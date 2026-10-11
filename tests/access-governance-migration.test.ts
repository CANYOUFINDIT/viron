import { randomUUID } from "node:crypto";
import {
  roleState,
  loadOrganizationAccess,
} from "../src/server/organization-rbac.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import {
  MysqlDatabaseClient,
  SqliteDatabaseClient,
  type EnvmanDatabase,
} from "../src/server/database-client.js";
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
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        containerName,
        "-e",
        "MYSQL_ROOT_PASSWORD=test",
        "-e",
        "MYSQL_DATABASE=viron_access_migration",
        "-p",
        `127.0.0.1:${mysqlPort}:3306`,
        "mariadb:11.4",
      ],
      { stdio: "pipe" },
    );
    containerStarted = true;
  }
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      const connection = await mysql.createConnection({
        host: mysqlHost,
        port: mysqlPort,
        user: "root",
        password: "test",
        database: "viron_access_migration",
      });
      await connection.end();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}, 60_000);

afterAll(() => {
  if (containerStarted)
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "pipe" });
});

async function verifyLegacyUpgrade(dialect: "sqlite" | "mysql") {
  const directory = mkdtempSync(
    join(tmpdir(), `viron-access-migration-${dialect}-`),
  );
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "test.db"),
    masterKey: Buffer.alloc(32, 19),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
    ...(dialect === "mysql"
      ? {
          databaseDriver: "mysql",
          databaseHost: mysqlHost,
          databasePort: mysqlPort,
          databaseName: "viron_access_migration",
          databaseUsername: "root",
          databasePassword: "test",
        }
      : {}),
  };
  let db: EnvmanDatabase =
    dialect === "sqlite"
      ? new SqliteDatabaseClient(new Database(config.databasePath))
      : new MysqlDatabaseClient({
          host: mysqlHost,
          port: mysqlPort,
          database: config.databaseName!,
          user: "root",
          password: "test",
          connectionLimit: 2,
        });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const schema =
      dialect === "sqlite"
        ? SQLITE_SCHEMA.replace(
            "  event_order INTEGER PRIMARY KEY AUTOINCREMENT,\n  id TEXT NOT NULL UNIQUE,",
            "  id TEXT PRIMARY KEY,",
          )
        : MYSQL_SCHEMA.replace(
            "  event_order BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  id VARCHAR(64) NOT NULL UNIQUE,",
            "  id VARCHAR(64) PRIMARY KEY,",
          );
    await db.exec(schema);
    await ensureAdmin(db, config);
    const user = await db
      .prepare("SELECT id FROM admin_users WHERE username='admin'")
      .get<{ id: string }>();
    const userId = user!.id,
      org = randomUUID(),
      env = randomUUID(),
      entry = randomUUID(),
      grant = randomUUID(),
      now = new Date().toISOString(),
      expires = new Date(Date.now() + 3600000).toISOString();
    await db
      .prepare(
        "INSERT INTO organizations (id,name,description,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(org, "迁移示例组织", "", userId, now, now);
    await db
      .prepare(
        "INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'admin',?,?)",
      )
      .run(org, userId, now, now);
    await db
      .prepare(
        "INSERT INTO environments (id,workspace_type,workspace_id,name,description,tags_json,created_at,updated_at) VALUES (?,'organization',?,?,'','[]',?,?)",
      )
      .run(env, org, "迁移环境", now, now);
    await db
      .prepare(
        "INSERT INTO web_entries (id,environment_id,name,url,description,tags_json,login_config_json,created_at,updated_at) VALUES (?,?,?,?,'','[]','{}',?,?)",
      )
      .run(entry, env, "历史入口", "https://example.invalid", now, now);
    await db
      .prepare(
        "INSERT INTO access_authorizations (id,organization_id,grantee_type,grantee_id,scope_kind,whole_group,permissions_json,items_json,expires_at,created_by_user_id,created_at,updated_at) VALUES (?,?,'user',?,'environment',0,?, '{}',?,?,?,?)",
      )
      .run(
        grant,
        org,
        userId,
        JSON.stringify({ web: ["view"] }),
        expires,
        userId,
        now,
        now,
      );
    await db
      .prepare(
        "INSERT INTO access_authorization_targets (authorization_id,resource_id) VALUES (?,?)",
      )
      .run(grant, env);
    const event = randomUUID();
    await db
      .prepare(
        "INSERT INTO access_governance_events (id,organization_id,grant_id,action,source,actor_id,actor_name,reason,details_json,created_at) VALUES (?,?,?,'granted','direct',?,'admin','历史原因','{}',?)",
      )
      .run(event, org, grant, userId, now);
    await db.close();
    db = await openDatabase(config);
    expect(
      (await db
        .prepare(
          "SELECT event_order,reason FROM access_governance_events WHERE id=?",
        )
        .get<{ event_order: number; reason: string }>(event))!.event_order,
    ).toBeGreaterThan(0);
    const state = await roleState(db, org);
    expect(state.featureGrants).toEqual([]);
    const migratedRole = state.roles.find((r) =>
      r.name.startsWith("迁移web授权"),
    )!;
    expect(migratedRole.permissionCodes).toEqual(["web.view"]);
    expect(
      state.dataGrants.filter((g) => g.roleId === migratedRole.id),
    ).toMatchObject([
      { target: { type: "web_entry", id: entry }, expiresAt: expires },
    ]);
    expect(
      (await loadOrganizationAccess(db, org, userId)).allows("web.view", {
        type: "web_entry",
        id: entry,
      }),
    ).toBe(true);
    await db.close();
    db = await openDatabase(config);
    expect((await roleState(db, org)).roles).toHaveLength(state.roles.length);
    app = await buildApp({ config, db, logger: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: config.adminPassword },
    });
    const cookies = { envman_session: login.cookies[0].value };
    await app.inject({
      method: "PUT",
      url: "/api/v1/auth/workspace",
      cookies,
      payload: { type: "organization", id: org },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/organizations/${org}/grants`,
          cookies,
          payload: {},
        })
      ).statusCode,
    ).toBe(410);
  } finally {
    if (app) await app.close();
    else await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("access governance database upgrades", () => {
  it(
    "preserves SQLite events and freezes migrated resource scopes and expiry",
    () => verifyLegacyUpgrade("sqlite"),
    30_000,
  );
  it.skipIf(!mysqlEnabled)(
    "preserves legacy MariaDB events and restores direct grants, request details and pagination",
    () => verifyLegacyUpgrade("mysql"),
    30_000,
  );
});
