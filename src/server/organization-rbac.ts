import { randomUUID } from "node:crypto";
import type { EnvmanDatabase } from "./database-client.js";
import type { AuthenticatedUser } from "./access-control.js";
import {
  applySources,
  allowsEnvironmentScope,
} from "./access-authorizations.js";
import {
  expandPermissions,
  fullPermissions,
  type PermissionMap,
  type ScopeKind,
} from "../shared/access-permissions.js";
import {
  PERMISSION_CODES,
  PERMISSION_DEFINITIONS,
  RESOURCE_CAPABILITIES,
  resourceKey,
  validAt,
  type OrganizationRole,
  type RoleAssignment,
  type RoleDataGrant,
  type FeatureGrant,
  type ResourceCatalogItem,
  type ResourceRef,
  type SubjectType,
  type ManagementScope,
} from "../shared/organization-rbac.js";

export class OrganizationPermissionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
const bool = (value: unknown) => Number(value) === 1;
const permissionDefinitionsByCode = new Map(PERMISSION_DEFINITIONS.map(definition => [definition.code, definition]));
const unrestricted: ManagementScope = {
  kind: "organization",
  ids: [],
  includeChildren: true,
};
export const resourceManagement: ManagementScope = {
  kind: "resources",
  ids: [],
  includeChildren: false,
};

export async function organizationResourceCatalog(
  db: EnvmanDatabase,
  org: string,
): Promise<ResourceCatalogItem[]> {
  // One round trip supplies the complete directory. Associations are grouped in memory,
  // including unlinked connections and knowledge inherited from parent folders.
  const scope = "workspace_type = 'organization' AND workspace_id = ?";
  const selects = [
    `SELECT 'environment' AS type, id, name, id AS environment_id, group_id, NULL AS parent_id FROM environments WHERE ${scope}`,
    ...([
      ["ssh_connection", "ssh_connections", "ssh_connection_environments"],
      ["database_connection", "database_connections", "database_connection_environments"],
      ["redis_connection", "redis_connections", "redis_connection_environments"],
    ] as const).map(([type, table, links]) => `SELECT '${type}' AS type, r.id, r.name, e.id AS environment_id, e.group_id, NULL AS parent_id
      FROM ${table} r LEFT JOIN ${links} l ON l.connection_id = r.id
      LEFT JOIN environments e ON e.id = l.environment_id AND e.workspace_type = 'organization' AND e.workspace_id = r.workspace_id
      WHERE r.workspace_type = 'organization' AND r.workspace_id = ?`),
    ...([
      ["web_entry", "web_entries"], ["environment_log", "environment_logs"], ["service", "services"],
    ] as const).map(([type, table]) => `SELECT '${type}' AS type, r.id, r.name, e.id AS environment_id, e.group_id, NULL AS parent_id
      FROM ${table} r JOIN environments e ON e.id = r.environment_id WHERE e.workspace_type = 'organization' AND e.workspace_id = ?`),
    `SELECT 'knowledge_node' AS type, n.id, n.name, e.id AS environment_id, e.group_id, n.parent_id
      FROM knowledge_nodes n LEFT JOIN environments e ON e.id = n.environment_id AND e.workspace_type = 'organization' AND e.workspace_id = n.workspace_id
      WHERE n.workspace_type = 'organization' AND n.workspace_id = ?`,
    `SELECT 'knowledge_node' AS type, n.id, n.name, e.id AS environment_id, e.group_id, n.parent_id
      FROM knowledge_nodes n JOIN knowledge_node_environments l ON l.node_id = n.id
      JOIN environments e ON e.id = l.environment_id AND e.workspace_type = 'organization' AND e.workspace_id = n.workspace_id
      WHERE n.workspace_type = 'organization' AND n.workspace_id = ?`,
    ...([
      ["service_deployment", "service_deployments", "display_name"], ["service_script", "service_script_actions", "name"],
    ] as const).map(([type, table, name]) => `SELECT '${type}' AS type, r.id, r.${name} AS name, e.id AS environment_id, e.group_id, NULL AS parent_id
      FROM ${table} r JOIN services s ON s.id = r.service_id JOIN environments e ON e.id = s.environment_id
      WHERE e.workspace_type = 'organization' AND e.workspace_id = ?`),
  ];
  const rows = await db.prepare(selects.join(" UNION ALL ")).all<{
    type: ResourceRef["type"]; id: string; name: string; environment_id: string | null; group_id: string | null; parent_id: string | null;
  }>(...selects.map(() => org));
  const items = new Map<string, ResourceCatalogItem>();
  const parents = new Map<string, string | null>();
  for (const row of rows) {
    const key = resourceKey(row);
    let item = items.get(key);
    if (!item) {
      item = { type: row.type, id: row.id, name: row.name || (row.type === "service_deployment" ? "服务部署" : ""), capability: RESOURCE_CAPABILITIES[row.type], environmentIds: [], groupIds: [] };
      items.set(key, item);
    }
    if (row.environment_id && !item.environmentIds.includes(row.environment_id)) item.environmentIds.push(row.environment_id);
    if (row.group_id && !item.groupIds.includes(row.group_id)) item.groupIds.push(row.group_id);
    if (row.type === "knowledge_node") parents.set(row.id, row.parent_id);
  }
  for (const item of items.values()) {
    if (item.type !== "knowledge_node") continue;
    const seen = new Set([item.id]);
    let parent = parents.get(item.id);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const inherited = items.get(`knowledge_node:${parent}`);
      inherited?.environmentIds.forEach(id => { if (!item.environmentIds.includes(id)) item.environmentIds.push(id); });
      inherited?.groupIds.forEach(id => { if (!item.groupIds.includes(id)) item.groupIds.push(id); });
      parent = parents.get(parent);
    }
  }
  const result = [...items.values()];
  // Monitoring retains its typed target even when it shares an SSH connection ID.
  for (const ssh of result.filter(item => item.type === "ssh_connection")) result.push({ ...ssh, type: "monitor_host", capability: "maintenance", name: ssh.name + " · 主机监控" });

  return result;
}

/** Same fixed scope as a direct feature grant: an environment keeps itself and the typed resources linked to it now. */
export function freezeFeatureTargets(
  catalog: Array<Pick<ResourceCatalogItem, "type" | "id" | "environmentIds">>,
  targets: ResourceRef[],
): ResourceRef[] {
  const environments = new Set(targets.filter((target) => target.type === "environment").map((target) => target.id));
  const frozen = [
    ...targets,
    ...catalog
      .filter((item) => item.environmentIds.some((id) => environments.has(id)))
      .map(({ type, id }) => ({ type, id })),
  ];
  return [...new Map(frozen.map((target) => [resourceKey(target), target])).values()];
}

export async function roleState(db: EnvmanDatabase, org: string, includeResourceGrants = true) {
  const [rs, as, ds, fs] = await Promise.all([
    db
      .prepare(
        "SELECT id, name, description, permission_codes_json, enabled, version FROM organization_roles WHERE organization_id = ? ORDER BY created_at, name",
      )
      .all<Record<string, unknown>>(org),
    db
      .prepare(
        "SELECT id, role_id, subject_type, subject_id, enabled, starts_at, expires_at, reason, management_scope_json FROM organization_role_assignments WHERE organization_id = ?",
      )
      .all<Record<string, unknown>>(org),
    includeResourceGrants ? db.prepare("SELECT id, role_id, target_type, target_id, batch_id, enabled, starts_at, expires_at, reason, source FROM organization_role_data_grants WHERE organization_id = ?").all<Record<string, unknown>>(org) : Promise.resolve([]),
    includeResourceGrants ? db.prepare("SELECT id, subject_type, subject_id, enabled, starts_at, expires_at, reason, targets_json, features_json FROM organization_feature_grants WHERE organization_id = ?").all<Record<string, unknown>>(org) : Promise.resolve([]),
  ]);
  const roles: OrganizationRole[] = rs.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    description: String(r.description),
    enabled: bool(r.enabled),
    permissionCodes: json(r.permission_codes_json, []),
    version: Number(r.version),
  }));
  const assignment = (r: Record<string, unknown>) => ({
    id: String(r.id),
    subjectType: String(r.subject_type) as SubjectType,
    subjectId: String(r.subject_id),
    enabled: bool(r.enabled),
    startsAt: r.starts_at ? String(r.starts_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    reason: String(r.reason),
  });
  const assignments: RoleAssignment[] = as.map((r) => ({
    ...assignment(r),
    roleId: String(r.role_id),
    managementScope: json(r.management_scope_json, resourceManagement),
  }));
  const dataGrants: RoleDataGrant[] = ds.map((r) => ({
    id: String(r.id),
    roleId: String(r.role_id),
    target: {
      type: String(r.target_type) as ResourceRef["type"],
      id: String(r.target_id),
    },
    batchId: String(r.batch_id),
    enabled: bool(r.enabled),
    startsAt: r.starts_at ? String(r.starts_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    reason: String(r.reason),
    source: String(r.source),
  }));
  const featureGrants: FeatureGrant[] = fs.map((r) => ({
    ...assignment(r),
    targets: json(r.targets_json, []),
    features: json(r.features_json, {
      mcp: false,
      agent: false,
      webPlugins: false,
    }),
  }));
  return { roles, assignments, dataGrants, featureGrants };
}

export async function insertRole(
  db: EnvmanDatabase,
  org: string,
  name: string,
  codes: string[],
  description = "",
) {
  const id = randomUUID(),
    now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO organization_roles (id, organization_id, name, description, permission_codes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, org, name, description, JSON.stringify(codes), now, now);
  return id;
}
export async function insertAssignment(
  db: EnvmanDatabase,
  org: string,
  roleId: string,
  subjectType: SubjectType,
  subjectId: string,
  scope: ManagementScope,
  startsAt: string | null = null,
  expiresAt: string | null = null,
  legacyId: string | null = null,
) {
  const id = randomUUID();
  await db
    .prepare(
      "INSERT INTO organization_role_assignments (id, organization_id, role_id, subject_type, subject_id, management_scope_json, starts_at, expires_at, reason, source, legacy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      org,
      roleId,
      subjectType,
      subjectId,
      JSON.stringify(scope),
      startsAt,
      expiresAt,
      legacyId ? "保留旧权限" : "角色分配",
      legacyId ? "migration" : "direct",
      legacyId,
      new Date().toISOString(),
    );
  return id;
}
export async function insertDataGrant(
  db: EnvmanDatabase,
  org: string,
  roleId: string,
  target: ResourceRef,
  batchId: string,
  startsAt: string | null,
  expiresAt: string | null,
  reason: string,
  source = "direct",
  legacyId: string | null = null,
) {
  const id = randomUUID();
  await db
    .prepare(
      "INSERT INTO organization_role_data_grants (id, organization_id, role_id, target_type, target_id, batch_id, starts_at, expires_at, reason, source, legacy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      org,
      roleId,
      target.type,
      target.id,
      batchId,
      startsAt,
      expiresAt,
      reason,
      source,
      legacyId,
      new Date().toISOString(),
    );
  return id;
}

function migrationCodes(cap: string, actions: string[]): string[] {
  const expanded =
    expandPermissions({ [cap]: actions } as PermissionMap)[
      cap as keyof PermissionMap
    ] ?? [];
  return [
    ...new Set(
      expanded.flatMap((action) =>
        action === "manage"
          ? [`resource.${cap}.configure`]
          : cap === "database" && action === "read"
            ? ["database.read", "database.export"]
            : cap === "database" && action === "write"
              ? ["database.write", "database.ddl"]
              : cap === "ssh" && action === "use"
                ? [
                    "ssh.use",
                    "ssh.browse",
                    "ssh.upload",
                    "ssh.download",
                    "ssh.delete",
                  ]
                : cap === "web" && action === "use"
                  ? ["web.use"]
                  : [`${cap}.${action}`],
      ),
    ),
  ];
}

/** Called inside the new-organization transaction, or a migration transaction. */
export async function initializeOrganizationRoles(
  db: EnvmanDatabase,
  org: string,
  newOrganization = false,
) {
  if (
    await db
      .prepare(
        "SELECT 1 FROM organization_role_migrations WHERE organization_id = ?",
      )
      .get(org)
  )
    return;
  const now = new Date().toISOString();
  const admin = await insertRole(
    db,
    org,
    "组织管理员",
    [...PERMISSION_CODES],
    "管理组织、角色及明确授权的资源。",
  );
  const member = await insertRole(
    db,
    org,
    "普通成员",
    [
      "organization.view",
      "team.view",
      "environment.catalog",
      "authorization.request",
    ],
    "浏览目录和发起申请，不自动获得资源操作权。",
  );
  await insertRole(
    db,
    org,
    "审计员",
    [
      "organization.view",
      "member.view",
      "team.view",
      "role.view",
      "authorization.view",
      "approval.view",
      "audit.view",
      "audit.export",
      "environment.catalog",
    ],
    "查看授权、审批和台账，不执行资源操作。",
  );
  await insertAssignment(
    db,
    org,
    member,
    "organization",
    org,
    unrestricted,
    null,
    null,
    "initial:members",
  );
  const members = await db
    .prepare(
      "SELECT user_id, role FROM organization_members WHERE organization_id = ?",
    )
    .all<{ user_id: string; role: string }>(org);
  for (const m of members.filter((m) => m.role === "admin"))
    await insertAssignment(
      db,
      org,
      admin,
      "user",
      m.user_id,
      unrestricted,
      null,
      null,
      "initial:admin:" + m.user_id,
    );
  const catalog = await organizationResourceCatalog(db, org);
  if (!newOrganization)
    for (const target of catalog)
      await insertDataGrant(
        db,
        org,
        admin,
        target,
        admin,
        null,
        null,
        "迁移管理员现有资源",
        "migration",
        "admin:" + resourceKey(target),
      );
  const fine = await db
    .prepare(
      "SELECT * FROM access_authorizations WHERE organization_id = ? ORDER BY created_at, id",
    )
    .all<Record<string, unknown>>(org);
  const legacy = await db
    .prepare(
      "SELECT * FROM resource_grants WHERE organization_id = ? ORDER BY created_at, id",
    )
    .all<Record<string, unknown>>(org);
  const sources = [
    ...fine.map((r) => ({ ...r, legacy: false })),
    ...legacy.map((r) => ({
      ...r,
      legacy: true,
      scope_kind: r.resource_type,
      whole_group: r.resource_type === "environment_group" ? 1 : 0,
      group_id: r.resource_type === "environment_group" ? r.resource_id : null,
      permissions_json: JSON.stringify(
        fullPermissions(r.resource_type as ScopeKind),
      ),
      items_json: "{}",
      starts_at: null,
      expires_at: null,
    })),
  ] as Array<Record<string, unknown>>;
  for (const source of sources) {
    const sourceId = String(source.id),
      scopeKind = String(source.scope_kind) as ScopeKind;
    const ids = source.legacy
      ? scopeKind === "environment_group"
        ? []
        : [String(source.resource_id)]
      : (
          await db
            .prepare(
              "SELECT resource_id FROM access_authorization_targets WHERE authorization_id = ?",
            )
            .all<{ resource_id: string }>(sourceId)
        ).map((r) => r.resource_id);
    const permissions = json<PermissionMap>(source.permissions_json, {});
    const resolved = await applySources(db, org, [
      {
        id: sourceId,
        scopeKind,
        wholeGroup: bool(source.whole_group),
        groupId: source.group_id ? String(source.group_id) : null,
        permissions,
        items: json(source.items_json, {}),
        targetIds: ids,
      },
    ]);
    for (const [cap, actions] of Object.entries(permissions)) {
      const codes = migrationCodes(cap, actions ?? []);
      if (!codes.length) continue;
      const targets = catalog.filter(
        (target) =>
          target.capability === cap &&
          (cap === "ssh" || cap === "database" || cap === "redis"
            ? resolved.connectionActions[cap].has(target.id)
            : target.environmentIds.some((e) =>
                allowsEnvironmentScope(
                  resolved.environmentScopes,
                  e,
                  cap as keyof PermissionMap,
                  (expandPermissions(permissions)[cap as keyof PermissionMap] ??
                    [])[0] ?? "view",
                  target.id,
                ),
              )),
      );
      if (!targets.length) continue;
      const roleId = await insertRole(
        db,
        org,
        `迁移${cap}授权 · ${sourceId}`,
        codes,
        "保留旧授权的对象、操作、范围和有效期，可按普通角色维护。",
      );
      const starts = source.starts_at ? String(source.starts_at) : null,
        expires = source.expires_at ? String(source.expires_at) : null;
      await insertAssignment(
        db,
        org,
        roleId,
        String(source.grantee_type) as SubjectType,
        String(source.grantee_id),
        resourceManagement,
        starts,
        expires,
        sourceId + ":" + cap,
      );
      for (const target of targets)
        await insertDataGrant(
          db,
          org,
          roleId,
          target,
          roleId,
          starts,
          expires,
          "迁移旧资源授权",
          "migration",
          sourceId + ":" + resourceKey(target),
        );
    }
  }
  const knowledge = await db
    .prepare("SELECT * FROM knowledge_node_grants WHERE organization_id = ?")
    .all<Record<string, unknown>>(org);
  const nodeRows = await db
    .prepare(
      "SELECT id, type, parent_id, created_by_user_id FROM knowledge_nodes WHERE workspace_type = 'organization' AND workspace_id = ?",
    )
    .all<{
      id: string;
      type: string;
      parent_id: string | null;
      created_by_user_id: string | null;
    }>(org);
  for (const grant of knowledge) {
    const roleId = await insertRole(
      db,
      org,
      "迁移知识授权 · " + String(grant.id),
      ["knowledge.view", "knowledge.edit"],
    );
    await insertAssignment(
      db,
      org,
      roleId,
      String(grant.grantee_type) as SubjectType,
      String(grant.grantee_id),
      resourceManagement,
      null,
      null,
      "knowledge:" + String(grant.id),
    );
    for (const node of nodeRows) {
      let current: typeof node | undefined = node;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        if (current.id === grant.node_id) {
          await insertDataGrant(
            db,
            org,
            roleId,
            { type: "knowledge_node", id: node.id },
            roleId,
            null,
            null,
            "迁移知识授权",
            "migration",
            "knowledge:" + grant.id + ":" + node.id,
          );
          break;
        }
        seen.add(current.id);
        current = nodeRows.find((n) => n.id === current!.parent_id);
      }
    }
  }
  // Existing document authors had edit access; preserve only those existing documents.
  for (const m of members) {
    const authored = nodeRows.filter(
      (n) => n.type === "document" && n.created_by_user_id === m.user_id,
    );
    if (!authored.length) continue;
    const roleId = await insertRole(
      db,
      org,
      "迁移文档作者 · " + m.user_id.slice(0, 8),
      ["knowledge.view", "knowledge.edit"],
    );
    await insertAssignment(
      db,
      org,
      roleId,
      "user",
      m.user_id,
      resourceManagement,
      null,
      null,
      "author:" + m.user_id,
    );
    for (const n of authored)
      await insertDataGrant(
        db,
        org,
        roleId,
        { type: "knowledge_node", id: n.id },
        roleId,
        null,
        null,
        "保留文档作者权限",
        "migration",
        "author:" + n.id,
      );
  }
  await db
    .prepare(
      "INSERT INTO organization_role_migrations (organization_id, version, completed_at) VALUES (?, 1, ?)",
    )
    .run(org, now);
  await db
    .prepare(
      "INSERT INTO organization_role_events (id, organization_id, actor_name, action, reason, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUID(),
      org,
      "系统",
      "权限模型迁移",
      "固定旧资源范围，功能授权初始为空",
      JSON.stringify({ version: 1, resources: catalog.length }),
      now,
    );
}
export async function ensureOrganizationRoles(db: EnvmanDatabase, org: string) {
  if (
    await db
      .prepare(
        "SELECT 1 FROM organization_role_migrations WHERE organization_id = ?",
      )
      .get(org)
  )
    return;
  await db.transaction(async () => {
    await db
      .prepare("UPDATE organizations SET updated_at = updated_at WHERE id = ?")
      .run(org);
    await initializeOrganizationRoles(db, org);
  })();
}
export async function migrateOrganizationRoles(db: EnvmanDatabase) {
  const orgs = await db
    .prepare("SELECT id FROM organizations")
    .all<{ id: string }>();
  for (const org of orgs) await ensureOrganizationRoles(db, org.id);
}

export interface OrganizationAccess {
  state: Awaited<ReturnType<typeof roleState>>;
  catalog: ResourceCatalogItem[];
  userId: string;
  permissionCodes: string[];
  applies(subjectType: SubjectType, subjectId: string): boolean;
  allows(code: string, target?: ResourceRef | string): boolean;
  now: number;
  operationPaths(
    code: string,
    target: ResourceRef,
  ): Array<{ startsAt: number | null; expiresAt: number | null; asOf: number }>;
  featurePaths(
    feature: keyof FeatureGrant["features"],
    target: ResourceRef,
  ): Array<{ startsAt: number | null; expiresAt: number | null; asOf: number }>;
  featureAllowed(
    feature: keyof FeatureGrant["features"],
    target: ResourceRef,
  ): boolean;
  /** Roles that may create the first resource of a capability in this environment. */
  maintenanceRoleIds(capability: string, environmentId: string): string[];
}
export async function loadOrganizationAccess(
  db: EnvmanDatabase,
  org: string,
  userId: string,
  now = Date.now(),
  snapshot?: Pick<OrganizationAccess, "state" | "catalog">,
): Promise<OrganizationAccess> {
  if (!snapshot) await ensureOrganizationRoles(db, org);
  const [state, catalog, projects, member, direct, maintenanceRows] = await Promise.all([
    snapshot ? Promise.resolve(snapshot.state) : roleState(db, org),
    snapshot ? Promise.resolve(snapshot.catalog) : organizationResourceCatalog(db, org),
    db
      .prepare("SELECT id, parent_id FROM projects WHERE organization_id = ?")
      .all<{ id: string; parent_id: string | null }>(org),
    db
      .prepare(
        "SELECT 1 FROM organization_members m JOIN admin_users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.user_id = ? AND u.status = 'active'",
      )
      .get(org, userId),
    db
      .prepare(
        "SELECT pm.project_id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.organization_id = ? AND pm.user_id = ?",
      )
      .all<{ project_id: string }>(org, userId),
    db
      .prepare(
        "SELECT code, target_type, target_id FROM organization_resource_maintenance WHERE organization_id = ? AND actor_id = ?",
      )
      .all<{ code: string; target_type: ResourceRef["type"]; target_id: string }>(org, userId),
  ]);
  const maintained = new Set(maintenanceRows.map((row) => `${row.code}:${row.target_type}:${row.target_id}`));
  const parentByProject = new Map(projects.map(project => [project.id, project.parent_id]));
  const ancestors = new Set<string>();
  for (const d of direct) {
    let id: string | null = d.project_id;
    while (id && !ancestors.has(id)) {
      ancestors.add(id);
      id = parentByProject.get(id) ?? null;
    }
  }
  const applies = (type: SubjectType, id: string) =>
    Boolean(member) &&
    (type === "user"
      ? id === userId
      : type === "organization"
        ? id === org
        : ancestors.has(id));
  const assignments = state.assignments.filter(
    (a) => validAt(a, now) && applies(a.subjectType, a.subjectId),
  );
  const activeRoles = new Map(
    state.roles.filter((r) => r.enabled).map((r) => [r.id, r]),
  );
  const validDataTargets = new Map<string, Set<string>>();
  const dataGrantsByTarget = new Map<string, RoleDataGrant[]>();
  for (const grant of state.dataGrants) {
    if (grant.enabled) {
      const key = resourceKey(grant.target);
      const grants = dataGrantsByTarget.get(key) ?? [];
      grants.push(grant);
      dataGrantsByTarget.set(key, grants);
    }
    if (!validAt(grant, now)) continue;
    const keys = validDataTargets.get(grant.roleId) ?? new Set<string>();
    keys.add(resourceKey(grant.target));
    validDataTargets.set(grant.roleId, keys);
  }
  const targets = new Set(catalog.map(resourceKey));
  const scopeCovers = (scope: ManagementScope, target: string) =>
    scope.kind === "organization" ||
    (scope.kind === "project" &&
      scope.ids.some((id) => {
        let current: string | null = target;
        const seen = new Set<string>();
        while (current && !seen.has(current)) {
          if (current === id) return true;
          if (!scope.includeChildren) return false;
          seen.add(current);
          current = parentByProject.get(current) ?? null;
        }
        return false;
      }));
  const allows = (code: string, target?: ResourceRef | string) => {
    const definition = permissionDefinitionsByCode.get(code);
    if (!definition || !member) return false;
    if (typeof target === "object" && !targets.has(resourceKey(target)))
      return false;
    // A creation maintenance record covers only its own configure code for this user.
    if (typeof target === "object" && maintained.has(`${code}:${target.type}:${target.id}`)) return true;
    return assignments.some((a) => {
      const r = activeRoles.get(a.roleId);
      if (!r?.permissionCodes.includes(code)) return false;
      if (definition.scope === "personal") return true;
      if (definition.scope === "organization")
        return a.managementScope.kind === "organization";
      if (definition.scope === "project")
        return scopeCovers(
          a.managementScope,
          typeof target === "string" ? target : org,
        );
      if (
        [
          "authorization.view",
          "authorization.create",
          "authorization.update",
          "authorization.revoke",
          "approval.view",
          "approval.approve",
          "approval.reject",
          "audit.view",
        ].includes(code) &&
        a.managementScope.kind === "organization"
      )
        return true;
      if (!target || typeof target === "string") return false;
      const cap = RESOURCE_CAPABILITIES[target.type];
      if (
        !["authorization", "approval", "audit", "resource"].includes(
          code.split(".")[0],
        ) &&
        code.split(".")[0] !== cap
      )
        return false;
      if (code.startsWith("resource.") && code.split(".")[1] !== cap)
        return false;
      return validDataTargets.get(a.roleId)?.has(resourceKey(target)) === true;
    });
  };
  const possibleCodes = new Set([
    ...assignments.flatMap(assignment => activeRoles.get(assignment.roleId)?.permissionCodes ?? []),
    ...maintenanceRows.map(row => row.code),
  ]);
  const permissionCodes = PERMISSION_CODES.filter(code => possibleCodes.has(code)).filter(
    (code) =>
      allows(code) ||
      catalog.some((t) => allows(code, t)) ||
      projects.some((p) => allows(code, p.id)),
  );
  const parsed = (value: string | null) => (value ? Date.parse(value) : null);
  const openInterval = (start: number | null, end: number | null) => {
    if (end !== null && end <= now) return null;
    if (start !== null && end !== null && start >= end) return null;
    return { startsAt: start, expiresAt: end, asOf: now };
  };
  const intersectRecord = (
    left: { startsAt: string | null; expiresAt: string | null },
    right: { startsAt: string | null; expiresAt: string | null },
  ) => {
    const leftStart = parsed(left.startsAt);
    const rightStart = parsed(right.startsAt);
    const leftEnd = parsed(left.expiresAt);
    const rightEnd = parsed(right.expiresAt);
    const start = leftStart === null ? rightStart : rightStart === null ? leftStart : Math.max(leftStart, rightStart);
    const end = leftEnd === null ? rightEnd : rightEnd === null ? leftEnd : Math.min(leftEnd, rightEnd);
    return openInterval(start, end);
  };
  const windowAssignments = state.assignments.filter(
    (assignment) =>
      assignment.enabled &&
      applies(assignment.subjectType, assignment.subjectId) &&
      (!assignment.expiresAt || Date.parse(assignment.expiresAt) > now),
  );
  const operationPaths = (code: string, target: ResourceRef) => {
    if (!member || !targets.has(resourceKey(target))) return [];
    const definition = permissionDefinitionsByCode.get(code);
    if (!definition || definition.scope !== "resource") return [];
    const cap = RESOURCE_CAPABILITIES[target.type];
    if (
      !["authorization", "approval", "audit", "resource"].includes(
        code.split(".")[0],
      ) &&
      code.split(".")[0] !== cap
    )
      return [];
    if (code.startsWith("resource.") && code.split(".")[1] !== cap) return [];
    const paths: Array<{ startsAt: number | null; expiresAt: number | null; asOf: number }> = [];
    for (const assignment of windowAssignments) {
      const role = activeRoles.get(assignment.roleId);
      if (!role?.permissionCodes.includes(code)) continue;
      if (
        [
          "authorization.view",
          "authorization.create",
          "authorization.update",
          "authorization.revoke",
          "approval.view",
          "approval.approve",
          "approval.reject",
          "audit.view",
        ].includes(code) &&
        assignment.managementScope.kind === "organization"
      ) {
        const interval = openInterval(parsed(assignment.startsAt), parsed(assignment.expiresAt));
        if (interval) paths.push(interval);
        continue;
      }
      for (const grant of dataGrantsByTarget.get(resourceKey(target)) ?? []) {
        if (grant.roleId !== assignment.roleId || !grant.enabled) continue;
        if (resourceKey(grant.target) !== resourceKey(target)) continue;
        const interval = intersectRecord(assignment, grant);
        if (interval) paths.push(interval);
      }
    }
    return paths;
  };
  const coversNow = (paths: Array<{ startsAt: number | null; expiresAt: number | null }>) =>
    paths.some(
      (path) =>
        (path.startsAt === null || path.startsAt <= now) &&
        (path.expiresAt === null || path.expiresAt > now),
    );
  const featureGrantsByTarget = new Map<string, FeatureGrant[]>();
  for (const grant of state.featureGrants) {
    if (!grant.enabled || !applies(grant.subjectType, grant.subjectId)) continue;
    for (const key of new Set(grant.targets.map(resourceKey))) {
      const grants = featureGrantsByTarget.get(key) ?? [];
      grants.push(grant);
      featureGrantsByTarget.set(key, grants);
    }
  }
  const featurePaths = (
    feature: keyof FeatureGrant["features"],
    target: ResourceRef,
  ) =>
    targets.has(resourceKey(target))
      ? (featureGrantsByTarget.get(resourceKey(target)) ?? []).flatMap((grant) => {
          if (!grant.enabled || !applies(grant.subjectType, grant.subjectId) || !grant.features[feature]) return [];
          if (!grant.targets.some((item) => resourceKey(item) === resourceKey(target))) return [];
          const interval = openInterval(parsed(grant.startsAt), parsed(grant.expiresAt));
          return interval ? [interval] : [];
        })
      : [];
  const maintenanceRoleIds = (capability: string, environmentId: string) => {
    const code = `resource.${capability}.configure`;
    const environmentKey = resourceKey({ type: "environment", id: environmentId });
    const existing = new Set(
      catalog
        .filter((item) => item.capability === capability && item.environmentIds.includes(environmentId))
        .map((item) => resourceKey(item)),
    );
    const ids = new Set<string>();
    for (const assignment of assignments) {
      const role = activeRoles.get(assignment.roleId);
      if (!role?.permissionCodes.includes(code)) continue;
      const granted = validDataTargets.get(assignment.roleId);
      const holdsEnvironment = granted?.has(environmentKey);
      const holdsExisting = granted && [...existing].some(key => granted.has(key));
      // Organization scope is the creator's explicit maintain code, not the admin name.
      // A data grant on this environment is the narrower configuration target.
      if (assignment.managementScope.kind === "organization" || holdsEnvironment || holdsExisting) ids.add(assignment.roleId);
    }
    return [...ids];
  };
  return {
    state,
    catalog,
    userId,
    now,
    permissionCodes,
    applies,
    allows,
    operationPaths,
    featurePaths,
    featureAllowed: (feature, target) => coversNow(featurePaths(feature, target)),
    maintenanceRoleIds,
  };
}
export async function attachOrganizationAccess(
  db: EnvmanDatabase,
  user: AuthenticatedUser,
) {
  if (user.workspace.type !== "organization") return;
  user.organizationAccess = await loadOrganizationAccess(
    db,
    user.workspace.id,
    user.id,
  );
  user.workspace.permissionCodes = user.organizationAccess.permissionCodes;
}
export async function assertOrganizationMaintainer(
  db: EnvmanDatabase,
  org: string,
) {
  const members = await db
    .prepare(
      "SELECT m.user_id FROM organization_members m JOIN admin_users u ON u.id = m.user_id WHERE m.organization_id = ? AND u.status = 'active'",
    )
    .all<{ user_id: string }>(org);
  const state = await roleState(db, org);
  const managementRoles = new Set(
    state.roles
      .filter(
        (r) =>
          r.enabled &&
          (r.permissionCodes.includes("role.update") ||
            r.permissionCodes.includes("authorization.create")),
      )
      .map((r) => r.id),
  );
  // Check every future validity boundary so a temporary sole maintainer cannot strand the organization.
  const now = Date.now();
  const boundaries = new Set([now]);
  for (const assignment of state.assignments.filter(
    (a) => a.enabled && managementRoles.has(a.roleId),
  )) {
    for (const value of [assignment.startsAt, assignment.expiresAt])
      if (value && Date.parse(value) > now) boundaries.add(Date.parse(value));
  }
  for (const time of boundaries) {
    let maintained = false;
    for (const m of members) {
      const access = await loadOrganizationAccess(db, org, m.user_id, time);
      if (
        access.allows("role.update") &&
        access.allows("authorization.create")
      ) {
        maintained = true;
        break;
      }
    }
    if (!maintained)
      throw new OrganizationPermissionError(
        "LAST_ORGANIZATION_MAINTAINER",
        409,
        "组织在当前及未来有效期内必须保留至少一名角色与全组织授权维护者",
      );
  }
}
