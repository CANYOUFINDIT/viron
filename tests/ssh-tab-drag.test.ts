/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/session", () => ({ session: { user: { id: "user-a" } } }));
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
import { i18nPlugin } from "../src/client/i18n";
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
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  storage.clear();
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
