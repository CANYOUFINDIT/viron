// Native guest verification with invented credentials and an isolated profile.
import { app, BrowserWindow, session } from "electron";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  const { desktopWebViews, reopenDesktopWebViews, activeDesktopWebPage, destroyDesktopWebPages, webViewState } = await import("../dist/desktop/web-view-runtime.js");
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
    credential.loginConfig.mode = "protected";
    credential.loginConfig.submitSelector = "#missing-submit";
    await reopenDesktopWebViews([view], credential);
    await until(() => view.login?.state.kind === "page" && Boolean(view.login.state.image), "switch back to protected fallback");
    assert.equal(custom.isDestroyed(), true);
    assert.equal(view.pages.size, 0);
    assert.equal(view.partition.extensions.getAllExtensions().length, 0);
    assert.equal(await view.login.window.webContents.executeJavaScript("getComputedStyle(beta).visibility"), "hidden");
    assert.equal(JSON.stringify(await owner.webContents.executeJavaScript("states")).includes("fixture-password"), false);
    console.log("Native direct login passed: delayed form, agreement, editable password, active extension, custom selectors, no refill after navigation and switch back to protected login.");
  } finally {
    view.closing = true; destroyDesktopWebPages(view); desktopWebViews.delete(view.id); owner.destroy();
    target.closeAllConnections(); await new Promise((resolveClose) => target.close(() => resolveClose()));
  }
}
run().then(() => { rmSync(directory, { recursive: true, force: true }); app.exit(0); }).catch((error) => { console.error(error); rmSync(directory, { recursive: true, force: true }); app.exit(1); });
