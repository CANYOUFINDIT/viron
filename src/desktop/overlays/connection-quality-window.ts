import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import {
  connectionQualityOverlayInteractionState,
  type ConnectionQualityOverlayState,
} from "../../shared/connection-quality.js";
import { translate as tr } from "../i18n.js";
import { mainWindow } from "../window-host.js";

export let connectionQualityWindow: BrowserWindow | null = null;
export let connectionQualityVisualWindow: BrowserWindow | null = null;
let connectionQualityState: ConnectionQualityOverlayState | null = null;
let connectionQualityLoaded = false;
let connectionQualityVisualLoaded = false;

export function layoutConnectionQualityWindow(): void {
  if (!mainWindow || !connectionQualityState) return;
  const content = mainWindow.getContentBounds();
  const layout = (window: BrowserWindow | null, state: ConnectionQualityOverlayState) => {
    if (!window || window.isDestroyed()) return;
    window.setBounds({
      x: content.x + Math.round(state.bounds.x),
      y: content.y + Math.round(state.bounds.y),
      width: Math.max(1, Math.round(state.bounds.width)),
      height: Math.max(1, Math.round(state.bounds.height)),
    }, false);
  };
  layout(connectionQualityVisualWindow, connectionQualityState);
  layout(connectionQualityWindow, connectionQualityOverlayInteractionState(connectionQualityState));
}

export function publishConnectionQualityState(): void {
  if (connectionQualityVisualLoaded && connectionQualityVisualWindow && !connectionQualityVisualWindow.isDestroyed()) {
    connectionQualityVisualWindow.webContents.send("viron:connection-quality-state", connectionQualityState);
  }
  if (connectionQualityLoaded && connectionQualityWindow && !connectionQualityWindow.isDestroyed()) {
    connectionQualityWindow.webContents.send(
      "viron:connection-quality-state",
      connectionQualityState ? connectionQualityOverlayInteractionState(connectionQualityState) : null,
    );
  }
}

export function createConnectionQualityWindow(): BrowserWindow {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const root = app.getAppPath();
  const overlay = new BrowserWindow({
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
      preload: join(root, "dist", "desktop", "connection-quality-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  overlay.setMenuBarVisibility(false);
  overlay.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event, url) => {
    if (url !== overlay.webContents.getURL()) event.preventDefault();
  });
  return overlay;
}

export async function ensureConnectionQualityWindow(): Promise<BrowserWindow> {
  if (connectionQualityWindow && !connectionQualityWindow.isDestroyed()
    && connectionQualityVisualWindow && !connectionQualityVisualWindow.isDestroyed()) return connectionQualityWindow;
  connectionQualityWindow?.close();
  connectionQualityVisualWindow?.close();
  const root = app.getAppPath();
  const visual = createConnectionQualityWindow();
  const interaction = createConnectionQualityWindow();
  connectionQualityVisualWindow = visual;
  connectionQualityWindow = interaction;
  connectionQualityVisualLoaded = false;
  connectionQualityLoaded = false;
  visual.setIgnoreMouseEvents(true);
  visual.webContents.once("did-finish-load", () => {
    connectionQualityVisualLoaded = true;
    publishConnectionQualityState();
  });
  interaction.webContents.once("did-finish-load", () => {
    connectionQualityLoaded = true;
    publishConnectionQualityState();
  });
  visual.on("closed", () => {
    if (connectionQualityVisualWindow === visual) {
      connectionQualityVisualWindow = null;
      connectionQualityVisualLoaded = false;
    }
  });
  interaction.on("closed", () => {
    if (connectionQualityWindow === interaction) {
      connectionQualityWindow = null;
      connectionQualityLoaded = false;
    }
  });
  await Promise.all([
    visual.loadFile(join(root, "dist", "desktop-renderer", "desktop-connection-quality.html")),
    interaction.loadFile(join(root, "dist", "desktop-renderer", "desktop-connection-quality.html")),
  ]);
  return interaction;
}

export async function updateConnectionQualityWindow(state: ConnectionQualityOverlayState | null): Promise<void> {
  connectionQualityState = state;
  if (!state) {
    publishConnectionQualityState();
    connectionQualityWindow?.hide();
    connectionQualityVisualWindow?.hide();
    return;
  }
  const interaction = await ensureConnectionQualityWindow();
  if (connectionQualityState !== state) return;
  layoutConnectionQualityWindow();
  publishConnectionQualityState();
  if (connectionQualityVisualWindow && !connectionQualityVisualWindow.isVisible()) connectionQualityVisualWindow.showInactive();
  if (!interaction.isVisible()) interaction.showInactive();
  if (connectionQualityVisualWindow) interaction.moveAbove(connectionQualityVisualWindow.getMediaSourceId());
}
