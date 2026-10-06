<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import type { AgentFloatingOverlayAction, AgentFloatingOverlayState } from "../../shared/agent-floating-overlay";
import { agentFloatingDragMoved } from "../agent-floating-position";
import AgentFloatingLauncher from "./AgentFloatingLauncher.vue";

const props = defineProps<{ state: Pick<AgentFloatingOverlayState, "open" | "running" | "dragging" | "edgeCollapsed" | "snappedEdge" | "label"> }>();
const emit = defineEmits<{ action: [action: AgentFloatingOverlayAction] }>();
let pointer: { id: number; x: number; y: number; lastX: number; lastY: number; moved: boolean } | null = null;
let suppressClick = false;
let suppressTimer: number | undefined;
function toggle() {
  if (suppressClick) { suppressClick = false; return; }
  emit("action", { type: "toggle" });
}
function start(event: PointerEvent) {
  if (event.button !== 0 || props.state.edgeCollapsed) return;
  pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, lastX: event.screenX, lastY: event.screenY, moved: false };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId) return;
  pointer.lastX = event.screenX; pointer.lastY = event.screenY;
  if (!(event.buttons & 1)) return finish(event);
  if (!pointer.moved && !agentFloatingDragMoved({ x: pointer.x, y: pointer.y }, { x: event.screenX, y: event.screenY })) return;
  if (!pointer.moved) {
    pointer.moved = true;
    emit("action", { type: "drag-start", screenX: pointer.x, screenY: pointer.y });
  }
  emit("action", { type: "drag-move", screenX: event.screenX, screenY: event.screenY });
  event.preventDefault();
}
function abort() {
  const active = pointer; pointer = null;
  if (!active?.moved) return;
  suppressClick = true;
  window.clearTimeout(suppressTimer);
  suppressTimer = window.setTimeout(() => { suppressClick = false; }, 250);
  emit("action", { type: "drag-end", screenX: active.lastX, screenY: active.lastY });
}
function finish(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId) return;
  abort();
  const target = event.currentTarget;
  if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}
onMounted(() => window.addEventListener("blur", abort));
onBeforeUnmount(() => { abort(); window.removeEventListener("blur", abort); window.clearTimeout(suppressTimer); });
</script>

<template>
  <AgentFloatingLauncher v-bind="state" @toggle="toggle" @expand="emit('action', { type: 'expand' })"
    @button-pointerdown="start" @button-pointermove="move" @button-pointerup="finish" @button-pointercancel="finish"
    @lostpointercapture="finish" />
</template>
