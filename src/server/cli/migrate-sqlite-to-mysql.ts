import "dotenv/config";
import Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { EnvmanDatabase } from "../database-client.js";
import { openDatabase } from "../database.js";
import { initializeMasterKey } from "../master-key.js";

interface TableCount {
  table: string;
  rows: number;
}

interface ForeignKeyColumn {
  constraint_name: string;
  table_name: string;
  column_name: string;
  referenced_table_name: string;
  referenced_column_name: string;
  ordinal_position: number;
}

export interface SqliteToMysqlMigrationResult {
  sourcePath: string;
  tables: TableCount[];
  totalRows: number;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `\`${value}\``;
}

function sourceTables(source: Database.Database): string[] {
  return (source.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

async function targetTables(target: EnvmanDatabase, databaseName: string): Promise<string[]> {
  const rows = await target.prepare(`
    SELECT TABLE_NAME AS name
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `).all(databaseName) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

async function assertEmptyTarget(target: EnvmanDatabase, tables: string[]): Promise<void> {
  const populated: TableCount[] = [];
  for (const table of tables) {
    const row = await target.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table)}`).get() as { count: number | string };
    const count = Number(row.count);
    if (count > 0) populated.push({ table, rows: count });
  }
  if (populated.length) {
    throw new Error(`MySQL target is not empty: ${populated.map((item) => `${item.table}=${item.rows}`).join(", ")}`);
  }
}

async function assertTargetColumns(
  target: EnvmanDatabase,
  databaseName: string,
  table: string,
  columns: string[],
): Promise<void> {
  const rows = await target.prepare(`
    SELECT COLUMN_NAME AS name
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
  `).all(databaseName, table) as Array<{ name: string }>;
  const targetColumns = new Set(rows.map((row) => row.name));
  const missing = columns.filter((column) => !targetColumns.has(column));
  if (missing.length) throw new Error(`MySQL table ${table} is missing columns: ${missing.join(", ")}`);
}

async function assertNoMysqlForeignKeyOrphans(target: EnvmanDatabase, databaseName: string): Promise<void> {
  const columns = await target.prepare(`
    SELECT
      CONSTRAINT_NAME AS constraint_name,
      TABLE_NAME AS table_name,
      COLUMN_NAME AS column_name,
      REFERENCED_TABLE_NAME AS referenced_table_name,
      REFERENCED_COLUMN_NAME AS referenced_column_name,
      ORDINAL_POSITION AS ordinal_position
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
  `).all(databaseName) as ForeignKeyColumn[];

  const constraints = new Map<string, ForeignKeyColumn[]>();
  for (const column of columns) {
    const key = `${column.table_name}\0${column.constraint_name}`;
    constraints.set(key, [...(constraints.get(key) ?? []), column]);
  }

  for (const constraintColumns of constraints.values()) {
    const first = constraintColumns[0]!;
    const join = constraintColumns
      .map((column) => `child.${identifier(column.column_name)} = parent.${identifier(column.referenced_column_name)}`)
      .join(" AND ");
    const present = constraintColumns
      .map((column) => `child.${identifier(column.column_name)} IS NOT NULL`)
      .join(" AND ");
    const row = await target.prepare(`
      SELECT COUNT(*) AS count
      FROM ${identifier(first.table_name)} child
      LEFT JOIN ${identifier(first.referenced_table_name)} parent ON ${join}
      WHERE ${present} AND parent.${identifier(first.referenced_column_name)} IS NULL
    `).get() as { count: number | string };
    const count = Number(row.count);
    if (count) throw new Error(`Foreign key ${first.constraint_name} has ${count} orphan row(s)`);
  }
}

export async function migrateSqliteToMysql(
  sourcePath: string,
  target: EnvmanDatabase,
  databaseName: string,
  log: (message: string) => void = () => undefined,
): Promise<SqliteToMysqlMigrationResult> {
  if (target.dialect !== "mysql") throw new Error("Migration target must use the MySQL driver");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.pragma("query_only = ON");
    const sourceForeignKeyViolations = source.pragma("foreign_key_check") as unknown[];
    if (sourceForeignKeyViolations.length) {
      throw new Error(`SQLite source has ${sourceForeignKeyViolations.length} foreign key violation(s)`);
    }

    const tables = sourceTables(source);
    const mysqlTables = new Set(await targetTables(target, databaseName));
    const missingTables = tables.filter((table) => !mysqlTables.has(table));
    if (missingTables.length) throw new Error(`MySQL target is missing tables: ${missingTables.join(", ")}`);
    await assertEmptyTarget(target, tables);

    const sourceCounts = new Map<string, number>();
    for (const table of tables) {
      const row = source.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table)}`).get() as { count: number };
      sourceCounts.set(table, Number(row.count));
    }

    await target.transaction(async () => {
      await target.exec("SET FOREIGN_KEY_CHECKS = 0");
      try {
        for (const table of tables) {
          const columns = (source.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name);
          await assertTargetColumns(target, databaseName, table, columns);
          const placeholders = columns.map(() => "?").join(", ");
          const insert = target.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${placeholders})`);
          let copied = 0;
          for (const row of source.prepare(`SELECT * FROM ${identifier(table)}`).iterate() as Iterable<Record<string, unknown>>) {
            await insert.run(...columns.map((column) => row[column]));
            copied += 1;
          }
          if (copied !== sourceCounts.get(table)) throw new Error(`SQLite row count changed while copying ${table}`);
          log(`${table}: ${copied}`);
        }
      } finally {
        await target.exec("SET FOREIGN_KEY_CHECKS = 1");
      }

      for (const table of tables) {
        const row = await target.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table)}`).get() as { count: number | string };
        const sourceCount = sourceCounts.get(table)!;
        if (Number(row.count) !== sourceCount) {
          throw new Error(`Row count mismatch for ${table}: SQLite=${sourceCount}, MySQL=${row.count}`);
        }
      }
      await assertNoMysqlForeignKeyOrphans(target, databaseName);
    })();

    const counts = tables.map((table) => ({ table, rows: sourceCounts.get(table)! }));
    return {
      sourcePath,
      tables: counts,
      totalRows: counts.reduce((sum, item) => sum + item.rows, 0),
    };
  } finally {
    source.close();
  }
}

async function run(config: AppConfig): Promise<void> {
  if (config.databaseDriver !== "mysql" || !config.databaseName) {
    throw new Error("Set DATABASE_DRIVER=mysql and complete the MySQL settings before running this migration");
  }
  const target = await openDatabase(config);
  try {
    const result = await migrateSqliteToMysql(config.databasePath, target, config.databaseName, (message) => console.log(message));
    await initializeMasterKey(config, target);
    console.log(`Migrated ${result.totalRows} rows across ${result.tables.length} tables from ${result.sourcePath}.`);
  } finally {
    await target.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run(loadConfig());
}
