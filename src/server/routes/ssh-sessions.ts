import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { filterAsync } from "../async-utils.js";
import { canAccessConnection, canAccessEnvironment, canManageWorkspace } from "../access-control.js";
import { executionScope } from "../execution-scope.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { ConnectionLimitError } from "../active-connections.js";
import { auditLikePattern, auditRetentionCutoff, parseAuditListQuery, type AuditListQuery } from "../audit-query.js";
import { SshCommandAbortedError } from "../ssh/command.js";
import { acceptDesktopReport, DesktopReportError } from "../desktop-report.js";

const createSessionSchema = z.object({
  connectionId: z.string().uuid(),
  originEnvironmentId: z.string().uuid().optional(),
  cols: z.number().int().min(20).max(500).default(120),
  rows: z.number().int().min(5).max(300).default(32),
});

const agentContextAuthorizationSchema = z.object({
  operationId: z.string().uuid(),
  action: z.literal("context"),
  sessionId: z.string().uuid(),
  executionScope: z.string().uuid(),
});

const agentDiagnosticAuthorizationSchema = z.object({
  operationId: z.string().uuid(),
  action: z.literal("execute"),
  sessionId: z.string().uuid(),
  executionScope: z.string().uuid(),
  command: z.string().min(1).max(2_000),
  intent: z.enum(["read", "write"]).default("read"),
});

const agentDiagnosticCancelAuthorizationSchema = z.object({
  operationId: z.string().uuid(),
  action: z.literal("cancel"),
  sessionId: z.string().uuid(),
  executionScope: z.string().uuid(),
  executionId: z.string().uuid(),
});

function agentExecutionScope(request: Parameters<typeof executionScope>[0]): string | null {
  const scope = executionScope(request);
  return scope && request.headers["x-viron-execution-mode"] === "server" ? scope : null;
}

function desktopReportReply(error: unknown, reply: FastifyReply) {
  if (error instanceof DesktopReportError) return reply.code(error.status).send({ error: error.code, message: error.message });
  if (error instanceof Error && error.message.includes("SSH 会话不存在")) {
    return reply.code(404).send({ error: "SESSION_NOT_FOUND", message: "SSH 会话不存在或已经结束" });
  }
  throw error;
}

export async function registerSshSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: AuditListQuery }>("/api/v1/ssh-recordings", { preHandler: requireAdmin }, async (request) => {
    const query = parseAuditListQuery(request.query, 500);
    const showOrganizationRecords = request.admin!.workspace.type === "organization" && canManageWorkspace(request);
    const filters = ["c.workspace_type = ?", "c.workspace_id = ?", "r.started_at >= ?"];
    const values: unknown[] = [request.admin!.workspace.type, request.admin!.workspace.id, auditRetentionCutoff(app.config.auditRetentionDays)];
    if (!showOrganizationRecords) { filters.push("r.owner_user_id = ?"); values.push(request.admin!.id); }
    if (query.actorUserId) { filters.push("r.owner_user_id = ?"); values.push(query.actorUserId); }
    if (query.keyword) {
      filters.push("(r.connection_name LIKE ? ESCAPE '!' OR r.host LIKE ? ESCAPE '!' OR r.status LIKE ? ESCAPE '!' OR r.close_reason LIKE ? ESCAPE '!')");
      const pattern = auditLikePattern(query.keyword);
      values.push(pattern, pattern, pattern, pattern);
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const rows = await app.db.prepare(`
      SELECT r.id, r.owner_user_id, u.username AS owner_username, r.session_id, r.connection_id,
        r.connection_name, r.host, r.status, r.size_bytes, r.started_at, r.ended_at, r.close_reason
      FROM ssh_terminal_recordings r
      JOIN ssh_connections c ON c.id = r.connection_id
      LEFT JOIN admin_users u ON u.id = r.owner_user_id
      ${where}
      ORDER BY r.started_at DESC LIMIT ? OFFSET ?
    `).all(...values, query.pageSize + 1, query.offset) as Record<string, unknown>[];
    const hasMore = rows.length > query.pageSize;
    const visibleRows = await filterAsync(rows.slice(0, query.pageSize), (row) => Boolean(row.connection_id) && canAccessConnection(app.db, request.admin!, "ssh", String(row.connection_id)));
    const items = visibleRows.map((row) => ({
      id: row.id,
      actor: row.owner_user_id && row.owner_username ? { id: row.owner_user_id, username: row.owner_username } : null,
      sessionId: row.session_id,
      connectionId: row.connection_id,
      connectionName: row.connection_name,
      host: row.host,
      status: row.status,
      sizeBytes: Number(row.size_bytes),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      closeReason: row.close_reason,
    }));
    return { items, page: query.page, pageSize: query.pageSize, hasMore, retentionDays: app.config.auditRetentionDays };
  });

  app.get<{ Params: { id: string } }>("/api/v1/ssh-recordings/:id/download", { preHandler: requireAdmin }, async (request, reply) => {
    const row = await app.db.prepare("SELECT connection_id, connection_name, recording_path FROM ssh_terminal_recordings WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id) as { connection_id: string; connection_name: string; recording_path: string } | undefined;
    if (!row) return reply.code(404).send({ error: "RECORDING_NOT_FOUND", message: "终端录像不存在" });
    if (!await canAccessConnection(app.db, request.admin!, "ssh", row.connection_id)) return reply.code(404).send({ error: "RECORDING_NOT_FOUND", message: "终端录像不存在" });
    try {
      const info = await stat(row.recording_path);
      reply.header("Content-Type", "application/x-asciicast; charset=utf-8");
      reply.header("Content-Length", String(info.size));
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${row.connection_name}-${basename(row.recording_path)}`)}`);
      await writeAudit(app.db, { action: "ssh.recording_downloaded", resourceType: "ssh_recording", resourceId: request.params.id, summary: `下载 SSH 终端录像 ${row.connection_name}`, request });
      return reply.send(createReadStream(row.recording_path));
    } catch {
      return reply.code(404).send({ error: "RECORDING_FILE_MISSING", message: "终端录像文件不存在" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/ssh-recordings/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const row = await app.db.prepare("SELECT connection_id, recording_path, status FROM ssh_terminal_recordings WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id) as { connection_id: string; recording_path: string; status: string } | undefined;
    if (!row) return reply.code(404).send({ error: "RECORDING_NOT_FOUND", message: "终端录像不存在" });
    if (!await canAccessConnection(app.db, request.admin!, "ssh", row.connection_id)) return reply.code(404).send({ error: "RECORDING_NOT_FOUND", message: "终端录像不存在" });
    if (row.status === "recording") return reply.code(409).send({ error: "RECORDING_ACTIVE", message: "活动会话的录像不能删除" });
    await unlink(row.recording_path).catch(() => undefined);
    await app.db.prepare("DELETE FROM ssh_terminal_recordings WHERE id = ?").run(request.params.id);
    await writeAudit(app.db, { action: "ssh.recording_deleted", resourceType: "ssh_recording", resourceId: request.params.id, summary: "删除 SSH 终端录像", request });
    return reply.code(204).send();
  });

  app.get("/api/v1/ssh-sessions", { preHandler: requireAdmin }, async (request) => ({
    items: app.sshSessions.list(request.admin!.id, executionScope(request)),
  }));

  app.post("/api/v1/ssh-sessions", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(createSessionSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "ssh", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    if (body.originEnvironmentId && !await canAccessEnvironment(app.db, request.admin, body.originEnvironmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "来源环境不存在或无权访问" });
    }
    try {
      const result = await app.sshSessions.create(request.admin, body.connectionId, body.cols, body.rows, executionScope(request), body.originEnvironmentId);
      await writeAudit(app.db, {
        action: "ssh.session_started",
        resourceType: "ssh_connection",
        resourceId: body.connectionId,
        summary: `打开 SSH 会话 ${result.session.connectionName}`,
        details: { sessionId: result.session.id, host: result.session.host },
        request,
      });
      return reply.code(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSH 连接失败";
      await writeAudit(app.db, {
        action: "ssh.connection_failed",
        resourceType: "ssh_connection",
        resourceId: body.connectionId,
        summary: "SSH 连接失败",
        details: { message },
        request,
      });
      if (error instanceof ConnectionLimitError) return reply.code(409).send({ error: error.code, message, limit: error.limit });
      return reply.code(502).send({ error: "SSH_CONNECTION_FAILED", message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-sessions/:id/ticket", { preHandler: requireAdmin }, async (request, reply) => {
    try {
      return { ticket: app.sshSessions.ticket(request.params.id, request.admin!.id, executionScope(request)) };
    } catch (error) {
      return reply.code(404).send({ error: "SESSION_NOT_FOUND", message: error instanceof Error ? error.message : "SSH 会话不存在" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-sessions/:id/agent-context", { preHandler: requireAdmin }, async (request, reply) => {
    if (!request.admin) return;
    try {
      const scope = agentExecutionScope(request);
      if (!scope) return reply.code(404).send({ error: "SESSION_NOT_FOUND", message: "SSH 会话不存在或已经结束" });
      let snapshot: ReturnType<typeof app.sshSessions.agentContext> | undefined;
      const accepted = await acceptDesktopReport(app, request.admin, request.body, agentContextAuthorizationSchema, async ({ payload, deviceId }) => {
        if (payload.sessionId !== request.params.id || payload.executionScope !== scope) {
          throw new DesktopReportError(403, "DESKTOP_REPORT_CONTEXT_MISMATCH", "桌面 Agent 授权与当前 SSH 现场不匹配");
        }
        const target = app.sshSessions.agentTarget(request.params.id, request.admin!, scope);
        if (!await canAccessConnection(app.db, request.admin!, "ssh", target.connectionId)) {
          throw new DesktopReportError(404, "SESSION_NOT_FOUND", "SSH 会话不存在或已经结束");
        }
        snapshot = app.sshSessions.agentContext(request.params.id, request.admin!, scope);
        await writeAudit(app.db, {
          action: "agent.ssh_context_read",
          resourceType: "ssh_connection",
          resourceId: snapshot.connectionId,
          summary: `Viron Agent 读取服务端转发 SSH 现场 ${snapshot.connectionName}`,
          details: {
            sessionId: snapshot.sessionId,
            deviceId,
            executionScope: scope,
            includedBytes: snapshot.includedBytes,
            lineCount: snapshot.lineCount,
            truncated: snapshot.truncated,
            redactionCount: snapshot.redactionCount,
          },
          request,
        });
      });
      if (accepted.duplicate || !snapshot) return reply.code(409).send({ error: "AGENT_AUTHORIZATION_REPLAYED", message: "Viron Agent 授权已被使用" });
      return snapshot;
    } catch (error) {
      return desktopReportReply(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/ssh-sessions/:id/agent-diagnostics", { preHandler: requireAdmin }, async (request, reply) => {
    if (!request.admin) return;
    const scope = agentExecutionScope(request);
    if (!scope) return reply.code(404).send({ error: "SESSION_NOT_FOUND", message: "SSH 会话不存在或已经结束" });
    let target: ReturnType<typeof app.sshSessions.agentTarget> | undefined;
    try {
      let payload: z.infer<typeof agentDiagnosticAuthorizationSchema> | undefined;
      let approvedTarget: ReturnType<typeof app.sshSessions.agentTarget> | undefined;
      const accepted = await acceptDesktopReport(app, request.admin, request.body, agentDiagnosticAuthorizationSchema, async (report) => {
        if (report.payload.operationId !== report.operationId
          || report.payload.sessionId !== request.params.id
          || report.payload.executionScope !== scope) {
          throw new DesktopReportError(403, "DESKTOP_REPORT_CONTEXT_MISMATCH", "桌面 Agent 授权与当前 SSH 诊断不匹配");
        }
        const currentTarget = app.sshSessions.agentTarget(request.params.id, request.admin!, scope);
        if (!await canAccessConnection(app.db, request.admin!, "ssh", currentTarget.connectionId)) {
          throw new DesktopReportError(404, "SESSION_NOT_FOUND", "SSH 会话不存在或已经结束");
        }
        payload = report.payload;
        approvedTarget = currentTarget;
        await writeAudit(app.db, {
          action: "agent.ssh_diagnostic_approved",
          resourceType: "ssh_connection",
          resourceId: currentTarget.connectionId,
          summary: `用户确认 Viron Agent 服务端转发 SSH ${payload?.intent === "write" ? "写命令" : "只读诊断"} ${currentTarget.connectionName}`,
          details: { sessionId: currentTarget.id, executionId: report.operationId, deviceId: report.deviceId, executionScope: scope },
          request,
        });
      });
      if (accepted.duplicate || !payload || !approvedTarget) {
        return reply.code(409).send({ error: "AGENT_AUTHORIZATION_REPLAYED", message: "Viron Agent 授权已被使用" });
      }
      target = approvedTarget;
      const result = await app.sshSessions.agentDiagnostic(payload.operationId, request.params.id, payload.command, request.admin, scope, { allowWrite: payload.intent === "write" });
      await writeAudit(app.db, {
        action: "agent.ssh_diagnostic_executed",
        resourceType: "ssh_connection",
        resourceId: result.connectionId,
        summary: `Viron Agent 服务端转发 SSH ${payload.intent === "write" ? "写命令" : "只读诊断"}完成 ${result.connectionName}`,
        details: {
          sessionId: result.sessionId,
          executionId: result.executionId,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
          redactionCount: result.redactionCount,
        },
        request,
      });
      return result;
    } catch (error) {
      if (error instanceof DesktopReportError) return desktopReportReply(error, reply);
      const message = error instanceof Error ? error.message : "SSH 诊断执行失败";
      if (!(error instanceof SshCommandAbortedError) && target) {
        await writeAudit(app.db, {
          action: "agent.ssh_diagnostic_rejected",
          resourceType: "ssh_connection",
          resourceId: target.connectionId,
          summary: `Viron Agent 服务端转发 SSH 诊断未完成 ${target.connectionName}`,
          details: { sessionId: target.id },
          request,
        });
      }
      return reply.code(/只读|写执行|单行|控制字符/.test(message) ? 400 : 502).send({ error: "AGENT_SSH_DIAGNOSTIC_FAILED", message });
    }
  });

  app.post<{ Params: { id: string; executionId: string } }>("/api/v1/ssh-sessions/:id/agent-diagnostics/:executionId/cancel", { preHandler: requireAdmin }, async (request, reply) => {
    if (!request.admin || !z.string().uuid().safeParse(request.params.executionId).success) {
      return reply.code(400).send({ error: "INVALID_EXECUTION_ID", message: "SSH 诊断执行 ID 无效" });
    }
    try {
      const scope = agentExecutionScope(request);
      if (!scope) return reply.code(404).send({ error: "SESSION_NOT_FOUND", message: "SSH 会话不存在或已经结束" });
      let target: ReturnType<typeof app.sshSessions.agentTarget> | undefined;
      let acceptedDeviceId = "";
      const accepted = await acceptDesktopReport(app, request.admin, request.body, agentDiagnosticCancelAuthorizationSchema, async ({ payload, deviceId }) => {
        if (payload.sessionId !== request.params.id
          || payload.executionId !== request.params.executionId
          || payload.executionScope !== scope) {
          throw new DesktopReportError(403, "DESKTOP_REPORT_CONTEXT_MISMATCH", "桌面 Agent 授权与当前 SSH 取消请求不匹配");
        }
        const currentTarget = app.sshSessions.agentTarget(request.params.id, request.admin!, scope);
        if (!await canAccessConnection(app.db, request.admin!, "ssh", currentTarget.connectionId)) {
          throw new DesktopReportError(404, "SESSION_NOT_FOUND", "SSH 会话不存在或已经结束");
        }
        target = currentTarget;
        acceptedDeviceId = deviceId;
      });
      if (accepted.duplicate || !target) return reply.code(409).send({ error: "AGENT_AUTHORIZATION_REPLAYED", message: "Viron Agent 授权已被使用" });
      const result = app.sshSessions.cancelAgentDiagnostic(request.params.executionId, request.params.id, request.admin, scope);
      if (result.stopped) {
        await writeAudit(app.db, {
          action: "agent.ssh_diagnostic_cancelled",
          resourceType: "ssh_connection",
          resourceId: target.connectionId,
          summary: `取消 Viron Agent 服务端转发 SSH 只读诊断 ${target.connectionName}`,
          details: { sessionId: target.id, executionId: request.params.executionId, deviceId: acceptedDeviceId, executionScope: scope },
          request,
        });
        return result;
      }
      return result;
    } catch (error) {
      return desktopReportReply(error, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/ssh-sessions/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const session = app.sshSessions.list(request.admin!.id, executionScope(request)).find((item) => item.id === request.params.id);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND", message: "SSH 会话不存在" });
    await app.sshSessions.close(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { ticket?: string } }>("/ws/ssh", { websocket: true }, (socket, request) => {
    const ticket = request.query.ticket;
    if (!ticket) {
      socket.close(4000, "缺少终端票据");
      return;
    }
    app.sshSessions.attach(ticket, socket);
  });
}
