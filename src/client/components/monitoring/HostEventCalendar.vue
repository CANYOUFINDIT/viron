<script setup lang="ts">
import {
  AlertOctagon,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  DatabaseZap,
  RefreshCw,
  ShieldCheck,
  Siren,
} from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  MonitorAlertSeverity,
  MonitorHostEventCalendarDay,
  MonitorHostEventCalendarResponse,
  MonitorHostEventItem,
} from "../../../shared/monitor-alerts";
import { api } from "../../api";
import { currentLocale, translate as tr } from "../../i18n";
import { monitorAlertRuleLabel } from "../../monitor-alert-copy";

const props = defineProps<{
  environmentId: string;
  hostId: string;
}>();

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const today = new Date();
const month = ref(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);
const loading = ref(false);
const error = ref("");
const calendar = ref<MonitorHostEventCalendarResponse | null>(null);
const drawerOpen = ref(false);
const selectedDate = ref("");
const events = ref<MonitorHostEventItem[]>([]);
const eventsLoading = ref(false);
let calendarAbort: AbortController | null = null;
let eventsAbort: AbortController | null = null;

const weekdayLabels = computed(() => {
  const monday = Date.UTC(2026, 7, 24);
  return Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(currentLocale(), { weekday: "narrow", timeZone: "UTC" })
    .format(new Date(monday + index * 24 * 60 * 60 * 1000)));
});
const monthLabel = computed(() => new Intl.DateTimeFormat(currentLocale(), { year: "numeric", month: "long", timeZone: "UTC" })
  .format(new Date(`${month.value}-01T00:00:00.000Z`)));
const calendarCells = computed<Array<MonitorHostEventCalendarDay | null>>(() => {
  const days = calendar.value?.days ?? [];
  if (!days.length) return [];
  const weekday = new Date(`${days[0]!.date}T00:00:00.000Z`).getUTCDay();
  const leading = (weekday + 6) % 7;
  return [...Array.from({ length: leading }, () => null), ...days];
});
const summary = computed(() => calendar.value?.summary ?? {
  healthyDays: 0,
  affectedDays: 0,
  noDataDays: 0,
  criticalEvents: 0,
  totalEvents: 0,
  affectedMinutes: 0,
  meanRecoveryMinutes: null,
});

function shiftMonth(delta: number) {
  const [year, monthNumber] = month.value.split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  month.value = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
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
  loading.value = true;
  error.value = "";
  try {
    const query = new URLSearchParams({ month: month.value, timezone });
    calendar.value = await api<MonitorHostEventCalendarResponse>(
      `/api/v1/environments/${props.environmentId}/monitor-hosts/${props.hostId}/event-calendar?${query}`,
      { signal: calendarAbort.signal },
    );
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    calendar.value = null;
    error.value = caught instanceof Error ? caught.message : tr("读取主机事件日历失败");
  } finally {
    loading.value = false;
  }
}

async function openDay(day: MonitorHostEventCalendarDay) {
  if (day.future || (!day.activeEventCount && day.coverageRatio >= 0.8)) return;
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

watch(() => [props.environmentId, props.hostId, month.value], loadCalendar, { immediate: true });
onBeforeUnmount(() => {
  calendarAbort?.abort();
  eventsAbort?.abort();
});
</script>

<template>
  <section class="event-calendar" :aria-label="$t('主机稳定性日历')">
    <header class="event-calendar__header">
      <div class="event-calendar__identity">
        <span class="event-calendar__icon"><CalendarDays :size="18" /></span>
        <div>
          <h4>{{ $t('主机稳定性日历') }}</h4>
          <p>{{ $t('颜色表示每日最高严重级别，深浅综合事件数量与影响时长') }}</p>
        </div>
      </div>
      <div class="event-calendar__month-control">
        <button type="button" :aria-label="$t('上个月')" @click="shiftMonth(-1)"><ChevronLeft :size="15" /></button>
        <strong>{{ monthLabel }}</strong>
        <button type="button" :aria-label="$t('下个月')" @click="shiftMonth(1)"><ChevronRight :size="15" /></button>
        <button type="button" :aria-label="$t('刷新事件日历')" :disabled="loading" @click="loadCalendar"><RefreshCw :size="14" :class="{ 'is-spinning': loading }" /></button>
      </div>
    </header>

    <div class="event-calendar__summary">
      <span><ShieldCheck :size="14" /><small>{{ $t('健康天数') }}</small><strong>{{ summary.healthyDays }}</strong></span>
      <span><Siren :size="14" /><small>{{ $t('异常天数') }}</small><strong>{{ summary.affectedDays }}</strong></span>
      <span><AlertOctagon :size="14" /><small>{{ $t('严重事件') }}</small><strong>{{ summary.criticalEvents }}</strong></span>
      <span><Clock3 :size="14" /><small>{{ $t('累计影响') }}</small><strong>{{ formatDuration(summary.affectedMinutes) }}</strong></span>
      <span><DatabaseZap :size="14" /><small>{{ $t('无数据天数') }}</small><strong>{{ summary.noDataDays }}</strong></span>
    </div>

    <p v-if="error" class="event-calendar__error">{{ error }}</p>
    <div class="event-calendar__matrix" :class="{ 'is-loading': loading }">
      <span v-for="label in weekdayLabels" :key="label" class="event-calendar__weekday">{{ label }}</span>
      <template v-for="(day, index) in calendarCells" :key="day?.date ?? `empty-${index}`">
        <span v-if="!day" class="event-calendar__blank"></span>
        <button
          v-else
          type="button"
          class="event-calendar__day"
          :class="[dayTone(day), dayIntensity(day)]"
          :title="dayTitle(day)"
          :aria-label="dayTitle(day)"
          :disabled="day.future"
          @click="openDay(day)"
        >
          <span>{{ Number(day.date.slice(-2)) }}</span>
          <strong v-if="day.activeEventCount">{{ day.activeEventCount }}</strong>
          <i v-if="day.coverageRatio < 0.8 && !day.future"></i>
        </button>
      </template>
    </div>

    <footer class="event-calendar__legend">
      <span><i class="is-healthy"></i>{{ $t('健康') }}</span>
      <span><i class="is-warning"></i>{{ $t('警告') }}</span>
      <span><i class="is-major"></i>{{ $t('高危') }}</span>
      <span><i class="is-critical"></i>{{ $t('严重') }}</span>
      <span><i class="is-no-data"></i>{{ $t('无数据') }}</span>
      <small>{{ timezone }}</small>
    </footer>
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
  margin-top: 16px;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink-50) 42%, var(--surface));
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
.event-calendar__month-control { padding: 3px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); display: flex; align-items: center; gap: 2px; }
.event-calendar__month-control button { width: 28px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--ink-500); display: grid; place-items: center; cursor: pointer; }
.event-calendar__month-control button:hover { background: var(--ink-50); color: var(--teal-700); }
.event-calendar__month-control button:disabled { opacity: .45; cursor: default; }
.event-calendar__month-control strong { min-width: 92px; color: var(--ink-800); text-align: center; font-size: 11px; }
.event-calendar__summary { padding: 10px 14px 4px; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; }
.event-calendar__summary > span { min-width: 0; padding: 8px 9px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; }
.event-calendar__summary svg { grid-row: span 2; color: var(--ink-400); }
.event-calendar__summary small { color: var(--ink-400); font-size: 9px; }
.event-calendar__summary strong { color: var(--ink-900); font-family: var(--font-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-calendar__matrix { padding: 10px 14px 12px; display: grid; grid-template-columns: repeat(7, minmax(28px, 1fr)); gap: 6px; transition: opacity .16s ease; }
.event-calendar__matrix.is-loading { opacity: .55; }
.event-calendar__weekday { padding-bottom: 2px; color: var(--ink-400); text-align: center; font-size: 9px; font-weight: 700; }
.event-calendar__blank { min-height: 38px; }
.event-calendar__day { position: relative; min-height: 42px; padding: 6px 7px; border: 1px solid transparent; border-radius: 8px; display: flex; align-items: flex-start; justify-content: space-between; overflow: hidden; cursor: pointer; transition: transform .14s ease, border-color .14s ease, box-shadow .14s ease; }
.event-calendar__day:not(:disabled):hover { z-index: 1; transform: translateY(-2px); border-color: color-mix(in srgb, currentColor 50%, var(--ink-200)); box-shadow: 0 5px 12px rgba(12, 30, 34, .10); }
.event-calendar__day > span { font-family: var(--font-mono); font-size: 10px; font-weight: 700; }
.event-calendar__day > strong { min-width: 17px; height: 17px; padding: 0 4px; border-radius: 8px; background: rgba(0, 0, 0, .18); color: white; display: grid; place-items: center; font-family: var(--font-mono); font-size: 9px; }
.event-calendar__day > i { position: absolute; inset: auto 5px 5px auto; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.event-calendar__day.is-healthy { background: color-mix(in srgb, var(--teal-500) 18%, var(--surface)); color: var(--teal-800); }
.event-calendar__day.is-info { background: color-mix(in srgb, #3b82f6 18%, var(--surface)); color: #1d4ed8; }
.event-calendar__day.is-warning { background: color-mix(in srgb, #f59e0b 35%, var(--surface)); color: #9a5b05; }
.event-calendar__day.is-major { background: color-mix(in srgb, #f97316 48%, var(--surface)); color: #8f3510; }
.event-calendar__day.is-critical { background: color-mix(in srgb, #ef4444 58%, var(--surface)); color: #7f1d1d; }
.event-calendar__day.is-no-data { border-color: var(--ink-200); color: var(--ink-400); background: repeating-linear-gradient(135deg, var(--ink-50), var(--ink-50) 5px, var(--ink-100) 5px, var(--ink-100) 7px); }
.event-calendar__day.is-future { color: var(--ink-300); background: transparent; cursor: default; }
.event-calendar__day.is-intensity-2 { filter: saturate(1.12); }
.event-calendar__day.is-intensity-3 { filter: saturate(1.28) brightness(.96); }
.event-calendar__day.is-intensity-4 { filter: saturate(1.4) brightness(.90); }
.event-calendar__legend { padding: 8px 14px; border-top: 1px solid var(--ink-100); background: var(--surface); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.event-calendar__legend span { color: var(--ink-500); display: inline-flex; align-items: center; gap: 5px; font-size: 9px; }
.event-calendar__legend i { width: 9px; height: 9px; border-radius: 3px; display: block; }
.event-calendar__legend i.is-healthy { background: var(--teal-500); }
.event-calendar__legend i.is-warning { background: #f59e0b; }
.event-calendar__legend i.is-major { background: #f97316; }
.event-calendar__legend i.is-critical { background: #ef4444; }
.event-calendar__legend i.is-no-data { border: 1px solid var(--ink-300); background: var(--ink-100); }
.event-calendar__legend small { margin-left: auto; color: var(--ink-400); font-family: var(--font-mono); font-size: 9px; }
.event-calendar__error { margin: 8px 14px 0 !important; color: var(--red-600) !important; }
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
@media (prefers-reduced-motion: reduce) { .event-calendar__day, .event-calendar__matrix { transition: none; } .is-spinning { animation: none; } }
@media (max-width: 760px) {
  .event-calendar__header { align-items: stretch; flex-direction: column; }
  .event-calendar__month-control { align-self: flex-start; }
  .event-calendar__summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .event-calendar__matrix { gap: 4px; }
  .event-calendar__day { min-height: 36px; padding: 5px; }
}
</style>
