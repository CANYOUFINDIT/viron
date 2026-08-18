import type { FastifyInstance } from "fastify";
import { requirePersonalApiKey } from "../api-key-auth.js";
import { VironMcpRuntime } from "../mcp/runtime.js";
import { requireAdmin } from "./auth.js";
import { VIRON_MCP_TOOL_NAMES } from "../../shared/mcp-tools.js";
import { listMcpBusinessOperations } from "../../shared/mcp-business-operations.js";
import type { ServerMcpStatus } from "../../shared/mcp-settings.js";

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  const enabled = app.config.mcpEnabled === true;
  const runtime = enabled ? new VironMcpRuntime(app) : null;
  app.get("/api/v1/mcp/status", { preHandler: requireAdmin }, async (request): Promise<ServerMcpStatus> => ({
    enabled,
    path: "/mcp",
    transport: "streamable-http",
    authentication: "personal-api-key",
    toolCount: VIRON_MCP_TOOL_NAMES.length,
    businessOperationCount: listMcpBusinessOperations().length,
    sessions: runtime?.sessionsForUser(request.admin!.id) ?? [],
  }));
  if (!runtime) return;
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    bodyLimit: 16 * 1024 * 1024,
    preHandler: requirePersonalApiKey,
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    handler: async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.hijack();
      try {
        await runtime.handle(request, reply);
      } catch (error) {
        app.log.error({ error, userId: request.admin?.id, apiKeyId: request.apiKey?.id }, "MCP request failed");
        if (!reply.raw.headersSent && !reply.raw.writableEnded) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader("content-type", "application/json; charset=utf-8");
          reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Viron MCP 内部错误" }, id: null }));
        }
      }
    },
  });
  app.addHook("onClose", async () => runtime.closeAll());
}
