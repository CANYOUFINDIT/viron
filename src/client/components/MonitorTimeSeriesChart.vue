<script setup lang="ts">
import type { Component } from "vue";
import { computed, ref } from "vue";
import { translate as tr } from "../i18n";
import { monitorChartPointerPosition } from "../monitor-chart-pointer";

export interface MonitorChartPoint {
  at: string;
  breakBefore?: boolean;
}

export interface MonitorChartSeries {
  key: string;
  label: string;
  color: string;
  values: Array<number | null>;
}

export interface MonitorChartAnnotation {
  startedAt: string;
  endedAt: string;
  severity: "warning" | "critical";
  label: string;
}

export interface MonitorChartTooltipRow {
  key: string;
  label: string;
  color: string;
  value: number | null;
}

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  icon: Component;
  points: MonitorChartPoint[];
  series: MonitorChartSeries[];
  format?: "percent" | "bytes" | "bytesPerSecond" | "opsPerSecond" | "duration" | "temperature" | "count" | "decimal";
  yMin?: number;
  yMax?: number;
  stacked?: boolean;
  totalValues?: Array<number | null>;
  totalLabel?: string;
  annotations?: MonitorChartAnnotation[];
  tooltipRows?: MonitorChartTooltipRow[][];
  size?: "hero" | "default" | "compact";
  threshold?: number | null;
  tone?: "ok" | "warn" | "critical" | "";
}>(), {
  subtitle: "",
  format: "decimal",
  yMin: 0,
  yMax: undefined,
  stacked: false,
  totalValues: () => [],
  totalLabel: "",
  annotations: () => [],
  tooltipRows: () => [],
  size: "default",
  threshold: null,
  tone: "",
});

const chartWidth = 720;
const chartHeight = computed(() => (props.size === "hero" ? 320 : props.size === "compact" ? 168 : 236));
const plot = computed(() => ({
  left: 54,
  right: 18,
  top: props.size === "hero" ? 16 : 18,
  bottom: 38,
}));
const plotWidth = computed(() => chartWidth - plot.value.left - plot.value.right);
const plotHeight = computed(() => chartHeight.value - plot.value.top - plot.value.bottom);
const hoveredIndex = ref<number | null>(null);
const hoveredX = ref<number | null>(null);
const gradientId = `monitor-area-${Math.random().toString(36).slice(2)}`;

const stackedTotals = computed(() => props.points.map((_, pointIndex) => props.series.reduce((sum, series) => {
  const value = series.values[pointIndex];
  return sum + (Number.isFinite(value) ? Number(value) : 0);
}, 0)));
const finiteValues = computed(() => (props.stacked
  ? (props.totalValues.length ? props.totalValues : stackedTotals.value)
  : props.series.flatMap((series) => series.values)
).filter((value): value is number => Number.isFinite(value)));
const domain = computed(() => {
  const maximum = props.yMax ?? Math.max(props.yMin, ...finiteValues.value, 1);
  if (maximum === props.yMin) return { min: props.yMin, max: props.yMin + 1 };
  const padding = props.yMax === undefined ? (maximum - props.yMin) * 0.08 : 0;
  return { min: props.yMin, max: maximum + padding };
});
const hasData = computed(() => finiteValues.value.length > 0 && props.points.length > 0);
const thresholdVisible = computed(() => Number.isFinite(props.threshold));
const thresholdTone = computed(() => {
  if (props.tone) return props.tone;
  if (!thresholdVisible.value) return "";
  const latest = finiteValues.value.at(-1);
  if (!Number.isFinite(latest)) return "";
  const threshold = Number(props.threshold);
  if (Number(latest) >= threshold) return "critical";
  if (Number(latest) >= threshold * 0.8) return "warn";
  return "ok";
});
const thresholdBand = computed(() => {
  if (!thresholdVisible.value) return null;
  const y = yFor(Number(props.threshold));
  return {
    y,
    height: Math.max(0, y - plot.value.top),
  };
});
const startTime = computed(() => Date.parse(props.points[0]?.at ?? ""));
const endTime = computed(() => Date.parse(props.points.at(-1)?.at ?? ""));
const timeSpan = computed(() => Math.max(1, endTime.value - startTime.value));
const yTicks = computed(() => Array.from({ length: 5 }, (_, index) => domain.value.max - (domain.value.max - domain.value.min) * index / 4));
const xTickIndexes = computed(() => {
  if (!props.points.length) return [];
  return [...new Set(Array.from({ length: 4 }, (_, index) => Math.round((props.points.length - 1) * index / 3)))];
});

function xFor(index: number): number {
  const time = Date.parse(props.points[index]?.at ?? "");
  if (!Number.isFinite(time) || !Number.isFinite(startTime.value)) return plot.value.left;
  return plot.value.left + (time - startTime.value) / timeSpan.value * plotWidth.value;
}

function yFor(value: number): number {
  return plot.value.top + (domain.value.max - value) / (domain.value.max - domain.value.min) * plotHeight.value;
}

function linePath(series: MonitorChartSeries): string {
  let path = "";
  let drawing = false;
  series.values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      drawing = false;
      return;
    }
    if (props.points[index]?.breakBefore) drawing = false;
    path += `${drawing ? "L" : "M"}${xFor(index).toFixed(2)},${yFor(value as number).toFixed(2)}`;
    drawing = true;
  });
  return path;
}

function stackedValue(seriesIndex: number, pointIndex: number): number | null {
  let total = 0;
  let found = false;
  for (let index = 0; index <= seriesIndex; index += 1) {
    const value = props.series[index]?.values[pointIndex];
    if (!Number.isFinite(value)) continue;
    total += Number(value);
    found = true;
  }
  return found ? total : null;
}

function stackedAreaPath(seriesIndex: number): string {
  const segments: number[][] = [];
  let segment: number[] = [];
  props.points.forEach((point, index) => {
    const value = props.series[seriesIndex]?.values[index];
    if (!Number.isFinite(value) || point.breakBefore) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (Number.isFinite(value)) segment.push(index);
  });
  if (segment.length) segments.push(segment);
  return segments.map((indexes) => {
    const upper = indexes.map((index) => `${xFor(index).toFixed(2)},${yFor(stackedValue(seriesIndex, index) ?? 0).toFixed(2)}`);
    const lower = [...indexes].reverse().map((index) => `${xFor(index).toFixed(2)},${yFor(seriesIndex > 0 ? stackedValue(seriesIndex - 1, index) ?? 0 : 0).toFixed(2)}`);
    return `M${upper.join("L")}L${lower.join("L")}Z`;
  }).join("");
}

function totalLinePath(): string {
  return linePath({
    key: "total",
    label: props.totalLabel,
    color: "",
    values: props.totalValues.length ? props.totalValues : stackedTotals.value,
  });
}

function areaPath(series: MonitorChartSeries): string {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];
  series.values.forEach((value, index) => {
    if (!Number.isFinite(value) || props.points[index]?.breakBefore) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (Number.isFinite(value)) segment.push({ x: xFor(index), y: yFor(value as number) });
  });
  if (segment.length) segments.push(segment);
  const baseline = plot.value.top + plotHeight.value;
  return segments.map((items) => {
    const first = items[0]!;
    const last = items.at(-1)!;
    return `M${first.x.toFixed(2)},${baseline}L${items.map((item) => `${item.x.toFixed(2)},${item.y.toFixed(2)}`).join("L")}L${last.x.toFixed(2)},${baseline}Z`;
  }).join("");
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (props.format === "percent") return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
  if (props.format === "temperature") return `${value.toFixed(1)}°C`;
  if (props.format === "count") return Math.round(value).toLocaleString();
  if (props.format === "duration") {
    if (value >= 86_400) return `${(value / 86_400).toFixed(1)} d`;
    if (value >= 3_600) return `${(value / 3_600).toFixed(1)} h`;
    if (value >= 60) return `${(value / 60).toFixed(1)} min`;
    return `${Math.round(value)} s`;
  }
  if (props.format === "bytes") return formatBytes(value);
  if (props.format === "bytesPerSecond") return `${formatBytes(value)}/s`;
  if (props.format === "opsPerSecond") return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ops/s`;
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = Math.max(0, value);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unit]}`;
}

function annotationX(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return plot.value.left;
  return Math.max(plot.value.left, Math.min(plot.value.left + plotWidth.value, plot.value.left + (time - startTime.value) / timeSpan.value * plotWidth.value));
}

function tooltipItems(index: number): MonitorChartTooltipRow[] {
  if (props.tooltipRows[index]?.length) return props.tooltipRows[index]!;
  return props.series.map((series) => ({
    key: series.key,
    label: series.label,
    color: series.color,
    value: series.values[index] ?? null,
  }));
}

function hoverY(seriesIndex: number, pointIndex: number): number {
  const value = props.stacked ? stackedValue(seriesIndex, pointIndex) : props.series[seriesIndex]?.values[pointIndex];
  return yFor(Number(value ?? 0));
}

function hoverSeries(pointIndex: number): Array<{ item: MonitorChartSeries; seriesIndex: number }> {
  return props.series.flatMap((item, seriesIndex) => Number.isFinite(item.values[pointIndex]) ? [{ item, seriesIndex }] : []);
}

function formatTime(value: string, detailed = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const sameDay = Number.isFinite(startTime.value) && new Date(startTime.value).toDateString() === new Date(endTime.value).toDateString();
  return new Intl.DateTimeFormat(undefined, detailed || !sameDay
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: detailed ? "2-digit" : undefined }
    : { hour: "2-digit", minute: "2-digit" }).format(date);
}

function hover(event: PointerEvent) {
  if (!props.points.length) return;
  const bounds = (event.currentTarget as SVGElement).getBoundingClientRect();
  const pointer = monitorChartPointerPosition(event.clientX, bounds.left, bounds.width, chartWidth, plot.value.left, plotWidth.value);
  const targetTime = startTime.value + pointer.ratio * timeSpan.value;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  props.points.forEach((point, index) => {
    const current = Math.abs(Date.parse(point.at) - targetTime);
    if (current < distance) {
      nearest = index;
      distance = current;
    }
  });
  hoveredX.value = pointer.x;
  hoveredIndex.value = nearest;
}

function clearHover() {
  hoveredX.value = null;
  hoveredIndex.value = null;
}
</script>

<template>
  <article class="monitor-chart-card" :class="[`is-${size}`, thresholdTone ? `is-${thresholdTone}` : '']">
    <header>
      <component :is="icon" :size="16" class="monitor-chart-card__glyph" />
      <div><strong>{{ title }}</strong><small v-if="subtitle">{{ subtitle }}</small></div>
      <div class="monitor-chart-card__legend" :aria-label="tr('图例')">
        <span v-for="item in series" :key="item.key"><i :style="{ background: item.color }"></i>{{ item.label }}</span>
      </div>
    </header>
    <div v-if="hasData" class="monitor-chart-card__plot">
      <svg
        :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
        preserveAspectRatio="none"
        role="img"
        :aria-label="title"
        @pointermove="hover"
        @pointerleave="clearHover"
      >
        <defs>
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" :stop-color="series[0]?.color" stop-opacity=".2" />
            <stop offset="1" :stop-color="series[0]?.color" stop-opacity="0" />
          </linearGradient>
        </defs>
        <g class="chart-grid">
          <template v-for="(tick, index) in yTicks" :key="index">
            <line :x1="plot.left" :x2="plot.left + plotWidth" :y1="plot.top + plotHeight * index / 4" :y2="plot.top + plotHeight * index / 4" />
            <text :x="plot.left - 9" :y="plot.top + plotHeight * index / 4 + 4" text-anchor="end">{{ formatValue(tick) }}</text>
          </template>
          <template v-for="index in xTickIndexes" :key="`x-${index}`">
            <line :x1="xFor(index)" :x2="xFor(index)" :y1="plot.top" :y2="plot.top + plotHeight" class="is-vertical" />
            <text :x="xFor(index)" :y="chartHeight - 11" :text-anchor="index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'">{{ formatTime(points[index]!.at) }}</text>
          </template>
        </g>
        <rect
          v-if="thresholdBand && thresholdTone !== 'ok'"
          class="chart-threshold-band"
          :class="`is-${thresholdTone}`"
          :x="plot.left"
          :y="plot.top"
          :width="plotWidth"
          :height="thresholdBand.height"
        />
        <g v-if="annotations.length" class="chart-annotations">
          <rect
            v-for="annotation in annotations"
            :key="`${annotation.startedAt}:${annotation.endedAt}:${annotation.label}`"
            :x="annotationX(annotation.startedAt)"
            :y="plot.top"
            :width="Math.max(2, annotationX(annotation.endedAt) - annotationX(annotation.startedAt))"
            :height="plotHeight"
            :class="`is-${annotation.severity}`"
          ><title>{{ annotation.label }}</title></rect>
        </g>
        <g v-if="thresholdVisible" class="chart-threshold">
          <line :x1="plot.left" :x2="plot.left + plotWidth" :y1="thresholdBand?.y ?? yFor(Number(threshold))" :y2="thresholdBand?.y ?? yFor(Number(threshold))" />
          <text :x="plot.left + plotWidth - 4" :y="(thresholdBand?.y ?? yFor(Number(threshold))) - 5" text-anchor="end">{{ formatValue(Number(threshold)) }}</text>
        </g>
        <template v-if="stacked">
          <path v-for="(item, index) in series" :key="item.key" :d="stackedAreaPath(index)" :fill="item.color" class="chart-stack-area" />
          <path :d="totalLinePath()" class="chart-total-line" />
        </template>
        <template v-else>
          <path v-if="series.length === 1" :d="areaPath(series[0]!)" :fill="`url(#${gradientId})`" class="chart-area" />
          <path v-for="item in series" :key="item.key" :d="linePath(item)" :stroke="item.color" class="chart-line" />
        </template>
        <g v-if="hoveredIndex !== null && hoveredX !== null" class="chart-hover">
          <line :x1="hoveredX" :x2="hoveredX" :y1="plot.top" :y2="plot.top + plotHeight" />
          <circle
            v-for="entry in hoverSeries(hoveredIndex)"
            :key="entry.item.key"
            :cx="xFor(hoveredIndex)"
            :cy="hoverY(entry.seriesIndex, hoveredIndex)"
            r="4"
            :fill="entry.item.color"
          />
        </g>
      </svg>
      <div v-if="hoveredIndex !== null && hoveredX !== null" class="monitor-chart-tooltip" :class="{ 'is-left': hoveredX > plot.left + plotWidth / 2 }">
        <time>{{ formatTime(points[hoveredIndex].at, true) }}</time>
        <span v-if="totalValues.length"><i class="is-total"></i>{{ totalLabel || tr('总计') }}<strong>{{ totalValues[hoveredIndex] == null ? '—' : formatValue(totalValues[hoveredIndex]!) }}</strong></span>
        <span v-for="item in tooltipItems(hoveredIndex)" :key="item.key"><i :style="{ background: item.color }"></i>{{ item.label }}<strong>{{ item.value === null ? '—' : formatValue(item.value) }}</strong></span>
        <small v-if="points[hoveredIndex].breakBefore">{{ tr('采集在此处恢复') }}</small>
      </div>
    </div>
    <div v-else class="monitor-chart-card__empty">{{ tr('当前时间范围没有可绘制的数据') }}</div>
  </article>
</template>

<style scoped>
.monitor-chart-card {
  min-width: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-panel);
  overflow: hidden;
  background: var(--color-paper);
}
.monitor-chart-card.is-warn { background: color-mix(in srgb, var(--color-warning-soft) 42%, var(--color-paper)); }
.monitor-chart-card.is-critical { background: color-mix(in srgb, var(--color-danger-soft) 46%, var(--color-paper)); }
.monitor-chart-card > header {
  min-height: 2.75rem;
  padding: var(--space-xs) var(--space-sm);
  border-block-end: 1px solid var(--color-rule);
  display: grid;
  grid-template-columns: auto minmax(7rem, 1fr) auto;
  align-items: center;
  gap: var(--space-xs);
}
.monitor-chart-card__glyph { color: var(--color-ink-soft); }
.monitor-chart-card header > div:nth-child(2) { min-width: 0; display: grid; gap: 1px; }
.monitor-chart-card header strong { font-size: var(--text-sm); font-weight: 700; }
.monitor-chart-card header small { overflow: hidden; color: var(--color-muted); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.monitor-chart-card__legend { display: flex !important; justify-content: flex-end; flex-wrap: wrap; gap: 4px var(--space-sm) !important; }
.monitor-chart-card__legend span { display: inline-flex; align-items: center; gap: 5px; color: var(--color-muted); font-size: var(--text-2xs); white-space: nowrap; }
.monitor-chart-card__legend i,
.monitor-chart-tooltip i { width: 6px; height: 6px; border-radius: 50%; }
.monitor-chart-card__plot { position: relative; min-height: 15rem; padding: var(--space-xs) var(--space-sm) var(--space-sm); }
.monitor-chart-card.is-hero .monitor-chart-card__plot { min-height: 20.5rem; }
.monitor-chart-card.is-compact .monitor-chart-card__plot { min-height: 10.5rem; }
.monitor-chart-card__plot > svg { display: block; width: 100%; height: 15rem; overflow: visible; touch-action: pan-y; }
.monitor-chart-card.is-hero .monitor-chart-card__plot > svg { height: 20.5rem; }
.monitor-chart-card.is-compact .monitor-chart-card__plot > svg { height: 10.5rem; }
.chart-threshold-band { pointer-events: none; }
.chart-threshold-band.is-warn { fill: color-mix(in srgb, var(--color-warning) 10%, transparent); }
.chart-threshold-band.is-critical { fill: color-mix(in srgb, var(--color-danger) 12%, transparent); }
.chart-threshold line { stroke: var(--color-warning); stroke-width: 1.2; stroke-dasharray: 4 4; vector-effect: non-scaling-stroke; }
.chart-threshold text { fill: var(--color-warning); font-family: var(--font-mono); font-size: 9px; }
.chart-grid line { stroke: var(--color-rule); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart-grid line.is-vertical { stroke-dasharray: 2 5; opacity: .55; }
.chart-grid text { fill: var(--color-muted); font-family: var(--font-mono); font-size: 9px; }
.chart-area { pointer-events: none; }
.chart-stack-area { opacity: .72; pointer-events: none; }
.chart-total-line { fill: none; stroke: var(--color-ink); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; pointer-events: none; }
.chart-line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; pointer-events: none; }
.chart-annotations rect { opacity: .1; pointer-events: none; }
.chart-annotations rect.is-warning { fill: var(--color-warning); }
.chart-annotations rect.is-critical { fill: var(--color-danger); opacity: .14; }
.chart-hover line { stroke: color-mix(in srgb, var(--color-ink) 38%, transparent); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.chart-hover circle { stroke: var(--color-paper); stroke-width: 2; vector-effect: non-scaling-stroke; }
.monitor-chart-tooltip {
  position: absolute;
  z-index: 2;
  inset-block-start: var(--space-md);
  inset-inline-start: var(--space-xl);
  min-width: 10.5rem;
  padding: var(--space-sm);
  border: 1px solid var(--color-rule-strong);
  border-radius: var(--radius-control);
  display: grid;
  gap: 5px;
  background: color-mix(in srgb, var(--color-ink) 94%, transparent);
  color: var(--color-sidebar-ink);
  box-shadow: var(--shadow-dialog);
  pointer-events: none;
}
.monitor-chart-tooltip.is-left { inset-inline: auto var(--space-md); }
.monitor-chart-tooltip time { color: color-mix(in srgb, var(--color-sidebar-ink) 68%, transparent); font-family: var(--font-mono); font-size: 9px; }
.monitor-chart-tooltip span { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; font-size: var(--text-2xs); }
.monitor-chart-tooltip i.is-total { border: 1px solid color-mix(in srgb, var(--color-sidebar-ink) 70%, transparent); background: transparent; }
.monitor-chart-tooltip strong { font-family: var(--font-mono); font-size: var(--text-xs); }
.monitor-chart-tooltip small { padding-block-start: 4px; border-block-start: 1px solid rgba(255, 255, 255, .12); color: var(--color-warning); font-size: 9px; }
.monitor-chart-card__empty { min-height: 15rem; display: grid; place-items: center; color: var(--color-muted); font-size: var(--text-xs); }
.monitor-chart-card.is-hero .monitor-chart-card__empty { min-height: 20.5rem; }
.monitor-chart-card.is-compact .monitor-chart-card__empty { min-height: 10.5rem; }

@media (max-width: 720px) {
  .monitor-chart-card > header { grid-template-columns: auto minmax(0, 1fr); }
  .monitor-chart-card__legend { grid-column: 1 / -1; justify-content: flex-start; }
  .monitor-chart-card__plot > svg,
  .monitor-chart-card.is-hero .monitor-chart-card__plot > svg { height: 13rem; }
  .monitor-chart-card__plot,
  .monitor-chart-card.is-hero .monitor-chart-card__plot { min-height: 13rem; padding-inline: var(--space-2xs); }
}
</style>
