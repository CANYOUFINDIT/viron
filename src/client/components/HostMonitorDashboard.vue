<script setup lang="ts">
import { Activity, CircleGauge, Clock3, Cpu, Gauge, HardDrive, MemoryStick, RefreshCw, Thermometer } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type {
  MonitorDiagnosticFinding,
  MonitorPerformanceHostSnapshot,
  MonitorPerformanceSummary,
  MonitorProcessSnapshot,
} from "../../shared/monitor-performance";
import { aggregateMonitorProcessesByIdentity, monitorProcessIdentity, monitorProcessLabel } from "../../shared/monitor-performance";
import { api } from "../api";
import { translate as tr } from "../i18n";
import {
  DEFAULT_MONITOR_HISTORY_RANGE,
  monitorHistoryLoadPlan,
  QUICK_MONITOR_HISTORY_RANGE,
  type MonitorHistoryRange,
} from "../monitor-history-loading";
import MonitorTimeSeriesChart, {
  type MonitorChartAnnotation,
  type MonitorChartSeries,
  type MonitorChartTooltipRow,
} from "./MonitorTimeSeriesChart.vue";

type HistoryRange = MonitorHistoryRange;
type ProcessMetric = "cpu" | "memory" | "io";
export type HostFocusMetric = "cpu" | "memory" | "disk" | "network" | "load" | "io" | "pressure" | "swap" | "uptime" | "temperature";
type ChartId =
  | "cpu-process" | "cpu-mode" | "memory-percent" | "memory-process" | "load"
  | "swap-percent" | "swap-rate" | "io-process" | "disk-iops" | "network"
  | "network-errors" | "pressure" | "uptime" | "temperature" | "disk-percent" | "disk-capacity";
type CpuView = "process" | "mode";
type MemoryView = "percent" | "process";
type NetworkView = "throughput" | "errors";
type IoView = "process" | "iops";
type SwapView = "percent" | "rate";

interface HistoryDisk {
  path: string;
  device: string;
  filesystem: string;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
}

interface HistoryTemperature {
  chip: string;
  feature: string;
  celsius: number | null;
  maximum: number | null;
  critical: number | null;
}

interface HistoryPoint {
  at: string;
  breakBefore: boolean;
  resolutionSeconds: number;
  sampleCount: number;
  host: MonitorPerformanceHostSnapshot & {
    memoryTotalBytes: number | null;
    memoryUsedBytes: number | null;
    swapTotalBytes: number | null;
    swapUsedBytes: number | null;
    uptimeSeconds: number | null;
    disks: HistoryDisk[];
    temperatures: HistoryTemperature[];
  };
}

interface HistoryResponse {
  range: HistoryRange;
  from: string;
  to: string;
  sourceSampleCount: number;
  sampledPointCount?: number;
  points: HistoryPoint[];
  diagnostics: MonitorDiagnosticFinding[];
  summary: MonitorPerformanceSummary;
  gaps: Array<{ startedAt: string; endedAt: string; reason: string }>;
}

interface ProcessComposition {
  series: MonitorChartSeries[];
  totals: Array<number | null>;
  tooltipRows: MonitorChartTooltipRow[][];
}

const emptyMetric = { average: null, p95: null, maximum: null, latest: null, changePercent: null };
const emptySummary: MonitorPerformanceSummary = {
  cpu: { ...emptyMetric }, memory: { ...emptyMetric }, loadPerCpu: { ...emptyMetric },
  diskThroughput: { ...emptyMetric }, networkThroughput: { ...emptyMetric }, pressure: { ...emptyMetric },
};
const processColors = ["#397ea8", "#d28a3a", "#6c8e58", "#9a66a8", "#c15f67"];
const otherProcessColor = "#8a9699";

const props = withDefaults(defineProps<{
  environmentId: string;
  hostId: string;
  lastCollectedAt: string | null;
  focusMetric?: HostFocusMetric;
  cpuThreshold?: number;
  memoryThreshold?: number;
  diskThreshold?: number;
}>(), {
  focusMetric: "cpu",
  cpuThreshold: 80,
  memoryThreshold: 80,
  diskThreshold: 80,
});
const emit = defineEmits<{ "update:focusMetric": [value: HostFocusMetric] }>();
const range = ref<HistoryRange>(DEFAULT_MONITOR_HISTORY_RANGE);
const loading = ref(false);
const loadingRange = ref<HistoryRange | null>(null);
const error = ref("");
const selectedFocus = ref<HostFocusMetric>(props.focusMetric);
const cpuView = ref<CpuView>("process");
const memoryView = ref<MemoryView>("percent");
const networkView = ref<NetworkView>("throughput");
const ioView = ref<IoView>("process");
const swapView = ref<SwapView>("percent");
const showAllMetrics = ref(false);
const history = ref<HistoryResponse>({
  range: DEFAULT_MONITOR_HISTORY_RANGE, from: "", to: "", sourceSampleCount: 0, points: [], diagnostics: [], summary: emptySummary, gaps: [],
});
const selectedDisk = ref("");
let requestSequence = 0;
let loadedContext = "";

const ranges: Array<{ value: HistoryRange; label: string }> = [
  { value: "1h", label: tr("1 小时") }, { value: "6h", label: tr("6 小时") }, { value: "24h", label: tr("24 小时") },
  { value: "7d", label: tr("7 天") }, { value: "30d", label: tr("30 天") },
];
function rangeLabel(value: HistoryRange): string {
  return ranges.find((item) => item.value === value)?.label ?? value;
}
const points = computed(() => history.value.points);
const loadingStatus = computed(() => {
  if (!loading.value || !points.value.length) return "";
  if (history.value.range === QUICK_MONITOR_HISTORY_RANGE && range.value !== QUICK_MONITOR_HISTORY_RANGE) {
    return tr("已显示 {{0}}，正在补齐 {{1}}", [rangeLabel(history.value.range), rangeLabel(range.value)]);
  }
  return tr("正在后台更新监控数据");
});
const initialLoadingLabel = computed(() => (
  loadingRange.value === QUICK_MONITOR_HISTORY_RANGE && range.value !== QUICK_MONITOR_HISTORY_RANGE
    ? tr("正在优先读取最近 1 小时的数据")
    : tr("正在读取监控历史")
));
const diskOptions = computed(() => {
  const options = new Map<string, { value: string; label: string }>();
  for (const point of points.value) for (const disk of point.host.disks) {
    const key = `${disk.path}\0${disk.device}`;
    options.set(key, { value: key, label: disk.device ? `${disk.path} · ${disk.device}` : disk.path });
  }
  return [...options.values()];
});
const activeDisk = computed(() => selectedDisk.value || diskOptions.value[0]?.value || "");
watch(diskOptions, (options) => {
  if (!options.some((item) => item.value === selectedDisk.value)) selectedDisk.value = options[0]?.value ?? "";
}, { immediate: true });

async function loadHistory() {
  const sequence = ++requestSequence;
  const context = `${props.environmentId}:${props.hostId}`;
  if (context !== loadedContext) {
    loadedContext = context;
    history.value = {
      range: DEFAULT_MONITOR_HISTORY_RANGE, from: "", to: "", sourceSampleCount: 0, points: [], diagnostics: [], summary: emptySummary, gaps: [],
    };
  }
  const targetRange = range.value;
  const loadPlan = monitorHistoryLoadPlan(targetRange, Boolean(history.value.from || history.value.to));
  loading.value = true;
  error.value = "";
  let lastError = "";
  for (const requestedRange of loadPlan) {
    if (sequence !== requestSequence) return;
    loadingRange.value = requestedRange;
    try {
      const response = await api<HistoryResponse>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${props.hostId}/history?range=${requestedRange}`);
      if (sequence !== requestSequence) return;
      history.value = response;
      lastError = "";
    } catch (caught) {
      if (sequence !== requestSequence) return;
      lastError = caught instanceof Error ? caught.message : tr("监控历史加载失败");
    }
  }
  if (sequence === requestSequence) {
    error.value = lastError;
    loading.value = false;
    loadingRange.value = null;
  }
}

watch([() => props.environmentId, () => props.hostId, () => props.lastCollectedAt, range], () => void loadHistory(), { immediate: true });
watch(() => props.focusMetric, (value) => { if (value) selectedFocus.value = value; });
watch(() => props.hostId, () => { showAllMetrics.value = false; });

function setFocus(value: HostFocusMetric) {
  selectedFocus.value = value;
  emit("update:focusMetric", value);
}

function values(read: (point: HistoryPoint) => number | null | undefined): Array<number | null> {
  return points.value.map((point) => Number.isFinite(read(point)) ? Number(read(point)) : null);
}
function series(key: string, label: string, color: string, read: (point: HistoryPoint) => number | null | undefined): MonitorChartSeries {
  return { key, label, color, values: values(read) };
}
function diskAt(point: HistoryPoint): HistoryDisk | undefined {
  return point.host.disks.find((disk) => `${disk.path}\0${disk.device}` === activeDisk.value);
}
function hasValues(items: MonitorChartSeries[]): boolean {
  return items.some((item) => item.values.some((value) => Number.isFinite(value)));
}
function processMetric(process: MonitorProcessSnapshot, metric: ProcessMetric): number {
  if (metric === "cpu") return process.cpuUsedPercent;
  if (metric === "memory") return process.memoryBytes;
  return process.diskReadBytesPerSecond + process.diskWriteBytesPerSecond;
}
function advancedMetric(point: HistoryPoint, read: (host: HistoryPoint["host"]) => number | null | undefined): number | null {
  if (point.host.metricsVersion < 2) return null;
  const value = read(point.host);
  return Number.isFinite(value) ? Number(value) : null;
}
function pointTotal(point: HistoryPoint, metric: ProcessMetric): number | null {
  if (point.host.metricsVersion < 2) return null;
  if (metric === "cpu") return Number(point.host.cpuUsedPercent ?? 0);
  if (metric === "memory") return Number(point.host.memoryUsedBytes ?? 0);
  return Number(point.host.diskReadBytesPerSecond ?? 0) + Number(point.host.diskWriteBytesPerSecond ?? 0);
}
function processComposition(metric: ProcessMetric): ProcessComposition {
  const scores = new Map<string, { process: MonitorProcessSnapshot; score: number }>();
  for (const point of points.value) for (const process of aggregateMonitorProcessesByIdentity(point.host.topProcesses)) {
    const key = monitorProcessIdentity(process);
    const current = scores.get(key) ?? { process, score: 0 };
    current.score += processMetric(process, metric);
    current.process = process;
    scores.set(key, current);
  }
  const dominant = [...scores.entries()].sort((left, right) => right[1].score - left[1].score).slice(0, 5);
  const dominantIndex = new Map(dominant.map(([key], index) => [key, index]));
  const totals = points.value.map((point) => pointTotal(point, metric));
  const componentValues = dominant.map(() => [] as Array<number | null>);
  const otherValues: Array<number | null> = [];
  const tooltipRows: MonitorChartTooltipRow[][] = [];
  points.value.forEach((point, pointIndex) => {
    const total = totals[pointIndex];
    if (total === null) {
      componentValues.forEach((values) => values.push(null));
      otherValues.push(null);
      tooltipRows.push([]);
      return;
    }
    const byIdentity = new Map(aggregateMonitorProcessesByIdentity(point.host.topProcesses).map((process) => [monitorProcessIdentity(process), process]));
    const rawValues = dominant.map(([key]) => processMetric(byIdentity.get(key) ?? {
      pid: 0, name: "", cpuUsedPercent: 0, memoryBytes: 0, diskReadBytesPerSecond: 0, diskWriteBytesPerSecond: 0,
    }, metric));
    const rawSum = rawValues.reduce((sum, value) => sum + value, 0);
    const scale = rawSum > total && rawSum > 0 ? total / rawSum : 1;
    rawValues.forEach((value, index) => componentValues[index]!.push(value * scale));
    otherValues.push(Math.max(0, total - rawSum * scale));
    const actual = [...point.host.topProcesses].sort((left, right) => processMetric(right, metric) - processMetric(left, metric)).slice(0, 5);
    const actualSum = actual.reduce((sum, process) => sum + processMetric(process, metric), 0);
    const actualScale = actualSum > total && actualSum > 0 ? total / actualSum : 1;
    tooltipRows.push([
      ...actual.map((process, index) => ({
        key: `${monitorProcessIdentity(process)}:${process.pid}`,
        label: monitorProcessLabel(process),
        color: dominantIndex.has(monitorProcessIdentity(process)) ? processColors[dominantIndex.get(monitorProcessIdentity(process))!]! : processColors[index]!,
        value: processMetric(process, metric) * actualScale,
      })),
      { key: "other", label: tr("其他进程"), color: otherProcessColor, value: Math.max(0, total - actualSum * actualScale) },
    ]);
  });
  return {
    totals,
    tooltipRows,
    series: [
      ...dominant.map(([key, value], index) => ({ key, label: monitorProcessLabel(value.process), color: processColors[index]!, values: componentValues[index]! })),
      { key: "other", label: tr("其他进程"), color: otherProcessColor, values: otherValues },
    ],
  };
}

const cpuComposition = computed(() => processComposition("cpu"));
const memoryComposition = computed(() => processComposition("memory"));
const ioComposition = computed(() => processComposition("io"));
const cpuModeSeries = computed(() => [
  series("user", tr("用户态"), "var(--color-info)", (point) => advancedMetric(point, (host) => host.cpuUserPercent)),
  series("system", tr("内核态"), "var(--color-accent)", (point) => advancedMetric(point, (host) => host.cpuSystemPercent)),
  series("iowait", "I/O Wait", "var(--color-warning)", (point) => advancedMetric(point, (host) => host.cpuIoWaitPercent)),
  series("steal", "Steal", "var(--color-danger)", (point) => advancedMetric(point, (host) => host.cpuStealPercent)),
]);
const memoryPercentSeries = computed(() => [series("memory", tr("内存利用率"), "var(--color-accent)", (point) => point.host.memoryUsedPercent)]);
const loadSeries = computed(() => [
  series("load1", "Load 1", "var(--color-info)", (point) => point.host.load1),
  series("load5", "Load 5", "var(--color-warning)", (point) => point.host.load5),
  series("load15", "Load 15", "var(--color-accent)", (point) => point.host.load15),
]);
const swapPercentSeries = computed(() => [series("swap", tr("Swap 使用率"), "var(--color-warning)", (point) => advancedMetric(point, (host) => host.swapUsedPercent))]);
const swapRateSeries = computed(() => [
  series("swap-in", tr("换入"), "var(--color-info)", (point) => advancedMetric(point, (host) => host.swapInBytesPerSecond)),
  series("swap-out", tr("换出"), "var(--color-danger)", (point) => advancedMetric(point, (host) => host.swapOutBytesPerSecond)),
]);
const diskIOPS = computed(() => [
  series("read", tr("读取"), "var(--color-info)", (point) => advancedMetric(point, (host) => host.diskReadOpsPerSecond)),
  series("write", tr("写入"), "var(--color-warning)", (point) => advancedMetric(point, (host) => host.diskWriteOpsPerSecond)),
]);
const networkSeries = computed(() => [
  series("receive", tr("接收"), "var(--color-info)", (point) => advancedMetric(point, (host) => host.networkReceiveBytesPerSecond)),
  series("transmit", tr("发送"), "var(--color-accent)", (point) => advancedMetric(point, (host) => host.networkTransmitBytesPerSecond)),
]);
const networkErrorSeries = computed(() => [
  series("errors", tr("错误"), "var(--color-danger)", (point) => advancedMetric(point, (host) => Number(host.networkReceiveErrorsPerSecond ?? 0) + Number(host.networkTransmitErrorsPerSecond ?? 0))),
  series("drops", tr("丢包"), "var(--color-warning)", (point) => advancedMetric(point, (host) => Number(host.networkReceiveDropsPerSecond ?? 0) + Number(host.networkTransmitDropsPerSecond ?? 0))),
]);
const pressureSeries = computed(() => [
  series("cpu", "CPU PSI", "var(--color-info)", (point) => advancedMetric(point, (host) => host.cpuPressure.someAvg10)),
  series("memory", tr("内存 PSI"), "var(--color-accent)", (point) => advancedMetric(point, (host) => host.memoryPressure.someAvg10)),
  series("io", "I/O PSI", "var(--color-warning)", (point) => advancedMetric(point, (host) => host.ioPressure.someAvg10)),
]);
const diskPercentSeries = computed(() => [series("disk-used", tr("已用空间"), "var(--color-warning)", (point) => diskAt(point)?.usedPercent)]);
const diskCapacitySeries = computed(() => [
  series("used", tr("已用"), "var(--color-warning)", (point) => diskAt(point)?.usedBytes),
  series("free", tr("可用"), "var(--color-accent)", (point) => diskAt(point)?.freeBytes),
  series("total", tr("总量"), "var(--color-muted)", (point) => diskAt(point)?.totalBytes),
]);
const uptimeSeries = computed(() => [series("uptime", tr("运行时间"), "var(--color-info)", (point) => point.host.uptimeSeconds)]);
const temperatureSeries = computed(() => {
  const sensors = new Map<string, string>();
  for (const point of points.value) for (const temperature of point.host.temperatures) {
    const key = `${temperature.chip}\0${temperature.feature}`;
    sensors.set(key, temperature.feature ? `${temperature.chip} · ${temperature.feature}` : temperature.chip);
  }
  const colors = ["var(--color-danger)", "var(--color-warning)", "var(--color-info)", "var(--color-accent)", "#7d63b8", "#bd6f91"];
  return [...sensors].map(([key, label], index) => series(key, label, colors[index % colors.length]!, (point) => point.host.temperatures.find((temperature) => `${temperature.chip}\0${temperature.feature}` === key)?.celsius));
});

function diagnosticLabel(type: MonitorDiagnosticFinding["type"]): string {
  return ({
    cpu_saturation: tr("CPU 饱和"), cpu_iowait: tr("CPU 等待 I/O"), blocked_load: tr("阻塞型高负载"),
    memory_pressure: tr("内存压力"), swap_activity: tr("活跃换页"), disk_io_pressure: tr("磁盘 I/O 压力"), network_errors: tr("网络错误或丢包"),
  })[type];
}
function annotations(types: MonitorDiagnosticFinding["type"][]): MonitorChartAnnotation[] {
  const selected = new Set(types);
  return history.value.diagnostics.filter((finding) => selected.has(finding.type)).map((finding) => ({
    startedAt: finding.startedAt, endedAt: finding.endedAt, severity: finding.severity, label: diagnosticLabel(finding.type),
  }));
}
const cpuAnnotations = computed(() => annotations(["cpu_saturation", "cpu_iowait", "blocked_load"]));
const memoryAnnotations = computed(() => annotations(["memory_pressure", "swap_activity"]));
const ioAnnotations = computed(() => annotations(["cpu_iowait", "blocked_load", "disk_io_pressure"]));
const networkAnnotations = computed(() => annotations(["network_errors"]));
const diagnosticItems = computed(() => history.value.diagnostics.slice(0, 8));
const summaryCards = computed(() => [
  { key: "cpu", label: tr("CPU"), value: history.value.summary.cpu, format: "percent" },
  { key: "memory", label: tr("内存"), value: history.value.summary.memory, format: "percent" },
  { key: "load", label: tr("每核负载"), value: history.value.summary.loadPerCpu, format: "decimal" },
  { key: "disk", label: tr("磁盘吞吐"), value: history.value.summary.diskThroughput, format: "rate" },
  { key: "network", label: tr("网络吞吐"), value: history.value.summary.networkThroughput, format: "rate" },
  { key: "pressure", label: tr("最高 PSI"), value: history.value.summary.pressure, format: "percent" },
]);
const focusedSummary = computed(() => {
  const key = ({
    cpu: "cpu", memory: "memory", load: "load", disk: "disk", io: "disk",
    network: "network", pressure: "pressure", swap: "memory", uptime: "cpu", temperature: "cpu",
  } as const)[selectedFocus.value];
  return summaryCards.value.find((item) => item.key === key) ?? summaryCards.value[0]!;
});
const sampleMeta = computed(() => {
  const sampled = history.value.sampledPointCount;
  const source = history.value.sourceSampleCount;
  if (sampled && sampled < source) return `${source.toLocaleString()} → ${sampled.toLocaleString()}`;
  return source ? source.toLocaleString() : "";
});
const charts = computed(() => {
  const diskLabel = diskOptions.value.find((item) => item.value === activeDisk.value)?.label ?? "";
  return [
    {
      id: "cpu-process" as const, available: hasValues(cpuComposition.value.series),
      icon: Cpu, title: tr("CPU 进程占用组成"), subtitle: "", format: "percent" as const, yMax: 100,
      stacked: true, series: cpuComposition.value.series, totalValues: cpuComposition.value.totals,
      tooltipRows: cpuComposition.value.tooltipRows, annotations: cpuAnnotations.value,
      totalLabel: tr("CPU 总利用率"), threshold: props.cpuThreshold,
    },
    {
      id: "cpu-mode" as const, available: hasValues(cpuModeSeries.value),
      icon: Cpu, title: tr("CPU 时间组成"), subtitle: "", format: "percent" as const, yMax: 100,
      stacked: false, series: cpuModeSeries.value, totalValues: [], tooltipRows: [],
      annotations: cpuAnnotations.value, totalLabel: "", threshold: props.cpuThreshold,
    },
    {
      id: "memory-percent" as const, available: hasValues(memoryPercentSeries.value),
      icon: MemoryStick, title: tr("内存利用率"), subtitle: "", format: "percent" as const, yMax: 100,
      stacked: false, series: memoryPercentSeries.value, totalValues: [], tooltipRows: [],
      annotations: memoryAnnotations.value, totalLabel: "", threshold: props.memoryThreshold,
    },
    {
      id: "memory-process" as const, available: hasValues(memoryComposition.value.series),
      icon: MemoryStick, title: tr("内存进程占用组成"), subtitle: "", format: "bytes" as const,
      stacked: true, series: memoryComposition.value.series, totalValues: memoryComposition.value.totals,
      tooltipRows: memoryComposition.value.tooltipRows, annotations: memoryAnnotations.value,
      totalLabel: tr("已用内存"), threshold: null, yMax: undefined,
    },
    {
      id: "load" as const, available: hasValues(loadSeries.value),
      icon: Gauge, title: tr("系统负载"), subtitle: "", format: "decimal" as const,
      stacked: false, series: loadSeries.value, totalValues: [], tooltipRows: [],
      annotations: [], totalLabel: "", threshold: null, yMax: undefined,
    },
    {
      id: "swap-percent" as const, available: hasValues(swapPercentSeries.value),
      icon: MemoryStick, title: tr("Swap 使用率"), subtitle: "", format: "percent" as const, yMax: 100,
      stacked: false, series: swapPercentSeries.value, totalValues: [], tooltipRows: [],
      annotations: memoryAnnotations.value, totalLabel: "", threshold: 50,
    },
    {
      id: "swap-rate" as const, available: hasValues(swapRateSeries.value),
      icon: MemoryStick, title: tr("Swap 换页速率"), subtitle: "", format: "bytesPerSecond" as const,
      stacked: false, series: swapRateSeries.value, totalValues: [], tooltipRows: [],
      annotations: memoryAnnotations.value, totalLabel: "", threshold: null, yMax: undefined,
    },
    {
      id: "io-process" as const, available: hasValues(ioComposition.value.series),
      icon: HardDrive, title: tr("磁盘 I/O 进程组成"), subtitle: "", format: "bytesPerSecond" as const,
      stacked: true, series: ioComposition.value.series, totalValues: ioComposition.value.totals,
      tooltipRows: ioComposition.value.tooltipRows, annotations: ioAnnotations.value,
      totalLabel: tr("磁盘总吞吐"), threshold: null, yMax: undefined,
    },
    {
      id: "disk-iops" as const, available: hasValues(diskIOPS.value),
      icon: HardDrive, title: tr("磁盘 IOPS"), subtitle: "", format: "opsPerSecond" as const,
      stacked: false, series: diskIOPS.value, totalValues: [], tooltipRows: [],
      annotations: ioAnnotations.value, totalLabel: "", threshold: null, yMax: undefined,
    },
    {
      id: "network" as const, available: hasValues(networkSeries.value),
      icon: Activity, title: tr("网络吞吐"), subtitle: "", format: "bytesPerSecond" as const,
      stacked: false, series: networkSeries.value, totalValues: [], tooltipRows: [],
      annotations: networkAnnotations.value, totalLabel: "", threshold: null, yMax: undefined,
    },
    {
      id: "network-errors" as const, available: hasValues(networkErrorSeries.value),
      icon: Activity, title: tr("网络错误与丢包"), subtitle: "", format: "decimal" as const,
      stacked: false, series: networkErrorSeries.value, totalValues: [], tooltipRows: [],
      annotations: networkAnnotations.value, totalLabel: "", threshold: null, yMax: undefined,
    },
    {
      id: "pressure" as const, available: hasValues(pressureSeries.value),
      icon: CircleGauge, title: tr("资源压力 PSI"), subtitle: "", format: "percent" as const, yMax: 100,
      stacked: false, series: pressureSeries.value, totalValues: [], tooltipRows: [],
      annotations: [...cpuAnnotations.value, ...memoryAnnotations.value, ...ioAnnotations.value],
      totalLabel: "", threshold: 20,
    },
    {
      id: "uptime" as const, available: hasValues(uptimeSeries.value),
      icon: Clock3, title: tr("运行时间"), subtitle: "", format: "duration" as const,
      stacked: false, series: uptimeSeries.value, totalValues: [], tooltipRows: [],
      annotations: [], totalLabel: "", threshold: null, yMax: undefined,
    },
    {
      id: "temperature" as const, available: hasValues(temperatureSeries.value),
      icon: Thermometer, title: tr("硬件温度"), subtitle: "", format: "temperature" as const,
      stacked: false, series: temperatureSeries.value, totalValues: [], tooltipRows: [],
      annotations: [], totalLabel: "", threshold: 80, yMax: undefined,
    },
    {
      id: "disk-percent" as const, available: hasValues(diskPercentSeries.value),
      icon: HardDrive, title: tr("磁盘利用率"), subtitle: diskLabel, format: "percent" as const, yMax: 100,
      stacked: false, series: diskPercentSeries.value, totalValues: [], tooltipRows: [],
      annotations: [], totalLabel: "", threshold: props.diskThreshold,
    },
    {
      id: "disk-capacity" as const, available: hasValues(diskCapacitySeries.value),
      icon: HardDrive, title: tr("磁盘容量"), subtitle: diskLabel, format: "bytes" as const,
      stacked: false, series: diskCapacitySeries.value, totalValues: [], tooltipRows: [],
      annotations: [], totalLabel: "", threshold: null, yMax: undefined,
    },
  ];
});
const focusOptions = computed(() => ([
  { value: "cpu" as const, label: "CPU", available: true },
  { value: "memory" as const, label: tr("内存"), available: true },
  { value: "disk" as const, label: tr("磁盘"), available: diskOptions.value.length > 0 },
  { value: "network" as const, label: tr("网络"), available: hasValues(networkSeries.value) || hasValues(networkErrorSeries.value) },
  { value: "load" as const, label: tr("负载"), available: hasValues(loadSeries.value) },
  { value: "io" as const, label: "I/O", available: hasValues(ioComposition.value.series) || hasValues(diskIOPS.value) },
  { value: "pressure" as const, label: "PSI", available: hasValues(pressureSeries.value) },
  { value: "swap" as const, label: "Swap", available: hasValues(swapPercentSeries.value) || hasValues(swapRateSeries.value) },
  { value: "uptime" as const, label: tr("运行时间"), available: hasValues(uptimeSeries.value) },
  { value: "temperature" as const, label: tr("温度"), available: hasValues(temperatureSeries.value) },
] as const).filter((item) => item.available));
const heroChartId = computed<ChartId>(() => {
  if (selectedFocus.value === "cpu") return cpuView.value === "mode" ? "cpu-mode" : "cpu-process";
  if (selectedFocus.value === "memory") return memoryView.value === "process" ? "memory-process" : "memory-percent";
  if (selectedFocus.value === "disk") return "disk-percent";
  if (selectedFocus.value === "network") return networkView.value === "errors" ? "network-errors" : "network";
  if (selectedFocus.value === "load") return "load";
  if (selectedFocus.value === "io") return ioView.value === "iops" ? "disk-iops" : "io-process";
  if (selectedFocus.value === "pressure") return "pressure";
  if (selectedFocus.value === "swap") return swapView.value === "rate" ? "swap-rate" : "swap-percent";
  if (selectedFocus.value === "uptime") return "uptime";
  return "temperature";
});
const secondaryChartIds = computed<ChartId[]>(() => {
  const used = new Set<ChartId>([heroChartId.value]);
  const preferred: ChartId[] = selectedFocus.value === "disk"
    ? ["disk-capacity", "memory-percent", "cpu-process"]
    : selectedFocus.value === "cpu"
      ? ["memory-percent", "disk-percent"]
      : selectedFocus.value === "memory"
        ? ["cpu-process", "disk-percent"]
        : ["cpu-process", "memory-percent", "disk-percent"];
  return preferred.filter((id) => {
    if (used.has(id)) return false;
    const chart = charts.value.find((item) => item.id === id);
    if (!chart?.available) return false;
    used.add(id);
    return true;
  }).slice(0, 2);
});
const extraCharts = computed(() => {
  const visible = new Set<ChartId>([heroChartId.value, ...secondaryChartIds.value]);
  return charts.value.filter((item) => item.available && !visible.has(item.id));
});
const secondaryCharts = computed(() => secondaryChartIds.value.flatMap((id) => {
  const chart = charts.value.find((item) => item.id === id);
  return chart ? [chart] : [];
}));
const heroChart = computed(() => charts.value.find((item) => item.id === heroChartId.value && item.available) ?? null);
const heroViews = computed(() => {
  if (selectedFocus.value === "cpu") return [
    { value: "process", label: tr("进程"), current: cpuView.value === "process", apply: () => { cpuView.value = "process"; } },
    { value: "mode", label: tr("时间"), current: cpuView.value === "mode", apply: () => { cpuView.value = "mode"; } },
  ];
  if (selectedFocus.value === "memory") return [
    { value: "percent", label: tr("利用率"), current: memoryView.value === "percent", apply: () => { memoryView.value = "percent"; } },
    { value: "process", label: tr("进程"), current: memoryView.value === "process", apply: () => { memoryView.value = "process"; } },
  ];
  if (selectedFocus.value === "network") return [
    { value: "throughput", label: tr("吞吐"), current: networkView.value === "throughput", apply: () => { networkView.value = "throughput"; } },
    { value: "errors", label: tr("错误"), current: networkView.value === "errors", apply: () => { networkView.value = "errors"; } },
  ];
  if (selectedFocus.value === "io") return [
    { value: "process", label: tr("进程"), current: ioView.value === "process", apply: () => { ioView.value = "process"; } },
    { value: "iops", label: "IOPS", current: ioView.value === "iops", apply: () => { ioView.value = "iops"; } },
  ];
  if (selectedFocus.value === "swap") return [
    { value: "percent", label: tr("利用率"), current: swapView.value === "percent", apply: () => { swapView.value = "percent"; } },
    { value: "rate", label: tr("换页"), current: swapView.value === "rate", apply: () => { swapView.value = "rate"; } },
  ];
  return [];
});
function meaningfulChange(value: number | null): string {
  if (value == null || Math.abs(value) < 5) return "";
  return `${value > 0 ? "↑" : "↓"} ${Math.abs(value).toFixed(1)}%`;
}
const extraMetricsLabel = computed(() => showAllMetrics.value ? tr("收起其余指标") : tr("其余 {{0}} 项指标", [extraCharts.value.length]));

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = Math.max(0, value);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unit]}`;
}
function summaryValue(value: number | null, format: string): string {
  if (value == null) return "—";
  if (format === "percent") return `${value.toFixed(1)}%`;
  if (format === "rate") return `${formatBytes(value)}/s`;
  return value.toFixed(2);
}
function diagnosticPeak(finding: MonitorDiagnosticFinding): string {
  if (finding.type === "swap_activity") return `${formatBytes(finding.peakValue)}/s`;
  if (finding.type === "network_errors") return `${finding.peakValue.toFixed(2)}/s`;
  if (finding.type === "blocked_load") return finding.peakValue.toFixed(2);
  return `${finding.peakValue.toFixed(1)}%`;
}
function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
function sampledPointLabel(count: number): string { return tr("图表已降采样为 {{0}} 个点", [count]); }
</script>

<template>
  <section class="monitor-history">
    <header class="monitor-history__toolbar">
      <div class="monitor-history__focus" role="tablist" :aria-label="$t('监控指标')">
        <button
          v-for="item in focusOptions"
          :key="item.value"
          type="button"
          role="tab"
          :aria-selected="selectedFocus === item.value"
          :class="{ 'is-active': selectedFocus === item.value }"
          @click="setFocus(item.value)"
        >{{ item.label }}</button>
      </div>
      <div class="monitor-history__ranges" role="group" :aria-label="$t('监控时间范围')">
        <button v-for="item in ranges" :key="item.value" type="button" :class="{ 'is-active': range === item.value }" @click="range = item.value">{{ item.label }}</button>
      </div>
      <button class="monitor-history__refresh" type="button" :disabled="loading" :title="$t('刷新监控历史')" @click="loadHistory"><RefreshCw :size="15" :class="{ 'is-spinning': loading }" /></button>
    </header>

    <div v-if="error && !points.length" class="monitor-history__notice is-error"><CircleGauge :size="18" /><span>{{ error }}</span><button type="button" @click="loadHistory">{{ $t('重试') }}</button></div>
    <div v-else-if="loading && !points.length" class="monitor-history__notice"><RefreshCw :size="18" class="is-spinning" /><span>{{ initialLoadingLabel }}</span></div>
    <div v-else-if="!points.length" class="monitor-history__notice"><Activity :size="19" /><span>{{ $t('当前时间范围还没有监控样本') }}</span></div>

    <template v-else>
      <div class="monitor-history__meta">
        <span :title="sampleMeta ? sampledPointLabel(history.sampledPointCount || history.sourceSampleCount) : ''">{{ formatTime(history.from) }} - {{ formatTime(history.to) }}</span>
        <span v-if="loadingStatus" class="monitor-history__load-status"><RefreshCw :size="12" class="is-spinning" />{{ loadingStatus }}</span>
        <button v-else-if="error" class="monitor-history__load-status is-error" type="button" :title="error" @click="loadHistory"><CircleGauge :size="12" />{{ $t('后台更新失败，点击重试') }}</button>
        <span v-if="history.gaps.length" class="is-warning">{{ history.gaps.length }} {{ $t('处采集断档') }}</span>
        <span v-if="diskOptions.length && selectedFocus === 'disk'" class="monitor-history__disk">
          <el-select v-model="selectedDisk" size="small">
            <el-option v-for="item in diskOptions" :key="item.value" :value="item.value" :label="item.label" />
          </el-select>
        </span>
      </div>

      <section v-if="diagnosticItems.length" class="monitor-diagnostics" :aria-label="$t('自动性能诊断')">
        <header><strong>{{ $t('诊断') }}</strong><b>{{ diagnosticItems.length }}</b></header>
        <div>
          <article v-for="finding in diagnosticItems" :key="finding.id" :class="`is-${finding.severity}`">
            <header><strong>{{ diagnosticLabel(finding.type) }}</strong><span>{{ finding.severity === 'critical' ? $t('严重') : $t('注意') }}</span></header>
            <p>{{ formatTime(finding.startedAt) }} - {{ formatTime(finding.endedAt) }} · {{ $t('峰值') }} {{ diagnosticPeak(finding) }}</p>
            <small v-if="finding.topProcesses.length">{{ finding.topProcesses.slice(0, 3).map((process) => monitorProcessLabel(process)).join('、') }}</small>
          </article>
        </div>
      </section>

      <div v-if="heroChart" class="monitor-history__hero">
        <div class="monitor-history__hero-bar">
          <div v-if="heroViews.length" class="monitor-history__views" role="group">
            <button v-for="item in heroViews" :key="item.value" type="button" :class="{ 'is-active': item.current }" @click="item.apply()">{{ item.label }}</button>
          </div>
          <dl class="monitor-history__stats">
            <div><dt>{{ $t('当前') }}</dt><dd>{{ summaryValue(focusedSummary.value.latest, focusedSummary.format) }}</dd></div>
            <div><dt>{{ $t('平均') }}</dt><dd>{{ summaryValue(focusedSummary.value.average, focusedSummary.format) }}</dd></div>
            <div><dt>P95</dt><dd>{{ summaryValue(focusedSummary.value.p95, focusedSummary.format) }}</dd></div>
            <div><dt>{{ $t('峰值') }}</dt><dd>{{ summaryValue(focusedSummary.value.maximum, focusedSummary.format) }}</dd></div>
            <div v-if="meaningfulChange(focusedSummary.value.changePercent)"><dt>{{ $t('变化') }}</dt><dd :class="(focusedSummary.value.changePercent || 0) > 0 ? 'is-up' : 'is-down'">{{ meaningfulChange(focusedSummary.value.changePercent) }}</dd></div>
          </dl>
        </div>
        <MonitorTimeSeriesChart
          :icon="heroChart.icon"
          :points="points"
          :series="heroChart.series"
          :title="heroChart.title"
          :subtitle="heroChart.subtitle"
          :format="heroChart.format"
          :y-max="heroChart.yMax"
          :stacked="heroChart.stacked"
          :total-values="heroChart.totalValues"
          :tooltip-rows="heroChart.tooltipRows"
          :annotations="heroChart.annotations"
          :total-label="heroChart.totalLabel"
          :threshold="heroChart.threshold"
          size="hero"
        />
      </div>

      <div class="monitor-history__secondary">
        <MonitorTimeSeriesChart
          v-for="chart in secondaryCharts"
          :key="chart.id"
          :icon="chart.icon"
          :points="points"
          :series="chart.series"
          :title="chart.title"
          :subtitle="chart.subtitle"
          :format="chart.format"
          :y-max="chart.yMax"
          :stacked="chart.stacked"
          :total-values="chart.totalValues"
          :tooltip-rows="chart.tooltipRows"
          :annotations="chart.annotations"
          :total-label="chart.totalLabel"
          :threshold="chart.threshold"
        />
      </div>

      <details class="monitor-history__summary" :aria-label="$t('趋势摘要')">
        <summary>{{ $t('区间摘要') }}</summary>
        <div>
          <article v-for="item in summaryCards" :key="item.key">
            <span>{{ item.label }}</span>
            <strong>{{ summaryValue(item.value.latest, item.format) }}</strong>
            <small>{{ $t('平均') }} {{ summaryValue(item.value.average, item.format) }} · P95 {{ summaryValue(item.value.p95, item.format) }} · {{ $t('峰值') }} {{ summaryValue(item.value.maximum, item.format) }}</small>
          </article>
        </div>
      </details>

      <button v-if="extraCharts.length" class="monitor-history__more" type="button" :aria-expanded="showAllMetrics" @click="showAllMetrics = !showAllMetrics">
        {{ extraMetricsLabel }}
      </button>
      <div v-if="showAllMetrics && extraCharts.length" class="monitor-chart-grid">
        <MonitorTimeSeriesChart
          v-for="chart in extraCharts"
          :key="chart.id"
          :icon="chart.icon"
          :points="points"
          :series="chart.series"
          :title="chart.title"
          :subtitle="chart.subtitle"
          :format="chart.format"
          :y-max="chart.yMax"
          :stacked="chart.stacked"
          :total-values="chart.totalValues"
          :tooltip-rows="chart.tooltipRows"
          :annotations="chart.annotations"
          :total-label="chart.totalLabel"
          :threshold="chart.threshold"
          size="compact"
        />
      </div>
      <div v-if="showAllMetrics && diskOptions.length && selectedFocus !== 'disk'" class="monitor-history__disk-more">
        <el-select v-model="selectedDisk" size="small">
          <el-option v-for="item in diskOptions" :key="item.value" :value="item.value" :label="item.label" />
        </el-select>
      </div>
    </template>
  </section>
</template>

<style scoped>
.monitor-history { margin-block-start: var(--space-md); display: grid; gap: var(--space-sm); }
.monitor-history__toolbar {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-sm);
}
.monitor-history__focus,
.monitor-history__ranges,
.monitor-history__views {
  padding: 3px;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: flex;
  flex-wrap: wrap;
  background: var(--color-paper-muted);
}
.monitor-history__focus button,
.monitor-history__ranges button,
.monitor-history__views button {
  min-width: 2.5rem;
  height: 1.85rem;
  padding-inline: var(--space-xs);
  border: 0;
  border-radius: calc(var(--radius-control) - 3px);
  background: transparent;
  color: var(--color-muted);
  font: inherit;
  font-size: var(--text-2xs);
  cursor: pointer;
}
.monitor-history__focus button.is-active,
.monitor-history__ranges button.is-active,
.monitor-history__views button.is-active {
  background: var(--color-ink);
  color: var(--color-sidebar-ink);
}
.monitor-history__refresh {
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: var(--color-paper);
  color: var(--color-ink-soft);
  cursor: pointer;
}
.monitor-history__refresh:disabled { opacity: .55; cursor: wait; }
.monitor-history__notice {
  min-height: 7rem;
  padding: var(--space-lg);
  border: 1px dashed var(--color-rule-strong);
  border-radius: var(--radius-panel);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  color: var(--color-muted);
  font-size: var(--text-sm);
}
.monitor-history__notice.is-error { border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-rule)); color: var(--color-danger); }
.monitor-history__notice button { border: 0; background: none; color: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }
.monitor-history__meta {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-md);
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.monitor-history__meta .is-warning { color: var(--color-warning); }
.monitor-history__load-status {
  min-height: 1.5rem;
  padding: 0 var(--space-xs);
  border: 0;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--color-info-soft);
  color: var(--color-info);
  font: inherit;
  font-size: var(--text-2xs);
}
.monitor-history__load-status.is-error { background: var(--color-danger-soft); color: var(--color-danger); cursor: pointer; }
.monitor-history__disk :deep(.el-select),
.monitor-history__disk-more :deep(.el-select) { width: min(18rem, 100%); }
.monitor-diagnostics {
  min-width: 0;
  padding: var(--space-sm);
  border: 1px solid color-mix(in srgb, var(--color-warning) 28%, var(--color-rule));
  border-radius: var(--radius-panel);
  display: grid;
  gap: var(--space-sm);
  background: color-mix(in srgb, var(--color-warning) 6%, var(--color-paper));
}
.monitor-diagnostics > header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.monitor-diagnostics > header strong { font-size: var(--text-sm); }
.monitor-diagnostics > header b { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); font-weight: 500; }
.monitor-diagnostics > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
.monitor-diagnostics article { min-width: 0; padding: var(--space-sm); border-radius: var(--radius-control); background: var(--color-paper); }
.monitor-diagnostics article.is-critical { background: color-mix(in srgb, var(--color-danger-soft) 55%, var(--color-paper)); }
.monitor-diagnostics article header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.monitor-diagnostics article header strong { font-size: var(--text-xs); }
.monitor-diagnostics article header span { color: var(--color-warning); font-size: var(--text-2xs); }
.monitor-diagnostics article.is-critical header span { color: var(--color-danger); }
.monitor-diagnostics article p { margin: 5px 0 0; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); }
.monitor-diagnostics article small { display: block; margin-block-start: 5px; overflow: hidden; color: var(--color-ink-soft); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.monitor-history__hero,
.monitor-history__secondary,
.monitor-chart-grid { min-width: 0; display: grid; gap: var(--space-sm); }
.monitor-history__secondary,
.monitor-chart-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.monitor-history__hero-bar {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-sm);
}
.monitor-history__stats { margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-sm) var(--space-md); }
.monitor-history__stats div { display: grid; gap: 2px; }
.monitor-history__stats dt { color: var(--color-muted); font-size: var(--text-2xs); }
.monitor-history__stats dd { margin: 0; font-family: var(--font-mono); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.monitor-history__stats .is-up { color: var(--color-warning); }
.monitor-history__stats .is-down { color: var(--color-accent); }
.monitor-history__summary { min-width: 0; border-top: 1px solid var(--color-rule); padding-block-start: var(--space-xs); }
.monitor-history__summary summary { color: var(--color-muted); font-size: var(--text-xs); cursor: pointer; }
.monitor-history__summary > div { margin-block-start: var(--space-sm); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-sm); }
.monitor-history__summary article { min-width: 0; display: grid; gap: 2px; }
.monitor-history__summary span { color: var(--color-muted); font-size: var(--text-2xs); }
.monitor-history__summary strong { font-family: var(--font-mono); font-size: var(--text-sm); }
.monitor-history__summary small { color: var(--color-muted); font-size: var(--text-2xs); }
.monitor-history__more {
  width: fit-content;
  min-height: 2rem;
  padding: 0 var(--space-sm);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  background: var(--color-paper);
  color: var(--color-ink-soft);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

@media (max-width: 1080px) {
  .monitor-history__secondary,
  .monitor-chart-grid,
  .monitor-diagnostics > div,
  .monitor-history__summary > div { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .monitor-history__toolbar { grid-template-columns: minmax(0, 1fr) auto; }
  .monitor-history__focus,
  .monitor-history__ranges { grid-column: 1 / -1; overflow-x: auto; }
  .monitor-history__refresh { grid-column: 2; grid-row: 1; }
  .monitor-history__focus button,
  .monitor-history__ranges button { flex: 1 0 3.2rem; }
}
</style>
