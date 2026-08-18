import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from "ssh2";
import { writeAudit } from "../audit.js";
import { addConnectionEnvironment } from "../connection-environments.js";
import { ensureConnectionGroup } from "../connection-groups.js";
import type { WorkspaceType } from "../access-control.js";
import { preserveSshLoginScript } from "../ssh/options.js";
import { parseSecureCrtFiles, type ImportedSshPayload } from "../imports/parsers.js";

export interface SecureCrtSourceConfig {
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  configPassphrase?: string;
  remotePaths: string[];
}

interface RemoteFile {
  /** Path relative to a configured root, used to preserve SecureCRT folders as groups. */
  path: string;
  /** Absolute remote path retained for source tracing and folder mappings. */
  sourcePath: string;
  content: Buffer;
}

interface ConflictItem {
  id: string;
  name: string;
  environmentName: string | null;
  sourceName: string | null;
  connectionGroupName: string | null;
  connectionGroupPath: string | null;
}

export interface SecureCrtSyncResult {
  files: number;
  parsed: number;
  created: number;
  updated: number;
  deleted: number;
  credentialWarnings: number;
  conflicts: number;
  conflictBatchId: string | null;
}

function connectSource(config: SecureCrtSourceConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const options: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 15_000,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
    };
    if (config.authType === "privateKey") {
      if (!config.privateKey) return reject(new Error("同步源没有保存私钥"));
      options.privateKey = config.privateKey;
      options.passphrase = config.passphrase || undefined;
    } else {
      if (!config.password) return reject(new Error("同步源没有保存密码"));
      options.password = config.password;
    }
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect(options);
  });
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
}

function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => sftp.realpath(path, (error, resolved) => error ? reject(error) : resolve(resolved)));
}

function readdir(sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => sftp.readdir(path, (error, files) => error ? reject(error) : resolve(files)));
}

function readFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => sftp.readFile(path, (error, content) => error ? reject(error) : resolve(content)));
}

async function collectRemoteFiles(sftp: SFTPWrapper, configuredPaths: string[]): Promise<RemoteFile[]> {
  const home = await realpath(sftp, ".");
  const files: RemoteFile[] = [];
  let totalBytes = 0;
  const walk = async (path: string, root: string, rootName: string, depth: number) => {
    if (depth > 32) throw new Error("SecureCRT 同步目录层级超过 32 层");
    for (const entry of await readdir(sftp, path)) {
      if (entry.filename === "." || entry.filename === "..") continue;
      const child = posix.join(path, entry.filename);
      if (entry.attrs.isDirectory()) {
        await walk(child, root, rootName, depth + 1);
      } else if (!entry.attrs.isSymbolicLink() && [".ini", ".session"].includes(posix.extname(entry.filename).toLowerCase())) {
        if (files.length >= 10_000) throw new Error("SecureCRT 同步文件超过 10,000 个上限");
        totalBytes += entry.attrs.size;
        if (totalBytes > 100 * 1024 * 1024) throw new Error("SecureCRT 同步文件总大小超过 100MB");
        files.push({ path: posix.join(rootName, posix.relative(root, child)), sourcePath: child, content: await readFile(sftp, child) });
      }
    }
  };
  for (const configuredPath of configuredPaths) {
    const path = configuredPath.startsWith("~/") ? posix.join(home, configuredPath.slice(2)) : configuredPath === "~" ? home : configuredPath;
    const normalized = posix.normalize(path);
    await walk(normalized, normalized, posix.basename(normalized), 0);
  }
  return files;
}

async function mappedEnvironment(app: FastifyInstance, sourceId: string, sourcePath: string): Promise<string | null> {
  const mappings = await app.db.prepare("SELECT source_path_prefix, environment_id FROM source_folder_mappings WHERE source_id = ? ORDER BY LENGTH(source_path_prefix) DESC").all(sourceId) as Array<{ source_path_prefix: string; environment_id: string }>;
  return mappings.find((mapping) => sourcePath.startsWith(mapping.source_path_prefix))?.environment_id ?? null;
}

async function conflictsFor(app: FastifyInstance, sourceId: string, payload: ImportedSshPayload, workspace: [WorkspaceType, string]): Promise<ConflictItem[]> {
  return (await app.db.prepare(`
    SELECT c.id, c.name, e.name AS environment_name, s.name AS source_name,
      g.name AS connection_group_name, g.path AS connection_group_path
    FROM ssh_connections c
    LEFT JOIN environments e ON e.id = c.environment_id
    LEFT JOIN connection_sources s ON s.id = c.source_id
    LEFT JOIN connection_groups g ON g.id = c.connection_group_id
    WHERE c.workspace_type = ? AND c.workspace_id = ? AND c.source_deleted = 0 AND (c.source_id IS NULL OR c.source_id <> ?)
      AND LOWER(c.host) = LOWER(?) AND c.port = ? AND LOWER(c.username) = LOWER(?)
  `).all(...workspace, sourceId, payload.host, payload.port, payload.username || "root")).map((row) => {
    const item = row as Record<string, unknown>;
    return {
      id: String(item.id),
      name: String(item.name),
      environmentName: item.environment_name ? String(item.environment_name) : null,
      sourceName: item.source_name ? String(item.source_name) : null,
      connectionGroupName: item.connection_group_name ? String(item.connection_group_name) : null,
      connectionGroupPath: item.connection_group_path ? String(item.connection_group_path) : null,
    };
  });
}

async function createConflictBatch(app: FastifyInstance, sourceId: string, sourceName: string, rows: Array<{ payload: ImportedSshPayload; conflicts: ConflictItem[] }>, now: string, workspace: [WorkspaceType, string]): Promise<string | null> {
  await app.db.prepare("UPDATE connection_import_batches SET status = 'cancelled', completed_at = ? WHERE source_id = ? AND status = 'preview'").run(now, sourceId);
  if (!rows.length) return null;
  const batchId = randomUUID();
  const summary = { total: rows.length, ssh: rows.length, database: 0, new: 0, conflict: rows.length, invalid: 0, warnings: rows.reduce((sum, row) => sum + row.payload.warnings.length, 0) };
  await app.db.prepare(`
    INSERT INTO connection_import_batches (id, workspace_type, workspace_id, source_id, type, filename, status, summary_json, created_at)
    VALUES (?, ?, ?, ?, 'securecrt', ?, 'preview', ?, ?)
  `).run(batchId, ...workspace, sourceId, `SecureCRT 同步 · ${sourceName}`, JSON.stringify(summary), now);
  const insert = app.db.prepare(`
    INSERT INTO connection_import_items (
      id, batch_id, connection_type, source_path, display_name, endpoint,
      payload_ciphertext, status, conflict_json, warnings_json, created_at
    ) VALUES (?, ?, 'ssh', ?, ?, ?, ?, 'conflict', ?, ?, ?)
  `);
  for (const row of rows) {
    await insert.run(
      randomUUID(), batchId, row.payload.sourcePath, row.payload.name,
      `${row.payload.username || "root"}@${row.payload.host}:${row.payload.port}`,
      app.secrets.encrypt(JSON.stringify(row.payload)), JSON.stringify(row.conflicts),
      JSON.stringify(row.payload.warnings), now,
    );
  }
  return batchId;
}

export async function reconcileSecureCrtPayloads(app: FastifyInstance, sourceId: string, sourceName: string, parsed: ImportedSshPayload[]): Promise<Omit<SecureCrtSyncResult, "files" | "parsed">> {
  let created = 0;
  let updated = 0;
  let credentialWarnings = 0;
  let conflictBatchId: string | null = null;
  const pendingConflicts: Array<{ payload: ImportedSshPayload; conflicts: ConflictItem[] }> = [];
  const now = new Date().toISOString();
  const source = await app.db.prepare("SELECT workspace_type, workspace_id FROM connection_sources WHERE id = ?").get(sourceId) as { workspace_type: WorkspaceType; workspace_id: string } | undefined;
  if (!source) throw new Error("SecureCRT 同步源不存在");
  if (!source.workspace_id) {
    const owner = await app.db.prepare("SELECT id FROM admin_users WHERE is_platform_admin = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (!owner) throw new Error("同步源尚未归属用户");
    source.workspace_type = "personal";
    source.workspace_id = owner.id;
    await app.db.prepare("UPDATE connection_sources SET workspace_type = 'personal', workspace_id = ? WHERE id = ?").run(owner.id, sourceId);
    await app.db.prepare("UPDATE ssh_connections SET workspace_type = 'personal', workspace_id = ? WHERE workspace_id = ''").run(owner.id);
    await app.db.prepare("UPDATE database_connections SET workspace_type = 'personal', workspace_id = ? WHERE workspace_id = ''").run(owner.id);
  }
  const workspace: [WorkspaceType, string] = [source.workspace_type, source.workspace_id];
  const sync = app.db.transaction(async () => {
    await app.db.prepare("UPDATE ssh_connections SET source_deleted = 1, updated_at = ? WHERE source_id = ?").run(now, sourceId);
    for (const payload of parsed) {
      const existing = await app.db.prepare("SELECT id, credential_ciphertext, connection_group_id, options_json FROM ssh_connections WHERE source_id = ? AND source_item_id = ?").get(sourceId, payload.importKey) as { id: string; credential_ciphertext: string; connection_group_id: string | null; options_json: string } | undefined;
      const credentialAvailable = Boolean(payload.credential.password || payload.credential.privateKey);
      if (!credentialAvailable) credentialWarnings += 1;
      if (existing) {
        const connectionGroupId = payload.groupPath?.length ? await ensureConnectionGroup(app, "ssh", payload.groupPath, workspace) : existing.connection_group_id;
        const options = preserveSshLoginScript(existing.options_json, payload.options);
        await app.db.prepare(`UPDATE ssh_connections SET connection_group_id = ?, source_path = ?, name = ?, host = ?, port = ?, username = ?, auth_type = ?, credential_ciphertext = ?, options_json = ?, source_deleted = 0, updated_at = ? WHERE id = ?`)
          .run(connectionGroupId, payload.sourcePath, payload.name, payload.host, payload.port, payload.username || "root", payload.authType, credentialAvailable ? app.secrets.encrypt(JSON.stringify(payload.credential)) : existing.credential_ciphertext, JSON.stringify(options), now, existing.id);
        updated += 1;
        continue;
      }
      const conflicts = await conflictsFor(app, sourceId, payload, workspace);
      if (conflicts.length) {
        pendingConflicts.push({ payload, conflicts });
        continue;
      }
      const id = randomUUID();
      const connectionGroupId = await ensureConnectionGroup(app, "ssh", payload.groupPath ?? [], workspace);
      const environmentId = await mappedEnvironment(app, sourceId, payload.sourcePath);
      await app.db.prepare(`INSERT INTO ssh_connections (id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, source_item_id, source_path, name, host, port, username, auth_type, credential_ciphertext, options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ...workspace, environmentId, connectionGroupId, sourceId, payload.importKey, payload.sourcePath, payload.name, payload.host, payload.port, payload.username || "root", payload.authType, app.secrets.encrypt(JSON.stringify(payload.credential)), JSON.stringify(payload.options), now, now);
      await addConnectionEnvironment(app.db, "ssh", id, environmentId);
      created += 1;
    }
    conflictBatchId = await createConflictBatch(app, sourceId, sourceName, pendingConflicts, now, workspace);
    await app.db.prepare("UPDATE connection_sources SET last_synced_at = ?, updated_at = ? WHERE id = ?").run(now, now, sourceId);
  });
  await sync();
  const deleted = Number((await app.db.prepare("SELECT COUNT(*) AS count FROM ssh_connections WHERE source_id = ? AND source_deleted = 1").get(sourceId) as { count: number }).count);
  return { created, updated, deleted, credentialWarnings, conflicts: pendingConflicts.length, conflictBatchId };
}

export async function syncSecureCrtSource(app: FastifyInstance, sourceId: string, request?: FastifyRequest): Promise<SecureCrtSyncResult> {
  const source = await app.db.prepare("SELECT name, config_ciphertext, workspace_type, workspace_id FROM connection_sources WHERE id = ? AND type = 'securecrt_sync'").get(sourceId) as { name: string; config_ciphertext: string; workspace_type: WorkspaceType; workspace_id: string } | undefined;
  if (!source) throw new Error("SecureCRT 同步源不存在");
  const config = JSON.parse(app.secrets.decrypt(source.config_ciphertext)) as SecureCrtSourceConfig;
  let client: Client | undefined;
  try {
    client = await connectSource(config);
    const sftp = await openSftp(client);
    const files = await collectRemoteFiles(sftp, config.remotePaths);
    const parsed = parseSecureCrtFiles(files, config.configPassphrase ?? "") as ImportedSshPayload[];
    const result = { files: files.length, parsed: parsed.length, ...await reconcileSecureCrtPayloads(app, sourceId, source.name, parsed) };
    await writeAudit(app.db, {
      action: "connection_source.synced",
      resourceType: "connection_source",
      resourceId: sourceId,
      summary: `同步 SecureCRT 来源 ${source.name}`,
      details: result,
      request,
      workspaceType: source.workspace_type,
      workspaceId: source.workspace_id,
    });
    return result;
  } catch (error) {
    await writeAudit(app.db, {
      action: "connection_source.sync_failed",
      resourceType: "connection_source",
      resourceId: sourceId,
      summary: `SecureCRT 同步失败 ${source.name}`,
      details: { message: error instanceof Error ? error.message : String(error) },
      request,
      workspaceType: source.workspace_type,
      workspaceId: source.workspace_id,
    });
    throw error;
  } finally {
    client?.end();
  }
}
