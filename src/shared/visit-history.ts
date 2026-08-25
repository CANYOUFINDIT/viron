export type VisitHistoryDirection = "back" | "forward";

export interface VisitLocation {
  name: string;
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface VisitHistoryState {
  entries: VisitLocation[];
  index: number;
}

export interface VisitRouteSnapshot {
  name?: unknown;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
}

export const VISIT_HISTORY_LIMIT = 80;
export const VISIT_QUERY_KEYS = ["tab", "mode", "section"] as const;

const defaultTabByRoute: Record<string, string> = {
  environment: "web",
  "connection-tools": "sync",
};

function stringValue(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === "string" && Boolean(item));
    return first ?? "";
  }
  return "";
}

function pickedRecord(source: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) result[key] = value;
  }
  return result;
}

export function emptyVisitHistory(): VisitHistoryState {
  return { entries: [], index: -1 };
}

export function visitLocationKey(location: VisitLocation): string {
  const params = Object.keys(location.params).sort().map((key) => `${key}=${location.params[key]}`).join("&");
  const query = Object.keys(location.query).sort().map((key) => `${key}=${location.query[key]}`).join("&");
  return `${location.name}|${params}|${query}`;
}

export function visitLocationsEqual(left: VisitLocation, right: VisitLocation): boolean {
  return visitLocationKey(left) === visitLocationKey(right);
}

export function visitLocationFromRoute(route: VisitRouteSnapshot): VisitLocation | null {
  const name = typeof route.name === "string" ? route.name : "";
  if (!name || name === "login") return null;
  const params = pickedRecord(route.params, ["id", "token"]);
  const query = pickedRecord(route.query, VISIT_QUERY_KEYS);
  const defaultTab = defaultTabByRoute[name];
  if (defaultTab && !query.tab) query.tab = defaultTab;
  return { name, params, query };
}

export function recordVisitLocation(state: VisitHistoryState, location: VisitLocation): VisitHistoryState {
  const current = state.entries[state.index];
  if (current && visitLocationsEqual(current, location)) return state;
  const entries = [...state.entries.slice(0, state.index + 1), location].slice(-VISIT_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

export function visitHistoryCanMove(state: VisitHistoryState, direction: VisitHistoryDirection): boolean {
  if (direction === "back") return state.index > 0;
  return state.index >= 0 && state.index < state.entries.length - 1;
}

export function applyVisitHistoryNavigation(
  state: VisitHistoryState,
  direction: VisitHistoryDirection,
): { state: VisitHistoryState; location: VisitLocation } | null {
  if (!visitHistoryCanMove(state, direction)) return null;
  const index = state.index + (direction === "back" ? -1 : 1);
  return { state: { ...state, index }, location: state.entries[index] };
}

export function visitRouteTarget(
  location: VisitLocation,
  current: VisitRouteSnapshot,
): { name: string; params: Record<string, string>; query: Record<string, string> } {
  const currentName = typeof current.name === "string" ? current.name : "";
  const currentParams = pickedRecord(current.params, ["id", "token"]);
  const samePage = currentName === location.name
    && (location.params.id ?? "") === (currentParams.id ?? "")
    && (location.params.token ?? "") === (currentParams.token ?? "");
  if (!samePage) return { name: location.name, params: location.params, query: location.query };

  const query = Object.fromEntries(
    Object.entries(current.query).flatMap(([key, value]) => {
      if ((VISIT_QUERY_KEYS as readonly string[]).includes(key)) return [];
      const text = stringValue(value);
      return text ? [[key, text]] : [];
    }),
  );
  return { name: location.name, params: location.params, query: { ...query, ...location.query } };
}
