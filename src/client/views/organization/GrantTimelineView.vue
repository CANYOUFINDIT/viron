<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  AlertTriangle,
  Clock,
  Infinity as InfinityIcon,
  Layers,
  Radio,
  Server,
  ShieldCheck,
  XCircle,
} from "@lucide/vue";
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
</script>

<template>
  <div class="chrono-timeline">
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

    <!-- Timeline Frame -->
    <div class="chrono-frame">
      <!-- Chrono Header & Ruler -->
      <div class="chrono-header-row">
        <div class="chrono-col-identity">
          <Layers :size="13" />
          <span>{{ $t('资源与授权范围') }}</span>
        </div>

        <div class="chrono-col-axis">
          <div class="chrono-ruler">
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

        <div class="chrono-col-remain">
          <Clock :size="13" />
          <span>{{ $t('到期') }}</span>
        </div>

        <div class="chrono-col-actions">
          <span>{{ $t('操作') }}</span>
        </div>
      </div>

      <!-- Tracks Container with Vertical Laser Guides -->
      <div class="chrono-body">
        <!-- Background Time Guides -->
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

        <!-- Tracks List -->
        <div
          v-for="item in grantTimelineRows"
          :key="item.bar.id"
          class="chrono-row"
          :class="`is-${item.bar.tone}`"
        >
          <!-- Identity Column -->
          <div class="chrono-col-identity">
            <span class="chrono-resource-icon">
              <Server :size="15" />
            </span>
            <div class="chrono-resource-meta">
              <strong :title="item.row.grant.label || item.row.grant.resourceId">
                {{ item.row.grant.label || item.row.grant.resourceId }}
              </strong>
              <small>
                <em :class="{ 'is-inherited': item.row.inherited }">
                  {{ grantSource(item.row) }}
                </em>
                <span v-if="item.row.grant.permissionText" :title="item.row.grant.permissionText">
                  {{ item.row.grant.permissionText }}
                </span>
              </small>
            </div>
          </div>

          <!-- Track Lane with Energy Capsule & Quantum Conduit -->
          <div class="chrono-col-axis">
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

              <div class="chrono-lane">
                <div class="chrono-lane__slot">
                  <!-- Origin Anchor Node -->
                  <div
                    class="chrono-node is-origin"
                    :style="{ left: `${item.bar.startLeft}%` }"
                    :title="`${$t('起始时间')}: ${formatFullDateTime(item.bar.start)}`"
                  >
                    <span class="chrono-node__core"></span>
                  </div>

                  <!-- Regular/Finite Bar -->
                  <div
                    v-if="!item.bar.openEnded"
                    class="chrono-capsule"
                    :class="`is-${item.bar.tone}`"
                    :style="{ left: `${item.bar.left}%`, width: `${item.bar.width}%` }"
                  >
                    <span class="chrono-capsule__body"></span>
                    <span class="chrono-capsule__terminal"></span>
                  </div>

                  <!-- Perpetual (Forever) Infinite Stream Conduit -->
                  <div
                    v-else
                    class="chrono-perpetual-conduit"
                    :style="{ left: `${item.bar.startLeft}%`, width: `${100 - item.bar.startLeft}%` }"
                  >
                    <!-- Active Past Segment: start to now -->
                    <div
                      class="chrono-stream__active"
                      :style="{
                        width: `${Math.max(0, Math.min(100, ((grantTimeline.nowLeft - item.bar.startLeft) / Math.max(0.1, 100 - item.bar.startLeft)) * 100))}%`
                      }"
                    >
                      <span class="chrono-stream__glow"></span>
                    </div>

                    <!-- Future Infinite Segment: now onwards -->
                    <div class="chrono-stream__future">
                      <span class="chrono-stream__chevrons"></span>
                      <span class="chrono-stream__infinity-pill">
                        <InfinityIcon :size="12" />
                        <em>{{ $t('永久通道') }}</em>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </el-tooltip>
          </div>

          <!-- Status Column -->
          <div class="chrono-col-remain">
            <span class="chrono-badge" :class="`is-${item.bar.tone}`">
              <InfinityIcon v-if="item.bar.openEnded" :size="12" />
              <AlertTriangle v-else-if="item.bar.tone === 'soon'" :size="12" />
              <Clock v-else-if="item.bar.tone === 'week' || item.bar.tone === 'later'" :size="12" />
              <XCircle v-else :size="12" />
              <span class="chrono-badge-text">{{ $t(item.remain.key, item.remain.values) }}</span>
            </span>
          </div>

          <!-- Actions Column -->
          <div class="chrono-col-actions">
            <template v-if="!item.row.inherited || props.selectedNodeType === 'organization'">
              <button
                type="button"
                class="chrono-action-btn is-edit"
                @click="emit('edit', item.row.grant)"
              >
                {{ $t('修改') }}
              </button>
              <button
                type="button"
                class="chrono-action-btn is-revoke"
                @click="emit('revoke', item.row.grant)"
              >
                {{ $t('撤销') }}
              </button>
            </template>
            <small v-else class="chrono-action-inherited">{{ $t('在来源节点管理') }}</small>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ==========================================================================
   Cyber-HUD Chrono-Timeline Styles
   ========================================================================== */

.chrono-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
  width: 100%;
}

/* --- Toolbar & Filters --- */
.chrono-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: 6px 10px;
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

/* --- Timeline Frame & Grid Layout --- */
.chrono-frame {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-card);
  background: var(--color-paper-raised);
  overflow: hidden;
  position: relative;
}

.chrono-header-row,
.chrono-row {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 2.75fr) minmax(4.5rem, 115px) 8.25rem;
  align-items: center;
  column-gap: var(--space-sm);
  padding: 0 var(--space-md);
  min-width: 0;
}

.chrono-header-row {
  min-height: 40px;
  border-bottom: 1px solid var(--color-rule);
  background: color-mix(in srgb, var(--color-paper) 65%, var(--color-paper-raised));
  color: var(--color-muted);
  font-size: var(--text-2xs);
}

.chrono-header-row .chrono-col-identity,
.chrono-header-row .chrono-col-remain,
.chrono-header-row .chrono-col-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}

/* --- Ruler & Axis Header --- */
.chrono-col-axis {
  position: relative;
  min-width: 0;
}

.chrono-col-remain {
  min-width: 0;
  overflow: hidden;
}

.chrono-ruler {
  position: relative;
  height: 32px;
  width: 100%;
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

/* --- NOW Beacon --- */
.chrono-beacon-marker {
  position: absolute;
  top: 4px;
  bottom: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  z-index: 3;
}

.chrono-beacon-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
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

/* --- Body & Grid Overlay --- */
.chrono-body {
  position: relative;
}

.chrono-grid-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 2.75fr) minmax(4.5rem, 115px) 8.25rem;
  column-gap: var(--space-sm);
  padding: 0 var(--space-md);
}

.chrono-grid-overlay > .chrono-grid-line,
.chrono-grid-overlay > .chrono-laser-beam {
  grid-column: 2;
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
  z-index: 1;
}

/* --- Row Structure --- */
.chrono-row {
  position: relative;
  z-index: 2;
  min-height: 56px;
  border-bottom: 1px solid var(--color-rule);
  transition: background var(--dur-micro) ease;
}

.chrono-row:last-child {
  border-bottom: 0;
}

.chrono-row:hover {
  background: color-mix(in srgb, var(--color-accent-soft) 30%, transparent);
}

/* Identity column */
.chrono-col-identity {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  min-width: 0;
}

.chrono-resource-icon {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--color-paper) 70%, var(--color-paper-raised));
  border: 1px solid var(--color-rule-strong);
  color: var(--color-accent);
  display: grid;
  place-items: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.chrono-resource-meta {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.chrono-resource-meta strong {
  color: var(--color-ink);
  font-size: var(--text-xs);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrono-resource-meta small {
  display: flex;
  align-items: center;
  color: var(--color-muted);
  font-size: var(--text-2xs);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrono-resource-meta em {
  flex: 0 0 auto;
  font-style: normal;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font-weight: 500;
}

.chrono-resource-meta em.is-inherited {
  background: var(--color-paper);
  color: var(--color-muted);
  border: 1px solid var(--color-rule);
}

.chrono-resource-meta span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrono-resource-meta span::before {
  content: "·";
  margin: 0 5px;
  color: var(--color-faint);
}

/* --- Telemetry Track Lane --- */
.chrono-lane {
  position: relative;
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.chrono-lane__slot {
  position: relative;
  width: 100%;
  height: 18px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-paper) 50%, var(--color-paper-raised));
  border: 1px solid color-mix(in srgb, var(--color-rule) 80%, transparent);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05);
  display: flex;
  align-items: center;
}

/* Origin Node */
.chrono-node.is-origin {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-paper-raised);
  border: 2px solid var(--color-accent);
  display: grid;
  place-items: center;
  z-index: 4;
  box-shadow: 0 0 6px color-mix(in srgb, var(--color-accent) 60%, transparent);
}

.chrono-node__core {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent);
}

/* Finite Capsule */
.chrono-capsule {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 10px;
  border-radius: 5px;
  z-index: 2;
  display: flex;
  align-items: center;
}

.chrono-capsule__body {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--capsule-gradient, var(--color-info));
  box-shadow: 0 0 8px var(--capsule-glow, rgba(0, 0, 0, 0.1));
}

.chrono-capsule__terminal {
  position: absolute;
  right: 0;
  width: 6px;
  height: 10px;
  border-radius: 0 5px 5px 0;
  background: #ffffff;
  opacity: 0.6;
}

.chrono-capsule.is-later {
  --capsule-gradient: linear-gradient(90deg, var(--color-info) 0%, color-mix(in srgb, var(--color-info) 70%, var(--color-accent)) 100%);
  --capsule-glow: color-mix(in srgb, var(--color-info) 40%, transparent);
}

.chrono-capsule.is-week {
  --capsule-gradient: linear-gradient(90deg, var(--color-warning) 0%, color-mix(in srgb, var(--color-warning) 80%, #ff8800) 100%);
  --capsule-glow: color-mix(in srgb, var(--color-warning) 50%, transparent);
}

.chrono-capsule.is-soon {
  --capsule-gradient: linear-gradient(90deg, var(--color-danger) 0%, #ff4d4f 100%);
  --capsule-glow: color-mix(in srgb, var(--color-danger) 70%, transparent);
  animation: chrono-capsule-pulse 1.4s ease-in-out infinite alternate;
}

.chrono-capsule.is-expired {
  --capsule-gradient: repeating-linear-gradient(45deg, var(--color-faint), var(--color-faint) 4px, transparent 4px, transparent 8px);
  --capsule-glow: transparent;
  opacity: 0.6;
}

@keyframes chrono-capsule-pulse {
  from { filter: drop-shadow(0 0 2px var(--color-danger)); }
  to { filter: drop-shadow(0 0 8px var(--color-danger)); }
}

/* --- Perpetual Quantum Conduit --- */
.chrono-perpetual-conduit {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
}

.chrono-stream__active {
  height: 100%;
  border-radius: 6px 0 0 6px;
  background: linear-gradient(
    90deg,
    var(--color-accent) 0%,
    color-mix(in srgb, var(--color-accent) 85%, #ffffff) 100%
  );
  box-shadow: 0 0 10px color-mix(in srgb, var(--color-accent) 50%, transparent);
  position: relative;
  flex: 0 0 auto;
}

.chrono-stream__glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.4) 0%, transparent 60%);
}

.chrono-stream__future {
  position: relative;
  height: 100%;
  flex: 1;
  display: flex;
  align-items: center;
  border-radius: 0 6px 6px 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-accent) 45%, transparent) 0%,
    color-mix(in srgb, var(--color-accent) 15%, transparent) 80%,
    transparent 100%
  );
  border-top: 1px dashed color-mix(in srgb, var(--color-accent) 50%, transparent);
  border-bottom: 1px dashed color-mix(in srgb, var(--color-accent) 50%, transparent);
  overflow: hidden;
}

.chrono-stream__chevrons {
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

.chrono-stream__infinity-pill {
  position: relative;
  z-index: 2;
  margin-left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent-soft) 85%, var(--color-paper-raised));
  border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent);
  color: var(--color-accent-strong);
  font-size: 10px;
  font-family: var(--font-mono);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
}

.chrono-stream__infinity-pill em {
  font-style: normal;
  font-size: 9px;
  letter-spacing: 0.02em;
}

/* --- Status Badges --- */
.chrono-badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-family: var(--font-mono);
  font-weight: 500;
  border: 1px solid transparent;
  white-space: nowrap;
}

.chrono-badge-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chrono-badge.is-forever {
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--color-accent) 15%, transparent);
}

.chrono-badge.is-later {
  background: var(--color-info-soft);
  color: var(--color-info);
  border-color: color-mix(in srgb, var(--color-info) 30%, transparent);
}

.chrono-badge.is-week {
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border-color: color-mix(in srgb, var(--color-warning) 30%, transparent);
}

.chrono-badge.is-soon {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
}

.chrono-badge.is-expired {
  background: var(--color-paper);
  color: var(--color-faint);
  border-color: var(--color-rule);
}

/* --- Action Buttons --- */
.chrono-col-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.chrono-action-btn {
  height: 26px;
  flex: 0 0 auto;
  padding: 0 8px;
  border-radius: var(--radius-control);
  font-size: var(--text-2xs);
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--dur-micro) ease;
  background: transparent;
  border: 1px solid var(--color-rule-strong);
}

.chrono-action-btn.is-edit {
  color: var(--color-accent-strong);
}

.chrono-action-btn.is-edit:hover {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}

.chrono-action-btn.is-revoke {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-rule));
}

.chrono-action-btn.is-revoke:hover {
  background: var(--color-danger-soft);
  border-color: var(--color-danger);
}

.chrono-action-inherited {
  min-width: 0;
  overflow: hidden;
  color: var(--color-muted);
  font-size: var(--text-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- Responsive Media Queries --- */
@media (max-width: 900px) {
  .chrono-header-row,
  .chrono-row,
  .chrono-grid-overlay {
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(4rem, 90px) 8.25rem;
    padding: 0 var(--space-xs);
  }
}

@media (max-width: 680px) {
  .chrono-header-row {
    display: none;
  }
  .chrono-grid-overlay {
    display: none;
  }
  .chrono-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: var(--space-sm);
  }
  .chrono-col-actions {
    justify-content: flex-start;
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
