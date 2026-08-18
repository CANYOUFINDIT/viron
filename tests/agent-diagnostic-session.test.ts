import { describe, expect, it } from "vitest";
import {
  AGENT_DIAGNOSTIC_MAX_DURATION_MS,
  AGENT_DIAGNOSTIC_MAX_STEPS,
  AgentDiagnosticBudget,
  agentRuntimeScopeMatches,
} from "../src/desktop/agent-diagnostic-session.js";

describe("Agent multi-step diagnostic budget", () => {
  it("shares one 64-call safety budget across Pi and specialized tools", () => {
    const budget = new AgentDiagnosticBudget(1_000);
    for (let step = 1; step <= AGENT_DIAGNOSTIC_MAX_STEPS; step += 1) {
      expect(budget.beginStep(1_000 + step)).toBe(step);
    }
    expect(budget.remaining).toBe(0);
    expect(() => budget.beginStep(1_100)).toThrow("64 次工具调用安全上限");
  });

  it("includes approval waiting and model execution in the 20-minute deadline", () => {
    const budget = new AgentDiagnosticBudget(5_000);
    expect(budget.remainingDuration(5_001)).toBe(AGENT_DIAGNOSTIC_MAX_DURATION_MS - 1);
    expect(() => budget.assertAvailable(5_000 + AGENT_DIAGNOSTIC_MAX_DURATION_MS)).toThrow("20 分钟安全时限");
  });

  it("binds an active run to endpoint, user and workspace", () => {
    const scope = { vironEndpoint: "https://viron.example", vironUserId: "u1", workspaceType: "organization" as const, workspaceId: "o1" };
    expect(agentRuntimeScopeMatches(scope, { ...scope })).toBe(true);
    expect(agentRuntimeScopeMatches(scope, { ...scope, workspaceId: "o2" })).toBe(false);
    expect(agentRuntimeScopeMatches(scope, { ...scope, vironUserId: "u2" })).toBe(false);
  });
});
