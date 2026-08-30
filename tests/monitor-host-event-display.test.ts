import { describe, expect, it } from "vitest";
import { monitorAlertLocalDateKey, monitorAlertLocalDateKeys } from "../src/client/monitor-host-event-display";

describe("monitor alert local dates", () => {
  it("keeps an active alert on every local day from trigger to last seen", () => {
    const keys = monitorAlertLocalDateKeys({
      triggeredAt: "2026-08-30T03:21:53.000Z",
      lastSeenAt: "2026-08-30T11:21:53.000Z",
      recoveredAt: null,
    });
    expect(keys).toContain(monitorAlertLocalDateKey("2026-08-30T11:21:53.000Z"));
  });
});
