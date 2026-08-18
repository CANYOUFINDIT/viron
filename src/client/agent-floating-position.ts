export type AgentFloatingEdge = "left" | "right" | "top" | "bottom";

export interface AgentFloatingPosition {
  x: number;
  y: number;
}

export interface AgentFloatingViewport {
  width: number;
  height: number;
}

export const AGENT_FLOATING_BUTTON_SIZE = 64;
export const AGENT_FLOATING_MARGIN = 16;
export const AGENT_FLOATING_SNAP_DISTANCE = 72;
export const AGENT_FLOATING_DRAG_THRESHOLD = 8;

export function agentFloatingDragMoved(
  start: AgentFloatingPosition,
  current: AgentFloatingPosition,
  threshold = AGENT_FLOATING_DRAG_THRESHOLD,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}

function axisBounds(viewportSize: number, buttonSize: number, margin: number) {
  const lastVisibleCoordinate = Math.max(0, viewportSize - buttonSize);
  const start = Math.min(margin, lastVisibleCoordinate);
  return { start, end: Math.max(start, lastVisibleCoordinate - margin) };
}

export function clampAgentFloatingPosition(
  position: AgentFloatingPosition,
  viewport: AgentFloatingViewport,
  buttonSize = AGENT_FLOATING_BUTTON_SIZE,
  margin = AGENT_FLOATING_MARGIN,
): AgentFloatingPosition {
  const horizontal = axisBounds(viewport.width, buttonSize, margin);
  const vertical = axisBounds(viewport.height, buttonSize, margin);
  return {
    x: Math.min(Math.max(position.x, horizontal.start), horizontal.end),
    y: Math.min(Math.max(position.y, vertical.start), vertical.end),
  };
}

export function nearestAgentFloatingEdge(
  position: AgentFloatingPosition,
  viewport: AgentFloatingViewport,
  buttonSize = AGENT_FLOATING_BUTTON_SIZE,
): { edge: AgentFloatingEdge; distance: number } {
  const distances: Array<{ edge: AgentFloatingEdge; distance: number }> = [
    { edge: "left", distance: position.x },
    { edge: "right", distance: viewport.width - position.x - buttonSize },
    { edge: "top", distance: position.y },
    { edge: "bottom", distance: viewport.height - position.y - buttonSize },
  ];
  return distances.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest);
}

export function agentFloatingSnapEdge(
  position: AgentFloatingPosition,
  viewport: AgentFloatingViewport,
  threshold = AGENT_FLOATING_SNAP_DISTANCE,
): AgentFloatingEdge | null {
  const nearest = nearestAgentFloatingEdge(position, viewport);
  return nearest.distance <= threshold ? nearest.edge : null;
}

export function snapAgentFloatingPosition(
  position: AgentFloatingPosition,
  edge: AgentFloatingEdge,
  viewport: AgentFloatingViewport,
  buttonSize = AGENT_FLOATING_BUTTON_SIZE,
  margin = AGENT_FLOATING_MARGIN,
): AgentFloatingPosition {
  const clamped = clampAgentFloatingPosition(position, viewport, buttonSize, margin);
  const horizontal = axisBounds(viewport.width, buttonSize, margin);
  const vertical = axisBounds(viewport.height, buttonSize, margin);
  if (edge === "left") return { ...clamped, x: horizontal.start };
  if (edge === "right") return { ...clamped, x: horizontal.end };
  if (edge === "top") return { ...clamped, y: vertical.start };
  return { ...clamped, y: vertical.end };
}
