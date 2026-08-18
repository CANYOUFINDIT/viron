import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import yauzl from "yauzl";
import yazl from "yazl";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { migrationWasImported, recordMigrationStaged } from "../platform-backup.js";
import {
  createMigrationManifest,
  exportPortableSnapshot,
  openMigrationMasterKey,
  rekeyPortableSnapshot,
  sha256File,
  type PlatformMigrationManifest,
} from "../platform-migration.js";
import { PRODUCT_VERSION } from "../product-info.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const settingsSchema = z.object({
  auditRetentionDays: z.number().int().min(1).max(3650),
  monitorPullIntervalSeconds: z.number().int().min(10).max(3600).optional(),
});

const migrationExportSchema = z.object({
  password: z.string().min(12).max(256),
});

function keyFingerprint(app: FastifyInstance): string {
  return createHash("sha256").update(app.config.masterKey).digest("hex").slice(0, 24);
}

async function addDirectory(zip: yazl.ZipFile, root: string, archiveRoot: string): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(root, entry.name);
      const archivePath = posix.join(archiveRoot, entry.name);
      if (entry.isDirectory()) await addDirectory(zip, path, archivePath);
      else if (entry.isFile()) zip.addFile(path, archivePath, { mode: 0o600 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createZip(zip: yazl.ZipFile, outputPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
    output.once("close", resolvePromise);
    output.once("error", reject);
    zip.outputStream.once("error", reject);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

async function extractRestore(zipPath: string, pendingDir: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("无法打开平台迁移包"));
      let fileCount = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("entry", (entry) => {
        if (settled) return;
        const archivePath = entry.fileName.replace(/\\/g, "/");
        if (archivePath.startsWith("/") || archivePath.split("/").includes("..")) return fail(new Error("平台迁移包包含不安全路径"));
        const allowed = archivePath === "manifest.json" || archivePath === "envman.db" || archivePath.startsWith("recordings/") || archivePath.startsWith("backups/");
        if (!allowed) return zip.readEntry();
        if (archivePath.endsWith("/")) return zip.readEntry();
        fileCount += 1;
        totalBytes += entry.uncompressedSize;
        if (fileCount > 100_000 || totalBytes > 5 * 1024 * 1024 * 1024) return fail(new Error("平台迁移包内容超过安全上限"));
        const destination = resolve(pendingDir, archivePath);
        if (!destination.startsWith(resolve(pendingDir) + "/") && destination !== resolve(pendingDir, "envman.db") && destination !== resolve(pendingDir, "manifest.json")) return fail(new Error("平台迁移包路径越界"));
        zip.openReadStream(entry, async (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error("无法读取平台迁移包条目"));
          try {
            await mkdir(resolve(destination, ".."), { recursive: true });
            await pipeline(stream, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
            zip.readEntry();
          } catch (error) {
            fail(error as Error);
          }
        });
      });
      zip.once("error", fail);
      zip.once("end", () => {
        if (!settled) { settled = true; resolvePromise(); }
      });
      zip.readEntry();
    });
  });
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  const requirePlatformAdmin = (request: Parameters<typeof requireAdmin>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (request.admin?.isPlatformAdmin) return true;
    void reply.code(403).send({ error: "PLATFORM_ADMIN_REQUIRED", message: "只有平台管理员可以修改平台设置和执行迁移" });
    return false;
  };

  app.get("/api/v1/settings", async () => ({
    item: {
      connectionIdleMinutes: app.activeConnections.idleMinutes,
      userConnectionLimit: app.activeConnections.limit,
      auditRetentionDays: app.config.auditRetentionDays,
      monitorPullIntervalSeconds: app.config.monitorPullIntervalSeconds ?? 60,
      databaseMode: app.db.dialect === "mysql" ? "MySQL / MariaDB" : "SQLite WAL",
      dataDir: "/data",
    },
  }));

  app.put("/api/v1/settings", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const body = parseBody(settingsSchema, request.body, reply);
    if (!body) return;
    app.config.auditRetentionDays = body.auditRetentionDays;
    app.config.monitorPullIntervalSeconds = body.monitorPullIntervalSeconds ?? app.config.monitorPullIntervalSeconds ?? 60;
    const now = new Date().toISOString();
    const upsert = app.db.prepare("INSERT INTO settings (`key`, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(`key`) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at");
    await upsert.run("auditRetentionDays", JSON.stringify(body.auditRetentionDays), now);
    await upsert.run("monitorPullIntervalSeconds", JSON.stringify(app.config.monitorPullIntervalSeconds), now);
    await writeAudit(app.db, {
      action: "settings.updated",
      resourceType: "settings",
      summary: "更新平台设置",
      details: { ...body, monitorPullIntervalSeconds: app.config.monitorPullIntervalSeconds },
      request,
    });
    return { ok: true };
  });

  app.post("/api/v1/platform-exports", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const body = parseBody(migrationExportSchema, request.body, reply);
    if (!body) return;
    const exportDir = join(app.config.dataDir, "exports");
    await mkdir(exportDir, { recursive: true });
    const id = randomUUID();
    const snapshotPath = join(exportDir, `${id}.db`);
    const archivePath = join(exportDir, `${id}.zip`);
    try {
      await exportPortableSnapshot(app.db, snapshotPath);
      const manifest = await createMigrationManifest(app.config.masterKey, body.password, app.db.dialect, await sha256File(snapshotPath));
      const zip = new yazl.ZipFile();
      zip.addFile(snapshotPath, "envman.db", { mode: 0o600 });
      zip.addBuffer(Buffer.from(JSON.stringify({ ...manifest, productVersion: PRODUCT_VERSION }, null, 2)), "manifest.json", { mode: 0o600 });
      await addDirectory(zip, join(app.config.dataDir, "recordings"), "recordings");
      await addDirectory(zip, join(app.config.dataDir, "backups"), "backups");
      await createZip(zip, archivePath);
      await rm(snapshotPath, { force: true });
      await writeAudit(app.db, { action: "platform.migration_export_created", resourceType: "platform", resourceId: id, summary: "创建密码保护的平台迁移包", request });
      return reply.code(201).send({ id, filename: `viron-migration-${new Date().toISOString().slice(0, 10)}.zip`, downloadUrl: `/api/v1/platform-exports/${id}/download` });
    } catch (error) {
      await rm(snapshotPath, { force: true });
      await rm(archivePath, { force: true });
      return reply.code(500).send({ error: "PLATFORM_EXPORT_FAILED", message: error instanceof Error ? error.message : "平台导出失败" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/platform-exports/:id/download", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "导出文件不存在" });
    const archivePath = join(app.config.dataDir, "exports", `${request.params.id}.zip`);
    try {
      const info = await stat(archivePath);
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Length", String(info.size));
      reply.header("Content-Disposition", `attachment; filename="viron-migration-${new Date().toISOString().slice(0, 10)}.zip"`);
      return reply.send(createReadStream(archivePath));
    } catch {
      return reply.code(404).send({ error: "NOT_FOUND", message: "导出文件不存在" });
    }
  });

  app.post("/api/v1/platform-restore", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const pendingDir = join(app.config.dataDir, "restore-pending");
    try {
      await stat(join(pendingDir, "restore.json"));
      return reply.code(409).send({ error: "RESTORE_ALREADY_PENDING", message: "已有恢复任务等待重启" });
    } catch { /* No pending restore. */ }
    const uploadPath = join(app.config.dataDir, `restore-upload-${randomUUID()}.zip`);
    let migrationPassword = "";
    let uploadFilename = "";
    try {
      for await (const part of request.parts({ limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 5 } })) {
        if (part.type === "file") {
          uploadFilename = part.filename;
          await pipeline(part.file, createWriteStream(uploadPath, { flags: "wx", mode: 0o600 }));
        } else if (part.fieldname === "password") {
          migrationPassword = String(part.value);
        }
      }
    } catch (error) {
      await rm(uploadPath, { force: true });
      return reply.code(400).send({ error: "PLATFORM_UPLOAD_FAILED", message: error instanceof Error ? error.message : "上传平台迁移包失败" });
    }
    if (!uploadFilename) return reply.code(400).send({ error: "FILE_REQUIRED", message: "请选择 Viron 平台迁移 ZIP" });
    if (!uploadFilename.toLowerCase().endsWith(".zip")) {
      await rm(uploadPath, { force: true });
      return reply.code(400).send({ error: "ZIP_REQUIRED", message: "平台迁移只接受 ZIP 文件" });
    }
    try {
      await mkdir(pendingDir, { recursive: false });
      await extractRestore(uploadPath, pendingDir);
      const manifest = JSON.parse(await readFile(join(pendingDir, "manifest.json"), "utf8")) as Partial<PlatformMigrationManifest> & { masterKeyFingerprint?: string };
      if (!["Viron", "EnvMan"].includes(manifest.product ?? "")) throw new Error("不是有效的 Viron 平台迁移包");
      const snapshotPath = join(pendingDir, "envman.db");
      await stat(snapshotPath);
      let migrationId: string | undefined;
      if (manifest.format === "platform-migration") {
        if (migrationPassword.length < 12 || migrationPassword.length > 256) throw new Error("迁移密码长度必须为 12–256 个字符");
        const migrationManifest = manifest as PlatformMigrationManifest;
        migrationId = migrationManifest.migrationId;
        if (!/^[0-9a-f-]{36}$/i.test(migrationId)) throw new Error("迁移包 ID 无效");
        if (migrationWasImported(app.config.dataDir, migrationId)) throw new Error("该迁移包已经在当前实例导入，不能重复执行");
        const sourceMasterKey = await openMigrationMasterKey(migrationManifest, migrationPassword);
        try {
          if (await sha256File(snapshotPath) !== migrationManifest.snapshotSha256) throw new Error("迁移包数据库快照校验失败");
          rekeyPortableSnapshot(snapshotPath, sourceMasterKey, app.config.masterKey);
        } finally {
          sourceMasterKey.fill(0);
        }
      } else {
        if (manifest.masterKeyFingerprint !== keyFingerprint(app)) throw new Error("旧版备份使用了不同的平台主密钥，无法解密其中凭据");
        rekeyPortableSnapshot(snapshotPath, app.config.masterKey, app.config.masterKey);
      }
      await writeFile(join(pendingDir, "restore.json"), JSON.stringify({ createdAt: new Date().toISOString(), snapshot: "envman.db", migrationId }, null, 2), { mode: 0o600, flag: "wx" });
      await writeAudit(app.db, { action: "platform.migration_import_staged", resourceType: "platform", resourceId: migrationId, summary: "暂存平台迁移包，等待重启", request });
      if (migrationId) recordMigrationStaged(app.config.dataDir, migrationId);
      return reply.code(202).send({ staged: true, restartRequired: true });
    } catch (error) {
      await rm(pendingDir, { recursive: true, force: true });
      return reply.code(400).send({ error: "PLATFORM_RESTORE_FAILED", message: error instanceof Error ? error.message : "平台恢复文件无效" });
    } finally {
      await rm(uploadPath, { force: true });
    }
  });
}
