<script setup lang="ts">
import { RefreshCw, Server } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";
import {
  compareMonitoringHosts,
  hostPressureScore,
  hostPriorityState,
  type MonitoringAlertCounts,
  type MonitoringHostPriorityState,
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
  installManaged?: boolean;
  installPath?: string;
  alertCounts?: MonitoringAlertCounts;
  worstDisk: { path: string; usedPercent: number | null } | null;
  disks?: MonitoringHostDisk[];
}

type ProbeAction = "install" | "update" | "reinstall" | "restart" | "clear";

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
const stateFilter = ref<"all" | MonitoringHostPriorityState>("all");
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

const allRankedHosts = computed(() => {
  return [...props.hosts]
    .map((host) => {
      const alertCounts = host.alertCounts ?? { critical: 0, major: 0, warning: 0 };
      const score = hostPressureScore({ ...host, alertCounts });
      const state = hostPriorityState({ ...host, alertCounts }, score);
      return { host, score, state, alertCounts };
    })
    .sort((left, right) => right.score - left.score || compareMonitoringHosts(left.host, right.host));
});

const rankedHosts = computed(() => {
  const query = hostQuery.value.trim().toLowerCase();
  return allRankedHosts.value.filter((item) => {
    const matchesQuery = !query || `${item.host.connectionName} ${item.host.host} ${item.host.environmentName}`.toLowerCase().includes(query);
    const matchesState = stateFilter.value === "all" || item.state === stateFilter.value;
    return matchesQuery && matchesState;
  });
});

const selected = computed(() => props.hosts.find((host) => host.sshConnectionId === props.selectedHostId) ?? null);
const selectedRank = computed(() => allRankedHosts.value.find((item) => item.host.sshConnectionId === props.selectedHostId) ?? null);
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
  if (host.offline) return tr("主机或监控探针离线");
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
  if (state === "offline") return tr("离线");
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

function probePath(host: MonitoringHostCard, action: "install/preflight" | "install-tasks" | "restart" | "clear") {
  return `/api/v1/environments/${host.environmentId}/monitor-hosts/${host.sshConnectionId}/${action}`;
}

function probeActionLabel(action: ProbeAction) {
  return ({
    install: tr("安装探针"),
    update: tr("更新探针"),
    reinstall: tr("重装探针"),
    restart: tr("重启探针"),
    clear: tr("清理节点监控数据"),
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
  if (action === "install" && !host.missing) {
    return { status: "skipped" as const, message: tr("已安装探针，未重复安装") };
  }
  if ((action === "update" || action === "reinstall" || action === "restart" || action === "clear") && host.missing) {
    return { status: "skipped" as const, message: tr("尚未安装探针") };
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
    : action === "reinstall"
      ? tr("将覆盖现有 Viron 监控探针程序，安装任务会在后台按队列执行。")
      : action === "install" || action === "update"
        ? tr("安装任务会先逐台预检，再在后台按队列执行。")
        : tr("操作将按最多 {{0}} 台并发执行。", [probeOperationConcurrency]);
  await ElMessageBox.confirm(
    `${tr("确认对 {{0}} 执行“{{1}}”？", [target, probeActionLabel(action)])}\n${detail}`,
    probeActionLabel(action),
    {
      type: action === "clear" || action === "reinstall" ? "warning" : "info",
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

      <div v-else class="view-toolbar">
        <div class="toolbar-filters">
          <el-input v-model="hostQuery" clearable :placeholder="$t('按主机名、IP 或环境搜索')" class="host-search" />
          <el-select v-model="stateFilter" class="state-filter">
            <el-option value="all" :label="$t('全部状态')" />
            <el-option value="offline" :label="$t('离线')" />
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
        <span>#{{ allRankedHosts.findIndex((item) => item.host.sshConnectionId === selected?.sshConnectionId) + 1 }} · {{ selectedRank.score }}</span>
      </div>
      <section class="host-detail-hero">
        <div>
          <div class="hero-badges">
            <span class="tone-badge" :class="`is-${selectedRank.state}`">{{ stateLabel(selectedRank.state) }}</span>
            <span class="tone-badge" :class="selected.offline ? 'is-critical' : selected.missing || selected.stale ? 'is-warning' : 'is-healthy'">
              {{ selected.offline ? $t('探针离线') : selected.missing ? $t('未安装探针') : selected.stale ? $t('数据陈旧') : $t('探针在线') }}
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
.priority-host-card.is-offline { border-top-color: var(--red-600); background: color-mix(in srgb, var(--red-100) 30%, var(--surface)); }
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
.tone-badge.is-offline { background: var(--red-100); color: var(--red-600); }
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
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-card, 8px);
}

.probe-result-list article {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 110px 72px minmax(180px, 1.5fr);
  gap: 10px;
  align-items: center;
  padding: 9px 12px;
  border-bottom: 1px solid var(--ink-100);
  font-size: 12px;
}

.probe-result-list article:last-child { border-bottom: 0; }
.probe-result-list small { color: var(--ink-400); overflow-wrap: anywhere; }
.probe-result-list b.is-success,
.probe-result-list b.is-submitted { color: var(--teal-700); }
.probe-result-list b.is-skipped { color: var(--ink-400); }
.probe-result-list b.is-failed { color: var(--red-600); }

@media (max-width: 1100px) {
  .priority-host-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .host-fleet.is-detail-mode { grid-template-columns: minmax(0, 1fr); }
  .host-detail-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 720px) {
  .priority-host-grid { grid-template-columns: minmax(0, 1fr); }
  .probe-result-list article { grid-template-columns: 1fr auto; }
}
</style>
