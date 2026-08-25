export type HistoryNavigationDirection = "back" | "forward";

export interface HistoryNavigationGestureConfig {
  axisRatio: number;
  armDistance: number;
  commitDistance: number;
  idleMs: number;
}

export const defaultHistoryNavigationGestureConfig: HistoryNavigationGestureConfig = {
  axisRatio: 1.75,
  armDistance: 40,
  commitDistance: 108,
  idleMs: 140,
};

export interface HistoryNavigationGestureState {
  status: "idle" | "pending" | "armed" | "committed";
  direction: HistoryNavigationDirection | null;
  distance: number;
  lastEventAt: number;
}

export interface HistoryNavigationSurface {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HistoryNavigationHandleBounds extends HistoryNavigationSurface {}

export const HISTORY_NAVIGATION_HANDLE_SIZE = { width: 48, height: 80 };
export const HISTORY_NAVIGATION_SURFACE_SELECTOR = ".app-content";

export const HISTORY_NAVIGATION_BLOCKED_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  ".monaco-editor",
  ".el-dialog",
  ".el-drawer",
  ".el-message-box__wrapper",
].join(",");

export function idleHistoryNavigationGesture(time = 0): HistoryNavigationGestureState {
  return { status: "idle", direction: null, distance: 0, lastEventAt: time };
}

export function historyNavigationProgress(
  state: HistoryNavigationGestureState,
  config: HistoryNavigationGestureConfig = defaultHistoryNavigationGestureConfig,
): number {
  if (!state.direction || state.status === "idle") return 0;
  return Math.min(1, state.distance / config.commitDistance);
}

export function historyNavigationDirectionFromDeltaX(deltaX: number): HistoryNavigationDirection | null {
  if (deltaX < 0) return "back";
  if (deltaX > 0) return "forward";
  return null;
}

export function historyNavigationFromSwipeDirection(direction: string): HistoryNavigationDirection | null {
  if (direction === "right") return "back";
  if (direction === "left") return "forward";
  return null;
}

export function historyNavigationFromAppCommand(command: string): HistoryNavigationDirection | null {
  if (command === "browser-backward") return "back";
  if (command === "browser-forward") return "forward";
  return null;
}

export function historyNavigationFromMouseButton(button: number | string | null | undefined): HistoryNavigationDirection | null {
  if (button === 3 || button === "back") return "back";
  if (button === 4 || button === "forward") return "forward";
  return null;
}

export function reduceHistoryNavigationWheel(
  state: HistoryNavigationGestureState,
  input: {
    deltaX: number;
    deltaY: number;
    deltaMode?: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    holding?: boolean;
    time: number;
  },
  config: HistoryNavigationGestureConfig = defaultHistoryNavigationGestureConfig,
): HistoryNavigationGestureState {
  if (input.ctrlKey || input.shiftKey || (input.deltaMode ?? 0) !== 0) {
    return idleHistoryNavigationGesture(input.time);
  }
  if (state.status === "committed") {
    if (input.time - state.lastEventAt > config.idleMs) return idleHistoryNavigationGesture(input.time);
    return { ...state, lastEventAt: input.time };
  }
  if (!input.holding && state.status !== "idle" && input.time - state.lastEventAt > config.idleMs) {
    state = idleHistoryNavigationGesture(input.time);
  }

  const absX = Math.abs(input.deltaX);
  const absY = Math.abs(input.deltaY);
  if (absX < 0.5 && absY < 0.5) return { ...state, lastEventAt: input.time };
  const axisFloor = state.status === "idle" ? config.axisRatio : 0.85;
  if (absX <= absY * axisFloor) return idleHistoryNavigationGesture(input.time);

  const direction = historyNavigationDirectionFromDeltaX(input.deltaX);
  if (!direction) return state;
  if (state.direction && state.direction !== direction) return idleHistoryNavigationGesture(input.time);

  const distance = (state.direction ? state.distance : 0) + absX;
  const status = distance >= config.commitDistance ? "armed" : "pending";
  return { status, direction, distance, lastEventAt: input.time };
}

export function settleHistoryNavigationGesture(
  state: HistoryNavigationGestureState,
  time = state.lastEventAt,
  config: HistoryNavigationGestureConfig = defaultHistoryNavigationGestureConfig,
): HistoryNavigationGestureState {
  if (state.status === "committed") return state;
  if (state.direction && state.distance >= config.commitDistance) {
    return { status: "committed", direction: state.direction, distance: state.distance, lastEventAt: time };
  }
  return idleHistoryNavigationGesture(time);
}

export function historyNavigationHandleBounds(
  direction: HistoryNavigationDirection,
  progress: number,
  surface: HistoryNavigationSurface,
  size = HISTORY_NAVIGATION_HANDLE_SIZE,
): HistoryNavigationHandleBounds {
  const amount = Math.min(1, Math.max(0, progress));
  const y = Math.round(surface.y + Math.max(0, (surface.height - size.height) / 2));
  if (direction === "back") {
    return {
      x: Math.round(surface.x - size.width * (1 - amount)),
      y,
      width: size.width,
      height: size.height,
    };
  }
  return {
    x: Math.round(surface.x + surface.width - size.width * amount),
    y,
    width: size.width,
    height: size.height,
  };
}

export function elementCanScrollHistoryDirection(
  element: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  direction: HistoryNavigationDirection,
): boolean {
  if (element.scrollWidth <= element.clientWidth + 1) return false;
  if (direction === "back") return element.scrollLeft > 1;
  return element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

export function historyNavigationBlockedBySelector(target: { closest(selector: string): unknown } | null | undefined): boolean {
  return Boolean(target?.closest(HISTORY_NAVIGATION_BLOCKED_SELECTOR));
}

export const HISTORY_NAVIGATION_SCROLL_PROBE = `function(direction) {
  const back = direction === "back";
  const seen = new Set();
  const candidates = [];
  const add = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    candidates.push(node);
  };
  add(document.scrollingElement);
  add(document.documentElement);
  add(document.body);
  for (const node of document.querySelectorAll("*")) {
    const overflowX = node instanceof Element ? getComputedStyle(node).overflowX : "";
    if (overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay") add(node);
    if (candidates.length >= 48) break;
  }
  for (const node of candidates) {
    if (!node || node.scrollWidth <= node.clientWidth + 1) continue;
    if (back && node.scrollLeft > 1) return true;
    if (!back && node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
  }
  return false;
}`;
