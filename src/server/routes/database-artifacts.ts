import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { Cron } from "croner";
import { parse as parseCsv } from "csv-parse/sync";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { defaultDataSyncOptions, defaultStructureSyncOptions, previewDatabaseSync } from "../../database-sync.js";
import { canAccessConnection, type AuthenticatedUser, type WorkspaceContext } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { connectDatabase } from "../database-workbench/connector.js";
import { executionScope } from "../execution-scope.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const automationWorkSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["query", "backup", "transfer", "dataSync", "structureSync", "dataDictionary", "export", "import", "dataGeneration", "model"]),
  name: z.string().trim().min(1).max(255),
  config: z.record(z.string(), z.unknown()).default({}),
});

const automationSchema = z.object({
  connectionId: z.string().uuid(),
  database: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(160),
  works: z.array(automationWorkSchema).max(500),
  advanced: z.record(z.string(), z.unknown()).default({}),
  scheduleCron: z.string().trim().max(255).default(""),
  scheduleEnabled: z.boolean().default(false),
});

const modelSchema = z.object({
  connectionId: z.string().uuid().nullable().default(null),
  database: z.string().trim().max(255).default(""),
  name: z.string().trim().min(1).max(160),
  modelType: z.enum(["physical", "logical", "conceptual"]),
  databaseEngine: z.string().trim().min(1).max(64).default("MySQL"),
  databaseVersion: z.string().trim().min(1).max(32).default("8.1"),
  model: z.record(z.string(), z.unknown()),
});

const snippetSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).default(""),
  sql: z.string().min(1).max(2 * 1024 * 1024),
});

const biWorkspaceSchema = z.object({
  connectionId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(160),
  document: z.record(z.string(), z.unknown()),
});

interface AutomationWork {
  id: string;
  type: "query" | "backup" | "transfer" | "dataSync" | "structureSync" | "dataDictionary" | "export" | "import" | "dataGeneration" | "model";
  name: string;
  config: Record<string, unknown>;
}

interface AutomationRow extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  workspace_type: "personal" | "organization";
  workspace_id: string;
  connection_id: string;
  database_name: string;
  name: string;
  works_json: string;
  advanced_json: string;
  schedule_cron: string;
  schedule_enabled: number;
  status: string;
  logs_json: string;
  created_at: string;
  updated_at: string;
  accessed_at: string;
  last_run_at: string | null;
}

interface AutomationOutput {
  path: string;
  filename: string;
  contentType: string;
  createdAt: string;
}

const MAX_AUTOMATION_ROWS = 100_000;

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function automationFilename(value: string, extension: string): string {
  const stem = value.normalize("NFKC").replaceAll(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replaceAll(/^[._]+|[._]+$/g, "").trim() || "automation";
  return `${stem.replace(new RegExp(`${extension.replace(".", "\\.")}$`, "i"), "")}${extension}`;
}

function automaticValue(type: string, name: string, index: number, seed: number): unknown {
  const normalized = type.toLowerCase();
  if (["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double", "real"].includes(normalized)) return seed + index + 1;
  if (["date"].includes(normalized)) return new Date(Date.UTC(2020 + (seed % 6), index % 12, 1 + (index % 27))).toISOString().slice(0, 10);
  if (["datetime", "timestamp"].includes(normalized)) return new Date(Date.UTC(2020 + (seed % 6), index % 12, 1 + (index % 27), index % 24, index % 60)).toISOString().slice(0, 19).replace("T", " ");
  if (["time"].includes(normalized)) return `${String(index % 24).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`;
  if (["year"].includes(normalized)) return 2020 + ((seed + index) % 7);
  if (["json"].includes(normalized)) return JSON.stringify({ generated: true, index: index + 1 });
  if (["bit", "boolean", "bool"].includes(normalized)) return index % 2;
  return `${name}_${String(seed + index + 1).padStart(4, "0")}`;
}

function automationItem(row: AutomationRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    database: row.database_name,
    name: row.name,
    works: JSON.parse(row.works_json),
    advanced: JSON.parse(row.advanced_json),
    scheduleCron: row.schedule_cron,
    scheduleEnabled: Boolean(row.schedule_enabled),
    status: row.status,
    logs: JSON.parse(row.logs_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    lastRunAt: row.last_run_at,
  };
}

function modelItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    database: row.database_name,
    name: row.name,
    modelType: row.model_type,
    databaseEngine: row.database_engine,
    databaseVersion: row.database_version,
    model: JSON.parse(String(row.model_json)),
    ownerName: row.owner_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
  };
}

function snippetItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sql: row.sql_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function biWorkspaceItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    document: JSON.parse(String(row.document_json)),
    ownerName: row.owner_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
  };
}

async function scheduledUser(app: FastifyInstance, row: AutomationRow): Promise<AuthenticatedUser | null> {
  const user = await app.db.prepare("SELECT id, username, is_platform_admin, status FROM admin_users WHERE id = ?").get(row.owner_user_id) as { id: string; username: string; is_platform_admin: number; status: string } | undefined;
  if (!user || user.status !== "active") return null;
  let workspace: WorkspaceContext;
  if (row.workspace_type === "personal") workspace = { type: "personal", id: user.id, name: "个人工作台", role: "owner" };
  else {
    const organization = await app.db.prepare(`
      SELECT o.name, m.role FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
      WHERE o.id = ? AND m.user_id = ?
    `).get(row.workspace_id, user.id) as { name: string; role: "admin" | "member" } | undefined;
    if (!organization) return null;
    workspace = { type: "organization", id: row.workspace_id, name: organization.name, role: organization.role };
  }
  return { id: user.id, username: user.username, isPlatformAdmin: Boolean(user.is_platform_admin), workspace };
}

async function waitForQuery(app: FastifyInstance, id: string, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 7_200; attempt += 1) {
    const job = app.databaseQueries.get(id, userId, null);
    if (!job) throw new Error("查询任务不存在或已过期");
    if (!["pending", "running"].includes(job.status)) {
      if (job.status !== "success") throw new Error(job.error || "查询执行失败");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("查询执行超时");
}

async function waitForTask(app: FastifyInstance, id: string, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 7_200; attempt += 1) {
    const task = app.databaseTasks.get(id, userId, null);
    if (!task) throw new Error("数据库任务不存在或已过期");
    if (!["pending", "running"].includes(task.status)) {
      if (task.status !== "success") throw new Error(task.error || "数据库任务失败");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("数据库任务执行超时");
}

async function exportAutomationTable(app: FastifyInstance, row: AutomationRow, work: AutomationWork): Promise<AutomationOutput> {
  const database = String(work.config.database ?? row.database_name).trim();
  const table = String(work.config.table ?? "").trim();
  const format = work.config.format === "sql" ? "sql" : "csv";
  const includeData = work.config.includeData !== false;
  if (!database || !table) throw new Error(`导出工作“${work.name}”缺少数据库或数据表`);
  const connected = await connectDatabase(app, row.connection_id, database);
  try {
    const [rows, fields] = format === "sql" && !includeData
      ? [[], []]
      : await connected.connection.query<RowDataPacket[]>(`SELECT * FROM ${identifier(database)}.${identifier(table)} LIMIT ?`, [MAX_AUTOMATION_ROWS + 1]);
    if (rows.length > MAX_AUTOMATION_ROWS) throw new Error(`自动导出最多 ${MAX_AUTOMATION_ROWS.toLocaleString()} 行`);
    const headers = (fields as unknown as Array<{ name: string }>).map((field) => field.name);
    let data: Buffer;
    let contentType: string;
    if (format === "csv") {
      data = Buffer.from([`\uFEFF${headers.map(csvCell).join(",")}`, ...rows.map((item) => headers.map((header) => csvCell(item[header])).join(","))].join("\r\n"), "utf8");
      contentType = "text/csv; charset=utf-8";
    } else {
      const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(database)}.${identifier(table)}`);
      const createSql = String(Object.entries(createRows[0] ?? {}).find(([key]) => key.toLowerCase().includes("create"))?.[1] ?? "");
      const statements = ["-- Viron automation table export", `DROP TABLE IF EXISTS ${identifier(table)};`, `${createSql};`];
      for (let index = 0; includeData && index < rows.length; index += 250) {
        const chunk = rows.slice(index, index + 250);
        const values = chunk.map((item) => `(${headers.map((header) => connected.connection.escape(item[header])).join(",")})`).join(",\n");
        statements.push(`INSERT INTO ${identifier(table)} (${headers.map(identifier).join(",")}) VALUES\n${values};`);
      }
      data = Buffer.from(statements.join("\n\n"), "utf8");
      contentType = "application/sql; charset=utf-8";
    }
    const directory = join(app.config.dataDir, "database-automation-outputs", row.owner_user_id, row.id);
    await mkdir(directory, { recursive: true });
    const filename = automationFilename(`${database}.${table}`, `.${format}`);
    const path = join(directory, `${work.id}-${filename}`);
    await writeFile(path, data, { mode: 0o600 });
    return { path, filename, contentType, createdAt: new Date().toISOString() };
  } finally {
    await connected.close();
  }
}

async function importAutomationTable(app: FastifyInstance, row: AutomationRow, work: AutomationWork): Promise<number> {
  const database = String(work.config.database ?? row.database_name).trim();
  const table = String(work.config.table ?? "").trim();
  const filename = String(work.config.filename ?? "");
  const encoded = String(work.config.contentBase64 ?? "");
  if (!database || !table || !filename || !encoded) throw new Error(`导入工作“${work.name}”缺少数据库、数据表或文件`);
  if (!filename.toLowerCase().endsWith(".csv")) throw new Error("自动导入当前只支持 CSV 文件");
  const file = Buffer.from(encoded, "base64");
  if (!file.length || file.length > 1_500_000) throw new Error("自动导入文件必须小于 1.5 MB");
  const rows = parseCsv(file, { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true }) as Array<Record<string, unknown>>;
  if (rows.length > MAX_AUTOMATION_ROWS) throw new Error(`自动导入最多 ${MAX_AUTOMATION_ROWS.toLocaleString()} 行`);
  const connected = await connectDatabase(app, row.connection_id, database);
  try {
    const [columnRows] = await connected.connection.query<RowDataPacket[]>(`
      SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
    `, [database, table]);
    const allowed = new Set(columnRows.map((column) => String(column.name)));
    const headers = Object.keys(rows[0] ?? {}).filter((name) => allowed.has(name));
    if (!headers.length) throw new Error("导入文件的列名与目标数据表不匹配");
    await connected.connection.beginTransaction();
    try {
      if (work.config.mode === "replace") await connected.connection.query(`DELETE FROM ${identifier(database)}.${identifier(table)}`);
      for (let index = 0; index < rows.length; index += 500) {
        const values = rows.slice(index, index + 500).map((item) => headers.map((header) => item[header]));
        if (values.length) await connected.connection.query(`INSERT INTO ${identifier(database)}.${identifier(table)} (${headers.map(identifier).join(",")}) VALUES ?`, [values]);
      }
      await connected.connection.commit();
    } catch (error) {
      await connected.connection.rollback();
      throw error;
    }
    return rows.length;
  } finally {
    await connected.close();
  }
}

async function generateAutomationData(app: FastifyInstance, row: AutomationRow, work: AutomationWork): Promise<number> {
  const database = String(work.config.database ?? row.database_name).trim();
  const table = String(work.config.table ?? "").trim();
  const rowCount = Math.max(1, Math.min(10_000, Number(work.config.rowCount ?? 100)));
  const seed = Math.max(0, Math.floor(Number(work.config.seed ?? 1)));
  if (!database || !table) throw new Error(`数据生成工作“${work.name}”缺少数据库或数据表`);
  const connected = await connectDatabase(app, row.connection_id, database);
  try {
    const [columns] = await connected.connection.query<RowDataPacket[]>(`
      SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS nullable, EXTRA AS extra
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
    `, [database, table]);
    const generated = columns
      .filter((column) => !String(column.extra ?? "").toLowerCase().includes("auto_increment"))
      .map((column) => ({ name: String(column.name), dataType: String(column.dataType), nullable: String(column.nullable) === "YES" }));
    if (!generated.length) throw new Error("目标数据表没有可生成的字段");
    await connected.connection.beginTransaction();
    try {
      for (let offset = 0; offset < rowCount; offset += 250) {
        const count = Math.min(250, rowCount - offset);
        const values = Array.from({ length: count }, (_, itemIndex) => generated.map((column) => automaticValue(column.dataType, column.name, offset + itemIndex, seed)));
        await connected.connection.query(`INSERT INTO ${identifier(database)}.${identifier(table)} (${generated.map((column) => identifier(column.name)).join(",")}) VALUES ?`, [values]);
      }
      await connected.connection.commit();
    } catch (error) {
      await connected.connection.rollback();
      throw error;
    }
    return rowCount;
  } finally {
    await connected.close();
  }
}

async function executeAutomation(app: FastifyInstance, row: AutomationRow, user: AuthenticatedUser): Promise<void> {
  const logs: string[] = [];
  const advanced = JSON.parse(row.advanced_json || "{}") as Record<string, unknown>;
  const outputs = (advanced.outputs && typeof advanced.outputs === "object" ? advanced.outputs : {}) as Record<string, AutomationOutput>;
  const now = new Date().toISOString();
  await app.db.prepare("UPDATE database_automation_jobs SET status = 'running', logs_json = ?, last_run_at = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(logs), now, now, row.id);
  try {
    if (!await canAccessConnection(app.db, user, "database", row.connection_id)) throw new Error("无权访问批处理作业的数据库连接");
    const works = JSON.parse(row.works_json) as AutomationWork[];
    for (const work of works) {
      logs.push(`开始：${work.name}`);
      await app.db.prepare("UPDATE database_automation_jobs SET logs_json = ? WHERE id = ?").run(JSON.stringify(logs.slice(-500)), row.id);
      if (work.type === "query") {
        const saved = await app.db.prepare("SELECT sql_text, database_name FROM database_saved_queries WHERE id = ? AND owner_user_id = ?").get(String(work.config.savedQueryId ?? ""), user.id) as { sql_text: string; database_name: string } | undefined;
        if (!saved) throw new Error(`查询工作不存在：${work.name}`);
        const job = await app.databaseQueries.create(user, row.connection_id, saved.sql_text, saved.database_name || row.database_name, null);
        await waitForQuery(app, job.id, user.id);
      } else if (work.type === "backup") {
        const task = await app.databaseTasks.createBackup(user, row.connection_id, String(work.config.database ?? row.database_name), null, work.config.includeData !== false);
        await waitForTask(app, task.id, user.id);
      } else if (work.type === "transfer") {
        const targetConnectionId = String(work.config.targetConnectionId ?? "");
        const targetDatabase = String(work.config.targetDatabase ?? "");
        if (!targetConnectionId || !targetDatabase || !await canAccessConnection(app.db, user, "database", targetConnectionId)) throw new Error(`数据传输“${work.name}”的目标配置无效`);
        const task = await app.databaseTasks.createTransfer(user, {
          sourceConnectionId: row.connection_id,
          sourceDatabase: row.database_name,
          targetConnectionId,
          targetDatabase,
          includeStructure: work.config.includeStructure !== false,
          includeData: work.config.includeData !== false,
          includeObjects: work.config.includeObjects !== false,
          dropExisting: work.config.dropExisting === true,
        }, null);
        await waitForTask(app, task.id, user.id);
      } else if (work.type === "dataSync" || work.type === "structureSync") {
        const targetConnectionId = String(work.config.targetConnectionId ?? "");
        const targetDatabase = String(work.config.targetDatabase ?? "");
        if (!targetConnectionId || !targetDatabase || !await canAccessConnection(app.db, user, "database", targetConnectionId)) throw new Error(`同步工作“${work.name}”的目标配置无效`);
        const mode = work.type === "dataSync" ? "data" : "structure";
        const options = { mode, sourceDatabase: row.database_name, targetDatabase, data: defaultDataSyncOptions(), structure: defaultStructureSyncOptions() } as const;
        const [source, target] = await Promise.all([connectDatabase(app, row.connection_id, row.database_name), connectDatabase(app, targetConnectionId, targetDatabase)]);
        let selectedItems: string[];
        try {
          const preview = await previewDatabaseSync(source.connection, target.connection, options);
          selectedItems = preview.items.filter((item) => item.action !== "none" && item.status !== "blocked").map((item) => item.id);
        } finally {
          await Promise.allSettled([source.close(), target.close()]);
        }
        if (!selectedItems.length) {
          logs.push(`跳过：${work.name} 没有差异`);
          continue;
        }
        const task = await app.databaseTasks.createSync(user, { sourceConnectionId: row.connection_id, targetConnectionId, selectedItems, ...options }, null);
        await waitForTask(app, task.id, user.id);
      } else if (work.type === "dataDictionary") {
        const job = await app.databaseQueries.create(user, row.connection_id, `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`, String(work.config.database ?? row.database_name), null);
        await waitForQuery(app, job.id, user.id);
      } else if (work.type === "model") {
        const result = await app.db.prepare("UPDATE database_models SET accessed_at = ? WHERE id = ? AND owner_user_id = ?").run(new Date().toISOString(), String(work.config.modelId ?? ""), user.id);
        if (!result.changes) throw new Error(`模型工作不存在：${work.name}`);
      } else if (work.type === "export") {
        const output = await exportAutomationTable(app, row, work);
        outputs[work.id] = output;
        advanced.outputs = outputs;
        await app.db.prepare("UPDATE database_automation_jobs SET advanced_json = ? WHERE id = ?").run(JSON.stringify(advanced), row.id);
        logs.push(`输出：${output.filename}`);
      } else if (work.type === "import") {
        logs.push(`导入：${await importAutomationTable(app, row, work)} 行`);
      } else if (work.type === "dataGeneration") {
        logs.push(`生成：${await generateAutomationData(app, row, work)} 行`);
      }
      logs.push(`完成：${work.name}`);
    }
    const completed = new Date().toISOString();
    await app.db.prepare("UPDATE database_automation_jobs SET status = 'success', logs_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(logs.slice(-500)), completed, row.id);
  } catch (error) {
    logs.push(`失败：${error instanceof Error ? error.message : String(error)}`);
    await app.db.prepare("UPDATE database_automation_jobs SET status = 'error', logs_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(logs.slice(-500)), new Date().toISOString(), row.id);
  }
}

export async function registerDatabaseArtifactRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  const schedules = new Map<string, Cron>();

  const configureSchedule = async (row: AutomationRow) => {
    schedules.get(row.id)?.stop();
    schedules.delete(row.id);
    if (!row.schedule_enabled || !row.schedule_cron) return;
    try {
      const cron = new Cron(row.schedule_cron, async () => {
        const current = await app.db.prepare("SELECT * FROM database_automation_jobs WHERE id = ?").get(row.id) as AutomationRow | undefined;
        if (!current || current.status === "running") return;
        const user = await scheduledUser(app, current);
        if (user) void executeAutomation(app, current, user);
      });
      schedules.set(row.id, cron);
    } catch {
      await app.db.prepare("UPDATE database_automation_jobs SET schedule_enabled = 0 WHERE id = ?").run(row.id);
      row.schedule_enabled = 0;
    }
  };

  const scheduledRows = await app.db.prepare("SELECT * FROM database_automation_jobs WHERE schedule_enabled = 1").all() as AutomationRow[];
  for (const row of scheduledRows) await configureSchedule(row);
  app.addHook("onClose", async () => {
    for (const schedule of schedules.values()) schedule.stop();
    schedules.clear();
  });

  app.get<{ Querystring: { connectionId?: string } }>("/api/v1/database-automations", async (request) => {
    const rows = request.query.connectionId
      ? await app.db.prepare("SELECT * FROM database_automation_jobs WHERE owner_user_id = ? AND workspace_type = ? AND workspace_id = ? AND connection_id = ? ORDER BY name").all(request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id, request.query.connectionId)
      : await app.db.prepare("SELECT * FROM database_automation_jobs WHERE owner_user_id = ? AND workspace_type = ? AND workspace_id = ? ORDER BY name").all(request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    return { items: (rows as AutomationRow[]).map(automationItem) };
  });

  app.post("/api/v1/database-automations", async (request, reply) => {
    const body = parseBody(automationSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        INSERT INTO database_automation_jobs (
          id, owner_user_id, workspace_type, workspace_id, connection_id, database_name, name, works_json,
          advanced_json, schedule_cron, schedule_enabled, status, logs_json, created_at, updated_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', '[]', ?, ?, ?)
      `).run(id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id, body.connectionId, body.database, body.name, JSON.stringify(body.works), JSON.stringify(body.advanced), body.scheduleCron, body.scheduleEnabled ? 1 : 0, now, now, now);
    } catch {
      return reply.code(409).send({ error: "AUTOMATION_NAME_CONFLICT", message: `批处理作业“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT * FROM database_automation_jobs WHERE id = ?").get(id) as AutomationRow;
    await configureSchedule(row);
    return reply.code(201).send({ item: automationItem(row) });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-automations/:id", async (request, reply) => {
    const body = parseBody(automationSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const now = new Date().toISOString();
    try {
      const result = await app.db.prepare(`
        UPDATE database_automation_jobs SET connection_id = ?, database_name = ?, name = ?, works_json = ?, advanced_json = ?,
          schedule_cron = ?, schedule_enabled = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?
      `).run(body.connectionId, body.database, body.name, JSON.stringify(body.works), JSON.stringify(body.advanced), body.scheduleCron, body.scheduleEnabled ? 1 : 0, now, request.params.id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id);
      if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "批处理作业不存在" });
    } catch {
      return reply.code(409).send({ error: "AUTOMATION_NAME_CONFLICT", message: `批处理作业“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT * FROM database_automation_jobs WHERE id = ?").get(request.params.id) as AutomationRow;
    await configureSchedule(row);
    return { item: automationItem(row) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-automations/:id/run", async (request, reply) => {
    const row = await app.db.prepare("SELECT * FROM database_automation_jobs WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?").get(request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id) as AutomationRow | undefined;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "批处理作业不存在" });
    if (row.status === "running") return reply.code(409).send({ error: "AUTOMATION_RUNNING", message: "批处理作业正在运行" });
    void executeAutomation(app, row, request.admin!);
    return reply.code(202).send({ ok: true });
  });

  app.get<{ Params: { id: string; workId: string } }>("/api/v1/database-automations/:id/outputs/:workId", async (request, reply) => {
    const row = await app.db.prepare("SELECT advanced_json FROM database_automation_jobs WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .get(request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id) as { advanced_json: string } | undefined;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "批处理作业不存在" });
    const advanced = JSON.parse(row.advanced_json || "{}") as { outputs?: Record<string, AutomationOutput> };
    const output = advanced.outputs?.[request.params.workId];
    if (!output) return reply.code(404).send({ error: "AUTOMATION_OUTPUT_NOT_FOUND", message: "工作没有可下载输出" });
    const outputRoot = resolve(app.config.dataDir, "database-automation-outputs") + sep;
    const outputPath = resolve(output.path);
    if (!outputPath.startsWith(outputRoot)) return reply.code(404).send({ error: "AUTOMATION_OUTPUT_NOT_FOUND", message: "工作输出路径无效" });
    try {
      const info = await stat(outputPath);
      reply.header("Content-Type", output.contentType);
      reply.header("Content-Length", String(info.size));
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(basename(output.filename))}`);
      return reply.send(createReadStream(outputPath));
    } catch {
      return reply.code(404).send({ error: "AUTOMATION_OUTPUT_NOT_FOUND", message: "工作输出文件不存在" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-automations/:id/schedule", async (request, reply) => {
    const result = await app.db.prepare("UPDATE database_automation_jobs SET schedule_cron = '', schedule_enabled = 0, updated_at = ? WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(new Date().toISOString(), request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "批处理作业不存在" });
    schedules.get(request.params.id)?.stop();
    schedules.delete(request.params.id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-automations/:id", async (request, reply) => {
    const result = await app.db.prepare("DELETE FROM database_automation_jobs WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "批处理作业不存在" });
    schedules.get(request.params.id)?.stop();
    schedules.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { connectionId?: string } }>("/api/v1/database-models", async (request) => {
    const values: unknown[] = [request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id];
    const connectionFilter = request.query.connectionId ? " AND m.connection_id = ?" : "";
    if (request.query.connectionId) values.push(request.query.connectionId);
    const rows = await app.db.prepare(`
      SELECT m.*, u.username AS owner_name FROM database_models m
      JOIN admin_users u ON u.id = m.owner_user_id
      WHERE m.owner_user_id = ? AND m.workspace_type = ? AND m.workspace_id = ?${connectionFilter}
      ORDER BY m.name
    `).all(...values) as Record<string, unknown>[];
    return { items: rows.map(modelItem) };
  });

  app.post("/api/v1/database-models", async (request, reply) => {
    const body = parseBody(modelSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (body.connectionId && !await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        INSERT INTO database_models (
          id, owner_user_id, workspace_type, workspace_id, connection_id, database_name, name, model_type,
          database_engine, database_version, model_json, created_at, updated_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id, body.connectionId, body.database, body.name, body.modelType, body.databaseEngine, body.databaseVersion, JSON.stringify(body.model), now, now, now);
    } catch {
      return reply.code(409).send({ error: "MODEL_NAME_CONFLICT", message: `模型“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT m.*, u.username AS owner_name FROM database_models m JOIN admin_users u ON u.id = m.owner_user_id WHERE m.id = ?").get(id) as Record<string, unknown>;
    return reply.code(201).send({ item: modelItem(row) });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-models/:id", async (request, reply) => {
    const body = parseBody(modelSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (body.connectionId && !await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const now = new Date().toISOString();
    try {
      const result = await app.db.prepare(`
        UPDATE database_models SET connection_id = ?, database_name = ?, name = ?, model_type = ?, database_engine = ?,
          database_version = ?, model_json = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?
      `).run(body.connectionId, body.database, body.name, body.modelType, body.databaseEngine, body.databaseVersion, JSON.stringify(body.model), now, request.params.id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id);
      if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "模型不存在" });
    } catch {
      return reply.code(409).send({ error: "MODEL_NAME_CONFLICT", message: `模型“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT m.*, u.username AS owner_name FROM database_models m JOIN admin_users u ON u.id = m.owner_user_id WHERE m.id = ?").get(request.params.id) as Record<string, unknown>;
    return { item: modelItem(row) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-models/:id/access", async (request, reply) => {
    const accessedAt = new Date().toISOString();
    const result = await app.db.prepare("UPDATE database_models SET accessed_at = ? WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(accessedAt, request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "模型不存在" });
    return { accessedAt };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-models/:id", async (request, reply) => {
    const result = await app.db.prepare("DELETE FROM database_models WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "模型不存在" });
    await writeAudit(app.db, { action: "database.model_deleted", resourceType: "database_model", resourceId: request.params.id, summary: "删除数据库模型", request });
    return reply.code(204).send();
  });

  app.get("/api/v1/database-code-snippets", async (request) => {
    const rows = await app.db.prepare(`
      SELECT * FROM database_code_snippets
      WHERE owner_user_id = ? AND workspace_type = ? AND workspace_id = ?
      ORDER BY name
    `).all(request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id) as Record<string, unknown>[];
    return { items: rows.map(snippetItem) };
  });

  app.post("/api/v1/database-code-snippets", async (request, reply) => {
    const body = parseBody(snippetSchema, request.body, reply);
    if (!body || !request.admin) return;
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        INSERT INTO database_code_snippets (id, owner_user_id, workspace_type, workspace_id, name, description, sql_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id, body.name, body.description, body.sql, now, now);
    } catch {
      return reply.code(409).send({ error: "SNIPPET_NAME_CONFLICT", message: `代码段“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT * FROM database_code_snippets WHERE id = ?").get(id) as Record<string, unknown>;
    return reply.code(201).send({ item: snippetItem(row) });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-code-snippets/:id", async (request, reply) => {
    const body = parseBody(snippetSchema, request.body, reply);
    if (!body || !request.admin) return;
    try {
      const result = await app.db.prepare(`
        UPDATE database_code_snippets SET name = ?, description = ?, sql_text = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?
      `).run(body.name, body.description, body.sql, new Date().toISOString(), request.params.id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id);
      if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "代码段不存在" });
    } catch {
      return reply.code(409).send({ error: "SNIPPET_NAME_CONFLICT", message: `代码段“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT * FROM database_code_snippets WHERE id = ?").get(request.params.id) as Record<string, unknown>;
    return { item: snippetItem(row) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-code-snippets/:id", async (request, reply) => {
    const result = await app.db.prepare("DELETE FROM database_code_snippets WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "代码段不存在" });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { connectionId?: string } }>("/api/v1/database-bi-workspaces", async (request) => {
    const values: unknown[] = [request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id];
    const filter = request.query.connectionId ? " AND b.connection_id = ?" : "";
    if (request.query.connectionId) values.push(request.query.connectionId);
    const rows = await app.db.prepare(`
      SELECT b.*, u.username AS owner_name FROM database_bi_workspaces b
      JOIN admin_users u ON u.id = b.owner_user_id
      WHERE b.owner_user_id = ? AND b.workspace_type = ? AND b.workspace_id = ?${filter}
      ORDER BY b.name
    `).all(...values) as Record<string, unknown>[];
    return { items: rows.map(biWorkspaceItem) };
  });

  app.post("/api/v1/database-bi-workspaces", async (request, reply) => {
    const body = parseBody(biWorkspaceSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (body.connectionId && !await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        INSERT INTO database_bi_workspaces (id, owner_user_id, workspace_type, workspace_id, connection_id, name, document_json, created_at, updated_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id, body.connectionId, body.name, JSON.stringify(body.document), now, now, now);
    } catch {
      return reply.code(409).send({ error: "BI_NAME_CONFLICT", message: `BI 工作区“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT b.*, u.username AS owner_name FROM database_bi_workspaces b JOIN admin_users u ON u.id = b.owner_user_id WHERE b.id = ?").get(id) as Record<string, unknown>;
    return reply.code(201).send({ item: biWorkspaceItem(row) });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-bi-workspaces/:id", async (request, reply) => {
    const body = parseBody(biWorkspaceSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (body.connectionId && !await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    try {
      const result = await app.db.prepare(`
        UPDATE database_bi_workspaces SET connection_id = ?, name = ?, document_json = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?
      `).run(body.connectionId, body.name, JSON.stringify(body.document), new Date().toISOString(), request.params.id, request.admin.id, request.admin.workspace.type, request.admin.workspace.id);
      if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "BI 工作区不存在" });
    } catch {
      return reply.code(409).send({ error: "BI_NAME_CONFLICT", message: `BI 工作区“${body.name}”已存在` });
    }
    const row = await app.db.prepare("SELECT b.*, u.username AS owner_name FROM database_bi_workspaces b JOIN admin_users u ON u.id = b.owner_user_id WHERE b.id = ?").get(request.params.id) as Record<string, unknown>;
    return { item: biWorkspaceItem(row) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-bi-workspaces/:id/access", async (request, reply) => {
    const accessedAt = new Date().toISOString();
    const result = await app.db.prepare("UPDATE database_bi_workspaces SET accessed_at = ? WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(accessedAt, request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "BI 工作区不存在" });
    return { accessedAt };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-bi-workspaces/:id", async (request, reply) => {
    const result = await app.db.prepare("DELETE FROM database_bi_workspaces WHERE id = ? AND owner_user_id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(request.params.id, request.admin!.id, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "BI 工作区不存在" });
    await writeAudit(app.db, { action: "database.bi_workspace_deleted", resourceType: "database_bi_workspace", resourceId: request.params.id, summary: "删除 BI 工作区", request });
    return reply.code(204).send();
  });
}
