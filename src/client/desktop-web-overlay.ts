export interface RectangleBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface RendererOverlayCandidate {
  rect: RectangleBounds;
  ariaHidden: boolean;
  display: string;
  visibility: string;
  ignored: boolean;
}

export function desktopWebBoundsBesideOverlay(
  surface: RectangleBounds,
  overlay: RectangleBounds,
  gap = 8,
  minWidth = 240,
): RectangleBounds | null {
  if (!rendererOverlayCoversSurface(surface, {
    rect: overlay,
    ariaHidden: false,
    display: "block",
    visibility: "visible",
    ignored: false,
  })) return surface;

  const leftRight = Math.min(surface.right, overlay.left - gap);
  const rightLeft = Math.max(surface.left, overlay.right + gap);
  const candidates = [
    {
      left: surface.left,
      right: leftRight,
      top: surface.top,
      bottom: surface.bottom,
      width: leftRight - surface.left,
      height: surface.height,
    },
    {
      left: rightLeft,
      right: surface.right,
      top: surface.top,
      bottom: surface.bottom,
      width: surface.right - rightLeft,
      height: surface.height,
    },
  ].filter((candidate) => candidate.width >= minWidth);

  return candidates.sort((first, second) => second.width - first.width)[0] ?? null;
}

export function desktopWebBoundsAboveOverlay(
  surface: RectangleBounds,
  overlay: RectangleBounds,
  gap = 8,
  minHeight = 160,
): RectangleBounds | null {
  if (!rendererOverlayCoversSurface(surface, {
    rect: overlay,
    ariaHidden: false,
    display: "block",
    visibility: "visible",
    ignored: false,
  })) return surface;

  const bottom = Math.min(surface.bottom, overlay.top - gap);
  const height = bottom - surface.top;
  if (height < minHeight) return null;
  return { ...surface, bottom, height };
}

export function rendererOverlayCoversSurface(
  surface: RectangleBounds,
  overlay: RendererOverlayCandidate,
): boolean {
  if (overlay.ignored
    || overlay.ariaHidden
    || overlay.display === "none"
    || overlay.visibility === "hidden"
    || overlay.rect.width <= 1
    || overlay.rect.height <= 1) return false;

  return overlay.rect.left < surface.right
    && overlay.rect.right > surface.left
    && overlay.rect.top < surface.bottom
    && overlay.rect.bottom > surface.top;
}
