import type { FastifyInstance } from "fastify";
import type { WorkspaceContext } from "./access-control.js";
import { closeDatabaseConnectionPool } from "./database-workbench/connector.js";
import { closeRedisConnectionPool } from "./redis/connector.js";
import { closeSshConnectionPool } from "./ssh/connector.js";

export async function revokeUserRuntime(app: FastifyInstance, userId: string, deleteAllSessions: boolean): Promise<void> {
  if (deleteAllSessions) await app.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  await Promise.all([
    app.sshSessions.closeOwner(userId),
    Promise.resolve(app.sshLogStreams.closeOwner(userId)),
    app.sftpTransfers.closeOwner(userId),
    Promise.resolve(app.databaseQueries.closeOwner(userId)),
    app.databaseTasks.closeOwner(userId),
    app.webAccountViews.closeOwner(userId),
    app.activeConnections.closeOwner(userId, "用户访问已失效"),
    closeSshConnectionPool(app),
    closeDatabaseConnectionPool(app),
    closeRedisConnectionPool(app),
  ]);
}

export async function revokeWorkspaceRuntime(app: FastifyInstance, workspace: WorkspaceContext): Promise<void> {
  if (workspace.type === "personal") {
    await revokeUserRuntime(app, workspace.id, false);
    return;
  }
  const members = await app.db.prepare("SELECT user_id FROM organization_members WHERE organization_id = ?").all(workspace.id) as Array<{ user_id: string }>;
  await Promise.all(members.map((member) => revokeUserRuntime(app, member.user_id, false)));
}
