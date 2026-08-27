import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { SSL_ASSET_MIGRATION_CHECKSUM, SSL_ASSET_MIGRATION_ID, migrateSslAssets } from "../src/server/ssl-asset-migration.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testConfig(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 61),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("ssl asset migration", () => {
  it("backfills old endpoints by workspace fingerprint and is idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssl-migrate-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const now = new Date().toISOString();
    const user = await db.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    const workspaceId = user.id;
    const envA = "11111111-1111-4111-8111-111111111111";
    const envB = "22222222-2222-4222-8222-222222222222";
    const endpointA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const endpointB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const webA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fingerprint = "aa".repeat(32);
    await db.prepare(`
      INSERT INTO environments (id, workspace_type, workspace_id, name, short_name, description, status, owner, tags_json, created_at, updated_at)
      VALUES (?, 'personal', ?, 'A', '', '', 'active', '', '[]', ?, ?)
    `).run(envA, workspaceId, now, now);
    await db.prepare(`
      INSERT INTO environments (id, workspace_type, workspace_id, name, short_name, description, status, owner, tags_json, created_at, updated_at)
      VALUES (?, 'personal', ?, 'B', '', '', 'active', '', '[]', ?, ?)
    `).run(envB, workspaceId, now, now);
    for (const [id, environmentId, host] of [[endpointA, envA, "api.example.com"], [endpointB, envB, "admin.example.com"]] as const) {
      await db.prepare(`
        INSERT INTO tls_endpoints (
          id, environment_id, ssh_bind_key, host, port, sni, source, observe_enabled, customized, sort_order,
          probe_status, probe_error, probed_at, leaf_cn, leaf_sans_json, issuer, serial, signature_algorithm,
          not_before, not_after, fingerprint_sha256, is_self_signed, created_at, updated_at
        ) VALUES (?, ?, '', ?, 443, ?, 'manual', 1, 0, 0, 'ok', '', ?, 'example.com', '[]', 'Issuer', '1', 'sha256', ?, ?, ?, 0, ?, ?)
      `).run(id, environmentId, host, host, now, now, now, fingerprint, now, now);
    }
    await db.prepare(`
      INSERT INTO web_entries (id, environment_id, name, url, description, tags_json, sort_order, created_at, updated_at)
      VALUES (?, ?, 'API', 'https://api.example.com', '', '[]', 0, ?, ?)
    `).run(webA, envA, now, now);
    await db.prepare("INSERT INTO tls_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)").run(endpointA, webA);
    await db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(SSL_ASSET_MIGRATION_ID);
    await db.prepare("DELETE FROM ssl_endpoint_web_entries").run();
    await db.prepare("DELETE FROM ssl_endpoints").run();
    await db.prepare("DELETE FROM ssl_certificates").run();

    await migrateSslAssets(db);
    await migrateSslAssets(db);

    const certs = await db.prepare("SELECT id, fingerprint_sha256 FROM ssl_certificates").all() as Array<{ id: string }>;
    expect(certs).toHaveLength(1);
    const endpoints = await db.prepare("SELECT id, certificate_id FROM ssl_endpoints ORDER BY host").all() as Array<{ id: string; certificate_id: string }>;
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]?.certificate_id).toBe(endpoints[1]?.certificate_id);
    expect(await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoint_web_entries").get()).toEqual({ total: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS total FROM tls_endpoints").get()).toEqual({ total: 2 });
    expect(await db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(SSL_ASSET_MIGRATION_ID)).toEqual({ checksum: SSL_ASSET_MIGRATION_CHECKSUM });
    if (db.dialect === "sqlite") {
      expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    await db.close();
  });
});
