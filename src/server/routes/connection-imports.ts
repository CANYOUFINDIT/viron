import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { canManageWorkspace, type WorkspaceType, workspaceParams, workspaceWhere } from "../access-control.js";
import { addConnectionEnvironment } from "../connection-environments.js";
import { ensureConnectionGroup } from "../connection-groups.js";
import { preserveSshLoginScript } from "../ssh/options.js";
import { parseConnectionImport, type ImportedDatabasePayload, type ImportedPayload, type ImportedSshPayload } from "../imports/parsers.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { decryptDatabaseCredential, normalizeDatabaseStorage } from "../database-credentials.js";

const confirmSchema = z.object({
  decisions: z.array(z.object({
    itemId: z.string().uuid(),
    action: z.enum(["import", "keep", "overwrite", "reuse", "skip"]),
    targetId: z.string().uuid().optional(),
  })).min(1).max(5_000),
});

interface ConflictItem {
  id: string;
  name: string;
  environmentName: string | null;
  sourceName: string | null;
  connectionGroupName: string | null;
  connectionGroupPath: string | null;
}

function endpoint(payload: ImportedPayload): string {
  return `${payload.username}@${payload.host}:${payload.port}`;
}

function hasCredential(payload: ImportedPayload): boolean {
  if (payload.type === "database") {
    const storage = normalizeDatabaseStorage(payload.options, payload.credential);
    return Object.values(storage.credential).some(Boolean);
  }
  return Object.values(payload.credential).some(Boolean);
}

async function conflictsFor(app: FastifyInstance, payload: ImportedPayload, workspace: [WorkspaceType, string]): Promise<ConflictItem[]> {
  if (payload.type === "ssh") {
    return (await app.db.prepare(`
      SELECT c.id, c.name, e.name AS environment_name, s.name AS source_name,
        g.name AS connection_group_name, g.path AS connection_group_path
      FROM ssh_connections c
      LEFT JOIN environments e ON e.id = c.environment_id
      LEFT JOIN connection_sources s ON s.id = c.source_id
      LEFT JOIN connection_groups g ON g.id = c.connection_group_id
      WHERE c.workspace_type = ? AND c.workspace_id = ? AND LOWER(c.host) = LOWER(?) AND c.port = ? AND LOWER(c.username) = LOWER(?)
    `).all(...workspace, payload.host, payload.port, payload.username)).map((row) => {
      const item = row as Record<string, unknown>;
      return { id: String(item.id), name: String(item.name), environmentName: item.environment_name ? String(item.environment_name) : null, sourceName: item.source_name ? String(item.source_name) : null, connectionGroupName: item.connection_group_name ? String(item.connection_group_name) : null, connectionGroupPath: item.connection_group_path ? String(item.connection_group_path) : null };
    });
  }
  return (await app.db.prepare(`
    SELECT c.id, c.name, e.name AS environment_name, s.name AS source_name,
      g.name AS connection_group_name, g.path AS connection_group_path
    FROM database_connections c
    LEFT JOIN environments e ON e.id = c.environment_id
    LEFT JOIN connection_sources s ON s.id = c.source_id
    LEFT JOIN connection_groups g ON g.id = c.connection_group_id
    WHERE c.workspace_type = ? AND c.workspace_id = ? AND c.engine = ? AND LOWER(c.host) = LOWER(?) AND c.port = ? AND LOWER(c.username) = LOWER(?)
  `).all(...workspace, payload.engine, payload.host, payload.port, payload.username)).map((row) => {
    const item = row as Record<string, unknown>;
    return { id: String(item.id), name: String(item.name), environmentName: item.environment_name ? String(item.environment_name) : null, sourceName: item.source_name ? String(item.source_name) : null, connectionGroupName: item.connection_group_name ? String(item.connection_group_name) : null, connectionGroupPath: item.connection_group_path ? String(item.connection_group_path) : null };
  });
}

async function mappedEnvironment(app: FastifyInstance, sourceId: string, sourcePath: string): Promise<string | null> {
  const mappings = await app.db.prepare(`
    SELECT source_path_prefix, environment_id FROM source_folder_mappings
    WHERE source_id = ? ORDER BY LENGTH(source_path_prefix) DESC
  `).all(sourceId) as Array<{ source_path_prefix: string; environment_id: string }>;
  return mappings.find((mapping) => sourcePath.startsWith(mapping.source_path_prefix))?.environment_id ?? null;
}

async function insertSsh(app: FastifyInstance, sourceId: string, payload: ImportedSshPayload, workspace: [WorkspaceType, string]): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const connectionGroupId = await ensureConnectionGroup(app, "ssh", payload.groupPath ?? [], workspace);
  const environmentId = await mappedEnvironment(app, sourceId, payload.sourcePath);
  await app.db.prepare(`
    INSERT INTO ssh_connections (
      id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, source_item_id, source_path, name, host, port,
      username, auth_type, credential_ciphertext, options_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, ...workspace, environmentId, connectionGroupId, sourceId, payload.importKey, payload.sourcePath,
    payload.name, payload.host, payload.port, payload.username || "root", payload.authType,
    app.secrets.encrypt(JSON.stringify(payload.credential)), JSON.stringify(payload.options), now, now,
  );
  await addConnectionEnvironment(app.db, "ssh", id, environmentId);
  return id;
}

async function updateSsh(app: FastifyInstance, targetId: string, sourceId: string, payload: ImportedSshPayload, workspace: [WorkspaceType, string]): Promise<string> {
  const existing = await app.db.prepare(`SELECT credential_ciphertext, connection_group_id, options_json FROM ssh_connections WHERE id = ? AND ${workspaceWhere()}`).get(targetId, ...workspace) as { credential_ciphertext: string; connection_group_id: string | null; options_json: string } | undefined;
  if (!existing) throw new Error("要覆盖的 SSH 连接不存在");
  const connectionGroupId = payload.groupPath?.length ? await ensureConnectionGroup(app, "ssh", payload.groupPath, workspace) : existing.connection_group_id;
  const options = preserveSshLoginScript(existing.options_json, payload.options);
  await app.db.prepare(`
    UPDATE ssh_connections SET connection_group_id = ?, source_id = ?, source_item_id = ?, source_path = ?, name = ?, host = ?,
      port = ?, username = ?, auth_type = ?, credential_ciphertext = ?, options_json = ?,
      source_deleted = 0, updated_at = ? WHERE id = ?
  `).run(
    connectionGroupId, sourceId, payload.importKey, payload.sourcePath, payload.name, payload.host, payload.port, payload.username || "root",
    payload.authType, hasCredential(payload) ? app.secrets.encrypt(JSON.stringify(payload.credential)) : existing.credential_ciphertext,
    JSON.stringify(options), new Date().toISOString(), targetId,
  );
  return targetId;
}

async function insertDatabase(app: FastifyInstance, sourceId: string, payload: ImportedDatabasePayload, workspace: [WorkspaceType, string], sshConnectionId?: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const storage = normalizeDatabaseStorage({ ...payload.options, sshConnectionId: sshConnectionId ?? null }, payload.credential);
  const connectionGroupId = await ensureConnectionGroup(app, "database", payload.groupPath ?? [], workspace);
  const environmentId = await mappedEnvironment(app, sourceId, payload.sourcePath);
  await app.db.prepare(`
    INSERT INTO database_connections (
      id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, source_item_id, source_path, name, engine, host, port,
      username, credential_ciphertext, default_database, connection_mode, options_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, ...workspace, environmentId, connectionGroupId, sourceId, payload.importKey, payload.sourcePath,
    payload.name, payload.engine, payload.host, payload.port, payload.username,
    app.secrets.encrypt(JSON.stringify(storage.credential)), payload.defaultDatabase, payload.connectionMode,
    JSON.stringify(storage.options), now, now,
  );
  await addConnectionEnvironment(app.db, "database", id, environmentId);
  return id;
}

async function updateDatabase(app: FastifyInstance, targetId: string, sourceId: string, payload: ImportedDatabasePayload, workspace: [WorkspaceType, string], sshConnectionId?: string): Promise<string> {
  const existing = await app.db.prepare(`SELECT credential_ciphertext, connection_group_id FROM database_connections WHERE id = ? AND ${workspaceWhere()}`).get(targetId, ...workspace) as { credential_ciphertext: string; connection_group_id: string | null } | undefined;
  if (!existing) throw new Error("要覆盖的数据库连接不存在");
  const storage = normalizeDatabaseStorage({ ...payload.options, sshConnectionId: sshConnectionId ?? null }, payload.credential);
  const credentialUpdates = Object.fromEntries(Object.entries(storage.credential).filter(([, value]) => Boolean(value)));
  const credential = Object.keys(credentialUpdates).length
    ? { ...decryptDatabaseCredential(app, existing.credential_ciphertext), ...credentialUpdates }
    : null;
  const connectionGroupId = payload.groupPath?.length ? await ensureConnectionGroup(app, "database", payload.groupPath, workspace) : existing.connection_group_id;
  await app.db.prepare(`
    UPDATE database_connections SET connection_group_id = ?, source_id = ?, source_item_id = ?, source_path = ?, name = ?, engine = ?,
      host = ?, port = ?, username = ?, credential_ciphertext = ?, default_database = ?,
      connection_mode = ?, options_json = ?, source_deleted = 0, updated_at = ? WHERE id = ?
  `).run(
    connectionGroupId, sourceId, payload.importKey, payload.sourcePath, payload.name, payload.engine, payload.host, payload.port,
    payload.username, credential ? app.secrets.encrypt(JSON.stringify(credential)) : existing.credential_ciphertext,
    payload.defaultDatabase, payload.connectionMode, JSON.stringify(storage.options), new Date().toISOString(), targetId,
  );
  return targetId;
}

async function publicBatch(app: FastifyInstance, batchId: string, workspace: [WorkspaceType, string]) {
  const batch = await app.db.prepare(`
    SELECT b.*, s.name AS source_name, s.type AS source_type FROM connection_import_batches b
    JOIN connection_sources s ON s.id = b.source_id WHERE b.id = ? AND ${workspaceWhere("b")}
  `).get(batchId, ...workspace) as Record<string, unknown> | undefined;
  if (!batch) return null;
  const rows = await app.db.prepare("SELECT * FROM connection_import_items WHERE batch_id = ? ORDER BY source_path, display_name").all(batchId) as Record<string, unknown>[];
  return {
    id: batch.id,
    type: batch.type,
    filename: batch.filename,
    sourceId: batch.source_id,
    sourceName: batch.source_name,
    sourceType: batch.source_type,
    status: batch.status,
    summary: JSON.parse(String(batch.summary_json)),
    createdAt: batch.created_at,
    items: rows.map((row) => {
      const payload = JSON.parse(app.secrets.decrypt(String(row.payload_ciphertext))) as ImportedPayload;
      return {
        id: row.id,
        type: row.connection_type,
        name: row.display_name,
        endpoint: row.endpoint,
        sourcePath: row.source_path,
        status: row.status,
        conflicts: JSON.parse(String(row.conflict_json)),
        warnings: JSON.parse(String(row.warnings_json)),
        hasCredential: hasCredential(payload),
        createdConnectionId: row.created_connection_id,
      };
    }),
  };
}

export async function registerConnectionImportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    if (!canManageWorkspace(request)) await reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "只有工作空间管理员可以导入连接" });
  });

  app.post("/api/v1/connection-imports/preview", async (request, reply) => {
    let type = "";
    let passphrase = "";
    let filename = "";
    let fileBuffer: Buffer | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        filename = part.filename;
        fileBuffer = await part.toBuffer();
      } else if (part.fieldname === "type") type = String(part.value);
      else if (part.fieldname === "passphrase") passphrase = String(part.value);
    }
    if (!fileBuffer || !filename) return reply.code(400).send({ error: "FILE_REQUIRED", message: "请选择导入文件" });
    if (type !== "securecrt" && type !== "navicat") return reply.code(400).send({ error: "INVALID_IMPORT_TYPE", message: "导入类型不正确" });
    try {
      const parsed = await parseConnectionImport(type, filename, fileBuffer, passphrase);
      if (!parsed.length) return reply.code(400).send({ error: "NO_CONNECTIONS", message: "文件中没有可识别的 SSH 或 MySQL/MariaDB 连接" });
      const batchId = randomUUID();
      const sourceId = randomUUID();
      const now = new Date().toISOString();
      const sourceName = `${type === "securecrt" ? "SecureCRT" : "Navicat"} · ${filename}`;
      const counts = { total: parsed.length, ssh: 0, database: 0, new: 0, conflict: 0, conflictSsh: 0, conflictDatabase: 0, invalid: 0, warnings: 0 };
      const rows = await Promise.all(parsed.map(async (payload) => {
        const invalid = !payload.host || !payload.port || !payload.username;
        const conflicts = invalid ? [] : await conflictsFor(app, payload, workspaceParams(request));
        const status = invalid ? "invalid" : conflicts.length ? "conflict" : "new";
        counts[payload.type] += 1;
        counts[status] += 1;
        if (status === "conflict") counts[payload.type === "ssh" ? "conflictSsh" : "conflictDatabase"] += 1;
        counts.warnings += payload.warnings.length;
        return { id: randomUUID(), payload, status, conflicts };
      }));
      const persist = app.db.transaction(async () => {
        await app.db.prepare(`
          INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sourceId, ...workspaceParams(request), `${type}_upload`, sourceName, app.secrets.encrypt("{}"), now, now);
        await app.db.prepare(`
          INSERT INTO connection_import_batches (id, workspace_type, workspace_id, source_id, type, filename, status, summary_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'preview', ?, ?)
        `).run(batchId, ...workspaceParams(request), sourceId, type, filename, JSON.stringify(counts), now);
        const insertItem = app.db.prepare(`
          INSERT INTO connection_import_items (
            id, batch_id, connection_type, source_path, display_name, endpoint,
            payload_ciphertext, status, conflict_json, warnings_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          await insertItem.run(
            row.id, batchId, row.payload.type, row.payload.sourcePath, row.payload.name, endpoint(row.payload),
            app.secrets.encrypt(JSON.stringify(row.payload)), row.status, JSON.stringify(row.conflicts),
            JSON.stringify(row.payload.warnings), now,
          );
        }
      });
      await persist();
      await writeAudit(app.db, { action: "connection.import_previewed", resourceType: "connection_import", resourceId: batchId, summary: `解析 ${sourceName}`, details: counts, request });
      return reply.code(201).send({ batch: await publicBatch(app, batchId, workspaceParams(request)) });
    } catch (error) {
      return reply.code(400).send({ error: "IMPORT_PARSE_FAILED", message: error instanceof Error ? error.message : "解析导入文件失败" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/connection-imports/:id", async (request, reply) => {
    const batch = await publicBatch(app, request.params.id, workspaceParams(request));
    if (!batch) return reply.code(404).send({ error: "NOT_FOUND", message: "导入批次不存在" });
    return { batch };
  });

  app.post<{ Params: { id: string } }>("/api/v1/connection-imports/:id/confirm", async (request, reply) => {
    const body = parseBody(confirmSchema, request.body, reply);
    if (!body) return;
    const batch = await app.db.prepare(`SELECT source_id, type, status FROM connection_import_batches WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as { source_id: string; type: string; status: string } | undefined;
    if (!batch) return reply.code(404).send({ error: "NOT_FOUND", message: "导入批次不存在" });
    if (batch.status !== "preview") return reply.code(409).send({ error: "ALREADY_COMPLETED", message: "该导入批次已经处理" });
    const decisions = new Map(body.decisions.map((decision) => [decision.itemId, decision]));
    const items = await app.db.prepare("SELECT * FROM connection_import_items WHERE batch_id = ? ORDER BY CASE connection_type WHEN 'ssh' THEN 0 ELSE 1 END, source_path").all(request.params.id) as Record<string, unknown>[];
    const createdByImportKey = new Map<string, string>();
    let imported = 0;
    let reused = 0;
    let skipped = 0;
    try {
      const confirm = app.db.transaction(async () => {
        for (const item of items) {
          const itemId = String(item.id);
          const decision = decisions.get(itemId);
          const currentStatus = String(item.status);
          if (currentStatus === "invalid") {
            await app.db.prepare("UPDATE connection_import_items SET status = 'skipped' WHERE id = ?").run(itemId);
            skipped += 1;
            continue;
          }
          if (!decision) throw new Error(`连接 ${String(item.display_name)} 尚未选择处理方式`);
          if (decision.action === "skip") {
            await app.db.prepare("UPDATE connection_import_items SET status = 'skipped' WHERE id = ?").run(itemId);
            skipped += 1;
            continue;
          }
          const reuseAllowed = batch.type === "navicat" && String(item.connection_type) === "ssh";
          if (currentStatus === "conflict" && !["keep", "overwrite", ...(reuseAllowed ? ["reuse"] : [])].includes(decision.action)) {
            throw new Error(`冲突连接 ${String(item.display_name)} 的处理方式不正确`);
          }
          if (currentStatus === "new" && decision.action !== "import") throw new Error(`新连接 ${String(item.display_name)} 的处理方式不正确`);
          const payload = JSON.parse(app.secrets.decrypt(String(item.payload_ciphertext))) as ImportedPayload;
          if (decision.action === "reuse") {
            if (!reuseAllowed || payload.type !== "ssh" || !decision.targetId) throw new Error(`复用 ${payload.name} 时必须选择已有 SSH 连接`);
            const conflictIds = (JSON.parse(String(item.conflict_json)) as ConflictItem[]).map((conflict) => conflict.id);
            if (!conflictIds.includes(decision.targetId)) throw new Error(`复用 ${payload.name} 时选择的 SSH 连接不属于冲突项`);
            createdByImportKey.set(payload.importKey, decision.targetId);
            await app.db.prepare("UPDATE connection_import_items SET status = 'imported', created_connection_id = ? WHERE id = ?").run(decision.targetId, itemId);
            reused += 1;
            continue;
          }
          let connectionId: string;
          const overwrite = decision.action === "overwrite";
          if (overwrite && !decision.targetId) throw new Error(`覆盖 ${payload.name} 时必须选择目标连接`);
          if (payload.type === "ssh") {
            connectionId = await (overwrite
              ? updateSsh(app, decision.targetId!, batch.source_id, payload, workspaceParams(request))
              : insertSsh(app, batch.source_id, payload, workspaceParams(request)));
          } else {
            const sshConnectionId = payload.sshImportKey ? createdByImportKey.get(payload.sshImportKey) : undefined;
            if (payload.connectionMode === "sshTunnel" && !sshConnectionId) payload.warnings.push("关联的 SSH Tunnel 未导入，需要手工选择");
            connectionId = await (overwrite
              ? updateDatabase(app, decision.targetId!, batch.source_id, payload, workspaceParams(request), sshConnectionId)
              : insertDatabase(app, batch.source_id, payload, workspaceParams(request), sshConnectionId));
          }
          createdByImportKey.set(payload.importKey, connectionId);
          await app.db.prepare("UPDATE connection_import_items SET status = 'imported', created_connection_id = ? WHERE id = ?").run(connectionId, itemId);
          imported += 1;
        }
        await app.db.prepare("UPDATE connection_import_batches SET status = 'imported', completed_at = ? WHERE id = ?").run(new Date().toISOString(), request.params.id);
      });
      await confirm();
    } catch (error) {
      return reply.code(400).send({ error: "IMPORT_CONFIRM_FAILED", message: error instanceof Error ? error.message : "确认导入失败" });
    }
    await writeAudit(app.db, { action: "connection.imported", resourceType: "connection_import", resourceId: request.params.id, summary: `导入 ${imported} 个连接`, details: { imported, reused, skipped }, request });
    return { imported, reused, skipped, batch: await publicBatch(app, request.params.id, workspaceParams(request)) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/connection-imports/:id", async (request, reply) => {
    const batch = await app.db.prepare(`
      SELECT b.source_id, b.status, s.type AS source_type
      FROM connection_import_batches b JOIN connection_sources s ON s.id = b.source_id
      WHERE b.id = ? AND ${workspaceWhere("b")}
    `).get(request.params.id, ...workspaceParams(request)) as { source_id: string; status: string; source_type: string } | undefined;
    if (!batch) return reply.code(404).send({ error: "NOT_FOUND", message: "导入批次不存在" });
    if (batch.status !== "preview") return reply.code(409).send({ error: "IMPORT_COMPLETED", message: "已完成的导入记录不能取消" });
    if (batch.source_type === "securecrt_sync") {
      await app.db.prepare("UPDATE connection_import_batches SET status = 'cancelled', completed_at = ? WHERE id = ?").run(new Date().toISOString(), request.params.id);
    } else {
      await app.db.prepare("DELETE FROM connection_sources WHERE id = ?").run(batch.source_id);
    }
    await writeAudit(app.db, { action: "connection.import_cancelled", resourceType: "connection_import", resourceId: request.params.id, summary: "取消连接导入", request });
    return reply.code(204).send();
  });
}
