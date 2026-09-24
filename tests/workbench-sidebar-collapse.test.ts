/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({ api: vi.fn(async () => ({ items: [] })) }));
vi.mock("../src/client/session", () => ({ session: { user: { id: "user-a" } } }));
vi.mock("../src/client/components/SshTerminalPane.vue", () => ({ default: { template: "<div />" } }));

import SshWorkbench from "../src/client/components/SshWorkbench.vue";
import EnvironmentLogPanel from "../src/client/components/EnvironmentLogPanel.vue";
import { i18nPlugin } from "../src/client/i18n";

const saved = new Map<string, string>();
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
  removeItem: (key: string) => { saved.delete(key); },
};

beforeEach(() => vi.stubGlobal("localStorage", storage));
afterEach(() => {
  saved.clear();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const stubs = {
  "el-input": true,
  "el-dropdown": true,
  "el-dropdown-menu": true,
  "el-dropdown-item": true,
  "el-button": true,
  "el-dialog": true,
};

function pointer(type: string, clientX: number) {
  return new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX });
}

describe("workbench sidebars", () => {
  it("shrinks the SSH connection list before collapsing and restores it with the button", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/ssh", component: SshWorkbench }] });
    await router.push("/ssh");
    const wrapper = mount(SshWorkbench, {
      props: { active: false },
      global: { plugins: [router, i18nPlugin], directives: { loading: () => undefined }, stubs },
    });
    try {
      await flushPromises();
      const workbench = wrapper.get(".ssh-workbench").element as HTMLElement;
      workbench.getBoundingClientRect = () => ({ left: 100, right: 1100, width: 1000 } as DOMRect);
      wrapper.get(".workbench-sidebar-resizer").element.dispatchEvent(pointer("pointerdown", 380));
      document.dispatchEvent(pointer("pointermove", 260));
      await nextTick();
      expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("160px");
      expect(wrapper.find(".ssh-hosts").exists()).toBe(true);

      document.dispatchEvent(pointer("pointermove", 210));
      await nextTick();
      expect(wrapper.find(".ssh-hosts").exists()).toBe(false);
      expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("280px");
      await wrapper.get(".workbench-sidebar-restore").trigger("click");
      expect(wrapper.find(".ssh-hosts").exists()).toBe(true);
      expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("280px");
    } finally {
      wrapper.unmount();
    }
  });

  it("shrinks the log catalog before collapsing and restores it with the button", async () => {
    const wrapper = mount(EnvironmentLogPanel, {
      props: { environmentId: "env-1", executionEnabled: true },
      global: { plugins: [i18nPlugin], directives: { loading: () => undefined }, stubs },
    });
    try {
      await flushPromises();
      const panel = wrapper.get(".environment-log-panel").element as HTMLElement;
      panel.getBoundingClientRect = () => ({ left: 100, right: 1100, width: 1000 } as DOMRect);
      wrapper.get(".log-catalog-resizer").element.dispatchEvent(pointer("pointerdown", 320));
      document.dispatchEvent(pointer("pointermove", 260));
      await nextTick();
      expect(panel.style.getPropertyValue("--log-catalog-width")).toBe("160px");
      expect(wrapper.find(".log-catalog").exists()).toBe(true);

      document.dispatchEvent(pointer("pointerup", 210));
      await nextTick();
      expect(wrapper.find(".log-catalog").exists()).toBe(false);
      expect(panel.style.getPropertyValue("--log-catalog-width")).toBe("220px");
      await wrapper.get(".log-catalog-restore").trigger("click");
      expect(wrapper.find(".log-catalog").exists()).toBe(true);
      expect(panel.style.getPropertyValue("--log-catalog-width")).toBe("220px");
    } finally {
      wrapper.unmount();
    }
  });
});
