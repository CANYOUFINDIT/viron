/** @vitest-environment happy-dom */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/components/AppShell.vue", () => ({ default: { template: "<main><slot /></main>" } }));
vi.mock("../src/client/components/EnvironmentWorkspaceHost.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../src/client/theme", async () => ({ theme: (await import("vue")).ref("light") }));

import App from "../src/client/App.vue";
import { desktopAppState, selectDesktopEndpoint } from "../src/client/desktop";
import { i18nPlugin, language } from "../src/client/i18n";
import { router } from "../src/client/router";
import { clearSession, login, session } from "../src/client/session";

const endpointA = "https://endpoint-a.example.test";
const endpointB = "https://endpoint-b.example.test";
const auth = {
  user: { id: "fixture-user", username: "fixture", isPlatformAdmin: false, createdAt: "2026-01-01" },
  workspace: { type: "personal" as const, id: "fixture-user", name: "Fixture", role: "owner" as const },
  workspaces: [],
};
const bridge = {
  getState: vi.fn(), setEndpoint: vi.fn(), clearEndpoint: vi.fn(), request: vi.fn(), setTitleBarTheme: vi.fn(),
};
let wrapper: VueWrapper | undefined;

function showRouteError() {
  window.__envmanRouteErrorMessage = "无法连接 Endpoint：net::ERR_CONNECTION_REFUSED";
  window.dispatchEvent(new CustomEvent("envman:route-error", { detail: { message: window.__envmanRouteErrorMessage } }));
}

function mountApp() {
  wrapper = mount(App, { global: {
    plugins: [router, i18nPlugin],
    stubs: {
      "el-config-provider": { template: "<div><slot /></div>" },
      "el-button": { props: ["disabled", "loading"], template: "<button :disabled='disabled || loading'><slot /></button>" },
    },
  } });
  return wrapper;
}

beforeEach(async () => {
  vi.clearAllMocks();
  language.value = "zh-CN";
  window.vironDesktop = bridge as unknown as NonNullable<Window["vironDesktop"]>;
  delete window.__envmanRouteErrorMessage;
  clearSession();
  session.loaded = false;
  bridge.getState.mockResolvedValue({ endpoint: null, recentEndpoint: endpointA });
  bridge.setEndpoint.mockResolvedValue({ ok: false, error: { message: "net::ERR_CONNECTION_REFUSED" } });
  bridge.clearEndpoint.mockResolvedValue({ endpoint: null, recentEndpoint: endpointA });
  bridge.request.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
  router.addRoute({ path: "/login", name: "login", meta: { public: true }, component: { template: "<form class='fixture-login'>Viron Endpoint</form>" } });
  router.addRoute({ path: "/monitoring", name: "monitoring", component: { template: "<div class='fixture-monitoring'>Dashboard</div>" } });
  await router.replace({ name: "login" });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  delete window.vironDesktop;
  delete window.__envmanRouteErrorMessage;
  clearSession();
  session.loaded = false;
  desktopAppState.value = null;
  vi.restoreAllMocks();
});

describe("offline desktop Endpoint recovery", () => {
  it("opens the login route without verifying an offline saved Endpoint", async () => {
    const app = mountApp();
    await flushPromises();
    expect(app.find(".fixture-login").exists()).toBe(true);
    expect(bridge.setEndpoint).not.toHaveBeenCalled();
    expect(bridge.request).not.toHaveBeenCalled();
    expect(session.loaded).toBe(false);
  });

  it("escapes a failed startup even when the current route is already login, then connects to B", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = mountApp();
    await expect(router.push({ name: "overview" })).rejects.toThrow("net::ERR_CONNECTION_REFUSED");
    await flushPromises();
    expect(app.find(".route-error-state").exists()).toBe(true);
    expect(session.loaded).toBe(false);
    const logoutButton = app.findAll("button").find((button) => button.text() === "退出登录")!;
    await logoutButton.trigger("click");
    await flushPromises();

    expect(app.find(".fixture-login").exists()).toBe(true);
    expect(app.find(".route-error-state").exists()).toBe(false);
    expect(window.__envmanRouteErrorMessage).toBeUndefined();
    expect(bridge.clearEndpoint).toHaveBeenCalledOnce();
    expect(bridge.setEndpoint).toHaveBeenCalledExactlyOnceWith(endpointA);
    expect(bridge.request).not.toHaveBeenCalled();
    expect(session.loaded).toBe(true);

    bridge.setEndpoint.mockResolvedValue({ ok: true, state: { endpoint: endpointB, recentEndpoint: endpointB } });
    bridge.request.mockResolvedValue({ status: 200, body: JSON.stringify(auth), headers: [] });
    await selectDesktopEndpoint(endpointB);
    await login("fixture", "fixture-password");
    await router.replace({ name: "monitoring" });
    await flushPromises();
    expect(app.find(".fixture-monitoring").exists()).toBe(true);
    expect(desktopAppState.value?.endpoint).toBe(endpointB);
    expect(session.user?.id).toBe(auth.user.id);
  });

  it("offers logout from a protected page error and removes the authenticated shell", async () => {
    session.user = auth.user;
    session.workspace = auth.workspace;
    session.loaded = true;
    await router.replace({ name: "monitoring" });
    const app = mountApp();
    showRouteError();
    await flushPromises();

    const logoutButton = app.findAll("button").find((button) => button.text() === "退出登录")!;
    await logoutButton.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("login");
    expect(app.find(".fixture-login").exists()).toBe(true);
    expect(session.user).toBeNull();
    expect(bridge.request).not.toHaveBeenCalled();
  });
});
