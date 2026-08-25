import {
  currentDesktopLanguage,
  initializeDesktopLanguage,
  translate as tr,
} from "./i18n.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
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
import { shortcutActionForInput } from "../shared/keyboard-shortcuts.js";
import {
  agentEntryMode,
  type AgentWorkbenchExecutionRequest,
} from "../shared/agent.js";
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
  layoutImmersiveNavigationWindow,
  updateImmersiveNavigationWindow,
} from "./overlays/immersive-navigation-window.js";
import {
  attachDesktopHistoryNavigationListeners,
  closeDesktopHistoryNavigation,
} from "./history-navigation-runtime.js";
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
  closeAllDesktopWebViews,
  desktopWebViews,
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
import { desktopSmokeStage } from "./smoke/stage.js";
import { runDesktopWebSmoke } from "./smoke/web-smoke.js";
import {
  runDesktopDatabaseSmoke,
  runDesktopInspectionSmoke,
  runDesktopLogSmoke,
  runDesktopSshSmoke,
} from "./smoke/runtime-smoke.js";
import {
  runDesktopAgentLauncherSmoke,
  runDesktopConnectionQualitySmoke,
  runDesktopImmersiveNavigationSmoke,
} from "./smoke/static-overlay-smoke.js";
import { runDesktopActiveEnvironmentDockSmoke } from "./smoke/active-environment-dock-smoke.js";

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
  attachDesktopHistoryNavigationListeners(createdMainWindow);
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
    closeDesktopHistoryNavigation();
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
      const immersiveNavigationPassed = immersiveNavigation.immediateExpand && immersiveNavigation.rendered && immersiveNavigation.snapshot && immersiveNavigation.webViewStayedVisible && immersiveNavigation.snappedTop && immersiveNavigation.hidden;
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
