import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectedLoginController, type ProtectedLoginBrowser } from "../src/shared/protected-web-login-controller.js";

afterEach(() => vi.useRealTimers());

function pendingPage() {
  let loaded!: () => void;
  const load = new Promise<void>((resolve) => { loaded = resolve; });
  const browser: ProtectedLoginBrowser = {
    load: () => load, url: () => "https://console.example.test/#/login", loading: () => false,
    destroyed: () => false, destroy: vi.fn(), cookies: async () => [], clear: async () => {},
    mouse: async () => {}, text: async () => {}, key: async () => {}, capture: async () => "",
    evaluate: async <T>(code: string) => ({ ok: true, released: false,
      value: code.includes("globalThis.__vironLogin.tick(") ? { status: "waiting" }
        : code.includes('String(performance.timeOrigin)') ? "document"
          : code.includes("globalThis.__vironLogin.secretReleased()") ? false : undefined,
    }) as T,
  };
  const login = new ProtectedLoginController({ browser, url: browser.url(), username: "fixture-user", password: "fixture-secret", changed: vi.fn(), completed: vi.fn() });
  return { login, loaded, browser };
}

describe("protected login page loading", () => {
  it("excludes document loading time from the subsequent authentication wait", async () => {
    vi.useFakeTimers(); const { login, loaded } = pendingPage();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(login.state).toMatchObject({ phase: "loading", pageLoading: true });
    loaded(); await vi.advanceTimersByTimeAsync(2000);
    expect(login.state).toMatchObject({ phase: "authenticating", pageLoading: false });
    login.navigationStarted(true);
    expect(login.state.pageLoading).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(login.state.phase).toBe("failed");
    expect(login.state.message).toContain("登录流程等待超时");
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
