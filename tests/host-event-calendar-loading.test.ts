/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

import { api } from "../src/client/api";
import HostEventCalendar from "../src/client/components/monitoring/HostEventCalendar.vue";
import { i18nPlugin } from "../src/client/i18n";
import { clearMonitorUiCache } from "../src/client/monitor-ui-cache";
import type { MonitorHostEventCalendarResponse } from "../src/shared/monitor-alerts";

const mockedApi = vi.mocked(api);
const now = new Date("2026-08-31T12:00:00.000Z");

function calendarMonth(path: string): string {
  return new URL(path, "http://localhost").searchParams.get("month")!;
}

function calendar(month: string, alert = false): MonitorHostEventCalendarResponse {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const alertDate = `${month}-01`;
  const days = Array.from({ length: count }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    const affected = alert && date === alertDate;
    return {
      date,
      future: date > "2026-08-31",
      coverageRatio: 1,
      newEventCount: affected ? 1 : 0,
      activeEventCount: affected ? 1 : 0,
      infoCount: 0,
      warningCount: 0,
      majorCount: 0,
      criticalCount: affected ? 1 : 0,
      affectedMinutes: affected ? 10 : 0,
      peakSeverity: affected ? "critical" as const : null,
      burdenScore: affected ? 8 : 0,
    };
  });
  return {
    month,
    timezone: "Asia/Shanghai",
    from: `${month}-01T00:00:00.000Z`,
    to: `${month}-${String(count).padStart(2, "0")}T23:59:59.999Z`,
    generatedAt: now.toISOString(),
    days,
    summary: {
      healthyDays: days.filter((day) => !day.future && !day.activeEventCount).length,
      affectedDays: alert ? 1 : 0,
      noDataDays: 0,
      criticalEvents: alert ? 1 : 0,
      totalEvents: alert ? 1 : 0,
      affectedMinutes: alert ? 10 : 0,
      meanRecoveryMinutes: null,
    },
  };
}

function mountCalendar() {
  return mount(HostEventCalendar, {
    props: { mode: "platform" },
    global: {
      plugins: [i18nPlugin],
      directives: { loading: () => undefined },
      stubs: {
        "el-drawer": { template: "<div><slot /></div>" },
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  clearMonitorUiCache();
  mockedApi.mockReset();
});

afterEach(() => {
  clearMonitorUiCache();
  vi.useRealTimers();
});

describe("platform event calendar loading state", () => {
  it("does not paint unloaded platform months as green no-alert days", async () => {
    mockedApi.mockImplementation(() => new Promise(() => undefined));

    const wrapper = mountCalendar();
    await flushPromises();

    expect(mockedApi).toHaveBeenCalledTimes(3);
    expect(wrapper.findAll(".event-calendar__cell.is-loading-data").length).toBeGreaterThan(0);
    expect(wrapper.findAll(".event-calendar__cell.is-healthy")).toHaveLength(0);
    expect(wrapper.find(".totals-pill.is-faint").exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps failed platform months in an explicit no-data state", async () => {
    mockedApi.mockRejectedValue(new Error("calendar unavailable"));

    const wrapper = mountCalendar();
    await flushPromises();

    expect(wrapper.findAll(".event-calendar__cell.is-loading-data")).toHaveLength(0);
    expect(wrapper.findAll(".event-calendar__cell.is-healthy")).toHaveLength(0);
    expect(wrapper.findAll(".event-calendar__cell.is-no-data").length).toBeGreaterThan(0);
    expect(wrapper.find(".event-calendar__error").text()).toContain("calendar unavailable");
    wrapper.unmount();
  });

  it("keeps loaded alert days visible while an expanded range refreshes", async () => {
    const currentMonth = "2026-08";
    let refreshing = false;
    mockedApi.mockImplementation((path, init?: { signal?: AbortSignal }) => {
      if (!refreshing) {
        const month = calendarMonth(String(path));
        return Promise.resolve(calendar(month, month === currentMonth));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });

    const wrapper = mountCalendar();
    await flushPromises();
    expect(wrapper.findAll(".event-calendar__cell.is-critical")).toHaveLength(1);
    expect(wrapper.find(".event-calendar__totals .totals-pill strong").text()).toBe("1");

    refreshing = true;
    await wrapper.findAll(".preset-chip").find((button) => button.text() === "6M")!.trigger("click");
    await flushPromises();

    expect(wrapper.findAll(".event-calendar__cell.is-critical")).toHaveLength(1);
    expect(wrapper.find(".event-calendar__totals .totals-pill strong").text()).toBe("1");
    expect(wrapper.findAll(".event-calendar__cell.is-loading-data").length).toBeGreaterThan(0);
    wrapper.unmount();
    await flushPromises();
  });
});
