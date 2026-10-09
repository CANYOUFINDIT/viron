import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { currentDesktopPackageCommand, packageCurrentOs } from "../scripts/package-current-os.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("current OS desktop packaging", () => {
  it("packages Apple Silicon macOS and always targets x86 on Intel/AMD Windows", () => {
    expect(currentDesktopPackageCommand("darwin", "arm64")).toEqual({
      command: "bash",
      args: ["scripts/package-macos.sh", "--arch=arm64"],
    });
    expect(currentDesktopPackageCommand("win32", "x64")).toEqual({
      command: process.execPath,
      args: ["scripts/package-windows.mjs", "--arch=ia32"],
    });
    expect(currentDesktopPackageCommand("win32", "ia32")).toEqual({
      command: process.execPath,
      args: ["scripts/package-windows.mjs", "--arch=ia32"],
    });
  });

  it.each([
    ["darwin", "x64"],
    ["darwin", "ia32"],
    ["win32", "arm64"],
    ["win32", "unknown"],
    ["linux", "x64"],
    ["linux", "arm64"],
  ])("rejects unsupported build machines (%s %s) without starting a build", (platform, arch) => {
    expect(currentDesktopPackageCommand(platform, arch)).toBeNull();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(packageCurrentOs(platform, arch)).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Apple Silicon macOS arm64 和 Windows x86"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("exposes an npm script for agents to package the current OS after each task", () => {
    expect(packageJson.scripts["package:current-os"]).toBe("node scripts/package-current-os.mjs");
  });

  it("installs Electron once before the test suite to avoid parallel download races", () => {
    expect(packageJson.scripts.test.startsWith("node scripts/ensure-electron.mjs")).toBe(true);
    expect(packageJson.scripts["ensure-electron"]).toBe("node scripts/ensure-electron.mjs");
  });
});
