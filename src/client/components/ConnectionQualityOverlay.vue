<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { ConnectionQualityOverlayAction, ConnectionQualityOverlayState } from "../../shared/connection-quality";
import ConnectionQualityCard from "./ConnectionQualityCard.vue";

const state = ref<ConnectionQualityOverlayState | null>(null);
const suppressClick = ref(false);
let removeStateListener: (() => void) | undefined;
let pointer: {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  startsOnControl: boolean;
} | null = null;

function action(value: ConnectionQualityOverlayAction): void {
  void window.vironConnectionQuality?.action(value);
}

function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  pointer = {
    id: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    lastX: event.screenX,
    lastY: event.screenY,
    moved: false,
    startsOnControl: event.target instanceof Element && Boolean(event.target.closest("button")),
  };
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent): void {
  if (!pointer || pointer.id !== event.pointerId) return;
  pointer.lastX = event.screenX;
  pointer.lastY = event.screenY;
  if (!(event.buttons & 1)) return finishDrag(event);
  if (!pointer.moved && Math.hypot(event.screenX - pointer.startX, event.screenY - pointer.startY) < 8) return;
  if (!pointer.moved) {
    pointer.moved = true;
    action({ type: "drag-start", screenX: pointer.startX, screenY: pointer.startY });
  }
  action({ type: "drag-move", screenX: event.screenX, screenY: event.screenY });
  event.preventDefault();
}

function suppressClickAfterDrag(): void {
  suppressClick.value = true;
  window.setTimeout(() => { suppressClick.value = false; }, 0);
}

function guardClick(event: MouseEvent): void {
  if (!suppressClick.value) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function finishDrag(event?: PointerEvent, toggleIfClick = false): void {
  if (!pointer || (event && pointer.id !== event.pointerId)) return;
  const active = pointer;
  pointer = null;
  if (event?.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  if (active.moved) {
    suppressClickAfterDrag();
    action({ type: "drag-end", screenX: event?.screenX ?? active.lastX, screenY: event?.screenY ?? active.lastY });
  } else if (toggleIfClick && !active.startsOnControl) {
    action({ type: "toggle-details" });
  }
}

function finishPointer(event: PointerEvent): void {
  finishDrag(event, true);
}

function cancelPointer(event: PointerEvent): void {
  finishDrag(event);
}

function abortDrag(): void {
  finishDrag();
}

onMounted(() => {
  removeStateListener = window.vironConnectionQuality?.onState((value) => { state.value = value; });
  document.addEventListener("mouseleave", abortDrag);
  document.addEventListener("lostpointercapture", abortDrag);
  window.addEventListener("blur", abortDrag);
});

onBeforeUnmount(() => {
  finishDrag();
  removeStateListener?.();
  document.removeEventListener("mouseleave", abortDrag);
  document.removeEventListener("lostpointercapture", abortDrag);
  window.removeEventListener("blur", abortDrag);
});
</script>

<template>
  <ConnectionQualityCard
    v-if="state"
    class="native-connection-quality"
    :class="{ 'is-interaction-layer': state.interactionLayer }"
    :style="{ left: `${state.rootOffset.x}px`, top: `${state.rootOffset.y}px` }"
    :state="state"
    @run-test="action({ type: 'run-test' })"
    @select-target="action({ type: 'select-target', targetId: $event })"
    @panel-click-capture="guardClick"
    @panel-pointerdown="startDrag"
    @panel-pointermove="moveDrag"
    @panel-pointerup="finishPointer"
    @panel-pointercancel="cancelPointer"
  />
</template>

<style>
* { box-sizing: border-box; }
html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
.native-connection-quality { position: absolute !important; }
.native-connection-quality.is-interaction-layer { opacity: 0; }
</style>
