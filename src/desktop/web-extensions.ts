import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, nativeImage, screen, type Session } from "electron";
import { installChromeWebStore } from "electron-chrome-web-store";
import { readState, writeState, type InstalledWebExtension } from "./app-state.js";
import { installedWebExtensions as installedExtensions, saveInstalledWebExtensions as saveInstalledExtensions, webExtensionPath, webExtensionRoot, WEB_EXTENSION_INSTALL_ID as UUID_PATTERN, WEB_EXTENSION_SCOPE as SCOPE_PATTERN } from "./web-extension-catalog.js";
import { translate as tr } from "./i18n.js";
import { findChromeExtensions, type ChromeExtensionOnDisk } from "./chrome-extension-scan.js";
import { extractWebExtensionArchive } from "./web-extension-archive.js";
import { mainWindow } from "./window-host.js";
import { registerNativeOverlayWindow } from "./overlays/native-window-stack.js";
import type { ManagedDesktopWebView } from "./web-view-runtime.js";
import { grantExtensionActiveTab } from "./web-extension-browser.js";
import { clearDesktopWebExtensionContextMenus, restoreDesktopWebExtensionContextMenus } from "./web-extension-context-menus.js";

export interface DesktopWebExtensionInfo extends InstalledWebExtension {
  loaded: boolean;
  error: string;
  pinned: boolean;
  enabled: boolean;
  iconDataUrl: string;
  hasPopup: boolean;
}

export interface DesktopChromeExtensionInfo {
  token: string;
  chromeId: string;
  name: string;
  version: string;
  profile: string;
}

const failedLoads = new Map<string, string>();
const extensionSessions = new Map<Session, string>();
let extensionOperations: Promise<unknown> = Promise.resolve();

// Serialize loads and mutations so a late load cannot resurrect a removed extension.
function extensionOperation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = extensionOperations.then(operation);
  extensionOperations = pending.catch(() => undefined);
  return pending;
}

function trackExtensionSession(partition: Session, scopeKey: string): void {
  if (!SCOPE_PATTERN.test(scopeKey)) throw new Error(tr("本机扩展所属账号无效"));
  extensionSessions.set(partition, scopeKey);
}

function notifyExtensionsChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:web-extension:changed", { type: "refresh" });
}
const scannedChromeExtensions = new Map<string, { extension: ChromeExtensionOnDisk; expiresAt: number }>();
const extensionPopups = new Map<string, BrowserWindow>();
const popupActiveTabs = new Map<string, { partition: Session; extensionId: string; tabId: number }>();
const storeSessions = new WeakSet<Session>();
const storeViews = new WeakMap<Session, ManagedDesktopWebView>();
const MAX_EXTENSION_BYTES = 100 * 1024 * 1024;
const CONTENT_STORAGE_COMPAT = "__viron_storage_sync_compat__.js";
const CONTENT_STORAGE_COMPAT_SOURCE = `try {
  const storage = globalThis.chrome?.storage;
  if (storage?.local) Object.defineProperty(storage, "sync", { configurable: true, value: storage.local });
} catch { /* Keep the extension's own content script running. */ }
`;

function storeDownloadRoot(scopeKey: string): string {
  if (!SCOPE_PATTERN.test(scopeKey)) throw new Error(tr("本机扩展所属账号无效"));
  return join(app.getPath("userData"), "web-store-downloads", scopeKey);
}

function extensionManifest(item: InstalledWebExtension, partition: Session): Record<string, unknown> {
  const loaded = partition.extensions.getExtension(item.extensionId);
  if (loaded?.manifest && typeof loaded.manifest === "object") return loaded.manifest as Record<string, unknown>;
  try {
    return JSON.parse(readFileSync(join(webExtensionPath(item), "manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function actionPopup(manifest: Record<string, unknown>): string {
  const action = manifest.action ?? manifest.browser_action;
  if (!action || typeof action !== "object") return "";
  const popup = (action as { default_popup?: unknown }).default_popup;
  if (typeof popup !== "string" || !popup || popup.startsWith("/") || popup.includes("\\") || popup.split("/").includes("..")) return "";
  return popup;
}

function extensionIcon(item: InstalledWebExtension, manifest: Record<string, unknown>): string {
  const icons = manifest.icons;
  if (!icons || typeof icons !== "object") return "";
  const paths = Object.entries(icons).sort((a, b) => Math.abs(Number(a[0]) - 32) - Math.abs(Number(b[0]) - 32));
  const root = webExtensionPath(item);
  for (const [, path] of paths) {
    if (typeof path !== "string" || !/\.(png|jpe?g)$/i.test(path)) continue;
    const iconPath = resolve(root, path);
    if (!iconPath.startsWith(root + sep)) continue;
    try {
      if (statSync(iconPath).size > 1024 * 1024) continue;
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) return icon.toDataURL();
    } catch { /* Use the generic icon. */ }
  }
  return "";
}

async function validateManifest(path: string): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  } catch {
    throw new Error(tr("扩展中没有有效的 manifest.json"));
  }
  if (!manifest || typeof manifest !== "object" || ![2, 3].includes((manifest as { manifest_version?: number }).manifest_version ?? 0)) {
    throw new Error(tr("此文件不是受支持的 Chrome 扩展"));
  }
}

async function ensureContentScriptStorageCompat(path: string): Promise<void> {
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    content_scripts?: Array<{ js?: string[] }>;
  };
  const scripts = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts.filter((entry) => entry && Array.isArray(entry.js) && entry.js.length)
    : [];
  if (!scripts.length) return;
  let changed = false;
  for (const entry of scripts) {
    if (!entry.js?.includes(CONTENT_STORAGE_COMPAT)) {
      entry.js = [CONTENT_STORAGE_COMPAT, ...entry.js!];
      changed = true;
    }
  }
  await writeFile(join(path, CONTENT_STORAGE_COMPAT), CONTENT_STORAGE_COMPAT_SOURCE, { mode: 0o600 });
  if (changed) await writeFile(manifestPath, JSON.stringify(manifest));
}

async function loadSessionExtensions(partition: Session, scopeKey: string): Promise<void> {
  for (const item of installedExtensions()) {
    if (item.enabled === false) continue;
    const errorKey = `${scopeKey}:${item.installId}`;
    if (partition.extensions.getExtension(item.extensionId)) {
      restoreDesktopWebExtensionContextMenus(partition, scopeKey, item.extensionId);
      failedLoads.delete(errorKey);
      continue;
    }
    try {
      const path = webExtensionPath(item);
      await ensureContentScriptStorageCompat(path);
      const extension = await partition.extensions.loadExtension(path);
      restoreDesktopWebExtensionContextMenus(partition, scopeKey, extension.id);
      failedLoads.delete(errorKey);
      if (extension.id !== item.extensionId) {
        clearDesktopWebExtensionContextMenus(partition, item.extensionId, true);
        saveInstalledExtensions(installedExtensions().map((stored) =>
          stored.installId === item.installId ? { ...stored, extensionId: extension.id } : stored));
      }
    } catch (error) {
      failedLoads.set(errorKey, error instanceof Error ? error.message : tr("扩展加载失败"));
    }
  }
}

async function loadAllSessionExtensions(): Promise<void> {
  for (const [partition, scopeKey] of extensionSessions) await loadSessionExtensions(partition, scopeKey);
}

export function loadDesktopWebExtensions(partition: Session, scopeKey: string): Promise<void> {
  return extensionOperation(async () => {
    trackExtensionSession(partition, scopeKey);
    await loadSessionExtensions(partition, scopeKey);
  });
}

export function releaseDesktopWebSessionExtensions(partition: Session): Promise<void> {
  return extensionOperation(async () => {
    const scope = extensionSessions.get(partition);
    extensionSessions.delete(partition);
    storeViews.delete(partition);
    for (const extension of partition.extensions.getAllExtensions()) {
      if (scope) clearDesktopWebExtensionContextMenus(partition, extension.id);
      partition.extensions.removeExtension(extension.id);
    }
  });
}

export function listDesktopWebExtensions(partition: Session, scopeKey: string): DesktopWebExtensionInfo[] {
  return installedExtensions().map((item) => {
    const manifest = extensionManifest(item, partition);
    return {
      ...item,
      pinned: item.pinned === true,
      enabled: item.enabled !== false,
      loaded: Boolean(partition.extensions.getExtension(item.extensionId)),
      error: failedLoads.get(`${scopeKey}:${item.installId}`) ?? "",
      iconDataUrl: extensionIcon(item, manifest),
      hasPopup: Boolean(actionPopup(manifest)),
    };
  });
}

export function updateDesktopWebExtension(partition: Session, scopeKey: string, installId: string, change: { pinned?: boolean; enabled?: boolean }): Promise<DesktopWebExtensionInfo[]> {
  return extensionOperation(async () => {
    trackExtensionSession(partition, scopeKey);
    if (!UUID_PATTERN.test(installId)) throw new Error(tr("本机扩展标识无效"));
    const items = installedExtensions();
    const item = items.find((candidate) => candidate.installId === installId);
    if (!item) throw new Error(tr("本机扩展不存在"));
    if (typeof change.enabled === "boolean") {
      if (!change.enabled) {
        closeDesktopWebExtensionPopup();
        for (const [session, key] of extensionSessions) {
          clearDesktopWebExtensionContextMenus(session, item.extensionId);
          if (session.extensions.getExtension(item.extensionId)) session.extensions.removeExtension(item.extensionId);
          failedLoads.delete(`${key}:${installId}`);
        }
      }
      item.enabled = change.enabled;
    }
    if (typeof change.pinned === "boolean") item.pinned = change.pinned;
    saveInstalledExtensions(items);
    await loadAllSessionExtensions();
    notifyExtensionsChanged();
    return listDesktopWebExtensions(partition, scopeKey);
  });
}

export async function openDesktopWebExtensionPopup(partition: Session, scopeKey: string, installId: string, anchor: { right: number; bottom: number }, activeTabId?: number): Promise<void> {
  if (!UUID_PATTERN.test(installId)) throw new Error(tr("本机扩展标识无效"));
  const item = installedExtensions().find((candidate) => candidate.installId === installId);
  if (!item || item.enabled === false || !partition.extensions.getExtension(item.extensionId)) throw new Error(tr("扩展尚未启用"));
  const popupPath = actionPopup(extensionManifest(item, partition));
  if (!popupPath) throw new Error(tr("此扩展没有可打开的弹窗"));
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const popupUrl = new URL(popupPath, `chrome-extension://${item.extensionId}/`).href;
  if (!popupUrl.startsWith(`chrome-extension://${item.extensionId}/`)) throw new Error(tr("扩展弹窗地址无效"));
  closeDesktopWebExtensionPopup();
  const content = mainWindow.getContentBounds();
  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const anchorRight = content.x + Math.round(anchor.right);
  const anchorBottom = content.y + Math.round(anchor.bottom) + 6;
  const popupBounds = (requestedWidth: number, requestedHeight: number) => {
    const width = Math.max(1, Math.min(Math.ceil(requestedWidth), workArea.width));
    const height = Math.max(1, Math.min(Math.ceil(requestedHeight), workArea.height));
    return {
      x: Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, anchorRight - width)),
      y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, anchorBottom)),
      width,
      height,
    };
  };
  const popup = new BrowserWindow({ parent: mainWindow, ...popupBounds(400, 600), show: false, frame: false, resizable: false, skipTaskbar: true,
    backgroundColor: "#ffffff", webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, sandbox: true, enablePreferredSizeMode: true } });
  let preferredSize: Electron.Size | null = null;
  let resolvePreferredSize: (() => void) | undefined;
  const firstPreferredSize = new Promise<void>((resolve) => { resolvePreferredSize = resolve; });
  popup.webContents.on("preferred-size-changed", (_event, size) => {
    if (size.width <= 0 || size.height <= 0 || popup.isDestroyed()) return;
    preferredSize = size;
    resolvePreferredSize?.();
    resolvePreferredSize = undefined;
    const bounds = popupBounds(size.width, size.height);
    const current = popup.getBounds();
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) popup.setBounds(bounds);
  });
  registerNativeOverlayWindow(popup, 2500);
  extensionPopups.set(scopeKey, popup);
  if (Number.isInteger(activeTabId)) grantExtensionActiveTab(partition, item.extensionId, activeTabId!);
  if (Number.isInteger(activeTabId)) popupActiveTabs.set(scopeKey, { partition, extensionId: item.extensionId, tabId: activeTabId! });
  popup.once("closed", () => {
    if (extensionPopups.get(scopeKey) === popup) {
      extensionPopups.delete(scopeKey);
      popupActiveTabs.delete(scopeKey);
    }
  });
  popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popup.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(`chrome-extension://${item.extensionId}/`)) event.preventDefault(); });
  popup.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); closeDesktopWebExtensionPopup(scopeKey); }
  });
  try {
    await popup.loadURL(popupUrl);
    if (!preferredSize) await Promise.race([firstPreferredSize, new Promise<void>((resolve) => setTimeout(resolve, 300))]);
    if (extensionPopups.get(scopeKey) !== popup || !mainWindow || mainWindow.isDestroyed()) return;
    popup.show();
    // Extension actions may change focus while native view callbacks are on the
    // stack. Close on the next turn, after the focus transition has settled.
    popup.once("blur", () => setImmediate(() => {
      if (extensionPopups.get(scopeKey) === popup && !popup.isDestroyed() && !popup.isFocused()) closeDesktopWebExtensionPopup(scopeKey);
    }));
  } catch (error) {
    closeDesktopWebExtensionPopup(scopeKey);
    throw error;
  }
}

export function closeDesktopWebExtensionPopup(scopeKey?: string): void {
  for (const [key, popup] of extensionPopups) {
    if (scopeKey && key !== scopeKey) continue;
    extensionPopups.delete(key);
    popupActiveTabs.delete(key);
    if (!popup.isDestroyed()) popup.close();
  }
}

export function desktopWebExtensionActiveTabId(partition: Session, extensionId: string): number | null {
  for (const entry of popupActiveTabs.values()) {
    if (entry.partition === partition && entry.extensionId === extensionId) return entry.tabId;
  }
  return null;
}

export function desktopWebExtensionPopupContents(scopeKey: string): Electron.WebContents | null {
  const popup = extensionPopups.get(scopeKey);
  return popup && !popup.isDestroyed() ? popup.webContents : null;
}

export async function enableDesktopChromeWebStore(view: ManagedDesktopWebView): Promise<void> {
  const partition = view.partition;
  storeViews.set(partition, view);
  if (storeSessions.has(partition)) return;
  const scopeKey = view.lastUrlKey;
  const downloads = storeDownloadRoot(scopeKey);
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  partition.extensions.on("extension-loaded", (_event, extension) => {
    const relativePath = relative(downloads, extension.path);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return;
    void (async () => {
      try {
        partition.extensions.removeExtension(extension.id);
        await installDesktopWebExtensionFromDirectory(partition, scopeKey, extension.path, extension.id);
        await rm(join(downloads, extension.id), { recursive: true, force: true });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:web-extension:changed", { viewId: storeViews.get(partition)?.id, type: "success", message: tr("扩展已安装到本机全部环境；刷新页面后生效") });
      } catch (error) {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:web-extension:changed", { viewId: storeViews.get(partition)?.id, type: "error", message: error instanceof Error ? error.message : tr("商店拓展安装失败") });
      }
    })();
  });
  await installChromeWebStore({
    session: partition,
    extensionsPath: downloads,
    loadExtensions: false,
    autoUpdate: false,
    beforeInstall: async ({ id, localizedName }) => {
      if (installedExtensions().some((item) => item.chromeId === id)) return { action: "deny" };
      if (!mainWindow || mainWindow.isDestroyed()) return { action: "deny" };
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        message: tr("将「{{0}}」添加到 Viron？", [localizedName]),
        buttons: [tr("取消"), tr("添加")],
        defaultId: 1,
        cancelId: 0,
      });
      return { action: result.response === 1 ? "allow" : "deny" };
    },
  });
  storeSessions.add(partition);
}

export async function scanDesktopChromeExtensions(): Promise<DesktopChromeExtensionInfo[]> {
  const now = Date.now();
  for (const [token, entry] of scannedChromeExtensions) if (entry.expiresAt < now) scannedChromeExtensions.delete(token);
  const smokeRoot = process.argv.includes("--smoke-test") ? process.env.VIRON_DESKTOP_SMOKE_CHROME_ROOT : undefined;
  const found = await findChromeExtensions(smokeRoot);
  return found.map((extension) => {
    const token = randomUUID();
    scannedChromeExtensions.set(token, { extension, expiresAt: now + 5 * 60_000 });
    return { token, chromeId: extension.chromeId, name: extension.name, version: extension.version, profile: extension.profile };
  });
}

export async function importDesktopChromeExtension(partition: Session, scopeKey: string, token: string): Promise<DesktopWebExtensionInfo[]> {
  const scanned = scannedChromeExtensions.get(token);
  if (!scanned || scanned.expiresAt < Date.now()) throw new Error(tr("Chrome 扩展列表已过期，请刷新后重试"));
  return installDesktopWebExtensionFromDirectory(partition, scopeKey, scanned.extension.path, scanned.extension.chromeId);
}

export async function installDesktopWebExtension(partition: Session, scopeKey: string): Promise<{ canceled: boolean; items: DesktopWebExtensionInfo[] }> {
  await loadDesktopWebExtensions(partition, scopeKey);
  const selected = await dialog.showOpenDialog({
    title: tr("选择 Chrome 扩展压缩包"),
    properties: ["openFile"],
    filters: [{ name: tr("Chrome 扩展"), extensions: ["zip", "crx"] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true, items: listDesktopWebExtensions(partition, scopeKey) };
  return { canceled: false, items: await installDesktopWebExtensionFromArchive(partition, scopeKey, selected.filePaths[0]) };
}

export async function installDesktopWebExtensionFromArchive(partition: Session, scopeKey: string, archivePath: string): Promise<DesktopWebExtensionInfo[]> {
  if (!/\.(zip|crx)$/i.test(archivePath)) throw new Error(tr("请选择 ZIP 或 CRX 扩展压缩包"));
  const extracted = await mkdtemp(join(tmpdir(), "viron-extension-"));
  try {
    await extractWebExtensionArchive(archivePath, extracted);
    let source = extracted;
    const entries = await readdir(extracted, { withFileTypes: true });
    if (!entries.some((entry) => entry.name === "manifest.json") && entries.length === 1 && entries[0].isDirectory()) {
      source = join(extracted, entries[0].name);
    }
    return await installDesktopWebExtensionFromDirectory(partition, scopeKey, source);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

export function installDesktopWebExtensionFromDirectory(partition: Session, scopeKey: string, directory: string, chromeId?: string): Promise<DesktopWebExtensionInfo[]> {
  return extensionOperation(async () => {
    trackExtensionSession(partition, scopeKey);
    try {
      await installExtensionDirectory(partition, directory, chromeId);
    } finally {
      // Store downloads and keyed duplicates can temporarily replace a loaded runtime.
      await loadAllSessionExtensions();
      notifyExtensionsChanged();
    }
    return listDesktopWebExtensions(partition, scopeKey);
  });
}

async function installExtensionDirectory(partition: Session, directory: string, chromeId?: string): Promise<void> {
  if (chromeId && installedExtensions().some((item) => item.chromeId === chromeId)) throw new Error(tr("本机已添加此 Chrome 扩展"));
  const source = resolve(directory);
  await validateManifest(source);
  const root = webExtensionRoot();
  const sourceRelativeToRoot = relative(root, source);
  if (!sourceRelativeToRoot.startsWith("..") && !isAbsolute(sourceRelativeToRoot)) {
    throw new Error(tr("不能从 Viron 已安装的扩展目录再次安装"));
  }
  const installId = randomUUID();
  const target = webExtensionPath({ installId });
  let copiedBytes = 0;
  let loadedExtensionId = "";
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await cp(source, target, {
      recursive: true,
      filter: async (path) => {
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(tr("扩展目录不能包含符号链接或特殊文件"));
        if (info.isFile()) {
          copiedBytes += info.size;
          if (copiedBytes > MAX_EXTENSION_BYTES) throw new Error(tr("扩展目录不能超过 100 MB"));
        }
        return true;
      },
    });
    await validateManifest(target);
    await ensureContentScriptStorageCompat(target);
    const extension = await partition.extensions.loadExtension(target);
    loadedExtensionId = extension.id;
    const item: InstalledWebExtension = { installId, extensionId: extension.id, name: extension.name, version: extension.version, ...(chromeId ? { chromeId } : {}) };
    if (installedExtensions().some((existing) => existing.extensionId === extension.id)) {
      throw new Error(tr("本机已添加此 Chrome 扩展"));
    }
    saveInstalledExtensions([...installedExtensions(), item]);
  } catch (error) {
    if (loadedExtensionId && partition.extensions.getExtension(loadedExtensionId)) partition.extensions.removeExtension(loadedExtensionId);
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export function removeDesktopWebExtension(partition: Session, scopeKey: string, installId: string): Promise<DesktopWebExtensionInfo[]> {
  return extensionOperation(async () => {
    trackExtensionSession(partition, scopeKey);
    if (!UUID_PATTERN.test(installId)) throw new Error(tr("本机扩展标识无效"));
    const items = installedExtensions();
    const item = items.find((candidate) => candidate.installId === installId);
    if (!item) throw new Error(tr("本机扩展不存在"));
    closeDesktopWebExtensionPopup();
    for (const [session, key] of extensionSessions) {
      clearDesktopWebExtensionContextMenus(session, item.extensionId, true);
      if (session.extensions.getExtension(item.extensionId)) session.extensions.removeExtension(item.extensionId);
      failedLoads.delete(`${key}:${installId}`);
    }
    // Forget saved menus in unopened environments as well.
    const state = readState();
    for (const menus of Object.values(state.webExtensionMenus ?? {})) delete menus[item.extensionId];
    writeState(state);
    saveInstalledExtensions(items.filter((candidate) => candidate.installId !== installId));
    notifyExtensionsChanged();
    await rm(webExtensionPath(item), { recursive: true, force: true });
    return listDesktopWebExtensions(partition, scopeKey);
  });
}

// Deleting an account only clears its runtime. The computer-wide catalog and files survive.
export function forgetDesktopWebExtensions(partition: Session, scopeKey: string): Promise<void> {
  return extensionOperation(async () => {
    closeDesktopWebExtensionPopup(scopeKey);
    for (const item of installedExtensions()) {
      clearDesktopWebExtensionContextMenus(partition, item.extensionId, true);
      if (partition.extensions.getExtension(item.extensionId)) partition.extensions.removeExtension(item.extensionId);
      failedLoads.delete(`${scopeKey}:${item.installId}`);
    }
    extensionSessions.delete(partition);
    const state = readState();
    if (state.webExtensionMenus) delete state.webExtensionMenus[scopeKey];
    writeState(state);
    await rm(storeDownloadRoot(scopeKey), { recursive: true, force: true });
  });
}
