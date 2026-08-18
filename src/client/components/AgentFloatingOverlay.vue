<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { AgentFloatingOverlayAction, AgentFloatingOverlayState } from "../../shared/agent-floating-overlay";
import { agentFloatingDragMoved } from "../agent-floating-position";
import AgentFloatingLauncher from "./AgentFloatingLauncher.vue";

const state = ref<AgentFloatingOverlayState | null>(null);
let removeStateListener: (() => void) | undefined;
let pointer: { id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null = null;
let suppressToggle = false;
let suppressToggleTimer: number | undefined;

function action(value: AgentFloatingOverlayAction) {
  void window.vironAgentLauncher?.action(value);
}

function toggle() {
  if (suppressToggle) {
    suppressToggle = false;
    return;
  }
  action({ type: "toggle" });
}

function suppressDragClick() {
  suppressToggle = true;
  window.clearTimeout(suppressToggleTimer);
  suppressToggleTimer = window.setTimeout(() => { suppressToggle = false; }, 250);
}

function startDrag(event: PointerEvent) {
  if (event.button !== 0 || state.value?.edgeCollapsed) return;
  pointer = {
    id: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    lastX: event.screenX,
    lastY: event.screenY,
    moved: false,
  };
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId) return;
  pointer.lastX = event.screenX;
  pointer.lastY = event.screenY;
  if (!(event.buttons & 1)) {
    finishDrag(event);
    return;
  }
  if (!pointer.moved && !agentFloatingDragMoved(
    { x: pointer.startX, y: pointer.startY },
    { x: event.screenX, y: event.screenY },
  )) return;
  if (!pointer.moved) {
    pointer.moved = true;
    action({ type: "drag-start", screenX: pointer.startX, screenY: pointer.startY });
  }
  action({ type: "drag-move", screenX: event.screenX, screenY: event.screenY });
  event.preventDefault();
}

function finishDrag(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const activePointer = pointer;
  pointer = null;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  if (activePointer.moved) {
    suppressDragClick();
    action({ type: "drag-end", screenX: event.screenX, screenY: event.screenY });
  }
}

function abortDrag() {
  const activePointer = pointer;
  pointer = null;
  if (activePointer?.moved) {
    suppressDragClick();
    action({ type: "drag-end", screenX: activePointer.lastX, screenY: activePointer.lastY });
  }
}

onMounted(() => {
  removeStateListener = window.vironAgentLauncher?.onState((value) => {
    state.value = value;
    if (!value) abortDrag();
  });
  document.addEventListener("mouseleave", abortDrag);
  document.addEventListener("lostpointercapture", finishDrag);
  window.addEventListener("blur", abortDrag);
});

onBeforeUnmount(() => {
  abortDrag();
  removeStateListener?.();
  document.removeEventListener("mouseleave", abortDrag);
  document.removeEventListener("lostpointercapture", finishDrag);
  window.removeEventListener("blur", abortDrag);
  window.clearTimeout(suppressToggleTimer);
});
</script>

<template>
  <AgentFloatingLauncher
    v-if="state"
    class="native-agent-launcher"
    :class="{ 'is-interaction-layer': state.interactionLayer }"
    :style="{ left: `${state.rootOffset.x}px`, top: `${state.rootOffset.y}px` }"
    :open="state.open"
    :running="state.running"
    :dragging="state.dragging"
    :edge-collapsed="state.edgeCollapsed"
    :snapped-edge="state.snappedEdge"
    :label="state.label"
    @toggle="toggle"
    @expand="action({ type: 'expand' })"
    @button-pointerdown="startDrag"
    @button-pointermove="moveDrag"
    @button-pointerup="finishDrag"
    @button-pointercancel="finishDrag"
  />
</template>

<style>
* { box-sizing: border-box; }
html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
.native-agent-launcher { position: absolute !important; }
.native-agent-launcher.is-interaction-layer { opacity: 0; }
</style>
