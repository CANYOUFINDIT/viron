export type ActiveConnectionType = "web" | "ssh" | "logs" | "sftp" | "database" | "redis";

export interface ActiveConnectionTraffic {
  sentBytesPerSecond: number;
  receivedBytesPerSecond: number;
  sentBytes: number;
  receivedBytes: number;
}

export interface ActiveConnectionItem {
  id: string;
  ownerId: string;
  ownerUsername: string;
  type: ActiveConnectionType;
  label: string;
  resourceId: string;
  originEnvironmentId: string | null;
  environmentIds: string[];
  environmentNames: string[];
  workspaceType: "personal" | "organization";
  workspaceId: string;
  workspaceName: string;
  client: "web" | "desktop";
  executionMode: "server" | "local";
  currentExecutionInstance: boolean;
  createdAt: string;
  lastActivityAt: string;
  status: "active" | "closing";
  traffic: ActiveConnectionTraffic;
}

export interface ActiveConnectionSummary {
  current: number;
  limit: number;
  idleMinutes: number;
  items: ActiveConnectionItem[];
}
