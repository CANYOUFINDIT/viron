/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

vi.mock("../src/client/api", () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock("../src/client/session", () => ({
  session: { workspace: { role: "owner" } },
}));

import { api } from "../src/client/api";
import { i18nPlugin } from "../src/client/i18n";
import MonitoringView from "../src/client/views/MonitoringView.vue";

const mockedApi = vi.mocked(api);

afterEach(() => {
  vi.clearAllMocks();
});

describe("monitoring overview abort", () => {
  it("aborts an in-flight overview request when leaving the monitoring page", async () => {
    const aborted: boolean[] = [];
    mockedApi.mockImplementation(async (path: string, init?: { signal?: AbortSignal }) => {
      if (String(path).includes("/monitoring/overview")) {
        return await new Promise((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted.push(true);
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
      if (String(path).includes("/monitor-alerts")) return { items: [] };
      if (String(path).includes("/environments")) return { items: [{ id: "env-1", name: "env" }] };
      return {};
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { name: "monitoring", path: "/monitoring", component: MonitoringView },
        { name: "overview", path: "/", component: { template: "<div class='home'>home</div>" } },
      ],
    });
    await router.push({ name: "monitoring", query: { view: "overview" } });
    const wrapper = mount(MonitoringView, {
      global: {
        plugins: [router, i18nPlugin],
        stubs: {
          PageHeader: { template: "<div><slot name='actions' /></div>" },
          HostFleetPanel: true,
          AlertServicePanel: true,
          NocScreen: true,
          "el-select": true,
          "el-option": true,
          "el-button": true,
        },
      },
    });
    await flushPromises();
    await router.push({ name: "overview" });
    await flushPromises();
    wrapper.unmount();
    expect(aborted[0]).toBe(true);
  });
});
