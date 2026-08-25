import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_ALERT_TOAST_DURATION_SECONDS,
  monitorAlertToastDurationMs,
  sanitizeMonitorAlertToastDurationSeconds,
} from "../src/client/monitor-alert-toasts.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("monitor alert toasts", () => {
  it("keeps only supported auto-dismiss durations", () => {
    expect(sanitizeMonitorAlertToastDurationSeconds(10)).toBe(10);
    expect(sanitizeMonitorAlertToastDurationSeconds("15")).toBe(15);
    expect(sanitizeMonitorAlertToastDurationSeconds(0)).toBe(DEFAULT_MONITOR_ALERT_TOAST_DURATION_SECONDS);
    expect(sanitizeMonitorAlertToastDurationSeconds("forever")).toBe(DEFAULT_MONITOR_ALERT_TOAST_DURATION_SECONDS);
    expect(monitorAlertToastDurationMs(30)).toBe(30_000);
    expect(monitorAlertToastDurationMs(0)).toBe(DEFAULT_MONITOR_ALERT_TOAST_DURATION_SECONDS * 1000);
  });

  it("auto-dismisses in-app alert toasts and offers a close-all control", () => {
    const center = source("src/client/components/MonitorAlertCenter.vue");
    expect(center).toContain("monitorAlertToastDurationMs(toastDurationSeconds.value)");
    expect(center).not.toContain("phase === \"active\" ? 0");
    expect(center).toContain("ElNotification.closeAll()");
    expect(center).toContain("$t('全部关闭')");
    expect(center).toContain("monitor-alert-toast-toolbar");
    expect(center).toContain("$t('自动消失')");
  });
});
