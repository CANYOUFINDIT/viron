import type { EnvmanDatabase } from "./database-client.js";
import { loadOrganizationAccess, OrganizationPermissionError, roleState } from "./organization-rbac.js";
import { presentTargetWindow, serverNow } from "./organization-boundary.js";
import {
  RESOURCE_CAPABILITIES,
  RESOURCE_TYPES,
  resourceKey,
  validAt,
  type OrganizationRole,
  type ResourceCatalogItem,
  type ResourceRef,
  type ResourceType,
} from "../shared/organization-rbac.js";

export const RESOURCE_ENTRIES = [
  { id: "environments", label: "环境总览" },
  { id: "credentials", label: "密钥与证书" },
  { id: "ssh", label: "SSH 工作台" },
  { id: "database", label: "数据库工作台" },
  { id: "redis", label: "Redis 工作台" },
  { id: "knowledge", label: "知识库" },
] as const;

const SECRET_FIELDS = ["password", "privateKey", "publicKey", "credential", "ciphertext", "secret", "log"];
const VIEW_CODES: Partial<Record<ResourceType, string>> = {
  ssh_connection: "ssh.view",
  database_connection: "database.read",
  redis_connection: "redis.view",
  web_entry: "web.view",
  knowledge_node: "knowledge.view",
  environment_log: "logs.view",
};

function operationApplies(role: Pick<OrganizationRole, "permissionCodes"> | undefined, target: ResourceRef) {
  if (!role) return false;
  const capability = RESOURCE_CAPABILITIES[target.type];
  return role.permissionCodes.some((code) => {
    const [head, mid] = code.split(".");
    return head === capability || (head === "resource" && mid === capability);
  });
}

function statusOf(record: { enabled: boolean; startsAt: string | null; expiresAt: string | null }, now: number) {
  if (!record.enabled) return "disabled";
  if (record.startsAt && Date.parse(record.startsAt) > now) return "pending";
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return "expired";
  return "active";
}

export async function relatedResourceKeys(db: EnvmanDatabase, org: string, projectId: string, now = serverNow()) {
  const [state, projects, members, activeMembers] = await Promise.all([
    roleState(db, org),
    db.prepare("SELECT id, parent_id FROM projects WHERE organization_id = ?").all<{ id: string; parent_id: string | null }>(org),
    db
      .prepare(
        `SELECT pm.project_id, pm.user_id FROM project_members pm
         JOIN projects p ON p.id = pm.project_id WHERE p.organization_id = ?`,
      )
      .all<{ project_id: string; user_id: string }>(org),
    db
      .prepare(
        `SELECT m.user_id FROM organization_members m
         JOIN admin_users u ON u.id = m.user_id
         WHERE m.organization_id = ? AND u.status = 'active'`,
      )
      .all<{ user_id: string }>(org),
  ]);
  const parent = new Map(projects.map((project) => [project.id, project.parent_id]));
  const ancestors = new Set<string>();
  for (let current: string | null = projectId; current && !ancestors.has(current); current = parent.get(current) ?? null)
    ancestors.add(current);
  const descendants = new Set<string>([projectId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const project of projects)
      if (project.parent_id && descendants.has(project.parent_id) && !descendants.has(project.id)) {
        descendants.add(project.id);
        grew = true;
      }
  }
  const scope = new Set([...ancestors, ...descendants]);
  const activeOrgMembers = new Set(activeMembers.map((member) => member.user_id));
  const userIds = new Set(
    members
      .filter((member) => descendants.has(member.project_id) && activeOrgMembers.has(member.user_id))
      .map((member) => member.user_id),
  );
  const subjectOk = (type: string, id: string) =>
    type === "organization" ? id === org : type === "project" ? scope.has(id) : userIds.has(id);
  const rolesById = new Map(state.roles.map((role) => [role.id, role]));
  const roleIds = new Set(
    state.assignments
      .filter((assignment) => validAt(assignment, now) && subjectOk(assignment.subjectType, assignment.subjectId) && rolesById.get(assignment.roleId)?.enabled)
      .map((assignment) => assignment.roleId),
  );
  const dataKeys = new Set<string>();
  const keys = new Set<string>();
  for (const grant of state.dataGrants)
    if (validAt(grant, now) && roleIds.has(grant.roleId) && operationApplies(rolesById.get(grant.roleId), grant.target)) {
      dataKeys.add(resourceKey(grant.target));
      keys.add(resourceKey(grant.target));
    }
  for (const grant of state.featureGrants)
    if (validAt(grant, now) && subjectOk(grant.subjectType, grant.subjectId))
      for (const target of grant.targets) keys.add(resourceKey(target));
  return { keys, dataKeys };
}

function publicItem(item: ResourceCatalogItem, extra: Record<string, unknown> = {}) {
  const safe = {
    type: item.type,
    id: item.id,
    name: item.name,
    capability: item.capability,
    environmentIds: item.environmentIds,
    ...extra,
  };
  for (const field of SECRET_FIELDS) delete (safe as Record<string, unknown>)[field];
  return safe;
}

export async function resourceOverview(db: EnvmanDatabase, org: string, userId: string, projectId?: string | null) {
  const now = serverNow();
  const access = await loadOrganizationAccess(db, org, userId, now);
  const related = projectId ? await relatedResourceKeys(db, org, projectId, now) : null;
  const visible = (item: ResourceCatalogItem) =>
    !related ||
    related.keys.has(resourceKey(item)) ||
    (item.type === "environment" &&
      access.catalog.some((other) => other.id !== item.id && related.keys.has(resourceKey(other)) && other.environmentIds.includes(item.id)));
  const environments = access.catalog.filter((item) => item.type === "environment" && visible(item));
  const environmentName = new Map(access.catalog.filter((item) => item.type === "environment").map((item) => [item.id, item.name]));
  const groups = await db
    .prepare("SELECT id, name FROM environment_groups WHERE workspace_type = 'organization' AND workspace_id = ?")
    .all<{ id: string; name: string }>(org);
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const favorites = await db
    .prepare(
      `SELECT environment_id FROM environment_preferences WHERE owner_user_id = ? AND is_favorite = 1`,
    )
    .all<{ environment_id: string }>(userId);
  const favoriteIds = new Set(favorites.map((row) => row.environment_id));
  const environmentRows = await db
    .prepare("SELECT id, group_id, owner FROM environments WHERE workspace_type = 'organization' AND workspace_id = ?")
    .all<{ id: string; group_id: string | null; owner: string }>(org);
  const environmentMeta = new Map(environmentRows.map((row) => [row.id, row]));
  const windowFor = (target: ResourceRef) => presentTargetWindow(access, target, undefined, now);
  const authorizationFor = (target: ResourceRef) => ({
    maintain: access.allows("authorization.create", target),
    request: access.allows("authorization.request"),
    view: access.allows("authorization.view", target),
  });
  const present = (item: ResourceCatalogItem, extra: Record<string, unknown> = {}) =>
    publicItem(item, { ...extra, authorization: authorizationFor(item) });
  const environmentItems = environments.map((item) => {
    const meta = environmentMeta.get(item.id);
    const authorized =
      access.operationPaths("environment.view", item).length > 0 ||
      access.operationPaths("environment.update", item).length > 0;
    const child = access.catalog.filter((other) => other.environmentIds.includes(item.id) && other.id !== item.id && visible(other));
    const partial = !authorized && child.some((other) => access.allows("ssh.view", other) || access.allows("database.read", other) || access.allows("redis.view", other) || access.allows("web.view", other));
    return present(item, {
      groupId: meta?.group_id ?? null,
      groupName: meta?.group_id ? groupName.get(meta.group_id) ?? "" : "",
      favorite: favoriteIds.has(item.id),
      ownerNote: meta?.owner ?? "",
      environmentAuthorized: authorized,
      partial,
      operationWindow: windowFor(item),
      counts: {
        web: child.filter((other) => other.type === "web_entry").length,
        ssh: child.filter((other) => other.type === "ssh_connection").length,
        database: child.filter((other) => other.type === "database_connection").length,
        redis: child.filter((other) => other.type === "redis_connection").length,
      },
      located: {
        web: child.filter((other) => other.type === "web_entry").map((other) => present(other)),
        logs: child.filter((other) => other.type === "environment_log").map((other) => present(other)),
        services: child.filter((other) => ["service", "service_deployment", "service_script", "monitor_host"].includes(other.type)).map((other) => present(other)),
        knowledge: child.filter((other) => other.type === "knowledge_node").map((other) => present(other)),
      },
    });
  });
  const safeConfig = new Map<string, { host: string; port: number; username: string }>();
  for (const [type, table] of [
    ["ssh_connection", "ssh_connections"],
    ["database_connection", "database_connections"],
    ["redis_connection", "redis_connections"],
  ] as const) {
    const rows = await db
      .prepare(`SELECT id, host, port, username FROM ${table} WHERE workspace_type = 'organization' AND workspace_id = ?`)
      .all<{ id: string; host: string; port: number; username: string }>(org);
    for (const row of rows)
      safeConfig.set(resourceKey({ type, id: row.id }), { host: row.host, port: Number(row.port), username: row.username });
  }
  const connections = (type: ResourceCatalogItem["type"]) =>
    access.catalog.filter((item) => item.type === type && visible(item)).map((item) => {
      const viewCode = VIEW_CODES[item.type];
      const config = viewCode && access.allows(viewCode, item) ? safeConfig.get(resourceKey(item)) : undefined;
      return present(item, {
        environments: item.environmentIds.map((id) => ({ id, name: environmentName.get(id) ?? "" })),
        operationWindow: windowFor(item),
        ...(config ?? {}),
      });
    });
  const linkedKeyIds = new Set<string>();
  const sshRows = await db
    .prepare("SELECT id, ssh_key_id FROM ssh_connections WHERE workspace_type = 'organization' AND workspace_id = ? AND ssh_key_id IS NOT NULL")
    .all<{ id: string; ssh_key_id: string }>(org);
  const visibleSsh = new Set(connections("ssh_connection").map((item) => item.id));
  for (const row of sshRows) if (!projectId || visibleSsh.has(row.id)) linkedKeyIds.add(row.ssh_key_id);
  const keys = await db
    .prepare(
      "SELECT id, name, algorithm, fingerprint FROM ssh_keys WHERE workspace_type = 'organization' AND workspace_id = ?",
    )
    .all<{ id: string; name: string; algorithm: string; fingerprint: string }>(org);
  const certificateRows = await db
    .prepare(
      `SELECT c.id, c.leaf_cn, c.fingerprint_sha256, c.not_after, ep.environment_id
       FROM ssl_certificates c
       LEFT JOIN ssl_endpoints ep ON ep.certificate_id = c.id
       WHERE c.workspace_type = 'organization' AND c.workspace_id = ?`,
    )
    .all<{ id: string; leaf_cn: string; fingerprint_sha256: string; not_after: string; environment_id: string | null }>(org);
  const certificates = new Map<string, { id: string; leaf_cn: string; fingerprint_sha256: string; not_after: string; environmentIds: string[] }>();
  for (const row of certificateRows) {
    const current = certificates.get(row.id) ?? { id: row.id, leaf_cn: row.leaf_cn, fingerprint_sha256: row.fingerprint_sha256, not_after: row.not_after, environmentIds: [] };
    if (row.environment_id && !current.environmentIds.includes(row.environment_id)) current.environmentIds.push(row.environment_id);
    certificates.set(row.id, current);
  }
  const visibleEnvironmentIds = new Set(environments.map((item) => item.id));
  const credentialItems = [
    ...keys
      .filter((key) => !projectId || linkedKeyIds.has(key.id))
      .map((key) => ({ type: "ssh_key", id: key.id, name: key.name, algorithm: key.algorithm, fingerprint: key.fingerprint, referenced: linkedKeyIds.has(key.id) })),
    ...[...certificates.values()]
      .filter((item) => !projectId || item.environmentIds.some((id) => visibleEnvironmentIds.has(id)))
      .map((item) => ({
        type: "ssl_certificate",
        id: item.id,
        name: item.leaf_cn || "证书",
        fingerprint: item.fingerprint_sha256,
        notAfter: item.not_after,
        environmentIds: item.environmentIds,
      })),
  ];
  const knowledgeRows = await db
    .prepare("SELECT id, parent_id, type, content FROM knowledge_nodes WHERE workspace_type = 'organization' AND workspace_id = ?")
    .all<{ id: string; parent_id: string | null; type: string; content: string }>(org);
  const knowledgeById = new Map(knowledgeRows.map((row) => [row.id, row]));
  const knowledge = access.catalog
    .filter((item) => item.type === "knowledge_node" && visible(item))
    .map((item) => {
      const row = knowledgeById.get(item.id);
      const readable = access.allows("knowledge.view", item);
      return present(item, {
        parentId: row?.parent_id ?? null,
        nodeType: row?.type ?? "document",
        kind: row?.type ?? "document",
        operationWindow: windowFor(item),
        ...(readable && row ? { content: row.content } : {}),
      });
    });
  const unlinked = access.catalog.filter(
    (item) =>
      ["web_entry", "environment_log", "service", "service_deployment", "service_script"].includes(item.type) &&
      item.environmentIds.length === 0 &&
      visible(item),
  );
  const entries = [
    { ...RESOURCE_ENTRIES[0], count: environmentItems.length, items: environmentItems, unlinked: unlinked.map((item) => present(item)) },
    { ...RESOURCE_ENTRIES[1], count: credentialItems.length, items: credentialItems },
    { ...RESOURCE_ENTRIES[2], count: connections("ssh_connection").length, items: connections("ssh_connection") },
    { ...RESOURCE_ENTRIES[3], count: connections("database_connection").length, items: connections("database_connection") },
    { ...RESOURCE_ENTRIES[4], count: connections("redis_connection").length, items: connections("redis_connection") },
    { ...RESOURCE_ENTRIES[5], count: knowledge.length, items: knowledge },
  ];
  return { entries, projectId: projectId ?? null };
}

export async function personalAuthorization(db: EnvmanDatabase, org: string, userId: string) {
  const now = serverNow();
  const access = await loadOrganizationAccess(db, org, userId, now);
  const heldRoleIds = new Set(
    access.state.assignments.filter((assignment) => access.applies(assignment.subjectType, assignment.subjectId)).map((assignment) => assignment.roleId),
  );
  const roles = access.state.assignments
    .filter((assignment) => access.applies(assignment.subjectType, assignment.subjectId))
    .map((assignment) => {
      const role = access.state.roles.find((item) => item.id === assignment.roleId);
      return {
        id: assignment.id,
        roleId: assignment.roleId,
        name: role?.name ?? "",
        permissionCodes: role?.permissionCodes ?? [],
        source: assignment.subjectType === "user" ? "direct" : "inherited",
        subjectType: assignment.subjectType,
        subjectId: assignment.subjectId,
        startsAt: assignment.startsAt,
        expiresAt: assignment.expiresAt,
        status: statusOf(assignment, now),
        managesResources: (role?.permissionCodes ?? []).some((code) => code.includes(".") && !code.startsWith("authorization.") && !code.startsWith("approval.") && !code.startsWith("audit.") && !code.startsWith("organization.") && !code.startsWith("member.") && !code.startsWith("team.")),
      };
    });
  const dataGrants = access.state.dataGrants
    .filter((grant) => heldRoleIds.has(grant.roleId))
    .map((grant) => ({
      id: grant.id,
      roleId: grant.roleId,
      roleName: access.state.roles.find((role) => role.id === grant.roleId)?.name ?? "",
      target: grant.target,
      name: access.catalog.find((item) => resourceKey(item) === resourceKey(grant.target))?.name ?? "",
      startsAt: grant.startsAt,
      expiresAt: grant.expiresAt,
      status: statusOf(grant, now),
      source: "role",
    }));
  const featureGrants = access.state.featureGrants
    .filter((grant) => access.applies(grant.subjectType, grant.subjectId))
    .map((grant) => ({
      id: grant.id,
      targets: grant.targets,
      features: grant.features,
      source: grant.subjectType === "user" ? "direct" : "inherited",
      subjectType: grant.subjectType,
      startsAt: grant.startsAt,
      expiresAt: grant.expiresAt,
      status: statusOf(grant, now),
    }));
  return { roles, dataGrants, featureGrants };
}

function namedTarget(access: Awaited<ReturnType<typeof loadOrganizationAccess>>, target: ResourceRef) {
  return {
    type: target.type,
    id: target.id,
    name: access.catalog.find((item) => resourceKey(item) === resourceKey(target))?.name ?? "",
  };
}

/** Read-only authorization rows for one resource. Does not return the organization's other records. */
export async function resourceAuthorization(db: EnvmanDatabase, org: string, userId: string, target: ResourceRef) {
  if (!RESOURCE_TYPES.includes(target.type))
    throw new OrganizationPermissionError("INVALID_RESOURCE", 400, "资源类型无效");
  const now = serverNow();
  const access = await loadOrganizationAccess(db, org, userId, now);
  const item = access.catalog.find((entry) => resourceKey(entry) === resourceKey(target));
  if (!item) throw new OrganizationPermissionError("NOT_FOUND", 404, "资源不存在");
  if (!access.allows("authorization.view", target))
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有查看该资源授权的权限");
  const key = resourceKey(target);
  const dataGrants = access.state.dataGrants
    .filter((grant) => resourceKey(grant.target) === key)
    .map((grant) => ({
      id: grant.id,
      kind: "data" as const,
      name: access.state.roles.find((role) => role.id === grant.roleId)?.name ?? "",
      roleId: grant.roleId,
      source: grant.source,
      status: statusOf(grant, now),
      startsAt: grant.startsAt,
      expiresAt: grant.expiresAt,
      targets: [namedTarget(access, grant.target)],
    }));
  const featureGrants = access.state.featureGrants
    .filter((grant) => grant.targets.some((entry) => resourceKey(entry) === key))
    .map((grant) => ({
      id: grant.id,
      kind: "feature" as const,
      name: grant.reason || "功能授权",
      source: grant.subjectType === "user" ? "direct" : "inherited",
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      status: statusOf(grant, now),
      startsAt: grant.startsAt,
      expiresAt: grant.expiresAt,
      features: grant.features,
      targets: grant.targets.map((entry) => namedTarget(access, entry)),
    }));
  return {
    target: namedTarget(access, target),
    authorization: {
      maintain: access.allows("authorization.create", target),
      request: access.allows("authorization.request"),
      view: access.allows("authorization.view", target),
    },
    dataGrants,
    featureGrants,
  };
}
