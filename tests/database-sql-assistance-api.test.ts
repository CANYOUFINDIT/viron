import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  createTable: "CREATE TABLE `orders` (\n"
    + "  `code` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin BINARY NOT NULL COLUMN_FORMAT DYNAMIC STORAGE DISK,\n"
    + "  PRIMARY KEY (`code`(24)),\n"
    + "  KEY `idx_code` (`code`(12) DESC) USING BTREE KEY_BLOCK_SIZE=8 WITH PARSER `ngram` INVISIBLE,\n"
    + "  CONSTRAINT `fk_orders_account` FOREIGN KEY (`code`) REFERENCES `identity`.`accounts` (`code`) ON DELETE CASCADE ON UPDATE NO ACTION,\n"
    + "  CONSTRAINT `chk_orders_code` CHECK ((char_length(`code`) > 0))\n"
    + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DATA DIRECTORY='/srv/mysql/data' PACK_KEYS=1 STATS_PERSISTENT=1",
}));

vi.mock("../src/server/database-workbench/connector.js", () => ({
  connectDatabase: vi.fn(async () => ({
    record: { name: "Primary", engine: "mysql" },
    connection: {
      async query(sql: string) {
        if (/SELECT TABLE_NAME, TABLE_TYPE FROM information_schema\.TABLES/i.test(sql)) return [[{ TABLE_NAME: "orders", TABLE_TYPE: "BASE TABLE" }], []];
        if (/SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE/i.test(sql)) return [[{ TABLE_NAME: "orders", COLUMN_NAME: "code", DATA_TYPE: "varchar", COLUMN_TYPE: "varchar(255)", ORDINAL_POSITION: 1 }], []];
        if (/FROM information_schema\.ROUTINES/i.test(sql)) return [[{ ROUTINE_NAME: "order_count", ROUTINE_TYPE: "FUNCTION" }], []];
        if (/SHOW CREATE TABLE/i.test(sql)) return [[{ "Create Table": fixture.createTable }], []];
        if (/FROM information_schema\.COLUMNS\s/i.test(sql)) return [[{
          COLUMN_NAME: "code", COLUMN_TYPE: "varchar(255)", DATA_TYPE: "varchar", IS_NULLABLE: "NO", COLUMN_DEFAULT: null,
          COLUMN_KEY: "PRI", EXTRA: "", COLUMN_COMMENT: "Order code", CHARACTER_MAXIMUM_LENGTH: 255,
          NUMERIC_PRECISION: null, NUMERIC_SCALE: null, DATETIME_PRECISION: null, GENERATION_EXPRESSION: "",
          CHARACTER_SET_NAME: "utf8mb4", COLLATION_NAME: "utf8mb4_bin", ORDINAL_POSITION: 1,
        }], []];
        if (/SHOW INDEX/i.test(sql)) return [[{ Key_name: "idx_code", Seq_in_index: 1, Index_type: "BTREE", Non_unique: 1, Column_name: "code", Sub_part: 12, Collation: "D", Index_comment: "", Cardinality: 10, Packed: null, Visible: "NO" }], []];
        if (/information_schema\.KEY_COLUMN_USAGE/i.test(sql)) throw new Error("foreign keys should come from SHOW CREATE TABLE");
        if (/information_schema\.CHECK_CONSTRAINTS/i.test(sql)) throw new Error("checks should come from SHOW CREATE TABLE");
        if (/information_schema\.TRIGGERS/i.test(sql)) return [[], []];
        if (/SHOW TABLE STATUS/i.test(sql)) return [[{ Engine: "InnoDB", Collation: "utf8mb4_bin", Row_format: "Dynamic", Auto_increment: null, Min_rows: 0, Avg_row_length: 0, Max_rows: 0, Create_options: "pack_keys=1 stats_persistent=1", Comment: "Orders" }], []];
        return [[], []];
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      escape(value: unknown) { return String(value); },
      async end() {},
      destroy() {},
    },
    async close() {},
  })),
}));

import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 29),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("database SQL assistance API", () => {
  it("returns completion metadata and advanced table design through the server execution path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-sql-assistance-api-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const connection = await app.inject({ method: "POST", url: "/api/v1/database-connections", cookies, payload: { name: "Primary", engine: "mysql", host: "127.0.0.1", port: 3306, username: "root" } });
    const connectionId = connection.json().id as string;

    const metadata = await app.inject({ method: "GET", url: `/api/v1/database-connections/${connectionId}/completion-metadata?database=billing`, cookies });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({ database: "billing", objects: [{ name: "orders", type: "table", columns: [{ name: "code", dataType: "varchar", columnType: "varchar(255)" }] }], routines: [{ name: "order_count", type: "function" }] });

    const design = await app.inject({ method: "GET", url: `/api/v1/database-connections/${connectionId}/table-design?database=billing&table=orders`, cookies });
    expect(design.statusCode).toBe(200);
    expect(design.json().design.fields[0]).toMatchObject({ name: "code", keyLength: "24", binary: true, columnFormat: "DYNAMIC", storage: "DISK" });
    expect(design.json().design.indexes[0]).toMatchObject({ name: "idx_code", keyBlockSize: 8, parser: "ngram", invisible: true, columnSettings: { code: { length: "12", order: "DESC" } } });
    expect(design.json().design.foreignKeys[0]).toMatchObject({ name: "fk_orders_account", referencedDatabase: "identity", referencedTable: "accounts", onDelete: "CASCADE", onUpdate: "NO ACTION" });
    expect(design.json().design.checks[0]).toMatchObject({ name: "chk_orders_code", expression: "(char_length(`code`) > 0)" });
    expect(design.json().design.options).toMatchObject({ dataDirectory: "/srv/mysql/data", packKeys: "1", statsPersistent: "1" });
    await app.close();
  });
});
