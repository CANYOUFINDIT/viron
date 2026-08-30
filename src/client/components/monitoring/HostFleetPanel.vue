<script setup lang="ts">
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Cpu,
  HardDrive,
  Info,
  Layers,
  MemoryStick,
  PlusCircle,
  Radio,
  RefreshCw,
  Server,
  Thermometer,
  Wrench,
} from "@lucide/vue";
import { computed, ref } from "vue";
import { translate as tr } from "../../i18n";
import { compareMonitoringHosts } from "../../../shared/monitoring";
import HostMonitorDashboard from "../HostMonitorDashboard.vue";
import HostEventCalendar from "./HostEventCalendar.vue";

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
  operatingSystem: string;
  architecture: string;
  worstDisk: { path: string; usedPercent: number | null } | null;
}

const props = defineProps<{
  hosts: MonitoringHostCard[];
  selectedHostId: string;
  canOperate: boolean;
  loadingMore?: boolean;
  loadedCount?: number;
  hostTotal?: number;
}>();

const emit = defineEmits<{
  select: [host: MonitoringHostCard];
  install: [host: MonitoringHostCard];
  "open-maintenance": [host: MonitoringHostCard];
}>();

const showUnmonitoredList = ref(false);

// 过滤已安装探针的监控主机与未安装探针的主机
const monitoredHosts = computed(() => [...props.hosts.filter((host) => !host.missing)].sort(compareMonitoringHosts));
const unmonitoredHosts = computed(() => props.hosts.filter((host) => host.missing));

const selected = computed(() => {
  if (props.selectedHostId) {
    const found = props.hosts.find((host) => host.sshConnectionId === props.selectedHostId);
    if (found) return found;
  }
  return monitoredHosts.value[0] ?? props.hosts[0] ?? null;
});

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatRate(value: number | null | undefined) {
  if (value == null) return "—";
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}

function formatCollected(value: string | null | undefined) {
  return value ? new Date(value).toLocaleTimeString() : "—";
}

function metricTone(value: number | null, warnThreshold = 75, critThreshold = 90) {
  if (value === null) return "is-muted";
  if (value >= critThreshold) return "is-danger";
  if (value >= warnThreshold) return "is-warning";
  return "is-healthy";
}

function presence(host: MonitoringHostCard) {
  if (host.offline) return { key: "offline", label: tr("离线"), icon: AlertCircle };
  if (host.missing) return { key: "missing", label: tr("探针未安装"), icon: CircleAlert };
  if (host.stale) return { key: "stale", label: tr("陈旧数据"), icon: AlertTriangle };
  if (host.status === "ready") return { key: "online", label: tr("在线"), icon: CheckCircle2 };
  return { key: "unknown", label: tr("未知"), icon: Activity };
}
</script>

<template>
  <section class="host-fleet">
    <!-- 未安装探针主机轻量提示横幅 -->
    <div v-if="unmonitoredHosts.length" class="unmonitored-notice-banner">
      <div class="notice-left">
        <Info :size="16" class="text-amber" />
        <div class="notice-text">
          <span>
            {{ $t('检测到有') }} <strong>{{ unmonitoredHosts.length }}</strong> {{ $t('台主机尚未接入监控探针，暂未纳入监控大盘。') }}
          </span>
        </div>
      </div>
      <div class="notice-actions">
        <button
          type="button"
          class="notice-toggle-btn"
          @click="showUnmonitoredList = !showUnmonitoredList"
        >
          <span>{{ showUnmonitoredList ? $t('收起未接入主机') : $t('查看未接入主机') }}</span>
          <component :is="showUnmonitoredList ? ChevronUp : ChevronDown" :size="14" />
        </button>
        <button
          v-if="canOperate && unmonitoredHosts[0]"
          type="button"
          class="notice-action-link"
          @click="emit('open-maintenance', unmonitoredHosts[0])"
        >
          {{ $t('前往服务维护批量安装') }} →
        </button>
      </div>
    </div>

    <!-- 展开的未安装探针主机列表抽屉/轻量容器 -->
    <div v-if="unmonitoredHosts.length && showUnmonitoredList" class="unmonitored-hosts-drawer">
      <header class="drawer-header">
        <h4>{{ $t('未接入监控主机列表') }} ({{ unmonitoredHosts.length }})</h4>
        <small>{{ $t('安装轻量级监控探针（viron-monitor）后即可在大盘实时采集其指标') }}</small>
      </header>
      <div class="unmonitored-hosts-grid">
        <div
          v-for="host in unmonitoredHosts"
          :key="host.sshConnectionId"
          class="unmonitored-host-item"
        >
          <div class="item-main">
            <span class="item-icon"><Server :size="14" /></span>
            <div class="item-text">
              <strong>{{ host.connectionName }}</strong>
              <small>{{ host.host }} · {{ host.environmentName }}</small>
            </div>
          </div>
          <el-button
            v-if="canOperate"
            size="small"
            type="primary"
            plain
            class="item-install-btn"
            @click="emit('install', host)"
          >
            <PlusCircle :size="12" />
            <span>{{ $t('一键安装探针') }}</span>
          </el-button>
        </div>
      </div>
    </div>

    <!-- 已安装探针的主机卡片网格矩阵 (仅展示已纳管监控的主机) -->
    <div v-if="monitoredHosts.length" class="host-fleet__grid">
      <button
        v-for="host in monitoredHosts"
        :key="host.sshConnectionId"
        type="button"
        class="host-card"
        :class="{
          'is-active': selected?.sshConnectionId === host.sshConnectionId,
          [`is-status-${presence(host).key}`]: true
        }"
        @click="emit('select', host)"
      >
        <!-- 卡片顶部：主机名称与状态 Badge -->
        <header class="host-card__head">
          <div class="host-card__identity">
            <span class="host-icon"><Server :size="15" /></span>
            <div class="host-title-group">
              <strong :title="host.connectionName">{{ host.connectionName }}</strong>
              <small>{{ host.host }} · {{ host.environmentName }}</small>
            </div>
          </div>
          <span class="presence-badge" :class="`is-${presence(host).key}`">
            <component :is="presence(host).icon" :size="12" />
            <span>{{ presence(host).label }}</span>
          </span>
        </header>

        <!-- 卡片中部：各维度的实时监控数据与进度槽 -->
        <div class="host-card__metrics">
          <!-- CPU 仪表槽 -->
          <div class="metric-row">
            <div class="metric-info">
              <span class="metric-label">CPU</span>
              <strong class="metric-value" :class="metricTone(host.cpuUsedPercent, 70, 85)">
                {{ formatPercent(host.cpuUsedPercent) }}
              </strong>
            </div>
            <div class="mini-progress-track">
              <div
                class="mini-progress-fill"
                :class="metricTone(host.cpuUsedPercent, 70, 85)"
                :style="{ width: `${Math.min(100, Math.max(0, host.cpuUsedPercent ?? 0))}%` }"
              ></div>
            </div>
          </div>

          <!-- 内存仪表槽 -->
          <div class="metric-row">
            <div class="metric-info">
              <span class="metric-label">{{ $t('内存') }}</span>
              <strong class="metric-value" :class="metricTone(host.memoryUsedPercent, 75, 90)">
                {{ formatPercent(host.memoryUsedPercent) }}
              </strong>
            </div>
            <div class="mini-progress-track">
              <div
                class="mini-progress-fill"
                :class="metricTone(host.memoryUsedPercent, 75, 90)"
                :style="{ width: `${Math.min(100, Math.max(0, host.memoryUsedPercent ?? 0))}%` }"
              ></div>
            </div>
          </div>

          <!-- 磁盘仪表槽 -->
          <div class="metric-row">
            <div class="metric-info">
              <span class="metric-label">{{ $t('磁盘') }}</span>
              <strong class="metric-value" :class="metricTone(host.diskUsedPercent, 80, 90)">
                {{ formatPercent(host.diskUsedPercent) }}
              </strong>
            </div>
            <div class="mini-progress-track">
              <div
                class="mini-progress-fill"
                :class="metricTone(host.diskUsedPercent, 80, 90)"
                :style="{ width: `${Math.min(100, Math.max(0, host.diskUsedPercent ?? 0))}%` }"
              ></div>
            </div>
          </div>

          <!-- 辅助微参数：网络吞吐与温度 -->
          <div class="host-card__sub-stats">
            <span class="sub-stat-chip" :title="$t('网络流量')">
              <ArrowDown :size="11" class="text-blue" />
              <span>{{ formatRate(host.networkReceiveBytesPerSecond) }}</span>
              <ArrowUp :size="11" class="text-teal" />
              <span>{{ formatRate(host.networkTransmitBytesPerSecond) }}</span>
            </span>
            <span v-if="host.temperatureCelsius !== null" class="sub-stat-chip" :title="$t('硬件温度')">
              <Thermometer :size="11" class="text-amber" />
              <span>{{ host.temperatureCelsius.toFixed(1) }}°C</span>
            </span>
          </div>
        </div>

        <!-- 卡片底部元数据 -->
        <footer class="host-card__foot">
          <span class="agent-ver">Agent {{ host.agentVersion || '—' }}</span>
          <span v-if="host.stale" class="stale-badge">{{ $t('陈旧采样') }} {{ formatCollected(host.lastCollectedAt) }}</span>
          <span v-else class="collected-time">{{ $t('采集') }} {{ formatCollected(host.lastCollectedAt) }}</span>
        </footer>
      </button>
    </div>

    <p v-if="loadingMore" class="host-fleet__more" aria-live="polite">
      <RefreshCw :size="14" class="is-spinning" />
      <span>{{ $t('正在加载其余主机') }}<template v-if="hostTotal"> · {{ loadedCount ?? hosts.length }}/{{ hostTotal }}</template></span>
    </p>

    <!-- 当环境中所有机器都尚未接入探针时的空状态引导 -->
    <div v-if="!monitoredHosts.length && !loadingMore" class="host-fleet__no-monitored">
      <div class="no-monitored-card">
        <Server :size="36" class="text-teal" />
        <div class="no-monitored-text">
          <h3>{{ $t('当前环境尚未接入已安装探针的主机') }}</h3>
          <p>{{ $t('监控大盘仅陈列已安装探针的主机。请先为环境中的主机安装监控探针以开始实时指标采集。') }}</p>
        </div>
        <el-button
          v-if="canOperate && unmonitoredHosts[0]"
          type="primary"
          @click="emit('open-maintenance', unmonitoredHosts[0])"
        >
          <PlusCircle :size="14" />
          <span>{{ $t('前往服务维护安装探针') }}</span>
        </el-button>
      </div>
    </div>

    <!-- 选定主机的可观测性看板（直接展示对应机器的监控数据与时序图表） -->
    <div v-if="selected && !selected.missing" class="host-fleet__detail-card">
      <header class="detail-header">
        <div class="detail-header__main">
          <div class="detail-icon"><Server :size="20" /></div>
          <div class="detail-info">
            <div class="detail-title-row">
              <h3>{{ selected.connectionName }}</h3>
              <span class="presence-pill" :class="`is-${presence(selected).key}`">
                {{ presence(selected).label }}
              </span>
            </div>
            <p class="detail-meta">
              <span>{{ selected.host }}</span>
              <span>·</span>
              <span>{{ selected.environmentName }}</span>
              <span>·</span>
              <span>{{ selected.operatingSystem }} {{ selected.architecture }}</span>
              <span v-if="selected.agentVersion">· Agent v{{ selected.agentVersion }}</span>
            </p>
          </div>
        </div>

        <div class="detail-header__actions">
          <el-button
            v-if="canOperate && (selected.missing || selected.offline)"
            type="warning"
            plain
            size="small"
            class="action-btn"
            @click="emit('install', selected)"
          >
            <RefreshCw :size="13" />
            <span>{{ $t('重新安装探针') }}</span>
          </el-button>
          <el-button
            type="primary"
            plain
            size="small"
            class="action-btn"
            @click="emit('open-maintenance', selected)"
          >
            <Wrench :size="13" />
            <span>{{ $t('服务维护') }}</span>
          </el-button>
        </div>
      </header>

      <div class="detail-body">
        <HostEventCalendar
          :environment-id="selected.environmentId"
          :host-id="selected.sshConnectionId"
        />
        <HostMonitorDashboard
          :environment-id="selected.environmentId"
          :host-id="selected.sshConnectionId"
          :last-collected-at="selected.lastCollectedAt"
          @open-maintenance="emit('open-maintenance', selected)"
        />
      </div>
    </div>

    <!-- 未选择提示 -->
    <div v-else-if="monitoredHosts.length" class="host-fleet__hint">
      <Activity :size="20" />
      <span>{{ $t('点击上方主机卡片，查看深度时序图表与智能诊断') }}</span>
    </div>
  </section>
</template>


<style scoped>
.host-fleet {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.host-fleet__more {
  margin: 0;
  padding: 8px 12px;
  border: 1px dashed var(--ink-200);
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-500);
  font-size: 12px;
}

.host-fleet__more .is-spinning {
  animation: host-fleet-spin 1s linear infinite;
}

@keyframes host-fleet-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .host-fleet__more .is-spinning { animation: none; }
}

/* 未纳管主机轻量提示横幅 */
.unmonitored-notice-banner {
  padding: 8px 14px;
  border: 1px solid color-mix(in srgb, #f59e0b 25%, var(--ink-100));
  border-radius: 9px;
  background: color-mix(in srgb, #fef3c7 30%, var(--surface));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.notice-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.notice-text {
  font-size: 11px;
  color: var(--ink-700);
}

.notice-text strong {
  color: #b45309;
  font-family: var(--font-mono);
}

.notice-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.notice-toggle-btn {
  border: 0;
  padding: 2px 6px;
  border-radius: 5px;
  background: transparent;
  color: var(--ink-600);
  font-size: 11px;
  font-weight: 650;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  transition: all .15s ease;
}

.notice-toggle-btn:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--ink-900);
}

.notice-action-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--teal-700);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.notice-action-link:hover {
  text-decoration: underline;
}

/* 展开的未安装探针主机抽屉 */
.unmonitored-hosts-drawer {
  padding: 12px 14px;
  border: 1px dashed var(--ink-200);
  border-radius: 10px;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.drawer-header h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 750;
  color: var(--ink-900);
}

.drawer-header small {
  font-size: 10px;
  color: var(--ink-400);
}

.unmonitored-hosts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 8px;
}

.unmonitored-host-item {
  padding: 8px 12px;
  border: 1px solid var(--ink-100);
  border-radius: 7px;
  background: var(--ink-50);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.item-icon {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  background: var(--ink-100);
  color: var(--ink-500);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.item-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.item-text strong {
  font-size: 11px;
  font-weight: 700;
  color: var(--ink-900);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-text small {
  font-size: 10px;
  color: var(--ink-400);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 主机卡片网格 */
.host-fleet__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 10px;
}

.host-card {
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-card, 8px);
  background: var(--surface);
  color: inherit;
  text-align: start;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: var(--shadow-sm);
  transition: border-color var(--dur-short, .2s) var(--ease-out, ease), background-color var(--dur-short, .2s) var(--ease-out, ease), box-shadow var(--dur-short, .2s) var(--ease-out, ease);
  position: relative;
  overflow: hidden;
}

.host-card:hover {
  border-color: var(--teal-300);
}

.host-card.is-active {
  border-color: var(--teal-500);
  background: color-mix(in srgb, var(--teal-50) 45%, var(--surface));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--teal-500) 12%, transparent);
}

/* 卡片头部 */
.host-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.host-card__identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.host-icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--ink-50);
  color: var(--ink-500);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  transition: background-color var(--dur-short, .2s) ease, color var(--dur-short, .2s) ease;
}

.host-card.is-active .host-icon {
  background: var(--teal-100);
  color: var(--teal-700);
}

.host-title-group {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.host-title-group strong {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-950);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-title-group small {
  font-size: 10px;
  color: var(--ink-400);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态徽标 */
.presence-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  flex-shrink: 0;
}

.presence-badge.is-online { background: var(--teal-50); color: var(--teal-700); }
.presence-badge.is-stale { background: var(--amber-100); color: var(--amber-700); }
.presence-badge.is-offline { background: var(--red-100); color: var(--red-600); }
.presence-badge.is-missing { background: var(--ink-50); color: var(--ink-500); }
.presence-badge.is-unknown { background: var(--ink-50); color: var(--ink-400); }

/* 指标槽条 */
.host-card__metrics {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metric-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.metric-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
}

.metric-label {
  color: var(--ink-400);
  font-size: 10px;
  font-weight: 600;
}

.metric-value {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
}

.metric-value.is-healthy { color: var(--ink-900); }
.metric-value.is-warning { color: var(--amber-600); }
.metric-value.is-danger { color: var(--red-600); }
.metric-value.is-muted { color: var(--ink-400); }

.mini-progress-track {
  height: 3px;
  border-radius: 1.5px;
  background: var(--ink-100);
  overflow: hidden;
}

.mini-progress-fill {
  height: 100%;
  border-radius: 1.5px;
  transition: width .25s ease;
}

.mini-progress-fill.is-healthy { background: var(--teal-500); }
.mini-progress-fill.is-warning { background: var(--amber-600); }
.mini-progress-fill.is-danger { background: var(--red-600); }
.mini-progress-fill.is-muted { background: var(--ink-300); }

/* 辅助微参数 */
.host-card__sub-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 5px;
  border-top: 1px solid var(--ink-100);
}

.sub-stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-500);
}

.text-blue { color: #3b76bb; }
.text-teal { color: var(--teal-600); }
.text-amber { color: var(--amber-600); }

/* 卡片底部 */
.host-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 5px;
  border-top: 1px solid var(--ink-100);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-400);
}

.stale-badge {
  color: var(--amber-600);
  font-weight: 600;
}

/* 全空态 */
.host-fleet__no-monitored {
  padding: 36px 20px;
  border: 1px dashed var(--ink-200);
  border-radius: var(--radius-panel, 8px);
  background: var(--surface);
  display: flex;
  justify-content: center;
  align-items: center;
}

.no-monitored-card {
  max-width: 480px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
}

.no-monitored-text h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--ink-900);
}

.no-monitored-text p {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--ink-400);
  line-height: 1.5;
}

/* 详情面板大卡片 */
.host-fleet__detail-card {
  min-width: 0;
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-panel, 8px);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.detail-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  background: color-mix(in srgb, var(--ink-50) 35%, var(--surface));
}

.detail-header__main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-icon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: var(--teal-50);
  color: var(--teal-700);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.detail-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.detail-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-title-row h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--ink-950);
}

.presence-pill {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
}

.presence-pill.is-online { background: var(--teal-50); color: var(--teal-700); }
.presence-pill.is-stale { background: var(--amber-100); color: var(--amber-700); }
.presence-pill.is-offline { background: var(--red-100); color: var(--red-600); }
.presence-pill.is-missing { background: var(--ink-50); color: var(--ink-500); }

.detail-meta {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ink-400);
}

.detail-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-body {
  padding: 0 16px 16px;
}

.host-fleet__hint {
  padding: 36px;
  border: 1px dashed var(--ink-200);
  border-radius: var(--radius-panel, 8px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ink-400);
  font-size: 13px;
}

@media (max-width: 768px) {
  .host-fleet__grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-header {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
