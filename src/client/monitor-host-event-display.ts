import type { MonitorHostEventItem } from "../shared/monitor-alerts";

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
