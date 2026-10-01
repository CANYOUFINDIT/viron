import type { FastifyInstance } from "fastify";
import { getWorkspaceAccess, type AuthenticatedUser, type WorkspaceAccess } from "./access-control.js";
import { expireServiceOperation } from "./service-operations.js";

const REASON = "授权已到期";

export function startAccessExpirySweep(app: FastifyInstance): () => void {
  const timer = setInterval(() => {
    void sweepExpiredAccess(app).catch((error) => app.log.error({ err: error }, "access expiry sweep failed"));
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function disconnectGrantees(app: FastifyInstance, organizationId: string, userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  await Promise.all(unique.map(async (userId) => {
    const access = await accessForMember(app, organizationId, userId);
    if (!access) {
      await closeOwnerOrganization(app, userId, organizationId);
      return;
    }
    if (access.canManage) return;
    await closeDisallowed(app, organizationId, userId, access);
  }));
}

export async function sweepExpiredAccess(app: FastifyInstance): Promise<void> {
  const owners = new Map<string, { organizationId: string; userId: string }>();
  for (const entry of app.activeConnections.inspect()) {
    if (entry.workspaceType !== "organization") continue;
    owners.set(`${entry.workspaceId}:${entry.ownerId}`, { organizationId: entry.workspaceId, userId: entry.ownerId });
  }
  for (const job of app.databaseQueries.runningJobs()) {
    if (job.workspaceType === "organization") owners.set(`${job.workspaceId}:${job.ownerId}`, { organizationId: job.workspaceId, userId: job.ownerId });
  }
  for (const task of app.databaseTasks.runningTasks()) {
    if (task.workspaceType === "organization" && task.connectionId) owners.set(`${task.workspaceId}:${task.ownerId}`, { organizationId: task.workspaceId, userId: task.ownerId });
  }
  const operations = await app.db.prepare(`
    SELECT id, workspace_id, environment_id, requested_by_user_id, operation_type
    FROM service_operation_runs
    WHERE workspace_type = 'organization' AND status IN ('queued', 'running')
  `).all() as Array<{ id: string; workspace_id: string; environment_id: string; requested_by_user_id: string; operation_type: string }>;
  for (const operation of operations) owners.set(`${operation.workspace_id}:${operation.requested_by_user_id}`, { organizationId: operation.workspace_id, userId: operation.requested_by_user_id });
  const resolved = new Map<string, WorkspaceAccess | null>();
  for (const owner of owners.values()) {
    if (!owner.organizationId) continue;
    const key = `${owner.organizationId}:${owner.userId}`;
    if (!resolved.has(key)) resolved.set(key, await accessForMember(app, owner.organizationId, owner.userId));
    const access = resolved.get(key);
    if (!access) {
      await closeOwnerOrganization(app, owner.userId, owner.organizationId);
      continue;
    }
    if (access.canManage) continue;
    await closeDisallowed(app, owner.organizationId, owner.userId, access);
  }
  for (const operation of operations) {
    const access = resolved.get(`${operation.workspace_id}:${operation.requested_by_user_id}`);
    const action = operation.operation_type === "script_action" ? "script" : "control";
    if (!access || !access.allowsEnvironment(operation.environment_id, "maintenance", action)) expireServiceOperation(operation.id);
  }
}

async function accessForMember(app: FastifyInstance, organizationId: string, userId: string): Promise<WorkspaceAccess | null> {
  const member = await app.db.prepare(`
    SELECT u.id, u.username, m.role, o.name
    FROM organization_members m
    JOIN admin_users u ON u.id = m.user_id
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.organization_id = ? AND m.user_id = ? AND u.status = 'active'
  `).get(organizationId, userId) as { id: string; username: string; role: "admin" | "member"; name: string } | undefined;
  if (!member) return null;
  const user: AuthenticatedUser = {
    id: member.id,
    username: member.username,
    isPlatformAdmin: false,
    workspace: { type: "organization", id: organizationId, name: member.name, role: member.role },
  };
  return getWorkspaceAccess(app.db, user);
}

async function closeOwnerOrganization(app: FastifyInstance, userId: string, organizationId: string): Promise<void> {
  await Promise.all(app.activeConnections.inspect()
    .filter((entry) => entry.ownerId === userId && entry.workspaceType === "organization" && entry.workspaceId === organizationId)
    .map((entry) => app.activeConnections.closeInspected(entry.id, REASON)));
}

async function closeDisallowed(app: FastifyInstance, organizationId: string, userId: string, access: WorkspaceAccess): Promise<void> {
  for (const entry of app.activeConnections.inspect()) {
    if (entry.ownerId !== userId || entry.workspaceId !== organizationId) continue;
    if (await entryAllowed(app, access, entry.type, entry.resourceId)) continue;
    await app.activeConnections.closeInspected(entry.id, REASON);
    if (entry.type === "database") {
      app.databaseQueries.closeMatching(userId, entry.resourceId, REASON);
      await app.databaseTasks.closeMatching(userId, entry.resourceId, REASON);
    }
  }
  for (const job of app.databaseQueries.runningJobs()) {
    if (job.ownerId === userId && job.workspaceId === organizationId && !access.allowsConnection("database", job.connectionId, "read")) {
      app.databaseQueries.closeMatching(userId, job.connectionId, REASON);
    }
  }
  for (const task of app.databaseTasks.runningTasks()) {
    if (task.ownerId === userId && task.workspaceId === organizationId && task.connectionId && !access.allowsConnection("database", task.connectionId, "read")) {
      await app.databaseTasks.closeMatching(userId, task.connectionId, REASON);
    }
  }
}

async function entryAllowed(app: FastifyInstance, access: WorkspaceAccess, type: string, resourceId: string): Promise<boolean> {
  if (type === "ssh" || type === "sftp") return access.allowsConnection("ssh", resourceId, "use");
  if (type === "redis") return access.allowsConnection("redis", resourceId, "view");
  if (type === "database") return access.allowsConnection("database", resourceId, "read");
  if (type === "logs") {
    const row = await app.db.prepare("SELECT environment_id FROM environment_logs WHERE id = ?").get(resourceId) as { environment_id: string } | undefined;
    return Boolean(row && access.allowsEnvironment(row.environment_id, "logs", "view", resourceId));
  }
  if (type === "web") {
    const row = await app.db.prepare(`
      SELECT w.environment_id, w.id AS entry_id
      FROM web_credentials c JOIN web_entries w ON w.id = c.web_entry_id
      WHERE c.id = ?
    `).get(resourceId) as { environment_id: string; entry_id: string } | undefined;
    return Boolean(row && access.allowsEnvironment(row.environment_id, "web", "use", row.entry_id));
  }
  return false;
}
