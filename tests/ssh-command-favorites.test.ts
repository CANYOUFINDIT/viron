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

function testConfig(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 23),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value };
}

describe("SSH command favorites", () => {
  it("persists favorites on the server and isolates them by user and connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssh-command-favorites-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const admin = await login(app, "admin", config.adminPassword);
    const connection = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies: admin,
      payload: {
        name: "Favorite Host",
        host: "127.0.0.1",
        port: 22,
        username: "operator",
        authType: "password",
        credential: { password: "unused-test-password" },
        options: {},
      },
    });
    expect(connection.statusCode).toBe(201);
    const connectionId = connection.json().id as string;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-command-favorites",
      cookies: admin,
      payload: { connectionId, command: "systemctl status viron", cwd: "/srv/viron" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ created: true, item: { connectionId, command: "systemctl status viron", cwd: "/srv/viron" } });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-command-favorites",
      cookies: admin,
      payload: { connectionId, command: "systemctl status viron", cwd: "/opt/viron" },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ created: false, item: { id: created.json().item.id, cwd: "/opt/viron" } });

    const sensitive = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-command-favorites",
      cookies: admin,
      payload: { connectionId, command: "export API_TOKEN=secret-value", cwd: "/tmp" },
    });
    expect(sensitive.statusCode).toBe(400);
    expect(sensitive.json().error).toBe("SENSITIVE_COMMAND");

    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "alice", password: "alice-password" },
    });
    const alice = { envman_session: registration.cookies.find((item) => item.name === "envman_session")!.value };
    const inaccessible = await app.inject({
      method: "GET",
      url: `/api/v1/ssh-command-favorites?connectionId=${connectionId}`,
      cookies: alice,
    });
    expect(inaccessible.statusCode).toBe(404);

    await app.close();

    const reopenedDb = await openDatabase(config);
    const reopenedApp = await buildApp({ config, db: reopenedDb, logger: false });
    const reopenedAdmin = await login(reopenedApp, "admin", config.adminPassword);
    const persisted = await reopenedApp.inject({
      method: "GET",
      url: `/api/v1/ssh-command-favorites?connectionId=${connectionId}`,
      cookies: reopenedAdmin,
    });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json().items).toEqual([
      expect.objectContaining({ id: created.json().item.id, command: "systemctl status viron", cwd: "/opt/viron" }),
    ]);

    const removed = await reopenedApp.inject({
      method: "DELETE",
      url: `/api/v1/ssh-command-favorites/${created.json().item.id}`,
      cookies: reopenedAdmin,
    });
    expect(removed.statusCode).toBe(204);
    const empty = await reopenedApp.inject({
      method: "GET",
      url: `/api/v1/ssh-command-favorites?connectionId=${connectionId}`,
      cookies: reopenedAdmin,
    });
    expect(empty.json().items).toEqual([]);
    await reopenedApp.close();
  });
});
