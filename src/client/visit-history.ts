import type { Router } from "vue-router";
import {
  applyVisitHistoryNavigation,
  emptyVisitHistory,
  recordVisitLocation,
  visitHistoryCanMove,
  visitLocationFromRoute,
  visitRouteTarget,
  type VisitHistoryState,
} from "../shared/visit-history";
import type { HistoryNavigationDirection } from "../shared/history-navigation-gesture";

let state: VisitHistoryState = emptyVisitHistory();
let navigating = false;
let routerRef: Router | null = null;

function routeSnapshot(router: Router) {
  const route = router.currentRoute.value;
  return { name: route.name, params: route.params, query: route.query };
}

export function installVisitHistory(router: Router): () => void {
  routerRef = router;
  const stop = router.afterEach((to) => {
    if (navigating) return;
    const location = visitLocationFromRoute({ name: to.name, params: to.params, query: to.query });
    if (location) state = recordVisitLocation(state, location);
  });
  const current = visitLocationFromRoute(routeSnapshot(router));
  if (current) state = recordVisitLocation(state, current);
  return () => {
    stop();
    routerRef = null;
    state = emptyVisitHistory();
    navigating = false;
  };
}

export function visitHistoryCanNavigate(direction: HistoryNavigationDirection): boolean {
  return visitHistoryCanMove(state, direction);
}

export function visitHistoryNavigate(direction: HistoryNavigationDirection): void {
  const result = applyVisitHistoryNavigation(state, direction);
  if (!result || !routerRef) return;
  state = result.state;
  navigating = true;
  const target = visitRouteTarget(result.location, routeSnapshot(routerRef));
  void routerRef.push({
    name: target.name,
    params: target.params,
    query: target.query,
  }).finally(() => {
    navigating = false;
  });
}
