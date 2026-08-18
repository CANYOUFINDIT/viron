<script setup lang="ts">
import { Bot, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from "@lucide/vue";
import { computed } from "vue";
import type { AgentFloatingEdge } from "../agent-floating-position";

const props = defineProps<{
  open: boolean;
  running: boolean;
  dragging: boolean;
  edgeCollapsed: boolean;
  snappedEdge: AgentFloatingEdge | null;
  label: string;
}>();

defineEmits<{
  toggle: [];
  expand: [];
  buttonPointerdown: [event: PointerEvent];
  buttonPointermove: [event: PointerEvent];
  buttonPointerup: [event: PointerEvent];
  buttonPointercancel: [event: PointerEvent];
}>();

const edgeToggleIcon = computed(() => {
  if (props.snappedEdge === "left") return ChevronRight;
  if (props.snappedEdge === "top") return ChevronDown;
  if (props.snappedEdge === "bottom") return ChevronUp;
  return ChevronLeft;
});
</script>

<template>
  <div
    class="agent-floating-launcher"
    :class="[
      { 'is-edge-collapsed': edgeCollapsed && !open, 'is-dragging': dragging },
      snappedEdge ? `is-edge-${snappedEdge}` : '',
    ]"
  >
    <button
      class="agent-floating__button"
      :class="{ 'is-open': open }"
      type="button"
      :aria-label="label"
      :aria-grabbed="dragging"
      :title="$t('{0} · 拖动可调整位置', [label])"
      @click="$emit('toggle')"
      @pointerdown="$emit('buttonPointerdown', $event)"
      @pointermove="$emit('buttonPointermove', $event)"
      @pointerup="$emit('buttonPointerup', $event)"
      @pointercancel="$emit('buttonPointercancel', $event)"
    >
      <span class="agent-floating__button-aura" aria-hidden="true"></span>
      <span class="agent-floating__button-core">
        <X v-if="open" :size="28" />
        <Bot v-else :size="28" />
      </span>
      <span v-if="running" class="agent-floating__running"></span>
    </button>

    <button
      v-if="edgeCollapsed && !open"
      class="agent-floating__edge-toggle"
      type="button"
      :aria-label="$t('展开 Viron Agent 悬浮按钮')"
      :title="$t('展开 Viron Agent 悬浮按钮')"
      @click="$emit('expand')"
    >
      <component :is="edgeToggleIcon" :size="14" />
    </button>
  </div>
</template>

<style scoped>
.agent-floating-launcher {
  --agent-green: #22c55e;
  position: relative;
  width: 64px;
  height: 64px;
  pointer-events: none;
  font-family: var(--font-ui, "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif);
  transition: transform .2s ease;
}

.agent-floating-launcher.is-dragging {
  transition: none;
}

.agent-floating__button,
.agent-floating__edge-toggle {
  pointer-events: auto;
}

.agent-floating__button {
  position: relative;
  z-index: 3;
  width: 64px;
  height: 64px;
  padding: 0;
  border: 2px solid rgba(255, 255, 255, .20);
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(99, 102, 241, .80), rgba(168, 85, 247, .80));
  color: #fff;
  box-shadow:
    0 0 20px rgba(139, 92, 246, .70),
    0 0 40px rgba(124, 58, 237, .50),
    0 0 60px rgba(109, 40, 217, .30);
  display: grid;
  place-items: center;
  overflow: visible;
  cursor: grab;
  touch-action: none;
  user-select: none;
  transform: rotate(0);
  transition: transform .5s ease, box-shadow .3s ease;
}

.agent-floating-launcher.is-dragging .agent-floating__button {
  cursor: grabbing;
}

.agent-floating__button::before,
.agent-floating__button::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}

.agent-floating__button::before {
  z-index: 0;
  background: linear-gradient(to bottom, rgba(255, 255, 255, .20), transparent);
  opacity: .30;
}

.agent-floating__button::after {
  z-index: 1;
  border: 2px solid rgba(255, 255, 255, .10);
}

.agent-floating__button:hover {
  transform: scale(1.1) rotate(5deg);
  box-shadow:
    0 0 30px rgba(139, 92, 246, .90),
    0 0 50px rgba(124, 58, 237, .70),
    0 0 70px rgba(109, 40, 217, .50);
}

.agent-floating__button.is-open {
  color: #fff;
  transform: rotate(90deg);
}

.agent-floating__button.is-open:hover {
  transform: scale(1.1) rotate(95deg);
}

.agent-floating__button:active {
  transform: scale(.95) rotate(5deg);
}

.agent-floating__button.is-open:active {
  transform: scale(.95) rotate(95deg);
}

.agent-floating__button:focus-visible {
  outline: 2px solid rgba(196, 181, 253, .95);
  outline-offset: 4px;
}

.agent-floating__button-aura {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background: #6366f1;
  opacity: .20;
  animation: agent-button-ping 1.5s cubic-bezier(0, 0, .2, 1) infinite;
}

.agent-floating__button-core {
  position: relative;
  z-index: 2;
  display: grid;
  place-items: center;
}

.agent-floating__running {
  position: absolute;
  top: 6px;
  right: 5px;
  z-index: 4;
  width: 9px;
  height: 9px;
  border: 2px solid rgba(24, 24, 27, .92);
  border-radius: 50%;
  background: var(--agent-green);
  box-shadow: 0 0 10px rgba(34, 197, 94, .9);
}

.agent-floating-launcher.is-edge-collapsed.is-edge-left { transform: translateX(-54px); }
.agent-floating-launcher.is-edge-collapsed.is-edge-right { transform: translateX(54px); }
.agent-floating-launcher.is-edge-collapsed.is-edge-top { transform: translateY(-54px); }
.agent-floating-launcher.is-edge-collapsed.is-edge-bottom { transform: translateY(54px); }
.agent-floating-launcher.is-edge-collapsed .agent-floating__button { transform: none; }

.agent-floating__edge-toggle {
  position: absolute;
  width: 28px;
  height: 34px;
  padding: 0;
  border: 1px solid rgba(203, 188, 255, .24);
  border-radius: 999px;
  background: rgba(18, 16, 26, .88);
  color: rgba(248, 244, 255, .76);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .28);
  display: grid;
  place-items: center;
  cursor: pointer;
  backdrop-filter: blur(18px);
}

.agent-floating-launcher.is-edge-right .agent-floating__edge-toggle { top: 15px; right: 72px; }
.agent-floating-launcher.is-edge-left .agent-floating__edge-toggle { top: 15px; left: 72px; }
.agent-floating-launcher.is-edge-top .agent-floating__edge-toggle { top: 72px; left: 15px; }
.agent-floating-launcher.is-edge-bottom .agent-floating__edge-toggle { bottom: 72px; left: 15px; }

@keyframes agent-button-ping {
  75%,
  100% {
    opacity: 0;
    transform: scale(2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-floating__button-aura { animation: none; }
  .agent-floating__button { animation-duration: .01ms; transition-duration: .01ms; }
}
</style>
