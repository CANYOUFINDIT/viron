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

  it("rolls back approval and withdrawal with the ledger, and rejects closed requests from other members", async () => {
    const f = await fixture();
    const applicant = await f.person("atomic-applicant");
    const approver = await f.person("atomic-approver");
    const outsider = await f.person("atomic-outsider");
    await f.assign(approver.userId, ["approval.approve", "approval.reject"], "organization");
    await f.assign(outsider.userId, ["approval.workflow"], "organization");
    const held = await f.assign(applicant.userId, ["ssh.view"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    const flow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "原子流程", nodes: [node("审批", "any", [approver.userId])], targets: [{ type: "ssh_connection", id: f.sshA }] },
    });
    expect(flow.statusCode, flow.body).toBe(201);
    const submit = () => f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: applicant.cookies,
      payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id: f.sshA }], durationMs: 3_600_000, reason: "原子验收" },
    });
    const originalPrepare = f.db.prepare.bind(f.db);
    async function failLedger(action: string, requestId: string, call: () => Promise<{ statusCode: number; body: string; json: () => { status?: string } }>) {
      f.db.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        if (!sql.includes("INSERT INTO organization_grant_ledger")) return statement;
        return {
          ...statement,
          run: async (...values: unknown[]) => {
            if (values[4] === action) throw new Error("fictional acceptance ledger failure");
            return statement.run(...values);
          },
        };
      }) as typeof f.db.prepare;
      try {
        const result = await call();
        const detail = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${requestId}`, cookies: applicant.cookies });
        const grants = await originalPrepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(requestId);
        expect(result.statusCode, result.body).toBe(500);
        expect(detail.json().status).toBe("pending");
        expect(grants).toHaveLength(0);
      } finally {
        f.db.prepare = originalPrepare;
      }
    }
    const approveTarget = await submit();
    expect(approveTarget.statusCode, approveTarget.body).toBe(201);
    await failLedger("审批通过", approveTarget.json().id, () => f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${approveTarget.json().id}/decision`,
      cookies: approver.cookies,
      payload: { decision: "approve", comment: "故障" },
    }));
    const withdrawTarget = await submit();
    await failLedger("撤回授权申请", withdrawTarget.json().id, () => f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${withdrawTarget.json().id}/withdraw`,
      cookies: applicant.cookies,
      payload: { reason: "故障" },
    }));

    const [approved, withdrawn] = [await submit(), await submit()];
    const approvedOnce = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${approved.json().id}/decision`,
      cookies: approver.cookies,
      payload: { decision: "approve", comment: "通过" },
    });
    expect(approvedOnce.statusCode, approvedOnce.body).toBe(200);
    const repeated = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${approved.json().id}/decision`,
      cookies: approver.cookies,
      payload: { decision: "approve", comment: "重复" },
    });
    expect(repeated.json()).toMatchObject({ already: true, status: "approved" });
    expect(await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(approved.json().id)).toHaveLength(1);
    const withdrawnOnce = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${withdrawn.json().id}/withdraw`,
      cookies: applicant.cookies,
      payload: { reason: "撤回" },
    });
    expect(withdrawnOnce.json()).toMatchObject({ status: "withdrawn", grantIds: [] });
    const withdrawnAgain = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${withdrawn.json().id}/withdraw`,
      cookies: applicant.cookies,
      payload: { reason: "再撤回" },
    });
    expect(withdrawnAgain.json()).toMatchObject({ already: true, status: "withdrawn" });
    expect(await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(withdrawn.json().id)).toHaveLength(0);
    for (const requestId of [approved.json().id, withdrawn.json().id]) {
      const decision = await f.app.inject({
        method: "POST",
        url: `${f.base}/grant-requests/${requestId}/decision`,
        cookies: outsider.cookies,
        payload: { decision: "approve", comment: "越权" },
      });
      const withdraw = await f.app.inject({
        method: "POST",
        url: `${f.base}/grant-requests/${requestId}/withdraw`,
        cookies: outsider.cookies,
        payload: { reason: "越权" },
      });
      expect([403, 404]).toContain(decision.statusCode);
      expect([403, 404]).toContain(withdraw.statusCode);
    }
    const ledger = await f.db.prepare("SELECT actor_id, actor_name, action, before_json, after_json, channel FROM organization_grant_ledger WHERE request_id = ?").all<{ actor_id: string; actor_name: string; action: string; before_json: string; after_json: string; channel: string }>(approved.json().id);
    const approval = ledger.find((row) => row.action === "审批通过");
    const generated = ledger.find((row) => row.action === "生成数据授权");
    expect(approval).toMatchObject({ actor_id: approver.userId, channel: "request" });
    expect(approval?.actor_name).not.toBe(approver.userId);
    expect(approval?.actor_name.length).toBeGreaterThan(0);
    expect(JSON.parse(approval!.before_json).status).toBe("pending");
    expect(JSON.parse(approval!.after_json).status).toBe("approved");
    expect(generated?.actor_id).toBe(approver.userId);
    expect(JSON.stringify(ledger)).not.toMatch(/password|ciphertext|fake-password/i);

    const racing = await submit();
    const [raceApprove, raceWithdraw] = await Promise.all([
      f.app.inject({ method: "POST", url: `${f.base}/grant-requests/${racing.json().id}/decision`, cookies: approver.cookies, payload: { decision: "approve", comment: "并发" } }),
      f.app.inject({ method: "POST", url: `${f.base}/grant-requests/${racing.json().id}/withdraw`, cookies: applicant.cookies, payload: { reason: "并发" } }),
    ]);
    expect([raceApprove.statusCode, raceWithdraw.statusCode].every((code) => code === 200 || code === 403 || code === 409)).toBe(true);
    const finalRow = await f.db.prepare("SELECT status FROM organization_grant_requests WHERE id = ?").get<{ status: string }>(racing.json().id);
    const raceGrants = await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(racing.json().id);
    expect(["approved", "withdrawn"]).toContain(finalRow?.status);
    expect(raceGrants).toHaveLength(finalRow?.status === "approved" ? 1 : 0);
  });

  it("filters request and ledger reads by the viewer's resource scope", async () => {
    const f = await fixture();
    const applicant = await f.person("scope-applicant");
    const viewer = await f.person("scope-viewer");
    const held = await f.assign(applicant.userId, ["ssh.view"], "resources", [{ type: "ssh_connection", id: f.sshA }, { type: "ssh_connection", id: f.sshB }]);
    await f.assign(viewer.userId, ["approval.view", "audit.view"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    const submit = (id: string, reason: string) => f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: applicant.cookies,
      payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id }], durationMs: 3_600_000, reason },
    });
    const onA = await submit(f.sshA, "范围内申请");
    const onB = await submit(f.sshB, "范围外申请");
    expect(onA.statusCode, onA.body).toBe(201);
    expect(onB.statusCode, onB.body).toBe(201);
    const all = await f.app.inject({ method: "GET", url: f.base + "/grant-requests?view=all", cookies: viewer.cookies });
    expect(all.statusCode, all.body).toBe(200);
    const ids = all.json().items.map((item: { id: string }) => item.id);
    expect(ids).toContain(onA.json().id);
    expect(ids).not.toContain(onB.json().id);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${onA.json().id}`, cookies: viewer.cookies })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${onB.json().id}`, cookies: viewer.cookies })).statusCode).toBe(404);
    const mine = await f.app.inject({ method: "GET", url: f.base + "/grant-requests?view=mine", cookies: applicant.cookies });
    expect(mine.json().items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([onA.json().id, onB.json().id]));
    expect((await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${onB.json().id}`, cookies: applicant.cookies })).statusCode).toBe(200);
    const ledger = await f.app.inject({ method: "GET", url: f.base + "/grant-ledger", cookies: viewer.cookies });
    expect(ledger.statusCode, ledger.body).toBe(200);
    expect(ledger.json().items.some((item: { requestId: string }) => item.requestId === onA.json().id)).toBe(true);
    expect(ledger.json().items.some((item: { requestId: string }) => item.requestId === onB.json().id)).toBe(false);
    expect((await f.app.inject({ method: "GET", url: f.base + "/grant-ledger?export=1", cookies: viewer.cookies })).statusCode).toBe(403);
    await f.assign(viewer.userId, ["audit.export"], "organization");
    const exported = await f.app.inject({ method: "GET", url: f.base + "/grant-ledger?export=1", cookies: viewer.cookies });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json().items.some((item: { requestId: string }) => item.requestId === onA.json().id)).toBe(true);
    expect(exported.json().items.some((item: { requestId: string }) => item.requestId === onB.json().id)).toBe(false);
    const adminLedger = await f.app.inject({ method: "GET", url: f.base + "/grant-ledger", cookies: f.cookies });
    expect(adminLedger.json().items.some((item: { requestId: string }) => item.requestId === onB.json().id)).toBe(true);
  });

  it("stores node operation switches, snapshots them, and exposes only eligible revision choices", async () => {
    const f = await fixture();
    const applicant = await f.person("switch-applicant");
    const approver = await f.person("switch-approver");
    const second = await f.person("switch-second");
    const stranger = await f.person("switch-stranger");
    const outsider = await f.person("switch-outsider");
    const reader = await f.person("switch-reader");
    await f.assign(approver.userId, ["approval.approve"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    await f.assign(second.userId, ["approval.approve"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    await f.assign(stranger.userId, ["ssh.view"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    await f.assign(reader.userId, ["approval.view"], "organization");
    const held = await f.assign(applicant.userId, ["ssh.view"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    const target = { type: "ssh_connection", id: f.sshA };
    const closedNode = {
      id: randomUUID(),
      name: "可配置节点",
      mode: "all",
      approverUserIds: [approver.userId],
      approverRoleId: null,
      allowSelf: false,
      requireComment: true,
      allowTransfer: false,
      allowAddSign: false,
      allowRollback: false,
    };
    const closed = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { name: "关闭节点操作", nodes: [closedNode], targets: [target] },
    });
    expect(closed.statusCode, closed.body).toBe(201);
    const savedFlows = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    const savedClosed = savedFlows.json().items.find((item: { id: string }) => item.id === closed.json().id);
    expect(savedClosed.nodes[0]).toMatchObject({ allowTransfer: false, allowAddSign: false, allowRollback: false, requireComment: true });
    const implied = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "缺省开关",
        nodes: [{ id: randomUUID(), name: "缺省", mode: "any", approverUserIds: [approver.userId], approverRoleId: null, allowSelf: false, requireComment: false }],
        targets: [{ type: "ssh_connection", id: f.sshB }],
      },
    });
    expect(implied.statusCode, implied.body).toBe(201);
    const impliedFlows = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    expect(impliedFlows.json().items.find((item: { id: string }) => item.id === implied.json().id).nodes[0]).toMatchObject({
      allowTransfer: true,
      allowAddSign: true,
      allowRollback: true,
    });
    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/approval-flows/${implied.json().id}`, cookies: f.cookies })).statusCode).toBe(204);
    const submit = (reason: string) => f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: applicant.cookies,
      payload: { kind: "data", roleId: held.roleId, targets: [target], durationMs: 3_600_000, reason },
    });
    const first = await submit("关闭开关");
    expect(first.statusCode, first.body).toBe(201);
    const firstId = first.json().id as string;
    const storedBefore = await f.db.prepare("SELECT workflow_snapshot_json FROM organization_grant_requests WHERE id = ?").get<{ workflow_snapshot_json: string }>(firstId);
    for (const type of ["transfer", "add_sign", "rollback"] as const) {
      const result = await f.app.inject({
        method: "POST",
        url: `${f.base}/grant-requests/${firstId}/revise`,
        cookies: approver.cookies,
        payload: { type, userId: type === "rollback" ? undefined : second.userId, stageIndex: type === "rollback" ? 0 : undefined, comment: "关闭的操作" },
      });
      expect(result.statusCode, result.body).toBe(400);
      expect(result.json().error).toBe("NODE_OPERATION_DISABLED");
    }
    const opened = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { id: closed.json().id, name: "关闭节点操作", nodes: [{ ...closedNode, allowTransfer: true, allowAddSign: true, allowRollback: true }], targets: [target] },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const storedAfter = await f.db.prepare("SELECT workflow_snapshot_json FROM organization_grant_requests WHERE id = ?").get<{ workflow_snapshot_json: string }>(firstId);
    expect(storedAfter?.workflow_snapshot_json).toBe(storedBefore?.workflow_snapshot_json);
    expect(JSON.parse(storedAfter!.workflow_snapshot_json).nodes[0]).toMatchObject({ allowTransfer: false, allowAddSign: false, allowRollback: false });
    const stillClosed = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${firstId}/revise`,
      cookies: approver.cookies,
      payload: { type: "add_sign", userId: second.userId, comment: "旧快照仍关闭" },
    });
    expect(stillClosed.statusCode, stillClosed.body).toBe(400);
    const hidden = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${firstId}`, cookies: outsider.cookies });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain("关闭开关");
    const outsiderMine = await f.app.inject({ method: "GET", url: f.base + "/grant-requests?view=mine", cookies: outsider.cookies });
    expect(outsiderMine.json().items.map((item: { id: string }) => item.id)).not.toContain(firstId);
    const applicantView = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${firstId}`, cookies: applicant.cookies });
    expect(applicantView.json()).toMatchObject({ canTransfer: false, canAddSign: false, canRollback: false, revisionCandidates: [] });
    const readerView = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${firstId}`, cookies: reader.cookies });
    expect(readerView.statusCode, readerView.body).toBe(200);
    expect(readerView.json()).toMatchObject({ canTransfer: false, canAddSign: false, revisionCandidates: [], rollbackTargets: [] });
    expect(readerView.json().nodes[0]).toMatchObject({
      id: closedNode.id,
      name: "可配置节点",
      mode: "all",
      resolution: "指定成员",
      allowSelf: false,
      requireComment: true,
      allowTransfer: false,
      allowAddSign: false,
      allowRollback: false,
    });
    expect(readerView.json().nodes[0].approvers).toEqual([
      expect.objectContaining({ id: approver.userId, name: "switch-approver", canApprove: true, canReject: false }),
    ]);
    expect(readerView.body).not.toContain("fake-password");
    expect(readerView.body).not.toContain(".invalid");

    const renewed = await submit("打开加签");
    expect(renewed.statusCode, renewed.body).toBe(201);
    const renewedId = renewed.json().id as string;
    await f.db.prepare("UPDATE admin_users SET username = ? WHERE id = ?").run("switch-approver-renamed", approver.userId);
    const detail = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${renewedId}`, cookies: approver.cookies });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      requireComment: true,
      canTransfer: true,
      canAddSign: true,
      canRollback: false,
      rollbackTargets: [],
    });
    expect(detail.json().nodes[0].approvers[0]).toMatchObject({ id: approver.userId, name: "switch-approver", canApprove: true, canReject: false });
    const candidate = detail.json().revisionCandidates.find((item: { userId: string }) => item.userId === second.userId);
    expect(candidate).toEqual({ userId: second.userId, name: "switch-second", canApprove: true, canReject: false });
    expect(detail.json().revisionCandidates.some((item: { userId: string }) => item.userId === stranger.userId || item.userId === applicant.userId)).toBe(false);
    await f.assign(applicant.userId, ["approval.approve"], "resources", [{ type: "ssh_connection", id: f.sshA }]);
    const excluded = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${renewedId}`, cookies: approver.cookies });
    expect(excluded.json().revisionCandidates.some((item: { userId: string }) => item.userId === applicant.userId)).toBe(false);
    for (const type of ["transfer", "add_sign"] as const) {
      const denied = await f.app.inject({
        method: "POST",
        url: `${f.base}/grant-requests/${renewedId}/revise`,
        cookies: approver.cookies,
        payload: { type, userId: applicant.userId, comment: "申请人默认排除" },
      });
      expect(denied.statusCode, denied.body).toBe(409);
      expect(denied.json().error).toBe("SELF_APPROVAL_FORBIDDEN");
    }
    const todos = await f.app.inject({ method: "GET", url: f.base + "/grant-requests?view=todo", cookies: approver.cookies });
    expect(todos.json().items.find((item: { id: string }) => item.id === renewedId).revisionCandidates).toEqual(expect.arrayContaining([candidate]));
    const premature = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${renewedId}/decision`,
      cookies: second.cookies,
      payload: { decision: "approve", comment: "尚未加签" },
    });
    expect(premature.statusCode, premature.body).toBe(403);
    const typed = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${renewedId}/revise`,
      cookies: approver.cookies,
      payload: { type: "transfer", userId: stranger.userId, comment: "不在可选名单" },
    });
    expect(typed.statusCode, typed.body).toBe(409);
    expect(typed.json().error).toBe("APPROVER_REQUIRED");
    const added = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${renewedId}/revise`,
      cookies: approver.cookies,
      payload: { type: "add_sign", userId: second.userId, comment: "会签加签" },
    });
    expect(added.statusCode, added.body).toBe(200);
    const blank = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${renewedId}/decision`,
      cookies: approver.cookies,
      payload: { decision: "approve", comment: "" },
    });
    expect(blank.statusCode, blank.body).toBe(400);
    expect(blank.json().error).toBe("COMMENT_REQUIRED");
    const approved = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${renewedId}/decision`,
      cookies: approver.cookies,
      payload: { decision: "approve", comment: "首位同意" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const midway = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${renewedId}`, cookies: f.cookies });
    expect(midway.json().status).toBe("pending");
    const completed = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${renewedId}/decision`,
      cookies: second.cookies,
      payload: { decision: "approve", comment: "新增会签人同意" },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const repeated = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${renewedId}/decision`,
      cookies: second.cookies,
      payload: { decision: "approve", comment: "再次同意" },
    });
    expect(repeated.json()).toMatchObject({ already: true, status: "approved" });
    expect(await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE request_id = ?").all(renewedId)).toHaveLength(1);
    const allowSelf = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: { id: closed.json().id, name: "关闭节点操作", nodes: [{ ...closedNode, allowSelf: true, allowTransfer: true, allowAddSign: true, allowRollback: true }], targets: [target] },
    });
    expect(allowSelf.statusCode, allowSelf.body).toBe(200);
    expect(JSON.parse((await f.db.prepare("SELECT workflow_snapshot_json FROM organization_grant_requests WHERE id = ?").get<{ workflow_snapshot_json: string }>(firstId))!.workflow_snapshot_json).nodes[0].allowSelf).toBe(false);
    const selfRequest = await submit("允许本人");
    expect(selfRequest.statusCode, selfRequest.body).toBe(201);
    const selfDetail = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${selfRequest.json().id}`, cookies: approver.cookies });
    expect(selfDetail.json().revisionCandidates.some((item: { userId: string }) => item.userId === applicant.userId)).toBe(true);
    const selfAdded = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${selfRequest.json().id}/revise`,
      cookies: approver.cookies,
      payload: { type: "add_sign", userId: applicant.userId, comment: "显式允许本人" },
    });
    expect(selfAdded.statusCode, selfAdded.body).toBe(200);

    await f.assign(approver.userId, ["approval.approve"], "resources", [{ type: "ssh_connection", id: f.sshB }]);
    await f.assign(second.userId, ["approval.approve"], "resources", [{ type: "ssh_connection", id: f.sshB }]);
    const legacyId = randomUUID();
    const laterId = randomUUID();
    const legacyFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "旧字段流程",
        nodes: [
          { id: legacyId, name: "第一", mode: "any", approverUserIds: [approver.userId], approverRoleId: null, allowSelf: false, requireComment: false },
          { id: laterId, name: "第二", mode: "any", approverUserIds: [approver.userId], approverRoleId: null, allowSelf: false, requireComment: false },
        ],
        targets: [{ type: "ssh_connection", id: f.sshB }],
      },
    });
    expect(legacyFlow.statusCode, legacyFlow.body).toBe(201);
    const legacyNodes = [
      { id: legacyId, name: "第一", mode: "any", approverUserIds: [approver.userId], approverRoleId: null, allowSelf: false, requireComment: false, allowTransfer: false },
      { id: laterId, name: "第二", mode: "any", approverUserIds: [approver.userId], approverRoleId: null, allowSelf: false, requireComment: false },
    ];
    await f.db.prepare("UPDATE organization_approval_flows SET nodes_json = ? WHERE id = ?").run(JSON.stringify(legacyNodes), legacyFlow.json().id);
    const beforeRead = await f.db.prepare("SELECT nodes_json FROM organization_approval_flows WHERE id = ?").get<{ nodes_json: string }>(legacyFlow.json().id);
    const legacyRead = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    const legacyItem = legacyRead.json().items.find((item: { id: string }) => item.id === legacyFlow.json().id);
    expect(legacyItem.nodes[0].allowTransfer).toBe(false);
    expect(legacyItem.nodes[0]).not.toHaveProperty("allowAddSign");
    expect(legacyItem.nodes[1]).not.toHaveProperty("allowRollback");
    const afterRead = await f.db.prepare("SELECT nodes_json FROM organization_approval_flows WHERE id = ?").get<{ nodes_json: string }>(legacyFlow.json().id);
    expect(afterRead?.nodes_json).toBe(beforeRead?.nodes_json);
    const legacyRequest = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: applicant.cookies,
      payload: { kind: "data", roleId: held.roleId, targets: [{ type: "ssh_connection", id: f.sshB }], durationMs: 3_600_000, reason: "旧字段快照" },
    });
    expect(legacyRequest.statusCode, legacyRequest.body).toBe(201);
    const legacyRequestId = legacyRequest.json().id as string;
    const legacySnapshot = JSON.parse((await f.db.prepare("SELECT workflow_snapshot_json FROM organization_grant_requests WHERE id = ?").get<{ workflow_snapshot_json: string }>(legacyRequestId))!.workflow_snapshot_json);
    expect(legacySnapshot.nodes[0].allowTransfer).toBe(false);
    expect(legacySnapshot.nodes[0]).not.toHaveProperty("allowAddSign");
    expect(legacySnapshot.nodes[1]).not.toHaveProperty("allowRollback");
    const legacyTransfer = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${legacyRequestId}/revise`,
      cookies: approver.cookies,
      payload: { type: "transfer", userId: second.userId, comment: "明确关闭" },
    });
    expect(legacyTransfer.json().error).toBe("NODE_OPERATION_DISABLED");
    const legacyAdd = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${legacyRequestId}/revise`,
      cookies: approver.cookies,
      payload: { type: "add_sign", userId: second.userId, comment: "缺省仍可加签" },
    });
    expect(legacyAdd.statusCode, legacyAdd.body).toBe(200);
    expect((await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${legacyRequestId}/decision`,
      cookies: approver.cookies,
      payload: { decision: "approve", comment: "进入下一节点" },
    })).statusCode).toBe(200);
    const atSecond = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${legacyRequestId}`, cookies: approver.cookies });
    expect(atSecond.json()).toMatchObject({ status: "pending", stageIndex: 1, canRollback: true });
    expect(atSecond.json().rollbackTargets).toEqual([{ stageIndex: 0, id: legacyId, name: "第一", mode: "any" }]);
    expect(atSecond.json().nodes[1].allowRollback).toBe(true);
    const currentIndex = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${legacyRequestId}/revise`,
      cookies: approver.cookies,
      payload: { type: "rollback", stageIndex: 1, comment: "不能停在当前节点" },
    });
    expect(currentIndex.statusCode, currentIndex.body).toBe(400);
    expect(currentIndex.json().error).toBe("INVALID_ROLLBACK");
    const rolled = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${legacyRequestId}/revise`,
      cookies: approver.cookies,
      payload: { type: "rollback", stageIndex: 0, comment: "退回真实前序节点" },
    });
    expect(rolled.statusCode, rolled.body).toBe(200);
    const restored = await f.app.inject({ method: "GET", url: `${f.base}/grant-requests/${legacyRequestId}`, cookies: approver.cookies });
    expect(restored.json()).toMatchObject({ status: "pending", stageIndex: 0 });
    expect(restored.json().decisions.some((item: { decision: string; superseded?: boolean }) => item.decision === "approve" && item.superseded)).toBe(true);
  });
});
