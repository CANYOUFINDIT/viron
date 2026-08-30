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
      <component :is="icon" :size="15" class="monitor-chart-card__glyph" />
      <div class="monitor-chart-card__title-group"><strong>{{ title }}</strong><small v-if="subtitle">{{ subtitle }}</small></div>
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
            <stop offset="0%" :stop-color="series[0]?.color" stop-opacity=".18" />
            <stop offset="100%" :stop-color="series[0]?.color" stop-opacity="0.01" />
          </linearGradient>
        </defs>
        <g class="chart-grid">
          <template v-for="(tick, index) in yTicks" :key="index">
            <line :x1="plot.left" :x2="plot.left + plotWidth" :y1="plot.top + plotHeight * index / 4" :y2="plot.top + plotHeight * index / 4" />
            <text :x="plot.left - 9" :y="plot.top + plotHeight * index / 4 + 3.5" text-anchor="end">{{ formatValue(tick) }}</text>
          </template>
          <template v-for="index in xTickIndexes" :key="`x-${index}`">
            <line :x1="xFor(index)" :x2="xFor(index)" :y1="plot.top" :y2="plot.top + plotHeight" class="is-vertical" />
            <text :x="xFor(index)" :y="chartHeight - 11" :text-anchor="index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'">{{ formatTime(points[index]!.at) }}</text>
          </template>
        </g>
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
            r="3.5"
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
  border: 1px solid var(--ink-100);
  border-radius: var(--radius-card, 8px);
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--dur-short, .2s) var(--ease-out, ease);
}

.monitor-chart-card:hover {
  border-color: var(--color-rule-strong, var(--ink-200));
}

.monitor-chart-card > header {
  min-height: 2.5rem;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ink-100);
  display: grid;
  grid-template-columns: auto minmax(6rem, 1fr) auto;
  align-items: center;
  gap: 8px;
  background: color-mix(in srgb, var(--ink-50) 30%, var(--surface));
}

.monitor-chart-card__glyph {
  color: var(--teal-600);
  flex-shrink: 0;
}

.monitor-chart-card__title-group {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.monitor-chart-card header strong {
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-900);
}

.monitor-chart-card header small {
  overflow: hidden;
  color: var(--ink-400);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.monitor-chart-card__legend {
  display: flex !important;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 3px 10px !important;
}

.monitor-chart-card__legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ink-500);
  font-size: 10.5px;
  white-space: nowrap;
}

.monitor-chart-card__legend i,
.monitor-chart-tooltip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.monitor-chart-card__plot {
  position: relative;
  min-height: 14rem;
  padding: 8px 12px 10px;
}

.monitor-chart-card.is-hero .monitor-chart-card__plot { min-height: 19rem; }
.monitor-chart-card.is-compact .monitor-chart-card__plot { min-height: 10rem; }

.monitor-chart-card__plot > svg {
  display: block;
  width: 100%;
  height: 14rem;
  overflow: visible;
  touch-action: pan-y;
}

.monitor-chart-card.is-hero .monitor-chart-card__plot > svg { height: 19rem; }
.monitor-chart-card.is-compact .monitor-chart-card__plot > svg { height: 10rem; }

.chart-threshold line {
  stroke: var(--amber-600);
  stroke-width: 1;
  stroke-dasharray: 4 3;
  vector-effect: non-scaling-stroke;
  opacity: .85;
}

.chart-threshold text {
  fill: var(--amber-600);
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
}

.chart-grid line {
  stroke: color-mix(in srgb, var(--ink-100) 85%, transparent);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.chart-grid line.is-vertical {
  stroke-dasharray: 2 4;
  opacity: .4;
}

.chart-grid text {
  fill: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 9.5px;
}

.chart-area { pointer-events: none; }
.chart-stack-area {
  opacity: .82;
  pointer-events: none;
}

.chart-total-line {
  fill: none;
  stroke: var(--ink-950);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}

.chart-line {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}

.chart-annotations rect {
  opacity: .12;
  pointer-events: none;
}

.chart-annotations rect.is-warning { fill: var(--amber-600); }
.chart-annotations rect.is-critical { fill: var(--red-600); opacity: .16; }

.chart-hover line {
  stroke: color-mix(in srgb, var(--ink-500) 60%, transparent);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}

.chart-hover circle {
  stroke: var(--surface);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.monitor-chart-tooltip {
  position: absolute;
  z-index: 10;
  inset-block-start: 10px;
  inset-inline-start: 56px;
  min-width: 10rem;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-control, 7px);
  display: grid;
  gap: 4px;
  background: rgba(15, 23, 27, 0.94);
  backdrop-filter: blur(8px);
  color: #f1f5f9;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  pointer-events: none;
}

.monitor-chart-tooltip.is-left { inset-inline: auto 12px; }
.monitor-chart-tooltip time { color: #94a3b8; font-family: var(--font-mono); font-size: 9.5px; }
.monitor-chart-tooltip span { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; font-size: 11px; }
.monitor-chart-tooltip i.is-total { border: 1px solid rgba(255, 255, 255, 0.7); background: transparent; }
.monitor-chart-tooltip strong { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: #ffffff; }
.monitor-chart-tooltip small { padding-block-start: 3px; border-block-start: 1px solid rgba(255, 255, 255, .1); color: #fbbf24; font-size: 9.5px; }

.monitor-chart-card__empty {
  min-height: 14rem;
  display: grid;
  place-items: center;
  color: var(--ink-400);
  font-size: 12px;
}

.monitor-chart-card.is-hero .monitor-chart-card__empty { min-height: 19rem; }
.monitor-chart-card.is-compact .monitor-chart-card__empty { min-height: 10rem; }

@media (max-width: 720px) {
  .monitor-chart-card > header { grid-template-columns: auto minmax(0, 1fr); }
  .monitor-chart-card__legend { grid-column: 1 / -1; justify-content: flex-start; }
  .monitor-chart-card__plot > svg,
  .monitor-chart-card.is-hero .monitor-chart-card__plot > svg { height: 12rem; }
  .monitor-chart-card__plot,
  .monitor-chart-card.is-hero .monitor-chart-card__plot { min-height: 12rem; padding-inline: 6px; }
}
</style>
