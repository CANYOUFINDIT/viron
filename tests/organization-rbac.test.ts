import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeviceIdentity,
  openDatabaseCredentialEnvelope,
  openRedisCredentialEnvelope,
  openSshCredentialEnvelope,
  solveDeviceChallenge,
} from "../src/desktop/device-identity.js";
import { buildApp } from "../src/server/app.js";
import { openDatabase, ensureAdmin } from "../src/server/database.js";
import type { AppConfig } from "../src/server/config.js";
import {
  insertRole,
  insertAssignment,
  insertDataGrant,
  loadOrganizationAccess,
  initializeOrganizationRoles,
  roleState,
} from "../src/server/organization-rbac.js";
import { runWithAuditSource } from "../src/server/audit.js";
import { authorizeOrganizationResources } from "./helpers/organization-roles.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "viron-rbac-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 19),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  cleanup.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: config.adminPassword },
  });
  const cookies = { envman_session: login.cookies[0].value };
  const adminId = login.json().user.id;
  const registration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { username: "member", password: "member" },
  });
  const userId = registration.json().user.id as string,
    memberCookies = { envman_session: registration.cookies[0].value };
  const organization = await app.inject({
    method: "POST",
    url: "/api/v1/organizations",
    cookies,
    payload: { name: "测试组织" },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  await db
    .prepare(
      "INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)",
    )
    .run(org, userId, new Date().toISOString(), new Date().toISOString());
  for (const c of [cookies, memberCookies])
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/auth/workspace",
          cookies: c,
          payload: { type: "organization", id: org },
        })
      ).statusCode,
    ).toBe(200);
  const environment = await app.inject({
    method: "POST",
    url: "/api/v1/environments",
    cookies,
    payload: { name: "生产" },
  });
  expect(environment.statusCode, environment.body).toBe(201);
  const env = environment.json().id as string;
  const ssh = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-connections",
    cookies,
    payload: {
      name: "测试SSH",
      host: "example.invalid",
      port: 22,
      username: "test",
      authType: "password",
      password: "fake-password",
      environmentIds: [env],
    },
  });
  expect(ssh.statusCode, ssh.body).toBe(201);
  const sshId = ssh.json().id as string;
  return {
    app,
    db,
    cookies,
    memberCookies,
    org,
    env,
    sshId,
    userId,
    adminId,
    base: `/api/v1/organizations/${org}`,
  };
}

describe("organization role permissions", () => {
  it("loads organization access once per session refresh and recomputes it after switching workspaces", async () => {
    const f = await fixture();
    const prepare = vi.spyOn(f.db, "prepare");
    try {
      const me = await f.app.inject({ url: "/api/v1/auth/me", cookies: f.cookies });
      expect(me.statusCode).toBe(200);
      expect(me.json().workspace.id).toBe(f.org);
      const catalogReads = () => prepare.mock.calls.filter(([sql]) => sql.includes("SELECT id, name, group_id FROM environments"));
      expect(catalogReads()).toHaveLength(1);

      const personal = await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: f.cookies, payload: { type: "personal" } });
      expect(personal.statusCode).toBe(200);
      expect(personal.json().workspace).toMatchObject({ type: "personal", id: f.adminId });
      expect(personal.json().workspace.permissionCodes).toBeUndefined();
      prepare.mockClear();
      const organization = await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: f.cookies, payload: { type: "organization", id: f.org } });
      expect(organization.statusCode).toBe(200);
      expect(organization.json().workspace.permissionCodes).toContain("role.update");
      expect(catalogReads()).toHaveLength(1);
    } finally {
      prepare.mockRestore();
    }
  });

  it("requires operation and target on the same assigned role and never grants channel access by role", async () => {
    const f = await fixture();
    const target = { type: "ssh_connection" as const, id: f.sshId };
    const operation = await insertRole(f.db, f.org, "可登录", ["ssh.use"]);
    const scope = await insertRole(f.db, f.org, "仅范围", []);
    await insertAssignment(f.db, f.org, operation, "user", f.userId, {
      kind: "resources",
      ids: [],
      includeChildren: false,
    });
    await insertAssignment(f.db, f.org, scope, "user", f.userId, {
      kind: "resources",
      ids: [],
      includeChildren: false,
    });
    await insertDataGrant(
      f.db,
      f.org,
      scope,
      target,
      scope,
      null,
      null,
      "测试",
    );
    let a = await loadOrganizationAccess(f.db, f.org, f.userId);
    expect(a.allows("ssh.use", target)).toBe(false);
    expect(a.allows("ssh.view", target)).toBe(false);
    await insertDataGrant(
      f.db,
      f.org,
      operation,
      target,
      operation,
      null,
      null,
      "测试",
    );
    a = await loadOrganizationAccess(f.db, f.org, f.userId);
    expect(a.allows("ssh.use", target)).toBe(true);
    expect(a.allows("ssh.view", target)).toBe(false);
    expect(
      a.allows("ssh.use", { type: "database_connection", id: f.sshId }),
    ).toBe(false);
    expect(a.featureAllowed("mcp", target)).toBe(false);
    await f.db
      .prepare("UPDATE organization_roles SET enabled=0 WHERE id=?")
      .run(operation);
    expect(
      (await loadOrganizationAccess(f.db, f.org, f.userId)).allows(
        "ssh.use",
        target,
      ),
    ).toBe(false);
  });
  it("keeps data, subject and feature forms separate; checks foreign targets, versions and the last permanent maintainer", async () => {
    const f = await fixture();
    const state = (
      await f.app.inject({
        method: "GET",
        url: f.base + "/role-access",
        cookies: f.cookies,
      })
    ).json();
    const admin = state.roles.find(
      (r: { name: string }) => r.name === "组织管理员",
    );
    for (const payload of [
      {
        roleId: admin.id,
        targets: [{ type: "environment", id: f.env }],
        granteeId: f.userId,
        reason: "混合字段",
      },
      {
        roleId: admin.id,
        targets: [{ type: "environment", id: randomUUID() }],
        reason: "外部资源",
      },
    ])
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: f.base + "/role-data-grants",
            cookies: f.cookies,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    const invalid = await f.app.inject({
      method: "POST",
      url: f.base + "/feature-grants",
      cookies: f.cookies,
      payload: {
        roleId: admin.id,
        subjectType: "user",
        subjectId: f.userId,
        targets: [{ type: "environment", id: f.env }],
        features: { mcp: true, agent: false, webPlugins: false },
        reason: "混合字段",
      },
    });
    expect(invalid.statusCode).toBe(400);
    const assignment = state.assignments.find(
      (a: { roleId: string }) => a.roleId === admin.id,
    );
    const temporary = await f.app.inject({
      method: "PUT",
      url: f.base + "/role-assignments/" + assignment.id,
      cookies: f.cookies,
      payload: {
        ...assignment,
        id: undefined,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        reason: "临时唯一维护者",
      },
    });
    expect(temporary.statusCode).toBe(409);
    expect(
      (
        await f.app.inject({
          method: "DELETE",
          url: f.base + "/role-assignments/" + assignment.id,
          cookies: f.cookies,
          payload: { reason: "撤销唯一维护者" },
        })
      ).statusCode,
    ).toBe(409);
    const payload = {
      name: admin.name,
      description: admin.description,
      permissionCodes: admin.permissionCodes,
      enabled: true,
      version: admin.version,
      reason: "测试版本",
    };
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: f.base + "/roles/" + admin.id,
          cookies: f.cookies,
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: f.base + "/roles/" + admin.id,
          cookies: f.cookies,
          payload,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("creates single-target grant rows, revokes only one, refreshes sessions and keeps named audit snapshots", async () => {
    const f = await fixture();
    const { roleId, ids } = await authorizeOrganizationResources(
      f.app,
      f.cookies,
      f.org,
      f.userId,
      [
        { type: "environment", id: f.env },
        { type: "ssh_connection", id: f.sshId },
      ],
      ["environment.view", "ssh.use"],
    );
    expect(ids).toHaveLength(2);
    const rows = (await roleState(f.db, f.org)).dataGrants.filter(
      (g) => g.roleId === roleId,
    );
    const ssh = rows.find((g) => g.target.type === "ssh_connection")!;
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          cookies: f.memberCookies,
        })
      ).json().workspace.permissionCodes,
    ).toContain("ssh.use");
    expect(
      (
        await f.app.inject({
          method: "DELETE",
          url: f.base + "/role-data-grants/" + ssh.id,
          cookies: f.cookies,
          payload: { reason: "单资源撤销" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          cookies: f.memberCookies,
        })
      ).json().workspace.permissionCodes,
    ).not.toContain("ssh.use");
    expect(
      (await roleState(f.db, f.org)).dataGrants.filter(
        (g) => g.roleId === roleId,
      ),
    ).toHaveLength(1);
    const event = await f.db
      .prepare(
        "SELECT before_json FROM organization_role_events WHERE organization_id=? AND reason=?",
      )
      .get<{ before_json: string }>(f.org, "单资源撤销");
    expect(JSON.parse(event!.before_json)).toMatchObject({
      target: { type: "ssh_connection", id: f.sshId },
      roleId,
    });
    expect(
      (
        await f.app.inject({
          method: "DELETE",
          url: f.base + "/roles/" + roleId,
          cookies: f.cookies,
          payload: { reason: "仍被使用" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("inherits multiple groups, enforces validity and retains another valid source after revocation", async () => {
    const f = await fixture(),
      now = Date.now(),
      parent = randomUUID(),
      child = randomUUID(),
      second = randomUUID();
    for (const [id, p] of [
      [parent, null],
      [child, parent],
      [second, null],
    ])
      await f.db
        .prepare(
          "INSERT INTO projects (id,organization_id,parent_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          f.org,
          p,
          id,
          "",
          new Date(now).toISOString(),
          new Date(now).toISOString(),
        );
    for (const id of [child, second])
      await f.db
        .prepare(
          "INSERT INTO project_members (project_id,user_id,created_at) VALUES (?,?,?)",
        )
        .run(id, f.userId, new Date(now).toISOString());
    const role = await insertRole(f.db, f.org, "继承角色", ["ssh.browse"]);
    const exp = new Date(now + 1000).toISOString();
    await insertAssignment(
      f.db,
      f.org,
      role,
      "project",
      parent,
      { kind: "resources", ids: [], includeChildren: false },
      null,
      exp,
    );
    const other = await insertAssignment(
      f.db,
      f.org,
      role,
      "project",
      second,
      { kind: "resources", ids: [], includeChildren: false },
      new Date(now + 500).toISOString(),
      null,
    );
    await insertDataGrant(
      f.db,
      f.org,
      role,
      { type: "ssh_connection", id: f.sshId },
      role,
      null,
      null,
      "测试",
    );
    expect(
      (await loadOrganizationAccess(f.db, f.org, f.userId, now)).allows(
        "ssh.browse",
        { type: "ssh_connection", id: f.sshId },
      ),
    ).toBe(true);
    expect(
      (await loadOrganizationAccess(f.db, f.org, f.userId, now + 1500)).allows(
        "ssh.browse",
        { type: "ssh_connection", id: f.sshId },
      ),
    ).toBe(true);
    await f.db
      .prepare("DELETE FROM organization_role_assignments WHERE id=?")
      .run(other);
    expect(
      (await loadOrganizationAccess(f.db, f.org, f.userId, now + 1500)).allows(
        "ssh.browse",
        { type: "ssh_connection", id: f.sshId },
      ),
    ).toBe(false);
  });
  it("freezes legacy writes, closes organization execution channels and lets feature grants exist without role permission", async () => {
    const f = await fixture();
    for (const [method, url] of [
      ["POST", "/grants"],
      ["PUT", "/approval-workflow"],
      ["POST", "/access-requests"],
    ] as const)
      expect(
        (
          await f.app.inject({
            method,
            url: f.base + url,
            cookies: f.cookies,
            payload: {},
          })
        ).statusCode,
      ).toBe(410);
    const feature = await f.app.inject({
      method: "POST",
      url: f.base + "/feature-grants",
      cookies: f.cookies,
      payload: {
        subjectType: "user",
        subjectId: f.userId,
        targets: [{ type: "ssh_connection", id: f.sshId }],
        features: { mcp: true, agent: true, webPlugins: false },
        reason: "独立功能授权",
      },
    });
    expect(feature.statusCode, feature.body).toBe(201);
    const access = await loadOrganizationAccess(f.db, f.org, f.userId);
    expect(
      access.featureAllowed("mcp", { type: "ssh_connection", id: f.sshId }),
    ).toBe(true);
    expect(
      access.allows("ssh.use", { type: "ssh_connection", id: f.sshId }),
    ).toBe(false);
    const execution = await runWithAuditSource("mcp", (headers) =>
      f.app.inject({
        method: "GET",
        url: "/api/v1/connections",
        headers,
        cookies: f.cookies,
      }),
    );
    expect(execution.statusCode).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/v1/desktop/ssh-connections/${f.sshId}/envelope`,
          cookies: f.cookies,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it("migrates existing administrator scope once, never adds new resources and leaves features empty", async () => {
    const f = await fixture();
    await f.db.transaction(async () => {
      await f.db
        .prepare(
          "DELETE FROM organization_role_migrations WHERE organization_id=?",
        )
        .run(f.org);
      await f.db
        .prepare(
          "DELETE FROM organization_role_assignments WHERE organization_id=?",
        )
        .run(f.org);
      await f.db
        .prepare("DELETE FROM organization_roles WHERE organization_id=?")
        .run(f.org);
      await initializeOrganizationRoles(f.db, f.org);
    })();
    let state = await roleState(f.db, f.org);
    const count = state.roles.length;
    expect(state.dataGrants.some((g) => g.target.id === f.sshId)).toBe(true);
    expect(state.featureGrants).toEqual([]);
    await f.db.transaction(() => initializeOrganizationRoles(f.db, f.org))();
    expect((await roleState(f.db, f.org)).roles).toHaveLength(count);
    const resource = await f.app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies: f.cookies,
      payload: {
        name: "新增",
        host: "new.invalid",
        username: "test",
        authType: "password",
        password: "fake",
      },
    });
    expect(resource.statusCode).toBe(201);
    const access = await loadOrganizationAccess(f.db, f.org, f.adminId);
    expect(
      access.allows("ssh.use", {
        type: "ssh_connection",
        id: resource.json().id,
      }),
    ).toBe(false);
  });

  it("authorizes desktop SSH, database, and Redis envelopes from the connectionId route param", async () => {
    const f = await fixture();
    const endpoint = "http://127.0.0.1:18453";
    const database = await f.app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies: f.cookies,
      payload: {
        name: "虚构桌面数据库",
        engine: "mysql",
        host: "database.example.invalid",
        port: 3306,
        username: "fake",
        credential: { password: "fake-db" },
      },
    });
    expect(database.statusCode, database.body).toBe(201);
    const redis = await f.app.inject({
      method: "POST",
      url: "/api/v1/redis-connections",
      cookies: f.cookies,
      payload: {
        name: "虚构桌面缓存",
        host: "redis.example.invalid",
        port: 6379,
        username: "fake",
        credential: { password: "fake-redis" },
      },
    });
    expect(redis.statusCode, redis.body).toBe(201);
    const otherSsh = await f.app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies: f.cookies,
      payload: {
        name: "未授权SSH",
        host: "other.example.invalid",
        port: 22,
        username: "fake",
        authType: "password",
        password: "not-granted",
      },
    });
    expect(otherSsh.statusCode, otherSsh.body).toBe(201);
    const granted = [
      {
        type: "ssh_connection" as const,
        id: f.sshId,
        code: "ssh.use",
        path: `/api/v1/desktop/ssh-connections/${f.sshId}/envelope`,
      },
      {
        type: "database_connection" as const,
        id: database.json().id as string,
        code: "database.read",
        path: `/api/v1/desktop/database-connections/${database.json().id}/envelope`,
      },
      {
        type: "redis_connection" as const,
        id: redis.json().id as string,
        code: "redis.view",
        path: `/api/v1/desktop/redis-connections/${redis.json().id}/envelope`,
      },
    ];
    const role = await insertRole(f.db, f.org, "桌面凭据", [
      "ssh.view",
      ...granted.map((item) => item.code),
    ]);
    await insertAssignment(f.db, f.org, role, "user", f.userId, {
      kind: "resources",
      ids: [],
      includeChildren: false,
    });
    for (const target of granted) {
      await insertDataGrant(f.db, f.org, role, target, role, null, null, "测试");
    }

    const spoofed = await f.app.inject({
      method: "POST",
      url: `/api/v1/desktop/ssh-connections/${otherSsh.json().id}/envelope`,
      cookies: f.memberCookies,
      payload: {
        deviceId: randomUUID(),
        requestId: randomUUID(),
        endpoint,
        connectionId: f.sshId,
      },
    });
    expect(spoofed.statusCode, spoofed.body).toBe(403);
    expect(spoofed.json().error).toBe("ACTION_FORBIDDEN");

    for (const target of granted) {
      const blocked = await f.app.inject({
        method: "POST",
        url: target.path,
        cookies: f.memberCookies,
        payload: {
          deviceId: randomUUID(),
          requestId: randomUUID(),
          endpoint,
        },
      });
      expect(blocked.statusCode, blocked.body).toBe(404);
      expect(blocked.json().error).toBe("DEVICE_NOT_FOUND");
    }

    const identity = createDeviceIdentity();
    const challenge = await f.app.inject({
      method: "POST",
      url: "/api/v1/desktop/devices/registration-challenges",
      cookies: f.memberCookies,
      payload: { deviceId: identity.deviceId, publicKey: identity.publicKey },
    });
    expect(challenge.statusCode, challenge.body).toBe(201);
    const proof = solveDeviceChallenge(identity, challenge.json().encryptedChallenge);
    const registered = await f.app.inject({
      method: "POST",
      url: `/api/v1/desktop/devices/registration-challenges/${challenge.json().challengeId}/complete`,
      cookies: f.memberCookies,
      payload: { proof },
    });
    expect(registered.statusCode, registered.body).toBe(200);

    const expected = {
      userId: f.userId,
      workspaceType: "organization" as const,
      workspaceId: f.org,
      endpoint,
    };
    const sshRequestId = randomUUID();
    const sshIssued = await f.app.inject({
      method: "POST",
      url: granted[0].path,
      cookies: f.memberCookies,
      payload: { deviceId: identity.deviceId, requestId: sshRequestId, endpoint },
    });
    expect(sshIssued.statusCode, sshIssued.body).toBe(200);
    const sshOpened = openSshCredentialEnvelope(identity, sshIssued.json(), {
      ...expected,
      requestId: sshRequestId,
      connectionId: f.sshId,
    });
    expect(sshOpened.credential.connection).toMatchObject({
      connectionId: f.sshId,
      host: "example.invalid",
      port: 22,
      username: "test",
    });

    const databaseRequestId = randomUUID();
    const databaseIssued = await f.app.inject({
      method: "POST",
      url: granted[1].path,
      cookies: f.memberCookies,
      payload: { deviceId: identity.deviceId, requestId: databaseRequestId, endpoint },
    });
    expect(databaseIssued.statusCode, databaseIssued.body).toBe(200);
    const databaseOpened = openDatabaseCredentialEnvelope(identity, databaseIssued.json(), {
      ...expected,
      requestId: databaseRequestId,
      connectionId: database.json().id,
    });
    expect(databaseOpened.credential.connection).toMatchObject({
      connectionId: database.json().id,
      host: "database.example.invalid",
      password: "fake-db",
    });

    const redisRequestId = randomUUID();
    const redisIssued = await f.app.inject({
      method: "POST",
      url: granted[2].path,
      cookies: f.memberCookies,
      payload: { deviceId: identity.deviceId, requestId: redisRequestId, endpoint },
    });
    expect(redisIssued.statusCode, redisIssued.body).toBe(200);
    const redisOpened = openRedisCredentialEnvelope(identity, redisIssued.json(), {
      ...expected,
      requestId: redisRequestId,
      connectionId: redis.json().id,
    });
    expect(redisOpened.credential.connection).toMatchObject({
      connectionId: redis.json().id,
      host: "redis.example.invalid",
      password: "fake-redis",
    });
  });
});
