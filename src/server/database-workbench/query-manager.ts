import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Connection, FieldPacket, ResultSetHeader } from "mysql2/promise";
import type { AuthenticatedUser, WorkspaceType } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { splitSqlStatements } from "../../shared/sql-statements.js";
import { connectDatabase, type ConnectedDatabase } from "./connector.js";

export type QueryStatus = "pending" | "running" | "success" | "error" | "cancelled";

export interface QueryResultSet {
  columns: Array<{ name: string; table: string; type: number }>;
  rows: Array<Record<string, unknown>>;
  affectedRows: number;
  insertId: string | number;
  info: string;
  truncated: boolean;
  statement?: string;
  error?: string;
}

interface QueryJob {
  id: string;
  ownerId: string;
  executionScope: string | null;
  workspaceType: WorkspaceType;
  workspaceId: string;
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
  resultSets: QueryResultSet[];
  active?: ConnectedDatabase;
}

export interface PublicQueryJob {
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
  resultSets: QueryResultSet[];
}

const MAX_RESULT_ROWS = 10_000;

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

function resultSet(rows: unknown, fields: FieldPacket[] | undefined): QueryResultSet {
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

function normalizeResults(rows: unknown, fields: unknown): QueryResultSet[] {
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

function databaseError(error: unknown): string {
  const value = error as { message?: string; code?: string; sqlMessage?: string };
  if (value.code === "ER_ACCESS_DENIED_ERROR") return "数据库认证失败，请检查用户名和密码";
  if (value.code === "ECONNREFUSED") return "数据库端口拒绝连接";
  if (value.code === "ETIMEDOUT" || value.code === "PROTOCOL_SEQUENCE_TIMEOUT") return "数据库连接或查询超时";
  return value.sqlMessage || value.message || String(error);
}

function isCancelled(job: QueryJob): boolean {
  return job.status === "cancelled";
}

export class DatabaseQueryManager {
  private readonly jobs = new Map<string, QueryJob>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly app: FastifyInstance,
    private readonly connect: typeof connectDatabase = connectDatabase,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60_000);
    this.cleanupTimer.unref();
  }

  async create(
    user: AuthenticatedUser,
    connectionId: string,
    sql: string,
    database = "",
    executionScope: string | null = null,
    continueOnError = false,
  ): Promise<PublicQueryJob> {
    const activeCount = [...this.jobs.values()].filter((job) => job.status === "pending" || job.status === "running").length;
    if (activeCount >= 10) throw new Error("数据库查询已达到 10 个并发上限");
    const row = await this.app.db.prepare("SELECT name FROM database_connections WHERE id = ?").get(connectionId) as { name: string } | undefined;
    if (!row) throw new Error("数据库连接不存在");
    this.app.activeConnections.touchResource(user.id, "database", connectionId, executionScope);
    const job: QueryJob = {
      id: randomUUID(),
      ownerId: user.id,
      executionScope,
      workspaceType: user.workspace.type,
      workspaceId: user.workspace.id,
      connectionId,
      connectionName: row.name,
      database,
      sql,
      continueOnError,
      status: "pending",
      createdAt: new Date().toISOString(),
      resultSets: [],
    };
    this.jobs.set(job.id, job);
    void this.run(job);
    return this.publicJob(job);
  }

  get(id: string, ownerId: string, executionScope: string | null = null): PublicQueryJob | undefined {
    const job = this.jobs.get(id);
    if (job?.ownerId === ownerId && job.executionScope === executionScope) {
      this.app.activeConnections.touchResource(ownerId, "database", job.connectionId, executionScope);
    }
    return job?.ownerId === ownerId && job.executionScope === executionScope ? this.publicJob(job) : undefined;
  }

  activeCount(ownerId: string, executionScope: string | null): number {
    return [...this.jobs.values()].filter((job) => job.ownerId === ownerId && job.executionScope === executionScope && ["pending", "running"].includes(job.status)).length;
  }

  hasActive(ownerId: string, connectionId: string, executionScope: string | null): boolean {
    return [...this.jobs.values()].some((job) => job.ownerId === ownerId && job.connectionId === connectionId
      && job.executionScope === executionScope && ["pending", "running"].includes(job.status));
  }

  cancel(id: string, ownerId: string, executionScope: string | null = null): boolean {
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId || job.executionScope !== executionScope || !["pending", "running"].includes(job.status)) return false;
    job.status = "cancelled";
    this.app.activeConnections.touchResource(ownerId, "database", job.connectionId, executionScope);
    job.error = "查询已由管理员取消";
    job.active?.connection.destroy();
    return true;
  }

  closeAll(): void {
    clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) {
      if (job.status === "pending" || job.status === "running") {
        job.status = "cancelled";
        job.active?.connection.destroy();
      }
    }
  }

  closeOwner(ownerId: string, executionScope?: string | null): void {
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId || (executionScope !== undefined && job.executionScope !== executionScope)) continue;
      if (["pending", "running"].includes(job.status)) {
        job.status = "cancelled";
        job.error = "查询已由管理员取消";
        job.active?.connection.destroy();
      }
    }
  }

  closeConnection(ownerId: string, connectionId: string, reason: string, executionScope: string | null): void {
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId || job.connectionId !== connectionId || job.executionScope !== executionScope) continue;
      if (!["pending", "running"].includes(job.status)) continue;
      job.status = "cancelled";
      job.error = reason;
      job.active?.connection.destroy();
    }
  }

  private async run(job: QueryJob): Promise<void> {
    const started = Date.now();
    job.status = "running";
    job.startedAt = new Date(started).toISOString();
    try {
      job.active = await this.connect(this.app, job.connectionId, job.database || undefined);
      if (isCancelled(job)) return;
      if (!job.continueOnError) {
        const [rows, fields] = await job.active.connection.query(job.sql);
        if (isCancelled(job)) return;
        job.resultSets = normalizeResults(rows, fields);
        job.status = "success";
      } else {
        const statements = splitSqlStatements(job.sql);
        let errors = 0;
        for (const statement of statements.length ? statements : [job.sql]) {
          if (isCancelled(job)) return;
          try {
            const [rows, fields] = await job.active.connection.query(statement);
            if (isCancelled(job)) return;
            job.resultSets.push(...normalizeResults(rows, fields).map((result) => ({ ...result, statement })));
          } catch (error) {
            if (isCancelled(job)) return;
            errors += 1;
            job.resultSets.push({
              columns: [],
              rows: [],
              affectedRows: 0,
              insertId: 0,
              info: "",
              truncated: false,
              statement,
              error: databaseError(error),
            });
          }
        }
        job.status = errors ? "error" : "success";
        if (errors) job.error = `${errors} 条语句执行失败，其余语句已继续执行`;
      }
    } catch (error) {
      if (!isCancelled(job)) {
        job.status = "error";
        job.error = databaseError(error);
      }
    } finally {
      await job.active?.close();
      job.active = undefined;
      job.completedAt = new Date().toISOString();
      this.app.activeConnections.touchResource(job.ownerId, "database", job.connectionId, job.executionScope);
      job.durationMs = Date.now() - started;
      const rowCount = job.resultSets.reduce((total, item) => total + item.rows.length + item.affectedRows, 0);
      await this.app.db.prepare(`
        INSERT INTO database_query_history (
          id, owner_user_id, connection_id, database_name, sql_text, status, duration_ms,
          row_count, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), job.ownerId, job.connectionId, job.database, job.sql, job.status,
        job.durationMs, rowCount, job.error ?? "", job.completedAt,
      );
      await writeAudit(this.app.db, {
        action: job.status === "success" ? "database.query_executed" : "database.query_failed",
        resourceType: "database_connection",
        resourceId: job.connectionId,
        summary: `${job.status === "success" ? "执行" : "未完成"} SQL · ${job.connectionName}`,
        details: { queryId: job.id, status: job.status, durationMs: job.durationMs, rowCount },
        actorUserId: job.ownerId,
        workspaceType: job.workspaceType,
        workspaceId: job.workspaceId,
      });
    }
  }

  private publicJob(job: QueryJob): PublicQueryJob {
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

  private cleanup(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, job] of this.jobs) {
      if (job.completedAt && new Date(job.completedAt).getTime() < cutoff) this.jobs.delete(id);
    }
  }
}
