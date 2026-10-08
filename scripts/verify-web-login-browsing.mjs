// Run after build:desktop with Electron. Uses invented credentials and hidden windows.
import { app, BrowserWindow, Menu, session } from "electron";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const parent = resolve("private/web-login-mode-tests"); mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, "browsing-native-"));
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
  while (!await predicate()) {
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
  const { setActiveEndpoint } = await import("../dist/desktop/endpoint-context.js");
  const { desktopDeviceAuthorizationContext } = await import("../dist/desktop/desktop-runtime-context.js");
  const { createDeviceIdentity } = await import("../dist/desktop/device-identity.js");
  const identity = createDeviceIdentity();
  const auth = { user: { id: "fixture-user-id", username: "fixture-user" }, workspace: { type: "personal", id: "fixture-workspace" } };
  const endpoint = "https://endpoint.example.test";
  const authorization = { auth, identity, endpoint };
  const views = [];
  setActiveEndpoint({ endpoint, protocolVersion: 1, capabilities: {}, partition: { fetch: async (url, options) => {
    const id = new URL(url).pathname.split("/").at(-2);
    const view = views.find(item => item.credentialId === id);
    assert.ok(view);
    const request = JSON.parse(options.body);
    const credential = { credentialId: id, entryId: view.entryId, entryUrl: view.entryUrl, username: "fixture-user", password: "fixture-password", customFields: {}, credentialUpdatedAt: new Date().toISOString(), loginConfig: { ...defaultWebLoginConfig(), usernameSelector: "#alpha", passwordSelector: "#beta" } };
    const claims = { version: 1, algorithm: "RSA-OAEP-256+A256GCM", keyId: identity.keyId, deviceId: identity.deviceId,
      requestId: request.requestId, userId: auth.user.id, workspaceType: auth.workspace.type, workspaceId: auth.workspace.id, credentialId: id,
      endpoint, targetOrigin: origin, credentialUpdatedAt: credential.credentialUpdatedAt, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
    const protectedBytes = Buffer.from(JSON.stringify(claims)), key = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(protectedBytes);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
    return new Response(JSON.stringify({ protected: protectedBytes.toString("base64url"), encryptedKey: publicEncrypt({ key: identity.publicKey, oaepHash: "sha256" }, key).toString("base64url"), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") }));
  } } });
  const buildMenu = Menu.buildFromTemplate;
  let menu = [];
  Menu.buildFromTemplate = template => { menu = template; return { popup() {} }; };
  async function rightFill(contents, y, label) {
    menu = [];
    let coordinates = {};
    contents.once("context-menu", (_event, params) => { coordinates = { x: params.x, y: params.y, isEditable: params.isEditable, zoom: contents.getZoomFactor() }; });
    contents.sendInputEvent({ type: "mouseDown", x: Math.round(40 * contents.getZoomFactor()), y: Math.round(y * contents.getZoomFactor()), button: "right", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: Math.round(40 * contents.getZoomFactor()), y: Math.round(y * contents.getZoomFactor()), button: "right", clickCount: 1 });
    try { await until(() => menu.some(item => item.label === label), "native input context menu"); }
    catch (error) { throw new Error(`${error.message}: ${JSON.stringify(coordinates)}`); }
    assert.ok(menu.some(item => item.label === "填入用户名")); assert.ok(menu.some(item => item.label === "填入密码"));
    desktopDeviceAuthorizationContext.run(authorization, () => menu.find(item => item.label === label).click());
  }

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
        manualFallback: () => { if (view.login === login) void browseDesktopWebWithoutAutofill(view); },
        changed: () => { if (view.login === login && login.state.phase === "failed") void browseDesktopWebWithoutAutofill(view); },
        completed: async () => { if (path !== "/manual") throw new Error("Fixture must never claim authentication"); await browseDesktopWebWithoutAutofill(view); } });
      const auth = login.window;
      if (path === "/cancel") {
        await until(() => loads === 1, "unfinished auth load");
        const started = Date.now();
        await Promise.all([handleDesktopWebViewAction(view.id, { type: "browse" }), handleDesktopWebViewAction(view.id, { type: "browse" })]);
        assert.ok(Date.now() - started < 5000);
      }
      try { await until(() => !view.login && view.pages.size === 1 && activeDesktopWebPage(view).view.webContents.getTitle() === "Login fixture", "fresh usable page"); }
      catch (error) { console.error("Fixture state", path, view.login?.state, view.pages.size, view.pendingPages); throw error; }
      assert.equal(auth.isDestroyed(), true);
      assert.equal(view.loginNotice, "");
      const contents = activeDesktopWebPage(view).view.webContents;
      if (path === "/manual") {
        assert.equal(login.state.image, "");
        contents.setZoomFactor(1.25);
        await contents.executeJavaScript("document.documentElement.getBoundingClientRect().width");
        await rightFill(contents, 80, "填入用户名");
        await until(() => contents.executeJavaScript("alpha.value === 'fixture-user'"), "native username fill");
        assert.equal(await contents.executeJavaScript("beta.value"), "");
        await rightFill(contents, 140, "填入密码");
        await until(() => contents.executeJavaScript("beta.value === 'fixture-password'"), "native password fill");
        assert.deepEqual(await contents.executeJavaScript("({readonly:beta.readOnly,visibility:getComputedStyle(beta).visibility})"), { readonly: false, visibility: "visible" });
        assert.equal(posts, 0);
        contents.setZoomFactor(1);
        const pageId = view.activePageId, documentTime = await contents.executeJavaScript("performance.timeOrigin");
        await contents.executeJavaScript("alpha.value='';beta.value=''");
        await desktopDeviceAuthorizationContext.run(authorization, () => handleDesktopWebViewAction(view.id, { type: "refill" }));
        await until(() => contents.executeJavaScript("alpha.value === 'fixture-user' && beta.value === 'fixture-password'"), "native active fill");
        assert.equal(view.activePageId, pageId); assert.equal(await contents.executeJavaScript("performance.timeOrigin"), documentTime); assert.equal(posts, 0);
        contents.sendInputEvent({ type: "mouseDown", x: 40, y: 210, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x: 40, y: 210, button: "left", clickCount: 1 });
        await until(() => contents.getTitle() === "Business", "user submitted native login");
        assert.equal(posts, 1);
        view.closing = true; destroyDesktopWebPages(view); desktopWebViews.delete(view.id);
        continue;
      }
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
    console.log("VIRON_PROTECTED_BROWSING_OK: normal fallback page, native input context menus, editable targeted fills, active fill without reload or submit, user login, cancelled loads and normal navigation passed.");
  } finally {
    for (const view of views) { view.closing = true; view.login?.dispose(); destroyDesktopWebPages(view); desktopWebViews.delete(view.id); }
    Menu.buildFromTemplate = buildMenu; setActiveEndpoint(null);
    owner.destroy(); for (const timer of timers) clearTimeout(timer);
    target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
  }
}
run().then(() => { rmSync(directory, { recursive: true, force: true }); app.exit(0); }, error => { console.error(error); rmSync(directory, { recursive: true, force: true }); app.exit(1); });
