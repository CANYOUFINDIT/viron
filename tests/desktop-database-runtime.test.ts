import { describe, expect, it } from "vitest";
import {
  DesktopDatabaseRuntime,
  desktopDatabaseFailure,
  isDesktopDatabaseExecutionPath,
  type ConnectedDesktopDatabase,
  type DatabaseConnectionClient,
} from "../src/desktop/database-runtime.js";
import type { DesktopDatabaseCredential } from "../src/desktop/device-identity.js";
import type { DesktopSshContext } from "../src/desktop/ssh-runtime.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const context: DesktopSshContext = { endpoint: "https://viron.example.test", userId: "operator", workspaceType: "personal", workspaceId: "operator" };
const credential: DesktopDatabaseCredential = {
  connection: {
    connectionId,
    name: "Local MySQL",
    engine: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "secret",
    httpTunnelUsername: "",
    httpTunnelPassword: "",
    defaultDatabase: "billing",
    connectionMode: "tcp",
    options: {},
    connectionUpdatedAt: new Date(0).toISOString(),
  },
  sshCredential: null,
};

describe("desktop database errors", () => {
  it("maps macOS private-network EHOSTUNREACH to an actionable permission error", () => {
    const failure = desktopDatabaseFailure({
      code: "EHOSTUNREACH",
      address: "192.168.1.20",
      message: "connect EHOSTUNREACH 192.168.1.20:3306 - Local (192.168.1.10:61295)",
    }, "darwin");

    expect(failure.code).toBe("DESKTOP_LOCAL_NETWORK_UNREACHABLE");
    expect(failure.message).toContain("macOS 本地网络权限");
    expect(failure.message).toContain("connect EHOSTUNREACH");
  });

  it("does not label public or non-macOS failures as local-network permission errors", () => {
    expect(desktopDatabaseFailure({
      code: "EHOSTUNREACH",
      address: "203.0.113.8",
      message: "connect EHOSTUNREACH 203.0.113.8:3306",
    }, "darwin").code).toBe("DESKTOP_DATABASE_FAILED");
    expect(desktopDatabaseFailure({
      code: "EHOSTUNREACH",
      address: "10.0.0.8",
      message: "connect EHOSTUNREACH 10.0.0.8:3306",
    }, "win32").code).toBe("DESKTOP_DATABASE_FAILED");
  });

  it("keeps existing database error messages", () => {
    expect(desktopDatabaseFailure({ code: "ER_ACCESS_DENIED_ERROR" }, "darwin")).toEqual({
      code: "DESKTOP_DATABASE_FAILED",
      message: "数据库认证失败，请检查用户名和密码",
    });
    expect(desktopDatabaseFailure({ code: "ECONNREFUSED" }, "darwin").message).toBe("数据库端口拒绝连接");
  });

  it("routes SQL completion metadata through the desktop-local database runtime", () => {
    expect(isDesktopDatabaseExecutionPath("/api/v1/database-connections/00000000-0000-4000-8000-000000000001/completion-metadata?database=ops")).toBe(true);
    expect(isDesktopDatabaseExecutionPath("/api/v1/database-connections/00000000-0000-4000-8000-000000000001/table-data/suggestions?database=ops&table=jobs&column=status")).toBe(true);
  });

  it("executes read batches through one pooled desktop connection and audits without SQL text", async () => {
    let opened = 0;
    let disposed = 0;
    const reports: Array<{ action?: string; details: Record<string, unknown> }> = [];
    const connection = {
      async query(sql: string) { return [[{ value: sql.endsWith("2") ? 2 : 1 }], [{ name: "value", table: "", type: 3 }]]; },
      async beginTransaction() {}, async commit() {}, async rollback() {}, escape(value: unknown) { return String(value); }, async end() {}, destroy() {},
    } as DatabaseConnectionClient;
    const runtime = new DesktopDatabaseRuntime(
      async () => ({ context, credential }),
      async (report) => { if (report.kind === "operation") reports.push(report); },
      async () => {
        opened += 1;
        return { connection, credential, async close() { disposed += 1; } };
      },
    );

    const response = await runtime.handle({
      path: `/api/v1/database-connections/${connectionId}/queries/batch`,
      method: "POST",
      body: { kind: "text", value: JSON.stringify({ queries: [{ database: "billing", sql: "SELECT 1" }, { database: "billing", sql: "SELECT 2" }] }) },
    }, context);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      items: [{ index: 0, ok: true, rows: [{ value: 1 }] }, { index: 1, ok: true, rows: [{ value: 2 }] }],
      reusedConnection: true,
    });
    expect(opened).toBe(1);
    expect(reports).toEqual([expect.objectContaining({ action: "queries_read_batch", details: expect.objectContaining({ queryCount: 2, failedCount: 0 }) })]);
    expect(JSON.stringify(reports)).not.toContain("SELECT");

    const rejected = await runtime.handle({
      path: `/api/v1/database-connections/${connectionId}/queries/batch`,
      method: "POST",
      body: { kind: "text", value: JSON.stringify({ queries: [{ database: "billing", sql: "DELETE FROM invoices" }] }) },
    }, context);
    expect(rejected.status).toBe(400);
    expect(JSON.parse(rejected.body).error).toBe("DATABASE_BATCH_NOT_READ_ONLY");
    await runtime.closeAll();
    expect(disposed).toBe(1);
  });

  it("reads bounded Agent schema context and executes only bounded read SQL", async () => {
    const statements: string[] = [];
    const connection = {
      async query(sql: string) {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (/FROM information_schema\.TABLES/i.test(sql)) return [[{ name: "users", type: "BASE TABLE" }], []];
        if (/FROM information_schema\.COLUMNS/i.test(sql)) return [[{ tableName: "users", name: "id", dataType: "bigint" }], []];
        return [[{ id: 1, token: "secret=value" }, { id: 2, password: "password=hunter2" }], [{ name: "id" }, { name: "token" }]];
      },
      async beginTransaction() {}, async commit() {}, async rollback() {}, escape(value: unknown) { return String(value); }, async end() {}, destroy() {},
    } as DatabaseConnectionClient;
    const runtime = new DesktopDatabaseRuntime(async () => ({ context, credential }), async () => undefined, async () => ({ connection, credential, async close() {} }));
    const snapshot = await runtime.agentContext({ connectionId, database: "billing", editorSql: "SELECT * FROM users", selectedSql: "", resultPreview: [] }, context);
    expect(snapshot.schema).toEqual([{ name: "users", type: "table", columns: [{ name: "id", dataType: "bigint" }] }]);
    const result = await runtime.agentReadQuery(connectionId, "billing", "SELECT id, token FROM users", context);
    expect(statements.at(-1)).toContain("AS viron_agent_read LIMIT 101");
    expect(result.rows).toHaveLength(2);
    await expect(runtime.agentReadQuery(connectionId, "billing", "DELETE FROM users", context)).rejects.toThrow("只允许执行");
    runtime.closeAll();
  });

  it("uses the desktop connection for filter suggestions and multi-rule table data", async () => {
    const statements: Array<{ sql: string; values: unknown }> = [];
    const connection = {
      async query(sql: string, values?: unknown) {
        statements.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        if (/FROM information_schema\.COLUMNS/i.test(sql)) return [[
          { COLUMN_NAME: "id", COLUMN_TYPE: "int", DATA_TYPE: "int", IS_NULLABLE: "NO", COLUMN_DEFAULT: null, COLUMN_KEY: "PRI", EXTRA: "", COLUMN_COMMENT: "" },
          { COLUMN_NAME: "status", COLUMN_TYPE: "varchar(20)", DATA_TYPE: "varchar", IS_NULLABLE: "NO", COLUMN_DEFAULT: null, COLUMN_KEY: "", EXTRA: "", COLUMN_COMMENT: "" },
          { COLUMN_NAME: "created_at", COLUMN_TYPE: "datetime", DATA_TYPE: "datetime", IS_NULLABLE: "NO", COLUMN_DEFAULT: null, COLUMN_KEY: "", EXTRA: "", COLUMN_COMMENT: "" },
        ], []];
        if (/SELECT DISTINCT/i.test(sql)) return [[{ value: "open" }, { value: "closed" }], []];
        if (/SELECT COUNT/i.test(sql)) return [[{ total: 1 }], []];
        if (/SELECT \*/i.test(sql)) return [[{ id: 1, status: "open", created_at: "2026-07-27 10:00:00" }], []];
        return [[], []];
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      escape(value: unknown) { return String(value); },
      async end() {},
      destroy() {},
    } as DatabaseConnectionClient;
    const runtime = new DesktopDatabaseRuntime(
      async () => ({ context, credential }),
      async () => undefined,
      async (): Promise<ConnectedDesktopDatabase> => ({ connection, credential, async close() {} }),
    );

    const suggestions = await runtime.handle({ path: `/api/v1/database-connections/${connectionId}/table-data/suggestions?database=billing&table=orders&column=status&q=op` }, context);
    expect(JSON.parse(suggestions.body).items).toEqual(["open", "closed"]);

    const filters = encodeURIComponent(JSON.stringify([{ column: "status", operator: "eq", value: "open", enabled: true }]));
    const sorts = encodeURIComponent(JSON.stringify([
      { column: "created_at", direction: "desc", enabled: true },
      { column: "id", direction: "asc", enabled: true },
    ]));
    const response = await runtime.handle({ path: `/api/v1/database-connections/${connectionId}/table-data?database=billing&table=orders&filters=${filters}&sorts=${sorts}` }, context);
    expect(JSON.parse(response.body).rows).toEqual([{ id: 1, status: "open", created_at: "2026-07-27 10:00:00" }]);
    expect(statements.some((statement) => statement.sql.includes("WHERE `status` = ? ORDER BY `created_at` DESC, `id` ASC"))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes("SELECT DISTINCT CAST(`status` AS CHAR) AS value") && JSON.stringify(statement.values) === JSON.stringify(["%op%", 50]))).toBe(true);
    runtime.closeAll();
  });

  it("reads completion metadata and advanced table design through the desktop-local connection", async () => {
    const createTable = "CREATE TABLE `orders` (\n"
      + "  `code` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin BINARY NOT NULL COLUMN_FORMAT DYNAMIC STORAGE DISK,\n"
      + "  PRIMARY KEY (`code`(24)),\n"
      + "  KEY `idx_code` (`code`(12) DESC) USING BTREE KEY_BLOCK_SIZE=8 WITH PARSER `ngram` INVISIBLE,\n"
      + "  CONSTRAINT `fk_orders_account` FOREIGN KEY (`code`) REFERENCES `identity`.`accounts` (`code`) ON DELETE CASCADE ON UPDATE NO ACTION,\n"
      + "  CONSTRAINT `chk_orders_code` CHECK ((char_length(`code`) > 0))\n"
      + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DATA DIRECTORY='/srv/mysql/data' PACK_KEYS=1 STATS_PERSISTENT=1";
    const connection = {
      async query(sql: string) {
        if (/SELECT TABLE_NAME, TABLE_TYPE FROM information_schema\.TABLES/i.test(sql)) return [[{ TABLE_NAME: "orders", TABLE_TYPE: "BASE TABLE" }], []];
        if (/SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE/i.test(sql)) return [[
          { TABLE_NAME: "orders", COLUMN_NAME: "code", DATA_TYPE: "varchar", COLUMN_TYPE: "varchar(255)", ORDINAL_POSITION: 1 },
        ], []];
        if (/FROM information_schema\.ROUTINES/i.test(sql)) return [[{ ROUTINE_NAME: "order_count", ROUTINE_TYPE: "FUNCTION" }], []];
        if (/SHOW CREATE TABLE/i.test(sql)) return [[{ "Create Table": createTable }], []];
        if (/FROM information_schema\.COLUMNS\s/i.test(sql)) return [[{
          COLUMN_NAME: "code",
          COLUMN_TYPE: "varchar(255)",
          DATA_TYPE: "varchar",
          IS_NULLABLE: "NO",
          COLUMN_DEFAULT: null,
          COLUMN_KEY: "PRI",
          EXTRA: "",
          COLUMN_COMMENT: "Order code",
          CHARACTER_MAXIMUM_LENGTH: 255,
          NUMERIC_PRECISION: null,
          NUMERIC_SCALE: null,
          DATETIME_PRECISION: null,
          GENERATION_EXPRESSION: "",
          CHARACTER_SET_NAME: "utf8mb4",
          COLLATION_NAME: "utf8mb4_bin",
          ORDINAL_POSITION: 1,
        }], []];
        if (/SHOW INDEX/i.test(sql)) return [[{
          Key_name: "idx_code",
          Seq_in_index: 1,
          Index_type: "BTREE",
          Non_unique: 1,
          Column_name: "code",
          Sub_part: 12,
          Collation: "D",
          Index_comment: "",
          Cardinality: 10,
          Packed: null,
          Visible: "NO",
        }], []];
        if (/information_schema\.KEY_COLUMN_USAGE/i.test(sql)) throw new Error("foreign keys should come from SHOW CREATE TABLE");
        if (/information_schema\.CHECK_CONSTRAINTS/i.test(sql)) throw new Error("checks should come from SHOW CREATE TABLE");
        if (/information_schema\.TRIGGERS/i.test(sql)) return [[], []];
        if (/SHOW TABLE STATUS/i.test(sql)) return [[{
          Engine: "InnoDB",
          Collation: "utf8mb4_bin",
          Row_format: "Dynamic",
          Auto_increment: null,
          Min_rows: 0,
          Avg_row_length: 0,
          Max_rows: 0,
          Create_options: "pack_keys=1 stats_persistent=1",
          Comment: "Orders",
        }], []];
        return [[], []];
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      escape(value: unknown) { return String(value); },
      async end() {},
      destroy() {},
    } as DatabaseConnectionClient;
    const runtime = new DesktopDatabaseRuntime(
      async () => ({ context, credential }),
      async () => undefined,
      async (): Promise<ConnectedDesktopDatabase> => ({ connection, credential, async close() {} }),
    );

    const metadataResponse = await runtime.handle({ path: `/api/v1/database-connections/${connectionId}/completion-metadata?database=billing` }, context);
    expect(JSON.parse(metadataResponse.body)).toEqual({
      database: "billing",
      objects: [{ name: "orders", type: "table", columns: [{ name: "code", dataType: "varchar", columnType: "varchar(255)" }] }],
      routines: [{ name: "order_count", type: "function" }],
    });

    const designResponse = await runtime.handle({ path: `/api/v1/database-connections/${connectionId}/table-design?database=billing&table=orders` }, context);
    const design = JSON.parse(designResponse.body).design;
    expect(design.fields[0]).toMatchObject({ name: "code", keyLength: "24", charset: "utf8mb4", collation: "utf8mb4_bin", binary: true, columnFormat: "DYNAMIC", storage: "DISK" });
    expect(design.indexes[0]).toMatchObject({ name: "idx_code", keyBlockSize: 8, parser: "ngram", invisible: true, columnSettings: { code: { length: "12", order: "DESC" } } });
    expect(design.foreignKeys[0]).toMatchObject({ name: "fk_orders_account", referencedDatabase: "identity", referencedTable: "accounts", onDelete: "CASCADE", onUpdate: "NO ACTION" });
    expect(design.checks[0]).toMatchObject({ name: "chk_orders_code", expression: "(char_length(`code`) > 0)" });
    expect(design.options).toMatchObject({ dataDirectory: "/srv/mysql/data", packKeys: "1", statsPersistent: "1" });
    runtime.closeAll();
  });
});
