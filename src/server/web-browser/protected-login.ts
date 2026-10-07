import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { ProtectedLoginController, type ProtectedLoginResult } from "../../shared/protected-web-login-controller.js";
import { protectedLoginBusinessPageScript } from "../../shared/protected-web-login-dom.js";
import type { WebLoginConfig } from "../../shared/protected-web-login.js";

/** Credentials are evaluated in a CDP isolated world of an undisclosed auth page. */
export async function createServerProtectedLogin(options: {
  context: BrowserContext; url: string; username: string; password: string; config: WebLoginConfig;
  changed: () => void; completed: (result: ProtectedLoginResult) => Promise<void>;
}): Promise<ProtectedLoginController> {
  const page = await options.context.newPage();
  const cdp = await options.context.newCDPSession(page);
  let closed = false;
  let closing = Promise.resolve();
  const evaluate = async <T>(expression: string): Promise<T> => {
    const tree = await cdp.send("Page.getFrameTree");
    const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "viron-protected-login" });
    const result = await cdp.send("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error("runtime-error");
    return result.result.value as T;
  };
  let prepared!: () => void;
  const preparation = new Promise<void>((resolve) => { prepared = resolve; });
  let pressed = false;
  const login = new ProtectedLoginController({ ...options, prepare: () => preparation, browser: {
    load: async (url) => { await page.goto(url, { waitUntil: "load", timeout: 30_000 }); },
    url: () => page.url(), loading: () => false, destroyed: () => closed || page.isClosed(), evaluate,
    capture: async ({ x, y, width, height }) => `data:image/png;base64,${(await page.screenshot({ clip: { x, y, width, height }, timeout: 3000 })).toString("base64")}`,
    mouse: async (type, x, y) => { if (type === "mouseDown") pressed = true; if (type === "mouseUp") pressed = false; await cdp.send("Input.dispatchMouseEvent", { type: type === "mouseDown" ? "mousePressed" : type === "mouseUp" ? "mouseReleased" : "mouseMoved", x, y, button: "left", buttons: pressed ? 1 : 0, clickCount: type === "mouseMove" ? 0 : 1 }); },
    text: async (value) => { await page.keyboard.insertText(value); },
    key: async (value) => { await page.keyboard.press(["Left", "Right"].includes(value) ? `Arrow${value}` : value); },
    cookies: () => options.context.cookies(),
    clear: async (origins) => {
      await closing;
      const audit = await options.context.newPage();
      try {
        const session = await options.context.newCDPSession(audit);
        for (const origin of origins) await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
        await options.context.clearCookies();
        await session.detach();
      } finally { await audit.close(); }
    },
    destroy: () => { closed = true; closing = page.close().catch(() => undefined); },
  } });
  const allowed = new Set([new URL(options.url).origin, ...options.config.allowedOrigins]);
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !allowed.has(new URL(request.url()).origin)) {
      await route.abort(); login.fail("登录跳转到了未授权的域名，请检查入口配置");
    } else await route.continue();
  });
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) login.navigationStarted(); });
  page.on("popup", (popup) => { void popup.close(); login.fail("登录需要新窗口，请调整入口的登录流程后重试"); });
  page.on("dialog", (dialog) => { void dialog.dismiss(); login.fail("登录页面使用浏览器原生对话框，请调整入口的登录流程后重试"); });
  page.on("crash", () => login.fail("后台登录页面已退出，请重试"));
  prepared();
  return login;
}

export async function verifyServerBusinessPage(page: Page, cdp: CDPSession, selector: string, current: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  let candidate = "", since = 0;
  while (current() && !page.isClosed() && Date.now() < deadline) {
    try {
      const tree = await cdp.send("Page.getFrameTree");
      const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "viron-business-probe" });
      const probe = await cdp.send("Runtime.evaluate", { expression: protectedLoginBusinessPageScript(selector), contextId: world.executionContextId, returnByValue: true });
      const result = probe.result.value;
      const key = `${page.url()}:${result}`;
      if (key !== candidate) { candidate = key; since = Date.now(); }
      if (result === "login" && Date.now() - since >= 3000) throw new Error("business-login");
      if (result === "ready" && Date.now() - since >= (selector ? 300 : 1500)) return;
    } catch (error) {
      if (error instanceof Error && error.message === "business-login") throw error;
      since = 0; candidate = "";
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("business-unconfirmed");
}
