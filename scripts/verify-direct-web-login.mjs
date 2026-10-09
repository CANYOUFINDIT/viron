// Native guest verification with invented credentials and an isolated profile.
import { app, BrowserWindow, Menu, session } from "electron";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const parent = resolve("private/web-login-mode-tests"); mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, "native-"));
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
const scope = createHash("sha256").update(directory).digest("hex");
const installId = randomUUID();
const extension = join(directory, "web-extensions", scope, installId);
mkdirSync(extension, { recursive: true });
writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Direct fill fixture", version: "1.0.0",
  content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_end" }] }));
writeFileSync(join(extension, "content.js"), 'document.documentElement.dataset.fixtureExtension="active";');
writeFileSync(join(directory, "desktop-state.json"), JSON.stringify({ webExtensions: { [scope]: [{ installId, extensionId: "pending", name: "Direct fill fixture", version: "1.0.0" }] } }));

let posts = 0;
const target = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.method === "POST") {
    let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => {
      const fields = new URLSearchParams(body);
      assert.equal(fields.get("username"), "fixture-user"); assert.equal(fields.get("password"), "fixture-password"); posts++;
      response.writeHead(302, { Location: "/home", "Set-Cookie": "session=fixture-authenticated; Path=/; HttpOnly; SameSite=Lax" }); response.end();
    }); return;
  }
  if (request.url === "/home") { response.end('<title>Business</title><main>Welcome</main>'); return; }
  if (request.url === "/settings") { response.end('<title>Settings</title><input id="alpha"><input id="beta" type="password"><button>Login</button>'); return; }
  if (request.url === "/custom") { response.end('<title>Custom</title><input id="alpha"><input id="beta"><button>Continue</button>'); return; }
  const form = `<form method="post"><input id="alpha" name="username"><input id="beta" name="password" type="password"><label><input id="agree" type="checkbox" required>Accept terms</label><button>Login</button></form>`;
  response.end(`<title>Console</title><style>input,button{margin:12px;height:32px}#terms{position:fixed;inset:30px;background:#eee}</style><main>Starting</main><script>
    setTimeout(()=>{document.body.innerHTML=${JSON.stringify(form)};agree.addEventListener('click',event=>{event.preventDefault();const modal=document.createElement('section');modal.id='terms';modal.innerHTML='<p>Privacy and service terms</p><button id="accept">Accept</button>';document.body.append(modal);accept.onclick=()=>{agree.checked=true;modal.remove()}})},600);
  </script>`);
});
async function until(predicate, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timeout: " + description);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function run() {
  await app.whenReady();
  const { setMainWindow } = await import("../dist/desktop/window-host.js");
  const { configureBrowserGuestHost } = await import("../dist/desktop/browser-guest-host.js");
  const { desktopWebViews, reopenDesktopWebViews, activeDesktopWebPage, destroyDesktopWebPages, webViewState, handleDesktopWebViewAction } = await import("../dist/desktop/web-view-runtime.js");
  const { inspectDesktopWebElement } = await import("../dist/desktop/web-view-support.js");
  const { defaultWebLoginConfig } = await import("../dist/shared/protected-web-login.js");
  const owner = setMainWindow(new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false, sandbox: false } }));
  configureBrowserGuestHost(owner.webContents);
  await owner.loadURL('data:text/html,' + encodeURIComponent(`<script>
    const {ipcRenderer}=require('electron');const guests=new Map();window.states=[];
    ipcRenderer.on('viron:web-view-state',(_,state)=>states.push(state));
    ipcRenderer.on('viron:browser-host',(_,message)=>{
      if(message.type==='create'){const r=message.request;const w=document.createElement('webview');w.style.cssText='width:900px;height:650px';w.setAttribute('partition',r.partition);w.setAttribute('useragent','VironBrowserGuest/'+r.token);w.setAttribute('allowpopups','');w.addEventListener('did-stop-loading',()=>ipcRenderer.invoke('viron:browser-host:attached',r.token,w.getWebContentsId()),{once:true});w.setAttribute('src','about:blank');guests.set(r.token,w);document.body.append(w)}
      if(message.type==='destroy'){guests.get(message.token)?.remove();guests.delete(message.token)}
    });
  </script>`));
  await new Promise((resolveListen) => target.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${target.address().port}`;
  const partitionName = "persist:direct-native-" + randomUUID();
  const view = { id: randomUUID(), registrationId: "fixture", credentialId: randomUUID(), entryId: "fixture", entryUrl: origin + "/", entryOrigin: origin,
    username: "fixture-user", password: "", loginConfig: defaultWebLoginConfig(), login: null, loginAttempt: randomUUID(), loginPreparation: Promise.resolve(), loginNotice: "",
    pages: new Map(), pageGeneration: 0, pendingPages: 0, activePageId: "", bounds: { x: 0, y: 0, width: 900, height: 650 }, visible: true, previewing: false,
    closing: false, lastActivityAt: Date.now(), closedReason: "", partition: session.fromPartition(partitionName), lastUrlKey: scope,
    partitionName, lastUrl: "", notice: null };
  desktopWebViews.set(view.id, view);
  const credential = { credentialId: view.credentialId, entryId: view.entryId, entryUrl: view.entryUrl, username: "fixture-user", password: "fixture-password",
    customFields: {}, credentialUpdatedAt: new Date().toISOString(), loginConfig: { ...defaultWebLoginConfig(), mode: "direct" } };
  const { setActiveEndpoint } = await import("../dist/desktop/endpoint-context.js");
  const { desktopDeviceAuthorizationContext } = await import("../dist/desktop/desktop-runtime-context.js");
  const { createDeviceIdentity } = await import("../dist/desktop/device-identity.js");
  const identity = createDeviceIdentity(), endpoint = "https://endpoint.example.test";
  const auth = { user: { id: "fixture-user-id", username: "fixture-user" }, workspace: { type: "personal", id: "fixture-workspace" } };
  const authorization = { auth, identity, endpoint };
  setActiveEndpoint({ endpoint, protocolVersion: 1, capabilities: {}, partition: { fetch: async (_url, options) => {
    const request = JSON.parse(options.body);
    const claims = { version: 1, algorithm: "RSA-OAEP-256+A256GCM", keyId: identity.keyId, deviceId: identity.deviceId,
      requestId: request.requestId, userId: auth.user.id, workspaceType: auth.workspace.type, workspaceId: auth.workspace.id, credentialId: credential.credentialId,
      endpoint, targetOrigin: origin, credentialUpdatedAt: credential.credentialUpdatedAt, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
    const protectedBytes = Buffer.from(JSON.stringify(claims)), key = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(protectedBytes);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
    return new Response(JSON.stringify({ protected: protectedBytes.toString("base64url"), encryptedKey: publicEncrypt({ key: identity.publicKey, oaepHash: "sha256" }, key).toString("base64url"), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") }));
  } } });
  const buildMenu = Menu.buildFromTemplate;
  let menu = [];
  Menu.buildFromTemplate = template => { menu = template; return { popup() {} }; };
  async function rightFill(contents, selector, label) {
    menu = [];
    const point = await contents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ["mouseDown", "mouseUp"]) contents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: "right", clickCount: 1 });
    await until(() => menu.some(item => item.label === label), "locked native context fill");
    assert.equal(menu.some(item => item.label === "检查元素"), false);
    desktopDeviceAuthorizationContext.run(authorization, () => menu.find(item => item.label === label).click());
  }
  try {
    await reopenDesktopWebViews([view], credential);
    assert.equal(view.login, null); assert.equal(webViewState(view).loginMode, "direct");
    const contents = activeDesktopWebPage(view).view.webContents;
    await until(() => contents.executeJavaScript("document.querySelector('#beta')?.value === 'fixture-password'"), "direct login fill");
    assert.equal(posts, 0); assert.equal(view.password, "");
    assert.deepEqual(await contents.executeJavaScript("({readonly:beta.readOnly,visibility:getComputedStyle(beta).visibility,extension:document.documentElement.dataset.fixtureExtension})"),
      { readonly: false, visibility: "visible", extension: "active" });
    await contents.executeJavaScript("beta.type='text';agree.click()");
    assert.equal(await contents.executeJavaScript("beta.value"), "fixture-password");
    assert.equal(await contents.executeJavaScript("Boolean(document.querySelector('#terms'))"), true);
    await contents.executeJavaScript("accept.click();document.querySelector('form').requestSubmit()");
    await until(() => contents.getTitle() === "Business", "manual login after agreement"); assert.equal(posts, 1);
    await contents.loadURL(origin + "/settings"); await new Promise((resolveWait) => setTimeout(resolveWait, 600));
    assert.equal(await contents.executeJavaScript("beta.value"), "");
    credential.entryUrl = origin + "/custom"; credential.loginConfig.usernameSelector = "#alpha"; credential.loginConfig.passwordSelector = "#beta";
    await reopenDesktopWebViews([view], credential);
    const custom = activeDesktopWebPage(view).view.webContents;
    await until(() => custom.executeJavaScript("document.querySelector('#beta')?.value === 'fixture-password'"), "custom direct selectors");
    assert.equal(await custom.executeJavaScript("alpha.value"), "fixture-user");
    assert.equal(await custom.executeJavaScript("beta.readOnly"), false);

    credential.entryUrl = origin + "/"; credential.loginConfig.mode = "locked";
    await reopenDesktopWebViews([view], credential);
    const locked = activeDesktopWebPage(view).view.webContents;
    await until(() => locked.executeJavaScript("document.querySelector('#beta')?.value === 'fixture-password'"), "locked delayed form");
    assert.equal(custom.isDestroyed(), true); assert.equal(posts, 1);
    assert.equal(view.partition.extensions.getAllExtensions().length, 0);
    assert.equal(view.partition.getPreloadScripts().length, 0);
    inspectDesktopWebElement(locked, 10, 10); locked.openDevTools();
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    assert.equal(locked.isDevToolsOpened(), false);
    assert.equal(await locked.executeJavaScript("typeof globalThis.__vironWebPasswordLocks"), "undefined");
    assert.equal(await locked.executeJavaScript("document.documentElement.dataset.fixtureExtension ?? ''"), "");
    await handleDesktopWebViewAction(view.id, { type: "new-page" });
    const extra = activeDesktopWebPage(view);
    extra.view.webContents.openDevTools(); assert.equal(extra.view.webContents.isDevToolsOpened(), false);
    await handleDesktopWebViewAction(view.id, { type: "close-page", pageId: extra.id });
    await locked.executeJavaScript("void window.open('/settings','fixture-popup')");
    await until(() => [...view.pages.values()].some(page => page.view.kind === "window"), "locked popup");
    const popup = [...view.pages.values()].find(page => page.view.kind === "window");
    popup.view.webContents.openDevTools(); assert.equal(popup.view.webContents.isDevToolsOpened(), false);
    popup.view.dispose();
    await locked.executeJavaScript("beta.type='text';beta.readOnly=false;beta.removeAttribute('style');document.body.insertAdjacentHTML('beforeend','<span id=echo>'+beta.value+'</span>');agree.click()");
    await until(() => locked.executeJavaScript("beta.type==='password' && beta.readOnly && !echo.textContent.includes('fixture-password')"), "page reveal masking");
    assert.equal(await locked.executeJavaScript("Boolean(document.querySelector('#terms'))"), true);
    await locked.executeJavaScript("accept.click();alpha.value='';beta.value=''");
    await desktopDeviceAuthorizationContext.run(authorization, () => handleDesktopWebViewAction(view.id, { type: "refill" }));
    await until(() => locked.executeJavaScript("beta.value === 'fixture-password'"), "explicit locked refill");
    assert.equal(await locked.executeJavaScript("agree.checked && beta.readOnly"), true);
    await locked.executeJavaScript("document.querySelector('form').requestSubmit()");
    await until(() => locked.getTitle() === "Business", "locked manual login after terms"); assert.equal(posts, 2);
    await locked.loadURL(origin + "/settings");
    assert.equal(await locked.executeJavaScript("beta.value"), "");
    await rightFill(locked, "#beta", "填入密码");
    await until(() => locked.executeJavaScript("beta.value === 'fixture-password' && beta.readOnly"), "locked native manual password");
    assert.equal(await locked.executeJavaScript("alpha.value"), "");
    await rightFill(locked, "#alpha", "填入用户名");
    await until(() => locked.executeJavaScript("alpha.value === 'fixture-user'"), "locked native manual username");
    assert.equal(await locked.executeJavaScript("alpha.readOnly"), false);

    credential.entryUrl = origin + "/custom"; credential.loginConfig.mode = "direct";
    await reopenDesktopWebViews([view], credential);
    const restored = activeDesktopWebPage(view).view.webContents;
    await until(() => restored.executeJavaScript("beta?.value === 'fixture-password' && document.documentElement.dataset.fixtureExtension === 'active'"), "direct policy restores extension");
    assert.equal(locked.isDestroyed(), true); assert.equal(await restored.executeJavaScript("beta.readOnly"), false);
    restored.openDevTools(); await until(() => restored.isDevToolsOpened(), "direct policy restores developer tools"); restored.closeDevTools();
    credential.loginConfig.mode = "protected";
    credential.loginConfig.submitSelector = "#missing-submit";
    await reopenDesktopWebViews([view], credential);
    await until(() => !view.login && view.pages.size === 1 && activeDesktopWebPage(view).view.webContents.getTitle() === "Custom", "switch back to normal manual page", 40_000);
    assert.equal(custom.isDestroyed(), true);
    assert.equal(view.pages.size, 1);
    assert.equal(view.partition.extensions.getAllExtensions().length, 1);
    const manual = activeDesktopWebPage(view).view.webContents;
    await until(() => manual.executeJavaScript("Boolean(document.querySelector('#beta'))"), "normal manual fields");
    assert.equal(await manual.executeJavaScript("beta.value"), "");
    assert.equal(await manual.executeJavaScript("beta.readOnly"), false);
    assert.equal(view.loginNotice, "");
    assert.equal(JSON.stringify(await owner.webContents.executeJavaScript("states")).includes("fixture-password"), false);
    console.log("Native fill policies passed: delayed form, terms dialog, manual submission, locked password, disabled extensions and DevTools, native context fill, explicit refill, no fill after navigation and policy transitions.");
  } finally {
    Menu.buildFromTemplate = buildMenu; setActiveEndpoint(null);
    view.closing = true; destroyDesktopWebPages(view); desktopWebViews.delete(view.id); owner.destroy();
    target.closeAllConnections(); await new Promise((resolveClose) => target.close(() => resolveClose()));
  }
}
run().then(() => { rmSync(directory, { recursive: true, force: true }); app.exit(0); }).catch((error) => { console.error(error); rmSync(directory, { recursive: true, force: true }); app.exit(1); });
