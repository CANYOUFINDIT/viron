import { normalizeAgentDatabaseSql } from "../shared/agent";

export interface AgentDatabaseWorkbenchScene {
  routePath: string;
  connectionId: string;
  connectionName: string;
  database: string;
  connected: boolean;
  localExecution: boolean;
  editorSql: string;
  selectedSql: string;
  resultPreview: Array<Record<string, unknown>>;
}

interface AgentDatabaseSceneProvider {
  current(): AgentDatabaseWorkbenchScene | null;
  fill(connectionId: string, database: string, sql: string): boolean;
}

let activeProvider: AgentDatabaseSceneProvider | null = null;

export function registerAgentDatabaseSceneProvider(provider: AgentDatabaseSceneProvider): () => void {
  activeProvider = provider;
  return () => { if (activeProvider === provider) activeProvider = null; };
}

export function currentAgentDatabaseScene(routePath: string): AgentDatabaseWorkbenchScene | null {
  const scene = activeProvider?.current() ?? null;
  return scene?.routePath === routePath ? scene : null;
}

export function fillAgentDatabaseSql(routePath: string, connectionId: string, database: string, sql: string): boolean {
  const scene = currentAgentDatabaseScene(routePath);
  if (!scene || !scene.connected || !scene.localExecution || scene.connectionId !== connectionId || scene.database !== database) return false;
  try {
    return activeProvider?.fill(connectionId, database, normalizeAgentDatabaseSql(sql)) ?? false;
  } catch {
    return false;
  }
}
