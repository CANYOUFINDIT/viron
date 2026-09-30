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
    masterKey: Buffer.alloc(32, 9),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

interface SshItem {
  id: string;
  name: string;
  connectionGroupId: string | null;
  sortOrder: number;
  updatedAt: string;
}

function sshPayload(name: string, host: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    host,
    port: 22,
    username: "root",
    authType: "password",
    credential: { password: "secret" },
    ...extra,
  };
}

describe("connection list order", () => {
  it("persists an SSH group order, keeps omitted rows in place, and appends the next connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssh-order-"));
    directories.push(directory);
    const db = await openDatabase(configFor(directory));
    await ensureAdmin(db, configFor(directory));
    const app = await buildApp({ config: configFor(directory), db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const group = await app.inject({ method: "POST", url: "/api/v1/connection-groups", cookies, payload: { type: "ssh", name: "研发" } });
      const otherGroup = await app.inject({ method: "POST", url: "/api/v1/connection-groups", cookies, payload: { type: "ssh", name: "运维" } });
      expect(group.statusCode).toBe(201);
      const groupId = group.json().id as string;

      const created: Record<string, string> = {};
      for (const [name, host, updatedAt] of [
        ["Alpha", "10.0.0.11", "2026-01-01T00:00:00.000Z"],
        ["Beta", "10.0.0.12", "2026-01-02T00:00:00.000Z"],
        ["Gamma", "10.0.0.13", "2026-01-03T00:00:00.000Z"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/ssh-connections",
          cookies,
          payload: sshPayload(name, host, { connectionGroupId: groupId }),
        });
        expect(response.statusCode).toBe(201);
        created[name] = response.json().id as string;
        await app.db.prepare("UPDATE ssh_connections SET updated_at = ? WHERE id = ?").run(updatedAt, created[name]);
      }
      const outsider = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: sshPayload("Outside", "10.0.0.19", { connectionGroupId: otherGroup.json().id }),
      });
      expect(outsider.statusCode).toBe(201);

      const before = await app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies });
      const groupItems = (before.json().items as SshItem[]).filter((item) => item.connectionGroupId === groupId);
      expect(groupItems.map((item) => item.sortOrder)).toEqual([0, 0, 0]);
      expect(groupItems.map((item) => item.name)).toEqual(["Gamma", "Beta", "Alpha"]);

      const reordered = await app.inject({
        method: "PUT",
        url: "/api/v1/ssh-connections/order",
        cookies,
        payload: { connectionGroupId: groupId, orderedIds: [created.Alpha, created.Gamma] },
      });
      expect(reordered.statusCode).toBe(200);

      const listed = await app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies });
      const ordered = (listed.json().items as SshItem[])
        .filter((item) => item.connectionGroupId === groupId)
        .sort((left, right) => left.sortOrder - right.sortOrder);
      expect(ordered.map((item) => item.name)).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(ordered.map((item) => item.sortOrder)).toEqual([0, 1, 2]);

      const reversed = await app.inject({
        method: "PUT",
        url: "/api/v1/ssh-connections/order",
        cookies,
        payload: { connectionGroupId: groupId, orderedIds: [created.Gamma, created.Alpha] },
      });
      expect(reversed.statusCode).toBe(200);
      const afterSubset = (await app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies })).json().items as SshItem[];
      expect(afterSubset.filter((item) => item.connectionGroupId === groupId).sort((left, right) => left.sortOrder - right.sortOrder).map((item) => item.name)).toEqual(["Gamma", "Beta", "Alpha"]);

      const duplicate = await app.inject({
        method: "PUT",
        url: "/api/v1/ssh-connections/order",
        cookies,
        payload: { connectionGroupId: groupId, orderedIds: [created.Alpha, created.Alpha] },
      });
      expect(duplicate.statusCode).toBe(400);
      const foreign = await app.inject({
        method: "PUT",
        url: "/api/v1/ssh-connections/order",
        cookies,
        payload: { connectionGroupId: groupId, orderedIds: [created.Alpha, outsider.json().id] },
      });
      expect(foreign.statusCode).toBe(400);

      const appended = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: sshPayload("Delta", "10.0.0.14", { connectionGroupId: groupId }),
      });
      expect(appended.statusCode).toBe(201);
      const withDelta = (await app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies })).json().items as SshItem[];
      const delta = withDelta.find((item) => item.id === appended.json().id);
      expect(delta?.sortOrder).toBe(3);
      expect(withDelta.filter((item) => item.connectionGroupId === groupId).sort((left, right) => left.sortOrder - right.sortOrder).at(-1)?.name).toBe("Delta");
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("orders ungrouped SSH connections separately from named groups", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssh-null-order-"));
    directories.push(directory);
    const db = await openDatabase(configFor(directory));
    await ensureAdmin(db, configFor(directory));
    const app = await buildApp({ config: configFor(directory), db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const first = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("First", "10.1.0.1") });
      const second = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("Second", "10.1.0.2") });
      expect(first.statusCode).toBe(201);
      await app.db.prepare("UPDATE ssh_connections SET updated_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", first.json().id);
      await app.db.prepare("UPDATE ssh_connections SET updated_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", second.json().id);

      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/ssh-connections/order",
        cookies,
        payload: { connectionGroupId: null, orderedIds: [first.json().id, second.json().id] },
      });
      expect(response.statusCode).toBe(200);
      const items = (await app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies })).json().items as SshItem[];
      expect(items.every((item) => item.connectionGroupId === null)).toBe(true);
      expect(items.sort((left, right) => left.sortOrder - right.sortOrder).map((item) => item.name)).toEqual(["First", "Second"]);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("requires the complete environment log list and appends a log created after that order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-log-order-"));
    directories.push(directory);
    const db = await openDatabase(configFor(directory));
    await ensureAdmin(db, configFor(directory));
    const app = await buildApp({ config: configFor(directory), db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({
        method: "POST",
        url: "/api/v1/environments",
        cookies,
        payload: { name: "日志环境", status: "active", tags: [] },
      });
      expect(environment.statusCode).toBe(201);
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: sshPayload("日志机", "10.2.0.1", { environmentId }),
      });
      expect(connection.statusCode).toBe(201);

      const created: Record<string, string> = {};
      for (const [name, filePath, updatedAt] of [
        ["Alpha", "/var/log/alpha.log", "2026-01-01T00:00:00.000Z"],
        ["Beta", "/var/log/beta.log", "2026-01-02T00:00:00.000Z"],
        ["Gamma", "/var/log/gamma.log", "2026-01-03T00:00:00.000Z"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/environments/${environmentId}/logs`,
          cookies,
          payload: { sshConnectionId: connection.json().id, name, filePaths: [filePath] },
        });
        expect(response.statusCode).toBe(201);
        created[name] = response.json().id as string;
        await app.db.prepare("UPDATE environment_logs SET updated_at = ? WHERE id = ?").run(updatedAt, created[name]);
      }

      const initial = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/logs`, cookies });
      expect(initial.json().items.map((item: { name: string }) => item.name)).toEqual(["Gamma", "Beta", "Alpha"]);

      const reordered = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/logs/order`,
        cookies,
        payload: { orderedIds: [created.Alpha, created.Beta, created.Gamma] },
      });
      expect(reordered.statusCode).toBe(200);
      const listed = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/logs`, cookies });
      expect(listed.json().items.map((item: { name: string }) => item.name)).toEqual(["Alpha", "Beta", "Gamma"]);

      const partial = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/logs/order`,
        cookies,
        payload: { orderedIds: [created.Alpha, created.Gamma] },
      });
      expect(partial.statusCode).toBe(400);

      const appended = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/logs`,
        cookies,
        payload: { sshConnectionId: connection.json().id, name: "Delta", filePaths: ["/var/log/delta.log"] },
      });
      expect(appended.statusCode).toBe(201);
      const withDelta = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/logs`, cookies });
      expect(withDelta.json().items.map((item: { name: string }) => item.name)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
      const stored = await app.db.prepare("SELECT sort_order FROM environment_logs WHERE id = ?").get(appended.json().id) as { sort_order: number | string };
      expect(Number(stored.sort_order)).toBe(3);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
