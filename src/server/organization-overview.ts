import { createHash } from "node:crypto";
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
  type SubjectType,
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
    .prepare("SELECT id, name, color FROM environment_groups WHERE workspace_type = 'organization' AND workspace_id = ?")
    .all<{ id: string; name: string; color: string }>(org);
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const groupColor = new Map(groups.map((group) => [group.id, group.color]));
  const favorites = await db
    .prepare(
      `SELECT environment_id FROM environment_preferences WHERE owner_user_id = ? AND is_favorite = 1`,
    )
    .all<{ environment_id: string }>(userId);
  const favoriteIds = new Set(favorites.map((row) => row.environment_id));
  const environmentRows = await db
    .prepare("SELECT id, group_id, owner, description FROM environments WHERE workspace_type = 'organization' AND workspace_id = ?")
    .all<{ id: string; group_id: string | null; owner: string; description: string }>(org);
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
      groupColor: meta?.group_id ? groupColor.get(meta.group_id) ?? "" : "",
      description: meta?.description ?? "",
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
  const connectionGroups = await db
    .prepare("SELECT id, path FROM connection_groups WHERE workspace_type = 'organization' AND workspace_id = ?")
    .all<{ id: string; path: string }>(org);
  const connectionGroupPath = new Map(connectionGroups.map((group) => [group.id, group.path]));
  const sshMeta = new Map((await db.prepare("SELECT id, connection_group_id, ssh_key_id FROM ssh_connections WHERE workspace_type = 'organization' AND workspace_id = ?").all<{ id: string; connection_group_id: string | null; ssh_key_id: string | null }>(org)).map((row) => [row.id, row]));
  const databaseMeta = new Map((await db.prepare("SELECT id, connection_group_id, engine, default_database FROM database_connections WHERE workspace_type = 'organization' AND workspace_id = ?").all<{ id: string; connection_group_id: string | null; engine: string; default_database: string }>(org)).map((row) => [row.id, row]));
  const redisMeta = new Map((await db.prepare("SELECT id, connection_group_id, default_database FROM redis_connections WHERE workspace_type = 'organization' AND workspace_id = ?").all<{ id: string; connection_group_id: string | null; default_database: number }>(org)).map((row) => [row.id, row]));
  const webMeta = new Map((await db.prepare("SELECT id, url FROM web_entries WHERE environment_id IN (SELECT id FROM environments WHERE workspace_type = 'organization' AND workspace_id = ?)").all<{ id: string; url: string }>(org)).map((row) => [row.id, row.url]));
  const groupOf = (id: string | null | undefined) => (id ? connectionGroupPath.get(id) || "" : "");
  const connections = (type: ResourceCatalogItem["type"]) =>
    access.catalog.filter((item) => item.type === type && visible(item)).map((item) => {
      const viewCode = VIEW_CODES[item.type];
      const config = viewCode && access.allows(viewCode, item) ? safeConfig.get(resourceKey(item)) : undefined;
      const ssh = type === "ssh_connection" ? sshMeta.get(item.id) : undefined;
      const database = type === "database_connection" ? databaseMeta.get(item.id) : undefined;
      const redis = type === "redis_connection" ? redisMeta.get(item.id) : undefined;
      return present(item, {
        environments: item.environmentIds.map((id) => ({ id, name: environmentName.get(id) ?? "" })),
        groupPath: groupOf(ssh?.connection_group_id ?? database?.connection_group_id ?? redis?.connection_group_id),
        operationWindow: windowFor(item),
        ...(config ?? {}),
        ...(database && config ? { engine: database.engine, databaseName: database.default_database } : {}),
        ...(redis && config ? { databaseIndex: Number(redis.default_database) } : {}),
      });
    });
  const linkedKeyIds = new Set<string>();
  const sshRows = [...sshMeta.values()].filter((row) => row.ssh_key_id);
  const visibleSsh = new Set(connections("ssh_connection").map((item) => String(item.id)));
  const sshName = new Map(access.catalog.filter((item) => item.type === "ssh_connection").map((item) => [item.id, item.name]));
  for (const row of sshRows) if (row.ssh_key_id && (!projectId || visibleSsh.has(row.id))) linkedKeyIds.add(row.ssh_key_id);
  const keyReferences = (keyId: string) => sshRows.filter((row) => row.ssh_key_id === keyId && (!projectId || visibleSsh.has(row.id))).map((row) => {
    const target = { type: "ssh_connection" as const, id: row.id };
    const config = access.allows("ssh.view", target) ? safeConfig.get(resourceKey(target)) : undefined;
    return { type: target.type, id: row.id, name: sshName.get(row.id) ?? "", ...(config ?? {}) };
  });
  const keys = await db
    .prepare(
      "SELECT id, name, algorithm, fingerprint FROM ssh_keys WHERE workspace_type = 'organization' AND workspace_id = ?",
    )
    .all<{ id: string; name: string; algorithm: string; fingerprint: string }>(org);
  const certificateRows = await db
    .prepare(
      `SELECT c.id, c.leaf_cn, c.fingerprint_sha256, c.not_after, ep.environment_id, ep.host, ep.port
       FROM ssl_certificates c
       LEFT JOIN ssl_endpoints ep ON ep.certificate_id = c.id
       WHERE c.workspace_type = 'organization' AND c.workspace_id = ?`,
    )
    .all<{ id: string; leaf_cn: string; fingerprint_sha256: string; not_after: string; environment_id: string | null; host: string | null; port: number | null }>(org);
  const canReadCredentials = access.allows("credential.view");
  const certificates = new Map<string, { id: string; leaf_cn: string; fingerprint_sha256: string; not_after: string; environmentIds: string[]; seen: Set<string>; references: Array<{ environmentId: string; environmentName: string; host?: string; port?: number }> }>();
  for (const row of certificateRows) {
    const current = certificates.get(row.id) ?? { id: row.id, leaf_cn: row.leaf_cn, fingerprint_sha256: row.fingerprint_sha256, not_after: row.not_after, environmentIds: [], seen: new Set<string>(), references: [] };
    if (row.environment_id && !current.environmentIds.includes(row.environment_id)) current.environmentIds.push(row.environment_id);
    // Same certificate, environment, and host can still expose distinct ports.
    const endpointKey = `${row.environment_id}\0${row.host ?? ""}\0${row.port ?? ""}`;
    if (row.environment_id && !current.seen.has(endpointKey)) {
      current.seen.add(endpointKey);
      current.references.push({
        environmentId: row.environment_id,
        environmentName: environmentName.get(row.environment_id) ?? "",
        ...(canReadCredentials && row.host ? { host: row.host, port: Number(row.port) } : {}),
      });
    }
    certificates.set(row.id, current);
  }
  const visibleEnvironmentIds = new Set(environments.map((item) => item.id));
  const credentialItems = [
    ...keys
      .filter((key) => !projectId || linkedKeyIds.has(key.id))
      .map((key) => ({ type: "ssh_key", id: key.id, name: key.name, algorithm: key.algorithm, fingerprint: key.fingerprint, referenced: linkedKeyIds.has(key.id), references: keyReferences(key.id) })),
    ...[...certificates.values()]
      .filter((item) => !projectId || item.environmentIds.some((id) => visibleEnvironmentIds.has(id)))
      .map((item) => ({
        type: "ssl_certificate",
        id: item.id,
        name: item.leaf_cn || "证书",
        fingerprint: item.fingerprint_sha256,
        notAfter: item.not_after,
        environmentIds: item.environmentIds,
        referenced: item.environmentIds.length > 0,
        references: item.references,
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
        environments: item.environmentIds.map((id) => ({ id, name: environmentName.get(id) ?? "" })),
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
  const decorateLocated = (item: Record<string, unknown>) => {
    if (item.type === "web_entry" && access.allows("web.view", { type: "web_entry", id: String(item.id) })) item.url = webMeta.get(String(item.id)) ?? "";
    if (item.type === "knowledge_node") {
      const row = knowledgeById.get(String(item.id));
      item.parentId = row?.parent_id ?? null;
      item.nodeType = row?.type ?? "document";
      if (row && access.allows("knowledge.view", { type: "knowledge_node", id: String(item.id) })) item.content = row.content;
    }
    return item;
  };
  for (const environment of environmentItems as Array<{ located?: Record<string, Array<Record<string, unknown>>> }>) {
    for (const group of Object.values(environment.located ?? {})) group.forEach(decorateLocated);
  }
  const entries = [
    { ...RESOURCE_ENTRIES[0], count: environmentItems.length, items: environmentItems, unlinked: unlinked.map((item) => decorateLocated(present(item) as Record<string, unknown>)) },
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

function ancestorProjectIds(directIds: string[], parentOf: Map<string, string | null>) {
  const covered = new Set<string>();
  for (const start of directIds) {
    let id: string | null = start;
    while (id && !covered.has(id)) {
      covered.add(id);
      id = parentOf.get(id) ?? null;
    }
  }
  return covered;
}

function operationCodes(role: OrganizationRole | undefined, target: ResourceRef) {
  if (!role) return [];
  const capability = RESOURCE_CAPABILITIES[target.type];
  return role.permissionCodes.filter((code) => {
    const [head, mid] = code.split(".");
    return head === capability || (head === "resource" && mid === capability);
  });
}

function recordStatus(record: { enabled: boolean; startsAt: string | null; expiresAt: string | null }, now: number) {
  return statusOf(record, now);
}

/** Read one member's real roles, grants, and feature grants. The caller's access only decides what may be returned. */
export async function memberPermissions(db: EnvmanDatabase, org: string, viewerId: string, memberId: string) {
  const now = serverNow();
  const [viewer, target, viewerRow, memberRow, directRows, projectRows, organization] = await Promise.all([
    loadOrganizationAccess(db, org, viewerId, now),
    loadOrganizationAccess(db, org, memberId, now),
    db.prepare(
      "SELECT u.status FROM organization_members m JOIN admin_users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.user_id = ?",
    ).get<{ status: string }>(org, viewerId),
    db.prepare(
      "SELECT u.username, u.status FROM organization_members m JOIN admin_users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.user_id = ?",
    ).get<{ username: string; status: string }>(org, memberId),
    db.prepare(
      `SELECT pm.project_id FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE p.organization_id = ? AND pm.user_id = ?`,
    ).all<{ project_id: string }>(org, memberId),
    db.prepare("SELECT id, name, parent_id FROM projects WHERE organization_id = ?").all<{ id: string; name: string; parent_id: string | null }>(org),
    db.prepare("SELECT name FROM organizations WHERE id = ?").get<{ name: string }>(org),
  ]);
  if (!viewerRow || viewerRow.status !== "active")
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有查看该成员权限的权限");
  if (!memberRow) throw new OrganizationPermissionError("NOT_FOUND", 404, "成员不存在");
  const memberActive = memberRow.status === "active";
  const direct = new Set(directRows.map((row) => row.project_id));
  const covered = ancestorProjectIds([...direct], new Map(projectRows.map((project) => [project.id, project.parent_id])));
  // Active members reuse loadOrganizationAccess.applies. A disabled account still resolves the same ancestors, but nothing is usable.
  const applies = (type: SubjectType, id: string) =>
    memberActive
      ? target.applies(type, id)
      : type === "user"
        ? id === memberId
        : type === "organization"
          ? id === org
          : covered.has(id);
  const self = viewerId === memberId;
  const seeMember = viewer.allows("member.view") || [...covered].some((id) => viewer.allows("member.view", id));
  // Role and member metadata do not grant authorization.view of every target. That stays org-wide or per target, matching role-access.
  const seeMetadata = self || seeMember || viewer.allows("role.view");
  const seeEveryTarget = self || viewer.allows("authorization.view");
  const canRead = (ref: ResourceRef) => seeEveryTarget || viewer.allows("authorization.view", ref);
  const projectName = new Map(projectRows.map((project) => [project.id, project.name]));
  const subjectName = (type: SubjectType, id: string) =>
    type === "user" ? (id === memberId ? memberRow.username : "") : type === "project" ? projectName.get(id) ?? "" : id === org ? organization?.name ?? "" : "";
  const sourceOf = (type: SubjectType, id: string): "direct" | "ancestor" | "organization" =>
    type === "organization" ? "organization" : type === "project" && !direct.has(id) ? "ancestor" : "direct";
  const rolesById = new Map(target.state.roles.map((role) => [role.id, role]));
  const assignmentReasons = (role: OrganizationRole | undefined, assignment: { enabled: boolean; startsAt: string | null; expiresAt: string | null }) => {
    const reasons: string[] = [];
    if (!memberActive) reasons.push("成员已停用");
    if (!role) reasons.push("角色不存在");
    else if (!role.enabled) reasons.push("角色已停用");
    if (!assignment.enabled) reasons.push("分配已停用");
    else if (assignment.startsAt && Date.parse(assignment.startsAt) > now) reasons.push("分配尚未生效");
    else if (assignment.expiresAt && Date.parse(assignment.expiresAt) <= now) reasons.push("分配已到期");
    return reasons;
  };
  const held = target.state.assignments.filter((assignment) => applies(assignment.subjectType, assignment.subjectId));
  const heldRoleIds = new Set(held.map((assignment) => assignment.roleId));
  const assignments = held.map((assignment) => {
    const role = rolesById.get(assignment.roleId);
    const reasons = assignmentReasons(role, assignment);
    return {
      id: assignment.id,
      roleId: assignment.roleId,
      roleName: role?.name ?? "",
      subjectType: assignment.subjectType,
      subjectId: assignment.subjectId,
      subjectName: subjectName(assignment.subjectType, assignment.subjectId),
      source: sourceOf(assignment.subjectType, assignment.subjectId),
      enabled: assignment.enabled,
      startsAt: assignment.startsAt,
      expiresAt: assignment.expiresAt,
      status: recordStatus(assignment, now),
      usable: reasons.length === 0,
      invalidReason: explainInvalid(reasons),
      reasons,
    };
  });
  const dataGrants = target.state.dataGrants
    .filter((grant) => heldRoleIds.has(grant.roleId))
    .map((grant) => {
      const role = rolesById.get(grant.roleId);
      const paths = assignments.filter((assignment) => assignment.roleId === grant.roleId);
      const grantReasons: string[] = [];
      if (!paths.some((path) => path.reasons.length === 0)) {
        for (const reason of new Set(paths.flatMap((path) => path.reasons))) grantReasons.push(reason);
      }
      if (!grant.enabled) grantReasons.push("授权已停用");
      else if (grant.startsAt && Date.parse(grant.startsAt) > now) grantReasons.push("授权尚未生效");
      else if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) grantReasons.push("授权已过期");
      const item = target.catalog.find((entry) => resourceKey(entry) === resourceKey(grant.target));
      return {
        id: grant.id,
        roleId: grant.roleId,
        roleName: role?.name ?? "",
        target: { type: grant.target.type, id: grant.target.id, name: item?.name ?? "" },
        permissionCodes: operationCodes(role, grant.target),
        sources: paths.map((path) => ({ source: path.source, subjectType: path.subjectType, subjectName: path.subjectName })),
        enabled: grant.enabled,
        startsAt: grant.startsAt,
        expiresAt: grant.expiresAt,
        status: recordStatus(grant, now),
        usable: grantReasons.length === 0,
        invalidReason: explainInvalid(grantReasons),
      };
    });
  const featureGrants = target.state.featureGrants
    .filter((grant) => applies(grant.subjectType, grant.subjectId))
    .map((grant) => {
      const reasons: string[] = [];
      if (!memberActive) reasons.push("成员已停用");
      if (!grant.enabled) reasons.push("授权已停用");
      else if (grant.startsAt && Date.parse(grant.startsAt) > now) reasons.push("授权尚未生效");
      else if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) reasons.push("授权已过期");
      return {
        id: grant.id,
        subjectType: grant.subjectType,
        subjectId: grant.subjectId,
        subjectName: subjectName(grant.subjectType, grant.subjectId),
        source: sourceOf(grant.subjectType, grant.subjectId),
        features: grant.features,
        targets: grant.targets.map((item) => {
          const named = target.catalog.find((entry) => resourceKey(entry) === resourceKey(item));
          return { type: item.type, id: item.id, name: named?.name ?? "" };
        }),
        enabled: grant.enabled,
        startsAt: grant.startsAt,
        expiresAt: grant.expiresAt,
        status: recordStatus(grant, now),
        usable: reasons.length === 0,
        invalidReason: explainInvalid(reasons),
      };
    });
  const visibleData = dataGrants.filter((grant) => canRead(grant.target));
  const visibleRoleIds = new Set(visibleData.map((grant) => grant.roleId));
  const visibleAssignments = assignments.filter((assignment) => seeMetadata || visibleRoleIds.has(assignment.roleId));
  const visibleFeatures = featureGrants.flatMap((grant) => {
    const targets = grant.targets.filter((item) => canRead(item));
    if (!targets.length) return [];
    return [{ ...grant, targets, hiddenTargetCount: grant.targets.length - targets.length }];
  });
  const omitted = {
    assignments: assignments.length - visibleAssignments.length,
    dataGrants: dataGrants.length - visibleData.length,
    featureGrants: featureGrants.length - visibleFeatures.length,
  };
  // Hidden rows are not themselves permission to read another member. Directory-only viewers get 403.
  if (!seeMetadata && !visibleData.length && !visibleFeatures.length)
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有查看该成员权限的权限");
  const visibleRoles = [...new Map(visibleAssignments.map((assignment) => [assignment.roleId, rolesById.get(assignment.roleId)])).entries()]
    .flatMap(([roleId, role]) => {
      const paths = visibleAssignments.filter((assignment) => assignment.roleId === roleId);
      return [{
        id: roleId,
        name: role?.name ?? "",
        enabled: role?.enabled ?? false,
        permissionCodes: role?.permissionCodes ?? [],
        usable: paths.some((path) => path.usable),
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const partialParts = [
    omitted.assignments ? `${omitted.assignments} 条角色分配` : "",
    omitted.dataGrants ? `${omitted.dataGrants} 条数据授权` : "",
    omitted.featureGrants ? `${omitted.featureGrants} 条功能授权` : "",
  ].filter(Boolean);
  return {
    member: { id: memberId, username: memberRow.username, active: memberActive },
    effectiveRoleNames: visibleRoles.filter((role) => role.usable).map((role) => role.name),
    partialReason: partialParts.length ? `还有 ${partialParts.join("、")} 不在当前查看范围内` : null,
    roles: visibleRoles,
    assignments: visibleAssignments.map(({ reasons: _reasons, ...assignment }) => assignment),
    dataGrants: visibleData,
    featureGrants: visibleFeatures,
  };
}

function namedTarget(access: Awaited<ReturnType<typeof loadOrganizationAccess>>, target: ResourceRef) {
  return {
    type: target.type,
    id: target.id,
    name: access.catalog.find((item) => resourceKey(item) === resourceKey(target))?.name ?? "",
  };
}

function windowReason(record: { enabled: boolean; startsAt: string | null; expiresAt: string | null }, now: number) {
  if (!record.enabled) return "授权已停用";
  if (record.startsAt && Date.parse(record.startsAt) > now) return "授权尚未生效";
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return "授权已过期";
  return null;
}

function explainInvalid(parts: Array<string | null>) {
  const reasons = parts.filter((part): part is string => Boolean(part));
  return reasons.length ? reasons.join("；") : null;
}

function revisionHash(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Stable edit token for one data row. It does not include other batch rows. */
export function dataAuthorizationRevision(grant: {
  id: string;
  roleId: string;
  target: ResourceRef;
  enabled: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  reason: string;
  source: string;
  requestId: string | null;
}) {
  return revisionHash({
    kind: "data",
    id: grant.id,
    roleId: grant.roleId,
    target: { type: grant.target.type, id: grant.target.id },
    enabled: grant.enabled,
    startsAt: grant.startsAt,
    expiresAt: grant.expiresAt,
    reason: grant.reason,
    source: grant.source,
    requestId: grant.requestId,
  });
}

/** Includes every target key so a sibling split invalidates a stale editor, without returning those keys. */
export function featureAuthorizationRevision(grant: {
  id: string;
  subjectType: string;
  subjectId: string;
  enabled: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  reason: string;
  features: { mcp: boolean; agent: boolean; webPlugins: boolean };
  requestId: string | null;
  targets: ResourceRef[];
}) {
  return revisionHash({
    kind: "feature",
    id: grant.id,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    enabled: grant.enabled,
    startsAt: grant.startsAt,
    expiresAt: grant.expiresAt,
    reason: grant.reason,
    features: {
      mcp: grant.features.mcp,
      agent: grant.features.agent,
      webPlugins: grant.features.webPlugins,
    },
    requestId: grant.requestId,
    targets: grant.targets.map((item) => `${item.type}:${item.id}`).sort(),
  });
}

async function rowsByIds<T extends { id: string }>(db: EnvmanDatabase, sql: string, ids: string[], leading: string[] = []) {
  if (!ids.length) return [] as T[];
  return db.prepare(sql.replace("IN (?)", `IN (${ids.map(() => "?").join(", ")})`)).all<T>(...leading, ...ids);
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
  const matchedFeatures = access.state.featureGrants.filter((grant) => grant.targets.some((entry) => resourceKey(entry) === key));
  const matchedData = access.state.dataGrants.filter((grant) => resourceKey(grant.target) === key);
  const [dataRequestRows, featureRequestRows] = await Promise.all([
    rowsByIds<{ id: string; request_id: string | null }>(db, "SELECT id, request_id FROM organization_role_data_grants WHERE organization_id = ? AND id IN (?)", matchedData.map((grant) => grant.id), [org]),
    rowsByIds<{ id: string; request_id: string | null }>(db, "SELECT id, request_id FROM organization_feature_grants WHERE organization_id = ? AND id IN (?)", matchedFeatures.map((grant) => grant.id), [org]),
  ]);
  const dataRequestId = new Map(dataRequestRows.map((row) => [row.id, row.request_id ? String(row.request_id) : null]));
  const featureRequestId = new Map(featureRequestRows.map((row) => [row.id, row.request_id ? String(row.request_id) : null]));
  const canUpdate = access.allows("authorization.update", target);
  const canRevoke = access.allows("authorization.revoke", target);
  const maintenanceRows = await db.prepare(
    "SELECT id, actor_id, code, created_at FROM organization_resource_maintenance WHERE organization_id = ? AND target_type = ? AND target_id = ?",
  ).all<{ id: string; actor_id: string; code: string; created_at: string }>(org, target.type, target.id);
  const userIds = [...new Set([
    ...matchedFeatures.filter((grant) => grant.subjectType === "user").map((grant) => grant.subjectId),
    ...maintenanceRows.map((row) => row.actor_id),
  ])];
  const projectIds = [...new Set(matchedFeatures.filter((grant) => grant.subjectType === "project").map((grant) => grant.subjectId))];
  const organizationIds = [...new Set(matchedFeatures.filter((grant) => grant.subjectType === "organization").map((grant) => grant.subjectId))];
  const [users, members, projects, organizations] = await Promise.all([
    rowsByIds<{ id: string; username: string; status: string }>(db, "SELECT id, username, status FROM admin_users WHERE id IN (?)", userIds),
    rowsByIds<{ id: string }>(db, "SELECT user_id AS id FROM organization_members WHERE organization_id = ? AND user_id IN (?)", userIds, [org]),
    rowsByIds<{ id: string; name: string }>(db, "SELECT id, name FROM projects WHERE organization_id = ? AND id IN (?)", projectIds, [org]),
    rowsByIds<{ id: string; name: string }>(db, "SELECT id, name FROM organizations WHERE id IN (?)", organizationIds),
  ]);
  const userById = new Map(users.map((row) => [row.id, row]));
  const memberIds = new Set(members.map((row) => row.id));
  const projectById = new Map(projects.map((row) => [row.id, row.name]));
  const organizationById = new Map(organizations.map((row) => [row.id, row.name]));
  const subjectOf = (type: "user" | "project" | "organization", id: string) => {
    if (type === "user") {
      const user = userById.get(id);
      if (!user) return { name: "", enabled: false, reason: "对象不存在" };
      if (user.status !== "active") return { name: user.username, enabled: false, reason: "对象已停用" };
      if (!memberIds.has(id)) return { name: user.username, enabled: false, reason: "对象已离开组织" };
      return { name: user.username, enabled: true, reason: null };
    }
    const name = (type === "project" ? projectById : organizationById).get(id);
    if (name === undefined || (type === "organization" && id !== org)) return { name: name ?? "", enabled: false, reason: "对象不存在" };
    return { name, enabled: true, reason: null };
  };
  const dataGrants = matchedData.map((grant) => {
      const role = access.state.roles.find((entry) => entry.id === grant.roleId);
      const roleEnabled = role?.enabled ?? false;
      const requestId = dataRequestId.get(grant.id) ?? null;
      return {
        id: grant.id,
        kind: "data" as const,
        name: role?.name ?? "",
        roleId: grant.roleId,
        permissionCodes: role?.permissionCodes ?? [],
        roleEnabled,
        enabled: grant.enabled,
        reason: grant.reason,
        source: grant.source,
        origin: grant.source,
        requestId,
        status: statusOf(grant, now),
        invalidReason: explainInvalid([role ? (roleEnabled ? null : "角色已停用") : "角色不存在", windowReason(grant, now)]),
        startsAt: grant.startsAt,
        expiresAt: grant.expiresAt,
        canUpdate,
        canRevoke,
        revision: dataAuthorizationRevision({ ...grant, requestId }),
        targets: [namedTarget(access, grant.target)],
      };
    });
  const featureGrants = matchedFeatures.map((grant) => {
    const subject = subjectOf(grant.subjectType, grant.subjectId);
    const requestId = featureRequestId.get(grant.id) ?? null;
    return {
      id: grant.id,
      kind: "feature" as const,
      name: grant.reason || "功能授权",
      source: grant.subjectType,
      origin: requestId ? "request" : "direct",
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      subjectName: subject.name,
      subjectEnabled: subject.enabled,
      enabled: grant.enabled,
      reason: grant.reason,
      requestId,
      status: statusOf(grant, now),
      invalidReason: explainInvalid([subject.reason, windowReason(grant, now)]),
      startsAt: grant.startsAt,
      expiresAt: grant.expiresAt,
      features: grant.features,
      canUpdate,
      canRevoke,
      revision: featureAuthorizationRevision({ ...grant, requestId, targets: grant.targets }),
      // Edit payload is only the resource being viewed. Other targets stay on the stored record.
      targets: [namedTarget(access, target)],
    };
  });
  // Configuration maintenance is a creator path, not a role data grant or a feature grant.
  const configurationMaintenance = maintenanceRows.map((row) => ({
    id: row.id,
    kind: "maintenance" as const,
    code: row.code,
    actorId: row.actor_id,
    actorName: userById.get(row.actor_id)?.username ?? "",
    source: "maintenance" as const,
    createdAt: row.created_at,
    target: namedTarget(access, target),
  }));
  return {
    target: namedTarget(access, target),
    authorization: {
      maintain: access.allows("authorization.create", target),
      update: canUpdate,
      revoke: canRevoke,
      request: access.allows("authorization.request"),
      view: access.allows("authorization.view", target),
    },
    dataGrants,
    featureGrants,
    configurationMaintenance,
  };
}
