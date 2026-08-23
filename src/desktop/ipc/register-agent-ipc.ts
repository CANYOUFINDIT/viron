import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { translate as tr } from "../i18n.js";
import {
  agentDatabaseReadResult,
  agentTransportValue,
  type AgentChatRequest,
  type AgentDatabaseContextInput,
  type AgentModelListInput,
  type AgentSettingsInput,
  type AgentToolApprovalResponseInput,
  type AgentWorkbenchExecutionRequest,
  type AgentWorkbenchExecutionResponseInput,
  type AgentWorkbenchExecutionResult,
} from "../../shared/agent.js";
import { summarizeAgentSshOutput } from "../../shared/agent-ssh-context.js";
import { DesktopAgentAuditStore } from "../agent-audit.js";
import { DesktopAgentSettingsStore } from "../agent-settings.js";
import { DesktopAgentSessionStore } from "../agent-session-store.js";
import { listAgentModels } from "../agent-models.js";
import { agentRuntimeScopeMatches, type AgentRuntimeScope } from "../agent-diagnostic-session.js";
import { DesktopSshCommandAbortedError, type DesktopSshContext } from "../ssh-runtime.js";
import {
  activeEndpoint,
  currentExecutionMode,
  executionScopeForEndpoint,
} from "../endpoint-context.js";
import { trustedSender } from "../ipc-guards.js";
import { mainWindow } from "../window-host.js";
import { sendToAgentChat } from "../overlays/agent-chat-window.js";
import {
  desktopAgentRuntime,
  desktopDatabaseRuntime,
  desktopSshRuntime,
} from "../desktop-runtime-context.js";
import {
  agentRuntimeScope,
  currentAgentRuntimeScope,
  currentAgentSettingsScope,
  currentDesktopSshContext,
  signedDesktopOperation,
} from "../execution-router.js";
import { endpointJson } from "../http-proxy.js";
import { requireDesktopString } from "./desktop-ipc-parse.js";

export let desktopAgentSettingsStore: DesktopAgentSettingsStore;
export let desktopAgentSessionStore: DesktopAgentSessionStore;
export let desktopAgentAuditStore: DesktopAgentAuditStore;

export function initializeDesktopAgentIpcStores(userDataPath: string): void {
  if (desktopAgentSettingsStore || desktopAgentSessionStore || desktopAgentAuditStore) {
    throw new Error("Desktop Agent IPC stores have already been initialized");
  }
  desktopAgentSettingsStore = new DesktopAgentSettingsStore(userDataPath);
  desktopAgentSessionStore = new DesktopAgentSessionStore(userDataPath);
  desktopAgentAuditStore = new DesktopAgentAuditStore(userDataPath);
}

const pendingAgentWorkbenchExecutions = new Map<string, {
  request: AgentWorkbenchExecutionRequest;
  resolve: (result: AgentWorkbenchExecutionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal;
  abortListener: () => void;
}>();


function agentSettingsInput(value: unknown): AgentSettingsInput {
  if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 配置无效"));
  const input = value as { endpoint?: unknown; protocol?: unknown; model?: unknown; apiKey?: unknown; approvalMode?: unknown; executionPresentation?: unknown };
  if (typeof input.endpoint !== "string") throw new Error(tr("模型 Endpoint 无效"));
  if (input.protocol !== "openai" && input.protocol !== "anthropic") throw new Error(tr("模型协议类型无效"));
  if (typeof input.model !== "string") throw new Error(tr("模型名称无效"));
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error(tr("API Key 无效"));
  if (input.approvalMode !== "always" && input.approvalMode !== "risk-only" && input.approvalMode !== "never") throw new Error(tr("Viron Agent 审批策略无效"));
  if (input.executionPresentation !== "conversation" && input.executionPresentation !== "workbench") throw new Error(tr("Viron Agent 执行位置无效"));
  return {
    endpoint: input.endpoint,
    protocol: input.protocol,
    model: input.model,
    apiKey: input.apiKey,
    approvalMode: input.approvalMode,
    executionPresentation: input.executionPresentation,
  };
}

function agentModelListInput(value: unknown): AgentModelListInput {
  if (!value || typeof value !== "object") throw new Error(tr("模型列表参数无效"));
  const input = value as { endpoint?: unknown; protocol?: unknown; apiKey?: unknown };
  if (typeof input.endpoint !== "string") throw new Error(tr("模型 Endpoint 无效"));
  if (input.protocol !== "openai" && input.protocol !== "anthropic") throw new Error(tr("模型协议类型无效"));
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error(tr("API Key 无效"));
  return { endpoint: input.endpoint, protocol: input.protocol, apiKey: input.apiKey };
}

function agentChatRequest(value: unknown): AgentChatRequest {
  if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 请求无效"));
  const input = value as AgentChatRequest;
  return {
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
    message: typeof input.message === "string" ? input.message : undefined,
    sceneHint: input.sceneHint && typeof input.sceneHint === "object" ? {
      routePath: typeof input.sceneHint.routePath === "string" ? input.sceneHint.routePath.slice(0, 1_000) : "",
      routeName: typeof input.sceneHint.routeName === "string" ? input.sceneHint.routeName.slice(0, 200) : "",
      capturedAt: typeof input.sceneHint.capturedAt === "string" ? input.sceneHint.capturedAt : new Date().toISOString(),
      contexts: Array.isArray(input.sceneHint.contexts) ? input.sceneHint.contexts : [],
    } : undefined,
    messages: Array.isArray(input.messages) ? input.messages : undefined,
    contextCards: Array.isArray(input.contextCards) ? input.contextCards : undefined,
  };
}

function agentDatabaseContextInput(value: unknown): AgentDatabaseContextInput {
  if (!value || typeof value !== "object") throw new Error(tr("数据库现场参数无效"));
  const input = value as Partial<AgentDatabaseContextInput>;
  if (typeof input.connectionId !== "string" || typeof input.database !== "string") throw new Error(tr("数据库现场参数无效"));
  return {
    connectionId: input.connectionId,
    database: input.database,
    editorSql: typeof input.editorSql === "string" ? input.editorSql : "",
    selectedSql: typeof input.selectedSql === "string" ? input.selectedSql : "",
    resultPreview: Array.isArray(input.resultPreview) ? input.resultPreview.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [],
  };
}

export async function executeAgentSshRead(input: {
  executionId: string;
  sessionId: string;
  command: string;
  executionTarget: "desktop-local" | "server-forwarded";
  scope: AgentRuntimeScope;
  desktopContext: DesktopSshContext;
  abortSignal?: AbortSignal;
  step?: number;
  maxSteps?: number;
  intent?: "read" | "write";
}): Promise<import("../../shared/agent.js").AgentSshDiagnosticResult> {
  if (!agentRuntimeScopeMatches(input.scope, agentRuntimeScope(input.desktopContext))) throw new Error(tr("Viron Agent 诊断现场已经失效"));
  const currentTarget = currentExecutionMode() === "server" ? "server-forwarded" : "desktop-local";
  if (input.executionTarget !== currentTarget) throw new Error(tr("Viron Agent 诊断现场已经失效"));
  const stepSummary = input.step && input.maxSteps ? tr("（第 {{0}}/{{1}} 步）", [input.step, input.maxSteps]) : "";
  const targetSummary = input.executionTarget === "server-forwarded" ? tr("服务端转发") : tr("本机直连");
  const write = input.intent === "write";
  desktopAgentAuditStore.append(input.scope, write ? "ssh_write_approved" : "ssh_diagnostic_approved", input.sessionId, tr("按当前 Viron Agent 审批策略执行 {{0}} SSH {{1}}{{2}}", [targetSummary, write ? tr("写命令") : tr("只读诊断命令"), stepSummary]));
  if (input.executionTarget === "server-forwarded") {
    const executionScope = executionScopeForEndpoint(input.desktopContext.endpoint);
    let cancelRequest: Promise<unknown> | undefined;
    const cancel = () => {
      cancelRequest ??= signedDesktopOperation({
        operationId: randomUUID(),
        action: "cancel" as const,
        sessionId: input.sessionId,
        executionScope,
        executionId: input.executionId,
      }, input.desktopContext).then((body) => endpointJson(
        `/api/v1/ssh-sessions/${encodeURIComponent(input.sessionId)}/agent-diagnostics/${encodeURIComponent(input.executionId)}/cancel`,
        { method: "POST", body },
      )).catch(() => undefined);
    };
    if (input.abortSignal?.aborted) throw new Error(String(input.abortSignal.reason ?? (write ? tr("SSH 写命令已取消") : tr("SSH 只读诊断已取消"))));
    input.abortSignal?.addEventListener("abort", cancel, { once: true });
    if (input.abortSignal?.aborted) cancel();
    try {
      const result = await endpointJson<import("../../shared/agent.js").AgentSshDiagnosticResult>(
        `/api/v1/ssh-sessions/${encodeURIComponent(input.sessionId)}/agent-diagnostics`,
        {
          method: "POST",
          body: await signedDesktopOperation({
            operationId: input.executionId,
            action: "execute" as const,
            sessionId: input.sessionId,
            executionScope,
            command: input.command,
            intent: write ? "write" as const : "read" as const,
          }, input.desktopContext),
        },
      );
      desktopAgentAuditStore.append(
        input.scope,
        write ? "ssh_write_executed" : "ssh_diagnostic_executed",
        result.connectionId,
        tr("服务端转发 SSH {{0}}完成{{1}}，退出码 {{2}}，耗时 {{3}} ms，输出脱敏 {{4}} 处{{5}}", [
          write ? tr("写命令") : tr("只读诊断"),
          stepSummary,
          result.exitCode ?? tr("未知"),
          result.durationMs,
          result.redactionCount,
          result.truncated ? tr("，结果已截断") : "",
        ]),
      );
      return result;
    } catch (error) {
      if (input.abortSignal?.aborted) {
        desktopAgentAuditStore.append(input.scope, write ? "ssh_write_cancelled" : "ssh_diagnostic_cancelled", input.sessionId, tr("服务端转发 SSH {{0}}已取消{{1}}", [write ? tr("写命令") : tr("只读诊断"), stepSummary]));
      } else {
        desktopAgentAuditStore.append(input.scope, write ? "ssh_write_rejected" : "ssh_diagnostic_rejected", input.sessionId, error instanceof Error ? error.message : tr("服务端转发 SSH 诊断执行失败"));
      }
      throw error;
    } finally {
      input.abortSignal?.removeEventListener("abort", cancel);
    }
  }
  const cancel = () => {
    try { desktopSshRuntime.cancelAgentDiagnostic(input.executionId, input.desktopContext); }
    catch { /* The execution may have completed before the abort signal arrived. */ }
  };
  if (input.abortSignal?.aborted) throw new Error(String(input.abortSignal.reason ?? (write ? tr("SSH 写命令已取消") : tr("SSH 只读诊断已取消"))));
  input.abortSignal?.addEventListener("abort", cancel, { once: true });
  if (input.abortSignal?.aborted) cancel();
  try {
    const result = await desktopSshRuntime.agentDiagnostic(input.executionId, input.sessionId, input.command, input.desktopContext, { allowWrite: write });
    desktopAgentAuditStore.append(
      input.scope,
      write ? "ssh_write_executed" : "ssh_diagnostic_executed",
      result.connectionId,
      tr("SSH {{0}}完成{{1}}，退出码 {{2}}，耗时 {{3}} ms，输出脱敏 {{4}} 处{{5}}", [
        write ? tr("写命令") : tr("只读诊断"),
        stepSummary,
        result.exitCode ?? tr("未知"),
        result.durationMs,
        result.redactionCount,
        result.truncated ? tr("，结果已截断") : "",
      ]),
    );
    return result;
  } catch (error) {
    if (input.abortSignal?.aborted || error instanceof DesktopSshCommandAbortedError) {
      desktopAgentAuditStore.append(input.scope, write ? "ssh_write_cancelled" : "ssh_diagnostic_cancelled", input.sessionId, tr("SSH {{0}}已取消{{1}}", [write ? tr("写命令") : tr("只读诊断"), stepSummary]));
    } else {
      desktopAgentAuditStore.append(input.scope, write ? "ssh_write_rejected" : "ssh_diagnostic_rejected", input.sessionId, error instanceof Error ? error.message : tr("SSH 诊断执行失败"));
    }
    throw error;
  } finally {
    input.abortSignal?.removeEventListener("abort", cancel);
  }
}

export function emitDesktopAgentEvent(event: import("../../shared/agent.js").AgentStreamEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:agent-event", event);
  sendToAgentChat("viron:agent-event", event);
}

export function settleAgentWorkbenchExecution(requestId: string, result: AgentWorkbenchExecutionResult | Error): boolean {
  const pending = pendingAgentWorkbenchExecutions.get(requestId);
  if (!pending) return false;
  pendingAgentWorkbenchExecutions.delete(requestId);
  clearTimeout(pending.timer);
  pending.abortSignal.removeEventListener("abort", pending.abortListener);
  if (result instanceof Error) pending.reject(result);
  else pending.resolve(result);
  return true;
}

export function requestAgentWorkbenchExecution(
  request: AgentWorkbenchExecutionRequest,
  abortSignal: AbortSignal,
): Promise<AgentWorkbenchExecutionResult> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.reject(new Error(tr("Viron 主窗口不可用")));
  const remainingMs = Date.parse(request.deadlineAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return Promise.reject(new Error(tr("Viron Agent 多步诊断已达到 2 分钟总时限")));
  if (pendingAgentWorkbenchExecutions.has(request.requestId)) return Promise.reject(new Error(tr("Viron Agent 工作台执行请求已存在")));
  return new Promise((resolve, reject) => {
    const abortListener = () => {
      emitDesktopAgentEvent({
        type: "workbench-execution-cancel",
        requestId: request.requestId,
        runId: request.runId,
        domain: request.domain,
        reason: String(abortSignal.reason ?? tr("用户停止小 V 回复或诊断")),
      });
      settleAgentWorkbenchExecution(request.requestId, new Error(String(abortSignal.reason ?? tr("用户停止小 V 回复或诊断"))));
    };
    const timer = setTimeout(() => {
      emitDesktopAgentEvent({
        type: "workbench-execution-cancel",
        requestId: request.requestId,
        runId: request.runId,
        domain: request.domain,
        reason: tr("Viron Agent 多步诊断已达到 2 分钟总时限"),
      });
      settleAgentWorkbenchExecution(request.requestId, new Error(tr("Viron Agent 多步诊断已达到 2 分钟总时限")));
    }, remainingMs);
    timer.unref?.();
    pendingAgentWorkbenchExecutions.set(request.requestId, { request, resolve, reject, timer, abortSignal, abortListener });
    abortSignal.addEventListener("abort", abortListener, { once: true });
    if (abortSignal.aborted) abortListener();
    else emitDesktopAgentEvent(request);
  });
}

export function agentWorkbenchExecutionResponse(value: unknown): AgentWorkbenchExecutionResponseInput {
  if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 工作台执行响应无效"));
  const input = value as Record<string, unknown>;
  const requestId = requireDesktopString(input.requestId, tr("工作台执行请求 ID"));
  if (input.error !== undefined && typeof input.error !== "string") throw new Error(tr("Viron Agent 工作台执行错误无效"));
  if (input.result !== undefined && (!input.result || typeof input.result !== "object")) throw new Error(tr("Viron Agent 工作台执行结果无效"));
  return { requestId, ...(typeof input.error === "string" ? { error: input.error } : {}), ...(input.result ? { result: input.result as AgentWorkbenchExecutionResult } : {}) };
}

export function validateAgentWorkbenchExecutionResult(
  request: AgentWorkbenchExecutionRequest,
  result: AgentWorkbenchExecutionResult,
): AgentWorkbenchExecutionResult {
  if (request.domain !== result.domain || request.requestId !== result.requestId) throw new Error(tr("Viron Agent 工作台执行现场已经失效"));
  if (request.domain === "ssh" && result.domain === "ssh") {
    if (
      request.sessionId !== result.sessionId
      || request.executionTarget !== result.executionTarget
      || request.command !== result.command
      || typeof result.connectionId !== "string"
      || typeof result.connectionName !== "string"
      || typeof result.host !== "string"
      || typeof result.rawOutput !== "string"
      || result.rawOutput.length > 512 * 1024
      || !Number.isFinite(result.durationMs)
      || typeof result.truncated !== "boolean"
    ) throw new Error(tr("Viron Agent SSH 工作台执行结果无效"));
    return result;
  }
  if (request.domain === "database" && result.domain === "database") {
    const parsed = agentDatabaseReadResult(agentTransportValue(result.result));
    if (!parsed || parsed.connectionId !== request.connectionId || parsed.database !== request.database || parsed.sql !== request.sql) {
      throw new Error(tr("Viron Agent 数据库工作台执行结果无效"));
    }
    return { ...result, result: parsed };
  }
  throw new Error(tr("Viron Agent 工作台执行结果无效"));
}

export async function executeAgentSshWorkbenchRead(input: {
  request: AgentWorkbenchExecutionRequest & { domain: "ssh" };
  scope: AgentRuntimeScope;
  desktopContext: DesktopSshContext;
  abortSignal: AbortSignal;
}): Promise<import("../../shared/agent.js").AgentSshDiagnosticResult> {
  if (!agentRuntimeScopeMatches(input.scope, agentRuntimeScope(input.desktopContext))) throw new Error(tr("Viron Agent 诊断现场已经失效"));
  const currentTarget = currentExecutionMode() === "server" ? "server-forwarded" : "desktop-local";
  if (input.request.executionTarget !== currentTarget) throw new Error(tr("Viron Agent 诊断现场已经失效"));
  const write = input.request.intent === "write";
  desktopAgentAuditStore.append(input.scope, write ? "ssh_workbench_write_started" : "ssh_workbench_execution_started", input.request.sessionId, tr("在当前 SSH 终端执行{{0}}（第 {{1}}/{{2}} 步）", [write ? tr("写命令") : tr("只读诊断命令"), input.request.step, input.request.maxSteps]));
  try {
    const snapshot = input.request.executionTarget === "server-forwarded"
      ? await endpointJson<import("../../shared/agent.js").AgentSshContextSnapshot>(
        `/api/v1/ssh-sessions/${encodeURIComponent(input.request.sessionId)}/agent-context`,
        {
          method: "POST",
          body: await signedDesktopOperation({
            operationId: randomUUID(),
            action: "context" as const,
            sessionId: input.request.sessionId,
            executionScope: executionScopeForEndpoint(input.desktopContext.endpoint),
          }, input.desktopContext),
        },
      )
      : await desktopSshRuntime.agentContext(input.request.sessionId, input.desktopContext);
    const result = await requestAgentWorkbenchExecution(input.request, input.abortSignal);
    if (result.domain !== "ssh") throw new Error(tr("Viron Agent SSH 工作台执行结果无效"));
    if (
      result.connectionId !== snapshot.connectionId
      || result.connectionName !== snapshot.connectionName
      || result.host !== snapshot.host
      || result.executionTarget !== snapshot.executionTarget
    ) throw new Error(tr("Viron Agent SSH 工作台执行现场已经失效"));
    if (!agentRuntimeScopeMatches(input.scope, agentRuntimeScope(await currentDesktopSshContext()))) throw new Error(tr("Viron Agent 诊断现场已经失效"));
    const output = summarizeAgentSshOutput(result.rawOutput, { maxBytes: 64 * 1024, maxLines: 500 });
    desktopAgentAuditStore.append(input.scope, write ? "ssh_workbench_write_completed" : "ssh_workbench_execution_completed", result.connectionId, tr("SSH 终端{{0}}完成，耗时 {{1}} ms，输出脱敏 {{2}} 处{{3}}", [write ? tr("写命令") : tr("只读诊断"), result.durationMs, output.redactionCount, output.truncated || result.truncated ? tr("，结果已截断") : ""]));
    return {
      executionId: input.request.requestId,
      sessionId: result.sessionId,
      connectionId: result.connectionId,
      connectionName: result.connectionName,
      host: result.host,
      executionTarget: result.executionTarget,
      command: result.command,
      stdout: output.output,
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: result.durationMs,
      truncated: output.truncated || result.truncated,
      redactionCount: output.redactionCount,
      presentation: "workbench",
    };
  } catch (error) {
    desktopAgentAuditStore.append(input.scope, input.abortSignal.aborted ? "ssh_workbench_execution_cancelled" : "ssh_workbench_execution_failed", input.request.sessionId, error instanceof Error ? error.message : tr("SSH 工作台执行失败"));
    throw error;
  }
}

export async function executeAgentDatabaseRead(input: {
  connectionId: string;
  database: string;
  sql: string;
  scope: AgentRuntimeScope;
  desktopContext: DesktopSshContext;
  abortSignal?: AbortSignal;
  step?: number;
  maxSteps?: number;
  intent?: "read" | "write";
}): Promise<import("../../shared/agent.js").AgentDatabaseReadResult> {
  if (!agentRuntimeScopeMatches(input.scope, agentRuntimeScope(input.desktopContext))) throw new Error(tr("Viron Agent 诊断现场已经失效"));
  const target = `${input.connectionId}:${input.database}`;
  const stepSummary = input.step && input.maxSteps ? tr("（第 {{0}}/{{1}} 步）", [input.step, input.maxSteps]) : "";
  const write = input.intent === "write";
  desktopAgentAuditStore.append(input.scope, write ? "database_write_approved" : "database_read_approved", target, tr("按当前 Viron Agent 审批策略执行数据库{{0}}{{1}}", [write ? tr("写 SQL") : tr("只读查询"), stepSummary]));
  try {
    const result = write
      ? await desktopDatabaseRuntime.agentWriteQuery(input.connectionId, input.database, input.sql, input.desktopContext, input.abortSignal)
      : await desktopDatabaseRuntime.agentReadQuery(input.connectionId, input.database, input.sql, input.desktopContext, input.abortSignal);
    desktopAgentAuditStore.append(input.scope, write ? "database_write_executed" : "database_read_executed", target, write ? tr("执行写 SQL{{0}}，影响 {{1}} 行", [stepSummary, result.affectedRows ?? result.rowCount]) : tr("执行只读 SQL{{0}}，返回 {{1}} 行", [stepSummary, result.rowCount]));
    return result;
  } catch (error) {
    if (input.abortSignal?.aborted) {
      desktopAgentAuditStore.append(input.scope, write ? "database_write_cancelled" : "database_read_cancelled", target, tr("数据库{{0}}已取消{{1}}", [write ? tr("写 SQL") : tr("只读查询"), stepSummary]));
    } else {
      desktopAgentAuditStore.append(input.scope, write ? "database_write_rejected" : "database_read_rejected", target, error instanceof Error ? error.message : write ? tr("写 SQL 执行失败") : tr("只读 SQL 执行失败"));
    }
    throw error;
  }
}

export function registerDesktopAgentIpc(): void {
  ipcMain.handle("viron:agent:settings:get", async (event) => {
    trustedSender(event);
    return desktopAgentSettingsStore.get(await currentAgentSettingsScope());
  });
  ipcMain.handle("viron:agent:settings:save", async (event, input: unknown) => {
    trustedSender(event);
    const scope = await currentAgentSettingsScope();
    const saved = desktopAgentSettingsStore.save(scope, agentSettingsInput(input));
    desktopAgentRuntime.stopAll(tr("Viron Agent 配置或访问策略已更新"));
    return saved;
  });
  ipcMain.handle("viron:agent:models:list", async (event, input: unknown) => {
    trustedSender(event);
    return listAgentModels(desktopAgentSettingsStore, await currentAgentSettingsScope(), agentModelListInput(input));
  });
  ipcMain.handle("viron:agent:settings:delete", async (event) => {
    trustedSender(event);
    const scope = await currentAgentSettingsScope();
    const deleted = desktopAgentSettingsStore.delete(scope);
    desktopAgentRuntime.stopAll(tr("Viron Agent 配置已清除"));
    return deleted;
  });
  ipcMain.handle("viron:agent:settings:test", async (event) => {
    trustedSender(event);
    return desktopAgentRuntime.test(await currentAgentSettingsScope());
  });
  ipcMain.handle("viron:agent:ssh-context", async (event, sessionId: unknown) => {
    trustedSender(event);
    const id = requireDesktopString(sessionId, tr("SSH 会话 ID"));
    if (currentExecutionMode() === "server") {
      if (!activeEndpoint?.capabilities.serverForwarding.ssh) throw new Error(tr("当前 Endpoint 未开放 SSH 服务端转发能力"));
      const desktopContext = await currentDesktopSshContext();
      const executionScope = executionScopeForEndpoint(desktopContext.endpoint);
      return endpointJson<import("../../shared/agent.js").AgentSshContextSnapshot>(
        `/api/v1/ssh-sessions/${encodeURIComponent(id)}/agent-context`,
        {
          method: "POST",
          body: await signedDesktopOperation({
            operationId: randomUUID(),
            action: "context" as const,
            sessionId: id,
            executionScope,
          }, desktopContext),
        },
      );
    }
    return desktopSshRuntime.agentContext(id, await currentDesktopSshContext());
  });
  ipcMain.handle("viron:agent:database-context", async (event, value: unknown) => {
    trustedSender(event);
    const input = agentDatabaseContextInput(value);
    const scope = await currentAgentSettingsScope();
    const snapshot = await desktopDatabaseRuntime.agentContext(input, await currentDesktopSshContext());
    desktopAgentAuditStore.append(scope, "database_context_read", `${snapshot.connectionId}:${snapshot.database}`, tr("读取数据库现场 {{0}} / {{1}}", [snapshot.connectionName, snapshot.database]));
    return snapshot;
  });
  ipcMain.handle("viron:agent:database-read", async (event, value: unknown) => {
    trustedSender(event);
    if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 数据库查询参数无效"));
    const input = value as { connectionId?: unknown; database?: unknown; sql?: unknown };
    const connectionId = requireDesktopString(input.connectionId, tr("数据库连接 ID"));
    const database = requireDesktopString(input.database, tr("数据库"));
    const sql = requireDesktopString(input.sql, "SQL");
    const desktopContext = await currentDesktopSshContext();
    return executeAgentDatabaseRead({ connectionId, database, sql, scope: agentRuntimeScope(desktopContext), desktopContext });
  });
  ipcMain.handle("viron:agent:audit:record", async (event, value: unknown) => {
    trustedSender(event);
    if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 操作记录无效"));
    const input = value as { action?: unknown; target?: unknown; summary?: unknown };
    desktopAgentAuditStore.append(await currentAgentSettingsScope(), requireDesktopString(input.action, tr("操作类型")), requireDesktopString(input.target, tr("操作目标")), requireDesktopString(input.summary, tr("操作摘要")));
    return { recorded: true as const };
  });
  ipcMain.handle("viron:agent:audit:clear", async (event) => {
    trustedSender(event);
    return desktopAgentAuditStore.clear(await currentAgentSettingsScope());
  });
  ipcMain.handle("viron:agent:sessions:list", async (event) => {
    trustedSender(event);
    return desktopAgentRuntime.listConversations(await currentAgentSettingsScope());
  });
  ipcMain.handle("viron:agent:sessions:current", async (event) => {
    trustedSender(event);
    return desktopAgentRuntime.currentConversation(await currentAgentSettingsScope());
  });
  ipcMain.handle("viron:agent:sessions:create", async (event, value: unknown) => {
    trustedSender(event);
    const title = typeof value === "string" ? value.slice(0, 80) : undefined;
    return desktopAgentRuntime.createConversation(await currentAgentSettingsScope(), title);
  });
  ipcMain.handle("viron:agent:sessions:select", async (event, sessionId: unknown) => {
    trustedSender(event);
    return desktopAgentRuntime.selectConversation(await currentAgentSettingsScope(), requireDesktopString(sessionId, tr("Agent 会话 ID")));
  });
  ipcMain.handle("viron:agent:sessions:rename", async (event, value: unknown) => {
    trustedSender(event);
    if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 会话重命名参数无效"));
    const input = value as { sessionId?: unknown; title?: unknown };
    return desktopAgentRuntime.renameConversation(
      await currentAgentSettingsScope(),
      requireDesktopString(input.sessionId, tr("Agent 会话 ID")),
      requireDesktopString(input.title, tr("Agent 会话标题")),
    );
  });
  ipcMain.handle("viron:agent:sessions:delete", async (event, sessionId: unknown) => {
    trustedSender(event);
    return desktopAgentRuntime.deleteConversation(await currentAgentSettingsScope(), requireDesktopString(sessionId, tr("Agent 会话 ID")));
  });
  ipcMain.handle("viron:agent:chat", async (event, input: unknown) => {
    trustedSender(event);
    return desktopAgentRuntime.chat(await currentAgentRuntimeScope(), agentChatRequest(input));
  });
  ipcMain.handle("viron:agent:approval:respond", async (event, value: unknown) => {
    trustedSender(event);
    if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 工具审批响应无效"));
    const input = value as Partial<AgentToolApprovalResponseInput>;
    const runId = requireDesktopString(input.runId, tr("Agent 运行 ID"));
    const approvalId = requireDesktopString(input.approvalId, tr("Agent 审批 ID"));
    if (typeof input.approved !== "boolean") throw new Error(tr("Agent 审批结果无效"));
    if (input.reason !== undefined && typeof input.reason !== "string") throw new Error(tr("Agent 审批说明无效"));
    const scope = await currentAgentRuntimeScope();
    const result = desktopAgentRuntime.respondApproval(scope, {
      runId,
      approvalId,
      approved: input.approved,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return result;
  });
  ipcMain.handle("viron:agent:workbench:respond", (event, value: unknown) => {
    trustedSender(event);
    let requestId = "";
    try {
      const input = agentWorkbenchExecutionResponse(value);
      requestId = input.requestId;
      const pending = pendingAgentWorkbenchExecutions.get(requestId);
      if (!pending) throw new Error(tr("Viron Agent 工作台执行请求不存在或已经结束"));
      if (input.error) {
        settleAgentWorkbenchExecution(requestId, new Error(input.error.slice(0, 1_000)));
        return { accepted: true as const };
      }
      if (!input.result) throw new Error(tr("Viron Agent 工作台执行结果无效"));
      settleAgentWorkbenchExecution(requestId, validateAgentWorkbenchExecutionResult(pending.request, input.result));
      return { accepted: true as const };
    } catch (error) {
      if (!requestId && value && typeof value === "object" && typeof (value as { requestId?: unknown }).requestId === "string") {
        requestId = (value as { requestId: string }).requestId.trim();
      }
      if (requestId) settleAgentWorkbenchExecution(requestId, error instanceof Error ? error : new Error(tr("Viron Agent 工作台执行结果无效")));
      throw error;
    }
  });
  ipcMain.handle("viron:agent:chat:stop", async (event, runId: unknown) => {
    trustedSender(event);
    const id = requireDesktopString(runId, tr("Agent 运行 ID"));
    return desktopAgentRuntime.stop(id);
  });
  ipcMain.handle("viron:agent:resource:stop", (event, value: unknown) => {
    trustedSender(event);
    if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 资源关闭通知无效"));
    const input = value as { kind?: unknown; resourceId?: unknown; executionTarget?: unknown };
    if (input.kind === "database") {
      const resourceId = requireDesktopString(input.resourceId, tr("数据库连接 ID"));
      return { stopped: desktopAgentRuntime.stopForSourcePrefix(`desktop-database:${resourceId}:`, tr("当前数据库连接已关闭")) };
    }
    if (input.kind === "ssh") {
      const resourceId = requireDesktopString(input.resourceId, tr("SSH 会话 ID"));
      if (input.executionTarget !== "desktop-local" && input.executionTarget !== "server-forwarded") throw new Error(tr("SSH 执行位置无效"));
      const prefix = input.executionTarget === "server-forwarded" ? "server-ssh:" : "desktop-ssh:";
      return { stopped: desktopAgentRuntime.stopForSource(`${prefix}${resourceId}`, tr("当前 SSH 会话已关闭")) };
    }
    throw new Error(tr("Viron Agent 资源类型无效"));
  });
}
