import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

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

describe("database backup lifecycle", () => {
  it("renames, duplicates, downloads, and deletes completed backup objects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-database-backup-lifecycle-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get("admin") as { id: string };
    const connectionId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const backupDirectory = join(directory, "backups");
    const originalPath = join(backupDirectory, "billing-original.sql");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(backupDirectory, { recursive: true }));
    writeFileSync(originalPath, "-- Viron SQL Backup\nSELECT 1;\n");
    await db.prepare(`
      INSERT INTO database_connections (
        id, workspace_type, workspace_id, name, engine, host, port, username, credential_ciphertext,
        default_database, connection_mode, options_json, created_at, updated_at
      ) VALUES (?, 'personal', ?, 'Primary', 'mysql', '127.0.0.1', 3306, 'root', 'ciphertext', 'billing', 'tcp', '{}', ?, ?)
    `).run(connectionId, admin.id, now, now);
    await db.prepare(`
      INSERT INTO database_tasks (
        id, owner_user_id, type, connection_id, status, progress, title, details_json, logs_json,
        output_path, error_message, created_at, started_at, completed_at
      ) VALUES (?, ?, 'backup', ?, 'success', 100, 'Original backup', ?, '[]', ?, '', ?, ?, ?)
    `).run(taskId, admin.id, connectionId, JSON.stringify({ database: "billing", fileSize: 30 }), originalPath, now, now, now);

    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };

    const renamed = await app.inject({ method: "PATCH", url: `/api/v1/database-backups/${taskId}`, cookies, payload: { name: "Nightly billing" } });
    expect(renamed.statusCode).toBe(200);
    const renamedPath = join(backupDirectory, "Nightly billing.sql");
    expect(existsSync(renamedPath)).toBe(true);

    const duplicated = await app.inject({ method: "POST", url: `/api/v1/database-backups/${taskId}/duplicate`, cookies, payload: { name: "Nightly billing copy" } });
    expect(duplicated.statusCode).toBe(201);
    const duplicateId = duplicated.json().task.id as string;
    const duplicateFilename = duplicated.json().task.outputFilename as string;
    const duplicatePath = join(backupDirectory, duplicateFilename);
    expect(readFileSync(duplicatePath, "utf8")).toContain("SELECT 1");

    const download = await app.inject({ method: "GET", url: `/api/v1/database-tasks/${duplicateId}/download`, cookies });
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain("Viron SQL Backup");

    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-backups/${taskId}`, cookies })).statusCode).toBe(204);
    expect(existsSync(renamedPath)).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-backups/${duplicateId}`, cookies })).statusCode).toBe(204);
    expect(existsSync(duplicatePath)).toBe(false);
    await app.close();
  });
});
