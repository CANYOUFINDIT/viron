import { describe, expect, it } from "vitest";
import type { ClientInstallerInformation } from "../src/shared/client-installer";
import {
  clientPlatformLabel,
  detectClientPlatform,
  recommendedClientInstaller,
} from "../src/client/client-platform-detection";

const installers: ClientInstallerInformation[] = [
  { fileName: "mac-arm.dmg", platform: "macos", architecture: "arm64", version: "1.0.0", size: 1, downloadUrl: "/mac-arm" },
  { fileName: "mac-intel.dmg", platform: "macos", architecture: "x64", version: "1.0.0", size: 1, downloadUrl: "/mac-intel" },
  { fileName: "win-x86.exe", platform: "windows", architecture: "x86", version: "1.0.0", size: 1, downloadUrl: "/win-x86" },
  { fileName: "win-x64.exe", platform: "windows", architecture: "x64", version: "1.0.0", size: 1, downloadUrl: "/win-x64" },
];

describe("client platform detection", () => {
  it("detects Apple Silicon from Chromium client hints", async () => {
    const detection = await detectClientPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      userAgentData: {
        platform: "macOS",
        getHighEntropyValues: async () => ({ platform: "macOS", architecture: "arm", bitness: "64" }),
      },
    });

    expect(detection).toEqual({ platform: "macos", architecture: "arm64", confidence: "exact" });
    expect(clientPlatformLabel(detection)).toBe("macOS · Apple Silicon");
    expect(recommendedClientInstaller(installers, detection)?.fileName).toBe("mac-arm.dmg");
  });

  it("detects 64-bit Windows from Chromium client hints", async () => {
    const detection = await detectClientPlatform({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      platform: "Win32",
      userAgentData: {
        platform: "Windows",
        getHighEntropyValues: async () => ({ platform: "Windows", architecture: "x86", bitness: "64" }),
      },
    });

    expect(detection).toEqual({ platform: "windows", architecture: "x64", confidence: "exact" });
    expect(recommendedClientInstaller(installers, detection)?.fileName).toBe("win-x64.exe");
  });

  it.each([
    ["x86", "32", "x86"],
    ["arm", "64", "arm64"],
  ] as const)("maps Windows %s/%s client hints to %s", async (architecture, bitness, expected) => {
    const detection = await detectClientPlatform({
      userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      platform: "Win32",
      userAgentData: {
        platform: "Windows",
        getHighEntropyValues: async () => ({ platform: "Windows", architecture, bitness }),
      },
    });

    expect(detection).toEqual({ platform: "windows", architecture: expected, confidence: "exact" });
  });

  it("uses the Windows user agent fallback when client hints are unavailable", async () => {
    const detection = await detectClientPlatform({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      platform: "Win32",
    });

    expect(detection).toEqual({ platform: "windows", architecture: "x64", confidence: "exact" });
  });

  it("does not guess the CPU architecture for macOS Safari", async () => {
    const detection = await detectClientPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.5 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });

    expect(detection).toEqual({ platform: "macos", architecture: null, confidence: "platform" });
    expect(recommendedClientInstaller(installers, detection)).toBeNull();
  });

  it("does not mistake an iPad reporting MacIntel for macOS", async () => {
    const detection = await detectClientPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });

    expect(detection).toEqual({ platform: null, architecture: null, confidence: "unknown" });
  });

  it("falls back only to a same-platform universal package", () => {
    const universal = { fileName: "mac-universal.dmg", platform: "macos", architecture: "universal", version: "1.0.0", size: 1, downloadUrl: "/mac-universal" } satisfies ClientInstallerInformation;
    expect(recommendedClientInstaller([...installers, universal], { platform: "macos", architecture: null, confidence: "platform" })).toBe(universal);
    expect(recommendedClientInstaller(installers, { platform: "macos", architecture: null, confidence: "platform" })).toBeNull();
  });
});
