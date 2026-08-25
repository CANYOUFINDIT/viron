export const MONITOR_ALERT_TOAST_DURATION_STORAGE_KEY = "viron-monitor-alert-toast-duration";
export const MONITOR_ALERT_TOAST_DURATION_OPTIONS = [5, 10, 15, 30] as const;
export const DEFAULT_MONITOR_ALERT_TOAST_DURATION_SECONDS = 10;

export type MonitorAlertToastDurationSeconds = (typeof MONITOR_ALERT_TOAST_DURATION_OPTIONS)[number];

export function sanitizeMonitorAlertToastDurationSeconds(value: unknown): MonitorAlertToastDurationSeconds {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return MONITOR_ALERT_TOAST_DURATION_OPTIONS.includes(seconds as MonitorAlertToastDurationSeconds)
    ? seconds as MonitorAlertToastDurationSeconds
    : DEFAULT_MONITOR_ALERT_TOAST_DURATION_SECONDS;
}

export function monitorAlertToastDurationMs(seconds: unknown): number {
  return sanitizeMonitorAlertToastDurationSeconds(seconds) * 1000;
}

export function readMonitorAlertToastDurationSeconds(): MonitorAlertToastDurationSeconds {
  try {
    return sanitizeMonitorAlertToastDurationSeconds(window.localStorage.getItem(MONITOR_ALERT_TOAST_DURATION_STORAGE_KEY));
  } catch {
    return DEFAULT_MONITOR_ALERT_TOAST_DURATION_SECONDS;
  }
}

export function persistMonitorAlertToastDurationSeconds(seconds: unknown): MonitorAlertToastDurationSeconds {
  const next = sanitizeMonitorAlertToastDurationSeconds(seconds);
  try {
    window.localStorage.setItem(MONITOR_ALERT_TOAST_DURATION_STORAGE_KEY, String(next));
  } catch {
    // Keep the in-memory duration even if storage is unavailable.
  }
  return next;
}
