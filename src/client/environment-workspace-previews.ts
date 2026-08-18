import { reactive } from "vue";
import {
  activeEnvironmentDockStackAfterNavigation,
  type ActiveEnvironmentDockConnection,
} from "../shared/active-environment-dock";

export type EnvironmentWorkspaceQuery = Record<string, string>;

interface EnvironmentPreviewFrame {
  dataUrl: string;
  updatedAt: number;
}

export const environmentWorkspacePreviews = reactive({
  stack: [] as string[],
  queries: {} as Record<string, EnvironmentWorkspaceQuery>,
  frames: {} as Record<string, EnvironmentPreviewFrame>,
  retainUntil: {} as Record<string, number>,
  hiddenConnectionIds: {} as Record<string, true>,
});

export function normalizeEnvironmentWorkspaceQuery(query: Record<string, unknown>): EnvironmentWorkspaceQuery {
  return Object.fromEntries(Object.entries(query).flatMap(([key, value]) => {
    if (typeof value === "string") return [[key, value]];
    if (Array.isArray(value)) {
      const first = value.find((item): item is string => typeof item === "string");
      return first === undefined ? [] : [[key, first]];
    }
    return [];
  }));
}

export function rememberEnvironmentWorkspaceRoute(environmentId: string, query: EnvironmentWorkspaceQuery): void {
  if (!environmentId) return;
  environmentWorkspacePreviews.queries[environmentId] = { ...query };
}

function connectionMatchesWorkspaceTab(connection: ActiveEnvironmentDockConnection, tab: string): boolean {
  if (tab === "ssh") return connection.type === "ssh" || connection.type === "sftp";
  return connection.type === tab;
}

export function orderEnvironmentWorkspaceConnections(
  connections: readonly ActiveEnvironmentDockConnection[],
  query: EnvironmentWorkspaceQuery | undefined,
): ActiveEnvironmentDockConnection[] {
  if (!query || connections.length < 2) return [...connections];
  const preferred = connections.find((connection) => connection.id === query.activeConnectionId)
    ?? connections.find((connection) => connection.resourceId === query.connectionId
      && (!query.tab || connectionMatchesWorkspaceTab(connection, query.tab)))
    ?? connections.find((connection) => Boolean(query.tab) && connectionMatchesWorkspaceTab(connection, query.tab));
  return preferred ? [preferred, ...connections.filter((connection) => connection.id !== preferred.id)] : [...connections];
}

export function transitionEnvironmentWorkspace(
  previousEnvironmentId: string,
  previousQuery: EnvironmentWorkspaceQuery,
  currentEnvironmentId: string,
  currentQuery: EnvironmentWorkspaceQuery,
): void {
  rememberEnvironmentWorkspaceRoute(previousEnvironmentId, previousQuery);
  rememberEnvironmentWorkspaceRoute(currentEnvironmentId, currentQuery);
  if (previousEnvironmentId && previousEnvironmentId !== currentEnvironmentId) {
    environmentWorkspacePreviews.retainUntil[previousEnvironmentId] = Date.now() + 10_000;
  }
  if (currentEnvironmentId) delete environmentWorkspacePreviews.retainUntil[currentEnvironmentId];
  environmentWorkspacePreviews.stack = activeEnvironmentDockStackAfterNavigation(
    environmentWorkspacePreviews.stack,
    previousEnvironmentId,
    currentEnvironmentId,
  );
}

export function setEnvironmentPreviewFrame(environmentId: string, dataUrl: string): void {
  if (!environmentId || !dataUrl) return;
  environmentWorkspacePreviews.frames[environmentId] = { dataUrl, updatedAt: Date.now() };
}

export function removeEnvironmentPreviewFrame(environmentId: string): void {
  delete environmentWorkspacePreviews.frames[environmentId];
}

export function hideEnvironmentWorkspaceConnections(connectionIds: readonly string[]): void {
  for (const connectionId of connectionIds) environmentWorkspacePreviews.hiddenConnectionIds[connectionId] = true;
}

export function environmentWorkspaceConnectionVisible(connectionId: string): boolean {
  return environmentWorkspacePreviews.hiddenConnectionIds[connectionId] !== true;
}

export function pruneHiddenEnvironmentWorkspaceConnections(activeConnectionIds: Iterable<string>): void {
  const activeIds = new Set(activeConnectionIds);
  for (const connectionId of Object.keys(environmentWorkspacePreviews.hiddenConnectionIds)) {
    if (!activeIds.has(connectionId)) delete environmentWorkspacePreviews.hiddenConnectionIds[connectionId];
  }
}

export function removeEnvironmentWorkspace(environmentId: string): void {
  environmentWorkspacePreviews.stack = environmentWorkspacePreviews.stack.filter((item) => item !== environmentId);
  delete environmentWorkspacePreviews.queries[environmentId];
  delete environmentWorkspacePreviews.frames[environmentId];
  delete environmentWorkspacePreviews.retainUntil[environmentId];
}

export function resetEnvironmentWorkspacePreviews(): void {
  environmentWorkspacePreviews.stack = [];
  environmentWorkspacePreviews.queries = {};
  environmentWorkspacePreviews.frames = {};
  environmentWorkspacePreviews.retainUntil = {};
  environmentWorkspacePreviews.hiddenConnectionIds = {};
}
