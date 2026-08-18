export interface DesktopInstallerInformation {
  available: boolean;
  version: string | null;
  downloadUrl: string | null;
  fileName: string | null;
  size: number | null;
}

export interface ProductVersionInformation {
  product: "viron";
  serverVersion: string;
  apiVersion: number;
  apiProtocol: { min: number; max: number };
  clients: {
    macos: {
      latestVersion: string;
      installers: {
        arm64: DesktopInstallerInformation;
        x64: DesktopInstallerInformation;
      };
    };
    windows: {
      latestVersion: string;
      installers: {
        x86: DesktopInstallerInformation;
        x64: DesktopInstallerInformation;
        arm64: DesktopInstallerInformation;
      };
    };
  };
}

export interface DesktopUpdateInformation {
  platform: "macos" | "windows";
  architecture: "arm64" | "x64" | "x86";
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  fileName: string;
  size: number;
}

export type DesktopUpdateCheckResult = "update-available" | "no-update" | "installer-unavailable" | "development" | "busy";

export type DesktopUpdateSelection =
  | { status: "update-available"; update: DesktopUpdateInformation }
  | { status: "no-update" }
  | { status: "installer-unavailable" };

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareProductVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) throw new Error("产品版本必须是有效的 SemVer");

  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const difference = parsedLeft.core[index] - parsedRight.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  if (!parsedLeft.prerelease.length || !parsedRight.prerelease.length) {
    return parsedLeft.prerelease.length === parsedRight.prerelease.length
      ? 0
      : parsedLeft.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length); index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function validInstaller(value: unknown): value is DesktopInstallerInformation & {
  available: true;
  downloadUrl: string;
  fileName: string;
  size: number;
} {
  if (!value || typeof value !== "object") return false;
  const installer = value as Partial<DesktopInstallerInformation>;
  return installer.available === true
    && typeof installer.downloadUrl === "string"
    && installer.downloadUrl.startsWith("/api/")
    && typeof installer.fileName === "string"
    && installer.fileName.length > 0
    && Number.isSafeInteger(installer.size)
    && installer.size! > 0;
}

export function evaluateDesktopUpdate(
  value: unknown,
  currentVersion: string,
  platform: NodeJS.Platform,
  architecture: string,
): DesktopUpdateSelection {
  if (!value || typeof value !== "object") return { status: "installer-unavailable" };
  const information = value as Partial<ProductVersionInformation>;
  if (information.product !== "viron" || !information.clients) return { status: "installer-unavailable" };

  let platformName: DesktopUpdateInformation["platform"];
  let architectureName: DesktopUpdateInformation["architecture"];
  let latestVersion: string;
  let installer: unknown;
  if (platform === "darwin" && (architecture === "arm64" || architecture === "x64")) {
    platformName = "macos";
    architectureName = architecture;
    latestVersion = information.clients.macos?.latestVersion;
    installer = information.clients.macos?.installers?.[architecture];
  } else if (platform === "win32" && (architecture === "ia32" || architecture === "x64" || architecture === "arm64")) {
    platformName = "windows";
    architectureName = architecture === "ia32" ? "x86" : architecture;
    latestVersion = information.clients.windows?.latestVersion;
    installer = information.clients.windows?.installers?.[architectureName];
  } else return { status: "installer-unavailable" };

  if (installer && typeof installer === "object" && typeof (installer as Partial<DesktopInstallerInformation>).version === "string") {
    latestVersion = (installer as Partial<DesktopInstallerInformation>).version!;
  }
  if (typeof latestVersion !== "string") return { status: "installer-unavailable" };
  try {
    if (compareProductVersions(latestVersion, currentVersion) <= 0) return { status: "no-update" };
  } catch {
    return { status: "installer-unavailable" };
  }
  if (!validInstaller(installer)) return { status: "installer-unavailable" };
  return {
    status: "update-available",
    update: {
      platform: platformName,
      architecture: architectureName,
      currentVersion,
      latestVersion,
      downloadUrl: installer.downloadUrl,
      fileName: installer.fileName,
      size: installer.size,
    },
  };
}

export function selectDesktopUpdate(
  value: unknown,
  currentVersion: string,
  platform: NodeJS.Platform,
  architecture: string,
): DesktopUpdateInformation | null {
  const selection = evaluateDesktopUpdate(value, currentVersion, platform, architecture);
  return selection.status === "update-available" ? selection.update : null;
}
