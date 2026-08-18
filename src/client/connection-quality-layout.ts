import {
  CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT,
  CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT,
  CONNECTION_QUALITY_PANEL_WIDTH,
} from "../shared/connection-quality";

export interface ConnectionQualityPosition { x: number; y: number }
export interface ConnectionQualityViewport { width: number; height: number }

const margin = 16;
const overlayPadding = 36;
const snapDistance = 72;

export function connectionQualityPanelSize(expanded: boolean) {
  return {
    width: CONNECTION_QUALITY_PANEL_WIDTH,
    height: expanded ? CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT : CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT,
  };
}

export function clampConnectionQualityPosition(
  position: ConnectionQualityPosition,
  viewport: ConnectionQualityViewport,
  expanded: boolean,
): ConnectionQualityPosition {
  const size = connectionQualityPanelSize(expanded);
  return {
    x: Math.min(Math.max(margin, position.x), Math.max(margin, viewport.width - size.width - margin)),
    y: Math.min(Math.max(margin, position.y), Math.max(margin, viewport.height - size.height - margin)),
  };
}

export function snapConnectionQualityPosition(
  position: ConnectionQualityPosition,
  viewport: ConnectionQualityViewport,
  expanded: boolean,
): ConnectionQualityPosition {
  const clamped = clampConnectionQualityPosition(position, viewport, expanded);
  const size = connectionQualityPanelSize(expanded);
  const distances = [
    { edge: "left", distance: clamped.x },
    { edge: "right", distance: viewport.width - clamped.x - size.width },
    { edge: "top", distance: clamped.y },
    { edge: "bottom", distance: viewport.height - clamped.y - size.height },
  ].sort((left, right) => left.distance - right.distance);
  const nearest = distances[0]!;
  if (nearest.distance > snapDistance) return clamped;
  if (nearest.edge === "left") return { ...clamped, x: margin };
  if (nearest.edge === "right") return { ...clamped, x: Math.max(margin, viewport.width - size.width - margin) };
  if (nearest.edge === "top") return { ...clamped, y: margin };
  return { ...clamped, y: Math.max(margin, viewport.height - size.height - margin) };
}

export function connectionQualityOverlayLayout(
  position: ConnectionQualityPosition,
  viewport: ConnectionQualityViewport,
  expanded: boolean,
) {
  const panelSize = connectionQualityPanelSize(expanded);
  const left = Math.max(0, position.x - overlayPadding);
  const top = Math.max(0, position.y - overlayPadding);
  const right = Math.min(viewport.width, position.x + panelSize.width + overlayPadding);
  const bottom = Math.min(viewport.height, position.y + panelSize.height + overlayPadding);
  return {
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    rootOffset: { x: position.x - left, y: position.y - top },
    panelSize,
  };
}
