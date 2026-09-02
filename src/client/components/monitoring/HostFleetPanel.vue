<script setup lang="ts">
import { RefreshCw, Server } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";
import {
  MONITORING_PROBE_STATES,
  compareMonitoringHosts,
  hostPressureScore,
  hostPriorityState,
  monitoringProbeState,
  type MonitoringAlertCounts,
  type MonitoringHostPriorityState,
  type MonitoringProbeState,
} from "../../../shared/monitoring";
import { api } from "../../api";
import { translate as tr } from "../../i18n";
import type { MonitorInstallPreflight, MonitorInstallTask } from "../service-maintenance/types";
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
  probeState: MonitoringProbeState;
  probeInstalled: boolean;
  offline: boolean;
  missing: boolean;
  stale: boolean;
  lastError?: string;
  installedAt?: string | null;
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
  installManaged?: boolean;
  installPath?: string;
  alertCounts?: MonitoringAlertCounts;
  worstDisk: { path: string; usedPercent: number | null } | null;
  disks?: MonitoringHostDisk[];
}

type ProbeAction = "refresh" | "install" | "update" | "reinstall" | "restart" | "clear" | "uninstall";

const props = defineProps<{
  hosts: MonitoringHostCard[];
  selectedHostId: string;
  canOperate: boolean;
  loadingMore?: boolean;
  loadedCount?: number;
  hostTotal?: number;
}>();

const emit = defineEmits<{
  select: [host: MonitoringHostCard | null];
  refresh: [];
  "open-maintenance": [host: MonitoringHostCard];
}>();

const hostQuery = ref("");
const stateFilter = ref<"all" | MonitoringProbeState>("all");
const expandedProbeStates = ref(new Set<MonitoringProbeState>());
const selectedIds = ref(new Set<string>());
const bulkAction = ref<ProbeAction | "">("");
const probeBusy = ref(false);
const probeResultsOpen = ref(false);
const probeResults = ref<Array<{
  id: string;
  host: string;
  action: ProbeAction;
  status: "success" | "submitted" | "skipped" | "failed";
  message: string;
  taskId?: string;
}>>([]);
const probeOperationConcurrency = 4;
const maxBulkHosts = 50;
const probeStateOrder = new Map(MONITORING_PROBE_STATES.map((state, index) => [state, index]));

function effectiveProbeState(host: MonitoringHostCard): MonitoringProbeState {
  return host.probeState ?? monitoringProbeState({
    status: host.status,
    agentVersion: host.agentVersion,
    installManaged: host.installManaged,
    installedAt: host.installedAt,
    lastCollectedAt: host.lastCollectedAt,
    stale: host.stale,
  });
}

const allRankedHosts = computed(() => {
  return [...props.hosts]
    .map((host) => {
      const alertCounts = host.alertCounts ?? { critical: 0, major: 0, warning: 0 };
      const probeState = effectiveProbeState(host);
      const score = hostPressureScore({ ...host, probeState, alertCounts });
      const state = hostPriorityState({ ...host, probeState, alertCounts }, score);
      return { host, score, state, probeState, alertCounts };
    })
    .sort((left, right) => (probeStateOrder.get(left.probeState) ?? 99) - (probeStateOrder.get(right.probeState) ?? 99)
      || right.score - left.score
      || compareMonitoringHosts(left.host, right.host));
});

const rankedHosts = computed(() => {
  const query = hostQuery.value.trim().toLowerCase();
  return allRankedHosts.value.filter((item) => {
    const matchesQuery = !query || `${item.host.connectionName} ${item.host.host} ${item.host.environmentName}`.toLowerCase().includes(query);
    const matchesState = stateFilter.value === "all" || item.probeState === stateFilter.value;
    return matchesQuery && matchesState;
  });
});

const probeStateCounts = computed(() => {
  const counts = Object.fromEntries(MONITORING_PROBE_STATES.map((state) => [state, 0])) as Record<MonitoringProbeState, number>;
  for (const item of allRankedHosts.value) counts[item.probeState] += 1;
  return counts;
});

const visibleProbeGroups = computed(() => MONITORING_PROBE_STATES
  .filter((probeState) => stateFilter.value === "all" || stateFilter.value === probeState)
  .map((probeState) => ({ probeState, items: rankedHosts.value.filter((item) => item.probeState === probeState) }))
  .filter((group) => group.items.length));

const selected = computed(() => props.hosts.find((host) => host.sshConnectionId === props.selectedHostId) ?? null);
const selectedRank = computed(() => allRankedHosts.value.find((item) => item.host.sshConnectionId === props.selectedHostId) ?? null);
const detailMode = computed(() => Boolean(selected.value));
const renderGroups = computed(() => {
  if (detailMode.value) return [{ probeState: null, items: rankedHosts.value, visibleItems: rankedHosts.value }];
  const searching = Boolean(hostQuery.value.trim()) || stateFilter.value !== "all";
  return visibleProbeGroups.value.map((group) => ({
    ...group,
    visibleItems: searching || expandedProbeStates.value.has(group.probeState) ? group.items : group.items.slice(0, 6),
  }));
});
const selectedGroupRank = computed(() => {
  if (!selectedRank.value) return 0;
  return allRankedHosts.value.filter((item) => item.probeState === selectedRank.value!.probeState)
    .findIndex((item) => item.host.sshConnectionId === props.selectedHostId) + 1;
});
const visibleIds = computed(() => renderGroups.value.flatMap((group) => group.visibleItems.map((item) => item.host.sshConnectionId)));
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

function collectionLabel(host: MonitoringHostCard) {
  if (["missing", "unreachable", "unchecked"].includes(effectiveProbeState(host))) return tr("尚无监控数据");
  const freshness = formatFreshness(host.lastCollectedAt);
  return freshness === "—" ? tr("尚无采集时间") : tr("{{0}} 前采集", [freshness]);
}

function probeLabel(host: MonitoringHostCard) {
  const state = effectiveProbeState(host);
  if (state === "missing") return tr("已确认未安装探针");
  if (state === "offline") return tr("已安装探针当前离线");
  if (state === "unreachable") return tr("SSH 连接失败，探针状态待确认");
  if (state === "stale") return tr("探针数据已中断");
  if (state === "unchecked") return tr("尚未检测探针");
  return host.agentVersion ? tr("探针 v{{0}} · 最近采集成功", [host.agentVersion]) : tr("最近采集成功");
}

function activeAlertCount(alerts: MonitoringAlertCounts) {
  return alerts.critical + alerts.major + alerts.warning;
}

function bottleneck(host: MonitoringHostCard, _state: MonitoringHostPriorityState, alerts: MonitoringAlertCounts) {
  const probeState = effectiveProbeState(host);
  if (probeState === "offline") return tr("已安装探针当前无法连接");
  if (probeState === "unreachable") return tr("SSH 连接失败，无法确认是否安装探针");
  if (probeState === "missing") return tr("已通过 SSH 确认未安装探针");
  if (probeState === "unchecked") return tr("尚未执行探针检测");
  if ((host.diskUsedPercent ?? 0) >= 90 && host.worstDisk?.path) return `${host.worstDisk.path} ${formatPercent(host.diskUsedPercent)}`;
  if (probeState === "stale") return tr("探针采集数据已超过刷新窗口");
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
  if (state === "offline") return tr("离线");
  if (state === "critical") return tr("资源紧张");
  if (state === "warning") return tr("需要关注");
  if (state === "unmanaged") return tr("未安装探针");
  return tr("运行正常");
}

function probeStateLabel(state: MonitoringProbeState) {
  if (state === "offline") return tr("探针离线");
  if (state === "unreachable") return tr("连接异常 · 待确认");
  if (state === "stale") return tr("采集中断");
  if (state === "missing") return tr("确认未安装");
  if (state === "unchecked") return tr("尚未检测");
  return tr("采集正常");
}

function probeStateDescription(state: MonitoringProbeState) {
  if (state === "offline") return tr("存在安装或历史采集凭据，但当前无法拉取探针数据");
  if (state === "unreachable") return tr("SSH 认证或网络连接失败，当前不能判断探针是否安装");
  if (state === "stale") return tr("探针曾正常上报，但采集数据已超过刷新窗口");
  if (state === "missing") return tr("已连接目标机器并确认 viron-monitor 不存在");
  if (state === "unchecked") return tr("尚未完成首次探针检测");
  return tr("最近一次采集成功且数据未过期，按告警和资源压力排序");
}

function probeStateTone(state: MonitoringProbeState) {
  if (state === "offline") return "critical";
  if (state === "unreachable" || state === "stale") return "warning";
  if (state === "online") return "healthy";
  return "unmanaged";
}

function probeHasMetrics(host: MonitoringHostCard) {
  return host.cpuUsedPercent != null || host.memoryUsedPercent != null || host.diskUsedPercent != null;
}

function probeIsInstalled(host: MonitoringHostCard) {
  return host.probeInstalled ?? ["online", "offline", "stale"].includes(effectiveProbeState(host));
}

function probeEvidenceDetail(host: MonitoringHostCard) {
  const state = effectiveProbeState(host);
  if (state === "missing") return tr("SSH 检测已完成：目标机器未找到 viron-monitor 命令");
  if (state === "unreachable") return host.lastError || tr("SSH 连接失败，请先检查地址、网络或认证信息");
  if (state === "offline") return host.lastError || tr("探针曾经上报过数据，但本次拉取失败");
  if (state === "stale") return tr("最后采集于 {{0}} 前，请刷新或检查探针进程", [formatFreshness(host.lastCollectedAt)]);
  if (state === "unchecked") return tr("执行“重新检测”后才能判断是否已安装探针");
  return tr("最近 {{0}} 前完成采集", [formatFreshness(host.lastCollectedAt)]);
}

function cardActionLabel(host: MonitoringHostCard) {
  const state = effectiveProbeState(host);
  if (state === "missing") return tr("安装探针");
  if (state === "unreachable" || state === "unchecked") return tr("查看连接诊断");
  return tr("查看监控");
}

function toggleProbeGroup(state: MonitoringProbeState) {
  const next = new Set(expandedProbeStates.value);
  if (next.has(state)) next.delete(state);
  else next.add(state);
  expandedProbeStates.value = next;
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

function probePath(host: MonitoringHostCard, action: "refresh" | "install/preflight" | "install-tasks" | "restart" | "clear" | "uninstall") {
  return `/api/v1/environments/${host.environmentId}/monitor-hosts/${host.sshConnectionId}/${action}`;
}

function probeActionLabel(action: ProbeAction) {
  return ({
    refresh: tr("重新检测探针状态"),
    install: tr("安装探针"),
    update: tr("更新探针"),
    reinstall: tr("重装探针"),
    restart: tr("重启探针"),
    clear: tr("清理节点监控数据"),
    uninstall: tr("卸载监控探针"),
  })[action];
}

function installRequestBody(installPath: string | undefined) {
  return JSON.stringify(installPath ? { installPath } : {});
}

async function requestPreflight(host: MonitoringHostCard, installPath?: string) {
  return await api<{ item: MonitorInstallPreflight }>(
    probePath(host, "install/preflight"),
    { method: "POST", body: installRequestBody(installPath) },
  ).then((response) => response.item);
}

async function preflightInstall(host: MonitoringHostCard, action: ProbeAction, allowPathPrompt: boolean) {
  let result = await requestPreflight(host, host.installPath || undefined);
  if (!result.canInstall && allowPathPrompt && (result.pathState === "conflict" || result.pathState === "legacy")) {
    const prompted = await ElMessageBox.prompt(
      `${result.issues.map((issue) => issue.message).join("；")}。${tr("请输入新的安装目录")}`,
      probeActionLabel(action),
      {
        inputValue: result.defaultInstallPath,
        inputPattern: /^\/.+/,
        inputErrorMessage: tr("安装目录必须是绝对路径"),
        confirmButtonText: tr("重新预检"),
        cancelButtonText: tr("取消"),
      },
    );
    result = await requestPreflight(host, prompted.value);
  }
  if (!result.canInstall) {
    throw new Error(result.issues.map((issue) => issue.message).join("；") || tr("监控探针安装预检未通过"));
  }
  if ((action === "update" || action === "reinstall") && result.pathState !== "upgrade") {
    throw new Error(tr("没有检测到可管理的 Viron 监控探针，请改用安装操作"));
  }
  return result;
}

async function executeProbe(host: MonitoringHostCard, action: ProbeAction, allowPathPrompt: boolean) {
  if (action === "refresh") {
    await api(probePath(host, "refresh"), { method: "POST" });
    return { status: "success" as const, message: tr("探针状态已重新检测") };
  }
  if (action === "install" && effectiveProbeState(host) !== "missing") {
    return { status: "skipped" as const, message: tr("当前未确认探针缺失，请先重新检测") };
  }
  if ((action === "update" || action === "reinstall" || action === "restart" || action === "clear") && !probeIsInstalled(host)) {
    return { status: "skipped" as const, message: tr("尚未确认已安装探针") };
  }
  if (action === "uninstall" && !probeIsInstalled(host) && !host.installManaged) {
    return { status: "skipped" as const, message: tr("尚未确认已安装探针") };
  }
  if (action === "install" || action === "update" || action === "reinstall") {
    const preflight = await preflightInstall(host, action, allowPathPrompt);
    const response = await api<{ item: MonitorInstallTask }>(probePath(host, "install-tasks"), {
      method: "POST",
      body: installRequestBody(preflight.installPath),
    });
    return {
      status: "submitted" as const,
      message: tr("安装任务已进入队列"),
      taskId: response.item.id,
    };
  }
  if (action === "restart") {
    await api(probePath(host, "restart"), { method: "POST" });
    return { status: "success" as const, message: tr("监控探针已重启") };
  }
  if (action === "uninstall") {
    await api(probePath(host, "uninstall"), { method: "DELETE" });
    return { status: "success" as const, message: tr("监控探针已卸载，中心历史数据已保留") };
  }
  await api(probePath(host, "clear"), { method: "POST" });
  return { status: "success" as const, message: tr("节点本地监控缓冲已清理") };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

async function confirmProbe(hosts: MonitoringHostCard[], action: ProbeAction) {
  const target = hosts.length === 1 ? hosts[0]!.connectionName : tr("{{0}} 台主机", [hosts.length]);
  const detail = action === "clear"
    ? tr("此操作只清理目标节点上的 viron-monitor 本地缓冲；不会删除 Viron 数据库中的历史采样、系统告警或个人通知。")
    : action === "uninstall"
      ? tr("此操作将停止并删除目标节点上的 viron-monitor 服务、程序、配置和本地缓冲；Viron 数据库中的历史采样会保留。")
    : action === "reinstall"
      ? tr("将覆盖现有 Viron 监控探针程序，安装任务会在后台按队列执行。")
      : action === "install" || action === "update"
        ? tr("安装任务会先逐台预检，再在后台按队列执行。")
        : action === "refresh"
          ? tr("将通过现有 SSH 连接重新判断探针是否安装以及当前是否在线。")
          : tr("操作将按最多 {{0}} 台并发执行。", [probeOperationConcurrency]);
  await ElMessageBox.confirm(
    `${tr("确认对 {{0}} 执行“{{1}}”？", [target, probeActionLabel(action)])}\n${detail}`,
    probeActionLabel(action),
    {
      type: action === "clear" || action === "reinstall" || action === "uninstall" ? "warning" : "info",
      confirmButtonText: tr("确认执行"),
      cancelButtonText: tr("取消"),
    },
  );
}

async function applyProbe(hosts: MonitoringHostCard[], action: ProbeAction) {
  if (!hosts.length || probeBusy.value) return;
  if (hosts.length > maxBulkHosts) {
    ElMessage.warning(tr("单次最多操作 {{0}} 台主机，请缩小选择范围", [maxBulkHosts]));
    return;
  }
  try {
    await confirmProbe(hosts, action);
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    throw caught;
  }
  probeBusy.value = true;
  try {
    probeResults.value = await mapConcurrent(hosts, probeOperationConcurrency, async (host) => {
      try {
        const result = await executeProbe(host, action, hosts.length === 1);
        return { id: host.sshConnectionId, host: host.connectionName, action, ...result };
      } catch (caught) {
        return {
          id: host.sshConnectionId,
          host: host.connectionName,
          action,
          status: caught === "cancel" || caught === "close" ? "skipped" as const : "failed" as const,
          message: caught === "cancel" || caught === "close"
            ? tr("已取消")
            : caught instanceof Error ? caught.message : tr("探针操作失败"),
        };
      }
    });
    const failed = probeResults.value.filter((item) => item.status === "failed").length;
    const submitted = probeResults.value.filter((item) => item.status === "submitted").length;
    probeResultsOpen.value = true;
    if (failed) ElMessage.warning(tr("探针操作完成，{{0}} 项失败", [failed]));
    else if (submitted) ElMessage.success(tr("{{0}} 个安装任务已进入队列", [submitted]));
    else ElMessage.success(tr("探针操作已完成"));
    selectedIds.value = new Set();
    emit("refresh");
  } finally {
    probeBusy.value = false;
  }
}

async function applyBulk() {
  const action = bulkAction.value;
  if (!action || !selectedCount.value) return;
  const hosts = rankedHosts.value.filter((item) => selectedIds.value.has(item.host.sshConnectionId)).map((item) => item.host);
  await applyProbe(hosts, action);
}

function probeSelected(action: ProbeAction) {
  if (!selected.value) return;
  void applyProbe([selected.value], action);
}

function resourceHot(value: number | null) {
  return (value ?? 0) >= 80;
}

function resultStatusLabel(status: (typeof probeResults.value)[number]["status"]) {
  if (status === "submitted") return tr("已入队");
  if (status === "success") return tr("成功");
  if (status === "skipped") return tr("已跳过");
  return tr("失败");
}
</script>

<template>
  <section class="host-fleet" :class="{ 'is-detail-mode': detailMode }">
    <div class="host-list-page">
      <div v-if="detailMode" class="host-compact-head">
        <strong>{{ $t('主机节点') }}</strong>
        <el-input v-model="hostQuery" clearable :placeholder="$t('筛选节点')" />
      </div>

      <div v-else class="host-workbench">
      <div class="view-toolbar">
        <div class="toolbar-filters">
          <el-input v-model="hostQuery" clearable :placeholder="$t('按主机名、IP 或环境搜索')" class="host-search" />
        </div>
        <div class="host-list-summary">
          <span class="host-count"><strong>{{ rankedHosts.length }}</strong> {{ $t('个节点') }}</span>
          <small>{{ $t('优先展示异常和高风险节点，未安装探针置底') }}</small>
        </div>
      </div>

      <nav class="probe-state-tabs" :aria-label="$t('探针状态分类')">
        <button type="button" :class="{ 'is-active': stateFilter === 'all' }" @click="stateFilter = 'all'">
          <span>{{ $t('全部分类') }}</span><strong>{{ allRankedHosts.length }}</strong>
        </button>
        <button
          v-for="probeState in MONITORING_PROBE_STATES"
          :key="probeState"
          type="button"
          :class="[`is-${probeStateTone(probeState)}`, { 'is-active': stateFilter === probeState }]"
          @click="stateFilter = probeState"
        >
          <span>{{ probeStateLabel(probeState) }}</span><strong>{{ probeStateCounts[probeState] }}</strong>
        </button>
      </nav>

      <div v-if="canOperate" class="bulk-probe-bar">
        <label class="bulk-selection">
          <input type="checkbox" :checked="allVisibleSelected" @change="toggleSelectAll(($event.target as HTMLInputElement).checked)" />
          <span>{{ $t('选择当前列表') }}</span>
          <strong>{{ selectedCount }} {{ $t('已选') }}</strong>
        </label>
        <div class="bulk-actions">
          <el-select v-model="bulkAction" class="bulk-action-select" :placeholder="$t('选择批量操作')">
            <el-option value="refresh" :label="$t('重新检测探针状态')" />
            <el-option value="install" :label="$t('安装探针')" />
            <el-option value="update" :label="$t('更新探针')" />
            <el-option value="reinstall" :label="$t('重装探针')" />
            <el-option value="restart" :label="$t('重启探针')" />
            <el-option value="clear" :label="$t('清理节点监控数据')" />
            <el-option value="uninstall" :label="$t('卸载监控探针')" />
          </el-select>
          <el-button type="primary" :disabled="!selectedCount || !bulkAction" :loading="probeBusy" @click="applyBulk">{{ $t('执行') }}</el-button>
        </div>
      </div>

      <div v-if="rankedHosts.length" class="probe-state-groups">
        <div class="host-table-head" :class="{ 'has-select': canOperate }">
          <span v-if="canOperate"></span>
          <span>{{ $t('主机') }}</span>
          <span>{{ $t('状态') }}</span>
          <span>{{ $t('判定依据') }}</span>
          <span>{{ $t('资源') }}</span>
          <span></span>
        </div>
        <section
          v-for="group in renderGroups"
          :key="group.probeState ?? 'detail-list'"
          class="probe-state-group"
          :class="group.probeState ? `is-${group.probeState}` : ''"
          :data-probe-state="group.probeState"
        >
          <header v-if="!detailMode && group.probeState" class="probe-state-group__head">
            <div>
              <span class="probe-state-dot" :class="`is-${probeStateTone(group.probeState)}`"></span>
              <strong>{{ probeStateLabel(group.probeState) }}</strong>
              <b>{{ group.items.length }}</b>
            </div>
            <small>{{ probeStateDescription(group.probeState) }}</small>
          </header>
          <div class="priority-host-grid">
            <article
              v-for="item in group.visibleItems"
              :key="item.host.sshConnectionId"
              class="priority-host-card"
              :class="[`is-${item.state}`, `is-probe-${item.probeState}`, { 'is-selected': selected?.sshConnectionId === item.host.sshConnectionId }]"
              tabindex="0"
              @click="openHost(item.host)"
              @keydown.enter="openHost(item.host)"
            >
              <template v-if="detailMode">
                <div class="compact-host-head">
                  <strong>{{ item.host.connectionName }}</strong>
                  <span class="tone-badge" :class="`is-${probeStateTone(item.probeState)}`">{{ probeStateLabel(item.probeState) }}</span>
                </div>
                <p>{{ item.host.host }} · {{ item.host.environmentName }}</p>
                <span class="compact-host-reason">{{ bottleneck(item.host, item.state, item.alertCounts) }}</span>
                <div v-if="probeHasMetrics(item.host)" class="compact-host-resources">
                  <span>CPU {{ formatPercent(item.host.cpuUsedPercent) }}</span>
                  <span>{{ $t('内存') }} {{ formatPercent(item.host.memoryUsedPercent) }}</span>
                  <span>{{ $t('磁盘') }} {{ formatPercent(item.host.diskUsedPercent) }}</span>
                </div>
              </template>
              <template v-else>
                <input
                  v-if="canOperate"
                  class="host-card-select"
                  type="checkbox"
                  :checked="selectedIds.has(item.host.sshConnectionId)"
                  :aria-label="item.host.connectionName"
                  @click.stop
                  @change="toggleSelect(item.host.sshConnectionId, ($event.target as HTMLInputElement).checked)"
                />
                <div class="host-card-identity">
                  <h3>{{ item.host.connectionName }}</h3>
                  <p>{{ item.host.host }} · {{ item.host.environmentName }}</p>
                </div>
                <div class="host-status-cell">
                  <span class="tone-badge" :class="`is-${probeStateTone(item.probeState)}`">{{ probeStateLabel(item.probeState) }}</span>
                  <span v-if="item.probeState === 'online' && ['critical', 'warning'].includes(item.state)" class="tone-badge" :class="`is-${item.state}`">{{ stateLabel(item.state) }}</span>
                </div>
                <div class="host-bottleneck">
                  <strong>{{ bottleneck(item.host, item.state, item.alertCounts) }}</strong>
                  <small v-if="activeAlertCount(item.alertCounts)">{{ activeAlertCount(item.alertCounts) }} {{ $t('条活动告警') }}</small>
                </div>
                <div class="host-resource-bars">
                  <template v-if="probeHasMetrics(item.host)">
                    <span class="host-resource-line" :class="{ 'is-hot': resourceHot(item.host.cpuUsedPercent) }">
                      <b>CPU</b><i><span :style="{ width: `${Math.min(100, Math.max(0, item.host.cpuUsedPercent ?? 0))}%` }"></span></i>
                      <output>{{ formatPercent(item.host.cpuUsedPercent) }}</output>
                    </span>
                    <span class="host-resource-line" :class="{ 'is-hot': resourceHot(item.host.memoryUsedPercent) }">
                      <b>{{ $t('内存') }}</b><i><span :style="{ width: `${Math.min(100, Math.max(0, item.host.memoryUsedPercent ?? 0))}%` }"></span></i>
                      <output>{{ formatPercent(item.host.memoryUsedPercent) }}</output>
                    </span>
                    <span class="host-resource-line" :class="{ 'is-hot': resourceHot(item.host.diskUsedPercent) }">
                      <b>{{ $t('磁盘') }}</b><i><span :style="{ width: `${Math.min(100, Math.max(0, item.host.diskUsedPercent ?? 0))}%` }"></span></i>
                      <output>{{ formatPercent(item.host.diskUsedPercent) }}</output>
                    </span>
                  </template>
                  <span v-else class="host-resource-empty">—</span>
                </div>
                <strong class="host-card-action">{{ cardActionLabel(item.host) }} →</strong>
              </template>
            </article>
            <button
              v-if="!detailMode && group.probeState && group.items.length > 6 && stateFilter === 'all' && !hostQuery.trim()"
              type="button"
              class="probe-group-toggle"
              @click="toggleProbeGroup(group.probeState)"
            >
              {{ expandedProbeStates.has(group.probeState)
                ? $t('收起分类')
                : $t('查看该分类全部 {0} 个节点', [group.items.length]) }}
            </button>
          </div>
        </section>
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
    </div>

    <div v-if="selected && selectedRank" class="host-resource-detail">
      <div class="detail-back-row">
        <el-button @click="closeDetail">← {{ $t('返回主机节点') }}</el-button>
        <span>
          {{ probeStateLabel(selectedRank.probeState) }} · {{ $t('组内顺序') }} {{ selectedGroupRank }}/{{ probeStateCounts[selectedRank.probeState] }}
          · {{ $t('判定依据') }}：{{ bottleneck(selected, selectedRank.state, selectedRank.alertCounts) }}
        </span>
      </div>
      <section class="host-detail-hero">
        <div>
          <div class="hero-badges">
            <span class="tone-badge" :class="`is-${probeStateTone(selectedRank.probeState)}`">{{ probeStateLabel(selectedRank.probeState) }}</span>
            <span v-if="selectedRank.probeState === 'online' && selectedRank.state !== 'healthy'" class="tone-badge" :class="`is-${selectedRank.state}`">{{ stateLabel(selectedRank.state) }}</span>
          </div>
          <h2>{{ selected.connectionName }}</h2>
          <p>{{ selected.host }} · {{ selected.operatingSystem }} {{ selected.architecture }} · {{ selected.environmentName }}</p>
        </div>
        <div v-if="canOperate" class="probe-operations">
          <el-button size="small" :disabled="probeBusy" @click="probeSelected('refresh')">{{ $t('重新检测') }}</el-button>
          <el-button v-if="selectedRank.probeState === 'missing'" size="small" type="primary" :disabled="probeBusy" @click="probeSelected('install')">{{ $t('安装探针') }}</el-button>
          <template v-if="probeIsInstalled(selected)">
            <el-button size="small" :disabled="probeBusy" @click="probeSelected('update')">{{ $t('更新探针') }}</el-button>
            <el-button size="small" :disabled="probeBusy" @click="probeSelected('reinstall')">{{ $t('重装探针') }}</el-button>
            <el-button size="small" :disabled="probeBusy" @click="probeSelected('restart')">{{ $t('重启探针') }}</el-button>
            <el-button size="small" type="danger" plain :disabled="probeBusy" @click="probeSelected('clear')">{{ $t('清理监控数据') }}</el-button>
            <el-button size="small" type="danger" :disabled="probeBusy" @click="probeSelected('uninstall')">{{ $t('卸载探针') }}</el-button>
          </template>
        </div>
      </section>
      <section v-if="selectedRank.probeState !== 'online'" class="host-detail-diagnostic" :class="`is-${selectedRank.probeState}`">
        <div>
          <span>{{ $t('探针状态诊断') }}</span>
          <strong>{{ probeStateLabel(selectedRank.probeState) }}</strong>
          <p>{{ probeEvidenceDetail(selected) }}</p>
        </div>
        <el-button size="small" @click="emit('open-maintenance', selected)">{{ $t('前往服务维护') }} →</el-button>
      </section>
      <div v-if="probeIsInstalled(selected)" class="host-detail-metrics">
        <div><span>CPU</span><strong>{{ formatPercent(selected.cpuUsedPercent) }}</strong><small>{{ selected.cpuCount ? `${selected.cpuCount} cores` : "—" }} · load {{ selected.load5 ?? "—" }}</small></div>
        <div><span>{{ $t('内存') }}</span><strong>{{ formatPercent(selected.memoryUsedPercent) }}</strong></div>
        <div><span>{{ $t('磁盘') }} MAX</span><strong :class="{ 'is-hot': resourceHot(selected.diskUsedPercent) }">{{ formatPercent(selected.diskUsedPercent) }}</strong><small>{{ selected.worstDisk?.path || "—" }}</small></div>
        <div><span>LOAD 5M</span><strong>{{ selected.load5 ?? "—" }}</strong><small>{{ formatFreshness(selected.lastCollectedAt) }}</small></div>
        <div><span>{{ $t('温度') }}</span><strong>{{ selected.temperatureCelsius == null ? "—" : `${selected.temperatureCelsius.toFixed(0)}°C` }}</strong></div>
      </div>
      <section v-if="probeIsInstalled(selected)" class="host-disk-table">
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
              <td colspan="5">{{ $t('暂无磁盘数据') }}</td>
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
        v-if="probeIsInstalled(selected) || selected.lastCollectedAt"
        :environment-id="selected.environmentId"
        :host-id="selected.sshConnectionId"
        :last-collected-at="selected.lastCollectedAt"
        @open-maintenance="emit('open-maintenance', selected)"
      />
    </div>
  </section>

  <el-dialog v-model="probeResultsOpen" :title="$t('探针操作结果')" width="min(720px, 94vw)" append-to-body>
    <div class="probe-result-summary">
      <span>{{ $t('本批次共 {0} 台主机', [probeResults.length]) }}</span>
      <small>{{ $t('安装、更新和重装任务会在服务端按并发上限继续执行') }}</small>
    </div>
    <div class="probe-result-list">
      <article v-for="item in probeResults" :key="item.id">
        <strong>{{ item.host }}</strong>
        <span>{{ probeActionLabel(item.action) }}</span>
        <b :class="`is-${item.status}`">{{ resultStatusLabel(item.status) }}</b>
        <small>{{ item.message }}<template v-if="item.taskId"> · {{ item.taskId }}</template></small>
      </article>
    </div>
    <template #footer>
      <el-button @click="probeResultsOpen = false">{{ $t('关闭') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.host-fleet {
  min-width: 0;
}

.host-fleet.is-detail-mode {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: var(--space-md, 16px);
  align-items: start;
}

.host-list-page { min-width: 0; }

.host-fleet.is-detail-mode .host-list-page {
  position: sticky;
  top: 0;
  border: 1px solid var(--color-rule, var(--ink-100));
  border-radius: var(--radius-panel, 8px);
  background: var(--color-paper-raised, var(--surface));
  overflow: hidden;
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
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
}

.host-compact-head strong { margin: 0; font-size: 13px; font-weight: 650; }

.host-workbench {
  min-width: 0;
  border: 1px solid var(--color-rule, var(--ink-100));
  border-radius: 12px;
  background: var(--color-paper-raised, var(--surface));
  overflow: hidden;
}

.view-toolbar {
  margin: 0;
  padding: 14px 16px 12px;
}

.probe-state-tabs {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0;
  padding: 0;
  border: 0;
  border-top: 1px solid var(--color-rule, var(--ink-100));
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
  border-radius: 0;
  background: var(--color-paper-muted, var(--ink-50));
}

.probe-state-tabs button {
  min-width: 0;
  min-height: 58px;
  padding: 8px 10px;
  display: grid;
  gap: 2px;
  align-content: center;
  border: 0;
  border-right: 1px solid var(--color-rule, var(--ink-100));
  border-radius: 0;
  background: transparent;
  color: var(--ink-500);
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-micro, 120ms) var(--ease-out, ease), color var(--dur-micro, 120ms) var(--ease-out, ease);
}

.probe-state-tabs button:last-child { border-right: 0; }
.probe-state-tabs button:hover { color: var(--ink-800); background: var(--surface); }
.probe-state-tabs button.is-active {
  background: var(--surface);
  color: var(--ink-900);
  box-shadow: inset 0 -2px 0 var(--ink-900);
}
.probe-state-tabs button:focus-visible {
  outline: 2px solid var(--teal-500);
  outline-offset: 1px;
}
.probe-state-tabs span { overflow: hidden; font-size: 10px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; order: 2; }
.probe-state-tabs strong { font-family: var(--font-display); font-size: 22px; font-weight: 800; letter-spacing: -0.03em; color: inherit; order: 1; }

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
.bulk-action-select { width: 160px; }

.host-count {
  color: var(--ink-700);
  font-size: 13px;
}

.host-count strong {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
}

.host-list-summary {
  display: grid;
  justify-items: end;
  gap: 2px;
}

.host-list-summary small {
  color: var(--ink-400);
  font-size: 10px;
}

.bulk-probe-bar {
  min-height: 44px;
  margin: 0;
  padding: 8px 16px;
  border: 0;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
  border-radius: 0;
  background: var(--surface);
}

.bulk-selection {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.bulk-selection strong { font-family: var(--font-mono); font-size: 11px; }

.probe-state-groups { display: grid; gap: 0; }
.probe-state-group { min-width: 0; }
.probe-state-group + .probe-state-group { border-top: 1px solid var(--color-rule, var(--ink-100)); }

.host-table-head,
.host-table-head.has-select,
.priority-host-card,
.priority-host-card:has(.host-card-select),
.priority-host-card:has(.host-resource-line),
.priority-host-card:has(.host-card-select):has(.host-resource-line) {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) 148px minmax(0, 1.2fr) 150px auto;
  gap: 12px 16px;
  align-items: center;
}

.host-table-head.has-select,
.priority-host-card:has(.host-card-select),
.priority-host-card:has(.host-card-select):has(.host-resource-line) {
  grid-template-columns: 18px minmax(0, 1.4fr) 148px minmax(0, 1.2fr) 150px auto;
}

.host-table-head {
  min-height: 34px;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
  background: var(--color-paper-muted, var(--ink-50));
  color: var(--ink-400);
  font-size: 11px;
  font-weight: 600;
}

.probe-state-group__head {
  min-height: 0;
  margin: 0;
  padding: 10px 16px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  border: 0;
  background: color-mix(in srgb, var(--color-paper-muted, var(--ink-50)) 70%, var(--surface));
}

.probe-state-group__head > div {
  min-width: 190px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.probe-state-group__head strong { font-size: 13px; font-weight: 650; }
.probe-state-group__head b { color: var(--ink-400); font-family: var(--font-mono); font-size: 12px; font-weight: 500; }
.probe-state-group__head small { color: var(--ink-400); font-size: 11px; text-align: right; }

.probe-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-300); }
.probe-state-dot.is-critical { background: var(--red-600); }
.probe-state-dot.is-warning { background: var(--amber-600); }
.probe-state-dot.is-healthy { background: var(--teal-600); }

.probe-group-toggle {
  width: 100%;
  margin-top: 0;
  padding: 10px 12px;
  border: 0;
  border-top: 1px solid var(--color-rule, var(--ink-100));
  border-radius: 0;
  background: transparent;
  color: var(--ink-600);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.probe-group-toggle:hover { color: var(--ink-900); background: var(--ink-50); }
.probe-group-toggle:focus-visible { outline: 2px solid var(--teal-500); outline-offset: -2px; }

.priority-host-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: hidden;
}

.host-fleet.is-detail-mode .priority-host-grid {
  border: 0;
  border-radius: 0;
  max-height: calc(100vh - 180px);
  overflow-y: auto;
}

.priority-host-card {
  min-height: 64px;
  position: relative;
  padding: 10px 16px;
  border: 0;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  transition: background var(--dur-micro, 120ms) var(--ease-out, ease);
}

.priority-host-card:last-child { border-bottom: 0; }
.priority-host-card:hover { background: var(--ink-50); }
.priority-host-card.is-selected { background: color-mix(in srgb, var(--teal-50) 70%, var(--surface)); }
.priority-host-card:focus-visible {
  outline: 2px solid var(--teal-500);
  outline-offset: -2px;
}

.host-fleet.is-detail-mode .priority-host-card,
.host-fleet.is-detail-mode .priority-host-card:has(.host-card-select),
.host-fleet.is-detail-mode .priority-host-card:has(.host-resource-line),
.host-fleet.is-detail-mode .priority-host-card:has(.host-card-select):has(.host-resource-line) {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  grid-template-columns: none;
  padding: 8px 12px;
}

.host-fleet.is-detail-mode .tone-badge {
  font-size: 0;
  gap: 0;
  min-height: 0;
  overflow: hidden;
}

.host-fleet.is-detail-mode .priority-host-card p,
.host-fleet.is-detail-mode .compact-host-reason,
.host-fleet.is-detail-mode .compact-host-resources {
  display: none;
}

.host-fleet.is-detail-mode .priority-host-card {
  overflow: hidden;
}

.host-card-select {
  width: 15px;
  height: 15px;
  margin: 0;
}

.host-status-cell {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.host-status-cell .tone-badge {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.compact-host-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.host-card-identity { min-width: 0; }

.host-card-flags {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.priority-host-card h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.priority-host-card p,
.host-detail-hero p,
.host-detail-metrics small {
  margin: 0;
  color: var(--ink-400);
  font-size: 11px;
}

.priority-host-card p { margin-top: 3px; }

.host-bottleneck {
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.host-bottleneck span {
  display: block;
  margin-bottom: 2px;
  color: var(--ink-400);
  font-size: 10px;
}

.host-bottleneck strong {
  color: var(--ink-800);
  font-size: 12px;
  font-weight: 600;
}

.host-bottleneck small {
  margin-top: 3px;
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink-400);
  font-size: 10px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.host-resource-bars { display: grid; gap: 4px; align-content: center; }
.host-resource-empty {
  color: var(--ink-300);
  font-family: var(--font-mono);
  font-size: 12px;
}

.host-resource-line {
  display: grid;
  grid-template-columns: 34px 1fr 36px;
  gap: 7px;
  align-items: center;
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
}

.host-resource-line i {
  height: 3px;
  overflow: hidden;
  border-radius: 99px;
  background: var(--ink-100);
}

.host-resource-line i span {
  display: block;
  height: 100%;
  background: var(--ink-400);
}

.host-resource-line.is-hot { color: var(--red-600); }
.host-resource-line.is-hot i span { background: var(--red-600); }
.is-hot { color: var(--red-600); }

.host-card-aside {
  min-width: 0;
  display: grid;
  justify-items: end;
  align-content: start;
  gap: 6px;
}

.host-card-meta {
  min-height: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.host-card-meta span {
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ink-400);
  font-size: 10px;
}

.host-card-meta span.is-alert {
  background: transparent;
  color: var(--red-600);
  font-weight: 650;
}

.host-card-action {
  justify-self: end;
  color: var(--ink-700);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.compact-host-head strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-host-reason {
  display: block;
  margin-top: 7px;
  overflow: hidden;
  color: var(--ink-600);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-host-resources {
  margin-top: 7px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 9px;
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
.host-detail-diagnostic,
.host-detail-metrics,
.host-disk-table {
  border: 1px solid var(--color-rule, var(--ink-100));
  border-radius: var(--radius-panel, 8px);
  background: var(--color-paper-raised, var(--surface));
}

.host-detail-hero { padding: 16px 18px; }

.host-detail-diagnostic {
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.host-detail-diagnostic span { color: var(--ink-400); font-size: 10px; }
.host-detail-diagnostic strong { display: block; margin: 3px 0; font-size: 14px; font-weight: 650; }
.host-detail-diagnostic p { margin: 0; color: var(--ink-500); font-size: 11px; overflow-wrap: anywhere; }

.host-detail-hero h2 {
  margin: 8px 0 4px;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.tone-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ink-600);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.tone-badge::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}

.tone-badge.is-critical,
.tone-badge.is-offline { color: var(--red-600); }
.tone-badge.is-warning { color: var(--amber-600); }
.tone-badge.is-unmanaged { color: var(--ink-400); }
.tone-badge.is-healthy { color: var(--teal-700); }

.host-detail-metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.host-detail-metrics > div {
  padding: 12px 14px;
  border-right: 1px solid var(--color-rule, var(--ink-100));
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
  font-weight: 650;
}

.host-disk-table header { padding: 10px 14px; border-bottom: 1px solid var(--color-rule, var(--ink-100)); }
.host-disk-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
.host-disk-table th,
.host-disk-table td { padding: 8px 14px; border-bottom: 1px solid var(--color-rule, var(--ink-100)); text-align: left; }
.host-disk-table th { color: var(--ink-400); font-weight: 600; }

.probe-result-summary {
  margin-bottom: 10px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.probe-result-summary small { color: var(--ink-400); }

.probe-result-list {
  max-height: 52vh;
  overflow-y: auto;
  border: 1px solid var(--color-rule, var(--ink-100));
  border-radius: var(--radius-panel, 8px);
}

.probe-result-list article {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 110px 72px minmax(180px, 1.5fr);
  gap: 10px;
  align-items: center;
  padding: 9px 12px;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
  font-size: 12px;
}

.probe-result-list article:last-child { border-bottom: 0; }
.probe-result-list small { color: var(--ink-400); overflow-wrap: anywhere; }
.probe-result-list b.is-success,
.probe-result-list b.is-submitted { color: var(--teal-700); }
.probe-result-list b.is-skipped { color: var(--ink-400); }
.probe-result-list b.is-failed { color: var(--red-600); }

@media (max-width: 1100px) {
  .probe-state-tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .host-fleet.is-detail-mode { grid-template-columns: minmax(0, 1fr); }
  .host-detail-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .host-detail-metrics > div:nth-child(2n) { border-right: 0; }
}

@media (max-width: 720px) {
  .probe-state-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .probe-state-tabs button { border-bottom: 1px solid var(--color-rule, var(--ink-100)); }
  .probe-state-group__head { align-items: flex-start; flex-direction: column; gap: 4px; }
  .probe-state-group__head small { text-align: left; }
  .host-detail-diagnostic { align-items: flex-start; flex-direction: column; }
  .host-table-head { display: none; }
  .priority-host-card,
  .priority-host-card:has(.host-card-select),
  .priority-host-card:has(.host-resource-line),
  .priority-host-card:has(.host-card-select):has(.host-resource-line),
  .host-table-head,
  .host-table-head.has-select {
    grid-template-columns: 18px minmax(0, 1fr);
  }
  .host-status-cell,
  .host-bottleneck,
  .host-resource-bars,
  .host-card-action { grid-column: 1 / -1; }
  .host-card-action { justify-self: start; }
  .probe-result-list article { grid-template-columns: 1fr auto; }
}

@media (prefers-reduced-motion: reduce) {
  .probe-state-tabs button,
  .priority-host-card { transition: none; }
  .host-fleet__more .is-spinning { animation: none; }
}
</style>
