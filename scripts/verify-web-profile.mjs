// Used by the opt-in desktop integration test to verify a real process restart.
import { app, BrowserWindow, session } from "electron";
import assert from "node:assert/strict";
import { desktopWebPartitionName, desktopWebLastUrlKey } from "../dist/desktop/web-page-policy.js";

process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
process.on("uncaughtException", error => { console.error(error); app.exit(1); });

async function run() {
app.setPath("userData", process.env.VIRON_FIXTURE_PROFILE);
app.on("window-all-closed", () => {});
await app.whenReady();
console.log("Profile fixture: ready");
const { enableDesktopWebSessionExtensions } = await import("../dist/desktop/web-view-support.js");
const { loadDesktopWebExtensions, suspendDesktopWebSessionExtensions, resumeDesktopWebSessionExtensions } = await import("../dist/desktop/web-extensions.js");
const scope = desktopWebLastUrlKey("https://endpoint.example.test", "fixture-user", "fixture-account");
const partition = session.fromPartition(desktopWebPartitionName("https://endpoint.example.test", "fixture-user", "fixture-account"));
enableDesktopWebSessionExtensions(partition, scope);
await loadDesktopWebExtensions(partition, scope);
console.log("Profile fixture: extensions loaded");
// The same suspend/resume cycle used by authentication must not reset installation.
await suspendDesktopWebSessionExtensions(partition);
console.log("Profile fixture: suspended");
assert.equal(partition.extensions.getAllExtensions().length, 0);
assert.equal(partition.getPreloadScripts().length, 0);
await resumeDesktopWebSessionExtensions(partition);
await loadDesktopWebExtensions(partition, scope);
console.log("Profile fixture: resumed");
const window = new BrowserWindow({ show: false, webPreferences: { session: partition, contextIsolation: true, sandbox: true } });
try {
  await window.loadURL(process.env.VIRON_FIXTURE_URL);
  if (process.argv.includes("--write")) {
    await window.webContents.executeJavaScript('localStorage.setItem("profile-marker", "retained")');
    await partition.cookies.set({ url: process.env.VIRON_FIXTURE_URL, name: "profile-cookie", value: "retained", expirationDate: Date.now() / 1000 + 3600 });
  }
  assert.equal(await window.webContents.executeJavaScript('localStorage.getItem("profile-marker")'), "retained");
  assert.equal((await partition.cookies.get({ name: "profile-cookie" }))[0]?.value, "retained");
  let count = 0;
  for (let attempt = 0; attempt < 100 && count !== 1; attempt++) {
    count = await window.webContents.executeJavaScript('Number(document.documentElement.dataset.installCount || 0)');
    if (count !== 1) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(count, 1, "Extension installation must occur only once across suspends and process restarts");
  window.destroy();
  partition.flushStorageData();
  await partition.cookies.flushStore();
  console.log("VIRON_PROFILE_RESTART_OK");
  app.quit();
} catch (error) {
  console.error(error);
  app.exit(1);
}
}
void run();
