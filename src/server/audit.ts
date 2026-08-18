import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AuditSource } from "../shared/audit-source.js";
import type { WorkspaceType } from "./access-control.js";
import type { EnvmanDatabase } from "./database.js";

const auditSourceContext = new AsyncLocalStorage<AuditSource>();
const INTERNAL_AUDIT_SOURCE_HEADER = "x-viron-internal-audit-source";
const internalAuditSources = new Map<string, AuditSource>();

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  request?: FastifyRequest;
  actorUserId?: string | null;
  workspaceType?: WorkspaceType | null;
  workspaceId?: string | null;
  source?: AuditSource;
}

export async function runWithAuditSource<T>(source: AuditSource, callback: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const marker = randomUUID();
  internalAuditSources.set(marker, source);
  try {
    return await auditSourceContext.run(source, () => callback({ [INTERNAL_AUDIT_SOURCE_HEADER]: marker }));
  } finally {
    internalAuditSources.delete(marker);
  }
}

function internalRequestAuditSource(request: FastifyRequest): AuditSource | null {
  const marker = request.headers[INTERNAL_AUDIT_SOURCE_HEADER];
  return typeof marker === "string" ? internalAuditSources.get(marker) ?? null : null;
}

export function enterAuditSourceForRequest(request: FastifyRequest): void {
  const source = internalRequestAuditSource(request);
  if (source) auditSourceContext.enterWith(source);
}

function requestAuditSource(request: FastifyRequest | undefined): AuditSource | null {
  if (!request) return null;
  const internalSource = internalRequestAuditSource(request);
  if (internalSource) return internalSource;
  const route = request.routeOptions?.url ?? request.url.split("?", 1)[0] ?? "";
  return route === "/mcp" || route.startsWith("/mcp/") || route.startsWith("/api/v1/mcp/") ? "mcp" : "manual";
}

function auditSource(input: AuditInput): AuditSource {
  return input.source
    ?? requestAuditSource(input.request)
    ?? auditSourceContext.getStore()
    ?? (input.actorUserId ? "manual" : "system");
}

export async function writeAudit(db: EnvmanDatabase, input: AuditInput): Promise<void> {
  const requestWorkspace = input.request?.admin?.workspace;
  await db.prepare(`
    INSERT INTO audit_events (
      id, actor_user_id, workspace_type, workspace_id, source, action, resource_type, resource_id, summary, details_json, ip_address, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    input.request?.admin?.id ?? input.actorUserId ?? null,
    requestWorkspace?.type ?? input.workspaceType ?? null,
    requestWorkspace?.id ?? input.workspaceId ?? null,
    auditSource(input),
    input.action,
    input.resourceType,
    input.resourceId ?? null,
    input.summary,
    JSON.stringify(input.details ?? {}),
    input.request?.ip ?? null,
    new Date().toISOString(),
  );
}
