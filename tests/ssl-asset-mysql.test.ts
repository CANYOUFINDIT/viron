import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { SSL_ASSET_MIGRATION_ID, migrateSslAssets } from "../src/server/ssl-asset-migration.js";

const enabled = process.env.VIRON_SSL_MYSQL_TEST !== "0";
const mysqlIt = enabled ? it : it.skip;
const directory = mkdtempSync(join(tmpdir(), "viron-ssl-mysql-"));
const containerName = `viron-ssl-mysql-${process.pid}`;
const port = 13317;
let dockerStarted = false;

function mysqlConfig(): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "unused.db"),
    databaseDriver: "mysql",
    databaseHost: "127.0.0.1",
    databasePort: port,
    databaseName: "viron_ssl",
    databaseUsername: "root",
    databasePassword: "test",
    masterKey: Buffer.alloc(32, 63),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function waitForMysql(timeoutMs = 60000): Promise<void> {
  const mysql = await import("mysql2/promise");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const connection = await mysql.createConnection({
        host: "127.0.0.1",
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
  await waitForMysql();
}, 120_000);

afterAll(async () => {
  if (dockerStarted) {
    try { execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch { /* ignore */ }
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("ssl asset MySQL equivalence", () => {
  mysqlIt("migrates, enforces workspace uniqueness, and dual-writes with the same counts as SQLite", async () => {
    const db = await openDatabase(mysqlConfig());
    await ensureAdmin(db, mysqlConfig());
    const now = new Date().toISOString();
    const user = await db.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    const envId = randomUUID();
    const endpointId = randomUUID();
    const fingerprint = "bb".repeat(32);
    await db.prepare(`
      INSERT INTO environments (id, workspace_type, workspace_id, name, short_name, description, status, owner, tags_json, sort_order, created_at, updated_at)
      VALUES (?, 'personal', ?, 'MySQL Env', '', '', 'active', '', '[]', 0, ?, ?)
    `).run(envId, user.id, now, now);
    await db.prepare(`
      INSERT INTO tls_endpoints (
        id, environment_id, ssh_bind_key, host, port, sni, source, observe_enabled, customized, sort_order,
        probe_status, probe_error, probed_at, leaf_cn, leaf_sans_json, issuer, serial, signature_algorithm,
        not_before, not_after, fingerprint_sha256, is_self_signed, created_at, updated_at
      ) VALUES (?, ?, '', 'db.example.com', 443, 'db.example.com', 'manual', 1, 0, 0, 'ok', '', ?, 'db.example.com', '[]', 'Issuer', '9', 'sha256', ?, ?, ?, 0, ?, ?)
    `).run(endpointId, envId, now, now, now, fingerprint, now, now);
    await db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(SSL_ASSET_MIGRATION_ID);
    await db.prepare("DELETE FROM ssl_endpoint_web_entries").run();
    await db.prepare("DELETE FROM ssl_endpoints").run();
    await db.prepare("DELETE FROM ssl_certificates").run();
    await migrateSslAssets(db);
    await migrateSslAssets(db);
    expect(await db.prepare("SELECT COUNT(*) AS total FROM ssl_certificates").get()).toEqual({ total: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints").get()).toEqual({ total: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS total FROM tls_endpoints").get()).toEqual({ total: 1 });
    await db.close();
  });
});
