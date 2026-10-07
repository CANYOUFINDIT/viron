import { BrowserWindow, type Rectangle, type Session } from "electron";
import { ProtectedLoginController, type ProtectedLoginResult } from "../shared/protected-web-login-controller.js";
import type { WebLoginConfig } from "../shared/protected-web-login.js";
export type { ProtectedLoginResult } from "../shared/protected-web-login-controller.js";

/** Electron owns the hidden authentication document; the shared controller owns its flow. */
export class ProtectedWebLogin extends ProtectedLoginController {
  private window: BrowserWindow;
  constructor(options: {
    session: Session; url: string; username: string; password: string; config?: WebLoginConfig;
    bounds: Rectangle; prepare?: () => Promise<void>; changed: () => void; completed: (result: ProtectedLoginResult) => Promise<void>;
  }) {
    const window = new BrowserWindow({ show: false, width: Math.max(800, options.bounds.width), height: Math.max(600, options.bounds.height),
      webPreferences: { session: options.session, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, backgroundThrottling: false } });
    const contents = window.webContents;
    let pressed = false;
    super({ ...options, browser: {
      load: async (url) => { await contents.loadURL(url); }, url: () => contents.getURL(),
      loading: () => contents.isLoadingMainFrame(), destroyed: () => contents.isDestroyed(),
      evaluate: async <T>(code: string) => await contents.executeJavaScriptInIsolatedWorld(997, [{ code }], true) as T,
      capture: async (region) => { const image = await contents.capturePage(region, { stayHidden: true }); return image.isEmpty() ? "" : image.toDataURL(); },
      mouse: async (type, x, y) => {
        if (type === "mouseDown") pressed = true;
        if (type === "mouseUp") pressed = false;
        contents.sendInputEvent({ type, x, y, button: pressed || type !== "mouseMove" ? "left" : undefined, modifiers: pressed ? ["leftButtonDown"] : [], clickCount: type === "mouseMove" ? 0 : 1 });
      },
      text: async (value) => { await contents.insertText(value); },
      key: async (value) => { contents.sendInputEvent({ type: "keyDown", keyCode: value }); contents.sendInputEvent({ type: "keyUp", keyCode: value }); },
      cookies: () => options.session.cookies.get({}), clear: (origins) => options.session.clearData({ origins }),
      destroy: () => { if (!window.isDestroyed()) window.destroy(); },
    } });
    this.window = window;
    const allowed = (url: string) => { try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && [new URL(options.url).origin, ...(options.config?.allowedOrigins ?? [])].includes(parsed.origin); } catch { return false; } };
    contents.setWindowOpenHandler(() => { this.fail("登录需要新窗口，请调整入口的登录流程后重试"); return { action: "deny" }; });
    contents.on("will-navigate", (event, url) => { if (!allowed(url)) { event.preventDefault(); this.fail("登录跳转到了未授权的域名，请检查入口配置"); } });
    contents.on("will-redirect", (event, url) => { if (!allowed(url)) { event.preventDefault(); this.fail("登录跳转到了未授权的域名，请检查入口配置"); } });
    contents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (mainFrame) this.navigationStarted(); });
    contents.on("certificate-error", (event, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); this.fail("登录站点的 HTTPS 证书校验失败，请先修复证书"); });
    contents.on("render-process-gone", () => this.fail("后台登录页面已退出，请重试"));
    options.session.setPermissionCheckHandler(() => false);
    options.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }
}
