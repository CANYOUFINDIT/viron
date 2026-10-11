import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  sql: [] as string[],
  hang: false,
  holdConnect: false,
  continueConnect: [] as Array<() => void>,
  cancel: [] as Array<() => void>,
}));

vi.mock("../src/server/database-workbench/connector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/database-workbench/connector.js")>();
  return {
    ...actual,
    connectDatabase: async () => {
      if (gate.holdConnect) await new Promise<void>((resolve) => gate.continueConnect.push(resolve));
      const pending: Array<() => void> = [];
      const finish = () => {
        for (const release of pending.splice(0)) release();
      };
      gate.cancel.push(finish);
      return {
        connection: {
          query(sql: string) {
            gate.sql.push(sql);
            if (!gate.hang) return Promise.resolve([[{ ok: 1 }], [{ name: "ok", table: "", type: 3 }]]);
            return new Promise((resolve) => {
              pending.push(() => resolve([[{ ok: 1 }], [{ name: "ok", table: "", type: 3 }]]));
            });
          },
          destroy: finish,
        },
        async close() {},
        record: { name: "fixture" },
      };
    },
  };
});

import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { disconnectGrantees } from "../src/server/access-expiry.js";

const scratchRoot = join(process.cwd(), "private", "grok-supervision-20261011");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  gate.hang = false;
  gate.holdConnect = false;
  for (const release of gate.continueConnect.splice(0)) release();
  for (const cancel of gate.cancel.splice(0)) cancel();
  gate.sql.length = 0;
  for (const finish of cleanup.splice(0)) await finish();
});

async function fixture() {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "viron-sql-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 9),
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
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "SQL权限组织" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产" } });
  expect(environment.statusCode, environment.body).toBe(201);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/database-connections",
    cookies,
    payload: { name: "虚构库", engine: "mysql", host: "127.0.0.1", port: 9, username: "fake", credential: { password: "fake" }, environmentIds: [environment.json().id] },
  });
  expect(created.statusCode, created.body).toBe(201);
  const connectionId = created.json().id as string;
  const base = `/api/v1/organizations/${org}`;
  let host = 1;
  async function member(name: string, codes: string[]) {
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      remoteAddress: `192.0.2.${host++}`,
      payload: { username: name, password: "test-password-123" },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const userId = registered.json().user.id as string;
    const session = { envman_session: registered.cookies[0].value };
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, now, now);
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: session, payload: { type: "organization", id: org } })).statusCode).toBe(200);
    const roleName = `${name}-${randomUUID()}`;
    const role = await app.inject({
      method: "POST",
      url: `${base}/roles`,
      cookies,
      payload: { name: roleName, permissionCodes: codes, reason: "SQL权限" },
    });
    expect(role.statusCode, role.body).toBe(201);
    const roleId = role.json().id as string;
    const assignment = await app.inject({
      method: "POST",
      url: `${base}/role-assignments`,
      cookies,
      payload: { roleId, subjectType: "user", subjectId: userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "分配" },
    });
    expect(assignment.statusCode, assignment.body).toBe(201);
    const grant = await app.inject({
      method: "POST",
      url: `${base}/role-data-grants`,
      cookies,
      payload: { roleId, targets: [{ type: "database_connection", id: connectionId }], reason: "目标连接" },
    });
    expect(grant.statusCode, grant.body).toBe(201);
    return { userId, cookies: session, roleId, roleName };
  }
  return { app, cookies, org, base, connectionId, member };
}

async function waitJob(app: Awaited<ReturnType<typeof fixture>>["app"], id: string, userId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = app.databaseQueries.get(id, userId, null);
    if (job && !["pending", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("query did not finish");
}

describe("organization SQL query permissions", () => {
  it("does not send SQL after the grant disappears while the connection is opening", async () => {
    const f = await fixture();
    const writer = await f.member("queued-write", ["database.write"]);
    gate.holdConnect = true;
    const started = await f.app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${f.connectionId}/queries`,
      cookies: writer.cookies,
      payload: { sql: "UPDATE example SET value=1", database: "example" },
    });
    expect(started.statusCode, started.body).toBe(202);
    await vi.waitFor(() => expect(gate.continueConnect.length).toBe(1));
    const revoked = await f.app.inject({
      method: "PUT",
      url: `${f.base}/roles/${writer.roleId}`,
      cookies: f.cookies,
      payload: { name: writer.roleName, description: "", permissionCodes: ["database.read"], enabled: true, reason: "执行前撤销写入" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    gate.continueConnect.shift()?.();
    const job = await waitJob(f.app, started.json().job.id, writer.userId);
    expect(job).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(gate.sql).not.toContain("UPDATE example SET value=1");
  });

  it("executes the statement when its actual codes are present and rejects the rest", async () => {
    const f = await fixture();
    const writer = await f.member("write-only", ["database.write"]);
    const ddl = await f.member("ddl-only", ["database.ddl"]);
    const reader = await f.member("read-only", ["database.read"]);
    const both = await f.member("write-ddl", ["database.write", "database.ddl"]);
    const structure = await f.member("read-ddl", ["database.read", "database.ddl"]);
    const locked = await f.member("read-write", ["database.read", "database.write"]);
    const full = await f.member("all-sql", ["database.read", "database.export", "database.write", "database.ddl"]);
    const post = (actor: { cookies: { envman_session: string } }, sql: string) => f.app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${f.connectionId}/queries`,
      cookies: actor.cookies,
      payload: { sql, database: "example" },
    });

    const update = await post(writer, "UPDATE example SET value=1");
    expect(update.statusCode, update.body).toBe(202);
    const updateJob = await waitJob(f.app, update.json().job.id, writer.userId);
    expect(updateJob.status).toBe("success");
    expect(gate.sql).toContain("UPDATE example SET value=1");
    const visible = await f.app.inject({ method: "GET", url: `/api/v1/database-queries/${update.json().job.id}`, cookies: writer.cookies });
    expect(visible.statusCode, visible.body).toBe(200);

    const created = await post(ddl, "CREATE TABLE ddl_example(id int)");
    expect(created.statusCode, created.body).toBe(202);
    expect((await waitJob(f.app, created.json().job.id, ddl.userId)).status).toBe("success");
    expect(gate.sql).toContain("CREATE TABLE ddl_example(id int)");

    const beforeDenied = gate.sql.length;
    for (const [actor, sql] of [
      [reader, "UPDATE example SET value=1"],
      [reader, "CREATE TABLE hidden(id int)"],
      [writer, "CREATE TABLE example(id int); UPDATE example SET id=2"],
      [ddl, "CREATE TABLE example(id int); UPDATE example SET id=2"],
      [writer, "/*!50000 CREATE TABLE example(id int) */"],
      [reader, "SELECT 1--1; DROP TABLE sql_comment_probe"],
      [writer, "/*M! CREATE TABLE mariadb_comment_probe(id INT) */"],
      [writer, "SELECT * FROM example FOR UPDATE"],
      [structure, "CREATE TABLE selected_rows AS SELECT * FROM example"],
      [writer, "SET @acceptance_sql='CREATE TABLE dynamic_sql_probe(id INT)'; PREPARE acceptance_stmt FROM @acceptance_sql; EXECUTE acceptance_stmt; DEALLOCATE PREPARE acceptance_stmt"],
      [writer, "CALL copy_rows()"],
      [writer, "GRANT SELECT ON example.* TO fictional"],
      [writer, "/* user's ordinary comment */ CREATE TABLE quoted_comment_probe(id INT)"],
      [reader, "SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'; SELECT '\\'; CREATE TABLE sqlmode_comment_probe(id INT); -- '"],
    ] as const) {
      const denied = await post(actor, sql);
      expect(denied.statusCode, denied.body).toBe(403);
    }
    expect(gate.sql).toHaveLength(beforeDenied);

    for (const [actor, sql] of [
      [reader, "SELECT 'FOR UPDATE' AS label"],
      [reader, "SELECT 1--1"],
      [reader, "/* user's ordinary comment */ SELECT 1"],
      [reader, "SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'; SELECT 1"],
      [reader, "SELECT '\\'; CREATE TABLE hidden(id INT); -- '"],
      [reader, "WITH x AS (SELECT 'DROP TABLE foo' AS label) SELECT * FROM x"],
      [writer, "UPDATE example SET label='create drop alter'"],
      [writer, "SET @acceptance_sql=1"],
      [ddl, "/*!50000 CREATE TABLE executable_example(id int) */"],
      [ddl, "/*M! CREATE TABLE mariadb_direct(id INT) */"],
      [locked, "SELECT * FROM example FOR UPDATE"],
      [both, "CREATE TABLE example(id int); UPDATE example SET id=2"],
      [full, "CREATE TABLE selected_rows AS SELECT * FROM example"],
    ] as const) {
      const allowed = await post(actor, sql);
      expect(allowed.statusCode, allowed.body).toBe(202);
      expect((await waitJob(f.app, allowed.json().job.id, actor.userId)).status).toBe("success");
      expect(gate.sql).toContain(sql);
    }
  });

  it("cancels a running query when its own operation is revoked", async () => {
    const f = await fixture();
    const actor = await f.member("query-recheck", ["database.read", "database.write", "database.ddl"]);
    gate.hang = true;
    const start = async (sql: string) => {
      const response = await f.app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${f.connectionId}/queries`,
        cookies: actor.cookies,
        payload: { sql, database: "example" },
      });
      expect(response.statusCode, response.body).toBe(202);
      return response.json().job.id as string;
    };
    const selectId = await start("SELECT id FROM example");
    const updateId = await start("UPDATE example SET value=1");
    const alterId = await start("ALTER TABLE example ADD COLUMN note INT");
    await vi.waitFor(() => expect(gate.sql).toEqual([
      "SELECT id FROM example",
      "UPDATE example SET value=1",
      "ALTER TABLE example ADD COLUMN note INT",
    ]));
    const put = async (permissionCodes: string[]) => {
      const response = await f.app.inject({
        method: "PUT",
        url: `${f.base}/roles/${actor.roleId}`,
        cookies: f.cookies,
        payload: { name: actor.roleName, description: "", permissionCodes, enabled: true, reason: "复核" },
      });
      expect(response.statusCode, response.body).toBe(200);
      await disconnectGrantees(f.app, f.org, [actor.userId]);
    };
    await put(["database.read", "database.ddl"]);
    expect(f.app.databaseQueries.get(updateId, actor.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(f.app.databaseQueries.get(selectId, actor.userId)?.status).toBe("running");
    expect(f.app.databaseQueries.get(alterId, actor.userId)?.status).toBe("running");
    await put(["database.read"]);
    expect(f.app.databaseQueries.get(alterId, actor.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(f.app.databaseQueries.get(selectId, actor.userId)?.status).toBe("running");
  });
});
