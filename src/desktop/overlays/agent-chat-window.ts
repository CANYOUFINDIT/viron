import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import {
  type AgentHostAction,
  type AgentHostActionRequest,
  type AgentHostActionResult,
  type AgentHostState,
} from "../../shared/agent-host.js";
import { translate as tr } from "../i18n.js";
import { mainWindow } from "../window-host.js";
import { agentLauncherVisualWindow, agentLauncherWindow } from "./agent-launcher-window.js";

export let agentChatWindow: BrowserWindow | null = null;
export let agentChatLoaded = false;
export let agentChatHostState: AgentHostState | null = null;
let agentChatChromeVisible = false;
let agentChatIgnoreMouse = false;
let agentChatNativeOverlay = false;
const pendingAgentHostActions = new Map<string, {
  resolve: (result: AgentHostActionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export function sendToAgentChat(channel: string, ...args: unknown[]): void {
  if (!agentChatWindow || agentChatWindow.isDestroyed() || !agentChatLoaded) return;
  agentChatWindow.webContents.send(channel, ...args);
}

export function layoutAgentChatWindow(): void {
  if (!mainWindow || !agentChatWindow || agentChatWindow.isDestroyed()) return;
  const content = mainWindow.getContentBounds();
  agentChatWindow.setBounds({
    x: content.x,
    y: content.y,
    width: Math.max(1, content.width),
    height: Math.max(1, content.height),
  }, false);
}

export function publishAgentHostState(): void {
  sendToAgentChat("viron:agent-host-state", agentChatHostState);
}

export function applyAgentChatIgnoreMouse(): void {
  if (!agentChatWindow || agentChatWindow.isDestroyed()) return;
  if (agentChatIgnoreMouse) agentChatWindow.setIgnoreMouseEvents(true, { forward: true });
  else agentChatWindow.setIgnoreMouseEvents(false);
}

// z-order: chat, then visual launcher, then interaction launcher. Do not reverse.
export function raiseAgentOverlayWindows(): void {
  if (agentChatWindow && !agentChatWindow.isDestroyed() && agentChatWindow.isVisible()) agentChatWindow.moveTop();
  if (agentLauncherVisualWindow && !agentLauncherVisualWindow.isDestroyed() && agentLauncherVisualWindow.isVisible()) {
    agentLauncherVisualWindow.moveTop();
  }
  if (agentLauncherWindow && !agentLauncherWindow.isDestroyed() && agentLauncherWindow.isVisible()) {
    agentLauncherWindow.moveTop();
  }
}

export function applyAgentChatChromeVisibility(): void {
  if (!agentChatWindow || agentChatWindow.isDestroyed()) return;
  if (agentChatNativeOverlay && agentChatHostState && agentChatChromeVisible) {
    agentChatIgnoreMouse = false;
    layoutAgentChatWindow();
    applyAgentChatIgnoreMouse();
    if (!agentChatWindow.isVisible()) agentChatWindow.showInactive();
    raiseAgentOverlayWindows();
    return;
  }
  if (agentChatWindow.isVisible()) agentChatWindow.hide();
}

export async function setAgentChatNativeOverlay(active: boolean): Promise<void> {
  agentChatNativeOverlay = active;
  if (!active) {
    agentChatChromeVisible = false;
    if (agentChatWindow && !agentChatWindow.isDestroyed()) {
      agentChatWindow.close();
      agentChatWindow = null;
      agentChatLoaded = false;
    }
    return;
  }
  await ensureAgentChatWindow();
  applyAgentChatChromeVisibility();
}

export async function ensureAgentChatWindow(): Promise<BrowserWindow> {
  if (agentChatWindow && !agentChatWindow.isDestroyed()) return agentChatWindow;
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const root = app.getAppPath();
  const overlay = new BrowserWindow({
    parent: mainWindow,
    width: 1,
    height: 1,
    show: false,
    focusable: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: false,
    webPreferences: {
      preload: join(root, "dist", "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  agentChatWindow = overlay;
  agentChatLoaded = false;
  overlay.setMenuBarVisibility(false);
  overlay.setIgnoreMouseEvents(false);
  overlay.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event, url) => {
    if (url !== overlay.webContents.getURL()) event.preventDefault();
  });
  overlay.webContents.once("did-finish-load", () => {
    agentChatLoaded = true;
    publishAgentHostState();
    applyAgentChatChromeVisibility();
  });
  overlay.on("closed", () => {
    if (agentChatWindow === overlay) {
      agentChatWindow = null;
      agentChatLoaded = false;
    }
  });
  await overlay.loadFile(join(root, "dist", "desktop-renderer", "desktop-agent-chat.html"));
  return overlay;
}

export async function updateAgentChatHost(state: AgentHostState | null): Promise<void> {
  agentChatHostState = state;
  if (!state || !agentChatNativeOverlay) {
    if (!state) agentChatChromeVisible = false;
    publishAgentHostState();
    applyAgentChatChromeVisibility();
    return;
  }
  await ensureAgentChatWindow();
  if (agentChatHostState !== state) return;
  publishAgentHostState();
  applyAgentChatChromeVisibility();
}

export function settleAgentHostAction(id: string, result: AgentHostActionResult | Error): boolean {
  const pending = pendingAgentHostActions.get(id);
  if (!pending) return false;
  pendingAgentHostActions.delete(id);
  clearTimeout(pending.timer);
  if (result instanceof Error) pending.reject(result);
  else pending.resolve(result);
  return true;
}

export function requestAgentHostAction(action: AgentHostAction): Promise<AgentHostActionResult> {
  const hostWindow = mainWindow;
  if (!hostWindow || hostWindow.isDestroyed()) return Promise.reject(new Error(tr("Viron 主窗口不可用")));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settleAgentHostAction(id, new Error(tr("Viron Agent 宿主操作超时")));
    }, 15_000);
    timer.unref?.();
    pendingAgentHostActions.set(id, { resolve, reject, timer });
    const request: AgentHostActionRequest = { id, action };
    hostWindow.webContents.send("viron:agent-host-request", request);
  });
}

export function setAgentChatChromeVisible(visible: boolean): void {
  agentChatChromeVisible = visible;
  applyAgentChatChromeVisibility();
}

export function setAgentChatIgnoreMouse(ignore: boolean): void {
  agentChatIgnoreMouse = ignore;
  applyAgentChatIgnoreMouse();
}
