import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { passwordPolicyError } from "../password-policy.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { revokeUserRuntime } from "../user-runtime.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const createUserSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
  isPlatformAdmin: z.boolean().default(false),
});

const statusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const resetPasswordSchema = z.object({ password: z.string().min(1).max(1024) });

function requirePlatformAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.admin?.isPlatformAdmin) return true;
  void reply.code(403).send({ error: "PLATFORM_ADMIN_REQUIRED", message: "只有平台管理员可以管理平台账号" });
  return false;
}

function mapUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    username: row.username,
    isPlatformAdmin: Boolean(row.is_platform_admin),
    status: row.status,
    organizationCount: Number(row.organization_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/v1/users", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const rows = await app.db.prepare(`
      SELECT u.*, COUNT(m.organization_id) AS organization_count
      FROM admin_users u
      LEFT JOIN organization_members m ON m.user_id = u.id
      GROUP BY u.id
      ORDER BY u.username COLLATE NOCASE
    `).all() as Record<string, unknown>[];
    return { items: rows.map(mapUser) };
  });

  app.post("/api/v1/users", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const body = parseBody(createUserSchema, request.body, reply);
    if (!body) return;
    const passwordError = passwordPolicyError(body.password, app.config.allowWeakPasswords);
    if (passwordError) return reply.code(400).send({ error: "WEAK_PASSWORD", message: passwordError });
    if (await app.db.prepare("SELECT id FROM admin_users WHERE username = ? COLLATE NOCASE").get(body.username)) {
      return reply.code(409).send({ error: "USERNAME_EXISTS", message: "用户名已存在" });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    try {
      await app.db.prepare(`
        INSERT INTO admin_users (id, username, password_hash, is_platform_admin, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(id, body.username, passwordHash, body.isPlatformAdmin ? 1 : 0, now, now);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "USERNAME_EXISTS", message: "用户名已存在" });
      throw error;
    }
    await writeAudit(app.db, { action: "user.created", resourceType: "user", resourceId: id, summary: `创建平台用户 ${body.username}`, details: { isPlatformAdmin: body.isPlatformAdmin }, request });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/v1/users/:id/status", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const body = parseBody(statusSchema, request.body, reply);
    if (!body) return;
    const user = await app.db.prepare("SELECT username, status, is_platform_admin FROM admin_users WHERE id = ?").get(request.params.id) as
      | { username: string; status: string; is_platform_admin: number }
      | undefined;
    if (!user) return reply.code(404).send({ error: "NOT_FOUND", message: "用户不存在" });
    if (body.status === "disabled" && request.params.id === request.admin!.id) {
      return reply.code(400).send({ error: "CANNOT_DISABLE_SELF", message: "不能停用当前登录账号" });
    }
    if (body.status === "disabled" && user.is_platform_admin) {
      const activeAdmins = await app.db.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE is_platform_admin = 1 AND status = 'active'").get() as { count: number };
      if (activeAdmins.count <= 1) return reply.code(400).send({ error: "LAST_PLATFORM_ADMIN", message: "平台必须保留至少一名有效平台管理员" });
    }
    if (body.status === "disabled") {
      const orphanedOrganization = await app.db.prepare(`
        SELECT o.name
        FROM organization_members own
        JOIN organizations o ON o.id = own.organization_id
        WHERE own.user_id = ? AND own.role = 'admin'
          AND NOT EXISTS (
            SELECT 1 FROM organization_members other
            JOIN admin_users u ON u.id = other.user_id
            WHERE other.organization_id = own.organization_id AND other.role = 'admin'
              AND other.user_id != own.user_id AND u.status = 'active'
          )
        LIMIT 1
      `).get(request.params.id) as { name: string } | undefined;
      if (orphanedOrganization) return reply.code(400).send({ error: "LAST_ORGANIZATION_ADMIN", message: `用户是组织“${orphanedOrganization.name}”的最后一名有效管理员` });
    }
    await app.db.prepare("UPDATE admin_users SET status = ?, updated_at = ? WHERE id = ?").run(body.status, new Date().toISOString(), request.params.id);
    if (body.status === "disabled") await revokeUserRuntime(app, request.params.id, true);
    await writeAudit(app.db, { action: `user.${body.status}`, resourceType: "user", resourceId: request.params.id, summary: `${body.status === "active" ? "启用" : "停用"}用户 ${user.username}`, request });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/v1/users/:id/password", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const body = parseBody(resetPasswordSchema, request.body, reply);
    if (!body) return;
    const passwordError = passwordPolicyError(body.password, app.config.allowWeakPasswords);
    if (passwordError) return reply.code(400).send({ error: "WEAK_PASSWORD", message: passwordError });
    const user = await app.db.prepare("SELECT username FROM admin_users WHERE id = ?").get(request.params.id) as { username: string } | undefined;
    if (!user) return reply.code(404).send({ error: "NOT_FOUND", message: "用户不存在" });
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    await app.db.prepare("UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?").run(passwordHash, new Date().toISOString(), request.params.id);
    await revokeUserRuntime(app, request.params.id, true);
    await writeAudit(app.db, { action: "user.password_reset", resourceType: "user", resourceId: request.params.id, summary: `重置用户 ${user.username} 的密码`, request });
    return { ok: true };
  });
}
