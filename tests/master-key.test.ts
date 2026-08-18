import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/server/config.js";
import { createSecretBox } from "../src/server/crypto.js";
import { openDatabase } from "../src/server/database.js";
import { initializeMasterKey } from "../src/server/master-key.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string, masterKey: Buffer): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey,
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("managed master key", () => {
  it("loads the same managed key after a fresh instance restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-master-key-reload-"));
    directories.push(directory);
    const saved = {
      dataDir: process.env.DATA_DIR,
      inlineKey: process.env.VIRON_MASTER_KEY,
      keyFile: process.env.VIRON_MASTER_KEY_FILE,
      databaseDriver: process.env.DATABASE_DRIVER,
    };
    process.env.DATA_DIR = directory;
    process.env.DATABASE_DRIVER = "sqlite";
    delete process.env.VIRON_MASTER_KEY;
    delete process.env.VIRON_MASTER_KEY_FILE;
    try {
      const first = loadConfig();
      expect(first.masterKeyNeedsPersistence).toBe(true);
      const db = await openDatabase(first);
      await initializeMasterKey(first, db);
      await db.close();

      const restarted = loadConfig();
      expect(restarted.masterKeyNeedsPersistence).toBeUndefined();
      expect(restarted.masterKey).toEqual(first.masterKey);
    } finally {
      if (saved.dataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved.dataDir;
      if (saved.inlineKey === undefined) delete process.env.VIRON_MASTER_KEY; else process.env.VIRON_MASTER_KEY = saved.inlineKey;
      if (saved.keyFile === undefined) delete process.env.VIRON_MASTER_KEY_FILE; else process.env.VIRON_MASTER_KEY_FILE = saved.keyFile;
      if (saved.databaseDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = saved.databaseDriver;
    }
  });

  it("persists a generated key with owner-only permissions for a fresh instance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-master-key-fresh-"));
    directories.push(directory);
    const key = Buffer.alloc(32, 17);
    const config = {
      ...configFor(directory, key),
      masterKeyFile: join(directory, "master-key"),
      masterKeyNeedsPersistence: true,
    };
    const db = await openDatabase(config);

    await initializeMasterKey(config, db);

    expect(config.masterKeyNeedsPersistence).toBe(false);
    expect(Buffer.from(readFileSync(config.masterKeyFile, "utf8").trim(), "base64")).toEqual(key);
    if (process.platform !== "win32") expect(statSync(config.masterKeyFile).mode & 0o077).toBe(0);
    await db.close();
  });

  it("refuses to generate a replacement when encrypted data already exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-master-key-existing-"));
    directories.push(directory);
    const originalKey = Buffer.alloc(32, 23);
    const originalConfig = configFor(directory, originalKey);
    const db = await openDatabase(originalConfig);
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'personal', '', 'test', ?, ?, ?, ?)`)
      .run("encrypted-source", "Encrypted source", createSecretBox(originalKey).encrypt("secret"), now, now);
    const managedFile = join(directory, "master-key");
    const missingConfig = {
      ...originalConfig,
      masterKey: Buffer.alloc(32, 41),
      masterKeyFile: managedFile,
      masterKeyNeedsPersistence: true,
    };

    await expect(initializeMasterKey(missingConfig, db)).rejects.toThrow("already contains encrypted data");
    expect(existsSync(managedFile)).toBe(false);

    const wrongConfig = { ...originalConfig, masterKey: Buffer.alloc(32, 42) };
    await expect(initializeMasterKey(wrongConfig, db)).rejects.toThrow("does not match the encrypted data");
    await db.close();
  });
});
