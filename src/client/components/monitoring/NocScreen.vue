<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleGauge,
  Cpu,
  Minimize,
  Network,
  Radio,
  Server,
  ShieldAlert,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { MonitorPlatformEventItem, MonitorPlatformEventListResponse } from "../../../shared/monitor-alerts";
import { hostPressureScore, hostPriorityState } from "../../../shared/monitoring";
import { api } from "../../api";
import type { MonitoringHostCard } from "./HostFleetPanel.vue";
import type { MonitoringProblemNode, MonitoringServiceCard } from "./ServiceApmPanel.vue";

const props = defineProps<{
  environmentId: string;
  generatedAt: string;
  refreshSeconds: number;
  summary: {
    hostTotal: number;
    hostOnline: number;
    hostOffline: number;
    hostMissing: number;
    hostStale: number;
    hostUnreachable?: number;
    hostUnchecked?: number;
    serviceTotal: number;
    avgCpuPercent: number | null;
    avgMemoryPercent: number | null;
    diskAlerts: number;
  };
  hosts: MonitoringHostCard[];
  services: MonitoringServiceCard[];
  serviceRanking: MonitoringServiceCard[];
  problemNodes: MonitoringProblemNode[];
}>();

const emit = defineEmits<{ exit: [] }>();
const root = ref<HTMLElement | null>(null);
const reducedMotion = ref(false);
const clock = ref(Date.now());
const alerts = ref<MonitorPlatformEventItem[]>([]);
const alertsLoading = ref(true);
const alertsFailed = ref(false);
const eventTotals = ref({ active: 0, critical: 0, major: 0, last24Hours: 0 });
let alertsAbort: AbortController | null = null;
let alertsTimer: number | undefined;
let clockTimer: number | undefined;

const scopeLabel = computed(() => {
  if (!props.environmentId) return "全部环境 / GLOBAL";
  return props.hosts.find((host) => host.environmentId === props.environmentId)?.environmentName
    || props.services.find((service) => service.environmentId === props.environmentId)?.environmentName
    || props.environmentId;
});
const currentDate = computed(() => new Date(clock.value).toLocaleDateString([], {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}));
const currentTime = computed(() => new Date(clock.value).toLocaleTimeString([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
}));
const generatedAge = computed(() => {
  const generated = Date.parse(props.generatedAt);
  if (!Number.isFinite(generated)) return "等待首帧";
  const seconds = Math.max(0, Math.floor((clock.value - generated) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
});

const uncheckedCount = computed(() => props.summary.hostUnchecked
  ?? props.hosts.filter((host) => host.probeState === "unchecked").length);
const unreachableCount = computed(() => props.summary.hostUnreachable
  ?? props.hosts.filter((host) => host.probeState === "unreachable").length);
const onlineRate = computed(() => ratio(props.summary.hostOnline, props.summary.hostTotal));
const probeCoverageRate = computed(() => ratio(
  Math.max(0, props.summary.hostTotal - props.summary.hostMissing - uncheckedCount.value),
  props.summary.hostTotal,
));
const deploymentTotal = computed(() => props.services.reduce((sum, service) => sum + service.deploymentCount, 0));
const runningTotal = computed(() => props.services.reduce((sum, service) => sum + service.runningCount, 0));
const deploymentRate = computed(() => ratio(runningTotal.value, deploymentTotal.value));
const totalNetworkRate = computed(() => props.hosts.reduce((sum, host) => sum
  + Number(host.networkReceiveBytesPerSecond ?? 0)
  + Number(host.networkTransmitBytesPerSecond ?? 0), 0));

const hostStates = computed(() => [
  { key: "online", label: "采集在线", count: props.summary.hostOnline, tone: "healthy" },
  { key: "offline", label: "探针离线", count: props.summary.hostOffline, tone: "critical" },
  { key: "unreachable", label: "连接异常", count: unreachableCount.value, tone: "major" },
  { key: "stale", label: "数据陈旧", count: props.summary.hostStale, tone: "warning" },
  { key: "missing", label: "未装探针", count: props.summary.hostMissing + uncheckedCount.value, tone: "muted" },
]);
const rankedHosts = computed(() => props.hosts
  .map((host) => {
    const score = hostPressureScore(host);
    return { host, score, state: hostPriorityState(host, score) };
  })
  .sort((left, right) => right.score - left.score
    || left.host.connectionName.localeCompare(right.host.connectionName, "zh")));
const fleetHosts = computed(() => rankedHosts.value.slice(0, 48));
const pressureHosts = computed(() => rankedHosts.value
  .filter(({ host }) => !["missing", "unchecked"].includes(host.probeState))
  .slice(0, 5));
const networkRanking = computed(() => props.hosts
  .filter((host) => !host.missing)
  .map((host) => ({
    host,
    receive: Number(host.networkReceiveBytesPerSecond ?? 0),
    transmit: Number(host.networkTransmitBytesPerSecond ?? 0),
    total: Number(host.networkReceiveBytesPerSecond ?? 0) + Number(host.networkTransmitBytesPerSecond ?? 0),
  }))
  .sort((left, right) => right.total - left.total)
  .slice(0, 3));
const storageRanking = computed(() => props.hosts
  .filter((host) => !host.missing && host.worstDisk?.usedPercent != null)
  .sort((left, right) => Number(right.worstDisk?.usedPercent ?? 0) - Number(left.worstDisk?.usedPercent ?? 0))
  .slice(0, 3));
const serviceRiskRanking = computed(() => {
  const source = props.serviceRanking.length ? props.serviceRanking : props.services;
  return [...source].sort((left, right) => serviceRiskScore(right) - serviceRiskScore(left)
    || left.name.localeCompare(right.name, "zh")).slice(0, 6);
});
const activeEventItems = computed(() => alerts.value.filter((alert) => alert.status === "active").slice(0, 6));
const displayedEvents = computed(() => activeEventItems.value.length ? activeEventItems.value : alerts.value.slice(0, 6));

function ratio(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : null;
}

function clampPercent(value: number | null | undefined) {
  return Math.min(100, Math.max(0, Number(value ?? 0)));
}

function formatPercent(value: number | null | undefined, digits = 0) {
  return value == null ? "—" : `${value.toFixed(digits)}%`;
}

function formatRate(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB/s`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}

function serviceRiskScore(service: MonitoringServiceCard) {
  const severity = { critical: 80, major: 55, warning: 30, info: 10 }[service.activeAlertPeakSeverity ?? "info"];
  const unavailable = Math.max(0, service.deploymentCount - service.runningCount) * 18;
  return severity + unavailable + (service.activeAlertCount ?? 0) * 8 + service.problemCount * 10
    + Math.min(20, Number(service.cpuUsedPercent ?? 0) / 5);
}

function serviceTone(service: MonitoringServiceCard) {
  if (service.activeAlertPeakSeverity === "critical"
    || (service.runningCount === 0 && service.deploymentCount > 0)) return "critical";
  if (service.activeAlertPeakSeverity === "major"
    || service.problemCount > 0
    || service.runningCount < service.deploymentCount) return "major";
  if (service.activeAlertPeakSeverity === "warning") return "warning";
  return "healthy";
}

function hostStateLabel(host: MonitoringHostCard) {
  if (host.probeState === "offline") return "OFFLINE";
  if (host.probeState === "unreachable") return "UNREACH";
  if (host.probeState === "stale") return "STALE";
  if (host.probeState === "missing") return "NO PROBE";
  if (host.probeState === "unchecked") return "UNCHECKED";
  return "ONLINE";
}

function alertTarget(alert: MonitorPlatformEventItem) {
  return alert.serviceName || alert.connectionName || alert.targetName;
}

function alertTime(alert: MonitorPlatformEventItem) {
  return new Date(alert.lastSeenAt || alert.triggeredAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function eventQuery(from: number, to: number, options: { status?: string; severity?: string; pageSize: number }) {
  const query = new URLSearchParams({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    status: options.status ?? "all",
    severity: options.severity ?? "all",
    order: "recent",
    page: "1",
    pageSize: String(options.pageSize),
  });
  if (props.environmentId) query.set("environmentId", props.environmentId);
  return query;
}

async function loadAlertEvents() {
  alertsAbort?.abort();
  alertsAbort = new AbortController();
  const controller = alertsAbort;
  alertsLoading.value = true;
  alertsFailed.value = false;
  const to = Date.now();
  const from = to - 24 * 60 * 60 * 1000;
  const request = (options: { status?: string; severity?: string; pageSize: number }) => api<MonitorPlatformEventListResponse>(
    `/api/v1/monitoring/events?${eventQuery(from, to, options)}`,
    { signal: controller.signal },
  );
  const results = await Promise.allSettled([
    request({ pageSize: 12 }),
    request({ status: "active", pageSize: 1 }),
    request({ status: "active", severity: "critical", pageSize: 1 }),
    request({ status: "active", severity: "major", pageSize: 1 }),
  ]);
  if (controller.signal.aborted) return;
  const [recent, active, critical, major] = results;
  if (recent?.status === "fulfilled") {
    alerts.value = recent.value.items;
    eventTotals.value.last24Hours = recent.value.total;
  }
  if (active?.status === "fulfilled") eventTotals.value.active = active.value.total;
  if (critical?.status === "fulfilled") eventTotals.value.critical = critical.value.total;
  if (major?.status === "fulfilled") eventTotals.value.major = major.value.total;
  alertsFailed.value = results.every((result) => result.status === "rejected") && alerts.value.length === 0;
  if (alertsAbort === controller) alertsLoading.value = false;
}

function stopAlertRefresh() {
  if (alertsTimer === undefined) return;
  window.clearInterval(alertsTimer);
  alertsTimer = undefined;
}

function startAlertRefresh() {
  stopAlertRefresh();
  if (!props.refreshSeconds) return;
  alertsTimer = window.setInterval(() => {
    if (!document.hidden) void loadAlertEvents();
  }, props.refreshSeconds * 1000);
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
  clockTimer = window.setInterval(() => { clock.value = Date.now(); }, 1000);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("keydown", onKeydown);
  void loadAlertEvents();
  startAlertRefresh();
  void enterFullscreen();
});
watch(() => props.environmentId, () => void loadAlertEvents());
watch(() => props.refreshSeconds, () => startAlertRefresh());
onBeforeUnmount(() => {
  stopAlertRefresh();
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  alertsAbort?.abort();
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("keydown", onKeydown);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
});
</script>

<template>
  <Teleport to="body">
    <section ref="root" class="noc-screen" :class="{ 'is-reduced': reducedMotion }" role="dialog" aria-label="NOC Operations Center">
      <header class="noc-command-bar">
        <div class="noc-identity">
          <span class="noc-identity__mark"><Radio :size="20" /></span>
          <div>
            <strong>VIRON / NETWORK OPERATIONS</strong>
            <small>REAL-TIME INFRASTRUCTURE COMMAND CENTER</small>
          </div>
        </div>
        <div class="noc-command-meta">
          <span><i>DATA SCOPE</i><b>{{ scopeLabel }}</b></span>
          <span><i>LAST FRAME</i><b>{{ generatedAge }}</b></span>
          <span class="noc-live-state" :class="{ 'is-paused': !refreshSeconds }"><i></i><b>{{ refreshSeconds ? `LIVE / ${refreshSeconds}S` : 'PAUSED' }}</b></span>
        </div>
        <div class="noc-clock">
          <span>{{ currentDate }}</span>
          <strong>{{ currentTime }}</strong>
          <button type="button" :aria-label="$t('退出全屏')" @click="emit('exit')"><Minimize :size="15" /> ESC</button>
        </div>
      </header>

      <section class="noc-kpi-rail" aria-label="关键运行指标">
        <article class="noc-kpi is-primary">
          <span class="noc-kpi__icon"><CircleGauge :size="19" /></span>
          <div><small>HOST READINESS / 主机在线率</small><strong>{{ onlineRate == null ? '—' : `${onlineRate}%` }}</strong></div>
          <em>{{ summary.hostOnline }} / {{ summary.hostTotal }} ONLINE</em>
        </article>
        <article class="noc-kpi">
          <span class="noc-kpi__icon"><Radio :size="19" /></span>
          <div><small>PROBE COVERAGE / 探针覆盖</small><strong>{{ probeCoverageRate == null ? '—' : `${probeCoverageRate}%` }}</strong></div>
          <em>{{ summary.hostMissing + uncheckedCount }} HOSTS UNMANAGED</em>
        </article>
        <article class="noc-kpi">
          <span class="noc-kpi__icon"><Boxes :size="19" /></span>
          <div><small>DEPLOYMENT READY / 部署就绪</small><strong>{{ deploymentRate == null ? '—' : `${deploymentRate}%` }}</strong></div>
          <em>{{ runningTotal }} / {{ deploymentTotal }} RUNNING</em>
        </article>
        <article class="noc-kpi" :class="{ 'is-danger': eventTotals.critical > 0 }">
          <span class="noc-kpi__icon"><ShieldAlert :size="19" /></span>
          <div><small>ACTIVE INCIDENTS / 活动告警</small><strong>{{ eventTotals.active }}</strong></div>
          <em>{{ eventTotals.critical }} CRITICAL · {{ eventTotals.major }} MAJOR</em>
        </article>
        <article class="noc-kpi">
          <span class="noc-kpi__icon"><Activity :size="19" /></span>
          <div><small>EVENTS / 24H 系统事件</small><strong>{{ eventTotals.last24Hours }}</strong></div>
          <em>SYSTEM HISTORY · NOT PERSONAL INBOX</em>
        </article>
      </section>

      <div class="noc-operations-grid">
        <aside class="noc-column noc-column--situation">
          <section class="noc-module noc-readiness-module">
            <header class="noc-module__header"><span><Server :size="15" /> FLEET READINESS</span><code>01 / HOSTS</code></header>
            <div class="noc-readiness">
              <div class="noc-readiness__dial"><div><strong>{{ onlineRate == null ? '—' : onlineRate }}</strong><small>% ONLINE</small></div></div>
              <div class="noc-readiness__copy">
                <small>已纳管 {{ Math.max(0, summary.hostTotal - summary.hostMissing - uncheckedCount) }} / {{ summary.hostTotal }}</small>
                <strong :class="(onlineRate ?? 0) >= 90 ? 'is-good' : 'is-warn'">
                  {{ summary.hostTotal === 0 ? 'NO HOST DATA' : (onlineRate ?? 0) >= 90 ? 'FLEET NOMINAL' : 'ATTENTION REQUIRED' }}
                </strong>
              </div>
            </div>
            <div class="noc-state-table">
              <div v-for="state in hostStates" :key="state.key" :class="`is-${state.tone}`">
                <i></i><span>{{ state.label }}</span><b>{{ state.count }}</b><em>{{ summary.hostTotal ? Math.round(state.count / summary.hostTotal * 100) : 0 }}%</em>
              </div>
            </div>
          </section>

          <section class="noc-module noc-event-module">
            <header class="noc-module__header"><span><AlertTriangle :size="15" /> INCIDENT STREAM</span><code>{{ eventTotals.active }} ACTIVE</code></header>
            <ol v-if="displayedEvents.length" class="noc-event-stream" aria-live="polite">
              <li v-for="alert in displayedEvents" :key="alert.id" :class="`is-${alert.peakSeverity}`">
                <span class="noc-event__severity">{{ alert.peakSeverity.slice(0, 4).toUpperCase() }}</span>
                <div><strong>{{ alertTarget(alert) }}</strong><small>{{ alert.environmentName }} · {{ alert.ruleType }}</small></div>
                <time>{{ alertTime(alert) }}</time>
              </li>
            </ol>
            <div v-else-if="alertsLoading" class="noc-empty-state is-compact"><Activity :size="18" /><span>正在同步系统事件中心</span></div>
            <div v-else-if="alertsFailed" class="noc-empty-state is-compact is-error"><AlertTriangle :size="18" /><span>事件中心暂时不可达</span></div>
            <div v-else class="noc-empty-state is-compact is-success"><CheckCircle2 :size="18" /><span>当前范围无系统告警事件</span></div>
          </section>
        </aside>

        <main class="noc-column noc-column--fleet">
          <section class="noc-module noc-fleet-module">
            <header class="noc-module__header noc-module__header--large">
              <div><span><Activity :size="16" /> LIVE HOST MATRIX</span><small>颜色表示风险状态；数值均为最新采集快照，不代表历史趋势</small></div>
              <code>{{ fleetHosts.length }} VISIBLE / {{ summary.hostTotal }} TOTAL</code>
            </header>
            <div v-if="fleetHosts.length" class="noc-host-matrix">
              <article v-for="item in fleetHosts" :key="item.host.sshConnectionId" class="noc-host-tile" :class="`is-${item.state}`" :title="`${item.host.connectionName} · ${item.host.host}`">
                <header><i></i><strong>{{ item.host.connectionName }}</strong><small>{{ hostStateLabel(item.host) }}</small></header>
                <div class="noc-host-address">{{ item.host.host }}</div>
                <dl>
                  <div><dt>CPU</dt><dd>{{ formatPercent(item.host.cpuUsedPercent) }}</dd></div>
                  <div><dt>MEM</dt><dd>{{ formatPercent(item.host.memoryUsedPercent) }}</dd></div>
                  <div><dt>DSK</dt><dd>{{ formatPercent(item.host.diskUsedPercent) }}</dd></div>
                </dl>
                <div class="noc-pressure-meter"><i :style="{ width: `${item.score}%` }"></i></div>
              </article>
            </div>
            <div v-else class="noc-empty-state noc-empty-state--hero">
              <Radio :size="28" /><strong>NO TELEMETRY LINK</strong>
              <span>当前环境尚无主机监控快照。安装并运行 viron-monitor 后，这里会显示实时舰队矩阵。</span>
            </div>
          </section>

          <section class="noc-module noc-pressure-module">
            <header class="noc-module__header"><span><Cpu :size="15" /> RESOURCE PRESSURE / LATEST SNAPSHOT</span><code>TOP {{ pressureHosts.length }}</code></header>
            <div v-if="pressureHosts.length" class="noc-pressure-table">
              <article v-for="(item, index) in pressureHosts" :key="`pressure-${item.host.sshConnectionId}`">
                <span class="noc-rank">0{{ index + 1 }}</span>
                <div class="noc-pressure-identity"><strong>{{ item.host.connectionName }}</strong><small>{{ item.host.environmentName }}</small></div>
                <div class="noc-pressure-bar is-cpu"><span>CPU</span><i><b :style="{ width: `${clampPercent(item.host.cpuUsedPercent)}%` }"></b></i><em>{{ formatPercent(item.host.cpuUsedPercent) }}</em></div>
                <div class="noc-pressure-bar is-memory"><span>MEM</span><i><b :style="{ width: `${clampPercent(item.host.memoryUsedPercent)}%` }"></b></i><em>{{ formatPercent(item.host.memoryUsedPercent) }}</em></div>
                <div class="noc-pressure-bar is-disk"><span>DSK</span><i><b :style="{ width: `${clampPercent(item.host.diskUsedPercent)}%` }"></b></i><em>{{ formatPercent(item.host.diskUsedPercent) }}</em></div>
                <strong class="noc-pressure-score">{{ item.score }}</strong>
              </article>
            </div>
            <div v-else class="noc-empty-state is-compact"><CircleGauge :size="18" /><span>暂无可计算资源压力的主机快照</span></div>
          </section>
        </main>

        <aside class="noc-column noc-column--services">
          <section class="noc-module noc-service-module">
            <header class="noc-module__header"><span><Boxes :size="15" /> SERVICE CONTROL</span><code>{{ summary.serviceTotal }} SERVICES</code></header>
            <div class="noc-service-summary">
              <div><small>RUNNING</small><strong>{{ runningTotal }}</strong></div>
              <div><small>EXPECTED</small><strong>{{ deploymentTotal }}</strong></div>
              <div><small>PROBLEM NODES</small><strong :class="{ 'is-alert': problemNodes.length > 0 }">{{ problemNodes.length }}</strong></div>
            </div>
            <ol v-if="serviceRiskRanking.length" class="noc-service-list">
              <li v-for="service in serviceRiskRanking" :key="service.id" :class="`is-${serviceTone(service)}`">
                <i></i><div><strong>{{ service.name }}</strong><small>{{ service.environmentName }}</small></div>
                <span><b>{{ service.runningCount }}/{{ service.deploymentCount }}</b><small>READY</small></span>
                <span><b>{{ formatPercent(service.cpuUsedPercent) }}</b><small>CPU</small></span>
                <em v-if="service.activeAlertCount">{{ service.activeAlertCount }} ALERT</em>
              </li>
            </ol>
            <div v-else class="noc-empty-state is-compact"><Boxes :size="18" /><span>当前范围暂无服务部署数据</span></div>
          </section>

          <section class="noc-module noc-io-module">
            <header class="noc-module__header"><span><Network :size="15" /> DATA PLANE</span><code>{{ formatRate(totalNetworkRate) }}</code></header>
            <div class="noc-io-section">
              <h4>NETWORK THROUGHPUT <span>RX + TX</span></h4>
              <ol v-if="networkRanking.length" class="noc-io-list">
                <li v-for="(item, index) in networkRanking" :key="`network-${item.host.sshConnectionId}`"><b>0{{ index + 1 }}</b><span>{{ item.host.connectionName }}</span><em>{{ formatRate(item.total) }}</em></li>
              </ol>
              <p v-else>暂无网络吞吐采样</p>
            </div>
            <div class="noc-io-section">
              <h4>STORAGE WATERLINE <span>HIGHEST USED</span></h4>
              <ol v-if="storageRanking.length" class="noc-io-list">
                <li v-for="(host, index) in storageRanking" :key="`storage-${host.sshConnectionId}`"><b>0{{ index + 1 }}</b><span>{{ host.connectionName }} · {{ host.worstDisk?.path }}</span><em :class="{ 'is-alert': Number(host.worstDisk?.usedPercent ?? 0) >= 85 }">{{ formatPercent(host.worstDisk?.usedPercent) }}</em></li>
              </ol>
              <p v-else>暂无存储水位采样</p>
            </div>
          </section>
        </aside>
      </div>

      <footer class="noc-status-line">
        <span><i></i> DATA SOURCE / MONITORING OVERVIEW + SYSTEM EVENT CENTER</span>
        <span>CPU {{ formatPercent(summary.avgCpuPercent, 1) }} AVG</span>
        <span>MEM {{ formatPercent(summary.avgMemoryPercent, 1) }} AVG</span>
        <span>DISK {{ summary.diskAlerts }} ALERTS</span>
        <span>FRAME {{ generatedAt ? new Date(generatedAt).toLocaleString() : '—' }}</span>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
.noc-screen {
  --noc-bg: #05090d;
  --noc-panel: #091117;
  --noc-panel-strong: #0c171e;
  --noc-line: #1b3038;
  --noc-line-strong: #294650;
  --noc-text: #dce9e6;
  --noc-muted: #6e8588;
  --noc-mint: #53e3b3;
  --noc-cyan: #5cc8e8;
  --noc-amber: #f3b955;
  --noc-orange: #f27a45;
  --noc-red: #ff5d62;
  position: fixed;
  inset: 0;
  z-index: 9999;
  min-width: 960px;
  min-height: 640px;
  padding: 0 16px;
  overflow: hidden;
  background: var(--noc-bg);
  color: var(--noc-text);
  display: grid;
  grid-template-rows: 66px 104px minmax(0, 1fr) 34px;
  font-family: var(--font-ui);
  user-select: none;
}
.noc-screen::before { content: ""; position: fixed; inset: 0; z-index: -1; border: 1px solid #102027; pointer-events: none; }
.noc-screen::after { content: ""; position: fixed; top: 66px; left: 16px; z-index: -1; width: 72px; height: 2px; background: var(--noc-mint); box-shadow: 0 0 18px rgba(83, 227, 179, .55); pointer-events: none; }

.noc-command-bar { min-width: 0; border-bottom: 1px solid var(--noc-line); display: grid; grid-template-columns: minmax(280px, 1fr) auto minmax(260px, 1fr); align-items: center; gap: 24px; }
.noc-identity, .noc-command-meta, .noc-clock, .noc-command-meta > span, .noc-live-state { display: flex; align-items: center; }
.noc-identity { gap: 11px; }
.noc-identity__mark { width: 36px; height: 36px; border: 1px solid var(--noc-line-strong); color: var(--noc-mint); display: grid; place-items: center; }
.noc-identity > div { display: flex; flex-direction: column; gap: 2px; }
.noc-identity strong { font-family: var(--font-mono); font-size: 13px; letter-spacing: .09em; }
.noc-identity small { color: var(--noc-muted); font-family: var(--font-mono); font-size: 8px; letter-spacing: .18em; }
.noc-command-meta { align-self: stretch; }
.noc-command-meta > span { height: 100%; min-width: 132px; padding: 0 18px; border-left: 1px solid var(--noc-line); flex-direction: column; align-items: flex-start; justify-content: center; gap: 3px; }
.noc-command-meta > span:last-child { border-right: 1px solid var(--noc-line); }
.noc-command-meta i { color: #52676b; font-family: var(--font-mono); font-size: 8px; font-style: normal; letter-spacing: .14em; }
.noc-command-meta b { max-width: 180px; overflow: hidden; color: #b8cbc8; font-family: var(--font-mono); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.noc-command-meta .noc-live-state { flex-direction: row; gap: 8px; }
.noc-live-state > i { width: 6px; height: 6px; background: var(--noc-mint); box-shadow: 0 0 10px var(--noc-mint); animation: noc-pulse 1.8s ease-in-out infinite; }
.noc-live-state.is-paused > i { background: var(--noc-amber); box-shadow: none; animation: none; }
.noc-live-state.is-paused b { color: var(--noc-amber); }
.noc-clock { justify-content: flex-end; gap: 12px; }
.noc-clock > span { color: var(--noc-muted); font-family: var(--font-mono); font-size: 10px; }
.noc-clock > strong { min-width: 84px; color: #f4fbf9; font-family: var(--font-mono); font-size: 18px; letter-spacing: .04em; }
.noc-clock button { height: 30px; padding: 0 11px; border: 1px solid var(--noc-line-strong); border-radius: 0; background: transparent; color: var(--noc-muted); display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-family: var(--font-mono); font-size: 9px; }
.noc-clock button:hover { border-color: var(--noc-mint); color: var(--noc-mint); }

.noc-kpi-rail { min-width: 0; padding: 13px 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.noc-kpi { min-width: 0; padding: 10px 12px; border: 1px solid var(--noc-line); border-top: 2px solid #2f4a52; background: var(--noc-panel); display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.noc-kpi.is-primary { border-top-color: var(--noc-mint); }
.noc-kpi.is-danger { border-top-color: var(--noc-red); }
.noc-kpi__icon { color: var(--noc-cyan); }
.noc-kpi.is-primary .noc-kpi__icon { color: var(--noc-mint); }
.noc-kpi.is-danger .noc-kpi__icon { color: var(--noc-red); }
.noc-kpi > div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.noc-kpi small { overflow: hidden; color: var(--noc-muted); font-family: var(--font-mono); font-size: 8px; letter-spacing: .08em; text-overflow: ellipsis; white-space: nowrap; }
.noc-kpi strong { color: #eaf6f3; font-family: var(--font-mono); font-size: clamp(21px, 1.8vw, 30px); line-height: 1; }
.noc-kpi em { align-self: end; color: #5f7478; font-family: var(--font-mono); font-size: 7px; font-style: normal; letter-spacing: .08em; white-space: nowrap; }

.noc-operations-grid { min-height: 0; padding-bottom: 10px; display: grid; grid-template-columns: minmax(260px, .78fr) minmax(500px, 1.65fr) minmax(290px, .92fr); gap: 8px; }
.noc-column { min-width: 0; min-height: 0; display: grid; gap: 8px; }
.noc-column--situation { grid-template-rows: minmax(240px, .88fr) minmax(250px, 1.12fr); }
.noc-column--fleet { grid-template-rows: minmax(350px, 1.45fr) minmax(190px, .55fr); }
.noc-column--services { grid-template-rows: minmax(330px, 1.2fr) minmax(220px, .8fr); }
.noc-module { min-width: 0; min-height: 0; border: 1px solid var(--noc-line); background: var(--noc-panel); overflow: hidden; display: flex; flex-direction: column; }
.noc-module__header { min-height: 38px; padding: 0 12px; border-bottom: 1px solid var(--noc-line); background: var(--noc-panel-strong); display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: none; }
.noc-module__header > span, .noc-module__header > div > span { display: flex; align-items: center; gap: 7px; color: #b7cdca; font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: .12em; }
.noc-module__header svg { color: var(--noc-mint); }
.noc-module__header code { color: #536b6e; font-family: var(--font-mono); font-size: 8px; letter-spacing: .08em; white-space: nowrap; }
.noc-module__header--large { min-height: 48px; }
.noc-module__header--large > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.noc-module__header--large > div > small { overflow: hidden; color: #53686b; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }

.noc-readiness { padding: 16px 14px 12px; display: flex; align-items: center; gap: 16px; }
.noc-readiness__dial { position: relative; width: 92px; height: 92px; flex: none; border: 1px solid #274149; border-top: 5px solid var(--noc-mint); border-right: 5px solid var(--noc-mint); border-radius: 50%; box-shadow: 0 0 14px rgba(83, 227, 179, .12); display: grid; place-items: center; }
.noc-readiness__dial::after { content: ""; position: absolute; inset: 6px; border: 1px solid #1c343b; border-radius: 50%; }
.noc-readiness__dial > div { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; }
.noc-readiness__dial strong { color: #e6f5f1; font-family: var(--font-mono); font-size: 26px; line-height: 1; }
.noc-readiness__dial small { margin-top: 5px; color: var(--noc-muted); font-family: var(--font-mono); font-size: 7px; letter-spacing: .12em; }
.noc-readiness__copy { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.noc-readiness__copy small { color: var(--noc-muted); font-size: 10px; }
.noc-readiness__copy strong { color: var(--noc-amber); font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; }
.noc-readiness__copy strong.is-good { color: var(--noc-mint); }
.noc-state-table { padding: 0 12px 12px; display: grid; gap: 4px; }
.noc-state-table > div { min-height: 26px; padding: 0 7px; border-bottom: 1px solid #14242a; display: grid; grid-template-columns: 8px 1fr 32px 32px; align-items: center; gap: 6px; }
.noc-state-table i { width: 5px; height: 5px; background: var(--noc-muted); }
.noc-state-table span { color: #8ea3a3; font-size: 10px; }
.noc-state-table b, .noc-state-table em { font-family: var(--font-mono); font-size: 10px; font-style: normal; text-align: right; }
.noc-state-table em { color: #52676a; }
.noc-state-table .is-healthy i { background: var(--noc-mint); }
.noc-state-table .is-healthy b { color: var(--noc-mint); }
.noc-state-table .is-critical i { background: var(--noc-red); }
.noc-state-table .is-critical b { color: var(--noc-red); }
.noc-state-table .is-major i { background: var(--noc-orange); }
.noc-state-table .is-major b { color: var(--noc-orange); }
.noc-state-table .is-warning i { background: var(--noc-amber); }
.noc-state-table .is-warning b { color: var(--noc-amber); }

.noc-event-stream, .noc-service-list, .noc-io-list { margin: 0; padding: 0; list-style: none; }
.noc-event-stream { min-height: 0; overflow: auto; display: grid; grid-auto-rows: minmax(52px, 1fr); flex: 1; }
.noc-event-stream li { min-height: 52px; padding: 8px 10px; border-bottom: 1px solid #14242a; display: grid; grid-template-columns: 37px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.noc-event__severity { padding: 3px 4px; border: 1px solid currentColor; color: var(--noc-amber); font-family: var(--font-mono); font-size: 7px; text-align: center; }
.noc-event-stream li.is-critical .noc-event__severity { color: var(--noc-red); }
.noc-event-stream li.is-major .noc-event__severity { color: var(--noc-orange); }
.noc-event-stream li.is-info .noc-event__severity { color: var(--noc-cyan); }
.noc-event-stream li > div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.noc-event-stream strong { overflow: hidden; color: #cbd9d7; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.noc-event-stream small { overflow: hidden; color: #53696c; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.noc-event-stream time { color: #657b7e; font-family: var(--font-mono); font-size: 8px; }

.noc-host-matrix { min-height: 0; padding: 8px; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); grid-auto-rows: minmax(88px, 1fr); gap: 5px; flex: 1; }
.noc-host-tile { position: relative; min-width: 0; min-height: 88px; padding: 8px; border: 1px solid #1b343b; border-left: 2px solid var(--noc-mint); background: #081318; overflow: hidden; }
.noc-host-tile::after { content: ""; position: absolute; top: 0; right: 0; width: 12px; height: 1px; background: #36535a; }
.noc-host-tile.is-warning { border-left-color: var(--noc-amber); }
.noc-host-tile.is-critical, .noc-host-tile.is-offline { border-left-color: var(--noc-red); background: #141014; }
.noc-host-tile.is-unmanaged { border-left-color: #475c60; }
.noc-host-tile header { min-width: 0; display: grid; grid-template-columns: 5px minmax(0, 1fr) auto; align-items: center; gap: 5px; }
.noc-host-tile header > i { width: 4px; height: 4px; background: var(--noc-mint); box-shadow: 0 0 7px var(--noc-mint); }
.noc-host-tile.is-warning header > i { background: var(--noc-amber); box-shadow: none; }
.noc-host-tile.is-critical header > i, .noc-host-tile.is-offline header > i { background: var(--noc-red); box-shadow: 0 0 7px var(--noc-red); }
.noc-host-tile.is-unmanaged header > i { background: #52686c; box-shadow: none; }
.noc-host-tile header strong { overflow: hidden; color: #d5e4e1; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.noc-host-tile header small { color: #5f7779; font-family: var(--font-mono); font-size: 6px; }
.noc-host-address { margin: 6px 0 7px; overflow: hidden; color: #4d6468; font-family: var(--font-mono); font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }
.noc-host-tile dl { margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.noc-host-tile dl > div { min-width: 0; }
.noc-host-tile dt { color: #52696c; font-family: var(--font-mono); font-size: 6px; }
.noc-host-tile dd { margin: 2px 0 0; color: #a9bdb9; font-family: var(--font-mono); font-size: 9px; }
.noc-pressure-meter { height: 2px; margin-top: 8px; background: #17282e; }
.noc-pressure-meter i { display: block; height: 100%; background: var(--noc-mint); }
.noc-host-tile.is-warning .noc-pressure-meter i { background: var(--noc-amber); }
.noc-host-tile.is-critical .noc-pressure-meter i, .noc-host-tile.is-offline .noc-pressure-meter i { background: var(--noc-red); }

.noc-pressure-table { min-height: 0; overflow: auto; }
.noc-pressure-table article { min-height: 38px; padding: 4px 10px; border-bottom: 1px solid #14242a; display: grid; grid-template-columns: 24px minmax(100px, .9fr) repeat(3, minmax(92px, 1fr)) 30px; align-items: center; gap: 8px; }
.noc-rank { color: #41595d; font-family: var(--font-mono); font-size: 9px; }
.noc-pressure-identity { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.noc-pressure-identity strong, .noc-pressure-identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.noc-pressure-identity strong { color: #b9ccca; font-size: 9px; }
.noc-pressure-identity small { color: #50676a; font-size: 7px; }
.noc-pressure-bar { display: grid; grid-template-columns: 22px minmax(25px, 1fr) 28px; align-items: center; gap: 4px; }
.noc-pressure-bar > span, .noc-pressure-bar > em { color: #5e7477; font-family: var(--font-mono); font-size: 7px; font-style: normal; }
.noc-pressure-bar > em { text-align: right; }
.noc-pressure-bar > i { height: 3px; background: #17282e; }
.noc-pressure-bar > i > b { display: block; height: 100%; background: var(--noc-cyan); }
.noc-pressure-bar.is-memory > i > b { background: var(--noc-mint); }
.noc-pressure-bar.is-disk > i > b { background: var(--noc-amber); }
.noc-pressure-score { color: #90aaa6; font-family: var(--font-mono); font-size: 12px; text-align: right; }

.noc-service-summary { height: 65px; padding: 9px 10px; border-bottom: 1px solid #14242a; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.noc-service-summary > div { padding-left: 8px; border-left: 1px solid #263d44; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.noc-service-summary small { color: #52696c; font-family: var(--font-mono); font-size: 7px; letter-spacing: .08em; }
.noc-service-summary strong { color: #d7e6e3; font-family: var(--font-mono); font-size: 18px; line-height: 1; }
.noc-service-summary strong.is-alert { color: var(--noc-red); }
.noc-service-list { min-height: 0; overflow: auto; display: grid; grid-auto-rows: minmax(48px, 1fr); flex: 1; }
.noc-service-list li { min-height: 48px; padding: 7px 9px; border-bottom: 1px solid #14242a; display: grid; grid-template-columns: 6px minmax(0, 1fr) 38px 42px auto; align-items: center; gap: 7px; }
.noc-service-list li > i { width: 5px; height: 22px; background: var(--noc-mint); }
.noc-service-list li.is-warning > i { background: var(--noc-amber); }
.noc-service-list li.is-major > i { background: var(--noc-orange); }
.noc-service-list li.is-critical > i { background: var(--noc-red); }
.noc-service-list li > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.noc-service-list li > div strong, .noc-service-list li > div small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.noc-service-list li > div strong { color: #c5d7d4; font-size: 10px; }
.noc-service-list li > div small { color: #50676a; font-size: 7px; }
.noc-service-list li > span { display: flex; flex-direction: column; gap: 2px; }
.noc-service-list li > span b { color: #9cb2ae; font-family: var(--font-mono); font-size: 10px; }
.noc-service-list li > span small { color: #4d6266; font-family: var(--font-mono); font-size: 6px; }
.noc-service-list li > em { padding: 3px 4px; border: 1px solid #583d31; color: var(--noc-orange); font-family: var(--font-mono); font-size: 6px; font-style: normal; white-space: nowrap; }

.noc-io-section { min-height: 0; padding: 8px 10px 4px; border-bottom: 1px solid #14242a; flex: 1; }
.noc-io-section:last-child { border-bottom: 0; }
.noc-io-section h4 { margin: 0 0 5px; color: #8ca2a1; display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 7px; letter-spacing: .08em; }
.noc-io-section h4 span { color: #465e61; font-size: 6px; }
.noc-io-list li { min-height: 24px; border-top: 1px solid #132329; display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.noc-io-list b { color: #40585c; font-family: var(--font-mono); font-size: 7px; }
.noc-io-list span { overflow: hidden; color: #839997; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.noc-io-list em { color: var(--noc-cyan); font-family: var(--font-mono); font-size: 8px; font-style: normal; }
.noc-io-list em.is-alert { color: var(--noc-red); }
.noc-io-section p { margin: 12px 0; color: #4b6265; font-size: 8px; text-align: center; }

.noc-empty-state { min-height: 0; padding: 18px; color: #597075; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; text-align: center; flex: 1; }
.noc-empty-state strong { color: #819896; font-family: var(--font-mono); font-size: 12px; letter-spacing: .12em; }
.noc-empty-state span { max-width: 360px; font-size: 10px; line-height: 1.6; }
.noc-empty-state.is-compact { min-height: 70px; flex-direction: row; font-size: 10px; }
.noc-empty-state.is-success { color: var(--noc-mint); }
.noc-empty-state.is-error { color: var(--noc-red); }
.noc-empty-state--hero { border: 1px dashed #1f343b; margin: 12px; }

.noc-status-line { min-width: 0; border-top: 1px solid var(--noc-line); color: #536a6d; display: flex; align-items: center; justify-content: space-between; gap: 16px; font-family: var(--font-mono); font-size: 7px; letter-spacing: .08em; }
.noc-status-line span { white-space: nowrap; }
.noc-status-line span:first-child { display: flex; align-items: center; gap: 7px; color: #78918e; }
.noc-status-line i { width: 5px; height: 5px; background: var(--noc-mint); }

@keyframes noc-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
.is-reduced *, .is-reduced *::before, .is-reduced *::after { animation: none !important; transition: none !important; }

@media (max-width: 1280px) {
  .noc-screen { padding: 0 10px; grid-template-rows: 58px 94px minmax(0, 1fr) 30px; }
  .noc-screen::after { top: 58px; left: 10px; }
  .noc-command-meta > span { min-width: 108px; padding: 0 10px; }
  .noc-command-meta > span:nth-child(2) { display: none; }
  .noc-kpi { padding: 8px; grid-template-columns: 22px minmax(0, 1fr); }
  .noc-kpi em { display: none; }
  .noc-operations-grid { grid-template-columns: minmax(230px, .7fr) minmax(440px, 1.55fr) minmax(250px, .8fr); }
  .noc-host-matrix { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
  .noc-pressure-table article { grid-template-columns: 20px minmax(90px, .8fr) repeat(3, minmax(70px, 1fr)) 26px; gap: 5px; }
}
@media (max-height: 760px) {
  .noc-screen { grid-template-rows: 52px 84px minmax(0, 1fr) 28px; }
  .noc-screen::after { top: 52px; }
  .noc-kpi-rail { padding: 9px 0; }
  .noc-column--situation { grid-template-rows: minmax(210px, .9fr) minmax(190px, 1.1fr); }
  .noc-column--fleet { grid-template-rows: minmax(300px, 1.5fr) minmax(150px, .5fr); }
  .noc-column--services { grid-template-rows: minmax(280px, 1.2fr) minmax(170px, .8fr); }
  .noc-readiness { padding: 8px 12px; }
  .noc-readiness__dial { width: 70px; height: 70px; }
  .noc-readiness__dial strong { font-size: 20px; }
  .noc-state-table { gap: 1px; }
  .noc-state-table > div { min-height: 21px; }
  .noc-host-matrix { grid-auto-rows: 82px; }
  .noc-event-stream li, .noc-service-list li { min-height: 41px; }
}
</style>
