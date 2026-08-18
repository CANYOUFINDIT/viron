export interface MonitorPressureSnapshot {
  someAvg10: number;
  someAvg60: number;
  someAvg300: number;
  fullAvg10: number;
  fullAvg60: number;
  fullAvg300: number;
}

export interface MonitorProcessSnapshot {
  pid: number;
  name: string;
  executable?: string;
  user?: string;
  cpuUsedPercent: number;
  memoryBytes: number;
  diskReadBytesPerSecond: number;
  diskWriteBytesPerSecond: number;
  workloadProvider?: string;
  workloadId?: string;
  workloadName?: string;
}

export interface MonitorPerformanceHostSnapshot {
  metricsVersion: number;
  cpuCount: number | null;
  cpuUsedPercent: number | null;
  cpuUserPercent: number | null;
  cpuSystemPercent: number | null;
  cpuIoWaitPercent: number | null;
  cpuStealPercent: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memoryUsedPercent: number | null;
  swapUsedPercent: number | null;
  swapInBytesPerSecond: number | null;
  swapOutBytesPerSecond: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  diskReadOpsPerSecond: number | null;
  diskWriteOpsPerSecond: number | null;
  networkReceiveBytesPerSecond: number | null;
  networkTransmitBytesPerSecond: number | null;
  networkReceiveErrorsPerSecond: number | null;
  networkTransmitErrorsPerSecond: number | null;
  networkReceiveDropsPerSecond: number | null;
  networkTransmitDropsPerSecond: number | null;
  cpuPressure: MonitorPressureSnapshot;
  memoryPressure: MonitorPressureSnapshot;
  ioPressure: MonitorPressureSnapshot;
  topProcesses: MonitorProcessSnapshot[];
}

export interface MonitorPerformancePoint {
  at: string;
  breakBefore: boolean;
  host: MonitorPerformanceHostSnapshot;
}

export type MonitorDiagnosticType =
  | "cpu_saturation"
  | "cpu_iowait"
  | "blocked_load"
  | "memory_pressure"
  | "swap_activity"
  | "disk_io_pressure"
  | "network_errors";

export interface MonitorDiagnosticFinding {
  id: string;
  type: MonitorDiagnosticType;
  severity: "warning" | "critical";
  startedAt: string;
  endedAt: string;
  sampleCount: number;
  peakValue: number;
  topProcesses: MonitorProcessSnapshot[];
}

export interface MonitorMetricSummary {
  average: number | null;
  p95: number | null;
  maximum: number | null;
  latest: number | null;
  changePercent: number | null;
}

export interface MonitorPerformanceSummary {
  cpu: MonitorMetricSummary;
  memory: MonitorMetricSummary;
  loadPerCpu: MonitorMetricSummary;
  diskThroughput: MonitorMetricSummary;
  networkThroughput: MonitorMetricSummary;
  pressure: MonitorMetricSummary;
}

interface DiagnosticSignal {
  type: MonitorDiagnosticType;
  severity: "warning" | "critical";
  value: number;
  topProcesses: MonitorProcessSnapshot[];
}

function finite(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function monitorProcessIdentity(process: MonitorProcessSnapshot): string {
  if (process.workloadProvider && process.workloadId) return `workload:${process.workloadProvider}:${process.workloadId}`;
  return `process:${process.user ?? ""}:${process.executable || process.name}`;
}

export function monitorProcessLabel(process: MonitorProcessSnapshot): string {
  return process.workloadName || process.executable || process.name;
}

export function aggregateMonitorProcessesByIdentity(processes: MonitorProcessSnapshot[]): MonitorProcessSnapshot[] {
  const aggregated = new Map<string, MonitorProcessSnapshot>();
  for (const process of processes) {
    const key = monitorProcessIdentity(process);
    const current = aggregated.get(key);
    if (!current) {
      aggregated.set(key, { ...process });
      continue;
    }
    current.pid = process.pid;
    current.cpuUsedPercent += process.cpuUsedPercent;
    current.memoryBytes += process.memoryBytes;
    current.diskReadBytesPerSecond += process.diskReadBytesPerSecond;
    current.diskWriteBytesPerSecond += process.diskWriteBytesPerSecond;
    current.name ||= process.name;
    current.executable ||= process.executable;
    current.user ||= process.user;
    current.workloadProvider ||= process.workloadProvider;
    current.workloadId ||= process.workloadId;
    current.workloadName ||= process.workloadName;
  }
  return [...aggregated.values()];
}

function pointSignals(point: MonitorPerformancePoint): DiagnosticSignal[] {
  const host = point.host;
  const signals: DiagnosticSignal[] = [];
  const advancedMetrics = host.metricsVersion >= 2;
  const cpu = finite(host.cpuUsedPercent);
  const cpuPressure = advancedMetrics ? finite(host.cpuPressure?.someAvg10) : 0;
  const memory = finite(host.memoryUsedPercent);
  const memoryPressure = advancedMetrics ? Math.max(finite(host.memoryPressure?.someAvg10), finite(host.memoryPressure?.fullAvg10)) : 0;
  const ioPressure = advancedMetrics ? Math.max(finite(host.ioPressure?.someAvg10), finite(host.ioPressure?.fullAvg10) * 2) : 0;
  const ioWait = advancedMetrics ? finite(host.cpuIoWaitPercent) : 0;
  const swapRate = advancedMetrics ? finite(host.swapInBytesPerSecond) + finite(host.swapOutBytesPerSecond) : 0;
  const networkErrors = advancedMetrics ? finite(host.networkReceiveErrorsPerSecond)
    + finite(host.networkTransmitErrorsPerSecond)
    + finite(host.networkReceiveDropsPerSecond)
    + finite(host.networkTransmitDropsPerSecond) : 0;
  const loadPerCpu = finite(host.load1) / Math.max(1, finite(host.cpuCount));
  const cpuProcesses = [...(host.topProcesses ?? [])].sort((left, right) => right.cpuUsedPercent - left.cpuUsedPercent).slice(0, 5);
  const memoryProcesses = [...(host.topProcesses ?? [])].sort((left, right) => right.memoryBytes - left.memoryBytes).slice(0, 5);
  const ioProcesses = [...(host.topProcesses ?? [])].sort((left, right) => (
    right.diskReadBytesPerSecond + right.diskWriteBytesPerSecond
  ) - (
    left.diskReadBytesPerSecond + left.diskWriteBytesPerSecond
  )).slice(0, 5);

  if (cpu >= 85 || cpuPressure >= 10) signals.push({
    type: "cpu_saturation",
    severity: cpu >= 95 || cpuPressure >= 25 ? "critical" : "warning",
    value: Math.max(cpu, cpuPressure),
    topProcesses: cpuProcesses,
  });
  if (ioWait >= 10) signals.push({
    type: "cpu_iowait",
    severity: ioWait >= 25 ? "critical" : "warning",
    value: ioWait,
    topProcesses: ioProcesses,
  });
  if (loadPerCpu >= 1.2 && cpu < 70) signals.push({
    type: "blocked_load",
    severity: loadPerCpu >= 2 ? "critical" : "warning",
    value: loadPerCpu,
    topProcesses: ioProcesses,
  });
  if (memory >= 95 || (memory >= 85 && (memoryPressure >= 5 || finite(host.swapUsedPercent) >= 5))) signals.push({
    type: "memory_pressure",
    severity: memory >= 97 || memoryPressure >= 15 ? "critical" : "warning",
    value: Math.max(memory, memoryPressure),
    topProcesses: memoryProcesses,
  });
  if (swapRate >= 1024 * 1024) signals.push({
    type: "swap_activity",
    severity: swapRate >= 20 * 1024 * 1024 ? "critical" : "warning",
    value: swapRate,
    topProcesses: memoryProcesses,
  });
  if (ioPressure >= 10 || ioWait >= 15) signals.push({
    type: "disk_io_pressure",
    severity: ioPressure >= 25 || ioWait >= 30 ? "critical" : "warning",
    value: Math.max(ioPressure, ioWait),
    topProcesses: ioProcesses,
  });
  if (networkErrors >= 0.1) signals.push({
    type: "network_errors",
    severity: networkErrors >= 5 ? "critical" : "warning",
    value: networkErrors,
    topProcesses: [],
  });
  return signals;
}

export function buildMonitorDiagnostics(points: MonitorPerformancePoint[]): MonitorDiagnosticFinding[] {
  const active = new Map<MonitorDiagnosticType, MonitorDiagnosticFinding>();
  const findings: MonitorDiagnosticFinding[] = [];
  const finish = (type: MonitorDiagnosticType) => {
    const finding = active.get(type);
    if (!finding) return;
    findings.push(finding);
    active.delete(type);
  };
  for (const point of points) {
    if (point.breakBefore) for (const type of [...active.keys()]) finish(type);
    const signals = pointSignals(point);
    const currentTypes = new Set(signals.map((signal) => signal.type));
    for (const type of [...active.keys()]) if (!currentTypes.has(type)) finish(type);
    for (const signal of signals) {
      const current = active.get(signal.type);
      if (!current) {
        active.set(signal.type, {
          id: `${signal.type}:${point.at}`,
          type: signal.type,
          severity: signal.severity,
          startedAt: point.at,
          endedAt: point.at,
          sampleCount: 1,
          peakValue: signal.value,
          topProcesses: signal.topProcesses,
        });
        continue;
      }
      current.endedAt = point.at;
      current.sampleCount += 1;
      if (signal.severity === "critical") current.severity = "critical";
      if (signal.value >= current.peakValue) {
        current.peakValue = signal.value;
        current.topProcesses = signal.topProcesses;
      }
    }
  }
  for (const type of [...active.keys()]) finish(type);
  return findings.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function metricSummary(values: Array<number | null | undefined>): MonitorMetricSummary {
  const finiteValues = values.filter((value): value is number => Number.isFinite(value));
  if (!finiteValues.length) return { average: null, p95: null, maximum: null, latest: null, changePercent: null };
  const sorted = [...finiteValues].sort((left, right) => left - right);
  const average = finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
  const segmentSize = Math.max(1, Math.floor(finiteValues.length / 3));
  const first = finiteValues.slice(0, segmentSize).reduce((sum, value) => sum + value, 0) / segmentSize;
  const lastValues = finiteValues.slice(-segmentSize);
  const last = lastValues.reduce((sum, value) => sum + value, 0) / lastValues.length;
  return {
    average,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!,
    maximum: sorted.at(-1)!,
    latest: finiteValues.at(-1)!,
    changePercent: Math.abs(first) < 1e-9 ? null : (last - first) / Math.abs(first) * 100,
  };
}

export function summarizeMonitorPerformance(points: MonitorPerformancePoint[]): MonitorPerformanceSummary {
  return {
    cpu: metricSummary(points.map((point) => finite(point.host.cpuUsedPercent))),
    memory: metricSummary(points.map((point) => finite(point.host.memoryUsedPercent))),
    loadPerCpu: metricSummary(points.map((point) => finite(point.host.load1) / Math.max(1, finite(point.host.cpuCount)))),
    diskThroughput: metricSummary(points.map((point) => point.host.metricsVersion >= 2
      ? finite(point.host.diskReadBytesPerSecond) + finite(point.host.diskWriteBytesPerSecond)
      : null)),
    networkThroughput: metricSummary(points.map((point) => point.host.metricsVersion >= 2
      ? finite(point.host.networkReceiveBytesPerSecond) + finite(point.host.networkTransmitBytesPerSecond)
      : null)),
    pressure: metricSummary(points.map((point) => point.host.metricsVersion >= 2 ? Math.max(
      finite(point.host.cpuPressure?.someAvg10),
      finite(point.host.memoryPressure?.someAvg10),
      finite(point.host.ioPressure?.someAvg10),
    ) : null)),
  };
}
