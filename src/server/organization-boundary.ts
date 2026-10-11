import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { internalRequestAuditSource } from "./audit.js";
import type { OrganizationAccess } from "./organization-rbac.js";
import {
  resourceKey,
  type FeatureGrant,
  type ResourceRef,
} from "../shared/organization-rbac.js";

/**
 * Section 9 choices, using only the boundaries that document already fixed.
 * These are not a wider policy than that column.
 */
export const SECTION9_DECISIONS = {
  newResource:
    "A maintainer with authorization.create creates the first data grant explicitly. Creating a resource does not insert a grant and does not restore admin.",
  featureScope:
    "Feature grants and approval snapshots keep the target ids saved at write time. Later environments, connections, and associations are not covered. Web plugins are judged against the real environment at execution.",
  legacyOperations:
    "Phase 0 mappings stay as shipped. SFTP upload and mkdir use ssh.upload. SFTP rename, chmod, and delete use ssh.delete. No new permission codes are added.",
  legacyRequests:
    "Old access requests stay readable and cannot be completed into a shared role data grant or a feature grant. New submissions use the data and feature request types.",
  roleChange:
    "Final approval grants nothing until the applicant still holds the role, the role permission codes still equal the snapshot, and the shared member set still equals the snapshot. A mismatch rejects completion. The grant cannot exceed the snapshot.",
  runtimeStop:
    "Every execution uses server time. A finished external effect is recorded as completed and is not rolled back; the session or task then stops. Another valid path keeps working. Expiry does not restore admin. The existing maintainer check already rejects a change that would leave zero current or future maintainers.",
} as const;

export type ExecutionChannel = "manual" | "mcp" | "agent" | "web_plugin";

const CHANNEL_HEADER = "x-viron-internal-execution-channel";
const channelMarkers = new Map<string, ExecutionChannel>();

/** Server clock only. A client timestamp, header, or body field is ignored. */
export function serverNow(_clientValue?: unknown): number {
  return Date.now();
}

export function runWithExecutionChannel<T>(
  channel: ExecutionChannel,
  callback: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const marker = randomUUID();
  channelMarkers.set(marker, channel);
  return callback({ [CHANNEL_HEADER]: marker }).finally(() => {
    channelMarkers.delete(marker);
  });
}

/** Route and server-issued marker decide the channel. Client channel fields do not. */
export function trustedExecutionChannel(request: FastifyRequest): ExecutionChannel {
  const marker = request.headers[CHANNEL_HEADER];
  if (typeof marker === "string") {
    const issued = channelMarkers.get(marker);
    if (issued) return issued;
  }
  const path = request.url.split("?", 1)[0] ?? "";
  if (path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/api/v1/mcp/"))
    return "mcp";
  if (path.includes("/agent-diagnostics")) return "agent";
  if (internalRequestAuditSource(request) === "mcp") return "mcp";
  return "manual";
}

export interface OperationPath {
  expiresAt: number | null;
}

export interface OperationWindow {
  allowed: boolean;
  permanent: boolean;
  expiresAt: number | null;
}

export function unionWindow(paths: OperationPath[]): OperationWindow {
  if (!paths.length) return { allowed: false, permanent: false, expiresAt: null };
  if (paths.some((path) => path.expiresAt === null))
    return { allowed: true, permanent: true, expiresAt: null };
  return {
    allowed: true,
    permanent: false,
    expiresAt: Math.max(...paths.map((path) => path.expiresAt ?? 0)),
  };
}

export function intersectWindows(left: OperationWindow, right: OperationWindow): OperationWindow {
  if (!left.allowed || !right.allowed)
    return { allowed: false, permanent: false, expiresAt: null };
  if (left.permanent && right.permanent)
    return { allowed: true, permanent: true, expiresAt: null };
  return {
    allowed: true,
    permanent: false,
    expiresAt: Math.min(
      left.expiresAt ?? Number.POSITIVE_INFINITY,
      right.expiresAt ?? Number.POSITIVE_INFINITY,
    ),
  };
}

const USE_CODES: Record<string, string[]> = {
  environment: ["environment.view", "environment.update"],
  web: ["web.view", "web.use", "web.reveal"],
  ssh: ["ssh.view", "ssh.use", "ssh.browse", "ssh.upload", "ssh.download", "ssh.delete"],
  database: ["database.read", "database.export", "database.write", "database.ddl"],
  redis: ["redis.view", "redis.write"],
  logs: ["logs.view"],
  knowledge: ["knowledge.view", "knowledge.edit"],
  maintenance: [
    "maintenance.view",
    "maintenance.control",
    "maintenance.script",
    "maintenance.install",
  ],
};

export function useCodesFor(capability: string): string[] {
  return USE_CODES[capability] ?? [];
}

export function channelWindow(
  access: OrganizationAccess,
  channel: ExecutionChannel,
  code: string,
  target: ResourceRef,
): OperationWindow {
  const operation = unionWindow(access.operationPaths(code, target));
  if (channel === "manual") return operation;
  const feature: keyof FeatureGrant["features"] =
    channel === "mcp" ? "mcp" : channel === "agent" ? "agent" : "webPlugins";
  const featureTarget =
    feature === "webPlugins" && target.type !== "environment"
      ? null
      : target;
  if (!featureTarget) return { allowed: false, permanent: false, expiresAt: null };
  return intersectWindows(
    operation,
    unionWindow(access.featurePaths(feature, featureTarget)),
  );
}

export interface ExecutionDecision {
  allowed: boolean;
  channel: ExecutionChannel;
  code: string;
  error: "ACTION_FORBIDDEN" | "FEATURE_FORBIDDEN" | null;
  message: string;
  window: OperationWindow;
}

export function executionDecision(
  access: OrganizationAccess,
  channel: ExecutionChannel,
  code: string,
  target: ResourceRef,
): ExecutionDecision {
  const operation = unionWindow(access.operationPaths(code, target));
  if (!operation.allowed)
    return {
      allowed: false,
      channel,
      code,
      error: "ACTION_FORBIDDEN",
      message: "角色未获得这项资源操作权限",
      window: operation,
    };
  if (channel === "manual")
    return {
      allowed: true,
      channel,
      code,
      error: null,
      message: "",
      window: operation,
    };
  const window = channelWindow(access, channel, code, target);
  if (!window.allowed)
    return {
      allowed: false,
      channel,
      code,
      error: "FEATURE_FORBIDDEN",
      message: "没有覆盖该目标的有效功能授权",
      window,
    };
  return { allowed: true, channel, code, error: null, message: "", window };
}

export function formatOperableRemaining(expiresAt: number, now = serverNow()): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} 小时 ${rest} 分`;
  if (hours) return `${hours} 小时`;
  return `${rest} 分`;
}

export interface PresentedWindow {
  permanent: boolean;
  partial: boolean;
  expiresAt: string | null;
  label: string | null;
}

export function presentWindows(
  paths: Array<OperationPath & { code: string }>,
  now = serverNow(),
): PresentedWindow {
  const byCode = new Map<string, OperationPath[]>();
  for (const path of paths) {
    const list = byCode.get(path.code) ?? [];
    list.push(path);
    byCode.set(path.code, list);
  }
  const windows = [...byCode.values()].map(unionWindow).filter((item) => item.allowed);
  if (!windows.length)
    return { permanent: false, partial: false, expiresAt: null, label: null };
  if (windows.every((item) => item.permanent))
    return { permanent: true, partial: false, expiresAt: null, label: null };
  const limited = windows.filter((item) => !item.permanent && item.expiresAt !== null);
  const expiresAt = Math.min(...limited.map((item) => item.expiresAt ?? now));
  const partial =
    windows.some((item) => item.permanent) ||
    new Set(limited.map((item) => item.expiresAt)).size > 1;
  const amount = formatOperableRemaining(expiresAt, now);
  return {
    permanent: false,
    partial,
    expiresAt: new Date(expiresAt).toISOString(),
    label: `${partial ? "部分操作剩余" : "可操作剩余"} ${amount}`,
  };
}

export function presentTargetWindow(
  access: OrganizationAccess,
  target: ResourceRef,
  codes = useCodesFor(
    access.catalog.find((item) => resourceKey(item) === resourceKey(target))?.capability ?? "",
  ),
  now = serverNow(),
): PresentedWindow {
  const paths = codes.flatMap((code) =>
    access.operationPaths(code, target).map((path) => ({ code, ...path })),
  );
  return presentWindows(paths, now);
}

export function webPluginInjection(
  access: OrganizationAccess,
  environmentId: string,
): { inject: boolean; label: string | null; reason: string } {
  const environment = access.catalog.find(
    (item) => item.type === "environment" && item.id === environmentId,
  );
  if (!environment)
    return {
      inject: false,
      label: "环境未授权 · 已禁用",
      reason: "无法确定真实环境",
    };
  const feature = unionWindow(
    access.featurePaths("webPlugins", { type: "environment", id: environmentId }),
  );
  const entries = access.catalog.filter(
    (item) => item.type === "web_entry" && item.environmentIds.includes(environmentId),
  );
  const canOpen = entries.some(
    (entry) => access.allows("web.view", entry) || access.allows("web.use", entry),
  );
  if (!feature.allowed || !canOpen)
    return {
      inject: false,
      label: "环境未授权 · 已禁用",
      reason: feature.allowed ? "没有该环境的 Web 入口访问权限" : "环境未授权",
    };
  return { inject: true, label: null, reason: "" };
}
