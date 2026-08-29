import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import type { EnvmanDatabase } from "../src/server/database.js";
import { migrateSslAssets, SSL_ASSET_MIGRATION_ID } from "../src/server/ssl-asset-migration.js";
import {
  createTlsEndpoint,
  deleteTlsEndpoint,
  getTlsEndpoint,
  listWorkspaceCertificates,
  updateTlsEndpoint,
} from "../src/server/tls-certificates.js";
import {
  clearTlsState,
  countTable,
  runDuplicateJunctionFailureTest,
  runHttpsWebEntryBackfillTests,
  runSslMigrationBehaviorTests,
  sslTestConfig,
} from "./helpers/ssl-asset-harness.js";

const enabled = process.env.VIRON_SSL_MYSQL_TEST !== "0";
const mysqlIt = enabled ? it : it.skip;
const directory = mkdtempSync(join(tmpdir(), "viron-ssl-mysql-"));
const containerName = `viron-ssl-mysql-${process.pid}`;
const externalHost = process.env.VIRON_SSL_MYSQL_HOST;
const port = Number(process.env.VIRON_SSL_MYSQL_PORT ?? 13317);
let dockerStarted = false;
let db: EnvmanDatabase | undefined;

function mysqlConfig() {
  return sslTestConfig(directory, { host: externalHost || "127.0.0.1", port });
}

function fakeApp(database: EnvmanDatabase): FastifyInstance {
  return { db: database, log: { warn() {}, info() {}, error() {} } } as unknown as FastifyInstance;
}

async function waitForMysql(timeoutMs = 60000): Promise<void> {
  const mysql = await import("mysql2/promise");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const connection = await mysql.createConnection({
        host: externalHost || "127.0.0.1",
        port,
        user: "root",
        password: "test",
        database: "viron_ssl",
      });
      await connection.query("SELECT 1");
      await connection.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("MariaDB container did not become ready");
}

beforeAll(async () => {
  if (!enabled) return;
  if (!externalHost) {
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // container may not exist
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", [
        "run", "-d", "--name", containerName,
        "-e", "MYSQL_ROOT_PASSWORD=test",
        "-e", "MYSQL_DATABASE=viron_ssl",
        "-p", `${port}:3306`,
        "mariadb:11.4",
      ], { stdio: "inherit" });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker run exited ${code}`)));
      child.on("error", reject);
    });
    dockerStarted = true;
  }
  await waitForMysql();
  const config = mysqlConfig();
  db = await openDatabase(config);
  await ensureAdmin(db, config);
}, 120_000);

afterAll(async () => {
  await db?.close();
  if (dockerStarted) {
    try { execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch { /* ignore */ }
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("ssl asset MySQL equivalence", () => {
  mysqlIt("migrates failed/success rows, reconciles after marker, and rejects duplicate junctions", async () => {
    expect(db).toBeDefined();
    const user = await db!.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    await runSslMigrationBehaviorTests(db!, user.id);
    await runDuplicateJunctionFailureTest(db!, user.id);
  });

  mysqlIt("backfills existing HTTPS web entries without touching HTTP entries", async () => {
    expect(db).toBeDefined();
    const user = await db!.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    await runHttpsWebEntryBackfillTests(db!, user.id);
  });

  mysqlIt("dual-writes CRUD, unique identity, unbind bind-key, and rolls back when the legacy write fails", async () => {
    expect(db).toBeDefined();
    await clearTlsState(db!);
    const now = new Date().toISOString();
    const user = await db!.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    const envId = randomUUID();
    await db!.prepare(`
      INSERT INTO environments (id, workspace_type, workspace_id, name, short_name, description, status, owner, tags_json, sort_order, created_at, updated_at)
      VALUES (?, 'personal', ?, 'MySQL CRUD', '', '', 'active', '', '[]', 0, ?, ?)
    `).run(envId, user.id, now, now);
    const app = fakeApp(db!);
    const disabledId = await createTlsEndpoint(app, envId, {
      host: "disabled.example.com",
      port: 443,
      observeEnabled: false,
    });
    const disabled = await getTlsEndpoint(app, disabledId);
    expect(disabled?.observeEnabled).toBe(false);
    expect(await db!.prepare("SELECT observe_enabled FROM tls_endpoints WHERE id = ?").get(disabledId)).toEqual({ observe_enabled: 0 });
    expect(await db!.prepare("SELECT observe_enabled FROM ssl_endpoints WHERE id = ?").get(disabledId)).toEqual({ observe_enabled: 0 });

    const firstId = await createTlsEndpoint(app, envId, { host: "one.example.com", port: 443, sni: "one.example.com" });
    await expect(createTlsEndpoint(app, envId, { host: "one.example.com", port: 443, sni: "one.example.com" })).rejects.toMatchObject({ code: "TLS_ENDPOINT_EXISTS" });

    await db!.prepare("UPDATE ssl_endpoints SET certificate_id = NULL, probe_status = 'ok', last_success_at = ? WHERE id = ?").run(now, firstId);
    const updated = await updateTlsEndpoint(app, firstId, { host: "two.example.com", port: 443, sni: "two.example.com", sshConnectionId: null });
    expect(updated.host).toBe("two.example.com");
    expect(updated.probeStatus).toBe("never");
    expect(updated.certificateId).toBeNull();
    expect(updated.lastSuccessAt).toBeNull();
    const bind = await db!.prepare("SELECT ssh_bind_key FROM ssl_endpoints WHERE id = ?").get(firstId) as { ssh_bind_key: string };
    expect(bind.ssh_bind_key).toBe("");
    expect(await db!.prepare("SELECT ssh_bind_key FROM tls_endpoints WHERE id = ?").get(firstId)).toEqual({ ssh_bind_key: "" });

    const originalPrepare = db!.prepare.bind(db!);
    try {
      db!.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        if (/INSERT INTO tls_endpoints\s*\(/.test(sql)) {
          return {
            get: statement.get.bind(statement),
            all: statement.all.bind(statement),
            run: async () => {
              throw new Error("legacy write failed");
            },
          };
        }
        return statement;
      }) as EnvmanDatabase["prepare"];
      const before = await countTable(db!, "ssl_endpoints");
      await expect(createTlsEndpoint(app, envId, { host: "rollback.example.com", port: 443 })).rejects.toThrow("legacy write failed");
      expect(await countTable(db!, "ssl_endpoints")).toBe(before);
    } finally {
      db!.prepare = originalPrepare;
    }

    await deleteTlsEndpoint(app, firstId);
    expect(await db!.prepare("SELECT id FROM ssl_endpoints WHERE id = ?").get(firstId)).toBeUndefined();
    expect(await db!.prepare("SELECT id FROM tls_endpoints WHERE id = ?").get(firstId)).toBeUndefined();

    const listed = await listWorkspaceCertificates(app, { type: "personal", id: user.id }, { page: 1, pageSize: 50 });
    expect(listed.pageInfo.pageSize).toBe(50);
    expect(listed.pageInfo.total).toBeGreaterThanOrEqual(0);
  });

  mysqlIt("rejects invalid legacy endpoint domains before activating the migration", async () => {
    expect(db).toBeDefined();
    await clearTlsState(db!);
    const now = new Date().toISOString();
    const user = await db!.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    const envId = randomUUID();
    await db!.prepare(`
      INSERT INTO environments (id, workspace_type, workspace_id, name, short_name, description, status, owner, tags_json, sort_order, created_at, updated_at)
      VALUES (?, 'personal', ?, 'Invalid legacy domain', '', '', 'active', '', '[]', 0, ?, ?)
    `).run(envId, user.id, now, now);
    const invalidRows = [
      { id: randomUUID(), host: "invalid-source.example.com", port: 443, source: "unknown", observeEnabled: 1, probeStatus: "never" },
      { id: randomUUID(), host: "invalid-status.example.com", port: 443, source: "manual", observeEnabled: 1, probeStatus: "not_a_status" },
      { id: randomUUID(), host: "invalid-port.example.com", port: 0, source: "manual", observeEnabled: 1, probeStatus: "never" },
      { id: randomUUID(), host: "invalid-boolean.example.com", port: 443, source: "manual", observeEnabled: 2, probeStatus: "never" },
    ];
    for (const row of invalidRows) {
      await db!.prepare(`
        INSERT INTO tls_endpoints (
          id, environment_id, ssh_bind_key, host, port, sni, source, observe_enabled, customized, sort_order,
          probe_status, probe_error, leaf_sans_json, is_self_signed, created_at, updated_at
        ) VALUES (?, ?, '', ?, ?, ?, ?, ?, 0, 0, ?, '', '[]', 0, ?, ?)
      `).run(row.id, envId, row.host, row.port, row.host, row.source, row.observeEnabled, row.probeStatus, now, now);
    }

    try {
      await migrateSslAssets(db!);
      throw new Error("expected invalid legacy endpoint migration to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "SSL_ASSET_MIGRATION_FAILED" });
      expect((error as { details: { rowIds: string[] } }).details.rowIds)
        .toEqual(expect.arrayContaining(invalidRows.map((row) => row.id)));
    }
    expect(await db!.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(SSL_ASSET_MIGRATION_ID)).toBeUndefined();
    expect(await countTable(db!, "tls_endpoints")).toBe(invalidRows.length);
    expect(await countTable(db!, "ssl_endpoints")).toBe(0);
  });
});
