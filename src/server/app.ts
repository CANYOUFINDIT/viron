import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import { createSecretBox } from "./crypto.js";
import type { EnvmanDatabase } from "./database.js";
import { DatabaseQueryManager } from "./database-workbench/query-manager.js";
import { DatabaseTaskManager } from "./database-workbench/task-manager.js";
import { ConnectionSourceScheduler } from "./connection-sources/scheduler.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerConnectionImportRoutes } from "./routes/connection-imports.js";
import { registerConnectionCopyRoutes } from "./routes/connection-copy.js";
import { registerConnectionSourceRoutes } from "./routes/connection-sources.js";
import { registerDatabaseWorkbenchRoutes } from "./routes/database-workbench.js";
import { registerDatabaseOperationRoutes } from "./routes/database-operations.js";
import { registerDatabaseArtifactRoutes } from "./routes/database-artifacts.js";
import { registerDatabaseAdminRoutes } from "./routes/database-admin.js";
import { registerRedisConnectionRoutes } from "./routes/redis-connections.js";
import { registerRedisWorkbenchRoutes } from "./routes/redis-workbench.js";
import { registerDesktopDeviceRoutes } from "./routes/desktop-devices.js";
import { registerEnvironmentLogRoutes } from "./routes/environment-logs.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerKnowledgeBaseRoutes } from "./routes/knowledge-base.js";
import { registerSshCommandFavoriteRoutes } from "./routes/ssh-command-favorites.js";
import { registerSshKeyRoutes } from "./routes/ssh-keys.js";
import { registerSshSessionRoutes } from "./routes/ssh-sessions.js";
import { registerSftpRoutes } from "./routes/sftp.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWebEntryRoutes } from "./routes/web-entries.js";
import { registerWebAccountViewRoutes } from "./routes/web-account-views.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { PRODUCT_VERSION, productCapabilities } from "./product-info.js";
import { SshLogStreamManager } from "./ssh/log-stream-manager.js";
import { SshSessionManager } from "./ssh/session-manager.js";
import { SftpTransferManager } from "./sftp/transfer-manager.js";
import { WebAccountViewManager } from "./web-browser/view-manager.js";
import { ActiveConnectionManager } from "./active-connections.js";
import { registerActiveConnectionRoutes } from "./routes/active-connections.js";
import { registerVersionRoutes } from "./routes/version.js";
import { registerClientInstallerRoutes } from "./routes/client-installers.js";
import { localizeJsonPayload } from "./i18n.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";
import { registerPlatformProvisioningRoutes } from "./routes/platform-provisioning.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerMcpActionRoutes } from "./routes/mcp-actions.js";
import { registerMcpOperationRoutes } from "./routes/mcp-operations.js";
import { registerServiceMaintenanceRoutes } from "./routes/service-maintenance.js";
import { registerMonitorHistoryRoutes } from "./routes/monitor-history.js";
import { registerMonitorAlertRoutes } from "./routes/monitor-alerts.js";
import { McpOperationStore } from "./mcp/operation-store.js";
import { migrateDatabaseTlsCredentials } from "./database-credentials.js";
import { startMonitorHostPuller } from "./service-monitor.js";
import { enterAuditSourceForRequest } from "./audit.js";
import { MonitorInstallTaskManager } from "./monitor-install-task-manager.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: EnvmanDatabase;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions) {
  const webClientEnabled = options.config.webClientEnabled !== false;
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.decorate("config", options.config);
  app.decorate("db", options.db);
  app.decorate("secrets", createSecretBox(options.config.masterKey));
  await migrateDatabaseTlsCredentials(app);
  app.decorate("activeConnections", new ActiveConnectionManager(app));
  const sshSessions = new SshSessionManager(app);
  await sshSessions.initialize();
  app.decorate("sshSessions", sshSessions);
  app.decorate("sshLogStreams", new SshLogStreamManager(app));
  app.decorate("sftpTransfers", new SftpTransferManager(app));
  app.decorate("databaseQueries", new DatabaseQueryManager(app));
  const databaseTasks = new DatabaseTaskManager(app);
  await databaseTasks.initialize();
  app.decorate("databaseTasks", databaseTasks);
  app.decorate("connectionSourceScheduler", new ConnectionSourceScheduler(app));
  app.decorate("webAccountViews", new WebAccountViewManager(app));
  app.decorate("mcpOperations", new McpOperationStore());
  const monitorInstallTasks = new MonitorInstallTaskManager(app);
  await monitorInstallTasks.initialize();
  app.decorate("monitorInstallTasks", monitorInstallTasks);
  app.decorateRequest("admin", null);
  app.decorateRequest("sessionId", null);
  app.decorateRequest("apiKey", null);

  await app.register(cookie);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  await app.register(helmet, {
    contentSecurityPolicy: options.config.nodeEnv === "production"
      ? { directives: { "upgrade-insecure-requests": options.config.cookieSecure ? [] : null } }
      : false,
    strictTransportSecurity: options.config.cookieSecure ? undefined : false,
  });
  await app.register(rateLimit, { global: false });
  const apiRateLimit = app.rateLimit({ max: 300, timeWindow: "1 minute" });
  app.addHook("preHandler", async (request, reply) => {
    enterAuditSourceForRequest(request);
    if (request.url.startsWith("/api/")) await apiRateLimit.call(app, request, reply);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (typeof payload !== "string" || !reply.getHeader("content-type")?.toString().includes("application/json")) return payload;
    return localizeJsonPayload(request.headers["accept-language"], payload);
  });
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  });
  await app.register(websocket);

  app.get("/healthz", async () => ({ status: "ok", version: PRODUCT_VERSION, ...productCapabilities(webClientEnabled, options.config.mcpEnabled === true) }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await app.db.ping();
    } catch (error) {
      // 原始错误只进日志，响应固定为不含路径、账号和连接串的短语。
      app.log.error({ err: error }, "readiness probe failed");
      return reply.code(503).send({ error: "DATABASE_UNAVAILABLE", message: "元数据库不可用" });
    }
    return { status: "ok", database: app.db.dialect };
  });
  app.get("/api/v1/capabilities", async () => productCapabilities(webClientEnabled, options.config.mcpEnabled === true));
  await app.register(registerVersionRoutes, { prefix: "/api/v1" });

  await app.register(registerAuthRoutes);
  await app.register(registerApiKeyRoutes);
  await app.register(registerPlatformProvisioningRoutes);
  await app.register(registerClientInstallerRoutes);
  await app.register(registerActiveConnectionRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerOrganizationRoutes);
  await app.register(registerEnvironmentRoutes);
  await app.register(registerKnowledgeBaseRoutes);
  await app.register(registerEnvironmentLogRoutes);
  await app.register(registerServiceMaintenanceRoutes);
  await app.register(registerMonitorHistoryRoutes);
  await app.register(registerMonitorAlertRoutes);
  await app.register(registerDesktopDeviceRoutes);
  await app.register(registerWebEntryRoutes);
  if (webClientEnabled) await app.register(registerWebAccountViewRoutes);
  await app.register(registerConnectionRoutes);
  await app.register(registerSshKeyRoutes);
  await app.register(registerRedisConnectionRoutes);
  await app.register(registerConnectionImportRoutes);
  await app.register(registerConnectionCopyRoutes);
  await app.register(registerConnectionSourceRoutes);
  await app.register(registerDatabaseWorkbenchRoutes);
  await app.register(registerDatabaseOperationRoutes);
  await app.register(registerDatabaseArtifactRoutes);
  await app.register(registerDatabaseAdminRoutes);
  await app.register(registerRedisWorkbenchRoutes);
  await app.register(registerSshCommandFavoriteRoutes);
  await app.register(registerSshSessionRoutes);
  await app.register(registerSftpRoutes);
  await app.register(registerSettingsRoutes);
  await app.register(registerAuditRoutes);
  await app.register(registerMcpActionRoutes);
  await app.register(registerMcpOperationRoutes);
  await app.register(registerMcpRoutes);
  await app.connectionSourceScheduler.start();
  const stopMonitorHostPuller = startMonitorHostPuller(app);

  const currentDir = fileURLToPath(new URL(".", import.meta.url));
  const clientDir = join(currentDir, "../client");
  if (webClientEnabled && options.config.nodeEnv === "production" && existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "接口不存在" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    await stopMonitorHostPuller();
    await app.monitorInstallTasks.closeAll();
    await app.sshSessions.closeAll();
    app.sshLogStreams.closeAll();
    await app.sftpTransfers.closeAll();
    app.databaseQueries.closeAll();
    await app.databaseTasks.closeAll();
    app.connectionSourceScheduler.close();
    await app.webAccountViews.closeAll();
    app.mcpOperations.close();
    app.activeConnections.stop();
    await options.db.close();
  });

  return app;
}
