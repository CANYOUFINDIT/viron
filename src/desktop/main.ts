import {
  currentDesktopLanguage,
  initializeDesktopLanguage,
  setDesktopLanguage,
  translate as tr,
} from "./i18n.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { WebSocket as NodeWebSocket } from "ws";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification as ElectronNotification,
  screen as electronScreen,
  shell,
  WebContentsView,
  type Rectangle,
} from "electron";
import { EndpointValidationError, normalizeEndpoint, validateEndpoint } from "./endpoint.js";
import {
  DesktopSftpRuntime,
  desktopSftpRemoteConnectionIds,
  type DesktopSftpTransferOptions,
} from "./sftp-runtime.js";
import { DesktopLogRuntime } from "./log-runtime.js";
import {
  DesktopDatabaseRuntime,
  isDesktopDatabaseExecutionPath,
} from "./database-runtime.js";
import {
  DesktopRedisRuntime,
  isDesktopRedisExecutionPath,
} from "./redis-runtime.js";
import {
  DesktopDatabaseOperationRuntime,
  isDesktopDatabaseDownloadPath,
  isDesktopDatabaseOperationPath,
} from "./database-operations-runtime.js";
import { DatabaseArtifactFileRuntime } from "./database-artifact-files.js";
import {
  DesktopConnectionInspectionRuntime,
  isDesktopConnectionInspectionPath,
  type DesktopInspectionConnection,
} from "./connection-inspection-runtime.js";
import {
  DesktopSshCommandAbortedError,
  DesktopSshRuntime,
  closeDesktopSshConnectionPool,
  connectDesktopSshConnection,
  executeDesktopSshCommandOnConnection,
  type DesktopSshCommandResult,
  type DesktopSshContext,
} from "./ssh-runtime.js";
import { sshCommandRiskLevel } from "../shared/ssh-command-risk.js";
import type { DesktopExecutionMode } from "../shared/execution-mode.js";
import {
  desktopTitleBarOverlay,
  isDesktopTitleBarAppearance,
} from "../shared/desktop-titlebar.js";
import { DesktopUpdater, shouldBlockLaunchForActiveUpdate } from "./updater.js";
import type { ImmersiveNavigationAction, ImmersiveNavigationState } from "../shared/immersive-navigation.js";
import {
  effectiveShortcutBindings,
  sanitizeShortcutOverrides,
  shortcutActionForInput,
  shortcutConflict,
  shortcutValidationError,
  type ShortcutActionId,
} from "../shared/keyboard-shortcuts.js";
import {
  agentDatabaseReadResult,
  agentEntryMode,
  agentTransportValue,
  type AgentChatRequest,
  type AgentDatabaseContextInput,
  type AgentModelListInput,
  type AgentSettingsInput,
  type AgentToolApprovalResponseInput,
  type AgentWorkbenchExecutionRequest,
  type AgentWorkbenchExecutionResponseInput,
  type AgentWorkbenchExecutionResult,
} from "../shared/agent.js";
import { summarizeAgentSshOutput } from "../shared/agent-ssh-context.js";
import {
  agentFloatingOverlayInteractionState,
  type AgentFloatingOverlayAction,
  type AgentFloatingOverlayState,
} from "../shared/agent-floating-overlay.js";
import {
  isAgentHostAction,
  isAgentHostState,
  type AgentHostAction,
  type AgentHostActionResult,
  type AgentHostState,
} from "../shared/agent-host.js";
import {
  CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT,
  CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT,
  CONNECTION_QUALITY_PANEL_WIDTH,
  type ConnectionQualityOverlayAction,
  type ConnectionQualityOverlayState,
  type ConnectionQualityTargetAddress,
} from "../shared/connection-quality.js";
import { probeDesktopTcpTarget } from "./connection-quality-probe.js";
import {
  activeEnvironmentDockCardSize,
  activeEnvironmentDockLayoutSnapshot,
  activeEnvironmentDockPanelSize,
  ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS,
  ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS,
  type ActiveEnvironmentDockAction,
  type ActiveEnvironmentDockDragAction,
  type ActiveEnvironmentDockLayoutState,
  type ActiveEnvironmentDockState,
} from "../shared/active-environment-dock.js";
import { DesktopAgentAuditStore } from "./agent-audit.js";
import { DesktopAgentSettingsStore } from "./agent-settings.js";
import { DesktopAgentSessionStore } from "./agent-session-store.js";
import { listAgentModels } from "./agent-models.js";
import { DesktopAgentRuntime } from "./agent-runtime.js";
import { agentRuntimeScopeMatches, type AgentRuntimeScope } from "./agent-diagnostic-session.js";
import { sanitizeAgentDatabaseInput } from "./agent-database-context.js";
import { DesktopMcpBroker } from "./mcp-broker.js";
import { desktopMcpOperationUrlAllowed } from "./mcp-security.js";
import { createVironMcpCompactGateway, resolveVironMcpApiRequest, resolveVironMcpApprovedRequest } from "../shared/mcp-tools.js";
import type { McpApiRequest, McpApiResponse, VironMcpOperationPublic } from "../shared/mcp-protocol.js";
import {
  mcpApprovalMode,
  VIRON_MCP_APPROVAL_MODE_HEADER,
  type DesktopMcpStatus,
} from "../shared/mcp-settings.js";
import {
  currentAgentEntryMode,
  readState,
  sendShortcutAction,
  shortcutPreferences,
  writeState,
} from "./app-state.js";
import {
  activeEndpoint,
  currentExecutionMode,
  endpointStateKey,
  executionScopeForEndpoint,
  setActiveEndpoint,
} from "./endpoint-context.js";
import {
  endpointSession,
} from "./device-session.js";
import { mainWindow, setMainWindow } from "./window-host.js";
import { installApplicationMenu } from "./app-menu.js";
import {
  trustedAgentChatSender,
  trustedMainWindowSender,
  trustedSender,
} from "./ipc-guards.js";
import {
  activeEnvironmentDockWindow,
  activeEnvironmentDockPointerInside,
  activeEnvironmentDockState,
  handleActiveEnvironmentDockDrag,
  keepActiveEnvironmentDockExpanded,
  layoutActiveEnvironmentDockWindow,
  scheduleActiveEnvironmentDockPointerTracking,
  stopActiveEnvironmentDockPointerTracking,
  updateActiveEnvironmentDockLayoutWindow,
  updateActiveEnvironmentDockWindow,
} from "./overlays/active-environment-dock-window.js";
import {
  agentChatWindow,
  agentChatHostState,
  requestAgentHostAction,
  sendToAgentChat,
  setAgentChatChromeVisible,
  setAgentChatIgnoreMouse,
  setAgentChatNativeOverlay,
  settleAgentHostAction,
  updateAgentChatHost,
  layoutAgentChatWindow,
} from "./overlays/agent-chat-window.js";
import {
  agentLauncherVisualWindow,
  agentLauncherWindow,
  layoutAgentLauncherWindow,
  updateAgentLauncherWindow,
} from "./overlays/agent-launcher-window.js";
import {
  connectionQualityVisualWindow,
  connectionQualityWindow,
  layoutConnectionQualityWindow,
  updateConnectionQualityWindow,
} from "./overlays/connection-quality-window.js";
import {
  handleImmersiveNavigationDrag,
  immersiveNavigationWindow,
  immersiveNavigationViewport,
  layoutImmersiveNavigationWindow,
  sendImmersiveNavigationAction,
  updateImmersiveNavigationWindow,
} from "./overlays/immersive-navigation-window.js";
import {
  desktopAgentRuntime,
  desktopAuditSourceContext,
  desktopConnectionInspectionRuntime,
  desktopDatabaseOperationRuntime,
  desktopDatabaseRuntime,
  desktopDeviceAuthorizationContext,
  desktopLogRuntime,
  desktopMcpApprovalModeContext,
  desktopRedisRuntime,
  desktopSftpRuntime,
  desktopSshRuntime,
  initializeDesktopRuntimeContext,
  setDesktopAgentRuntime,
} from "./desktop-runtime-context.js";
import {
  agentRuntimeScope,
  closeAllServiceSockets,
  closeDesktopExecution,
  closeServerForwardingRuntime,
  currentAgentRuntimeScope,
  currentAgentSettingsScope,
  currentDesktopSshContext,
  currentDeviceAuthorization,
  emptyExecutionActivity,
  executionRuntimeApiMissing,
  localDatabaseCredential,
  localRedisCredential,
  localSshCredential,
  openServiceSocket,
  releaseDesktopRuntimeReservation,
  reportDesktopConnectionInspection,
  reportDesktopDatabaseExecution,
  reportDesktopRedisExecution,
  reportDesktopSshExecution,
  reserveDesktopRuntime,
  serviceSockets,
  signedDesktopOperation,
  syncDesktopRuntimeConnections,
  touchDesktopDatabaseRequest,
  touchDesktopRedisRequest,
  trackDesktopRuntime,
  type ExecutionActivity,
} from "./execution-router.js";
import {
  endpointFetch,
  endpointJson,
  suggestedFilename,
  type DesktopRequest,
} from "./http-proxy.js";
import {
  actOnDesktopWebCredential,
  activeDesktopWebPage,
  captureDesktopRendererPreview,
  captureDesktopWebViewPreview,
  captureWebContentsPreview,
  closeAllDesktopWebViews,
  closeDesktopWebView,
  controlDesktopWebCredential,
  desktopWebMutationContext,
  desktopWebViews,
  handleDesktopWebViewAction,
  inspectDesktopWebElement,
  layoutDesktopWebViewPages,
  localWebView,
  openDesktopWebView,
  reconcileDesktopWebMutation,
  resetDesktopWebView,
  resetDesktopWebViews,
  snapshotDesktopWebCredential,
  uploadDesktopWebCredential,
  webViewBounds,
  webViewState,
  type DesktopMcpWebAction,
  type DesktopMcpWebControl,
  type DesktopWebInitialPage,
  type DesktopWebViewBounds,
  type ManagedDesktopWebView,
} from "./web-view-runtime.js";

if (process.platform === "darwin") app.commandLine.appendSwitch("use-mock-keychain");

const gotTheLock = process.argv.includes("--smoke-test") || app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

function developmentApplicationIcon(): string | undefined {
  if (app.isPackaged) return undefined;
  const icon = join(app.getAppPath(), "design", "logo", "viron-logo.png");
  return existsSync(icon) ? icon : undefined;
}

interface DesktopEnvironmentLog {
  id: string;
  sshConnectionId: string;
  name: string;
  filePaths: string[];
  connectionAvailable: boolean;
}

if (gotTheLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}
let desktopUpdater: DesktopUpdater;
let desktopAgentSettingsStore: DesktopAgentSettingsStore;
let desktopAgentSessionStore: DesktopAgentSessionStore;
let desktopAgentAuditStore: DesktopAgentAuditStore;
const pendingAgentWorkbenchExecutions = new Map<string, {
  request: AgentWorkbenchExecutionRequest;
  resolve: (result: AgentWorkbenchExecutionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal;
  abortListener: () => void;
}>();
let desktopMcpBroker: DesktopMcpBroker;
let desktopMcpLastError: string | null = null;
const desktopMcpOperationWindows = new Set<BrowserWindow>();
const desktopMcpOperationIds = new Set<string>();
const desktopMonitorNotifications = new Set<Electron.Notification>();
const desktopMcpPendingOperations = new Map<string, {
  lease: string;
  request: McpApiRequest;
  response?: McpApiResponse;
  running?: Promise<McpApiResponse>;
}>();
let desktopRuntimeHeartbeat: NodeJS.Timeout | null = null;
let shortcutCaptureActive = false;

function localMcpLauncherPath(): string {
  return process.platform === "win32"
    ? join(dirname(process.execPath), "viron-mcp.cmd")
    : join(dirname(process.execPath), "viron-mcp");
}

function localMcpStatus(): DesktopMcpStatus {
  const broker = desktopMcpBroker.status();
  return {
    enabled: readState().localMcpEnabled === true,
    approvalMode: mcpApprovalMode(readState().localMcpApprovalMode),
    running: broker.running,
    transport: broker.transport,
    address: broker.address,
    launcherPath: localMcpLauncherPath(),
    clients: broker.clients,
    lastError: desktopMcpLastError,
  };
}

function publishDesktopAppState(next = publicState()): typeof next {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:state-changed", next);
  sendToAgentChat("viron:state-changed", next);
  return next;
}

function publicState() {
  const state = readState();
  return {
    appVersion: app.getVersion(),
    language: currentDesktopLanguage(),
    agentEntryMode: agentEntryMode(state.agentEntryMode),
    recentEndpoint: state.recentEndpoint ?? null,
    endpoint: activeEndpoint?.endpoint ?? null,
    protocolVersion: activeEndpoint?.protocolVersion ?? null,
    capabilities: activeEndpoint?.capabilities ?? null,
    executionMode: currentExecutionMode(),
  };
}

async function openDesktopMcpOperationWindow(actionUrl: string): Promise<void> {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  const target = new URL(actionUrl);
  if (!desktopMcpOperationUrlAllowed(activeEndpoint.endpoint, target.href)) {
    throw new Error(tr("Viron MCP Operation 页面地址无效"));
  }
  const existing = [...desktopMcpOperationWindows].find((window) => !window.isDestroyed() && window.webContents.getURL() === target.href);
  if (existing) {
    existing.show();
    existing.focus();
    return;
  }
  const operationWindow = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 520,
    minHeight: 480,
    show: false,
    parent: mainWindow ?? undefined,
    modal: false,
    closable: true,
    title: tr("Viron 安全操作"),
    backgroundColor: "#edf1f0",
    webPreferences: {
      session: activeEndpoint.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  desktopMcpOperationWindows.add(operationWindow);
  operationWindow.setMenuBarVisibility(false);
  operationWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  operationWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  operationWindow.webContents.on("will-navigate", (event, url) => {
    if (desktopMcpOperationUrlAllowed(activeEndpoint!.endpoint, url, true)) return;
    event.preventDefault();
  });
  const operationId = target.pathname.split("/").at(-1)!;
  let closeWithoutCancelling = false;
  let checkingStatus = false;
  let statusRefreshQueued = false;
  const closeWindow = () => {
    if (operationWindow.isDestroyed()) return;
    closeWithoutCancelling = true;
    operationWindow.close();
  };
  const refreshOperationStatus = (queueIfBusy = false) => {
    if (checkingStatus) {
      statusRefreshQueued ||= queueIfBusy;
      return;
    }
    if (operationWindow.isDestroyed()) return;
    checkingStatus = true;
    void endpointJson<VironMcpOperationPublic>(`/api/v1/mcp/operations/${operationId}`)
      .then((operation) => {
        if (operation.status === "approved") {
          const pending = desktopMcpPendingOperations.get(operationId);
          if (pending) {
            pending.running ??= completeDesktopMcpOperation(operationId, pending).finally(() => { pending.running = undefined; });
            void pending.running.catch(() => undefined);
          }
          closeWindow();
        } else if (["completed", "failed", "cancelled", "expired"].includes(operation.status)) {
          desktopMcpPendingOperations.delete(operationId);
          desktopMcpOperationIds.delete(operationId);
          closeWindow();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checkingStatus = false;
        if (!statusRefreshQueued) return;
        statusRefreshQueued = false;
        refreshOperationStatus();
      });
  };
  const statusTimer = setInterval(() => refreshOperationStatus(), 750);
  operationWindow.webContents.on("did-navigate", (_event, url) => {
    try {
      if (/\/(?:submit|cancel)$/.test(new URL(url).pathname)) refreshOperationStatus(true);
    } catch {
      // Navigation is already constrained by desktopMcpOperationUrlAllowed.
    }
  });
  operationWindow.once("ready-to-show", () => operationWindow.show());
  operationWindow.once("closed", () => {
    clearInterval(statusTimer);
    desktopMcpOperationWindows.delete(operationWindow);
    if (closeWithoutCancelling || !desktopMcpOperationIds.has(operationId)) return;
    desktopMcpOperationIds.delete(operationId);
    desktopMcpPendingOperations.delete(operationId);
    void endpointJson(`/api/v1/mcp/operations/${operationId}`, { method: "DELETE" }).catch(() => undefined);
  });
  await operationWindow.loadURL(target.href);
}

async function closeDesktopMcpOperations(cancelRemote = true): Promise<void> {
  const operationIds = [...desktopMcpOperationIds];
  desktopMcpOperationIds.clear();
  desktopMcpPendingOperations.clear();
  for (const operationWindow of [...desktopMcpOperationWindows]) {
    if (!operationWindow.isDestroyed()) operationWindow.destroy();
  }
  desktopMcpOperationWindows.clear();
  if (!cancelRemote || !activeEndpoint) return;
  await Promise.all(operationIds.map((operationId) => endpointJson(`/api/v1/mcp/operations/${operationId}`, { method: "DELETE" }).catch(() => undefined)));
}

function mcpRequestPath(input: McpApiRequest): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") query.set(name, String(value));
  }
  return `${input.path}${query.size ? `?${query.toString()}` : ""}`;
}

function mcpDesktopRequest(input: McpApiRequest): DesktopRequest {
  const formEntries = input.form ? [
    ...Object.entries(input.form.fields ?? {}).map(([name, value]) => ({ name, value })),
    ...(input.form.files ?? []).map((file) => {
      const data = Buffer.from(file.contentBase64, "base64");
      return {
        name: file.fieldName,
        file: {
          name: file.filename,
          type: file.contentType,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        },
      };
    }),
  ] : undefined;
  return {
    path: mcpRequestPath(input),
    method: input.method,
    headers: input.form ? undefined : input.body === undefined ? undefined : [["content-type", "application/json"]],
    body: input.form ? { kind: "form", entries: formEntries } : input.body === undefined ? undefined : { kind: "text", value: JSON.stringify(input.body) },
  };
}

function mcpFormFile(input: McpApiRequest): { name: string; type: string; data: Buffer } {
  const file = input.form?.files?.[0];
  if (!file) throw new Error(tr("MCP 文件请求缺少文件内容"));
  return { name: file.filename, type: file.contentType, data: Buffer.from(file.contentBase64, "base64") };
}

function isDesktopLocalMcpExecutionPath(path: string): boolean {
  const pathname = new URL(path, "http://desktop.local").pathname;
  return isDesktopConnectionInspectionPath(path)
    || isDesktopDatabaseExecutionPath(path)
    || isDesktopDatabaseOperationPath(path)
    || isDesktopDatabaseDownloadPath(path)
    || isDesktopRedisExecutionPath(path)
    || /^\/api\/v1\/mcp\/ssh-connections\/[0-9a-f-]+\/commands$/i.test(pathname)
    || /^\/api\/v1\/ssh-connections\/[0-9a-f-]+\/sftp(?:\/download)?$/i.test(pathname)
    || /^\/api\/v1\/sftp-transfers(?:\/preview|\/[0-9a-f-]+)?$/i.test(pathname)
    || /^\/api\/v1\/mcp\/environment-logs\/[0-9a-f-]+\/snapshot$/i.test(pathname)
    || /^\/api\/v1\/mcp\/web-credentials\/[0-9a-f-]+\/snapshot$/i.test(pathname)
    || /^\/api\/v1\/ssh-recordings(?:\/[0-9a-f-]+(?:\/download)?)?$/i.test(pathname);
}

function boundedDesktopSshBatchResult(result: DesktopSshCommandResult, maxBytes: number): DesktopSshCommandResult {
  const stdout = Buffer.from(result.stdout, "utf8");
  const boundedStdout = stdout.subarray(0, Math.max(0, maxBytes));
  const remaining = Math.max(0, maxBytes - boundedStdout.length);
  const stderr = Buffer.from(result.stderr, "utf8");
  const boundedStderr = stderr.subarray(0, remaining);
  return {
    ...result,
    stdout: boundedStdout.toString("utf8"),
    stderr: boundedStderr.toString("utf8"),
    truncated: result.truncated || boundedStdout.length < stdout.length || boundedStderr.length < stderr.length,
  };
}

async function executeDesktopMcpApprovedRequest(input: McpApiRequest): Promise<McpApiResponse> {
  if (!desktopDeviceAuthorizationContext.getStore()) {
    const authorization = await currentDeviceAuthorization();
    return desktopDeviceAuthorizationContext.run(authorization, () => executeDesktopMcpApprovedRequest(input));
  }
  return desktopAuditSourceContext.run("mcp", async () => {
    const request = mcpDesktopRequest(input);
    const path = request.path;
    try {
      const sshCommand = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/ssh-connections\/([0-9a-f-]+)\/command$/i);
      if (sshCommand && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.ssh) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SSH 能力，MCP 不会回退到服务端执行"));
        const body = input.body as { command: string; timeoutMs: number; maxBytes: number };
        const loaded = await connectDesktopSshConnection(sshCommand[1], await currentDesktopSshContext(), localSshCredential);
        try {
          return mcpJsonResponse(200, await executeDesktopSshCommandOnConnection(loaded.connected, body.command, { timeoutMs: body.timeoutMs, maxBytes: body.maxBytes }));
        } finally {
          loaded.connected.close();
        }
      }
      if (isDesktopDatabaseExecutionPath(path)) {
        if (!activeEndpoint?.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
        const context = await currentDesktopSshContext();
        await touchDesktopDatabaseRequest(path, context);
        return desktopResponseToMcp(await desktopDatabaseRuntime.handle(request, context));
      }
      if (isDesktopDatabaseOperationPath(path)) {
        if (!activeEndpoint?.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
        return desktopResponseToMcp(await desktopDatabaseOperationRuntime.handle(request, await currentDesktopSshContext()));
      }
      if (isDesktopRedisExecutionPath(path)) {
        if (!activeEndpoint?.capabilities.desktopLocal?.redis) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Redis 能力，MCP 不会回退到服务端执行"));
        return desktopResponseToMcp(await desktopRedisRuntime.handle(request, await currentDesktopSshContext()));
      }
      const url = new URL(path, "http://desktop.local");
      const sftp = url.pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp\/(mkdir|rename|chmod)$/i);
      if (sftp && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        const body = input.body as { path: string; newPath?: string; mode?: string };
        if (sftp[2] === "mkdir") return mcpJsonResponse(201, await desktopSftpRuntime.mkdir(sftp[1], body.path));
        if (sftp[2] === "rename") return mcpJsonResponse(200, await desktopSftpRuntime.rename(sftp[1], body.path, body.newPath ?? ""));
        await desktopSftpRuntime.chmod(sftp[1], body.path, body.mode ?? "");
        return mcpJsonResponse(200, { ok: true });
      }
      const sftpDelete = url.pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp$/i);
      if (sftpDelete && input.method === "DELETE") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        await desktopSftpRuntime.delete(sftpDelete[1], String((input.body as { path?: unknown }).path ?? ""));
        return mcpJsonResponse(204, null);
      }
      if (url.pathname === "/api/v1/sftp-transfers" && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(201, { task: await desktopSftpRuntime.create(await currentDesktopSshContext(), input.body as DesktopSftpTransferOptions) });
      }
      const sftpUpload = url.pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp\/upload$/i);
      if (sftpUpload && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        const file = mcpFormFile(input);
        const context = await currentDesktopSshContext();
        const started = await desktopSftpRuntime.startUpload(sftpUpload[1], url.searchParams.get("path") ?? "/", file.name, context);
        try {
          await desktopSftpRuntime.uploadChunk(started.uploadId, context, file.data);
          return mcpJsonResponse(201, await desktopSftpRuntime.completeUpload(started.uploadId, context));
        } catch (error) {
          try { desktopSftpRuntime.cancelUpload(started.uploadId, context); } catch { /* Upload may already be closed. */ }
          throw error;
        }
      }
      const sftpRetry = url.pathname.match(/^\/api\/v1\/sftp-transfers\/([0-9a-f-]+)\/retry$/i);
      if (sftpRetry && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(201, { task: await desktopSftpRuntime.retryTransfer(sftpRetry[1], await currentDesktopSshContext()) });
      }
      const webAction = url.pathname.match(/^\/api\/v1\/mcp\/web-credentials\/([0-9a-f-]+)\/action$/i);
      if (webAction && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(200, await actOnDesktopWebCredential(webAction[1], input.body as DesktopMcpWebAction));
      }
      const webControl = url.pathname.match(/^\/api\/v1\/mcp\/web-credentials\/([0-9a-f-]+)\/control$/i);
      if (webControl && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(200, await controlDesktopWebCredential(webControl[1], input.body as DesktopMcpWebControl));
      }
      const webUpload = url.pathname.match(/^\/api\/v1\/web-credentials\/([0-9a-f-]+)\/view\/upload$/i);
      if (webUpload && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
        const file = mcpFormFile(input);
        return mcpJsonResponse(200, await uploadDesktopWebCredential(webUpload[1], file.name, file.data));
      }
      throw new Error(tr("当前本机 MCP Operation 没有对应的受控 Runtime"));
    } catch (error) {
      return mcpJsonResponse(502, { error: "DESKTOP_MCP_OPERATION_FAILED", message: error instanceof Error ? error.message : tr("本机 MCP Operation 执行失败") });
    }
  });
}

async function completeDesktopMcpOperation(operationId: string, pending: NonNullable<ReturnType<typeof desktopMcpPendingOperations.get>>): Promise<McpApiResponse> {
  pending.response ??= await executeDesktopMcpApprovedRequest(pending.request);
  const operation = await endpointJson<VironMcpOperationPublic>(`/api/v1/mcp/operations/${operationId}/desktop-result`, {
    method: "POST",
    body: { lease: pending.lease, response: pending.response },
  });
  desktopMcpPendingOperations.delete(operationId);
  desktopMcpOperationIds.delete(operationId);
  return mcpJsonResponse(200, operation);
}

async function handleDesktopMcpOperationResponse(toolName: string, arguments_: Record<string, unknown>, response: McpApiResponse): Promise<McpApiResponse> {
  const data = response.data as Partial<VironMcpOperationPublic> | null;
  if (response.status < 400 && data?.operationId && ["awaiting_purpose", "pending", "approved"].includes(String(data.status))) {
    desktopMcpOperationIds.add(data.operationId);
    const leaseHeader = response.headers["x-viron-mcp-desktop-lease"];
    const lease = Array.isArray(leaseHeader) ? leaseHeader[0] : leaseHeader;
    if (lease) {
      desktopMcpPendingOperations.set(data.operationId, {
        lease,
        request: resolveVironMcpApprovedRequest(toolName, arguments_),
      });
    }
    if (data.status === "awaiting_purpose") return response;
    if (data.status === "pending") {
      if (!data.actionUrl) throw new Error(tr("Viron Operation 缺少审批页面地址"));
      await openDesktopMcpOperationWindow(data.actionUrl);
      return response;
    }
    const pending = desktopMcpPendingOperations.get(data.operationId);
    if (!pending) throw new Error(tr("本机 Operation 缺少当前 App 启动实例的执行租约，请重新创建 Operation"));
    pending.running ??= completeDesktopMcpOperation(data.operationId, pending).finally(() => { pending.running = undefined; });
    return pending.running;
  }
  if (toolName === "viron_operation_get" && response.status < 400 && data?.operationId && data.status === "approved") {
    const pending = desktopMcpPendingOperations.get(data.operationId);
    if (!pending) throw new Error(tr("本机 Operation 缺少当前 App 启动实例的执行租约，请重新创建 Operation"));
    pending.running ??= completeDesktopMcpOperation(data.operationId, pending).finally(() => { pending.running = undefined; });
    return pending.running;
  }
  if (toolName === "viron_operation_cancel" && data?.operationId) desktopMcpPendingOperations.delete(data.operationId);
  if (data?.operationId && ["completed", "failed", "cancelled", "expired"].includes(String(data.status))) desktopMcpOperationIds.delete(data.operationId);
  return response;
}

async function invokeDesktopMcpTool(toolName: string, arguments_: Record<string, unknown>): Promise<McpApiResponse> {
  if (!activeEndpoint) throw new Error(tr("请先在 Viron App 中验证 Endpoint"));
  const request = resolveVironMcpApiRequest(toolName, arguments_);
  if (request.workspace) {
    const context = await currentDesktopSshContext();
    const currentWorkspace = context.workspaceType === "personal" ? "personal" : `organization:${context.workspaceId}`;
    if (request.workspace !== currentWorkspace) {
      throw new Error(tr("本机 MCP 只能使用 Viron App 当前工作空间（当前：{{0}}，请求：{{1}}）", [currentWorkspace, request.workspace]));
    }
  }
  const path = mcpRequestPath(request);
  const desktopRequest = mcpDesktopRequest(request);
  if (currentExecutionMode() === "local" && isDesktopLocalMcpExecutionPath(path) && !desktopDeviceAuthorizationContext.getStore()) {
    const authorization = await currentDeviceAuthorization();
    const source = desktopAuditSourceContext.getStore() ?? "mcp";
    return desktopDeviceAuthorizationContext.run(authorization, () => desktopAuditSourceContext.run(source, () => invokeDesktopMcpTool(toolName, arguments_)));
  }
  if (currentExecutionMode() === "local") {
    const sshBatch = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/ssh-connections\/([0-9a-f-]+)\/commands$/i);
    if (sshBatch && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.ssh) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SSH 能力，MCP 不会回退到服务端执行"));
      const body = request.body as { commands: string[]; timeoutMs: number; maxBytes: number };
      if (body.commands.some((command) => sshCommandRiskLevel(command) !== "low")) {
        return mcpJsonResponse(400, { error: "SSH_BATCH_NOT_READ_ONLY", message: tr("SSH 批量读取只允许可证明为只读的命令") });
      }
      const context = await currentDesktopSshContext();
      const started = Date.now();
      const acquireStarted = Date.now();
      const loaded = await connectDesktopSshConnection(sshBatch[1], context, localSshCredential);
      const transportAcquireDurationMs = Date.now() - acquireStarted;
      const items = [];
      let remainingBytes = body.maxBytes;
      try {
        for (let index = 0; index < body.commands.length; index += 1) {
          if (remainingBytes <= 0) {
            items.push({ index, ok: false, error: tr("SSH 批量响应已达到总输出限制") });
            continue;
          }
          try {
            const result = boundedDesktopSshBatchResult(await executeDesktopSshCommandOnConnection(
              loaded.connected,
              body.commands[index],
              { timeoutMs: body.timeoutMs, maxBytes: Math.max(1024, remainingBytes) },
            ), remainingBytes);
            remainingBytes -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
            items.push({ index, ok: true, ...result });
          } catch (error) {
            items.push({ index, ok: false, error: error instanceof Error ? error.message : tr("SSH 命令执行失败") });
          }
        }
      } finally {
        loaded.connected.close();
      }
      const durationMs = Date.now() - started;
      await reportDesktopSshExecution({
        operationId: randomUUID(),
        connectionId: sshBatch[1],
        action: "commands_read_batch",
        summary: tr("本机批量执行 {{0}} 条 SSH 只读命令", [body.commands.length]),
        details: {
          commandCount: body.commands.length,
          failedCount: items.filter((item) => !item.ok).length,
          outputBytes: body.maxBytes - remainingBytes,
          durationMs,
          transportAcquireDurationMs,
          transportReused: loaded.reused,
        },
      }, context);
      return mcpJsonResponse(200, {
        items,
        durationMs,
        outputBytes: body.maxBytes - remainingBytes,
        reusedConnection: body.commands.length > 1,
        transportReused: loaded.reused,
        transportAcquireDurationMs,
      });
    }
    if (isDesktopConnectionInspectionPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.inspection) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机连接巡检能力，MCP 不会回退到服务端执行"));
      return desktopResponseToMcp(await desktopConnectionInspectionRuntime.handle(desktopRequest, await currentDesktopSshContext()));
    }
    if (isDesktopDatabaseExecutionPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
      const context = await currentDesktopSshContext();
      await touchDesktopDatabaseRequest(path, context);
      return desktopResponseToMcp(await desktopDatabaseRuntime.handle(desktopRequest, context));
    }
    if (isDesktopDatabaseOperationPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
      return desktopResponseToMcp(await desktopDatabaseOperationRuntime.handle(desktopRequest, await currentDesktopSshContext()));
    }
    if (isDesktopDatabaseDownloadPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
      const download = await desktopDatabaseOperationRuntime.download(path, await currentDesktopSshContext());
      return mcpJsonResponse(200, {
        filename: download.filename,
        contentType: download.contentType,
        size: download.data.length,
        contentBase64: download.data.toString("base64"),
      });
    }
    if (isDesktopRedisExecutionPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.redis) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Redis 能力，MCP 不会回退到服务端执行"));
      return desktopResponseToMcp(await desktopRedisRuntime.handle(desktopRequest, await currentDesktopSshContext()));
    }
    const sftpList = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp$/i);
    if (sftpList && (request.method ?? "GET") === "GET") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      return mcpJsonResponse(200, await desktopSftpRuntime.list(sftpList[1], new URL(path, "http://desktop.local").searchParams.get("path") ?? "/"));
    }
    if (path === "/api/v1/sftp-transfers") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      return mcpJsonResponse(200, { items: desktopSftpRuntime.listTransfers(await currentDesktopSshContext()) });
    }
    if (path === "/api/v1/sftp-transfers/preview" && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      const body = request.body as Omit<DesktopSftpTransferOptions, "conflict">;
      return mcpJsonResponse(200, await desktopSftpRuntime.preview(body));
    }
    const sftpDownload = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp\/download$/i);
    if (sftpDownload && (request.method ?? "GET") === "GET") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      const url = new URL(path, "http://desktop.local");
      const download = await desktopSftpRuntime.download(sftpDownload[1], url.searchParams.get("path") ?? "/");
      return mcpJsonResponse(200, {
        filename: download.filename,
        contentType: "application/octet-stream",
        size: download.data.length,
        contentBase64: download.data.toString("base64"),
      });
    }
    const sftpTransfer = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/sftp-transfers\/([0-9a-f-]+)$/i);
    if (sftpTransfer && request.method === "DELETE") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      desktopSftpRuntime.cancelTransfer(sftpTransfer[1], await currentDesktopSshContext());
      return mcpJsonResponse(204, null);
    }
    const logSnapshot = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/environment-logs\/([0-9a-f-]+)\/snapshot$/i);
    if (logSnapshot && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.logs) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机日志能力，MCP 不会回退到服务端执行"));
      const body = request.body as { initialLines: number; maxBytes: number };
      const response = await endpointJson<{ items: DesktopEnvironmentLog[] }>(`/api/v1/environments/${encodeURIComponent(await environmentIdForLog(logSnapshot[1]))}/logs`);
      const log = response.items.find((item) => item.id === logSnapshot[1]);
      if (!log || !log.connectionAvailable) throw new Error(tr("日志配置不存在或关联 SSH 连接不可用"));
      return mcpJsonResponse(200, await desktopLogRuntime.snapshot({ logId: log.id, logName: log.name, sshConnectionId: log.sshConnectionId, filePaths: log.filePaths, initialLines: body.initialLines }, body.maxBytes));
    }
    const webSnapshot = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/web-credentials\/([0-9a-f-]+)\/snapshot$/i);
    if (webSnapshot && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
      const body = request.body as { width: number; height: number; maxTextChars: number };
      return mcpJsonResponse(200, await snapshotDesktopWebCredential(webSnapshot[1], body.width, body.height, body.maxTextChars));
    }
    const webReset = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/web-credentials\/([0-9a-f-]+)\/view\/reset$/i);
    if (webReset && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
      const views = [...desktopWebViews.values()].filter((view) => view.credentialId === webReset[1] && !view.closing);
      if (views.length) await resetDesktopWebViews(views);
      return mcpJsonResponse(200, { ok: true });
    }
    const sshRecording = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/ssh-recordings(?:\/([0-9a-f-]+)(?:\/download)?)?$/i);
    if (sshRecording) {
      if (!activeEndpoint.capabilities.desktopLocal?.ssh) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SSH 能力，MCP 不会回退到服务端执行"));
      const context = await currentDesktopSshContext();
      if (!sshRecording[1] && (request.method ?? "GET") === "GET") return mcpJsonResponse(200, { items: desktopSshRuntime.listRecordings(context) });
      if (sshRecording[1] && request.method === "DELETE") {
        desktopSshRuntime.deleteRecording(sshRecording[1], context);
        return mcpJsonResponse(204, null);
      }
      if (sshRecording[1] && (request.method ?? "GET") === "GET") {
        const file = desktopSshRuntime.recordingFile(sshRecording[1], context);
        const data = await readFile(file.path);
        return mcpJsonResponse(200, { filename: file.filename, contentType: "application/x-asciicast", size: data.length, contentBase64: data.toString("base64") });
      }
    }
    if (/^\/api\/v1\/web-view-downloads\//.test(new URL(path, "http://desktop.local").pathname)) {
      throw new Error(tr("本机 Web 下载由系统保存对话框处理，不存在可回读的服务端下载 ID"));
    }
  }
  const response = await endpointFetch({
    ...desktopRequest,
    headers: [
      ...(desktopRequest.headers ?? []),
      ["X-Viron-MCP-Origin", activeEndpoint.endpoint],
      [VIRON_MCP_APPROVAL_MODE_HEADER, desktopMcpApprovalModeContext.getStore() ?? mcpApprovalMode(readState().localMcpApprovalMode)],
    ],
  });
  const headers = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get("content-type") ?? "";
  let data: unknown;
  if (contentType.includes("application/json")) {
    const body = await response.text();
    try { data = body ? JSON.parse(body) as unknown : null; }
    catch { data = { error: "INVALID_JSON_RESPONSE", message: tr("Viron Endpoint 返回了无效 JSON") }; }
  } else if (contentType.startsWith("text/") || contentType.includes("application/sql") || contentType.includes("application/x-asciicast")) {
    data = await response.text();
  } else {
    const binary = Buffer.from(await response.arrayBuffer());
    data = {
      contentType: contentType || "application/octet-stream",
      contentDisposition: response.headers.get("content-disposition") ?? "",
      size: binary.length,
      contentBase64: binary.toString("base64"),
    };
  }
  return handleDesktopMcpOperationResponse(toolName, arguments_, { status: response.status, headers, data });
}

function mcpJsonResponse(status: number, data: unknown): McpApiResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, data };
}

function desktopResponseToMcp(response: { status: number; headers: Array<[string, string]>; body: string }): McpApiResponse {
  const headers = Object.fromEntries(response.headers);
  let data: unknown = response.body;
  if (headers["content-type"]?.includes("application/json")) {
    try { data = response.body ? JSON.parse(response.body) as unknown : null; }
    catch { data = { error: "INVALID_JSON_RESPONSE", message: tr("桌面 Runtime 返回了无效 JSON") }; }
  }
  return { status: response.status, headers, data };
}

async function environmentIdForLog(logId: string): Promise<string> {
  const environments = await endpointJson<{ items: Array<{ id: string }> }>("/api/v1/environments");
  for (const environment of environments.items) {
    const logs = await endpointJson<{ items: DesktopEnvironmentLog[] }>(`/api/v1/environments/${encodeURIComponent(environment.id)}/logs`);
    if (logs.items.some((item) => item.id === logId)) return environment.id;
  }
  throw new Error(tr("日志配置不存在或无权访问"));
}

async function currentExecutionActivity(): Promise<ExecutionActivity> {
  if (!activeEndpoint) return emptyExecutionActivity();
  if (currentExecutionMode() === "server") {
    const forwarding = activeEndpoint.capabilities.serverForwarding;
    let activity = emptyExecutionActivity();
    if (forwarding.enabled) {
      try {
        activity = await endpointJson<ExecutionActivity>("/api/v1/auth/execution-runtime");
      } catch (error) {
        if (!executionRuntimeApiMissing(error)) throw error;
      }
    }
    if (!forwarding.enabled || !forwarding.web) activity.counts.web += desktopWebViews.size;
    activity.total = Object.values(activity.counts).reduce((sum, count) => sum + count, 0);
    return activity;
  }
  const context = await currentDesktopSshContext();
  const counts = {
    web: desktopWebViews.size,
    ssh: desktopSshRuntime.list(context).length,
    sftp: desktopSftpRuntime.activeCount(),
    logs: desktopLogRuntime.activeCount(),
    database: desktopDatabaseRuntime.activeCount() + desktopDatabaseOperationRuntime.activeCount(),
    redis: desktopRedisRuntime.activeCount(),
  };
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
}

function requireDesktopString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(tr("{{0}}无效", [label]));
  return value;
}

function requireDesktopInput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 * 1024) throw new Error(tr("终端输入无效"));
  return value;
}

function desktopBinary(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(tr("二进制数据无效"));
}

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

function monitorAlertNotificationInput(value: unknown): import("../shared/monitor-alerts.js").DesktopMonitorAlertNotification {
  if (!value || typeof value !== "object") throw new Error(tr("监控告警通知无效"));
  const input = value as Record<string, unknown>;
  const required = (key: string, max: number) => {
    const text = typeof input[key] === "string" ? input[key].trim() : "";
    if (!text || text.length > max) throw new Error(tr("监控告警通知无效"));
    return text;
  };
  const optionalId = (key: string) => {
    if (input[key] == null) return null;
    const text = typeof input[key] === "string" ? input[key] : "";
    if (!/^[0-9a-f-]{36}$/i.test(text)) throw new Error(tr("监控告警通知无效"));
    return text;
  };
  const environmentId = required("environmentId", 64);
  if (!/^[0-9a-f-]{36}$/i.test(environmentId)) throw new Error(tr("监控告警通知无效"));
  return {
    id: required("id", 128),
    title: required("title", 160),
    body: required("body", 500),
    environmentId,
    sshConnectionId: optionalId("sshConnectionId"),
    serviceId: optionalId("serviceId"),
    deploymentId: optionalId("deploymentId"),
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

function registerDesktopSshIpc(): void {
  ipcMain.handle("viron:ssh:list", async (event) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    return { items: desktopSshRuntime.list(context) };
  });

  ipcMain.handle("viron:ssh:open", async (event, input: { connectionId?: unknown; originEnvironmentId?: unknown; cols?: unknown; rows?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const cols = Number(input?.cols ?? 120);
    const rows = Number(input?.rows ?? 32);
    const originEnvironmentId = typeof input?.originEnvironmentId === "string" ? input.originEnvironmentId : undefined;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error(tr("终端尺寸无效"));
    const loaded = await localSshCredential(connectionId);
    const registrationId = await reserveDesktopRuntime("ssh", connectionId, undefined, originEnvironmentId);
    try {
      const opened = await desktopSshRuntime.create(loaded.context, loaded.credential, cols, rows);
      trackDesktopRuntime({
        id: registrationId,
        localId: opened.session.id,
        activity: () => desktopSshRuntime.activity(opened.session.id),
        close: (reason) => {
          desktopAgentRuntime?.stopForSource(`desktop-ssh:${opened.session.id}`, reason);
          return desktopSshRuntime.close(opened.session.id, reason);
        },
      });
      return { ...opened, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });

  ipcMain.handle("viron:ssh:ticket", async (event, sessionId: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    return { ticket: desktopSshRuntime.ticket(requireDesktopString(sessionId, tr("SSH 会话 ID")), context) };
  });

  ipcMain.handle("viron:ssh:attach", async (event, sessionId: unknown, ticket: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    return desktopSshRuntime.attach(requireDesktopString(sessionId, tr("SSH 会话 ID")), requireDesktopString(ticket, tr("终端票据")), context);
  });

  ipcMain.handle("viron:ssh:detach", async (event, sessionId: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    desktopSshRuntime.detach(requireDesktopString(sessionId, tr("SSH 会话 ID")), context);
    return { detached: true as const };
  });

  ipcMain.handle("viron:ssh:action", async (event, sessionId: unknown, action: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown }) => {
    trustedSender(event);
    const id = requireDesktopString(sessionId, tr("SSH 会话 ID"));
    const context = await currentDesktopSshContext();
    if (action?.type === "input") await desktopSshRuntime.input(id, context, requireDesktopInput(action.data));
    else if (action?.type === "binary") await desktopSshRuntime.input(id, context, desktopBinary(action.data));
    else if (action?.type === "resize") {
      const cols = Number(action.cols);
      const rows = Number(action.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error(tr("终端尺寸无效"));
      desktopSshRuntime.resize(id, context, cols, rows);
    } else throw new Error(tr("不支持的终端操作"));
    return { ok: true as const };
  });

  ipcMain.handle("viron:ssh:close", async (event, sessionId: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    const id = requireDesktopString(sessionId, tr("SSH 会话 ID"));
    if (!desktopSshRuntime.list(context).some((session) => session.id === id)) throw new Error(tr("SSH 会话不存在或已经结束"));
    desktopAgentRuntime.stopForSource(`desktop-ssh:${id}`, tr("当前 SSH 会话已关闭"));
    await desktopSshRuntime.close(id);
    return { closed: true as const };
  });

  ipcMain.handle("viron:ssh-recordings:list", async (event) => {
    trustedSender(event);
    return { items: desktopSshRuntime.listRecordings(await currentDesktopSshContext()) };
  });

  ipcMain.handle("viron:ssh-recordings:download", async (event, recordingId: unknown) => {
    trustedSender(event);
    const file = desktopSshRuntime.recordingFile(requireDesktopString(recordingId, tr("终端录像 ID")), await currentDesktopSshContext());
    const target = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath("downloads"), basename(file.filename)) });
    if (target.canceled || !target.filePath) return { saved: false as const };
    await copyFile(file.path, target.filePath);
    return { saved: true as const, filePath: target.filePath };
  });

  ipcMain.handle("viron:ssh-recordings:delete", async (event, recordingId: unknown) => {
    trustedSender(event);
    desktopSshRuntime.deleteRecording(requireDesktopString(recordingId, tr("终端录像 ID")), await currentDesktopSshContext());
    return { deleted: true as const };
  });

  ipcMain.handle("viron:sftp:list", async (event, input: { connectionId?: unknown; path?: unknown }) => {
    trustedSender(event);
    return desktopSftpRuntime.list(requireDesktopString(input?.connectionId, tr("SSH 连接 ID")), typeof input?.path === "string" ? input.path : "/");
  });

  ipcMain.handle("viron:sftp:action", async (event, input: { type?: unknown; connectionId?: unknown; path?: unknown; newPath?: unknown; mode?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const path = requireDesktopString(input?.path, tr("远程路径"));
    if (input.type === "mkdir") return desktopSftpRuntime.mkdir(connectionId, path);
    if (input.type === "rename") return desktopSftpRuntime.rename(connectionId, path, requireDesktopString(input.newPath, tr("新路径")));
    if (input.type === "chmod") {
      await desktopSftpRuntime.chmod(connectionId, path, requireDesktopString(input.mode, tr("权限")));
      return { ok: true as const };
    }
    if (input.type === "delete") {
      await desktopSftpRuntime.delete(connectionId, path);
      return { deleted: true as const };
    }
    throw new Error(tr("不支持的 SFTP 操作"));
  });

  ipcMain.handle("viron:sftp:upload-start", async (event, input: { connectionId?: unknown; directory?: unknown; filename?: unknown }) => {
    trustedSender(event);
    return desktopSftpRuntime.startUpload(
      requireDesktopString(input?.connectionId, tr("SSH 连接 ID")),
      requireDesktopString(input?.directory, tr("远程目录")),
      requireDesktopString(input?.filename, tr("上传文件名")),
      await currentDesktopSshContext(),
    );
  });

  ipcMain.handle("viron:sftp:upload-chunk", async (event, uploadId: unknown, data: unknown) => {
    trustedSender(event);
    await desktopSftpRuntime.uploadChunk(requireDesktopString(uploadId, tr("上传任务 ID")), await currentDesktopSshContext(), desktopBinary(data));
    return { accepted: true as const };
  });

  ipcMain.handle("viron:sftp:upload-complete", async (event, uploadId: unknown) => {
    trustedSender(event);
    return desktopSftpRuntime.completeUpload(requireDesktopString(uploadId, tr("上传任务 ID")), await currentDesktopSshContext());
  });

  ipcMain.handle("viron:sftp:upload-cancel", async (event, uploadId: unknown) => {
    trustedSender(event);
    desktopSftpRuntime.cancelUpload(requireDesktopString(uploadId, tr("上传任务 ID")), await currentDesktopSshContext());
    return { cancelled: true as const };
  });

  ipcMain.handle("viron:sftp:download", async (event, input: { connectionId?: unknown; path?: unknown; filename?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const path = requireDesktopString(input?.path, tr("远程路径"));
    const filename = typeof input?.filename === "string" ? basename(input.filename) : basename(path);
    const target = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath("downloads"), filename || "download") });
    if (target.canceled || !target.filePath) return { saved: false as const };
    await desktopSftpRuntime.downloadTo(connectionId, path, target.filePath);
    return { saved: true as const, filePath: target.filePath };
  });

  ipcMain.handle("viron:sftp:drag-out", async (event, input: { connectionId?: unknown; paths?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const paths = Array.isArray(input?.paths) ? input.paths.map((path) => requireDesktopString(path, tr("来源路径"))) : [];
    if (!paths.length) throw new Error(tr("请选择要拖出的文件或目录"));
    const temporaryDirectory = join(app.getPath("temp"), "viron-sftp-drag", randomUUID());
    const materialized = await desktopSftpRuntime.materializeForNativeDrag(connectionId, paths, temporaryDirectory);
    const icon = await app.getFileIcon(materialized.files[0], { size: "small" });
    event.sender.startDrag({ file: materialized.files[0], files: materialized.files, icon });
    if (materialized.temporary) {
      const cleanup = setTimeout(() => void rm(temporaryDirectory, { recursive: true, force: true }), 10 * 60 * 1000);
      cleanup.unref();
    }
    return { started: true as const };
  });

  ipcMain.handle("viron:sftp-transfers:list", async (event) => {
    trustedSender(event);
    return { items: desktopSftpRuntime.listTransfers(await currentDesktopSshContext()) };
  });

  ipcMain.handle("viron:sftp-transfers:preview", async (event, input: Omit<DesktopSftpTransferOptions, "conflict">) => {
    trustedSender(event);
    const sourcePaths = Array.isArray(input?.sourcePaths)
      ? input.sourcePaths.map((path) => requireDesktopString(path, tr("来源路径")))
      : undefined;
    return desktopSftpRuntime.preview({
      sourceConnectionId: requireDesktopString(input?.sourceConnectionId, tr("来源 SSH 连接 ID")),
      targetConnectionId: requireDesktopString(input?.targetConnectionId, tr("目标 SSH 连接 ID")),
      sourcePath: typeof input?.sourcePath === "string" ? requireDesktopString(input.sourcePath, tr("来源路径")) : undefined,
      sourcePaths,
      targetDirectory: requireDesktopString(input?.targetDirectory, tr("目标目录")),
    });
  });

  ipcMain.handle("viron:sftp-transfers:create", async (event, input: DesktopSftpTransferOptions) => {
    trustedSender(event);
    const conflict = input?.conflict;
    if (conflict !== "overwrite" && conflict !== "skip") throw new Error(tr("文件冲突策略无效"));
    const sourcePaths = Array.isArray(input?.sourcePaths)
      ? input.sourcePaths.map((path) => requireDesktopString(path, tr("来源路径")))
      : undefined;
    const conflictDecisions = input?.conflictDecisions && Object.fromEntries(Object.entries(input.conflictDecisions).map(([path, decision]) => {
      if (decision !== "overwrite" && decision !== "skip") throw new Error(tr("文件冲突策略无效"));
      return [requireDesktopString(path, tr("目标路径")), decision];
    }));
    const sourceConnectionId = requireDesktopString(input?.sourceConnectionId, tr("来源 SSH 连接 ID"));
    const targetConnectionId = requireDesktopString(input?.targetConnectionId, tr("目标 SSH 连接 ID"));
    const [resourceId, relatedResourceId] = desktopSftpRemoteConnectionIds(sourceConnectionId, targetConnectionId);
    const registrationId = await reserveDesktopRuntime("sftp", resourceId, relatedResourceId, input.originEnvironmentId);
    try {
      const context = await currentDesktopSshContext();
      const task = await desktopSftpRuntime.create(context, {
      sourceConnectionId,
      targetConnectionId,
      sourcePath: typeof input?.sourcePath === "string" ? requireDesktopString(input.sourcePath, tr("来源路径")) : undefined,
      sourcePaths,
      targetDirectory: requireDesktopString(input?.targetDirectory, tr("目标目录")),
      conflict,
      conflictDecisions,
      });
      trackDesktopRuntime({
        id: registrationId,
        localId: task.id,
        activity: () => desktopSftpRuntime.activity(task.id),
        close: () => {
          if (desktopSftpRuntime.activity(task.id) !== null) desktopSftpRuntime.cancelTransfer(task.id, context);
        },
      });
      return { task, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });

  ipcMain.handle("viron:sftp-transfers:cancel", async (event, taskId: unknown) => {
    trustedSender(event);
    desktopSftpRuntime.cancelTransfer(requireDesktopString(taskId, tr("传输任务 ID")), await currentDesktopSshContext());
    return { cancelled: true as const };
  });

  ipcMain.handle("viron:sftp-transfers:retry", async (event, input: { taskId?: unknown; originEnvironmentId?: unknown }) => {
    trustedSender(event);
    const id = requireDesktopString(input?.taskId, tr("传输任务 ID"));
    const originEnvironmentId = typeof input?.originEnvironmentId === "string" ? input.originEnvironmentId : undefined;
    const context = await currentDesktopSshContext();
    const previous = desktopSftpRuntime.listTransfers(context).find((task) => task.id === id);
    if (!previous) throw new Error(tr("传输任务不存在"));
    const [resourceId, relatedResourceId] = desktopSftpRemoteConnectionIds(previous.sourceConnectionId, previous.targetConnectionId);
    const registrationId = await reserveDesktopRuntime("sftp", resourceId, relatedResourceId, originEnvironmentId);
    try {
      const task = await desktopSftpRuntime.retryTransfer(id, context);
      trackDesktopRuntime({
        id: registrationId,
        localId: task.id,
        activity: () => desktopSftpRuntime.activity(task.id),
        close: () => {
          if (desktopSftpRuntime.activity(task.id) !== null) desktopSftpRuntime.cancelTransfer(task.id, context);
        },
      });
      return { task, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });
}

function registerDesktopLogIpc(): void {
  ipcMain.handle("viron:logs:open", async (event, input: { environmentId?: unknown; logId?: unknown; initialLines?: unknown }) => {
    trustedSender(event);
    if (!activeEndpoint?.capabilities.desktopLocal?.logs) throw new Error(tr("当前 Endpoint 未声明桌面 App 本机日志能力"));
    const environmentId = requireDesktopString(input?.environmentId, tr("环境 ID"));
    const logId = requireDesktopString(input?.logId, tr("日志配置 ID"));
    const initialLines = Number(input?.initialLines);
    const response = await endpointJson<{ items: DesktopEnvironmentLog[] }>(`/api/v1/environments/${encodeURIComponent(environmentId)}/logs`);
    const log = response.items.find((item) => item.id === logId);
    if (!log) throw new Error(tr("日志配置不存在或无权访问"));
    if (!log.connectionAvailable) throw new Error(tr("该 SSH 连接已不可用，请编辑日志配置"));
    const registrationId = await reserveDesktopRuntime("logs", log.id, undefined, environmentId);
    try {
      const opened = await desktopLogRuntime.create({
        logId: log.id,
        logName: log.name,
        sshConnectionId: log.sshConnectionId,
        filePaths: log.filePaths,
        initialLines,
      });
      trackDesktopRuntime({
        id: registrationId,
        localId: opened.stream.id,
        activity: () => desktopLogRuntime.activity(opened.stream.id),
        close: (reason) => { desktopLogRuntime.close(opened.stream.id, undefined, reason); },
      });
      return { ...opened, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });

  ipcMain.handle("viron:logs:close", async (event, streamId: unknown) => {
    trustedSender(event);
    const closed = desktopLogRuntime.close(
      requireDesktopString(streamId, tr("日志流 ID")),
      await currentDesktopSshContext(),
    );
    if (!closed) throw new Error(tr("实时日志不存在或已经结束"));
    return { closed: true as const };
  });
}

async function executeAgentSshRead(input: {
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
}): Promise<import("../shared/agent.js").AgentSshDiagnosticResult> {
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
      const result = await endpointJson<import("../shared/agent.js").AgentSshDiagnosticResult>(
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

function emitDesktopAgentEvent(event: import("../shared/agent.js").AgentStreamEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:agent-event", event);
  sendToAgentChat("viron:agent-event", event);
}

function settleAgentWorkbenchExecution(requestId: string, result: AgentWorkbenchExecutionResult | Error): boolean {
  const pending = pendingAgentWorkbenchExecutions.get(requestId);
  if (!pending) return false;
  pendingAgentWorkbenchExecutions.delete(requestId);
  clearTimeout(pending.timer);
  pending.abortSignal.removeEventListener("abort", pending.abortListener);
  if (result instanceof Error) pending.reject(result);
  else pending.resolve(result);
  return true;
}

function requestAgentWorkbenchExecution(
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

function agentWorkbenchExecutionResponse(value: unknown): AgentWorkbenchExecutionResponseInput {
  if (!value || typeof value !== "object") throw new Error(tr("Viron Agent 工作台执行响应无效"));
  const input = value as Record<string, unknown>;
  const requestId = requireDesktopString(input.requestId, tr("工作台执行请求 ID"));
  if (input.error !== undefined && typeof input.error !== "string") throw new Error(tr("Viron Agent 工作台执行错误无效"));
  if (input.result !== undefined && (!input.result || typeof input.result !== "object")) throw new Error(tr("Viron Agent 工作台执行结果无效"));
  return { requestId, ...(typeof input.error === "string" ? { error: input.error } : {}), ...(input.result ? { result: input.result as AgentWorkbenchExecutionResult } : {}) };
}

function validateAgentWorkbenchExecutionResult(
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

async function executeAgentSshWorkbenchRead(input: {
  request: AgentWorkbenchExecutionRequest & { domain: "ssh" };
  scope: AgentRuntimeScope;
  desktopContext: DesktopSshContext;
  abortSignal: AbortSignal;
}): Promise<import("../shared/agent.js").AgentSshDiagnosticResult> {
  if (!agentRuntimeScopeMatches(input.scope, agentRuntimeScope(input.desktopContext))) throw new Error(tr("Viron Agent 诊断现场已经失效"));
  const currentTarget = currentExecutionMode() === "server" ? "server-forwarded" : "desktop-local";
  if (input.request.executionTarget !== currentTarget) throw new Error(tr("Viron Agent 诊断现场已经失效"));
  const write = input.request.intent === "write";
  desktopAgentAuditStore.append(input.scope, write ? "ssh_workbench_write_started" : "ssh_workbench_execution_started", input.request.sessionId, tr("在当前 SSH 终端执行{{0}}（第 {{1}}/{{2}} 步）", [write ? tr("写命令") : tr("只读诊断命令"), input.request.step, input.request.maxSteps]));
  try {
    const snapshot = input.request.executionTarget === "server-forwarded"
      ? await endpointJson<import("../shared/agent.js").AgentSshContextSnapshot>(
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

async function executeAgentDatabaseRead(input: {
  connectionId: string;
  database: string;
  sql: string;
  scope: AgentRuntimeScope;
  desktopContext: DesktopSshContext;
  abortSignal?: AbortSignal;
  step?: number;
  maxSteps?: number;
  intent?: "read" | "write";
}): Promise<import("../shared/agent.js").AgentDatabaseReadResult> {
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

function registerDesktopAgentIpc(): void {
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
      return endpointJson<import("../shared/agent.js").AgentSshContextSnapshot>(
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

function registerIpc(): void {
  registerDesktopSshIpc();
  registerDesktopLogIpc();
  registerDesktopAgentIpc();
  const databaseArtifactFiles = new DatabaseArtifactFileRuntime(app.getPath("userData"));
  ipcMain.handle("viron:immersive-navigation:update", async (event, state: ImmersiveNavigationState | null) => {
    trustedSender(event);
    if (state !== null && (!state || typeof state !== "object" || typeof state.visible !== "boolean")) throw new Error(tr("沉浸导航状态无效"));
    await updateImmersiveNavigationWindow(state);
  });
  ipcMain.handle("viron:immersive-navigation:action", (event, action: ImmersiveNavigationAction) => {
    if (!immersiveNavigationWindow || event.sender !== immersiveNavigationWindow.webContents) throw new Error(tr("拒绝来自非沉浸导航窗口的请求"));
    if (!action || typeof action.type !== "string") throw new Error(tr("沉浸导航操作无效"));
    if (["drag-start", "drag-move", "drag-end"].includes(action.type)) {
      handleImmersiveNavigationDrag(action as Extract<ImmersiveNavigationAction, { type: "drag-start" | "drag-move" | "drag-end" }>);
    } else {
      sendImmersiveNavigationAction(action);
      if (["collapse", "select-tab", "select-credential", "exit"].includes(action.type)) mainWindow?.focus();
    }
  });
  ipcMain.handle("viron:agent-chat:native-overlay", async (event, active: unknown) => {
    trustedMainWindowSender(event);
    if (typeof active !== "boolean") throw new Error(tr("Viron Agent 原生叠层状态无效"));
    await setAgentChatNativeOverlay(active);
  });
  ipcMain.handle("viron:agent-host:get", (event) => {
    trustedAgentChatSender(event);
    return agentChatHostState;
  });
  ipcMain.handle("viron:agent-host:update", async (event, value: AgentHostState | null) => {
    trustedMainWindowSender(event);
    if (value !== null && !isAgentHostState(value)) throw new Error(tr("Viron Agent 宿主状态无效"));
    await updateAgentChatHost(value);
  });
  ipcMain.handle("viron:agent-host:action", async (event, action: AgentHostAction) => {
    trustedAgentChatSender(event);
    if (!isAgentHostAction(action)) throw new Error(tr("Viron Agent 宿主操作无效"));
    return requestAgentHostAction(action);
  });
  ipcMain.handle("viron:agent-host:respond", (event, id: unknown, result: AgentHostActionResult) => {
    trustedMainWindowSender(event);
    if (typeof id !== "string" || !id) throw new Error(tr("Viron Agent 宿主响应无效"));
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw new Error(tr("Viron Agent 宿主响应无效"));
    if (!settleAgentHostAction(id, result)) throw new Error(tr("Viron Agent 宿主响应已过期"));
  });
  ipcMain.handle("viron:agent-chat:chrome", (event, visible: unknown) => {
    trustedAgentChatSender(event);
    if (typeof visible !== "boolean") throw new Error(tr("Viron Agent 对话层状态无效"));
    setAgentChatChromeVisible(visible);
  });
  ipcMain.handle("viron:agent-chat:ignore-mouse", (event, ignore: unknown) => {
    trustedAgentChatSender(event);
    if (typeof ignore !== "boolean") throw new Error(tr("Viron Agent 鼠标穿透状态无效"));
    setAgentChatIgnoreMouse(ignore);
  });
  ipcMain.handle("viron:agent-chat:focus", (event) => {
    trustedAgentChatSender(event);
    if (agentChatWindow && !agentChatWindow.isDestroyed() && agentChatWindow.isVisible()) agentChatWindow.focus();
  });
  ipcMain.handle("viron:agent-chat:pointer-outside", (event) => {
    trustedMainWindowSender(event);
    sendToAgentChat("viron:agent-chat-pointer-outside");
  });
  ipcMain.handle("viron:agent-launcher:update", async (event, value: AgentFloatingOverlayState | null) => {
    trustedSender(event);
    if (value !== null) {
      const edge = value?.snappedEdge;
      const numbers = [value?.bounds?.x, value?.bounds?.y, value?.bounds?.width, value?.bounds?.height, value?.rootOffset?.x, value?.rootOffset?.y];
      if (!value || numbers.some((number) => !Number.isFinite(number))
        || value.bounds.width <= 0 || value.bounds.height <= 0
        || typeof value.running !== "boolean" || typeof value.dragging !== "boolean" || typeof value.edgeCollapsed !== "boolean"
        || (edge !== null && !["left", "right", "top", "bottom"].includes(edge)) || typeof value.label !== "string") {
        throw new Error(tr("Viron Agent 悬浮按钮状态无效"));
      }
    }
    await updateAgentLauncherWindow(value);
  });
  ipcMain.handle("viron:agent-launcher:action", (event, action: AgentFloatingOverlayAction) => {
    if (!agentLauncherWindow || event.sender !== agentLauncherWindow.webContents) throw new Error(tr("拒绝来自非 Agent 悬浮窗口的请求"));
    if (!action || !["toggle", "expand", "drag-start", "drag-move", "drag-end"].includes(action.type)) throw new Error(tr("Viron Agent 悬浮按钮操作无效"));
    if ((action.type === "drag-start" || action.type === "drag-move" || action.type === "drag-end")
      && (!Number.isFinite(action.screenX) || !Number.isFinite(action.screenY))) throw new Error(tr("Viron Agent 拖动坐标无效"));
    mainWindow?.webContents.send("viron:agent-launcher-action", action);
    sendToAgentChat("viron:agent-launcher-action", action);
    if (action.type === "toggle" || action.type === "expand") mainWindow?.focus();
  });
  ipcMain.handle("viron:connection-quality:update", async (event, value: ConnectionQualityOverlayState | null) => {
    trustedSender(event);
    if (value !== null) {
      const numbers = [
        value?.bounds?.x, value?.bounds?.y, value?.bounds?.width, value?.bounds?.height,
        value?.rootOffset?.x, value?.rootOffset?.y, value?.panelSize?.width, value?.panelSize?.height,
      ];
      if (!value || numbers.some((number) => !Number.isFinite(number))
        || value.bounds.width <= 0 || value.bounds.height <= 0 || value.panelSize.width <= 0 || value.panelSize.height <= 0
        || typeof value.expanded !== "boolean" || typeof value.dragging !== "boolean" || typeof value.testing !== "boolean"
        || !value.service || !Array.isArray(value.targets)) {
        throw new Error(tr("连接质量悬浮面板状态无效"));
      }
    }
    await updateConnectionQualityWindow(value);
  });
  ipcMain.handle("viron:connection-quality:target:probe", async (event, targetId: unknown) => {
    trustedSender(event);
    if (typeof targetId !== "string" || !targetId) throw new Error(tr("活动目标无效"));
    const target = await endpointJson<ConnectionQualityTargetAddress>(
      `/api/v1/desktop/connection-quality/targets/${encodeURIComponent(targetId)}`,
    );
    if (!target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
      throw new Error(tr("活动目标无效"));
    }
    return probeDesktopTcpTarget(target);
  });
  ipcMain.handle("viron:connection-quality:action", (event, action: ConnectionQualityOverlayAction) => {
    if (!connectionQualityWindow || event.sender !== connectionQualityWindow.webContents) {
      throw new Error(tr("拒绝来自非连接质量悬浮窗口的请求"));
    }
    if (!action || !["toggle-details", "run-test", "select-target", "drag-start", "drag-move", "drag-end"].includes(action.type)) {
      throw new Error(tr("连接质量悬浮面板操作无效"));
    }
    if ((action.type === "drag-start" || action.type === "drag-move" || action.type === "drag-end")
      && (!Number.isFinite(action.screenX) || !Number.isFinite(action.screenY))) {
      throw new Error(tr("连接质量面板拖动坐标无效"));
    }
    if (action.type === "select-target" && typeof action.targetId !== "string") throw new Error(tr("活动目标无效"));
    mainWindow?.webContents.send("viron:connection-quality-action", action);
  });
  ipcMain.handle("viron:active-environment-dock:update", async (event, value: ActiveEnvironmentDockState | null) => {
    trustedSender(event);
    if (value !== null) {
      const numbers = [value?.bounds?.x, value?.bounds?.y, value?.bounds?.width, value?.bounds?.height];
      if (!value || numbers.some((number) => !Number.isFinite(number)) || value.bounds.width <= 0 || value.bounds.height <= 0
        || !Number.isFinite(value.card?.width) || !Number.isFinite(value.card?.height) || value.card.width <= 0 || value.card.height <= 0
        || typeof value.expanded !== "boolean" || typeof value.growUp !== "boolean" || typeof value.dragging !== "boolean" || typeof value.dark !== "boolean"
        || !["zh-CN", "en"].includes(value.language) || !Array.isArray(value.environments)) {
        throw new Error(tr("活动环境悬浮坞状态无效"));
      }
      if (value.environments.some((environment) => typeof environment?.id !== "string" || typeof environment?.name !== "string"
        || !Array.isArray(environment?.connections) || !environment.connections.length
        || environment.preview && (typeof environment.preview.dataUrl !== "string"
          || !environment.preview.dataUrl.startsWith("data:image/jpeg;base64,")
          || environment.preview.dataUrl.length > 500_000))) {
        throw new Error(tr("活动环境悬浮坞状态无效"));
      }
    }
    await updateActiveEnvironmentDockWindow(value);
  });
  ipcMain.handle("viron:active-environment-dock:layout", async (event, value: ActiveEnvironmentDockLayoutState) => {
    trustedSender(event);
    const numbers = [value?.bounds?.x, value?.bounds?.y, value?.bounds?.width, value?.bounds?.height, value?.card?.width, value?.card?.height];
    if (!value || numbers.some((number) => !Number.isFinite(number)) || value.bounds.width <= 0 || value.bounds.height <= 0
      || value.card.width <= 0 || value.card.height <= 0 || typeof value.expanded !== "boolean"
      || typeof value.growUp !== "boolean" || typeof value.dragging !== "boolean") {
      throw new Error(tr("活动环境悬浮坞布局无效"));
    }
    await updateActiveEnvironmentDockLayoutWindow(value);
  });
  ipcMain.handle("viron:renderer-preview:capture", async (event, bounds: unknown) => {
    trustedSender(event);
    return await captureDesktopRendererPreview(bounds);
  });
  ipcMain.handle("viron:active-environment-dock:action", (event, action: ActiveEnvironmentDockAction) => {
    if (!activeEnvironmentDockWindow || event.sender !== activeEnvironmentDockWindow.webContents) throw new Error(tr("拒绝来自非活动环境悬浮坞的请求"));
    if (!action || !["expand", "toggle", "collapse", "open-environment", "close-environment"].includes(action.type)) {
      throw new Error(tr("活动环境悬浮坞操作无效"));
    }
    if ((action.type === "open-environment" || action.type === "close-environment") && typeof action.environmentId !== "string") throw new Error(tr("活动环境无效"));
    if (action.type === "open-environment" && action.origin) {
      const values = [action.origin.x, action.origin.y, action.origin.width, action.origin.height];
      if (values.some((value) => !Number.isFinite(value)) || action.origin.width <= 0 || action.origin.height <= 0) throw new Error(tr("活动环境位置无效"));
      const dockBounds = activeEnvironmentDockWindow.getBounds();
      const contentBounds = mainWindow?.getContentBounds();
      if (contentBounds) action = {
        ...action,
        origin: {
          x: dockBounds.x - contentBounds.x + action.origin.x,
          y: dockBounds.y - contentBounds.y + action.origin.y,
          width: action.origin.width,
          height: action.origin.height,
        },
      };
    }
    if (action.type === "collapse" && activeEnvironmentDockState?.expanded && activeEnvironmentDockPointerInside()) {
      keepActiveEnvironmentDockExpanded();
      return;
    }
    if (action.type === "collapse") stopActiveEnvironmentDockPointerTracking();
    mainWindow?.webContents.send("viron:active-environment-dock-action", action);
    if (action.type === "open-environment" || action.type === "close-environment") mainWindow?.focus();
  });
  ipcMain.on("viron:active-environment-dock:drag", (event, action: ActiveEnvironmentDockDragAction) => {
    if (!activeEnvironmentDockWindow || event.sender !== activeEnvironmentDockWindow.webContents) return;
    if (!action || !["drag-start", "drag-move", "drag-end"].includes(action.type)
      || !Number.isFinite(action.screenX) || !Number.isFinite(action.screenY)) return;
    handleActiveEnvironmentDockDrag(action);
  });
  ipcMain.handle("viron:state", (event) => {
    trustedSender(event);
    return publicState();
  });
  ipcMain.handle("viron:language:set", (event, value: unknown) => {
    trustedSender(event);
    const language = setDesktopLanguage(value);
    const state = readState();
    if (state.language !== language) writeState({ ...state, language });
    installApplicationMenu();
    return { language };
  });
  ipcMain.handle("viron:titlebar-theme:set", (event, appearance: unknown) => {
    trustedSender(event);
    if (!isDesktopTitleBarAppearance(appearance)) throw new Error(tr("窗口标题栏主题无效"));
    const applied = process.platform === "win32";
    if (applied) mainWindow?.setTitleBarOverlay(desktopTitleBarOverlay(appearance));
    return { applied };
  });
  ipcMain.handle("viron:monitor-alert:notify", (event, value: unknown) => {
    trustedSender(event);
    const input = monitorAlertNotificationInput(value);
    if (!ElectronNotification.isSupported()) return { shown: false };
    const notification = new ElectronNotification({ title: input.title, body: input.body });
    desktopMonitorNotifications.add(notification);
    notification.once("close", () => desktopMonitorNotifications.delete(notification));
    notification.on("click", () => {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send("viron:monitor-alert-open", input);
    });
    notification.show();
    return { shown: true };
  });
  ipcMain.handle("viron:clipboard:read-text", (event) => {
    trustedSender(event);
    return clipboard.readText();
  });
  ipcMain.handle("viron:clipboard:write-text", (event, value: unknown) => {
    trustedSender(event);
    if (typeof value !== "string") throw new Error(tr("剪贴板文本无效"));
    clipboard.writeText(value);
    return { written: true as const };
  });
  ipcMain.handle("viron:shortcuts:get", (event) => {
    trustedSender(event);
    return shortcutPreferences();
  });
  ipcMain.handle("viron:shortcuts:set", (event, value: unknown) => {
    trustedSender(event);
    const overrides = sanitizeShortcutOverrides(value);
    const bindings = effectiveShortcutBindings(overrides, process.platform);
    for (const [action, binding] of Object.entries(bindings) as Array<[ShortcutActionId, string]>) {
      const validation = shortcutValidationError(binding, process.platform);
      if (validation) throw new Error(validation);
      const conflict = shortcutConflict(bindings, action, binding);
      if (conflict) throw new Error(tr("快捷键与“{{0}}”冲突", [conflict.label]));
    }
    const state = readState();
    writeState({ ...state, shortcutOverrides: overrides });
    installApplicationMenu();
    return { overrides, bindings };
  });
  ipcMain.handle("viron:shortcuts:capture", (event, active: unknown) => {
    trustedSender(event);
    shortcutCaptureActive = Boolean(active);
    return { active: shortcutCaptureActive };
  });
  ipcMain.handle("viron:agent:entry-mode:set", (event, value: unknown) => {
    trustedSender(event);
    if (value !== "floating" && value !== "quick" && value !== "disabled") throw new Error(tr("Viron Agent 入口模式无效"));
    if (value === "disabled") desktopAgentRuntime?.stopAll(tr("Viron Agent 已关闭"));
    const state = readState();
    writeState({ ...state, agentEntryMode: value });
    return publishDesktopAppState();
  });
  ipcMain.handle("viron:update:check", (event) => {
    trustedSender(event);
    return desktopUpdater.check(true);
  });
  ipcMain.handle("viron:system-settings:open-local-network", async (event) => {
    trustedSender(event);
    if (process.platform !== "darwin") throw new Error(tr("本地网络设置入口仅适用于 macOS"));
    await shell.openExternal("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork");
    return { opened: true as const };
  });

  ipcMain.handle("viron:execution-mode:set", async (event, mode: DesktopExecutionMode) => {
    trustedSender(event);
    if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
    if (mode !== "local" && mode !== "server") throw new Error(tr("连接模式无效"));
    if (mode === currentExecutionMode()) return publicState();
    const previousMode = currentExecutionMode();
    await Promise.all([
      closeDesktopMcpOperations(),
      closeAllDesktopWebViews(),
      closeDesktopExecution(tr("App 连接模式已切换")),
      previousMode === "server" ? closeServerForwardingRuntime(tr("App 连接模式已切换")) : Promise.resolve(),
    ]);
    const state = readState();
    const key = endpointStateKey(activeEndpoint.endpoint);
    writeState({ ...state, executionModes: { ...state.executionModes, [key]: mode } });
    return publishDesktopAppState();
  });
  ipcMain.handle("viron:execution-activity", async (event) => {
    trustedSender(event);
    return currentExecutionActivity();
  });
  ipcMain.handle("viron:mcp:status", (event) => {
    trustedSender(event);
    return localMcpStatus();
  });
  ipcMain.handle("viron:mcp:enabled:set", async (event, enabled: unknown) => {
    trustedSender(event);
    if (typeof enabled !== "boolean") throw new Error(tr("本机 MCP 开关值无效"));
    const currentlyEnabled = readState().localMcpEnabled === true;
    if (enabled) {
      try {
        await desktopMcpBroker.start();
        desktopMcpLastError = null;
      } catch (error) {
        desktopMcpLastError = error instanceof Error ? error.message : tr("本机 MCP Broker 启动失败");
        throw error;
      }
    } else if (currentlyEnabled || desktopMcpBroker.status().running) {
      await closeDesktopMcpOperations();
      await desktopMcpBroker.close();
      desktopMcpLastError = null;
    }
    const state = readState();
    writeState({ ...state, localMcpEnabled: enabled });
    return localMcpStatus();
  });
  ipcMain.handle("viron:mcp:approval-mode:set", async (event, mode: unknown) => {
    trustedSender(event);
    const approvalMode = mcpApprovalMode(mode);
    if (approvalMode !== mode) throw new Error(tr("MCP 审批策略无效"));
    const state = readState();
    writeState({ ...state, localMcpApprovalMode: approvalMode });
    return localMcpStatus();
  });

  ipcMain.handle("viron:database-artifact:select-sql", async (event) => {
    trustedSender(event);
    const selected = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      filters: [{ name: tr("SQL 文件"), extensions: ["sql"] }, { name: tr("文本文件"), extensions: ["txt"] }],
    });
    const filePath = selected.filePaths[0];
    if (selected.canceled || !filePath) return { selected: false as const };
    return { selected: true as const, name: basename(filePath), content: await readFile(filePath, "utf8"), filePath };
  });

  ipcMain.handle("viron:database-artifact:open-query", async (event, input: { id?: unknown; name?: unknown; sql?: unknown }) => {
    trustedSender(event);
    const id = requireDesktopString(input?.id, tr("查询 ID"));
    const name = requireDesktopString(input?.name, tr("查询名称"));
    if (typeof input?.sql !== "string") throw new Error(tr("查询 SQL 无效"));
    const filePath = await databaseArtifactFiles.queryFile(id, name, input.sql);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    return { opened: true as const, filePath };
  });

  ipcMain.handle("viron:database-artifact:reveal-query", async (event, input: { id?: unknown; name?: unknown; sql?: unknown }) => {
    trustedSender(event);
    const id = requireDesktopString(input?.id, tr("查询 ID"));
    const name = requireDesktopString(input?.name, tr("查询名称"));
    if (typeof input?.sql !== "string") throw new Error(tr("查询 SQL 无效"));
    const filePath = await databaseArtifactFiles.queryFile(id, name, input.sql);
    shell.showItemInFolder(filePath);
    return { revealed: true as const, filePath };
  });

  ipcMain.handle("viron:database-artifact:reveal-backup", async (event, input: { id?: unknown; path?: unknown; filename?: unknown }) => {
    trustedSender(event);
    const id = requireDesktopString(input?.id, tr("备份 ID"));
    const path = requireDesktopString(input?.path, tr("备份下载路径"));
    const requestedFilename = requireDesktopString(input?.filename, tr("备份文件名"));
    let filename = requestedFilename;
    let data: Uint8Array;
    if (currentExecutionMode() === "local" && isDesktopDatabaseDownloadPath(path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.database) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，桌面 App 不会回退到服务端执行"));
      }
      const download = await desktopDatabaseOperationRuntime.download(path, await currentDesktopSshContext());
      filename = download.filename || requestedFilename;
      data = download.data;
    } else {
      const response = await endpointFetch({ path });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? tr("下载失败（HTTP {{0}}）", [response.status]));
      }
      filename = suggestedFilename(response, path) || requestedFilename;
      data = new Uint8Array(await response.arrayBuffer());
    }
    const filePath = await databaseArtifactFiles.backupFile(id, filename, data);
    shell.showItemInFolder(filePath);
    return { revealed: true as const, filePath };
  });

  ipcMain.handle("viron:service-socket:open", async (event, path: string, params: Record<string, string>) => {
    trustedSender(event);
    return openServiceSocket(path, params ?? {});
  });
  ipcMain.handle("viron:service-socket:send", (event, id: string, data: string | ArrayBuffer) => {
    trustedSender(event);
    const managed = serviceSockets.get(id);
    if (!managed || managed.socket.readyState !== NodeWebSocket.OPEN) throw new Error(tr("服务端实时通道尚未连接"));
    managed.socket.send(typeof data === "string" ? data : Buffer.from(data));
    return { sent: true as const };
  });
  ipcMain.handle("viron:service-socket:close", (event, id: string) => {
    trustedSender(event);
    const managed = serviceSockets.get(id);
    if (!managed) return { closed: false as const };
    managed.socket.close(1000, tr("用户关闭连接"));
    return { closed: true as const };
  });

  ipcMain.handle("viron:endpoint:set", async (event, input: string) => {
    trustedSender(event);
    try {
      const normalized = normalizeEndpoint(input);
      const endpointPartition = endpointSession(normalized);
      const validated = await validateEndpoint(normalized, {
        fetcher: (url, init) => endpointPartition.fetch(url instanceof URL ? url.href : url, init),
      });
      if (activeEndpoint?.endpoint && activeEndpoint.endpoint !== validated.endpoint) {
        await Promise.all([
          closeDesktopMcpOperations(),
          closeAllDesktopWebViews(),
          closeDesktopExecution(tr("Endpoint 已切换")),
          closeServerForwardingRuntime(tr("Endpoint 已切换")),
        ]);
      }
      setActiveEndpoint({ ...validated, partition: endpointPartition });
      writeState({ ...readState(), recentEndpoint: validated.endpoint });
      void desktopUpdater.check().catch((error) => {
        process.stderr.write(`Viron update check failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
      return { ok: true as const, state: publicState() };
    } catch (error) {
      const known = error instanceof EndpointValidationError;
      return {
        ok: false as const,
        error: {
          code: known ? error.code : "ENDPOINT_ERROR",
          message: error instanceof Error ? error.message : tr("Endpoint 验证失败"),
        },
      };
    }
  });

  ipcMain.handle("viron:endpoint:clear", async (event) => {
    trustedSender(event);
    await Promise.all([closeDesktopMcpOperations(), closeAllDesktopWebViews(), closeDesktopExecution(tr("Endpoint 已清除")), closeServerForwardingRuntime(tr("Endpoint 已清除"))]);
    setActiveEndpoint(null);
    return publicState();
  });

  ipcMain.handle("viron:api", async (event, request: DesktopRequest) => {
    trustedSender(event);
    if (request.path.startsWith("/api/v1/desktop/")
      || request.path === "/api/v1/auth/execution-runtime/close"
      || /^\/api\/v1\/web-credentials\/[^/]+\/reveal$/.test(request.path)
      || /^\/api\/v1\/ssh-sessions\/[^/]+\/agent-(?:context|diagnostics)(?:\/|$)/.test(request.path)) {
      throw new Error(tr("桌面界面不能直接调用受保护的主进程或敏感接口"));
    }
    const method = (request.method ?? "GET").toUpperCase();
    if (currentExecutionMode() === "local" && isDesktopConnectionInspectionPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.inspection) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机连接巡检能力，桌面 App 不会回退到服务端执行"));
      }
      return desktopConnectionInspectionRuntime.handle(request, await currentDesktopSshContext());
    }
    if (currentExecutionMode() === "local" && isDesktopDatabaseExecutionPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.database) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，桌面 App 不会回退到服务端执行"));
      }
      const context = await currentDesktopSshContext();
      await touchDesktopDatabaseRequest(request.path, context);
      return desktopDatabaseRuntime.handle(request, context);
    }
    if (currentExecutionMode() === "local" && isDesktopRedisExecutionPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.redis) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Redis 能力，桌面 App 不会回退到服务端执行"));
      }
      await touchDesktopRedisRequest(request.path);
      return desktopRedisRuntime.handle(request, await currentDesktopSshContext());
    }
    if (currentExecutionMode() === "local" && isDesktopDatabaseOperationPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.database) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，桌面 App 不会回退到服务端执行"));
      }
      return desktopDatabaseOperationRuntime.handle(request, await currentDesktopSshContext());
    }
    const mutationContext = await desktopWebMutationContext(request.path, method);
    const response = await endpointFetch(request);
    const result = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body: await response.text(),
    };
    if (response.ok && ["/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/workspace"].includes(request.path)) {
      const reason = request.path.endsWith("login") ? tr("用户已重新登录") : request.path.endsWith("logout") ? tr("用户已退出登录") : tr("工作空间已切换");
      closeAllServiceSockets(reason);
      await Promise.all([closeDesktopMcpOperations(), closeAllDesktopWebViews(), closeDesktopExecution(reason)]);
    } else {
      await reconcileDesktopWebMutation(mutationContext, method, response);
      const sshConnection = request.path.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)$/i);
      if (response.ok && sshConnection && ["PUT", "DELETE"].includes(method)) {
        const reason = method === "DELETE" ? tr("SSH 连接已删除") : tr("SSH 连接配置已更新");
        for (const session of desktopSshRuntime.list(await currentDesktopSshContext())) {
          if (session.connectionId === sshConnection[1]) desktopAgentRuntime.stopForSource(`desktop-ssh:${session.id}`, reason);
        }
        await Promise.all([
          desktopSshRuntime.closeConnection(sshConnection[1], reason),
          closeDesktopSshConnectionPool(sshConnection[1]),
          desktopDatabaseRuntime.closeAll(reason),
          desktopRedisRuntime.closeAll(),
        ]);
        desktopSftpRuntime.closeConnection(sshConnection[1]);
        desktopLogRuntime.closeConnection(sshConnection[1], reason);
      }
      const databaseConnection = request.path.match(/^\/api\/v1\/database-connections\/([0-9a-f-]+)$/i);
      if (response.ok && databaseConnection && ["PUT", "DELETE"].includes(method)) {
        desktopAgentRuntime.stopForSourcePrefix(`desktop-database:${databaseConnection[1]}:`, method === "DELETE" ? tr("数据库连接已删除") : tr("数据库连接配置已更新"));
        await desktopDatabaseRuntime.closeConnection(databaseConnection[1], method === "DELETE" ? tr("数据库连接已删除") : tr("数据库连接配置已更新"));
        desktopDatabaseOperationRuntime.closeConnection(databaseConnection[1], method === "DELETE" ? tr("数据库连接已删除") : tr("数据库连接配置已更新"));
      }
      const redisConnection = request.path.match(/^\/api\/v1\/redis-connections\/([0-9a-f-]+)$/i);
      if (response.ok && redisConnection && ["PUT", "DELETE"].includes(method)) {
        await desktopRedisRuntime.closeConnection(redisConnection[1]);
      }
      const environmentLog = request.path.match(/^\/api\/v1\/environment-logs\/([0-9a-f-]+)$/i);
      if (response.ok && environmentLog && ["PUT", "DELETE"].includes(method)) {
        desktopLogRuntime.closeLog(environmentLog[1], method === "DELETE" ? tr("日志配置已删除") : tr("日志配置已更新"));
      }
    }
    return result;
  });

  ipcMain.handle("viron:download", async (event, path: string, filename?: string) => {
    trustedSender(event);
    if (currentExecutionMode() === "local" && isDesktopDatabaseDownloadPath(path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.database) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，桌面 App 不会回退到服务端执行"));
      }
      const download = await desktopDatabaseOperationRuntime.download(path, await currentDesktopSshContext());
      const target = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: filename || download.filename,
      });
      if (target.canceled || !target.filePath) return { saved: false as const };
      await writeFile(target.filePath, download.data);
      return { saved: true as const, filePath: target.filePath };
    }
    const response = await endpointFetch({ path });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(body.message ?? tr("下载失败（HTTP {{0}}）", [response.status]));
    }
    const target = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: filename || suggestedFilename(response, path),
    });
    if (target.canceled || !target.filePath) return { saved: false as const };
    await writeFile(target.filePath, Buffer.from(await response.arrayBuffer()));
    return { saved: true as const, filePath: target.filePath };
  });

  ipcMain.handle("viron:save-text-file", async (event, input: { filename?: unknown; content?: unknown }) => {
    trustedSender(event);
    if (!input || typeof input.filename !== "string" || typeof input.content !== "string") throw new Error(tr("保存文件请求无效"));
    const filename = basename(input.filename.replace(/[\r\n]/g, "")) || "viron-log.log";
    const target = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: join(app.getPath("downloads"), filename),
    });
    if (target.canceled || !target.filePath) return { saved: false as const };
    await writeFile(target.filePath, input.content, "utf8");
    return { saved: true as const, filePath: target.filePath };
  });

  ipcMain.handle("viron:web-view:open", async (event, input: { credentialId?: string; bounds?: DesktopWebViewBounds; initialPage?: DesktopWebInitialPage; originEnvironmentId?: string }) => {
    trustedSender(event);
    if (!input || typeof input.credentialId !== "string" || !input.bounds) throw new Error(tr("本机页面请求无效"));
    if (input.initialPage !== undefined && input.initialPage !== "entry" && input.initialPage !== "blank") throw new Error(tr("本机页面初始模式无效"));
    if (input.originEnvironmentId !== undefined && typeof input.originEnvironmentId !== "string") throw new Error(tr("活动环境无效"));
    return await openDesktopWebView(input.credentialId, input.bounds, input.initialPage, true, input.originEnvironmentId);
  });

  ipcMain.handle("viron:web-view:bounds", (event, id: string, bounds: DesktopWebViewBounds) => {
    trustedSender(event);
    const view = localWebView(id);
    view.bounds = webViewBounds(bounds);
    layoutDesktopWebViewPages(view);
    return webViewState(view);
  });

  ipcMain.handle("viron:web-view:visible", (event, id: string, visible: boolean) => {
    trustedSender(event);
    const view = localWebView(id);
    view.visible = Boolean(visible);
    layoutDesktopWebViewPages(view);
    return webViewState(view);
  });

  ipcMain.handle("viron:web-view:previewing", (event, id: string, previewing: boolean) => {
    trustedSender(event);
    const view = localWebView(id);
    view.previewing = Boolean(previewing);
    if (view.previewing) view.visible = false;
    for (const page of view.pages.values()) page.view.webContents.setBackgroundThrottling(!view.previewing);
    layoutDesktopWebViewPages(view);
    return webViewState(view);
  });

  ipcMain.handle("viron:web-view:capture", async (event, id: string) => {
    trustedSender(event);
    return await captureDesktopWebViewPreview(localWebView(id));
  });

  ipcMain.handle("viron:web-view:action", async (event, id: string, action: { type?: string; url?: string; pageId?: string; orderedPageIds?: string[] }) => {
    trustedSender(event);
    if (!action || typeof action.type !== "string") throw new Error(tr("本机页面操作无效"));
    return await handleDesktopWebViewAction(id, { type: action.type, url: action.url, pageId: action.pageId, orderedPageIds: action.orderedPageIds });
  });

  ipcMain.handle("viron:web-view:close", async (event, id: string) => {
    trustedSender(event);
    await closeDesktopWebView(id);
    return { closed: true as const };
  });
}

async function waitForDesktopWebTitle(view: ManagedDesktopWebView, expected: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = activeDesktopWebPage(view).view.webContents.getTitle();
    if (title === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(tr("等待本机页面标题超时：{{0}}", [expected]));
}

function desktopSmokeStage(stage: string): void {
  if (process.argv.includes("--smoke-test")) process.stderr.write(`VIRON_DESKTOP_SMOKE_STAGE ${stage}\n`);
}

async function waitForDesktopWebNotice(view: ManagedDesktopWebView, type: "success" | "error", timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (view.notice?.type === type) return;
    if (view.notice?.type === "error") throw new Error(view.notice.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(tr("等待本机网页下载完成超时"));
}

async function runDesktopWebSmoke(credentialId: string, username: string, uploadPath?: string): Promise<{
  opened: boolean;
  blankOpenedWithoutEntry: boolean;
  manualRefillOnCurrentPage: boolean;
  sessionStatePersisted: boolean;
  lastLocationRestored: boolean;
  tabsReordered: boolean;
  inspectorOpened: boolean;
  resetCleared: boolean;
  uploadSelected: boolean | null;
  downloadTriggered: boolean;
}> {
  const blankState = await openDesktopWebView(credentialId, { x: 40, y: 120, width: 900, height: 620 }, "blank");
  const blankView = localWebView(blankState.id);
  const deferredEntryPage = blankView.pages.get(blankState.pages[0]?.id ?? "");
  const blankOpenedWithoutEntry = blankState.pages.length === 2
    && blankState.pages[0]?.url === blankView.entryUrl
    && blankState.pages[1]?.url === "about:blank"
    && blankState.activePageId === blankState.pages[1]?.id
    && blankState.url === "about:blank"
    && deferredEntryPage?.pendingUrl === blankView.entryUrl
    && deferredEntryPage.view.webContents.getURL() === "";
  const blankTarget = new URL(blankView.entryUrl);
  await handleDesktopWebViewAction(blankState.id, { type: "navigate", url: `${blankTarget.host}/upload` });
  await waitForDesktopWebTitle(blankView, "Upload fixture");
  const shorthandAddressLoaded = activeDesktopWebPage(blankView).view.webContents.getURL() === `${blankView.entryOrigin}/upload`;
  const reorderedBlankState = await handleDesktopWebViewAction(blankState.id, {
    type: "reorder-pages",
    orderedPageIds: blankState.pages.map((page) => page.id).reverse(),
  });
  const tabsReordered = reorderedBlankState.pages[0]?.id === blankState.pages[1]?.id
    && reorderedBlankState.pages[1]?.id === blankState.pages[0]?.id;
  const activatedEntryState = await handleDesktopWebViewAction(blankState.id, { type: "activate-page", pageId: blankState.pages[0]?.id });
  const defaultAddressPreserved = activatedEntryState.activePageId === blankState.pages[0]?.id
    && activatedEntryState.url === blankView.entryUrl;
  await handleDesktopWebViewAction(blankState.id, { type: "activate-page", pageId: blankState.pages[1]?.id });
  await handleDesktopWebViewAction(blankState.id, { type: "navigate", url: `${blankTarget.host}/` });
  await waitForDesktopWebTitle(blankView, "Login");
  await handleDesktopWebViewAction(blankState.id, { type: "refill" });
  await waitForDesktopWebTitle(blankView, `Logged ${username}`);
  const manualRefillOnCurrentPage = activeDesktopWebPage(blankView).view.webContents.getTitle() === `Logged ${username}`;
  await activeDesktopWebPage(blankView).view.webContents.executeJavaScript(`localStorage.setItem("viron-persist-smoke", "present")`);
  await activeDesktopWebPage(blankView).view.webContents.loadURL(`${blankView.entryOrigin}/upload`);
  await waitForDesktopWebTitle(blankView, "Upload fixture");
  await closeDesktopWebView(blankState.id);
  const managedState = await openDesktopWebView(credentialId, { x: 40, y: 120, width: 900, height: 620 });
  const managed = localWebView(managedState.id);
  await waitForDesktopWebTitle(managed, "Upload fixture");
  const lastLocationRestored = activeDesktopWebPage(managed).view.webContents.getURL() === `${managed.entryOrigin}/upload`;
  const sessionStatePersisted = await activeDesktopWebPage(managed).view.webContents.executeJavaScript(`localStorage.getItem("viron-persist-smoke") === "present"`) as boolean;
  const initialPage = activeDesktopWebPage(managed).view.webContents;
  const devToolsOpened = initialPage.isDevToolsOpened()
    ? Promise.resolve()
    : new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error(tr("等待网页检查器打开超时"))), 10_000);
      initialPage.once("devtools-opened", () => {
        clearTimeout(timeout);
        resolveOpen();
      });
    });
  inspectDesktopWebElement(initialPage, 8, 8);
  await devToolsOpened;
  initialPage.closeDevTools();
  await initialPage.executeJavaScript(`localStorage.setItem("viron-reset-smoke", "present")`);
  await resetDesktopWebView(managed);
  await waitForDesktopWebTitle(managed, `Logged ${username}`);
  const resetCleared = await activeDesktopWebPage(managed).view.webContents.executeJavaScript(`localStorage.getItem("viron-reset-smoke") === null`) as boolean;

  let uploadSelected: boolean | null = null;
  if (uploadPath) {
    const uploadPage = activeDesktopWebPage(managed).view.webContents;
    await uploadPage.loadURL(`${managed.entryOrigin}/upload`);
    await waitForDesktopWebTitle(managed, "Upload fixture");
    uploadPage.debugger.attach("1.3");
    try {
      const document = await uploadPage.debugger.sendCommand("DOM.getDocument") as { root: { nodeId: number } };
      const input = await uploadPage.debugger.sendCommand("DOM.querySelector", { nodeId: document.root.nodeId, selector: "input[type=file]" }) as { nodeId: number };
      await uploadPage.debugger.sendCommand("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [uploadPath] });
    } finally {
      uploadPage.debugger.detach();
    }
    await waitForDesktopWebTitle(managed, `Selected ${basename(uploadPath)}`);
    uploadSelected = true;
  }

  const downloadPage = activeDesktopWebPage(managed).view.webContents;
  await downloadPage.loadURL(`${managed.entryOrigin}/download`);
  await waitForDesktopWebTitle(managed, "Download fixture");
  managed.notice = null;
  await downloadPage.executeJavaScript(`document.querySelector("a[download]").click()`);
  await waitForDesktopWebNotice(managed, "success");
  return { opened: true, blankOpenedWithoutEntry: blankOpenedWithoutEntry && shorthandAddressLoaded && defaultAddressPreserved, manualRefillOnCurrentPage, sessionStatePersisted, lastLocationRestored, tabsReordered, inspectorOpened: true, resetCleared, uploadSelected, downloadTriggered: true };
}

async function runDesktopSshSmoke(connectionId: string): Promise<{
  opened: boolean;
  textInputEchoed: boolean;
  binaryInputEchoed: boolean;
  resized: boolean;
  agentContextRead: boolean;
  recordingCompleted: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    const connectionId = ${JSON.stringify(connectionId)};
    const output = [];
    let sessionId = "";
    let unsubscribe = null;
    const append = (value) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      for (const byte of bytes) output.push(byte);
    };
    const includes = (needle) => output.some((_, index) => needle.every((byte, offset) => output[index + offset] === byte));
    const waitForOutput = (predicate) => new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + 10000;
      const inspect = () => {
        if (predicate()) return resolveWait();
        if (Date.now() >= deadline) return rejectWait(new Error("等待本机 SSH 输出超时：" + new TextDecoder().decode(Uint8Array.from(output))));
        setTimeout(inspect, 20);
      };
      inspect();
    });
    try {
      unsubscribe = window.vironDesktop.onSshSessionEvent((event) => {
        if (event.sessionId === sessionId && event.type === "output") append(event.data);
      });
      const opened = await window.vironDesktop.openSshSession({ connectionId, cols: 100, rows: 30 });
      sessionId = opened.session.id;
      const attached = await window.vironDesktop.attachSshSession(sessionId, opened.ticket);
      const initial = atob(attached.output);
      append(Uint8Array.from(initial, (character) => character.charCodeAt(0)));
      await waitForOutput(() => new TextDecoder().decode(Uint8Array.from(output)).includes("DESKTOP-SSH-READY"));
      await window.vironDesktop.sshSessionAction(sessionId, { type: "resize", cols: 132, rows: 40 });
      await window.vironDesktop.sshSessionAction(sessionId, { type: "input", data: "desktop-smoke\\n" });
      const binary = Uint8Array.from([0, 24, 255, 15, 128]);
      await window.vironDesktop.sshSessionAction(sessionId, { type: "binary", data: binary.buffer });
      await waitForOutput(() => new TextDecoder().decode(Uint8Array.from(output)).includes("ECHO:desktop-smoke"));
      await waitForOutput(() => includes([...new TextEncoder().encode("ECHO:"), ...binary]));
      await window.vironDesktop.sshSessionAction(sessionId, { type: "input", data: "token=desktop-agent-secret\\n" });
      await waitForOutput(() => new TextDecoder().decode(Uint8Array.from(output)).includes("desktop-agent-secret"));
      const agentContext = await window.vironDesktop.readAgentSshContext(sessionId);
      await window.vironDesktop.closeSshSession(sessionId);
      const recordings = await window.vironDesktop.listSshRecordings();
      resolve({
        opened: true,
        textInputEchoed: true,
        binaryInputEchoed: true,
        resized: true,
        agentContextRead: agentContext.sessionId === sessionId
          && agentContext.output.includes("token=[REDACTED]")
          && !agentContext.output.includes("desktop-agent-secret")
          && agentContext.includedBytes <= 3072
          && !("credential" in agentContext),
        recordingCompleted: recordings.items.some((item) => item.sessionId === sessionId && item.status === "completed"),
      });
    } catch (error) {
      if (sessionId) await window.vironDesktop.closeSshSession(sessionId).catch(() => undefined);
      reject(error);
    } finally {
      unsubscribe?.();
    }
  })`);
}

async function runDesktopLogSmoke(environmentId: string, logId: string): Promise<{
  opened: boolean;
  outputReceived: boolean;
  stopped: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    const environmentId = ${JSON.stringify(environmentId)};
    const logId = ${JSON.stringify(logId)};
    let streamId = "";
    let output = "";
    let stopped = false;
    let unsubscribe = null;
    const waitFor = (predicate, label) => new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + 10000;
      const inspect = () => {
        if (predicate()) return resolveWait();
        if (Date.now() >= deadline) return rejectWait(new Error("等待本机日志" + label + "超时：" + output));
        setTimeout(inspect, 20);
      };
      inspect();
    });
    try {
      unsubscribe = window.vironDesktop.onLogStreamEvent((event) => {
        if (event.logId !== logId) return;
        if (event.type === "output" || event.type === "stderr") output += event.data;
        else if (event.type === "closed") stopped = true;
        else if (event.type === "error") reject(new Error(event.message));
      });
      const opened = await window.vironDesktop.openLogStream({ environmentId, logId, initialLines: 200 });
      streamId = opened.stream.id;
      await waitFor(() => output.includes("DESKTOP-LOG-READY"), "输出");
      await window.vironDesktop.closeLogStream(streamId);
      await waitFor(() => stopped, "停止");
      resolve({ opened: true, outputReceived: true, stopped: true });
    } catch (error) {
      if (streamId) await window.vironDesktop.closeLogStream(streamId).catch(() => undefined);
      reject(error);
    } finally {
      unsubscribe?.();
    }
  })`);
}

async function runDesktopDatabaseSmoke(connectionId: string): Promise<{
  tested: boolean;
  queried: boolean;
  cancelled: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    const connectionId = ${JSON.stringify(connectionId)};
    const request = async (path, init = {}) => {
      const response = await window.vironDesktop.request({
        path,
        method: init.method,
        headers: init.body === undefined ? undefined : [["content-type", "application/json"]],
        body: init.body === undefined ? undefined : { kind: "text", value: JSON.stringify(init.body) },
      });
      const body = response.body ? JSON.parse(response.body) : undefined;
      if (response.status < 200 || response.status >= 300) throw new Error(body?.message || "本机数据库请求失败（" + response.status + "）");
      return body;
    };
    const waitForJob = async (id) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const response = await request("/api/v1/database-queries/" + id);
        if (!['pending', 'running'].includes(response.job.status)) return response.job;
        await new Promise((resolveWait) => setTimeout(resolveWait, 40));
      }
      throw new Error("等待本机数据库查询超时");
    };
    try {
      const tested = await request("/api/v1/database-connections/" + connectionId + "/test", { method: "POST" });
      const started = await request("/api/v1/database-connections/" + connectionId + "/queries", {
        method: "POST",
        body: { database: "", sql: "SELECT 'DESKTOP-DATABASE-READY' AS marker" },
      });
      const completed = await waitForJob(started.job.id);
      const marker = completed.resultSets?.[0]?.rows?.[0]?.marker;
      const cancellable = await request("/api/v1/database-connections/" + connectionId + "/queries", {
        method: "POST",
        body: { database: "", sql: "SELECT 'DESKTOP-DATABASE-CANCEL' AS marker" },
      });
      const cancelledResponse = await window.vironDesktop.request({
        path: "/api/v1/database-queries/" + cancellable.job.id,
        method: "DELETE",
      });
      const cancelled = await waitForJob(cancellable.job.id);
      resolve({
        tested: tested.ok === true && Boolean(tested.version),
        queried: completed.status === "success" && marker === "DESKTOP-DATABASE-READY",
        cancelled: cancelledResponse.status === 204 && cancelled.status === "cancelled",
      });
    } catch (error) {
      reject(error);
    }
  })`);
}

async function runDesktopInspectionSmoke(sshConnectionId: string, databaseConnectionId: string): Promise<{
  total: number;
  available: number;
  sshAvailable: boolean;
  databaseAvailable: boolean;
  credentialsHidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    try {
      const items = [
        { type: "ssh", id: ${JSON.stringify(sshConnectionId)} },
        { type: "database", id: ${JSON.stringify(databaseConnectionId)} },
      ];
      const response = await window.vironDesktop.request({
        path: "/api/v1/connections/inspect",
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: { kind: "text", value: JSON.stringify({ items }) },
      });
      const body = response.body ? JSON.parse(response.body) : {};
      if (response.status < 200 || response.status >= 300) throw new Error(body.message || "本机连接巡检失败（" + response.status + "）");
      resolve({
        total: body.summary.total,
        available: body.summary.available,
        sshAvailable: body.items.some((item) => item.type === "ssh" && item.status === "available"),
        databaseAvailable: body.items.some((item) => item.type === "database" && item.status === "available"),
        credentialsHidden: body.items.every((item) => !["credential", "password", "options", "sshCredential"].some((key) => key in item)),
      });
    } catch (error) {
      reject(error);
    }
  })`);
}

async function waitForDesktopWindowSnapshot(window: BrowserWindow, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (!(await window.webContents.capturePage()).isEmpty()) return true;
    } catch {
      // Chromium's compositor may not have a surface immediately after a transparent child window is shown.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function runDesktopImmersiveNavigationSmoke(): Promise<{
  rendered: boolean;
  snapshot: boolean;
  webViewStayedVisible: boolean;
  snappedTop: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  testView.setBounds({ x: 120, y: 120, width: 420, height: 280 });
  testView.setVisible(true);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL("data:text/html,<main style='background:white'>IMMERSIVE-WEB-VIEW</main>");
  const base: ImmersiveNavigationState = {
    visible: true,
    expanded: false,
    dark: false,
    dock: { edge: "right", offset: 0.5 },
    environmentName: tr("沉浸导航烟测环境"),
    activeTab: "web",
    webExpanded: true,
    expandedEntryId: "entry-smoke",
    selectedEntryId: "entry-smoke",
    selectedCredentialId: "credential-smoke",
    counts: { web: 1, ssh: 2, logs: 3, database: 4, redis: 5, knowledge: 6, maintenance: 0 },
    maintenanceHostCount: 0,
    entries: [{
      id: "entry-smoke",
      name: tr("烟测控制台"),
      credentialCount: 1,
      credentials: [{ id: "credential-smoke", username: "smoke-user" }],
      loading: false,
    }],
  };
  try {
    await updateImmersiveNavigationWindow(base);
    await updateImmersiveNavigationWindow({ ...base, expanded: true });
    const rendered = await immersiveNavigationWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        if (document.body.innerText.includes(${JSON.stringify(tr("沉浸导航烟测环境"))}) && document.body.innerText.includes('smoke-user')) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('沉浸导航未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as boolean;
    const snapshot = await waitForDesktopWindowSnapshot(immersiveNavigationWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    await updateImmersiveNavigationWindow({ ...base, dock: { edge: "top", offset: 0.5 } });
    const topBounds = immersiveNavigationWindow!.getBounds();
    const snappedTop = topBounds.y === immersiveNavigationViewport().y && topBounds.width === 48 && topBounds.height === 34;
    await updateImmersiveNavigationWindow(null);
    return { rendered, snapshot, webViewStayedVisible, snappedTop, hidden: !immersiveNavigationWindow!.isVisible() };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
  }
}

async function runDesktopAgentLauncherSmoke(): Promise<{
  rendered: boolean;
  exactButtonSize: boolean;
  glowClearance: boolean;
  compactInteraction: boolean;
  nonFocusable: boolean;
  passivePointerStable: boolean;
  snapshot: boolean;
  webViewStayedVisible: boolean;
  actionDelivered: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  testView.setBounds({ x: 240, y: 240, width: 420, height: 280 });
  testView.setVisible(true);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL("data:text/html,<main style='background:white'>AGENT-LAUNCHER-WEB-VIEW</main>");
  const state: AgentFloatingOverlayState = {
    bounds: { x: 280, y: 240, width: 288, height: 288 },
    rootOffset: { x: 112, y: 112 },
    open: false,
    running: false,
    dragging: false,
    edgeCollapsed: false,
    snappedEdge: null,
    label: tr("打开 Viron Agent"),
  };
  try {
    await updateAgentLauncherWindow(state);
    const inspected = await agentLauncherVisualWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const button = document.querySelector('.agent-floating__button');
        if (button) {
          const rect = button.getBoundingClientRect();
          const glowClearance = rect.left >= 110 && rect.top >= 110
            && window.innerWidth - rect.right >= 110 && window.innerHeight - rect.bottom >= 110;
          return resolve({ rendered: button.getAttribute('aria-label') === ${JSON.stringify(tr("打开 Viron Agent"))}, exactButtonSize: rect.width === 64 && rect.height === 64, glowClearance });
        }
        if (Date.now() >= deadline) return reject(new Error('Agent 悬浮按钮未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { rendered: boolean; exactButtonSize: boolean; glowClearance: boolean };
    const actionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      window.__agentLauncherSmokeActions = [];
      const stop = window.vironDesktop.onAgentLauncherAction((action) => {
        window.__agentLauncherSmokeActions.push(action.type);
        if (action.type === 'toggle') { stop(); resolve(true); }
      });
      window.__agentLauncherSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__agentLauncherSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('Agent 悬浮按钮烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    agentLauncherVisualWindow!.webContents.sendInputEvent({ type: "mouseMove", x: 8, y: 8 });
    const passivePointerStable = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      setTimeout(() => resolve(window.__agentLauncherSmokeActions.length === 0), 50);
    })`) as boolean;
    const interactionState = agentFloatingOverlayInteractionState(state);
    const buttonCenter = { x: interactionState.rootOffset.x + 32, y: interactionState.rootOffset.y + 32 };
    agentLauncherWindow!.webContents.sendInputEvent({ type: "mouseMove", ...buttonCenter });
    agentLauncherWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...buttonCenter });
    agentLauncherWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...buttonCenter });
    const actionDelivered = await actionPromise;
    const snapshot = await waitForDesktopWindowSnapshot(agentLauncherVisualWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    const interactionBounds = agentLauncherWindow!.getBounds();
    const compactInteraction = interactionBounds.width === 64 && interactionBounds.height === 64;
    const nonFocusable = !agentLauncherWindow!.isFocusable() && !agentLauncherVisualWindow!.isFocusable();
    await updateAgentLauncherWindow(null);
    return {
      ...inspected,
      compactInteraction,
      nonFocusable,
      passivePointerStable,
      snapshot,
      webViewStayedVisible,
      actionDelivered,
      hidden: !agentLauncherWindow!.isVisible() && !agentLauncherVisualWindow!.isVisible(),
    };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
    await updateAgentLauncherWindow(null);
  }
}

async function runDesktopConnectionQualitySmoke(): Promise<{
  rendered: boolean;
  exactPanelSize: boolean;
  noHeader: boolean;
  expandedContentFits: boolean;
  testButtonClearance: boolean;
  compactInteraction: boolean;
  nonFocusable: boolean;
  snapshot: boolean;
  webViewStayedVisible: boolean;
  actionDelivered: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  testView.setBounds({ x: 760, y: 100, width: 500, height: 360 });
  testView.setVisible(true);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL("data:text/html,<main style='height:100vh;background:white'>CONNECTION-QUALITY-WEB-VIEW</main>");
  const link = {
    latencyMs: 18,
    jitterMs: 3,
    failureRate: 0,
    status: "good" as const,
    uploadBytesPerSecond: 12_000,
    downloadBytesPerSecond: 48_000,
  };
  const state: ConnectionQualityOverlayState = {
    bounds: { x: 814, y: 44, width: CONNECTION_QUALITY_PANEL_WIDTH + 72, height: CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT + 72 },
    rootOffset: { x: 36, y: 36 },
    panelSize: { width: CONNECTION_QUALITY_PANEL_WIDTH, height: CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT },
    expanded: false,
    dragging: false,
    testing: false,
    service: { id: "service", label: "Viron", detail: "http://127.0.0.1", ...link },
    target: {
      id: randomUUID(), type: "ssh", executionMode: "server", label: tr("烟测目标"), detail: "smoke",
      lastActivityAt: new Date().toISOString(), ...link,
    },
    targets: [],
    speedTest: null,
  };
  state.targets = [state.target!];
  try {
    await updateConnectionQualityWindow(state);
    const inspected = await connectionQualityVisualWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const panel = document.querySelector('[data-connection-quality-card]');
        if (panel) {
          const rect = panel.getBoundingClientRect();
          return resolve({
            rendered: document.body.innerText.includes(${JSON.stringify(tr("烟测目标"))}),
            exactPanelSize: rect.width === ${CONNECTION_QUALITY_PANEL_WIDTH} && rect.height === ${CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT},
            noHeader: !document.querySelector('.connection-quality-card__header'),
          });
        }
        if (Date.now() >= deadline) return reject(new Error('连接质量面板未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { rendered: boolean; exactPanelSize: boolean; noHeader: boolean };
    const actionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const stop = window.vironDesktop.onConnectionQualityAction((action) => {
        if (action.type === 'toggle-details') { stop(); resolve(true); }
      });
      window.__connectionQualitySmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__connectionQualitySmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('连接质量烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const toggle = await connectionQualityWindow!.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-connection-quality-card]');
      const rect = panel.getBoundingClientRect();
      return { x: Math.round(rect.left + 24), y: Math.round(rect.top + 24) };
    })()`) as { x: number; y: number };
    connectionQualityWindow!.webContents.sendInputEvent({ type: "mouseMove", ...toggle });
    connectionQualityWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...toggle });
    connectionQualityWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...toggle });
    const actionDelivered = await actionPromise;
    const compactBounds = connectionQualityWindow!.getBounds();
    const compactInteraction = compactBounds.width === CONNECTION_QUALITY_PANEL_WIDTH
      && compactBounds.height === CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT;
    const expandedState: ConnectionQualityOverlayState = {
      ...state,
      expanded: true,
      bounds: {
        ...state.bounds,
        height: CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT + 72,
      },
      panelSize: {
        width: CONNECTION_QUALITY_PANEL_WIDTH,
        height: CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT,
      },
    };
    await updateConnectionQualityWindow(expandedState);
    const expandedInspection = await connectionQualityVisualWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const panel = document.querySelector('[data-connection-quality-card]');
        const button = panel?.querySelector('footer button');
        const panelRect = panel?.getBoundingClientRect();
        if (panel && button && Math.round(panelRect.height) === ${CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT}) {
          const buttonRect = button.getBoundingClientRect();
          return resolve({
            expandedContentFits: panel.scrollHeight <= panel.clientHeight,
            testButtonClearance: panelRect.bottom - buttonRect.bottom >= 8,
          });
        }
        if (Date.now() >= deadline) return reject(new Error('连接质量面板展开内容未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { expandedContentFits: boolean; testButtonClearance: boolean };
    const snapshot = await waitForDesktopWindowSnapshot(connectionQualityVisualWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    const nonFocusable = !connectionQualityWindow!.isFocusable() && !connectionQualityVisualWindow!.isFocusable();
    await updateConnectionQualityWindow(null);
    return {
      ...inspected,
      ...expandedInspection,
      compactInteraction,
      nonFocusable,
      snapshot,
      webViewStayedVisible,
      actionDelivered,
      hidden: !connectionQualityWindow!.isVisible() && !connectionQualityVisualWindow!.isVisible(),
    };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
    await updateConnectionQualityWindow(null);
  }
}

async function runDesktopActiveEnvironmentDockSmoke(): Promise<{
  rendered: boolean;
  collapsedPanelSize: boolean;
  expandedPanelSize: boolean;
  collapsedStacked: boolean;
  expandedStacked: boolean;
  expandedAligned: boolean;
  anchorStable: boolean;
  expandedContentFits: boolean;
  rendererPreviewPixels: boolean;
  previewPixels: boolean;
  previewFrameChanged: boolean;
  retainedPreviewPixels: boolean;
  nonInteractivePreview: boolean;
  dragPositionDelivered: boolean;
  closeActionDelivered: boolean;
  closeStateRemoved: boolean;
  snapshot: boolean;
  nonFocusable: boolean;
  passiveHoverFocusStable: boolean;
  hoverIntentStable: boolean;
  nativePointerTrackingStable: boolean;
  collapseAnimationStable: boolean;
  collapseResizeSynchronized: boolean;
  lightweightLayoutStable: boolean;
  programmaticMoveIgnored: boolean;
  webViewStayedVisible: boolean;
  nativeAboveWebView: boolean;
  actionDelivered: boolean;
  hidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const rendererPreviewBounds = await mainWindow.webContents.executeJavaScript(`(() => {
    const marker = document.createElement('div');
    marker.id = 'active-environment-renderer-preview-smoke';
    marker.style.cssText = 'position:fixed;left:24px;top:24px;width:320px;height:180px;z-index:2147483647;background:#155e75;color:white;display:grid;place-items:center;font:700 28px sans-serif';
    marker.textContent = 'SSH-RENDERER-PREVIEW';
    document.body.appendChild(marker);
    const rect = marker.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`) as Rectangle;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const rendererPreview = await captureDesktopRendererPreview(rendererPreviewBounds);
  await mainWindow.webContents.executeJavaScript("document.querySelector('#active-environment-renderer-preview-smoke')?.remove()", true);
  const rendererPreviewPixels = Boolean(rendererPreview);
  const testView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  const testViewBounds = { x: 180, y: 130, width: 520, height: 360 };
  testView.setBounds(testViewBounds);
  testView.setVisible(true);
  testView.webContents.setBackgroundThrottling(false);
  mainWindow.contentView.addChildView(testView);
  await testView.webContents.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#0d5f52;color:white;font:700 34px sans-serif;display:grid;place-items:center;height:100vh"><main>ACTIVE-ENVIRONMENT-PIP</main><script>let on=false;setInterval(()=>{on=!on;document.body.style.background=on?'#b23a48':'#0d5f52'},90)</script></body></html>`)}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  desktopSmokeStage("dock-preview-visible-first");
  const firstPreview = await captureWebContentsPreview(testView.webContents);
  await testView.webContents.executeJavaScript("document.querySelector('main').textContent='ACTIVE-ENVIRONMENT-PIP-UPDATED'; document.body.style.background='#facc15'; document.body.offsetHeight", true);
  desktopSmokeStage("dock-preview-visible-second");
  let secondPreview = "";
  const previewDeadline = Date.now() + 3_000;
  while (Date.now() < previewDeadline && (!secondPreview || secondPreview === firstPreview)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    secondPreview = await captureWebContentsPreview(testView.webContents);
  }
  const previewFrameChanged = Boolean(firstPreview && secondPreview && firstPreview !== secondPreview);
  testView.setVisible(false);
  desktopSmokeStage("dock-preview-retained");
  const retainedPreviewPixels = Boolean(secondPreview);
  testView.setVisible(true);
  const now = Date.now();
  const environments = [
    {
      id: "dock-smoke-environment-a",
      name: "DOCK-SMOKE-ENVIRONMENT-A",
      lastActivityAt: new Date(now).toISOString(),
      preview: { dataUrl: rendererPreview, updatedAt: now },
      connections: [
        { id: "dock-smoke-ssh", type: "ssh" as const, label: "DOCK-SMOKE-SSH", resourceId: randomUUID(), executionMode: "local" as const, lastActivityAt: new Date(now).toISOString(), status: "active" as const },
      ],
    },
    {
      id: "dock-smoke-environment-b",
      name: "DOCK-SMOKE-ENVIRONMENT-B",
      lastActivityAt: new Date(now - 1_000).toISOString(),
      preview: { dataUrl: secondPreview, updatedAt: now },
      connections: [
        { id: "dock-smoke-database", type: "database" as const, label: "DOCK-SMOKE-DATABASE", resourceId: randomUUID(), executionMode: "server" as const, lastActivityAt: new Date(now - 1_000).toISOString(), status: "active" as const },
      ],
    },
  ];
  const contentViewport = mainWindow.getContentBounds();
  const viewport = { width: contentViewport.width, height: contentViewport.height };
  const card = activeEnvironmentDockCardSize(viewport);
  const collapsedSize = activeEnvironmentDockPanelSize(false, environments, viewport);
  const collapsedState: ActiveEnvironmentDockState = {
    bounds: { x: 240, y: 170, ...collapsedSize },
    card,
    expanded: false,
    growUp: false,
    dragging: false,
    dark: false,
    language: currentDesktopLanguage(),
    environments,
  };
  const updateLayoutFromRenderer = async (state: ActiveEnvironmentDockState): Promise<void> => {
    const layout = activeEnvironmentDockLayoutSnapshot(state);
    await mainWindow!.webContents.executeJavaScript(
      `window.vironDesktop.updateActiveEnvironmentDockLayout(${JSON.stringify(layout)})`,
    );
  };
  try {
    await updateActiveEnvironmentDockWindow(collapsedState);
    const collapsedInspection = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const panel = document.querySelector('[data-active-environment-dock]');
        const cards = [...document.querySelectorAll('.active-environment-pip__card')];
        const images = [...document.querySelectorAll('.active-environment-pip__visual img')];
        if (panel && cards.length === 2 && images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0)) {
          window.__activeEnvironmentDockLayoutCards = cards;
          window.__activeEnvironmentDockLayoutImages = images;
          const rect = panel.getBoundingClientRect();
          const first = cards[0].getBoundingClientRect();
          const second = cards[1].getBoundingClientRect();
          const visual = document.querySelector('.active-environment-pip__visual');
          return resolve({
            collapsedPanelSize: rect.width === ${collapsedSize.width} && rect.height === ${collapsedSize.height},
            collapsedStacked: second.top > first.top && second.top - first.top <= 12 && Math.abs(second.left - first.left) <= 8,
            firstLeft: first.left,
            firstTop: first.top,
            previewPixels: images.every((image) => image.src.startsWith('data:image/png') || image.src.startsWith('data:image/jpeg')),
            nonInteractivePreview: visual && getComputedStyle(visual).pointerEvents === 'none' && !visual.querySelector('button,input,a'),
          });
        }
        if (Date.now() >= deadline) return reject(new Error('活动环境画中画折叠状态未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { collapsedPanelSize: boolean; collapsedStacked: boolean; firstLeft: number; firstTop: number; previewPixels: boolean; nonInteractivePreview: boolean };
    if (process.platform === "darwin") app.focus({ steal: true });
    mainWindow.focus();
    const focusDeadline = Date.now() + 2_000;
    while (!mainWindow.isFocused() && Date.now() < focusDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const focusedBeforeHover = mainWindow.isFocused();
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", x: 12, y: 12 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const passiveHoverFocusStable = focusedBeforeHover && mainWindow.isFocused();
    const nonFocusable = !activeEnvironmentDockWindow!.isFocusable();
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockHoverActions = [];
      window.__activeEnvironmentDockHoverStop?.();
      window.__activeEnvironmentDockHoverStop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'expand' || action.type === 'collapse') window.__activeEnvironmentDockHoverActions.push(action.type);
      });
      return true;
    })()`);
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`document.querySelector('[data-active-environment-dock]')?.dispatchEvent(new MouseEvent('mouseenter'))`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions = []");
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve) => {
      const panel = document.querySelector('[data-active-environment-dock]');
      panel?.dispatchEvent(new MouseEvent('mouseleave'));
      setTimeout(() => panel?.dispatchEvent(new MouseEvent('mouseenter')), 80);
      setTimeout(resolve, 360);
    })`);
    const quickReentryActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions = []");
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve) => {
      document.querySelector('[data-active-environment-dock]')?.dispatchEvent(new MouseEvent('mouseleave'));
      setTimeout(resolve, 360);
    })`);
    const sustainedLeaveActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockHoverStop?.();
      delete window.__activeEnvironmentDockHoverStop;
      delete window.__activeEnvironmentDockHoverActions;
    })()`);
    const hoverIntentStable = !quickReentryActions.includes("collapse")
      && sustainedLeaveActions.filter((type) => type === "collapse").length === 1;
    const collapsedBounds = activeEnvironmentDockWindow!.getBounds();
    const collapsedWindowSize = collapsedBounds.width === collapsedSize.width && collapsedBounds.height === collapsedSize.height;
    const expandedSize = activeEnvironmentDockPanelSize(true, environments, viewport);
    const expandedState: ActiveEnvironmentDockState = {
      ...collapsedState,
      expanded: true,
      bounds: { ...collapsedState.bounds, ...expandedSize },
    };
    await updateLayoutFromRenderer(expandedState);
    const inspected = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const panel = document.querySelector('[data-active-environment-dock]');
        const viewport = document.querySelector('.active-environment-pip__viewport');
        const cards = [...document.querySelectorAll('.active-environment-pip__card')];
        if (panel && viewport && cards.length === 2 && document.body.innerText.includes('DOCK-SMOKE-ENVIRONMENT-A') && document.body.innerText.includes('DOCK-SMOKE-DATABASE')) {
          const rect = panel.getBoundingClientRect();
          const first = cards[0].getBoundingClientRect();
          const second = cards[1].getBoundingClientRect();
          const expandedStacked = second.top - first.top >= ${card.height + 6};
          const expandedAligned = Math.abs(second.left - first.left) <= 1;
          const layoutCards = window.__activeEnvironmentDockLayoutCards || [];
          const layoutImages = window.__activeEnvironmentDockLayoutImages || [];
          if (!expandedStacked && Date.now() < deadline) return setTimeout(inspect, 20);
          return resolve({
            rendered: true,
            expandedPanelSize: rect.width === ${expandedSize.width} && rect.height === ${expandedSize.height},
            expandedStacked,
            expandedAligned,
            anchorStable: Math.abs(first.left - ${collapsedInspection.firstLeft}) <= 1 && Math.abs(first.top - ${collapsedInspection.firstTop}) <= 1,
            expandedContentFits: viewport.scrollHeight <= viewport.clientHeight,
            lightweightLayoutStable: cards.every((card, index) => card === layoutCards[index])
              && [...document.querySelectorAll('.active-environment-pip__visual img')].every((image, index) => image === layoutImages[index]),
          });
        }
        if (Date.now() >= deadline) return reject(new Error('活动环境画中画展开状态未完成渲染'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as { rendered: boolean; expandedPanelSize: boolean; expandedStacked: boolean; expandedAligned: boolean; anchorStable: boolean; expandedContentFits: boolean; lightweightLayoutStable: boolean };
    await updateLayoutFromRenderer(collapsedState);
    const collapseStartBounds = activeEnvironmentDockWindow!.getBounds();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const collapseAnimationInspection = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-active-environment-dock]');
      const card = document.querySelectorAll('.active-environment-pip__card')[1];
      if (!panel || !card) return { panelRetained: false, compositorOnly: false };
      const transitionProperties = getComputedStyle(card).transitionProperty.split(',').map((value) => value.trim());
      return {
        panelRetained: panel.getBoundingClientRect().height === ${expandedSize.height},
        compositorOnly: transitionProperties.includes('transform')
          && !transitionProperties.includes('top')
          && !transitionProperties.includes('bottom')
          && !transitionProperties.includes('left'),
      };
    })()`) as { panelRetained: boolean; compositorOnly: boolean };
    const collapseBoundsDeferred = collapseStartBounds.width === expandedSize.width && collapseStartBounds.height === expandedSize.height;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS - 40 + 8)));
    const collapsePreResizeBounds = activeEnvironmentDockWindow!.getBounds();
    const collapsePreResizePanelHeight = await activeEnvironmentDockWindow!.webContents.executeJavaScript(
      "document.querySelector('[data-active-environment-dock]')?.getBoundingClientRect().height",
    ) as number;
    const collapseResizeSynchronized = collapsePreResizePanelHeight === collapsePreResizeBounds.height;
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS + 100));
    const collapseEndBounds = activeEnvironmentDockWindow!.getBounds();
    const collapsePanelSettled = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`document.querySelector('[data-active-environment-dock]')?.getBoundingClientRect().height === ${collapsedSize.height}`) as boolean;
    const collapseAnimationStable = collapseBoundsDeferred
      && collapseAnimationInspection.panelRetained
      && collapseAnimationInspection.compositorOnly
      && collapseEndBounds.width === collapsedSize.width
      && collapseEndBounds.height === collapsedSize.height
      && collapsePanelSettled;
    await updateLayoutFromRenderer(expandedState);
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const panel = document.querySelector('[data-active-environment-dock]');
        if (panel?.classList.contains('is-expanded') && panel.getBoundingClientRect().height === ${expandedSize.height}) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('活动环境画中画重新展开未完成'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`);
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockNativeHoverActions = [];
      window.__activeEnvironmentDockNativeHoverStop?.();
      window.__activeEnvironmentDockNativeHoverStop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'collapse') window.__activeEnvironmentDockNativeHoverActions.push(action.type);
      });
      return true;
    })()`);
    const cursor = electronScreen.getCursorScreenPoint();
    const workArea = electronScreen.getDisplayNearestPoint(cursor).workArea;
    const hoverWidth = Math.min(expandedSize.width, workArea.width);
    const hoverHeight = Math.min(expandedSize.height, workArea.height);
    const hoverBounds = {
      x: Math.min(Math.max(workArea.x, cursor.x - Math.round(hoverWidth / 2)), workArea.x + workArea.width - hoverWidth),
      y: Math.min(Math.max(workArea.y, cursor.y - Math.round(hoverHeight / 2)), workArea.y + workArea.height - hoverHeight),
      width: hoverWidth,
      height: hoverHeight,
    };
    stopActiveEnvironmentDockPointerTracking();
    activeEnvironmentDockWindow!.setBounds(hoverBounds, false);
    scheduleActiveEnvironmentDockPointerTracking();
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS + 180));
    const pointerInsideActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockNativeHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockNativeHoverActions = []");
    const awaySize = 80;
    activeEnvironmentDockWindow!.setBounds({
      x: cursor.x < workArea.x + workArea.width / 2 ? workArea.x + workArea.width - awaySize : workArea.x,
      y: cursor.y < workArea.y + workArea.height / 2 ? workArea.y + workArea.height - awaySize : workArea.y,
      width: awaySize,
      height: awaySize,
    }, false);
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS + 260));
    const pointerOutsideActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockNativeHoverActions") as string[];
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockNativeHoverStop?.();
      delete window.__activeEnvironmentDockNativeHoverStop;
      delete window.__activeEnvironmentDockNativeHoverActions;
    })()`);
    const nativePointerTrackingStable = !pointerInsideActions.includes("collapse")
      && pointerOutsideActions.filter((type) => type === "collapse").length === 1;
    await updateLayoutFromRenderer(expandedState);
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockProgrammaticMoveActions = [];
      window.__activeEnvironmentDockProgrammaticMoveStop?.();
      window.__activeEnvironmentDockProgrammaticMoveStop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'position') window.__activeEnvironmentDockProgrammaticMoveActions.push(action);
      });
      return true;
    })()`);
    const programmaticBounds = activeEnvironmentDockWindow!.getBounds();
    activeEnvironmentDockWindow!.setPosition(programmaticBounds.x, programmaticBounds.y + 24, false);
    await new Promise((resolve) => setTimeout(resolve, 320));
    const programmaticMoveActions = await mainWindow.webContents.executeJavaScript("window.__activeEnvironmentDockProgrammaticMoveActions") as unknown[];
    await mainWindow.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockProgrammaticMoveStop?.();
      delete window.__activeEnvironmentDockProgrammaticMoveStop;
      delete window.__activeEnvironmentDockProgrammaticMoveActions;
    })()`);
    const programmaticMoveIgnored = programmaticMoveActions.length === 0;
    await updateLayoutFromRenderer(expandedState);
    const dragPositionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const timeout = setTimeout(() => { stop(); resolve(false); }, 3000);
      const stop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'position') { clearTimeout(timeout); stop(); resolve(Number.isFinite(action.x) && Number.isFinite(action.y)); }
      });
      window.__activeEnvironmentDockDragSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__activeEnvironmentDockDragSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('画中画拖动烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const dragCenter = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.active-environment-pip__open');
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`) as { x: number; y: number };
    const beforeDragBounds = activeEnvironmentDockWindow!.getBounds();
    await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      window.__activeEnvironmentDockPointerEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
        document.addEventListener(type, (event) => window.__activeEnvironmentDockPointerEvents.push({
          type,
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          buttons: event.buttons,
          target: event.target?.className || event.target?.tagName || '',
        }), { capture: true, once: type !== 'pointermove' });
      }
    })()`);
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", ...dragCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...dragCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", x: dragCenter.x + 34, y: dragCenter.y + 22, movementX: 34, movementY: 22 });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: dragCenter.x + 34, y: dragCenter.y + 22 });
    const dragPositionDelivered = await dragPositionPromise;
    const afterDragBounds = activeEnvironmentDockWindow!.getBounds();
    const cardDragMovedWindow = Math.abs(afterDragBounds.x - beforeDragBounds.x) >= 7 || Math.abs(afterDragBounds.y - beforeDragBounds.y) >= 7;
    if (!dragPositionDelivered || !cardDragMovedWindow) {
      const pointerEvents = await activeEnvironmentDockWindow!.webContents.executeJavaScript("window.__activeEnvironmentDockPointerEvents") as unknown;
      throw new Error(`画中画整卡拖动失败：${JSON.stringify({ beforeDragBounds, afterDragBounds, pointerEvents })}`);
    }
    await updateActiveEnvironmentDockWindow(expandedState);

    const closeActionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('画中画关闭动作未回传')); }, 3000);
      const stop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'close-environment' && action.environmentId === 'dock-smoke-environment-a') { clearTimeout(timeout); stop(); resolve(true); }
      });
      window.__activeEnvironmentDockCloseSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__activeEnvironmentDockCloseSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('画中画关闭烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const closeCenter = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.active-environment-pip__close');
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`) as { x: number; y: number };
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", ...closeCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...closeCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...closeCenter });
    const closeActionDelivered = await closeActionPromise;
    const remainingEnvironments = environments.slice(1);
    const remainingSize = activeEnvironmentDockPanelSize(true, remainingEnvironments, viewport);
    await updateActiveEnvironmentDockWindow({
      ...expandedState,
      bounds: { ...expandedState.bounds, ...remainingSize },
      environments: remainingEnvironments,
    });
    const closeStateRemoved = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const cards = [...document.querySelectorAll('.active-environment-pip__card')];
        const images = [...document.querySelectorAll('.active-environment-pip__visual img')];
        if (cards.length === 1 && images.length === 1 && document.body.innerText.includes('DOCK-SMOKE-ENVIRONMENT-B')) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('画中画关闭后卡片未移除'));
        setTimeout(inspect, 20);
      };
      inspect();
    })`) as boolean;
    await updateActiveEnvironmentDockWindow(expandedState);

    const actionPromise = mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('画中画打开环境动作未回传')); }, 3000);
      const stop = window.vironDesktop.onActiveEnvironmentDockAction((action) => {
        if (action.type === 'open-environment' && action.environmentId === 'dock-smoke-environment-b') { clearTimeout(timeout); stop(); resolve(true); }
      });
      window.__activeEnvironmentDockSmokeReady = true;
    })`) as Promise<boolean>;
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const inspect = () => {
        if (window.__activeEnvironmentDockSmokeReady) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('活动环境悬浮坞烟测监听未就绪'));
        setTimeout(inspect, 10);
      };
      inspect();
    })`);
    const connectionCenter = await activeEnvironmentDockWindow!.webContents.executeJavaScript(`(() => {
      const button = document.querySelectorAll('.active-environment-pip__card')[1];
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`) as { x: number; y: number };
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseMove", ...connectionCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...connectionCenter });
    activeEnvironmentDockWindow!.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...connectionCenter });
    const actionDelivered = await actionPromise;
    const expandedBounds = activeEnvironmentDockWindow!.getBounds();
    const expandedWindowSize = expandedBounds.width === expandedSize.width && expandedBounds.height === expandedSize.height;
    const snapshot = await waitForDesktopWindowSnapshot(activeEnvironmentDockWindow!);
    const webViewStayedVisible = testView.getVisible() && !testView.webContents.isDestroyed();
    const contentBounds = mainWindow.getContentBounds();
    const testViewScreenBounds = {
      x: contentBounds.x + testViewBounds.x,
      y: contentBounds.y + testViewBounds.y,
      width: testViewBounds.width,
      height: testViewBounds.height,
    };
    const overlapsWebView = expandedBounds.x < testViewScreenBounds.x + testViewScreenBounds.width
      && expandedBounds.x + expandedBounds.width > testViewScreenBounds.x
      && expandedBounds.y < testViewScreenBounds.y + testViewScreenBounds.height
      && expandedBounds.y + expandedBounds.height > testViewScreenBounds.y;
    const nativeAboveWebView = activeEnvironmentDockWindow!.getParentWindow() === mainWindow
      && activeEnvironmentDockWindow!.isVisible() && webViewStayedVisible && overlapsWebView;
    await updateActiveEnvironmentDockWindow(null);
    return {
      ...inspected,
      ...collapsedInspection,
      collapsedPanelSize: collapsedInspection.collapsedPanelSize && collapsedWindowSize,
      expandedPanelSize: inspected.expandedPanelSize && expandedWindowSize,
      rendererPreviewPixels,
      previewFrameChanged,
      retainedPreviewPixels,
      nonFocusable,
      passiveHoverFocusStable,
      hoverIntentStable,
      nativePointerTrackingStable,
      collapseAnimationStable,
      collapseResizeSynchronized,
      lightweightLayoutStable: inspected.lightweightLayoutStable,
      programmaticMoveIgnored,
      dragPositionDelivered: dragPositionDelivered && cardDragMovedWindow,
      closeActionDelivered,
      closeStateRemoved,
      snapshot,
      webViewStayedVisible,
      nativeAboveWebView,
      actionDelivered,
      hidden: !activeEnvironmentDockWindow!.isVisible(),
    };
  } finally {
    mainWindow.contentView.removeChildView(testView);
    if (!testView.webContents.isDestroyed()) testView.webContents.close();
    await updateActiveEnvironmentDockWindow(null);
  }
}

async function createWindow(): Promise<void> {
  desktopSmokeStage("create-window");
  const appRoot = app.getAppPath();
  const preload = join(appRoot, "dist", "desktop", "preload.cjs");
  const renderer = join(appRoot, "dist", "desktop-renderer", "index.html");
  const icon = developmentApplicationIcon();
  if (!existsSync(preload) || !existsSync(renderer)) throw new Error(tr("桌面 App 静态资源不完整，请先执行 npm run build:desktop"));

  const createdMainWindow = setMainWindow(new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: "#071015",
    title: "Viron",
    ...(process.platform !== "darwin" && icon ? { icon } : {}),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin" ? {} : {
      titleBarOverlay: desktopTitleBarOverlay("login"),
    }),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  }));
  createdMainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createdMainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  createdMainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    if (shortcutCaptureActive) {
      event.preventDefault();
      createdMainWindow.webContents.send("viron:shortcut-capture-input", {
        key: input.key,
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
      });
      return;
    }
    const action = shortcutActionForInput(shortcutPreferences().bindings, {
      key: input.key,
      meta: input.meta,
      control: input.control,
      alt: input.alt,
      shift: input.shift,
    }, process.platform);
    if (!action) return;
    if (action === "app.agentQuickInput" && currentAgentEntryMode() !== "quick") return;
    event.preventDefault();
    sendShortcutAction(action);
  });
  createdMainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== createdMainWindow.webContents.getURL()) event.preventDefault();
  });
  createdMainWindow.once("ready-to-show", () => createdMainWindow.show());
  createdMainWindow.on("move", () => {
    layoutImmersiveNavigationWindow();
    layoutAgentLauncherWindow();
    layoutAgentChatWindow();
    layoutConnectionQualityWindow();
    layoutActiveEnvironmentDockWindow();
  });
  createdMainWindow.on("resize", () => {
    layoutImmersiveNavigationWindow();
    layoutAgentLauncherWindow();
    layoutAgentChatWindow();
    layoutConnectionQualityWindow();
    layoutActiveEnvironmentDockWindow();
  });
  createdMainWindow.on("closed", () => {
    void closeAllDesktopWebViews();
    void updateImmersiveNavigationWindow(null);
    immersiveNavigationWindow?.close();
    void updateAgentChatHost(null);
    void setAgentChatNativeOverlay(false);
    void updateAgentLauncherWindow(null);
    agentLauncherWindow?.close();
    agentLauncherVisualWindow?.close();
    void updateConnectionQualityWindow(null);
    connectionQualityWindow?.close();
    connectionQualityVisualWindow?.close();
    void updateActiveEnvironmentDockWindow(null);
    activeEnvironmentDockWindow?.close();
    shortcutCaptureActive = false;
    setMainWindow(null);
  });
  installApplicationMenu();
  await createdMainWindow.loadFile(renderer);
  desktopSmokeStage("renderer-loaded");

  if (process.argv.includes("--smoke-test")) {
    try {
      createdMainWindow.show();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const smokeEndpoint = process.argv.find((argument) => argument.startsWith("--smoke-endpoint="))?.slice("--smoke-endpoint=".length);
      desktopSmokeStage(smokeEndpoint ? "endpoint-start" : "static-smoke");
      let endpointValidated: boolean | null = null;
      let apiStatus: number | null = null;
      let localWeb: Awaited<ReturnType<typeof runDesktopWebSmoke>> | null = null;
      let localSsh: Awaited<ReturnType<typeof runDesktopSshSmoke>> | null = null;
      let localLogs: Awaited<ReturnType<typeof runDesktopLogSmoke>> | null = null;
      let localDatabase: Awaited<ReturnType<typeof runDesktopDatabaseSmoke>> | null = null;
      let localInspection: Awaited<ReturnType<typeof runDesktopInspectionSmoke>> | null = null;
      const immersiveNavigation = await runDesktopImmersiveNavigationSmoke();
      const agentLauncher = await runDesktopAgentLauncherSmoke();
      const connectionQuality = await runDesktopConnectionQualitySmoke();
      const activeEnvironmentDock = await runDesktopActiveEnvironmentDockSmoke();
      if (smokeEndpoint) {
        const endpointResult = await createdMainWindow.webContents.executeJavaScript(
          `window.vironDesktop.setEndpoint(${JSON.stringify(smokeEndpoint)})`,
        ) as { ok: boolean };
        endpointValidated = endpointResult.ok;
        desktopSmokeStage(endpointResult.ok ? "endpoint-ready" : "endpoint-rejected");
        if (endpointResult.ok) {
          const response = await createdMainWindow.webContents.executeJavaScript(
            `window.vironDesktop.request({ path: "/api/v1/capabilities" })`,
          ) as { status: number };
          apiStatus = response.status;
          desktopSmokeStage(`api-${response.status}`);
          const smokeUsername = process.env.VIRON_DESKTOP_SMOKE_USERNAME;
          const smokePassword = process.env.VIRON_DESKTOP_SMOKE_PASSWORD;
          const smokeCredentialId = process.env.VIRON_DESKTOP_SMOKE_WEB_CREDENTIAL_ID;
          const smokeSshConnectionId = process.env.VIRON_DESKTOP_SMOKE_SSH_CONNECTION_ID;
          const smokeLogId = process.env.VIRON_DESKTOP_SMOKE_LOG_ID;
          const smokeLogEnvironmentId = process.env.VIRON_DESKTOP_SMOKE_LOG_ENVIRONMENT_ID;
          const smokeDatabaseConnectionId = process.env.VIRON_DESKTOP_SMOKE_DATABASE_CONNECTION_ID;
          const smokeInspectionSshConnectionId = process.env.VIRON_DESKTOP_SMOKE_INSPECTION_SSH_CONNECTION_ID;
          const smokeInspectionDatabaseConnectionId = process.env.VIRON_DESKTOP_SMOKE_INSPECTION_DATABASE_CONNECTION_ID;
          if (smokeUsername && smokePassword && (smokeCredentialId || smokeSshConnectionId || (smokeLogId && smokeLogEnvironmentId) || smokeDatabaseConnectionId || (smokeInspectionSshConnectionId && smokeInspectionDatabaseConnectionId))) {
            await endpointJson("/api/v1/auth/login", { method: "POST", body: { username: smokeUsername, password: smokePassword } });
            desktopSmokeStage("login-ready");
            if (smokeCredentialId) localWeb = await runDesktopWebSmoke(smokeCredentialId, smokeUsername, process.env.VIRON_DESKTOP_SMOKE_UPLOAD_PATH);
            if (smokeSshConnectionId) localSsh = await runDesktopSshSmoke(smokeSshConnectionId);
            if (smokeLogId && smokeLogEnvironmentId) localLogs = await runDesktopLogSmoke(smokeLogEnvironmentId, smokeLogId);
            if (smokeDatabaseConnectionId) {
              desktopSmokeStage("database-start");
              localDatabase = await runDesktopDatabaseSmoke(smokeDatabaseConnectionId);
              desktopSmokeStage("database-ready");
            }
            if (smokeInspectionSshConnectionId && smokeInspectionDatabaseConnectionId) {
              desktopSmokeStage("inspection-start");
              localInspection = await runDesktopInspectionSmoke(smokeInspectionSshConnectionId, smokeInspectionDatabaseConnectionId);
              desktopSmokeStage("inspection-ready");
            }
          }
        }
      }
      const result = await createdMainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const loginVisible = Boolean(document.querySelector('.login-page'));
          const endpointVisible = Boolean(document.querySelector('input[aria-label="Viron Endpoint"]'));
          if (loginVisible && endpointVisible) return resolve({ title: document.title, loginVisible, endpointVisible });
          if (Date.now() >= deadline) return reject(new Error('登录页未在 10 秒内完成渲染'));
          setTimeout(inspect, 50);
        };
        inspect();
      })`);
      const smokeResult = { ...result, endpointValidated, apiStatus, localWeb, localSsh, localLogs, localDatabase, localInspection, immersiveNavigation, agentLauncher, connectionQuality, activeEnvironmentDock };
      process.stdout.write(`VIRON_DESKTOP_SMOKE ${JSON.stringify(smokeResult)}\n`);
      desktopSmokeStage("complete");
      const endpointPassed = endpointValidated === null || (endpointValidated && apiStatus === 200);
      const localWebPassed = localWeb === null || (localWeb.opened && localWeb.resetCleared && localWeb.uploadSelected !== false && localWeb.downloadTriggered);
      const localSshPassed = localSsh === null || (localSsh.opened && localSsh.textInputEchoed && localSsh.binaryInputEchoed && localSsh.resized && localSsh.agentContextRead && localSsh.recordingCompleted);
      const localLogsPassed = localLogs === null || (localLogs.opened && localLogs.outputReceived && localLogs.stopped);
      const localDatabasePassed = localDatabase === null || (localDatabase.tested && localDatabase.queried && localDatabase.cancelled);
      const localInspectionPassed = localInspection === null || (localInspection.total === 2 && localInspection.available === 2 && localInspection.sshAvailable && localInspection.databaseAvailable && localInspection.credentialsHidden);
      const immersiveNavigationPassed = immersiveNavigation.rendered && immersiveNavigation.snapshot && immersiveNavigation.webViewStayedVisible && immersiveNavigation.snappedTop && immersiveNavigation.hidden;
      const agentLauncherPassed = agentLauncher.rendered && agentLauncher.exactButtonSize && agentLauncher.glowClearance && agentLauncher.compactInteraction
        && agentLauncher.nonFocusable && agentLauncher.passivePointerStable
        && agentLauncher.snapshot && agentLauncher.webViewStayedVisible && agentLauncher.actionDelivered && agentLauncher.hidden;
      const connectionQualityPassed = connectionQuality.rendered && connectionQuality.exactPanelSize && connectionQuality.compactInteraction
        && connectionQuality.noHeader && connectionQuality.expandedContentFits && connectionQuality.testButtonClearance
        && connectionQuality.nonFocusable && connectionQuality.snapshot && connectionQuality.webViewStayedVisible
        && connectionQuality.actionDelivered && connectionQuality.hidden;
      const activeEnvironmentDockPassed = activeEnvironmentDock.rendered && activeEnvironmentDock.collapsedPanelSize
        && activeEnvironmentDock.expandedPanelSize && activeEnvironmentDock.collapsedStacked
        && activeEnvironmentDock.expandedStacked && activeEnvironmentDock.expandedAligned && activeEnvironmentDock.anchorStable
        && activeEnvironmentDock.expandedContentFits && activeEnvironmentDock.rendererPreviewPixels
        && activeEnvironmentDock.previewPixels && activeEnvironmentDock.previewFrameChanged && activeEnvironmentDock.retainedPreviewPixels
        && activeEnvironmentDock.nonInteractivePreview && activeEnvironmentDock.snapshot
        && activeEnvironmentDock.nonFocusable && activeEnvironmentDock.passiveHoverFocusStable && activeEnvironmentDock.hoverIntentStable
        && activeEnvironmentDock.nativePointerTrackingStable && activeEnvironmentDock.collapseAnimationStable
        && activeEnvironmentDock.collapseResizeSynchronized
        && activeEnvironmentDock.lightweightLayoutStable
        && activeEnvironmentDock.programmaticMoveIgnored
        && activeEnvironmentDock.dragPositionDelivered && activeEnvironmentDock.closeActionDelivered && activeEnvironmentDock.closeStateRemoved
        && activeEnvironmentDock.webViewStayedVisible && activeEnvironmentDock.nativeAboveWebView
        && activeEnvironmentDock.actionDelivered && activeEnvironmentDock.hidden;
      app.exit(result.loginVisible && result.endpointVisible && endpointPassed && localWebPassed && localSshPassed && localLogsPassed && localDatabasePassed && localInspectionPassed && immersiveNavigationPassed && agentLauncherPassed && connectionQualityPassed && activeEnvironmentDockPassed ? 0 : 1);
    } catch (error) {
      process.stderr.write(`VIRON_DESKTOP_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
      app.exit(1);
    }
  }
}

app.whenReady().then(async () => {
  if (!gotTheLock) return;
  initializeDesktopLanguage(readState().language, app.getLocale());
  if (await shouldBlockLaunchForActiveUpdate()) {
    await dialog.showMessageBox({
      type: "info",
      title: tr("正在更新 Viron"),
      message: tr("正在安装更新"),
      detail: tr("请等待当前更新完成。完成后 Viron 会自动启动。"),
      buttons: [tr("知道了")],
    });
    app.exit(0);
    return;
  }
  const icon = developmentApplicationIcon();
  if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
  const sshRuntime = new DesktopSshRuntime(
    join(app.getPath("userData"), "ssh-recordings"),
    (event) => {
      if (event.type === "closed") desktopAgentRuntime?.stopForSource(`desktop-ssh:${event.sessionId}`, event.reason);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:ssh-session-event", event);
    },
  );
  const sftpRuntime = new DesktopSftpRuntime(localSshCredential, currentDesktopSshContext);
  const logRuntime = new DesktopLogRuntime(localSshCredential, currentDesktopSshContext, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:log-stream-event", event);
  });
  const databaseRuntime = new DesktopDatabaseRuntime(localDatabaseCredential, reportDesktopDatabaseExecution);
  const redisRuntime = new DesktopRedisRuntime(localRedisCredential, reportDesktopRedisExecution);
  const databaseOperationRuntime = new DesktopDatabaseOperationRuntime(
    app.getPath("userData"),
    localDatabaseCredential,
    reportDesktopDatabaseExecution,
  );
  const connectionInspectionRuntime = new DesktopConnectionInspectionRuntime(
    () => endpointJson<{ items: DesktopInspectionConnection[] }>("/api/v1/connections?assignment=all&type=all"),
    localSshCredential,
    localDatabaseCredential,
    localRedisCredential,
    reportDesktopConnectionInspection,
  );
  initializeDesktopRuntimeContext({
    ssh: sshRuntime,
    sftp: sftpRuntime,
    log: logRuntime,
    database: databaseRuntime,
    databaseOperation: databaseOperationRuntime,
    redis: redisRuntime,
    connectionInspection: connectionInspectionRuntime,
  });
  desktopAgentSettingsStore = new DesktopAgentSettingsStore(app.getPath("userData"));
  desktopAgentSessionStore = new DesktopAgentSessionStore(app.getPath("userData"));
  desktopAgentAuditStore = new DesktopAgentAuditStore(app.getPath("userData"));
  const desktopAgentGateway = createVironMcpCompactGateway({
    invoke: (toolName, arguments_) => desktopMcpApprovalModeContext.run(
      "never",
      () => desktopAuditSourceContext.run("mcp", () => invokeDesktopMcpTool(toolName, arguments_)),
    ),
  });
  const agentRuntime = new DesktopAgentRuntime(
    desktopAgentSettingsStore,
    desktopAgentSessionStore,
    (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:agent-event", event);
    },
    {
      executeSshDiagnostic: async (input, execution) => {
        const desktopContext = await currentDesktopSshContext();
        if (input.presentation === "workbench") {
          return executeAgentSshWorkbenchRead({
            request: {
              type: "workbench-execution-request",
              domain: "ssh",
              requestId: randomUUID(),
              runId: execution.runId,
              messageId: execution.messageId,
              toolCallId: execution.toolCallId,
              deadlineAt: execution.deadlineAt,
              step: execution.step,
              maxSteps: execution.maxSteps,
              sessionId: input.sessionId,
              executionTarget: input.executionTarget,
              command: input.command,
              intent: input.intent ?? "read",
            },
            scope: execution.scope,
            desktopContext,
            abortSignal: execution.abortSignal,
          });
        }
        return executeAgentSshRead({
          executionId: randomUUID(),
          sessionId: input.sessionId,
          command: input.command,
          executionTarget: input.executionTarget,
          scope: execution.scope,
          desktopContext,
          abortSignal: execution.abortSignal,
          step: execution.step,
          maxSteps: execution.maxSteps,
          intent: input.intent ?? "read",
        }).then((result) => ({ ...result, presentation: "conversation" as const }));
      },
      executeDatabaseRead: async (input, execution) => {
        const desktopContext = await currentDesktopSshContext();
        const write = input.intent === "write";
        if (input.presentation === "workbench") {
          const request: AgentWorkbenchExecutionRequest & { domain: "database" } = {
            type: "workbench-execution-request",
            domain: "database",
            requestId: randomUUID(),
            runId: execution.runId,
            messageId: execution.messageId,
            toolCallId: execution.toolCallId,
            deadlineAt: execution.deadlineAt,
            step: execution.step,
            maxSteps: execution.maxSteps,
            connectionId: input.connectionId,
            database: input.database,
            sql: input.sql,
            intent: input.intent ?? "read",
          };
          if (!agentRuntimeScopeMatches(execution.scope, agentRuntimeScope(desktopContext))) throw new Error(tr("Viron Agent 诊断现场已经失效"));
          desktopAgentAuditStore.append(execution.scope, write ? "database_workbench_write_started" : "database_workbench_execution_started", `${input.connectionId}:${input.database}`, tr("在当前数据库工作台执行{{0}}（第 {{1}}/{{2}} 步）", [write ? tr("写 SQL") : tr("只读查询"), execution.step, execution.maxSteps]));
          try {
            const workbenchResult = await requestAgentWorkbenchExecution(request, execution.abortSignal);
            if (workbenchResult.domain !== "database") throw new Error(tr("Viron Agent 数据库工作台执行结果无效"));
            if (!agentRuntimeScopeMatches(execution.scope, agentRuntimeScope(await currentDesktopSshContext()))) throw new Error(tr("Viron Agent 诊断现场已经失效"));
            const sanitized = sanitizeAgentDatabaseInput({
              connectionId: input.connectionId,
              database: input.database,
              editorSql: "",
              selectedSql: "",
              resultPreview: workbenchResult.result.rows,
            }, 100);
            const result = {
              ...workbenchResult.result,
              rows: sanitized.resultPreview,
              truncated: workbenchResult.result.truncated || sanitized.truncated,
              presentation: "workbench" as const,
            };
            desktopAgentAuditStore.append(execution.scope, write ? "database_workbench_write_completed" : "database_workbench_execution_completed", `${input.connectionId}:${input.database}`, write ? tr("数据库工作台写 SQL 完成，影响 {{0}} 行", [result.affectedRows ?? result.rowCount]) : tr("数据库工作台只读查询完成，返回 {{0}} 行", [result.rowCount]));
            return result;
          } catch (error) {
            desktopAgentAuditStore.append(execution.scope, execution.abortSignal.aborted ? (write ? "database_workbench_write_cancelled" : "database_workbench_execution_cancelled") : (write ? "database_workbench_write_failed" : "database_workbench_execution_failed"), `${input.connectionId}:${input.database}`, error instanceof Error ? error.message : tr("数据库工作台执行失败"));
            throw error;
          }
        }
        return executeAgentDatabaseRead({
          connectionId: input.connectionId,
          database: input.database,
          sql: input.sql,
          scope: execution.scope,
          desktopContext,
          abortSignal: execution.abortSignal,
          step: execution.step,
          maxSteps: execution.maxSteps,
          intent: input.intent ?? "read",
        }).then((result) => ({ ...result, presentation: "conversation" as const }));
      },
      invokeVironTool: (name, input) => desktopAgentGateway.invoke(name, input),
      currentScope: currentAgentRuntimeScope,
      recordDiagnosticStop: (input, scope) => {
        desktopAgentAuditStore.append(
          scope,
          "agent_diagnostic_cancelled",
          input.runId,
          tr("Viron Agent 多步诊断已停止，已完成 {{0}} 步：{{1}}", [input.completedSteps, input.reason]),
        );
      },
    },
    desktopAgentGateway.tools,
  );
  setDesktopAgentRuntime(agentRuntime);
  desktopMcpBroker = new DesktopMcpBroker(app.getPath("userData"), app.getVersion(), invokeDesktopMcpTool);
  if (readState().localMcpEnabled === true) {
    try {
      await desktopMcpBroker.start();
    } catch (error) {
      desktopMcpLastError = error instanceof Error ? error.message : tr("本机 MCP Broker 启动失败");
    }
  }
  desktopUpdater = new DesktopUpdater({
    fetch: (path, signal) => endpointFetch({ path }, signal),
    window: () => mainWindow,
  });
  await desktopUpdater.cleanup();
  registerIpc();
  desktopRuntimeHeartbeat = setInterval(() => { void syncDesktopRuntimeConnections(); }, 3_000);
  desktopRuntimeHeartbeat.unref();
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});

let desktopShutdownStarted = false;
app.on("before-quit", (event) => {
  if (desktopShutdownStarted || !desktopSshRuntime || !desktopSftpRuntime || !desktopLogRuntime || !desktopDatabaseRuntime || !desktopDatabaseOperationRuntime || !desktopRedisRuntime) return;
  event.preventDefault();
  desktopShutdownStarted = true;
  if (desktopRuntimeHeartbeat) clearInterval(desktopRuntimeHeartbeat);
  closeAllServiceSockets(tr("Viron App 正在退出"));
  desktopAgentRuntime?.stopAll();
  void Promise.all([
    closeDesktopMcpOperations(false),
    desktopMcpBroker?.close(),
    closeAllDesktopWebViews(),
    desktopSshRuntime.closeAll(),
    desktopSftpRuntime.closeAll(),
    Promise.resolve(desktopLogRuntime.closeAll()),
    desktopDatabaseRuntime.closeAll(),
    desktopRedisRuntime.closeAll(),
    closeDesktopSshConnectionPool(),
    Promise.resolve(desktopDatabaseOperationRuntime.closeAll()),
  ]).finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());
