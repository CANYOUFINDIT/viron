import type { Rectangle } from "electron";

export function resolveWebViewBounds(input: unknown, viewport: { width: number; height: number }): Rectangle | null {
  if (!input || typeof input !== "object") return null;
  const rect = input as Rectangle;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  // The window clips its native children. Changing the page's size to the
  // visible intersection would reflow it on every outer scroll frame.
  const width = Math.max(1, Math.min(viewport.width, Math.round(rect.width)));
  const height = Math.max(1, Math.min(viewport.height, Math.round(rect.height)));
  return {
    x: Math.max(-width, Math.min(viewport.width, Math.round(rect.x))),
    y: Math.max(-height, Math.min(viewport.height, Math.round(rect.y))),
    width,
    height,
  };
}
