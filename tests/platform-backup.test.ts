import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { createSecretBox } from "../src/server/crypto.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { applyPendingRestore } from "../src/server/platform-backup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string, keyByte = 29): AppConfig {
  return { nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "envman.db"), masterKey: Buffer.alloc(32, keyByte), adminUsername: "admin", adminPassword: "test-password-123", sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30 };
}

function multipart(boundary: string, filename: string, content: Buffer, password: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${password}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe("platform backup and restore", () => {
  it("exports a password-protected package and rekeys it for a different target instance", async () => {
    const sourceDirectory = mkdtempSync(join(tmpdir(), "viron-platform-source-"));
    const targetDirectory = mkdtempSync(join(tmpdir(), "viron-platform-target-"));
    directories.push(sourceDirectory, targetDirectory);
    const sourceConfig = configFor(sourceDirectory, 29);
    const sourceDb = await openDatabase(sourceConfig);
    await ensureAdmin(sourceDb, sourceConfig);
    const sourceApp = await buildApp({ config: sourceConfig, db: sourceDb, logger: false });
    const sourceLogin = await sourceApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const sourceCookies = { envman_session: sourceLogin.cookies.find((item) => item.name === "envman_session")!.value };
    const migrationPassword = "correct horse battery staple";

    await sourceApp.inject({ method: "POST", url: "/api/v1/environments", cookies: sourceCookies, payload: { name: "Before Export", status: "active", tags: [] } });
    const generatedKey = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/ssh-keys/generate",
      cookies: sourceCookies,
      payload: { name: "Migrated SSH key", algorithm: "ed25519", passphrase: "migration-key-passphrase" },
    });
    expect(generatedKey.statusCode).toBe(201);
    await sourceDb.prepare(`INSERT INTO connection_sources (id, workspace_type, workspace_id, type, name, config_ciphertext, created_at, updated_at) VALUES (?, 'personal', '', 'test', ?, ?, ?, ?)`)
      .run("source-secret", "Encrypted source", sourceApp.secrets.encrypt(JSON.stringify({ password: "source-password" })), new Date().toISOString(), new Date().toISOString());
    const exported = await sourceApp.inject({ method: "POST", url: "/api/v1/platform-exports", cookies: sourceCookies, payload: { password: migrationPassword } });
    expect(exported.statusCode).toBe(201);
    const archive = await sourceApp.inject({ method: "GET", url: exported.json().downloadUrl, cookies: sourceCookies });
    expect(archive.statusCode).toBe(200);
    expect(archive.rawPayload.subarray(0, 2).toString()).toBe("PK");
    await sourceApp.close();

    const targetConfig = configFor(targetDirectory, 47);
    const targetDb = await openDatabase(targetConfig);
    await ensureAdmin(targetDb, targetConfig);
    const targetApp = await buildApp({ config: targetConfig, db: targetDb, logger: false });
    const targetLogin = await targetApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const targetCookies = { envman_session: targetLogin.cookies.find((item) => item.name === "envman_session")!.value };
    const boundary = "envman-platform-restore";
    const wrongPassword = await targetApp.inject({
      method: "POST",
      url: "/api/v1/platform-restore",
      cookies: targetCookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, "viron-migration.zip", archive.rawPayload, "wrong-password-value"),
    });
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json().message).toContain("密码错误");

    const staged = await targetApp.inject({
      method: "POST",
      url: "/api/v1/platform-restore",
      cookies: targetCookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, "viron-migration.zip", archive.rawPayload, migrationPassword),
    });
    expect(staged.statusCode).toBe(202);
    expect(staged.json()).toMatchObject({ staged: true, restartRequired: true });
    await targetApp.close();

    applyPendingRestore(targetDirectory);
    const restored = await openDatabase(targetConfig);
    const names = (await restored.prepare("SELECT name FROM environments ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(["Before Export"]);
    const encrypted = await restored.prepare("SELECT config_ciphertext FROM connection_sources WHERE id = ?").get("source-secret") as { config_ciphertext: string };
    expect(JSON.parse(createSecretBox(targetConfig.masterKey).decrypt(encrypted.config_ciphertext))).toEqual({ password: "source-password" });
    const restoredKey = await restored.prepare("SELECT private_key_ciphertext FROM ssh_keys WHERE id = ?").get(generatedKey.json().id) as { private_key_ciphertext: string };
    const restoredKeyCredential = JSON.parse(createSecretBox(targetConfig.masterKey).decrypt(restoredKey.private_key_ciphertext)) as { privateKey: string; passphrase: string };
    expect(restoredKeyCredential.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(restoredKeyCredential.passphrase).toBe("migration-key-passphrase");

    const replayApp = await buildApp({ config: targetConfig, db: restored, logger: false });
    const replayLogin = await replayApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const replayCookies = { envman_session: replayLogin.cookies.find((item) => item.name === "envman_session")!.value };
    const replay = await replayApp.inject({
      method: "POST",
      url: "/api/v1/platform-restore",
      cookies: replayCookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, "viron-migration.zip", archive.rawPayload, migrationPassword),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().message).toContain("已经在当前实例导入");
    await replayApp.close();
  });
});
