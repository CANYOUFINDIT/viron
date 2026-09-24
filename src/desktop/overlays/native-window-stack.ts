import type { BrowserWindow } from "electron";

const windows = new Map<BrowserWindow, { priority: number; sequence: number }>();
let sequence = 0;

export function registerNativeOverlayWindow(window: BrowserWindow, priority: number): void {
  windows.set(window, { priority, sequence: ++sequence });
  window.on("show", raiseNativeOverlayWindows);
  window.on("focus", raiseNativeOverlayWindows);
  window.once("closed", () => {
    window.off("show", raiseNativeOverlayWindows);
    window.off("focus", raiseNativeOverlayWindows);
    windows.delete(window);
  });
}

export function updateNativeOverlayPriority(window: BrowserWindow, priority: number): void {
  const entry = windows.get(window);
  if (!entry) return;
  entry.priority = priority;
  raiseNativeOverlayWindows();
}

export function raiseNativeOverlayWindows(): void {
  for (const window of [...windows.entries()]
    .filter(([window]) => !window.isDestroyed() && window.isVisible())
    .sort((a, b) => a[1].priority - b[1].priority || a[1].sequence - b[1].sequence)
    .map(([window]) => window)) window.moveTop();
}
