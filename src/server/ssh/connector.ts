import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { Client } from "ssh2";
import type { WorkspaceType } from "../access-control.js";
import { connectSshClient } from "../../shared/ssh-client.js";
import { IdleResourcePool } from "../../shared/idle-resource-pool.js";
import { buildSshConnectConfig } from "../../shared/ssh-connect.js";
import { openSshProxySocket } from "../../shared/ssh-proxy.js";
import type { SshAuthType, SshConnectionCredential, SshConnectionOptions } from "../../shared/ssh-connect.js";
import { resolveSshCredential } from "./key-store.js";

export interface SshConnectionRecord {
  id: string;
  workspaceType: WorkspaceType;
  workspaceId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  sshKeyId: string | null;
  credential: SshConnectionCredential;
  jumpConnectionId: string | null;
  options: SshConnectionOptions;
}

export interface ConnectedSsh {
  client: Client;
  jumpClient?: Client;
  jumpClients?: Client[];
  connection: SshConnectionRecord;
  transportReused?: boolean;
  close(): void;
}

function decodeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function loadSshConnection(app: FastifyInstance, connectionId: string): Promise<SshConnectionRecord> {
  const row = await app.db.prepare(`
    SELECT id, workspace_type, workspace_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
      jump_connection_id, options_json
    FROM ssh_connections WHERE id = ?
  `).get(connectionId) as
    | {
        id: string;
        workspace_type: WorkspaceType;
        workspace_id: string;
        name: string;
        host: string;
        port: number;
        username: string;
        auth_type: SshConnectionRecord["authType"];
        ssh_key_id: string | null;
        credential_ciphertext: string;
        jump_connection_id: string | null;
        options_json: string;
      }
    | undefined;
  if (!row) throw new Error("SSH 连接不存在");
  const credential = await resolveSshCredential(app, row);
  return {
    id: row.id,
    workspaceType: row.workspace_type,
    workspaceId: row.workspace_id,
    name: row.name,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    authType: row.auth_type,
    sshKeyId: row.ssh_key_id,
    credential,
    jumpConnectionId: row.jump_connection_id,
    options: decodeJson(row.options_json, {}),
  };
}

async function connectClient(connection: SshConnectionRecord, sock?: Readable): Promise<Client> {
  const keyboardInteractivePassword = connection.authType === "keyboardInteractive"
    ? connection.credential.password
    : undefined;
  const transport = sock ?? await openSshProxySocket(connection);
  try {
    return await connectSshClient(new Client(), buildSshConnectConfig(connection, transport), keyboardInteractivePassword);
  } catch (error) {
    transport?.destroy();
    throw error;
  }
}

function forward(client: Client, host: string, port: number): Promise<Readable> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

interface PooledSsh {
  connected: ConnectedSsh;
  usable: boolean;
}

const sshPools = new WeakMap<object, IdleResourcePool<PooledSsh>>();

function connectionFingerprint(connection: SshConnectionRecord, jumps: SshConnectionRecord[]): string {
  return createHash("sha256").update(JSON.stringify({ connection, jumps })).digest("hex");
}

function sshPool(app: FastifyInstance): IdleResourcePool<PooledSsh> {
  const existing = sshPools.get(app.server);
  if (existing) return existing;
  const pool = new IdleResourcePool<PooledSsh>({
    maxIdlePerKey: 2,
    usable: (resource) => resource.usable,
    dispose: (resource) => resource.connected.close(),
  });
  sshPools.set(app.server, pool);
  app.server.once("close", () => { void pool.close(); });
  return pool;
}

async function loadJumpChain(app: FastifyInstance, connection: SshConnectionRecord): Promise<SshConnectionRecord[]> {
  const jumps: SshConnectionRecord[] = [];
  const visited = new Set([connection.id]);
  let jumpId = connection.jumpConnectionId;
  while (jumpId) {
    if (visited.has(jumpId)) throw new Error("跳板机配置不能形成循环");
    if (jumps.length >= 8) throw new Error("ProxyJump 最多支持 8 跳");
    const jump = await loadSshConnection(app, jumpId);
    if (jump.workspaceType !== connection.workspaceType || jump.workspaceId !== connection.workspaceId) {
      throw new Error("跳板机不属于同一工作空间");
    }
    visited.add(jump.id);
    jumps.push(jump);
    jumpId = jump.jumpConnectionId;
  }
  return jumps;
}

async function createConnectedSsh(connection: SshConnectionRecord, jumps: SshConnectionRecord[]): Promise<ConnectedSsh> {
  const chain = [connection, ...jumps];
  const clients = new Array<Client>(chain.length);
  try {
    const outermostIndex = chain.length - 1;
    clients[outermostIndex] = await connectClient(chain[outermostIndex]);
    for (let index = outermostIndex - 1; index >= 0; index -= 1) {
      const stream = await forward(clients[index + 1], chain[index].host, chain[index].port);
      clients[index] = await connectClient(chain[index], stream);
    }
    const jumpClients = clients.slice(1);
    return {
      client: clients[0],
      jumpClient: jumpClients[0],
      jumpClients,
      connection,
      close: () => clients.forEach((client) => client.end()),
    };
  } catch (error) {
    clients.filter(Boolean).forEach((client) => client.end());
    throw error;
  }
}

export async function connectSsh(app: FastifyInstance, connectionId: string): Promise<ConnectedSsh> {
  const connection = await loadSshConnection(app, connectionId);
  const jumps = await loadJumpChain(app, connection);
  const key = `${connection.id}\0${connectionFingerprint(connection, jumps)}`;
  const lease = await sshPool(app).acquire(key, async () => {
    const connected = await createConnectedSsh(connection, jumps);
    const resource: PooledSsh = { connected, usable: true };
    connected.client.once("close", () => { resource.usable = false; });
    connected.client.once("error", () => { resource.usable = false; });
    for (const jumpClient of connected.jumpClients ?? []) {
      jumpClient.once("close", () => { resource.usable = false; });
      jumpClient.once("error", () => { resource.usable = false; });
    }
    return resource;
  });
  return {
    ...lease.resource.connected,
    transportReused: lease.reused,
    close: () => { void lease.release(); },
  };
}

export async function closeSshConnectionPool(app: FastifyInstance, connectionId?: string): Promise<void> {
  const pool = sshPools.get(app.server);
  if (!pool) return;
  await pool.invalidate(connectionId ? (key) => key.startsWith(`${connectionId}\0`) : undefined);
}
