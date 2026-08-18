import { describe, expect, it } from "vitest";
import { agentToolActivity, summarizeAgentToolValue } from "../src/client/agent-tool-activity.js";

describe("Agent tool activity display", () => {
  it("hides internal context checks and tools with dedicated suggestion cards", () => {
    expect(agentToolActivity({
      type: "tool-call",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "agent_echo_context",
      input: { reason: "确认现场" },
    })).toBeNull();
    expect(agentToolActivity({
      type: "tool-result",
      runId: "run-1",
      toolCallId: "tool-2",
      toolName: "ssh_propose_command",
      output: { kind: "ssh-command-suggestion", command: "pwd" },
    })).toBeNull();
    expect(agentToolActivity({
      type: "tool-result",
      runId: "run-1",
      toolCallId: "tool-script",
      toolName: "ssh_propose_script",
      output: { kind: "ssh-script-suggestion", script: "echo ready", execution: "fill-only" },
    })).toBeNull();
  });

  it("formats unknown tool data as a readable summary instead of raw JSON", () => {
    const activity = agentToolActivity({
      type: "tool-result",
      runId: "run-1",
      toolCallId: "tool-3",
      toolName: "service_health_check",
      output: { ok: true, latencyMs: 42, items: ["api", "web"] },
    });
    expect(activity).toMatchObject({
      id: "tool-3:result",
      title: "service health check 已完成",
      detail: "ok：true；latency Ms：42；items：2 项",
    });
    expect(activity?.detail).not.toContain("{");
  });

  it("keeps scalar summaries compact", () => {
    expect(summarizeAgentToolValue("  completed\n successfully  ")).toBe("completed successfully");
  });
});
