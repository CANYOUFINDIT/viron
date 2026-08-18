import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WorkspaceType } from "../access-control.js";
import { replaceConnectionEnvironments } from "../connection-environments.js";
import { ensureConnectionGroup, normalizeGroupPath, type ConnectionType } from "../connection-groups.js";
import { inspectSshPrivateKey } from "../ssh/key-store.js";
import { writeAudit } from "../audit.js";
import { revokeWorkspaceRuntime } from "../user-runtime.js";
import { scriptSyncPayloadSchema, type ScriptEnvironmentReference, type ScriptSyncPayload } from "./script-contract.js";
import { executeSandboxedScript } from "./script-runner.js";
import { normalizeDatabaseStorage } from "../database-credentials.js";

export type ScriptConflictStrategy = "overwrite" | "ignore";
export type ScriptSyncAction = "created" | "updated" | "ignored" | "missing";

export interface ScriptSourceConfig {
  script: string;
  conflictStrategy: ScriptConflictStrategy;
}

export interface ScriptSyncReportItem {
  resourceType: string;
  name: string;
  context: string;
  action: ScriptSyncAction;
  matches?: number;
}

export interface ScriptSyncSummary {
  created: number;
  updated: number;
  ignored: number;
  missing: number;
  total: number;
  byResource: Record<string, { created: number; updated: number; ignored: number; missing: number }>;
}

export interface ScriptSyncResult extends ScriptSyncSummary {
  runId: string;
}

interface ScriptSourceRow {
  id: string;
  name: string;
  config_ciphertext: string;
  workspace_type: WorkspaceType;
  workspace_id: string;
}

interface ApplyContext {
  app: FastifyInstance;
  source: ScriptSourceRow;
  payload: ScriptSyncPayload;
  strategy: ScriptConflictStrategy;
  actorUserId: string;
  now: string;
  workspace: [WorkspaceType, string];
  items: ScriptSyncReportItem[];
  environmentIds: Map<string, string>;
  sshIds: Map<string, string>;
  keyIds: Map<string, string>;
}

const runningScriptSources = new Set<string>();

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function reportUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "Web 地址";
  }
}

function environmentKey(reference: { group: string | null; name: string }): string {
  return `${normalized(reference.group ?? "")}\0${normalized(reference.name)}`;
}

function addReport(context: ApplyContext, resourceType: string, name: string, itemContext: string, action: ScriptSyncAction, matches?: number): void {
  context.items.push({ resourceType, name, context: itemContext, action, ...(matches && matches > 1 ? { matches } : {}) });
}

function assertUnique<T>(rows: T[], key: (row: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) throw new Error(`脚本输出包含重复${label}：${value.replaceAll("\0", " / ")}`);
    seen.add(value);
  }
}

function validatePayloadNames(payload: ScriptSyncPayload): void {
  assertUnique(payload.environmentGroups, (row) => normalized(row.name), "环境组");
  assertUnique(payload.environments, environmentKey, "环境");
  assertUnique(payload.webEntries, (row) => `${environmentKey(row.environment)}\0${normalized(row.name)}`, "Web 入口");
  for (const entry of payload.webEntries) assertUnique(entry.credentials, (row) => normalized(row.username), `Web 账号（${entry.name}）`);
  assertUnique(payload.connectionGroups, (row) => `${row.type}\0${normalized(normalizeGroupPath([row.path]).join("/"))}`, "连接组");
  assertUnique(payload.sshKeys, (row) => normalized(row.name), "SSH 密钥");
  assertUnique(payload.sshConnections, (row) => normalized(row.name), "SSH 连接");
  assertUnique(payload.databaseConnections, (row) => normalized(row.name), "数据库连接");
  for (const connection of payload.databaseConnections) assertUnique(connection.profiles, (row) => normalized(row.name), `数据库配置档（${connection.name}）`);
  assertUnique(payload.redisConnections, (row) => normalized(row.name), "Redis 连接");
  assertUnique(payload.environmentLogs, (row) => `${environmentKey(row.environment)}\0${normalized(row.name)}`, "日志配置");
}

export function parseScriptSyncOutput(stdout: string): ScriptSyncPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new Error("脚本标准输出必须是单个有效 JSON 对象", { cause: error });
  }
  const parsed = scriptSyncPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；");
    throw new Error(`脚本输出格式无效：${issues}`);
  }
  validatePayloadNames(parsed.data);
  return parsed.data;
}

async function environmentIdFor(context: ApplyContext, reference: ScriptEnvironmentReference): Promise<string> {
  const key = environmentKey(reference);
  const cached = context.environmentIds.get(key);
  if (cached) return cached;
  const rows = reference.group
    ? await context.app.db.prepare(`
      SELECT e.id FROM environments e JOIN environment_groups g ON g.id = e.group_id
      WHERE e.workspace_type = ? AND e.workspace_id = ? AND LOWER(e.name) = LOWER(?) AND LOWER(g.name) = LOWER(?)
      ORDER BY e.created_at
    `).all(...context.workspace, reference.name, reference.group) as Array<{ id: string }>
    : await context.app.db.prepare(`
      SELECT e.id FROM environments e
      WHERE e.workspace_type = ? AND e.workspace_id = ? AND e.group_id IS NULL AND LOWER(e.name) = LOWER(?)
      ORDER BY e.created_at
    `).all(...context.workspace, reference.name) as Array<{ id: string }>;
  if (!rows.length) throw new Error(`找不到环境：${reference.group ? `${reference.group} / ` : ""}${reference.name}`);
  context.environmentIds.set(key, rows[0].id);
  return rows[0].id;
}

async function sshIdsForName(context: ApplyContext, name: string): Promise<string[]> {
  const rows = await context.app.db.prepare(`
    SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at
  `).all(...context.workspace, name) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function sshIdForName(context: ApplyContext, name: string | null): Promise<string | null> {
  if (!name) return null;
  const cached = context.sshIds.get(normalized(name));
  if (cached) return cached;
  const ids = await sshIdsForName(context, name);
  if (!ids.length) throw new Error(`找不到 SSH 连接：${name}`);
  context.sshIds.set(normalized(name), ids[0]);
  return ids[0];
}

async function environmentIdsFor(context: ApplyContext, references: ScriptEnvironmentReference[]): Promise<string[]> {
  return Promise.all(references.map((reference) => environmentIdFor(context, reference)));
}

async function syncEnvironmentGroups(context: ApplyContext): Promise<void> {
  for (const row of context.payload.environmentGroups) {
    const matches = await context.app.db.prepare(`SELECT id FROM environment_groups WHERE workspace_type = ? AND workspace_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at`).all(...context.workspace, row.name) as Array<{ id: string }>;
    if (!matches.length) {
      const id = randomUUID();
      const nextOrder = await context.app.db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM environment_groups WHERE workspace_type = ? AND workspace_id = ?
      `).get(...context.workspace) as { next_sort_order: number | string };
      await context.app.db.prepare(`INSERT INTO environment_groups (id, workspace_type, workspace_id, name, description, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ...context.workspace, row.name, row.description, row.color, Number(nextOrder.next_sort_order), context.now, context.now);
      addReport(context, "environment_group", row.name, "", "created");
    } else if (context.strategy === "ignore") {
      addReport(context, "environment_group", row.name, "", "ignored", matches.length);
    } else {
      for (const match of matches) await context.app.db.prepare("UPDATE environment_groups SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?").run(row.name, row.description, row.color, context.now, match.id);
      addReport(context, "environment_group", row.name, "", "updated", matches.length);
    }
  }
}

async function syncEnvironments(context: ApplyContext): Promise<void> {
  for (const row of context.payload.environments) {
    const group = row.group
      ? await context.app.db.prepare(`SELECT id FROM environment_groups WHERE workspace_type = ? AND workspace_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at LIMIT 1`).get(...context.workspace, row.group) as { id: string } | undefined
      : undefined;
    if (row.group && !group) throw new Error(`环境 ${row.name} 引用了不存在的环境组：${row.group}`);
    const matches = group
      ? await context.app.db.prepare(`SELECT id FROM environments WHERE workspace_type = ? AND workspace_id = ? AND group_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at`).all(...context.workspace, group.id, row.name) as Array<{ id: string }>
      : await context.app.db.prepare(`SELECT id FROM environments WHERE workspace_type = ? AND workspace_id = ? AND group_id IS NULL AND LOWER(name) = LOWER(?) ORDER BY created_at`).all(...context.workspace, row.name) as Array<{ id: string }>;
    let id: string;
    if (!matches.length) {
      id = randomUUID();
      const groupFilter = group ? "group_id = ?" : "group_id IS NULL";
      const nextOrder = await context.app.db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM environments WHERE workspace_type = ? AND workspace_id = ? AND ${groupFilter}
      `).get(...context.workspace, ...(group ? [group.id] : [])) as { next_sort_order: number | string };
      await context.app.db.prepare(`INSERT INTO environments (id, workspace_type, workspace_id, group_id, sort_order, name, short_name, description, status, owner, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ...context.workspace, group?.id ?? null, Number(nextOrder.next_sort_order), row.name, row.shortName, row.description, row.status, row.owner, JSON.stringify(row.tags), context.now, context.now);
      addReport(context, "environment", row.name, row.group ?? "未分组", "created");
    } else {
      id = matches[0].id;
      if (context.strategy === "ignore") addReport(context, "environment", row.name, row.group ?? "未分组", "ignored", matches.length);
      else {
        for (const match of matches) await context.app.db.prepare(`UPDATE environments SET group_id = ?, name = ?, short_name = ?, description = ?, status = ?, owner = ?, tags_json = ?, updated_at = ? WHERE id = ?`)
          .run(group?.id ?? null, row.name, row.shortName, row.description, row.status, row.owner, JSON.stringify(row.tags), context.now, match.id);
        addReport(context, "environment", row.name, row.group ?? "未分组", "updated", matches.length);
      }
    }
    context.environmentIds.set(environmentKey(row), id);
  }
}

async function syncConnectionGroups(context: ApplyContext): Promise<void> {
  for (const row of context.payload.connectionGroups) {
    const parts = normalizeGroupPath([row.path]);
    if (!parts.length) throw new Error("连接组路径不能为空");
    const path = parts.join("/");
    const matches = await context.app.db.prepare(`SELECT id FROM connection_groups WHERE workspace_type = ? AND workspace_id = ? AND type = ? AND LOWER(path) = LOWER(?) ORDER BY created_at`).all(...context.workspace, row.type, path) as Array<{ id: string }>;
    if (!matches.length) {
      const missingPaths: string[] = [];
      for (let index = 1; index <= parts.length; index += 1) {
        const prefix = parts.slice(0, index).join("/");
        const exists = await context.app.db.prepare(`SELECT id FROM connection_groups WHERE workspace_type = ? AND workspace_id = ? AND type = ? AND LOWER(path) = LOWER(?) LIMIT 1`).get(...context.workspace, row.type, prefix);
        if (!exists) missingPaths.push(prefix);
      }
      const id = await ensureConnectionGroup(context.app, row.type, parts, context.workspace);
      if (id) await context.app.db.prepare("UPDATE connection_groups SET sort_order = ?, updated_at = ? WHERE id = ?").run(row.sortOrder, context.now, id);
      for (const missingPath of missingPaths) addReport(context, "connection_group", missingPath, row.type, "created");
    } else if (context.strategy === "ignore") addReport(context, "connection_group", path, row.type, "ignored", matches.length);
    else {
      for (const match of matches) await context.app.db.prepare("UPDATE connection_groups SET sort_order = ?, updated_at = ? WHERE id = ?").run(row.sortOrder, context.now, match.id);
      addReport(context, "connection_group", path, row.type, "updated", matches.length);
    }
  }
}

async function syncSshKeys(context: ApplyContext): Promise<void> {
  for (const row of context.payload.sshKeys) {
    const parsed = inspectSshPrivateKey(row.privateKey, row.passphrase);
    const matches = await context.app.db.prepare(`SELECT id FROM ssh_keys WHERE workspace_type = ? AND workspace_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at`).all(...context.workspace, row.name) as Array<{ id: string }>;
    let id: string;
    const encrypted = context.app.secrets.encrypt(JSON.stringify({ privateKey: row.privateKey, passphrase: row.passphrase }));
    if (!matches.length) {
      id = randomUUID();
      await context.app.db.prepare(`INSERT INTO ssh_keys (id, workspace_type, workspace_id, name, algorithm, public_key, fingerprint, private_key_ciphertext, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ...context.workspace, row.name, parsed.algorithm, parsed.publicKey, parsed.fingerprint, encrypted, context.actorUserId, context.now, context.now);
      addReport(context, "ssh_key", row.name, parsed.fingerprint, "created");
    } else {
      id = matches[0].id;
      if (context.strategy === "ignore") addReport(context, "ssh_key", row.name, parsed.fingerprint, "ignored", matches.length);
      else {
        for (const match of matches) await context.app.db.prepare(`UPDATE ssh_keys SET name = ?, algorithm = ?, public_key = ?, fingerprint = ?, private_key_ciphertext = ?, updated_at = ? WHERE id = ?`)
          .run(row.name, parsed.algorithm, parsed.publicKey, parsed.fingerprint, encrypted, context.now, match.id);
        addReport(context, "ssh_key", row.name, parsed.fingerprint, "updated", matches.length);
      }
    }
    context.keyIds.set(normalized(row.name), id);
  }
}

async function sshKeyIdForName(context: ApplyContext, name: string | null): Promise<string | null> {
  if (!name) return null;
  const cached = context.keyIds.get(normalized(name));
  if (cached) return cached;
  const row = await context.app.db.prepare(`SELECT id FROM ssh_keys WHERE workspace_type = ? AND workspace_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at LIMIT 1`).get(...context.workspace, name) as { id: string } | undefined;
  if (!row) throw new Error(`找不到 SSH 密钥：${name}`);
  context.keyIds.set(normalized(name), row.id);
  return row.id;
}

async function syncWebEntries(context: ApplyContext): Promise<void> {
  for (const row of context.payload.webEntries) {
    const environmentId = await environmentIdFor(context, row.environment);
    const matches = await context.app.db.prepare("SELECT id FROM web_entries WHERE environment_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at").all(environmentId, row.name) as Array<{ id: string }>;
    let ids: string[];
    if (!matches.length) {
      const id = randomUUID();
      await context.app.db.prepare(`INSERT INTO web_entries (id, environment_id, name, url, description, tags_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, environmentId, row.name, row.url, row.description, JSON.stringify(row.tags), row.sortOrder, context.now, context.now);
      ids = [id];
      addReport(context, "web_entry", row.name, `${row.environment.group ? `${row.environment.group} / ` : ""}${row.environment.name}`, "created");
    } else {
      ids = matches.map((match) => match.id);
      if (context.strategy === "ignore") addReport(context, "web_entry", row.name, reportUrl(row.url), "ignored", matches.length);
      else {
        for (const match of matches) await context.app.db.prepare("UPDATE web_entries SET name = ?, url = ?, description = ?, tags_json = ?, sort_order = ?, updated_at = ? WHERE id = ?")
          .run(row.name, row.url, row.description, JSON.stringify(row.tags), row.sortOrder, context.now, match.id);
        addReport(context, "web_entry", row.name, reportUrl(row.url), "updated", matches.length);
      }
    }
    for (const entryId of ids) {
      for (const credential of row.credentials) {
        const credentialMatches = await context.app.db.prepare("SELECT id FROM web_credentials WHERE web_entry_id = ? AND LOWER(username) = LOWER(?) ORDER BY created_at").all(entryId, credential.username) as Array<{ id: string }>;
        const encrypted = context.app.secrets.encrypt(credential.password);
        if (!credentialMatches.length) {
          await context.app.db.prepare(`INSERT INTO web_credentials (id, web_entry_id, username, password_ciphertext, note, custom_fields_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), entryId, credential.username, encrypted, credential.note, JSON.stringify(credential.customFields), credential.sortOrder, context.now, context.now);
          addReport(context, "web_credential", credential.username, row.name, "created");
        } else if (context.strategy === "ignore") addReport(context, "web_credential", credential.username, row.name, "ignored", credentialMatches.length);
        else {
          for (const match of credentialMatches) await context.app.db.prepare("UPDATE web_credentials SET username = ?, password_ciphertext = ?, note = ?, custom_fields_json = ?, sort_order = ?, updated_at = ? WHERE id = ?")
            .run(credential.username, encrypted, credential.note, JSON.stringify(credential.customFields), credential.sortOrder, context.now, match.id);
          addReport(context, "web_credential", credential.username, row.name, "updated", credentialMatches.length);
        }
      }
    }
  }
}

async function groupIdForPath(context: ApplyContext, type: ConnectionType, path: string): Promise<string | null> {
  if (!path.trim()) return null;
  const normalizedPath = normalizeGroupPath([path]).join("/");
  const existing = await context.app.db.prepare(`SELECT id FROM connection_groups WHERE workspace_type = ? AND workspace_id = ? AND type = ? AND LOWER(path) = LOWER(?) ORDER BY created_at LIMIT 1`).get(...context.workspace, type, normalizedPath) as { id: string } | undefined;
  if (existing) return existing.id;
  const parts = normalizeGroupPath([path]);
  const missingPaths: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const exists = await context.app.db.prepare(`SELECT id FROM connection_groups WHERE workspace_type = ? AND workspace_id = ? AND type = ? AND LOWER(path) = LOWER(?) LIMIT 1`).get(...context.workspace, type, prefix);
    if (!exists) missingPaths.push(prefix);
  }
  const id = await ensureConnectionGroup(context.app, type, parts, context.workspace);
  for (const missingPath of missingPaths) addReport(context, "connection_group", missingPath, type, "created");
  return id;
}

async function syncSshConnections(context: ApplyContext): Promise<void> {
  const matchedIds = new Map<string, string[]>();
  const ignoredExisting = new Set<string>();
  for (const row of context.payload.sshConnections) {
    const environmentIds = await environmentIdsFor(context, row.environments);
    const connectionGroupId = await groupIdForPath(context, "ssh", row.groupPath);
    const sshKeyId = await sshKeyIdForName(context, row.keyName);
    const matches = await sshIdsForName(context, row.name);
    const credential = context.app.secrets.encrypt(JSON.stringify(row.credential));
    let ids: string[];
    if (!matches.length) {
      const id = randomUUID();
      await context.app.db.prepare(`INSERT INTO ssh_connections (id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext, jump_connection_id, options_json, tags_json, source_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)`)
        .run(id, ...context.workspace, environmentIds[0] ?? null, connectionGroupId, context.source.id, row.name, row.host, row.port, row.username, row.authType, sshKeyId, credential, JSON.stringify(row.options), JSON.stringify(row.tags), context.now, context.now);
      await replaceConnectionEnvironments(context.app.db, "ssh", id, environmentIds);
      ids = [id];
      addReport(context, "ssh_connection", row.name, `${row.username}@${row.host}:${row.port}`, "created");
    } else {
      ids = matches;
      if (context.strategy === "ignore") {
        ignoredExisting.add(normalized(row.name));
        addReport(context, "ssh_connection", row.name, `${row.username}@${row.host}:${row.port}`, "ignored", matches.length);
      }
      else {
        for (const id of matches) {
          await context.app.db.prepare(`UPDATE ssh_connections SET connection_group_id = ?, source_id = ?, source_item_id = NULL, source_path = NULL, name = ?, host = ?, port = ?, username = ?, auth_type = ?, ssh_key_id = ?, credential_ciphertext = ?, options_json = ?, tags_json = ?, source_deleted = 0, updated_at = ? WHERE id = ?`)
            .run(connectionGroupId, context.source.id, row.name, row.host, row.port, row.username, row.authType, sshKeyId, credential, JSON.stringify(row.options), JSON.stringify(row.tags), context.now, id);
          await replaceConnectionEnvironments(context.app.db, "ssh", id, environmentIds);
        }
        addReport(context, "ssh_connection", row.name, `${row.username}@${row.host}:${row.port}`, "updated", matches.length);
      }
    }
    matchedIds.set(normalized(row.name), ids);
    context.sshIds.set(normalized(row.name), ids[0]);
  }
  for (const row of context.payload.sshConnections) {
    if (ignoredExisting.has(normalized(row.name))) continue;
    const jumpId = await sshIdForName(context, row.jumpConnection);
    for (const id of matchedIds.get(normalized(row.name)) ?? []) {
      if (jumpId === id) throw new Error(`SSH 连接不能把自己设为跳板机：${row.name}`);
      await context.app.db.prepare("UPDATE ssh_connections SET jump_connection_id = ? WHERE id = ?").run(jumpId, id);
    }
  }
}

async function syncDatabaseConnections(context: ApplyContext): Promise<void> {
  for (const row of context.payload.databaseConnections) {
    const environmentIds = await environmentIdsFor(context, row.environments);
    const connectionGroupId = await groupIdForPath(context, "database", row.groupPath);
    const sshConnectionId = await sshIdForName(context, row.sshConnection);
    if (row.connectionMode === "sshTunnel" && !sshConnectionId) throw new Error(`数据库连接 ${row.name} 的 SSH Tunnel 缺少 SSH 连接`);
    const storage = normalizeDatabaseStorage({ ...row.options, sshConnectionId }, row.credential);
    const credential = context.app.secrets.encrypt(JSON.stringify(storage.credential));
    const matches = await context.app.db.prepare(`SELECT id FROM database_connections WHERE profile_parent_id IS NULL AND workspace_type = ? AND workspace_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at`).all(...context.workspace, row.name) as Array<{ id: string }>;
    let ids: string[];
    if (!matches.length) {
      const id = randomUUID();
      await context.app.db.prepare(`INSERT INTO database_connections (id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, name, engine, host, port, username, credential_ciphertext, default_database, connection_mode, options_json, source_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(id, ...context.workspace, environmentIds[0] ?? null, connectionGroupId, context.source.id, row.name, row.engine, row.host, row.port, row.username, credential, row.defaultDatabase, row.connectionMode, JSON.stringify(storage.options), context.now, context.now);
      await replaceConnectionEnvironments(context.app.db, "database", id, environmentIds);
      ids = [id];
      addReport(context, "database_connection", row.name, `${row.username}@${row.host}:${row.port}`, "created");
    } else {
      ids = matches.map((match) => match.id);
      if (context.strategy === "ignore") addReport(context, "database_connection", row.name, `${row.username}@${row.host}:${row.port}`, "ignored", matches.length);
      else {
        for (const id of ids) {
          await context.app.db.prepare(`UPDATE database_connections SET connection_group_id = ?, source_id = ?, source_item_id = NULL, source_path = NULL, name = ?, engine = ?, host = ?, port = ?, username = ?, credential_ciphertext = ?, default_database = ?, connection_mode = ?, options_json = ?, source_deleted = 0, updated_at = ? WHERE id = ?`)
            .run(connectionGroupId, context.source.id, row.name, row.engine, row.host, row.port, row.username, credential, row.defaultDatabase, row.connectionMode, JSON.stringify(storage.options), context.now, id);
          await replaceConnectionEnvironments(context.app.db, "database", id, environmentIds);
        }
        addReport(context, "database_connection", row.name, `${row.username}@${row.host}:${row.port}`, "updated", matches.length);
      }
    }
    for (const parentId of ids) {
      for (const profile of row.profiles) {
        const profileMatches = await context.app.db.prepare("SELECT id FROM database_connections WHERE profile_parent_id = ? AND LOWER(profile_name) = LOWER(?) ORDER BY created_at").all(parentId, profile.name) as Array<{ id: string }>;
        const profileSshId = await sshIdForName(context, profile.sshConnection);
        if (profile.connectionMode === "sshTunnel" && !profileSshId) throw new Error(`数据库配置档 ${row.name} / ${profile.name} 缺少 SSH 连接`);
        const profileStorage = normalizeDatabaseStorage({ ...profile.options, sshConnectionId: profileSshId }, profile.credential);
        const profileCredential = context.app.secrets.encrypt(JSON.stringify(profileStorage.credential));
        if (!profileMatches.length) {
          await context.app.db.prepare(`INSERT INTO database_connections (id, profile_parent_id, profile_name, workspace_type, workspace_id, name, engine, host, port, username, credential_ciphertext, default_database, connection_mode, options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), parentId, profile.name, ...context.workspace, row.name, profile.engine, profile.host, profile.port, profile.username, profileCredential, profile.defaultDatabase, profile.connectionMode, JSON.stringify(profileStorage.options), context.now, context.now);
          addReport(context, "database_profile", profile.name, row.name, "created");
        } else if (context.strategy === "ignore") addReport(context, "database_profile", profile.name, row.name, "ignored", profileMatches.length);
        else {
          for (const match of profileMatches) await context.app.db.prepare(`UPDATE database_connections SET profile_name = ?, name = ?, engine = ?, host = ?, port = ?, username = ?, credential_ciphertext = ?, default_database = ?, connection_mode = ?, options_json = ?, updated_at = ? WHERE id = ?`)
            .run(profile.name, row.name, profile.engine, profile.host, profile.port, profile.username, profileCredential, profile.defaultDatabase, profile.connectionMode, JSON.stringify(profileStorage.options), context.now, match.id);
          addReport(context, "database_profile", profile.name, row.name, "updated", profileMatches.length);
        }
      }
    }
  }
}

async function syncRedisConnections(context: ApplyContext): Promise<void> {
  for (const row of context.payload.redisConnections) {
    const environmentIds = await environmentIdsFor(context, row.environments);
    const connectionGroupId = await groupIdForPath(context, "redis", row.groupPath);
    const sshConnectionId = await sshIdForName(context, row.sshConnection);
    if (row.connectionMode === "sshTunnel" && !sshConnectionId) throw new Error(`Redis 连接 ${row.name} 的 SSH Tunnel 缺少 SSH 连接`);
    const options = { ...row.options, sshConnectionId };
    const credential = context.app.secrets.encrypt(JSON.stringify(row.credential));
    const matches = await context.app.db.prepare(`SELECT id FROM redis_connections WHERE workspace_type = ? AND workspace_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at`).all(...context.workspace, row.name) as Array<{ id: string }>;
    if (!matches.length) {
      const id = randomUUID();
      await context.app.db.prepare(`INSERT INTO redis_connections (id, workspace_type, workspace_id, environment_id, connection_group_id, source_id, name, host, port, username, credential_ciphertext, default_database, connection_mode, options_json, source_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(id, ...context.workspace, environmentIds[0] ?? null, connectionGroupId, context.source.id, row.name, row.host, row.port, row.username, credential, row.defaultDatabase, row.connectionMode, JSON.stringify(options), context.now, context.now);
      await replaceConnectionEnvironments(context.app.db, "redis", id, environmentIds);
      addReport(context, "redis_connection", row.name, `${row.host}:${row.port}`, "created");
    } else if (context.strategy === "ignore") addReport(context, "redis_connection", row.name, `${row.host}:${row.port}`, "ignored", matches.length);
    else {
      for (const match of matches) {
        await context.app.db.prepare(`UPDATE redis_connections SET connection_group_id = ?, source_id = ?, source_item_id = NULL, source_path = NULL, name = ?, host = ?, port = ?, username = ?, credential_ciphertext = ?, default_database = ?, connection_mode = ?, options_json = ?, source_deleted = 0, updated_at = ? WHERE id = ?`)
          .run(connectionGroupId, context.source.id, row.name, row.host, row.port, row.username, credential, row.defaultDatabase, row.connectionMode, JSON.stringify(options), context.now, match.id);
        await replaceConnectionEnvironments(context.app.db, "redis", match.id, environmentIds);
      }
      addReport(context, "redis_connection", row.name, `${row.host}:${row.port}`, "updated", matches.length);
    }
  }
}

async function syncEnvironmentLogs(context: ApplyContext): Promise<void> {
  for (const row of context.payload.environmentLogs) {
    const environmentId = await environmentIdFor(context, row.environment);
    const sshConnectionId = await sshIdForName(context, row.sshConnection);
    if (!sshConnectionId) throw new Error(`日志配置 ${row.name} 缺少 SSH 连接`);
    const matches = await context.app.db.prepare("SELECT id FROM environment_logs WHERE environment_id = ? AND LOWER(name) = LOWER(?) ORDER BY created_at").all(environmentId, row.name) as Array<{ id: string }>;
    if (!matches.length) {
      await context.app.db.prepare(`INSERT INTO environment_logs (id, environment_id, ssh_connection_id, name, file_path, file_paths_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), environmentId, sshConnectionId, row.name, row.filePaths[0], JSON.stringify(row.filePaths), context.now, context.now);
      addReport(context, "environment_log", row.name, row.sshConnection, "created");
    } else if (context.strategy === "ignore") addReport(context, "environment_log", row.name, row.sshConnection, "ignored", matches.length);
    else {
      for (const match of matches) await context.app.db.prepare("UPDATE environment_logs SET ssh_connection_id = ?, name = ?, file_path = ?, file_paths_json = ?, updated_at = ? WHERE id = ?")
        .run(sshConnectionId, row.name, row.filePaths[0], JSON.stringify(row.filePaths), context.now, match.id);
      addReport(context, "environment_log", row.name, row.sshConnection, "updated", matches.length);
    }
  }
}

async function recordMissing(context: ApplyContext): Promise<void> {
  const environmentReferences = [
    ...context.payload.environments.map((row) => ({ group: row.group, name: row.name })),
    ...context.payload.webEntries.map((row) => row.environment),
    ...context.payload.sshConnections.flatMap((row) => row.environments),
    ...context.payload.databaseConnections.flatMap((row) => row.environments),
    ...context.payload.redisConnections.flatMap((row) => row.environments),
    ...context.payload.environmentLogs.map((row) => row.environment),
  ];
  const impliedGroups: Array<{ type: ConnectionType; path: string }> = [
    ...context.payload.sshConnections.filter((row) => row.groupPath).map((row) => ({ type: "ssh" as const, path: row.groupPath })),
    ...context.payload.databaseConnections.filter((row) => row.groupPath).map((row) => ({ type: "database" as const, path: row.groupPath })),
    ...context.payload.redisConnections.filter((row) => row.groupPath).map((row) => ({ type: "redis" as const, path: row.groupPath })),
  ];
  const expectedConnectionGroups = new Set<string>();
  for (const row of [...context.payload.connectionGroups, ...impliedGroups]) {
    const parts = normalizeGroupPath([row.path]);
    for (let index = 1; index <= parts.length; index += 1) expectedConnectionGroups.add(`${row.type}\0${normalized(parts.slice(0, index).join("/"))}`);
  }
  const expected = {
    environment_group: new Set([...context.payload.environmentGroups.map((row) => normalized(row.name)), ...environmentReferences.flatMap((row) => row.group ? [normalized(row.group)] : [])]),
    environment: new Set(environmentReferences.map(environmentKey)),
    web_entry: new Set(context.payload.webEntries.map((row) => `${environmentKey(row.environment)}\0${normalized(row.name)}`)),
    web_credential: new Set(context.payload.webEntries.flatMap((entry) => entry.credentials.map((row) => `${environmentKey(entry.environment)}\0${normalized(entry.name)}\0${normalized(row.username)}`))),
    connection_group: expectedConnectionGroups,
    ssh_key: new Set([...context.payload.sshKeys.map((row) => normalized(row.name)), ...context.payload.sshConnections.flatMap((row) => row.keyName ? [normalized(row.keyName)] : [])]),
    ssh_connection: new Set([
      ...context.payload.sshConnections.map((row) => normalized(row.name)),
      ...context.payload.sshConnections.flatMap((row) => row.jumpConnection ? [normalized(row.jumpConnection)] : []),
      ...context.payload.databaseConnections.flatMap((row) => row.sshConnection ? [normalized(row.sshConnection)] : []),
      ...context.payload.databaseConnections.flatMap((row) => row.profiles.flatMap((profile) => profile.sshConnection ? [normalized(profile.sshConnection)] : [])),
      ...context.payload.redisConnections.flatMap((row) => row.sshConnection ? [normalized(row.sshConnection)] : []),
      ...context.payload.environmentLogs.map((row) => normalized(row.sshConnection)),
    ]),
    database_connection: new Set(context.payload.databaseConnections.map((row) => normalized(row.name))),
    database_profile: new Set(context.payload.databaseConnections.flatMap((connection) => connection.profiles.map((row) => `${normalized(connection.name)}\0${normalized(row.name)}`))),
    redis_connection: new Set(context.payload.redisConnections.map((row) => normalized(row.name))),
    environment_log: new Set(context.payload.environmentLogs.map((row) => `${environmentKey(row.environment)}\0${normalized(row.name)}`)),
  };
  const [groups, environments, webEntries, credentials, connectionGroups, keys, ssh, databases, profiles, redis, logs] = await Promise.all([
    context.app.db.prepare("SELECT name FROM environment_groups WHERE workspace_type = ? AND workspace_id = ?").all(...context.workspace) as Promise<Array<{ name: string }>>,
    context.app.db.prepare(`SELECT e.name, g.name AS group_name FROM environments e LEFT JOIN environment_groups g ON g.id = e.group_id WHERE e.workspace_type = ? AND e.workspace_id = ?`).all(...context.workspace) as Promise<Array<{ name: string; group_name: string | null }>>,
    context.app.db.prepare(`SELECT w.name, e.name AS environment_name, g.name AS group_name FROM web_entries w JOIN environments e ON e.id = w.environment_id LEFT JOIN environment_groups g ON g.id = e.group_id WHERE e.workspace_type = ? AND e.workspace_id = ?`).all(...context.workspace) as Promise<Array<{ name: string; environment_name: string; group_name: string | null }>>,
    context.app.db.prepare(`SELECT c.username, w.name AS web_name, e.name AS environment_name, g.name AS group_name FROM web_credentials c JOIN web_entries w ON w.id = c.web_entry_id JOIN environments e ON e.id = w.environment_id LEFT JOIN environment_groups g ON g.id = e.group_id WHERE e.workspace_type = ? AND e.workspace_id = ?`).all(...context.workspace) as Promise<Array<{ username: string; web_name: string; environment_name: string; group_name: string | null }>>,
    context.app.db.prepare("SELECT type, path FROM connection_groups WHERE workspace_type = ? AND workspace_id = ?").all(...context.workspace) as Promise<Array<{ type: string; path: string }>>,
    context.app.db.prepare("SELECT name FROM ssh_keys WHERE workspace_type = ? AND workspace_id = ?").all(...context.workspace) as Promise<Array<{ name: string }>>,
    context.app.db.prepare("SELECT name FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?").all(...context.workspace) as Promise<Array<{ name: string }>>,
    context.app.db.prepare("SELECT name FROM database_connections WHERE profile_parent_id IS NULL AND workspace_type = ? AND workspace_id = ?").all(...context.workspace) as Promise<Array<{ name: string }>>,
    context.app.db.prepare(`SELECT p.profile_name, root.name AS connection_name FROM database_connections p JOIN database_connections root ON root.id = p.profile_parent_id WHERE root.workspace_type = ? AND root.workspace_id = ?`).all(...context.workspace) as Promise<Array<{ profile_name: string; connection_name: string }>>,
    context.app.db.prepare("SELECT name FROM redis_connections WHERE workspace_type = ? AND workspace_id = ?").all(...context.workspace) as Promise<Array<{ name: string }>>,
    context.app.db.prepare(`SELECT l.name, e.name AS environment_name, g.name AS group_name FROM environment_logs l JOIN environments e ON e.id = l.environment_id LEFT JOIN environment_groups g ON g.id = e.group_id WHERE e.workspace_type = ? AND e.workspace_id = ?`).all(...context.workspace) as Promise<Array<{ name: string; environment_name: string; group_name: string | null }>>,
  ]);
  for (const row of groups) if (!expected.environment_group.has(normalized(row.name))) addReport(context, "environment_group", row.name, "", "missing");
  for (const row of environments) if (!expected.environment.has(environmentKey({ group: row.group_name, name: row.name }))) addReport(context, "environment", row.name, row.group_name ?? "未分组", "missing");
  for (const row of webEntries) if (!expected.web_entry.has(`${environmentKey({ group: row.group_name, name: row.environment_name })}\0${normalized(row.name)}`)) addReport(context, "web_entry", row.name, row.environment_name, "missing");
  for (const row of credentials) if (!expected.web_credential.has(`${environmentKey({ group: row.group_name, name: row.environment_name })}\0${normalized(row.web_name)}\0${normalized(row.username)}`)) addReport(context, "web_credential", row.username, row.web_name, "missing");
  for (const row of connectionGroups) if (!expected.connection_group.has(`${row.type}\0${normalized(row.path)}`)) addReport(context, "connection_group", row.path, row.type, "missing");
  for (const row of keys) if (!expected.ssh_key.has(normalized(row.name))) addReport(context, "ssh_key", row.name, "", "missing");
  for (const row of ssh) if (!expected.ssh_connection.has(normalized(row.name))) addReport(context, "ssh_connection", row.name, "", "missing");
  for (const row of databases) if (!expected.database_connection.has(normalized(row.name))) addReport(context, "database_connection", row.name, "", "missing");
  for (const row of profiles) if (!expected.database_profile.has(`${normalized(row.connection_name)}\0${normalized(row.profile_name)}`)) addReport(context, "database_profile", row.profile_name, row.connection_name, "missing");
  for (const row of redis) if (!expected.redis_connection.has(normalized(row.name))) addReport(context, "redis_connection", row.name, "", "missing");
  for (const row of logs) if (!expected.environment_log.has(`${environmentKey({ group: row.group_name, name: row.environment_name })}\0${normalized(row.name)}`)) addReport(context, "environment_log", row.name, row.environment_name, "missing");
}

function summarize(items: ScriptSyncReportItem[]): ScriptSyncSummary {
  const summary: ScriptSyncSummary = { created: 0, updated: 0, ignored: 0, missing: 0, total: items.length, byResource: {} };
  for (const item of items) {
    summary[item.action] += 1;
    summary.byResource[item.resourceType] ??= { created: 0, updated: 0, ignored: 0, missing: 0 };
    summary.byResource[item.resourceType][item.action] += 1;
  }
  return summary;
}

export async function applyScriptSyncPayload(
  app: FastifyInstance,
  source: ScriptSourceRow,
  payload: ScriptSyncPayload,
  strategy: ScriptConflictStrategy,
  actorUserId: string,
  runId?: string,
): Promise<{ summary: ScriptSyncSummary; items: ScriptSyncReportItem[] }> {
  validatePayloadNames(payload);
  const now = new Date().toISOString();
  const context: ApplyContext = {
    app, source, payload, strategy, actorUserId, now,
    workspace: [source.workspace_type, source.workspace_id], items: [], environmentIds: new Map(), sshIds: new Map(), keyIds: new Map(),
  };
  const apply = app.db.transaction(async () => {
    await syncEnvironmentGroups(context);
    await syncEnvironments(context);
    await syncConnectionGroups(context);
    await syncSshKeys(context);
    await syncWebEntries(context);
    await syncSshConnections(context);
    await syncDatabaseConnections(context);
    await syncRedisConnections(context);
    await syncEnvironmentLogs(context);
    await recordMissing(context);
    const summary = summarize(context.items);
    await app.db.prepare("UPDATE connection_sources SET last_synced_at = ?, updated_at = ? WHERE id = ?").run(now, now, source.id);
    if (runId) await app.db.prepare(`UPDATE connection_source_runs SET status = 'success', completed_at = ?, duration_ms = ?, summary_json = ?, items_json = ? WHERE id = ?`)
      .run(now, Math.max(0, Date.now() - Date.parse((await app.db.prepare("SELECT started_at FROM connection_source_runs WHERE id = ?").get(runId) as { started_at: string }).started_at)), JSON.stringify(summary), JSON.stringify(context.items), runId);
    return summary;
  });
  const summary = await apply();
  return { summary, items: context.items };
}

async function syncActorUserId(app: FastifyInstance, source: ScriptSourceRow, request?: FastifyRequest): Promise<string> {
  if (request?.admin?.id) return request.admin.id;
  if (source.workspace_type === "personal") {
    const user = await app.db.prepare("SELECT id FROM admin_users WHERE id = ? AND status = 'active'").get(source.workspace_id) as { id: string } | undefined;
    if (user) return user.id;
  } else {
    const user = await app.db.prepare(`
      SELECT u.id FROM organization_members m JOIN admin_users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND m.role = 'admin' AND u.status = 'active' ORDER BY m.created_at LIMIT 1
    `).get(source.workspace_id) as { id: string } | undefined;
    if (user) return user.id;
  }
  throw new Error("同步空间没有可用于写入资源的有效管理员");
}

async function failRun(app: FastifyInstance, runId: string, startedAt: string, error: unknown): Promise<void> {
  const completedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  await app.db.prepare(`UPDATE connection_source_runs SET status = 'failed', completed_at = ?, duration_ms = ?, error_message = ? WHERE id = ?`)
    .run(completedAt, Math.max(0, Date.now() - Date.parse(startedAt)), message.slice(0, 4000), runId);
}

async function performScriptSync(app: FastifyInstance, sourceId: string, request?: FastifyRequest, trigger: "manual" | "schedule" = request ? "manual" : "schedule"): Promise<ScriptSyncResult> {
  const source = await app.db.prepare("SELECT id, name, config_ciphertext, workspace_type, workspace_id FROM connection_sources WHERE id = ? AND type = 'script_sync'").get(sourceId) as ScriptSourceRow | undefined;
  if (!source) throw new Error("脚本同步源不存在");
  const config = JSON.parse(app.secrets.decrypt(source.config_ciphertext)) as ScriptSourceConfig;
  if (typeof config.script !== "string" || !config.script.trim() || !["overwrite", "ignore"].includes(config.conflictStrategy)) throw new Error("脚本同步源配置无效，请编辑后重新保存");
  const actorUserId = await syncActorUserId(app, source, request);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  await app.db.prepare(`INSERT INTO connection_source_runs (id, source_id, workspace_type, workspace_id, triggered_by_user_id, trigger_type, status, conflict_strategy, started_at, summary_json, items_json, error_message) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, '{}', '[]', '')`)
    .run(runId, source.id, source.workspace_type, source.workspace_id, request?.admin?.id ?? null, trigger, config.conflictStrategy, startedAt);
  let applied: Awaited<ReturnType<typeof applyScriptSyncPayload>>;
  try {
    const execution = await executeSandboxedScript(app.config.scriptRunnerSocket, config.script, app.config.scriptRunnerImage);
    if (execution.exitCode !== 0) throw new Error(`脚本执行失败（退出码 ${execution.exitCode}）；标准错误未保存，请在脚本中自行输出不含凭据的诊断字段`);
    applied = await applyScriptSyncPayload(app, source, parseScriptSyncOutput(execution.stdout), config.conflictStrategy, actorUserId, runId);
  } catch (error) {
    await failRun(app, runId, startedAt, error);
    await writeAudit(app.db, {
      action: "connection_source.sync_failed", resourceType: "connection_source", resourceId: source.id,
      summary: `脚本同步失败 ${source.name}`, details: { runId, message: error instanceof Error ? error.message : String(error) }, request,
      workspaceType: source.workspace_type, workspaceId: source.workspace_id,
    });
    throw error;
  }
  try {
    await revokeWorkspaceRuntime(app, {
      type: source.workspace_type,
      id: source.workspace_id,
      name: source.name,
      role: source.workspace_type === "personal" ? "owner" : "admin",
    });
  } catch (error) {
    app.log.error({ err: error, sourceId: source.id }, "Failed to close workspace runtime after script sync");
  }
  await writeAudit(app.db, {
    action: "connection_source.synced", resourceType: "connection_source", resourceId: source.id,
    summary: `执行脚本同步 ${source.name}`, details: { runId, ...applied.summary }, request,
    workspaceType: source.workspace_type, workspaceId: source.workspace_id,
  });
  return { runId, ...applied.summary };
}

export async function syncScriptSource(app: FastifyInstance, sourceId: string, request?: FastifyRequest, trigger: "manual" | "schedule" = request ? "manual" : "schedule"): Promise<ScriptSyncResult> {
  if (runningScriptSources.has(sourceId)) throw new Error("该同步源正在执行，请等待本轮结束");
  runningScriptSources.add(sourceId);
  try {
    return await performScriptSync(app, sourceId, request, trigger);
  } finally {
    runningScriptSources.delete(sourceId);
  }
}
