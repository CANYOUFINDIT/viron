export interface OperationWindowDetail {
  code: string;
  name: string;
  channel: "operation" | "mcp" | "agent" | "webPlugins";
  resourceType: string;
  resourceId: string;
  resourceName: string;
  permanent: boolean;
  expiresAt: string | null;
  operationPermanent?: boolean;
  operationExpiresAt?: string | null;
  featurePermanent?: boolean;
  featureExpiresAt?: string | null;
  featureAllowed?: boolean;
}

export interface OperationWindowData {
  permanent?: boolean;
  partial?: boolean;
  expiresAt?: string | null;
  label?: string | null;
  serverNow?: string;
  details?: OperationWindowDetail[];
}
