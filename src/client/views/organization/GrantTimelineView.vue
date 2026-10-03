<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  AlertTriangle,
  Clock,
  History,
  Infinity as InfinityIcon,
  Pencil,
  Radio,
  Server,
  Trash2,
  XCircle,
} from "@lucide/vue";
import { currentLocale, translate } from "../../i18n";
import {
  GRANT_TIMELINE_LEGEND,
  buildGrantTimeline,
  grantRemainingCopy,
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
let timelineClock: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timelineClock = setInterval(() => {
    timelineNow.value = Date.now();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (timelineClock) clearInterval(timelineClock);
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

  if (activeFilter.value === "all") {
    return items;
  }
  return items.filter((item) => item.bar.tone === activeFilter.value);
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

function formatShortDate(time: number | string | null): string {
  if (!time) return "";
  const ts = typeof time === "string" ? Date.parse(time) : time;
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

<template>
  <div class="chrono-container">
    <!-- Telemetry Filter Toolbar -->
    <div class="chrono-toolbar">
      <div class="chrono-filter-group" role="tablist" :aria-label="$t('时序状态筛选')">
        <button
          type="button"
          class="chrono-filter-chip"
          :class="{ 'is-active': activeFilter === 'all' }"
          @click="activeFilter = 'all'"
        >
          <span class="chrono-filter-dot is-all"></span>
          <span>{{ $t('全部') }}</span>
          <b class="chrono-filter-count">{{ props.rows.length }}</b>
        </button>

        <button
          v-for="item in GRANT_TIMELINE_LEGEND"
          :key="item.tone"
          type="button"
          class="chrono-filter-chip"
          :class="[
            `is-${item.tone}`,
            { 'is-active': activeFilter === item.tone, 'is-dim': (grantTimeline.toneCounts[item.tone] || 0) === 0 }
          ]"
          @click="activeFilter = activeFilter === item.tone ? 'all' : item.tone"
        >
          <span class="chrono-filter-dot" :class="`is-${item.tone}`"></span>
          <span>{{ $t(item.label) }}</span>
          <b class="chrono-filter-count">{{ grantTimeline.toneCounts[item.tone] || 0 }}</b>
        </button>
      </div>

      <div class="chrono-sync-indicator">
        <span class="chrono-pulse-ring">
          <span class="chrono-pulse-dot"></span>
        </span>
        <span class="chrono-sync-text">{{ $t('时序信标活跃') }}</span>
      </div>
    </div>

    <!-- Chrono Stage -->
    <div class="chrono-stage">
      <!-- Full-Width Panoramic Chrono-Ruler -->
      <div class="chrono-ruler-bar">
        <div class="chrono-ruler-track">
          <!-- Calibrated Ticks -->
          <div
            v-for="(tick, idx) in grantTimeline.ticks"
            :key="idx"
            class="chrono-tick"
            :style="{ left: `${tick.left}%` }"
          >
            <i class="chrono-tick-notch"></i>
            <span class="chrono-tick-label">{{ tick.label }}</span>
          </div>

          <!-- Active NOW Beacon -->
          <div
            class="chrono-beacon-marker"
            :style="{ left: `${grantTimeline.nowLeft}%` }"
            :title="$t('当前时间点')"
          >
            <div class="chrono-beacon-tag">
              <span class="chrono-beacon-ping"></span>
              <span>{{ $t('现在') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Chrono Lanes Stream Area -->
      <div class="chrono-stream-surface">
        <!-- Background Laser Guides across entire height -->
        <div class="chrono-grid-overlay" aria-hidden="true">
          <div
            v-for="(tick, idx) in grantTimeline.ticks"
            :key="idx"
            class="chrono-grid-line"
            :style="{ left: `${tick.left}%` }"
          ></div>
          <div
            class="chrono-laser-beam"
            :style="{ left: `${grantTimeline.nowLeft}%` }"
          ></div>
        </div>

        <!-- Fused Chrono-Lanes List -->
        <div class="chrono-lanes-list">
          <article
            v-for="item in grantTimelineRows"
            :key="item.bar.id"
            class="chrono-lane-card"
            :class="`is-${item.bar.tone}`"
          >
            <!-- Integrated Info & Action Ribbon (Fusing Identity, Status, and Actions into one cohesive row) -->
            <header class="chrono-lane-ribbon">
              <!-- Left: Unified Identity & Metadata (Never truncated, full width) -->
              <div class="chrono-lane-identity">
                <span class="chrono-resource-icon">
                  <Server :size="14" />
                </span>
                <strong class="chrono-lane-title" :title="item.row.grant.label || item.row.grant.resourceId">
                  {{ item.row.grant.label || item.row.grant.resourceId }}
                </strong>
                <span class="chrono-source-tag" :class="{ 'is-inherited': item.row.inherited }">
                  {{ grantSource(item.row) }}
                </span>
                <span v-if="item.row.grant.permissionText" class="chrono-perm-tag" :title="item.row.grant.permissionText">
                  {{ item.row.grant.permissionText }}
                </span>
                <span class="chrono-duration-tag">
                  <Radio :size="10" />
                  {{ $t('持续运行') }} {{ item.bar.activeDays }} {{ $t('天') }}
                </span>
              </div>

              <!-- Right: Smart Fused Status & Hover Quick Actions -->
              <div class="chrono-lane-tools">
                <!-- Status Badge -->
                <span class="chrono-status-chip" :class="`is-${item.bar.tone}`">
                  <InfinityIcon v-if="item.bar.openEnded" :size="12" />
                  <AlertTriangle v-else-if="item.bar.tone === 'soon'" :size="12" />
                  <Clock v-else-if="item.bar.tone === 'week' || item.bar.tone === 'later'" :size="12" />
                  <XCircle v-else :size="12" />
                  <span>{{ item.bar.openEnded ? $t('永久有效') : $t(item.remain.key, item.remain.values) }}</span>
                </span>

                <!-- Contextual Action Capsule (Sleek micro-actions) -->
                <div class="chrono-action-pill">
                  <button
                    type="button"
                    class="chrono-btn-action is-history"
                    :title="$t('查看流转记录')"
                    @click.stop="emit('history', item.row.grant)"
                  >
                    <History :size="12" />
                    <span>{{ $t('记录') }}</span>
                  </button>

                  <template v-if="!item.row.inherited || props.selectedNodeType === 'organization'">
                    <button
                      type="button"
                      class="chrono-btn-action is-edit"
                      :title="$t('修改授权')"
                      @click.stop="emit('edit', item.row.grant)"
                    >
                      <Pencil :size="12" />
                      <span>{{ $t('修改') }}</span>
                    </button>
                    <button
                      type="button"
                      class="chrono-btn-action is-revoke"
                      :title="$t('撤销授权')"
                      @click.stop="emit('revoke', item.row.grant)"
                    >
                      <Trash2 :size="12" />
                      <span>{{ $t('撤销') }}</span>
                    </button>
                  </template>
                  <span v-else class="chrono-inherited-pill" :title="$t('在来源节点管理')">
                    {{ $t('继承授权') }}
                  </span>
                </div>
              </div>
            </header>

            <!-- Full-Width Panoramic Timeline Track (Spans 100% of the lane, calibrated with the top ruler) -->
            <div class="chrono-lane-track-wrapper">
              <el-tooltip
                placement="top"
                :show-after="80"
                popper-class="chrono-hud-popper"
                effect="dark"
              >
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
                        <Radio :size="12" />
                        {{ $t('已生效运行') }} <b class="chrono-mono">{{ item.bar.activeDays }}</b> {{ $t('天') }}
                      </span>
                    </footer>
                  </div>
                </template>

                <div class="chrono-lane-track">
                  <div class="chrono-track-slot">
                    <!-- Origin Milestone Node -->
                    <div
                      class="chrono-origin-pin"
                      :style="{ left: `${item.bar.startLeft}%` }"
                      :title="`${$t('起始时间')}: ${formatFullDateTime(item.bar.start)}`"
                    >
                      <span class="chrono-origin-dot"></span>
                      <span class="chrono-origin-label">{{ formatShortDate(item.bar.start) }}</span>
                    </div>

                    <!-- Finite/Expiring Energy Capsule -->
                    <div
                      v-if="!item.bar.openEnded"
                      class="chrono-energy-capsule"
                      :class="`is-${item.bar.tone}`"
                      :style="{ left: `${item.bar.left}%`, width: `${item.bar.width}%` }"
                    >
                      <span class="chrono-capsule-core"></span>
                      <span class="chrono-capsule-cap"></span>
                    </div>

                    <!-- Perpetual Infinite Stream (Spans to the right edge with fluid quantum styling) -->
                    <div
                      v-else
                      class="chrono-perpetual-stream"
                      :style="{ left: `${item.bar.startLeft}%`, width: `${100 - item.bar.startLeft}%` }"
                    >
                      <!-- Active range: start to NOW -->
                      <div
                        class="chrono-stream-active"
                        :style="{
                          width: `${Math.max(0, Math.min(100, ((grantTimeline.nowLeft - item.bar.startLeft) / Math.max(0.1, 100 - item.bar.startLeft)) * 100))}%`
                        }"
                      >
                        <span class="chrono-stream-active-sheen"></span>
                      </div>

                      <!-- Future infinite range: NOW to infinity -->
                      <div class="chrono-stream-infinite">
                        <span class="chrono-stream-stripes"></span>
                        <span class="chrono-stream-badge">
                          <InfinityIcon :size="11" />
                          <em>{{ $t('持续生效') }}</em>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </el-tooltip>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ==========================================================================
   Smart Fused Cyber-HUD Chrono-Timeline
   ========================================================================== */

.chrono-container {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
  width: 100%;
}

/* --- Filter Toolbar --- */
.chrono-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: 6px 12px;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--color-paper) 40%, var(--color-paper-raised));
  border: 1px solid var(--color-rule);
}

.chrono-filter-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.chrono-filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  font-size: var(--text-2xs);
  cursor: pointer;
  transition: all var(--dur-micro) ease-out;
  white-space: nowrap;
}

.chrono-filter-chip:hover {
  background: color-mix(in srgb, var(--color-ink) 4%, transparent);
  color: var(--color-ink);
}

.chrono-filter-chip.is-active {
  border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-rule-strong));
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font-weight: 600;
}

.chrono-filter-chip.is-dim {
  opacity: 0.55;
}

.chrono-filter-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.chrono-filter-dot.is-all { background: var(--color-ink-soft); }
.chrono-filter-dot.is-forever { background: var(--color-accent); box-shadow: 0 0 6px var(--color-accent); }
.chrono-filter-dot.is-later { background: var(--color-info); }
.chrono-filter-dot.is-week { background: var(--color-warning); box-shadow: 0 0 6px var(--color-warning); }
.chrono-filter-dot.is-soon { background: var(--color-danger); box-shadow: 0 0 6px var(--color-danger); }
.chrono-filter-dot.is-expired { background: var(--color-faint); }

.chrono-filter-count {
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.85;
}

.chrono-sync-indicator {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--text-2xs);
  color: var(--color-muted);
  font-family: var(--font-mono);
}

.chrono-pulse-ring {
  position: relative;
  width: 10px;
  height: 10px;
  display: grid;
  place-items: center;
}

.chrono-pulse-ring::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--color-accent);
  opacity: 0.35;
  animation: chrono-radar-ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;
}

.chrono-pulse-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
}

@keyframes chrono-radar-ping {
  0% { transform: scale(0.8); opacity: 0.8; }
  100% { transform: scale(2.2); opacity: 0; }
}

/* --- Chrono Stage Frame --- */
.chrono-stage {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-card);
  background: var(--color-paper-raised);
  overflow: hidden;
  position: relative;
}

/* --- Ruler Bar (Full Width) --- */
.chrono-ruler-bar {
  min-height: 38px;
  padding: 0 var(--space-md);
  border-bottom: 1px solid var(--color-rule);
  background: color-mix(in srgb, var(--color-paper) 65%, var(--color-paper-raised));
  position: relative;
  z-index: 3;
}

.chrono-ruler-track {
  position: relative;
  width: 100%;
  height: 38px;
}

.chrono-tick {
  position: absolute;
  top: 0;
  bottom: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.chrono-tick-notch {
  width: 1px;
  height: 6px;
  background: var(--color-rule-strong);
  margin-top: auto;
}

.chrono-tick-label {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-muted);
  letter-spacing: -0.02em;
  white-space: nowrap;
}

/* NOW Beacon on Ruler */
.chrono-beacon-marker {
  position: absolute;
  top: 7px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  z-index: 4;
}

.chrono-beacon-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-accent-strong);
  color: var(--color-accent-ink, #ffffff);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 0 10px color-mix(in srgb, var(--color-accent) 45%, transparent);
}

.chrono-beacon-ping {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #ffffff;
  animation: chrono-radar-ping 1.6s ease-out infinite;
}

/* --- Chrono Stream Surface & Grid Overlay --- */
.chrono-stream-surface {
  position: relative;
  padding: var(--space-xs) var(--space-md) var(--space-md);
}

.chrono-grid-overlay {
  position: absolute;
  inset: 0 var(--space-md);
  pointer-events: none;
  z-index: 1;
}

.chrono-grid-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--color-rule) 75%, transparent);
  transform: translateX(-50%);
}

.chrono-laser-beam {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: linear-gradient(
    to bottom,
    var(--color-accent) 0%,
    color-mix(in srgb, var(--color-accent) 40%, transparent) 100%
  );
  box-shadow: 0 0 7px var(--color-accent);
  transform: translateX(-50%);
  z-index: 2;
}

/* --- Fused Chrono-Lane Card --- */
.chrono-lanes-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  z-index: 3;
}

.chrono-lane-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--color-paper) 35%, var(--color-paper-raised));
  border: 1px solid var(--color-rule);
  transition: all var(--dur-micro) ease-out;
  position: relative;
}

.chrono-lane-card:hover {
  background: color-mix(in srgb, var(--color-accent-soft) 22%, var(--color-paper-raised));
  border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-rule));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

/* --- Upper Ribbon: Identity + Status + Actions --- */
.chrono-lane-ribbon {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  min-height: 24px;
}

.chrono-lane-identity {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px var(--space-xs);
  min-width: 0;
}

.chrono-resource-icon {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  border-radius: 5px;
  background: color-mix(in srgb, var(--color-paper) 60%, var(--color-paper-raised));
  border: 1px solid var(--color-rule-strong);
  color: var(--color-accent);
  display: grid;
  place-items: center;
}

.chrono-lane-title {
  color: var(--color-ink);
  font-size: var(--text-xs);
  font-weight: 600;
  white-space: nowrap;
}

.chrono-source-tag {
  font-style: normal;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font-size: var(--text-2xs);
  font-weight: 500;
  white-space: nowrap;
}

.chrono-source-tag.is-inherited {
  background: var(--color-paper);
  color: var(--color-muted);
  border: 1px solid var(--color-rule);
}

.chrono-perm-tag {
  color: var(--color-muted);
  font-size: var(--text-2xs);
  white-space: nowrap;
}

.chrono-perm-tag::before {
  content: "·";
  margin-right: 6px;
  color: var(--color-faint);
}

.chrono-duration-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-muted);
  white-space: nowrap;
}

.chrono-duration-tag svg {
  color: var(--color-accent);
}

/* Right tools: Status & Actions */
.chrono-lane-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

/* Status Chip */
.chrono-status-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-family: var(--font-mono);
  font-weight: 500;
  border: 1px solid transparent;
  white-space: nowrap;
}

.chrono-status-chip.is-forever {
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
}

.chrono-status-chip.is-active,
.chrono-status-chip.is-later {
  background: var(--color-info-soft);
  color: var(--color-info);
  border-color: color-mix(in srgb, var(--color-info) 30%, transparent);
}

.chrono-status-chip.is-week {
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border-color: color-mix(in srgb, var(--color-warning) 30%, transparent);
}

.chrono-status-chip.is-soon {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
}

.chrono-status-chip.is-expired {
  background: var(--color-paper);
  color: var(--color-faint);
  border-color: var(--color-rule);
}

/* Smart Action Pill */
.chrono-action-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 3px;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--color-paper) 60%, var(--color-paper-raised));
  border: 1px solid var(--color-rule-strong);
  transition: all var(--dur-micro) ease;
}

.chrono-btn-action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  font-size: 11px;
  color: var(--color-ink-soft);
  cursor: pointer;
  transition: all var(--dur-micro) ease;
  white-space: nowrap;
}

.chrono-btn-action:hover {
  background: var(--color-paper-raised);
  color: var(--color-ink);
}

.chrono-btn-action.is-history:hover {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
}

.chrono-btn-action.is-edit:hover {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
}

.chrono-btn-action.is-revoke:hover {
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-color: color-mix(in srgb, var(--color-danger) 35%, transparent);
}

.chrono-inherited-pill {
  font-size: 10px;
  color: var(--color-muted);
  padding: 0 4px;
}

/* --- Lower Tier: Full-Width Timeline Track --- */
.chrono-lane-track-wrapper {
  width: 100%;
  cursor: pointer;
}

.chrono-lane-track {
  width: 100%;
  height: 18px;
  display: flex;
  align-items: center;
}

.chrono-track-slot {
  position: relative;
  width: 100%;
  height: 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-paper) 45%, var(--color-paper-raised));
  border: 1px solid color-mix(in srgb, var(--color-rule) 85%, transparent);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04);
  display: flex;
  align-items: center;
}

/* Origin Anchor Pin */
.chrono-origin-pin {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 4px;
  z-index: 5;
  pointer-events: none;
}

.chrono-origin-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--color-paper-raised);
  border: 2px solid var(--color-accent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--color-accent) 60%, transparent);
}

.chrono-origin-label {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-muted);
  opacity: 0.8;
  white-space: nowrap;
}

/* Finite Energy Capsule */
.chrono-energy-capsule {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 8px;
  border-radius: 4px;
  z-index: 3;
  display: flex;
  align-items: center;
}

.chrono-capsule-core {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--capsule-gradient, var(--color-info));
  box-shadow: 0 0 6px var(--capsule-glow, rgba(0, 0, 0, 0.1));
}

.chrono-capsule-cap {
  position: absolute;
  right: 0;
  width: 4px;
  height: 8px;
  border-radius: 0 4px 4px 0;
  background: #ffffff;
  opacity: 0.6;
}

.chrono-energy-capsule.is-later {
  --capsule-gradient: linear-gradient(90deg, var(--color-info) 0%, color-mix(in srgb, var(--color-info) 70%, var(--color-accent)) 100%);
  --capsule-glow: color-mix(in srgb, var(--color-info) 40%, transparent);
}

.chrono-energy-capsule.is-week {
  --capsule-gradient: linear-gradient(90deg, var(--color-warning) 0%, color-mix(in srgb, var(--color-warning) 80%, #ff8800) 100%);
  --capsule-glow: color-mix(in srgb, var(--color-warning) 50%, transparent);
}

.chrono-energy-capsule.is-soon {
  --capsule-gradient: linear-gradient(90deg, var(--color-danger) 0%, #ff4d4f 100%);
  --capsule-glow: color-mix(in srgb, var(--color-danger) 70%, transparent);
  animation: chrono-capsule-pulse 1.4s ease-in-out infinite alternate;
}

.chrono-energy-capsule.is-expired {
  --capsule-gradient: repeating-linear-gradient(45deg, var(--color-faint), var(--color-faint) 4px, transparent 4px, transparent 8px);
  --capsule-glow: transparent;
  opacity: 0.6;
}

@keyframes chrono-capsule-pulse {
  from { filter: drop-shadow(0 0 2px var(--color-danger)); }
  to { filter: drop-shadow(0 0 8px var(--color-danger)); }
}

/* Perpetual Infinite Stream */
.chrono-perpetual-stream {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 10px;
  z-index: 3;
  display: flex;
  align-items: center;
}

.chrono-stream-active {
  height: 100%;
  border-radius: 5px 0 0 5px;
  background: linear-gradient(
    90deg,
    var(--color-accent) 0%,
    color-mix(in srgb, var(--color-accent) 85%, #ffffff) 100%
  );
  box-shadow: 0 0 8px color-mix(in srgb, var(--color-accent) 45%, transparent);
  position: relative;
  flex: 0 0 auto;
}

.chrono-stream-active-sheen {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.4) 0%, transparent 60%);
}

.chrono-stream-infinite {
  position: relative;
  height: 100%;
  flex: 1;
  display: flex;
  align-items: center;
  border-radius: 0 5px 5px 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-accent) 40%, transparent) 0%,
    color-mix(in srgb, var(--color-accent) 15%, transparent) 80%,
    transparent 100%
  );
  border-top: 1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent);
  border-bottom: 1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent);
  overflow: hidden;
}

.chrono-stream-stripes {
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    -45deg,
    color-mix(in srgb, var(--color-accent) 25%, transparent) 0,
    color-mix(in srgb, var(--color-accent) 25%, transparent) 3px,
    transparent 3px,
    transparent 7px
  );
  opacity: 0.8;
}

.chrono-stream-badge {
  position: relative;
  z-index: 2;
  margin-left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent-soft) 85%, var(--color-paper-raised));
  border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent);
  color: var(--color-accent-strong);
  font-size: 9px;
  font-family: var(--font-mono);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.chrono-stream-badge em {
  font-style: normal;
  font-size: 9px;
  letter-spacing: 0.02em;
}

/* --- Responsive Media Queries --- */
@media (max-width: 680px) {
  .chrono-lane-ribbon {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .chrono-lane-tools {
    width: 100%;
    justify-content: space-between;
  }
}
</style>

<style>
/* Global Popover Styles for HUD card (rendered in body by Element Plus) */
.el-popper.chrono-hud-popper {
  background: var(--color-sidebar-raised, #162427) !important;
  border: 1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-sidebar-rule, #26383b)) !important;
  border-radius: var(--radius-card, 8px) !important;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35) !important;
  padding: 12px 14px !important;
}

.el-popper.chrono-hud-popper .el-popper__arrow::before {
  background: var(--color-sidebar-raised, #162427) !important;
  border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-sidebar-rule, #26383b)) !important;
}

.chrono-hud-card {
  width: 290px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--color-sidebar-ink, #d9e1df);
}

.chrono-hud-card__head {
  display: flex;
  align-items: center;
  gap: 7px;
  border-bottom: 1px solid color-mix(in srgb, #ffffff 10%, transparent);
  padding-bottom: 7px;
}

.chrono-hud-accent {
  color: var(--color-accent-on-dark, #4ade80);
}

.chrono-hud-card__head strong {
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.chrono-hud-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
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
}

.chrono-hud-metric small {
  font-size: 10px;
  color: var(--color-sidebar-muted, #94a3b8);
}

.chrono-hud-metric span {
  font-size: 11px;
  color: #f1f5f9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrono-hud-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid color-mix(in srgb, #ffffff 8%, transparent);
  padding-top: 6px;
  font-size: 10px;
  color: var(--color-sidebar-muted, #94a3b8);
}

.chrono-hud-stat {
  display: flex;
  align-items: center;
  gap: 5px;
}

.chrono-hud-stat b {
  color: var(--color-accent-on-dark, #4ade80);
}

.chrono-mono {
  font-family: var(--font-mono);
}
</style>
