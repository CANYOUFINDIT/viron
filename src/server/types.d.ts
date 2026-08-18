import type { AppConfig } from "./config.js";
import type { SecretBox } from "./crypto.js";
import type { EnvmanDatabase } from "./database.js";
import type { SshSessionManager } from "./ssh/session-manager.js";
import type { SshLogStreamManager } from "./ssh/log-stream-manager.js";
import type { SftpTransferManager } from "./sftp/transfer-manager.js";
import type { DatabaseQueryManager } from "./database-workbench/query-manager.js";
import type { DatabaseTaskManager } from "./database-workbench/task-manager.js";
import type { ConnectionSourceScheduler } from "./connection-sources/scheduler.js";
import type { WebAccountViewManager } from "./web-browser/view-manager.js";
import type { AuthenticatedUser } from "./access-control.js";
import type { ActiveConnectionManager } from "./active-connections.js";
import type { ApiKeyPrincipal } from "./api-key-auth.js";
import type { McpOperationStore } from "./mcp/operation-store.js";
import type { MonitorInstallTaskManager } from "./monitor-install-task-manager.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: EnvmanDatabase;
    secrets: SecretBox;
    sshSessions: SshSessionManager;
    sshLogStreams: SshLogStreamManager;
    sftpTransfers: SftpTransferManager;
    databaseQueries: DatabaseQueryManager;
    databaseTasks: DatabaseTaskManager;
    connectionSourceScheduler: ConnectionSourceScheduler;
    webAccountViews: WebAccountViewManager;
    activeConnections: ActiveConnectionManager;
    mcpOperations: McpOperationStore;
    monitorInstallTasks: MonitorInstallTaskManager;
  }

  interface FastifyRequest {
    admin: AuthenticatedUser | null;
    sessionId: string | null;
    apiKey: ApiKeyPrincipal | null;
  }
}
