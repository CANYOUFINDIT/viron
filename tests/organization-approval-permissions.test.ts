import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { loadOrganizationAccess } from "../src/server/organization-rbac.js";

const scratchRoot = join(process.cwd(), "private", "grok-supervision-20261011");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function fixture() {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "viron-approval-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 7),
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
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "审批边界组织" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产" } });
  expect(environment.statusCode, environment.body).toBe(201);
  const env = environment.json().id as string;
  async function connect(name: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: { name, host: `${name}.invalid`, port: 22, username: "root", authType: "password", password: "fake-password", environmentIds: [env] },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  }
  const sshA = await connect("连接A");
  const sshB = await connect("连接B");
  const base = `/api/v1/organizations/${org}`;
  async function person(username: string) {
    const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username, password: "test-password-123" } });
    expect(registered.statusCode, registered.body).toBe(201);
    const userId = registered.json().user.id as string;
    const session = { envman_session: registered.cookies[0].value };
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, now, now);
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: session, payload: { type: "organization", id: org } })).statusCode).toBe(200);
    return { userId, cookies: session };
  }
  async function assign(userId: string, codes: string[], scope: "organization" | "resources", targets: Array<{ type: string; id: string }> = []) {
    const role = await app.inject({
      method: "POST",
      url: base + "/roles",
      cookies,
      payload: { name: `${codes.join("-")}-${randomUUID()}`, permissionCodes: codes, reason: "审批边界" },
    });
    expect(role.statusCode, role.body).toBe(201);
    const roleId = role.json().id as string;
    const assignment = await app.inject({
      method: "POST",
      url: base + "/role-assignments",
      cookies,
      payload: {
        roleId,
        subjectType: "user",
        subjectId: userId,
        managementScope: { kind: scope, ids: [], includeChildren: scope === "organization" },
        reason: "分配审批资格",
      },
    });
    expect(assignment.statusCode, assignment.body).toBe(201);
    if (targets.length) {
      const grant = await app.inject({
        method: "POST",
        url: base + "/role-data-grants",
        cookies,
        payload: { roleId, targets, reason: "限定资源范围" },
      });
      expect(grant.statusCode, grant.body).toBe(201);
    }
    return { roleId, assignmentId: assignment.json().id as string };
  }
  return { app, db, cookies, adminId, org, env, sshA, sshB, base, person, assign };
}

function node(name: string, mode: string, approverUserIds: string[]) {
  return { id: randomUUID(), name, mode, approverUserIds, approverRoleId: null, allowSelf: false, requireComment: false };
}

describe("approval permission boundaries", () => {
  it("lets only approval.workflow maintain flows, and separates approve from reject", async () => {
    const f = await fixture();
    const applicant = await f.person("applicant");
    const maintainer = await f.person("workflow-only");
    const approver = await f.person("approve-only");
    const rejector = await f.person("reject-only");
    await f.assign(maintainer.userId, ["approval.workflow"], "organization");
    await f.assign(approver.userId, ["approval.approve"], "organization");
    await f.assign(rejector.userId, ["approval.reject"], "organization");
    const held = await f.assign(applicant.userId, ["ssh.view"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    const maintainerAccess = await loadOrganizationAccess(f.db, f.org, maintainer.userId);
    const approverAccess = await loadOrganizationAccess(f.db, f.org, approver.userId);
    const rejectorAccess = await loadOrganizationAccess(f.db, f.org, rejector.userId);
    expect(maintainerAccess.allows("approval.workflow")).toBe(true);
    expect(maintainerAccess.allows("approval.approve")).toBe(false);
    expect(maintainerAccess.allows("approval.reject")).toBe(false);
    expect(approverAccess.allows("approval.approve")).toBe(true);
    expect(approverAccess.allows("approval.workflow")).toBe(false);
    expect(approverAccess.allows("approval.reject")).toBe(false);
    expect(rejectorAccess.allows("approval.reject")).toBe(true);
    expect(rejectorAccess.allows("approval.approve")).toBe(false);
    expect(rejectorAccess.allows("approval.workflow")).toBe(false);

    const flowBody = {
      name: "指定连接流程",
      nodes: [node("审批", "any", [approver.userId, rejector.userId])],
      targets: [{ type: "ssh_connection", id: f.sshA }],
    };
    const approverSave = await f.app.inject({ method: "POST", url: f.base + "/approval-flows", cookies: approver.cookies, payload: flowBody });
    expect(approverSave.statusCode, approverSave.body).toBe(403);
    expect(approverSave.json().error).toBe("ACTION_FORBIDDEN");
    const rejectorSave = await f.app.inject({ method: "POST", url: f.base + "/approval-flows", cookies: rejector.cookies, payload: flowBody });
    expect(rejectorSave.statusCode, rejectorSave.body).toBe(403);
    const saved = await f.app.inject({ method: "POST", url: f.base + "/approval-flows", cookies: maintainer.cookies, payload: flowBody });
    expect(saved.statusCode, saved.body).toBe(201);
    const listed = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: maintainer.cookies });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.some((item: { id: string }) => item.id === saved.json().id)).toBe(true);
    const removed = await f.app.inject({ method: "DELETE", url: `${f.base}/approval-flows/${saved.json().id}`, cookies: approver.cookies });
    expect(removed.statusCode, removed.body).toBe(403);
    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/approval-flows/${saved.json().id}`, cookies: maintainer.cookies })).statusCode).toBe(204);

    const recreated = await f.app.inject({ method: "POST", url: f.base + "/approval-flows", cookies: maintainer.cookies, payload: flowBody });
    expect(recreated.statusCode, recreated.body).toBe(201);
    const request = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: applicant.cookies,
      payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id: f.sshA }], durationMs: 3_600_000, reason: "申请连接A" },
    });
    expect(request.statusCode, request.body).toBe(201);
    const requestId = request.json().id as string;
    const todos = await f.app.inject({ method: "GET", url: f.base + "/grant-requests?view=todo", cookies: rejector.cookies });
    expect(todos.statusCode, todos.body).toBe(200);
    expect(todos.json().items.map((item: { id: string }) => item.id)).toContain(requestId);
    const rejectorView = todos.json().items.find((item: { id: string }) => item.id === requestId);
    expect(rejectorView).toMatchObject({ canDecide: true, canApprove: false, canReject: true });
    expect(rejectorView.nodes[0].approverIds).toEqual(expect.arrayContaining([approver.userId, rejector.userId]));
    const approverTodos = await f.app.inject({ method: "GET", url: f.base + "/grant-requests?view=todo", cookies: approver.cookies });
    expect(approverTodos.json().items.find((item: { id: string }) => item.id === requestId)).toMatchObject({ canApprove: true, canReject: false });

    const rejectedApprove = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${requestId}/decision`,
      cookies: rejector.cookies,
      payload: { decision: "approve", comment: "拒绝资格不能通过" },
    });
    expect(rejectedApprove.statusCode, rejectedApprove.body).toBe(403);
    expect(rejectedApprove.json().error).toBe("APPROVAL_DECISION_FORBIDDEN");
    const approvedReject = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${requestId}/decision`,
      cookies: approver.cookies,
      payload: { decision: "reject", comment: "通过资格不能拒绝" },
    });
    expect(approvedReject.statusCode, approvedReject.body).toBe(403);
    expect(approvedReject.json().error).toBe("APPROVAL_DECISION_FORBIDDEN");
    const rejected = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${requestId}/decision`,
      cookies: rejector.cookies,
      payload: { decision: "reject", comment: "拒绝" },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ status: "rejected", grantIds: [] });
    const grants = await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE role_id = ? AND request_id = ?").all(held.roleId, requestId);
    expect(grants).toHaveLength(0);
  });

  it("limits approve and reject to the granted resources and rejects another organization", async () => {
    const f = await fixture();
    const applicant = await f.person("applicant-scope");
    const scoped = await f.person("scoped-approver");
    const held = await f.assign(applicant.userId, ["ssh.view"], "resources", [{ type: "ssh_connection", id: f.sshA }, { type: "ssh_connection", id: f.sshB }]);
    const scopedRole = await f.assign(scoped.userId, ["approval.approve", "approval.reject"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    const access = await loadOrganizationAccess(f.db, f.org, scoped.userId);
    expect(access.allows("approval.approve", { type: "ssh_connection", id: f.sshA })).toBe(true);
    expect(access.allows("approval.reject", { type: "ssh_connection", id: f.sshA })).toBe(true);
    expect(access.allows("approval.approve", { type: "ssh_connection", id: f.sshB })).toBe(false);
    expect(access.allows("approval.approve")).toBe(false);

    const flowA = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "连接A流程", nodes: [node("范围审批", "any", [scoped.userId])], targets: [{ type: "ssh_connection", id: f.sshA }] },
    });
    expect(flowA.statusCode, flowA.body).toBe(201);
    const flowB = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "连接B流程", nodes: [node("范围审批", "all", [scoped.userId, f.adminId])], targets: [{ type: "ssh_connection", id: f.sshB }] },
    });
    expect(flowB.statusCode, flowB.body).toBe(201);
    const submit = (id: string, reason: string) => f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: applicant.cookies,
      payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id }], durationMs: 3_600_000, reason },
    });
    const onA = await submit(f.sshA, "申请A");
    const onB = await submit(f.sshB, "申请B");
    expect(onA.statusCode, onA.body).toBe(201);
    expect(onB.statusCode, onB.body).toBe(201);
    const outside = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${onB.json().id}`, cookies: f.cookies });
    expect(outside.json().nodes[0].approverIds).not.toContain(scoped.userId);
    expect(outside.json().nodes[0].approverIds).toContain(f.adminId);
    const deniedB = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${onB.json().id}/decision`,
      cookies: scoped.cookies,
      payload: { decision: "approve", comment: "越权" },
    });
    expect(deniedB.statusCode, deniedB.body).toBe(403);
    expect(deniedB.json().error).toBe("APPROVER_REQUIRED");

    const allowedA = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${onA.json().id}/decision`,
      cookies: scoped.cookies,
      payload: { decision: "reject", comment: "范围内拒绝" },
    });
    expect(allowedA.statusCode, allowedA.body).toBe(200);
    expect(allowedA.json().status).toBe("rejected");

    const again = await submit(f.sshA, "撤销范围后再审");
    expect(again.statusCode, again.body).toBe(201);
    const grantIds = await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE role_id = ? AND source = 'direct'").all<{ id: string }>(scopedRole.roleId);
    expect(grantIds.length).toBeGreaterThan(0);
    for (const grant of grantIds)
      expect((await f.app.inject({ method: "DELETE", url: `${f.base}/role-data-grants/${grant.id}`, cookies: f.cookies, payload: { reason: "收回范围" } })).statusCode).toBe(200);
    const narrowed = await loadOrganizationAccess(f.db, f.org, scoped.userId);
    expect(narrowed.allows("approval.approve", { type: "ssh_connection", id: f.sshA })).toBe(false);
    const afterRevoke = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${again.json().id}/decision`,
      cookies: scoped.cookies,
      payload: { decision: "approve", comment: "范围已收回" },
    });
    expect(afterRevoke.statusCode, afterRevoke.body).toBe(403);

    const otherOrg = await f.app.inject({ method: "POST", url: "/api/v1/organizations", cookies: f.cookies, payload: { name: "另一个组织" } });
    expect(otherOrg.statusCode, otherOrg.body).toBe(201);
    const otherId = otherOrg.json().id as string;
    expect((await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: f.cookies, payload: { type: "organization", id: otherId } })).statusCode).toBe(200);
    const otherEnv = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "外部" } });
    const otherSsh = await f.app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies: f.cookies,
      payload: { name: "外部连接", host: "foreign.invalid", port: 22, username: "root", authType: "password", password: "fake-password", environmentIds: [otherEnv.json().id] },
    });
    expect(otherSsh.statusCode, otherSsh.body).toBe(201);
    expect((await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: f.cookies, payload: { type: "organization", id: f.org } })).statusCode).toBe(200);
    const foreignTarget = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "跨组织目标", nodes: [node("审批", "any", [f.adminId])], targets: [{ type: "ssh_connection", id: otherSsh.json().id }] },
    });
    expect(foreignTarget.statusCode, foreignTarget.body).toBe(400);
    expect(foreignTarget.json().error).toBe("INVALID_RESOURCE");
    const foreignRoute = await f.app.inject({
      method: "POST",
      url: `/api/v1/organizations/${otherId}/approval-flows`,
      cookies: scoped.cookies,
      payload: { name: "跨组织维护", nodes: [node("审批", "any", [scoped.userId])], targets: [{ type: "ssh_connection", id: f.sshA }] },
    });
    expect(foreignRoute.statusCode, foreignRoute.body).toBe(403);
    expect(foreignRoute.json().error).toBe("ORGANIZATION_WORKSPACE_REQUIRED");
  });

  it("keeps a lost countersign member and does not skip a sequence approver", async () => {
    const f = await fixture();
    const applicant = await f.person("applicant-order");
    const first = await f.person("sequence-first");
    const second = await f.person("sequence-second");
    const held = await f.assign(applicant.userId, ["ssh.view"], "resources", [{ type: "ssh_connection", id: f.sshA }, { type: "ssh_connection", id: f.sshB }]);
    await f.assign(first.userId, ["approval.approve"], "organization");
    const secondRole = await f.assign(second.userId, ["approval.approve"], "organization");
    const sequenceFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "依次流程", nodes: [node("依次", "sequence", [first.userId, second.userId])], targets: [{ type: "ssh_connection", id: f.sshA }] },
    });
    const countersignFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "会签流程", nodes: [node("会签", "all", [first.userId, second.userId])], targets: [{ type: "ssh_connection", id: f.sshB }] },
    });
    expect(sequenceFlow.statusCode, sequenceFlow.body).toBe(201);
    expect(countersignFlow.statusCode, countersignFlow.body).toBe(201);
    const submit = (id: string, reason: string) => f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: applicant.cookies,
      payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id }], durationMs: 3_600_000, reason },
    });
    const ordered = await submit(f.sshA, "依次申请");
    const countersign = await submit(f.sshB, "会签申请");
    expect(ordered.statusCode, ordered.body).toBe(201);
    expect(countersign.statusCode, countersign.body).toBe(201);
    const early = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${ordered.json().id}/decision`,
      cookies: second.cookies,
      payload: { decision: "approve", comment: "还没轮到" },
    });
    expect(early.statusCode, early.body).toBe(403);
    expect(early.json().message).toContain("还没轮到");
    const firstStep = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${ordered.json().id}/decision`,
      cookies: first.cookies,
      payload: { decision: "approve", comment: "第一人" },
    });
    expect(firstStep.statusCode, firstStep.body).toBe(200);
    expect(firstStep.json()).toMatchObject({ status: "pending" });
    const secondStep = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${ordered.json().id}/decision`,
      cookies: second.cookies,
      payload: { decision: "approve", comment: "第二人" },
    });
    expect(secondStep.statusCode, secondStep.body).toBe(200);
    expect(secondStep.json().status).toBe("approved");
    expect(secondStep.json().grantIds).toHaveLength(1);
    expect(await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE id = ?").get(secondStep.json().grantIds[0])).toBeTruthy();

    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/role-assignments/${secondRole.assignmentId}`, cookies: f.cookies, payload: { reason: "失去资格" } })).statusCode).toBe(200);
    const paused = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${countersign.json().id}/decision`,
      cookies: first.cookies,
      payload: { decision: "approve", comment: "会签缺人" },
    });
    expect(paused.statusCode, paused.body).toBe(409);
    expect(paused.json().error).toBe("APPROVAL_PAUSED");
    const pausedRead = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${countersign.json().id}`, cookies: f.cookies });
    expect(pausedRead.json()).toMatchObject({ status: "pending" });
    expect(pausedRead.json().nodes[0].approverIds).toEqual(expect.arrayContaining([first.userId, second.userId]));
    expect(await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(countersign.json().id)).toHaveLength(0);
  });

  it("does not auto-pass countersign or sequence after approve is revoked but reject remains", async () => {
    const f = await fixture();
    const applicant = await f.person("applicant-keep-reject");
    const approver = await f.person("countersign-a");
    const narrowed = await f.person("countersign-b");
    const held = await f.assign(applicant.userId, ["ssh.view"], "resources", [
      { type: "ssh_connection", id: f.sshA },
      { type: "ssh_connection", id: f.sshB },
    ]);
    await f.assign(approver.userId, ["approval.approve"], "organization");
    const approveRole = await f.assign(narrowed.userId, ["approval.approve"], "organization");
    await f.assign(narrowed.userId, ["approval.reject"], "organization");
    const before = await loadOrganizationAccess(f.db, f.org, narrowed.userId);
    expect(before.allows("approval.approve")).toBe(true);
    expect(before.allows("approval.reject")).toBe(true);

    const sequenceFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "依次保留拒绝",
        nodes: [node("依次", "sequence", [approver.userId, narrowed.userId])],
        targets: [{ type: "ssh_connection", id: f.sshA }],
      },
    });
    const countersignFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "会签保留拒绝",
        nodes: [node("会签", "all", [approver.userId, narrowed.userId])],
        targets: [{ type: "ssh_connection", id: f.sshB }],
      },
    });
    expect(sequenceFlow.statusCode, sequenceFlow.body).toBe(201);
    expect(countersignFlow.statusCode, countersignFlow.body).toBe(201);
    const submit = (id: string, reason: string) =>
      f.app.inject({
        method: "POST",
        url: f.base + "/grant-requests",
        cookies: applicant.cookies,
        payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id }], durationMs: 3_600_000, reason },
      });
    const ordered = await submit(f.sshA, "依次两人原先都能通过");
    const countersign = await submit(f.sshB, "会签两人原先都能通过");
    expect(ordered.statusCode, ordered.body).toBe(201);
    expect(countersign.statusCode, countersign.body).toBe(201);

    expect((await f.app.inject({
      method: "DELETE",
      url: `${f.base}/role-assignments/${approveRole.assignmentId}`,
      cookies: f.cookies,
      payload: { reason: "只收回通过权" },
    })).statusCode).toBe(200);
    const after = await loadOrganizationAccess(f.db, f.org, narrowed.userId);
    expect(after.allows("approval.approve")).toBe(false);
    expect(after.allows("approval.reject")).toBe(true);

    const decide = (requestId: string, cookies: { envman_session: string }, decision: "approve" | "reject", comment: string) =>
      f.app.inject({
        method: "POST",
        url: `${f.base}/grant-requests/${requestId}/decision`,
        cookies,
        payload: { decision, comment },
      });
    async function staysOpen(requestId: string) {
      const attempt = await decide(requestId, approver.cookies, "approve", "剩下的通过人审批");
      expect(attempt.statusCode, attempt.body).toBe(409);
      expect(attempt.json().error).toBe("APPROVAL_PAUSED");
      const read = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${requestId}`, cookies: f.cookies });
      expect(read.json()).toMatchObject({ status: "pending" });
      expect(read.json().blockReason).toContain("失去资格");
      expect(read.json().nodes[0].approverIds).toEqual([approver.userId, narrowed.userId]);
      const raw = await f.db.prepare("SELECT workflow_snapshot_json FROM organization_grant_requests WHERE id = ?").get<{ workflow_snapshot_json: string }>(requestId);
      const snapshot = JSON.parse(raw!.workflow_snapshot_json) as { nodes: Array<{ resolvedApproverIds: string[]; passApproverIds: string[] }> };
      expect(snapshot.nodes[0].resolvedApproverIds).toEqual([approver.userId, narrowed.userId]);
      expect(snapshot.nodes[0].passApproverIds).toEqual([approver.userId, narrowed.userId]);
      expect(await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(requestId)).toHaveLength(0);
    }
    await staysOpen(ordered.json().id);
    await staysOpen(countersign.json().id);

    const todos = await f.app.inject({ method: "GET", url: f.base + "/grant-requests?view=todo", cookies: narrowed.cookies });
    expect(todos.statusCode, todos.body).toBe(200);
    const visible = todos.json().items.find((item: { id: string }) => item.id === countersign.json().id);
    expect(visible).toMatchObject({ canDecide: true, canApprove: false, canReject: true });
    expect(visible.nodes[0].approverIds).toEqual([approver.userId, narrowed.userId]);
    const rejected = await decide(countersign.json().id, narrowed.cookies, "reject", "只剩拒绝权");
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ status: "rejected", grantIds: [] });
    expect(await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(countersign.json().id)).toHaveLength(0);
    const sequenceStillOpen = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${ordered.json().id}`, cookies: f.cookies });
    expect(sequenceStillOpen.json()).toMatchObject({ status: "pending" });
    expect(sequenceStillOpen.json().nodes[0].approverIds).toEqual([approver.userId, narrowed.userId]);
  });
});
