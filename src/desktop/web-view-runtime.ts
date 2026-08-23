import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  app,
  clipboard,
  Menu,
  WebContentsView,
  type NativeImage,
  type Rectangle,
  type Session,
} from "electron";
import {
  DESKTOP_WEB_PAGE_LIMIT,
  desktopWebContextMenuGroups,
  desktopWebLastUrlKey,
  pageAfterClose,
  supportedDesktopPopupUrl,
  supportedDesktopWebUrl,
  type DesktopWebContextMenuAction,
} from "./web-page-policy.js";
import { normalizeWebAddress } from "../shared/web-address.js";
import { reorderMap } from "../shared/tab-order.js";
import { WEB_CREDENTIAL_AUTOFILL_DELAYS_MS } from "../shared/web-credential-autofill.js";
import { immersiveNavigationEscapeAction } from "../shared/immersive-navigation.js";
import { shortcutActionForInput } from "../shared/keyboard-shortcuts.js";
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
import {
  immersiveNavigationState,
  sendImmersiveNavigationAction,
} from "./overlays/immersive-navigation-window.js";
import { mainWindow } from "./window-host.js";
import {
  desktopWebActionScript,
  desktopWebSnapshotScript,
  type DesktopWebSemanticSnapshot,
} from "./web-view-dom-script.js";
import {
  activeDesktopWebPage,
  applyDesktopWebCredential,
  autoFillWebPage,
  cachedDesktopWebUrl,
  clearDesktopWebSession,
  desktopWebPreferences,
  desktopWebSession,
  desktopWebViews,
  forgetDesktopWebLastUrl,
  inspectDesktopWebElement,
  latestDesktopWebCredential,
  notifyWebView,
  rememberDesktopWebLastUrl,
  sendWebViewState,
  touchDesktopWebView,
  trackDesktopWebPartition,
  webViewBounds,
  webViewState,
} from "./web-view-support.js";

export { activeDesktopWebPage, desktopWebViews, inspectDesktopWebElement, webViewBounds, webViewState };

export interface DesktopWebViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopWebInitialPage = "entry" | "blank";

export interface DesktopWebViewState {
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
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  autofillMessage: string;
  error: string;
  closedReason: string;
  notice: {
    id: string;
    type: "success" | "info" | "error";
    message: string;
  } | null;
}

export interface ManagedDesktopWebPage {
  id: string;
  view: WebContentsView;
  allowAutofill: boolean;
  pendingUrl: string;
  autofillSignature: string;
  autofillMessage: string;
  error: string;
  closing: boolean;
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
  pages: Map<string, ManagedDesktopWebPage>;
  activePageId: string;
  bounds: Rectangle;
  visible: boolean;
  previewing: boolean;
  closing: boolean;
  lastActivityAt: number;
  closedReason: string;
  partition: Session;
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
  if (!view.visible) return "";
  return await captureWebContentsPreview(activeDesktopWebPage(view).view.webContents);
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
    if (active) page.view.setBounds(view.bounds);
    page.view.setVisible(active && view.visible);
  }
  if (focus && view.visible) activeDesktopWebPage(view).view.webContents.focus();
}

export function activateDesktopWebPage(view: ManagedDesktopWebView, pageId: string): void {
  const page = view.pages.get(pageId);
  if (!page) throw new Error(tr("本机子页面不存在或已经关闭"));
  view.activePageId = pageId;
  touchDesktopWebView(view);
  layoutDesktopWebViewPages(view, true);
  const pendingUrl = page.pendingUrl;
  rememberDesktopWebLastUrl(view, pendingUrl || page.view.webContents.getURL());
  if (pendingUrl) {
    page.pendingUrl = "";
    void page.view.webContents.loadURL(pendingUrl).catch((error) => {
      page.error = error instanceof Error ? error.message : tr("本机页面加载失败");
      sendWebViewState(view);
    });
  }
  sendWebViewState(view);
}

export function removeDesktopWebPage(view: ManagedDesktopWebView, pageId: string, closeContents: boolean): void {
  const page = view.pages.get(pageId);
  if (!page) return;
  const nextPageId = pageAfterClose([...view.pages.keys()], view.activePageId, pageId);
  page.closing = closeContents;
  view.pages.delete(pageId);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(page.view);
  if (closeContents && !page.view.webContents.isDestroyed()) page.view.webContents.close();
  if (view.closing) return;
  if (nextPageId) {
    activateDesktopWebPage(view, nextPageId);
    return;
  }
  const replacement = createDesktopWebPage(view, true);
  activateDesktopWebPage(view, replacement.id);
  void replacement.view.webContents.loadURL(view.entryUrl).catch((error) => {
    replacement.error = error instanceof Error ? error.message : tr("本机页面加载失败");
    sendWebViewState(view);
  });
}

export function destroyDesktopWebPages(view: ManagedDesktopWebView): void {
  for (const page of view.pages.values()) {
    page.closing = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }
  view.pages.clear();
  view.activePageId = "";
}

export function openDesktopWebLinkInNewPage(view: ManagedDesktopWebView, url: string): void {
  if (!supportedDesktopWebUrl(url)) return;
  if (view.pages.size >= DESKTOP_WEB_PAGE_LIMIT) {
    notifyWebView(view, "error", tr("同一账号最多打开 {{0}} 个页面", [DESKTOP_WEB_PAGE_LIMIT]));
    return;
  }
  const page = createDesktopWebPage(view, false);
  page.pendingUrl = url;
  activateDesktopWebPage(view, page.id);
}

export function desktopWebContextMenuItem(
  view: ManagedDesktopWebView,
  webContents: Electron.WebContents,
  params: Electron.ContextMenuParams,
  action: DesktopWebContextMenuAction,
): Electron.MenuItemConstructorOptions {
  const navigation = webContents.navigationHistory;
  switch (action) {
    case "open-link-new-page": return { label: tr("在新标签页中打开链接"), click: () => openDesktopWebLinkInNewPage(view, params.linkURL) };
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

export function createDesktopWebPage(
  view: ManagedDesktopWebView,
  allowAutofill: boolean,
  adoptedWebContents?: Electron.WebContents,
): ManagedDesktopWebPage {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const nativeView = new WebContentsView(adoptedWebContents
    ? { webContents: adoptedWebContents }
    : { webPreferences: desktopWebPreferences(view.partition) });
  nativeView.setBackgroundColor("#ffffff");
  nativeView.webContents.setBackgroundThrottling(!view.previewing);
  nativeView.setBounds(view.bounds);
  nativeView.setVisible(false);
  const page: ManagedDesktopWebPage = {
    id: randomUUID(),
    view: nativeView,
    allowAutofill,
    pendingUrl: "",
    autofillSignature: "",
    autofillMessage: "",
    error: "",
    closing: false,
  };
  view.pages.set(page.id, page);
  mainWindow.contentView.addChildView(nativeView);
  nativeView.webContents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type !== "mouseDown") return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("viron:native-view-pointer-down");
    sendToAgentChat("viron:native-view-pointer-down");
  });
  nativeView.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed() || nativeView.webContents.isDestroyed()) return;
    const groups = desktopWebContextMenuGroups({
      linkUrl: params.linkURL,
      isEditable: params.isEditable,
      hasSelection: Boolean(params.selectionText),
    });
    const template = groups.flatMap((group, index) => [
      ...(index > 0 ? [{ type: "separator" as const }] : []),
      ...group.map((action) => desktopWebContextMenuItem(view, nativeView.webContents, params, action)),
    ]);
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
  nativeView.webContents.on("before-input-event", (event, input) => {
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
    if (view.pages.size >= DESKTOP_WEB_PAGE_LIMIT) {
      page.autofillMessage = tr("同一账号最多打开 {{0}} 个页面", [DESKTOP_WEB_PAGE_LIMIT]);
      sendWebViewState(view);
      return { action: "deny" };
    }
    return {
      action: "allow",
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: desktopWebPreferences(view.partition) },
      createWindow: (options) => {
        const popup = createDesktopWebPage(
          view,
          false,
          (options as Electron.WebContentsViewConstructorOptions).webContents,
        );
        activateDesktopWebPage(view, popup.id);
        return popup.view.webContents;
      },
    };
  });
  nativeView.webContents.on("will-navigate", (event, url) => {
    if (!supportedDesktopPopupUrl(url)) event.preventDefault();
  });
  nativeView.webContents.on("did-start-loading", () => { touchDesktopWebView(view); sendWebViewState(view); });
  nativeView.webContents.on("did-stop-loading", () => { touchDesktopWebView(view); sendWebViewState(view); });
  nativeView.webContents.on("page-title-updated", () => sendWebViewState(view));
  nativeView.webContents.on("did-navigate", (_event, url) => {
    if (view.activePageId === page.id) rememberDesktopWebLastUrl(view, url);
    sendWebViewState(view);
  });
  nativeView.webContents.on("did-navigate-in-page", (_event, url) => {
    if (view.activePageId === page.id) rememberDesktopWebLastUrl(view, url);
    sendWebViewState(view);
  });
  nativeView.webContents.on("dom-ready", () => {
    if (!page.allowAutofill) return;
    for (const delay of WEB_CREDENTIAL_AUTOFILL_DELAYS_MS) {
      const timer = setTimeout(() => void autoFillWebPage(view, page), delay);
      timer.unref();
    }
  });
  nativeView.webContents.on("render-process-gone", (_event, details) => {
    page.error = tr("本机页面进程已退出（{{0}}）", [details.reason]);
    sendWebViewState(view);
  });
  nativeView.webContents.on("destroyed", () => {
    if (!view.closing && !page.closing) removeDesktopWebPage(view, page.id, false);
  });
  return page;
}

export async function reopenDesktopWebViews(views: ManagedDesktopWebView[], credential: DesktopWebCredential): Promise<void> {
  await Promise.all(views.map(async (view) => {
    applyDesktopWebCredential(view, credential);
    destroyDesktopWebPages(view);
    const page = createDesktopWebPage(view, true);
    activateDesktopWebPage(view, page.id);
    await page.view.webContents.loadURL(view.entryUrl);
  }));
}

export async function refreshDesktopWebViews(views: ManagedDesktopWebView[], reopen: boolean): Promise<void> {
  const first = views[0];
  if (!first) return;
  const credential = await latestDesktopWebCredential(first.credentialId);
  if (reopen) await reopenDesktopWebViews(views, credential);
  else for (const view of views) applyDesktopWebCredential(view, credential);
}

export async function resetDesktopWebViews(views: ManagedDesktopWebView[]): Promise<void> {
  const first = views[0];
  if (!first) return;
  const credential = await latestDesktopWebCredential(first.credentialId);
  forgetDesktopWebLastUrl(first.lastUrlKey);
  for (const view of views) view.lastUrl = "";
  for (const view of views) destroyDesktopWebPages(view);
  try {
    await clearDesktopWebSession(first.partition);
  } catch (error) {
    await reopenDesktopWebViews(views, credential);
    throw error;
  }
  await reopenDesktopWebViews(views, credential);
  for (const view of views) notifyWebView(view, "success", tr("已清除本机登录状态并重新打开账号页面"));
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
  if (desktopWebViews.size >= 8) throw new Error(tr("本机最多同时打开 8 个账号页面，请先关闭一个页面"));
  const { auth, credential } = await localWebCredential(credentialId);
  if (!supportedDesktopWebUrl(credential.entryUrl)) throw new Error(tr("Web 入口地址只支持 HTTP 或 HTTPS"));
  const endpoint = activeEndpoint?.endpoint;
  if (!endpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  const registrationId = await reserveDesktopRuntime("web", credentialId, undefined, originEnvironmentId);
  const id = randomUUID();
  const webPartition = desktopWebSession(endpoint, auth.user.id, credential.credentialId);
  const lastUrlKey = desktopWebLastUrlKey(endpoint, auth.user.id, credential.credentialId);
  const initialUrl = cachedDesktopWebUrl(credential.entryUrl, lastUrlKey);
  const managed: ManagedDesktopWebView = {
    id,
    registrationId,
    credentialId,
    entryId: credential.entryId,
    entryUrl: credential.entryUrl,
    entryOrigin: new URL(credential.entryUrl).origin,
    username: credential.username,
    password: credential.password,
    pages: new Map(),
    activePageId: "",
    bounds: webViewBounds(bounds),
    visible,
    previewing: false,
    closing: false,
    lastActivityAt: Date.now(),
    closedReason: "",
    partition: webPartition,
    lastUrlKey,
    lastUrl: "",
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
    const page = createDesktopWebPage(managed, true);
    activateDesktopWebPage(managed, page.id);
    trackDesktopRuntime({
      id: registrationId,
      localId: id,
      activity: () => desktopWebViews.get(id)?.lastActivityAt ?? null,
      close: (reason) => closeDesktopWebView(id, reason),
    });
    if (initialPage === "entry") {
      void page.view.webContents.loadURL(initialUrl).catch((error) => {
        page.error = error instanceof Error ? error.message : tr("本机页面加载失败");
        sendWebViewState(managed);
      });
    } else {
      page.pendingUrl = initialUrl;
      const blankPage = createDesktopWebPage(managed, false);
      activateDesktopWebPage(managed, blankPage.id);
    }
    return webViewState(managed);
  } catch (error) {
    desktopWebViews.delete(id);
    await releaseDesktopRuntimeReservation(registrationId);
    throw error;
  }
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
  managed.closedReason = reason;
  sendWebViewState(managed);
  managed.closing = true;
  desktopWebViews.delete(id);
  managed.partition.off("will-download", managed.downloadListener);
  const releaseReservation = releaseDesktopRuntimeReservation(managed.registrationId);
  try {
    managed.partition.flushStorageData();
    await managed.partition.cookies.flushStore();
  } finally {
    destroyDesktopWebPages(managed);
    managed.password = "";
    await releaseReservation;
  }
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

export async function handleDesktopWebViewAction(id: string, action: { type: string; url?: string; pageId?: string; orderedPageIds?: string[] }): Promise<DesktopWebViewState> {
  const managed = localWebView(id);
  touchDesktopWebView(managed);
  if (action.type === "activate-page") {
    if (!action.pageId) throw new Error(tr("请选择要激活的本机页面"));
    activateDesktopWebPage(managed, action.pageId);
    return webViewState(managed);
  }
  if (action.type === "close-page") {
    if (!action.pageId || !managed.pages.has(action.pageId)) throw new Error(tr("要关闭的本机页面不存在"));
    if (managed.pages.size <= 1) throw new Error(tr("账号至少需要保留一个页面"));
    removeDesktopWebPage(managed, action.pageId, true);
    return webViewState(managed);
  }
  if (action.type === "new-page") {
    if (managed.pages.size >= DESKTOP_WEB_PAGE_LIMIT) throw new Error(tr("同一账号最多打开 {{0}} 个页面", [DESKTOP_WEB_PAGE_LIMIT]));
    const blankPage = createDesktopWebPage(managed, false);
    activateDesktopWebPage(managed, blankPage.id);
    return webViewState(managed);
  }
  if (action.type === "reorder-pages") {
    const reordered = Array.isArray(action.orderedPageIds) ? reorderMap(managed.pages, action.orderedPageIds) : null;
    if (!reordered) throw new Error(tr("页面标签排序必须包含当前账号的全部页面"));
    managed.pages = reordered;
    sendWebViewState(managed);
    return webViewState(managed);
  }
  if (action.type === "reset") return await resetDesktopWebView(managed);
  const page = activeDesktopWebPage(managed);
  const navigation = page.view.webContents.navigationHistory;
  if (action.type === "back" && navigation.canGoBack()) navigation.goBack();
  else if (action.type === "forward" && navigation.canGoForward()) navigation.goForward();
  else if (action.type === "reload") page.view.webContents.reload();
  else if (action.type === "navigate") {
    const url = typeof action.url === "string" ? normalizeWebAddress(action.url) : null;
    if (!url || !supportedDesktopWebUrl(url)) throw new Error(tr("页面地址只支持 HTTP 或 HTTPS URL"));
    page.pendingUrl = "";
    page.error = "";
    void page.view.webContents.loadURL(url).catch((error) => {
      page.error = error instanceof Error ? error.message : tr("页面导航失败");
      sendWebViewState(managed);
    });
  } else if (action.type === "refill") {
    await autoFillWebPage(managed, page, true);
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
    if (method === "DELETE") forgetDesktopWebLastUrl(lastUrlKey);
    await clearDesktopWebSession(desktopWebSession(context.endpoint, context.userId, credentialId));
  }
}
