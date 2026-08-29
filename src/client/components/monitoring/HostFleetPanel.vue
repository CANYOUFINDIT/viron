<script setup lang="ts">
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  Cpu,
  HardDrive,
  Layers,
  MemoryStick,
  PlusCircle,
  Radio,
  RefreshCw,
  Server,
  Thermometer,
  Wrench,
} from "@lucide/vue";
import { computed } from "vue";
import { translate as tr } from "../../i18n";
import HostMonitorDashboard from "../HostMonitorDashboard.vue";

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
}>();

const emit = defineEmits<{
  select: [host: MonitoringHostCard];
  install: [host: MonitoringHostCard];
  "open-maintenance": [host: MonitoringHostCard];
}>();

const selected = computed(() => props.hosts.find((host) => host.sshConnectionId === props.selectedHostId) ?? null);

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
  if (host.missing) return { key: "missing", label: tr("探针缺失"), icon: CircleAlert };
  if (host.stale) return { key: "stale", label: tr("陈旧数据"), icon: AlertTriangle };
  if (host.status === "ready") return { key: "online", label: tr("在线"), icon: CheckCircle2 };
  return { key: "unknown", label: tr("未知"), icon: Activity };
}
</script>

<template>
  <section class="host-fleet">
    <!-- 主机卡片网格矩阵 -->
    <div class="host-fleet__grid">
      <button
        v-for="host in hosts"
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

        <!-- 卡片中部：探针已安装时的可视化指标 -->
        <div v-if="!host.missing" class="host-card__metrics">
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

        <!-- 探针缺失引导态 -->
        <div v-else class="host-card__missing-guide">
          <CircleAlert :size="20" class="text-muted" />
          <div class="missing-text">
            <strong>{{ $t('尚未安装监控探针') }}</strong>
            <small>{{ $t('安装探针后可实时采集 CPU、内存及服务时序') }}</small>
          </div>
          <el-button
            v-if="canOperate"
            size="small"
            type="primary"
            plain
            class="missing-install-btn"
            @click.stop="emit('install', host)"
          >
            <PlusCircle :size="12" />
            <span>{{ $t('一键安装探针') }}</span>
          </el-button>
        </div>

        <!-- 卡片底部元数据 -->
        <footer class="host-card__foot">
          <span class="agent-ver">Agent {{ host.agentVersion || '—' }}</span>
          <span v-if="host.stale" class="stale-badge">{{ $t('陈旧采样') }} {{ formatCollected(host.lastCollectedAt) }}</span>
          <span v-else class="collected-time">{{ $t('采集') }} {{ formatCollected(host.lastCollectedAt) }}</span>
        </footer>
      </button>

      <!-- 空状态 -->
      <div v-if="!hosts.length" class="host-fleet__empty">
        <Server :size="28" />
        <strong>{{ $t('当前环境暂无关联主机') }}</strong>
      </div>
    </div>

    <!-- 选定主机的可观测性看板 -->
    <div v-if="selected" class="host-fleet__detail-card">
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
        <HostMonitorDashboard
          v-if="!selected.missing"
          :environment-id="selected.environmentId"
          :host-id="selected.sshConnectionId"
          :last-collected-at="selected.lastCollectedAt"
          @open-maintenance="emit('open-maintenance', selected)"
        />
        <div v-else class="host-fleet__missing-full">
          <CircleAlert :size="28" />
          <div>
            <strong>{{ $t('该主机未安装监控探针或数据已下线') }}</strong>
            <p>{{ $t('前往服务维护页面为该主机安装轻量级监控探针以启用实时指标与诊断。') }}</p>
          </div>
          <el-button
            v-if="canOperate"
            type="primary"
            @click="emit('install', selected)"
          >
            <PlusCircle :size="14" />
            {{ $t('前往服务维护安装探针') }}
          </el-button>
        </div>
      </div>
    </div>

    <!-- 未选择提示 -->
    <div v-else class="host-fleet__hint">
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
  gap: 16px;
}

/* 主机卡片网格 */
.host-fleet__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18.5rem, 1fr));
  gap: 12px;
}

.host-card {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  background: var(--surface);
  color: inherit;
  text-align: start;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-sm);
  transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
  position: relative;
  overflow: hidden;
}

.host-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
  background: transparent;
  transition: background .18s ease;
}

.host-card:hover {
  transform: translateY(-2px);
  border-color: var(--teal-300);
  box-shadow: 0 4px 16px rgba(0, 0, 0, .05);
}

.host-card.is-active {
  border-color: var(--teal-500);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--teal-500) 25%, transparent), var(--shadow-sm);
}

.host-card.is-active::before {
  background: var(--teal-500);
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
  gap: 10px;
}

.host-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--ink-50);
  color: var(--ink-600);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.host-card.is-active .host-icon {
  background: var(--teal-50);
  color: var(--teal-700);
}

.host-title-group {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.host-title-group strong {
  font-size: 13px;
  font-weight: 750;
  color: var(--ink-950);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-title-group small {
  font-size: 11px;
  color: var(--ink-400);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态徽标 */
.presence-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.presence-badge.is-online { background: var(--teal-50); color: var(--teal-700); }
.presence-badge.is-stale { background: var(--amber-100); color: var(--amber-600); }
.presence-badge.is-offline { background: var(--red-100); color: var(--red-600); }
.presence-badge.is-missing { background: var(--ink-100); color: var(--ink-500); }
.presence-badge.is-unknown { background: var(--ink-50); color: var(--ink-400); }

/* 指标槽条 */
.host-card__metrics {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metric-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.metric-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}

.metric-label {
  color: var(--ink-400);
  font-size: 10px;
  font-weight: 650;
}

.metric-value {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
}

.metric-value.is-healthy { color: var(--ink-800); }
.metric-value.is-warning { color: #d97706; }
.metric-value.is-danger { color: #dc2626; }
.metric-value.is-muted { color: var(--ink-400); }

.mini-progress-track {
  height: 4px;
  border-radius: 2px;
  background: var(--ink-100);
  overflow: hidden;
}

.mini-progress-fill {
  height: 100%;
  border-radius: 2px;
  transition: width .25s ease;
}

.mini-progress-fill.is-healthy { background: #10b981; }
.mini-progress-fill.is-warning { background: #f59e0b; }
.mini-progress-fill.is-danger { background: #ef4444; }
.mini-progress-fill.is-muted { background: var(--ink-200); }

/* 辅助微参数 */
.host-card__sub-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px dashed var(--ink-100);
}

.sub-stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-500);
}

.text-blue { color: #2563eb; }
.text-teal { color: var(--teal-600); }
.text-amber { color: #d97706; }

/* 探针缺失引导态 */
.host-card__missing-guide {
  min-height: 80px;
  padding: 10px;
  border-radius: 8px;
  background: var(--ink-50);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
}

.missing-text strong {
  display: block;
  font-size: 11px;
  color: var(--ink-700);
}

.missing-text small {
  display: block;
  font-size: 10px;
  color: var(--ink-400);
  margin-top: 2px;
}

.missing-install-btn {
  margin-top: 2px;
}

/* 卡片底部 */
.host-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--ink-100);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-400);
}

.stale-badge {
  color: #d97706;
  font-weight: 700;
}

/* 详情面板大卡片 */
.host-fleet__detail-card {
  min-width: 0;
  border: 1px solid var(--ink-100);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.detail-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  background: color-mix(in srgb, var(--ink-50) 40%, var(--surface));
}

.detail-header__main {
  display: flex;
  align-items: center;
  gap: 12px;
}

.detail-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--teal-50);
  color: var(--teal-700);
  display: grid;
  place-items: center;
}

.detail-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.detail-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-title-row h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 800;
  color: var(--ink-950);
}

.presence-pill {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
}

.presence-pill.is-online { background: var(--teal-50); color: var(--teal-700); }
.presence-pill.is-stale { background: var(--amber-100); color: var(--amber-600); }
.presence-pill.is-offline { background: var(--red-100); color: var(--red-600); }
.presence-pill.is-missing { background: var(--ink-100); color: var(--ink-500); }

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

.host-fleet__missing-full {
  padding: 48px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 14px;
  color: var(--ink-400);
}

.host-fleet__missing-full strong {
  font-size: 14px;
  color: var(--ink-800);
}

.host-fleet__missing-full p {
  margin: 6px 0 0;
  font-size: 12px;
  max-width: 480px;
}

.host-fleet__empty,
.host-fleet__hint {
  padding: 40px;
  border: 1px dashed var(--ink-200);
  border-radius: 12px;
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

