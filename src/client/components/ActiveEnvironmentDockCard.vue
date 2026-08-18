<script setup lang="ts">
import {
  Database,
  FileText,
  Globe2,
  MemoryStick,
  Server,
  TerminalSquare,
  X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ACTIVE_ENVIRONMENT_DOCK_CARD_GAP,
  ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS,
  ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH,
  ACTIVE_ENVIRONMENT_DOCK_LAYER_X,
  ACTIVE_ENVIRONMENT_DOCK_LAYER_Y,
  ACTIVE_ENVIRONMENT_DOCK_PADDING,
  ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS,
  type ActiveEnvironmentDockConnection,
  type ActiveEnvironmentDockEnvironment,
  type ActiveEnvironmentDockState,
} from "../../shared/active-environment-dock";
import { ENVIRONMENT_WORKSPACE_EXIT_MS } from "../environment-workspace-transition";

const props = withDefaults(defineProps<{
  state: ActiveEnvironmentDockState;
  deferCollapseResize?: boolean;
}>(), {
  deferCollapseResize: false,
});
const emit = defineEmits<{
  expand: [];
  collapse: [];
  openEnvironment: [environmentId: string, origin: { x: number; y: number; width: number; height: number }];
  closeEnvironment: [environmentId: string];
  dragPointerdown: [event: PointerEvent];
  dragPointermove: [event: PointerEvent];
  dragPointerup: [event: PointerEvent];
  dragPointercancel: [event: PointerEvent];
  clickCapture: [event: MouseEvent];
}>();

const viewport = ref<HTMLElement | null>(null);
const pointerDragging = ref(false);
const collapseTransitioning = ref(false);
const activatingEnvironmentId = ref("");
const displayHeight = ref(props.state.bounds.height);
let dragPointer: { id: number; x: number; y: number; moved: boolean } | null = null;
let suppressActivation = false;
let pointerInside = false;
let focusInside = false;
let collapseTimer: number | null = null;
let activationResetTimer: number | null = null;
const expandedTrackHeight = computed(() => ACTIVE_ENVIRONMENT_DOCK_PADDING * 2
  + props.state.environments.length * props.state.card.height
  + Math.max(0, props.state.environments.length - 1) * ACTIVE_ENVIRONMENT_DOCK_CARD_GAP);
const trackHeight = computed(() => props.state.expanded || collapseTransitioning.value
  ? expandedTrackHeight.value
  : props.state.bounds.height);

function typeIcon(type: ActiveEnvironmentDockConnection["type"]) {
  if (type === "web") return Globe2;
  if (type === "ssh") return TerminalSquare;
  if (type === "logs") return FileText;
  if (type === "database") return Database;
  if (type === "redis") return MemoryStick;
  return Server;
}

function typeLabel(type: ActiveEnvironmentDockConnection["type"]): string {
  if (type === "web") return "Web";
  if (type === "ssh") return "SSH";
  if (type === "logs") return "日志";
  if (type === "database") return "数据库";
  if (type === "redis") return "Redis";
  return "SFTP";
}

function primaryConnection(environment: ActiveEnvironmentDockEnvironment): ActiveEnvironmentDockConnection {
  return environment.connections[0]!;
}

function activateEnvironment(environmentId: string, event: MouseEvent): void {
  if (suppressActivation) return;
  if (!props.state.expanded && props.state.environments.length > 1) emit("expand");
  else {
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement) || activatingEnvironmentId.value) return;
    const bounds = element.getBoundingClientRect();
    activatingEnvironmentId.value = environmentId;
    window.setTimeout(() => {
      emit("openEnvironment", environmentId, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      activationResetTimer = window.setTimeout(() => {
        activationResetTimer = null;
        if (activatingEnvironmentId.value === environmentId) activatingEnvironmentId.value = "";
      }, 900);
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ENVIRONMENT_WORKSPACE_EXIT_MS);
  }
}

function environmentClosing(environment: ActiveEnvironmentDockEnvironment): boolean {
  return environment.connections.every((connection) => connection.status === "closing");
}

function pointerPosition(event: PointerEvent): { x: number; y: number } {
  return event.screenX || event.screenY
    ? { x: event.screenX, y: event.screenY }
    : { x: event.clientX, y: event.clientY };
}

function handleDragPointerdown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const pointer = pointerPosition(event);
  dragPointer = { id: event.pointerId, ...pointer, moved: false };
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
  emit("dragPointerdown", event);
}

function handleDragPointermove(event: PointerEvent): void {
  if (!dragPointer || dragPointer.id !== event.pointerId) return;
  const pointer = pointerPosition(event);
  if (!dragPointer.moved && Math.hypot(pointer.x - dragPointer.x, pointer.y - dragPointer.y) >= 7) {
    dragPointer.moved = true;
    pointerDragging.value = true;
  }
  emit("dragPointermove", event);
  if (dragPointer.moved) event.preventDefault();
}

function handleDragPointerup(event: PointerEvent): void {
  finishCardDrag(event, "dragPointerup");
}

function handleDragPointercancel(event: PointerEvent): void {
  finishCardDrag(event, "dragPointercancel");
}

function finishCardDrag(event: PointerEvent, type: "dragPointerup" | "dragPointercancel"): void {
  if (!dragPointer || dragPointer.id !== event.pointerId) return;
  const moved = dragPointer.moved;
  dragPointer = null;
  pointerDragging.value = false;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  if (type === "dragPointerup") emit("dragPointerup", event);
  else emit("dragPointercancel", event);
  if (!moved) return;
  suppressActivation = true;
  window.setTimeout(() => { suppressActivation = false; }, 0);
}

function cardStyle(index: number): Record<string, string | number> {
  const expandedOffset = ACTIVE_ENVIRONMENT_DOCK_PADDING + index * (props.state.card.height + ACTIVE_ENVIRONMENT_DOCK_CARD_GAP);
  const collapsedDepth = Math.min(index, ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH);
  const verticalOffset = props.state.expanded ? expandedOffset : ACTIVE_ENVIRONMENT_DOCK_PADDING + collapsedDepth * ACTIVE_ENVIRONMENT_DOCK_LAYER_Y;
  const horizontalOffset = props.state.expanded ? ACTIVE_ENVIRONMENT_DOCK_PADDING : ACTIVE_ENVIRONMENT_DOCK_PADDING + collapsedDepth * ACTIVE_ENVIRONMENT_DOCK_LAYER_X;
  return {
    width: `${props.state.card.width}px`,
    height: `${props.state.card.height}px`,
    left: "0px",
    ...(props.state.growUp ? { bottom: "0px" } : { top: "0px" }),
    "--active-environment-pip-x": `${horizontalOffset}px`,
    "--active-environment-pip-y": `${props.state.growUp ? -verticalOffset : verticalOffset}px`,
    zIndex: props.state.environments.length - index,
    opacity: !props.state.expanded && index > ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH ? 0 : 1,
    pointerEvents: !props.state.expanded && index > 0 ? "none" : "auto",
  };
}

function finishCollapseTransition(): void {
  collapseTransitioning.value = false;
  displayHeight.value = props.state.bounds.height;
}

function finishCollapseAfterResize(): void {
  if (props.deferCollapseResize && collapseTransitioning.value) finishCollapseTransition();
}

function cancelCollapse(): void {
  if (collapseTimer === null) return;
  window.clearTimeout(collapseTimer);
  collapseTimer = null;
}

function expandFromPointer(): void {
  pointerInside = true;
  cancelCollapse();
  emit("expand");
}

function collapseAfterPointerLeaves(): void {
  pointerInside = false;
  scheduleCollapse();
}

function expandFromFocus(): void {
  focusInside = true;
  cancelCollapse();
  emit("expand");
}

function scheduleCollapse(): void {
  cancelCollapse();
  if (pointerInside || focusInside) return;
  collapseTimer = window.setTimeout(() => {
    collapseTimer = null;
    if (!pointerInside && !focusInside) emit("collapse");
  }, ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS);
}

function leaveFocus(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && event.currentTarget instanceof HTMLElement && event.currentTarget.contains(next)) return;
  focusInside = false;
  scheduleCollapse();
}

watch(
  () => [props.state.expanded, props.state.growUp] as const,
  async ([expanded, growUp]) => {
    if (!expanded) return;
    await nextTick();
    if (viewport.value) viewport.value.scrollTop = growUp ? viewport.value.scrollHeight : 0;
  },
  { immediate: true },
);

watch(
  () => props.state.expanded,
  (expanded, wasExpanded) => {
    if (!props.deferCollapseResize || expanded || !wasExpanded || displayHeight.value === props.state.bounds.height) {
      collapseTransitioning.value = false;
      displayHeight.value = props.state.bounds.height;
      return;
    }
    collapseTransitioning.value = true;
  },
);

watch(
  () => props.state.bounds.height,
  (height) => {
    if (!collapseTransitioning.value) displayHeight.value = height;
  },
);

onMounted(() => window.addEventListener("resize", finishCollapseAfterResize));

onBeforeUnmount(() => {
  cancelCollapse();
  window.removeEventListener("resize", finishCollapseAfterResize);
  if (activationResetTimer !== null) window.clearTimeout(activationResetTimer);
});

watch(() => props.state.environments.map((environment) => environment.id), (environmentIds) => {
  if (activatingEnvironmentId.value && !environmentIds.includes(activatingEnvironmentId.value)) activatingEnvironmentId.value = "";
});
</script>

<template>
  <section
    class="active-environment-pip"
    :class="{ 'is-expanded': state.expanded, 'is-grow-up': state.growUp, 'is-dragging': state.dragging || pointerDragging }"
    :style="{
      width: `${state.bounds.width}px`,
      height: `${displayHeight}px`,
      '--active-environment-dock-transition-duration': `${ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS}ms`,
    }"
    data-active-environment-dock
    @mouseenter="expandFromPointer"
    @mouseleave="collapseAfterPointerLeaves"
    @focusin="expandFromFocus"
    @focusout="leaveFocus"
    @click.capture="emit('clickCapture', $event)"
  >
    <div ref="viewport" class="active-environment-pip__viewport">
      <div class="active-environment-pip__track" :style="{ height: `${trackHeight}px` }">
        <article
          v-for="(environment, index) in state.environments"
          :key="environment.id"
          class="active-environment-pip__card"
          :class="{ 'is-closing': environmentClosing(environment), 'is-activating': activatingEnvironmentId === environment.id, 'has-preview': Boolean(environment.preview?.dataUrl) }"
          :style="cardStyle(index)"
          :title="environment.name"
        >
          <button
            type="button"
            class="active-environment-pip__open"
            :aria-label="!state.expanded && state.environments.length > 1 ? $t('展开环境画中画') : $t('切换到环境：{0}', [environment.name])"
            :aria-expanded="index === 0 && state.environments.length > 1 ? state.expanded : undefined"
            @click="activateEnvironment(environment.id, $event)"
            @pointerdown="handleDragPointerdown"
            @pointermove="handleDragPointermove"
            @pointerup="handleDragPointerup"
            @pointercancel="handleDragPointercancel"
          >
            <span class="active-environment-pip__visual" aria-hidden="true">
              <img v-if="environment.preview?.dataUrl" :src="environment.preview.dataUrl" alt="" draggable="false" />
              <span v-else class="active-environment-pip__pending">
                <component :is="typeIcon(primaryConnection(environment).type)" :size="32" />
              </span>
            </span>
            <span class="active-environment-pip__caption">
              <span class="active-environment-pip__identity">
                <strong>{{ environment.name }}</strong>
                <small><i></i>{{ $t(typeLabel(primaryConnection(environment).type)) }} · {{ primaryConnection(environment).label }}</small>
              </span>
              <component :is="typeIcon(primaryConnection(environment).type)" :size="16" />
            </span>
          </button>
          <button
            type="button"
            class="active-environment-pip__close"
            :disabled="environmentClosing(environment)"
            :aria-label="$t('关闭环境全部连接：{0}', [environment.name])"
            :title="$t('关闭环境全部连接')"
            @click.stop="emit('closeEnvironment', environment.id)"
            @pointerdown.stop
            @keydown.stop
          ><X :size="15" /></button>
        </article>
        <span v-if="!state.expanded && state.environments.length > ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH + 1" class="active-environment-pip__count">
          +{{ state.environments.length - ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH - 1 }}
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.active-environment-pip {
  position: relative;
  color: var(--ink-900);
  font-family: var(--font-ui, "Avenir Next", "PingFang SC", sans-serif);
  user-select: none;
  touch-action: none;
}
.active-environment-pip__viewport { width: 100%; height: 100%; overflow: hidden; scrollbar-width: thin; scrollbar-color: var(--ink-300) transparent; }
.active-environment-pip.is-expanded .active-environment-pip__viewport { overflow-y: auto; }
.active-environment-pip__track { position: relative; width: 100%; min-height: 100%; }
.active-environment-pip__card {
  position: absolute;
  margin: 0;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--ink-300) 78%, transparent);
  border-radius: var(--radius-panel, 8px);
  overflow: hidden;
  background: var(--surface);
  color: var(--ink-900);
  box-shadow: 0 4px 8px color-mix(in srgb, var(--ink-950) 18%, transparent);
  display: block;
  cursor: pointer;
  transform-origin: center;
  transform: translate3d(var(--active-environment-pip-x), var(--active-environment-pip-y), 0) scale(var(--active-environment-pip-scale, 1));
  backface-visibility: hidden;
  will-change: transform, opacity;
  transition: transform var(--active-environment-dock-transition-duration) var(--ease-out), opacity var(--dur-micro, 120ms) ease, border-color var(--dur-micro, 120ms) ease;
  -webkit-app-region: no-drag;
}
.active-environment-pip__card:hover,
.active-environment-pip__card:focus-within { border-color: var(--teal-500); outline: 2px solid color-mix(in srgb, var(--teal-500) 34%, transparent); outline-offset: 2px; }
.active-environment-pip__card:active { --active-environment-pip-scale: .992; }
.active-environment-pip__card.is-activating {
  --active-environment-pip-scale: 1.025;
  border-color: var(--teal-500);
  opacity: 0;
  filter: saturate(1.08) brightness(1.03);
  pointer-events: none;
  transition-duration: 110ms;
}
.active-environment-pip.is-dragging .active-environment-pip__card { cursor: grabbing; }
.active-environment-pip__card.is-closing { opacity: .62 !important; }
.active-environment-pip__open { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: grab; touch-action: none; -webkit-app-region: no-drag; }
.active-environment-pip.is-dragging .active-environment-pip__open { cursor: grabbing; }
.active-environment-pip__open:focus-visible { outline: 0; }
.active-environment-pip__visual { position: absolute; inset: 0; display: block; background: var(--ink-50); pointer-events: none; }
.active-environment-pip__visual > img { width: 100%; height: 100%; object-fit: cover; display: block; }
.active-environment-pip__pending {
  width: 100%;
  height: 100%;
  color: var(--teal-700);
  display: grid;
  place-items: center;
  background-color: var(--ink-50);
  background-image: linear-gradient(var(--page-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--page-grid-line) 1px, transparent 1px);
  background-size: var(--page-grid-size) var(--page-grid-size);
}
.active-environment-pip__caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  min-width: 0;
  height: 44px;
  padding: 0 var(--space-sm);
  background: color-mix(in srgb, var(--color-sidebar) 92%, transparent);
  color: var(--color-sidebar-ink);
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  text-align: left;
  pointer-events: none;
}
.active-environment-pip__identity { min-width: 0; flex: 1; }
.active-environment-pip__identity strong,
.active-environment-pip__identity small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.active-environment-pip__identity strong { font-size: var(--text-xs); font-weight: 700; }
.active-environment-pip__identity small { margin-top: 2px; color: var(--color-sidebar-muted); font-size: 10px; }
.active-environment-pip__identity i { width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--color-accent-on-dark); display: inline-block; }
.active-environment-pip__caption > svg { flex: 0 0 auto; color: var(--color-accent-on-dark); }
.active-environment-pip__close {
  position: absolute;
  top: 8px;
  z-index: 4;
  width: 28px;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--color-sidebar-ink) 20%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-sidebar) 88%, transparent);
  color: var(--color-sidebar-muted);
  display: grid;
  place-items: center;
  -webkit-app-region: no-drag;
}
.active-environment-pip__close { right: 8px; padding: 0; cursor: pointer; }
.active-environment-pip__close:hover:not(:disabled) { border-color: var(--red-500); background: var(--red-600); color: white; }
.active-environment-pip__close:disabled { opacity: .5; cursor: wait; }
.active-environment-pip__count {
  position: absolute;
  right: 0;
  bottom: 0;
  z-index: 50;
  min-width: 26px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px 0 0 0;
  background: var(--color-sidebar);
  color: var(--color-sidebar-ink);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  line-height: 22px;
  text-align: center;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .active-environment-pip__card { transition: opacity 120ms ease; }
  .active-environment-pip__card.is-activating { opacity: .7; filter: none; }
}
</style>
