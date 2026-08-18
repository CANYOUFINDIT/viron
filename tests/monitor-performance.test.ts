import { describe, expect, it } from "vitest";
import {
  aggregateMonitorProcessesByIdentity,
  buildMonitorDiagnostics,
  monitorProcessIdentity,
  summarizeMonitorPerformance,
  type MonitorPerformancePoint,
  type MonitorProcessSnapshot,
} from "../src/shared/monitor-performance.js";

const pressure = { someAvg10: 0, someAvg60: 0, someAvg300: 0, fullAvg10: 0, fullAvg60: 0, fullAvg300: 0 };

function process(pid: number, name: string, cpu: number, memory: number, io = 0): MonitorProcessSnapshot {
  return {
    pid,
    name,
    executable: name,
    user: "service",
    cpuUsedPercent: cpu,
    memoryBytes: memory,
    diskReadBytesPerSecond: io,
    diskWriteBytesPerSecond: 0,
  };
}

function point(at: string, cpu: number, memory: number, topProcesses: MonitorProcessSnapshot[], extra: Partial<MonitorPerformancePoint["host"]> = {}): MonitorPerformancePoint {
  return {
    at,
    breakBefore: false,
    host: {
      metricsVersion: 2,
      cpuCount: 8,
      cpuUsedPercent: cpu,
      cpuUserPercent: cpu * 0.7,
      cpuSystemPercent: cpu * 0.2,
      cpuIoWaitPercent: cpu * 0.1,
      cpuStealPercent: 0,
      load1: cpu / 10,
      load5: cpu / 12,
      load15: cpu / 15,
      memoryUsedPercent: memory,
      swapUsedPercent: 0,
      swapInBytesPerSecond: 0,
      swapOutBytesPerSecond: 0,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
      diskReadOpsPerSecond: 0,
      diskWriteOpsPerSecond: 0,
      networkReceiveBytesPerSecond: 0,
      networkTransmitBytesPerSecond: 0,
      networkReceiveErrorsPerSecond: 0,
      networkTransmitErrorsPerSecond: 0,
      networkReceiveDropsPerSecond: 0,
      networkTransmitDropsPerSecond: 0,
      cpuPressure: { ...pressure },
      memoryPressure: { ...pressure },
      ioPressure: { ...pressure },
      topProcesses,
      ...extra,
    },
  };
}

describe("monitor performance diagnostics", () => {
  it("groups sustained bottlenecks and preserves the top processes at the peak", () => {
    const points = [
      point("2026-08-10T10:00:00.000Z", 90, 70, [process(11, "java", 45, 2_000)]),
      point("2026-08-10T10:00:30.000Z", 97, 72, [process(12, "java", 60, 2_200), process(22, "mysql", 20, 1_800)]),
      point("2026-08-10T10:01:00.000Z", 40, 70, [process(12, "java", 10, 2_100)]),
    ];
    const findings = buildMonitorDiagnostics(points);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "cpu_saturation",
        severity: "critical",
        startedAt: "2026-08-10T10:00:00.000Z",
        endedAt: "2026-08-10T10:00:30.000Z",
        sampleCount: 2,
        peakValue: 97,
        topProcesses: expect.arrayContaining([expect.objectContaining({ name: "java", cpuUsedPercent: 60 })]),
      }),
    ]));
  });

  it("summarizes current, average, p95, peak, and direction for the selected range", () => {
    const summary = summarizeMonitorPerformance([
      point("2026-08-10T10:00:00.000Z", 10, 40, []),
      point("2026-08-10T10:00:30.000Z", 30, 50, []),
      point("2026-08-10T10:01:00.000Z", 50, 60, []),
    ]);
    expect(summary.cpu).toMatchObject({ average: 30, maximum: 50, latest: 50, changePercent: 400 });
    expect(summary.memory).toMatchObject({ average: 50, maximum: 60, latest: 60, changePercent: 50 });
  });

  it("uses the workload identity across PID changes", () => {
    expect(monitorProcessIdentity({ ...process(101, "java", 20, 100), workloadProvider: "systemd", workloadId: "api.service" }))
      .toBe(monitorProcessIdentity({ ...process(202, "java", 30, 120), workloadProvider: "systemd", workloadId: "api.service" }));
  });

  it("sums simultaneous processes that share a stable identity", () => {
    expect(aggregateMonitorProcessesByIdentity([
      process(101, "node", 12, 100, 20),
      process(202, "node", 18, 150, 30),
    ])).toEqual([
      expect.objectContaining({ pid: 202, cpuUsedPercent: 30, memoryBytes: 250, diskReadBytesPerSecond: 50 }),
    ]);
  });

  it("does not report advanced metrics for legacy samples", () => {
    const legacy = point("2026-08-10T10:00:00.000Z", 30, 40, [], {
      metricsVersion: 1,
      diskReadBytesPerSecond: 0,
      networkReceiveBytesPerSecond: 0,
    });
    const summary = summarizeMonitorPerformance([legacy]);
    expect(summary.cpu.latest).toBe(30);
    expect(summary.diskThroughput.latest).toBeNull();
    expect(summary.networkThroughput.latest).toBeNull();
    expect(summary.pressure.latest).toBeNull();
  });
});
