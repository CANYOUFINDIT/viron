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

import { i18nPlugin, translate } from "../src/client/i18n";
import AppShell from "../src/client/components/AppShell.vue";

function mockMatchMedia({
  reducedMotion = false,
  narrow = false,
  hoverNone = false,
}: { reducedMotion?: boolean; narrow?: boolean; hoverNone?: boolean } = {}) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion
      : query.includes("max-width: 900px") ? narrow
        : query.includes("(hover: none)") ? hoverNone
          : false,
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

describe("collapsed sidebar hover expand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands the collapsed sidebar on pointer enter and collapses it on leave", async () => {
    mockMatchMedia();
    const wrapper = await mountShell(vi.fn(), vi.fn());

    await wrapper.get(".sidebar-toggle").trigger("click");
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");

    await wrapper.get(".app-sidebar").trigger("pointerenter");
    await flushPromises();
    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");

    await wrapper.get(".app-sidebar").trigger("pointerleave");
    await flushPromises();
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");
    wrapper.unmount();
  });

  it("does not collapse a pinned sidebar when the pointer leaves", async () => {
    mockMatchMedia();
    const wrapper = await mountShell(vi.fn(), vi.fn());

    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");
    await wrapper.get(".app-sidebar").trigger("pointerleave");
    await flushPromises();
    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");
    wrapper.unmount();
  });

  it("pins a hover-expanded sidebar when clicking the toggle and keeps it open on leave", async () => {
    mockMatchMedia();
    const wrapper = await mountShell(vi.fn(), vi.fn());

    await wrapper.get(".sidebar-toggle").trigger("click");
    await wrapper.get(".app-sidebar").trigger("pointerenter");
    expect(wrapper.get(".sidebar-toggle").attributes("aria-label")).toBe(translate("固定左侧菜单"));
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-pinned");

    await wrapper.get(".sidebar-toggle").trigger("click");
    await wrapper.get(".app-sidebar").trigger("pointerleave");
    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-expanded");
    expect(wrapper.get(".app-frame").classes()).toContain("is-sidebar-pinned");
    expect(wrapper.get(".sidebar-toggle").attributes("aria-label")).toBe(translate("收起左侧菜单"));

    await wrapper.get(".sidebar-toggle").trigger("click");
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-pinned");
    wrapper.unmount();
  });

  it("does not expand the sidebar when clicking the workspace switcher", async () => {
    mockMatchMedia();
    const wrapper = await mountShell(vi.fn(), vi.fn());

    await wrapper.get(".sidebar-toggle").trigger("click");
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");
    await wrapper.get(".workspace-switcher__trigger").trigger("click");
    await flushPromises();
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");
    expect(wrapper.getComponent({ name: "ElDropdown" }).props("placement")).toBe("right-start");
    expect(wrapper.getComponent({ name: "ElDropdown" }).props("popperOptions").modifiers).toEqual(
      expect.arrayContaining([{ name: "flip", enabled: false }]),
    );
    wrapper.unmount();
  });

  it("does not hover-expand on narrow viewports", async () => {
    mockMatchMedia({ narrow: true });
    const wrapper = await mountShell(vi.fn(), vi.fn());

    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");
    await wrapper.get(".app-sidebar").trigger("pointerenter");
    await flushPromises();
    expect(wrapper.get(".app-frame").classes()).not.toContain("is-sidebar-expanded");
    wrapper.unmount();
  });
});
