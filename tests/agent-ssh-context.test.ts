import { describe, expect, it } from "vitest";
import { agentSshContextSnapshot, summarizeAgentSshOutput } from "../src/desktop/agent-ssh-context.js";

describe("AI Agent SSH context", () => {
  it("strips terminal controls, redacts secrets, and keeps only a bounded tail", () => {
    const noisyLines = Array.from({ length: 140 }, (_, index) => `line-${index}`).join("\n");
    const summary = summarizeAgentSshOutput([
      noisyLines,
      "\x1b[31mERROR\x1b[0m password=super-secret",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "DATABASE_URL=https://operator:database-secret@example.test/app",
      "token=final-secret",
    ].join("\r\n"));

    expect(summary.output).toContain("ERROR password=[REDACTED]");
    expect(summary.output).toContain("Authorization: [REDACTED]");
    expect(summary.output).toContain("https://operator:[REDACTED]@example.test/app");
    expect(summary.output).not.toContain("super-secret");
    expect(summary.output).not.toContain("database-secret");
    expect(summary.output).not.toContain("final-secret");
    expect(summary.output).not.toContain("\x1b");
    expect(summary.lineCount).toBeLessThanOrEqual(120);
    expect(summary.includedBytes).toBeLessThanOrEqual(3 * 1024);
    expect(summary.truncated).toBe(true);
    expect(summary.redactionCount).toBeGreaterThanOrEqual(4);
  });

  it("returns only session metadata and the sanitized output snapshot", () => {
    const snapshot = agentSshContextSnapshot({
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production Readonly",
      host: "10.0.0.8",
      output: "token=secret-value\nready",
      executionTarget: "desktop-local",
    });

    expect(snapshot).toMatchObject({
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production Readonly",
      host: "10.0.0.8",
      executionTarget: "desktop-local",
      output: "token=[REDACTED]\nready",
      redactionCount: 1,
      truncated: false,
    });
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot).not.toHaveProperty("username");
    expect(snapshot).not.toHaveProperty("credential");
  });

  it("supports larger bounded and redacted diagnostic results", () => {
    const summary = summarizeAgentSshOutput(`${"line\n".repeat(800)}token=diagnostic-secret`, { maxBytes: 64 * 1024, maxLines: 500 });
    expect(summary.lineCount).toBeLessThanOrEqual(500);
    expect(summary.output).toContain("token=[REDACTED]");
    expect(summary.output).not.toContain("diagnostic-secret");
    expect(summary.truncated).toBe(true);
  });
});
