import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_HISTORY_RANGE,
  monitorHistoryLoadPlan,
  QUICK_MONITOR_HISTORY_RANGE,
} from "../src/client/monitor-history-loading.js";

describe("progressive monitor history loading", () => {
  it("opens dashboards on the one-hour range", () => {
    expect(DEFAULT_MONITOR_HISTORY_RANGE).toBe("1h");
  });

  it("primes an empty dashboard with one hour before loading the selected range", () => {
    expect(monitorHistoryLoadPlan("6h", false)).toEqual([QUICK_MONITOR_HISTORY_RANGE, "6h"]);
    expect(monitorHistoryLoadPlan("30d", false)).toEqual([QUICK_MONITOR_HISTORY_RANGE, "30d"]);
  });

  it("does not duplicate the request when one hour is selected", () => {
    expect(monitorHistoryLoadPlan("1h", false)).toEqual(["1h"]);
  });

  it("refreshes an already rendered dashboard without replaying the prime request", () => {
    expect(monitorHistoryLoadPlan("6h", true)).toEqual(["6h"]);
  });
});
