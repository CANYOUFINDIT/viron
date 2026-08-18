import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canAccessConnection } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { executionScope } from "../execution-scope.js";
import { connectRedis, type ConnectedRedis } from "../redis/connector.js";
import { parseBody } from "../validation.js";
import {
  parseRedisInfo,
  redisBinaryValue,
  redisCommandAccess,
  redisReply,
  redisResponseBytes,
  validateRedisBoundedRead,
} from "../../shared/redis.js";
import { requireAdmin } from "./auth.js";

const databaseSchema = z.number().int().min(0).max(1023).optional();
const maxResponseBytes = 2 * 1024 * 1024;

const scanSchema = z.object({
  database: databaseSchema,
  cursor: z.string().regex(/^\d+$/).default("0"),
  pattern: z.string().max(1024).default("*"),
  count: z.number().int().min(10).max(1000).default(200),
  type: z.enum(["string", "hash", "list", "set", "zset", "stream"]).optional(),
});

const commandArgumentSchema = z.union([
  z.string().max(256 * 1024),
  z.object({ base64: z.string().max(512 * 1024) }),
]);

const commandSchema = z.object({
  database: databaseSchema,
  command: z.string().trim().min(1).max(64),
  args: z.array(commandArgumentSchema).max(256).default([]),
});
const commandBatchSchema = z.object({
  commands: z.array(commandSchema).min(1).max(20),
});

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/WRONGPASS|NOAUTH/i.test(message)) return "Redis 认证失败，请检查用户名和密码";
  if (/ECONNREFUSED/i.test(message)) return "Redis 端口拒绝连接";
  if (/ETIMEDOUT|timeout/i.test(message)) return "Redis 连接超时";
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return "无法解析 Redis 主机地址";
  if (/CERT_|certificate|self[- ]signed|hostname.*match|unable to verify/i.test(message)) return `Redis TLS 证书校验失败：${message}`;
  return message;
}

const connectionStageLabels = {
  connect: "网络或 TLS 建连",
  ping: "认证后 PING",
  info: "读取服务信息",
} as const;

function argumentBuffer(argument: z.infer<typeof commandArgumentSchema>): Buffer {
  if (typeof argument === "string") return Buffer.from(argument, "utf8");
  const buffer = Buffer.from(argument.base64, "base64");
  if (buffer.toString("base64").replace(/=+$/, "") !== argument.base64.replace(/=+$/, "")) throw new Error("命令参数包含无效 Base64");
  return buffer;
}

export async function registerRedisWorkbenchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/redis-connections/")) return;
    const connectionId = (request.params as { id?: string }).id;
    if (connectionId && !await canAccessConnection(app.db, request.admin!, "redis", connectionId)) {
      await reply.code(404).send({ error: "NOT_FOUND", message: "Redis 连接不存在" });
    }
  });

  function touchConnection(request: FastifyRequest, connectionId: string): void {
    if (!request.admin) return;
    app.activeConnections.touchResource(request.admin.id, "redis", connectionId, executionScope(request));
  }

  app.post<{ Params: { id: string } }>("/api/v1/redis-connections/:id/test", async (request, reply) => {
    const started = Date.now();
    let stage: keyof typeof connectionStageLabels = "connect";
    let connected: ConnectedRedis | undefined;
    try {
      connected = await connectRedis(app, request.params.id);
      stage = "ping";
      await connected.client.ping();
      stage = "info";
      const info = parseRedisInfo(await connected.client.info("server"));
      const latencyMs = Date.now() - started;
      const version = info.server?.redis_version ?? "";
      await writeAudit(app.db, { action: "redis.connection_tested", resourceType: "redis_connection", resourceId: request.params.id, summary: `Redis 连接测试成功 ${connected.record.name}`, details: { latencyMs, version }, request });
      return { ok: true, latencyMs, version, mode: info.server?.redis_mode ?? "standalone" };
    } catch (error) {
      const message = errorMessage(error);
      await writeAudit(app.db, { action: "redis.connection_test_failed", resourceType: "redis_connection", resourceId: request.params.id, summary: "Redis 连接测试失败", details: { message, stage }, request });
      return reply.code(502).send({ error: "REDIS_CONNECTION_FAILED", stage, message: `${connectionStageLabels[stage]}失败：${message}` });
    } finally {
      await connected?.close();
    }
  });

  app.get<{ Params: { id: string }; Querystring: { database?: string } }>("/api/v1/redis-connections/:id/info", async (request, reply) => {
    const database = Number.parseInt(request.query.database ?? "", 10);
    if (request.query.database !== undefined && (!Number.isInteger(database) || database < 0 || database > 1023)) {
      return reply.code(400).send({ error: "INVALID_DATABASE", message: "Redis 数据库编号必须为 0–1023" });
    }
    try {
      const connected = await connectRedis(app, request.params.id, Number.isInteger(database) ? database : undefined);
      try {
        const info = parseRedisInfo(await connected.client.info());
        touchConnection(request, request.params.id);
        await writeAudit(app.db, { action: "redis.info_read", resourceType: "redis_connection", resourceId: request.params.id, summary: `读取 Redis 运行信息 ${connected.record.name}`, details: { database: connected.client.options.db }, request });
        return { info, database: connected.client.options.db };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "REDIS_INFO_FAILED", message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/redis-connections/:id/scan", async (request, reply) => {
    const body = parseBody(scanSchema, request.body, reply);
    if (!body) return;
    try {
      const connected = await connectRedis(app, request.params.id, body.database);
      try {
        const args: Array<string | number> = [body.cursor, "MATCH", body.pattern, "COUNT", body.count];
        if (body.type) args.push("TYPE", body.type);
        const response = await connected.client.callBuffer("SCAN", ...args) as unknown;
        if (!Array.isArray(response) || response.length !== 2 || !Array.isArray(response[1])) throw new Error("Redis 返回了无效的 SCAN 结果");
        if (redisResponseBytes(response) > maxResponseBytes) return reply.code(413).send({ error: "REDIS_RESPONSE_TOO_LARGE", message: "Redis 响应超过 2 MiB 限制" });
        const cursor = Buffer.isBuffer(response[0]) ? response[0].toString("utf8") : String(response[0]);
        const keys = (response[1] as unknown[]).filter(Buffer.isBuffer) as Buffer[];
        const pipeline = connected.client.pipeline();
        for (const key of keys) pipeline.type(key).pttl(key);
        const metadata = await pipeline.exec();
        touchConnection(request, request.params.id);
        await writeAudit(app.db, {
          action: "redis.keys_scanned",
          resourceType: "redis_connection",
          resourceId: request.params.id,
          summary: `扫描 Redis 键空间 ${connected.record.name}`,
          details: { database: connected.client.options.db, pattern: body.pattern, count: keys.length, complete: cursor === "0" },
          request,
        });
        return {
          cursor,
          complete: cursor === "0",
          items: keys.map((key, index) => ({
            key: redisBinaryValue(key),
            type: String(metadata?.[index * 2]?.[1] ?? "none"),
            ttlMs: Number(metadata?.[index * 2 + 1]?.[1] ?? -2),
          })),
        };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "REDIS_SCAN_FAILED", message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/redis-connections/:id/command", async (request, reply) => {
    const body = parseBody(commandSchema, request.body, reply);
    if (!body) return;
    const command = body.command.toUpperCase();
    const args = body.args.map(argumentBuffer);
    const access = redisCommandAccess(command, args.map((value) => value.toString("utf8")));
    if (access === "deny") {
      await writeAudit(app.db, { action: "redis.command_rejected", resourceType: "redis_connection", resourceId: request.params.id, summary: `拒绝 Redis 命令 ${command}`, details: { command, argumentCount: args.length, reason: "policy" }, request });
      return reply.code(403).send({ error: "REDIS_COMMAND_BLOCKED", message: `当前策略不允许执行 ${command}` });
    }
    const boundedError = validateRedisBoundedRead(command, args);
    if (boundedError) {
      await writeAudit(app.db, { action: "redis.command_rejected", resourceType: "redis_connection", resourceId: request.params.id, summary: `拒绝 Redis 命令 ${command}`, details: { command, argumentCount: args.length, reason: "resource_limit" }, request });
      return reply.code(400).send({ error: "REDIS_COMMAND_UNBOUNDED", message: boundedError });
    }
    const started = Date.now();
    try {
      const connected = await connectRedis(app, request.params.id, body.database);
      try {
        if (connected.record.options.readOnly && access !== "read") {
          await writeAudit(app.db, { action: "redis.command_rejected", resourceType: "redis_connection", resourceId: request.params.id, summary: `只读连接拒绝 Redis 命令 ${command}`, details: { command, argumentCount: args.length, reason: "read_only" }, request });
          return reply.code(403).send({ error: "REDIS_CONNECTION_READ_ONLY", message: "当前 Redis 连接为只读模式" });
        }
        const response = await connected.client.callBuffer(command, ...args);
        touchConnection(request, request.params.id);
        const byteLength = redisResponseBytes(response);
        const durationMs = Date.now() - started;
        await writeAudit(app.db, { action: "redis.command_executed", resourceType: "redis_connection", resourceId: request.params.id, summary: `执行 Redis 命令 ${command}`, details: { command, argumentCount: args.length, access, durationMs, byteLength, responseTooLarge: byteLength > maxResponseBytes }, request });
        if (byteLength > maxResponseBytes) return reply.code(413).send({ error: "REDIS_RESPONSE_TOO_LARGE", message: "Redis 响应超过 2 MiB 限制" });
        return { result: redisReply(response), durationMs, byteLength };
      } finally {
        await connected.close();
      }
    } catch (error) {
      const message = errorMessage(error);
      await writeAudit(app.db, { action: "redis.command_failed", resourceType: "redis_connection", resourceId: request.params.id, summary: `Redis 命令失败 ${command}`, details: { command, argumentCount: args.length, message }, request });
      return reply.code(502).send({ error: "REDIS_COMMAND_FAILED", message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/redis-connections/:id/commands/batch", async (request, reply) => {
    const body = parseBody(commandBatchSchema, request.body, reply);
    if (!body) return;
    const commands = body.commands.map((item) => ({
      database: item.database,
      command: item.command.toUpperCase(),
      args: item.args.map(argumentBuffer),
    }));
    for (const item of commands) {
      if (redisCommandAccess(item.command, item.args.map((value) => value.toString("utf8"))) !== "read") {
        return reply.code(400).send({ error: "REDIS_BATCH_NOT_READ_ONLY", message: `Redis 批量读取不允许执行 ${item.command}` });
      }
      const boundedError = validateRedisBoundedRead(item.command, item.args);
      if (boundedError) return reply.code(400).send({ error: "REDIS_COMMAND_UNBOUNDED", message: boundedError });
    }
    const started = Date.now();
    let responseBytes = 0;
    const items = [];
    const connections = new Map<string, ConnectedRedis>();
    try {
      for (let index = 0; index < commands.length; index += 1) {
        const commandStarted = Date.now();
        const databaseKey = String(commands[index].database ?? "");
        try {
          let connected = connections.get(databaseKey);
          if (!connected) {
            connected = await connectRedis(app, request.params.id, commands[index].database);
            connections.set(databaseKey, connected);
          }
          const response = await connected.client.callBuffer(commands[index].command, ...commands[index].args);
          touchConnection(request, request.params.id);
          const byteLength = redisResponseBytes(response);
          responseBytes += byteLength;
          if (responseBytes > maxResponseBytes) {
            items.push({ index, ok: false, command: commands[index].command, error: "批量 Redis 响应累计超过 2 MiB 限制", durationMs: Date.now() - commandStarted });
            break;
          }
          items.push({ index, ok: true, command: commands[index].command, result: redisReply(response), byteLength, durationMs: Date.now() - commandStarted });
        } catch (error) {
          items.push({ index, ok: false, command: commands[index].command, error: errorMessage(error), durationMs: Date.now() - commandStarted });
        }
      }
    } finally {
      await Promise.all([...connections.values()].map((connected) => connected.close()));
    }
    await writeAudit(app.db, {
      action: "mcp.redis_commands_read_batch",
      resourceType: "redis_connection",
      resourceId: request.params.id,
      summary: `MCP 批量执行 ${commands.length} 条 Redis 只读命令`,
      details: { commandCount: commands.length, failedCount: items.filter((item) => !item.ok).length, responseBytes, durationMs: Date.now() - started },
      request,
    });
    return { items, durationMs: Date.now() - started, reusedConnection: commands.length > new Set(commands.map((item) => item.database ?? "")).size };
  });
}
