import { randomUUID } from "node:crypto";
import { protectedLoginInstallScript } from "./protected-web-login-dom.js";
import { containsPersistedWebLoginSecret } from "./web-login-storage.js";
import { parseWebLoginConfig, type ProtectedLoginInput, type ProtectedLoginState, type ProtectedLoginTarget, type WebLoginConfig } from "./protected-web-login.js";

export interface LoginRegion { x: number; y: number; width: number; height: number; revision: string; targets?: ProtectedLoginTarget[] }
type Region = LoginRegion;
export interface ProtectedLoginBrowser {
  load(url: string): Promise<void>;
  url(): string;
  loading(): boolean;
  destroyed(): boolean;
  evaluate<T>(code: string): Promise<T>;
  capture(region: LoginRegion): Promise<string>;
  mouse(type: "mouseDown" | "mouseUp" | "mouseMove", x: number, y: number): Promise<void>;
  text(value: string): Promise<void>;
  key(value: string): Promise<void>;
  wheel?(x: number, y: number, deltaY: number): Promise<void>;
  cookies(): Promise<Array<{ name?: string; value: string }>>;
  clear(origins: string[]): Promise<void>;
  destroy(): void | Promise<void>;
}
interface Tick { status: string; region?: Region; released?: boolean; kind?: string }
export interface ProtectedLoginResult { url: string; sessionStorage: Record<string, string>; authenticated: boolean }

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

/** No auth webview ID, DOM, script or credentials crosses the shell IPC. */
export class ProtectedLoginController {
  readonly state: ProtectedLoginState = { phase: "loading", pageLoading: true, message: "正在加载登录网页", image: "", revision: "", width: 0, height: 0 };
  private browser: ProtectedLoginBrowser;
  private config: WebLoginConfig;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private busy = false;
  private step = 0;
  private submitted = false;
  private passwordSubmitted = false;
  private submittedUrl = "";
  private submittedDocument = "";
  private startedAt = Date.now();
  private progressAt = Date.now();
  private readySince = 0;
  private readyDocument = "";
  private installedDocument = "";
  private navigationVersion = 0;
  private inputBusy = false;
  private inputQueue = Promise.resolve();
  private pressed = false;
  private origins: Set<string>;
  private interactionFrame: Region | null = null;
  private nonce = randomUUID();
  private cleanup = Promise.resolve();
  private destruction = Promise.resolve();
  private documentDestroyed = false;
  private credentialReleased = false;
  private storageVerified = false;
  private assisted = false;
  private assistedScope: { document: string; url: string; navigation: number } | undefined;
  constructor(private options: {
    browser: ProtectedLoginBrowser; url: string; username: string; password: string; config?: WebLoginConfig;
    prepare?: () => Promise<void>; manualFallback?: () => void; changed: () => void; completed: (result: ProtectedLoginResult) => Promise<void>;
  }) {
    this.config = parseWebLoginConfig(options.config);
    this.origins = new Set([new URL(options.url).origin, ...this.config.allowedOrigins]);
    this.browser = options.browser;
    void Promise.resolve().then(() => options.prepare?.()).then(async () => {
      if (!this.disposed) {
        this.pageLoadingChanged(true);
        await this.browser.load(options.url);
        if (!this.disposed && this.state.phase !== "failed") { this.pageLoadingChanged(false); this.schedule(); }
      }
    }).catch(() => this.fail("登录页面准备或加载失败，请检查网络后重试"));
  }
  private allowed(url: string) {
    try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && this.origins.has(parsed.origin); } catch { return false; }
  }
  private async evaluate<T>(code: string): Promise<T> {
    // Electron may replace a thrown renderer exception with a generic message.
    // Return only recognized guard codes from the isolated world, never arbitrary
    // exception text (which could contain credentials supplied by the target page).
    const wrapped = `Promise.resolve().then(() => (${code})).then(
      value => ({ ok: true, value, released: globalThis.__vironLogin?.secretReleased() === true }),
      error => ({ ok: false, released: globalThis.__vironLogin?.secretReleased() === true, code: ${JSON.stringify(Object.keys(guardMessages))}.includes(error?.message) ? error.message : "runtime-error" })
    )`;
    const result = await this.browser.evaluate(wrapped) as { ok: boolean; value?: T; code?: string; released?: boolean };
    this.credentialReleased ||= result?.released === true;
    if (!result?.ok) throw new Error(result?.code || "runtime-error");
    return result.value as T;
  }
  private clearFrame() {
    this.interactionFrame = null;
    this.cancelPointer();
    Object.assign(this.state, { image: "", revision: "", width: 0, height: 0, targets: undefined });
  }
  private cancelPointer() {
    if (this.pressed && !this.browser.destroyed()) void this.browser.mouse("mouseUp", -1, -1).catch(() => undefined);
    this.pressed = false;
  }
  pageLoadingChanged(loading: boolean): void {
    if (this.disposed || this.state.phase === "failed") return;
    if (loading && !this.loadTimer) {
      this.loadTimer = setTimeout(() => this.fail("网页加载超时，请检查站点连接后重试"), 30_000);
      this.loadTimer.unref();
    } else if (!loading) { clearTimeout(this.loadTimer); this.loadTimer = undefined; }
    if (this.state.pageLoading === loading && (loading ? this.state.phase === "loading" : this.state.phase !== "loading")) return;
    this.state.pageLoading = loading;
    this.state.phase = loading ? "loading" : "authenticating";
    this.state.message = loading ? "正在加载登录网页" : "网页已加载，正在识别登录表单";
    if (!loading) this.progressAt = Date.now();
    this.options.changed();
    if (!loading) this.schedule();
  }
  navigationStarted(inPlace = false): void {
    if (this.disposed || this.state.phase === "failed") return;
    this.navigationVersion++;
    if (!inPlace) this.installedDocument = "";
    this.readyDocument = ""; this.readySince = 0;
    this.clearFrame();
    if (!inPlace) this.pageLoadingChanged(true);
    else { this.pageLoadingChanged(false); this.state.phase = "authenticating"; this.state.message = "正在确认登录页面状态"; }
    this.options.changed();
  }
  private schedule() {
    if (this.disposed || this.state.phase === "failed") return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.state.phase === "interactive" ? 120 : 150);
    this.timer.unref();
  }
  fail(message: string) {
    if (this.disposed || this.state.phase === "failed") return;
    clearTimeout(this.timer);
    clearTimeout(this.loadTimer); this.loadTimer = undefined;
    this.clearFrame();
    this.state.phase = "failed";
    this.state.pageLoading = false;
    this.state.message = message;
    // Destroy the document even on failure; do not retain inspectable credentials.
    this.destroyWindow();
    if (!this.storageVerified && (this.credentialReleased || /将密码写入/.test(message))) {
      this.cleanup = this.browser.clear([...this.origins]);
      void this.cleanup.catch(() => undefined); // Settled callers still observe cleanup failures.
    }
    this.options.changed();
  }
  private assist(message: string) {
    if (this.options.manualFallback) { this.options.manualFallback(); return; }
    if (!this.assisted && this.installedDocument) this.assistedScope = { document: this.installedDocument, url: this.browser.url(), navigation: this.navigationVersion };
    this.assisted = true;
    this.progressAt = Date.now();
    this.readyDocument = ""; this.readySince = 0;
    this.clearFrame();
    Object.assign(this.state, { phase: "authenticating", pageLoading: false, message });
    this.options.changed();
  }
  private async complete(url: string, authenticated: boolean) {
    if (this.disposed) return;
    const navigationVersion = this.navigationVersion;
    const password = this.options.password, username = this.options.username;
    if (!this.allowed(url) || (password && decodeURIComponent(url).includes(password))) throw new Error("unsafe-url");
    const storage = await this.evaluate<Record<string, string>>("globalThis.__vironLogin.finish()");
    const cookies = await this.browser.cookies();
    if (this.disposed) return;
    if (this.browser.loading() || navigationVersion !== this.navigationVersion || this.browser.url() !== url) throw new Error("navigation-changed");
    if (cookies.some((cookie) => containsPersistedWebLoginSecret(cookie.value, password, username, cookie.name))) throw new Error("secret-in-storage");
    this.storageVerified = true;
    Object.assign(this.state, { phase: "authenticating", pageLoading: true, message: "正在安全打开业务页面" });
    this.dispose(); this.options.changed();
    await this.destruction;
    await this.options.completed({ url, sessionStorage: storage, authenticated });
  }
  private async tick() {
    if (this.disposed || this.busy || this.inputBusy || this.state.phase === "failed") return this.schedule();
    this.busy = true;
    const navigationVersion = this.navigationVersion;
    let stage: "initialization" | "form" | "verification" | "storage" = "initialization";
    try {
      if (!this.assisted && Date.now() - this.startedAt > 300_000) this.assist("自动登录等待超时，请在受保护页面中继续登录");
      const contents = this.browser;
      if (contents.destroyed()) return;
      if (contents.loading()) { this.pageLoadingChanged(true); return; }
      if (this.state.pageLoading) this.pageLoadingChanged(false);
      if (!this.assisted && this.state.phase !== "interactive" && Date.now() - this.progressAt > 30_000) this.assist("自动登录等待超时，请在受保护页面中继续登录");
      const url = contents.url();
      if (!this.allowed(url)) return this.fail("登录页面不在允许的域名中");
      if (this.options.password && decodeURIComponent(url).includes(this.options.password)) return this.fail("站点将密码写入了页面地址，无法安全打开");
      const documentId = await this.evaluate<string>("String(performance.timeOrigin)");
      if (this.installedDocument !== documentId) {
        await this.evaluate(protectedLoginInstallScript(this.config, this.options.username, this.options.password, randomUUID()));
        this.installedDocument = documentId;
      }
      if (this.assisted && !this.assistedScope) this.assistedScope = { document: documentId, url, navigation: this.navigationVersion };
      const sameAssistedScope = this.assistedScope?.document === documentId && this.assistedScope.url === url && this.assistedScope.navigation === this.navigationVersion;
      stage = "form";
      const alreadyReleased = this.credentialReleased;
      // Treat an interrupted renderer call conservatively: it can fill the form
      // before its reply reaches main. Never resume extensions on unchecked storage.
      this.credentialReleased ||= Boolean(this.options.password);
      const result = await this.evaluate<Tick>(this.assisted ? `globalThis.__vironLogin.assist(${sameAssistedScope})` : `globalThis.__vironLogin.tick(${this.step}, ${this.submitted}, ${JSON.stringify(this.submittedUrl)}, ${this.passwordSubmitted}, ${JSON.stringify(this.submittedDocument)})`);
      if (!alreadyReleased && !result.released && !await this.evaluate<boolean>("globalThis.__vironLogin.secretReleased()")) this.credentialReleased = false;
      // An unrecognized page can be an SPA splash, not a cached session. Keep
      // the protected document available instead of abandoning login detection.
      if (result.status === "anonymous" && !this.assisted) {
        // A visible input needs manual help; a splash may still mount its form.
        const hasInputs = await this.evaluate<boolean>(`Array.from(document.querySelectorAll('input')).some(input => {
          const rect = input.getBoundingClientRect(), style = getComputedStyle(input);
          return !input.disabled && ["text", "email", "password", "search", "tel", "url"].includes(input.type)
            && rect.width > 2 && rect.height > 2 && style.display !== "none" && style.visibility !== "hidden";
        })`);
        if (hasInputs) this.assist("未识别到登录表单，请手动填入登录信息");
        return;
      }
      if (result.status === "anonymous" && this.assisted && (!this.credentialReleased || sameAssistedScope)) result.status = "interactive";
      if (result.released) this.submittedUrl ||= url;
      if (result.status !== "waiting") this.progressAt = Date.now();
      if (!["success", "anonymous"].includes(result.status)) { this.readySince = 0; this.readyDocument = ""; }
      if (result.status === "next") {
        this.step++;
        this.submitted = true;
        this.passwordSubmitted ||= Boolean(result.released);
        this.submittedUrl ||= url;
        this.submittedDocument ||= documentId;
      } else if (result.status === "submitted") {
        this.submitted = true;
        this.passwordSubmitted ||= Boolean(result.released);
        this.submittedUrl = url;
        this.submittedDocument = documentId;
      } else if (result.status === "rejected") {
        this.assist("登录未通过，请检查页面提示后继续操作；系统已停止自动提交"); return;
      } else if (result.status === "interactive" && result.region) {
        if (this.options.manualFallback) { this.options.manualFallback(); return; }
        stage = "verification";
        const before = result.region;
        const image = await contents.capture(before);
        const after = await this.evaluate<Region | null>(this.assisted ? "globalThis.__vironLogin.pageRegion()" : "globalThis.__vironLogin.region()");
        if (this.disposed || contents.destroyed()) return;
        if (!after || before.revision !== after.revision || before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height || !image) { this.clearFrame(); return; }
        // Only publish target rectangles present throughout the capture. Moving
        // unrelated controls never invalidate the entire page or an open menu.
        const targets = before.targets?.flatMap((target) => {
          const current = after.targets?.find((item) => item.token === target.token);
          if (!current) return [];
          const x = Math.max(target.x, current.x), y = Math.max(target.y, current.y);
          const width = Math.min(target.x + target.width, current.x + current.width) - x;
          const height = Math.min(target.y + target.height, current.y + current.height) - y;
          return width > 2 && height > 2 ? [{ token: target.token, x, y, width, height }] : [];
        });
        if (this.interactionFrame?.revision !== after.revision) this.cancelPointer();
        this.interactionFrame = after;
        Object.assign(this.state, { phase: "interactive", message: result.kind === "page" ? "自动登录未完成。请继续操作页面；可右键输入框填充用户名或密码。" : result.kind === "agreement" ? "请确认页面的协议选项后继续登录" : "请完成验证，然后继续登录", image, kind: result.kind === "page" ? "page" : result.kind === "agreement" ? "agreement" : "challenge", revision: `${this.nonce}:${after.revision}`, width: after.width, height: after.height, targets });
        this.options.changed();
        return;
      } else if (result.status === "success" || result.status === "anonymous") {
        const candidate = `${documentId}:${url}:${result.status}`;
        if (this.readyDocument !== candidate) { this.readyDocument = candidate; this.readySince = Date.now(); }
        // An explicit marker has stronger evidence than a generic route change.
        const marker = this.config.successSelector || this.config.steps.find((step) => step.action === "success")?.selector;
        if (Date.now() - this.readySince < (marker ? 300 : 1500)) return;
        stage = "storage";
        await this.complete(url, result.status === "success");
        return;
      }
      this.readySince = 0;
      this.readyDocument = "";
      this.clearFrame();
      this.state.phase = "authenticating";
      this.state.message = this.config.steps.length ? "正在执行登录步骤" : this.submitted || result.status === "filled" ? "已填写登录信息，正在等待站点认证结果" : "网页已加载，正在等待登录表单";
      this.options.changed();
    } catch (error) {
      if (!this.disposed && !this.browser.destroyed()) {
        const navigating = this.browser.loading() || navigationVersion !== this.navigationVersion || /context.*destroyed|frame.*disposed|frame.*removed/i.test(error instanceof Error ? error.message : "");
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
        if (!this.assisted && (stage === "form" && (!code || ["ambiguous-selector", "invalid-input", "missing-submit", "invalid-step", "unsafe-region", "unsafe-frame", "unsafe-shadow"].includes(code))
          || stage === "verification" && ["unsafe-region", "unsafe-frame", "unsafe-shadow"].includes(code ?? ""))) {
          this.assist("自动登录未完成，请在受保护页面中继续登录"); return;
        }
        this.fail(code ? guardMessages[code]! : stage === "initialization"
          ? "后台登录脚本初始化失败，请更新客户端后重试"
          : stage === "storage" ? "无法检查站点的登录存储，已保持页面保护，请重试"
            : stage === "verification" ? "无法安全获取验证画面，已保持页面保护，请重试"
              : "无法执行登录表单，请检查登录选择器和多步登录步骤");
      }
    } finally { this.busy = false; this.schedule(); }
  }
  input(input: ProtectedLoginInput): Promise<void> {
    const operation = this.inputQueue.then(() => this.applyInput(input));
    this.inputQueue = operation.catch(() => undefined);
    return operation;
  }
  private async applyInput(input: ProtectedLoginInput): Promise<void> {
    if (this.disposed || this.state.phase !== "interactive" || !this.interactionFrame || !input) throw new Error("当前没有待完成的验证");
    // Reject a stale frame without turning an expected modal/layout transition
    // into an error. Never replay its coordinates against a different crop.
    const targetedFill = this.assisted && (input.type === "fill-username" || input.type === "fill-password");
    if (!targetedFill && input.revision !== this.state.revision) { this.cancelPointer(); return; }
    while (this.busy && !this.disposed) await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.disposed || !this.interactionFrame || (!targetedFill && input.revision !== this.state.revision)) { this.cancelPointer(); return; }
    this.inputBusy = true;
    try {
      if (targetedFill) {
        if (typeof input.targetToken !== "string" || input.targetToken.length > 160) throw new Error("请选择页面中的输入框");
        const accepted = await this.evaluate<boolean>(`globalThis.__vironLogin.fillTarget(${JSON.stringify(input.targetToken)}, ${JSON.stringify(input.type)})`);
        if (!accepted) throw new Error("请选择可编辑的用户名或密码输入框");
        return;
      }
      if (this.assisted && input.type === "continue") {
        try { await this.complete(this.browser.url(), false); }
        catch { this.fail("无法安全移交登录页面，请重试；托管密码仍受保护"); }
        return;
      }
      const keyboard = input.type === "text" || input.type === "key";
      const rect = await this.evaluate<Region | null>(`globalThis.__vironLogin.authorize(${JSON.stringify(this.interactionFrame.revision)}, ${JSON.stringify(input.x ?? null)}, ${JSON.stringify(input.y ?? null)}, ${keyboard})`);
      if (!rect) { this.cancelPointer(); return; }
      if (input.type === "continue") {
        const accepted = await this.evaluate<boolean>(`globalThis.__vironLogin.continueInteraction(${JSON.stringify(rect.revision)})`);
        if (!accepted) return;
        if (this.config.steps.length) this.step++;
        this.clearFrame();
        this.state.phase = "authenticating";
        this.progressAt = Date.now();
        this.options.changed();
      } else if (input.type === "text") {
        if (typeof input.text !== "string" || input.text.length > 256) throw new Error("验证输入无效");
        await this.browser.text(input.text);
      } else if (input.type === "key") {
        if (!["Backspace", "Delete", "Left", "Right", "Home", "End", ...(this.assisted ? ["Enter", "Tab", "Escape", "Up", "Down"] : [])].includes(input.key ?? "")) throw new Error("验证按键无效");
        await this.browser.key(input.key!);
      } else if (input.type === "scroll" && this.assisted) {
        if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || !Number.isFinite(input.deltaY) || Math.abs(input.deltaY!) > 1000) throw new Error("滚动参数无效");
        await this.browser.wheel?.(rect.x + input.x!, rect.y + input.y!, input.deltaY!);
      } else if (["mouseDown", "mouseUp", "mouseMove", "click"].includes(input.type)) {
        if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error("验证坐标无效");
        const x = Math.floor(rect.x + input.x!), y = Math.floor(rect.y + input.y!);
        if (input.type === "click") {
          await this.browser.mouse("mouseDown", x, y);
          this.pressed = true;
          // Revalidate after down: a page can open a modal before up.
          if (await this.evaluate(`globalThis.__vironLogin.authorize(${JSON.stringify(rect.revision)}, ${input.x}, ${input.y}, false)`)) {
            await this.browser.mouse("mouseUp", x, y);
            this.pressed = false;
          } else this.cancelPointer();
        } else {
          await this.browser.mouse(input.type as "mouseDown", x, y);
          if (input.type === "mouseDown") this.pressed = true;
          if (input.type === "mouseUp") this.pressed = false;
        }
      } else throw new Error("不支持的验证操作");
      // Keep the capture loop locked until native events have been processed.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      this.inputBusy = false;
      if (!this.busy) await this.tick();
      this.schedule();
    }
  }
  private destroyWindow() {
    if (this.documentDestroyed) return;
    this.documentDestroyed = true;
    this.options.username = "";
    this.options.password = "";
    this.destruction = Promise.resolve(this.browser.destroy());
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.loadTimer); this.loadTimer = undefined;
    this.clearFrame();
    this.destroyWindow();
    if (!this.storageVerified && this.credentialReleased && this.state.phase !== "failed") {
      this.cleanup = this.browser.clear([...this.origins]);
      void this.cleanup.catch(() => undefined);
    }
  }
  settled(): Promise<void> { return Promise.all([this.cleanup, this.destruction]).then(() => undefined); }
}
