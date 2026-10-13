import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { internalRequestAuditSource } from "./audit.js";
import type { OrganizationAccess } from "./organization-rbac.js";
import {
  PERMISSION_DEFINITIONS,
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
  /** Null means the path is already open at asOf. */
  startsAt?: number | null;
  /** Null means the path does not expire. */
  expiresAt: number | null;
  /** Clock used when the path was read. Matches loadOrganizationAccess. */
  asOf?: number;
}

export interface OperationWindow {
  allowed: boolean;
  permanent: boolean;
  expiresAt: number | null;
}

function pathAsOf(paths: OperationPath[], now?: number): number {
  if (typeof now === "number") return now;
  const stamped = paths.find((path) => typeof path.asOf === "number")?.asOf;
  return typeof stamped === "number" ? stamped : Date.now();
}

/**
 * Merges complete-path intervals that cover `now` without crossing a gap.
 * A later path extends the window only when it starts at or before the current end.
 * A permanent path that is not covering `now` does not make the window permanent.
 */
export function unionWindow(paths: OperationPath[], now?: number): OperationWindow {
  const at = pathAsOf(paths, now);
  const intervals = paths
    .map((path) => ({
      start: path.startsAt ?? Number.NEGATIVE_INFINITY,
      end: path.expiresAt,
    }))
    .filter((interval) => interval.end === null || interval.end > at);
  const active = intervals.filter(
    (interval) => interval.start <= at && (interval.end === null || interval.end > at),
  );
  if (!active.length) return { allowed: false, permanent: false, expiresAt: null };
  if (active.some((interval) => interval.end === null))
    return { allowed: true, permanent: true, expiresAt: null };
  let cursor = Math.max(...active.map((interval) => interval.end ?? at));
  const later = intervals.filter((interval) => interval.start > at);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const interval of later) {
      if (interval.start <= cursor && (interval.end === null || interval.end > cursor)) {
        if (interval.end === null) return { allowed: true, permanent: true, expiresAt: null };
        cursor = interval.end;
        progressed = true;
      }
    }
  }
  return { allowed: true, permanent: false, expiresAt: cursor };
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

export interface WindowDetail {
  code: string;
  name: string;
  channel: "operation" | "mcp" | "agent" | "webPlugins";
  resourceType: string;
  resourceId: string;
  resourceName: string;
  permanent: boolean;
  expiresAt: string | null;
  /** Operation boundary. Present on channel rows. */
  operationPermanent?: boolean;
  operationExpiresAt?: string | null;
  /** Feature boundary. Present on channel rows. */
  featurePermanent?: boolean;
  featureExpiresAt?: string | null;
  featureAllowed?: boolean;
}

export interface PresentedWindow {
  permanent: boolean;
  partial: boolean;
  expiresAt: string | null;
  label: string | null;
  serverNow: string;
  details: WindowDetail[];
}

function permissionName(code: string): string {
  return PERMISSION_DEFINITIONS.find((item) => item.code === code)?.label ?? code;
}

function emptyPresented(now: number): PresentedWindow {
  return {
    permanent: false,
    partial: false,
    expiresAt: null,
    label: null,
    serverNow: new Date(now).toISOString(),
    details: [],
  };
}

export function presentWindows(
  paths: Array<OperationPath & { code: string; resourceType?: string; resourceId?: string; resourceName?: string }>,
  now = pathAsOf(paths),
): PresentedWindow {
  const byCode = new Map<string, OperationPath[]>();
  for (const path of paths) {
    const key = `${path.resourceType ?? ""}:${path.resourceId ?? ""}:${path.code}`;
    const list = byCode.get(key) ?? [];
    list.push(path);
    byCode.set(key, list);
  }
  const windows = [...byCode.values()].map((group) => unionWindow(group, now)).filter((item) => item.allowed);
  if (!windows.length) return emptyPresented(now);
  if (windows.every((item) => item.permanent))
    return { permanent: true, partial: false, expiresAt: null, label: null, serverNow: new Date(now).toISOString(), details: [] };
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
    serverNow: new Date(now).toISOString(),
    details: [],
  };
}

const CHANNELS = ["mcp", "agent", "webPlugins"] as const;
const CHANNEL_NAMES = { mcp: "MCP", agent: "Agent", webPlugins: "插件" } as const;

function catalogItem(access: OrganizationAccess, target: ResourceRef) {
  return access.catalog.find((item) => resourceKey(item) === resourceKey(target));
}

function isoTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function operationDetail(
  access: OrganizationAccess,
  target: ResourceRef,
  code: string,
  window: OperationWindow,
  channel: WindowDetail["channel"],
  bounds?: { operation: OperationWindow; feature: OperationWindow },
): WindowDetail {
  const item = catalogItem(access, target);
  const name = permissionName(code);
  return {
    code,
    name: channel === "operation" ? name : `${CHANNEL_NAMES[channel]} · ${name}`,
    channel,
    resourceType: target.type,
    resourceId: target.id,
    resourceName: item?.name ?? target.id,
    permanent: window.permanent,
    expiresAt: isoTime(window.expiresAt),
    ...(bounds
      ? {
          operationPermanent: bounds.operation.permanent,
          operationExpiresAt: isoTime(bounds.operation.expiresAt),
          featurePermanent: bounds.feature.allowed && bounds.feature.permanent,
          featureExpiresAt: bounds.feature.allowed ? isoTime(bounds.feature.expiresAt) : null,
          featureAllowed: bounds.feature.allowed,
        }
      : {}),
  };
}

/** Web plugins are granted on the real environment and apply to that environment's web entry. */
function pluginEnvironment(access: OrganizationAccess, target: ResourceRef): ResourceRef | null {
  if (target.type === "environment") return target;
  if (target.type !== "web_entry") return null;
  const environmentId = catalogItem(access, target)?.environmentIds[0];
  return environmentId ? { type: "environment", id: environmentId } : null;
}

/** One resource, or an environment card plus the resources linked to it. */
export function presentTargetWindow(
  access: OrganizationAccess,
  target: ResourceRef,
  codes?: string[],
  now = access.now,
): PresentedWindow {
  return presentResourceWindows(access, [target], now, codes ? new Map([[resourceKey(target), codes]]) : undefined);
}

export function presentEnvironmentWindow(
  access: OrganizationAccess,
  environmentId: string,
  now = access.now,
): PresentedWindow {
  const targets = access.catalog.filter(
    (item) => item.id === environmentId || item.environmentIds.includes(environmentId),
  );
  if (!targets.some((item) => item.type === "environment" && item.id === environmentId)) {
    targets.unshift({
      type: "environment",
      id: environmentId,
      name: access.catalog.find((item) => item.id === environmentId)?.name ?? "",
      capability: "environment",
      environmentIds: [],
      groupIds: [],
    });
  }
  return presentResourceWindows(access, targets, now);
}

function presentResourceWindows(
  access: OrganizationAccess,
  targets: ResourceRef[],
  now: number,
  codesByTarget?: Map<string, string[]>,
): PresentedWindow {
  const paths: Array<OperationPath & { code: string; resourceType: string; resourceId: string; resourceName: string }> = [];
  const details: WindowDetail[] = [];
  for (const target of targets) {
    const codes = codesByTarget?.get(resourceKey(target)) ?? useCodesFor(catalogItem(access, target)?.capability ?? (target.type === "environment" ? "environment" : ""));
    for (const code of codes) {
      const operationPaths = access.operationPaths(code, target).map((path) => ({ ...path, asOf: path.asOf ?? now }));
      const operation = unionWindow(operationPaths, now);
      if (!operation.allowed) continue;
      const item = catalogItem(access, target);
      paths.push({
        code,
        startsAt: null,
        expiresAt: operation.expiresAt,
        asOf: now,
        resourceType: target.type,
        resourceId: target.id,
        resourceName: item?.name ?? target.id,
      });
      details.push(operationDetail(access, target, code, operation, "operation"));
      for (const channel of CHANNELS) {
        if (channel === "webPlugins" && !(code === "web.view" || code === "web.use")) continue;
        const featureTarget = channel === "webPlugins" ? pluginEnvironment(access, target) : target;
        if (!featureTarget) continue;
        const feature = unionWindow(
          access.featurePaths(channel, featureTarget).map((path) => ({ ...path, asOf: path.asOf ?? now })),
          now,
        );
        const intersected = intersectWindows(operation, feature);
        details.push(operationDetail(access, target, code, intersected.allowed ? intersected : { allowed: false, permanent: false, expiresAt: null }, channel, { operation, feature }));
      }
    }
  }
  const presented = presentWindows(paths, now);
  return { ...presented, details };
}

export function webPluginInjection(
  access: OrganizationAccess,
  environmentId: string,
  entryId: string,
): { inject: boolean; label: string | null; reason: string } {
  const denied = (reason: string) => ({
    inject: false,
    label: "环境未授权 · 已禁用",
    reason,
  });
  const environment = access.catalog.find(
    (item) => item.type === "environment" && item.id === environmentId,
  );
  const entry = access.catalog.find((item) => item.type === "web_entry" && item.id === entryId);
  if (!environment || !entry || !entry.environmentIds.includes(environmentId))
    return denied("无法确定真实环境");
  const feature = unionWindow(
    access.featurePaths("webPlugins", { type: "environment", id: environmentId }),
  );
  const canOpen = access.allows("web.view", entry) || access.allows("web.use", entry);
  if (!feature.allowed || !canOpen)
    return denied(feature.allowed ? "没有该入口的数据权限" : "环境未授权");
  return { inject: true, label: null, reason: "" };
}
