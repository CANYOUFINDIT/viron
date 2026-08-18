import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { canAccessEnvironment, canManageWorkspace } from "../access-control.js";
import { parseBody } from "../validation.js";
import { loadWebFavicon } from "../web-favicon.js";
import { hasExactIds } from "../../shared/tab-order.js";
import { requireAdmin } from "./auth.js";

const entrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().url().max(2048),
  description: z.string().trim().max(1000).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

const credentialSchema = z.object({
  username: z.string().trim().min(1).max(256),
  password: z.string().max(4096),
  note: z.string().trim().max(1000).default(""),
  customFields: z.record(z.string(), z.string()).default({}),
});

const credentialUpdateSchema = credentialSchema.extend({ password: z.string().max(4096).optional() });
const orderSchema = z.object({ orderedIds: z.array(z.string().uuid()).max(200) });

async function entryEnvironmentId(app: FastifyInstance, entryId: string): Promise<string | null> {
  const row = await app.db.prepare("SELECT environment_id FROM web_entries WHERE id = ?").get(entryId) as { environment_id: string } | undefined;
  return row?.environment_id ?? null;
}

async function credentialEnvironmentId(app: FastifyInstance, credentialId: string): Promise<string | null> {
  const row = await app.db.prepare("SELECT w.environment_id FROM web_credentials c JOIN web_entries w ON w.id = c.web_entry_id WHERE c.id = ?").get(credentialId) as { environment_id: string } | undefined;
  return row?.environment_id ?? null;
}

function requireManager(request: Parameters<typeof canManageWorkspace>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "只有工作空间管理员可以修改 Web 入口和账号" });
  return false;
}

export async function registerWebEntryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/web-entries",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
      const rows = await app.db.prepare(`
        SELECT w.*,
          (SELECT COUNT(*) FROM web_credentials c WHERE c.web_entry_id = w.id) AS credential_count
        FROM web_entries w
        WHERE w.environment_id = ?
        ORDER BY w.sort_order, w.created_at
      `).all(request.params.environmentId) as Record<string, unknown>[];
      return {
        items: rows.map((row) => ({
          id: row.id,
          environmentId: row.environment_id,
          name: row.name,
          url: row.url,
          description: row.description,
          tags: JSON.parse(String(row.tags_json ?? "[]")),
          credentialCount: Number(row.credential_count),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      };
    },
  );

  app.post<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/web-entries",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(entrySchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
      const id = randomUUID();
      const now = new Date().toISOString();
      const nextOrder = await app.db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM web_entries WHERE environment_id = ?
      `).get(request.params.environmentId) as { next_sort_order: number | string };
      await app.db.prepare(`
        INSERT INTO web_entries (
          id, environment_id, name, url, description, tags_json, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        request.params.environmentId,
        body.name,
        body.url,
        body.description,
        JSON.stringify(body.tags),
        Number(nextOrder.next_sort_order),
        now,
        now,
      );
      await writeAudit(app.db, {
        action: "web_entry.created",
        resourceType: "web_entry",
        resourceId: id,
        summary: `添加 Web 入口 ${body.name}`,
        request,
      });
      return reply.code(201).send({ id });
    },
  );

  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/web-entries/order",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(orderSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
      const rows = await app.db.prepare("SELECT id FROM web_entries WHERE environment_id = ?").all(request.params.environmentId) as Array<{ id: string }>;
      if (!hasExactIds(body.orderedIds, rows.map((row) => row.id))) {
        return reply.code(400).send({ error: "INVALID_WEB_ENTRY_ORDER", message: "Web 入口排序必须包含当前环境的全部入口" });
      }
      await app.db.transaction(async () => {
        for (const [index, id] of body.orderedIds.entries()) {
          await app.db.prepare("UPDATE web_entries SET sort_order = ? WHERE id = ? AND environment_id = ?")
            .run(index, id, request.params.environmentId);
        }
      })();
      await writeAudit(app.db, {
        action: "web_entry.reordered",
        resourceType: "environment",
        resourceId: request.params.environmentId,
        summary: "调整 Web 入口顺序",
        details: { orderedIds: body.orderedIds },
        request,
      });
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/web-entries/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(entrySchema, request.body, reply);
      if (!body) return;
      const environmentId = await entryEnvironmentId(app, request.params.id);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      const credentials = await app.db.prepare("SELECT id FROM web_credentials WHERE web_entry_id = ?").all(request.params.id) as Array<{ id: string }>;
      const result = await app.db.prepare("UPDATE web_entries SET name = ?, url = ?, description = ?, tags_json = ?, updated_at = ? WHERE id = ?")
        .run(body.name, body.url, body.description, JSON.stringify(body.tags), new Date().toISOString(), request.params.id);
      if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      await Promise.all(credentials.map((credential) => app.webAccountViews.sleepCredential(credential.id)));
      await writeAudit(app.db, { action: "web_entry.updated", resourceType: "web_entry", resourceId: request.params.id, summary: `更新 Web 入口 ${body.name}`, request });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/web-entries/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const environmentId = await entryEnvironmentId(app, request.params.id);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      const entry = await app.db.prepare("SELECT name FROM web_entries WHERE id = ?").get(request.params.id) as { name: string } | undefined;
      if (!entry) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      const credentials = await app.db.prepare("SELECT id FROM web_credentials WHERE web_entry_id = ?").all(request.params.id) as Array<{ id: string }>;
      await Promise.all(credentials.map((credential) => app.webAccountViews.purgeCredential(credential.id)));
      await app.db.prepare("DELETE FROM web_entries WHERE id = ?").run(request.params.id);
      await writeAudit(app.db, { action: "web_entry.deleted", resourceType: "web_entry", resourceId: request.params.id, summary: `删除 Web 入口 ${entry.name}`, request });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { entryId: string } }>(
    "/api/v1/web-entries/:entryId/favicon",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const entry = await app.db.prepare("SELECT environment_id, url FROM web_entries WHERE id = ?").get(request.params.entryId) as { environment_id: string; url: string } | undefined;
      if (!entry || !await canAccessEnvironment(app.db, request.admin!, entry.environment_id)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      reply.header("Cache-Control", "private, max-age=900");
      return { dataUrl: await loadWebFavicon(entry.url) };
    },
  );

  app.get<{ Params: { entryId: string } }>(
    "/api/v1/web-entries/:entryId/credentials",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const environmentId = await entryEnvironmentId(app, request.params.entryId);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      return { items: (await app.db.prepare(`
        SELECT id, web_entry_id, username, note, custom_fields_json, created_at, updated_at
        FROM web_credentials WHERE web_entry_id = ? ORDER BY sort_order, created_at
      `).all(request.params.entryId)).map((row) => {
        const item = row as Record<string, unknown>;
        return {
          id: item.id,
          webEntryId: item.web_entry_id,
          username: item.username,
          note: item.note,
          customFields: canManageWorkspace(request) ? JSON.parse(String(item.custom_fields_json ?? "{}")) : {},
          hasPassword: true,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        };
      }) };
    },
  );

  app.post<{ Params: { entryId: string } }>(
    "/api/v1/web-entries/:entryId/credentials",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(credentialSchema, request.body, reply);
      if (!body) return;
      const environmentId = await entryEnvironmentId(app, request.params.entryId);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      const id = randomUUID();
      const now = new Date().toISOString();
      const nextOrder = await app.db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM web_credentials WHERE web_entry_id = ?
      `).get(request.params.entryId) as { next_sort_order: number | string };
      await app.db.prepare(`
        INSERT INTO web_credentials (
          id, web_entry_id, username, password_ciphertext, note, custom_fields_json, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        request.params.entryId,
        body.username,
        app.secrets.encrypt(body.password),
        body.note,
        JSON.stringify(body.customFields),
        Number(nextOrder.next_sort_order),
        now,
        now,
      );
      await writeAudit(app.db, {
        action: "web_credential.created",
        resourceType: "web_credential",
        resourceId: id,
        summary: `添加 Web 登录账号 ${body.username}`,
        request,
      });
      return reply.code(201).send({ id });
    },
  );

  app.put<{ Params: { entryId: string } }>(
    "/api/v1/web-entries/:entryId/credentials/order",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(orderSchema, request.body, reply);
      if (!body) return;
      const environmentId = await entryEnvironmentId(app, request.params.entryId);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "Web 入口不存在" });
      const rows = await app.db.prepare("SELECT id FROM web_credentials WHERE web_entry_id = ?").all(request.params.entryId) as Array<{ id: string }>;
      if (!hasExactIds(body.orderedIds, rows.map((row) => row.id))) {
        return reply.code(400).send({ error: "INVALID_WEB_CREDENTIAL_ORDER", message: "登录账号排序必须包含当前入口的全部账号" });
      }
      await app.db.transaction(async () => {
        for (const [index, id] of body.orderedIds.entries()) {
          await app.db.prepare("UPDATE web_credentials SET sort_order = ? WHERE id = ? AND web_entry_id = ?")
            .run(index, id, request.params.entryId);
        }
      })();
      await writeAudit(app.db, {
        action: "web_credential.reordered",
        resourceType: "web_entry",
        resourceId: request.params.entryId,
        summary: "调整 Web 登录账号顺序",
        details: { orderedIds: body.orderedIds },
        request,
      });
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/web-credentials/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(credentialUpdateSchema, request.body, reply);
      if (!body) return;
      const environmentId = await credentialEnvironmentId(app, request.params.id);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      const existing = await app.db.prepare("SELECT password_ciphertext FROM web_credentials WHERE id = ?").get(request.params.id) as { password_ciphertext: string } | undefined;
      if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      await app.db.prepare("UPDATE web_credentials SET username = ?, password_ciphertext = ?, note = ?, custom_fields_json = ?, updated_at = ? WHERE id = ?")
        .run(body.username, body.password ? app.secrets.encrypt(body.password) : existing.password_ciphertext, body.note, JSON.stringify(body.customFields), new Date().toISOString(), request.params.id);
      await writeAudit(app.db, { action: "web_credential.updated", resourceType: "web_credential", resourceId: request.params.id, summary: `更新 Web 登录账号 ${body.username}`, request });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/web-credentials/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const environmentId = await credentialEnvironmentId(app, request.params.id);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      const credential = await app.db.prepare("SELECT username FROM web_credentials WHERE id = ?").get(request.params.id) as { username: string } | undefined;
      if (!credential) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      await app.webAccountViews.purgeCredential(request.params.id);
      await app.db.prepare("DELETE FROM web_credentials WHERE id = ?").run(request.params.id);
      await writeAudit(app.db, { action: "web_credential.deleted", resourceType: "web_credential", resourceId: request.params.id, summary: `删除 Web 登录账号 ${credential.username}`, request });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/web-credentials/:id/reveal",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const environmentId = await credentialEnvironmentId(app, request.params.id);
      if (!environmentId || !await canAccessEnvironment(app.db, request.admin!, environmentId)) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      const credential = await app.db.prepare(`
        SELECT username, password_ciphertext FROM web_credentials WHERE id = ?
      `).get(request.params.id) as { username: string; password_ciphertext: string } | undefined;
      if (!credential) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      await writeAudit(app.db, {
        action: "web_credential.revealed",
        resourceType: "web_credential",
        resourceId: request.params.id,
        summary: `查看 Web 账号 ${credential.username} 的密码`,
        request,
      });
      return { password: app.secrets.decrypt(credential.password_ciphertext) };
    },
  );
}
