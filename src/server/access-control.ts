import type { FastifyRequest } from "fastify";
import type { Capability, PermissionMap } from "../shared/access-permissions.js";
import { fullPermissions } from "../shared/access-permissions.js";
import {
  allowsEnvironmentScope,
  environmentPermissionMap,
  resolveOrganizationAccess,
  type ConnectionActionMaps,
  type EnvironmentScopes,
} from "./access-authorizations.js";
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
  environmentScopes: EnvironmentScopes;
  connectionActions: ConnectionActionMaps;
  allowsEnvironment(environmentId: string, capability: Capability, action: string, itemId?: string, requireAll?: boolean): boolean;
  allowsConnection(type: "ssh" | "database" | "redis", connectionId: string, action: string): boolean;
  environmentPermissions(environmentId: string): PermissionMap;
}

const accessCache = new WeakMap<AuthenticatedUser, Promise<WorkspaceAccess>>();

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

function bindAccess(access: Omit<WorkspaceAccess, "allowsEnvironment" | "allowsConnection" | "environmentPermissions">): WorkspaceAccess {
  const bound = access as WorkspaceAccess;
  bound.allowsEnvironment = (environmentId, capability, action, itemId, requireAll = false) => (
    access.canManage || allowsEnvironmentScope(access.environmentScopes, environmentId, capability, action, itemId, requireAll)
  );
  bound.allowsConnection = (type, connectionId, action) => access.canManage || Boolean(access.connectionActions[type].get(connectionId)?.has(action));
  bound.environmentPermissions = (environmentId) => access.canManage ? fullPermissions("environment") : environmentPermissionMap(access.environmentScopes, environmentId);
  return bound;
}

export async function getWorkspaceAccess(db: EnvmanDatabase, user: AuthenticatedUser): Promise<WorkspaceAccess> {
  const cached = accessCache.get(user);
  if (cached) return cached;
  const loading = loadWorkspaceAccess(db, user);
  accessCache.set(user, loading);
  return loading;
}

async function loadWorkspaceAccess(db: EnvmanDatabase, user: AuthenticatedUser): Promise<WorkspaceAccess> {
  const canManage = user.workspace.role === "owner" || user.workspace.role === "admin";
  if (canManage || user.workspace.type !== "organization") {
    return bindAccess({
      canManage,
      environmentGroupIds: new Set(),
      environmentIds: new Set(),
      sshConnectionIds: new Set(),
      databaseConnectionIds: new Set(),
      redisConnectionIds: new Set(),
      environmentScopes: new Map(),
      connectionActions: { ssh: new Map(), database: new Map(), redis: new Map() },
    });
  }
  const resolved = await resolveOrganizationAccess(db, user);
  return bindAccess({ canManage: false, ...resolved });
}

export async function environmentCapability(
  db: EnvmanDatabase,
  user: AuthenticatedUser,
  environmentId: string,
  capability: Capability,
  action: string,
  itemId?: string,
  requireAll = false,
): Promise<"ok" | "missing" | "forbidden"> {
  const row = await db.prepare("SELECT workspace_type, workspace_id FROM environments WHERE id = ?").get(environmentId) as
    | { workspace_type: WorkspaceType; workspace_id: string }
    | undefined;
  if (!row || row.workspace_type !== user.workspace.type || row.workspace_id !== user.workspace.id) return "missing";
  const access = await getWorkspaceAccess(db, user);
  return access.allowsEnvironment(environmentId, capability, action, itemId, requireAll) ? "ok" : "forbidden";
}

export function sendCapabilityResult(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  result: "ok" | "missing" | "forbidden",
  missing: { error: string; message: string },
): boolean {
  if (result === "ok") return true;
  if (result === "missing") void reply.code(404).send(missing);
  else void reply.code(403).send({ error: "ACTION_FORBIDDEN", message: "没有这项操作权限" });
  return false;
}

export async function requireEnvironmentAction(
  db: EnvmanDatabase,
  user: AuthenticatedUser,
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  environmentId: string,
  capability: Capability,
  action: string,
  itemId?: string,
  missing: { error: string; message: string } = { error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" },
  requireAll = false,
): Promise<boolean> {
  return sendCapabilityResult(reply, await environmentCapability(db, user, environmentId, capability, action, itemId, requireAll), missing);
}

export async function canAccessEnvironment(db: EnvmanDatabase, user: AuthenticatedUser, environmentId: string): Promise<boolean> {
  const row = await db.prepare("SELECT workspace_type, workspace_id FROM environments WHERE id = ?").get(environmentId) as
    | { workspace_type: WorkspaceType; workspace_id: string }
    | undefined;
  if (!row || row.workspace_type !== user.workspace.type || row.workspace_id !== user.workspace.id) return false;
  const access = await getWorkspaceAccess(db, user);
  return access.canManage || access.environmentIds.has(environmentId);
}

export async function canAccessConnection(
  db: EnvmanDatabase,
  user: AuthenticatedUser,
  type: "ssh" | "database" | "redis",
  connectionId: string,
  action?: string,
): Promise<boolean> {
  const minimum = action ?? (type === "database" ? "read" : "view");
  const table = type === "ssh" ? "ssh_connections" : type === "database" ? "database_connections" : "redis_connections";
  const row = await db.prepare(`SELECT workspace_type, workspace_id${type === "database" ? ", profile_parent_id" : ""} FROM ${table} WHERE id = ?`).get(connectionId) as
    | { workspace_type: WorkspaceType; workspace_id: string; profile_parent_id?: string | null }
    | undefined;
  if (!row || row.workspace_type !== user.workspace.type || row.workspace_id !== user.workspace.id) return false;
  const access = await getWorkspaceAccess(db, user);
  return access.allowsConnection(type, connectionId, minimum)
    || (type === "database" && Boolean(row.profile_parent_id && access.allowsConnection(type, row.profile_parent_id, minimum)));
}

export async function requireConnectionConfig(
  db: EnvmanDatabase,
  user: AuthenticatedUser,
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  type: "ssh" | "database" | "redis",
  connectionId: string | null,
  environmentIds: string[],
): Promise<boolean> {
  const access = await getWorkspaceAccess(db, user);
  if (access.canManage) return true;
  const capability = type === "database" ? "database" : type;
  if (!connectionId) {
    const allowed = environmentIds.length > 0 && environmentIds.every((environmentId) => access.allowsEnvironment(environmentId, capability, "manage", undefined, true));
    if (!allowed) void reply.code(403).send({ error: "ACTION_FORBIDDEN", message: "没有这项操作权限" });
    return allowed;
  }
  const table = type === "ssh" ? "ssh_connections" : type === "database" ? "database_connections" : "redis_connections";
  const row = await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_type = ? AND workspace_id = ?`).get(connectionId, user.workspace.type, user.workspace.id);
  if (!row) {
    void reply.code(404).send({ error: "NOT_FOUND", message: "连接不存在" });
    return false;
  }
  const allowed = access.allowsConnection(type, connectionId, "manage");
  if (!allowed) void reply.code(403).send({ error: "ACTION_FORBIDDEN", message: "没有这项操作权限" });
  return allowed;
}

export async function canCreateConnection(
  db: EnvmanDatabase,
  user: AuthenticatedUser,
  type: "ssh" | "database" | "redis",
  environmentIds: string[],
): Promise<boolean> {
  const access = await getWorkspaceAccess(db, user);
  if (access.canManage) return true;
  if (!environmentIds.length) return false;
  const capability = type === "database" ? "database" : type;
  return environmentIds.every((environmentId) => access.allowsEnvironment(environmentId, capability, "manage", undefined, true));
}

export async function canAccessWebCredential(db: EnvmanDatabase, user: AuthenticatedUser, credentialId: string, action = "use"): Promise<boolean> {
  const row = await db.prepare(`
    SELECT w.environment_id, w.id AS entry_id, env.workspace_type, env.workspace_id
    FROM web_credentials c
    JOIN web_entries w ON w.id = c.web_entry_id
    JOIN environments env ON env.id = w.environment_id
    WHERE c.id = ?
  `).get(credentialId) as { environment_id: string; entry_id: string; workspace_type: WorkspaceType; workspace_id: string } | undefined;
  if (!row || row.workspace_type !== user.workspace.type || row.workspace_id !== user.workspace.id) return false;
  const access = await getWorkspaceAccess(db, user);
  return access.allowsEnvironment(row.environment_id, "web", action, row.entry_id);
}

export async function canAccessEnvironmentLog(db: EnvmanDatabase, user: AuthenticatedUser, logId: string, action = "view"): Promise<boolean> {
  const row = await db.prepare(`
    SELECT l.environment_id, e.workspace_type, e.workspace_id
    FROM environment_logs l JOIN environments e ON e.id = l.environment_id
    WHERE l.id = ?
  `).get(logId) as { environment_id: string; workspace_type: WorkspaceType; workspace_id: string } | undefined;
  if (!row || row.workspace_type !== user.workspace.type || row.workspace_id !== user.workspace.id) return false;
  const access = await getWorkspaceAccess(db, user);
  return access.allowsEnvironment(row.environment_id, "logs", action, logId);
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
