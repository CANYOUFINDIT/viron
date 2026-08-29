import { translate as tr } from "./i18n";
import { computed, shallowRef } from "vue";
import { resolveExecutionTargets, type DesktopExecutionMode } from "../shared/execution-mode";
import type { DesktopTitleBarAppearance } from "../shared/desktop-titlebar";
import type { DesktopUpdateCheckResult } from "../shared/desktop-release";
import {
  plainImmersiveNavigationState,
  type ImmersiveNavigationAction,
  type ImmersiveNavigationState,
} from "../shared/immersive-navigation";
import { agentChatRequestTransport } from "../shared/agent";
import type {
  AgentChatRequest,
  AgentDatabaseContextInput,
  AgentDatabaseContextSnapshot,
  AgentDatabaseReadResult,
  AgentConversation,
  AgentConversationListResult,
  AgentConversationSummary,
  AgentEntryMode,
  AgentModelListInput,
  AgentModelListResult,
  AgentSettingsInput,
  AgentSettingsPublic,
  AgentSettingsTestResult,
  AgentSshContextSnapshot,
  AgentStreamEvent,
  AgentToolApprovalResponseInput,
  AgentWorkbenchExecutionResponseInput,
} from "../shared/agent";
import type { AgentFloatingOverlayAction, AgentFloatingOverlayState } from "../shared/agent-floating-overlay";
import type { ConnectionQualityOverlayAction, ConnectionQualityOverlayState } from "../shared/connection-quality";
import type { ActiveEnvironmentDockAction, ActiveEnvironmentDockLayoutState, ActiveEnvironmentDockState } from "../shared/active-environment-dock";
import { dispatchConnectionLimit } from "./connection-limit";
import type { DesktopMcpStatus, McpApprovalMode } from "../shared/mcp-settings";
import type { DesktopMonitorAlertNotification } from "../shared/monitor-alerts";
import { sftpTransferCreateSnapshot, type SftpTransferCreateInput } from "./sftp";

export interface DesktopCapabilities {
  product: string;
  productVersion: string;
  apiProtocol: { min: number; max: number };
  clientAccess?: { desktop: boolean; web: boolean };
  desktopLocal?: { web: boolean; ssh?: boolean; sftp?: boolean; logs?: boolean; database?: boolean; redis?: boolean; inspection?: boolean };
  mcp?: { server: { enabled: boolean; path: string; transport: "streamable-http"; authentication: "personal-api-key" } };
  serverForwarding: {
    enabled: boolean;
    web: boolean;
    ssh: boolean;
    sftp: boolean;
    logs: boolean;
    database: boolean;
    redis?: boolean;
  };
}

export interface DesktopState {
  appVersion: string;
  language: import("../shared/i18n").Language;
  agentEntryMode: AgentEntryMode;
  recentEndpoint: string | null;
  endpoint: string | null;
  protocolVersion: number | null;
  capabilities: DesktopCapabilities | null;
  executionMode: DesktopExecutionMode;
}

export interface DesktopExecutionActivity {
  total: number;
  counts: { web: number; ssh: number; sftp: number; logs: number; database: number; redis: number };
}

export const desktopAppState = shallowRef<DesktopState | null>(null);
export const desktopAgentSettings = shallowRef<AgentSettingsPublic | null>(null);
export const desktopExecutionTargets = computed(() => resolveExecutionTargets(
  desktopAppState.value?.executionMode ?? "local",
  desktopAppState.value?.capabilities,
));

interface DesktopRequest {
  path: string;
  method?: string;
  headers?: Array<[string, string]>;
  body?: {
    kind: "text" | "form";
    value?: string;
    entries?: Array<{
      name: string;
      value?: string;
      file?: { name: string; type: string; data: ArrayBuffer };
    }>;
  };
}

export interface DesktopResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

export interface DesktopWebViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopWebInitialPage = "entry" | "blank";

export interface DesktopWebViewState {
  id: string;
  credentialId: string;
  activePageId: string;
  pages: Array<{
    id: string;
    url: string;
    title: string;
    loading: boolean;
  }>;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  autofillMessage: string;
  error: string;
  closedReason: string;
  notice: {
    id: string;
    type: "success" | "info" | "error";
    message: string;
  } | null;
}

export interface DesktopWebViewAction {
  type: "back" | "forward" | "reload" | "navigate" | "refill" | "reset" | "new-page" | "activate-page" | "close-page" | "reorder-pages";
  url?: string;
  pageId?: string;
  orderedPageIds?: string[];
}

export interface DesktopSshSessionState {
  id: string;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
  attached: boolean;
}

export type DesktopSshSessionEvent =
  | { sessionId: string; type: "ready"; session: DesktopSshSessionState }
  | { sessionId: string; type: "output"; data: Uint8Array }
  | { sessionId: string; type: "closed"; reason: string }
  | { sessionId: string; type: "error"; message: string };

export interface DesktopSshRecording {
  id: string;
  sessionId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  status: "recording" | "completed" | "interrupted";
  sizeBytes: number;
  startedAt: string;
  endedAt?: string;
  closeReason: string;
  source: "desktop";
}

export interface DesktopLogStreamState {
  id: string;
  logId: string;
  logName: string;
  filePath: string;
  filePaths: string[];
  initialLines: number;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
}

export type DesktopLogStreamEvent =
  | { streamId: string; logId: string; type: "ready"; stream: DesktopLogStreamState }
  | { streamId: string; logId: string; type: "output" | "stderr"; data: string }
  | { streamId: string; logId: string; type: "closed"; reason: string }
  | { streamId: string; logId: string; type: "error"; message: string };

export type DesktopServiceSocketEvent =
  | { socketId: string; type: "open" }
  | { socketId: string; type: "message"; data: string | ArrayBuffer }
  | { socketId: string; type: "error"; message: string }
  | { socketId: string; type: "close"; code: number; reason: string };

export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && Boolean(window.vironDesktop);
}

export async function desktopState(): Promise<DesktopState | null> {
  const state = await (window.vironDesktop?.getState() ?? null);
  desktopAppState.value = state;
  return state;
}

export async function setDesktopTitleBarTheme(appearance: DesktopTitleBarAppearance): Promise<void> {
  if (!window.vironDesktop) return;
  await window.vironDesktop.setTitleBarTheme(appearance);
}

export function showDesktopMonitorAlertNotification(input: DesktopMonitorAlertNotification): Promise<{ shown: boolean }> {
  if (!window.vironDesktop) return Promise.resolve({ shown: false });
  return window.vironDesktop.showMonitorAlertNotification(input);
}

export function onDesktopMonitorAlertOpen(listener: (target: DesktopMonitorAlertNotification) => void): () => void {
  if (!window.vironDesktop) return () => undefined;
  return window.vironDesktop.onMonitorAlertOpen(listener);
}

export async function checkForDesktopUpdates(): Promise<DesktopUpdateCheckResult> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  return window.vironDesktop.checkForUpdates();
}

export async function openMacosLocalNetworkSettings(): Promise<void> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  await window.vironDesktop.openLocalNetworkSettings();
}

export async function selectDesktopEndpoint(endpoint: string): Promise<DesktopState> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  const result = await window.vironDesktop.setEndpoint(endpoint);
  if (!result.ok) throw new Error(result.error.message);
  desktopAppState.value = result.state;
  return result.state;
}

export async function setDesktopExecutionMode(mode: DesktopExecutionMode): Promise<DesktopState> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  const state = await window.vironDesktop.setExecutionMode(mode);
  desktopAppState.value = state;
  return state;
}

export async function setDesktopAgentEntryMode(mode: AgentEntryMode): Promise<DesktopState> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  const state = await window.vironDesktop.setAgentEntryMode(mode);
  desktopAppState.value = state;
  return state;
}

export async function desktopExecutionActivity(): Promise<DesktopExecutionActivity> {
  if (!window.vironDesktop) return { total: 0, counts: { web: 0, ssh: 0, sftp: 0, logs: 0, database: 0, redis: 0 } };
  return window.vironDesktop.getExecutionActivity();
}

export async function desktopMcpStatus(): Promise<DesktopMcpStatus | null> {
  return await (window.vironDesktop?.getMcpStatus() ?? null);
}

export async function setDesktopMcpEnabled(enabled: boolean): Promise<DesktopMcpStatus> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  return window.vironDesktop.setLocalMcpEnabled(enabled);
}

export async function setDesktopMcpApprovalMode(mode: McpApprovalMode): Promise<DesktopMcpStatus> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  return window.vironDesktop.setLocalMcpApprovalMode(mode);
}

async function publishDesktopAgentSettings(request: Promise<AgentSettingsPublic>): Promise<AgentSettingsPublic> {
  const value = await request;
  desktopAgentSettings.value = value;
  return value;
}

export function getDesktopAgentSettings(): Promise<AgentSettingsPublic> {
  return publishDesktopAgentSettings(desktopBridge().getAgentSettings());
}

export function saveDesktopAgentSettings(input: AgentSettingsInput): Promise<AgentSettingsPublic> {
  return publishDesktopAgentSettings(desktopBridge().saveAgentSettings(input));
}

export function listDesktopAgentModels(input: AgentModelListInput): Promise<AgentModelListResult> {
  return desktopBridge().listAgentModels(input);
}

export function deleteDesktopAgentSettings(): Promise<AgentSettingsPublic> {
  return publishDesktopAgentSettings(desktopBridge().deleteAgentSettings());
}

export function testDesktopAgentSettings(): Promise<AgentSettingsTestResult> {
  return desktopBridge().testAgentSettings();
}

export function readDesktopAgentSshContext(sessionId: string): Promise<AgentSshContextSnapshot> {
  return desktopBridge().readAgentSshContext(sessionId);
}

export function readDesktopAgentDatabaseContext(input: AgentDatabaseContextInput): Promise<AgentDatabaseContextSnapshot> {
  return desktopBridge().readAgentDatabaseContext(input);
}

export function executeDesktopAgentDatabaseRead(input: { connectionId: string; database: string; sql: string }): Promise<AgentDatabaseReadResult> {
  return desktopBridge().executeAgentDatabaseRead(input);
}

export function recordDesktopAgentAction(input: { action: string; target: string; summary: string }): Promise<{ recorded: true }> {
  return desktopBridge().recordAgentAction(input);
}

export function clearDesktopAgentAudit(): Promise<{ cleared: number }> {
  return desktopBridge().clearAgentAudit();
}

export function listDesktopAgentSessions(): Promise<AgentConversationListResult> {
  return desktopBridge().listAgentSessions();
}

export function getCurrentDesktopAgentSession(): Promise<AgentConversation> {
  return desktopBridge().getCurrentAgentSession();
}

export function createDesktopAgentSession(title?: string): Promise<AgentConversation> {
  return desktopBridge().createAgentSession(title);
}

export function selectDesktopAgentSession(sessionId: string): Promise<AgentConversation> {
  return desktopBridge().selectAgentSession(sessionId);
}

export function renameDesktopAgentSession(sessionId: string, title: string): Promise<AgentConversationSummary> {
  return desktopBridge().renameAgentSession({ sessionId, title });
}

export function deleteDesktopAgentSession(sessionId: string): Promise<AgentConversation> {
  return desktopBridge().deleteAgentSession(sessionId);
}

export function sendDesktopAgentChat(input: AgentChatRequest): Promise<{ runId: string; messageId: string; sessionId: string }> {
  return desktopBridge().sendAgentChat(agentChatRequestTransport(input));
}

export function respondDesktopAgentApproval(input: AgentToolApprovalResponseInput): Promise<{ accepted: boolean; runId: string; messageId: string }> {
  return desktopBridge().respondAgentApproval(input);
}

export function respondDesktopAgentWorkbenchExecution(input: AgentWorkbenchExecutionResponseInput): Promise<{ accepted: true }> {
  return desktopBridge().respondAgentWorkbenchExecution(input);
}

export function stopDesktopAgentChat(runId: string): Promise<{ stopped: boolean }> {
  return desktopBridge().stopAgentChat(runId);
}

export function stopDesktopAgentResourceRuns(input: {
  kind: "database" | "ssh";
  resourceId: string;
  executionTarget?: "desktop-local" | "server-forwarded";
}): Promise<{ stopped: number }> {
  return desktopBridge().stopAgentResourceRuns(input);
}

export function onDesktopAgentEvent(listener: (event: AgentStreamEvent) => void): () => void {
  return desktopBridge().onAgentEvent(listener);
}

export function updateDesktopAgentLauncher(state: AgentFloatingOverlayState | null): Promise<void> {
  return desktopBridge().updateAgentLauncher(state);
}

export function onDesktopAgentLauncherAction(listener: (action: AgentFloatingOverlayAction) => void): () => void {
  return desktopBridge().onAgentLauncherAction(listener);
}

export function updateDesktopConnectionQuality(state: ConnectionQualityOverlayState | null): Promise<void> {
  if (!window.vironDesktop) return Promise.resolve();
  return window.vironDesktop.updateConnectionQuality(state);
}

export function probeDesktopConnectionQualityTarget(targetId: string): Promise<number> {
  return desktopBridge().probeConnectionQualityTarget(targetId);
}

export function onDesktopConnectionQualityAction(listener: (action: ConnectionQualityOverlayAction) => void): () => void {
  if (!window.vironDesktop) return () => undefined;
  return window.vironDesktop.onConnectionQualityAction(listener);
}

export function updateDesktopActiveEnvironmentDock(state: ActiveEnvironmentDockState | null): Promise<void> {
  if (!window.vironDesktop) return Promise.resolve();
  return window.vironDesktop.updateActiveEnvironmentDock(state);
}

export function updateDesktopActiveEnvironmentDockLayout(layout: ActiveEnvironmentDockLayoutState): Promise<void> {
  if (!window.vironDesktop) return Promise.resolve();
  return window.vironDesktop.updateActiveEnvironmentDockLayout(layout);
}

export function captureDesktopRendererPreview(bounds: DesktopWebViewBounds): Promise<string> {
  return desktopBridge().captureRendererPreview(bounds);
}

export function onDesktopActiveEnvironmentDockAction(listener: (action: ActiveEnvironmentDockAction) => void): () => void {
  if (!window.vironDesktop) return () => undefined;
  return window.vironDesktop.onActiveEnvironmentDockAction(listener);
}

export function onDesktopNativeViewPointerDown(listener: () => void): () => void {
  if (!window.vironDesktop) return () => undefined;
  return window.vironDesktop.onNativeViewPointerDown(listener);
}

export function onDesktopHistoryNavigation(listener: (direction: "back" | "forward") => void): () => void {
  if (!window.vironDesktop) return () => undefined;
  return window.vironDesktop.onHistoryNavigation(listener);
}

export function onDesktopHistoryNavigationTouch(listener: (phase: "begin" | "end") => void): () => void {
  if (!window.vironDesktop) return () => undefined;
  return window.vironDesktop.onHistoryNavigationTouch(listener);
}

if (typeof window !== "undefined") {
  window.vironDesktop?.onStateChanged((state) => { desktopAppState.value = state; });
}

async function serializeBody(body: BodyInit | null | undefined): Promise<DesktopRequest["body"]> {
  if (!body) return undefined;
  if (typeof body === "string") return { kind: "text", value: body };
  if (!(body instanceof FormData)) throw new Error(tr("桌面 App 当前只支持 JSON、文本和表单请求体"));

  const entries: NonNullable<NonNullable<DesktopRequest["body"]>["entries"]> = [];
  for (const [name, value] of body.entries()) {
    if (typeof value === "string") entries.push({ name, value });
    else entries.push({
      name,
      file: { name: value.name, type: value.type, data: await value.arrayBuffer() },
    });
  }
  return { kind: "form", entries };
}

export async function desktopRequest(path: string, init: RequestInit = {}): Promise<DesktopResponse> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  const request = window.vironDesktop.request({
    path,
    method: init.method,
    headers: [...headers.entries()],
    body: await serializeBody(init.body),
  });
  if (!init.signal) return request;
  return new Promise<DesktopResponse>((resolve, reject) => {
    const abort = () => reject(init.signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    init.signal!.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => init.signal?.removeEventListener("abort", abort));
  });
}

export async function downloadApiFile(path: string, filename?: string): Promise<boolean> {
  if (window.vironDesktop) return (await window.vironDesktop.download(path, filename)).saved;
  window.location.href = path;
  return true;
}

export async function saveTextFile(filename: string, content: string): Promise<boolean> {
  if (window.vironDesktop) return (await window.vironDesktop.saveTextFile({ filename, content })).saved;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
    return true;
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export async function selectDesktopDatabaseSqlFile(): Promise<{ selected: boolean; name?: string; content?: string; filePath?: string }> {
  if (!window.vironDesktop) return { selected: false };
  return window.vironDesktop.selectDatabaseSqlFile();
}

export async function openDesktopDatabaseQueryExternally(input: { id: string; name: string; sql: string }): Promise<{ opened: true; filePath: string }> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  return window.vironDesktop.openDatabaseQueryExternally(input);
}

export async function revealDesktopDatabaseQuery(input: { id: string; name: string; sql: string }): Promise<{ revealed: true; filePath: string }> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  return window.vironDesktop.revealDatabaseQuery(input);
}

export async function revealDesktopDatabaseBackup(input: { id: string; path: string; filename: string }): Promise<{ revealed: true; filePath: string }> {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  return window.vironDesktop.revealDatabaseBackup(input);
}

function desktopBridge() {
  if (!window.vironDesktop) throw new Error(tr("当前不是 Viron 桌面 App"));
  return window.vironDesktop;
}

export function readDesktopClipboardText(): Promise<string> {
  return desktopBridge().readClipboardText();
}

export function writeDesktopClipboardText(value: string): Promise<{ written: true }> {
  return desktopBridge().writeClipboardText(value);
}

async function openingConnection<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const connectionLimitMessages = [
      "单用户最大连接数",
      "先关闭现有连接",
      tr("连接数已达上限"),
      tr("当前连接数已达到上限，请先关闭现有连接再继续"),
    ];
    if (connectionLimitMessages.some((candidate) => message.includes(candidate))) dispatchConnectionLimit(message);
    throw error;
  }
}

export function openDesktopWebView(
  credentialId: string,
  bounds: DesktopWebViewBounds,
  initialPage: DesktopWebInitialPage = "entry",
  originEnvironmentId?: string,
): Promise<DesktopWebViewState> {
  return openingConnection(desktopBridge().openWebView({ credentialId, bounds, initialPage, originEnvironmentId }));
}

export function updateDesktopWebViewBounds(id: string, bounds: DesktopWebViewBounds): Promise<DesktopWebViewState> {
  return desktopBridge().updateWebViewBounds(id, bounds);
}

export function setDesktopWebViewVisible(id: string, visible: boolean): Promise<DesktopWebViewState> {
  return desktopBridge().setWebViewVisible(id, visible);
}

export function setDesktopWebViewPreviewing(id: string, previewing: boolean): Promise<DesktopWebViewState> {
  return desktopBridge().setWebViewPreviewing(id, previewing);
}

export function captureDesktopWebView(id: string, mode: "preview" | "page" = "preview"): Promise<string> {
  return desktopBridge().captureWebView(id, mode);
}

export function desktopWebViewAction(id: string, action: DesktopWebViewAction): Promise<DesktopWebViewState> {
  return desktopBridge().webViewAction(id, action);
}

export async function closeDesktopWebView(id: string): Promise<void> {
  await desktopBridge().closeWebView(id);
}

export function onDesktopWebViewState(listener: (state: DesktopWebViewState) => void): () => void {
  return desktopBridge().onWebViewState(listener);
}

export async function updateDesktopImmersiveNavigation(state: ImmersiveNavigationState | null): Promise<void> {
  if (!window.vironDesktop) return;
  await window.vironDesktop.updateImmersiveNavigation(state ? plainImmersiveNavigationState(state) : null);
}

export function onDesktopImmersiveNavigationAction(listener: (action: ImmersiveNavigationAction) => void): () => void {
  if (!window.vironDesktop) return () => undefined;
  return window.vironDesktop.onImmersiveNavigationAction(listener);
}

export function listDesktopSshSessions(): Promise<{ items: DesktopSshSessionState[] }> {
  return desktopBridge().listSshSessions();
}

export function openDesktopSshSession(input: { connectionId: string; originEnvironmentId?: string; cols: number; rows: number }): Promise<{ session: DesktopSshSessionState; ticket: string; activeConnectionId: string }> {
  return openingConnection(desktopBridge().openSshSession(input));
}

export function issueDesktopSshTicket(sessionId: string): Promise<{ ticket: string }> {
  return desktopBridge().issueSshTicket(sessionId);
}

export function attachDesktopSshSession(sessionId: string, ticket: string): Promise<{ session: DesktopSshSessionState; output: string }> {
  return desktopBridge().attachSshSession(sessionId, ticket);
}

export function detachDesktopSshSession(sessionId: string): Promise<{ detached: boolean }> {
  return desktopBridge().detachSshSession(sessionId);
}

export function sendDesktopSshInput(sessionId: string, data: string): Promise<{ ok: boolean }> {
  return desktopBridge().sshSessionAction(sessionId, { type: "input", data });
}

export function sendDesktopSshBinary(sessionId: string, data: Uint8Array): Promise<{ ok: boolean }> {
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return desktopBridge().sshSessionAction(sessionId, { type: "binary", data: bytes });
}

export function resizeDesktopSshSession(sessionId: string, cols: number, rows: number): Promise<{ ok: boolean }> {
  return desktopBridge().sshSessionAction(sessionId, { type: "resize", cols, rows });
}

export function closeDesktopSshSession(sessionId: string): Promise<{ closed: boolean }> {
  return desktopBridge().closeSshSession(sessionId);
}

export function onDesktopSshSessionEvent(listener: (event: DesktopSshSessionEvent) => void): () => void {
  return desktopBridge().onSshSessionEvent(listener);
}

export function listDesktopSshRecordings(): Promise<{ items: DesktopSshRecording[] }> {
  return desktopBridge().listSshRecordings();
}

export function downloadDesktopSshRecording(recordingId: string): Promise<{ saved: boolean; filePath?: string }> {
  return desktopBridge().downloadSshRecording(recordingId);
}

export function deleteDesktopSshRecording(recordingId: string): Promise<{ deleted: boolean }> {
  return desktopBridge().deleteSshRecording(recordingId);
}

export function listDesktopSftp(connectionId: string, path: string): Promise<{ path: string; parentPath: string | null; items: import("./sftp").SftpItem[] }> {
  return desktopBridge().listSftp({ connectionId, path });
}

export function desktopSftpAction(input: { type: "mkdir" | "rename" | "chmod" | "delete"; connectionId: string; path: string; newPath?: string; mode?: string }): Promise<unknown> {
  return desktopBridge().sftpAction(input);
}

export function startDesktopSftpUpload(input: { connectionId: string; directory: string; filename: string }): Promise<{ uploadId: string; path: string }> {
  return desktopBridge().startSftpUpload(input);
}

export function uploadDesktopSftpChunk(uploadId: string, data: ArrayBuffer): Promise<{ accepted: boolean }> {
  return desktopBridge().uploadSftpChunk(uploadId, data);
}

export function completeDesktopSftpUpload(uploadId: string): Promise<{ path: string }> {
  return desktopBridge().completeSftpUpload(uploadId);
}

export function cancelDesktopSftpUpload(uploadId: string): Promise<{ cancelled: boolean }> {
  return desktopBridge().cancelSftpUpload(uploadId);
}

export function downloadDesktopSftp(input: { connectionId: string; path: string; filename: string }): Promise<{ saved: boolean; filePath?: string }> {
  return desktopBridge().downloadSftp(input);
}

export function desktopDroppedFilePath(file: File): string {
  return desktopBridge().droppedFilePath(file);
}

export function startDesktopSftpDrag(input: { connectionId: string; paths: string[] }): Promise<{ started: boolean }> {
  return desktopBridge().startSftpDrag(input);
}

export function listDesktopSftpTransfers(): Promise<{ items: import("./sftp").SftpTransferTask[] }> {
  return desktopBridge().listSftpTransfers();
}

export function previewDesktopSftpTransfer(input: { sourceConnectionId: string; targetConnectionId: string; sourcePath?: string; sourcePaths?: string[]; targetDirectory: string }): Promise<unknown> {
  return desktopBridge().previewSftpTransfer(input);
}

export function createDesktopSftpTransfer(input: SftpTransferCreateInput): Promise<{ task: import("./sftp").SftpTransferTask; activeConnectionId: string }> {
  return openingConnection(desktopBridge().createSftpTransfer(sftpTransferCreateSnapshot(input)));
}

export function cancelDesktopSftpTransfer(taskId: string): Promise<{ cancelled: boolean }> {
  return desktopBridge().cancelSftpTransfer(taskId);
}

export function retryDesktopSftpTransfer(taskId: string, originEnvironmentId?: string): Promise<{ task: import("./sftp").SftpTransferTask; activeConnectionId: string }> {
  return openingConnection(desktopBridge().retrySftpTransfer({ taskId, originEnvironmentId }));
}

export function openDesktopLogStream(input: { environmentId: string; logId: string; initialLines: number }): Promise<{ stream: DesktopLogStreamState; activeConnectionId: string }> {
  return openingConnection(desktopBridge().openLogStream(input));
}

export function closeDesktopLogStream(streamId: string): Promise<{ closed: boolean }> {
  return desktopBridge().closeLogStream(streamId);
}

export function onDesktopLogStreamEvent(listener: (event: DesktopLogStreamEvent) => void): () => void {
  return desktopBridge().onLogStreamEvent(listener);
}

export function openDesktopServiceSocket(path: string, params: Record<string, string>): Promise<{ id: string }> {
  return desktopBridge().openServiceSocket(path, params);
}

export function sendDesktopServiceSocket(id: string, data: string | ArrayBuffer): Promise<{ sent: boolean }> {
  return desktopBridge().sendServiceSocket(id, data);
}

export function closeDesktopServiceSocket(id: string): Promise<{ closed: boolean }> {
  return desktopBridge().closeServiceSocket(id);
}

export function onDesktopServiceSocketEvent(listener: (event: DesktopServiceSocketEvent) => void): () => void {
  return desktopBridge().onServiceSocketEvent(listener);
}
