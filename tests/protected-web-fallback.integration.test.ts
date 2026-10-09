import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import type { PublicWebAccountView } from "../src/server/web-browser/view-manager.js";

type Message = { requestId?: number; token?: string; pageId?: string; type: string; view?: PublicWebAccountView; data?: string; message?: string };
async function until(predicate: () => boolean, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Browsing fallback timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function fixture(mode: string, check: (value: {
  socket: WebSocket; wire: Message[]; context: BrowserContext; auth: Page;
  origin: string; posts: () => number; loads: () => number;
}) => Promise<void>) {
  let posts = 0, homeLoads = 0, entryLoads = 0;
  const pending = new Set<NodeJS.Timeout>();
  const target = createServer((request, response) => {
    // Native browser caching also restores favicon loading. Count document
    // visits, not the browser's automatic icon request, when checking retries.
    if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.method === "POST") {
      posts++;
      if (mode === "rejected") { response.end('<title>Login rejected</title><input type="password"><p role="alert">Rejected</p>'); return; }
      response.writeHead(302, { Location: "/home", "Set-Cookie": "session=fixture-authenticated; Path=/; HttpOnly; SameSite=Lax" }); response.end(); return;
    }
    if (request.url === "/clicked") { response.end('<title>Clicked</title><main>Page controls work</main>'); return; }
    if (request.url === "/settings/security") { response.end('<title>Security settings</title><main>Settings</main><input type="password" name="password">'); return; }
    if (request.url === "/home" || /session=fixture-authenticated/.test(request.headers.cookie ?? "")) {
      homeLoads++;
      response.end(`<title>Business</title><main ${homeLoads === 1 ? 'id="success"' : ''}>Authenticated business</main><button onclick="location.href='/clicked'" style="position:fixed;left:20px;top:20px;width:200px;height:50px">Continue</button>`); return;
    }
    entryLoads++;
    if (mode === "agreement") {
      response.end('<title>Login fixture</title><form method="post"><input id="alpha" name="username"><input id="beta" name="password" type="password"><label><input id="agree" type="checkbox" required>Accept terms</label><button>Login</button></form>'); return;
    }
    if (mode.startsWith("slow")) {
      const form = '<form method="post"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Login</button></form>';
      response.end(`<title>Nacos</title>${mode === "slow-splash" ? '<main>Loading console...</main>' : ''}<script>setTimeout(()=>document.body.innerHTML=${JSON.stringify(form)},3500)</script>`); return;
    }
    if (mode === "readonly" || mode === "permanent-readonly") {
      response.end(`<title>Login fixture</title><form method="post"><input id="alpha" name="username" readonly autocomplete="username" style="position:fixed;left:20px;top:60px;width:220px;height:40px" onfocus="${mode === "readonly" ? 'this.readOnly=false' : ''}"><input id="beta" type="password" name="password" readonly style="position:fixed;left:20px;top:120px;width:220px;height:40px" onfocus="${mode === "readonly" ? 'this.readOnly=false' : ''}"><button style="position:fixed;left:20px;top:190px;width:200px;height:50px">Login</button></form>`); return;
    }
    if (["manual", "moving", "settings"].includes(mode)) {
      response.end('<!doctype html><title>Login fixture</title><input id="alpha" autocomplete="off" style="position:fixed;left:20px;top:60px;width:220px;height:40px"><input id="beta" autocomplete="off" style="position:fixed;left:20px;top:120px;width:220px;height:40px"><button style="position:fixed;left:20px;top:190px;width:200px;height:50px" onclick="fetch(\'/login\',{method:\'POST\',body:new URLSearchParams({username:alpha.value,password:beta.value})}).then(()=>location.href=\'/home\')">Continue</button>' + (mode === "moving" ? '<script>setInterval(()=>document.querySelector("button").style.left=(20+Math.random())+"px",30)</script>' : '')); return;
    }
    const html = `<!doctype html><title>Login fixture</title><form method="post"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Login</button>${mode === "ambiguous" ? '<button type="submit">Sign in</button>' : ''}</form><a href="/clicked" style="position:fixed;left:20px;top:250px;width:200px;height:50px;display:block">Continue browsing</a><script>
      document.querySelector('input[type=password]').addEventListener('input',event=>{localStorage.setItem('unverified-password',event.target.value);sessionStorage.setItem('unverified-password',event.target.value);document.cookie='unverified-password='+event.target.value+'; Path=/'});
      ${mode === "business" ? "document.querySelector('input[type=password]').addEventListener('change',()=>{localStorage.clear();sessionStorage.clear();document.cookie='unverified-password=; Max-Age=0; Path=/'})" : ''}
    </script>`;
    if (mode === "cancel" && entryLoads === 1) {
      const timer = setTimeout(() => { pending.delete(timer); response.end(html); }, 25_000); pending.add(timer);
    } else response.end(html);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  mkdirSync("private/browser-tests", { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), "private/browser-tests/fallback-"));
  // The bundled browser avoids a system Chrome updater inheriting its stdio
  // and delaying persistent-context shutdown during the real 30-second timeout.
  const executable = chromium.executablePath();
  const config: AppConfig = { nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "db.sqlite"), masterKey: Buffer.alloc(32, 29), adminUsername: "admin", adminPassword: "test-password-123", sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30, webSessionExecutor: "server", webBrowserExecutable: existsSync(executable) ? executable : undefined };
  const db = await openDatabase(config); await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const signedIn = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
    const cookies = { envman_session: signedIn.cookies.find((item) => item.name === "envman_session")!.value };
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Browsing fallback" } });
    const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Fixture", url: origin + (mode.startsWith("slow") ? "/nacos/" : "/"), loginConfig: ["invalid", "manual", "moving", "settings", "readonly", "permanent-readonly"].includes(mode) ? { usernameSelector: "[broken(" } : mode === "timeout" ? { usernameSelector: "#missing-user", passwordSelector: "#missing-password" } : mode === "business" ? { successSelector: "#success" } : {} } });
    expect(entry.statusCode).toBe(201);
    const credential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${entry.json().id}/credentials`, cookies, payload: { username: "fixture-user", password: "fixture-password" } });
    const opened = await app.inject({ method: "POST", url: `/api/v1/web-credentials/${credential.json().id}/view`, cookies, payload: { width: 900, height: 650 } });
    expect(opened.statusCode).toBe(200);
    const managed = [...(app.webAccountViews as unknown as { views: Map<string, { context: BrowserContext }> }).views.values()][0];
    const auth = managed.context.pages()[0];
    socket = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws/web-account-view?ticket=${opened.json().ticket}`);
    const wire: Message[] = [];
    socket.on("message", (raw) => wire.push(JSON.parse(String(raw))));
    try { await check({ socket, wire, context: managed.context, auth, origin, posts: () => posts, loads: () => entryLoads }); }
    catch (error) {
      console.error("Fallback fixture:", mode, { posts, homeLoads, entryLoads }, wire.filter((message) => message.view).slice(-6).map((message) => ({ phase: message.view!.protectedLogin?.phase, message: message.view!.protectedLogin?.message, title: message.view!.title, notice: message.view!.loginNotice })));
      throw error;
    }
    expect(JSON.stringify(wire)).not.toContain("fixture-password");
  } finally {
    socket?.terminate(); await app.webAccountViews.closeAll();
    await app.close();
    for (const timer of pending) clearTimeout(timer);
    target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
}

let requestId = 0;
async function normalPage(wire: Message[], context: BrowserContext): Promise<Page> {
  await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Login fixture"), 36_000);
  const page = context.pages()[0];
  await page.waitForLoadState();
  expect(wire.some((message) => message.view?.protectedLogin?.kind === "page")).toBe(false);
  expect(wire.filter((message) => message.view?.protectedLogin === null).at(-1)?.view?.loginNotice).toBe("");
  return page;
}
async function target(socket: WebSocket, wire: Message[], x: number, y: number) {
  const view = wire.filter((message) => message.view?.protectedLogin === null).at(-1)!.view!;
  const id = ++requestId;
  socket.send(JSON.stringify({ type: "credential-context", requestId: id, pageId: view.activePageId, x, y }));
  await until(() => wire.some((message) => message.type === "credential-context" && message.requestId === id));
  const response = wire.find((message) => message.type === "credential-context" && message.requestId === id)!;
  expect(response.token).toBeTruthy();
  return { token: response.token, pageId: response.pageId };
}
function click(socket: WebSocket, x: number, y: number) {
  socket.send(JSON.stringify({ type: "mouse", action: "down", x, y, button: "left" }));
  socket.send(JSON.stringify({ type: "mouse", action: "up", x, y, button: "left" }));
}

describe.skipIf(process.env.VIRON_WEB_BROWSER_TEST !== "1")("normal Web page manual credential filling", () => {
  it.each(["ambiguous", "invalid", "rejected"])("opens a normal page automatically after %s", async (mode) => {
    await fixture(mode, async ({ socket, wire, context, auth, origin, posts }) => {
      const page = await normalPage(wire, context);
      expect(auth.isClosed()).toBe(true);
      expect(await page.locator('input[type="password"]').inputValue()).toBe("");
      expect(await page.evaluate(() => [localStorage.getItem("unverified-password"), sessionStorage.getItem("unverified-password")])).toEqual([null, null]);
      expect((await context.cookies()).some((cookie) => cookie.name === "unverified-password")).toBe(false);
      expect(wire.some((message) => message.type === "login-complete")).toBe(false);
      expect(posts()).toBe(mode === "rejected" ? 1 : 0);
      click(socket, 40, 270);
      await until(() => wire.some((message) => message.view?.title === "Clicked"));
      socket.send(JSON.stringify({ type: "navigate", url: origin + "/" }));
      await until(() => page.url() === origin + "/");
      await page.waitForLoadState();
      expect(await page.locator('input[type="password"]').inputValue()).toBe("");
    });
  }, 45_000);

  it("can cancel an unfinished load and open the normal page", async () => {
    await fixture("cancel", async ({ socket, wire, context, auth, posts, loads }) => {
      await until(() => socket.readyState === WebSocket.OPEN && loads() === 1);
      socket.send(JSON.stringify({ type: "browse" })); socket.send(JSON.stringify({ type: "browse" }));
      await normalPage(wire, context);
      expect(auth.isClosed()).toBe(true); expect(posts()).toBe(0);
    });
  }, 20_000);

  it("keeps an authenticated business page usable without its success marker", async () => {
    await fixture("business", async ({ socket, wire, auth, posts }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Business"));
      expect(auth.isClosed()).toBe(true); expect(posts()).toBe(1);
      click(socket, 40, 40);
      await until(() => wire.some((message) => message.view?.title === "Clicked"));
      expect(wire.some((message) => message.type === "login-complete")).toBe(false);
    });
  }, 20_000);

  it("opens the normal page after automatic login times out", async () => {
    await fixture("timeout", async ({ wire, context, auth, posts }) => {
      await normalPage(wire, context);
      expect(auth.isClosed()).toBe(true); expect(posts()).toBe(0);
    });
  }, 45_000);

  it("fills only the selected inputs and waits for the user to submit", async () => {
    await fixture("manual", async ({ socket, wire, context, auth, posts, loads }) => {
      const page = await normalPage(wire, context);
      const loadCount = loads();
      socket.send(JSON.stringify({ type: "fill-username", ...await target(socket, wire, 40, 80) }));
      await expect.poll(() => page.locator("#alpha").inputValue()).toBe("fixture-user");
      expect(await page.locator("#beta").inputValue()).toBe("");
      socket.send(JSON.stringify({ type: "fill-password", ...await target(socket, wire, 40, 140) }));
      await expect.poll(() => page.locator("#beta").inputValue()).toBe("fixture-password");
      expect(await page.locator("#beta").getAttribute("readonly")).toBeNull();
      expect(await page.locator("#beta").evaluate((node) => getComputedStyle(node).visibility)).toBe("visible");
      expect(posts()).toBe(0); expect(loads()).toBe(loadCount); expect(auth.isClosed()).toBe(true);
      await page.locator("#alpha").fill("edited-user");
      click(socket, 40, 210);
      await until(() => wire.some((message) => message.view?.title === "Business"));
      expect(posts()).toBe(1);
    });
  }, 20_000);

  it.each(["slow-empty", "slow-splash"])("waits for the delayed SPA form and logs in on its first attempt: %s", async (mode) => {
    await fixture(mode, async ({ wire, auth, posts, loads }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Business"));
      expect(auth.isClosed()).toBe(true); expect(posts()).toBe(1); expect(loads()).toBe(1);
    });
  }, 20_000);

  it("opens agreements on the normal page and fills both fields in place without resetting user choices", async () => {
    await fixture("agreement", async ({ socket, wire, context, auth, posts, loads }) => {
      const page = await normalPage(wire, context);
      expect(auth.isClosed()).toBe(true);
      await page.locator("#agree").check();
      const count = loads();
      socket.send(JSON.stringify({ type: "refill" }));
      await expect.poll(() => page.locator("#beta").inputValue()).toBe("fixture-password");
      expect(await page.locator("#alpha").inputValue()).toBe("fixture-user");
      expect(await page.locator("#agree").isChecked()).toBe(true);
      expect(loads()).toBe(count); expect(posts()).toBe(0);
      await page.locator("button").click();
      await until(() => wire.some((message) => message.view?.title === "Business"));
      expect(posts()).toBe(1);
    });
  }, 20_000);

  it.each(["readonly", "permanent-readonly"])("respects %s fields", async (mode) => {
    await fixture(mode, async ({ socket, wire, context, posts }) => {
      const page = await normalPage(wire, context);
      socket.send(JSON.stringify({ type: "fill-password", ...await target(socket, wire, 40, 140) }));
      if (mode === "permanent-readonly") {
        await until(() => wire.some((message) => message.type === "error"));
        expect(await page.locator("#beta").inputValue()).toBe("");
      } else {
        await expect.poll(() => page.locator("#beta").inputValue()).toBe("fixture-password");
        socket.send(JSON.stringify({ type: "fill-username", ...await target(socket, wire, 40, 80) }));
        await expect.poll(() => page.locator("#alpha").inputValue()).toBe("fixture-user");
        expect(posts()).toBe(0);
        click(socket, 40, 210);
        await until(() => wire.some((message) => message.view?.title === "Business"));
        expect(posts()).toBe(1);
      }
    });
  }, 20_000);

  it("fills a moved input by identity and rejects a replacement", async () => {
    await fixture("moving", async ({ socket, wire, context }) => {
      const page = await normalPage(wire, context);
      const selected = await target(socket, wire, 40, 140);
      await page.evaluate(() => { document.querySelector<HTMLElement>("#beta")!.style.left = "300px"; });
      socket.send(JSON.stringify({ type: "fill-password", ...selected }));
      await expect.poll(() => page.locator("#beta").inputValue()).toBe("fixture-password");
      const replaced = await target(socket, wire, 320, 140);
      await page.evaluate(() => { document.querySelector("#beta")!.outerHTML = '<input id="beta">'; });
      socket.send(JSON.stringify({ type: "fill-password", ...replaced }));
      await until(() => wire.some((message) => message.type === "error"));
      expect(await page.locator("#beta").inputValue()).toBe("");
    });
  }, 20_000);

  it("never replays a selected target after navigating into settings", async () => {
    await fixture("settings", async ({ socket, wire, context, origin }) => {
      const page = await normalPage(wire, context);
      const selected = await target(socket, wire, 40, 140);
      await page.goto(origin + "/settings/security");
      socket.send(JSON.stringify({ type: "fill-password", ...selected }));
      await until(() => wire.some((message) => message.type === "error"));
      expect(await page.locator('input[type=password]').inputValue()).toBe("");
    });
  }, 20_000);
});
