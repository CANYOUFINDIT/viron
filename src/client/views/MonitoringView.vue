<script setup lang="ts">
import {
  Activity,
  Boxes,
  CheckCircle2,
  Cpu,
  HardDrive,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  SlidersHorizontal,
} from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import HostFleetPanel, { type MonitoringHostCard } from "../components/monitoring/HostFleetPanel.vue";
import NocScreen from "../components/monitoring/NocScreen.vue";
import ServiceApmPanel, { type MonitoringProblemNode, type MonitoringServiceCard } from "../components/monitoring/ServiceApmPanel.vue";
import { translate as tr } from "../i18n";
import { session } from "../session";
import type { MonitorAlertItem } from "../../shared/monitor-alerts";
import type { MonitoringRange, MonitoringRefreshSeconds } from "../../shared/monitoring";

interface OverviewPayload {
  generatedAt: string;
  truncated?: boolean;
  partialFailures: string[];
  summary: {
    hostTotal: number;
    hostOnline: number;
    hostOffline: number;
    hostMissing: number;
    hostStale: number;
    serviceTotal: number;
    avgCpuPercent: number | null;
    avgMemoryPercent: number | null;
    diskAlerts: number;
  };
  hosts: MonitoringHostCard[];
  services: MonitoringServiceCard[];
  serviceRanking: MonitoringServiceCard[];
  problemNodes: MonitoringProblemNode[];
}

interface EnvironmentOption { id: string; name: string }

type MonitoringView = "hosts" | "services" | "noc";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const refreshing = ref(false);
const environments = ref<EnvironmentOption[]>([]);
const overview = ref<OverviewPayload | null>(null);
const timeseriesPoints = ref<Array<{ at: string; breakBefore?: boolean; cpuUsedPercent: number | null; memoryBytes: number | null }>>([]);
const loadingTimeseries = ref(false);
const lastUpdated = ref("");
const error = ref("");
const alerts = ref<MonitorAlertItem[]>([]);
let overviewAbort: AbortController | null = null;
let timeseriesAbort: AbortController | null = null;
let alertsAbort: AbortController | null = null;
let refreshTimer: number | undefined;
let overviewInFlight = false;
let lastTimeseriesAt = 0;

const view = computed<MonitoringView>(() => {
  const value = String(route.query.view ?? "hosts");
  return value === "services" || value === "noc" ? value : "hosts";
});
const environmentId = computed(() => String(route.query.environmentId ?? ""));
const range = computed<MonitoringRange>(() => {
  const value = String(route.query.range ?? "1h");
  return (["1h", "6h", "24h", "7d", "30d"] as const).includes(value as MonitoringRange) ? value as MonitoringRange : "1h";
});
const refreshSeconds = computed<MonitoringRefreshSeconds>(() => {
  const value = Number(route.query.refresh ?? 15);
  return value === 0 || value === 30 || value === 60 ? value : 15;
});
const selectedHostId = computed(() => String(route.query.hostId ?? ""));
const selectedServiceId = computed(() => String(route.query.serviceId ?? ""));
const canOperate = computed(() => ["owner", "admin"].includes(session.workspace?.role ?? ""));

function patchQuery(next: Record<string, string | undefined>) {
  const query = { ...route.query, ...next };
  for (const key of Object.keys(query)) if (!query[key]) delete query[key];
  void router.replace({ name: "monitoring", query });
}

async function loadEnvironments() {
  const response = await api<{ items: EnvironmentOption[] }>("/api/v1/environments");
  environments.value = response.items.map((item) => ({ id: item.id, name: item.name }));
}

async function loadOverview(silent = false) {
  overviewAbort?.abort();
  overviewAbort = new AbortController();
  const signal = overviewAbort.signal;
  overviewInFlight = true;
  if (!silent) loading.value = true;
  else refreshing.value = true;
  try {
    const params = new URLSearchParams();
    if (environmentId.value) params.set("environmentId", environmentId.value);
    const response = await api<OverviewPayload>(`/api/v1/monitoring/overview${params.size ? `?${params}` : ""}`, { signal });
    if (signal.aborted) return;
    overview.value = response;
    lastUpdated.value = response.generatedAt;
    error.value = "";
    void loadAlerts();
    if (view.value === "hosts" && !selectedHostId.value && response.hosts[0]) {
      patchQuery({ hostId: response.hosts[0].sshConnectionId, environmentId: environmentId.value || response.hosts[0].environmentId });
    }
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError" || signal.aborted) return;
    error.value = caught instanceof Error ? caught.message : tr("读取监控概览失败");
  } finally {
    if (overviewAbort?.signal === signal) {
      overviewInFlight = false;
      loading.value = false;
      refreshing.value = false;
    }
  }
}

async function loadAlerts() {
  alertsAbort?.abort();
  alertsAbort = new AbortController();
  try {
    const params = new URLSearchParams();
    if (environmentId.value) params.set("environmentId", environmentId.value);
    const response = await api<{ items: MonitorAlertItem[] }>(`/api/v1/monitor-alerts${params.size ? `?${params}` : ""}`, { signal: alertsAbort.signal });
    alerts.value = response.items;
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    alerts.value = [];
  }
}

async function loadTimeseries() {
  timeseriesAbort?.abort();
  timeseriesAbort = new AbortController();
  const signal = timeseriesAbort.signal;
  const serviceId = selectedServiceId.value;
  if (!serviceId || view.value !== "services") {
    timeseriesPoints.value = [];
    loadingTimeseries.value = false;
    return;
  }
  loadingTimeseries.value = true;
  try {
    const response = await api<{ points: typeof timeseriesPoints.value }>(
      `/api/v1/monitoring/services/${serviceId}/timeseries?range=${range.value}`,
      { signal },
    );
    if (signal.aborted || selectedServiceId.value !== serviceId || view.value !== "services") return;
    timeseriesPoints.value = response.points;
    lastTimeseriesAt = Date.now();
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError" || signal.aborted) return;
    timeseriesPoints.value = [];
    ElMessage.warning(caught instanceof Error ? caught.message : tr("暂无服务时序"));
  } finally {
    if (timeseriesAbort?.signal === signal) loadingTimeseries.value = false;
  }
}

function stopRefresh() {
  if (refreshTimer === undefined) return;
  window.clearInterval(refreshTimer);
  refreshTimer = undefined;
}

function startRefresh() {
  stopRefresh();
  if (!refreshSeconds.value) return;
  refreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    void loadOverview(true);
    if (view.value === "services" && Date.now() - lastTimeseriesAt >= 30_000) void loadTimeseries();
    void loadAlerts();
  }, refreshSeconds.value * 1000);
}

function onVisibility() {
  if (document.hidden) return;
  void loadOverview(true);
}

onMounted(async () => {
  document.addEventListener("visibilitychange", onVisibility);
  try {
    await loadEnvironments();
    await loadOverview();
    if (view.value === "services") await loadTimeseries();
    startRefresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : tr("读取监控概览失败");
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  stopRefresh();
  overviewAbort?.abort();
  timeseriesAbort?.abort();
  alertsAbort?.abort();
  document.removeEventListener("visibilitychange", onVisibility);
});

watch([environmentId, view], () => { void loadOverview(true); });
watch([selectedServiceId, range, view], () => {
  void loadTimeseries();
});
watch(refreshSeconds, () => startRefresh());

function selectHost(host: MonitoringHostCard) {
  patchQuery({ view: "hosts", hostId: host.sshConnectionId, environmentId: environmentId.value || host.environmentId });
}
function selectService(service: MonitoringServiceCard) {
  patchQuery({ view: "services", serviceId: service.id, environmentId: environmentId.value || service.environmentId });
}
function inspectNode(node: MonitoringProblemNode) {
  if (!node.environmentId) {
    patchQuery({ view: "services", serviceId: String(node.serviceId) });
    return;
  }
  void router.push({
    name: "environment",
    params: { id: String(node.environmentId) },
    query: { tab: "maintenance", serviceId: String(node.serviceId), deploymentId: String(node.id) },
  });
}

function openHostMaintenance(host: MonitoringHostCard) {
  void router.push({
    name: "environment",
    params: { id: host.environmentId },
    query: { tab: "maintenance", hostId: host.sshConnectionId },
  });
}
function openInstall(host: MonitoringHostCard) {
  void router.push({ name: "environment", params: { id: host.environmentId }, query: { tab: "maintenance", maintenanceHostId: host.sshConnectionId } });
}

const summary = computed(() => overview.value?.summary ?? {
  hostTotal: 0, hostOnline: 0, hostOffline: 0, hostMissing: 0, hostStale: 0, serviceTotal: 0, avgCpuPercent: null, avgMemoryPercent: null, diskAlerts: 0,
});

const onlineRate = computed(() => {
  if (!summary.value.hostTotal) return 0;
  return Math.round((summary.value.hostOnline / summary.value.hostTotal) * 100);
});

function cpuTone(val: number | null) {
  if (val === null) return "is-muted";
  if (val >= 85) return "is-danger";
  if (val >= 70) return "is-warning";
  return "is-healthy";
}

function memTone(val: number | null) {
  if (val === null) return "is-muted";
  if (val >= 90) return "is-danger";
  if (val >= 75) return "is-warning";
  return "is-healthy";
}
</script>

<template>
  <section class="monitoring-view" v-loading="loading">
    <!-- 顶部智能操作工具栏 -->
    <header class="monitoring-topbar">
      <div class="monitoring-topbar__title-group">
        <div class="title-with-pulse">
          <span class="live-dot" :class="{ 'is-paused': refreshSeconds === 0 }"></span>
          <h1>{{ $t('监控大盘') }}</h1>
        </div>
        <div class="monitoring-live-status">
          <span v-if="lastUpdated" class="updated-time">
            {{ $t('上次更新') }} {{ new Date(lastUpdated).toLocaleTimeString() }}
          </span>
          <span v-if="refreshSeconds > 0" class="refresh-badge is-active">
            <Play :size="11" /> {{ refreshSeconds }}s {{ $t('自动刷新') }}
          </span>
          <span v-else class="refresh-badge is-paused">
            <Pause :size="11" /> {{ $t('已暂停') }}
          </span>
        </div>
      </div>

      <!-- 中间视图分段切换器 (Segmented Control) -->
      <nav class="monitoring-view-switcher" role="tablist" :aria-label="$t('视图模式')">
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'hosts'"
          :class="{ 'is-active': view === 'hosts' }"
          @click="patchQuery({ view: 'hosts' })"
        >
          <Server :size="14" />
          <span>{{ $t('主机基础设施') }}</span>
          <small v-if="summary.hostTotal" class="tab-badge">{{ summary.hostTotal }}</small>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'services'"
          :class="{ 'is-active': view === 'services' }"
          @click="patchQuery({ view: 'services' })"
        >
          <Boxes :size="14" />
          <span>{{ $t('业务服务') }}</span>
          <small v-if="summary.serviceTotal" class="tab-badge">{{ summary.serviceTotal }}</small>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'noc'"
          :class="{ 'is-active': view === 'noc' }"
          @click="patchQuery({ view: 'noc' })"
        >
          <Radio :size="14" />
          <span>{{ $t('NOC 全屏') }}</span>
        </button>
      </nav>

      <!-- 右侧参数过滤与刷新操作 -->
      <div class="monitoring-controls">
        <el-select
          :model-value="environmentId"
          clearable
          :placeholder="$t('全部环境')"
          class="control-env-select"
          @change="(value: string) => patchQuery({ environmentId: value, hostId: undefined, serviceId: undefined })"
        >
          <el-option v-for="item in environments" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>

        <el-select
          :model-value="range"
          class="control-range-select"
          @change="(value: string) => patchQuery({ range: value })"
        >
          <el-option value="1h" :label="$t('1 小时')" />
          <el-option value="6h" :label="$t('6 小时')" />
          <el-option value="24h" :label="$t('24 小时')" />
          <el-option value="7d" :label="$t('7 天')" />
          <el-option value="30d" :label="$t('30 天')" />
        </el-select>

        <el-select
          :model-value="String(refreshSeconds)"
          class="control-refresh-select"
          @change="(value: string) => patchQuery({ refresh: value })"
        >
          <el-option value="15" :label="$t('15 秒')" />
          <el-option value="30" :label="$t('30 秒')" />
          <el-option value="60" :label="$t('60 秒')" />
          <el-option value="0" :label="$t('暂停刷新')" />
        </el-select>

        <el-button
          type="primary"
          plain
          class="control-refresh-btn"
          :loading="refreshing"
          @click="loadOverview(true)"
        >
          <RefreshCw :size="13" :class="{ 'is-spinning': refreshing }" />
          <span>{{ $t('立即刷新') }}</span>
        </el-button>
      </div>
    </header>

    <p v-if="error" class="monitoring-banner-error">{{ error }}</p>

    <!-- 全景集群健康 KPI 态势卡片 -->
    <section v-if="view !== 'noc'" class="cluster-kpi-grid">
      <!-- KPI 1: 主机在线与就绪率 -->
      <article class="kpi-card">
        <header class="kpi-card__head">
          <div class="kpi-card__title">
            <span class="kpi-icon is-teal"><Server :size="16" /></span>
            <strong>{{ $t('主机就绪态势') }}</strong>
          </div>
          <span class="kpi-tag" :class="onlineRate >= 80 ? 'is-green' : 'is-warning'">
            {{ onlineRate }}% {{ $t('可用') }}
          </span>
        </header>
        <div class="kpi-card__body">
          <div class="kpi-value-row">
            <span class="kpi-value-main">{{ summary.hostOnline }}<small>/{{ summary.hostTotal }}</small></span>
            <span class="kpi-value-sub">{{ $t('在线主机') }}</span>
          </div>
          <!-- 多色分段健康比率条 -->
          <div class="kpi-segmented-bar" :title="$t('集群主机健康分布')">
            <div
              v-if="summary.hostOnline > 0"
              class="bar-slice is-online"
              :style="{ flex: summary.hostOnline }"
            ></div>
            <div
              v-if="summary.hostStale > 0"
              class="bar-slice is-stale"
              :style="{ flex: summary.hostStale }"
            ></div>
            <div
              v-if="summary.hostOffline > 0"
              class="bar-slice is-offline"
              :style="{ flex: summary.hostOffline }"
            ></div>
            <div
              v-if="summary.hostMissing > 0"
              class="bar-slice is-missing"
              :style="{ flex: summary.hostMissing }"
            ></div>
            <div
              v-if="!summary.hostTotal"
              class="bar-slice is-empty"
              style="flex: 1"
            ></div>
          </div>
          <footer class="kpi-card__footer">
            <span v-if="summary.hostStale > 0" class="status-sub-chip is-stale">{{ summary.hostStale }} {{ $t('陈旧') }}</span>
            <span v-if="summary.hostOffline > 0" class="status-sub-chip is-offline">{{ summary.hostOffline }} {{ $t('离线') }}</span>
            <span v-if="summary.hostMissing > 0" class="status-sub-chip is-missing">{{ summary.hostMissing }} {{ $t('探针缺失') }}</span>
            <span v-if="!summary.hostOffline && !summary.hostMissing && !summary.hostStale && summary.hostTotal" class="status-sub-chip is-healthy">
              <CheckCircle2 :size="11" /> {{ $t('全部健康') }}
            </span>
          </footer>
        </div>
      </article>

      <!-- KPI 2: 集群平均 CPU 水位 -->
      <article class="kpi-card">
        <header class="kpi-card__head">
          <div class="kpi-card__title">
            <span class="kpi-icon is-blue"><Cpu :size="16" /></span>
            <strong>{{ $t('集群平均 CPU') }}</strong>
          </div>
          <span class="kpi-tag" :class="cpuTone(summary.avgCpuPercent)">
            {{ summary.avgCpuPercent === null ? $t('无数据') : (summary.avgCpuPercent >= 80 ? $t('高负荷') : $t('正常')) }}
          </span>
        </header>
        <div class="kpi-card__body">
          <div class="kpi-value-row">
            <span class="kpi-value-main">
              {{ summary.avgCpuPercent === null ? '—' : `${summary.avgCpuPercent.toFixed(1)}%` }}
            </span>
            <span class="kpi-value-sub">{{ $t('整体 CPU 负荷') }}</span>
          </div>
          <!-- 水平刻度进度槽 -->
          <div class="kpi-meter-bar">
            <div
              class="kpi-meter-fill"
              :class="cpuTone(summary.avgCpuPercent)"
              :style="{ width: `${Math.min(100, Math.max(0, summary.avgCpuPercent ?? 0))}%` }"
            ></div>
          </div>
          <footer class="kpi-card__footer">
            <span>{{ $t('基准警戒线') }}: 80%</span>
          </footer>
        </div>
      </article>

      <!-- KPI 3: 集群平均内存消耗 -->
      <article class="kpi-card">
        <header class="kpi-card__head">
          <div class="kpi-card__title">
            <span class="kpi-icon is-purple"><HardDrive :size="16" /></span>
            <strong>{{ $t('集群平均内存') }}</strong>
          </div>
          <span class="kpi-tag" :class="memTone(summary.avgMemoryPercent)">
            {{ summary.avgMemoryPercent === null ? $t('无数据') : (summary.avgMemoryPercent >= 85 ? $t('偏高') : $t('正常')) }}
          </span>
        </header>
        <div class="kpi-card__body">
          <div class="kpi-value-row">
            <span class="kpi-value-main">
              {{ summary.avgMemoryPercent === null ? '—' : `${summary.avgMemoryPercent.toFixed(1)}%` }}
            </span>
            <span class="kpi-value-sub">{{ $t('整体内存利用率') }}</span>
          </div>
          <!-- 水平刻度进度槽 -->
          <div class="kpi-meter-bar">
            <div
              class="kpi-meter-fill is-purple"
              :class="memTone(summary.avgMemoryPercent)"
              :style="{ width: `${Math.min(100, Math.max(0, summary.avgMemoryPercent ?? 0))}%` }"
            ></div>
          </div>
          <footer class="kpi-card__footer">
            <span>{{ $t('基准警戒线') }}: 85%</span>
          </footer>
        </div>
      </article>

      <!-- KPI 4: 存储与告警态势 -->
      <article class="kpi-card">
        <header class="kpi-card__head">
          <div class="kpi-card__title">
            <span class="kpi-icon" :class="summary.diskAlerts > 0 || alerts.length > 0 ? 'is-danger' : 'is-amber'">
              <ShieldAlert :size="16" />
            </span>
            <strong>{{ $t('存储与活动告警') }}</strong>
          </div>
          <span class="kpi-tag" :class="summary.diskAlerts > 0 || alerts.length > 0 ? 'is-danger' : 'is-green'">
            {{ (summary.diskAlerts + alerts.length) === 0 ? $t('平稳运行') : `${summary.diskAlerts + alerts.length} ${$t('项注意')}` }}
          </span>
        </header>
        <div class="kpi-card__body">
          <div class="kpi-value-row">
            <span class="kpi-value-main" :class="{ 'text-danger': summary.diskAlerts > 0 }">
              {{ summary.diskAlerts }}
            </span>
            <span class="kpi-value-sub">{{ $t('磁盘高危水位') }}</span>
          </div>
          <div class="kpi-alerts-chips">
            <span class="alert-indicator-chip" :class="alerts.length > 0 ? 'is-warn' : 'is-ok'">
              {{ alerts.length }} {{ $t('条未恢复告警') }}
            </span>
          </div>
          <footer class="kpi-card__footer">
            <span v-if="!summary.diskAlerts && !alerts.length" class="text-healthy-sub">
              <CheckCircle2 :size="11" /> {{ $t('未发现磁盘与服务异常') }}
            </span>
            <span v-else class="text-danger-sub">
              {{ $t('建议排查高水位分区') }}
            </span>
          </footer>
        </div>
      </article>
    </section>

    <!-- 视图内容区域 -->
    <main class="monitoring-content-stage">
      <HostFleetPanel
        v-if="view === 'hosts'"
        :hosts="overview?.hosts ?? []"
        :selected-host-id="selectedHostId"
        :can-operate="canOperate"
        @select="selectHost"
        @install="openInstall"
        @open-maintenance="openHostMaintenance"
      />
      <ServiceApmPanel
        v-else-if="view === 'services'"
        :services="overview?.services ?? []"
        :ranking="overview?.serviceRanking ?? []"
        :problem-nodes="overview?.problemNodes ?? []"
        :selected-service-id="selectedServiceId"
        :points="timeseriesPoints"
        :loading-timeseries="loadingTimeseries"
        @select="selectService"
        @inspect="inspectNode"
      />
      <NocScreen
        v-else-if="view === 'noc' && overview"
        :generated-at="overview.generatedAt"
        :summary="summary"
        :hosts="overview.hosts"
        :problem-nodes="overview.problemNodes"
        :ranking="overview.serviceRanking"
        :alerts="alerts"
        @exit="patchQuery({ view: 'hosts' })"
      />
    </main>
  </section>
</template>

<style scoped>
.monitoring-view {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 顶部操作工具栏 */
.monitoring-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.monitoring-topbar__title-group {
  display: flex;
  align-items: center;
  gap: 14px;
}

.title-with-pulse {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-with-pulse h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -.02em;
  color: var(--ink-950);
}

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2);
  animation: live-pulse 2s infinite ease-in-out;
}

.live-dot.is-paused {
  background: var(--ink-400);
  box-shadow: none;
  animation: none;
}

@keyframes live-pulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); }
  70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

.monitoring-live-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.updated-time {
  color: var(--ink-400);
  font-family: var(--font-mono);
}

.refresh-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 700;
}

.refresh-badge.is-active {
  background: var(--teal-50);
  color: var(--teal-700);
}

.refresh-badge.is-paused {
  background: var(--ink-50);
  color: var(--ink-500);
}

/* 视图模式分段选择器 */
.monitoring-view-switcher {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--ink-100);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink-100) 45%, var(--surface));
}

.monitoring-view-switcher button {
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ink-500);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: all .16s ease;
}

.monitoring-view-switcher button:hover {
  color: var(--ink-900);
}

.monitoring-view-switcher button.is-active {
  background: var(--surface);
  color: var(--teal-700);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .06);
}

.tab-badge {
  padding: 1px 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--teal-100) 60%, transparent);
  color: var(--teal-700);
  font-family: var(--font-mono);
  font-size: 10px;
}

/* 过滤与控制组 */
.monitoring-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-env-select { width: 140px; }
.control-range-select { width: 96px; }
.control-refresh-select { width: 100px; }

.control-refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
}

.is-spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.monitoring-banner-error {
  margin: 0;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--red-100);
  color: var(--red-600);
  font-size: 12px;
}

/* 集群全景 KPI 态势卡片 */
.cluster-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.kpi-card {
  padding: 14px 16px;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: transform .18s ease, border-color .18s ease;
}

.kpi-card:hover {
  border-color: var(--teal-300);
}

.kpi-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.kpi-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kpi-card__title strong {
  font-size: 13px;
  font-weight: 750;
  color: var(--ink-800);
}

.kpi-icon {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: grid;
  place-items: center;
}

.kpi-icon.is-teal { background: var(--teal-50); color: var(--teal-600); }
.kpi-icon.is-blue { background: #eff6ff; color: #2563eb; }
.kpi-icon.is-purple { background: #f5f3ff; color: #7c3aed; }
.kpi-icon.is-amber { background: #fffbeb; color: #d97706; }
.kpi-icon.is-danger { background: var(--red-100); color: var(--red-600); }

.kpi-tag {
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 700;
}

.kpi-tag.is-green, .kpi-tag.is-healthy { background: var(--teal-50); color: var(--teal-700); }
.kpi-tag.is-warning { background: var(--amber-100); color: var(--amber-600); }
.kpi-tag.is-danger { background: var(--red-100); color: var(--red-600); }
.kpi-tag.is-muted { background: var(--ink-50); color: var(--ink-500); }

.kpi-card__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kpi-value-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.kpi-value-main {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 800;
  line-height: 1.1;
  color: var(--ink-950);
}

.kpi-value-main small {
  font-size: 14px;
  color: var(--ink-400);
  margin-left: 2px;
}

.kpi-value-main.text-danger {
  color: var(--red-600);
}

.kpi-value-sub {
  font-size: 11px;
  color: var(--ink-400);
}

/* 分段健康比例槽 */
.kpi-segmented-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--ink-100);
  display: flex;
  gap: 2px;
  overflow: hidden;
}

.bar-slice {
  height: 100%;
  border-radius: 2px;
  transition: flex .3s ease;
}

.bar-slice.is-online { background: #10b981; }
.bar-slice.is-stale { background: #f59e0b; }
.bar-slice.is-offline { background: #ef4444; }
.bar-slice.is-missing { background: #94a3b8; }
.bar-slice.is-empty { background: var(--ink-200); }

/* 水位进度槽 */
.kpi-meter-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--ink-100);
  overflow: hidden;
}

.kpi-meter-fill {
  height: 100%;
  border-radius: 3px;
  transition: width .3s ease;
}

.kpi-meter-fill.is-healthy { background: #10b981; }
.kpi-meter-fill.is-warning { background: #f59e0b; }
.kpi-meter-fill.is-danger { background: #ef4444; }
.kpi-meter-fill.is-purple { background: #8b5cf6; }
.kpi-meter-fill.is-muted { background: var(--ink-300); }

.kpi-alerts-chips {
  display: flex;
  gap: 6px;
}

.alert-indicator-chip {
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 650;
}

.alert-indicator-chip.is-ok { background: var(--ink-50); color: var(--ink-600); }
.alert-indicator-chip.is-warn { background: var(--red-100); color: var(--red-600); }

.kpi-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  color: var(--ink-400);
  min-height: 18px;
}

.status-sub-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 700;
}

.status-sub-chip.is-stale { color: #d97706; }
.status-sub-chip.is-offline { color: #dc2626; }
.status-sub-chip.is-missing { color: #64748b; }
.status-sub-chip.is-healthy { color: #059669; }

.text-healthy-sub {
  color: #059669;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
}

.text-danger-sub {
  color: #dc2626;
  font-size: 11px;
  font-weight: 600;
}

.monitoring-content-stage {
  min-width: 0;
}

@media (max-width: 1120px) {
  .cluster-kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .monitoring-topbar {
    flex-direction: column;
    align-items: stretch;
  }
  .monitoring-controls {
    flex-wrap: wrap;
  }
  .cluster-kpi-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

