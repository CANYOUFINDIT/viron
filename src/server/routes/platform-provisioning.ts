import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformApiKey } from "../api-key-auth.js";
import { issueApiKey } from "../api-keys.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { passwordPolicyError } from "../password-policy.js";
import { parseBody } from "../validation.js";

const ensureUserSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});
const ensureOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  ownerUserId: z.string().uuid(),
});
const memberSchema = z.object({ role: z.enum(["admin", "member"]).default("member") });
const ensureProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
});
const issueUserKeySchema = z.object({ name: z.string().trim().min(1).max(128) });

function platformAuditDetails(request: FastifyRequest, details: Record<string, unknown> = {}) {
  return { platformApiKeyId: request.apiKey!.id, ...details };
}

export async function registerPlatformProvisioningRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requirePlatformApiKey);

  app.post("/api/v1/platform/users/ensure", async (request, reply) => {
    const body = parseBody(ensureUserSchema, request.body, reply);
    if (!body) return;
    const existing = await app.db.prepare("SELECT id, username, status, is_platform_admin FROM admin_users WHERE username = ? COLLATE NOCASE")
      .get(body.username) as { id: string; username: string; status: string; is_platform_admin: number } | undefined;
    if (existing) {
      if (existing.status !== "active") return reply.code(409).send({ error: "USER_DISABLED", message: "Viron 账号已停用" });
      if (Boolean(existing.is_platform_admin)) {
        return reply.code(409).send({ error: "PLATFORM_USER_CONFLICT", message: "外部接入不能复用 Viron 平台管理员账号" });
      }
      return { id: existing.id, username: existing.username, created: false };
    }
    const passwordError = passwordPolicyError(body.password, app.config.allowWeakPasswords);
    if (passwordError) return reply.code(400).send({ error: "WEAK_PASSWORD", message: passwordError });
    const id = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    try {
      await app.db.prepare(`
        INSERT INTO admin_users (id, username, password_hash, is_platform_admin, status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'active', ?, ?)
      `).run(id, body.username, passwordHash, now, now);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const raced = await app.db.prepare("SELECT id, username FROM admin_users WHERE username = ? COLLATE NOCASE").get(body.username) as { id: string; username: string };
        return { ...raced, created: false };
      }
      throw error;
    }
    await writeAudit(app.db, { action: "platform.user_ensured", resourceType: "user", resourceId: id, summary: `平台 API 创建用户 ${body.username}`, details: platformAuditDetails(request), request });
    return reply.code(201).send({ id, username: body.username, created: true });
  });

  app.post("/api/v1/platform/organizations/ensure", async (request, reply) => {
    const body = parseBody(ensureOrganizationSchema, request.body, reply);
    if (!body) return;
    const owner = await app.db.prepare("SELECT id, status FROM admin_users WHERE id = ?").get(body.ownerUserId) as { id: string; status: string } | undefined;
    if (!owner || owner.status !== "active") return reply.code(404).send({ error: "OWNER_NOT_FOUND", message: "组织初始化管理员不存在或不可用" });
    let organization = await app.db.prepare("SELECT id, name FROM organizations WHERE name = ? COLLATE NOCASE").get(body.name) as { id: string; name: string } | undefined;
    let created = false;
    await app.db.transaction(async () => {
      if (!organization) {
        const now = new Date().toISOString();
        organization = { id: randomUUID(), name: body.name };
        try {
          await app.db.prepare("INSERT INTO organizations (id, name, description, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(organization.id, body.name, body.description, owner.id, now, now);
          created = true;
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          organization = await app.db.prepare("SELECT id, name FROM organizations WHERE name = ? COLLATE NOCASE").get(body.name) as { id: string; name: string };
        }
      }
      const now = new Date().toISOString();
      await app.db.prepare("INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)")
        .run(organization!.id, owner.id, now, now);
      await app.db.prepare("UPDATE organization_members SET role = 'admin', updated_at = ? WHERE organization_id = ? AND user_id = ?")
        .run(now, organization!.id, owner.id);
    })();
    await writeAudit(app.db, { action: "platform.organization_ensured", resourceType: "organization", resourceId: organization!.id, summary: `平台 API 确认组织 ${organization!.name}`, details: platformAuditDetails(request, { ownerUserId: owner.id, created }), request });
    return reply.code(created ? 201 : 200).send({ ...organization, ownerUserId: owner.id, created });
  });

  app.put<{ Params: { id: string; userId: string } }>("/api/v1/platform/organizations/:id/members/:userId", async (request, reply) => {
    const body = parseBody(memberSchema, request.body, reply);
    if (!body) return;
    const [organization, user] = await Promise.all([
      app.db.prepare("SELECT id, name FROM organizations WHERE id = ?").get(request.params.id),
      app.db.prepare("SELECT id, username, status FROM admin_users WHERE id = ?").get(request.params.userId) as Promise<{ id: string; username: string; status: string } | undefined>,
    ]);
    if (!organization || !user || user.status !== "active") return reply.code(404).send({ error: "NOT_FOUND", message: "组织或用户不存在" });
    const now = new Date().toISOString();
    const inserted = await app.db.prepare("INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(request.params.id, request.params.userId, body.role, now, now);
    await app.db.prepare("UPDATE organization_members SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?")
      .run(body.role, now, request.params.id, request.params.userId);
    await writeAudit(app.db, { action: "platform.organization_member_ensured", resourceType: "organization", resourceId: request.params.id, summary: `平台 API 确认组织成员 ${user.username}`, details: platformAuditDetails(request, { userId: user.id, role: body.role }), request });
    return { organizationId: request.params.id, userId: user.id, role: body.role, created: inserted.changes > 0 };
  });

  app.post<{ Params: { id: string } }>("/api/v1/platform/organizations/:id/projects/ensure", async (request, reply) => {
    const body = parseBody(ensureProjectSchema, request.body, reply);
    if (!body) return;
    if (!await app.db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(request.params.id)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "组织不存在" });
    }
    let project = await app.db.prepare("SELECT id, name FROM projects WHERE organization_id = ? AND name = ? COLLATE NOCASE")
      .get(request.params.id, body.name) as { id: string; name: string } | undefined;
    let created = false;
    if (!project) {
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        await app.db.prepare("INSERT INTO projects (id, organization_id, parent_id, name, description, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)")
          .run(id, request.params.id, body.name, body.description, now, now);
        project = { id, name: body.name };
        created = true;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        project = await app.db.prepare("SELECT id, name FROM projects WHERE organization_id = ? AND name = ? COLLATE NOCASE")
          .get(request.params.id, body.name) as { id: string; name: string };
      }
    }
    await writeAudit(app.db, { action: "platform.project_ensured", resourceType: "project", resourceId: project.id, summary: `平台 API 确认项目组 ${project.name}`, details: platformAuditDetails(request, { organizationId: request.params.id, created }), request });
    return reply.code(created ? 201 : 200).send({ ...project, organizationId: request.params.id, created });
  });

  app.put<{ Params: { id: string; userId: string } }>("/api/v1/platform/projects/:id/members/:userId", async (request, reply) => {
    const project = await app.db.prepare("SELECT id, organization_id, name FROM projects WHERE id = ?").get(request.params.id) as { id: string; organization_id: string; name: string } | undefined;
    if (!project) return reply.code(404).send({ error: "NOT_FOUND", message: "项目组不存在" });
    if (!await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(project.organization_id, request.params.userId)) {
      return reply.code(400).send({ error: "NOT_ORGANIZATION_MEMBER", message: "用户必须先加入项目组所属组织" });
    }
    const inserted = await app.db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)")
      .run(project.id, request.params.userId, new Date().toISOString());
    await writeAudit(app.db, { action: "platform.project_member_ensured", resourceType: "project", resourceId: project.id, summary: "平台 API 确认项目组成员", details: platformAuditDetails(request, { userId: request.params.userId }), request });
    return { projectId: project.id, userId: request.params.userId, created: inserted.changes > 0 };
  });

  app.post<{ Params: { id: string } }>("/api/v1/platform/users/:id/api-keys", async (request, reply) => {
    const body = parseBody(issueUserKeySchema, request.body, reply);
    if (!body) return;
    const user = await app.db.prepare("SELECT id, username, status, is_platform_admin FROM admin_users WHERE id = ?").get(request.params.id) as { id: string; username: string; status: string; is_platform_admin: number } | undefined;
    if (!user || user.status !== "active") return reply.code(404).send({ error: "NOT_FOUND", message: "用户不存在或不可用" });
    if (Boolean(user.is_platform_admin)) {
      return reply.code(409).send({ error: "PLATFORM_USER_CONFLICT", message: "平台 API 不能代替平台管理员签发个人 API Key" });
    }
    const activeKeys = await app.db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE key_type = 'personal' AND user_id = ? AND status = 'active'")
      .get(user.id) as { count: number | string };
    if (Number(activeKeys.count) >= 10) {
      return reply.code(409).send({ error: "API_KEY_LIMIT", message: "该用户已有过多有效个人 API Key，请先撤销旧 Key" });
    }
    const issued = await issueApiKey(app.db, "personal", user.id, body.name, null);
    await writeAudit(app.db, { action: "platform.user_api_key_created", resourceType: "api_key", resourceId: issued.id, summary: `平台 API 为 ${user.username} 创建个人 API Key`, details: platformAuditDetails(request, { userId: user.id }), request });
    return reply.code(201).send(issued);
  });

  app.delete<{ Params: { id: string; keyId: string } }>("/api/v1/platform/users/:id/api-keys/:keyId", async (request, reply) => {
    const revoked = await app.db.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND user_id = ? AND key_type = 'personal' AND status = 'active'")
      .run(new Date().toISOString(), request.params.keyId, request.params.id);
    if (!revoked.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "有效个人 API Key 不存在" });
    await writeAudit(app.db, { action: "platform.user_api_key_revoked", resourceType: "api_key", resourceId: request.params.keyId, summary: "平台 API 撤销个人 API Key", details: platformAuditDetails(request, { userId: request.params.id }), request });
    return reply.code(204).send();
  });
}
