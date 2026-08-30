/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

import { api } from "../src/client/api";
import HostMonitorDashboard from "../src/client/components/HostMonitorDashboard.vue";
import { i18nPlugin } from "../src/client/i18n";
import { clearMonitorUiCache } from "../src/client/monitor-ui-cache";

const mockedApi = vi.mocked(api);
const pressure = { someAvg10: 0, someAvg60: 0, someAvg300: 0, fullAvg10: 0, fullAvg60: 0, fullAvg300: 0 };

function metric(value: number) {
  return { average: value, p95: value, maximum: value, latest: value, changePercent: 0 };
}

function history(cpuUsedPercent: number) {
  const at = "2026-08-30T03:00:00.000Z";
  return {
    range: "1h",
    from: at,
    to: at,
    sourceSampleCount: 1,
    sampledPointCount: 1,
    points: [{
      at,
      breakBefore: false,
      resolutionSeconds: 30,
      sampleCount: 1,
      host: {
        metricsVersion: 2,
        cpuCount: 4,
        cpuUsedPercent,
        cpuUserPercent: cpuUsedPercent * 0.7,
        cpuSystemPercent: cpuUsedPercent * 0.2,
        cpuIoWaitPercent: cpuUsedPercent * 0.1,
        cpuStealPercent: 0,
        load1: 1,
        load5: 1,
        load15: 1,
        memoryUsedPercent: 50,
        memoryTotalBytes: 16_000,
        memoryUsedBytes: 8_000,
        swapTotalBytes: 0,
        swapUsedBytes: 0,
        swapUsedPercent: 0,
        swapInBytesPerSecond: 0,
        swapOutBytesPerSecond: 0,
        diskReadBytesPerSecond: 0,
        diskWriteBytesPerSecond: 0,
        diskReadOpsPerSecond: 0,
        diskWriteOpsPerSecond: 0,
        networkReceiveBytesPerSecond: 0,
        networkTransmitBytesPerSecond: 0,
        networkReceiveErrorsPerSecond: 0,
        networkTransmitErrorsPerSecond: 0,
        networkReceiveDropsPerSecond: 0,
        networkTransmitDropsPerSecond: 0,
        cpuPressure: { ...pressure },
        memoryPressure: { ...pressure },
        ioPressure: { ...pressure },
        topProcesses: [],
        uptimeSeconds: 3_600,
        disks: [],
        temperatures: [],
      },
    }],
    diagnostics: [],
    summary: {
      cpu: metric(cpuUsedPercent),
      memory: metric(50),
      loadPerCpu: metric(0.25),
      diskThroughput: metric(0),
      networkThroughput: metric(0),
      pressure: metric(0),
    },
    gaps: [],
  };
}

beforeEach(() => {
  clearMonitorUiCache();
  mockedApi.mockReset();
});

afterEach(() => clearMonitorUiCache());

describe("host monitor dashboard cache", () => {
  it("shows the previous host response immediately while refreshing it in the background", async () => {
    let hostACalls = 0;
    let resolveHostARefresh: ((value: ReturnType<typeof history>) => void) | undefined;
    mockedApi.mockImplementation((path) => {
      if (String(path).includes("/host-a/")) {
        hostACalls += 1;
        if (hostACalls === 1) return Promise.resolve(history(11));
        return new Promise((resolve) => { resolveHostARefresh = resolve; });
      }
      return Promise.resolve(history(22));
    });

    const wrapper = mount(HostMonitorDashboard, {
      props: { environmentId: "env-1", hostId: "host-a", lastCollectedAt: "first" },
      global: {
        plugins: [i18nPlugin],
        stubs: {
          MonitorTimeSeriesChart: { template: "<div class='chart-stub' />" },
          "el-select": { template: "<div><slot /></div>" },
          "el-option": true,
        },
      },
    });

    await flushPromises();
    expect(wrapper.text()).toContain("11.0%");

    await wrapper.setProps({ hostId: "host-b", lastCollectedAt: "second" });
    await flushPromises();
    expect(wrapper.text()).toContain("22.0%");

    await wrapper.setProps({ hostId: "host-a", lastCollectedAt: "third" });
    expect(hostACalls).toBe(2);
    expect(wrapper.text()).toContain("11.0%");
    expect(wrapper.find(".monitor-history__load-status").exists()).toBe(true);
    expect(wrapper.find(".monitor-history__notice").exists()).toBe(false);

    resolveHostARefresh?.(history(33));
    await flushPromises();
    expect(wrapper.text()).toContain("33.0%");

    wrapper.unmount();
  });
});
