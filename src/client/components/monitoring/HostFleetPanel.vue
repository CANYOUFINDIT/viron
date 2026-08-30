<script setup lang="ts">
import { RefreshCw, Server } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";
import type { MonitorAlertItem } from "../../../shared/monitor-alerts";
import {
  compareMonitoringHosts,
  hostPressureScore,
  hostPriorityState,
  type MonitoringAlertCounts,
  type MonitoringHostPriorityState,
} from "../../../shared/monitoring";
import { api } from "../../api";
import { translate as tr } from "../../i18n";
import HostMonitorDashboard from "../HostMonitorDashboard.vue";

export interface MonitoringHostDisk {
  path: string;
  device?: string;
  filesystem?: string;
  usedPercent: number | null;
  usedBytes: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
}

export interface MonitoringHostCard {
  sshConnectionId: string;
  connectionName: string;
  host: string;
  environmentId: string;
  environmentName: string;
  status: string;
  offline: boolean;
  missing: boolean;
  stale: boolean;
  agentVersion: string;
  lastCollectedAt: string | null;
  lastPulledAt?: string | null;
  cpuUsedPercent: number | null;
  memoryUsedPercent: number | null;
  diskUsedPercent: number | null;
  networkReceiveBytesPerSecond?: number | null;
  networkTransmitBytesPerSecond?: number | null;
  temperatureCelsius: number | null;
  cpuCount?: number | null;
  load5?: number | null;
  operatingSystem: string;
  architecture: string;
  worstDisk: { path: string; usedPercent: number | null } | null;
  disks?: MonitoringHostDisk[];
}

type ProbeAction = "install" | "update" | "reinstall" | "restart" | "clear";

const props = defineProps<{
  hosts: MonitoringHostCard[];
  alerts?: MonitorAlertItem[];
  selectedHostId: string;
  canOperate: boolean;
  loadingMore?: boolean;
  loadedCount?: number;
  hostTotal?: number;
}>();

const emit = defineEmits<{
  select: [host: MonitoringHostCard | null];
  install: [host: MonitoringHostCard];
  "open-maintenance": [host: MonitoringHostCard];
}>();

const hostQuery = ref("");
const stateFilter = ref<"all" | MonitoringHostPriorityState>("all");
const selectedIds = ref(new Set<string>());
const bulkAction = ref<ProbeAction | "">("");
const probeBusy = ref(false);

const alertCountsByHost = computed(() => {
  const map = new Map<string, MonitoringAlertCounts>();
  for (const alert of props.alerts ?? []) {
    if (alert.status !== "active" || !alert.sshConnectionId) continue;
    const current = map.get(alert.sshConnectionId) ?? { critical: 0, major: 0, warning: 0 };
    if (alert.peakSeverity === "critical") current.critical += 1;
    else if (alert.peakSeverity === "major") current.major += 1;
    else if (alert.peakSeverity === "warning") current.warning += 1;
    map.set(alert.sshConnectionId, current);
  }
  return map;
});

const rankedHosts = computed(() => {
  const query = hostQuery.value.trim().toLowerCase();
  return [...props.hosts]
    .map((host) => {
      const alertCounts = alertCountsByHost.value.get(host.sshConnectionId) ?? { critical: 0, major: 0, warning: 0 };
      const score = hostPressureScore({ ...host, alertCounts });
      const state = hostPriorityState({ ...host, alertCounts }, score);
      return { host, score, state, alertCounts };
    })
    .sort((left, right) => right.score - left.score || compareMonitoringHosts(left.host, right.host))
    .filter((item) => {
      const matchesQuery = !query || `${item.host.connectionName} ${item.host.host} ${item.host.environmentName}`.toLowerCase().includes(query);
      const matchesState = stateFilter.value === "all" || item.state === stateFilter.value;
      return matchesQuery && matchesState;
    });
});

const selected = computed(() => props.hosts.find((host) => host.sshConnectionId === props.selectedHostId) ?? null);
const selectedRank = computed(() => rankedHosts.value.find((item) => item.host.sshConnectionId === props.selectedHostId) ?? null);
const detailMode = computed(() => Boolean(selected.value));
const visibleIds = computed(() => rankedHosts.value.map((item) => item.host.sshConnectionId));
const selectedCount = computed(() => visibleIds.value.filter((id) => selectedIds.value.has(id)).length);
const allVisibleSelected = computed(() => visibleIds.value.length > 0 && visibleIds.value.every((id) => selectedIds.value.has(id)));

function formatPercent(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function formatBytes(value: number | null | undefined) {
  if (value == null) return "—";
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${(value / 1024).toFixed(0)} KB`;
}

function formatFreshness(value: string | null | undefined) {
  if (!value) return "—";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "—";
  if (elapsed < 60_000) return `${Math.max(1, Math.round(elapsed / 1000))}s`;
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m`;
  return new Date(value).toLocaleTimeString();
}

function bottleneck(host: MonitoringHostCard, _state: MonitoringHostPriorityState, alerts: MonitoringAlertCounts) {
  if (host.missing) return tr("未安装监控探针");
  if ((host.diskUsedPercent ?? 0) >= 90 && host.worstDisk?.path) return `${host.worstDisk.path} ${formatPercent(host.diskUsedPercent)}`;
  if (host.stale) return tr("监控数据陈旧");
  if (alerts.critical) return tr("存在 Critical 告警");
  const resources: Array<[string, number | null]> = [
    ["CPU", host.cpuUsedPercent],
    [tr("内存"), host.memoryUsedPercent],
    [tr("磁盘"), host.diskUsedPercent],
  ];
  resources.sort((left, right) => (right[1] ?? -1) - (left[1] ?? -1));
  const top = resources[0];
  return top?.[1] == null ? "—" : `${top[0]} ${formatPercent(top[1])}`;
}

function stateLabel(state: MonitoringHostPriorityState) {
  if (state === "critical") return tr("资源紧张");
  if (state === "warning") return tr("需要关注");
  if (state === "unmanaged") return tr("未安装探针");
  return tr("运行正常");
}

function toggleSelectAll(checked: boolean) {
  const next = new Set(selectedIds.value);
  for (const id of visibleIds.value) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  selectedIds.value = next;
}

function toggleSelect(id: string, checked: boolean) {
  const next = new Set(selectedIds.value);
  if (checked) next.add(id);
  else next.delete(id);
  selectedIds.value = next;
}

function openHost(host: MonitoringHostCard) {
  emit("select", host);
}

function closeDetail() {
  emit("select", null);
}

function probePath(host: MonitoringHostCard, action: "install-tasks" | "restart" | "clear") {
  return `/api/v1/environments/${host.environmentId}/monitor-hosts/${host.sshConnectionId}/${action}`;
}

async function runProbe(host: MonitoringHostCard, action: ProbeAction) {
  if (action === "clear") {
    await ElMessageBox.confirm(tr("确认清理 {{0}} 的监控数据？", [host.connectionName]), tr("清理监控数据"), {
      type: "warning",
      confirmButtonText: tr("清理"),
      cancelButtonText: tr("取消"),
    });
  }
  if (action === "install" || action === "update" || action === "reinstall") {
    await api(probePath(host, "install-tasks"), { method: "POST", body: "{}" });
    emit("install", host);
    return;
  }
  if (action === "restart") {
    await api(probePath(host, "restart"), { method: "POST" });
    return;
  }
  await api(probePath(host, "clear"), { method: "POST" });
}

async function applyProbe(hosts: MonitoringHostCard[], action: ProbeAction) {
  if (!hosts.length) return;
  probeBusy.value = true;
  let failed = 0;
  try {
    for (const host of hosts) {
      try {
        await runProbe(host, action);
      } catch (caught) {
        if (caught === "cancel" || caught === "close") return;
        failed += 1;
        ElMessage.error(caught instanceof Error ? caught.message : tr("探针操作失败"));
      }
    }
    if (!failed) ElMessage.success(tr("已提交探针操作"));
  } finally {
    probeBusy.value = false;
  }
}

async function applyBulk() {
  if (!bulkAction.value || !selectedCount.value) return;
  const hosts = rankedHosts.value.filter((item) => selectedIds.value.has(item.host.sshConnectionId)).map((item) => item.host);
  await applyProbe(hosts, bulkAction.value);
}

function probeSelected(action: ProbeAction) {
  if (!selected.value) return;
  void applyProbe([selected.value], action);
}

function resourceHot(value: number | null) {
  return (value ?? 0) >= 80;
}
</script>

<template>
  <section class="host-fleet" :class="{ 'is-detail-mode': detailMode }">
    <div class="host-list-page">
      <div v-if="detailMode" class="host-compact-head">
        <strong>{{ $t('主机节点') }}</strong>
        <el-input v-model="hostQuery" clearable :placeholder="$t('筛选节点')" />
      </div>

      <div v-else class="view-toolbar">
        <div class="toolbar-filters">
          <el-input v-model="hostQuery" clearable :placeholder="$t('按主机名、IP 或环境搜索')" class="host-search" />
          <el-select v-model="stateFilter" class="state-filter">
            <el-option value="all" :label="$t('全部状态')" />
            <el-option value="critical" :label="$t('资源紧张')" />
            <el-option value="warning" :label="$t('需要关注')" />
            <el-option value="unmanaged" :label="$t('未安装探针')" />
          </el-select>
        </div>
        <span class="host-count"><strong>{{ rankedHosts.length }}</strong> {{ $t('个节点') }}</span>
      </div>

      <div v-if="!detailMode && canOperate" class="bulk-probe-bar">
        <label class="bulk-selection">
          <input type="checkbox" :checked="allVisibleSelected" @change="toggleSelectAll(($event.target as HTMLInputElement).checked)" />
          <span>{{ $t('选择当前列表') }}</span>
          <strong>{{ selectedCount }} {{ $t('已选') }}</strong>
        </label>
        <div class="bulk-actions">
          <el-select v-model="bulkAction" class="bulk-action-select" :placeholder="$t('选择批量操作')">
            <el-option value="install" :label="$t('安装探针')" />
            <el-option value="update" :label="$t('更新探针')" />
            <el-option value="reinstall" :label="$t('重装探针')" />
            <el-option value="restart" :label="$t('重启探针')" />
            <el-option value="clear" :label="$t('清理节点监控数据')" />
          </el-select>
          <el-button type="primary" :disabled="!selectedCount || !bulkAction" :loading="probeBusy" @click="applyBulk">{{ $t('执行') }}</el-button>
        </div>
      </div>

      <div v-if="rankedHosts.length" class="priority-host-grid">
        <article
          v-for="(item, index) in rankedHosts"
          :key="item.host.sshConnectionId"
          class="priority-host-card"
          :class="[`is-${item.state}`, { 'is-selected': selected?.sshConnectionId === item.host.sshConnectionId }]"
          tabindex="0"
          @click="openHost(item.host)"
          @keydown.enter="openHost(item.host)"
        >
          <span class="host-rank">#{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="host-pressure-score">{{ item.score }}<small>/100</small></span>
          <input
            v-if="canOperate && !detailMode"
            class="host-card-select"
            type="checkbox"
            :checked="selectedIds.has(item.host.sshConnectionId)"
            :aria-label="item.host.connectionName"
            @click.stop
            @change="toggleSelect(item.host.sshConnectionId, ($event.target as HTMLInputElement).checked)"
          />
          <h3>{{ item.host.connectionName }}</h3>
          <p>{{ item.host.host }} · {{ item.host.environmentName }}</p>
          <div class="host-bottleneck">
            <strong>{{ bottleneck(item.host, item.state, item.alertCounts) }}</strong>
          </div>
          <div v-if="!detailMode" class="host-resource-bars">
            <span class="host-resource-line" :class="{ 'is-hot': resourceHot(item.host.cpuUsedPercent) }">
              <b>CPU</b><i><span :style="{ width: `${Math.min(100, Math.max(0, item.host.cpuUsedPercent ?? 0))}%` }"></span></i>
              <output>{{ formatPercent(item.host.cpuUsedPercent) }}</output>
            </span>
            <span class="host-resource-line" :class="{ 'is-hot': resourceHot(item.host.memoryUsedPercent) }">
              <b>MEM</b><i><span :style="{ width: `${Math.min(100, Math.max(0, item.host.memoryUsedPercent ?? 0))}%` }"></span></i>
              <output>{{ formatPercent(item.host.memoryUsedPercent) }}</output>
            </span>
            <span class="host-resource-line" :class="{ 'is-hot': resourceHot(item.host.diskUsedPercent) }">
              <b>DSK</b><i><span :style="{ width: `${Math.min(100, Math.max(0, item.host.diskUsedPercent ?? 0))}%` }"></span></i>
              <output>{{ formatPercent(item.host.diskUsedPercent) }}</output>
            </span>
          </div>
          <div v-if="!detailMode" class="host-card-foot">
            <span>{{ item.host.missing ? $t('未安装') : `v${item.host.agentVersion || '—'}` }}</span>
            <span>{{ item.alertCounts.critical + item.alertCounts.major + item.alertCounts.warning ? `${item.alertCounts.critical + item.alertCounts.major + item.alertCounts.warning} ${$t('活动告警')}` : formatFreshness(item.host.lastCollectedAt) }}</span>
            <strong>{{ $t('详情') }} →</strong>
          </div>
        </article>
      </div>
      <div v-else-if="!loadingMore" class="host-empty">
        <Server :size="28" />
        <span>{{ $t('暂无监控主机') }}</span>
      </div>
      <p v-if="loadingMore" class="host-fleet__more">
        <RefreshCw :size="14" class="is-spinning" />
        <span>{{ $t('正在加载其余主机') }}<template v-if="hostTotal"> · {{ loadedCount ?? hosts.length }}/{{ hostTotal }}</template></span>
      </p>
    </div>

    <div v-if="selected && selectedRank" class="host-resource-detail">
      <div class="detail-back-row">
        <el-button @click="closeDetail">← {{ $t('返回主机节点') }}</el-button>
        <span>#{{ rankedHosts.findIndex((item) => item.host.sshConnectionId === selected?.sshConnectionId) + 1 }} · {{ selectedRank.score }}</span>
      </div>
      <section class="host-detail-hero">
        <div>
          <div class="hero-badges">
            <span class="tone-badge" :class="`is-${selectedRank.state}`">{{ stateLabel(selectedRank.state) }}</span>
            <span class="tone-badge" :class="selected.missing || selected.stale ? 'is-warning' : 'is-healthy'">
              {{ selected.missing ? $t('未安装探针') : selected.stale ? $t('数据陈旧') : $t('探针在线') }}
            </span>
          </div>
          <h2>{{ selected.connectionName }}</h2>
          <p>{{ selected.host }} · {{ selected.operatingSystem }} {{ selected.architecture }} · {{ selected.environmentName }}</p>
        </div>
        <div v-if="canOperate" class="probe-operations">
          <el-button size="small" :disabled="probeBusy" @click="probeSelected(selected.missing ? 'install' : 'update')">{{ selected.missing ? $t('安装探针') : $t('更新探针') }}</el-button>
          <el-button size="small" :disabled="probeBusy || selected.missing" @click="probeSelected('reinstall')">{{ $t('重装探针') }}</el-button>
          <el-button size="small" :disabled="probeBusy || selected.missing" @click="probeSelected('restart')">{{ $t('重启探针') }}</el-button>
          <el-button size="small" type="danger" plain :disabled="probeBusy || selected.missing" @click="probeSelected('clear')">{{ $t('清理监控数据') }}</el-button>
        </div>
      </section>
      <div class="host-detail-metrics">
        <div><span>CPU</span><strong>{{ formatPercent(selected.cpuUsedPercent) }}</strong><small>{{ selected.cpuCount ? `${selected.cpuCount} cores` : "—" }} · load {{ selected.load5 ?? "—" }}</small></div>
        <div><span>{{ $t('内存') }}</span><strong>{{ formatPercent(selected.memoryUsedPercent) }}</strong></div>
        <div><span>{{ $t('磁盘') }} MAX</span><strong :class="{ 'is-hot': resourceHot(selected.diskUsedPercent) }">{{ formatPercent(selected.diskUsedPercent) }}</strong><small>{{ selected.worstDisk?.path || "—" }}</small></div>
        <div><span>LOAD 5M</span><strong>{{ selected.load5 ?? "—" }}</strong><small>{{ formatFreshness(selected.lastCollectedAt) }}</small></div>
        <div><span>{{ $t('温度') }}</span><strong>{{ selected.temperatureCelsius == null ? "—" : `${selected.temperatureCelsius.toFixed(0)}°C` }}</strong></div>
      </div>
      <section class="host-disk-table">
        <header>
          <strong>{{ $t('挂载点') }}</strong>
          <el-button size="small" @click="emit('open-maintenance', selected)">{{ $t('服务维护') }} →</el-button>
        </header>
        <table>
          <thead>
            <tr>
              <th>{{ $t('挂载点') }}</th>
              <th>{{ $t('文件系统') }}</th>
              <th>{{ $t('已用 / 总量') }}</th>
              <th>{{ $t('使用率') }}</th>
              <th>{{ $t('采集时间') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!selected.disks?.length">
              <td colspan="5">{{ selected.missing ? $t('尚无监控数据，请先安装探针。') : $t('暂无磁盘数据') }}</td>
            </tr>
            <tr v-for="disk in selected.disks ?? []" :key="`${disk.device}:${disk.path}`">
              <td><strong>{{ disk.path }}</strong></td>
              <td>{{ disk.filesystem || "—" }}</td>
              <td>{{ formatBytes(disk.usedBytes) }} / {{ formatBytes(disk.totalBytes) }}</td>
              <td :class="{ 'is-hot': resourceHot(disk.usedPercent) }">{{ formatPercent(disk.usedPercent) }}</td>
              <td>{{ formatFreshness(selected.lastCollectedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
      <HostMonitorDashboard
        v-if="!selected.missing"
        :environment-id="selected.environmentId"
        :host-id="selected.sshConnectionId"
        :last-collected-at="selected.lastCollectedAt"
        @open-maintenance="emit('open-maintenance', selected)"
      />
    </div>
  </section>
</template>

<style scoped>
.host-fleet {
  min-width: 0;
}

.host-fleet.is-detail-mode {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.host-list-page { min-width: 0; }

.host-fleet.is-detail-mode .host-list-page {
  position: sticky;
  top: 0;
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-card, 8px);
  background: var(--surface);
}

.host-compact-head,
.view-toolbar,
.bulk-probe-bar,
.detail-back-row,
.host-detail-hero,
.host-disk-table header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.host-compact-head {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--ink-100);
}

.host-compact-head strong { margin: 0; }

.view-toolbar {
  margin-bottom: 10px;
}

.toolbar-filters,
.bulk-actions,
.hero-badges,
.probe-operations {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.host-search { width: 260px; }
.state-filter,
.bulk-action-select { width: 160px; }

.host-count {
  color: var(--ink-400);
  font-size: 12px;
}

.bulk-probe-bar {
  min-height: 44px;
  margin-bottom: 12px;
  padding: 7px 10px;
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-card, 8px);
  background: var(--surface);
}

.bulk-selection {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.bulk-selection strong { font-family: var(--font-mono); font-size: 11px; }

.priority-host-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.host-fleet.is-detail-mode .priority-host-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  max-height: calc(100vh - 180px);
  overflow-y: auto;
}

.priority-host-card {
  min-height: 176px;
  position: relative;
  padding: 12px;
  border: 1px solid var(--ink-100);
  border-top: 3px solid var(--teal-500);
  border-radius: var(--radius-card, 8px);
  background: var(--surface);
  cursor: pointer;
}

.priority-host-card.is-critical { border-top-color: var(--red-600); }
.priority-host-card.is-warning { border-top-color: var(--amber-600); }
.priority-host-card.is-unmanaged { border-top-color: var(--ink-300); }
.priority-host-card.is-selected { background: var(--teal-50); }

.host-fleet.is-detail-mode .priority-host-card {
  min-height: 84px;
  border: 0;
  border-radius: 0;
  border-bottom: 1px solid var(--ink-100);
  border-top: 0;
}

.host-card-select {
  position: absolute;
  top: 10px;
  right: 10px;
}

.host-rank {
  position: absolute;
  top: 10px;
  left: 12px;
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 800;
}

.host-pressure-score {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  margin-left: 32px;
  color: var(--red-600);
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 800;
}

.host-pressure-score small { color: var(--ink-400); font-size: 9px; }

.host-fleet.is-detail-mode .host-pressure-score {
  position: absolute;
  top: 10px;
  right: 10px;
  margin: 0;
  font-size: 14px;
}

.priority-host-card h3 {
  margin: 14px 0 2px;
  font-size: 13px;
}

.priority-host-card p,
.host-card-foot,
.host-detail-hero p,
.host-detail-metrics small {
  margin: 0;
  color: var(--ink-400);
  font-size: 11px;
}

.host-bottleneck {
  min-height: 20px;
  margin: 8px 0;
}

.host-bottleneck strong {
  color: var(--red-600);
  font-size: 12px;
}

.host-resource-bars { display: grid; gap: 6px; }

.host-resource-line {
  display: grid;
  grid-template-columns: 28px 1fr 36px;
  gap: 7px;
  align-items: center;
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
}

.host-resource-line i {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--ink-100);
}

.host-resource-line i span {
  display: block;
  height: 100%;
  background: var(--teal-500);
}

.host-resource-line.is-hot i span,
.is-hot { color: var(--red-600); }
.host-resource-line.is-hot i span { background: var(--red-600); }

.host-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--ink-100);
  font-family: var(--font-mono);
  font-size: 10px;
}

.host-empty,
.host-fleet__more {
  margin: 0;
  padding: 28px 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ink-400);
  font-size: 13px;
}

.host-fleet__more .is-spinning { animation: host-spin 1s linear infinite; }
@keyframes host-spin { to { transform: rotate(360deg); } }

.host-resource-detail { min-width: 0; display: grid; gap: 12px; }

.detail-back-row span { color: var(--ink-400); font-size: 12px; }

.host-detail-hero,
.host-detail-metrics,
.host-disk-table {
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-card, 8px);
  background: var(--surface);
}

.host-detail-hero { padding: 16px; }

.host-detail-hero h2 {
  margin: 8px 0 4px;
  font-size: 20px;
}

.tone-badge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  background: var(--ink-50);
  color: var(--ink-600);
  font-size: 11px;
  font-weight: 700;
}

.tone-badge.is-critical { background: var(--red-100); color: var(--red-600); }
.tone-badge.is-warning,
.tone-badge.is-unmanaged { background: var(--amber-100); color: var(--amber-600); }
.tone-badge.is-healthy { background: var(--teal-50); color: var(--teal-700); }

.host-detail-metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.host-detail-metrics > div {
  padding: 12px 14px;
  border-right: 1px solid var(--ink-100);
}

.host-detail-metrics > div:last-child { border-right: 0; }

.host-detail-metrics span {
  color: var(--ink-400);
  font-size: 11px;
}

.host-detail-metrics strong {
  display: block;
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 18px;
}

.host-disk-table header { padding: 10px 14px; border-bottom: 1px solid var(--ink-100); }
.host-disk-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
.host-disk-table th,
.host-disk-table td { padding: 8px 14px; border-bottom: 1px solid var(--ink-100); text-align: left; }
.host-disk-table th { color: var(--ink-400); font-weight: 650; }

@media (max-width: 1100px) {
  .priority-host-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .host-fleet.is-detail-mode { grid-template-columns: minmax(0, 1fr); }
  .host-detail-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 720px) {
  .priority-host-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
