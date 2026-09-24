import { BrowserWindow, type Rectangle } from "electron";
import { mainWindow } from "../window-host.js";
import { raiseNativeOverlayWindows, registerNativeOverlayWindow, updateNativeOverlayPriority } from "./native-window-stack.js";

const overlayName = /^viron-dom-overlay-[a-z0-9-]{1,64}$/;
const windows = new Map<string, { window: BrowserWindow; order: number; bounds: Rectangle | null }>();

export function isDomOverlayRequest(url: string, frameName: string): boolean {
  return url === "about:blank" && overlayName.test(frameName);
}

export function registerDomOverlayWindow(frameName: string, window: BrowserWindow): void {
  if (!overlayName.test(frameName) || !mainWindow || window.getParentWindow() !== mainWindow) {
    window.close();
    return;
  }
  windows.get(frameName)?.window.close();
  windows.set(frameName, { window, order: 0, bounds: null });
  registerNativeOverlayWindow(window, 0);
  window.setMenuBarVisibility(false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    if (windows.get(frameName)?.window === window) windows.delete(frameName);
  });
}

function checkedBounds(input: Rectangle): Rectangle {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window unavailable");
  if (!input || ![input.x, input.y, input.width, input.height].every(Number.isFinite)) {
    throw new Error("Invalid overlay bounds");
  }
  const content = mainWindow.getContentBounds();
  const x = Math.max(0, Math.min(content.width - 1, Math.floor(input.x)));
  const y = Math.max(0, Math.min(content.height - 1, Math.floor(input.y)));
  const width = Math.max(1, Math.min(content.width - x, Math.ceil(input.width)));
  const height = Math.max(1, Math.min(content.height - y, Math.ceil(input.height)));
  return { x: content.x + x, y: content.y + y, width, height };
}

export function layoutDomOverlayWindow(frameName: string, bounds: Rectangle, order: number, focus = false): void {
  const entry = windows.get(frameName);
  if (!entry || entry.window.isDestroyed()) return;
  entry.order = Number.isFinite(order) ? Math.max(-1_000_000, Math.min(1_000_000, order)) : 0;
  updateNativeOverlayPriority(entry.window, entry.order);
  entry.bounds = bounds;
  entry.window.setBounds(checkedBounds(bounds), false);
  if (!entry.window.isVisible()) {
    entry.window.showInactive();
    if (focus) entry.window.focus();
  }
  raiseDomOverlayWindows();
}

export function hideDomOverlayWindow(frameName: string): void {
  const entry = windows.get(frameName);
  if (entry?.window && !entry.window.isDestroyed()) entry.window.hide();
}

export function closeDomOverlayWindow(frameName: string): void {
  const entry = windows.get(frameName);
  if (entry?.window && !entry.window.isDestroyed()) {
    const focused = entry.window.isFocused();
    entry.window.close();
    if (focused && mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  }
}

export function domOverlayWindow(frameName: string): BrowserWindow | null {
  const window = windows.get(frameName)?.window;
  return window && !window.isDestroyed() ? window : null;
}

export function domOverlayWindows(): BrowserWindow[] {
  return [...windows.values()].map((entry) => entry.window).filter((window) => !window.isDestroyed());
}

export function layoutDomOverlayWindows(): void {
  for (const entry of windows.values()) {
    if (entry.window.isDestroyed() || !entry.bounds) continue;
    entry.window.setBounds(checkedBounds(entry.bounds), false);
  }
}

export function raiseDomOverlayWindows(): void {
  raiseNativeOverlayWindows();
}

export function closeAllDomOverlayWindows(): void {
  for (const frameName of [...windows.keys()]) closeDomOverlayWindow(frameName);
}
