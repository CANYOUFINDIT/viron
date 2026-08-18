import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeTableProfile, type TableProfileConfig } from "../src/client/database-table-profile.js";
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
    masterKey: Buffer.alloc(32, 19),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

const profileConfig: TableProfileConfig = {
  filters: [{ column: "status", operator: "eq", value: "open", enabled: true }],
  sorts: [
    { column: "created_at", direction: "desc", enabled: true },
    { column: "status", direction: "asc", enabled: true },
  ],
  columns: [
    { name: "created_at", visible: true, width: 180 },
    { name: "status", visible: false, width: 120 },
  ],
  pageSize: 200,
  viewMode: "grid",
};

describe("database table profiles", () => {
  it("normalizes saved columns against the current table structure", () => {
    expect(normalizeTableProfile({
      ...profileConfig,
      columns: [...profileConfig.columns, { name: "removed", visible: true, width: 2 }],
    }, ["id", "status", "created_at"])).toEqual({
      ...profileConfig,
      columns: [
        { name: "created_at", visible: true, width: 180 },
        { name: "status", visible: false, width: 120 },
        { name: "id", visible: true, width: 120 },
      ],
    });
  });

  it("upgrades legacy single filter and sort profiles", () => {
    expect(normalizeTableProfile({
      filter: { column: "status", operator: "eq", value: "open" },
      sort: { column: "created_at", direction: "desc" },
      columns: [],
      pageSize: 100,
      viewMode: "grid",
    }, ["status", "created_at"])).toMatchObject({
      filters: [{ column: "status", operator: "eq", value: "open", enabled: true }],
      sorts: [{ column: "created_at", direction: "desc", enabled: true }],
    });
  });

  it("creates, loads, renames, updates, and deletes a table profile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-table-profile-test-"));
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
      url: "/api/v1/database-table-profiles",
      cookies,
      payload: { connectionId, database: "billing", table: "orders", name: "Open orders", config: profileConfig },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/database-table-profiles",
      cookies,
      payload: { connectionId, database: "billing", table: "orders", name: "Open orders", config: profileConfig },
    });
    expect(duplicate.statusCode).toBe(409);

    const listed = await app.inject({ method: "GET", url: `/api/v1/database-table-profiles?connectionId=${connectionId}&database=billing&table=orders`, cookies });
    expect(listed.json().items).toEqual([expect.objectContaining({ id: created.json().id, name: "Open orders", config: profileConfig })]);

    const updatedConfig = { ...profileConfig, pageSize: 500, viewMode: "form" as const };
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/database-table-profiles/${created.json().id}`,
      cookies,
      payload: { connectionId, database: "billing", table: "orders", name: "Recent orders", config: updatedConfig },
    });
    expect(updated.statusCode).toBe(200);

    const accessed = await app.inject({ method: "POST", url: `/api/v1/database-table-profiles/${created.json().id}/access`, cookies });
    expect(accessed.statusCode).toBe(200);
    const relisted = await app.inject({ method: "GET", url: `/api/v1/database-table-profiles?connectionId=${connectionId}&database=billing&table=orders`, cookies });
    expect(relisted.json().items[0]).toMatchObject({ name: "Recent orders", config: updatedConfig, accessedAt: accessed.json().accessedAt });

    const deleted = await app.inject({ method: "DELETE", url: `/api/v1/database-table-profiles/${created.json().id}`, cookies });
    expect(deleted.statusCode).toBe(204);
    const empty = await app.inject({ method: "GET", url: `/api/v1/database-table-profiles?connectionId=${connectionId}&database=billing&table=orders`, cookies });
    expect(empty.json().items).toEqual([]);
    await app.close();
  });
});
