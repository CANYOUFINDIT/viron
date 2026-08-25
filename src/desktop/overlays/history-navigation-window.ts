import { BrowserWindow, type Rectangle } from "electron";
import {
  HISTORY_NAVIGATION_HANDLE_SIZE,
  historyNavigationHandleBounds,
  type HistoryNavigationDirection,
} from "../../shared/history-navigation-gesture.js";
import { HISTORY_NAVIGATION_OVERLAY_CSS } from "../history-navigation-overlay.js";
import { mainWindow } from "../window-host.js";

export let historyNavigationOverlay: BrowserWindow | null = null;
let historyNavigationOverlayHideTimer: NodeJS.Timeout | null = null;

export function hideDesktopHistoryNavigationOverlay(): void {
  if (historyNavigationOverlayHideTimer) {
    clearTimeout(historyNavigationOverlayHideTimer);
    historyNavigationOverlayHideTimer = null;
  }
  historyNavigationOverlay?.hide();
}

export function closeDesktopHistoryNavigationOverlay(): void {
  hideDesktopHistoryNavigationOverlay();
  historyNavigationOverlay?.close();
  historyNavigationOverlay = null;
}

export function scheduleDesktopHistoryNavigationOverlayHide(callback: () => void, delayMs: number): void {
  if (historyNavigationOverlayHideTimer) clearTimeout(historyNavigationOverlayHideTimer);
  historyNavigationOverlayHideTimer = setTimeout(callback, delayMs);
}

export async function ensureHistoryNavigationOverlay(): Promise<BrowserWindow | null> {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (historyNavigationOverlay && !historyNavigationOverlay.isDestroyed()) return historyNavigationOverlay;
  const overlay = new BrowserWindow({
    parent: mainWindow,
    width: HISTORY_NAVIGATION_HANDLE_SIZE.width,
    height: HISTORY_NAVIGATION_HANDLE_SIZE.height,
    show: false,
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
    focusable: false,
    roundedCorners: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  overlay.setMenuBarVisibility(false);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event, url) => {
    if (url !== overlay.webContents.getURL()) event.preventDefault();
  });
  overlay.on("closed", () => {
    if (historyNavigationOverlay === overlay) historyNavigationOverlay = null;
  });
  historyNavigationOverlay = overlay;
  await overlay.loadURL("about:blank");
  if (historyNavigationOverlay !== overlay) return null;
  await overlay.webContents.insertCSS(HISTORY_NAVIGATION_OVERLAY_CSS);
  await overlay.webContents.executeJavaScript(`
    document.documentElement.dataset.direction = "back";
    document.body.innerHTML = '<div class="handle" aria-hidden="true"><i class="chevron"></i></div>';
  `);
  return overlay;
}

export function layoutDesktopHistoryNavigationOverlay(
  direction: HistoryNavigationDirection,
  progress: number,
  surface: Rectangle,
): void {
  if (!mainWindow || mainWindow.isDestroyed() || !historyNavigationOverlay || historyNavigationOverlay.isDestroyed()) return;
  const content = mainWindow.getContentBounds();
  const bounds = historyNavigationHandleBounds(direction, progress, surface);
  historyNavigationOverlay.setBounds({
    x: Math.round(content.x + bounds.x),
    y: Math.round(content.y + bounds.y),
    width: bounds.width,
    height: bounds.height,
  }, false);
  void historyNavigationOverlay.webContents.executeJavaScript(
    `document.documentElement.dataset.direction = ${JSON.stringify(direction)};`,
  ).catch(() => undefined);
}

export async function showDesktopHistoryNavigationOverlay(
  direction: HistoryNavigationDirection,
  progress: number,
  surface: Rectangle,
): Promise<void> {
  const overlay = await ensureHistoryNavigationOverlay();
  if (!overlay || overlay.isDestroyed()) return;
  layoutDesktopHistoryNavigationOverlay(direction, progress, surface);
  if (!overlay.isVisible()) overlay.showInactive();
}
