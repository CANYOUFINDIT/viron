import type { ActiveConnectionItem, ActiveConnectionType } from "./active-connection.js";
import type { Language } from "./i18n.js";

export interface ActiveEnvironmentDockPosition {
  x: number;
  y: number;
}

export interface ActiveEnvironmentDockViewport {
  width: number;
  height: number;
}

export interface ActiveEnvironmentDockConnection {
  id: string;
  type: ActiveConnectionType;
  label: string;
  resourceId: string;
  executionMode: "server" | "local";
  lastActivityAt: string;
  status: "active" | "closing";
}

export interface ActiveEnvironmentDockPreview {
  dataUrl: string;
  updatedAt: number;
}

export interface ActiveEnvironmentDockEnvironment {
  id: string;
  name: string;
  lastActivityAt: string;
  connections: ActiveEnvironmentDockConnection[];
  preview?: ActiveEnvironmentDockPreview;
}

export interface ActiveEnvironmentDockState {
  bounds: { x: number; y: number; width: number; height: number };
  card: { width: number; height: number };
  expanded: boolean;
  growUp: boolean;
  dragging: boolean;
  dark: boolean;
  language: Language;
  environments: ActiveEnvironmentDockEnvironment[];
}

export interface ActiveEnvironmentDockLayoutState {
  bounds: ActiveEnvironmentDockState["bounds"];
  card: ActiveEnvironmentDockState["card"];
  expanded: boolean;
  growUp: boolean;
  dragging: boolean;
}

export function activeEnvironmentDockLayoutSnapshot(state: ActiveEnvironmentDockState): ActiveEnvironmentDockLayoutState {
  return {
    bounds: { ...state.bounds },
    card: { ...state.card },
    expanded: state.expanded,
    growUp: state.growUp,
    dragging: state.dragging,
  };
}

export function activeEnvironmentDockStateSnapshot(state: ActiveEnvironmentDockState | null): ActiveEnvironmentDockState | null {
  if (!state) return null;
  return {
    ...activeEnvironmentDockLayoutSnapshot(state),
    dark: state.dark,
    language: state.language,
    environments: state.environments.map((environment) => ({
      id: environment.id,
      name: environment.name,
      lastActivityAt: environment.lastActivityAt,
      connections: environment.connections.map((connection) => ({ ...connection })),
      ...(environment.preview ? { preview: { ...environment.preview } } : {}),
    })),
  };
}

export type ActiveEnvironmentDockDragAction = {
  type: "drag-start" | "drag-move" | "drag-end";
  screenX: number;
  screenY: number;
};

export type ActiveEnvironmentDockAction =
  | { type: "expand" | "collapse" | "toggle" }
  | { type: "open-environment"; environmentId: string; origin?: { x: number; y: number; width: number; height: number } }
  | { type: "close-environment"; environmentId: string }
  | { type: "position"; x: number; y: number }
  | ActiveEnvironmentDockDragAction;

export interface ActiveEnvironmentDockScope {
  ownerId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  desktop: boolean;
  rememberedEnvironmentIds?: Readonly<Record<string, string>>;
}

export const ACTIVE_ENVIRONMENT_DOCK_CARD_WIDTH = 320;
export const ACTIVE_ENVIRONMENT_DOCK_CARD_ASPECT_RATIO = 16 / 9;
export const ACTIVE_ENVIRONMENT_DOCK_CARD_GAP = 8;
export const ACTIVE_ENVIRONMENT_DOCK_COLLAPSE_DELAY_MS = 240;
export const ACTIVE_ENVIRONMENT_DOCK_TRANSITION_MS = 220;
export const ACTIVE_ENVIRONMENT_DOCK_LAYER_X = 6;
export const ACTIVE_ENVIRONMENT_DOCK_LAYER_Y = 10;
export const ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH = 3;
export const ACTIVE_ENVIRONMENT_DOCK_PADDING = 4;
export const ACTIVE_ENVIRONMENT_DOCK_MAX_HEIGHT = 640;
export const ACTIVE_ENVIRONMENT_DOCK_MARGIN = 16;

export function activeEnvironmentDockPointInsideBounds(
  point: ActiveEnvironmentDockPosition,
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

function environmentIdForConnection(
  item: ActiveConnectionItem,
  rememberedEnvironmentIds: Readonly<Record<string, string>>,
): string | null {
  const remembered = rememberedEnvironmentIds[item.id];
  if (item.originEnvironmentId) return item.originEnvironmentId;
  if (remembered && item.environmentIds.includes(remembered)) return remembered;
  if (["web", "logs"].includes(item.type) && item.environmentIds.length === 1) return item.environmentIds[0]!;
  return null;
}

function environmentName(item: ActiveConnectionItem, environmentId: string): string {
  const index = item.environmentIds.indexOf(environmentId);
  return index >= 0 ? item.environmentNames[index] || environmentId : environmentId;
}

export function activeEnvironmentDockEnvironments(
  items: readonly ActiveConnectionItem[],
  scope: ActiveEnvironmentDockScope,
): ActiveEnvironmentDockEnvironment[] {
  const rememberedEnvironmentIds = scope.rememberedEnvironmentIds ?? {};
  const environments = new Map<string, ActiveEnvironmentDockEnvironment>();

  for (const item of items) {
    if (item.ownerId !== scope.ownerId || item.workspaceType !== scope.workspaceType || item.workspaceId !== scope.workspaceId) continue;
    if (scope.desktop && item.executionMode === "local" && !item.currentExecutionInstance) continue;
    const environmentId = environmentIdForConnection(item, rememberedEnvironmentIds);
    if (!environmentId) continue;
    const connection: ActiveEnvironmentDockConnection = {
      id: item.id,
      type: item.type,
      label: item.label,
      resourceId: item.resourceId,
      executionMode: item.executionMode,
      lastActivityAt: item.lastActivityAt,
      status: item.status,
    };
    const existing = environments.get(environmentId);
    if (existing) {
      existing.connections.push(connection);
      if (connection.lastActivityAt > existing.lastActivityAt) existing.lastActivityAt = connection.lastActivityAt;
    } else {
      environments.set(environmentId, {
        id: environmentId,
        name: environmentName(item, environmentId),
        lastActivityAt: connection.lastActivityAt,
        connections: [connection],
      });
    }
  }

  return [...environments.values()]
    .map((environment) => ({
      ...environment,
      connections: environment.connections.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt)),
    }))
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
}

export function activeEnvironmentDockStackAfterNavigation(
  stack: readonly string[],
  previousEnvironmentId: string,
  currentEnvironmentId: string,
): string[] {
  const next = stack.filter((environmentId) => environmentId !== previousEnvironmentId && environmentId !== currentEnvironmentId);
  if (previousEnvironmentId && previousEnvironmentId !== currentEnvironmentId) next.unshift(previousEnvironmentId);
  return next;
}

export function activeEnvironmentDockVisibleEnvironments(
  environments: readonly ActiveEnvironmentDockEnvironment[],
  stack: readonly string[],
  currentEnvironmentId: string,
): ActiveEnvironmentDockEnvironment[] {
  const byId = new Map(environments.map((environment) => [environment.id, environment]));
  const seen = new Set<string>();
  return [...stack, ...environments.map((environment) => environment.id)].flatMap((environmentId) => {
    if (seen.has(environmentId)) return [];
    seen.add(environmentId);
    const environment = byId.get(environmentId);
    return environment && environmentId !== currentEnvironmentId ? [environment] : [];
  });
}

export function activeEnvironmentDockCardSize(viewport: ActiveEnvironmentDockViewport): { width: number; height: number } {
  const reservedWidth = ACTIVE_ENVIRONMENT_DOCK_MARGIN * 2
    + ACTIVE_ENVIRONMENT_DOCK_PADDING * 2
    + ACTIVE_ENVIRONMENT_DOCK_LAYER_X * ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH;
  const width = Math.max(120, Math.min(ACTIVE_ENVIRONMENT_DOCK_CARD_WIDTH, viewport.width - reservedWidth));
  return { width, height: Math.round(width / ACTIVE_ENVIRONMENT_DOCK_CARD_ASPECT_RATIO) };
}

export function activeEnvironmentDockPanelSize(
  expanded: boolean,
  environments: readonly ActiveEnvironmentDockEnvironment[],
  viewport: ActiveEnvironmentDockViewport,
): { width: number; height: number } {
  const card = activeEnvironmentDockCardSize(viewport);
  const depth = Math.min(ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH, Math.max(0, environments.length - 1));
  const width = card.width + ACTIVE_ENVIRONMENT_DOCK_PADDING * 2 + ACTIVE_ENVIRONMENT_DOCK_LAYER_X * ACTIVE_ENVIRONMENT_DOCK_LAYER_DEPTH;
  if (!expanded) {
    return {
      width,
      height: card.height + ACTIVE_ENVIRONMENT_DOCK_PADDING * 2 + ACTIVE_ENVIRONMENT_DOCK_LAYER_Y * depth,
    };
  }
  const contentHeight = environments.length * card.height
    + Math.max(0, environments.length - 1) * ACTIVE_ENVIRONMENT_DOCK_CARD_GAP
    + ACTIVE_ENVIRONMENT_DOCK_PADDING * 2;
  return { width, height: Math.min(ACTIVE_ENVIRONMENT_DOCK_MAX_HEIGHT, contentHeight) };
}

export function clampActiveEnvironmentDockPosition(
  position: ActiveEnvironmentDockPosition,
  viewport: ActiveEnvironmentDockViewport,
  expanded: boolean,
  environments: readonly ActiveEnvironmentDockEnvironment[],
): ActiveEnvironmentDockPosition {
  const size = activeEnvironmentDockPanelSize(expanded, environments, viewport);
  return {
    x: Math.min(Math.max(ACTIVE_ENVIRONMENT_DOCK_MARGIN, position.x), Math.max(ACTIVE_ENVIRONMENT_DOCK_MARGIN, viewport.width - size.width - ACTIVE_ENVIRONMENT_DOCK_MARGIN)),
    y: Math.min(Math.max(ACTIVE_ENVIRONMENT_DOCK_MARGIN, position.y), Math.max(ACTIVE_ENVIRONMENT_DOCK_MARGIN, viewport.height - size.height - ACTIVE_ENVIRONMENT_DOCK_MARGIN)),
  };
}

export function snapActiveEnvironmentDockPosition(
  position: ActiveEnvironmentDockPosition,
  viewport: ActiveEnvironmentDockViewport,
  expanded: boolean,
  environments: readonly ActiveEnvironmentDockEnvironment[],
): ActiveEnvironmentDockPosition {
  const clamped = clampActiveEnvironmentDockPosition(position, viewport, expanded, environments);
  const size = activeEnvironmentDockPanelSize(expanded, environments, viewport);
  const left = clamped.x;
  const right = viewport.width - clamped.x - size.width;
  const top = clamped.y;
  const bottom = viewport.height - clamped.y - size.height;
  const nearest = Math.min(left, right, top, bottom);
  if (nearest > 72) return clamped;
  if (nearest === left) return { ...clamped, x: ACTIVE_ENVIRONMENT_DOCK_MARGIN };
  if (nearest === right) return { ...clamped, x: Math.max(ACTIVE_ENVIRONMENT_DOCK_MARGIN, viewport.width - size.width - ACTIVE_ENVIRONMENT_DOCK_MARGIN) };
  if (nearest === top) return { ...clamped, y: ACTIVE_ENVIRONMENT_DOCK_MARGIN };
  return { ...clamped, y: Math.max(ACTIVE_ENVIRONMENT_DOCK_MARGIN, viewport.height - size.height - ACTIVE_ENVIRONMENT_DOCK_MARGIN) };
}
