import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canManageWorkspace, getWorkspaceAccess, workspaceParams, workspaceWhere } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { connectionEnvironmentMap, environmentsExist, normalizeEnvironmentIds, replaceConnectionEnvironments } from "../connection-environments.js";
import { connectionGroupExists, resolveConnectionGroupId } from "../connection-groups.js";
import { revokeWorkspaceRuntime } from "../user-runtime.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { closeRedisConnectionPool } from "../redis/connector.js";

const redisCredentialSchema = z.object({
  password: z.string().max(4096).optional(),
  tlsCa: z.string().max(128 * 1024).optional(),
  tlsCertificate: z.string().max(128 * 1024).optional(),
  tlsPrivateKey: z.string().max(128 * 1024).optional(),
  tlsPassphrase: z.string().max(4096).optional(),
});

const tlsDefaults = {
  enabled: false,
  rejectUnauthorized: true,
  serverName: "",
};

const redisConnectionSchema = z.object({
  environmentId: z.string().uuid().nullable().optional(),
  environmentIds: z.array(z.string().uuid()).max(100).optional(),
  connectionGroupId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(160),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(6379),
  username: z.string().trim().max(255).default(""),
  credential: redisCredentialSchema.optional(),
  defaultDatabase: z.number().int().min(0).max(1023).default(0),
  connectionMode: z.enum(["tcp", "sshTunnel"]).default("tcp"),
  options: z.object({
    connectTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
    keySeparator: z.string().max(16).default(":"),
    readOnly: z.boolean().default(false),
    sshConnectionId: z.string().uuid().nullable().optional(),
    tls: z.object({
      enabled: z.boolean().default(false),
      rejectUnauthorized: z.boolean().default(true),
      serverName: z.string().trim().max(255).default(""),
    }).default(tlsDefaults),
  }).default({ connectTimeoutMs: 10000, keySeparator: ":", readOnly: false, tls: tlsDefaults }),
});

const redisConnectionCreateSchema = redisConnectionSchema.extend({
  copyFromId: z.string().uuid().optional(),
});

type StoredCredential = z.infer<typeof redisCredentialSchema>;

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function encryptCredential(app: FastifyInstance, credential: StoredCredential): string {
  return app.secrets.encrypt(JSON.stringify(credential));
}

function mergeCredential(app: FastifyInstance, encrypted: string, updates: StoredCredential): string {
  const current = parseJson<StoredCredential>(app.secrets.decrypt(encrypted), {});
  const merged = { ...current };
  for (const key of ["password", "tlsCa", "tlsCertificate", "tlsPrivateKey", "tlsPassphrase"] as const) {
    if (updates[key] !== undefined) merged[key] = updates[key];
  }
  return encryptCredential(app, merged);
}

function credentialFlags(app: FastifyInstance, encrypted: unknown) {
  if (!encrypted) return { hasPassword: false, hasTlsCa: false, hasTlsCertificate: false, hasTlsPrivateKey: false, hasTlsPassphrase: false };
  const credential = parseJson<StoredCredential>(app.secrets.decrypt(String(encrypted)), {});
  return {
    hasPassword: Boolean(credential.password),
    hasTlsCa: Boolean(credential.tlsCa),
    hasTlsCertificate: Boolean(credential.tlsCertificate),
    hasTlsPrivateKey: Boolean(credential.tlsPrivateKey),
    hasTlsPassphrase: Boolean(credential.tlsPassphrase),
  };
}

async function tunnelError(app: FastifyInstance, mode: "tcp" | "sshTunnel", sshConnectionId: string | null | undefined, workspace: ReturnType<typeof workspaceParams>): Promise<string | null> {
  if (mode !== "sshTunnel") return null;
  if (!sshConnectionId) return "SSH Tunnel 模式必须选择 SSH 连接";
  const row = await app.db.prepare(`SELECT id FROM ssh_connections WHERE id = ? AND ${workspaceWhere()}`).get(sshConnectionId, ...workspace);
  return row ? null : "SSH Tunnel 连接不存在或不属于当前工作空间";
}

function requireWorkspaceManager(request: Parameters<typeof canManageWorkspace>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  reply.code(403).send({ error: "WORKSPACE_MANAGER_REQUIRED", message: "只有当前工作空间管理员可以修改 Redis 连接" });
  return false;
}

export async function registerRedisConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get<{ Querystring: { assignment?: string; environmentId?: string; q?: string } }>("/api/v1/redis-connections", async (request) => {
    const access = await getWorkspaceAccess(app.db, request.admin!);
    if (request.query.environmentId && !access.canManage && !access.environmentIds.has(request.query.environmentId)) return { items: [] };
    const filters = [workspaceWhere("c")];
    const values: unknown[] = [...workspaceParams(request)];
    if (!access.canManage) {
      if (!access.redisConnectionIds.size) return { items: [] };
      filters.push(`c.id IN (${[...access.redisConnectionIds].map(() => "?").join(",")})`);
      values.push(...access.redisConnectionIds);
    }
    if (request.query.assignment === "assigned") filters.push("EXISTS (SELECT 1 FROM redis_connection_environments ce WHERE ce.connection_id = c.id)");
    if (request.query.assignment === "unassigned") filters.push("NOT EXISTS (SELECT 1 FROM redis_connection_environments ce WHERE ce.connection_id = c.id)");
    if (request.query.environmentId) {
      filters.push("EXISTS (SELECT 1 FROM redis_connection_environments ce WHERE ce.connection_id = c.id AND ce.environment_id = ?)");
      values.push(request.query.environmentId);
    }
    if (request.query.q?.trim()) {
      filters.push("(c.name LIKE ? OR c.host LIKE ? OR c.username LIKE ?)");
      const query = `%${request.query.q.trim()}%`;
      values.push(query, query, query);
    }
    const environmentsByConnection = await connectionEnvironmentMap(app.db, "redis", workspaceParams(request));
    const rows = await app.db.prepare(`
      SELECT c.*, g.name AS connection_group_name, g.path AS connection_group_path,
        i.status AS inspection_status, i.latency_ms AS inspection_latency_ms,
        i.message AS inspection_message, i.checked_at AS inspection_checked_at
      FROM redis_connections c
      LEFT JOIN connection_groups g ON g.id = c.connection_group_id
      LEFT JOIN connection_inspection_results i ON i.connection_type = 'redis' AND i.connection_id = c.id
      WHERE ${filters.join(" AND ")}
      ORDER BY c.name, c.id
    `).all(...values) as Record<string, unknown>[];
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: "redis",
        name: row.name,
        host: row.host,
        port: Number(row.port),
        username: row.username,
        defaultDatabase: Number(row.default_database),
        connectionMode: row.connection_mode,
        connectionGroupId: row.connection_group_id,
        connectionGroupName: row.connection_group_name,
        connectionGroupPath: row.connection_group_path,
        environments: (environmentsByConnection.get(String(row.id)) ?? []).filter((environment) => access.canManage || access.environmentIds.has(environment.id)),
        credential: credentialFlags(app, row.credential_ciphertext),
        options: parseJson(row.options_json, {}),
        inspection: row.inspection_status ? {
          status: row.inspection_status,
          latencyMs: Number(row.inspection_latency_ms),
          message: row.inspection_message,
          checkedAt: row.inspection_checked_at,
        } : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  });

  app.post("/api/v1/redis-connections", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(redisConnectionCreateSchema, request.body, reply);
    if (!body) return;
    const copySource = body.copyFromId
      ? await app.db.prepare(`SELECT credential_ciphertext FROM redis_connections WHERE id = ? AND ((${workspaceWhere()}) OR (? = 'organization' AND workspace_type = 'personal' AND workspace_id = ?))`)
        .get(body.copyFromId, ...workspaceParams(request), request.admin!.workspace.type, request.admin!.id) as { credential_ciphertext: string } | undefined
      : undefined;
    if (body.copyFromId && !copySource) return reply.code(404).send({ error: "NOT_FOUND", message: "要复制的 Redis 连接不存在" });
    const environmentIds = normalizeEnvironmentIds(body.environmentIds, body.environmentId);
    if (!await environmentsExist(app.db, environmentIds, workspaceParams(request))) return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "所选环境中存在无效项" });
    if (!await connectionGroupExists(app, body.connectionGroupId, "redis", workspaceParams(request))) return reply.code(400).send({ error: "INVALID_CONNECTION_GROUP", message: "所选 Redis 连接组不存在" });
    const invalidTunnel = await tunnelError(app, body.connectionMode, body.options.sshConnectionId, workspaceParams(request));
    if (invalidTunnel) return reply.code(400).send({ error: "INVALID_SSH_TUNNEL", message: invalidTunnel });
    const connectionGroupId = await resolveConnectionGroupId(app, "redis", environmentIds[0], body.connectionGroupId, workspaceParams(request));
    const id = randomUUID();
    const now = new Date().toISOString();
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT INTO redis_connections (
          id, workspace_type, workspace_id, environment_id, connection_group_id, name, host, port, username,
          credential_ciphertext, default_database, connection_mode, options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, ...workspaceParams(request), environmentIds[0] ?? null, connectionGroupId, body.name, body.host, body.port, body.username,
        copySource ? mergeCredential(app, copySource.credential_ciphertext, body.credential ?? {}) : encryptCredential(app, body.credential ?? {}),
        body.defaultDatabase, body.connectionMode, JSON.stringify(body.options), now, now,
      );
      await replaceConnectionEnvironments(app.db, "redis", id, environmentIds);
    })();
    await writeAudit(app.db, {
      action: body.copyFromId ? "connection.redis_copied" : "connection.redis_created",
      resourceType: "redis_connection",
      resourceId: id,
      summary: `${body.copyFromId ? "复制" : "创建"} Redis 连接 ${body.name}`,
      details: { host: body.host, port: body.port, defaultDatabase: body.defaultDatabase, environmentIds, copyFromId: body.copyFromId ?? null },
      request,
    });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/v1/redis-connections/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(redisConnectionSchema, request.body, reply);
    if (!body) return;
    const existing = await app.db.prepare(`SELECT credential_ciphertext, connection_group_id FROM redis_connections WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { credential_ciphertext: string; connection_group_id: string | null } | undefined;
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "Redis 连接不存在" });
    const environmentIds = normalizeEnvironmentIds(body.environmentIds, body.environmentId);
    if (!await environmentsExist(app.db, environmentIds, workspaceParams(request))) return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "所选环境中存在无效项" });
    if (!await connectionGroupExists(app, body.connectionGroupId, "redis", workspaceParams(request))) return reply.code(400).send({ error: "INVALID_CONNECTION_GROUP", message: "所选 Redis 连接组不存在" });
    const invalidTunnel = await tunnelError(app, body.connectionMode, body.options.sshConnectionId, workspaceParams(request));
    if (invalidTunnel) return reply.code(400).send({ error: "INVALID_SSH_TUNNEL", message: invalidTunnel });
    const connectionGroupId = await resolveConnectionGroupId(app, "redis", environmentIds[0], body.connectionGroupId, workspaceParams(request), existing.connection_group_id);
    await app.db.transaction(async () => {
      await app.db.prepare(`
        UPDATE redis_connections SET environment_id = ?, connection_group_id = ?, name = ?, host = ?, port = ?, username = ?,
          credential_ciphertext = ?, default_database = ?, connection_mode = ?, options_json = ?, updated_at = ? WHERE id = ?
      `).run(
        environmentIds[0] ?? null, connectionGroupId, body.name, body.host, body.port, body.username,
        body.credential ? mergeCredential(app, existing.credential_ciphertext, body.credential) : existing.credential_ciphertext,
        body.defaultDatabase, body.connectionMode, JSON.stringify(body.options), new Date().toISOString(), request.params.id,
      );
      await replaceConnectionEnvironments(app.db, "redis", request.params.id, environmentIds);
    })();
    await closeRedisConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, { action: "connection.redis_updated", resourceType: "redis_connection", resourceId: request.params.id, summary: `更新 Redis 连接 ${body.name}`, details: { host: body.host, port: body.port, environmentIds }, request });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/redis-connections/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const row = await app.db.prepare(`SELECT name FROM redis_connections WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { name: string } | undefined;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "Redis 连接不存在" });
    await app.db.prepare("DELETE FROM redis_connections WHERE id = ?").run(request.params.id);
    await app.db.prepare("DELETE FROM connection_inspection_results WHERE connection_type = 'redis' AND connection_id = ?").run(request.params.id);
    await app.db.prepare("DELETE FROM resource_grants WHERE resource_type = 'redis_connection' AND resource_id = ?").run(request.params.id);
    await closeRedisConnectionPool(app, request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, { action: "connection.redis_deleted", resourceType: "redis_connection", resourceId: request.params.id, summary: `删除 Redis 连接 ${row.name}`, request });
    return reply.code(204).send();
  });
}
