// Hidden Electron fixture: public bundles cross profiles, account state never does.
import { app, BrowserWindow, session } from "electron";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { installDesktopPublicWebAssets, configureDesktopPublicWebAssets } from "../dist/desktop/public-web-assets.js";
import { ProtectedWebLogin } from "../dist/desktop/protected-web-login.js";
import { verifyProtectedBusinessPage } from "../dist/desktop/protected-web-login-business.js";
import { evaluateWebIsolated, loadWebDocument, webDocumentLoading } from "../dist/desktop/web-document.js";
import { DirectWebAutofill } from "../dist/shared/direct-web-autofill.js";
import { defaultWebLoginConfig } from "../dist/shared/protected-web-login.js";

mkdirSync("private/browser-tests", { recursive: true });
const directory = mkdtempSync(join(process.cwd(), "private/browser-tests/electron-assets-"));
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
let scriptRequests = 0, posts = 0;
const scriptCookies = [];
const server = createServer((request, response) => {
  if (request.url === "/slow-image") return;
  if (request.method === "POST") { posts++; response.end("ok"); return; }
  if (request.url === "/assets/app-AbCd1234.js") {
    scriptRequests++; scriptCookies.push(request.headers.cookie ?? "");
    response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600", "Content-Encoding": "gzip" });
    response.end(gzipSync("document.querySelector('main').dataset.loaded='yes';")); return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === "/business-slow") { response.end('<main id="home">Signed in</main><img src="/slow-image">'); return; }
  if (request.url === "/login") {
    response.end(`<!doctype html><title>Login</title><form><input name="username" autocomplete="username"><input name="password" type="password"><button>Login</button></form><img src="/slow-image"><script>
      document.querySelector('form').onsubmit=async event=>{event.preventDefault();await fetch('/authenticate',{method:'POST'});event.target.remove();document.body.insertAdjacentHTML('beforeend','<main id="home">Signed in</main>');location.hash='/home';}
    </script>`); return;
  }
  if (request.url === "/state") { response.end('<body><script>document.body.innerText=localStorage.getItem("account")</script></body>'); return; }
  response.setHeader("Cache-Control", "private, no-store");
  response.end(`<!doctype html><main>${request.headers.cookie ?? "anonymous"}</main><script src="/assets/app-AbCd1234.js"></script>`);
});
async function run() {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const windows = [];
  let login;
  let directFill;
  try {
    const profiles = [];
    for (const account of ["first-account", "second-account"]) {
      console.log(`Checking public assets for ${account}`);
      const partition = session.fromPartition(`persist:asset-fixture-${account}`); profiles.push(partition);
      installDesktopPublicWebAssets(partition, "https://endpoint.example.test", "fixture-user");
      await partition.cookies.set({ url: origin, name: "account", value: account });
      const window = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true } });
      windows.push(window); await configureDesktopPublicWebAssets(window.webContents); await window.loadURL(origin);
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('main').textContent"), `account=${account}`);
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('main').dataset.loaded"), "yes");
      await window.webContents.executeJavaScript(`localStorage.setItem('account', ${JSON.stringify(account)})`);
    }
    assert.equal(scriptRequests, 1); assert.deepEqual(scriptCookies, [""]);
    for (let index = 0; index < windows.length; index++) {
      await windows[index].loadURL(origin + "/state");
      assert.equal(await windows[index].webContents.executeJavaScript("document.body.innerText"), index === 0 ? "first-account" : "second-account");
    }
    const authenticated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Electron login waited for a slow image")), 5000);
      login = new ProtectedWebLogin({ session: profiles[0], url: origin + "/login", username: "fixture-user", password: "fixture-password",
        config: { ...defaultWebLoginConfig(), successSelector: "#home" }, bounds: { x: 0, y: 0, width: 900, height: 650 },
        changed: () => {}, completed: async result => { clearTimeout(timer); resolve(result); },
      });
    });
    assert.equal((await authenticated).authenticated, true); assert.equal(posts, 1);
    const contents = windows[0].webContents;
    const businessStarted = Date.now();
    await loadWebDocument(contents, origin + "/business-slow");
    await verifyProtectedBusinessPage(contents, "#home", () => true);
    assert.ok(Date.now() - businessStarted < 5000);
    await loadWebDocument(contents, origin + "/login");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Direct filling waited for a slow image")), 5000);
      directFill = new DirectWebAutofill({ browser: { destroyed: () => contents.isDestroyed(), loading: () => webDocumentLoading(contents),
        evaluate: source => evaluateWebIsolated(contents, source, "viron-credential-fill") }, entryUrl: origin + "/login",
        config: { ...defaultWebLoginConfig(), mode: "locked" }, username: "fixture-user", password: "fixture-password",
        changed: () => { clearTimeout(timer); resolve(); },
      });
    });
    assert.equal(await evaluateWebIsolated(contents, "document.querySelector('input[type=password]').readOnly", "viron-credential-fill"), true);
    assert.equal(posts, 1);
    console.log("VIRON_PUBLIC_ASSET_CACHE_OK: one bundle download; isolated cookies/localStorage; authentication, business readiness and locked filling ignore slow images");
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    directFill?.dispose(); login?.dispose(); await login?.settled(); for (const window of windows) window.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true }); app.exit(process.exitCode ?? 0);
  }
}
void run().catch(error => { console.error(error); app.exit(1); });
