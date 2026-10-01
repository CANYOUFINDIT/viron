import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { expandActions, heavierActions, sqlRequiresWrite } from "../src/shared/access-permissions.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 19),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value };
}

describe("access permission helpers", () => {
  it("expands heavier actions without treating service actions as one chain", () => {
    expect(expandActions("web", ["manage"])).toEqual(["view", "use", "manage"]);
    expect(expandActions("database", ["write"])).toEqual(["read", "write"]);
    expect(expandActions("maintenance", ["script", "install"])).toEqual(["view", "script", "install"]);
    expect(heavierActions("ssh", "view")).toEqual(["use", "manage"]);
    expect(heavierActions("maintenance", "control")).toEqual([]);
    expect(heavierActions("maintenance", "view")).toEqual(["control", "script", "manage", "install"]);
  });

  it("treats reads as queries and everything else as a change", () => {
    expect(sqlRequiresWrite("SELECT 1")).toBe(false);
    expect(sqlRequiresWrite("SHOW TABLES")).toBe(false);
    expect(sqlRequiresWrite("WITH rows AS (SELECT 1 AS id) SELECT * FROM rows")).toBe(false);
    expect(sqlRequiresWrite("SELECT * FROM t FOR UPDATE")).toBe(true);
    expect(sqlRequiresWrite("UPDATE t SET name = 'a'")).toBe(true);
    expect(sqlRequiresWrite("")).toBe(true);
  });
});

describe("organization access authorizations", () => {
  it("limits actions, expires them, and reactivates the same grant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-access-grant-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const admin = await login(app, "admin", config.adminPassword);
      const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "member", password: "member" } });
      const memberId = registered.json().user.id as string;
      const member = await login(app, "member", "member");
      const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies: admin, payload: { name: "授权组织", description: "" } });
      const organizationId = organization.json().id as string;
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: admin, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
      const invitation = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: admin, payload: { expiresInHours: 24, maxUses: 1 } });
      expect((await app.inject({ method: "POST", url: `/api/v1/organization-invitations/${invitation.json().token}/accept`, cookies: member })).statusCode).toBe(201);
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: member, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);

      const group = await app.inject({ method: "POST", url: "/api/v1/environment-groups", cookies: admin, payload: { name: "生产", description: "", color: "#1d8a74" } });
      const groupId = group.json().id as string;
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: admin, payload: { name: "现有环境", groupId } });
      const environmentId = environment.json().id as string;
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const past = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/grants`,
        cookies: admin,
        payload: {
          granteeType: "user",
          granteeId: memberId,
          scopeKind: "environment",
          targetIds: [environmentId],
          permissions: { web: ["view"] },
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      });
      expect(past.statusCode).toBe(400);
      expect(past.json().error).toBe("INVALID_EXPIRY");

      const created = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/grants`,
        cookies: admin,
        payload: {
          granteeType: "user",
          granteeId: memberId,
          scopeKind: "environment",
          targetIds: [environmentId],
          permissions: { web: ["view"] },
          expiresAt,
        },
      });
      expect(created.statusCode).toBe(201);
      const grantId = created.json().id as string;
      const visible = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies: member });
      expect(visible.statusCode).toBe(200);
      expect(visible.json().item.permissions.web).toEqual(["view"]);
      expect(visible.json().item.permissions.ssh).toBeUndefined();
      const createEntry = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/web-entries`,
        cookies: member,
        payload: { name: "门户", url: "https://example.com" },
      });
      expect(createEntry.statusCode).toBe(403);
      expect(createEntry.json().error).toBe("ACTION_FORBIDDEN");

      await db.prepare("UPDATE access_authorizations SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", grantId);
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies: member })).statusCode).toBe(404);
      const listed = await app.inject({ method: "GET", url: `/api/v1/organizations/${organizationId}`, cookies: admin });
      expect(listed.json().grants).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: grantId, expired: true, permissions: { web: ["view"] } }),
      ]));

      const restored = await app.inject({
        method: "PUT",
        url: `/api/v1/organizations/${organizationId}/grants/${grantId}`,
        cookies: admin,
        payload: {
          granteeType: "user",
          granteeId: memberId,
          scopeKind: "environment",
          targetIds: [environmentId],
          permissions: { web: ["view"] },
          expiresAt: null,
        },
      });
      expect(restored.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies: member })).statusCode).toBe(200);

      const whole = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/grants`,
        cookies: admin,
        payload: {
          granteeType: "user",
          granteeId: memberId,
          scopeKind: "environment_group",
          wholeGroup: true,
          groupId,
          targetIds: [],
          permissions: { logs: ["view"] },
          expiresAt: null,
        },
      });
      expect(whole.statusCode).toBe(201);
      const later = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: admin, payload: { name: "以后的环境", groupId } });
      const laterId = later.json().id as string;
      const laterView = await app.inject({ method: "GET", url: `/api/v1/environments/${laterId}`, cookies: member });
      expect(laterView.statusCode).toBe(200);
      expect(laterView.json().item.permissions.logs).toEqual(["view"]);
    } finally {
      await app.close();
    }
  });

  it("keeps an old environment grant as full permanent access until it is edited", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-legacy-grant-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const admin = await login(app, "admin", config.adminPassword);
      const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "legacy", password: "legacy" } });
      const memberId = registered.json().user.id as string;
      const member = await login(app, "legacy", "legacy");
      const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies: admin, payload: { name: "旧授权组织", description: "" } });
      const organizationId = organization.json().id as string;
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: admin, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
      const invitation = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: admin, payload: { expiresInHours: 24, maxUses: 1 } });
      expect((await app.inject({ method: "POST", url: `/api/v1/organization-invitations/${invitation.json().token}/accept`, cookies: member })).statusCode).toBe(201);
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: member, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: admin, payload: { name: "旧环境" } });
      const environmentId = environment.json().id as string;
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/grants`,
        cookies: admin,
        payload: { granteeType: "user", granteeId: memberId, resourceType: "environment", resourceId: environmentId },
      });
      expect(created.statusCode).toBe(201);
      const grantId = created.json().id as string;
      const before = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies: member });
      expect(before.json().item.permissions.web).toEqual(["view", "use", "manage"]);
      expect(before.json().item.permissions.maintenance).toEqual(["view", "control", "script", "manage", "install"]);

      const edited = await app.inject({
        method: "PUT",
        url: `/api/v1/organizations/${organizationId}/grants/${grantId}`,
        cookies: admin,
        payload: {
          granteeType: "user",
          granteeId: memberId,
          scopeKind: "environment",
          targetIds: [environmentId],
          permissions: { logs: ["view"] },
          expiresAt: null,
        },
      });
      expect(edited.statusCode).toBe(200);
      expect(await db.prepare("SELECT id FROM resource_grants WHERE id = ?").get(grantId)).toBeUndefined();
      expect(await db.prepare("SELECT id FROM access_authorizations WHERE id = ?").get(grantId)).toEqual({ id: grantId });
      const after = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies: member });
      expect(after.json().item.permissions).toEqual({ logs: ["view"] });
    } finally {
      await app.close();
    }
  });
});
