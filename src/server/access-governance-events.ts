import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AccessEventAction, AccessGovernanceEvent, AccessGrantSnapshot } from "../shared/access-governance.js";
import { fullPermissions, permissionSummary, type ScopeKind } from "../shared/access-permissions.js";
import type { EnvmanDatabase } from "./database.js";

const scopeTables: Record<ScopeKind, string> = {
  environment_group: "environment_groups", environment: "environments", ssh_connection: "ssh_connections",
  database_connection: "database_connections", redis_connection: "redis_connections",
};

type SnapshotInput = Omit<AccessGrantSnapshot, "granteeName" | "label" | "permissionText">;

export async function authorizationSnapshot(db: EnvmanDatabase, input: SnapshotInput): Promise<AccessGrantSnapshot> {
  const grantee = input.granteeType === "user"
    ? await db.prepare("SELECT username AS name FROM admin_users WHERE id = ?").get<{ name: string }>(input.granteeId)
    : await db.prepare("SELECT name FROM projects WHERE id = ?").get<{ name: string }>(input.granteeId);
  const ids = input.wholeGroup && input.groupId ? [input.groupId] : input.targetIds;
  const table = input.scopeKind === "knowledge_node" ? "knowledge_nodes" : scopeTables[input.wholeGroup ? "environment_group" : input.scopeKind];
  const resources = ids.length ? await db.prepare(`SELECT id, name FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`).all<{ id: string; name: string }>(...ids) : [];
  const names = new Map(resources.map((row) => [row.id, row.name]));
  const itemNames: NonNullable<AccessGrantSnapshot["itemNames"]> = {};
  const itemTables: Record<string, string> = { web: "web_entries", ssh: "ssh_connections", logs: "environment_logs",
    database: "database_connections", redis: "redis_connections", knowledge: "knowledge_nodes" };
  for (const [capability, selected] of Object.entries(input.items)) {
    if (!selected?.length) continue;
    if (capability === "maintenance") {
      itemNames[capability] = [];
      for (const id of selected) {
        const [kind, resourceId] = id.split(":");
        const row = await db.prepare(`SELECT name FROM ${kind === "service" ? "services" : "ssh_connections"} WHERE id = ?`).get<{ name: string }>(resourceId);
        itemNames[capability]!.push({ id, name: row?.name ?? id });
      }
    } else if (itemTables[capability]) {
      const rows = await db.prepare(`SELECT id, name FROM ${itemTables[capability]} WHERE id IN (${selected.map(() => "?").join(",")})`).all<{ id: string; name: string }>(...selected);
      const byId = new Map(rows.map((row) => [row.id, row.name]));
      itemNames[capability] = selected.map((id) => ({ id, name: byId.get(id) ?? id }));
    }
  }
  return { ...input, granteeName: grantee?.name ?? input.granteeId,
    label: ids.map((id) => names.get(id) ?? id).join("、") + (input.wholeGroup ? "（整个组）" : ""),
    itemNames, permissionText: permissionSummary(input.permissions) };
}

export async function readGrantSnapshot(db: EnvmanDatabase, organizationId: string, grantId: string): Promise<AccessGrantSnapshot | null> {
  const fine = await db.prepare("SELECT * FROM access_authorizations WHERE organization_id = ? AND id = ?").get<Record<string, unknown>>(organizationId, grantId);
  if (fine) {
    const targets = await db.prepare("SELECT resource_id FROM access_authorization_targets WHERE authorization_id = ? ORDER BY resource_id").all<{ resource_id: string }>(grantId);
    return authorizationSnapshot(db, {
      granteeType: fine.grantee_type as "user" | "project", granteeId: String(fine.grantee_id),
      scopeKind: fine.scope_kind as ScopeKind, wholeGroup: Number(fine.whole_group) === 1,
      groupId: fine.group_id ? String(fine.group_id) : null, targetIds: targets.map((row) => row.resource_id),
      permissions: JSON.parse(String(fine.permissions_json)), items: JSON.parse(String(fine.items_json)),
      expiresAt: fine.expires_at ? String(fine.expires_at) : null,
    });
  }
  const legacy = await db.prepare("SELECT * FROM resource_grants WHERE organization_id = ? AND id = ?").get<Record<string, unknown>>(organizationId, grantId);
  if (legacy) {
    const scopeKind = legacy.resource_type as ScopeKind;
    return authorizationSnapshot(db, { granteeType: legacy.grantee_type as "user" | "project", granteeId: String(legacy.grantee_id),
      scopeKind, wholeGroup: scopeKind === "environment_group", groupId: scopeKind === "environment_group" ? String(legacy.resource_id) : null,
      targetIds: scopeKind === "environment_group" ? [] : [String(legacy.resource_id)], permissions: fullPermissions(scopeKind), items: {}, expiresAt: null });
  }
  const knowledge = await db.prepare("SELECT * FROM knowledge_node_grants WHERE organization_id = ? AND id = ?").get<Record<string, unknown>>(organizationId, grantId);
  return knowledge ? authorizationSnapshot(db, { granteeType: knowledge.grantee_type as "user" | "project", granteeId: String(knowledge.grantee_id),
    scopeKind: "knowledge_node", wholeGroup: false, groupId: null, targetIds: [String(knowledge.node_id)],
    permissions: { knowledge: ["view", "edit"] }, items: {}, expiresAt: null }) : null;
}

export async function recordAccessEvent(db: EnvmanDatabase, organizationId: string, input: {
  id?: string; action: AccessEventAction; grantId?: string | null; requestId?: string | null;
  source?: AccessGovernanceEvent["source"]; reason: string; before?: AccessGrantSnapshot | null; after?: AccessGrantSnapshot | null;
  details?: Record<string, unknown>; request?: FastifyRequest; actorId?: string | null; actorName?: string; createdAt?: string;
}): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO access_governance_events
    (id, organization_id, request_id, grant_id, action, source, actor_id, actor_name, reason, before_json, after_json, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.id ?? randomUUID(), organizationId, input.requestId ?? null, input.grantId ?? null, input.action,
      input.source ?? (input.request ? "direct" : "system"), input.request?.admin?.id ?? input.actorId ?? null,
      input.request?.admin?.username ?? input.actorName ?? "系统", input.reason,
      input.before ? JSON.stringify(input.before) : null, input.after ? JSON.stringify(input.after) : null,
      JSON.stringify({ ...input.details, ...(input.request ? { ipAddress: input.request.ip, route: input.request.routeOptions.url } : {}) }), input.createdAt ?? new Date().toISOString());
}

export function accessEvent(row: Record<string, unknown>): AccessGovernanceEvent {
  return { id: String(row.id), requestId: row.request_id ? String(row.request_id) : null, grantId: row.grant_id ? String(row.grant_id) : null,
    action: row.action as AccessEventAction, source: row.source as AccessGovernanceEvent["source"], actorId: row.actor_id ? String(row.actor_id) : null,
    actorName: String(row.actor_name), reason: String(row.reason), before: row.before_json ? JSON.parse(String(row.before_json)) : null,
    after: row.after_json ? JSON.parse(String(row.after_json)) : null, details: JSON.parse(String(row.details_json)), createdAt: String(row.created_at) };
}

// A baseline describes the state we found during upgrade, not a reconstructed historical decision.
export async function backfillAccessGovernance(db: EnvmanDatabase): Promise<void> {
  for (const table of ["access_authorizations", "resource_grants", "knowledge_node_grants"]) {
    const rows = await db.prepare(`SELECT g.id, g.organization_id, g.created_by_user_id, u.username FROM ${table} g
      LEFT JOIN admin_users u ON u.id = g.created_by_user_id
      WHERE NOT EXISTS (SELECT 1 FROM access_governance_events e WHERE e.grant_id = g.id)`)
      .all<{ id: string; organization_id: string; created_by_user_id: string; username: string }>();
    for (const row of rows) {
      const snapshot = await readGrantSnapshot(db, row.organization_id, row.id);
      if (snapshot) await recordAccessEvent(db, row.organization_id, { id: `baseline:${row.id}`, action: "imported", grantId: row.id,
        reason: "升级时导入现有授权，早期审批过程不可追溯", after: snapshot,
        actorId: row.created_by_user_id, actorName: row.username, details: { baseline: true } });
    }
  }
}

export async function recordExpiredAccess(db: EnvmanDatabase): Promise<void> {
  await db.transaction(async () => {
    const rows = await db.prepare(`SELECT a.id, a.organization_id, a.expires_at FROM access_authorizations a
      WHERE a.expires_at <= ? AND NOT EXISTS (SELECT 1 FROM access_governance_events e
        WHERE e.grant_id = a.id AND e.action = 'expired' AND e.created_at >= a.updated_at)`)
      .all<{ id: string; organization_id: string; expires_at: string }>(new Date().toISOString());
    for (const row of rows) {
      const snapshot = await readGrantSnapshot(db, row.organization_id, row.id);
      if (snapshot) await recordAccessEvent(db, row.organization_id, {
        id: createHash("sha256").update(`expiry:${row.id}:${row.expires_at}`).digest("hex"), action: "expired", grantId: row.id,
        reason: "授权期限届满，权限自动失效", before: snapshot, after: snapshot, details: { expiresAt: row.expires_at } });
    }
  })();
}

export async function recordGranteeRevocations(db: EnvmanDatabase, organizationId: string, granteeType: "user" | "project", granteeIds: string[], reason: string, request: FastifyRequest): Promise<void> {
  if (!granteeIds.length) return;
  for (const table of ["access_authorizations", "resource_grants", "knowledge_node_grants"]) {
    const rows = await db.prepare(`SELECT id FROM ${table} WHERE organization_id = ? AND grantee_type = ? AND grantee_id IN (${granteeIds.map(() => "?").join(",")})`).all<{ id: string }>(organizationId, granteeType, ...granteeIds);
    for (const row of rows) await recordAccessEvent(db, organizationId, { action: "revoked", grantId: row.id, reason,
      before: await readGrantSnapshot(db, organizationId, row.id), request });
  }
}
