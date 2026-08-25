export type MonitorHistoryRange = "1h" | "6h" | "24h" | "7d" | "30d";

export const QUICK_MONITOR_HISTORY_RANGE: MonitorHistoryRange = "1h";

export function monitorHistoryLoadPlan(
  targetRange: MonitorHistoryRange,
  hasLoadedResponse: boolean,
): MonitorHistoryRange[] {
  if (hasLoadedResponse || targetRange === QUICK_MONITOR_HISTORY_RANGE) return [targetRange];
  return [QUICK_MONITOR_HISTORY_RANGE, targetRange];
}
