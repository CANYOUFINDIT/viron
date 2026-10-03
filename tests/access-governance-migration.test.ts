import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { MysqlDatabaseClient, SqliteDatabaseClient, type EnvmanDatabase } from "../src/server/database-client.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { MYSQL_SCHEMA } from "../src/server/mysql-schema.js";
import { SQLITE_SCHEMA } from "../src/server/sqlite-schema.js";

const mysqlEnabled = process.env.VIRON_ACCESS_MYSQL_TEST === "1";
const mysqlHost = process.env.VIRON_ACCESS_MYSQL_HOST || "127.0.0.1";
const mysqlPort = Number(process.env.VIRON_ACCESS_MYSQL_PORT ?? 13321);
const containerName = `viron-access-migration-${process.pid}`;
let containerStarted = false;

beforeAll(async () => {
  if (!mysqlEnabled) return;
  if (!process.env.VIRON_ACCESS_MYSQL_HOST) {
    execFileSync("docker", ["run", "-d", "--name", containerName,
      "-e", "MYSQL_ROOT_PASSWORD=test", "-e", "MYSQL_DATABASE=viron_access_migration",
      "-p", `127.0.0.1:${mysqlPort}:3306`, "mariadb:11.4"], { stdio: "pipe" });
    containerStarted = true;
  }
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      const connection = await mysql.createConnection({ host: mysqlHost, port: mysqlPort, user: "root", password: "test", database: "viron_access_migration" });
      await connection.end();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}, 60_000);

afterAll(() => {
  if (containerStarted) execFileSync("docker", ["rm", "-f", containerName], { stdio: "pipe" });
});

async function verifyLegacyUpgrade(dialect: "sqlite" | "mysql") {
  const directory = mkdtempSync(join(tmpdir(), `viron-access-migration-${dialect}-`));
  const config: AppConfig = {
    nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "test.db"),
    masterKey: Buffer.alloc(32, 19), adminUsername: "admin", adminPassword: "test-password-123",
    allowWeakPasswords: true, sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30,
    ...(dialect === "mysql" ? { databaseDriver: "mysql", databaseHost: mysqlHost, databasePort: mysqlPort,
      databaseName: "viron_access_migration", databaseUsername: "root", databasePassword: "test" } : {}),
  };
  let db: EnvmanDatabase = dialect === "sqlite"
    ? new SqliteDatabaseClient(new Database(config.databasePath))
    : new MysqlDatabaseClient({ host: mysqlHost, port: mysqlPort, database: config.databaseName!, user: "root", password: "test", connectionLimit: 2 });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const schema = dialect === "sqlite"
      ? SQLITE_SCHEMA.replace("  event_order INTEGER PRIMARY KEY AUTOINCREMENT,\n  id TEXT NOT NULL UNIQUE,", "  id TEXT PRIMARY KEY,")
      : MYSQL_SCHEMA.replace("  event_order BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  id VARCHAR(64) NOT NULL UNIQUE,", "  id VARCHAR(64) PRIMARY KEY,");
    await db.exec(schema);
    await ensureAdmin(db, config);
    app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    expect(login.statusCode).toBe(200);
    const userId = login.json().user.id as string;
    const cookies = { envman_session: login.cookies.find((cookie) => cookie.name === "envman_session")!.value };
    const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "迁移示例组织" } });
    expect(organization.statusCode).toBe(201);
    const organizationId = organization.json().id as string;
    const base = `/api/v1/organizations/${organizationId}`;
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "迁移示例环境" } });
    expect(environment.statusCode).toBe(201);
    const draft = { granteeType: "user", granteeId: userId, scopeKind: "environment", targetIds: [environment.json().id], permissions: { web: ["view"] }, reason: "主动授权迁移测试" };
    const grant = await app.inject({ method: "POST", url: `${base}/grants`, cookies, payload: draft });
    expect(grant.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `${base}/approval-workflow`, cookies })).json().workflow).toBeNull();
    const failedLedger = await app.inject({ method: "GET", url: `${base}/access-history`, cookies });
    expect(failedLedger.statusCode).toBe(500);
    expect(failedLedger.json().message).toContain("event_order");

    expect((await app.inject({ method: "PUT", url: `${base}/approval-workflow`, cookies, payload: { name: "示例审批", stages: [{ name: "确认", approverIds: [userId] }] } })).statusCode).toBe(200);
    const request = await app.inject({ method: "POST", url: `${base}/access-requests`, cookies, payload: { ...draft, reason: "申请迁移测试" } });
    expect(request.statusCode).toBe(201);
    const requestId = request.json().id as string;
    const originalEvents = await db.prepare("SELECT * FROM access_governance_events ORDER BY created_at, id").all<Record<string, unknown>>();
    expect(originalEvents).toHaveLength(3);
    await app.close();
    app = undefined;

    db = await openDatabase(config);
    const migratedEvents = await db.prepare("SELECT * FROM access_governance_events ORDER BY created_at, id").all<Record<string, unknown>>();
    expect(migratedEvents.map(({ event_order: _order, ...event }) => event)).toEqual(originalEvents);
    expect(new Set(migratedEvents.map((event) => Number(event.event_order))).size).toBe(3);
    expect(migratedEvents.every((event) => Number(event.event_order) > 0)).toBe(true);
    app = await buildApp({ config, db, logger: false });
    const ledger = await app.inject({ method: "GET", url: `${base}/access-history?grantId=${grant.json().id}`, cookies });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().items).toEqual([expect.objectContaining({ action: "granted", source: "direct", reason: draft.reason,
      after: expect.objectContaining({ granteeId: userId, targetIds: draft.targetIds, permissions: draft.permissions, granteeName: "admin", label: "迁移示例环境" }) })]);
    expect((await app.inject({ method: "GET", url: `${base}/access-requests/${requestId}`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${base}/access-requests/${requestId}/decisions`, cookies, payload: { decision: "approve", reason: "迁移后确认" } })).statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `${base}/access-requests/${requestId}`, cookies });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().events.map((event: { action: string }) => event.action)).toEqual(["requested", "approved", "granted"]);
    const updated = await app.inject({ method: "PUT", url: `${base}/grants/${grant.json().id}`, cookies, payload: { ...draft, permissions: { web: ["manage"] }, reason: "升级后修改授权" } });
    expect(updated.statusCode).toBe(200);
    // Events sharing a timestamp still sort by insertion order, including across pages.
    await db.prepare("UPDATE access_governance_events SET created_at = ? WHERE grant_id = ?").run("2026-01-01T00:00:00.000Z", grant.json().id);
    const pageOne = await app.inject({ method: "GET", url: `${base}/access-history?grantId=${grant.json().id}&pageSize=1`, cookies });
    const pageTwo = await app.inject({ method: "GET", url: `${base}/access-history?grantId=${grant.json().id}&pageSize=1&page=2`, cookies });
    expect(pageOne.statusCode).toBe(200);
    expect(pageOne.json()).toMatchObject({ items: [{ action: "updated" }], hasMore: true });
    expect(pageTwo.json()).toMatchObject({ items: [{ action: "granted" }], hasMore: false });
    const beforeReopen = await db.prepare("SELECT * FROM access_governance_events ORDER BY event_order").all();
    await app.close();
    app = undefined;
    db = await openDatabase(config);
    expect(await db.prepare("SELECT * FROM access_governance_events ORDER BY event_order").all()).toEqual(beforeReopen);
    if (dialect === "sqlite") expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    if (app) await app.close();
    else await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("access governance database upgrades", () => {
  it("preserves legacy SQLite events and restores direct grants, request details and pagination", () => verifyLegacyUpgrade("sqlite"), 30_000);
  it.skipIf(!mysqlEnabled)("preserves legacy MariaDB events and restores direct grants, request details and pagination", () => verifyLegacyUpgrade("mysql"), 30_000);
});
