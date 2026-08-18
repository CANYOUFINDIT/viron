import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeviceIdentity, openRedisCredentialEnvelope, solveDeviceChallenge } from "../src/desktop/device-identity.js";
import { DesktopRedisRuntime } from "../src/desktop/redis-runtime.js";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { parseRedisInfo, redisBinaryValue, redisCommandAccess, redisReply, validateRedisBoundedRead } from "../src/shared/redis.js";

const directories: string[] = [];
const redisProcesses: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const process of redisProcesses.splice(0)) {
    process.kill("SIGTERM");
    await new Promise<void>((resolve) => process.once("exit", () => resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 41),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function appWithLogin(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const config = configFor(directory);
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
  const cookie = login.cookies.find((item) => item.name === "envman_session")!;
  return { app, db, config, cookies: { envman_session: cookie.value }, userId: login.json().user.id as string };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配 Redis 测试端口");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startRedis(binary: string, directory: string): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  const port = await availablePort();
  const process = spawn(binary, [
    "--bind", "127.0.0.1",
    "--protected-mode", "yes",
    "--port", String(port),
    "--dir", directory,
    "--save", "",
    "--appendonly", "no",
  ], { stdio: ["ignore", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  redisProcesses.push(process);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Redis 测试服务启动超时")), 10_000);
    const output = (chunk: Buffer) => {
      if (!chunk.toString("utf8").includes("Ready to accept connections")) return;
      clearTimeout(timeout);
      process.stdout.off("data", output);
      resolve();
    };
    process.stdout.on("data", output);
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Redis 测试服务提前退出：${code}`));
    });
  });
  return { process, port };
}

describe("Redis shared runtime policy", () => {
  it("classifies only explicitly supported commands and read-only subcommands", () => {
    expect(redisCommandAccess("get")).toBe("read");
    expect(redisCommandAccess("SET")).toBe("write");
    expect(redisCommandAccess("MEMORY", ["USAGE", "key"])).toBe("read");
    expect(redisCommandAccess("MEMORY", ["PURGE"])).toBe("deny");
    expect(redisCommandAccess("SLOWLOG", ["GET", "20"])).toBe("read");
    expect(redisCommandAccess("SLOWLOG", ["RESET"])).toBe("deny");
    for (const blocked of ["KEYS", "FLUSHDB", "FLUSHALL", "CONFIG", "ACL", "EVAL", "SCRIPT", "DEBUG", "MONITOR", "SUBSCRIBE"]) {
      expect(redisCommandAccess(blocked)).toBe("deny");
    }
  });

  it("preserves binary values and enforces bounded collection reads", () => {
    const value = Buffer.from([0, 0xff, 0x61]);
    expect(redisBinaryValue(value)).toEqual({ base64: "AP9h", utf8: null, byteLength: 3 });
    expect(redisReply([value, 42])).toEqual({
      type: "array",
      value: [
        { type: "binary", value: { base64: "AP9h", utf8: null, byteLength: 3 } },
        { type: "integer", value: "42" },
      ],
    });
    expect(validateRedisBoundedRead("LRANGE", [Buffer.from("key"), Buffer.from("0"), Buffer.from("999")])).toBeNull();
    expect(validateRedisBoundedRead("LRANGE", [Buffer.from("key"), Buffer.from("0"), Buffer.from("1000")])).toContain("1000");
    expect(validateRedisBoundedRead("XRANGE", [Buffer.from("key"), Buffer.from("-"), Buffer.from("+")])).toContain("COUNT");
    expect(validateRedisBoundedRead("SLOWLOG", [Buffer.from("GET")])).toContain("必须指定");
    expect(validateRedisBoundedRead("ZRANGE", [Buffer.from("key"), Buffer.from("0"), Buffer.from("999"), Buffer.from("BYSCORE")])).toContain("按索引");
    expect(validateRedisBoundedRead("HMGET", [Buffer.from("key"), ...Array.from({ length: 101 }, () => Buffer.from("field"))])).toContain("100");
    expect(validateRedisBoundedRead("MEMORY", [Buffer.from("USAGE"), Buffer.from("key"), Buffer.from("SAMPLES"), Buffer.from("0")])).toContain("1–1000");
  });

  it("reports desktop policy rejections without opening a Redis connection", async () => {
    const reports: Array<{ action: string }> = [];
    const context = { endpoint: "http://127.0.0.1:8080", userId: crypto.randomUUID(), workspaceType: "personal" as const, workspaceId: crypto.randomUUID() };
    const runtime = new DesktopRedisRuntime(
      async () => { throw new Error("不应加载凭据"); },
      async (report) => { reports.push(report); },
    );
    const response = await runtime.handle({
      path: `/api/v1/redis-connections/${crypto.randomUUID()}/command`,
      method: "POST",
      body: { kind: "text", value: JSON.stringify({ command: "FLUSHALL", args: [] }) },
    }, context);
    expect(response.status).toBe(403);
    expect(reports.map((report) => report.action)).toEqual(["command_rejected"]);
  });

  it("parses INFO sections without changing values", () => {
    expect(parseRedisInfo("# Server\r\nredis_version:7.4.1\r\n# Keyspace\r\ndb0:keys=2,expires=1\r\n")).toEqual({
      server: { redis_version: "7.4.1" },
      keyspace: { db0: "keys=2,expires=1" },
    });
  });
});

describe("Redis resource API", () => {
  it("creates, refreshes and closes an environment-scoped Redis activity session", async () => {
    const { app, cookies } = await appWithLogin("viron-redis-session-api-");
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Redis Session Env" } });
    const connection = await app.inject({
      method: "POST", url: "/api/v1/redis-connections", cookies,
      payload: {
        name: "Redis Session",
        host: "redis-session.internal",
        port: 6379,
        username: "",
        defaultDatabase: 0,
        connectionMode: "tcp",
        environmentIds: [environment.json().id],
        options: { connectTimeoutMs: 5000, keySeparator: ":", readOnly: true, tls: { enabled: false, rejectUnauthorized: true, serverName: "" } },
      },
    });
    const scope = crypto.randomUUID();
    const headers = { "x-viron-execution-scope": scope, "x-viron-execution-mode": "local" };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/redis-sessions",
      cookies,
      headers,
      payload: { connectionId: connection.json().id, originEnvironmentId: environment.json().id },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().item).toMatchObject({
      type: "redis",
      resourceId: connection.json().id,
      originEnvironmentId: environment.json().id,
      environmentIds: [environment.json().id],
      environmentNames: ["Redis Session Env"],
      client: "desktop",
      executionMode: "local",
    });

    const listed = await app.inject({ method: "GET", url: "/api/v1/active-connections", cookies, headers });
    const session = listed.json().items.find((item: { id: string }) => item.id === created.json().item.id);
    expect(session).toMatchObject({ currentExecutionInstance: true, type: "redis" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const activity = await app.inject({
      method: "POST",
      url: "/api/v1/redis-sessions/activity",
      cookies,
      headers,
      payload: { connectionId: connection.json().id },
    });
    expect(activity.statusCode).toBe(204);
    const refreshed = await app.inject({ method: "GET", url: "/api/v1/active-connections", cookies, headers });
    const refreshedSession = refreshed.json().items.find((item: { id: string }) => item.id === created.json().item.id);
    expect(Date.parse(refreshedSession.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(session.lastActivityAt));

    const closed = await app.inject({ method: "DELETE", url: `/api/v1/active-connections/${created.json().item.id}`, cookies, headers });
    expect(closed.statusCode).toBe(204);
    expect(app.activeConnections.activeCount(created.json().item.ownerId)).toBe(0);
    await app.close();
  });

  it("creates, lists, copies and deletes encrypted Redis connection resources", async () => {
    const { app, db, cookies, userId } = await appWithLogin("viron-redis-api-");
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Redis Env" } });
    const ssh = await app.inject({
      method: "POST", url: "/api/v1/ssh-connections", cookies,
      payload: { name: "Redis Tunnel", host: "jump.example.com", port: 22, username: "operator", authType: "password", credential: { password: "ssh-secret" } },
    });
    const created = await app.inject({
      method: "POST", url: "/api/v1/redis-connections", cookies,
      payload: {
        name: "Cache Primary",
        host: "redis.internal",
        port: 6380,
        username: "cache-user",
        credential: { password: "redis-secret", tlsCa: "private-ca", tlsPrivateKey: "private-key" },
        defaultDatabase: 3,
        connectionMode: "sshTunnel",
        environmentIds: [environment.json().id],
        options: {
          connectTimeoutMs: 8000,
          keySeparator: ":",
          readOnly: true,
          sshConnectionId: ssh.json().id,
          tls: { enabled: true, rejectUnauthorized: true, serverName: "redis.internal" },
        },
      },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({ method: "GET", url: "/api/v1/connections?type=redis", cookies });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0]).toMatchObject({
      id: created.json().id,
      type: "redis",
      name: "Cache Primary",
      host: "redis.internal",
      defaultDatabase: 3,
      environmentIds: [environment.json().id],
      hasPassword: true,
      hasTlsCa: true,
      hasTlsPrivateKey: true,
      options: { readOnly: true, sshConnectionId: ssh.json().id, tls: { enabled: true, rejectUnauthorized: true, serverName: "redis.internal" } },
    });
    expect(JSON.stringify(listed.json())).not.toContain("redis-secret");
    expect(JSON.stringify(listed.json())).not.toContain("private-key");
    expect(JSON.stringify(listed.json())).not.toContain("private-ca");

    const blocked = await app.inject({
      method: "POST", url: `/api/v1/redis-connections/${created.json().id}/command`, cookies,
      payload: { database: 3, command: "FLUSHALL", args: [] },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("REDIS_COMMAND_BLOCKED");

    const copied = await app.inject({
      method: "POST", url: "/api/v1/redis-connections", cookies,
      payload: {
        copyFromId: created.json().id,
        name: "Cache Primary Copy",
        host: "redis-copy.internal",
        port: 6379,
        username: "cache-user",
        defaultDatabase: 0,
        connectionMode: "tcp",
        options: { connectTimeoutMs: 10000, keySeparator: ":", readOnly: false, tls: { enabled: false, rejectUnauthorized: true, serverName: "" } },
      },
    });
    expect(copied.statusCode).toBe(201);
    const copiedCredential = await db.prepare("SELECT credential_ciphertext FROM redis_connections WHERE id = ?").get(copied.json().id) as { credential_ciphertext: string };
    expect(app.secrets.decrypt(copiedCredential.credential_ciphertext)).toContain("redis-secret");

    const identity = createDeviceIdentity();
    const challenge = await app.inject({ method: "POST", url: "/api/v1/desktop/devices/registration-challenges", cookies, payload: { deviceId: identity.deviceId, publicKey: identity.publicKey } });
    const proof = solveDeviceChallenge(identity, challenge.json().encryptedChallenge);
    await app.inject({ method: "POST", url: `/api/v1/desktop/devices/registration-challenges/${challenge.json().challengeId}/complete`, cookies, payload: { proof } });
    const requestId = crypto.randomUUID();
    const envelope = await app.inject({
      method: "POST", url: `/api/v1/desktop/redis-connections/${created.json().id}/envelope`, cookies,
      payload: { deviceId: identity.deviceId, requestId, endpoint: "http://127.0.0.1:8081" },
    });
    expect(envelope.statusCode).toBe(200);
    const opened = openRedisCredentialEnvelope(identity, envelope.json(), {
      requestId, userId, workspaceType: "personal", workspaceId: userId, connectionId: created.json().id, endpoint: "http://127.0.0.1:8081",
    });
    expect(opened.credential.connection).toMatchObject({ password: "redis-secret", defaultDatabase: 3, connectionMode: "sshTunnel", options: { tls: { ca: "private-ca", privateKey: "private-key" } } });
    expect(opened.credential.sshCredential?.connection.connectionId).toBe(ssh.json().id);

    const removed = await app.inject({ method: "DELETE", url: `/api/v1/redis-connections/${created.json().id}`, cookies });
    expect(removed.statusCode).toBe(204);
    expect(await db.prepare("SELECT id FROM redis_connections WHERE id = ?").get(created.json().id)).toBeUndefined();
    await app.close();
  });
});

const redisServerBinary = process.env.REDIS_SERVER_BIN;
const describeRealRedis = redisServerBinary ? describe : describe.skip;

describeRealRedis("Redis real server integration", () => {
  it("tests, scans and mutates UTF-8 and binary keys against a real Redis server", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "viron-real-redis-runtime-"));
    directories.push(runtimeDirectory);
    const { port } = await startRedis(redisServerBinary!, runtimeDirectory);
    const { app, db, cookies } = await appWithLogin("viron-real-redis-api-");
    const created = await app.inject({
      method: "POST", url: "/api/v1/redis-connections", cookies,
      payload: {
        name: "Real Redis",
        host: "127.0.0.1",
        port,
        username: "",
        defaultDatabase: 2,
        connectionMode: "tcp",
        options: { connectTimeoutMs: 5000, keySeparator: ":", readOnly: false, tls: { enabled: false, rejectUnauthorized: true, serverName: "" } },
      },
    });
    const id = created.json().id as string;
    const execute = (command: string, args: unknown[]) => app.inject({
      method: "POST", url: `/api/v1/redis-connections/${id}/command`, cookies,
      payload: { database: 2, command, args },
    });

    const tested = await app.inject({ method: "POST", url: `/api/v1/redis-connections/${id}/test`, cookies });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: true, mode: "standalone" });
    expect((await app.inject({ method: "GET", url: `/api/v1/redis-connections/${id}/info?database=2`, cookies })).statusCode).toBe(200);

    expect((await execute("SET", ["user:1", "Ada"])).statusCode).toBe(200);
    expect((await execute("HSET", ["user:1:profile", "role", "admin"])).statusCode).toBe(200);
    const binaryKey = Buffer.from([0xff, 0x00, 0x61]);
    const binaryValue = Buffer.from([0x00, 0xff, 0x62]);
    expect((await execute("SET", [{ base64: binaryKey.toString("base64") }, { base64: binaryValue.toString("base64") }])).statusCode).toBe(200);

    const getBinary = await execute("GET", [{ base64: binaryKey.toString("base64") }]);
    expect(getBinary.json().result).toEqual({ type: "binary", value: { base64: binaryValue.toString("base64"), utf8: null, byteLength: 3 } });

    const batch = await app.inject({
      method: "POST", url: `/api/v1/redis-connections/${id}/commands/batch`, cookies,
      payload: { commands: [
        { database: 2, command: "GET", args: ["user:1"] },
        { database: 2, command: "HGET", args: ["user:1:profile", "role"] },
      ] },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({ items: [{ index: 0, ok: true }, { index: 1, ok: true }], reusedConnection: true });
    const rejectedBatch = await app.inject({
      method: "POST", url: `/api/v1/redis-connections/${id}/commands/batch`, cookies,
      payload: { commands: [{ database: 2, command: "SET", args: ["blocked", "value"] }] },
    });
    expect(rejectedBatch.statusCode).toBe(400);
    expect(rejectedBatch.json().error).toBe("REDIS_BATCH_NOT_READ_ONLY");

    let cursor = "0";
    const seen = new Map<string, unknown>();
    do {
      const scan = await app.inject({
        method: "POST", url: `/api/v1/redis-connections/${id}/scan`, cookies,
        payload: { database: 2, cursor, pattern: "*", count: 100 },
      });
      expect(scan.statusCode).toBe(200);
      cursor = scan.json().cursor;
      for (const item of scan.json().items) seen.set(item.key.base64, item);
    } while (cursor !== "0");
    expect(seen.get(Buffer.from("user:1").toString("base64"))).toMatchObject({ type: "string", ttlMs: -1 });
    expect(seen.get(binaryKey.toString("base64"))).toMatchObject({ key: { utf8: null, byteLength: 3 }, type: "string" });

    const unbounded = await execute("LRANGE", ["list", "0", "5000"]);
    expect(unbounded.statusCode).toBe(400);
    expect(unbounded.json().error).toBe("REDIS_COMMAND_UNBOUNDED");
    const dangerous = await execute("EVAL", ["return 1", "0"]);
    expect(dangerous.statusCode).toBe(403);

    const listed = await app.inject({ method: "GET", url: "/api/v1/connections?type=redis", cookies });
    const connection = listed.json().items[0];
    const updated = await app.inject({
      method: "PUT", url: `/api/v1/redis-connections/${id}`, cookies,
      payload: {
        name: connection.name,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        defaultDatabase: connection.defaultDatabase,
        connectionMode: connection.connectionMode,
        options: { ...connection.options, readOnly: true },
      },
    });
    expect(updated.statusCode).toBe(200);
    const readOnlyWrite = await execute("SET", ["blocked", "value"]);
    expect(readOnlyWrite.statusCode).toBe(403);
    expect(readOnlyWrite.json().error).toBe("REDIS_CONNECTION_READ_ONLY");
    expect((await execute("GET", ["user:1"])).statusCode).toBe(200);
    const auditActions = (await db.prepare("SELECT action FROM audit_events WHERE resource_id = ?").all(id) as Array<{ action: string }>).map((item) => item.action);
    expect(auditActions).toEqual(expect.arrayContaining(["redis.connection_tested", "redis.info_read", "redis.keys_scanned", "redis.command_executed", "redis.command_rejected"]));
    await app.close();
  }, 30_000);
});
