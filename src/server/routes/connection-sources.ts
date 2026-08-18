import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { canManageWorkspace, workspaceParams, workspaceWhere } from "../access-control.js";
import { addConnectionEnvironment } from "../connection-environments.js";
import { cronExpressionError } from "../connection-sources/scheduler.js";
import { syncSecureCrtSource, type SecureCrtSourceConfig } from "../connection-sources/sync.js";
import { syncScriptSource, type ScriptSourceConfig } from "../connection-sources/script-sync.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const sourceConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(255),
  authType: z.enum(["password", "privateKey"]).default("password"),
  password: z.string().max(4096).optional(),
  privateKey: z.string().max(128 * 1024).optional(),
  passphrase: z.string().max(4096).optional(),
  configPassphrase: z.string().max(4096).optional(),
  remotePaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(20),
  scheduleEnabled: z.boolean().default(false),
  scheduleExpression: z.string().trim().max(120).default(""),
});

const scriptSourceConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  script: z.string().trim().min(1).max(256 * 1024),
  conflictStrategy: z.enum(["overwrite", "ignore"]).default("ignore"),
  scheduleEnabled: z.boolean().default(false),
  scheduleExpression: z.string().trim().max(120).default(""),
});

const mappingSchema = z.object({
  sourcePathPrefix: z.string().trim().min(1).max(4096),
  environmentId: z.string().uuid(),
});

async function publicSources(app: FastifyInstance, workspace: ReturnType<typeof workspaceParams>) {
  const rows = await app.db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM ssh_connections c WHERE c.source_id = s.id) AS ssh_count,
      (SELECT COUNT(*) FROM database_connections c WHERE c.source_id = s.id) AS database_count,
      (SELECT COUNT(*) FROM redis_connections c WHERE c.source_id = s.id) AS redis_count,
      (SELECT COUNT(*) FROM source_folder_mappings m WHERE m.source_id = s.id) AS mapping_count
    FROM connection_sources s WHERE ${workspaceWhere("s")} ORDER BY s.updated_at DESC
  `).all(...workspace) as Record<string, unknown>[];
  return Promise.all(rows.map(async (row) => {
    let secureConfig: Partial<SecureCrtSourceConfig> = {};
    let scriptConfig: Partial<ScriptSourceConfig> = {};
    try {
      const config = JSON.parse(app.secrets.decrypt(String(row.config_ciphertext))) as SecureCrtSourceConfig | ScriptSourceConfig;
      if (row.type === "script_sync") scriptConfig = config as ScriptSourceConfig;
      else secureConfig = config as SecureCrtSourceConfig;
    } catch { /* Invalid configs remain visible for repair. */ }
    const pendingBatch = await app.db.prepare("SELECT id, summary_json FROM connection_import_batches WHERE source_id = ? AND status = 'preview' ORDER BY created_at DESC LIMIT 1").get(row.id) as { id: string; summary_json: string } | undefined;
    const pendingSummary = pendingBatch ? JSON.parse(pendingBatch.summary_json) as { conflict?: number } : null;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      host: secureConfig.host ?? "",
      port: secureConfig.port ?? 22,
      username: secureConfig.username ?? "",
      authType: secureConfig.authType ?? "password",
      remotePaths: secureConfig.remotePaths ?? [],
      hasPassword: Boolean(secureConfig.password),
      hasPrivateKey: Boolean(secureConfig.privateKey),
      hasConfigPassphrase: Boolean(secureConfig.configPassphrase),
      script: scriptConfig.script ?? "",
      conflictStrategy: scriptConfig.conflictStrategy ?? "ignore",
      scheduleEnabled: Boolean(row.schedule_enabled),
      scheduleExpression: row.schedule_expression,
      nextSyncAt: app.connectionSourceScheduler.nextRun(String(row.id))?.toISOString() ?? null,
      conflictBatchId: pendingBatch?.id ?? null,
      conflictCount: pendingSummary?.conflict ?? 0,
      lastSyncedAt: row.last_synced_at,
      sshCount: Number(row.ssh_count),
      databaseCount: Number(row.database_count),
      redisCount: Number(row.redis_count),
      mappingCount: Number(row.mapping_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }));
}

export async function registerConnectionSourceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    if (!canManageWorkspace(request)) await reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "只有工作空间管理员可以管理连接来源" });
  });

  app.get("/api/v1/connection-sources", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { items: await publicSources(app, workspaceParams(request)) };
  });

  app.post("/api/v1/connection-sources/securecrt", async (request, reply) => {
    const body = parseBody(sourceConfigSchema, request.body, reply);
    if (!body) return;
    if (body.authType === "password" && !body.password) return reply.code(400).send({ error: "PASSWORD_REQUIRED", message: "密码认证必须填写同步密码" });
    if (body.authType === "privateKey" && !body.privateKey) return reply.code(400).send({ error: "PRIVATE_KEY_REQUIRED", message: "私钥认证必须填写私钥" });
    const scheduleError = body.scheduleEnabled ? cronExpressionError(body.scheduleExpression) : null;
    if (scheduleError) return reply.code(400).send({ error: "INVALID_SCHEDULE", message: scheduleError });
    const id = randomUUID();
    const now = new Date().toISOString();
    const config: SecureCrtSourceConfig = { host: body.host, port: body.port, username: body.username, authType: body.authType, password: body.password, privateKey: body.privateKey, passphrase: body.passphrase, configPassphrase: body.configPassphrase, remotePaths: body.remotePaths };
    await app.db.prepare(`INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, schedule_enabled, schedule_expression, created_at, updated_at) VALUES (?, ?, ?, 'securecrt_sync', ?, ?, ?, ?, ?, ?)`)
      .run(id, ...workspaceParams(request), body.name, app.secrets.encrypt(JSON.stringify(config)), body.scheduleEnabled ? 1 : 0, body.scheduleExpression || null, now, now);
    await app.connectionSourceScheduler.refresh(id);
    await writeAudit(app.db, { action: "connection_source.created", resourceType: "connection_source", resourceId: id, summary: `创建 SecureCRT 同步源 ${body.name}`, request });
    return reply.code(201).send({ id });
  });

  app.post("/api/v1/connection-sources/script", async (request, reply) => {
    const body = parseBody(scriptSourceConfigSchema, request.body, reply);
    if (!body) return;
    const scheduleError = body.scheduleEnabled ? cronExpressionError(body.scheduleExpression) : null;
    if (scheduleError) return reply.code(400).send({ error: "INVALID_SCHEDULE", message: scheduleError });
    const id = randomUUID();
    const now = new Date().toISOString();
    const config: ScriptSourceConfig = { script: body.script, conflictStrategy: body.conflictStrategy };
    await app.db.prepare(`INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, schedule_enabled, schedule_expression, created_at, updated_at) VALUES (?, ?, ?, 'script_sync', ?, ?, ?, ?, ?, ?)`)
      .run(id, ...workspaceParams(request), body.name, app.secrets.encrypt(JSON.stringify(config)), body.scheduleEnabled ? 1 : 0, body.scheduleExpression || null, now, now);
    await app.connectionSourceScheduler.refresh(id);
    await writeAudit(app.db, { action: "connection_source.created", resourceType: "connection_source", resourceId: id, summary: `创建脚本同步源 ${body.name}`, details: { conflictStrategy: body.conflictStrategy }, request });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/v1/connection-sources/:id", async (request, reply) => {
    const body = parseBody(sourceConfigSchema, request.body, reply);
    if (!body) return;
    const scheduleError = body.scheduleEnabled ? cronExpressionError(body.scheduleExpression) : null;
    if (scheduleError) return reply.code(400).send({ error: "INVALID_SCHEDULE", message: scheduleError });
    const existing = await app.db.prepare(`SELECT config_ciphertext FROM connection_sources WHERE id = ? AND type = 'securecrt_sync' AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { config_ciphertext: string } | undefined;
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "SecureCRT 同步源不存在" });
    const current = JSON.parse(app.secrets.decrypt(existing.config_ciphertext)) as SecureCrtSourceConfig;
    const config: SecureCrtSourceConfig = {
      host: body.host,
      port: body.port,
      username: body.username,
      authType: body.authType,
      password: body.password || current.password,
      privateKey: body.privateKey || current.privateKey,
      passphrase: body.passphrase || current.passphrase,
      configPassphrase: body.configPassphrase || current.configPassphrase,
      remotePaths: body.remotePaths,
    };
    await app.db.prepare("UPDATE connection_sources SET name = ?, config_ciphertext = ?, schedule_enabled = ?, schedule_expression = ?, updated_at = ? WHERE id = ?")
      .run(body.name, app.secrets.encrypt(JSON.stringify(config)), body.scheduleEnabled ? 1 : 0, body.scheduleExpression || null, new Date().toISOString(), request.params.id);
    await app.connectionSourceScheduler.refresh(request.params.id);
    await writeAudit(app.db, { action: "connection_source.updated", resourceType: "connection_source", resourceId: request.params.id, summary: `更新 SecureCRT 同步源 ${body.name}`, request });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/v1/connection-sources/:id/script", async (request, reply) => {
    const body = parseBody(scriptSourceConfigSchema, request.body, reply);
    if (!body) return;
    const scheduleError = body.scheduleEnabled ? cronExpressionError(body.scheduleExpression) : null;
    if (scheduleError) return reply.code(400).send({ error: "INVALID_SCHEDULE", message: scheduleError });
    const existing = await app.db.prepare(`SELECT id FROM connection_sources WHERE id = ? AND type = 'script_sync' AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request));
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "脚本同步源不存在" });
    const config: ScriptSourceConfig = { script: body.script, conflictStrategy: body.conflictStrategy };
    await app.db.prepare("UPDATE connection_sources SET name = ?, config_ciphertext = ?, schedule_enabled = ?, schedule_expression = ?, updated_at = ? WHERE id = ?")
      .run(body.name, app.secrets.encrypt(JSON.stringify(config)), body.scheduleEnabled ? 1 : 0, body.scheduleExpression || null, new Date().toISOString(), request.params.id);
    await app.connectionSourceScheduler.refresh(request.params.id);
    await writeAudit(app.db, { action: "connection_source.updated", resourceType: "connection_source", resourceId: request.params.id, summary: `更新脚本同步源 ${body.name}`, details: { conflictStrategy: body.conflictStrategy }, request });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/connection-sources/:id", async (request, reply) => {
    const source = await app.db.prepare(`SELECT name FROM connection_sources WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { name: string } | undefined;
    if (!source) return reply.code(404).send({ error: "NOT_FOUND", message: "连接来源不存在" });
    await app.db.prepare("DELETE FROM connection_sources WHERE id = ?").run(request.params.id);
    app.connectionSourceScheduler.stop(request.params.id);
    await writeAudit(app.db, { action: "connection_source.deleted", resourceType: "connection_source", resourceId: request.params.id, summary: `删除连接来源 ${source.name}`, request });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/connection-sources/:id/sync", async (request, reply) => {
    const source = await app.db.prepare(`SELECT type FROM connection_sources WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { type: string } | undefined;
    if (!source) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "同步源不存在" });
    }
    try {
      return source.type === "script_sync" ? await syncScriptSource(app, request.params.id, request) : await syncSecureCrtSource(app, request.params.id, request);
    } catch (error) {
      if (error instanceof Error && error.message === "SecureCRT 同步源不存在") return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      return reply.code(502).send({ error: "SOURCE_SYNC_FAILED", message: error instanceof Error ? error.message : "SecureCRT 同步失败" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/connection-sources/:id/runs", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!await app.db.prepare(`SELECT 1 FROM connection_sources WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request))) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "同步源不存在" });
    }
    const rows = await app.db.prepare(`SELECT id, trigger_type, status, conflict_strategy, started_at, completed_at, duration_ms, summary_json, error_message FROM connection_source_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 50`).all(request.params.id) as Record<string, unknown>[];
    return { items: rows.map((row) => ({ id: row.id, triggerType: row.trigger_type, status: row.status, conflictStrategy: row.conflict_strategy, startedAt: row.started_at, completedAt: row.completed_at, durationMs: Number(row.duration_ms), summary: JSON.parse(String(row.summary_json)), errorMessage: row.error_message })) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/connection-source-runs/:id", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const row = await app.db.prepare(`
      SELECT r.* FROM connection_source_runs r JOIN connection_sources s ON s.id = r.source_id
      WHERE r.id = ? AND ${workspaceWhere("s")}
    `).get(request.params.id, ...workspaceParams(request)) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "同步报告不存在" });
    return { id: row.id, sourceId: row.source_id, triggerType: row.trigger_type, status: row.status, conflictStrategy: row.conflict_strategy, startedAt: row.started_at, completedAt: row.completed_at, durationMs: Number(row.duration_ms), summary: JSON.parse(String(row.summary_json)), items: JSON.parse(String(row.items_json)), errorMessage: row.error_message };
  });

  app.get<{ Params: { id: string } }>("/api/v1/connection-sources/:id/mappings", async (request) => {
    const rows = await app.db.prepare(`SELECT m.*, e.name AS environment_name FROM source_folder_mappings m JOIN environments e ON e.id = m.environment_id JOIN connection_sources s ON s.id = m.source_id WHERE m.source_id = ? AND ${workspaceWhere("s")} ORDER BY LENGTH(m.source_path_prefix) DESC`).all(request.params.id, ...workspaceParams(request)) as Record<string, unknown>[];
    return { items: rows.map((row) => ({ id: row.id, sourcePathPrefix: row.source_path_prefix, environmentId: row.environment_id, environmentName: row.environment_name, createdAt: row.created_at })) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/connection-sources/:id/mappings", async (request, reply) => {
    const body = parseBody(mappingSchema, request.body, reply);
    if (!body) return;
    const source = await app.db.prepare(`SELECT id FROM connection_sources WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request));
    if (!source) return reply.code(404).send({ error: "NOT_FOUND", message: "连接来源不存在" });
    if (!await app.db.prepare(`SELECT 1 FROM environments WHERE id = ? AND ${workspaceWhere()}`).get(body.environmentId, ...workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT", message: "环境不属于当前工作空间" });
    }
    const id = randomUUID();
    const apply = app.db.transaction(async () => {
      const now = new Date().toISOString();
      await app.db.prepare("INSERT INTO source_folder_mappings (id, source_id, source_path_prefix, environment_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, request.params.id, body.sourcePathPrefix, body.environmentId, now);
      for (const type of ["ssh", "database"] as const) {
        const connectionTable = type === "ssh" ? "ssh_connections" : "database_connections";
        const environmentTable = type === "ssh" ? "ssh_connection_environments" : "database_connection_environments";
        const rows = await app.db.prepare(`
          SELECT c.id FROM ${connectionTable} c
          WHERE c.source_id = ? AND c.source_path LIKE ?
            AND NOT EXISTS (SELECT 1 FROM ${environmentTable} ce WHERE ce.connection_id = c.id)
        `).all(request.params.id, `${body.sourcePathPrefix}%`) as Array<{ id: string }>;
        for (const row of rows) {
          await addConnectionEnvironment(app.db, type, row.id, body.environmentId);
          await app.db.prepare(`UPDATE ${connectionTable} SET updated_at = ? WHERE id = ?`).run(now, row.id);
        }
      }
    });
    try { await apply(); } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "DUPLICATE_MAPPING", message: "该来源路径已经配置映射" });
      throw error;
    }
    await writeAudit(app.db, { action: "connection_source.mapping_created", resourceType: "connection_source", resourceId: request.params.id, summary: `创建来源目录映射 ${body.sourcePathPrefix}`, details: body, request });
    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { sourceId: string; mappingId: string } }>("/api/v1/connection-sources/:sourceId/mappings/:mappingId", async (request, reply) => {
    if (!await app.db.prepare(`SELECT 1 FROM connection_sources WHERE id = ? AND ${workspaceWhere()}`).get(request.params.sourceId, ...workspaceParams(request))) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "连接来源不存在" });
    }
    const result = await app.db.prepare("DELETE FROM source_folder_mappings WHERE id = ? AND source_id = ?").run(request.params.mappingId, request.params.sourceId);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "映射规则不存在" });
    await writeAudit(app.db, { action: "connection_source.mapping_deleted", resourceType: "connection_source", resourceId: request.params.sourceId, summary: "删除来源目录映射", details: { mappingId: request.params.mappingId }, request });
    return reply.code(204).send();
  });
}
