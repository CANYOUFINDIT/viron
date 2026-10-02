import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { EnvmanDatabase } from "./database.js";
import { writeAudit } from "./audit.js";
import type { AuthenticatedUser } from "./access-control.js";
import {
  CAPABILITIES,
  CAPABILITY_ACTIONS,
  type Capability,
  type ItemMap,
  type PermissionMap,
  SCOPE_KINDS,
  type ScopeKind,
  connectionCapability,
  expandPermissions,
  fullPermissions,
  isCapability,
  permissionSummary,
} from "../shared/access-permissions.js";

export interface ActionScope {
  all: boolean;
  ids: Set<string>;
}

export type EnvironmentScopes = Map<string, Map<Capability, Map<string, ActionScope>>>;
export type ConnectionActionMaps = {
  ssh: Map<string, Set<string>>;
  database: Map<string, Set<string>>;
  redis: Map<string, Set<string>>;
};

export interface ResolvedOrganizationAccess {
  environmentGroupIds: Set<string>;
  environmentIds: Set<string>;
  sshConnectionIds: Set<string>;
  databaseConnectionIds: Set<string>;
  redisConnectionIds: Set<string>;
  environmentScopes: EnvironmentScopes;
  connectionActions: ConnectionActionMaps;
}

export interface AuthorizationInput {
  granteeType: "user" | "project";
  granteeId: string;
  scopeKind: ScopeKind;
  wholeGroup: boolean;
  groupId: string | null;
  targetIds: string[];
  permissions: PermissionMap;
  items: ItemMap;
  expiresAt: string | null;
}

export interface StoredAuthorization extends AuthorizationInput {
  id: string;
  legacy: boolean;
  granteeName: string;
  label: string;
  permissionText: string;
  expired: boolean;
  createdAt: string;
  resourceType: ScopeKind;
  resourceId: string;
}

export class AccessAuthorizationError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
  }
}

interface GrantSource {
  id: string;
  scopeKind: ScopeKind;
  wholeGroup: boolean;
  groupId: string | null;
  permissions: PermissionMap;
  items: ItemMap;
  targetIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function allowsEnvironmentScope(
  scopes: EnvironmentScopes,
  environmentId: string,
  capability: Capability,
  action: string,
  itemId?: string,
  requireAll = false,
): boolean {
  const scope = scopes.get(environmentId)?.get(capability)?.get(action);
  if (!scope) return false;
  if (requireAll) return scope.all;
  if (!itemId) return scope.all || scope.ids.size > 0;
  return scope.all || scope.ids.has(itemId);
}

export function environmentPermissionMap(scopes: EnvironmentScopes, environmentId: string): PermissionMap {
  const capabilities = scopes.get(environmentId);
  const result: PermissionMap = {};
  for (const capability of CAPABILITIES) {
    const actions = CAPABILITY_ACTIONS[capability].filter((action) => {
      const scope = capabilities?.get(capability)?.get(action);
      return Boolean(scope && (scope.all || scope.ids.size > 0));
    });
    if (actions.length) result[capability] = [...actions];
  }
  return result;
}

export async function resolveOrganizationAccess(db: EnvmanDatabase, user: AuthenticatedUser): Promise<ResolvedOrganizationAccess> {
  const empty = emptyResolution();
  if (user.workspace.type !== "organization") return empty;
  const projectIds = await memberProjectIds(db, user.workspace.id, user.id);
  const now = new Date().toISOString();
  const granteeSql = granteeFilter(projectIds);
  const granteeParams = [user.workspace.id, user.id, ...projectIds];
  const authorizations = await db.prepare(`
    SELECT id, scope_kind, whole_group, group_id, permissions_json, items_json
    FROM access_authorizations
    WHERE organization_id = ? AND (expires_at IS NULL OR expires_at > ?) AND ${granteeSql}
  `).all(user.workspace.id, now, user.id, ...projectIds) as Array<Record<string, unknown>>;
  const legacy = await db.prepare(`
    SELECT resource_type, resource_id FROM resource_grants
    WHERE organization_id = ? AND ${granteeSql}
  `).all(...granteeParams) as Array<{ resource_type: ScopeKind; resource_id: string }>;
  const targets = authorizations.length
    ? await db.prepare(`
      SELECT authorization_id, resource_id FROM access_authorization_targets
      WHERE authorization_id IN (${authorizations.map(() => "?").join(",")})
    `).all(...authorizations.map((row) => String(row.id))) as Array<{ authorization_id: string; resource_id: string }>
    : [];
  const targetsByAuthorization = new Map<string, string[]>();
  for (const target of targets) {
    const list = targetsByAuthorization.get(target.authorization_id) ?? [];
    list.push(target.resource_id);
    targetsByAuthorization.set(target.authorization_id, list);
  }
  const sources: GrantSource[] = authorizations.map((row) => ({
    id: String(row.id),
    scopeKind: String(row.scope_kind) as ScopeKind,
    wholeGroup: Number(row.whole_group) === 1,
    groupId: row.group_id ? String(row.group_id) : null,
    permissions: parsePermissions(row.permissions_json),
    items: parseItems(row.items_json),
    targetIds: targetsByAuthorization.get(String(row.id)) ?? [],
  }));
  for (const grant of legacy) {
    sources.push({
      id: `legacy:${grant.resource_type}:${grant.resource_id}`,
      scopeKind: grant.resource_type,
      wholeGroup: grant.resource_type === "environment_group",
      groupId: grant.resource_type === "environment_group" ? grant.resource_id : null,
      permissions: fullPermissions(grant.resource_type),
      items: {},
      targetIds: grant.resource_type === "environment_group" ? [] : [grant.resource_id],
    });
  }
  return applySources(db, user.workspace.id, sources);
}

export async function createAccessAuthorization(
  db: EnvmanDatabase,
  organizationId: string,
  actor: AuthenticatedUser,
  input: AuthorizationInput,
  request: FastifyRequest,
): Promise<string> {
  const normalized = await normalizeAuthorization(db, organizationId, input);
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await insertAuthorization(db, id, organizationId, normalized, actor.id, now, now);
    await writeAudit(db, {
      action: "resource.granted",
      resourceType: normalized.scopeKind,
      resourceId: normalized.wholeGroup ? normalized.groupId ?? id : normalized.targetIds[0] ?? id,
      summary: "分配组织资源",
      details: { grantId: id, granteeType: normalized.granteeType, granteeId: normalized.granteeId, permissions: normalized.permissions, expiresAt: normalized.expiresAt },
      request,
    });
  })();
  return id;
}

export async function updateAccessAuthorization(
  db: EnvmanDatabase,
  organizationId: string,
  grantId: string,
  actor: AuthenticatedUser,
  input: AuthorizationInput,
  request: FastifyRequest,
): Promise<{ granteeType: "user" | "project"; granteeId: string }> {
  const existing = await authorizationGrantee(db, organizationId, grantId);
  if (!existing) throw new AccessAuthorizationError("NOT_FOUND", 404, "授权不存在");
  const normalized = await normalizeAuthorization(db, organizationId, { ...input, granteeType: existing.granteeType, granteeId: existing.granteeId });
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare("DELETE FROM resource_grants WHERE id = ? AND organization_id = ?").run(grantId, organizationId);
    await db.prepare("DELETE FROM access_authorizations WHERE id = ? AND organization_id = ?").run(grantId, organizationId);
    await insertAuthorization(db, grantId, organizationId, normalized, actor.id, existing.createdAt, now);
    await writeAudit(db, {
      action: "resource.granted",
      resourceType: normalized.scopeKind,
      resourceId: normalized.wholeGroup ? normalized.groupId ?? grantId : normalized.targetIds[0] ?? grantId,
      summary: "修改组织资源授权",
      details: { grantId, granteeType: normalized.granteeType, granteeId: normalized.granteeId, permissions: normalized.permissions, expiresAt: normalized.expiresAt },
      request,
    });
  })();
  return { granteeType: existing.granteeType, granteeId: existing.granteeId };
}

export async function deleteAccessAuthorization(db: EnvmanDatabase, organizationId: string, grantId: string): Promise<{ granteeType: "user" | "project"; granteeId: string; resourceType: string; resourceId: string } | undefined> {
  const fine = await db.prepare("SELECT grantee_type, grantee_id, scope_kind, group_id, whole_group FROM access_authorizations WHERE id = ? AND organization_id = ?")
    .get(grantId, organizationId) as { grantee_type: "user" | "project"; grantee_id: string; scope_kind: string; group_id: string | null; whole_group: number } | undefined;
  if (fine) {
    const target = await db.prepare("SELECT resource_id FROM access_authorization_targets WHERE authorization_id = ? LIMIT 1").get(grantId) as { resource_id: string } | undefined;
    await db.prepare("DELETE FROM access_authorizations WHERE id = ?").run(grantId);
    return {
      granteeType: fine.grantee_type,
      granteeId: fine.grantee_id,
      resourceType: fine.scope_kind,
      resourceId: Number(fine.whole_group) === 1 ? String(fine.group_id ?? grantId) : target?.resource_id ?? grantId,
    };
  }
  const legacy = await db.prepare("SELECT grantee_type, grantee_id, resource_type, resource_id FROM resource_grants WHERE id = ? AND organization_id = ?")
    .get(grantId, organizationId) as { grantee_type: "user" | "project"; grantee_id: string; resource_type: string; resource_id: string } | undefined;
  if (!legacy) return undefined;
  await db.prepare("DELETE FROM resource_grants WHERE id = ?").run(grantId);
  return { granteeType: legacy.grantee_type, granteeId: legacy.grantee_id, resourceType: legacy.resource_type, resourceId: legacy.resource_id };
}

export async function listOrganizationGrants(db: EnvmanDatabase, organizationId: string): Promise<StoredAuthorization[]> {
  const now = new Date().toISOString();
  const fine = await db.prepare(`
    SELECT a.*, COALESCE(u.username, p.name) AS grantee_name
    FROM access_authorizations a
    LEFT JOIN admin_users u ON a.grantee_type = 'user' AND u.id = a.grantee_id
    LEFT JOIN projects p ON a.grantee_type = 'project' AND p.id = a.grantee_id
    WHERE a.organization_id = ?
  `).all(organizationId) as Array<Record<string, unknown>>;
  const targets = fine.length
    ? await db.prepare(`SELECT authorization_id, resource_id FROM access_authorization_targets WHERE authorization_id IN (${fine.map(() => "?").join(",")})`)
      .all(...fine.map((row) => String(row.id))) as Array<{ authorization_id: string; resource_id: string }>
    : [];
  const legacy = await db.prepare(`
    SELECT g.*, COALESCE(u.username, p.name) AS grantee_name
    FROM resource_grants g
    LEFT JOIN admin_users u ON g.grantee_type = 'user' AND u.id = g.grantee_id
    LEFT JOIN projects p ON g.grantee_type = 'project' AND p.id = g.grantee_id
    WHERE g.organization_id = ?
  `).all(organizationId) as Array<Record<string, unknown>>;
  const targetsById = new Map<string, string[]>();
  for (const target of targets) {
    const list = targetsById.get(target.authorization_id) ?? [];
    list.push(target.resource_id);
    targetsById.set(target.authorization_id, list);
  }
  const nameIds = {
    environment_group: new Set<string>(),
    environment: new Set<string>(),
    ssh_connection: new Set<string>(),
    database_connection: new Set<string>(),
    redis_connection: new Set<string>(),
  };
  const pending: Array<Omit<StoredAuthorization, "label">> = [];
  for (const row of fine) {
    const scopeKind = String(row.scope_kind) as ScopeKind;
    const wholeGroup = Number(row.whole_group) === 1;
    const groupId = row.group_id ? String(row.group_id) : null;
    const targetIds = targetsById.get(String(row.id)) ?? [];
    const permissions = parsePermissions(row.permissions_json);
    const expiresAt = row.expires_at ? String(row.expires_at) : null;
    if (wholeGroup && groupId) nameIds.environment_group.add(groupId);
    else for (const id of targetIds) nameIds[scopeKind].add(id);
    pending.push({
      id: String(row.id),
      legacy: false,
      granteeType: String(row.grantee_type) as "user" | "project",
      granteeId: String(row.grantee_id),
      granteeName: String(row.grantee_name ?? ""),
      scopeKind,
      wholeGroup,
      groupId,
      targetIds,
      permissions,
      items: parseItems(row.items_json),
      expiresAt,
      expired: Boolean(expiresAt && expiresAt <= now),
      createdAt: String(row.created_at),
      permissionText: permissionSummary(permissions),
      resourceType: scopeKind,
      resourceId: wholeGroup ? groupId ?? "" : targetIds[0] ?? "",
    });
  }
  for (const row of legacy) {
    const scopeKind = String(row.resource_type) as ScopeKind;
    const wholeGroup = scopeKind === "environment_group";
    const resourceId = String(row.resource_id);
    const permissions = fullPermissions(scopeKind);
    nameIds[scopeKind].add(resourceId);
    pending.push({
      id: String(row.id),
      legacy: true,
      granteeType: String(row.grantee_type) as "user" | "project",
      granteeId: String(row.grantee_id),
      granteeName: String(row.grantee_name ?? ""),
      scopeKind,
      wholeGroup,
      groupId: wholeGroup ? resourceId : null,
      targetIds: wholeGroup ? [] : [resourceId],
      permissions,
      items: {},
      expiresAt: null,
      expired: false,
      createdAt: String(row.created_at),
      permissionText: permissionSummary(permissions),
      resourceType: scopeKind,
      resourceId,
    });
  }
  const names = await loadNames(db, nameIds);
  return pending
    .map((grant) => ({ ...grant, label: grantLabel(grant, names) }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function grantCatalog(db: EnvmanDatabase, organizationId: string, environmentIds: string[]) {
  const unique = [...new Set(environmentIds)];
  if (!unique.length) return { web: [], ssh: [], logs: [], database: [], redis: [], knowledge: [], maintenance: [] };
  const rows = await db.prepare(`
    SELECT id FROM environments
    WHERE workspace_type = 'organization' AND workspace_id = ? AND id IN (${unique.map(() => "?").join(",")})
  `).all(organizationId, ...unique) as Array<{ id: string }>;
  if (rows.length !== unique.length) throw new AccessAuthorizationError("INVALID_RESOURCE", 400, "只能选择当前组织的环境");
  const marks = unique.map(() => "?").join(",");
  const [environments, web, ssh, logs, database, redis, knowledge, services, hosts] = await Promise.all([
    db.prepare(`SELECT id, name FROM environments WHERE id IN (${marks})`).all(...unique) as Promise<Array<{ id: string; name: string }>>,
    db.prepare(`SELECT id, name, environment_id FROM web_entries WHERE environment_id IN (${marks}) ORDER BY name COLLATE NOCASE`).all(...unique) as Promise<Array<Record<string, unknown>>>,
    db.prepare(`
      SELECT c.id, c.name, ce.environment_id FROM ssh_connections c
      JOIN ssh_connection_environments ce ON ce.connection_id = c.id
      WHERE ce.environment_id IN (${marks}) ORDER BY c.name COLLATE NOCASE
    `).all(...unique) as Promise<Array<Record<string, unknown>>>,
    db.prepare(`SELECT id, name, environment_id FROM environment_logs WHERE environment_id IN (${marks}) ORDER BY name COLLATE NOCASE`).all(...unique) as Promise<Array<Record<string, unknown>>>,
    db.prepare(`
      SELECT c.id, c.name, ce.environment_id FROM database_connections c
      JOIN database_connection_environments ce ON ce.connection_id = c.id
      WHERE c.profile_parent_id IS NULL AND ce.environment_id IN (${marks}) ORDER BY c.name COLLATE NOCASE
    `).all(...unique) as Promise<Array<Record<string, unknown>>>,
    db.prepare(`
      SELECT c.id, c.name, ce.environment_id FROM redis_connections c
      JOIN redis_connection_environments ce ON ce.connection_id = c.id
      WHERE ce.environment_id IN (${marks}) ORDER BY c.name COLLATE NOCASE
    `).all(...unique) as Promise<Array<Record<string, unknown>>>,
    db.prepare(`
      SELECT n.id, n.name, n.type, n.parent_id, ke.environment_id
      FROM knowledge_nodes n
      JOIN knowledge_node_environments ke ON ke.node_id = n.id
      WHERE ke.environment_id IN (${marks})
      ORDER BY n.name COLLATE NOCASE
    `).all(...unique) as Promise<Array<Record<string, unknown>>>,
    db.prepare(`SELECT id, name, environment_id FROM services WHERE environment_id IN (${marks}) ORDER BY name COLLATE NOCASE`).all(...unique) as Promise<Array<Record<string, unknown>>>,
    db.prepare(`
      SELECT c.id, c.name, ce.environment_id FROM ssh_connections c
      JOIN ssh_connection_environments ce ON ce.connection_id = c.id
      WHERE ce.environment_id IN (${marks}) ORDER BY c.name COLLATE NOCASE
    `).all(...unique) as Promise<Array<Record<string, unknown>>>,
  ]);
  const environmentName = new Map(environments.map((row) => [row.id, row.name]));
  const named = (row: Record<string, unknown>, id = String(row.id)) => ({
    id,
    name: String(row.name),
    environmentId: String(row.environment_id),
    environmentName: environmentName.get(String(row.environment_id)) ?? "",
  });
  return {
    web: web.map((row) => named(row)),
    ssh: ssh.map((row) => named(row)),
    logs: logs.map((row) => named(row)),
    database: database.map((row) => named(row)),
    redis: redis.map((row) => named(row)),
    knowledge: knowledge.map((row) => ({ ...named(row), type: String(row.type), parentId: row.parent_id ? String(row.parent_id) : null })),
    maintenance: [
      ...services.map((row) => ({ ...named(row, `service:${row.id}`), kind: "service" as const })),
      ...hosts.map((row) => ({ ...named(row, `host:${row.id}`), kind: "host" as const })),
    ],
  };
}

export async function deleteAccessTargets(db: EnvmanDatabase, resourceId: string): Promise<void> {
  const rows = await db.prepare("SELECT authorization_id FROM access_authorization_targets WHERE resource_id = ?").all(resourceId) as Array<{ authorization_id: string }>;
  await db.prepare("DELETE FROM access_authorization_targets WHERE resource_id = ?").run(resourceId);
  for (const row of rows) {
    const authorization = await db.prepare("SELECT whole_group FROM access_authorizations WHERE id = ?").get(row.authorization_id) as { whole_group: number } | undefined;
    if (!authorization || Number(authorization.whole_group) === 1) continue;
    const remaining = await db.prepare("SELECT 1 FROM access_authorization_targets WHERE authorization_id = ?").get(row.authorization_id);
    if (!remaining) await db.prepare("DELETE FROM access_authorizations WHERE id = ?").run(row.authorization_id);
  }
}

export async function deleteAccessForGroup(db: EnvmanDatabase, groupId: string): Promise<void> {
  await db.prepare("DELETE FROM access_authorizations WHERE group_id = ? AND whole_group = 1").run(groupId);
  await db.prepare("UPDATE access_authorizations SET group_id = NULL WHERE group_id = ?").run(groupId);
}

export async function deleteAccessForGrantee(db: EnvmanDatabase, organizationId: string, granteeType: "user" | "project", granteeIds: string[]): Promise<void> {
  if (!granteeIds.length) return;
  await db.prepare(`
    DELETE FROM access_authorizations
    WHERE organization_id = ? AND grantee_type = ? AND grantee_id IN (${granteeIds.map(() => "?").join(",")})
  `).run(organizationId, granteeType, ...granteeIds);
}

async function applySources(db: EnvmanDatabase, organizationId: string, sources: GrantSource[]): Promise<ResolvedOrganizationAccess> {
  const resolution = emptyResolution();
  const wholeGroupIds = new Set(sources.filter((source) => source.wholeGroup && source.groupId).map((source) => source.groupId!));
  const groupedEnvironments = wholeGroupIds.size
    ? await db.prepare(`
      SELECT id, group_id FROM environments
      WHERE workspace_type = 'organization' AND workspace_id = ? AND group_id IN (${[...wholeGroupIds].map(() => "?").join(",")})
    `).all(organizationId, ...wholeGroupIds) as Array<{ id: string; group_id: string }>
    : [];
  const environmentsByGroup = new Map<string, string[]>();
  for (const environment of groupedEnvironments) {
    const list = environmentsByGroup.get(environment.group_id) ?? [];
    list.push(environment.id);
    environmentsByGroup.set(environment.group_id, list);
  }
  for (const source of sources) {
    if (source.scopeKind === "ssh_connection" || source.scopeKind === "database_connection" || source.scopeKind === "redis_connection") {
      const capability = connectionCapability(source.scopeKind);
      const actions = expandPermissions(source.permissions)[capability] ?? [];
      const map = source.scopeKind === "ssh_connection" ? resolution.connectionActions.ssh : source.scopeKind === "database_connection" ? resolution.connectionActions.database : resolution.connectionActions.redis;
      for (const targetId of source.targetIds) addActions(map, targetId, actions);
      continue;
    }
    const environmentIds = source.wholeGroup && source.groupId
      ? environmentsByGroup.get(source.groupId) ?? []
      : source.targetIds;
    if (source.wholeGroup && source.groupId) resolution.environmentGroupIds.add(source.groupId);
    for (const environmentId of environmentIds) applyEnvironment(resolution.environmentScopes, environmentId, source.permissions, source.items);
  }
  await expandLinkedConnections(db, resolution);
  for (const environmentId of resolution.environmentScopes.keys()) resolution.environmentIds.add(environmentId);
  if (resolution.environmentIds.size) {
    const rows = await db.prepare(`SELECT id, group_id FROM environments WHERE id IN (${[...resolution.environmentIds].map(() => "?").join(",")})`)
      .all(...resolution.environmentIds) as Array<{ id: string; group_id: string | null }>;
    for (const row of rows) if (row.group_id) resolution.environmentGroupIds.add(row.group_id);
  }
  for (const [id, actions] of resolution.connectionActions.ssh) if (actions.has("view")) resolution.sshConnectionIds.add(id);
  for (const [id, actions] of resolution.connectionActions.database) if (actions.has("read")) resolution.databaseConnectionIds.add(id);
  for (const [id, actions] of resolution.connectionActions.redis) if (actions.has("view")) resolution.redisConnectionIds.add(id);
  return resolution;
}

async function expandLinkedConnections(db: EnvmanDatabase, resolution: ResolvedOrganizationAccess): Promise<void> {
  await expandCapabilityConnections(db, resolution, "ssh", "ssh_connection_environments", resolution.connectionActions.ssh);
  await expandCapabilityConnections(db, resolution, "database", "database_connection_environments", resolution.connectionActions.database);
  await expandCapabilityConnections(db, resolution, "redis", "redis_connection_environments", resolution.connectionActions.redis);
  if (!resolution.connectionActions.database.size) return;
  const parents = [...resolution.connectionActions.database.keys()];
  const profiles = await db.prepare(`SELECT id, profile_parent_id FROM database_connections WHERE profile_parent_id IN (${parents.map(() => "?").join(",")})`)
    .all(...parents) as Array<{ id: string; profile_parent_id: string }>;
  for (const profile of profiles) {
    const parentActions = resolution.connectionActions.database.get(profile.profile_parent_id);
    if (parentActions) addActions(resolution.connectionActions.database, profile.id, parentActions);
  }
}

async function expandCapabilityConnections(
  db: EnvmanDatabase,
  resolution: ResolvedOrganizationAccess,
  capability: "ssh" | "database" | "redis",
  table: string,
  target: Map<string, Set<string>>,
): Promise<void> {
  const environmentIds = [...resolution.environmentScopes.keys()].filter((environmentId) => resolution.environmentScopes.get(environmentId)?.has(capability));
  if (!environmentIds.length) return;
  const links = await db.prepare(`SELECT connection_id, environment_id FROM ${table} WHERE environment_id IN (${environmentIds.map(() => "?").join(",")})`)
    .all(...environmentIds) as Array<{ connection_id: string; environment_id: string }>;
  for (const link of links) {
    const actions = resolution.environmentScopes.get(link.environment_id)?.get(capability);
    if (!actions) continue;
    for (const [action, scope] of actions) {
      if (scope.all || scope.ids.has(link.connection_id)) addActions(target, link.connection_id, [action]);
    }
  }
}

function applyEnvironment(scopes: EnvironmentScopes, environmentId: string, permissions: PermissionMap, items: ItemMap): void {
  const expanded = expandPermissions(permissions);
  for (const capability of CAPABILITIES) {
    const actions = expanded[capability];
    if (!actions?.length) continue;
    const selected = items[capability];
    for (const action of actions) mergeScope(scopeFor(scopes, environmentId, capability, action), selected ? { all: false, ids: selected } : { all: true });
  }
}

function scopeFor(scopes: EnvironmentScopes, environmentId: string, capability: Capability, action: string): ActionScope {
  let capabilities = scopes.get(environmentId);
  if (!capabilities) scopes.set(environmentId, capabilities = new Map());
  let actions = capabilities.get(capability);
  if (!actions) capabilities.set(capability, actions = new Map());
  let scope = actions.get(action);
  if (!scope) actions.set(action, scope = { all: false, ids: new Set() });
  return scope;
}

function mergeScope(scope: ActionScope, incoming: { all: boolean; ids?: Iterable<string> }): void {
  if (scope.all) return;
  if (incoming.all) {
    scope.all = true;
    scope.ids.clear();
    return;
  }
  for (const id of incoming.ids ?? []) scope.ids.add(id);
}

function addActions(target: Map<string, Set<string>>, id: string, actions: Iterable<string>): void {
  let set = target.get(id);
  if (!set) target.set(id, set = new Set());
  for (const action of actions) set.add(action);
}

function emptyResolution(): ResolvedOrganizationAccess {
  return {
    environmentGroupIds: new Set(),
    environmentIds: new Set(),
    sshConnectionIds: new Set(),
    databaseConnectionIds: new Set(),
    redisConnectionIds: new Set(),
    environmentScopes: new Map(),
    connectionActions: { ssh: new Map(), database: new Map(), redis: new Map() },
  };
}

async function memberProjectIds(db: EnvmanDatabase, organizationId: string, userId: string): Promise<string[]> {
  const projects = await db.prepare(`
    SELECT p.id, p.parent_id, CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END AS is_member
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    WHERE p.organization_id = ?
  `).all(userId, organizationId) as Array<{ id: string; parent_id: string | null; is_member: number | string }>;
  const byId = new Map(projects.map((project) => [project.id, project]));
  const ids = new Set<string>();
  for (const project of projects) {
    if (!Number(project.is_member)) continue;
    let current: typeof project | undefined = project;
    while (current && !ids.has(current.id)) {
      ids.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
  }
  return [...ids];
}

function granteeFilter(projectIds: string[]): string {
  const userClause = "(grantee_type = 'user' AND grantee_id = ?)";
  if (!projectIds.length) return userClause;
  return `(${userClause} OR (grantee_type = 'project' AND grantee_id IN (${projectIds.map(() => "?").join(",")})))`;
}

async function normalizeAuthorization(db: EnvmanDatabase, organizationId: string, input: AuthorizationInput): Promise<AuthorizationInput> {
  if (!SCOPE_KINDS.includes(input.scopeKind)) throw new AccessAuthorizationError("INVALID_SCOPE", 400, "授权范围无效");
  const permissions = expandPermissions(sanitizePermissions(input.scopeKind, input.permissions));
  if (!Object.keys(permissions).length) throw new AccessAuthorizationError("INVALID_PERMISSIONS", 400, "至少选择一项操作");
  const targetIds = [...new Set(input.targetIds)];
  const groupId = input.groupId;
  const wholeGroup = input.wholeGroup;
  const items = sanitizeItems(input.items);
  if (input.scopeKind === "ssh_connection" || input.scopeKind === "database_connection" || input.scopeKind === "redis_connection") {
    if (wholeGroup || groupId || Object.keys(items).length) throw new AccessAuthorizationError("INVALID_SCOPE", 400, "连接授权只选择连接和对应操作");
    if (!targetIds.length) throw new AccessAuthorizationError("INVALID_RESOURCE", 400, "请选择要授权的连接");
    await assertResources(db, organizationId, input.scopeKind, targetIds);
  } else if (wholeGroup) {
    if (input.scopeKind !== "environment_group" || !groupId || targetIds.length || Object.keys(items).length) {
      throw new AccessAuthorizationError("INVALID_SCOPE", 400, "整个环境组不能再挑选具体环境或具体对象");
    }
    await assertResources(db, organizationId, "environment_group", [groupId]);
  } else {
    if (!targetIds.length) throw new AccessAuthorizationError("INVALID_RESOURCE", 400, "请选择要授权的环境");
    await assertResources(db, organizationId, "environment", targetIds);
    if (groupId) await assertResources(db, organizationId, "environment_group", [groupId]);
    await assertItems(db, targetIds, permissions, items);
  }
  const grantee = input.granteeType === "user"
    ? await db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(organizationId, input.granteeId)
    : await db.prepare("SELECT 1 FROM projects WHERE organization_id = ? AND id = ?").get(organizationId, input.granteeId);
  if (!grantee) throw new AccessAuthorizationError("INVALID_GRANTEE", 400, "授权对象不属于当前组织");
  return {
    granteeType: input.granteeType,
    granteeId: input.granteeId,
    scopeKind: wholeGroup ? "environment_group" : input.scopeKind === "environment_group" ? "environment" : input.scopeKind,
    wholeGroup,
    groupId: wholeGroup ? groupId : null,
    targetIds: wholeGroup ? [] : targetIds,
    permissions,
    items: wholeGroup || input.scopeKind.endsWith("connection") ? {} : items,
    expiresAt: normalizeExpiry(input.expiresAt),
  };
}

function sanitizePermissions(scopeKind: ScopeKind, permissions: PermissionMap): PermissionMap {
  const allowed = new Set<string>(scopeKind === "environment" || scopeKind === "environment_group" ? CAPABILITIES : [connectionCapability(scopeKind)]);
  const result: PermissionMap = {};
  for (const [capability, actions] of Object.entries(permissions)) {
    if (!isCapability(capability) || !allowed.has(capability) || !Array.isArray(actions)) continue;
    const known = new Set<string>(CAPABILITY_ACTIONS[capability]);
    const selected = actions.filter((action) => known.has(action));
    if (selected.length) result[capability] = selected;
  }
  return result;
}

function sanitizeItems(items: ItemMap): ItemMap {
  const result: ItemMap = {};
  for (const capability of CAPABILITIES) {
    const values = items[capability];
    if (!values) continue;
    if (!values.length) throw new AccessAuthorizationError("INVALID_ITEMS", 400, "指定时至少选择一个");
    result[capability] = [...new Set(values)];
  }
  return result;
}

function normalizeExpiry(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new AccessAuthorizationError("INVALID_EXPIRY", 400, "授权结束时间必须晚于现在");
  return new Date(parsed).toISOString();
}

async function assertResources(db: EnvmanDatabase, organizationId: string, kind: ScopeKind, ids: string[]): Promise<void> {
  const table = {
    environment_group: "environment_groups",
    environment: "environments",
    ssh_connection: "ssh_connections",
    database_connection: "database_connections",
    redis_connection: "redis_connections",
  }[kind];
  const rows = await db.prepare(`
    SELECT id FROM ${table}
    WHERE workspace_type = 'organization' AND workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})
  `).all(organizationId, ...ids) as Array<{ id: string }>;
  if (rows.length !== ids.length) throw new AccessAuthorizationError("INVALID_RESOURCE", 400, "只能授权当前组织的资源");
}

async function assertItems(db: EnvmanDatabase, environmentIds: string[], permissions: PermissionMap, items: ItemMap): Promise<void> {
  for (const capability of CAPABILITIES) {
    if (!permissions[capability]?.length || !items[capability]) continue;
    const values = items[capability]!;
    const marks = environmentIds.map(() => "?").join(",");
    let found = 0;
    if (capability === "maintenance") {
      const serviceIds = values.filter((id) => id.startsWith("service:")).map((id) => id.slice("service:".length));
      const hostIds = values.filter((id) => id.startsWith("host:")).map((id) => id.slice("host:".length));
      if (serviceIds.length + hostIds.length !== values.length || [...serviceIds, ...hostIds].some((id) => !UUID.test(id))) {
        throw new AccessAuthorizationError("INVALID_ITEMS", 400, "服务维护对象无效");
      }
      found += await countIds(db, `SELECT id FROM services WHERE environment_id IN (${marks}) AND id IN (${serviceIds.map(() => "?").join(",")})`, environmentIds, serviceIds);
      found += await countIds(db, `SELECT DISTINCT connection_id AS id FROM ssh_connection_environments WHERE environment_id IN (${marks}) AND connection_id IN (${hostIds.map(() => "?").join(",")})`, environmentIds, hostIds);
    } else if (capability === "knowledge") {
      if (values.some((id) => !UUID.test(id))) throw new AccessAuthorizationError("INVALID_ITEMS", 400, "知识库对象无效");
      for (const id of values) {
        const row = await db.prepare(`
          WITH RECURSIVE chain(id, parent_id, environment_id) AS (
            SELECT id, parent_id, environment_id FROM knowledge_nodes WHERE id = ?
            UNION ALL
            SELECT parent.id, parent.parent_id, parent.environment_id
            FROM knowledge_nodes parent JOIN chain ON parent.id = chain.parent_id
          )
          SELECT 1 AS ok FROM chain
          WHERE environment_id IN (${marks})
            OR EXISTS (SELECT 1 FROM knowledge_node_environments ke WHERE ke.node_id = chain.id AND ke.environment_id IN (${marks}))
          LIMIT 1
        `).get(id, ...environmentIds, ...environmentIds);
        if (row) found += 1;
      }
    } else {
      if (values.some((id) => !UUID.test(id))) throw new AccessAuthorizationError("INVALID_ITEMS", 400, "授权对象无效");
      const sql = {
        web: `SELECT id FROM web_entries WHERE environment_id IN (${marks}) AND id IN (${values.map(() => "?").join(",")})`,
        ssh: `SELECT DISTINCT connection_id AS id FROM ssh_connection_environments WHERE environment_id IN (${marks}) AND connection_id IN (${values.map(() => "?").join(",")})`,
        logs: `SELECT id FROM environment_logs WHERE environment_id IN (${marks}) AND id IN (${values.map(() => "?").join(",")})`,
        database: `SELECT DISTINCT connection_id AS id FROM database_connection_environments WHERE environment_id IN (${marks}) AND connection_id IN (${values.map(() => "?").join(",")})`,
        redis: `SELECT DISTINCT connection_id AS id FROM redis_connection_environments WHERE environment_id IN (${marks}) AND connection_id IN (${values.map(() => "?").join(",")})`,
      }[capability];
      found = await countIds(db, sql, environmentIds, values);
    }
    if (found !== values.length) throw new AccessAuthorizationError("INVALID_ITEMS", 400, "所选对象不属于这次授权的环境");
  }
}

async function countIds(db: EnvmanDatabase, sql: string, environmentIds: string[], ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.prepare(sql).all(...environmentIds, ...ids) as unknown[];
  return rows.length;
}

async function insertAuthorization(db: EnvmanDatabase, id: string, organizationId: string, input: AuthorizationInput, actorId: string, createdAt: string, updatedAt: string): Promise<void> {
  await db.prepare(`
    INSERT INTO access_authorizations (
      id, organization_id, grantee_type, grantee_id, scope_kind, whole_group, group_id,
      permissions_json, items_json, expires_at, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    organizationId,
    input.granteeType,
    input.granteeId,
    input.scopeKind,
    input.wholeGroup ? 1 : 0,
    input.groupId,
    JSON.stringify(input.permissions),
    JSON.stringify(input.items),
    input.expiresAt,
    actorId,
    createdAt,
    updatedAt,
  );
  for (const resourceId of input.targetIds) {
    await db.prepare("INSERT INTO access_authorization_targets (authorization_id, resource_id) VALUES (?, ?)").run(id, resourceId);
  }
}

async function authorizationGrantee(db: EnvmanDatabase, organizationId: string, grantId: string): Promise<{ granteeType: "user" | "project"; granteeId: string; createdAt: string } | undefined> {
  const fine = await db.prepare("SELECT grantee_type, grantee_id, created_at FROM access_authorizations WHERE id = ? AND organization_id = ?")
    .get(grantId, organizationId) as { grantee_type: "user" | "project"; grantee_id: string; created_at: string } | undefined;
  if (fine) return { granteeType: fine.grantee_type, granteeId: fine.grantee_id, createdAt: fine.created_at };
  const legacy = await db.prepare("SELECT grantee_type, grantee_id, created_at FROM resource_grants WHERE id = ? AND organization_id = ?")
    .get(grantId, organizationId) as { grantee_type: "user" | "project"; grantee_id: string; created_at: string } | undefined;
  return legacy ? { granteeType: legacy.grantee_type, granteeId: legacy.grantee_id, createdAt: legacy.created_at } : undefined;
}

function parsePermissions(value: unknown): PermissionMap {
  const parsed = parseObject(value);
  const result: PermissionMap = {};
  for (const capability of CAPABILITIES) {
    const actions = parsed[capability];
    if (Array.isArray(actions)) result[capability] = actions.filter((action): action is string => typeof action === "string");
  }
  return result;
}

function parseItems(value: unknown): ItemMap {
  const parsed = parseObject(value);
  const result: ItemMap = {};
  for (const capability of CAPABILITIES) {
    const ids = parsed[capability];
    if (Array.isArray(ids)) result[capability] = ids.filter((id): id is string => typeof id === "string");
  }
  return result;
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function loadNames(db: EnvmanDatabase, ids: Record<ScopeKind, Set<string>>): Promise<Record<ScopeKind, Map<string, string>>> {
  const tables: Record<ScopeKind, string> = {
    environment_group: "environment_groups",
    environment: "environments",
    ssh_connection: "ssh_connections",
    database_connection: "database_connections",
    redis_connection: "redis_connections",
  };
  const names = {} as Record<ScopeKind, Map<string, string>>;
  for (const kind of SCOPE_KINDS) {
    const values = [...ids[kind]];
    names[kind] = new Map();
    if (!values.length) continue;
    const rows = await db.prepare(`SELECT id, name FROM ${tables[kind]} WHERE id IN (${values.map(() => "?").join(",")})`).all(...values) as Array<{ id: string; name: string }>;
    for (const row of rows) names[kind].set(row.id, row.name);
  }
  return names;
}

function grantLabel(grant: Omit<StoredAuthorization, "label">, names: Record<ScopeKind, Map<string, string>>): string {
  if (grant.wholeGroup) return `${names.environment_group.get(grant.groupId ?? "") ?? grant.groupId ?? "环境组"}（整个组）`;
  const labels = grant.targetIds.map((id) => names[grant.scopeKind].get(id) ?? id);
  return labels.join("、") || "未命名资源";
}
