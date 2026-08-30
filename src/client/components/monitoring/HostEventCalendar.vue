<script setup lang="ts">
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, RefreshCw } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  MonitorAlertSeverity,
  MonitorHostEventCalendarDay,
  MonitorHostEventCalendarResponse,
  MonitorHostEventCalendarSummary,
  MonitorHostEventItem,
} from "../../../shared/monitor-alerts";
import { api } from "../../api";
import { currentLocale, translate as tr } from "../../i18n";
import { monitorAlertRuleLabel } from "../../monitor-alert-copy";

const props = defineProps<{ environmentId: string; hostId: string }>();

const RANGE_MONTHS = 12;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const today = new Date();
const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
const anchorMonth = ref(currentMonth);
const loading = ref(false);
const error = ref("");
const calendars = ref<MonitorHostEventCalendarResponse[]>([]);
const drawerOpen = ref(false);
const selectedDate = ref("");
const events = ref<MonitorHostEventItem[]>([]);
const eventsLoading = ref(false);
let calendarAbort: AbortController | null = null;
let eventsAbort: AbortController | null = null;

function offsetMonth(monthKey: string, delta: number) {
  const [year, monthNumber] = monthKey.split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

const visibleMonths = computed(() => Array.from(
  { length: RANGE_MONTHS },
  (_, index) => offsetMonth(anchorMonth.value, index - RANGE_MONTHS + 1),
));
const weekdayLabels = computed(() => {
  const sunday = Date.UTC(2026, 7, 23);
  return Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(currentLocale(), { weekday: "narrow", timeZone: "UTC" })
    .format(new Date(sunday + index * 24 * 60 * 60 * 1000)));
});
const rangeLabel = computed(() => {
  const formatter = new Intl.DateTimeFormat(currentLocale(), { year: "numeric", month: "short", timeZone: "UTC" });
  const first = new Date(`${visibleMonths.value[0]}-01T00:00:00.000Z`);
  const last = new Date(`${visibleMonths.value.at(-1)}-01T00:00:00.000Z`);
  return `${formatter.format(first)} – ${formatter.format(last)}`;
});
const allDays = computed(() => calendars.value.flatMap((item) => item.days));
const heatmapWeeks = computed<Array<Array<MonitorHostEventCalendarDay | null>>>(() => {
  if (!allDays.value.length) return [];
  const leading = new Date(`${allDays.value[0]!.date}T00:00:00.000Z`).getUTCDay();
  const cells: Array<MonitorHostEventCalendarDay | null> = [
    ...Array.from({ length: leading }, () => null),
    ...allDays.value,
  ];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
});
const monthMarkers = computed(() => {
  if (!allDays.value.length) return [];
  const leading = new Date(`${allDays.value[0]!.date}T00:00:00.000Z`).getUTCDay();
  const formatter = new Intl.DateTimeFormat(currentLocale(), { month: "short", timeZone: "UTC" });
  return visibleMonths.value.map((monthKey) => {
    const dayIndex = allDays.value.findIndex((day) => day.date.startsWith(monthKey));
    return {
      month: monthKey,
      label: formatter.format(new Date(`${monthKey}-01T00:00:00.000Z`)),
      week: dayIndex < 0 ? 0 : Math.floor((leading + dayIndex) / 7),
    };
  });
});
const summary = computed<MonitorHostEventCalendarSummary>(() => calendars.value.reduce((total, item) => ({
  healthyDays: total.healthyDays + item.summary.healthyDays,
  affectedDays: total.affectedDays + item.summary.affectedDays,
  noDataDays: total.noDataDays + item.summary.noDataDays,
  criticalEvents: total.criticalEvents + item.summary.criticalEvents,
  totalEvents: total.totalEvents + item.summary.totalEvents,
  affectedMinutes: total.affectedMinutes + item.summary.affectedMinutes,
  meanRecoveryMinutes: null,
}), {
  healthyDays: 0,
  affectedDays: 0,
  noDataDays: 0,
  criticalEvents: 0,
  totalEvents: 0,
  affectedMinutes: 0,
  meanRecoveryMinutes: null,
}));
const canShiftForward = computed(() => anchorMonth.value < currentMonth);

function shiftRange(years: number) {
  const next = offsetMonth(anchorMonth.value, years * RANGE_MONTHS);
  anchorMonth.value = next > currentMonth ? currentMonth : next;
}

function severityLabel(value: MonitorAlertSeverity) {
  return ({ info: tr("提示"), warning: tr("警告"), major: tr("高危"), critical: tr("严重") })[value];
}

function dayTone(day: MonitorHostEventCalendarDay) {
  if (day.future) return "is-future";
  if (day.peakSeverity) return `is-${day.peakSeverity}`;
  if (day.coverageRatio < 0.8) return "is-no-data";
  return "is-healthy";
}

function dayIntensity(day: MonitorHostEventCalendarDay) {
  if (day.burdenScore >= 16) return "is-intensity-4";
  if (day.burdenScore >= 8) return "is-intensity-3";
  if (day.burdenScore >= 3) return "is-intensity-2";
  return "is-intensity-1";
}

function dayTitle(day: MonitorHostEventCalendarDay) {
  if (day.future) return day.date;
  if (day.coverageRatio < 0.8 && !day.activeEventCount) {
    return tr("{0} · 无数据 · 采集覆盖 {1}%", [day.date, Math.round(day.coverageRatio * 100)]);
  }
  if (!day.activeEventCount) return tr("{0} · 健康 · 采集覆盖 {1}%", [day.date, Math.round(day.coverageRatio * 100)]);
  return tr("{0} · {1} · {2} 个事件 · 影响 {3} 分钟", [
    day.date,
    severityLabel(day.peakSeverity ?? "warning"),
    day.activeEventCount,
    day.affectedMinutes,
  ]);
}

function isInteractiveDay(day: MonitorHostEventCalendarDay) {
  return !day.future && (day.activeEventCount > 0 || day.coverageRatio < 0.8);
}

function formatDuration(minutes: number) {
  if (minutes < 60) return tr("{0} 分钟", [Math.round(minutes)]);
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest ? tr("{0} 小时 {1} 分钟", [hours, rest]) : tr("{0} 小时", [hours]);
}

function eventDuration(event: MonitorHostEventItem) {
  const end = event.recoveredAt ? Date.parse(event.recoveredAt) : Date.now();
  return formatDuration(Math.max(0, end - Date.parse(event.triggeredAt)) / 60_000);
}

function eventMetric(event: MonitorHostEventItem) {
  const value = Number(event.details.value);
  const threshold = Number(event.details.threshold);
  if (!Number.isFinite(value)) return "";
  const suffix = event.ruleType === "temperature" ? "°C" : "%";
  return Number.isFinite(threshold) ? `${value.toFixed(1)}${suffix} / ${threshold.toFixed(1)}${suffix}` : `${value.toFixed(1)}${suffix}`;
}

async function loadCalendar() {
  calendarAbort?.abort();
  calendarAbort = new AbortController();
  const controller = calendarAbort;
  loading.value = true;
  error.value = "";
  try {
    const results = await Promise.all(visibleMonths.value.map((monthKey) => {
      const query = new URLSearchParams({ month: monthKey, timezone });
      return api<MonitorHostEventCalendarResponse>(
        `/api/v1/environments/${props.environmentId}/monitor-hosts/${props.hostId}/event-calendar?${query}`,
        { signal: controller.signal },
      );
    }));
    if (!controller.signal.aborted) calendars.value = results;
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    calendars.value = [];
    error.value = caught instanceof Error ? caught.message : tr("读取主机事件日历失败");
  } finally {
    if (calendarAbort === controller) loading.value = false;
  }
}

async function openDay(day: MonitorHostEventCalendarDay) {
  if (!isInteractiveDay(day)) return;
  selectedDate.value = day.date;
  drawerOpen.value = true;
  events.value = [];
  eventsAbort?.abort();
  eventsAbort = new AbortController();
  eventsLoading.value = true;
  try {
    const query = new URLSearchParams({ date: day.date, timezone });
    const response = await api<{ items: MonitorHostEventItem[] }>(
      `/api/v1/environments/${props.environmentId}/monitor-hosts/${props.hostId}/events?${query}`,
      { signal: eventsAbort.signal },
    );
    events.value = response.items;
  } catch (caught) {
    if ((caught as { name?: string }).name !== "AbortError") error.value = caught instanceof Error ? caught.message : tr("读取主机事件失败");
  } finally {
    eventsLoading.value = false;
  }
}

watch(() => [props.environmentId, props.hostId, anchorMonth.value], loadCalendar, { immediate: true });
onBeforeUnmount(() => {
  calendarAbort?.abort();
  eventsAbort?.abort();
});
</script>

<template>
  <section class="event-calendar" :aria-label="$t('主机事件热力图')">
    <header class="event-calendar__header">
      <div class="event-calendar__identity">
        <span class="event-calendar__icon"><CalendarDays :size="18" /></span>
        <div>
          <h4>{{ $t('主机事件热力图') }}</h4>
          <p>{{ $t('过去 12 个月每天一个方格，颜色表示最高严重级别，深浅表示事件负载') }}</p>
        </div>
      </div>
      <div class="event-calendar__range-control">
        <button type="button" :aria-label="$t('上一年')" @click="shiftRange(-1)"><ChevronLeft :size="15" /></button>
        <strong>{{ rangeLabel }}</strong>
        <button type="button" :aria-label="$t('下一年')" :disabled="!canShiftForward" @click="shiftRange(1)"><ChevronRight :size="15" /></button>
        <button type="button" :aria-label="$t('刷新事件热力图')" :disabled="loading" @click="loadCalendar"><RefreshCw :size="14" :class="{ 'is-spinning': loading }" /></button>
      </div>
    </header>

    <p v-if="error" class="event-calendar__error">{{ error }}</p>
    <div class="event-calendar__graph-scroll" :class="{ 'is-loading': loading }">
      <div v-if="heatmapWeeks.length" class="event-calendar__graph" :style="{ '--week-count': heatmapWeeks.length }">
        <div class="event-calendar__months" aria-hidden="true">
          <span v-for="marker in monthMarkers" :key="marker.month" :style="{ gridColumnStart: marker.week + 1 }">{{ marker.label }}</span>
        </div>
        <div class="event-calendar__plot">
          <div class="event-calendar__weekdays" aria-hidden="true">
            <span v-for="(label, index) in weekdayLabels" :key="`${label}-${index}`">{{ index === 1 || index === 3 || index === 5 ? label : '' }}</span>
          </div>
          <div class="event-calendar__weeks">
            <div v-for="(week, weekIndex) in heatmapWeeks" :key="weekIndex" class="event-calendar__week">
              <template v-for="(day, dayIndex) in week" :key="day?.date ?? `empty-${weekIndex}-${dayIndex}`">
                <span v-if="!day" class="event-calendar__cell is-blank"></span>
                <button
                  v-else
                  type="button"
                  class="event-calendar__cell"
                  :class="[dayTone(day), dayIntensity(day), { 'is-interactive': isInteractiveDay(day), 'is-today': day.date === todayKey }]"
                  :title="dayTitle(day)"
                  :aria-label="dayTitle(day)"
                  :aria-disabled="!isInteractiveDay(day)"
                  :tabindex="isInteractiveDay(day) ? 0 : -1"
                  @click="openDay(day)"
                ></button>
              </template>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="event-calendar__loading-grid" aria-hidden="true">
        <i v-for="index in 112" :key="index"></i>
      </div>
    </div>

    <footer class="event-calendar__footer">
      <div class="event-calendar__totals">
        <span><strong>{{ summary.totalEvents }}</strong>{{ $t('个监控事件') }}</span>
        <span><strong>{{ summary.affectedDays }}</strong>{{ $t('天出现异常') }}</span>
        <span>{{ $t('累计影响') }} <strong>{{ formatDuration(summary.affectedMinutes) }}</strong></span>
        <span v-if="summary.noDataDays"><strong>{{ summary.noDataDays }}</strong>{{ $t('天无数据') }}</span>
      </div>
      <div class="event-calendar__legend" :aria-label="$t('严重级别图例')">
        <span>{{ $t('健康') }}</span>
        <i class="is-healthy"></i>
        <i class="is-info" :title="$t('提示')"></i>
        <i class="is-warning" :title="$t('警告')"></i>
        <i class="is-major" :title="$t('高危')"></i>
        <i class="is-critical" :title="$t('严重')"></i>
        <span>{{ $t('严重') }}</span>
        <i class="is-no-data"></i><span>{{ $t('无数据') }}</span>
      </div>
    </footer>
    <small class="event-calendar__timezone">{{ timezone }}</small>
  </section>

  <el-drawer v-model="drawerOpen" size="min(460px, 94vw)" append-to-body :title="$t('{0} 主机事件', [selectedDate])">
    <section class="event-day-drawer" v-loading="eventsLoading">
      <div v-if="events.length" class="event-day-drawer__list">
        <article v-for="event in events" :key="event.id" :class="`is-${event.peakSeverity}`">
          <header>
            <span>{{ severityLabel(event.peakSeverity) }}</span>
            <strong>{{ monitorAlertRuleLabel(event) }}</strong>
            <em>{{ event.status === 'active' ? $t('进行中') : event.status === 'event' ? $t('事件') : $t('已恢复') }}</em>
          </header>
          <p>{{ event.targetName }}</p>
          <div class="event-day-drawer__meta">
            <span><Clock3 :size="12" />{{ eventDuration(event) }}</span>
            <span v-if="eventMetric(event)">{{ eventMetric(event) }}</span>
            <span v-if="event.occurrenceCount > 1">{{ $t('合并 {0} 次短时复发', [event.occurrenceCount - 1]) }}</span>
          </div>
          <time>{{ new Date(event.triggeredAt).toLocaleString(currentLocale()) }} → {{ event.recoveredAt ? new Date(event.recoveredAt).toLocaleString(currentLocale()) : $t('至今') }}</time>
        </article>
      </div>
      <div v-else-if="!eventsLoading" class="event-day-drawer__empty"><CheckCircle2 :size="28" /><strong>{{ $t('当天没有监控事件') }}</strong></div>
    </section>
  </el-drawer>
</template>

<style scoped>
.event-calendar {
  position: relative;
  margin-top: 16px;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  background: var(--surface);
  overflow: hidden;
}
.event-calendar__header {
  min-height: 62px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.event-calendar__identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.event-calendar__icon { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--teal-50); color: var(--teal-700); }
.event-calendar h4 { margin: 0; color: var(--ink-900); font-size: 13px; font-weight: 800; }
.event-calendar p { margin: 3px 0 0; color: var(--ink-400); font-size: 10px; }
.event-calendar__range-control { padding: 3px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); display: flex; align-items: center; gap: 2px; }
.event-calendar__range-control button { width: 28px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--ink-500); display: grid; place-items: center; cursor: pointer; }
.event-calendar__range-control button:hover:not(:disabled) { background: var(--ink-50); color: var(--teal-700); }
.event-calendar__range-control button:disabled { opacity: .35; cursor: default; }
.event-calendar__range-control strong { min-width: 166px; color: var(--ink-800); text-align: center; font-size: 10px; }
.event-calendar__error { margin: 8px 14px 0 !important; color: var(--red-600) !important; }
.event-calendar__graph-scroll { padding: 15px 14px 12px; overflow-x: auto; transition: opacity .16s ease; scrollbar-width: thin; }
.event-calendar__graph-scroll.is-loading { opacity: .55; }
.event-calendar__graph { --heat-cell: 11px; --heat-gap: 3px; width: max-content; min-width: 100%; }
.event-calendar__months {
  height: 17px;
  margin-left: 31px;
  display: grid;
  grid-template-columns: repeat(var(--week-count), var(--heat-cell));
  column-gap: var(--heat-gap);
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1;
}
.event-calendar__months span { width: max-content; }
.event-calendar__plot { display: flex; align-items: stretch; gap: 8px; }
.event-calendar__weekdays {
  width: 23px;
  display: grid;
  grid-template-rows: repeat(7, var(--heat-cell));
  row-gap: var(--heat-gap);
  color: var(--ink-400);
  font-size: 8px;
  line-height: var(--heat-cell);
  text-align: right;
}
.event-calendar__weeks { display: grid; grid-template-columns: repeat(var(--week-count), var(--heat-cell)); column-gap: var(--heat-gap); }
.event-calendar__week { display: grid; grid-template-rows: repeat(7, var(--heat-cell)); row-gap: var(--heat-gap); }
.event-calendar__cell {
  width: var(--heat-cell);
  height: var(--heat-cell);
  padding: 0;
  border: 1px solid color-mix(in srgb, currentColor 12%, var(--ink-100));
  border-radius: 2px;
  background: var(--ink-50);
  color: var(--ink-300);
  cursor: default;
  transition: transform .1s ease, box-shadow .1s ease, filter .1s ease;
}
.event-calendar__cell.is-interactive { cursor: pointer; }
.event-calendar__cell.is-interactive:hover,
.event-calendar__cell.is-interactive:focus-visible { z-index: 1; transform: scale(1.45); box-shadow: 0 0 0 2px var(--surface), 0 2px 8px rgba(10, 28, 31, .24); outline: none; }
.event-calendar__cell.is-blank { border-color: transparent; background: transparent; }
.event-calendar__cell.is-healthy { background: color-mix(in srgb, var(--teal-500) 13%, var(--surface)); color: var(--teal-700); }
.event-calendar__cell.is-info { background: #93c5fd; color: #2563eb; }
.event-calendar__cell.is-warning { background: #fbbf24; color: #b45309; }
.event-calendar__cell.is-major { background: #f97316; color: #c2410c; }
.event-calendar__cell.is-critical { background: #dc2626; color: #991b1b; }
.event-calendar__cell.is-no-data { border-color: var(--ink-200); background: repeating-linear-gradient(135deg, var(--ink-50), var(--ink-50) 3px, var(--ink-100) 3px, var(--ink-100) 5px); color: var(--ink-400); }
.event-calendar__cell.is-future { border-color: color-mix(in srgb, var(--ink-200) 55%, transparent); background: transparent; color: var(--ink-200); }
.event-calendar__cell.is-intensity-2 { filter: saturate(1.12); }
.event-calendar__cell.is-intensity-3 { filter: saturate(1.3) brightness(.93); }
.event-calendar__cell.is-intensity-4 { filter: saturate(1.45) brightness(.82); }
.event-calendar__cell.is-today { box-shadow: 0 0 0 1px var(--ink-800); }
.event-calendar__loading-grid { width: 742px; max-width: 100%; display: grid; grid-template-columns: repeat(28, 11px); gap: 3px; }
.event-calendar__loading-grid i { width: 11px; height: 11px; border-radius: 2px; background: var(--ink-50); }
.event-calendar__footer { min-height: 38px; padding: 8px 14px; border-top: 1px solid var(--ink-100); background: color-mix(in srgb, var(--ink-50) 45%, var(--surface)); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.event-calendar__totals { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; color: var(--ink-500); font-size: 9px; }
.event-calendar__totals span { display: inline-flex; align-items: baseline; gap: 3px; }
.event-calendar__totals strong { color: var(--ink-800); font-family: var(--font-mono); font-size: 10px; }
.event-calendar__legend { display: flex; align-items: center; gap: 4px; color: var(--ink-500); font-size: 9px; white-space: nowrap; }
.event-calendar__legend i { width: 9px; height: 9px; border: 1px solid transparent; border-radius: 2px; display: block; }
.event-calendar__legend i.is-healthy { background: color-mix(in srgb, var(--teal-500) 13%, var(--surface)); }
.event-calendar__legend i.is-info { background: #93c5fd; }
.event-calendar__legend i.is-warning { background: #fbbf24; }
.event-calendar__legend i.is-major { background: #f97316; }
.event-calendar__legend i.is-critical { background: #dc2626; }
.event-calendar__legend i.is-no-data { margin-left: 7px; border-color: var(--ink-300); background: repeating-linear-gradient(135deg, var(--ink-50), var(--ink-50) 3px, var(--ink-100) 3px, var(--ink-100) 5px); }
.event-calendar__timezone { position: absolute; right: 14px; bottom: 3px; color: var(--ink-300); font-family: var(--font-mono); font-size: 8px; pointer-events: none; }
.event-day-drawer { min-height: 260px; }
.event-day-drawer__list { display: grid; gap: 10px; }
.event-day-drawer article { padding: 12px 13px; border: 1px solid var(--ink-100); border-left: 3px solid var(--ink-300); border-radius: 9px; background: var(--surface); }
.event-day-drawer article.is-warning { border-left-color: #f59e0b; }
.event-day-drawer article.is-major { border-left-color: #f97316; }
.event-day-drawer article.is-critical { border-left-color: #ef4444; }
.event-day-drawer article.is-info { border-left-color: #3b82f6; }
.event-day-drawer article header { display: flex; align-items: center; gap: 7px; }
.event-day-drawer article header > span { padding: 2px 6px; border-radius: 5px; background: var(--ink-100); color: var(--ink-600); font-size: 9px; font-weight: 800; }
.event-day-drawer article header strong { color: var(--ink-900); font-size: 12px; }
.event-day-drawer article header em { margin-left: auto; color: var(--ink-400); font-size: 9px; font-style: normal; }
.event-day-drawer article p { margin: 8px 0; color: var(--ink-600); font-size: 12px; }
.event-day-drawer__meta { display: flex; flex-wrap: wrap; gap: 6px; }
.event-day-drawer__meta span { padding: 3px 6px; border-radius: 5px; background: var(--ink-50); color: var(--ink-500); display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 9px; }
.event-day-drawer article time { margin-top: 8px; color: var(--ink-400); display: block; font-family: var(--font-mono); font-size: 9px; }
.event-day-drawer__empty { min-height: 260px; color: var(--ink-400); display: grid; place-items: center; align-content: center; gap: 8px; font-size: 12px; }
.is-spinning { animation: event-calendar-spin .9s linear infinite; }
@keyframes event-calendar-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .event-calendar__cell, .event-calendar__graph-scroll { transition: none; } .is-spinning { animation: none; } }
@media (max-width: 760px) {
  .event-calendar__header { align-items: stretch; flex-direction: column; }
  .event-calendar__range-control { align-self: flex-start; }
  .event-calendar__range-control strong { min-width: 148px; }
  .event-calendar__footer { align-items: flex-start; flex-direction: column; }
}
</style>
