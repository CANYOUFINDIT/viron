<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  MonitorAlertSeverity,
  MonitorPlatformEventItem,
  MonitorPlatformEventListResponse,
} from "../../../shared/monitor-alerts";
import { api } from "../../api";
import { currentLocale, translate as tr } from "../../i18n";
import { monitorAlertBody, monitorAlertRuleLabel } from "../../monitor-alert-copy";
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
const topEvents = ref<MonitorPlatformEventItem[]>([]);
const topEventTotal = ref(0);
const topEventsLoading = ref(false);
const topEventsError = ref("");
const allEventsOpen = ref(false);
const allEvents = ref<MonitorPlatformEventItem[]>([]);
const allEventTotal = ref(0);
const allEventPage = ref(1);
const allEventPageSize = 50;
const allEventsLoading = ref(false);
const allEventsError = ref("");
const serviceQuery = ref("");
const todayKey = monitorAlertLocalDateKey(new Date().toISOString());
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let eventsAbort: AbortController | null = null;
let allEventsAbort: AbortController | null = null;

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

function eventQuery(options: {
  page: number;
  pageSize: number;
  order: "recent" | "priority";
  environmentId?: string;
  severity?: "all" | MonitorAlertSeverity;
  status?: "all" | "active" | "recovered" | "event";
}) {
  const query = new URLSearchParams({
    timezone,
    severity: options.severity ?? "all",
    status: options.status ?? "all",
    order: options.order,
    page: String(options.page),
    pageSize: String(options.pageSize),
  });
  if (selectedHeatDate.value) query.set("date", selectedHeatDate.value);
  else {
    query.set("from", boundaryIso(rangeStartKey.value));
    query.set("to", boundaryIso(rangeEndKey.value, 1));
  }
  if (options.environmentId) query.set("environmentId", options.environmentId);
  return query;
}

async function loadTopEvents() {
  eventsAbort?.abort();
  eventsAbort = new AbortController();
  const controller = eventsAbort;
  topEventsLoading.value = true;
  topEventsError.value = "";
  try {
    const query = eventQuery({
      page: 1,
      pageSize: 5,
      order: "priority",
      environmentId: props.environmentId,
    });
    const response = await api<MonitorPlatformEventListResponse>(`/api/v1/monitoring/events?${query}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    topEvents.value = response.items;
    topEventTotal.value = response.total;
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    topEvents.value = [];
    topEventTotal.value = 0;
    topEventsError.value = caught instanceof Error ? caught.message : tr("读取系统告警事件失败");
  } finally {
    if (eventsAbort === controller) topEventsLoading.value = false;
  }
}

async function loadAllEvents() {
  if (!allEventsOpen.value) return;
  allEventsAbort?.abort();
  allEventsAbort = new AbortController();
  const controller = allEventsAbort;
  allEventsLoading.value = true;
  allEventsError.value = "";
  try {
    const query = eventQuery({
      page: allEventPage.value,
      pageSize: allEventPageSize,
      order: "recent",
      environmentId: effectiveEventEnvironmentId.value,
      severity: eventSeverity.value,
      status: eventStatus.value,
    });
    const response = await api<MonitorPlatformEventListResponse>(`/api/v1/monitoring/events?${query}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    allEvents.value = response.items;
    allEventTotal.value = response.total;
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    allEvents.value = [];
    allEventTotal.value = 0;
    allEventsError.value = caught instanceof Error ? caught.message : tr("读取系统告警事件失败");
  } finally {
    if (allEventsAbort === controller) allEventsLoading.value = false;
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

function eventBody(event: MonitorPlatformEventItem) {
  return monitorAlertBody(event, event.status === "recovered" ? "recovered" : "active");
}

function openAllEvents() {
  allEventsOpen.value = true;
}

function openDrawerEvent(event: MonitorPlatformEventItem) {
  allEventsOpen.value = false;
  emit("open-event", event);
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
    eventRangeDays.value,
    selectedHeatDate.value,
    props.refreshKey,
  ],
  () => {
    void loadTopEvents();
    if (!allEventsOpen.value) return;
    if (allEventPage.value !== 1) allEventPage.value = 1;
    else void loadAllEvents();
  },
  { immediate: true },
);
watch(
  () => [eventEnvironmentId.value, eventSeverity.value, eventStatus.value],
  () => {
    if (!allEventsOpen.value) return;
    if (allEventPage.value !== 1) allEventPage.value = 1;
    else void loadAllEvents();
  },
);
watch(allEventsOpen, (open) => {
  if (!open) {
    allEventsAbort?.abort();
    return;
  }
  if (allEventPage.value !== 1) allEventPage.value = 1;
  else void loadAllEvents();
});
watch(allEventPage, () => void loadAllEvents());
onBeforeUnmount(() => {
  eventsAbort?.abort();
  allEventsAbort?.abort();
});
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

    <div class="observe-split">
    <section class="observe-panel priority-event-panel" v-loading="topEventsLoading">
      <header class="observe-panel__head">
        <div>
          <h3>{{ $t('重点告警事件') }}</h3>
          <small>{{ eventRangeLabel }} · {{ $t('按严重等级展示最需要关注的 5 条') }}</small>
        </div>
        <button type="button" class="all-events-link" @click="openAllEvents">
          <span>{{ $t('查看全部系统告警') }}</span>
          <b>{{ topEventTotal }}</b>
          <i>→</i>
        </button>
      </header>
      <div class="event-filter-bar">
        <div class="event-range-tabs" role="group" :aria-label="$t('告警事件时间范围')">
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 1 }" @click="chooseRange(1)">{{ $t('今天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 7 }" @click="chooseRange(7)">{{ $t('近 7 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 30 }" @click="chooseRange(30)">{{ $t('近 30 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 90 }" @click="chooseRange(90)">{{ $t('近 90 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 365 }" @click="chooseRange(365)">{{ $t('近一年') }}</button>
        </div>

      </div>
      <div v-if="topEventsError" class="event-list-error">{{ topEventsError }}</div>
      <div v-else-if="!topEvents.length && !topEventsLoading" class="observe-empty compact">{{ $t('当前时间范围没有告警事件') }}</div>
      <div v-else class="event-list">
        <div class="event-row is-head">
          <span>{{ $t('状态') }}</span>
          <span>{{ $t('时间') }}</span>
          <span>{{ $t('事件') }}</span>
          <span>{{ $t('目标') }}</span>
          <span></span>
        </div>
        <button
          v-for="event in topEvents"
          :key="event.id"
          type="button"
          class="event-row"
          @click="emit('open-event', event)"
        >
          <span class="tone-badge" :class="`is-${event.peakSeverity}`">{{ severityLabel(event.peakSeverity) }}</span>
          <span class="event-time">{{ eventTime(event) }}</span>
          <span>
            <strong>{{ monitorAlertRuleLabel(event) }}</strong>
            <small class="event-message">
              {{ eventBody(event) }}<template v-if="event.occurrenceCount > 1"> · {{ $t('合并 {0} 次短时复发', [event.occurrenceCount - 1]) }}</template>
            </small>
          </span>
          <span>
            <strong>{{ eventTarget(event) }}</strong>
            <small>{{ event.environmentName }}</small>
          </span>
          <span class="tone-badge" :class="event.status === 'active' ? 'is-critical' : event.status === 'recovered' ? 'is-healthy' : 'is-info'">{{ statusLabel(event.status) }}</span>
        </button>
      </div>
    </section>

    <section class="observe-panel service-section">
      <header class="observe-panel__head">
        <h3>{{ $t('服务') }}</h3>
        <el-input v-model="serviceQuery" clearable class="service-search" :placeholder="$t('按服务名或环境搜索')" />
      </header>
      <div class="service-table">
        <div class="service-row is-head">
          <span>{{ $t('服务 / 环境') }}</span>
          <span>{{ $t('运行状态') }}</span>
          <span>{{ $t('活动告警') }}</span>
          <span></span>
        </div>
        <div v-if="!visibleServices.length" class="observe-empty">{{ $t('暂无服务实例') }}</div>
        <div v-for="service in visibleServices" :key="service.id" class="service-row">
          <div>
            <strong>{{ service.name }}</strong>
            <small>{{ service.environmentName }} · {{ service.runningCount }} / {{ service.deploymentCount }}</small>
          </div>
          <span><b class="tone-badge" :class="`is-${service.health}`">{{ healthLabel(service.health) }}</b></span>
          <span :class="{ 'is-hot': (service.activeAlertCount ?? 0) > 0 }">{{ serviceAlertText(service) }}</span>
          <button type="button" class="row-action" @click="emit('open-service', service)">{{ $t('服务维护') }} →</button>
        </div>
      </div>
    </section>
    </div>

    <el-drawer
      v-model="allEventsOpen"
      :title="$t('全部系统告警')"
      size="min(1080px, 96vw)"
      append-to-body
      destroy-on-close
      class="system-event-drawer"
    >
      <div class="drawer-event-context">
        <div>
          <strong>{{ eventRangeLabel }}</strong>
          <span>{{ allEventTotal }} {{ $t('条系统事件记录') }}</span>
        </div>
        <small>{{ $t('系统历史数据，不受个人通知读取或清除影响') }}</small>
      </div>
      <div class="drawer-event-filters">
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
      <div class="drawer-event-list" v-loading="allEventsLoading">
        <div v-if="allEventsError" class="event-list-error">{{ allEventsError }}</div>
        <div v-else-if="!allEvents.length && !allEventsLoading" class="observe-empty">{{ $t('当前条件下没有告警事件') }}</div>
        <div v-else class="event-list">
          <button
            v-for="event in allEvents"
            :key="event.id"
            type="button"
            class="event-row"
            @click="openDrawerEvent(event)"
          >
            <span class="tone-badge" :class="`is-${event.peakSeverity}`">{{ severityLabel(event.peakSeverity) }}</span>
            <span class="event-time">{{ eventTime(event) }}</span>
            <span>
              <strong>{{ monitorAlertRuleLabel(event) }}</strong>
              <small class="event-message">
                {{ eventBody(event) }}<template v-if="event.occurrenceCount > 1"> · {{ $t('合并 {0} 次短时复发', [event.occurrenceCount - 1]) }}</template>
              </small>
            </span>
            <span>
              <strong>{{ eventTarget(event) }}</strong>
              <small>{{ event.environmentName }}</small>
            </span>
            <span class="tone-badge" :class="event.status === 'active' ? 'is-critical' : event.status === 'recovered' ? 'is-healthy' : 'is-info'">{{ statusLabel(event.status) }}</span>
          </button>
        </div>
        <footer v-if="allEventTotal > allEventPageSize" class="event-pagination">
          <el-pagination
            v-model:current-page="allEventPage"
            :page-size="allEventPageSize"
            :total="allEventTotal"
            layout="total, prev, pager, next"
            background
          />
        </footer>
      </div>
    </el-drawer>
  </section>
</template>

<style scoped>
.alert-service-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.observe-split {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  gap: 16px;
  align-items: stretch;
}

.observe-panel {
  min-width: 0;
  min-height: 320px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-rule, var(--ink-100));
  border-radius: 12px;
  background: var(--color-paper-raised, var(--surface));
  overflow: hidden;
}

.observe-panel__head {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
}

.observe-panel__head h3,
.observe-panel__head small {
  margin: 0;
}

.observe-panel__head h3 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.observe-panel__head small {
  display: block;
  margin-top: 2px;
  color: var(--ink-400);
  font-size: 11px;
}

.all-events-link {
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--color-rule, var(--ink-100));
  border-radius: var(--radius-control, 7px);
  background: transparent;
  color: var(--ink-700);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: background var(--dur-micro, 120ms) var(--ease-out, ease), border-color var(--dur-micro, 120ms) var(--ease-out, ease);
}

.all-events-link b {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--ink-50);
  color: var(--ink-600);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
}

.all-events-link i { font-style: normal; color: var(--ink-400); }
.all-events-link:hover { background: var(--ink-50); border-color: var(--color-rule-strong, var(--ink-200)); }
.all-events-link:focus-visible { outline: 2px solid var(--teal-500); outline-offset: 1px; }

.event-range-tabs button,
.row-action {
  border: 0;
  background: transparent;
  color: var(--ink-500);
  cursor: pointer;
}

.event-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
}

.event-range-tabs {
  flex: 1;
  min-width: min(100%, 420px);
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border-radius: var(--radius-control, 7px);
  background: var(--color-paper-muted, var(--ink-50));
}

.event-filter-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.priority-order-note {
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: nowrap;
}

.event-range-tabs button {
  height: 28px;
  padding: 0 8px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
  transition: background var(--dur-micro, 120ms) var(--ease-out, ease), color var(--dur-micro, 120ms) var(--ease-out, ease);
}

.event-range-tabs button:hover { color: var(--ink-800); }

.event-range-tabs button.is-active {
  background: var(--surface);
  color: var(--ink-900);
  box-shadow: var(--shadow-whisper, var(--shadow-sm));
}

.event-range-tabs button:focus-visible {
  outline: 2px solid var(--teal-500);
  outline-offset: 1px;
}

.filter-select { width: 132px; }

.event-list { min-width: 0; }

.event-list-error {
  padding: 12px 16px;
  color: var(--red-600);
  font-size: 12px;
}

.event-pagination {
  min-height: 48px;
  padding: 8px 14px;
  border-top: 1px solid var(--color-rule, var(--ink-100));
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.drawer-event-context {
  min-height: 44px;
  margin-bottom: 12px;
  padding: 0 0 12px;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.drawer-event-context > div {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.drawer-event-context strong { font-size: 14px; font-weight: 650; }
.drawer-event-context span,
.drawer-event-context small { color: var(--ink-400); font-size: 11px; }

.drawer-event-filters {
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.drawer-event-list {
  min-height: 180px;
  overflow: hidden;
  border: 1px solid var(--color-rule, var(--ink-100));
  border-radius: var(--radius-panel, 8px);
}

.event-row,
.service-row {
  min-width: 0;
  display: grid;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  border: 0;
  border-bottom: 1px solid var(--color-rule, var(--ink-100));
  background: transparent;
  text-align: left;
}

.event-row {
  width: 100%;
  grid-template-columns: 92px 132px minmax(180px, 1.4fr) minmax(140px, 1fr) 72px;
  cursor: pointer;
  color: inherit;
  transition: background var(--dur-micro, 120ms) var(--ease-out, ease);
}

.event-row:last-child,
.service-row:last-child { border-bottom: 0; }
.event-row:hover,
.service-row:hover { background: var(--ink-50); }

.event-row.is-head,
.service-row.is-head {
  min-height: 32px;
  padding-top: 8px;
  padding-bottom: 8px;
  background: var(--color-paper-muted, var(--ink-50));
  color: var(--ink-400);
  font-size: 11px;
  font-weight: 600;
}

.event-row.is-head:hover,
.service-row.is-head:hover { background: var(--color-paper-muted, var(--ink-50)); }
.event-row:focus-visible {
  outline: 2px solid var(--teal-500);
  outline-offset: -2px;
}

.event-row strong,
.service-row strong { display: block; font-size: 13px; font-weight: 600; }
.event-row small,
.service-row small {
  display: block;
  margin-top: 3px;
  color: var(--ink-400);
  font-size: 11px;
}

.event-row .event-message {
  color: var(--ink-500);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.event-time {
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: 11px;
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
.tone-badge.is-degraded { color: var(--red-600); }
.tone-badge.is-major,
.tone-badge.is-warning,
.tone-badge.is-unknown { color: var(--amber-600); }
.tone-badge.is-healthy,
.tone-badge.is-running { color: var(--teal-700); }
.tone-badge.is-info { color: var(--color-info, #3d7bb8); }
.tone-badge.is-disabled,
.tone-badge.is-empty { color: var(--ink-400); }

.observe-empty {
  margin: 0;
  flex: 1;
  min-height: 160px;
  padding: 24px 16px;
  color: var(--ink-400);
  display: grid;
  place-items: center;
  text-align: center;
  font-size: 13px;
}

.observe-empty.compact { min-height: 160px; padding: 24px 16px; }

.service-section { overflow: hidden; }
.event-list,
.service-table { flex: 1; }

.service-table { min-width: 0; overflow-x: auto; }

.service-row {
  grid-template-columns: minmax(0, 1.4fr) 88px 72px auto;
  font-size: 12px;
  color: var(--ink-700);
}

.service-search { width: min(220px, 100%); }

.service-row .is-hot { color: var(--red-600); font-weight: 650; }

.row-action {
  height: 28px;
  padding: 0 4px;
  color: var(--ink-700);
  font-size: 12px;
  font-weight: 600;
}

.row-action:hover { color: var(--ink-900); text-decoration: underline; }
.row-action:focus-visible { outline: 2px solid var(--teal-500); outline-offset: 2px; }

@media (max-width: 1100px) {
  .observe-split { grid-template-columns: 1fr; }
  .observe-panel { min-height: 0; }
}

@media (max-width: 960px) {
  .observe-panel__head,
  .drawer-event-context { align-items: flex-start; flex-direction: column; }

  .event-range-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }

  .event-row,
  .event-row.is-head,
  .service-row,
  .service-row.is-head {
    grid-template-columns: minmax(140px, 1fr) auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .all-events-link,
  .event-range-tabs button,
  .event-row { transition: none; }
}
</style>
