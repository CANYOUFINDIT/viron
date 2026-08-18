import { AGENT_FLOATING_BUTTON_SIZE, type AgentFloatingEdge, type AgentFloatingPosition, type AgentFloatingViewport } from "./agent-floating-position";

// Chromium can paint the launcher's 70px glow beyond its nominal blur radius.
// Keep the transparent native window far enough away that the glow fades out
// before reaching a rectangular window edge.
const overlayPadding = 112;
const collapsedOffset = 54;
const edgeToggleWidth = 28;
const edgeToggleHeight = 34;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function buttonRect(position: AgentFloatingPosition, edge: AgentFloatingEdge | null): Rect {
  const { x: translateX, y: translateY } = edgeTranslation(edge);
  const x = position.x + translateX;
  const y = position.y + translateY;
  return { left: x, top: y, right: x + AGENT_FLOATING_BUTTON_SIZE, bottom: y + AGENT_FLOATING_BUTTON_SIZE };
}

function edgeTranslation(edge: AgentFloatingEdge | null): AgentFloatingPosition {
  return {
    x: edge === "left" ? -collapsedOffset : edge === "right" ? collapsedOffset : 0,
    y: edge === "top" ? -collapsedOffset : edge === "bottom" ? collapsedOffset : 0,
  };
}

function edgeToggleRect(position: AgentFloatingPosition, edge: AgentFloatingEdge): Rect {
  const { x: translateX, y: translateY } = edgeTranslation(edge);
  const left = position.x + translateX + (edge === "right" ? -36 : edge === "left" ? 72 : 15);
  const top = position.y + translateY + (edge === "top" ? 72 : edge === "bottom" ? -42 : 15);
  return { left, top, right: left + edgeToggleWidth, bottom: top + edgeToggleHeight };
}

export function agentFloatingOverlayLayout(
  position: AgentFloatingPosition,
  viewport: AgentFloatingViewport,
  edge: AgentFloatingEdge | null,
): { bounds: { x: number; y: number; width: number; height: number }; rootOffset: AgentFloatingPosition } {
  const rects = [buttonRect(position, edge)];
  if (edge) rects.push(edgeToggleRect(position, edge));
  const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)) - overlayPadding);
  const top = Math.max(0, Math.min(...rects.map((rect) => rect.top)) - overlayPadding);
  const right = Math.min(viewport.width, Math.max(...rects.map((rect) => rect.right)) + overlayPadding);
  const bottom = Math.min(viewport.height, Math.max(...rects.map((rect) => rect.bottom)) + overlayPadding);
  return {
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    rootOffset: { x: position.x - left, y: position.y - top },
  };
}
