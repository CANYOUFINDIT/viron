import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { runWithAuditSource } from "../src/server/audit.js";
import { serverNow, runWithExecutionChannel } from "../src/server/organization-boundary.js";
import { loadOrganizationAccess, roleState } from "../src/server/organization-rbac.js";
import { desktopWebPartitionName } from "../src/desktop/web-page-policy.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "viron-phases-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 21),
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
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies[0].value };
  const adminId = login.json().user.id as string;
  const registration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "member", password: "member" } });
  const userId = registration.json().user.id as string;
  const memberCookies = { envman_session: registration.cookies[0].value };
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "阶段组织" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, new Date().toISOString(), new Date().toISOString());
  for (const session of [cookies, memberCookies])
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: session, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产", owner: "member" } });
  expect(environment.statusCode, environment.body).toBe(201);
  const env = environment.json().id as string;
  const ssh = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-connections",
    cookies,
    payload: { name: "连接A", host: "example.invalid", port: 22, username: "root", authType: "password", password: "fake-password", environmentIds: [env] },
  });
  expect(ssh.statusCode, ssh.body).toBe(201);
  const other = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-connections",
    cookies,
    payload: { name: "连接B", host: "other.invalid", port: 22, username: "root", authType: "password", password: "other-secret", environmentIds: [env] },
  });
  expect(other.statusCode, other.body).toBe(201);
  const now = new Date().toISOString();
  const knowledgeId = randomUUID();
  await db.prepare("INSERT INTO knowledge_nodes (id, workspace_type, workspace_id, type, name, content, created_by_user_id, created_at, updated_at) VALUES (?, 'organization', ?, 'document', '运维笔记', 'secret-body-text', ?, ?, ?)").run(knowledgeId, org, adminId, now, now);
  return { app, db, cookies, memberCookies, org, env, sshId: ssh.json().id as string, otherId: other.json().id as string, userId, adminId, knowledgeId, base: `/api/v1/organizations/${org}` };
}

async function grantRole(app: Awaited<ReturnType<typeof fixture>>["app"], cookies: { envman_session: string }, base: string, userId: string, codes: string[], targets: Array<{ type: string; id: string }>, expiresAt: string | null = null) {
  const role = await app.inject({ method: "POST", url: base + "/roles", cookies, payload: { name: "角色 " + randomUUID(), permissionCodes: codes, reason: "测试角色" } });
  expect(role.statusCode, role.body).toBe(201);
  const roleId = role.json().id as string;
  const assignment = await app.inject({ method: "POST", url: base + "/role-assignments", cookies, payload: { roleId, subjectType: "user", subjectId: userId, reason: "分配" } });
  expect(assignment.statusCode, assignment.body).toBe(201);
  const grant = await app.inject({ method: "POST", url: base + "/role-data-grants", cookies, payload: { roleId, targets, expiresAt, reason: "数据范围" } });
  expect(grant.statusCode, grant.body).toBe(201);
  return { roleId, grantIds: grant.json().ids as string[] };
}

describe("organization phases 2-7", () => {
  it("keeps same-role checks and rejects legacy writes", async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: "POST", url: f.base + "/grants", cookies: f.cookies, payload: {} })).statusCode).toBe(410);
    const codeOnly = await f.app.inject({ method: "POST", url: f.base + "/roles", cookies: f.cookies, payload: { name: "只有权限码", permissionCodes: ["ssh.use"], reason: "码" } });
    const dataOnly = await f.app.inject({ method: "POST", url: f.base + "/roles", cookies: f.cookies, payload: { name: "只有数据", permissionCodes: ["ssh.view"], reason: "数据" } });
    expect(codeOnly.statusCode, codeOnly.body).toBe(201);
    expect(dataOnly.statusCode, dataOnly.body).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-assignments", cookies: f.cookies, payload: { roleId: codeOnly.json().id, subjectType: "user", subjectId: f.userId, reason: "分配码" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-assignments", cookies: f.cookies, payload: { roleId: dataOnly.json().id, subjectType: "user", subjectId: f.userId, reason: "分配数据" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-data-grants", cookies: f.cookies, payload: { roleId: dataOnly.json().id, targets: [{ type: "ssh_connection", id: f.sshId }], reason: "只给另一角色" } })).statusCode).toBe(201);
    const access = await loadOrganizationAccess(f.db, f.org, f.userId);
    expect(access.allows("ssh.use", { type: "ssh_connection", id: f.sshId })).toBe(false);
    expect(access.operationPaths("ssh.use", { type: "ssh_connection", id: f.sshId })).toEqual([]);
    expect(serverNow(Date.now() + 86_400_000)).toBeLessThan(Date.now() + 5_000);
  });

  it("inherits project grants on invite and keeps the other path after leaving one sub-organization", async () => {
    const f = await fixture();
    const projectA = await f.app.inject({ method: "POST", url: f.base + "/projects", cookies: f.cookies, payload: { name: "平台组" } });
    const projectB = await f.app.inject({ method: "POST", url: f.base + "/projects", cookies: f.cookies, payload: { name: "数据组" } });
    expect(projectA.statusCode, projectA.body).toBe(201);
    expect(projectB.statusCode, projectB.body).toBe(201);
    const roleA = await f.app.inject({ method: "POST", url: f.base + "/roles", cookies: f.cookies, payload: { name: "平台操作", permissionCodes: ["ssh.view", "ssh.use"], reason: "项目角色" } });
    const roleB = await f.app.inject({ method: "POST", url: f.base + "/roles", cookies: f.cookies, payload: { name: "数据操作", permissionCodes: ["ssh.view"], reason: "另一项目" } });
    const roleAId = roleA.json().id as string;
    const roleBId = roleB.json().id as string;
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-assignments", cookies: f.cookies, payload: { roleId: roleAId, subjectType: "project", subjectId: projectA.json().id, reason: "平台组" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-assignments", cookies: f.cookies, payload: { roleId: roleBId, subjectType: "project", subjectId: projectB.json().id, reason: "数据组" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-data-grants", cookies: f.cookies, payload: { roleId: roleAId, targets: [{ type: "ssh_connection", id: f.sshId }], reason: "连接A" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-data-grants", cookies: f.cookies, payload: { roleId: roleBId, targets: [{ type: "ssh_connection", id: f.otherId }], reason: "连接B" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/feature-grants", cookies: f.cookies, payload: { subjectType: "project", subjectId: projectA.json().id, targets: [{ type: "ssh_connection", id: f.sshId }], features: { mcp: true, agent: false, webPlugins: false }, reason: "平台功能" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: f.base + "/feature-grants", cookies: f.cookies, payload: { subjectType: "project", subjectId: projectB.json().id, targets: [{ type: "ssh_connection", id: f.otherId }], features: { mcp: false, agent: true, webPlugins: false }, reason: "数据功能" } })).statusCode).toBe(201);
    const before = await roleState(f.db, f.org);
    const invite = await f.app.inject({ method: "POST", url: f.base + "/invitations", cookies: f.cookies, payload: { expiresInHours: 24, maxUses: 1, projectId: projectA.json().id } });
    expect(invite.statusCode, invite.body).toBe(201);
    const guest = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "guest", password: "guest" } });
    const guestId = guest.json().user.id as string;
    const guestCookies = { envman_session: guest.cookies[0].value };
    const accepted = await f.app.inject({ method: "POST", url: `/api/v1/organization-invitations/${invite.json().token}/accept`, cookies: guestCookies });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const after = await roleState(f.db, f.org);
    expect(after.roles).toHaveLength(before.roles.length);
    expect(after.dataGrants).toHaveLength(before.dataGrants.length);
    expect((await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: guestCookies, payload: { type: "organization", id: f.org } })).statusCode).toBe(200);
    let access = await loadOrganizationAccess(f.db, f.org, guestId);
    expect(access.allows("ssh.use", { type: "ssh_connection", id: f.sshId })).toBe(true);
    expect(access.allows("environment.update", { type: "environment", id: f.env })).toBe(false);
    expect(access.allows("approval.approve")).toBe(false);
    expect((await f.app.inject({ method: "POST", url: `${f.base}/projects/${projectB.json().id}/members`, cookies: f.cookies, payload: { userId: guestId } })).statusCode).toBe(201);
    access = await loadOrganizationAccess(f.db, f.org, guestId);
    expect(access.allows("ssh.view", { type: "ssh_connection", id: f.otherId })).toBe(true);
    expect(access.featureAllowed("mcp", { type: "ssh_connection", id: f.sshId })).toBe(true);
    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/projects/${projectA.json().id}/members/${guestId}`, cookies: f.cookies })).statusCode).toBe(204);
    access = await loadOrganizationAccess(f.db, f.org, guestId);
    expect(access.allows("ssh.use", { type: "ssh_connection", id: f.sshId })).toBe(false);
    expect(access.allows("ssh.view", { type: "ssh_connection", id: f.otherId })).toBe(true);
    expect(access.featureAllowed("mcp", { type: "ssh_connection", id: f.sshId })).toBe(false);
    expect(access.featureAllowed("agent", { type: "ssh_connection", id: f.otherId })).toBe(true);
    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/members/${guestId}`, cookies: f.cookies })).statusCode).toBe(204);
    access = await loadOrganizationAccess(f.db, f.org, guestId);
    expect(access.featureAllowed("agent", { type: "ssh_connection", id: f.otherId })).toBe(false);
    expect(access.allows("ssh.view", { type: "ssh_connection", id: f.otherId })).toBe(false);
  });

  it("redacts the catalog, narrows a sub-organization, and does not treat one connection as the environment", async () => {
    const f = await fixture();
    const project = await f.app.inject({ method: "POST", url: f.base + "/projects", cookies: f.cookies, payload: { name: "平台组" } });
    const otherProject = await f.app.inject({ method: "POST", url: f.base + "/projects", cookies: f.cookies, payload: { name: "无关组" } });
    const role = await grantRole(f.app, f.cookies, f.base, f.userId, ["ssh.view", "ssh.use"], [{ type: "ssh_connection", id: f.sshId }]);
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-assignments", cookies: f.cookies, payload: { roleId: role.roleId, subjectType: "project", subjectId: project.json().id, reason: "只属于平台组" } })).statusCode).toBe(201);
    const keyId = randomUUID();
    const now = new Date().toISOString();
    await f.db.prepare("INSERT INTO ssh_keys (id, workspace_type, workspace_id, name, algorithm, public_key, fingerprint, private_key_ciphertext, created_by_user_id, created_at, updated_at) VALUES (?, 'organization', ?, '密钥A', 'ed25519', 'ssh-ed25519 AAAA', 'SHA256:test', 'ciphertext', ?, ?, ?)").run(keyId, f.org, f.adminId, now, now);
    await f.db.prepare("UPDATE ssh_connections SET ssh_key_id = ? WHERE id = ?").run(keyId, f.sshId);
    const overview = await f.app.inject({ method: "GET", url: f.base + "/resource-overview", cookies: f.memberCookies });
    expect(overview.statusCode, overview.body).toBe(200);
    const body = overview.json();
    expect(body.entries.map((entry: { label: string }) => entry.label)).toEqual(["环境总览", "密钥与证书", "SSH 工作台", "数据库工作台", "Redis 工作台", "知识库"]);
    expect(overview.body).not.toContain("example.invalid");
    expect(overview.body).not.toContain("fake-password");
    expect(overview.body).not.toContain("secret-body-text");
    expect(overview.body).not.toContain("ciphertext");
    const environment = body.entries[0].items.find((item: { id: string }) => item.id === f.env);
    expect(environment.environmentAuthorized).toBe(false);
    expect(body.entries[2].items.map((item: { id: string }) => item.id)).toContain(f.sshId);
    const narrowed = await f.app.inject({ method: "GET", url: f.base + "/resource-overview?projectId=" + otherProject.json().id, cookies: f.memberCookies });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().entries[2].items.map((item: { id: string }) => item.id)).not.toContain(f.sshId);
    const projectView = await f.app.inject({ method: "GET", url: f.base + "/resource-overview?projectId=" + project.json().id, cookies: f.cookies });
    expect(projectView.json().entries[2].items.map((item: { id: string }) => item.id)).toContain(f.sshId);
    const access = await loadOrganizationAccess(f.db, f.org, f.userId);
    expect(access.allows("ssh.use", { type: "ssh_connection", id: f.sshId })).toBe(true);
    expect(access.allows("ssh.use", { type: "ssh_connection", id: f.otherId })).toBe(false);
    expect(access.allows("credential.export")).toBe(false);
    const exported = await f.app.inject({ method: "GET", url: `/api/v1/ssh-keys/${keyId}/export?part=private`, cookies: f.memberCookies });
    expect(exported.statusCode).toBe(403);
    const mine = await f.app.inject({ method: "GET", url: f.base + "/my-access", cookies: f.memberCookies });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(JSON.stringify(mine.json().dataGrants)).not.toContain("mcp");
    expect(mine.json().featureGrants.every((grant: { roleId?: string }) => grant.roleId === undefined)).toBe(true);
  });

  it("approves data and feature requests separately, rejects overlap, and keeps one grant plus the ledger", async () => {
    const f = await fixture();
    const role = await f.app.inject({ method: "POST", url: f.base + "/roles", cookies: f.cookies, payload: { name: "查询角色", permissionCodes: ["ssh.view"], reason: "申请用" } });
    const roleId = role.json().id as string;
    expect((await f.app.inject({ method: "POST", url: f.base + "/role-assignments", cookies: f.cookies, payload: { roleId, subjectType: "user", subjectId: f.userId, reason: "持有" } })).statusCode).toBe(201);
    const before = await roleState(f.db, f.org);
    const dataRequest = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.memberCookies,
      payload: { kind: "data", roleId, targets: [{ type: "ssh_connection", id: f.sshId }], durationMs: 3_600_000, reason: "需要查询" },
    });
    expect(dataRequest.statusCode, dataRequest.body).toBe(201);
    const requestId = dataRequest.json().id as string;
    const changed = await f.app.inject({ method: "PUT", url: f.base + "/roles/" + roleId, cookies: f.cookies, payload: { name: "查询角色", permissionCodes: ["ssh.view", "ssh.use"], reason: "审批中改权限" } });
    expect(changed.statusCode, changed.body).toBe(200);
    const blocked = await f.app.inject({ method: "POST", url: `${f.base}/grant-requests/${requestId}/decision`, cookies: f.cookies, payload: { decision: "approve", comment: "同意" } });
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(blocked.json().status).toBe("pending");
    expect(blocked.json().blockReason).toContain("重新申请");
    expect((await roleState(f.db, f.org)).dataGrants).toHaveLength(before.dataGrants.length);
    expect((await f.app.inject({ method: "PUT", url: f.base + "/roles/" + roleId, cookies: f.cookies, payload: { name: "查询角色", permissionCodes: ["ssh.view"], reason: "改回" } })).statusCode).toBe(200);
    const approved = await f.app.inject({ method: "POST", url: `${f.base}/grant-requests/${requestId}/decision`, cookies: f.cookies, payload: { decision: "approve", comment: "同意" } });
    expect(approved.json().status).toBe("approved");
    const again = await f.app.inject({ method: "POST", url: `${f.base}/grant-requests/${requestId}/decision`, cookies: f.cookies, payload: { decision: "approve", comment: "再次" } });
    expect(again.json().already).toBe(true);
    let state = await roleState(f.db, f.org);
    const approvedGrants = await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE role_id = ? AND request_id = ?").all(roleId, requestId) as Array<{ id: string }>;
    expect(approvedGrants).toHaveLength(1);
    expect(state.featureGrants).toHaveLength(before.featureGrants.length);
    expect(state.assignments).toHaveLength(before.assignments.length);
    const featureRequest = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.memberCookies,
      payload: { kind: "feature", features: { mcp: true, agent: false, webPlugins: false }, targets: [{ type: "ssh_connection", id: f.sshId }], durationMs: null, reason: "需要 MCP" },
    });
    expect(featureRequest.statusCode, featureRequest.body).toBe(201);
    const featureApproved = await f.app.inject({ method: "POST", url: `${f.base}/grant-requests/${featureRequest.json().id}/decision`, cookies: f.cookies, payload: { decision: "approve", comment: "同意功能" } });
    expect(featureApproved.json().status).toBe("approved");
    state = await roleState(f.db, f.org);
    expect(state.featureGrants).toHaveLength(before.featureGrants.length + 1);
    expect(state.featureGrants.some((grant) => grant.features.mcp)).toBe(true);
    expect(state.dataGrants.filter((grant) => grant.roleId === roleId)).toHaveLength(1);
    const flows = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    const defaults = flows.json().items.find((item: { isDefault: boolean }) => item.isDefault);
    const node = defaults.nodes[0];
    const firstFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "连接流程", nodes: [{ ...node, id: randomUUID(), name: "审批" }], targets: [{ type: "ssh_connection", id: f.sshId }] },
    });
    expect(firstFlow.statusCode, firstFlow.body).toBe(201);
    const overlap = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "冲突流程", nodes: [{ ...node, id: randomUUID(), name: "审批" }], targets: [{ type: "ssh_connection", id: f.sshId }] },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error).toBe("APPROVAL_SCOPE_CONFLICT");
    const ledgerBefore = (await f.app.inject({ method: "GET", url: f.base + "/grant-ledger", cookies: f.cookies })).json().items.length;
    const removed = await f.app.inject({ method: "DELETE", url: `${f.base}/role-data-grants/${approvedGrants[0].id}`, cookies: f.cookies, payload: { reason: "撤销数据授权" } });
    expect(removed.statusCode, removed.body).toBe(200);
    const ledger = await f.app.inject({ method: "GET", url: f.base + "/grant-ledger", cookies: f.cookies });
    expect(ledger.json().items.length).toBeGreaterThan(ledgerBefore);
    expect(ledger.json().items.some((row: { action: string }) => row.action.includes("生成") || row.action.includes("提交") || row.action.includes("审批"))).toBe(true);
  });

  it("requires a feature grant for automation, keeps a valid manual query, and ignores the client clock", async () => {
    const f = await fixture();
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    await grantRole(f.app, f.cookies, f.base, f.userId, ["ssh.view", "ssh.use"], [{ type: "ssh_connection", id: f.sshId }]);
    const upload = await grantRole(f.app, f.cookies, f.base, f.userId, ["ssh.upload"], [{ type: "ssh_connection", id: f.sshId }], soon);
    const listed = await f.app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies: f.memberCookies });
    expect(listed.statusCode, listed.body).toBe(200);
    const connection = listed.json().items.find((item: { id: string }) => item.id === f.sshId);
    expect(connection.operationWindow.label).toContain("部分操作剩余");
    const denied = await f.app.inject({
      method: "POST",
      url: `/api/v1/mcp/ssh-connections/${f.sshId}/command`,
      cookies: f.memberCookies,
      headers: { "x-channel": "manual", "x-viron-channel": "manual", "x-viron-internal-execution-channel": "client-made" },
      payload: { command: "", now: Date.now() + 86_400_000, clientTime: Date.now() + 86_400_000 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("FEATURE_FORBIDDEN");
    const mcpList = await runWithAuditSource("mcp", (headers) => f.app.inject({ method: "GET", url: "/api/v1/connections", cookies: f.memberCookies, headers }));
    expect(mcpList.statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: f.base + "/feature-grants", cookies: f.cookies, payload: { subjectType: "user", subjectId: f.userId, targets: [{ type: "ssh_connection", id: f.sshId }], features: { mcp: false, agent: true, webPlugins: false }, reason: "只有 Agent" } })).statusCode).toBe(201);
    const agentCall = await runWithExecutionChannel("agent", (channelHeaders) => runWithAuditSource("mcp", (auditHeaders) => f.app.inject({
      method: "POST",
      url: `/api/v1/mcp/ssh-connections/${f.sshId}/command`,
      cookies: f.memberCookies,
      headers: { ...channelHeaders, ...auditHeaders, "x-channel": "manual" },
      payload: { command: "" },
    })));
    expect(agentCall.statusCode).not.toBe(403);
    await f.db.prepare("UPDATE organization_role_data_grants SET expires_at = ? WHERE id = ?").run(past, upload.grantIds[0]);
    const viewOnly = await loadOrganizationAccess(f.db, f.org, f.userId);
    expect(viewOnly.allows("ssh.view", { type: "ssh_connection", id: f.sshId })).toBe(true);
    expect(viewOnly.allows("ssh.upload", { type: "ssh_connection", id: f.sshId })).toBe(false);
    const entryId = randomUUID();
    const stamp = new Date().toISOString();
    await f.db.prepare("INSERT INTO web_entries (id, environment_id, name, url, created_at, updated_at) VALUES (?, ?, '控制台', 'https://example.invalid', ?, ?)").run(entryId, f.env, stamp, stamp);
    const otherEnv = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "开发" } });
    await grantRole(f.app, f.cookies, f.base, f.userId, ["web.view"], [{ type: "web_entry", id: entryId }]);
    expect((await f.app.inject({ method: "POST", url: f.base + "/feature-grants", cookies: f.cookies, payload: { subjectType: "user", subjectId: f.userId, targets: [{ type: "environment", id: f.env }], features: { mcp: false, agent: false, webPlugins: true }, reason: "生产插件" } })).statusCode).toBe(201);
    const enabled = await f.app.inject({ method: "GET", url: `/api/v1/web-plugin-policy?environmentId=${f.env}`, cookies: f.memberCookies });
    const disabled = await f.app.inject({ method: "GET", url: `/api/v1/web-plugin-policy?environmentId=${otherEnv.json().id}`, cookies: f.memberCookies });
    expect(enabled.json().inject).toBe(true);
    expect(disabled.json()).toMatchObject({ inject: false, label: "环境未授权 · 已禁用" });
    const plain = desktopWebPartitionName("https://viron.example", f.userId, "credential");
    expect(desktopWebPartitionName("https://viron.example", f.userId, "credential")).toBe(plain);
    expect(desktopWebPartitionName("https://viron.example", f.userId, "credential", f.env)).not.toBe(desktopWebPartitionName("https://viron.example", f.userId, "credential", otherEnv.json().id));
  });

  it("pauses a countersign when an approver is lost, rejects an unqualified transfer, and keeps history on rollback", async () => {
    const f = await fixture();
    const approver = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "approver", password: "approver" } });
    const approverId = approver.json().user.id as string;
    const approverCookies = { envman_session: approver.cookies[0].value };
    const stamp = new Date().toISOString();
    await f.db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(f.org, approverId, stamp, stamp);
    expect((await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: approverCookies, payload: { type: "organization", id: f.org } })).statusCode).toBe(200);
    const approverRole = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "审批员", permissionCodes: ["approval.approve"], reason: "会签" },
    });
    const assignment = await f.app.inject({
      method: "POST",
      url: f.base + "/role-assignments",
      cookies: f.cookies,
      payload: { roleId: approverRole.json().id, subjectType: "user", subjectId: approverId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "审批资格" },
    });
    expect(assignment.statusCode, assignment.body).toBe(201);
    const held = await grantRole(f.app, f.cookies, f.base, f.userId, ["ssh.view"], [{ type: "ssh_connection", id: f.sshId }, { type: "ssh_connection", id: f.otherId }]);
    const node = (name: string, mode: string) => ({ id: randomUUID(), name, mode, approverUserIds: [f.adminId, approverId], approverRoleId: null, allowSelf: false, requireComment: false });
    const pauseFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "会签流程", nodes: [node("会签", "all")], targets: [{ type: "ssh_connection", id: f.otherId }] },
    });
    expect(pauseFlow.statusCode, pauseFlow.body).toBe(201);
    const rollbackFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "回退流程", nodes: [node("第一会签", "all"), node("第二节点", "any")], targets: [{ type: "ssh_connection", id: f.sshId }] },
    });
    expect(rollbackFlow.statusCode, rollbackFlow.body).toBe(201);
    const submit = (id: string, reason: string) => f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.memberCookies,
      payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id }], durationMs: 3_600_000, reason },
    });
    const pauseRequest = await submit(f.otherId, "会签申请");
    const rollbackRequest = await submit(f.sshId, "回退申请");
    expect(pauseRequest.statusCode, pauseRequest.body).toBe(201);
    expect(rollbackRequest.statusCode, rollbackRequest.body).toBe(201);
    const original = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${rollbackRequest.json().id}`, cookies: f.cookies });
    expect(original.json().nodes[0].name).toBe("第一会签");
    const edited = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { id: rollbackFlow.json().id, name: "回退流程已改", nodes: [node("改名", "all"), node("第二节点", "any")], targets: [{ type: "ssh_connection", id: f.sshId }] },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const unchanged = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${rollbackRequest.json().id}`, cookies: f.cookies });
    expect(unchanged.json().nodes[0].name).toBe("第一会签");
    const transfer = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${pauseRequest.json().id}/revise`,
      cookies: f.cookies,
      payload: { type: "transfer", userId: f.userId, comment: "转给没有审批权的成员" },
    });
    expect(transfer.statusCode, transfer.body).toBe(409);
    expect(transfer.json().error).toBe("APPROVER_REQUIRED");
    const added = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${pauseRequest.json().id}/revise`,
      cookies: f.cookies,
      payload: { type: "add_sign", userId: f.userId, comment: "加签给没有审批权的成员" },
    });
    expect(added.statusCode, added.body).toBe(409);
    expect(added.json().error).toBe("APPROVER_REQUIRED");
    const approve = (requestId: string, cookies: { envman_session: string }) => f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${requestId}/decision`,
      cookies,
      payload: { decision: "approve", comment: "同意" },
    });
    expect((await approve(rollbackRequest.json().id, f.cookies)).statusCode).toBe(200);
    const second = await approve(rollbackRequest.json().id, approverCookies);
    expect(second.statusCode, second.body).toBe(200);
    const midway = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${rollbackRequest.json().id}`, cookies: f.cookies });
    expect(midway.json()).toMatchObject({ status: "pending", stageIndex: 1 });
    const rolled = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${rollbackRequest.json().id}/revise`,
      cookies: f.cookies,
      payload: { type: "rollback", stageIndex: 0, comment: "退回会签" },
    });
    expect(rolled.statusCode, rolled.body).toBe(200);
    const again = await approve(rollbackRequest.json().id, f.cookies);
    expect(again.statusCode, again.body).toBe(200);
    const afterRollback = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${rollbackRequest.json().id}`, cookies: f.cookies });
    expect(afterRollback.json()).toMatchObject({ status: "pending", stageIndex: 0 });
    expect(afterRollback.json().decisions.some((item: { decision: string; superseded?: boolean }) => item.decision === "approve" && item.superseded)).toBe(true);
    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/role-assignments/${assignment.json().id}`, cookies: f.cookies, payload: { reason: "失去资格" } })).statusCode).toBe(200);
    const paused = await approve(pauseRequest.json().id, f.cookies);
    expect(paused.statusCode, paused.body).toBe(409);
    expect(paused.json().error).toBe("APPROVAL_PAUSED");
    expect(paused.json().message).toContain("失去资格");
    const pausedRead = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${pauseRequest.json().id}`, cookies: f.cookies });
    expect(pausedRead.json().status).toBe("pending");
    expect(pausedRead.json().blockReason).toContain("失去资格");
    expect(pausedRead.json().nodes[0].approverIds).toContain(approverId);
    expect(pausedRead.json().canDecide).toBe(false);
    const grants = await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE role_id = ? AND request_id = ?").all(held.roleId, pauseRequest.json().id);
    expect(grants).toHaveLength(0);
  });
});
