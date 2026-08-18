import { reactive, ref } from "vue";
import type { AgentWorkbenchExecutionRequest, AgentWorkbenchExecutionResult } from "../shared/agent";
import {
  emptyAgentHostState,
  type AgentHostAction,
  type AgentHostActionRequest,
  type AgentHostActionResult,
  type AgentHostState,
} from "../shared/agent-host";
import { currentAgentDatabaseScene, fillAgentDatabaseSql } from "./agent-database-scene";
import { currentAgentSshScene, fillAgentSshCommand, fillAgentSshScript } from "./agent-ssh-scene";
import { cancelAgentWorkbenchRequest, executeAgentWorkbenchRequest } from "./agent-workbench-execution";

export const agentHostState = reactive<AgentHostState>({ ...emptyAgentHostState });
export const agentNativeOverlayActive = ref(false);

let nativeOverlayRetainCount = 0;
let navigateSettingsHandler: (() => Promise<void>) | null = null;

export function isAgentChatOverlayRuntime(): boolean {
  return Boolean(window.vironAgentChatOverlay);
}

export function registerAgentHostNavigateSettings(handler: () => Promise<void>): () => void {
  navigateSettingsHandler = handler;
  return () => {
    if (navigateSettingsHandler === handler) navigateSettingsHandler = null;
  };
}

export function retainAgentNativeOverlay(): void {
  nativeOverlayRetainCount += 1;
  agentNativeOverlayActive.value = true;
  void window.vironDesktop?.setAgentChatNativeOverlay?.(true);
}

export function releaseAgentNativeOverlay(): void {
  nativeOverlayRetainCount = Math.max(0, nativeOverlayRetainCount - 1);
  const active = nativeOverlayRetainCount > 0;
  agentNativeOverlayActive.value = active;
  void window.vironDesktop?.setAgentChatNativeOverlay?.(active);
}

export function applyAgentHostState(state: AgentHostState | null): void {
  Object.assign(agentHostState, state ?? emptyAgentHostState);
}

export function currentAgentHostSnapshot(
  input: Omit<AgentHostState, "ssh" | "database">,
): AgentHostState {
  return {
    ...input,
    ssh: currentAgentSshScene(input.routePath),
    database: currentAgentDatabaseScene(input.routePath),
  };
}

export async function dispatchLocalAgentHostAction(action: AgentHostAction): Promise<AgentHostActionResult> {
  switch (action.type) {
    case "navigate-settings":
      await navigateSettingsHandler?.();
      return { ok: true };
    case "scene-snapshot":
      return { ok: true, result: currentAgentHostSnapshot(agentHostState) };
    case "fill-ssh":
      return { ok: true, filled: fillAgentSshCommand(agentHostState.routePath, action.sessionId, action.command) };
    case "fill-ssh-script":
      return { ok: true, filled: fillAgentSshScript(agentHostState.routePath, action.sessionId, action.script) };
    case "fill-database":
      return {
        ok: true,
        filled: fillAgentDatabaseSql(agentHostState.routePath, action.connectionId, action.database, action.sql),
      };
    case "workbench-execute":
      return {
        ok: true,
        result: await executeAgentWorkbenchRequest(agentHostState.routePath, action.request),
      };
    case "workbench-cancel":
      cancelAgentWorkbenchRequest(action.requestId, action.domain, action.reason);
      return { ok: true };
  }
}

export async function performAgentHostAction(action: AgentHostAction): Promise<AgentHostActionResult> {
  if (isAgentChatOverlayRuntime() && window.vironDesktop?.agentHostAction) return window.vironDesktop.agentHostAction(action);
  return dispatchLocalAgentHostAction(action);
}

export async function executeAgentHostWorkbench(
  request: AgentWorkbenchExecutionRequest,
): Promise<AgentWorkbenchExecutionResult> {
  const result = await performAgentHostAction({ type: "workbench-execute", request });
  if (!result.ok || !result.result) throw new Error(result.error || "Viron Agent 工作台执行失败");
  return result.result as AgentWorkbenchExecutionResult;
}

export async function getDesktopAgentHost(): Promise<AgentHostState | null> {
  if (!isAgentChatOverlayRuntime() || !window.vironDesktop?.getAgentHost) return agentHostState.userId ? { ...agentHostState } : null;
  return window.vironDesktop.getAgentHost();
}

export function updateDesktopAgentHost(state: AgentHostState | null): Promise<void> {
  if (!window.vironDesktop?.updateAgentHost) return Promise.resolve();
  return window.vironDesktop.updateAgentHost(state);
}

export function onDesktopAgentHostState(listener: (state: AgentHostState | null) => void): () => void {
  return window.vironDesktop?.onAgentHostState(listener) ?? (() => undefined);
}

export function onDesktopAgentHostRequest(listener: (request: AgentHostActionRequest) => void): () => void {
  return window.vironDesktop?.onAgentHostRequest(listener) ?? (() => undefined);
}

export function respondDesktopAgentHost(id: string, result: AgentHostActionResult): Promise<void> {
  if (!window.vironDesktop?.respondAgentHost) return Promise.resolve();
  return window.vironDesktop.respondAgentHost(id, result);
}

export function onDesktopAgentChatPointerOutside(listener: () => void): () => void {
  return window.vironDesktop?.onAgentChatPointerOutside(listener) ?? (() => undefined);
}

export function updateDesktopAgentChatChrome(visible: boolean): Promise<void> {
  if (!isAgentChatOverlayRuntime() || !window.vironDesktop?.updateAgentChatChrome) return Promise.resolve();
  return window.vironDesktop.updateAgentChatChrome(visible);
}

export function setDesktopAgentChatIgnoreMouse(ignore: boolean): Promise<void> {
  if (!isAgentChatOverlayRuntime() || !window.vironDesktop?.setAgentChatIgnoreMouse) return Promise.resolve();
  return window.vironDesktop.setAgentChatIgnoreMouse(ignore);
}

export function focusDesktopAgentChat(): Promise<void> {
  if (!isAgentChatOverlayRuntime() || !window.vironDesktop?.focusAgentChat) return Promise.resolve();
  return window.vironDesktop.focusAgentChat();
}

export function notifyDesktopAgentChatPointerOutside(): Promise<void> {
  if (!window.vironDesktop?.notifyAgentChatPointerOutside) return Promise.resolve();
  return window.vironDesktop.notifyAgentChatPointerOutside();
}
