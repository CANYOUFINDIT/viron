import { randomUUID } from "node:crypto";
import { session, type Rectangle, type Session } from "electron";
import type * as Electron from "electron";
import {
  cacheableDesktopWebUrl,
  desktopWebPartitionName,
  restorableDesktopWebUrl,
  shouldAttemptDesktopWebAutofill,
  supportedDesktopWebUrl,
} from "./web-page-policy.js";
import {
  buildWebCredentialAutofillScript,
  type WebCredentialAutofillResult,
} from "../shared/web-credential-autofill.js";
import { readState, writeState } from "./app-state.js";
import type { DesktopWebCredential } from "./device-identity.js";
import { localWebCredential } from "./execution-router.js";
import { translate as tr } from "./i18n.js";
import { mainWindow } from "./window-host.js";
import type {
  DesktopWebViewBounds,
  DesktopWebViewState,
  ManagedDesktopWebPage,
  ManagedDesktopWebView,
} from "./web-view-runtime.js";

export const desktopWebViews = new Map<string, ManagedDesktopWebView>();
const trackedWebPartitions = new WeakSet<Session>();

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

export function desktopWebSession(endpoint: string, userId: string, credentialId: string): Session {
  const webPartition = session.fromPartition(desktopWebPartitionName(endpoint, userId, credentialId));
  webPartition.setPermissionCheckHandler(() => false);
  webPartition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  return webPartition;
}

export function webViewBounds(input: DesktopWebViewBounds): Rectangle {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const content = mainWindow.getContentBounds();
  const x = Math.max(0, Math.min(content.width - 1, Math.round(input.x)));
  const y = Math.max(0, Math.min(content.height - 1, Math.round(input.y)));
  const width = Math.max(1, Math.min(content.width - x, Math.round(input.width)));
  const height = Math.max(1, Math.min(content.height - y, Math.round(input.height)));
  if (![x, y, width, height].every(Number.isFinite)) throw new Error(tr("本机页面区域无效"));
  return { x, y, width, height };
}

export function webViewState(view: ManagedDesktopWebView): DesktopWebViewState {
  const active = view.pages.get(view.activePageId);
  if (!active) throw new Error(tr("本机账号当前没有可用页面"));
  const navigation = active.view.webContents.navigationHistory;
  return {
    id: view.id,
    credentialId: view.credentialId,
    activePageId: active.id,
    pages: [...view.pages.values()].map((page) => ({
      id: page.id,
      url: page.pendingUrl || page.view.webContents.getURL() || (page.allowAutofill ? view.entryUrl : "about:blank"),
      title: page.view.webContents.getTitle() || (page.allowAutofill ? view.username : tr("新页面")),
      loading: page.view.webContents.isLoading(),
    })),
    url: active.pendingUrl || active.view.webContents.getURL() || (active.allowAutofill ? view.entryUrl : "about:blank"),
    title: active.view.webContents.getTitle() || (active.allowAutofill ? view.username : tr("新页面")),
    loading: active.view.webContents.isLoading(),
    canGoBack: navigation.canGoBack(),
    canGoForward: navigation.canGoForward(),
    autofillMessage: active.autofillMessage,
    error: active.error,
    closedReason: view.closedReason,
    notice: view.notice,
  };
}


export function touchDesktopWebView(view: ManagedDesktopWebView): void {
  view.lastActivityAt = Date.now();
}

export function trackDesktopWebPartition(partition: Session): void {
  if (trackedWebPartitions.has(partition)) return;
  trackedWebPartitions.add(partition);
  partition.webRequest.onBeforeRequest((_details, callback) => {
    for (const view of desktopWebViews.values()) {
      if (view.partition === partition && !view.closing) touchDesktopWebView(view);
    }
    callback({});
  });
}

export function sendWebViewState(view: ManagedDesktopWebView): void {
  if (!mainWindow || mainWindow.isDestroyed() || view.closing || !desktopWebViews.has(view.id) || !view.pages.has(view.activePageId)) return;
  mainWindow.webContents.send("viron:web-view-state", webViewState(view));
}

export function notifyWebView(view: ManagedDesktopWebView, type: "success" | "info" | "error", message: string): void {
  view.notice = { id: randomUUID(), type, message };
  sendWebViewState(view);
}

export async function autoFillWebPage(view: ManagedDesktopWebView, page: ManagedDesktopWebPage, force = false): Promise<void> {
  if (page.view.webContents.isDestroyed()) return;
  if (!shouldAttemptDesktopWebAutofill(page.allowAutofill, force)) return;
  try {
    const currentUrl = page.view.webContents.getURL();
    if (!currentUrl || new URL(currentUrl).origin !== view.entryOrigin) {
      page.autofillMessage = force ? tr("当前页面不在入口原始域名，未填充账号密码") : "";
      sendWebViewState(view);
      return;
    }
    const result = await page.view.webContents.executeJavaScript(
      buildWebCredentialAutofillScript({
        username: view.username,
        password: view.password,
        previousSignature: force ? "" : page.autofillSignature,
        autoSubmit: false,
        messages: {
          duplicate: tr("登录表单未变化"),
          ambiguousPasswords: tr("检测到多个密码框，未识别到唯一登录密码框"),
          noReliableForm: tr("未识别到可靠的登录表单"),
          filled: tr("已在当前页面填充账号密码"),
          filledAndSubmitted: tr("已在当前页面填充账号密码"),
        },
      }),
      true,
    ) as WebCredentialAutofillResult;
    page.autofillSignature = result.signature;
    page.autofillMessage = result.status === "duplicate" ? "" : result.message;
    sendWebViewState(view);
  } catch (error) {
    page.error = error instanceof Error ? error.message : tr("自动填充失败");
    sendWebViewState(view);
  }
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
  webContents.openDevTools({ mode: "detach", title: tr("Viron 网页检查器") });
  webContents.inspectElement(x, y);
}


export async function clearDesktopWebSession(partition: Session): Promise<void> {
  await partition.closeAllConnections();
  await partition.clearData();
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
  view.lastUrl = cacheableDesktopWebUrl(view.entryUrl, view.lastUrl) ?? "";
}
