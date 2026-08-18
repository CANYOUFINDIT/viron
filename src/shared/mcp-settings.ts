export const MCP_APPROVAL_MODES = ["always", "high-risk", "never"] as const;

export type McpApprovalMode = typeof MCP_APPROVAL_MODES[number];

export type McpRiskLevel = "low" | "medium" | "high";

export const DEFAULT_MCP_APPROVAL_MODE: McpApprovalMode = "always";
export const VIRON_MCP_APPROVAL_MODE_HEADER = "X-Viron-MCP-Approval-Mode";

export function mcpApprovalMode(value: unknown): McpApprovalMode {
  return MCP_APPROVAL_MODES.includes(value as McpApprovalMode)
    ? value as McpApprovalMode
    : DEFAULT_MCP_APPROVAL_MODE;
}

export function mcpApprovalRequired(mode: McpApprovalMode, riskLevel: McpRiskLevel): boolean {
  if (riskLevel === "low") return false;
  if (mode === "never") return false;
  if (mode === "high-risk") return riskLevel === "high";
  return true;
}

export interface ServerMcpSessionInfo {
  id: string;
  clientName: string;
  clientVersion: string;
  connectedAt: string;
  lastActivityAt: string;
}

export interface ServerMcpStatus {
  enabled: boolean;
  path: "/mcp";
  transport: "streamable-http";
  authentication: "personal-api-key";
  toolCount: number;
  businessOperationCount: number;
  sessions: ServerMcpSessionInfo[];
}

export interface DesktopMcpClientInfo {
  id: string;
  clientName: string;
  clientVersion: string;
  connectedAt: string;
  lastActivityAt: string;
}

export interface DesktopMcpStatus {
  enabled: boolean;
  approvalMode: McpApprovalMode;
  running: boolean;
  transport: "unix" | "pipe";
  address: string | null;
  launcherPath: string;
  clients: DesktopMcpClientInfo[];
  lastError: string | null;
}
