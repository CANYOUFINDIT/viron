import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "viron-resource-overview-"));
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
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "资源浏览组织" } });
  const org = organization.json().id as string;
  const base = `/api/v1/organizations/${org}`;
  await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: org } });
  return { app, db, cookies, org, base, adminId: login.json().user.id as string };
}

describe("resource overview and first configuration", () => {
  it("returns safe configuration, knowledge structure, linked certificates, and one resource's authorization rows", async () => {
    const f = await fixture();
    const registered = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "overview-member", password: "member-password" } });
    const userId = registered.json().user.id as string;
    const memberCookies = { envman_session: registered.cookies[0].value };
    const stamp = new Date().toISOString();
    await f.db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(f.org, userId, stamp, stamp);
    await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: memberCookies, payload: { type: "organization", id: f.org } });
    const ssh = await f.app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies: f.cookies,
      payload: { name: "可见连接", host: "example.invalid", port: 22, username: "fake", authType: "password", password: "fake-password" },
    });
    const other = await f.app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies: f.cookies,
      payload: { name: "其他连接", host: "other.invalid", port: 22, username: "other", authType: "password", password: "other-secret" },
    });
    const sshId = ssh.json().id as string;
    const otherId = other.json().id as string;
    const role = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "连接查看", permissionCodes: ["environment.catalog", "ssh.view"], reason: "验收" },
    });
    const roleId = role.json().id as string;
    expect((await f.app.inject({
      method: "POST",
      url: f.base + "/role-assignments",
      cookies: f.cookies,
      payload: { roleId, subjectType: "user", subjectId: userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "验收" },
    })).statusCode).toBe(201);
    expect((await f.app.inject({
      method: "POST",
      url: f.base + "/role-data-grants",
      cookies: f.cookies,
      payload: { roleId, targets: [{ type: "ssh_connection", id: sshId }], reason: "同一角色" },
    })).statusCode).toBe(201);
    const catalogRole = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "仅目录", permissionCodes: ["environment.catalog"], reason: "验收" },
    });
    const catalogUser = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "catalog-only", password: "member-password" } });
    const catalogId = catalogUser.json().user.id as string;
    const catalogCookies = { envman_session: catalogUser.cookies[0].value };
    await f.db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(f.org, catalogId, stamp, stamp);
    await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: catalogCookies, payload: { type: "organization", id: f.org } });
    expect((await f.app.inject({
      method: "POST",
      url: f.base + "/role-assignments",
      cookies: f.cookies,
      payload: { roleId: catalogRole.json().id, subjectType: "user", subjectId: catalogId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "验收" },
    })).statusCode).toBe(201);
    const folder = randomUUID();
    const document = randomUUID();
    await f.db.prepare("INSERT INTO knowledge_nodes (id,workspace_type,workspace_id,type,name,content,created_by_user_id,created_at,updated_at) VALUES (?,'organization',?,'folder','文件夹','',?,?,?)").run(folder, f.org, f.adminId, stamp, stamp);
    await f.db.prepare("INSERT INTO knowledge_nodes (id,workspace_type,workspace_id,parent_id,type,name,content,created_by_user_id,created_at,updated_at) VALUES (?,'organization',?,?,'document','文档','# 正文',?,?,?)").run(document, f.org, folder, f.adminId, stamp, stamp);
    const overview = await f.app.inject({ method: "GET", url: f.base + "/resource-overview", cookies: memberCookies });
    const sshItem = overview.json().entries.find((entry: { id: string }) => entry.id === "ssh").items.find((item: { id: string }) => item.id === sshId);
    const hidden = overview.json().entries.find((entry: { id: string }) => entry.id === "ssh").items.find((item: { id: string }) => item.id === otherId);
    expect(sshItem).toMatchObject({ host: "example.invalid", username: "fake" });
    expect(sshItem.password).toBeUndefined();
    expect(hidden.host).toBeUndefined();
    const catalogOverview = await f.app.inject({ method: "GET", url: f.base + "/resource-overview", cookies: catalogCookies });
    const catalogSsh = catalogOverview.json().entries.find((entry: { id: string }) => entry.id === "ssh").items.find((item: { id: string }) => item.id === sshId);
    expect(catalogSsh.host).toBeUndefined();
    const environment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "空环境", description: "虚构说明" } });
    const refreshed = await f.app.inject({ method: "GET", url: f.base + "/resource-overview", cookies: catalogCookies });
    const doc = refreshed.json().entries.find((entry: { id: string }) => entry.id === "knowledge").items.find((item: { id: string }) => item.id === document);
    expect(doc.parentId).toBe(folder);
    expect(doc.nodeType).toBe("document");
    expect(doc.content).toBeUndefined();
    expect(refreshed.body).not.toContain("# 正文");
    const environmentItem = refreshed.json().entries[0].items.find((item: { id: string }) => item.id === environment.json().id);
    expect(environmentItem.description).toBe("虚构说明");
    expect(environmentItem.located).toEqual({ web: [], logs: [], services: [], knowledge: [] });
    const detail = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshId}`, cookies: f.cookies });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().dataGrants).toHaveLength(1);
    expect(detail.json().dataGrants[0]).toMatchObject({
      name: "连接查看",
      source: "direct",
      status: "active",
      permissionCodes: ["environment.catalog", "ssh.view"],
      roleEnabled: true,
      invalidReason: null,
      targets: [{ type: "ssh_connection", id: sshId }],
    });
    expect(detail.json().featureGrants).toEqual([]);
    expect(detail.json().configurationMaintenance).toEqual([]);
    const otherDetail = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${otherId}`, cookies: f.cookies });
    expect(otherDetail.json().dataGrants).toEqual([]);
    const denied = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshId}`, cookies: catalogCookies });
    expect(denied.statusCode).toBe(403);
    const feature = await f.app.inject({
      method: "POST",
      url: f.base + "/feature-grants",
      cookies: f.cookies,
      payload: {
        subjectType: "user",
        subjectId: userId,
        targets: [{ type: "ssh_connection", id: sshId }, { type: "ssh_connection", id: otherId }],
        features: { mcp: true, agent: false, webPlugins: false },
        reason: "多目标",
      },
    });
    expect(feature.statusCode, feature.body).toBe(201);
    const viewer = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "grant-viewer", password: "member-password" } });
    const viewerId = viewer.json().user.id as string;
    const viewerCookies = { envman_session: viewer.cookies[0].value };
    await f.db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(f.org, viewerId, stamp, stamp);
    await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: viewerCookies, payload: { type: "organization", id: f.org } });
    const viewRole = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "授权查看", permissionCodes: ["environment.catalog", "authorization.view"], reason: "验收" },
    });
    expect((await f.app.inject({
      method: "POST",
      url: f.base + "/role-assignments",
      cookies: f.cookies,
      payload: { roleId: viewRole.json().id, subjectType: "user", subjectId: viewerId, managementScope: { kind: "resources", ids: [], includeChildren: false }, reason: "验收" },
    })).statusCode).toBe(201);
    expect((await f.app.inject({
      method: "POST",
      url: f.base + "/role-data-grants",
      cookies: f.cookies,
      payload: { roleId: viewRole.json().id, targets: [{ type: "ssh_connection", id: sshId }], reason: "仅当前资源" },
    })).statusCode).toBe(201);
    const scoped = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshId}`, cookies: viewerCookies });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json().featureGrants).toHaveLength(1);
    expect(scoped.json().featureGrants[0].targets.every((entry: { id: string }) => entry.id === sshId)).toBe(true);
    expect(scoped.json().featureGrants[0]).toMatchObject({ subjectName: "overview-member", source: "user", subjectEnabled: true, status: "active" });
    expect(scoped.json().dataGrants.find((row: { roleId: string }) => row.roleId === roleId).permissionCodes).toContain("ssh.view");
    expect((await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${otherId}`, cookies: viewerCookies })).statusCode).toBe(403);
    expect((await f.app.inject({
      method: "PUT",
      url: f.base + "/roles/" + roleId,
      cookies: f.cookies,
      payload: { name: "连接查看", permissionCodes: ["environment.catalog", "ssh.view"], enabled: false, reason: "角色停用" },
    })).statusCode).toBe(200);
    const disabled = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshId}`, cookies: viewerCookies });
    expect(disabled.json().dataGrants.find((row: { roleId: string }) => row.roleId === roleId)).toMatchObject({
      roleEnabled: false,
      status: "active",
      invalidReason: "角色已停用",
    });
  });

  it("lets the maintain code create and update the first Web entry without granting that path to environment.create", async () => {
    const f = await fixture();
    const environment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "首条入口环境" } });
    const envId = environment.json().id as string;
    const created = await f.app.inject({
      method: "POST",
      url: `/api/v1/environments/${envId}/web-entries`,
      cookies: f.cookies,
      payload: { name: "第一条", url: "http://fixture.invalid" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const entryId = created.json().id as string;
    const grants = await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE target_id = ?").all(entryId);
    expect(grants).toEqual([]);
    const maintenance = await f.db.prepare("SELECT code, actor_id FROM organization_resource_maintenance WHERE target_id = ?").all<{ code: string; actor_id: string }>(entryId);
    expect(maintenance).toEqual([{ code: "resource.web.configure", actor_id: f.adminId }]);
    const maintainedDetail = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/web_entry/${entryId}`, cookies: f.cookies });
    expect(maintainedDetail.statusCode, maintainedDetail.body).toBe(200);
    expect(maintainedDetail.json().dataGrants).toEqual([]);
    expect(maintainedDetail.json().featureGrants).toEqual([]);
    expect(maintainedDetail.json().configurationMaintenance).toEqual([
      expect.objectContaining({ kind: "maintenance", code: "resource.web.configure", actorId: f.adminId, actorName: "admin", source: "maintenance" }),
    ]);
    const { loadOrganizationAccess } = await import("../src/server/organization-rbac.js");
    const createdAccess = await loadOrganizationAccess(f.db, f.org, f.adminId);
    expect(createdAccess.allows("web.use", { type: "web_entry", id: entryId })).toBe(false);
    expect(createdAccess.allows("resource.web.configure", { type: "web_entry", id: entryId })).toBe(true);
    const updated = await f.app.inject({
      method: "PUT",
      url: `/api/v1/web-entries/${entryId}`,
      cookies: f.cookies,
      payload: { name: "第一条已维护", url: "http://fixture.invalid/edited" },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const registered = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "env-creator", password: "member-password" } });
    const userId = registered.json().user.id as string;
    const cookies = { envman_session: registered.cookies[0].value };
    const stamp = new Date().toISOString();
    await f.db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(f.org, userId, stamp, stamp);
    await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: f.org } });
    const role = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "只创建环境", permissionCodes: ["environment.create"], reason: "验收" },
    });
    expect((await f.app.inject({
      method: "POST",
      url: f.base + "/role-assignments",
      cookies: f.cookies,
      payload: { roleId: role.json().id, subjectType: "user", subjectId: userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "验收" },
    })).statusCode).toBe(201);
    const ownEnvironment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "无维护环境" } });
    expect(ownEnvironment.statusCode, ownEnvironment.body).toBe(201);
    const denied = await f.app.inject({
      method: "POST",
      url: `/api/v1/environments/${ownEnvironment.json().id}/web-entries`,
      cookies,
      payload: { name: "不能维护", url: "http://fixture.invalid" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("edits or revokes only the current feature target and keeps the sibling source", async () => {
    const f = await fixture();
    const registered = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "target-editor", password: "member-password" } });
    const userId = registered.json().user.id as string;
    const cookies = { envman_session: registered.cookies[0].value };
    const stamp = new Date().toISOString();
    await f.db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(f.org, userId, stamp, stamp);
    await f.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: f.org } });
    const ssh = async (name: string) => {
      const created = await f.app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies: f.cookies,
        payload: { name, host: "example.invalid", port: 22, username: "fake", authType: "password", password: "fake-password" },
      });
      expect(created.statusCode, created.body).toBe(201);
      return created.json().id as string;
    };
    const sshA = await ssh("目标A");
    const sshB = await ssh("目标B");
    const holder = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "仅连接", permissionCodes: ["ssh.view"], reason: "验收" },
    });
    const maintainer = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "只维护A", permissionCodes: ["authorization.view", "authorization.update", "authorization.revoke"], reason: "验收" },
    });
    for (const roleId of [holder.json().id, maintainer.json().id]) {
      expect((await f.app.inject({
        method: "POST",
        url: f.base + "/role-assignments",
        cookies: f.cookies,
        payload: { roleId, subjectType: "user", subjectId: userId, managementScope: { kind: "resources", ids: [], includeChildren: false }, reason: "验收" },
      })).statusCode).toBe(201);
    }
    const holderGrants = await f.app.inject({
      method: "POST",
      url: f.base + "/role-data-grants",
      cookies: f.cookies,
      payload: { roleId: holder.json().id, targets: [{ type: "ssh_connection", id: sshA }, { type: "ssh_connection", id: sshB }], reason: "一批两个目标" },
    });
    expect(holderGrants.statusCode, holderGrants.body).toBe(201);
    expect((await f.app.inject({
      method: "POST",
      url: f.base + "/role-data-grants",
      cookies: f.cookies,
      payload: { roleId: maintainer.json().id, targets: [{ type: "ssh_connection", id: sshA }], reason: "只给A" },
    })).statusCode).toBe(201);
    const feature = await f.app.inject({
      method: "POST",
      url: f.base + "/feature-grants",
      cookies: f.cookies,
      payload: {
        subjectType: "user",
        subjectId: userId,
        targets: [{ type: "ssh_connection", id: sshA }, { type: "ssh_connection", id: sshB }],
        features: { mcp: true, agent: false, webPlugins: false },
        reason: "多目标",
      },
    });
    expect(feature.statusCode, feature.body).toBe(201);
    const featureId = feature.json().id as string;
    const requestId = randomUUID();
    await f.db.prepare("UPDATE organization_feature_grants SET request_id = ? WHERE id = ?").run(requestId, featureId);
    const dataA = await f.db.prepare("SELECT id FROM organization_role_data_grants WHERE role_id = ? AND target_id = ?").get<{ id: string }>(holder.json().id, sshA);
    const dataB = await f.db.prepare("SELECT id, enabled, starts_at, expires_at, reason, source, request_id FROM organization_role_data_grants WHERE role_id = ? AND target_id = ?").get<{ id: string; enabled: number; starts_at: string | null; expires_at: string | null; reason: string; source: string; request_id: string | null }>(holder.json().id, sshB);
    const dataRequestId = randomUUID();
    await f.db.prepare("UPDATE organization_role_data_grants SET source = 'request', request_id = ? WHERE id = ?").run(dataRequestId, dataA!.id);
    const trimmed = await f.app.inject({
      method: "PUT",
      url: `${f.base}/feature-grants/${featureId}`,
      cookies,
      payload: {
        subjectType: "user",
        subjectId: userId,
        targets: [{ type: "ssh_connection", id: sshA }],
        features: { mcp: false, agent: true, webPlugins: false },
        enabled: false,
        reason: "裁剪整条",
      },
    });
    expect(trimmed.statusCode).toBe(403);
    const detailA = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshA}`, cookies });
    expect(detailA.statusCode, detailA.body).toBe(200);
    expect(JSON.stringify(detailA.json())).not.toContain(sshB);
    expect(detailA.json().authorization).toMatchObject({ update: true, revoke: true });
    const featureRow = detailA.json().featureGrants.find((row: { id: string }) => row.id === featureId);
    expect(featureRow).toMatchObject({
      source: "user",
      origin: "request",
      requestId,
      subjectId: userId,
      enabled: true,
      features: { mcp: true, agent: false, webPlugins: false },
      canUpdate: true,
      canRevoke: true,
    });
    expect(featureRow.targets).toEqual([expect.objectContaining({ id: sshA, type: "ssh_connection" })]);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshB}`, cookies })).statusCode).toBe(403);
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const edited = await f.app.inject({
      method: "PUT",
      url: `${f.base}/resource-authorizations/ssh_connection/${sshA}/feature-grants/${featureId}`,
      cookies,
      payload: { enabled: false, startsAt: null, expiresAt, features: { mcp: false, agent: true, webPlugins: false }, reason: "只改A", revision: featureRow.revision },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const stored = await f.db.prepare("SELECT id, targets_json, features_json, enabled, starts_at, expires_at, reason, request_id, subject_id FROM organization_feature_grants WHERE organization_id = ?").all<{ id: string; targets_json: string; features_json: string; enabled: number; starts_at: string | null; expires_at: string | null; reason: string; request_id: string | null; subject_id: string }>(f.org);
    const retained = stored.find((row) => row.id === featureId);
    const split = stored.find((row) => row.id !== featureId);
    expect(JSON.parse(retained!.targets_json)).toEqual([{ type: "ssh_connection", id: sshB }]);
    expect(JSON.parse(retained!.features_json)).toMatchObject({ mcp: true, agent: false, webPlugins: false });
    expect(retained).toMatchObject({ enabled: 1, starts_at: null, expires_at: null, reason: "多目标", request_id: requestId, subject_id: userId });
    expect(JSON.parse(split!.targets_json)).toEqual([{ type: "ssh_connection", id: sshA }]);
    expect(JSON.parse(split!.features_json)).toMatchObject({ mcp: false, agent: true, webPlugins: false });
    expect(split).toMatchObject({ enabled: 0, expires_at: expiresAt, reason: "只改A", request_id: requestId, subject_id: userId });
    const stale = await f.app.inject({
      method: "PUT",
      url: `${f.base}/resource-authorizations/ssh_connection/${sshA}/feature-grants/${featureId}`,
      cookies,
      payload: { enabled: false, startsAt: null, expiresAt, features: { mcp: false, agent: true, webPlugins: false }, reason: "过期修订", revision: featureRow.revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("CURRENT_TARGET_CHANGED");
    const adminB = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshB}`, cookies: f.cookies });
    const retainedRow = adminB.json().featureGrants.find((row: { id: string }) => row.id === featureId);
    const deniedB = await f.app.inject({
      method: "DELETE",
      url: `${f.base}/resource-authorizations/ssh_connection/${sshB}/feature-grants/${featureId}`,
      cookies,
      payload: { reason: "不能撤B", revision: retainedRow.revision },
    });
    expect(deniedB.statusCode).toBe(403);
    expect(adminB.json().featureGrants.find((row: { id: string }) => row.id === featureId)).toMatchObject({
      enabled: true,
      reason: "多目标",
      requestId,
      origin: "request",
      features: { mcp: true, agent: false, webPlugins: false },
    });
    const currentA = await f.app.inject({ method: "GET", url: `${f.base}/resource-authorizations/ssh_connection/${sshA}`, cookies });
    const splitRow = currentA.json().featureGrants.find((row: { id: string }) => row.id === split!.id);
    const revoked = await f.app.inject({
      method: "DELETE",
      url: `${f.base}/resource-authorizations/ssh_connection/${sshA}/feature-grants/${split!.id}`,
      cookies,
      payload: { reason: "撤销A", revision: splitRow.revision },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const afterRevoke = await f.db.prepare("SELECT id, targets_json, features_json, enabled, reason, request_id FROM organization_feature_grants WHERE organization_id = ?").all<{ id: string; targets_json: string; features_json: string; enabled: number; reason: string; request_id: string | null }>(f.org);
    expect(afterRevoke.map((row) => row.id)).toEqual([featureId]);
    expect(JSON.parse(afterRevoke[0].targets_json)).toEqual([{ type: "ssh_connection", id: sshB }]);
    expect(JSON.parse(afterRevoke[0].features_json)).toMatchObject({ mcp: true, agent: false, webPlugins: false });
    expect(afterRevoke[0]).toMatchObject({ enabled: 1, reason: "多目标", request_id: requestId });
    const dataDetail = currentA.json().dataGrants.find((row: { id: string }) => row.id === dataA!.id);
    expect(dataDetail).toMatchObject({ source: "request", origin: "request", requestId: dataRequestId, canUpdate: true });
    const dataEdit = await f.app.inject({
      method: "PUT",
      url: `${f.base}/resource-authorizations/ssh_connection/${sshA}/data-grants/${dataA!.id}`,
      cookies,
      payload: { enabled: false, startsAt: null, expiresAt, reason: "只停A", revision: dataDetail.revision },
    });
    expect(dataEdit.statusCode, dataEdit.body).toBe(200);
    const dataAfter = await f.db.prepare("SELECT id, enabled, expires_at, source, request_id, reason FROM organization_role_data_grants WHERE id IN (?, ?)").all<{ id: string; enabled: number; expires_at: string | null; source: string; request_id: string | null; reason: string }>(dataA!.id, dataB!.id);
    expect(dataAfter.find((row) => row.id === dataA!.id)).toMatchObject({ enabled: 0, expires_at: expiresAt, source: "request", request_id: dataRequestId, reason: "只停A" });
    expect(dataAfter.find((row) => row.id === dataB!.id)).toMatchObject({ enabled: dataB!.enabled, expires_at: dataB!.expires_at, source: dataB!.source, request_id: dataB!.request_id, reason: dataB!.reason });
    const siblingDetail = adminB.json().dataGrants.find((row: { id: string }) => row.id === dataB!.id);
    expect((await f.app.inject({
      method: "PUT",
      url: `${f.base}/resource-authorizations/ssh_connection/${sshB}/data-grants/${dataB!.id}`,
      cookies,
      payload: { enabled: false, startsAt: null, expiresAt, reason: "不能改B", revision: siblingDetail.revision },
    })).statusCode).toBe(403);
    expect((await f.app.inject({
      method: "DELETE",
      url: `${f.base}/resource-authorizations/ssh_connection/${sshA}/data-grants/${randomUUID()}`,
      cookies,
      payload: { reason: "没有这条", revision: dataDetail.revision },
    })).statusCode).toBe(404);
  });
});
