import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrganizationRole, WorkspaceContext } from "./access-control.js";
import { apiKeyHash, type ApiKeyType } from "./api-keys.js";
import { mcpApprovalMode, type McpApprovalMode } from "../shared/mcp-settings.js";

export interface ApiKeyPrincipal {
  id: string;
  type: ApiKeyType;
  userId: string | null;
  name: string;
  mcpApprovalMode: McpApprovalMode;
}

interface ApiKeyRow {
  id: string;
  key_type: ApiKeyType;
  user_id: string | null;
  name: string;
  mcp_approval_mode: string;
  status: string;
  username: string | null;
  is_platform_admin: number | null;
  user_status: string | null;
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const value = authorization.slice("Bearer ".length).trim();
  return value || null;
}

export function hasBearerApiKey(request: FastifyRequest): boolean {
  return Boolean(bearerToken(request));
}

async function workspaceForApiKey(request: FastifyRequest, userId: string): Promise<WorkspaceContext | null> {
  const requested = String(request.headers["x-viron-workspace"] ?? "").trim();
  if (!requested || requested === "personal") {
    return { type: "personal", id: userId, name: "个人工作台", role: "owner" };
  }
  if (!requested.startsWith("organization:")) return null;
  const organizationId = requested.slice("organization:".length);
  const organization = await request.server.db.prepare(`
    SELECT o.id, o.name, m.role
    FROM organizations o
    JOIN organization_members m ON m.organization_id = o.id
    WHERE o.id = ? AND m.user_id = ?
  `).get(organizationId, userId) as { id: string; name: string; role: OrganizationRole } | undefined;
  return organization
    ? { type: "organization", id: organization.id, name: organization.name, role: organization.role }
    : null;
}

async function authenticateApiKey(request: FastifyRequest, reply: FastifyReply, requiredType: ApiKeyType): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "API_KEY_REQUIRED", message: "缺少 API Key" });
    return false;
  }
  const row = await request.server.db.prepare(`
    SELECT k.id, k.key_type, k.user_id, k.name, k.status, k.mcp_approval_mode,
      u.username, u.is_platform_admin, u.status AS user_status
    FROM api_keys k
    LEFT JOIN admin_users u ON u.id = k.user_id
    WHERE k.token_hash = ?
  `).get(apiKeyHash(token)) as ApiKeyRow | undefined;
  if (!row || row.status !== "active" || row.key_type !== requiredType) {
    await reply.code(401).send({ error: "API_KEY_INVALID", message: "API Key 无效或已撤销" });
    return false;
  }
  request.apiKey = {
    id: row.id,
    type: row.key_type,
    userId: row.user_id,
    name: row.name,
    mcpApprovalMode: mcpApprovalMode(row.mcp_approval_mode),
  };
  if (requiredType === "personal") {
    if (!row.user_id || !row.username || row.user_status !== "active") {
      await reply.code(401).send({ error: "API_KEY_INVALID", message: "API Key 对应账号不可用" });
      return false;
    }
    const workspace = await workspaceForApiKey(request, row.user_id);
    if (!workspace) {
      await reply.code(403).send({ error: "WORKSPACE_FORBIDDEN", message: "API Key 无权访问指定工作空间" });
      return false;
    }
    request.admin = {
      id: row.user_id,
      username: row.username,
      isPlatformAdmin: Boolean(row.is_platform_admin),
      workspace,
    };
  }
  const now = new Date().toISOString();
  await request.server.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return true;
}

export async function requirePersonalApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticateApiKey(request, reply, "personal");
}

export async function requirePlatformApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticateApiKey(request, reply, "platform");
}

export async function authenticatePersonalApiKey(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  return authenticateApiKey(request, reply, "personal");
}
