import { agentSqlWritePreview, agentSshWritePreview } from "./agent-write.js";

export type AgentContextKind = "scene" | "ssh" | "database" | "log" | "redis" | "web";

export type AgentEntryMode = "floating" | "quick" | "disabled";

export const AGENT_APPROVAL_MODES = ["always", "risk-only", "never"] as const;
export type AgentApprovalMode = typeof AGENT_APPROVAL_MODES[number];
export type AgentActionRiskLevel = "low" | "medium" | "high";

export const AGENT_EXECUTION_PRESENTATIONS = ["conversation", "workbench"] as const;
export type AgentExecutionPresentation = typeof AGENT_EXECUTION_PRESENTATIONS[number];

export const DEFAULT_AGENT_APPROVAL_MODE: AgentApprovalMode = "always";
export const DEFAULT_AGENT_EXECUTION_PRESENTATION: AgentExecutionPresentation = "conversation";

export function agentApprovalMode(value: unknown): AgentApprovalMode {
  return AGENT_APPROVAL_MODES.includes(value as AgentApprovalMode)
    ? value as AgentApprovalMode
    : DEFAULT_AGENT_APPROVAL_MODE;
}

export function agentExecutionPresentation(value: unknown): AgentExecutionPresentation {
  return AGENT_EXECUTION_PRESENTATIONS.includes(value as AgentExecutionPresentation)
    ? value as AgentExecutionPresentation
    : DEFAULT_AGENT_EXECUTION_PRESENTATION;
}

export function agentApprovalRequired(mode: AgentApprovalMode, riskLevel: AgentActionRiskLevel): boolean {
  if (mode === "never") return false;
  if (mode === "risk-only") return riskLevel !== "low";
  return true;
}

export function agentEntryMode(value: unknown): AgentEntryMode {
  if (value === "floating" || value === "quick" || value === "disabled") return value;
  if (value === "both") return "floating";
  return "disabled";
}

export interface AgentContextCard {
  id: string;
  kind: AgentContextKind;
  title: string;
  summary: string;
  source: string;
  createdAt: string;
  resourceId?: string;
}

export type AgentChatRole = "user" | "assistant";

export interface AgentTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface AgentChatMessage {
  id: string;
  role: AgentChatRole;
  content: string;
  createdAt: string;
  durationMs?: number;
  usage?: AgentTurnUsage;
}

export interface AgentConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface AgentConversation extends AgentConversationSummary {
  messages: AgentChatMessage[];
}

export interface AgentConversationListResult {
  currentSessionId: string;
  items: AgentConversationSummary[];
}

export interface AgentSceneHint {
  routePath: string;
  routeName: string;
  contexts: AgentContextCard[];
  capturedAt: string;
}

export interface AgentSettingsPublic {
  configured: boolean;
  endpoint: string;
  protocol: AgentApiProtocol;
  model: string;
  apiKeyStored: boolean;
  approvalMode: AgentApprovalMode;
  executionPresentation: AgentExecutionPresentation;
  updatedAt: string | null;
}

export interface AgentSettingsInput {
  endpoint: string;
  protocol: AgentApiProtocol;
  model: string;
  apiKey?: string;
  approvalMode: AgentApprovalMode;
  executionPresentation: AgentExecutionPresentation;
}

export type AgentApiProtocol = "openai" | "anthropic";

export interface AgentModelListInput {
  endpoint: string;
  protocol: AgentApiProtocol;
  apiKey?: string;
}

export interface AgentModelListResult {
  models: string[];
}

export interface AgentSettingsTestResult {
  ok: true;
  model: string;
  latencyMs: number;
  text: string;
}

export interface AgentChatRequest {
  sessionId?: string;
  message?: string;
  sceneHint?: AgentSceneHint;
  messages?: AgentChatMessage[];
  contextCards?: AgentContextCard[];
}

export interface AgentSshContextSnapshot {
  sessionId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  executionTarget: "desktop-local" | "server-forwarded";
  capturedAt: string;
  output: string;
  includedBytes: number;
  lineCount: number;
  truncated: boolean;
  redactionCount: number;
}

export interface AgentSshCommandSuggestion {
  kind: "ssh-command-suggestion";
  command: string;
  explanation: string;
  contextId: string;
  source: string;
  execution: "fill-only" | "confirm-read" | "confirm-write";
  riskLevel?: AgentActionRiskLevel;
  impactPreview?: import("./agent-write.js").AgentSshWritePreview;
  approval?: AgentDiagnosticApproval;
}

export type AgentSshScriptInterpreter = "sh" | "bash";

export interface AgentSshScriptSuggestion {
  kind: "ssh-script-suggestion";
  script: string;
  interpreter: AgentSshScriptInterpreter;
  explanation: string;
  contextId: string;
  source: string;
  execution: "fill-only";
}

export interface AgentDiagnosticApproval {
  runId: string;
  approvalId: string;
  step: number;
  maxSteps: number;
  deadlineAt: string;
}

export interface AgentToolApprovalResponseInput {
  runId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
}

export interface AgentVironToolApprovalSuggestion {
  kind: "viron-tool-approval";
  toolName: string;
  title: string;
  description: string;
  riskLevel: AgentActionRiskLevel;
  input: AgentJsonValue;
  approval: AgentDiagnosticApproval;
}

export interface AgentSshDiagnosticResult {
  executionId: string;
  sessionId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  executionTarget: "desktop-local" | "server-forwarded";
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
  redactionCount: number;
  presentation?: AgentExecutionPresentation;
}

export interface AgentDatabaseContextInput {
  connectionId: string;
  database: string;
  editorSql: string;
  selectedSql: string;
  resultPreview: Array<Record<string, unknown>>;
}

export interface AgentDatabaseContextSnapshot {
  connectionId: string;
  connectionName: string;
  database: string;
  capturedAt: string;
  schema: Array<{ name: string; type: "table" | "view"; columns: Array<{ name: string; dataType: string }> }>;
  editorSql: string;
  selectedSql: string;
  resultPreview: Array<Record<string, AgentJsonValue>>;
  truncated: boolean;
  redactionCount: number;
}

export interface AgentDatabaseSqlSuggestion {
  kind: "database-sql-suggestion";
  sql: string;
  explanation: string;
  contextId: string;
  source: string;
  execution: "fill-only" | "confirm-read" | "confirm-write";
  riskLevel?: AgentActionRiskLevel;
  impactPreview?: import("./agent-write.js").AgentSqlWritePreview;
  approval?: AgentDiagnosticApproval;
}

export interface AgentDatabaseReadResult {
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
  columns: string[];
  rows: Array<Record<string, AgentJsonValue>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  presentation?: AgentExecutionPresentation;
  affectedRows?: number;
  insertId?: number | string | null;
  impactPreview?: import("./agent-write.js").AgentSqlWritePreview;
}

export type AgentWorkbenchDomain = "ssh" | "database" | "redis" | "knowledge" | "service";

interface AgentWorkbenchExecutionRequestBase {
  type: "workbench-execution-request";
  requestId: string;
  runId: string;
  messageId: string;
  toolCallId: string;
  deadlineAt: string;
  step: number;
  maxSteps: number;
}

export type AgentWorkbenchExecutionRequest =
  | AgentWorkbenchExecutionRequestBase & {
    domain: "ssh";
    sessionId: string;
    executionTarget: "desktop-local" | "server-forwarded";
    command: string;
    intent?: "read" | "write";
  }
  | AgentWorkbenchExecutionRequestBase & {
    domain: "database";
    connectionId: string;
    database: string;
    sql: string;
    intent?: "read" | "write";
  };

export type AgentWorkbenchExecutionCancel = {
  type: "workbench-execution-cancel";
  requestId: string;
  runId: string;
  domain: AgentWorkbenchDomain;
  reason: string;
};

export type AgentWorkbenchExecutionResult =
  | {
    domain: "ssh";
    requestId: string;
    sessionId: string;
    connectionId: string;
    connectionName: string;
    host: string;
    executionTarget: "desktop-local" | "server-forwarded";
    command: string;
    rawOutput: string;
    durationMs: number;
    truncated: boolean;
  }
  | {
    domain: "database";
    requestId: string;
    result: AgentDatabaseReadResult;
  };

export interface AgentWorkbenchExecutionResponseInput {
  requestId: string;
  result?: AgentWorkbenchExecutionResult;
  error?: string;
}

export function agentChatRequestTransport(input: AgentChatRequest): AgentChatRequest {
  return {
    ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
    ...(typeof input.message === "string" ? { message: input.message } : {}),
    ...(input.sceneHint ? {
      sceneHint: {
        routePath: input.sceneHint.routePath,
        routeName: input.sceneHint.routeName,
        capturedAt: input.sceneHint.capturedAt,
        contexts: input.sceneHint.contexts.map((card) => ({
          id: card.id,
          kind: card.kind,
          title: card.title,
          summary: card.summary,
          source: card.source,
          createdAt: card.createdAt,
          ...(typeof card.resourceId === "string" && card.resourceId ? { resourceId: card.resourceId } : {}),
        })),
      },
    } : {}),
    ...(Array.isArray(input.messages) ? { messages: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })) } : {}),
    ...(Array.isArray(input.contextCards) ? { contextCards: input.contextCards.map((card) => ({
      id: card.id,
      kind: card.kind,
      title: card.title,
      summary: card.summary,
      source: card.source,
      createdAt: card.createdAt,
      ...(typeof card.resourceId === "string" && card.resourceId ? { resourceId: card.resourceId } : {}),
    })) } : {}),
  };
}

export type AgentJsonValue = string | number | boolean | null | AgentJsonValue[] | { [key: string]: AgentJsonValue };

export function normalizeAgentSshCommand(value: unknown): string {
  if (typeof value !== "string") throw new Error("SSH 建议命令无效");
  let command = value.trim();
  if (command.startsWith("`") && command.endsWith("`") && !command.slice(1, -1).includes("`")) command = command.slice(1, -1).trim();
  if (!command) throw new Error("SSH 建议命令不能为空");
  if (command.length > 2_000) throw new Error("SSH 建议命令过长");
  if (/[\r\n\0]/.test(command)) throw new Error("SSH 建议命令必须是单行文本");
  if (/\x1b/.test(command)) throw new Error("SSH 建议命令不能包含终端控制字符");
  return command;
}

export function agentSshCommandSuggestion(value: AgentJsonValue): AgentSshCommandSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.kind !== "ssh-command-suggestion"
    || (value.execution !== "fill-only" && value.execution !== "confirm-read" && value.execution !== "confirm-write")
    || typeof value.contextId !== "string"
    || typeof value.source !== "string"
  ) return null;
  try {
    const approval = agentDiagnosticApproval(value.approval);
    const impactPreview = agentSshWritePreview(value.impactPreview);
    return {
      kind: "ssh-command-suggestion",
      command: normalizeAgentSshCommand(value.command),
      explanation: typeof value.explanation === "string" ? value.explanation.slice(0, 600) : "",
      contextId: value.contextId,
      source: value.source,
      execution: value.execution,
      ...(value.riskLevel === "low" || value.riskLevel === "medium" || value.riskLevel === "high" ? { riskLevel: value.riskLevel } : {}),
      ...(impactPreview ? { impactPreview } : {}),
      ...(approval ? { approval } : {}),
    };
  } catch {
    return null;
  }
}

export function normalizeAgentSshScript(value: unknown): string {
  if (typeof value !== "string") throw new Error("SSH 建议脚本无效");
  const script = value
    .trim()
    .replace(/^```(?:bash|sh|shell)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!script) throw new Error("SSH 建议脚本不能为空");
  if (script.length > 20_000) throw new Error("SSH 建议脚本过长");
  if (/\0|\x1b/.test(script)) throw new Error("SSH 建议脚本不能包含终端控制字符");
  if (/[^\t\n\x20-\x7e\u0080-\uffff]/.test(script)) throw new Error("SSH 建议脚本包含无效控制字符");
  if (!script.includes("\n")) throw new Error("SSH 建议脚本必须包含多行内容");
  return script;
}

export function agentSshScriptSuggestion(value: AgentJsonValue): AgentSshScriptSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.kind !== "ssh-script-suggestion"
    || value.execution !== "fill-only"
    || (value.interpreter !== "sh" && value.interpreter !== "bash")
    || typeof value.contextId !== "string"
    || typeof value.source !== "string"
  ) return null;
  try {
    return {
      kind: "ssh-script-suggestion",
      script: normalizeAgentSshScript(value.script),
      interpreter: value.interpreter,
      explanation: typeof value.explanation === "string" ? value.explanation.slice(0, 600) : "",
      contextId: value.contextId,
      source: value.source,
      execution: "fill-only",
    };
  } catch {
    return null;
  }
}

export function normalizeAgentDatabaseSql(value: unknown): string {
  if (typeof value !== "string") throw new Error("数据库建议 SQL 无效");
  const sql = value.trim().replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!sql) throw new Error("数据库建议 SQL 不能为空");
  if (sql.length > 20_000) throw new Error("数据库建议 SQL 过长");
  if (/\0/.test(sql)) throw new Error("数据库建议 SQL 包含无效字符");
  return sql;
}

export function agentDatabaseSqlSuggestion(value: AgentJsonValue): AgentDatabaseSqlSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind !== "database-sql-suggestion"
    || (value.execution !== "fill-only" && value.execution !== "confirm-read" && value.execution !== "confirm-write")
    || typeof value.contextId !== "string"
    || typeof value.source !== "string") return null;
  try {
    const approval = agentDiagnosticApproval(value.approval);
    const impactPreview = agentSqlWritePreview(value.impactPreview);
    return {
      kind: "database-sql-suggestion",
      sql: normalizeAgentDatabaseSql(value.sql),
      explanation: typeof value.explanation === "string" ? value.explanation.slice(0, 600) : "",
      contextId: value.contextId,
      source: value.source,
      execution: value.execution,
      ...(value.riskLevel === "low" || value.riskLevel === "medium" || value.riskLevel === "high" ? { riskLevel: value.riskLevel } : {}),
      ...(impactPreview ? { impactPreview } : {}),
      ...(approval ? { approval } : {}),
    };
  } catch {
    return null;
  }
}

export function agentDiagnosticApproval(value: AgentJsonValue | undefined): AgentDiagnosticApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.runId !== "string"
    || typeof value.approvalId !== "string"
    || !Number.isInteger(value.step)
    || !Number.isInteger(value.maxSteps)
    || typeof value.deadlineAt !== "string"
  ) return null;
  const step = Number(value.step);
  const maxSteps = Number(value.maxSteps);
  if (step < 1 || maxSteps < 1 || step > maxSteps || Number.isNaN(Date.parse(value.deadlineAt))) return null;
  return { runId: value.runId, approvalId: value.approvalId, step, maxSteps, deadlineAt: value.deadlineAt };
}

export function agentVironToolApprovalSuggestion(value: AgentJsonValue): AgentVironToolApprovalSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.kind !== "viron-tool-approval"
    || typeof value.toolName !== "string"
    || typeof value.title !== "string"
    || typeof value.description !== "string"
    || (value.riskLevel !== "low" && value.riskLevel !== "medium" && value.riskLevel !== "high")
  ) return null;
  const approval = agentDiagnosticApproval(value.approval);
  if (!approval) return null;
  return {
    kind: "viron-tool-approval",
    toolName: value.toolName,
    title: value.title,
    description: value.description,
    riskLevel: value.riskLevel,
    input: value.input ?? null,
    approval,
  };
}

export function agentSshDiagnosticResult(value: AgentJsonValue): AgentSshDiagnosticResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.executionId !== "string"
    || typeof value.sessionId !== "string"
    || typeof value.connectionId !== "string"
    || typeof value.connectionName !== "string"
    || typeof value.host !== "string"
    || (value.executionTarget !== "desktop-local" && value.executionTarget !== "server-forwarded")
    || typeof value.command !== "string"
    || typeof value.stdout !== "string"
    || typeof value.stderr !== "string"
    || (value.exitCode !== null && typeof value.exitCode !== "number")
    || (value.signal !== null && typeof value.signal !== "string")
    || typeof value.durationMs !== "number"
    || typeof value.truncated !== "boolean"
    || typeof value.redactionCount !== "number"
    || (value.presentation !== undefined && value.presentation !== "conversation" && value.presentation !== "workbench")
  ) return null;
  return value as unknown as AgentSshDiagnosticResult;
}

export function agentDatabaseReadResult(value: AgentJsonValue): AgentDatabaseReadResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.connectionId !== "string"
    || typeof value.connectionName !== "string"
    || typeof value.database !== "string"
    || typeof value.sql !== "string"
    || !Array.isArray(value.columns)
    || !value.columns.every((column) => typeof column === "string")
    || !Array.isArray(value.rows)
    || typeof value.rowCount !== "number"
    || typeof value.truncated !== "boolean"
    || typeof value.durationMs !== "number"
    || (value.presentation !== undefined && value.presentation !== "conversation" && value.presentation !== "workbench")
    || (value.affectedRows !== undefined && typeof value.affectedRows !== "number")
    || (value.insertId !== undefined && value.insertId !== null && typeof value.insertId !== "number" && typeof value.insertId !== "string")
  ) return null;
  const impactPreview = agentSqlWritePreview(value.impactPreview);
  return {
    ...(value as unknown as AgentDatabaseReadResult),
    ...(impactPreview ? { impactPreview } : {}),
  };
}

const AGENT_TRANSPORT_MAX_DEPTH = 8;
const AGENT_TRANSPORT_MAX_ENTRIES = 100;

export function agentTransportValue(value: unknown, depth = 0, seen = new WeakSet<object>()): AgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (depth >= AGENT_TRANSPORT_MAX_DEPTH) return "[Max depth]";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (ArrayBuffer.isView(value)) return `[Binary ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[Binary ${value.byteLength} bytes]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, AGENT_TRANSPORT_MAX_ENTRIES).map((item) => agentTransportValue(item, depth + 1, seen));
  }
  if (value instanceof Map) {
    return [...value.entries()].slice(0, AGENT_TRANSPORT_MAX_ENTRIES).map(([key, item]) => [
      agentTransportValue(key, depth + 1, seen),
      agentTransportValue(item, depth + 1, seen),
    ]);
  }
  if (value instanceof Set) {
    return [...value.values()].slice(0, AGENT_TRANSPORT_MAX_ENTRIES).map((item) => agentTransportValue(item, depth + 1, seen));
  }

  const output: Record<string, AgentJsonValue> = {};
  for (const key of Object.keys(value).slice(0, AGENT_TRANSPORT_MAX_ENTRIES)) {
    try {
      output[key] = agentTransportValue((value as Record<string, unknown>)[key], depth + 1, seen);
    } catch {
      output[key] = "[Unreadable]";
    }
  }
  return output;
}

export type AgentStreamEvent =
  | { type: "run-start"; runId: string; messageId: string; sessionId: string; createdAt: string }
  | { type: "text-delta"; runId: string; messageId: string; delta: string }
  | { type: "tool-call"; runId: string; toolCallId: string; toolName: string; input: AgentJsonValue }
  | { type: "tool-result"; runId: string; toolCallId: string; toolName: string; output: AgentJsonValue }
  | { type: "tool-error"; runId: string; toolCallId: string; toolName: string; message: string }
  | { type: "execution-start"; runId: string; messageId: string; toolCallId: string; toolName: string; suggestion: AgentJsonValue }
  | { type: "approval-required"; runId: string; messageId: string; toolCallId: string; toolName: string; suggestion: AgentJsonValue }
  | { type: "run-pause"; runId: string; messageId: string; approvalId: string; step: number; maxSteps: number; deadlineAt: string; usage?: AgentJsonValue }
  | { type: "run-finish"; runId: string; messageId: string; finishReason: string; durationMs: number; usage?: AgentTurnUsage }
  | { type: "run-error"; runId: string; messageId?: string; message: string; durationMs?: number; usage?: AgentTurnUsage }
  | { type: "run-abort"; runId: string; messageId?: string; reason: string; durationMs?: number; usage?: AgentTurnUsage }
  | AgentWorkbenchExecutionRequest
  | AgentWorkbenchExecutionCancel;
