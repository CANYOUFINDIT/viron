import { describe, expect, it } from "vitest";
import { AgentTerminalExecutionCapture } from "../src/client/agent-terminal-execution.js";

describe("Agent visible SSH terminal execution capture", () => {
  it("waits for command output and the next shell prompt", () => {
    const capture = new AgentTerminalExecutionCapture(100);
    expect(capture.append("uptime\r\n", 110)).toBeNull();
    expect(capture.append(" 10:00 up 2 days, load average: 0.10\r\n", 130)).toBeNull();
    expect(capture.append("root@server:/srv/app# ", 150)).toEqual({
      rawOutput: "uptime\r\n 10:00 up 2 days, load average: 0.10\r\nroot@server:/srv/app# ",
      durationMs: 50,
      truncated: false,
    });
  });

  it("does not treat a password prompt or inline prompt-like output as completion", () => {
    const capture = new AgentTerminalExecutionCapture(0);
    expect(capture.append("sudo status\r\nPassword: ", 5)).toBeNull();
    expect(capture.append("service says root@server:/tmp# but continues\r\n", 10)).toBeNull();
  });
});
