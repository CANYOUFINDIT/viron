import { screen, WebContentsView, type Rectangle, type WebContentsViewConstructorOptions } from "electron";
import { mainWindow } from "../window-host.js";

type SidebarOverlay = { view: WebContentsView; timer?: NodeJS.Timeout; inside?: boolean };
const sidebars = new Map<string, SidebarOverlay>();

export function isSidebarDomOverlay(name: string): boolean {
  return /^viron-dom-overlay-sidebar-[a-z0-9-]+$/.test(name);
}

function stopTracking(entry: SidebarOverlay): void {
  clearInterval(entry.timer);
  entry.timer = undefined;
  entry.inside = undefined;
}

function trackPointer(name: string, entry: SidebarOverlay): void {
  if (entry.timer) return;
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

export function createSidebarOverlay(name: string, options: WebContentsViewConstructorOptions): Electron.WebContents {
  if (!mainWindow || mainWindow.isDestroyed() || !isSidebarDomOverlay(name)) throw new Error("Sidebar host unavailable");
  closeSidebarOverlay(name);
  // Keep the sidebar in the same native window as the page. A BrowserWindow
  // popup requires OS activation and does not behave like the app's navigation.
  const view = new WebContentsView(options);
  view.setBackgroundColor("#00000000");
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  const entry: SidebarOverlay = { view };
  sidebars.set(name, entry);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  view.webContents.once("destroyed", () => {
    stopTracking(entry);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
    if (sidebars.get(name) === entry) sidebars.delete(name);
  });
  return view.webContents;
}

export function layoutSidebarOverlay(name: string, bounds: Rectangle): void {
  const entry = sidebars.get(name);
  if (!entry || entry.view.webContents.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error("Invalid sidebar bounds");
  const [width, height] = mainWindow.getContentSize();
  const x = Math.max(0, Math.min(width - 1, Math.floor(bounds.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(bounds.y)));
  entry.view.setBounds({ x, y, width: Math.max(1, Math.min(width - x, Math.ceil(bounds.width))), height: Math.max(1, Math.min(height - y, Math.ceil(bounds.height))) });
  entry.view.setVisible(true);
  raiseSidebarOverlays();
  trackPointer(name, entry);
}

export function hideSidebarOverlay(name: string): void {
  const entry = sidebars.get(name);
  if (!entry) return;
  stopTracking(entry);
  if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(false);
}

export function closeSidebarOverlay(name: string): void {
  const entry = sidebars.get(name);
  if (!entry) return;
  stopTracking(entry);
  sidebars.delete(name);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(entry.view);
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
}

export function sidebarOverlayViews(): WebContentsView[] {
  return [...sidebars.values()].map((entry) => entry.view).filter((view) => !view.webContents.isDestroyed());
}

export function raiseSidebarOverlays(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const view of sidebarOverlayViews()) if (view.getVisible()) mainWindow.contentView.addChildView(view);
}

export function closeAllSidebarOverlays(): void {
  for (const name of [...sidebars.keys()]) closeSidebarOverlay(name);
}
