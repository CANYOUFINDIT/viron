import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Server } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { buildSshLogTailCommand, quotePosixShellArg } from "../src/shared/environment-log.js";

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
    masterKey: Buffer.alloc(32, 19),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

interface CapturedShell {
  input: string;
}

async function startSshServer(): Promise<{ server: Server; port: number; commands: string[]; shells: CapturedShell[] }> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const commands: string[] = [];
  const shells: CapturedShell[] = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "ssh-log-secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          stream.write("2026-07-20 first line\n");
          setTimeout(() => stream.write("2026-07-20 followed line\n"), 20);
        });
        session.on("pty", (acceptPty) => acceptPty());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          const captured = { input: "" };
          shells.push(captured);
          let outputStarted = false;
          stream.on("data", (chunk: Buffer | string) => {
            captured.input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
            if (!outputStarted && captured.input.includes("tail -n ")) {
              outputStarted = true;
              stream.write("2026-07-20 shell first line\n");
              setTimeout(() => stream.write("2026-07-20 shell followed line\n"), 20);
            }
          });
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port, commands, shells };
}

function waitFor<T>(messages: T[], predicate: (message: T) => boolean, timeoutMs = 3000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<T>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = messages.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for log message: ${JSON.stringify(messages)}`));
      }
    }, 10);
  });
}

describe("environment SSH logs", () => {
  it("quotes every remote path and only accepts bounded initial line counts", () => {
    const filePaths = ["/var/log/app'$(touch /tmp/envman-pwn);*.log", "/var/log/app/current.log"];
    expect(quotePosixShellArg(filePaths[0]!)).toBe("'/var/log/app'\"'\"'$(touch /tmp/envman-pwn);*.log'");
    expect(buildSshLogTailCommand(filePaths, 750)).toBe(`tail -n 750 -F -- ${filePaths.map(quotePosixShellArg).join(" ")}`);
    expect(() => buildSshLogTailCommand(filePaths, 0)).toThrow("初始行数");
    expect(() => buildSshLogTailCommand(["relative.log"], 200)).toThrow("绝对路径");
  });

  it("migrates existing single-path log rows without losing the configured file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-log-migration-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const legacyDb = new Database(config.databasePath);
    legacyDb.exec(`
      CREATE TABLE environment_logs (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        ssh_connection_id TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(environment_id, ssh_connection_id, file_path)
      )
    `);
    await legacyDb.prepare(`
      INSERT INTO environment_logs (id, environment_id, ssh_connection_id, name, file_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-log", "legacy-environment", "legacy-connection", "旧日志", "/var/log/legacy.log", "2026-07-20", "2026-07-20");
    legacyDb.close();

    const migratedDb = await openDatabase(config);
    const row = await migratedDb.prepare("SELECT file_path, file_paths_json FROM environment_logs WHERE id = ?").get("legacy-log") as {
      file_path: string;
      file_paths_json: string;
    };
    expect(row.file_path).toBe("/var/log/legacy.log");
    expect(JSON.parse(row.file_paths_json)).toEqual(["/var/log/legacy.log"]);
    await migratedDb.close();
  });

  it("stores environment-scoped configs and follows a real SSH exec stream", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-log-test-"));
    directories.push(directory);
    const sshServer = await startSshServer();
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const appPort = (app.server.address() as AddressInfo).port;
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "admin", password: "test-password-123" },
      });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({
        method: "POST",
        url: "/api/v1/environments",
        cookies,
        payload: { name: "日志测试环境", shortName: "LOG", description: "", status: "active", owner: "", tags: [] },
      });
      const otherEnvironment = await app.inject({
        method: "POST",
        url: "/api/v1/environments",
        cookies,
        payload: { name: "其他环境", shortName: "OTHER", description: "", status: "active", owner: "", tags: [] },
      });
      expect(environment.statusCode).toBe(201);
      expect(otherEnvironment.statusCode).toBe(201);

      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId: environment.json().id,
          name: "日志服务器",
          host: "127.0.0.1",
          port: sshServer.port,
          username: "operator",
          authType: "password",
          credential: { password: "ssh-log-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      expect(connection.statusCode).toBe(201);

      const relativePath = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environment.json().id}/logs`,
        cookies,
        payload: { sshConnectionId: connection.json().id, name: "bad", filePath: "var/log/app.log" },
      });
      expect(relativePath.statusCode).toBe(400);

      const crossEnvironment = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${otherEnvironment.json().id}/logs`,
        cookies,
        payload: { sshConnectionId: connection.json().id, name: "bad", filePath: "/var/log/app.log" },
      });
      expect(crossEnvironment.statusCode).toBe(400);

      const filePaths = ["/var/log/app'$(touch /tmp/envman-pwn);*.log", "/var/log/app/current.log"];
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environment.json().id}/logs`,
        cookies,
        payload: { sshConnectionId: connection.json().id, name: "应用日志", filePaths },
      });
      expect(created.statusCode).toBe(201);

      const duplicate = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environment.json().id}/logs`,
        cookies,
        payload: { sshConnectionId: connection.json().id, name: "重复", filePaths },
      });
      expect(duplicate.statusCode).toBe(409);

      const duplicatePathInConfig = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environment.json().id}/logs`,
        cookies,
        payload: { sshConnectionId: connection.json().id, name: "配置内重复", filePaths: ["/tmp/repeated.log", "/tmp/repeated.log"] },
      });
      expect(duplicatePathInConfig.statusCode).toBe(400);

      const listed = await app.inject({ method: "GET", url: `/api/v1/environments/${environment.json().id}/logs`, cookies });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toEqual([
        expect.objectContaining({ name: "应用日志", filePath: filePaths[0], filePaths, connectionName: "日志服务器", connectionAvailable: true }),
      ]);
      const environmentDetail = await app.inject({ method: "GET", url: `/api/v1/environments/${environment.json().id}`, cookies });
      expect(environmentDetail.json().item.logCount).toBe(1);

      const invalidInitialLines = await app.inject({
        method: "POST",
        url: `/api/v1/environment-logs/${created.json().id}/stream`,
        cookies,
        payload: { initialLines: 5001 },
      });
      expect(invalidInitialLines.statusCode).toBe(400);
      expect(sshServer.commands).toEqual([]);

      const started = await app.inject({
        method: "POST",
        url: `/api/v1/environment-logs/${created.json().id}/stream`,
        cookies,
        payload: { initialLines: 750 },
      });
      expect(started.statusCode).toBe(201);
      expect(sshServer.commands).toEqual([buildSshLogTailCommand(filePaths, 750)]);
      expect(started.json().stream).toEqual(expect.objectContaining({ filePaths, initialLines: 750 }));
      const { stream, ticket } = started.json() as { stream: { id: string }; ticket: string };

      const messages: Array<Record<string, unknown>> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${appPort}/ws/ssh-logs?ticket=${encodeURIComponent(ticket)}`);
      socket.on("message", (message) => messages.push(JSON.parse(message.toString()) as Record<string, unknown>));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await waitFor(messages, (message) => message.type === "ready");
      await waitFor(messages, (message) => message.type === "output" && String(message.data).includes("first line"));
      await waitFor(messages, (message) => message.type === "output" && String(message.data).includes("followed line"));

      const stopped = await app.inject({ method: "DELETE", url: `/api/v1/ssh-log-streams/${stream.id}`, cookies });
      expect(stopped.statusCode).toBe(204);
      socket.close();

      const loginScript = "kubectl exec -it -n apps app-pod -- sh";
      const scriptedConnection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId: environment.json().id,
          name: "带登录脚本的日志服务器",
          host: "127.0.0.1",
          port: sshServer.port,
          username: "operator",
          authType: "password",
          credential: { password: "ssh-log-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: true, loginScript },
        },
      });
      expect(scriptedConnection.statusCode).toBe(201);
      const scriptedFilePaths = ["/opt/viron/logs/app.log"];
      const scriptedLog = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environment.json().id}/logs`,
        cookies,
        payload: { sshConnectionId: scriptedConnection.json().id, name: "Pod 应用日志", filePaths: scriptedFilePaths },
      });
      expect(scriptedLog.statusCode).toBe(201);
      const scriptedStarted = await app.inject({
        method: "POST",
        url: `/api/v1/environment-logs/${scriptedLog.json().id}/stream`,
        cookies,
        payload: { initialLines: 200 },
      });
      expect(scriptedStarted.statusCode).toBe(201);
      const scriptedTailCommand = buildSshLogTailCommand(scriptedFilePaths, 200);
      const capturedShell = await waitFor(sshServer.shells, (shell) => shell.input.includes(scriptedTailCommand));
      expect(capturedShell.input).toBe(`${loginScript}\n${scriptedTailCommand}\n`);
      expect(sshServer.commands).toEqual([buildSshLogTailCommand(filePaths, 750)]);
      const scriptedStream = scriptedStarted.json().stream as { id: string };
      const scriptedStopped = await app.inject({ method: "DELETE", url: `/api/v1/ssh-log-streams/${scriptedStream.id}`, cookies });
      expect(scriptedStopped.statusCode).toBe(204);
      const scriptedRemoved = await app.inject({ method: "DELETE", url: `/api/v1/environment-logs/${scriptedLog.json().id}`, cookies });
      expect(scriptedRemoved.statusCode).toBe(204);

      const updated = await app.inject({
        method: "PUT",
        url: `/api/v1/environment-logs/${created.json().id}`,
        cookies,
        payload: { sshConnectionId: connection.json().id, name: "更新后的日志", filePaths: ["/var/log/app/current.log", "/var/log/app/error.log"] },
      });
      expect(updated.statusCode).toBe(200);
      const removed = await app.inject({ method: "DELETE", url: `/api/v1/environment-logs/${created.json().id}`, cookies });
      expect(removed.statusCode).toBe(204);
      const empty = await app.inject({ method: "GET", url: `/api/v1/environments/${environment.json().id}/logs`, cookies });
      expect(empty.json().items).toEqual([]);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => sshServer.server.close(() => resolve()));
    }
  }, 10_000);
});
