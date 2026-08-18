import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { normalizeMysqlSql, SqliteDatabaseClient } from "../src/server/database-client.js";
import { isUniqueConstraintError } from "../src/server/database-errors.js";

describe("database adapters", () => {
  it("normalizes the SQLite compatibility SQL used by MariaDB", () => {
    expect(normalizeMysqlSql("SELECT id FROM users WHERE username = ? COLLATE NOCASE"))
      .toBe("SELECT id FROM users WHERE username = ?");
    expect(normalizeMysqlSql("INSERT OR IGNORE INTO links (id) VALUES (?)"))
      .toBe("INSERT IGNORE INTO links (id) VALUES (?)");
    expect(normalizeMysqlSql(`
      INSERT INTO settings (\`key\`, value_json) VALUES (?, ?)
      ON CONFLICT(\`key\`) DO UPDATE SET value_json = excluded.value_json
    `)).toContain("ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)");
  });

  it("recognizes SQLite and MySQL duplicate-key errors", () => {
    expect(isUniqueConstraintError({ code: "ER_DUP_ENTRY" })).toBe(true);
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed"))).toBe(true);
    expect(isUniqueConstraintError(new Error("connection failed"))).toBe(false);
  });

  it("rolls back an asynchronous SQLite transaction", async () => {
    const db = new SqliteDatabaseClient(new Database(":memory:"));
    await db.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
    await expect(db.transaction(async () => {
      await db.prepare("INSERT INTO items (id) VALUES (?)").run("temporary");
      throw new Error("rollback");
    })()).rejects.toThrow("rollback");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM items").get()).toEqual({ count: 0 });
    await db.close();
  });
});
