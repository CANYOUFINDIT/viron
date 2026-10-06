import { browserGuestBindingAgent, browserGuestInitialUrl, type BrowserGuestPresentation, type BrowserGuestRequest, type BrowserHostMessage } from "../shared/browser-host";

// Guests stay connected to this document for their entire lifetime. Vue chrome
// stays in the app document too; no menu/side panel is adopted into a guest.
interface GuestElement extends HTMLElement {
  getWebContentsId(): number;
}
interface Guest {
  request: BrowserGuestRequest;
  element: GuestElement;
  presentation: BrowserGuestPresentation | null;
}
interface Surface { element: () => HTMLElement | null; visible: () => boolean }
const guests = new Map<string, Guest>();
const surfaces = new Map<string, Surface>();
let installed = false;

function surfaceClip(element: HTMLElement, rect: DOMRect) {
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipsX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
    const clipsY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const bounds = parent.getBoundingClientRect();
    if (clipsX) {
      left = Math.max(left, bounds.left + parent.clientLeft);
      right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
    }
    if (clipsY) {
      top = Math.max(top, bounds.top + parent.clientTop);
      bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
    }
  }
  return { visible: right > left && bottom > top,
    css: `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)` };
}

function layout(guest: Guest): void {
  const surface = surfaces.get(guest.request.viewId);
  const element = surface?.element();
  const presentation = guest.presentation;
  const rect = element?.getBoundingClientRect();
  const clip = element && rect ? surfaceClip(element, rect) : null;
  const visible = Boolean(presentation?.visible && element?.isConnected && surface?.visible()
    && rect && rect.width > 1 && rect.height > 1 && clip?.visible);
  const bounds = rect ?? presentation?.bounds ?? { x: 0, y: 0, width: guest.request.width, height: guest.request.height };
  const x = rect?.left ?? (bounds as { x: number }).x;
  const y = rect?.top ?? (bounds as { y: number }).y;
  Object.assign(guest.element.style, {
    left: `${visible ? x : -Math.max(1, bounds.width) - 100}px`,
    top: `${visible ? y : 0}px`,
    width: `${Math.max(1, bounds.width)}px`,
    height: `${Math.max(1, bounds.height)}px`,
    visibility: visible ? "visible" : "hidden",
    pointerEvents: visible ? "auto" : "none",
    clipPath: visible ? clip!.css : "none",
  });
  const focus = visible && presentation?.focus;
  if (presentation) presentation.focus = false;
  if (focus) guest.element.focus();
}

function create(request: BrowserGuestRequest): void {
  if (guests.has(request.token)) return;
  const element = document.createElement("webview") as GuestElement;
  element.className = "viron-browser-guest";
  element.dataset.browserViewId = request.viewId;
  element.dataset.browserPageId = request.pageId;
  element.setAttribute("partition", request.partition);
  element.setAttribute("useragent", browserGuestBindingAgent(request.token));
  element.setAttribute("allowpopups", "");
  element.style.cssText = "position:fixed;z-index:10;display:flex;background:white;visibility:hidden;pointer-events:none";
  const guest: Guest = { request, element, presentation: null };
  guests.set(request.token, guest);
  // Complete the bootstrap navigation before the main process loads a page.
  // Binding at dom-ready can race its load-commit and replay the bootstrap URL.
  element.addEventListener("did-stop-loading", () => {
    if (!guests.has(request.token)) return;
    void window.vironDesktop!.attachBrowserGuest(request.token, element.getWebContentsId())
      .catch((error) => console.error("[Viron] Browser guest binding failed", error));
  }, { once: true });
  element.setAttribute("src", browserGuestInitialUrl());
  document.body.appendChild(element);
  layout(guest);
}

function receive(message: BrowserHostMessage): void {
  if (message.type === "create") return create(message.request);
  const token = message.type === "present" ? message.presentation.token : message.token;
  const guest = guests.get(token);
  if (!guest) return;
  if (message.type === "destroy") {
    guests.delete(token);
    guest.element.remove();
    return;
  }
  if (guest.presentation && guest.presentation.revision >= message.presentation.revision) return;
  guest.presentation = message.presentation;
  layout(guest);
}

export function updateBrowserGuestLayout(): void {
  for (const guest of guests.values()) layout(guest);
}

export function installBrowserGuestHost(): void {
  if (installed || !window.vironDesktop) return;
  installed = true;
  window.vironDesktop.onBrowserHostMessage(receive);
  window.addEventListener("resize", updateBrowserGuestLayout);
  window.addEventListener("scroll", updateBrowserGuestLayout, true);
}

export function registerBrowserSurface(viewId: string, element: () => HTMLElement | null, visible: () => boolean): () => void {
  const surface = { element, visible };
  surfaces.set(viewId, surface);
  const observer = new ResizeObserver(updateBrowserGuestLayout);
  if (element()) observer.observe(element()!);
  updateBrowserGuestLayout();
  return () => {
    observer.disconnect();
    if (surfaces.get(viewId) === surface) surfaces.delete(viewId);
    updateBrowserGuestLayout();
  };
}
