import { createHash } from "node:crypto";
import { join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { SFTPWrapper } from "ssh2";
import { z } from "zod";
import { quotePosixShellArg } from "../shared/environment-log.js";
import { PRODUCT_VERSION } from "./product-info.js";
import { executeSshCommand, executeSshCommandOnConnection } from "./ssh/command.js";
import { connectSsh, type ConnectedSsh } from "./ssh/connector.js";

export const DEFAULT_MONITOR_INSTALL_PATH = "/opt/viron/monitor";

const packageManifestSchema = z.object({
  product: z.literal("viron-monitor"),
  version: z.string().min(1).max(64),
  architecture: z.enum(["amd64", "arm64"]),
});

const installedManifestSchema = packageManifestSchema.extend({
  installPath: z.string().min(1).max(512),
  installedAt: z.string().min(1).max(64),
});

const packageFileNames = [
  "viron-monitor",
  "viron-monitor-collector",
  "viron-monitor.service",
  "viron-monitor.service.legacy",
  "THIRD_PARTY_NOTICES.md",
  "install.sh",
  "manifest.json",
] as const;

const uploadFileNames = [...packageFileNames, "SHA256SUMS"] as const;
const maximumPackageFileBytes = 64 * 1024 * 1024;
const preflightMarker = "VIRON_MONITOR_PREFLIGHT_V1";
const stagingPathPattern = /^\/tmp\/viron-monitor-install\.[A-Za-z0-9]+$/;

export function restartMonitorServiceCommand(): string {
  return [
    "command -v viron-monitor >/dev/null 2>&1 || exit 127",
    "if [ \"$(id -u)\" = 0 ]; then systemctl restart viron-monitor",
    "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n systemctl restart viron-monitor",
    "else exit 126",
    "fi",
  ].join("; ");
}

const monitorUninstallMarker = "VIRON_MONITOR_UNINSTALL_V1";

export function uninstallMonitorCommand(installPathValue: unknown, sshUsername: string): string {
  const installPath = normalizeMonitorInstallPath(installPathValue);
  const script = [
    "set -eu",
    `INSTALL_DIR=${quotePosixShellArg(installPath)}`,
    `SSH_USER=${quotePosixShellArg(sshUsername)}`,
    'INSTALL_MARKER="$INSTALL_DIR/.viron-monitor-install.json"',
    'SYSTEMD_UNIT="/etc/systemd/system/viron-monitor.service"',
    `printf '%s\\n' ${quotePosixShellArg(monitorUninstallMarker)}`,
    'if [ -L "$INSTALL_DIR" ] || [ ! -d "$INSTALL_DIR" ] || [ -L "$INSTALL_MARKER" ] || [ ! -f "$INSTALL_MARKER" ]; then echo "目标机安装清单已缺失或不匹配，拒绝自动卸载" >&2; exit 125; fi',
    'MARKER_CONTENT="$(tr -d \'[:space:]\' < "$INSTALL_MARKER")"',
    'case "$MARKER_CONTENT" in *\'"product":"viron-monitor"\'*) ;; *) echo "目标机安装清单已缺失或不匹配，拒绝自动卸载" >&2; exit 125 ;; esac',
    'case "$MARKER_CONTENT" in *\'"installPath":"\'"$INSTALL_DIR"\'"\'*) ;; *) echo "目标机安装清单已缺失或不匹配，拒绝自动卸载" >&2; exit 125 ;; esac',
    'if [ -e "$SYSTEMD_UNIT" ] || [ -L "$SYSTEMD_UNIT" ]; then if [ -L "$SYSTEMD_UNIT" ] || ! grep -Fq "Description=Viron host and service monitor" "$SYSTEMD_UNIT" || ! grep -Fq "ExecStart=/usr/local/bin/viron-monitor run" "$SYSTEMD_UNIT"; then echo "目标机监控文件已被其他内容占用，拒绝自动卸载" >&2; exit 124; fi; fi',
    'for ENTRY in viron-monitor viron-monitor-collector; do STABLE="/usr/local/bin/$ENTRY"; EXPECTED="$INSTALL_DIR/$ENTRY"; if [ -e "$STABLE" ] || [ -L "$STABLE" ]; then if [ ! -L "$STABLE" ] || [ "$(readlink -f "$STABLE" 2>/dev/null || true)" != "$EXPECTED" ]; then echo "目标机监控文件已被其他内容占用，拒绝自动卸载" >&2; exit 124; fi; fi; done',
    'if command -v systemctl >/dev/null 2>&1; then systemctl disable --now viron-monitor >/dev/null 2>&1 || systemctl stop viron-monitor >/dev/null 2>&1 || true; fi',
    'rm -f -- "$SYSTEMD_UNIT"',
    'for ENTRY in viron-monitor viron-monitor-collector; do rm -f -- "/usr/local/bin/$ENTRY"; done',
    'rm -rf -- "$INSTALL_DIR" /etc/viron-monitor /var/lib/viron-monitor /run/viron-monitor',
    'if id viron-monitor >/dev/null 2>&1; then userdel viron-monitor >/dev/null 2>&1 || true; fi',
    'if getent group viron-monitor >/dev/null 2>&1; then if id "$SSH_USER" >/dev/null 2>&1 && command -v gpasswd >/dev/null 2>&1; then gpasswd -d "$SSH_USER" viron-monitor >/dev/null 2>&1 || true; fi; GROUP_MEMBERS="$(getent group viron-monitor | cut -d: -f4)"; if [ -z "$GROUP_MEMBERS" ]; then groupdel viron-monitor >/dev/null 2>&1 || true; fi; fi',
    'if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; systemctl reset-failed viron-monitor >/dev/null 2>&1 || true; fi',
    'printf \'%s\\n\' \'{"ok":true,"localDataRemoved":true}\'',
  ].join("\n");
  const quotedScript = quotePosixShellArg(script);
  return [
    `if [ "$(id -u)" = 0 ]; then /bin/sh -c ${quotedScript}`,
    `elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n /bin/sh -c ${quotedScript}`,
    "else exit 126",
    "fi",
  ].join("; ");
}

export async function uninstallMonitor(
  app: FastifyInstance,
  connectionId: string,
  sshUsername: string,
  installPathValue: unknown,
): Promise<{ installPath: string; localDataRemoved: true; stdout: string }> {
  const installPath = normalizeMonitorInstallPath(installPathValue);
  const result = await executeSshCommand(app, connectionId, uninstallMonitorCommand(installPath, sshUsername), {
    timeoutMs: 120_000,
    maxBytes: 128 * 1024,
  });
  if (result.exitCode === 126) {
    throw new MonitorInstallError("MONITOR_UNINSTALL_PRIVILEGE_REQUIRED", "SSH 用户必须是 root 或具有免密 sudo 才能卸载监控探针", 422);
  }
  if (result.exitCode === 125) {
    throw new MonitorInstallError("MONITOR_UNINSTALL_NOT_MANAGED", "目标机安装清单已缺失或不匹配，拒绝自动卸载", 409);
  }
  if (result.exitCode === 124) {
    throw new MonitorInstallError("MONITOR_UNINSTALL_CONFLICT", "目标机监控文件已被其他内容占用，拒绝自动卸载", 409);
  }
  if (result.exitCode !== 0 || result.truncated) {
    throw new MonitorInstallError(
      "MONITOR_UNINSTALL_FAILED",
      (result.stderr.trim() || result.stdout.trim() || "监控探针卸载失败").slice(0, 1000),
    );
  }
  return { installPath, localDataRemoved: true, stdout: result.stdout.slice(0, 20_000) };
}

export type MonitorArchitecture = "amd64" | "arm64";
export type MonitorInstallPrivilege = "root" | "passwordless_sudo" | "unavailable";
export type MonitorInstallPathState = "available" | "upgrade" | "conflict" | "legacy";

export interface MonitorInstallIssue {
  code: string;
  message: string;
}

export interface MonitorInstallPreflight {
  defaultInstallPath: string;
  installPath: string;
  operatingSystem: string;
  machineArchitecture: string;
  architecture: MonitorArchitecture | null;
  systemdAvailable: boolean;
  privilege: MonitorInstallPrivilege;
  pathState: MonitorInstallPathState;
  existingMonitorPath: string;
  existingInstallation: z.infer<typeof installedManifestSchema> | null;
  packageVersion: string;
  packageAvailable: boolean;
  canInstall: boolean;
  issues: MonitorInstallIssue[];
}

export interface MonitorInstallProgressEvent {
  phase: "preflight" | "package_validation" | "ssh_connect" | "staging" | "upload" | "remote_install";
  progress: number;
  message: string;
}

export type MonitorInstallProgressReporter = (event: MonitorInstallProgressEvent) => Promise<void> | void;

interface MonitorPackageFile {
  name: typeof uploadFileNames[number];
  content: Buffer;
}

interface MonitorPackage {
  manifest: z.infer<typeof packageManifestSchema>;
  files: MonitorPackageFile[];
}

export class MonitorInstallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 502,
    public readonly preflight?: MonitorInstallPreflight,
  ) {
    super(message);
  }
}

export function normalizeMonitorInstallPath(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_MONITOR_INSTALL_PATH;
  if (raw.length > 512 || /[\0\r\n\s]/.test(raw) || !/^\/opt\/[A-Za-z0-9._/-]+$/.test(raw)) {
    throw new MonitorInstallError("INVALID_MONITOR_INSTALL_PATH", "安装目录必须是 /opt 下不含空格的绝对路径", 400);
  }
  const normalized = posix.normalize(raw).replace(/\/$/, "");
  if (normalized !== raw.replace(/\/$/, "") || normalized === "/opt" || !normalized.startsWith("/opt/")) {
    throw new MonitorInstallError("INVALID_MONITOR_INSTALL_PATH", "安装目录不能包含路径回退或指向 /opt 根目录", 400);
  }
  return normalized;
}

function architecture(value: string): MonitorArchitecture | null {
  if (["x86_64", "amd64"].includes(value)) return "amd64";
  if (["aarch64", "arm64"].includes(value)) return "arm64";
  return null;
}

function packageDirectory(app: FastifyInstance, target: MonitorArchitecture): string {
  const root = app.config.monitorPackageDir ? resolve(app.config.monitorPackageDir) : resolve("dist/monitor");
  return join(root, `linux-${target}`);
}

function parseChecksumFile(value: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of value.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?([A-Za-z0-9._-]+)$/i);
    if (match) checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

async function loadMonitorPackage(app: FastifyInstance, target: MonitorArchitecture): Promise<MonitorPackage> {
  const directory = packageDirectory(app, target);
  let manifest: z.infer<typeof packageManifestSchema>;
  let checksumContent: Buffer;
  try {
    manifest = packageManifestSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
    checksumContent = await readFile(join(directory, "SHA256SUMS"));
  } catch (error) {
    throw new MonitorInstallError("MONITOR_PACKAGE_UNAVAILABLE", `Viron 服务端缺少 ${target} 监控安装包`, 503, undefined);
  }
  if (manifest.architecture !== target || manifest.version !== PRODUCT_VERSION) {
    throw new MonitorInstallError("MONITOR_PACKAGE_VERSION_MISMATCH", `监控安装包必须与 Viron ${PRODUCT_VERSION} 版本一致`, 503);
  }
  const checksums = parseChecksumFile(checksumContent.toString("utf8"));
  const files: MonitorPackageFile[] = [];
  for (const name of packageFileNames) {
    const filePath = join(directory, name);
    let content: Buffer;
    try {
      const information = await stat(filePath);
      if (!information.isFile() || information.size <= 0 || information.size > maximumPackageFileBytes) throw new Error("invalid package file");
      content = await readFile(filePath);
    } catch {
      throw new MonitorInstallError("MONITOR_PACKAGE_INCOMPLETE", `监控安装包缺少有效文件：${name}`, 503);
    }
    const expected = checksums.get(name);
    const actual = createHash("sha256").update(content).digest("hex");
    if (!expected || expected !== actual) {
      throw new MonitorInstallError("MONITOR_PACKAGE_CHECKSUM_MISMATCH", `监控安装包校验失败：${name}`, 503);
    }
    files.push({ name, content });
  }
  files.push({ name: "SHA256SUMS", content: checksumContent });
  return { manifest, files };
}

function preflightCommand(installPath: string): string {
  const path = quotePosixShellArg(installPath);
  const marker = quotePosixShellArg(posix.join(installPath, ".viron-monitor-install.json"));
  return [
    "set -u",
    `printf '%s\\n' ${quotePosixShellArg(preflightMarker)}`,
    "printf 'kernel='; uname -s",
    "printf 'machine='; uname -m",
    "if command -v systemctl >/dev/null 2>&1; then printf 'systemd=1\\n'; else printf 'systemd=0\\n'; fi",
    "if [ \"$(id -u)\" = '0' ]; then printf 'privilege=root\\n'; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then printf 'privilege=passwordless_sudo\\n'; else printf 'privilege=unavailable\\n'; fi",
    `if [ -L ${path} ]; then printf 'path_kind=other\\npath_empty=0\\n'; elif [ ! -e ${path} ]; then printf 'path_kind=missing\\npath_empty=1\\n'; elif [ -d ${path} ]; then printf 'path_kind=directory\\n'; if find ${path} -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then printf 'path_empty=0\\n'; else printf 'path_empty=1\\n'; fi; else printf 'path_kind=other\\npath_empty=0\\n'; fi`,
    `if [ -f ${marker} ]; then printf 'manifest_base64='; base64 -w 0 ${marker} 2>/dev/null || true; printf '\\n'; fi`,
    "if command -v viron-monitor >/dev/null 2>&1; then printf 'monitor_path='; readlink -f \"$(command -v viron-monitor)\" 2>/dev/null || command -v viron-monitor; printf '\\n'; else printf 'monitor_path=\\n'; fi",
  ].join("; ");
}

function parsePreflightOutput(output: string): Map<string, string> {
  const lines = output.split(/\r?\n/);
  const markerIndex = lines.indexOf(preflightMarker);
  if (markerIndex < 0) throw new MonitorInstallError("MONITOR_PREFLIGHT_INVALID", "目标机器返回了无法识别的安装预检结果");
  const values = new Map<string, string>();
  for (const line of lines.slice(markerIndex + 1)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function installedManifest(value: string | undefined): z.infer<typeof installedManifestSchema> | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (decoded.length > 8192) return null;
    return installedManifestSchema.parse(JSON.parse(decoded));
  } catch {
    return null;
  }
}

function issue(code: string, message: string): MonitorInstallIssue {
  return { code, message };
}

export async function preflightMonitorInstallation(
  app: FastifyInstance,
  connectionId: string,
  requestedPath: unknown,
): Promise<MonitorInstallPreflight> {
  const installPath = normalizeMonitorInstallPath(requestedPath);
  const commandResult = await executeSshCommand(app, connectionId, preflightCommand(installPath), { timeoutMs: 30_000, maxBytes: 128 * 1024 });
  if (commandResult.exitCode !== 0 || commandResult.truncated) {
    const message = (commandResult.stderr.trim() || commandResult.stdout.trim() || "安装预检执行失败").slice(0, 1000);
    throw new MonitorInstallError("MONITOR_PREFLIGHT_FAILED", message);
  }
  const values = parsePreflightOutput(commandResult.stdout);
  const operatingSystem = values.get("kernel") ?? "";
  const machineArchitecture = values.get("machine") ?? "";
  const targetArchitecture = architecture(machineArchitecture);
  const systemdAvailable = values.get("systemd") === "1";
  const privilegeValue = values.get("privilege");
  const privilege: MonitorInstallPrivilege = privilegeValue === "root" || privilegeValue === "passwordless_sudo" ? privilegeValue : "unavailable";
  const existingInstallation = installedManifest(values.get("manifest_base64"));
  const existingMonitorPath = values.get("monitor_path") ?? "";
  const pathOccupied = values.get("path_kind") === "other" || values.get("path_empty") !== "1";
  const validManagedInstallation = existingInstallation?.installPath === installPath;
  let pathState: MonitorInstallPathState;
  if (validManagedInstallation) pathState = "upgrade";
  else if (pathOccupied) pathState = "conflict";
  else if (existingMonitorPath) pathState = "legacy";
  else pathState = "available";

  let packageAvailable = false;
  let packageIssue: MonitorInstallIssue | undefined;
  if (targetArchitecture) {
    try {
      await loadMonitorPackage(app, targetArchitecture);
      packageAvailable = true;
    } catch (error) {
      packageAvailable = false;
      if (error instanceof MonitorInstallError) packageIssue = issue(error.code, error.message);
    }
  }

  const issues: MonitorInstallIssue[] = [];
  if (operatingSystem !== "Linux") issues.push(issue("UNSUPPORTED_MONITOR_OS", "一键安装只支持 Linux 主机"));
  if (!targetArchitecture) issues.push(issue("UNSUPPORTED_MONITOR_ARCHITECTURE", `不支持目标架构：${machineArchitecture || "未知"}`));
  if (!systemdAvailable) issues.push(issue("SYSTEMD_REQUIRED", "目标机器必须使用 systemd"));
  if (privilege === "unavailable") issues.push(issue("MONITOR_INSTALL_PRIVILEGE_REQUIRED", "SSH 用户必须是 root 或具有免密 sudo"));
  if (!packageAvailable) issues.push(packageIssue ?? issue("MONITOR_PACKAGE_UNAVAILABLE", `Viron 服务端缺少 ${targetArchitecture ?? (machineArchitecture || "目标架构")} 监控安装包`));
  if (pathState === "conflict") issues.push(issue("MONITOR_INSTALL_PATH_CONFLICT", `安装目录已被非 Viron 内容占用：${installPath}`));
  if (pathState === "legacy") issues.push(issue("LEGACY_MONITOR_INSTALLATION", `检测到旧版手工安装：${existingMonitorPath}，不会自动覆盖`));

  return {
    defaultInstallPath: DEFAULT_MONITOR_INSTALL_PATH,
    installPath,
    operatingSystem,
    machineArchitecture,
    architecture: targetArchitecture,
    systemdAvailable,
    privilege,
    pathState,
    existingMonitorPath,
    existingInstallation,
    packageVersion: PRODUCT_VERSION,
    packageAvailable,
    canInstall: issues.length === 0,
    issues,
  };
}

function openSftp(connected: ConnectedSsh): Promise<SFTPWrapper> {
  return new Promise((resolveSftp, reject) => {
    connected.client.sftp((error, sftp) => {
      if (error) reject(error);
      else resolveSftp(sftp);
    });
  });
}

async function uploadPackage(
  connected: ConnectedSsh,
  stagingPath: string,
  monitorPackage: MonitorPackage,
  report?: MonitorInstallProgressReporter,
): Promise<void> {
  const sftp = await openSftp(connected);
  for (const [index, file] of monitorPackage.files.entries()) {
    const destination = posix.join(stagingPath, file.name);
    await pipeline(Readable.from([file.content]), sftp.createWriteStream(destination, { flags: "w", mode: 0o600 }));
    const completed = index + 1;
    await report?.({
      phase: "upload",
      progress: 40 + Math.round((completed / monitorPackage.files.length) * 25),
      message: `正在上传安装包 ${completed}/${monitorPackage.files.length}：${file.name}`,
    });
  }
}

function preflightError(preflight: MonitorInstallPreflight): MonitorInstallError {
  const first = preflight.issues[0] ?? issue("MONITOR_INSTALL_BLOCKED", "目标机器不满足一键安装条件");
  const statusCode = first.code === "MONITOR_INSTALL_PATH_CONFLICT" || first.code === "LEGACY_MONITOR_INSTALLATION" ? 409 : 422;
  return new MonitorInstallError(first.code, first.message, statusCode, preflight);
}

export async function installMonitor(
  app: FastifyInstance,
  connectionId: string,
  sshUsername: string,
  requestedPath: unknown,
  report?: MonitorInstallProgressReporter,
): Promise<{ preflight: MonitorInstallPreflight; stdout: string }> {
  await report?.({ phase: "preflight", progress: 5, message: "正在预检目标系统、架构、权限和安装目录" });
  const preflight = await preflightMonitorInstallation(app, connectionId, requestedPath);
  if (!preflight.canInstall || !preflight.architecture) throw preflightError(preflight);
  await report?.({ phase: "package_validation", progress: 15, message: `正在校验 ${preflight.architecture} 监控安装包` });
  const monitorPackage = await loadMonitorPackage(app, preflight.architecture);
  await report?.({ phase: "ssh_connect", progress: 25, message: "正在建立监控安装 SSH 会话" });
  const connected = await connectSsh(app, connectionId);
  let stagingPath = "";
  try {
    await report?.({ phase: "staging", progress: 35, message: "正在目标主机创建安全临时目录" });
    const staging = await executeSshCommandOnConnection(connected, "mktemp -d /tmp/viron-monitor-install.XXXXXX", { timeoutMs: 30_000, maxBytes: 16 * 1024 });
    stagingPath = staging.stdout.trim();
    if (staging.exitCode !== 0 || !stagingPathPattern.test(stagingPath)) {
      throw new MonitorInstallError("MONITOR_STAGING_FAILED", (staging.stderr.trim() || "无法创建监控安装临时目录").slice(0, 1000));
    }
    await report?.({ phase: "upload", progress: 40, message: `准备上传 ${monitorPackage.files.length} 个安装文件` });
    await uploadPackage(connected, stagingPath, monitorPackage, report);
    const privilegePrefix = preflight.privilege === "root" ? "" : "sudo -n ";
    const command = `${privilegePrefix}bash ${quotePosixShellArg(posix.join(stagingPath, "install.sh"))} --ssh-user ${quotePosixShellArg(sshUsername)} --install-dir ${quotePosixShellArg(preflight.installPath)}`;
    await report?.({ phase: "remote_install", progress: 70, message: "正在写入程序、配置和 systemd 服务" });
    const result = await executeSshCommandOnConnection(connected, command, { timeoutMs: 120_000, maxBytes: 1024 * 1024 });
    if (result.exitCode !== 0 || result.truncated) {
      const message = (result.stderr.trim() || result.stdout.trim() || "监控服务安装失败").slice(0, 4000);
      throw new MonitorInstallError("MONITOR_INSTALL_FAILED", message);
    }
    await report?.({ phase: "remote_install", progress: 78, message: "目标主机监控服务已启动" });
    return { preflight, stdout: result.stdout.slice(0, 20_000) };
  } finally {
    if (stagingPathPattern.test(stagingPath)) {
      try {
        await executeSshCommandOnConnection(connected, `rm -rf -- ${quotePosixShellArg(stagingPath)}`, { timeoutMs: 30_000, maxBytes: 16 * 1024 });
      } catch {
        // The exact temporary directory is intentionally best-effort cleanup.
      }
    }
    connected.close();
  }
}
