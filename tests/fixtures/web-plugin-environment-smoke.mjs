import { app, BrowserWindow, session } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

app.commandLine.appendSwitch("use-mock-keychain");

const profile = process.env.VIRON_PLUGIN_PROFILE;
const origin = process.env.VIRON_PLUGIN_ORIGIN;
const policyBase = process.env.VIRON_PLUGIN_POLICY_BASE;
const cookie = process.env.VIRON_PLUGIN_COOKIE;
const adminCookie = process.env.VIRON_PLUGIN_ADMIN_COOKIE;
const userId = process.env.VIRON_PLUGIN_USER_ID;
const stageFeatureId = process.env.VIRON_PLUGIN_STAGE_FEATURE;
const orgBase = process.env.VIRON_PLUGIN_ORG_BASE;
const dev = JSON.parse(process.env.VIRON_PLUGIN_DEV);
const prod = JSON.parse(process.env.VIRON_PLUGIN_PROD);
const stage = JSON.parse(process.env.VIRON_PLUGIN_STAGE);
const installId = "eb496248-beb8-4b0e-9e92-834a3aa72b08";

async function run() {
  app.setPath("userData", profile);
  await app.whenReady();
  const runtime = await import(pathToFileURL(resolve("dist/desktop/desktop-runtime-context.js")));
  const host = await import(pathToFileURL(resolve("dist/desktop/window-host.js")));
  const endpoint = await import(pathToFileURL(resolve("dist/desktop/endpoint-context.js")));
  const views = await import(pathToFileURL(resolve("dist/desktop/web-view-runtime.js")));
  const extensions = await import(pathToFileURL(resolve("dist/desktop/web-extensions.js")));
  const menus = await import(pathToFileURL(resolve("dist/desktop/web-extension-context-menus.js")));
  const browser = await import(pathToFileURL(resolve("dist/desktop/web-extension-browser.js")));
  const pages = await import(pathToFileURL(resolve("dist/desktop/web-page-policy.js")));
  const idle = { setIdleMinutes() {} };
  runtime.initializeDesktopRuntimeContext({ ssh: idle, sftp: idle, log: idle, database: idle, databaseOperation: idle, redis: idle, connectionInspection: idle });
  menus.registerDesktopWebExtensionContextMenus();
  const scope = pages.desktopWebLastUrlKey(policyBase, userId, dev.credentialId, dev.environmentId);
  const extensionPath = join(profile, "web-extensions", scope, installId);
  await mkdir(extensionPath, { recursive: true });
  await writeFile(join(extensionPath, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Environment fixture", version: "1.0.0",
    permissions: ["contextMenus", "storage"],
    commands: { ping: { suggested_key: { default: "Alt+Shift+Y" }, description: "Ping" } },
    background: { service_worker: "worker.js" }, action: { default_popup: "popup.html" },
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_end" }],
  }));
  await writeFile(join(extensionPath, "worker.js"), `chrome.runtime.onInstalled.addListener(() => { chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: "ping", title: "Ping page", contexts: ["all"] })); });`);
  await writeFile(join(extensionPath, "content.js"), `document.documentElement.dataset.plugin = "on";`);
  await writeFile(join(extensionPath, "popup.html"), "<!doctype html><title>Popup</title>");
  await writeFile(join(profile, "desktop-state.json"), JSON.stringify({ globalWebExtensions: [{ installId, extensionId: "pending", name: "Environment fixture", version: "1.0.0", sourceScope: scope, enabled: true }] }));
  const guests = await import(pathToFileURL(resolve("dist/desktop/browser-guest-host.js")));
  const main = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: resolve("dist/desktop/preload.cjs"), webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  host.setMainWindow(main);
  guests.configureBrowserGuestHost(main.webContents);
  await main.loadFile(resolve("tests/fixtures/web-plugin-guest-host.html"));
  const endpointPartition = session.fromPartition("persist:viron-plugin-endpoint");
  await endpointPartition.cookies.set({ url: policyBase, name: "envman_session", value: cookie.slice("envman_session=".length) });
  endpoint.setActiveEndpoint({
    endpoint: policyBase, protocolVersion: 2, partition: endpointPartition,
    capabilities: {
      product: "viron", productVersion: "test", apiProtocol: { min: 1, max: 2 },
      desktopLocal: { web: true },
      serverForwarding: { enabled: false, web: false, ssh: false, sftp: false, logs: false, database: false },
    },
  });
  const until = async (callback) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await callback()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("plugin environment fixture timed out");
  };
  const open = (target) => views.openDesktopWebView(target.credentialId, { x: 0, y: 0, width: 900, height: 640 }, "entry", false, target.environmentId);
  const devState = await open(dev);
  const prodState = await open(prod);
  const stageState = await open(stage);
  const pageOf = (id) => {
    const view = views.localWebView(id);
    const page = view.pages.get(view.activePageId);
    if (!page) throw new Error("页面不存在");
    return { view, contents: page.view.webContents };
  };
  const marker = (id) => pageOf(id).contents.executeJavaScript("document.documentElement.dataset.plugin || ''");
  await until(async () => (await marker(devState.id)) === "on");
  await until(async () => (await marker(stageState.id)) === "on");
  await until(async () => pageOf(prodState.id).contents.isLoading() === false);
  const devView = pageOf(devState.id).view;
  const prodView = pageOf(prodState.id).view;
  const stageView = pageOf(stageState.id).view;
  assert.notEqual(devView.partition, prodView.partition);
  assert.equal(prodView.allowExtensions, false);
  assert.equal(prodView.partition.extensions.getAllExtensions().length, 0);
  assert.equal(await marker(prodState.id), "");
  assert.equal(devView.partition.extensions.getAllExtensions().length, 1);
  assert.equal(stageView.partition.extensions.getAllExtensions().length, 1);
  const menuParams = { pageURL: dev.url, frameURL: "", linkURL: "", srcURL: "", mediaType: "none", selectionText: "", isEditable: false };
  await until(() => menus.desktopWebExtensionContextMenuItems(devView.partition, pageOf(devState.id).contents, menuParams).length === 1);
  assert.equal(browser.handleExtensionShortcut(pageOf(devState.id).contents, { type: "keyDown", key: "y", code: "KeyY", alt: true, shift: true, meta: false, control: false, isAutoRepeat: false }), true);
  const disabled = await extensions.updateDesktopWebExtension(devView.partition, devView.lastUrlKey, installId, { enabled: false });
  assert.equal(disabled[0].enabled, false);
  await views.handleDesktopWebViewAction(devState.id, { type: "reload" });
  await until(async () => pageOf(devState.id).contents.isLoading() === false && (await marker(devState.id)) === "");
  await views.syncOpenWebPluginPolicies();
  await views.handleDesktopWebViewAction(devState.id, { type: "reload" });
  await until(async () => pageOf(devState.id).contents.isLoading() === false);
  assert.equal(await marker(devState.id), "");
  assert.equal((await extensions.listDesktopWebExtensions(devView.partition, devView.lastUrlKey))[0].enabled, false);
  await extensions.updateDesktopWebExtension(devView.partition, devView.lastUrlKey, installId, { enabled: true });
  await views.syncOpenWebPluginPolicies();
  await views.handleDesktopWebViewAction(devState.id, { type: "reload" });
  await until(async () => (await marker(devState.id)) === "on");
  await views.handleDesktopWebViewAction(devState.id, { type: "navigate", url: `${origin}/dev/next` });
  await until(async () => pageOf(devState.id).contents.getURL().includes("/dev/next") && (await marker(devState.id)) === "on");
  assert.equal(pageOf(devState.id).view.pluginEnvironmentId, dev.environmentId);
  const beforePopup = devView.partition.extensions.getAllExtensions().length;
  await pageOf(devState.id).contents.executeJavaScript(`window.open(${JSON.stringify(prod.url)})`);
  await until(() => BrowserWindow.getAllWindows().some((window) => window.webContents.session !== devView.partition && window.webContents.getURL() === prod.url));
  const prodPopup = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === prod.url);
  assert.notEqual(prodPopup.webContents.session, devView.partition);
  assert.equal(prodPopup.webContents.session.extensions.getAllExtensions().length, 0);
  assert.equal(devView.partition.extensions.getAllExtensions().length, beforePopup);
  assert.equal(await marker(devState.id), "on");
  assert.equal(pageOf(devState.id).view.pluginEnvironmentId, dev.environmentId);
  await pageOf(devState.id).contents.executeJavaScript(`window.open(${JSON.stringify(`${origin}/missing`)})`);
  await until(() => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL() === `${origin}/missing`));
  const unknown = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === `${origin}/missing`);
  assert.notEqual(unknown.webContents.session, devView.partition);
  assert.equal(unknown.webContents.session.extensions.getAllExtensions().length, 0);
  assert.equal(devView.partition.extensions.getAllExtensions().length, beforePopup);
  await pageOf(devState.id).contents.executeJavaScript(`window.open(${JSON.stringify(stage.url)})`);
  await until(() => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL() === stage.url && window.webContents.session !== devView.partition && window.webContents.session.extensions.getAllExtensions().length === 1));
  const stagePopup = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === stage.url && window.webContents.session !== devView.partition);
  assert.equal(await marker(devState.id), "on");
  assert.equal(pageOf(devState.id).view.pluginEnvironmentId, dev.environmentId);
  const removed = await fetch(`${policyBase}${orgBase}/feature-grants/${stageFeatureId}`, { method: "DELETE", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ reason: "停用插件" }) });
  assert.equal(removed.status, 200, await removed.text());
  await views.syncOpenWebPluginPolicies();
  await until(() => stagePopup.webContents.session.extensions.getAllExtensions().length === 0);
  assert.equal(devView.partition.extensions.getAllExtensions().length, beforePopup);
  assert.equal(await marker(devState.id), "on");
  assert.equal(stageView.partition.extensions.getAllExtensions().length, 0);
  assert.equal(browser.handleExtensionShortcut(pageOf(devState.id).contents, { type: "keyDown", key: "y", code: "KeyY", alt: true, shift: true, meta: false, control: false, isAutoRepeat: false }), true);
  process.stdout.write("WEB_PLUGIN_ENVIRONMENT_PASS\n");
}

run().then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
