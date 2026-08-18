import { describe, expect, it } from "vitest";
import {
  agentApprovalMode,
  agentApprovalRequired,
  agentExecutionPresentation,
} from "../src/shared/agent.js";

describe("Viron Agent approval and presentation policy", () => {
  it("keeps legacy or invalid settings on restrictive defaults", () => {
    expect(agentApprovalMode(undefined)).toBe("always");
    expect(agentApprovalMode("unexpected")).toBe("always");
    expect(agentExecutionPresentation(undefined)).toBe("conversation");
    expect(agentExecutionPresentation("unexpected")).toBe("conversation");
  });

  it("applies the three approval modes without changing the action risk", () => {
    expect(agentApprovalRequired("always", "low")).toBe(true);
    expect(agentApprovalRequired("always", "high")).toBe(true);
    expect(agentApprovalRequired("risk-only", "low")).toBe(false);
    expect(agentApprovalRequired("risk-only", "medium")).toBe(true);
    expect(agentApprovalRequired("risk-only", "high")).toBe(true);
    expect(agentApprovalRequired("never", "high")).toBe(false);
  });
});
