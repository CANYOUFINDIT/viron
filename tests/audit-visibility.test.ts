import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { writeAudit } from "../src/server/audit.js";

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
    masterKey: Buffer.alloc(32, 31),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function register(app: Awaited<ReturnType<typeof buildApp>>, username: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username, password: username } });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id as string,
    cookies: { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value },
  };
}

describe("organization audit visibility", () => {
  it("identifies actors across events, recordings, and query history without widening member access", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-audit-visibility-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const alice = await register(app, "alice");
    const bob = await register(app, "bob");
    const organization = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      cookies: alice.cookies,
      payload: { name: "Audit Organization", description: "" },
    });
    const organizationId = organization.json().id as string;
    const now = new Date().toISOString();
    await app.db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, 'member', ?, ?)
    `).run(organizationId, bob.id, now, now);
    for (const user of [alice, bob]) {
      const switched = await app.inject({
        method: "PUT",
        url: "/api/v1/auth/workspace",
        cookies: user.cookies,
        payload: { type: "organization", id: organizationId },
      });
      expect(switched.statusCode).toBe(200);
    }

    const sshConnectionId = crypto.randomUUID();
    const databaseConnectionId = crypto.randomUUID();
    await app.db.prepare(`
      INSERT INTO ssh_connections (
        id, workspace_type, workspace_id, name, host, port, username, auth_type,
        credential_ciphertext, options_json, created_at, updated_at
      ) VALUES (?, 'organization', ?, 'Shared SSH', 'ssh.internal', 22, 'operator', 'password', ?, '{}', ?, ?)
    `).run(sshConnectionId, organizationId, app.secrets.encrypt("{}"), now, now);
    await app.db.prepare(`
      INSERT INTO database_connections (
        id, workspace_type, workspace_id, name, engine, host, port, username,
        credential_ciphertext, created_at, updated_at
      ) VALUES (?, 'organization', ?, 'Shared Database', 'mysql', 'db.internal', 3306, 'reader', ?, ?, ?)
    `).run(databaseConnectionId, organizationId, app.secrets.encrypt("{}"), now, now);
    for (const [resourceType, resourceId] of [["ssh_connection", sshConnectionId], ["database_connection", databaseConnectionId]]) {
      await app.db.prepare(`
        INSERT INTO resource_grants (
          id, organization_id, grantee_type, grantee_id, resource_type, resource_id,
          created_by_user_id, created_at
        ) VALUES (?, ?, 'user', ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), organizationId, bob.id, resourceType, resourceId, alice.id, now);
    }

    for (const [index, user] of [alice, bob].entries()) {
      await writeAudit(app.db, {
        action: "test.operation",
        resourceType: "database_connection",
        resourceId: databaseConnectionId,
        summary: `执行测试操作 ${index + 1}`,
        details: { status: "success", durationMs: index + 10 },
        actorUserId: user.id,
        workspaceType: "organization",
        workspaceId: organizationId,
        source: index === 0 ? "manual" : "mcp",
      });
      await app.db.prepare(`
        INSERT INTO ssh_terminal_recordings (
          id, owner_user_id, session_id, connection_id, connection_name, host,
          recording_path, status, size_bytes, started_at, ended_at, close_reason
        ) VALUES (?, ?, ?, ?, 'Shared SSH', 'ssh.internal', ?, 'completed', 128, ?, ?, '测试结束')
      `).run(crypto.randomUUID(), user.id, crypto.randomUUID(), sshConnectionId, join(directory, `${user.id}.cast`), now, now);
      await app.db.prepare(`
        INSERT INTO database_query_history (
          id, owner_user_id, connection_id, database_name, sql_text, status,
          duration_ms, row_count, error_message, created_at
        ) VALUES (?, ?, ?, 'envman', ?, 'success', 12, 1, '', ?)
      `).run(crypto.randomUUID(), user.id, databaseConnectionId, `SELECT '${user.id}'`, now);
    }
    await writeAudit(app.db, {
      action: "capacity.checked",
      resourceType: "database_connection",
      resourceId: databaseConnectionId,
      summary: "CPU reached 90%",
      actorUserId: alice.id,
      workspaceType: "organization",
      workspaceId: organizationId,
    });

    const oldEventId = crypto.randomUUID();
    const oldRecordingId = crypto.randomUUID();
    const oldQueryId = crypto.randomUUID();
    const oldCreatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await app.db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, workspace_type, workspace_id, action, resource_type,
        resource_id, summary, details_json, created_at
      ) VALUES (?, ?, 'organization', ?, 'old.operation', 'database_connection', ?, 'Old operation', '{}', ?)
    `).run(oldEventId, bob.id, organizationId, databaseConnectionId, oldCreatedAt);
    await app.db.prepare(`
      INSERT INTO ssh_terminal_recordings (
        id, owner_user_id, session_id, connection_id, connection_name, host,
        recording_path, status, size_bytes, started_at, ended_at, close_reason
      ) VALUES (?, ?, ?, ?, 'Old SSH', 'old.internal', ?, 'completed', 64, ?, ?, 'Old close')
    `).run(oldRecordingId, bob.id, crypto.randomUUID(), sshConnectionId, join(directory, "old.cast"), oldCreatedAt, oldCreatedAt);
    await app.db.prepare(`
      INSERT INTO database_query_history (
        id, owner_user_id, connection_id, database_name, sql_text, status,
        duration_ms, row_count, error_message, created_at
      ) VALUES (?, ?, ?, 'old_database', 'SELECT old_secret', 'success', 1, 1, '', ?)
    `).run(oldQueryId, bob.id, databaseConnectionId, oldCreatedAt);

    const adminEvents = await app.inject({ method: "GET", url: "/api/v1/audit-events?limit=200", cookies: alice.cookies });
    const testEvents = adminEvents.json().items.filter((item: { action: string }) => item.action === "test.operation");
    expect(testEvents.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(expect.arrayContaining(["alice", "bob"]));
    expect(testEvents[0].details).toMatchObject({ status: "success" });

    const adminRecordings = await app.inject({ method: "GET", url: "/api/v1/ssh-recordings", cookies: alice.cookies });
    expect(adminRecordings.json().items.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(expect.arrayContaining(["alice", "bob"]));
    const adminQueries = await app.inject({ method: "GET", url: "/api/v1/database-query-history", cookies: alice.cookies });
    expect(adminQueries.json().items.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(expect.arrayContaining(["alice", "bob"]));

    const actors = await app.inject({ method: "GET", url: "/api/v1/audit-actors", cookies: alice.cookies });
    expect(actors.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alice.id, username: "alice" }),
      expect.objectContaining({ id: bob.id, username: "bob" }),
    ]));
    const firstEventPage = await app.inject({ method: "GET", url: "/api/v1/audit-events?pageSize=1&q=test.operation", cookies: alice.cookies });
    expect(firstEventPage.json()).toMatchObject({ page: 1, pageSize: 1, hasMore: true, retentionDays: 30 });
    expect(firstEventPage.json().items).toHaveLength(1);
    const secondEventPage = await app.inject({ method: "GET", url: "/api/v1/audit-events?page=2&pageSize=1&q=test.operation", cookies: alice.cookies });
    expect(secondEventPage.json()).toMatchObject({ page: 2, pageSize: 1, hasMore: false });
    expect(secondEventPage.json().items).toHaveLength(1);
    const bobEvents = await app.inject({ method: "GET", url: `/api/v1/audit-events?actorUserId=${bob.id}&q=%E6%B5%8B%E8%AF%95%E6%93%8D%E4%BD%9C`, cookies: alice.cookies });
    expect(bobEvents.json().items.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(["bob"]);
    const mcpEvents = await app.inject({ method: "GET", url: "/api/v1/audit-events?source=mcp", cookies: alice.cookies });
    expect(mcpEvents.json().items).toEqual([expect.objectContaining({ source: "mcp", actor: expect.objectContaining({ username: "bob" }) })]);
    const bobRecordings = await app.inject({ method: "GET", url: `/api/v1/ssh-recordings?actorUserId=${bob.id}&q=Shared%20SSH`, cookies: alice.cookies });
    expect(bobRecordings.json().items.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(["bob"]);
    const bobQueries = await app.inject({ method: "GET", url: `/api/v1/database-query-history?actorUserId=${bob.id}&q=Shared%20Database`, cookies: alice.cookies });
    expect(bobQueries.json().items.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(["bob"]);
    const sqlBodySearch = await app.inject({ method: "GET", url: "/api/v1/database-query-history?q=SELECT", cookies: alice.cookies });
    expect(sqlBodySearch.json().items).toEqual([]);
    const literalWildcardSearch = await app.inject({ method: "GET", url: "/api/v1/audit-events?q=%25", cookies: alice.cookies });
    expect(literalWildcardSearch.json().items.map((item: { summary: string }) => item.summary)).toEqual(["CPU reached 90%"]);
    for (const endpoint of ["audit-events", "ssh-recordings", "database-query-history"]) {
      const old = await app.inject({ method: "GET", url: `/api/v1/${endpoint}?q=Old`, cookies: alice.cookies });
      expect(old.json().items).toEqual([]);
    }

    const memberEvents = await app.inject({ method: "GET", url: "/api/v1/audit-events?limit=200", cookies: bob.cookies });
    expect(memberEvents.json().items.filter((item: { action: string }) => item.action === "test.operation").map((item: { actor: { username: string } }) => item.actor.username)).toEqual(["bob"]);
    const memberRecordings = await app.inject({ method: "GET", url: "/api/v1/ssh-recordings", cookies: bob.cookies });
    expect(memberRecordings.json().items.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(["bob"]);
    const memberQueries = await app.inject({ method: "GET", url: "/api/v1/database-query-history", cookies: bob.cookies });
    expect(memberQueries.json().items.map((item: { actor: { username: string } }) => item.actor.username)).toEqual(["bob"]);

    await app.sshSessions.initialize();
    expect(await app.db.prepare("SELECT id FROM audit_events WHERE id = ?").get(oldEventId)).toBeUndefined();
    expect(await app.db.prepare("SELECT id FROM ssh_terminal_recordings WHERE id = ?").get(oldRecordingId)).toBeUndefined();
    expect(await app.db.prepare("SELECT id FROM database_query_history WHERE id = ?").get(oldQueryId)).toBeUndefined();

    await app.close();
  });
});
