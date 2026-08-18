import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const enabled = process.env.VIRON_DESKTOP_DATABASE_TEST === "1";
const directories: string[] = [];
const httpServers: Server[] = [];
const applications: Array<{ close(): Promise<void> }> = [];
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
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

function tunnelRows(fields: Array<{ name: string; type: number; value: string }>): Buffer {
  return Buffer.concat([
    uint32(1111), uint16(202), uint32(0), Buffer.alloc(6),
    uint32(0), uint32(0), uint32(0), uint32(fields.length), uint32(1), Buffer.alloc(12),
    ...fields.flatMap((field) => [block(field.name), block(""), uint32(field.type), uint32(0), uint32(255)]),
    ...fields.map((field) => block(field.value)),
    Buffer.from([0]),
  ]);
}

function runElectron(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const executable = process.env.VIRON_DESKTOP_DATABASE_EXECUTABLE || electronPath;
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`桌面数据库集成测试超时\n${stdout}\n${stderr}`));
    }, process.env.VIRON_DESKTOP_DATABASE_EXECUTABLE ? 25_000 : 60_000);
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

async function startHttpTunnel(): Promise<number> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const sql = form.getAll("q[]").map((value) => Buffer.from(value, "base64").toString("utf8")).join("; ");
      const finish = () => {
        if (response.destroyed) return;
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        if (/SELECT\s+VERSION\(\)/i.test(sql)) {
          response.end(tunnelRows([
            { name: "version", type: 253, value: "11.4.0-MariaDB" },
            { name: "connectionId", type: 3, value: "17" },
          ]));
        } else if (sql.includes("DESKTOP-DATABASE-CANCEL")) {
          response.end(tunnelRows([{ name: "marker", type: 253, value: "DESKTOP-DATABASE-CANCEL" }]));
        } else {
          response.end(tunnelRows([{ name: "marker", type: 253, value: "DESKTOP-DATABASE-READY" }]));
        }
      };
      if (sql.includes("DESKTOP-DATABASE-CANCEL")) setTimeout(finish, 2_000);
      else finish();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  httpServers.push(server);
  return (server.address() as AddressInfo).port;
}

describe.skipIf(!enabled)("macOS local database", () => {
  it("tests, queries, cancels, and audits a database through the preload API bridge", async () => {
    const tunnelPort = await startHttpTunnel();
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-local-database-"));
    directories.push(directory);
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      databasePath: join(directory, "envman.db"),
      masterKey: Buffer.alloc(32, 41),
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
    const connection = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: {
        name: "Desktop Database Fixture",
        engine: "mariadb",
        host: "database.internal",
        port: 3306,
        username: "operator",
        credential: { password: "desktop-secret", httpTunnelUsername: "tunnel-user", httpTunnelPassword: "tunnel-secret" },
        connectionMode: "httpTunnel",
        options: { httpTunnelUrl: `http://127.0.0.1:${tunnelPort}/ntunnel_mysql.php` },
      },
    });
    expect(connection.statusCode).toBe(201);

    const packaged = Boolean(process.env.VIRON_DESKTOP_DATABASE_EXECUTABLE);
    const result = await runElectron([
      `--user-data-dir=${join(directory, "electron-user-data")}`,
      ...(packaged ? [] : ["."]),
      "--smoke-test",
      `--smoke-endpoint=http://127.0.0.1:${appPort}`,
    ], {
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VIRON_DESKTOP_SMOKE_USERNAME: config.adminUsername,
      VIRON_DESKTOP_SMOKE_PASSWORD: config.adminPassword,
      VIRON_DESKTOP_SMOKE_DATABASE_CONNECTION_ID: connection.json().id,
    });
    expect(result.code, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find((item) => item.startsWith("VIRON_DESKTOP_SMOKE "));
    expect(line, result.stdout).toBeTruthy();
    const smoke = JSON.parse(line!.slice("VIRON_DESKTOP_SMOKE ".length));
    expect(smoke.localDatabase).toEqual({ tested: true, queried: true, cancelled: true });

    const deadline = Date.now() + 5_000;
    let histories = 0;
    while (Date.now() < deadline) {
      histories = Number((await db.prepare("SELECT COUNT(*) AS total FROM database_query_history").get() as { total: number }).total);
      if (histories >= 2) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(histories).toBe(2);
    const rows = await db.prepare("SELECT status, sql_text FROM database_query_history ORDER BY created_at").all() as Array<{ status: string; sql_text: string }>;
    expect(rows.map((row) => row.status).sort()).toEqual(["cancelled", "success"]);
    expect(rows.some((row) => row.sql_text.includes("DESKTOP-DATABASE-READY"))).toBe(true);
  }, 60_000);
});
