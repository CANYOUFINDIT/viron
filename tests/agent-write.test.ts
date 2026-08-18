import { describe, expect, it } from "vitest";
import { describeAgentWriteCommand, describeAgentWriteSql } from "../src/shared/agent-write.js";
import { assertAgentWriteSql } from "../src/desktop/agent-database-context.js";

describe("Agent write impact previews", () => {
  it("classifies DML, missing WHERE, and schema changes", () => {
    expect(describeAgentWriteSql("UPDATE users SET active=0 WHERE id=1")).toMatchObject({
      kind: "update",
      riskLevel: "medium",
      missingWhere: false,
      targets: ["users"],
      previewSql: "SELECT COUNT(*) AS affected_estimate FROM users WHERE id=1",
    });
    expect(describeAgentWriteSql("DELETE FROM users")).toMatchObject({
      kind: "delete",
      riskLevel: "high",
      missingWhere: true,
      previewSql: "SELECT COUNT(*) AS affected_estimate FROM users",
    });
    expect(describeAgentWriteSql("DROP TABLE users")).toMatchObject({
      kind: "drop",
      riskLevel: "high",
      targets: ["users"],
    });
    expect(describeAgentWriteSql("TRUNCATE TABLE logs")).toMatchObject({
      kind: "truncate",
      riskLevel: "high",
      targets: ["logs"],
    });
    expect(describeAgentWriteSql("INSERT INTO users (name) VALUES ('a')")).toMatchObject({
      kind: "insert",
      riskLevel: "medium",
      targets: ["users"],
    });
  });

  it("rejects account-management and file-side-effect SQL", () => {
    expect(() => assertAgentWriteSql("GRANT ALL ON *.* TO 'root'@'%'")).toThrow("只允许受控");
    expect(() => assertAgentWriteSql("INSERT INTO users SELECT 1 INTO OUTFILE '/tmp/a'")).toThrow("账号安全");
    expect(() => assertAgentWriteSql("SELECT 1")).toThrow("只允许受控");
    expect(() => assertAgentWriteSql("UPDATE users SET active=0; DELETE FROM users")).toThrow("一条 SQL");
  });

  it("describes high-risk SSH write commands", () => {
    expect(describeAgentWriteCommand("rm -rf /tmp/cache")).toMatchObject({
      riskLevel: "high",
      reason: expect.stringContaining("删除"),
    });
    expect(describeAgentWriteCommand("systemctl restart nginx")).toMatchObject({
      riskLevel: "high",
      reason: expect.stringContaining("服务"),
    });
    expect(() => describeAgentWriteCommand("uptime")).toThrow("只读");
  });
});
