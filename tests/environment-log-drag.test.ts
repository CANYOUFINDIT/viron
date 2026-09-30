/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({
  user: { id: "user-a", username: "a", isPlatformAdmin: true, createdAt: "" },
  workspace: { type: "personal" as const, id: "user-a", name: "个人", role: "owner" as "owner" | "member" },
  workspaces: [],
  loaded: true,
}));

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/session", () => ({ session: sessionState }));

import { api } from "../src/client/api";
import EnvironmentLogPanel from "../src/client/components/EnvironmentLogPanel.vue";
import { i18nPlugin, language } from "../src/client/i18n";

const mockedApi = vi.mocked(api);

afterEach(() => {
  sessionState.workspace.role = "owner";
  language.value = "zh-CN";
  vi.clearAllMocks();
});

function logItem(id: string, name: string) {
  return {
    id,
    environmentId: "env-1",
    sshConnectionId: "ssh-1",
    name,
    filePath: `/var/log/${id}.log`,
    filePaths: [`/var/log/${id}.log`],
    connectionName: "server",
    host: "10.0.0.8",
    port: 22,
    username: "root",
    connectionAvailable: true,
    createdAt: "",
    updatedAt: "",
  };
}

function dragEvent(type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", dropEffect: "", setData: vi.fn() } });
  Object.defineProperty(event, "clientY", { value: 0 });
  return event;
}

async function mountLogs() {
  language.value = "zh-CN";
  mockedApi.mockImplementation(async (path) => {
    const url = String(path);
    if (url.includes("/logs/order")) return { ok: true } as never;
    if (url.includes("/logs")) return { items: [logItem("log-a", "Alpha"), logItem("log-b", "Beta")] } as never;
    if (url.includes("/connections")) return { items: [] } as never;
    throw new Error(`Unexpected request: ${url}`);
  });
  const wrapper = mount(EnvironmentLogPanel, {
    props: { environmentId: "env-1", executionEnabled: true },
    global: {
      plugins: [i18nPlugin],
      directives: { loading: { mounted() {} } },
      stubs: {
        "el-dialog": true,
        "el-select": true,
        "el-option": true,
        "el-dropdown": { template: "<div><slot /></div>" },
        "el-button": true,
        "el-form": true,
        "el-form-item": true,
        "el-input": true,
        "el-tooltip": true,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

describe("environment log list dragging", () => {
  it("reorders the catalog and saves the full environment order", async () => {
    const wrapper = await mountLogs();
    expect(wrapper.findAll(".log-config-item strong").map((node) => node.text())).toEqual(["Alpha", "Beta"]);
    expect(wrapper.get(".log-config-item").attributes("draggable")).toBe("true");
    expect(wrapper.get(".log-config-item__main").attributes("title")).toContain("拖动可调整顺序");

    const cards = wrapper.findAll(".log-config-item");
    cards[1]!.element.dispatchEvent(dragEvent("dragstart"));
    cards[0]!.element.dispatchEvent(dragEvent("dragover"));
    cards[0]!.element.dispatchEvent(dragEvent("drop"));
    await flushPromises();

    expect(wrapper.findAll(".log-config-item strong").map((node) => node.text())).toEqual(["Beta", "Alpha"]);
    expect(mockedApi).toHaveBeenCalledWith("/api/v1/environments/env-1/logs/order", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ orderedIds: ["log-b", "log-a"] }),
    }));
    wrapper.unmount();
  });

  it("does not reorder when the drag starts on the log menu or the user cannot manage the workspace", async () => {
    const wrapper = await mountLogs();
    const cards = wrapper.findAll(".log-config-item");
    cards[1]!.get(".log-config-item__menu").element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    cards[1]!.element.dispatchEvent(dragEvent("dragstart"));
    cards[0]!.element.dispatchEvent(dragEvent("drop"));
    await flushPromises();
    expect(wrapper.findAll(".log-config-item strong").map((node) => node.text())).toEqual(["Alpha", "Beta"]);
    expect(mockedApi).not.toHaveBeenCalledWith("/api/v1/environments/env-1/logs/order", expect.anything());
    wrapper.unmount();

    sessionState.workspace.role = "member";
    const member = await mountLogs();
    expect(member.get(".log-config-item").attributes("draggable")).toBe("false");
    expect(member.get(".log-config-item__main").attributes("title")).not.toContain("拖动可调整顺序");
    member.unmount();
  });
});
