import { createHash } from "node:crypto";
import { idAfterClose } from "../shared/tab-order.js";

export const DESKTOP_WEB_PAGE_LIMIT = 8;

export type DesktopWebContextMenuAction =
  | "open-link-new-page"
  | "copy-link"
  | "fill-username"
  | "fill-password"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "back"
  | "forward"
  | "reload"
  | "inspect";

export interface DesktopWebContextMenuContext {
  linkUrl: string;
  isEditable: boolean;
  hasSelection: boolean;
  credentialFillAvailable?: boolean;
  inspectAllowed?: boolean;
}

export function desktopWebPartitionName(endpoint: string, userId: string, credentialId: string): string {
  const key = createHash("sha256").update(`${endpoint}\0${userId}\0${credentialId}`).digest("hex").slice(0, 40);
  return `persist:viron-web-${key}`;
}

export function desktopWebLastUrlKey(endpoint: string, userId: string, credentialId: string): string {
  return createHash("sha256").update(`${endpoint}\0${userId}\0${credentialId}`).digest("hex");
}

export function supportedDesktopWebUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function deceptiveChromeWebStoreUrl(value: string): boolean {
  if (!value.startsWith("https://chromewebstore.google.com")) return false;
  try {
    return new URL(value).origin !== "https://chromewebstore.google.com";
  } catch {
    return true;
  }
}

export function supportedDesktopPopupUrl(value: string): boolean {
  return value === "about:blank" || supportedDesktopWebUrl(value);
}

export function cacheableDesktopWebUrl(entryUrl: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const entry = new URL(entryUrl);
    const target = new URL(value);
    if (!supportedDesktopWebUrl(entry.href) || !supportedDesktopWebUrl(target.href) || target.origin !== entry.origin) return null;
    return target.href;
  } catch {
    return null;
  }
}

export function restorableDesktopWebUrl(entryUrl: string, storedUrl: unknown): string {
  return cacheableDesktopWebUrl(entryUrl, storedUrl) ?? new URL(entryUrl).href;
}

export function shouldAttemptDesktopWebAutofill(automaticAutofillEnabled: boolean, force: boolean): boolean {
  return automaticAutofillEnabled || force;
}

export function desktopWebContextMenuGroups(context: DesktopWebContextMenuContext): DesktopWebContextMenuAction[][] {
  const groups: DesktopWebContextMenuAction[][] = [];
  if (context.linkUrl) {
    groups.push([
      ...(supportedDesktopWebUrl(context.linkUrl) ? ["open-link-new-page" as const] : []),
      "copy-link",
    ]);
  }
  if (context.isEditable) {
    if (context.credentialFillAvailable) groups.push(["fill-username", "fill-password"]);
    groups.push(["undo", "redo"], ["cut", "copy", "paste"], ["select-all"]);
  } else if (context.hasSelection) {
    groups.push(["copy"]);
  }
  groups.push(["back", "forward", "reload"]);
  if (context.inspectAllowed !== false) groups.push(["inspect"]);
  return groups;
}

export function pageAfterClose(pageIds: string[], activePageId: string, closedPageId: string): string | null {
  return idAfterClose(pageIds, activePageId, closedPageId);
}
