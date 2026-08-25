import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MONITOR_ALERT_TOAST_DURATION_MS, MONITOR_ALERT_TOAST_DURATION_SECONDS } from "../src/client/monitor-alert-toasts.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("monitor alert toasts", () => {
  it("uses a platform default auto-dismiss duration", () => {
    expect(MONITOR_ALERT_TOAST_DURATION_SECONDS).toBe(5);
    expect(MONITOR_ALERT_TOAST_DURATION_MS).toBe(5_000);
  });

  it("auto-dismisses in-app alert toasts after the platform delay and offers a close-all control", () => {
    const center = source("src/client/components/MonitorAlertCenter.vue");
    const toasts = source("src/client/monitor-alert-toasts.ts");
    expect(center).toContain("duration: MONITOR_ALERT_TOAST_DURATION_MS");
    expect(center).not.toContain("phase === \"active\" ? 0");
    expect(center).not.toContain("$t('自动消失')");
    expect(center).not.toContain("MONITOR_ALERT_TOAST_DURATION_OPTIONS");
    expect(center).not.toContain("toastDurationSeconds");
    expect(center).toContain("ElNotification.closeAll()");
    expect(center).toContain("$t('全部关闭')");
    expect(center).toContain("monitor-alert-toast-toolbar");
    expect(center).toContain("$t('全部清理')");
    expect(center).toContain("/api/v1/monitor-alerts/clear-all");
    expect(toasts).toContain("pauses this timer while the mouse is over the toast");
  });
});
