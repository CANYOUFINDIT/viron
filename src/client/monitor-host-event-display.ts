import type { MonitorAlertItem, MonitorHostEventItem } from "../shared/monitor-alerts";

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function monitorAlertLocalDateKey(value: string, now = new Date()): string {
  const date = new Date(value);
  const source = Number.isFinite(date.getTime()) ? date : now;
  return `${source.getFullYear()}-${padDatePart(source.getMonth() + 1)}-${padDatePart(source.getDate())}`;
}

export function monitorAlertLocalDateKeys(alert: Pick<MonitorAlertItem, "triggeredAt" | "lastSeenAt" | "recoveredAt">, maxDays = 366): string[] {
  const start = new Date(alert.triggeredAt);
  const end = new Date(alert.lastSeenAt || alert.recoveredAt || alert.triggeredAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    const fallback = monitorAlertLocalDateKey(alert.lastSeenAt || alert.triggeredAt);
    return fallback ? [fallback] : [];
  }
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (cursor > last) return [monitorAlertLocalDateKey(alert.lastSeenAt || alert.triggeredAt)];
  const keys: string[] = [];
  for (let index = 0; index < maxDays && cursor <= last; index += 1) {
    keys.push(`${cursor.getFullYear()}-${padDatePart(cursor.getMonth() + 1)}-${padDatePart(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

export function monitorHostEventDurationMinutes(event: MonitorHostEventItem, now = Date.now()): number | null {
  if (event.status === "event") return null;
  const start = Date.parse(event.triggeredAt);
  const end = event.recoveredAt ? Date.parse(event.recoveredAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start) / 60_000;
}

export function monitorHostEventDiskLabel(event: MonitorHostEventItem): string {
  if (!["disk_usage", "disk_added", "disk_missing"].includes(event.ruleType)) return "";
  const device = String(event.details.device ?? "").trim();
  const path = String(event.details.path ?? "").trim();
  const filesystem = String(event.details.filesystem ?? "").trim();
  return [device, path, filesystem].filter(Boolean).join(" · ");
}
