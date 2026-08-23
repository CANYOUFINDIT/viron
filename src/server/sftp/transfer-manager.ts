import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import {
  buildSftpPlan,
  collectSftpConflicts,
  copySftpEntry,
  isSftpMissingFileCode,
  type SftpConflict,
  type SftpPlanFileSystem,
  type SftpTransferConflictItem as SharedSftpTransferConflictItem,
  type SftpTransferPlan,
  type SftpTransferProgress,
} from "../../shared/sftp-transfer-plan.js";
import type { AuthenticatedUser, WorkspaceType } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { connectSsh, loadSshConnection, type ConnectedSsh } from "../ssh/connector.js";

export type SftpTransferConflict = SftpConflict;
export type SftpTransferStatus = "pending" | "running" | "success" | "error" | "cancelled";

export interface SftpTransferOptions {
  sourceConnectionId: string;
  targetConnectionId: string;
  sourcePath?: string;
  sourcePaths?: string[];
  targetDirectory: string;
  conflict: SftpTransferConflict;
  conflictDecisions?: Record<string, SftpTransferConflict>;
  originEnvironmentId?: string;
}

interface NormalizedSftpTransferOptions extends SftpTransferOptions {
  sourcePath: string;
  sourcePaths: string[];
}

export interface PublicSftpTransferTask {
  id: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  sourcePath: string;
  sourcePaths: string[];
  targetConnectionId: string;
  targetConnectionName: string;
  targetPath: string;
  conflict: SftpTransferConflict;
  status: SftpTransferStatus;
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

export interface SftpTransferPreview {
  sourceName: string;
  sourceType: "file" | "directory";
  sourcePath: string;
  sourcePaths: string[];
  targetPath: string;
  targetExists: boolean;
  totalBytes: number;
  totalFiles: number;
  conflicts: SftpTransferConflictItem[];
}

export type SftpTransferConflictItem = SharedSftpTransferConflictItem;

interface TransferTask extends PublicSftpTransferTask {
  ownerId: string;
  executionScope: string | null;
  workspaceType: WorkspaceType;
  workspaceId: string;
  options: NormalizedSftpTransferOptions;
  abortController: AbortController;
  activeConnections: Set<ConnectedSsh>;
  runPromise: Promise<void> | null;
}

type TransferPlan = SftpTransferPlan;
type TransferProgress = SftpTransferProgress;

export interface TransferSftp {
  lstat(path: string, callback: (error: Error | undefined, attributes: Stats) => void): void;
  readdir(path: string, callback: (error: Error | undefined, entries: FileEntryWithStats[]) => void): void;
  mkdir(path: string, callback: (error?: Error | null) => void): void;
  rmdir(path: string, callback: (error?: Error | null) => void): void;
  unlink(path: string, callback: (error?: Error | null) => void): void;
  chmod(path: string, mode: number | string, callback: (error?: Error | null) => void): void;
  createReadStream(path: string): Readable;
  createWriteStream(path: string, options?: { flags?: string; mode?: number }): Writable;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCancelled(task: TransferTask): boolean {
  return task.status === "cancelled";
}

function normalizePath(value: string): string {
  return posix.resolve("/", value.trim() || "/");
}

function normalizedSourcePaths(options: Pick<SftpTransferOptions, "sourcePath" | "sourcePaths">): string[] {
  const raw = options.sourcePaths?.length ? options.sourcePaths : options.sourcePath ? [options.sourcePath] : [];
  return [...new Set(raw.map(normalizePath))];
}

function openSftp(client: ConnectedSsh["client"]): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => error ? reject(error) : resolve(sftp));
  });
}

function lstat(sftp: TransferSftp, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (error, attributes) => error ? reject(error) : resolve(attributes));
  });
}

function readdir(sftp: TransferSftp, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, entries) => error ? reject(error) : resolve(entries));
  });
}

function action(run: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    run((error) => error ? reject(error) : resolve());
  });
}

function sftpPlanFileSystem(sftp: TransferSftp): SftpPlanFileSystem {
  return {
    lstat: (path) => lstat(sftp, path),
    readdir: (path) => readdir(sftp, path),
    mkdir: (path) => action((callback) => sftp.mkdir(path, callback)),
    rmdir: (path) => action((callback) => sftp.rmdir(path, callback)),
    unlink: (path) => action((callback) => sftp.unlink(path, callback)),
    chmod: (path, mode) => action((callback) => sftp.chmod(path, mode, callback)),
    createReadStream: (path) => sftp.createReadStream(path),
    createWriteStream: (path, options) => sftp.createWriteStream(path, options),
  };
}

function serverSftpMissingFile(error: unknown): boolean {
  return isSftpMissingFileCode(error) || /no such file/i.test(errorMessage(error));
}

function serverSftpTranslate(key: string, values: readonly unknown[] = []): string {
  return key.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => String(values[Number(index)] ?? ""));
}

export async function transferSftpEntry(
  source: TransferSftp,
  target: TransferSftp,
  sourcePath: string,
  targetPath: string,
  conflict: SftpTransferConflict,
  onProgress: (progress: TransferProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<TransferPlan & TransferProgress> {
  const sourceFileSystem = sftpPlanFileSystem(source);
  const targetFileSystem = sftpPlanFileSystem(target);
  const plan = await buildSftpPlan(sourceFileSystem, sourcePath, signal, serverSftpTranslate);
  const progress: TransferProgress = { transferredBytes: 0, completedFiles: 0, skippedFiles: 0 };
  await copySftpEntry(
    sourceFileSystem,
    targetFileSystem,
    sourcePath,
    targetPath,
    conflict,
    undefined,
    progress,
    onProgress,
    signal,
    serverSftpTranslate,
    serverSftpMissingFile,
  );
  return { ...plan, ...progress };
}

export class SftpTransferManager {
  private readonly tasks = new Map<string, TransferTask>();

  constructor(private readonly app: FastifyInstance) {}

  async preview(options: Omit<SftpTransferOptions, "conflict">): Promise<SftpTransferPreview> {
    const sourcePaths = normalizedSourcePaths(options);
    const targetDirectory = normalizePath(options.targetDirectory);
    if (!sourcePaths.length) throw new Error("请选择要传输的文件或目录");
    if (sourcePaths.includes("/")) throw new Error("不能传输远端根目录");
    const source = await connectSsh(this.app, options.sourceConnectionId);
    const target = await connectSsh(this.app, options.targetConnectionId);
    try {
      const [sourceSftp, targetSftp] = await Promise.all([openSftp(source.client), openSftp(target.client)]);
      const sourceFileSystem = sftpPlanFileSystem(sourceSftp as TransferSftp);
      const targetFileSystem = sftpPlanFileSystem(targetSftp as TransferSftp);
      const plans = await Promise.all(sourcePaths.map((sourcePath) => buildSftpPlan(sourceFileSystem, sourcePath, undefined, serverSftpTranslate)));
      const conflicts: SftpTransferConflictItem[] = [];
      for (const [index, sourcePath] of sourcePaths.entries()) {
        const targetPath = posix.join(targetDirectory, posix.basename(sourcePath));
        this.assertSafeDestination(options.sourceConnectionId, options.targetConnectionId, sourcePath, targetPath, plans[index].sourceType);
        await collectSftpConflicts(sourceFileSystem, targetFileSystem, sourcePath, targetPath, conflicts, undefined, serverSftpTranslate, serverSftpMissingFile);
      }
      const sourcePath = sourcePaths[0];
      const plan = plans[0];
      const targetPath = sourcePaths.length === 1 ? posix.join(targetDirectory, posix.basename(sourcePath)) : targetDirectory;
      return {
        sourceName: sourcePaths.length === 1 ? posix.basename(sourcePath) : `${sourcePaths.length} 项`,
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

  async create(user: AuthenticatedUser, rawOptions: SftpTransferOptions, executionScope: string | null = null): Promise<PublicSftpTransferTask> {
    const active = [...this.tasks.values()].filter((task) => ["pending", "running"].includes(task.status)).length;
    if (active >= 3) throw new Error("SFTP 后台传输已达到 3 个并发上限");
    const sourcePaths = normalizedSourcePaths(rawOptions);
    if (!sourcePaths.length) throw new Error("请选择要传输的文件或目录");
    const options: NormalizedSftpTransferOptions = {
      ...rawOptions,
      sourcePath: sourcePaths[0],
      sourcePaths,
      targetDirectory: normalizePath(rawOptions.targetDirectory),
    };
    if (options.sourcePaths.includes("/")) throw new Error("不能传输远端根目录");
    for (const sourcePath of options.sourcePaths) {
      this.assertSafeDestination(options.sourceConnectionId, options.targetConnectionId, sourcePath, posix.join(options.targetDirectory, posix.basename(sourcePath)));
    }
    const targetPath = options.sourcePaths.length === 1 ? posix.join(options.targetDirectory, posix.basename(options.sourcePath)) : options.targetDirectory;
    const [sourceConnection, targetConnection] = await Promise.all([
      loadSshConnection(this.app, options.sourceConnectionId),
      loadSshConnection(this.app, options.targetConnectionId),
    ]);
    const id = randomUUID();
    await this.app.activeConnections.reserve({
      id,
      user,
      type: "sftp",
      resourceId: options.sourceConnectionId,
      relatedResourceId: options.targetConnectionId,
      originEnvironmentId: options.originEnvironmentId,
      executionScope,
    });
    const createdAt = new Date().toISOString();
    const task: TransferTask = {
      id,
      ownerId: user.id,
      executionScope,
      workspaceType: user.workspace.type,
      workspaceId: user.workspace.id,
      options,
      sourceConnectionId: options.sourceConnectionId,
      sourceConnectionName: sourceConnection.name,
      sourcePath: options.sourcePath,
      sourcePaths: options.sourcePaths,
      targetConnectionId: options.targetConnectionId,
      targetConnectionName: targetConnection.name,
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
      createdAt,
      abortController: new AbortController(),
      activeConnections: new Set(),
      runPromise: null,
    };
    this.tasks.set(task.id, task);
    this.app.activeConnections.activate(task.id, (reason) => this.cancelTask(task, reason));
    this.trimCompletedTasks();
    task.runPromise = this.run(task);
    void task.runPromise.finally(() => { task.runPromise = null; });
    return this.publicTask(task);
  }

  list(user: AuthenticatedUser, executionScope: string | null = null): PublicSftpTransferTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.ownerId === user.id && task.workspaceType === user.workspace.type && task.workspaceId === user.workspace.id
        && (!["pending", "running"].includes(task.status) || task.executionScope === executionScope))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => this.publicTask(task));
  }

  activeCount(ownerId: string, executionScope: string | null): number {
    return [...this.tasks.values()].filter((task) => task.ownerId === ownerId && task.executionScope === executionScope && ["pending", "running"].includes(task.status)).length;
  }

  get(id: string, user: AuthenticatedUser, executionScope: string | null = null): PublicSftpTransferTask | undefined {
    const task = this.taskForUser(id, user, executionScope);
    return task ? this.publicTask(task) : undefined;
  }

  async retry(id: string, user: AuthenticatedUser, executionScope: string | null = null, originEnvironmentId?: string): Promise<PublicSftpTransferTask | undefined> {
    const task = this.taskForUser(id, user, executionScope);
    if (!task || !["error", "cancelled"].includes(task.status)) return undefined;
    return this.create(user, { ...task.options, originEnvironmentId }, executionScope);
  }

  cancel(id: string, user: AuthenticatedUser, executionScope: string | null = null): boolean {
    const task = this.taskForUser(id, user, executionScope);
    if (!task || !["pending", "running"].includes(task.status)) return false;
    task.status = "cancelled";
    task.error = "任务已由用户取消";
    task.completedAt = new Date().toISOString();
    task.abortController.abort(new Error(task.error));
    for (const connected of task.activeConnections) connected.client.destroy();
    this.app.activeConnections.release(task.id);
    return true;
  }

  async closeOwner(ownerId: string, executionScope?: string | null): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      if (task.ownerId !== ownerId || !["pending", "running"].includes(task.status) || (executionScope !== undefined && task.executionScope !== executionScope)) continue;
      this.cancelTask(task, "用户访问已失效");
      if (task.runPromise) runs.push(task.runPromise);
    }
    await Promise.allSettled(runs);
  }

  async closeAll(): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      if (!["pending", "running"].includes(task.status)) continue;
      this.cancelTask(task, "Viron 服务停止导致任务中断", "error");
      if (task.runPromise) runs.push(task.runPromise);
    }
    await Promise.allSettled(runs);
  }

  private async run(task: TransferTask): Promise<void> {
    task.status = "running";
    this.app.activeConnections.touch(task.id);
    task.startedAt = new Date().toISOString();
    const startedAt = Date.now();
    let source: ConnectedSsh | undefined;
    let target: ConnectedSsh | undefined;
    try {
      [source, target] = await Promise.all([
        connectSsh(this.app, task.sourceConnectionId),
        connectSsh(this.app, task.targetConnectionId),
      ]);
      task.activeConnections.add(source);
      task.activeConnections.add(target);
      const [sourceSftp, targetSftp] = await Promise.all([openSftp(source.client), openSftp(target.client)]);
      const sourceFileSystem = sftpPlanFileSystem(sourceSftp as TransferSftp);
      const targetFileSystem = sftpPlanFileSystem(targetSftp as TransferSftp);
      const plans = await Promise.all(task.sourcePaths.map((sourcePath) => buildSftpPlan(sourceFileSystem, sourcePath, task.abortController.signal, serverSftpTranslate)));
      for (const [index, sourcePath] of task.sourcePaths.entries()) {
        this.assertSafeDestination(task.sourceConnectionId, task.targetConnectionId, sourcePath, posix.join(task.options.targetDirectory, posix.basename(sourcePath)), plans[index].sourceType);
      }
      task.totalBytes = plans.reduce((total, plan) => total + plan.totalBytes, 0);
      task.totalFiles = plans.reduce((total, plan) => total + plan.totalFiles, 0);
      const progress: TransferProgress = { transferredBytes: 0, completedFiles: 0, skippedFiles: 0 };
      const onProgress = (next: TransferProgress) => {
          const progress = next;
          const delta = Math.max(0, progress.transferredBytes - task.transferredBytes);
          task.transferredBytes = progress.transferredBytes;
          task.completedFiles = progress.completedFiles;
          task.skippedFiles = progress.skippedFiles;
          const elapsedSeconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
          task.speedBytesPerSecond = Math.round(task.transferredBytes / elapsedSeconds);
          const processedFiles = task.completedFiles + task.skippedFiles;
          task.progress = task.totalBytes > 0
            ? Math.min(99, Math.round((task.transferredBytes / task.totalBytes) * 100))
            : Math.min(99, Math.round((processedFiles / Math.max(1, task.totalFiles)) * 100));
          this.app.activeConnections.recordTraffic(task.id, { sentBytes: delta, receivedBytes: delta });
        };
      for (const sourcePath of task.sourcePaths) {
        await copySftpEntry(
          sourceFileSystem,
          targetFileSystem,
          sourcePath,
          posix.join(task.options.targetDirectory, posix.basename(sourcePath)),
          task.conflict,
          task.options.conflictDecisions,
          progress,
          onProgress,
          task.abortController.signal,
          serverSftpTranslate,
          serverSftpMissingFile,
        );
      }
      task.transferredBytes = progress.transferredBytes;
      task.completedFiles = progress.completedFiles;
      task.skippedFiles = progress.skippedFiles;
      if (!isCancelled(task)) {
        task.status = "success";
        task.progress = 100;
      }
    } catch (error) {
      if (!isCancelled(task)) {
        task.status = "error";
        task.error = errorMessage(error);
      }
    } finally {
      task.completedAt ??= new Date().toISOString();
      source?.close();
      target?.close();
      task.activeConnections.clear();
      this.app.activeConnections.release(task.id);
      await writeAudit(this.app.db, {
        action: `sftp.transfer_${task.status}`,
        resourceType: "ssh_connection",
        resourceId: task.sourceConnectionId,
        summary: `SFTP 主机间传输 ${task.sourceConnectionName} → ${task.targetConnectionName} · ${task.status}`,
        details: {
          taskId: task.id,
          sourcePath: task.sourcePath,
          sourcePaths: task.sourcePaths,
          targetConnectionId: task.targetConnectionId,
          targetPath: task.targetPath,
          status: task.status,
          transferredBytes: task.transferredBytes,
          completedFiles: task.completedFiles,
          skippedFiles: task.skippedFiles,
          error: task.error,
        },
        actorUserId: task.ownerId,
        workspaceType: task.workspaceType,
        workspaceId: task.workspaceId,
      });
    }
  }

  private taskForUser(id: string, user: AuthenticatedUser, executionScope: string | null): TransferTask | undefined {
    const task = this.tasks.get(id);
    if (!task || task.ownerId !== user.id || task.workspaceType !== user.workspace.type || task.workspaceId !== user.workspace.id) return undefined;
    if (["pending", "running"].includes(task.status) && task.executionScope !== executionScope) return undefined;
    return task;
  }

  private cancelTask(task: TransferTask, message: string, status: SftpTransferStatus = "cancelled"): void {
    task.status = status;
    task.error = message;
    task.completedAt = new Date().toISOString();
    task.abortController.abort(new Error(message));
    for (const connected of task.activeConnections) connected.client.destroy();
    this.app.activeConnections.release(task.id);
  }

  private publicTask(task: TransferTask): PublicSftpTransferTask {
    const {
      ownerId: _ownerId,
      workspaceType: _workspaceType,
      workspaceId: _workspaceId,
      options: _options,
      abortController: _abortController,
      activeConnections: _activeConnections,
      runPromise: _runPromise,
      ...publicTask
    } = task;
    return publicTask;
  }

  private trimCompletedTasks(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => !["pending", "running"].includes(task.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const task of completed.slice(100)) this.tasks.delete(task.id);
  }

  private assertSafeDestination(
    sourceConnectionId: string,
    targetConnectionId: string,
    sourcePath: string,
    targetPath: string,
    sourceType?: "file" | "directory",
  ): void {
    if (sourceConnectionId !== targetConnectionId) return;
    if (sourcePath === targetPath) throw new Error("来源和目标不能是同一路径");
    if (sourceType === "directory" && targetPath.startsWith(`${sourcePath}/`)) throw new Error("目标目录不能位于来源目录内部");
  }
}
