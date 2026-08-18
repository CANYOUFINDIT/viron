import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePersonalApiKey } from "../api-key-auth.js";
import { apiKeyHash, issueApiKey, publicApiKey, type ApiKeyType } from "../api-keys.js";
import { MCP_APPROVAL_MODES, mcpApprovalMode } from "../../shared/mcp-settings.js";
import { writeAudit } from "../audit.js";
import { parseBody } from "../validation.js";
import { revokeUserRuntime } from "../user-runtime.js";
import { requireAdmin } from "./auth.js";

const COOKIE_NAME = "envman_session";
const MAX_ACTIVE_KEYS = 10;
const keySchema = z.object({
  name: z.string().trim().min(1).max(128),
  mcpApprovalMode: z.enum(MCP_APPROVAL_MODES).default("always"),
});
const mcpApprovalModeSchema = z.object({ mcpApprovalMode: z.enum(MCP_APPROVAL_MODES) });
const loginTicketSchema = z.object({
  organizationId: z.string().uuid().optional(),
  redirectPath: z.string().trim().min(1).max(512).default("/"),
});
const consumeTicketSchema = z.object({ ticket: z.string().min(32).max(256) });

function requirePlatformAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.admin?.isPlatformAdmin) return true;
  void reply.code(403).send({ error: "PLATFORM_ADMIN_REQUIRED", message: "只有平台管理员可以管理平台 API Key" });
  return false;
}

function validRedirectPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && !path.includes("\r") && !path.includes("\n");
}

async function activeKeyCount(app: FastifyInstance, type: ApiKeyType, userId: string | null): Promise<number> {
  const row = await app.db.prepare(`
    SELECT COUNT(*) AS count FROM api_keys
    WHERE key_type = ? AND status = 'active' AND ${userId ? "user_id = ?" : "user_id IS NULL"}
  `).get(...(userId ? [type, userId] : [type])) as { count: number | string };
  return Number(row.count);
}

async function rotateKey(app: FastifyInstance, id: string, type: ApiKeyType, userId: string | null, actorUserId: string) {
  return app.db.transaction(async () => {
    const existing = await app.db.prepare(`
      SELECT id, name, mcp_approval_mode FROM api_keys
      WHERE id = ? AND key_type = ? AND ${userId ? "user_id = ?" : "user_id IS NULL"}
    `).get(...(userId ? [id, type, userId] : [id, type])) as { id: string; name: string; mcp_approval_mode: string } | undefined;
    if (!existing) return null;
    const issued = await issueApiKey(app.db, type, userId, existing.name, actorUserId, mcpApprovalMode(existing.mcp_approval_mode));
    await app.db.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?")
      .run(new Date().toISOString(), existing.id);
    return issued;
  })();
}

async function revokeKey(app: FastifyInstance, id: string, type: ApiKeyType, userId: string | null): Promise<boolean> {
  const result = await app.db.prepare(`
    UPDATE api_keys SET status = 'revoked', revoked_at = ?
    WHERE id = ? AND key_type = ? AND status = 'active' AND ${userId ? "user_id = ?" : "user_id IS NULL"}
  `).run(...(userId ? [new Date().toISOString(), id, type, userId] : [new Date().toISOString(), id, type]));
  return result.changes > 0;
}

function cookieOptions(app: FastifyInstance) {
  return {
    path: "/",
    httpOnly: true,
    secure: app.config.cookieSecure ?? false,
    sameSite: "strict" as const,
    maxAge: app.config.sessionTtlHours * 60 * 60,
  };
}

export async function registerApiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/api-keys", { preHandler: requireAdmin }, async (request) => {
    const rows = await app.db.prepare(`
      SELECT k.* FROM api_keys k
      WHERE k.key_type = 'personal' AND k.user_id = ?
      ORDER BY k.created_at DESC
    `).all(request.admin!.id) as Record<string, unknown>[];
    return { items: rows.map(publicApiKey) };
  });

  app.post("/api/v1/api-keys", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(keySchema, request.body, reply);
    if (!body) return;
    if (await activeKeyCount(app, "personal", request.admin!.id) >= MAX_ACTIVE_KEYS) {
      return reply.code(409).send({ error: "API_KEY_LIMIT", message: `每个用户最多保留 ${MAX_ACTIVE_KEYS} 个有效 API Key` });
    }
    const issued = await issueApiKey(app.db, "personal", request.admin!.id, body.name, request.admin!.id, body.mcpApprovalMode);
    await writeAudit(app.db, { action: "api_key.personal_created", resourceType: "api_key", resourceId: issued.id, summary: "创建个人 API Key", request });
    return reply.code(201).send(issued);
  });

  app.post<{ Params: { id: string } }>("/api/v1/api-keys/:id/rotate", { preHandler: requireAdmin }, async (request, reply) => {
    const issued = await rotateKey(app, request.params.id, "personal", request.admin!.id, request.admin!.id);
    if (!issued) return reply.code(404).send({ error: "NOT_FOUND", message: "API Key 不存在" });
    await writeAudit(app.db, { action: "api_key.personal_rotated", resourceType: "api_key", resourceId: issued.id, summary: "轮换个人 API Key", details: { previousKeyId: request.params.id }, request });
    return reply.code(201).send(issued);
  });

  app.patch<{ Params: { id: string } }>("/api/v1/api-keys/:id/mcp-approval-mode", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(mcpApprovalModeSchema, request.body, reply);
    if (!body) return;
    const result = await app.db.prepare(`
      UPDATE api_keys SET mcp_approval_mode = ?
      WHERE id = ? AND key_type = 'personal' AND user_id = ? AND status = 'active'
    `).run(body.mcpApprovalMode, request.params.id, request.admin!.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "有效个人 API Key 不存在" });
    await writeAudit(app.db, {
      action: "api_key.mcp_approval_mode_updated",
      resourceType: "api_key",
      resourceId: request.params.id,
      summary: "更新个人 API Key 的 MCP 审批策略",
      details: { mcpApprovalMode: body.mcpApprovalMode },
      request,
    });
    const row = await app.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(request.params.id) as Record<string, unknown>;
    return publicApiKey(row);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/api-keys/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!await revokeKey(app, request.params.id, "personal", request.admin!.id)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "有效 API Key 不存在" });
    }
    await writeAudit(app.db, { action: "api_key.personal_revoked", resourceType: "api_key", resourceId: request.params.id, summary: "撤销个人 API Key", request });
    return reply.code(204).send();
  });

  app.get("/api/v1/platform/api-keys", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const rows = await app.db.prepare(`
      SELECT k.* FROM api_keys k WHERE k.key_type = 'platform' ORDER BY k.created_at DESC
    `).all() as Record<string, unknown>[];
    return { items: rows.map(publicApiKey) };
  });

  app.post("/api/v1/platform/api-keys", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const body = parseBody(keySchema, request.body, reply);
    if (!body) return;
    if (await activeKeyCount(app, "platform", null) >= MAX_ACTIVE_KEYS) {
      return reply.code(409).send({ error: "API_KEY_LIMIT", message: `平台最多保留 ${MAX_ACTIVE_KEYS} 个有效 API Key` });
    }
    const issued = await issueApiKey(app.db, "platform", null, body.name, request.admin!.id);
    await writeAudit(app.db, { action: "api_key.platform_created", resourceType: "api_key", resourceId: issued.id, summary: "创建平台 API Key", request });
    return reply.code(201).send(issued);
  });

  app.post<{ Params: { id: string } }>("/api/v1/platform/api-keys/:id/rotate", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const issued = await rotateKey(app, request.params.id, "platform", null, request.admin!.id);
    if (!issued) return reply.code(404).send({ error: "NOT_FOUND", message: "平台 API Key 不存在" });
    await writeAudit(app.db, { action: "api_key.platform_rotated", resourceType: "api_key", resourceId: issued.id, summary: "轮换平台 API Key", details: { previousKeyId: request.params.id }, request });
    return reply.code(201).send(issued);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/platform/api-keys/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    if (!await revokeKey(app, request.params.id, "platform", null)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "有效平台 API Key 不存在" });
    }
    await writeAudit(app.db, { action: "api_key.platform_revoked", resourceType: "api_key", resourceId: request.params.id, summary: "撤销平台 API Key", request });
    return reply.code(204).send();
  });

  app.get("/api/v1/api-key/self", { preHandler: requirePersonalApiKey }, async (request) => ({
    user: { id: request.admin!.id, username: request.admin!.username },
    workspace: request.admin!.workspace,
    apiKeyId: request.apiKey!.id,
  }));

  app.post("/api/v1/auth/api-key/tickets", { preHandler: requirePersonalApiKey }, async (request, reply) => {
    const body = parseBody(loginTicketSchema, request.body, reply);
    if (!body) return;
    if (!validRedirectPath(body.redirectPath)) {
      return reply.code(400).send({ error: "INVALID_REDIRECT_PATH", message: "登录跳转路径必须是 Viron 内部路径" });
    }
    let workspaceType: "personal" | "organization" = "personal";
    let workspaceId = request.admin!.id;
    if (body.organizationId) {
      const membership = await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?")
        .get(body.organizationId, request.admin!.id);
      if (!membership) return reply.code(403).send({ error: "WORKSPACE_FORBIDDEN", message: "当前用户不属于目标组织" });
      workspaceType = "organization";
      workspaceId = body.organizationId;
    }
    const ticket = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    await app.db.transaction(async () => {
      await app.db.prepare("DELETE FROM api_key_login_tickets WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)")
        .run(now.toISOString(), new Date(now.getTime() - 3_600_000).toISOString());
      await app.db.prepare("UPDATE api_key_login_tickets SET consumed_at = ? WHERE api_key_id = ? AND user_id = ? AND consumed_at IS NULL")
        .run(now.toISOString(), request.apiKey!.id, request.admin!.id);
      await app.db.prepare(`
        INSERT INTO api_key_login_tickets (
          id, api_key_id, user_id, token_hash, workspace_type, workspace_id, redirect_path, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), request.apiKey!.id, request.admin!.id, apiKeyHash(ticket), workspaceType, workspaceId, body.redirectPath, expiresAt.toISOString(), now.toISOString());
    })();
    await writeAudit(app.db, { action: "api_key.login_ticket_created", resourceType: "api_key", resourceId: request.apiKey!.id, summary: "创建 API Key 免密登录票据", request });
    const origin = `${request.protocol}://${request.headers.host ?? request.hostname}`;
    return {
      consumeAction: `${origin}/auth/api-key/consume`,
      ticket,
      expiresAt: expiresAt.toISOString(),
    };
  });

  app.post("/auth/api-key/consume", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    const body = parseBody(consumeTicketSchema, request.body, reply);
    if (!body) return;
    const currentSessionToken = request.cookies[COOKIE_NAME];
    const currentSession = currentSessionToken
      ? await app.db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(apiKeyHash(currentSessionToken)) as { user_id: string } | undefined
      : undefined;
    const sessionToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + app.config.sessionTtlHours * 60 * 60 * 1000);
    const result = await app.db.transaction(async () => {
      const ticket = await app.db.prepare(`
        SELECT t.id, t.user_id, t.workspace_type, t.workspace_id, t.redirect_path, t.expires_at, t.consumed_at,
          k.status AS key_status, u.status AS user_status
        FROM api_key_login_tickets t
        JOIN api_keys k ON k.id = t.api_key_id
        JOIN admin_users u ON u.id = t.user_id
        WHERE t.token_hash = ?
      `).get(apiKeyHash(body.ticket)) as {
        id: string; user_id: string; workspace_type: "personal" | "organization"; workspace_id: string;
        redirect_path: string; expires_at: string; consumed_at: string | null; key_status: string; user_status: string;
      } | undefined;
      if (!ticket || ticket.key_status !== "active" || ticket.user_status !== "active") return { error: "API_KEY_TICKET_INVALID" as const };
      if (ticket.consumed_at) return { error: "API_KEY_TICKET_CONSUMED" as const };
      if (new Date(ticket.expires_at).getTime() <= now.getTime()) return { error: "API_KEY_TICKET_EXPIRED" as const };
      if (ticket.workspace_type === "organization" && !await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(ticket.workspace_id, ticket.user_id)) {
        return { error: "API_KEY_TICKET_INVALID" as const };
      }
      const consumed = await app.db.prepare("UPDATE api_key_login_tickets SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
        .run(now.toISOString(), ticket.id);
      if (!consumed.changes) return { error: "API_KEY_TICKET_CONSUMED" as const };
      if (currentSessionToken) await app.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(apiKeyHash(currentSessionToken));
      await app.db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, workspace_type, workspace_id, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), ticket.user_id, apiKeyHash(sessionToken), ticket.workspace_type, ticket.workspace_id, expiresAt.toISOString(), now.toISOString(), now.toISOString());
      return { ticket };
    })();
    if ("error" in result) {
      const status = result.error === "API_KEY_TICKET_EXPIRED" || result.error === "API_KEY_TICKET_CONSUMED" ? 410 : 401;
      return reply.code(status).send({ error: result.error, message: "免密登录票据无效、已过期或已使用" });
    }
    if (currentSession) await revokeUserRuntime(app, currentSession.user_id, false);
    reply.setCookie(COOKIE_NAME, sessionToken, cookieOptions(app));
    await writeAudit(app.db, {
      action: "api_key.login_ticket_consumed",
      resourceType: "user",
      resourceId: result.ticket.user_id,
      summary: "使用 API Key 票据免密登录",
      actorUserId: result.ticket.user_id,
      workspaceType: result.ticket.workspace_type,
      workspaceId: result.ticket.workspace_id,
    });
    return reply.code(303).header("Location", result.ticket.redirect_path).send();
  });
}
