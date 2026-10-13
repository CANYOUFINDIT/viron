import { z } from "zod";
import { RESOURCE_TYPES, type ResourceRef } from "./organization-rbac.js";

/** Signed desktop request that asks the server to authorize one organization execution. */
export const DESKTOP_EXECUTION_CHANNELS = ["mcp", "agent"] as const;
export type DesktopExecutionChannel = (typeof DESKTOP_EXECUTION_CHANNELS)[number];

export const DESKTOP_EXECUTION_AUTHORIZATION_KIND = "organization_execution_authorization" as const;
export const DESKTOP_EXECUTION_RESULT_KIND = "organization_execution_result" as const;

export const desktopExecutionRequestIdentitySchema = z.object({
  method: z.string().regex(/^[A-Z]{1,16}$/),
  path: z.string().regex(/^\/[^\s]{0,2047}$/),
  bodyDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const desktopExecutionCheckSchema = z.object({
  target: z.object({
    type: z.enum(RESOURCE_TYPES),
    id: z.string().uuid(),
  }).strict(),
  code: z.string().min(1).max(80),
}).strict();

export const desktopExecutionAuthorizationPayloadSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.literal(DESKTOP_EXECUTION_AUTHORIZATION_KIND),
  channel: z.enum(DESKTOP_EXECUTION_CHANNELS),
  checks: z.array(desktopExecutionCheckSchema).min(1).max(16),
  requestIdentity: desktopExecutionRequestIdentitySchema,
}).strict();

export type DesktopExecutionRequestIdentity = z.infer<typeof desktopExecutionRequestIdentitySchema>;
export type DesktopExecutionCheck = z.infer<typeof desktopExecutionCheckSchema>;
export type DesktopExecutionAuthorizationPayload = z.infer<typeof desktopExecutionAuthorizationPayloadSchema>;

const desktopExecutionWindowSchema = z.object({
  allowed: z.boolean(),
  permanent: z.boolean(),
  expiresAt: z.number().nullable(),
}).strict();

/** Separate from the authorization check. status is the tool execution outcome. */
export const desktopExecutionResultPayloadSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.literal(DESKTOP_EXECUTION_RESULT_KIND),
  channel: z.enum(DESKTOP_EXECUTION_CHANNELS),
  target: z.object({
    type: z.enum(RESOURCE_TYPES),
    id: z.string().uuid(),
  }).strict(),
  code: z.string().min(1).max(80),
  status: z.enum(["success", "failed", "cancelled"]),
  basis: z.object({
    roles: z.array(z.object({
      roleId: z.string().min(1).max(80),
      roleName: z.string().min(1).max(200),
      assignmentId: z.string().min(1).max(80),
      dataGrantId: z.string().min(1).max(80),
    }).strict()).max(32),
    featureGrantIds: z.array(z.string().min(1).max(80)).max(32),
    operation: desktopExecutionWindowSchema,
    feature: desktopExecutionWindowSchema,
  }).strict(),
}).strict();

export type DesktopExecutionResultPayload = z.infer<typeof desktopExecutionResultPayloadSchema>;

export interface DesktopExecutionWindow {
  allowed: boolean;
  permanent: boolean;
  expiresAt: number | null;
}

/** Roles listed here each have both the permission code and this target's data grant. */
export interface DesktopExecutionAuthorizationBasis {
  roles: Array<{
    roleId: string;
    roleName: string;
    assignmentId: string;
    dataGrantId: string;
  }>;
  featureGrantIds: string[];
  operation: DesktopExecutionWindow;
  feature: DesktopExecutionWindow;
}

export interface DesktopExecutionCheckResult {
  target: ResourceRef;
  code: string;
  allowed: boolean;
  error: "ACTION_FORBIDDEN" | "FEATURE_FORBIDDEN" | null;
  message: string;
  window: DesktopExecutionWindow;
  basis: DesktopExecutionAuthorizationBasis;
}

export interface DesktopExecutionAuthorizationResult {
  allowed: boolean;
  scope: "personal" | "organization";
  operationId: string;
  duplicate: boolean;
  kind: typeof DESKTOP_EXECUTION_AUTHORIZATION_KIND;
  channel: DesktopExecutionChannel;
  error: "ACTION_FORBIDDEN" | "FEATURE_FORBIDDEN" | null;
  message: string;
  window: DesktopExecutionWindow;
  checks: DesktopExecutionCheckResult[];
  requestIdentity: DesktopExecutionRequestIdentity;
}
