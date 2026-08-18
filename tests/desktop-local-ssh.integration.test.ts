import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const enabled = process.env.VIRON_DESKTOP_SSH_TEST === "1";
const directories: string[] = [];
const sshServers: Server[] = [];
const applications: Array<{ close(): Promise<void> }> = [];
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(sshServers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runElectron(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(electronPath, args, { cwd: root, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`桌面 SSH 集成测试超时\n${stdout}\n${stderr}`));
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
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "desktop-secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("window-change", (acceptWindow) => acceptWindow?.());
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("DESKTOP-SSH-READY\r\n");
        stream.on("data", (chunk: Buffer) => stream.write(Buffer.concat([Buffer.from("ECHO:"), chunk])));
      });
    }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  sshServers.push(server);
  return (server.address() as AddressInfo).port;
}

describe.skipIf(!enabled)("macOS local SSH", () => {
  it("opens an SSH shell through the preload IPC bridge and records the session locally", async () => {
    const sshPort = await startSshServer();
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-local-ssh-"));
    directories.push(directory);
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      databasePath: join(directory, "envman.db"),
      masterKey: Buffer.alloc(32, 37),
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
      url: "/api/v1/ssh-connections",
      cookies,
      payload: {
        name: "Desktop SSH Fixture",
        host: "127.0.0.1",
        port: sshPort,
        username: "operator",
        authType: "password",
        credential: { password: "desktop-secret" },
        options: { loginScriptEnabled: true, loginScript: "echo LOGIN-SCRIPT" },
      },
    });
    expect(connection.statusCode).toBe(201);

    const result = await runElectron([
      `--user-data-dir=${join(directory, "electron-user-data")}`,
      ".",
      "--smoke-test",
      `--smoke-endpoint=http://127.0.0.1:${appPort}`,
    ], {
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VIRON_DESKTOP_SMOKE_USERNAME: config.adminUsername,
      VIRON_DESKTOP_SMOKE_PASSWORD: config.adminPassword,
      VIRON_DESKTOP_SMOKE_SSH_CONNECTION_ID: connection.json().id,
    });
    expect(result.code, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find((item) => item.startsWith("VIRON_DESKTOP_SMOKE "));
    expect(line, result.stdout).toBeTruthy();
    const smoke = JSON.parse(line!.slice("VIRON_DESKTOP_SMOKE ".length));
    expect(smoke.localSsh).toEqual({
      opened: true,
      textInputEchoed: true,
      binaryInputEchoed: true,
      resized: true,
      agentContextRead: true,
      recordingCompleted: true,
    });
  }, 60_000);
});
