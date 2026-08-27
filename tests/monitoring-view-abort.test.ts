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

describe("monitoring timeseries abort", () => {
  it("aborts an in-flight timeseries request when leaving the service scope", async () => {
    const aborted: boolean[] = [];
    let resolveOverview: ((value: unknown) => void) | undefined;
    mockedApi.mockImplementation(async (path: string, init?: { signal?: AbortSignal }) => {
      if (String(path).includes("/monitoring/services/") && String(path).includes("/timeseries")) {
        return await new Promise((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted.push(true);
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
          });
          setTimeout(() => resolve({ points: [{ at: "stale-point", cpuUsedPercent: 99, memoryBytes: 1 }] }), 200);
        });
      }
      if (String(path).includes("/monitoring/overview")) {
        return await new Promise((resolve) => {
          resolveOverview = resolve;
          resolve({
            generatedAt: new Date().toISOString(),
            partialFailures: [],
            summary: { hostTotal: 0, hostOnline: 0, hostOffline: 0, hostMissing: 0, hostStale: 0, serviceTotal: 1, avgCpuPercent: null, avgMemoryPercent: null, diskAlerts: 0 },
            hosts: [],
            services: [{ id: "svc-1", name: "api", status: "active", environmentId: "env-1", environmentName: "env", deploymentCount: 1, runningCount: 1, problemCount: 0, cpuUsedPercent: 1, memoryBytes: 1, health: "running" }],
            serviceRanking: [],
            problemNodes: [],
          });
        });
      }
      if (String(path).includes("/monitor-alerts")) return { items: [] };
      if (String(path).includes("/environments")) return { items: [{ id: "env-1", name: "env" }] };
      return {};
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ name: "monitoring", path: "/monitoring", component: MonitoringView }],
    });
    await router.push({ name: "monitoring", query: { view: "services", serviceId: "svc-1" } });
    const wrapper = mount(MonitoringView, {
      global: {
        plugins: [router, i18nPlugin],
        stubs: {
          PageHeader: { template: "<div><slot name='actions' /></div>" },
          HostFleetPanel: true,
          ServiceApmPanel: { props: ["points"], template: "<div class='apm'>{{ JSON.stringify(points) }}</div>" },
          NocScreen: true,
          "el-select": true,
          "el-option": true,
          "el-button": true,
        },
      },
    });
    await flushPromises();
    await router.replace({ name: "monitoring", query: { view: "hosts" } });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborted[0]).toBe(true);
    expect(wrapper.text()).not.toContain("stale-point");
    resolveOverview?.({
      generatedAt: new Date().toISOString(),
      partialFailures: [],
      summary: { hostTotal: 0, hostOnline: 0, hostOffline: 0, hostMissing: 0, hostStale: 0, serviceTotal: 0, avgCpuPercent: null, avgMemoryPercent: null, diskAlerts: 0 },
      hosts: [],
      services: [],
      serviceRanking: [],
      problemNodes: [],
    });
    wrapper.unmount();
  });
});
