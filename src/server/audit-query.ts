import { isAuditSource } from "../shared/audit-source.js";

export interface AuditListQuery {
  actorUserId?: string;
  source?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export function parseAuditListQuery(query: AuditListQuery, defaultPageSize = 100) {
  const page = Math.min(Math.max(Number.parseInt(query.page ?? "1", 10) || 1, 1), 1_000_000);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize ?? String(defaultPageSize), 10) || defaultPageSize, 1), 500);
  return {
    actorUserId: query.actorUserId?.trim().slice(0, 128) || null,
    source: isAuditSource(query.source) ? query.source : null,
    keyword: query.q?.trim().slice(0, 200) || null,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

export function auditLikePattern(keyword: string): string {
  return `%${keyword.replace(/[!%_]/g, "!$&")}%`;
}

export function auditRetentionCutoff(retentionDays: number, now = Date.now()): string {
  return new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}
