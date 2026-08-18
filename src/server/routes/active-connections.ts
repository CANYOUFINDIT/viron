import type { FastifyInstance, FastifyReply } from "fastify";
import { connect } from "node:net";
import { z } from "zod";
import { canAccessConnection, canAccessEnvironment, canAccessEnvironmentLog, canAccessWebCredential } from "../access-control.js";
import { ConnectionLimitError } from "../active-connections.js";
import { writeAudit } from "../audit.js";
import { executionScope } from "../execution-scope.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import type { ConnectionQualityTargetAddress } from "../../shared/connection-quality.js";

const desktopReservationSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["web", "ssh", "logs", "sftp"]),
  resourceId: z.string().uuid(),
  originEnvironmentId: z.string().uuid().optional(),
  relatedResourceId: z.string().uuid().optional(),
});

const desktopHeartbeatSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    lastActivityAt: z.number().int().positive(),
  })).max(100),
});

const databaseSessionSchema = z.object({
  connectionId: z.string().uuid(),
  originEnvironmentId: z.string().uuid().optional(),
});
const databaseActivitySchema = z.object({ connectionId: z.string().uuid() });
const redisSessionSchema = z.object({
  connectionId: z.string().uuid(),
  originEnvironmentId: z.string().uuid().optional(),
});
const redisActivitySchema = z.object({ connectionId: z.string().uuid() });
const connectionQualityUploadSchema = z.object({ payload: z.string().max(512 * 1024) });

interface TargetAddress {
  host: string;
  port: number;
}

async function activeTargetAddress(app: FastifyInstance, item: { type: string; resourceId: string }): Promise<TargetAddress | null> {
  if (item.type === "web") {
    const row = await app.db.prepare(`
      SELECT w.url FROM web_credentials c JOIN web_entries w ON w.id = c.web_entry_id WHERE c.id = ?
    `).get(item.resourceId) as { url: string } | undefined;
    if (!row) return null;
    const url = new URL(row.url);
    return { host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
  }
  if (item.type === "logs") {
    const row = await app.db.prepare(`
      SELECT s.host, s.port FROM environment_logs l JOIN ssh_connections s ON s.id = l.ssh_connection_id WHERE l.id = ?
    `).get(item.resourceId) as { host: string; port: number } | undefined;
    return row ? { host: row.host, port: Number(row.port) } : null;
  }
  const table = item.type === "database" ? "database_connections" : item.type === "redis" ? "redis_connections" : "ssh_connections";
  const row = await app.db.prepare(`SELECT host, port FROM ${table} WHERE id = ?`).get(item.resourceId) as { host: string; port: number } | undefined;
  return row ? { host: row.host, port: Number(row.port) } : null;
}

function probeTcpTarget(target: TargetAddress, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = connect({ host: target.host, port: target.port });
    const finish = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(Math.max(0, Math.round(performance.now() - started)));
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("目标连接探测超时")));
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

function sendReservationError(error: unknown, reply: FastifyReply) {
  if (error instanceof ConnectionLimitError) {
    return reply.code(409).send({ error: error.code, message: error.message, limit: error.limit });
  }
  throw error;
}

async function canReserveDesktop(app: FastifyInstance, user: NonNullable<Parameters<typeof canAccessConnection>[1]>, body: z.infer<typeof desktopReservationSchema>): Promise<boolean> {
  if (body.type === "web") return canAccessWebCredential(app.db, user, body.resourceId);
  if (body.type === "logs") return canAccessEnvironmentLog(app.db, user, body.resourceId);
  if (!await canAccessConnection(app.db, user, "ssh", body.resourceId)) return false;
  return !body.relatedResourceId || canAccessConnection(app.db, user, "ssh", body.relatedResourceId);
}

export async function registerActiveConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/connection-quality/ping", { preHandler: requireAdmin }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { serverAt: Date.now() };
  });

  app.get<{ Querystring: { bytes?: string } }>("/api/v1/connection-quality/download", { preHandler: requireAdmin }, async (request, reply) => {
    const requested = Number(request.query.bytes);
    const bytes = Number.isInteger(requested) ? Math.min(512 * 1024, Math.max(1, requested)) : 256 * 1024;
    reply.header("Cache-Control", "no-store");
    reply.type("text/plain; charset=utf-8");
    return "0".repeat(bytes);
  });

  app.post("/api/v1/connection-quality/upload", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(connectionQualityUploadSchema, request.body, reply);
    if (!body) return;
    reply.header("Cache-Control", "no-store");
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/v1/connection-quality/targets/:id/probe", { preHandler: requireAdmin }, async (request, reply) => {
    const item = app.activeConnections.get(request.params.id, request.admin!);
    if (!item || item.ownerId !== request.admin!.id) {
      return reply.code(404).send({ error: "ACTIVE_CONNECTION_NOT_FOUND", message: "活动目标不存在或已经断开" });
    }
    const target = await activeTargetAddress(app, item);
    if (!target) return reply.code(404).send({ error: "TARGET_NOT_FOUND", message: "无法确定活动连接的目标地址" });
    try {
      return { latencyMs: await probeTcpTarget(target), checkedAt: new Date().toISOString() };
    } catch (error) {
      return reply.code(502).send({
        error: "TARGET_PROBE_FAILED",
        message: error instanceof Error ? error.message : "目标连接探测失败",
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/desktop/connection-quality/targets/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const scope = executionScope(request);
    if (!scope) return reply.code(400).send({ error: "EXECUTION_SCOPE_REQUIRED", message: "缺少有效的 App 执行实例标识" });
    const item = app.activeConnections.getForExecutionScope(request.params.id, request.admin!, scope);
    if (!item || item.ownerId !== request.admin!.id || item.executionMode !== "local") {
      return reply.code(404).send({ error: "ACTIVE_CONNECTION_NOT_FOUND", message: "本机活动目标不存在或已经断开" });
    }
    const target: ConnectionQualityTargetAddress | null = await activeTargetAddress(app, item);
    if (!target) return reply.code(404).send({ error: "TARGET_NOT_FOUND", message: "无法确定活动连接的目标地址" });
    return target;
  });

  app.get("/api/v1/active-connections", { preHandler: requireAdmin }, async (request) => ({
    current: app.activeConnections.activeCount(request.admin!.id),
    limit: app.activeConnections.limit,
    idleMinutes: app.activeConnections.idleMinutes,
    items: app.activeConnections.list(request.admin!, executionScope(request)),
  }));

  app.get<{ Params: { id: string } }>("/api/v1/active-connections/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const item = app.activeConnections.get(request.params.id, request.admin!);
    if (!item) return reply.code(404).send({ error: "ACTIVE_CONNECTION_NOT_FOUND", message: "活动连接不存在或已经断开" });
    return { item };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/active-connections/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const actor = request.admin!;
    const item = await app.activeConnections.closeForViewer(
      request.params.id,
      actor,
      actor.isPlatformAdmin ? `平台管理员 ${actor.username} 主动关闭连接` : "用户主动关闭连接",
    );
    if (!item) return reply.code(404).send({ error: "ACTIVE_CONNECTION_NOT_FOUND", message: "活动连接不存在或已经断开" });
    await writeAudit(app.db, {
      action: "active_connection.closed",
      resourceType: "active_connection",
      resourceId: item.id,
      summary: `${actor.isPlatformAdmin && item.ownerId !== actor.id ? "管理员" : "用户"}关闭${item.label}`,
      details: { ownerId: item.ownerId, type: item.type, resourceId: item.resourceId, client: item.client, executionMode: item.executionMode },
      request,
    });
    return reply.code(204).send();
  });

  app.post("/api/v1/active-connections/desktop", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(desktopReservationSchema, request.body, reply);
    const scope = executionScope(request);
    if (!body || !request.admin) return;
    if (!scope) return reply.code(400).send({ error: "EXECUTION_SCOPE_REQUIRED", message: "缺少有效的 App 执行实例标识" });
    if (!await canReserveDesktop(app, request.admin, body)) return reply.code(404).send({ error: "NOT_FOUND", message: "连接资源不存在或无权访问" });
    if (body.originEnvironmentId && !await canAccessEnvironment(app.db, request.admin, body.originEnvironmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "来源环境不存在或无权访问" });
    }
    try {
      const item = await app.activeConnections.reserve({
        ...body,
        user: request.admin,
        executionScope: scope,
        client: "desktop",
        executionMode: "local",
        external: true,
      });
      return reply.code(201).send({ item, limit: app.activeConnections.limit, idleMinutes: app.activeConnections.idleMinutes });
    } catch (error) {
      return sendReservationError(error, reply);
    }
  });

  app.put("/api/v1/active-connections/desktop", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(desktopHeartbeatSchema, request.body, reply);
    const scope = executionScope(request);
    if (!body || !request.admin) return;
    if (!scope) return reply.code(400).send({ error: "EXECUTION_SCOPE_REQUIRED", message: "缺少有效的 App 执行实例标识" });
    return { close: app.activeConnections.syncExternal(request.admin.id, scope, body.items) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/active-connections/desktop/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const scope = executionScope(request);
    if (!scope || !request.admin) return reply.code(400).send({ error: "EXECUTION_SCOPE_REQUIRED", message: "缺少有效的 App 执行实例标识" });
    if (!app.activeConnections.releaseExternal(request.params.id, request.admin.id, scope)) {
      return reply.code(404).send({ error: "ACTIVE_CONNECTION_NOT_FOUND", message: "活动连接不存在或已经断开" });
    }
    return reply.code(204).send();
  });

  app.post("/api/v1/database-sessions", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(databaseSessionSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    }
    if (body.originEnvironmentId && !await canAccessEnvironment(app.db, request.admin, body.originEnvironmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "来源环境不存在或无权访问" });
    }
    try {
      const item = await app.activeConnections.reserve({
        user: request.admin,
        type: "database",
        resourceId: body.connectionId,
        originEnvironmentId: body.originEnvironmentId,
        executionScope: executionScope(request),
        client: executionScope(request) ? "desktop" : "web",
        executionMode: request.headers["x-viron-execution-mode"] === "local" ? "local" : "server",
      });
      app.activeConnections.activate(item.id, (reason) => {
        app.databaseQueries.closeConnection(request.admin!.id, body.connectionId, reason, executionScope(request));
      });
      return reply.code(201).send({ item, limit: app.activeConnections.limit, idleMinutes: app.activeConnections.idleMinutes });
    } catch (error) {
      return sendReservationError(error, reply);
    }
  });

  app.post("/api/v1/database-sessions/activity", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(databaseActivitySchema, request.body, reply);
    if (!body || !request.admin) return;
    app.activeConnections.touchResource(request.admin.id, "database", body.connectionId, executionScope(request));
    return reply.code(204).send();
  });

  app.post("/api/v1/redis-sessions", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(redisSessionSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "redis", body.connectionId)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "Redis 连接不存在" });
    }
    if (body.originEnvironmentId && !await canAccessEnvironment(app.db, request.admin, body.originEnvironmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "来源环境不存在或无权访问" });
    }
    try {
      const item = await app.activeConnections.reserve({
        user: request.admin,
        type: "redis",
        resourceId: body.connectionId,
        originEnvironmentId: body.originEnvironmentId,
        executionScope: executionScope(request),
        client: executionScope(request) ? "desktop" : "web",
        executionMode: request.headers["x-viron-execution-mode"] === "local" ? "local" : "server",
      });
      app.activeConnections.activate(item.id, () => undefined);
      return reply.code(201).send({ item, limit: app.activeConnections.limit, idleMinutes: app.activeConnections.idleMinutes });
    } catch (error) {
      return sendReservationError(error, reply);
    }
  });

  app.post("/api/v1/redis-sessions/activity", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(redisActivitySchema, request.body, reply);
    if (!body || !request.admin) return;
    app.activeConnections.touchResource(request.admin.id, "redis", body.connectionId, executionScope(request));
    return reply.code(204).send();
  });
}
