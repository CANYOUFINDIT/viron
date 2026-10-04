<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { CalendarRange, Server } from "@lucide/vue";
import { currentLocale, translate } from "../../i18n";
import GrantDetailsPopover from "./GrantDetailsPopover.vue";
import type { GrantDetailSource, GrantScopeResource } from "./grant-permission-details";
import {
  GRANT_TIMELINE_LEGEND,
  GRANT_TIMELINE_SPANS,
  buildGrantTimeline,
  grantRemainingCopy,
  grantTimelineWindow,
  type GrantTimelineRange,
  type GrantTimelineSpan,
  type GrantTimelineTone,
} from "./grant-timeline";

export interface GrantRowItem {
  grant: GrantDetailSource & {
    id: string;
    label?: string;
    resourceId: string;
    permissionText?: string;
    createdAt: string;
    startsAt?: string | null;
    expiresAt: string | null;
    expired: boolean;
  };
  source: string;
  inherited: boolean;
}

const props = defineProps<{
  rows: GrantRowItem[];
  selectedNodeType: "organization" | "project" | "member";
  organizationId?: string;
  resources?: GrantScopeResource[];
}>();

const emit = defineEmits<{
  (e: "edit", grant: any): void;
  (e: "revoke", grant: any): void;
  (e: "history", grant: any): void;
}>();

const timelineNow = ref(Date.now());
const activeFilter = ref<GrantTimelineTone | "all">("all");
const selectedSpan = ref<GrantTimelineSpan | "all" | "custom">(7);
const customRange = ref<GrantTimelineRange | null>(null);
const draftRange = ref<[Date, Date] | null>(null);
const draftTimestamps = computed(() => {
  const start = draftRange.value?.[0]?.getTime();
  const end = draftRange.value?.[1]?.getTime();
  return start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end } : null;
});
const timelineRange = computed(() => {
  if (selectedSpan.value === "all") return "all";
  if (selectedSpan.value === "custom") return customRange.value ?? grantTimelineWindow(timelineNow.value);
  return grantTimelineWindow(timelineNow.value, selectedSpan.value);
});
const rulerScale = ref<HTMLElement | null>(null);
const scaleWidth = ref(720);
const hoveredGrantId = ref<string | null>(null);
const focusedGrantId = ref<string | null>(null);
let timelineClock: ReturnType<typeof setInterval> | undefined;
let scaleObserver: ResizeObserver | undefined;

onMounted(() => {
  timelineClock = setInterval(() => {
    timelineNow.value = Date.now();
  }, 30_000);
  const node = rulerScale.value;
  if (!node || typeof ResizeObserver === "undefined") return;
  scaleObserver = new ResizeObserver(() => {
    scaleWidth.value = node.clientWidth;
  });
  scaleObserver.observe(node);
  scaleWidth.value = node.clientWidth;
});

onBeforeUnmount(() => {
  if (timelineClock) clearInterval(timelineClock);
  scaleObserver?.disconnect();
});

const grantTimeline = computed(() => {
  return buildGrantTimeline(
    props.rows.map((row) => ({
      id: row.grant.id,
      label: row.grant.label || row.grant.resourceId,
      createdAt: row.grant.createdAt,
      startsAt: row.grant.startsAt,
      expiresAt: row.grant.expiresAt,
      expired: row.grant.expired,
    })),
    timelineNow.value,
    timelineRange.value,
  );
});

const grantTimelineRows = computed(() => {
  const rowsMap = new Map(props.rows.map((row) => [row.grant.id, row]));
  const items = grantTimeline.value.bars.flatMap((bar) => {
    const row = rowsMap.get(bar.id);
    if (!row) return [];
    return [{ bar, row, remain: grantRemainingCopy(bar.remainingMs) }];
  });

  if (activeFilter.value === "all") return items;
  return items.filter((item) => item.bar.tone === activeFilter.value);
});

const highlightedGrant = computed(() => grantTimelineRows.value.find(
  (item) => item.bar.id === (hoveredGrantId.value ?? focusedGrantId.value),
));

const rulerBoundaries = computed(() => {
  const bar = highlightedGrant.value?.bar;
  if (!bar) return [];
  const model = grantTimeline.value;
  return [
    { kind: "start", time: bar.start, left: bar.startLeft, label: "起始时间" },
    { kind: "end", time: bar.end, left: bar.endLeft, label: "截止时间" },
  ].map((boundary) => ({
    ...boundary,
    inRange: boundary.time !== null && boundary.time >= model.axisStart && boundary.time <= model.axisEnd,
  }));
});
const rulerBoundaryMarkers = computed(() => rulerBoundaries.value.filter((boundary) => boundary.inRange));

const rulerTicks = computed(() => {
  const nowLeft = grantTimeline.value.nowLeft;
  const width = Math.max(scaleWidth.value, 1);
  const nowX = (nowLeft / 100) * width;
  const ticks = grantTimeline.value.ticks.map((tick) => ({
    ...tick,
    x: (tick.left / 100) * width,
    nearNow: grantTimeline.value.nowVisible && Math.abs((tick.left / 100) * width - nowX) < 28,
    showGuide: tick.left > 0.8 && tick.left < 99.2 && (!grantTimeline.value.nowVisible || Math.abs(tick.left - nowLeft) > 1.4),
    edge: tick.left <= 0.5 ? "start" : tick.left >= 99.5 ? "end" : "",
    showLabel: false,
  }));
  const chosen = new Set<number>();
  const fits = (tick: (typeof ticks)[number]) => {
    if (tick.nearNow) return false;
    return ticks.every((other) => !chosen.has(other.time) || Math.abs(other.x - tick.x) >= 64);
  };
  for (const tick of [ticks[0], ticks[ticks.length - 1]]) {
    if (tick && fits(tick)) chosen.add(tick.time);
  }
  for (const tick of ticks) {
    if (fits(tick)) chosen.add(tick.time);
  }
  for (const tick of ticks) tick.showLabel = chosen.has(tick.time);
  return ticks;
});

function changeSpan(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "custom") {
    const model = grantTimeline.value;
    customRange.value ??= { start: model.axisStart, end: model.axisEnd };
    draftRange.value = [new Date(customRange.value.start), new Date(customRange.value.end)];
    selectedSpan.value = "custom";
  } else if (value === "all") {
    selectedSpan.value = "all";
  } else {
    const days = Number(value) as GrantTimelineSpan;
    if (GRANT_TIMELINE_SPANS.includes(days)) selectedSpan.value = days;
  }
}

function applyCustomRange(): void {
  if (draftTimestamps.value) customRange.value = { ...draftTimestamps.value };
}

function grantSource(row: { source: string; inherited: boolean }): string {
  return row.inherited ? translate("继承自 {0}", [row.source]) : row.source;
}

function formatFullDateTime(time: number | string | null): string {
  if (!time) return translate("永久");
  const ts = typeof time === "string" ? Date.parse(time) : time;
  if (!Number.isFinite(ts)) return translate("永久");
  return new Date(ts).toLocaleString(currentLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatBoundaryDateTime(time: number): string {
  const date = new Date(time);
  const sameYear = new Date(grantTimeline.value.axisStart).getFullYear() === date.getFullYear()
    && new Date(grantTimeline.value.axisEnd).getFullYear() === date.getFullYear();
  const day = `${sameYear ? "" : `${date.getFullYear()}/`}${date.getMonth() + 1}/${date.getDate()}`;
  return `${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function leaveRowFocus(event: FocusEvent): void {
  if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)) {
    focusedGrantId.value = null;
  }
}

function canManage(row: GrantRowItem): boolean {
  return !row.inherited || props.selectedNodeType === "organization";
}
</script>

<template>
  <div class="chrono-timeline">
    <div class="trace-card">
      <div class="trace-head">
        <div class="trace-filters" role="tablist" :aria-label="$t('时序状态筛选')">
          <button
            type="button"
            class="trace-chip"
            :class="{ 'is-active': activeFilter === 'all' }"
            @click="activeFilter = 'all'"
          >
            <span class="trace-dot is-all"></span>
            <span>{{ $t('全部') }}</span>
            <b>{{ props.rows.length }}</b>
          </button>
          <button
            v-for="item in GRANT_TIMELINE_LEGEND"
            :key="item.tone"
            type="button"
            class="trace-chip"
            :class="[
              `is-${item.tone}`,
              { 'is-active': activeFilter === item.tone, 'is-dim': (grantTimeline.toneCounts[item.tone] || 0) === 0 },
            ]"
            @click="activeFilter = activeFilter === item.tone ? 'all' : item.tone"
          >
            <span class="trace-dot" :class="`is-${item.tone}`"></span>
            <span>{{ $t(item.label) }}</span>
            <b>{{ grantTimeline.toneCounts[item.tone] || 0 }}</b>
          </button>
        </div>
        <label class="trace-range-control">
          <CalendarRange :size="13" aria-hidden="true" />
          <span>{{ $t('时间跨度') }}</span>
          <select :value="selectedSpan" class="trace-range-select" :aria-label="$t('时间跨度')" @change="changeSpan">
            <option v-for="days in GRANT_TIMELINE_SPANS" :key="days" :value="days" v-text="$t('{{0}} 天', [days])"></option>
            <option value="all">{{ $t('全部时间') }}</option>
            <option value="custom">{{ $t('自定义范围') }}</option>
          </select>
        </label>
      </div>

      <div v-if="selectedSpan === 'custom'" class="trace-custom-range">
        <el-date-picker
          v-model="draftRange"
          type="datetimerange"
          size="small"
          format="YYYY/MM/DD HH:mm"
          :range-separator="$t('至')"
          :start-placeholder="$t('开始时间')"
          :end-placeholder="$t('结束时间')"
          :aria-label="$t('自定义时间范围')"
          class="trace-range-picker"
        />
        <button type="button" class="trace-range-apply" :disabled="!draftTimestamps" @click="applyCustomRange">
          {{ $t('应用范围') }}
        </button>
      </div>

      <div class="trace-ruler trace-cols">
        <div class="trace-ruler-label">
          <strong>{{ highlightedGrant ? (highlightedGrant.row.grant.label || highlightedGrant.row.grant.resourceId) : $t('资源') }}</strong>
          <small>{{ $t('悬停查看起止时间') }}</small>
        </div>
        <div ref="rulerScale" class="trace-scale">
          <span
            v-for="tick in rulerTicks"
            v-show="tick.showLabel"
            :key="tick.time"
            class="trace-tick"
            :class="tick.edge ? `is-${tick.edge}` : ''"
            :style="{ left: `${tick.left}%` }"
          >{{ tick.label }}</span>
          <template v-for="boundary in rulerBoundaries" :key="boundary.kind">
            <span v-if="boundary.inRange" class="trace-boundary-mark" :class="`is-${boundary.kind}`" :style="{ left: `${boundary.left}%` }"></span>
            <span
              class="trace-boundary-label"
              :class="`is-${boundary.kind}`"
              :title="`${$t(boundary.label)} · ${formatFullDateTime(boundary.time)}`"
            >
              <small>{{ $t(boundary.label) }}</small>
              <span v-if="boundary.time === null" class="trace-boundary-infinity" :aria-label="$t('永久有效')">♾️</span>
              <time v-else :datetime="new Date(boundary.time).toISOString()">{{ formatBoundaryDateTime(boundary.time) }}</time>
            </span>
          </template>
        </div>
        <div class="trace-col-meta"></div>
        <div></div>
      </div>

      <div class="trace-body">
        <div class="trace-guides trace-cols" aria-hidden="true">
          <div></div>
          <div class="trace-scale">
            <span
              v-for="tick in rulerTicks"
              v-show="tick.showGuide"
              :key="tick.time"
              class="trace-guide"
              :style="{ left: `${tick.left}%` }"
            ></span>
            <span
              v-for="boundary in rulerBoundaryMarkers"
              :key="boundary.kind"
              class="trace-boundary-guide"
              :class="`is-${boundary.kind}`"
              :style="{ left: `${boundary.left}%` }"
            ></span>
          </div>
          <div class="trace-col-meta"></div>
          <div></div>
        </div>

        <GrantDetailsPopover
          v-for="item in grantTimelineRows"
          :key="item.bar.id"
          :grant="item.row.grant"
          :source="grantSource(item.row)"
          :status="item.bar.openEnded && item.bar.tone !== 'expired' ? $t('永久有效') : $t(item.remain.key, item.remain.values)"
          :tone="item.bar.tone"
          :start="item.bar.start"
          :end="item.bar.end"
          :organization-id="organizationId"
          :resources="resources"
        >
          <article
            class="trace-row trace-cols"
            :class="[`is-${item.bar.tone}`, { 'is-highlighted': highlightedGrant?.bar.id === item.bar.id }]"
            tabindex="0"
            @mouseenter="hoveredGrantId = item.bar.id"
            @mouseleave="hoveredGrantId = null"
            @focusin="focusedGrantId = item.bar.id"
            @focusout="leaveRowFocus"
          >
            <div class="trace-label">
              <Server :size="14" />
              <span class="trace-label-copy">
                <strong :title="item.row.grant.label || item.row.grant.resourceId">
                  {{ item.row.grant.label || item.row.grant.resourceId }}
                </strong>
                <small class="trace-source"><span class="trace-source-name">{{ grantSource(item.row) }}</span><span>·</span><span class="trace-scope">{{ $t('授权范围') }}</span></small>
              </span>
            </div>

            <div class="trace-scale">
              <div class="trace-hit">
                <span v-if="item.bar.outsideRange" class="trace-outside" :class="`is-${item.bar.outsideRange}`">
                  {{ item.bar.outsideRange === 'before' ? $t('← 早于当前范围') : $t('晚于当前范围 →') }}
                </span>
                <div
                  v-else
                  class="trace-bar"
                  :style="{ left: `${item.bar.left}%`, width: `${item.bar.width}%` }"
                >
                  <span class="trace-bar-fill"></span>
                </div>
              </div>
            </div>

            <div class="trace-meta trace-col-meta">
              <span class="trace-meta-status">
                {{ item.bar.openEnded && item.bar.tone !== 'expired' ? $t('永久有效') : $t(item.remain.key, item.remain.values) }}
              </span>
              <span class="trace-meta-days">{{ item.bar.activeDays }}{{ $t('天') }}</span>
            </div>

            <div class="trace-actions">
              <button type="button" :title="$t('查看流转记录')" @click.stop="emit('history', item.row.grant)">
                {{ $t('记录') }}
              </button>
              <template v-if="canManage(item.row)">
                <button type="button" :title="$t('修改授权')" @click.stop="emit('edit', item.row.grant)">
                  {{ $t('修改') }}
                </button>
                <button type="button" class="is-revoke" :title="$t('撤销授权')" @click.stop="emit('revoke', item.row.grant)">
                  {{ $t('撤销') }}
                </button>
              </template>
              <small v-else :title="$t('在来源节点管理')">{{ $t('继承授权') }}</small>
            </div>
          </article>
        </GrantDetailsPopover>

        <div v-if="grantTimeline.nowVisible" class="trace-now-layer trace-cols" aria-hidden="true">
          <div></div>
          <div class="trace-scale">
            <span class="trace-now" :style="{ left: `${grantTimeline.nowLeft}%` }" :title="$t('当前时间点')">
              <i class="trace-now-diamond"></i>
              <span class="trace-sr">{{ $t('现在') }}</span>
            </span>
          </div>
          <div class="trace-col-meta"></div>
          <div></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chrono-timeline {
  container-type: inline-size;
  min-width: 0;
  width: 100%;
  margin-block-start: var(--space-xs);
}

.trace-card {
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 14px;
  background: var(--color-paper-raised);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--color-ink) 5%, transparent);
}

.trace-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  min-height: 42px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-rule);
}

.trace-range-control {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  margin-inline-start: auto;
  color: var(--color-muted);
  font-size: 11px;
  white-space: nowrap;
}

.trace-range-select {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--color-rule-strong);
  border-radius: 6px;
  background: var(--color-paper-raised);
  color: var(--color-ink);
  font: inherit;
  cursor: pointer;
}

.trace-range-select:focus-visible,
.trace-range-apply:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.trace-custom-range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-rule);
}

.trace-custom-range :deep(.trace-range-picker) {
  flex: 0 1 360px;
  min-width: 0;
  max-width: 100%;
}

.trace-range-apply {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--color-accent);
  border-radius: 6px;
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.trace-range-apply:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.trace-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.trace-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.trace-chip b {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
}

.trace-chip:hover {
  background: color-mix(in srgb, var(--color-ink) 4%, transparent);
  color: var(--color-ink);
}

.trace-chip.is-active {
  border-color: var(--color-rule-strong);
  background: color-mix(in srgb, var(--color-ink) 6%, transparent);
  color: var(--color-ink);
  font-weight: 600;
}

.trace-chip.is-dim {
  opacity: 0.45;
}

.trace-chip:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.trace-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.trace-dot.is-all { background: var(--color-ink-soft); }
.trace-dot.is-forever { background: var(--color-accent); }
.trace-dot.is-later { background: var(--color-info); }
.trace-dot.is-week { background: var(--color-warning); }
.trace-dot.is-soon { background: var(--color-danger); }
.trace-dot.is-expired { background: var(--color-faint); }

.trace-cols {
  display: grid;
  grid-template-columns: minmax(108px, 200px) minmax(72px, 1fr) minmax(4.25rem, 6.75rem) 8.25rem;
  column-gap: 10px;
  align-items: center;
  padding-inline: 12px;
}

.trace-ruler {
  height: 76px;
  border-bottom: 1px solid var(--color-rule);
}

.trace-ruler-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: var(--color-muted);
  font-size: 10px;
}

.trace-ruler-label strong {
  overflow: hidden;
  color: var(--color-ink-soft);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-ruler-label small { font-size: inherit; }

.trace-scale {
  position: relative;
  height: 100%;
  min-width: 0;
  min-height: 28px;
}

.trace-tick {
  position: absolute;
  top: 8px;
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
}

.trace-tick.is-start { transform: none; }
.trace-tick.is-end { transform: translateX(-100%); }

.trace-boundary-mark {
  position: absolute;
  top: 27px;
  bottom: 0;
  border-left: 1px dashed var(--color-accent);
  opacity: 0.55;
}

.trace-boundary-label {
  position: absolute;
  z-index: 1;
  top: 26px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: calc(50% - 4px);
  padding: 3px 0;
  background: var(--color-paper-raised);
  color: var(--color-accent);
  font-size: 10px;
  line-height: 1.2;
}

.trace-boundary-label.is-start { left: 0; }
.trace-boundary-label.is-end { right: 0; align-items: flex-end; text-align: right; }
.trace-boundary-label small { color: var(--color-muted); font-size: inherit; }
.trace-boundary-label time { max-width: 100%; font-family: var(--font-mono); overflow-wrap: anywhere; }
.trace-boundary-infinity { font-size: 14px; line-height: 1; }

.trace-body {
  position: relative;
  padding-block: 4px 6px;
}

.trace-guides,
.trace-now-layer {
  position: absolute;
  inset: 0;
  align-items: stretch;
  pointer-events: none;
}

.trace-guides .trace-scale,
.trace-now-layer .trace-scale,
.trace-row .trace-scale {
  align-self: stretch;
  height: auto;
}

.trace-guides { z-index: 1; }
.trace-now-layer { z-index: 3; }

.trace-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--color-rule-strong) 70%, transparent);
  transform: translateX(-50%);
}

.trace-boundary-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--color-accent);
  opacity: 0.4;
}

.trace-now {
  position: absolute;
  top: -1px;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--color-ink) 72%, transparent);
  transform: translateX(-50%);
}

.trace-now-diamond {
  position: absolute;
  top: -1px;
  left: 50%;
  width: 6px;
  height: 6px;
  border-radius: 1px;
  background: var(--color-ink);
  transform: translate(-50%, -50%) rotate(45deg);
}

.trace-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.trace-row {
  position: relative;
  z-index: 2;
  min-height: 48px;
  padding-block: 6px;
  border-radius: 8px;
}

.trace-row:hover,
.trace-row.is-highlighted {
  background: color-mix(in srgb, var(--color-ink) 4%, transparent);
}

.trace-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.trace-row.is-soon {
  background: color-mix(in srgb, var(--color-danger) 6%, transparent);
}

.trace-row.is-soon:hover {
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
}

.trace-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--color-muted);
}

.trace-label-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.trace-label-copy strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-row.is-expired .trace-label-copy strong {
  color: var(--color-muted);
}

.trace-label-copy small {
  overflow: hidden;
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-label-copy .trace-scope { color: var(--color-accent); text-decoration: underline dotted; text-underline-offset: 3px; }
.trace-label-copy .trace-source { display: flex; gap: 4px; }
.trace-source-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.trace-scope { flex-shrink: 0; }
.trace-label svg { flex: 0 0 auto; }

.trace-row.is-forever .trace-label svg { color: var(--color-accent); }
.trace-row.is-later .trace-label svg { color: var(--color-info); }
.trace-row.is-week .trace-label svg { color: var(--color-warning); }
.trace-row.is-soon .trace-label svg { color: var(--color-danger); }
.trace-row.is-expired .trace-label svg { color: var(--color-faint); }

.trace-row .trace-scale {
  min-height: 36px;
}

.trace-hit {
  position: absolute;
  inset: 0;
  cursor: default;
}

.trace-bar {
  position: absolute;
  top: 50%;
  height: 8px;
  min-width: 3px;
  overflow: hidden;
  border-radius: 999px;
  transform: translateY(-50%);
}

.trace-outside {
  position: absolute;
  top: 50%;
  left: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--color-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateY(-50%);
}

.trace-outside.is-after {
  right: 0;
  left: auto;
}

.trace-bar-fill {
  position: absolute;
  inset: 0;
}

.trace-bar-fill {
  background: var(--color-ink);
}

.trace-row.is-forever .trace-bar-fill { background: var(--color-accent); }
.trace-row.is-later .trace-bar-fill { background: var(--color-info); }
.trace-row.is-week .trace-bar-fill { background: var(--color-warning); }
.trace-row.is-soon .trace-bar-fill { background: var(--color-danger); }
.trace-row.is-expired .trace-bar-fill { background: var(--color-faint); }

.trace-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  min-width: 0;
}

.trace-meta-status,
.trace-meta-days {
  max-width: 100%;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-meta-status { color: var(--color-muted); }
.trace-meta-days {
  color: color-mix(in srgb, var(--color-ink) 70%, transparent);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.trace-row.is-soon .trace-meta-status,
.trace-row.is-soon .trace-meta-days { color: var(--color-danger); }
.trace-row.is-week .trace-meta-status { color: var(--color-warning); }
.trace-row.is-expired .trace-meta-status,
.trace-row.is-expired .trace-meta-days { color: var(--color-faint); }

.trace-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  min-width: 8.25rem;
}

.trace-actions button {
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.trace-actions button:hover {
  background: color-mix(in srgb, var(--color-ink) 6%, transparent);
  color: var(--color-ink);
}

.trace-actions button.is-revoke:hover {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.trace-actions button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.trace-actions small {
  overflow: hidden;
  color: var(--color-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@container (max-width: 560px) {
  .trace-cols {
    grid-template-columns: minmax(72px, 1fr) minmax(48px, 1.3fr) 8.25rem;
  }

  .trace-col-meta {
    display: none;
  }
}
</style>
