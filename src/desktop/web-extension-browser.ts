import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, ipcMain, WebContentsView, type Session, type WebContents } from "electron";

import { connectGrantedPort, executeGrantedScript, postGrantedPort, registerExtensionContentBridge } from "./web-extension-scripting.js";

interface TabHost {
  windowId: number;
  bounds?: () => { width: number; height: number };
  select: () => void;
  remove: () => void | Promise<void>;
}
interface BrowserHost {
  create: (url: string, active: boolean) => WebContents | Promise<WebContents>;
}
const browsers = new WeakMap<Session, BrowserHost>();
const tabs = new WeakMap<Session, Map<number, { contents: WebContents; host: TabHost }>>();
const activeTabs = new WeakMap<Session, number>();
const grantedTabs = new WeakMap<Session, Map<string, Set<number>>>();
const windows = new WeakMap<Session, Map<number, BrowserWindow>>();
const registered = new WeakSet<Session>();
const workers = new WeakSet<Electron.ServiceWorkerMain>();
let listening = false;

export function registerExtensionBrowser(partition: Session, host: BrowserHost): void {
  browsers.set(partition, host);
}

export function closeExtensionBrowser(partition: Session): void {
  browsers.delete(partition);
  activeTabs.delete(partition);
  grantedTabs.delete(partition);
  for (const window of windows.get(partition)?.values() ?? []) if (!window.isDestroyed()) window.close();
  windows.delete(partition);
}

export function registerExtensionTab(contents: WebContents, host: TabHost): void {
  const partition = contents.session;
  let entries = tabs.get(partition);
  if (!entries) { entries = new Map(); tabs.set(partition, entries); }
  entries.set(contents.id, { contents, host });
  contents.once("destroyed", () => {
    entries!.delete(contents.id);
    for (const granted of grantedTabs.get(partition)?.values() ?? []) granted.delete(contents.id);
  });
  contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) for (const granted of grantedTabs.get(partition)?.values() ?? []) granted.delete(contents.id);
  });
}

export function selectExtensionTab(contents: WebContents): void {
  activeTabs.set(contents.session, contents.id);
}

export function grantExtensionActiveTab(partition: Session, extensionId: string, tabId: number): void {
  if (!tabs.get(partition)?.has(tabId)) return;
  let grants = grantedTabs.get(partition);
  if (!grants) { grants = new Map(); grantedTabs.set(partition, grants); }
  let ids = grants.get(extensionId);
  if (!ids) { ids = new Set(); grants.set(extensionId, ids); }
  ids.add(tabId);
  activeTabs.set(partition, tabId);
}

function tabDetails(partition: Session, id: number) {
  const tab = tabs.get(partition)?.get(id);
  if (!tab || tab.contents.isDestroyed()) throw new Error(`No tab with id: ${id}`);
  return {
    id, windowId: tab.host.windowId, index: [...tabs.get(partition)!.keys()].indexOf(id),
    active: activeTabs.get(partition) === id, highlighted: activeTabs.get(partition) === id,
    url: tab.contents.getURL(), title: tab.contents.getTitle(), incognito: false,
    status: tab.contents.isLoading() ? "loading" : "complete", pinned: false,
    width: (tab.host.bounds?.() ?? BrowserWindow.fromId(tab.host.windowId)?.getContentBounds())?.width ?? 0,
    height: (tab.host.bounds?.() ?? BrowserWindow.fromId(tab.host.windowId)?.getContentBounds())?.height ?? 0,
  };
}

// Dispatch from an extension frame so Chromium wakes its service worker and
// routes the event inside this session, including after worker suspension.
export async function sendExtensionEvent(partition: Session, extensionId: string, message: unknown): Promise<unknown> {
  const extension = partition.extensions.getExtension(extensionId);
  if (!extension) return;
  const filename = "__viron_context_menu_bridge__.html";
  await writeFile(join(extension.path, filename), "<!doctype html><title>Extension event</title>", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const bridge = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await bridge.webContents.loadURL(`chrome-extension://${extensionId}/${filename}`);
    return await bridge.webContents.executeJavaScript(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  } finally { if (!bridge.webContents.isDestroyed()) bridge.webContents.close(); }
}

function allowedUrl(extensionId: string, value: unknown): string {
  const url = new URL(typeof value === "string" && value ? value : "about:blank", `chrome-extension://${extensionId}/`);
  if (["http:", "https:"].includes(url.protocol) || url.href === "about:blank" || url.origin === `chrome-extension://${extensionId}` || url.href.startsWith(`chrome-extension://${extensionId}/`)) return url.href;
  throw new Error("Unsupported extension tab URL");
}

function currentTab(partition: Session) {
  return tabs.get(partition)?.get(activeTabs.get(partition) ?? -1);
}

async function browserOperation(partition: Session, origin: string, operation: string, args: unknown[], senderId?: number, send?: (event: unknown) => void): Promise<unknown> {
  const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(origin)?.[1];
  const extension = id ? partition.extensions.getExtension(id) : undefined;
  if (!id || !extension) throw new Error("Invalid extension origin");
  const entries = tabs.get(partition) ?? new Map();
  const input = (args[0] && typeof args[0] === "object" ? args[0] : {}) as Record<string, any>;
  if (operation === "scripting.executeScript" || operation === "tabs.connect") {
    const tabId = operation === "scripting.executeScript" ? input.target?.tabId : args[0];
    const tab = entries.get(Number(tabId));
    if (!tab || !/^https?:/.test(tab.contents.getURL())) throw new Error("Tab is not accessible in this environment");
    if (!extension.manifest.permissions?.includes("activeTab") || !grantedTabs.get(partition)?.get(id)?.has(tab.contents.id)) throw new Error("A user gesture granting activeTab is required");
    if (operation === "scripting.executeScript") {
      if (!extension.manifest.permissions?.includes("scripting")) throw new Error("The scripting permission is required");
      return executeGrantedScript(tab.contents, id, input, () => Boolean(partition.extensions.getExtension(id) && grantedTabs.get(partition)?.get(id)?.has(tab.contents.id)));
    }
    if (!send) throw new Error("Extension port sender is unavailable");
    return connectGrantedPort(partition, id, tab.contents, (args[1] ?? {}) as Record<string, unknown>, send);
  }
  if (operation === "port.post" || operation === "port.disconnect") {
    postGrantedPort(partition, id, String(args[0]), args[1], operation === "port.disconnect");
    return;
  }
  if (operation === "tabs.query") {
    return [...entries.keys()].map((tabId) => tabDetails(partition, tabId)).filter((tab) => {
      if (input.active !== undefined && tab.active !== input.active) return false;
      if (typeof input.windowId === "number" && input.windowId >= 0 && tab.windowId !== input.windowId) return false;
      if (input.status && tab.status !== input.status) return false;
      if (input.pinned === true) return false;
      if (input.url) {
        const patterns = Array.isArray(input.url) ? input.url : [input.url];
        if (!patterns.some((pattern: string) => new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*")}$`).test(tab.url))) return false;
      }
      return true;
    });
  }
  if (operation === "tabs.get") return tabDetails(partition, Number(args[0]));
  if (operation === "tabs.getCurrent") return senderId && entries.has(senderId) ? tabDetails(partition, senderId) : undefined;
  if (operation === "tabs.create") {
    const browser = browsers.get(partition);
    if (!browser) throw new Error("No browser is open in this environment");
    const tab = await browser.create(allowedUrl(id, input.url), input.active !== false);
    return tabDetails(partition, tab.id);
  }
  if (operation === "tabs.update") {
    const target = typeof args[0] === "number" ? args[0] : activeTabs.get(partition);
    const properties = (typeof args[0] === "number" ? args[1] : args[0]) as Record<string, unknown>;
    const tab = entries.get(target ?? -1);
    if (!tab) throw new Error("Tab is not in this environment");
    if (properties.active) { tab.host.select(); selectExtensionTab(tab.contents); }
    if (properties.url !== undefined) void tab.contents.loadURL(allowedUrl(id, properties.url)).catch(() => undefined);
    if (typeof properties.muted === "boolean") tab.contents.setAudioMuted(properties.muted);
    return tabDetails(partition, tab.contents.id);
  }
  if (operation === "tabs.remove") {
    const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
    for (const tabId of ids) {
      const tab = entries.get(Number(tabId));
      if (!tab) throw new Error("Tab is not in this environment");
      await tab.host.remove();
    }
    return;
  }
  if (operation === "tabs.captureVisibleTab") {
    const windowId = typeof args[0] === "number" ? args[0] : undefined;
    const options = (typeof args[0] === "number" || args[0] == null ? args[1] : args[0]) as { format?: string; quality?: number } | undefined;
    const tab = currentTab(partition);
    if (!tab || (windowId !== undefined && windowId >= 0 && windowId !== tab.host.windowId)) throw new Error("No active tab in this window");
    const permissions = extension.manifest.permissions ?? [];
    const hosts = extension.manifest.host_permissions ?? permissions;
    if (!hosts.includes("<all_urls>") && !(permissions.includes("activeTab") && grantedTabs.get(partition)?.get(id)?.has(tab.contents.id))) throw new Error("captureVisibleTab requires <all_urls> or an activeTab user gesture");
    const captured = await tab.contents.capturePage();
    if (options?.format === "png") return captured.toDataURL();
    return `data:image/jpeg;base64,${captured.toJPEG(Math.min(100, Math.max(0, options?.quality ?? 92))).toString("base64")}`;
  }
  if (operation.startsWith("windows.")) {
    if (operation === "windows.create") {
      const urls = Array.isArray(input.url) ? input.url : [input.url];
      const url = allowedUrl(id, urls[0]);
      let owned = windows.get(partition);
      if (!owned) { owned = new Map(); windows.set(partition, owned); }
      if (owned.size >= 10) throw new Error("Too many extension windows");
      const window = new BrowserWindow({ width: Math.min(1920, Math.max(100, Number(input.width) || 900)), height: Math.min(1440, Math.max(100, Number(input.height) || 700)), show: input.focused !== false,
        webPreferences: { session: partition, sandbox: true, nodeIntegration: false, contextIsolation: true } });
      owned.set(window.id, window);
      window.once("closed", () => owned!.delete(window.id));
      window.webContents.setWindowOpenHandler(({ url: target }) => {
        try { browsers.get(partition)?.create(allowedUrl(id, target), true); } catch { /* Unsupported URL. */ }
        return { action: "deny" };
      });
      registerExtensionTab(window.webContents, { windowId: window.id, select: () => window.focus(), remove: () => window.close() });
      // Extension UI windows do not change which web page a toolbar action targets.
      void window.loadURL(url).catch(() => undefined);
      return { id: window.id, focused: window.isFocused(), type: input.type ?? "normal", ...window.getBounds(), tabs: [tabDetails(partition, window.webContents.id)] };
    }
    const windowId = typeof args[0] === "number" && args[0] >= 0 ? args[0] : currentTab(partition)?.host.windowId;
    const owned = windows.get(partition)?.get(windowId ?? -1);
    if (operation === "windows.remove") { if (!owned) throw new Error("Window is not owned by an extension"); owned.close(); return; }
    if (operation === "windows.update") {
      if (!owned) throw new Error("Window is not owned by an extension");
      const properties = args[1] as Record<string, unknown>;
      if (properties.focused === true) owned.focus();
      return { id: owned.id, focused: owned.isFocused(), type: "normal", ...owned.getBounds() };
    }
    const ids = [...new Set([...entries.values()].map((tab) => tab.host.windowId))];
    const details = ids.map((windowId) => ({ id: windowId, focused: currentTab(partition)?.host.windowId === windowId, type: "normal", incognito: false, tabs: [...entries.keys()].map((id) => tabDetails(partition, id)).filter((tab) => tab.windowId === windowId) }));
    if (operation === "windows.getAll") return details;
    const result = details.find((window) => window.id === windowId);
    if (!result) throw new Error("No window in this environment");
    return result;
  }
  throw new Error(`Unsupported extension operation: ${operation}`);
}

export function registerExtensionBrowserIpc(): void {
  if (listening) return;
  listening = true;
  ipcMain.handle("viron:extension-browser", async (event, operation: string, args: unknown[]) => {
    try { return { result: await browserOperation(event.sender.session, event.senderFrame?.url ?? "", operation, args, event.sender.id, (value) => { if (!event.senderFrame?.isDestroyed()) event.senderFrame?.send("viron:extension-port", value); }) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  });
}

export function registerExtensionBrowserWorkers(partition: Session): void {
  registerExtensionBrowserIpc();
  registerExtensionContentBridge(partition, sendExtensionEvent);
  if (registered.has(partition)) return;
  registered.add(partition);
  partition.extensions.on("extension-unloaded", (_event, extension) => grantedTabs.get(partition)?.delete(extension.id));
  const bind = (versionId: number) => {
    const worker = partition.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || workers.has(worker)) return;
    workers.add(worker);
    worker.ipc.handle("viron:extension-browser", async (event, operation: string, args: unknown[]) => {
      try { return { result: await browserOperation(event.session, event.serviceWorker.scope, operation, args, undefined, (value) => { if (!event.serviceWorker.isDestroyed()) event.serviceWorker.send("viron:extension-port", value); }) }; }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    });
  };
  partition.serviceWorkers.on("running-status-changed", (event) => {
    if (event.runningStatus === "starting" || event.runningStatus === "running") bind(event.versionId);
  });
  for (const id of Object.keys(partition.serviceWorkers.getAllRunning())) bind(Number(id));
}

export function handleExtensionShortcut(contents: WebContents, input: Electron.Input): boolean {
  if (input.type !== "keyDown" || input.isAutoRepeat) return false;
  for (const extension of contents.session.extensions.getAllExtensions()) {
    for (const [name, command] of Object.entries(extension.manifest.commands ?? {}) as Array<[string, { suggested_key?: Record<string, string> }]>) {
      if (name.startsWith("_execute_")) continue;
      const key = command.suggested_key?.[process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux"] ?? command.suggested_key?.default;
      if (!key) continue;
      const parts = key.toLowerCase().split("+");
      const control = parts.includes("macctrl") || (process.platform !== "darwin" && parts.includes("ctrl"));
      const meta = parts.includes("command") || (process.platform === "darwin" && parts.includes("ctrl"));
      if (input.key.toLowerCase() !== parts.at(-1) || input.control !== control || input.meta !== meta || input.alt !== parts.includes("alt") || input.shift !== parts.includes("shift")) continue;
      grantExtensionActiveTab(contents.session, extension.id, contents.id);
      void sendExtensionEvent(contents.session, extension.id, { __vironCommand: name, extensionId: extension.id, tab: tabDetails(contents.session, contents.id) }).catch(() => undefined);
      return true;
    }
  }
  return false;
}
