import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canManageWorkspace } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { addConnectionEnvironment } from "../connection-environments.js";
import { ensureConnectionGroup } from "../connection-groups.js";
import { parseStoredLogFilePaths } from "../environment-log-files.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const idList = z.array(z.string().uuid()).max(1000).default([]);
const selectionSchema = z.object({
  environmentGroupIds: idList,
  environmentIds: idList,
  sshConnectionIds: idList,
  databaseConnectionIds: idList,
  webEntryIds: idList,
  webCredentialIds: idList,
  logIds: idList,
}).refine((value) => Object.values(value).some((items) => items.length), "请至少选择一项个人资源");

const previewSchema = z.object({ selection: selectionSchema });
const commitSchema = z.object({
  selection: selectionSchema,
  reuse: z.record(z.string(), z.string().uuid()).default({}),
  grantees: z.array(z.object({ type: z.enum(["user", "project"]), id: z.string().uuid() })).max(200).default([]),
});

type CopySelection = z.infer<typeof selectionSchema>;
type ResourceKind = "environment_group" | "environment" | "ssh_connection" | "database_connection" | "web_entry" | "web_credential" | "environment_log";

interface EnvironmentGroupRow { id: string; name: string; description: string; color: string; sort_order: number }
interface EnvironmentRow { id: string; group_id: string | null; name: string; short_name: string; description: string; status: string; owner: string; tags_json: string }
interface WebEntryRow { id: string; environment_id: string; name: string; url: string; description: string; tags_json: string; sort_order: number }
interface WebCredentialRow { id: string; web_entry_id: string; username: string; password_ciphertext: string; note: string; custom_fields_json: string; sort_order: number }
interface SshRow {
  id: string; environment_id: string | null; connection_group_id: string | null; name: string; host: string; port: number; username: string;
  auth_type: string; ssh_key_id: string | null; credential_ciphertext: string; jump_connection_id: string | null; options_json: string; tags_json: string;
}
interface SshKeyRow { id: string; name: string; algorithm: string; public_key: string; fingerprint: string; private_key_ciphertext: string }
interface DatabaseRow {
  id: string; environment_id: string | null; connection_group_id: string | null; name: string; engine: string; host: string; port: number; username: string;
  credential_ciphertext: string; default_database: string; connection_mode: string; options_json: string;
}
interface LogRow { id: string; environment_id: string; ssh_connection_id: string; name: string; file_path: string; file_paths_json: string }
interface ConnectionGroupRow { id: string; type: "ssh" | "database"; path: string }
interface ConflictCandidate { id: string; label: string; context: string }
interface CopyConflict { kind: ResourceKind; sourceId: string; sourceName: string; candidates: ConflictCandidate[] }

interface CopySource {
  groups: Map<string, EnvironmentGroupRow>;
  environments: Map<string, EnvironmentRow>;
  webEntries: Map<string, WebEntryRow>;
  webCredentials: Map<string, WebCredentialRow>;
  sshConnections: Map<string, SshRow>;
  sshKeys: Map<string, SshKeyRow>;
  databaseConnections: Map<string, DatabaseRow>;
  logs: Map<string, LogRow>;
  connectionGroups: Map<string, ConnectionGroupRow>;
  sshEnvironmentIds: Map<string, string[]>;
  databaseEnvironmentIds: Map<string, string[]>;
}

interface ExpandedCopyPlan {
  selection: CopySelection;
  dependencyAdded: Array<{ type: "ssh"; id: string; name: string; reason: string }>;
  conflicts: CopyConflict[];
  secretCount: number;
}

function mapById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function reencrypt(app: FastifyInstance, value: string): string {
  return app.secrets.encrypt(app.secrets.decrypt(value));
}

function requireOrganizationAdmin(request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (request.admin?.workspace.type === "organization" && canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "ORGANIZATION_ADMIN_REQUIRED", message: "请先切换到你管理的组织工作空间" });
  return false;
}

async function loadSource(app: FastifyInstance, userId: string): Promise<CopySource> {
  const workspace = ["personal", userId];
  const [groups, environments, webEntries, webCredentials, sshConnections, sshKeys, databaseConnections, logs, connectionGroups, sshLinks, databaseLinks] = await Promise.all([
    app.db.prepare("SELECT id, name, description, color, sort_order FROM environment_groups WHERE workspace_type = ? AND workspace_id = ? ORDER BY sort_order, name").all<EnvironmentGroupRow>(...workspace),
    app.db.prepare("SELECT id, group_id, name, short_name, description, status, owner, tags_json FROM environments WHERE workspace_type = ? AND workspace_id = ? ORDER BY name").all<EnvironmentRow>(...workspace),
    app.db.prepare(`SELECT w.id, w.environment_id, w.name, w.url, w.description, w.tags_json, w.sort_order FROM web_entries w JOIN environments e ON e.id = w.environment_id WHERE e.workspace_type = ? AND e.workspace_id = ? ORDER BY w.sort_order, w.name`).all<WebEntryRow>(...workspace),
    app.db.prepare(`SELECT c.id, c.web_entry_id, c.username, c.password_ciphertext, c.note, c.custom_fields_json, c.sort_order FROM web_credentials c JOIN web_entries w ON w.id = c.web_entry_id JOIN environments e ON e.id = w.environment_id WHERE e.workspace_type = ? AND e.workspace_id = ? ORDER BY c.sort_order, c.username`).all<WebCredentialRow>(...workspace),
    app.db.prepare("SELECT id, environment_id, connection_group_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext, jump_connection_id, options_json, tags_json FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ? ORDER BY name").all<SshRow>(...workspace),
    app.db.prepare("SELECT id, name, algorithm, public_key, fingerprint, private_key_ciphertext FROM ssh_keys WHERE workspace_type = ? AND workspace_id = ? ORDER BY name").all<SshKeyRow>(...workspace),
    app.db.prepare("SELECT id, environment_id, connection_group_id, name, engine, host, port, username, credential_ciphertext, default_database, connection_mode, options_json FROM database_connections WHERE workspace_type = ? AND workspace_id = ? ORDER BY name").all<DatabaseRow>(...workspace),
    app.db.prepare(`SELECT l.id, l.environment_id, l.ssh_connection_id, l.name, l.file_path, l.file_paths_json FROM environment_logs l JOIN environments e ON e.id = l.environment_id WHERE e.workspace_type = ? AND e.workspace_id = ? ORDER BY l.name`).all<LogRow>(...workspace),
    app.db.prepare("SELECT id, type, path FROM connection_groups WHERE workspace_type = ? AND workspace_id = ?").all<ConnectionGroupRow>(...workspace),
    app.db.prepare(`SELECT ce.connection_id, ce.environment_id FROM ssh_connection_environments ce JOIN ssh_connections c ON c.id = ce.connection_id WHERE c.workspace_type = ? AND c.workspace_id = ?`).all<{ connection_id: string; environment_id: string }>(...workspace),
    app.db.prepare(`SELECT ce.connection_id, ce.environment_id FROM database_connection_environments ce JOIN database_connections c ON c.id = ce.connection_id WHERE c.workspace_type = ? AND c.workspace_id = ?`).all<{ connection_id: string; environment_id: string }>(...workspace),
  ]);
  const sshEnvironmentIds = new Map<string, string[]>();
  const databaseEnvironmentIds = new Map<string, string[]>();
  for (const row of sshLinks) sshEnvironmentIds.set(row.connection_id, [...(sshEnvironmentIds.get(row.connection_id) ?? []), row.environment_id]);
  for (const row of databaseLinks) databaseEnvironmentIds.set(row.connection_id, [...(databaseEnvironmentIds.get(row.connection_id) ?? []), row.environment_id]);
  return {
    groups: mapById(groups), environments: mapById(environments), webEntries: mapById(webEntries), webCredentials: mapById(webCredentials),
    sshConnections: mapById(sshConnections), sshKeys: mapById(sshKeys), databaseConnections: mapById(databaseConnections), logs: mapById(logs), connectionGroups: mapById(connectionGroups),
    sshEnvironmentIds, databaseEnvironmentIds,
  };
}

function assertKnownSelection(source: CopySource, selection: CopySelection): void {
  const checks: Array<[string, string[], Map<string, unknown>]> = [
    ["环境组", selection.environmentGroupIds, source.groups], ["环境", selection.environmentIds, source.environments],
    ["SSH 连接", selection.sshConnectionIds, source.sshConnections], ["数据库连接", selection.databaseConnectionIds, source.databaseConnections],
    ["Web 入口", selection.webEntryIds, source.webEntries], ["Web 账号", selection.webCredentialIds, source.webCredentials], ["日志配置", selection.logIds, source.logs],
  ];
  for (const [label, ids, rows] of checks) {
    const unknown = ids.find((id) => !rows.has(id));
    if (unknown) throw new Error(`${label}不属于当前用户的个人空间`);
  }
}

function expandDependencies(source: CopySource, input: CopySelection): { selection: CopySelection; dependencyAdded: ExpandedCopyPlan["dependencyAdded"] } {
  const selection: CopySelection = {
    environmentGroupIds: unique(input.environmentGroupIds), environmentIds: unique(input.environmentIds),
    sshConnectionIds: unique(input.sshConnectionIds), databaseConnectionIds: unique(input.databaseConnectionIds),
    webEntryIds: unique(input.webEntryIds), webCredentialIds: unique(input.webCredentialIds), logIds: unique(input.logIds),
  };
  const environmentIds = new Set(selection.environmentIds);
  const webEntryIds = new Set(selection.webEntryIds);
  const sshIds = new Set(selection.sshConnectionIds);
  const dependencyAdded: ExpandedCopyPlan["dependencyAdded"] = [];

  for (const credentialId of selection.webCredentialIds) {
    const credential = source.webCredentials.get(credentialId)!;
    webEntryIds.add(credential.web_entry_id);
  }
  for (const entryId of webEntryIds) environmentIds.add(source.webEntries.get(entryId)!.environment_id);
  for (const logId of selection.logIds) {
    const log = source.logs.get(logId)!;
    environmentIds.add(log.environment_id);
    if (!sshIds.has(log.ssh_connection_id)) {
      sshIds.add(log.ssh_connection_id);
      dependencyAdded.push({ type: "ssh", id: log.ssh_connection_id, name: source.sshConnections.get(log.ssh_connection_id)!.name, reason: `日志配置 ${log.name}` });
    }
  }

  const addSshDependency = (id: string | null | undefined, reason: string) => {
    if (!id || sshIds.has(id)) return;
    const connection = source.sshConnections.get(id);
    if (!connection) throw new Error(`${reason}引用的 SSH 连接不属于个人空间`);
    sshIds.add(id);
    dependencyAdded.push({ type: "ssh", id, name: connection.name, reason });
    addSshDependency(connection.jump_connection_id, `SSH 跳板依赖 ${connection.name}`);
  };
  for (const id of [...sshIds]) addSshDependency(source.sshConnections.get(id)!.jump_connection_id, `SSH 跳板依赖 ${source.sshConnections.get(id)!.name}`);
  for (const databaseId of selection.databaseConnectionIds) {
    const database = source.databaseConnections.get(databaseId)!;
    const tunnelId = String(parseJsonObject(database.options_json).sshConnectionId ?? "");
    addSshDependency(tunnelId || null, `数据库 SSH Tunnel ${database.name}`);
  }

  selection.environmentIds = [...environmentIds];
  selection.webEntryIds = [...webEntryIds];
  selection.sshConnectionIds = [...sshIds];
  return { selection, dependencyAdded };
}

async function conflictCandidates(app: FastifyInstance, source: CopySource, selection: CopySelection, organizationId: string): Promise<CopyConflict[]> {
  const workspace = ["organization", organizationId];
  const conflicts: CopyConflict[] = [];
  const add = (kind: ResourceKind, sourceId: string, sourceName: string, rows: ConflictCandidate[]) => {
    if (rows.length) conflicts.push({ kind, sourceId, sourceName, candidates: rows });
  };
  for (const id of selection.environmentGroupIds) {
    const row = source.groups.get(id)!;
    add("environment_group", id, row.name, await app.db.prepare("SELECT id, name AS label, '环境组' AS context FROM environment_groups WHERE workspace_type = ? AND workspace_id = ? AND name = ? COLLATE NOCASE").all<ConflictCandidate>(...workspace, row.name));
  }
  for (const id of selection.environmentIds) {
    const row = source.environments.get(id)!;
    add("environment", id, row.name, await app.db.prepare("SELECT id, name AS label, '环境' AS context FROM environments WHERE workspace_type = ? AND workspace_id = ? AND name = ? COLLATE NOCASE").all<ConflictCandidate>(...workspace, row.name));
  }
  for (const id of selection.sshConnectionIds) {
    const row = source.sshConnections.get(id)!;
    const candidates = await app.db.prepare("SELECT id, name, host, port FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ? AND host = ? AND port = ? AND username = ?").all<{ id: string; name: string; host: string; port: number }>(...workspace, row.host, row.port, row.username);
    add("ssh_connection", id, row.name, candidates.map((item) => ({ id: item.id, label: item.name, context: `${item.host}:${item.port}` })));
  }
  for (const id of selection.databaseConnectionIds) {
    const row = source.databaseConnections.get(id)!;
    const candidates = await app.db.prepare("SELECT id, name, host, port FROM database_connections WHERE workspace_type = ? AND workspace_id = ? AND engine = ? AND host = ? AND port = ? AND username = ?").all<{ id: string; name: string; host: string; port: number }>(...workspace, row.engine, row.host, row.port, row.username);
    add("database_connection", id, row.name, candidates.map((item) => ({ id: item.id, label: item.name, context: `${item.host}:${item.port}` })));
  }
  for (const id of selection.webEntryIds) {
    const row = source.webEntries.get(id)!;
    const candidates = await app.db.prepare(`SELECT w.id, w.name AS label, e.name AS context FROM web_entries w JOIN environments e ON e.id = w.environment_id WHERE e.workspace_type = ? AND e.workspace_id = ? AND w.url = ?`).all<ConflictCandidate>(...workspace, row.url);
    add("web_entry", id, row.name, candidates);
  }
  for (const id of selection.webCredentialIds) {
    const row = source.webCredentials.get(id)!;
    const sourceEntry = source.webEntries.get(row.web_entry_id)!;
    const candidates = await app.db.prepare(`SELECT c.id, c.username AS label, w.name AS context FROM web_credentials c JOIN web_entries w ON w.id = c.web_entry_id JOIN environments e ON e.id = w.environment_id WHERE e.workspace_type = ? AND e.workspace_id = ? AND w.url = ? AND c.username = ?`).all<ConflictCandidate>(...workspace, sourceEntry.url, row.username);
    add("web_credential", id, row.username, candidates);
  }
  for (const id of selection.logIds) {
    const row = source.logs.get(id)!;
    const candidates = await app.db.prepare(`SELECT l.id, l.name AS label, e.name AS context FROM environment_logs l JOIN environments e ON e.id = l.environment_id WHERE e.workspace_type = ? AND e.workspace_id = ? AND l.file_path = ?`).all<ConflictCandidate>(...workspace, row.file_path);
    add("environment_log", id, row.name, candidates);
  }
  return conflicts;
}

async function buildPlan(app: FastifyInstance, userId: string, organizationId: string, requested: CopySelection): Promise<{ source: CopySource; plan: ExpandedCopyPlan }> {
  const source = await loadSource(app, userId);
  assertKnownSelection(source, requested);
  const expanded = expandDependencies(source, requested);
  const conflicts = await conflictCandidates(app, source, expanded.selection, organizationId);
  return {
    source,
    plan: {
      ...expanded,
      conflicts,
      secretCount: new Set(expanded.selection.sshConnectionIds.map((id) => {
        const connection = source.sshConnections.get(id)!;
        return connection.ssh_key_id ? `ssh-key:${connection.ssh_key_id}` : `ssh-connection:${id}`;
      })).size + expanded.selection.databaseConnectionIds.length + expanded.selection.webCredentialIds.length,
    },
  };
}

async function nextCopyName(app: FastifyInstance, table: string, workspace: ["organization", string], baseName: string): Promise<string> {
  const exists = async (name: string) => Boolean(await app.db.prepare(`SELECT 1 FROM ${table} WHERE workspace_type = ? AND workspace_id = ? AND name = ? COLLATE NOCASE`).get(...workspace, name));
  if (!await exists(baseName)) return baseName;
  if (!await exists(`${baseName} 副本`)) return `${baseName} 副本`;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${baseName} 副本 ${index}`;
    if (!await exists(candidate)) return candidate;
  }
  throw new Error(`无法为 ${baseName} 生成可用名称`);
}

function allowedReuse(plan: ExpandedCopyPlan): Map<string, { kind: ResourceKind; candidateIds: Set<string> }> {
  return new Map(plan.conflicts.map((conflict) => [conflict.sourceId, { kind: conflict.kind, candidateIds: new Set(conflict.candidates.map((item) => item.id)) }]));
}

async function validateGrantees(app: FastifyInstance, organizationId: string, grantees: Array<{ type: "user" | "project"; id: string }>): Promise<void> {
  for (const grantee of grantees) {
    const exists = grantee.type === "user"
      ? await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(organizationId, grantee.id)
      : await app.db.prepare("SELECT 1 FROM projects WHERE organization_id = ? AND id = ?").get(organizationId, grantee.id);
    if (!exists) throw new Error("授权对象不属于当前组织");
  }
}

async function executeCopy(
  app: FastifyInstance,
  request: FastifyRequest,
  source: CopySource,
  plan: ExpandedCopyPlan,
  reuse: Record<string, string>,
  grantees: Array<{ type: "user" | "project"; id: string }>,
) {
  const organizationId = request.admin!.workspace.id;
  const workspace: ["organization", string] = ["organization", organizationId];
  const permittedReuse = allowedReuse(plan);
  for (const [sourceId, targetId] of Object.entries(reuse)) {
    if (!permittedReuse.get(sourceId)?.candidateIds.has(targetId)) throw new Error("复用目标不属于当前冲突候选");
  }
  await validateGrantees(app, organizationId, grantees);

  const groupMap = new Map<string, string>();
  const environmentMap = new Map<string, string>();
  const sshMap = new Map<string, string>();
  const sshKeyMap = new Map<string, string>();
  const databaseMap = new Map<string, string>();
  const webEntryMap = new Map<string, string>();
  const webCredentialMap = new Map<string, string>();
  const logMap = new Map<string, string>();
  const reusedIds = new Set(Object.keys(reuse));
  const now = new Date().toISOString();

  const copy = app.db.transaction(async () => {
    for (const sourceId of plan.selection.environmentGroupIds) {
      const row = source.groups.get(sourceId)!;
      const targetId = reuse[sourceId] ?? randomUUID();
      groupMap.set(sourceId, targetId);
      if (reuse[sourceId]) continue;
      const name = await nextCopyName(app, "environment_groups", workspace, row.name);
      await app.db.prepare(`INSERT INTO environment_groups (id, workspace_type, workspace_id, name, description, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, ...workspace, name, row.description, row.color, row.sort_order, now, now);
    }

    for (const sourceId of plan.selection.environmentIds) {
      const row = source.environments.get(sourceId)!;
      const targetId = reuse[sourceId] ?? randomUUID();
      environmentMap.set(sourceId, targetId);
      if (reuse[sourceId]) {
        const target = await app.db.prepare("SELECT group_id FROM environments WHERE id = ?").get<{ group_id: string | null }>(targetId);
        const expectedGroupId = row.group_id ? groupMap.get(row.group_id) : undefined;
        if (expectedGroupId && target?.group_id !== expectedGroupId) throw new Error(`环境 ${row.name} 的复用目标不在对应环境组中`);
        continue;
      }
      const name = await nextCopyName(app, "environments", workspace, row.name);
      await app.db.prepare(`INSERT INTO environments (id, workspace_type, workspace_id, group_id, name, short_name, description, status, owner, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, ...workspace, row.group_id ? groupMap.get(row.group_id) ?? null : null, name, row.short_name, row.description, row.status, row.owner, row.tags_json, now, now);
    }

    const ensureSshKey = async (sourceId: string): Promise<string> => {
      const mapped = sshKeyMap.get(sourceId);
      if (mapped) return mapped;
      const row = source.sshKeys.get(sourceId);
      if (!row) throw new Error("SSH 连接关联的个人密钥不存在");
      const existing = await app.db.prepare(`SELECT id FROM ssh_keys WHERE workspace_type = ? AND workspace_id = ? AND fingerprint = ? ORDER BY created_at LIMIT 1`)
        .get<{ id: string }>(...workspace, row.fingerprint);
      if (existing) {
        sshKeyMap.set(sourceId, existing.id);
        return existing.id;
      }
      const targetId = randomUUID();
      const name = await nextCopyName(app, "ssh_keys", workspace, row.name);
      await app.db.prepare(`INSERT INTO ssh_keys (id, workspace_type, workspace_id, name, algorithm, public_key, fingerprint, private_key_ciphertext, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, ...workspace, name, row.algorithm, row.public_key, row.fingerprint, reencrypt(app, row.private_key_ciphertext), request.admin!.id, now, now);
      sshKeyMap.set(sourceId, targetId);
      return targetId;
    };

    const ensureSsh = async (sourceId: string): Promise<string> => {
      const mapped = sshMap.get(sourceId);
      if (mapped) return mapped;
      const row = source.sshConnections.get(sourceId)!;
      const targetId = reuse[sourceId] ?? randomUUID();
      sshMap.set(sourceId, targetId);
      if (reuse[sourceId]) return targetId;
      const jumpId = row.jump_connection_id ? await ensureSsh(row.jump_connection_id) : null;
      const groupPath = row.connection_group_id ? source.connectionGroups.get(row.connection_group_id)?.path : "";
      const connectionGroupId = groupPath ? await ensureConnectionGroup(app, "ssh", groupPath.split("/"), workspace) : null;
      const name = await nextCopyName(app, "ssh_connections", workspace, row.name);
      const sshKeyId = row.ssh_key_id ? await ensureSshKey(row.ssh_key_id) : null;
      await app.db.prepare(`INSERT INTO ssh_connections (id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, source_item_id, source_path, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext, jump_connection_id, options_json, tags_json, source_deleted, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(targetId, ...workspace, connectionGroupId, name, row.host, row.port, row.username, row.auth_type, sshKeyId, reencrypt(app, row.credential_ciphertext), jumpId, row.options_json, row.tags_json, now, now);
      return targetId;
    };
    for (const sourceId of plan.selection.sshConnectionIds) await ensureSsh(sourceId);

    for (const sourceId of plan.selection.databaseConnectionIds) {
      const row = source.databaseConnections.get(sourceId)!;
      const targetId = reuse[sourceId] ?? randomUUID();
      databaseMap.set(sourceId, targetId);
      if (reuse[sourceId]) continue;
      const options = parseJsonObject(row.options_json);
      const tunnelId = typeof options.sshConnectionId === "string" ? options.sshConnectionId : "";
      if (tunnelId) options.sshConnectionId = sshMap.get(tunnelId) ?? null;
      const groupPath = row.connection_group_id ? source.connectionGroups.get(row.connection_group_id)?.path : "";
      const connectionGroupId = groupPath ? await ensureConnectionGroup(app, "database", groupPath.split("/"), workspace) : null;
      const name = await nextCopyName(app, "database_connections", workspace, row.name);
      await app.db.prepare(`INSERT INTO database_connections (id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, source_item_id, source_path, name, engine, host, port, username, credential_ciphertext, default_database, connection_mode, options_json, source_deleted, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(targetId, ...workspace, connectionGroupId, name, row.engine, row.host, row.port, row.username, reencrypt(app, row.credential_ciphertext), row.default_database, row.connection_mode, JSON.stringify(options), now, now);
    }

    for (const [sourceId, targetId] of sshMap) {
      for (const sourceEnvironmentId of source.sshEnvironmentIds.get(sourceId) ?? []) {
        await addConnectionEnvironment(app.db, "ssh", targetId, environmentMap.get(sourceEnvironmentId) ?? null);
      }
    }
    for (const [sourceId, targetId] of databaseMap) {
      for (const sourceEnvironmentId of source.databaseEnvironmentIds.get(sourceId) ?? []) {
        await addConnectionEnvironment(app.db, "database", targetId, environmentMap.get(sourceEnvironmentId) ?? null);
      }
    }

    for (const sourceId of plan.selection.webEntryIds) {
      const row = source.webEntries.get(sourceId)!;
      const environmentId = environmentMap.get(row.environment_id);
      if (!environmentId) throw new Error(`Web 入口 ${row.name} 缺少目标环境`);
      const targetId = reuse[sourceId] ?? randomUUID();
      webEntryMap.set(sourceId, targetId);
      if (reuse[sourceId]) {
        const target = await app.db.prepare("SELECT environment_id FROM web_entries WHERE id = ?").get<{ environment_id: string }>(targetId);
        if (target?.environment_id !== environmentId) throw new Error(`Web 入口 ${row.name} 的复用目标不在对应环境中`);
        continue;
      }
      await app.db.prepare(`INSERT INTO web_entries (id, environment_id, name, url, description, tags_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, environmentId, row.name, row.url, row.description, row.tags_json, row.sort_order, now, now);
    }

    for (const sourceId of plan.selection.webCredentialIds) {
      const row = source.webCredentials.get(sourceId)!;
      const webEntryId = webEntryMap.get(row.web_entry_id);
      if (!webEntryId) throw new Error(`Web 账号 ${row.username} 缺少目标入口`);
      const targetId = reuse[sourceId] ?? randomUUID();
      webCredentialMap.set(sourceId, targetId);
      if (reuse[sourceId]) {
        const target = await app.db.prepare("SELECT web_entry_id FROM web_credentials WHERE id = ?").get<{ web_entry_id: string }>(targetId);
        if (target?.web_entry_id !== webEntryId) throw new Error(`Web 账号 ${row.username} 的复用目标不在对应入口中`);
        continue;
      }
      await app.db.prepare(`INSERT INTO web_credentials (id, web_entry_id, username, password_ciphertext, note, custom_fields_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, webEntryId, row.username, reencrypt(app, row.password_ciphertext), row.note, row.custom_fields_json, row.sort_order, now, now);
    }

    for (const sourceId of plan.selection.logIds) {
      const row = source.logs.get(sourceId)!;
      const environmentId = environmentMap.get(row.environment_id);
      const sshConnectionId = sshMap.get(row.ssh_connection_id);
      if (!environmentId || !sshConnectionId) throw new Error(`日志配置 ${row.name} 缺少目标环境或 SSH 连接`);
      const targetId = reuse[sourceId] ?? randomUUID();
      logMap.set(sourceId, targetId);
      if (reuse[sourceId]) {
        const target = await app.db.prepare("SELECT environment_id, ssh_connection_id FROM environment_logs WHERE id = ?").get<{ environment_id: string; ssh_connection_id: string }>(targetId);
        if (target?.environment_id !== environmentId || target.ssh_connection_id !== sshConnectionId) throw new Error(`日志配置 ${row.name} 的复用目标依赖不一致`);
        continue;
      }
      await app.db.prepare(`INSERT INTO environment_logs (id, environment_id, ssh_connection_id, name, file_path, file_paths_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, environmentId, sshConnectionId, row.name, row.file_path, row.file_paths_json, now, now);
    }

    const coveredEnvironmentIds = new Set<string>();
    for (const sourceId of plan.selection.environmentIds) {
      const row = source.environments.get(sourceId)!;
      if (row.group_id && groupMap.has(row.group_id)) coveredEnvironmentIds.add(sourceId);
    }
    const coveredSshIds = new Set<string>();
    const coveredDatabaseIds = new Set<string>();
    const dependencySshIds = new Set(plan.dependencyAdded.map((item) => item.id));
    for (const sourceId of plan.selection.sshConnectionIds) {
      if ((source.sshEnvironmentIds.get(sourceId) ?? []).some((id) => environmentMap.has(id))) coveredSshIds.add(sourceId);
    }
    for (const sourceId of plan.selection.databaseConnectionIds) {
      if ((source.databaseEnvironmentIds.get(sourceId) ?? []).some((id) => environmentMap.has(id))) coveredDatabaseIds.add(sourceId);
    }
    const grantTargets: Array<{ type: "environment_group" | "environment" | "ssh_connection" | "database_connection"; id: string }> = [
      ...[...groupMap.values()].map((id) => ({ type: "environment_group" as const, id })),
      ...[...environmentMap].filter(([sourceId]) => !coveredEnvironmentIds.has(sourceId)).map(([, id]) => ({ type: "environment" as const, id })),
      ...[...sshMap].filter(([sourceId]) => !coveredSshIds.has(sourceId) && !dependencySshIds.has(sourceId)).map(([, id]) => ({ type: "ssh_connection" as const, id })),
      ...[...databaseMap].filter(([sourceId]) => !coveredDatabaseIds.has(sourceId)).map(([, id]) => ({ type: "database_connection" as const, id })),
    ];
    let grantCount = 0;
    for (const grantee of grantees) {
      for (const target of grantTargets) {
        const inserted = await app.db.prepare(`INSERT OR IGNORE INTO resource_grants (id, organization_id, grantee_type, grantee_id, resource_type, resource_id, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), organizationId, grantee.type, grantee.id, target.type, target.id, request.admin!.id, now);
        grantCount += inserted.changes;
      }
    }

    const counts = {
      environmentGroups: groupMap.size, environments: environmentMap.size, sshKeys: sshKeyMap.size, sshConnections: sshMap.size, databaseConnections: databaseMap.size,
      webEntries: webEntryMap.size, webCredentials: webCredentialMap.size, logs: logMap.size, grants: grantCount,
    };
    await writeAudit(app.db, {
      action: "connection_resources.copied_to_organization",
      resourceType: "organization",
      resourceId: organizationId,
      summary: `从个人空间复制 ${Object.values(counts).reduce((sum, value) => sum + value, 0)} 项资源`,
      details: { counts, reused: reusedIds.size, grantees },
      request,
    });
    return { counts, reused: reusedIds.size };
  });
  return await copy();
}

export async function registerConnectionCopyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/v1/connection-copy/catalog", async (request, reply) => {
    if (!requireOrganizationAdmin(request, reply)) return;
    const source = await loadSource(app, request.admin!.id);
    const organizationId = request.admin!.workspace.id;
    const [members, projects] = await Promise.all([
      app.db.prepare(`SELECT u.id, u.username AS name FROM organization_members m JOIN admin_users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role = 'member' AND u.status = 'active' ORDER BY u.username COLLATE NOCASE`).all<{ id: string; name: string }>(organizationId),
      app.db.prepare("SELECT id, name FROM projects WHERE organization_id = ? ORDER BY name COLLATE NOCASE").all<{ id: string; name: string }>(organizationId),
    ]);
    return {
      environmentGroups: [...source.groups.values()].map((row) => ({ id: row.id, name: row.name, description: row.description, color: row.color })),
      environments: [...source.environments.values()].map((row) => ({ id: row.id, groupId: row.group_id, name: row.name, description: row.description, status: row.status })),
      webEntries: [...source.webEntries.values()].map((row) => ({ id: row.id, environmentId: row.environment_id, name: row.name, url: row.url })),
      webCredentials: [...source.webCredentials.values()].map((row) => ({ id: row.id, webEntryId: row.web_entry_id, username: row.username, note: row.note })),
      sshConnections: [...source.sshConnections.values()].map((row) => ({ id: row.id, name: row.name, host: row.host, port: Number(row.port), username: row.username, environmentIds: source.sshEnvironmentIds.get(row.id) ?? [], jumpConnectionId: row.jump_connection_id, connectionGroupPath: row.connection_group_id ? source.connectionGroups.get(row.connection_group_id)?.path ?? "" : "" })),
      databaseConnections: [...source.databaseConnections.values()].map((row) => ({ id: row.id, name: row.name, engine: row.engine, host: row.host, port: Number(row.port), username: row.username, environmentIds: source.databaseEnvironmentIds.get(row.id) ?? [], sshConnectionId: String(parseJsonObject(row.options_json).sshConnectionId ?? ""), connectionGroupPath: row.connection_group_id ? source.connectionGroups.get(row.connection_group_id)?.path ?? "" : "" })),
      logs: [...source.logs.values()].map((row) => ({ id: row.id, environmentId: row.environment_id, sshConnectionId: row.ssh_connection_id, name: row.name, filePaths: parseStoredLogFilePaths(row.file_paths_json, row.file_path) })),
      grantees: [...members.map((item) => ({ ...item, type: "user" as const })), ...projects.map((item) => ({ ...item, type: "project" as const }))],
    };
  });

  app.post("/api/v1/connection-copy/preview", async (request, reply) => {
    if (!requireOrganizationAdmin(request, reply)) return;
    const body = parseBody(previewSchema, request.body, reply);
    if (!body) return;
    try {
      const { plan } = await buildPlan(app, request.admin!.id, request.admin!.workspace.id, body.selection);
      return { selection: plan.selection, dependencyAdded: plan.dependencyAdded, conflicts: plan.conflicts, secretCount: plan.secretCount };
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_COPY_SELECTION", message: error instanceof Error ? error.message : "复制选择无效" });
    }
  });

  app.post("/api/v1/connection-copy", async (request, reply) => {
    if (!requireOrganizationAdmin(request, reply)) return;
    const body = parseBody(commitSchema, request.body, reply);
    if (!body) return;
    try {
      const { source, plan } = await buildPlan(app, request.admin!.id, request.admin!.workspace.id, body.selection);
      const result = await executeCopy(app, request, source, plan, body.reuse, body.grantees);
      return reply.code(201).send(result);
    } catch (error) {
      return reply.code(400).send({ error: "COPY_FAILED", message: error instanceof Error ? error.message : "连接资源复制失败" });
    }
  });
}
