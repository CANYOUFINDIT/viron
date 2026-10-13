import { createHash } from "node:crypto";
import { databaseSqlPermissions } from "../shared/access-permissions.js";
import type { DesktopExecutionCheck } from "../shared/desktop-execution-authorization.js";
import type { McpApiRequest, McpApiResponse } from "../shared/mcp-protocol.js";
import { redisCommandAccess } from "../shared/redis.js";
import { currentDesktopSshContext } from "./execution-router.js";
import { DesktopApiError } from "./http-proxy.js";
import { authorizeOrganizationExecution } from "./organization-execution.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_GET = /\/(?:ssh-connections|database-connections|redis-connections|web-credentials|web-entries|knowledge-documents|knowledge-nodes|environment-logs|database-queries|database-tasks|ssh-recordings|sftp-transfers)\/[0-9a-f-]{36}/i;

function requestMethod(request: McpApiRequest): string {
  return (request.method ?? "GET").toUpperCase();
}

function requestPathname(request: McpApiRequest): string {
  return new URL(request.path, "http://desktop.local").pathname;
}

function requestIdentity(request: McpApiRequest) {
  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  return {
    method: requestMethod(request),
    path: requestPathname(request),
    bodyDigest: createHash("sha256").update(body).digest("hex"),
  };
}

function sqlText(body: unknown): string {
  const value = body as { sql?: string; statements?: Array<string | { sql: string }>; queries?: Array<string | { sql?: string }> } | undefined;
  if (typeof value?.sql === "string") return value.sql;
  if (Array.isArray(value?.statements)) return value.statements.map((item) => (typeof item === "string" ? item : item.sql)).join(";\n");
  if (Array.isArray(value?.queries)) return value.queries.map((item) => (typeof item === "string" ? item : item.sql ?? "")).join(";\n");
  return "";
}

function redisCodes(body: unknown): string[] | null {
  const value = body as { command?: string; args?: string[]; commands?: Array<{ command?: string; args?: string[] }> } | undefined;
  const commands = Array.isArray(value?.commands)
    ? value.commands.map((item) => ({ command: String(item.command ?? ""), args: item.args ?? [] }))
    : [{ command: String(value?.command ?? ""), args: value?.args ?? [] }];
  const codes = new Set<string>();
  for (const command of commands) {
    const access = redisCommandAccess(command.command, command.args);
    if (access === "deny") return null;
    codes.add(access === "read" ? "redis.view" : "redis.write");
  }
  return [...codes];
}

/** Supported organization MCP paths. Null means this batch does not authorize the call. */
export function organizationMcpChecks(request: McpApiRequest): DesktopExecutionCheck[] | null {
  const method = requestMethod(request);
  const path = requestPathname(request);
  const knowledge = path.match(/^\/api\/v1\/knowledge-documents\/([^/]+)(?:\/content)?$/i);
  if (knowledge && UUID.test(knowledge[1])) {
    return [{ target: { type: "knowledge_node", id: knowledge[1].toLowerCase() }, code: method === "GET" || method === "HEAD" ? "knowledge.view" : "knowledge.edit" }];
  }
  const ssh = path.match(/^\/api\/v1\/mcp\/ssh-connections\/([^/]+)\/commands?$/i);
  if (ssh && method === "POST" && UUID.test(ssh[1])) {
    return [{ target: { type: "ssh_connection", id: ssh[1].toLowerCase() }, code: "ssh.use" }];
  }
  const database = path.match(/^\/api\/v1\/database-connections\/([^/]+)\/queries(?:\/batch)?$/i);
  if (database && method === "POST" && UUID.test(database[1])) {
    return databaseSqlPermissions(sqlText(request.body)).map((code) => ({
      target: { type: "database_connection", id: database[1].toLowerCase() },
      code,
    }));
  }
  const redisRead = path.match(/^\/api\/v1\/redis-connections\/([^/]+)\/(?:info|scan|test)$/i);
  if (redisRead && UUID.test(redisRead[1]) && (method === "GET" || method === "POST")) {
    return [{ target: { type: "redis_connection", id: redisRead[1].toLowerCase() }, code: "redis.view" }];
  }
  const redisCommand = path.match(/^\/api\/v1\/redis-connections\/([^/]+)\/commands?(?:\/batch)?$/i);
  if (redisCommand && method === "POST" && UUID.test(redisCommand[1])) {
    const codes = redisCodes(request.body);
    if (!codes) return [];
    return codes.map((code) => ({ target: { type: "redis_connection", id: redisCommand[1].toLowerCase() }, code }));
  }
  return null;
}

function denied(error: string, message: string): McpApiResponse {
  return { status: 403, headers: { "content-type": "application/json; charset=utf-8" }, data: { error, message } };
}

function isCatalogRead(request: McpApiRequest): boolean {
  const method = requestMethod(request);
  return (method === "GET" || method === "HEAD") && !RESOURCE_GET.test(requestPathname(request));
}

/** Organization calls authorize before execution. Personal workspaces stay on the existing path. */
export async function guardDesktopOrganizationMcpRequest(request: McpApiRequest): Promise<McpApiResponse | null> {
  if ((await currentDesktopSshContext()).workspaceType !== "organization") return null;
  const checks = organizationMcpChecks(request);
  if (checks === null) {
    if (isCatalogRead(request)) return null;
    return denied("FEATURE_FORBIDDEN", "组织 MCP 尚未接入这项操作");
  }
  if (!checks.length) return denied("ACTION_FORBIDDEN", "组织 MCP 不能执行未受控的操作");
  try {
    const result = await authorizeOrganizationExecution(requestIdentity(request), checks);
    if (!result.allowed) return denied(result.error ?? "FEATURE_FORBIDDEN", result.message || "组织执行授权未通过");
    return null;
  } catch (error) {
    if (error instanceof DesktopApiError && error.status === 403) return denied(error.code, error.message);
    throw error;
  }
}
