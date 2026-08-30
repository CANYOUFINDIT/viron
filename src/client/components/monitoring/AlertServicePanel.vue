<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  MonitorAlertSeverity,
  MonitorPlatformEventItem,
  MonitorPlatformEventListResponse,
} from "../../../shared/monitor-alerts";
import { api } from "../../api";
import { currentLocale, translate as tr } from "../../i18n";
import { monitorAlertRuleLabel } from "../../monitor-alert-copy";
import { monitorAlertLocalDateKey } from "../../monitor-host-event-display";
import HostEventCalendar from "./HostEventCalendar.vue";
import type { MonitoringServiceCard } from "./ServiceApmPanel.vue";

const props = defineProps<{
  environmentId: string;
  environments: Array<{ id: string; name: string }>;
  services: MonitoringServiceCard[];
  refreshKey?: string;
}>();

const emit = defineEmits<{
  "open-event": [event: MonitorPlatformEventItem];
  "open-service": [service: MonitoringServiceCard];
}>();

const eventRangeDays = ref(1);
const selectedHeatDate = ref("");
const eventEnvironmentId = ref("");
const eventSeverity = ref<"all" | MonitorAlertSeverity>("all");
const eventStatus = ref<"all" | "active" | "recovered" | "event">("all");
const events = ref<MonitorPlatformEventItem[]>([]);
const eventTotal = ref(0);
const eventPage = ref(1);
const eventPageSize = 100;
const eventsLoading = ref(false);
const eventsError = ref("");
const serviceQuery = ref("");
const todayKey = monitorAlertLocalDateKey(new Date().toISOString());
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let eventsAbort: AbortController | null = null;

function addDays(key: string, delta: number) {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return monitorAlertLocalDateKey(new Date(year, month - 1, day + delta).toISOString());
}

function selectHeatDate(date: string) {
  selectedHeatDate.value = selectedHeatDate.value === date ? "" : date;
}

const rangeStartKey = computed(() => selectedHeatDate.value || addDays(todayKey, -(eventRangeDays.value - 1)));
const rangeEndKey = computed(() => selectedHeatDate.value || todayKey);
const effectiveEventEnvironmentId = computed(() => props.environmentId || eventEnvironmentId.value);

function boundaryIso(key: string, dayOffset = 0) {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day + dayOffset, 0, 0, 0, 0).toISOString();
}

async function loadEvents() {
  eventsAbort?.abort();
  eventsAbort = new AbortController();
  const controller = eventsAbort;
  eventsLoading.value = true;
  eventsError.value = "";
  try {
    const query = new URLSearchParams({
      timezone,
      severity: eventSeverity.value,
      status: eventStatus.value,
      page: String(eventPage.value),
      pageSize: String(eventPageSize),
    });
    if (selectedHeatDate.value) query.set("date", selectedHeatDate.value);
    else {
      query.set("from", boundaryIso(rangeStartKey.value));
      query.set("to", boundaryIso(rangeEndKey.value, 1));
    }
    if (effectiveEventEnvironmentId.value) query.set("environmentId", effectiveEventEnvironmentId.value);
    const response = await api<MonitorPlatformEventListResponse>(`/api/v1/monitoring/events?${query}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    events.value = response.items;
    eventTotal.value = response.total;
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    events.value = [];
    eventTotal.value = 0;
    eventsError.value = caught instanceof Error ? caught.message : tr("读取系统告警事件失败");
  } finally {
    if (eventsAbort === controller) eventsLoading.value = false;
  }
}

function chooseRange(days: number) {
  selectedHeatDate.value = "";
  eventRangeDays.value = days;
}

const eventRangeLabel = computed(() => {
  if (selectedHeatDate.value) return selectedHeatDate.value;
  if (eventRangeDays.value === 1) return tr("今天");
  if (eventRangeDays.value === 365) return tr("近一年");
  return tr("近 {{0}} 天", [eventRangeDays.value]);
});

function severityLabel(value: MonitorAlertSeverity) {
  return ({ info: "INFO", warning: "WARNING", major: "MAJOR", critical: "CRITICAL" })[value];
}

function statusLabel(status: MonitorPlatformEventItem["status"]) {
  return status === "active" ? tr("活动中") : status === "recovered" ? tr("已恢复") : tr("事件");
}

function eventTime(event: MonitorPlatformEventItem) {
  const at = new Date(event.lastSeenAt || event.triggeredAt);
  return `${monitorAlertLocalDateKey(at.toISOString())} ${at.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function eventTarget(event: MonitorPlatformEventItem) {
  return event.serviceName || event.connectionName || event.targetName;
}

const visibleServices = computed(() => {
  const query = serviceQuery.value.trim().toLowerCase();
  return props.services.filter((service) => {
    if (!query) return true;
    return `${service.name} ${service.environmentName}`.toLowerCase().includes(query);
  });
});

function healthLabel(health: string) {
  if (health === "running") return tr("运行中");
  if (health === "degraded") return tr("异常");
  if (health === "disabled") return tr("已停用");
  if (health === "empty") return tr("无部署");
  return tr("未知");
}

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(0)}%`;
}

function formatBytes(value: number | null) {
  if (value === null) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}G`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)}M`;
  return `${(value / 1024).toFixed(0)}K`;
}

function serviceAlertText(service: MonitoringServiceCard) {
  if (!service.activeAlertCount) return "0";
  return service.activeAlertPeakSeverity
    ? `${service.activeAlertCount} ${severityLabel(service.activeAlertPeakSeverity)}`
    : String(service.activeAlertCount);
}

watch(() => props.environmentId, (value) => {
  eventEnvironmentId.value = value;
}, { immediate: true });

watch(
  () => [
    props.environmentId,
    eventEnvironmentId.value,
    eventRangeDays.value,
    selectedHeatDate.value,
    eventSeverity.value,
    eventStatus.value,
    props.refreshKey,
  ],
  () => {
    if (eventPage.value !== 1) eventPage.value = 1;
    else void loadEvents();
  },
  { immediate: true },
);
watch(eventPage, () => void loadEvents());
onBeforeUnmount(() => eventsAbort?.abort());
</script>

<template>
  <section class="alert-service-panel">
    <HostEventCalendar
      mode="platform"
      :environment-id="environmentId"
      :refresh-key="refreshKey"
      :selected-date="selectedHeatDate"
      @select-date="selectHeatDate"
    />

    <section class="observe-panel" v-loading="eventsLoading">
      <header class="observe-panel__head">
        <div>
          <h3>{{ $t('告警事件') }}</h3>
          <small>{{ eventRangeLabel }} · {{ eventTotal }} · {{ $t('系统事件记录，不受个人通知清除影响') }}</small>
        </div>
      </header>
      <div class="event-filter-bar">
        <div class="event-range-tabs" role="group" :aria-label="$t('告警事件时间范围')">
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 1 }" @click="chooseRange(1)">{{ $t('今天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 7 }" @click="chooseRange(7)">{{ $t('近 7 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 30 }" @click="chooseRange(30)">{{ $t('近 30 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 90 }" @click="chooseRange(90)">{{ $t('近 90 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 365 }" @click="chooseRange(365)">{{ $t('近一年') }}</button>
        </div>
        <div class="event-filter-controls">
          <el-select v-model="eventEnvironmentId" clearable :disabled="Boolean(environmentId)" :placeholder="$t('全部环境')" class="filter-select">
            <el-option v-for="item in environments" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
          <el-select v-model="eventSeverity" class="filter-select">
            <el-option value="all" :label="$t('全部级别')" />
            <el-option value="critical" label="Critical" />
            <el-option value="major" label="Major" />
            <el-option value="warning" label="Warning" />
            <el-option value="info" label="Info" />
          </el-select>
          <el-select v-model="eventStatus" class="filter-select">
            <el-option value="all" :label="$t('全部状态')" />
            <el-option value="active" :label="$t('活动中')" />
            <el-option value="recovered" :label="$t('已恢复')" />
            <el-option value="event" :label="$t('事件')" />
          </el-select>
        </div>
      </div>
      <div v-if="eventsError" class="event-list-error">{{ eventsError }}</div>
      <div v-else-if="!events.length && !eventsLoading" class="observe-empty">{{ $t('当前条件下没有告警事件') }}</div>
      <div v-else class="event-list">
        <button
          v-for="event in events"
          :key="event.id"
          type="button"
          class="event-row"
          @click="emit('open-event', event)"
        >
          <span class="tone-badge" :class="`is-${event.peakSeverity}`">{{ severityLabel(event.peakSeverity) }}</span>
          <span class="event-time">{{ eventTime(event) }}</span>
          <span>
            <strong>{{ monitorAlertRuleLabel(event) }}</strong>
            <small>{{ event.connectionName || event.targetName }}<template v-if="event.occurrenceCount > 1"> · {{ event.occurrenceCount }}</template></small>
          </span>
          <span>
            <strong>{{ eventTarget(event) }}</strong>
            <small>{{ event.environmentName }}</small>
          </span>
          <span class="tone-badge" :class="event.status === 'active' ? 'is-critical' : event.status === 'recovered' ? 'is-healthy' : 'is-info'">{{ statusLabel(event.status) }}</span>
        </button>
      </div>
      <footer v-if="eventTotal > eventPageSize" class="event-pagination">
        <el-pagination
          v-model:current-page="eventPage"
          :page-size="eventPageSize"
          :total="eventTotal"
          layout="prev, pager, next"
          background
        />
      </footer>
    </section>

    <section class="observe-panel service-section">
      <header class="observe-panel__head">
        <h3>{{ $t('服务') }}</h3>
        <el-input v-model="serviceQuery" clearable class="service-search" :placeholder="$t('按服务名或环境搜索')" />
      </header>
      <div class="service-table">
        <div class="service-row is-head">
          <span>{{ $t('服务 / 环境') }}</span>
          <span>{{ $t('部署') }}</span>
          <span>{{ $t('运行状态') }}</span>
          <span>{{ $t('活动告警') }}</span>
          <span>{{ $t('重启') }}</span>
          <span>{{ $t('当前资源') }}</span>
          <span></span>
        </div>
        <div v-if="!visibleServices.length" class="observe-empty">{{ $t('暂无服务实例') }}</div>
        <div v-for="service in visibleServices" :key="service.id" class="service-row">
          <div>
            <strong>{{ service.name }}</strong>
            <small>{{ service.environmentName }}</small>
          </div>
          <span>{{ service.runningCount }} / {{ service.deploymentCount }}</span>
          <span><b class="tone-badge" :class="`is-${service.health}`">{{ healthLabel(service.health) }}</b></span>
          <span :class="{ 'is-hot': (service.activeAlertCount ?? 0) > 0 }">{{ serviceAlertText(service) }}</span>
          <span>{{ service.restartCount ?? 0 }}</span>
          <span>CPU {{ formatPercent(service.cpuUsedPercent) }} · MEM {{ formatBytes(service.memoryBytes) }}</span>
          <button type="button" class="row-action" @click="emit('open-service', service)">{{ $t('服务维护') }} →</button>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.alert-service-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.observe-panel {
  min-width: 0;
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-card, 8px);
  background: var(--surface);
}

.observe-panel__head {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--ink-100);
}

.observe-panel__title,
.observe-panel__head h3,
.observe-panel__head small {
  margin: 0;
}

.observe-panel__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.observe-panel__icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: var(--teal-50);
  color: var(--teal-700);
}

.observe-panel__head h3 {
  font-size: 14px;
  font-weight: 750;
}

.observe-panel__head small {
  display: block;
  margin-top: 2px;
  color: var(--ink-400);
  font-size: 11px;
}

.observe-panel__foot {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 8px 14px;
  border-top: 1px solid var(--ink-100);
}

.range-pills {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  background: var(--ink-50);
}

.range-pills button,
.event-range-tabs button,
.row-action {
  border: 0;
  background: transparent;
  color: var(--ink-500);
  cursor: pointer;
}

.range-pills button {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
}

.range-pills button.is-active {
  background: var(--surface);
  color: var(--ink-900);
  box-shadow: var(--shadow-sm);
}

.heat-body {
  padding: 14px 16px 12px;
  overflow-x: auto;
}

.heat-body.is-loading {
  opacity: 0.7;
}

.heat-months {
  min-width: 720px;
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
}

.heat-plot {
  min-width: 720px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
}

.heat-weekdays {
  display: grid;
  grid-template-rows: repeat(7, 12px);
  gap: 3px;
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 12px;
}

.heat-grid {
  display: grid;
  grid-template-rows: repeat(7, 12px);
  grid-auto-flow: column;
  gap: 3px;
}

.heat-cell {
  min-width: 10px;
  height: 12px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--ink-900) 6%, transparent);
  border-radius: 2px;
  background: var(--ink-100);
  cursor: pointer;
}

.heat-cell:disabled {
  cursor: default;
  opacity: 0.18;
}

.heat-cell.is-healthy { background: color-mix(in srgb, var(--teal-500) 28%, var(--surface)); }
.heat-cell.is-info { background: color-mix(in srgb, var(--color-info, #4a8fd4) 55%, var(--surface)); }
.heat-cell.is-warning { background: var(--amber-600); }
.heat-cell.is-major { background: color-mix(in srgb, var(--amber-600) 45%, var(--red-600)); }
.heat-cell.is-critical { background: var(--red-600); }
.heat-cell.is-selected { outline: 2px solid var(--teal-600); outline-offset: 1px; }

.heat-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
}

.heat-legend i {
  width: 10px;
  height: 10px;
  display: inline-block;
  border-radius: 2px;
  background: var(--ink-100);
}

.heat-legend .is-healthy { background: color-mix(in srgb, var(--teal-500) 28%, var(--surface)); }
.heat-legend .is-warning { background: var(--amber-600); }
.heat-legend .is-major { background: color-mix(in srgb, var(--amber-600) 45%, var(--red-600)); }
.heat-legend .is-critical { background: var(--red-600); }

.event-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ink-100);
  background: var(--ink-50);
}

.event-range-tabs,
.event-filter-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.event-range-tabs button {
  height: 28px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 650;
}

.event-range-tabs button.is-active {
  border-color: var(--ink-200);
  background: var(--surface);
  color: var(--ink-900);
}

.filter-select { width: 132px; }
.service-search { width: 220px; }

.event-list { min-width: 0; }

.event-list-error {
  padding: 12px 14px;
  background: var(--red-100);
  color: var(--red-600);
  font-size: 12px;
}

.event-pagination {
  min-height: 48px;
  padding: 8px 14px;
  border-top: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.event-row,
.service-row {
  min-width: 0;
  display: grid;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 0;
  border-bottom: 1px solid var(--ink-100);
  background: transparent;
  text-align: left;
}

.event-row {
  width: 100%;
  grid-template-columns: 86px 132px minmax(180px, 1.4fr) minmax(140px, 1fr) 78px;
  cursor: pointer;
  color: inherit;
}

.event-row:last-child,
.service-row:last-child { border-bottom: 0; }
.event-row:hover,
.service-row:hover { background: var(--ink-50); }

.event-row strong,
.service-row strong { display: block; font-size: 13px; }
.event-row small,
.service-row small {
  display: block;
  margin-top: 3px;
  color: var(--ink-400);
  font-size: 11px;
}

.event-time {
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: 11px;
}

.tone-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  background: var(--ink-50);
  color: var(--ink-600);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
}

.tone-badge.is-critical,
.tone-badge.is-degraded { background: var(--red-100); color: var(--red-600); }
.tone-badge.is-major,
.tone-badge.is-warning,
.tone-badge.is-unknown { background: var(--amber-100); color: var(--amber-600); }
.tone-badge.is-healthy,
.tone-badge.is-running { background: var(--teal-50); color: var(--teal-700); }
.tone-badge.is-info { background: color-mix(in srgb, var(--color-info, #4a8fd4) 16%, var(--surface)); color: var(--color-info, #3d7bb8); }

.observe-empty {
  margin: 0;
  padding: 36px 16px;
  color: var(--ink-400);
  text-align: center;
  font-size: 13px;
}

.service-section { overflow: hidden; }

.service-table { min-width: 0; overflow-x: auto; }

.service-row {
  grid-template-columns: minmax(160px, 1.3fr) 72px 88px 92px 56px minmax(130px, .9fr) auto;
  font-size: 12px;
  color: var(--ink-700);
}

.service-row.is-head {
  min-height: 34px;
  background: var(--ink-50);
  color: var(--ink-400);
  font-size: 11px;
  font-weight: 650;
}

.service-row.is-head:hover { background: var(--ink-50); }

.service-row .is-hot { color: var(--red-600); font-weight: 700; }

.row-action {
  height: 28px;
  padding: 0 8px;
  color: var(--teal-700);
  font-size: 12px;
  font-weight: 650;
}

.row-action:hover { text-decoration: underline; }

@media (max-width: 960px) {
  .event-row,
  .service-row,
  .service-row.is-head {
    grid-template-columns: minmax(140px, 1fr) auto;
  }
}
</style>
