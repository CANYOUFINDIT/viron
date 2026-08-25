export type ImmersiveWorkspaceTab = "web" | "ssh" | "logs" | "database" | "redis" | "knowledge" | "maintenance";
export type ImmersiveDockEdge = "left" | "right" | "top";

export interface ImmersiveDockPosition {
  edge: ImmersiveDockEdge;
  offset: number;
}

export interface ImmersiveNavigationCredential {
  id: string;
  username: string;
}

export interface ImmersiveNavigationEntry {
  id: string;
  name: string;
  credentialCount: number;
  credentials: ImmersiveNavigationCredential[] | null;
  loading: boolean;
}

export interface ImmersiveNavigationState {
  language?: import("./i18n.js").Language;
  visible: boolean;
  expanded: boolean;
  dark: boolean;
  dock: ImmersiveDockPosition;
  environmentName: string;
  activeTab: ImmersiveWorkspaceTab;
  webExpanded: boolean;
  expandedEntryId: string;
  selectedEntryId: string;
  selectedCredentialId: string;
  counts: Record<ImmersiveWorkspaceTab, number>;
  maintenanceHostCount: number;
  entries: ImmersiveNavigationEntry[];
}

export type ImmersiveNavigationAction =
  | { type: "toggle" | "collapse" | "toggle-web" | "exit" }
  | { type: "toggle-entry"; entryId: string }
  | { type: "select-tab"; tab: Exclude<ImmersiveWorkspaceTab, "web"> }
  | { type: "select-credential"; entryId: string; credentialId: string }
  | { type: "dock"; dock: ImmersiveDockPosition }
  | { type: "drag-start" | "drag-move" | "drag-end"; screenX: number; screenY: number };

export function previewImmersiveNavigationAction(
  state: ImmersiveNavigationState,
  action: ImmersiveNavigationAction,
): ImmersiveNavigationState {
  if (action.type === "toggle") {
    const expanded = !state.expanded;
    return {
      ...state,
      expanded,
      ...(expanded ? {
        webExpanded: state.activeTab === "web",
        expandedEntryId: state.activeTab === "web" ? state.selectedEntryId : "",
      } : {}),
    };
  }
  if (["collapse", "select-tab", "select-credential", "exit"].includes(action.type)) {
    return state.expanded ? { ...state, expanded: false } : state;
  }
  if (action.type === "toggle-web") return { ...state, webExpanded: !state.webExpanded };
  if (action.type === "toggle-entry") {
    return { ...state, expandedEntryId: state.expandedEntryId === action.entryId ? "" : action.entryId };
  }
  return state;
}

export function plainImmersiveNavigationState(state: ImmersiveNavigationState): ImmersiveNavigationState {
  return {
    ...state,
    dock: { ...state.dock },
    counts: { ...state.counts },
    entries: state.entries.map((entry) => ({
      ...entry,
      credentials: entry.credentials?.map((credential) => ({ ...credential })) ?? null,
    })),
  };
}

export function immersiveNavigationEscapeAction(
  state: Pick<ImmersiveNavigationState, "visible" | "expanded"> | null,
): { type: "collapse" | "exit" } | null {
  if (!state?.visible) return null;
  return { type: state.expanded ? "collapse" : "exit" };
}

export interface ImmersiveViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImmersiveSize {
  width: number;
  height: number;
}

export interface ImmersiveBounds extends ImmersiveSize {
  x: number;
  y: number;
}

export const IMMERSIVE_HANDLE_SIDE_SIZE: ImmersiveSize = { width: 34, height: 48 };
export const IMMERSIVE_HANDLE_TOP_SIZE: ImmersiveSize = { width: 48, height: 34 };
export const IMMERSIVE_PANEL_WIDTH = 286;
export const IMMERSIVE_PANEL_MAX_HEIGHT = 520;
export const IMMERSIVE_PANEL_MARGIN = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function defaultImmersiveDock(): ImmersiveDockPosition {
  return { edge: "right", offset: 0.5 };
}

export function immersiveNavigationSize(
  dock: ImmersiveDockPosition,
  expanded: boolean,
  viewport: ImmersiveViewport,
): ImmersiveSize {
  if (!expanded) return dock.edge === "top" ? IMMERSIVE_HANDLE_TOP_SIZE : IMMERSIVE_HANDLE_SIDE_SIZE;
  return {
    width: Math.min(IMMERSIVE_PANEL_WIDTH, Math.max(1, viewport.width - IMMERSIVE_PANEL_MARGIN * 2)),
    height: Math.min(IMMERSIVE_PANEL_MAX_HEIGHT, Math.max(1, viewport.height - IMMERSIVE_PANEL_MARGIN * 2)),
  };
}

export function immersiveNavigationBounds(
  dock: ImmersiveDockPosition,
  size: ImmersiveSize,
  viewport: ImmersiveViewport,
): ImmersiveBounds {
  const offset = clamp(dock.offset, 0, 1);
  if (dock.edge === "top") {
    return {
      x: Math.round(viewport.x + clamp(offset * viewport.width - size.width / 2, IMMERSIVE_PANEL_MARGIN, viewport.width - size.width - IMMERSIVE_PANEL_MARGIN)),
      y: viewport.y,
      ...size,
    };
  }
  return {
    x: dock.edge === "left" ? viewport.x : viewport.x + viewport.width - size.width,
    y: Math.round(viewport.y + clamp(offset * viewport.height - size.height / 2, IMMERSIVE_PANEL_MARGIN, viewport.height - size.height - IMMERSIVE_PANEL_MARGIN)),
    ...size,
  };
}

export function snapImmersiveDock(
  point: { x: number; y: number },
  viewport: ImmersiveViewport,
): ImmersiveDockPosition {
  const distances: Array<[ImmersiveDockEdge, number]> = [
    ["left", Math.abs(point.x - viewport.x)],
    ["right", Math.abs(viewport.x + viewport.width - point.x)],
    ["top", Math.abs(point.y - viewport.y)],
  ];
  const edge = distances.sort((left, right) => left[1] - right[1])[0][0];
  const rawOffset = edge === "top"
    ? (point.x - viewport.x) / viewport.width
    : (point.y - viewport.y) / viewport.height;
  return { edge, offset: clamp(rawOffset, 0, 1) };
}
