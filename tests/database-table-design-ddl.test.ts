import { describe, expect, it } from "vitest";
import { parseCreateTableConstraints } from "../src/shared/database-table-design.js";

describe("database table design DDL parsing", () => {
  it("reads foreign keys and checks from SHOW CREATE TABLE without information_schema lookups", () => {
    const parsed = parseCreateTableConstraints(`CREATE TABLE \`orders\` (
      \`tenant_id\` bigint NOT NULL,
      \`account_id\` bigint NOT NULL,
      \`payload\` json DEFAULT NULL,
      CONSTRAINT \`fk_orders_account\` FOREIGN KEY (\`tenant_id\`, \`account_id\`) REFERENCES \`identity-prod\`.\`accounts\` (\`tenant_id\`, \`id\`) ON DELETE SET NULL ON UPDATE NO ACTION,
      CONSTRAINT \`chk_orders_payload\` CHECK ((json_extract(\`payload\`, '$.kind') in ('retail','business')))
    ) ENGINE=InnoDB`, "billing");

    expect(parsed).toEqual({
      foreignKeys: [{
        originalName: "fk_orders_account",
        name: "fk_orders_account",
        columns: ["tenant_id", "account_id"],
        referencedDatabase: "identity-prod",
        referencedTable: "accounts",
        referencedColumns: ["tenant_id", "id"],
        onDelete: "SET NULL",
        onUpdate: "NO ACTION",
      }],
      checks: [{
        originalName: "chk_orders_payload",
        name: "chk_orders_payload",
        expression: "(json_extract(`payload`, '$.kind') in ('retail','business'))",
      }],
      foreignKeysComplete: true,
      checksComplete: true,
    });
  });

  it("uses the current database for unqualified references and defaults omitted actions", () => {
    const parsed = parseCreateTableConstraints(`CREATE TABLE \`environments\` (
      \`group_id\` varchar(64) DEFAULT NULL,
      CONSTRAINT \`environments_group_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`environment_groups\` (\`id\`) ON DELETE SET NULL
    ) ENGINE=InnoDB`, "viron");

    expect(parsed.foreignKeys[0]).toMatchObject({
      referencedDatabase: "viron",
      referencedTable: "environment_groups",
      onDelete: "SET NULL",
      onUpdate: "RESTRICT",
    });
    expect(parsed.foreignKeysComplete).toBe(true);
    expect(parsed.checksComplete).toBe(true);
  });

  it("marks unsupported constraint syntax incomplete so callers can fall back safely", () => {
    const parsed = parseCreateTableConstraints(`CREATE TABLE \`orders\` (
      \`account_id\` bigint NOT NULL,
      FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\` (\`id\`),
      CHECK (account_id > 0)
    ) ENGINE=InnoDB`, "billing");

    expect(parsed.foreignKeys).toEqual([]);
    expect(parsed.checks).toEqual([]);
    expect(parsed.foreignKeysComplete).toBe(false);
    expect(parsed.checksComplete).toBe(false);
  });

  it("treats a valid table without constraints as fully parsed", () => {
    expect(parseCreateTableConstraints("CREATE TABLE `simple` (`id` bigint NOT NULL) ENGINE=InnoDB", "billing")).toEqual({
      foreignKeys: [],
      checks: [],
      foreignKeysComplete: true,
      checksComplete: true,
    });
  });
});
