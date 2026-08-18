import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { cronExpressionError } from "../src/server/connection-sources/scheduler.js";
import { reconcileSecureCrtPayloads } from "../src/server/connection-sources/sync.js";
import { applyScriptSyncPayload, parseScriptSyncOutput, syncScriptSource } from "../src/server/connection-sources/script-sync.js";
import { refreshPendingExistingConnections } from "../src/server/connection-existing.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { generateSshKeyPair } from "../src/server/ssh/key-store.js";

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
    masterKey: Buffer.alloc(32, 11),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("SecureCRT connection source", () => {
  it("validates Cron schedules", () => {
    expect(cronExpressionError("0 */6 * * *")).toBeNull();
    expect(cronExpressionError("not-a-cron")).toBe("Cron 表达式无效");
    expect(cronExpressionError("")).toBe("启用定时同步时必须填写 Cron 表达式");
  });

  it("queues cross-source duplicates for an explicit conflict decision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-source-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    await db.prepare(`INSERT INTO connection_sources (id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'securecrt_sync', ?, ?, ?, ?)`)
      .run(sourceId, "Test Sync", app.secrets.encrypt("{}"), now, now);
    await db.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, auth_type, credential_ciphertext, options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'password', ?, '{}', ?, ?)`)
      .run(crypto.randomUUID(), "Existing", "10.0.0.10", 22, "root", app.secrets.encrypt(JSON.stringify({ password: "existing-secret" })), now, now);

    const result = await reconcileSecureCrtPayloads(app, sourceId, "Test Sync", [{
      type: "ssh",
      importKey: "Production/App.ini",
      sourcePath: "Production/App.ini",
      groupPath: ["Production"],
      name: "Synced App",
      host: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
      credential: { password: "synced-secret" },
      options: {},
      warnings: [],
    }]);
    expect(result.created).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(result.conflictBatchId).toBeTruthy();
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ssh_connections").get() as { count: number }).count).toBe(1);

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const preview = await app.inject({ method: "GET", url: `/api/v1/connection-imports/${result.conflictBatchId}`, cookies });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().batch.sourceType).toBe("securecrt_sync");
    const itemId = preview.json().batch.items[0].id as string;
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/connection-imports/${result.conflictBatchId}/confirm`,
      cookies,
      payload: { decisions: [{ itemId, action: "keep" }] },
    });
    expect(confirmed.statusCode).toBe(200);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ssh_connections").get() as { count: number }).count).toBe(2);
    expect((await db.prepare("SELECT source_item_id FROM ssh_connections WHERE source_id = ?").get(sourceId) as { source_item_id: string }).source_item_id).toBe("Production/App.ini");

    await app.close();
  });

  it("does not treat connections created by the same sync source as existing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-same-source-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    await db.prepare(`INSERT INTO connection_sources (id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'securecrt_sync', ?, ?, ?, ?)`)
      .run(sourceId, "Same Source", app.secrets.encrypt("{}"), now, now);
    const payload = (importKey: string, name: string) => ({
      type: "ssh" as const, importKey, sourcePath: importKey, groupPath: ["Production"], name,
      host: "10.0.0.20", port: 22, username: "root", authType: "password" as const,
      credential: { password: "secret" }, options: {}, warnings: [],
    });

    const result = await reconcileSecureCrtPayloads(app, sourceId, "Same Source", [payload("Production/A.ini", "A"), payload("Production/B.ini", "B")]);
    expect(result).toMatchObject({ created: 2, conflicts: 0, conflictBatchId: null });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ssh_connections WHERE source_id = ?").get(sourceId) as { count: number }).count).toBe(2);
    await app.close();
  });

  it("preserves a locally configured login script when synchronization updates the connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-script-sync-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    await db.prepare(`INSERT INTO connection_sources (id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'securecrt_sync', ?, ?, ?, ?)`)
      .run(sourceId, "Script Source", app.secrets.encrypt("{}"), now, now);
    const payload = {
      type: "ssh" as const,
      importKey: "Production/App.ini",
      sourcePath: "Production/App.ini",
      groupPath: ["Production"],
      name: "Synced App",
      host: "10.0.0.40",
      port: 22,
      username: "root",
      authType: "password" as const,
      credential: { password: "secret" },
      options: { terminalType: "xterm" },
      warnings: [],
    };
    expect((await reconcileSecureCrtPayloads(app, sourceId, "Script Source", [payload])).created).toBe(1);
    const connection = await db.prepare("SELECT id FROM ssh_connections WHERE source_id = ?").get(sourceId) as { id: string };
    await db.prepare("UPDATE ssh_connections SET options_json = ? WHERE id = ?").run(JSON.stringify({
      terminalType: "xterm",
      loginScriptEnabled: true,
      loginScript: "cd /srv/app\necho synced",
    }), connection.id);

    const updatedPayload = { ...payload, name: "Synced App Updated", options: { terminalType: "xterm-256color", keepAliveSeconds: 45 } };
    expect((await reconcileSecureCrtPayloads(app, sourceId, "Script Source", [updatedPayload])).updated).toBe(1);
    const stored = await db.prepare("SELECT name, options_json FROM ssh_connections WHERE id = ?").get(connection.id) as { name: string; options_json: string };
    expect(stored.name).toBe("Synced App Updated");
    expect(JSON.parse(stored.options_json)).toMatchObject({
      terminalType: "xterm-256color",
      keepAliveSeconds: 45,
      loginScriptEnabled: true,
      loginScript: "cd /srv/app\necho synced",
    });
    await app.close();
  });

  it("cancels a pending existing-connection batch when all targets were deleted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-stale-existing-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    const existingId = crypto.randomUUID();
    await db.prepare(`INSERT INTO connection_sources (id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'securecrt_sync', ?, ?, ?, ?)`)
      .run(sourceId, "Stale Source", app.secrets.encrypt("{}"), now, now);
    await db.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, auth_type, credential_ciphertext, options_json, created_at, updated_at) VALUES (?, 'Existing', '10.0.0.30', 22, 'root', 'password', ?, '{}', ?, ?)`)
      .run(existingId, app.secrets.encrypt("{}"), now, now);
    const result = await reconcileSecureCrtPayloads(app, sourceId, "Stale Source", [{
      type: "ssh", importKey: "A.ini", sourcePath: "A.ini", groupPath: [], name: "A", host: "10.0.0.30", port: 22, username: "root", authType: "password", credential: { password: "secret" }, options: {}, warnings: [],
    }]);
    await db.prepare("DELETE FROM ssh_connections WHERE id = ?").run(existingId);
    await refreshPendingExistingConnections(db);
    expect((await db.prepare("SELECT status FROM connection_import_batches WHERE id = ?").get(result.conflictBatchId) as { status: string }).status).toBe("cancelled");
    await app.close();
  });
});

describe("script connection source", () => {
  it("validates the versioned script output", () => {
    expect(() => parseScriptSyncOutput("not-json")).toThrow("单个有效 JSON");
    expect(() => parseScriptSyncOutput(JSON.stringify({ schemaVersion: 2 }))).toThrow("脚本输出格式无效");
    expect(() => parseScriptSyncOutput(JSON.stringify({ schemaVersion: 1, sshConnections: [
      { name: "app", host: "10.0.0.1", username: "root" },
      { name: "APP", host: "10.0.0.2", username: "root" },
    ] }))).toThrow("重复SSH 连接");
  });

  it("preserves manual environment ordering and appends synchronized additions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-script-order-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const actor = await db.prepare("SELECT id FROM admin_users WHERE is_platform_admin = 1").get() as { id: string };
    const sourceId = crypto.randomUUID();
    const productionGroupId = crypto.randomUUID();
    const pinnedGroupId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'personal', ?, 'script_sync', ?, ?, ?, ?)`)
      .run(sourceId, actor.id, "Inventory", app.secrets.encrypt("{}"), now, now);
    await db.prepare(`INSERT INTO environment_groups (id, workspace_type, workspace_id, name, description, color, sort_order, created_at, updated_at) VALUES (?, 'personal', ?, ?, '', '#1d8a74', ?, ?, ?)`)
      .run(pinnedGroupId, actor.id, "Pinned", 0, now, now);
    await db.prepare(`INSERT INTO environment_groups (id, workspace_type, workspace_id, name, description, color, sort_order, created_at, updated_at) VALUES (?, 'personal', ?, ?, 'old', '#1d8a74', ?, ?, ?)`)
      .run(productionGroupId, actor.id, "Production", 1, now, now);
    await db.prepare(`INSERT INTO environments (id, workspace_type, workspace_id, group_id, sort_order, name, description, created_at, updated_at) VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), actor.id, productionGroupId, 0, "First", "manual", now, now);
    await db.prepare(`INSERT INTO environments (id, workspace_type, workspace_id, group_id, sort_order, name, description, created_at, updated_at) VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), actor.id, productionGroupId, 1, "Second", "old", now, now);
    await db.prepare(`INSERT INTO environments (id, workspace_type, workspace_id, group_id, sort_order, name, description, created_at, updated_at) VALUES (?, 'personal', ?, NULL, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), actor.id, 0, "Ungrouped existing", "old", now, now);

    const payload = parseScriptSyncOutput(JSON.stringify({
      schemaVersion: 1,
      environmentGroups: [
        { name: "Production", description: "updated", sortOrder: 0 },
        { name: "New group B", sortOrder: 999 },
        { name: "New group A", sortOrder: 0 },
      ],
      environments: [
        { group: "Production", name: "Second", description: "updated", sortOrder: 0 },
        { group: "Production", name: "New environment B", sortOrder: 999 },
        { group: "Production", name: "New environment A", sortOrder: 0 },
        { name: "Ungrouped existing", description: "updated", sortOrder: 999 },
        { name: "Ungrouped new B", sortOrder: 999 },
        { name: "Ungrouped new A", sortOrder: 0 },
      ],
    }));
    const source = { id: sourceId, name: "Inventory", config_ciphertext: "", workspace_type: "personal" as const, workspace_id: actor.id };

    await applyScriptSyncPayload(app, source, payload, "overwrite", actor.id);
    await applyScriptSyncPayload(app, source, payload, "overwrite", actor.id);

    const groups = await db.prepare(`SELECT name, sort_order FROM environment_groups WHERE workspace_type = 'personal' AND workspace_id = ? ORDER BY sort_order, name`).all(actor.id) as Array<{ name: string; sort_order: number }>;
    expect(groups).toEqual([
      { name: "Pinned", sort_order: 0 },
      { name: "Production", sort_order: 1 },
      { name: "New group B", sort_order: 2 },
      { name: "New group A", sort_order: 3 },
    ]);
    const groupedEnvironments = await db.prepare("SELECT name, sort_order, description FROM environments WHERE group_id = ? ORDER BY sort_order, name").all(productionGroupId) as Array<{ name: string; sort_order: number; description: string }>;
    expect(groupedEnvironments).toEqual([
      { name: "First", sort_order: 0, description: "manual" },
      { name: "Second", sort_order: 1, description: "updated" },
      { name: "New environment B", sort_order: 2, description: "" },
      { name: "New environment A", sort_order: 3, description: "" },
    ]);
    const ungroupedEnvironments = await db.prepare("SELECT name, sort_order FROM environments WHERE workspace_type = 'personal' AND workspace_id = ? AND group_id IS NULL ORDER BY sort_order, name").all(actor.id) as Array<{ name: string; sort_order: number }>;
    expect(ungroupedEnvironments).toEqual([
      { name: "Ungrouped existing", sort_order: 0 },
      { name: "Ungrouped new B", sort_order: 1 },
      { name: "Ungrouped new A", sort_order: 2 },
    ]);

    await app.close();
  });

  it("writes every supported resource atomically and produces a secret-free review report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-script-source-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const actor = await db.prepare("SELECT id FROM admin_users WHERE is_platform_admin = 1").get() as { id: string };
    const sourceId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'personal', ?, 'script_sync', ?, ?, ?, ?)`)
      .run(sourceId, actor.id, "Inventory", app.secrets.encrypt("{}"), now, now);
    await db.prepare(`INSERT INTO ssh_connections (id, workspace_type, workspace_id, name, host, port, username, auth_type, credential_ciphertext, options_json, created_at, updated_at) VALUES (?, 'personal', ?, 'Manual only', '127.0.0.1', 22, 'root', 'password', ?, '{}', ?, ?)`)
      .run(crypto.randomUUID(), actor.id, app.secrets.encrypt("{}"), now, now);
    const generatedKey = generateSshKeyPair("ed25519", "", "sync-test");

    const payload = parseScriptSyncOutput(JSON.stringify({
      schemaVersion: 1,
      environmentGroups: [{ name: "Production", description: "managed" }],
      environments: [{ group: "Production", name: "Application", tags: ["prod"] }],
      webEntries: [{ environment: { group: "Production", name: "Application" }, name: "Console", url: "https://example.com", credentials: [{ username: "operator", password: "web-secret" }] }],
      connectionGroups: [{ type: "ssh", path: "Production/App" }, { type: "database", path: "Production/Data" }, { type: "redis", path: "Production/Cache" }],
      sshKeys: [{ name: "Application key", privateKey: generatedKey.privateKey }],
      sshConnections: [{ name: "App SSH", environments: [{ group: "Production", name: "Application" }], groupPath: "Production/App", host: "10.0.0.10", username: "root", authType: "privateKey", keyName: "Application key" }],
      databaseConnections: [{ name: "App DB", environments: [{ group: "Production", name: "Application" }], groupPath: "Production/Data", engine: "mysql", host: "10.0.0.11", port: 3306, username: "db", credential: { password: "db-secret" }, connectionMode: "sshTunnel", sshConnection: "App SSH", profiles: [{ name: "Read only", engine: "mysql", host: "10.0.0.12", port: 3306, username: "reader", credential: { password: "profile-secret" } }] }],
      redisConnections: [{ name: "App Redis", environments: [{ group: "Production", name: "Application" }], groupPath: "Production/Cache", host: "10.0.0.13", username: "cache", credential: { password: "redis-secret" }, connectionMode: "sshTunnel", sshConnection: "App SSH" }],
      environmentLogs: [{ environment: { group: "Production", name: "Application" }, sshConnection: "App SSH", name: "Application log", filePaths: ["/var/log/app.log"] }],
    }));
    const source = { id: sourceId, name: "Inventory", config_ciphertext: "", workspace_type: "personal" as const, workspace_id: actor.id };
    const first = await applyScriptSyncPayload(app, source, payload, "overwrite", actor.id);
    expect(first.summary).toMatchObject({ created: 16, updated: 0, ignored: 0 });
    expect(first.items.some((item) => item.action === "missing" && item.name === "Manual only")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("web-secret");
    expect(JSON.stringify(first)).not.toContain("ssh-secret");
    expect(JSON.stringify(first)).not.toContain("db-secret");
    expect((await db.prepare("SELECT COUNT(*) AS count FROM environment_groups").get() as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM environments").get() as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM web_entries").get() as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM web_credentials").get() as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ssh_keys").get() as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ssh_connections WHERE source_id = ?").get(sourceId) as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM database_connections WHERE source_id = ?").get(sourceId) as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM redis_connections WHERE source_id = ?").get(sourceId) as { count: number }).count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM environment_logs").get() as { count: number }).count).toBe(1);

    const ignoredPayload = { ...payload, sshConnections: payload.sshConnections.map((row) => ({ ...row, host: "10.0.0.99" })) };
    const ignored = await applyScriptSyncPayload(app, source, ignoredPayload, "ignore", actor.id);
    expect(ignored.summary.ignored).toBeGreaterThan(0);
    expect((await db.prepare("SELECT host FROM ssh_connections WHERE source_id = ?").get(sourceId) as { host: string }).host).toBe("10.0.0.10");
    const overwritten = await applyScriptSyncPayload(app, source, ignoredPayload, "overwrite", actor.id);
    expect(overwritten.summary.updated).toBeGreaterThan(0);
    expect((await db.prepare("SELECT host FROM ssh_connections WHERE source_id = ?").get(sourceId) as { host: string }).host).toBe("10.0.0.99");
    await app.close();
  });

  it("executes through the runner socket and stores only a sanitized scheduled report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-script-runner-test-"));
    directories.push(directory);
    const config = configFor(directory);
    config.scriptRunnerSocket = join(directory, "runner.sock");
    const runner = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const stdout = JSON.stringify({ schemaVersion: 1, environments: [{ name: "Runner environment" }], webEntries: [{ environment: { group: null, name: "Runner environment" }, name: "Runner web", url: "https://example.com", credentials: [{ username: "review", password: "runner-secret" }] }] });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ exitCode: 0, stdout, stderr: "" }));
      });
    });
    runner.listen(config.scriptRunnerSocket);
    await once(runner, "listening");
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const actor = await db.prepare("SELECT id FROM admin_users WHERE is_platform_admin = 1").get() as { id: string };
    const sourceId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'personal', ?, 'script_sync', 'Runner', ?, ?, ?)`)
      .run(sourceId, actor.id, app.secrets.encrypt(JSON.stringify({ script: "printf json", conflictStrategy: "overwrite" })), now, now);
    const result = await syncScriptSource(app, sourceId, undefined, "schedule");
    expect(result).toMatchObject({ created: 3, updated: 0 });
    const report = await db.prepare("SELECT status, summary_json, items_json FROM connection_source_runs WHERE id = ?").get(result.runId) as { status: string; summary_json: string; items_json: string };
    expect(report.status).toBe("success");
    expect(`${report.summary_json}${report.items_json}`).not.toContain("runner-secret");
    await app.close();
    runner.close();
    await once(runner, "close");
  });
});
