import { describe, expect, it } from "vitest";
import {
  monitorLocalDayRange,
  monitorMonthDays,
  validateMonitorTimezone,
} from "../src/server/monitor-event-calendar.js";

describe("monitor event calendar time boundaries", () => {
  it("builds local calendar days without assuming every day is 24 hours", () => {
    const days = monitorMonthDays("2026-03", "America/New_York");
    expect(days).toHaveLength(31);
    const daylightSavingDay = days.find((day) => day.date === "2026-03-08");
    expect(daylightSavingDay).toBeDefined();
    expect(daylightSavingDay!.end - daylightSavingDay!.start).toBe(23 * 60 * 60 * 1000);
  });

  it("rejects invalid dates and timezones", () => {
    expect(validateMonitorTimezone("Asia/Shanghai")).toBe(true);
    expect(validateMonitorTimezone("Not/A_Timezone")).toBe(false);
    expect(monitorLocalDayRange("2026-02-30", "UTC")).toBeNull();
    expect(monitorMonthDays("2026-13", "UTC")).toEqual([]);
  });
});
