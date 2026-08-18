<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { translate as tr } from "../i18n";
import type { AgentTurnUsage } from "../../shared/agent";
import {
  agentTurnTokenDetails,
  formatAgentDuration,
  formatAgentExactTokenCount,
  formatAgentTokenCount,
  hasAgentTurnStats,
  hasAgentTurnTokens,
} from "../../shared/agent-turn-stats";

const props = defineProps<{
  durationMs?: number;
  usage?: AgentTurnUsage;
}>();

const open = ref(false);
const tipStyle = ref<Record<string, string>>({});
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const visible = computed(() => hasAgentTurnStats(props.durationMs, props.usage));
const details = computed(() => agentTurnTokenDetails(props.usage));
const tokenLabels = {
  input: "输入",
  output: "输出",
  cacheRead: "缓存读",
  cacheWrite: "缓存写",
} as const;
const ariaLabel = computed(() => {
  const duration = typeof props.durationMs === "number" ? formatAgentDuration(props.durationMs) : "";
  const tokens = hasAgentTurnTokens(props.usage) && props.usage
    ? formatAgentTokenCount(props.usage.totalTokens)
    : "";
  if (duration && tokens) return tr("本轮 {{0}}，共 {{1}} tokens", [duration, tokens]);
  if (duration) return tr("本轮耗时 {{0}}", [duration]);
  return tr("本轮共 {{0}} tokens", [tokens]);
});

function placeTip(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const width = 176;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const top = Math.max(8, rect.top - 8);
  tipStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    transform: "translateY(-100%)",
  };
}

function showTip(event: Event) {
  if (!details.value.length) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  if (hideTimer) clearTimeout(hideTimer);
  placeTip(target);
  open.value = true;
}

function hideTip() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    open.value = false;
  }, 80);
}

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer);
});
</script>

<template>
  <span
    v-if="visible"
    class="agent-turn-stats"
    :aria-label="ariaLabel"
    tabindex="0"
    @mouseenter="showTip"
    @mouseleave="hideTip"
    @focus="showTip"
    @blur="hideTip"
  >
    <span v-if="typeof durationMs === 'number'" class="agent-turn-stats__item">{{ formatAgentDuration(durationMs) }}</span>
    <span v-if="hasAgentTurnTokens(usage) && usage" class="agent-turn-stats__item">{{ formatAgentTokenCount(usage.totalTokens) }}</span>
    <Teleport to="body">
      <div
        v-if="open && details.length"
        class="agent-turn-stats__tip"
        role="tooltip"
        :style="tipStyle"
        @mouseenter="open = true"
        @mouseleave="hideTip"
      >
        <div v-for="row in details" :key="row.key">
          <span>{{ $t(tokenLabels[row.key]) }}</span>
          <strong>{{ formatAgentExactTokenCount(row.value) }}</strong>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.agent-turn-stats {
  width: fit-content;
  max-width: 100%;
  color: var(--agent-turn-stats-color, rgba(161, 161, 170, .82));
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  letter-spacing: .01em;
  cursor: default;
  user-select: none;
}

.agent-turn-stats:focus-visible {
  outline: 1px solid rgba(196, 181, 253, .45);
  outline-offset: 2px;
  border-radius: 4px;
}

.agent-turn-stats__item + .agent-turn-stats__item::before {
  content: "·";
  margin-right: 6px;
  color: var(--agent-turn-stats-dot, rgba(113, 113, 122, .8));
}
</style>

<style>
.agent-turn-stats__tip {
  position: fixed;
  z-index: 1400;
  min-width: 132px;
  padding: 7px 8px;
  border: 1px solid rgba(255, 255, 255, .12);
  border-radius: 8px;
  background: rgba(24, 24, 27, .94);
  box-shadow: 0 10px 24px rgba(0, 0, 0, .28);
  color: #d4d4d8;
  display: grid;
  gap: 4px;
  pointer-events: none;
}

.agent-turn-stats__tip > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 12px;
  font-size: 10px;
  line-height: 1.35;
}

.agent-turn-stats__tip span {
  color: #a1a1aa;
}

.agent-turn-stats__tip strong {
  color: #f4f4f5;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
