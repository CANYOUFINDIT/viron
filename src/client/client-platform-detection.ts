import { translate as tr } from "./i18n";
import type {
  ClientInstallerArchitecture,
  ClientInstallerInformation,
  ClientInstallerPlatform,
} from "../shared/client-installer";

export type DetectedClientArchitecture = Exclude<ClientInstallerArchitecture, "universal">;

export interface ClientPlatformDetection {
  platform: ClientInstallerPlatform | null;
  architecture: DetectedClientArchitecture | null;
  confidence: "exact" | "platform" | "unknown";
}

interface UserAgentDataLike {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platform?: string;
    architecture?: string;
    bitness?: string;
  }>;
}

export interface BrowserEnvironment {
  userAgent: string;
  platform: string;
  maxTouchPoints?: number;
  userAgentData?: UserAgentDataLike;
}

function browserEnvironment(): BrowserEnvironment {
  if (typeof navigator === "undefined") return { userAgent: "", platform: "" };
  const userAgentData = (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgentData,
  };
}

function normalizePlatform(value: string, userAgent: string, legacyPlatform: string, maxTouchPoints: number): ClientInstallerPlatform | null {
  const combined = `${value} ${legacyPlatform} ${userAgent}`;
  if (maxTouchPoints > 1 && /Mac/i.test(`${value} ${legacyPlatform}`)) return null;
  if (/Windows|Win32|Win64/i.test(combined)) return "windows";
  if (/macOS|Macintosh|MacIntel|Mac OS X/i.test(combined)) return "macos";
  return null;
}

function normalizeArchitecture(architecture: string, bitness: string): DetectedClientArchitecture | null {
  const normalizedArchitecture = architecture.trim().toLowerCase();
  const normalizedBitness = bitness.trim();
  if (/arm64|aarch64/.test(normalizedArchitecture)) return "arm64";
  if (/^arm/.test(normalizedArchitecture)) return normalizedBitness === "64" ? "arm64" : null;
  if (/x86_64|x64|amd64/.test(normalizedArchitecture)) return "x64";
  if (/x86|i[3-6]86/.test(normalizedArchitecture)) return normalizedBitness === "64" ? "x64" : "x86";
  return null;
}

function fallbackArchitecture(platform: ClientInstallerPlatform | null, userAgent: string): DetectedClientArchitecture | null {
  if (/arm64|aarch64/i.test(userAgent)) return "arm64";
  if (platform !== "windows") return null;
  if (/Win64|WOW64|x64|amd64/i.test(userAgent)) return "x64";
  if (/Windows NT|Win32/i.test(userAgent)) return "x86";
  return null;
}

export async function detectClientPlatform(input?: BrowserEnvironment): Promise<ClientPlatformDetection> {
  const environment = input ?? browserEnvironment();
  let highEntropyValues: Awaited<ReturnType<NonNullable<UserAgentDataLike["getHighEntropyValues"]>>> = {};
  try {
    highEntropyValues = await environment.userAgentData?.getHighEntropyValues?.(["platform", "architecture", "bitness"]) ?? {};
  } catch {
    // Browsers may deny or omit high-entropy hints; the conservative fallback below remains available.
  }

  const platform = normalizePlatform(
    highEntropyValues.platform ?? environment.userAgentData?.platform ?? "",
    environment.userAgent,
    environment.platform,
    environment.maxTouchPoints ?? 0,
  );
  const architecture = normalizeArchitecture(
    highEntropyValues.architecture ?? "",
    highEntropyValues.bitness ?? "",
  ) ?? fallbackArchitecture(platform, environment.userAgent);

  return {
    platform,
    architecture: platform ? architecture : null,
    confidence: platform && architecture ? "exact" : platform ? "platform" : "unknown",
  };
}

export function recommendedClientInstaller(
  installers: ClientInstallerInformation[],
  detection: ClientPlatformDetection | null,
): ClientInstallerInformation | null {
  if (!detection?.platform) return null;
  const platformInstallers = installers.filter((installer) => installer.platform === detection.platform);
  if (detection.architecture) {
    const exact = platformInstallers.find((installer) => installer.architecture === detection.architecture);
    if (exact) return exact;
  }
  return platformInstallers.find((installer) => installer.architecture === "universal") ?? null;
}

export function clientPlatformLabel(detection: ClientPlatformDetection): string {
  if (detection.platform === "macos") {
    if (detection.architecture === "arm64") return "macOS · Apple Silicon";
    if (detection.architecture === "x64") return "macOS · Intel";
    return "macOS";
  }
  if (detection.platform === "windows") {
    if (detection.architecture === "arm64") return "Windows · ARM64";
    if (detection.architecture === "x64") return tr("Windows · 64 位");
    if (detection.architecture === "x86") return tr("Windows · 32 位");
    return "Windows";
  }
  return tr("未知系统");
}
