import { describe, expect, it } from "vitest";
import { compareProductVersions, evaluateDesktopUpdate, selectDesktopUpdate, type ProductVersionInformation } from "../src/shared/desktop-release.js";

function versionInformation(): ProductVersionInformation {
  const unavailable = { available: false, version: null, downloadUrl: null, fileName: null, size: null };
  return {
    product: "viron",
    serverVersion: "0.2.0",
    apiVersion: 2,
    apiProtocol: { min: 1, max: 2 },
    clients: {
      macos: {
        latestVersion: "0.2.0",
        installers: {
          arm64: { available: true, version: "0.2.0", downloadUrl: "/api/v1/desktop-installers/macos/arm64", fileName: "Viron-0.2.0.dmg", size: 128 },
          x64: unavailable,
        },
      },
      windows: {
        latestVersion: "0.2.0",
        installers: {
          x86: { available: true, version: "0.2.0", downloadUrl: "/api/v1/desktop-installers/windows/x86", fileName: "Viron-0.2.0.exe", size: 256 },
          x64: { available: true, version: "0.2.0", downloadUrl: "/api/v1/desktop-installers/windows/x64", fileName: "Viron-0.2.0-x64.exe", size: 384 },
          arm64: unavailable,
        },
      },
    },
  };
}

describe("desktop product releases", () => {
  it("compares release and prerelease SemVer values", () => {
    expect(compareProductVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareProductVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareProductVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareProductVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
    expect(() => compareProductVersions("latest", "1.0.0")).toThrow("SemVer");
  });

  it("selects only a newer installer matching the current platform and architecture", () => {
    const information = versionInformation();
    expect(selectDesktopUpdate(information, "0.1.0", "darwin", "arm64")).toMatchObject({
      platform: "macos",
      architecture: "arm64",
      latestVersion: "0.2.0",
      size: 128,
    });
    expect(selectDesktopUpdate(information, "0.1.0", "win32", "ia32")).toMatchObject({
      platform: "windows",
      architecture: "x86",
      size: 256,
    });
    expect(selectDesktopUpdate(information, "0.1.0", "win32", "x64")).toMatchObject({
      platform: "windows",
      architecture: "x64",
      size: 384,
    });
    expect(selectDesktopUpdate(information, "0.2.0", "darwin", "arm64")).toBeNull();
    expect(selectDesktopUpdate(information, "0.3.0", "darwin", "arm64")).toBeNull();
    expect(selectDesktopUpdate(information, "0.1.0", "darwin", "x64")).toBeNull();
    expect(evaluateDesktopUpdate(information, "0.1.0", "win32", "arm64")).toEqual({ status: "installer-unavailable" });
  });

  it("rejects malformed or external installer metadata", () => {
    const information = versionInformation();
    information.clients.macos.installers.arm64.downloadUrl = "https://malicious.example/update.dmg";
    expect(selectDesktopUpdate(information, "0.1.0", "darwin", "arm64")).toBeNull();
  });

  it("accepts legacy version responses that do not include installer-level versions", () => {
    const information = versionInformation();
    delete (information.clients.windows.installers.x86 as Partial<typeof information.clients.windows.installers.x86>).version;
    expect(selectDesktopUpdate(information, "0.1.0", "win32", "ia32")).toMatchObject({
      latestVersion: "0.2.0",
      architecture: "x86",
    });
  });
});
