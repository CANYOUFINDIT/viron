<script setup lang="ts">
import { Radio, RefreshCw, Server, ShieldAlert } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { MonitorAlertItem } from "../../shared/monitor-alerts";
import {
  MONITORING_HOST_PAGE_CONCURRENCY,
  MONITORING_HOST_PAGE_SIZE,
  MONITORING_MAX_HOSTS,
  compareMonitoringHosts,
  type MonitoringRefreshSeconds,
} from "../../shared/monitoring";
import { api } from "../api";
import PageHeader from "../components/PageHeader.vue";
import AlertServicePanel from "../components/monitoring/AlertServicePanel.vue";
import HostFleetPanel, { type MonitoringHostCard } from "../components/monitoring/HostFleetPanel.vue";
import NocScreen from "../components/monitoring/NocScreen.vue";
import type { MonitoringProblemNode, MonitoringServiceCard } from "../components/monitoring/ServiceApmPanel.vue";
import { translate as tr } from "../i18n";
import { session } from "../session";

interface OverviewPayload {
  generatedAt: string;
  truncated?: boolean;
  nextHostOffset?: number | null;
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

type MonitoringView = "overview" | "hosts" | "noc";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const refreshing = ref(false);
const environments = ref<EnvironmentOption[]>([]);
const overview = ref<OverviewPayload | null>(null);
const lastUpdated = ref("");
const error = ref("");
const alerts = ref<MonitorAlertItem[]>([]);
const hostsLoadingMore = ref(false);
let overviewAbort: AbortController | null = null;
let alertsAbort: AbortController | null = null;
let refreshTimer: number | undefined;
let overviewInFlight = false;

const view = computed<MonitoringView>(() => {
  const value = String(route.query.view ?? "overview");
  if (value === "hosts" || value === "noc") return value;
  return "overview";
});
const environmentId = computed(() => String(route.query.environmentId ?? ""));
const refreshSeconds = computed<MonitoringRefreshSeconds>(() => {
  const value = Number(route.query.refresh ?? 15);
  return value === 0 || value === 30 || value === 60 ? value : 15;
});
const selectedHostId = computed(() => String(route.query.hostId ?? ""));
const canOperate = computed(() => ["owner", "admin"].includes(session.workspace?.role ?? ""));

function isMonitoringRoute() {
  return route.name === "monitoring";
}

function patchQuery(next: Record<string, string | undefined>) {
  if (!isMonitoringRoute()) return;
  const query = { ...route.query, ...next };
  for (const key of Object.keys(query)) if (!query[key]) delete query[key];
  void router.replace({ name: "monitoring", query });
}

async function loadEnvironments() {
  const response = await api<{ items: EnvironmentOption[] }>("/api/v1/environments");
  environments.value = response.items.map((item) => ({ id: item.id, name: item.name }));
}

function overviewQuery(extra: Record<string, string>) {
  const params = new URLSearchParams(extra);
  if (environmentId.value) params.set("environmentId", environmentId.value);
  return `/api/v1/monitoring/overview?${params}`;
}

function mergeHostPage(page: OverviewPayload, replace: boolean, keepIds?: Set<string>) {
  const current = overview.value;
  if (replace || !current) {
    overview.value = page;
    return;
  }
  const hosts = new Map(current.hosts.map((host) => [host.sshConnectionId, host]));
  for (const host of page.hosts) hosts.set(host.sshConnectionId, host);
  let merged = [...hosts.values()];
  if (keepIds) merged = merged.filter((host) => keepIds.has(host.sshConnectionId));
  overview.value = {
    ...current,
    generatedAt: page.generatedAt,
    truncated: page.truncated,
    nextHostOffset: page.nextHostOffset,
    partialFailures: page.partialFailures,
    summary: {
      ...page.summary,
      serviceTotal: page.summary.serviceTotal || current.summary.serviceTotal,
    },
    hosts: merged.sort(compareMonitoringHosts),
    services: current.services.length ? current.services : page.services,
    serviceRanking: current.serviceRanking.length ? current.serviceRanking : page.serviceRanking,
    problemNodes: current.problemNodes.length ? current.problemNodes : page.problemNodes,
  };
}

async function loadOverview(silent = false) {
  overviewAbort?.abort();
  overviewAbort = new AbortController();
  const signal = overviewAbort.signal;
  overviewInFlight = true;
  if (!silent) loading.value = true;
  else refreshing.value = true;
  const seenIds = new Set<string>();
  try {
    const first = await api<OverviewPayload>(
      overviewQuery({ hostLimit: String(MONITORING_HOST_PAGE_SIZE), hostOffset: "0" }),
      { signal },
    );
    if (signal.aborted || !isMonitoringRoute()) return;
    for (const host of first.hosts) seenIds.add(host.sshConnectionId);
    mergeHostPage(first, !silent);
    lastUpdated.value = first.generatedAt;
    error.value = "";
    loading.value = false;
    refreshing.value = false;
    void loadAlerts();

    const total = Math.min(first.summary.hostTotal, MONITORING_MAX_HOSTS);
    const offsets: number[] = [];
    for (let offset = MONITORING_HOST_PAGE_SIZE; offset < total; offset += MONITORING_HOST_PAGE_SIZE) offsets.push(offset);
    if (!offsets.length) return;

    hostsLoadingMore.value = true;
    let next = 0;
    const workers = Array.from({ length: Math.min(MONITORING_HOST_PAGE_CONCURRENCY, offsets.length) }, async () => {
      while (next < offsets.length) {
        const offset = offsets[next];
        next += 1;
        const page = await api<OverviewPayload>(
          overviewQuery({
            hostLimit: String(MONITORING_HOST_PAGE_SIZE),
            hostOffset: String(offset),
            hostsOnly: "1",
          }),
          { signal },
        );
        if (signal.aborted || !isMonitoringRoute()) return;
        for (const host of page.hosts) seenIds.add(host.sshConnectionId);
        mergeHostPage(page, false);
        lastUpdated.value = page.generatedAt;
      }
    });
    await Promise.all(workers);
    if (!signal.aborted && isMonitoringRoute()) mergeHostPage({
      ...(overview.value as OverviewPayload),
      hosts: [],
    }, false, seenIds);
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError" || signal.aborted) return;
    if (!overview.value) error.value = caught instanceof Error ? caught.message : tr("读取监控概览失败");
    else ElMessage.warning(caught instanceof Error ? caught.message : tr("部分主机监控数据加载失败"));
  } finally {
    if (overviewAbort?.signal === signal) {
      overviewInFlight = false;
      loading.value = false;
      refreshing.value = false;
      hostsLoadingMore.value = false;
    }
  }
}

async function loadAlerts() {
  alertsAbort?.abort();
  alertsAbort = new AbortController();
  try {
    const params = new URLSearchParams();
    if (environmentId.value) params.set("environmentId", environmentId.value);
    params.set("limit", "500");
    const response = await api<{ items: MonitorAlertItem[] }>(`/api/v1/monitor-alerts?${params.toString()}`, { signal: alertsAbort.signal });
    alerts.value = response.items;
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    alerts.value = [];
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
    if (document.hidden || !isMonitoringRoute()) return;
    void loadOverview(true);
    void loadAlerts();
  }, refreshSeconds.value * 1000);
}

function onVisibility() {
  if (document.hidden || !isMonitoringRoute()) return;
  void loadOverview(true);
}

onMounted(async () => {
  document.addEventListener("visibilitychange", onVisibility);
  try {
    await loadEnvironments();
    await loadOverview();
    startRefresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : tr("读取监控概览失败");
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  stopRefresh();
  overviewAbort?.abort();
  alertsAbort?.abort();
  document.removeEventListener("visibilitychange", onVisibility);
});

watch(environmentId, () => {
  if (!isMonitoringRoute()) return;
  void loadOverview(true);
});
watch(() => route.name, (name) => {
  if (name === "monitoring") return;
  overviewAbort?.abort();
  alertsAbort?.abort();
  stopRefresh();
});
watch(refreshSeconds, () => startRefresh());

function selectHost(host: MonitoringHostCard | null) {
  patchQuery({ view: "hosts", hostId: host?.sshConnectionId });
}

function openService(service: MonitoringServiceCard) {
  void router.push({
    name: "environment",
    params: { id: service.environmentId },
    query: { tab: "maintenance", serviceId: service.id },
  });
}

function openEvent(event: MonitorAlertItem) {
  if (event.targetType === "tls_endpoint") {
    void router.push({ name: "ssh-keys", query: { tab: "ssl" } });
    return;
  }
  if (event.serviceId && event.environmentId) {
    void router.push({
      name: "environment",
      params: { id: event.environmentId },
      query: { tab: "maintenance", serviceId: event.serviceId },
    });
    return;
  }
  if (event.sshConnectionId) {
    patchQuery({ view: "hosts", hostId: event.sshConnectionId, environmentId: event.environmentId });
    return;
  }
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
  <section class="monitoring-view" v-loading="loading">
    <PageHeader :title="$t('监控大盘')">
      <template #actions>
        <el-select
          :model-value="environmentId"
          clearable
          :placeholder="$t('全部环境')"
          class="control-env-select"
          @change="(value: string) => patchQuery({ environmentId: value, hostId: undefined })"
        >
          <el-option v-for="item in environments" :key="item.id" :label="item.name" :value="item.id" />
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
        <el-button type="primary" plain :loading="refreshing" @click="loadOverview(true)">
          <RefreshCw :size="14" :class="{ 'is-spinning': refreshing }" />
          {{ $t('刷新') }}
        </el-button>
        <span v-if="lastUpdated" class="last-sync-time">{{ new Date(lastUpdated).toLocaleTimeString() }}</span>
      </template>
    </PageHeader>

    <nav class="monitoring-subnav" role="tablist" :aria-label="$t('监控大盘')">
      <button
        type="button"
        role="tab"
        :aria-selected="view === 'overview'"
        :class="{ 'is-active': view === 'overview' }"
        @click="patchQuery({ view: 'overview' })"
      >
        <ShieldAlert :size="14" />
        {{ $t('告警与服务') }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="view === 'hosts'"
        :class="{ 'is-active': view === 'hosts' }"
        @click="patchQuery({ view: 'hosts' })"
      >
        <Server :size="14" />
        {{ $t('主机节点') }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="view === 'noc'"
        :class="{ 'is-active': view === 'noc' }"
        @click="patchQuery({ view: 'noc' })"
      >
        <Radio :size="14" />
        {{ $t('NOC 全屏') }}
      </button>
    </nav>

    <p v-if="error" class="monitoring-banner-error">{{ error }}</p>

    <main class="monitoring-content-stage">
      <AlertServicePanel
        v-if="view === 'overview'"
        :environment-id="environmentId"
        :environments="environments"
        :services="overview?.services ?? []"
        :alerts="alerts"
        @open-event="openEvent"
        @open-service="openService"
      />
      <HostFleetPanel
        v-else-if="view === 'hosts'"
        :hosts="overview?.hosts ?? []"
        :alerts="alerts"
        :selected-host-id="selectedHostId"
        :can-operate="canOperate"
        :loading-more="hostsLoadingMore"
        :loaded-count="overview?.hosts.length ?? 0"
        :host-total="summary.hostTotal"
        @select="selectHost"
        @install="openInstall"
        @open-maintenance="openHostMaintenance"
      />
      <NocScreen
        v-else-if="view === 'noc' && overview"
        :generated-at="overview.generatedAt"
        :summary="summary"
        :hosts="overview.hosts"
        :problem-nodes="overview.problemNodes"
        :ranking="overview.serviceRanking"
        :alerts="alerts"
        @exit="patchQuery({ view: 'overview' })"
      />
    </main>
  </section>
</template>

<style scoped>
.monitoring-view {
  min-width: 0;
}

.control-env-select { width: 10rem; }
.control-refresh-select { width: 6.5rem; }

.last-sync-time {
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 12px;
}

.is-spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.monitoring-subnav {
  display: flex;
  gap: 4px;
  margin-bottom: 14px;
  padding: 4px;
  border: 1px solid var(--ink-100);
  border-radius: 9px;
  background: var(--surface);
}

.monitoring-subnav button {
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-500);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}

.monitoring-subnav button:hover,
.monitoring-subnav button.is-active {
  background: var(--teal-50);
  color: var(--teal-700);
}

.monitoring-banner-error {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--red-100);
  color: var(--red-600);
  font-size: 12px;
}

.monitoring-content-stage { min-width: 0; }

@media (max-width: 720px) {
  .monitoring-subnav { display: grid; grid-template-columns: 1fr; }
}
</style>
