import { normalizeAgentSshCommand, normalizeAgentSshScript } from "../shared/agent";

export interface AgentSshWorkbenchScene {
  routePath: string;
  sessionId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  status: "connecting" | "connected" | "disconnected" | "closed";
  currentDirectory: string;
  localExecution: boolean;
}

interface AgentSshSceneProvider {
  current(): AgentSshWorkbenchScene | null;
  fill(sessionId: string, command: string): boolean;
  fillScript(sessionId: string, script: string): boolean;
}

let activeProvider: AgentSshSceneProvider | null = null;

export function registerAgentSshSceneProvider(provider: AgentSshSceneProvider): () => void {
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) activeProvider = null;
  };
}

export function currentAgentSshScene(routePath: string): AgentSshWorkbenchScene | null {
  const scene = activeProvider?.current() ?? null;
  return scene?.routePath === routePath ? scene : null;
}

export function fillAgentSshCommand(routePath: string, sessionId: string, command: string): boolean {
  const scene = currentAgentSshScene(routePath);
  if (!scene || scene.sessionId !== sessionId || scene.status !== "connected" || !scene.localExecution) return false;
  try {
    return activeProvider?.fill(sessionId, normalizeAgentSshCommand(command)) ?? false;
  } catch {
    return false;
  }
}

export function fillAgentSshScript(routePath: string, sessionId: string, script: string): boolean {
  const scene = currentAgentSshScene(routePath);
  if (!scene || scene.sessionId !== sessionId || scene.status !== "connected" || !scene.localExecution) return false;
  try {
    return activeProvider?.fillScript(sessionId, normalizeAgentSshScript(script)) ?? false;
  } catch {
    return false;
  }
}
