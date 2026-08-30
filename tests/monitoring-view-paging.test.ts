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

function overview(hosts: Array<{ id: string; name: string }>, total = 20, extras: Record<string, unknown> = {}) {
  return {
    generatedAt: new Date().toISOString(),
    truncated: hosts.length < total,
    nextHostOffset: hosts.length < total ? 12 : null,
    partialFailures: [],
    summary: { hostTotal: total, hostOnline: total, hostOffline: 0, hostMissing: 0, hostStale: 0, serviceTotal: 0, avgCpuPercent: 10, avgMemoryPercent: 10, diskAlerts: 0 },
    hosts: hosts.map((host) => ({
      sshConnectionId: host.id,
      connectionName: host.name,
      host: "127.0.0.1",
      environmentId: "env-1",
      environmentName: "dev",
      status: "ready",
      offline: false,
      missing: false,
      stale: false,
      agentVersion: "0.1.6",
      lastCollectedAt: new Date().toISOString(),
      cpuUsedPercent: 10,
      memoryUsedPercent: 10,
      diskUsedPercent: 10,
      networkReceiveBytesPerSecond: 0,
      networkTransmitBytesPerSecond: 0,
      temperatureCelsius: null,
      operatingSystem: "linux",
      architecture: "amd64",
      worstDisk: null,
    })),
    services: [],
    serviceRanking: [],
    problemNodes: [],
    ...extras,
  };
}

describe("monitoring host pages", () => {
  it("renders the first host page before later pages resolve", async () => {
    let resolveSecond: ((value: unknown) => void) | undefined;
    mockedApi.mockImplementation(async (path: string) => {
      const url = String(path);
      if (url.includes("/environments") && !url.includes("monitoring")) return { items: [{ id: "env-1", name: "dev" }] };
      if (url.includes("/monitor-alerts")) return { items: [] };
      if (url.includes("/monitoring/overview") && url.includes("hostOffset=12")) {
        return await new Promise((resolve) => {
          resolveSecond = resolve;
        });
      }
      if (url.includes("/monitoring/overview")) {
        return overview([{ id: "00000000-0000-4000-8000-000000000001", name: "host-first" }]);
      }
      return {};
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ name: "monitoring", path: "/monitoring", component: MonitoringView }],
    });
    await router.push({ name: "monitoring", query: { view: "hosts" } });
    const wrapper = mount(MonitoringView, {
      global: {
        plugins: [router, i18nPlugin],
        stubs: {
          HostFleetPanel: {
            props: ["hosts", "loadingMore"],
            template: `<div class="fleet">{{ hosts.map((host) => host.connectionName).join(",") }}{{ loadingMore ? "|more" : "" }}</div>`,
          },
          AlertServicePanel: true,
          NocScreen: true,
          "el-select": true,
          "el-option": true,
          "el-button": true,
        },
      },
    });
    await flushPromises();
    expect(wrapper.find(".fleet").text()).toContain("host-first");
    expect(wrapper.find(".fleet").text()).toContain("|more");
    expect(wrapper.find(".fleet").text()).not.toContain("host-second");

    resolveSecond?.(overview([{ id: "00000000-0000-4000-8000-000000000002", name: "host-second" }], 20));
    await flushPromises();
    expect(wrapper.find(".fleet").text()).toContain("host-first");
    expect(wrapper.find(".fleet").text()).toContain("host-second");
    wrapper.unmount();
  });

  it("does not hijack navigation back to monitoring after leaving the page", async () => {
    let resolveOverview: ((value: unknown) => void) | undefined;
    mockedApi.mockImplementation(async (path: string) => {
      const url = String(path);
      if (url.includes("/environments") && !url.includes("monitoring")) return { items: [{ id: "env-1", name: "dev" }] };
      if (url.includes("/monitor-alerts")) return { items: [] };
      if (url.includes("/monitoring/overview")) {
        return await new Promise((resolve) => {
          resolveOverview = resolve;
        });
      }
      return {};
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { name: "monitoring", path: "/monitoring", component: MonitoringView },
        { name: "overview", path: "/", component: { template: "<div class='home'>home</div>" } },
      ],
    });
    await router.push({ name: "monitoring", query: { view: "services" } });
    const wrapper = mount(MonitoringView, {
      global: {
        plugins: [router, i18nPlugin],
        stubs: {
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
    resolveOverview?.(overview([{ id: "00000000-0000-4000-8000-000000000001", name: "host-first" }], 1));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("overview");
    wrapper.unmount();
  });
});
