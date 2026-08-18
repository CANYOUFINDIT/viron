import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { canAccessEnvironment, canAccessEnvironmentLog, canManageWorkspace } from "../access-control.js";
import {
  DEFAULT_ENVIRONMENT_LOG_LINES,
  MAX_ENVIRONMENT_LOG_FILES,
  MAX_ENVIRONMENT_LOG_LINES,
  MIN_ENVIRONMENT_LOG_LINES,
  parseStoredLogFilePaths,
} from "../environment-log-files.js";
import { parseBody } from "../validation.js";
import { executionScope } from "../execution-scope.js";
import { requireAdmin } from "./auth.js";
import { ConnectionLimitError } from "../active-connections.js";

const filePathSchema = z.string()
  .trim()
  .min(1, "请输入日志文件路径")
  .max(1024, "日志文件路径不能超过 1024 个字符")
  .refine((value) => value.startsWith("/"), "请输入绝对路径")
  .refine((value) => !/[\0\r\n]/.test(value), "日志文件路径不能包含换行或空字符");

export const environmentLogSchema = z.object({
  sshConnectionId: z.string().uuid(),
  name: z.string().trim().max(120).default(""),
  filePath: filePathSchema.optional(),
  filePaths: z.array(filePathSchema).min(1, "请至少填写一个日志文件路径").max(MAX_ENVIRONMENT_LOG_FILES, `最多配置 ${MAX_ENVIRONMENT_LOG_FILES} 个日志文件`).optional(),
}).superRefine((value, context) => {
  const paths = value.filePaths ?? (value.filePath ? [value.filePath] : []);
  if (!paths.length) {
    context.addIssue({ code: "custom", path: ["filePaths"], message: "请至少填写一个日志文件路径" });
  }
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["filePaths"], message: "日志文件路径不能重复" });
  }
}).transform((value) => ({
  sshConnectionId: value.sshConnectionId,
  name: value.name,
  filePaths: value.filePaths ?? [value.filePath!],
}));

const streamOptionsSchema = z.object({
  initialLines: z.number().int().min(MIN_ENVIRONMENT_LOG_LINES).max(MAX_ENVIRONMENT_LOG_LINES).default(DEFAULT_ENVIRONMENT_LOG_LINES),
});

function displayName(name: string, filePaths: string[]): string {
  if (name) return name;
  const firstName = posix.basename(filePaths[0]!) || filePaths[0]!;
  return filePaths.length > 1 ? `${firstName} 等 ${filePaths.length} 个文件` : firstName;
}

async function connectionBelongsToEnvironment(app: FastifyInstance, connectionId: string, environmentId: string): Promise<boolean> {
  return Boolean(await app.db.prepare(`
    SELECT c.id FROM ssh_connections c
    JOIN ssh_connection_environments ce ON ce.connection_id = c.id
    WHERE c.id = ? AND ce.environment_id = ? AND c.source_deleted = 0
  `).get(connectionId, environmentId));
}

function requireManager(request: Parameters<typeof canManageWorkspace>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "只有工作空间管理员可以修改日志配置" });
  return false;
}

function mapLog(row: Record<string, unknown>) {
  const filePaths = parseStoredLogFilePaths(row.file_paths_json, row.file_path);
  return {
    id: row.id,
    environmentId: row.environment_id,
    sshConnectionId: row.ssh_connection_id,
    name: row.name,
    filePath: filePaths[0] ?? "",
    filePaths,
    connectionName: row.connection_name,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    connectionAvailable: Boolean(row.connection_available) && !Boolean(row.source_deleted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function registerEnvironmentLogRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/logs",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      const rows = await app.db.prepare(`
        SELECT l.*, s.name AS connection_name, s.host, s.port, s.username, s.source_deleted,
          EXISTS (
            SELECT 1 FROM ssh_connection_environments ce
            WHERE ce.connection_id = s.id AND ce.environment_id = l.environment_id
          ) AS connection_available
        FROM environment_logs l
        JOIN ssh_connections s ON s.id = l.ssh_connection_id
        WHERE l.environment_id = ?
        ORDER BY l.updated_at DESC
      `).all(request.params.environmentId) as Record<string, unknown>[];
      return { items: rows.map(mapLog) };
    },
  );

  app.post<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/logs",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(environmentLogSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      if (!await connectionBelongsToEnvironment(app, body.sshConnectionId, request.params.environmentId)) {
        return reply.code(400).send({ error: "INVALID_SSH_CONNECTION", message: "请选择当前环境中可用的 SSH 连接" });
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const name = displayName(body.name, body.filePaths);
      const firstFilePath = body.filePaths[0]!;
      try {
        await app.db.prepare(`
          INSERT INTO environment_logs (
            id, environment_id, ssh_connection_id, name, file_path, file_paths_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, request.params.environmentId, body.sshConnectionId, name, firstFilePath, JSON.stringify(body.filePaths), now, now);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: "DUPLICATE_LOG", message: "该 SSH 连接已存在以相同文件开头的日志配置" });
        }
        throw error;
      }
      await writeAudit(app.db, {
        action: "environment_log.created",
        resourceType: "environment_log",
        resourceId: id,
        summary: `新增环境日志 ${name}`,
        details: { environmentId: request.params.environmentId, sshConnectionId: body.sshConnectionId, filePaths: body.filePaths },
        request,
      });
      return reply.code(201).send({ id });
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/environment-logs/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(environmentLogSchema, request.body, reply);
      if (!body) return;
      const existing = await app.db.prepare("SELECT environment_id FROM environment_logs WHERE id = ?").get(request.params.id) as
        | { environment_id: string }
        | undefined;
      if (!existing) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
      if (!await canAccessEnvironment(app.db, request.admin!, existing.environment_id)) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
      if (!await connectionBelongsToEnvironment(app, body.sshConnectionId, existing.environment_id)) {
        return reply.code(400).send({ error: "INVALID_SSH_CONNECTION", message: "请选择当前环境中可用的 SSH 连接" });
      }
      const name = displayName(body.name, body.filePaths);
      const firstFilePath = body.filePaths[0]!;
      try {
        await app.db.prepare(`
          UPDATE environment_logs
          SET ssh_connection_id = ?, name = ?, file_path = ?, file_paths_json = ?, updated_at = ?
          WHERE id = ?
        `).run(body.sshConnectionId, name, firstFilePath, JSON.stringify(body.filePaths), new Date().toISOString(), request.params.id);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: "DUPLICATE_LOG", message: "该 SSH 连接已存在以相同文件开头的日志配置" });
        }
        throw error;
      }
      await writeAudit(app.db, {
        action: "environment_log.updated",
        resourceType: "environment_log",
        resourceId: request.params.id,
        summary: `更新环境日志 ${name}`,
        details: { environmentId: existing.environment_id, sshConnectionId: body.sshConnectionId, filePaths: body.filePaths },
        request,
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/environment-logs/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const log = await app.db.prepare("SELECT name, environment_id FROM environment_logs WHERE id = ?").get(request.params.id) as
        | { name: string; environment_id: string }
        | undefined;
      if (!log) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
      if (!await canAccessEnvironment(app.db, request.admin!, log.environment_id)) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
      await app.db.prepare("DELETE FROM environment_logs WHERE id = ?").run(request.params.id);
      await writeAudit(app.db, {
        action: "environment_log.deleted",
        resourceType: "environment_log",
        resourceId: request.params.id,
        summary: `删除环境日志 ${log.name}`,
        details: { environmentId: log.environment_id },
        request,
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/environment-logs/:id/stream",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!request.admin) return;
      if (!await canAccessEnvironmentLog(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
      const options = parseBody(streamOptionsSchema, request.body ?? {}, reply);
      if (!options) return;
      const log = await app.db.prepare("SELECT name, ssh_connection_id, file_path, file_paths_json FROM environment_logs WHERE id = ?").get(request.params.id) as
        | { name: string; ssh_connection_id: string; file_path: string; file_paths_json: string }
        | undefined;
      if (!log) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
      const filePaths = parseStoredLogFilePaths(log.file_paths_json, log.file_path);
      try {
        const result = await app.sshLogStreams.create(request.admin, request.params.id, options.initialLines, executionScope(request));
        await writeAudit(app.db, {
          action: "environment_log.view_started",
          resourceType: "environment_log",
          resourceId: request.params.id,
          summary: `查看环境日志 ${log.name}`,
          details: { streamId: result.stream.id, sshConnectionId: log.ssh_connection_id, filePaths, initialLines: options.initialLines },
          request,
        });
        return reply.code(201).send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "实时日志连接失败";
        await writeAudit(app.db, {
          action: "environment_log.view_failed",
          resourceType: "environment_log",
          resourceId: request.params.id,
          summary: `环境日志连接失败 ${log.name}`,
          details: { sshConnectionId: log.ssh_connection_id, filePaths, initialLines: options.initialLines, message },
          request,
        });
        if (error instanceof ConnectionLimitError) return reply.code(409).send({ error: error.code, message, limit: error.limit });
        return reply.code(502).send({ error: "SSH_LOG_STREAM_FAILED", message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/ssh-log-streams/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const stream = app.sshLogStreams.list(request.admin!.id, executionScope(request)).find((item) => item.id === request.params.id);
      if (!stream) return reply.code(404).send({ error: "LOG_STREAM_NOT_FOUND", message: "实时日志不存在" });
      app.sshLogStreams.close(request.params.id);
      await writeAudit(app.db, {
        action: "environment_log.view_stopped",
        resourceType: "environment_log",
        resourceId: stream.logId,
        summary: `停止查看环境日志 ${stream.logName}`,
        details: { streamId: stream.id },
        request,
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: { ticket?: string } }>("/ws/ssh-logs", { websocket: true }, (socket, request) => {
    if (!request.query.ticket) {
      socket.close(4000, "缺少日志票据");
      return;
    }
    app.sshLogStreams.attach(request.query.ticket, socket);
  });
}
