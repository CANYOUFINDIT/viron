import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessConnection } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const favoriteSchema = z.object({
  connectionId: z.string().uuid(),
  command: z.string().min(1).max(16 * 1024).refine((value) => !/[\r\n]/.test(value)),
  cwd: z.string().trim().max(2048).default(""),
});

interface FavoriteRow {
  id: string;
  connection_id: string;
  command_text: string;
  cwd: string;
  created_at: string;
  updated_at: string;
}

function isSensitiveSshCommand(command: string): boolean {
  if (/^\s/.test(command)) return true;
  return [
    /\b(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)\b\s*(?:=|:)\s*\S+/i,
    /--(?:password|passwd|token|secret|api[_-]?key)(?:=|\s+)\S+/i,
    /\b(?:mysql|mariadb)\b[^\r\n]*\s-p\S+/i,
    /\b(?:export|set)\s+[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=/i,
  ].some((pattern) => pattern.test(command));
}

function commandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function serializeFavorite(row: FavoriteRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    command: row.command_text,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function registerSshCommandFavoriteRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { connectionId?: string } }>("/api/v1/ssh-command-favorites", { preHandler: requireAdmin }, async (request, reply) => {
    const parsedConnectionId = z.string().uuid().safeParse(request.query.connectionId);
    if (!parsedConnectionId.success) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "请选择 SSH 连接" });
    if (!await canAccessConnection(app.db, request.admin!, "ssh", parsedConnectionId.data)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    }
    const rows = await app.db.prepare(`
      SELECT id, connection_id, command_text, cwd, created_at, updated_at
      FROM ssh_command_favorites
      WHERE owner_user_id = ? AND connection_id = ?
      ORDER BY updated_at DESC
    `).all(request.admin!.id, parsedConnectionId.data) as FavoriteRow[];
    return { items: rows.map(serializeFavorite) };
  });

  app.post("/api/v1/ssh-command-favorites", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(favoriteSchema, request.body, reply);
    if (!body || !request.admin) return;
    const command = body.command.trim();
    if (!command || isSensitiveSshCommand(body.command)) {
      return reply.code(400).send({ error: "SENSITIVE_COMMAND", message: "敏感命令不能收藏" });
    }
    if (!await canAccessConnection(app.db, request.admin, "ssh", body.connectionId)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
    }

    const hash = commandHash(command);
    const existing = await app.db.prepare(`
      SELECT id, connection_id, command_text, cwd, created_at, updated_at
      FROM ssh_command_favorites
      WHERE owner_user_id = ? AND connection_id = ? AND command_hash = ?
    `).get(request.admin.id, body.connectionId, hash) as FavoriteRow | undefined;
    const now = new Date().toISOString();
    if (existing) {
      await app.db.prepare("UPDATE ssh_command_favorites SET cwd = ?, updated_at = ? WHERE id = ?").run(body.cwd, now, existing.id);
      return { item: serializeFavorite({ ...existing, cwd: body.cwd, updated_at: now }), created: false };
    }

    const id = randomUUID();
    try {
      await app.db.prepare(`
        INSERT INTO ssh_command_favorites (
          id, owner_user_id, connection_id, command_text, command_hash, cwd, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.admin.id, body.connectionId, command, hash, body.cwd, now, now);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await app.db.prepare(`
        SELECT id, connection_id, command_text, cwd, created_at, updated_at
        FROM ssh_command_favorites
        WHERE owner_user_id = ? AND connection_id = ? AND command_hash = ?
      `).get(request.admin.id, body.connectionId, hash) as FavoriteRow | undefined;
      if (!raced) throw error;
      await app.db.prepare("UPDATE ssh_command_favorites SET cwd = ?, updated_at = ? WHERE id = ?").run(body.cwd, now, raced.id);
      return { item: serializeFavorite({ ...raced, cwd: body.cwd, updated_at: now }), created: false };
    }
    const connection = await app.db.prepare("SELECT name FROM ssh_connections WHERE id = ?").get(body.connectionId) as { name: string };
    await writeAudit(app.db, {
      action: "ssh.command_favorite_created",
      resourceType: "ssh_connection",
      resourceId: body.connectionId,
      summary: `收藏 SSH 命令 ${connection.name}`,
      request,
    });
    return reply.code(201).send({
      item: serializeFavorite({ id, connection_id: body.connectionId, command_text: command, cwd: body.cwd, created_at: now, updated_at: now }),
      created: true,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/ssh-command-favorites/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const favorite = await app.db.prepare(`
      SELECT id, connection_id, command_text, cwd, created_at, updated_at
      FROM ssh_command_favorites WHERE id = ? AND owner_user_id = ?
    `).get(request.params.id, request.admin!.id) as FavoriteRow | undefined;
    if (!favorite || !await canAccessConnection(app.db, request.admin!, "ssh", favorite.connection_id)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 命令收藏不存在" });
    }
    await app.db.prepare("DELETE FROM ssh_command_favorites WHERE id = ?").run(favorite.id);
    await writeAudit(app.db, {
      action: "ssh.command_favorite_deleted",
      resourceType: "ssh_connection",
      resourceId: favorite.connection_id,
      summary: "取消收藏 SSH 命令",
      request,
    });
    return reply.code(204).send();
  });
}
