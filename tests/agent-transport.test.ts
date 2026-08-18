import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import {
  agentChatRequestTransport,
  agentDatabaseReadResult,
  agentDatabaseSqlSuggestion,
  agentSshDiagnosticResult,
  agentSshCommandSuggestion,
  agentSshScriptSuggestion,
  agentTransportValue,
  normalizeAgentSshCommand,
  normalizeAgentSshScript,
  normalizeAgentDatabaseSql,
} from "../src/shared/agent.js";

describe("AI Agent Electron transport", () => {
  it("snapshots reactive chat requests before invoking Electron IPC", () => {
    const request = reactive({
      sessionId: "agent-session",
      messages: [{ id: "message-1", role: "user" as const, content: "只回复 OK", createdAt: "2026-07-28T00:00:00.000Z" }],
      contextCards: [{
        id: "scene:/ssh",
        kind: "scene" as const,
        title: "SSH 工作台",
        summary: "当前页面引用",
        source: "/ssh",
        createdAt: "2026-07-28T00:00:00.000Z",
      }],
    });

    expect(() => structuredClone(request)).toThrow();
    const payload = agentChatRequestTransport(request);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual({
      sessionId: "agent-session",
      messages: [{ id: "message-1", role: "user", content: "只回复 OK", createdAt: "2026-07-28T00:00:00.000Z" }],
      contextCards: [{
        id: "scene:/ssh",
        kind: "scene",
        title: "SSH 工作台",
        summary: "当前页面引用",
        source: "/ssh",
        createdAt: "2026-07-28T00:00:00.000Z",
      }],
    });
  });

  it("converts provider values into a structured-cloneable JSON payload", () => {
    class ProviderUsage {
      constructor(readonly inputTokens: bigint) {}
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const value = reactive({
      usage: new ProviderUsage(12n),
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      metadata: new Map([["cached", true]]),
      tags: new Set(["tool", "chat"]),
      error: new Error("provider failure"),
      binary: new Uint8Array([1, 2, 3]),
      circular,
      ignored: undefined,
    });

    const payload = agentTransportValue(value);

    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual({
      usage: { inputTokens: "12" },
      createdAt: "2026-07-28T00:00:00.000Z",
      metadata: [["cached", true]],
      tags: ["tool", "chat"],
      error: { name: "Error", message: "provider failure" },
      binary: "[Binary 3 bytes]",
      circular: { self: "[Circular]" },
      ignored: null,
    });
  });

  it("bounds deeply nested or oversized provider payloads", () => {
    const entries = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`key-${index}`, index]));
    const nested = { level: { level: { level: { level: { level: { level: { level: { level: { value: true } } } } } } } } };

    expect(Object.keys(agentTransportValue(entries) as Record<string, unknown>)).toHaveLength(100);
    expect(JSON.stringify(agentTransportValue(nested))).toContain("[Max depth]");
  });

  it("accepts only structured single-line SSH command suggestions", () => {
    expect(normalizeAgentSshCommand("`pwd` ")).toBe("pwd");
    expect(() => normalizeAgentSshCommand("pwd\nuname -a")).toThrow("单行");
    expect(agentSshCommandSuggestion({
      kind: "ssh-command-suggestion",
      command: "systemctl status nginx",
      explanation: "读取服务状态。",
      contextId: "ssh:session-1",
      source: "desktop-ssh:session-1",
      execution: "fill-only",
    })).toEqual({
      kind: "ssh-command-suggestion",
      command: "systemctl status nginx",
      explanation: "读取服务状态。",
      contextId: "ssh:session-1",
      source: "desktop-ssh:session-1",
      execution: "fill-only",
    });
    expect(agentSshCommandSuggestion({
      kind: "ssh-command-suggestion",
      command: "pwd\nuname -a",
      explanation: "invalid",
      contextId: "ssh:session-1",
      source: "desktop-ssh:session-1",
      execution: "fill-only",
    })).toBeNull();
    expect(agentSshCommandSuggestion({
      kind: "ssh-command-suggestion",
      command: "systemctl status nginx",
      explanation: "逐次确认后读取服务状态。",
      contextId: "ssh:session-1",
      source: "desktop-ssh:session-1",
      execution: "confirm-read",
      approval: { runId: "run-1", approvalId: "approval-1", step: 2, maxSteps: 5, deadlineAt: "2026-08-10T01:00:00.000Z" },
    })).toMatchObject({ command: "systemctl status nginx", execution: "confirm-read", approval: { runId: "run-1", step: 2, maxSteps: 5 } });
  });

  it("normalizes structured database SQL suggestions", () => {
    expect(normalizeAgentDatabaseSql("```sql\nSELECT 1\n```")).toBe("SELECT 1");
    expect(agentDatabaseSqlSuggestion({ kind: "database-sql-suggestion", sql: "SELECT * FROM users", explanation: "读取用户", contextId: "database:c1:app", source: "desktop-database:c1:app", execution: "confirm-read" })).toMatchObject({ sql: "SELECT * FROM users", execution: "confirm-read" });
    expect(agentDatabaseSqlSuggestion({
      kind: "database-sql-suggestion",
      sql: "UPDATE users SET active=0 WHERE id=1",
      explanation: "停用用户",
      contextId: "database:c1:app",
      source: "desktop-database:c1:app",
      execution: "confirm-write",
      riskLevel: "medium",
      impactPreview: { kind: "update", riskLevel: "medium", reason: "该 SQL 会更新匹配行", targets: ["users"], missingWhere: false, estimatedRows: 1 },
    })).toMatchObject({ execution: "confirm-write", riskLevel: "medium", impactPreview: { estimatedRows: 1 } });
    expect(agentDatabaseSqlSuggestion({ kind: "database-sql-suggestion", sql: "", contextId: "x", source: "x", execution: "fill-only" })).toBeNull();
  });

  it("accepts only bounded fill-only Shell script suggestions", () => {
    expect(normalizeAgentSshScript("```bash\nset -eu\nprintf '%s\\n' ready\n```"))
      .toBe("set -eu\nprintf '%s\\n' ready");
    expect(() => normalizeAgentSshScript("echo ready\x1b[2J"))
      .toThrow("终端控制字符");
    expect(agentSshScriptSuggestion({
      kind: "ssh-script-suggestion",
      script: "set -eu\nprintf '%s\\n' ready",
      interpreter: "sh",
      explanation: "显示完整脚本供人工检查。",
      contextId: "ssh:session-1",
      source: "desktop-ssh:session-1",
      execution: "fill-only",
    })).toEqual({
      kind: "ssh-script-suggestion",
      script: "set -eu\nprintf '%s\\n' ready",
      interpreter: "sh",
      explanation: "显示完整脚本供人工检查。",
      contextId: "ssh:session-1",
      source: "desktop-ssh:session-1",
      execution: "fill-only",
    });
    expect(agentSshScriptSuggestion({
      kind: "ssh-script-suggestion",
      script: "echo ready",
      interpreter: "bash",
      contextId: "ssh:session-1",
      source: "desktop-ssh:session-1",
      execution: "confirm-read",
    })).toBeNull();
  });

  it("accepts bounded SSH and database execution results returned to the Agent loop", () => {
    expect(agentSshDiagnosticResult({
      executionId: "execution-1",
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production",
      host: "10.0.0.1",
      executionTarget: "desktop-local",
      command: "uptime",
      stdout: "up 2 days",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 42,
      truncated: false,
      redactionCount: 0,
    })).toMatchObject({ command: "uptime", exitCode: 0 });
    expect(agentDatabaseReadResult({
      connectionId: "database-1",
      connectionName: "Primary",
      database: "app",
      sql: "SELECT 1 AS ok",
      columns: ["ok"],
      rows: [{ ok: 1 }],
      rowCount: 1,
      truncated: false,
      durationMs: 18,
    })).toMatchObject({ database: "app", rowCount: 1 });
  });
});
