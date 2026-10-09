import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  app,
  clipboard,
  Menu,
  BrowserWindow,
  session,
  type NativeImage,
  type Rectangle,
  type Session,
} from "electron";
import {
  DESKTOP_WEB_PAGE_LIMIT,
  desktopWebContextMenuGroups,
  desktopWebLastUrlKey,
  desktopWebPartitionName,
  pageAfterClose,
  supportedDesktopPopupUrl,
  supportedDesktopWebUrl,
  type DesktopWebContextMenuAction,
} from "./web-page-policy.js";
import { normalizeWebAddress } from "../shared/web-address.js";
import { reorderMap } from "../shared/tab-order.js";
import { ProtectedWebLogin } from "./protected-web-login.js";
import { verifyProtectedBusinessPage } from "./protected-web-login-business.js";
import { DirectWebAutofill, DIRECT_WEB_FILL_MESSAGE } from "../shared/direct-web-autofill.js";
import { captureWebCredentialTargetScript, fillWebCredentialTargetScript, installWebCredentialContextListenerScript } from "../shared/web-credential-context-fill.js";
import { defaultWebLoginConfig, type WebLoginConfig, type ProtectedLoginState, type ProtectedLoginInput } from "../shared/protected-web-login.js";
import { loadWebIcon } from "../shared/web-favicon.js";
import { immersiveNavigationEscapeAction } from "../shared/immersive-navigation.js";
import { shortcutActionForInput } from "../shared/keyboard-shortcuts.js";
import {
  pageZoomCommandFromKey,
  pageZoomFactor,
  pageZoomWheelShouldHandle,
  reducePageZoomWheel,
  selectPageZoomTarget,
  stepPageZoomBy,
} from "../shared/page-zoom.js";
import type { DesktopWebCredential } from "./device-identity.js";
import {
  currentAgentEntryMode,
  sendShortcutAction,
  shortcutPreferences,
} from "./app-state.js";
import { activeEndpoint } from "./endpoint-context.js";
import { pendingCredentialRequests, type DesktopAuthContext } from "./desktop-runtime-context.js";
import {
  localWebCredential,
  releaseDesktopRuntimeReservation,
  reserveDesktopRuntime,
  trackDesktopRuntime,
} from "./execution-router.js";
import { endpointJson } from "./http-proxy.js";
import { translate as tr } from "./i18n.js";
import { sendToAgentChat } from "./overlays/agent-chat-window.js";
import { closeBrowserGuests, createBrowserGuest, type BrowserPageHost } from "./browser-guest-host.js";
import {
  immersiveNavigationState,
  sendImmersiveNavigationAction,
} from "./overlays/immersive-navigation-window.js";
import {
  attachHistoryNavigationTouchTracking,
  handleDesktopHistoryNavigationMouse,
} from "./history-navigation-runtime.js";
import { mainWindow } from "./window-host.js";
import { closeDesktopWebExtensionPopup, forgetDesktopWebExtensions, loadDesktopWebExtensions, releaseDesktopWebSessionExtensions, resumeDesktopWebSessionExtensions, suspendDesktopWebSessionExtensions } from "./web-extensions.js";
import { closeExtensionBrowser, handleExtensionShortcut, registerExtensionBrowser, registerExtensionTab, selectExtensionTab } from "./web-extension-browser.js";
import { desktopWebExtensionContextMenuItems } from "./web-extension-context-menus.js";
import {
  desktopWebActionScript,
  desktopWebSnapshotScript,
  type DesktopWebSemanticSnapshot,
} from "./web-view-dom-script.js";
import {
  activeDesktopWebPage,
  applyDesktopWebCredential,
  applyDesktopWebPageZoom,
  cachedDesktopWebUrl,
  changeDesktopWebPageZoom,
  clearDesktopWebSession,
  desktopWebPreferences,
  enableDesktopWebSessionExtensions,
  desktopWebSession,
  desktopWebViews,
  forgetDesktopWebLastUrl,
  forgetDesktopWebZoom,
  inspectDesktopWebElement,
  latestDesktopWebCredential,
  notifyWebView,
  rememberDesktopWebLastUrl,
  restoreDesktopWebPageZoom,
  sendWebViewState,
  touchDesktopWebView,
  trackDesktopWebPartition,
  webViewBounds,
  webViewState,
} from "./web-view-support.js";

export { activeDesktopWebPage, desktopWebViews, inspectDesktopWebElement, webViewBounds, webViewState };
const closingProfiles = new WeakMap<Session, Promise<void>>();

export interface DesktopWebViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopWebInitialPage = "entry" | "blank";

export interface DesktopWebViewState {
  loginMode?: WebLoginConfig["mode"];
  id: string;
  credentialId: string;
  activePageId: string;
  pages: Array<{
    id: string;
    url: string;
    title: string;
    loading: boolean;
  }>;
  url: string;
  title: string;
  faviconDataUrl: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  autofillMessage: string;
  error: string;
  certificateError: {
    url: string;
    error: string;
  } | null;
  closedReason: string;
  notice: {
    id: string;
    type: "success" | "info" | "error";
    message: string;
  } | null;
  zoomFactor: number;
  protectedLogin: ProtectedLoginState | null;
  loginNotice: string;
}

export interface ManagedDesktopWebPage {
  directAutofill?: DirectWebAutofill;
  id: string;
  view: BrowserPageHost;
  allowAutofill: boolean;
  protectedEntry?: boolean;
  pendingUrl: string;
  loadingUrl: string;
  autofillSignature: string;
  autofillMessage: string;
  error: string;
  faviconDataUrl: string;
  faviconLoadVersion: number;
  certificateError: {
    url: string;
    error: string;
    callback: (isTrusted: boolean) => void;
  } | null;
  closing: boolean;
  zoomFactor: number;
  zoomWheelAccumulated: number;
  zoomWheelAt: number;
}

export interface ManagedDesktopWebView {
  id: string;
  registrationId: string;
  credentialId: string;
  entryId: string;
  entryUrl: string;
  entryOrigin: string;
  username: string;
  password: string;
  loginConfig: WebLoginConfig;
  login: ProtectedWebLogin | null;
  loginAttempt: string;
  loginPreparation: Promise<void>;
  loginNotice: string;
  pages: Map<string, ManagedDesktopWebPage>;
  pageGeneration: number;
  pendingPages: number;
  activePageId: string;
  bounds: Rectangle;
  visible: boolean;
  previewing: boolean;
  closing: boolean;
  lastActivityAt: number;
  closedReason: string;
  partition: Session;
  partitionName: string;
  lastUrlKey: string;
  lastUrl: string;
  notice: DesktopWebViewState["notice"];
  downloadListener: (event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents) => void;
}

export function previewImageDataUrl(image: NativeImage): string {
  const size = image.getSize();
  if (size.width < 2 || size.height < 2) return "";
  const targetRatio = 16 / 9;
  const ratio = size.width / size.height;
  const cropped = ratio > targetRatio
    ? image.crop({ x: Math.round((size.width - size.height * targetRatio) / 2), y: 0, width: Math.round(size.height * targetRatio), height: size.height })
    : ratio < targetRatio
      ? image.crop({ x: 0, y: Math.round((size.height - size.width / targetRatio) / 2), width: size.width, height: Math.round(size.width / targetRatio) })
      : image;
  const jpeg = cropped.resize({ width: 640, height: 360, quality: "good" }).toJPEG(72);
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

export async function captureWebContentsPreview(webContents: Electron.WebContents, bounds?: Rectangle): Promise<string> {
  if (webContents.isDestroyed()) return "";
  const image = await webContents.capturePage(bounds);
  if (image.isEmpty()) return "";
  return previewImageDataUrl(image);
}

export async function captureDesktopWebViewPreview(view: ManagedDesktopWebView): Promise<string> {
  if (!view.visible || view.login) return "";
  return await captureWebContentsPreview(activeDesktopWebPage(view).view.webContents);
}

export async function captureDesktopWebViewPage(view: ManagedDesktopWebView): Promise<string> {
  if (!view.visible || view.login) return "";
  const image = await activeDesktopWebPage(view).view.webContents.capturePage();
  return image.isEmpty() ? "" : image.toDataURL();
}

export function desktopRendererPreviewBounds(value: unknown): Rectangle {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error(tr("主窗口不可用"));
  if (!value || typeof value !== "object") throw new Error(tr("画中画截图区域无效"));
  const input = value as Partial<Rectangle>;
  if (![input.x, input.y, input.width, input.height].every(Number.isFinite)) throw new Error(tr("画中画截图区域无效"));
  const [viewportWidth, viewportHeight] = mainWindow.getContentSize();
  const left = Math.max(0, Math.floor(input.x!));
  const top = Math.max(0, Math.floor(input.y!));
  const right = Math.min(viewportWidth, Math.ceil(input.x! + input.width!));
  const bottom = Math.min(viewportHeight, Math.ceil(input.y! + input.height!));
  if (right - left < 2 || bottom - top < 2) throw new Error(tr("画中画截图区域无效"));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export async function captureDesktopRendererPreview(value: unknown): Promise<string> {
  if (!mainWindow || mainWindow.isDestroyed()) return "";
  return await captureWebContentsPreview(mainWindow.webContents, desktopRendererPreviewBounds(value));
}

export function layoutDesktopWebViewPages(view: ManagedDesktopWebView, focus = false): void {
  for (const page of view.pages.values()) {
    const active = page.id === view.activePageId;
    const visible = active && !view.login && view.visible && !page.certificateError;
    if (page.view.kind === "window") continue;
    if (active) page.view.setBounds(view.bounds);
    page.view.setVisible(visible);
    // Keep the active page running while focus moves into browser chrome or
    // an overlay. Inactive and genuinely hidden tabs retain Chromium's normal
    // background throttling, while preview workspaces preserve their live page.
    page.view.webContents.setBackgroundThrottling(!visible && !view.previewing);
  }
  if (focus && !view.login && view.visible && view.pages.has(view.activePageId) && !activeDesktopWebPage(view).certificateError) activeDesktopWebPage(view).view.focus();
}

export function activateDesktopWebPage(view: ManagedDesktopWebView, pageId: string): void {
  const page = view.pages.get(pageId);
  if (!page) throw new Error(tr("本机子页面不存在或已经关闭"));
  if (page.protectedEntry && page.pendingUrl) {
    view.lastUrl = page.pendingUrl;
    rememberDesktopWebLastUrl(view, page.pendingUrl);
    page.protectedEntry = false;
    page.pendingUrl = "";
    void refreshDesktopWebViews([view], true).catch(() => notifyWebView(view, "error", "无法准备后台登录，请重试"));
    return;
  }
  view.activePageId = pageId;
  selectExtensionTab(page.view.webContents);
  touchDesktopWebView(view);
  layoutDesktopWebViewPages(view, true);
  const pendingUrl = page.pendingUrl;
  rememberDesktopWebLastUrl(view, pendingUrl || page.view.webContents.getURL());
  if (pendingUrl) {
    page.pendingUrl = "";
    page.loadingUrl = pendingUrl;
    void page.view.webContents.loadURL(pendingUrl).catch((error) => {
      if (page.loadingUrl === pendingUrl) page.loadingUrl = "";
      page.error = error instanceof Error ? error.message : tr("本机页面加载失败");
      sendWebViewState(view);
    });
  }
  sendWebViewState(view);
}

export async function removeDesktopWebPage(view: ManagedDesktopWebView, pageId: string, closeContents: boolean): Promise<void> {
  const page = view.pages.get(pageId);
  if (!page) return;
  const nextPageId = pageAfterClose([...view.pages.values()].filter((item) => item.view.kind === "guest").map((item) => item.id), view.activePageId, pageId);
  page.directAutofill?.dispose();
  page.closing = closeContents;
  view.pages.delete(pageId);
  if (closeContents) page.view.dispose();
  if (view.closing || page.view.kind === "window") return;
  if (nextPageId) {
    activateDesktopWebPage(view, nextPageId);
    return;
  }
  await createDesktopWebPage(view, true).then((replacement) => {
    activateDesktopWebPage(view, replacement.id);
    return replacement.view.webContents.loadURL(view.entryUrl);
  }).catch((error) => {
    if (!view.closing) notifyWebView(view, "error", error instanceof Error ? error.message : tr("本机页面加载失败"));
  });
}

export function destroyDesktopWebPages(view: ManagedDesktopWebView): void {
  view.pageGeneration += 1;
  view.pendingPages = 0;
  for (const page of view.pages.values()) {
    page.directAutofill?.dispose();
    page.closing = true;
    resolveDesktopWebCertificateError(page, false);
    page.view.dispose();
  }
  closeBrowserGuests(view.id);
  view.pages.clear();
  view.activePageId = "";
}

function resolveDesktopWebCertificateError(page: ManagedDesktopWebPage, isTrusted: boolean): boolean {
  const pending = page.certificateError;
  if (!pending) return false;
  page.certificateError = null;
  pending.callback(isTrusted);
  return true;
}

export async function openDesktopWebLinkInNewPage(view: ManagedDesktopWebView, url: string): Promise<void> {
  if (!supportedDesktopWebUrl(url)) return;
  if (view.pages.size >= DESKTOP_WEB_PAGE_LIMIT) {
    notifyWebView(view, "error", tr("同一账号最多打开 {{0}} 个页面", [DESKTOP_WEB_PAGE_LIMIT]));
    return;
  }
  const page = await createDesktopWebPage(view, false);
  page.pendingUrl = url;
  activateDesktopWebPage(view, page.id);
}

export function desktopWebContextMenuItem(
  view: ManagedDesktopWebView,
  webContents: Electron.WebContents,
  params: Electron.ContextMenuParams,
  action: DesktopWebContextMenuAction,
  credentialTarget?: string,
): Electron.MenuItemConstructorOptions {
  const navigation = webContents.navigationHistory;
  switch (action) {
    case "fill-username":
    case "fill-password": return { label: tr(action === "fill-username" ? "填入用户名" : "填入密码"), enabled: Boolean(credentialTarget), click: () => {
      void fillDesktopWebCredentialTarget(view, webContents, credentialTarget!, action).catch(() => {
        if (!view.closing) notifyWebView(view, "error", tr("未能填入登录信息，请重新右键选择输入框"));
      });
    } };
    case "open-link-new-page": return { label: tr("在新标签页中打开链接"), click: () => {
      void openDesktopWebLinkInNewPage(view, params.linkURL).catch((error) => {
        if (!view.closing) notifyWebView(view, "error", error instanceof Error ? error.message : tr("本机页面加载失败"));
      });
    } };
    case "copy-link": return { label: tr("复制链接地址"), click: () => clipboard.writeText(params.linkURL) };
    case "undo": return { label: tr("撤销"), accelerator: "CommandOrControl+Z", enabled: params.editFlags.canUndo, click: () => webContents.undo() };
    case "redo": return { label: tr("重做"), accelerator: "CommandOrControl+Shift+Z", enabled: params.editFlags.canRedo, click: () => webContents.redo() };
    case "cut": return { label: tr("剪切"), accelerator: "CommandOrControl+X", enabled: params.editFlags.canCut, click: () => webContents.cut() };
    case "copy": return { label: tr("复制"), accelerator: "CommandOrControl+C", enabled: params.editFlags.canCopy, click: () => webContents.copy() };
    case "paste": return { label: tr("粘贴"), accelerator: "CommandOrControl+V", enabled: params.editFlags.canPaste, click: () => webContents.paste() };
    case "select-all": return { label: tr("全选"), accelerator: "CommandOrControl+A", enabled: params.editFlags.canSelectAll, click: () => webContents.selectAll() };
    case "back": return { label: tr("后退"), enabled: navigation.canGoBack(), click: () => navigation.goBack() };
    case "forward": return { label: tr("前进"), enabled: navigation.canGoForward(), click: () => navigation.goForward() };
    case "reload": return { label: tr("重新加载"), accelerator: "CommandOrControl+R", click: () => webContents.reload() };
    case "inspect": return { label: tr("检查元素"), click: () => inspectDesktopWebElement(webContents, params.x, params.y) };
  }
}

async function fillDesktopWebCredentialTarget(view: ManagedDesktopWebView, contents: Electron.WebContents, token: string, action: "fill-username" | "fill-password"): Promise<void> {
  const page = activeDesktopWebPage(view);
  if (!page || page.view.webContents !== contents || view.login) return;
  page.directAutofill?.dispose();
  const credential = await latestDesktopWebCredential(view.credentialId);
  if (view.closing || desktopWebViews.get(view.id) !== view || activeDesktopWebPage(view) !== page || contents.isDestroyed() || view.login) return;
  const origins = [new URL(credential.entryUrl).origin, ...(credential.loginConfig?.allowedOrigins ?? [])];
  const filled = await contents.executeJavaScriptInIsolatedWorld(999, [{ code: fillWebCredentialTargetScript(token, action === "fill-username" ? credential.username : credential.password, origins, action === "fill-password" && view.loginConfig.mode === "locked") }], true);
  if (!filled) throw new Error("stale-input");
  view.loginNotice = "";
  sendWebViewState(view);
}

let desktopWebZoomTargetId = "";

export function noteDesktopWebZoomTarget(id: string): void {
  if (!id || !desktopWebViews.has(id)) return;
  desktopWebZoomTargetId = id;
}

export function handleDesktopShellPageZoom(input: {
  key: string;
  code?: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}): boolean {
  const command = pageZoomCommandFromKey(input);
  if (!command) return false;
  const view = selectPageZoomTarget([...desktopWebViews.values()].map((candidate) => ({
    id: candidate.id,
    visible: candidate.visible,
    closing: candidate.closing,
    closedReason: candidate.closedReason,
    lastActivityAt: candidate.lastActivityAt,
    hasActivePage: candidate.pages.has(candidate.activePageId),
    view: candidate,
  })), desktopWebZoomTargetId);
  if (!view) return false;
  noteDesktopWebZoomTarget(view.id);
  changeDesktopWebPageZoom(view.view, activeDesktopWebPage(view.view), command);
  return true;
}

function zoomWheelModifiers(mouse: Electron.MouseInputEvent): { control: boolean; meta: boolean; alt: boolean; shift: boolean } {
  const modifiers = new Set(mouse.modifiers ?? []);
  const record = mouse as Electron.MouseInputEvent & { control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean };
  return {
    control: modifiers.has("control") || modifiers.has("ctrl") || record.control === true,
    meta: modifiers.has("meta") || modifiers.has("command") || modifiers.has("cmd") || record.meta === true,
    alt: modifiers.has("alt") || record.alt === true,
    shift: modifiers.has("shift") || record.shift === true,
  };
}

function handleDesktopWebPageZoomWheel(
  event: Electron.Event,
  mouse: Electron.MouseInputEvent,
  view: ManagedDesktopWebView,
  page: ManagedDesktopWebPage,
): boolean {
  if (mouse.type !== "mouseWheel" || page.closing) return false;
  const wheel = mouse as Electron.MouseWheelInputEvent;
  const modifiers = zoomWheelModifiers(mouse);
  const deltaX = Number(wheel.deltaX ?? 0) || Number(wheel.wheelTicksX ?? 0) * 100;
  const deltaY = Number(wheel.deltaY ?? 0) || Number(wheel.wheelTicksY ?? 0) * 100;
  if (!pageZoomWheelShouldHandle({ ...modifiers, deltaX, deltaY })) return false;
  event.preventDefault();
  noteDesktopWebZoomTarget(view.id);
  const now = Date.now();
  if (now - page.zoomWheelAt > 180) page.zoomWheelAccumulated = 0;
  const reduced = reducePageZoomWheel(page.zoomWheelAccumulated, deltaY);
  page.zoomWheelAccumulated = reduced.accumulated;
  page.zoomWheelAt = now;
  if (reduced.steps !== 0) {
    const next = stepPageZoomBy(page.zoomFactor, reduced.steps);
    if (next !== page.zoomFactor) applyDesktopWebPageZoom(view, page, next, { persist: true });
  }
  return true;
}

async function updateDesktopWebPageFavicon(
  view: ManagedDesktopWebView,
  page: ManagedDesktopWebPage,
  candidates: string[],
): Promise<void> {
  const version = ++page.faviconLoadVersion;
  for (const candidate of [...new Set(candidates)].slice(0, 8)) {
    const dataUrl = await loadWebIcon(candidate, (input, init) => view.partition.fetch(
      input instanceof URL ? input.href : input,
      { ...init, credentials: "include" },
    ));
    if (version !== page.faviconLoadVersion || page.closing || view.closing || !view.pages.has(page.id)) return;
    if (!dataUrl) continue;
    page.faviconDataUrl = dataUrl;
    sendWebViewState(view);
    return;
  }
}

export async function createDesktopWebPage(
  view: ManagedDesktopWebView,
  allowAutofill: boolean,
): Promise<ManagedDesktopWebPage> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const id = randomUUID();
  if (view.pages.size + view.pendingPages >= DESKTOP_WEB_PAGE_LIMIT) throw new Error(tr("同一账号最多打开 {{0}} 个页面", [DESKTOP_WEB_PAGE_LIMIT]));
  const generation = view.pageGeneration;
  view.pendingPages += 1;
  const guest = await createBrowserGuest(mainWindow.webContents, view.partition, view.partitionName,
    view.id, id, view.bounds, { ...desktopWebPreferences(view.partition), devTools: view.loginConfig.mode !== "locked" }).finally(() => {
      if (generation === view.pageGeneration) view.pendingPages -= 1;
    });
  if (view.closing || desktopWebViews.get(view.id) !== view || generation !== view.pageGeneration) {
    guest.dispose();
    throw new Error(tr("本机账号页面不存在或已经关闭"));
  }
  return configureDesktopWebPage(view, allowAutofill, guest, id);
}

function configureDesktopWebPage(
  view: ManagedDesktopWebView,
  allowAutofill: boolean,
  nativeView: BrowserPageHost,
  id = randomUUID(),
): ManagedDesktopWebPage {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  nativeView.webContents.setBackgroundThrottling(!view.visible && !view.previewing);
  const page: ManagedDesktopWebPage = {
    id,
    view: nativeView,
    allowAutofill,
    pendingUrl: "",
    loadingUrl: "",
    autofillSignature: "",
    autofillMessage: "",
    error: "",
    faviconDataUrl: "",
    faviconLoadVersion: 0,
    certificateError: null,
    closing: false,
    zoomFactor: 1,
    zoomWheelAccumulated: 0,
    zoomWheelAt: 0,
  };
  view.pages.set(page.id, page);
  const pageWindow = nativeView.kind === "window" ? BrowserWindow.fromWebContents(nativeView.webContents) : mainWindow;
  registerExtensionTab(nativeView.webContents, {
    windowId: pageWindow?.id ?? mainWindow.id,
    bounds: () => nativeView.getBounds(),
    select: () => nativeView.kind === "window" ? nativeView.focus() : activateDesktopWebPage(view, page.id),
    remove: () => removeDesktopWebPage(view, page.id, true),
  });
  nativeView.webContents.on("focus", () => selectExtensionTab(nativeView.webContents));
  attachHistoryNavigationTouchTracking(nativeView.webContents);
  nativeView.webContents.on("before-mouse-event", (event, mouse) => {
    if (handleDesktopWebPageZoomWheel(event, mouse, view, page)) return;
    if (handleDesktopHistoryNavigationMouse(event, mouse, view, nativeView.webContents)) return;
    if (mouse.type !== "mouseDown") return;
    closeDesktopWebExtensionPopup(view.lastUrlKey);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("viron:native-view-pointer-down");
    sendToAgentChat("viron:native-view-pointer-down");
  });
  nativeView.webContents.on("dom-ready", () => {
    void nativeView.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: installWebCredentialContextListenerScript() }]).catch(() => undefined);
  });
  nativeView.webContents.on("context-menu", async (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed() || nativeView.webContents.isDestroyed()) return;
    const token = randomUUID();
    const origins = [new URL(view.entryUrl).origin, ...view.loginConfig.allowedOrigins];
    const available = !view.login && params.isEditable && await nativeView.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: captureWebCredentialTargetScript(token, params.x, params.y, origins, true) }], true).catch(() => false);
    if (!mainWindow || mainWindow.isDestroyed() || nativeView.webContents.isDestroyed() || view.closing) return;
    const groups = desktopWebContextMenuGroups({
      linkUrl: params.linkURL,
      isEditable: params.isEditable,
      hasSelection: Boolean(params.selectionText),
      credentialFillAvailable: Boolean(available),
      inspectAllowed: view.loginConfig.mode !== "locked",
    });
    const template = groups.flatMap((group, index) => [
      ...(index > 0 ? [{ type: "separator" as const }] : []),
      ...group.map((action) => desktopWebContextMenuItem(view, nativeView.webContents, params, action, available ? token : undefined)),
    ]);
    const extensionItems = view.loginConfig.mode === "locked" ? [] : desktopWebExtensionContextMenuItems(view.partition, nativeView.webContents, params);
    if (extensionItems.length) {
      if (template.length) template.push({ type: "separator" });
      template.push(...extensionItems);
    }
    Menu.buildFromTemplate(template).popup({ window: pageWindow ?? mainWindow });
  });
  nativeView.webContents.on("before-input-event", (event, input) => {
    if (view.loginConfig.mode !== "locked" && handleExtensionShortcut(nativeView.webContents, input)) { event.preventDefault(); return; }
    if (input.type === "keyDown") {
      const command = pageZoomCommandFromKey({
        key: input.key,
        code: input.code,
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
      });
      if (command) {
        event.preventDefault();
        noteDesktopWebZoomTarget(view.id);
        changeDesktopWebPageZoom(view, page, command);
        return;
      }
    }
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    if (input.key === "Escape") {
      const action = immersiveNavigationEscapeAction(immersiveNavigationState);
      if (!action) return;
      event.preventDefault();
      sendImmersiveNavigationAction(action);
      return;
    }
    const shortcutAction = shortcutActionForInput(shortcutPreferences().bindings, {
      key: input.key,
      code: input.code,
      meta: input.meta,
      control: input.control,
      alt: input.alt,
      shift: input.shift,
    }, process.platform);
    if (shortcutAction !== "app.agentQuickInput" || currentAgentEntryMode() !== "quick") return;
    event.preventDefault();
    sendShortcutAction(shortcutAction);
  });
  nativeView.webContents.setWindowOpenHandler(({ url }) => {
    if (!supportedDesktopPopupUrl(url)) {
      page.autofillMessage = tr("已阻止非 HTTP(S) 弹窗");
      sendWebViewState(view);
      return { action: "deny" };
    }
    if (view.pages.size + view.pendingPages >= DESKTOP_WEB_PAGE_LIMIT) {
      page.autofillMessage = tr("同一账号最多打开 {{0}} 个页面", [DESKTOP_WEB_PAGE_LIMIT]);
      sendWebViewState(view);
      return { action: "deny" };
    }
    return {
      action: "allow",
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: { ...desktopWebPreferences(view.partition), devTools: view.loginConfig.mode !== "locked" } },
      createWindow: (options) => {
        // Preserve window.opener and script-created about:blank documents in a
        // real page popup. App chrome is never moved into this document.
        const popup = new BrowserWindow({ ...options, show: true, width: 1000, height: 720 });
        const popupHost: BrowserPageHost = {
          kind: "window", webContents: popup.webContents,
          setBounds() {}, getBounds: () => popup.getContentBounds(), setVisible() {},
          focus: () => popup.focus(), dispose: () => { if (!popup.isDestroyed()) popup.destroy(); },
        };
        const child = configureDesktopWebPage(view, false, popupHost);
        popup.on("closed", () => { void removeDesktopWebPage(view, child.id, false); });
        return popup.webContents;
      },
    };
  });
  nativeView.webContents.on("will-navigate", (event, url) => {
    if (!supportedDesktopPopupUrl(url)) {
      event.preventDefault();
      return;
    }
    restoreDesktopWebPageZoom(view, page, url);
  });
  nativeView.webContents.on("certificate-error", (event, url, error, _certificate, callback, isMainFrame) => {
    if (!isMainFrame || !supportedDesktopWebUrl(url)) return;
    event.preventDefault();
    resolveDesktopWebCertificateError(page, false);
    page.certificateError = { url, error, callback };
    page.error = "";
    layoutDesktopWebViewPages(view);
    sendWebViewState(view);
  });
  nativeView.webContents.on("did-start-loading", () => { touchDesktopWebView(view); sendWebViewState(view); });
  nativeView.webContents.on("did-stop-loading", () => { touchDesktopWebView(view); sendWebViewState(view); });
  nativeView.webContents.on("page-title-updated", () => sendWebViewState(view));
  nativeView.webContents.on("page-favicon-updated", (_event, favicons) => {
    void updateDesktopWebPageFavicon(view, page, favicons);
  });
  nativeView.webContents.on("zoom-changed", () => {
    if (page.closing || nativeView.webContents.isDestroyed()) return;
    const snapped = pageZoomFactor(nativeView.webContents.getZoomFactor());
    if (snapped === page.zoomFactor) return;
    applyDesktopWebPageZoom(view, page, snapped, { persist: true });
  });
  nativeView.webContents.on("did-navigate", (_event, url) => {
    page.loadingUrl = "";
    restoreDesktopWebPageZoom(view, page, url);
    if (view.activePageId === page.id) rememberDesktopWebLastUrl(view, url);
    sendWebViewState(view);
  });
  nativeView.webContents.on("did-navigate-in-page", (_event, url) => {
    if (view.activePageId === page.id) rememberDesktopWebLastUrl(view, url);
    sendWebViewState(view);
  });
  nativeView.webContents.on("render-process-gone", (_event, details) => {
    page.error = tr("本机页面进程已退出（{{0}}）", [details.reason]);
    sendWebViewState(view);
  });
  nativeView.webContents.on("destroyed", () => {
    resolveDesktopWebCertificateError(page, false);
    if (!view.closing && !page.closing) void removeDesktopWebPage(view, page.id, false);
  });
  return page;
}

function cacheableLoginResumeUrl(entryUrl: string, key: string): string {
  const restored = cachedDesktopWebUrl(entryUrl, key);
  return restored === entryUrl || /\/(login|signin)(?:[/?#]|$)/i.test(restored) ? "" : restored;
}

function registerBusinessExtensions(view: ManagedDesktopWebView): void {
  enableDesktopWebSessionExtensions(view.partition, view.lastUrlKey);
  registerExtensionBrowser(view.partition, {
    create: async (url, active) => {
      if ((view.login && view.login.state.phase !== "authenticating") || view.closing || view.pages.size >= DESKTOP_WEB_PAGE_LIMIT) throw new Error("No space for another extension tab");
      const page = await createDesktopWebPage(view, false);
      page.loadingUrl = url;
      void page.view.webContents.loadURL(url).catch(() => undefined);
      if (active) activateDesktopWebPage(view, page.id);
      sendWebViewState(view);
      return page.view.webContents;
    },
  });
}

async function startConfiguredDesktopLogin(view: ManagedDesktopWebView): Promise<void> {
  if (view.loginConfig.mode === "protected") { startProtectedDesktopLogin(view); return; }
  const previous = view.login;
  previous?.dispose();
  const attempt = randomUUID();
  view.loginAttempt = attempt;
  view.notice = null;
  view.loginNotice = "";
  const current = () => !view.closing && desktopWebViews.get(view.id) === view && view.loginAttempt === attempt;
  destroyDesktopWebPages(view);
  await view.loginPreparation;
  await previous?.settled();
  if (!current()) return;
  closeDesktopWebExtensionPopup();
  closeExtensionBrowser(view.partition);
  if (view.loginConfig.mode === "locked") await suspendDesktopWebSessionExtensions(view.partition);
  else await resumeDesktopWebSessionExtensions(view.partition);
  if (!current()) return;
  // Both fill modes use an interactive guest. Locked mode keeps extensions
  // suspended and developer tools disabled for the account's entire view.
  if (view.loginConfig.mode !== "locked") {
    enableDesktopWebSessionExtensions(view.partition, view.lastUrlKey);
    await loadDesktopWebExtensions(view.partition, view.lastUrlKey);
  }
  if (!current()) return;
  const page = await createDesktopWebPage(view, true);
  if (!current()) { page.view.dispose(); return; }
  view.login = null;
  if (view.loginConfig.mode !== "locked") registerBusinessExtensions(view);
  page.loadingUrl = view.entryUrl;
  activateDesktopWebPage(view, page.id);
  const navigation = page.view.webContents.loadURL(view.entryUrl);
  fillDirectDesktopPage(view, page);
  void navigation.catch(() => {
    if (current()) { page.loadingUrl = ""; page.error = tr("网页加载失败，请检查地址或网络后刷新"); sendWebViewState(view); }
  });
}

function fillDirectDesktopPage(view: ManagedDesktopWebView, page: ManagedDesktopWebPage): void {
  page.directAutofill?.dispose();
  page.autofillMessage = "";
  view.loginNotice = "";
  const contents = page.view.webContents;
  const current = () => !view.closing && desktopWebViews.get(view.id) === view && view.pages.get(page.id) === page && !view.login;
  page.directAutofill = new DirectWebAutofill({
    browser: { destroyed: () => !current() || contents.isDestroyed(), loading: () => contents.isLoading(), evaluate: (source) => contents.executeJavaScriptInIsolatedWorld(999, [{ code: source }], true) },
    entryUrl: view.entryUrl, config: view.loginConfig, username: view.username, password: view.password,
    changed: (message) => { if (current()) { view.loginNotice = message === DIRECT_WEB_FILL_MESSAGE ? "" : message; sendWebViewState(view); } },
  });
  view.password = "";
  sendWebViewState(view);
}

function startProtectedDesktopLogin(view: ManagedDesktopWebView): void {
  const previousLogin = view.login;
  previousLogin?.dispose();
  const attempt = randomUUID();
  view.loginAttempt = attempt;
  view.notice = null;
  view.loginNotice = "";
  const current = () => !view.closing && desktopWebViews.get(view.id) === view && view.loginAttempt === attempt;
  closeDesktopWebExtensionPopup();
  closeExtensionBrowser(view.partition);
  destroyDesktopWebPages(view);
  const preparation = suspendDesktopWebSessionExtensions(view.partition).then(() => previousLogin?.settled());
  view.loginPreparation = preparation;
  // Retain the stable account profile. The hidden authentication document is
  // loaded only after extension workers, preloads and old website workers stop.
  view.login = new ProtectedWebLogin({
    session: view.partition, url: view.entryUrl, username: view.username, password: view.password,
    prepare: () => preparation,
    config: view.loginConfig, bounds: view.bounds,
    manualFallback: () => { if (current()) void browseDesktopWebWithoutAutofill(view).catch(() => undefined); },
    changed: () => {
      if (!current()) return;
      sendWebViewState(view);
      if (view.login?.state.phase === "failed") void browseDesktopWebWithoutAutofill(view).catch(() => undefined);
    },
    completed: async ({ url, sessionStorage, authenticated }) => {
      if (!current()) return;
      try {
        // Authentication document was destroyed before any extension or guest exists.
        await resumeDesktopWebSessionExtensions(view.partition);
        if (!current()) return;
        registerBusinessExtensions(view);
        await loadDesktopWebExtensions(view.partition, view.lastUrlKey);
        if (!current()) return;
        const page = await createDesktopWebPage(view, false);
        if (!current()) { page.view.dispose(); return; }
        const contents = page.view.webContents;
        let storageScriptId: string | undefined;
        if (Object.keys(sessionStorage).length) {
          contents.debugger.attach("1.3");
          const result = await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: `if (location.origin === ${JSON.stringify(new URL(url).origin)}) { for (const [key, value] of Object.entries(${JSON.stringify(sessionStorage)})) sessionStorage.setItem(key, value); }`,
          });
          storageScriptId = result.identifier;
        }
        if (!current()) return;
        const target = view.lastUrl && !/\/(?:log-?in|sign-?in|auth)(?:[/?#]|$)/i.test(new URL(view.lastUrl).pathname + new URL(view.lastUrl).hash) ? view.lastUrl : url;
        await contents.loadURL(target);
        if (!current()) return;
        if (view.login) Object.assign(view.login.state, { pageLoading: false, message: "业务网页已加载，正在确认登录状态" });
        sendWebViewState(view);
        if (storageScriptId) {
          await contents.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: storageScriptId });
          contents.debugger.detach();
        }
        if (!current()) return;
        view.login = null;
        activateDesktopWebPage(view, page.id);
        // The fresh business document contains no injected credentials. Its
        // login marker is diagnostic and must never block ordinary browsing.
        const successSelector = view.loginConfig.successSelector || view.loginConfig.steps.find((step) => step.action === "success")?.selector || "";
        try {
          await verifyProtectedBusinessPage(contents, target === url ? successSelector : "", current);
          if (current() && authenticated) notifyWebView(view, "success", "后台登录已完成");
        } catch {
          if (current()) { view.loginNotice = "未能确认登录状态，网页仍可继续使用。可检查登录配置后重试自动登录。"; sendWebViewState(view); }
        }
      } catch (error) {
        if (!current()) return;
        destroyDesktopWebPages(view);
        if (view.login) Object.assign(view.login.state, { phase: "failed", pageLoading: false, message: error instanceof Error && error.message === "business-login"
          ? "业务页面仍在登录页，登录状态未生效。请检查登录配置后重试"
          : "未能确认业务页面已登录，请检查登录成功标记后重试" });
        sendWebViewState(view);
        await browseDesktopWebWithoutAutofill(view);
      }
    },
  });
  view.password = "";
  sendWebViewState(view);
}

const desktopBrowseTransitions = new WeakMap<ManagedDesktopWebView, Promise<void>>();

/** Never expose the authentication document, even when its form cannot be identified. */
export function browseDesktopWebWithoutAutofill(view: ManagedDesktopWebView): Promise<void> {
  const pending = desktopBrowseTransitions.get(view);
  if (pending) return pending;
  const login = view.login;
  if (!login || view.closing) return Promise.resolve();
  const attempt = randomUUID();
  view.loginAttempt = attempt;
  const current = () => !view.closing && desktopWebViews.get(view.id) === view && view.loginAttempt === attempt;
  login.dispose();
  Object.assign(login.state, { phase: "authenticating", pageLoading: false, message: "正在安全打开网页" });
  sendWebViewState(view);
  const transition = (async () => {
    try {
      await view.loginPreparation;
      await login.settled();
      if (!current()) return;
      destroyDesktopWebPages(view);
      await resumeDesktopWebSessionExtensions(view.partition);
      if (!current()) return;
      registerBusinessExtensions(view);
      await loadDesktopWebExtensions(view.partition, view.lastUrlKey);
      if (!current()) return;
      const page = await createDesktopWebPage(view, false);
      if (!current()) { page.view.dispose(); return; }
      view.password = "";
      view.login = null;
      view.loginNotice = "";
      page.loadingUrl = view.entryUrl;
      activateDesktopWebPage(view, page.id);
      void page.view.webContents.loadURL(view.entryUrl).catch(() => {
        if (current()) { page.loadingUrl = ""; page.error = tr("网页加载失败，请检查地址或网络后刷新"); sendWebViewState(view); }
      });
    } catch {
      if (current()) {
        Object.assign(login.state, { phase: "failed", pageLoading: false, message: "无法安全准备网页，请重试；托管密码仍受保护" });
        sendWebViewState(view);
      }
    }
  })();
  desktopBrowseTransitions.set(view, transition);
  void transition.finally(() => { if (desktopBrowseTransitions.get(view) === transition) desktopBrowseTransitions.delete(view); });
  return transition;
}

export async function reopenDesktopWebViews(views: ManagedDesktopWebView[], credential: DesktopWebCredential): Promise<void> {
  for (const view of views) {
    if (view.closing || desktopWebViews.get(view.id) !== view) continue;
    applyDesktopWebCredential(view, credential);
    await startConfiguredDesktopLogin(view);
  }
}

export async function refreshDesktopWebViews(views: ManagedDesktopWebView[], reopen: boolean): Promise<void> {
  const first = views[0];
  if (!first) return;
  const credential = await latestDesktopWebCredential(first.credentialId);
  if (reopen) await reopenDesktopWebViews(views, credential);
  else for (const view of views) {
    applyDesktopWebCredential(view, credential);
    if (view.login) await startConfiguredDesktopLogin(view);
    else {
      for (const page of view.pages.values()) page.directAutofill?.dispose();
      view.password = "";
      sendWebViewState(view);
    }
  }
}

export async function resetDesktopWebViews(views: ManagedDesktopWebView[]): Promise<void> {
  const first = views[0];
  if (!first) return;
  const credential = await latestDesktopWebCredential(first.credentialId);
  forgetDesktopWebLastUrl(first.lastUrlKey);
  for (const view of views) view.lastUrl = "";
  for (const view of views) { view.login?.dispose(); destroyDesktopWebPages(view); }
  try {
    await clearDesktopWebSession(first.partition);
  } catch (error) {
    await reopenDesktopWebViews(views, credential);
    throw error;
  }
  await reopenDesktopWebViews(views, credential);
  for (const view of views) notifyWebView(view, "info", tr("已清除本机登录状态，正在重新打开登录页"));
}

export async function resetDesktopWebView(view: ManagedDesktopWebView): Promise<DesktopWebViewState> {
  await resetDesktopWebViews([...desktopWebViews.values()].filter((candidate) => candidate.credentialId === view.credentialId));
  return webViewState(view);
}

export async function openDesktopWebView(
  credentialId: string,
  bounds: DesktopWebViewBounds,
  initialPage: DesktopWebInitialPage = "entry",
  visible = true,
  originEnvironmentId?: string,
): Promise<DesktopWebViewState> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const existing = [...desktopWebViews.values()].find((view) => view.credentialId === credentialId && !view.closing);
  if (existing) return webViewState(existing);
  if (desktopWebViews.size >= 8) throw new Error(tr("本机最多同时打开 8 个账号页面，请先关闭一个页面"));
  const { auth, credential } = await localWebCredential(credentialId);
  if (!supportedDesktopWebUrl(credential.entryUrl)) throw new Error(tr("Web 入口地址只支持 HTTP 或 HTTPS"));
  const endpoint = activeEndpoint?.endpoint;
  if (!endpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  const registrationId = await reserveDesktopRuntime("web", credentialId, undefined, originEnvironmentId);
  const id = randomUUID();
  const partitionName = desktopWebPartitionName(endpoint, auth.user.id, credential.credentialId);
  const webPartition = session.fromPartition(partitionName);
  try { await closingProfiles.get(webPartition); }
  catch (error) { await releaseDesktopRuntimeReservation(registrationId); throw error; }
  const concurrent = [...desktopWebViews.values()].find((view) => view.partition === webPartition && !view.closing);
  if (concurrent) {
    await releaseDesktopRuntimeReservation(registrationId);
    return webViewState(concurrent);
  }
  const lastUrlKey = desktopWebLastUrlKey(endpoint, auth.user.id, credential.credentialId);
  const managed: ManagedDesktopWebView = {
    id,
    registrationId,
    credentialId,
    entryId: credential.entryId,
    entryUrl: credential.entryUrl,
    entryOrigin: new URL(credential.entryUrl).origin,
    username: credential.username,
    password: credential.password,
    loginConfig: credential.loginConfig ?? defaultWebLoginConfig(),
    login: null,
    loginAttempt: "",
    loginPreparation: Promise.resolve(),
    loginNotice: "",
    pages: new Map(),
    pageGeneration: 0,
    pendingPages: 0,
    activePageId: "",
    bounds: webViewBounds(bounds),
    visible,
    previewing: false,
    closing: false,
    lastActivityAt: Date.now(),
    closedReason: "",
    partition: webPartition,
    partitionName,
    lastUrlKey,
    lastUrl: cacheableLoginResumeUrl(credential.entryUrl, lastUrlKey),
    notice: null,
    downloadListener: (_event, item, webContents) => {
      const page = [...managed.pages.values()].find((item) => item.view.webContents.id === webContents.id);
      if (!page) return;
      const filename = basename(item.getFilename()) || "download";
      const smokeDownloadPath = process.argv.includes("--smoke-test") ? process.env.VIRON_DESKTOP_SMOKE_DOWNLOAD_PATH?.trim() : "";
      if (smokeDownloadPath) item.setSavePath(smokeDownloadPath);
      else item.setSaveDialogOptions({ title: tr("保存网页下载"), defaultPath: join(app.getPath("downloads"), filename) });
      notifyWebView(managed, "info", tr("准备下载 {{0}}", [filename]));
      item.once("done", (_downloadEvent, state) => {
        if (state === "completed") notifyWebView(managed, "success", tr("{{0}} 已保存", [filename]));
        else if (state === "cancelled") notifyWebView(managed, "info", tr("已取消下载 {{0}}", [filename]));
        else notifyWebView(managed, "error", tr("{{0}} 下载失败", [filename]));
      });
    },
  };
  try {
    desktopWebViews.set(id, managed);
    trackDesktopWebPartition(webPartition);
    webPartition.on("will-download", managed.downloadListener);
    trackDesktopRuntime({
      id: registrationId,
      localId: id,
      activity: () => desktopWebViews.get(id)?.lastActivityAt ?? null,
      close: (reason) => closeDesktopWebView(id, reason),
    });
    if (initialPage === "entry") await startConfiguredDesktopLogin(managed);
    else {
      managed.password = "";
      if (managed.loginConfig.mode === "locked") await suspendDesktopWebSessionExtensions(managed.partition);
      else {
        await resumeDesktopWebSessionExtensions(managed.partition);
        registerBusinessExtensions(managed);
        await loadDesktopWebExtensions(managed.partition, lastUrlKey);
      }
      const entryPage = await createDesktopWebPage(managed, false);
      entryPage.protectedEntry = true;
      entryPage.pendingUrl = credential.entryUrl;
      const blankPage = await createDesktopWebPage(managed, false);
      activateDesktopWebPage(managed, blankPage.id);
    }
    return webViewState(managed);
  } catch (error) {
    desktopWebViews.delete(id);
    managed.closing = true;
    managed.login?.dispose();
    destroyDesktopWebPages(managed);
    await releaseDesktopRuntimeReservation(registrationId);
    throw error;
  }
}

async function waitForProtectedDesktopLogin(view: ManagedDesktopWebView): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (view.login && !["failed", "interactive"].includes(view.login.state.phase) && Date.now() < deadline && !view.closing) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (view.login) throw new Error("请在账号页面完成后台登录后再读取或操作业务页面：" + view.login.state.message);
}

export async function snapshotDesktopWebCredential(credentialId: string, width: number, height: number, maxTextChars: number) {
  const existing = [...desktopWebViews.values()].find((view) => view.credentialId === credentialId && !view.closing);
  let managed = existing;
  let createdId: string | null = null;
  if (!managed) {
    const state = await openDesktopWebView(credentialId, { x: 0, y: 0, width, height }, "entry", false);
    createdId = state.id;
    managed = desktopWebViews.get(state.id);
  }
  if (!managed) throw new Error(tr("本机 Web 页面未能启动"));
  try {
    await waitForProtectedDesktopLogin(managed);
    const page = activeDesktopWebPage(managed);
    const deadline = Date.now() + 20_000;
    while (page.view.webContents.isLoading() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    const semantic = await page.view.webContents.executeJavaScript(desktopWebSnapshotScript, true) as DesktopWebSemanticSnapshot;
    const limit = Math.max(1_000, Math.min(200_000, Math.round(maxTextChars)));
    touchDesktopWebView(managed);
    return {
      view: webViewState(managed),
      text: semantic.text.slice(0, limit),
      textTruncated: semantic.text.length > limit,
      interactive: semantic.interactive,
    };
  } finally {
    if (createdId) await closeDesktopWebView(createdId, tr("MCP Web 快照已完成"));
  }
}

export interface DesktopMcpWebAction {
  action: "click" | "fill" | "select" | "submit";
  elementIndex: number;
  value?: string;
  expectedName?: string;
}

export interface DesktopMcpWebControl {
  action: "navigate" | "back" | "forward" | "reload";
  url?: string;
}

export async function actOnDesktopWebCredential(credentialId: string, input: DesktopMcpWebAction) {
  let managed = [...desktopWebViews.values()].find((view) => view.credentialId === credentialId && !view.closing);
  if (!managed) {
    const state = await openDesktopWebView(credentialId, { x: 0, y: 0, width: 1280, height: 720 }, "entry", false);
    managed = desktopWebViews.get(state.id);
  }
  if (!managed) throw new Error(tr("本机 Web 页面未能启动"));
  await waitForProtectedDesktopLogin(managed);
  const page = activeDesktopWebPage(managed);
  const deadline = Date.now() + 20_000;
  while (page.view.webContents.isLoading() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const element = await page.view.webContents.executeJavaScript(desktopWebActionScript(input), true) as { index: number; tag: string; name: string };
  touchDesktopWebView(managed);
  return {
    view: webViewState(managed),
    action: input.action,
    element,
    url: activeDesktopWebPage(managed).view.webContents.getURL(),
    title: activeDesktopWebPage(managed).view.webContents.getTitle(),
  };
}

export async function controlDesktopWebCredential(credentialId: string, input: DesktopMcpWebControl) {
  let managed = [...desktopWebViews.values()].find((view) => view.credentialId === credentialId && !view.closing);
  if (!managed) {
    const state = await openDesktopWebView(credentialId, { x: 0, y: 0, width: 1280, height: 720 }, "entry", false);
    managed = desktopWebViews.get(state.id);
  }
  if (!managed) throw new Error(tr("本机 Web 页面未能启动"));
  await waitForProtectedDesktopLogin(managed);
  const page = activeDesktopWebPage(managed);
  const webContents = page.view.webContents;
  const navigation = webContents.navigationHistory;
  if (input.action === "navigate") {
    if (!input.url || !supportedDesktopWebUrl(input.url)) throw new Error(tr("页面地址只支持 HTTP 或 HTTPS URL"));
    page.pendingUrl = "";
    page.error = "";
    await webContents.loadURL(input.url);
  } else if (input.action === "back") {
    if (navigation.canGoBack()) navigation.goBack();
  } else if (input.action === "forward") {
    if (navigation.canGoForward()) navigation.goForward();
  } else {
    webContents.reload();
  }
  const deadline = Date.now() + 30_000;
  while (webContents.isLoading() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  touchDesktopWebView(managed);
  return {
    view: webViewState(managed),
    action: input.action,
    url: webContents.getURL(),
    title: webContents.getTitle(),
  };
}

export async function uploadDesktopWebCredential(credentialId: string, filenameValue: string, data: Buffer) {
  let managed = [...desktopWebViews.values()].find((view) => view.credentialId === credentialId && !view.closing);
  if (!managed) {
    const state = await openDesktopWebView(credentialId, { x: 0, y: 0, width: 1280, height: 720 }, "entry", false);
    managed = desktopWebViews.get(state.id);
  }
  if (!managed) throw new Error(tr("本机 Web 页面未能启动"));
  await waitForProtectedDesktopLogin(managed);
  const page = activeDesktopWebPage(managed).view.webContents;
  const deadline = Date.now() + 20_000;
  while (page.isLoading() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const directory = join(app.getPath("temp"), "viron-mcp-web-upload", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = basename(filenameValue.replaceAll("\0", "")) || "upload";
  const path = join(directory, filename);
  await writeFile(path, data, { mode: 0o600, flag: "wx" });
  try {
    page.debugger.attach("1.3");
    const document = await page.debugger.sendCommand("DOM.getDocument") as { root: { nodeId: number } };
    const input = await page.debugger.sendCommand("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector: "input[type=file]:not([disabled])",
    }) as { nodeId: number };
    if (!input.nodeId) throw new Error(tr("当前页面没有可用的文件输入框"));
    await page.debugger.sendCommand("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [path] });
    touchDesktopWebView(managed);
    return { ok: true, filename, view: webViewState(managed) };
  } finally {
    if (page.debugger.isAttached()) page.debugger.detach();
    const timer = setTimeout(() => { void rm(directory, { recursive: true, force: true }); }, 30_000);
    timer.unref();
  }
}

export async function closeDesktopWebView(id: string, reason = tr("用户主动关闭连接")): Promise<void> {
  const managed = desktopWebViews.get(id);
  if (!managed) return;
  if (managed.closing) { await closingProfiles.get(managed.partition); return; }
  closeDesktopWebExtensionPopup(managed.lastUrlKey);
  managed.closedReason = reason;
  sendWebViewState(managed);
  managed.closing = true;
  const login = managed.login;
  login?.dispose();
  managed.login = null;
  closeExtensionBrowser(managed.partition);
  managed.partition.off("will-download", managed.downloadListener);
  const releaseReservation = releaseDesktopRuntimeReservation(managed.registrationId);
  const pending = (async () => {
    try {
      destroyDesktopWebPages(managed);
      await login?.settled();
      await resumeDesktopWebSessionExtensions(managed.partition);
      await releaseDesktopWebSessionExtensions(managed.partition);
      managed.partition.flushStorageData();
      await managed.partition.cookies.flushStore();
    } finally {
      destroyDesktopWebPages(managed);
      managed.password = "";
      try { await releaseReservation; }
      finally { desktopWebViews.delete(id); }
    }
  })();
  closingProfiles.set(managed.partition, pending);
  try { await pending; }
  finally { if (closingProfiles.get(managed.partition) === pending) closingProfiles.delete(managed.partition); }
}

export async function closeAllDesktopWebViews(): Promise<void> {
  const views = [...desktopWebViews.values()];
  await Promise.all(views.map((view) => closeDesktopWebView(view.id)));
  pendingCredentialRequests.clear();
}

export function localWebView(id: string): ManagedDesktopWebView {
  const view = desktopWebViews.get(id);
  if (!view) throw new Error(tr("本机账号页面不存在或已经关闭"));
  return view;
}

export async function handleDesktopWebViewAction(id: string, action: { type: string; url?: string; pageId?: string; orderedPageIds?: string[]; loginInput?: ProtectedLoginInput }): Promise<DesktopWebViewState> {
  const managed = localWebView(id);
  touchDesktopWebView(managed);
  if (action.type === "login-input") {
    if (!managed.login || !action.loginInput) throw new Error("当前没有待完成的验证");
    await managed.login.input(action.loginInput);
    return webViewState(managed);
  }
  if (action.type === "reset") return await resetDesktopWebView(managed);
  if (action.type === "browse") {
    await browseDesktopWebWithoutAutofill(managed);
    return webViewState(managed);
  }
  if (action.type === "refill") {
    const credential = await latestDesktopWebCredential(managed.credentialId);
    const active = managed.pages.get(managed.activePageId);
    applyDesktopWebCredential(managed, credential);
    if (active && !managed.login) fillDirectDesktopPage(managed, active);
    else await startConfiguredDesktopLogin(managed);
    return webViewState(managed);
  }
  if (managed.login) throw new Error("请先完成后台登录");
  if (action.type === "activate-page") {
    if (!action.pageId) throw new Error(tr("请选择要激活的本机页面"));
    activateDesktopWebPage(managed, action.pageId);
    return webViewState(managed);
  }
  if (action.type === "close-page") {
    if (!action.pageId || !managed.pages.has(action.pageId)) throw new Error(tr("要关闭的本机页面不存在"));
    if ([...managed.pages.values()].filter((page) => page.view.kind === "guest").length <= 1) throw new Error(tr("账号至少需要保留一个页面"));
    await removeDesktopWebPage(managed, action.pageId, true);
    return webViewState(managed);
  }
  if (action.type === "new-page") {
    if (managed.pages.size >= DESKTOP_WEB_PAGE_LIMIT) throw new Error(tr("同一账号最多打开 {{0}} 个页面", [DESKTOP_WEB_PAGE_LIMIT]));
    const blankPage = await createDesktopWebPage(managed, false);
    activateDesktopWebPage(managed, blankPage.id);
    return webViewState(managed);
  }
  if (action.type === "reorder-pages") {
    const guestPages = new Map([...managed.pages].filter(([, page]) => page.view.kind === "guest"));
    const reordered = Array.isArray(action.orderedPageIds) ? reorderMap(guestPages, action.orderedPageIds) : null;
    if (!reordered) throw new Error(tr("页面标签排序必须包含当前账号的全部页面"));
    managed.pages = new Map([...reordered, ...[...managed.pages].filter(([, page]) => page.view.kind === "window")]);
    sendWebViewState(managed);
    return webViewState(managed);
  }
  const page = activeDesktopWebPage(managed);
  if (action.type === "zoom-in" || action.type === "zoom-out" || action.type === "zoom-reset") {
    noteDesktopWebZoomTarget(managed.id);
    changeDesktopWebPageZoom(managed, page, action.type === "zoom-in" ? "in" : action.type === "zoom-out" ? "out" : "reset");
    return webViewState(managed);
  }
  const navigation = page.view.webContents.navigationHistory;
  if (action.type === "continue-certificate") {
    if (!resolveDesktopWebCertificateError(page, true)) throw new Error(tr("当前页面没有待确认的证书异常"));
    layoutDesktopWebViewPages(managed, true);
    sendWebViewState(managed);
  } else if (action.type === "back" && navigation.canGoBack()) {
    resolveDesktopWebCertificateError(page, false);
    layoutDesktopWebViewPages(managed);
    navigation.goBack();
  } else if (action.type === "forward" && navigation.canGoForward()) navigation.goForward();
  else if (action.type === "reload") {
    resolveDesktopWebCertificateError(page, false);
    layoutDesktopWebViewPages(managed);
    page.view.webContents.reload();
  }
  else if (action.type === "navigate") {
    const url = typeof action.url === "string" ? normalizeWebAddress(action.url) : null;
    if (!url || !supportedDesktopWebUrl(url)) throw new Error(tr("页面地址只支持 HTTP 或 HTTPS URL"));
    resolveDesktopWebCertificateError(page, false);
    layoutDesktopWebViewPages(managed);
    page.pendingUrl = "";
    page.error = "";
    page.loadingUrl = url;
    void page.view.webContents.loadURL(url).catch((error) => {
      if (page.loadingUrl === url) page.loadingUrl = "";
      page.error = error instanceof Error ? error.message : tr("页面导航失败");
      sendWebViewState(managed);
    });
  } else if (!["back", "forward"].includes(action.type)) throw new Error(tr("不支持的本机页面操作"));
  return webViewState(managed);
}

export interface DesktopWebMutationContext {
  endpoint: string;
  userId: string;
  credentialIds: string[];
  resource: "credential" | "entry" | "environment";
}

export async function desktopWebMutationContext(path: string, method: string): Promise<DesktopWebMutationContext | null> {
  if (!activeEndpoint || !["PUT", "DELETE"].includes(method)) return null;
  const endpoint = activeEndpoint.endpoint;
  const credential = path.match(/^\/api\/v1\/web-credentials\/([0-9a-f-]+)$/i);
  if (credential) {
    const auth = await endpointJson<DesktopAuthContext>("/api/v1/auth/me");
    return { endpoint, userId: auth.user.id, credentialIds: [credential[1]], resource: "credential" };
  }
  const entry = path.match(/^\/api\/v1\/web-entries\/([0-9a-f-]+)$/i);
  if (entry) {
    const credentialIds = method === "PUT"
      ? [...desktopWebViews.values()].filter((view) => view.entryId === entry[1]).map((view) => view.credentialId)
      : (await endpointJson<{ items: Array<{ id: string }> }>(`/api/v1/web-entries/${entry[1]}/credentials`)).items.map((item) => item.id);
    if (!credentialIds.length) return null;
    const auth = await endpointJson<DesktopAuthContext>("/api/v1/auth/me");
    return { endpoint, userId: auth.user.id, credentialIds: [...new Set(credentialIds)], resource: "entry" };
  }
  const environment = method === "DELETE" ? path.match(/^\/api\/v1\/environments\/([0-9a-f-]+)$/i) : null;
  if (environment) {
    const entries = await endpointJson<{ items: Array<{ id: string }> }>(`/api/v1/environments/${environment[1]}/web-entries`);
    const credentials = await Promise.all(entries.items.map((item) => endpointJson<{ items: Array<{ id: string }> }>(`/api/v1/web-entries/${item.id}/credentials`)));
    const credentialIds = credentials.flatMap((response) => response.items.map((item) => item.id));
    if (!credentialIds.length) return null;
    const auth = await endpointJson<DesktopAuthContext>("/api/v1/auth/me");
    return { endpoint, userId: auth.user.id, credentialIds: [...new Set(credentialIds)], resource: "environment" };
  }
  return null;
}

export async function reconcileDesktopWebMutation(context: DesktopWebMutationContext | null, method: string, response: Response): Promise<void> {
  if (!response.ok || !context) return;
  for (const credentialId of context.credentialIds) {
    const lastUrlKey = desktopWebLastUrlKey(context.endpoint, context.userId, credentialId);
    const activeViews = [...desktopWebViews.values()].filter((view) => view.credentialId === credentialId);
    if (method === "PUT" && activeViews.length) {
      await refreshDesktopWebViews(activeViews, context.resource === "entry");
      continue;
    }
    await Promise.all(activeViews.map((view) => closeDesktopWebView(view.id)));
    if (method === "DELETE") {
      forgetDesktopWebLastUrl(lastUrlKey);
      forgetDesktopWebZoom(lastUrlKey);
    }
    const partition = desktopWebSession(context.endpoint, context.userId, credentialId);
    if (method === "DELETE") await forgetDesktopWebExtensions(partition, lastUrlKey);
    await clearDesktopWebSession(partition);
  }
}
