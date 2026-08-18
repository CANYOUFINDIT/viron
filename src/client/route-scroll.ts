import type { RouteLocationNormalized, RouteLocationNormalizedLoaded } from "vue-router";

export type RouteScrollPosition = { left: number; top: number };

export function resolveRouteScrollPosition(
  to: RouteLocationNormalized,
  from: RouteLocationNormalizedLoaded,
  savedPosition: RouteScrollPosition | null,
): RouteScrollPosition | false {
  if (savedPosition) return savedPosition;
  if (from.name != null && to.name === from.name && to.path === from.path) return false;
  return { top: 0, left: 0 };
}
