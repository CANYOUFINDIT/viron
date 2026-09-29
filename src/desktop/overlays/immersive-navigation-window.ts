import { join } from "node:path";
import { app, WebContentsView, type Rectangle } from "electron";
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

// Kept under the existing export name so callers do not need to care whether
// the overlay is a window or a view. It deliberately lives in the main
// window's contentView: clicks then share the same activation boundary as the
// embedded web page instead of first activating a separate BrowserWindow.
export let immersiveNavigationWindow: WebContentsView | null = null;
export let immersiveNavigationState: ImmersiveNavigationState | null = null;
let immersiveNavigationLoaded = false;
let immersiveNavigationDrag: { cursor: { x: number; y: number }; bounds: Rectangle } | null = null;

function liveImmersiveNavigationView(): WebContentsView | null {
  return immersiveNavigationWindow && !immersiveNavigationWindow.webContents.isDestroyed()
    ? immersiveNavigationWindow
    : null;
}

export function sendImmersiveNavigationAction(action: ImmersiveNavigationAction): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("viron:immersive-navigation-action", action);
}

export function raiseImmersiveNavigationWindow(): void {
  const overlay = liveImmersiveNavigationView();
  if (!mainWindow || mainWindow.isDestroyed() || !overlay?.getVisible()) return;
  mainWindow.contentView.addChildView(overlay);
}

export function applyImmersiveNavigationActionPreview(action: ImmersiveNavigationAction): void {
  const overlay = liveImmersiveNavigationView();
  if (!immersiveNavigationState || !overlay) return;
  const previousState = immersiveNavigationState;
  const nextState = previewImmersiveNavigationAction(previousState, action);
  if (nextState === previousState) return;
  immersiveNavigationState = nextState;
  layoutImmersiveNavigationWindow();
  publishImmersiveNavigationState();
  if (nextState.expanded && !previousState.expanded) {
    overlay.setVisible(true);
    raiseImmersiveNavigationWindow();
  }
}

export function immersiveNavigationViewport(): Rectangle {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error(tr("主窗口不可用"));
  const [width, height] = mainWindow.getContentSize();
  return { x: 0, y: 0, width, height };
}

export function layoutImmersiveNavigationWindow(): void {
  const overlay = liveImmersiveNavigationView();
  if (!overlay || !immersiveNavigationState?.visible) return;
  const viewport = immersiveNavigationViewport();
  const size = immersiveNavigationSize(immersiveNavigationState.dock, immersiveNavigationState.expanded, viewport);
  overlay.setBounds(immersiveNavigationBounds(immersiveNavigationState.dock, size, viewport));
  raiseImmersiveNavigationWindow();
}

export function publishImmersiveNavigationState(): void {
  const overlay = liveImmersiveNavigationView();
  if (!immersiveNavigationLoaded || !overlay || !immersiveNavigationState) return;
  overlay.webContents.send("viron:immersive-navigation-state", immersiveNavigationState);
}

export async function ensureImmersiveNavigationWindow(): Promise<WebContentsView> {
  const existing = liveImmersiveNavigationView();
  if (existing) return existing;
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error(tr("主窗口不可用"));
  const root = app.getAppPath();
  const overlay = new WebContentsView({
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
  overlay.setBackgroundColor("#00000000");
  overlay.setBounds({ x: 0, y: 0, width: 34, height: 48 });
  overlay.setVisible(false);
  mainWindow.contentView.addChildView(overlay);
  overlay.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event, url) => {
    if (url !== overlay.webContents.getURL()) event.preventDefault();
  });
  overlay.webContents.once("did-finish-load", () => {
    immersiveNavigationLoaded = true;
    publishImmersiveNavigationState();
  });
  overlay.webContents.once("destroyed", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(overlay);
    if (immersiveNavigationWindow === overlay) immersiveNavigationWindow = null;
    immersiveNavigationLoaded = false;
    immersiveNavigationDrag = null;
  });
  await overlay.webContents.loadFile(join(root, "dist", "desktop-renderer", "desktop-immersive-navigation.html"));
  return overlay;
}

export async function updateImmersiveNavigationWindow(state: ImmersiveNavigationState | null): Promise<void> {
  const wasExpanded = immersiveNavigationState?.expanded ?? false;
  immersiveNavigationState = state;
  if (!state?.visible) {
    const overlay = liveImmersiveNavigationView();
    if (immersiveNavigationLoaded && overlay) overlay.webContents.send("viron:immersive-navigation-state", null);
    overlay?.setVisible(false);
    return;
  }
  const overlay = await ensureImmersiveNavigationWindow();
  if (immersiveNavigationState !== state) return;
  layoutImmersiveNavigationWindow();
  publishImmersiveNavigationState();
  if (state.expanded && !wasExpanded) overlay.setVisible(true);
  else if (!overlay.getVisible()) overlay.setVisible(true);
  raiseImmersiveNavigationWindow();
}

export function closeImmersiveNavigationWindow(): void {
  const overlay = immersiveNavigationWindow;
  immersiveNavigationWindow = null;
  immersiveNavigationLoaded = false;
  immersiveNavigationDrag = null;
  if (!overlay) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(overlay);
  if (!overlay.webContents.isDestroyed()) overlay.webContents.close();
}

export function handleImmersiveNavigationDrag(
  action: Extract<ImmersiveNavigationAction, { type: "drag-start" | "drag-move" | "drag-end" }>,
): void {
  const overlay = liveImmersiveNavigationView();
  if (!overlay || !immersiveNavigationState || immersiveNavigationState.expanded || !mainWindow) return;
  if (action.type === "drag-start") {
    immersiveNavigationDrag = {
      cursor: { x: action.screenX, y: action.screenY },
      bounds: overlay.getBounds(),
    };
    return;
  }
  if (!immersiveNavigationDrag) return;
  if (action.type === "drag-move") {
    const bounds = immersiveNavigationDrag.bounds;
    overlay.setBounds({
      ...bounds,
      x: Math.round(bounds.x + action.screenX - immersiveNavigationDrag.cursor.x),
      y: Math.round(bounds.y + action.screenY - immersiveNavigationDrag.cursor.y),
    });
    return;
  }
  const dock = snapImmersiveDock(
    { x: action.screenX, y: action.screenY },
    mainWindow.getContentBounds(),
  );
  immersiveNavigationDrag = null;
  immersiveNavigationState = { ...immersiveNavigationState, dock };
  layoutImmersiveNavigationWindow();
  publishImmersiveNavigationState();
  sendImmersiveNavigationAction({ type: "dock", dock });
}
