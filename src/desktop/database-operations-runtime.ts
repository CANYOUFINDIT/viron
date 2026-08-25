import { translate as tr } from "./i18n.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import ExcelJS from "exceljs";
import type { RowDataPacket } from "mysql2/promise";
import { parse as parseCsv } from "csv-parse/sync";
import {
  defaultDataSyncOptions,
  defaultStructureSyncOptions,
  executeDatabaseSync,
  previewDatabaseSync,
  type DatabaseSyncMode,
  type DatabaseSyncOptions,
} from "../database-sync.js";
import type { DesktopDatabaseCredential } from "./device-identity.js";
import {
  connectDesktopDatabase,
  type ConnectedDesktopDatabase,
  type DesktopDatabaseExecutionReport,
  type DesktopDatabaseRequest,
} from "./database-runtime.js";
import type { DesktopSshContext } from "./ssh-runtime.js";
import { contextKey } from "./ssh-context.js";
import { jsonResponse, type DesktopDatabaseResponse } from "./json-response.js";

export interface DesktopDatabaseDownload {
  filename: string;
  contentType: string;
  data: Buffer;
}

type DatabaseTaskType = "backup" | "restore" | "transfer" | "import";
type DatabaseTaskStatus = "pending" | "running" | "success" | "error" | "cancelled";

interface DatabaseTask {
  id: string;
  context: DesktopSshContext;
  type: DatabaseTaskType;
  connectionId: string | null;
  status: DatabaseTaskStatus;
  progress: number;
  title: string;
  details: Record<string, unknown>;
  logs: string[];
  outputPath: string | null;
  error: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  active: Set<ConnectedDesktopDatabase>;
}

interface StoredDatabaseTask extends Omit<DatabaseTask, "active"> {}

interface PublicDatabaseTask extends Omit<DatabaseTask, "active" | "outputPath" | "context"> {
  downloadable: boolean;
  outputFilename: string | null;
}

interface TransferOptions {
  sourceConnectionId: string;
  sourceDatabase: string;
  targetConnectionId: string;
  targetDatabase: string;
  includeStructure: boolean;
  includeData: boolean;
  includeObjects: boolean;
  dropExisting: boolean;
  tables?: string[];
}

interface SyncTaskOptions extends DatabaseSyncOptions {
  sourceConnectionId: string;
  targetConnectionId: string;
  selectedItems: string[];
}

type DesktopDatabaseOperationReport = Extract<DesktopDatabaseExecutionReport, { kind: "operation" }>;

class DesktopDatabaseOperationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_TABULAR_ROWS = 100_000;
const TASK_LOG_LIMIT = 500;
const TASK_LIMIT = 3;
const BACKUP_BOUNDARY = "\n-- ENVMAN_STATEMENT_BOUNDARY\n";

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function errorMessage(error: unknown): string {
  const value = error as { sqlMessage?: string; message?: string; code?: string };
  if (value.code === "ER_ACCESS_DENIED_ERROR") return tr("数据库认证失败，请检查用户名和密码");
  if (value.code === "ECONNREFUSED") return tr("数据库端口拒绝连接");
  if (value.code === "ETIMEDOUT" || value.code === "PROTOCOL_SEQUENCE_TIMEOUT") return tr("数据库连接或查询超时");
  return value.sqlMessage || value.message || String(error);
}

function requiredString(value: unknown, label: string, max = 255): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new DesktopDatabaseOperationError(400, "INVALID_REQUEST", tr("{{0}}无效", [label]));
  }
  return value.trim();
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function syncOptions(connectionId: string, body: Record<string, unknown>, requireSelection: boolean): SyncTaskOptions {
  const mode = body.mode === "data" || body.mode === "structure" ? body.mode as DatabaseSyncMode : null;
  if (!mode) throw new DesktopDatabaseOperationError(400, "INVALID_SYNC_MODE", tr("同步类型无效"));
  const dataBody = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const structureBody = body.structure && typeof body.structure === "object" && !Array.isArray(body.structure) ? body.structure as Record<string, unknown> : {};
  const dataDefaults = defaultDataSyncOptions();
  const structureDefaults = defaultStructureSyncOptions();
  const selectedItems = Array.isArray(body.selectedItems) ? body.selectedItems.map((value) => requiredString(value, tr("同步对象"), 1_000)) : [];
  if (requireSelection && !selectedItems.length) throw new DesktopDatabaseOperationError(400, "EMPTY_SYNC", tr("请选择要同步的对象"));
  const options: SyncTaskOptions = {
    mode,
    sourceConnectionId: connectionId,
    sourceDatabase: requiredString(body.sourceDatabase, tr("来源数据库")),
    targetConnectionId: requiredString(body.targetConnectionId, tr("目标连接")),
    targetDatabase: requiredString(body.targetDatabase, tr("目标数据库")),
    selectedItems,
    data: {
      insert: optionalBoolean(dataBody.insert, dataDefaults.insert),
      update: optionalBoolean(dataBody.update, dataDefaults.update),
      delete: optionalBoolean(dataBody.delete, dataDefaults.delete),
    },
    structure: {
      compareTables: optionalBoolean(structureBody.compareTables, structureDefaults.compareTables),
      comparePrimaryKeys: optionalBoolean(structureBody.comparePrimaryKeys, structureDefaults.comparePrimaryKeys),
      compareForeignKeys: optionalBoolean(structureBody.compareForeignKeys, structureDefaults.compareForeignKeys),
      compareIndexes: optionalBoolean(structureBody.compareIndexes, structureDefaults.compareIndexes),
      compareChecks: optionalBoolean(structureBody.compareChecks, structureDefaults.compareChecks),
      compareCharsets: optionalBoolean(structureBody.compareCharsets, structureDefaults.compareCharsets),
      compareAutoIncrement: optionalBoolean(structureBody.compareAutoIncrement, structureDefaults.compareAutoIncrement),
      compareTableOptions: optionalBoolean(structureBody.compareTableOptions, structureDefaults.compareTableOptions),
      compareViews: optionalBoolean(structureBody.compareViews, structureDefaults.compareViews),
      compareRoutines: optionalBoolean(structureBody.compareRoutines, structureDefaults.compareRoutines),
      compareTriggers: optionalBoolean(structureBody.compareTriggers, structureDefaults.compareTriggers),
      compareEvents: optionalBoolean(structureBody.compareEvents, structureDefaults.compareEvents),
      compareDefiners: optionalBoolean(structureBody.compareDefiners, structureDefaults.compareDefiners),
      dropExtra: optionalBoolean(structureBody.dropExtra, structureDefaults.dropExtra),
    },
  };
  if (options.sourceConnectionId === options.targetConnectionId && options.sourceDatabase === options.targetDatabase) throw new DesktopDatabaseOperationError(400, "SAME_SYNC_TARGET", tr("源数据库和目标数据库不能相同"));
  if (mode === "data" && !options.data.insert && !options.data.update && !options.data.delete) throw new DesktopDatabaseOperationError(400, "EMPTY_DATA_SYNC", tr("请至少选择插入、更新或删除中的一项"));
  return options;
}

function parsedJson(request: DesktopDatabaseRequest): Record<string, unknown> {
  if (request.body?.kind !== "text") return {};
  try {
    const value = JSON.parse(request.body.value ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new DesktopDatabaseOperationError(400, "INVALID_BODY", tr("请求内容不是有效 JSON"));
  }
}

function formValues(request: DesktopDatabaseRequest): {
  fields: Record<string, string>;
  file: { name: string; type: string; data: Buffer } | null;
} {
  if (request.body?.kind !== "form") throw new DesktopDatabaseOperationError(400, "INVALID_FORM", tr("请求必须使用表单"));
  const fields: Record<string, string> = {};
  let file: { name: string; type: string; data: Buffer } | null = null;
  for (const entry of request.body.entries ?? []) {
    if (entry.file) file = { name: entry.file.name, type: entry.file.type, data: Buffer.from(entry.file.data) };
    else fields[entry.name] = entry.value ?? "";
  }
  return { fields, file };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function worksheetCell(value: ExcelJS.CellValue): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if ("result" in value) return worksheetCell(value.result as ExcelJS.CellValue);
    if ("text" in value) return String(value.text);
    if ("richText" in value) return value.richText.map((item) => item.text).join("");
    return JSON.stringify(value);
  }
  return value ?? null;
}

function extractCreate(row: RowDataPacket | undefined): string {
  if (!row) return "";
  const entries = Object.entries(row).filter(([, value]) => typeof value === "string");
  return String(entries.find(([key]) => key.toLowerCase().startsWith("create "))?.[1]
    ?? entries.find(([key]) => key.toLowerCase() === "sql original statement")?.[1]
    ?? "");
}

function rewriteDatabaseReferences(sql: string, sourceDatabase: string, targetDatabase: string): string {
  return sql
    .replaceAll(`${identifier(sourceDatabase)}.`, `${identifier(targetDatabase)}.`)
    .replace(/\sDEFINER\s*=\s*(?:`[^`]*`@`[^`]*`|[^\s]+)\s*/i, " ");
}

function splitSql(sql: string): string[] {
  if (sql.includes("-- ENVMAN_STATEMENT_BOUNDARY")) {
    return sql.split(/\r?\n-- ENVMAN_STATEMENT_BOUNDARY\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  const statements: string[] = [];
  let current = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") { current += next; index += 1; blockComment = false; }
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\" && next) { current += next; index += 1; continue; }
      if (char === quote) {
        if (next === quote) { current += next; index += 1; }
        else quote = "";
      }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; current += char; continue; }
    if (char === "#") { lineComment = true; current += char; continue; }
    if (char === "/" && next === "*") { blockComment = true; current += char; continue; }
    if (["'", '"', "`"].includes(char)) { quote = char; current += char; continue; }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function isTaskCancelled(task: DatabaseTask): boolean {
  return task.status === "cancelled";
}

export function isDesktopDatabaseOperationPath(path: string): boolean {
  const pathname = new URL(path, "http://desktop.local").pathname;
  return /^\/api\/v1\/database-connections\/[^/]+\/(?:table-import|backup|restore|transfer|sync-preview|sync)$/.test(pathname)
    || pathname === "/api/v1/database-tasks"
    || /^\/api\/v1\/database-tasks\/[^/]+$/.test(pathname);
}

export function isDesktopDatabaseDownloadPath(path: string): boolean {
  const pathname = new URL(path, "http://desktop.local").pathname;
  return /^\/api\/v1\/database-connections\/[^/]+\/table-export$/.test(pathname)
    || /^\/api\/v1\/database-tasks\/[^/]+\/download$/.test(pathname);
}

export class DesktopDatabaseOperationRuntime {
  private readonly tasks = new Map<string, DatabaseTask>();
  private readonly runningTasks = new Map<string, Promise<void>>();
  private readonly taskDirectory: string;
  private readonly backupDirectory: string;
  private readonly uploadDirectory: string;
  private readonly indexPath: string;

  constructor(
    dataDirectory: string,
    private readonly loadCredential: (connectionId: string) => Promise<{ context: DesktopSshContext; credential: DesktopDatabaseCredential }>,
    private readonly report: (report: DesktopDatabaseExecutionReport, context?: DesktopSshContext) => Promise<void>,
    private readonly connectDatabase: typeof connectDesktopDatabase = connectDesktopDatabase,
  ) {
    this.taskDirectory = join(dataDirectory, "database-tasks");
    this.backupDirectory = join(this.taskDirectory, "backups");
    this.uploadDirectory = join(this.taskDirectory, "uploads");
    this.indexPath = join(this.taskDirectory, "index.json");
    mkdirSync(this.backupDirectory, { recursive: true });
    mkdirSync(this.uploadDirectory, { recursive: true });
    this.loadTasks();
  }

  async handle(request: DesktopDatabaseRequest, context: DesktopSshContext): Promise<DesktopDatabaseResponse> {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      const url = new URL(request.path, "http://desktop.local");
      const connectionRoute = url.pathname.match(/^\/api\/v1\/database-connections\/([0-9a-f-]+)\/(table-import|backup|restore|transfer|sync-preview|sync)$/i);
      if (connectionRoute) {
        const connectionId = connectionRoute[1];
        const action = connectionRoute[2];
        if (action === "table-import" && method === "POST") return jsonResponse(201, await this.importTable(connectionId, request));
        if (action === "backup" && method === "POST") {
          const body = parsedJson(request);
          return jsonResponse(202, { task: await this.createBackup(context, connectionId, requiredString(body.database, tr("数据库")), optionalBoolean(body.includeData, true)) });
        }
        if (action === "restore" && method === "POST") return jsonResponse(202, { task: await this.createRestore(context, connectionId, request) });
        if (action === "transfer" && method === "POST") return jsonResponse(202, { task: await this.createTransfer(context, connectionId, parsedJson(request)) });
        if (action === "sync-preview" && method === "POST") return jsonResponse(200, { preview: await this.previewSync(context, connectionId, parsedJson(request)) });
        if (action === "sync" && method === "POST") return jsonResponse(202, { task: await this.createSync(context, connectionId, parsedJson(request)) });
      }
      if (url.pathname === "/api/v1/database-tasks" && method === "GET") {
        return jsonResponse(200, { items: this.list(context) });
      }
      const taskRoute = url.pathname.match(/^\/api\/v1\/database-tasks\/([0-9a-f-]+)$/i);
      if (taskRoute && method === "GET") return jsonResponse(200, { task: this.get(taskRoute[1], context) });
      if (taskRoute && method === "DELETE") {
        await this.cancel(taskRoute[1], context);
        return jsonResponse(204);
      }
      return jsonResponse(404, { error: "NOT_FOUND", message: tr("本机数据库操作不存在") });
    } catch (error) {
      const known = error instanceof DesktopDatabaseOperationError;
      return jsonResponse(known ? error.status : 502, {
        error: known ? error.code : "DESKTOP_DATABASE_OPERATION_FAILED",
        message: known ? error.message : errorMessage(error),
      });
    }
  }

  async download(path: string, context: DesktopSshContext): Promise<DesktopDatabaseDownload> {
    const url = new URL(path, "http://desktop.local");
    const exportRoute = url.pathname.match(/^\/api\/v1\/database-connections\/([0-9a-f-]+)\/table-export$/i);
    if (exportRoute) return this.exportTable(exportRoute[1], url);
    const taskRoute = url.pathname.match(/^\/api\/v1\/database-tasks\/([0-9a-f-]+)\/download$/i);
    if (!taskRoute) throw new DesktopDatabaseOperationError(404, "NOT_FOUND", tr("本机数据库下载不存在"));
    const task = this.taskForContext(taskRoute[1], context);
    if (task.status !== "success" || !task.outputPath) {
      throw new DesktopDatabaseOperationError(404, "TASK_OUTPUT_NOT_FOUND", tr("任务没有可下载文件"));
    }
    const info = await stat(task.outputPath);
    if (!info.isFile()) throw new DesktopDatabaseOperationError(404, "TASK_OUTPUT_NOT_FOUND", tr("任务没有可下载文件"));
    return {
      filename: basename(task.outputPath),
      contentType: "application/sql; charset=utf-8",
      data: await readFile(task.outputPath),
    };
  }

  closeConnection(connectionId: string, reason: string): void {
    for (const task of this.tasks.values()) {
      if (!["pending", "running"].includes(task.status)) continue;
      if (task.connectionId === connectionId || task.details.targetConnectionId === connectionId) this.cancelTask(task, reason);
    }
  }

  activeCount(): number {
    return [...this.tasks.values()].filter((task) => ["pending", "running"].includes(task.status)).length;
  }

  closeContext(context: DesktopSshContext, reason: string): void {
    const key = contextKey(context);
    for (const task of this.tasks.values()) {
      if (contextKey(task.context) === key && ["pending", "running"].includes(task.status)) this.cancelTask(task, reason);
    }
  }

  async closeAll(reason = tr("Viron App 正在退出")): Promise<void> {
    for (const task of this.tasks.values()) {
      if (["pending", "running"].includes(task.status)) this.cancelTask(task, reason);
    }
    await Promise.allSettled(this.runningTasks.values());
  }

  private async connect(task: DatabaseTask, connectionId: string, database?: string): Promise<ConnectedDesktopDatabase> {
    const loaded = await this.loadCredential(connectionId);
    if (contextKey(loaded.context) !== contextKey(task.context)) throw new Error(tr("数据库连接不属于当前用户或工作空间"));
    const connected = await this.connectDatabase(loaded.credential, database);
    task.active.add(connected);
    return connected;
  }

  private async exportTable(connectionId: string, url: URL): Promise<DesktopDatabaseDownload> {
    const database = requiredString(url.searchParams.get("database"), tr("数据库"));
    const table = requiredString(url.searchParams.get("table"), tr("数据表"));
    const format = url.searchParams.get("format") ?? "csv";
    const includeData = url.searchParams.get("includeData") !== "false";
    if (!["csv", "xlsx", "sql"].includes(format)) throw new DesktopDatabaseOperationError(400, "INVALID_EXPORT", tr("导出参数不正确"));
    const loaded = await this.loadCredential(connectionId);
    const connected = await this.connectDatabase(loaded.credential, database);
    try {
      const [rows, fields] = format === "sql" && !includeData
        ? [[], []]
        : await connected.connection.query<RowDataPacket[]>(`SELECT * FROM ${identifier(database)}.${identifier(table)} LIMIT ?`, [MAX_TABULAR_ROWS + 1]);
      if (rows.length > MAX_TABULAR_ROWS) {
        throw new DesktopDatabaseOperationError(413, "EXPORT_TOO_LARGE", tr("表格导出最多 {{0}} 行，请使用 SQL 备份任务导出完整数据", [MAX_TABULAR_ROWS.toLocaleString()]));
      }
      const headers = (fields as unknown as Array<{ name: string }>).map((field) => field.name);
      let data: Buffer;
      let contentType: string;
      if (format === "csv") {
        const csv = [`\uFEFF${headers.map(csvCell).join(",")}`, ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n");
        data = Buffer.from(csv, "utf8");
        contentType = "text/csv; charset=utf-8";
      } else if (format === "xlsx") {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "Viron";
        const worksheet = workbook.addWorksheet(table.slice(0, 31));
        worksheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(12, Math.min(42, header.length + 5)) }));
        worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176F60" } };
        for (const row of rows) worksheet.addRow(Object.fromEntries(headers.map((header) => [header, row[header]])));
        worksheet.views = [{ state: "frozen", ySplit: 1 }];
        data = Buffer.from(await workbook.xlsx.writeBuffer());
        contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      } else {
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(database)}.${identifier(table)}`);
        const createSql = String(Object.entries(createRows[0] ?? {}).find(([key]) => key.toLowerCase().includes("create"))?.[1] ?? "");
        const statements = ["-- Viron table export", `DROP TABLE IF EXISTS ${identifier(table)};`, `${createSql};`];
        for (let index = 0; includeData && index < rows.length; index += 250) {
          const chunk = rows.slice(index, index + 250);
          const values = chunk.map((row) => `(${headers.map((header) => connected.connection.escape(row[header])).join(",")})`).join(",\n");
          statements.push(`INSERT INTO ${identifier(table)} (${headers.map(identifier).join(",")}) VALUES\n${values};`);
        }
        data = Buffer.from(statements.join("\n\n"), "utf8");
        contentType = "application/sql; charset=utf-8";
      }
      await this.report({
        kind: "operation",
        operationId: randomUUID(),
        connectionId,
        action: "table_exported",
        summary: tr("本机导出数据表 {{0}}.{{1}}", [database, table]),
        details: { format, rows: rows.length, includeData },
      }, loaded.context);
      return { filename: `${database}.${table}${format === "sql" && !includeData ? ".structure" : ""}.${format}`, contentType, data };
    } finally {
      await connected.close();
    }
  }

  private async importTable(connectionId: string, request: DesktopDatabaseRequest) {
    const { fields, file } = formValues(request);
    const database = requiredString(fields.database, tr("数据库"));
    const table = requiredString(fields.table, tr("数据表"));
    if (!file) throw new DesktopDatabaseOperationError(400, "INVALID_IMPORT", tr("请选择文件、数据库和数据表"));
    let rows: Array<Record<string, unknown>> = [];
    if (extname(file.name).toLowerCase() === ".csv") {
      rows = parseCsv(file.data, { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true }) as Array<Record<string, unknown>>;
    } else if ([".xlsx", ".xlsm"].includes(extname(file.name).toLowerCase())) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(file.data).buffer);
      const worksheet = workbook.worksheets[0];
      if (!worksheet) throw new DesktopDatabaseOperationError(400, "INVALID_IMPORT", tr("XLSX 中没有工作表"));
      const headers = (worksheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((value) => String(worksheetCell(value) ?? "").trim());
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const values = (row.values as ExcelJS.CellValue[]).slice(1);
        if (values.every((value) => value === null || value === undefined || value === "")) return;
        rows.push(Object.fromEntries(headers.map((header, index) => [header, worksheetCell(values[index])])));
      });
    } else {
      throw new DesktopDatabaseOperationError(400, "UNSUPPORTED_IMPORT", tr("数据表导入仅支持 CSV 和 XLSX"));
    }
    if (rows.length > MAX_TABULAR_ROWS) throw new DesktopDatabaseOperationError(413, "IMPORT_TOO_LARGE", tr("单次导入最多 {{0}} 行", [MAX_TABULAR_ROWS.toLocaleString()]));
    const loaded = await this.loadCredential(connectionId);
    const connected = await this.connectDatabase(loaded.credential, database);
    try {
      const [columnRows] = await connected.connection.query<RowDataPacket[]>(`
        SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
      `, [database, table]);
      const allowed = new Set(columnRows.map((row) => String(row.name)));
      if (!allowed.size) throw new DesktopDatabaseOperationError(404, "TABLE_NOT_FOUND", tr("目标数据表不存在"));
      const headers = Object.keys(rows[0] ?? {}).filter((name) => allowed.has(name));
      if (!headers.length) throw new DesktopDatabaseOperationError(400, "COLUMN_MISMATCH", tr("导入文件的列名与目标数据表不匹配"));
      await connected.connection.beginTransaction();
      try {
        if (fields.mode === "replace") await connected.connection.query(`DELETE FROM ${identifier(database)}.${identifier(table)}`);
        for (let index = 0; index < rows.length; index += 500) {
          const chunk = rows.slice(index, index + 500).map((row) => headers.map((header) => row[header]));
          if (!chunk.length) continue;
          await connected.connection.query(
            `INSERT INTO ${identifier(database)}.${identifier(table)} (${headers.map(identifier).join(",")}) VALUES ?`,
            [chunk],
          );
        }
        await connected.connection.commit();
      } catch (error) {
        await connected.connection.rollback();
        throw error;
      }
      const result = { imported: rows.length, columns: headers.length };
      await this.report({
        kind: "operation",
        operationId: randomUUID(),
        connectionId,
        action: "table_imported",
        summary: tr("本机导入数据表 {{0}}.{{1}}", [database, table]),
        details: { filename: file.name, mode: fields.mode || "append", ...result },
      }, loaded.context);
      return result;
    } finally {
      await connected.close();
    }
  }

  private async createBackup(context: DesktopSshContext, connectionId: string, database: string, includeData: boolean): Promise<PublicDatabaseTask> {
    const task = this.createTask(context, "backup", connectionId, `${includeData ? tr("备份") : tr("备份结构")} ${database}`, { database, includeData });
    this.startTask(task, () => this.backup(task, connectionId, database, includeData));
    return this.publicTask(task);
  }

  private async createRestore(context: DesktopSshContext, connectionId: string, request: DesktopDatabaseRequest): Promise<PublicDatabaseTask> {
    const { fields, file } = formValues(request);
    const database = requiredString(fields.database, tr("数据库"));
    if (!file) throw new DesktopDatabaseOperationError(400, "INVALID_RESTORE", tr("请选择 SQL 文件和目标数据库"));
    if (!file.name.toLowerCase().endsWith(".sql")) throw new DesktopDatabaseOperationError(400, "SQL_REQUIRED", tr("恢复任务只接受 .sql 文件"));
    await mkdir(this.uploadDirectory, { recursive: true });
    const inputPath = join(this.uploadDirectory, `${randomUUID()}.sql`);
    await writeFile(inputPath, file.data, { mode: 0o600, flag: "wx" });
    const task = this.createTask(context, "restore", connectionId, tr("恢复 {{0}}", [database]), { database, originalFilename: file.name });
    this.startTask(task, () => this.restore(task, connectionId, database, inputPath));
    return this.publicTask(task);
  }

  private async createTransfer(context: DesktopSshContext, connectionId: string, body: Record<string, unknown>): Promise<PublicDatabaseTask> {
    const options: TransferOptions = {
      sourceConnectionId: connectionId,
      sourceDatabase: requiredString(body.sourceDatabase, tr("来源数据库")),
      targetConnectionId: requiredString(body.targetConnectionId, tr("目标连接")),
      targetDatabase: requiredString(body.targetDatabase, tr("目标数据库")),
      includeStructure: optionalBoolean(body.includeStructure, true),
      includeData: optionalBoolean(body.includeData, true),
      includeObjects: optionalBoolean(body.includeObjects, true),
      dropExisting: optionalBoolean(body.dropExisting, false),
      tables: Array.isArray(body.tables) ? body.tables.map((value) => requiredString(value, tr("数据表"))) : undefined,
    };
    if (!options.includeStructure && !options.includeData) throw new DesktopDatabaseOperationError(400, "EMPTY_TRANSFER", tr("请至少选择结构或数据"));
    const target = await this.loadCredential(options.targetConnectionId);
    if (contextKey(target.context) !== contextKey(context)) throw new DesktopDatabaseOperationError(404, "NOT_FOUND", tr("目标数据库连接不存在"));
    const task = this.createTask(context, "transfer", connectionId, tr("迁移 {{0}} → {{1}}", [options.sourceDatabase, options.targetDatabase]), {
      sourceDatabase: options.sourceDatabase,
      targetDatabase: options.targetDatabase,
      targetConnectionId: options.targetConnectionId,
      includeStructure: options.includeStructure,
      includeData: options.includeData,
      includeObjects: options.includeObjects,
      dropExisting: options.dropExisting,
      tableCount: options.tables?.length ?? null,
    });
    this.startTask(task, () => this.transfer(task, options));
    return this.publicTask(task);
  }

  private async previewSync(context: DesktopSshContext, connectionId: string, body: Record<string, unknown>) {
    const options = syncOptions(connectionId, body, false);
    const [sourceLoaded, targetLoaded] = await Promise.all([this.loadCredential(connectionId), this.loadCredential(options.targetConnectionId)]);
    if (contextKey(sourceLoaded.context) !== contextKey(context) || contextKey(targetLoaded.context) !== contextKey(context)) throw new DesktopDatabaseOperationError(404, "NOT_FOUND", tr("数据库连接不存在"));
    const source = await this.connectDatabase(sourceLoaded.credential, options.sourceDatabase);
    try {
      const target = await this.connectDatabase(targetLoaded.credential);
      try {
        return previewDatabaseSync(source.connection, target.connection, options);
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  }

  private async createSync(context: DesktopSshContext, connectionId: string, body: Record<string, unknown>): Promise<PublicDatabaseTask> {
    const options = syncOptions(connectionId, body, true);
    const target = await this.loadCredential(options.targetConnectionId);
    if (contextKey(target.context) !== contextKey(context)) throw new DesktopDatabaseOperationError(404, "NOT_FOUND", tr("目标数据库连接不存在"));
    const label = options.mode === "data" ? tr("数据同步") : tr("结构同步");
    const task = this.createTask(context, "transfer", connectionId, `${label} ${options.sourceDatabase} → ${options.targetDatabase}`, {
      syncMode: options.mode,
      sourceDatabase: options.sourceDatabase,
      targetDatabase: options.targetDatabase,
      targetConnectionId: options.targetConnectionId,
      selectedCount: options.selectedItems.length,
      data: options.data,
      structure: options.structure,
    });
    this.startTask(task, () => this.sync(task, options));
    return this.publicTask(task);
  }

  private createTask(context: DesktopSshContext, type: DatabaseTaskType, connectionId: string | null, title: string, details: Record<string, unknown>): DatabaseTask {
    const active = [...this.tasks.values()].filter((task) => ["pending", "running"].includes(task.status)).length;
    if (active >= TASK_LIMIT) throw new DesktopDatabaseOperationError(429, "TASK_START_FAILED", tr("数据库后台任务已达到 {{0}} 个并发上限", [TASK_LIMIT]));
    const task: DatabaseTask = {
      id: randomUUID(),
      context: { ...context },
      type,
      connectionId,
      status: "pending",
      progress: 0,
      title,
      details,
      logs: [],
      outputPath: null,
      error: "",
      createdAt: new Date().toISOString(),
      active: new Set(),
    };
    this.tasks.set(task.id, task);
    this.saveTasks();
    return task;
  }

  private async run(task: DatabaseTask, action: () => Promise<void>): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.log(task, tr("任务开始"));
    this.saveTasks();
    try {
      await action();
      if (!isTaskCancelled(task)) {
        task.status = "success";
        task.progress = 100;
        this.log(task, tr("任务完成"));
      }
    } catch (error) {
      if (!isTaskCancelled(task)) {
        task.status = "error";
        task.error = errorMessage(error);
        this.log(task, tr("任务失败：{{0}}", [task.error]));
      }
    } finally {
      task.completedAt = new Date().toISOString();
      task.active.clear();
      this.saveTasks();
      if (task.connectionId) {
        const finalTaskStatus = task.status as DatabaseTaskStatus;
        const status = finalTaskStatus === "success" ? "success" : finalTaskStatus === "cancelled" ? "cancelled" : "error";
        await this.report({
          kind: "operation",
          operationId: task.id,
          connectionId: task.connectionId,
          action: `${task.type}_${status}` as DesktopDatabaseOperationReport["action"],
          summary: tr("本机{{0}} · {{1}}", [task.title, task.status]),
          details: { taskId: task.id, status: task.status, ...task.details },
        }, task.context).catch(() => undefined);
      }
    }
  }

  private startTask(task: DatabaseTask, action: () => Promise<void>): void {
    const running = this.run(task, action);
    this.runningTasks.set(task.id, running);
    void running.finally(() => this.runningTasks.delete(task.id));
  }

  private async backup(task: DatabaseTask, connectionId: string, database: string, includeData: boolean): Promise<void> {
    await mkdir(this.backupDirectory, { recursive: true });
    const outputPath = join(this.backupDirectory, `${database.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`);
    const file = await open(outputPath, "wx", 0o600);
    const connected = await this.connect(task, connectionId, database);
    try {
      const [tableRows] = await connected.connection.query<RowDataPacket[]>(`SHOW FULL TABLES FROM ${identifier(database)}`);
      const objects = tableRows.map((row) => ({ name: String(Object.values(row)[0]), type: String(Object.values(row)[1]) }));
      const [routineRows] = await connected.connection.query<RowDataPacket[]>("SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME", [database]);
      const [triggerRows] = await connected.connection.query<RowDataPacket[]>("SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME", [database]);
      const [eventRows] = await connected.connection.query<RowDataPacket[]>("SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME", [database]);
      const totalObjects = objects.length + routineRows.length + triggerRows.length + eventRows.length;
      this.log(task, tr("发现 {{0}} 个数据库对象", [totalObjects]));
      await file.write(`-- Viron SQL Backup\n-- Database: ${database}\n-- Created: ${new Date().toISOString()}\n${BACKUP_BOUNDARY}`);
      await file.write(`SET FOREIGN_KEY_CHECKS=0;${BACKUP_BOUNDARY}`);
      const tables = objects.filter((item) => item.type === "BASE TABLE");
      const views = objects.filter((item) => item.type === "VIEW");
      let processed = 0;
      for (const table of tables) {
        if (task.status === "cancelled") return;
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(database)}.${identifier(table.name)}`);
        await file.write(`DROP TABLE IF EXISTS ${identifier(table.name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        let rowCount = 0;
        if (includeData) {
          const [rows, fields] = await connected.connection.query<RowDataPacket[]>(`SELECT * FROM ${identifier(database)}.${identifier(table.name)}`);
          const fieldNames = (fields as unknown as Array<{ name: string }>).map((field) => field.name);
          rowCount = rows.length;
          for (let index = 0; index < rows.length; index += 250) {
            const chunk = rows.slice(index, index + 250);
            if (!chunk.length || !fieldNames.length) continue;
            const values = chunk.map((row) => `(${fieldNames.map((name) => connected.connection.escape(row[name])).join(",")})`).join(",\n");
            await file.write(`INSERT INTO ${identifier(table.name)} (${fieldNames.map(identifier).join(",")}) VALUES\n${values};${BACKUP_BOUNDARY}`);
          }
        }
        this.log(task, includeData ? tr("表 {{0}}：{{1}} 行", [table.name, rowCount]) : tr("表 {{0}}：仅结构", [table.name]));
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const view of views) {
        if (task.status === "cancelled") return;
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE VIEW ${identifier(database)}.${identifier(view.name)}`);
        await file.write(`DROP VIEW IF EXISTS ${identifier(view.name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const row of routineRows) {
        if (task.status === "cancelled") return;
        const name = String(row.name);
        const type = String(row.type).toUpperCase() === "FUNCTION" ? "FUNCTION" : "PROCEDURE";
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE ${type} ${identifier(database)}.${identifier(name)}`);
        await file.write(`DROP ${type} IF EXISTS ${identifier(name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const row of triggerRows) {
        if (task.status === "cancelled") return;
        const name = String(row.name);
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TRIGGER ${identifier(database)}.${identifier(name)}`);
        await file.write(`DROP TRIGGER IF EXISTS ${identifier(name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const row of eventRows) {
        if (task.status === "cancelled") return;
        const name = String(row.name);
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE EVENT ${identifier(database)}.${identifier(name)}`);
        await file.write(`DROP EVENT IF EXISTS ${identifier(name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      await file.write(`SET FOREIGN_KEY_CHECKS=1;${BACKUP_BOUNDARY}`);
      task.outputPath = outputPath;
      this.progress(task, 96);
    } finally {
      await file.close();
      await connected.close();
      task.active.delete(connected);
    }
  }

  private async restore(task: DatabaseTask, connectionId: string, database: string, inputPath: string): Promise<void> {
    const connected = await this.connect(task, connectionId);
    try {
      await connected.connection.query(`CREATE DATABASE IF NOT EXISTS ${identifier(database)}`);
      await connected.connection.query(`USE ${identifier(database)}`);
      const statements = splitSql(await readFile(inputPath, "utf8"));
      this.log(task, tr("读取 {{0}} 条 SQL 语句", [statements.length]));
      for (let index = 0; index < statements.length; index += 1) {
        if (task.status === "cancelled") return;
        const statement = statements[index].trim();
        if (!statement || statement.startsWith("--") && !statement.includes("\n")) continue;
        await connected.connection.query(statement);
        if (index % 25 === 0) this.progress(task, Math.round(((index + 1) / Math.max(1, statements.length)) * 95));
      }
    } finally {
      await connected.close();
      task.active.delete(connected);
      await unlink(inputPath).catch(() => undefined);
    }
  }

  private async transfer(task: DatabaseTask, options: TransferOptions): Promise<void> {
    const source = await this.connect(task, options.sourceConnectionId, options.sourceDatabase);
    const target = await this.connect(task, options.targetConnectionId);
    try {
      await target.connection.query(`CREATE DATABASE IF NOT EXISTS ${identifier(options.targetDatabase)}`);
      await target.connection.query(`USE ${identifier(options.targetDatabase)}`);
      await target.connection.query("SET FOREIGN_KEY_CHECKS=0");
      const [rows] = await source.connection.query<RowDataPacket[]>(`
        SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME
      `, [options.sourceDatabase]);
      const available = rows.map((row) => String(row.name));
      const tables = options.tables?.length ? available.filter((name) => options.tables!.includes(name)) : available;
      const includeObjects = options.includeStructure && options.includeObjects;
      const [viewRows] = includeObjects
        ? await source.connection.query<RowDataPacket[]>("SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [options.sourceDatabase])
        : [[] as unknown as RowDataPacket[]];
      const [routineRows] = includeObjects
        ? await source.connection.query<RowDataPacket[]>("SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME", [options.sourceDatabase])
        : [[] as unknown as RowDataPacket[]];
      const [triggerRows] = includeObjects
        ? await source.connection.query<RowDataPacket[]>("SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME", [options.sourceDatabase])
        : [[] as unknown as RowDataPacket[]];
      const [eventRows] = includeObjects
        ? await source.connection.query<RowDataPacket[]>("SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME", [options.sourceDatabase])
        : [[] as unknown as RowDataPacket[]];
      const totalObjects = tables.length + viewRows.length + routineRows.length + triggerRows.length + eventRows.length;
      let processed = 0;
      this.log(task, tr("准备迁移 {{0}} 个表{{1}}", [tables.length, includeObjects ? `及 ${totalObjects - tables.length} 个视图/例程/触发器/事件` : ""]));
      for (const table of tables) {
        if (task.status === "cancelled") return;
        if (options.includeStructure) {
          const [createRows] = await source.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(options.sourceDatabase)}.${identifier(table)}`);
          if (options.dropExisting) await target.connection.query(`DROP TABLE IF EXISTS ${identifier(options.targetDatabase)}.${identifier(table)}`);
          const createSql = extractCreate(createRows[0]).replace(/^CREATE TABLE\s+`[^`]+`/i, `CREATE TABLE ${identifier(options.targetDatabase)}.${identifier(table)}`);
          await target.connection.query(createSql);
        }
        if (options.includeData) {
          const [dataRows, fields] = await source.connection.query<RowDataPacket[]>(`SELECT * FROM ${identifier(options.sourceDatabase)}.${identifier(table)}`);
          const fieldNames = (fields as unknown as Array<{ name: string }>).map((field) => field.name);
          if (!options.includeStructure && options.dropExisting) await target.connection.query(`TRUNCATE TABLE ${identifier(options.targetDatabase)}.${identifier(table)}`);
          for (let index = 0; index < dataRows.length; index += 250) {
            const chunk = dataRows.slice(index, index + 250);
            const values = chunk.map((row) => `(${fieldNames.map((name) => target.connection.escape(row[name])).join(",")})`).join(",");
            if (values) await target.connection.query(`INSERT INTO ${identifier(options.targetDatabase)}.${identifier(table)} (${fieldNames.map(identifier).join(",")}) VALUES ${values}`);
          }
          this.log(task, tr("{{0}}：迁移 {{1}} 行", [table, dataRows.length]));
        }
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 95));
      }
      if (includeObjects) {
        for (const row of routineRows) {
          if (task.status === "cancelled") return;
          const name = String(row.name);
          const type = String(row.type).toUpperCase() === "FUNCTION" ? "FUNCTION" : "PROCEDURE";
          const [createRows] = await source.connection.query<RowDataPacket[]>(`SHOW CREATE ${type} ${identifier(options.sourceDatabase)}.${identifier(name)}`);
          if (options.dropExisting) await target.connection.query(`DROP ${type} IF EXISTS ${identifier(options.targetDatabase)}.${identifier(name)}`);
          await target.connection.query(rewriteDatabaseReferences(extractCreate(createRows[0]), options.sourceDatabase, options.targetDatabase));
          processed += 1;
          this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 95));
        }
        for (const row of viewRows) {
          if (task.status === "cancelled") return;
          const name = String(row.name);
          const [createRows] = await source.connection.query<RowDataPacket[]>(`SHOW CREATE VIEW ${identifier(options.sourceDatabase)}.${identifier(name)}`);
          if (options.dropExisting) await target.connection.query(`DROP VIEW IF EXISTS ${identifier(options.targetDatabase)}.${identifier(name)}`);
          await target.connection.query(rewriteDatabaseReferences(extractCreate(createRows[0]), options.sourceDatabase, options.targetDatabase));
          processed += 1;
          this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 95));
        }
        for (const row of triggerRows) {
          if (task.status === "cancelled") return;
          const name = String(row.name);
          const [createRows] = await source.connection.query<RowDataPacket[]>(`SHOW CREATE TRIGGER ${identifier(options.sourceDatabase)}.${identifier(name)}`);
          if (options.dropExisting) await target.connection.query(`DROP TRIGGER IF EXISTS ${identifier(options.targetDatabase)}.${identifier(name)}`);
          await target.connection.query(rewriteDatabaseReferences(extractCreate(createRows[0]), options.sourceDatabase, options.targetDatabase));
          processed += 1;
          this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 95));
        }
        for (const row of eventRows) {
          if (task.status === "cancelled") return;
          const name = String(row.name);
          const [createRows] = await source.connection.query<RowDataPacket[]>(`SHOW CREATE EVENT ${identifier(options.sourceDatabase)}.${identifier(name)}`);
          if (options.dropExisting) await target.connection.query(`DROP EVENT IF EXISTS ${identifier(options.targetDatabase)}.${identifier(name)}`);
          await target.connection.query(rewriteDatabaseReferences(extractCreate(createRows[0]), options.sourceDatabase, options.targetDatabase));
          processed += 1;
          this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 95));
        }
      }
      await target.connection.query("SET FOREIGN_KEY_CHECKS=1");
    } finally {
      await source.close();
      await target.close();
      task.active.delete(source);
      task.active.delete(target);
    }
  }

  private async sync(task: DatabaseTask, options: SyncTaskOptions): Promise<void> {
    const source = await this.connect(task, options.sourceConnectionId, options.sourceDatabase);
    try {
      const target = await this.connect(task, options.targetConnectionId);
      try {
        await executeDatabaseSync(source.connection, target.connection, options, options.selectedItems, {
          log: (message) => this.log(task, message),
          progress: (value) => this.progress(task, value),
          cancelled: () => task.status === "cancelled",
        });
      } finally {
        await target.close();
        task.active.delete(target);
      }
    } finally {
      await source.close();
      task.active.delete(source);
    }
  }

  private list(context: DesktopSshContext): PublicDatabaseTask[] {
    const key = contextKey(context);
    return [...this.tasks.values()]
      .filter((task) => contextKey(task.context) === key)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => this.publicTask(task));
  }

  private get(id: string, context: DesktopSshContext): PublicDatabaseTask {
    return this.publicTask(this.taskForContext(id, context));
  }

  private async cancel(id: string, context: DesktopSshContext): Promise<void> {
    const task = this.taskForContext(id, context);
    if (!["pending", "running"].includes(task.status)) throw new DesktopDatabaseOperationError(409, "TASK_NOT_RUNNING", tr("任务已经结束或不存在"));
    this.cancelTask(task, tr("任务已由管理员取消"));
  }

  private taskForContext(id: string, context: DesktopSshContext): DatabaseTask {
    const task = this.tasks.get(id);
    if (!task || contextKey(task.context) !== contextKey(context)) throw new DesktopDatabaseOperationError(404, "TASK_NOT_FOUND", tr("数据库任务不存在"));
    return task;
  }

  private cancelTask(task: DatabaseTask, reason: string): void {
    task.status = "cancelled";
    task.error = reason;
    task.completedAt = new Date().toISOString();
    for (const connected of task.active) connected.connection.destroy();
    this.log(task, reason);
    this.saveTasks();
  }

  private log(task: DatabaseTask, message: string): void {
    task.logs.push(`${new Date().toISOString()} ${message}`);
    if (task.logs.length > TASK_LOG_LIMIT) task.logs.splice(0, task.logs.length - TASK_LOG_LIMIT);
  }

  private progress(task: DatabaseTask, value: number): void {
    task.progress = Math.max(task.progress, Math.min(99, value));
    this.saveTasks();
  }

  private publicTask(task: DatabaseTask): PublicDatabaseTask {
    return {
      id: task.id,
      type: task.type,
      connectionId: task.connectionId,
      status: task.status,
      progress: task.progress,
      title: task.title,
      details: task.details,
      logs: [...task.logs],
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      downloadable: task.status === "success" && Boolean(task.outputPath),
      outputFilename: task.outputPath ? basename(task.outputPath) : null,
    };
  }

  private loadTasks(): void {
    try {
      const stored = JSON.parse(readFileSync(this.indexPath, "utf8")) as StoredDatabaseTask[];
      for (const item of stored) {
        const interrupted = ["pending", "running"].includes(item.status);
        const task: DatabaseTask = {
          ...item,
          status: interrupted ? "error" : item.status,
          error: interrupted ? tr("Viron App 重启导致任务中断") : item.error,
          completedAt: interrupted ? new Date().toISOString() : item.completedAt,
          active: new Set(),
        };
        this.tasks.set(task.id, task);
      }
      if (stored.some((item) => ["pending", "running"].includes(item.status))) this.saveTasks();
    } catch {
      // The task index is optional and is rebuilt from new local tasks.
    }
  }

  private saveTasks(): void {
    mkdirSync(this.taskDirectory, { recursive: true });
    const stored: StoredDatabaseTask[] = [...this.tasks.values()].map(({ active: _active, ...task }) => task);
    writeFileSync(this.indexPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
