import { describe, expect, it } from "vitest";
import {
  buildAlterTableSql,
  buildCreateTableSql,
  validateTableDesigner,
  type TableDesignerField,
  type TableDesignerState,
} from "../src/client/database-table-designer.js";

function field(id: string, overrides: Partial<TableDesignerField> = {}): TableDesignerField {
  return {
    id,
    name: id,
    type: "VARCHAR",
    length: "255",
    decimals: "",
    notNull: false,
    primaryKey: false,
    unsigned: false,
    autoIncrement: false,
    defaultKind: "none",
    defaultValue: "",
    comment: "",
    ...overrides,
  };
}

function state(overrides: Partial<TableDesignerState> = {}): TableDesignerState {
  return {
    database: "billing",
    tableName: "orders",
    fields: [field("id", { type: "BIGINT", length: "", notNull: true, primaryKey: true, unsigned: true, autoIncrement: true })],
    indexes: [],
    foreignKeys: [],
    checks: [],
    triggers: [],
    options: { engine: "InnoDB", charset: "utf8mb4", collation: "", rowFormat: "", autoIncrement: null },
    comment: "",
    ...overrides,
  };
}

describe("database table designer", () => {
  it("omits blank Navicat table options from the generated SQL", () => {
    const sql = buildCreateTableSql(state());
    expect(sql).not.toContain("MIN_ROWS=");
    expect(sql).not.toContain("AVG_ROW_LENGTH=");
    expect(sql).not.toContain("KEY_BLOCK_SIZE=");
    expect(sql).not.toContain("MAX_ROWS=");
  });

  it("validates field, index, foreign key, check, and trigger definitions", () => {
    const invalid = state({
      tableName: "",
      fields: [
        field("first", { name: "account_id", type: "INT", length: "", autoIncrement: true }),
        field("second", { name: "ACCOUNT_ID", type: "VARCHAR", length: "0" }),
      ],
      indexes: [{ id: "index", name: "idx_missing", type: "INDEX", columns: ["missing"] }],
      foreignKeys: [{
        id: "foreign-key",
        name: "fk_account",
        columns: ["account_id"],
        referencedDatabase: "billing",
        referencedTable: "accounts",
        referencedColumns: [],
        onDelete: "RESTRICT",
        onUpdate: "CASCADE",
      }],
      checks: [{ id: "check", name: "", expression: "amount >= 0" }],
      triggers: [{ id: "trigger", name: "orders_before_insert", timing: "BEFORE", event: "INSERT", statement: "" }],
    });

    expect(validateTableDesigner(invalid)).toEqual(expect.arrayContaining([
      "表名需为 1–64 个有效字符",
      "字段 account_id 的自动递增仅支持整数主键",
      "字段名称重复：ACCOUNT_ID",
      "字段 ACCOUNT_ID 需要有效长度",
      "索引 idx_missing 包含不存在的字段",
      "外键 fk_account 的本地字段和引用字段数量必须一致",
      "检查约束需要有效名称和表达式",
      "触发器需要有效名称和执行语句",
    ]));
  });

  it("generates a complete MySQL create-table script", () => {
    const design = state({
      fields: [
        field("id", { type: "BIGINT", length: "", notNull: true, primaryKey: true, unsigned: true, autoIncrement: true }),
        field("account_id", { type: "BIGINT", length: "", notNull: true, unsigned: true }),
        field("customer_name", { type: "VARCHAR", length: "80", defaultKind: "value", defaultValue: "O'Reilly", comment: "Buyer's name" }),
        field("amount", { type: "DECIMAL", length: "12", decimals: "2", notNull: true, defaultKind: "value", defaultValue: "0" }),
        field("gross_amount", { type: "DECIMAL", length: "14", decimals: "2", generated: true, generatedExpression: "amount * 1.2", generatedStored: true }),
        field("created_at", { type: "TIMESTAMP", length: "", notNull: true, defaultKind: "expression", defaultValue: "CURRENT_TIMESTAMP" }),
      ],
      indexes: [{ id: "index", name: "uniq_account_name", type: "UNIQUE", columns: ["account_id", "customer_name"], method: "BTREE", comment: "Account lookup", invisible: true }],
      foreignKeys: [{
        id: "foreign-key",
        name: "fk_orders_account",
        columns: ["account_id"],
        referencedDatabase: "identity",
        referencedTable: "accounts",
        referencedColumns: ["id"],
        onDelete: "CASCADE",
        onUpdate: "NO ACTION",
      }],
      checks: [{ id: "check", name: "chk_orders_amount", expression: "amount >= 0" }],
      triggers: [{ id: "trigger", name: "orders_before_insert", timing: "BEFORE", event: "INSERT", statement: "SET NEW.created_at = CURRENT_TIMESTAMP;" }],
      options: { engine: "InnoDB", charset: "utf8mb4", collation: "utf8mb4_unicode_ci", rowFormat: "DYNAMIC", autoIncrement: 1000, minRows: 10, averageRowLength: 256, keyBlockSize: 8, maxRows: 100000 },
      comment: "Customer orders",
    });

    expect(validateTableDesigner(design)).toEqual([]);
    const sql = buildCreateTableSql(design);
    expect(sql).toContain("CREATE TABLE `billing`.`orders`");
    expect(sql).toContain("`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT");
    expect(sql).toContain("`customer_name` VARCHAR(80) NULL DEFAULT 'O''Reilly' COMMENT 'Buyer''s name'");
    expect(sql).toContain("`amount` DECIMAL(12,2) NOT NULL DEFAULT 0");
    expect(sql).toContain("`gross_amount` DECIMAL(14,2) GENERATED ALWAYS AS (amount * 1.2) STORED");
    expect(sql).toContain("UNIQUE KEY `uniq_account_name` (`account_id`, `customer_name`) USING BTREE COMMENT 'Account lookup' INVISIBLE");
    expect(sql).toContain("CONSTRAINT `fk_orders_account` FOREIGN KEY (`account_id`) REFERENCES `identity`.`accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION");
    expect(sql).toContain("CONSTRAINT `chk_orders_amount` CHECK (amount >= 0)");
    expect(sql).toContain("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC AUTO_INCREMENT=1000 MIN_ROWS=10 AVG_ROW_LENGTH=256 KEY_BLOCK_SIZE=8 MAX_ROWS=100000 COMMENT='Customer orders';");
    expect(sql).toContain("CREATE TRIGGER `billing`.`orders_before_insert` BEFORE INSERT ON `billing`.`orders` FOR EACH ROW SET NEW.created_at = CURRENT_TIMESTAMP;");
  });

  it("generates Navicat advanced field, index, and table options", () => {
    const design = state({
      fields: [
        field("code", { primaryKey: true, keyLength: "24", notNull: true, charset: "utf8mb4", collation: "utf8mb4_bin", binary: true, columnFormat: "DYNAMIC", storage: "DISK" }),
        field("amount", { type: "DECIMAL", length: "10", decimals: "2", unsigned: true, zerofill: true }),
      ],
      indexes: [{ id: "lookup", name: "idx_code", type: "INDEX", columns: ["code"], columnSettings: { code: { length: "12", order: "DESC" } }, method: "BTREE", keyBlockSize: 8, parser: "ngram", invisible: true }],
      options: {
        engine: "InnoDB",
        charset: "utf8mb4",
        collation: "utf8mb4_unicode_ci",
        rowFormat: "DYNAMIC",
        autoIncrement: null,
        dataDirectory: "/srv/mysql/data",
        indexDirectory: "/srv/mysql/index",
        delayKeyWrite: true,
        packKeys: "DEFAULT",
        checksum: true,
        pageChecksum: false,
        connection: "archive/server",
        encryption: "Y",
        unionTables: "billing.orders_2025, `billing`.`orders_2026`",
        insertMethod: "LAST",
        statsPersistent: "1",
        statsAutoRecalc: "DEFAULT",
        statsSamplePages: 32,
        transactional: true,
      },
    });

    expect(validateTableDesigner(design)).toEqual([]);
    const sql = buildCreateTableSql(design);
    expect(sql).toContain("`code` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin BINARY NOT NULL COLUMN_FORMAT DYNAMIC STORAGE DISK");
    expect(sql).toContain("`amount` DECIMAL(10,2) UNSIGNED ZEROFILL NULL");
    expect(sql).toContain("PRIMARY KEY (`code`(24))");
    expect(sql).toContain("KEY `idx_code` (`code`(12) DESC) USING BTREE KEY_BLOCK_SIZE=8 WITH PARSER `ngram` INVISIBLE");
    expect(sql).toContain("DATA DIRECTORY='/srv/mysql/data'");
    expect(sql).toContain("UNION=(`billing`.`orders_2025`, `billing`.`orders_2026`)");
    expect(sql).toContain("STATS_PERSISTENT=1 STATS_AUTO_RECALC=DEFAULT STATS_SAMPLE_PAGES=32 TRANSACTIONAL=1");
  });

  it("rebuilds a primary key when only its prefix length changes and resets advanced options", () => {
    const original = state({
      fields: [field("code", { originalName: "code", primaryKey: true, keyLength: "12", notNull: true })],
      options: { engine: "InnoDB", charset: "utf8mb4", collation: "", rowFormat: "", autoIncrement: null, packKeys: "1", connection: "archive", unionTables: "billing.archive", statsPersistent: "1" },
    });
    const current = JSON.parse(JSON.stringify(original)) as TableDesignerState;
    current.fields[0].keyLength = "24";
    current.options.packKeys = "";
    current.options.connection = "";
    current.options.unionTables = "";
    current.options.statsPersistent = "";

    const sql = buildAlterTableSql(original, current);
    expect(sql).toContain("DROP PRIMARY KEY");
    expect(sql).toContain("ADD PRIMARY KEY (`code`(24))");
    expect(sql).toContain("PACK_KEYS=DEFAULT");
    expect(sql).toContain("CONNECTION=''");
    expect(sql).toContain("UNION=()");
    expect(sql).toContain("STATS_PERSISTENT=DEFAULT");
  });

  it("generates dependency-ordered ALTER statements for an existing table", () => {
    const original = state({
      fields: [
        field("id", { originalName: "id", type: "BIGINT", length: "", notNull: true, primaryKey: true, unsigned: true, autoIncrement: true }),
        field("account_id", { originalName: "account_id", type: "BIGINT", length: "", notNull: true, unsigned: true }),
        field("status", { originalName: "status", type: "VARCHAR", length: "20", notNull: true, defaultKind: "value", defaultValue: "open" }),
      ],
      indexes: [{ id: "status-index", originalName: "idx_status", name: "idx_status", type: "INDEX", columns: ["status"], method: "BTREE" }],
      foreignKeys: [{
        id: "account-fk",
        originalName: "fk_orders_account",
        name: "fk_orders_account",
        columns: ["account_id"],
        referencedDatabase: "billing",
        referencedTable: "accounts",
        referencedColumns: ["id"],
        onDelete: "RESTRICT",
        onUpdate: "RESTRICT",
      }],
      checks: [{ id: "status-check", originalName: "chk_status", name: "chk_status", expression: "status <> ''" }],
      triggers: [{ id: "touch-trigger", originalName: "orders_before_update", name: "orders_before_update", timing: "BEFORE", event: "UPDATE", statement: "SET NEW.status = LOWER(NEW.status)" }],
      comment: "Original",
    });
    const current = JSON.parse(JSON.stringify(original)) as TableDesignerState;
    current.fields[1].name = "customer_id";
    current.fields[2].length = "40";
    current.indexes = [{ id: "customer-index", name: "uniq_customer_status", type: "UNIQUE", columns: ["customer_id", "status"], method: "BTREE" }];
    current.foreignKeys[0].columns = ["customer_id"];
    current.foreignKeys[0].onDelete = "CASCADE";
    current.checks[0].expression = "CHAR_LENGTH(status) > 0";
    current.triggers[0].statement = "SET NEW.status = UPPER(NEW.status)";
    current.comment = "Updated";

    const sql = buildAlterTableSql(original, current);
    expect(sql).toContain("DROP TRIGGER IF EXISTS `billing`.`orders_before_update`;");
    expect(sql).toContain("DROP FOREIGN KEY `fk_orders_account`");
    expect(sql).toContain("DROP CHECK `chk_status`");
    expect(sql).toContain("DROP INDEX `idx_status`");
    expect(sql).toContain("CHANGE COLUMN `account_id` `customer_id` BIGINT UNSIGNED NOT NULL AFTER `id`");
    expect(sql).toContain("MODIFY COLUMN `status` VARCHAR(40) NOT NULL DEFAULT 'open' AFTER `customer_id`");
    expect(sql).toContain("ADD UNIQUE KEY `uniq_customer_status` (`customer_id`, `status`) USING BTREE");
    expect(sql).toContain("ADD CONSTRAINT `fk_orders_account` FOREIGN KEY (`customer_id`) REFERENCES `billing`.`accounts` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT");
    expect(sql).toContain("COMMENT='Updated'");
    expect(sql).toContain("CREATE TRIGGER `billing`.`orders_before_update` BEFORE UPDATE ON `billing`.`orders` FOR EACH ROW SET NEW.status = UPPER(NEW.status);");
    expect(sql.indexOf("DROP TRIGGER")).toBeLessThan(sql.indexOf("ALTER TABLE"));
    expect(sql.indexOf("ALTER TABLE")).toBeLessThan(sql.indexOf("CREATE TRIGGER"));
  });

  it("does not generate ALTER SQL when an existing design is unchanged", () => {
    const original = state({ fields: [field("id", { originalName: "id", type: "BIGINT", length: "", notNull: true, primaryKey: true })] });
    expect(buildAlterTableSql(original, JSON.parse(JSON.stringify(original)) as TableDesignerState)).toBe("-- 未检测到结构变更");
  });
});
