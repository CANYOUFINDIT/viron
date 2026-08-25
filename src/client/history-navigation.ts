import { shallowRef } from "vue";
import {
  HISTORY_NAVIGATION_BLOCKED_SELECTOR,
  defaultHistoryNavigationGestureConfig,
  elementCanScrollHistoryDirection,
  historyNavigationFromMouseButton,
  historyNavigationProgress,
  idleHistoryNavigationGesture,
  reduceHistoryNavigationWheel,
  settleHistoryNavigationGesture,
  type HistoryNavigationDirection,
  type HistoryNavigationGestureState,
} from "../shared/history-navigation-gesture";
import { onDesktopHistoryNavigation, onDesktopHistoryNavigationTouch } from "./desktop";

export interface HistoryNavigationOverlayView {
  direction: HistoryNavigationDirection;
  progress: number;
  available: boolean;
}

export const historyNavigationOverlay = shallowRef<HistoryNavigationOverlayView | null>(null);

interface HistoryNavigationController {
  canNavigate(direction: HistoryNavigationDirection): boolean;
  navigate(direction: HistoryNavigationDirection): void;
}

let gesture = idleHistoryNavigationGesture();
let idleTimer: number | undefined;
let hideTimer: number | undefined;
let controller: HistoryNavigationController | null = null;
let lastNavigationAt = 0;
let holdUntilRelease = false;
const navigationCooldownMs = 420;

function overlayFromGesture(state: HistoryNavigationGestureState, available: boolean): HistoryNavigationOverlayView | null {
  if (!state.direction || state.status === "idle") return null;
  const progress = historyNavigationProgress(state);
  if (progress < 0.02 && state.status === "pending") return null;
  return { direction: state.direction, progress: state.status === "committed" ? 1 : Math.max(progress, 0.18), available };
}

function clearIdleTimer() {
  window.clearTimeout(idleTimer);
  idleTimer = undefined;
}

function clearHideTimer() {
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
}

function resetGesture(time = performance.now()) {
  clearIdleTimer();
  holdUntilRelease = false;
  gesture = idleHistoryNavigationGesture(time);
  historyNavigationOverlay.value = null;
}

function finishHeldGesture(time = performance.now()) {
  if (gesture.status === "committed") return;
  const settled = settleHistoryNavigationGesture(gesture, time);
  if (settled.status === "committed" && settled.direction) {
    gesture = settled;
    commitNavigation(settled.direction);
    return;
  }
  resetGesture(time);
}

function scheduleIdleReset(time: number) {
  if (holdUntilRelease) return;
  clearIdleTimer();
  idleTimer = window.setTimeout(() => {
    if (holdUntilRelease || gesture.status === "committed") return;
    finishHeldGesture(time + defaultHistoryNavigationGestureConfig.idleMs);
  }, defaultHistoryNavigationGestureConfig.idleMs);
}

export function applyHistoryNavigationTouch(phase: "begin" | "end") {
  if (phase === "begin") {
    holdUntilRelease = true;
    clearIdleTimer();
    return;
  }
  holdUntilRelease = false;
  finishHeldGesture();
}

export function showHistoryNavigationOverlay(view: HistoryNavigationOverlayView | null) {
  clearHideTimer();
  historyNavigationOverlay.value = view;
}

export function flashHistoryNavigationOverlay(direction: HistoryNavigationDirection, available = true) {
  showHistoryNavigationOverlay({ direction, progress: 1, available });
  hideTimer = window.setTimeout(() => {
    if (historyNavigationOverlay.value?.direction === direction) historyNavigationOverlay.value = null;
  }, 180);
}

function commitNavigation(direction: HistoryNavigationDirection) {
  const now = performance.now();
  const available = controller?.canNavigate(direction) ?? false;
  showHistoryNavigationOverlay({ direction, progress: 1, available });
  if (available && now - lastNavigationAt >= navigationCooldownMs) {
    lastNavigationAt = now;
    controller?.navigate(direction);
  }
  hideTimer = window.setTimeout(() => {
    resetGesture(performance.now());
  }, 180);
}

export function applyHistoryNavigationWheel(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "shiftKey" | "target">,
  time = performance.now(),
  options?: { ignoreBlockedTargets?: boolean },
): HistoryNavigationGestureState {
  const next = reduceHistoryNavigationWheel(gesture, {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    holding: holdUntilRelease,
    time,
  });
  const direction = next.direction;
  if (direction && !options?.ignoreBlockedTargets) {
    if (historyNavigationBlockedByEventTarget(event.target)) {
      resetGesture(time);
      return gesture;
    }
    if (historyNavigationBlockedByScrollTarget(event.target, direction)) {
      resetGesture(time);
      return gesture;
    }
  }
  gesture = next;
  if (gesture.status === "idle") {
    historyNavigationOverlay.value = null;
    return gesture;
  }
  const available = gesture.direction ? controller?.canNavigate(gesture.direction) ?? true : true;
  historyNavigationOverlay.value = overlayFromGesture(gesture, available);
  scheduleIdleReset(time);
  return gesture;
}

export function applyHistoryNavigationCommand(direction: HistoryNavigationDirection) {
  gesture = { status: "committed", direction, distance: defaultHistoryNavigationGestureConfig.commitDistance, lastEventAt: performance.now() };
  commitNavigation(direction);
}

export function historyNavigationBlockedByEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(HISTORY_NAVIGATION_BLOCKED_SELECTOR));
}

export function historyNavigationBlockedByScrollTarget(target: EventTarget | null, direction: HistoryNavigationDirection): boolean {
  let node: Element | null = target instanceof Element ? target : null;
  while (node) {
    if (elementCanScrollHistoryDirection(node, direction)) return true;
    node = node.parentElement;
  }
  return false;
}

export function appHistoryCanNavigate(direction: HistoryNavigationDirection): boolean {
  const state = window.history.state as { back?: unknown; forward?: unknown } | null;
  if (direction === "back") return state?.back != null && state.back !== "";
  return state?.forward != null && state.forward !== "";
}

export function installHistoryNavigationGestures(next: HistoryNavigationController): () => void {
  controller = next;
  const fromEmbeddedWeb = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".web-account-browser"));
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || fromEmbeddedWeb(event.target)) return;
    const previous = gesture.status;
    const nextState = applyHistoryNavigationWheel(event);
    if (nextState.status === "armed" || nextState.status === "committed" || (previous !== "idle" && nextState.status === "pending")) {
      event.preventDefault();
    }
  };
  const onMouseDown = (event: MouseEvent) => {
    const direction = historyNavigationFromMouseButton(event.button);
    if (!direction || fromEmbeddedWeb(event.target)) return;
    event.preventDefault();
  };
  const onMouseUp = (event: MouseEvent) => {
    const direction = historyNavigationFromMouseButton(event.button);
    if (!direction || fromEmbeddedWeb(event.target)) return;
    event.preventDefault();
    applyHistoryNavigationCommand(direction);
  };
  const stopDesktop = onDesktopHistoryNavigation((direction) => applyHistoryNavigationCommand(direction));
  const stopDesktopTouch = onDesktopHistoryNavigationTouch((phase) => applyHistoryNavigationTouch(phase));
  const onAuxClick = (event: MouseEvent) => {
    if (!historyNavigationFromMouseButton(event.button) || fromEmbeddedWeb(event.target)) return;
    event.preventDefault();
  };
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("auxclick", onAuxClick, true);
  return () => {
    stopDesktop();
    stopDesktopTouch();
    window.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("auxclick", onAuxClick, true);
    controller = null;
    resetGesture();
    clearHideTimer();
  };
}
