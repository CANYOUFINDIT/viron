export const MONITORING_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type MonitoringRange = (typeof MONITORING_RANGES)[number];

export const MONITORING_REFRESH_SECONDS = [15, 30, 60] as const;
export type MonitoringRefreshSeconds = (typeof MONITORING_REFRESH_SECONDS)[number] | 0;

export const MONITORING_MAX_HOSTS = 200;
export const MONITORING_MAX_SERVICES = 100;
export const MONITORING_MAX_POINTS = 480;
export const MONITORING_MAX_SERVICE_DEPLOYMENTS = 50;
export const MONITORING_TOP_PROCESSES = 5;
export const MONITORING_STALE_CYCLES = 2;
export const MONITORING_DEFAULT_RESOLUTION_SECONDS = 30;
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

export function isMonitorStale(lastCollectedAt: string | null | undefined, resolutionSeconds = MONITORING_DEFAULT_RESOLUTION_SECONDS, now = Date.now()): boolean {
  if (!lastCollectedAt) return false;
  const collected = Date.parse(lastCollectedAt);
  if (!Number.isFinite(collected)) return false;
  const cycleMs = Math.max(1, resolutionSeconds) * 1000;
  return now - collected > MONITORING_STALE_CYCLES * cycleMs;
}

export function capSeriesPoints<T>(points: T[], max = MONITORING_MAX_POINTS): T[] {
  if (points.length <= max) return points;
  if (max <= 2) return [points[0]!, points[points.length - 1]!].slice(0, max);
  const lastIndex = points.length - 1;
  const selected = new Map<number, T>();
  selected.set(0, points[0]!);
  selected.set(lastIndex, points[lastIndex]!);
  const inner = max - 2;
  for (let slot = 1; slot <= inner; slot += 1) {
    const index = Math.round((slot * lastIndex) / (inner + 1));
    selected.set(index, points[index]!);
  }
  return [...selected.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
}
