import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  Notification as ElectronNotification,
  shell,
} from "electron";
import { translate as tr, setDesktopLanguage } from "../i18n.js";
import {
  desktopTitleBarOverlay,
  isDesktopTitleBarAppearance,
} from "../../shared/desktop-titlebar.js";
import {
  effectiveShortcutBindings,
  sanitizeShortcutOverrides,
  shortcutConflict,
  shortcutValidationError,
  type ShortcutActionId,
} from "../../shared/keyboard-shortcuts.js";
import type { ImmersiveNavigationAction, ImmersiveNavigationState } from "../../shared/immersive-navigation.js";
import {
  isAgentHostAction,
  isAgentHostState,
  type AgentHostAction,
  type AgentHostActionResult,
  type AgentHostState,
} from "../../shared/agent-host.js";
import type {
  AgentFloatingOverlayAction,
  AgentFloatingOverlayState,
} from "../../shared/agent-floating-overlay.js";
import type {
  ConnectionQualityOverlayAction,
  ConnectionQualityOverlayState,
  ConnectionQualityTargetAddress,
} from "../../shared/connection-quality.js";
import type {
  ActiveEnvironmentDockAction,
  ActiveEnvironmentDockDragAction,
  ActiveEnvironmentDockLayoutState,
  ActiveEnvironmentDockState,
} from "../../shared/active-environment-dock.js";
import { DesktopUpdater } from "../updater.js";
import { DatabaseArtifactFileRuntime } from "../database-artifact-files.js";
import { isDesktopDatabaseDownloadPath } from "../database-operations-runtime.js";
import { probeDesktopTcpTarget } from "../connection-quality-probe.js";
import { readState, shortcutPreferences, writeState } from "../app-state.js";
import { activeEndpoint, currentExecutionMode } from "../endpoint-context.js";
import { mainWindow } from "../window-host.js";
import { installApplicationMenu } from "../app-menu.js";
import {
  trustedAgentChatSender,
  trustedMainWindowSender,
  trustedSender,
} from "../ipc-guards.js";
import {
  activeEnvironmentDockPointerInside,
  activeEnvironmentDockState,
  activeEnvironmentDockWindow,
  handleActiveEnvironmentDockDrag,
  keepActiveEnvironmentDockExpanded,
  stopActiveEnvironmentDockPointerTracking,
  updateActiveEnvironmentDockLayoutWindow,
  updateActiveEnvironmentDockWindow,
} from "../overlays/active-environment-dock-window.js";
import {
  agentChatHostState,
  agentChatWindow,
  requestAgentHostAction,
  sendToAgentChat,
  setAgentChatChromeVisible,
  setAgentChatIgnoreMouse,
  setAgentChatNativeOverlay,
  settleAgentHostAction,
  updateAgentChatHost,
} from "../overlays/agent-chat-window.js";
import {
  agentLauncherWindow,
  updateAgentLauncherWindow,
} from "../overlays/agent-launcher-window.js";
import {
  connectionQualityWindow,
  updateConnectionQualityWindow,
} from "../overlays/connection-quality-window.js";
import {
  applyImmersiveNavigationActionPreview,
  handleImmersiveNavigationDrag,
  immersiveNavigationWindow,
  sendImmersiveNavigationAction,
  updateImmersiveNavigationWindow,
} from "../overlays/immersive-navigation-window.js";
import { desktopDatabaseOperationRuntime } from "../desktop-runtime-context.js";
import { currentDesktopSshContext } from "../execution-router.js";
import { endpointFetch, endpointJson, suggestedFilename } from "../http-proxy.js";
import {
  captureDesktopRendererPreview,
  captureDesktopWebViewPreview,
  closeDesktopWebView,
  handleDesktopWebViewAction,
  layoutDesktopWebViewPages,
  localWebView,
  openDesktopWebView,
  webViewBounds,
  webViewState,
  type DesktopWebInitialPage,
  type DesktopWebViewBounds,
} from "../web-view-runtime.js";
import { requireDesktopString } from "./desktop-ipc-parse.js";

const desktopMonitorNotifications = new Set<Electron.Notification>();
export let shortcutCaptureActive = false;

function monitorAlertNotificationInput(value: unknown): import("../../shared/monitor-alerts.js").DesktopMonitorAlertNotification {
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
  const workspaceType = input.workspaceType === "personal" || input.workspaceType === "organization" ? input.workspaceType : null;
  const workspaceId = required("workspaceId", 64);
  if (!workspaceType || !/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error(tr("监控告警通知无效"));
  return {
    id: required("id", 128),
    title: required("title", 160),
    body: required("body", 500),
    workspaceType,
    workspaceId,
    workspaceName: required("workspaceName", 160),
    environmentId,
    sshConnectionId: optionalId("sshConnectionId"),
    serviceId: optionalId("serviceId"),
    deploymentId: optionalId("deploymentId"),
  };
}

export function resetShortcutCapture(): void {
  shortcutCaptureActive = false;
}

export function registerDesktopCoreIpc(desktopUpdater: DesktopUpdater): void {
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
      applyImmersiveNavigationActionPreview(action);
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
