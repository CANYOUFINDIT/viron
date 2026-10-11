import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { internalRequestAuditSource } from "./audit.js";
import { sqlRequiresWrite } from "../shared/access-permissions.js";
import { executionDecision, trustedExecutionChannel, type ExecutionChannel } from "./organization-boundary.js";
import { recordGrantLedger } from "./organization-approval.js";
import type { ResourceRef } from "../shared/organization-rbac.js";
import { redisCommandAccess } from "../shared/redis.js";

interface MappedOperation {
  code: string;
  type: ResourceRef["type"];
  id: string;
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
    return { code, type: "ssh_connection", id };
  }
  if (/\/mcp\/ssh-connections\/[^/]+/.test(path) && id) return { code: "ssh.use", type: "ssh_connection", id };
  if (/\/desktop\/ssh-connections\/[^/]+\/envelope$/.test(path) && id)
    return { code: "ssh.use", type: "ssh_connection", id };
  if (/\/desktop\/database-connections\/[^/]+\/envelope$/.test(path) && id)
    return { code: "database.read", type: "database_connection", id };
  if (/\/desktop\/redis-connections\/[^/]+\/envelope$/.test(path) && id)
    return { code: "redis.view", type: "redis_connection", id };
  if (/\/database-connections\//.test(path) && id) {
    let code = "";
    if (/\/(table-export|backup)$/.test(path)) code = "database.export";
    else if (/\/(restore|database-create|database-drop|table-create|table-alter|table-drop|table-rename|table-copy|schema-changes)$/.test(path))
      code = "database.ddl";
    else if (path.includes("/queries") && request.method === "POST") {
      const body = request.body as { sql?: string; statements?: Array<string | { sql: string }> } | undefined;
      const sql = body?.sql ?? (body?.statements ?? []).map((item) => (typeof item === "string" ? item : item.sql)).join(";\n");
      code = sqlRequiresWrite(sql) ? "database.write" : "database.read";
    } else if (/\/mcp\/database-connections\//.test(path)) code = request.method === "GET" ? "database.read" : "database.write";
    if (!code) return null;
    return { code, type: "database_connection", id };
  }
  if (/\/redis-connections\/[^/]+\/(?:info|scan|test)$/.test(path) && id)
    return { code: "redis.view", type: "redis_connection", id };
  if (/\/redis-connections\/[^/]+\/commands?(?:\/batch)?$/.test(path) && id) {
    const command = String((request.body as { command?: string } | undefined)?.command ?? "");
    if (!command && channel === "manual") return null;
    const access = command ? redisCommandAccess(command.toUpperCase()) : "write";
    return { code: access === "read" ? "redis.view" : "redis.write", type: "redis_connection", id };
  }
  if (/\/knowledge-documents\/[^/]+/.test(path) && id)
    return { code: request.method === "GET" ? "knowledge.view" : "knowledge.edit", type: "knowledge_node", id };
  if (path.includes("/database-automations") && connectionId)
    return { code: request.method === "GET" ? "database.read" : "database.write", type: "database_connection", id: connectionId };
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
    const decision = executionDecision(access, channel, mapped.code, target);
    if (!decision.allowed) {
      await deny(request, reply, decision.error ?? "FEATURE_FORBIDDEN", decision.message, { channel, code: mapped.code, target });
      return;
    }
    if (mapped.code === "database.write" && !access.allows("database.ddl", target) && path.includes("/queries")) {
      const body = request.body as { sql?: string } | undefined;
      if (body?.sql && /create|drop|alter/i.test(body.sql) && !access.allows("database.ddl", target)) {
        await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { channel, code: "database.ddl", target });
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
  if (mapped.code === "database.write" && path.includes("/queries")) {
    const body = request.body as { sql?: string; statements?: Array<string | { sql: string }> } | undefined;
    const sql = body?.sql ?? (body?.statements ?? []).map((item) => (typeof item === "string" ? item : item.sql)).join(";\n");
    if (sqlRequiresWrite(sql) && access.allows("database.write", target) && !access.allows("database.ddl", target)) {
      await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { code: "database.ddl", target, channel: "manual" });
      return;
    }
  }
  if (!access.allows(mapped.code, target))
    await deny(request, reply, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", { code: mapped.code, target, channel: "manual" });
}
