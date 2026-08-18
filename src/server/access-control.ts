import type { FastifyRequest } from "fastify";
import type { EnvmanDatabase } from "./database.js";

export type WorkspaceType = "personal" | "organization";
export type OrganizationRole = "admin" | "member";

export interface WorkspaceContext {
  type: WorkspaceType;
  id: string;
  name: string;
  role: "owner" | OrganizationRole;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  isPlatformAdmin: boolean;
  workspace: WorkspaceContext;
}

export interface WorkspaceAccess {
  canManage: boolean;
  environmentGroupIds: Set<string>;
  environmentIds: Set<string>;
  sshConnectionIds: Set<string>;
  databaseConnectionIds: Set<string>;
  redisConnectionIds: Set<string>;
}

export function canManageWorkspace(request: FastifyRequest): boolean {
  return request.admin?.workspace.role === "owner" || request.admin?.workspace.role === "admin";
}

export function workspaceParams(request: FastifyRequest): [WorkspaceType, string] {
  const workspace = request.admin!.workspace;
  return [workspace.type, workspace.id];
}

export function workspaceWhere(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}workspace_type = ? AND ${prefix}workspace_id = ?`;
}

export async function getWorkspaceAccess(db: EnvmanDatabase, user: AuthenticatedUser): Promise<WorkspaceAccess> {
  const canManage = user.workspace.role === "owner" || user.workspace.role === "admin";
  const access: WorkspaceAccess = {
    canManage,
    environmentGroupIds: new Set(),
    environmentIds: new Set(),
    sshConnectionIds: new Set(),
    databaseConnectionIds: new Set(),
    redisConnectionIds: new Set(),
  };
  if (canManage) return access;

  const directGrants = await db.prepare(`
    SELECT g.resource_type, g.resource_id
    FROM resource_grants g
    WHERE g.organization_id = ? AND g.grantee_type = 'user' AND g.grantee_id = ?
  `).all(user.workspace.id, user.id) as Array<{ resource_type: string; resource_id: string }>;
  const projects = await db.prepare(`
    SELECT p.id, p.parent_id,
      CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END AS is_member
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    WHERE p.organization_id = ?
  `).all(user.id, user.workspace.id) as Array<{ id: string; parent_id: string | null; is_member: number | string }>;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const grantedProjectIds = new Set<string>();
  for (const project of projects) {
    if (!Number(project.is_member)) continue;
    let current: typeof project | undefined = project;
    while (current && !grantedProjectIds.has(current.id)) {
      grantedProjectIds.add(current.id);
      current = current.parent_id ? projectById.get(current.parent_id) : undefined;
    }
  }
  const projectGrants = grantedProjectIds.size
    ? await db.prepare(`
      SELECT resource_type, resource_id FROM resource_grants
      WHERE organization_id = ? AND grantee_type = 'project'
        AND grantee_id IN (${[...grantedProjectIds].map(() => "?").join(",")})
    `).all(user.workspace.id, ...grantedProjectIds) as Array<{ resource_type: string; resource_id: string }>
    : [];
  const grants = [...directGrants, ...projectGrants];
  const grantedGroupIds = new Set<string>();
  for (const grant of grants) {
    if (grant.resource_type === "environment_group") grantedGroupIds.add(grant.resource_id);
    if (grant.resource_type === "environment") access.environmentIds.add(grant.resource_id);
    if (grant.resource_type === "ssh_connection") access.sshConnectionIds.add(grant.resource_id);
    if (grant.resource_type === "database_connection") access.databaseConnectionIds.add(grant.resource_id);
    if (grant.resource_type === "redis_connection") access.redisConnectionIds.add(grant.resource_id);
  }

  if (grantedGroupIds.size) {
    const placeholders = [...grantedGroupIds].map(() => "?").join(",");
    const rows = await db.prepare(`
      SELECT id FROM environments
      WHERE workspace_type = 'organization' AND workspace_id = ? AND group_id IN (${placeholders})
    `).all(user.workspace.id, ...grantedGroupIds) as Array<{ id: string }>;
    for (const row of rows) access.environmentIds.add(row.id);
  }

  if (access.environmentIds.size) {
    const environmentIds = [...access.environmentIds];
    const placeholders = environmentIds.map(() => "?").join(",");
    const environments = await db.prepare(`SELECT id, group_id FROM environments WHERE id IN (${placeholders})`).all(...environmentIds) as Array<{ id: string; group_id: string | null }>;
    for (const environment of environments) if (environment.group_id) access.environmentGroupIds.add(environment.group_id);
    const sshRows = await db.prepare(`SELECT connection_id FROM ssh_connection_environments WHERE environment_id IN (${placeholders})`).all(...environmentIds) as Array<{ connection_id: string }>;
    const databaseRows = await db.prepare(`SELECT connection_id FROM database_connection_environments WHERE environment_id IN (${placeholders})`).all(...environmentIds) as Array<{ connection_id: string }>;
    const redisRows = await db.prepare(`SELECT connection_id FROM redis_connection_environments WHERE environment_id IN (${placeholders})`).all(...environmentIds) as Array<{ connection_id: string }>;
    for (const row of sshRows) access.sshConnectionIds.add(row.connection_id);
    for (const row of databaseRows) access.databaseConnectionIds.add(row.connection_id);
    for (const row of redisRows) access.redisConnectionIds.add(row.connection_id);
  }
  if (access.databaseConnectionIds.size) {
    const rootIds = [...access.databaseConnectionIds];
    const profiles = await db.prepare(`SELECT id FROM database_connections WHERE profile_parent_id IN (${rootIds.map(() => "?").join(",")})`).all(...rootIds) as Array<{ id: string }>;
    for (const profile of profiles) access.databaseConnectionIds.add(profile.id);
  }
  for (const id of grantedGroupIds) access.environmentGroupIds.add(id);
  return access;
}

export async function canAccessEnvironment(db: EnvmanDatabase, user: AuthenticatedUser, environmentId: string): Promise<boolean> {
  const row = await db.prepare("SELECT workspace_type, workspace_id FROM environments WHERE id = ?").get(environmentId) as
    | { workspace_type: WorkspaceType; workspace_id: string }
    | undefined;
  if (!row || row.workspace_type !== user.workspace.type || row.workspace_id !== user.workspace.id) return false;
  const access = await getWorkspaceAccess(db, user);
  return access.canManage || access.environmentIds.has(environmentId);
}

export async function canAccessConnection(db: EnvmanDatabase, user: AuthenticatedUser, type: "ssh" | "database" | "redis", connectionId: string): Promise<boolean> {
  const table = type === "ssh" ? "ssh_connections" : type === "database" ? "database_connections" : "redis_connections";
  const row = await db.prepare(`SELECT workspace_type, workspace_id${type === "database" ? ", profile_parent_id" : ""} FROM ${table} WHERE id = ?`).get(connectionId) as
    | { workspace_type: WorkspaceType; workspace_id: string; profile_parent_id?: string | null }
    | undefined;
  if (!row || row.workspace_type !== user.workspace.type || row.workspace_id !== user.workspace.id) return false;
  const access = await getWorkspaceAccess(db, user);
  const ids = type === "ssh" ? access.sshConnectionIds : type === "database" ? access.databaseConnectionIds : access.redisConnectionIds;
  return access.canManage || ids.has(connectionId) || (type === "database" && Boolean(row.profile_parent_id && ids.has(row.profile_parent_id)));
}

export async function canAccessWebCredential(db: EnvmanDatabase, user: AuthenticatedUser, credentialId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT e.environment_id
    FROM web_credentials c
    JOIN web_entries e ON e.id = c.web_entry_id
    WHERE c.id = ?
  `).get(credentialId) as { environment_id: string } | undefined;
  return Boolean(row && await canAccessEnvironment(db, user, row.environment_id));
}

export async function canAccessEnvironmentLog(db: EnvmanDatabase, user: AuthenticatedUser, logId: string): Promise<boolean> {
  const row = await db.prepare("SELECT environment_id FROM environment_logs WHERE id = ?").get(logId) as { environment_id: string } | undefined;
  return Boolean(row && await canAccessEnvironment(db, user, row.environment_id));
}

export async function resourceBelongsToWorkspace(
  db: EnvmanDatabase,
  user: AuthenticatedUser,
  resourceType: "environment_group" | "environment" | "ssh_connection" | "database_connection" | "redis_connection",
  resourceId: string,
): Promise<boolean> {
  const table = {
    environment_group: "environment_groups",
    environment: "environments",
    ssh_connection: "ssh_connections",
    database_connection: "database_connections",
    redis_connection: "redis_connections",
  }[resourceType];
  const row = await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_type = ? AND workspace_id = ?`).get(
    resourceId,
    user.workspace.type,
    user.workspace.id,
  );
  return Boolean(row);
}
