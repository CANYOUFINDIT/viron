import { currentDesktopLanguage, translate as tr } from "./i18n.js";
import { accessSync, constants, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath, win32 } from "node:path";
import { execFile, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { app, BrowserWindow, dialog, nativeTheme } from "electron";
import {
  evaluateDesktopUpdate,
  type DesktopUpdateCheckResult,
  type DesktopUpdateInformation,
} from "../shared/desktop-release.js";

export const INSTALL_STATUS_FILE = "install-status";
export const INSTALL_HELPER_PID_FILE = "install-helper.pid";
const INSTALL_READY_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_INSTALL_STATUS_MS = 2 * 60 * 1000;

export type InstallStatusState = "authorized" | "installing" | "installed" | "failed";

export interface InstallStatus {
  state: InstallStatusState;
  detail: string;
  ageMs: number;
}

type DesktopUpdateProgressPhase = "downloading" | "cancelling" | "preparing" | "installing";

interface DesktopUpdateProgressState {
  language: import("../shared/i18n.js").Language;
  phase: DesktopUpdateProgressPhase;
  platform: NodeJS.Platform;
  received: number;
  total: number;
  version: string;
  cancellable: boolean;
}

interface DesktopUpdateProgressWindow {
  open(state: DesktopUpdateProgressState): Promise<void>;
  update(state: DesktopUpdateProgressState): void;
  close(): void;
}

interface DesktopUpdaterOptions {
  fetch: (path: string, signal?: AbortSignal) => Promise<Response>;
  window: () => BrowserWindow | null;
  progressWindow?: (owner: BrowserWindow, onCancel: () => void) => DesktopUpdateProgressWindow;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || stdout.trim() || error.message, { cause: error }));
      else resolve({ stdout, stderr });
    });
  });
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.removeListener("error", reject);
      child.unref();
      resolve();
    });
  });
}

function pathWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function desktopUpdateDirectory(userData = app.getPath("userData")): string {
  return join(userData, "updates");
}

export function macosAppBundlePath(execPath: string): string {
  const macosDir = dirname(execPath);
  const contentsDir = dirname(macosDir);
  return basename(macosDir) === "MacOS" && basename(contentsDir) === "Contents"
    ? dirname(contentsDir)
    : dirname(execPath);
}

export function resolveMacosUpdateTarget(
  bundlePath: string,
  options: { defaultTarget?: string; writable?: (path: string) => boolean } = {},
): string {
  const defaultTarget = options.defaultTarget ?? "/Applications/Viron.app";
  const writable = options.writable ?? pathWritable;
  const resolved = resolvePath(bundlePath);
  if (resolved === "/" || resolved.startsWith("/Volumes/")) return defaultTarget;
  return writable(dirname(resolved)) ? resolved : defaultTarget;
}

export function macosTargetNeedsAdministrator(
  targetApp: string,
  writable: (path: string) => boolean = pathWritable,
): boolean {
  return !writable(dirname(targetApp));
}

export function windowsInstallDirectory(executablePath: string): string {
  return /^[A-Za-z]:[\\/]/.test(executablePath) || executablePath.includes("\\")
    ? win32.dirname(executablePath)
    : dirname(executablePath);
}

export function installedVersionMatches(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  const parts = (value: string) => value.trim().split(/[+\s-]/)[0]?.split(".").map((part) => Number(part)) ?? [];
  const actualParts = parts(actual);
  const expectedParts = parts(expected);
  return expectedParts.length >= 3
    && actualParts.length >= 3
    && actualParts[0] === expectedParts[0]
    && actualParts[1] === expectedParts[1]
    && actualParts[2] === expectedParts[2];
}

export function parseInstallStatus(value: string, ageMs = 0): InstallStatus | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "authorized" || trimmed === "installing" || trimmed === "installed") {
    return { state: trimmed, detail: "", ageMs };
  }
  if (trimmed.startsWith("failed:")) {
    return { state: "failed", detail: trimmed.slice("failed:".length).trim(), ageMs };
  }
  return null;
}

export async function readInstallStatus(updateDirectory: string): Promise<InstallStatus | null> {
  const statusPath = join(updateDirectory, INSTALL_STATUS_FILE);
  try {
    const [content, file] = await Promise.all([readFile(statusPath, "utf8"), stat(statusPath)]);
    return parseInstallStatus(content, Date.now() - file.mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function isInstallHelperAlive(updateDirectory: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(join(updateDirectory, INSTALL_HELPER_PID_FILE), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function shouldBlockLaunchForActiveUpdate(updateDirectory?: string): Promise<boolean> {
  const directory = updateDirectory ?? desktopUpdateDirectory();
  const status = await readInstallStatus(directory);
  if (!status || status.state === "installed" || status.state === "failed") return false;
  if (status.state !== "authorized" && status.state !== "installing") return false;
  return await isInstallHelperAlive(directory) || status.ageMs < STALE_INSTALL_STATUS_MS;
}

export async function waitForInstallReady(statusPath: string, timeoutMs = INSTALL_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = parseInstallStatus(await readFile(statusPath, "utf8"));
      if (status?.state === "authorized" || status?.state === "installing" || status?.state === "installed") return;
      if (status?.state === "failed") throw new Error(status.detail || tr("未能完成客户端更新"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(tr("更新安装准备超时，请重试"));
}

function stopInstallHelper(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

async function startInstallHelper(command: string, args: string[], statusPath: string, readyTimeoutMs = INSTALL_READY_TIMEOUT_MS): Promise<void> {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  await waitForSpawn(child);
  try {
    await waitForInstallReady(statusPath, readyTimeoutMs);
  } catch (error) {
    stopInstallHelper(child);
    throw error;
  }
}

export async function launchMacosInstaller(
  installerPath: string,
  updateDirectory: string,
  expectedVersion: string,
  parentProcessId = process.pid,
  targetApp = "/Applications/Viron.app",
  logPath = join(app.getPath("userData"), "update-install.log"),
  options: { needsAdministrator?: boolean; readyTimeoutMs?: number } = {},
): Promise<void> {
  const scriptPath = join(updateDirectory, "install-update.sh");
  const privilegedScriptPath = join(updateDirectory, "install-privileged.sh");
  const appleScriptPath = join(updateDirectory, "install-update.applescript");
  const statusPath = join(updateDirectory, INSTALL_STATUS_FILE);
  const needsAdministrator = options.needsAdministrator ?? macosTargetNeedsAdministrator(targetApp);
  await writeFile(appleScriptPath, [
    "on run argv",
    "  set cmd to \"/bin/sh\"",
    "  repeat with i from 1 to count of argv",
    "    set cmd to cmd & \" \" & quoted form of (item i of argv)",
    "  end repeat",
    "  do shell script cmd with administrator privileges",
    "end run",
  ].join("\n"), "utf8");
  await writeFile(privilegedScriptPath, [
    "#!/bin/sh",
    "set -u",
    "source_app=$1",
    "target_app=$2",
    "staging_app=$3",
    "backup_app=$4",
    "expected_version=$5",
    "status_path=$6",
    "parent_process_id=$7",
    "log_path=$8",
    "write_log() { /usr/bin/printf '%s %s\\n' \"$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')\" \"$1\" >> \"$log_path\"; }",
    "write_status() { /usr/bin/printf '%s\\n' \"$1\" > \"$status_path\"; }",
    "fail() { write_status \"failed: $1\"; write_log \"failed: $1\"; exit 1; }",
    "write_status authorized",
    "write_log \"waiting for Viron process $parent_process_id to exit\"",
    "attempt=0",
    "while /bin/kill -0 \"$parent_process_id\" 2>/dev/null; do",
    "  if [ \"$attempt\" -ge 150 ]; then",
    "    write_log \"graceful shutdown timed out; terminating old Viron process\"",
    "    /bin/kill \"$parent_process_id\" 2>/dev/null || true",
    "    /bin/sleep 2",
    "    /bin/kill -9 \"$parent_process_id\" 2>/dev/null || true",
    "    break",
    "  fi",
    "  /bin/sleep 0.2",
    "  attempt=$((attempt + 1))",
    "done",
    "write_log \"old Viron process stopped\"",
    "attempt=0",
    "while /usr/bin/pgrep -f \"$target_app/Contents/\" >/dev/null 2>&1; do",
    "  if [ \"$attempt\" -ge 150 ]; then",
    "    write_log \"remaining Viron processes still running; forcing exit\"",
    "    /usr/bin/pkill -f \"$target_app/Contents/\" 2>/dev/null || true",
    "    /bin/sleep 1",
    "    /usr/bin/pkill -9 -f \"$target_app/Contents/\" 2>/dev/null || true",
    "    break",
    "  fi",
    "  /bin/sleep 0.2",
    "  attempt=$((attempt + 1))",
    "done",
    "write_log \"installing Viron $expected_version\"",
    "/bin/rm -rf \"$staging_app\" \"$backup_app\" || fail \"could not clear staging files\"",
    "/usr/bin/ditto \"$source_app\" \"$staging_app\" || fail \"could not stage replacement app\"",
    "/usr/bin/codesign --verify --deep --strict \"$staging_app\" >> \"$log_path\" 2>&1 || fail \"staged app signature verification failed\"",
    "actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \"$staging_app/Contents/Info.plist\" 2>> \"$log_path\") || fail \"could not read staged app version\"",
    "[ \"$actual_version\" = \"$expected_version\" ] || fail \"staged app version $actual_version does not match $expected_version\"",
    "if [ -e \"$target_app\" ]; then /bin/mv \"$target_app\" \"$backup_app\" || fail \"could not back up current app\"; fi",
    "if /bin/mv \"$staging_app\" \"$target_app\" && /usr/bin/codesign --verify --deep --strict \"$target_app\" >> \"$log_path\" 2>&1 && test \"$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \"$target_app/Contents/Info.plist\")\" = \"$expected_version\"; then",
    "  /bin/rm -rf \"$backup_app\"",
    "  write_status installed",
    "  write_log \"installed Viron $expected_version\"",
    "else",
    "  /bin/rm -rf \"$target_app\"",
    "  if [ -e \"$backup_app\" ]; then /bin/mv \"$backup_app\" \"$target_app\"; fi",
    "  fail \"could not replace the running Viron app\"",
    "fi",
  ].join("\n"), "utf8");
  await writeFile(scriptPath, [
    "#!/bin/sh",
    "set -u",
    "installer=$1",
    "apple_script=$2",
    "privileged_script=$3",
    "parent_process_id=$4",
    "target_app=$5",
    "expected_version=$6",
    "log_path=$7",
    "update_directory=$8",
    "needs_admin=$9",
    "status_path=$update_directory/install-status",
    "mount_point=",
    "staging_app=$(dirname \"$target_app\")/.Viron-update.app",
    "backup_app=$(dirname \"$target_app\")/.Viron-backup.app",
    "write_log() { /usr/bin/printf '%s %s\\n' \"$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')\" \"$1\" >> \"$log_path\"; }",
    "write_status() { /usr/bin/printf '%s\\n' \"$1\" > \"$status_path\"; }",
    "cleanup() {",
    "  if [ -n \"$mount_point\" ]; then /usr/bin/hdiutil detach \"$mount_point\" >> \"$log_path\" 2>&1 || /usr/bin/hdiutil detach -force \"$mount_point\" >> \"$log_path\" 2>&1; fi",
    "  /bin/rm -f \"$installer\" \"$apple_script\" \"$privileged_script\" \"$0\" \"$update_directory/install-helper.pid\"",
    "}",
    "fail() {",
    "  write_status \"failed: $1\"",
    "  write_log \"failed: $1\"",
    "  cleanup",
    "  if ! /bin/kill -0 \"$parent_process_id\" 2>/dev/null; then",
    "    /usr/bin/osascript -e \"display alert \\\"Viron update failed\\\" message \\\"$1. The previous version will reopen. See update-install.log for details.\\\" as critical\" >/dev/null 2>&1 || true",
    "    if [ -d \"$target_app\" ]; then /usr/bin/open -n \"$target_app\"; fi",
    "  fi",
    "  exit 1",
    "}",
    "/usr/bin/printf '%s\\n' \"$$\" > \"$update_directory/install-helper.pid\"",
    ": > \"$log_path\"",
    "write_log \"verifying installer for $target_app\"",
    "attach_output=$(/usr/bin/hdiutil attach -readonly -nobrowse \"$installer\" 2>> \"$log_path\") || fail \"could not attach installer\"",
    "mount_point=$(printf '%s\\n' \"$attach_output\" | /usr/bin/awk -F '\\t' '$NF ~ /^\\/Volumes\\// { print $NF; exit }')",
    "[ -n \"$mount_point\" ] || fail \"could not identify installer mount point\"",
    "source_app=$mount_point/Viron.app",
    "[ -d \"$source_app\" ] || fail \"installer does not contain Viron.app\"",
    "/usr/bin/codesign --verify --deep --strict \"$source_app\" >> \"$log_path\" 2>&1 || fail \"installer signature verification failed\"",
    "actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \"$source_app/Contents/Info.plist\" 2>> \"$log_path\") || fail \"could not read installer version\"",
    "[ \"$actual_version\" = \"$expected_version\" ] || fail \"installer version $actual_version does not match $expected_version\"",
    "write_log \"installer verified; requesting replacement of $target_app\"",
    "if [ \"$needs_admin\" = 1 ]; then",
    "  /usr/bin/osascript \"$apple_script\" \"$privileged_script\" \"$source_app\" \"$target_app\" \"$staging_app\" \"$backup_app\" \"$expected_version\" \"$status_path\" \"$parent_process_id\" \"$log_path\" >> \"$log_path\" 2>&1 || fail \"system authorization was cancelled or the privileged install failed\"",
    "else",
    "  /bin/sh \"$privileged_script\" \"$source_app\" \"$target_app\" \"$staging_app\" \"$backup_app\" \"$expected_version\" \"$status_path\" \"$parent_process_id\" \"$log_path\" >> \"$log_path\" 2>&1 || fail \"could not replace the running Viron app\"",
    "fi",
    "write_log \"installed Viron $expected_version\"",
    "cleanup",
    "/usr/bin/open -n \"$target_app\" --args --updated",
  ].join("\n"), "utf8");
  await startInstallHelper("/bin/sh", [
    scriptPath,
    installerPath,
    appleScriptPath,
    privilegedScriptPath,
    String(parentProcessId),
    targetApp,
    expectedVersion,
    logPath,
    updateDirectory,
    needsAdministrator ? "1" : "0",
  ], statusPath, options.readyTimeoutMs);
}

export async function launchWindowsInstaller(
  installerPath: string,
  updateDirectory: string,
  expectedVersion: string,
  parentProcessId = process.pid,
  executablePath = process.execPath,
  logPath = join(app.getPath("userData"), "update-install.log"),
  options: { readyTimeoutMs?: number } = {},
): Promise<void> {
  const scriptPath = join(updateDirectory, "install-update.ps1");
  const statusPath = join(updateDirectory, INSTALL_STATUS_FILE);
  const helperPidPath = join(updateDirectory, INSTALL_HELPER_PID_FILE);
  const installDirectory = windowsInstallDirectory(executablePath);
  await writeFile(scriptPath, [
    "param([string]$Installer, [int]$ParentProcessId, [string]$Executable, [string]$ExpectedVersion, [string]$LogPath, [string]$StatusPath, [string]$HelperPidPath, [string]$InstallDirectory)",
    "$ErrorActionPreference = 'Stop'",
    "function Write-UpdateLog([string]$Message) { Add-Content -LiteralPath $LogPath -Value \"$([DateTime]::UtcNow.ToString('o')) $Message\" -Encoding UTF8 }",
    "function Write-UpdateStatus([string]$Status) { Set-Content -LiteralPath $StatusPath -Value $Status -Encoding UTF8 }",
    "function VersionMatches([string]$Actual, [string]$Expected) {",
    "  $actualParts = @(($Actual -split '[+\\s-]')[0] -split '\\.')",
    "  $expectedParts = @(($Expected -split '[+\\s-]')[0] -split '\\.')",
    "  return ($actualParts.Length -ge 3) -and ($expectedParts.Length -ge 3) -and ($actualParts[0] -eq $expectedParts[0]) -and ($actualParts[1] -eq $expectedParts[1]) -and ($actualParts[2] -eq $expectedParts[2])",
    "}",
    "Set-Content -LiteralPath $HelperPidPath -Value $PID -Encoding UTF8",
    "Write-UpdateStatus 'authorized'",
    "Set-Content -LiteralPath $LogPath -Value \"$([DateTime]::UtcNow.ToString('o')) waiting for Viron process $ParentProcessId to exit\" -Encoding UTF8",
    "try {",
    "  $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue",
    "  if ($null -ne $parent) {",
    "    try { $parent | Wait-Process -Timeout 30 -ErrorAction Stop }",
    "    catch {",
    "      Write-UpdateLog 'graceful shutdown timed out; terminating old Viron process'",
    "      Stop-Process -Id $ParentProcessId -Force -ErrorAction SilentlyContinue",
    "      Wait-Process -Id $ParentProcessId -ErrorAction SilentlyContinue",
    "    }",
    "  }",
    "  Write-UpdateLog 'old Viron process stopped'",
    "  $waited = 0",
    "  while ($waited -lt 30) {",
    "    $remaining = @(Get-Process | Where-Object { $_.Path -and ($_.Path -ieq $Executable) })",
    "    if ($remaining.Count -eq 0) { break }",
    "    Start-Sleep -Milliseconds 200",
    "    $waited += 0.2",
    "  }",
    "  $remaining = @(Get-Process | Where-Object { $_.Path -and ($_.Path -ieq $Executable) })",
    "  if ($remaining.Count -gt 0) {",
    "    Write-UpdateLog 'remaining Viron processes still running; forcing exit'",
    "    $remaining | Stop-Process -Force -ErrorAction SilentlyContinue",
    "    Start-Sleep -Seconds 1",
    "  }",
    "  $argumentList = @('/S', \"/D=$InstallDirectory\")",
    "  $process = Start-Process -FilePath $Installer -ArgumentList $argumentList -PassThru -Wait",
    "  if ($process.ExitCode -ne 0) { throw \"Viron installer exited with code $($process.ExitCode)\" }",
    "  $installedVersion = (Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion",
    "  if (-not (VersionMatches $installedVersion $ExpectedVersion)) { throw \"Installed Viron version $installedVersion does not match $ExpectedVersion\" }",
    "  Write-UpdateStatus 'installed'",
    "  Write-UpdateLog \"installed Viron $ExpectedVersion\"",
    "  Start-Process -FilePath $Executable -ArgumentList @('--updated')",
    "} catch {",
    "  Write-UpdateStatus \"failed: $($_.Exception.Message)\"",
    "  Write-UpdateLog \"failed: $($_.Exception.Message)\"",
    "  $parentStillRunning = $null -ne (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)",
    "  if (-not $parentStillRunning) {",
    "    try { (New-Object -ComObject WScript.Shell).Popup(\"$($_.Exception.Message)`nThe previous version will reopen. See update-install.log for details.\", 0, 'Viron update failed', 16) | Out-Null } catch {}",
    "    if (Test-Path -LiteralPath $Executable) { Start-Process -FilePath $Executable }",
    "  }",
    "  exit 1",
    "} finally {",
    "  Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $HelperPidPath -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue",
    "}",
  ].join("\r\n"), "utf8");
  await startInstallHelper("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Installer", installerPath,
    "-ParentProcessId", String(parentProcessId),
    "-Executable", executablePath,
    "-ExpectedVersion", expectedVersion,
    "-LogPath", logPath,
    "-StatusPath", statusPath,
    "-HelperPidPath", helperPidPath,
    "-InstallDirectory", installDirectory,
  ], statusPath, options.readyTimeoutMs);
}

class ElectronUpdateProgressWindow implements DesktopUpdateProgressWindow {
  private readonly window: BrowserWindow;
  private state: DesktopUpdateProgressState | null = null;
  private loaded = false;
  private allowClose = false;

  constructor(owner: BrowserWindow, private readonly onCancel: () => void) {
    const root = app.getAppPath();
    this.window = new BrowserWindow({
      parent: owner,
      width: 440,
      height: 184,
      show: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1719" : "#f7f7f7",
      title: tr("正在更新 Viron"),
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      webPreferences: {
        preload: join(root, "dist", "desktop", "update-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.window.setMenuBarVisibility(false);
    this.window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event, url) => {
      if (url !== this.window.webContents.getURL()) event.preventDefault();
    });
    this.window.webContents.on("ipc-message", (_event, channel) => {
      if (channel === "viron:update-window:cancel" && this.state?.cancellable) this.onCancel();
    });
    this.window.on("close", (event) => {
      if (this.allowClose) return;
      event.preventDefault();
      if (this.state?.cancellable) this.onCancel();
    });
    this.window.on("closed", () => {
      this.loaded = false;
    });
  }

  async open(state: DesktopUpdateProgressState): Promise<void> {
    this.state = state;
    await this.window.loadFile(join(app.getAppPath(), "dist", "desktop-renderer", "desktop-update.html"));
    if (this.window.isDestroyed()) return;
    this.loaded = true;
    this.publish();
    this.window.show();
  }

  update(state: DesktopUpdateProgressState): void {
    this.state = state;
    this.publish();
  }

  close(): void {
    if (this.window.isDestroyed()) return;
    this.allowClose = true;
    this.window.close();
  }

  private publish(): void {
    if (!this.loaded || !this.state || this.window.isDestroyed()) return;
    this.window.webContents.send("viron:update-window:state", this.state);
  }
}

export async function downloadDesktopInstaller(
  response: Response,
  targetPath: string,
  expectedSize: number,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  if (!response.ok || !response.body) throw new Error(tr("安装包下载失败（HTTP {{0}}）", [response.status]));
  const responseSize = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(responseSize) && responseSize > 0 && responseSize !== expectedSize) {
    throw new Error(tr("安装包在下载前发生变化，请稍后重试"));
  }
  let received = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      onProgress(received, expectedSize);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    progress,
    createWriteStream(targetPath, { mode: 0o600 }),
    { signal },
  );
  const downloadedSize = (await stat(targetPath)).size;
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  if (downloadedSize !== expectedSize) throw new Error(tr("安装包下载不完整，请重试"));
}

export class DesktopUpdater {
  private readonly prompted = new Set<string>();
  private checking = false;
  private installing = false;

  constructor(private readonly options: DesktopUpdaterOptions) {}

  private updateDirectory(): string {
    return join(app.getPath("userData"), "updates");
  }

  async cleanup(): Promise<void> {
    if (await shouldBlockLaunchForActiveUpdate(this.updateDirectory())) return;
    await rm(this.updateDirectory(), { recursive: true, force: true }).catch(() => undefined);
  }

  async check(manual = false): Promise<DesktopUpdateCheckResult> {
    if (!app.isPackaged || process.argv.includes("--smoke-test")) return "development";
    if (this.checking || this.installing) return "busy";
    this.checking = true;
    try {
      const response = await this.options.fetch("/api/v1/version");
      if (!response.ok) throw new Error(tr("检测更新失败（HTTP {{0}}）", [response.status]));
      const selection = evaluateDesktopUpdate(await response.json(), app.getVersion(), process.platform, process.arch);
      if (selection.status !== "update-available") return selection.status;
      const update = selection.update;
      const promptKey = `${update.platform}:${update.architecture}:${update.latestVersion}`;
      if (!manual && this.prompted.has(promptKey)) return "update-available";
      this.prompted.add(promptKey);
      const owner = this.options.window();
      if (!owner) return "update-available";
      const choice = await dialog.showMessageBox(owner, {
        type: "info",
        title: tr("Viron 客户端更新"),
        message: tr("发现 Viron {{0}}", [update.latestVersion]),
        detail: tr("当前版本为 {{0}}。下载过程中可以取消；进入校验与安装后将关闭当前连接，完成后 Viron 会自动重新启动。", [update.currentVersion]),
        buttons: [tr("下载并安装"), tr("稍后")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (choice.response === 0) await this.downloadAndInstall(update);
      return "update-available";
    } finally {
      this.checking = false;
    }
  }

  private async downloadAndInstall(update: DesktopUpdateInformation): Promise<void> {
    const owner = this.options.window();
    if (!owner || this.installing) return;
    this.installing = true;
    const updateDirectory = this.updateDirectory();
    const installerPath = join(updateDirectory, update.platform === "macos" ? "Viron-update.dmg" : "Viron-update.exe");
    const abortController = new AbortController();
    let cancelled = false;
    let cancellable = true;
    let receivedBytes = 0;
    let progressWindow: DesktopUpdateProgressWindow | null = null;
    const setOwnerProgress = (progress: number) => {
      if (!owner.isDestroyed()) owner.setProgressBar(progress);
    };
    const progressState = (
      phase: DesktopUpdateProgressPhase,
      received: number,
      canCancel: boolean,
    ): DesktopUpdateProgressState => ({
      language: currentDesktopLanguage(),
      phase,
      platform: process.platform,
      received,
      total: update.size,
      version: update.latestVersion,
      cancellable: canCancel,
    });
    const cancel = () => {
      if (!cancellable || abortController.signal.aborted) return;
      cancelled = true;
      cancellable = false;
      progressWindow?.update(progressState("cancelling", receivedBytes, false));
      abortController.abort();
    };
    progressWindow = this.options.progressWindow?.(owner, cancel) ?? new ElectronUpdateProgressWindow(owner, cancel);
    setOwnerProgress(0);
    try {
      await progressWindow.open(progressState("downloading", 0, true));
      await this.cleanup();
      await mkdir(updateDirectory, { recursive: true });
      const response = await this.options.fetch(update.downloadUrl, abortController.signal);
      await downloadDesktopInstaller(response, installerPath, update.size, abortController.signal, (received, total) => {
        receivedBytes = received;
        setOwnerProgress(Math.min(received / total, 1));
        progressWindow?.update(progressState("downloading", received, true));
      });
      cancellable = false;
      setOwnerProgress(2);
      progressWindow.update(progressState("preparing", update.size, false));
      if (update.platform === "macos") {
        await run("/usr/bin/hdiutil", ["verify", installerPath]);
        progressWindow.update(progressState("installing", update.size, false));
        const targetApp = resolveMacosUpdateTarget(macosAppBundlePath(process.execPath));
        await launchMacosInstaller(installerPath, updateDirectory, update.latestVersion, process.pid, targetApp);
      } else {
        progressWindow.update(progressState("installing", update.size, false));
        await launchWindowsInstaller(installerPath, updateDirectory, update.latestVersion, process.pid, process.execPath);
      }
      setOwnerProgress(-1);
      progressWindow.close();
      app.quit();
    } catch (error) {
      setOwnerProgress(-1);
      if (!(await shouldBlockLaunchForActiveUpdate(updateDirectory))) await this.cleanup();
      progressWindow.close();
      if (!cancelled) {
        await dialog.showMessageBox(owner, {
          type: "error",
          title: tr("Viron 更新失败"),
          message: tr("未能完成客户端更新"),
          detail: error instanceof Error ? error.message : String(error),
          buttons: [tr("知道了")],
        });
      }
    } finally {
      progressWindow.close();
      this.installing = false;
    }
  }
}
