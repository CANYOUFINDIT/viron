import { join } from "node:path";
import { app, WebContentsView } from "electron";
import { closeDomOverlayWindow, domOverlayWindow, domOverlayWindows } from "../overlays/dom-overlay-windows.js";
import { mainWindow } from "../window-host.js";

export async function runDesktopDomOverlaySmoke(): Promise<{
  nodeAdopted: boolean;
  childAboveWeb: boolean;
  pointerDelivered: boolean;
  webStayedLive: boolean;
  cleanup: boolean;
}> {
  if (!mainWindow) throw new Error("Main window unavailable");
  const host = mainWindow;
  const name = "viron-dom-overlay-smoke";
  const web = new WebContentsView();
  web.setBounds({ x: 80, y: 120, width: 420, height: 270 });
  host.contentView.addChildView(web);
  try {
    await web.webContents.loadURL("data:text/html,<html><body><script>window.ticks=0;setInterval(()=>window.ticks++,20)</script><button>Web page</button></body></html>");
    await host.webContents.executeJavaScript(`(async () => {
      window.__vironOverlaySmokeClicks = 0;
      const child = window.open("about:blank", ${JSON.stringify(name)}, "width=180,height=100");
      if (!child) throw new Error("Native overlay popup was blocked");
      const button = document.createElement("button");
      button.textContent = "Overlay button";
      button.style.cssText = "position:absolute;left:10px;top:10px;width:140px;height:60px;background:#7c55ed;color:white";
      button.addEventListener("click", () => { window.__vironOverlaySmokeClicks += 1; });
      child.document.body.appendChild(button);
      window.__vironOverlaySmokeChild = child;
      await window.vironDesktop.layoutDomOverlay(${JSON.stringify(name)}, { x: 120, y: 150, width: 180, height: 100 }, 2000);
    })()`);
    const overlay = domOverlayWindow(name);
    if (!overlay) throw new Error("Native overlay window was not registered");
    const nodeAdopted = await overlay.webContents.executeJavaScript('document.body.querySelector("button")?.textContent === "Overlay button"') as boolean;
    const childAboveWeb = overlay.getParentWindow() === host && overlay.isVisible() && web.getVisible();
    const before = await web.webContents.executeJavaScript("window.ticks") as number;
    overlay.focus();
    overlay.webContents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
    overlay.webContents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const pointerDelivered = await host.webContents.executeJavaScript("window.__vironOverlaySmokeClicks === 1") as boolean;
    const after = await web.webContents.executeJavaScript("window.ticks") as number;
    const webStayedLive = after > before;
    const closed = new Promise<void>((resolve) => overlay.once("closed", () => resolve()));
    closeDomOverlayWindow(name);
    await closed;
    return { nodeAdopted, childAboveWeb, pointerDelivered, webStayedLive, cleanup: domOverlayWindow(name) === null };
  } finally {
    closeDomOverlayWindow(name);
    host.contentView.removeChildView(web);
    if (!web.webContents.isDestroyed()) web.webContents.close();
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function runDesktopDomOverlayManagerSmoke(): Promise<{
  sidebarPortaled: boolean;
  popoverPortaled: boolean;
  elementPopoverPortaled: boolean;
  outsideDismissed: boolean;
  vueEventsPreserved: boolean;
  webStayedLive: boolean;
  restored: boolean;
}> {
  if (!mainWindow) throw new Error("Main window unavailable");
  const host = mainWindow;
  await host.loadFile(join(app.getAppPath(), "dist", "desktop-renderer", "desktop-dom-overlay-smoke.html"));
  const web = new WebContentsView();
  web.setBounds({ x: 100, y: 120, width: 420, height: 270 });
  host.contentView.addChildView(web);
  try {
    await web.webContents.loadURL("data:text/html,<html><body><script>window.ticks=0;setInterval(()=>window.ticks++,20)</script>Live page</body></html>");
    await waitUntil(() => domOverlayWindows().length === 3 && domOverlayWindows().every((window) => window.isVisible()), "native DOM overlays");
    const windows = domOverlayWindows();
    const sidebar = windows.find((window) => window.getBounds().x === host.getContentBounds().x);
    const popover = windows.find((window) => window !== sidebar && window.getBounds().x < host.getContentBounds().x + 300);
    const elementPopover = windows.find((window) => window !== sidebar && window !== popover);
    if (!sidebar || !popover || !elementPopover) throw new Error("Sidebar or popover window missing");
    const sidebarPortaled = await sidebar.webContents.executeJavaScript('Boolean(document.querySelector(".app-sidebar #sidebar-action"))') as boolean;
    const popoverPortaled = await popover.webContents.executeJavaScript('Boolean(document.querySelector(".el-popper #popover-action"))') as boolean;
    const elementPopoverPortaled = await elementPopover.webContents.executeJavaScript('Boolean(document.querySelector(".smoke-element-popper #element-popover-action"))') as boolean;
    const before = await web.webContents.executeJavaScript("window.ticks") as number;
    await sidebar.webContents.executeJavaScript('document.querySelector("#sidebar-action").click()');
    await popover.webContents.executeJavaScript('document.querySelector("#popover-action").click()');
    await elementPopover.webContents.executeJavaScript('document.querySelector("#element-popover-action").click()');
    const vueEventsPreserved = await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.clicks.join(",") === "sidebar,popover,element"') as boolean;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const webStayedLive = (await web.webContents.executeJavaScript("window.ticks") as number) > before;
    host.webContents.send("viron:native-view-pointer-down");
    await waitUntil(() => domOverlayWindows().length === 2, "Element Plus popover outside click");
    const outsideDismissed = await host.webContents.executeJavaScript('!document.querySelector(".smoke-element-popper") || getComputedStyle(document.querySelector(".smoke-element-popper")).display === "none"') as boolean;
    await host.webContents.executeJavaScript('document.querySelector(".app-frame").classList.remove("is-sidebar-expanded")');
    await popover.webContents.executeJavaScript('document.querySelector(".el-popper").style.display = "none"');
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.hideElementPopover()');
    await waitUntil(() => domOverlayWindows().length === 0, "overlay cleanup");
    const restored = await host.webContents.executeJavaScript('Boolean(document.querySelector(".app-sidebar #sidebar-action")) && Boolean(document.querySelector(".el-popper #popover-action"))') as boolean;
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.close()');
    return { sidebarPortaled, popoverPortaled, elementPopoverPortaled, outsideDismissed, vueEventsPreserved, webStayedLive, restored };
  } finally {
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke?.close()').catch(() => undefined);
    host.contentView.removeChildView(web);
    if (!web.webContents.isDestroyed()) web.webContents.close();
  }
}
