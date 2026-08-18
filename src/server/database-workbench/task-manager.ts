import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { executeDatabaseSync, type DatabaseSyncOptions } from "../../database-sync.js";
import type { AuthenticatedUser, WorkspaceType } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { connectDatabase, type ConnectedDatabase } from "./connector.js";

export type DatabaseTaskType = "backup" | "restore" | "transfer" | "import";
export type DatabaseTaskStatus = "pending" | "running" | "success" | "error" | "cancelled";

interface DatabaseTask {
  id: string;
  ownerId: string;
  executionScope: string | null;
  workspaceType: WorkspaceType;
  workspaceId: string;
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
  active: Set<ConnectedDatabase>;
}

export interface PublicDatabaseTask extends Omit<DatabaseTask, "active" | "outputPath" | "ownerId" | "executionScope" | "workspaceType" | "workspaceId"> {
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

const TASK_LOG_LIMIT = 500;
const BACKUP_BOUNDARY = "\n-- ENVMAN_STATEMENT_BOUNDARY\n";

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
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

function errorMessage(error: unknown): string {
  const value = error as { sqlMessage?: string; message?: string };
  return value.sqlMessage || value.message || String(error);
}

function isCancelled(task: DatabaseTask): boolean {
  return task.status === "cancelled";
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

export class DatabaseTaskManager {
  private readonly tasks = new Map<string, DatabaseTask>();

  constructor(private readonly app: FastifyInstance) {}

  async initialize(): Promise<void> {
    const rows = await this.app.db.prepare("SELECT * FROM database_tasks ORDER BY created_at DESC LIMIT 200").all() as Record<string, unknown>[];
    for (const row of rows) {
      const status = ["pending", "running"].includes(String(row.status)) ? "error" : String(row.status) as DatabaseTaskStatus;
      const task: DatabaseTask = {
        id: String(row.id),
        ownerId: String(row.owner_user_id ?? ""),
        executionScope: null,
        workspaceType: "personal",
        workspaceId: String(row.owner_user_id ?? ""),
        type: row.type as DatabaseTaskType,
        connectionId: row.connection_id ? String(row.connection_id) : null,
        status,
        progress: Number(row.progress),
        title: String(row.title),
        details: JSON.parse(String(row.details_json)),
        logs: JSON.parse(String(row.logs_json)),
        outputPath: row.output_path ? String(row.output_path) : null,
        error: status === "error" && ["pending", "running"].includes(String(row.status)) ? "Viron 重启导致任务中断" : String(row.error_message),
        createdAt: String(row.created_at),
        startedAt: row.started_at ? String(row.started_at) : undefined,
        completedAt: row.completed_at ? String(row.completed_at) : undefined,
        active: new Set(),
      };
      this.tasks.set(task.id, task);
      if (status === "error" && status !== row.status) await this.persist(task);
    }
  }

  async createBackup(user: AuthenticatedUser, connectionId: string, database: string, executionScope: string | null = null, includeData = true): Promise<PublicDatabaseTask> {
    const task = await this.createTask(user, "backup", connectionId, `${includeData ? "备份" : "备份结构"} ${database}`, { database, includeData }, executionScope);
    void this.run(task, () => this.backup(task, connectionId, database, includeData));
    return this.publicTask(task);
  }

  async createRestore(user: AuthenticatedUser, connectionId: string, database: string, inputPath: string, originalFilename: string, executionScope: string | null = null): Promise<PublicDatabaseTask> {
    const task = await this.createTask(user, "restore", connectionId, `恢复 ${database}`, { database, originalFilename }, executionScope);
    void this.run(task, () => this.restore(task, connectionId, database, inputPath));
    return this.publicTask(task);
  }

  async createTransfer(user: AuthenticatedUser, options: TransferOptions, executionScope: string | null = null): Promise<PublicDatabaseTask> {
    const task = await this.createTask(user, "transfer", options.sourceConnectionId, `迁移 ${options.sourceDatabase} → ${options.targetDatabase}`, {
      sourceDatabase: options.sourceDatabase,
      targetDatabase: options.targetDatabase,
      targetConnectionId: options.targetConnectionId,
      includeStructure: options.includeStructure,
      includeData: options.includeData,
      includeObjects: options.includeObjects,
      dropExisting: options.dropExisting,
      tableCount: options.tables?.length ?? null,
    }, executionScope);
    void this.run(task, () => this.transfer(task, options));
    return this.publicTask(task);
  }

  async createSync(user: AuthenticatedUser, options: SyncTaskOptions, executionScope: string | null = null): Promise<PublicDatabaseTask> {
    const label = options.mode === "data" ? "数据同步" : "结构同步";
    const task = await this.createTask(user, "transfer", options.sourceConnectionId, `${label} ${options.sourceDatabase} → ${options.targetDatabase}`, {
      syncMode: options.mode,
      sourceDatabase: options.sourceDatabase,
      targetDatabase: options.targetDatabase,
      targetConnectionId: options.targetConnectionId,
      selectedCount: options.selectedItems.length,
      data: options.data,
      structure: options.structure,
    }, executionScope);
    void this.run(task, () => this.sync(task, options));
    return this.publicTask(task);
  }

  list(ownerId: string, executionScope: string | null = null): PublicDatabaseTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.ownerId === ownerId && (!["pending", "running"].includes(task.status) || task.executionScope === executionScope))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => this.publicTask(task));
  }

  get(id: string, ownerId: string, executionScope: string | null = null): PublicDatabaseTask | undefined {
    const task = this.tasks.get(id);
    return task?.ownerId === ownerId && (!["pending", "running"].includes(task.status) || task.executionScope === executionScope) ? this.publicTask(task) : undefined;
  }

  activeCount(ownerId: string, executionScope: string | null): number {
    return [...this.tasks.values()].filter((task) => task.ownerId === ownerId && task.executionScope === executionScope && ["pending", "running"].includes(task.status)).length;
  }

  output(id: string, ownerId: string): string | null {
    const task = this.tasks.get(id);
    return task?.ownerId === ownerId && task.status === "success" ? task.outputPath : null;
  }

  async renameBackup(id: string, ownerId: string, name: string): Promise<PublicDatabaseTask | null> {
    const task = this.tasks.get(id);
    if (!task || task.ownerId !== ownerId || task.type !== "backup" || task.status !== "success" || !task.outputPath) return null;
    const cleanName = name.trim().replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff ]/g, "_").slice(0, 160);
    if (!cleanName) return null;
    const extension = extname(task.outputPath) || ".sql";
    const nextPath = join(dirname(task.outputPath), `${cleanName.replace(/\.sql$/i, "")}${extension}`);
    if (nextPath !== task.outputPath) await rename(task.outputPath, nextPath);
    task.title = cleanName;
    task.outputPath = nextPath;
    await this.persist(task);
    return this.publicTask(task);
  }

  async duplicateBackup(id: string, ownerId: string, name: string): Promise<PublicDatabaseTask | null> {
    const source = this.tasks.get(id);
    if (!source || source.ownerId !== ownerId || source.type !== "backup" || source.status !== "success" || !source.outputPath) return null;
    const cleanName = name.trim().replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff ]/g, "_").slice(0, 160);
    if (!cleanName) return null;
    const extension = extname(source.outputPath) || ".sql";
    const outputPath = join(dirname(source.outputPath), `${cleanName.replace(/\.sql$/i, "")}-${randomUUID().slice(0, 8)}${extension}`);
    await copyFile(source.outputPath, outputPath);
    const now = new Date().toISOString();
    const task: DatabaseTask = {
      id: randomUUID(),
      ownerId: source.ownerId,
      executionScope: null,
      workspaceType: source.workspaceType,
      workspaceId: source.workspaceId,
      type: "backup",
      connectionId: source.connectionId,
      status: "success",
      progress: 100,
      title: cleanName,
      details: { ...source.details, copiedFromId: source.id },
      logs: [`从备份 ${source.title} 创建副本`],
      outputPath,
      error: "",
      createdAt: now,
      startedAt: now,
      completedAt: now,
      active: new Set(),
    };
    this.tasks.set(task.id, task);
    await this.persist(task, true);
    return this.publicTask(task);
  }

  async deleteBackup(id: string, ownerId: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || task.ownerId !== ownerId || task.type !== "backup" || ["pending", "running"].includes(task.status)) return false;
    if (task.outputPath) await unlink(task.outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.tasks.delete(id);
    await this.app.db.prepare("DELETE FROM database_tasks WHERE id = ? AND owner_user_id = ?").run(id, ownerId);
    return true;
  }

  async cancel(id: string, ownerId: string, executionScope: string | null = null): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || task.ownerId !== ownerId || task.executionScope !== executionScope || !["pending", "running"].includes(task.status)) return false;
    task.status = "cancelled";
    task.error = "任务已由管理员取消";
    task.completedAt = new Date().toISOString();
    for (const connected of task.active) connected.connection.destroy();
    this.log(task, "任务取消请求已发送");
    await this.persist(task);
    return true;
  }

  async closeAll(): Promise<void> {
    const updates: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      if (["pending", "running"].includes(task.status)) {
        task.status = "error";
        task.error = "Viron 服务停止导致任务中断";
        task.completedAt = new Date().toISOString();
        for (const connected of task.active) connected.connection.destroy();
        updates.push(this.persist(task));
      }
    }
    await Promise.all(updates);
  }

  async closeOwner(ownerId: string, executionScope?: string | null): Promise<void> {
    const tasks = [...this.tasks.values()].filter((task) => task.ownerId === ownerId
      && ["pending", "running"].includes(task.status)
      && (executionScope === undefined || task.executionScope === executionScope));
    await Promise.all(tasks.map(async (task) => {
      task.status = "cancelled";
      task.error = "任务已由管理员取消";
      task.completedAt = new Date().toISOString();
      for (const connected of task.active) connected.connection.destroy();
      this.log(task, "任务取消请求已发送");
      await this.persist(task);
    }));
  }

  private async createTask(user: AuthenticatedUser, type: DatabaseTaskType, connectionId: string | null, title: string, details: Record<string, unknown>, executionScope: string | null): Promise<DatabaseTask> {
    const active = [...this.tasks.values()].filter((task) => ["pending", "running"].includes(task.status)).length;
    if (active >= 3) throw new Error("数据库后台任务已达到 3 个并发上限");
    const task: DatabaseTask = { id: randomUUID(), ownerId: user.id, executionScope, workspaceType: user.workspace.type, workspaceId: user.workspace.id, type, connectionId, status: "pending", progress: 0, title, details, logs: [], outputPath: null, error: "", createdAt: new Date().toISOString(), active: new Set() };
    this.tasks.set(task.id, task);
    await this.persist(task, true);
    return task;
  }

  private async run(task: DatabaseTask, action: () => Promise<void>): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.log(task, "任务开始");
    await this.persist(task);
    try {
      await action();
      if (!isCancelled(task)) {
        task.status = "success";
        task.progress = 100;
        this.log(task, "任务完成");
      }
    } catch (error) {
      if (!isCancelled(task)) {
        task.status = "error";
        task.error = errorMessage(error);
        this.log(task, `任务失败：${task.error}`);
      }
    } finally {
      task.completedAt = new Date().toISOString();
      task.active.clear();
      await this.persist(task);
      await writeAudit(this.app.db, {
        action: `database.${task.type}_${task.status}`,
        resourceType: "database_connection",
        resourceId: task.connectionId,
        summary: `${task.title} · ${task.status}`,
        details: { taskId: task.id, status: task.status, ownerId: task.ownerId },
        actorUserId: task.ownerId,
        workspaceType: task.workspaceType,
        workspaceId: task.workspaceId,
      });
    }
  }

  private async connect(task: DatabaseTask, connectionId: string, database?: string): Promise<ConnectedDatabase> {
    const connected = await connectDatabase(this.app, connectionId, database);
    task.active.add(connected);
    return connected;
  }

  private async backup(task: DatabaseTask, connectionId: string, database: string, includeData: boolean): Promise<void> {
    const backupDir = join(this.app.config.dataDir, "backups");
    await mkdir(backupDir, { recursive: true });
    const outputPath = join(backupDir, `${database.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`);
    const file = await open(outputPath, "wx", 0o600);
    const connected = await this.connect(task, connectionId, database);
    try {
      const [tableRows] = await connected.connection.query<RowDataPacket[]>(`SHOW FULL TABLES FROM ${identifier(database)}`);
      const objects = tableRows.map((row) => ({ name: String(Object.values(row)[0]), type: String(Object.values(row)[1]) }));
      const [routineRows] = await connected.connection.query<RowDataPacket[]>(`SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, [database]);
      const [triggerRows] = await connected.connection.query<RowDataPacket[]>(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`, [database]);
      const [eventRows] = await connected.connection.query<RowDataPacket[]>(`SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`, [database]);
      const totalObjects = objects.length + routineRows.length + triggerRows.length + eventRows.length;
      this.log(task, `发现 ${totalObjects} 个数据库对象`);
      await file.write(`-- Viron SQL Backup\n-- Database: ${database}\n-- Created: ${new Date().toISOString()}\n${BACKUP_BOUNDARY}`);
      await file.write(`SET FOREIGN_KEY_CHECKS=0;${BACKUP_BOUNDARY}`);
      const tables = objects.filter((item) => item.type === "BASE TABLE");
      const views = objects.filter((item) => item.type === "VIEW");
      let processed = 0;
      for (const table of tables) {
        if (task.status === "cancelled") return;
        this.log(task, `备份表结构 ${table.name}`);
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(database)}.${identifier(table.name)}`);
        const createSql = extractCreate(createRows[0]);
        await file.write(`DROP TABLE IF EXISTS ${identifier(table.name)};${BACKUP_BOUNDARY}${createSql};${BACKUP_BOUNDARY}`);
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
        this.log(task, includeData ? `表 ${table.name}：${rowCount} 行` : `表 ${table.name}：仅结构`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const view of views) {
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE VIEW ${identifier(database)}.${identifier(view.name)}`);
        await file.write(`DROP VIEW IF EXISTS ${identifier(view.name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const row of routineRows) {
        const name = String(row.name);
        const type = String(row.type).toUpperCase() === "FUNCTION" ? "FUNCTION" : "PROCEDURE";
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE ${type} ${identifier(database)}.${identifier(name)}`);
        await file.write(`DROP ${type} IF EXISTS ${identifier(name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const row of triggerRows) {
        const name = String(row.name);
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TRIGGER ${identifier(database)}.${identifier(name)}`);
        await file.write(`DROP TRIGGER IF EXISTS ${identifier(name)};${BACKUP_BOUNDARY}${extractCreate(createRows[0])};${BACKUP_BOUNDARY}`);
        processed += 1;
        this.progress(task, Math.round((processed / Math.max(1, totalObjects)) * 90));
      }
      for (const row of eventRows) {
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
      const content = await readFile(inputPath, "utf8");
      const statements = splitSql(content);
      this.log(task, `读取 ${statements.length} 条 SQL 语句`);
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
      this.log(task, `准备迁移 ${tables.length} 个表${includeObjects ? `及 ${totalObjects - tables.length} 个视图/例程/触发器/事件` : ""}`);
      for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
        if (task.status === "cancelled") return;
        const table = tables[tableIndex];
        if (options.includeStructure) {
          const [createRows] = await source.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(options.sourceDatabase)}.${identifier(table)}`);
          if (options.dropExisting) await target.connection.query(`DROP TABLE IF EXISTS ${identifier(options.targetDatabase)}.${identifier(table)}`);
          let createSql = extractCreate(createRows[0]);
          createSql = createSql.replace(/^CREATE TABLE\s+`[^`]+`/i, `CREATE TABLE ${identifier(options.targetDatabase)}.${identifier(table)}`);
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
          this.log(task, `${table}：迁移 ${dataRows.length} 行`);
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

  private log(task: DatabaseTask, message: string): void {
    task.logs.push(`${new Date().toISOString()} ${message}`);
    if (task.logs.length > TASK_LOG_LIMIT) task.logs.splice(0, task.logs.length - TASK_LOG_LIMIT);
  }

  private progress(task: DatabaseTask, value: number): void {
    task.progress = Math.max(task.progress, Math.min(99, value));
    void this.persist(task);
  }

  private async persist(task: DatabaseTask, insert = false): Promise<void> {
    if (insert) {
      await this.app.db.prepare(`INSERT INTO database_tasks (id, owner_user_id, type, connection_id, status, progress, title, details_json, logs_json, output_path, error_message, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.id, task.ownerId, task.type, task.connectionId, task.status, task.progress, task.title, JSON.stringify(task.details), JSON.stringify(task.logs), task.outputPath, task.error, task.createdAt, task.startedAt ?? null, task.completedAt ?? null);
    } else {
      await this.app.db.prepare(`UPDATE database_tasks SET status = ?, progress = ?, title = ?, details_json = ?, logs_json = ?, output_path = ?, error_message = ?, started_at = ?, completed_at = ? WHERE id = ?`)
        .run(task.status, task.progress, task.title, JSON.stringify(task.details), JSON.stringify(task.logs), task.outputPath, task.error, task.startedAt ?? null, task.completedAt ?? null, task.id);
    }
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
      logs: task.logs,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      downloadable: task.status === "success" && Boolean(task.outputPath),
      outputFilename: task.outputPath ? basename(task.outputPath) : null,
    };
  }
}
