import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentDesktopPackageCommand } from "../scripts/package-current-os.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("current OS desktop packaging", () => {
  it("maps the current machine to the matching desktop installer script", () => {
    expect(currentDesktopPackageCommand("darwin", "arm64")).toEqual({
      command: "bash",
      args: ["scripts/package-macos.sh", "--arch=arm64"],
    });
    expect(currentDesktopPackageCommand("darwin", "x64")).toEqual({
      command: "bash",
      args: ["scripts/package-macos.sh", "--arch=x64"],
    });
    expect(currentDesktopPackageCommand("win32", "x64")).toEqual({
      command: process.execPath,
      args: ["scripts/package-windows.mjs", "--arch=x64"],
    });
    expect(currentDesktopPackageCommand("win32", "arm64")).toEqual({
      command: process.execPath,
      args: ["scripts/package-windows.mjs", "--arch=arm64"],
    });
    expect(currentDesktopPackageCommand("win32", "ia32")).toEqual({
      command: process.execPath,
      args: ["scripts/package-windows.mjs", "--arch=ia32"],
    });
    expect(currentDesktopPackageCommand("linux", "x64")).toBeNull();
  });

  it("exposes an npm script for agents to package the current OS after each task", () => {
    expect(packageJson.scripts["package:current-os"]).toBe("node scripts/package-current-os.mjs");
  });
});
