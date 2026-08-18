import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const enabled = process.env.VIRON_DESKTOP_WEB_TEST === "1";
const directories: string[] = [];
const servers: Server[] = [];
const applications: Array<{ close(): Promise<void> }> = [];
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("测试服务器未返回端口"));
      else resolvePort(address.port);
    });
  });
}

function runElectron(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(electronPath, args, { cwd: root, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`桌面集成测试超时\n${stdout}\n${stderr}`));
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

describe.skipIf(!enabled)("macOS local Web", () => {
  it("opens, uploads, downloads, and clears an isolated account Profile", async () => {
    const target = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/login") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const username = new URLSearchParams(body).get("username") || "unknown";
          response.writeHead(302, { Location: "/", "Set-Cookie": `account=${encodeURIComponent(username)}; Path=/; SameSite=Lax` });
          response.end();
        });
        return;
      }
      if (request.url === "/upload") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Upload fixture</title><input id="file" type="file"><script>file.addEventListener("change",()=>{location.href="/selected?name="+encodeURIComponent(file.files[0].name)})</script>`);
        return;
      }
      if (request.url?.startsWith("/selected?")) {
        const filename = new URL(request.url, "http://127.0.0.1").searchParams.get("name") || "unknown";
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Selected ${filename}</title>`);
        return;
      }
      if (request.url === "/download") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Download fixture</title><a href="/artifact.txt" download>download</a>`);
        return;
      }
      if (request.url === "/artifact.txt") {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename=artifact.txt" });
        response.end("desktop download contents");
        return;
      }
      const account = /(?:^|;\s*)account=([^;]+)/.exec(request.headers.cookie || "")?.[1];
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (account) response.end(`<!doctype html><title>Logged ${decodeURIComponent(account)}</title>`);
      else response.end(`<!doctype html><title>Login</title><form method="post" action="/login"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>登录</button></form><script>const form=document.querySelector("form");form.addEventListener("input",()=>{const values=new FormData(form);if(values.get("username")&&values.get("password"))setTimeout(()=>form.requestSubmit(),0)})</script>`);
    });
    servers.push(target);
    const targetPort = await listen(target);

    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-local-web-"));
    directories.push(directory);
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      databasePath: join(directory, "envman.db"),
      masterKey: Buffer.alloc(32, 31),
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
    const appPort = (app.server.address() as { port: number }).port;
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Desktop local Web" } });
    const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Fixture", url: `http://127.0.0.1:${targetPort}/` } });
    const credential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${entry.json().id}/credentials`, cookies, payload: { username: config.adminUsername, password: "target-password", note: "", customFields: {} } });

    const userData = join(directory, "electron-user-data");
    const uploadPath = join(directory, "upload fixture.txt");
    const downloadPath = join(directory, "artifact.txt");
    writeFileSync(uploadPath, "desktop upload contents");
    const result = await runElectron([
      `--user-data-dir=${userData}`,
      ".",
      "--smoke-test",
      `--smoke-endpoint=http://127.0.0.1:${appPort}`,
    ], {
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VIRON_DESKTOP_SMOKE_USERNAME: config.adminUsername,
      VIRON_DESKTOP_SMOKE_PASSWORD: config.adminPassword,
      VIRON_DESKTOP_SMOKE_WEB_CREDENTIAL_ID: credential.json().id,
      VIRON_DESKTOP_SMOKE_UPLOAD_PATH: uploadPath,
      VIRON_DESKTOP_SMOKE_DOWNLOAD_PATH: downloadPath,
    });
    expect(result.code, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find((item) => item.startsWith("VIRON_DESKTOP_SMOKE "));
    expect(line, result.stdout).toBeTruthy();
    const smoke = JSON.parse(line!.slice("VIRON_DESKTOP_SMOKE ".length));
    expect(smoke.localWeb).toEqual({ opened: true, blankOpenedWithoutEntry: true, manualRefillOnCurrentPage: true, sessionStatePersisted: true, lastLocationRestored: true, tabsReordered: true, inspectorOpened: true, resetCleared: true, uploadSelected: true, downloadTriggered: true });
    expect(basename(uploadPath)).toBe("upload fixture.txt");
    expect(readFileSync(downloadPath, "utf8")).toBe("desktop download contents");
  });
});
