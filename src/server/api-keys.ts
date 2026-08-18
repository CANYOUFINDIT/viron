import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EnvmanDatabase } from "./database.js";
import { mcpApprovalMode, type McpApprovalMode } from "../shared/mcp-settings.js";

export type ApiKeyType = "platform" | "personal";

export interface IssuedApiKey {
  id: string;
  type: ApiKeyType;
  name: string;
  keyPrefix: string;
  apiKey: string;
  mcpApprovalMode: McpApprovalMode;
  createdAt: string;
}

export function apiKeyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function issueApiKey(
  db: EnvmanDatabase,
  type: ApiKeyType,
  userId: string | null,
  name: string,
  createdByUserId: string | null,
  approvalMode: McpApprovalMode = "always",
): Promise<IssuedApiKey> {
  const id = randomUUID();
  const apiKey = `viron_${type}_${randomBytes(32).toString("base64url")}`;
  const keyPrefix = apiKey.slice(0, 24);
  const createdAt = new Date().toISOString();
  await db.prepare(`
    INSERT INTO api_keys (
      id, key_type, user_id, name, token_hash, key_prefix, mcp_approval_mode, status, created_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, type, userId, name, apiKeyHash(apiKey), keyPrefix, approvalMode, createdByUserId, createdAt);
  return { id, type, name, keyPrefix, apiKey, mcpApprovalMode: approvalMode, createdAt };
}

export function publicApiKey(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.key_type,
    userId: row.user_id ?? null,
    username: row.username ?? null,
    name: row.name,
    keyPrefix: row.key_prefix,
    mcpApprovalMode: mcpApprovalMode(row.mcp_approval_mode),
    status: row.status,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  };
}
