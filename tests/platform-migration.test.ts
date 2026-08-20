import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/database.js";
import type { EnvmanDatabase } from "../src/server/database-client.js";
import { createMigrationManifest, exportPortableSnapshot, openMigrationMasterKey, replaceMysqlFromPortableSnapshot } from "../src/server/platform-migration.js";

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
    masterKey: Buffer.alloc(32, 13),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

function mysqlDialectAdapter(db: EnvmanDatabase): EnvmanDatabase {
  return {
    dialect: "mysql",
    prepare: db.prepare.bind(db),
    exec: (sql) => sql.startsWith("SET FOREIGN_KEY_CHECKS") ? Promise.resolve() : db.exec(sql),
    transaction: db.transaction.bind(db),
    backup: db.backup.bind(db),
    ping: db.ping.bind(db),
    close: db.close.bind(db),
  };
}

describe("portable platform snapshots", () => {
  it("binds the encrypted source key to the snapshot digest", async () => {
    const sourceKey = Buffer.alloc(32, 7);
    const manifest = await createMigrationManifest(sourceKey, "correct horse battery staple", "sqlite", "a".repeat(64));
    const opened = await openMigrationMasterKey(manifest, "correct horse battery staple");
    expect(opened).toEqual(sourceKey);
    opened.fill(0);

    await expect(openMigrationMasterKey({ ...manifest, snapshotSha256: "b".repeat(64) }, "correct horse battery staple"))
      .rejects.toThrow("密码错误或迁移包已损坏");
  });

  it("exports and replaces data through the MySQL database adapter path", async () => {
    const sourceDirectory = mkdtempSync(join(tmpdir(), "viron-portable-source-"));
    const targetDirectory = mkdtempSync(join(tmpdir(), "viron-portable-target-"));
    directories.push(sourceDirectory, targetDirectory);
    const source = await openDatabase(configFor(sourceDirectory));
    const target = await openDatabase(configFor(targetDirectory));
    const now = new Date().toISOString();
    await source.prepare("INSERT INTO environments (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
      .run("source-environment", "Portable source", now, now);
    await target.prepare("INSERT INTO environments (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
      .run("target-environment", "Old target", now, now);
    const snapshotPath = join(sourceDirectory, "portable.db");

    await exportPortableSnapshot(mysqlDialectAdapter(source), snapshotPath);
    await replaceMysqlFromPortableSnapshot(snapshotPath, mysqlDialectAdapter(target));

    const environments = await target.prepare("SELECT id, name FROM environments ORDER BY id").all();
    expect(environments).toEqual([{ id: "source-environment", name: "Portable source" }]);
    await source.close();
    await target.close();
  });
});
