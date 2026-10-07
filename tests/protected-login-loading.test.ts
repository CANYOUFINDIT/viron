import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectedLoginController, type ProtectedLoginBrowser } from "../src/shared/protected-web-login-controller.js";

afterEach(() => vi.useRealTimers());

function pendingPage() {
  let loaded!: () => void;
  const load = new Promise<void>((resolve) => { loaded = resolve; });
  const browser: ProtectedLoginBrowser = {
    load: () => load, url: () => "https://console.example.test/#/login", loading: () => false,
    destroyed: () => false, destroy: vi.fn(), cookies: async () => [], clear: async () => {},
    mouse: async () => {}, text: async () => {}, key: async () => {}, capture: async () => "data:image/png;base64,AA==",
    evaluate: async <T>(code: string) => ({ ok: true, released: false,
      value: code.includes("globalThis.__vironLogin.tick(") ? { status: "waiting" }
        : code.includes("globalThis.__vironLogin.assist(") ? { status: "interactive", kind: "page", region: { x: 0, y: 0, width: 900, height: 650, revision: "fallback" } }
          : code.includes("globalThis.__vironLogin.pageRegion()") ? { x: 0, y: 0, width: 900, height: 650, revision: "fallback" }
        : code.includes('String(performance.timeOrigin)') ? "document"
          : code.includes("globalThis.__vironLogin.secretReleased()") ? false : undefined,
    }) as T,
  };
  const login = new ProtectedLoginController({ browser, url: browser.url(), username: "fixture-user", password: "fixture-secret", changed: vi.fn(), completed: vi.fn() });
  return { login, loaded, browser };
}

describe("protected login page loading", () => {
  it("keeps an unrecognized rendered page protected rather than claiming a cached session", async () => {
    vi.useFakeTimers(); const { login, loaded, browser } = pendingPage();
    const evaluate = browser.evaluate;
    browser.evaluate = async <T>(code: string) => code.includes("globalThis.__vironLogin.tick(")
      ? { ok: true, released: false, value: { status: "anonymous" } } as T : evaluate<T>(code);
    loaded(); await vi.advanceTimersByTimeAsync(5000);
    expect(login.state).toMatchObject({ phase: "interactive", kind: "page" });
    expect(browser.destroy).not.toHaveBeenCalled(); login.dispose();
  });
  it("does not allow default assisted autofill after document or SPA route navigation", async () => {
    vi.useFakeTimers(); const { login, loaded, browser } = pendingPage();
    const evaluate = browser.evaluate, calls: string[] = [];
    browser.evaluate = async <T>(code: string) => { calls.push(code); return evaluate<T>(code); };
    loaded(); await vi.advanceTimersByTimeAsync(31_000);
    expect(calls.some((code) => code.includes("__vironLogin.assist(true)"))).toBe(true);
    browser.url = () => "https://console.example.test/#/settings";
    calls.length = 0; login.navigationStarted(true); await vi.advanceTimersByTimeAsync(500);
    expect(calls.some((code) => code.includes("__vironLogin.assist(false)"))).toBe(true);
    expect(calls.some((code) => code.includes("__vironLogin.assist(true)"))).toBe(false);
    calls.length = 0; login.navigationStarted(); await vi.advanceTimersByTimeAsync(500);
    expect(calls.some((code) => code.includes("__vironLogin.assist(false)"))).toBe(true);
    expect(login.state.phase).toBe("interactive"); login.dispose();
  });
  it("recovers from a credential-overlapping verification crop without exposing or destroying the authentication document", async () => {
    vi.useFakeTimers(); const { login, loaded, browser } = pendingPage();
    const evaluate = browser.evaluate;
    browser.evaluate = async <T>(code: string) => code.includes("globalThis.__vironLogin.tick(")
      ? { ok: false, code: "unsafe-region", released: true } as T : evaluate<T>(code);
    loaded(); await vi.advanceTimersByTimeAsync(600);
    expect(login.state).toMatchObject({ phase: "interactive", kind: "page" });
    expect(browser.destroy).not.toHaveBeenCalled();
    expect(JSON.stringify(login.state)).not.toContain("fixture-secret");
    login.dispose();
  });
  it("rejects manual handoff if the current address exposes the managed password", async () => {
    vi.useFakeTimers(); const { login, loaded, browser } = pendingPage();
    loaded(); await vi.advanceTimersByTimeAsync(31_000);
    expect(login.state.kind).toBe("page");
    browser.url = () => "https://console.example.test/?password=fixture-secret";
    await login.input({ type: "continue", revision: login.state.revision });
    expect(login.state.phase).toBe("failed");
    expect(browser.destroy).toHaveBeenCalled();
    expect(JSON.stringify(login.state)).not.toContain("fixture-secret");
    login.dispose();
  });
  it("excludes document loading time from the subsequent authentication wait", async () => {
    vi.useFakeTimers(); const { login, loaded } = pendingPage();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(login.state).toMatchObject({ phase: "loading", pageLoading: true });
    loaded(); await vi.advanceTimersByTimeAsync(2000);
    expect(login.state).toMatchObject({ phase: "authenticating", pageLoading: false });
    login.navigationStarted(true);
    expect(login.state.pageLoading).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(login.state).toMatchObject({ phase: "interactive", kind: "page" });
    expect(login.state.message).toContain("自动登录未完成");
    login.dispose();
  });
  it("reports an unfinished document load as a page timeout and destroys its window", async () => {
    vi.useFakeTimers(); const { login, loaded, browser } = pendingPage();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(login.state).toMatchObject({ phase: "failed", pageLoading: false });
    expect(login.state.message).toContain("网页加载超时");
    expect(browser.destroy).toHaveBeenCalled();
    loaded(); await vi.advanceTimersByTimeAsync(500);
    expect(login.state.phase).toBe("failed");
    login.dispose();
  });
});
