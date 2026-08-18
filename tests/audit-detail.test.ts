import { describe, expect, it } from "vitest";
import { auditDetailSummary } from "../src/client/audit-detail.js";

describe("audit detail summary", () => {
  it("shows at most three useful fields in a stable order", () => {
    expect(auditDetailSummary({
      database: "envman",
      rowCount: 12,
      status: "success",
      durationMs: 48,
    })).toEqual(["状态 成功", "耗时 48 ms", "行数 12"]);
  });

  it("omits unknown, structured, multiline, and overlong values", () => {
    expect(auditDetailSummary({
      password: "database-secret",
      token: "access-token",
      items: [{ id: "resource-1" }],
      host: "line-one\nline-two",
      path: "/".repeat(81),
      port: 22,
    })).toEqual(["端口 22"]);
  });
});
