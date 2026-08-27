import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import {
  runDuplicateJunctionFailureTest,
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
});
