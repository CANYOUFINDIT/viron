import { describe, expect, it } from "vitest";
import {
  addAgentTurnUsage,
  agentTurnDurationMs,
  agentTurnStatsSummary,
  agentTurnTokenDetails,
  agentTurnUsage,
  emptyAgentTurnUsage,
  formatAgentDuration,
  formatAgentExactTokenCount,
  formatAgentTokenCount,
  hasAgentTurnStats,
} from "../src/shared/agent-turn-stats.js";

describe("Agent turn stats", () => {
  it("parses and accumulates only non-negative token fields", () => {
    expect(agentTurnUsage({ input: -1, output: "12", cacheRead: 3, extra: 9 })).toEqual({
      input: 0,
      output: 12,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 15,
    });
    expect(addAgentTurnUsage(emptyAgentTurnUsage(), {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
    })).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
    });
    expect(agentTurnUsage({ input: 0, output: 0 })).toBeUndefined();
    expect(agentTurnDurationMs("1280.4")).toBe(1280);
    expect(agentTurnDurationMs(-8)).toBeUndefined();
  });

  it("formats compact duration and token totals for the caption", () => {
    expect(formatAgentDuration(800)).toBe("0.8s");
    expect(formatAgentDuration(12_400)).toBe("12s");
    expect(formatAgentDuration(84_000)).toBe("1m 24s");
    expect(formatAgentTokenCount(348)).toBe("348");
    expect(formatAgentTokenCount(3_400)).toBe("3.4k");
    expect(formatAgentTokenCount(12_000)).toBe("12k");
    expect(formatAgentExactTokenCount(3400)).toBe("3,400");
    expect(agentTurnStatsSummary(1_200, {
      input: 2100,
      output: 1280,
      cacheRead: 80,
      cacheWrite: 0,
      totalTokens: 3460,
    })).toBe("1.2s · 3.5k");
    expect(hasAgentTurnStats(undefined, undefined)).toBe(false);
  });

  it("hides zero cache rows from the hover breakdown", () => {
    expect(agentTurnTokenDetails({
      input: 12,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
    }).map((row) => row.key)).toEqual(["input", "output"]);
    expect(agentTurnTokenDetails({
      input: 12,
      output: 8,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 24,
    }).map((row) => row.key)).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
  });
});
