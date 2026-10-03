import type { ItemMap, PermissionMap, ScopeKind } from "./access-permissions.js";

export interface ApprovalStage {
  name: string;
  approverIds: string[];
  mode: "any" | "all";
}

export interface ApprovalWorkflow {
  name: string;
  stages: ApprovalStage[];
}

export interface AccessGrantSnapshot {
  granteeType: "user" | "project";
  granteeId: string;
  granteeName: string;
  scopeKind: ScopeKind | "knowledge_node";
  wholeGroup: boolean;
  groupId: string | null;
  targetIds: string[];
  permissions: PermissionMap;
  items: ItemMap;
  itemNames?: Record<string, Array<{ id: string; name: string }>>;
  expiresAt: string | null;
  label: string;
  permissionText: string;
}

export type AccessEventAction = "requested" | "approved" | "rejected" | "withdrawn" | "granted" | "updated" | "revoked" | "expired" | "imported" | "workflow_updated";
export interface AccessGovernanceEvent {
  id: string;
  requestId: string | null;
  grantId: string | null;
  action: AccessEventAction;
  source: "direct" | "request" | "system";
  actorId: string | null;
  actorName: string;
  reason: string;
  before: AccessGrantSnapshot | null;
  after: AccessGrantSnapshot | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AccessRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  snapshot: AccessGrantSnapshot;
  workflow: ApprovalWorkflow;
  approverNames: Record<string, string>;
  stageIndex: number;
  stageApprovals: string[];
  grantId: string | null;
  canApprove: boolean;
  canWithdraw: boolean;
  createdAt: string;
  updatedAt: string;
}
