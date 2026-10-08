import type { WebLoginConfig } from "./protected-web-login.js";
import { buildWebCredentialAutofillScript, type WebCredentialAutofillResult } from "./web-credential-autofill.js";

export const DIRECT_WEB_FILL_MESSAGE = "已填充登录信息，请确认协议或验证码后自行提交登录。";
export const DIRECT_WEB_FILL_MISSING = "未识别到可填充的登录表单，网页仍可继续使用。可配置用户名和密码选择器后重新填充。";
export const DIRECT_WEB_FILL_ORIGIN = "当前页面不在允许登录域名中，未填入账号密码。";

export interface DirectWebAutofillBrowser {
  destroyed(): boolean;
  loading(): boolean;
  evaluate<T>(source: string): Promise<T>;
}

/** Opt-in direct fill. Never follows the user into another document or route. */
export class DirectWebAutofill {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private scope: { href: string; timeOrigin: number } | undefined;
  private startedAt = Date.now();
  private readyAt = 0;
  private username: string;
  private password: string;
  private readonly origins: string[];

  constructor(private readonly options: {
    browser: DirectWebAutofillBrowser;
    entryUrl: string;
    config: WebLoginConfig;
    username: string;
    password: string;
    changed(message: string): void;
  }) {
    this.username = options.username;
    this.password = options.password;
    // Do not retain another copy of secrets in the options object.
    options.username = "";
    options.password = "";
    this.origins = [new URL(options.entryUrl).origin, ...options.config.allowedOrigins];
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.username = this.password = "";
  }

  private finish(message?: string): void {
    this.dispose();
    if (message) this.options.changed(message);
  }

  private schedule(): void {
    this.timer = setTimeout(() => { void this.tick(); }, 250);
  }

  private async tick(): Promise<void> {
    const { browser, config } = this.options;
    if (this.disposed) return;
    if (browser.destroyed()) { this.dispose(); return; }
    try {
      if (!this.scope) {
        if (browser.loading()) {
          if (Date.now() - this.startedAt >= 30_000) this.finish(DIRECT_WEB_FILL_MISSING);
          else this.schedule();
          return;
        }
        const scope = await browser.evaluate<{ href: string; timeOrigin: number; origin: string }>("({ href: location.href, timeOrigin: performance.timeOrigin, origin: location.origin })");
        if (this.disposed) return;
        if (!this.origins.includes(scope.origin)) { this.finish(DIRECT_WEB_FILL_ORIGIN); return; }
        this.scope = { href: scope.href, timeOrigin: scope.timeOrigin };
        this.readyAt = Date.now();
      }
      const live = await browser.evaluate<{ href: string; timeOrigin: number }>("({ href: location.href, timeOrigin: performance.timeOrigin })");
      if (this.disposed) return;
      if (live.href !== this.scope.href || live.timeOrigin !== this.scope.timeOrigin) { this.dispose(); return; }
      const result = await browser.evaluate<WebCredentialAutofillResult>(buildWebCredentialAutofillScript({
        username: this.username, password: this.password, previousSignature: "", autoSubmit: false,
        usernameSelector: config.usernameSelector, passwordSelector: config.passwordSelector,
        scope: { ...this.scope, allowedOrigins: this.origins },
        messages: { duplicate: DIRECT_WEB_FILL_MESSAGE, filled: DIRECT_WEB_FILL_MESSAGE, filledAndSubmitted: DIRECT_WEB_FILL_MESSAGE,
          ambiguousPasswords: DIRECT_WEB_FILL_MISSING, noReliableForm: DIRECT_WEB_FILL_MISSING },
      }));
      if (this.disposed) return;
      if (result.status === "filled" || result.status === "duplicate") this.finish(DIRECT_WEB_FILL_MESSAGE);
      else if (Date.now() - this.readyAt >= 10_000) this.finish(DIRECT_WEB_FILL_MISSING);
      else this.schedule();
    } catch {
      if (!this.disposed) this.finish(DIRECT_WEB_FILL_MISSING);
    }
  }
}
