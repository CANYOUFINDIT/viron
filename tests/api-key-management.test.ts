import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

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
    databasePath: join(directory, "viron.db"),
    masterKey: Buffer.alloc(32, 23),
    adminUsername: "admin",
    adminPassword: "Admin-password-123",
    allowWeakPasswords: false,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("API key management and provisioning", () => {
  it("provisions a user into an organization and project before one-time passwordless login", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-api-keys-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: config.adminUsername, password: config.adminPassword },
    });
    const adminCookie = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const platformKeyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/platform/api-keys",
      cookies: adminCookie,
      payload: { name: "integration-client" },
    });
    expect(platformKeyResponse.statusCode).toBe(201);
    const platformKey = platformKeyResponse.json().apiKey as string;
    expect(platformKey).toMatch(/^viron_platform_/);
    const platformHeaders = { authorization: `Bearer ${platformKey}` };

    const platformAdminCollision = await app.inject({
      method: "POST", url: "/api/v1/platform/users/ensure", headers: platformHeaders,
      payload: { username: "admin", password: "Different-password-123" },
    });
    expect(platformAdminCollision.statusCode).toBe(409);
    expect(platformAdminCollision.json().error).toBe("PLATFORM_USER_CONFLICT");

    const ensureOwner = await app.inject({
      method: "POST", url: "/api/v1/platform/users/ensure", headers: platformHeaders,
      payload: { username: "viron-owner", password: "Owner-password-123" },
    });
    const ownerId = ensureOwner.json().id as string;
    const ensureUser = await app.inject({
      method: "POST", url: "/api/v1/platform/users/ensure", headers: platformHeaders,
      payload: { username: "integration-client-user", password: "User-password-123" },
    });
    const userId = ensureUser.json().id as string;
    expect((await app.inject({
      method: "POST", url: "/api/v1/platform/users/ensure", headers: platformHeaders,
      payload: { username: "integration-client-user", password: "Different-password-123" },
    })).json()).toMatchObject({ id: userId, created: false });

    const organizationResponse = await app.inject({
      method: "POST", url: "/api/v1/platform/organizations/ensure", headers: platformHeaders,
      payload: { name: "Operations", ownerUserId: ownerId },
    });
    const organizationId = organizationResponse.json().id as string;
    expect(organizationResponse.json()).toMatchObject({ ownerUserId: ownerId, created: true });
    const membershipResponse = await app.inject({
      method: "PUT", url: `/api/v1/platform/organizations/${organizationId}/members/${userId}`, headers: platformHeaders,
      payload: { role: "member" },
    });
    expect(membershipResponse.json()).toMatchObject({ userId, role: "member", created: true });

    const projectResponse = await app.inject({
      method: "POST", url: `/api/v1/platform/organizations/${organizationId}/projects/ensure`, headers: platformHeaders,
      payload: { name: "Operations" },
    });
    const projectId = projectResponse.json().id as string;
    const projectMembership = await app.inject({
      method: "PUT", url: `/api/v1/platform/projects/${projectId}/members/${userId}`, headers: platformHeaders,
    });
    expect(projectMembership.json()).toMatchObject({ projectId, userId, created: true });

    const personalKeyResponse = await app.inject({
      method: "POST", url: `/api/v1/platform/users/${userId}/api-keys`, headers: platformHeaders,
      payload: { name: "integration-client-login" },
    });
    expect(personalKeyResponse.statusCode).toBe(201);
    const personalKey = personalKeyResponse.json().apiKey as string;
    expect(personalKey).toMatch(/^viron_personal_/);
    expect((await app.inject({
      method: "GET", url: "/api/v1/organizations", headers: { authorization: `Bearer ${personalKey}` },
    })).json().items).toEqual([expect.objectContaining({ id: organizationId, role: "member" })]);

    const ticketResponse = await app.inject({
      method: "POST", url: "/api/v1/auth/api-key/tickets",
      headers: { authorization: `Bearer ${personalKey}` },
      payload: { organizationId, redirectPath: "/" },
    });
    expect(ticketResponse.statusCode).toBe(200);
    const ticket = ticketResponse.json().ticket as string;
    const consume = await app.inject({
      method: "POST", url: "/auth/api-key/consume",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${encodeURIComponent(ticket)}`,
    });
    expect(consume.statusCode).toBe(303);
    expect(consume.headers.location).toBe("/");
    expect(consume.headers["cache-control"]).toBe("no-store");
    const sessionCookie = consume.cookies.find((item) => item.name === "envman_session")!.value;
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { envman_session: sessionCookie } });
    expect(me.json()).toMatchObject({ user: { id: userId, username: "integration-client-user" }, workspace: { id: organizationId, role: "member" } });

    const replay = await app.inject({
      method: "POST", url: "/auth/api-key/consume",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${encodeURIComponent(ticket)}`,
    });
    expect(replay.statusCode).toBe(410);
    expect(replay.json().error).toBe("API_KEY_TICKET_CONSUMED");
    expect((await app.db.prepare("SELECT token_hash FROM api_keys WHERE id = ?").get(personalKeyResponse.json().id) as { token_hash: string }).token_hash).not.toContain(personalKey);

    await app.close();
  });

  it("keeps platform key management exclusive to platform administrators", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-platform-api-keys-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const registered = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username: "member", password: "Member-password-123" },
    });
    const memberCookie = { envman_session: registered.cookies.find((item) => item.name === "envman_session")!.value };
    const denied = await app.inject({
      method: "POST", url: "/api/v1/platform/api-keys", cookies: memberCookie, payload: { name: "forbidden" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("PLATFORM_ADMIN_REQUIRED");
    await app.close();
  });

  it("stores and updates remote MCP approval policy per personal API key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-api-key-mcp-policy-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: config.adminUsername, password: config.adminPassword },
    });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      cookies,
      payload: { name: "Codex remote", mcpApprovalMode: "high-risk" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ mcpApprovalMode: "high-risk" });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/api-keys/${created.json().id}/mcp-approval-mode`,
      cookies,
      payload: { mcpApprovalMode: "never" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ mcpApprovalMode: "never" });

    const rotated = await app.inject({
      method: "POST",
      url: `/api/v1/api-keys/${created.json().id}/rotate`,
      cookies,
    });
    expect(rotated.statusCode).toBe(201);
    expect(rotated.json()).toMatchObject({ mcpApprovalMode: "never" });
    await app.close();
  });
});
