import { createHash } from "node:crypto";
import { databaseSqlPermissions } from "../shared/access-permissions.js";
import { databaseTaskAccessPlan, type DatabaseTaskKind } from "../shared/database-task-access.js";
import type { DesktopExecutionCheck } from "../shared/desktop-execution-authorization.js";
import type { McpApiRequest, McpApiResponse } from "../shared/mcp-protocol.js";
import type { ResourceRef } from "../shared/organization-rbac.js";
import { redisCommandAccess } from "../shared/redis.js";
import {
  desktopDatabaseOperationRuntime,
  desktopDatabaseRuntime,
  desktopSftpRuntime,
  desktopSshRuntime,
} from "./desktop-runtime-context.js";
import { currentDesktopSshContext } from "./execution-router.js";
import { DesktopApiError, endpointJson } from "./http-proxy.js";
import { authorizeOrganizationExecution } from "./organization-execution.js";
import { DESKTOP_LOCAL_SFTP_CONNECTION_ID } from "./sftp-runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECK_BATCH = 16;

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

export interface OrganizationMcpSources {
  webEntryId(credentialId: string): Promise<string | null>;
  databaseTask(id: string): Promise<{ type: DatabaseTaskKind; connectionId: string | null; details: Record<string, unknown> } | null>;
  databaseQuery(id: string): Promise<{ connectionId: string; sql: string } | null>;
  sftpTransfer(id: string): Promise<{ sourceConnectionId: string; targetConnectionId: string } | null>;
  recording(id: string): Promise<{ connectionId: string } | null>;
  recordingConnectionIds(): Promise<string[]>;
}

function requestMethod(request: McpApiRequest): string {
  return (request.method ?? "GET").toUpperCase();
}

function requestUrl(request: McpApiRequest): URL {
  return new URL(request.path, "http://desktop.local");
}

/** Digest covers the path query, the structured query, and form field or file summaries. */
export function desktopMcpRequestIdentity(request: McpApiRequest) {
  const url = requestUrl(request);
  const query = new URLSearchParams(url.search);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const queryText = [...query.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("&");
  const fields = Object.entries(request.form?.fields ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("&");
  const files = (request.form?.files ?? []).map((file) => {
    const digest = createHash("sha256").update(file.contentBase64).digest("hex");
    return `${file.fieldName}:${file.filename}:${file.contentType}:${file.contentBase64.length}:${digest}`;
  }).join(",");
  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  return {
    method: requestMethod(request),
    path: url.pathname,
    bodyDigest: createHash("sha256").update(`${body}\n${queryText}\n${fields}\n${files}`).digest("hex"),
  };
}

function sqlText(body: unknown): string {
  const value = body as { sql?: string; statements?: Array<string | { sql: string }>; queries?: Array<string | { sql?: string }> } | undefined;
  if (typeof value?.sql === "string") return value.sql;
  if (Array.isArray(value?.statements)) return value.statements.map((item) => (typeof item === "string" ? item : item.sql)).join(";\n");
  if (Array.isArray(value?.queries)) return value.queries.map((item) => (typeof item === "string" ? item : item.sql ?? "")).join(";\n");
  return "";
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function restoreSql(request: McpApiRequest): string {
  const record = bodyRecord(request.body);
  if (typeof record.restoreSql === "string") return record.restoreSql;
  const file = request.form?.files?.find((item) => item.filename.toLowerCase().endsWith(".sql")) ?? request.form?.files?.[0];
  if (!file) return "";
  return Buffer.from(file.contentBase64, "base64").toString("utf8");
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

function check(type: ResourceRef["type"], id: string, code: string): DesktopExecutionCheck | null {
  if (!UUID.test(id)) return null;
  return { target: { type, id: id.toLowerCase() }, code };
}

function databaseChecks(id: string, actions: string[]): DesktopExecutionCheck[] {
  return actions.map((code) => check("database_connection", id, code)).filter((item): item is DesktopExecutionCheck => item !== null);
}

function sshChecks(id: string, code: string): DesktopExecutionCheck[] {
  if (id === DESKTOP_LOCAL_SFTP_CONNECTION_ID) return [];
  const item = check("ssh_connection", id, code);
  return item ? [item] : [];
}

function isMetadataRead(method: string, path: string): boolean {
  return (method === "GET" || method === "HEAD") && METADATA_READ.some((pattern) => pattern.test(path));
}

async function defaultSources(): Promise<OrganizationMcpSources> {
  const context = await currentDesktopSshContext();
  return {
    async webEntryId(credentialId) {
      try {
        const row = await endpointJson<{ entryId?: string }>(`/api/v1/web-credentials/${credentialId}/entry-ref`);
        return typeof row.entryId === "string" && UUID.test(row.entryId) ? row.entryId.toLowerCase() : null;
      } catch {
        return null;
      }
    },
    async databaseTask(id) {
      const task = desktopDatabaseOperationRuntime?.ownedAccess(id, context) ?? null;
      if (!task || (task.type !== "backup" && task.type !== "restore" && task.type !== "transfer" && task.type !== "import")) return null;
      return task;
    },
    async databaseQuery(id) {
      return desktopDatabaseRuntime?.ownedQuery(id, context) ?? null;
    },
    async sftpTransfer(id) {
      return desktopSftpRuntime?.ownedTransfer(id, context) ?? null;
    },
    async recording(id) {
      return desktopSshRuntime?.ownedRecording(id, context) ?? null;
    },
    async recordingConnectionIds() {
      return desktopSshRuntime?.ownedRecordingConnectionIds(context) ?? [];
    },
  };
}

/** Passthrough is an owned status or metadata read. Closed is an operation this batch does not run. */
export type OrganizationMcpDecision = DesktopExecutionCheck[] | "passthrough" | "closed";

function isOwnedCancel(method: string, path: string): boolean {
  return method === "DELETE" && (/^\/api\/v1\/database-tasks\/[^/]+$/i.test(path) || /^\/api\/v1\/database-queries\/[^/]+$/i.test(path) || /^\/api\/v1\/sftp-transfers\/[^/]+$/i.test(path));
}

/** Supported organization MCP paths. Passthrough does not start a new external operation. */
export async function organizationMcpChecks(request: McpApiRequest, sources?: OrganizationMcpSources): Promise<OrganizationMcpDecision> {
  const method = requestMethod(request);
  const url = requestUrl(request);
  const path = url.pathname;
  if (isMetadataRead(method, path) && path !== "/api/v1/ssh-recordings") return "passthrough";
  const resolved = sources ?? await defaultSources();
  if (isOwnedCancel(method, path)) {
    const id = path.split("/").at(-1) ?? "";
    if (path.includes("/database-tasks/")) return await resolved.databaseTask(id) ? "passthrough" : [];
    if (path.includes("/database-queries/")) return await resolved.databaseQuery(id) ? "passthrough" : [];
    return await resolved.sftpTransfer(id) ? "passthrough" : [];
  }
  const recordings = path.match(/^\/api\/v1\/ssh-recordings(?:\/([^/]+)(?:\/download)?)?$/i);
  if (recordings && !recordings[1] && (method === "GET" || method === "HEAD")) {
    const connectionIds = await resolved.recordingConnectionIds();
    if (!connectionIds.length) return "passthrough";
    return connectionIds.flatMap((id) => sshChecks(id, "ssh.view"));
  }
  if (recordings?.[1] && UUID.test(recordings[1])) {
    const recording = await resolved.recording(recordings[1]);
    if (!recording) return [];
    const code = method === "DELETE" ? "resource.ssh.configure" : "ssh.view";
    return sshChecks(recording.connectionId, code);
  }
  const knowledge = path.match(/^\/api\/v1\/knowledge-documents\/([^/]+)(?:\/content)?$/i);
  if (knowledge && UUID.test(knowledge[1])) {
    return [check("knowledge_node", knowledge[1], method === "GET" || method === "HEAD" ? "knowledge.view" : "knowledge.edit")].filter((item): item is DesktopExecutionCheck => item !== null);
  }
  const ssh = path.match(/^\/api\/v1\/mcp\/ssh-connections\/([^/]+)\/commands?$/i);
  if (ssh && method === "POST" && UUID.test(ssh[1])) return [check("ssh_connection", ssh[1], "ssh.use")].filter((item): item is DesktopExecutionCheck => item !== null);
  const web = path.match(/^\/api\/v1\/(?:mcp\/)?web-credentials\/([^/]+)\/(?:snapshot|action|control|view\/upload|view\/reset)$/i);
  if (web && method === "POST" && UUID.test(web[1])) {
    const entryId = await resolved.webEntryId(web[1]);
    return entryId ? [check("web_entry", entryId, "web.use")].filter((item): item is DesktopExecutionCheck => item !== null) : [];
  }
  const log = path.match(/^\/api\/v1\/mcp\/environment-logs\/([^/]+)\/snapshot$/i);
  if (log && method === "POST" && UUID.test(log[1])) return [check("environment_log", log[1], "logs.view")].filter((item): item is DesktopExecutionCheck => item !== null);
  const inspect = path === "/api/v1/connections/inspect" && method === "POST";
  if (inspect) {
    const items = bodyRecord(request.body).items;
    if (!Array.isArray(items) || !items.length) return [];
    const checks: DesktopExecutionCheck[] = [];
    for (const item of items) {
      const value = item as { type?: string; id?: string } | null;
      const code = value?.type === "ssh" ? "ssh.use" : value?.type === "database" ? "database.read" : value?.type === "redis" ? "redis.view" : "";
      const type = value?.type === "ssh" ? "ssh_connection" : value?.type === "database" ? "database_connection" : value?.type === "redis" ? "redis_connection" : null;
      const next = type && value?.id && code ? check(type, value.id, code) : null;
      if (!next) return [];
      checks.push(next);
    }
    return checks;
  }
  const sftp = path.match(/^\/api\/v1\/ssh-connections\/([^/]+)\/sftp(?:\/(download|upload|mkdir|rename|chmod))?$/i);
  if (sftp && UUID.test(sftp[1])) {
    const action = sftp[2] ?? "";
    const code = action === "download" ? "ssh.download"
      : action === "upload" || action === "mkdir" ? "ssh.upload"
        : action === "rename" || action === "chmod" || method === "DELETE" ? "ssh.delete"
          : method === "GET" || method === "HEAD" ? "ssh.browse"
            : "";
    return code ? sshChecks(sftp[1], code) : [];
  }
  const sftpCreate = path === "/api/v1/sftp-transfers" || path === "/api/v1/sftp-transfers/preview";
  if (sftpCreate && method === "POST") {
    const body = bodyRecord(request.body);
    const source = typeof body.sourceConnectionId === "string" ? body.sourceConnectionId : "";
    const target = typeof body.targetConnectionId === "string" ? body.targetConnectionId : "";
    return [...sshChecks(source, "ssh.download"), ...sshChecks(target, "ssh.upload")];
  }
  const sftpRetry = path.match(/^\/api\/v1\/sftp-transfers\/([^/]+)\/retry$/i);
  if (sftpRetry && method === "POST" && UUID.test(sftpRetry[1])) {
    const task = await resolved.sftpTransfer(sftpRetry[1]);
    if (!task) return [];
    return [...sshChecks(task.sourceConnectionId, "ssh.download"), ...sshChecks(task.targetConnectionId, "ssh.upload")];
  }
  const database = path.match(/^\/api\/v1\/database-connections\/([^/]+)\/([a-z0-9/-]+)$/i);
  if (database && UUID.test(database[1])) {
    const id = database[1];
    const action = database[2].toLowerCase();
    if (action === "queries" || action === "queries/batch") {
      if (method !== "POST") return [];
      return databaseSqlPermissions(sqlText(request.body)).map((code) => check("database_connection", id, code)).filter((item): item is DesktopExecutionCheck => item !== null);
    }
    if (["schemas", "objects", "completion-metadata", "ddl", "table-design", "table-data", "table-data/suggestions", "test"].includes(action) && (method === "GET" || method === "HEAD" || (action === "test" && method === "POST"))) {
      return databaseChecks(id, ["database.read"]);
    }
    if (action === "table-data/changes" && method === "POST") return databaseChecks(id, ["database.write"]);
    if (action === "table-import" && method === "POST") return databaseChecks(id, ["database.write"]);
    if (action === "table-export") return databaseChecks(id, ["database.read", "database.export"]);
    if (["database-create", "database-drop", "table-create", "table-alter", "table-drop", "table-rename", "table-copy", "schema-changes"].includes(action)) {
      return databaseChecks(id, ["database.ddl"]);
    }
    if (action === "backup" && method === "POST") return databaseChecks(id, databaseTaskAccessPlan("backup", bodyRecord(request.body)).operations.map((code) => `database.${code}`));
    if (action === "restore" && method === "POST") {
      const plan = databaseTaskAccessPlan("restore", { restoreSql: restoreSql(request) });
      return plan.operations.length ? databaseChecks(id, plan.operations.map((code) => `database.${code}`)) : [];
    }
    if ((action === "transfer" || action === "sync" || action === "sync-preview") && method === "POST") {
      const body = bodyRecord(request.body);
      const target = typeof body.targetConnectionId === "string" ? body.targetConnectionId : "";
      if (action === "sync-preview") return [...databaseChecks(id, ["database.read"]), ...databaseChecks(target, ["database.read"])];
      const plan = databaseTaskAccessPlan("transfer", { ...body, syncMode: body.syncMode ?? body.mode, targetConnectionId: target });
      if (!plan.targetConnectionId) return [];
      return [
        ...databaseChecks(id, plan.operations.map((code) => `database.${code}`)),
        ...databaseChecks(plan.targetConnectionId, plan.targetOperations.map((code) => `database.${code}`)),
      ];
    }
    return [];
  }
  const query = path.match(/^\/api\/v1\/database-queries\/([^/]+)$/i);
  if (query && UUID.test(query[1]) && (method === "GET" || method === "HEAD")) {
    const job = await resolved.databaseQuery(query[1]);
    return job ? databaseSqlPermissions(job.sql).map((code) => check("database_connection", job.connectionId, code)).filter((item): item is DesktopExecutionCheck => item !== null) : [];
  }
  const download = path.match(/^\/api\/v1\/database-tasks\/([^/]+)\/download$/i);
  if (download && UUID.test(download[1]) && (method === "GET" || method === "HEAD")) {
    const task = await resolved.databaseTask(download[1]);
    if (!task?.connectionId) return [];
    const plan = databaseTaskAccessPlan(task.type, task.details);
    return [
      ...databaseChecks(task.connectionId, plan.operations.map((code) => `database.${code}`)),
      ...(plan.targetConnectionId ? databaseChecks(plan.targetConnectionId, plan.targetOperations.map((code) => `database.${code}`)) : []),
    ];
  }
  const redisRead = path.match(/^\/api\/v1\/redis-connections\/([^/]+)\/(?:info|scan|test)$/i);
  if (redisRead && UUID.test(redisRead[1]) && (method === "GET" || method === "POST")) return [check("redis_connection", redisRead[1], "redis.view")].filter((item): item is DesktopExecutionCheck => item !== null);
  const redisCommand = path.match(/^\/api\/v1\/redis-connections\/([^/]+)\/commands?(?:\/batch)?$/i);
  if (redisCommand && method === "POST" && UUID.test(redisCommand[1])) {
    const codes = redisCodes(request.body);
    if (!codes) return [];
    return codes.map((code) => check("redis_connection", redisCommand[1], code)).filter((item): item is DesktopExecutionCheck => item !== null);
  }
  return "closed";
}

function denied(error: string, message: string): McpApiResponse {
  return { status: 403, headers: { "content-type": "application/json; charset=utf-8" }, data: { error, message } };
}

/** Organization calls authorize before execution. Personal workspaces stay on the existing path. */
export async function guardDesktopOrganizationMcpRequest(request: McpApiRequest): Promise<{ denied: McpApiResponse | null; checks: DesktopExecutionCheck[] }> {
  if ((await currentDesktopSshContext()).workspaceType !== "organization") return { denied: null, checks: [] };
  const decision = await organizationMcpChecks(request);
  if (decision === "passthrough") return { denied: null, checks: [] };
  if (decision === "closed") return { denied: denied("FEATURE_FORBIDDEN", "组织 MCP 尚未接入这项操作"), checks: [] };
  if (!decision.length) return { denied: denied("ACTION_FORBIDDEN", "组织 MCP 不能执行未受控的操作"), checks: [] };
  const identity = desktopMcpRequestIdentity(request);
  try {
    for (let index = 0; index < decision.length; index += CHECK_BATCH) {
      const result = await authorizeOrganizationExecution(identity, decision.slice(index, index + CHECK_BATCH));
      if (!result.allowed) return { denied: denied(result.error ?? "FEATURE_FORBIDDEN", result.message || "组织执行授权未通过"), checks: [] };
    }
    return { denied: null, checks: decision };
  } catch (error) {
    if (error instanceof DesktopApiError && error.status === 403) return { denied: denied(error.code, error.message), checks: [] };
    throw error;
  }
}
