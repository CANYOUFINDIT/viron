import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import type { PublicWebAccountView } from "../src/server/web-browser/view-manager.js";

type Message = { type: string; view?: PublicWebAccountView; data?: string; message?: string };
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
  const directory = mkdtempSync(join(tmpdir(), "viron-browsing-fallback-"));
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
    const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Fixture", url: origin + (mode.startsWith("slow") ? "/nacos/" : "/"), loginConfig: ["invalid", "manual", "moving", "settings"].includes(mode) ? { usernameSelector: "[broken(" } : mode === "timeout" ? { usernameSelector: "#missing-user", passwordSelector: "#missing-password" } : mode === "business" ? { successSelector: "#success" } : {} } });
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

describe.skipIf(process.env.VIRON_WEB_BROWSER_TEST !== "1")("web browsing survives automatic-login failures", () => {
  it.each(["ambiguous", "invalid", "rejected"])("retains an interactive protected fallback after %s and can still open an unfilled normal page", async (mode) => {
    await fixture(mode, async ({ socket, wire, context, auth, origin, posts }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin?.kind === "page"));
      expect(auth.isClosed()).toBe(false);
      if (mode !== "rejected") {
        expect(await auth.locator('input[type="password"]').getAttribute("readonly")).not.toBeNull();
        expect(await auth.locator('input[type="password"]').evaluate((node) => getComputedStyle(node).visibility)).toBe("hidden");
      }
      expect(wire.some((message) => message.type === "frame")).toBe(false);
      socket.send(JSON.stringify({ type: "browse" }));
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Login fixture"));
      expect(auth.isClosed()).toBe(true);
      const page = context.pages()[0];
      expect(await page.locator('input[type="password"]').inputValue()).toBe("");
      expect(await page.evaluate(() => [localStorage.getItem("unverified-password"), sessionStorage.getItem("unverified-password")])).toEqual([null, null]);
      expect((await context.cookies()).some((cookie) => cookie.name === "unverified-password")).toBe(false);
      expect(wire.some((message) => message.view?.loginNotice.includes("未填入托管密码"))).toBe(true);
      expect(wire.some((message) => message.type === "login-complete")).toBe(false);
      expect(posts()).toBe(mode === "rejected" ? 1 : 0);
      socket.send(JSON.stringify({ type: "mouse", action: "down", x: 40, y: 270, button: "left" }));
      socket.send(JSON.stringify({ type: "mouse", action: "up", x: 40, y: 270, button: "left" }));
      await until(() => wire.some((message) => message.view?.title === "Clicked"));
      socket.send(JSON.stringify({ type: "navigate", url: origin + "/" }));
      await until(() => page.url() === origin + "/" && !page.isClosed());
      await page.waitForLoadState();
      socket.send(JSON.stringify({ type: "reload" }));
      await until(() => wire.some((message) => message.type === "frame"));
      expect(await page.locator('input[type="password"]').inputValue()).toBe("");
    });
  }, 20_000);

  it("can stop an unfinished initial page load without waiting for its timeout", async () => {
    await fixture("cancel", async ({ socket, wire, auth, posts, loads }) => {
      await until(() => socket.readyState === WebSocket.OPEN && loads() === 1);
      const started = Date.now();
      socket.send(JSON.stringify({ type: "browse" })); socket.send(JSON.stringify({ type: "browse" }));
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Login fixture"));
      expect(Date.now() - started).toBeLessThan(5000); expect(auth.isClosed()).toBe(true); expect(posts()).toBe(0);
    });
  }, 20_000);

  it("keeps an authenticated fresh business page usable when its success marker is absent", async () => {
    await fixture("business", async ({ socket, wire, auth, posts }) => {
      const started = Date.now();
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Business"));
      expect(Date.now() - started).toBeLessThan(5000); expect(auth.isClosed()).toBe(true); expect(posts()).toBe(1);
      socket.send(JSON.stringify({ type: "mouse", action: "down", x: 40, y: 40, button: "left" }));
      socket.send(JSON.stringify({ type: "mouse", action: "up", x: 40, y: 40, button: "left" }));
      await until(() => wire.some((message) => message.view?.title === "Clicked" && message.view.protectedLogin === null));
      expect(wire.some((message) => message.type === "login-complete")).toBe(false);
    });
  }, 20_000);

  it("keeps a timed-out form interactive and allows leaving it without mandatory retry", async () => {
    await fixture("timeout", async ({ socket, wire, auth, posts }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin?.kind === "page"), 36_000);
      expect(auth.isClosed()).toBe(false);
      socket.send(JSON.stringify({ type: "browse" }));
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Login fixture"));
      expect(auth.isClosed()).toBe(true); expect(posts()).toBe(0);
      expect(wire.some((message) => message.view?.loginNotice.includes("未填入托管密码"))).toBe(true);
    });
  }, 45_000);

  it("fills unrecognized fields by identity, freezes the secret, and completes a real login through the fallback", async () => {
    await fixture("manual", async ({ socket, wire, auth, posts }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin?.kind === "page"));
      const revision = () => wire.filter((message) => message.view?.protectedLogin?.kind === "page").at(-1)!.view!.protectedLogin!.revision;
      const token = (y: number) => wire.filter((message) => message.view?.protectedLogin?.kind === "page").at(-1)!.view!.protectedLogin!.targets!.find((item) => y >= item.y && y < item.y + item.height)!.token;
      expect(await auth.evaluate("typeof globalThis.__vironLogin")).toBe("undefined");
      const stale = revision() + "-stale";
      socket.send(JSON.stringify({ type: "login-input", input: { type: "fill-password", targetToken: "invalid-target", revision: stale } }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await auth.locator("#beta").inputValue()).toBe("");
      socket.send(JSON.stringify({ type: "login-input", input: { type: "fill-username", targetToken: token(80), revision: revision() } }));
      await until(() => wire.some((message) => message.type === "login-input-result"));
      await expect.poll(() => auth.locator("#alpha").inputValue()).toBe("fixture-user");
      socket.send(JSON.stringify({ type: "login-input", input: { type: "fill-password", targetToken: token(140), revision: revision() } }));
      await expect.poll(() => auth.locator("#beta").inputValue()).toBe("fixture-password");
      expect(await auth.locator("#beta").getAttribute("readonly")).not.toBeNull();
      await auth.locator("#beta").evaluate((node) => { (node as HTMLInputElement).type = "text"; node.style.visibility = "visible"; });
      await expect.poll(() => auth.locator("#beta").evaluate((node) => getComputedStyle(node).visibility)).toBe("hidden");
      socket.send(JSON.stringify({ type: "login-input", input: { type: "click", x: 40, y: 210, revision: revision() } }));
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Business"));
      expect(auth.isClosed()).toBe(true); expect(posts()).toBe(1);
      expect(wire.some((message) => message.type === "login-complete")).toBe(false);
    });
  }, 20_000);

  it.each(["slow-empty", "slow-splash"])("retains a delayed SPA on /nacos/ without a login title: %s", async (mode) => {
    await fixture(mode, async ({ socket, wire, auth, posts }) => {
      await auth.waitForLoadState(); await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(auth.isClosed()).toBe(false); expect(posts()).toBe(0);
      expect(wire.some((message) => message.type === "login-complete")).toBe(false);
      if (mode === "slow-splash") {
        await expect.poll(() => auth.locator('input[type=password]').inputValue(), { timeout: 6000 }).toBe("fixture-password");
        expect(await auth.locator('input[type=password]').getAttribute("readonly")).not.toBeNull();
        const state = () => wire.filter((message) => message.view?.protectedLogin?.kind === "page").at(-1)!.view!.protectedLogin!;
        await until(() => Boolean(state()?.image));
        const box = (await auth.locator('button').boundingBox())!;
        socket.send(JSON.stringify({ type: "login-input", input: { type: "click", revision: state().revision, x: box.x + 5, y: box.y + 5 } }));
      }
      await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Business"));
      expect(auth.isClosed()).toBe(true); expect(posts()).toBe(1);
    });
  }, 20_000);

  it.each(["readonly", "permanent-readonly"])("retains %s fields without destroying the fallback", async (mode) => {
    await fixture(mode, async ({ socket, wire, auth, posts }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin?.kind === "page"));
      const state = () => wire.filter((message) => message.view?.protectedLogin?.kind === "page").at(-1)!.view!.protectedLogin!;
      const fill = (type: string, y: number) => socket.send(JSON.stringify({ type: "login-input", requestId: "fill-" + y, input: { type, revision: state().revision, targetToken: state().targets!.find((item) => y >= item.y && y < item.y + item.height)!.token } }));
      expect(await auth.locator("#beta").inputValue()).toBe(""); fill("fill-password", 140);
      if (mode === "permanent-readonly") {
        await until(() => wire.some((message) => message.type === "login-input-result"));
        expect(await auth.locator("#beta").inputValue()).toBe("");
        expect(auth.isClosed()).toBe(false); expect(state().phase).toBe("interactive"); expect(posts()).toBe(0);
      } else {
        await expect.poll(() => auth.locator("#beta").inputValue()).toBe("fixture-password"); fill("fill-username", 80);
        await expect.poll(() => auth.locator("#alpha").inputValue()).toBe("fixture-user");
        socket.send(JSON.stringify({ type: "login-input", input: { type: "click", revision: state().revision, x: 40, y: 210 } }));
        await until(() => wire.some((message) => message.view?.protectedLogin === null && message.view.title === "Business"));
        expect(posts()).toBe(1);
      }
    });
  }, 20_000);

  it("keeps moving pages visible and fills the selected node after it moves, but rejects a replacement", async () => {
    await fixture("moving", async ({ socket, wire, auth }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin?.targets?.length === 2));
      const state = () => wire.filter((message) => message.view?.protectedLogin?.kind === "page").at(-1)!.view!.protectedLogin!;
      const selected = state().targets!.find((item) => item.y > 100)!.token, revision = state().revision;
      await auth.evaluate(() => { document.querySelector<HTMLElement>("#beta")!.style.left = "300px"; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(state().revision).toBe(revision); expect(state().image).not.toBe("");
      socket.send(JSON.stringify({ type: "login-input", input: { type: "fill-password", targetToken: selected, revision } }));
      await expect.poll(() => auth.locator("#beta").inputValue()).toBe("fixture-password");
      await auth.evaluate(() => { document.querySelector("#beta")!.outerHTML = '<input id="beta" style="position:fixed;left:300px;top:120px;width:220px;height:40px">'; });
      const count = wire.filter((message) => message.type === "login-input-result").length;
      socket.send(JSON.stringify({ type: "login-input", input: { type: "fill-password", targetToken: selected, revision } }));
      await until(() => wire.filter((message) => message.type === "login-input-result").length > count);
      expect(await auth.locator("#beta").inputValue()).toBe(""); expect(auth.isClosed()).toBe(false);
    });
  }, 20_000);

  it("does not inject the managed password into a new settings document after assisted login", async () => {
    await fixture("settings", async ({ socket, wire, auth, origin }) => {
      await until(() => wire.some((message) => message.view?.protectedLogin?.targets?.length === 2));
      const state = () => wire.filter((message) => message.view?.protectedLogin?.kind === "page").at(-1)!.view!.protectedLogin!;
      const oldToken = state().targets!.find((item) => item.y > 100)!.token;
      socket.send(JSON.stringify({ type: "login-input", input: { type: "fill-password", targetToken: oldToken, revision: state().revision } }));
      await expect.poll(() => auth.locator("#beta").inputValue()).toBe("fixture-password");
      await auth.goto(origin + "/settings/security");
      await until(() => state().targets?.some((item) => item.token !== oldToken) === true);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await auth.locator('input[type=password]').inputValue()).toBe(""); expect(auth.isClosed()).toBe(false);
      socket.send(JSON.stringify({ type: "login-input", input: { type: "fill-password", targetToken: oldToken, revision: state().revision } }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await auth.locator('input[type=password]').inputValue()).toBe("");
    });
  }, 20_000);
});
