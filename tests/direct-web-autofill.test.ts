import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { DirectWebAutofill, DIRECT_WEB_FILL_MESSAGE, DIRECT_WEB_FILL_MISSING, DIRECT_WEB_FILL_ORIGIN } from "../src/shared/direct-web-autofill.js";
import { defaultWebLoginConfig } from "../src/shared/protected-web-login.js";

describe("administrator-selected direct Web fill", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function fixture(selectors = {}, html = '<form><input name="username"><input type="password"><button>Login</button></form>') {
    const window = new Window({ url: "https://console.example.test/" });
    Object.defineProperty(window.performance, "timeOrigin", { value: 10, configurable: true });
    const render = (markup: string) => {
      window.document.body.innerHTML = markup;
      for (const node of window.document.querySelectorAll("*")) node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON() {} });
    };
    render(html);
    const changed = vi.fn();
    const state = { loading: false, destroyed: false };
    const browser = { loading: () => state.loading, destroyed: () => state.destroyed, evaluate: async <T>(source: string) => window.eval(source) as T };
    const helper = new DirectWebAutofill({ browser, entryUrl: window.location.href, config: { ...defaultWebLoginConfig(), mode: "direct", ...selectors },
      username: "fixture-user", password: "fixture-password", changed });
    return { window, state, helper, changed, render };
  }
  it("fills editable fields without submitting or freezing them, then discards retained secrets", async () => {
    const { window, helper, changed } = fixture();
    const submit = vi.fn((event: Event) => event.preventDefault());
    window.document.querySelector("form")!.addEventListener("submit", submit);
    await vi.advanceTimersByTimeAsync(500);
    const password = window.document.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(password.value).toBe("fixture-password"); expect(password.readOnly).toBe(false);
    password.type = "text"; expect(password.value).toBe("fixture-password");
    expect(submit).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledWith(DIRECT_WEB_FILL_MESSAGE);
    expect((helper as unknown as { password: string }).password).toBe("");
    password.value = "manually-edited";
    await vi.advanceTimersByTimeAsync(12_000); expect(password.value).toBe("manually-edited");
  });
  it("waits for a delayed SPA form and honors unique custom selectors", async () => {
    const { window, render, changed } = fixture({ usernameSelector: "#alpha", passwordSelector: "#beta" }, '<main>Starting console</main>');
    await vi.advanceTimersByTimeAsync(1000);
    render('<input id="alpha"><input id="beta" type="password"><button>Continue</button>');
    await vi.advanceTimersByTimeAsync(500);
    expect(window.document.querySelector<HTMLInputElement>("#alpha")!.value).toBe("fixture-user");
    expect(window.document.querySelector<HTMLInputElement>("#beta")!.value).toBe("fixture-password");
    expect(changed).toHaveBeenCalledWith(DIRECT_WEB_FILL_MESSAGE);
  });
  it("does not follow a route change or a new document into password settings", async () => {
    for (const navigation of ["route", "document"]) {
      const { window, render, changed } = fixture({}, '<main>Loading</main>');
      await vi.advanceTimersByTimeAsync(500);
      if (navigation === "route") window.location.hash = "#/settings";
      else Object.defineProperty(window.performance, "timeOrigin", { value: 20 });
      render('<input name="username"><input type="password"><button>Login</button>');
      await vi.advanceTimersByTimeAsync(12_000);
      expect(window.document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
      expect(changed).not.toHaveBeenCalled();
    }
  });
  it("leaves unrecognized or readonly forms usable and never writes to a foreign origin", async () => {
    const unknown = fixture({ passwordSelector: "#beta" }, '<input id="beta" readonly type="password"><button>Continue</button>');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(unknown.window.document.querySelector<HTMLInputElement>("#beta")!.value).toBe("");
    expect(unknown.changed).toHaveBeenCalledWith(DIRECT_WEB_FILL_MISSING);
    const foreign = fixture(); foreign.window.location.href = "https://other.example.test/login";
    await vi.advanceTimersByTimeAsync(500);
    expect(foreign.window.document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(foreign.changed).toHaveBeenCalledWith(DIRECT_WEB_FILL_ORIGIN);
  });
  it("cancels pending fill when its page is closed", async () => {
    const { helper, window, changed } = fixture();
    helper.dispose(); await vi.advanceTimersByTimeAsync(11_000);
    expect(window.document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(changed).not.toHaveBeenCalled();
  });
  it("checks the origin and document again inside the actual credential-writing script", async () => {
    const window = new Window({ url: "https://console.example.test/login" });
    window.document.body.innerHTML = '<input name="username"><input type="password"><button>Login</button>';
    for (const node of window.document.querySelectorAll("*")) node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON() {} });
    const changed = vi.fn();
    const helper = new DirectWebAutofill({ entryUrl: window.location.href, config: defaultWebLoginConfig(), username: "fixture-user", password: "fixture-password", changed,
      browser: { destroyed: () => false, loading: () => false, evaluate: async <T>(source: string) => {
        if (source.includes("const bytes")) window.location.href = "https://foreign.example.test/login";
        return window.eval(source) as T;
      } },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(window.document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    helper.dispose();
  });
});
