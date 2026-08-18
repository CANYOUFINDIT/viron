import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const electron = vi.hoisted(() => ({
  BrowserWindow: class {},
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => "0.1.0"),
    getPath: vi.fn(() => "/tmp/viron-test"),
    getAppPath: vi.fn(() => "/tmp/viron-app"),
    getFileIcon: vi.fn(),
    quit: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
}));

vi.mock("electron", () => electron);
vi.mock("node:child_process", () => childProcess);

import {
  DesktopUpdater,
  downloadDesktopInstaller,
  installedVersionMatches,
  isInstallHelperAlive,
  launchMacosInstaller,
  launchWindowsInstaller,
  macosAppBundlePath,
  parseInstallStatus,
  resolveMacosUpdateTarget,
  shouldBlockLaunchForActiveUpdate,
  waitForInstallReady,
} from "../src/desktop/updater.js";

function versionResponse(version: string): Response {
  return Response.json({
    product: "viron",
    serverVersion: version,
    apiVersion: 2,
    apiProtocol: { min: 1, max: 2 },
    clients: {
      macos: {
        latestVersion: version,
        installers: {
          arm64: { available: true, version, downloadUrl: "/api/v1/desktop-installers/macos/arm64", fileName: `Viron-${version}.dmg`, size: 128 },
          x64: { available: false, version: null, downloadUrl: null, fileName: null, size: null },
        },
      },
      windows: {
        latestVersion: version,
        installers: {
          x86: { available: false, version: null, downloadUrl: null, fileName: null, size: null },
          x64: { available: false, version: null, downloadUrl: null, fileName: null, size: null },
          arm64: { available: false, version: null, downloadUrl: null, fileName: null, size: null },
        },
      },
    },
  });
}

describe("desktop updater checks", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    electron.app.isPackaged = true;
    electron.app.quit.mockClear();
    electron.dialog.showMessageBox.mockReset();
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    childProcess.spawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports when no newer installer is available", async () => {
    const updater = new DesktopUpdater({
      fetch: vi.fn(async () => versionResponse("0.1.0")),
      window: () => ({}) as Electron.BrowserWindow,
    });

    await expect(updater.check(true)).resolves.toBe("no-update");
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("does not claim the App is current when a newer matching installer is unavailable", async () => {
    const updater = new DesktopUpdater({
      fetch: vi.fn(async () => versionResponse("0.2.0")),
      window: () => ({}) as Electron.BrowserWindow,
    });

    const response = versionResponse("0.2.0");
    const payload = await response.json();
    payload.clients.macos.installers.arm64 = { available: false, version: null, downloadUrl: null, fileName: null, size: null };
    const unavailableUpdater = new DesktopUpdater({
      fetch: vi.fn(async () => Response.json(payload)),
      window: () => ({}) as Electron.BrowserWindow,
    });

    await expect(updater.check(true)).resolves.toBe("update-available");
    await expect(unavailableUpdater.check(true)).resolves.toBe("installer-unavailable");
  });

  it("lets a manual check reopen an update prompt suppressed for automatic checks", async () => {
    const updater = new DesktopUpdater({
      fetch: vi.fn(async () => versionResponse("0.2.0")),
      window: () => ({}) as Electron.BrowserWindow,
    });

    await expect(updater.check()).resolves.toBe("update-available");
    await expect(updater.check()).resolves.toBe("update-available");
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);

    await expect(updater.check(true)).resolves.toBe("update-available");
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("explains that development builds cannot update themselves", async () => {
    electron.app.isPackaged = false;
    const updater = new DesktopUpdater({
      fetch: vi.fn(async () => versionResponse("0.2.0")),
      window: () => ({}) as Electron.BrowserWindow,
    });

    await expect(updater.check(true)).resolves.toBe("development");
  });

  it("cancels an active installer download without showing a failure", async () => {
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const owner = { isDestroyed: vi.fn(() => false), setProgressBar: vi.fn() } as unknown as Electron.BrowserWindow;
    let fetchCount = 0;
    const fetch = vi.fn(async (_path: string, signal?: AbortSignal) => {
      fetchCount += 1;
      if (fetchCount === 1) return versionResponse("0.2.0");
      expect(signal?.aborted).toBe(true);
      throw new DOMException("The operation was aborted", "AbortError");
    });
    let cancelDownload = () => undefined;
    const progress = {
      open: vi.fn(async () => cancelDownload()),
      update: vi.fn(),
      close: vi.fn(),
    };
    const updater = new DesktopUpdater({
      fetch,
      window: () => owner,
      progressWindow: (_window, onCancel) => {
        cancelDownload = onCancel;
        return progress;
      },
    });
    const cleanup = vi.spyOn(updater, "cleanup").mockResolvedValue();

    await expect(updater.check(true)).resolves.toBe("update-available");

    expect(progress.open.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]);
    expect(progress.update).toHaveBeenCalledWith(expect.objectContaining({ phase: "cancelling", cancellable: false }));
    expect(progress.close).toHaveBeenCalled();
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it("writes installer bytes and reports exact download progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "viron-updater-test-"));
    const target = join(directory, "Viron-update.dmg");
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const updates: Array<[number, number]> = [];
    try {
      await downloadDesktopInstaller(
        new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
        target,
        bytes.byteLength,
        new AbortController().signal,
        (received, total) => updates.push([received, total]),
      );

      expect(new Uint8Array(await readFile(target))).toEqual(bytes);
      expect(updates.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not ask Electron to load the executable icon for the update window", async () => {
    const source = await readFile(join(import.meta.dirname, "../src/desktop/updater.ts"), "utf8");
    expect(source).not.toContain("app.getFileIcon");
  });

  it("replaces the macOS app only after the old process exits and rolls back failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "viron-macos-updater-test-"));
    const installerPath = join(directory, "Viron-update.dmg");
    const appleScriptPath = join(directory, "install-update.applescript");
    const scriptPath = join(directory, "install-update.sh");
    const privilegedScriptPath = join(directory, "install-privileged.sh");
    const targetApp = "/Applications/Viron Test.app";
    const logPath = join(directory, "update-install.log");
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn>; pid: number; kill: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    child.pid = 9876;
    child.kill = vi.fn();
    childProcess.spawn.mockReturnValue(child);
    try {
      const launch = launchMacosInstaller(installerPath, directory, "0.2.0", 4321, targetApp, logPath, {
        needsAdministrator: true,
        readyTimeoutMs: 1000,
      });
      await vi.waitFor(() => expect(childProcess.spawn).toHaveBeenCalledOnce());
      await writeFile(join(directory, "install-status"), "authorized\n");
      child.emit("spawn");
      await launch;

      const script = await readFile(scriptPath, "utf8");
      const privilegedScript = await readFile(privilegedScriptPath, "utf8");
      const appleScript = await readFile(appleScriptPath, "utf8");
      const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      actualChildProcess.execFileSync("/bin/sh", ["-n", scriptPath]);
      actualChildProcess.execFileSync("/bin/sh", ["-n", privilegedScriptPath]);
      actualChildProcess.execFileSync("/usr/bin/osacompile", ["-o", join(directory, "install-update.scpt"), appleScriptPath]);
      expect(script.indexOf("hdiutil attach")).toBeLessThan(script.indexOf("osascript \"$apple_script\""));
      expect(script.indexOf("osascript \"$apple_script\"")).toBeLessThan(script.indexOf("open -n \"$target_app\" --args --updated"));
      expect(privilegedScript.indexOf("write_status authorized")).toBeLessThan(privilegedScript.indexOf("kill -0 \"$parent_process_id\""));
      expect(privilegedScript.indexOf("kill -0 \"$parent_process_id\"")).toBeLessThan(privilegedScript.indexOf("pgrep -f \"$target_app/Contents/\""));
      expect(privilegedScript).toContain("[ \"$attempt\" -ge 150 ]");
      expect(privilegedScript).toContain("kill -9 \"$parent_process_id\"");
      expect(privilegedScript).toContain("pkill -9 -f \"$target_app/Contents/\"");
      expect(privilegedScript).toContain("actual_version=");
      expect(privilegedScript).toContain("staged app version $actual_version does not match $expected_version");
      expect(script).toContain("The previous version will reopen");
      expect(script).toContain("open -n \"$target_app\" --args --updated");
      expect(script).toContain("install-helper.pid");
      expect(script).toContain("needs_admin=$9");
      expect(appleScript).toContain("with administrator privileges");
      expect(privilegedScript).toContain("codesign --verify --deep --strict");
      expect(privilegedScript).toContain("CFBundleShortVersionString");
      expect(privilegedScript).toContain("backup_app=");
      expect(childProcess.spawn).toHaveBeenCalledWith("/bin/sh", [
        scriptPath,
        installerPath,
        appleScriptPath,
        privilegedScriptPath,
        "4321",
        targetApp,
        "0.2.0",
        logPath,
        directory,
        "1",
      ], { detached: true, stdio: "ignore" });
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds Windows shutdown, validates the installed version, and recovers failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "viron-windows-updater-test-"));
    const installerPath = join(directory, "Viron-update.exe");
    const executablePath = "C:\\Users\\tester\\AppData\\Local\\Programs\\viron\\Viron.exe";
    const logPath = join(directory, "update-install.log");
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn>; pid: number; kill: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    child.pid = 9876;
    child.kill = vi.fn();
    childProcess.spawn.mockReturnValue(child);
    try {
      const launch = launchWindowsInstaller(installerPath, directory, "0.2.0", 4321, executablePath, logPath, { readyTimeoutMs: 1000 });
      await vi.waitFor(() => expect(childProcess.spawn).toHaveBeenCalledOnce());
      await writeFile(join(directory, "install-status"), "authorized\n");
      child.emit("spawn");
      await launch;

      const script = await readFile(join(directory, "install-update.ps1"), "utf8");
      expect(script.indexOf("Write-UpdateStatus 'authorized'")).toBeLessThan(script.indexOf("Wait-Process -Timeout 30"));
      expect(script.indexOf("Wait-Process -Timeout 30")).toBeLessThan(script.indexOf("Start-Process -FilePath $Installer"));
      expect(script).toContain("Stop-Process -Id $ParentProcessId -Force");
      expect(script).toContain("$_.Path -ieq $Executable");
      expect(script).toContain("/D=$InstallDirectory");
      expect(script).not.toContain("--force-run");
      expect(script).toContain("if ($process.ExitCode -ne 0)");
      expect(script).toContain("VersionInfo.ProductVersion");
      expect(script).toContain("VersionMatches $installedVersion $ExpectedVersion");
      expect(script).toContain("The previous version will reopen");
      expect(script).toContain("Start-Process -FilePath $Executable -ArgumentList @('--updated')");
      expect(childProcess.spawn).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining([
        "-Installer", installerPath,
        "-ParentProcessId", "4321",
        "-Executable", executablePath,
        "-ExpectedVersion", "0.2.0",
        "-LogPath", logPath,
        "-StatusPath", join(directory, "install-status"),
        "-InstallDirectory", "C:\\Users\\tester\\AppData\\Local\\Programs\\viron",
      ]), { detached: true, stdio: "ignore" });
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("desktop updater target and status helpers", () => {
  it("keeps a single desktop instance and blocks relaunch during install", async () => {
    const main = await readFile(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
    expect(main).toContain("requestSingleInstanceLock");
    expect(main).toContain('--smoke-test") || app.requestSingleInstanceLock()');
    expect(main).toContain("shouldBlockLaunchForActiveUpdate");
    expect(main).toContain("正在安装更新");
  });

  it("replaces the running macOS app unless it is on a disk image or unwritable", () => {
    expect(macosAppBundlePath("/Users/me/Apps/Viron.app/Contents/MacOS/Viron")).toBe("/Users/me/Apps/Viron.app");
    expect(resolveMacosUpdateTarget("/Users/me/Apps/Viron.app", { writable: () => true }))
      .toBe("/Users/me/Apps/Viron.app");
    expect(resolveMacosUpdateTarget("/Volumes/Viron 0.1.6/Viron.app", { writable: () => false }))
      .toBe("/Applications/Viron.app");
    expect(resolveMacosUpdateTarget("/Applications/Viron.app", { writable: () => false }))
      .toBe("/Applications/Viron.app");
  });

  it("accepts Windows ProductVersion values that only add a trailing build number", () => {
    expect(installedVersionMatches("0.2.0", "0.2.0")).toBe(true);
    expect(installedVersionMatches("0.2.0.0", "0.2.0")).toBe(true);
    expect(installedVersionMatches("0.2.0+build.1", "0.2.0")).toBe(true);
    expect(installedVersionMatches("0.1.9", "0.2.0")).toBe(false);
    expect(installedVersionMatches("", "0.2.0")).toBe(false);
  });

  it("waits for the helper to authorize and surfaces helper failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "viron-update-status-"));
    const statusPath = join(directory, "install-status");
    try {
      const ready = waitForInstallReady(statusPath, 1000);
      await writeFile(statusPath, "authorized\n");
      await expect(ready).resolves.toBeUndefined();

      await writeFile(statusPath, "failed: user canceled administrator authorization\n");
      await expect(waitForInstallReady(statusPath, 1000)).rejects.toThrow("user canceled administrator authorization");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks relaunch only while an install helper is still active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "viron-update-block-"));
    try {
      expect(parseInstallStatus("authorized")).toEqual({ state: "authorized", detail: "", ageMs: 0 });
      await writeFile(join(directory, "install-status"), "authorized\n");
      await writeFile(join(directory, "install-helper.pid"), `${process.pid}\n`);
      await expect(isInstallHelperAlive(directory)).resolves.toBe(true);
      await expect(shouldBlockLaunchForActiveUpdate(directory)).resolves.toBe(true);

      await writeFile(join(directory, "install-status"), "failed: cancelled\n");
      await expect(shouldBlockLaunchForActiveUpdate(directory)).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
