export type AgentFloatingOverlayEdge = "left" | "right" | "top" | "bottom";

export interface AgentFloatingOverlayState {
  bounds: { x: number; y: number; width: number; height: number };
  rootOffset: { x: number; y: number };
  open: boolean;
  running: boolean;
  dragging: boolean;
  edgeCollapsed: boolean;
  snappedEdge: AgentFloatingOverlayEdge | null;
  label: string;
  interactionLayer?: boolean;
}

export type AgentFloatingOverlayAction =
  | { type: "toggle" }
  | { type: "expand" }
  | { type: "drag-start" | "drag-move" | "drag-end"; screenX: number; screenY: number };

const buttonSize = 64;
const collapsedOffset = 54;
const edgeToggleWidth = 28;
const edgeToggleHeight = 34;

interface Point {
  x: number;
  y: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function edgeTranslation(edge: AgentFloatingOverlayEdge | null): Point {
  return {
    x: edge === "left" ? -collapsedOffset : edge === "right" ? collapsedOffset : 0,
    y: edge === "top" ? -collapsedOffset : edge === "bottom" ? collapsedOffset : 0,
  };
}

function controlRects(state: AgentFloatingOverlayState): Rect[] {
  const edge = state.edgeCollapsed ? state.snappedEdge : null;
  const translation = edgeTranslation(edge);
  const buttonLeft = state.rootOffset.x + translation.x;
  const buttonTop = state.rootOffset.y + translation.y;
  const rects: Rect[] = [{
    left: buttonLeft,
    top: buttonTop,
    right: buttonLeft + buttonSize,
    bottom: buttonTop + buttonSize,
  }];
  if (!edge) return rects;

  const toggleLeft = state.rootOffset.x + translation.x + (edge === "right" ? -36 : edge === "left" ? 72 : 15);
  const toggleTop = state.rootOffset.y + translation.y + (edge === "top" ? 72 : edge === "bottom" ? -42 : 15);
  rects.push({
    left: toggleLeft,
    top: toggleTop,
    right: toggleLeft + edgeToggleWidth,
    bottom: toggleTop + edgeToggleHeight,
  });
  return rects;
}

export function agentFloatingOverlayInteractionState(state: AgentFloatingOverlayState): AgentFloatingOverlayState {
  const rects = controlRects(state);
  const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)));
  const top = Math.max(0, Math.min(...rects.map((rect) => rect.top)));
  const right = Math.min(state.bounds.width, Math.max(...rects.map((rect) => rect.right)));
  const bottom = Math.min(state.bounds.height, Math.max(...rects.map((rect) => rect.bottom)));
  return {
    ...state,
    interactionLayer: true,
    bounds: {
      x: state.bounds.x + left,
      y: state.bounds.y + top,
      width: right - left,
      height: bottom - top,
    },
    rootOffset: {
      x: state.rootOffset.x - left,
      y: state.rootOffset.y - top,
    },
  };
}
