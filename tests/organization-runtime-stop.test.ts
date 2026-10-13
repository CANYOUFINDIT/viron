import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const pendingConnects = vi.hoisted(() => [] as Array<(error: Error) => void>);

vi.mock("../src/server/database-workbench/connector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/database-workbench/connector.js")>();
  return {
    ...actual,
    connectDatabase: () => new Promise((_resolve, reject) => {
      pendingConnects.push(reject);
    }),
  };
});

import type { AuthenticatedUser } from "../src/server/access-control.js";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { disconnectGrantees } from "../src/server/access-expiry.js";
import { defaultDataSyncOptions, defaultStructureSyncOptions } from "../src/database-sync.js";
import { DESKTOP_LOCAL_SFTP_CONNECTION_ID, desktopSftpReservation } from "../src/desktop/sftp-runtime.js";
import { refreshOrganizationWebPlugins, webExtensionShortcutEnabled, type WebPluginView } from "../src/desktop/web-plugin-session.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const reject of pendingConnects.splice(0)) reject(new Error("test cleanup"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const finish of cleanup.splice(0)) await finish();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "viron-runtime-stop-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 21),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  cleanup.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies[0].value };
  const registration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "member", password: "member" } });
  const userId = registration.json().user.id as string;
  const memberCookies = { envman_session: registration.cookies[0].value };
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "阶段组织" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, now, now);
  for (const session of [cookies, memberCookies])
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: session, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产", owner: "member" } });
  expect(environment.statusCode, environment.body).toBe(201);
  const env = environment.json().id as string;
  const ssh = await app.inject({
    method: "POST", url: "/api/v1/ssh-connections", cookies,
    payload: { name: "连接A", host: "example.invalid", port: 22, username: "root", authType: "password", password: "fake-password", environmentIds: [env] },
  });
  const other = await app.inject({
    method: "POST", url: "/api/v1/ssh-connections", cookies,
    payload: { name: "连接B", host: "other.invalid", port: 22, username: "root", authType: "password", password: "other-secret", environmentIds: [env] },
  });
  expect(ssh.statusCode, ssh.body).toBe(201);
  expect(other.statusCode, other.body).toBe(201);
  const base = `/api/v1/organizations/${org}`;
  const user: AuthenticatedUser = {
    id: userId,
    username: "member",
    isPlatformAdmin: false,
    workspace: { type: "organization", id: org, name: "阶段组织", role: "member" },
  };
  return { app, db, cookies, memberCookies, org, env, user, userId, base, sshId: ssh.json().id as string, otherId: other.json().id as string };
}

async function grantRole(f: Awaited<ReturnType<typeof fixture>>, name: string, codes: string[], targets: Array<{ type: string; id: string }>) {
  const role = await f.app.inject({ method: "POST", url: f.base + "/roles", cookies: f.cookies, payload: { name, permissionCodes: codes, reason: "测试角色" } });
  expect(role.statusCode, role.body).toBe(201);
  const roleId = role.json().id as string;
  const assignment = await f.app.inject({
    method: "POST", url: f.base + "/role-assignments", cookies: f.cookies,
    payload: { roleId, subjectType: "user", subjectId: f.userId, reason: "分配" },
  });
  expect(assignment.statusCode, assignment.body).toBe(201);
  const grant = await f.app.inject({
    method: "POST", url: f.base + "/role-data-grants", cookies: f.cookies,
    payload: { roleId, targets, reason: "数据范围" },
  });
  expect(grant.statusCode, grant.body).toBe(201);
  return { roleId, assignmentId: assignment.json().id as string };
}

async function revokeAssignment(f: Awaited<ReturnType<typeof fixture>>, assignmentId: string) {
  const response = await f.app.inject({
    method: "DELETE", url: `${f.base}/role-assignments/${assignmentId}`, cookies: f.cookies, payload: { reason: "撤销" },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function assignRole(f: Awaited<ReturnType<typeof fixture>>, roleId: string) {
  const response = await f.app.inject({
    method: "POST", url: f.base + "/role-assignments", cookies: f.cookies,
    payload: { roleId, subjectType: "user", subjectId: f.userId, reason: "恢复" },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

async function watchConnection(f: Awaited<ReturnType<typeof fixture>>, input: {
  type: "ssh" | "sftp" | "web";
  resourceId: string;
  relatedResourceId?: string;
  sftpAction?: "download" | "upload";
}) {
  const id = randomUUID();
  const reasons: string[] = [];
  await f.app.activeConnections.reserve({ id, user: f.user, ...input });
  f.app.activeConnections.activate(id, (reason) => { reasons.push(reason); });
  return { id, reasons };
}

function live(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return f.app.activeConnections.inspect().some((entry) => entry.id === id);
}

describe("runtime authorization stop", () => {
  it("stops a live SFTP transfer when source download or target upload is revoked", async () => {
    const f = await fixture();
    const use = await grantRole(f, "终端", ["ssh.use"], [{ type: "ssh_connection", id: f.sshId }, { type: "ssh_connection", id: f.otherId }]);
    const download = await grantRole(f, "下载", ["ssh.download"], [{ type: "ssh_connection", id: f.sshId }]);
    const upload = await grantRole(f, "上传", ["ssh.upload"], [{ type: "ssh_connection", id: f.otherId }]);
    const scope = randomUUID();
    const reserve = (payload: Record<string, unknown>) => f.app.inject({
      method: "POST",
      url: "/api/v1/active-connections/desktop",
      cookies: f.memberCookies,
      headers: { "x-viron-execution-scope": scope },
      payload,
    });
    expect((await reserve({ id: randomUUID(), type: "sftp", resourceId: f.sshId, relatedResourceId: f.otherId })).statusCode).toBe(201);
    const ssh = await watchConnection(f, { type: "ssh", resourceId: f.sshId });
    const transfer = await watchConnection(f, { type: "sftp", resourceId: f.sshId, relatedResourceId: f.otherId });
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(transfer.reasons).toEqual([]);
    expect(ssh.reasons).toEqual([]);
    expect(live(f, transfer.id)).toBe(true);
    expect(live(f, ssh.id)).toBe(true);

    await revokeAssignment(f, upload.assignmentId);
    expect((await reserve({ id: randomUUID(), type: "sftp", resourceId: f.sshId, relatedResourceId: f.otherId })).statusCode).toBe(404);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(transfer.reasons).toEqual(["授权已到期"]);
    expect(live(f, transfer.id)).toBe(false);
    expect(ssh.reasons).toEqual([]);

    const restoredUpload = await assignRole(f, upload.roleId);
    const afterUpload = await watchConnection(f, { type: "sftp", resourceId: f.sshId, relatedResourceId: f.otherId });
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(afterUpload.reasons).toEqual([]);
    await revokeAssignment(f, download.assignmentId);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(afterUpload.reasons).toEqual(["授权已到期"]);
    expect(ssh.reasons).toEqual([]);

    await assignRole(f, download.roleId);
    const kept = await watchConnection(f, { type: "sftp", resourceId: f.sshId, relatedResourceId: f.otherId });
    await revokeAssignment(f, use.assignmentId);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(kept.reasons).toEqual([]);
    expect(live(f, kept.id)).toBe(true);
    expect(ssh.reasons).toEqual(["授权已到期"]);
    expect(live(f, ssh.id)).toBe(false);
    expect(restoredUpload).toBeTruthy();
  });

  it("uses the one-sided upload or download action for a desktop transfer", async () => {
    const f = await fixture();
    expect(desktopSftpReservation(DESKTOP_LOCAL_SFTP_CONNECTION_ID, f.otherId)).toEqual({ resourceId: f.otherId, sftpAction: "upload" });
    expect(desktopSftpReservation(f.sshId, DESKTOP_LOCAL_SFTP_CONNECTION_ID)).toEqual({ resourceId: f.sshId, sftpAction: "download" });
    expect(desktopSftpReservation(f.sshId, f.otherId)).toEqual({ resourceId: f.sshId, relatedResourceId: f.otherId });
    const download = await grantRole(f, "下载", ["ssh.download"], [{ type: "ssh_connection", id: f.sshId }]);
    const upload = await grantRole(f, "上传", ["ssh.upload"], [{ type: "ssh_connection", id: f.otherId }]);
    const scope = randomUUID();
    const uploadReserve = await f.app.inject({
      method: "POST", url: "/api/v1/active-connections/desktop", cookies: f.memberCookies,
      headers: { "x-viron-execution-scope": scope },
      payload: { id: randomUUID(), type: "sftp", resourceId: f.otherId, sftpAction: "upload" },
    });
    expect(uploadReserve.statusCode, uploadReserve.body).toBe(201);
    const transfer = await watchConnection(f, { type: "sftp", resourceId: f.otherId, sftpAction: "upload" });
    await revokeAssignment(f, download.assignmentId);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(transfer.reasons).toEqual([]);
    expect(live(f, transfer.id)).toBe(true);
    await revokeAssignment(f, upload.assignmentId);
    const denied = await f.app.inject({
      method: "POST", url: "/api/v1/active-connections/desktop", cookies: f.memberCookies,
      headers: { "x-viron-execution-scope": scope },
      payload: { id: randomUUID(), type: "sftp", resourceId: f.otherId, sftpAction: "upload" },
    });
    expect(denied.statusCode, denied.body).toBe(404);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(transfer.reasons).toEqual(["授权已到期"]);
    expect(live(f, transfer.id)).toBe(false);
  });

  it("stops only the database operation that lost its permission", async () => {
    const f = await fixture();
    const created = await f.app.inject({
      method: "POST", url: "/api/v1/database-connections", cookies: f.cookies,
      payload: { name: "库", engine: "mysql", host: "127.0.0.1", port: 3306, username: "root", credential: { password: "secret" }, environmentIds: [f.env] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const connectionId = created.json().id as string;
    const role = await grantRole(f, "库操作", ["database.read", "database.write", "database.ddl", "database.export"], [{ type: "database_connection", id: connectionId }]);
    const selectJob = await f.app.databaseQueries.create(f.user, connectionId, "SELECT id FROM accounts");
    const updateJob = await f.app.databaseQueries.create(f.user, connectionId, "UPDATE accounts SET note = 1");
    const alterJob = await f.app.databaseQueries.create(f.user, connectionId, "ALTER TABLE accounts ADD COLUMN note INT");
    const backup = await f.app.databaseTasks.createBackup(f.user, connectionId, "billing");
    const restore = await f.app.databaseTasks.createRestore(f.user, connectionId, "billing", join(tmpdir(), "missing-restore.sql"), "missing-restore.sql");
    await vi.waitFor(() => { expect(pendingConnects.length).toBe(5); }, { timeout: 5_000 });
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(f.app.databaseQueries.get(selectJob.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseQueries.get(updateJob.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseQueries.get(alterJob.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseTasks.get(backup.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseTasks.get(restore.id, f.userId)?.status).toBe("running");

    const put = async (permissionCodes: string[], reason: string) => {
      const response = await f.app.inject({
        method: "PUT", url: `${f.base}/roles/${role.roleId}`, cookies: f.cookies,
        payload: { name: "库操作", description: "", permissionCodes, enabled: true, reason },
      });
      expect(response.statusCode, response.body).toBe(200);
      await disconnectGrantees(f.app, f.org, [f.userId]);
    };
    await put(["database.read", "database.write", "database.ddl"], "撤销导出");
    expect(f.app.databaseTasks.get(backup.id, f.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(f.app.databaseQueries.get(updateJob.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseQueries.get(alterJob.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseQueries.get(selectJob.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseTasks.get(restore.id, f.userId)?.status).toBe("running");

    await put(["database.read", "database.ddl"], "撤销写入");
    expect(f.app.databaseQueries.get(updateJob.id, f.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(f.app.databaseTasks.get(restore.id, f.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(f.app.databaseQueries.get(alterJob.id, f.userId)?.status).toBe("running");
    expect(f.app.databaseQueries.get(selectJob.id, f.userId)?.status).toBe("running");

    await put(["database.read"], "撤销结构");
    expect(f.app.databaseQueries.get(alterJob.id, f.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(f.app.databaseQueries.get(selectJob.id, f.userId)?.status).toBe("running");
  }, 20_000);

  it("rechecks transfer and sync changes on the target connection", async () => {
    const f = await fixture();
    const source = await f.app.inject({
      method: "POST", url: "/api/v1/database-connections", cookies: f.cookies,
      payload: { name: "来源库", engine: "mysql", host: "127.0.0.1", port: 3306, username: "root", credential: { password: "secret" }, environmentIds: [f.env] },
    });
    const target = await f.app.inject({
      method: "POST", url: "/api/v1/database-connections", cookies: f.cookies,
      payload: { name: "目标库", engine: "mysql", host: "127.0.0.1", port: 3306, username: "root", credential: { password: "secret" }, environmentIds: [f.env] },
    });
    expect(source.statusCode, source.body).toBe(201);
    expect(target.statusCode, target.body).toBe(201);
    const sourceId = source.json().id as string;
    const targetId = target.json().id as string;
    await grantRole(f, "来源读取", ["database.read", "database.write"], [{ type: "database_connection", id: sourceId }]);
    const targetRole = await grantRole(f, "目标变更", ["database.read", "database.write", "database.ddl"], [{ type: "database_connection", id: targetId }]);
    const defaults = { sourceConnectionId: sourceId, sourceDatabase: "billing", targetConnectionId: targetId, targetDatabase: "archive", includeStructure: true, includeData: true, includeObjects: true, dropExisting: false };
    const setTarget = async (permissionCodes: string[], reason: string) => {
      const response = await f.app.inject({
        method: "PUT", url: `${f.base}/roles/${targetRole.roleId}`, cookies: f.cookies,
        payload: { name: "目标变更", description: "", permissionCodes, enabled: true, reason },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const started = async () => {
      const task = await f.app.databaseTasks.createTransfer(f.user, defaults);
      await vi.waitFor(() => { expect(f.app.databaseTasks.get(task.id, f.userId)?.status).toBe("running"); }, { timeout: 5_000 });
      await disconnectGrantees(f.app, f.org, [f.userId]);
      expect(f.app.databaseTasks.get(task.id, f.userId)?.status).toBe("running");
      return task.id;
    };

    const transferId = await started();
    await setTarget(["database.read", "database.ddl"], "撤销目标写入");
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(f.app.databaseTasks.get(transferId, f.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });

    await setTarget(["database.read", "database.write", "database.ddl"], "恢复目标写入");
    const structureOnly = await f.app.databaseTasks.createTransfer(f.user, { ...defaults, includeData: false, includeObjects: true });
    await vi.waitFor(() => { expect(f.app.databaseTasks.get(structureOnly.id, f.userId)?.status).toBe("running"); }, { timeout: 5_000 });
    await setTarget(["database.read", "database.ddl"], "结构迁移不写数据");
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(f.app.databaseTasks.get(structureOnly.id, f.userId)?.status).toBe("running");
    await setTarget(["database.read", "database.write"], "撤销目标结构");
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(f.app.databaseTasks.get(structureOnly.id, f.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });

    await setTarget(["database.read", "database.write", "database.ddl"], "恢复目标结构");
    const synced = await f.app.databaseTasks.createSync(f.user, {
      mode: "data",
      sourceConnectionId: sourceId,
      targetConnectionId: targetId,
      sourceDatabase: "billing",
      targetDatabase: "archive",
      selectedItems: ["table:table:accounts"],
      data: defaultDataSyncOptions(),
      structure: defaultStructureSyncOptions(),
    });
    await vi.waitFor(() => { expect(f.app.databaseTasks.get(synced.id, f.userId)?.status).toBe("running"); }, { timeout: 5_000 });
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(f.app.databaseTasks.get(synced.id, f.userId)?.status).toBe("running");
    await setTarget(["database.read", "database.ddl"], "撤销同步写入");
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(f.app.databaseTasks.get(synced.id, f.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
  }, 20_000);

  it("suspends web plugins after the feature grant ends and keeps a page that still has web.use", async () => {
    const f = await fixture();
    const otherEnvResponse = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "预发", owner: "member" } });
    expect(otherEnvResponse.statusCode, otherEnvResponse.body).toBe(201);
    const otherEnv = otherEnvResponse.json().id as string;
    const now = new Date().toISOString();
    const entryId = randomUUID();
    const otherEntryId = randomUUID();
    const credentialId = randomUUID();
    await f.db.prepare("INSERT INTO web_entries (id, environment_id, name, url, description, tags_json, login_config_json, sort_order, created_at, updated_at) VALUES (?, ?, '控制台', 'https://console.example', '', '[]', '{}', 0, ?, ?)").run(entryId, f.env, now, now);
    await f.db.prepare("INSERT INTO web_entries (id, environment_id, name, url, description, tags_json, login_config_json, sort_order, created_at, updated_at) VALUES (?, ?, '预发台', 'https://stage.example', '', '[]', '{}', 0, ?, ?)").run(otherEntryId, otherEnv, now, now);
    await f.db.prepare("INSERT INTO web_credentials (id, web_entry_id, username, password_ciphertext, note, custom_fields_json, sort_order, created_at, updated_at) VALUES (?, ?, 'ops', 'ciphertext', '', '{}', 0, ?, ?)").run(credentialId, entryId, now, now);
    const role = await grantRole(f, "网页", ["web.view", "web.use"], [{ type: "web_entry", id: entryId }, { type: "web_entry", id: otherEntryId }]);
    const feature = async (environmentId: string) => {
      const response = await f.app.inject({
        method: "POST", url: f.base + "/feature-grants", cookies: f.cookies,
        payload: { subjectType: "user", subjectId: f.userId, targets: [{ type: "environment", id: environmentId }], features: { mcp: false, agent: false, webPlugins: true }, reason: "插件" },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().id as string;
    };
    const revokedFeature = await feature(f.env);
    await feature(otherEnv);
    const page = await watchConnection(f, { type: "web", resourceId: credentialId });
    const policy = async (environmentId: string, entry = "") => {
      const params = new URLSearchParams({ environmentId });
      if (entry) params.set("entryId", entry);
      const response = await f.app.inject({
        method: "GET", url: `/api/v1/web-plugin-policy?${params.toString()}`, cookies: f.memberCookies,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { inject: boolean };
    };
    expect((await policy(f.env, entryId)).inject).toBe(true);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(page.reasons).toEqual([]);
    expect(live(f, page.id)).toBe(true);

    const removed = await f.app.inject({
      method: "DELETE", url: `${f.base}/feature-grants/${revokedFeature}`, cookies: f.cookies, payload: { reason: "停用插件" },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await policy(f.env, entryId)).inject).toBe(false);
    expect((await policy(otherEnv, otherEntryId)).inject).toBe(true);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(page.reasons).toEqual([]);
    expect(live(f, page.id)).toBe(true);

    const lost = pluginView(f.env, entryId, true);
    const kept = pluginView(otherEnv, otherEntryId, true);
    const personal = pluginView("", "", true);
    await refreshOrganizationWebPlugins([lost, kept, personal], (target) => policy(target.environmentId, target.entryId));
    expect(lost.allowExtensions).toBe(false);
    expect(lost.suspended).toBe(true);
    expect(lost.popupClosed).toBe(1);
    expect(webExtensionShortcutEnabled(lost.allowExtensions, lost.locked)).toBe(false);
    expect(kept.allowExtensions).toBe(true);
    expect(kept.suspended).toBe(false);
    expect(personal.allowExtensions).toBe(true);
    expect(personal.suspended).toBe(false);
    expect(live(f, page.id)).toBe(true);

    const narrowed = await f.app.inject({
      method: "PUT", url: `${f.base}/roles/${role.roleId}`, cookies: f.cookies,
      payload: { name: "网页", description: "", permissionCodes: ["web.view"], enabled: true, reason: "撤销使用" },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    await disconnectGrantees(f.app, f.org, [f.userId]);
    expect(page.reasons).toEqual(["授权已到期"]);
    expect(live(f, page.id)).toBe(false);
    expect((await policy(otherEnv, otherEntryId)).inject).toBe(true);
  });
});

function pluginView(environmentId: string, entryId: string, allowExtensions: boolean): WebPluginView & { suspended: boolean; popupClosed: number } {
  const state = {
    environmentId,
    entryId,
    currentUrl: entryId ? `https://console.example/${entryId}` : "",
    allowExtensions,
    locked: false,
    suspended: false,
    popupClosed: 0,
    async suspend() { state.suspended = true; },
    async resume() { state.resumed = true; },
    closePopup() { state.popupClosed += 1; },
    resumed: false,
  };
  return state;
}
