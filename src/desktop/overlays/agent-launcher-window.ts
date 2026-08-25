import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import {
  agentFloatingOverlayInteractionState,
  type AgentFloatingOverlayState,
} from "../../shared/agent-floating-overlay.js";
import { translate as tr } from "../i18n.js";
import { mainWindow } from "../window-host.js";

export let agentLauncherWindow: BrowserWindow | null = null;
export let agentLauncherVisualWindow: BrowserWindow | null = null;
let agentLauncherState: AgentFloatingOverlayState | null = null;
let agentLauncherLoaded = false;
let agentLauncherVisualLoaded = false;

export function layoutAgentLauncherWindow(): void {
  if (!mainWindow || !agentLauncherState) return;
  const content = mainWindow.getContentBounds();
  const layout = (window: BrowserWindow | null, state: AgentFloatingOverlayState) => {
    if (!window || window.isDestroyed()) return;
    const { bounds } = state;
    window.setBounds({
      x: content.x + Math.round(bounds.x),
      y: content.y + Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    }, false);
  };
  layout(agentLauncherVisualWindow, agentLauncherState);
  layout(agentLauncherWindow, agentFloatingOverlayInteractionState(agentLauncherState));
}

export function publishAgentLauncherState(): void {
  if (agentLauncherVisualLoaded && agentLauncherVisualWindow && !agentLauncherVisualWindow.isDestroyed()) {
    agentLauncherVisualWindow.webContents.send("viron:agent-launcher-state", agentLauncherState);
  }
  if (agentLauncherLoaded && agentLauncherWindow && !agentLauncherWindow.isDestroyed()) {
    agentLauncherWindow.webContents.send(
      "viron:agent-launcher-state",
      agentLauncherState ? agentFloatingOverlayInteractionState(agentLauncherState) : null,
    );
  }
}

export function createAgentLauncherWindow(): BrowserWindow {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const root = app.getAppPath();
  const window = new BrowserWindow({
    parent: mainWindow,
    width: 1,
    height: 1,
    show: false,
    focusable: false,
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
      preload: join(root, "dist", "desktop", "agent-launcher-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  return window;
}

export async function ensureAgentLauncherWindow(): Promise<BrowserWindow> {
  if (agentLauncherWindow && !agentLauncherWindow.isDestroyed()
    && agentLauncherVisualWindow && !agentLauncherVisualWindow.isDestroyed()) return agentLauncherWindow;
  agentLauncherWindow?.close();
  agentLauncherVisualWindow?.close();

  const root = app.getAppPath();
  const visual = createAgentLauncherWindow();
  const interaction = createAgentLauncherWindow();
  agentLauncherVisualWindow = visual;
  agentLauncherWindow = interaction;
  agentLauncherVisualLoaded = false;
  agentLauncherLoaded = false;
  visual.setIgnoreMouseEvents(true);
  visual.webContents.once("did-finish-load", () => {
    agentLauncherVisualLoaded = true;
    publishAgentLauncherState();
  });
  interaction.webContents.once("did-finish-load", () => {
    agentLauncherLoaded = true;
    publishAgentLauncherState();
  });
  visual.on("closed", () => {
    if (agentLauncherVisualWindow === visual) {
      agentLauncherVisualWindow = null;
      agentLauncherVisualLoaded = false;
    }
  });
  interaction.on("closed", () => {
    if (agentLauncherWindow === interaction) {
      agentLauncherWindow = null;
      agentLauncherLoaded = false;
    }
  });
  await Promise.all([
    visual.loadFile(join(root, "dist", "desktop-renderer", "desktop-agent-launcher.html")),
    interaction.loadFile(join(root, "dist", "desktop-renderer", "desktop-agent-launcher.html")),
  ]);
  return interaction;
}

export async function updateAgentLauncherWindow(state: AgentFloatingOverlayState | null): Promise<void> {
  agentLauncherState = state;
  if (!state) {
    publishAgentLauncherState();
    agentLauncherWindow?.hide();
    agentLauncherVisualWindow?.hide();
    return;
  }
  const interaction = await ensureAgentLauncherWindow();
  if (agentLauncherState !== state) return;
  layoutAgentLauncherWindow();
  publishAgentLauncherState();
  if (agentLauncherVisualWindow && !agentLauncherVisualWindow.isVisible()) agentLauncherVisualWindow.showInactive();
  if (!interaction.isVisible()) interaction.showInactive();
  if (agentLauncherVisualWindow) interaction.moveAbove(agentLauncherVisualWindow.getMediaSourceId());
}
