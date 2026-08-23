import { join } from "node:path";
import { app, BrowserWindow, screen as electronScreen } from "electron";
import {
  activeEnvironmentDockPointInsideBounds,
  ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS,
  ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS,
  type ActiveEnvironmentDockAction,
  type ActiveEnvironmentDockDragAction,
  type ActiveEnvironmentDockLayoutState,
  type ActiveEnvironmentDockState,
} from "../../shared/active-environment-dock.js";
import { translate as tr } from "../i18n.js";
import { mainWindow } from "../window-host.js";

export let activeEnvironmentDockWindow: BrowserWindow | null = null;
export let activeEnvironmentDockState: ActiveEnvironmentDockState | null = null;
let activeEnvironmentDockLoaded = false;
let activeEnvironmentDockPointerTimer: NodeJS.Timeout | null = null;
let activeEnvironmentDockPointerOutsideSince: number | null = null;
let activeEnvironmentDockCollapseLayoutTimer: NodeJS.Timeout | null = null;
let activeEnvironmentDockDrag: {
  pointer: { x: number; y: number };
  origin: { x: number; y: number };
  moved: boolean;
} | null = null;

export function layoutActiveEnvironmentDockWindow(): void {
  if (activeEnvironmentDockDrag || activeEnvironmentDockCollapseLayoutTimer
    || !mainWindow || !activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed() || !activeEnvironmentDockState) return;
  const content = mainWindow.getContentBounds();
  activeEnvironmentDockWindow.setBounds({
    x: content.x + Math.round(activeEnvironmentDockState.bounds.x),
    y: content.y + Math.round(activeEnvironmentDockState.bounds.y),
    width: Math.max(1, Math.round(activeEnvironmentDockState.bounds.width)),
    height: Math.max(1, Math.round(activeEnvironmentDockState.bounds.height)),
  }, false);
}

export function stopActiveEnvironmentDockCollapseLayout(): void {
  if (activeEnvironmentDockCollapseLayoutTimer) clearTimeout(activeEnvironmentDockCollapseLayoutTimer);
  activeEnvironmentDockCollapseLayoutTimer = null;
}

export function scheduleActiveEnvironmentDockCollapseLayout(): void {
  if (activeEnvironmentDockCollapseLayoutTimer) return;
  activeEnvironmentDockCollapseLayoutTimer = setTimeout(() => {
    activeEnvironmentDockCollapseLayoutTimer = null;
    layoutActiveEnvironmentDockWindow();
  }, ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS + 34);
  activeEnvironmentDockCollapseLayoutTimer.unref();
}

export function publishActiveEnvironmentDockState(): void {
  if (!activeEnvironmentDockLoaded || !activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed()) return;
  activeEnvironmentDockWindow.webContents.send("viron:active-environment-dock-state", activeEnvironmentDockState);
}

export function publishActiveEnvironmentDockLayout(): void {
  if (!activeEnvironmentDockLoaded || !activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed() || !activeEnvironmentDockState) return;
  activeEnvironmentDockWindow.webContents.send("viron:active-environment-dock-layout", {
    bounds: { ...activeEnvironmentDockState.bounds },
    card: { ...activeEnvironmentDockState.card },
    expanded: activeEnvironmentDockState.expanded,
    growUp: activeEnvironmentDockState.growUp,
    dragging: activeEnvironmentDockState.dragging,
  } satisfies ActiveEnvironmentDockLayoutState);
}

export function stopActiveEnvironmentDockPointerTracking(): void {
  if (activeEnvironmentDockPointerTimer) clearTimeout(activeEnvironmentDockPointerTimer);
  activeEnvironmentDockPointerTimer = null;
  activeEnvironmentDockPointerOutsideSince = null;
}

export function activeEnvironmentDockPointerInside(): boolean {
  if (!activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed()) return false;
  return activeEnvironmentDockPointInsideBounds(
    electronScreen.getCursorScreenPoint(),
    activeEnvironmentDockWindow.getBounds(),
  );
}

export function scheduleActiveEnvironmentDockPointerTracking(): void {
  if (activeEnvironmentDockPointerTimer || !activeEnvironmentDockState?.expanded
    || !activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed()) return;
  const inspect = () => {
    activeEnvironmentDockPointerTimer = null;
    if (!activeEnvironmentDockState?.expanded || !activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed()) {
      stopActiveEnvironmentDockPointerTracking();
      return;
    }
    if (activeEnvironmentDockDrag || activeEnvironmentDockPointerInside()) {
      activeEnvironmentDockPointerOutsideSince = null;
    } else {
      const now = Date.now();
      activeEnvironmentDockPointerOutsideSince ??= now;
      if (now - activeEnvironmentDockPointerOutsideSince >= ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS) {
        activeEnvironmentDockPointerOutsideSince = null;
        mainWindow?.webContents.send("viron:active-environment-dock-action", { type: "collapse" } satisfies ActiveEnvironmentDockAction);
        return;
      }
    }
    activeEnvironmentDockPointerTimer = setTimeout(inspect, 80);
    activeEnvironmentDockPointerTimer.unref();
  };
  activeEnvironmentDockPointerTimer = setTimeout(inspect, 80);
  activeEnvironmentDockPointerTimer.unref();
}

export function keepActiveEnvironmentDockExpanded(): void {
  activeEnvironmentDockPointerOutsideSince = null;
  scheduleActiveEnvironmentDockPointerTracking();
}

export function activeEnvironmentDockPosition(): { x: number; y: number } | null {
  if (!mainWindow || !activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed()) return null;
  const content = mainWindow.getContentBounds();
  const bounds = activeEnvironmentDockWindow.getBounds();
  return { x: bounds.x - content.x, y: bounds.y - content.y };
}

export function sendActiveEnvironmentDockPosition(): void {
  const position = activeEnvironmentDockPosition();
  if (!position || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("viron:active-environment-dock-action", {
    type: "position",
    ...position,
  } satisfies ActiveEnvironmentDockAction);
}

export function handleActiveEnvironmentDockDrag(action: ActiveEnvironmentDockDragAction): void {
  if (!mainWindow || !activeEnvironmentDockWindow || activeEnvironmentDockWindow.isDestroyed()) return;
  if (action.type === "drag-start") {
    const bounds = activeEnvironmentDockWindow.getBounds();
    activeEnvironmentDockDrag = {
      pointer: { x: action.screenX, y: action.screenY },
      origin: { x: bounds.x, y: bounds.y },
      moved: false,
    };
    mainWindow.webContents.send("viron:active-environment-dock-action", action);
    return;
  }
  if (!activeEnvironmentDockDrag) return;
  if (action.type === "drag-move") {
    const deltaX = action.screenX - activeEnvironmentDockDrag.pointer.x;
    const deltaY = action.screenY - activeEnvironmentDockDrag.pointer.y;
    if (!activeEnvironmentDockDrag.moved && Math.hypot(deltaX, deltaY) < 7) return;
    activeEnvironmentDockDrag.moved = true;
    const content = mainWindow.getContentBounds();
    const bounds = activeEnvironmentDockWindow.getBounds();
    const x = Math.min(
      Math.max(content.x, activeEnvironmentDockDrag.origin.x + deltaX),
      Math.max(content.x, content.x + content.width - bounds.width),
    );
    const y = Math.min(
      Math.max(content.y, activeEnvironmentDockDrag.origin.y + deltaY),
      Math.max(content.y, content.y + content.height - bounds.height),
    );
    activeEnvironmentDockWindow.setPosition(Math.round(x), Math.round(y), false);
    return;
  }
  const moved = activeEnvironmentDockDrag.moved;
  activeEnvironmentDockDrag = null;
  if (moved) sendActiveEnvironmentDockPosition();
  else mainWindow.webContents.send("viron:active-environment-dock-action", action);
}

export async function ensureActiveEnvironmentDockWindow(): Promise<BrowserWindow> {
  if (activeEnvironmentDockWindow && !activeEnvironmentDockWindow.isDestroyed()) return activeEnvironmentDockWindow;
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const root = app.getAppPath();
  const overlay = new BrowserWindow({
    parent: mainWindow,
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    roundedCorners: true,
    webPreferences: {
      preload: join(root, "dist", "desktop", "active-environment-dock-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  activeEnvironmentDockWindow = overlay;
  activeEnvironmentDockLoaded = false;
  overlay.setMenuBarVisibility(false);
  overlay.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event, url) => {
    if (url !== overlay.webContents.getURL()) event.preventDefault();
  });
  overlay.webContents.once("did-finish-load", () => {
    activeEnvironmentDockLoaded = true;
    publishActiveEnvironmentDockState();
  });
  overlay.on("closed", () => {
    stopActiveEnvironmentDockCollapseLayout();
    stopActiveEnvironmentDockPointerTracking();
    if (activeEnvironmentDockDrag) {
      mainWindow?.webContents.send("viron:active-environment-dock-action", {
        type: "drag-end",
        screenX: activeEnvironmentDockDrag.pointer.x,
        screenY: activeEnvironmentDockDrag.pointer.y,
      } satisfies ActiveEnvironmentDockAction);
    }
    activeEnvironmentDockDrag = null;
    activeEnvironmentDockWindow = null;
    activeEnvironmentDockLoaded = false;
  });
  await overlay.loadFile(join(root, "dist", "desktop-renderer", "desktop-active-environment-dock.html"));
  return overlay;
}

export async function updateActiveEnvironmentDockWindow(state: ActiveEnvironmentDockState | null): Promise<void> {
  const previousState = activeEnvironmentDockState;
  activeEnvironmentDockState = state;
  if (!state) {
    stopActiveEnvironmentDockCollapseLayout();
    stopActiveEnvironmentDockPointerTracking();
    publishActiveEnvironmentDockState();
    activeEnvironmentDockWindow?.hide();
    return;
  }
  const overlay = await ensureActiveEnvironmentDockWindow();
  if (activeEnvironmentDockState !== state) return;
  if (activeEnvironmentDockDrag) return;
  if (state.expanded) stopActiveEnvironmentDockCollapseLayout();
  else if (previousState?.expanded) scheduleActiveEnvironmentDockCollapseLayout();
  layoutActiveEnvironmentDockWindow();
  publishActiveEnvironmentDockState();
  if (!overlay.isVisible()) overlay.showInactive();
  if (state.expanded) scheduleActiveEnvironmentDockPointerTracking();
  else stopActiveEnvironmentDockPointerTracking();
}

export async function updateActiveEnvironmentDockLayoutWindow(layout: ActiveEnvironmentDockLayoutState): Promise<void> {
  if (!activeEnvironmentDockState) return;
  const previousState = activeEnvironmentDockState;
  const state: ActiveEnvironmentDockState = {
    ...activeEnvironmentDockState,
    ...layout,
    bounds: { ...layout.bounds },
    card: { ...layout.card },
  };
  activeEnvironmentDockState = state;
  const overlay = await ensureActiveEnvironmentDockWindow();
  if (activeEnvironmentDockState !== state) return;
  if (state.expanded) stopActiveEnvironmentDockCollapseLayout();
  else if (previousState.expanded) scheduleActiveEnvironmentDockCollapseLayout();
  layoutActiveEnvironmentDockWindow();
  publishActiveEnvironmentDockLayout();
  if (!overlay.isVisible()) overlay.showInactive();
  if (state.expanded) scheduleActiveEnvironmentDockPointerTracking();
  else stopActiveEnvironmentDockPointerTracking();
}
