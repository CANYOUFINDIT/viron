import { afterEach, describe, expect, it } from "vitest";
import {
  clearMonitorUiCache,
  monitorEventCalendarCacheKey,
  monitorHistoryCacheKey,
  readMonitorUiCache,
  writeMonitorUiCache,
} from "../src/client/monitor-ui-cache";

afterEach(() => clearMonitorUiCache());

describe("monitor UI cache", () => {
  it("isolates history by environment, host, and range", () => {
    const hostA = monitorHistoryCacheKey("env-1", "host-a", "1h");
    const hostB = monitorHistoryCacheKey("env-1", "host-b", "1h");
    const longerRange = monitorHistoryCacheKey("env-1", "host-a", "24h");

    writeMonitorUiCache(hostA, { marker: "cached-host-a" });

    expect(readMonitorUiCache(hostA)).toEqual({ marker: "cached-host-a" });
    expect(readMonitorUiCache(hostB)).toBeNull();
    expect(readMonitorUiCache(longerRange)).toBeNull();
  });

  it("isolates event calendars by the visible month window", () => {
    const currentWindow = monitorEventCalendarCacheKey("env-1", "host-a", "Asia/Shanghai", ["2026-06", "2026-07", "2026-08"]);
    const previousWindow = monitorEventCalendarCacheKey("env-1", "host-a", "Asia/Shanghai", ["2026-03", "2026-04", "2026-05"]);

    writeMonitorUiCache(currentWindow, [{ month: "2026-08" }]);

    expect(readMonitorUiCache(currentWindow)).toEqual([{ month: "2026-08" }]);
    expect(readMonitorUiCache(previousWindow)).toBeNull();
  });
});
