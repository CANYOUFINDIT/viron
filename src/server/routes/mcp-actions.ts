import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessConnection, canAccessEnvironmentLog, canAccessWebCredential } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { listMcpBusinessOperations, MCP_BUSINESS_OPERATION_MODES } from "../../shared/mcp-business-operations.js";
import { VIRON_MCP_TOOL_NAMES } from "../../shared/mcp-tools.js";
import { parseStoredLogFilePaths, buildSshLogSnapshotCommand } from "../../shared/environment-log.js";
import { executionScope } from "../execution-scope.js";
import { executeSshCommand, executeSshCommandOnConnection, type SshCommandResult } from "../ssh/command.js";
import { connectSsh } from "../ssh/connector.js";
import { sshCommandRiskLevel } from "../../shared/ssh-command-risk.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const logSnapshotSchema = z.object({
  initialLines: z.number().int().min(1).max(5000).default(200),
  maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
});

const webSnapshotSchema = z.object({
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(240).max(1200).default(720),
  maxTextChars: z.number().int().min(1000).max(200_000).default(50_000),
});

const sshCommandSchema = z.object({
  command: z.string().trim().min(1).max(256 * 1024),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
});
const sshCommandBatchSchema = z.object({
  commands: z.array(z.string().trim().min(1).max(256 * 1024)).min(1).max(20),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
});

function boundedSshBatchResult(result: SshCommandResult, maxBytes: number): SshCommandResult {
  const stdout = Buffer.from(result.stdout, "utf8");
  const boundedStdout = stdout.subarray(0, Math.max(0, maxBytes));
  const remaining = Math.max(0, maxBytes - boundedStdout.length);
  const stderr = Buffer.from(result.stderr, "utf8");
  const boundedStderr = stderr.subarray(0, remaining);
  return {
    ...result,
    stdout: boundedStdout.toString("utf8"),
    stderr: boundedStderr.toString("utf8"),
    truncated: result.truncated || boundedStdout.length < stdout.length || boundedStderr.length < stderr.length,
  };
}

const webActionSchema = z.object({
  action: z.enum(["click", "fill", "select", "submit"]),
  elementIndex: z.number().int().min(0).max(199),
  value: z.string().max(256 * 1024).optional(),
  expectedName: z.string().trim().max(500).optional(),
}).refine((value) => !["fill", "select"].includes(value.action) || value.value !== undefined, {
  message: "填写或选择操作必须提供 value",
  path: ["value"],
});
const webControlSchema = z.object({
  action: z.enum(["navigate", "back", "forward", "reload"]),
  url: z.string().url().max(2048).optional(),
}).refine((value) => value.action !== "navigate" || Boolean(value.url), {
  message: "导航操作必须提供 URL",
  path: ["url"],
});

export async function registerMcpActionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { mode?: string } }>("/api/v1/mcp/business-operations", { preHandler: requireAdmin }, async (request, reply) => {
    const mode = request.query.mode;
    if (mode && !MCP_BUSINESS_OPERATION_MODES.includes(mode as typeof MCP_BUSINESS_OPERATION_MODES[number])) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", message: "MCP 业务操作模式无效" });
    }
    return {
      coverageVersion: 1,
      specializedTools: [...VIRON_MCP_TOOL_NAMES].filter((name) => !name.startsWith("viron_business_")),
      items: listMcpBusinessOperations(mode as typeof MCP_BUSINESS_OPERATION_MODES[number] | undefined),
      excluded: [
        "Viron 账号注册、登录、密码、API Key 和会话管理",
        "平台用户、组织成员、项目成员、资源授权和知识库授权",
        "SSH 私钥、密码、Cookie、Token 和其他秘密读取或导出",
        "桌面设备注册、一次性凭据信封、WebSocket 票据和内部 Runtime 协议",
        "平台级备份恢复、服务配置和安装包管理",
        "目标数据库账号、密码和授权管理",
      ],
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/ssh-connections/:id/command", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(sshCommandSchema, request.body ?? {}, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "ssh", request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    const connection = await app.db.prepare("SELECT name FROM ssh_connections WHERE id = ?").get(request.params.id) as { name: string } | undefined;
    try {
      const result = await executeSshCommand(app, request.params.id, body.command, { timeoutMs: body.timeoutMs, maxBytes: body.maxBytes });
      await writeAudit(app.db, {
        action: "mcp.ssh_command_executed",
        resourceType: "ssh_connection",
        resourceId: request.params.id,
        summary: `MCP 执行 SSH 命令 ${connection?.name ?? request.params.id}`,
        details: { commandLength: body.command.length, durationMs: result.durationMs, exitCode: result.exitCode, truncated: result.truncated },
        request,
      });
      return result;
    } catch (error) {
      await writeAudit(app.db, {
        action: "mcp.ssh_command_failed",
        resourceType: "ssh_connection",
        resourceId: request.params.id,
        summary: `MCP SSH 命令失败 ${connection?.name ?? request.params.id}`,
        details: { commandLength: body.command.length },
        request,
      });
      return reply.code(502).send({ error: "SSH_COMMAND_FAILED", message: error instanceof Error ? error.message : "SSH 命令执行失败" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/ssh-connections/:id/commands", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(sshCommandBatchSchema, request.body ?? {}, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "ssh", request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    if (body.commands.some((command) => sshCommandRiskLevel(command) !== "low")) {
      return reply.code(400).send({ error: "SSH_BATCH_NOT_READ_ONLY", message: "SSH 批量读取只允许可证明为只读的命令" });
    }
    const started = Date.now();
    const acquireStarted = Date.now();
    const items = [];
    let remainingBytes = body.maxBytes;
    let connected: Awaited<ReturnType<typeof connectSsh>> | undefined;
    try {
      connected = await connectSsh(app, request.params.id);
    } catch (error) {
      await writeAudit(app.db, {
        action: "mcp.ssh_commands_read_batch",
        resourceType: "ssh_connection",
        resourceId: request.params.id,
        summary: `MCP 批量 SSH 只读命令连接失败（${body.commands.length} 条）`,
        details: { commandCount: body.commands.length, failedCount: body.commands.length, durationMs: Date.now() - started, stage: "connect" },
        request,
      });
      return reply.code(502).send({ error: "SSH_COMMAND_FAILED", message: error instanceof Error ? error.message : "SSH 连接失败" });
    }
    const transportAcquireDurationMs = Date.now() - acquireStarted;
    try {
      for (let index = 0; index < body.commands.length; index += 1) {
        if (remainingBytes <= 0) {
          items.push({ index, ok: false, error: "SSH 批量响应已达到总输出限制" });
          continue;
        }
        try {
          const result = boundedSshBatchResult(await executeSshCommandOnConnection(
            connected,
            body.commands[index],
            { timeoutMs: body.timeoutMs, maxBytes: Math.max(1024, remainingBytes) },
          ), remainingBytes);
          remainingBytes -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
          items.push({ index, ok: true, ...result });
        } catch (error) {
          items.push({ index, ok: false, error: error instanceof Error ? error.message : "SSH 命令执行失败" });
        }
      }
    } finally {
      connected.close();
    }
    await writeAudit(app.db, {
      action: "mcp.ssh_commands_read_batch",
      resourceType: "ssh_connection",
      resourceId: request.params.id,
      summary: `MCP 批量执行 ${body.commands.length} 条 SSH 只读命令`,
      details: {
        commandCount: body.commands.length,
        failedCount: items.filter((item) => !item.ok).length,
        outputBytes: body.maxBytes - remainingBytes,
        durationMs: Date.now() - started,
        transportAcquireDurationMs,
        transportReused: connected.transportReused === true,
      },
      request,
    });
    return {
      items,
      durationMs: Date.now() - started,
      outputBytes: body.maxBytes - remainingBytes,
      reusedConnection: body.commands.length > 1,
      transportReused: connected.transportReused === true,
      transportAcquireDurationMs,
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/environment-logs/:id/snapshot", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(logSnapshotSchema, request.body ?? {}, reply);
    if (!body || !request.admin) return;
    if (!await canAccessEnvironmentLog(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
    const log = await app.db.prepare(`
      SELECT l.name, l.ssh_connection_id, l.file_path, l.file_paths_json
      FROM environment_logs l WHERE l.id = ?
    `).get(request.params.id) as { name: string; ssh_connection_id: string; file_path: string; file_paths_json: string } | undefined;
    if (!log) return reply.code(404).send({ error: "LOG_NOT_FOUND", message: "日志配置不存在" });
    const filePaths = parseStoredLogFilePaths(log.file_paths_json, log.file_path);
    try {
      const result = await executeSshCommand(app, log.ssh_connection_id, buildSshLogSnapshotCommand(filePaths, body.initialLines), {
        timeoutMs: 30_000,
        maxBytes: body.maxBytes,
      });
      await writeAudit(app.db, {
        action: "mcp.log_snapshot_read",
        resourceType: "environment_log",
        resourceId: request.params.id,
        summary: `MCP 读取日志快照 ${log.name}`,
        details: { initialLines: body.initialLines, byteLength: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), truncated: result.truncated },
        request,
      });
      return { logId: request.params.id, name: log.name, filePaths, ...result };
    } catch (error) {
      return reply.code(502).send({ error: "LOG_SNAPSHOT_FAILED", message: error instanceof Error ? error.message : "读取日志快照失败" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/web-credentials/:id/snapshot", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(webSnapshotSchema, request.body ?? {}, reply);
    if (!body || !request.admin) return;
    if (!await canAccessWebCredential(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 登录账号不存在" });
    try {
      const snapshot = await app.webAccountViews.snapshot(
        request.admin,
        request.params.id,
        body.width,
        body.height,
        body.maxTextChars,
        executionScope(request),
      );
      await writeAudit(app.db, {
        action: "mcp.web_snapshot_read",
        resourceType: "web_credential",
        resourceId: request.params.id,
        summary: `MCP 读取 Web 页面快照 ${snapshot.view.entryName}`,
        details: { url: snapshot.view.url, title: snapshot.view.title, textChars: snapshot.text.length, interactiveCount: snapshot.interactive.length },
        request,
      });
      return snapshot;
    } catch (error) {
      return reply.code(503).send({ error: "WEB_SNAPSHOT_UNAVAILABLE", message: error instanceof Error ? error.message : "Web 页面快照不可用" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/web-credentials/:id/action", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(webActionSchema, request.body ?? {}, reply);
    if (!body || !request.admin) return;
    if (!await canAccessWebCredential(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 登录账号不存在" });
    try {
      const result = await app.webAccountViews.semanticAction(request.admin, request.params.id, body, executionScope(request));
      await writeAudit(app.db, {
        action: "mcp.web_action_executed",
        resourceType: "web_credential",
        resourceId: request.params.id,
        summary: `MCP 操作 Web 页面 ${result.view.entryName}`,
        details: { action: body.action, elementIndex: body.elementIndex, elementName: result.element.name, url: result.url },
        request,
      });
      return result;
    } catch (error) {
      return reply.code(503).send({ error: "WEB_ACTION_FAILED", message: error instanceof Error ? error.message : "Web 页面操作失败" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/web-credentials/:id/control", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(webControlSchema, request.body ?? {}, reply);
    if (!body || !request.admin) return;
    if (!await canAccessWebCredential(app.db, request.admin, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 登录账号不存在" });
    try {
      const result = await app.webAccountViews.semanticControl(request.admin, request.params.id, body, executionScope(request));
      await writeAudit(app.db, {
        action: "mcp.web_control_executed",
        resourceType: "web_credential",
        resourceId: request.params.id,
        summary: `MCP 控制 Web 页面 ${result.view.entryName}`,
        details: { action: body.action, url: result.url },
        request,
      });
      return result;
    } catch (error) {
      return reply.code(503).send({ error: "WEB_CONTROL_FAILED", message: error instanceof Error ? error.message : "Web 页面控制失败" });
    }
  });
}
