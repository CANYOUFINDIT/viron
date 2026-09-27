import { join } from "node:path";
import { app, BrowserWindow, screen, WebContentsView } from "electron";
import { closeDomOverlayWindow, domOverlayWindow, domOverlayWindows } from "../overlays/dom-overlay-windows.js";
import { mainWindow } from "../window-host.js";
import { sidebarOverlayViews } from "../overlays/sidebar-overlay-view.js";

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
  sidebarFullWidth: boolean;
  sidebarAnimationStable: boolean;
  sidebarPinRestored: boolean;
  sidebarPassiveInteraction: boolean;
  sidebarNativeAutoCollapse: boolean;
  popoverPortaled: boolean;
  elementPopoverPortaled: boolean;
  elementPopoverArrowAligned: boolean;
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
    await waitUntil(() => domOverlayWindows().length === 2 && sidebarOverlayViews().length === 1 && sidebarOverlayViews()[0].getVisible() && domOverlayWindows().every((window) => window.isVisible()), "native DOM overlays");
    const windows = domOverlayWindows();
    const sidebar = sidebarOverlayViews()[0];
    const popover = windows.find((window) => window.getBounds().x < host.getContentBounds().x + 300);
    const elementPopover = windows.find((window) => window !== popover);
    if (!sidebar || !popover || !elementPopover) throw new Error("Sidebar or popover window missing");
    const sidebarDocument = '(document.querySelector("iframe")?.contentDocument ?? document)';
    const sidebarPortaled = await sidebar.webContents.executeJavaScript(`Boolean(${sidebarDocument}.querySelector(".app-sidebar #sidebar-action"))`) as boolean;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const sidebarFullWidth = sidebar.getBounds().width === 224;
    const popoverPortaled = await popover.webContents.executeJavaScript('Boolean(document.querySelector(".el-popper #popover-action"))') as boolean;
    const elementPopoverPortaled = await elementPopover.webContents.executeJavaScript('Boolean(document.querySelector(".smoke-element-popper #element-popover-action"))') as boolean;
    const anchorCenter = await host.webContents.executeJavaScript('(() => { const rect = document.querySelector("#element-popover-anchor").getBoundingClientRect(); return rect.left + rect.width / 2; })()') as number;
    const arrowPosition = await elementPopover.webContents.executeJavaScript('(() => { const popper = document.querySelector(".smoke-element-popper"); const arrow = popper?.querySelector(":scope > .el-popper__arrow"); if (!arrow) return null; const rect = arrow.getBoundingClientRect(); return { center: rect.left + rect.width / 2, side: popper.dataset.vironNativeArrowSide, top: getComputedStyle(arrow).top }; })()') as { center: number; side: string; top: string } | null;
    const elementPopoverArrowAligned = Boolean(arrowPosition && arrowPosition.side === "bottom" && arrowPosition.top === "-5px"
      && Math.abs(elementPopover.getBounds().x - host.getContentBounds().x + arrowPosition.center - anchorCenter) <= 4);
    const before = await web.webContents.executeJavaScript("window.ticks") as number;
    await sidebar.webContents.executeJavaScript(`${sidebarDocument}.querySelector("#sidebar-action").click()`);
    await popover.webContents.executeJavaScript('document.querySelector("#popover-action").click()');
    await elementPopover.webContents.executeJavaScript('document.querySelector("#element-popover-action").click()');
    const vueEventsPreserved = await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.clicks.join(",") === "sidebar,popover,element"') as boolean;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const webStayedLive = (await web.webContents.executeJavaScript("window.ticks") as number) > before;
    host.webContents.send("viron:native-view-pointer-down");
    await waitUntil(() => domOverlayWindows().length === 1, "Element Plus popover outside click");
    const outsideDismissed = await host.webContents.executeJavaScript('!document.querySelector(".smoke-element-popper") || getComputedStyle(document.querySelector(".smoke-element-popper")).display === "none"') as boolean;
    const sidebarAnimationStable = await host.webContents.executeJavaScript(`(async () => {
      const api = window.vironDomOverlaySmoke;
      const sidebar = api.sidebar();
      const originalDocument = sidebar.ownerDocument;
      const sample = async (expanded, reverse = false) => {
        api.setSidebarExpanded(expanded);
        const frames = [];
        const start = performance.now();
        let reversed = false;
        while (performance.now() - start < 550) {
          await new Promise(requestAnimationFrame);
          frames.push({ width: sidebar.getBoundingClientRect().width, portaled: sidebar.ownerDocument !== document });
          if (reverse && !reversed && frames.at(-1).width < 190) {
            api.setSidebarExpanded(true);
            reversed = true;
          }
        }
        return frames;
      };
      const reverse = await sample(false, true);
      const sameDocument = sidebar.ownerDocument === originalDocument;
      const collapse = await sample(false);
      const expand = await sample(true);
      const recollapse = await sample(false);
      const intermediate = (frames) => frames.some(f => f.portaled && f.width > 70 && f.width < 220);
      const final = (frames, width, portaled) => Math.abs(frames.at(-1).width - width) < 1 && frames.at(-1).portaled === portaled;
      const monotonic = (frames, opening) => frames.every((f, i) => !i || (opening ? f.width >= frames[i - 1].width - 1 : f.width <= frames[i - 1].width + 1));
      return sameDocument && intermediate(reverse) && final(reverse, 224, true)
        && intermediate(collapse) && monotonic(collapse, false) && final(collapse, 68, false)
        && intermediate(expand) && monotonic(expand, true) && final(expand, 224, true)
        && intermediate(recollapse) && monotonic(recollapse, false) && final(recollapse, 68, false);
    })()` ) as boolean;
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.setSidebarExpanded(true)');
    await waitUntil(() => sidebarOverlayViews().length === 1, "sidebar reopened");
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.setSidebarPinned(true)');
    await waitUntil(() => sidebarOverlayViews().length === 0, "pinned sidebar restored");
    const sidebarPinRestored = await host.webContents.executeJavaScript('Boolean(document.querySelector(".app-sidebar #sidebar-action"))') as boolean;
    await popover.webContents.executeJavaScript('document.querySelector(".el-popper").style.display = "none"');
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.hideElementPopover()');
    await waitUntil(() => domOverlayWindows().length === 0, "overlay cleanup");
    const restored = await host.webContents.executeJavaScript('Boolean(document.querySelector(".app-sidebar #sidebar-action")) && Boolean(document.querySelector(".el-popper #popover-action"))') as boolean;
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.setSidebarPinned(false); window.vironDomOverlaySmoke.setSidebarExpanded(true)');
    await waitUntil(() => sidebarOverlayViews().length === 1 && sidebarOverlayViews()[0].getVisible(), "passive sidebar");
    const passiveSidebar = sidebarOverlayViews()[0];
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Move the sidebar view around the real OS cursor, without synthesizing
    // DOM enter/leave events. This also works while the web page has focus.
    const point = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(point).workArea;
    const hostSize = host.getBounds();
    host.setPosition(Math.max(area.x, Math.min(area.x + area.width - hostSize.width, point.x - 100)),
      Math.max(area.y, Math.min(area.y + area.height - hostSize.height, point.y - 100)), false);
    const origin = host.getContentBounds();
    passiveSidebar.setBounds({
      x: Math.max(0, Math.min(origin.width - 224, point.x - origin.x - 40)),
      y: Math.max(0, Math.min(origin.height - 300, point.y - origin.y - 40)),
      width: 224, height: 300,
    });
    host.show();
    app.focus({ steal: true });
    host.focus();
    web.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.enableNativeHover()');
    const webFocusedBefore = web.webContents.isFocused();
    const clicksBefore = await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.clicks.length') as number;
    const buttonPoint = await passiveSidebar.webContents.executeJavaScript(`(() => {
      const rect = ${sidebarDocument}.querySelector("#sidebar-action").getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`) as { x: number; y: number };
    // Exercise native input with the page still focused. DOM .click() would
    // bypass the activation boundary that caused the original regression.
    await passiveSidebar.webContents.executeJavaScript(`(() => {
      window.__sidebarPointerDelivered = false;
      ${sidebarDocument}.querySelector("#sidebar-action").addEventListener("pointermove", (event) => {
        window.__sidebarPointerDelivered = event.isTrusted;
      }, { once: true });
    })()`);
    passiveSidebar.webContents.sendInputEvent({ type: "mouseEnter", ...buttonPoint });
    passiveSidebar.webContents.sendInputEvent({ type: "mouseMove", ...buttonPoint });
    await waitUntil(() => passiveSidebar.webContents.executeJavaScript('window.__sidebarPointerDelivered'), "sidebar hover input without activation");
    const hoveredWithoutActivation = web.webContents.isFocused();
    passiveSidebar.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...buttonPoint });
    passiveSidebar.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...buttonPoint });
    await waitUntil(() => host.webContents.executeJavaScript(`window.vironDomOverlaySmoke.clicks.length === ${clicksBefore + 1}`), "first sidebar click without activation");
    const sidebarPassiveInteraction = BrowserWindow.fromWebContents(passiveSidebar.webContents) === host
      && webFocusedBefore && host.isFocused() && hoveredWithoutActivation;
    passiveSidebar.setBounds({ x: point.x - origin.x < origin.width / 2 ? origin.width - 224 : 0, y: 0, width: 224, height: 300 });
    await waitUntil(() => sidebarOverlayViews().length === 0, "sidebar collapse without activation or DOM leave");
    const sidebarNativeAutoCollapse = await host.webContents.executeJavaScript('!document.querySelector(".app-frame").classList.contains("is-sidebar-expanded") && document.querySelector(".app-sidebar").getBoundingClientRect().width === 68') as boolean;
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke.close()');
    return { sidebarPortaled, sidebarFullWidth, sidebarAnimationStable, sidebarPinRestored, sidebarPassiveInteraction, sidebarNativeAutoCollapse, popoverPortaled, elementPopoverPortaled, elementPopoverArrowAligned, outsideDismissed, vueEventsPreserved, webStayedLive, restored };
  } finally {
    await host.webContents.executeJavaScript('window.vironDomOverlaySmoke?.close()').catch(() => undefined);
    host.contentView.removeChildView(web);
    if (!web.webContents.isDestroyed()) web.webContents.close();
  }
}
