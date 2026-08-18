import { translate as tr } from "./i18n.js";
import { randomUUID } from "node:crypto";
import { join as nativeJoin, posix } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { Transform, type Writable } from "node:stream";
import { createReadStream, createWriteStream, type Stats as LocalStats } from "node:fs";
import { chmod, lstat as localLstat, mkdir, readdir as localReaddir, rename as localRename, rmdir, stat as localStat, unlink } from "node:fs/promises";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import type { DesktopSshCredential } from "./device-identity.js";
import {
  connectDesktopSshConnection,
  desktopSshErrorMessage,
  openDesktopSftp,
  type ConnectedDesktopSsh,
  type DesktopSshContext,
} from "./ssh-runtime.js";

export const DESKTOP_LOCAL_SFTP_CONNECTION_ID = "desktop-local";

export function desktopSftpRemoteConnectionIds(sourceConnectionId: string, targetConnectionId: string): [string, string?] {
  const sourceIsLocal = sourceConnectionId === DESKTOP_LOCAL_SFTP_CONNECTION_ID;
  const targetIsLocal = targetConnectionId === DESKTOP_LOCAL_SFTP_CONNECTION_ID;
  if (sourceIsLocal && targetIsLocal) throw new Error(tr("本机之间无需使用 SFTP 传输"));
  if (sourceIsLocal) return [targetConnectionId];
  if (targetIsLocal) return [sourceConnectionId];
  return [sourceConnectionId, targetConnectionId];
}

export interface DesktopSftpItem {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  targetType: "directory" | "file" | null;
  size: number;
  mode: string;
  modifiedAt: string;
}

export interface DesktopSftpTransferOptions {
  sourceConnectionId: string;
  targetConnectionId: string;
  sourcePath?: string;
  sourcePaths?: string[];
  targetDirectory: string;
  conflict: "overwrite" | "skip";
  conflictDecisions?: Record<string, "overwrite" | "skip">;
  originEnvironmentId?: string;
}

interface NormalizedDesktopSftpTransferOptions extends DesktopSftpTransferOptions {
  sourcePath: string;
  sourcePaths: string[];
}

export interface DesktopSftpTransferTask {
  id: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  sourcePath: string;
  sourcePaths: string[];
  targetConnectionId: string;
  targetConnectionName: string;
  targetPath: string;
  conflict: "overwrite" | "skip";
  status: "pending" | "running" | "success" | "error" | "cancelled";
  progress: number;
  transferredBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  completedFiles: number;
  skippedFiles: number;
  totalFiles: number;
  error: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DesktopSftpTransferPreview {
  sourceName: string;
  sourceType: "file" | "directory";
  sourcePath: string;
  sourcePaths: string[];
  targetPath: string;
  targetExists: boolean;
  totalBytes: number;
  totalFiles: number;
  conflicts: DesktopSftpTransferConflictItem[];
}

export interface DesktopSftpTransferConflictItem {
  sourcePath: string;
  targetPath: string;
  sourceType: "file" | "directory";
  targetType: "file" | "directory" | "symlink";
}

interface CredentialResult {
  context: DesktopSshContext;
  credential: DesktopSshCredential;
}

interface ManagedUpload {
  id: string;
  context: DesktopSshContext;
  stream: Writable;
  destination: string;
  closed: boolean;
  connected?: ConnectedDesktopSsh;
}

interface ManagedTransfer extends DesktopSftpTransferTask {
  context: DesktopSshContext;
  options: NormalizedDesktopSftpTransferOptions;
  abortController: AbortController;
  activeConnections: Set<ConnectedDesktopSsh>;
  runPromise: Promise<void> | null;
  lastActivityAt: number;
}

interface TransferPlan {
  sourceType: "file" | "directory";
  totalBytes: number;
  totalFiles: number;
}

interface TransferProgress {
  transferredBytes: number;
  completedFiles: number;
  skippedFiles: number;
}

type FileAttributes = Pick<Stats, "mode" | "size" | "isDirectory" | "isSymbolicLink"> & { mtime?: number | Date; mtimeMs?: number };

interface FileSystemEntry {
  filename: string;
  longname: string;
  attrs: FileAttributes;
}

interface SftpFileSystem {
  lstat(path: string): Promise<FileAttributes>;
  stat(path: string): Promise<FileAttributes>;
  readdir(path: string): Promise<FileSystemEntry[]>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  createReadStream(path: string): NodeJS.ReadableStream;
  createWriteStream(path: string, options: { flags: "w"; mode: number }): Writable;
  close(): void;
}

const TRANSFER_LIMIT = 3;
const SFTP_FILE_TYPE_MASK = 0o170000;
const SFTP_DIRECTORY_TYPE = 0o040000;
const SFTP_SYMLINK_TYPE = 0o120000;

function contextKey(context: DesktopSshContext): string {
  return `${context.endpoint}\0${context.userId}\0${context.workspaceType}\0${context.workspaceId}`;
}

function transferCancelled(task: ManagedTransfer): boolean {
  return task.status === "cancelled";
}

function remotePath(value: string | undefined): string {
  return posix.resolve("/", value?.trim() || "/");
}

function normalizedSourcePaths(options: Pick<DesktopSftpTransferOptions, "sourcePath" | "sourcePaths">): string[] {
  const raw = options.sourcePaths?.length ? options.sourcePaths : options.sourcePath ? [options.sourcePath] : [];
  return [...new Set(raw.map((path) => remotePath(path)))];
}

function isLocalConnection(connectionId: string): boolean {
  return connectionId === DESKTOP_LOCAL_SFTP_CONNECTION_ID;
}

function modeText(mode: number | undefined): string {
  return ((mode ?? 0) & 0o7777).toString(8).padStart(3, "0");
}

function modifiedAt(attributes: FileAttributes): string {
  if (attributes.mtime instanceof Date) return attributes.mtime.toISOString();
  return new Date(attributes.mtimeMs ?? (attributes.mtime ?? 0) * 1000).toISOString();
}

function sftpAction(run: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => run((error) => error ? reject(error) : resolve()));
}

function lstat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.lstat(path, (error, attributes) => error ? reject(error) : resolve(attributes)));
}

function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.stat(path, (error, attributes) => error ? reject(error) : resolve(attributes)));
}

function readdir(sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => sftp.readdir(path, (error, entries) => error ? reject(error) : resolve(entries)));
}

class SshSftpFileSystem implements SftpFileSystem {
  constructor(private readonly sftp: SFTPWrapper, private readonly connected: ConnectedDesktopSsh) {}

  lstat(path: string): Promise<FileAttributes> {
    return lstat(this.sftp, path);
  }

  stat(path: string): Promise<FileAttributes> {
    return stat(this.sftp, path);
  }

  readdir(path: string): Promise<FileSystemEntry[]> {
    return readdir(this.sftp, path);
  }

  mkdir(path: string): Promise<void> {
    return sftpAction((callback) => this.sftp.mkdir(path, callback));
  }

  rmdir(path: string): Promise<void> {
    return sftpAction((callback) => this.sftp.rmdir(path, callback));
  }

  unlink(path: string): Promise<void> {
    return sftpAction((callback) => this.sftp.unlink(path, callback));
  }

  chmod(path: string, mode: number): Promise<void> {
    return sftpAction((callback) => this.sftp.chmod(path, mode, callback));
  }

  createReadStream(path: string): NodeJS.ReadableStream {
    return this.sftp.createReadStream(path);
  }

  createWriteStream(path: string, options: { flags: "w"; mode: number }): Writable {
    return this.sftp.createWriteStream(path, options);
  }

  close(): void {
    this.connected.close();
  }
}

class LocalSftpFileSystem implements SftpFileSystem {
  lstat(path: string): Promise<LocalStats> {
    return localLstat(path);
  }

  stat(path: string): Promise<LocalStats> {
    return localStat(path);
  }

  async readdir(path: string): Promise<FileSystemEntry[]> {
    const names = await localReaddir(path);
    return Promise.all(names.map(async (filename) => ({
      filename,
      longname: filename,
      attrs: await localLstat(posix.join(path, filename)),
    })));
  }

  mkdir(path: string): Promise<void> {
    return mkdir(path);
  }

  rmdir(path: string): Promise<void> {
    return rmdir(path);
  }

  unlink(path: string): Promise<void> {
    return unlink(path);
  }

  chmod(path: string, mode: number): Promise<void> {
    return chmod(path, mode);
  }

  createReadStream(path: string): NodeJS.ReadableStream {
    return createReadStream(path);
  }

  createWriteStream(path: string, options: { flags: "w"; mode: number }): Writable {
    return createWriteStream(path, options);
  }

  close(): void {}
}

export function sftpEntryTypeFromMetadata(attributes: FileAttributes, longname = ""): DesktopSftpItem["type"] | null {
  if (attributes.isDirectory()) return "directory";
  if (attributes.isSymbolicLink()) return "symlink";
  const fileType = (attributes.mode ?? 0) & SFTP_FILE_TYPE_MASK;
  if (fileType === SFTP_DIRECTORY_TYPE) return "directory";
  if (fileType === SFTP_SYMLINK_TYPE) return "symlink";
  if (fileType !== 0) return "file";
  if (!/^[bcdlps-][rwxStTs-]{9}(?:\s|$)/.test(longname)) return null;
  if (longname[0] === "d") return "directory";
  if (longname[0] === "l") return "symlink";
  return "file";
}

async function resolveSftpListItem(fileSystem: SftpFileSystem, parentPath: string, entry: FileSystemEntry): Promise<DesktopSftpItem> {
  const path = posix.join(parentPath, entry.filename);
  let attributes = entry.attrs;
  let type = sftpEntryTypeFromMetadata(attributes, entry.longname);
  if (!type) {
    try {
      attributes = await fileSystem.lstat(path);
      type = sftpEntryTypeFromMetadata(attributes);
    } catch {
      // Keep the directory listing usable when a single entry disappears during refresh.
    }
  }
  type ??= "file";
  let targetType: DesktopSftpItem["targetType"] = null;
  if (type === "symlink") {
    try {
      const resolved = sftpEntryTypeFromMetadata(await fileSystem.stat(path));
      if (resolved === "directory" || resolved === "file") targetType = resolved;
    } catch {
      // Broken or inaccessible links remain visible as links without a target type.
    }
  }
  return {
    name: entry.filename,
    path,
    type,
    targetType,
    size: attributes.size,
    mode: modeText(attributes.mode),
    modifiedAt: modifiedAt(attributes),
  };
}

async function existingStats(fileSystem: SftpFileSystem, path: string): Promise<FileAttributes | null> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 2 || code === "ENOENT" || code === "NO_SUCH_FILE" || /no such file/i.test(desktopSshErrorMessage(error))) return null;
    throw error;
  }
}

async function buildPlan(fileSystem: SftpFileSystem, path: string, signal?: AbortSignal): Promise<TransferPlan> {
  if (signal?.aborted) throw signal.reason;
  const attributes = await fileSystem.lstat(path);
  if (attributes.isSymbolicLink()) throw new Error(tr("暂不支持传输符号链接"));
  if (!attributes.isDirectory()) return { sourceType: "file", totalBytes: attributes.size, totalFiles: 1 };
  let totalBytes = 0;
  let totalFiles = 0;
  for (const entry of await fileSystem.readdir(path)) {
    if (entry.filename === "." || entry.filename === "..") continue;
    const child = await buildPlan(fileSystem, posix.join(path, entry.filename), signal);
    totalBytes += child.totalBytes;
    totalFiles += child.totalFiles;
  }
  return { sourceType: "directory", totalBytes, totalFiles };
}

function entryType(attributes: FileAttributes): DesktopSftpTransferConflictItem["targetType"] {
  if (attributes.isSymbolicLink()) return "symlink";
  return attributes.isDirectory() ? "directory" : "file";
}

async function collectConflicts(
  source: SftpFileSystem,
  target: SftpFileSystem,
  sourcePath: string,
  targetPath: string,
  conflicts: DesktopSftpTransferConflictItem[],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const sourceAttributes = await source.lstat(sourcePath);
  if (sourceAttributes.isSymbolicLink()) throw new Error(tr("暂不支持传输符号链接：{{0}}", [sourcePath]));
  const existing = await existingStats(target, targetPath);
  if (!sourceAttributes.isDirectory()) {
    if (existing) conflicts.push({ sourcePath, targetPath, sourceType: "file", targetType: entryType(existing) });
    return;
  }
  if (!existing) return;
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    conflicts.push({ sourcePath, targetPath, sourceType: "directory", targetType: entryType(existing) });
    return;
  }
  for (const child of await source.readdir(sourcePath)) {
    if (child.filename === "." || child.filename === "..") continue;
    await collectConflicts(source, target, posix.join(sourcePath, child.filename), posix.join(targetPath, child.filename), conflicts, signal);
  }
}

async function removeEntry(fileSystem: SftpFileSystem, path: string, attributes: FileAttributes): Promise<void> {
  if (!attributes.isDirectory() || attributes.isSymbolicLink()) {
    await fileSystem.unlink(path);
    return;
  }
  for (const child of await fileSystem.readdir(path)) {
    if (child.filename === "." || child.filename === "..") continue;
    const childPath = posix.join(path, child.filename);
    await removeEntry(fileSystem, childPath, await fileSystem.lstat(childPath));
  }
  await fileSystem.rmdir(path);
}

async function materializeEntry(fileSystem: SftpFileSystem, sourcePath: string, targetPath: string): Promise<void> {
  const attributes = await fileSystem.lstat(sourcePath);
  if (attributes.isSymbolicLink()) throw new Error(tr("暂不支持拖出符号链接：{{0}}", [sourcePath]));
  if (!attributes.isDirectory()) {
    await pipeline(fileSystem.createReadStream(sourcePath), createWriteStream(targetPath, { mode: attributes.mode & 0o777 }));
    return;
  }
  await mkdir(targetPath, { recursive: true, mode: attributes.mode & 0o777 });
  for (const child of await fileSystem.readdir(sourcePath)) {
    if (child.filename === "." || child.filename === "..") continue;
    await materializeEntry(fileSystem, posix.join(sourcePath, child.filename), nativeJoin(targetPath, child.filename));
  }
}

function conflictDecision(
  targetPath: string,
  fallback: "overwrite" | "skip",
  decisions: Readonly<Record<string, "overwrite" | "skip">> | undefined,
): "overwrite" | "skip" {
  return decisions?.[targetPath] ?? fallback;
}

async function ensureDirectory(
  fileSystem: SftpFileSystem,
  path: string,
  conflict: "overwrite" | "skip",
  decisions?: Readonly<Record<string, "overwrite" | "skip">>,
): Promise<boolean> {
  const existing = await existingStats(fileSystem, path);
  if (!existing) {
    await fileSystem.mkdir(path);
    return true;
  }
  if (existing.isDirectory() && !existing.isSymbolicLink()) return true;
  if (conflictDecision(path, conflict, decisions) === "skip") return false;
  await removeEntry(fileSystem, path, existing);
  await fileSystem.mkdir(path);
  return true;
}

async function copyEntry(
  source: SftpFileSystem,
  target: SftpFileSystem,
  sourcePath: string,
  targetPath: string,
  conflict: "overwrite" | "skip",
  decisions: Readonly<Record<string, "overwrite" | "skip">> | undefined,
  progress: TransferProgress,
  onProgress: (progress: TransferProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const attributes = await source.lstat(sourcePath);
  if (attributes.isSymbolicLink()) throw new Error(tr("暂不支持传输符号链接：{{0}}", [sourcePath]));
  if (attributes.isDirectory()) {
    if (!await ensureDirectory(target, targetPath, conflict, decisions)) {
      const skipped = await buildPlan(source, sourcePath, signal);
      progress.skippedFiles += skipped.totalFiles;
      onProgress(progress);
      return;
    }
    for (const entry of await source.readdir(sourcePath)) {
      if (entry.filename === "." || entry.filename === "..") continue;
      await copyEntry(source, target, posix.join(sourcePath, entry.filename), posix.join(targetPath, entry.filename), conflict, decisions, progress, onProgress, signal);
    }
    await target.chmod(targetPath, attributes.mode & 0o777);
    return;
  }

  const existing = await existingStats(target, targetPath);
  if (existing && conflictDecision(targetPath, conflict, decisions) === "skip") {
    progress.skippedFiles += 1;
    onProgress(progress);
    return;
  }
  if (existing?.isDirectory() || existing?.isSymbolicLink()) await removeEntry(target, targetPath, existing);
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      progress.transferredBytes += chunk.length;
      onProgress(progress);
      callback(null, chunk);
    },
  });
  await pipeline(
    source.createReadStream(sourcePath),
    counter,
    target.createWriteStream(targetPath, { flags: "w", mode: attributes.mode & 0o777 }),
    { signal },
  );
  await target.chmod(targetPath, attributes.mode & 0o777);
  progress.completedFiles += 1;
  onProgress(progress);
}

export class DesktopSftpRuntime {
  private readonly uploads = new Map<string, ManagedUpload>();
  private readonly transfers = new Map<string, ManagedTransfer>();

  constructor(
    private readonly loadCredential: (connectionId: string) => Promise<CredentialResult>,
    private readonly currentContext: () => Promise<DesktopSshContext>,
  ) {}

  async list(connectionId: string, pathValue: string): Promise<{ path: string; parentPath: string | null; items: DesktopSftpItem[] }> {
    const path = remotePath(pathValue);
    return this.withFileSystem(connectionId, async (fileSystem) => {
      const items = await Promise.all((await fileSystem.readdir(path))
        .filter((entry) => entry.filename !== "." && entry.filename !== "..")
        .map((entry) => resolveSftpListItem(fileSystem, path, entry)));
      items.sort((left, right) => {
        const leftDirectory = left.type === "directory" || left.targetType === "directory";
        const rightDirectory = right.type === "directory" || right.targetType === "directory";
        if (leftDirectory && !rightDirectory) return -1;
        if (!leftDirectory && rightDirectory) return 1;
        return left.name.localeCompare(right.name, "zh-CN");
      });
      return { path, parentPath: path === "/" ? null : posix.dirname(path), items };
    });
  }

  async mkdir(connectionId: string, pathValue: string): Promise<{ path: string }> {
    const path = remotePath(pathValue);
    await this.withFileSystem(connectionId, (fileSystem) => fileSystem.mkdir(path));
    return { path };
  }

  async rename(connectionId: string, pathValue: string, newPathValue: string): Promise<{ path: string }> {
    const path = remotePath(pathValue);
    const newPath = remotePath(newPathValue);
    if (isLocalConnection(connectionId)) await localRename(path, newPath);
    else await this.withSftp(connectionId, (sftp) => sftpAction((callback) => sftp.rename(path, newPath, callback)));
    return { path: newPath };
  }

  async chmod(connectionId: string, pathValue: string, mode: string): Promise<void> {
    if (!/^[0-7]{3,4}$/.test(mode)) throw new Error(tr("请输入 3 或 4 位八进制权限"));
    const path = remotePath(pathValue);
    await this.withFileSystem(connectionId, (fileSystem) => fileSystem.chmod(path, Number.parseInt(mode, 8)));
  }

  async delete(connectionId: string, pathValue: string): Promise<void> {
    const path = remotePath(pathValue);
    if (path === "/") throw new Error(tr("不能删除根目录"));
    await this.withFileSystem(connectionId, async (fileSystem) => {
      const attributes = await fileSystem.lstat(path);
      await (attributes.isDirectory() ? fileSystem.rmdir(path) : fileSystem.unlink(path));
    });
  }

  async startUpload(connectionId: string, directoryValue: string, filenameValue: string, context: DesktopSshContext): Promise<{ uploadId: string; path: string }> {
    const directory = remotePath(directoryValue);
    const filename = posix.basename(filenameValue.replaceAll("\0", ""));
    if (!filename || filename === "." || filename === "..") throw new Error(tr("上传文件名无效"));
    const destination = posix.join(directory, filename);
    if (isLocalConnection(connectionId)) {
      const stream = createWriteStream(destination, { flags: "w", mode: 0o640 });
      const upload: ManagedUpload = { id: randomUUID(), context, stream, destination, closed: false };
      stream.once("error", () => this.finishUpload(upload, false));
      this.uploads.set(upload.id, upload);
      return { uploadId: upload.id, path: destination };
    }
    const loaded = await this.openConnection(connectionId, context);
    const connected = loaded.connected;
    try {
      const sftp = await openDesktopSftp(connected.client);
      const stream = sftp.createWriteStream(destination, { flags: "w", mode: 0o640 });
      const upload: ManagedUpload = { id: randomUUID(), context: loaded.context, connected, stream, destination, closed: false };
      stream.once("error", () => this.finishUpload(upload, false));
      this.uploads.set(upload.id, upload);
      return { uploadId: upload.id, path: destination };
    } catch (error) {
      connected.close();
      throw error;
    }
  }

  async uploadChunk(uploadId: string, context: DesktopSshContext, data: Uint8Array): Promise<void> {
    const upload = this.uploadForContext(uploadId, context);
    if (!upload.stream.write(Buffer.from(data))) await once(upload.stream, "drain");
  }

  async completeUpload(uploadId: string, context: DesktopSshContext): Promise<{ path: string }> {
    const upload = this.uploadForContext(uploadId, context);
    await new Promise<void>((resolve, reject) => {
      upload.stream.once("error", reject);
      upload.stream.end(resolve);
    });
    const path = upload.destination;
    this.finishUpload(upload, true);
    return { path };
  }

  cancelUpload(uploadId: string, context: DesktopSshContext): void {
    const upload = this.uploadForContext(uploadId, context);
    upload.stream.destroy(new Error(tr("上传已取消")));
    this.finishUpload(upload, false);
  }

  async downloadTo(connectionId: string, pathValue: string, targetPath: string): Promise<void> {
    const path = remotePath(pathValue);
    await this.withFileSystem(connectionId, async (fileSystem) => {
      const attributes = await fileSystem.lstat(path);
      if (attributes.isDirectory()) throw new Error(tr("请进入目录后逐个下载文件"));
      await pipeline(fileSystem.createReadStream(path), createWriteStream(targetPath, { mode: 0o600 }));
    });
  }

  async materializeForNativeDrag(connectionId: string, pathValues: string[], targetDirectory: string): Promise<{ files: string[]; temporary: boolean }> {
    const paths = [...new Set(pathValues.map((path) => remotePath(path)))];
    if (!paths.length) throw new Error(tr("请选择要拖出的文件或目录"));
    if (isLocalConnection(connectionId)) return { files: paths, temporary: false };
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const files = await this.withFileSystem(connectionId, async (fileSystem) => {
      const targets: string[] = [];
      for (const sourcePath of paths) {
        const targetPath = nativeJoin(targetDirectory, posix.basename(sourcePath));
        await materializeEntry(fileSystem, sourcePath, targetPath);
        targets.push(targetPath);
      }
      return targets;
    });
    return { files, temporary: true };
  }

  async download(connectionId: string, pathValue: string, maxBytes = 8 * 1024 * 1024): Promise<{ filename: string; data: Buffer }> {
    const path = remotePath(pathValue);
    return this.withFileSystem(connectionId, async (fileSystem) => {
      const attributes = await fileSystem.lstat(path);
      if (attributes.isDirectory()) throw new Error(tr("请进入目录后逐个下载文件"));
      if (attributes.size > maxBytes) throw new Error(tr("MCP 单次读取文件不能超过 {{0}} MiB", [Math.floor(maxBytes / 1024 / 1024)]));
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of fileSystem.createReadStream(path) as AsyncIterable<Buffer | string>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) throw new Error(tr("MCP 单次读取文件不能超过 {{0}} MiB", [Math.floor(maxBytes / 1024 / 1024)]));
        chunks.push(buffer);
      }
      return { filename: posix.basename(path), data: Buffer.concat(chunks) };
    });
  }

  async preview(options: Omit<DesktopSftpTransferOptions, "conflict">): Promise<DesktopSftpTransferPreview> {
    const sourcePaths = normalizedSourcePaths(options);
    const targetDirectory = remotePath(options.targetDirectory);
    if (!sourcePaths.length) throw new Error(tr("请选择要传输的文件或目录"));
    if (sourcePaths.includes("/")) throw new Error(tr("不能传输远端根目录"));
    const expectedContext = await this.currentContext();
    const [sourceLoaded, targetLoaded] = await Promise.all([
      this.connectionInfoIfRemote(options.sourceConnectionId, expectedContext),
      this.connectionInfoIfRemote(options.targetConnectionId, expectedContext),
    ]);
    if (sourceLoaded && targetLoaded && contextKey(sourceLoaded.context) !== contextKey(targetLoaded.context)) throw new Error(tr("来源和目标连接不属于当前工作空间"));
    const [source, target] = await Promise.all([
      this.openFileSystem(options.sourceConnectionId, expectedContext),
      this.openFileSystem(options.targetConnectionId, expectedContext),
    ]);
    try {
      const plans = await Promise.all(sourcePaths.map((sourcePath) => buildPlan(source, sourcePath)));
      const conflicts: DesktopSftpTransferConflictItem[] = [];
      for (const [index, sourcePath] of sourcePaths.entries()) {
        const targetPath = posix.join(targetDirectory, posix.basename(sourcePath));
        this.assertSafeDestination(options.sourceConnectionId, options.targetConnectionId, sourcePath, targetPath, plans[index].sourceType);
        await collectConflicts(source, target, sourcePath, targetPath, conflicts);
      }
      const sourcePath = sourcePaths[0];
      const plan = plans[0];
      const targetPath = sourcePaths.length === 1 ? posix.join(targetDirectory, posix.basename(sourcePath)) : targetDirectory;
      return {
        sourceName: sourcePaths.length === 1 ? posix.basename(sourcePath) : tr("{{0}} 项", [sourcePaths.length]),
        sourceType: sourcePaths.length === 1 ? plan.sourceType : "directory",
        sourcePath,
        sourcePaths,
        targetPath,
        targetExists: conflicts.length > 0,
        totalBytes: plans.reduce((total, item) => total + item.totalBytes, 0),
        totalFiles: plans.reduce((total, item) => total + item.totalFiles, 0),
        conflicts,
      };
    } finally {
      source.close();
      target.close();
    }
  }

  async create(context: DesktopSshContext, rawOptions: DesktopSftpTransferOptions): Promise<DesktopSftpTransferTask> {
    const active = [...this.transfers.values()].filter((task) => ["pending", "running"].includes(task.status)).length;
    if (active >= TRANSFER_LIMIT) throw new Error(tr("SFTP 后台传输已达到 {{0}} 个并发上限", [TRANSFER_LIMIT]));
    const sourcePaths = normalizedSourcePaths(rawOptions);
    if (!sourcePaths.length) throw new Error(tr("请选择要传输的文件或目录"));
    const options: NormalizedDesktopSftpTransferOptions = {
      ...rawOptions,
      sourcePath: sourcePaths[0],
      sourcePaths,
      targetDirectory: remotePath(rawOptions.targetDirectory),
    };
    if (options.sourcePaths.includes("/")) throw new Error(tr("不能传输远端根目录"));
    for (const sourcePath of options.sourcePaths) {
      this.assertSafeDestination(options.sourceConnectionId, options.targetConnectionId, sourcePath, posix.join(options.targetDirectory, posix.basename(sourcePath)));
    }
    const targetPath = options.sourcePaths.length === 1 ? posix.join(options.targetDirectory, posix.basename(options.sourcePath)) : options.targetDirectory;
    const [sourceLoaded, targetLoaded] = await Promise.all([
      this.connectionInfoIfRemote(options.sourceConnectionId, context),
      this.connectionInfoIfRemote(options.targetConnectionId, context),
    ]);
    if ((sourceLoaded && contextKey(sourceLoaded.context) !== contextKey(context)) || (targetLoaded && contextKey(targetLoaded.context) !== contextKey(context))) throw new Error(tr("连接不属于当前工作空间"));
    const task: ManagedTransfer = {
      id: randomUUID(),
      context,
      options,
      sourceConnectionId: options.sourceConnectionId,
      sourceConnectionName: sourceLoaded?.name ?? tr("本机"),
      sourcePath: options.sourcePath,
      sourcePaths: options.sourcePaths,
      targetConnectionId: options.targetConnectionId,
      targetConnectionName: targetLoaded?.name ?? tr("本机"),
      targetPath,
      conflict: options.conflict,
      status: "pending",
      progress: 0,
      transferredBytes: 0,
      totalBytes: 0,
      speedBytesPerSecond: 0,
      completedFiles: 0,
      skippedFiles: 0,
      totalFiles: 0,
      error: "",
      createdAt: new Date().toISOString(),
      abortController: new AbortController(),
      activeConnections: new Set(),
      runPromise: null,
      lastActivityAt: Date.now(),
    };
    this.transfers.set(task.id, task);
    this.trimTransfers();
    task.runPromise = this.runTransfer(task);
    void task.runPromise.finally(() => { task.runPromise = null; });
    return this.publicTask(task);
  }

  listTransfers(context: DesktopSshContext): DesktopSftpTransferTask[] {
    const key = contextKey(context);
    return [...this.transfers.values()]
      .filter((task) => contextKey(task.context) === key)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => this.publicTask(task));
  }

  activeCount(): number {
    return this.uploads.size + [...this.transfers.values()].filter((task) => ["pending", "running"].includes(task.status)).length;
  }

  activity(taskId: string): number | null {
    const task = this.transfers.get(taskId);
    return task && ["pending", "running"].includes(task.status) ? task.lastActivityAt : null;
  }

  cancelTransfer(taskId: string, context: DesktopSshContext): void {
    const task = this.taskForContext(taskId, context);
    if (!["pending", "running"].includes(task.status)) throw new Error(tr("传输任务已经结束"));
    task.status = "cancelled";
    task.error = tr("任务已由用户取消");
    task.completedAt = new Date().toISOString();
    task.abortController.abort(new Error(task.error));
    for (const connection of task.activeConnections) connection.client.destroy();
  }

  async retryTransfer(taskId: string, context: DesktopSshContext): Promise<DesktopSftpTransferTask> {
    const task = this.taskForContext(taskId, context);
    if (!["error", "cancelled"].includes(task.status)) throw new Error(tr("只有失败或已取消的任务可以重试"));
    return this.create(context, task.options);
  }

  async closeContext(context: DesktopSshContext): Promise<void> {
    const key = contextKey(context);
    for (const upload of this.uploads.values()) {
      if (contextKey(upload.context) !== key) continue;
      upload.stream.destroy(new Error(tr("用户访问已失效")));
      this.finishUpload(upload, false);
    }
    for (const task of this.transfers.values()) {
      if (contextKey(task.context) === key && ["pending", "running"].includes(task.status)) this.cancelTransfer(task.id, context);
    }
  }

  closeConnection(connectionId: string): void {
    for (const upload of [...this.uploads.values()]) {
      if (upload.connected?.connection.connectionId !== connectionId) continue;
      upload.stream.destroy(new Error(tr("SSH 连接配置已变更")));
      this.finishUpload(upload, false);
    }
    for (const task of this.transfers.values()) {
      if (!["pending", "running"].includes(task.status)) continue;
      if (task.sourceConnectionId === connectionId || task.targetConnectionId === connectionId) {
        task.status = "cancelled";
        task.error = tr("SSH 连接配置已变更");
        task.completedAt = new Date().toISOString();
        task.abortController.abort(new Error(task.error));
        for (const connection of task.activeConnections) connection.client.destroy();
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const upload of [...this.uploads.values()]) {
      upload.stream.destroy(new Error(tr("Viron App 正在退出")));
      this.finishUpload(upload, false);
    }
    for (const task of this.transfers.values()) {
      if (["pending", "running"].includes(task.status)) {
        task.status = "cancelled";
        task.abortController.abort(new Error(tr("Viron App 正在退出")));
        for (const connection of task.activeConnections) connection.client.destroy();
      }
    }
    await Promise.allSettled([...this.transfers.values()].map((task) => task.runPromise).filter((run): run is Promise<void> => Boolean(run)));
  }

  private async withSftp<T>(connectionId: string, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const loaded = await this.openConnection(connectionId);
    const connected = loaded.connected;
    try {
      return await action(await openDesktopSftp(connected.client));
    } finally {
      connected.close();
    }
  }

  private async withFileSystem<T>(connectionId: string, action: (fileSystem: SftpFileSystem) => Promise<T>): Promise<T> {
    const fileSystem = await this.openFileSystem(connectionId);
    try {
      return await action(fileSystem);
    } finally {
      fileSystem.close();
    }
  }

  private async connectionInfoIfRemote(
    connectionId: string,
    expectedContext: DesktopSshContext,
  ): Promise<{ context: DesktopSshContext; name: string } | null> {
    if (isLocalConnection(connectionId)) return null;
    const loaded = await this.openConnection(connectionId, expectedContext);
    try {
      return { context: loaded.context, name: loaded.connected.connection.name };
    } finally {
      loaded.connected.close();
    }
  }

  private async openConnection(connectionId: string, expectedContext?: DesktopSshContext) {
    return connectDesktopSshConnection(connectionId, expectedContext ?? await this.currentContext(), this.loadCredential);
  }

  private async openFileSystem(connectionId: string, expectedContext?: DesktopSshContext): Promise<SftpFileSystem> {
    if (isLocalConnection(connectionId)) return new LocalSftpFileSystem();
    const loaded = await this.openConnection(connectionId, expectedContext);
    const connected = loaded.connected;
    try {
      return new SshSftpFileSystem(await openDesktopSftp(connected.client), connected);
    } catch (error) {
      connected.close();
      throw error;
    }
  }

  private uploadForContext(uploadId: string, context: DesktopSshContext): ManagedUpload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.closed || contextKey(upload.context) !== contextKey(context)) throw new Error(tr("上传任务不存在或已经结束"));
    return upload;
  }

  private finishUpload(upload: ManagedUpload, _completed: boolean): void {
    if (upload.closed) return;
    upload.closed = true;
    this.uploads.delete(upload.id);
    upload.connected?.close();
  }

  private taskForContext(taskId: string, context: DesktopSshContext): ManagedTransfer {
    const task = this.transfers.get(taskId);
    if (!task || contextKey(task.context) !== contextKey(context)) throw new Error(tr("传输任务不存在"));
    return task;
  }

  private async runTransfer(task: ManagedTransfer): Promise<void> {
    task.status = "running";
    task.lastActivityAt = Date.now();
    task.startedAt = new Date().toISOString();
    const startedAt = Date.now();
    let source: SftpFileSystem | undefined;
    let target: SftpFileSystem | undefined;
    try {
      const [sourceLoaded, targetLoaded] = await Promise.all([
        this.connectionInfoIfRemote(task.sourceConnectionId, task.context),
        this.connectionInfoIfRemote(task.targetConnectionId, task.context),
      ]);
      if ((sourceLoaded && contextKey(sourceLoaded.context) !== contextKey(task.context)) || (targetLoaded && contextKey(targetLoaded.context) !== contextKey(task.context))) throw new Error(tr("连接访问权限已经失效"));
      [source, target] = await Promise.all([
        this.openFileSystem(task.sourceConnectionId, task.context),
        this.openFileSystem(task.targetConnectionId, task.context),
      ]);
      const sourceFileSystem = source;
      const targetFileSystem = target;
      const plans = await Promise.all(task.sourcePaths.map((sourcePath) => buildPlan(sourceFileSystem, sourcePath, task.abortController.signal)));
      for (const [index, sourcePath] of task.sourcePaths.entries()) {
        this.assertSafeDestination(task.sourceConnectionId, task.targetConnectionId, sourcePath, posix.join(task.options.targetDirectory, posix.basename(sourcePath)), plans[index].sourceType);
      }
      task.totalBytes = plans.reduce((total, plan) => total + plan.totalBytes, 0);
      task.totalFiles = plans.reduce((total, plan) => total + plan.totalFiles, 0);
      const progress: TransferProgress = { transferredBytes: 0, completedFiles: 0, skippedFiles: 0 };
      for (const sourcePath of task.sourcePaths) {
        await copyEntry(sourceFileSystem, targetFileSystem, sourcePath, posix.join(task.options.targetDirectory, posix.basename(sourcePath)), task.conflict, task.options.conflictDecisions, progress, (next) => {
          task.transferredBytes = next.transferredBytes;
          task.completedFiles = next.completedFiles;
          task.skippedFiles = next.skippedFiles;
          const elapsed = Math.max(.1, (Date.now() - startedAt) / 1000);
          task.speedBytesPerSecond = Math.round(task.transferredBytes / elapsed);
          const processedFiles = task.completedFiles + task.skippedFiles;
          task.progress = task.totalBytes > 0
            ? Math.min(99, Math.round(task.transferredBytes / task.totalBytes * 100))
            : Math.min(99, Math.round(processedFiles / Math.max(1, task.totalFiles) * 100));
          task.lastActivityAt = Date.now();
        }, task.abortController.signal);
      }
      if (!transferCancelled(task)) {
        task.status = "success";
        task.progress = 100;
      }
    } catch (error) {
      if (!transferCancelled(task)) {
        task.status = "error";
        task.error = desktopSshErrorMessage(error);
      }
    } finally {
      task.completedAt ??= new Date().toISOString();
      source?.close();
      target?.close();
      task.activeConnections.clear();
    }
  }

  private publicTask(task: ManagedTransfer): DesktopSftpTransferTask {
    return {
      id: task.id,
      sourceConnectionId: task.sourceConnectionId,
      sourceConnectionName: task.sourceConnectionName,
      sourcePath: task.sourcePath,
      sourcePaths: task.sourcePaths,
      targetConnectionId: task.targetConnectionId,
      targetConnectionName: task.targetConnectionName,
      targetPath: task.targetPath,
      conflict: task.conflict,
      status: task.status,
      progress: task.progress,
      transferredBytes: task.transferredBytes,
      totalBytes: task.totalBytes,
      speedBytesPerSecond: task.speedBytesPerSecond,
      completedFiles: task.completedFiles,
      skippedFiles: task.skippedFiles,
      totalFiles: task.totalFiles,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    };
  }

  private assertSafeDestination(sourceConnectionId: string, targetConnectionId: string, sourcePath: string, targetPath: string, sourceType?: "file" | "directory"): void {
    if (sourceConnectionId !== targetConnectionId || sourceType === "file") return;
    const normalizedSource = remotePath(sourcePath);
    const normalizedTarget = remotePath(targetPath);
    if (normalizedTarget === normalizedSource || normalizedTarget.startsWith(`${normalizedSource}/`)) throw new Error(tr("目标目录不能位于来源目录内部"));
  }

  private trimTransfers(): void {
    const completed = [...this.transfers.values()]
      .filter((task) => !["pending", "running"].includes(task.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const task of completed.slice(100)) this.transfers.delete(task.id);
  }
}
