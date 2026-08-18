import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import { defaultDataSyncOptions, defaultStructureSyncOptions, previewDatabaseSync } from "../../database-sync.js";
import { writeAudit } from "../audit.js";
import { filterAsync } from "../async-utils.js";
import { canAccessConnection } from "../access-control.js";
import { connectDatabase } from "../database-workbench/connector.js";
import { executionScope } from "../execution-scope.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const backupSchema = z.object({ database: z.string().trim().min(1).max(255), includeData: z.boolean().default(true) });
const backupNameSchema = z.object({ name: z.string().trim().min(1).max(160) });
const backupRestoreSchema = z.object({ database: z.string().trim().min(1).max(255).optional() });
const transferSchema = z.object({
  sourceDatabase: z.string().trim().min(1).max(255),
  targetConnectionId: z.string().uuid(),
  targetDatabase: z.string().trim().min(1).max(255),
  includeStructure: z.boolean().default(true),
  includeData: z.boolean().default(true),
  includeObjects: z.boolean().default(true),
  dropExisting: z.boolean().default(false),
  tables: z.array(z.string().trim().min(1).max(255)).max(5_000).optional(),
});
const dataSyncOptionsSchema = z.object({
  insert: z.boolean().default(true),
  update: z.boolean().default(true),
  delete: z.boolean().default(true),
}).default(defaultDataSyncOptions());
const structureSyncOptionsSchema = z.object({
  compareTables: z.boolean().default(true),
  comparePrimaryKeys: z.boolean().default(true),
  compareForeignKeys: z.boolean().default(true),
  compareIndexes: z.boolean().default(true),
  compareChecks: z.boolean().default(true),
  compareCharsets: z.boolean().default(true),
  compareAutoIncrement: z.boolean().default(false),
  compareTableOptions: z.boolean().default(true),
  compareViews: z.boolean().default(true),
  compareRoutines: z.boolean().default(true),
  compareTriggers: z.boolean().default(true),
  compareEvents: z.boolean().default(true),
  compareDefiners: z.boolean().default(false),
  dropExtra: z.boolean().default(false),
}).default(defaultStructureSyncOptions());
const syncPreviewSchema = z.object({
  mode: z.enum(["data", "structure"]),
  sourceDatabase: z.string().trim().min(1).max(255),
  targetConnectionId: z.string().uuid(),
  targetDatabase: z.string().trim().min(1).max(255),
  data: dataSyncOptionsSchema,
  structure: structureSyncOptionsSchema,
});
const syncStartSchema = syncPreviewSchema.extend({ selectedItems: z.array(z.string().trim().min(1).max(1_000)).min(1).max(10_000) });

const MAX_TABULAR_EXPORT_ROWS = 100_000;

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function errorMessage(error: unknown): string {
  const value = error as { sqlMessage?: string; message?: string };
  return value.sqlMessage || value.message || String(error);
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

async function importRows(app: FastifyInstance, connectionId: string, database: string, table: string, rows: Array<Record<string, unknown>>, replace: boolean) {
  if (rows.length > MAX_TABULAR_EXPORT_ROWS) throw new Error(`单次导入最多 ${MAX_TABULAR_EXPORT_ROWS.toLocaleString()} 行`);
  const connected = await connectDatabase(app, connectionId, database);
  try {
    const [columnRows] = await connected.connection.query<RowDataPacket[]>(`
      SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
    `, [database, table]);
    const allowed = new Set(columnRows.map((row) => String(row.name)));
    if (!allowed.size) throw new Error("目标数据表不存在");
    const headers = Object.keys(rows[0] ?? {}).filter((name) => allowed.has(name));
    if (!headers.length) throw new Error("导入文件的列名与目标数据表不匹配");
    await connected.connection.beginTransaction();
    try {
      if (replace) await connected.connection.query(`DELETE FROM ${identifier(database)}.${identifier(table)}`);
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
    return { imported: rows.length, columns: headers.length };
  } finally {
    await connected.close();
  }
}

export async function registerDatabaseOperationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/database-connections/")) return;
    const connectionId = (request.params as { id?: string }).id;
    if (connectionId && !await canAccessConnection(app.db, request.admin!, "database", connectionId)) {
      await reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { database?: string; table?: string; format?: string; includeData?: string };
  }>("/api/v1/database-connections/:id/table-export", async (request, reply) => {
    const database = request.query.database?.trim();
    const table = request.query.table?.trim();
    const format = request.query.format ?? "csv";
    const includeData = request.query.includeData !== "false";
    if (!database || !table || !["csv", "xlsx", "sql"].includes(format)) {
      return reply.code(400).send({ error: "INVALID_EXPORT", message: "导出参数不正确" });
    }
    try {
      const connected = await connectDatabase(app, request.params.id, database);
      try {
        const [rows, fields] = format === "sql" && !includeData
          ? [[], []]
          : await connected.connection.query<RowDataPacket[]>(`SELECT * FROM ${identifier(database)}.${identifier(table)} LIMIT ?`, [MAX_TABULAR_EXPORT_ROWS + 1]);
        if (rows.length > MAX_TABULAR_EXPORT_ROWS) {
          return reply.code(413).send({ error: "EXPORT_TOO_LARGE", message: `表格导出最多 ${MAX_TABULAR_EXPORT_ROWS.toLocaleString()} 行，请使用 SQL 备份任务导出完整数据` });
        }
        const headers = (fields as unknown as Array<{ name: string }>).map((field) => field.name);
        const filename = `${database}.${table}${format === "sql" && !includeData ? ".structure" : ""}.${format}`;
        reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        if (format === "csv") {
          const csv = [`\uFEFF${headers.map(csvCell).join(",")}`, ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n");
          reply.type("text/csv; charset=utf-8");
          return reply.send(csv);
        }
        if (format === "xlsx") {
          const workbook = new ExcelJS.Workbook();
          workbook.creator = "Viron";
          const worksheet = workbook.addWorksheet(table.slice(0, 31));
          worksheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(12, Math.min(42, header.length + 5)) }));
          worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
          worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176F60" } };
          for (const row of rows) worksheet.addRow(Object.fromEntries(headers.map((header) => [header, row[header]])));
          worksheet.views = [{ state: "frozen", ySplit: 1 }];
          const buffer = await workbook.xlsx.writeBuffer();
          reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
          return reply.send(Buffer.from(buffer));
        }
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(database)}.${identifier(table)}`);
        const createSql = String(Object.entries(createRows[0] ?? {}).find(([key]) => key.toLowerCase().includes("create"))?.[1] ?? "");
        const statements = [`-- Viron table export`, `DROP TABLE IF EXISTS ${identifier(table)};`, `${createSql};`];
        for (let index = 0; includeData && index < rows.length; index += 250) {
          const chunk = rows.slice(index, index + 250);
          const values = chunk.map((row) => `(${headers.map((header) => connected.connection.escape(row[header])).join(",")})`).join(",\n");
          statements.push(`INSERT INTO ${identifier(table)} (${headers.map(identifier).join(",")}) VALUES\n${values};`);
        }
        reply.type("application/sql; charset=utf-8");
        return reply.send(statements.join("\n\n"));
      } finally {
        await connected.close();
        await writeAudit(app.db, { action: "database.table_exported", resourceType: "database_connection", resourceId: request.params.id, summary: `导出数据表 ${database}.${table}`, details: { format, includeData }, request });
      }
    } catch (error) {
      return reply.code(502).send({ error: "TABLE_EXPORT_FAILED", message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/table-import", async (request, reply) => {
    let database = "";
    let table = "";
    let mode = "append";
    let filename = "";
    let file: Buffer | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") { filename = part.filename; file = await part.toBuffer(); }
      else if (part.fieldname === "database") database = String(part.value);
      else if (part.fieldname === "table") table = String(part.value);
      else if (part.fieldname === "mode") mode = String(part.value);
    }
    if (!file || !filename || !database || !table) return reply.code(400).send({ error: "INVALID_IMPORT", message: "请选择文件、数据库和数据表" });
    try {
      let rows: Array<Record<string, unknown>> = [];
      if (extname(filename).toLowerCase() === ".csv") {
        rows = parseCsv(file, { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true }) as Array<Record<string, unknown>>;
      } else if ([".xlsx", ".xlsm"].includes(extname(filename).toLowerCase())) {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(new Uint8Array(file).buffer);
        const worksheet = workbook.worksheets[0];
        if (!worksheet) throw new Error("XLSX 中没有工作表");
        const headers = (worksheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((value) => String(worksheetCell(value) ?? "").trim());
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          const values = (row.values as ExcelJS.CellValue[]).slice(1);
          if (values.every((value) => value === null || value === undefined || value === "")) return;
          rows.push(Object.fromEntries(headers.map((header, index) => [header, worksheetCell(values[index])])));
        });
      } else {
        return reply.code(400).send({ error: "UNSUPPORTED_IMPORT", message: "数据表导入仅支持 CSV 和 XLSX" });
      }
      const result = await importRows(app, request.params.id, database, table, rows, mode === "replace");
      await writeAudit(app.db, { action: "database.table_imported", resourceType: "database_connection", resourceId: request.params.id, summary: `导入数据表 ${database}.${table}`, details: { filename, mode, ...result }, request });
      return reply.code(201).send(result);
    } catch (error) {
      return reply.code(502).send({ error: "TABLE_IMPORT_FAILED", message: errorMessage(error) });
    }
  });

  app.get("/api/v1/database-tasks", async (request) => ({
    items: await filterAsync(
      app.databaseTasks.list(request.admin!.id, executionScope(request)),
      (task) => Boolean(task.connectionId) && canAccessConnection(app.db, request.admin!, "database", task.connectionId!),
    ),
  }));

  app.get<{ Params: { id: string } }>("/api/v1/database-tasks/:id", async (request, reply) => {
    const task = app.databaseTasks.get(request.params.id, request.admin!.id, executionScope(request));
    if (!task || !task.connectionId || !await canAccessConnection(app.db, request.admin!, "database", task.connectionId)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "数据库任务不存在" });
    return { task };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-tasks/:id", async (request, reply) => {
    const task = app.databaseTasks.get(request.params.id, request.admin!.id, executionScope(request));
    if (!task || !task.connectionId || !await canAccessConnection(app.db, request.admin!, "database", task.connectionId)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "数据库任务不存在" });
    if (!await app.databaseTasks.cancel(request.params.id, request.admin!.id, executionScope(request))) return reply.code(409).send({ error: "TASK_NOT_RUNNING", message: "任务已经结束或不存在" });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/v1/database-tasks/:id/download", async (request, reply) => {
    const task = app.databaseTasks.get(request.params.id, request.admin!.id, executionScope(request));
    if (!task || !task.connectionId || !await canAccessConnection(app.db, request.admin!, "database", task.connectionId)) return reply.code(404).send({ error: "TASK_OUTPUT_NOT_FOUND", message: "任务没有可下载文件" });
    const path = app.databaseTasks.output(request.params.id, request.admin!.id);
    if (!path) return reply.code(404).send({ error: "TASK_OUTPUT_NOT_FOUND", message: "任务没有可下载文件" });
    const info = await stat(path);
    reply.header("Content-Type", "application/sql; charset=utf-8");
    reply.header("Content-Length", String(info.size));
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`);
    return reply.send(createReadStream(path));
  });

  app.patch<{ Params: { id: string } }>("/api/v1/database-backups/:id", async (request, reply) => {
    const body = parseBody(backupNameSchema, request.body, reply);
    if (!body || !request.admin) return;
    const task = app.databaseTasks.get(request.params.id, request.admin.id, executionScope(request));
    if (!task?.connectionId || task.type !== "backup" || !await canAccessConnection(app.db, request.admin, "database", task.connectionId)) return reply.code(404).send({ error: "BACKUP_NOT_FOUND", message: "备份不存在" });
    try {
      const updated = await app.databaseTasks.renameBackup(task.id, request.admin.id, body.name);
      if (!updated) return reply.code(409).send({ error: "BACKUP_NOT_READY", message: "只有已完成的备份可以重命名" });
      await writeAudit(app.db, { action: "database.backup_renamed", resourceType: "database_connection", resourceId: task.connectionId, summary: `重命名备份为 ${body.name}`, request });
      return { task: updated };
    } catch (error) {
      return reply.code(409).send({ error: "BACKUP_RENAME_FAILED", message: error instanceof Error ? error.message : "无法重命名备份" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-backups/:id/duplicate", async (request, reply) => {
    const body = parseBody(backupNameSchema, request.body, reply);
    if (!body || !request.admin) return;
    const task = app.databaseTasks.get(request.params.id, request.admin.id, executionScope(request));
    if (!task?.connectionId || task.type !== "backup" || !await canAccessConnection(app.db, request.admin, "database", task.connectionId)) return reply.code(404).send({ error: "BACKUP_NOT_FOUND", message: "备份不存在" });
    try {
      const duplicate = await app.databaseTasks.duplicateBackup(task.id, request.admin.id, body.name);
      if (!duplicate) return reply.code(409).send({ error: "BACKUP_NOT_READY", message: "只有已完成的备份可以复制" });
      await writeAudit(app.db, { action: "database.backup_duplicated", resourceType: "database_connection", resourceId: task.connectionId, summary: `复制备份 ${task.title} 为 ${body.name}`, request });
      return reply.code(201).send({ task: duplicate });
    } catch (error) {
      return reply.code(409).send({ error: "BACKUP_DUPLICATE_FAILED", message: error instanceof Error ? error.message : "无法复制备份" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-backups/:id/restore", async (request, reply) => {
    const body = parseBody(backupRestoreSchema, request.body ?? {}, reply);
    if (!body || !request.admin) return;
    const task = app.databaseTasks.get(request.params.id, request.admin.id, executionScope(request));
    if (!task?.connectionId || task.type !== "backup" || !await canAccessConnection(app.db, request.admin, "database", task.connectionId)) return reply.code(404).send({ error: "BACKUP_NOT_FOUND", message: "备份不存在" });
    const path = app.databaseTasks.output(task.id, request.admin.id);
    if (!path) return reply.code(409).send({ error: "BACKUP_NOT_READY", message: "备份尚未完成或文件不可用" });
    const database = body.database || String(task.details.database ?? "");
    if (!database) return reply.code(400).send({ error: "INVALID_RESTORE", message: "备份缺少目标数据库" });
    try {
      const restore = await app.databaseTasks.createRestore(request.admin, task.connectionId, database, path, task.outputFilename || `${task.title}.sql`, executionScope(request));
      return reply.code(202).send({ task: restore });
    } catch (error) {
      return reply.code(429).send({ error: "TASK_START_FAILED", message: error instanceof Error ? error.message : "无法开始恢复任务" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-backups/:id", async (request, reply) => {
    const task = app.databaseTasks.get(request.params.id, request.admin!.id, executionScope(request));
    if (!task?.connectionId || task.type !== "backup" || !await canAccessConnection(app.db, request.admin!, "database", task.connectionId)) return reply.code(404).send({ error: "BACKUP_NOT_FOUND", message: "备份不存在" });
    const deleted = await app.databaseTasks.deleteBackup(task.id, request.admin!.id);
    if (!deleted) return reply.code(409).send({ error: "BACKUP_RUNNING", message: "运行中的备份不能删除，请先取消任务" });
    await writeAudit(app.db, { action: "database.backup_deleted", resourceType: "database_connection", resourceId: task.connectionId, summary: `删除备份 ${task.title}`, request });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/backup", async (request, reply) => {
    const body = parseBody(backupSchema, request.body, reply);
    if (!body || !request.admin) return;
    try { return reply.code(202).send({ task: await app.databaseTasks.createBackup(request.admin, request.params.id, body.database, executionScope(request), body.includeData) }); }
    catch (error) { return reply.code(429).send({ error: "TASK_START_FAILED", message: error instanceof Error ? error.message : "无法开始备份任务" }); }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/restore", async (request, reply) => {
    let database = "";
    let filename = "";
    let file: Buffer | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") { filename = part.filename; file = await part.toBuffer(); }
      else if (part.fieldname === "database") database = String(part.value);
    }
    if (!file || !filename || !database) return reply.code(400).send({ error: "INVALID_RESTORE", message: "请选择 SQL 文件和目标数据库" });
    if (!filename.toLowerCase().endsWith(".sql")) return reply.code(400).send({ error: "SQL_REQUIRED", message: "恢复任务只接受 .sql 文件" });
    const uploadDir = join(app.config.dataDir, "uploads");
    await mkdir(uploadDir, { recursive: true });
    const inputPath = join(uploadDir, `${randomUUID()}.sql`);
    await writeFile(inputPath, file, { mode: 0o600, flag: "wx" });
    try { return reply.code(202).send({ task: await app.databaseTasks.createRestore(request.admin!, request.params.id, database, inputPath, filename, executionScope(request)) }); }
    catch (error) { return reply.code(429).send({ error: "TASK_START_FAILED", message: error instanceof Error ? error.message : "无法开始恢复任务" }); }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/sync-preview", async (request, reply) => {
    const body = parseBody(syncPreviewSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.targetConnectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "目标数据库连接不存在" });
    if (request.params.id === body.targetConnectionId && body.sourceDatabase === body.targetDatabase) return reply.code(400).send({ error: "SAME_SYNC_TARGET", message: "源数据库和目标数据库不能相同" });
    try {
      const source = await connectDatabase(app, request.params.id, body.sourceDatabase);
      try {
        const target = await connectDatabase(app, body.targetConnectionId);
        try {
          return { preview: await previewDatabaseSync(source.connection, target.connection, body) };
        } finally {
          await target.close();
        }
      } finally {
        await source.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_SYNC_PREVIEW_FAILED", message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/sync", async (request, reply) => {
    const body = parseBody(syncStartSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.targetConnectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "目标数据库连接不存在" });
    if (request.params.id === body.targetConnectionId && body.sourceDatabase === body.targetDatabase) return reply.code(400).send({ error: "SAME_SYNC_TARGET", message: "源数据库和目标数据库不能相同" });
    if (body.mode === "data" && !body.data.insert && !body.data.update && !body.data.delete) return reply.code(400).send({ error: "EMPTY_DATA_SYNC", message: "请至少选择插入、更新或删除中的一项" });
    try {
      return reply.code(202).send({ task: await app.databaseTasks.createSync(request.admin, { sourceConnectionId: request.params.id, ...body }, executionScope(request)) });
    } catch (error) {
      return reply.code(429).send({ error: "TASK_START_FAILED", message: error instanceof Error ? error.message : "无法开始同步任务" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/transfer", async (request, reply) => {
    const body = parseBody(transferSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.targetConnectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "目标数据库连接不存在" });
    if (!body.includeStructure && !body.includeData) return reply.code(400).send({ error: "EMPTY_TRANSFER", message: "请至少选择结构或数据" });
    try {
      return reply.code(202).send({ task: await app.databaseTasks.createTransfer(request.admin, { sourceConnectionId: request.params.id, ...body }, executionScope(request)) });
    } catch (error) {
      return reply.code(429).send({ error: "TASK_START_FAILED", message: error instanceof Error ? error.message : "无法开始迁移任务" });
    }
  });
}
