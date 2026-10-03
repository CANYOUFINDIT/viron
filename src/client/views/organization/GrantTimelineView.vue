<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Server } from "@lucide/vue";
import { currentLocale, translate } from "../../i18n";
import {
  GRANT_TIMELINE_LEGEND,
  buildGrantTimeline,
  grantRemainingCopy,
  type GrantTimelineBar,
  type GrantTimelineTone,
} from "./grant-timeline";

export interface GrantRowItem {
  grant: {
    id: string;
    label?: string;
    resourceId: string;
    permissionText?: string;
    createdAt: string;
    expiresAt: string | null;
    expired: boolean;
  };
  source: string;
  inherited: boolean;
}

const props = defineProps<{
  rows: GrantRowItem[];
  selectedNodeType: "organization" | "project" | "member";
}>();

const emit = defineEmits<{
  (e: "edit", grant: any): void;
  (e: "revoke", grant: any): void;
  (e: "history", grant: any): void;
}>();

const timelineNow = ref(Date.now());
const activeFilter = ref<GrantTimelineTone | "all">("all");
const rulerScale = ref<HTMLElement | null>(null);
const scaleWidth = ref(720);
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
      expiresAt: row.grant.expiresAt,
      expired: row.grant.expired,
    })),
    timelineNow.value,
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

const rulerTicks = computed(() => {
  const nowLeft = grantTimeline.value.nowLeft;
  const width = Math.max(scaleWidth.value, 1);
  const nowX = (nowLeft / 100) * width;
  const ticks = grantTimeline.value.ticks.map((tick) => ({
    ...tick,
    x: (tick.left / 100) * width,
    nearNow: Math.abs((tick.left / 100) * width - nowX) < 28,
    showGuide: tick.left > 0.8 && tick.left < 99.2 && Math.abs(tick.left - nowLeft) > 1.4,
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

function barScale(bar: GrantTimelineBar): number {
  const span = Math.max(bar.width, 0.001);
  return Math.max(0, Math.min(1, (grantTimeline.value.nowLeft - bar.left) / span));
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
      </div>

      <div class="trace-ruler trace-cols">
        <div></div>
        <div ref="rulerScale" class="trace-scale">
          <span
            v-for="tick in rulerTicks"
            v-show="tick.showLabel"
            :key="tick.time"
            class="trace-tick"
            :class="tick.edge ? `is-${tick.edge}` : ''"
            :style="{ left: `${tick.left}%` }"
          >{{ tick.label }}</span>
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
          </div>
          <div class="trace-col-meta"></div>
          <div></div>
        </div>

        <article
          v-for="item in grantTimelineRows"
          :key="item.bar.id"
          class="trace-row trace-cols"
          :class="`is-${item.bar.tone}`"
        >
          <div class="trace-label">
            <Server :size="14" />
            <span class="trace-label-copy">
              <strong :title="item.row.grant.label || item.row.grant.resourceId">
                {{ item.row.grant.label || item.row.grant.resourceId }}
              </strong>
              <small :title="`${grantSource(item.row)}${item.row.grant.permissionText ? ` · ${item.row.grant.permissionText}` : ''}`">
                {{ grantSource(item.row) }}<template v-if="item.row.grant.permissionText"> · {{ item.row.grant.permissionText }}</template>
              </small>
            </span>
          </div>

          <div class="trace-scale">
            <el-tooltip placement="top" :show-after="80" popper-class="chrono-hud-popper" effect="dark">
              <template #content>
                <div class="chrono-hud-card">
                  <header class="chrono-hud-card__head">
                    <Server :size="14" class="chrono-hud-accent" />
                    <strong>{{ item.row.grant.label || item.row.grant.resourceId }}</strong>
                    <span class="chrono-hud-tag" :class="`is-${item.bar.tone}`">
                      {{ item.bar.openEnded ? $t('永久有效') : $t(item.remain.key, item.remain.values) }}
                    </span>
                  </header>
                  <div class="chrono-hud-card__grid">
                    <div class="chrono-hud-metric">
                      <small>{{ $t('权限范围') }}</small>
                      <span>{{ item.row.grant.permissionText || '—' }}</span>
                    </div>
                    <div class="chrono-hud-metric">
                      <small>{{ $t('授权来源') }}</small>
                      <span>{{ grantSource(item.row) }}</span>
                    </div>
                    <div class="chrono-hud-metric">
                      <small>{{ $t('起始时间') }}</small>
                      <span class="chrono-mono">{{ formatFullDateTime(item.bar.start) }}</span>
                    </div>
                    <div class="chrono-hud-metric">
                      <small>{{ $t('截止时间') }}</small>
                      <span class="chrono-mono">{{ item.bar.openEnded ? $t('永久有效') : formatFullDateTime(item.bar.end) }}</span>
                    </div>
                  </div>
                  <footer class="chrono-hud-card__foot">
                    <span class="chrono-hud-stat">
                      {{ $t('已生效运行') }} <b class="chrono-mono">{{ item.bar.activeDays }}</b> {{ $t('天') }}
                    </span>
                  </footer>
                </div>
              </template>
              <div class="trace-hit">
                <div
                  class="trace-bar"
                  :style="{ left: `${item.bar.left}%`, width: `${item.bar.width}%` }"
                >
                  <span class="trace-bar-track"></span>
                  <span class="trace-bar-fill" :style="{ transform: `scaleX(${barScale(item.bar)})` }"></span>
                </div>
              </div>
            </el-tooltip>
          </div>

          <div class="trace-meta trace-col-meta">
            <span class="trace-meta-status">
              {{ item.bar.openEnded ? $t('永久有效') : $t(item.remain.key, item.remain.values) }}
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

        <div class="trace-now-layer trace-cols" aria-hidden="true">
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
  align-items: center;
  min-height: 42px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-rule);
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
  height: 28px;
  border-bottom: 1px solid var(--color-rule);
}

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
  min-height: 44px;
  border-radius: 8px;
}

.trace-row:hover {
  background: color-mix(in srgb, var(--color-ink) 4%, transparent);
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
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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

.trace-bar-track,
.trace-bar-fill {
  position: absolute;
  inset: 0;
}

.trace-bar-track {
  background: color-mix(in srgb, var(--color-ink) 10%, transparent);
}

.trace-bar-fill {
  transform-origin: left center;
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

.trace-row :deep(.el-tooltip__trigger) {
  display: block;
  height: 100%;
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

<style>
.el-popper.chrono-hud-popper {
  padding: 12px 14px !important;
  border: 1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-sidebar-rule, #26383b)) !important;
  border-radius: var(--radius-card, 8px) !important;
  background: var(--color-sidebar-raised, #162427) !important;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35) !important;
}

.el-popper.chrono-hud-popper .el-popper__arrow::before {
  border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-sidebar-rule, #26383b)) !important;
  background: var(--color-sidebar-raised, #162427) !important;
}

.chrono-hud-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 290px;
  color: var(--color-sidebar-ink, #d9e1df);
}

.chrono-hud-card__head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 7px;
  border-bottom: 1px solid color-mix(in srgb, #ffffff 10%, transparent);
}

.chrono-hud-accent { color: var(--color-accent-on-dark, #4ade80); }

.chrono-hud-card__head strong {
  flex: 1;
  overflow: hidden;
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrono-hud-tag {
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
}

.chrono-hud-tag.is-forever { background: rgba(33, 151, 128, 0.25); color: #5eead4; }
.chrono-hud-tag.is-later { background: rgba(56, 189, 248, 0.25); color: #7dd3fc; }
.chrono-hud-tag.is-week { background: rgba(251, 146, 60, 0.25); color: #fdba74; }
.chrono-hud-tag.is-soon { background: rgba(244, 63, 94, 0.25); color: #fda4af; }
.chrono-hud-tag.is-expired { background: rgba(148, 163, 184, 0.25); color: #cbd5e1; }

.chrono-hud-card__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.chrono-hud-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.chrono-hud-metric small { color: var(--color-sidebar-muted, #94a3b8); font-size: 10px; }

.chrono-hud-metric span {
  overflow: hidden;
  color: #f1f5f9;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrono-hud-card__foot {
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, #ffffff 8%, transparent);
  color: var(--color-sidebar-muted, #94a3b8);
  font-size: 10px;
}

.chrono-hud-stat b { color: var(--color-accent-on-dark, #4ade80); }
.chrono-mono { font-family: var(--font-mono); }
</style>
