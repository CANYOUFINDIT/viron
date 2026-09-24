/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const desktop = vi.hoisted(() => ({ listener: null as ((event: unknown) => void) | null }));

vi.mock("../src/client/api", () => ({ api: vi.fn(async (path: string) => path.includes("/logs")
  ? { items: [{ id: "log-1", environmentId: "env-1", sshConnectionId: "ssh-1", name: "app.log", filePath: "/tmp/app.log", filePaths: ["/tmp/app.log"], connectionName: "server", host: "example.test", port: 22, username: "test", connectionAvailable: true, createdAt: "", updatedAt: "" }] }
  : { items: [] }) }));
vi.mock("../src/client/desktop", () => ({
  onDesktopLogStreamEvent: vi.fn((listener: (event: unknown) => void) => { desktop.listener = listener; return () => { desktop.listener = null; }; }),
  openDesktopLogStream: vi.fn(async () => ({ activeConnectionId: "connection-1", stream: { id: "stream-1", filePaths: ["/tmp/app.log"] } })),
  closeDesktopLogStream: vi.fn(async () => {}),
  saveTextFile: vi.fn(async () => true),
}));

import EnvironmentLogPanel from "../src/client/components/EnvironmentLogPanel.vue";
import { i18nPlugin, language } from "../src/client/i18n";

afterEach(() => { desktop.listener = null; });

describe("log viewer manual line breaks", () => {
  it("keeps repeated Enter breaks when another log chunk arrives", async () => {
    language.value = "zh-CN";
    const mountPoint = document.createElement("div");
    document.body.append(mountPoint);
    const wrapper = mount(EnvironmentLogPanel, {
      props: { environmentId: "env-1", localExecution: true, executionEnabled: true },
      attachTo: mountPoint,
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
    try {
      await flushPromises();
      await wrapper.get(".log-config-item__main").trigger("dblclick");
      await flushPromises();
      expect(desktop.listener).not.toBeNull();
      const output = wrapper.get(".log-output").element;
      expect(document.activeElement).toBe(output);

      await wrapper.get('.log-viewer__footer input[type="checkbox"]').setValue(false);
      desktop.listener?.({ type: "output", logId: "log-1", data: "first" });
      await flushPromises();

      output.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      output.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, repeat: true }));
      await flushPromises();
      expect(wrapper.get(".log-output pre code").element.textContent).toBe("first\n\n\n");

      desktop.listener?.({ type: "output", logId: "log-1", data: "second\n" });
      await flushPromises();
      expect(wrapper.get(".log-output pre code").element.textContent).toBe("first\n\n\nsecond\n");
    } finally {
      wrapper.unmount();
      mountPoint.remove();
    }
  });
});
