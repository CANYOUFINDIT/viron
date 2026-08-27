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
  for (const index of requiredIndexes) {
    if (selected.size >= max && index !== 0 && index !== lastIndex) continue;
    selected.set(index, points[index]!);
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
