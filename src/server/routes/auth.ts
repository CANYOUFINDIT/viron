import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AuthenticatedUser, OrganizationRole, WorkspaceContext } from "../access-control.js";
import { passwordPolicyError } from "../password-policy.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { executionScope } from "../execution-scope.js";
import { parseBody } from "../validation.js";
import { revokeUserRuntime } from "../user-runtime.js";
import { authenticatePersonalApiKey, hasBearerApiKey } from "../api-key-auth.js";

const COOKIE_NAME = "envman_session";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

const registerSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

const workspaceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("personal") }),
  z.object({ type: z.literal("organization"), id: z.string().uuid() }),
]);

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionCookieOptions(app: FastifyInstance) {
  return {
    path: "/",
    httpOnly: true,
    secure: app.config.cookieSecure ?? false,
    sameSite: "strict" as const,
    maxAge: app.config.sessionTtlHours * 60 * 60,
  };
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (hasBearerApiKey(request)) {
    await authenticatePersonalApiKey(request, reply);
    return;
  }
  const token = request.cookies[COOKIE_NAME];
  if (!token) {
    await reply.code(401).send({ error: "UNAUTHENTICATED", message: "请先登录" });
    return;
  }

  let row = await request.server.db.prepare(`
    SELECT s.id AS session_id, s.expires_at, s.workspace_type, s.workspace_id,
      u.id, u.username, u.is_platform_admin, u.status
    FROM sessions s
    JOIN admin_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash(token)) as
    | { session_id: string; expires_at: string; workspace_type: string; workspace_id: string; id: string; username: string; is_platform_admin: number; status: string }
    | undefined;

  if (!row || row.status !== "active" || new Date(row.expires_at).getTime() <= Date.now()) {
    if (row) {
      await request.server.db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
      await revokeUserRuntime(request.server, row.id, false);
    }
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    await reply.code(401).send({ error: "SESSION_EXPIRED", message: "登录已过期" });
    return;
  }

  let workspace: WorkspaceContext;
  if (row.workspace_type === "organization") {
    const organization = await request.server.db.prepare(`
      SELECT o.id, o.name, m.role
      FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
      WHERE o.id = ? AND m.user_id = ?
    `).get(row.workspace_id, row.id) as { id: string; name: string; role: OrganizationRole } | undefined;
    if (organization) {
      workspace = { type: "organization", id: organization.id, name: organization.name, role: organization.role };
    } else {
      await request.server.db.prepare("UPDATE sessions SET workspace_type = 'personal', workspace_id = ? WHERE id = ?").run(row.id, row.session_id);
      row = { ...row, workspace_type: "personal", workspace_id: row.id };
      workspace = { type: "personal", id: row.id, name: "个人工作台", role: "owner" };
    }
  } else {
    if (row.workspace_id !== row.id) {
      await request.server.db.prepare("UPDATE sessions SET workspace_id = ? WHERE id = ?").run(row.id, row.session_id);
    }
    workspace = { type: "personal", id: row.id, name: "个人工作台", role: "owner" };
  }
  request.admin = {
    id: row.id,
    username: row.username,
    isPlatformAdmin: Boolean(row.is_platform_admin),
    workspace,
  };
  request.sessionId = row.session_id;
  await request.server.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.session_id,
  );
}

async function workspacesFor(app: FastifyInstance, user: AuthenticatedUser) {
  const organizations = await app.db.prepare(`
    SELECT o.id, o.name, m.role
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ?
    ORDER BY o.name COLLATE NOCASE
  `).all(user.id) as Array<{ id: string; name: string; role: OrganizationRole }>;
  return [
    { type: "personal" as const, id: user.id, name: "个人工作台", role: "owner" as const },
    ...organizations.map((item) => ({ type: "organization" as const, ...item })),
  ];
}

async function authResponse(app: FastifyInstance, user: AuthenticatedUser) {
  const profile = await app.db.prepare("SELECT created_at FROM admin_users WHERE id = ?").get(user.id) as { created_at: string };
  return {
    user: { id: user.id, username: user.username, isPlatformAdmin: user.isPlatformAdmin, createdAt: profile.created_at },
    workspace: user.workspace,
    workspaces: await workspacesFor(app, user),
  };
}

async function createSession(app: FastifyInstance, user: { id: string; username: string; is_platform_admin: number }, reply: FastifyReply) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + app.config.sessionTtlHours * 60 * 60 * 1000);
  await app.db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, workspace_type, workspace_id, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, 'personal', ?, ?, ?, ?)
  `).run(randomUUID(), user.id, tokenHash(token), user.id, expiresAt.toISOString(), now.toISOString(), now.toISOString());
  reply.setCookie(COOKIE_NAME, token, sessionCookieOptions(app));
  const authenticated: AuthenticatedUser = {
    id: user.id,
    username: user.username,
    isPlatformAdmin: Boolean(user.is_platform_admin),
    workspace: { type: "personal", id: user.id, name: "个人工作台", role: "owner" },
  };
  return authenticated;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/auth/register", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = parseBody(registerSchema, request.body, reply);
    if (!body) return;
    const passwordError = passwordPolicyError(body.password, app.config.allowWeakPasswords);
    if (passwordError) return reply.code(400).send({ error: "WEAK_PASSWORD", message: passwordError });
    const existing = await app.db.prepare("SELECT id FROM admin_users WHERE username = ? COLLATE NOCASE").get(body.username);
    if (existing) return reply.code(409).send({ error: "USERNAME_EXISTS", message: "用户名已存在" });
    const id = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    try {
      await app.db.prepare(`
        INSERT INTO admin_users (id, username, password_hash, is_platform_admin, status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'active', ?, ?)
      `).run(id, body.username, passwordHash, now, now);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "USERNAME_EXISTS", message: "用户名已存在" });
      throw error;
    }
    const user = await createSession(app, { id, username: body.username, is_platform_admin: 0 }, reply);
    request.admin = user;
    await writeAudit(app.db, { action: "auth.register", resourceType: "user", resourceId: id, summary: `用户 ${body.username} 注册`, request });
    return reply.code(201).send(await authResponse(app, user));
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = parseBody(loginSchema, request.body, reply);
    if (!body) return;

    const user = await app.db.prepare(`
      SELECT id, username, password_hash, is_platform_admin, status FROM admin_users WHERE username = ? COLLATE NOCASE
    `).get(body.username) as { id: string; username: string; password_hash: string; is_platform_admin: number; status: string } | undefined;

    const valid = user?.status === "active" ? await argon2.verify(user.password_hash, body.password) : false;
    if (!user || !valid) {
      await writeAudit(app.db, {
        action: "auth.login_failed",
        resourceType: "user",
        summary: `用户登录失败：${body.username}`,
        request,
      });
      return reply.code(401).send({ error: "INVALID_CREDENTIALS", message: "用户名或密码错误" });
    }

    const authenticated = await createSession(app, user, reply);
    request.admin = authenticated;
    await writeAudit(app.db, {
      action: "auth.login",
      resourceType: "user",
      resourceId: user.id,
      summary: `用户 ${user.username} 登录`,
      request,
    });
    return authResponse(app, authenticated);
  });

  app.post("/api/v1/auth/logout", { preHandler: requireAdmin }, async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];
    if (token) await app.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    if (request.admin) await revokeUserRuntime(app, request.admin.id, false);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    await writeAudit(app.db, {
      action: "auth.logout",
      resourceType: "admin",
      resourceId: request.admin?.id,
      summary: `用户 ${request.admin?.username} 退出`,
      request,
    });
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", { preHandler: requireAdmin }, async (request) => authResponse(app, request.admin!));

  app.put("/api/v1/auth/workspace", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(workspaceSchema, request.body, reply);
    if (!body || !request.admin || !request.sessionId) return;
    let workspace: WorkspaceContext;
    if (body.type === "personal") {
      workspace = { type: "personal", id: request.admin.id, name: "个人工作台", role: "owner" };
    } else {
      const organization = await app.db.prepare(`
        SELECT o.id, o.name, m.role
        FROM organizations o
        JOIN organization_members m ON m.organization_id = o.id
        WHERE o.id = ? AND m.user_id = ?
      `).get(body.id, request.admin.id) as { id: string; name: string; role: OrganizationRole } | undefined;
      if (!organization) return reply.code(403).send({ error: "WORKSPACE_FORBIDDEN", message: "你不是该组织的成员" });
      workspace = { type: "organization", id: organization.id, name: organization.name, role: organization.role };
    }
    await app.db.prepare("UPDATE sessions SET workspace_type = ?, workspace_id = ?, last_seen_at = ? WHERE id = ?").run(
      workspace.type,
      workspace.id,
      new Date().toISOString(),
      request.sessionId,
    );
    await revokeUserRuntime(app, request.admin.id, false);
    request.admin.workspace = workspace;
    await writeAudit(app.db, { action: "auth.workspace_switched", resourceType: "workspace", resourceId: workspace.id, summary: `切换到${workspace.name}`, request });
    return authResponse(app, request.admin);
  });

  app.get("/api/v1/auth/execution-runtime", { preHandler: requireAdmin }, async (request, reply) => {
    const scope = executionScope(request);
    if (!scope || !request.admin) return reply.code(400).send({ error: "EXECUTION_SCOPE_REQUIRED", message: "缺少有效的 App 执行实例标识" });
    const counts = {
      web: app.webAccountViews.activeCount(request.admin.id, scope),
      ssh: app.sshSessions.activeCount(request.admin.id, scope),
      sftp: app.sftpTransfers.activeCount(request.admin.id, scope),
      logs: app.sshLogStreams.activeCount(request.admin.id, scope),
      database: app.databaseQueries.activeCount(request.admin.id, scope) + app.databaseTasks.activeCount(request.admin.id, scope),
    };
    return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  });

  app.post("/api/v1/auth/execution-runtime/close", { preHandler: requireAdmin }, async (request, reply) => {
    const scope = executionScope(request);
    if (!scope || !request.admin) return reply.code(400).send({ error: "EXECUTION_SCOPE_REQUIRED", message: "缺少有效的 App 执行实例标识" });
    const reason = "App 连接模式已切换";
    await Promise.all([
      app.sshSessions.closeOwner(request.admin.id, reason, scope),
      Promise.resolve(app.sshLogStreams.closeOwner(request.admin.id, reason, scope)),
      app.sftpTransfers.closeOwner(request.admin.id, scope),
      Promise.resolve(app.databaseQueries.closeOwner(request.admin.id, scope)),
      app.databaseTasks.closeOwner(request.admin.id, scope),
      app.webAccountViews.closeOwner(request.admin.id, reason, scope),
    ]);
    return reply.code(204).send();
  });

  app.put("/api/v1/auth/password", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(passwordSchema, request.body, reply);
    if (!body || !request.admin) return;
    const user = await app.db.prepare("SELECT password_hash FROM admin_users WHERE id = ?").get(request.admin.id) as {
      password_hash: string;
    };
    if (!(await argon2.verify(user.password_hash, body.currentPassword))) {
      return reply.code(400).send({ error: "INVALID_PASSWORD", message: "当前密码不正确" });
    }
    const passwordError = passwordPolicyError(body.newPassword, app.config.allowWeakPasswords);
    if (passwordError) return reply.code(400).send({ error: "WEAK_PASSWORD", message: passwordError });
    const passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
    await app.db.prepare("UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      passwordHash,
      new Date().toISOString(),
      request.admin.id,
    );
    await app.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(
      request.admin.id,
      tokenHash(request.cookies[COOKIE_NAME] ?? ""),
    );
    await revokeUserRuntime(app, request.admin.id, false);
    await writeAudit(app.db, {
      action: "auth.password_changed",
      resourceType: "user",
      resourceId: request.admin.id,
      summary: "用户修改密码",
      request,
    });
    return { ok: true };
  });
}
