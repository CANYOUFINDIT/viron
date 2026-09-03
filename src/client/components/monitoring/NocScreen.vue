<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleGauge,
  Cpu,
  Grid2X2,
  Minimize,
  Network,
  Pause,
  Play,
  Radar,
  Radio,
  Server,
  ShieldAlert,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { MonitorPlatformEventItem, MonitorPlatformEventListResponse } from "../../../shared/monitor-alerts";
import { hostPressureScore, hostPriorityState, monitoringPressure } from "../../../shared/monitoring";
import { api } from "../../api";
import type { MonitoringHostCard } from "./HostFleetPanel.vue";
import type { MonitoringProblemNode, MonitoringServiceCard } from "./ServiceApmPanel.vue";
import NocTelemetryOrbit from "./NocTelemetryOrbit.vue";

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
const effectsPaused = ref(false);
const pageHidden = ref(false);
const fleetView = ref<"orbit" | "matrix">("orbit");
const clock = ref(Date.now());
const alerts = ref<MonitorPlatformEventItem[]>([]);
const alertsLoading = ref(true);
const alertsFailed = ref(false);
const eventTotals = ref({ active: 0, critical: 0, major: 0, last24Hours: 0 });
let alertsAbort: AbortController | null = null;
let alertsTimer: number | undefined;
let clockTimer: number | undefined;
let motionPreference: MediaQueryList | undefined;

function onMotionPreferenceChange() {
  reducedMotion.value = motionPreference?.matches ?? false;
}

function onVisibilityChange() {
  pageHidden.value = document.hidden;
}

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
    return { host, score, pressure: monitoringPressure(host), state: hostPriorityState(host, score) };
  })
  .sort((left, right) => right.score - left.score
    || left.host.connectionName.localeCompare(right.host.connectionName, "zh")));
const telemetryHosts = computed(() => rankedHosts.value.filter(({ host }) => hasHostTelemetry(host)));
const fleetHosts = computed(() => telemetryHosts.value.slice(0, 48));
const pressureHosts = computed(() => [...telemetryHosts.value]
  .sort((left, right) => right.pressure - left.pressure
    || left.host.connectionName.localeCompare(right.host.connectionName, "zh"))
  .slice(0, 5));
const networkRanking = computed(() => props.hosts
  .filter((host) => !host.missing)
  .map((host) => ({
    host,
    receive: Number(host.networkReceiveBytesPerSecond ?? 0),
    transmit: Number(host.networkTransmitBytesPerSecond ?? 0),
    total: Number(host.networkReceiveBytesPerSecond ?? 0) + Number(host.networkTransmitBytesPerSecond ?? 0),
  }))
  .filter((item) => item.total > 0)
  .sort((left, right) => right.total - left.total)
  .slice(0, 3));
const storageRanking = computed(() => props.hosts
  .filter((host) => !host.missing && host.worstDisk?.usedPercent != null)
  .sort((left, right) => Number(right.worstDisk?.usedPercent ?? 0) - Number(left.worstDisk?.usedPercent ?? 0))
  .slice(0, 3));
const dataPlaneAvailable = computed(() => networkRanking.value.length > 0 || storageRanking.value.length > 0);
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

function hasHostTelemetry(host: MonitoringHostCard) {
  return [host.cpuUsedPercent, host.memoryUsedPercent, host.diskUsedPercent]
    .some((value) => value != null && Number.isFinite(Number(value)));
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
  motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  onMotionPreferenceChange();
  onVisibilityChange();
  motionPreference.addEventListener("change", onMotionPreferenceChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
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
  motionPreference?.removeEventListener("change", onMotionPreferenceChange);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("keydown", onKeydown);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
});
</script>

<template>
  <Teleport to="body">
    <section ref="root" class="noc-screen" :class="{ 'is-reduced': reducedMotion, 'is-still': effectsPaused || pageHidden }" role="dialog" aria-label="NOC Operations Center">
      <div class="noc-atmosphere" aria-hidden="true"><div class="noc-atmosphere__grid"></div><div class="noc-atmosphere__glow"></div></div>
      <header class="noc-command-bar">
        <div class="noc-identity">
          <span class="noc-identity__mark"><Radio :size="20" /></span>
          <div>
            <strong>VIRON <span>/ NOC</span></strong>
            <small>{{ scopeLabel }}</small>
          </div>
        </div>
        <div class="noc-masthead">
          <small>NETWORK OPERATIONS CENTER</small>
          <strong>全域运维指挥中心</strong>
          <div><i></i><span>INFRASTRUCTURE INTELLIGENCE</span><i></i></div>
        </div>
        <div class="noc-clock">
          <div class="noc-clock__time"><strong>{{ currentTime }}</strong><span>{{ currentDate }}</span></div>
          <button type="button" class="noc-motion-toggle" :aria-label="reducedMotion ? '系统已启用减少动态效果' : effectsPaused ? '开启动效' : '暂停动效'" :aria-pressed="!effectsPaused && !reducedMotion" :disabled="reducedMotion" :title="reducedMotion ? '跟随系统减少动态效果设置' : effectsPaused ? '开启动效' : '暂停动效'" @click="effectsPaused = !effectsPaused"><component :is="effectsPaused || reducedMotion ? Play : Pause" :size="14" /></button>
          <button type="button" :aria-label="$t('退出全屏')" @click="emit('exit')"><Minimize :size="15" /> ESC</button>
        </div>
      </header>

      <section class="noc-kpi-rail" aria-label="关键运行指标">
        <article class="noc-kpi is-primary" :style="{ '--kpi-level': `${onlineRate ?? 0}%` }">
          <span class="noc-kpi__icon"><CircleGauge :size="19" /></span>
          <div><small>HOST ONLINE / 主机在线率</small><strong>{{ onlineRate == null ? '—' : `${onlineRate}%` }}</strong></div>
          <em>{{ summary.hostOnline }} / {{ summary.hostTotal }} ONLINE</em>
        </article>
        <article class="noc-kpi" :style="{ '--kpi-level': `${probeCoverageRate ?? 0}%` }">
          <span class="noc-kpi__icon"><Radio :size="19" /></span>
          <div><small>PROBE COVERAGE / 探针覆盖率</small><strong>{{ probeCoverageRate == null ? '—' : `${probeCoverageRate}%` }}</strong></div>
          <em>{{ summary.hostMissing + uncheckedCount }} HOSTS UNMANAGED</em>
        </article>
        <article class="noc-kpi" :style="{ '--kpi-level': `${deploymentRate ?? 0}%` }">
          <span class="noc-kpi__icon"><Boxes :size="19" /></span>
          <div><small>SERVICE READY / 服务部署就绪</small><strong>{{ deploymentRate == null ? '—' : `${deploymentRate}%` }}</strong></div>
          <em>{{ runningTotal }} / {{ deploymentTotal }} RUNNING</em>
        </article>
        <article class="noc-kpi" :class="{ 'is-danger': eventTotals.critical > 0 }">
          <span class="noc-kpi__icon"><ShieldAlert :size="19" /></span>
          <div><small>ACTIVE ALERTS / 活动告警</small><strong>{{ eventTotals.active }}</strong></div>
          <em>{{ eventTotals.critical }} CRITICAL · {{ eventTotals.major }} MAJOR</em>
        </article>
        <article class="noc-kpi">
          <span class="noc-kpi__icon"><Activity :size="19" /></span>
          <div><small>SYSTEM EVENTS / 24H 事件</small><strong>{{ eventTotals.last24Hours }}</strong></div>
          <em>SYSTEM HISTORY · NOT PERSONAL INBOX</em>
        </article>
      </section>

      <div class="noc-operations-grid">
        <aside class="noc-column noc-column--situation">
          <section class="noc-module noc-readiness-module">
            <header class="noc-module__header"><span><Server :size="15" /> CONNECTIVITY & PROBE</span><code>01 / HOSTS</code></header>
            <div class="noc-readiness">
              <div class="noc-readiness__dial">
                <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="noc-dial-track" cx="50" cy="50" r="43" /><circle class="noc-dial-value" cx="50" cy="50" r="43" pathLength="100" :stroke-dasharray="`${clampPercent(onlineRate)} 100`" /></svg>
                <div><strong>{{ onlineRate == null ? '—' : onlineRate }}</strong><small>% ONLINE</small></div>
              </div>
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
              <div><span><Radar :size="16" /> {{ fleetView === 'orbit' ? 'TELEMETRY COMMAND' : 'TELEMETRY HOST MATRIX' }}</span><small>最新采集快照 · {{ fleetHosts.length }} / {{ telemetryHosts.length }} 台有效指标主机</small></div>
              <div class="noc-view-switch" role="group" aria-label="主机展示方式">
                <button type="button" :aria-pressed="fleetView === 'orbit'" @click="fleetView = 'orbit'"><Radar :size="12" />态势</button>
                <button type="button" :aria-pressed="fleetView === 'matrix'" @click="fleetView = 'matrix'"><Grid2X2 :size="12" />矩阵</button>
              </div>
            </header>
            <NocTelemetryOrbit v-if="fleetView === 'orbit'" :hosts="fleetHosts" :total="telemetryHosts.length" />
            <div v-else-if="fleetHosts.length" class="noc-host-matrix">
              <article v-for="item in fleetHosts" :key="item.host.sshConnectionId" class="noc-host-tile" :class="`is-${item.state}`" :title="`${item.host.connectionName} · ${item.host.host}`">
                <header><i></i><strong>{{ item.host.connectionName }}</strong><small>{{ hostStateLabel(item.host) }}</small></header>
                <div class="noc-host-address">{{ item.host.host }}</div>
                <dl>
                  <div><dt>CPU</dt><dd>{{ formatPercent(item.host.cpuUsedPercent) }}</dd></div>
                  <div><dt>MEM</dt><dd>{{ formatPercent(item.host.memoryUsedPercent) }}</dd></div>
                  <div><dt>DSK</dt><dd>{{ formatPercent(item.host.diskUsedPercent) }}</dd></div>
                </dl>
                <div class="noc-pressure-meter"><i :style="{ width: `${item.pressure}%` }"></i></div>
              </article>
            </div>
            <div v-else class="noc-empty-state noc-empty-state--hero">
              <Radio :size="28" /><strong>NO VALID TELEMETRY</strong>
              <span>当前范围没有包含 CPU、内存或磁盘指标的主机快照，不使用连接异常数据填充资源矩阵。</span>
              <div class="noc-empty-counters">
                <b>{{ unreachableCount }}<small>连接异常</small></b>
                <b>{{ summary.hostMissing + uncheckedCount }}<small>未纳管</small></b>
                <b>{{ summary.hostOffline }}<small>探针离线</small></b>
              </div>
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
                <strong class="noc-pressure-score">{{ Math.round(item.pressure) }}</strong>
              </article>
            </div>
            <div v-else class="noc-empty-state is-compact"><CircleGauge :size="18" /><span>暂无有效 CPU / MEM / DSK 采样，无法计算资源压力</span></div>
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
            <header class="noc-module__header"><span><Network :size="15" /> DATA PLANE</span><code>{{ networkRanking.length ? formatRate(totalNetworkRate) : 'NO LIVE SAMPLE' }}</code></header>
            <template v-if="dataPlaneAvailable">
              <div class="noc-io-section">
                <h4>NETWORK THROUGHPUT <span>RX + TX · NON-ZERO</span></h4>
                <ol v-if="networkRanking.length" class="noc-io-list">
                  <li v-for="(item, index) in networkRanking" :key="`network-${item.host.sshConnectionId}`"><b>0{{ index + 1 }}</b><span>{{ item.host.connectionName }}</span><em>{{ formatRate(item.total) }}</em></li>
                </ol>
                <p v-else>暂无非零网络吞吐采样</p>
              </div>
              <div class="noc-io-section">
                <h4>STORAGE WATERLINE <span>HIGHEST USED</span></h4>
                <ol v-if="storageRanking.length" class="noc-io-list">
                  <li v-for="(host, index) in storageRanking" :key="`storage-${host.sshConnectionId}`"><b>0{{ index + 1 }}</b><span>{{ host.connectionName }} · {{ host.worstDisk?.path }}</span><em :class="{ 'is-alert': Number(host.worstDisk?.usedPercent ?? 0) >= 85 }">{{ formatPercent(host.worstDisk?.usedPercent) }}</em></li>
                </ol>
                <p v-else>暂无存储水位采样</p>
              </div>
            </template>
            <div v-else class="noc-empty-state noc-data-plane-empty">
              <Network :size="24" /><strong>NO DATA PLANE SAMPLE</strong>
              <span>当前没有非零网络吞吐或有效磁盘水位，不展示零值排行。</span>
            </div>
          </section>
        </aside>
      </div>

      <footer class="noc-status-line">
        <span class="noc-live-state" :class="{ 'is-paused': !refreshSeconds }"><i></i> {{ refreshSeconds ? `LIVE / ${refreshSeconds}S` : 'PAUSED' }} · {{ generatedAge }}</span>
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
  --noc-unit: clamp(.85px, min(.0732vw, .13vh), 2.8px);
  --noc-bg: #040a10;
  --noc-panel: #09141de8;
  --noc-panel-strong: #10222c88;
  --noc-line: #23414b;
  --noc-line-strong: #294650;
  --noc-text: #dce9e6;
  --noc-muted: #86a5ab;
  --noc-mint: #53e3b3;
  --noc-cyan: #5cc8e8;
  --noc-amber: #f3b955;
  --noc-orange: #f27a45;
  --noc-red: #ff5d62;
  position: fixed;
  inset: 0;
  z-index: 9999;
  min-width: 0;
  min-height: 0;
  isolation: isolate;
  padding: 0 calc(16 * var(--noc-unit));
  overflow: hidden;
  background: var(--noc-bg);
  color: var(--noc-text);
  display: grid;
  grid-template-rows: calc(82 * var(--noc-unit)) calc(104 * var(--noc-unit)) minmax(0, 1fr) calc(34 * var(--noc-unit));
  font-family: var(--font-ui);
  user-select: none;
}
.noc-screen::before { content: ""; position: fixed; inset: 0; z-index: -1; border: calc(1 * var(--noc-unit)) solid #102027; pointer-events: none; }
.noc-screen::after { content: ""; position: fixed; top: calc(66 * var(--noc-unit)); left: calc(16 * var(--noc-unit)); z-index: -1; width: calc(72 * var(--noc-unit)); height: calc(2 * var(--noc-unit)); background: var(--noc-mint); box-shadow: 0 0 calc(18 * var(--noc-unit)) rgba(83, 227, 179, .55); pointer-events: none; }

.noc-command-bar { min-width: 0; border-bottom: calc(1 * var(--noc-unit)) solid var(--noc-line); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr); align-items: center; gap: calc(24 * var(--noc-unit)); }
.noc-identity, .noc-clock, .noc-live-state { display: flex; align-items: center; }
.noc-identity { gap: calc(11 * var(--noc-unit)); }
.noc-identity__mark { width: calc(36 * var(--noc-unit)); height: calc(36 * var(--noc-unit)); border: calc(1 * var(--noc-unit)) solid var(--noc-line-strong); color: var(--noc-mint); display: grid; place-items: center; }
.noc-identity > div { display: flex; flex-direction: column; gap: calc(2 * var(--noc-unit)); }
.noc-identity strong { font-family: var(--font-mono); font-size: calc(13 * var(--noc-unit)); letter-spacing: .09em; }
.noc-identity small { color: var(--noc-muted); font-family: var(--font-mono); font-size: calc(8 * var(--noc-unit)); letter-spacing: .18em; }
.noc-live-state > i { width: calc(6 * var(--noc-unit)); height: calc(6 * var(--noc-unit)); background: var(--noc-mint); box-shadow: 0 0 calc(10 * var(--noc-unit)) var(--noc-mint); animation: noc-pulse 1.8s ease-in-out infinite; }
.noc-live-state.is-paused > i { background: var(--noc-amber); box-shadow: none; animation: none; }
.noc-live-state.is-paused b { color: var(--noc-amber); }
.noc-clock { justify-content: flex-end; gap: calc(12 * var(--noc-unit)); }
.noc-clock button { height: calc(30 * var(--noc-unit)); padding: 0 calc(11 * var(--noc-unit)); border: calc(1 * var(--noc-unit)) solid var(--noc-line-strong); border-radius: 0; background: transparent; color: var(--noc-muted); display: inline-flex; align-items: center; gap: calc(7 * var(--noc-unit)); cursor: pointer; font-family: var(--font-mono); font-size: calc(9 * var(--noc-unit)); }
.noc-clock button:hover { border-color: var(--noc-mint); color: var(--noc-mint); }

.noc-kpi-rail { min-width: 0; padding: calc(13 * var(--noc-unit)) 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: calc(8 * var(--noc-unit)); }
.noc-kpi { min-width: 0; padding: calc(10 * var(--noc-unit)) calc(12 * var(--noc-unit)); border: calc(1 * var(--noc-unit)) solid var(--noc-line); border-top: calc(2 * var(--noc-unit)) solid #2f4a52; background: var(--noc-panel); display: grid; grid-template-columns: calc(30 * var(--noc-unit)) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; align-items: center; column-gap: calc(10 * var(--noc-unit)); row-gap: calc(3 * var(--noc-unit)); }
.noc-kpi.is-primary { border-top-color: var(--noc-mint); }
.noc-kpi.is-danger { border-top-color: var(--noc-red); }
.noc-kpi__icon { grid-row: 1 / -1; color: var(--noc-cyan); }
.noc-kpi.is-primary .noc-kpi__icon { color: var(--noc-mint); }
.noc-kpi.is-danger .noc-kpi__icon { color: var(--noc-red); }
.noc-kpi > div { min-width: 0; display: flex; flex-direction: column; gap: calc(3 * var(--noc-unit)); }
.noc-kpi small { overflow: hidden; color: var(--noc-muted); font-family: var(--font-mono); font-size: calc(8 * var(--noc-unit)); letter-spacing: .08em; text-overflow: ellipsis; white-space: nowrap; }
.noc-kpi strong { color: #eaf6f3; font-family: var(--font-mono); font-size: clamp(calc(21 * var(--noc-unit)), 1.8vw, calc(30 * var(--noc-unit))); line-height: 1; }
.noc-kpi em { grid-column: 2; min-width: 0; overflow: hidden; color: #5f7478; font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); font-style: normal; letter-spacing: .08em; text-overflow: ellipsis; white-space: nowrap; }

.noc-operations-grid { min-height: 0; padding-bottom: calc(10 * var(--noc-unit)); display: grid; grid-template-columns: minmax(calc(260 * var(--noc-unit)), .78fr) minmax(calc(500 * var(--noc-unit)), 1.65fr) minmax(calc(290 * var(--noc-unit)), .92fr); gap: calc(8 * var(--noc-unit)); }
.noc-column { min-width: 0; min-height: 0; display: grid; gap: calc(8 * var(--noc-unit)); }
.noc-column--situation { grid-template-rows: minmax(0, 1.05fr) minmax(0, .95fr); }
.noc-column--fleet { grid-template-rows: minmax(0, 1.55fr) minmax(0, .7fr); }
.noc-column--services { grid-template-rows: minmax(0, 1.15fr) minmax(0, .85fr); }
.noc-module { min-width: 0; min-height: 0; border: calc(1 * var(--noc-unit)) solid var(--noc-line); background: var(--noc-panel); overflow: hidden; display: flex; flex-direction: column; }
.noc-module__header { min-height: calc(38 * var(--noc-unit)); padding: 0 calc(12 * var(--noc-unit)); border-bottom: calc(1 * var(--noc-unit)) solid var(--noc-line); background: var(--noc-panel-strong); display: flex; align-items: center; justify-content: space-between; gap: calc(10 * var(--noc-unit)); flex: none; }
.noc-module__header > span, .noc-module__header > div > span { display: flex; align-items: center; gap: calc(7 * var(--noc-unit)); color: #b7cdca; font-family: var(--font-mono); font-size: calc(9 * var(--noc-unit)); font-weight: 800; letter-spacing: .12em; }
.noc-module__header svg { color: var(--noc-mint); }
.noc-module__header code { color: #536b6e; font-family: var(--font-mono); font-size: calc(8 * var(--noc-unit)); letter-spacing: .08em; white-space: nowrap; }
.noc-module__header--large { min-height: calc(48 * var(--noc-unit)); }
.noc-module__header--large > div { min-width: 0; display: flex; flex-direction: column; gap: calc(4 * var(--noc-unit)); }
.noc-module__header--large > div > small { overflow: hidden; color: #53686b; font-size: calc(9 * var(--noc-unit)); text-overflow: ellipsis; white-space: nowrap; }

.noc-readiness { padding: calc(16 * var(--noc-unit)) calc(14 * var(--noc-unit)) calc(12 * var(--noc-unit)); display: flex; align-items: center; gap: calc(16 * var(--noc-unit)); }
.noc-readiness__dial { position: relative; width: calc(92 * var(--noc-unit)); height: calc(92 * var(--noc-unit)); flex: none; border: calc(1 * var(--noc-unit)) solid #274149; border-top: calc(5 * var(--noc-unit)) solid var(--noc-mint); border-right: calc(5 * var(--noc-unit)) solid var(--noc-mint); border-radius: 50%; box-shadow: 0 0 calc(14 * var(--noc-unit)) rgba(83, 227, 179, .12); display: grid; place-items: center; }
.noc-readiness__dial::after { content: ""; position: absolute; inset: calc(6 * var(--noc-unit)); border: calc(1 * var(--noc-unit)) solid #1c343b; border-radius: 50%; }
.noc-readiness__dial > div { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; }
.noc-readiness__dial strong { color: #e6f5f1; font-family: var(--font-mono); font-size: calc(26 * var(--noc-unit)); line-height: 1; }
.noc-readiness__dial small { margin-top: calc(5 * var(--noc-unit)); color: var(--noc-muted); font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); letter-spacing: .12em; }
.noc-readiness__copy { min-width: 0; display: flex; flex-direction: column; gap: calc(7 * var(--noc-unit)); }
.noc-readiness__copy small { color: var(--noc-muted); font-size: calc(10 * var(--noc-unit)); }
.noc-readiness__copy strong { color: var(--noc-amber); font-family: var(--font-mono); font-size: calc(10 * var(--noc-unit)); letter-spacing: .08em; }
.noc-readiness__copy strong.is-good { color: var(--noc-mint); }
.noc-state-table { overflow: auto; padding: 0 calc(12 * var(--noc-unit)) calc(12 * var(--noc-unit)); display: grid; gap: calc(4 * var(--noc-unit)); }
.noc-state-table > div { min-height: calc(26 * var(--noc-unit)); padding: 0 calc(7 * var(--noc-unit)); border-bottom: calc(1 * var(--noc-unit)) solid #14242a; display: grid; grid-template-columns: calc(8 * var(--noc-unit)) 1fr calc(32 * var(--noc-unit)) calc(32 * var(--noc-unit)); align-items: center; gap: calc(6 * var(--noc-unit)); }
.noc-state-table i { width: calc(5 * var(--noc-unit)); height: calc(5 * var(--noc-unit)); background: var(--noc-muted); }
.noc-state-table span { color: #8ea3a3; font-size: calc(10 * var(--noc-unit)); }
.noc-state-table b, .noc-state-table em { font-family: var(--font-mono); font-size: calc(10 * var(--noc-unit)); font-style: normal; text-align: right; }
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
.noc-event-stream { min-height: 0; overflow: auto; display: grid; grid-auto-rows: minmax(calc(52 * var(--noc-unit)), 1fr); flex: 1; }
.noc-event-stream li { min-height: calc(52 * var(--noc-unit)); padding: calc(8 * var(--noc-unit)) calc(10 * var(--noc-unit)); border-bottom: calc(1 * var(--noc-unit)) solid #14242a; display: grid; grid-template-columns: calc(37 * var(--noc-unit)) minmax(0, 1fr) auto; align-items: center; gap: calc(8 * var(--noc-unit)); }
.noc-event__severity { padding: calc(3 * var(--noc-unit)) calc(4 * var(--noc-unit)); border: calc(1 * var(--noc-unit)) solid currentColor; color: var(--noc-amber); font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); text-align: center; }
.noc-event-stream li.is-critical .noc-event__severity { color: var(--noc-red); }
.noc-event-stream li.is-major .noc-event__severity { color: var(--noc-orange); }
.noc-event-stream li.is-info .noc-event__severity { color: var(--noc-cyan); }
.noc-event-stream li > div { min-width: 0; display: flex; flex-direction: column; gap: calc(3 * var(--noc-unit)); }
.noc-event-stream strong { overflow: hidden; color: #cbd9d7; font-size: calc(10 * var(--noc-unit)); text-overflow: ellipsis; white-space: nowrap; }
.noc-event-stream small { overflow: hidden; color: #53696c; font-size: calc(8 * var(--noc-unit)); text-overflow: ellipsis; white-space: nowrap; }
.noc-event-stream time { color: #657b7e; font-family: var(--font-mono); font-size: calc(8 * var(--noc-unit)); }

.noc-host-matrix { min-height: 0; padding: calc(8 * var(--noc-unit)); overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(118 * var(--noc-unit)), 1fr)); grid-auto-rows: minmax(calc(88 * var(--noc-unit)), 1fr); gap: calc(5 * var(--noc-unit)); flex: 1; }
.noc-host-tile { position: relative; min-width: 0; min-height: calc(88 * var(--noc-unit)); padding: calc(8 * var(--noc-unit)); border: calc(1 * var(--noc-unit)) solid #1b343b; border-left: calc(2 * var(--noc-unit)) solid var(--noc-mint); background: #081318; overflow: hidden; }
.noc-host-tile::after { content: ""; position: absolute; top: 0; right: 0; width: calc(12 * var(--noc-unit)); height: calc(1 * var(--noc-unit)); background: #36535a; }
.noc-host-tile.is-warning { border-left-color: var(--noc-amber); }
.noc-host-tile.is-critical, .noc-host-tile.is-offline { border-left-color: var(--noc-red); background: #141014; }
.noc-host-tile.is-unmanaged { border-left-color: #475c60; }
.noc-host-tile header { min-width: 0; display: grid; grid-template-columns: calc(5 * var(--noc-unit)) minmax(0, 1fr) auto; align-items: center; gap: calc(5 * var(--noc-unit)); }
.noc-host-tile header > i { width: calc(4 * var(--noc-unit)); height: calc(4 * var(--noc-unit)); background: var(--noc-mint); box-shadow: 0 0 calc(7 * var(--noc-unit)) var(--noc-mint); }
.noc-host-tile.is-warning header > i { background: var(--noc-amber); box-shadow: none; }
.noc-host-tile.is-critical header > i, .noc-host-tile.is-offline header > i { background: var(--noc-red); box-shadow: 0 0 calc(7 * var(--noc-unit)) var(--noc-red); }
.noc-host-tile.is-unmanaged header > i { background: #52686c; box-shadow: none; }
.noc-host-tile header strong { overflow: hidden; color: #d5e4e1; font-size: calc(10 * var(--noc-unit)); text-overflow: ellipsis; white-space: nowrap; }
.noc-host-tile header small { color: #5f7779; font-family: var(--font-mono); font-size: calc(6 * var(--noc-unit)); }
.noc-host-address { margin: calc(6 * var(--noc-unit)) 0 calc(7 * var(--noc-unit)); overflow: hidden; color: #4d6468; font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); text-overflow: ellipsis; white-space: nowrap; }
.noc-host-tile dl { margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(4 * var(--noc-unit)); }
.noc-host-tile dl > div { min-width: 0; }
.noc-host-tile dt { color: #52696c; font-family: var(--font-mono); font-size: calc(6 * var(--noc-unit)); }
.noc-host-tile dd { margin: calc(2 * var(--noc-unit)) 0 0; color: #a9bdb9; font-family: var(--font-mono); font-size: calc(9 * var(--noc-unit)); }
.noc-pressure-meter { height: calc(2 * var(--noc-unit)); margin-top: calc(8 * var(--noc-unit)); background: #17282e; }
.noc-pressure-meter i { display: block; height: 100%; background: var(--noc-mint); }
.noc-host-tile.is-warning .noc-pressure-meter i { background: var(--noc-amber); }
.noc-host-tile.is-critical .noc-pressure-meter i, .noc-host-tile.is-offline .noc-pressure-meter i { background: var(--noc-red); }

.noc-pressure-table { min-height: 0; overflow: auto; }
.noc-pressure-table article { min-height: calc(38 * var(--noc-unit)); padding: calc(4 * var(--noc-unit)) calc(10 * var(--noc-unit)); border-bottom: calc(1 * var(--noc-unit)) solid #14242a; display: grid; grid-template-columns: calc(24 * var(--noc-unit)) minmax(calc(100 * var(--noc-unit)), .9fr) repeat(3, minmax(calc(92 * var(--noc-unit)), 1fr)) calc(30 * var(--noc-unit)); align-items: center; gap: calc(8 * var(--noc-unit)); }
.noc-rank { color: #41595d; font-family: var(--font-mono); font-size: calc(9 * var(--noc-unit)); }
.noc-pressure-identity { min-width: 0; display: flex; flex-direction: column; gap: calc(2 * var(--noc-unit)); }
.noc-pressure-identity strong, .noc-pressure-identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.noc-pressure-identity strong { color: #b9ccca; font-size: calc(9 * var(--noc-unit)); }
.noc-pressure-identity small { color: #50676a; font-size: calc(7 * var(--noc-unit)); }
.noc-pressure-bar { display: grid; grid-template-columns: calc(22 * var(--noc-unit)) minmax(calc(25 * var(--noc-unit)), 1fr) calc(28 * var(--noc-unit)); align-items: center; gap: calc(4 * var(--noc-unit)); }
.noc-pressure-bar > span, .noc-pressure-bar > em { color: #5e7477; font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); font-style: normal; }
.noc-pressure-bar > em { text-align: right; }
.noc-pressure-bar > i { height: calc(3 * var(--noc-unit)); background: #17282e; }
.noc-pressure-bar > i > b { display: block; height: 100%; background: var(--noc-cyan); }
.noc-pressure-bar.is-memory > i > b { background: var(--noc-mint); }
.noc-pressure-bar.is-disk > i > b { background: var(--noc-amber); }
.noc-pressure-score { color: #90aaa6; font-family: var(--font-mono); font-size: calc(12 * var(--noc-unit)); text-align: right; }

.noc-service-summary { height: calc(65 * var(--noc-unit)); padding: calc(9 * var(--noc-unit)) calc(10 * var(--noc-unit)); border-bottom: calc(1 * var(--noc-unit)) solid #14242a; display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(6 * var(--noc-unit)); }
.noc-service-summary > div { padding-left: calc(8 * var(--noc-unit)); border-left: calc(1 * var(--noc-unit)) solid #263d44; display: flex; flex-direction: column; justify-content: center; gap: calc(4 * var(--noc-unit)); }
.noc-service-summary small { color: #52696c; font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); letter-spacing: .08em; }
.noc-service-summary strong { color: #d7e6e3; font-family: var(--font-mono); font-size: calc(18 * var(--noc-unit)); line-height: 1; }
.noc-service-summary strong.is-alert { color: var(--noc-red); }
.noc-service-list { min-height: 0; overflow: auto; display: grid; grid-auto-rows: minmax(calc(48 * var(--noc-unit)), 1fr); flex: 1; }
.noc-service-list li { min-height: calc(48 * var(--noc-unit)); padding: calc(7 * var(--noc-unit)) calc(9 * var(--noc-unit)); border-bottom: calc(1 * var(--noc-unit)) solid #14242a; display: grid; grid-template-columns: calc(6 * var(--noc-unit)) minmax(0, 1fr) calc(38 * var(--noc-unit)) calc(42 * var(--noc-unit)) auto; align-items: center; gap: calc(7 * var(--noc-unit)); }
.noc-service-list li > i { width: calc(5 * var(--noc-unit)); height: calc(22 * var(--noc-unit)); background: var(--noc-mint); }
.noc-service-list li.is-warning > i { background: var(--noc-amber); }
.noc-service-list li.is-major > i { background: var(--noc-orange); }
.noc-service-list li.is-critical > i { background: var(--noc-red); }
.noc-service-list li > div { min-width: 0; display: flex; flex-direction: column; gap: calc(2 * var(--noc-unit)); }
.noc-service-list li > div strong, .noc-service-list li > div small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.noc-service-list li > div strong { color: #c5d7d4; font-size: calc(10 * var(--noc-unit)); }
.noc-service-list li > div small { color: #50676a; font-size: calc(7 * var(--noc-unit)); }
.noc-service-list li > span { display: flex; flex-direction: column; gap: calc(2 * var(--noc-unit)); }
.noc-service-list li > span b { color: #9cb2ae; font-family: var(--font-mono); font-size: calc(10 * var(--noc-unit)); }
.noc-service-list li > span small { color: #4d6266; font-family: var(--font-mono); font-size: calc(6 * var(--noc-unit)); }
.noc-service-list li > em { padding: calc(3 * var(--noc-unit)) calc(4 * var(--noc-unit)); border: calc(1 * var(--noc-unit)) solid #583d31; color: var(--noc-orange); font-family: var(--font-mono); font-size: calc(6 * var(--noc-unit)); font-style: normal; white-space: nowrap; }

.noc-io-section { min-height: 0; padding: calc(8 * var(--noc-unit)) calc(10 * var(--noc-unit)) calc(4 * var(--noc-unit)); border-bottom: calc(1 * var(--noc-unit)) solid #14242a; flex: 1; }
.noc-io-section:last-child { border-bottom: 0; }
.noc-io-section h4 { margin: 0 0 calc(5 * var(--noc-unit)); color: #8ca2a1; display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); letter-spacing: .08em; }
.noc-io-section h4 span { color: #465e61; font-size: calc(6 * var(--noc-unit)); }
.noc-io-list li { min-height: calc(24 * var(--noc-unit)); border-top: calc(1 * var(--noc-unit)) solid #132329; display: grid; grid-template-columns: calc(18 * var(--noc-unit)) minmax(0, 1fr) auto; align-items: center; gap: calc(6 * var(--noc-unit)); }
.noc-io-list b { color: #40585c; font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); }
.noc-io-list span { overflow: hidden; color: #839997; font-size: calc(8 * var(--noc-unit)); text-overflow: ellipsis; white-space: nowrap; }
.noc-io-list em { color: var(--noc-cyan); font-family: var(--font-mono); font-size: calc(8 * var(--noc-unit)); font-style: normal; }
.noc-io-list em.is-alert { color: var(--noc-red); }
.noc-io-section p { margin: calc(12 * var(--noc-unit)) 0; color: #4b6265; font-size: calc(8 * var(--noc-unit)); text-align: center; }

.noc-empty-state { min-height: 0; padding: calc(18 * var(--noc-unit)); color: #597075; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(7 * var(--noc-unit)); text-align: center; flex: 1; }
.noc-empty-state strong { color: #819896; font-family: var(--font-mono); font-size: calc(12 * var(--noc-unit)); letter-spacing: .12em; }
.noc-empty-state span { max-width: calc(360 * var(--noc-unit)); font-size: calc(10 * var(--noc-unit)); line-height: 1.6; }
.noc-empty-state.is-compact { min-height: calc(70 * var(--noc-unit)); flex-direction: row; font-size: calc(10 * var(--noc-unit)); }
.noc-empty-state.is-success { color: var(--noc-mint); }
.noc-empty-state.is-error { color: var(--noc-red); }
.noc-empty-state--hero { border: calc(1 * var(--noc-unit)) dashed #1f343b; margin: calc(12 * var(--noc-unit)); }
.noc-empty-counters { width: min(calc(420 * var(--noc-unit)), 90%); margin-top: calc(8 * var(--noc-unit)); display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(1 * var(--noc-unit)); background: var(--noc-line); }
.noc-empty-counters b { padding: calc(10 * var(--noc-unit)) calc(8 * var(--noc-unit)); background: #081318; color: var(--noc-amber); display: flex; flex-direction: column; gap: calc(4 * var(--noc-unit)); font-family: var(--font-mono); font-size: calc(18 * var(--noc-unit)); }
.noc-empty-counters small { color: #60777a; font-family: var(--font-ui); font-size: calc(8 * var(--noc-unit)); font-weight: 500; }
.noc-data-plane-empty { min-height: calc(180 * var(--noc-unit)); }

.noc-status-line { min-width: 0; border-top: calc(1 * var(--noc-unit)) solid var(--noc-line); color: #536a6d; display: flex; align-items: center; justify-content: space-between; gap: calc(16 * var(--noc-unit)); font-family: var(--font-mono); font-size: calc(7 * var(--noc-unit)); letter-spacing: .08em; }
.noc-status-line span { white-space: nowrap; }
.noc-status-line span:first-child { display: flex; align-items: center; gap: calc(7 * var(--noc-unit)); color: #78918e; }
.noc-status-line i { width: calc(5 * var(--noc-unit)); height: calc(5 * var(--noc-unit)); background: var(--noc-mint); }

@keyframes noc-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
.is-reduced :deep(*), .is-reduced :deep(*::before), .is-reduced :deep(*::after) { animation: none !important; transition: none !important; }
.is-still :deep(*), .is-still :deep(*::before), .is-still :deep(*::after) { animation-play-state: paused !important; }

@media (max-width: 1280px) {
  .noc-screen { padding: 0 calc(10 * var(--noc-unit)); grid-template-rows: calc(58 * var(--noc-unit)) calc(94 * var(--noc-unit)) minmax(0, 1fr) calc(30 * var(--noc-unit)); }
  .noc-screen::after { top: calc(58 * var(--noc-unit)); left: calc(10 * var(--noc-unit)); }
  .noc-kpi { padding: calc(8 * var(--noc-unit)); grid-template-columns: calc(22 * var(--noc-unit)) minmax(0, 1fr); }
  .noc-kpi em { display: none; }
  .noc-operations-grid { grid-template-columns: minmax(calc(230 * var(--noc-unit)), .7fr) minmax(calc(440 * var(--noc-unit)), 1.55fr) minmax(calc(250 * var(--noc-unit)), .8fr); }
  .noc-host-matrix { grid-template-columns: repeat(auto-fill, minmax(calc(104 * var(--noc-unit)), 1fr)); }
  .noc-pressure-table article { grid-template-columns: calc(20 * var(--noc-unit)) minmax(calc(90 * var(--noc-unit)), .8fr) repeat(3, minmax(calc(70 * var(--noc-unit)), 1fr)) calc(26 * var(--noc-unit)); gap: calc(5 * var(--noc-unit)); }
}
@media (max-height: 760px) {
  .noc-screen { grid-template-rows: calc(52 * var(--noc-unit)) calc(84 * var(--noc-unit)) minmax(0, 1fr) calc(28 * var(--noc-unit)); }
  .noc-screen::after { top: calc(52 * var(--noc-unit)); }
  .noc-kpi-rail { padding: calc(9 * var(--noc-unit)) 0; }
  .noc-column--situation { grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  .noc-column--fleet { grid-template-rows: minmax(0, 1.55fr) minmax(0, .7fr); }
  .noc-column--services { grid-template-rows: minmax(0, 1.15fr) minmax(0, .85fr); }
  .noc-readiness { padding: calc(8 * var(--noc-unit)) calc(12 * var(--noc-unit)); }
  .noc-readiness__dial { width: calc(70 * var(--noc-unit)); height: calc(70 * var(--noc-unit)); }
  .noc-readiness__dial strong { font-size: calc(20 * var(--noc-unit)); }
  .noc-state-table { gap: calc(1 * var(--noc-unit)); }
  .noc-state-table > div { min-height: calc(21 * var(--noc-unit)); }
  .noc-host-matrix { grid-auto-rows: calc(82 * var(--noc-unit)); }
  .noc-event-stream li, .noc-service-list li { min-height: calc(41 * var(--noc-unit)); }
}
/* The light field sits behind all operational content and never intercepts input. */
.noc-atmosphere { position: absolute; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; background: radial-gradient(ellipse at 50% 0, #173f5140, transparent 60%), radial-gradient(ellipse at 50% 90%, #08392f22, transparent 70%); }
.noc-atmosphere__grid { position: absolute; inset: 0; background-image: linear-gradient(#4fa1b008 1px, transparent 1px), linear-gradient(90deg, #4fa1b008 1px, transparent 1px); background-size: calc(36 * var(--noc-unit)) calc(36 * var(--noc-unit)); mask-image: linear-gradient(#000, transparent 85%); }
.noc-atmosphere__glow { position: absolute; top: -25%; left: 25%; width: 50%; height: 50%; border-radius: 50%; background: radial-gradient(ellipse, #53e3b30a, transparent 70%); animation: noc-drift 20s ease-in-out infinite alternate; }
.noc-screen::before { inset: calc(5 * var(--noc-unit)); border-color: #29536344; }
.noc-screen::after { top: 0; left: 30%; width: 40%; height: 1px; background: linear-gradient(90deg, transparent, var(--noc-cyan), transparent); }
.noc-command-bar { position: relative; border-bottom-color: #356071; }
.noc-command-bar::after { content: ""; position: absolute; bottom: -1px; left: 34%; width: 32%; height: 2px; background: linear-gradient(90deg, transparent, var(--noc-cyan), transparent); box-shadow: 0 0 16px #5cc8e84d; }
.noc-identity__mark { width: calc(38 * var(--noc-unit)); height: calc(38 * var(--noc-unit)); border-color: #357582; background: linear-gradient(135deg, #17353a, #0a1720); box-shadow: inset 0 0 18px #53e3b30c; clip-path: polygon(0 0, 80% 0, 100% 20%, 100% 100%, 20% 100%, 0 80%); }
.noc-identity strong { font-size: calc(17 * var(--noc-unit)); letter-spacing: .14em; }
.noc-identity strong > span { color: #5e8a93; font-size: calc(10 * var(--noc-unit)); }
.noc-identity small { max-width: calc(240 * var(--noc-unit)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: calc(4 * var(--noc-unit)); color: #81a4ac; letter-spacing: .06em; }
.noc-masthead { position: relative; display: flex; flex-direction: column; align-items: center; gap: calc(4 * var(--noc-unit)); align-self: stretch; justify-content: center; background: linear-gradient(180deg, #18405222, #173f5100); }
.noc-masthead > small { color: #729ca9; font: calc(7 * var(--noc-unit)) var(--font-mono); letter-spacing: .32em; }
.noc-masthead > strong { color: #e1f6f8; font-size: calc(23 * var(--noc-unit)); line-height: 1.25; font-weight: 600; letter-spacing: .24em; text-indent: .24em; text-shadow: 0 0 22px #5cc8e847; white-space: nowrap; }
.noc-masthead > div { display: flex; align-items: center; gap: calc(10 * var(--noc-unit)); color: #507d89; font: calc(5 * var(--noc-unit)) var(--font-mono); letter-spacing: .28em; }
.noc-masthead > div i { width: calc(28 * var(--noc-unit)); height: 1px; background: #365d6b; }
.noc-clock { gap: calc(8 * var(--noc-unit)); }
.noc-clock__time { display: flex; flex-direction: column; align-items: flex-end; gap: calc(3 * var(--noc-unit)); margin-right: calc(5 * var(--noc-unit)); }
.noc-clock__time strong { color: #def6f7; font: 500 calc(21 * var(--noc-unit))/1 var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: .04em; }
.noc-clock__time span { color: #7a9ca5; font: calc(8 * var(--noc-unit)) var(--font-mono); letter-spacing: .1em; }
.noc-clock button { color: #9ab5bc; background: #0e202955; }
.noc-clock .noc-motion-toggle { padding: 0; width: calc(30 * var(--noc-unit)); justify-content: center; }
.noc-clock button:focus-visible, .noc-view-switch button:focus-visible { outline: 2px solid var(--noc-cyan); outline-offset: 3px; }
.noc-clock button:disabled { opacity: .45; cursor: default; }
.noc-kpi { position: relative; overflow: hidden; background: linear-gradient(110deg, #11232e, #0a151ed9); border-top-width: 1px; border-top-color: #366072; box-shadow: inset 0 1px #70c4dd0c; }
.noc-kpi::before { content: ""; position: absolute; top: 0; right: 0; width: 36%; height: 100%; pointer-events: none; background: repeating-linear-gradient(120deg, transparent 0 11px, #5cc8e806 11px 12px); }
.noc-kpi::after { content: ""; position: absolute; bottom: 0; left: 0; width: var(--kpi-level, 0%); height: calc(2 * var(--noc-unit)); background: var(--noc-cyan); box-shadow: 0 0 10px #5cc8e840; transition: width .8s ease; }
.noc-kpi.is-primary { background: linear-gradient(110deg, #11322f, #0a1a21d9); border-color: #2e625c; }
.noc-kpi.is-primary::after { background: var(--noc-mint); }
.noc-kpi.is-primary strong { color: #a7ffda; text-shadow: 0 0 20px #53e3b326; }
.noc-kpi.is-danger { border-color: #743b49; background: linear-gradient(110deg, #321d28, #15121ed9); }
.noc-kpi.is-danger strong { color: #ff9093; }
.noc-kpi strong { font-weight: 500; font-variant-numeric: tabular-nums; }
.noc-kpi em { color: #7e9ca5; }
.noc-kpi__icon { opacity: .85; filter: drop-shadow(0 0 8px #5cc8e830); }
.noc-module { position: relative; box-shadow: inset 0 0 35px #153a4810; }
.noc-module::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(var(--noc-cyan), var(--noc-cyan)) left top / 12px 1px no-repeat, linear-gradient(var(--noc-cyan), var(--noc-cyan)) left top / 1px 12px no-repeat, linear-gradient(#365d6b, #365d6b) right bottom / 12px 1px no-repeat, linear-gradient(#365d6b, #365d6b) right bottom / 1px 12px no-repeat; opacity: .6; }
.noc-module__header { background: linear-gradient(90deg, #17303b70, #0e202730); }
.noc-module__header code, .noc-module__header--large > div > small { color: #80a0a9; }
.noc-module__header > span, .noc-module__header > div > span { color: #badde0; font-size: calc(8 * var(--noc-unit)); }
.noc-module__header--large .noc-view-switch { flex-direction: row; flex: none; gap: 0; padding: calc(2 * var(--noc-unit)); background: #071117; border: 1px solid #23414b; }
.noc-view-switch button { padding: calc(5 * var(--noc-unit)) calc(8 * var(--noc-unit)); border: 0; background: transparent; color: #7499a2; display: flex; align-items: center; gap: calc(4 * var(--noc-unit)); font-size: calc(8 * var(--noc-unit)); cursor: pointer; }
.noc-view-switch button[aria-pressed="true"] { color: #9af1da; background: #173935; box-shadow: inset 0 0 12px #53e3b308; }
.noc-view-switch button svg { color: inherit; }
.noc-fleet-module { border-color: #305968; background: #07131be8; }
.noc-readiness__dial { border: 0; background: radial-gradient(circle, #13353a, #0a181e 65%); box-shadow: none; }
.noc-readiness__dial > svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; transform: rotate(-90deg); }
.noc-dial-track, .noc-dial-value { fill: none; stroke: #244047; stroke-width: 4; }
.noc-dial-value { stroke: var(--noc-mint); stroke-linecap: round; filter: drop-shadow(0 0 3px #53e3b366); transition: stroke-dasharray 1s ease; }
.noc-readiness__dial::after { inset: 13%; border-style: dashed; border-color: #345861; }
.noc-readiness { padding: calc(8 * var(--noc-unit)) calc(14 * var(--noc-unit)); }
.noc-state-table { gap: calc(2 * var(--noc-unit)); }
.noc-state-table > div { min-height: calc(22 * var(--noc-unit)); }
.noc-state-table > div { background: linear-gradient(90deg, #1e3f4612, transparent); }
.noc-state-table em, .noc-event-stream small, .noc-event-stream time { color: #7e9ca5; }
.noc-event-stream li.is-critical { background: linear-gradient(90deg, #ff5d620c, transparent); }
.noc-event-stream li.is-critical .noc-event__severity { box-shadow: 0 0 12px #ff5d6218; }
.noc-event-stream strong { color: #d5e5e7; }
.noc-event-stream { grid-auto-rows: minmax(calc(34 * var(--noc-unit)), 1fr); }
.noc-event-stream li { min-height: calc(34 * var(--noc-unit)); padding-top: calc(4 * var(--noc-unit)); padding-bottom: calc(4 * var(--noc-unit)); line-height: 1.25; }
.noc-host-tile { background: linear-gradient(135deg, #10252d, #09161f); transition: border-color .2s ease; }
.noc-host-tile:hover { border-top-color: #5795a3; border-right-color: #5795a3; border-bottom-color: #5795a3; }
.noc-host-tile header small, .noc-host-address, .noc-host-tile dt { color: #80a0a9; }
.noc-pressure-meter i, .noc-pressure-bar > i > b { transition: width .8s ease; box-shadow: 0 0 8px #5cc8e828; }
.noc-pressure-bar > i { height: calc(4 * var(--noc-unit)); }
.noc-pressure-bar > span, .noc-pressure-bar > em, .noc-pressure-identity small { color: #84a2aa; }
.noc-pressure-score { color: #bedddd; }
.noc-pressure-table article { min-height: calc(25 * var(--noc-unit)); padding-top: calc(2 * var(--noc-unit)); padding-bottom: calc(2 * var(--noc-unit)); line-height: 1.1; }
.noc-service-summary { background: linear-gradient(180deg, #14303944, transparent); }
.noc-service-summary strong { color: #b5eedc; font-size: calc(23 * var(--noc-unit)); }
.noc-service-summary small, .noc-service-list li > div small, .noc-service-list li > span small { color: #7c9ba5; }
.noc-service-list li > i { width: calc(3 * var(--noc-unit)); height: calc(18 * var(--noc-unit)); box-shadow: 0 0 10px #53e3b31a; }
.noc-service-list { grid-auto-rows: minmax(calc(33 * var(--noc-unit)), 1fr); }
.noc-service-list li { min-height: calc(33 * var(--noc-unit)); padding-top: calc(4 * var(--noc-unit)); padding-bottom: calc(4 * var(--noc-unit)); line-height: 1.25; }
.noc-io-section h4 { color: #a8c7cd; }
.noc-io-section h4 span, .noc-io-section p, .noc-io-list b { color: #6f939f; }
.noc-io-list span { color: #aac4c9; }
.noc-status-line { color: #7395a1; font-variant-numeric: tabular-nums; }
.noc-status-line span:first-child { color: #9acac9; }
@keyframes noc-drift { to { transform: translate3d(15%, 15%, 0); opacity: .5; } }
@media (prefers-reduced-motion: no-preference) {
  .noc-module, .noc-kpi { animation: noc-reveal .65s ease both; }
  .noc-column--fleet .noc-module { animation-delay: .08s; }
  .noc-column--services .noc-module { animation-delay: .16s; }
}
@keyframes noc-reveal { from { opacity: 0; transform: translateY(calc(8 * var(--noc-unit))); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 1280px) {
  .noc-screen { grid-template-rows: calc(74 * var(--noc-unit)) calc(94 * var(--noc-unit)) minmax(0, 1fr) calc(30 * var(--noc-unit)); }
  .noc-command-bar { gap: calc(12 * var(--noc-unit)); }
  .noc-masthead > strong { font-size: calc(21 * var(--noc-unit)); }
  .noc-pressure-table article { grid-template-columns: 16px minmax(65px, .8fr) repeat(3, minmax(60px, 1fr)) 24px; }
}
@media (max-width: 1000px) {
  .noc-screen { --noc-unit: 1px; overflow-y: auto; display: flex; flex-direction: column; padding: 0 12px; }
  .noc-command-bar { position: sticky; top: 0; z-index: 5; min-height: 74px; flex: none; background: #07121cf5; grid-template-columns: minmax(0, 1fr) auto; }
  .noc-masthead { display: none; }
  .noc-kpi-rail { min-height: 140px; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: none; }
  .noc-operations-grid { display: flex; flex-direction: column; flex: none; }
  .noc-column--fleet { order: -1; grid-template-rows: 460px 250px; }
  .noc-column--situation, .noc-column--services { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: 340px; }
  .noc-status-line { min-height: 32px; flex-wrap: wrap; gap: 8px; padding: 8px 0; flex: none; }
}
@media (max-width: 600px) {
  .noc-column--situation, .noc-column--services { grid-template-columns: 1fr; grid-template-rows: 320px 300px; }
  .noc-kpi-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 220px; }
  .noc-identity strong { font-size: 14px; }
  .noc-identity small { max-width: 130px; font-size: 7px; }
  .noc-identity__mark { display: none; }
  .noc-clock__time strong { font-size: 16px; }
  .noc-pressure-table { overflow-x: auto; }
  .noc-pressure-table article { min-width: 470px; }
}
</style>
