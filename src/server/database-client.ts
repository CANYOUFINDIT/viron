import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type Database from "better-sqlite3";
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";

export type DatabaseDialect = "sqlite" | "mysql";

export interface DatabaseRunResult {
  changes: number;
  lastInsertRowid: number | string;
}

export interface DatabaseStatement {
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<DatabaseRunResult>;
}

export interface EnvmanDatabase {
  readonly dialect: DatabaseDialect;
  prepare(sql: string): DatabaseStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(callback: () => T | Promise<T>): () => Promise<T>;
  backup(destinationPath: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

class AsyncMutex {
  private tail = Promise.resolve();

  async run<T>(callback: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

export class SqliteDatabaseClient implements EnvmanDatabase {
  readonly dialect = "sqlite" as const;
  private readonly mutex = new AsyncMutex();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();

  constructor(readonly raw: Database.Database) {}

  prepare(sql: string): DatabaseStatement {
    const statement = this.raw.prepare(sql);
    return {
      get: <T>(...params: unknown[]) => this.execute(() => statement.get(...params) as T | undefined),
      all: <T>(...params: unknown[]) => this.execute(() => statement.all(...params) as T[]),
      run: (...params: unknown[]) => this.execute(() => {
        const result = statement.run(...params);
        return { changes: result.changes, lastInsertRowid: String(result.lastInsertRowid) };
      }),
    };
  }

  exec(sql: string): Promise<void> {
    return this.execute(() => { this.raw.exec(sql); });
  }

  transaction<T>(callback: () => T | Promise<T>): () => Promise<T> {
    return () => this.mutex.run(async () => {
      this.raw.exec("BEGIN");
      try {
        const result = await this.transactionContext.run(true, callback);
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      }
    });
  }

  backup(destinationPath: string): Promise<void> {
    return this.mutex.run(() => this.raw.backup(destinationPath).then(() => undefined));
  }

  async ping(): Promise<void> {
    // 两段检查缺一不可：进程已经持有库文件的 fd，删除库文件或改成不可读写之后任何 SQL 依然成功，
    // 只有校验库文件路径本身才能发现；反过来路径检查看不到连接已关闭、页损坏这类故障，需要真实读兜住。
    if (!this.raw.memory && this.raw.name) await access(this.raw.name, constants.R_OK | constants.W_OK);
    // 必须读到真实数据页，`SELECT 1` 是常量表达式，由表达式求值器直接算出、不碰任何数据页。
    await this.prepare("SELECT count(*) AS count FROM sqlite_master").get();
  }

  close(): Promise<void> {
    return this.mutex.run(() => { this.raw.close(); });
  }

  private execute<T>(callback: () => T): Promise<T> {
    if (this.transactionContext.getStore()) return Promise.resolve(callback());
    return this.mutex.run(callback);
  }
}

export function normalizeMysqlSql(sql: string): string {
  let normalized = sql
    .replace(/\s+COLLATE\s+NOCASE/gi, "")
    .replace(/\bINSERT\s+OR\s+IGNORE\b/gi, "INSERT IGNORE");
  normalized = normalized.replace(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+([\s\S]+)$/i, (_match, assignments: string) => {
    const mysqlAssignments = assignments.replace(/excluded\.([a-z_][a-z0-9_]*)/gi, "VALUES($1)");
    return `ON DUPLICATE KEY UPDATE ${mysqlAssignments}`;
  });
  return normalized;
}

export interface MysqlDatabaseOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
}

export class MysqlDatabaseClient implements EnvmanDatabase {
  readonly dialect = "mysql" as const;
  private readonly pool: Pool;
  private readonly transactionContext = new AsyncLocalStorage<PoolConnection>();

  constructor(options: MysqlDatabaseOptions) {
    this.pool = mysql.createPool({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      connectionLimit: options.connectionLimit,
      waitForConnections: true,
      queueLimit: 0,
      charset: "utf8mb4",
      timezone: "Z",
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: true,
    });
  }

  prepare(sql: string): DatabaseStatement {
    const normalized = normalizeMysqlSql(sql);
    return {
      get: async <T>(...params: unknown[]) => {
        const [rows] = await this.query(normalized, params);
        return (rows as T[])[0];
      },
      all: async <T>(...params: unknown[]) => {
        const [rows] = await this.query(normalized, params);
        return rows as T[];
      },
      run: async (...params: unknown[]) => {
        const [result] = await this.query(normalized, params);
        const header = result as ResultSetHeader;
        return { changes: Number(header.affectedRows ?? 0), lastInsertRowid: header.insertId ?? 0 };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(normalizeMysqlSql(sql));
  }

  transaction<T>(callback: () => T | Promise<T>): () => Promise<T> {
    return async () => {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await this.transactionContext.run(connection, callback);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    };
  }

  async backup(): Promise<void> {
    throw new Error("MySQL 模式暂不支持平台快照导出");
  }

  async ping(): Promise<void> {
    // 直接用连接池而不是 this.query：就绪检查要验证的正是连接池仍能拿到可用连接，
    // 不能被 AsyncLocalStorage 里正在进行的事务连接顶替。
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private query(sql: string, params: unknown[] = []): Promise<[RowDataPacket[] | RowDataPacket[][] | ResultSetHeader, unknown]> {
    const connection = this.transactionContext.getStore();
    return (connection ?? this.pool).query(sql, params) as unknown as Promise<[RowDataPacket[] | RowDataPacket[][] | ResultSetHeader, unknown]>;
  }
}
