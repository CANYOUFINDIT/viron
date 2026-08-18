import { mkdtempSync, rmSync } from "node:fs";
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
    masterKey: Buffer.alloc(32, 12),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("database saved queries", () => {
  it("supports create, list, open, update, conflict detection, and delete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-database-saved-query-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const connection = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: { name: "Primary", engine: "mysql", host: "127.0.0.1", port: 3306, username: "root", credential: { password: "secret" } },
    });
    const connectionId = connection.json().id as string;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/database-saved-queries",
      cookies,
      payload: { connectionId, database: "billing", name: "Open orders", sql: "SELECT * FROM orders" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/database-saved-queries",
      cookies,
      payload: { connectionId, database: "billing", name: "Open orders", sql: "SELECT 1" },
    });
    expect(conflict.statusCode).toBe(409);

    const listed = await app.inject({ method: "GET", url: `/api/v1/database-saved-queries?connectionId=${connectionId}&database=billing`, cookies });
    expect(listed.json().items).toEqual([
      expect.objectContaining({ id, connectionId, database: "billing", name: "Open orders", sql: "SELECT * FROM orders", ownerName: "admin" }),
    ]);

    const accessed = await app.inject({ method: "POST", url: `/api/v1/database-saved-queries/${id}/access`, cookies });
    expect(accessed.statusCode).toBe(200);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/database-saved-queries/${id}`,
      cookies,
      payload: { connectionId, database: "analytics", name: "Recent orders", sql: "SELECT * FROM recent_orders" },
    });
    expect(updated.statusCode).toBe(200);

    const relisted = await app.inject({ method: "GET", url: `/api/v1/database-saved-queries?connectionId=${connectionId}`, cookies });
    expect(relisted.json().items).toEqual([
      expect.objectContaining({ id, database: "analytics", name: "Recent orders", sql: "SELECT * FROM recent_orders" }),
    ]);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-saved-queries/${id}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/v1/database-saved-queries?connectionId=${connectionId}`, cookies })).json().items).toEqual([]);
    await app.close();
  });
});
