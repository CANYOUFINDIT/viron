import type { FieldPacket, QueryResult, RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import {
  defaultDataSyncOptions,
  defaultStructureSyncOptions,
  executeDatabaseSync,
  previewDatabaseSync,
  type DatabaseSyncClient,
} from "../src/database-sync.js";

interface FakeTable {
  create: string;
  columns: Array<{
    name: string;
    type: string;
    nullable?: boolean;
    defaultValue?: unknown;
    extra?: string;
    charset?: string;
    collation?: string;
    comment?: string;
  }>;
  indexes: Array<{ name: string; nonUnique?: boolean; type?: string; columns: string[] }>;
  rows: Array<Record<string, unknown>>;
  engine?: string;
  collation?: string;
  comment?: string;
}

interface FakeSchema {
  tables: Record<string, FakeTable>;
  views?: Record<string, string>;
}

class FakeSyncClient implements DatabaseSyncClient {
  readonly statements: string[] = [];
  began = 0;
  committed = 0;
  rolledBack = 0;

  constructor(readonly schemas: Record<string, FakeSchema>) {}

  async query<T extends QueryResult = QueryResult>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);
    const args = Array.isArray(values) ? values : [];
    const database = String(args[0] ?? "");
    const schema = this.schemas[database] ?? { tables: {} };

    if (/FROM information_schema\.TABLES WHERE TABLE_SCHEMA = \? AND TABLE_TYPE = 'BASE TABLE'/i.test(normalized)) {
      return [Object.entries(schema.tables).map(([name, table]) => ({
        name,
        rowCount: table.rows.length,
        engine: table.engine ?? "InnoDB",
        collation: table.collation ?? "utf8mb4_general_ci",
        comment: table.comment ?? "",
        autoIncrement: null,
        rowFormat: "Dynamic",
      })) as unknown as T, []];
    }
    if (/FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = \?/i.test(normalized)) {
      return [Object.entries(schema.tables).flatMap(([tableName, table]) => table.columns.map((column, index) => ({
        tableName,
        name: column.name,
        ordinalPosition: index + 1,
        columnType: column.type,
        nullable: column.nullable ? "YES" : "NO",
        defaultValue: column.defaultValue ?? null,
        extra: column.extra ?? "",
        charset: column.charset ?? (/char|text/i.test(column.type) ? "utf8mb4" : null),
        collation: column.collation ?? (/char|text/i.test(column.type) ? "utf8mb4_general_ci" : null),
        comment: column.comment ?? "",
        generationExpression: "",
      }))) as unknown as T, []];
    }
    if (/FROM information_schema\.STATISTICS WHERE TABLE_SCHEMA = \?/i.test(normalized)) {
      return [Object.entries(schema.tables).flatMap(([tableName, table]) => table.indexes.flatMap((index) => index.columns.map((column, sequence) => ({
        tableName,
        indexName: index.name,
        nonUnique: index.name === "PRIMARY" ? 0 : index.nonUnique === false ? 0 : 1,
        indexType: index.type ?? "BTREE",
        sequence: sequence + 1,
        columnName: column,
        subPart: null,
        direction: "A",
      })))) as unknown as T, []];
    }
    if (/information_schema\.KEY_COLUMN_USAGE/i.test(normalized) || /information_schema\.CHECK_CONSTRAINTS/i.test(normalized)) return [[] as unknown as T, []];
    if (/SELECT TABLE_NAME AS name FROM information_schema\.VIEWS/i.test(normalized)) return [Object.keys(schema.views ?? {}).map((name) => ({ name })) as unknown as T, []];
    if (/SELECT ROUTINE_NAME AS name/i.test(normalized) || /SELECT TRIGGER_NAME AS name/i.test(normalized) || /SELECT EVENT_NAME AS name/i.test(normalized)) return [[] as unknown as T, []];

    const showTable = normalized.match(/^SHOW CREATE TABLE `([^`]+)`\.`([^`]+)`$/i);
    if (showTable) return [[{ Table: showTable[2], "Create Table": this.schemas[showTable[1]]?.tables[showTable[2]]?.create ?? "" }] as unknown as T, []];
    const showView = normalized.match(/^SHOW CREATE VIEW `([^`]+)`\.`([^`]+)`$/i);
    if (showView) return [[{ View: showView[2], "Create View": this.schemas[showView[1]]?.views?.[showView[2]] ?? "" }] as unknown as T, []];

    const selectRows = normalized.match(/^SELECT (.+) FROM `([^`]+)`\.`([^`]+)`(?: WHERE (.+?))? ORDER BY (.+) LIMIT 400$/i);
    if (selectRows) {
      const columns = [...selectRows[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      const table = this.schemas[selectRows[2]].tables[selectRows[3]];
      let rows = [...table.rows].sort((left, right) => Number(left.id) - Number(right.id));
      if (/ > \?/i.test(selectRows[4] ?? "")) rows = rows.filter((row) => Number(row.id) > Number(args[0]));
      return [rows.slice(0, 400).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))) as unknown as T, columns.map((name) => ({ name })) as FieldPacket[]];
    }

    const lookup = normalized.match(/^SELECT (.+) FROM `([^`]+)`\.`([^`]+)` WHERE `([^`]+)` IN \((.+)\)$/i);
    if (lookup) {
      const columns = [...lookup[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      const keys = new Set(args.map(String));
      const rows = this.schemas[lookup[2]].tables[lookup[3]].rows.filter((row) => keys.has(String(row[lookup[4]])));
      return [rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))) as unknown as T, []];
    }

    const insert = normalized.match(/^INSERT INTO `([^`]+)`\.`([^`]+)` \((.+)\) VALUES /i);
    if (insert) {
      const columns = [...insert[3].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      const table = this.schemas[insert[1]].tables[insert[2]];
      for (let index = 0; index < args.length; index += columns.length) table.rows.push(Object.fromEntries(columns.map((column, columnIndex) => [column, args[index + columnIndex]])));
      return [{ affectedRows: args.length / columns.length } as unknown as T, []];
    }

    const update = normalized.match(/^UPDATE `([^`]+)`\.`([^`]+)` SET (.+) WHERE `([^`]+)` = \?$/i);
    if (update) {
      const updateColumns = [...update[3].matchAll(/`([^`]+)` = \?/g)].map((match) => match[1]);
      const key = args[args.length - 1];
      const row = this.schemas[update[1]].tables[update[2]].rows.find((item) => item[update[4]] === key);
      if (row) updateColumns.forEach((column, index) => { row[column] = args[index]; });
      return [{ affectedRows: row ? 1 : 0 } as unknown as T, []];
    }

    const remove = normalized.match(/^DELETE FROM `([^`]+)`\.`([^`]+)` WHERE `([^`]+)` IN \((.+)\)$/i);
    if (remove) {
      const table = this.schemas[remove[1]].tables[remove[2]];
      const keys = new Set(args.map(String));
      const before = table.rows.length;
      table.rows = table.rows.filter((row) => !keys.has(String(row[remove[3]])));
      return [{ affectedRows: before - table.rows.length } as unknown as T, []];
    }

    return [{ affectedRows: 0 } as unknown as T, []];
  }

  async beginTransaction() { this.began += 1; }
  async commit() { this.committed += 1; }
  async rollback() { this.rolledBack += 1; }
  escape(value: unknown) { return value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
}

function callbacks() {
  return { log: () => undefined, progress: () => undefined, cancelled: () => false };
}

describe("database synchronization", () => {
  it("previews and executes table and view structure differences without recreating the table", async () => {
    const source = new FakeSyncClient({ source: { tables: {
      users: {
        create: "CREATE TABLE `users` (`id` int NOT NULL, `name` varchar(100) NOT NULL, `email` varchar(160), PRIMARY KEY (`id`), KEY `idx_email` (`email`)) ENGINE=InnoDB",
        columns: [{ name: "id", type: "int" }, { name: "name", type: "varchar(100)" }, { name: "email", type: "varchar(160)", nullable: true }],
        indexes: [{ name: "PRIMARY", columns: ["id"] }, { name: "idx_email", columns: ["email"] }],
        rows: [{ id: 1, name: "alpha", email: "a@example.com" }],
        comment: "用户",
      },
    }, views: { active_users: "CREATE ALGORITHM=UNDEFINED VIEW `source`.`active_users` AS select `source`.`users`.`id` AS `id` from `source`.`users`" } } });
    const target = new FakeSyncClient({ target: { tables: {
      users: {
        create: "CREATE TABLE `users` (`id` int NOT NULL, `name` varchar(50) NOT NULL, `legacy` int, PRIMARY KEY (`id`), KEY `idx_legacy` (`legacy`)) ENGINE=InnoDB",
        columns: [{ name: "id", type: "int" }, { name: "name", type: "varchar(50)" }, { name: "legacy", type: "int", nullable: true }],
        indexes: [{ name: "PRIMARY", columns: ["id"] }, { name: "idx_legacy", columns: ["legacy"] }],
        rows: [{ id: 1, name: "alpha", legacy: 1 }],
      },
    }, views: { active_users: "CREATE VIEW `target`.`active_users` AS select 1 AS `id`" } } });
    const options = {
      mode: "structure" as const,
      sourceDatabase: "source",
      targetDatabase: "target",
      data: defaultDataSyncOptions(),
      structure: { ...defaultStructureSyncOptions(), compareRoutines: false, compareTriggers: false, compareEvents: false, dropExtra: true },
    };
    const preview = await previewDatabaseSync(source, target, options);
    const table = preview.items.find((item) => item.id === "table:table:users")!;
    const view = preview.items.find((item) => item.id === "view:view:active_users")!;
    expect(table.status).toBe("different");
    expect(table.sql.join("\n")).toContain("MODIFY COLUMN `name` varchar(100)");
    expect(table.sql.join("\n")).toContain("ADD COLUMN `email`");
    expect(table.sql.join("\n")).toContain("DROP COLUMN `legacy`");
    expect(table.sql.join("\n")).toContain("DROP INDEX `idx_legacy`");
    expect(table.sql.join("\n")).toContain("ADD KEY `idx_email`");
    expect(view.action).toBe("replace");

    await executeDatabaseSync(source, target, options, [table.id, view.id], callbacks());
    expect(target.statements.some((statement) => statement.includes("ALTER TABLE `target`.`users` MODIFY COLUMN `name`"))).toBe(true);
    expect(target.statements.some((statement) => statement.includes("DROP VIEW IF EXISTS `target`.`active_users`"))).toBe(true);
    expect(target.statements.some((statement) => statement.includes("CREATE ALGORITHM=UNDEFINED VIEW `target`.`active_users`"))).toBe(true);
    expect(target.statements.some((statement) => /DROP TABLE/i.test(statement))).toBe(false);
  });

  it("synchronizes inserts, updates, and deletes by primary key inside a target transaction", async () => {
    const table = (rows: Array<Record<string, unknown>>): FakeTable => ({
      create: "CREATE TABLE `items` (`id` int NOT NULL, `name` varchar(80) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB",
      columns: [{ name: "id", type: "int" }, { name: "name", type: "varchar(80)" }],
      indexes: [{ name: "PRIMARY", columns: ["id"] }],
      rows,
    });
    const source = new FakeSyncClient({ source: { tables: { items: table([{ id: 1, name: "alpha-new" }, { id: 2, name: "beta" }]) } } });
    const target = new FakeSyncClient({ target: { tables: { items: table([{ id: 1, name: "alpha-old" }, { id: 3, name: "extra" }]) } } });
    const options = {
      mode: "data" as const,
      sourceDatabase: "source",
      targetDatabase: "target",
      data: defaultDataSyncOptions(),
      structure: defaultStructureSyncOptions(),
    };
    const preview = await previewDatabaseSync(source, target, options);
    expect(preview.items[0]).toMatchObject({ id: "table:data:items", status: "ready", primaryKey: ["id"] });

    await executeDatabaseSync(source, target, options, ["table:data:items"], callbacks());
    expect(target.schemas.target.tables.items.rows).toEqual([{ id: 1, name: "alpha-new" }, { id: 2, name: "beta" }]);
    expect(target.began).toBe(1);
    expect(target.committed).toBe(1);
    expect(target.rolledBack).toBe(0);
  });
});
