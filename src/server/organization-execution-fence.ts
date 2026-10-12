import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { internalRequestAuditSource } from "./audit.js";
import { databaseSqlPermissions, missingDatabaseSqlPermission } from "../shared/access-permissions.js";
import { executionDecision, trustedExecutionChannel, type ExecutionChannel } from "./organization-boundary.js";
import { recordGrantLedger } from "./organization-approval.js";
import type { ResourceRef } from "../shared/organization-rbac.js";
import { redisCommandAccess } from "../shared/redis.js";

interface MappedOperation {
  codes: string[];
  sql?: string;
  type: ResourceRef["type"];
  id: string;
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

function mappedOperation(request: FastifyRequest, channel: ExecutionChannel): MappedOperation | null {
  const path = request.url.split("?", 1)[0] ?? "";
  const id = (request.params as { id?: string }).id;
  const connectionId =
    (request.body as { connectionId?: string } | undefined)?.connectionId ??
    (request.query as { connectionId?: string } | undefined)?.connectionId;
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
  if (/\/desktop\/ssh-connections\/[^/]+\/envelope$/.test(path) && id)
    return operation("ssh.use", "ssh_connection", id);
  if (/\/desktop\/database-connections\/[^/]+\/envelope$/.test(path) && id)
    return operation("database.read", "database_connection", id);
  if (/\/desktop\/redis-connections\/[^/]+\/envelope$/.test(path) && id)
    return operation("redis.view", "redis_connection", id);
  if (/\/database-connections\//.test(path) && id) {
    if (/\/(table-export|backup)$/.test(path)) return { codes: ["database.read", "database.export"], type: "database_connection", id };
    if (/\/restore$/.test(path)) return { codes: [], type: "database_connection", id };
    if (/\/(database-create|database-drop|table-create|table-alter|table-drop|table-rename|table-copy|schema-changes)$/.test(path))
      return operation("database.ddl", "database_connection", id);
    if (path.includes("/queries") && request.method === "POST") {
      const sql = requestSql(request.body as { sql?: string; statements?: Array<string | { sql: string }>; queries?: Array<string | { sql?: string }> } | undefined);
      return { codes: databaseSqlPermissions(sql), sql, type: "database_connection", id };
    }
    if (/\/mcp\/database-connections\//.test(path)) return operation(request.method === "GET" ? "database.read" : "database.write", "database_connection", id);
    return null;
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
  if (path.startsWith("/api/v1/mcp/") && path.endsWith("/status")) return;
  if (
    request.method !== "GET" &&
    /\/api\/v1\/database-(?:models|bi-workspaces|saved-queries|table-profiles)\/[^/]+\/access$/.test(path)
  ) {
    await reply.code(410).send({ error: "LEGACY_ACCESS_READ_ONLY", message: "请通过角色维护资源授权" });
    return;
  }
  const channel = trustedExecutionChannel(request);
  const mapped = mappedOperation(request, channel);
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
    const target = { type: mapped.type, id: mapped.id };
    if (mapped.sql !== undefined) {
      const missing = await missingDatabaseSqlPermission(mapped.sql, (code) => executionDecision(access, channel, code, target).allowed);
      if (missing) {
        const decision = executionDecision(access, channel, missing, target);
        await deny(request, reply, decision.error ?? "FEATURE_FORBIDDEN", decision.message, { channel, code: missing, target });
      }
      return;
    }
    for (const code of mapped.codes) {
      const decision = executionDecision(access, channel, code, target);
      if (!decision.allowed) {
        await deny(request, reply, decision.error ?? "FEATURE_FORBIDDEN", decision.message, { channel, code, target });
        return;
      }
    }
    return;
  }
  if (!mapped) {
    if (path.includes("/database-automations") || /^\/api\/v1\/desktop\/(ssh|database|redis)-connections\//.test(path))
      await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限");
    return;
  }
  const target = { type: mapped.type, id: mapped.id };
  if (mapped.sql !== undefined) {
    const missing = await missingDatabaseSqlPermission(mapped.sql, (code) => access.allows(code, target));
    if (missing) await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { code: missing, target, channel: "manual" });
    return;
  }
  for (const code of mapped.codes) {
    if (!access.allows(code, target)) {
      await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { code, target, channel: "manual" });
      return;
    }
  }
}
