export const AUDIT_SOURCES = ["manual", "mcp", "system", "unknown"] as const;

export type AuditSource = typeof AUDIT_SOURCES[number];

export function isAuditSource(value: unknown): value is AuditSource {
  return typeof value === "string" && AUDIT_SOURCES.includes(value as AuditSource);
}
