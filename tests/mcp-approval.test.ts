import { describe, expect, it } from "vitest";
import { mcpApprovalMode, mcpApprovalRequired } from "../src/shared/mcp-settings.js";

describe("MCP approval policy", () => {
  it("normalizes persisted values and applies the three approval levels", () => {
    expect(mcpApprovalMode(undefined)).toBe("always");
    expect(mcpApprovalMode("unexpected")).toBe("always");
    expect(mcpApprovalMode("never")).toBe("never");

    expect(mcpApprovalRequired("always", "low")).toBe(false);
    expect(mcpApprovalRequired("always", "medium")).toBe(true);
    expect(mcpApprovalRequired("always", "high")).toBe(true);
    expect(mcpApprovalRequired("high-risk", "medium")).toBe(false);
    expect(mcpApprovalRequired("high-risk", "high")).toBe(true);
    expect(mcpApprovalRequired("never", "high")).toBe(false);
  });
});
