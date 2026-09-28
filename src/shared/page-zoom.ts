/** Chrome preset page-zoom factors, from 25% through 500%. */
export const PAGE_ZOOM_FACTORS = [
  0.25,
  1 / 3,
  0.5,
  2 / 3,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
  4,
  5,
] as const;

const PAGE_ZOOM_LABELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500] as const;

export const PAGE_ZOOM_WHEEL_THRESHOLD = 100;
export const PAGE_ZOOM_WHEEL_STEP_LIMIT = 3;

export type PageZoomCommand = "in" | "out" | "reset";

export interface PageZoomKeyInput {
  key: string;
  code?: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

export interface PageZoomWheelInput {
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  deltaX: number;
  deltaY: number;
}

export interface PageZoomTarget {
  id: string;
  visible: boolean;
  closing: boolean;
  closedReason: string;
  lastActivityAt: number;
  hasActivePage: boolean;
}

export function pageZoomIndex(factor: number): number {
  const value = Number.isFinite(factor) && factor > 0 ? factor : 1;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < PAGE_ZOOM_FACTORS.length; index += 1) {
    const distance = Math.abs(PAGE_ZOOM_FACTORS[index] - value);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

export function pageZoomFactor(factor: number): number {
  return PAGE_ZOOM_FACTORS[pageZoomIndex(factor)];
}

export function pageZoomLabel(factor: number): string {
  return `${PAGE_ZOOM_LABELS[pageZoomIndex(factor)]}%`;
}

export function stepPageZoom(factor: number, command: PageZoomCommand): number {
  const index = pageZoomIndex(factor);
  if (command === "reset") return 1;
  if (command === "in") return PAGE_ZOOM_FACTORS[Math.min(PAGE_ZOOM_FACTORS.length - 1, index + 1)];
  return PAGE_ZOOM_FACTORS[Math.max(0, index - 1)];
}

/** Positive steps zoom out, matching Chrome: wheel down and pinch-close. */
export function stepPageZoomBy(factor: number, steps: number): number {
  if (!Number.isFinite(steps) || steps === 0) return pageZoomFactor(factor);
  const command: PageZoomCommand = steps > 0 ? "out" : "in";
  let next = pageZoomFactor(factor);
  const count = Math.min(PAGE_ZOOM_FACTORS.length, Math.abs(Math.trunc(steps)));
  for (let index = 0; index < count; index += 1) next = stepPageZoom(next, command);
  return next;
}

export function pageZoomOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function desktopWebZoomStorageKey(scope: string, origin: string): string {
  return `${scope}\n${origin}`;
}

export function pageZoomCommandFromKey(input: PageZoomKeyInput): PageZoomCommand | null {
  if (input.alt || (!input.meta && !input.control)) return null;
  const code = input.code ?? "";
  if (!input.shift && (input.key === "0" || code === "Digit0" || code === "Numpad0")) return "reset";
  if (input.key === "+" || input.key === "=" || code === "Equal" || code === "NumpadAdd") return "in";
  if (input.key === "-" || input.key === "_" || code === "Minus" || code === "NumpadSubtract") return "out";
  return null;
}

export function pageZoomWheelShouldHandle(input: PageZoomWheelInput): boolean {
  if (input.alt || input.shift || (!input.control && !input.meta)) return false;
  if (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)) return false;
  return Math.abs(input.deltaY) > 0 && Math.abs(input.deltaY) >= Math.abs(input.deltaX);
}

export function reducePageZoomWheel(
  accumulated: number,
  deltaY: number,
  threshold = PAGE_ZOOM_WHEEL_THRESHOLD,
): { accumulated: number; steps: number } {
  const base = Number.isFinite(accumulated) ? accumulated : 0;
  if (!Number.isFinite(deltaY) || deltaY === 0 || threshold <= 0) return { accumulated: base, steps: 0 };
  const next = base + deltaY;
  const rawSteps = Math.trunc(next / threshold);
  if (rawSteps === 0) return { accumulated: next, steps: 0 };
  return {
    accumulated: next - rawSteps * threshold,
    steps: Math.max(-PAGE_ZOOM_WHEEL_STEP_LIMIT, Math.min(PAGE_ZOOM_WHEEL_STEP_LIMIT, rawSteps)),
  };
}

export function selectPageZoomTarget<T extends PageZoomTarget>(views: readonly T[], targetId: string): T | null {
  const visible = views.filter((view) => view.visible && !view.closing && !view.closedReason && view.hasActivePage);
  return visible.find((view) => view.id === targetId)
    ?? [...visible].sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0]
    ?? null;
}
