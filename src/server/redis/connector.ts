import net from "node:net";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Redis, type RedisOptions } from "ioredis";
import type { WorkspaceType } from "../access-control.js";
import { connectSsh, loadSshConnection, type ConnectedSsh } from "../ssh/connector.js";
import { IdleResourcePool } from "../../shared/idle-resource-pool.js";

export interface RedisConnectionRecord {
  id: string;
  workspaceType: WorkspaceType;
  workspaceId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  defaultDatabase: number;
  connectionMode: "tcp" | "sshTunnel";
  options: {
    connectTimeoutMs?: number;
    keySeparator?: string;
    readOnly?: boolean;
    sshConnectionId?: string | null;
    tls?: {
      enabled?: boolean;
      rejectUnauthorized?: boolean;
      ca?: string;
      certificate?: string;
      privateKey?: string;
      passphrase?: string;
      serverName?: string;
    };
  };
}

export interface ConnectedRedis {
  client: Redis;
  record: RedisConnectionRecord;
  close(): Promise<void>;
}

interface SshForward {
  host: string;
  port: number;
  close(): Promise<void>;
}

function decodeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function loadRedisConnection(app: FastifyInstance, connectionId: string): Promise<RedisConnectionRecord> {
  const row = await app.db.prepare(`
    SELECT id, workspace_type, workspace_id, name, host, port, username, credential_ciphertext,
      default_database, connection_mode, options_json
    FROM redis_connections WHERE id = ?
  `).get(connectionId) as
    | {
        id: string;
        workspace_type: WorkspaceType;
        workspace_id: string;
        name: string;
        host: string;
        port: number;
        username: string;
        credential_ciphertext: string;
        default_database: number;
        connection_mode: "tcp" | "sshTunnel";
        options_json: string;
      }
    | undefined;
  if (!row) throw new Error("Redis 连接不存在");
  const credential = decodeJson<{
    password?: string;
    tlsCa?: string;
    tlsCertificate?: string;
    tlsPrivateKey?: string;
    tlsPassphrase?: string;
  }>(app.secrets.decrypt(row.credential_ciphertext), {});
  const options = decodeJson<RedisConnectionRecord["options"]>(row.options_json, {});
  if (options.tls) {
    options.tls.ca = credential.tlsCa ?? "";
    options.tls.certificate = credential.tlsCertificate ?? "";
    options.tls.privateKey = credential.tlsPrivateKey ?? "";
    options.tls.passphrase = credential.tlsPassphrase ?? "";
  }
  return {
    id: row.id,
    workspaceType: row.workspace_type,
    workspaceId: row.workspace_id,
    name: row.name,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    password: credential.password ?? "",
    defaultDatabase: Number(row.default_database),
    connectionMode: row.connection_mode,
    options,
  };
}

async function createSshForward(app: FastifyInstance, record: RedisConnectionRecord): Promise<SshForward> {
  const connectionId = record.options.sshConnectionId;
  if (!connectionId) throw new Error("Redis 连接没有配置 SSH Tunnel 连接");
  const tunnel = await loadSshConnection(app, connectionId);
  if (tunnel.workspaceType !== record.workspaceType || tunnel.workspaceId !== record.workspaceId) {
    throw new Error("SSH Tunnel 连接不属于同一工作空间");
  }
  const ssh: ConnectedSsh = await connectSsh(app, connectionId);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    ssh.client.forwardOut("127.0.0.1", 0, record.host, record.port, (error, stream) => {
      if (error) {
        socket.destroy(error);
        return;
      }
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
    throw new Error("无法建立 Redis SSH Tunnel 本地端口");
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

function redisOptions(record: RedisConnectionRecord, host: string, port: number, database: number): RedisOptions {
  const tls = record.options.tls;
  return {
    host,
    port,
    username: record.username || undefined,
    password: record.password || undefined,
    db: database,
    connectTimeout: record.options.connectTimeoutMs ?? 10_000,
    commandTimeout: record.options.connectTimeoutMs ?? 10_000,
    connectionName: `viron:${record.id}`,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    stringNumbers: true,
    tls: tls?.enabled ? {
      rejectUnauthorized: tls.rejectUnauthorized !== false,
      servername: tls.serverName || record.host,
      ca: tls.ca || undefined,
      cert: tls.certificate || undefined,
      key: tls.privateKey || undefined,
      passphrase: tls.passphrase || undefined,
    } : undefined,
  };
}

async function createRedisConnection(app: FastifyInstance, record: RedisConnectionRecord, database?: number): Promise<ConnectedRedis> {
  let forward: SshForward | undefined;
  let client: Redis | undefined;
  try {
    if (record.connectionMode === "sshTunnel") forward = await createSshForward(app, record);
    client = new Redis(redisOptions(record, forward?.host ?? record.host, forward?.port ?? record.port, database ?? record.defaultDatabase));
    await client.connect();
    return {
      client,
      record,
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

interface PooledRedis {
  connected: ConnectedRedis;
}

const redisPools = new WeakMap<object, IdleResourcePool<PooledRedis>>();

function redisPool(app: FastifyInstance): IdleResourcePool<PooledRedis> {
  const existing = redisPools.get(app.server);
  if (existing) return existing;
  const pool = new IdleResourcePool<PooledRedis>({
    maxIdlePerKey: 2,
    usable: (resource) => resource.connected.client.status === "ready",
    dispose: (resource) => resource.connected.close(),
  });
  redisPools.set(app.server, pool);
  app.server.once("close", () => { void pool.close(); });
  return pool;
}

function redisFingerprint(record: RedisConnectionRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export async function connectRedis(app: FastifyInstance, connectionId: string, database?: number): Promise<ConnectedRedis> {
  const record = await loadRedisConnection(app, connectionId);
  const selectedDatabase = database ?? record.defaultDatabase;
  const key = `${record.id}\0${selectedDatabase}\0${redisFingerprint(record)}`;
  const lease = await redisPool(app).acquire(key, async () => ({ connected: await createRedisConnection(app, record, database) }));
  return {
    client: lease.resource.connected.client,
    record: lease.resource.connected.record,
    close: async () => { await lease.release(lease.resource.connected.client.status !== "ready"); },
  };
}

export async function closeRedisConnectionPool(app: FastifyInstance, connectionId?: string): Promise<void> {
  const pool = redisPools.get(app.server);
  if (!pool) return;
  await pool.invalidate(connectionId ? (key) => key.startsWith(`${connectionId}\0`) : undefined);
}
