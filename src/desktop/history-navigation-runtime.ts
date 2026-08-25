import { type BrowserWindow, type WebContents } from "electron";
import {
  HISTORY_NAVIGATION_SCROLL_PROBE,
  defaultHistoryNavigationGestureConfig,
  historyNavigationFromAppCommand,
  historyNavigationFromMouseButton,
  historyNavigationFromSwipeDirection,
  historyNavigationProgress,
  idleHistoryNavigationGesture,
  reduceHistoryNavigationWheel,
  settleHistoryNavigationGesture,
  type HistoryNavigationDirection,
  type HistoryNavigationGestureState,
} from "../shared/history-navigation-gesture.js";
import {
  hideDesktopHistoryNavigationOverlay,
  closeDesktopHistoryNavigationOverlay,
  scheduleDesktopHistoryNavigationOverlayHide,
  showDesktopHistoryNavigationOverlay,
} from "./overlays/history-navigation-window.js";
import { desktopWebViews } from "./web-view-support.js";
import { mainWindow } from "./window-host.js";

interface HistoryNavigationSurfaceView {
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  closing: boolean;
  closedReason: string;
}

let historyNavigationGesture = idleHistoryNavigationGesture();
let historyNavigationGestureTimer: NodeJS.Timeout | null = null;
let historyNavigationScrollBlocked: boolean | null = null;
let historyNavigationScrollProbe = 0;
let historyNavigationAppliedAt = 0;
let historyNavigationTouchHeld = false;
const HISTORY_NAVIGATION_COOLDOWN_MS = 420;

function visibleHistoryNavigationWebView(): HistoryNavigationSurfaceView | null {
  for (const view of desktopWebViews.values()) {
    if (view.visible && !view.closing && !view.closedReason) return view;
  }
  return null;
}

export function resetDesktopHistoryNavigationGesture(time = Date.now()): void {
  if (historyNavigationGestureTimer) {
    clearTimeout(historyNavigationGestureTimer);
    historyNavigationGestureTimer = null;
  }
  historyNavigationTouchHeld = false;
  historyNavigationGesture = idleHistoryNavigationGesture(time);
  historyNavigationScrollBlocked = null;
  hideDesktopHistoryNavigationOverlay();
}

export function closeDesktopHistoryNavigation(): void {
  closeDesktopHistoryNavigationOverlay();
  resetDesktopHistoryNavigationGesture();
}

function sendHistoryNavigationTouch(phase: "begin" | "end"): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("viron:history-navigation-touch", phase);
}

function applyDesktopHistoryNavigation(direction: HistoryNavigationDirection): boolean {
  const now = Date.now();
  if (now - historyNavigationAppliedAt < HISTORY_NAVIGATION_COOLDOWN_MS) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  historyNavigationAppliedAt = now;
  mainWindow.webContents.send("viron:history-navigation", direction);
  return true;
}

function publishDesktopHistoryNavigationGesture(state: HistoryNavigationGestureState, view: HistoryNavigationSurfaceView | null): void {
  if (!state.direction || state.status === "idle") {
    hideDesktopHistoryNavigationOverlay();
    return;
  }
  const rawProgress = historyNavigationProgress(state);
  if (rawProgress < 0.02 && state.status === "pending") return;
  const progress = state.status === "committed" ? 1 : Math.max(rawProgress, 0.18);
  if (!view) return;
  void showDesktopHistoryNavigationOverlay(state.direction, progress, view.bounds);
}

function commitDesktopHistoryNavigation(direction: HistoryNavigationDirection, view: HistoryNavigationSurfaceView | null): void {
  applyDesktopHistoryNavigation(direction);
  publishDesktopHistoryNavigationGesture(historyNavigationGesture, view);
  scheduleDesktopHistoryNavigationOverlayHide(() => resetDesktopHistoryNavigationGesture(Date.now()), 180);
}

function finishDesktopHistoryNavigationGesture(): void {
  if (historyNavigationGesture.status === "committed") return;
  const view = visibleHistoryNavigationWebView();
  const settled = settleHistoryNavigationGesture(historyNavigationGesture, Date.now());
  if (settled.status === "committed" && settled.direction && historyNavigationScrollBlocked !== true) {
    historyNavigationGesture = settled;
    commitDesktopHistoryNavigation(settled.direction, view);
    return;
  }
  resetDesktopHistoryNavigationGesture(Date.now());
}

function handleHistoryNavigationInputEvent(input: Electron.InputEvent): void {
  if (input.type === "gestureScrollBegin") {
    historyNavigationTouchHeld = true;
    if (historyNavigationGestureTimer) {
      clearTimeout(historyNavigationGestureTimer);
      historyNavigationGestureTimer = null;
    }
    sendHistoryNavigationTouch("begin");
    return;
  }
  if (input.type !== "gestureScrollEnd" && input.type !== "gestureFlingStart") return;
  if (!historyNavigationTouchHeld && historyNavigationGesture.status === "idle") return;
  historyNavigationTouchHeld = false;
  sendHistoryNavigationTouch("end");
  finishDesktopHistoryNavigationGesture();
}

export function attachHistoryNavigationTouchTracking(webContents: WebContents): void {
  webContents.on("input-event", (_event, input) => {
    handleHistoryNavigationInputEvent(input);
  });
}

function scheduleDesktopHistoryNavigationIdle(time: number, view: HistoryNavigationSurfaceView): void {
  if (historyNavigationTouchHeld) return;
  if (historyNavigationGestureTimer) clearTimeout(historyNavigationGestureTimer);
  historyNavigationGestureTimer = setTimeout(() => {
    if (historyNavigationGesture.status === "committed") return;
    const settled = settleHistoryNavigationGesture(historyNavigationGesture, Date.now());
    if (settled.status === "committed" && settled.direction && historyNavigationScrollBlocked !== true) {
      historyNavigationGesture = settled;
      commitDesktopHistoryNavigation(settled.direction, view);
      return;
    }
    resetDesktopHistoryNavigationGesture(time);
  }, defaultHistoryNavigationGestureConfig.idleMs);
}

export function handleDesktopHistoryNavigationCommand(direction: HistoryNavigationDirection): void {
  const view = visibleHistoryNavigationWebView();
  applyDesktopHistoryNavigation(direction);
  historyNavigationGesture = {
    status: "committed",
    direction,
    distance: 108,
    lastEventAt: Date.now(),
  };
  if (view) void showDesktopHistoryNavigationOverlay(direction, 1, view.bounds);
  scheduleDesktopHistoryNavigationOverlayHide(() => resetDesktopHistoryNavigationGesture(Date.now()), 180);
}

function probeDesktopHistoryNavigationScroll(webContents: WebContents, direction: HistoryNavigationDirection): void {
  if (historyNavigationScrollBlocked !== null || webContents.isDestroyed()) return;
  const sequence = ++historyNavigationScrollProbe;
  void webContents.executeJavaScript(`(${HISTORY_NAVIGATION_SCROLL_PROBE})(${JSON.stringify(direction)})`, true)
    .then((blocked) => {
      if (sequence !== historyNavigationScrollProbe) return;
      historyNavigationScrollBlocked = Boolean(blocked);
      if (historyNavigationScrollBlocked) resetDesktopHistoryNavigationGesture(Date.now());
    })
    .catch(() => {
      if (sequence !== historyNavigationScrollProbe) return;
      historyNavigationScrollBlocked = false;
    });
}

export function handleDesktopHistoryNavigationWheel(
  event: Electron.Event,
  mouse: Electron.MouseInputEvent,
  view: HistoryNavigationSurfaceView,
  webContents: WebContents,
): void {
  if (mouse.type !== "mouseWheel") return;
  const wheel = mouse as Electron.MouseWheelInputEvent;
  const time = Date.now();
  const next = reduceHistoryNavigationWheel(historyNavigationGesture, {
    deltaX: Number(wheel.deltaX ?? 0) || Number(wheel.wheelTicksX ?? 0) * 40,
    deltaY: Number(wheel.deltaY ?? 0) || Number(wheel.wheelTicksY ?? 0) * 40,
    deltaMode: 0,
    ctrlKey: false,
    shiftKey: false,
    holding: historyNavigationTouchHeld,
    time,
  });
  if (next.direction && next.status !== "idle") probeDesktopHistoryNavigationScroll(webContents, next.direction);
  const blocked = historyNavigationScrollBlocked;
  if (blocked) {
    resetDesktopHistoryNavigationGesture(time);
    return;
  }
  historyNavigationGesture = next;
  if (next.status === "armed" || next.status === "committed" || (blocked === false && next.status === "pending")) {
    event.preventDefault();
  }
  publishDesktopHistoryNavigationGesture(next, view);
  if (next.status === "idle") hideDesktopHistoryNavigationOverlay();
  else scheduleDesktopHistoryNavigationIdle(time, view);
}

export function handleDesktopHistoryNavigationMouse(
  event: Electron.Event,
  mouse: Electron.MouseInputEvent,
  view: HistoryNavigationSurfaceView,
  webContents: WebContents,
): boolean {
  if (mouse.type === "mouseWheel") {
    handleDesktopHistoryNavigationWheel(event, mouse, view, webContents);
    return true;
  }
  if (mouse.type !== "mouseDown") return false;
  const historyDirection = historyNavigationFromMouseButton(mouse.button);
  if (!historyDirection) return false;
  event.preventDefault();
  handleDesktopHistoryNavigationCommand(historyDirection);
  return true;
}

export function attachDesktopHistoryNavigationListeners(window: BrowserWindow): void {
  attachHistoryNavigationTouchTracking(window.webContents);
  window.on("swipe", (_event, direction) => {
    const navigation = historyNavigationFromSwipeDirection(direction);
    if (navigation) handleDesktopHistoryNavigationCommand(navigation);
  });
  window.on("app-command", (event, command) => {
    const navigation = historyNavigationFromAppCommand(command);
    if (!navigation) return;
    event.preventDefault();
    handleDesktopHistoryNavigationCommand(navigation);
  });
}
