import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { parseBody } from "../validation.js";
import { OrganizationPermissionError } from "../organization-rbac.js";
import { RESOURCE_TYPES, type ResourceRef } from "../../shared/organization-rbac.js";
import { webPluginInjection } from "../organization-boundary.js";
import { selectWebPluginEntry, type WebPluginEntryRecord } from "../../shared/web-plugin-target.js";
import { memberPermissions, personalAuthorization, resourceAuthorization, resourceOverview } from "../organization-overview.js";
import {
  decideGrantRequest,
  deleteApprovalFlow,
  listApprovalFlows,
  listGrantLedger,
  listGrantRequests,
  type GrantLedgerFilter,
  readGrantRequest,
  reviseGrantRequest,
  roleNamesByMember,
  saveApprovalFlow,
  submitGrantRequest,
  withdrawGrantRequest,
  type FlowMode,
} from "../organization-approval.js";

const targetSchema = z.object({ type: z.enum(RESOURCE_TYPES), id: z.string().uuid() }).strict();
const nodeSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(160),
    mode: z.enum(["any", "all", "sequence", "auto_approve", "auto_reject", "cc"]),
    approverUserIds: z.array(z.string().uuid()).max(100).default([]),
    approverRoleId: z.string().uuid().nullable().default(null),
    allowSelf: z.boolean().default(false),
    requireComment: z.boolean().default(false),
    // 缺省保持原先可操作；请求里的明确 true/false 会原样保存。
    allowTransfer: z.boolean().default(true),
    allowAddSign: z.boolean().default(true),
    allowRollback: z.boolean().default(true),
  })
  .strict();
const flowSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(160),
    nodes: z.array(nodeSchema).min(1).max(30),
    targets: z.array(targetSchema).max(1000).default([]),
  })
  .strict();
const requestSchema = z
  .object({
    kind: z.enum(["data", "feature"]),
    roleId: z.string().uuid().nullable().optional(),
    features: z.object({ mcp: z.boolean(), agent: z.boolean(), webPlugins: z.boolean() }).strict().nullable().optional(),
    targets: z.array(targetSchema).min(1).max(1000),
    durationMs: z.number().int().positive().nullable().default(null),
    reason: z.string().trim().min(1).max(2000),
    // 分组提交：取 MULTIPLE_APPROVAL_FLOWS.groups[].flowId。缺省表示初次选择，环境目标会冻结当时关联资源。
    flowId: z.string().uuid().optional(),
  })
  .strict();
const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    comment: z.string().trim().max(2000).default(""),
  })
  .strict();
const withdrawSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const reviseSchema = z
  .object({
    type: z.enum(["transfer", "add_sign", "rollback"]),
    userId: z.string().uuid().optional(),
    stageIndex: z.number().int().nonnegative().optional(),
    comment: z.string().trim().min(1).max(2000),
  })
  .strict();

function workspaceReady(request: FastifyRequest, reply: FastifyReply, organizationId: string) {
  if (request.admin?.workspace.type !== "organization" || request.admin.workspace.id !== organizationId) {
    void reply.code(403).send({ error: "ORGANIZATION_WORKSPACE_REQUIRED", message: "请先切换到目标组织工作空间" });
    return false;
  }
  return true;
}

export async function registerOrganizationPhaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OrganizationPermissionError)
      return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
    return reply.code(500).send({ error: "REQUEST_FAILED", message: "操作没有完成" });
  });

  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>(
    "/api/v1/organizations/:id/resource-overview",
    async (request, reply) => {
      if (!workspaceReady(request, reply, request.params.id)) return;
      const access = request.admin!.organizationAccess;
      if (!access?.allows("environment.catalog") && !access?.allows("organization.view"))
        return reply.code(403).send({ error: "ACTION_FORBIDDEN", message: "没有资源目录权限" });
      if (request.query.projectId) {
        const project = await app.db
          .prepare("SELECT 1 FROM projects WHERE id = ? AND organization_id = ?")
          .get(request.query.projectId, request.params.id);
        if (!project) return reply.code(404).send({ error: "NOT_FOUND", message: "子组织不存在" });
      }
      return resourceOverview(app.db, request.params.id, request.admin!.id, request.query.projectId, request.admin!.organizationAccess);
    },
  );

  app.get<{ Params: { id: string; type: string; resourceId: string } }>(
    "/api/v1/organizations/:id/resource-authorizations/:type/:resourceId",
    async (request, reply) => {
      if (!workspaceReady(request, reply, request.params.id)) return;
      const parsed = z.object({ type: z.enum(RESOURCE_TYPES), resourceId: z.string().uuid() }).safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_RESOURCE", message: "资源不存在" });
      return resourceAuthorization(app.db, request.params.id, request.admin!.id, {
        type: parsed.data.type,
        id: parsed.data.resourceId,
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id/my-access", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    return personalAuthorization(app.db, request.params.id, request.admin!.id, request.admin!.organizationAccess);
  });

  app.get<{ Params: { id: string; memberId: string } }>("/api/v1/organizations/:id/members/:memberId/permissions", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const memberId = z.string().uuid().safeParse(request.params.memberId);
    if (!memberId.success) return reply.code(400).send({ error: "INVALID_MEMBER", message: "成员不存在" });
    return memberPermissions(app.db, request.params.id, request.admin!.id, memberId.data);
  });

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id/member-roles", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const names = await roleNamesByMember(app.db, request.params.id);
    return { items: [...names.entries()].map(([userId, roleNames]) => ({ userId, roleNames })) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id/approval-flows", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const access = request.admin!.organizationAccess;
    if (!access?.allows("approval.view") && !access?.allows("authorization.request") && !access?.allows("approval.approve") && !access?.allows("approval.reject") && !access?.allows("approval.workflow"))
      return reply.code(403).send({ error: "ACTION_FORBIDDEN", message: "没有查看审批流程的权限" });
    return listApprovalFlows(app.db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/organizations/:id/approval-flows", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    if (!request.admin!.organizationAccess?.allows("approval.workflow"))
      return reply.code(403).send({ error: "ACTION_FORBIDDEN", message: "没有维护审批流程的权限" });
    const body = parseBody(flowSchema, request.body, reply);
    if (!body) return;
    const saved = await saveApprovalFlow(app.db, request.params.id, request.admin!, {
      ...body,
      nodes: body.nodes.map((node) => ({ ...node, mode: node.mode as FlowMode })),
      targets: body.targets as ResourceRef[],
    });
    return reply.code(body.id ? 200 : 201).send(saved);
  });

  app.delete<{ Params: { id: string; flowId: string } }>("/api/v1/organizations/:id/approval-flows/:flowId", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    if (!request.admin!.organizationAccess?.allows("approval.workflow"))
      return reply.code(403).send({ error: "ACTION_FORBIDDEN", message: "没有维护审批流程的权限" });
    await deleteApprovalFlow(app.db, request.params.id, request.admin!, request.params.flowId);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/organizations/:id/grant-requests", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const body = parseBody(requestSchema, request.body, reply);
    if (!body) return;
    const created = await submitGrantRequest(app.db, request.params.id, request.admin!.id, {
      kind: body.kind,
      roleId: body.roleId,
      features: body.features,
      targets: body.targets as ResourceRef[],
      durationMs: body.durationMs,
      reason: body.reason,
      flowId: body.flowId,
    });
    return reply.code(201).send(created);
  });

  app.get<{ Params: { id: string }; Querystring: { view?: "mine" | "todo" | "all" } }>(
    "/api/v1/organizations/:id/grant-requests",
    async (request, reply) => {
      if (!workspaceReady(request, reply, request.params.id)) return;
      const view = request.query.view ?? "mine";
      return listGrantRequests(app.db, request.params.id, request.admin!.id, view);
    },
  );

  app.get<{ Params: { id: string; requestId: string } }>("/api/v1/organizations/:id/grant-requests/:requestId", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    return readGrantRequest(app.db, request.params.id, request.params.requestId, request.admin!.id);
  });

  app.post<{ Params: { id: string; requestId: string } }>("/api/v1/organizations/:id/grant-requests/:requestId/decision", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const body = parseBody(decisionSchema, request.body, reply);
    if (!body) return;
    return decideGrantRequest(app.db, request.params.id, request.params.requestId, request.admin!, body.decision, body.comment);
  });

  app.post<{ Params: { id: string; requestId: string } }>("/api/v1/organizations/:id/grant-requests/:requestId/withdraw", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const body = parseBody(withdrawSchema, request.body, reply);
    if (!body) return;
    return withdrawGrantRequest(app.db, request.params.id, request.params.requestId, request.admin!, body.reason);
  });

  app.post<{ Params: { id: string; requestId: string } }>("/api/v1/organizations/:id/grant-requests/:requestId/revise", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const body = parseBody(reviseSchema, request.body, reply);
    if (!body) return;
    return reviseGrantRequest(app.db, request.params.id, request.params.requestId, request.admin!, body);
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>("/api/v1/organizations/:id/grant-ledger", async (request, reply) => {
    if (!workspaceReady(request, reply, request.params.id)) return;
    const query = request.query ?? {};
    const bounded = (value: string | undefined) => {
      const text = value?.trim() ?? "";
      return text.length > 200 ? null : text;
    };
    const action = bounded(query.action);
    const actor = bounded(query.actor);
    const target = bounded(query.target);
    if (action === null || actor === null || target === null)
      return reply.code(400).send({ error: "INVALID_LEDGER_QUERY", message: "台账筛选过长" });
    const parseTime = (value?: string) => {
      if (!value?.trim()) return undefined;
      const numeric = Number(value);
      const time = Number.isFinite(numeric) && Math.abs(numeric) > 10_000_000_000 ? numeric : Date.parse(value);
      return Number.isFinite(time) ? time : null;
    };
    const from = parseTime(query.from);
    const to = parseTime(query.to);
    if (from === null || to === null || (from !== undefined && to !== undefined && from > to))
      return reply.code(400).send({ error: "INVALID_LEDGER_QUERY", message: "台账时间范围无效" });
    const type = query.type?.trim() ?? "";
    if (type && !(RESOURCE_TYPES as readonly string[]).includes(type))
      return reply.code(400).send({ error: "INVALID_LEDGER_QUERY", message: "台账资源类型无效" });
    const exporting = query.export === "1" || query.export === "true";
    const filter: GrantLedgerFilter = {
      action: action || undefined,
      actor: actor || undefined,
      target: target || undefined,
      type: (type || undefined) as GrantLedgerFilter["type"],
      from,
      to,
    };
    if (exporting) reply.header("content-disposition", "attachment; filename=\"grant-ledger.json\"");
    return listGrantLedger(app.db, request.params.id, request.admin!.id, exporting, filter);
  });

  app.get<{ Querystring: { environmentId?: string; entryId?: string; url?: string } }>("/api/v1/web-plugin-policy", async (request) => {
    const user = request.admin!;
    const denied = (reason: string) => ({ inject: false, label: "环境未授权 · 已禁用", reason, entryId: "", environmentId: "", entryUrl: "" });
    if (user.workspace.type === "personal") return { inject: true, label: null, reason: "", entryId: "", environmentId: "", entryUrl: "" };
    const access = user.organizationAccess;
    if (!access) return denied("无法确定真实环境");
    const requestedEntry = request.query.entryId?.trim() ?? "";
    const requestedEnvironment = request.query.environmentId?.trim() ?? "";
    const currentUrl = request.query.url?.trim() ?? "";
    if (requestedEntry.length > 80 || requestedEnvironment.length > 80 || currentUrl.length > 2000)
      return denied("无法确定真实环境");
    const rows = await app.db.prepare(`
      SELECT w.id, w.environment_id, w.url
      FROM web_entries w
      JOIN environments e ON e.id = w.environment_id
      WHERE e.workspace_type = 'organization' AND e.workspace_id = ?
    `).all<{ id: string; environment_id: string; url: string }>(user.workspace.id);
    const entries: WebPluginEntryRecord[] = rows.map((row) => ({ id: row.id, environmentId: row.environment_id, url: row.url }));
    const selected = currentUrl
      ? selectWebPluginEntry(entries, currentUrl, requestedEntry)
      : entries.find((entry) => entry.id === requestedEntry) ?? null;
    if (!selected) return denied(currentUrl ? "未知目标" : "无法确定真实环境");
    if (!currentUrl && requestedEnvironment && requestedEnvironment !== selected.environmentId)
      return denied("入口不属于该环境");
    return {
      ...webPluginInjection(access, selected.environmentId, selected.id),
      entryId: selected.id,
      environmentId: selected.environmentId,
      entryUrl: selected.url,
    };
  });
}
