export const MONITORING_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type MonitoringRange = (typeof MONITORING_RANGES)[number];

export const MONITORING_REFRESH_SECONDS = [15, 30, 60] as const;
export type MonitoringRefreshSeconds = (typeof MONITORING_REFRESH_SECONDS)[number] | 0;

export const MONITORING_MAX_HOSTS = 200;
export const MONITORING_HOST_PAGE_SIZE = 12;
export const MONITORING_HOST_PAGE_CONCURRENCY = 4;
export const MONITORING_MAX_SERVICES = 100;
export const MONITORING_MAX_POINTS = 480;
export const MONITORING_MAX_SERVICE_DEPLOYMENTS = 50;
export const MONITORING_TOP_PROCESSES = 5;
export const MONITORING_STALE_CYCLES = 2;
export const MONITORING_DEFAULT_RESOLUTION_SECONDS = 30;
export const MONITORING_MIN_STALE_SECONDS = 30 * 60;
export const MONITORING_OVERVIEW_CACHE_MS = 5_000;

export const rangeMilliseconds: Record<MonitoringRange, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function finiteMetric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export interface MonitoringSeverityHost {
  connectionName?: unknown;
  name?: unknown;
  probeState?: MonitoringProbeState;
  offline?: boolean;
  missing?: boolean;
  stale?: boolean;
  status?: unknown;
  cpuUsedPercent?: number | null;
  memoryUsedPercent?: number | null;
  diskUsedPercent?: number | null;
}

export const MONITORING_PROBE_STATES = ["offline", "unreachable", "stale", "missing", "unchecked", "online"] as const;
export type MonitoringProbeState = (typeof MONITORING_PROBE_STATES)[number];

export interface MonitoringProbeEvidence {
  status?: unknown;
  agentId?: unknown;
  agentVersion?: unknown;
  installManaged?: boolean;
  installedAt?: unknown;
  lastCollectedAt?: unknown;
  stale?: boolean;
}

export function hasMonitoringProbeEvidence(host: MonitoringProbeEvidence): boolean {
  return Boolean(
    String(host.agentId ?? "").trim()
    || String(host.agentVersion ?? "").trim()
    || host.installManaged
    || host.installedAt
    || host.lastCollectedAt,
  );
}

export function monitoringProbeState(host: MonitoringProbeEvidence): MonitoringProbeState {
  const status = String(host.status ?? "unknown");
  if (status === "missing") return "missing";
  if (status === "error") return hasMonitoringProbeEvidence(host) ? "offline" : "unreachable";
  if (status === "ready") return host.stale ? "stale" : "online";
  return "unchecked";
}

export function monitoringPressure(host: MonitoringSeverityHost): number {
  return Math.max(finiteMetric(host.diskUsedPercent) ?? 0, finiteMetric(host.cpuUsedPercent) ?? 0, finiteMetric(host.memoryUsedPercent) ?? 0);
}

export function monitoringSeverityRank(host: MonitoringSeverityHost): number {
  const cpu = finiteMetric(host.cpuUsedPercent) ?? 0;
  const memory = finiteMetric(host.memoryUsedPercent) ?? 0;
  const disk = finiteMetric(host.diskUsedPercent) ?? 0;
  if (host.probeState === "offline" || host.offline) return 0;
  if (disk >= 90 || cpu >= 85 || memory >= 90) return 1;
  if (host.probeState === "unreachable") return 2;
  if (host.probeState === "stale" || host.stale) return 3;
  if (disk >= 80 || cpu >= 70 || memory >= 75) return 4;
  if (host.probeState === "missing" || host.missing) return 5;
  if (host.probeState === "unchecked") return 6;
  if (host.status && host.status !== "ready") return 7;
  return 8;
}

export function compareMonitoringHosts(left: MonitoringSeverityHost, right: MonitoringSeverityHost): number {
  const rank = monitoringSeverityRank(left) - monitoringSeverityRank(right);
  if (rank !== 0) return rank;
  const pressure = monitoringPressure(right) - monitoringPressure(left);
  if (pressure !== 0) return pressure;
  return String(left.connectionName || left.name || "").localeCompare(String(right.connectionName || right.name || ""), "zh");
}

export interface MonitoringAlertCounts {
  critical: number;
  major: number;
  warning: number;
}

export type MonitoringHostPriorityState = "offline" | "unmanaged" | "critical" | "warning" | "healthy";

export function hostPressureScore(host: MonitoringSeverityHost & { alertCounts?: MonitoringAlertCounts }): number {
  if (host.probeState === "offline" || host.offline) return 100;
  if (host.probeState === "unreachable") return 92;
  if (host.probeState === "missing" || host.missing) return 8;
  if (host.probeState === "unchecked") return 4;
  const cpu = finiteMetric(host.cpuUsedPercent) ?? 0;
  const memory = finiteMetric(host.memoryUsedPercent) ?? 0;
  const disk = finiteMetric(host.diskUsedPercent) ?? 0;
  const saturation = Math.max(cpu / 85, memory / 85, disk / 90);
  const breadth = ((cpu + memory + disk) / 300) * 20;
  const alerts = host.alertCounts ?? { critical: 0, major: 0, warning: 0 };
  const alertWeight = alerts.critical * 15 + alerts.major * 8 + alerts.warning * 3;
  const capacityWeight = disk >= 90 ? 10 : disk >= 80 ? 5 : 0;
  const freshnessWeight = host.stale ? 8 : 0;
  return Math.min(100, Math.round(saturation * 55 + breadth + alertWeight + capacityWeight + freshnessWeight));
}

export function hostPriorityState(
  host: MonitoringSeverityHost & { alertCounts?: MonitoringAlertCounts },
  score = hostPressureScore(host),
): MonitoringHostPriorityState {
  const alerts = host.alertCounts ?? { critical: 0, major: 0, warning: 0 };
  if (host.probeState === "offline" || host.offline) return "offline";
  if (host.probeState === "missing" || host.probeState === "unchecked" || host.missing) return "unmanaged";
  if (host.probeState === "unreachable") return "warning";
  if (score >= 80 || alerts.critical > 0) return "critical";
  if (score >= 55 || alerts.major > 0 || alerts.warning > 0 || host.stale) return "warning";
  return "healthy";
}

export function isMonitorStale(lastCollectedAt: string | null | undefined, resolutionSeconds = MONITORING_DEFAULT_RESOLUTION_SECONDS, now = Date.now()): boolean {
  if (!lastCollectedAt) return false;
  const collected = Date.parse(lastCollectedAt);
  if (!Number.isFinite(collected)) return false;
  const cycleMs = Math.max(1, resolutionSeconds) * 1000;
  return now - collected > Math.max(MONITORING_MIN_STALE_SECONDS * 1000, MONITORING_STALE_CYCLES * cycleMs);
}

export function timeBucketMs(range: MonitoringRange): number {
  return Math.max(1000, Math.floor(rangeMilliseconds[range] / MONITORING_MAX_POINTS));
}

export function bucketTimestamp(at: string, bucketMs: number): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return at;
  return new Date(Math.floor(time / bucketMs) * bucketMs).toISOString();
}

export function capSeriesPoints<T>(points: T[], max = MONITORING_MAX_POINTS, isGap?: (point: T) => boolean): T[] {
  if (points.length <= max) return points;
  if (max <= 2) return [points[0]!, points[points.length - 1]!].slice(0, max);
  const lastIndex = points.length - 1;
  const required = new Set<number>([0, lastIndex]);
  for (let index = 0; index < points.length; index += 1) {
    const gap = isGap ? isGap(points[index]!) : Boolean((points[index] as { breakBefore?: boolean }).breakBefore);
    if (!gap) continue;
    if (index > 0) required.add(index - 1);
    required.add(index);
  }
  const selected = new Map<number, T>();
  const requiredIndexes = [...required].sort((left, right) => left - right);
  if (requiredIndexes.length > max) {
    for (let slot = 0; slot < max; slot += 1) {
      const position = Math.round((slot * (requiredIndexes.length - 1)) / (max - 1));
      const index = requiredIndexes[position]!;
      selected.set(index, points[index]!);
    }
  } else {
    for (const index of requiredIndexes) selected.set(index, points[index]!);
  }
  selected.set(0, points[0]!);
  selected.set(lastIndex, points[lastIndex]!);
  const remaining = max - selected.size;
  if (remaining > 0) {
    for (let slot = 1; slot <= remaining; slot += 1) {
      const index = Math.round((slot * lastIndex) / (remaining + 1));
      selected.set(index, points[index]!);
    }
  }
  return [...selected.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
}
