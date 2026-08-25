import { translate as tr } from "./i18n.js";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import mysql, { type ConnectionOptions, type FieldPacket, type QueryResult, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { ClientChannel } from "ssh2";
import { NavicatHttpTunnelConnection } from "../server/database-workbench/http-tunnel.js";
import { buildTableDataClauses, parseTableDataQueryRules } from "../shared/database-table-data.js";
import { parseCreateTableConstraints } from "../shared/database-table-design.js";
import type { AgentDatabaseContextInput, AgentDatabaseContextSnapshot, AgentDatabaseReadResult } from "../shared/agent.js";
import { splitSqlStatements } from "../shared/sql-statements.js";
import { agentDatabaseContextSnapshot, assertAgentReadOnlySql, assertAgentWriteSql, sanitizeAgentDatabaseInput } from "./agent-database-context.js";
import type { DesktopDatabaseCredential } from "./device-identity.js";
import { connectDesktopSsh, type ConnectedDesktopSsh, type DesktopSshContext } from "./ssh-runtime.js";
import { IdleResourcePool } from "../shared/idle-resource-pool.js";
import { assertMcpReadOnlySql } from "../shared/mcp-policy.js";
import { contextKey } from "./ssh-context.js";
import { jsonResponse, type DesktopDatabaseResponse } from "./json-response.js";

export type { DesktopDatabaseResponse };

export interface DesktopDatabaseRequest {
  path: string;
  method?: string;
  body?: {
    kind: "text" | "form";
    value?: string;
    entries?: Array<{
      name: string;
      value?: string;
      file?: { name: string; type: string; data: ArrayBuffer };
    }>;
  };
}

export type DesktopDatabaseExecutionReport =
  | {
      kind: "query";
      operationId: string;
      connectionId: string;
      database: string;
      sql: string;
      status: "success" | "error" | "cancelled";
      durationMs: number;
      rowCount: number;
      error: string;
    }
  | {
      kind: "operation";
      operationId: string;
      connectionId: string;
      action:
        | "connection_tested"
        | "connection_test_failed"
        | "table_data_changed"
        | "queries_read_batch"
        | "table_exported"
        | "table_imported"
        | "backup_success"
        | "backup_error"
        | "backup_cancelled"
        | "restore_success"
        | "restore_error"
        | "restore_cancelled"
        | "transfer_success"
        | "transfer_error"
        | "transfer_cancelled";
      summary: string;
      details: Record<string, unknown>;
    };

export interface DatabaseConnectionClient {
  query<T extends QueryResult = QueryResult>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  escape(value: unknown): string;
  end(): Promise<void>;
  destroy(): void;
}

export interface ConnectedDesktopDatabase {
  connection: DatabaseConnectionClient;
  credential: DesktopDatabaseCredential;
  close(): Promise<void>;
}

type QueryStatus = "pending" | "running" | "success" | "error" | "cancelled";
type ObjectCategory = "tables" | "views" | "procedures" | "functions" | "triggers" | "events";

export interface DesktopDatabaseQueryResultSet {
  columns: Array<{ name: string; table: string; type: number }>;
  rows: Array<Record<string, unknown>>;
  affectedRows: number;
  insertId: string | number;
  info: string;
  truncated: boolean;
  statement?: string;
  error?: string;
}

export interface DesktopDatabaseQueryJob {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
  continueOnError: boolean;
  status: QueryStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  resultSets: DesktopDatabaseQueryResultSet[];
}

interface ManagedQueryJob extends DesktopDatabaseQueryJob {
  context: DesktopSshContext;
  active?: ConnectedDesktopDatabase;
  cancelRequested?: boolean;
  reporting?: boolean;
}

class DesktopDatabaseError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_RESULT_ROWS = 10_000;
const QUERY_LIMIT = 10;
const MAX_BATCH_RESPONSE_BYTES = 2 * 1024 * 1024;

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function columnValue(row: RowDataPacket, ...names: string[]): unknown {
  for (const name of names) {
    if (name in row) return row[name];
  }
  return undefined;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createStatement(rows: RowDataPacket[]): string {
  const row = rows[0];
  return row ? String(Object.entries(row).find(([key]) => key.toLowerCase().includes("create"))?.[1] ?? "") : "";
}

function sqlStringValue(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1).replaceAll("''", "'").replaceAll("\\\\", "\\");
  }
  return trimmed;
}

function ddlToken(ddl: string, name: string): string {
  return ddl.match(new RegExp(`\\b${name}\\s*=\\s*([A-Za-z0-9_$-]+)`, "i"))?.[1]?.toUpperCase() ?? "";
}

function ddlNumber(ddl: string, name: string): number | null {
  const value = ddl.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`, "i"))?.[1];
  return value === undefined ? null : Number(value);
}

function ddlBoolean(ddl: string, name: string): boolean | null {
  const value = ddl.match(new RegExp(`\\b${name}\\s*=\\s*([01])`, "i"))?.[1];
  return value === undefined ? null : value === "1";
}

function ddlString(ddl: string, name: string): string {
  const value = ddl.match(new RegExp(`\\b${name}\\s*=\\s*('(?:''|[^'])*'|"(?:""|[^"])*"|[^\\s]+)`, "i"))?.[1];
  return sqlStringValue(value);
}

function columnDefinition(ddl: string, column: string): string {
  return ddl.match(new RegExp("^\\s*`" + regexEscape(column) + "`\\s+.*?(?:,)?$", "mi"))?.[0] ?? "";
}

function primaryKeyLength(ddl: string, column: string): string {
  const primary = ddl.match(/^\s*PRIMARY KEY\s*\((.+)\)(?:\s+USING\s+[A-Za-z0-9_]+)?\s*,?\s*$/im)?.[1] ?? "";
  return primary.match(new RegExp("`" + regexEscape(column) + "`\\s*\\((\\d+)\\)", "i"))?.[1] ?? "";
}

function indexDefinition(ddl: string, name: string): string {
  return ddl.match(new RegExp("^\\s*(?:UNIQUE\\s+|FULLTEXT\\s+|SPATIAL\\s+)?KEY\\s+`" + regexEscape(name) + "`\\s+.*?(?:,)?$", "mi"))?.[0] ?? "";
}

export function desktopDatabaseErrorMessage(error: unknown): string {
  return desktopDatabaseFailure(error).message;
}

function isPrivateNetworkAddress(address: string): boolean {
  const ipv4 = address.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return ipv4[0] === 10
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
      || (ipv4[0] === 169 && ipv4[1] === 254);
  }
  return /^(?:f[cd]|fe[89ab])/i.test(address);
}

export function desktopDatabaseFailure(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): { code: string; message: string } {
  const value = error as { address?: string; code?: string; message?: string; sqlMessage?: string };
  const rawMessage = value.sqlMessage || value.message || String(error);
  const address = value.address || rawMessage.match(/(?:\d{1,3}\.){3}\d{1,3}|(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}/i)?.[0] || "";
  if (platform === "darwin" && value.code === "EHOSTUNREACH" && isPrivateNetworkAddress(address)) {
    return {
      code: "DESKTOP_LOCAL_NETWORK_UNREACHABLE",
      message: tr("无法访问局域网数据库。可能是 macOS 本地网络权限状态异常，请前往“系统设置 → 隐私与安全性 → 本地网络”，关闭后重新开启 Viron，然后重试。技术信息：{{0}}", [rawMessage]),
    };
  }
  if (value.code === "ER_ACCESS_DENIED_ERROR") return { code: "DESKTOP_DATABASE_FAILED", message: tr("数据库认证失败，请检查用户名和密码") };
  if (value.code === "ECONNREFUSED") return { code: "DESKTOP_DATABASE_FAILED", message: tr("数据库端口拒绝连接") };
  if (value.code === "ETIMEDOUT" || value.code === "PROTOCOL_SEQUENCE_TIMEOUT") return { code: "DESKTOP_DATABASE_FAILED", message: tr("数据库连接或查询超时") };
  if (value.code === "ENOTFOUND" || value.code === "EAI_AGAIN") return { code: "DESKTOP_DATABASE_FAILED", message: tr("无法解析数据库主机地址") };
  return { code: "DESKTOP_DATABASE_FAILED", message: rawMessage };
}

function forward(client: ConnectedDesktopSsh["client"], host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

function mysqlOptions(credential: DesktopDatabaseCredential, database?: string, stream?: Readable): ConnectionOptions {
  const record = credential.connection;
  const ssl = record.options.ssl;
  const options: ConnectionOptions = {
    host: record.host,
    port: record.port,
    user: record.username,
    password: record.password,
    database: (database ?? record.defaultDatabase) || undefined,
    charset: record.options.charset || "utf8mb4",
    timezone: (record.options.timezone || "local") as ConnectionOptions["timezone"],
    connectTimeout: record.options.connectTimeoutMs ?? 10_000,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    decimalNumbers: false,
    rowsAsArray: false,
  };
  if (stream) options.stream = stream;
  if (ssl?.enabled) {
    options.ssl = {
      rejectUnauthorized: ssl.rejectUnauthorized !== false,
      ca: ssl.ca || undefined,
      cert: ssl.certificate || undefined,
      key: ssl.privateKey || undefined,
      passphrase: ssl.passphrase || undefined,
    };
  }
  return options;
}

export async function connectDesktopDatabase(
  credential: DesktopDatabaseCredential,
  database?: string,
): Promise<ConnectedDesktopDatabase> {
  const record = credential.connection;
  if (record.connectionMode === "httpTunnel") {
    if (!record.options.httpTunnelUrl) throw new Error(tr("数据库连接没有配置 HTTP Tunnel URL"));
    const connection = new NavicatHttpTunnelConnection({
      url: record.options.httpTunnelUrl,
      host: record.host,
      port: record.port,
      username: record.username,
      password: record.password,
      database: (database ?? record.defaultDatabase) || "",
      timeoutMs: record.options.connectTimeoutMs ?? 10_000,
      basicAuthUsername: record.httpTunnelUsername,
      basicAuthPassword: record.httpTunnelPassword,
      rejectUnauthorized: record.options.httpTunnelRejectUnauthorized !== false,
    });
    return { connection, credential, close: () => connection.end() };
  }

  let ssh: ConnectedDesktopSsh | undefined;
  try {
    let stream: ClientChannel | undefined;
    if (record.connectionMode === "sshTunnel") {
      if (!credential.sshCredential) throw new Error(tr("数据库连接缺少 SSH Tunnel 凭据"));
      ssh = await connectDesktopSsh(credential.sshCredential);
      stream = await forward(ssh.client, record.host, record.port);
    }
    const connection = await mysql.createConnection(mysqlOptions(credential, database, stream)) as DatabaseConnectionClient;
    return {
      connection,
      credential,
      close: async () => {
        try {
          await connection.end();
        } catch {
          connection.destroy();
        }
        ssh?.close();
      },
    };
  } catch (error) {
    ssh?.close();
    throw error;
  }
}

function safeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function safeRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") return { value: safeValue(row) };
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safeValue(value)]));
}

function resultSet(rows: unknown, fields: FieldPacket[] | undefined): DesktopDatabaseQueryResultSet {
  if (Array.isArray(rows)) {
    return {
      columns: (fields ?? []).map((field) => ({ name: field.name, table: field.table, type: field.type ?? 0 })),
      rows: rows.slice(0, MAX_RESULT_ROWS).map(safeRow),
      affectedRows: 0,
      insertId: 0,
      info: "",
      truncated: rows.length > MAX_RESULT_ROWS,
    };
  }
  const header = rows as Partial<ResultSetHeader> | undefined;
  return {
    columns: [],
    rows: [],
    affectedRows: Number(header?.affectedRows ?? 0),
    insertId: Number(header?.insertId ?? 0),
    info: String(header?.info ?? ""),
    truncated: false,
  };
}

function normalizeResults(rows: unknown, fields: unknown): DesktopDatabaseQueryResultSet[] {
  if (
    Array.isArray(rows)
    && Array.isArray(fields)
    && rows.length === fields.length
    && fields.some((item) => item === undefined || Array.isArray(item))
  ) {
    return rows.map((item, index) => resultSet(item, Array.isArray(fields[index]) ? fields[index] as FieldPacket[] : undefined));
  }
  return [resultSet(rows, fields as FieldPacket[] | undefined)];
}

function parsedJson(request: DesktopDatabaseRequest): Record<string, unknown> {
  if (request.body?.kind !== "text") return {};
  try {
    const value = JSON.parse(request.body.value ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new DesktopDatabaseError(400, "INVALID_BODY", tr("请求内容不是有效 JSON"));
  }
}

function requiredString(value: unknown, label: string, max = 255): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new DesktopDatabaseError(400, "INVALID_REQUEST", tr("{{0}}无效", [label]));
  }
  return value.trim();
}

function optionalString(value: unknown, max = 255): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) throw new DesktopDatabaseError(400, "INVALID_REQUEST", tr("请求参数无效"));
  return value.trim();
}

function optionalBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new DesktopDatabaseError(400, "INVALID_REQUEST", tr("请求参数无效"));
  return value;
}

function positiveInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function publicJob(job: ManagedQueryJob): DesktopDatabaseQueryJob {
  return {
    id: job.id,
    connectionId: job.connectionId,
    connectionName: job.connectionName,
    database: job.database,
    sql: job.sql,
    continueOnError: job.continueOnError,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: job.durationMs,
    error: job.error,
    resultSets: job.resultSets,
  };
}

function isCancelled(job: ManagedQueryJob): boolean {
  return job.cancelRequested === true;
}

export function isDesktopDatabaseExecutionPath(path: string): boolean {
  const pathname = new URL(path, "http://desktop.local").pathname;
  return /^\/api\/v1\/database-connections\/[^/]+\/(?:test|schemas|objects|completion-metadata|ddl|queries(?:\/batch)?|table-design|table-data(?:\/(?:changes|suggestions))?)$/.test(pathname)
    || /^\/api\/v1\/database-queries\/[^/]+$/.test(pathname);
}

export class DesktopDatabaseRuntime {
  private readonly jobs = new Map<string, ManagedQueryJob>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly connectionPool: IdleResourcePool<{ context: DesktopSshContext; connected: ConnectedDesktopDatabase; usable: boolean }>;

  constructor(
    private readonly loadCredential: (connectionId: string) => Promise<{ context: DesktopSshContext; credential: DesktopDatabaseCredential }>,
    private readonly report: (report: DesktopDatabaseExecutionReport, context?: DesktopSshContext) => Promise<void>,
    private readonly connectDatabase: typeof connectDesktopDatabase = connectDesktopDatabase,
  ) {
    this.connectionPool = new IdleResourcePool({
      maxIdlePerKey: 2,
      usable: (resource) => resource.usable,
      dispose: (resource) => resource.connected.close(),
    });
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60_000);
    this.cleanupTimer.unref();
  }

  async handle(request: DesktopDatabaseRequest, context: DesktopSshContext): Promise<DesktopDatabaseResponse> {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      const url = new URL(request.path, "http://desktop.local");
      const connectionRoute = url.pathname.match(/^\/api\/v1\/database-connections\/([0-9a-f-]+)\/(test|schemas|objects|completion-metadata|ddl|queries(?:\/batch)?|table-design|table-data(?:\/(?:changes|suggestions))?)$/i);
      if (connectionRoute) {
        const connectionId = connectionRoute[1];
        const action = connectionRoute[2];
        if (action === "test" && method === "POST") return jsonResponse(200, await this.testConnection(connectionId));
        if (action === "schemas" && method === "GET") return jsonResponse(200, await this.schemas(connectionId));
        if (action === "objects" && method === "GET") return jsonResponse(200, await this.objects(connectionId, url));
        if (action === "completion-metadata" && method === "GET") return jsonResponse(200, await this.completionMetadata(connectionId, url));
        if (action === "ddl" && method === "GET") return jsonResponse(200, await this.ddl(connectionId, url));
        if (action === "table-design" && method === "GET") return jsonResponse(200, await this.tableDesign(connectionId, url));
        if (action === "table-data" && method === "GET") return jsonResponse(200, await this.tableData(connectionId, url));
        if (action === "table-data/suggestions" && method === "GET") return jsonResponse(200, await this.tableDataSuggestions(connectionId, url));
        if (action === "table-data/changes" && method === "POST") return jsonResponse(200, await this.tableChanges(connectionId, parsedJson(request)));
        if (action === "queries/batch" && method === "POST") return jsonResponse(200, await this.readBatch(connectionId, parsedJson(request)));
        if (action === "queries" && method === "POST") return jsonResponse(202, { job: await this.createQuery(connectionId, parsedJson(request)) });
      }
      const queryRoute = url.pathname.match(/^\/api\/v1\/database-queries\/([0-9a-f-]+)$/i);
      if (queryRoute && method === "GET") return jsonResponse(200, { job: this.getQuery(queryRoute[1], context) });
      if (queryRoute && method === "DELETE") {
        this.cancelQuery(queryRoute[1], context);
        return jsonResponse(204);
      }
      return jsonResponse(404, { error: "NOT_FOUND", message: tr("本机数据库操作不存在") });
    } catch (error) {
      const known = error instanceof DesktopDatabaseError;
      const failure = desktopDatabaseFailure(error);
      return jsonResponse(known ? error.status : 502, {
        error: known ? error.code : failure.code,
        message: known ? error.message : failure.message,
      });
    }
  }

  async closeConnection(connectionId: string, reason = tr("数据库连接配置已更新")): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.connectionId === connectionId && ["pending", "running"].includes(job.status)) this.cancelManagedJob(job, reason);
    }
    await this.connectionPool.invalidate((key) => key.startsWith(`${connectionId}\0`));
  }

  activeCount(): number {
    return [...this.jobs.values()].filter((job) => ["pending", "running"].includes(job.status)).length;
  }

  async agentContext(input: AgentDatabaseContextInput, context: DesktopSshContext): Promise<AgentDatabaseContextSnapshot> {
    const session = await this.connect(input.connectionId, input.database || undefined);
    if (contextKey(session.context) !== contextKey(context)) {
      await session.connected.close();
      throw new Error(tr("数据库现场不属于当前用户或 Endpoint"));
    }
    const connected = session.connected;
    try {
      const [objects] = await connected.connection.query<RowDataPacket[]>(`
        SELECT TABLE_NAME AS name, TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME LIMIT 50
      `, [input.database]);
      const names = objects.map((row) => String(row.name));
      const columns = names.length ? (await connected.connection.query<RowDataPacket[]>(`
        SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, DATA_TYPE AS dataType
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${names.map(() => "?").join(",")})
        ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 300
      `, [input.database, ...names]))[0] : [];
      const sanitized = sanitizeAgentDatabaseInput(input);
      return agentDatabaseContextSnapshot({
        connectionId: input.connectionId,
        connectionName: connected.credential.connection.name,
        database: input.database,
        schema: objects.map((object) => ({
          name: String(object.name),
          type: String(object.type) === "VIEW" ? "view" as const : "table" as const,
          columns: columns.filter((column) => String(column.tableName) === String(object.name)).map((column) => ({ name: String(column.name), dataType: String(column.dataType) })),
        })),
        ...sanitized,
        truncated: sanitized.truncated || objects.length >= 50 || columns.length >= 300,
      });
    } finally {
      await connected.close();
    }
  }

  async agentReadQuery(connectionId: string, database: string, inputSql: string, context: DesktopSshContext, abortSignal?: AbortSignal): Promise<AgentDatabaseReadResult> {
    const sql = assertAgentReadOnlySql(inputSql);
    const session = await this.connect(connectionId, database || undefined);
    if (contextKey(session.context) !== contextKey(context)) {
      await session.connected.close();
      throw new Error(tr("数据库现场不属于当前用户或 Endpoint"));
    }
    const connected = session.connected;
    const started = Date.now();
    const abortQuery = () => connected.connection.destroy();
    if (abortSignal?.aborted) {
      abortQuery();
      throw new Error(String(abortSignal.reason ?? tr("Viron Agent 数据库查询已取消")));
    }
    abortSignal?.addEventListener("abort", abortQuery, { once: true });
    if (abortSignal?.aborted) abortQuery();
    try {
      const querySql = /^EXPLAIN\b/i.test(sql) ? sql : `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS viron_agent_read LIMIT 101`;
      const [rows, fields] = await connected.connection.query<RowDataPacket[]>(querySql);
      const preview = sanitizeAgentDatabaseInput({ connectionId, database, editorSql: "", selectedSql: "", resultPreview: rows.slice(0, 100).map(safeRow) }, 100).resultPreview;
      return {
        connectionId,
        connectionName: connected.credential.connection.name,
        database,
        sql,
        columns: (fields ?? []).map((field) => field.name),
        rows: preview,
        rowCount: preview.length,
        truncated: rows.length > preview.length,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (abortSignal?.aborted) throw new Error(String(abortSignal.reason ?? tr("Viron Agent 数据库查询已取消")));
      throw error;
    } finally {
      abortSignal?.removeEventListener("abort", abortQuery);
      await connected.close();
    }
  }

  async agentWriteQuery(connectionId: string, database: string, inputSql: string, context: DesktopSshContext, abortSignal?: AbortSignal): Promise<AgentDatabaseReadResult> {
    const sql = assertAgentWriteSql(inputSql);
    const session = await this.connect(connectionId, database || undefined);
    if (contextKey(session.context) !== contextKey(context)) {
      await session.connected.close();
      throw new Error(tr("数据库现场不属于当前用户或 Endpoint"));
    }
    const connected = session.connected;
    const started = Date.now();
    const abortQuery = () => connected.connection.destroy();
    if (abortSignal?.aborted) {
      abortQuery();
      throw new Error(String(abortSignal.reason ?? tr("Viron Agent 数据库写操作已取消")));
    }
    abortSignal?.addEventListener("abort", abortQuery, { once: true });
    if (abortSignal?.aborted) abortQuery();
    try {
      const [result] = await connected.connection.query(sql);
      const header = Array.isArray(result) ? undefined : result as Partial<ResultSetHeader>;
      const affectedRows = Number(header?.affectedRows ?? 0);
      const insertId = header?.insertId === undefined ? null : header.insertId;
      return {
        connectionId,
        connectionName: connected.credential.connection.name,
        database,
        sql,
        columns: ["affectedRows", "insertId"],
        rows: [{ affectedRows, insertId }],
        rowCount: affectedRows,
        truncated: false,
        durationMs: Date.now() - started,
        affectedRows,
        insertId,
      };
    } catch (error) {
      if (abortSignal?.aborted) throw new Error(String(abortSignal.reason ?? tr("Viron Agent 数据库写操作已取消")));
      throw error;
    } finally {
      abortSignal?.removeEventListener("abort", abortQuery);
      await connected.close();
    }
  }

  connectionIdForQuery(id: string, context: DesktopSshContext): string | null {
    const job = this.jobs.get(id);
    return job && contextKey(job.context) === contextKey(context) ? job.connectionId : null;
  }

  async closeContext(context: DesktopSshContext, reason: string): Promise<void> {
    const key = contextKey(context);
    for (const job of this.jobs.values()) {
      if (contextKey(job.context) === key && ["pending", "running"].includes(job.status)) this.cancelManagedJob(job, reason);
    }
    await this.connectionPool.invalidate((_poolKey, resource) => contextKey(resource.context) === key);
  }

  async closeAll(reason = tr("Viron App 正在退出")): Promise<void> {
    for (const job of this.jobs.values()) {
      if (["pending", "running"].includes(job.status)) this.cancelManagedJob(job, reason);
    }
    await this.connectionPool.invalidate();
  }

  private async connect(connectionId: string, database?: string): Promise<{ context: DesktopSshContext; connected: ConnectedDesktopDatabase }> {
    const key = `${connectionId}\0${database ?? ""}`;
    const lease = await this.connectionPool.acquire(key, async () => {
      const loaded = await this.loadCredential(connectionId);
      return { context: loaded.context, connected: await this.connectDatabase(loaded.credential, database), usable: true };
    });
    const pooled = lease.resource;
    const call = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        pooled.usable = false;
        throw error;
      }
    };
    const connection: DatabaseConnectionClient = {
      query: (sql, values) => call(() => pooled.connected.connection.query(sql, values)),
      beginTransaction: () => call(() => pooled.connected.connection.beginTransaction()),
      commit: () => call(() => pooled.connected.connection.commit()),
      rollback: () => call(() => pooled.connected.connection.rollback()),
      escape: (value) => pooled.connected.connection.escape(value),
      end: async () => { await lease.release(!pooled.usable); },
      destroy: () => {
        pooled.usable = false;
        pooled.connected.connection.destroy();
      },
    };
    return {
      context: pooled.context,
      connected: {
        connection,
        credential: pooled.connected.credential,
        close: async () => { await lease.release(!pooled.usable); },
      },
    };
  }

  private async testConnection(connectionId: string) {
    const started = Date.now();
    let reportContext: DesktopSshContext | undefined;
    try {
      const { context, connected } = await this.connect(connectionId);
      reportContext = context;
      try {
        const [rows] = await connected.connection.query<RowDataPacket[]>("SELECT VERSION() AS version, CONNECTION_ID() AS connectionId");
        const latencyMs = Date.now() - started;
        await this.report({
          kind: "operation",
          operationId: randomUUID(),
          connectionId,
          action: "connection_tested",
          summary: tr("本机数据库连接测试成功 {{0}}", [connected.credential.connection.name]),
          details: { latencyMs, version: rows[0]?.version },
        }, context);
        return { ok: true, latencyMs, version: String(rows[0]?.version ?? ""), connectionId: String(rows[0]?.connectionId ?? "") };
      } finally {
        await connected.close();
      }
    } catch (error) {
      await this.report({
        kind: "operation",
        operationId: randomUUID(),
        connectionId,
        action: "connection_test_failed",
        summary: tr("本机数据库连接测试失败"),
        details: { message: desktopDatabaseErrorMessage(error), latencyMs: Date.now() - started },
      }, reportContext).catch(() => undefined);
      throw error;
    }
  }

  private async schemas(connectionId: string) {
    const { connected } = await this.connect(connectionId);
    try {
      const [rows] = await connected.connection.query<RowDataPacket[]>(`
        SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset,
          DEFAULT_COLLATION_NAME AS collation
        FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME
      `);
      return { items: rows.map((row) => ({ name: String(row.name), charset: String(row.charset), collation: String(row.collation) })) };
    } finally {
      await connected.close();
    }
  }

  private async objects(connectionId: string, url: URL) {
    const database = requiredString(url.searchParams.get("database"), tr("数据库"));
    const category = url.searchParams.get("category") as ObjectCategory | null;
    if (!category || !["tables", "views", "procedures", "functions", "triggers", "events"].includes(category)) {
      throw new DesktopDatabaseError(400, "INVALID_OBJECT_QUERY", tr("请选择数据库和对象分类"));
    }
    const { context, connected } = await this.connect(connectionId, database);
    try {
      let sql = "";
      let values: unknown[] = [database];
      if (category === "tables" || category === "views") {
        sql = `SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount, DATA_LENGTH + INDEX_LENGTH AS dataSize,
          ENGINE AS engine, CREATE_TIME AS createdAt, UPDATE_TIME AS updatedAt,
          TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
          FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME`;
        values = [database, category === "tables" ? "BASE TABLE" : "VIEW"];
      } else if (category === "procedures" || category === "functions") {
        sql = `SELECT ROUTINE_NAME AS name, CREATED AS createdAt, LAST_ALTERED AS updatedAt, ROUTINE_COMMENT AS comment
          FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME`;
        values = [database, category === "procedures" ? "PROCEDURE" : "FUNCTION"];
      } else if (category === "triggers") {
        sql = `SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS tableName,
          ACTION_TIMING AS timing, CREATED AS createdAt FROM information_schema.TRIGGERS
          WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`;
      } else {
        sql = `SELECT EVENT_NAME AS name, STATUS AS status, EVENT_TYPE AS eventType, INTERVAL_VALUE AS intervalValue,
          INTERVAL_FIELD AS intervalField, CREATED AS createdAt FROM information_schema.EVENTS
          WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`;
      }
      const [rows] = await connected.connection.query<RowDataPacket[]>(sql, values);
      return { items: rows.map(safeRow) };
    } finally {
      await connected.close();
    }
  }

  private async completionMetadata(connectionId: string, url: URL) {
    const database = requiredString(url.searchParams.get("database"), tr("数据库"));
    const { connected } = await this.connect(connectionId, database);
    try {
      const [tableRows] = await connected.connection.query<RowDataPacket[]>(`
        SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME
      `, [database]);
      const objectTypes = new Map(tableRows.map((row) => [String(row.TABLE_NAME), String(row.TABLE_TYPE) === "VIEW" ? "view" as const : "table" as const]));
      const [columnRows] = await connected.connection.query<RowDataPacket[]>(`
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, ORDINAL_POSITION
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `, [database]);
      const objects = new Map<string, { name: string; type: "table" | "view"; columns: Array<{ name: string; dataType: string; columnType: string }> }>();
      for (const row of columnRows) {
        const name = String(row.TABLE_NAME);
        const object = objects.get(name) ?? { name, type: objectTypes.get(name) ?? "table", columns: [] };
        object.columns.push({ name: String(row.COLUMN_NAME), dataType: String(row.DATA_TYPE), columnType: String(row.COLUMN_TYPE) });
        objects.set(name, object);
      }
      const [routineRows] = await connected.connection.query<RowDataPacket[]>(`
        SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME
      `, [database]);
      return {
        database,
        objects: [...objects.values()],
        routines: routineRows.map((row) => ({ name: String(row.ROUTINE_NAME), type: String(row.ROUTINE_TYPE).toUpperCase() === "PROCEDURE" ? "procedure" : "function" })),
      };
    } finally {
      await connected.close();
    }
  }

  private async ddl(connectionId: string, url: URL) {
    const database = requiredString(url.searchParams.get("database"), tr("数据库"));
    const name = requiredString(url.searchParams.get("name"), tr("数据库对象名称"));
    const type = url.searchParams.get("type") ?? "";
    const showTypes: Record<string, string> = {
      table: "TABLE",
      view: "VIEW",
      procedure: "PROCEDURE",
      function: "FUNCTION",
      trigger: "TRIGGER",
      event: "EVENT",
    };
    if (!showTypes[type]) throw new DesktopDatabaseError(400, "INVALID_DDL_QUERY", tr("数据库对象参数不完整"));
    const { context, connected } = await this.connect(connectionId, database);
    try {
      const [rows] = await connected.connection.query<RowDataPacket[]>(
        `SHOW CREATE ${showTypes[type]} ${identifier(database)}.${identifier(name)}`,
      );
      const row = rows[0];
      const ddl = row
        ? Object.entries(row).find(([key, value]) => key.toLowerCase().includes("create") && typeof value === "string")?.[1]
        : undefined;
      return { ddl: String(ddl ?? "") };
    } finally {
      await connected.close();
    }
  }

  private async tableDesign(connectionId: string, url: URL) {
    const database = requiredString(url.searchParams.get("database"), tr("数据库"));
    const table = requiredString(url.searchParams.get("table"), tr("数据表"));
    const { connected } = await this.connect(connectionId, database);
    try {
      const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(database)}.${identifier(table)}`);
      const createDdl = createStatement(createRows);
      const [columnRows] = await connected.connection.query<RowDataPacket[]>(`
        SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA,
          COLUMN_COMMENT, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
          DATETIME_PRECISION, GENERATION_EXPRESSION, CHARACTER_SET_NAME, COLLATION_NAME, ORDINAL_POSITION
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [database, table]);
      if (!columnRows.length) throw new DesktopDatabaseError(404, "TABLE_NOT_FOUND", tr("数据表不存在"));
      const fields = columnRows.map((row) => {
        const dataType = String(row.DATA_TYPE).toUpperCase();
        const columnType = String(row.COLUMN_TYPE);
        const extra = String(row.EXTRA ?? "");
        let length = "";
        let decimals = "";
        if (["VARCHAR", "CHAR", "BINARY", "VARBINARY", "BIT"].includes(dataType)) length = String(row.CHARACTER_MAXIMUM_LENGTH ?? columnType.match(/\((\d+)\)/)?.[1] ?? "");
        else if (["DECIMAL", "DOUBLE", "FLOAT"].includes(dataType)) {
          length = String(row.NUMERIC_PRECISION ?? "");
          decimals = String(row.NUMERIC_SCALE ?? "");
        } else if (["DATETIME", "TIMESTAMP", "TIME"].includes(dataType) && row.DATETIME_PRECISION !== null) length = String(row.DATETIME_PRECISION);
        else if (["ENUM", "SET"].includes(dataType)) length = columnType.replace(/^[^(]+\(|\)$/g, "");
        const defaultValue = row.COLUMN_DEFAULT;
        const defaultGenerated = /DEFAULT_GENERATED/i.test(extra);
        const generated = Boolean(String(row.GENERATION_EXPRESSION ?? "").trim()) || /VIRTUAL GENERATED|STORED GENERATED/i.test(extra);
        const onUpdateExpression = extra.match(/on update\s+(.+?)(?:\s+DEFAULT_GENERATED)?$/i)?.[1] ?? "";
        const definition = columnDefinition(createDdl, String(row.COLUMN_NAME));
        return {
          originalName: String(row.COLUMN_NAME),
          name: String(row.COLUMN_NAME),
          type: dataType,
          length,
          decimals,
          notNull: row.IS_NULLABLE === "NO",
          primaryKey: row.COLUMN_KEY === "PRI",
          unsigned: /\bunsigned\b/i.test(columnType),
          zerofill: /\bzerofill\b/i.test(columnType) || /\bZEROFILL\b/i.test(definition),
          charset: String(row.CHARACTER_SET_NAME ?? ""),
          collation: String(row.COLLATION_NAME ?? ""),
          binary: /\bBINARY\b/i.test(definition),
          columnFormat: (definition.match(/\bCOLUMN_FORMAT\s+(DEFAULT|FIXED|DYNAMIC)\b/i)?.[1] ?? "").toUpperCase(),
          storage: (definition.match(/\bSTORAGE\s+(DEFAULT|DISK|MEMORY)\b/i)?.[1] ?? "").toUpperCase(),
          keyLength: primaryKeyLength(createDdl, String(row.COLUMN_NAME)),
          autoIncrement: /auto_increment/i.test(extra),
          defaultKind: generated ? "none" : defaultValue === null ? (row.IS_NULLABLE === "YES" ? "null" : "none") : defaultGenerated || /^(?:CURRENT_|LOCALTIME|LOCALTIMESTAMP)/i.test(String(defaultValue)) ? "expression" : "value",
          defaultValue: defaultValue === null ? "" : String(defaultValue),
          comment: String(row.COLUMN_COMMENT ?? ""),
          generated,
          generatedExpression: String(row.GENERATION_EXPRESSION ?? ""),
          generatedStored: /STORED GENERATED/i.test(extra),
          onUpdateExpression,
        };
      });

      const [indexRows] = await connected.connection.query<RowDataPacket[]>(`SHOW INDEX FROM ${identifier(database)}.${identifier(table)}`);
      const indexGroups = new Map<string, RowDataPacket[]>();
      for (const row of indexRows) {
        const name = String(columnValue(row, "Key_name", "KEY_NAME") ?? "");
        if (!name || name === "PRIMARY") continue;
        indexGroups.set(name, [...(indexGroups.get(name) ?? []), row]);
      }
      const indexes = [...indexGroups.entries()].map(([name, rows]) => {
        rows.sort((left, right) => Number(columnValue(left, "Seq_in_index", "SEQ_IN_INDEX") ?? 0) - Number(columnValue(right, "Seq_in_index", "SEQ_IN_INDEX") ?? 0));
        const first = rows[0];
        const indexType = String(columnValue(first, "Index_type", "INDEX_TYPE") ?? "BTREE").toUpperCase();
        const definition = indexDefinition(createDdl, name);
        const indexKeyBlockSize = definition.match(/\bKEY_BLOCK_SIZE\s*=\s*(\d+)/i)?.[1];
        return {
          originalName: name,
          name,
          type: indexType === "FULLTEXT" ? "FULLTEXT" : Number(columnValue(first, "Non_unique", "NON_UNIQUE") ?? 1) === 0 ? "UNIQUE" : "INDEX",
          columns: rows.map((row) => String(columnValue(row, "Column_name", "COLUMN_NAME") ?? "")).filter(Boolean),
          columnSettings: Object.fromEntries(rows.flatMap((row) => {
            const column = String(columnValue(row, "Column_name", "COLUMN_NAME") ?? "");
            return column ? [[column, { length: String(columnValue(row, "Sub_part", "SUB_PART") ?? ""), order: String(columnValue(row, "Collation", "COLLATION") ?? "") === "D" ? "DESC" : String(columnValue(row, "Collation", "COLLATION") ?? "") === "A" ? "ASC" : "" }]] : [];
          })),
          method: indexType === "HASH" ? "HASH" : "BTREE",
          comment: String(columnValue(first, "Index_comment", "INDEX_COMMENT") ?? ""),
          collation: String(columnValue(first, "Collation", "COLLATION") ?? "") === "D" ? "DESC" : "",
          cardinality: String(columnValue(first, "Cardinality", "CARDINALITY") ?? ""),
          packed: !["", "NULL", "NO", "0"].includes(String(columnValue(first, "Packed", "PACKED") ?? "").toUpperCase()),
          keyBlockSize: indexKeyBlockSize ? Number(indexKeyBlockSize) : null,
          parser: definition.match(/\bWITH\s+PARSER\s+`?([^`\s]+)`?/i)?.[1] ?? "",
          invisible: String(columnValue(first, "Visible", "VISIBLE") ?? "YES").toUpperCase() === "NO" || /\bINVISIBLE\b/i.test(definition),
        };
      });

      const parsedConstraints = parseCreateTableConstraints(createDdl, database);
      let foreignKeys = parsedConstraints.foreignKeys;
      if (!parsedConstraints.foreignKeysComplete) {
        const [foreignKeyRows] = await connected.connection.query<RowDataPacket[]>(`
          SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
            k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION, r.UPDATE_RULE, r.DELETE_RULE
          FROM information_schema.KEY_COLUMN_USAGE k
          JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION
        `, [database, table]);
        const foreignKeyGroups = new Map<string, RowDataPacket[]>();
        for (const row of foreignKeyRows) foreignKeyGroups.set(String(row.CONSTRAINT_NAME), [...(foreignKeyGroups.get(String(row.CONSTRAINT_NAME)) ?? []), row]);
        foreignKeys = [...foreignKeyGroups.entries()].map(([name, rows]) => ({
          originalName: name,
          name,
          columns: rows.map((row) => String(row.COLUMN_NAME)),
          referencedDatabase: String(rows[0].REFERENCED_TABLE_SCHEMA ?? database),
          referencedTable: String(rows[0].REFERENCED_TABLE_NAME),
          referencedColumns: rows.map((row) => String(row.REFERENCED_COLUMN_NAME)),
          onDelete: String(rows[0].DELETE_RULE ?? "RESTRICT") as "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION",
          onUpdate: String(rows[0].UPDATE_RULE ?? "RESTRICT") as "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION",
        }));
      }

      let checks: Array<{ originalName: string; name: string; expression: string }> = parsedConstraints.checks;
      if (!parsedConstraints.checksComplete) {
        try {
          const [checkRows] = await connected.connection.query<RowDataPacket[]>(`
            SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc
            JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
            WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY tc.CONSTRAINT_NAME
          `, [database, table]);
          checks = checkRows.map((row) => ({ originalName: String(row.CONSTRAINT_NAME), name: String(row.CONSTRAINT_NAME), expression: String(row.CHECK_CLAUSE ?? "") }));
        } catch {
          checks = [];
        }
      }
      const [triggerRows] = await connected.connection.query<RowDataPacket[]>(`
        SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME
      `, [database, table]);
      const triggers = triggerRows.map((row) => ({ originalName: String(row.TRIGGER_NAME), name: String(row.TRIGGER_NAME), timing: String(row.ACTION_TIMING), event: String(row.EVENT_MANIPULATION), statement: String(row.ACTION_STATEMENT ?? "") }));
      const [statusRows] = await connected.connection.query<RowDataPacket[]>(`SHOW TABLE STATUS FROM ${identifier(database)} LIKE ?`, [table]);
      const status = statusRows[0] ?? {} as RowDataPacket;
      const createOptions = `${String(columnValue(status, "Create_options", "CREATE_OPTIONS") ?? "")} ${createDdl}`;
      const keyBlockSize = createOptions.match(/key_block_size=(\d+)/i)?.[1];
      const partition = createDdl.match(/\bPARTITION BY\s+([\s\S]+)$/i)?.[1]?.replace(/\/\*![0-9]+\s*/g, "").replace(/\*\/$/, "").trim() ?? "";
      return {
        design: {
          database,
          tableName: table,
          fields,
          indexes,
          foreignKeys,
          checks,
          triggers,
          options: {
            engine: String(columnValue(status, "Engine", "ENGINE") ?? "InnoDB"),
            charset: String(columnValue(status, "Collation", "COLLATION") ?? "utf8mb4").split("_")[0],
            collation: String(columnValue(status, "Collation", "COLLATION") ?? ""),
            rowFormat: String(columnValue(status, "Row_format", "ROW_FORMAT") ?? "").toUpperCase(),
            autoIncrement: columnValue(status, "Auto_increment", "AUTO_INCREMENT") === null ? null : Number(columnValue(status, "Auto_increment", "AUTO_INCREMENT")),
            tablespace: createDdl.match(/\bTABLESPACE\s+`?([^`\s]+)`?/i)?.[1] ?? "",
            minRows: Number(columnValue(status, "Min_rows", "MIN_ROWS") ?? 0) || null,
            averageRowLength: Number(columnValue(status, "Avg_row_length", "AVG_ROW_LENGTH") ?? 0) || null,
            keyBlockSize: keyBlockSize ? Number(keyBlockSize) : null,
            maxRows: Number(columnValue(status, "Max_rows", "MAX_ROWS") ?? 0) || null,
            partition,
            dataDirectory: ddlString(createDdl, "DATA\\s+DIRECTORY"),
            indexDirectory: ddlString(createDdl, "INDEX\\s+DIRECTORY"),
            delayKeyWrite: ddlBoolean(createOptions, "DELAY_KEY_WRITE"),
            packKeys: ddlToken(createOptions, "PACK_KEYS"),
            checksum: ddlBoolean(createOptions, "CHECKSUM"),
            pageChecksum: ddlBoolean(createOptions, "PAGE_CHECKSUM"),
            connection: ddlString(createDdl, "CONNECTION"),
            encryption: ddlString(createDdl, "ENCRYPTION").toUpperCase(),
            unionTables: createDdl.match(/\bUNION\s*=\s*\(([^)]*)\)/i)?.[1]?.trim() ?? "",
            insertMethod: ddlToken(createDdl, "INSERT_METHOD"),
            statsPersistent: ddlToken(createOptions, "STATS_PERSISTENT"),
            statsAutoRecalc: ddlToken(createOptions, "STATS_AUTO_RECALC"),
            statsSamplePages: ddlNumber(createOptions, "STATS_SAMPLE_PAGES"),
            transactional: ddlBoolean(createOptions, "TRANSACTIONAL"),
          },
          comment: String(columnValue(status, "Comment", "COMMENT") ?? ""),
        },
      };
    } finally {
      await connected.close();
    }
  }

  private async tableColumns(connection: DatabaseConnectionClient, database: string, table: string) {
    const [rows] = await connection.query<RowDataPacket[]>(`
      SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
        COLUMN_KEY, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [database, table]);
    return rows.map((row) => ({
      name: String(row.COLUMN_NAME),
      columnType: String(row.COLUMN_TYPE),
      dataType: String(row.DATA_TYPE),
      nullable: row.IS_NULLABLE === "YES",
      defaultValue: safeValue(row.COLUMN_DEFAULT),
      primary: row.COLUMN_KEY === "PRI",
      unique: row.COLUMN_KEY === "UNI",
      autoIncrement: String(row.EXTRA).includes("auto_increment"),
      comment: String(row.COLUMN_COMMENT ?? ""),
    }));
  }

  private async tableData(connectionId: string, url: URL) {
    const database = requiredString(url.searchParams.get("database"), tr("数据库"));
    const table = requiredString(url.searchParams.get("table"), tr("数据表"));
    const page = positiveInteger(url.searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = positiveInteger(url.searchParams.get("pageSize"), 100, 20, 500);
    const { connected } = await this.connect(connectionId, database);
    try {
      const columns = await this.tableColumns(connected.connection, database, table);
      if (!columns.length) throw new DesktopDatabaseError(404, "TABLE_NOT_FOUND", tr("数据表不存在"));
      const rules = parseTableDataQueryRules(url.searchParams, columns.map((column) => column.name));
      const clauses = buildTableDataClauses(rules.filters, rules.sorts, columns[0].name);
      const [countRows] = await connected.connection.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM ${identifier(database)}.${identifier(table)}${clauses.where}`,
        clauses.params,
      );
      const [rows] = await connected.connection.query<RowDataPacket[]>(
        `SELECT * FROM ${identifier(database)}.${identifier(table)}${clauses.where}${clauses.orderBy} LIMIT ? OFFSET ?`,
        [...clauses.params, pageSize, (page - 1) * pageSize],
      );
      return {
        columns,
        primaryKey: columns.filter((column) => column.primary).map((column) => column.name),
        page,
        pageSize,
        total: Number(countRows[0]?.total ?? 0),
        rows: rows.map(safeRow),
      };
    } finally {
      await connected.close();
    }
  }

  private async tableDataSuggestions(connectionId: string, url: URL) {
    const database = requiredString(url.searchParams.get("database"), tr("数据库"));
    const table = requiredString(url.searchParams.get("table"), tr("数据表"));
    const requestedColumn = requiredString(url.searchParams.get("column"), tr("筛选字段"));
    const search = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
    const limit = positiveInteger(url.searchParams.get("limit"), 50, 10, 100);
    const { connected } = await this.connect(connectionId, database);
    try {
      const columns = await this.tableColumns(connected.connection, database, table);
      const column = columns.find((candidate) => candidate.name === requestedColumn)?.name;
      if (!column) throw new DesktopDatabaseError(404, "TABLE_COLUMN_NOT_FOUND", tr("筛选字段不存在"));
      const expression = `CAST(${identifier(column)} AS CHAR)`;
      const searchSql = search ? ` AND ${expression} LIKE ?` : "";
      const params = search ? [`%${search}%`, limit] : [limit];
      const [rows] = await connected.connection.query<RowDataPacket[]>(
        `SELECT DISTINCT ${expression} AS value FROM ${identifier(database)}.${identifier(table)} WHERE ${identifier(column)} IS NOT NULL${searchSql} ORDER BY value LIMIT ?`,
        params,
      );
      return { items: rows.map((row) => String(row.value ?? "")) };
    } finally {
      await connected.close();
    }
  }

  private async tableChanges(connectionId: string, body: Record<string, unknown>) {
    const database = requiredString(body.database, tr("数据库"));
    const table = requiredString(body.table, tr("数据表"));
    const changes = body.changes;
    if (!Array.isArray(changes) || !changes.length || changes.length > 500) {
      throw new DesktopDatabaseError(400, "INVALID_CHANGES", tr("数据表变更无效"));
    }
    const { context, connected } = await this.connect(connectionId, database);
    let changed = 0;
    try {
      const columns = await this.tableColumns(connected.connection, database, table);
      const allowed = new Set(columns.map((column) => column.name));
      const primary = columns.filter((column) => column.primary).map((column) => column.name);
      if (!columns.length) throw new DesktopDatabaseError(404, "TABLE_NOT_FOUND", tr("数据表不存在"));
      await connected.connection.beginTransaction();
      try {
        for (const item of changes) {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new DesktopDatabaseError(400, "INVALID_CHANGES", tr("数据表变更无效"));
          const change = item as { type?: unknown; values?: unknown; key?: unknown };
          if (!["insert", "update", "delete"].includes(String(change.type))) throw new DesktopDatabaseError(400, "INVALID_CHANGES", tr("数据表变更类型无效"));
          const valuesObject = change.values && typeof change.values === "object" && !Array.isArray(change.values) ? change.values as Record<string, unknown> : {};
          const keyObject = change.key && typeof change.key === "object" && !Array.isArray(change.key) ? change.key as Record<string, unknown> : {};
          const values = Object.entries(valuesObject).filter(([key]) => allowed.has(key));
          if (change.type === "insert") {
            if (!values.length) continue;
            const sql = `INSERT INTO ${identifier(database)}.${identifier(table)} (${values.map(([key]) => identifier(key)).join(",")}) VALUES (${values.map(() => "?").join(",")})`;
            const [result] = await connected.connection.query(sql, values.map(([, value]) => value));
            changed += Number((result as { affectedRows?: number }).affectedRows ?? 0);
            continue;
          }
          if (!primary.length) throw new DesktopDatabaseError(400, "PRIMARY_KEY_REQUIRED", tr("没有主键的数据表不能直接修改或删除"));
          const keys = primary.map((key) => [key, keyObject[key]] as const);
          if (keys.some(([, value]) => value === undefined)) throw new DesktopDatabaseError(400, "INVALID_CHANGES", tr("修改数据缺少完整主键"));
          const where = keys.map(([key]) => `${identifier(key)} <=> ?`).join(" AND ");
          if (change.type === "delete") {
            const [result] = await connected.connection.query(
              `DELETE FROM ${identifier(database)}.${identifier(table)} WHERE ${where} LIMIT 1`,
              keys.map(([, value]) => value),
            );
            changed += Number((result as { affectedRows?: number }).affectedRows ?? 0);
          } else if (values.length) {
            const set = values.map(([key]) => `${identifier(key)} = ?`).join(",");
            const [result] = await connected.connection.query(
              `UPDATE ${identifier(database)}.${identifier(table)} SET ${set} WHERE ${where} LIMIT 1`,
              [...values.map(([, value]) => value), ...keys.map(([, value]) => value)],
            );
            changed += Number((result as { affectedRows?: number }).affectedRows ?? 0);
          }
        }
        await connected.connection.commit();
      } catch (error) {
        await connected.connection.rollback();
        throw error;
      }
      await this.report({
        kind: "operation",
        operationId: randomUUID(),
        connectionId,
        action: "table_data_changed",
        summary: tr("本机提交数据表变更 {{0}}.{{1}}", [database, table]),
        details: { changed, operations: changes.length },
      }, context);
      return { changed };
    } finally {
      await connected.close();
    }
  }

  private async readBatch(connectionId: string, body: Record<string, unknown>) {
    if (!Array.isArray(body.queries) || body.queries.length < 1 || body.queries.length > 20) {
      throw new DesktopDatabaseError(400, "INVALID_BATCH", tr("批量查询数量必须为 1–20 条"));
    }
    let queries: Array<{ database: string; sql: string }>;
    try {
      queries = body.queries.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(tr("批量查询参数无效"));
        const input = value as Record<string, unknown>;
        const database = typeof input.database === "string" ? input.database.trim() : "";
        if (database.length > 255) throw new Error(tr("数据库名称过长"));
        return { database, sql: assertMcpReadOnlySql(input.sql) };
      });
    } catch (error) {
      throw new DesktopDatabaseError(400, "DATABASE_BATCH_NOT_READ_ONLY", error instanceof Error ? error.message : tr("批量查询只允许只读 SQL"));
    }
    const started = Date.now();
    const items = [];
    let responseBytes = 0;
    let reportContext: DesktopSshContext | undefined;
    const connections = new Map<string, ConnectedDesktopDatabase>();
    try {
      for (let index = 0; index < queries.length; index += 1) {
        const queryStarted = Date.now();
        const database = queries[index].database;
        let connected = connections.get(database);
        try {
          if (!connected) {
            const session = await this.connect(connectionId, database || undefined);
            reportContext ??= session.context;
            connected = session.connected;
            connections.set(database, connected);
          }
          const [rows, fields] = await connected.connection.query<RowDataPacket[]>(queries[index].sql);
          const safeRows = Array.isArray(rows) ? rows.slice(0, 500).map(safeRow) : [];
          const item = {
            index, ok: true, database,
            columns: (fields ?? []).map((field) => ({ name: field.name, table: field.table, type: field.type ?? 0 })),
            rows: safeRows, rowCount: safeRows.length, truncated: Array.isArray(rows) && rows.length > safeRows.length,
            durationMs: Date.now() - queryStarted,
          };
          const itemBytes = Buffer.byteLength(JSON.stringify(item));
          if (responseBytes + itemBytes > MAX_BATCH_RESPONSE_BYTES) {
            items.push({ index, ok: false, database, error: tr("批量数据库响应累计超过 2 MiB 限制"), durationMs: Date.now() - queryStarted });
            break;
          }
          responseBytes += itemBytes;
          items.push(item);
        } catch (error) {
          if (connected) {
            connections.delete(database);
            await connected.close();
          }
          items.push({ index, ok: false, database, error: desktopDatabaseErrorMessage(error), durationMs: Date.now() - queryStarted });
        }
      }
    } finally {
      await Promise.all([...connections.values()].map((connected) => connected.close()));
    }
    await this.report({
      kind: "operation",
      operationId: randomUUID(),
      connectionId,
      action: "queries_read_batch",
      summary: tr("本机批量执行 {{0}} 条数据库只读查询", [queries.length]),
      details: { queryCount: queries.length, failedCount: items.filter((item) => !item.ok).length, responseBytes, durationMs: Date.now() - started },
    }, reportContext);
    return { items, responseBytes, durationMs: Date.now() - started, reusedConnection: queries.length > new Set(queries.map((query) => query.database)).size };
  }

  private async createQuery(connectionId: string, body: Record<string, unknown>): Promise<DesktopDatabaseQueryJob> {
    const sql = requiredString(body.sql, "SQL", 2 * 1024 * 1024);
    const database = optionalString(body.database);
    const continueOnError = optionalBoolean(body.continueOnError);
    const activeCount = [...this.jobs.values()].filter((job) => ["pending", "running"].includes(job.status)).length;
    if (activeCount >= QUERY_LIMIT) throw new DesktopDatabaseError(429, "QUERY_START_FAILED", tr("数据库查询已达到 {{0}} 个并发上限", [QUERY_LIMIT]));
    const session = await this.connect(connectionId, database || undefined);
    const job: ManagedQueryJob = {
      id: randomUUID(),
      context: session.context,
      connectionId,
      connectionName: session.connected.credential.connection.name,
      database,
      sql,
      continueOnError,
      status: "pending",
      createdAt: new Date().toISOString(),
      resultSets: [],
      active: session.connected,
    };
    this.jobs.set(job.id, job);
    void this.runQuery(job);
    return publicJob(job);
  }

  private getQuery(id: string, context: DesktopSshContext): DesktopDatabaseQueryJob {
    const job = this.jobs.get(id);
    if (!job || contextKey(job.context) !== contextKey(context)) {
      throw new DesktopDatabaseError(404, "QUERY_NOT_FOUND", tr("查询任务不存在或已过期"));
    }
    return publicJob(job);
  }

  private cancelQuery(id: string, context: DesktopSshContext): void {
    const job = this.jobs.get(id);
    if (!job || contextKey(job.context) !== contextKey(context)) {
      throw new DesktopDatabaseError(404, "QUERY_NOT_FOUND", tr("查询任务不存在或已过期"));
    }
    if (!["pending", "running"].includes(job.status) || job.reporting) {
      throw new DesktopDatabaseError(409, "QUERY_NOT_RUNNING", tr("查询已经结束或不存在"));
    }
    this.cancelManagedJob(job, tr("查询已由管理员取消"));
  }

  private cancelManagedJob(job: ManagedQueryJob, reason: string): void {
    job.cancelRequested = true;
    job.error = reason;
    job.active?.connection.destroy();
  }

  private async runQuery(job: ManagedQueryJob): Promise<void> {
    const started = Date.now();
    let finalStatus: "success" | "error" | "cancelled" = "error";
    job.status = "running";
    job.startedAt = new Date(started).toISOString();
    try {
      const active = job.active;
      if (!active) throw new Error(tr("数据库连接尚未建立"));
      if (isCancelled(job)) {
        finalStatus = "cancelled";
      } else if (!job.continueOnError) {
        const [rows, fields] = await active.connection.query(job.sql);
        if (isCancelled(job)) finalStatus = "cancelled";
        else {
          job.resultSets = normalizeResults(rows, fields);
          finalStatus = "success";
        }
      } else {
        const statements = splitSqlStatements(job.sql);
        let errors = 0;
        for (const statement of statements.length ? statements : [job.sql]) {
          if (isCancelled(job)) {
            finalStatus = "cancelled";
            break;
          }
          try {
            const [rows, fields] = await active.connection.query(statement);
            if (isCancelled(job)) {
              finalStatus = "cancelled";
              break;
            }
            job.resultSets.push(...normalizeResults(rows, fields).map((result) => ({ ...result, statement })));
          } catch (error) {
            if (isCancelled(job)) {
              finalStatus = "cancelled";
              break;
            }
            errors += 1;
            job.resultSets.push({
              columns: [],
              rows: [],
              affectedRows: 0,
              insertId: 0,
              info: "",
              truncated: false,
              statement,
              error: desktopDatabaseErrorMessage(error),
            });
          }
        }
        if (finalStatus !== "cancelled") finalStatus = errors ? "error" : "success";
        if (errors) job.error = tr("{{0}} 条语句执行失败，其余语句已继续执行", [errors]);
      }
    } catch (error) {
      if (isCancelled(job)) finalStatus = "cancelled";
      else {
        finalStatus = "error";
        job.error = desktopDatabaseErrorMessage(error);
      }
    } finally {
      await job.active?.close();
      job.active = undefined;
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.now() - started;
      const rowCount = job.resultSets.reduce((total, item) => total + item.rows.length + item.affectedRows, 0);
      job.reporting = true;
      await this.report({
        kind: "query",
        operationId: job.id,
        connectionId: job.connectionId,
        database: job.database,
        sql: job.sql,
        status: finalStatus,
        durationMs: job.durationMs,
        rowCount,
        error: job.error ?? "",
      }, job.context).catch(() => undefined);
      job.reporting = false;
      job.status = finalStatus;
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, job] of this.jobs) {
      if (job.completedAt && new Date(job.completedAt).getTime() < cutoff) this.jobs.delete(id);
    }
  }
}
