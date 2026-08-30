<script setup lang="ts">
import { CalendarDays } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  MonitorAlertItem,
  MonitorAlertSeverity,
  MonitorHostEventCalendarDay,
  MonitorHostEventCalendarResponse,
  MonitorPlatformEventItem,
} from "../../../shared/monitor-alerts";
import { api } from "../../api";
import { currentLocale, translate as tr } from "../../i18n";
import { monitorAlertRuleLabel } from "../../monitor-alert-copy";
import { platformEventCalendarCacheKey, readMonitorUiCache, writeMonitorUiCache } from "../../monitor-ui-cache";
import type { MonitoringServiceCard } from "./ServiceApmPanel.vue";

const props = defineProps<{
  environmentId: string;
  environments: Array<{ id: string; name: string }>;
  services: MonitoringServiceCard[];
  alerts: MonitorAlertItem[];
}>();

const emit = defineEmits<{
  "open-event": [event: MonitorPlatformEventItem];
  "open-service": [service: MonitoringServiceCard];
}>();

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const heatRangeDays = ref(365);
const eventRangeDays = ref(1);
const selectedHeatDate = ref("");
const eventEnvironmentId = ref("");
const eventSeverity = ref<"all" | MonitorAlertSeverity>("all");
const eventStatus = ref<"all" | "active" | "recovered" | "event">("all");
const serviceQuery = ref("");
const calendars = ref<MonitorHostEventCalendarResponse[]>([]);
const calendarLoading = ref(false);
const events = ref<MonitorPlatformEventItem[]>([]);
const eventsLoading = ref(false);
const eventsError = ref("");
let calendarAbort: AbortController | null = null;
let eventsAbort: AbortController | null = null;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(key: string, delta: number) {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return localDateKey(new Date(year, month - 1, day + delta));
}

const todayKey = localDateKey(new Date());

function offsetMonth(monthKey: string, delta: number) {
  const [year, month] = monthKey.split("-").map(Number) as [number, number];
  const next = new Date(year, month - 1 + delta, 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
}

const neededMonths = computed(() => {
  const start = addDays(todayKey, -(heatRangeDays.value - 1));
  const months: string[] = [];
  let cursor = start.slice(0, 7);
  const end = todayKey.slice(0, 7);
  while (cursor <= end) {
    months.push(cursor);
    cursor = offsetMonth(cursor, 1);
  }
  return months;
});

const dayMap = computed(() => {
  const map = new Map<string, MonitorHostEventCalendarDay>();
  for (const calendar of calendars.value) {
    for (const day of calendar.days) map.set(day.date, day);
  }
  return map;
});

const heatmapWeeks = computed(() => {
  const startKey = addDays(todayKey, -(heatRangeDays.value - 1));
  const [year, month, day] = startKey.split("-").map(Number) as [number, number, number];
  const leading = (new Date(year, month - 1, day).getDay() + 6) % 7;
  const total = heatRangeDays.value + leading;
  const padded = Math.ceil(total / 7) * 7;
  const cells: Array<MonitorHostEventCalendarDay | null> = [];
  for (let index = 0; index < padded; index += 1) {
    if (index < leading) {
      cells.push(null);
      continue;
    }
    const key = addDays(startKey, index - leading);
    if (key > todayKey) {
      cells.push(null);
      continue;
    }
    cells.push(dayMap.value.get(key) ?? {
      date: key,
      future: key > todayKey,
      coverageRatio: 1,
      newEventCount: 0,
      activeEventCount: 0,
      infoCount: 0,
      warningCount: 0,
      majorCount: 0,
      criticalCount: 0,
      affectedMinutes: 0,
      peakSeverity: null,
      burdenScore: 0,
    });
  }
  return Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
});

const monthLabels = computed(() => {
  const formatter = new Intl.DateTimeFormat(currentLocale(), { month: "short" });
  const labels: Array<{ key: string; label: string }> = [];
  for (const week of heatmapWeeks.value) {
    const first = week.find((day) => day);
    if (!first) continue;
    const monthKey = first.date.slice(0, 7);
    if (labels.at(-1)?.key === monthKey) continue;
    const [year, month] = monthKey.split("-").map(Number) as [number, number];
    labels.push({ key: monthKey, label: formatter.format(new Date(year, month - 1, 1)) });
  }
  return labels;
});

const weekdayLabels = computed(() => {
  const monday = Date.UTC(2026, 7, 24);
  return Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(currentLocale(), { weekday: "narrow", timeZone: "UTC" })
    .format(new Date(monday + index * 24 * 60 * 60 * 1000)));
});

function cellTone(day: MonitorHostEventCalendarDay | null) {
  if (!day || day.future) return "is-empty";
  if (day.peakSeverity) return `is-${day.peakSeverity}`;
  return "is-healthy";
}

function cellTitle(day: MonitorHostEventCalendarDay | null) {
  if (!day) return "";
  if (!day.activeEventCount && !day.newEventCount) return `${day.date}`;
  return `${day.date} · ${day.newEventCount || day.activeEventCount}`;
}

async function loadCalendar() {
  calendarAbort?.abort();
  calendarAbort = new AbortController();
  const signal = calendarAbort.signal;
  const months = neededMonths.value;
  const cacheKey = platformEventCalendarCacheKey(props.environmentId, timezone, months);
  const cached = readMonitorUiCache<MonitorHostEventCalendarResponse[]>(cacheKey);
  calendars.value = cached ?? [];
  calendarLoading.value = !cached;
  try {
    const results = await Promise.all(months.map((month) => {
      const query = new URLSearchParams({ month, timezone });
      if (props.environmentId) query.set("environmentId", props.environmentId);
      return api<MonitorHostEventCalendarResponse>(`/api/v1/monitoring/event-calendar?${query}`, { signal });
    }));
    if (signal.aborted) return;
    calendars.value = results;
    writeMonitorUiCache(cacheKey, results);
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    if (!cached) calendars.value = [];
  } finally {
    if (calendarAbort?.signal === signal) calendarLoading.value = false;
  }
}

async function loadEvents() {
  eventsAbort?.abort();
  eventsAbort = new AbortController();
  const signal = eventsAbort.signal;
  eventsLoading.value = true;
  eventsError.value = "";
  const query = new URLSearchParams({ timezone });
  const environmentId = eventEnvironmentId.value || props.environmentId;
  if (environmentId) query.set("environmentId", environmentId);
  if (eventSeverity.value !== "all") query.set("severity", eventSeverity.value);
  if (eventStatus.value !== "all") query.set("status", eventStatus.value);
  if (selectedHeatDate.value) {
    query.set("date", selectedHeatDate.value);
  } else {
    const fromKey = addDays(todayKey, -(eventRangeDays.value - 1));
    const [year, month, day] = fromKey.split("-").map(Number) as [number, number, number];
    query.set("from", new Date(year, month - 1, day).toISOString());
    query.set("to", new Date().toISOString());
  }
  try {
    const response = await api<{ items: MonitorPlatformEventItem[] }>(`/api/v1/monitoring/events?${query}`, { signal });
    if (!signal.aborted) events.value = response.items;
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    events.value = [];
    eventsError.value = caught instanceof Error ? caught.message : tr("读取告警事件失败");
  } finally {
    if (eventsAbort?.signal === signal) eventsLoading.value = false;
  }
}

watch([heatRangeDays, () => props.environmentId], loadCalendar, { immediate: true });
watch([selectedHeatDate, eventRangeDays, eventEnvironmentId, eventSeverity, eventStatus, () => props.environmentId], loadEvents, { immediate: true });
watch(() => props.environmentId, (value) => {
  eventEnvironmentId.value = value;
});
onBeforeUnmount(() => {
  calendarAbort?.abort();
  eventsAbort?.abort();
});

function selectHeatDate(day: MonitorHostEventCalendarDay | null) {
  if (!day) return;
  selectedHeatDate.value = selectedHeatDate.value === day.date ? "" : day.date;
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
  const at = new Date(event.triggeredAt);
  return `${localDateKey(at)} ${at.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function eventTarget(event: MonitorPlatformEventItem) {
  return event.serviceName || event.connectionName || event.targetName;
}

const activeAlertsByService = computed(() => {
  const map = new Map<string, { count: number; peak: MonitorAlertSeverity | null }>();
  for (const alert of props.alerts) {
    if (alert.status !== "active" || !alert.serviceId) continue;
    const current = map.get(alert.serviceId) ?? { count: 0, peak: null };
    current.count += 1;
    if (!current.peak || ["info", "warning", "major", "critical"].indexOf(alert.peakSeverity) > ["info", "warning", "major", "critical"].indexOf(current.peak)) {
      current.peak = alert.peakSeverity;
    }
    map.set(alert.serviceId, current);
  }
  return map;
});

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
  const item = activeAlertsByService.value.get(service.id);
  if (!item?.count) return "0";
  return item.peak ? `${item.count} ${severityLabel(item.peak)}` : String(item.count);
}
</script>

<template>
  <section class="alert-service-panel">
    <section class="observe-panel">
      <header class="observe-panel__head">
        <div class="observe-panel__title">
          <span class="observe-panel__icon"><CalendarDays :size="16" /></span>
          <strong>{{ $t('告警事件热力矩阵') }}</strong>
        </div>
        <div class="range-pills" role="group" :aria-label="$t('热力矩阵时间范围')">
          <button type="button" :class="{ 'is-active': heatRangeDays === 30 }" @click="heatRangeDays = 30">1M</button>
          <button type="button" :class="{ 'is-active': heatRangeDays === 90 }" @click="heatRangeDays = 90">3M</button>
          <button type="button" :class="{ 'is-active': heatRangeDays === 180 }" @click="heatRangeDays = 180">6M</button>
          <button type="button" :class="{ 'is-active': heatRangeDays === 365 }" @click="heatRangeDays = 365">12M</button>
        </div>
      </header>
      <div class="heat-body" :class="{ 'is-loading': calendarLoading }">
        <div class="heat-months">
          <span v-for="item in monthLabels" :key="item.key">{{ item.label }}</span>
        </div>
        <div class="heat-plot">
          <div class="heat-weekdays" aria-hidden="true">
            <span v-for="(label, index) in weekdayLabels" :key="index">{{ index % 2 === 0 ? label : "" }}</span>
          </div>
          <div class="heat-grid" :style="{ gridTemplateColumns: `repeat(${heatmapWeeks.length}, minmax(10px, 1fr))` }">
            <template v-for="(week, weekIndex) in heatmapWeeks" :key="weekIndex">
              <button
                v-for="(day, dayIndex) in week"
                :key="`${weekIndex}-${dayIndex}`"
                type="button"
                class="heat-cell"
                :class="[cellTone(day), { 'is-selected': day && selectedHeatDate === day.date }]"
                :disabled="!day"
                :title="cellTitle(day)"
                :aria-label="cellTitle(day)"
                @click="selectHeatDate(day)"
              />
            </template>
          </div>
        </div>
      </div>
      <footer class="observe-panel__foot">
        <div class="heat-legend">
          <span>{{ $t('低') }}</span>
          <i class="is-healthy"></i>
          <i class="is-warning"></i>
          <i class="is-major"></i>
          <i class="is-critical"></i>
          <span>{{ $t('高') }}</span>
        </div>
      </footer>
    </section>

    <section class="observe-panel">
      <header class="observe-panel__head">
        <div>
          <h3>{{ $t('告警事件') }}</h3>
          <small>{{ eventRangeLabel }} · {{ events.length }}</small>
        </div>
      </header>
      <div class="event-filter-bar">
        <div class="event-range-tabs" role="group" :aria-label="$t('告警事件时间范围')">
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 1 }" @click="selectedHeatDate = ''; eventRangeDays = 1">{{ $t('今天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 7 }" @click="selectedHeatDate = ''; eventRangeDays = 7">{{ $t('近 7 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 30 }" @click="selectedHeatDate = ''; eventRangeDays = 30">{{ $t('近 30 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 90 }" @click="selectedHeatDate = ''; eventRangeDays = 90">{{ $t('近 90 天') }}</button>
          <button type="button" :class="{ 'is-active': !selectedHeatDate && eventRangeDays === 365 }" @click="selectedHeatDate = ''; eventRangeDays = 365">{{ $t('近一年') }}</button>
        </div>
        <div class="event-filter-controls">
          <el-select v-model="eventEnvironmentId" clearable :placeholder="$t('全部环境')" class="filter-select">
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
      <p v-if="eventsError" class="observe-empty">{{ eventsError }}</p>
      <div v-else-if="eventsLoading && !events.length" class="observe-empty">{{ $t('正在读取告警事件') }}</div>
      <div v-else-if="!events.length" class="observe-empty">{{ $t('当前条件下没有告警事件') }}</div>
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
          <span :class="{ 'is-hot': (activeAlertsByService.get(service.id)?.count ?? 0) > 0 }">{{ serviceAlertText(service) }}</span>
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
