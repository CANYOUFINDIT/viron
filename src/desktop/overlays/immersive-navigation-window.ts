import { join } from "node:path";
import { app, BrowserWindow, type Rectangle } from "electron";
import {
  immersiveNavigationBounds,
  immersiveNavigationSize,
  previewImmersiveNavigationAction,
  snapImmersiveDock,
  type ImmersiveNavigationAction,
  type ImmersiveNavigationState,
} from "../../shared/immersive-navigation.js";
import { translate as tr } from "../i18n.js";
import { mainWindow } from "../window-host.js";

export let immersiveNavigationWindow: BrowserWindow | null = null;
export let immersiveNavigationState: ImmersiveNavigationState | null = null;
let immersiveNavigationLoaded = false;
let immersiveNavigationDrag: { cursor: { x: number; y: number }; bounds: Rectangle } | null = null;

export function sendImmersiveNavigationAction(action: ImmersiveNavigationAction): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("viron:immersive-navigation-action", action);
}

export function applyImmersiveNavigationActionPreview(action: ImmersiveNavigationAction): void {
  if (!immersiveNavigationState || !immersiveNavigationWindow || immersiveNavigationWindow.isDestroyed()) return;
  const previousState = immersiveNavigationState;
  const nextState = previewImmersiveNavigationAction(previousState, action);
  if (nextState === previousState) return;
  immersiveNavigationState = nextState;
  layoutImmersiveNavigationWindow();
  publishImmersiveNavigationState();
  if (nextState.expanded && !previousState.expanded) {
    immersiveNavigationWindow.show();
    immersiveNavigationWindow.focus();
  }
}

export function immersiveNavigationViewport(): Rectangle {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.getBounds();
}

export function layoutImmersiveNavigationWindow(): void {
  if (!immersiveNavigationWindow || immersiveNavigationWindow.isDestroyed() || !immersiveNavigationState?.visible) return;
  const viewport = immersiveNavigationViewport();
  const size = immersiveNavigationSize(immersiveNavigationState.dock, immersiveNavigationState.expanded, viewport);
  const bounds = immersiveNavigationBounds(immersiveNavigationState.dock, size, viewport);
  immersiveNavigationWindow.setBounds(bounds, false);
}

export function publishImmersiveNavigationState(): void {
  if (!immersiveNavigationLoaded || !immersiveNavigationWindow || immersiveNavigationWindow.isDestroyed() || !immersiveNavigationState) return;
  immersiveNavigationWindow.webContents.send("viron:immersive-navigation-state", immersiveNavigationState);
}

export async function ensureImmersiveNavigationWindow(): Promise<BrowserWindow> {
  if (immersiveNavigationWindow && !immersiveNavigationWindow.isDestroyed()) return immersiveNavigationWindow;
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const root = app.getAppPath();
  const overlay = new BrowserWindow({
    parent: mainWindow,
    width: 34,
    height: 48,
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
    roundedCorners: false,
    webPreferences: {
      preload: join(root, "dist", "desktop", "immersive-navigation-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  immersiveNavigationWindow = overlay;
  immersiveNavigationLoaded = false;
  overlay.setMenuBarVisibility(false);
  overlay.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event, url) => {
    if (url !== overlay.webContents.getURL()) event.preventDefault();
  });
  overlay.webContents.once("did-finish-load", () => {
    immersiveNavigationLoaded = true;
    publishImmersiveNavigationState();
  });
  overlay.on("blur", () => {
    if (immersiveNavigationState?.expanded && !immersiveNavigationDrag) sendImmersiveNavigationAction({ type: "collapse" });
  });
  overlay.on("closed", () => {
    immersiveNavigationWindow = null;
    immersiveNavigationLoaded = false;
    immersiveNavigationDrag = null;
  });
  await overlay.loadFile(join(root, "dist", "desktop-renderer", "desktop-immersive-navigation.html"));
  return overlay;
}

export async function updateImmersiveNavigationWindow(state: ImmersiveNavigationState | null): Promise<void> {
  const wasExpanded = immersiveNavigationState?.expanded ?? false;
  immersiveNavigationState = state;
  if (!state?.visible) {
    if (immersiveNavigationLoaded && immersiveNavigationWindow && !immersiveNavigationWindow.isDestroyed()) {
      immersiveNavigationWindow.webContents.send("viron:immersive-navigation-state", null);
    }
    immersiveNavigationWindow?.hide();
    return;
  }
  const overlay = await ensureImmersiveNavigationWindow();
  if (immersiveNavigationState !== state) return;
  layoutImmersiveNavigationWindow();
  publishImmersiveNavigationState();
  if (state.expanded && !wasExpanded) {
    overlay.show();
    overlay.focus();
  } else if (!overlay.isVisible()) overlay.showInactive();
}

export function handleImmersiveNavigationDrag(
  action: Extract<ImmersiveNavigationAction, { type: "drag-start" | "drag-move" | "drag-end" }>,
): void {
  if (!immersiveNavigationWindow || !immersiveNavigationState || immersiveNavigationState.expanded || !mainWindow) return;
  if (action.type === "drag-start") {
    immersiveNavigationDrag = {
      cursor: { x: action.screenX, y: action.screenY },
      bounds: immersiveNavigationWindow.getBounds(),
    };
    return;
  }
  if (!immersiveNavigationDrag) return;
  if (action.type === "drag-move") {
    immersiveNavigationWindow.setPosition(
      Math.round(immersiveNavigationDrag.bounds.x + action.screenX - immersiveNavigationDrag.cursor.x),
      Math.round(immersiveNavigationDrag.bounds.y + action.screenY - immersiveNavigationDrag.cursor.y),
      false,
    );
    return;
  }
  const dock = snapImmersiveDock({ x: action.screenX, y: action.screenY }, immersiveNavigationViewport());
  immersiveNavigationDrag = null;
  immersiveNavigationState = { ...immersiveNavigationState, dock };
  layoutImmersiveNavigationWindow();
  publishImmersiveNavigationState();
  sendImmersiveNavigationAction({ type: "dock", dock });
}
