<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { activeConnections, loadActiveConnections } from "../active-connections";
import { probeConnectionTarget, probeVironService, runVironSpeedTest } from "../connection-quality-client";
import {
  clampConnectionQualityPosition,
  connectionQualityOverlayLayout,
  snapConnectionQualityPosition,
  type ConnectionQualityPosition,
  type ConnectionQualityViewport,
} from "../connection-quality-layout";
import { connectionQualityEnabled } from "../connection-quality-preference";
import { sampleConnectionQualityTraffic } from "../connection-quality-traffic";
import {
  desktopAppState,
  isDesktopApp,
  onDesktopConnectionQualityAction,
  updateDesktopConnectionQuality,
} from "../desktop";
import { session } from "../session";
import { translate as tr } from "../i18n";
import {
  appendConnectionQualitySample,
  connectionQualityHealth,
  type ConnectionQualityLink,
  type ConnectionQualityOverlayAction,
  type ConnectionQualityOverlayState,
  type ConnectionQualityProbeSample,
  type ConnectionQualitySpeedTestResult,
  type ConnectionQualityTargetLink,
} from "../../shared/connection-quality";
import type { ActiveConnectionItem } from "../../shared/active-connection";
import ConnectionQualityCard from "./ConnectionQualityCard.vue";

interface DragState {
  pointerId?: number;
  cursor: { x: number; y: number };
  origin: ConnectionQualityPosition;
  moved: boolean;
  startsOnControl: boolean;
}

const positionStorageKey = "viron-connection-quality-position";
const desktop = isDesktopApp();
const expanded = ref(false);
const dragging = ref(false);
const suppressWebClick = ref(false);
const testing = ref(false);
const selectedTargetId = ref("");
const speedTest = ref<ConnectionQualitySpeedTestResult | null>(null);
const serviceSamples = ref<ConnectionQualityProbeSample[]>([]);
const clientTraffic = ref({ uploadBytesPerSecond: 0, downloadBytesPerSecond: 0 });
const targetSamples = new Map<string, ConnectionQualityProbeSample[]>();
const viewport = ref<ConnectionQualityViewport>({ width: window.innerWidth, height: window.innerHeight });
const position = ref<ConnectionQualityPosition>(storedPosition(viewport.value));
const overlayState = ref<ConnectionQualityOverlayState | null>(null);
let removeDesktopActionListener: (() => void) | undefined;
let refreshTimer: number | undefined;
let dragState: DragState | null = null;
let refreshRunning = false;

const visible = computed(() => connectionQualityEnabled.value && Boolean(session.user));
const ownConnections = computed(() => activeConnections.items
  .filter((item) => item.ownerId === session.user?.id
    && item.status === "active"
    && (item.executionMode === "server" || (desktop && item.currentExecutionInstance)))
  .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt)));

function currentViewport(): ConnectionQualityViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function defaultPosition(value: ConnectionQualityViewport): ConnectionQualityPosition {
  return clampConnectionQualityPosition({ x: value.width - 350, y: desktop ? 78 : 24 }, value, false);
}

function storedPosition(value: ConnectionQualityViewport): ConnectionQualityPosition {
  try {
    const stored = JSON.parse(localStorage.getItem(positionStorageKey) || "null") as Partial<ConnectionQualityPosition> | null;
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      return clampConnectionQualityPosition({ x: Number(stored.x), y: Number(stored.y) }, value, false);
    }
  } catch {
    // Ignore malformed local state.
  }
  return defaultPosition(value);
}

function persistPosition(): void {
  localStorage.setItem(positionStorageKey, JSON.stringify(position.value));
}

function targetHealth(id: string) {
  return connectionQualityHealth(targetSamples.get(id) ?? []);
}

function targetLink(item: ActiveConnectionItem): ConnectionQualityTargetLink {
  const health = targetHealth(item.id);
  return {
    id: item.id,
    type: item.type,
    executionMode: item.executionMode,
    label: item.label,
    detail: item.environmentNames.join(" · ") || item.label,
    uploadBytesPerSecond: item.traffic?.sentBytesPerSecond ?? 0,
    downloadBytesPerSecond: item.traffic?.receivedBytesPerSecond ?? 0,
    lastActivityAt: item.lastActivityAt,
    ...health,
  };
}

function selectedTarget(targets: ConnectionQualityTargetLink[]): ConnectionQualityTargetLink | null {
  const selected = targets.find((item) => item.id === selectedTargetId.value);
  if (selected) return selected;
  selectedTargetId.value = targets[0]?.id ?? "";
  return targets[0] ?? null;
}

function serviceLink(traffic: { uploadBytesPerSecond: number; downloadBytesPerSecond: number }): ConnectionQualityLink {
  return {
    id: "viron-service",
    label: "Viron",
    detail: desktopAppState.value?.endpoint || window.location.host,
    uploadBytesPerSecond: traffic.uploadBytesPerSecond,
    downloadBytesPerSecond: traffic.downloadBytesPerSecond,
    ...connectionQualityHealth(serviceSamples.value),
  };
}

function buildOverlayState(): ConnectionQualityOverlayState {
  position.value = clampConnectionQualityPosition(position.value, viewport.value, expanded.value);
  const layout = connectionQualityOverlayLayout(position.value, viewport.value, expanded.value);
  const targets = ownConnections.value.map(targetLink);
  return {
    ...layout,
    expanded: expanded.value,
    dragging: dragging.value,
    testing: testing.value,
    service: serviceLink(clientTraffic.value),
    target: selectedTarget(targets),
    targets,
    speedTest: speedTest.value,
  };
}

async function publish(): Promise<void> {
  if (!visible.value) {
    overlayState.value = null;
    if (desktop) await updateDesktopConnectionQuality(null).catch(() => undefined);
    return;
  }
  const state = buildOverlayState();
  overlayState.value = state;
  if (desktop) await updateDesktopConnectionQuality(state).catch(() => undefined);
}

async function refreshMeasurements(): Promise<void> {
  if (!visible.value || refreshRunning) return;
  refreshRunning = true;
  try {
    await loadActiveConnections().catch(() => undefined);
    const activeTargetIds = new Set(ownConnections.value.map((item) => item.id));
    for (const id of targetSamples.keys()) {
      if (!activeTargetIds.has(id)) targetSamples.delete(id);
    }
    try {
      const latencyMs = await probeVironService();
      serviceSamples.value = appendConnectionQualitySample(serviceSamples.value, { at: Date.now(), latencyMs });
    } catch {
      serviceSamples.value = appendConnectionQualitySample(serviceSamples.value, { at: Date.now(), latencyMs: null });
    }
    const targets = ownConnections.value.map(targetLink);
    const target = selectedTarget(targets);
    const targetsToProbe = expanded.value ? targets.slice(0, 10) : target ? [target] : [];
    await Promise.all(targetsToProbe.map(async (item) => {
      let latencyMs: number | null = null;
      try { latencyMs = await probeConnectionTarget(item.id, item.executionMode); } catch { /* Record the failed probe below. */ }
      targetSamples.set(item.id, appendConnectionQualitySample(targetSamples.get(item.id) ?? [], { at: Date.now(), latencyMs }));
    }));
  } finally {
    refreshRunning = false;
    clientTraffic.value = sampleConnectionQualityTraffic();
    await publish();
  }
}

function toggleDetails(): void {
  expanded.value = !expanded.value;
  position.value = clampConnectionQualityPosition(position.value, viewport.value, expanded.value);
  persistPosition();
  void publish();
}

function selectTarget(id: string): void {
  selectedTargetId.value = id;
  void refreshMeasurements();
}

async function runTest(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  await publish();
  try {
    speedTest.value = await runVironSpeedTest();
    await refreshMeasurements();
    ElMessage.success(tr("连接测速完成"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("连接测速失败"));
  } finally {
    testing.value = false;
    await publish();
  }
}

function beginDrag(cursor: { x: number; y: number }, pointerId?: number, startsOnControl = false): void {
  dragState = { pointerId, cursor, origin: { ...position.value }, moved: false, startsOnControl };
}

function moveDrag(cursor: { x: number; y: number }): void {
  if (!dragState) return;
  const deltaX = cursor.x - dragState.cursor.x;
  const deltaY = cursor.y - dragState.cursor.y;
  if (!dragState.moved && Math.hypot(deltaX, deltaY) < 8) return;
  dragState.moved = true;
  dragging.value = true;
  position.value = clampConnectionQualityPosition({
    x: dragState.origin.x + deltaX,
    y: dragState.origin.y + deltaY,
  }, viewport.value, expanded.value);
  void publish();
}

function finishDrag(): DragState | null {
  if (!dragState) return null;
  const completed = dragState;
  dragState = null;
  dragging.value = false;
  if (completed.moved) {
    position.value = snapConnectionQualityPosition(position.value, viewport.value, expanded.value);
    persistPosition();
  }
  void publish();
  return completed;
}

function startsOnControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button"));
}

function suppressClickAfterDrag(): void {
  suppressWebClick.value = true;
  window.setTimeout(() => { suppressWebClick.value = false; }, 0);
}

function guardWebClick(event: MouseEvent): void {
  if (!suppressWebClick.value) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function webPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  beginDrag({ x: event.clientX, y: event.clientY }, event.pointerId, startsOnControl(event.target));
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
}

function webPointerMove(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (!(event.buttons & 1)) {
    finishDrag();
    return;
  }
  moveDrag({ x: event.clientX, y: event.clientY });
  if (dragState?.moved) event.preventDefault();
}

function webPointerUp(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const completed = finishDrag();
  if (completed?.moved) suppressClickAfterDrag();
  else if (completed && !completed.startsOnControl) toggleDetails();
}

function webPointerCancel(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const completed = finishDrag();
  if (completed?.moved) suppressClickAfterDrag();
}

function desktopAction(action: ConnectionQualityOverlayAction): void {
  if (action.type === "toggle-details") return toggleDetails();
  if (action.type === "run-test") return void runTest();
  if (action.type === "select-target") return selectTarget(action.targetId);
  if (!("screenX" in action)) return;
  const cursor = { x: action.screenX, y: action.screenY };
  if (action.type === "drag-start") beginDrag(cursor);
  else if (action.type === "drag-move") moveDrag(cursor);
  else finishDrag();
}

function resize(): void {
  viewport.value = currentViewport();
  position.value = clampConnectionQualityPosition(position.value, viewport.value, expanded.value);
  persistPosition();
  void publish();
}

watch(visible, (value) => {
  window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  if (!value) return void publish();
  void refreshMeasurements();
  refreshTimer = window.setInterval(() => void refreshMeasurements(), 5_000);
}, { immediate: true });

watch(() => activeConnections.items, () => { if (visible.value && !refreshRunning) void publish(); }, { deep: true });

onMounted(() => {
  removeDesktopActionListener = onDesktopConnectionQualityAction(desktopAction);
  window.addEventListener("resize", resize);
  window.addEventListener("blur", finishDrag);
  void publish();
});

onBeforeUnmount(() => {
  removeDesktopActionListener?.();
  window.removeEventListener("resize", resize);
  window.removeEventListener("blur", finishDrag);
  window.clearInterval(refreshTimer);
  if (desktop) void updateDesktopConnectionQuality(null);
});
</script>

<template>
  <ConnectionQualityCard
    v-if="!desktop && overlayState"
    class="connection-quality-web-overlay"
    :style="{ left: `${position.x}px`, top: `${position.y}px` }"
    :state="overlayState"
    @run-test="runTest"
    @select-target="selectTarget"
    @panel-click-capture="guardWebClick"
    @panel-pointerdown="webPointerDown"
    @panel-pointermove="webPointerMove"
    @panel-pointerup="webPointerUp"
    @panel-pointercancel="webPointerCancel"
  />
</template>

<style scoped>
.connection-quality-web-overlay { position: fixed; z-index: 2600; }
@media (max-width: 720px) {
  .connection-quality-web-overlay { transform: scale(.88); transform-origin: top right; }
}
</style>
