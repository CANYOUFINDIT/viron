import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PRODUCT_VERSION } from "../product-info.js";
import { registerVironMcpTools } from "../../shared/mcp-tools.js";
import { McpApiBridge } from "./api-bridge.js";
import type { ServerMcpSessionInfo } from "../../shared/mcp-settings.js";

interface McpSession {
  id: string | null;
  apiKeyId: string;
  userId: string;
  executionScope: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsedAt: number;
  connectedAt: number;
  clientName: string;
  clientVersion: string;
  closing: boolean;
}

function initializeClientInfo(body: unknown): { clientName: string; clientVersion: string } {
  if (!body || typeof body !== "object") return { clientName: "未知客户端", clientVersion: "" };
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return { clientName: "未知客户端", clientVersion: "" };
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  if (!clientInfo || typeof clientInfo !== "object") return { clientName: "未知客户端", clientVersion: "" };
  const raw = clientInfo as { name?: unknown; version?: unknown };
  return {
    clientName: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : "未知客户端",
    clientVersion: typeof raw.version === "string" ? raw.version.trim().slice(0, 80) : "",
  };
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonRpcError(reply: FastifyReply, status: number, code: number, message: string): void {
  if (reply.raw.headersSent || reply.raw.writableEnded) return;
  reply.raw.statusCode = status;
  reply.raw.setHeader("content-type", "application/json; charset=utf-8");
  reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function createServer(bridge: McpApiBridge): McpServer {
  const server = new McpServer({ name: "viron", version: PRODUCT_VERSION }, {
    instructions: "Start with viron_context and viron_domains_list. Use viron_operations_search to find only the relevant domain; call viron_operation_schema only when inputSummary is insufficient, then invoke viron_read, viron_change, viron_risk, or viron_secure according to the returned mode. Viron exposes only resources and actions authorized for the current user. Never request or expose passwords, private keys, cookies, tokens, or other secrets. Client approval does not replace Viron permission, confirmation, audit, limits, or execution-mode checks.",
  });
  registerVironMcpTools(server, bridge);
  return server;
}

export class VironMcpRuntime {
  private readonly bridge: McpApiBridge;
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly app: FastifyInstance) {
    this.bridge = new McpApiBridge(app);
  }

  private sessionMatchesRequest(session: McpSession, request: FastifyRequest): boolean {
    return session.apiKeyId === request.apiKey?.id && session.userId === request.admin?.id;
  }

  private async closeExecution(session: McpSession, reason: string): Promise<void> {
    this.app.mcpOperations.cancelScope(session.userId, session.executionScope);
    await Promise.all([
      this.app.sshSessions.closeOwner(session.userId, reason, session.executionScope),
      Promise.resolve(this.app.sshLogStreams.closeOwner(session.userId, reason, session.executionScope)),
      this.app.sftpTransfers.closeOwner(session.userId, session.executionScope),
      Promise.resolve(this.app.databaseQueries.closeOwner(session.userId, session.executionScope)),
      this.app.databaseTasks.closeOwner(session.userId, session.executionScope),
      this.app.webAccountViews.closeOwner(session.userId, reason, session.executionScope),
    ]);
  }

  private async dispose(session: McpSession, reason: string, closeServer: boolean): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    if (session.id) this.sessions.delete(session.id);
    await this.closeExecution(session, reason);
    if (closeServer) await session.server.close().catch(() => undefined);
  }

  private async cleanupIdle(): Promise<void> {
    const idleMs = (this.app.config.connectionIdleMinutes ?? this.app.config.terminalIdleMinutes) * 60_000;
    const expired = [...this.sessions.values()].filter((session) => Date.now() - session.lastUsedAt >= idleMs);
    await Promise.all(expired.map((session) => this.dispose(session, "MCP 会话空闲超时", true)));
  }

  private async handleWithSession(session: McpSession, request: FastifyRequest, reply: FastifyReply, body?: unknown): Promise<void> {
    if (!this.sessionMatchesRequest(session, request)) {
      jsonRpcError(reply, 403, -32001, "MCP Session 不属于当前 Viron 用户或 API Key");
      return;
    }
    session.lastUsedAt = Date.now();
    await this.bridge.runWithRequest(request, session.executionScope, () => session.transport.handleRequest(request.raw, reply.raw, body));
  }

  private async initialize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const apiKeyId = request.apiKey?.id;
    const userId = request.admin?.id;
    if (!apiKeyId || !userId) {
      jsonRpcError(reply, 401, -32001, "MCP 需要个人 Viron API Key");
      return;
    }
    let session: McpSession;
    const clientInfo = initializeClientInfo(request.body);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.id = sessionId;
        this.sessions.set(sessionId, session);
      },
    });
    const server = createServer(this.bridge);
    session = {
      id: null,
      apiKeyId,
      userId,
      executionScope: randomUUID(),
      transport,
      server,
      lastUsedAt: Date.now(),
      connectedAt: Date.now(),
      ...clientInfo,
      closing: false,
    };
    transport.onclose = () => { void this.dispose(session, "MCP 客户端已断开", false); };
    transport.onerror = (error) => this.app.log.warn({ error, userId, apiKeyId }, "MCP transport error");
    await server.connect(transport);
    try {
      await this.handleWithSession(session, request, reply, request.body);
    } catch (error) {
      await this.dispose(session, "MCP 初始化失败", true);
      throw error;
    }
  }

  sessionsForUser(userId: string): ServerMcpSessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId && session.id && !session.closing)
      .map((session) => ({
        id: session.id!,
        clientName: session.clientName,
        clientVersion: session.clientVersion,
        connectedAt: new Date(session.connectedAt).toISOString(),
        lastActivityAt: new Date(session.lastUsedAt).toISOString(),
      }))
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.cleanupIdle();
    const sessionId = headerValue(request, "mcp-session-id");
    if (request.method === "POST" && !sessionId && isInitializeRequest(request.body)) {
      await this.initialize(request, reply);
      return;
    }
    if (!sessionId) {
      jsonRpcError(reply, 400, -32000, "缺少有效的 MCP Session ID");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      jsonRpcError(reply, 404, -32000, "MCP Session 不存在或已过期");
      return;
    }
    await this.handleWithSession(session, request, reply, request.method === "POST" ? request.body : undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.dispose(session, "Viron 服务正在关闭", true)));
  }
}
