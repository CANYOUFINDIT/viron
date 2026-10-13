import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { databaseSqlPermissions, missingDatabaseSqlPermission } from "../shared/access-permissions.js";
import { databaseTaskAccessPlan, type DatabaseTaskAction, type DatabaseTaskKind } from "../shared/database-task-access.js";
import type { ResourceRef } from "../shared/organization-rbac.js";
import { redisCommandAccess } from "../shared/redis.js";
import { internalRequestAuditSource } from "./audit.js";
import { executionScope } from "./execution-scope.js";
import { executionDecision, trustedExecutionChannel, type ExecutionChannel } from "./organization-boundary.js";
import { recordGrantLedger } from "./organization-approval.js";

interface MappedOperation {
  codes: string[];
  /** Envelope transport accepts any one complete code. SQL and other routes still require every code. */
  match?: "any";
  sql?: string;
  type: ResourceRef["type"];
  id: string;
  also?: MappedOperation[];
}

function operation(code: string, type: ResourceRef["type"], id: string): MappedOperation {
  return { codes: [code], type, id };
}

function requestSql(body: { sql?: string; statements?: Array<string | { sql: string }>; queries?: Array<string | { sql?: string }> } | undefined): string {
  if (typeof body?.sql === "string") return body.sql;
  if (Array.isArray(body?.statements)) return body.statements.map((item) => (typeof item === "string" ? item : item.sql)).join(";\n");
  if (Array.isArray(body?.queries)) return body.queries.map((item) => (typeof item === "string" ? item : item.sql ?? "")).join(";\n");
  return "";
}

const METADATA_READ = [
  /^\/api\/v1\/mcp\/status$/i,
  /^\/api\/v1\/mcp\/business-operations$/i,
  /^\/api\/v1\/mcp\/operations\/[^/]+$/i,
  /^\/api\/v1\/capabilities$/i,
  /^\/api\/v1\/auth\/me$/i,
  /^\/api\/v1\/dashboard$/i,
  /^\/api\/v1\/environment-groups$/i,
  /^\/api\/v1\/environments$/i,
  /^\/api\/v1\/environments\/[^/]+$/i,
  /^\/api\/v1\/environments\/[^/]+\/logs$/i,
  /^\/api\/v1\/environments\/[^/]+\/web-entries$/i,
  /^\/api\/v1\/environments\/[^/]+\/knowledge$/i,
  /^\/api\/v1\/connection-groups$/i,
  /^\/api\/v1\/knowledge$/i,
  /^\/api\/v1\/active-connections$/i,
  /^\/api\/v1\/database-tasks$/i,
  /^\/api\/v1\/database-tasks\/[^/]+$/i,
  /^\/api\/v1\/database-query-history$/i,
  /^\/api\/v1\/sftp-transfers$/i,
  /^\/api\/v1\/web-credentials\/[^/]+\/entry-ref$/i,
  /^\/api\/v1\/ssh-command-favorites$/i,
  /^\/api\/v1\/database-saved-queries$/i,
];

function isMetadataRead(method: string, path: string): boolean {
  return (method === "GET" || method === "HEAD") && METADATA_READ.some((pattern) => pattern.test(path));
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function databaseCodes(actions: readonly DatabaseTaskAction[]): string[] {
  return actions.map((action) => `database.${action}`);
}

function planOperation(id: string, kind: DatabaseTaskKind, details: Record<string, unknown>): MappedOperation | null {
  const plan = databaseTaskAccessPlan(kind, details);
  if (!plan.operations.length) return null;
  const mapped = operation(databaseCodes(plan.operations)[0] ?? "", "database_connection", id);
  mapped.codes = databaseCodes(plan.operations);
  if (plan.targetConnectionId && plan.targetOperations.length) {
    mapped.also = [{ codes: databaseCodes(plan.targetOperations), type: "database_connection", id: plan.targetConnectionId }];
  }
  return mapped;
}

async function workspaceWebEntry(request: FastifyRequest, credentialId: string): Promise<string | null> {
  const admin = request.admin;
  if (!admin) return null;
  const row = await request.server.db.prepare(`
    SELECT w.id AS entry_id
    FROM web_credentials c
    JOIN web_entries w ON w.id = c.web_entry_id
    JOIN environments e ON e.id = w.environment_id
    WHERE c.id = ? AND e.workspace_type = ? AND e.workspace_id = ?
  `).get(credentialId, admin.workspace.type, admin.workspace.id) as { entry_id: string } | undefined;
  return row?.entry_id ?? null;
}

async function workspaceLog(request: FastifyRequest, logId: string): Promise<boolean> {
  const admin = request.admin;
  if (!admin) return false;
  const row = await request.server.db.prepare(`
    SELECT l.id
    FROM environment_logs l
    JOIN environments e ON e.id = l.environment_id
    WHERE l.id = ? AND e.workspace_type = ? AND e.workspace_id = ?
  `).get(logId, admin.workspace.type, admin.workspace.id) as { id: string } | undefined;
  return Boolean(row);
}

async function mappedOperation(request: FastifyRequest, channel: ExecutionChannel): Promise<MappedOperation | null> {
  const path = request.url.split("?", 1)[0] ?? "";
  const params = request.params as { id?: string; connectionId?: string };
  const id = params.id;
  const connectionId =
    (request.body as { connectionId?: string } | undefined)?.connectionId ??
    (request.query as { connectionId?: string } | undefined)?.connectionId;
  // These three desktop routes name the resource :connectionId. Body and query ids belong to other chains.
  const desktopConnectionId = params.connectionId || id;
  if (/\/ssh-connections\/[^/]+\/sftp/.test(path) && id) {
    const code = path.endsWith("/download")
      ? "ssh.download"
      : request.method === "DELETE" || /\/(rename|chmod)$/.test(path)
        ? "ssh.delete"
        : request.method === "POST"
          ? "ssh.upload"
          : "ssh.browse";
    return operation(code, "ssh_connection", id);
  }
  if (/\/mcp\/ssh-connections\/[^/]+/.test(path) && id) return operation("ssh.use", "ssh_connection", id);
  if (/\/desktop\/ssh-connections\/[^/]+\/envelope$/.test(path) && desktopConnectionId) {
    if (bodyRecord(request.body).auditSource === "mcp") return null;
    return operation("ssh.use", "ssh_connection", desktopConnectionId);
  }
  if (/\/desktop\/database-connections\/[^/]+\/envelope$/.test(path) && desktopConnectionId)
    return {
      codes: ["database.read", "database.write", "database.ddl"],
      match: "any",
      type: "database_connection",
      id: desktopConnectionId,
    };
  if (/\/desktop\/redis-connections\/[^/]+\/envelope$/.test(path) && desktopConnectionId)
    return operation("redis.view", "redis_connection", desktopConnectionId);
  if (/\/database-connections\//.test(path) && id) {
    if (/\/table-export$/.test(path)) return { codes: ["database.read", "database.export"], type: "database_connection", id };
    if (/\/backup$/.test(path) && request.method === "POST") return planOperation(id, "backup", bodyRecord(request.body));
    if (/\/restore$/.test(path) && request.method === "POST") {
      const details = bodyRecord(request.body);
      const planned = planOperation(id, "restore", details);
      if (planned) return planned;
      return { codes: ["database.write", "database.ddl"], type: "database_connection", id };
    }
    if (request.method === "GET" && /\/(schemas|objects|completion-metadata|ddl|table-design|table-data(?:\/suggestions)?)$/.test(path))
      return operation("database.read", "database_connection", id);
    if (request.method === "POST" && /\/table-data\/changes$/.test(path)) return operation("database.write", "database_connection", id);
    if (request.method === "POST" && /\/table-import$/.test(path)) return operation("database.write", "database_connection", id);
    if (request.method === "POST" && /\/(transfer|sync)$/.test(path)) {
      const body = bodyRecord(request.body);
      const target = typeof body.targetConnectionId === "string" ? body.targetConnectionId : "";
      if (!target) return null;
      return planOperation(id, "transfer", { ...body, syncMode: body.syncMode ?? body.mode, targetConnectionId: target });
    }
    if (request.method === "POST" && /\/sync-preview$/.test(path)) {
      const target = bodyRecord(request.body).targetConnectionId;
      if (typeof target !== "string" || !target) return null;
      return { codes: ["database.read"], type: "database_connection", id, also: [{ codes: ["database.read"], type: "database_connection", id: target }] };
    }
    if (/\/(database-create|database-drop|table-create|table-alter|table-drop|table-rename|table-copy|schema-changes)$/.test(path))
      return operation("database.ddl", "database_connection", id);
    if (path.includes("/queries") && request.method === "POST") {
      const sql = requestSql(request.body as { sql?: string; statements?: Array<string | { sql: string }>; queries?: Array<string | { sql?: string }> } | undefined);
      return { codes: databaseSqlPermissions(sql), sql, type: "database_connection", id };
    }
    return null;
  }
  const web = path.match(/^\/api\/v1\/(?:mcp\/)?web-credentials\/([^/]+)\/(?:snapshot|action|control|view\/upload)$/);
  if (web && request.method === "POST") {
    const entryId = await workspaceWebEntry(request, web[1]);
    return entryId ? operation("web.use", "web_entry", entryId) : null;
  }
  const log = path.match(/^\/api\/v1\/mcp\/environment-logs\/([^/]+)\/snapshot$/);
  if (log && request.method === "POST") return await workspaceLog(request, log[1]) ? operation("logs.view", "environment_log", log[1]) : null;
  if ((path === "/api/v1/sftp-transfers" || path === "/api/v1/sftp-transfers/preview") && request.method === "POST") {
    const body = bodyRecord(request.body);
    const source = typeof body.sourceConnectionId === "string" ? body.sourceConnectionId : "";
    const target = typeof body.targetConnectionId === "string" ? body.targetConnectionId : "";
    if (!source || !target) return null;
    return { codes: ["ssh.download"], type: "ssh_connection", id: source, also: [{ codes: ["ssh.upload"], type: "ssh_connection", id: target }] };
  }
  const sftpRetry = path.match(/^\/api\/v1\/sftp-transfers\/([^/]+)\/retry$/);
  if (sftpRetry && request.method === "POST" && request.admin) {
    const task = request.server.sftpTransfers.get(sftpRetry[1], request.admin, executionScope(request));
    if (!task) return null;
    return { codes: ["ssh.download"], type: "ssh_connection", id: task.sourceConnectionId, also: [{ codes: ["ssh.upload"], type: "ssh_connection", id: task.targetConnectionId }] };
  }
  const queryJob = path.match(/^\/api\/v1\/database-queries\/([^/]+)$/);
  if (queryJob && request.method === "GET" && request.admin) {
    const job = request.server.databaseQueries.get(queryJob[1], request.admin.id, executionScope(request));
    if (!job) return null;
    return { codes: databaseSqlPermissions(job.sql), sql: job.sql, type: "database_connection", id: job.connectionId };
  }
  const taskDownload = path.match(/^\/api\/v1\/database-tasks\/([^/]+)\/download$/);
  if (taskDownload && request.method === "GET" && request.admin) {
    const task = request.server.databaseTasks.getOwned(taskDownload[1], request.admin, executionScope(request));
    if (!task?.connectionId || (task.type !== "backup" && task.type !== "restore" && task.type !== "transfer" && task.type !== "import")) return null;
    return planOperation(task.connectionId, task.type, task.details);
  }
  if (path === "/api/v1/connections/inspect" && request.method === "POST") {
    const items = bodyRecord(request.body).items;
    if (!Array.isArray(items) || !items.length) return null;
    const nodes: MappedOperation[] = [];
    for (const item of items) {
      const value = item as { type?: string; id?: string } | null;
      const code = value?.type === "ssh" ? "ssh.use" : value?.type === "database" ? "database.read" : value?.type === "redis" ? "redis.view" : "";
      const type = value?.type === "ssh" ? "ssh_connection" : value?.type === "database" ? "database_connection" : value?.type === "redis" ? "redis_connection" : null;
      if (!type || !value?.id || !code) return null;
      nodes.push(operation(code, type, value.id));
    }
    const [first, ...rest] = nodes;
    return first ? { ...first, also: rest } : null;
  }
  if (/\/redis-connections\/[^/]+\/(?:info|scan|test)$/.test(path) && id)
    return operation("redis.view", "redis_connection", id);
  if (/\/redis-connections\/[^/]+\/commands?(?:\/batch)?$/.test(path) && id) {
    const command = String((request.body as { command?: string } | undefined)?.command ?? "");
    if (!command && channel === "manual") return null;
    const access = command ? redisCommandAccess(command.toUpperCase()) : "write";
    return operation(access === "read" ? "redis.view" : "redis.write", "redis_connection", id);
  }
  if (/\/knowledge-documents\/[^/]+/.test(path) && id)
    return operation(request.method === "GET" ? "knowledge.view" : "knowledge.edit", "knowledge_node", id);
  if (path.includes("/database-automations") && connectionId)
    return operation(request.method === "GET" ? "database.read" : "database.write", "database_connection", connectionId);
  return null;
}

async function deny(
  request: FastifyRequest,
  reply: FastifyReply,
  error: string,
  message: string,
  details?: { code?: string; target?: ResourceRef; channel?: ExecutionChannel },
) {
  const access = request.admin?.organizationAccess;
  const org = request.admin?.workspace.type === "organization" ? request.admin.workspace.id : "";
  if (access && org && details?.channel && details.channel !== "manual" && details.target)
    await recordGrantLedger(
      (request.server as FastifyInstance).db,
      org,
      { id: request.admin?.id, name: request.admin?.username ?? "" },
      "拒绝执行",
      message,
      { targets: [details.target], channel: details.channel, after: { code: details.code, error } },
    );
  await reply.code(403).send({ error, message });
}

/** Organization execution uses the caller, the real target, and server time. Client channel fields are ignored. */
export async function organizationExecutionFence(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const access = request.admin?.organizationAccess;
  if (!access || reply.sent) return;
  const path = request.url.split("?", 1)[0] ?? "";
  if (
    /^\/api\/v1\/desktop\/ssh-connections\/[^/]+\/envelope$/i.test(path)
    && bodyRecord(request.body).auditSource === "mcp"
  ) return;
  if (path.startsWith("/api/v1/mcp/") && path.endsWith("/status")) return;
  if (
    request.method !== "GET" &&
    /\/api\/v1\/database-(?:models|bi-workspaces|saved-queries|table-profiles)\/[^/]+\/access$/.test(path)
  ) {
    await reply.code(410).send({ error: "LEGACY_ACCESS_READ_ONLY", message: "请通过角色维护资源授权" });
    return;
  }
  if (isMetadataRead(request.method, path)) return;
  const channel = trustedExecutionChannel(request);
  const mapped = await mappedOperation(request, channel);
  const automated =
    channel !== "manual" ||
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path.startsWith("/api/v1/mcp/") ||
    path.includes("/agent-diagnostics") ||
    path.includes("/database-automations") ||
    internalRequestAuditSource(request) === "mcp";
  if (path.includes("/agent-diagnostics")) return;
  if (automated && channel !== "manual") {
    if (!mapped) {
      await deny(request, reply, "FEATURE_FORBIDDEN", "组织自动化调用必须指向已授权的具体资源", { channel });
      return;
    }
    for (const node of [mapped, ...(mapped.also ?? [])]) {
      const target = { type: node.type, id: node.id };
      if (node.sql !== undefined) {
        const missing = await missingDatabaseSqlPermission(node.sql, (code) => executionDecision(access, channel, code, target).allowed);
        if (missing) {
          const decision = executionDecision(access, channel, missing, target);
          await deny(request, reply, decision.error ?? "FEATURE_FORBIDDEN", decision.message, { channel, code: missing, target });
          return;
        }
        continue;
      }
      const codes = node.codes.filter(Boolean);
      if (!codes.length) {
        await deny(request, reply, "FEATURE_FORBIDDEN", "组织自动化调用必须指向已授权的具体资源", { channel, target });
        return;
      }
      if (node.match === "any") {
        const allowed = codes.some((code) => executionDecision(access, channel, code, target).allowed);
        if (!allowed) {
          const decision = executionDecision(access, channel, codes[0] ?? "", target);
          await deny(request, reply, decision.error ?? "FEATURE_FORBIDDEN", decision.message, { channel, code: codes[0], target });
          return;
        }
        continue;
      }
      for (const code of codes) {
        const decision = executionDecision(access, channel, code, target);
        if (!decision.allowed) {
          await deny(request, reply, decision.error ?? "FEATURE_FORBIDDEN", decision.message, { channel, code, target });
          return;
        }
      }
    }
    return;
  }
  if (!mapped) {
    if (path.includes("/database-automations") || /^\/api\/v1\/desktop\/(ssh|database|redis)-connections\//.test(path))
      await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限");
    return;
  }
  for (const node of [mapped, ...(mapped.also ?? [])]) {
    const target = { type: node.type, id: node.id };
    if (node.sql !== undefined) {
      const missing = await missingDatabaseSqlPermission(node.sql, (code) => access.allows(code, target));
      if (missing) {
        await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { code: missing, target, channel: "manual" });
        return;
      }
      continue;
    }
    const codes = node.codes.filter(Boolean);
    if (!codes.length) {
      await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { target, channel: "manual" });
      return;
    }
    if (node.match === "any") {
      if (!codes.some((code) => access.allows(code, target))) {
        await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { code: codes[0], target, channel: "manual" });
        return;
      }
      continue;
    }
    for (const code of codes) {
      if (!access.allows(code, target)) {
        await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { code, target, channel: "manual" });
        return;
      }
    }
  }
}
