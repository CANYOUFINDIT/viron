import type { AgentWorkbenchDomain, AgentWorkbenchExecutionRequest } from "./agent.js";

export interface AgentHostSshScene {
  routePath: string;
  sessionId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  status: "connecting" | "connected" | "disconnected" | "closed";
  currentDirectory: string;
  localExecution: boolean;
}

export interface AgentHostDatabaseScene {
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

export interface AgentHostState {
  userId: string;
  workspaceType: string;
  workspaceId: string;
  routePath: string;
  routeName: string;
  settingsSection: string;
  ssh: AgentHostSshScene | null;
  database: AgentHostDatabaseScene | null;
}

export const emptyAgentHostState: AgentHostState = {
  userId: "",
  workspaceType: "",
  workspaceId: "",
  routePath: "/",
  routeName: "",
  settingsSection: "",
  ssh: null,
  database: null,
};

export type AgentHostAction =
  | { type: "navigate-settings" }
  | { type: "scene-snapshot" }
  | { type: "fill-ssh"; sessionId: string; command: string }
  | { type: "fill-ssh-script"; sessionId: string; script: string }
  | { type: "fill-database"; connectionId: string; database: string; sql: string }
  | { type: "workbench-execute"; request: AgentWorkbenchExecutionRequest }
  | { type: "workbench-cancel"; requestId: string; domain: AgentWorkbenchDomain; reason: string };

export interface AgentHostActionResult {
  ok: boolean;
  filled?: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentHostActionRequest {
  id: string;
  action: AgentHostAction;
}

export function isAgentHostState(value: unknown): value is AgentHostState {
  if (!value || typeof value !== "object") return false;
  const state = value as AgentHostState;
  return typeof state.userId === "string"
    && typeof state.workspaceType === "string"
    && typeof state.workspaceId === "string"
    && typeof state.routePath === "string"
    && typeof state.routeName === "string"
    && typeof state.settingsSection === "string"
    && (state.ssh === null || Boolean(state.ssh && typeof state.ssh.sessionId === "string"))
    && (state.database === null || Boolean(state.database && typeof state.database.connectionId === "string"));
}

export function isAgentHostAction(value: unknown): value is AgentHostAction {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return false;
  const action = value as AgentHostAction;
  switch (action.type) {
    case "navigate-settings":
    case "scene-snapshot":
      return true;
    case "fill-ssh":
      return typeof action.sessionId === "string" && typeof action.command === "string";
    case "fill-ssh-script":
      return typeof action.sessionId === "string" && typeof action.script === "string";
    case "fill-database":
      return typeof action.connectionId === "string" && typeof action.database === "string" && typeof action.sql === "string";
    case "workbench-execute":
      return Boolean(action.request && typeof action.request === "object");
    case "workbench-cancel":
      return typeof action.requestId === "string" && typeof action.domain === "string";
    default:
      return false;
  }
}
