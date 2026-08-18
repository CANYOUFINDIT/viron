import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { canAccessWebCredential } from "../access-control.js";
import { executionScope } from "../execution-scope.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { ConnectionLimitError } from "../active-connections.js";

const openViewSchema = z.object({
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(240).max(1200).default(720),
  initialPage: z.enum(["entry", "blank"]).default("entry"),
  preload: z.boolean().default(false),
});

function safeUploadFilename(value: string): string {
  const cleaned = basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "upload" : cleaned;
}

export async function registerWebAccountViewRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/api/v1/web-credentials/:id/view",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = parseBody(openViewSchema, request.body, reply);
      if (!body || !request.admin) return;
      if (!await canAccessWebCredential(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      try {
        return await app.webAccountViews.create(request.admin, request.params.id, body.width, body.height, executionScope(request), body.initialPage, body.preload);
      } catch (error) {
        return reply.code(error instanceof ConnectionLimitError ? 409 : 503).send({
          error: error instanceof ConnectionLimitError ? error.code : "WEB_VIEW_UNAVAILABLE",
          message: error instanceof Error ? error.message : "账号页面启动失败",
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/web-credentials/:id/view/reset",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!request.admin) return;
      if (!await canAccessWebCredential(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      const credential = await app.db.prepare("SELECT username FROM web_credentials WHERE id = ?").get(request.params.id) as { username: string } | undefined;
      if (!credential) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      await app.webAccountViews.reset(request.admin.id, request.params.id, executionScope(request));
      await writeAudit(app.db, {
        action: "web_account_view.reset",
        resourceType: "web_credential",
        resourceId: request.params.id,
        summary: `重新登录 Web 账号 ${credential.username}`,
        request,
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/web-credentials/:id/view",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!request.admin) return;
      if (!await canAccessWebCredential(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      await app.webAccountViews.closeCredential(request.admin.id, request.params.id, executionScope(request), "页面预热已取消");
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/web-credentials/:id/view/upload",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!request.admin) return;
      if (!await canAccessWebCredential(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "FILE_REQUIRED", message: "请选择要上传的文件" });
      const directory = join(app.config.dataDir, "web-uploads", request.admin.id, request.params.id, randomUUID());
      mkdirSync(directory, { recursive: true });
      const path = join(directory, safeUploadFilename(file.filename));
      try {
        await pipeline(file.file, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        await app.webAccountViews.setUpload(request.admin.id, request.params.id, path, executionScope(request));
        return { ok: true };
      } catch (error) {
        return reply.code(409).send({
          error: "UPLOAD_NOT_ACCEPTED",
          message: error instanceof Error ? error.message : "页面未接受上传文件",
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/web-view-downloads/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!request.admin) return;
      const download = app.webAccountViews.getDownload(request.admin.id, request.params.id, executionScope(request));
      if (!download) return reply.code(404).send({ error: "DOWNLOAD_NOT_FOUND", message: "下载文件不存在或已经过期" });
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Length", String(download.size));
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`);
      reply.raw.once("finish", download.cleanup);
      reply.raw.once("close", download.cleanup);
      return reply.send(download.stream);
    },
  );

  app.get<{ Querystring: { ticket?: string } }>("/ws/web-account-view", { websocket: true }, (socket, request) => {
    const ticket = request.query.ticket;
    if (!ticket) {
      socket.close(4000, "缺少页面票据");
      return;
    }
    app.webAccountViews.attach(ticket, socket);
  });
}
