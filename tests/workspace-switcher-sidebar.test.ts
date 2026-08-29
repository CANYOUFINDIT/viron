/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

vi.hoisted(() => {
  const createStorage = () => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() { return store.size; },
    };
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: createStorage() });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createStorage() });
});

vi.mock("../src/client/desktop", () => ({
  isDesktopApp: () => false,
}));
vi.mock("../src/client/keyboard-shortcuts", () => ({
  initializeAppShortcuts: vi.fn(async () => undefined),
  onAppShortcut: () => () => undefined,
  shortcutActionFromKeyboardEvent: () => null,
}));
vi.mock("../src/client/history-navigation", () => ({
  installHistoryNavigationGestures: () => () => undefined,
}));
vi.mock("../src/client/visit-history", () => ({
  installVisitHistory: () => () => undefined,
  visitHistoryCanNavigate: () => false,
  visitHistoryNavigate: vi.fn(),
}));
vi.mock("../src/client/active-connections", () => ({
  activeConnections: { current: 0, limit: 30, items: [] },
  loadActiveConnections: vi.fn(async () => undefined),
}));
vi.mock("../src/client/agent-host", () => ({
  agentNativeOverlayActive: { value: false },
}));
vi.mock("../src/client/session", () => ({
  session: {
    user: { id: "u1", username: "futongyong", isPlatformAdmin: true, createdAt: "" },
    workspace: { type: "personal", id: "p1", name: "personal", role: "owner" },
    workspaces: [
      { type: "personal", id: "p1", name: "personal", role: "owner" },
      { type: "organization", id: "o1", name: "onepro", role: "admin" },
    ],
    loaded: true,
  },
  switchWorkspace: vi.fn(),
}));

import { i18nPlugin } from "../src/client/i18n";
import AppShell from "../src/client/components/AppShell.vue";

function mockMatchMedia(reducedMotion: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

async function mountShell(handleOpen: ReturnType<typeof vi.fn>, handleClose: ReturnType<typeof vi.fn>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { name: "overview", path: "/", component: { template: "<div />" } },
      { name: "settings", path: "/settings", component: { template: "<div />" } },
      { name: "active-connections", path: "/active-connections", component: { template: "<div />" } },
      { name: "client-downloads", path: "/client-downloads", component: { template: "<div />" } },
      { name: "environment", path: "/environments/:id", component: { template: "<div />" } },
    ],
  });
  await router.push({ name: "overview" });
  const DropdownStub = defineComponent({
    name: "ElDropdown",
    props: ["popperOptions", "placement"],
    setup(_, { slots, expose }) {
      expose({ handleOpen, handleClose });
      return () => h("div", { class: "el-dropdown" }, [slots.default?.(), slots.dropdown?.()]);
    },
  });
  return mount(AppShell, {
    global: {
      plugins: [router, i18nPlugin],
      stubs: {
        AgentFloatingWindow: true,
        HistoryNavigationOverlay: true,
        AgentHostBridge: true,
        ActiveEnvironmentDockWindow: true,
        ConnectionQualityWindow: true,
        MonitorAlertCenter: true,
        "el-dropdown": DropdownStub,
        "el-dropdown-menu": { template: "<div><slot /></div>" },
        "el-dropdown-item": { template: "<div><slot /></div>" },
      },
    },
  });
}

describe("workspace switcher sidebar sequence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands the collapsed sidebar before opening the workspace list", async () => {
    mockMatchMedia(false);
    const handleOpen = vi.fn();
    const handleClose = vi.fn();
    const wrapper = await mountShell(handleOpen, handleClose);

    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");
    await wrapper.get(".sidebar-toggle").trigger("click");
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");

    await wrapper.get(".workspace-switcher__trigger").trigger("click");
    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");
    expect(wrapper.getComponent({ name: "ElDropdown" }).props("placement")).toBe("right-start");
    expect(wrapper.getComponent({ name: "ElDropdown" }).props("popperOptions").modifiers).toEqual(
      expect.arrayContaining([{ name: "flip", enabled: false }]),
    );
    expect(handleOpen).not.toHaveBeenCalled();

    wrapper.get(".app-sidebar__panel").element.dispatchEvent(new Event("transitionend"));
    await flushPromises();
    expect(handleOpen).not.toHaveBeenCalled();

    const clipPathEnd = new Event("transitionend");
    Object.defineProperty(clipPathEnd, "propertyName", { value: "clip-path" });
    wrapper.get(".app-sidebar__panel").element.dispatchEvent(clipPathEnd);
    await flushPromises();
    expect(handleOpen).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("does not programmatically open the list when the sidebar is already expanded", async () => {
    mockMatchMedia(false);
    const handleOpen = vi.fn();
    const handleClose = vi.fn();
    const wrapper = await mountShell(handleOpen, handleClose);

    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");
    await wrapper.get(".workspace-switcher__trigger").trigger("click");
    await flushPromises();
    expect(handleOpen).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("opens the workspace list after expanding when motion is reduced", async () => {
    mockMatchMedia(true);
    const handleOpen = vi.fn();
    const handleClose = vi.fn();
    const wrapper = await mountShell(handleOpen, handleClose);

    await wrapper.get(".sidebar-toggle").trigger("click");
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");
    await wrapper.get(".workspace-switcher__trigger").trigger("click");
    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");
    await flushPromises();
    expect(handleOpen).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
