// Run after build:desktop with Electron. Uses invented credentials and hidden windows.
import { app, BrowserWindow, session } from "electron";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const directory = mkdtempSync(join(tmpdir(), "viron-browsing-native-"));
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
let posts = 0, loads = 0;
const timers = new Set();
const target = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.method === "POST") {
    posts++;
    let body = ""; request.on("data", chunk => body += chunk); request.on("end", () => {
      const values = new URLSearchParams(body); assert.equal(values.get("username"), "fixture-user"); assert.equal(values.get("password"), "fixture-password");
      response.writeHead(302, { Location: "/home", "Set-Cookie": "session=fixture-authenticated; Path=/; HttpOnly; SameSite=Lax" }); response.end();
    }); return;
  }
  if (/session=fixture-authenticated/.test(request.headers.cookie ?? "")) { response.end('<title>Business</title><main>Authenticated business</main>'); return; }
  if (request.url === "/clicked") { response.end('<title>Clicked</title><main>Browsing works</main>'); return; }
  if (request.url === "/manual") { response.end('<title>Login fixture</title><input id="alpha" autocomplete="off" style="position:fixed;left:20px;top:60px;width:220px;height:40px"><input id="beta" autocomplete="off" style="position:fixed;left:20px;top:120px;width:220px;height:40px"><button style="position:fixed;left:20px;top:190px;width:200px;height:50px" onclick="fetch(\'/manual-submit\',{method:\'POST\',body:new URLSearchParams({username:alpha.value,password:beta.value})}).then(()=>location.href=\'/home\')">Continue</button>'); return; }
  const html = '<!doctype html><title>Login fixture</title><form method="post"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Login</button><button type="submit">Sign in</button></form><a href="/clicked">Continue browsing</a><script>document.querySelector("input[type=password]").addEventListener("input",event=>{localStorage.setItem("unverified-password",event.target.value);sessionStorage.setItem("unverified-password",event.target.value);document.cookie="unverified-password="+event.target.value+"; Path=/"})</script>';
  if (request.url === "/cancel" && ++loads === 1) {
    const timer = setTimeout(() => { timers.delete(timer); response.end(html); }, 25_000); timers.add(timer);
  } else response.end(html);
});

async function until(predicate, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timeout: " + description);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function run() {
  await app.whenReady();
  const { setMainWindow } = await import("../dist/desktop/window-host.js");
  const { configureBrowserGuestHost } = await import("../dist/desktop/browser-guest-host.js");
  const { desktopWebViews, browseDesktopWebWithoutAutofill, activeDesktopWebPage, handleDesktopWebViewAction, destroyDesktopWebPages } = await import("../dist/desktop/web-view-runtime.js");
  const { ProtectedWebLogin } = await import("../dist/desktop/protected-web-login.js");
  const { defaultWebLoginConfig } = await import("../dist/shared/protected-web-login.js");
  const owner = setMainWindow(new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false, sandbox: false } }));
  configureBrowserGuestHost(owner.webContents);
  // This fixture shell drives the same authenticated guest-binding IPC as Vue.
  // Production guest preferences replace all shell-supplied preferences.
  await owner.loadURL('data:text/html,' + encodeURIComponent(`<script>
    const {ipcRenderer}=require('electron');const guests=new Map();window.states=[];
    ipcRenderer.on('viron:web-view-state',(_,state)=>states.push(state));
    ipcRenderer.on('viron:browser-host',(_,message)=>{
      if(message.type==='create'){const r=message.request;const w=document.createElement('webview');w.style.cssText='width:900px;height:650px';w.setAttribute('partition',r.partition);w.setAttribute('useragent','VironBrowserGuest/'+r.token);w.setAttribute('allowpopups','');w.addEventListener('did-stop-loading',()=>ipcRenderer.invoke('viron:browser-host:attached',r.token,w.getWebContentsId()),{once:true});w.setAttribute('src','about:blank');guests.set(r.token,w);document.body.append(w)}
      if(message.type==='destroy'){guests.get(message.token)?.remove();guests.delete(message.token)}
    });
  </script>`));
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${target.address().port}`;
  const views = [];
  try {
    for (const path of ["/ambiguous", "/cancel", "/manual"]) {
      const partitionName = `verify-browsing-${randomUUID()}`;
      const view = { id: randomUUID(), registrationId: "fixture", credentialId: randomUUID(), entryId: "fixture", entryUrl: origin + path, entryOrigin: origin,
        username: "fixture-user", password: "", loginConfig: defaultWebLoginConfig(), login: null, loginAttempt: randomUUID(), loginPreparation: Promise.resolve(), loginNotice: "",
        pages: new Map(), pageGeneration: 0, pendingPages: 0, activePageId: "", bounds: { x: 0, y: 0, width: 900, height: 650 }, visible: true, previewing: false,
        closing: false, lastActivityAt: Date.now(), closedReason: "", partition: session.fromPartition(partitionName), partitionName, lastUrlKey: createHash("sha256").update(partitionName).digest("hex"), lastUrl: "", notice: null };
      views.push(view); desktopWebViews.set(view.id, view);
      const login = view.login = new ProtectedWebLogin({ session: view.partition, url: view.entryUrl, username: "fixture-user", password: "fixture-password", bounds: view.bounds,
        config: { ...defaultWebLoginConfig(), usernameSelector: path === "/manual" ? "[broken(" : "" },
        changed: () => { if (view.login === login && login.state.phase === "failed") void browseDesktopWebWithoutAutofill(view); },
        completed: async () => { if (path !== "/manual") throw new Error("Fixture must never claim authentication"); await browseDesktopWebWithoutAutofill(view); } });
      const auth = login.window;
      if (path === "/cancel") {
        await until(() => loads === 1, "unfinished auth load");
        const started = Date.now();
        await Promise.all([handleDesktopWebViewAction(view.id, { type: "browse" }), handleDesktopWebViewAction(view.id, { type: "browse" })]);
        assert.ok(Date.now() - started < 5000);
      } else {
        await until(() => login.state.kind === "page" && Boolean(login.state.image), "interactive login fallback");
        assert.equal(auth.isDestroyed(), false);
        assert.equal(view.pages.size, 0, "No native page or inspector can access the auth DOM");
        if (path === "/manual") {
          const token = y => login.state.targets.find(item => y >= item.y && y < item.y + item.height).token;
          await login.input({ type: "fill-username", targetToken: token(80), revision: login.state.revision });
          await login.input({ type: "fill-password", targetToken: token(140), revision: login.state.revision });
          const frozen = await auth.webContents.executeJavaScript('({value:beta.value,readonly:beta.readOnly,visibility:getComputedStyle(beta).visibility})');
          assert.deepEqual(frozen, { value: "fixture-password", readonly: true, visibility: "hidden" });
          await auth.webContents.executeJavaScript('beta.type="text";beta.style.visibility="visible"');
          assert.equal(await auth.webContents.executeJavaScript('getComputedStyle(beta).visibility'), "hidden");
          await login.input({ type: "click", x: 40, y: 210, revision: login.state.revision });
          await until(() => !view.login && view.pages.size === 1 && activeDesktopWebPage(view).view.webContents.getTitle() === "Business", "manual login handoff");
          assert.equal(auth.isDestroyed(), true);
          view.closing = true; destroyDesktopWebPages(view); desktopWebViews.delete(view.id);
          continue;
        }
        assert.equal(await auth.webContents.executeJavaScript('document.querySelector("input[type=password]").readOnly'), true);
        await handleDesktopWebViewAction(view.id, { type: "browse" });
      }
      try { await until(() => !view.login && view.pages.size === 1 && activeDesktopWebPage(view).view.webContents.getTitle() === "Login fixture", "fresh usable page"); }
      catch (error) { console.error("Fixture state", path, view.login?.state, view.pages.size, view.pendingPages); throw error; }
      assert.equal(auth.isDestroyed(), true);
      assert.match(view.loginNotice, /未填入托管密码/);
      const contents = activeDesktopWebPage(view).view.webContents;
      const values = await contents.executeJavaScript('({password:document.querySelector("input[type=password]").value,local:localStorage.getItem("unverified-password"),tab:sessionStorage.getItem("unverified-password")})');
      assert.deepEqual(values, { password: "", local: null, tab: null });
      assert.equal((await view.partition.cookies.get({})).some(cookie => cookie.name === "unverified-password"), false);
      await contents.executeJavaScript('document.querySelector("a").click()');
      await until(() => contents.getTitle() === "Clicked", "page click");
      await handleDesktopWebViewAction(view.id, { type: "navigate", url: origin + path });
      await until(() => contents.getTitle() === "Login fixture", "navigation");
      await handleDesktopWebViewAction(view.id, { type: "reload" });
      await until(() => !contents.isLoading(), "reload");
      assert.equal(await contents.executeJavaScript('document.querySelector("input[type=password]").value'), "");
      assert.equal(view.login, null);
      view.closing = true; destroyDesktopWebPages(view); desktopWebViews.delete(view.id);
    }
    assert.equal(posts, 1);
    assert.ok(!(await owner.webContents.executeJavaScript("JSON.stringify(states)")).includes("fixture-password"));
    console.log("VIRON_PROTECTED_BROWSING_OK: interactive login fallback, targeted credential fill and freeze, manual authentication, safe handoff, cancelled loads and normal navigation passed.");
  } finally {
    for (const view of views) { view.closing = true; view.login?.dispose(); destroyDesktopWebPages(view); desktopWebViews.delete(view.id); }
    owner.destroy(); for (const timer of timers) clearTimeout(timer);
    target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
  }
}
run().then(() => { rmSync(directory, { recursive: true, force: true }); app.exit(0); }, error => { console.error(error); rmSync(directory, { recursive: true, force: true }); app.exit(1); });
