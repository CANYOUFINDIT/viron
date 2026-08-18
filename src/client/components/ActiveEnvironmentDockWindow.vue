<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  activeEnvironmentDockCardSize,
  activeEnvironmentDockEnvironments,
  activeEnvironmentDockLayoutSnapshot,
  activeEnvironmentDockPanelSize,
  activeEnvironmentDockStateSnapshot,
  activeEnvironmentDockVisibleEnvironments,
  clampActiveEnvironmentDockPosition,
  snapActiveEnvironmentDockPosition,
  type ActiveEnvironmentDockAction,
  type ActiveEnvironmentDockPosition,
  type ActiveEnvironmentDockState,
} from "../../shared/active-environment-dock";
import { activeEnvironmentDockNavigationTarget } from "../active-connection-navigation";
import { rememberedActiveConnectionOrigin } from "../active-connection-origin";
import { activeConnections, closeActiveConnections, loadActiveConnections } from "../active-connections";
import {
  isDesktopApp,
  onDesktopActiveEnvironmentDockAction,
  updateDesktopActiveEnvironmentDock,
  updateDesktopActiveEnvironmentDockLayout,
} from "../desktop";
import {
  environmentWorkspaceConnectionVisible,
  environmentWorkspacePreviews,
  hideEnvironmentWorkspaceConnections,
  orderEnvironmentWorkspaceConnections,
  removeEnvironmentWorkspace,
} from "../environment-workspace-previews";
import { rememberEnvironmentWorkspaceTransition, type EnvironmentWorkspaceTransitionOrigin } from "../environment-workspace-transition";
import { language, translate as tr } from "../i18n";
import { session } from "../session";
import { theme } from "../theme";
import ActiveEnvironmentDockCard from "./ActiveEnvironmentDockCard.vue";

interface DragState {
  pointerId?: number;
  cursor: { x: number; y: number };
  origin: ActiveEnvironmentDockPosition;
  moved: boolean;
}

const positionStorageKey = "viron-active-environment-pip-position";
const desktop = isDesktopApp();
const route = useRoute();
const router = useRouter();
const expanded = ref(false);
const growUp = ref(true);
const dragging = ref(false);
const suppressClick = ref(false);
const closingEnvironmentIds = ref<string[]>([]);
const viewport = ref({ width: window.innerWidth, height: window.innerHeight });
const position = ref<ActiveEnvironmentDockPosition>({ x: 16, y: 16 });
let dragState: DragState | null = null;
let removeDesktopActionListener: (() => void) | undefined;
let pendingFullPublish = false;

const rememberedEnvironmentIds = computed(() => Object.fromEntries(
  activeConnections.items.flatMap((item) => {
    const environmentId = rememberedActiveConnectionOrigin(item.id);
    return environmentId ? [[item.id, environmentId]] : [];
  }),
));
const groupedEnvironments = computed(() => {
  const user = session.user;
  const workspace = session.workspace;
  if (!user || !workspace) return [];
  return activeEnvironmentDockEnvironments(activeConnections.items, {
    ownerId: user.id,
    workspaceType: workspace.type,
    workspaceId: workspace.id,
    desktop,
    rememberedEnvironmentIds: rememberedEnvironmentIds.value,
  }).flatMap((environment) => {
    const connections = environment.connections.filter((connection) => environmentWorkspaceConnectionVisible(connection.id));
    return connections.length ? [{ ...environment, connections }] : [];
  });
});
const currentEnvironmentId = computed(() => route.name === "environment" ? String(route.params.id ?? "") : "");
const environments = computed(() => activeEnvironmentDockVisibleEnvironments(
  groupedEnvironments.value,
  environmentWorkspacePreviews.stack,
  currentEnvironmentId.value,
).map((environment) => ({
  ...environment,
  preview: environmentWorkspacePreviews.frames[environment.id]
    ? { ...environmentWorkspacePreviews.frames[environment.id] }
    : undefined,
  connections: orderEnvironmentWorkspaceConnections(
    environment.connections,
    environmentWorkspacePreviews.queries[environment.id],
  ).map((connection) => closingEnvironmentIds.value.includes(environment.id)
    ? { ...connection, status: "closing" as const }
    : connection),
})));
const visible = computed(() => environments.value.length > 0);
const state = computed<ActiveEnvironmentDockState | null>(() => {
  if (!visible.value) return null;
  position.value = clampActiveEnvironmentDockPosition(position.value, viewport.value, expanded.value, environments.value);
  const size = activeEnvironmentDockPanelSize(expanded.value, environments.value, viewport.value);
  return {
    bounds: { x: position.value.x, y: position.value.y, ...size },
    card: activeEnvironmentDockCardSize(viewport.value),
    expanded: expanded.value,
    growUp: growUp.value,
    dragging: dragging.value,
    dark: theme.value === "dark",
    language: language.value,
    environments: environments.value,
  };
});

function defaultPosition(): ActiveEnvironmentDockPosition {
  const size = activeEnvironmentDockPanelSize(false, environments.value, viewport.value);
  return {
    x: Math.max(16, viewport.value.width - size.width - 16),
    y: Math.max(16, viewport.value.height - size.height - 16),
  };
}

function storedPosition(): ActiveEnvironmentDockPosition {
  try {
    const value = JSON.parse(localStorage.getItem(positionStorageKey) || "null") as Partial<ActiveEnvironmentDockPosition> | null;
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: Number(value.x), y: Number(value.y) };
  } catch {
    // Ignore malformed device-local position state.
  }
  return defaultPosition();
}

function persistPosition(): void {
  localStorage.setItem(positionStorageKey, JSON.stringify(position.value));
}

async function publish(): Promise<void> {
  if (!desktop) return;
  if (dragging.value) {
    pendingFullPublish = true;
    return;
  }
  pendingFullPublish = false;
  try {
    await updateDesktopActiveEnvironmentDock(activeEnvironmentDockStateSnapshot(state.value));
  } catch (error) {
    console.error("[Viron] Failed to publish active environment picture-in-picture state", error);
  }
}

async function publishLayout(): Promise<void> {
  if (!desktop || !state.value) return;
  try {
    await updateDesktopActiveEnvironmentDockLayout(activeEnvironmentDockLayoutSnapshot(state.value));
  } catch (error) {
    console.error("[Viron] Failed to publish active environment picture-in-picture layout", error);
  }
}

function resumePendingPublish(): void {
  if (!pendingFullPublish) return;
  window.requestAnimationFrame(() => { void publish(); });
}

function setExpanded(value: boolean): void {
  if (expanded.value === value || !environments.value.length) return;
  const oldSize = activeEnvironmentDockPanelSize(expanded.value, environments.value, viewport.value);
  if (value) growUp.value = position.value.y + oldSize.height / 2 > viewport.value.height / 2;
  const nextSize = activeEnvironmentDockPanelSize(value, environments.value, viewport.value);
  if (growUp.value) position.value.y += oldSize.height - nextSize.height;
  expanded.value = value;
  position.value = clampActiveEnvironmentDockPosition(position.value, viewport.value, value, environments.value);
  persistPosition();
}

function connectionItem(connectionId: string) {
  return activeConnections.items.find((item) => item.id === connectionId) ?? null;
}

async function openEnvironment(environmentId: string, origin?: EnvironmentWorkspaceTransitionOrigin): Promise<void> {
  const environment = environments.value.find((item) => item.id === environmentId);
  const connection = environment?.connections[0];
  if (!connection) return;
  const item = connectionItem(connection.id);
  if (!item) return;
  try {
    if (origin) rememberEnvironmentWorkspaceTransition(environmentId, origin);
    const rememberedQuery = environmentWorkspacePreviews.queries[environmentId];
    await router.push(rememberedQuery && Object.keys(rememberedQuery).length
      ? { name: "environment", params: { id: environmentId }, query: { ...rememberedQuery } }
      : activeEnvironmentDockNavigationTarget(item, environmentId));
    setExpanded(false);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法打开连接位置"));
  }
}

async function closeEnvironment(environmentId: string): Promise<void> {
  const environment = groupedEnvironments.value.find((item) => item.id === environmentId);
  if (!environment || closingEnvironmentIds.value.includes(environmentId)) return;
  const items = environment.connections.flatMap((connection) => {
    const item = connectionItem(connection.id);
    return item ? [item] : [];
  });
  if (!items.length) return;
  try {
    await ElMessageBox.confirm(
      tr("将关闭“{0}”的 {1} 个活动连接，并移除该环境的画中画。", [environment.name, items.length]),
      tr("关闭环境全部连接"),
      { type: "warning", confirmButtonText: tr("关闭全部连接"), cancelButtonText: tr("取消") },
    );
    closingEnvironmentIds.value = [...closingEnvironmentIds.value, environmentId];
    await closeActiveConnections(items);
    hideEnvironmentWorkspaceConnections(items.map((item) => item.id));
    removeEnvironmentWorkspace(environmentId);
    ElMessage.success(tr("已关闭“{0}”的全部连接", [environment.name]));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("关闭环境连接失败"));
  } finally {
    closingEnvironmentIds.value = closingEnvironmentIds.value.filter((item) => item !== environmentId);
  }
}

function beginDrag(cursor: { x: number; y: number }, pointerId?: number): void {
  dragState = { pointerId, cursor, origin: { ...position.value }, moved: false };
}

function moveDrag(cursor: { x: number; y: number }): void {
  if (!dragState) return;
  const deltaX = cursor.x - dragState.cursor.x;
  const deltaY = cursor.y - dragState.cursor.y;
  if (!dragState.moved && Math.hypot(deltaX, deltaY) < 7) return;
  dragState.moved = true;
  dragging.value = true;
  position.value = clampActiveEnvironmentDockPosition({
    x: dragState.origin.x + deltaX,
    y: dragState.origin.y + deltaY,
  }, viewport.value, expanded.value, environments.value);
}

function finishDrag(): boolean {
  const moved = Boolean(dragState?.moved);
  dragState = null;
  dragging.value = false;
  if (moved) {
    position.value = snapActiveEnvironmentDockPosition(position.value, viewport.value, expanded.value, environments.value);
    persistPosition();
  }
  return moved;
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

function webPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  beginDrag({ x: event.clientX, y: event.clientY }, event.pointerId);
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
}

function webPointerMove(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (!(event.buttons & 1)) return void finishDrag();
  moveDrag({ x: event.clientX, y: event.clientY });
  if (dragState?.moved) event.preventDefault();
}

function webPointerUp(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  if (finishDrag()) suppressClickAfterDrag();
}

function webPointerCancel(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  if (finishDrag()) suppressClickAfterDrag();
}

function desktopAction(action: ActiveEnvironmentDockAction): void {
  if (action.type === "expand") return setExpanded(true);
  if (action.type === "collapse") return setExpanded(false);
  if (action.type === "toggle") return setExpanded(!expanded.value);
  if (action.type === "open-environment") return void openEnvironment(action.environmentId, action.origin);
  if (action.type === "close-environment") return void closeEnvironment(action.environmentId);
  if (action.type === "position") {
    dragState = null;
    position.value = snapActiveEnvironmentDockPosition({ x: action.x, y: action.y }, viewport.value, expanded.value, environments.value);
    dragging.value = false;
    persistPosition();
    resumePendingPublish();
    return;
  }
  if (action.type === "drag-start" || action.type === "drag-move" || action.type === "drag-end") {
    const cursor = { x: action.screenX, y: action.screenY };
    if (action.type === "drag-start") {
      beginDrag(cursor);
      pendingFullPublish = true;
      dragging.value = true;
    }
    else if (action.type === "drag-move") moveDrag(cursor);
    else {
      finishDrag();
      resumePendingPublish();
    }
  }
}

function resize(): void {
  viewport.value = { width: window.innerWidth, height: window.innerHeight };
  position.value = clampActiveEnvironmentDockPosition(position.value, viewport.value, expanded.value, environments.value);
  persistPosition();
}

function outsidePointerDown(event: PointerEvent): void {
  if (desktop || !expanded.value || event.target instanceof Element && event.target.closest("[data-active-environment-dock]")) return;
  setExpanded(false);
}

watch([visible, environments, () => theme.value, () => language.value], () => { void publish(); }, { deep: true });
watch([
  () => state.value?.bounds.x,
  () => state.value?.bounds.y,
  () => state.value?.bounds.width,
  () => state.value?.bounds.height,
  () => state.value?.card.width,
  () => state.value?.card.height,
  () => state.value?.expanded,
  () => state.value?.growUp,
  () => state.value?.dragging,
], () => { void publishLayout(); });
watch(visible, (value) => { if (!value) expanded.value = false; });

onMounted(() => {
  position.value = clampActiveEnvironmentDockPosition(storedPosition(), viewport.value, false, environments.value);
  growUp.value = position.value.y > viewport.value.height / 2;
  removeDesktopActionListener = onDesktopActiveEnvironmentDockAction(desktopAction);
  window.addEventListener("resize", resize);
  document.addEventListener("pointerdown", outsidePointerDown, true);
  void loadActiveConnections().catch(() => undefined);
  void publish();
});

onBeforeUnmount(() => {
  removeDesktopActionListener?.();
  window.removeEventListener("resize", resize);
  document.removeEventListener("pointerdown", outsidePointerDown, true);
  if (desktop) void updateDesktopActiveEnvironmentDock(null);
});
</script>

<template>
  <ActiveEnvironmentDockCard
    v-if="!desktop && state"
    class="active-environment-pip-web"
    :style="{ left: `${state.bounds.x}px`, top: `${state.bounds.y}px` }"
    :state="state"
    @expand="setExpanded(true)"
    @collapse="setExpanded(false)"
    @open-environment="openEnvironment"
    @close-environment="closeEnvironment"
    @drag-pointerdown="webPointerDown"
    @drag-pointermove="webPointerMove"
    @drag-pointerup="webPointerUp"
    @drag-pointercancel="webPointerCancel"
    @click-capture="guardClick"
  />
</template>

<style scoped>
.active-environment-pip-web { position: fixed; z-index: 2580; }
</style>
