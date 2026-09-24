import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { app, dialog, type Session } from "electron";
import { readState, writeState } from "./app-state.js";
import { translate as tr } from "./i18n.js";

interface InstalledWebExtension {
  installId: string;
  extensionId: string;
  name: string;
  version: string;
}

export interface DesktopWebExtensionInfo extends InstalledWebExtension {
  loaded: boolean;
  error: string;
}

const failedLoads = new Map<string, string>();
const loadingSessions = new WeakMap<Session, Promise<void>>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_EXTENSION_BYTES = 100 * 1024 * 1024;

function extensionRoot(scopeKey: string): string {
  if (!SCOPE_PATTERN.test(scopeKey)) throw new Error(tr("本机扩展所属账号无效"));
  return join(app.getPath("userData"), "web-extensions", scopeKey);
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

async function validateManifest(path: string): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  } catch {
    throw new Error(tr("所选目录没有有效的 manifest.json；请选择已解压的 Chrome 扩展根目录"));
  }
  if (!manifest || typeof manifest !== "object" || ![2, 3].includes((manifest as { manifest_version?: number }).manifest_version ?? 0)) {
    throw new Error(tr("此目录不是受支持的 Chrome 扩展"));
  }
}

export async function loadDesktopWebExtensions(partition: Session, scopeKey: string): Promise<void> {
  const pending = loadingSessions.get(partition);
  if (pending) return pending;
  const task = (async () => {
    for (const item of installedExtensions(scopeKey)) {
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
  return installedExtensions(scopeKey).map((item) => ({
    ...item,
    loaded: Boolean(partition.extensions.getExtension(item.extensionId)),
    error: failedLoads.get(`${scopeKey}:${item.installId}`) ?? "",
  }));
}

export async function installDesktopWebExtension(partition: Session, scopeKey: string): Promise<{ canceled: boolean; items: DesktopWebExtensionInfo[] }> {
  await loadDesktopWebExtensions(partition, scopeKey);
  const selected = await dialog.showOpenDialog({
    title: tr("选择已解压的 Chrome 扩展目录"),
    properties: ["openDirectory"],
  });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true, items: listDesktopWebExtensions(partition, scopeKey) };
  return { canceled: false, items: await installDesktopWebExtensionFromDirectory(partition, scopeKey, selected.filePaths[0]) };
}

export async function installDesktopWebExtensionFromDirectory(partition: Session, scopeKey: string, directory: string): Promise<DesktopWebExtensionInfo[]> {
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
    const item: InstalledWebExtension = { installId, extensionId: extension.id, name: extension.name, version: extension.version };
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
  if (partition.extensions.getExtension(item.extensionId)) partition.extensions.removeExtension(item.extensionId);
  saveInstalledExtensions(scopeKey, items.filter((candidate) => candidate.installId !== installId));
  failedLoads.delete(`${scopeKey}:${installId}`);
  await rm(join(extensionRoot(scopeKey), installId), { recursive: true, force: true });
  return listDesktopWebExtensions(partition, scopeKey);
}

export async function forgetDesktopWebExtensions(partition: Session, scopeKey: string): Promise<void> {
  for (const item of installedExtensions(scopeKey)) {
    if (partition.extensions.getExtension(item.extensionId)) partition.extensions.removeExtension(item.extensionId);
    failedLoads.delete(`${scopeKey}:${item.installId}`);
  }
  saveInstalledExtensions(scopeKey, []);
  await rm(extensionRoot(scopeKey), { recursive: true, force: true });
}
