<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  HardDrive,
  Minimize,
  Radio,
  Server,
  ShieldAlert,
  Zap,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MonitoringHostCard } from "./HostFleetPanel.vue";
import type { MonitoringProblemNode, MonitoringServiceCard } from "./ServiceApmPanel.vue";

const props = defineProps<{
  generatedAt: string;
  summary: {
    hostTotal: number;
    hostOnline: number;
    hostOffline: number;
    hostMissing: number;
    hostStale: number;
    avgCpuPercent: number | null;
    avgMemoryPercent: number | null;
    diskAlerts: number;
  };
  hosts: MonitoringHostCard[];
  problemNodes: MonitoringProblemNode[];
  ranking: MonitoringServiceCard[];
  alerts: Array<{ id: string; status: string; targetName: string; environmentName?: string; triggeredAt?: string }>;
}>();

const emit = defineEmits<{ exit: [] }>();
const root = ref<HTMLElement | null>(null);
const reducedMotion = ref(false);

const heatHosts = computed(() => props.hosts.slice(0, 48));
const networkRanking = computed(() => props.hosts
  .map((host) => ({ host, total: Number(host.networkReceiveBytesPerSecond ?? 0) + Number(host.networkTransmitBytesPerSecond ?? 0) }))
  .sort((left, right) => right.total - left.total)
  .slice(0, 8));
const storageWarnings = computed(() => props.hosts
  .filter((host) => host.worstDisk?.usedPercent != null)
  .sort((left, right) => Number(right.worstDisk?.usedPercent ?? 0) - Number(left.worstDisk?.usedPercent ?? 0))
  .slice(0, 8));

const distributionStyle = computed(() => {
  const total = Math.max(1, props.summary.hostTotal);
  const online = (props.summary.hostOnline / total) * 360;
  const offline = (props.summary.hostOffline / total) * 360;
  const missing = (props.summary.hostMissing / total) * 360;
  return {
    background: `conic-gradient(#10b981 0deg ${online}deg, #ef4444 ${online}deg ${online + offline}deg, #64748b ${online + offline}deg ${online + offline + missing}deg, #f59e0b ${online + offline + missing}deg 360deg)`
  };
});

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(0)}%`;
}

function formatRate(value: number) {
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}

function heatClass(host: MonitoringHostCard) {
  if (host.offline || host.missing) return "is-down";
  if (host.stale) return "is-unknown";
  const cpu = host.cpuUsedPercent;
  if (cpu === null) return "is-unknown";
  if (cpu >= 85) return "is-critical";
  if (cpu >= 70) return "is-warn";
  return "is-ok";
}

async function enterFullscreen() {
  if (!root.value || document.fullscreenElement) return;
  try { await root.value.requestFullscreen(); } catch { /* keep windowed NOC */ }
}

function onFullscreenChange() {
  if (!document.fullscreenElement) emit("exit");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("exit");
}

onMounted(() => {
  reducedMotion.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("keydown", onKeydown);
  void enterFullscreen();
});
onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("keydown", onKeydown);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
});
</script>

<template>
  <Teleport to="body">
    <section ref="root" class="noc-screen" :class="{ 'is-reduced': reducedMotion }" role="dialog" aria-label="NOC Operations Center">
      <!-- 顶部控制条 -->
      <header class="noc-header">
        <div class="noc-brand">
          <Radio :size="18" class="text-teal" />
          <strong>VIRON CLUSTER OPERATIONS CENTER</strong>
          <span class="noc-live-badge" aria-live="polite">
            <span class="noc-pulse-dot"></span> LIVE · {{ generatedAt ? new Date(generatedAt).toLocaleTimeString() : "—" }}
          </span>
        </div>
        <button type="button" class="noc-exit-btn" :aria-label="$t('退出全屏')" @click="emit('exit')">
          <Minimize :size="14" />
          <span>{{ $t('退出全屏') }} (ESC)</span>
        </button>
      </header>

      <!-- 大屏三列网格 -->
      <div class="noc-grid">
        <!-- 左侧面板：节点分布与告警流 -->
        <aside class="noc-panel">
          <header class="noc-panel__head">
            <h3>{{ $t('节点运行状态罗盘') }}</h3>
          </header>
          <div class="noc-donut" :style="distributionStyle">
            <div class="donut-core">
              <strong>{{ summary.hostOnline }}</strong>
              <small>/ {{ summary.hostTotal }} ONLINE</small>
            </div>
          </div>
          <div class="noc-legend">
            <span><i class="dot-green"></i> {{ summary.hostOnline }} {{ $t('在线') }}</span>
            <span><i class="dot-red"></i> {{ summary.hostOffline }} {{ $t('离线') }}</span>
            <span><i class="dot-gray"></i> {{ summary.hostMissing }} {{ $t('缺失') }}</span>
            <span><i class="dot-amber"></i> {{ summary.hostStale }} {{ $t('陈旧') }}</span>
          </div>

          <header class="noc-panel__head mt-16">
            <h3>{{ $t('实时告警事件流') }}</h3>
          </header>
          <ol v-if="alerts.length" class="noc-alert-stream">
            <li v-for="alert in alerts.slice(0, 12)" :key="alert.id">
              <AlertTriangle :size="12" class="text-amber" />
              <span class="alert-name">{{ alert.targetName }}</span>
              <span class="alert-status">{{ alert.status }}</span>
            </li>
          </ol>
          <p v-else class="noc-empty">
            <CheckCircle2 :size="16" class="text-teal" />
            <span>{{ $t('暂无活动告警') }}</span>
          </p>
        </aside>

        <!-- 中间主面板：集群核心仪表、波形与热力矩阵 -->
        <main class="noc-panel noc-main-panel">
          <!-- 3 个核心大表盘 -->
          <div class="noc-gauges">
            <article class="gauge-card">
              <div class="gauge-head">
                <Cpu :size="16" class="text-teal" />
                <small>CPU AVG</small>
              </div>
              <strong>{{ formatPercent(summary.avgCpuPercent) }}</strong>
            </article>
            <article class="gauge-card">
              <div class="gauge-head">
                <HardDrive :size="16" class="text-purple" />
                <small>MEM AVG</small>
              </div>
              <strong>{{ formatPercent(summary.avgMemoryPercent) }}</strong>
            </article>
            <article class="gauge-card">
              <div class="gauge-head">
                <ShieldAlert :size="16" class="text-amber" />
                <small>DISK ALERTS</small>
              </div>
              <strong :class="{ 'text-red': summary.diskAlerts > 0 }">{{ summary.diskAlerts }}</strong>
            </article>
          </div>

          <!-- 动态波形条 -->
          <div class="noc-wave-box">
            <div class="noc-wave" aria-label="CPU waveform">
              <i
                v-for="host in heatHosts.slice(0, 36)"
                :key="`wave-${host.sshConnectionId}`"
                :style="{ height: `${Math.max(8, host.cpuUsedPercent || 0)}%` }"
                :title="`${host.connectionName}: ${formatPercent(host.cpuUsedPercent)}`"
              ></i>
            </div>
          </div>

          <!-- 主机热力图矩阵 (Fleet Heatmap) -->
          <header class="noc-panel__head">
            <h3>{{ $t('宿主机集群热力矩阵') }}</h3>
          </header>
          <div v-if="heatHosts.length" class="noc-heat-grid">
            <div
              v-for="host in heatHosts"
              :key="host.sshConnectionId"
              class="heat-cell"
              :class="heatClass(host)"
              :title="`${host.connectionName} (${host.host}) · CPU: ${formatPercent(host.cpuUsedPercent)}`"
            >
              <span class="heat-host-name">{{ host.connectionName }}</span>
              <strong class="heat-val">{{ formatPercent(host.cpuUsedPercent) }}</strong>
            </div>
          </div>
          <p v-else class="noc-empty">{{ $t('暂无主机矩阵') }}</p>
        </main>

        <!-- 右侧面板：吞吐排行与存储水位 -->
        <aside class="noc-panel">
          <header class="noc-panel__head">
            <h3>{{ $t('网络吞吐排行') }}</h3>
          </header>
          <ol v-if="networkRanking.length" class="noc-rank-list">
            <li v-for="(item, idx) in networkRanking" :key="item.host.sshConnectionId">
              <span class="noc-rank-num">{{ idx + 1 }}</span>
              <span class="noc-rank-name">{{ item.host.connectionName }}</span>
              <strong class="noc-rank-rate">{{ formatRate(item.total) }}</strong>
            </li>
          </ol>
          <p v-else class="noc-empty">{{ $t('暂无网络数据') }}</p>

          <header class="noc-panel__head mt-16">
            <h3>{{ $t('存储容量水位') }}</h3>
          </header>
          <ol v-if="storageWarnings.length" class="noc-rank-list">
            <li v-for="host in storageWarnings" :key="`disk-${host.sshConnectionId}`">
              <span class="noc-rank-name">{{ host.connectionName }} · {{ host.worstDisk?.path }}</span>
              <strong class="noc-rank-rate" :class="Number(host.worstDisk?.usedPercent ?? 0) >= 85 ? 'text-red' : 'text-amber'">
                {{ formatPercent(host.worstDisk?.usedPercent ?? null) }}
              </strong>
            </li>
          </ol>
          <p v-else class="noc-empty">{{ $t('暂无存储预警数据') }}</p>
        </aside>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.noc-screen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: #070d12;
  color: #e2f1ee;
  font-family: var(--font-ui);
  user-select: none;
}

/* 顶部操作条 */
.noc-header {
  min-height: 52px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #14282e;
  background: #0a131a;
}

.noc-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.noc-brand strong {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: .08em;
  color: #f1f5f9;
}

.noc-live-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
}

.noc-pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 8px #10b981;
}

.noc-exit-btn {
  padding: 6px 14px;
  border: 1px solid #1b383f;
  border-radius: 8px;
  background: transparent;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: all .16s ease;
}

.noc-exit-btn:hover {
  border-color: #10b981;
  color: #10b981;
  background: rgba(16, 185, 129, 0.08);
}

/* 主网格 */
.noc-grid {
  min-height: 0;
  display: grid;
  grid-template-columns: 20rem minmax(0, 1fr) 20rem;
  gap: 14px;
  padding: 14px;
}

.noc-panel {
  min-width: 0;
  padding: 16px;
  border: 1px solid #14282e;
  border-radius: 12px;
  background: #0c161d;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.noc-panel__head h3 {
  margin: 0;
  color: #7dd3fc;
  font-size: 11px;
  font-weight: 750;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.mt-16 { margin-top: 14px; }

/* 环形状态罗盘 */
.noc-donut {
  width: 130px;
  height: 130px;
  margin: 8px auto;
  border-radius: 50%;
  display: grid;
  place-items: center;
  box-shadow: 0 0 20px rgba(16, 185, 129, 0.15);
}

.donut-core {
  width: 90px;
  height: 90px;
  border-radius: 50%;
  background: #0c161d;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.donut-core strong {
  font-size: 24px;
  font-family: var(--font-mono);
  color: #10b981;
  line-height: 1;
}

.donut-core small {
  font-size: 9px;
  color: #64748b;
  margin-top: 2px;
}

.noc-legend {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  font-size: 11px;
  color: #94a3b8;
  padding: 8px;
  border-radius: 8px;
  background: #081016;
}

.noc-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot-green { width: 7px; height: 7px; border-radius: 50%; background: #10b981; }
.dot-red { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; }
.dot-gray { width: 7px; height: 7px; border-radius: 50%; background: #64748b; }
.dot-amber { width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; }

/* 告警流 */
.noc-alert-stream {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.noc-alert-stream li {
  padding: 8px 10px;
  border-left: 2px solid #f59e0b;
  border-radius: 0 6px 6px 0;
  background: #081016;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.alert-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alert-status { font-family: var(--font-mono); font-size: 10px; color: #f59e0b; }

/* 核心仪表卡片 */
.noc-gauges {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.gauge-card {
  padding: 14px;
  border: 1px solid #18333c;
  border-radius: 10px;
  background: #091218;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gauge-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.gauge-head small {
  font-size: 10px;
  font-weight: 750;
  color: #64748b;
  letter-spacing: .06em;
}

.gauge-card strong {
  font-size: 28px;
  font-family: var(--font-mono);
  color: #38bdf8;
  line-height: 1;
}

/* 动态波形 */
.noc-wave-box {
  padding: 10px;
  border: 1px solid #14282e;
  border-radius: 10px;
  background: #081016;
}

.noc-wave {
  height: 80px;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow: hidden;
}

.noc-wave i {
  flex: 1;
  min-width: 4px;
  border-radius: 3px 3px 0 0;
  background: #10b981;
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
  transition: height .4s ease;
}

/* 热力图网格 */
.noc-heat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(5rem, 1fr));
  gap: 6px;
}

.heat-cell {
  height: 48px;
  padding: 6px;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 10px;
  transition: transform .15s ease;
}

.heat-cell:hover {
  transform: scale(1.05);
}

.heat-host-name {
  font-size: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .85;
}

.heat-val {
  font-size: 12px;
  font-weight: 800;
}

.heat-cell.is-ok { background: #064e3b; color: #6ee7b7; border: 1px solid #059669; }
.heat-cell.is-warn { background: #78350f; color: #fde68a; border: 1px solid #d97706; }
.heat-cell.is-critical { background: #7f1d1d; color: #fecaca; border: 1px solid #dc2626; }
.heat-cell.is-down, .heat-cell.is-unknown { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }

/* 排行列表 */
.noc-rank-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.noc-rank-list li {
  padding: 7px 10px;
  border-radius: 6px;
  background: #081016;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
}

.noc-rank-num {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: #1e293b;
  color: #38bdf8;
  font-family: var(--font-mono);
  font-size: 10px;
  display: grid;
  place-items: center;
}

.noc-rank-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #cbd5e1;
}

.noc-rank-rate {
  font-family: var(--font-mono);
  color: #38bdf8;
}

.noc-empty {
  padding: 16px;
  text-align: center;
  color: #64748b;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.text-teal { color: #10b981; }
.text-purple { color: #a855f7; }
.text-amber { color: #f59e0b; }
.text-red { color: #ef4444; }

@media (max-width: 1024px) {
  .noc-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

