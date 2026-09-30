/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({
  user: { id: "user-a" },
  workspace: { type: "personal" as const, id: "workspace-a", name: "Personal", role: "owner" as "owner" | "admin" | "member" },
}));

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/session", () => ({ session: sessionState }));
vi.mock("../src/client/components/SshTerminalPane.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({
    setup(_, { expose }) {
      expose({ fit: vi.fn(), focus: vi.fn() });
      return () => h("div", { class: "ssh-terminal-shell" });
    },
  }) };
});

import { api } from "../src/client/api";
import { i18nPlugin, language } from "../src/client/i18n";
import SshWorkbench from "../src/client/components/SshWorkbench.vue";

const mockedApi = vi.mocked(api);
const saved = new Map<string, string>();
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
  removeItem: (key: string) => { saved.delete(key); },
  clear: () => { saved.clear(); },
};

beforeEach(() => {
  language.value = "zh-CN";
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  storage.clear();
  sessionState.workspace.role = "owner";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function dragEvent(type: string, dataTransfer: object) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

describe("SSH session tab dragging", () => {
  it("moves a live tab into an empty split pane without closing the session", async () => {
    localStorage.setItem("envman:ssh-workbench:fixed:ssh:global", JSON.stringify({
      layout: "quad",
      sessionIds: ["session-a"],
      panes: { "session-a": 0 },
      activeByPane: { 0: "session-a" },
    }));
    mockedApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/v1/connections?")) return { items: [{ id: "connection-a", name: "Example host" }] } as never;
      if (path === "/api/v1/ssh-sessions") return { items: [{
        id: "session-a", connectionId: "connection-a", connectionName: "Example host",
        host: "example.invalid", createdAt: "2026-01-01T00:00:00.000Z", attached: true,
      }] } as never;
      if (path === "/api/v1/ssh-sessions/session-a/ticket") return { ticket: "ticket-a" } as never;
      if (String(path).startsWith("/api/v1/ssh-command-favorites?")) return { items: [] } as never;
      throw new Error(`Unexpected request: ${path}`);
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/ssh", component: SshWorkbench }],
    });
    await router.push("/ssh");
    const wrapper = mount(SshWorkbench, {
      props: { active: false },
      global: {
        plugins: [router, i18nPlugin],
        directives: { loading: () => undefined },
        stubs: {
          SshCommandHistoryPanel: true,
          ConnectionEditDialog: true,
          "el-input": true,
          "el-dropdown": true,
          "el-dropdown-menu": true,
          "el-dropdown-item": true,
        },
      },
    });
    await flushPromises();
    expect(wrapper.findAll(".terminal-cell")).toHaveLength(4);
    expect(wrapper.findAll(".terminal-cell")[0].find(".terminal-tab").exists()).toBe(true);

    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    wrapper.find(".terminal-tab").element.dispatchEvent(dragEvent("dragstart", dataTransfer));
    await nextTick();
    const destination = wrapper.findAll(".terminal-cell")[2];
    destination.element.dispatchEvent(dragEvent("dragover", dataTransfer));
    await nextTick();
    expect(destination.classes()).toContain("is-session-drop-target");
    destination.element.dispatchEvent(dragEvent("drop", dataTransfer));
    await flushPromises();

    expect(wrapper.findAll(".terminal-cell")[0].find(".terminal-tab").exists()).toBe(false);
    expect(wrapper.findAll(".terminal-cell")[2].find(".terminal-tab").text()).toContain("Example host");
    expect(wrapper.findAll(".terminal-cell")[2].find(".terminal-tab").classes()).toContain("is-active");
    expect(JSON.parse(localStorage.getItem("envman:ssh-workbench:fixed:ssh:global") ?? "{}").panes["session-a"]).toBe(2);
    expect(JSON.parse(localStorage.getItem("envman:ssh-workbench:fixed:ssh:global") ?? "{}").activeByPane[0]).toBe("");
    expect(mockedApi).not.toHaveBeenCalledWith("/api/v1/ssh-sessions/session-a", expect.objectContaining({ method: "DELETE" }));

    wrapper.findAll(".terminal-cell")[2].find(".terminal-tabs").element.dispatchEvent(dragEvent("dragstart", dataTransfer));
    wrapper.findAll(".terminal-cell")[0].element.dispatchEvent(dragEvent("dragover", dataTransfer));
    wrapper.findAll(".terminal-cell")[0].element.dispatchEvent(dragEvent("drop", dataTransfer));
    await flushPromises();
    expect(wrapper.findAll(".terminal-cell")[0].find(".terminal-tab").text()).toContain("Example host");
    expect(JSON.parse(localStorage.getItem("envman:ssh-workbench:fixed:ssh:global") ?? "{}").panes["session-a"]).toBe(0);
    wrapper.unmount();
  });
});

function hostConnection(overrides: Record<string, unknown>) {
  return {
    type: "ssh",
    host: "10.0.0.11",
    port: 22,
    username: "root",
    environmentId: null,
    environmentName: null,
    environmentIds: [],
    connectionGroupId: "group-dev",
    connectionGroupPath: "研发",
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    authType: "password",
    jumpConnectionId: null,
    tags: [],
    options: {},
    hasPassword: true,
    hasPrivateKey: false,
    ...overrides,
  };
}

function hostNames(wrapper: { findAll: (selector: string) => Array<{ text: () => string }> }) {
  return wrapper.findAll(".ssh-host-card strong").map((node) => node.text());
}

async function mountHostList(items: Array<Record<string, unknown>>, onOrder?: (body: unknown) => void) {
  mockedApi.mockImplementation(async (path, init) => {
    const url = String(path);
    if (url.startsWith("/api/v1/connections?")) return { items } as never;
    if (url === "/api/v1/ssh-sessions") return { items: [] } as never;
    if (url.startsWith("/api/v1/ssh-command-favorites")) return { items: [] } as never;
    if (url === "/api/v1/ssh-connections/order") {
      onOrder?.(JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}")));
      return { ok: true } as never;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/ssh", component: SshWorkbench }],
  });
  await router.push("/ssh");
  return mount(SshWorkbench, {
    props: { active: false },
    global: {
      plugins: [router, i18nPlugin],
      directives: { loading: () => undefined },
      stubs: {
        SshCommandHistoryPanel: true,
        ConnectionEditDialog: true,
        "el-input": true,
        "el-dropdown": { template: "<div><slot /></div>" },
        "el-dropdown-menu": true,
        "el-dropdown-item": true,
      },
    },
  });
}

describe("SSH connection list dragging", () => {
  it("reorders hosts inside one group and saves that visible order", async () => {
    const saved: unknown[] = [];
    const wrapper = await mountHostList([
      hostConnection({ id: "alpha", name: "Alpha", sortOrder: 0 }),
      hostConnection({ id: "beta", name: "Beta", sortOrder: 1, host: "10.0.0.12" }),
    ], (body) => saved.push(body));
    await flushPromises();
    expect(hostNames(wrapper)).toEqual(["Alpha", "Beta"]);
    expect(wrapper.get(".ssh-host-card").attributes("draggable")).toBe("true");
    expect(wrapper.get(".connection-card-main").attributes("title")).toContain("拖动可调整顺序");

    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    const cards = wrapper.findAll(".ssh-host-card");
    cards[1]!.element.dispatchEvent(dragEvent("dragstart", dataTransfer));
    cards[0]!.element.dispatchEvent(dragEvent("dragover", dataTransfer));
    cards[0]!.element.dispatchEvent(dragEvent("drop", dataTransfer));
    await flushPromises();

    expect(hostNames(wrapper)).toEqual(["Beta", "Alpha"]);
    expect(saved).toEqual([{ connectionGroupId: "group-dev", orderedIds: ["beta", "alpha"] }]);
    wrapper.unmount();
  });

  it("does not start a reorder from the connection menu", async () => {
    const saved: unknown[] = [];
    const wrapper = await mountHostList([
      hostConnection({ id: "alpha", name: "Alpha" }),
      hostConnection({ id: "beta", name: "Beta", sortOrder: 1, host: "10.0.0.12" }),
    ], (body) => saved.push(body));
    await flushPromises();
    const cards = wrapper.findAll(".ssh-host-card");
    cards[1]!.get(".connect-indicator").element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    cards[1]!.element.dispatchEvent(dragEvent("dragstart", dataTransfer));
    cards[0]!.element.dispatchEvent(dragEvent("dragover", dataTransfer));
    cards[0]!.element.dispatchEvent(dragEvent("drop", dataTransfer));
    await flushPromises();
    expect(hostNames(wrapper)).toEqual(["Alpha", "Beta"]);
    expect(saved).toEqual([]);
    expect(dataTransfer.setData).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("ignores a drop onto a host in another group", async () => {
    const saved: unknown[] = [];
    const wrapper = await mountHostList([
      hostConnection({ id: "alpha", name: "Alpha", connectionGroupId: "group-a", connectionGroupPath: "甲组" }),
      hostConnection({ id: "beta", name: "Beta", connectionGroupId: "group-b", connectionGroupPath: "乙组", host: "10.0.0.12" }),
    ], (body) => saved.push(body));
    await flushPromises();
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    const cards = wrapper.findAll(".ssh-host-card");
    cards[1]!.element.dispatchEvent(dragEvent("dragstart", dataTransfer));
    cards[0]!.element.dispatchEvent(dragEvent("dragover", dataTransfer));
    cards[0]!.element.dispatchEvent(dragEvent("drop", dataTransfer));
    await flushPromises();
    expect(hostNames(wrapper)).toEqual(["Alpha", "Beta"]);
    expect(saved).toEqual([]);
    wrapper.unmount();
  });

  it("keeps the list fixed for workspace members", async () => {
    sessionState.workspace.role = "member";
    const wrapper = await mountHostList([
      hostConnection({ id: "alpha", name: "Alpha" }),
    ]);
    await flushPromises();
    expect(wrapper.get(".ssh-host-card").attributes("draggable")).toBe("false");
    expect(wrapper.get(".connection-card-main").attributes("title")).not.toContain("拖动可调整顺序");
    wrapper.unmount();
  });
});
