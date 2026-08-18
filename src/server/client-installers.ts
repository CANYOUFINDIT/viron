import { lstat, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  ClientInstallerArchitecture,
  ClientInstallerInformation,
  ClientInstallerPlatform,
} from "../shared/client-installer.js";
import { PRODUCT_VERSION } from "./product-info.js";

const installerFormats: Record<string, { platform: ClientInstallerPlatform; contentType: string }> = {
  ".dmg": { platform: "macos", contentType: "application/x-apple-diskimage" },
  ".exe": { platform: "windows", contentType: "application/vnd.microsoft.portable-executable" },
};

const platformOrder: Record<ClientInstallerPlatform, number> = { windows: 0, macos: 1 };
const architectureOrder: Record<ClientInstallerArchitecture, number> = {
  arm64: 0,
  x64: 1,
  x86: 2,
  universal: 3,
};

export interface PublishedClientInstaller {
  information: ClientInstallerInformation & {
    architecture: ClientInstallerArchitecture;
    version: string;
  };
  filePath: string;
  contentType: string;
  modifiedAt: number;
}

function architectureFromFileName(fileName: string): ClientInstallerArchitecture | null {
  const tokens = fileName.toLowerCase().split(/[-_.]+/);
  if (tokens.some((token) => token === "arm64" || token === "aarch64")) return "arm64";
  if (tokens.some((token) => token === "x64" || token === "amd64")) return "x64";
  if (tokens.some((token) => token === "x86" || token === "ia32" || token === "i386")) return "x86";
  if (tokens.includes("universal")) return "universal";
  return null;
}

function versionFromFileName(fileName: string): string | null {
  const escapedVersion = PRODUCT_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return fileName.match(new RegExp(`(?:^|[-_])v?(${escapedVersion})(?=[-_.]|$)`, "i"))?.[1] ?? null;
}

function newerInstaller(left: PublishedClientInstaller, right: PublishedClientInstaller): PublishedClientInstaller {
  if (left.modifiedAt !== right.modifiedAt) return left.modifiedAt > right.modifiedAt ? left : right;
  return left.information.fileName.localeCompare(right.information.fileName, "zh-CN", { numeric: true }) >= 0 ? left : right;
}

export async function listPublishedClientInstallers(dataDir: string): Promise<PublishedClientInstaller[]> {
  const directory = join(dataDir, "installers");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const installers = await Promise.all(entries.map(async (entry): Promise<PublishedClientInstaller | null> => {
    if (!entry.isFile()) return null;
    const format = installerFormats[extname(entry.name).toLowerCase()];
    const architecture = architectureFromFileName(entry.name);
    const version = versionFromFileName(entry.name);
    if (!format || !architecture || version !== PRODUCT_VERSION) return null;
    const filePath = join(directory, entry.name);
    let file;
    try {
      file = await lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!file.isFile() || file.size <= 0) return null;
    return {
      information: {
        fileName: entry.name,
        platform: format.platform,
        architecture,
        version,
        size: file.size,
        downloadUrl: `/api/v1/client-installers/${encodeURIComponent(entry.name)}/download`,
      },
      filePath,
      contentType: format.contentType,
      modifiedAt: file.mtimeMs,
    };
  }));

  const latestByTarget = new Map<string, PublishedClientInstaller>();
  for (const installer of installers) {
    if (!installer) continue;
    const target = `${installer.information.platform}:${installer.information.architecture}`;
    const current = latestByTarget.get(target);
    latestByTarget.set(target, current ? newerInstaller(current, installer) : installer);
  }

  return [...latestByTarget.values()].sort((left, right) =>
    platformOrder[left.information.platform] - platformOrder[right.information.platform]
      || architectureOrder[left.information.architecture] - architectureOrder[right.information.architecture]
      || left.information.fileName.localeCompare(right.information.fileName, "zh-CN", { numeric: true }));
}

export function findPublishedClientInstaller(
  installers: PublishedClientInstaller[],
  platform: ClientInstallerPlatform,
  architecture: Exclude<ClientInstallerArchitecture, "universal">,
): PublishedClientInstaller | null {
  return installers.find((installer) =>
    installer.information.platform === platform && installer.information.architecture === architecture)
    ?? installers.find((installer) =>
      installer.information.platform === platform && installer.information.architecture === "universal")
    ?? null;
}
