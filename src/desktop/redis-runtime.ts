import { translate as tr } from "./i18n.js";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Redis, type RedisOptions } from "ioredis";
import {
  parseRedisInfo,
  redisBinaryValue,
  redisCommandAccess,
  redisReply,
  redisResponseBytes,
  validateRedisBoundedRead,
} from "../shared/redis.js";
import type { DesktopRedisCredential } from "./device-identity.js";
import { connectDesktopSsh, type ConnectedDesktopSsh, type DesktopSshContext } from "./ssh-runtime.js";
import { IdleResourcePool } from "../shared/idle-resource-pool.js";
import { contextKey } from "./ssh-context.js";
import { jsonResponse, type DesktopRedisResponse } from "./json-response.js";

export type { DesktopRedisResponse };

export interface DesktopRedisRequest {
  path: string;
  method?: string;
  body?: { kind: "text" | "form"; value?: string };
}

export interface DesktopRedisExecutionReport {
  operationId: string;
  connectionId: string;
  action: "connection_tested" | "connection_test_failed" | "info_read" | "keys_scanned" | "command_executed" | "command_failed" | "command_rejected" | "commands_read_batch";
  summary: string;
  details: Record<string, unknown>;
}

interface LocalForward {
  host: string;
  port: number;
  close(): Promise<void>;
}

interface ConnectedDesktopRedis {
  client: Redis;
  credential: DesktopRedisCredential;
  close(): Promise<void>;
}

class DesktopRedisError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function parsedJson(request: DesktopRedisRequest): Record<string, unknown> {
  if (request.body?.kind !== "text") return {};
  try {
    const value = JSON.parse(request.body.value ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new DesktopRedisError(400, "INVALID_BODY", tr("请求内容不是有效 JSON"));
  }
}

function databaseNumber(value: unknown, optional = false): number | undefined {
  if ((value === undefined || value === null || value === "") && optional) return undefined;
  const database = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(database) || database < 0 || database > 1023) throw new DesktopRedisError(400, "INVALID_DATABASE", tr("Redis 数据库编号必须为 0–1023"));
  return database;
}

function positiveInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new DesktopRedisError(400, "INVALID_REQUEST", tr("数值必须在 {{0}}–{{1}} 之间", [minimum, maximum]));
  return parsed;
}

function argumentBuffer(value: unknown): Buffer {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 256 * 1024) throw new DesktopRedisError(400, "INVALID_ARGUMENT", tr("命令参数超过 256 KiB 限制"));
    return Buffer.from(value, "utf8");
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { base64?: unknown }).base64 === "string") {
    const base64 = (value as { base64: string }).base64;
    if (base64.length > 512 * 1024) throw new DesktopRedisError(400, "INVALID_ARGUMENT", tr("Base64 命令参数过大"));
    const buffer = Buffer.from(base64, "base64");
    if (buffer.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) throw new DesktopRedisError(400, "INVALID_ARGUMENT", tr("命令参数包含无效 Base64"));
    return buffer;
  }
  throw new DesktopRedisError(400, "INVALID_ARGUMENT", tr("Redis 命令参数无效"));
}

export function desktopRedisErrorMessage(error: unknown): string {
  const value = error as { code?: string; message?: string };
  const message = value.message || String(error);
  if (/WRONGPASS|NOAUTH/i.test(message)) return tr("Redis 认证失败，请检查用户名和密码");
  if (value.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message)) return tr("Redis 端口拒绝连接");
  if (value.code === "ETIMEDOUT" || /timeout/i.test(message)) return tr("Redis 连接超时");
  if (value.code === "ENOTFOUND" || value.code === "EAI_AGAIN") return tr("无法解析 Redis 主机地址");
  return message;
}

async function createSshForward(credential: DesktopRedisCredential): Promise<LocalForward> {
  if (!credential.sshCredential) throw new Error(tr("Redis 连接缺少 SSH Tunnel 凭据"));
  const ssh: ConnectedDesktopSsh = await connectDesktopSsh(credential.sshCredential);
  const sockets = new Set<net.Socket>();
  const target = credential.connection;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    ssh.client.forwardOut("127.0.0.1", 0, target.host, target.port, (error, stream) => {
      if (error) return socket.destroy(error);
      socket.pipe(stream).pipe(socket);
      stream.once("error", (streamError: Error) => socket.destroy(streamError));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    ssh.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    ssh.close();
    throw new Error(tr("无法建立 Redis SSH Tunnel 本地端口"));
  }
  return {
    host: "127.0.0.1",
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ssh.close();
    },
  };
}

function redisOptions(credential: DesktopRedisCredential, host: string, port: number, database: number): RedisOptions {
  const connection = credential.connection;
  const tls = connection.options.tls;
  return {
    host,
    port,
    username: connection.username || undefined,
    password: connection.password || undefined,
    db: database,
    connectTimeout: connection.options.connectTimeoutMs ?? 10_000,
    commandTimeout: connection.options.connectTimeoutMs ?? 10_000,
    connectionName: `viron-desktop:${connection.connectionId}`,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    stringNumbers: true,
    tls: tls?.enabled ? {
      rejectUnauthorized: tls.rejectUnauthorized !== false,
      servername: tls.serverName || connection.host,
      ca: tls.ca || undefined,
      cert: tls.certificate || undefined,
      key: tls.privateKey || undefined,
      passphrase: tls.passphrase || undefined,
    } : undefined,
  };
}

export async function connectDesktopRedis(credential: DesktopRedisCredential, database?: number): Promise<ConnectedDesktopRedis> {
  const connection = credential.connection;
  let forward: LocalForward | undefined;
  let client: Redis | undefined;
  try {
    if (connection.connectionMode === "sshTunnel") forward = await createSshForward(credential);
    client = new Redis(redisOptions(credential, forward?.host ?? connection.host, forward?.port ?? connection.port, database ?? connection.defaultDatabase));
    await client.connect();
    return {
      client,
      credential,
      close: async () => {
        client?.disconnect(false);
        await forward?.close();
      },
    };
  } catch (error) {
    client?.disconnect(false);
    await forward?.close();
    throw error;
  }
}

export function isDesktopRedisExecutionPath(path: string): boolean {
  const pathname = new URL(path, "http://desktop.local").pathname;
  return /^\/api\/v1\/redis-connections\/[^/]+\/(?:test|info|scan|command|commands\/batch)$/.test(pathname);
}

export class DesktopRedisRuntime {
  private readonly active = new Map<string, { connectionId: string; connected: ConnectedDesktopRedis }>();
  private readonly connectionPool: IdleResourcePool<{ context: DesktopSshContext; connected: ConnectedDesktopRedis }>;

  constructor(
    private readonly loadCredential: (connectionId: string) => Promise<{ context: DesktopSshContext; credential: DesktopRedisCredential }>,
    private readonly report: (report: DesktopRedisExecutionReport, context?: DesktopSshContext) => Promise<void>,
  ) {
    this.connectionPool = new IdleResourcePool({
      maxIdlePerKey: 2,
      usable: (resource) => resource.connected.client.status === "ready",
      dispose: (resource) => resource.connected.close(),
    });
  }

  activeCount(): number {
    return this.active.size;
  }

  async handle(request: DesktopRedisRequest, context: DesktopSshContext): Promise<DesktopRedisResponse> {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      const url = new URL(request.path, "http://desktop.local");
      const match = url.pathname.match(/^\/api\/v1\/redis-connections\/([0-9a-f-]+)\/(test|info|scan|command|commands\/batch)$/i);
      if (!match) return jsonResponse(404, { error: "NOT_FOUND", message: tr("接口不存在") });
      const [, connectionId, action] = match;
      if (action === "test" && method === "POST") return jsonResponse(200, await this.testConnection(connectionId, context));
      if (action === "info" && method === "GET") return jsonResponse(200, await this.info(connectionId, url, context));
      if (action === "scan" && method === "POST") return jsonResponse(200, await this.scan(connectionId, parsedJson(request), context));
      if (action === "commands/batch" && method === "POST") return jsonResponse(200, await this.commandBatch(connectionId, parsedJson(request), context));
      if (action === "command" && method === "POST") return jsonResponse(200, await this.command(connectionId, parsedJson(request), context));
      return jsonResponse(405, { error: "METHOD_NOT_ALLOWED", message: tr("请求方法不受支持") });
    } catch (error) {
      const failure = error instanceof DesktopRedisError
        ? error
        : new DesktopRedisError(502, "REDIS_EXECUTION_FAILED", desktopRedisErrorMessage(error));
      return jsonResponse(failure.status, { error: failure.code, message: failure.message });
    }
  }

  async closeConnection(connectionId: string): Promise<void> {
    const closing = [...this.active.entries()].filter(([, item]) => item.connectionId === connectionId);
    await Promise.all(closing.map(async ([id, item]) => {
      this.active.delete(id);
      await item.connected.close();
    }));
    await this.connectionPool.invalidate((key) => key.startsWith(`${connectionId}\0`));
  }

  async closeAll(): Promise<void> {
    const closing = [...this.active.values()];
    this.active.clear();
    await Promise.all(closing.map((item) => item.connected.close()));
    await this.connectionPool.invalidate();
  }

  private async connect(connectionId: string, database: number | undefined, expectedContext: DesktopSshContext) {
    const key = `${connectionId}\0${database ?? ""}`;
    const lease = await this.connectionPool.acquire(key, async () => {
      const loaded = await this.loadCredential(connectionId);
      return { context: loaded.context, connected: await connectDesktopRedis(loaded.credential, database) };
    });
    const pooled = lease.resource;
    if (contextKey(pooled.context) !== contextKey(expectedContext)) {
      await lease.release(true);
      throw new DesktopRedisError(403, "CONTEXT_CHANGED", tr("本机 Redis 执行所属用户或工作空间已经切换"));
    }
    const connected: ConnectedDesktopRedis = {
      client: pooled.connected.client,
      credential: pooled.connected.credential,
      close: async () => { await lease.release(pooled.connected.client.status !== "ready"); },
    };
    const operationId = randomUUID();
    this.active.set(operationId, { connectionId, connected });
    return {
      context: pooled.context,
      connected,
      close: async () => {
        this.active.delete(operationId);
        await connected.close();
      },
    };
  }

  private async testConnection(connectionId: string, expectedContext: DesktopSshContext) {
    const started = Date.now();
    let reportContext: DesktopSshContext | undefined;
    try {
      const session = await this.connect(connectionId, undefined, expectedContext);
      reportContext = session.context;
      try {
        await session.connected.client.ping();
        const info = parseRedisInfo(await session.connected.client.info("server"));
        const latencyMs = Date.now() - started;
        const version = info.server?.redis_version ?? "";
        await this.report({
          operationId: randomUUID(), connectionId, action: "connection_tested",
          summary: tr("本机 Redis 连接测试成功 {{0}}", [session.connected.credential.connection.name]),
          details: { latencyMs, version },
        }, session.context);
        return { ok: true, latencyMs, version, mode: info.server?.redis_mode ?? "standalone" };
      } finally {
        await session.close();
      }
    } catch (error) {
      await this.report({
        operationId: randomUUID(), connectionId, action: "connection_test_failed",
        summary: tr("本机 Redis 连接测试失败"),
        details: { latencyMs: Date.now() - started, message: desktopRedisErrorMessage(error) },
      }, reportContext).catch(() => undefined);
      throw error;
    }
  }

  private async info(connectionId: string, url: URL, expectedContext: DesktopSshContext) {
    const database = databaseNumber(url.searchParams.get("database"), true);
    const session = await this.connect(connectionId, database, expectedContext);
    try {
      const info = parseRedisInfo(await session.connected.client.info());
      await this.report({
        operationId: randomUUID(), connectionId, action: "info_read", summary: tr("本机读取 Redis 运行信息"),
        details: { database: session.connected.client.options.db },
      }, session.context);
      return { info, database: session.connected.client.options.db };
    } finally {
      await session.close();
    }
  }

  private async scan(connectionId: string, body: Record<string, unknown>, expectedContext: DesktopSshContext) {
    const database = databaseNumber(body.database, true);
    const cursor = body.cursor === undefined ? "0" : String(body.cursor);
    if (!/^\d+$/.test(cursor)) throw new DesktopRedisError(400, "INVALID_CURSOR", tr("SCAN 游标无效"));
    const pattern = body.pattern === undefined ? "*" : String(body.pattern);
    if (pattern.length > 1024) throw new DesktopRedisError(400, "INVALID_PATTERN", tr("键匹配模式过长"));
    const count = positiveInteger(body.count, 200, 10, 1000);
    const type = body.type === undefined ? "" : String(body.type);
    if (type && !["string", "hash", "list", "set", "zset", "stream"].includes(type)) throw new DesktopRedisError(400, "INVALID_TYPE", tr("Redis 数据类型无效"));
    const session = await this.connect(connectionId, database, expectedContext);
    try {
      const args: Array<string | number> = [cursor, "MATCH", pattern, "COUNT", count];
      if (type) args.push("TYPE", type);
      const response = await session.connected.client.callBuffer("SCAN", ...args) as unknown;
      if (!Array.isArray(response) || response.length !== 2 || !Array.isArray(response[1])) throw new Error(tr("Redis 返回了无效的 SCAN 结果"));
      if (redisResponseBytes(response) > MAX_RESPONSE_BYTES) throw new DesktopRedisError(413, "REDIS_RESPONSE_TOO_LARGE", tr("Redis 响应超过 2 MiB 限制"));
      const nextCursor = Buffer.isBuffer(response[0]) ? response[0].toString("utf8") : String(response[0]);
      const keys = (response[1] as unknown[]).filter(Buffer.isBuffer) as Buffer[];
      const pipeline = session.connected.client.pipeline();
      for (const key of keys) pipeline.type(key).pttl(key);
      const metadata = await pipeline.exec();
      await this.report({
        operationId: randomUUID(), connectionId, action: "keys_scanned", summary: tr("本机扫描 Redis 键空间"),
        details: { database: session.connected.client.options.db, pattern, count: keys.length, complete: nextCursor === "0" },
      }, session.context);
      return {
        cursor: nextCursor,
        complete: nextCursor === "0",
        items: keys.map((key, index) => ({
          key: redisBinaryValue(key),
          type: String(metadata?.[index * 2]?.[1] ?? "none"),
          ttlMs: Number(metadata?.[index * 2 + 1]?.[1] ?? -2),
        })),
      };
    } finally {
      await session.close();
    }
  }

  private async commandBatch(connectionId: string, body: Record<string, unknown>, expectedContext: DesktopSshContext) {
    if (!Array.isArray(body.commands) || body.commands.length < 1 || body.commands.length > 20) {
      throw new DesktopRedisError(400, "INVALID_BATCH", tr("批量 Redis 命令数量必须为 1–20 条"));
    }
    const commands = body.commands.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopRedisError(400, "INVALID_BATCH", tr("批量 Redis 命令参数无效"));
      const input = value as Record<string, unknown>;
      if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 64) throw new DesktopRedisError(400, "INVALID_COMMAND", tr("Redis 命令无效"));
      if (input.args !== undefined && !Array.isArray(input.args)) throw new DesktopRedisError(400, "INVALID_ARGUMENTS", tr("Redis 命令参数无效"));
      const args = ((input.args ?? []) as unknown[]).map(argumentBuffer);
      const command = input.command.trim().toUpperCase();
      if (redisCommandAccess(command, args.map((item) => item.toString("utf8"))) !== "read") throw new DesktopRedisError(400, "REDIS_BATCH_NOT_READ_ONLY", tr("Redis 批量读取不允许执行 {{0}}", [command]));
      const boundedError = validateRedisBoundedRead(command, args);
      if (boundedError) throw new DesktopRedisError(400, "REDIS_COMMAND_UNBOUNDED", boundedError);
      return { database: databaseNumber(input.database, true), command, args };
    });
    const started = Date.now();
    let responseBytes = 0;
    const items = [];
    let reportContext: DesktopSshContext | undefined = expectedContext;
    const sessions = new Map<string, Awaited<ReturnType<DesktopRedisRuntime["connect"]>>>();
    try {
      for (let index = 0; index < commands.length; index += 1) {
        const commandStarted = Date.now();
        const databaseKey = String(commands[index].database ?? "");
        try {
          let session = sessions.get(databaseKey);
          if (!session) {
            session = await this.connect(connectionId, commands[index].database, expectedContext);
            sessions.set(databaseKey, session);
          }
          reportContext = session.context;
          const response = await session.connected.client.callBuffer(commands[index].command, ...commands[index].args);
          const byteLength = redisResponseBytes(response);
          responseBytes += byteLength;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            items.push({ index, ok: false, command: commands[index].command, error: tr("批量 Redis 响应累计超过 2 MiB 限制"), durationMs: Date.now() - commandStarted });
            break;
          }
          items.push({ index, ok: true, command: commands[index].command, result: redisReply(response), byteLength, durationMs: Date.now() - commandStarted });
        } catch (error) {
          items.push({ index, ok: false, command: commands[index].command, error: desktopRedisErrorMessage(error), durationMs: Date.now() - commandStarted });
        }
      }
    } finally {
      await Promise.all([...sessions.values()].map((session) => session.close()));
    }
    await this.report({
      operationId: randomUUID(), connectionId, action: "commands_read_batch",
      summary: tr("本机批量执行 {{0}} 条 Redis 只读命令", [commands.length]),
      details: { commandCount: commands.length, failedCount: items.filter((item) => !item.ok).length, responseBytes, durationMs: Date.now() - started },
    }, reportContext);
    return { items, durationMs: Date.now() - started, reusedConnection: commands.length > new Set(commands.map((item) => item.database ?? "")).size };
  }

  private async command(connectionId: string, body: Record<string, unknown>, expectedContext: DesktopSshContext) {
    const database = databaseNumber(body.database, true);
    if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 64) throw new DesktopRedisError(400, "INVALID_COMMAND", tr("Redis 命令无效"));
    if (body.args !== undefined && !Array.isArray(body.args)) throw new DesktopRedisError(400, "INVALID_ARGUMENTS", tr("Redis 命令参数无效"));
    const rawArgs = (body.args ?? []) as unknown[];
    if (rawArgs.length > 256) throw new DesktopRedisError(400, "INVALID_ARGUMENTS", tr("Redis 命令参数过多"));
    const command = body.command.trim().toUpperCase();
    const args = rawArgs.map(argumentBuffer);
    const access = redisCommandAccess(command, args.map((value) => value.toString("utf8")));
    const started = Date.now();
    const operationId = randomUUID();
    let reportContext: DesktopSshContext | undefined = expectedContext;
    let commandExecuted = false;
    let executionReported = false;
    try {
      if (access === "deny") throw new DesktopRedisError(403, "REDIS_COMMAND_BLOCKED", tr("当前策略不允许执行 {{0}}", [command]));
      const boundedError = validateRedisBoundedRead(command, args);
      if (boundedError) throw new DesktopRedisError(400, "REDIS_COMMAND_UNBOUNDED", boundedError);
      const session = await this.connect(connectionId, database, expectedContext);
      reportContext = session.context;
      try {
        if (session.connected.credential.connection.options.readOnly && access !== "read") throw new DesktopRedisError(403, "REDIS_CONNECTION_READ_ONLY", tr("当前 Redis 连接为只读模式"));
        const response = await session.connected.client.callBuffer(command, ...args);
        commandExecuted = true;
        const byteLength = redisResponseBytes(response);
        const durationMs = Date.now() - started;
        await this.report({
          operationId, connectionId, action: "command_executed", summary: tr("本机执行 Redis 命令 {{0}}", [command]),
          details: { command, argumentCount: args.length, access, durationMs, byteLength, responseTooLarge: byteLength > MAX_RESPONSE_BYTES, database: session.connected.client.options.db },
        }, session.context);
        executionReported = true;
        if (byteLength > MAX_RESPONSE_BYTES) throw new DesktopRedisError(413, "REDIS_RESPONSE_TOO_LARGE", tr("Redis 响应超过 2 MiB 限制"));
        return { result: redisReply(response), durationMs, byteLength };
      } finally {
        await session.close();
      }
    } catch (error) {
      if (!executionReported) {
        const rejected = error instanceof DesktopRedisError && ["REDIS_COMMAND_BLOCKED", "REDIS_COMMAND_UNBOUNDED", "REDIS_CONNECTION_READ_ONLY"].includes(error.code);
        const action = commandExecuted ? "command_executed" : rejected ? "command_rejected" : "command_failed";
        await this.report({
          operationId, connectionId, action,
          summary: action === "command_executed" ? tr("本机执行 Redis 命令 {{0}}", [command]) : action === "command_rejected" ? tr("本机拒绝 Redis 命令 {{0}}", [command]) : tr("本机 Redis 命令失败 {{0}}", [command]),
          details: { command, argumentCount: args.length, access, durationMs: Date.now() - started, message: desktopRedisErrorMessage(error) },
        }, reportContext).catch(() => undefined);
      }
      throw error;
    }
  }
}
