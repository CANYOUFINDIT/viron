import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcMain, WebContentsView, type MenuItemConstructorOptions, type Session, type WebContents } from "electron";
import { readState, writeState } from "./app-state.js";

type MenuId = string | number;
type ExtensionMenu = {
  id: MenuId;
  title: string;
  type: "normal" | "separator" | "checkbox" | "radio";
  contexts: string[];
  parentId?: MenuId;
  visible: boolean;
  enabled: boolean;
  checked: boolean;
  documentUrlPatterns: string[];
  targetUrlPatterns: string[];
};
type Context = {
  pageURL: string;
  frameURL: string;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
};

const menus = new WeakMap<Session, Map<string, Map<MenuId, ExtensionMenu>>>();
const scopeKeys = new WeakMap<Session, string>();
const workerListeners = new WeakSet<Session>();
const boundWorkers = new WeakSet<Electron.ServiceWorkerMain>();
let listening = false;

function menuStore(partition: Session, extensionId: string): Map<MenuId, ExtensionMenu> {
  let byExtension = menus.get(partition);
  if (!byExtension) { byExtension = new Map(); menus.set(partition, byExtension); }
  let items = byExtension.get(extensionId);
  if (!items) { items = new Map(); byExtension.set(extensionId, items); }
  return items;
}

function persistMenus(partition: Session, extensionId: string): void {
  const scopeKey = scopeKeys.get(partition);
  if (!scopeKey) return;
  const state = readState();
  const scopes = { ...state.webExtensionMenus };
  const extensions = { ...scopes[scopeKey] };
  const items = [...(menus.get(partition)?.get(extensionId)?.values() ?? [])];
  if (items.length) extensions[extensionId] = items;
  else delete extensions[extensionId];
  if (Object.keys(extensions).length) scopes[scopeKey] = extensions;
  else delete scopes[scopeKey];
  if (Object.keys(scopes).length) state.webExtensionMenus = scopes;
  else delete state.webExtensionMenus;
  writeState(state);
}

export function restoreDesktopWebExtensionContextMenus(partition: Session, scopeKey: string, extensionId: string): void {
  const loaded = partition.extensions.getExtension(extensionId);
  if (!loaded || !Array.isArray(loaded.manifest.permissions) || !loaded.manifest.permissions.includes("contextMenus")) return;
  const stored = readState().webExtensionMenus?.[scopeKey]?.[extensionId];
  if (!Array.isArray(stored)) return;
  const items = menuStore(partition, extensionId);
  for (const raw of stored.slice(0, 100)) {
    const item = checkedMenu(raw);
    if (item && !items.has(item.id)) items.set(item.id, item);
  }
}

function checkedId(value: unknown): MenuId | null {
  return typeof value === "string" && value.length <= 128 ? value
    : typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function checkedMenu(value: unknown, previous?: ExtensionMenu): ExtensionMenu | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = checkedId(input.id);
  if (id === null) return null;
  const type = ["normal", "separator", "checkbox", "radio"].includes(String(input.type))
    ? input.type as ExtensionMenu["type"] : previous?.type ?? "normal";
  const title = typeof input.title === "string" ? input.title.slice(0, 200) : previous?.title ?? "";
  if (type !== "separator" && !title) return null;
  const contexts = Array.isArray(input.contexts) ? input.contexts.filter((item): item is string => typeof item === "string").slice(0, 16) : previous?.contexts ?? ["page"];
  const patterns = (key: "documentUrlPatterns" | "targetUrlPatterns") => Array.isArray(input[key])
    ? input[key].filter((item): item is string => typeof item === "string" && item.length <= 500).slice(0, 32)
    : previous?.[key] ?? [];
  return {
    id, title, type, contexts,
    parentId: checkedId(input.parentId) ?? previous?.parentId,
    visible: typeof input.visible === "boolean" ? input.visible : previous?.visible ?? true,
    enabled: typeof input.enabled === "boolean" ? input.enabled : previous?.enabled ?? true,
    checked: typeof input.checked === "boolean" ? input.checked : previous?.checked ?? false,
    documentUrlPatterns: patterns("documentUrlPatterns"),
    targetUrlPatterns: patterns("targetUrlPatterns"),
  };
}

function applyMutation(partition: Session, origin: string, operation: string, extensionId: string, value?: unknown): void {
  if (typeof extensionId !== "string" || !origin.startsWith(`chrome-extension://${extensionId}/`)) return;
  const loaded = partition.extensions.getExtension(extensionId);
  if (!loaded || !Array.isArray(loaded.manifest.permissions) || !loaded.manifest.permissions.includes("contextMenus")) return;
  const items = menuStore(partition, extensionId);
  if (operation === "removeAll") { items.clear(); persistMenus(partition, extensionId); return; }
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const id = checkedId(input.id);
  if (id === null) return;
  if (operation === "remove") { items.delete(id); persistMenus(partition, extensionId); return; }
  if (operation !== "create" && operation !== "update") return;
  const next = checkedMenu(input, operation === "update" ? items.get(id) : undefined);
  if (next && (items.size < 100 || items.has(id))) {
    items.set(id, next);
    persistMenus(partition, extensionId);
  }
}

export function registerDesktopWebExtensionContextMenus(): void {
  if (listening) return;
  listening = true;
  ipcMain.on("viron:extension-menu:mutate", (event, operation: string, extensionId: string, value?: unknown) => {
    if (!event.senderFrame) return;
    applyMutation(event.sender.session, event.senderFrame.url, operation, extensionId, value);
  });
}

export function registerDesktopWebExtensionWorkerMenus(partition: Session, scopeKey: string): void {
  scopeKeys.set(partition, scopeKey);
  if (workerListeners.has(partition)) return;
  workerListeners.add(partition);
  const bindWorker = (versionId: number) => {
    const worker = partition.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || boundWorkers.has(worker)) return;
    boundWorkers.add(worker);
    worker.ipc.on("viron:extension-menu:mutate", (event, operation: string, extensionId: string, value?: unknown) => {
      applyMutation(event.session, event.serviceWorker.scope, operation, extensionId, value);
    });
  };
  partition.serviceWorkers.on("running-status-changed", (event) => {
    if (event.runningStatus === "starting" || event.runningStatus === "running") bindWorker(event.versionId);
  });
  for (const id of Object.keys(partition.serviceWorkers.getAllRunning())) bindWorker(Number(id));
}

export function clearDesktopWebExtensionContextMenus(partition: Session, extensionId: string, forget = false): void {
  menus.get(partition)?.delete(extensionId);
  if (forget) persistMenus(partition, extensionId);
}

function matchesPattern(pattern: string, url: string): boolean {
  if (!url) return false;
  if (pattern === "<all_urls>") return /^(https?|file):/i.test(url);
  const expression = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  try { return new RegExp(`^${expression}$`, "i").test(url); } catch { return false; }
}

function visibleInContext(item: ExtensionMenu, params: Context): boolean {
  if (!item.visible) return false;
  const contexts = item.contexts;
  const isPage = !params.selectionText && !params.linkURL && !params.isEditable && params.mediaType === "none";
  if (!contexts.includes("all") && !(contexts.includes("page") && isPage)
    && !(contexts.includes("selection") && params.selectionText)
    && !(contexts.includes("link") && params.linkURL)
    && !(contexts.includes("editable") && params.isEditable)
    && !(contexts.includes("frame") && params.frameURL && params.frameURL !== params.pageURL)
    && !(contexts.includes(params.mediaType) && params.mediaType !== "none")) return false;
  if (item.documentUrlPatterns.length && !item.documentUrlPatterns.some((pattern) => matchesPattern(pattern, params.frameURL || params.pageURL))) return false;
  if (item.targetUrlPatterns.length && !item.targetUrlPatterns.some((pattern) => matchesPattern(pattern, params.linkURL || params.srcURL))) return false;
  return true;
}

async function dispatchClick(partition: Session, extensionId: string, id: MenuId, item: ExtensionMenu, contents: WebContents, params: Context, wasChecked: boolean): Promise<void> {
  const info = {
    menuItemId: id,
    ...(item.parentId === undefined ? {} : { parentMenuItemId: item.parentId }),
    pageUrl: params.pageURL,
    frameUrl: params.frameURL,
    linkUrl: params.linkURL,
    srcUrl: params.srcURL,
    mediaType: params.mediaType,
    selectionText: params.selectionText,
    editable: params.isEditable,
    wasChecked,
    checked: item.checked,
  };
  const tab = { id: contents.id, url: contents.getURL(), title: contents.getTitle(), active: true };
  const extension = partition.extensions.getExtension(extensionId);
  if (!extension) return;
  const filename = "__viron_context_menu_bridge__.html";
  await writeFile(join(extension.path, filename), "<!doctype html><title>Extension command</title>", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const bridge = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await bridge.webContents.loadURL(`chrome-extension://${extensionId}/${filename}`);
    await bridge.webContents.executeJavaScript(`chrome.runtime.sendMessage(${JSON.stringify({ __vironMenuClick: true, extensionId, info, tab })})`);
  } catch { /* The extension may have been disabled while the command was opening. */ }
  finally { if (!bridge.webContents.isDestroyed()) bridge.webContents.close(); }
}

export function desktopWebExtensionContextMenuItems(partition: Session, contents: WebContents, params: Context): MenuItemConstructorOptions[] {
  const byExtension = menus.get(partition);
  if (!byExtension) return [];
  const groups: MenuItemConstructorOptions[] = [];
  for (const [extensionId, items] of byExtension) {
    const extension = partition.extensions.getExtension(extensionId);
    if (!extension) continue;
    const visible = [...items.values()].filter((item) => visibleInContext(item, params));
    if (!visible.length) continue;
    const build = (parentId?: MenuId, depth = 0): MenuItemConstructorOptions[] => visible
      .filter((item) => item.parentId === parentId)
      .map((item): MenuItemConstructorOptions => {
        if (item.type === "separator") return { type: "separator" };
        const children = depth < 3 ? build(item.id, depth + 1) : [];
        return {
          label: item.title.replace(/%s/g, params.selectionText.slice(0, 80)),
          type: item.type,
          enabled: item.enabled,
          ...(item.type === "checkbox" || item.type === "radio" ? { checked: item.checked } : {}),
          ...(children.length ? { submenu: children } : { click: () => {
            const wasChecked = item.checked;
            if (item.type === "checkbox") item.checked = !item.checked;
            if (item.type === "radio") {
              for (const sibling of items.values()) {
                if (sibling.type === "radio" && sibling.parentId === item.parentId) sibling.checked = sibling === item;
              }
            }
            if (item.type === "checkbox" || item.type === "radio") persistMenus(partition, extensionId);
            void dispatchClick(partition, extensionId, item.id, item, contents, params, wasChecked).catch(() => undefined);
          } }),
        };
      });
    const entries = build();
    if (!entries.length) continue;
    groups.push({ label: extension.name, submenu: entries });
  }
  return groups;
}
