<script setup lang="ts">
import {
  Box,
  CircleGauge,
  Clock3,
  Cpu,
  MemoryStick,
  RefreshCw,
  RotateCcw,
  Server,
} from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { api } from "../api";
import { translate as tr } from "../i18n";
import { providerLabel, type Provider } from "../service-candidate-tree";
import MonitorTimeSeriesChart, { type MonitorChartSeries } from "./MonitorTimeSeriesChart.vue";

type HistoryRange = "1h" | "6h" | "24h" | "7d" | "30d";

interface DeploymentTarget {
  id: string;
  sshConnectionId: string | null;
  sshConnectionName: string;
  provider: Provider;
  externalId: string;
  displayName: string;
  connectionAvailable: boolean;
  lastCheckedAt: string | null;
}

interface DeploymentMetric {
  deploymentId: string;
  cpuUsedPercent: number | null;
  memoryBytes: number | null;
  restartCount: number | null;
  uptimeSeconds: number | null;
}

interface HistoryPoint {
  at: string;
  breakBefore: boolean;
  deployments: DeploymentMetric[];
}

interface HistoryResponse {
  range: HistoryRange;
  from: string;
  to: string;
  sourceSampleCount: number;
  sampledPointCount?: number;
  points: HistoryPoint[];
  gaps: Array<{ startedAt: string; endedAt: string; reason: string }>;
}

const props = defineProps<{
  environmentId: string;
  deployments: DeploymentTarget[];
}>();

const range = ref<HistoryRange>("6h");
const loading = ref(false);
const historyByHost = ref<Record<string, HistoryResponse>>({});
const errorByHost = ref<Record<string, string>>({});
let requestSequence = 0;

const ranges: Array<{ value: HistoryRange; label: string }> = [
  { value: "1h", label: tr("1 小时") },
  { value: "6h", label: tr("6 小时") },
  { value: "24h", label: tr("24 小时") },
  { value: "7d", label: tr("7 天") },
  { value: "30d", label: tr("30 天") },
];

const deploymentSignature = computed(() => props.deployments.map((deployment) => [
  deployment.id,
  deployment.sshConnectionId,
  deployment.connectionAvailable,
  deployment.lastCheckedAt,
].join(":"))
  .join("|"));

async function loadHistory() {
  const sequence = ++requestSequence;
  const hostIds = [...new Set(props.deployments
    .filter((deployment) => deployment.connectionAvailable && deployment.sshConnectionId)
    .map((deployment) => deployment.sshConnectionId!))];
  loading.value = true;
  if (!hostIds.length) {
    historyByHost.value = {};
    errorByHost.value = {};
    loading.value = false;
    return;
  }
  const results = await Promise.all(hostIds.map(async (hostId) => {
    try {
      const history = await api<HistoryResponse>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${hostId}/history?range=${range.value}`);
      return { hostId, history, error: "" };
    } catch (caught) {
      return {
        hostId,
        history: null,
        error: caught instanceof Error ? caught.message : tr("监控历史加载失败"),
      };
    }
  }));
  if (sequence !== requestSequence) return;
  historyByHost.value = Object.fromEntries(results.flatMap((result) => result.history ? [[result.hostId, result.history]] : []));
  errorByHost.value = Object.fromEntries(results.flatMap((result) => result.error ? [[result.hostId, result.error]] : []));
  loading.value = false;
}

watch(
  [() => props.environmentId, deploymentSignature, range],
  () => void loadHistory(),
  { immediate: true },
);

function historyFor(deployment: DeploymentTarget): HistoryResponse | null {
  return deployment.sshConnectionId ? historyByHost.value[deployment.sshConnectionId] ?? null : null;
}

function pointsFor(deployment: DeploymentTarget): HistoryPoint[] {
  return historyFor(deployment)?.points ?? [];
}

function errorFor(deployment: DeploymentTarget): string {
  if (!deployment.connectionAvailable || !deployment.sshConnectionId) return tr("SSH 连接不可用，无法读取监控历史");
  return errorByHost.value[deployment.sshConnectionId] ?? "";
}

function metricAt(point: HistoryPoint, deploymentId: string): DeploymentMetric | undefined {
  return point.deployments.find((metric) => metric.deploymentId === deploymentId);
}

function metricSeries(
  deployment: DeploymentTarget,
  key: string,
  label: string,
  color: string,
  read: (metric: DeploymentMetric) => number | null,
): MonitorChartSeries[] {
  const points = historyFor(deployment)?.points ?? [];
  return [{
    key: `${key}-${deployment.id}`,
    label,
    color,
    values: points.map((point) => {
      const value = metricAt(point, deployment.id);
      const metric = value ? read(value) : null;
      return Number.isFinite(metric) ? Number(metric) : null;
    }),
  }];
}

function cpuSeries(deployment: DeploymentTarget): MonitorChartSeries[] {
  return metricSeries(deployment, "cpu", tr("CPU 利用率"), "var(--color-info)", (metric) => metric.cpuUsedPercent);
}

function memorySeries(deployment: DeploymentTarget): MonitorChartSeries[] {
  return metricSeries(deployment, "memory", tr("内存占用"), "var(--color-accent)", (metric) => metric.memoryBytes);
}

function restartSeries(deployment: DeploymentTarget): MonitorChartSeries[] {
  return metricSeries(deployment, "restarts", tr("重启次数"), "var(--color-warning)", (metric) => metric.restartCount);
}

function uptimeSeries(deployment: DeploymentTarget): MonitorChartSeries[] {
  return metricSeries(deployment, "uptime", tr("运行时间"), "var(--color-info)", (metric) => metric.uptimeSeconds);
}

function deploymentName(deployment: DeploymentTarget): string {
  return deployment.displayName || deployment.externalId;
}

function formatTime(value: string | null): string {
  if (!value) return tr("尚未采集");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return tr("尚未采集");
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
</script>

<template>
  <section class="deployment-monitor">
    <header class="deployment-monitor__toolbar">
      <strong>{{ $t('部署节点监控') }}</strong>
      <div class="deployment-monitor__ranges" role="group" :aria-label="$t('监控时间范围')">
        <button v-for="item in ranges" :key="item.value" type="button" :class="{ 'is-active': range === item.value }" @click="range = item.value">{{ item.label }}</button>
      </div>
      <button class="deployment-monitor__refresh" type="button" :disabled="loading" :title="$t('刷新监控历史')" @click="loadHistory"><RefreshCw :size="15" :class="{ 'is-spinning': loading }" /></button>
    </header>

    <div class="deployment-monitor__nodes">
      <article v-for="deployment in deployments" :key="deployment.id" class="deployment-monitor__node">
        <header>
          <span class="deployment-monitor__node-icon"><Box :size="17" /></span>
          <div>
            <strong>{{ deploymentName(deployment) }}</strong>
            <small>{{ providerLabel(deployment.provider) }} · <Server :size="12" />{{ deployment.sshConnectionName }}</small>
          </div>
          <time>{{ formatTime(deployment.lastCheckedAt) }}</time>
        </header>

        <div v-if="errorFor(deployment)" class="deployment-monitor__notice is-error"><CircleGauge :size="18" /><span>{{ errorFor(deployment) }}</span></div>
        <div v-else-if="loading && !historyFor(deployment)" class="deployment-monitor__notice"><RefreshCw :size="18" class="is-spinning" /><span>{{ $t('正在读取监控历史') }}</span></div>
        <div v-else-if="historyFor(deployment)" class="deployment-monitor__charts">
          <MonitorTimeSeriesChart
            :icon="Cpu"
            :points="pointsFor(deployment)"
            :series="cpuSeries(deployment)"
            :title="$t('CPU 利用率')"
            format="percent"
            :threshold="80"
          />
          <MonitorTimeSeriesChart
            :icon="MemoryStick"
            :points="pointsFor(deployment)"
            :series="memorySeries(deployment)"
            :title="$t('内存占用')"
            format="bytes"
          />
          <MonitorTimeSeriesChart
            :icon="Clock3"
            :points="pointsFor(deployment)"
            :series="uptimeSeries(deployment)"
            :title="$t('运行时间')"
            format="duration"
          />
          <MonitorTimeSeriesChart
            :icon="RotateCcw"
            :points="pointsFor(deployment)"
            :series="restartSeries(deployment)"
            :title="$t('重启次数')"
            format="count"
          />
        </div>
        <div v-else class="deployment-monitor__notice"><CircleGauge :size="18" /><span>{{ $t('当前时间范围还没有监控样本') }}</span></div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.deployment-monitor { margin-block-start: var(--space-lg); padding-block-start: var(--space-md); border-block-start: 1px solid var(--color-rule); display: grid; gap: var(--space-md); }
.deployment-monitor__toolbar {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) auto auto;
  align-items: center;
  gap: var(--space-sm);
}
.deployment-monitor__toolbar > strong { font-size: var(--text-sm); font-weight: 700; }
.deployment-monitor__ranges { padding: 3px; border: 1px solid var(--color-rule); border-radius: var(--radius-control); display: flex; background: var(--color-paper-muted); }
.deployment-monitor__ranges button { min-width: 3.25rem; height: 1.85rem; padding-inline: var(--space-xs); border: 0; border-radius: calc(var(--radius-control) - 3px); background: transparent; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); cursor: pointer; }
.deployment-monitor__ranges button.is-active { background: var(--color-ink); color: var(--color-sidebar-ink); box-shadow: 0 4px 10px color-mix(in srgb, var(--color-ink) 14%, transparent); }
.deployment-monitor__refresh { width: 2.25rem; height: 2.25rem; border: 1px solid var(--color-rule); border-radius: var(--radius-control); display: grid; place-items: center; background: var(--color-paper); color: var(--color-ink-soft); cursor: pointer; }
.deployment-monitor__refresh:disabled { opacity: .55; cursor: wait; }
.deployment-monitor__nodes { min-width: 0; display: grid; gap: var(--space-lg); }
.deployment-monitor__node { min-width: 0; border: 1px solid var(--color-rule); border-radius: var(--radius-panel); overflow: hidden; background: var(--color-paper); }
.deployment-monitor__node > header { min-width: 0; min-height: 4rem; padding: var(--space-sm) var(--space-md); border-block-end: 1px solid var(--color-rule); display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-sm); background: color-mix(in srgb, var(--color-paper-muted) 72%, var(--color-paper)); }
.deployment-monitor__node-icon { width: 2rem; height: 2rem; border-radius: var(--radius-control); display: grid; place-items: center; background: var(--color-accent-soft); color: var(--color-accent-strong); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 20%, transparent); }
.deployment-monitor__node > header > div { min-width: 0; display: grid; gap: 3px; }
.deployment-monitor__node > header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-display); font-size: var(--text-sm); }
.deployment-monitor__node > header small { min-width: 0; display: flex; align-items: center; gap: 4px; overflow: hidden; color: var(--color-muted); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.deployment-monitor__node > header time { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); white-space: nowrap; }
.deployment-monitor__charts { min-width: 0; padding: var(--space-md); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-md); }
.deployment-monitor__notice { min-height: 8rem; padding: var(--space-lg); display: flex; align-items: center; justify-content: center; gap: var(--space-sm); color: var(--color-muted); font-size: var(--text-sm); }
.deployment-monitor__notice.is-error { color: var(--color-danger); }

@media (max-width: 1080px) {
  .deployment-monitor__charts { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .deployment-monitor__toolbar { grid-template-columns: minmax(0, 1fr) auto; }
  .deployment-monitor__ranges { grid-column: 1 / -1; overflow-x: auto; }
  .deployment-monitor__ranges button { flex: 1 0 3.6rem; }
  .deployment-monitor__refresh { grid-column: 2; grid-row: 1; }
  .deployment-monitor__node > header { grid-template-columns: auto minmax(0, 1fr); }
  .deployment-monitor__node > header time { grid-column: 2; }
  .deployment-monitor__charts { padding: var(--space-sm); }
}
</style>
