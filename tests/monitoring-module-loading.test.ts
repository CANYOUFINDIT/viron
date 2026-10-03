/** @vitest-environment happy-dom */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/session", () => ({ session: { workspace: { role: "owner" } } }));

import { api } from "../src/client/api";
import AlertServicePanel from "../src/client/components/monitoring/AlertServicePanel.vue";
import { i18nPlugin } from "../src/client/i18n";
import MonitoringView from "../src/client/views/MonitoringView.vue";
import type { MonitorPlatformEventItem } from "../src/shared/monitor-alerts";

const mockedApi = vi.mocked(api);
const wrappers: VueWrapper[] = [];
const event: MonitorPlatformEventItem = {
  id: "event-1", ruleType: "host_offline", ruleKey: "offline", status: "active",
  severity: "critical", peakSeverity: "critical", occurrenceCount: 1,
  targetName: "example-host", details: {}, triggeredAt: "2026-10-03T01:00:00.000Z",
  recoveredAt: null, lastSeenAt: "2026-10-03T01:00:00.000Z", environmentId: "env-1",
  environmentName: "测试环境", sshConnectionId: "host-1", serviceId: null,
  serviceName: "", connectionName: "example-host", targetType: "host",
};
const eventResponse = { items: [event], total: 1, page: 1, pageSize: 5 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const globalOptions = {
  plugins: [i18nPlugin],
  directives: {
    loading: (element: HTMLElement, binding: { value: unknown }) => {
      element.dataset.loading = String(Boolean(binding.value));
    },
  },
  stubs: {
    HostEventCalendar: true,
    HostFleetPanel: true,
    NocScreen: true,
    PageHeader: { template: "<header><slot name='actions' /></header>" },
    "el-input": true,
    "el-drawer": { template: "<div><slot /></div>" },
    "el-select": true,
    "el-option": true,
    "el-pagination": true,
    "el-button": { template: "<button><slot /></button>" },
  },
};

function mountPanel(props = {}) {
  const wrapper = mount(AlertServicePanel, {
    props: { environmentId: "", environments: [], services: [], ...props },
    global: globalOptions,
  });
  wrappers.push(wrapper);
  return wrapper;
}

function overview(total = 0, generatedAt = "2026-10-03T01:00:00.000Z") {
  return {
    generatedAt, partialFailures: [], hosts: [], services: [], serviceRanking: [], problemNodes: [],
    summary: {
      hostTotal: total, hostOnline: total, hostOffline: 0, hostMissing: 0, hostStale: 0,
      serviceTotal: 0, avgCpuPercent: null, avgMemoryPercent: null, diskAlerts: 0,
    },
  };
}

async function mountView(refresh = "0") {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ name: "monitoring", path: "/monitoring", component: MonitoringView }],
  });
  await router.push({ name: "monitoring", query: { refresh } });
  const wrapper = mount(MonitoringView, {
    global: { ...globalOptions, plugins: [router, i18nPlugin] },
  });
  wrappers.push(wrapper);
  return { wrapper, router };
}

beforeEach(() => { mockedApi.mockReset(); });
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
});

describe("monitoring module loading", () => {
  it("places services and priority loading on their own bodies and hides premature empty states", async () => {
    mockedApi.mockImplementation(() => new Promise(() => undefined));
    const wrapper = mountPanel({ servicesLoading: true });
    await flushPromises();
    expect(wrapper.get(".service-table").attributes("data-loading")).toBe("true");
    expect(wrapper.get(".priority-event-body").attributes("data-loading")).toBe("true");
    expect(wrapper.get(".priority-event-panel").attributes("data-loading")).toBeUndefined();
    expect(wrapper.find(".service-section .observe-empty").exists()).toBe(false);
    expect(wrapper.find(".priority-event-body .observe-empty").exists()).toBe(false);
    expect(wrapper.get(".event-filter-bar").attributes("data-loading")).toBeUndefined();
  });

  it("keeps an identical in-flight priority request when refresh ticks arrive", async () => {
    const pending = deferred<typeof eventResponse>();
    mockedApi.mockReturnValue(pending.promise);
    const wrapper = mountPanel();
    const signal = mockedApi.mock.calls[0]![1]!.signal!;
    await wrapper.setProps({ refreshKey: "1" });
    await wrapper.setProps({ refreshKey: "2" });
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    pending.resolve(eventResponse);
    await flushPromises();
    expect(wrapper.find("button.event-row").exists()).toBe(true);
  });

  it("retains rows without a blocking mask during background refresh, including on failure", async () => {
    mockedApi.mockResolvedValueOnce(eventResponse);
    const pending = deferred<typeof eventResponse>();
    mockedApi.mockReturnValueOnce(pending.promise);
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.setProps({ refreshKey: "1" });
    expect(wrapper.get(".priority-event-body").attributes("data-loading")).toBe("false");
    expect(wrapper.get(".priority-event-body").attributes("aria-busy")).toBe("true");
    expect(wrapper.find("button.event-row").exists()).toBe(true);
    expect(wrapper.find(".priority-event-panel .module-refresh-indicator").exists()).toBe(true);
    pending.reject(new Error("refresh unavailable"));
    await flushPromises();
    expect(wrapper.find("button.event-row").exists()).toBe(true);
    expect(wrapper.get(".event-list-error").text()).toBe("refresh unavailable");
    expect(wrapper.get(".priority-event-body").attributes("aria-busy")).toBe("false");
  });

  it("does not block an already loaded empty result during refresh", async () => {
    mockedApi.mockResolvedValueOnce({ ...eventResponse, items: [], total: 0 });
    mockedApi.mockImplementationOnce(() => new Promise(() => undefined));
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.setProps({ refreshKey: "1" });
    expect(wrapper.get(".priority-event-body").attributes("data-loading")).toBe("false");
    expect(wrapper.find(".module-refresh-indicator").exists()).toBe(true);
  });

  it("aborts on a changed time range and ignores stale failures", async () => {
    const old = deferred<typeof eventResponse>();
    const current = deferred<typeof eventResponse>();
    mockedApi.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const wrapper = mountPanel();
    const signal = mockedApi.mock.calls[0]![1]!.signal!;
    await wrapper.get(".event-range-tabs button:nth-child(2)").trigger("click");
    expect(signal.aborted).toBe(true);
    expect(mockedApi).toHaveBeenCalledTimes(2);
    old.reject(new Error("stale failure"));
    await flushPromises();
    expect(wrapper.find(".event-list-error").exists()).toBe(false);
    expect(wrapper.get(".priority-event-body").attributes("data-loading")).toBe("true");
    current.resolve(eventResponse);
    await flushPromises();
    expect(wrapper.get(".priority-event-body").attributes("data-loading")).toBe("false");
  });

  it("loads priority events once on entry, independent of initial overview and host page completion", async () => {
    const first = deferred<ReturnType<typeof overview>>();
    const second = deferred<ReturnType<typeof overview>>();
    const third = deferred<ReturnType<typeof overview>>();
    mockedApi.mockImplementation((path) => {
      if (path.includes("/monitoring/events?")) return Promise.resolve(eventResponse);
      if (path.includes("/monitoring/overview")) {
        if (path.includes("hostOffset=12")) return second.promise;
        if (path.includes("hostOffset=24")) return third.promise;
        return first.promise;
      }
      return Promise.resolve({ items: [] });
    });
    const { wrapper } = await mountView();
    await flushPromises();
    expect(wrapper.get(".monitoring-view").attributes("data-loading")).toBeUndefined();
    expect(wrapper.get(".service-table").attributes("data-loading")).toBe("true");
    expect(wrapper.get(".priority-event-body").attributes("data-loading")).toBe("false");
    first.resolve(overview(25));
    await flushPromises();
    expect(wrapper.get(".service-table").attributes("data-loading")).toBe("false");
    second.resolve(overview(25, "2026-10-03T01:00:01.000Z"));
    await flushPromises();
    third.resolve(overview(25, "2026-10-03T01:00:02.000Z"));
    await flushPromises();
    expect(mockedApi.mock.calls.filter(([path]) => path.includes("/monitoring/events?"))).toHaveLength(1);
    expect(mockedApi.mock.calls.filter(([path]) => path.includes("/monitoring/overview"))).toHaveLength(3);
    await wrapper.get("header button:nth-of-type(2)").trigger("click");
    await flushPromises();
    expect(mockedApi.mock.calls.filter(([path]) => path.includes("/monitoring/events?"))).toHaveLength(2);
    expect(wrapper.findComponent({ name: "HostEventCalendar" }).props("refreshKey")).toBe("1");
  });

  it("does not restart a slow overview when another refresh is requested", async () => {
    const pending = deferred<ReturnType<typeof overview>>();
    mockedApi.mockImplementation((path) => {
      if (path.includes("/monitoring/events?")) return Promise.resolve(eventResponse);
      if (path.includes("/monitoring/overview")) return pending.promise;
      return Promise.resolve({ items: [] });
    });
    const { wrapper } = await mountView();
    await flushPromises();
    const signal = mockedApi.mock.calls.find(([path]) => path.includes("/monitoring/overview"))![1]!.signal!;
    await wrapper.get("header button:nth-of-type(2)").trigger("click");
    await flushPromises();
    expect(signal.aborted).toBe(false);
    expect(mockedApi.mock.calls.filter(([path]) => path.includes("/monitoring/overview"))).toHaveLength(1);
    pending.resolve(overview());
    await flushPromises();
  });

  it("coalesces automatic refresh ticks while the first overview and alerts are still pending", async () => {

    let tick!: () => void;
    vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      tick = callback as () => void;
      return 0;
    });
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const pendingOverview = deferred<ReturnType<typeof overview>>();
    const pendingEvents = deferred<typeof eventResponse>();
    mockedApi.mockImplementation((path) => {
      if (path.includes("/monitoring/events?")) return pendingEvents.promise;
      if (path.includes("/monitoring/overview")) return pendingOverview.promise;
      return Promise.resolve({ items: [] });
    });
    const { wrapper } = await mountView("15");
    await flushPromises();
    tick();
    await flushPromises();
    tick();
    await flushPromises();
    expect(mockedApi.mock.calls.filter(([path]) => path.includes("/monitoring/events?"))).toHaveLength(1);
    expect(mockedApi.mock.calls.filter(([path]) => path.includes("/monitoring/overview"))).toHaveLength(1);
    expect(wrapper.get(".service-table").attributes("data-loading")).toBe("true");
    pendingEvents.resolve(eventResponse);
    pendingOverview.resolve(overview());
    await flushPromises();
  });

  it("cancels remaining host pages when a page fails so they cannot overwrite a later refresh", async () => {
    const failedPage = deferred<ReturnType<typeof overview>>();
    const pendingPage = deferred<ReturnType<typeof overview>>();
    mockedApi.mockImplementation((path) => {
      if (path.includes("/monitoring/events?")) return Promise.resolve(eventResponse);
      if (path.includes("/monitoring/overview")) {
        if (path.includes("hostOffset=12")) return failedPage.promise;
        if (path.includes("hostOffset=24")) return pendingPage.promise;
        return Promise.resolve(overview(25));
      }
      return Promise.resolve({ items: [] });
    });
    await mountView();
    await flushPromises();
    const signal = mockedApi.mock.calls.find(([path]) => path.includes("hostOffset=24"))![1]!.signal!;
    failedPage.reject(new Error("host page unavailable"));
    await flushPromises();
    expect(signal.aborted).toBe(true);
    pendingPage.resolve(overview(25));
    await flushPromises();
  });

  it("clears old services and starts local loading when switching environment", async () => {
    const pending = deferred<ReturnType<typeof overview>>();
    mockedApi.mockImplementation((path) => {
      if (path.includes("/monitoring/events?")) return Promise.resolve(eventResponse);
      if (path.includes("/monitoring/overview")) {
        return path.includes("environmentId=env-2") ? pending.promise : Promise.resolve(overview());
      }
      return Promise.resolve({ items: [] });
    });
    const { wrapper, router } = await mountView();
    await flushPromises();
    await router.replace({ name: "monitoring", query: { refresh: "0", environmentId: "env-2" } });
    await flushPromises();
    expect(wrapper.get(".service-table").attributes("data-loading")).toBe("true");
    expect(wrapper.find(".service-section .observe-empty").exists()).toBe(false);
    expect(mockedApi.mock.calls.filter(([path]) => path.includes("/monitoring/events?"))).toHaveLength(2);
    pending.resolve(overview());
    await flushPromises();
  });
});
