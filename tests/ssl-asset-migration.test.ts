import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import {
  runDuplicateJunctionFailureTest,
  runHttpsWebEntryBackfillTests,
  runSslMigrationBehaviorTests,
  sslTestConfig,
} from "./helpers/ssl-asset-harness.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ssl asset migration", () => {
  it("backfills successful snapshots only, is idempotent, and reconciles old-binary writes after the marker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssl-migrate-"));
    directories.push(directory);
    const config = sslTestConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const user = await db.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    await runSslMigrationBehaviorTests(db, user.id);
    if (db.dialect === "sqlite") {
      expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    await db.close();
  });

  it("fails closed when one web entry has multiple legacy endpoints", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssl-dup-"));
    directories.push(directory);
    const config = sslTestConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const user = await db.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    await runDuplicateJunctionFailureTest(db, user.id);
    await db.close();
  });

  it("backfills existing HTTPS web entries without touching HTTP entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssl-web-entry-backfill-"));
    directories.push(directory);
    const config = sslTestConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const user = await db.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    await runHttpsWebEntryBackfillTests(db, user.id);
    if (db.dialect === "sqlite") {
      expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    await db.close();
  });

  it("enforces the SQLite endpoint domains that MariaDB validates in the migration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssl-domain-"));
    directories.push(directory);
    const config = sslTestConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const user = await db.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
    const now = new Date().toISOString();
    const envId = randomUUID();
    await db.prepare(`
      INSERT INTO environments (id, workspace_type, workspace_id, name, short_name, description, status, owner, tags_json, sort_order, created_at, updated_at)
      VALUES (?, 'personal', ?, 'Domain check', '', '', 'active', '', '[]', 0, ?, ?)
    `).run(envId, user.id, now, now);
    await expect(db.prepare(`
      INSERT INTO tls_endpoints (
        id, environment_id, ssh_bind_key, host, port, sni, source, observe_enabled, customized, sort_order,
        probe_status, probe_error, leaf_sans_json, created_at, updated_at
      ) VALUES (?, ?, '', 'invalid.example.com', 443, 'invalid.example.com', 'unknown', 1, 0, 0,
        'not_a_status', '', '[]', ?, ?)
    `).run(randomUUID(), envId, now, now)).rejects.toThrow();
    await db.close();
  });
});
