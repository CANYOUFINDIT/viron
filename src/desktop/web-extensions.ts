import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, nativeImage, screen, type Session } from "electron";
import { installChromeWebStore } from "electron-chrome-web-store";
import { readState, writeState } from "./app-state.js";
import { translate as tr } from "./i18n.js";
import { findChromeExtensions, type ChromeExtensionOnDisk } from "./chrome-extension-scan.js";
import { extractWebExtensionArchive } from "./web-extension-archive.js";
import { mainWindow } from "./window-host.js";
import type { ManagedDesktopWebView } from "./web-view-runtime.js";

interface InstalledWebExtension {
  installId: string;
  extensionId: string;
  name: string;
  version: string;
  chromeId?: string;
  pinned?: boolean;
  enabled?: boolean;
}

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
const loadingSessions = new WeakMap<Session, Promise<void>>();
const scannedChromeExtensions = new Map<string, { extension: ChromeExtensionOnDisk; expiresAt: number }>();
const extensionPopups = new Map<string, BrowserWindow>();
const storeSessions = new WeakSet<Session>();
const storeViews = new WeakMap<Session, ManagedDesktopWebView>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_EXTENSION_BYTES = 100 * 1024 * 1024;

function extensionRoot(scopeKey: string): string {
  if (!SCOPE_PATTERN.test(scopeKey)) throw new Error(tr("本机扩展所属账号无效"));
  return join(app.getPath("userData"), "web-extensions", scopeKey);
}

function storeDownloadRoot(scopeKey: string): string {
  if (!SCOPE_PATTERN.test(scopeKey)) throw new Error(tr("本机扩展所属账号无效"));
  return join(app.getPath("userData"), "web-store-downloads", scopeKey);
}

function installedExtensions(scopeKey: string): InstalledWebExtension[] {
  const stored = readState().webExtensions?.[scopeKey];
  if (!Array.isArray(stored)) return [];
  return stored.filter((item): item is InstalledWebExtension => Boolean(
    item && UUID_PATTERN.test(item.installId) && typeof item.extensionId === "string"
    && typeof item.name === "string" && typeof item.version === "string",
  ));
}

function saveInstalledExtensions(scopeKey: string, items: InstalledWebExtension[]): void {
  const state = readState();
  const webExtensions = { ...state.webExtensions };
  if (items.length) webExtensions[scopeKey] = items;
  else delete webExtensions[scopeKey];
  if (Object.keys(webExtensions).length) state.webExtensions = webExtensions;
  else delete state.webExtensions;
  writeState(state);
}

function extensionManifest(scopeKey: string, item: InstalledWebExtension, partition: Session): Record<string, unknown> {
  const loaded = partition.extensions.getExtension(item.extensionId);
  if (loaded?.manifest && typeof loaded.manifest === "object") return loaded.manifest as Record<string, unknown>;
  try {
    return JSON.parse(readFileSync(join(extensionRoot(scopeKey), item.installId, "manifest.json"), "utf8")) as Record<string, unknown>;
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

function extensionIcon(scopeKey: string, item: InstalledWebExtension, manifest: Record<string, unknown>): string {
  const icons = manifest.icons;
  if (!icons || typeof icons !== "object") return "";
  const paths = Object.entries(icons).sort((a, b) => Math.abs(Number(a[0]) - 32) - Math.abs(Number(b[0]) - 32));
  const root = join(extensionRoot(scopeKey), item.installId);
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

export async function loadDesktopWebExtensions(partition: Session, scopeKey: string): Promise<void> {
  const pending = loadingSessions.get(partition);
  if (pending) return pending;
  const task = (async () => {
    for (const item of installedExtensions(scopeKey)) {
      if (item.enabled === false) continue;
      const errorKey = `${scopeKey}:${item.installId}`;
      if (partition.extensions.getExtension(item.extensionId)) {
        failedLoads.delete(errorKey);
        continue;
      }
      try {
        const extension = await partition.extensions.loadExtension(join(extensionRoot(scopeKey), item.installId));
        failedLoads.delete(errorKey);
        if (extension.id !== item.extensionId) {
          saveInstalledExtensions(scopeKey, installedExtensions(scopeKey).map((stored) =>
            stored.installId === item.installId ? { ...stored, extensionId: extension.id } : stored));
        }
      } catch (error) {
        failedLoads.set(errorKey, error instanceof Error ? error.message : tr("扩展加载失败"));
      }
    }
  })();
  loadingSessions.set(partition, task);
  try { await task; } finally { loadingSessions.delete(partition); }
}

export function listDesktopWebExtensions(partition: Session, scopeKey: string): DesktopWebExtensionInfo[] {
  return installedExtensions(scopeKey).map((item) => {
    const manifest = extensionManifest(scopeKey, item, partition);
    return {
      ...item,
      pinned: item.pinned === true,
      enabled: item.enabled !== false,
      loaded: Boolean(partition.extensions.getExtension(item.extensionId)),
      error: failedLoads.get(`${scopeKey}:${item.installId}`) ?? "",
      iconDataUrl: extensionIcon(scopeKey, item, manifest),
      hasPopup: Boolean(actionPopup(manifest)),
    };
  });
}

export async function updateDesktopWebExtension(partition: Session, scopeKey: string, installId: string, change: { pinned?: boolean; enabled?: boolean }): Promise<DesktopWebExtensionInfo[]> {
  if (!UUID_PATTERN.test(installId)) throw new Error(tr("本机扩展标识无效"));
  const items = installedExtensions(scopeKey);
  const item = items.find((candidate) => candidate.installId === installId);
  if (!item) throw new Error(tr("本机扩展不存在"));
  if (typeof change.enabled === "boolean" && change.enabled !== (item.enabled !== false)) {
    if (!change.enabled) {
      extensionPopups.get(scopeKey)?.close();
      if (partition.extensions.getExtension(item.extensionId)) partition.extensions.removeExtension(item.extensionId);
    } else {
      const extension = await partition.extensions.loadExtension(join(extensionRoot(scopeKey), installId));
      item.extensionId = extension.id;
      failedLoads.delete(`${scopeKey}:${installId}`);
    }
    item.enabled = change.enabled;
  }
  if (typeof change.pinned === "boolean") item.pinned = change.pinned;
  saveInstalledExtensions(scopeKey, items);
  return listDesktopWebExtensions(partition, scopeKey);
}

export async function openDesktopWebExtensionPopup(partition: Session, scopeKey: string, installId: string, anchor: { right: number; bottom: number }): Promise<void> {
  if (!UUID_PATTERN.test(installId)) throw new Error(tr("本机扩展标识无效"));
  const item = installedExtensions(scopeKey).find((candidate) => candidate.installId === installId);
  if (!item || item.enabled === false || !partition.extensions.getExtension(item.extensionId)) throw new Error(tr("扩展尚未启用"));
  const popupPath = actionPopup(extensionManifest(scopeKey, item, partition));
  if (!popupPath) throw new Error(tr("此扩展没有可打开的弹窗"));
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  const popupUrl = new URL(popupPath, `chrome-extension://${item.extensionId}/`).href;
  if (!popupUrl.startsWith(`chrome-extension://${item.extensionId}/`)) throw new Error(tr("扩展弹窗地址无效"));
  extensionPopups.get(scopeKey)?.close();
  const parentBounds = mainWindow.getContentBounds();
  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const width = 360;
  const height = 480;
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, parentBounds.x + Math.round(anchor.right) - width));
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, parentBounds.y + Math.round(anchor.bottom) + 6));
  const popup = new BrowserWindow({ parent: mainWindow, x, y, width, height, show: false, frame: false, resizable: false,
    webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  extensionPopups.set(scopeKey, popup);
  popup.once("closed", () => { if (extensionPopups.get(scopeKey) === popup) extensionPopups.delete(scopeKey); });
  popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popup.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(`chrome-extension://${item.extensionId}/`)) event.preventDefault(); });
  try {
    await popup.loadURL(popupUrl);
    popup.show();
    popup.once("blur", () => { if (!popup.isDestroyed()) popup.close(); });
  } catch (error) {
    popup.close();
    throw error;
  }
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
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viron:web-extension:changed", { viewId: storeViews.get(partition)?.id, type: "success", message: tr("拓展已安装到 Viron") });
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
      if (installedExtensions(scopeKey).some((item) => item.chromeId === id)) return { action: "deny" };
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

export async function installDesktopWebExtensionFromDirectory(partition: Session, scopeKey: string, directory: string, chromeId?: string): Promise<DesktopWebExtensionInfo[]> {
  if (chromeId && installedExtensions(scopeKey).some((item) => item.chromeId === chromeId)) throw new Error(tr("当前账号已添加此 Chrome 扩展"));
  const source = resolve(directory);
  await validateManifest(source);
  const root = extensionRoot(scopeKey);
  const sourceRelativeToRoot = relative(root, source);
  if (!sourceRelativeToRoot.startsWith("..") && !isAbsolute(sourceRelativeToRoot)) {
    throw new Error(tr("不能从 Viron 已安装的扩展目录再次安装"));
  }
  const installId = randomUUID();
  const target = join(root, installId);
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
    const extension = await partition.extensions.loadExtension(target);
    loadedExtensionId = extension.id;
    const item: InstalledWebExtension = { installId, extensionId: extension.id, name: extension.name, version: extension.version, ...(chromeId ? { chromeId } : {}) };
    saveInstalledExtensions(scopeKey, [...installedExtensions(scopeKey), item]);
    return listDesktopWebExtensions(partition, scopeKey);
  } catch (error) {
    if (loadedExtensionId && partition.extensions.getExtension(loadedExtensionId)) partition.extensions.removeExtension(loadedExtensionId);
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function removeDesktopWebExtension(partition: Session, scopeKey: string, installId: string): Promise<DesktopWebExtensionInfo[]> {
  if (!UUID_PATTERN.test(installId)) throw new Error(tr("本机扩展标识无效"));
  const items = installedExtensions(scopeKey);
  const item = items.find((candidate) => candidate.installId === installId);
  if (!item) throw new Error(tr("本机扩展不存在"));
  extensionPopups.get(scopeKey)?.close();
  if (partition.extensions.getExtension(item.extensionId)) partition.extensions.removeExtension(item.extensionId);
  saveInstalledExtensions(scopeKey, items.filter((candidate) => candidate.installId !== installId));
  failedLoads.delete(`${scopeKey}:${installId}`);
  await rm(join(extensionRoot(scopeKey), installId), { recursive: true, force: true });
  return listDesktopWebExtensions(partition, scopeKey);
}

export async function forgetDesktopWebExtensions(partition: Session, scopeKey: string): Promise<void> {
  extensionPopups.get(scopeKey)?.close();
  for (const item of installedExtensions(scopeKey)) {
    if (partition.extensions.getExtension(item.extensionId)) partition.extensions.removeExtension(item.extensionId);
    failedLoads.delete(`${scopeKey}:${item.installId}`);
  }
  saveInstalledExtensions(scopeKey, []);
  await rm(extensionRoot(scopeKey), { recursive: true, force: true });
  await rm(storeDownloadRoot(scopeKey), { recursive: true, force: true });
}
