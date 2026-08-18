export interface McpApiResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  data: unknown;
}

export interface McpApiRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  workspace?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  form?: {
    fields?: Record<string, string>;
    files?: Array<{
      fieldName: string;
      filename: string;
      contentType: string;
      contentBase64: string;
    }>;
  };
}

export interface VironMcpBackend {
  invoke(toolName: string, arguments_: Record<string, unknown>): Promise<McpApiResponse>;
}

export type VironMcpOperationStatus =
  | "awaiting_purpose"
  | "pending"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface VironMcpOperationPublic {
  operationId: string;
  action: string;
  kind: "credential" | "confirmation";
  status: VironMcpOperationStatus;
  title: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  purpose: string | null;
  actionUrl: string | null;
  expiresAt: string;
  nextAction?: {
    tool: "viron_operation_purpose_provide";
    arguments: { operationId: string; workspace: string };
    instruction: string;
    purposeMinLength: number;
    purposeMaxLength: number;
  };
  result?: McpApiResponse;
}

export const VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH = 8;
export const VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH = 80;

export interface VironMcpBrokerDescriptor {
  protocolVersion: 1;
  transport: "unix" | "pipe";
  address: string;
  token: string;
  pid: number;
  appVersion: string;
  updatedAt: string;
}

export type VironMcpBrokerRequest =
  | { id: string; type: "hello"; token: string; protocolVersion: 1; clientInfo?: { name: string; version: string } }
  | { id: string; type: "invoke"; toolName: string; arguments: Record<string, unknown> };

export type VironMcpBrokerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
