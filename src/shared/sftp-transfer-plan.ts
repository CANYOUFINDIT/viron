import { posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type SftpConflict = "overwrite" | "skip";

export interface SftpPlanAttributes {
  size: number;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SftpPlanEntry {
  filename: string;
}

export interface SftpPlanFileSystem {
  lstat(path: string): Promise<SftpPlanAttributes>;
  readdir(path: string): Promise<SftpPlanEntry[]>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  createReadStream(path: string): NodeJS.ReadableStream;
  createWriteStream(path: string, options: { flags: "w"; mode: number }): NodeJS.WritableStream;
}

export interface SftpTransferPlan {
  sourceType: "file" | "directory";
  totalBytes: number;
  totalFiles: number;
}

export interface SftpTransferProgress {
  transferredBytes: number;
  completedFiles: number;
  skippedFiles: number;
}

export interface SftpTransferConflictItem {
  sourcePath: string;
  targetPath: string;
  sourceType: "file" | "directory";
  targetType: "file" | "directory" | "symlink";
}

type Translate = (key: string, values?: readonly unknown[]) => string;
type IsMissingFile = (error: unknown) => boolean;

export function isSftpMissingFileCode(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === 2 || code === "ENOENT" || code === "NO_SUCH_FILE";
}

export async function existingSftpStats(
  fileSystem: SftpPlanFileSystem,
  path: string,
  isMissingFile: IsMissingFile,
): Promise<SftpPlanAttributes | null> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export function sftpConflictDecision(
  targetPath: string,
  fallback: SftpConflict,
  decisions: Readonly<Record<string, SftpConflict>> | undefined,
): SftpConflict {
  return decisions?.[targetPath] ?? fallback;
}

export async function buildSftpPlan(
  fileSystem: SftpPlanFileSystem,
  path: string,
  signal: AbortSignal | undefined,
  translate: Translate,
): Promise<SftpTransferPlan> {
  if (signal?.aborted) throw signal.reason;
  const attributes = await fileSystem.lstat(path);
  if (attributes.isSymbolicLink()) throw new Error(translate("暂不支持传输符号链接"));
  if (!attributes.isDirectory()) return { sourceType: "file", totalBytes: attributes.size, totalFiles: 1 };
  let totalBytes = 0;
  let totalFiles = 0;
  for (const entry of await fileSystem.readdir(path)) {
    if (entry.filename === "." || entry.filename === "..") continue;
    const child = await buildSftpPlan(fileSystem, posix.join(path, entry.filename), signal, translate);
    totalBytes += child.totalBytes;
    totalFiles += child.totalFiles;
  }
  return { sourceType: "directory", totalBytes, totalFiles };
}

function sftpEntryType(attributes: SftpPlanAttributes): SftpTransferConflictItem["targetType"] {
  if (attributes.isSymbolicLink()) return "symlink";
  return attributes.isDirectory() ? "directory" : "file";
}

export async function collectSftpConflicts(
  source: SftpPlanFileSystem,
  target: SftpPlanFileSystem,
  sourcePath: string,
  targetPath: string,
  conflicts: SftpTransferConflictItem[],
  signal: AbortSignal | undefined,
  translate: Translate,
  isMissingFile: IsMissingFile,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const sourceAttributes = await source.lstat(sourcePath);
  if (sourceAttributes.isSymbolicLink()) throw new Error(translate("暂不支持传输符号链接：{{0}}", [sourcePath]));
  const existing = await existingSftpStats(target, targetPath, isMissingFile);
  if (!sourceAttributes.isDirectory()) {
    if (existing) conflicts.push({ sourcePath, targetPath, sourceType: "file", targetType: sftpEntryType(existing) });
    return;
  }
  if (!existing) return;
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    conflicts.push({ sourcePath, targetPath, sourceType: "directory", targetType: sftpEntryType(existing) });
    return;
  }
  for (const child of await source.readdir(sourcePath)) {
    if (child.filename === "." || child.filename === "..") continue;
    await collectSftpConflicts(
      source,
      target,
      posix.join(sourcePath, child.filename),
      posix.join(targetPath, child.filename),
      conflicts,
      signal,
      translate,
      isMissingFile,
    );
  }
}

export async function removeSftpEntry(
  fileSystem: SftpPlanFileSystem,
  path: string,
  attributes: SftpPlanAttributes,
): Promise<void> {
  if (!attributes.isDirectory() || attributes.isSymbolicLink()) {
    await fileSystem.unlink(path);
    return;
  }
  for (const child of await fileSystem.readdir(path)) {
    if (child.filename === "." || child.filename === "..") continue;
    const childPath = posix.join(path, child.filename);
    await removeSftpEntry(fileSystem, childPath, await fileSystem.lstat(childPath));
  }
  await fileSystem.rmdir(path);
}

export async function ensureSftpDirectory(
  fileSystem: SftpPlanFileSystem,
  path: string,
  conflict: SftpConflict,
  decisions: Readonly<Record<string, SftpConflict>> | undefined,
  isMissingFile: IsMissingFile,
): Promise<boolean> {
  const existing = await existingSftpStats(fileSystem, path, isMissingFile);
  if (!existing) {
    await fileSystem.mkdir(path);
    return true;
  }
  if (existing.isDirectory() && !existing.isSymbolicLink()) return true;
  if (sftpConflictDecision(path, conflict, decisions) === "skip") return false;
  await removeSftpEntry(fileSystem, path, existing);
  await fileSystem.mkdir(path);
  return true;
}

export async function copySftpEntry(
  source: SftpPlanFileSystem,
  target: SftpPlanFileSystem,
  sourcePath: string,
  targetPath: string,
  conflict: SftpConflict,
  decisions: Readonly<Record<string, SftpConflict>> | undefined,
  progress: SftpTransferProgress,
  onProgress: (progress: SftpTransferProgress) => void,
  signal: AbortSignal | undefined,
  translate: Translate,
  isMissingFile: IsMissingFile,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const attributes = await source.lstat(sourcePath);
  if (attributes.isSymbolicLink()) throw new Error(translate("暂不支持传输符号链接：{{0}}", [sourcePath]));
  if (attributes.isDirectory()) {
    if (!await ensureSftpDirectory(target, targetPath, conflict, decisions, isMissingFile)) {
      const skipped = await buildSftpPlan(source, sourcePath, signal, translate);
      progress.skippedFiles += skipped.totalFiles;
      onProgress(progress);
      return;
    }
    for (const entry of await source.readdir(sourcePath)) {
      if (entry.filename === "." || entry.filename === "..") continue;
      await copySftpEntry(
        source,
        target,
        posix.join(sourcePath, entry.filename),
        posix.join(targetPath, entry.filename),
        conflict,
        decisions,
        progress,
        onProgress,
        signal,
        translate,
        isMissingFile,
      );
    }
    await target.chmod(targetPath, attributes.mode & 0o777);
    return;
  }

  const existing = await existingSftpStats(target, targetPath, isMissingFile);
  if (existing && sftpConflictDecision(targetPath, conflict, decisions) === "skip") {
    progress.skippedFiles += 1;
    onProgress(progress);
    return;
  }
  if (existing?.isDirectory() || existing?.isSymbolicLink()) await removeSftpEntry(target, targetPath, existing);
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
