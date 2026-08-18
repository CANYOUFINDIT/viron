import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { canAccessConnection, canManageWorkspace, getWorkspaceAccess, type AuthenticatedUser, workspaceParams, workspaceWhere } from "../access-control.js";
import {
  connectionEnvironmentMap,
  environmentsExist,
  normalizeEnvironmentIds,
  replaceConnectionEnvironments,
} from "../connection-environments.js";
import { inspectConnection, type InspectableConnectionType } from "../connection-inspection.js";
import { connectionGroupExists, ensureConnectionGroup, resolveConnectionGroupId, type ConnectionType } from "../connection-groups.js";
import { refreshPendingExistingConnections } from "../connection-existing.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { revokeWorkspaceRuntime } from "../user-runtime.js";
import { normalizeDatabaseStorage } from "../database-credentials.js";
import { closeSshConnectionPool } from "../ssh/connector.js";
import { closeDatabaseConnectionPool } from "../database-workbench/connector.js";
import { closeRedisConnectionPool } from "../redis/connector.js";

const sshCredentialSchema = z.object({
  password: z.string().max(4096).default(""),
  privateKey: z.string().max(128 * 1024).default(""),
  passphrase: z.string().max(4096).default(""),
});

const defaultSshOptions = {
  terminalType: "xterm-256color",
  keepAliveSeconds: 30,
  encoding: "utf-8",
  hostKeySha256: "",
  loginScriptEnabled: false,
  loginScript: "",
};

const sshConnectionSchema = z.object({
  environmentId: z.string().uuid().nullable().optional(),
  environmentIds: z.array(z.string().uuid()).max(100).optional(),
  connectionGroupId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(160),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(255),
  authType: z.enum(["password", "privateKey", "keyboardInteractive"]).default("password"),
  sshKeyId: z.string().uuid().nullable().optional(),
  credential: sshCredentialSchema.optional(),
  jumpConnectionId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  options: z.object({
    terminalType: z.string().trim().min(1).max(80).default("xterm-256color"),
    keepAliveSeconds: z.number().int().min(0).max(600).default(30),
    encoding: z.string().trim().min(1).max(40).default("utf-8"),
    hostKeySha256: z.string().trim().max(160).default(""),
    loginScriptEnabled: z.boolean().default(false),
    loginScript: z.string().max(64 * 1024).default(""),
  }).optional(),
});

const sshConnectionCreateSchema = sshConnectionSchema.extend({
  copyFromId: z.string().uuid().optional(),
});

const databaseCredentialSchema = z.object({
  password: z.string().max(4096).optional(),
  httpTunnelUsername: z.string().max(4096).optional(),
  httpTunnelPassword: z.string().max(4096).optional(),
  tlsCa: z.string().max(128 * 1024).optional(),
  tlsCertificate: z.string().max(128 * 1024).optional(),
  tlsPrivateKey: z.string().max(128 * 1024).optional(),
  tlsPassphrase: z.string().max(4096).optional(),
});

const databaseConnectionSchema = z.object({
  environmentId: z.string().uuid().nullable().optional(),
  environmentIds: z.array(z.string().uuid()).max(100).optional(),
  connectionGroupId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(160),
  engine: z.enum(["mysql", "mariadb"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(255),
  credential: databaseCredentialSchema.optional(),
  defaultDatabase: z.string().trim().max(255).default(""),
  connectionMode: z.enum(["tcp", "sshTunnel", "httpTunnel"]).default("tcp"),
  options: z.object({
    charset: z.string().trim().max(80).default("utf8mb4"),
    timezone: z.string().trim().max(80).default("local"),
    connectTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
    sshConnectionId: z.string().uuid().nullable().optional(),
    ssl: z.object({
      enabled: z.boolean().default(false),
      rejectUnauthorized: z.boolean().default(true),
      ca: z.string().max(128 * 1024).default(""),
      certificate: z.string().max(128 * 1024).default(""),
      privateKey: z.string().max(128 * 1024).default(""),
      passphrase: z.string().max(4096).default(""),
    }).default({
      enabled: false,
      rejectUnauthorized: true,
      ca: "",
      certificate: "",
      privateKey: "",
      passphrase: "",
    }),
    httpTunnelUrl: z.union([z.literal(""), z.string().url()]).default(""),
    httpTunnelRejectUnauthorized: z.boolean().default(true),
    activeProfileId: z.string().uuid().nullable().optional(),
  }).default({
    charset: "utf8mb4",
    timezone: "local",
    connectTimeoutMs: 10000,
    ssl: {
      enabled: false,
      rejectUnauthorized: true,
      ca: "",
      certificate: "",
      privateKey: "",
      passphrase: "",
    },
    httpTunnelUrl: "",
    httpTunnelRejectUnauthorized: true,
  }),
});

const databaseConnectionPreferenceSchema = z.object({
  starred: z.boolean().optional(),
  color: z.union([z.literal(""), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).optional(),
}).refine((value) => value.starred !== undefined || value.color !== undefined, "请至少修改一个连接偏好");

const databaseConnectionCreateSchema = databaseConnectionSchema.extend({
  copyFromId: z.string().uuid().optional(),
});

const databaseConnectionProfileSchema = databaseConnectionSchema.extend({
  profileName: z.string().trim().min(1).max(160),
});

const databaseConnectionProfileDuplicateSchema = z.object({
  profileName: z.string().trim().min(1).max(160),
});

const databaseConnectionActiveProfileSchema = z.object({
  profileId: z.string().uuid().nullable(),
});

const assignmentSchema = z.object({
  items: z.array(z.object({
    type: z.enum(["ssh", "database", "redis"]),
    id: z.string().uuid(),
  })).min(1).max(500),
  environmentId: z.string().uuid().nullable().optional(),
  environmentIds: z.array(z.string().uuid()).max(100).optional(),
});

const bulkDeleteSchema = z.object({
  items: z.array(z.object({
    type: z.enum(["ssh", "database", "redis"]),
    id: z.string().uuid(),
  })).min(1).max(500),
});

const inspectionSchema = z.object({
  items: z.array(z.object({
    type: z.enum(["ssh", "database", "redis"]),
    id: z.string().uuid(),
  })).min(1).max(500),
});

const connectionGroupSchema = z.object({
  type: z.enum(["ssh", "database", "redis"]),
  parentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(80).refine((value) => !/[\\/]/.test(value), "连接组名称不能包含斜杠"),
});

interface StoredCredential {
  [key: string]: string | undefined;
}

function encryptCredential(app: FastifyInstance, credential: StoredCredential): string {
  return app.secrets.encrypt(JSON.stringify(credential));
}

function credentialFlags(app: FastifyInstance, value: unknown): Record<string, boolean> {
  try {
    const parsed = JSON.parse(app.secrets.decrypt(String(value))) as StoredCredential;
    return {
      hasPassword: Boolean(parsed.password),
      hasPrivateKey: Boolean(parsed.privateKey),
      hasPassphrase: Boolean(parsed.passphrase),
      hasHttpTunnelAuth: Boolean(parsed.httpTunnelUsername || parsed.httpTunnelPassword),
      hasTlsCa: Boolean(parsed.tlsCa),
      hasTlsCertificate: Boolean(parsed.tlsCertificate),
      hasTlsPrivateKey: Boolean(parsed.tlsPrivateKey),
      hasTlsPassphrase: Boolean(parsed.tlsPassphrase),
    };
  } catch {
    return { hasPassword: false, hasPrivateKey: false, hasPassphrase: false, hasHttpTunnelAuth: false };
  }
}

function mergeCredential(app: FastifyInstance, encrypted: string, updates: StoredCredential): string {
  const current = JSON.parse(app.secrets.decrypt(encrypted)) as StoredCredential;
  for (const [key, value] of Object.entries(updates)) {
    if (value) current[key] = value;
  }
  return encryptCredential(app, current);
}

function parseOptions(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(value ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseTags(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function assertJumpConnection(app: FastifyInstance, jumpConnectionId: string | null | undefined, workspace: ReturnType<typeof workspaceParams>, ownId?: string): Promise<string | null> {
  if (!jumpConnectionId) return null;
  if (jumpConnectionId === ownId) return "SSH 连接不能把自己设为跳板机";
  const jump = await app.db.prepare(`SELECT jump_connection_id FROM ssh_connections WHERE id = ? AND ${workspaceWhere()}`).get(jumpConnectionId, ...workspace) as
    | { jump_connection_id: string | null }
    | undefined;
  if (!jump) return "所选跳板机不存在";
  if (ownId && jump.jump_connection_id === ownId) return "跳板机配置不能形成循环";
  return null;
}

async function assertSshKey(app: FastifyInstance, sshKeyId: string | null | undefined, workspace: ReturnType<typeof workspaceParams>): Promise<string | null> {
  if (!sshKeyId) return null;
  const exists = await app.db.prepare(`SELECT 1 FROM ssh_keys WHERE id = ? AND ${workspaceWhere()}`).get(sshKeyId, ...workspace);
  return exists ? null : "所选 SSH 密钥不属于当前工作空间";
}

function storedCredential(app: FastifyInstance, ciphertext: string): StoredCredential {
  try {
    return JSON.parse(app.secrets.decrypt(ciphertext)) as StoredCredential;
  } catch {
    return {};
  }
}

function removeInlinePrivateKey(app: FastifyInstance, ciphertext: string): string {
  return encryptCredential(app, {});
}

async function assertDatabaseTunnelConnection(
  app: FastifyInstance,
  connectionMode: "tcp" | "sshTunnel" | "httpTunnel",
  sshConnectionId: string | null | undefined,
  workspace: ReturnType<typeof workspaceParams>,
): Promise<string | null> {
  if (connectionMode !== "sshTunnel") return null;
  if (!sshConnectionId) return "SSH Tunnel 模式必须选择 SSH 连接";
  const exists = await app.db.prepare(`SELECT 1 FROM ssh_connections WHERE id = ? AND ${workspaceWhere()}`).get(sshConnectionId, ...workspace);
  return exists ? null : "所选 SSH Tunnel 连接不属于当前工作空间";
}

function requireWorkspaceManager(request: Parameters<typeof canManageWorkspace>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "当前工作空间只有管理员可以修改连接资源" });
  return false;
}

async function databaseConnectionProfileIds(app: FastifyInstance, rootId: string): Promise<string[]> {
  const rows = await app.db.prepare("SELECT id FROM database_connections WHERE id = ? OR profile_parent_id = ?").all(rootId, rootId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function databaseConnectionIsOpen(app: FastifyInstance, rootId: string, user: AuthenticatedUser): Promise<boolean> {
  const ids = new Set(await databaseConnectionProfileIds(app, rootId));
  return app.activeConnections.list({ ...user, isPlatformAdmin: false })
    .some((item) => item.ownerId === user.id && item.type === "database" && ids.has(item.resourceId));
}

function addConnectionAccessFilter(sql: string[], values: unknown[], column: string, ids: Set<string>): void {
  if (!ids.size) sql.push("1 = 0");
  else {
    sql.push(`${column} IN (${[...ids].map(() => "?").join(",")})`);
    values.push(...ids);
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function registerConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get<{ Querystring: { type?: ConnectionType } }>("/api/v1/connection-groups", async (request) => {
    const workspace = workspaceParams(request);
    let rows = request.query.type
      ? await app.db.prepare(`SELECT * FROM connection_groups WHERE type = ? AND ${workspaceWhere()} ORDER BY path`).all(request.query.type, ...workspace)
      : await app.db.prepare(`SELECT * FROM connection_groups WHERE ${workspaceWhere()} ORDER BY type, path`).all(...workspace);
    const access = await getWorkspaceAccess(app.db, request.admin!);
    if (!access.canManage) {
      const visible = new Set<string>();
      const collect = async (table: "ssh_connections" | "database_connections" | "redis_connections", ids: Set<string>) => {
        if (!ids.size) return;
        const result = await app.db.prepare(`SELECT connection_group_id FROM ${table} WHERE id IN (${[...ids].map(() => "?").join(",")}) AND connection_group_id IS NOT NULL`).all(...ids) as Array<{ connection_group_id: string }>;
        for (const item of result) visible.add(item.connection_group_id);
      };
      await Promise.all([
        collect("ssh_connections", access.sshConnectionIds),
        collect("database_connections", access.databaseConnectionIds),
        collect("redis_connections", access.redisConnectionIds),
      ]);
      const byId = new Map((rows as Record<string, unknown>[]).map((row) => [String(row.id), row]));
      for (const id of [...visible]) {
        let parentId = byId.get(id)?.parent_id;
        while (parentId) {
          visible.add(String(parentId));
          parentId = byId.get(String(parentId))?.parent_id;
        }
      }
      rows = (rows as Record<string, unknown>[]).filter((row) => visible.has(String(row.id)));
    }
    return {
      items: (rows as Record<string, unknown>[]).map((row) => ({
        id: row.id,
        type: row.type,
        parentId: row.parent_id,
        name: row.name,
        path: row.path,
      })),
    };
  });

  app.post("/api/v1/connection-groups", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(connectionGroupSchema, request.body, reply);
    if (!body) return;
    let parentPath: string[] = [];
    if (body.parentId) {
      const parent = await app.db.prepare(`SELECT type, path FROM connection_groups WHERE id = ? AND ${workspaceWhere()}`).get(body.parentId, ...workspaceParams(request)) as { type: ConnectionType; path: string } | undefined;
      if (!parent || parent.type !== body.type) return reply.code(400).send({ error: "INVALID_CONNECTION_GROUP", message: "上级连接组不存在或类型不匹配" });
      parentPath = parent.path.split("/");
    }
    const path = [...parentPath, body.name].join("/");
    if (await app.db.prepare(`SELECT id FROM connection_groups WHERE type = ? AND path = ? AND ${workspaceWhere()}`).get(body.type, path, ...workspaceParams(request))) {
      return reply.code(409).send({ error: "DUPLICATE_CONNECTION_GROUP", message: "同级连接组名称已存在" });
    }
    const id = await ensureConnectionGroup(app, body.type, [...parentPath, body.name], workspaceParams(request))!;
    await writeAudit(app.db, { action: "connection_group.created", resourceType: "connection_group", resourceId: id, summary: `创建连接组 ${path}`, details: { type: body.type }, request });
    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/connection-groups/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const group = await app.db.prepare(`SELECT type, path FROM connection_groups WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { type: ConnectionType; path: string } | undefined;
    if (!group) return reply.code(404).send({ error: "NOT_FOUND", message: "连接组不存在" });
    await app.db.prepare("DELETE FROM connection_groups WHERE id = ?").run(request.params.id);
    await writeAudit(app.db, { action: "connection_group.deleted", resourceType: "connection_group", resourceId: request.params.id, summary: `删除连接组 ${group.path}`, details: { type: group.type }, request });
    return reply.code(204).send();
  });

  app.get<{
    Querystring: { type?: string; assignment?: string; environmentId?: string; sourceId?: string; q?: string; includeProfiles?: string };
  }>("/api/v1/connections", async (request) => {
    const type = request.query.type ?? "all";
    const access = await getWorkspaceAccess(app.db, request.admin!);
    if (request.query.environmentId && !access.canManage && !access.environmentIds.has(request.query.environmentId)) {
      return { items: [] };
    }
    const filters = (tableAlias: string, connectionType: "ssh" | "database" | "redis") => {
      const sql: string[] = [workspaceWhere(tableAlias)];
      const values: unknown[] = [...workspaceParams(request)];
      const connectionIds = connectionType === "ssh" ? access.sshConnectionIds : connectionType === "database" ? access.databaseConnectionIds : access.redisConnectionIds;
      if (connectionType === "database" && request.query.includeProfiles !== "true") sql.push(`${tableAlias}.profile_parent_id IS NULL`);
      if (!access.canManage) addConnectionAccessFilter(sql, values, `${tableAlias}.id`, connectionIds);
      const environmentTable = connectionType === "ssh" ? "ssh_connection_environments" : connectionType === "database" ? "database_connection_environments" : "redis_connection_environments";
      if (request.query.assignment === "assigned") sql.push(`EXISTS (SELECT 1 FROM ${environmentTable} ce WHERE ce.connection_id = ${tableAlias}.id)`);
      if (request.query.assignment === "unassigned") sql.push(`NOT EXISTS (SELECT 1 FROM ${environmentTable} ce WHERE ce.connection_id = ${tableAlias}.id)`);
      if (request.query.environmentId) {
        sql.push(`EXISTS (SELECT 1 FROM ${environmentTable} ce WHERE ce.connection_id = ${tableAlias}.id AND ce.environment_id = ?)`);
        values.push(request.query.environmentId);
      }
      if (request.query.sourceId) {
        sql.push(`${tableAlias}.source_id = ?`);
        values.push(request.query.sourceId);
      }
      if (request.query.q?.trim()) {
        sql.push(`(${tableAlias}.name LIKE ? OR ${tableAlias}.host LIKE ? OR ${tableAlias}.username LIKE ? OR ${tableAlias}.source_path LIKE ?${connectionType === "ssh" ? ` OR ${tableAlias}.tags_json LIKE ?` : ""})`);
        const query = `%${request.query.q.trim()}%`;
        values.push(query, query, query, query);
        if (connectionType === "ssh") values.push(query);
      }
      return { where: `WHERE ${sql.join(" AND ")}`, values, connectionType };
    };

    const items: Record<string, unknown>[] = [];
    if (type === "all" || type === "ssh") {
      const query = filters("c", "ssh");
      const environmentsByConnection = await connectionEnvironmentMap(app.db, "ssh", workspaceParams(request));
      const rows = await app.db.prepare(`
        SELECT c.*, s.name AS source_name,
          g.name AS connection_group_name, g.path AS connection_group_path,
          j.name AS jump_connection_name, k.name AS ssh_key_name,
          i.status AS inspection_status, i.latency_ms AS inspection_latency_ms,
          i.message AS inspection_message, i.checked_at AS inspection_checked_at
        FROM ssh_connections c
        LEFT JOIN connection_sources s ON s.id = c.source_id
        LEFT JOIN connection_groups g ON g.id = c.connection_group_id
        LEFT JOIN ssh_connections j ON j.id = c.jump_connection_id
        LEFT JOIN ssh_keys k ON k.id = c.ssh_key_id
        LEFT JOIN connection_inspection_results i ON i.connection_type = 'ssh' AND i.connection_id = c.id
        ${query.where}
      `).all(...query.values) as Record<string, unknown>[];
      for (const row of rows) {
        const flags = credentialFlags(app, row.credential_ciphertext);
        const environments = (environmentsByConnection.get(String(row.id)) ?? [])
          .filter((environment) => access.canManage || access.environmentIds.has(environment.id));
        items.push({
          id: row.id,
          type: "ssh",
          environmentIds: environments.map((environment) => environment.id),
          environments,
          environmentId: environments[0]?.id ?? null,
          environmentName: environments[0]?.name ?? null,
          connectionGroupId: row.connection_group_id,
          connectionGroupName: row.connection_group_name,
          connectionGroupPath: row.connection_group_path,
          sourceId: row.source_id,
          sourceName: row.source_name ?? "手工创建",
          sourcePath: row.source_path,
          sourceDeleted: Boolean(row.source_deleted),
          name: row.name,
          host: row.host,
          port: Number(row.port),
          username: row.username,
          authType: row.auth_type,
          sshKeyId: access.canManage ? row.ssh_key_id : null,
          sshKeyName: access.canManage ? row.ssh_key_name : null,
          jumpConnectionId: row.jump_connection_id,
          jumpConnectionName: row.jump_connection_name,
          tags: parseTags(row.tags_json),
          options: parseOptions(row.options_json),
          ...flags,
          hasPrivateKey: Boolean(row.ssh_key_id) || flags.hasPrivateKey,
          lastInspectionStatus: row.inspection_status ?? null,
          lastInspectionLatencyMs: row.inspection_latency_ms == null ? null : Number(row.inspection_latency_ms),
          lastInspectionMessage: row.inspection_message ?? null,
          lastInspectedAt: row.inspection_checked_at ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
    }

    if (type === "all" || type === "database") {
      const query = filters("c", "database");
      const environmentsByConnection = await connectionEnvironmentMap(app.db, "database", workspaceParams(request));
      const rows = await app.db.prepare(`
        SELECT c.*, s.name AS source_name,
          g.name AS connection_group_name, g.path AS connection_group_path,
          i.status AS inspection_status, i.latency_ms AS inspection_latency_ms,
          i.message AS inspection_message, i.checked_at AS inspection_checked_at,
          pref.starred AS preference_starred, pref.color AS preference_color
        FROM database_connections c
        LEFT JOIN database_connection_preferences pref ON pref.connection_id = c.id AND pref.owner_user_id = ?
        LEFT JOIN connection_sources s ON s.id = c.source_id
        LEFT JOIN connection_groups g ON g.id = c.connection_group_id
        LEFT JOIN connection_inspection_results i ON i.connection_type = 'database' AND i.connection_id = c.id
        ${query.where}
      `).all(request.admin!.id, ...query.values) as Record<string, unknown>[];
      for (const row of rows) {
        const databaseOptions = normalizeDatabaseStorage(parseOptions(row.options_json)).options;
        const environments = (environmentsByConnection.get(String(row.id)) ?? [])
          .filter((environment) => access.canManage || access.environmentIds.has(environment.id));
        items.push({
          id: row.id,
          type: "database",
          profileParentId: row.profile_parent_id ?? null,
          profileName: row.profile_name ?? "",
          environmentIds: environments.map((environment) => environment.id),
          environments,
          environmentId: environments[0]?.id ?? null,
          environmentName: environments[0]?.name ?? null,
          connectionGroupId: row.connection_group_id,
          connectionGroupName: row.connection_group_name,
          connectionGroupPath: row.connection_group_path,
          sourceId: row.source_id,
          sourceName: row.source_name ?? "手工创建",
          sourcePath: row.source_path,
          sourceDeleted: Boolean(row.source_deleted),
          name: row.name,
          engine: row.engine,
          host: row.host,
          port: Number(row.port),
          username: row.username,
          defaultDatabase: row.default_database,
          connectionMode: row.connection_mode,
          options: access.canManage ? databaseOptions : { activeProfileId: databaseOptions.activeProfileId ?? null },
          canManage: access.canManage,
          starred: Boolean(row.preference_starred),
          color: row.preference_color ?? "",
          ...credentialFlags(app, row.credential_ciphertext),
          lastInspectionStatus: row.inspection_status ?? null,
          lastInspectionLatencyMs: row.inspection_latency_ms == null ? null : Number(row.inspection_latency_ms),
          lastInspectionMessage: row.inspection_message ?? null,
          lastInspectedAt: row.inspection_checked_at ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
    }

    if (type === "all" || type === "redis") {
      const query = filters("c", "redis");
      const environmentsByConnection = await connectionEnvironmentMap(app.db, "redis", workspaceParams(request));
      const rows = await app.db.prepare(`
        SELECT c.*, s.name AS source_name,
          g.name AS connection_group_name, g.path AS connection_group_path,
          i.status AS inspection_status, i.latency_ms AS inspection_latency_ms,
          i.message AS inspection_message, i.checked_at AS inspection_checked_at
        FROM redis_connections c
        LEFT JOIN connection_sources s ON s.id = c.source_id
        LEFT JOIN connection_groups g ON g.id = c.connection_group_id
        LEFT JOIN connection_inspection_results i ON i.connection_type = 'redis' AND i.connection_id = c.id
        ${query.where}
      `).all(...query.values) as Record<string, unknown>[];
      for (const row of rows) {
        const environments = (environmentsByConnection.get(String(row.id)) ?? [])
          .filter((environment) => access.canManage || access.environmentIds.has(environment.id));
        items.push({
          id: row.id,
          type: "redis",
          environmentIds: environments.map((environment) => environment.id),
          environments,
          environmentId: environments[0]?.id ?? null,
          environmentName: environments[0]?.name ?? null,
          connectionGroupId: row.connection_group_id,
          connectionGroupName: row.connection_group_name,
          connectionGroupPath: row.connection_group_path,
          sourceId: row.source_id,
          sourceName: row.source_name ?? "手工创建",
          sourcePath: row.source_path,
          sourceDeleted: Boolean(row.source_deleted),
          name: row.name,
          host: row.host,
          port: Number(row.port),
          username: row.username,
          defaultDatabase: Number(row.default_database),
          connectionMode: row.connection_mode,
          options: access.canManage ? parseOptions(row.options_json) : {},
          ...credentialFlags(app, row.credential_ciphertext),
          lastInspectionStatus: row.inspection_status ?? null,
          lastInspectionLatencyMs: row.inspection_latency_ms == null ? null : Number(row.inspection_latency_ms),
          lastInspectionMessage: row.inspection_message ?? null,
          lastInspectedAt: row.inspection_checked_at ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
    }

    items.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return { items };
  });

  app.post("/api/v1/connections/inspect", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(inspectionSchema, request.body, reply);
    if (!body || !request.admin) return;
    const saveResult = app.db.prepare(`
      INSERT INTO connection_inspection_results (
        connection_type, connection_id, status, latency_ms, message, checked_by_user_id, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_type, connection_id) DO UPDATE SET
        status = excluded.status,
        latency_ms = excluded.latency_ms,
        message = excluded.message,
        checked_by_user_id = excluded.checked_by_user_id,
        checked_at = excluded.checked_at
    `);
    const items = await mapWithConcurrency(body.items, 5, async (item) => {
      const table = item.type === "ssh" ? "ssh_connections" : item.type === "database" ? "database_connections" : "redis_connections";
      const row = await app.db.prepare(`SELECT name, host, port FROM ${table} WHERE id = ? AND ${workspaceWhere()}`).get(item.id, ...workspaceParams(request)) as
        | { name: string; host: string; port: number }
        | undefined;
      const started = Date.now();
      let status: "available" | "unavailable" = "unavailable";
      let message = "连接不存在";
      let latencyMs = 0;
      if (row) {
        try {
          const result = await inspectConnection(app, item.type as InspectableConnectionType, item.id);
          status = "available";
          message = result.message;
          latencyMs = result.latencyMs;
        } catch (error) {
          latencyMs = Date.now() - started;
          message = error instanceof Error ? error.message : String(error);
        }
        const checkedAt = new Date().toISOString();
        await saveResult.run(item.type, item.id, status, latencyMs, message, request.admin!.id, checkedAt);
        return { ...item, name: row.name, host: row.host, port: Number(row.port), status, latencyMs, message, checkedAt };
      }
      return { ...item, name: "已删除连接", host: "", port: 0, status, latencyMs, message, checkedAt: new Date().toISOString() };
    });
    const available = items.filter((item) => item.status === "available").length;
    const unavailable = items.length - available;
    await writeAudit(app.db, {
      action: "connection.inspected",
      resourceType: "connection",
      summary: `巡检 ${items.length} 个连接：可用 ${available}，不可用 ${unavailable}`,
      details: { items: items.map((item) => ({ type: item.type, id: item.id, status: item.status, latencyMs: item.latencyMs })) },
      request,
    });
    return { summary: { total: items.length, available, unavailable }, items };
  });

  app.post("/api/v1/ssh-connections", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(sshConnectionCreateSchema, request.body, reply);
    if (!body) return;
    const copySource = body.copyFromId
      ? await app.db.prepare(`SELECT workspace_type, workspace_id, ssh_key_id, credential_ciphertext, tags_json FROM ssh_connections WHERE id = ? AND ((${workspaceWhere()}) OR (? = 'organization' AND workspace_type = 'personal' AND workspace_id = ?))`)
        .get(body.copyFromId, ...workspaceParams(request), request.admin!.workspace.type, request.admin!.id) as { workspace_type: string; workspace_id: string; ssh_key_id: string | null; credential_ciphertext: string; tags_json: string } | undefined
      : undefined;
    if (body.copyFromId && !copySource) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "要复制的 SSH 连接不存在" });
    }
    const environmentIds = normalizeEnvironmentIds(body.environmentIds, body.environmentId);
    if (!await environmentsExist(app.db, environmentIds, workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "所选环境中存在无效项" });
    }
    if (!await connectionGroupExists(app, body.connectionGroupId, "ssh", workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_CONNECTION_GROUP", message: "所选 SSH 连接组不存在" });
    }
    const jumpError = await assertJumpConnection(app, body.jumpConnectionId, workspaceParams(request));
    if (jumpError) return reply.code(400).send({ error: "INVALID_JUMP_HOST", message: jumpError });
    const workspace = workspaceParams(request);
    const sourceKeyId = copySource?.workspace_type === workspace[0] && copySource.workspace_id === workspace[1] ? copySource.ssh_key_id : null;
    const sshKeyId = body.authType === "privateKey" ? (body.sshKeyId === undefined ? sourceKeyId : body.sshKeyId) : null;
    const keyError = await assertSshKey(app, sshKeyId, workspace);
    if (keyError) return reply.code(400).send({ error: "INVALID_SSH_KEY", message: keyError });
    let encryptedCredential = copySource
      ? mergeCredential(app, copySource.credential_ciphertext, body.credential ?? {})
      : encryptCredential(app, body.credential ?? {});
    if (sshKeyId) encryptedCredential = removeInlinePrivateKey(app, encryptedCredential);
    if (body.authType === "privateKey" && !sshKeyId && !storedCredential(app, encryptedCredential).privateKey) {
      return reply.code(400).send({ error: "SSH_KEY_REQUIRED", message: "私钥认证必须选择 SSH 密钥" });
    }
    const connectionGroupId = await resolveConnectionGroupId(app, "ssh", environmentIds[0], body.connectionGroupId, workspaceParams(request));
    const id = randomUUID();
    const now = new Date().toISOString();
    const tags = [...new Set(body.tags ?? (copySource ? parseTags(copySource.tags_json) : []))];
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT INTO ssh_connections (
          id, workspace_type, workspace_id, environment_id, connection_group_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
          jump_connection_id, options_json, tags_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, ...workspaceParams(request), environmentIds[0] ?? null, connectionGroupId, body.name, body.host, body.port, body.username,
        body.authType, sshKeyId, encryptedCredential, body.jumpConnectionId ?? null,
        JSON.stringify(body.options ?? defaultSshOptions), JSON.stringify(tags), now, now,
      );
      await replaceConnectionEnvironments(app.db, "ssh", id, environmentIds);
    })();
    await writeAudit(app.db, {
      action: body.copyFromId ? "connection.ssh_copied" : "connection.ssh_created",
      resourceType: "ssh_connection",
      resourceId: id,
      summary: `${body.copyFromId ? "复制" : "创建"} SSH 连接 ${body.name}`,
      details: { host: body.host, port: body.port, environmentIds, tags, sshKeyId, copyFromId: body.copyFromId ?? null },
      request,
    });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/v1/ssh-connections/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(sshConnectionSchema, request.body, reply);
    if (!body) return;
    const existing = await app.db.prepare(`SELECT name, auth_type, ssh_key_id, credential_ciphertext, connection_group_id, options_json, tags_json FROM ssh_connections WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as
      | { name: string; auth_type: string; ssh_key_id: string | null; credential_ciphertext: string; connection_group_id: string | null; options_json: string; tags_json: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    const environmentIds = normalizeEnvironmentIds(body.environmentIds, body.environmentId);
    if (!await environmentsExist(app.db, environmentIds, workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "所选环境中存在无效项" });
    }
    if (!await connectionGroupExists(app, body.connectionGroupId, "ssh", workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_CONNECTION_GROUP", message: "所选 SSH 连接组不存在" });
    }
    const jumpError = await assertJumpConnection(app, body.jumpConnectionId, workspaceParams(request), request.params.id);
    if (jumpError) return reply.code(400).send({ error: "INVALID_JUMP_HOST", message: jumpError });
    const sshKeyId = body.authType === "privateKey" ? (body.sshKeyId === undefined ? existing.ssh_key_id : body.sshKeyId) : null;
    const keyError = await assertSshKey(app, sshKeyId, workspaceParams(request));
    if (keyError) return reply.code(400).send({ error: "INVALID_SSH_KEY", message: keyError });
    let encryptedCredential = body.credential ? mergeCredential(app, existing.credential_ciphertext, body.credential) : existing.credential_ciphertext;
    if (sshKeyId) encryptedCredential = removeInlinePrivateKey(app, encryptedCredential);
    if (body.authType === "privateKey" && !sshKeyId && !storedCredential(app, encryptedCredential).privateKey) {
      return reply.code(400).send({ error: "SSH_KEY_REQUIRED", message: "私钥认证必须选择 SSH 密钥" });
    }
    const connectionGroupId = await resolveConnectionGroupId(app, "ssh", environmentIds[0], body.connectionGroupId, workspaceParams(request), existing.connection_group_id);
    const tags = [...new Set(body.tags ?? parseTags(existing.tags_json))];
    await app.db.transaction(async () => {
      await app.db.prepare(`
        UPDATE ssh_connections SET environment_id = ?, connection_group_id = ?, name = ?, host = ?, port = ?, username = ?,
          auth_type = ?, ssh_key_id = ?, credential_ciphertext = ?, jump_connection_id = ?, options_json = ?, tags_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        environmentIds[0] ?? null, connectionGroupId, body.name, body.host, body.port, body.username, body.authType,
        sshKeyId, encryptedCredential,
        body.jumpConnectionId ?? null, JSON.stringify(body.options ?? parseOptions(existing.options_json)), JSON.stringify(tags), new Date().toISOString(), request.params.id,
      );
      await replaceConnectionEnvironments(app.db, "ssh", request.params.id, environmentIds);
    })();
    await Promise.all([closeSshConnectionPool(app, request.params.id), closeDatabaseConnectionPool(app), closeRedisConnectionPool(app)]);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "connection.ssh_updated",
      resourceType: "ssh_connection",
      resourceId: request.params.id,
      summary: `更新 SSH 连接 ${body.name}`,
      details: { host: body.host, port: body.port, environmentIds, tags, sshKeyId },
      request,
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/ssh-connections/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const row = await app.db.prepare(`SELECT name FROM ssh_connections WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { name: string } | undefined;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    await app.db.prepare("DELETE FROM ssh_connections WHERE id = ?").run(request.params.id);
    await app.db.prepare("DELETE FROM connection_inspection_results WHERE connection_type = 'ssh' AND connection_id = ?").run(request.params.id);
    await app.db.prepare("DELETE FROM resource_grants WHERE resource_type = 'ssh_connection' AND resource_id = ?").run(request.params.id);
    await Promise.all([closeSshConnectionPool(app, request.params.id), closeDatabaseConnectionPool(app), closeRedisConnectionPool(app)]);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await refreshPendingExistingConnections(app.db);
    await writeAudit(app.db, {
      action: "connection.ssh_deleted",
      resourceType: "ssh_connection",
      resourceId: request.params.id,
      summary: `删除 SSH 连接 ${row.name}`,
      request,
    });
    return reply.code(204).send();
  });

  app.post("/api/v1/database-connections", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(databaseConnectionCreateSchema, request.body, reply);
    if (!body) return;
    const copySource = body.copyFromId
      ? await app.db.prepare(`SELECT credential_ciphertext FROM database_connections WHERE id = ? AND ((${workspaceWhere()}) OR (? = 'organization' AND workspace_type = 'personal' AND workspace_id = ?))`)
        .get(body.copyFromId, ...workspaceParams(request), request.admin!.workspace.type, request.admin!.id) as { credential_ciphertext: string } | undefined
      : undefined;
    if (body.copyFromId && !copySource) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "要复制的数据库连接不存在" });
    }
    const environmentIds = normalizeEnvironmentIds(body.environmentIds, body.environmentId);
    if (!await environmentsExist(app.db, environmentIds, workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "所选环境中存在无效项" });
    }
    if (!await connectionGroupExists(app, body.connectionGroupId, "database", workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_CONNECTION_GROUP", message: "所选数据库连接组不存在" });
    }
    const tunnelError = await assertDatabaseTunnelConnection(app, body.connectionMode, body.options.sshConnectionId, workspaceParams(request));
    if (tunnelError) return reply.code(400).send({ error: "INVALID_SSH_TUNNEL", message: tunnelError });
    if (body.connectionMode === "httpTunnel" && !body.options.httpTunnelUrl) {
      return reply.code(400).send({ error: "HTTP_TUNNEL_REQUIRED", message: "HTTP Tunnel 模式必须填写 Tunnel URL" });
    }
    const connectionGroupId = await resolveConnectionGroupId(app, "database", environmentIds[0], body.connectionGroupId, workspaceParams(request));
    const storage = normalizeDatabaseStorage(body.options, body.credential as StoredCredential | undefined);
    const id = randomUUID();
    const now = new Date().toISOString();
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT INTO database_connections (
          id, workspace_type, workspace_id, environment_id, connection_group_id, name, engine, host, port, username, credential_ciphertext,
          default_database, connection_mode, options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, ...workspaceParams(request), environmentIds[0] ?? null, connectionGroupId, body.name, body.engine, body.host, body.port, body.username,
        copySource ? mergeCredential(app, copySource.credential_ciphertext, storage.credential) : encryptCredential(app, storage.credential), body.defaultDatabase, body.connectionMode,
        JSON.stringify(storage.options), now, now,
      );
      await replaceConnectionEnvironments(app.db, "database", id, environmentIds);
    })();
    await writeAudit(app.db, {
      action: body.copyFromId ? "connection.database_copied" : "connection.database_created",
      resourceType: "database_connection",
      resourceId: id,
      summary: `${body.copyFromId ? "复制" : "创建"}数据库连接 ${body.name}`,
      details: { engine: body.engine, host: body.host, port: body.port, environmentIds, copyFromId: body.copyFromId ?? null },
      request,
    });
    return reply.code(201).send({ id });
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/profiles", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(databaseConnectionProfileSchema, request.body, reply);
    if (!body) return;
    const parent = await app.db.prepare(`
      SELECT id, name, credential_ciphertext, environment_id, connection_group_id
      FROM database_connections WHERE id = ? AND profile_parent_id IS NULL AND ${workspaceWhere()}
    `).get(request.params.id, ...workspaceParams(request)) as {
      id: string;
      name: string;
      credential_ciphertext: string;
      environment_id: string | null;
      connection_group_id: string | null;
    } | undefined;
    if (!parent) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    if (await databaseConnectionIsOpen(app, parent.id, request.admin!)) {
      return reply.code(409).send({ error: "CONNECTION_PROFILE_REQUIRES_CLOSED", message: "要创建新的连接配置文件，必须关闭连接" });
    }
    if (await app.db.prepare("SELECT id FROM database_connections WHERE profile_parent_id = ? AND profile_name = ?").get(parent.id, body.profileName)) {
      return reply.code(409).send({ error: "PROFILE_NAME_CONFLICT", message: `连接配置文件“${body.profileName}”已存在` });
    }
    const tunnelError = await assertDatabaseTunnelConnection(app, body.connectionMode, body.options.sshConnectionId, workspaceParams(request));
    if (tunnelError) return reply.code(400).send({ error: "INVALID_SSH_TUNNEL", message: tunnelError });
    if (body.connectionMode === "httpTunnel" && !body.options.httpTunnelUrl) {
      return reply.code(400).send({ error: "HTTP_TUNNEL_REQUIRED", message: "HTTP Tunnel 模式必须填写 Tunnel URL" });
    }
    const storage = normalizeDatabaseStorage(body.options, body.credential as StoredCredential | undefined);
    const id = randomUUID();
    const now = new Date().toISOString();
    const environments = await app.db.prepare("SELECT environment_id FROM database_connection_environments WHERE connection_id = ?").all(parent.id) as Array<{ environment_id: string }>;
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT INTO database_connections (
          id, profile_parent_id, profile_name, workspace_type, workspace_id, environment_id, connection_group_id,
          name, engine, host, port, username, credential_ciphertext, default_database, connection_mode, options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, parent.id, body.profileName, ...workspaceParams(request), parent.environment_id, parent.connection_group_id,
        parent.name, body.engine, body.host, body.port, body.username,
        Object.keys(storage.credential).length ? mergeCredential(app, parent.credential_ciphertext, storage.credential) : parent.credential_ciphertext,
        body.defaultDatabase, body.connectionMode, JSON.stringify(storage.options), now, now,
      );
      for (const environment of environments) {
        await app.db.prepare("INSERT INTO database_connection_environments (connection_id, environment_id) VALUES (?, ?)").run(id, environment.environment_id);
      }
    })();
    await closeDatabaseConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "connection.database_profile_created",
      resourceType: "database_connection",
      resourceId: parent.id,
      summary: `创建连接配置文件 ${parent.name}/${body.profileName}`,
      details: { profileId: id, host: body.host, port: body.port },
      request,
    });
    return reply.code(201).send({ id, profileName: body.profileName });
  });

  app.put<{ Params: { id: string; profileId: string } }>("/api/v1/database-connections/:id/profiles/:profileId", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(databaseConnectionProfileSchema, request.body, reply);
    if (!body) return;
    const profile = await app.db.prepare(`
      SELECT p.id, p.credential_ciphertext FROM database_connections p
      JOIN database_connections root ON root.id = p.profile_parent_id
      WHERE root.id = ? AND p.id = ? AND ${workspaceWhere("root")}
    `).get(request.params.id, request.params.profileId, ...workspaceParams(request)) as { id: string; credential_ciphertext: string } | undefined;
    if (!profile) return reply.code(404).send({ error: "NOT_FOUND", message: "连接配置文件不存在" });
    if (await databaseConnectionIsOpen(app, request.params.id, request.admin!)) {
      return reply.code(409).send({ error: "CONNECTION_PROFILE_REQUIRES_CLOSED", message: "要修改连接配置文件，必须关闭连接" });
    }
    if (await app.db.prepare("SELECT id FROM database_connections WHERE profile_parent_id = ? AND profile_name = ? AND id <> ?")
      .get(request.params.id, body.profileName, request.params.profileId)) {
      return reply.code(409).send({ error: "PROFILE_NAME_CONFLICT", message: `连接配置文件“${body.profileName}”已存在` });
    }
    const tunnelError = await assertDatabaseTunnelConnection(app, body.connectionMode, body.options.sshConnectionId, workspaceParams(request));
    if (tunnelError) return reply.code(400).send({ error: "INVALID_SSH_TUNNEL", message: tunnelError });
    if (body.connectionMode === "httpTunnel" && !body.options.httpTunnelUrl) {
      return reply.code(400).send({ error: "HTTP_TUNNEL_REQUIRED", message: "HTTP Tunnel 模式必须填写 Tunnel URL" });
    }
    const storage = normalizeDatabaseStorage(body.options, body.credential as StoredCredential | undefined);
    await app.db.prepare(`
      UPDATE database_connections SET profile_name = ?, engine = ?, host = ?, port = ?, username = ?,
        credential_ciphertext = ?, default_database = ?, connection_mode = ?, options_json = ?, updated_at = ?
      WHERE id = ? AND profile_parent_id = ?
    `).run(
      body.profileName,
      body.engine,
      body.host,
      body.port,
      body.username,
      Object.keys(storage.credential).length ? mergeCredential(app, profile.credential_ciphertext, storage.credential) : profile.credential_ciphertext,
      body.defaultDatabase,
      body.connectionMode,
      JSON.stringify(storage.options),
      new Date().toISOString(),
      request.params.profileId,
      request.params.id,
    );
    await closeDatabaseConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "connection.database_profile_updated",
      resourceType: "database_connection",
      resourceId: request.params.id,
      summary: `更新连接配置文件 ${body.profileName}`,
      details: { profileId: request.params.profileId, host: body.host, port: body.port },
      request,
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string; profileId: string } }>("/api/v1/database-connections/:id/profiles/:profileId/duplicate", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(databaseConnectionProfileDuplicateSchema, request.body, reply);
    if (!body) return;
    const profile = await app.db.prepare(`
      SELECT p.*, root.environment_id AS root_environment_id, root.connection_group_id AS root_connection_group_id
      FROM database_connections p
      JOIN database_connections root ON root.id = p.profile_parent_id
      WHERE root.id = ? AND p.id = ? AND ${workspaceWhere("root")}
    `).get(request.params.id, request.params.profileId, ...workspaceParams(request)) as Record<string, unknown> | undefined;
    if (!profile) return reply.code(404).send({ error: "NOT_FOUND", message: "连接配置文件不存在" });
    if (await databaseConnectionIsOpen(app, request.params.id, request.admin!)) {
      return reply.code(409).send({ error: "CONNECTION_PROFILE_REQUIRES_CLOSED", message: "要复制连接配置文件，必须关闭连接" });
    }
    if (await app.db.prepare("SELECT id FROM database_connections WHERE profile_parent_id = ? AND profile_name = ?").get(request.params.id, body.profileName)) {
      return reply.code(409).send({ error: "PROFILE_NAME_CONFLICT", message: `连接配置文件“${body.profileName}”已存在` });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const environments = await app.db.prepare("SELECT environment_id FROM database_connection_environments WHERE connection_id = ?").all(request.params.profileId) as Array<{ environment_id: string }>;
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT INTO database_connections (
          id, profile_parent_id, profile_name, workspace_type, workspace_id, environment_id, connection_group_id,
          name, engine, host, port, username, credential_ciphertext, default_database, connection_mode, options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        request.params.id,
        body.profileName,
        profile.workspace_type,
        profile.workspace_id,
        profile.root_environment_id ?? null,
        profile.root_connection_group_id ?? null,
        profile.name,
        profile.engine,
        profile.host,
        profile.port,
        profile.username,
        profile.credential_ciphertext,
        profile.default_database,
        profile.connection_mode,
        profile.options_json,
        now,
        now,
      );
      for (const environment of environments) {
        await app.db.prepare("INSERT INTO database_connection_environments (connection_id, environment_id) VALUES (?, ?)").run(id, environment.environment_id);
      }
    })();
    await closeDatabaseConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "connection.database_profile_duplicated",
      resourceType: "database_connection",
      resourceId: request.params.id,
      summary: `复制连接配置文件 ${body.profileName}`,
      details: { profileId: id, sourceProfileId: request.params.profileId },
      request,
    });
    return reply.code(201).send({ id, profileName: body.profileName });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-connections/:id/profiles/active", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(databaseConnectionActiveProfileSchema, request.body, reply);
    if (!body) return;
    const root = await app.db.prepare(`SELECT options_json FROM database_connections WHERE id = ? AND profile_parent_id IS NULL AND ${workspaceWhere()}`)
      .get(request.params.id, ...workspaceParams(request)) as { options_json: string } | undefined;
    if (!root) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    if (body.profileId && !await app.db.prepare("SELECT id FROM database_connections WHERE id = ? AND profile_parent_id = ?").get(body.profileId, request.params.id)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "连接配置文件不存在" });
    }
    if (await databaseConnectionIsOpen(app, request.params.id, request.admin!)) {
      return reply.code(409).send({ error: "CONNECTION_PROFILE_REQUIRES_CLOSED", message: "要切换连接配置文件，必须关闭连接" });
    }
    const options = parseOptions(root.options_json);
    options.activeProfileId = body.profileId;
    await app.db.prepare("UPDATE database_connections SET options_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(options), new Date().toISOString(), request.params.id);
    await closeDatabaseConnectionPool(app, request.params.id);
    await writeAudit(app.db, {
      action: "connection.database_profile_activated",
      resourceType: "database_connection",
      resourceId: request.params.id,
      summary: body.profileId ? "设置活动连接配置文件" : "设置主要配置文件为活动配置",
      details: { profileId: body.profileId },
      request,
    });
    return { activeProfileId: body.profileId };
  });

  app.delete<{ Params: { id: string; profileId: string } }>("/api/v1/database-connections/:id/profiles/:profileId", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const profile = await app.db.prepare(`
      SELECT p.profile_name, root.options_json FROM database_connections p
      JOIN database_connections root ON root.id = p.profile_parent_id
      WHERE root.id = ? AND p.id = ? AND ${workspaceWhere("root")}
    `).get(request.params.id, request.params.profileId, ...workspaceParams(request)) as { profile_name: string; options_json: string } | undefined;
    if (!profile) return reply.code(404).send({ error: "NOT_FOUND", message: "连接配置文件不存在" });
    if (await databaseConnectionIsOpen(app, request.params.id, request.admin!)) {
      return reply.code(409).send({ error: "CONNECTION_PROFILE_REQUIRES_CLOSED", message: "要删除连接配置文件，必须关闭连接" });
    }
    await app.db.prepare("DELETE FROM database_connections WHERE id = ? AND profile_parent_id = ?").run(request.params.profileId, request.params.id);
    const options = parseOptions(profile.options_json);
    if (options.activeProfileId === request.params.profileId) {
      options.activeProfileId = null;
      await app.db.prepare("UPDATE database_connections SET options_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(options), new Date().toISOString(), request.params.id);
    }
    await closeDatabaseConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, { action: "connection.database_profile_deleted", resourceType: "database_connection", resourceId: request.params.id, summary: `删除连接配置文件 ${profile.profile_name}`, request });
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-connections/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(databaseConnectionSchema, request.body, reply);
    if (!body) return;
    const existing = await app.db.prepare(`SELECT name, credential_ciphertext, connection_group_id FROM database_connections WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as
      | { name: string; credential_ciphertext: string; connection_group_id: string | null }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const environmentIds = normalizeEnvironmentIds(body.environmentIds, body.environmentId);
    if (!await environmentsExist(app.db, environmentIds, workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "所选环境中存在无效项" });
    }
    if (!await connectionGroupExists(app, body.connectionGroupId, "database", workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_CONNECTION_GROUP", message: "所选数据库连接组不存在" });
    }
    const tunnelError = await assertDatabaseTunnelConnection(app, body.connectionMode, body.options.sshConnectionId, workspaceParams(request));
    if (tunnelError) return reply.code(400).send({ error: "INVALID_SSH_TUNNEL", message: tunnelError });
    if (body.connectionMode === "httpTunnel" && !body.options.httpTunnelUrl) {
      return reply.code(400).send({ error: "HTTP_TUNNEL_REQUIRED", message: "HTTP Tunnel 模式必须填写 Tunnel URL" });
    }
    const connectionGroupId = await resolveConnectionGroupId(app, "database", environmentIds[0], body.connectionGroupId, workspaceParams(request), existing.connection_group_id);
    const storage = normalizeDatabaseStorage(body.options, body.credential as StoredCredential | undefined);
    await app.db.transaction(async () => {
      await app.db.prepare(`
        UPDATE database_connections SET environment_id = ?, connection_group_id = ?, name = ?, engine = ?, host = ?, port = ?,
          username = ?, credential_ciphertext = ?, default_database = ?, connection_mode = ?,
          options_json = ?, updated_at = ? WHERE id = ?
      `).run(
        environmentIds[0] ?? null, connectionGroupId, body.name, body.engine, body.host, body.port, body.username,
        Object.keys(storage.credential).length ? mergeCredential(app, existing.credential_ciphertext, storage.credential) : existing.credential_ciphertext,
        body.defaultDatabase, body.connectionMode, JSON.stringify(storage.options), new Date().toISOString(), request.params.id,
      );
      await replaceConnectionEnvironments(app.db, "database", request.params.id, environmentIds);
    })();
    await closeDatabaseConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "connection.database_updated",
      resourceType: "database_connection",
      resourceId: request.params.id,
      summary: `更新数据库连接 ${body.name}`,
      details: { engine: body.engine, host: body.host, port: body.port, environmentIds },
      request,
    });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-connections/:id/preferences", async (request, reply) => {
    const body = parseBody(databaseConnectionPreferenceSchema, request.body, reply);
    if (!body) return;
    if (!await canAccessConnection(app.db, request.admin!, "database", request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const current = await app.db.prepare("SELECT starred, color FROM database_connection_preferences WHERE owner_user_id = ? AND connection_id = ?")
      .get(request.admin!.id, request.params.id) as { starred: number; color: string } | undefined;
    const starred = body.starred ?? Boolean(current?.starred);
    const color = body.color ?? current?.color ?? "";
    const now = new Date().toISOString();
    if (current) await app.db.prepare("UPDATE database_connection_preferences SET starred = ?, color = ?, updated_at = ? WHERE owner_user_id = ? AND connection_id = ?")
      .run(starred ? 1 : 0, color, now, request.admin!.id, request.params.id);
    else await app.db.prepare("INSERT INTO database_connection_preferences (owner_user_id, connection_id, starred, color, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(request.admin!.id, request.params.id, starred ? 1 : 0, color, now);
    return { starred, color };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-connections/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const row = await app.db.prepare(`SELECT name FROM database_connections WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { name: string } | undefined;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    await app.db.prepare("DELETE FROM database_connections WHERE profile_parent_id = ?").run(request.params.id);
    await app.db.prepare("DELETE FROM database_connections WHERE id = ?").run(request.params.id);
    await app.db.prepare("DELETE FROM connection_inspection_results WHERE connection_type = 'database' AND connection_id = ?").run(request.params.id);
    await app.db.prepare("DELETE FROM resource_grants WHERE resource_type = 'database_connection' AND resource_id = ?").run(request.params.id);
    await closeDatabaseConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await refreshPendingExistingConnections(app.db);
    await writeAudit(app.db, {
      action: "connection.database_deleted",
      resourceType: "database_connection",
      resourceId: request.params.id,
      summary: `删除数据库连接 ${row.name}`,
      request,
    });
    return reply.code(204).send();
  });

  app.post("/api/v1/connections/assign", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(assignmentSchema, request.body, reply);
    if (!body) return;
    const environmentIds = normalizeEnvironmentIds(body.environmentIds, body.environmentId);
    if (!await environmentsExist(app.db, environmentIds, workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "所选环境中存在无效项" });
    }
    const sshConnectionGroupId = await resolveConnectionGroupId(app, "ssh", environmentIds[0], null, workspaceParams(request));
    const databaseConnectionGroupId = await resolveConnectionGroupId(app, "database", environmentIds[0], null, workspaceParams(request));
    const redisConnectionGroupId = await resolveConnectionGroupId(app, "redis", environmentIds[0], null, workspaceParams(request));
    const updateSsh = app.db.prepare(`UPDATE ssh_connections SET connection_group_id = COALESCE(connection_group_id, ?), updated_at = ? WHERE id = ? AND ${workspaceWhere()}`);
    const updateDatabase = app.db.prepare(`UPDATE database_connections SET connection_group_id = COALESCE(connection_group_id, ?), updated_at = ? WHERE id = ? AND ${workspaceWhere()}`);
    const updateRedis = app.db.prepare(`UPDATE redis_connections SET connection_group_id = COALESCE(connection_group_id, ?), updated_at = ? WHERE id = ? AND ${workspaceWhere()}`);
    const now = new Date().toISOString();
    let updated = 0;
    const assign = app.db.transaction(async () => {
      for (const item of body.items) {
        const result = item.type === "ssh"
          ? await updateSsh.run(sshConnectionGroupId, now, item.id, ...workspaceParams(request))
          : item.type === "database"
            ? await updateDatabase.run(databaseConnectionGroupId, now, item.id, ...workspaceParams(request))
            : await updateRedis.run(redisConnectionGroupId, now, item.id, ...workspaceParams(request));
        if (result.changes && await replaceConnectionEnvironments(app.db, item.type, item.id, environmentIds)) updated += 1;
      }
    });
    await assign();
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: environmentIds.length ? "connection.assigned" : "connection.unassigned",
      resourceType: "connection",
      summary: environmentIds.length ? `关联 ${updated} 个连接到环境` : `取消 ${updated} 个连接的环境关联`,
      details: { items: body.items, environmentIds, updated },
      request,
    });
    return { updated };
  });

  app.post("/api/v1/connections/bulk-delete", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(bulkDeleteSchema, request.body, reply);
    if (!body) return;
    const deleteSsh = app.db.prepare(`DELETE FROM ssh_connections WHERE id = ? AND ${workspaceWhere()}`);
    const deleteDatabase = app.db.prepare(`DELETE FROM database_connections WHERE id = ? AND ${workspaceWhere()}`);
    const deleteRedis = app.db.prepare(`DELETE FROM redis_connections WHERE id = ? AND ${workspaceWhere()}`);
    let deleted = 0;
    const remove = app.db.transaction(async () => {
      for (const item of body.items) {
        const result = item.type === "ssh"
          ? await deleteSsh.run(item.id, ...workspaceParams(request))
          : item.type === "database"
            ? await deleteDatabase.run(item.id, ...workspaceParams(request))
            : await deleteRedis.run(item.id, ...workspaceParams(request));
        await app.db.prepare("DELETE FROM connection_inspection_results WHERE connection_type = ? AND connection_id = ?").run(item.type, item.id);
        deleted += result.changes;
      }
    });
    await remove();
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await refreshPendingExistingConnections(app.db);
    await writeAudit(app.db, {
      action: "connection.bulk_deleted",
      resourceType: "connection",
      summary: `批量删除 ${deleted} 个连接`,
      details: { items: body.items, deleted },
      request,
    });
    return { deleted };
  });
}
