import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceIdentity, signDeviceReport, solveDeviceChallenge } from "../src/desktop/device-identity.js";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const signedDesktopOperation = vi.hoisted(() => vi.fn());
const endpointJson = vi.hoisted(() => vi.fn());
vi.mock("../src/desktop/execution-router.js", () => ({ signedDesktopOperation }));
vi.mock("../src/desktop/http-proxy.js", () => ({ endpointJson }));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  signedDesktopOperation.mockReset();
  endpointJson.mockReset();
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signedReport(
  identity: ReturnType<typeof createDeviceIdentity>,
  userId: string,
  workspace: { type: "personal" | "organization"; id: string },
  payload: { operationId: string } & Record<string, unknown>,
) {
  const issuedAt = new Date();
  const protectedBytes = Buffer.from(JSON.stringify({
    version: 1,
    algorithm: "RSA-PSS-SHA256",
    keyId: identity.keyId,
    deviceId: identity.deviceId,
    operationId: payload.operationId,
    userId,
    workspaceType: workspace.type,
    workspaceId: workspace.id,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    payload,
  }), "utf8");
  return { protected: protectedBytes.toString("base64url"), signature: signDeviceReport(identity, protectedBytes) };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "viron-org-exec-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "db.sqlite"),
    masterKey: Buffer.alloc(32, 23),
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
    rmSync(directory, { recursive: true, force: true });
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies[0].value };
  const registration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "member", password: "member" } });
  const userId = registration.json().user.id as string;
  const memberCookies = { envman_session: registration.cookies[0].value };
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "执行组织" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, now, now);
  for (const session of [cookies, memberCookies]) {
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: session, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  }
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产", owner: "member" } });
  expect(environment.statusCode, environment.body).toBe(201);
  const ssh = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-connections",
    cookies,
    payload: { name: "连接A", host: "example.invalid", port: 22, username: "root", authType: "password", password: "fake-password", environmentIds: [environment.json().id] },
  });
  expect(ssh.statusCode, ssh.body).toBe(201);
  const sshId = ssh.json().id as string;
  const identity = createDeviceIdentity();
  const challenge = await app.inject({
    method: "POST",
    url: "/api/v1/desktop/devices/registration-challenges",
    cookies: memberCookies,
    payload: { deviceId: identity.deviceId, publicKey: identity.publicKey },
  });
  expect(challenge.statusCode, challenge.body).toBe(201);
  const proof = solveDeviceChallenge(identity, challenge.json().encryptedChallenge);
  expect((await app.inject({
    method: "POST",
    url: `/api/v1/desktop/devices/registration-challenges/${challenge.json().challengeId}/complete`,
    cookies: memberCookies,
    payload: { proof },
  })).statusCode).toBe(200);
  const base = `/api/v1/organizations/${org}`;
  const target = { type: "ssh_connection" as const, id: sshId };
  async function grant(name: string, codes: string[], withData: boolean) {
    const role = await app.inject({ method: "POST", url: `${base}/roles`, cookies, payload: { name, permissionCodes: codes, reason: "测试角色" } });
    expect(role.statusCode, role.body).toBe(201);
    const roleId = role.json().id as string;
    expect((await app.inject({ method: "POST", url: `${base}/role-assignments`, cookies, payload: { roleId, subjectType: "user", subjectId: userId, reason: "分配" } })).statusCode).toBe(201);
    let grantIds: string[] = [];
    if (withData) {
      const data = await app.inject({ method: "POST", url: `${base}/role-data-grants`, cookies, payload: { roleId, targets: [target], reason: "数据范围" } });
      expect(data.statusCode, data.body).toBe(201);
      grantIds = data.json().ids as string[];
    }
    return { roleId, grantIds };
  }
  async function feature(channel: "mcp" | "agent") {
    const created = await app.inject({
      method: "POST",
      url: `${base}/feature-grants`,
      cookies,
      payload: { subjectType: "user", subjectId: userId, targets: [target], features: { mcp: channel === "mcp", agent: channel === "agent", webPlugins: false }, reason: channel },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  }
  function requestBody(channel: "mcp" | "agent", code = "ssh.use", operationId = randomUUID()) {
    return {
      operationId,
      kind: "organization_execution_authorization" as const,
      channel,
      checks: [{ target, code }],
      requestIdentity: { method: "POST", path: `/api/v1/mcp/ssh-connections/${sshId}/command`, bodyDigest: digest(`${code}:${channel}:${operationId}`) },
    };
  }
  async function authorize(
    channel: "mcp" | "agent",
    code = "ssh.use",
    options: {
      extra?: Record<string, unknown>;
      cookies?: { envman_session: string };
      workspace?: { type: "personal" | "organization"; id: string };
      operationId?: string;
      userId?: string;
    } = {},
  ) {
    const body = requestBody(channel, code, options.operationId);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/organization-execution/authorize",
      cookies: options.cookies ?? memberCookies,
      payload: {
        ...signedReport(identity, options.userId ?? userId, options.workspace ?? { type: "organization", id: org }, body),
        ...options.extra,
      },
    });
    return { response, body };
  }
  return { app, db, cookies, memberCookies, org, userId, sshId, base, target, grant, feature, authorize };
}

describe("desktop organization execution authorization", () => {
  it("checks the signed channel against the same role and does not keep an old allow", async () => {
    const f = await fixture();
    const role = await f.grant("运维执行", ["ssh.view", "ssh.use"], true);
    const codeOnly = await f.grant("只有权限码", ["ssh.use"], false);
    const dataOnly = await f.grant("只有数据", ["ssh.view"], true);
    const missingFeature = await f.authorize("mcp");
    expect(missingFeature.response.statusCode, missingFeature.response.body).toBe(403);
    expect(missingFeature.response.json()).toMatchObject({ error: "FEATURE_FORBIDDEN", allowed: false, scope: "organization", channel: "mcp" });
    expect(missingFeature.response.json().checks[0].basis.roles.map((item: { roleId: string }) => item.roleId)).toContain(role.roleId);
    expect(missingFeature.response.json().checks[0].basis.roles.map((item: { roleId: string }) => item.roleId)).not.toContain(dataOnly.roleId);
    expect(missingFeature.response.json().checks[0].basis.roles.map((item: { roleId: string }) => item.roleId)).not.toContain(codeOnly.roleId);
    expect(missingFeature.response.json().checks[0].window.allowed).toBe(false);

    const featureId = await f.feature("agent");
    const agent = await f.authorize("agent");
    expect(agent.response.statusCode, agent.response.body).toBe(200);
    expect(agent.response.json()).toMatchObject({ allowed: true, error: null, channel: "agent", scope: "organization" });
    expect(agent.response.json().window).toEqual({ allowed: true, permanent: true, expiresAt: null });
    expect(agent.response.json().checks[0].basis.featureGrantIds).toEqual([featureId]);
    expect(agent.response.json().checks[0].basis.roles).toEqual([expect.objectContaining({ roleId: role.roleId, roleName: "运维执行", dataGrantId: role.grantIds[0] })]);

    const unsignedAgent = await f.authorize("mcp", "ssh.use", { extra: { channel: "agent" } });
    expect(unsignedAgent.response.statusCode, unsignedAgent.response.body).toBe(403);
    expect(unsignedAgent.response.json().error).toBe("FEATURE_FORBIDDEN");
    expect(unsignedAgent.response.json().channel).toBe("mcp");

    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/feature-grants/${featureId}`, cookies: f.cookies, payload: { reason: "撤销功能" } })).statusCode).toBe(200);
    const mcpFeature = await f.feature("mcp");
    const allowed = await f.authorize("mcp");
    expect(allowed.response.statusCode, allowed.response.body).toBe(200);
    expect(allowed.response.json().checks[0].basis.featureGrantIds).toEqual([mcpFeature]);
    const listed = await f.app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies: f.memberCookies });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.some((item: { id: string }) => item.id === f.sshId)).toBe(true);

    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/role-data-grants/${role.grantIds[0]}`, cookies: f.cookies, payload: { reason: "撤销数据" } })).statusCode).toBe(200);
    const revoked = await f.authorize("mcp");
    expect(revoked.response.statusCode, revoked.response.body).toBe(403);
    expect(revoked.response.json().error).toBe("ACTION_FORBIDDEN");
    const replay = await f.authorize("mcp", "ssh.use", { operationId: allowed.body.operationId });
    expect(replay.response.statusCode, replay.response.body).toBe(403);
    expect(replay.response.json()).toMatchObject({ error: "ACTION_FORBIDDEN", duplicate: true, allowed: false });

    const ledger = await f.db.prepare("SELECT actor_id, action, channel, target_refs_json, after_json FROM organization_grant_ledger WHERE organization_id = ? AND action = '执行授权检查'").all<{ actor_id: string; action: string; channel: string; target_refs_json: string; after_json: string }>(f.org);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((row) => row.actor_id === f.userId && row.action === "执行授权检查" && row.target_refs_json.includes(f.sshId))).toBe(true);
    expect(ledger.some((row) => row.channel === "mcp" && row.after_json.includes("\"result\":\"allowed\""))).toBe(true);
    expect(ledger.some((row) => row.after_json.includes("\"result\":\"denied\"") && row.after_json.includes("FEATURE_FORBIDDEN"))).toBe(true);
    expect(ledger.every((row) => !row.after_json.includes("外部执行完成"))).toBe(true);
    const executions = await f.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'ssh.%' OR action LIKE 'database.%' OR action = 'connection.inspected'").all();
    expect(executions).toEqual([]);

    const beforeSwitch = ledger.length;
    expect((await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: f.memberCookies, payload: { type: "personal" } })).statusCode).toBe(200);
    const switched = await f.authorize("mcp");
    expect(switched.response.statusCode, switched.response.body).toBe(403);
    expect(switched.response.json().error).toBe("DESKTOP_REPORT_CONTEXT_MISMATCH");
    const personal = await f.authorize("mcp", "ssh.use", { workspace: { type: "personal", id: f.userId } });
    expect(personal.response.statusCode, personal.response.body).toBe(200);
    expect(personal.response.json()).toMatchObject({ allowed: true, scope: "personal", checks: [expect.objectContaining({ basis: expect.objectContaining({ roles: [] }) })] });
    const otherAccount = await f.authorize("mcp", "ssh.use", { cookies: f.cookies, workspace: { type: "organization", id: f.org } });
    expect(otherAccount.response.statusCode).toBe(403);
    expect(otherAccount.response.json().error).toBe("DESKTOP_REPORT_CONTEXT_MISMATCH");
    const afterSwitch = await f.db.prepare("SELECT id FROM organization_grant_ledger WHERE organization_id = ? AND action = '执行授权检查'").all(f.org);
    expect(afterSwitch).toHaveLength(beforeSwitch);

    const manual = await f.app.inject({
      method: "POST",
      url: "/api/v1/desktop/organization-execution/authorize",
      cookies: f.memberCookies,
      payload: signedReport(createDeviceIdentity(), f.userId, { type: "personal", id: f.userId }, { ...personal.body, channel: "manual", operationId: randomUUID() }),
    });
    expect(manual.statusCode, manual.body).toBe(400);
    expect(manual.json().error).toBe("INVALID_DESKTOP_REPORT_PAYLOAD");
  });
});

describe("organization execution helper", () => {
  it("signs the trusted channel and a new operation each call", async () => {
    signedDesktopOperation.mockImplementation(async (payload: { operationId: string; channel: string }) => ({ protected: payload.operationId, signature: payload.channel }));
    endpointJson.mockImplementation(async (_path: string, init: { body: { protected: string; signature: string } }) => ({ allowed: init.body.signature === "agent", operationId: init.body.protected, channel: init.body.signature }));
    const { authorizeOrganizationExecution, runWithOrganizationExecutionChannel } = await import("../src/desktop/organization-execution.js");
    const requestIdentity = { method: "POST", path: "/api/v1/mcp/ssh-connections/00000000-0000-4000-8000-000000000001/command", bodyDigest: digest("body") };
    const checks = [{ target: { type: "ssh_connection" as const, id: "00000000-0000-4000-8000-000000000001" }, code: "ssh.use" }];
    const first = await authorizeOrganizationExecution(requestIdentity, checks);
    const second = await runWithOrganizationExecutionChannel("agent", () => authorizeOrganizationExecution(requestIdentity, checks));
    expect(first.channel).toBe("mcp");
    expect(second.channel).toBe("agent");
    expect(first.operationId).not.toBe(second.operationId);
    expect(endpointJson).toHaveBeenCalledTimes(2);
    expect(endpointJson.mock.calls[0][0]).toBe("/api/v1/desktop/organization-execution/authorize");
    expect(signedDesktopOperation.mock.calls[0][0].channel).toBe("mcp");
    expect(signedDesktopOperation.mock.calls[1][0].channel).toBe("agent");
    expect(signedDesktopOperation.mock.calls[0][0].requestIdentity).toEqual(requestIdentity);
  });
});
