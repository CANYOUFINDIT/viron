<script setup lang="ts">
import { Pause, Play, RefreshCw } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import PageHeader from "../components/PageHeader.vue";
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
</script>

<template>
  <section class="monitoring-page" v-loading="loading">
    <PageHeader :title="$t('监控大盘')">
      <template #actions>
        <span class="monitoring-updated" aria-live="polite">{{ lastUpdated ? `${$t('上次更新')} ${new Date(lastUpdated).toLocaleTimeString()}` : "" }}</span>
        <el-select :model-value="environmentId" clearable :placeholder="$t('全部环境')" style="width: 12rem" @change="(value: string) => patchQuery({ environmentId: value, hostId: undefined, serviceId: undefined })">
          <el-option v-for="item in environments" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select :model-value="range" style="width: 7.5rem" @change="(value: string) => patchQuery({ range: value })">
          <el-option value="1h" :label="$t('1 小时')" />
          <el-option value="6h" :label="$t('6 小时')" />
          <el-option value="24h" :label="$t('24 小时')" />
          <el-option value="7d" :label="$t('7 天')" />
          <el-option value="30d" :label="$t('30 天')" />
        </el-select>
        <el-select :model-value="String(refreshSeconds)" style="width: 8rem" @change="(value: string) => patchQuery({ refresh: value })">
          <el-option value="15" :label="$t('15 秒')" />
          <el-option value="30" :label="$t('30 秒')" />
          <el-option value="60" :label="$t('60 秒')" />
          <el-option value="0" :label="$t('暂停刷新')" />
        </el-select>
        <el-button :loading="refreshing" @click="loadOverview(true)"><RefreshCw :size="15" />{{ $t('立即刷新') }}</el-button>
      </template>
    </PageHeader>

    <nav class="monitoring-tabs" role="tablist" :aria-label="$t('监控大盘')">
      <button type="button" role="tab" :aria-selected="view === 'hosts'" :class="{ 'is-active': view === 'hosts' }" @click="patchQuery({ view: 'hosts' })">{{ $t('主机基础设施') }}</button>
      <button type="button" role="tab" :aria-selected="view === 'services'" :class="{ 'is-active': view === 'services' }" @click="patchQuery({ view: 'services' })">{{ $t('业务服务') }}</button>
      <button type="button" role="tab" :aria-selected="view === 'noc'" :class="{ 'is-active': view === 'noc' }" @click="patchQuery({ view: 'noc' })">{{ $t('NOC 全屏') }}</button>
    </nav>

    <p v-if="error" class="monitoring-error">{{ error }}</p>
    <dl class="monitoring-summary">
      <div><dt>{{ $t('在线') }}</dt><dd>{{ summary.hostOnline }}/{{ summary.hostTotal }}</dd></div>
      <div><dt>CPU</dt><dd>{{ summary.avgCpuPercent === null ? "—" : `${summary.avgCpuPercent.toFixed(1)}%` }}</dd></div>
      <div><dt>{{ $t('内存') }}</dt><dd>{{ summary.avgMemoryPercent === null ? "—" : `${summary.avgMemoryPercent.toFixed(1)}%` }}</dd></div>
      <div><dt>{{ $t('磁盘') }}</dt><dd>{{ summary.diskAlerts }}</dd></div>
    </dl>

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
    <p v-if="refreshSeconds === 0" class="monitoring-paused"><Pause :size="14" />{{ $t('暂停刷新') }}</p>
    <p v-else class="monitoring-paused is-quiet"><Play :size="14" />{{ $t('自动刷新') }}</p>
  </section>
</template>

<style scoped>
.monitoring-page { min-width: 0; display: grid; gap: 1rem; }
.monitoring-tabs { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--ink-100); border-radius: 8px; background: color-mix(in srgb, var(--ink-100) 55%, var(--surface)); width: max-content; }
.monitoring-tabs button {
  min-height: 2.125rem; padding: 0 .875rem; border: 0; border-radius: 6px; background: transparent; color: var(--ink-500); font-weight: 650; cursor: pointer;
}
.monitoring-tabs button.is-active { background: var(--surface); color: var(--teal-700); }
.monitoring-summary { margin: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
.monitoring-summary div { padding: .875rem 1rem; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--surface); }
.monitoring-summary dt { color: var(--ink-400); font-size: .6875rem; }
.monitoring-summary dd { margin: .25rem 0 0; font-family: var(--font-mono); font-size: 1.25rem; }
.monitoring-updated, .monitoring-error, .monitoring-paused { margin: 0; color: var(--ink-400); font-size: .75rem; }
.monitoring-error { color: var(--color-danger); }
.monitoring-paused { display: inline-flex; align-items: center; gap: .375rem; }
@media (max-width: 899px) { .monitoring-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
