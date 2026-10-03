import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AccessRequest, ApprovalWorkflow } from "../../shared/access-governance.js";
import { AccessAuthorizationError, createAccessAuthorization, grantCatalog, normalizeAuthorization, type AuthorizationInput } from "../access-authorizations.js";
import { accessEvent, authorizationSnapshot, recordAccessEvent } from "../access-governance-events.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

export const authorizationBodySchema = z.object({
  granteeType: z.enum(["user", "project"]), granteeId: z.string().uuid(),
  scopeKind: z.enum(["environment_group", "environment", "ssh_connection", "database_connection", "redis_connection"]),
  wholeGroup: z.boolean().default(false), groupId: z.string().uuid().nullable().default(null),
  targetIds: z.array(z.string().uuid()).max(500).default([]),
  permissions: z.record(z.string(), z.array(z.string())).default({}), items: z.record(z.string(), z.array(z.string())).default({}),
  startsAt: z.string().nullable().default(null), expiresAt: z.string().nullable().default(null), reason: z.string().trim().min(1).max(2000).optional(),
});
const workflowSchema = z.object({ name: z.string().trim().min(1).max(120), stages: z.array(z.object({
  name: z.string().trim().min(1).max(120), mode: z.enum(["any", "all"]).default("any"),
  approverIds: z.array(z.string().uuid()).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "审批人不能重复"),
})).min(1).max(10) });
const requestSchema = authorizationBodySchema.extend({ reason: z.string().trim().min(1).max(2000) });
const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().min(1).max(2000) });
const paginationSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) });
const requestQuerySchema = paginationSchema.extend({ view: z.enum(["mine", "todo", "reviewed", "all"]).default("mine"), status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional() });
const historyQuerySchema = paginationSchema.extend({ grantId: z.string().uuid().optional(), requestId: z.string().uuid().optional(),
  action: z.enum(["requested", "approved", "rejected", "withdrawn", "granted", "updated", "revoked", "expired", "imported", "workflow_updated"]).optional() });

type RequestRow = Record<string, unknown> & { id: string; requester_id: string; status: string; stage_index: number; version: number };

async function organizationRole(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, organizationId: string): Promise<"admin" | "member" | null> {
  if (request.admin!.workspace.type !== "organization" || request.admin!.workspace.id !== organizationId) {
    void reply.code(403).send({ error: "ORGANIZATION_WORKSPACE_REQUIRED", message: "请先切换到目标组织工作空间" });
    return null;
  }
  const member = await app.db.prepare("SELECT m.role FROM organization_members m JOIN admin_users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.user_id = ? AND u.status = 'active'")
    .get<{ role: "admin" | "member" }>(organizationId, request.admin!.id);
  if (!member) { void reply.code(403).send({ error: "NOT_ORGANIZATION_MEMBER", message: "你已不是组织的有效成员" }); return null; }
  return member.role;
}

function requestItem(row: RequestRow, userId: string): AccessRequest {
  const workflow: ApprovalWorkflow = JSON.parse(String(row.workflow_json));
  const stageIndex = Number(row.stage_index);
  const stageApprovals: string[] = JSON.parse(String(row.stage_approvals_json));
  return { id: row.id, requesterId: row.requester_id, requesterName: String(row.requester_name), reason: String(row.reason), status: row.status as AccessRequest["status"],
    snapshot: JSON.parse(String(row.snapshot_json)), workflow, approverNames: JSON.parse(String(row.approver_names_json)), stageIndex, stageApprovals,
    grantId: row.grant_id ? String(row.grant_id) : null,
    canApprove: row.status === "pending" && Boolean(workflow.stages[stageIndex]?.approverIds.includes(userId)) && !stageApprovals.includes(userId),
    canWithdraw: row.status === "pending" && row.requester_id === userId, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function canReadRequest(row: RequestRow, userId: string, role: string): boolean {
  return role === "admin" || row.requester_id === userId || (JSON.parse(String(row.workflow_json)) as ApprovalWorkflow).stages.some((stage) => stage.approverIds.includes(userId));
}

async function namesForWorkflow(app: FastifyInstance, organizationId: string, workflow: ApprovalWorkflow): Promise<Record<string, string>> {
  const ids = [...new Set(workflow.stages.flatMap((stage) => stage.approverIds))];
  const members = await app.db.prepare(`SELECT u.id, u.username FROM organization_members m JOIN admin_users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.status = 'active' AND u.id IN (${ids.map(() => "?").join(",")})`).all<{ id: string; username: string }>(organizationId, ...ids);
  if (members.length !== ids.length) throw new AccessAuthorizationError("INVALID_APPROVERS", 400, "审批人必须是当前组织的有效成员，请管理员更新审批流程");
  return Object.fromEntries(members.map((row) => [row.id, row.username]));
}

async function workflowFor(app: FastifyInstance, organizationId: string): Promise<ApprovalWorkflow | null> {
  const row = await app.db.prepare("SELECT workflow_json FROM organization_approval_workflows WHERE organization_id = ?").get<{ workflow_json: string }>(organizationId);
  return row ? JSON.parse(row.workflow_json) : null;
}

function failure(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof AccessAuthorizationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  throw error;
}

export async function registerAccessGovernanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id/approval-workflow", async (request, reply) => {
    if (!await organizationRole(app, request, reply, request.params.id)) return;
    return { workflow: await workflowFor(app, request.params.id) };
  });
  app.put<{ Params: { id: string } }>("/api/v1/organizations/:id/approval-workflow", async (request, reply) => {
    if (await organizationRole(app, request, reply, request.params.id) !== "admin") {
      if (!reply.sent) return reply.code(403).send({ error: "ORGANIZATION_ADMIN_REQUIRED", message: "只有组织管理员可以配置审批流程" });
      return;
    }
    const workflow = parseBody(workflowSchema, request.body, reply);
    if (!workflow) return;
    try {
      await app.db.transaction(async () => {
        const approverNames = await namesForWorkflow(app, request.params.id, workflow);
        const before = await workflowFor(app, request.params.id);
        await app.db.prepare(`INSERT INTO organization_approval_workflows (organization_id, workflow_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(organization_id) DO UPDATE SET workflow_json = excluded.workflow_json, updated_at = excluded.updated_at`)
          .run(request.params.id, JSON.stringify(workflow), new Date().toISOString());
        await recordAccessEvent(app.db, request.params.id, { action: "workflow_updated", reason: "配置组织授权审批流程", details: { before, after: workflow, approverNames }, request });
        await writeAudit(app.db, { action: "access.workflow_updated", resourceType: "organization", resourceId: request.params.id, summary: "配置组织授权审批流程", details: { before, after: workflow, approverNames }, request });
      })();
      return { ok: true };
    } catch (error) { return failure(error, reply); }
  });

  // This discovery endpoint exposes labels only. It does not expose connection addresses, accounts or secrets.
  app.get<{ Params: { id: string }; Querystring: { environmentIds?: string } }>("/api/v1/organizations/:id/access-request-catalog", async (request, reply) => {
    if (!await organizationRole(app, request, reply, request.params.id)) return;
    const ids = (request.query.environmentIds ?? "").split(",").filter(Boolean);
    if (ids.length > 500 || ids.some((id) => !z.string().uuid().safeParse(id).success)) return reply.code(400).send({ error: "INVALID_RESOURCE", message: "环境无效" });
    try {
      if (ids.length) return await grantCatalog(app.db, request.params.id, ids);
      const [groups, environments, ssh, database, redis] = await Promise.all([
        app.db.prepare("SELECT id, name FROM environment_groups WHERE workspace_type = 'organization' AND workspace_id = ? ORDER BY name").all(request.params.id),
        app.db.prepare("SELECT id, name, group_id AS groupId FROM environments WHERE workspace_type = 'organization' AND workspace_id = ? ORDER BY name").all(request.params.id),
        ...["ssh_connections", "database_connections", "redis_connections"].map((table) => app.db.prepare(`SELECT id, name FROM ${table} WHERE workspace_type = 'organization' AND workspace_id = ?${table === "database_connections" ? " AND profile_parent_id IS NULL" : ""} ORDER BY name`).all(request.params.id)),
      ]);
      return { groups, environments, connections: [
        ...ssh.map((row) => ({ ...row, type: "ssh" })), ...database.map((row) => ({ ...row, type: "database" })), ...redis.map((row) => ({ ...row, type: "redis" })),
      ] };
    } catch (error) { return failure(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/v1/organizations/:id/access-requests", async (request, reply) => {
    const role = await organizationRole(app, request, reply, request.params.id);
    if (!role) return;
    const body = parseBody(requestSchema, request.body, reply);
    if (!body) return;
    if (body.granteeType !== "user" || body.granteeId !== request.admin!.id) {
      return reply.code(403).send({ error: "SELF_REQUEST_REQUIRED", message: "授权申请只能为当前账号申请权限" });
    }
    try {
      const id = randomUUID();
      await app.db.transaction(async () => {
        const workflow = await workflowFor(app, request.params.id);
        if (!workflow) throw new AccessAuthorizationError("WORKFLOW_REQUIRED", 409, "请组织管理员先配置授权审批流程");
        const approverNames = await namesForWorkflow(app, request.params.id, workflow);
        const normalized = await normalizeAuthorization(app.db, request.params.id, body);
        const snapshot = await authorizationSnapshot(app.db, normalized);
        const pendingKey = createHash("sha256").update(JSON.stringify([request.params.id, request.admin!.id, normalized])).digest("hex");
        const now = new Date().toISOString();
        await app.db.prepare(`INSERT INTO access_requests (id, organization_id, requester_id, requester_name, reason, status,
          authorization_json, snapshot_json, workflow_json, approver_names_json, stage_index, stage_approvals_json, version, pending_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, '[]', 0, ?, ?, ?)`)
          .run(id, request.params.id, request.admin!.id, request.admin!.username, body.reason,
            JSON.stringify(normalized), JSON.stringify(snapshot), JSON.stringify(workflow), JSON.stringify(approverNames), pendingKey, now, now);
        for (const [index, stage] of workflow.stages.entries()) {
          for (const approverId of stage.approverIds) await app.db.prepare("INSERT INTO access_request_approvers (request_id, stage_index, approver_id) VALUES (?, ?, ?)").run(id, index, approverId);
        }
        await recordAccessEvent(app.db, request.params.id, { action: "requested", requestId: id, source: "request", reason: body.reason, after: snapshot,
          details: { workflow, approverNames }, request });
        await writeAudit(app.db, { action: "access.requested", resourceType: "access_request", resourceId: id, summary: "提交组织资源授权申请", details: { ...snapshot, reason: body.reason }, request });
      })();
      return reply.code(201).send({ id });
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "REQUEST_EXISTS", message: "相同权限已有待审批申请" });
      return failure(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id/access-requests", async (request, reply) => {
    const role = await organizationRole(app, request, reply, request.params.id);
    if (!role) return;
    const query = parseBody(requestQuerySchema, request.query, reply);
    if (!query) return;
    if (query.view === "all" && role !== "admin") return reply.code(403).send({ error: "ORGANIZATION_ADMIN_REQUIRED", message: "只有组织管理员可以查看全部申请" });
    const filters = ["r.organization_id = ?"];
    const params: unknown[] = [request.params.id];
    if (query.status) { filters.push("r.status = ?"); params.push(query.status); }
    if (query.view === "mine") { filters.push("r.requester_id = ?"); params.push(request.admin!.id); }
    if (query.view === "todo" || query.view === "reviewed") {
      filters.push(query.view === "todo"
        ? "r.status = 'pending' AND EXISTS (SELECT 1 FROM access_request_approvers a WHERE a.request_id = r.id AND a.stage_index = r.stage_index AND a.approver_id = ? AND a.decided_at IS NULL)"
        : "EXISTS (SELECT 1 FROM access_request_approvers a WHERE a.request_id = r.id AND a.approver_id = ? AND a.decided_at IS NOT NULL)");
      params.push(request.admin!.id);
    }
    const rows = await app.db.prepare(`SELECT r.* FROM access_requests r WHERE ${filters.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all<RequestRow>(...params, query.pageSize + 1, (query.page - 1) * query.pageSize);
    return { items: rows.slice(0, query.pageSize).map((row) => requestItem(row, request.admin!.id)), page: query.page, hasMore: rows.length > query.pageSize };
  });

  app.get<{ Params: { id: string; requestId: string } }>("/api/v1/organizations/:id/access-requests/:requestId", async (request, reply) => {
    const role = await organizationRole(app, request, reply, request.params.id);
    if (!role) return;
    const row = await app.db.prepare("SELECT * FROM access_requests WHERE organization_id = ? AND id = ?").get<RequestRow>(request.params.id, request.params.requestId);
    if (!row || !canReadRequest(row, request.admin!.id, role)) return reply.code(404).send({ error: "NOT_FOUND", message: "申请不存在或无权查看" });
    const events = await app.db.prepare("SELECT * FROM access_governance_events WHERE organization_id = ? AND request_id = ? ORDER BY created_at, event_order").all<Record<string, unknown>>(request.params.id, row.id);
    return { item: requestItem(row, request.admin!.id), events: events.map(accessEvent) };
  });

  app.post<{ Params: { id: string; requestId: string } }>("/api/v1/organizations/:id/access-requests/:requestId/decisions", async (request, reply) => {
    if (!await organizationRole(app, request, reply, request.params.id)) return;
    const body = parseBody(decisionSchema, request.body, reply);
    if (!body) return;
    try {
      await app.db.transaction(async () => {
        const row = await app.db.prepare("SELECT * FROM access_requests WHERE organization_id = ? AND id = ?").get<RequestRow>(request.params.id, request.params.requestId);
        if (!row) throw new AccessAuthorizationError("NOT_FOUND", 404, "申请不存在");
        if (row.status !== "pending") throw new AccessAuthorizationError("REQUEST_CLOSED", 409, "申请已处理，请刷新后查看");
        const item = requestItem(row, request.admin!.id);
        if (!item.canApprove) throw new AccessAuthorizationError("APPROVER_REQUIRED", 403, "只有当前节点尚未处理的审批人可以审批");
        const stage = item.workflow.stages[item.stageIndex]!;
        const approvals = [...item.stageApprovals, request.admin!.id];
        const stageComplete = stage.mode === "any" || stage.approverIds.every((id) => approvals.includes(id));
        const complete = body.decision === "approve" && stageComplete && item.stageIndex === item.workflow.stages.length - 1;
        const status = body.decision === "reject" ? "rejected" : complete ? "approved" : "pending";
        const nextStage = body.decision === "approve" && stageComplete ? item.stageIndex + 1 : item.stageIndex;
        const changed = await app.db.prepare(`UPDATE access_requests SET status = ?, stage_index = ?, stage_approvals_json = ?,
          pending_key = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ? AND status = 'pending' AND version = ?`)
          .run(status, nextStage, JSON.stringify(stageComplete ? [] : approvals), status === "pending" ? row.pending_key : null,
            new Date().toISOString(), row.id, request.params.id, Number(row.version));
        if (!changed.changes) throw new AccessAuthorizationError("REQUEST_CHANGED", 409, "申请已被其他审批人处理，请刷新");
        await app.db.prepare("UPDATE access_request_approvers SET decided_at = ? WHERE request_id = ? AND stage_index = ? AND approver_id = ?")
          .run(new Date().toISOString(), row.id, item.stageIndex, request.admin!.id);
        await recordAccessEvent(app.db, request.params.id, { action: body.decision === "approve" ? "approved" : "rejected", requestId: row.id,
          source: "request", reason: body.reason, after: item.snapshot,
          details: { stageIndex: item.stageIndex, stageName: stage.name, stageComplete, selfApproved: row.requester_id === request.admin!.id }, request });
        if (complete) {
          // Revalidate membership, resources, selected objects and expiry at the final decision.
          const grantId = await createAccessAuthorization(app.db, request.params.id, request.admin!, JSON.parse(String(row.authorization_json)) as AuthorizationInput,
            request, { reason: String(row.reason), requestId: row.id, withinTransaction: true });
          await app.db.prepare("UPDATE access_requests SET grant_id = ? WHERE id = ?").run(grantId, row.id);
        }
        await writeAudit(app.db, { action: `access.${body.decision === "approve" ? "approved" : "rejected"}`, resourceType: "access_request", resourceId: row.id,
          summary: body.decision === "approve" ? "通过授权审批节点" : "拒绝授权申请", details: { stageIndex: item.stageIndex, reason: body.reason, selfApproved: row.requester_id === request.admin!.id }, request });
      })();
      return { ok: true };
    } catch (error) { return failure(error, reply); }
  });

  app.post<{ Params: { id: string; requestId: string } }>("/api/v1/organizations/:id/access-requests/:requestId/withdraw", async (request, reply) => {
    if (!await organizationRole(app, request, reply, request.params.id)) return;
    const body = parseBody(z.object({ reason: z.string().trim().min(1).max(2000) }), request.body, reply);
    if (!body) return;
    try {
      await app.db.transaction(async () => {
        const changed = await app.db.prepare("UPDATE access_requests SET status = 'withdrawn', pending_key = NULL, version = version + 1, updated_at = ? WHERE organization_id = ? AND id = ? AND requester_id = ? AND status = 'pending'")
          .run(new Date().toISOString(), request.params.id, request.params.requestId, request.admin!.id);
        if (!changed.changes) throw new AccessAuthorizationError("REQUEST_NOT_WITHDRAWABLE", 409, "只能撤回自己的待审批申请");
        const row = await app.db.prepare("SELECT * FROM access_requests WHERE id = ?").get<RequestRow>(request.params.requestId);
        await recordAccessEvent(app.db, request.params.id, { action: "withdrawn", requestId: row!.id, source: "request", reason: body.reason, after: requestItem(row!, request.admin!.id).snapshot, request });
        await writeAudit(app.db, { action: "access.withdrawn", resourceType: "access_request", resourceId: request.params.requestId, summary: "撤回授权申请", details: body, request });
      })();
      return { ok: true };
    } catch (error) { return failure(error, reply); }
  });

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id/access-history", async (request, reply) => {
    const role = await organizationRole(app, request, reply, request.params.id);
    if (!role) return;
    const query = parseBody(historyQuerySchema, request.query, reply);
    if (!query) return;
    // Organization administrators manage the ledger; applicants use their own request detail.
    if (role !== "admin") return reply.code(403).send({ error: "ORGANIZATION_ADMIN_REQUIRED", message: "只有组织管理员可以查看授权台账" });
    const filters = ["organization_id = ?"];
    const params: unknown[] = [request.params.id];
    if (query.grantId) {
      filters.push("(grant_id = ? OR request_id IN (SELECT id FROM access_requests WHERE organization_id = ? AND grant_id = ?))");
      params.push(query.grantId, request.params.id, query.grantId);
    }
    for (const [key, column] of [["requestId", "request_id"], ["action", "action"]] as const) {
      if (query[key]) { filters.push(`${column} = ?`); params.push(query[key]); }
    }
    const rows = await app.db.prepare(`SELECT * FROM access_governance_events WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, event_order DESC LIMIT ? OFFSET ?`)
      .all<Record<string, unknown>>(...params, query.pageSize + 1, (query.page - 1) * query.pageSize);
    return { items: rows.slice(0, query.pageSize).map(accessEvent), page: query.page, hasMore: rows.length > query.pageSize };
  });
}
