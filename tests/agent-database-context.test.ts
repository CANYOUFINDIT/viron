import { describe, expect, it } from "vitest";
import { assertAgentReadOnlySql, assertAgentWriteSql, sanitizeAgentDatabaseInput } from "../src/desktop/agent-database-context.js";

describe("AI Agent database context", () => {
  it("bounds and redacts renderer-provided editor and result context", () => {
    const result = sanitizeAgentDatabaseInput({
      connectionId: "connection-1",
      database: "app",
      editorSql: "SELECT * FROM users WHERE token=secret-value",
      selectedSql: "password=hunter2",
      resultPreview: Array.from({ length: 25 }, (_, id) => ({ id, token: `value-${id}` })),
    });
    expect(result.editorSql).toContain("token=[REDACTED]");
    expect(result.selectedSql).toBe("password=[REDACTED]");
    expect(result.resultPreview).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.redactionCount).toBe(2);
  });

  it("only permits one SELECT or EXPLAIN SELECT without side effects", () => {
    expect(assertAgentReadOnlySql("SELECT id FROM users LIMIT 10")).toBe("SELECT id FROM users LIMIT 10");
    expect(assertAgentReadOnlySql("EXPLAIN FORMAT=JSON SELECT * FROM users")).toContain("EXPLAIN");
    expect(() => assertAgentReadOnlySql("UPDATE users SET active=0")).toThrow("只允许执行");
    expect(() => assertAgentReadOnlySql("SELECT 1; DELETE FROM users")).toThrow("一条 SQL");
    expect(() => assertAgentReadOnlySql("SELECT * FROM users FOR UPDATE")).toThrow("副作用");
    expect(() => assertAgentReadOnlySql("SELECT 1 INTO OUTFILE '/tmp/a'")).toThrow("副作用");
  });

  it("permits controlled write SQL and rejects account or file side effects", () => {
    expect(assertAgentWriteSql("UPDATE users SET active=0 WHERE id=1")).toBe("UPDATE users SET active=0 WHERE id=1");
    expect(assertAgentWriteSql("DROP TABLE stale_users")).toContain("DROP TABLE");
    expect(() => assertAgentWriteSql("GRANT ALL ON *.* TO 'root'@'%'")).toThrow("只允许受控");
    expect(() => assertAgentWriteSql("INSERT INTO users SELECT 1 INTO OUTFILE '/tmp/a'")).toThrow("账号安全");
    expect(() => assertAgentWriteSql("SELECT id FROM users")).toThrow("只允许受控");
  });
});
