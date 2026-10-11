import type { FastifyRequest } from "fastify";
import type { Capability, PermissionMap } from "../shared/access-permissions.js";
import { fullPermissions } from "../shared/access-permissions.js";
import {
  allowsEnvironmentScope,
  environmentPermissionMap,
  type ConnectionActionMaps,
  type EnvironmentScopes,
} from "./access-authorizations.js";
import { loadOrganizationAccess, type OrganizationAccess } from "./organization-rbac.js";
import { legacyOperationCodes, type ResourceRef } from "../shared/organization-rbac.js";
import type { EnvmanDatabase } from "./database.js";

export type WorkspaceType = "personal" | "organization";
export type OrganizationRole = "admin" | "member";

export interface WorkspaceContext {
  type: WorkspaceType;
  id: string;
  name: string;
  role: "owner" | OrganizationRole;
  permissionCodes?: string[];
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  isPlatformAdmin: boolean;
  workspace: WorkspaceContext;
  organizationAccess?: OrganizationAccess;
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
  organizationAccess?: OrganizationAccess;
}

export function hasWorkspacePermission(request: FastifyRequest, code: string, target?: ResourceRef | string): boolean {
  const user = request.admin;
  if (!user) return false;
  if (user.workspace.type === "personal") return user.workspace.role === "owner";
  return user.organizationAccess?.allows(code, target) ?? false;
}

/** Compatibility helper for existing route guards, resolved by the actual route operation. */
export function canManageWorkspace(request: FastifyRequest): boolean {
  if (request.admin?.workspace.type === "personal") return request.admin.workspace.role === "owner";
  const path = request.url.split("?", 1)[0];
  const params = request.params as Record<string, string>;
  const reading = request.method === "GET";
  if (path.includes("ssh-keys") || path.includes("certificates")) return hasWorkspacePermission(request, path.includes("/export") ? "credential.export" : reading ? "credential.view" : "credential.update");
  if (path.includes("connection-sources")) return hasWorkspacePermission(request, "tool.sync");
  if (path.includes("connection-import")) return hasWorkspacePermission(request, "tool.import");
  if (path.includes("connection-copy")) return hasWorkspacePermission(request, "tool.copy");
  if (path.includes("audit")) return hasWorkspacePermission(request, reading ? "audit.view" : "audit.export");
  if (path.includes("knowledge") && path.includes("grant")) return hasWorkspacePermission(request, "authorization.create", params.id ? { type:"knowledge_node", id:params.id } : undefined);
  if (path.includes("recording") || path.includes("query-history")) return hasWorkspacePermission(request,"audit.view");
  for (const [prefix, type, cap] of [["ssh-connections","ssh_connection","ssh"],["database-connections","database_connection","database"],["redis-connections","redis_connection","redis"]] as const) {
    if (path.includes(prefix)) return params.id ? hasWorkspacePermission(request, `resource.${cap}.configure`, { type, id:params.id }) : hasWorkspacePermission(request,"environment.create");
  }
  if (params.environmentId || (path.startsWith("/api/v1/environments/") && params.id)) return hasWorkspacePermission(request,"environment.update",{type:"environment",id:params.environmentId || params.id});
  if (path.includes("environment")) return hasWorkspacePermission(request,"environment.create");
  if (path.includes("recording") || path.includes("query-history")) return hasWorkspacePermission(request,"audit.view");
  return false;
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
  if (user.workspace.type === "personal") return bindAccess({canManage:user.workspace.role === "owner",environmentGroupIds:new Set(),environmentIds:new Set(),sshConnectionIds:new Set(),databaseConnectionIds:new Set(),redisConnectionIds:new Set(),environmentScopes:new Map(),connectionActions:{ssh:new Map(),database:new Map(),redis:new Map()}});
  // Deliberately refreshed on execution, including long-lived websocket principals.
  const rbac = await loadOrganizationAccess(db, user.workspace.id, user.id);
  const actionMaps: ConnectionActionMaps = {ssh:new Map(),database:new Map(),redis:new Map()};
  const visible = (type: ResourceRef["type"]) => new Set(rbac.catalog.filter(c=>c.type===type && (["view","use","read","write","manage"].some(a=>legacyOperationCodes(c.capability,a).some(code=>rbac.allows(code,c))))).map(c=>c.id));
  for (const type of ["ssh","database","redis"] as const) for(const c of rbac.catalog.filter(c=>c.capability===type)) {
    const actions=new Set(["view","use","read","write","manage"].filter(a=>legacyOperationCodes(type,a).some(code=>rbac.allows(code,c))));if(actions.size)actionMaps[type].set(c.id,actions);
  }
  const permits=(environmentId:string,capability:Capability,action:string,itemId?:string,requireAll=false) => {
    const candidates=rbac.catalog.filter(c=>c.capability===capability&&c.environmentIds.includes(environmentId)&&(!itemId||c.id===(capability === "maintenance" ? itemId.replace(/^(service|host):/, "") : itemId)));
    const check=(c:ResourceRef)=>legacyOperationCodes(capability,action).some(code=>rbac.allows(code,c));
    return candidates.length>0&&(requireAll?candidates.every(check):candidates.some(check));
  };
  const envIds=new Set(rbac.catalog.filter(c=>c.type==="environment"&&(rbac.allows("environment.catalog")||rbac.allows("environment.view",c)||rbac.catalog.some(t=>t.environmentIds.includes(c.id)&&[...PERMITTED_RESOURCE_ACTIONS(t.capability)].some(code=>rbac.allows(code,t))))).map(c=>c.id));
  return {canManage:false,organizationAccess:rbac,environmentIds:envIds,environmentGroupIds:new Set(rbac.catalog.filter(c=>c.type==="environment"&&envIds.has(c.id)).flatMap(c=>c.groupIds)),sshConnectionIds:visible("ssh_connection"),databaseConnectionIds:visible("database_connection"),redisConnectionIds:visible("redis_connection"),environmentScopes:new Map(),connectionActions:actionMaps,allowsEnvironment:permits,allowsConnection:(type,id,action)=>legacyOperationCodes(type,action).some(code=>rbac.allows(code,{type:`${type}_connection` as ResourceRef["type"],id})),environmentPermissions:(id)=>Object.fromEntries(["web","ssh","database","redis","logs","knowledge","maintenance"].map(cap=>[cap,["view","use","read","write","manage","edit","control","script","install"].filter(action=>permits(id,cap as Capability,action))])) as PermissionMap};
}
function PERMITTED_RESOURCE_ACTIONS(cap:string) { return ["view","use","read","write","edit","control","script","install",`configure`].map(a=>a==="configure"?`resource.${cap}.configure`:`${cap}.${a}`); }

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
  return access.allowsConnection(type, connectionId, minimum);
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
    const allowed = access.organizationAccess?.allows("environment.create") ?? (environmentIds.length > 0 && environmentIds.every((environmentId) => access.allowsEnvironment(environmentId, capability, "manage", undefined, true)));
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
  if (access.organizationAccess?.allows("environment.create")) return true;
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
