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
import { monitorEventCalendarCacheKey, readMonitorUiCache, writeMonitorUiCache } from "../../monitor-ui-cache";
import { monitorAlertRuleLabel } from "../../monitor-alert-copy";

const props = defineProps<{ environmentId: string; hostId: string }>();

// 默认选择近 3 个月，整年 12 个月（1 年）全矩阵展示，可通过拖动竖线调整 1 ~ 12 个月
const rangeMonths = ref(3);
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
const isDragging = ref(false);
const weeksWrapperRef = ref<HTMLElement | null>(null);

let calendarAbort: AbortController | null = null;
let eventsAbort: AbortController | null = null;

function offsetMonth(monthKey: string, delta: number) {
  const [year, monthNumber] = monthKey.split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

// 永远展示固定整年 12 个月方格矩阵
const fullYearMonths = computed(() => Array.from(
  { length: 12 },
  (_, index) => offsetMonth(anchorMonth.value, index - 11),
));

// 当前处于选中活跃状态的月份切片（例如近 3 个月）
const activeMonths = computed(() => fullYearMonths.value.slice(12 - rangeMonths.value));
const activeStartDate = computed(() => `${activeMonths.value[0]}-01`);

function isDayActive(day: MonitorHostEventCalendarDay) {
  return day.date >= activeStartDate.value;
}

const weekdayLabels = computed(() => {
  const sunday = Date.UTC(2026, 7, 23);
  return Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(currentLocale(), { weekday: "narrow", timeZone: "UTC" })
    .format(new Date(sunday + index * 24 * 60 * 60 * 1000)));
});

const rangeLabel = computed(() => {
  const formatter = new Intl.DateTimeFormat(currentLocale(), { year: "numeric", month: "short", timeZone: "UTC" });
  const first = new Date(`${activeMonths.value[0]}-01T00:00:00.000Z`);
  const last = new Date(`${activeMonths.value.at(-1)}-01T00:00:00.000Z`);
  return `${formatter.format(first)} – ${formatter.format(last)}`;
});

function placeholderMonthDays(monthKey: string): MonitorHostEventCalendarDay[] {
  const [year, month] = monthKey.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${monthKey}-${String(i + 1).padStart(2, "0")}`;
    return {
      date,
      future: date > todayKey,
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
    };
  });
}

// 整合整年 12 个月的全部日期，未加载的非活跃月份自动填充占位日，保证方块矩阵尺寸 100% 完整铺满
const allDays = computed(() => {
  const calendarMap = new Map(calendars.value.map((item) => [item.month, item]));
  return fullYearMonths.value.flatMap((monthKey) => {
    const loaded = calendarMap.get(monthKey);
    return loaded ? loaded.days : placeholderMonthDays(monthKey);
  });
});

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

// 纯日期数学运算计算 12 个月份横坐标位置
const monthMarkers = computed(() => {
  if (!fullYearMonths.value.length) return [];
  const formatter = new Intl.DateTimeFormat(currentLocale(), { month: "short", timeZone: "UTC" });
  const firstMonthKey = fullYearMonths.value[0]!;
  const [startYear, startMonthNumber] = firstMonthKey.split("-").map(Number) as [number, number];
  const startDate = new Date(Date.UTC(startYear, startMonthNumber - 1, 1));
  const leading = startDate.getUTCDay();

  return fullYearMonths.value.map((monthKey) => {
    const [y, m] = monthKey.split("-").map(Number) as [number, number];
    const mDate = new Date(Date.UTC(y, m - 1, 1));
    const diffDays = Math.round((mDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
    const weekIndex = Math.floor((leading + diffDays) / 7);
    const isActive = activeMonths.value.includes(monthKey);
    return {
      month: monthKey,
      label: formatter.format(mDate),
      week: weekIndex,
      isActive,
    };
  });
});

// 计算拖拽分界竖线在周列网格上的绝对水平百分比位置
const activeWeekIndex = computed(() => {
  if (!heatmapWeeks.value.length) return 0;
  const idx = heatmapWeeks.value.findIndex((week) => week.some((day) => day && day.date >= activeStartDate.value));
  return idx >= 0 ? idx : 0;
});

const dividerLeftPercent = computed(() => {
  if (!heatmapWeeks.value.length) return 75;
  return (activeWeekIndex.value / heatmapWeeks.value.length) * 100;
});

// 统计信息严格按当前选中的活跃时间范围（竖线右侧）聚合计算
const activeCalendars = computed(() => calendars.value.filter((item) => activeMonths.value.includes(item.month)));
const summary = computed<MonitorHostEventCalendarSummary>(() => activeCalendars.value.reduce((total, item) => ({
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

function startDividerDrag(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  isDragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onWeeksPointerMove(event: PointerEvent) {
  if (!isDragging.value || !weeksWrapperRef.value) return;
  const rect = weeksWrapperRef.value.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, offsetX / rect.width));
  // 从右向左：右边缘(1)对应1个月，左边缘(0)对应12个月
  const months = Math.max(1, Math.min(12, Math.round((1 - ratio) * 12)));
  if (months !== rangeMonths.value) {
    rangeMonths.value = months;
  }
}

function onWeeksPointerUp(event: PointerEvent) {
  if (isDragging.value) {
    isDragging.value = false;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {}
  }
}

function monthsForDay(day: MonitorHostEventCalendarDay): number {
  const [dayYear, dayMonth] = day.date.split("-").map(Number) as [number, number];
  const [anchorYear, anchorMonthNum] = anchorMonth.value.split("-").map(Number) as [number, number];
  const diffMonths = (anchorYear - dayYear) * 12 + (anchorMonthNum - dayMonth) + 1;
  return Math.max(1, Math.min(12, diffMonths));
}

function severityLabel(value: MonitorAlertSeverity) {
  return ({ info: tr("提示"), warning: tr("警告"), major: tr("高危"), critical: tr("严重") })[value];
}

function dayTone(day: MonitorHostEventCalendarDay) {
  if (day.future) return "is-future";
  if (day.peakSeverity) return `is-${day.peakSeverity}`;
  if (day.date === todayKey && day.coverageRatio < 0.8) return "is-detecting";
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
  if (!isDayActive(day)) {
    return tr("{0} · 未在当前时间范围 (近 {1} 个月) · 点击或向左拖动竖线展开", [day.date, rangeMonths.value]);
  }
  if (day.future) return day.date;
  if (day.peakSeverity) {
    return tr("{0} · {1} · {2} 个事件 · 影响 {3} 分钟", [
      day.date,
      severityLabel(day.peakSeverity),
      day.activeEventCount,
      day.affectedMinutes,
    ]);
  }
  if (day.date === todayKey && day.coverageRatio < 0.8) {
    return tr("{0} · 检测中 · 采集覆盖率 {1}%", [day.date, Math.round(day.coverageRatio * 100)]);
  }
  if (day.coverageRatio < 0.8) {
    return tr("{0} · 无采集数据", [day.date]);
  }
  return tr("{0} · 健康 · 采集覆盖 100%", [day.date]);
}

function isInteractiveDay(day: MonitorHostEventCalendarDay) {
  return !day.future && (day.activeEventCount > 0 || day.coverageRatio < 0.8 || day.date === todayKey);
}

// 零延迟即时悬浮提示（Instant Custom Tooltip）
interface HoveredDayInfo {
  day: MonitorHostEventCalendarDay;
  x: number;
  y: number;
  placement: "top" | "bottom";
}
const hoveredDay = ref<HoveredDayInfo | null>(null);

function handleCellMouseEnter(day: MonitorHostEventCalendarDay, event: MouseEvent | FocusEvent) {
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const calendarEl = target.closest(".event-calendar") as HTMLElement | null;
  const containerRect = calendarEl ? calendarEl.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth };

  const topOffset = rect.top - containerRect.top;
  const placement = topOffset < 78 ? "bottom" : "top";

  hoveredDay.value = {
    day,
    x: rect.left - containerRect.left + rect.width / 2,
    y: placement === "top" ? topOffset - 6 : topOffset + rect.height + 6,
    placement,
  };
}

function handleCellMouseLeave() {
  hoveredDay.value = null;
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
  const neededMonths = activeMonths.value;
  const cacheKey = monitorEventCalendarCacheKey(props.environmentId, props.hostId, timezone, neededMonths);
  const cachedCalendars = readMonitorUiCache<MonitorHostEventCalendarResponse[]>(cacheKey);
  calendars.value = cachedCalendars ?? [];
  calendarAbort?.abort();
  calendarAbort = new AbortController();
  const controller = calendarAbort;
  loading.value = true;
  error.value = "";
  try {
    const results = await Promise.all(neededMonths.map((monthKey) => {
      const query = new URLSearchParams({ month: monthKey, timezone });
      return api<MonitorHostEventCalendarResponse>(
        `/api/v1/environments/${props.environmentId}/monitor-hosts/${props.hostId}/event-calendar?${query}`,
        { signal: controller.signal },
      );
    }));
    if (!controller.signal.aborted) {
      // 严格基于当前 host 缓存与新结果建立 map，避免旧主机数据残留
      const existingMap = new Map((cachedCalendars ?? []).map((c) => [c.month, c]));
      results.forEach((c) => existingMap.set(c.month, c));
      const combined = [...existingMap.values()];
      calendars.value = combined;
      writeMonitorUiCache(cacheKey, combined);
    }
  } catch (caught) {
    if ((caught as { name?: string }).name === "AbortError") return;
    if (!cachedCalendars) calendars.value = [];
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

watch(() => [props.environmentId, props.hostId], () => {
  calendars.value = [];
});
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
        <div class="event-calendar__title-wrap">
          <h4>{{ $t('主机事件热力图') }}</h4>
          <p>{{ $t('每天一个方格，颜色表示严重级别，深浅表示事件负载') }}</p>
        </div>
      </div>

      <!-- 单行一体化控制栏 -->
      <div class="event-calendar__unified-toolbar">
        <div class="toolbar-section toolbar-range">
          <div class="timeline-presets">
            <button
              type="button"
              class="preset-chip"
              :class="{ 'is-active': rangeMonths === 1 }"
              @click="setPresetMonths(1)"
            >
              1M
            </button>
            <button
              type="button"
              class="preset-chip"
              :class="{ 'is-active': rangeMonths === 3 }"
              @click="setPresetMonths(3)"
            >
              3M
            </button>
            <button
              type="button"
              class="preset-chip"
              :class="{ 'is-active': rangeMonths === 6 }"
              @click="setPresetMonths(6)"
            >
              6M
            </button>
            <button
              type="button"
              class="preset-chip"
              :class="{ 'is-active': rangeMonths === 12 }"
              @click="setPresetMonths(12)"
            >
              1Y
            </button>
          </div>

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

        <span class="toolbar-divider" aria-hidden="true"></span>

        <div class="toolbar-section toolbar-nav">
          <button type="button" :aria-label="$t('上一区间')" @click="shiftRange(-1)"><ChevronLeft :size="14" /></button>
          <strong class="toolbar-range-label">{{ rangeLabel }}</strong>
          <button type="button" :aria-label="$t('下一区间')" :disabled="!canShiftForward" @click="shiftRange(1)"><ChevronRight :size="14" /></button>
          <button type="button" class="btn-refresh" :aria-label="$t('刷新事件热力图')" :disabled="loading" @click="loadCalendar"><RefreshCw :size="13" :class="{ 'is-spinning': loading }" /></button>
        </div>
      </div>
    </header>

    <p v-if="error" class="event-calendar__error">{{ error }}</p>
    <div class="event-calendar__graph-scroll" :class="{ 'is-loading': loading && !heatmapWeeks.length }" @scroll="handleCellMouseLeave">
      <div v-if="heatmapWeeks.length" class="event-calendar__graph" :style="{ '--week-count': heatmapWeeks.length }">
        <div class="event-calendar__months" aria-hidden="true">
          <span
            v-for="marker in monthMarkers"
            :key="marker.month"
            :class="{ 'is-active': marker.isActive }"
            :style="{ gridColumnStart: marker.week + 1 }"
          >
            {{ marker.label }}
          </span>
        </div>
        <div class="event-calendar__plot">
          <div class="event-calendar__weekdays" aria-hidden="true">
            <span v-for="(label, index) in weekdayLabels" :key="`${label}-${index}`">{{ index === 1 || index === 3 || index === 5 ? label : '' }}</span>
          </div>
          <div
            class="event-calendar__weeks-wrapper"
            ref="weeksWrapperRef"
            @pointermove="onWeeksPointerMove"
            @pointerup="onWeeksPointerUp"
            @pointercancel="onWeeksPointerUp"
          >
            <div class="event-calendar__weeks">
              <div v-for="(week, weekIndex) in heatmapWeeks" :key="weekIndex" class="event-calendar__week">
                <template v-for="(day, dayIndex) in week" :key="day?.date ?? `empty-${weekIndex}-${dayIndex}`">
                  <span v-if="!day" class="event-calendar__cell is-blank"></span>
                  <button
                    v-else
                    type="button"
                    class="event-calendar__cell"
                    :class="[
                      isDayActive(day) ? [dayTone(day), dayIntensity(day)] : 'is-inactive',
                      {
                        'is-interactive': isDayActive(day) && isInteractiveDay(day),
                        'is-today': day.date === todayKey,
                      }
                    ]"
                    :aria-label="dayTitle(day)"
                    :aria-disabled="!isDayActive(day) && !isInteractiveDay(day)"
                    :tabindex="isDayActive(day) && isInteractiveDay(day) ? 0 : -1"
                    @mouseenter="handleCellMouseEnter(day, $event)"
                    @mouseleave="handleCellMouseLeave"
                    @focus="handleCellMouseEnter(day, $event)"
                    @blur="handleCellMouseLeave"
                    @click="isDayActive(day) ? openDay(day) : setPresetMonths(monthsForDay(day))"
                  ></button>
                </template>
              </div>
            </div>

            <!-- 可拖动时间范围分界竖线与手柄 -->
            <div
              v-if="dividerLeftPercent > 0 && dividerLeftPercent < 100"
              class="event-calendar__range-divider"
              :class="{ 'is-dragging': isDragging }"
              :style="{ left: `${dividerLeftPercent}%` }"
              @pointerdown="startDividerDrag"
            >
              <div class="range-divider-line"></div>
              <div class="range-divider-handle" :title="$t('按住拖动以调整监控时间范围（1 ~ 12 个月）')">
                <span class="handle-tag">{{ rangeMonths }}M</span>
                <span class="handle-grip"><i class="grip-bar"></i><i class="grip-bar"></i></span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="event-calendar__loading-grid" aria-hidden="true">
        <i v-for="index in 84" :key="index"></i>
      </div>
    </div>

    <!-- 零延迟即时悬浮提示卡片 (Instant Custom Popover) -->
    <transition name="popover-fade">
      <div
        v-if="hoveredDay"
        class="event-calendar__instant-tooltip"
        :class="`placement-${hoveredDay.placement}`"
        :style="{ left: `${hoveredDay.x}px`, top: `${hoveredDay.y}px` }"
      >
        <div class="tooltip-header">
          <span class="tooltip-dot" :class="isDayActive(hoveredDay.day) ? dayTone(hoveredDay.day) : 'is-inactive'"></span>
          <strong class="tooltip-date">{{ hoveredDay.day.date }}</strong>
          <span class="tooltip-badge" :class="isDayActive(hoveredDay.day) ? dayTone(hoveredDay.day) : 'is-inactive'">
            {{
              !isDayActive(hoveredDay.day)
                ? $t('未选范围')
                : hoveredDay.day.future
                  ? $t('未来')
                  : hoveredDay.day.peakSeverity
                    ? severityLabel(hoveredDay.day.peakSeverity)
                    : hoveredDay.day.date === todayKey && hoveredDay.day.coverageRatio < 0.8
                      ? $t('检测中')
                      : hoveredDay.day.coverageRatio < 0.8
                        ? $t('无数据')
                        : $t('健康')
            }}
          </span>
        </div>

        <div class="tooltip-body">
          <template v-if="!isDayActive(hoveredDay.day)">
            <span class="tooltip-text is-dim">{{ $t('当前处于近 {0} 个月统计范围之外，可向左拖动竖线或点击以展开', [rangeMonths]) }}</span>
          </template>
          <template v-else-if="hoveredDay.day.future">
            <span class="tooltip-text is-dim">{{ $t('暂无数据') }}</span>
          </template>
          <template v-else-if="hoveredDay.day.activeEventCount">
            <div class="tooltip-stat">
              <span class="stat-highlight">{{ hoveredDay.day.activeEventCount }}</span> {{ $t('个事件') }}
              <span class="stat-sep">·</span>
              {{ $t('影响') }} <strong>{{ formatDuration(hoveredDay.day.affectedMinutes) }}</strong>
            </div>
            <div class="tooltip-hint" v-if="isInteractiveDay(hoveredDay.day)">
              {{ $t('点击查看事件详情') }} ↗
            </div>
          </template>
          <template v-else-if="hoveredDay.day.date === todayKey && hoveredDay.day.coverageRatio < 0.8">
            <div class="tooltip-stat is-detecting-stat">
              <span class="detecting-pulse-dot"></span>
              {{ $t('运行检测中 · 采集覆盖率 {0}%', [Math.round(hoveredDay.day.coverageRatio * 100)]) }}
            </div>
          </template>
          <template v-else-if="hoveredDay.day.coverageRatio < 0.8">
            <div class="tooltip-stat is-no-data-stat">
              {{ $t('该日期暂无监控采集数据') }}
            </div>
          </template>
          <template v-else>
            <div class="tooltip-stat is-healthy">
              <CheckCircle2 :size="12" /> {{ $t('运行正常 · 覆盖 100%') }}
            </div>
          </template>
        </div>
      </div>
    </transition>


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
  margin-top: 14px;
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-panel, 8px);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  transition: border-color var(--dur-short, .2s) var(--ease-out, ease);
}

.event-calendar:hover {
  border-color: var(--color-rule-strong, var(--ink-200));
}

.event-calendar__header {
  min-height: 48px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: color-mix(in srgb, var(--ink-50) 30%, var(--surface));
}

.event-calendar__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.event-calendar__icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--teal-50);
  color: var(--teal-600);
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

.event-calendar__title-wrap {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* 单行一体化控制栏 */
.event-calendar__unified-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: color-mix(in srgb, var(--ink-50) 40%, var(--surface));
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  padding: 3px 6px;
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.02);
}

.toolbar-section {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-divider {
  width: 1px;
  height: 16px;
  background: var(--ink-150, color-mix(in srgb, var(--ink-200) 60%, transparent));
  margin: 0 2px;
}

.timeline-presets {
  display: flex;
  gap: 2px;
}

.preset-chip {
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ink-600);
  font-size: 10.5px;
  font-weight: 600;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all 0.12s ease;
  white-space: nowrap;
}

.preset-chip:hover {
  background: var(--surface);
  color: var(--ink-900);
}

.preset-chip.is-active {
  background: var(--teal-600);
  color: #ffffff;
  box-shadow: 0 1px 2px rgba(20, 184, 166, 0.25);
}

.timeline-slider-holder {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 2px;
}

.timeline-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 60px;
  height: 4px;
  border-radius: 2px;
  background: var(--ink-200);
  outline: none;
  cursor: pointer;
}

.timeline-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--teal-600);
  border: 2px solid var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  transition: transform 0.1s ease;
}

.timeline-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.timeline-slider__val {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--teal-700);
  min-width: 20px;
}

.toolbar-nav {
  display: flex;
  align-items: center;
  gap: 2px;
}

.toolbar-nav button {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ink-500);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: all 0.12s ease;
}

.toolbar-nav button:hover:not(:disabled) {
  background: var(--surface);
  color: var(--teal-700);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.toolbar-nav button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.toolbar-range-label {
  min-width: 140px;
  color: var(--ink-800);
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono);
  user-select: none;
  padding: 0 4px;
}

/* 零延迟即时悬浮提示卡片 Instant Popover Tooltip */
.event-calendar__instant-tooltip {
  position: absolute;
  z-index: 50;
  pointer-events: none;
  min-width: 170px;
  max-width: 280px;
  padding: 8px 11px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.94);
  color: #f8fafc;
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(8px);
  font-family: var(--font-body);
}

.event-calendar__instant-tooltip.placement-top {
  transform: translate(-50%, -100%);
}

.event-calendar__instant-tooltip.placement-bottom {
  transform: translate(-50%, 0);
}

.tooltip-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.tooltip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tooltip-dot.is-healthy { background: #10b981; box-shadow: 0 0 6px #10b981; }
.tooltip-dot.is-info { background: #38bdf8; box-shadow: 0 0 6px #38bdf8; }
.tooltip-dot.is-warning { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
.tooltip-dot.is-major { background: #f97316; box-shadow: 0 0 6px #f97316; }
.tooltip-dot.is-critical { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
.tooltip-dot.is-no-data { background: #64748b; }
.tooltip-dot.is-inactive { background: #94a3b8; }
.tooltip-dot.is-detecting { background: #2dd4bf; box-shadow: 0 0 6px #2dd4bf; }

.tooltip-date {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 700;
  color: #ffffff;
}

.tooltip-badge {
  margin-left: auto;
  font-size: 9.5px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  line-height: 1.2;
}

.tooltip-badge.is-healthy { background: rgba(16, 185, 129, 0.2); color: #34d399; }
.tooltip-badge.is-info { background: rgba(56, 189, 248, 0.2); color: #7dd3fc; }
.tooltip-badge.is-warning { background: rgba(245, 158, 11, 0.25); color: #fbbf24; }
.tooltip-badge.is-major { background: rgba(249, 115, 22, 0.25); color: #fb923c; }
.tooltip-badge.is-critical { background: rgba(239, 68, 68, 0.3); color: #f87171; }
.tooltip-badge.is-no-data { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
.tooltip-badge.is-inactive { background: rgba(148, 163, 184, 0.18); color: #94a3b8; }
.tooltip-badge.is-detecting { background: rgba(20, 184, 166, 0.25); color: #2dd4bf; }

.tooltip-body {
  font-size: 11px;
  line-height: 1.4;
  color: #cbd5e1;
}

.is-no-data-stat {
  color: #94a3b8;
  font-size: 10.5px;
}

.is-detecting-stat {
  color: #2dd4bf;
  font-size: 10.5px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.detecting-pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2dd4bf;
  box-shadow: 0 0 6px #2dd4bf;
  display: inline-block;
  animation: pulse-dot 1.5s infinite ease-in-out;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 0.6; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.15); }
}

.tooltip-stat {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tooltip-stat.is-healthy {
  color: #34d399;
  font-size: 10.5px;
}

.stat-highlight {
  color: #f87171;
  font-weight: 700;
  font-family: var(--font-mono);
}

.stat-sep {
  opacity: 0.4;
}

.tooltip-hint {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed rgba(255, 255, 255, 0.12);
  color: #94a3b8;
  font-size: 9.5px;
  text-align: right;
}

/* Popover 极速淡入淡出动画 */
.popover-fade-enter-active,
.popover-fade-leave-active {
  transition: opacity 0.08s ease, transform 0.08s cubic-bezier(0.16, 1, 0.3, 1);
}

.popover-fade-enter-from,
.popover-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, -95%) scale(0.96);
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
  opacity: 0.38;
  color: var(--ink-400);
  transition: opacity 0.15s ease, color 0.15s ease, font-weight 0.15s ease;
}

.event-calendar__months span.is-active {
  opacity: 1;
  color: var(--ink-800);
  font-weight: 700;
}

.event-calendar__plot {
  display: flex;
  align-items: stretch;
  gap: 9px;
  position: relative;
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

.event-calendar__weeks-wrapper {
  position: relative;
  display: flex;
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

/* 范围分界拦截线与拖动手柄 */
.event-calendar__range-divider {
  position: absolute;
  top: -24px;
  bottom: -6px;
  width: 0;
  z-index: 25;
  cursor: ew-resize;
  touch-action: none;
  transition: left 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

.event-calendar__range-divider.is-dragging {
  transition: none;
}

.range-divider-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -1px;
  width: 2px;
  background: var(--teal-500);
  box-shadow: 0 0 8px color-mix(in srgb, var(--teal-500) 65%, transparent), 0 0 2px var(--teal-500);
  border-radius: 1px;
}

.range-divider-handle {
  position: absolute;
  top: 50%;
  left: 0;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  border-radius: 6px;
  background: var(--surface);
  border: 1.5px solid var(--teal-500);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18), 0 0 0 2px color-mix(in srgb, var(--teal-500) 25%, transparent);
  cursor: ew-resize;
  user-select: none;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.range-divider-handle:hover,
.event-calendar__range-divider.is-dragging .range-divider-handle {
  transform: translate(-50%, -50%) scale(1.1);
  box-shadow: 0 4px 14px rgba(20, 184, 166, 0.4), 0 0 0 3px color-mix(in srgb, var(--teal-500) 35%, transparent);
}

.handle-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--teal-700);
  line-height: 1;
}

.handle-grip {
  display: flex;
  gap: 2px;
}

.grip-bar {
  width: 1.5px;
  height: 6px;
  border-radius: 1px;
  background: var(--teal-400);
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

/* 未选时间范围（竖线左侧）的方格表现：轻微灰度沉浸，点击即可将竖线拉到该日期 */
.event-calendar__cell.is-inactive {
  background: color-mix(in srgb, var(--ink-100) 40%, var(--surface));
  border-color: color-mix(in srgb, var(--ink-200) 25%, transparent);
  opacity: 0.32;
  cursor: pointer;
}

.event-calendar__cell.is-inactive:hover {
  opacity: 0.7;
  border-color: var(--teal-400);
  transform: scale(1.2);
}

/* 极简清爽的“无数据”状态：剔除密集斜线马赛克，采用淡雅微槽底色 */
.event-calendar__cell.is-no-data {
  background: color-mix(in srgb, var(--ink-100) 45%, var(--surface));
  border-color: color-mix(in srgb, var(--ink-200) 35%, transparent);
}

/* 当日采集中/检测中状态：柔和青绿呼吸微光 */
.event-calendar__cell.is-detecting {
  background: color-mix(in srgb, var(--teal-500) 25%, var(--surface));
  border-color: var(--teal-500);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--teal-500) 40%, transparent);
  animation: cell-detecting-pulse 2.2s infinite ease-in-out;
}

@keyframes cell-detecting-pulse {
  0%, 100% { opacity: 0.82; }
  50% { opacity: 1; filter: brightness(1.15); box-shadow: 0 0 6px color-mix(in srgb, var(--teal-500) 60%, transparent); }
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
  min-height: 38px;
  padding: 6px 14px;
  border-top: 1px solid var(--ink-100);
  background: color-mix(in srgb, var(--ink-50) 30%, var(--surface));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.event-calendar__totals {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.totals-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--ink-100);
  color: var(--ink-600);
  font-size: 10.5px;
  line-height: 1.2;
}

.totals-pill strong {
  color: var(--ink-900);
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px;
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
