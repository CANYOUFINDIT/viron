import { describe, expect, it } from "vitest";
import { monitorHostEventDiskLabel, monitorHostEventDurationMinutes } from "../src/client/monitor-host-event-display.js";
import type { MonitorHostEventItem } from "../src/shared/monitor-alerts.js";

function event(overrides: Partial<MonitorHostEventItem> = {}): MonitorHostEventItem {
  return {
    id: "event-1",
    ruleType: "disk_added",
    ruleKey: "",
    status: "event",
    severity: "info",
    peakSeverity: "info",
    occurrenceCount: 1,
    targetName: "node-01",
    details: { device: "/dev/sdb1", path: "/data", filesystem: "xfs" },
    triggeredAt: "2026-08-27T00:00:00.000Z",
    recoveredAt: null,
    lastSeenAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("monitor host event display", () => {
  it("does not render one-time events as ongoing durations", () => {
    expect(monitorHostEventDurationMinutes(event(), Date.parse("2026-08-30T00:00:00.000Z"))).toBeNull();
    expect(monitorHostEventDurationMinutes(event({ status: "active" }), Date.parse("2026-08-27T01:00:00.000Z"))).toBe(60);
  });

  it("shows the disk identity carried by the event", () => {
    expect(monitorHostEventDiskLabel(event())).toBe("/dev/sdb1 · /data · xfs");
  });
});
