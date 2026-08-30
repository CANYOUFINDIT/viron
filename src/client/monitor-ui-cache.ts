const MAX_MONITOR_UI_CACHE_ENTRIES = 160;

const monitorUiCache = new Map<string, unknown>();

function touchCacheEntry<T>(key: string, value: T): T {
  monitorUiCache.delete(key);
  monitorUiCache.set(key, value);
  while (monitorUiCache.size > MAX_MONITOR_UI_CACHE_ENTRIES) {
    const oldestKey = monitorUiCache.keys().next().value;
    if (oldestKey === undefined) break;
    monitorUiCache.delete(oldestKey);
  }
  return value;
}

export function monitorHistoryCacheKey(environmentId: string, hostId: string, range: string): string {
  return `history:${environmentId}:${hostId}:${range}`;
}

export function monitorEventCalendarCacheKey(
  environmentId: string,
  hostId: string,
  timezone: string,
  months: string[],
): string {
  return `event-calendar:${environmentId}:${hostId}:${timezone}:${months.join(",")}`;
}

export function readMonitorUiCache<T>(key: string): T | null {
  if (!monitorUiCache.has(key)) return null;
  return touchCacheEntry(key, monitorUiCache.get(key) as T);
}

export function writeMonitorUiCache<T>(key: string, value: T): void {
  touchCacheEntry(key, value);
}

export function clearMonitorUiCache(): void {
  monitorUiCache.clear();
}
