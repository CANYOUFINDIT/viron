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
import { monitorHostEventDiskLabel, monitorHostEventDurationMinutes } from "../../monitor-host-event-display";
import { monitorAlertRuleLabel } from "../../monitor-alert-copy";

const props = defineProps<{ environmentId: string; hostId: string }>();

const rangeMonths = ref(3); // 默认展示近 3 个月，最大可拉拽到 12 个月（1 年）
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
  { length: rangeMonths.value },
  (_, index) => offsetMonth(anchorMonth.value, index - rangeMonths.value + 1),
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

// 纯日期数学运算计算月份横坐标位置，彻底杜绝数据切换时的坐标跑偏与重叠
const monthMarkers = computed(() => {
  if (!visibleMonths.value.length) return [];
  const formatter = new Intl.DateTimeFormat(currentLocale(), { month: "short", timeZone: "UTC" });
  const firstMonthKey = visibleMonths.value[0]!;
  const [startYear, startMonthNumber] = firstMonthKey.split("-").map(Number) as [number, number];
  const startDate = new Date(Date.UTC(startYear, startMonthNumber - 1, 1));
  const leading = startDate.getUTCDay();

  return visibleMonths.value.map((monthKey) => {
    const [y, m] = monthKey.split("-").map(Number) as [number, number];
    const mDate = new Date(Date.UTC(y, m - 1, 1));
    const diffDays = Math.round((mDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
    const weekIndex = Math.floor((leading + diffDays) / 7);
    return {
      month: monthKey,
      label: formatter.format(mDate),
      week: weekIndex,
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

function shiftRange(step: number) {
  const next = offsetMonth(anchorMonth.value, step * rangeMonths.value);
  anchorMonth.value = next > currentMonth ? currentMonth : next;
}

function setPresetMonths(months: number) {
  rangeMonths.value = months;
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
  const minutes = monitorHostEventDurationMinutes(event);
  return minutes == null ? "" : formatDuration(minutes);
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

watch(() => [props.environmentId, props.hostId, anchorMonth.value, rangeMonths.value], loadCalendar, { immediate: true });
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
          <p>{{ $t('每天一个方格，颜色表示最高严重级别，深浅表示事件负载') }}</p>
        </div>
      </div>

      <!-- 交互式时间轴拉拽与范围控制器 -->
      <div class="event-calendar__controls-wrap">
        <div class="timeline-bar">
          <span class="timeline-bar__label">{{ $t('时间跨度') }}</span>
          <div class="timeline-presets">
            <button
              type="button"
              class="preset-chip"
              :class="{ 'is-active': rangeMonths === 3 }"
              @click="setPresetMonths(3)"
            >
              3 {{ $t('个月') }}
            </button>
            <button
              type="button"
              class="preset-chip"
              :class="{ 'is-active': rangeMonths === 6 }"
              @click="setPresetMonths(6)"
            >
              6 {{ $t('个月') }}
            </button>
            <button
              type="button"
              class="preset-chip"
              :class="{ 'is-active': rangeMonths === 12 }"
              @click="setPresetMonths(12)"
            >
              1 {{ $t('年') }}
            </button>
          </div>

          <!-- 时间轴滑块 -->
          <div class="timeline-slider-holder" :title="$t('拉拽调整时间轴跨度（1 ~ 12 个月）')">
            <input
              type="range"
              class="timeline-slider"
              min="1"
              max="12"
              step="1"
              v-model.number="rangeMonths"
            />
            <span class="timeline-slider__val">{{ rangeMonths }}M</span>
          </div>
        </div>

        <div class="event-calendar__range-control">
          <button type="button" :aria-label="$t('上一区间')" @click="shiftRange(-1)"><ChevronLeft :size="15" /></button>
          <strong>{{ rangeLabel }}</strong>
          <button type="button" :aria-label="$t('下一区间')" :disabled="!canShiftForward" @click="shiftRange(1)"><ChevronRight :size="15" /></button>
          <button type="button" :aria-label="$t('刷新事件热力图')" :disabled="loading" @click="loadCalendar"><RefreshCw :size="14" :class="{ 'is-spinning': loading }" /></button>
        </div>
      </div>
    </header>

    <p v-if="error" class="event-calendar__error">{{ error }}</p>
    <div class="event-calendar__graph-scroll" :class="{ 'is-loading': loading }">
      <div v-if="heatmapWeeks.length" class="event-calendar__graph" :style="{ '--week-count': heatmapWeeks.length }">
        <div class="event-calendar__months" aria-hidden="true">
          <span
            v-for="marker in monthMarkers"
            :key="marker.month"
            :style="{ gridColumnStart: marker.week + 1 }"
          >
            {{ marker.label }}
          </span>
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
        <i v-for="index in 84" :key="index"></i>
      </div>
    </div>


    <footer class="event-calendar__footer">
      <div class="event-calendar__totals">
        <span class="totals-pill">
          <strong>{{ summary.totalEvents }}</strong> {{ $t('个监控事件') }}
        </span>
        <span class="totals-pill" :class="{ 'is-affected': summary.affectedDays > 0 }">
          <strong>{{ summary.affectedDays }}</strong> {{ $t('天出现异常') }}
        </span>
        <span class="totals-pill">
          <span class="pill-label">{{ $t('累计影响') }}</span>
          <strong>{{ formatDuration(summary.affectedMinutes) }}</strong>
        </span>
        <span v-if="summary.noDataDays" class="totals-pill is-faint">
          <strong>{{ summary.noDataDays }}</strong> {{ $t('天无数据') }}
        </span>
      </div>
      <div class="event-calendar__legend-group">
        <div class="event-calendar__legend" :aria-label="$t('严重级别图例')">
          <span class="legend-label">{{ $t('健康') }}</span>
          <i class="is-healthy" :title="$t('健康')"></i>
          <i class="is-info" :title="$t('提示')"></i>
          <i class="is-warning" :title="$t('警告')"></i>
          <i class="is-major" :title="$t('高危')"></i>
          <i class="is-critical" :title="$t('严重')"></i>
          <span class="legend-label">{{ $t('严重') }}</span>
          <span class="legend-sep"></span>
          <i class="is-no-data" :title="$t('无数据')"></i>
          <span class="legend-label">{{ $t('无数据') }}</span>
        </div>
        <small class="event-calendar__timezone">{{ timezone }}</small>
      </div>
    </footer>
  </section>

  <el-drawer v-model="drawerOpen" size="min(460px, 94vw)" append-to-body :title="$t('{0} 主机事件', [selectedDate])">
    <section class="event-day-drawer" v-loading="eventsLoading">
      <div v-if="events.length" class="event-day-drawer__list">
        <article v-for="event in events" :key="event.id" :class="`is-${event.peakSeverity}`">
          <header>
            <span class="event-badge">{{ severityLabel(event.peakSeverity) }}</span>
            <strong>{{ monitorAlertRuleLabel(event) }}</strong>
            <em>{{ event.status === 'active' ? $t('进行中') : event.status === 'event' ? $t('事件') : $t('已恢复') }}</em>
          </header>
          <p>{{ event.targetName }}</p>
          <div class="event-day-drawer__meta">
            <span v-if="eventDuration(event)"><Clock3 :size="12" />{{ eventDuration(event) }}</span>
            <span v-if="monitorHostEventDiskLabel(event)">{{ monitorHostEventDiskLabel(event) }}</span>
            <span v-if="eventMetric(event)">{{ eventMetric(event) }}</span>
            <span v-if="event.occurrenceCount > 1">{{ $t('合并 {0} 次短时复发', [event.occurrenceCount - 1]) }}</span>
          </div>
          <time v-if="event.status === 'event'">{{ new Date(event.triggeredAt).toLocaleString(currentLocale()) }}</time>
          <time v-else>{{ new Date(event.triggeredAt).toLocaleString(currentLocale()) }} → {{ event.recoveredAt ? new Date(event.recoveredAt).toLocaleString(currentLocale()) : $t('至今') }}</time>
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
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.03), 0 6px 16px -2px rgba(15, 23, 42, 0.04);
  overflow: hidden;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.event-calendar:hover {
  border-color: color-mix(in srgb, var(--ink-200) 80%, transparent);
}

.event-calendar__header {
  min-height: 58px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, var(--ink-50)) 0%, var(--surface) 100%);
}

.event-calendar__identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.event-calendar__icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, var(--teal-50) 0%, color-mix(in srgb, var(--teal-100) 60%, var(--surface)) 100%);
  color: var(--teal-600);
  border: 1px solid color-mix(in srgb, var(--teal-200) 40%, transparent);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.6);
  flex-shrink: 0;
}

.event-calendar h4 {
  margin: 0;
  color: var(--ink-900);
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.event-calendar p {
  margin: 3px 0 0;
  color: var(--ink-400);
  font-size: 11px;
  line-height: 1.35;
}

.event-calendar__controls-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 交互式时间轴控制器 */
.timeline-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink-50) 40%, var(--surface));
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.02);
}

.timeline-bar__label {
  font-size: 10.5px;
  color: var(--ink-400);
  font-weight: 500;
  white-space: nowrap;
}

.timeline-presets {
  display: flex;
  gap: 2px;
}

.preset-chip {
  padding: 2px 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ink-600);
  font-size: 10.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.preset-chip:hover {
  background: var(--surface);
  color: var(--ink-900);
}

.preset-chip.is-active {
  background: var(--teal-600);
  color: #ffffff;
  font-weight: 700;
  box-shadow: 0 1px 3px rgba(20, 184, 166, 0.25);
}

.timeline-slider-holder {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
}

.timeline-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 72px;
  height: 4px;
  border-radius: 2px;
  background: var(--ink-200);
  outline: none;
  cursor: pointer;
  transition: background 0.15s ease;
}

.timeline-slider:hover {
  background: var(--teal-200);
}

.timeline-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--teal-600);
  border: 2px solid var(--surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  transition: transform 0.15s ease;
}

.timeline-slider::-webkit-slider-thumb:hover {
  transform: scale(1.25);
  background: var(--teal-500);
}

.timeline-slider__val {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--teal-700);
  min-width: 24px;
  text-align: center;
}

.event-calendar__range-control {
  padding: 3px 5px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink-50) 40%, var(--surface));
  display: flex;
  align-items: center;
  gap: 3px;
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.02);
}

.event-calendar__range-control button {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-500);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: all 0.15s ease;
}

.event-calendar__range-control button:hover:not(:disabled) {
  background: var(--surface);
  color: var(--teal-700);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}

.event-calendar__range-control button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.event-calendar__range-control strong {
  min-width: 160px;
  color: var(--ink-800);
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono);
  user-select: none;
}

.event-calendar__error {
  margin: 10px 18px 0 !important;
  color: var(--red-600) !important;
  font-size: 12px;
}

.event-calendar__graph-scroll {
  padding: 18px 18px 14px;
  overflow-x: auto;
  transition: opacity 0.16s ease;
  scrollbar-width: thin;
}

.event-calendar__graph-scroll.is-loading {
  opacity: 0.5;
}

.event-calendar__graph {
  --heat-cell: 12px;
  --heat-gap: 3.5px;
  width: max-content;
  min-width: 100%;
}

/* 月份横坐标：单行网格、强制不换行、绝对对齐周列 */
.event-calendar__months {
  position: relative;
  height: 18px;
  margin-left: 32px;
  display: grid;
  grid-template-columns: repeat(var(--week-count), var(--heat-cell));
  grid-template-rows: 18px;
  column-gap: var(--heat-gap);
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  line-height: 18px;
  overflow: visible;
}

.event-calendar__months span {
  grid-row: 1;
  width: max-content;
  white-space: nowrap;
  pointer-events: none;
}

.event-calendar__plot {
  display: flex;
  align-items: stretch;
  gap: 9px;
}

.event-calendar__weekdays {
  width: 23px;
  display: grid;
  grid-template-rows: repeat(7, var(--heat-cell));
  row-gap: var(--heat-gap);
  color: var(--ink-400);
  font-size: 9px;
  line-height: var(--heat-cell);
  text-align: right;
  font-family: var(--font-body);
  user-select: none;
}

.event-calendar__weeks {
  display: grid;
  grid-template-columns: repeat(var(--week-count), var(--heat-cell));
  column-gap: var(--heat-gap);
}

.event-calendar__week {
  display: grid;
  grid-template-rows: repeat(7, var(--heat-cell));
  row-gap: var(--heat-gap);
}

/* 核心方块单元 (Clean Modern Look) */
.event-calendar__cell {
  width: var(--heat-cell);
  height: var(--heat-cell);
  padding: 0;
  border-radius: 3px;
  border: 1px solid transparent;
  background: var(--ink-50);
  color: var(--ink-300);
  cursor: default;
  transition: transform 0.12s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s ease, filter 0.12s ease;
  position: relative;
}

.event-calendar__cell.is-interactive {
  cursor: pointer;
}

.event-calendar__cell.is-interactive:hover,
.event-calendar__cell.is-interactive:focus-visible {
  z-index: 5;
  transform: scale(1.45);
  box-shadow: 0 0 0 2px var(--surface), 0 4px 12px rgba(15, 23, 42, 0.18);
  outline: none;
}

.event-calendar__cell.is-blank {
  border-color: transparent;
  background: transparent;
  pointer-events: none;
}

/* 极简清爽的“无数据”状态：剔除密集斜线马赛克，采用淡雅微槽底色 */
.event-calendar__cell.is-no-data {
  background: color-mix(in srgb, var(--ink-100) 45%, var(--surface));
  border-color: color-mix(in srgb, var(--ink-200) 35%, transparent);
}

/* 各级别健康度色彩系统 */
.event-calendar__cell.is-healthy {
  background: #10b981;
  border-color: #059669;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.event-calendar__cell.is-info {
  background: #38bdf8;
  border-color: #0284c7;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.event-calendar__cell.is-warning {
  background: #f59e0b;
  border-color: #d97706;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.event-calendar__cell.is-major {
  background: #f97316;
  border-color: #c2410c;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.event-calendar__cell.is-critical {
  background: #ef4444;
  border-color: #b91c1c;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 0 6px rgba(239, 68, 68, 0.4);
}

.event-calendar__cell.is-future {
  border-color: color-mix(in srgb, var(--ink-100) 60%, transparent);
  background: transparent;
  opacity: 0.4;
}

/* 负载强度阶梯映射 */
.event-calendar__cell.is-intensity-1 { opacity: 0.82; }
.event-calendar__cell.is-intensity-2 { opacity: 0.92; filter: saturate(1.1); }
.event-calendar__cell.is-intensity-3 { opacity: 1; filter: saturate(1.25) brightness(0.96); }
.event-calendar__cell.is-intensity-4 { opacity: 1; filter: saturate(1.4) brightness(0.9); box-shadow: 0 0 4px rgba(0, 0, 0, 0.25); }

.event-calendar__cell.is-today {
  box-shadow: 0 0 0 1.5px var(--surface), 0 0 0 3px var(--teal-600) !important;
  z-index: 2;
}

.event-calendar__loading-grid {
  width: 742px;
  max-width: 100%;
  display: grid;
  grid-template-columns: repeat(28, 12px);
  gap: 3.5px;
}

.event-calendar__loading-grid i {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--ink-50);
  animation: calendar-pulse 1.4s infinite ease-in-out;
}

@keyframes calendar-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}

/* 底部统计栏与图例 */
.event-calendar__footer {
  min-height: 42px;
  padding: 8px 18px;
  border-top: 1px solid var(--ink-100);
  background: color-mix(in srgb, var(--ink-50) 50%, var(--surface));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.event-calendar__totals {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.totals-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--ink-100);
  color: var(--ink-600);
  font-size: 11px;
  line-height: 1.2;
}

.totals-pill strong {
  color: var(--ink-900);
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11.5px;
}

.totals-pill.is-affected {
  background: var(--amber-50);
  border-color: var(--amber-200);
  color: var(--amber-800);
}

.totals-pill.is-affected strong {
  color: var(--amber-800);
}

.totals-pill.is-faint {
  background: transparent;
  border-color: transparent;
  color: var(--ink-400);
}

.totals-pill.is-faint strong {
  color: var(--ink-500);
}

.pill-label {
  color: var(--ink-400);
}

.event-calendar__legend-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.event-calendar__legend {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--ink-500);
  font-size: 10px;
  white-space: nowrap;
}

.legend-label {
  font-size: 10px;
  color: var(--ink-400);
  user-select: none;
}

.legend-sep {
  width: 1px;
  height: 10px;
  background: var(--ink-200);
  margin: 0 4px;
}

.event-calendar__legend i {
  width: 10px;
  height: 10px;
  border-radius: 2.5px;
  display: block;
}

.event-calendar__legend i.is-healthy { background: #10b981; }
.event-calendar__legend i.is-info { background: #38bdf8; }
.event-calendar__legend i.is-warning { background: #f59e0b; }
.event-calendar__legend i.is-major { background: #f97316; }
.event-calendar__legend i.is-critical { background: #ef4444; }
.event-calendar__legend i.is-no-data {
  background: color-mix(in srgb, var(--ink-100) 45%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--ink-200) 35%, transparent);
}

.event-calendar__timezone {
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 10px;
  user-select: none;
}

/* 抽屉排障详情列表 */
.event-day-drawer {
  min-height: 260px;
}

.event-day-drawer__list {
  display: grid;
  gap: 12px;
}

.event-day-drawer article {
  padding: 14px 16px;
  border: 1px solid var(--ink-100);
  border-left: 4px solid var(--ink-300);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.event-day-drawer article:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
}

.event-day-drawer article.is-warning { border-left-color: #f59e0b; }
.event-day-drawer article.is-major { border-left-color: #f97316; }
.event-day-drawer article.is-critical { border-left-color: #ef4444; }
.event-day-drawer article.is-info { border-left-color: #38bdf8; }

.event-day-drawer article header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.event-day-drawer article header .event-badge {
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--ink-100);
  color: var(--ink-700);
  font-size: 10px;
  font-weight: 700;
}

.event-day-drawer article.is-warning .event-badge { background: var(--amber-50); color: var(--amber-800); }
.event-day-drawer article.is-major .event-badge { background: #ffedd5; color: #c2410c; }
.event-day-drawer article.is-critical .event-badge { background: #fee2e2; color: #b91c1c; }
.event-day-drawer article.is-info .event-badge { background: #e0f2fe; color: #0369a1; }

.event-day-drawer article header strong {
  color: var(--ink-900);
  font-size: 13px;
  font-weight: 600;
}

.event-day-drawer article header em {
  margin-left: auto;
  color: var(--ink-400);
  font-size: 10px;
  font-style: normal;
  font-family: var(--font-mono);
}

.event-day-drawer article p {
  margin: 8px 0;
  color: var(--ink-600);
  font-size: 12px;
}

.event-day-drawer__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.event-day-drawer__meta span {
  min-width: 0;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--ink-50);
  color: var(--ink-600);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.event-day-drawer article time {
  margin-top: 10px;
  color: var(--ink-400);
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
}

.event-day-drawer__empty {
  min-height: 260px;
  color: var(--ink-400);
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  font-size: 13px;
}

.is-spinning {
  animation: event-calendar-spin 0.9s linear infinite;
}

@keyframes event-calendar-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .event-calendar__cell,
  .event-calendar__graph-scroll { transition: none; }
  .is-spinning { animation: none; }
}

@media (max-width: 760px) {
  .event-calendar__header { align-items: stretch; flex-direction: column; }
  .event-calendar__range-control { align-self: flex-start; }
  .event-calendar__range-control strong { min-width: 148px; }
  .event-calendar__footer { align-items: flex-start; flex-direction: column; }
}
</style>
