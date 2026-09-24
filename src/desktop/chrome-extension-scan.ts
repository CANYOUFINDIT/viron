import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";

export interface ChromeExtensionOnDisk {
  chromeId: string;
  name: string;
  version: string;
  profile: string;
  path: string;
}

const CHROME_ID = /^[a-p]{32}$/;
const PROFILE_NAME = /^(Default|Profile \d+)$/;
const MAX_MANIFEST_BYTES = 256 * 1024;

export function chromeUserDataRoot(platform = process.platform, home = homedir(), localAppData = process.env.LOCALAPPDATA): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return join(localAppData || join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return join(home, ".config", "google-chrome");
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function smallJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.size > MAX_MANIFEST_BYTES) return null;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function extensionName(path: string, manifest: Record<string, unknown>): Promise<string> {
  const value = manifest.name;
  if (typeof value !== "string" || !value.trim()) return "";
  const localized = /^__MSG_(.+)__$/.exec(value);
  if (!localized) return value.trim();
  const locales = [manifest.default_locale, "en", "zh_CN"].filter((locale): locale is string => typeof locale === "string" && /^[A-Za-z_]+$/.test(locale));
  for (const locale of [...new Set(locales)]) {
    const messages = await smallJson(join(path, "_locales", locale, "messages.json"));
    if (!messages) continue;
    const key = Object.keys(messages).find((candidate) => candidate.toLowerCase() === localized[1].toLowerCase());
    const message = key ? messages[key] : null;
    if (message && typeof message === "object" && typeof (message as { message?: unknown }).message === "string") {
      return (message as { message: string }).message;
    }
  }
  return localized[1];
}

export async function findChromeExtensions(root = chromeUserDataRoot()): Promise<ChromeExtensionOnDisk[]> {
  const result: ChromeExtensionOnDisk[] = [];
  const profiles = (await directories(root)).filter((profile) => PROFILE_NAME.test(profile)).slice(0, 32);
  for (const profile of profiles) {
    const extensionsRoot = join(root, profile, "Extensions");
    const ids = (await directories(extensionsRoot)).filter((id) => CHROME_ID.test(id)).slice(0, 500);
    for (const chromeId of ids) {
      const extensionRoot = join(extensionsRoot, chromeId);
      const versions = (await directories(extensionRoot)).filter((version) => /^[\w.-]+$/.test(version))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const versionFolder of versions) {
        const path = join(extensionRoot, versionFolder);
        const manifest = await smallJson(join(path, "manifest.json"));
        if (!manifest || ![2, 3].includes(Number(manifest.manifest_version)) || typeof manifest.version !== "string") continue;
        const name = await extensionName(path, manifest);
        if (name) result.push({ chromeId, name, version: manifest.version, profile, path });
        break;
      }
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.profile.localeCompare(b.profile));
}
