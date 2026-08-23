import {
  currentDesktopLanguage,
  initializeDesktopLanguage,
  translate as tr,
} from "./i18n.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen as electronScreen,
  WebContentsView,
  type Rectangle,
} from "electron";
import { EndpointValidationError, normalizeEndpoint, validateEndpoint } from "./endpoint.js";
import { DesktopSftpRuntime } from "./sftp-runtime.js";
import { DesktopLogRuntime } from "./log-runtime.js";
import { DesktopDatabaseRuntime } from "./database-runtime.js";
import { DesktopRedisRuntime } from "./redis-runtime.js";
import { DesktopDatabaseOperationRuntime } from "./database-operations-runtime.js";
import {
  DesktopConnectionInspectionRuntime,
  type DesktopInspectionConnection,
} from "./connection-inspection-runtime.js";
import {
  DesktopSshRuntime,
  closeDesktopSshConnectionPool,
} from "./ssh-runtime.js";
import type { DesktopExecutionMode } from "../shared/execution-mode.js";
import { desktopTitleBarOverlay } from "../shared/desktop-titlebar.js";
import { DesktopUpdater, shouldBlockLaunchForActiveUpdate } from "./updater.js";
import type { ImmersiveNavigationState } from "../shared/immersive-navigation.js";
import { shortcutActionForInput } from "../shared/keyboard-shortcuts.js";
import {
  agentEntryMode,
  type AgentWorkbenchExecutionRequest,
} from "../shared/agent.js";
import {
  agentFloatingOverlayInteractionState,
  type AgentFloatingOverlayState,
} from "../shared/agent-floating-overlay.js";
import {
  CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT,
  CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT,
  CONNECTION_QUALITY_PANEL_WIDTH,
  type ConnectionQualityOverlayState,
} from "../shared/connection-quality.js";
import {
  activeEnvironmentDockCardSize,
  activeEnvironmentDockLayoutSnapshot,
  activeEnvironmentDockPanelSize,
  ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS,
  ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS,
  type ActiveEnvironmentDockState,
} from "../shared/active-environment-dock.js";
import { DesktopAgentRuntime } from "./agent-runtime.js";
import { agentRuntimeScopeMatches } from "./agent-diagnostic-session.js";
import { sanitizeAgentDatabaseInput } from "./agent-database-context.js";
import { DesktopMcpBroker } from "./mcp-broker.js";
import { createVironMcpCompactGateway } from "../shared/mcp-tools.js";
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
  setActiveEndpoint,
} from "./endpoint-context.js";
import {
  endpointSession,
} from "./device-session.js";
import { mainWindow, setMainWindow } from "./window-host.js";
import { installApplicationMenu } from "./app-menu.js";
import { trustedSender } from "./ipc-guards.js";
import {
  activeEnvironmentDockWindow,
  layoutActiveEnvironmentDockWindow,
  scheduleActiveEnvironmentDockPointerTracking,
  stopActiveEnvironmentDockPointerTracking,
  updateActiveEnvironmentDockWindow,
} from "./overlays/active-environment-dock-window.js";
import {
  sendToAgentChat,
  setAgentChatNativeOverlay,
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
  immersiveNavigationWindow,
  immersiveNavigationViewport,
  layoutImmersiveNavigationWindow,
  updateImmersiveNavigationWindow,
} from "./overlays/immersive-navigation-window.js";
import {
  desktopAgentRuntime,
  desktopAuditSourceContext,
  desktopDatabaseOperationRuntime,
  desktopDatabaseRuntime,
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
  currentDesktopSshContext,
  emptyExecutionActivity,
  executionRuntimeApiMissing,
  localDatabaseCredential,
  localRedisCredential,
  localSshCredential,
  reportDesktopConnectionInspection,
  reportDesktopDatabaseExecution,
  reportDesktopRedisExecution,
  syncDesktopRuntimeConnections,
  type ExecutionActivity,
} from "./execution-router.js";
import { endpointFetch, endpointJson } from "./http-proxy.js";
import {
  activeDesktopWebPage,
  captureDesktopRendererPreview,
  captureWebContentsPreview,
  closeAllDesktopWebViews,
  closeDesktopWebView,
  desktopWebViews,
  handleDesktopWebViewAction,
  inspectDesktopWebElement,
  localWebView,
  openDesktopWebView,
  resetDesktopWebView,
  type ManagedDesktopWebView,
} from "./web-view-runtime.js";
import {
  closeDesktopMcpOperations,
  desktopMcpBroker,
  initializeDesktopMcpBridge,
  invokeDesktopMcpTool,
  setDesktopMcpLastError,
} from "./mcp-desktop-bridge.js";
import { registerDesktopSshIpc } from "./ipc/register-ssh-ipc.js";
import { registerDesktopLogIpc } from "./ipc/register-log-ipc.js";
import {
  desktopAgentAuditStore,
  desktopAgentSessionStore,
  desktopAgentSettingsStore,
  executeAgentDatabaseRead,
  executeAgentSshRead,
  executeAgentSshWorkbenchRead,
  initializeDesktopAgentIpcStores,
  registerDesktopAgentIpc,
  requestAgentWorkbenchExecution,
} from "./ipc/register-agent-ipc.js";
import {
  registerDesktopCoreIpc,
  resetShortcutCapture,
  shortcutCaptureActive,
} from "./ipc/register-core-ipc.js";
import { registerDesktopExecutionIpc } from "./ipc/register-execution-ipc.js";

if (process.platform === "darwin") app.commandLine.appendSwitch("use-mock-keychain");

const gotTheLock = process.argv.includes("--smoke-test") || app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

function developmentApplicationIcon(): string | undefined {
  if (app.isPackaged) return undefined;
  const icon = join(app.getAppPath(), "design", "logo", "viron-logo.png");
  return existsSync(icon) ? icon : undefined;
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
let desktopRuntimeHeartbeat: NodeJS.Timeout | null = null;
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

function registerIpc(): void {
  registerDesktopSshIpc();
  registerDesktopLogIpc();
  registerDesktopAgentIpc();
  registerDesktopCoreIpc(desktopUpdater);
  registerDesktopExecutionIpc();
  ipcMain.handle("viron:state", (event) => {
    trustedSender(event);
    return publicState();
  });
  ipcMain.handle("viron:agent:entry-mode:set", (event, value: unknown) => {
    trustedSender(event);
    if (value !== "floating" && value !== "quick" && value !== "disabled") throw new Error(tr("Viron Agent 入口模式无效"));
    if (value === "disabled") desktopAgentRuntime?.stopAll(tr("Viron Agent 已关闭"));
    const state = readState();
    writeState({ ...state, agentEntryMode: value });
    return publishDesktopAppState();
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
    resetShortcutCapture();
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
  initializeDesktopAgentIpcStores(app.getPath("userData"));
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
  initializeDesktopMcpBridge(new DesktopMcpBroker(app.getPath("userData"), app.getVersion(), invokeDesktopMcpTool));
  if (readState().localMcpEnabled === true) {
    try {
      await desktopMcpBroker.start();
    } catch (error) {
      setDesktopMcpLastError(error);
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
