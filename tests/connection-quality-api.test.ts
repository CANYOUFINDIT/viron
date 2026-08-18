import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AuthenticatedUser } from "../src/server/access-control.js";
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
    masterKey: Buffer.alloc(32, 7),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("connection quality API", () => {
  it("reveals a local probe target only to its owning desktop execution instance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-connection-quality-api-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookie = login.cookies.find((item) => item.name === "envman_session")!;
    const row = await db.prepare("SELECT id, username FROM admin_users WHERE username = 'admin'").get() as { id: string; username: string };
    const user: AuthenticatedUser = {
      id: row.id,
      username: row.username,
      isPlatformAdmin: true,
      workspace: { type: "personal", id: row.id, name: "个人工作台", role: "owner" },
    };
    const connectionId = crypto.randomUUID();
    const scope = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO ssh_connections (id, workspace_type, workspace_id, name, host, port, username, credential_ciphertext, created_at, updated_at)
      VALUES (?, 'personal', ?, 'Local target', '192.0.2.25', 2222, 'operator', 'encrypted', ?, ?)
    `).run(connectionId, row.id, now, now);
    const item = await app.activeConnections.reserve({
      id: crypto.randomUUID(),
      user,
      type: "ssh",
      resourceId: connectionId,
      executionScope: scope,
      client: "desktop",
      executionMode: "local",
      external: true,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/active-connections",
      cookies: { envman_session: cookie.value },
      headers: { "x-viron-execution-scope": scope },
    });
    expect(listed.json().items).toContainEqual(expect.objectContaining({ id: item.id, currentExecutionInstance: true }));

    const target = await app.inject({
      method: "GET",
      url: `/api/v1/desktop/connection-quality/targets/${item.id}`,
      cookies: { envman_session: cookie.value },
      headers: { "x-viron-execution-scope": scope },
    });
    expect(target.statusCode).toBe(200);
    expect(target.json()).toEqual({ host: "192.0.2.25", port: 2222 });

    const otherInstance = await app.inject({
      method: "GET",
      url: `/api/v1/desktop/connection-quality/targets/${item.id}`,
      cookies: { envman_session: cookie.value },
      headers: { "x-viron-execution-scope": crypto.randomUUID() },
    });
    expect(otherInstance.statusCode).toBe(404);

    await app.close();
  });
});
