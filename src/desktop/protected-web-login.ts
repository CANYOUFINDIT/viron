import { BrowserWindow, type Rectangle, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { protectedLoginInstallScript } from "../shared/protected-web-login-dom.js";
import { parseWebLoginConfig, type ProtectedLoginInput, type ProtectedLoginState, type WebLoginConfig } from "../shared/protected-web-login.js";

type Region = Rectangle & { revision: string };
interface Tick { status: string; region?: Region; released?: boolean }
export interface ProtectedLoginResult { url: string; sessionStorage: Record<string, string> }

const guardMessages: Record<string, string> = {
  "ambiguous-selector": "登录选择器匹配到多个可见控件，请配置唯一的 CSS 选择器",
  "invalid-input": "登录输入选择器未指向可编辑的输入框，请检查入口配置",
  "missing-submit": "未找到可用的登录按钮，请在入口中配置登录按钮选择器",
  "invalid-step": "登录步骤配置无效，请检查多步登录脚本",
  "unsafe-region": "验证区域包含或覆盖了账号密码，或超出了页面范围，请调整验证区域选择器",
  "unsafe-frame": "验证区域包含嵌入页面（iframe），当前无法安全交互",
  "unsafe-shadow": "验证区域包含 Shadow DOM 控件，当前无法安全交互",
  "secret-in-storage": "站点将密码写入了会话存储，无法安全打开，请调整站点的登录实现",
  "storage-read-failed": "无法检查站点的登录存储，已保持页面保护，请重试",
  "storage-too-large": "站点的登录存储超出检查范围，已保持页面保护",
};

/** No webview ID, DOM, script, credentials or full-page image crosses the shell IPC. */
export class ProtectedWebLogin {
  readonly state: ProtectedLoginState = { phase: "loading", message: "正在后台打开登录页", image: "", revision: "", width: 0, height: 0 };
  private window: BrowserWindow;
  private config: WebLoginConfig;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private busy = false;
  private step = 0;
  private submitted = false;
  private passwordSubmitted = false;
  private submittedUrl = "";
  private submittedDocument = "";
  private startedAt = Date.now();
  private anonymousSince = 0;
  private installedDocument = "";
  private inputBusy = false;
  private origins: Set<string>;
  private interactionFrame: Region | null = null;
  private nonce = randomUUID();
  constructor(private options: {
    session: Session; url: string; username: string; password: string; config?: WebLoginConfig;
    bounds: Rectangle; changed: () => void; completed: (result: ProtectedLoginResult) => Promise<void>;
  }) {
    this.config = parseWebLoginConfig(options.config);
    this.origins = new Set([new URL(options.url).origin, ...this.config.allowedOrigins]);
    this.window = new BrowserWindow({ show: false, width: Math.max(800, options.bounds.width), height: Math.max(600, options.bounds.height),
      webPreferences: { session: options.session, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, backgroundThrottling: false } });
    const contents = this.window.webContents;
    contents.setWindowOpenHandler(() => { this.fail("登录需要新窗口，请调整入口的登录流程后重试"); return { action: "deny" }; });
    contents.on("will-navigate", (event, details) => {
      if (!this.allowed(details)) { event.preventDefault(); this.fail("登录跳转到了未授权的域名，请在入口配置中添加允许登录域名"); }
    });
    contents.on("will-redirect", (event, details) => {
      if (!this.allowed(details)) { event.preventDefault(); this.fail("登录跳转到了未授权的域名，请检查入口配置"); }
    });
    contents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) { this.installedDocument = ""; this.clearFrame(); }
    });
    contents.on("certificate-error", (event, _url, _error, _certificate, callback) => {
      event.preventDefault(); callback(false); this.fail("登录站点的 HTTPS 证书校验失败，请先修复证书");
    });
    contents.on("render-process-gone", () => this.fail("后台登录页面已退出，请重试"));
    options.session.setPermissionCheckHandler(() => false);
    options.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    void contents.loadURL(options.url).then(() => this.schedule(), () => this.fail("登录页面加载失败，请检查网络和入口地址"));
  }
  private allowed(url: string) {
    try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && this.origins.has(parsed.origin); } catch { return false; }
  }
  private async evaluate<T>(code: string): Promise<T> {
    // Electron may replace a thrown renderer exception with a generic message.
    // Return only recognized guard codes from the isolated world, never arbitrary
    // exception text (which could contain credentials supplied by the target page).
    const wrapped = `Promise.resolve().then(() => (${code})).then(
      value => ({ ok: true, value }),
      error => ({ ok: false, code: ${JSON.stringify(Object.keys(guardMessages))}.includes(error?.message) ? error.message : "runtime-error" })
    )`;
    const result = await this.window.webContents.executeJavaScriptInIsolatedWorld(997, [{ code: wrapped }], true) as { ok: boolean; value?: T; code?: string };
    if (!result?.ok) throw new Error(result?.code || "runtime-error");
    return result.value as T;
  }
  private clearFrame() {
    this.interactionFrame = null;
    Object.assign(this.state, { image: "", revision: "", width: 0, height: 0 });
  }
  private schedule() {
    if (this.disposed || this.state.phase === "failed") return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 300);
    this.timer.unref();
  }
  private fail(message: string) {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.clearFrame();
    this.state.phase = "failed";
    this.state.message = message;
    // Destroy the document even on failure; do not retain inspectable credentials.
    this.destroyWindow();
    void this.options.session.clearData().catch(() => undefined);
    this.options.changed();
  }
  private async tick() {
    if (this.disposed || this.busy || this.inputBusy || this.state.phase === "failed") return this.schedule();
    this.busy = true;
    let stage: "initialization" | "form" | "verification" | "storage" = "initialization";
    try {
      if (Date.now() - this.startedAt > 300_000) return this.fail("登录等待超时，请检查登录配置后重试");
      const contents = this.window.webContents;
      if (contents.isDestroyed()) return;
      if (contents.isLoadingMainFrame()) return;
      const url = contents.getURL();
      if (!this.allowed(url)) return this.fail("登录页面不在允许的域名中");
      if (this.options.password && decodeURIComponent(url).includes(this.options.password)) return this.fail("站点将密码写入了页面地址，无法安全打开");
      const documentId = await this.evaluate<string>("String(performance.timeOrigin)");
      if (this.installedDocument !== documentId) {
        await this.evaluate(protectedLoginInstallScript(this.config, this.options.username, this.options.password, randomUUID()));
        this.installedDocument = documentId;
      }
      stage = "form";
      const result = await this.evaluate<Tick>(`globalThis.__vironLogin.tick(${this.step}, ${this.submitted}, ${JSON.stringify(this.submittedUrl)}, ${this.passwordSubmitted}, ${JSON.stringify(this.submittedDocument)})`);
      if (result.released) this.submittedUrl ||= url;
      if (result.status === "next") {
        this.step++;
        this.submitted = true;
        this.submittedUrl ||= url;
      } else if (result.status === "submitted") {
        this.submitted = true;
        this.passwordSubmitted ||= Boolean(result.released);
        this.submittedUrl = url;
        this.submittedDocument = documentId;
      } else if (result.status === "rejected") {
        return this.fail("登录未通过，已停止重复提交。请检查账号密码后重新后台登录");
      } else if (result.status === "interactive" && result.region) {
        stage = "verification";
        const before = result.region;
        const image = await contents.capturePage(before, { stayHidden: true });
        const after = await this.evaluate<Region | null>("globalThis.__vironLogin.region()");
        if (this.disposed || contents.isDestroyed()) return;
        if (!after || JSON.stringify(before) !== JSON.stringify(after) || image.isEmpty()) { this.clearFrame(); return; }
        this.interactionFrame = after;
        Object.assign(this.state, { phase: "interactive", message: "请完成验证，然后继续登录", image: image.toDataURL(), revision: `${this.nonce}:${after.revision}`, width: after.width, height: after.height });
        this.options.changed();
        return;
      } else if (result.status === "success" || result.status === "anonymous") {
        if (result.status === "anonymous") {
          this.anonymousSince ||= Date.now();
          if (Date.now() - this.anonymousSince < 3000) return;
        }
        stage = "storage";
        const storage = await this.evaluate<Record<string, string>>("globalThis.__vironLogin.finish()");
        const cookies = await this.options.session.cookies.get({});
        if (this.options.password && cookies.some((cookie) => cookie.value.includes(this.options.password))) return this.fail("站点将密码写入了会话存储，无法安全打开，请调整站点的登录实现");
        Object.assign(this.state, { phase: "authenticating", message: "认证通过，正在打开业务页面" });
        this.dispose();
        this.options.changed();
        await this.options.completed({ url, sessionStorage: storage });
        return;
      } else this.anonymousSince = 0;
      this.clearFrame();
      this.state.phase = "authenticating";
      this.state.message = this.submitted ? "等待登录成功；如有验证，请在入口中配置验证区域" : "正在识别登录表单；复杂页面可在入口中配置登录步骤";
      this.options.changed();
    } catch (error) {
      if (!this.disposed && !this.window.isDestroyed()) {
        const navigating = this.window.webContents.isLoadingMainFrame() || /context.*destroyed|frame.*disposed|frame.*removed/i.test(error instanceof Error ? error.message : "");
        if (navigating) {
          this.clearFrame();
          this.installedDocument = "";
          if (this.config.steps[this.step]?.action === "click") this.step++;
          this.options.changed();
          return;
        }
      }
      if (!this.disposed) {
        const reason = error instanceof Error ? error.message : "";
        // Match only our fixed guard codes; never expose arbitrary page exceptions
        // or storage/input values through the public login state.
        const code = Object.keys(guardMessages).find((key) => reason === key || reason === `Error: ${key}`);
        this.fail(code ? guardMessages[code]! : stage === "initialization"
          ? "后台登录脚本初始化失败，请更新客户端后重试"
          : stage === "storage" ? "无法检查站点的登录存储，已保持页面保护，请重试"
            : stage === "verification" ? "无法安全获取验证画面，已保持页面保护，请重试"
              : "无法执行登录表单，请检查登录选择器和多步登录步骤");
      }
    } finally { this.busy = false; this.schedule(); }
  }
  async input(input: ProtectedLoginInput): Promise<void> {
    if (this.disposed || this.state.phase !== "interactive" || this.inputBusy || !this.interactionFrame || !input || input.revision !== this.state.revision) throw new Error("验证画面已更新，请使用最新画面重试");
    this.inputBusy = true;
    try {
      const keyboard = input.type === "text" || input.type === "key";
      const rect = await this.evaluate<Region | null>(`globalThis.__vironLogin.authorize(${JSON.stringify(this.interactionFrame.revision)}, ${JSON.stringify(input.x ?? null)}, ${JSON.stringify(input.y ?? null)}, ${keyboard})`);
      if (!rect) throw new Error("验证区域或焦点已变化");
      const contents = this.window.webContents;
      if (input.type === "continue") {
        const accepted = await this.evaluate<boolean>(`globalThis.__vironLogin.continueInteraction(${JSON.stringify(rect.revision)})`);
        if (!accepted) throw new Error("验证画面已更新");
        if (this.config.steps.length) this.step++;
        this.clearFrame();
        this.state.phase = "authenticating";
        this.options.changed();
      } else if (input.type === "text") {
        if (typeof input.text !== "string" || input.text.length > 256) throw new Error("验证输入无效");
        await contents.insertText(input.text);
      } else if (input.type === "key") {
        // No Tab/Enter/shortcuts: focus and implicit form submits must not escape the crop.
        if (!["Backspace", "Delete", "Left", "Right", "Home", "End"].includes(input.key ?? "")) throw new Error("验证按键无效");
        contents.sendInputEvent({ type: "keyDown", keyCode: input.key! });
        contents.sendInputEvent({ type: "keyUp", keyCode: input.key! });
      } else if (["mouseDown", "mouseUp", "mouseMove"].includes(input.type)) {
        if (typeof input.x !== "number" || typeof input.y !== "number") throw new Error("验证坐标无效");
        contents.sendInputEvent({ type: input.type as "mouseDown", x: Math.floor(rect.x + input.x), y: Math.floor(rect.y + input.y), button: "left", clickCount: 1 });
      } else throw new Error("不支持的验证操作");
    } finally {
      this.inputBusy = false;
      // Refresh the revision after the native event is processed, so a queued drag
      // or keystroke validates against the next safe frame rather than a stale one.
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (!this.busy) await this.tick();
      this.schedule();
    }
  }
  private destroyWindow() {
    this.options.username = "";
    this.options.password = "";
    if (!this.window.isDestroyed()) this.window.destroy();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.clearFrame();
    this.destroyWindow();
  }
}
