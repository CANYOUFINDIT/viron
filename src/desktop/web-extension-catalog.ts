import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { readState, writeState, type InstalledWebExtension } from "./app-state.js";

export const WEB_EXTENSION_INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WEB_EXTENSION_SCOPE = /^[0-9a-f]{64}$/i;

export function webExtensionRoot(): string {
  return join(app.getPath("userData"), "web-extensions");
}

export function webExtensionPath(item: Pick<InstalledWebExtension, "installId" | "sourceScope">): string {
  if (!WEB_EXTENSION_INSTALL_ID.test(item.installId) || (item.sourceScope && !WEB_EXTENSION_SCOPE.test(item.sourceScope))) {
    throw new Error("Invalid local extension path");
  }
  return join(webExtensionRoot(), item.sourceScope || "global", item.installId);
}

function validItems(stored: unknown): InstalledWebExtension[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter((item): item is InstalledWebExtension => Boolean(
    item && WEB_EXTENSION_INSTALL_ID.test(item.installId) && typeof item.extensionId === "string"
    && typeof item.name === "string" && typeof item.version === "string"
    && (item.sourceScope === undefined || (typeof item.sourceScope === "string" && WEB_EXTENSION_SCOPE.test(item.sourceScope))),
  ));
}

export function installedWebExtensions(): InstalledWebExtension[] {
  const state = readState();
  const items = validItems(state.globalWebExtensions);
  if (!state.webExtensions) return items;
  // Migrate every account, including environments that are not currently open.
  // Retain the original path: Electron derives unpacked extension IDs from it.
  for (const [scopeKey, stored] of Object.entries(state.webExtensions)) {
    if (!WEB_EXTENSION_SCOPE.test(scopeKey)) continue;
    for (const legacy of validItems(stored)) {
      const item = { ...legacy, sourceScope: scopeKey };
      const duplicate = items.findIndex((existing) => existing.installId === item.installId
        || (item.chromeId ? existing.chromeId === item.chromeId
          : /^[a-p]{32}$/.test(item.extensionId) && existing.extensionId === item.extensionId));
      if (duplicate < 0) items.push(item);
      else {
        const existing = items[duplicate];
        const available = existsSync(join(webExtensionPath(item), "manifest.json"));
        const newer = item.version.localeCompare(existing.version, "en", { numeric: true }) > 0;
        if (available && (newer || !existsSync(join(webExtensionPath(existing), "manifest.json")))) items[duplicate] = item;
        items[duplicate].pinned = existing.pinned === true || item.pinned === true;
        items[duplicate].enabled = existing.enabled !== false || item.enabled !== false;
      }
    }
  }
  state.globalWebExtensions = items;
  delete state.webExtensions;
  writeState(state);
  return items;
}

export function saveInstalledWebExtensions(items: InstalledWebExtension[]): void {
  const state = readState();
  state.globalWebExtensions = items;
  writeState(state);
}
