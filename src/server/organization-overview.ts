import type { EnvmanDatabase } from "./database-client.js";
import { loadOrganizationAccess, roleState } from "./organization-rbac.js";
import { presentTargetWindow, serverNow } from "./organization-boundary.js";
import { resourceKey, validAt, type ResourceCatalogItem, type ResourceRef } from "../shared/organization-rbac.js";

export const RESOURCE_ENTRIES = [
  { id: "environments", label: "环境总览" },
  { id: "credentials", label: "密钥与证书" },
  { id: "ssh", label: "SSH 工作台" },
  { id: "database", label: "数据库工作台" },
  { id: "redis", label: "Redis 工作台" },
  { id: "knowledge", label: "知识库" },
] as const;

const SECRET_FIELDS = ["host", "port", "username", "password", "content", "privateKey", "publicKey", "body", "secret", "log"];

function statusOf(record: { enabled: boolean; startsAt: string | null; expiresAt: string | null }, now: number) {
  if (!record.enabled) return "disabled";
  if (record.startsAt && Date.parse(record.startsAt) > now) return "pending";
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return "expired";
  return "active";
}

export async function relatedResourceKeys(db: EnvmanDatabase, org: string, projectId: string, now = serverNow()) {
  const [state, projects, members] = await Promise.all([
    roleState(db, org),
    db.prepare("SELECT id, parent_id FROM projects WHERE organization_id = ?").all<{ id: string; parent_id: string | null }>(org),
    db
      .prepare(
        `SELECT pm.project_id, pm.user_id FROM project_members pm
         JOIN projects p ON p.id = pm.project_id WHERE p.organization_id = ?`,
      )
      .all<{ project_id: string; user_id: string }>(org),
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
  const userIds = new Set(members.filter((member) => descendants.has(member.project_id)).map((member) => member.user_id));
  const subjectOk = (type: string, id: string) =>
    type === "organization" ? id === org : type === "project" ? scope.has(id) : userIds.has(id);
  const roleIds = new Set(
    state.assignments.filter((assignment) => validAt(assignment, now) && subjectOk(assignment.subjectType, assignment.subjectId)).map((assignment) => assignment.roleId),
  );
  const dataKeys = new Set<string>();
  const keys = new Set<string>();
  for (const grant of state.dataGrants)
    if (validAt(grant, now) && roleIds.has(grant.roleId)) {
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
  const environmentItems = environments.map((item) => {
    const meta = environmentMeta.get(item.id);
    const authorized =
      access.operationPaths("environment.view", item).length > 0 ||
      access.operationPaths("environment.update", item).length > 0;
    const child = access.catalog.filter((other) => other.environmentIds.includes(item.id) && other.id !== item.id);
    const partial = !authorized && child.some((other) => access.allows("ssh.view", other) || access.allows("database.read", other) || access.allows("redis.view", other) || access.allows("web.view", other));
    return publicItem(item, {
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
    });
  });
  const connections = (type: ResourceCatalogItem["type"]) =>
    access.catalog.filter((item) => item.type === type && visible(item)).map((item) =>
      publicItem(item, {
        environments: item.environmentIds.map((id) => ({ id, name: environmentName.get(id) ?? "" })),
        operationWindow: windowFor(item),
      }),
    );
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
  const certificates = await db
    .prepare(
      "SELECT id, leaf_cn, fingerprint_sha256, not_after FROM ssl_certificates WHERE workspace_type = 'organization' AND workspace_id = ?",
    )
    .all<{ id: string; leaf_cn: string; fingerprint_sha256: string; not_after: string }>(org);
  const credentialItems = [
    ...keys
      .filter((key) => !projectId || linkedKeyIds.has(key.id))
      .map((key) => ({ type: "ssh_key", id: key.id, name: key.name, algorithm: key.algorithm, fingerprint: key.fingerprint })),
    ...(!projectId
      ? certificates.map((item) => ({
          type: "ssl_certificate",
          id: item.id,
          name: item.leaf_cn || "证书",
          fingerprint: item.fingerprint_sha256,
          notAfter: item.not_after,
        }))
      : []),
  ];
  const knowledge = access.catalog
    .filter((item) => item.type === "knowledge_node" && visible(item))
    .map((item) => publicItem(item, { operationWindow: windowFor(item) }));
  const unlinked = access.catalog.filter(
    (item) =>
      ["web_entry", "environment_log", "service", "service_deployment", "service_script"].includes(item.type) &&
      item.environmentIds.length === 0 &&
      visible(item),
  );
  const entries = [
    { ...RESOURCE_ENTRIES[0], count: environmentItems.length, items: environmentItems, unlinked: unlinked.map((item) => publicItem(item)) },
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
