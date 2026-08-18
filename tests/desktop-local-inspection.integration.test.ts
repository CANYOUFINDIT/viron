import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SshServer } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const enabled = process.env.VIRON_DESKTOP_INSPECTION_TEST === "1";
const directories: string[] = [];
const sshServers: SshServer[] = [];
const httpServers: HttpServer[] = [];
const applications: Array<{ close(): Promise<void> }> = [];
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(sshServers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(httpServers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function block(value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([content.length]), content]);
}

function tunnelRows(): Buffer {
  return Buffer.concat([
    uint32(1111), uint16(202), uint32(0), Buffer.alloc(6),
    uint32(0), uint32(0), uint32(0), uint32(1), uint32(1), Buffer.alloc(12),
    block("envman_connection_check"), block(""), uint32(3), uint32(0), uint32(255),
    block("1"), Buffer.from([0]),
  ]);
}

function runElectron(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const executable = process.env.VIRON_DESKTOP_INSPECTION_EXECUTABLE || electronPath;
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`桌面连接巡检集成测试超时\n${stdout}\n${stderr}`));
    }, 60_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveProcess({ code, stdout, stderr });
    });
  });
}

async function startSshServer(): Promise<number> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const server = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "desktop-secret") context.accept();
      else context.reject();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  sshServers.push(server);
  return (server.address() as AddressInfo).port;
}

async function startHttpTunnel(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.end(tunnelRows());
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  httpServers.push(server);
  return (server.address() as AddressInfo).port;
}

describe.skipIf(!enabled)("macOS local connection inspection", () => {
  it("inspects SSH and database connections locally and persists the signed report", async () => {
    const sshPort = await startSshServer();
    const tunnelPort = await startHttpTunnel();
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-local-inspection-"));
    directories.push(directory);
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      databasePath: join(directory, "envman.db"),
      masterKey: Buffer.alloc(32, 43),
      adminUsername: "desktop-smoke",
      adminPassword: "desktop-smoke-password",
      allowWeakPasswords: true,
      sessionTtlHours: 12,
      terminalIdleMinutes: 30,
      auditRetentionDays: 30,
    };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    applications.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const appPort = (app.server.address() as AddressInfo).port;
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const sshConnection = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: {
        name: "Desktop Inspection SSH",
        host: "127.0.0.1",
        port: sshPort,
        username: "operator",
        authType: "password",
        credential: { password: "desktop-secret" },
      },
    });
    expect(sshConnection.statusCode).toBe(201);
    const databaseConnection = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: {
        name: "Desktop Inspection Database",
        engine: "mariadb",
        host: "database.internal",
        port: 3306,
        username: "operator",
        credential: { password: "desktop-secret" },
        connectionMode: "httpTunnel",
        options: { httpTunnelUrl: `http://127.0.0.1:${tunnelPort}/ntunnel_mysql.php` },
      },
    });
    expect(databaseConnection.statusCode).toBe(201);

    const packaged = Boolean(process.env.VIRON_DESKTOP_INSPECTION_EXECUTABLE);
    const result = await runElectron([
      `--user-data-dir=${join(directory, "electron-user-data")}`,
      ...(packaged ? [] : ["."]),
      "--smoke-test",
      `--smoke-endpoint=http://127.0.0.1:${appPort}`,
    ], {
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VIRON_DESKTOP_SMOKE_USERNAME: config.adminUsername,
      VIRON_DESKTOP_SMOKE_PASSWORD: config.adminPassword,
      VIRON_DESKTOP_SMOKE_INSPECTION_SSH_CONNECTION_ID: sshConnection.json().id,
      VIRON_DESKTOP_SMOKE_INSPECTION_DATABASE_CONNECTION_ID: databaseConnection.json().id,
    });
    expect(result.code, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find((item) => item.startsWith("VIRON_DESKTOP_SMOKE "));
    expect(line, result.stdout).toBeTruthy();
    const smoke = JSON.parse(line!.slice("VIRON_DESKTOP_SMOKE ".length));
    expect(smoke.localInspection).toEqual({
      total: 2,
      available: 2,
      sshAvailable: true,
      databaseAvailable: true,
      credentialsHidden: true,
    });

    const rows = await db.prepare(`
      SELECT connection_type, connection_id, status FROM connection_inspection_results ORDER BY connection_type
    `).all() as Array<{ connection_type: string; connection_id: string; status: string }>;
    expect(rows).toEqual([
      { connection_type: "database", connection_id: databaseConnection.json().id, status: "available" },
      { connection_type: "ssh", connection_id: sshConnection.json().id, status: "available" },
    ]);
    const audit = await db.prepare("SELECT details_json FROM audit_events WHERE action = 'connection.inspected' ORDER BY created_at DESC LIMIT 1").get() as { details_json: string };
    expect(JSON.parse(audit.details_json)).toMatchObject({ executionMode: "desktop-local" });
  }, 60_000);
});
