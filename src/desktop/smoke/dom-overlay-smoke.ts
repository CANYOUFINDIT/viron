import { session } from "electron";
import { createBrowserGuest } from "../browser-guest-host.js";
import { desktopWebPreferences } from "../web-view-support.js";
import { join } from "node:path";
import { app, BrowserWindow, screen, WebContentsView } from "electron";
import { closeDomOverlayWindow } from "../overlays/dom-overlay-windows.js";
import { mainWindow } from "../window-host.js";
import { domOverlayView, domOverlayViews, sidebarOverlayViews } from "../overlays/sidebar-overlay-view.js";

export async function runDesktopDomOverlaySmoke(): Promise<{
  nodeAdopted: boolean;
  childAboveWeb: boolean;
  mainWindowStayedFocused: boolean;
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
    const overlay = domOverlayView(name);
    if (!overlay) throw new Error("Native overlay view was not registered");
    const nodeAdopted = await overlay.webContents.executeJavaScript('document.body.querySelector("button")?.textContent === "Overlay button"') as boolean;
    const childAboveWeb = BrowserWindow.fromWebContents(overlay.webContents) === host && overlay.getVisible() && web.getVisible();
    const before = await web.webContents.executeJavaScript("window.ticks") as number;
    host.show();
    app.focus({ steal: true });
    host.focus();
    overlay.webContents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
    overlay.webContents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mainWindowStayedFocused = host.isFocused();
    const pointerDelivered = await host.webContents.executeJavaScript("window.__vironOverlaySmokeClicks === 1") as boolean;
    const after = await web.webContents.executeJavaScript("window.ticks") as number;
    const webStayedLive = after > before;
    const closed = new Promise<void>((resolve) => overlay.webContents.once("destroyed", () => resolve()));
    closeDomOverlayWindow(name);
    await closed;
    return { nodeAdopted, childAboveWeb, mainWindowStayedFocused, pointerDelivered, webStayedLive, cleanup: domOverlayView(name) === null };
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

export async function runDesktopDomOverlayManagerSmoke(): Promise<Record<string, boolean>> {
  if (!mainWindow) throw new Error("Main window unavailable");
  const host = mainWindow;
  await host.loadFile(join(app.getAppPath(), "dist", "desktop-renderer", "desktop-dom-overlay-smoke.html"));
  await waitUntil(() => host.webContents.executeJavaScript("Boolean(window.vironDomOverlaySmoke)"), "browser host renderer");
  const partitionName = "persist:browser-composition-smoke";
  const partition = session.fromPartition(partitionName);
  const guest = await createBrowserGuest(host.webContents, partition, partitionName, "smoke-view", "smoke-page",
    { x: 100, y: 120, width: 420, height: 270 }, desktopWebPreferences(partition));
  try {
    await guest.webContents.loadURL("data:text/html,<html><body style='margin:0;height:100vh;background:%23255'><script>window.ticks=0;window.clicks=0;setInterval(()=>window.ticks++,20);document.addEventListener('click',()=>window.clicks++)</script>Live page</body></html>");
    guest.setVisible(true);
    guest.webContents.setBackgroundThrottling(false);
    host.show(); app.focus({ steal: true }); host.focus();
    await waitUntil(() => host.webContents.executeJavaScript('getComputedStyle(document.querySelector("webview")).visibility === "visible"'), "visible browser guest");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const sameDocument = await host.webContents.executeJavaScript('document.querySelector(".app-sidebar").ownerDocument === document && document.querySelector(".smoke-element-popper").ownerDocument === document');
    const noNativeOverlayViews = domOverlayViews().length === 0;
    host.webContents.debugger.attach("1.3");
    const click = async (x: number, y: number) => {
      await host.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x, y });
      await host.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x, y });
    };
    const point = (selector: string) => host.webContents.executeJavaScript(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`) as Promise<{ x: number; y: number }>;
    const button = await point("#element-popover-action");
    await click(button.x, button.y);
    await waitUntil(() => host.webContents.executeJavaScript('window.vironDomOverlaySmoke.clicks.includes("element")'), "host popover native pointer");
    const popoverPointer = true;
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.setModal(true)');
    const modal = await point("#modal-action");
    const beforeClicks = await guest.webContents.executeJavaScript("window.clicks");
    await click(modal.x, modal.y);
    await waitUntil(() => host.webContents.executeJavaScript('window.vironDomOverlaySmoke.clicks.includes("modal")'), "modal native pointer");
    const modalBlocksPage = await guest.webContents.executeJavaScript(`window.clicks === ${beforeClicks}`);
    const before = await guest.webContents.executeJavaScript("window.ticks");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const webStayedLive = await guest.webContents.executeJavaScript(`window.ticks > ${before}`);
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.setModal(false);window.vironDomOverlaySmoke.setSidebarExpanded(false);window.vironDomOverlaySmoke.hideElementPopover()');
    await waitUntil(() => host.webContents.executeJavaScript('!document.querySelector(".el-overlay") && document.querySelector(".app-sidebar").getBoundingClientRect().width < 70'), "modal and sidebar close");
    await host.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await click(490, 340);
    await waitUntil(() => guest.webContents.executeJavaScript(`window.clicks > ${beforeClicks}`), "guest native pointer after modal");
    const pagePointer = true;
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.setVisible(false)');
    const hidden = await host.webContents.executeJavaScript('getComputedStyle(document.querySelector("webview")).pointerEvents === "none"');
    const guestId = guest.webContents.id;
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.setVisible(true)');
    const stableGuest = guest.webContents.id === guestId && !guest.webContents.isDestroyed();
    guest.focus();
    await host.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const input = await point("#host-input");
    await click(input.x, input.y);
    guest.setBounds({ x: 100, y: 120, width: 420, height: 270 });
    await host.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await host.webContents.debugger.sendCommand("Input.insertText", { text: "typed in host" });
    const hostInputKeepsFocus = await host.webContents.executeJavaScript('document.activeElement.id === "host-input" && document.querySelector("#host-input").value === "typed in host"');
    await host.webContents.executeJavaScript('document.querySelector("#surface").style.width="480px";document.querySelector("#surface").style.left="130px"');
    await waitUntil(() => host.webContents.executeJavaScript('document.querySelector("webview").getBoundingClientRect().width === 480 && document.querySelector("webview").getBoundingClientRect().left === 130'), "resized browser surface");
    const resizedWithoutReload = guest.webContents.id === guestId && await guest.webContents.executeJavaScript("window.clicks > 0 && window.ticks > 0");
    const pageIsolated = await guest.webContents.executeJavaScript('typeof window.vironDesktop === "undefined" && typeof require === "undefined" && !navigator.userAgent.includes("VironBrowserGuest/")');
    return { sameDocument, noNativeOverlayViews, popoverPointer, modalBlocksPage, pagePointer, webStayedLive, hidden, stableGuest, hostInputKeepsFocus, resizedWithoutReload, pageIsolated, mainWindowFocused: host.isFocused() };
  } finally {
    if (host.webContents.debugger.isAttached()) host.webContents.debugger.detach();
    guest.dispose();
    await host.loadFile(join(app.getAppPath(), "dist", "desktop-renderer", "index.html"));
  }
}
