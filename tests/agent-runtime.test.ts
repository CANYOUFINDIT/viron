import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopAgentRuntime,
  type DesktopAgentToolExecutor,
} from "../src/desktop/agent-runtime.js";
import { DesktopAgentSessionStore } from "../src/desktop/agent-session-store.js";
import type { DesktopAgentSettingsStore, ResolvedAgentSettings } from "../src/desktop/agent-settings.js";
import type { AgentStreamEvent } from "../src/shared/agent.js";
import type { VironMcpCompactToolDefinition } from "../src/shared/mcp-tools.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitForRunEvent<T extends AgentStreamEvent["type"]>(
  events: AgentStreamEvent[],
  type: T,
  runId?: string,
): Promise<Extract<AgentStreamEvent, { type: T }>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = events.find((item) => item.type === type && (!runId || item.runId === runId));
    if (event) return event as Extract<AgentStreamEvent, { type: T }>;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function testScope(workspaceId = "u1") {
  return {
    vironEndpoint: "https://viron.example",
    vironUserId: "u1",
    workspaceType: workspaceId === "u1" ? "personal" as const : "organization" as const,
    workspaceId,
  };
}

function createRuntime(
  responses: FauxResponseStep[],
  options: {
    settings?: Partial<ResolvedAgentSettings>;
    executor?: Partial<DesktopAgentToolExecutor>;
    currentScope?: () => ReturnType<typeof testScope>;
    gatewayTools?: VironMcpCompactToolDefinition[];
  } = {},
) {
  const faux = fauxProvider({ provider: `viron-test-${randomUUID()}` });
  faux.setResponses(responses);
  const directory = mkdtempSync(join(tmpdir(), "viron-agent-runtime-"));
  tempDirectories.push(directory);
  const settings: ResolvedAgentSettings = {
    endpoint: "https://model.example/v1",
    protocol: "openai",
    model: "mock",
    apiKey: "",
    approvalMode: "always",
    executionPresentation: "conversation",
    ...options.settings,
  };
  const events: AgentStreamEvent[] = [];
  const currentScope = options.currentScope ?? (() => testScope());
  const executor: DesktopAgentToolExecutor = {
    executeSshDiagnostic: vi.fn(async () => { throw new Error("unexpected SSH execution"); }),
    executeDatabaseRead: vi.fn(async () => { throw new Error("unexpected database execution"); }),
    invokeVironTool: vi.fn(async () => { throw new Error("unexpected Viron tool execution"); }),
    currentScope: async () => currentScope(),
    ...options.executor,
  };
  const sessionStore = new DesktopAgentSessionStore(directory);
  const runtime = new DesktopAgentRuntime(
    { resolve: () => settings } as unknown as DesktopAgentSettingsStore,
    sessionStore,
    (event) => events.push(event),
    executor,
    options.gatewayTools ?? [],
    (_settings, _model, context, streamOptions) => faux.provider.streamSimple(faux.getModel(), context, streamOptions),
  );
  return { runtime, sessionStore, events, faux, executor };
}

const sshScene = {
  routePath: "/ssh",
  routeName: "SSH",
  capturedAt: "2026-08-14T00:00:00.000Z",
  contexts: [{
    id: "ssh:session-1",
    kind: "ssh" as const,
    title: "SSH · Production",
    summary: "受限终端摘要",
    source: "desktop-ssh:session-1",
    createdAt: "2026-08-14T00:00:00.000Z",
  }],
};

describe("Desktop Agent Pi runtime", () => {
  it("returns a structured Shell script suggestion without approval or execution", async () => {
    const { runtime, events, executor } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("ssh_propose_script", {
          script: "set -eu\nprintf '%s\\n' ready",
          interpreter: "sh",
          explanation: "生成可检查脚本",
        }, { id: "script-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("脚本已生成，填入后仍需人工检查。"),
    ]);

    const started = runtime.chat(testScope(), { message: "写一个严格模式脚本", sceneHint: sshScene });
    await waitForRunEvent(events, "run-finish", started.runId);

    expect(events.some((event) => event.type === "tool-result"
      && event.toolCallId === "script-1"
      && typeof event.output === "object"
      && event.output !== null
      && !Array.isArray(event.output)
      && event.output.kind === "ssh-script-suggestion"
      && event.output.execution === "fill-only")).toBe(true);
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(executor.executeSshDiagnostic).not.toHaveBeenCalled();
  });

  it("waits inside the Pi tool call, executes after approval, and resumes the same loop", async () => {
    const executeSshDiagnostic = vi.fn(async () => ({
      executionId: "execution-1",
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production",
      host: "10.0.0.1",
      executionTarget: "desktop-local" as const,
      command: "uptime",
      stdout: "load average: 0.10",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 25,
      truncated: false,
      redactionCount: 0,
    }));
    const { runtime, events, faux } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("ssh_propose_command", {
          command: "uptime",
          explanation: "读取负载",
          execution: "confirm-read",
        }, { id: "ssh-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("结论：系统负载正常。")]),
    ], { executor: { executeSshDiagnostic } });

    const scope = testScope();
    const started = runtime.chat(scope, { message: "检查服务器负载", sceneHint: sshScene });
    const approvalEvent = await waitForRunEvent(events, "approval-required", started.runId);
    await waitForRunEvent(events, "run-pause", started.runId);
    expect(approvalEvent.suggestion).toMatchObject({ command: "uptime", approval: { step: 1, maxSteps: 64 } });

    const approval = approvalEvent.suggestion && typeof approvalEvent.suggestion === "object" && !Array.isArray(approvalEvent.suggestion)
      ? approvalEvent.suggestion.approval
      : null;
    if (!approval || typeof approval !== "object" || Array.isArray(approval) || typeof approval.approvalId !== "string") throw new Error("missing approval id");
    runtime.respondApproval(scope, { runId: started.runId, approvalId: approval.approvalId, approved: true });

    await waitForRunEvent(events, "run-finish", started.runId);
    expect(executeSshDiagnostic).toHaveBeenCalledWith(
      { sessionId: "session-1", command: "uptime", executionTarget: "desktop-local", presentation: "conversation", intent: "read" },
      expect.objectContaining({ runId: started.runId, toolCallId: "ssh-1", step: 1, maxSteps: 64 }),
    );
    expect(events.some((event) => event.type === "tool-result" && event.toolCallId === "ssh-1"
      && typeof event.output === "object" && event.output !== null && !Array.isArray(event.output)
      && event.output.stdout === "load average: 0.10")).toBe(true);
    expect(events.some((event) => event.type === "text-delta" && event.delta.includes("系统负载正常"))).toBe(true);
    expect(faux.state.callCount).toBe(2);
  });

  it("auto-runs proven read-only workbench actions under the guarded policy", async () => {
    const executeSshDiagnostic = vi.fn(async () => ({
      executionId: "execution-auto",
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production",
      host: "10.0.0.1",
      executionTarget: "desktop-local" as const,
      command: "uptime",
      stdout: "load average: 0.10",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: 25,
      truncated: false,
      redactionCount: 0,
      presentation: "workbench" as const,
    }));
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("ssh_propose_command", { command: "uptime", execution: "confirm-read" }, { id: "ssh-auto" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("已读取终端结果。"),
    ], {
      settings: { approvalMode: "risk-only", executionPresentation: "workbench" },
      executor: { executeSshDiagnostic },
    });

    const started = runtime.chat(testScope(), { message: "检查负载", sceneHint: sshScene });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(events.some((event) => event.type === "execution-start" && event.toolCallId === "ssh-auto")).toBe(true);
    expect(executeSshDiagnostic).toHaveBeenCalledWith(
      { sessionId: "session-1", command: "uptime", executionTarget: "desktop-local", presentation: "workbench", intent: "read" },
      expect.objectContaining({ runId: started.runId, deadlineAt: expect.any(String) }),
    );
  });

  it("reroutes visible-workbench MCP SSH reads onto the bound terminal", async () => {
    const executeSshDiagnostic = vi.fn(async () => ({
      executionId: "execution-mcp",
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production",
      host: "10.0.0.1",
      executionTarget: "desktop-local" as const,
      command: "uptime",
      stdout: "load average: 0.10",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: 18,
      truncated: false,
      redactionCount: 0,
      presentation: "workbench" as const,
    }));
    const invokeVironTool = vi.fn(async () => { throw new Error("unexpected Viron tool execution"); });
    const workbenchScene = {
      ...sshScene,
      contexts: [{ ...sshScene.contexts[0], resourceId: "connection-1" }],
    };
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("viron_read", {
          operation: "viron_ssh_commands_read_batch",
          input: { connectionId: "connection-1", commands: ["uptime"] },
        }, { id: "mcp-ssh-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("已在当前终端读取负载。"),
    ], {
      settings: { approvalMode: "risk-only", executionPresentation: "workbench" },
      executor: { executeSshDiagnostic, invokeVironTool },
      gatewayTools: [{ name: "viron_read", title: "读取", description: "read operations" }],
    });

    const started = runtime.chat(testScope(), { message: "检查负载", sceneHint: workbenchScene });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(invokeVironTool).not.toHaveBeenCalled();
    expect(executeSshDiagnostic).toHaveBeenCalledWith(
      { sessionId: "session-1", command: "uptime", executionTarget: "desktop-local", presentation: "workbench", intent: "read" },
      expect.objectContaining({ runId: started.runId, toolCallId: "mcp-ssh-1" }),
    );
  });

  it("keeps MCP SSH execution on a different connection in the background", async () => {
    const invokeVironTool = vi.fn(async () => ({ ok: true, stdout: "other-host" }));
    const workbenchScene = {
      ...sshScene,
      contexts: [{ ...sshScene.contexts[0], resourceId: "connection-1" }],
    };
    const { runtime, events, executor } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("viron_read", {
          operation: "viron_ssh_commands_read_batch",
          input: { connectionId: "connection-other", commands: ["uptime"] },
        }, { id: "mcp-ssh-other" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("已读取另一台主机。"),
    ], {
      settings: { approvalMode: "risk-only", executionPresentation: "workbench" },
      executor: { invokeVironTool },
      gatewayTools: [{ name: "viron_read", title: "读取", description: "read operations" }],
    });

    const started = runtime.chat(testScope(), { message: "看另一台机器", sceneHint: workbenchScene });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(executor.executeSshDiagnostic).not.toHaveBeenCalled();
    expect(invokeVironTool).toHaveBeenCalledWith("viron_read", {
      operation: "viron_ssh_commands_read_batch",
      input: { connectionId: "connection-other", commands: ["uptime"] },
    });
  });

  it("reroutes visible-workbench MCP SSH writes onto the bound terminal", async () => {
    const executeSshDiagnostic = vi.fn(async () => ({
      executionId: "execution-write",
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production",
      host: "10.0.0.1",
      executionTarget: "desktop-local" as const,
      command: "rm -rf /tmp/cache",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 12,
      truncated: false,
      redactionCount: 0,
      presentation: "workbench" as const,
    }));
    const invokeVironTool = vi.fn(async () => { throw new Error("unexpected Viron tool execution"); });
    const workbenchScene = {
      ...sshScene,
      contexts: [{ ...sshScene.contexts[0], resourceId: "connection-1" }],
    };
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("viron_risk", {
          operation: "viron_ssh_command_request",
          input: { connectionId: "connection-1", command: "rm -rf /tmp/cache" },
        }, { id: "mcp-ssh-write" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("已在当前终端执行写命令。"),
    ], {
      settings: { approvalMode: "never", executionPresentation: "workbench" },
      executor: { executeSshDiagnostic, invokeVironTool },
      gatewayTools: [{ name: "viron_risk", title: "风险", description: "risk operations" }],
    });

    const started = runtime.chat(testScope(), { message: "清一下缓存", sceneHint: workbenchScene });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(invokeVironTool).not.toHaveBeenCalled();
    expect(executeSshDiagnostic).toHaveBeenCalledWith(
      { sessionId: "session-1", command: "rm -rf /tmp/cache", executionTarget: "desktop-local", presentation: "workbench", intent: "write" },
      expect.objectContaining({ runId: started.runId, toolCallId: "mcp-ssh-write" }),
    );
  });

  it("reroutes visible-workbench MCP SQL reads onto the bound query tab", async () => {
    const executeDatabaseRead = vi.fn(async () => ({
      connectionId: "database-1",
      connectionName: "Primary",
      database: "app",
      sql: "SELECT 1",
      columns: ["1"],
      rows: [{ "1": 1 }],
      rowCount: 1,
      truncated: false,
      durationMs: 12,
      presentation: "workbench" as const,
    }));
    const invokeVironTool = vi.fn(async () => { throw new Error("unexpected Viron tool execution"); });
    const databaseScene = {
      routePath: "/database",
      routeName: "数据库",
      capturedAt: "2026-08-14T00:00:00.000Z",
      contexts: [{
        id: "database:database-1:app",
        kind: "database" as const,
        title: "数据库 · Primary / app",
        summary: "受限数据库摘要",
        source: "desktop-database:database-1:app",
        createdAt: "2026-08-14T00:00:00.000Z",
        resourceId: "database-1",
      }],
    };
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("viron_read", {
          operation: "viron_database_query_read_start",
          input: { connectionId: "database-1", database: "app", sql: "SELECT 1" },
        }, { id: "mcp-db-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("查询已在工作台执行。"),
    ], {
      settings: { approvalMode: "risk-only", executionPresentation: "workbench" },
      executor: { executeDatabaseRead, invokeVironTool },
      gatewayTools: [{ name: "viron_read", title: "读取", description: "read operations" }],
    });

    const started = runtime.chat(testScope(), { message: "查一行", sceneHint: databaseScene });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(invokeVironTool).not.toHaveBeenCalled();
    expect(executeDatabaseRead).toHaveBeenCalledWith(
      { connectionId: "database-1", database: "app", sql: "SELECT 1", presentation: "workbench", intent: "read" },
      expect.objectContaining({ runId: started.runId, toolCallId: "mcp-db-1" }),
    );
  });

  it("redacts sensitive generic-tool approval fields before sending them to the renderer", async () => {
    const invokeVironTool = vi.fn(async () => ({ ok: true }));
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("viron_secure", {
          operation: "connection_secret_update",
          input: { password: "hunter2", note: "Authorization: Bearer abcdefghijklmnop" },
        }, { id: "secure-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("未执行凭据操作。"),
    ], {
      executor: { invokeVironTool },
      gatewayTools: [{ name: "viron_secure", title: "安全凭据操作", description: "通过安全窗口完成凭据操作" }],
    });

    const scope = testScope();
    const started = runtime.chat(scope, { message: "更新连接凭据" });
    const approvalEvent = await waitForRunEvent(events, "approval-required", started.runId);
    expect(JSON.stringify(approvalEvent.suggestion)).not.toContain("hunter2");
    expect(JSON.stringify(approvalEvent.suggestion)).not.toContain("abcdefghijklmnop");
    expect(approvalEvent.suggestion).toMatchObject({
      kind: "viron-tool-approval",
      input: { input: { password: "[REDACTED]", note: "Authorization: [REDACTED]" } },
    });
    const approval = typeof approvalEvent.suggestion === "object" && approvalEvent.suggestion !== null && !Array.isArray(approvalEvent.suggestion)
      ? approvalEvent.suggestion.approval
      : null;
    if (!approval || typeof approval !== "object" || Array.isArray(approval) || typeof approval.approvalId !== "string") throw new Error("missing approval id");
    runtime.respondApproval(scope, { runId: started.runId, approvalId: approval.approvalId, approved: false });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(invokeVironTool).not.toHaveBeenCalled();
  });

  it("returns a Pi tool error for an invalid server-forwarded fill action without executing it", async () => {
    const serverScene = {
      ...sshScene,
      contexts: [{ ...sshScene.contexts[0], source: "server-ssh:session-1" }],
    };
    const { runtime, events, executor } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("ssh_propose_command", { command: "uptime", execution: "fill-only" }, { id: "ssh-fill" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("当前服务端现场只能执行受控只读诊断。"),
    ]);

    const started = runtime.chat(testScope(), { message: "给我填入 uptime", sceneHint: serverScene });
    await waitForRunEvent(events, "run-finish", started.runId);
    const failedTool = events.find((event) => event.type === "tool-error" && event.toolCallId === "ssh-fill");
    expect(failedTool).toMatchObject({ message: expect.stringContaining("不允许填入交互终端") });
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(executor.executeSshDiagnostic).not.toHaveBeenCalled();
  });

  it("keeps the conversation across workspaces while invalidating an old workspace approval", async () => {
    const databaseScene = {
      routePath: "/database",
      routeName: "数据库",
      capturedAt: "2026-08-14T00:00:00.000Z",
      contexts: [{
        id: "database:database-1:app",
        kind: "database" as const,
        title: "数据库 · Primary / app",
        summary: "受限数据库摘要",
        source: "desktop-database:database-1:app",
        createdAt: "2026-08-14T00:00:00.000Z",
      }],
    };
    const { runtime, events, executor } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("database_propose_sql", {
          sql: "SELECT COUNT(*) AS total FROM users",
          explanation: "统计用户",
          execution: "confirm-read",
        }, { id: "db-1" }),
      ], { stopReason: "toolUse" }),
    ]);
    const firstWorkspace = testScope("o1");
    const started = runtime.chat(firstWorkspace, { message: "统计用户数量", sceneHint: databaseScene });
    const approvalEvent = await waitForRunEvent(events, "approval-required", started.runId);
    const approval = typeof approvalEvent.suggestion === "object" && approvalEvent.suggestion !== null && !Array.isArray(approvalEvent.suggestion)
      ? approvalEvent.suggestion.approval
      : null;
    if (!approval || typeof approval !== "object" || Array.isArray(approval) || typeof approval.approvalId !== "string") throw new Error("missing approval id");

    expect(() => runtime.respondApproval(testScope("o2"), {
      runId: started.runId,
      approvalId: approval.approvalId,
      approved: true,
    })).toThrow("现场已经失效");
    await waitForRunEvent(events, "run-abort", started.runId);
    expect(executor.executeDatabaseRead).not.toHaveBeenCalled();
    expect(runtime.currentConversation(testScope("o2")).id).toBe(started.sessionId);
    expect(runtime.currentConversation(testScope("o2")).messages[0]?.content).toBe("统计用户数量");
  });

  it("aborts an approved tool execution when the user stops the run", async () => {
    let executionSignal: AbortSignal | undefined;
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("ssh_propose_command", { command: "uptime", execution: "confirm-read" }, { id: "ssh-cancel" }),
      ], { stopReason: "toolUse" }),
    ], {
      executor: {
        executeSshDiagnostic: (_input, context) => {
          executionSignal = context.abortSignal;
          return new Promise((_resolve, reject) => {
            context.abortSignal.addEventListener("abort", () => reject(new Error(String(context.abortSignal.reason))), { once: true });
          });
        },
      },
    });
    const scope = testScope();
    const started = runtime.chat(scope, { message: "检查负载", sceneHint: sshScene });
    const approvalEvent = await waitForRunEvent(events, "approval-required", started.runId);
    const approval = typeof approvalEvent.suggestion === "object" && approvalEvent.suggestion !== null && !Array.isArray(approvalEvent.suggestion)
      ? approvalEvent.suggestion.approval
      : null;
    if (!approval || typeof approval !== "object" || Array.isArray(approval) || typeof approval.approvalId !== "string") throw new Error("missing approval id");
    runtime.respondApproval(scope, { runId: started.runId, approvalId: approval.approvalId, approved: true });
    const deadline = Date.now() + 2_000;
    while (!executionSignal && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executionSignal).toBeDefined();

    expect(runtime.stop(started.runId).stopped).toBe(true);
    await waitForRunEvent(events, "run-abort", started.runId);
    expect(executionSignal?.aborted).toBe(true);
  });

  it("reuses Pi history for a second turn after the workspace changes", async () => {
    let secondTurnContext: import("@earendil-works/pi-ai").Context | undefined;
    const { runtime, events } = createRuntime([
      fauxAssistantMessage("第一轮回答"),
      (context) => {
        secondTurnContext = context;
        return fauxAssistantMessage("第二轮回答");
      },
    ]);
    const first = runtime.chat(testScope("o1"), { message: "第一轮问题" });
    await waitForRunEvent(events, "run-finish", first.runId);
    const second = runtime.chat(testScope("o2"), { sessionId: first.sessionId, message: "继续刚才的问题" });
    await waitForRunEvent(events, "run-finish", second.runId);

    expect(second.sessionId).toBe(first.sessionId);
    expect(secondTurnContext?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const stored = runtime.currentConversation(testScope("o2"));
    expect(stored.messages.map((message) => message.content)).toEqual([
      "第一轮问题",
      "第一轮回答",
      "继续刚才的问题",
      "第二轮回答",
    ]);
  });

  it("records wall-clock duration and accumulated token usage for a finished turn", async () => {
    const { runtime, events, sessionStore } = createRuntime([
      fauxAssistantMessage("第一轮回答"),
    ]);
    const scope = testScope();
    const started = runtime.chat(scope, { message: "第一轮问题" });
    const finished = await waitForRunEvent(events, "run-finish", started.runId);
    expect(finished.durationMs).toBeGreaterThanOrEqual(0);
    expect(finished.usage?.totalTokens).toBeGreaterThan(0);
    expect(finished.usage).toEqual(expect.objectContaining({
      input: expect.any(Number),
      output: expect.any(Number),
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
    }));
    const stored = sessionStore.current(scope).messages.find((message) => message.id === started.messageId);
    expect(stored?.durationMs).toBe(finished.durationMs);
    expect(stored?.usage).toEqual(finished.usage);
  });

  it("asks for approval before executing an SSH write even under the guarded policy", async () => {
    const executeSshDiagnostic = vi.fn(async () => ({
      executionId: "execution-write",
      sessionId: "session-1",
      connectionId: "connection-1",
      connectionName: "Production",
      host: "10.0.0.1",
      executionTarget: "desktop-local" as const,
      command: "rm -rf /tmp/cache",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 8,
      truncated: false,
      redactionCount: 0,
    }));
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("ssh_propose_command", { command: "rm -rf /tmp/cache", execution: "confirm-write" }, { id: "ssh-write" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("缓存目录已删除。"),
    ], {
      settings: { approvalMode: "risk-only" },
      executor: { executeSshDiagnostic },
    });
    const scope = testScope();
    const started = runtime.chat(scope, { message: "清一下缓存", sceneHint: sshScene });
    const approvalEvent = await waitForRunEvent(events, "approval-required", started.runId);
    expect(approvalEvent.suggestion).toMatchObject({
      command: "rm -rf /tmp/cache",
      execution: "confirm-write",
      riskLevel: "high",
      impactPreview: { riskLevel: "high" },
    });
    const approval = typeof approvalEvent.suggestion === "object" && approvalEvent.suggestion !== null && !Array.isArray(approvalEvent.suggestion)
      ? approvalEvent.suggestion.approval
      : null;
    if (!approval || typeof approval !== "object" || Array.isArray(approval) || typeof approval.approvalId !== "string") throw new Error("missing approval id");
    runtime.respondApproval(scope, { runId: started.runId, approvalId: approval.approvalId, approved: true });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(executeSshDiagnostic).toHaveBeenCalledWith(
      { sessionId: "session-1", command: "rm -rf /tmp/cache", executionTarget: "desktop-local", presentation: "conversation", intent: "write" },
      expect.objectContaining({ runId: started.runId, toolCallId: "ssh-write" }),
    );
  });

  it("previews a database write then executes it after confirmation", async () => {
    const executeDatabaseRead = vi.fn(async (input: { sql: string; intent?: "read" | "write" }) => {
      if (input.intent === "write") {
        return {
          connectionId: "database-1",
          connectionName: "Primary",
          database: "app",
          sql: input.sql,
          columns: ["affectedRows", "insertId"],
          rows: [{ affectedRows: 3, insertId: 0 }],
          rowCount: 3,
          truncated: false,
          durationMs: 18,
          affectedRows: 3,
          insertId: 0,
        };
      }
      return {
        connectionId: "database-1",
        connectionName: "Primary",
        database: "app",
        sql: input.sql,
        columns: ["affected_estimate"],
        rows: [{ affected_estimate: 3 }],
        rowCount: 1,
        truncated: false,
        durationMs: 5,
      };
    });
    const databaseScene = {
      routePath: "/database",
      routeName: "数据库",
      capturedAt: "2026-08-14T00:00:00.000Z",
      contexts: [{
        id: "database:database-1:app",
        kind: "database" as const,
        title: "数据库 · Primary / app",
        summary: "受限数据库摘要",
        source: "desktop-database:database-1:app",
        createdAt: "2026-08-14T00:00:00.000Z",
      }],
    };
    const { runtime, events } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("database_propose_sql", {
          sql: "UPDATE users SET active=0 WHERE id=1",
          explanation: "停用用户",
          execution: "confirm-write",
        }, { id: "db-write" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("已停用该用户。"),
    ], { executor: { executeDatabaseRead } });
    const scope = testScope();
    const started = runtime.chat(scope, { message: "停用 id=1 的用户", sceneHint: databaseScene });
    const approvalEvent = await waitForRunEvent(events, "approval-required", started.runId);
    expect(approvalEvent.suggestion).toMatchObject({
      execution: "confirm-write",
      riskLevel: "medium",
      impactPreview: { kind: "update", estimatedRows: 3, missingWhere: false },
    });
    const approval = typeof approvalEvent.suggestion === "object" && approvalEvent.suggestion !== null && !Array.isArray(approvalEvent.suggestion)
      ? approvalEvent.suggestion.approval
      : null;
    if (!approval || typeof approval !== "object" || Array.isArray(approval) || typeof approval.approvalId !== "string") throw new Error("missing approval id");
    runtime.respondApproval(scope, { runId: started.runId, approvalId: approval.approvalId, approved: true });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(executeDatabaseRead).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sql: "SELECT COUNT(*) AS affected_estimate FROM users WHERE id=1", intent: "read", presentation: "conversation" }),
      expect.anything(),
    );
    expect(executeDatabaseRead).toHaveBeenNthCalledWith(
      2,
      { connectionId: "database-1", database: "app", sql: "UPDATE users SET active=0 WHERE id=1", presentation: "conversation", intent: "write" },
      expect.objectContaining({ runId: started.runId, toolCallId: "db-write" }),
    );
  });

  it("rejects account-management SQL and read-only confirm-write misuse", async () => {
    const databaseScene = {
      routePath: "/database",
      routeName: "数据库",
      capturedAt: "2026-08-14T00:00:00.000Z",
      contexts: [{
        id: "database:database-1:app",
        kind: "database" as const,
        title: "数据库 · Primary / app",
        summary: "受限数据库摘要",
        source: "desktop-database:database-1:app",
        createdAt: "2026-08-14T00:00:00.000Z",
      }],
    };
    const grant = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("database_propose_sql", { sql: "INSERT INTO users SELECT 1 INTO OUTFILE '/tmp/a'", execution: "confirm-write" }, { id: "db-grant" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("该语句已被拒绝。"),
    ]);
    const grantStarted = grant.runtime.chat(testScope(), { message: "授权", sceneHint: databaseScene });
    await waitForRunEvent(grant.events, "run-finish", grantStarted.runId);
    expect(grant.events.find((event) => event.type === "tool-error" && event.toolCallId === "db-grant")?.message).toContain("账号安全");

    const { runtime, events, executor } = createRuntime([
      fauxAssistantMessage([
        fauxToolCall("ssh_propose_command", { command: "uptime", execution: "confirm-write" }, { id: "ssh-misuse" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("只读命令应使用 confirm-read。"),
    ]);
    const started = runtime.chat(testScope(), { message: "看负载", sceneHint: sshScene });
    await waitForRunEvent(events, "run-finish", started.runId);
    expect(events.find((event) => event.type === "tool-error" && event.toolCallId === "ssh-misuse")?.message).toContain("confirm-read");
    expect(executor.executeSshDiagnostic).not.toHaveBeenCalled();
  });
});
