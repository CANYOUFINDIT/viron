import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import WebSocket from "ws";
import { buildApp } from "../src/server/app.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import type { AppConfig } from "../src/server/config.js";

async function fixture() {
  const parent = resolve("private/web-login-mode-tests"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "server-"));
  const config: AppConfig = { nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "db.sqlite"),
    masterKey: Buffer.alloc(32, 23), adminUsername: "admin", adminPassword: "test-password-123", allowWeakPasswords: true,
    sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30, webSessionExecutor: "server",
    webBrowserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
  const db = await openDatabase(config); await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
  const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Login policy fixture" } });
  const base = `/api/v1/environments/${environment.json().id}/web-entries`;
  return { app, cookies, base, close: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("Web entry login policy", () => {
  it("round-trips the entry policy, defaults old entries and prevents another user from changing it", async () => {
    const f = await fixture();
    try {
      const payload = { name: "Policy fixture", url: "https://console.example.test/login" };
      const entry = await f.app.inject({ method: "POST", url: f.base, cookies: f.cookies, payload });
      expect(entry.statusCode).toBe(201);
      const endpoint = `/api/v1/web-entries/${entry.json().id}`;
      const read = () => f.app.inject({ method: "GET", url: f.base, cookies: f.cookies });
      expect((await read()).json().items[0].loginConfig.mode).toBe("protected");
      expect((await f.app.inject({ method: "PUT", url: endpoint, cookies: f.cookies, payload: { ...payload, loginConfig: { mode: "direct", passwordSelector: "#secret" } } })).statusCode).toBe(200);
      expect((await read()).json().items[0].loginConfig).toMatchObject({ mode: "direct", passwordSelector: "#secret" });
      expect((await f.app.inject({ method: "PUT", url: endpoint, cookies: f.cookies, payload })).statusCode).toBe(200);
      expect((await read()).json().items[0].loginConfig.mode).toBe("direct");
      const member = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "other-user", password: "fixture-password" } });
      const memberCookies = { envman_session: member.cookies.find((item) => item.name === "envman_session")!.value };
      const denied = await f.app.inject({ method: "PUT", url: endpoint, cookies: memberCookies, payload: { ...payload, loginConfig: { mode: "protected" } } });
      expect([403, 404]).toContain(denied.statusCode);
      expect((await read()).json().items[0].loginConfig.mode).toBe("direct");
      expect((await f.app.inject({ method: "PUT", url: endpoint, cookies: f.cookies, payload: { ...payload, loginConfig: { mode: "typo" } } })).statusCode).toBe(400);
      const stored = await f.app.db.prepare("SELECT login_config_json FROM web_entries WHERE id = ?").get(entry.json().id) as { login_config_json: string };
      expect(JSON.parse(stored.login_config_json).mode).toBe("direct");
      expect((await f.app.inject({ method: "PUT", url: endpoint, cookies: f.cookies, payload: { ...payload, loginConfig: { mode: "locked" } } })).statusCode).toBe(200);
      expect((await read()).json().items[0].loginConfig.mode).toBe("locked");
    } finally { await f.close(); }
  });
});

describe.skipIf(process.env.VIRON_WEB_BROWSER_TEST !== "1")("direct server Web login", () => {
  it.each(["direct", "locked"] as const)("%s fills a delayed page, preserves manual interaction and does not follow navigation", async (mode) => {
    let posts = 0, loads = 0;
    const html = '<form method="post"><input id="alpha" name="username"><input id="beta" name="password" type="password"><label><input id="agree" type="checkbox" required>Accept terms</label><button>Login</button></form>';
    const target = createServer((request, response) => {
      if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.method === "POST") {
        let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => {
          const values = new URLSearchParams(body);
          if (values.get("username") !== "fixture-user" || values.get("password") !== "fixture-password") { response.writeHead(403); response.end("Denied"); return; }
          posts++; response.writeHead(302, { Location: "/home", "Set-Cookie": "session=fixture-authenticated; Path=/; HttpOnly; SameSite=Lax" }); response.end();
        }); return;
      }
      if (request.url === "/home") { response.end('<title>Business</title><main>Welcome</main>'); return; }
      if (request.url === "/settings") { response.end('<title>Settings</title><input id="alpha"><input id="beta" type="password"><button>Login</button>'); return; }
      loads++; response.end(`<title>Console</title><main>Starting</main><script>setTimeout(()=>document.body.innerHTML=${JSON.stringify(html)},700)</script>`);
    });
    const foreign = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(html); });
    await new Promise<void>((resolveListen) => target.listen(0, "127.0.0.1", resolveListen));
    await new Promise<void>((resolveListen) => foreign.listen(0, "127.0.0.1", resolveListen));
    const origin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    const foreignOrigin = `http://127.0.0.1:${(foreign.address() as { port: number }).port}`;
    const f = await fixture(); let socket: WebSocket | undefined;
    try {
      await f.app.listen({ host: "127.0.0.1", port: 0 });
      const entry = await f.app.inject({ method: "POST", url: f.base, cookies: f.cookies,
        payload: { name: "Fill fixture", url: origin + "/", loginConfig: { mode, usernameSelector: "#alpha", passwordSelector: "#beta" } } });
      const credential = await f.app.inject({ method: "POST", url: `/api/v1/web-entries/${entry.json().id}/credentials`, cookies: f.cookies, payload: { username: "fixture-user", password: "fixture-password" } });
      const opened = await f.app.inject({ method: "POST", url: `/api/v1/web-credentials/${credential.json().id}/view`, cookies: f.cookies, payload: { width: 900, height: 650 } });
      expect(opened.statusCode).toBe(200); expect(opened.json().view.loginMode).toBe(mode); expect(opened.json().view.protectedLogin).toBeNull();
      const managed = [...(f.app.webAccountViews as unknown as { views: Map<string, { activePageId: string; pages: Map<string, { page: Page }>; loginNotice: string }> }).views.values()][0];
      const page = [...managed.pages.values()][0].page;
      socket = new WebSocket(`ws://127.0.0.1:${(f.app.server.address() as { port: number }).port}/ws/web-account-view?ticket=${opened.json().ticket}`);
      const wire: unknown[] = []; socket.on("message", (raw) => wire.push(JSON.parse(String(raw))));
      await new Promise<void>((resolveOpen) => socket!.once("open", resolveOpen));
      await page.waitForFunction("document.querySelector('#beta')?.value === 'fixture-password'");
      expect(posts).toBe(0);
      expect(await page.evaluate("({readonly:beta.readOnly,visibility:getComputedStyle(beta).visibility})")).toEqual({ readonly: mode === "locked", visibility: "visible" });
      if (mode === "locked") {
        await page.evaluate("beta.type='text';beta.readOnly=false;document.body.insertAdjacentHTML('beforeend','<span id=echo>'+beta.value+'</span>')");
        await page.waitForFunction("beta.type === 'password' && beta.readOnly && !echo.textContent.includes('fixture-password')");
        expect(await page.evaluate("typeof globalThis.__vironWebPasswordLocks")).toBe("undefined");
      }
      await page.locator("#agree").check(); await page.evaluate("alpha.value='';beta.value='';beta.type='text'");
      socket.send(JSON.stringify({ type: "refill" }));
      await page.waitForFunction("beta.value === 'fixture-password'");
      expect(await page.locator("#agree").isChecked()).toBe(true); expect(loads).toBe(1); expect(posts).toBe(0);
      await page.locator("button").click(); await page.waitForURL(origin + "/home"); expect(posts).toBe(1);
      await page.goto(origin + "/settings"); await new Promise((resolveWait) => setTimeout(resolveWait, 600));
      expect(await page.locator("#beta").inputValue()).toBe("");
      if (mode === "locked") {
        const rect = (await page.locator("#beta").boundingBox())!;
        socket.send(JSON.stringify({ type: "credential-context", requestId: "manual-lock", pageId: managed.activePageId, x: rect.x + 5, y: rect.y + 5 }));
        const menu = await new Promise<{ token: string }>((resolveMenu, reject) => {
          const timeout = setTimeout(() => reject(new Error("Missing context menu reply")), 3000);
          socket!.on("message", (raw) => { const message = JSON.parse(String(raw)); if (message.type === "credential-context" && message.requestId === "manual-lock") { clearTimeout(timeout); resolveMenu(message); } });
        });
        expect(menu.token).not.toBe("");
        socket.send(JSON.stringify({ type: "fill-password", pageId: managed.activePageId, token: menu.token }));
        await page.waitForFunction("beta.value === 'fixture-password' && beta.readOnly && beta.type === 'password'");
      }
      await page.goto(foreignOrigin); socket.send(JSON.stringify({ type: "refill" }));
      await page.waitForFunction("document.querySelector('#beta') !== null");
      await new Promise((resolveWait) => setTimeout(resolveWait, 600));
      expect(managed.loginNotice).toContain("不在允许登录域名"); expect(await page.locator("#beta").inputValue()).toBe("");
      expect(JSON.stringify(wire)).not.toContain("fixture-password");
    } finally {
      socket?.close(); await f.close();
      for (const server of [target, foreign]) { server.closeAllConnections(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); }
    }
  }, 30_000);
});
