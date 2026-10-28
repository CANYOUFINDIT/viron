import { app, BrowserWindow, ipcMain, WebContentsView, type BrowserWindowConstructorOptions, type Rectangle, type WebContents } from "electron";
import { join } from "node:path";
import { normalizeWebAddress } from "../shared/web-address.js";
import {
  DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT,
  type DesktopWebPopupAction,
  type DesktopWebPopupState,
} from "../shared/web-popup.js";
import { translate as tr } from "./i18n.js";

interface DesktopWebPopup {
  window: BrowserWindow;
  target: WebContents;
  view: WebContentsView;
  closing: boolean;
}

const popups = new Map<number, DesktopWebPopup>();
let ipcRegistered = false;

function popupFor(sender: WebContents): DesktopWebPopup | undefined {
  const popup = popups.get(sender.id);
  return popup && !popup.closing && !popup.window.isDestroyed() && !popup.target.isDestroyed() ? popup : undefined;
}

function popupState(popup: DesktopWebPopup): DesktopWebPopupState {
  const { target } = popup;
  if (target.isDestroyed()) {
    return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, secure: false };
  }
  try {
    const url = target.getURL();
    return {
      url,
      title: target.getTitle(),
      loading: target.isLoading(),
      canGoBack: target.navigationHistory.canGoBack(),
      canGoForward: target.navigationHistory.canGoForward(),
      secure: url.startsWith("https://"),
    };
  } catch {
    return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, secure: false };
  }
}

function closeTarget(target: WebContents): void {
  if (target.isDestroyed()) return;
  try {
    target.close({ waitForBeforeUnload: false });
  } catch {
    // The page may have been destroyed while the window was closing.
  }
}

function publish(popup: DesktopWebPopup): void {
  if (popup.closing || popup.window.isDestroyed() || popup.window.webContents.isDestroyed()) return;
  const state = popupState(popup);
  try {
    popup.window.webContents.send("viron:web-popup:state", state);
  } catch {
    return;
  }
  const title = state.title.trim() || state.url;
  if (!title) return;
  try {
    if (popup.window.getTitle() !== title) popup.window.setTitle(title);
  } catch {
    // The window may have been destroyed between the state update and title change.
  }
}

function readAction(value: unknown): DesktopWebPopupAction | null {
  if (!value || typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "back":
    case "forward":
    case "reload":
    case "stop":
    case "close":
      return { type: action.type };
    case "navigate":
      return typeof action.url === "string" ? { type: "navigate", url: action.url } : null;
    default:
      return null;
  }
}

function registerPopupIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("viron:web-popup:get-state", (event) => {
    const popup = popupFor(event.sender);
    if (!popup) throw new Error(tr("网页窗口已关闭"));
    return popupState(popup);
  });
  ipcMain.handle("viron:web-popup:action", async (event, value: unknown) => {
    const popup = popupFor(event.sender);
    if (!popup) throw new Error(tr("网页窗口已关闭"));
    const action = readAction(value);
    if (!action) throw new Error(tr("无效的网页窗口操作"));
    const { target } = popup;
    switch (action.type) {
      case "back":
        if (target.navigationHistory.canGoBack()) target.navigationHistory.goBack();
        break;
      case "forward":
        if (target.navigationHistory.canGoForward()) target.navigationHistory.goForward();
        break;
      case "reload":
        target.reload();
        break;
      case "stop":
        target.stop();
        break;
      case "navigate": {
        const url = normalizeWebAddress(action.url);
        if (!url) throw new Error(tr("请输入有效的网址"));
        await target.loadURL(url);
        target.focus();
        break;
      }
      case "close":
        popup.window.close();
        break;
    }
    publish(popup);
  });
}

function popupShellOptions(options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
  const width = Math.max(480, Math.round(Number(options.width) || 1000));
  const height = Math.max(360, Math.round(Number(options.height) || 720)) + DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT;
  const windowOptions = { ...options } as BrowserWindowConstructorOptions & { webContents?: unknown };
  // Electron passes the popup's WebContents in the window options. Passing it
  // to the shell constructor would attach it to the shell's own page.
  delete windowOptions.webContents;
  return {
    ...windowOptions,
    width,
    height,
    minWidth: 480,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f7f6",
    title: "Viron",
    ...(Number.isFinite(options.x) ? { x: options.x } : {}),
    ...(Number.isFinite(options.y) ? { y: options.y } : {}),
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "desktop", "web-popup-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  };
}

export interface DesktopWebPopupWindow {
  window: BrowserWindow;
  target: WebContents;
  pageBounds: () => Rectangle;
  dispose: () => void;
}

export function createDesktopWebPopupWindow(
  target: WebContents,
  options: BrowserWindowConstructorOptions,
  show: boolean,
  targetView?: WebContentsView,
): DesktopWebPopupWindow {
  registerPopupIpc();
  const shouldShow = show && options.show !== false;
  const popupWindow = new BrowserWindow(popupShellOptions(options));
  const shellContentsId = popupWindow.webContents.id;
  popupWindow.setMenuBarVisibility(false);
  popupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popupWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  const view = targetView ?? new WebContentsView({ webContents: target });
  view.setBackgroundColor("#ffffff");
  popupWindow.contentView.addChildView(view);

  const popup: DesktopWebPopup = { window: popupWindow, target, view, closing: false };

  const layout = () => {
    if (popupWindow.isDestroyed() || target.isDestroyed() || popup.closing) return;
    const [width, height] = popupWindow.getContentSize();
    view.setBounds({
      x: 0,
      y: DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT),
    });
    view.setVisible(true);
  };
  layout();
  popupWindow.on("resize", layout);
  popupWindow.on("maximize", layout);
  popupWindow.on("unmaximize", layout);
  popupWindow.on("enter-full-screen", layout);
  popupWindow.on("leave-full-screen", layout);

  const publishState = () => publish(popup);
  target.on("did-start-loading", publishState);
  target.on("did-stop-loading", publishState);
  target.on("did-navigate", publishState);
  target.on("did-navigate-in-page", publishState);
  target.on("page-title-updated", publishState);
  target.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "l") {
      event.preventDefault();
      popupWindow.webContents.send("viron:web-popup-focus-address");
    }
  });

  popupWindow.once("ready-to-show", () => {
    if (shouldShow && !popupWindow.isDestroyed()) {
      popupWindow.show();
      target.focus();
    }
    publishState();
  });

  popupWindow.on("closed", () => {
    popup.closing = true;
    popups.delete(shellContentsId);
    closeTarget(target);
  });
  target.once("destroyed", () => {
    if (!popup.closing && !popupWindow.isDestroyed()) popupWindow.close();
  });

  popups.set(shellContentsId, popup);
  void popupWindow.loadFile(join(app.getAppPath(), "dist", "desktop-renderer", "desktop-web-popup.html")).then(() => {
    if (shouldShow && !popupWindow.isDestroyed() && !popupWindow.isVisible()) {
      popupWindow.show();
      if (!target.isDestroyed()) target.focus();
    }
    publishState();
  }).catch((error) => {
    if (popup.closing || popupWindow.isDestroyed()) return;
    popupWindow.setTitle(tr("网页窗口加载失败"));
    console.error("[Viron] Failed to load the Web popup shell", error);
  });

  return {
    window: popupWindow,
    target,
    pageBounds: () => {
      if (popupWindow.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
      const [width, height] = popupWindow.getContentSize();
      return { x: 0, y: 0, width, height: Math.max(0, height - DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT) };
    },
    dispose: () => {
      popup.closing = true;
      popups.delete(shellContentsId);
      if (!popupWindow.isDestroyed()) popupWindow.destroy();
      closeTarget(target);
    },
  };
}
