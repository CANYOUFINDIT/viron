import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { session, type Rectangle, type Session } from "electron";
import type * as Electron from "electron";
import {
  cacheableDesktopWebUrl,
  deceptiveChromeWebStoreUrl,
  desktopWebLastUrlKey,
  desktopWebPartitionName,
  restorableDesktopWebUrl,
  supportedDesktopWebUrl,
} from "./web-page-policy.js";
import { defaultWebLoginConfig } from "../shared/protected-web-login.js";
import { readState, writeState } from "./app-state.js";
import type { DesktopWebCredential } from "./device-identity.js";
import { localWebCredential } from "./execution-router.js";
import { translate as tr } from "./i18n.js";
import { mainWindow } from "./window-host.js";
import {
  desktopWebZoomStorageKey,
  pageZoomFactor,
  pageZoomOrigin,
  stepPageZoom,
  type PageZoomCommand,
} from "../shared/page-zoom.js";
import { resolveWebViewBounds } from "./web-view-bounds.js";
import { registerDesktopWebExtensionWorkerMenus } from "./web-extension-context-menus.js";
import { installedWebExtensions } from "./web-extension-catalog.js";
import { installDesktopPublicWebAssets } from "./public-web-assets.js";
import type {
  DesktopWebViewBounds,
  DesktopWebViewState,
  ManagedDesktopWebPage,
  ManagedDesktopWebView,
} from "./web-view-runtime.js";

export const desktopWebViews = new Map<string, ManagedDesktopWebView>();
const trackedWebPartitions = new WeakSet<Session>();
const extensionCompatSessions = new WeakSet<Session>();

export function cachedDesktopWebUrl(entryUrl: string, key: string): string {
  return restorableDesktopWebUrl(entryUrl, readState().webLastUrls?.[key]);
}
export function rememberDesktopWebLastUrl(view: ManagedDesktopWebView, value: string): void {
  const url = cacheableDesktopWebUrl(view.entryUrl, value);
  if (!url || view.lastUrl === url) return;
  view.lastUrl = url;
  const state = readState();
  if (state.webLastUrls?.[view.lastUrlKey] === url) return;
  writeState({
    ...state,
    webLastUrls: { ...state.webLastUrls, [view.lastUrlKey]: url },
  });
}

export function forgetDesktopWebLastUrl(key: string): void {
  const state = readState();
  if (!state.webLastUrls || !(key in state.webLastUrls)) return;
  const webLastUrls = { ...state.webLastUrls };
  delete webLastUrls[key];
  if (Object.keys(webLastUrls).length) state.webLastUrls = webLastUrls;
  else delete state.webLastUrls;
  writeState(state);
}

export function rememberedDesktopWebZoom(scope: string, origin: string): number {
  const stored = readState().webZoomFactors?.[desktopWebZoomStorageKey(scope, origin)];
  return typeof stored === "number" ? pageZoomFactor(stored) : 1;
}

export function rememberDesktopWebZoom(scope: string, origin: string, factor: number): void {
  const key = desktopWebZoomStorageKey(scope, origin);
  const normalized = pageZoomFactor(factor);
  const state = readState();
  const current = state.webZoomFactors?.[key];
  if (normalized === 1) {
    if (current === undefined) return;
    const webZoomFactors = { ...state.webZoomFactors };
    delete webZoomFactors[key];
    if (Object.keys(webZoomFactors).length) state.webZoomFactors = webZoomFactors;
    else delete state.webZoomFactors;
    writeState(state);
    return;
  }
  if (current === normalized) return;
  state.webZoomFactors = { ...state.webZoomFactors, [key]: normalized };
  writeState(state);
}

export function forgetDesktopWebZoom(scope: string): void {
  const state = readState();
  if (!state.webZoomFactors) return;
  const prefix = `${scope}\n`;
  const entries = Object.entries(state.webZoomFactors).filter(([key]) => !key.startsWith(prefix));
  if (entries.length === Object.keys(state.webZoomFactors).length) return;
  if (entries.length) state.webZoomFactors = Object.fromEntries(entries);
  else delete state.webZoomFactors;
  writeState(state);
}

let applyingDesktopWebPageZoom = false;

function writeWebContentsZoom(page: ManagedDesktopWebPage, factor: number): void {
  page.zoomFactor = factor;
  const contents = page.view.webContents;
  if (contents.isDestroyed()) return;
  if (Math.abs(contents.getZoomFactor() - factor) <= 0.001) return;
  contents.setZoomFactor(factor);
}

export function applyDesktopWebPageZoom(
  view: ManagedDesktopWebView,
  page: ManagedDesktopWebPage,
  factor: number,
  options: { persist?: boolean; notify?: boolean } = {},
): void {
  if (applyingDesktopWebPageZoom) return;
  const next = pageZoomFactor(factor);
  const contents = page.view.webContents;
  const contentsDiffer = !contents.isDestroyed() && Math.abs(contents.getZoomFactor() - next) > 0.001;
  const changed = page.zoomFactor !== next || contentsDiffer;
  applyingDesktopWebPageZoom = true;
  try {
    if (changed) writeWebContentsZoom(page, next);
    if (options.persist) {
      const url = contents.isDestroyed() ? page.pendingUrl : (contents.getURL() || page.pendingUrl);
      const origin = pageZoomOrigin(url);
      if (origin) {
        rememberDesktopWebZoom(view.lastUrlKey, origin, next);
        for (const other of view.pages.values()) {
          if (other.id === page.id || other.view.webContents.isDestroyed()) continue;
          const otherOrigin = pageZoomOrigin(other.view.webContents.getURL() || other.pendingUrl);
          if (otherOrigin === origin) writeWebContentsZoom(other, next);
        }
      }
    }
  } finally {
    applyingDesktopWebPageZoom = false;
  }
  if (options.notify !== false && changed) sendWebViewState(view);
}

export function restoreDesktopWebPageZoom(view: ManagedDesktopWebView, page: ManagedDesktopWebPage, url: string): void {
  const origin = pageZoomOrigin(url);
  if (!origin) return;
  applyDesktopWebPageZoom(view, page, rememberedDesktopWebZoom(view.lastUrlKey, origin), { persist: false, notify: false });
}

export function changeDesktopWebPageZoom(view: ManagedDesktopWebView, page: ManagedDesktopWebPage, command: PageZoomCommand): void {
  const current = pageZoomFactor(page.zoomFactor || 1);
  const next = stepPageZoom(current, command);
  if (next === current) return;
  applyDesktopWebPageZoom(view, page, next, { persist: true });
}

export function desktopWebSession(endpoint: string, userId: string, credentialId: string): Session {
  const webPartition = session.fromPartition(desktopWebPartitionName(endpoint, userId, credentialId));
  installDesktopPublicWebAssets(webPartition, endpoint, userId);
  enableDesktopWebSessionExtensions(webPartition, desktopWebLastUrlKey(endpoint, userId, credentialId));
  webPartition.setPermissionCheckHandler(() => false);
  webPartition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  return webPartition;
}

export function enableDesktopWebSessionExtensions(webPartition: Session, scope: string): void {
  if (!extensionCompatSessions.has(webPartition)) {
    const preload = fileURLToPath(new URL("./web-extension-compat-preload.cjs", import.meta.url));
    webPartition.registerPreloadScript({ type: "frame", filePath: preload });
    webPartition.registerPreloadScript({ type: "service-worker", filePath: preload });
    registerDesktopWebExtensionWorkerMenus(webPartition, scope);
    extensionCompatSessions.add(webPartition);
  }
}

export function webViewBounds(input: DesktopWebViewBounds): Rectangle {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const bounds = resolveWebViewBounds(input, mainWindow.getContentBounds());
  if (!bounds) throw new Error(tr("本机页面区域无效"));
  return bounds;
}

export function webViewState(view: ManagedDesktopWebView): DesktopWebViewState {
  const active = view.pages.get(view.activePageId);
  if (!active) {
    if (!view.login) throw new Error(tr("本机账号当前没有可用页面"));
    return { loginMode: view.loginConfig.mode, id: view.id, credentialId: view.credentialId, activePageId: "", pages: [], url: view.entryUrl, title: view.username,
      faviconDataUrl: "", loading: view.login.state.pageLoading === true, canGoBack: false, canGoForward: false,
      autofillMessage: "", error: "", certificateError: null, closedReason: view.closedReason, notice: view.notice,
      zoomFactor: 1, protectedLogin: { ...view.login.state }, loginNotice: view.loginNotice };
  }
  const navigation = active.view.webContents.navigationHistory;
  return {
    loginMode: view.loginConfig.mode,
    id: view.id,
    credentialId: view.credentialId,
    activePageId: active.id,
    pages: [...view.pages.values()].filter((page) => page.view.kind === "guest").map((page) => ({
      id: page.id,
      url: page.pendingUrl || page.loadingUrl || page.view.webContents.getURL() || (page.allowAutofill ? view.entryUrl : "about:blank"),
      title: page.view.webContents.getTitle() || (page.allowAutofill ? view.username : tr("新页面")),
      loading: page.view.webContents.isLoading(),
    })),
    url: active.pendingUrl || active.loadingUrl || active.view.webContents.getURL() || (active.allowAutofill ? view.entryUrl : "about:blank"),
    title: active.view.webContents.getTitle() || (active.allowAutofill ? view.username : tr("新页面")),
    faviconDataUrl: active.faviconDataUrl,
    loading: active.view.webContents.isLoading(),
    canGoBack: navigation.canGoBack(),
    canGoForward: navigation.canGoForward(),
    autofillMessage: active.autofillMessage,
    error: active.error,
    certificateError: active.certificateError
      ? { url: active.certificateError.url, error: active.certificateError.error }
      : null,
    closedReason: view.closedReason,
    notice: view.notice,
    zoomFactor: pageZoomFactor(active.zoomFactor || 1),
    protectedLogin: view.login ? { ...view.login.state } : null,
    loginNotice: view.loginNotice,
  };
}


export function touchDesktopWebView(view: ManagedDesktopWebView): void {
  view.lastActivityAt = Date.now();
}

export function trackDesktopWebPartition(partition: Session): void {
  if (trackedWebPartitions.has(partition)) return;
  trackedWebPartitions.add(partition);
  partition.webRequest.onBeforeRequest((details, callback) => {
    if (deceptiveChromeWebStoreUrl(details.url)) return callback({ cancel: true });
    for (const view of desktopWebViews.values()) {
      if (view.partition === partition && !view.closing && [...view.pages.values()].some((page) => page.view.webContents.id === details.webContentsId)) {
        touchDesktopWebView(view);
      }
    }
    callback({});
  });
}

export function sendWebViewState(view: ManagedDesktopWebView): void {
  if (!mainWindow || mainWindow.isDestroyed() || view.closing || !desktopWebViews.has(view.id) || (!view.login && !view.pages.has(view.activePageId))) return;
  mainWindow.webContents.send("viron:web-view-state", webViewState(view));
}

export function notifyWebView(view: ManagedDesktopWebView, type: "success" | "info" | "error", message: string): void {
  view.notice = { id: randomUUID(), type, message };
  sendWebViewState(view);
}

export function activeDesktopWebPage(view: ManagedDesktopWebView): ManagedDesktopWebPage {
  const page = view.pages.get(view.activePageId);
  if (!page) throw new Error(tr("本机账号当前没有可用页面"));
  return page;
}


export function desktopWebPreferences(partition: Session): Electron.WebPreferences {
  return {
    session: partition,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  };
}

export function inspectDesktopWebElement(webContents: Electron.WebContents, x: number, y: number): void {
  if (webContents.isDestroyed()) return;
  if ([...desktopWebViews.values()].some((view) => view.loginConfig.mode === "locked" && [...view.pages.values()].some((page) => page.view.webContents === webContents))) return;
  webContents.openDevTools({ mode: "detach", title: tr("Viron 网页检查器") });
  webContents.inspectElement(x, y);
}


export async function clearDesktopWebSession(partition: Session): Promise<void> {
  await partition.closeAllConnections();
  // Reset websites while keeping extension preferences and first-install markers.
  const excludeOrigins = [...new Set([
    ...partition.extensions.getAllExtensions().map((extension) => extension.id),
    ...installedWebExtensions().map((extension) => extension.extensionId),
  ])].map((id) => `chrome-extension://${id}`);
  await partition.clearData({ excludeOrigins });
}

export async function latestDesktopWebCredential(credentialId: string): Promise<DesktopWebCredential> {
  const { credential } = await localWebCredential(credentialId);
  if (!supportedDesktopWebUrl(credential.entryUrl)) throw new Error(tr("Web 入口地址只支持 HTTP 或 HTTPS"));
  return credential;
}

export function applyDesktopWebCredential(view: ManagedDesktopWebView, credential: DesktopWebCredential): void {
  view.entryId = credential.entryId;
  view.entryUrl = credential.entryUrl;
  view.entryOrigin = new URL(credential.entryUrl).origin;
  view.username = credential.username;
  view.password = credential.password;
  view.loginConfig = credential.loginConfig ?? defaultWebLoginConfig();
  view.lastUrl = cacheableDesktopWebUrl(view.entryUrl, view.lastUrl) ?? "";
}
