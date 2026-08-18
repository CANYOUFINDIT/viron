<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type {
  ActiveEnvironmentDockAction,
  ActiveEnvironmentDockDragAction,
  ActiveEnvironmentDockLayoutState,
  ActiveEnvironmentDockState,
} from "../../shared/active-environment-dock";
import { language } from "../i18n";
import ActiveEnvironmentDockCard from "./ActiveEnvironmentDockCard.vue";

const state = ref<ActiveEnvironmentDockState | null>(null);
let removeStateListener: (() => void) | undefined;
let removeLayoutListener: (() => void) | undefined;
let dragMoveFrame: number | null = null;
let pendingDragMove: ActiveEnvironmentDockDragAction | null = null;

function action(value: ActiveEnvironmentDockAction): void {
  void window.vironActiveEnvironmentDock?.action(value);
}

function dragPoint(event: PointerEvent): { screenX: number; screenY: number } {
  return {
    screenX: window.screenX + event.clientX,
    screenY: window.screenY + event.clientY,
  };
}

function cancelDragMoveFrame(): void {
  if (dragMoveFrame === null) return;
  window.cancelAnimationFrame(dragMoveFrame);
  dragMoveFrame = null;
}

function flushDragMove(): void {
  cancelDragMoveFrame();
  if (!pendingDragMove) return;
  window.vironActiveEnvironmentDock?.drag(pendingDragMove);
  pendingDragMove = null;
}

function dragAction(type: "drag-start" | "drag-move" | "drag-end", event: PointerEvent): void {
  const point = dragPoint(event);
  if (type === "drag-move") {
    pendingDragMove = { type, ...point };
    if (dragMoveFrame === null) {
      dragMoveFrame = window.requestAnimationFrame(() => {
        dragMoveFrame = null;
        if (!pendingDragMove) return;
        window.vironActiveEnvironmentDock?.drag(pendingDragMove);
        pendingDragMove = null;
      });
    }
    return;
  }
  if (type === "drag-start") {
    cancelDragMoveFrame();
    pendingDragMove = null;
  } else {
    flushDragMove();
  }
  window.vironActiveEnvironmentDock?.drag({ type, ...point });
}

onMounted(() => {
  removeStateListener = window.vironActiveEnvironmentDock?.onState((value) => {
    state.value = value;
    document.documentElement.classList.toggle("dark", value?.dark === true);
    if (value?.language) language.value = value.language;
  });
  removeLayoutListener = window.vironActiveEnvironmentDock?.onLayout((layout: ActiveEnvironmentDockLayoutState) => {
    if (!state.value) return;
    state.value = {
      ...state.value,
      ...layout,
      bounds: { ...layout.bounds },
      card: { ...layout.card },
    };
  });
});

onBeforeUnmount(() => {
  cancelDragMoveFrame();
  pendingDragMove = null;
  removeStateListener?.();
  removeLayoutListener?.();
});
</script>

<template>
  <ActiveEnvironmentDockCard
    v-if="state"
    class="native-active-environment-dock"
    :state="state"
    defer-collapse-resize
    @expand="action({ type: 'expand' })"
    @collapse="action({ type: 'collapse' })"
    @open-environment="(environmentId, origin) => action({ type: 'open-environment', environmentId, origin })"
    @close-environment="action({ type: 'close-environment', environmentId: $event })"
    @drag-pointerdown="dragAction('drag-start', $event)"
    @drag-pointermove="dragAction('drag-move', $event)"
    @drag-pointerup="dragAction('drag-end', $event)"
    @drag-pointercancel="dragAction('drag-end', $event)"
  />
</template>

<style>
* { box-sizing: border-box; }
html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
.native-active-environment-dock { position: absolute !important; inset: 0; }
</style>
