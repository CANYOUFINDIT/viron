import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 29),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
  return { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value };
}

async function switchWorkspace(app: Awaited<ReturnType<typeof buildApp>>, cookies: { envman_session: string }, organizationId: string) {
  const response = await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: organizationId } });
  expect(response.statusCode).toBe(200);
}

async function createPersonalFixture(app: Awaited<ReturnType<typeof buildApp>>, cookies: { envman_session: string }) {
  const group = await app.inject({ method: "POST", url: "/api/v1/environment-groups", cookies, payload: { name: "生产集群", description: "核心系统", color: "#1d8a74" } });
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { groupId: group.json().id, name: "生产环境", shortName: "PROD", description: "primary", status: "active", owner: "ops", tags: ["prod"] } });
  const environmentId = environment.json().id as string;
  const jump = await app.inject({
    method: "POST", url: "/api/v1/ssh-connections", cookies,
    payload: { name: "生产跳板机", host: "10.0.0.10", port: 22, username: "jump", authType: "password", credential: { password: "jump-secret" } },
  });
  const application = await app.inject({
    method: "POST", url: "/api/v1/ssh-connections", cookies,
    payload: { environmentIds: [environmentId], name: "生产应用", host: "10.0.0.20", port: 22, username: "app", authType: "password", credential: { password: "app-secret" }, jumpConnectionId: jump.json().id },
  });
  const database = await app.inject({
    method: "POST", url: "/api/v1/database-connections", cookies,
    payload: { environmentIds: [environmentId], name: "生产数据库", engine: "mysql", host: "10.0.0.30", port: 3306, username: "db", credential: { password: "db-secret" }, connectionMode: "sshTunnel", options: { sshConnectionId: jump.json().id } },
  });
  const webEntry = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/web-entries`, cookies, payload: { name: "管理后台", url: "https://prod.example.com", description: "console", tags: ["admin"] } });
  const webCredential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${webEntry.json().id}/credentials`, cookies, payload: { username: "operator", password: "web-secret", note: "primary", customFields: { tenant: "prod" } } });
  const log = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/logs`, cookies, payload: { sshConnectionId: application.json().id, name: "应用日志", filePaths: ["/var/log/app.log"] } });
  return {
    groupId: group.json().id as string,
    environmentId,
    jumpId: jump.json().id as string,
    applicationId: application.json().id as string,
    databaseId: database.json().id as string,
    webEntryId: webEntry.json().id as string,
    webCredentialId: webCredential.json().id as string,
    logId: log.json().id as string,
  };
}

function fixtureSelection(fixture: Awaited<ReturnType<typeof createPersonalFixture>>) {
  return {
    environmentGroupIds: [fixture.groupId],
    environmentIds: [fixture.environmentId],
    sshConnectionIds: [fixture.applicationId],
    databaseConnectionIds: [fixture.databaseId],
    webEntryIds: [fixture.webEntryId],
    webCredentialIds: [fixture.webCredentialId],
    logIds: [fixture.logId],
  };
}

describe("personal resource copy to organization", () => {
  it("copies a complete environment graph, expands dependencies, reencrypts secrets, and grants the group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-copy-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const cookies = await login(app);
    const fixture = await createPersonalFixture(app, cookies);
    const sourceSshCiphertext = (await app.db.prepare("SELECT credential_ciphertext FROM ssh_connections WHERE id = ?").get<{ credential_ciphertext: string }>(fixture.applicationId))!.credential_ciphertext;

    expect((await app.inject({ method: "GET", url: "/api/v1/connection-copy/catalog", cookies })).statusCode).toBe(403);

    const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "研发中心", description: "delivery" } });
    const organizationId = organization.json().id as string;
    await switchWorkspace(app, cookies, organizationId);
    const project = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/projects`, cookies, payload: { name: "运维项目", description: "" } });

    const catalog = await app.inject({ method: "GET", url: "/api/v1/connection-copy/catalog", cookies });
    expect(catalog.statusCode).toBe(200);
    expect(JSON.stringify(catalog.json())).not.toContain("app-secret");
    expect(catalog.json().environmentGroups).toEqual([expect.objectContaining({ id: fixture.groupId, name: "生产集群" })]);

    const preview = await app.inject({ method: "POST", url: "/api/v1/connection-copy/preview", cookies, payload: { selection: fixtureSelection(fixture) } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().selection.sshConnectionIds).toEqual(expect.arrayContaining([fixture.applicationId, fixture.jumpId]));
    expect(preview.json().dependencyAdded).toEqual(expect.arrayContaining([expect.objectContaining({ id: fixture.jumpId })]));
    expect(preview.json().secretCount).toBe(4);

    const copied = await app.inject({
      method: "POST", url: "/api/v1/connection-copy", cookies,
      payload: { selection: fixtureSelection(fixture), reuse: {}, grantees: [{ type: "project", id: project.json().id }] },
    });
    expect(copied.statusCode, copied.body).toBe(201);
    expect(copied.json().counts).toMatchObject({ environmentGroups: 1, environments: 1, sshConnections: 2, databaseConnections: 1, webEntries: 1, webCredentials: 1, logs: 1, grants: 1 });

    const copiedApplication = await app.db.prepare("SELECT id, credential_ciphertext, jump_connection_id FROM ssh_connections WHERE workspace_type = 'organization' AND workspace_id = ? AND host = '10.0.0.20'").get<{ id: string; credential_ciphertext: string; jump_connection_id: string }>(organizationId);
    const copiedJump = await app.db.prepare("SELECT id FROM ssh_connections WHERE workspace_type = 'organization' AND workspace_id = ? AND host = '10.0.0.10'").get<{ id: string }>(organizationId);
    expect(copiedApplication?.jump_connection_id).toBe(copiedJump?.id);
    expect(copiedApplication?.credential_ciphertext).not.toBe(sourceSshCiphertext);
    expect(JSON.parse(app.secrets.decrypt(copiedApplication!.credential_ciphertext))).toEqual({ password: "app-secret", privateKey: "", passphrase: "" });

    const copiedDatabase = await app.db.prepare("SELECT options_json FROM database_connections WHERE workspace_type = 'organization' AND workspace_id = ?").get<{ options_json: string }>(organizationId);
    expect(JSON.parse(copiedDatabase!.options_json).sshConnectionId).toBe(copiedJump?.id);
    const copiedEnvironment = await app.db.prepare("SELECT id FROM environments WHERE workspace_type = 'organization' AND workspace_id = ?").get<{ id: string }>(organizationId);
    expect(await app.db.prepare("SELECT 1 FROM ssh_connection_environments WHERE connection_id = ? AND environment_id = ?").get(copiedApplication!.id, copiedEnvironment!.id)).toBeTruthy();
    expect(await app.db.prepare("SELECT 1 FROM environment_logs WHERE environment_id = ? AND ssh_connection_id = ?").get(copiedEnvironment!.id, copiedApplication!.id)).toBeTruthy();
    expect(await app.db.prepare("SELECT resource_type FROM resource_grants WHERE organization_id = ? AND grantee_type = 'project' AND grantee_id = ?").get<{ resource_type: string }>(organizationId, project.json().id)).toEqual({ resource_type: "environment_group" });

    const conflictPreview = await app.inject({ method: "POST", url: "/api/v1/connection-copy/preview", cookies, payload: { selection: fixtureSelection(fixture) } });
    expect(conflictPreview.json().conflicts).toHaveLength(8);
    const reuse = Object.fromEntries((conflictPreview.json().conflicts as Array<{ sourceId: string; candidates: Array<{ id: string }> }>).map((item) => [item.sourceId, item.candidates[0]!.id]));
    const reused = await app.inject({ method: "POST", url: "/api/v1/connection-copy", cookies, payload: { selection: fixtureSelection(fixture), reuse, grantees: [] } });
    expect(reused.statusCode, reused.body).toBe(201);
    expect(reused.json().reused).toBe(8);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM environments WHERE workspace_type = 'organization' AND workspace_id = ?").get<{ count: number }>(organizationId)).toEqual({ count: 1 });

    await app.close();
  });

  it("rolls back every copied row when a credential cannot be decrypted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-copy-rollback-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const cookies = await login(app);
    const fixture = await createPersonalFixture(app, cookies);
    await app.db.prepare("UPDATE web_credentials SET password_ciphertext = 'broken' WHERE id = ?").run(fixture.webCredentialId);
    const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "回滚验证", description: "" } });
    const organizationId = organization.json().id as string;
    await switchWorkspace(app, cookies, organizationId);

    const copied = await app.inject({ method: "POST", url: "/api/v1/connection-copy", cookies, payload: { selection: fixtureSelection(fixture), reuse: {}, grantees: [] } });
    expect(copied.statusCode).toBe(400);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM environments WHERE workspace_type = 'organization' AND workspace_id = ?").get<{ count: number }>(organizationId)).toEqual({ count: 0 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM ssh_connections WHERE workspace_type = 'organization' AND workspace_id = ?").get<{ count: number }>(organizationId)).toEqual({ count: 0 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM connection_groups WHERE workspace_type = 'organization' AND workspace_id = ?").get<{ count: number }>(organizationId)).toEqual({ count: 0 });

    await app.close();
  });
});
