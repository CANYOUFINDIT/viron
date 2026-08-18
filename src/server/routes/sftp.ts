import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { canAccessConnection, canAccessEnvironment } from "../access-control.js";
import { executionScope } from "../execution-scope.js";
import { connectSsh } from "../ssh/connector.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { ConnectionLimitError } from "../active-connections.js";

const pathSchema = z.object({ path: z.string().min(1).max(4096) });
const renameSchema = z.object({
  path: z.string().min(1).max(4096),
  newPath: z.string().min(1).max(4096),
});
const chmodSchema = z.object({
  path: z.string().min(1).max(4096),
  mode: z.string().regex(/^[0-7]{3,4}$/),
});
const transferPreviewSchema = z.object({
  sourceConnectionId: z.string().uuid(),
  targetConnectionId: z.string().uuid(),
  sourcePath: z.string().min(1).max(4096).optional(),
  sourcePaths: z.array(z.string().min(1).max(4096)).min(1).max(500).optional(),
  targetDirectory: z.string().min(1).max(4096),
}).refine((value) => Boolean(value.sourcePath || value.sourcePaths?.length), { message: "请选择要传输的文件或目录" });
const transferSchema = transferPreviewSchema.extend({
  conflict: z.enum(["overwrite", "skip"]),
  conflictDecisions: z.record(z.string().min(1).max(4096), z.enum(["overwrite", "skip"])).optional(),
  originEnvironmentId: z.string().uuid().optional(),
});
const transferRetrySchema = z.object({ originEnvironmentId: z.string().uuid().optional() });
const uploadManifestEntrySchema = z.object({
  relativePath: z.string().min(1).max(4096).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "上传路径无效"),
  type: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const uploadManifestSchema = z.object({
  targetDirectory: z.string().min(1).max(4096),
  entries: z.array(uploadManifestEntrySchema).min(1).max(10_000),
});
const uploadDirectorySchema = uploadManifestSchema.extend({
  conflictDecisions: z.record(z.string().min(1).max(4096), z.enum(["overwrite", "skip"])).optional(),
});

type SftpEntryType = "directory" | "file" | "symlink";
const SFTP_FILE_TYPE_MASK = 0o170000;
const SFTP_DIRECTORY_TYPE = 0o040000;
const SFTP_SYMLINK_TYPE = 0o120000;

function remotePath(value: string | undefined): string {
  return posix.resolve("/", value?.trim() || "/");
}

function openSftp(client: Awaited<ReturnType<typeof connectSsh>>["client"]): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function readDirectory(sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, entries) => {
      if (error) reject(error);
      else resolve(entries);
    });
  });
}

function lstat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (error, attributes) => {
      if (error) reject(error);
      else resolve(attributes);
    });
  });
}

async function existingStats(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  try {
    return await lstat(sftp, path);
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 2 || code === "ENOENT" || code === "NO_SUCH_FILE" || /no such file/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
}

function sftpEntryKind(attributes: Stats): "file" | "directory" | "symlink" {
  if (attributes.isSymbolicLink()) return "symlink";
  return attributes.isDirectory() ? "directory" : "file";
}

async function removeSftpEntry(sftp: SFTPWrapper, path: string, attributes: Stats): Promise<void> {
  if (!attributes.isDirectory() || attributes.isSymbolicLink()) {
    await sftpAction(sftp, (callback) => sftp.unlink(path, callback));
    return;
  }
  for (const entry of await readDirectory(sftp, path)) {
    if (entry.filename === "." || entry.filename === "..") continue;
    const childPath = posix.join(path, entry.filename);
    await removeSftpEntry(sftp, childPath, await lstat(sftp, childPath));
  }
  await sftpAction(sftp, (callback) => sftp.rmdir(path, callback));
}

function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, attributes) => {
      if (error) reject(error);
      else resolve(attributes);
    });
  });
}

function sftpAction(sftp: SFTPWrapper, action: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    action((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withSftp<T>(app: FastifyInstance, connectionId: string, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const connected = await connectSsh(app, connectionId);
  try {
    const sftp = await openSftp(connected.client);
    return await action(sftp);
  } finally {
    connected.close();
  }
}

function modeText(mode: number | undefined): string {
  return ((mode ?? 0) & 0o7777).toString(8).padStart(3, "0");
}

export function sftpEntryTypeFromMetadata(attributes: Stats, longname = ""): SftpEntryType | null {
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

async function resolveSftpListItem(sftp: SFTPWrapper, parentPath: string, entry: FileEntryWithStats) {
  const path = posix.join(parentPath, entry.filename);
  let attributes = entry.attrs;
  let type = sftpEntryTypeFromMetadata(attributes, entry.longname);
  if (!type) {
    try {
      attributes = await lstat(sftp, path);
      type = sftpEntryTypeFromMetadata(attributes);
    } catch {
      // Keep the directory listing usable when a single entry disappears during refresh.
    }
  }
  type ??= "file";
  let targetType: "directory" | "file" | null = null;
  if (type === "symlink") {
    try {
      const resolved = sftpEntryTypeFromMetadata(await stat(sftp, path));
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
    modifiedAt: new Date(attributes.mtime * 1000).toISOString(),
  };
}

export async function registerSftpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/api/v1/ssh-connections/:id/sftp")) return;
    const connectionId = (request.params as { id?: string }).id;
    if (connectionId && !await canAccessConnection(app.db, request.admin!, "ssh", connectionId)) {
      await reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    }
  });

  app.get("/api/v1/sftp-transfers", async (request) => ({
    items: app.sftpTransfers.list(request.admin!, executionScope(request)),
  }));

  app.post("/api/v1/sftp-transfers/preview", async (request, reply) => {
    const body = parseBody(transferPreviewSchema, request.body, reply);
    if (!body) return;
    const [sourceAllowed, targetAllowed] = await Promise.all([
      canAccessConnection(app.db, request.admin!, "ssh", body.sourceConnectionId),
      canAccessConnection(app.db, request.admin!, "ssh", body.targetConnectionId),
    ]);
    if (!sourceAllowed || !targetAllowed) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    try {
      return await app.sftpTransfers.preview(body);
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_TRANSFER_PREVIEW_FAILED", message: error instanceof Error ? error.message : "无法检查传输内容" });
    }
  });

  app.post("/api/v1/sftp-transfers", async (request, reply) => {
    const body = parseBody(transferSchema, request.body, reply);
    if (!body) return;
    const [sourceAllowed, targetAllowed] = await Promise.all([
      canAccessConnection(app.db, request.admin!, "ssh", body.sourceConnectionId),
      canAccessConnection(app.db, request.admin!, "ssh", body.targetConnectionId),
    ]);
    if (!sourceAllowed || !targetAllowed) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    if (body.originEnvironmentId && !await canAccessEnvironment(app.db, request.admin!, body.originEnvironmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "来源环境不存在或无权访问" });
    }
    try {
      const task = await app.sftpTransfers.create(request.admin!, body, executionScope(request));
      await writeAudit(app.db, {
        action: "sftp.transfer_started",
        resourceType: "ssh_connection",
        resourceId: body.sourceConnectionId,
        summary: `启动 SFTP 主机间传输 ${task.sourceConnectionName} → ${task.targetConnectionName}`,
        details: { taskId: task.id, sourcePath: task.sourcePath, sourcePaths: task.sourcePaths, targetConnectionId: task.targetConnectionId, targetPath: task.targetPath, conflict: task.conflict },
        request,
      });
      return reply.code(201).send({ task });
    } catch (error) {
      return reply.code(error instanceof ConnectionLimitError ? 409 : 429).send({ error: error instanceof ConnectionLimitError ? error.code : "SFTP_TRANSFER_START_FAILED", message: error instanceof Error ? error.message : "无法开始 SFTP 传输" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/sftp-transfers/:id", async (request, reply) => {
    if (!app.sftpTransfers.cancel(request.params.id, request.admin!, executionScope(request))) {
      return reply.code(409).send({ error: "SFTP_TRANSFER_NOT_RUNNING", message: "传输任务已经结束或不存在" });
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/sftp-transfers/:id/retry", async (request, reply) => {
    const body = parseBody(transferRetrySchema, request.body ?? {}, reply);
    if (!body) return;
    const previous = app.sftpTransfers.get(request.params.id, request.admin!, executionScope(request));
    if (!previous) return reply.code(404).send({ error: "SFTP_TRANSFER_NOT_FOUND", message: "传输任务不存在" });
    const [sourceAllowed, targetAllowed] = await Promise.all([
      canAccessConnection(app.db, request.admin!, "ssh", previous.sourceConnectionId),
      canAccessConnection(app.db, request.admin!, "ssh", previous.targetConnectionId),
    ]);
    if (!sourceAllowed || !targetAllowed) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    if (body.originEnvironmentId && !await canAccessEnvironment(app.db, request.admin!, body.originEnvironmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "来源环境不存在或无权访问" });
    }
    try {
      const task = await app.sftpTransfers.retry(request.params.id, request.admin!, executionScope(request), body.originEnvironmentId);
      if (!task) return reply.code(409).send({ error: "SFTP_TRANSFER_NOT_RETRYABLE", message: "只有失败或已取消的任务可以重试" });
      return reply.code(201).send({ task });
    } catch (error) {
      return reply.code(error instanceof ConnectionLimitError ? 409 : 429).send({ error: error instanceof ConnectionLimitError ? error.code : "SFTP_TRANSFER_START_FAILED", message: error instanceof Error ? error.message : "无法重试 SFTP 传输" });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/v1/ssh-connections/:id/sftp", async (request, reply) => {
    const path = remotePath(request.query.path);
    try {
      const items = await withSftp(app, request.params.id, async (sftp) => {
        const entries = await readDirectory(sftp, path);
        const items = await Promise.all(entries
          .filter((entry) => entry.filename !== "." && entry.filename !== "..")
          .map((entry) => resolveSftpListItem(sftp, path, entry)));
        return items.sort((left, right) => {
            const leftDirectory = left.type === "directory" || left.targetType === "directory";
            const rightDirectory = right.type === "directory" || right.targetType === "directory";
            if (leftDirectory && !rightDirectory) return -1;
            if (!leftDirectory && rightDirectory) return 1;
            return left.name.localeCompare(right.name, "zh-CN");
          });
      });
      return { path, parentPath: path === "/" ? null : posix.dirname(path), items };
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_LIST_FAILED", message: error instanceof Error ? error.message : "读取远程目录失败" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-connections/:id/sftp/mkdir", async (request, reply) => {
    const body = parseBody(pathSchema, request.body, reply);
    if (!body) return;
    const path = remotePath(body.path);
    try {
      await withSftp(app, request.params.id, (sftp) => sftpAction(sftp, (callback) => sftp.mkdir(path, callback)));
      await writeAudit(app.db, { action: "sftp.mkdir", resourceType: "ssh_connection", resourceId: request.params.id, summary: `创建远程目录 ${path}`, details: { path }, request });
      return reply.code(201).send({ path });
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_MKDIR_FAILED", message: error instanceof Error ? error.message : "创建远程目录失败" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-connections/:id/sftp/rename", async (request, reply) => {
    const body = parseBody(renameSchema, request.body, reply);
    if (!body) return;
    const path = remotePath(body.path);
    const newPath = remotePath(body.newPath);
    try {
      await withSftp(app, request.params.id, (sftp) => sftpAction(sftp, (callback) => sftp.rename(path, newPath, callback)));
      await writeAudit(app.db, { action: "sftp.rename", resourceType: "ssh_connection", resourceId: request.params.id, summary: `重命名远程文件 ${path}`, details: { path, newPath }, request });
      return { path: newPath };
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_RENAME_FAILED", message: error instanceof Error ? error.message : "重命名失败" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-connections/:id/sftp/chmod", async (request, reply) => {
    const body = parseBody(chmodSchema, request.body, reply);
    if (!body) return;
    const path = remotePath(body.path);
    try {
      await withSftp(app, request.params.id, (sftp) => sftpAction(sftp, (callback) => sftp.chmod(path, body.mode, callback)));
      await writeAudit(app.db, { action: "sftp.chmod", resourceType: "ssh_connection", resourceId: request.params.id, summary: `修改远程权限 ${path}`, details: { path, mode: body.mode }, request });
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_CHMOD_FAILED", message: error instanceof Error ? error.message : "修改权限失败" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/ssh-connections/:id/sftp", async (request, reply) => {
    const body = parseBody(pathSchema, request.body, reply);
    if (!body) return;
    const path = remotePath(body.path);
    if (path === "/") return reply.code(400).send({ error: "ROOT_DELETE_FORBIDDEN", message: "不能删除根目录" });
    try {
      const itemType = await withSftp(app, request.params.id, async (sftp) => {
        const attributes = await lstat(sftp, path);
        if (attributes.isDirectory()) {
          await sftpAction(sftp, (callback) => sftp.rmdir(path, callback));
          return "directory";
        }
        await sftpAction(sftp, (callback) => sftp.unlink(path, callback));
        return "file";
      });
      await writeAudit(app.db, { action: "sftp.deleted", resourceType: "ssh_connection", resourceId: request.params.id, summary: `删除远程${itemType === "directory" ? "目录" : "文件"} ${path}`, details: { path, itemType }, request });
      return reply.code(204).send();
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_DELETE_FAILED", message: error instanceof Error ? error.message : "删除失败，目录必须为空" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-connections/:id/sftp/upload-preview", async (request, reply) => {
    const body = parseBody(uploadManifestSchema, request.body, reply);
    if (!body) return;
    const targetDirectory = remotePath(body.targetDirectory);
    try {
      const conflicts = await withSftp(app, request.params.id, async (sftp) => {
        const result: Array<{ sourcePath: string; targetPath: string; sourceType: "file" | "directory"; targetType: "file" | "directory" | "symlink" }> = [];
        const unavailablePrefixes: string[] = [];
        const entries = [...body.entries].sort((left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length || Number(right.type === "directory") - Number(left.type === "directory"));
        for (const entry of entries) {
          if (unavailablePrefixes.some((prefix) => entry.relativePath.startsWith(`${prefix}/`))) continue;
          const targetPath = posix.join(targetDirectory, entry.relativePath);
          const existing = await existingStats(sftp, targetPath);
          if (!existing) {
            if (entry.type === "directory") unavailablePrefixes.push(entry.relativePath);
            continue;
          }
          const targetType = sftpEntryKind(existing);
          if (entry.type === "directory" && targetType === "directory") continue;
          result.push({ sourcePath: entry.relativePath, targetPath, sourceType: entry.type, targetType });
          if (entry.type === "directory") unavailablePrefixes.push(entry.relativePath);
        }
        return result;
      });
      return {
        sourceName: body.entries.length === 1 ? posix.basename(body.entries[0].relativePath) : `${body.entries.length} 项`,
        sourceType: body.entries.length === 1 ? body.entries[0].type : "directory",
        sourcePath: body.entries[0].relativePath,
        sourcePaths: body.entries.map((entry) => entry.relativePath),
        targetPath: targetDirectory,
        targetExists: conflicts.length > 0,
        totalBytes: body.entries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0),
        totalFiles: body.entries.filter((entry) => entry.type === "file").length,
        conflicts,
      };
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_UPLOAD_PREVIEW_FAILED", message: error instanceof Error ? error.message : "无法检查上传内容" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-connections/:id/sftp/upload-directories", async (request, reply) => {
    const body = parseBody(uploadDirectorySchema, request.body, reply);
    if (!body) return;
    const targetDirectory = remotePath(body.targetDirectory);
    try {
      const skippedDirectories = await withSftp(app, request.params.id, async (sftp) => {
        const skipped: string[] = [];
        const directories = body.entries.filter((entry) => entry.type === "directory")
          .sort((left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length);
        for (const entry of directories) {
          if (skipped.some((prefix) => entry.relativePath.startsWith(`${prefix}/`))) continue;
          const targetPath = posix.join(targetDirectory, entry.relativePath);
          const existing = await existingStats(sftp, targetPath);
          if (!existing) {
            await sftpAction(sftp, (callback) => sftp.mkdir(targetPath, callback));
            continue;
          }
          if (existing.isDirectory() && !existing.isSymbolicLink()) continue;
          if (body.conflictDecisions?.[targetPath] !== "overwrite") {
            skipped.push(entry.relativePath);
            continue;
          }
          await removeSftpEntry(sftp, targetPath, existing);
          await sftpAction(sftp, (callback) => sftp.mkdir(targetPath, callback));
        }
        return skipped;
      });
      return { skippedDirectories };
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_UPLOAD_DIRECTORIES_FAILED", message: error instanceof Error ? error.message : "无法创建上传目录" });
    }
  });

  app.post<{ Params: { id: string }; Querystring: { path?: string; filename?: string; conflict?: "overwrite" | "skip" } }>("/api/v1/ssh-connections/:id/sftp/upload", async (request, reply) => {
    const directory = remotePath(request.query.path);
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "FILE_REQUIRED", message: "请选择上传文件" });
    const filename = posix.basename(request.query.filename || part.filename);
    const destination = posix.join(directory, filename);
    try {
      const uploaded = await withSftp(app, request.params.id, async (sftp) => {
        const existing = await existingStats(sftp, destination);
        if (existing && request.query.conflict !== "overwrite") {
          part.file.resume();
          return false;
        }
        if (existing?.isDirectory() || existing?.isSymbolicLink()) await removeSftpEntry(sftp, destination, existing);
        await pipeline(part.file, sftp.createWriteStream(destination, { flags: "w", mode: 0o640 }));
        return true;
      });
      if (!uploaded) return { path: destination, skipped: true };
      await writeAudit(app.db, { action: "sftp.upload", resourceType: "ssh_connection", resourceId: request.params.id, summary: `上传远程文件 ${destination}`, details: { destination, filename }, request });
      return reply.code(201).send({ path: destination, skipped: false });
    } catch (error) {
      return reply.code(502).send({ error: "SFTP_UPLOAD_FAILED", message: error instanceof Error ? error.message : "上传文件失败" });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/v1/ssh-connections/:id/sftp/download", async (request, reply) => {
    const path = remotePath(request.query.path);
    const connected = await connectSsh(app, request.params.id);
    try {
      const sftp = await openSftp(connected.client);
      const attributes = await lstat(sftp, path);
      if (attributes.isDirectory()) {
        connected.close();
        return reply.code(400).send({ error: "DIRECTORY_DOWNLOAD_UNSUPPORTED", message: "请进入目录后逐个下载文件" });
      }
      const stream = sftp.createReadStream(path);
      const close = () => connected.close();
      stream.once("close", close);
      stream.once("error", close);
      await writeAudit(app.db, { action: "sftp.download", resourceType: "ssh_connection", resourceId: request.params.id, summary: `下载远程文件 ${path}`, details: { path, size: attributes.size }, request });
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Length", String(attributes.size));
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(path))}`);
      return reply.send(stream);
    } catch (error) {
      connected.close();
      return reply.code(502).send({ error: "SFTP_DOWNLOAD_FAILED", message: error instanceof Error ? error.message : "下载文件失败" });
    }
  });
}
