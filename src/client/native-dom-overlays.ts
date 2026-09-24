import { onDesktopNativeViewPointerDown } from "./desktop";

type Surface = { element: () => HTMLElement | null; visible: () => boolean };
type OverlayKind = "sidebar" | "modal" | "popper";
type OverlayRecord = {
  element: HTMLElement;
  placeholder: Comment;
  child: Window;
  name: string;
  kind: OverlayKind;
  rect: { x: number; y: number; width: number; height: number };
  order: number;
  anchor: Element | null;
  anchorOffset: { x: number; y: number } | null;
  observer: MutationObserver;
  resizeObserver: ResizeObserver;
  lastLayout: string;
  ready: boolean;
};

const surfaces = new Set<Surface>();
const overlays = new Map<HTMLElement, OverlayRecord>();
let bodyObserver: MutationObserver | null = null;
let stopNativePointerDown: (() => void) | null = null;
let frame = 0;
let nextId = 0;
let sidebarTransferUntil = 0;

function bridge() {
  return window.vironDesktop;
}

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return Boolean(style && style.display !== "none" && style.visibility !== "hidden");
}

function intersects(first: DOMRect, second: DOMRect): boolean {
  return first.left < second.right && first.right > second.left
    && first.top < second.bottom && first.bottom > second.top;
}

function activeSurfaceRects(): DOMRect[] {
  return [...surfaces].filter((surface) => surface.visible()).map((surface) => surface.element()?.getBoundingClientRect())
    .filter((rect): rect is DOMRect => Boolean(rect && rect.width > 1 && rect.height > 1));
}

function overlayKind(element: HTMLElement): OverlayKind {
  if (element.classList.contains("app-sidebar")) return "sidebar";
  if (element.classList.contains("el-overlay") || element.dataset.nativeOverlay === "modal") return "modal";
  return "popper";
}

function popperAnchor(element: HTMLElement): Element | null {
  if (!element.id) return null;
  const id = CSS.escape(element.id);
  return document.querySelector(`[aria-describedby~="${id}"], [aria-controls="${id}"]`);
}

function overlayCandidates(rects: DOMRect[]): HTMLElement[] {
  if (!rects.length) return [];
  const candidates = [...document.querySelectorAll<HTMLElement>(".el-overlay, .el-popper, .el-message, .el-notification, [data-native-overlay]")]
    .filter((element) => visible(element) && !element.parentElement?.closest(".el-overlay, .app-sidebar, [data-native-overlay]")
      && rects.some((rect) => intersects(element.getBoundingClientRect(), rect)));
  const frame = document.querySelector(".app-frame.is-sidebar-expanded:not(.is-sidebar-pinned)");
  const sidebar = frame?.querySelector<HTMLElement>(".app-sidebar");
  if (sidebar && visible(sidebar)) candidates.push(sidebar);
  return candidates;
}

function copyDocumentStyle(child: Window): Promise<void> {
  const target = child.document;
  const stylesheetLoads: Promise<void>[] = [];
  target.documentElement.className = document.documentElement.className;
  for (const { name, value } of [...document.documentElement.attributes]) {
    if (name.startsWith("data-")) target.documentElement.setAttribute(name, value);
  }
  target.body.className = document.body.className;
  for (const node of document.head.querySelectorAll("style, link[rel=stylesheet]")) {
    const clone = node.cloneNode(true) as HTMLElement;
    if (node instanceof HTMLLinkElement && clone instanceof HTMLLinkElement) {
      clone.href = node.href;
      stylesheetLoads.push(new Promise((resolve) => {
        clone.addEventListener("load", () => resolve(), { once: true });
        clone.addEventListener("error", () => resolve(), { once: true });
      }));
    }
    target.head.appendChild(clone);
  }
  const style = target.createElement("style");
  style.textContent = `
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent !important; }
    .viron-native-overlay-root { position: relative; width: 100%; height: 100%; background: transparent; }
    .viron-native-overlay-root.app-frame { padding: 0 !important; min-height: 0 !important; isolation: isolate; }
    .viron-native-overlay-popper { position: absolute !important; inset: 8px auto auto 8px !important; margin: 0 !important; transform: none !important; }
    .viron-native-overlay-root .app-sidebar { inset: 0 auto 0 0 !important; }
  `;
  target.head.appendChild(style);
  return Promise.race([
    Promise.all(stylesheetLoads),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1_500)),
  ]).then(() => undefined);
}

function boundsFor(element: HTMLElement, kind: OverlayKind) {
  const rect = element.getBoundingClientRect();
  const padding = kind === "popper" ? 8 : 0;
  return {
    x: Math.max(0, Math.floor(rect.left - padding)),
    y: Math.max(0, Math.floor(rect.top - padding)),
    width: Math.max(1, Math.ceil(rect.width + padding * 2)),
    height: Math.max(1, Math.ceil(rect.height + padding * 2)),
  };
}

function makeOverlay(element: HTMLElement): void {
  if (!element.parentNode || overlays.has(element) || !bridge()) return;
  const kind = overlayKind(element);
  const rect = boundsFor(element, kind);
  const anchor = kind === "popper" ? popperAnchor(element) : null;
  const anchorRect = anchor?.getBoundingClientRect();
  const anchorOffset = anchorRect ? { x: rect.x - anchorRect.left, y: rect.y - anchorRect.top } : null;
  const order = kind === "sidebar" ? 40 : Number.parseInt(getComputedStyle(element).zIndex, 10) || 2000;
  const name = `viron-dom-overlay-${++nextId}`;
  const child = window.open("about:blank", name, `width=${rect.width},height=${rect.height}`);
  if (!child) return;
  try {
    const stylesReady = copyDocumentStyle(child);
    const root = child.document.createElement("div");
    root.className = kind === "sidebar"
      ? `${document.querySelector(".app-frame")?.className ?? "app-frame"} viron-native-overlay-root`
      : "viron-native-overlay-root";
    child.document.body.appendChild(root);
    const placeholder = document.createComment(`native overlay ${name}`);
    element.parentNode.insertBefore(placeholder, element);
    if (kind === "popper") element.classList.add("viron-native-overlay-popper");
    if (kind === "sidebar") sidebarTransferUntil = performance.now() + 120;
    root.appendChild(element);
    if (kind === "sidebar") {
      child.document.addEventListener("pointerleave", () => {
        window.dispatchEvent(new Event("viron:native-sidebar-pointerleave"));
      });
    }
    child.document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    });
    child.addEventListener("beforeunload", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(child.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-hidden"] });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(element);
    if (anchor instanceof HTMLElement) resizeObserver.observe(anchor);
    const record: OverlayRecord = { element, placeholder, child, name, kind, rect, order, anchor, anchorOffset, observer, resizeObserver, lastLayout: "", ready: false };
    overlays.set(element, record);
    void stylesReady.then(() => {
      if (overlays.get(element) !== record) return;
      record.ready = true;
      schedule();
    });
    schedule();
  } catch {
    child.close();
  }
}

function restoreOverlay(record: OverlayRecord): void {
  record.observer.disconnect();
  record.resizeObserver.disconnect();
  overlays.delete(record.element);
  record.element.classList.remove("viron-native-overlay-popper");
  if (record.kind === "sidebar") sidebarTransferUntil = performance.now() + 120;
  if (record.element.isConnected && record.placeholder.parentNode) {
    record.placeholder.parentNode.insertBefore(record.element, record.placeholder);
  }
  record.placeholder.remove();
  if (!record.child.closed) record.child.close();
  void bridge()?.closeDomOverlay(record.name).catch(() => undefined);
}

function positionOverlay(record: OverlayRecord): void {
  if (!record.ready) return;
  if (record.kind === "sidebar") {
    const frame = document.querySelector(".app-frame");
    const root = record.child.document.querySelector<HTMLElement>(".viron-native-overlay-root");
    if (root && frame) {
      const classes = `${frame.className} viron-native-overlay-root`;
      if (root.className !== classes) root.className = classes;
    }
    record.rect.height = window.innerHeight;
  } else if (record.kind === "modal") {
    record.rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  } else {
    const rect = record.element.getBoundingClientRect();
    record.rect.width = Math.max(1, Math.ceil(rect.width + 16));
    record.rect.height = Math.max(1, Math.ceil(rect.height + 16));
    if (record.anchor?.isConnected && record.anchorOffset) {
      const anchor = record.anchor.getBoundingClientRect();
      record.rect.x = Math.max(0, Math.min(window.innerWidth - record.rect.width, Math.round(anchor.left + record.anchorOffset.x)));
      record.rect.y = Math.max(0, Math.min(window.innerHeight - record.rect.height, Math.round(anchor.top + record.anchorOffset.y)));
    }
  }
  const layout = JSON.stringify([record.rect, record.order]);
  if (record.lastLayout === layout) return;
  record.lastLayout = layout;
  void bridge()?.layoutDomOverlay(record.name, record.rect, record.order, record.kind === "modal").catch(() => {
    record.lastLayout = "";
  });
}

function sync(): void {
  frame = 0;
  const rects = activeSurfaceRects();
  const candidates = new Set(overlayCandidates(rects));
  for (const record of [...overlays.values()]) {
    const sidebarNeeded = record.kind === "sidebar"
      && Boolean(document.querySelector(".app-frame.is-sidebar-expanded:not(.is-sidebar-pinned)")) && rects.length > 0;
    if (record.child.closed || !visible(record.element)
      || (record.kind === "sidebar" ? !sidebarNeeded : !rects.length)) {
      restoreOverlay(record);
      continue;
    }
    if (record.kind !== "sidebar" && !rects.some((rect) => intersects(
      new DOMRect(record.rect.x, record.rect.y, record.rect.width, record.rect.height), rect,
    ))) {
      restoreOverlay(record);
      continue;
    }
    positionOverlay(record);
  }
  for (const element of candidates) if (!overlays.has(element)) makeOverlay(element);
}

function schedule(): void {
  if (!frame) frame = window.requestAnimationFrame(sync);
}

function onNativePointerDown(): void {
  if (![...overlays.values()].some((record) => record.kind === "popper")) return;
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function start(): void {
  if (bodyObserver) return;
  bodyObserver = new MutationObserver(schedule);
  bodyObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-hidden"] });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  stopNativePointerDown = onDesktopNativeViewPointerDown(onNativePointerDown);
  schedule();
}

function stop(): void {
  bodyObserver?.disconnect();
  bodyObserver = null;
  stopNativePointerDown?.();
  stopNativePointerDown = null;
  window.removeEventListener("resize", schedule);
  window.removeEventListener("scroll", schedule, true);
  if (frame) window.cancelAnimationFrame(frame);
  frame = 0;
  for (const record of [...overlays.values()]) restoreOverlay(record);
}

export function registerNativeWebSurface(element: () => HTMLElement | null, visible: () => boolean): () => void {
  const surface = { element, visible };
  surfaces.add(surface);
  start();
  schedule();
  return () => {
    surfaces.delete(surface);
    if (!surfaces.size) stop();
    else schedule();
  };
}

export function nativeSidebarPortalActive(): boolean {
  return [...overlays.values()].some((record) => record.kind === "sidebar");
}

export function nativeSidebarTransferInProgress(): boolean {
  return performance.now() < sidebarTransferUntil;
}

export function scheduleNativeDomOverlays(): void {
  schedule();
}
