export interface MonitorStoragePolicy {
  rawHours: number;
  fiveMinuteDays: number;
  hourlyDays: number;
  alertDays: number;
  diagnosticHours: number;
  incidentDiagnosticDays: number;
  maxBytes: number;
  diagnosticMaxBytes: number;
  maxSeriesPerWorkspace: number;
  maintenanceIntervalSeconds: number;
  maintenanceBudgetMs: number;
  batchSize: number;
}

export const defaultMonitorStoragePolicy: Readonly<MonitorStoragePolicy> = {
  rawHours: 48, fiveMinuteDays: 30, hourlyDays: 180,
  alertDays: 365, diagnosticHours: 24, incidentDiagnosticDays: 7,
  maxBytes: 10 * 1024 ** 3, diagnosticMaxBytes: 1024 ** 3,
  maxSeriesPerWorkspace: 50_000, maintenanceIntervalSeconds: 60,
  maintenanceBudgetMs: 8_000, batchSize: 100,
};

export type MonitorStorageLevel = "normal" | "warning" | "constrained" | "critical";
export interface MonitorStorageStatus {
  level: MonitorStorageLevel;
  usedBytes: number;
  budgetBytes: number;
  seriesCount: number;
  lastMaintenanceAt: string | null;
  lastError: string | null;
  migrationPending: boolean;
  policy: MonitorStoragePolicy;
}

export function monitorStorageLevel(usedBytes: number, budgetBytes: number): MonitorStorageLevel {
  const ratio = budgetBytes > 0 ? usedBytes / budgetBytes : 0;
  return ratio >= .95 ? "critical" : ratio >= .85 ? "constrained" : ratio >= .7 ? "warning" : "normal";
}

export const monitorHostMetricKeys = [
  "cpuCount", "cpuUsedPercent", "cpuUserPercent", "cpuSystemPercent", "cpuIoWaitPercent", "cpuStealPercent",
  "load1", "load5", "load15", "memoryTotalBytes", "memoryUsedBytes", "memoryUsedPercent",
  "swapTotalBytes", "swapUsedBytes", "swapUsedPercent", "swapInBytesPerSecond", "swapOutBytesPerSecond",
  "uptimeSeconds", "diskReadBytesPerSecond", "diskWriteBytesPerSecond", "diskReadOpsPerSecond", "diskWriteOpsPerSecond",
  "networkReceiveBytesPerSecond", "networkTransmitBytesPerSecond", "networkReceiveErrorsPerSecond", "networkTransmitErrorsPerSecond",
  "networkReceiveDropsPerSecond", "networkTransmitDropsPerSecond",
  ...["cpuPressure", "memoryPressure", "ioPressure"].flatMap(pressure =>
    ["someAvg10", "someAvg60", "someAvg300", "fullAvg10", "fullAvg60", "fullAvg300"].map(field => `${pressure}.${field}`)),
] as readonly string[];
export const monitorObjectMetricKeys = ["totalBytes", "freeBytes", "usedBytes", "usedPercent", "celsius", "maximum", "critical"] as const;
export const monitorDeploymentMetricKeys = ["cpuUsedPercent", "memoryBytes", "restartCount", "uptimeSeconds", "statusCode"] as const;
export const monitorMetricKeys = [...new Set([...monitorHostMetricKeys, ...monitorObjectMetricKeys, ...monitorDeploymentMetricKeys])];
export const monitorStatisticSuffixes = ["sum", "min", "max", "last", "weight"] as const;
export function monitorMetricColumn(key: string): string {
  return key.replace(/\./g, "_").replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

export interface MonitorMetricStatistic {
  sum: number;
  min: number;
  max: number;
  last: number;
  weight: number;
}
