import { screen, WebContentsView, type Rectangle, type WebContentsViewConstructorOptions } from "electron";
import { mainWindow } from "../window-host.js";

type DomOverlay = {
  view: WebContentsView;
  order: number;
  bounds: Rectangle | null;
  timer?: NodeJS.Timeout;
  inside?: boolean;
};

const overlayName = /^viron-dom-overlay-[a-z0-9-]{1,64}$/;
const overlays = new Map<string, DomOverlay>();

export function isSidebarDomOverlay(name: string): boolean {
  return /^viron-dom-overlay-sidebar-[a-z0-9-]+$/.test(name);
}

function stopTracking(entry: DomOverlay): void {
  clearInterval(entry.timer);
  entry.timer = undefined;
  entry.inside = undefined;
}

function trackPointer(name: string, entry: DomOverlay): void {
  if (!isSidebarDomOverlay(name) || entry.timer) return;
  entry.timer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || entry.view.webContents.isDestroyed() || !entry.view.getVisible()) return stopTracking(entry);
    const origin = mainWindow.getContentBounds();
    const rect = entry.view.getBounds();
    const point = screen.getCursorScreenPoint();
    const x = point.x - origin.x;
    const y = point.y - origin.y;
    const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    if (inside === entry.inside) return;
    entry.inside = inside;
    mainWindow.webContents.send("viron:dom-overlay:pointer", name, inside);
  }, 40);
  entry.timer.unref();
}

function checkedBounds(input: Rectangle): Rectangle {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window unavailable");
  if (!input || ![input.x, input.y, input.width, input.height].every(Number.isFinite)) throw new Error("Invalid overlay bounds");
  const [width, height] = mainWindow.getContentSize();
  const x = Math.max(0, Math.min(width - 1, Math.floor(input.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(input.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.ceil(input.width))),
    height: Math.max(1, Math.min(height - y, Math.ceil(input.height))),
  };
}

export function createDomOverlayView(name: string, options: WebContentsViewConstructorOptions): Electron.WebContents {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayName.test(name)) throw new Error("DOM overlay host unavailable");
  closeDomOverlayView(name);
  // Keep transient chrome in the same native window as the page. Separate
  // BrowserWindow popups steal macOS activation and make the Viron window
  // appear unfocused whenever a menu or extension list is clicked.
  const view = new WebContentsView(options);
  view.setBackgroundColor("#00000000");
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  const entry: DomOverlay = { view, order: 0, bounds: null };
  overlays.set(name, entry);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  view.webContents.once("destroyed", () => {
    stopTracking(entry);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
    if (overlays.get(name) === entry) overlays.delete(name);
  });
  return view.webContents;
}

export function createSidebarOverlay(name: string, options: WebContentsViewConstructorOptions): Electron.WebContents {
  if (!isSidebarDomOverlay(name)) throw new Error("Invalid sidebar overlay name");
  return createDomOverlayView(name, options);
}

export function layoutDomOverlayView(name: string, bounds: Rectangle, order: number, focus = false): void {
  const entry = overlays.get(name);
  if (!entry || entry.view.webContents.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  entry.order = Number.isFinite(order) ? Math.max(-1_000_000, Math.min(1_000_000, order)) : 0;
  entry.bounds = bounds;
  entry.view.setBounds(checkedBounds(bounds));
  entry.view.setVisible(true);
  raiseDomOverlayViews();
  trackPointer(name, entry);
  if (focus) entry.view.webContents.focus();
}

export function layoutSidebarOverlay(name: string, bounds: Rectangle): void {
  layoutDomOverlayView(name, bounds, overlays.get(name)?.order ?? 0);
}

export function hideDomOverlayView(name: string): void {
  const entry = overlays.get(name);
  if (!entry) return;
  stopTracking(entry);
  if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(false);
}

export function hideSidebarOverlay(name: string): void {
  hideDomOverlayView(name);
}

export function closeDomOverlayView(name: string): void {
  const entry = overlays.get(name);
  if (!entry) return;
  stopTracking(entry);
  overlays.delete(name);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(entry.view);
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
}

export function closeSidebarOverlay(name: string): void {
  closeDomOverlayView(name);
}

export function domOverlayView(name: string): WebContentsView | null {
  const view = overlays.get(name)?.view;
  return view && !view.webContents.isDestroyed() ? view : null;
}

export function domOverlayViews(): WebContentsView[] {
  return [...overlays.values()].map((entry) => entry.view).filter((view) => !view.webContents.isDestroyed());
}

export function sidebarOverlayViews(): WebContentsView[] {
  return [...overlays.entries()]
    .filter(([name]) => isSidebarDomOverlay(name))
    .map(([, entry]) => entry.view)
    .filter((view) => !view.webContents.isDestroyed());
}

export function layoutDomOverlayViews(): void {
  for (const entry of overlays.values()) {
    if (entry.view.webContents.isDestroyed() || !entry.bounds) continue;
    entry.view.setBounds(checkedBounds(entry.bounds));
  }
}

export function raiseDomOverlayViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const visible = [...overlays.values()]
    .filter((entry) => !entry.view.webContents.isDestroyed() && entry.view.getVisible())
    .sort((left, right) => left.order - right.order);
  for (const entry of visible) mainWindow.contentView.addChildView(entry.view);
}

export function raiseSidebarOverlays(): void {
  // This compatibility entry point is called after web-page layout. Raise all
  // DOM overlay views so ordinary popovers are not buried under a new web tab.
  raiseDomOverlayViews();
}

export function closeAllDomOverlayViews(): void {
  for (const name of [...overlays.keys()]) closeDomOverlayView(name);
}

export function closeAllSidebarOverlays(): void {
  for (const name of [...overlays.keys()]) if (isSidebarDomOverlay(name)) closeDomOverlayView(name);
}
