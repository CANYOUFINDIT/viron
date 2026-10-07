// Run after build:desktop: node_modules/.bin/electron scripts/verify-protected-web-login.mjs
// Pass --loopback to also check the secure-context loopback case.
// Fixtures contain invented credentials; all windows remain hidden.
import { app, BrowserWindow, session } from "electron";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProtectedWebLogin } from "../dist/desktop/protected-web-login.js";
import { verifyProtectedBusinessPage } from "../dist/desktop/protected-web-login-business.js";
import { defaultWebLoginConfig } from "../dist/shared/protected-web-login.js";

process.on("unhandledRejection", (error) => { console.error(error); app.exit(1); });
process.on("uncaughtException", (error) => { console.error(error); app.exit(1); });
app.on("window-all-closed", () => {});
const fixtureHost = process.argv.includes("--loopback") ? "127.0.0.1" : "login.example.test";
app.commandLine.appendSwitch("host-resolver-rules", "MAP login.example.test 127.0.0.1");
app.commandLine.appendSwitch("proxy-server", "direct://");
const windows = [];
const logins = [];
let posts = 0;
let oneUsePages = 0;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      const values = new URLSearchParams(body);
      posts++;
      if (request.url === "/denied") { response.writeHead(302, { Location: "/denied-login" }); response.end(); return; }
      if (request.url === "/transient") { response.writeHead(302, { Location: "/transient-home" }); response.end(); return; }
      if (request.url === "/one-use") { response.writeHead(302, { Location: "/one-use-home" }); response.end(); return; }
      assert.equal(values.get("password"), "fixture-secret");
      if (request.url === "/verify" && values.get("otp") !== "654321") { response.end("<title>Denied</title><input type=password>"); return; }
      response.writeHead(302, { Location: "/home", "Set-Cookie": "fixtureSession=authenticated; Path=/; HttpOnly; SameSite=Lax" });
      response.end();
    });
    return;
  }
  if (request.url === "/redirect") { response.writeHead(302, { Location: "http://127.0.0.1:9/unauthorized" }); response.end(); return; }
  if (request.url === "/home") { response.end("<title>Business</title><main id=success>Signed in</main>"); return; }
  if (request.url === "/transient-home") { response.end('<title>Business</title><script>setTimeout(() => location.replace("/denied-login"), 1200)</script>'); return; }
  if (request.url === "/one-use-home" && ++oneUsePages === 1) { response.end('<title>Business</title><main id=success>Signed in once</main>'); return; }
  const challenge = request.url === "/verify" || request.url === "/unsafe";
  const form = `<form method=post action="${challenge ? "/verify" : request.url === "/transient" ? "/transient" : request.url === "/one-use" ? "/one-use" : request.url?.startsWith("/denied") ? "/denied" : "/plain"}"><input id=username name=username autocomplete=username><input id=password name=password type=password autocomplete=current-password>${challenge ? '<div id=challenge><label>Code<input id=otp name=otp autocomplete=one-time-code></label></div>' : ''}${request.url === "/agreement" ? '<label id=agreement><input id=agree type=checkbox required> I agree to the terms</label>' : ''}<button id=login type=submit>Login</button></form>`;
  response.end(`<!doctype html><title>Login</title><style>input,button { display:block;margin:12px;width:180px;height:30px } #challenge { margin:20px;width:260px;height:100px;background:#ddd;padding:8px } #agreement { display:block;margin:20px;width:260px;height:80px; }</style>${request.url === "/delayed" ? `<script>setTimeout(() => {document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(form)})}, 4200)</script>` : form}<script>sessionStorage.setItem('fixture-tab', 'kept');localStorage.setItem('fixture-local', 'kept');</script>`);
});
function waitUntil(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try { if (predicate()) return resolve(); } catch (error) { return reject(error); }
      if (Date.now() > deadline) return reject(new Error(`Timeout: ${description}`));
      setTimeout(poll, 40);
    };
    poll();
  });
}
async function run() {
await app.whenReady();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://${fixtureHost}:${server.address().port}`;
try {
  const contextProbe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, session: session.fromPartition(`verify-context-${randomUUID()}`) } });
  windows.push(contextProbe);
  await contextProbe.loadURL(origin + "/plain");
  const capabilities = await contextProbe.webContents.executeJavaScript("({ secure: isSecureContext, uuidAvailable: typeof crypto.randomUUID === 'function' })");
  assert.equal(capabilities.secure, fixtureHost === "127.0.0.1");
  assert.equal(capabilities.uuidAvailable, fixtureHost === "127.0.0.1");
  console.log(`Fixture context: ${fixtureHost === "127.0.0.1" ? "loopback" : "ordinary HTTP"}, browser UUID ${capabilities.uuidAvailable ? "available" : "unavailable"}`);
  contextProbe.destroy();
  for (const path of ["/plain", "/verify", "/unsafe", "/denied", "/redirect", "/script", "/bad-selector", "/delayed", "/transient", "/agreement", "/one-use"]) {
    console.log(`Checking ${path}`);
    const partition = session.fromPartition(`verify-protected-${randomUUID()}`);
    let completed;
    const snapshots = [];
    const login = new ProtectedWebLogin({ session: partition, url: origin + path, username: "fixture-user", password: "fixture-secret",
      config: { ...defaultWebLoginConfig(), usernameSelector: path === "/bad-selector" ? "input:fixture-secret()" : "", successSelector: ["/delayed", "/transient", "/agreement"].includes(path) ? "" : "#success", interactionSelector: path === "/unsafe" ? "form" : path === "/verify" ? "#challenge" : "",
        steps: path === "/script" ? [{ action: "type", selector: "#username", value: "{USERNAME}" }, { action: "type", selector: "#password", value: "{SECRET}" }, { action: "click", selector: "#login" }, { action: "success", selector: "#success" }] : [] },
      bounds: { x: 0, y: 0, width: 900, height: 650 }, changed: () => snapshots.push(JSON.stringify(login.state)), completed: async (result) => { completed = result; },
    });
    logins.push(login);
    if (["/unsafe", "/denied", "/redirect", "/bad-selector", "/transient"].includes(path)) {
      await waitUntil(() => login.state.phase === "failed", "unsafe challenge blocked");
      if (path === "/unsafe") assert.match(login.state.message, /验证区域包含或覆盖/);
      if (path === "/bad-selector") assert.match(login.state.message, /无法执行登录表单/);
      assert.ok(snapshots.every((snapshot) => !snapshot.includes("fixture-secret")));
      assert.equal(login.state.image, "");
      assert.equal(login.window.isDestroyed(), true);
      assert.equal(completed, undefined);
      continue;
    }
    if (path === "/delayed") {
      await new Promise(resolve => setTimeout(resolve, 3500));
      assert.equal(completed, undefined, "A delayed login form must not be accepted as an anonymous page");
    }
    if (path === "/agreement") {
      const before = posts;
      await waitUntil(() => login.state.phase === "interactive", "agreement crop");
      assert.equal(posts, before, "The user must confirm the agreement before submission");
      const coordinates = await login.window.webContents.executeJavaScript(`(() => {const a=document.querySelector('#agreement').getBoundingClientRect();const b=document.querySelector('#agree').getBoundingClientRect();return {x:b.x-a.x+20,y:b.y-a.y+12}})()`);
      await login.input({ type: "mouseDown", ...coordinates, revision: login.state.revision });
      await login.input({ type: "mouseUp", ...coordinates, revision: login.state.revision });
      if (login.state.phase === "interactive") await login.input({ type: "continue", revision: login.state.revision });
    }
    if (path === "/verify") {
      await waitUntil(() => login.state.phase === "interactive", "verification crop");
      assert.equal(login.window.isVisible(), false);
      assert.ok(login.state.width < 400);
      assert.ok(login.state.image.startsWith("data:image/png;base64,"));
      // Find only the crop input coordinates, then use the public constrained input path.
      const coordinates = await login.window.webContents.executeJavaScript(`(() => {const a=document.querySelector('#challenge').getBoundingClientRect();const b=document.querySelector('#otp').getBoundingClientRect();return {x:b.x-a.x+20,y:b.y-a.y+12}})()`);
      await login.input({ type: "mouseDown", ...coordinates, revision: login.state.revision });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await login.input({ type: "mouseUp", ...coordinates, revision: login.state.revision });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await login.input({ type: "text", text: "654321", revision: login.state.revision });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await assert.rejects(login.input({ type: "key", key: "Tab", revision: login.state.revision }));
      await login.input({ type: "continue", revision: login.state.revision });
    }
    await waitUntil(() => completed || login.state.phase === "failed", "successful login");
    assert.ok(completed, login.state.message);
    assert.equal(login.window.isDestroyed(), true);
    assert.equal(completed.sessionStorage["fixture-tab"], "kept");
    assert.ok(snapshots.every((snapshot) => !snapshot.includes("fixture-secret")));
    const business = new BrowserWindow({ show: false, webPreferences: { session: partition, contextIsolation: true, sandbox: true } });
    windows.push(business);
    await business.loadURL(completed.url);
    if (path === "/one-use") {
      await assert.rejects(verifyProtectedBusinessPage(business.webContents, "#success", () => true), /business-login/);
      assert.equal(business.webContents.getTitle(), "Login");
      business.destroy();
      continue;
    }
    await verifyProtectedBusinessPage(business.webContents, "#success", () => true);
    assert.equal(business.webContents.getTitle(), "Business");
    assert.equal(await business.webContents.executeJavaScript("localStorage.getItem('fixture-local')"), "kept");
    assert.equal((await partition.cookies.get({ name: "fixtureSession" })).length, 1);
    assert.equal(await business.webContents.executeJavaScript("document.querySelector('input[type=password]')?.value || ''"), "");
    business.destroy();
  }
  // An interrupted challenge must never leave a password in a retained profile.
  const cancelledPartition = session.fromPartition(`verify-cancelled-${randomUUID()}`);
  const cancelled = new ProtectedWebLogin({ session: cancelledPartition, url: origin + "/verify", username: "fixture-user", password: "fixture-secret",
    config: { ...defaultWebLoginConfig(), interactionSelector: "#challenge", successSelector: "#success" },
    bounds: { x: 0, y: 0, width: 900, height: 650 }, changed: () => {}, completed: async () => { assert.fail("Cancelled login must not complete"); },
  });
  logins.push(cancelled);
  await waitUntil(() => cancelled.state.phase === "interactive", "cancelled challenge");
  await cancelled.window.webContents.executeJavaScript('localStorage.setItem("unsafe-fixture", "fixture-secret")');
  cancelled.dispose();
  await cancelled.settled();
  const audit = new BrowserWindow({ show: false, webPreferences: { session: cancelledPartition, contextIsolation: true, sandbox: true } });
  windows.push(audit);
  await audit.loadURL(origin + "/home");
  assert.equal(await audit.webContents.executeJavaScript('localStorage.getItem("unsafe-fixture")'), null);
  audit.destroy();
  assert.equal(posts, 8);
  console.log("Protected login passed: hidden credentials, CAPTCHA and agreement input, retained session, delayed SPA rendering, transient redirects, handoff returning to login, unsafe crop, rejected login and unauthorized origin blocked.");
} catch (error) {
  console.error(error);
  app.exit(1);
} finally {
  for (const login of logins) login.dispose();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  server.close();
  app.quit();
}

}
void run();
