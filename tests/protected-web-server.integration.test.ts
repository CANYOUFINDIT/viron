import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Page } from "playwright-core";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import type { ProtectedLoginState } from "../src/shared/protected-web-login.js";

type Message = { type: string; requestId?: number; message?: string; view?: { protectedLogin: ProtectedLoginState | null; title: string } };
function wait(socket: WebSocket, predicate: (message: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("Protected server login timed out")); }, 15_000);
    const receive = (raw: WebSocket.RawData) => { const message = JSON.parse(String(raw)) as Message; if (predicate(message)) { clearTimeout(timer); socket.off("message", receive); resolve(message); } };
    socket.on("message", receive);
  });
}

describe.skipIf(process.env.VIRON_WEB_BROWSER_TEST !== "1")("protected server Web login", () => {
  it("handles checkbox → animated terms dialog → authenticated business page without exposing the login page", async () => {
    let posts = 0;
    const target = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.method === "POST") {
        let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => {
          const fields = new URLSearchParams(body);
          if (fields.get("username") !== "fixture-user" || fields.get("password") !== "fixture-password") { response.writeHead(403); response.end("Denied"); return; }
          posts++; response.writeHead(302, { Location: "/home", "Set-Cookie": "account=authenticated; Path=/; HttpOnly; SameSite=Lax" }); response.end();
        }); return;
      }
      if (/account=authenticated/.test(request.headers.cookie ?? "")) { response.end('<title>Business</title><main id="success">Welcome</main>'); return; }
      response.end(`<!doctype html><title>Login</title><style>input,button{display:block;margin:12px;width:180px;height:30px}#agreement{display:block;margin:20px;width:420px;height:70px}#terms{position:fixed;left:40px;top:40px;width:450px;height:220px;padding:12px;background:#222;color:white;animation:appear .2s}@keyframes appear{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}</style><form method="post"><input name="username" autocomplete="username"><input name="password" type="password"><label id="agreement"><input id="agree" type="checkbox" required>I agree to privacy and service terms</label><button type="submit">Login</button></form><aside id="clock"></aside><script>
        setInterval(()=>clock.textContent=String(Date.now()),30);
        agree.addEventListener('click',event=>{event.preventDefault();const dialog=document.createElement('section');dialog.id='terms';dialog.setAttribute('role','dialog');dialog.innerHTML='<p>Privacy and service terms</p><button id="decline" type="button">Disagree</button><button id="accept" type="button">Agree</button>';document.body.append(dialog);document.querySelector('#accept').addEventListener('click',()=>{agree.checked=true;dialog.remove()});document.querySelector('#decline').addEventListener('click',()=>dialog.remove());});
      </script>`);
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    const directory = mkdtempSync(join(tmpdir(), "viron-protected-server-"));
    const config: AppConfig = { nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "db.sqlite"), masterKey: Buffer.alloc(32, 23), adminUsername: "admin", adminPassword: "test-password-123", sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30, webSessionExecutor: "server", webBrowserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
    const db = await openDatabase(config); await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    let socket: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Protected login test" } });
      const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Terms fixture", url: `http://127.0.0.1:${targetPort}/login`, loginConfig: { successSelector: "#success" } } });
      const credential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${entry.json().id}/credentials`, cookies, payload: { username: "fixture-user", password: "fixture-password" } });
      const id = credential.json().id;
      const opened = await app.inject({ method: "POST", url: `/api/v1/web-credentials/${id}/view`, cookies, payload: { width: 900, height: 650 } });
      expect(opened.statusCode).toBe(200); expect(opened.json().frame).toBe(""); expect(opened.json().view.pages).toEqual([]);
      socket = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws/web-account-view?ticket=${opened.json().ticket}`);
      const wire: Message[] = [];
      socket.on("message", (raw) => wire.push(JSON.parse(String(raw))));
      const first = await wait(socket, (message) => message.view?.protectedLogin?.phase === "interactive");
      expect(first.view!.protectedLogin!.kind).toBe("agreement"); expect(posts).toBe(0);
      await expect(app.webAccountViews.snapshot(login.json().user, id, 900, 650, 1000)).rejects.toThrow("后台登录验证");
      const attack = wait(socket, (message) => message.type === "error"); socket.send(JSON.stringify({ type: "mouse", action: "down", x: 25, y: 100 })); await attack;
      const managed = [...(app.webAccountViews as unknown as { views: Map<string, { context: { pages(): Page[] } }> }).views.values()][0];
      const auth = managed.context.pages()[0];
      expect(await auth.evaluate("typeof globalThis.__vironLogin")).toBe("undefined");
      const checkbox = await auth.evaluate("(() => {const a=agreement.getBoundingClientRect(),b=agree.getBoundingClientRect();return{x:b.x-a.x+20,y:b.y-a.y+12}})()");
      const modal = wait(socket, (message) => message.view?.protectedLogin?.phase === "interactive" && message.view.protectedLogin.width > 450);
      socket.send(JSON.stringify({ type: "login-input", requestId: 1, input: { type: "click", ...checkbox, revision: first.view!.protectedLogin!.revision } }));
      const second = await modal;
      expect(await auth.evaluate('getComputedStyle(document.querySelector("input[type=password]")).visibility')).toBe("hidden");
      expect(wire.some((message) => message.type === "frame")).toBe(false);
      const stale = wait(socket, (message) => message.type === "login-input-result" && message.requestId === 2);
      socket.send(JSON.stringify({ type: "login-input", requestId: 2, input: { type: "click", ...checkbox, revision: first.view!.protectedLogin!.revision } }));
      expect((await stale).message).toBeUndefined(); expect(await auth.evaluate('Boolean(document.querySelector("#terms"))')).toBe(true);
      const confirm = await auth.evaluate("(() => {const a=terms.getBoundingClientRect(),b=document.querySelector('#accept').getBoundingClientRect();return{x:b.x-a.x+20,y:b.y-a.y+12}})()");
      const finished = wait(socket, (message) => message.view?.protectedLogin === null && message.view.title === "Business");
      const started = Date.now();
      socket.send(JSON.stringify({ type: "login-input", requestId: 3, input: { type: "click", ...confirm, revision: second.view!.protectedLogin!.revision } }));
      await finished;
      expect(Date.now() - started).toBeLessThan(3500); expect(posts).toBe(1); expect(auth.isClosed()).toBe(true);
      const snapshot = await app.webAccountViews.snapshot(login.json().user, id, 900, 650, 1000);
      expect(snapshot.text).toContain("Welcome"); expect(JSON.stringify(wire)).not.toContain("fixture-password");
    } finally {
      socket?.close(); await app.close(); target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
