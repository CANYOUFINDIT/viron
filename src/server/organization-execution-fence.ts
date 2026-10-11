import type { FastifyReply, FastifyRequest } from "fastify";
import { internalRequestAuditSource } from "./audit.js";
import { sqlRequiresWrite } from "../shared/access-permissions.js";

/** Phase 0 fence: closed channels stay closed until every operation has a server-side gate. */
export async function organizationExecutionFence(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const access = request.admin?.organizationAccess;
  if (!access) return;
  const path = request.url.split("?", 1)[0];
  const source = internalRequestAuditSource(request);
  const closed =
    source === "mcp" ||
    path === "/mcp" ||
    (path.startsWith("/api/v1/mcp/") && !path.endsWith("/status")) ||
    /^\/api\/v1\/desktop\/(ssh|database|redis)-connections\//.test(path) ||
    path.includes("/database-automations");
  if (closed) {
    await reply
      .code(403)
      .send({
        error: "ORGANIZATION_CHANNEL_CLOSED",
        message: "组织的自动化与桌面本机执行将在阶段 6 完成逐资源鉴权后开放",
      });
    return;
  }
  if (
    request.method !== "GET" &&
    /\/api\/v1\/database-(?:models|bi-workspaces|saved-queries|table-profiles)\/[^/]+\/access$/.test(
      path,
    )
  ) {
    await reply
      .code(410)
      .send({
        error: "LEGACY_ACCESS_READ_ONLY",
        message: "请通过角色维护资源授权",
      });
    return;
  }
  const id = (request.params as { id?: string }).id;
  if (!id) return;
  let code: string | undefined;
  let type: "ssh_connection" | "database_connection" | undefined;
  if (/\/ssh-connections\/[^/]+\/sftp/.test(path)) {
    type = "ssh_connection";
    code = path.endsWith("/download")
      ? "ssh.download"
      : request.method === "DELETE" || /\/(rename|chmod)$/.test(path)
        ? "ssh.delete"
        : request.method === "POST"
          ? "ssh.upload"
          : "ssh.browse";
  }
  if (/\/database-connections\//.test(path)) {
    type = "database_connection";
    if (/\/(table-export|backup)$/.test(path)) code = "database.export";
    else if (
      /\/(restore|database-create|database-drop|table-create|table-alter|table-drop|table-rename|table-copy|schema-changes)$/.test(
        path,
      )
    )
      code = "database.ddl";
    else if (path.includes("/queries") && request.method === "POST") {
      const body = request.body as
        | { sql?: string; statements?: Array<string | { sql: string }> }
        | undefined;
      const sql =
        body?.sql ??
        (body?.statements ?? [])
          .map((s) => (typeof s === "string" ? s : s.sql))
          .join(";\n");
      // Unclassified writes require both write and DDL; conservative until the SQL parser is integrated.
      if (sqlRequiresWrite(sql)) {
        if (!access.allows("database.write", { type, id }))
          code = "database.write";
        else if (!access.allows("database.ddl", { type, id }))
          code = "database.ddl";
      }
    }
  }
  if (code && type && !access.allows(code, { type, id }))
    await reply
      .code(403)
      .send({
        error: "ACTION_FORBIDDEN",
        message: "角色未获得这项资源操作权限",
      });
}
