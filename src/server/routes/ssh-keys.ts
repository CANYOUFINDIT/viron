import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canManageWorkspace, workspaceParams, workspaceWhere } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { inspectSshPrivateKey, generateSshKeyPair } from "../ssh/key-store.js";
import { revokeWorkspaceRuntime } from "../user-runtime.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const importSchema = z.object({
  name: z.string().trim().min(1).max(160),
  privateKey: z.string().min(1).max(128 * 1024),
  passphrase: z.string().max(4096).default(""),
});

const generateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  algorithm: z.enum(["ed25519", "rsa3072", "rsa4096"]).default("ed25519"),
  passphrase: z.string().max(4096).default(""),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160),
});

interface SshKeyRow {
  id: string;
  name: string;
  algorithm: string;
  public_key: string;
  fingerprint: string;
  private_key_ciphertext: string;
  created_by_user_id: string;
  creator_name?: string;
  connection_count?: number | string;
  created_at: string;
  updated_at: string;
}

function requireWorkspaceManager(request: Parameters<typeof canManageWorkspace>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "当前工作空间只有管理员可以管理 SSH 密钥" });
  return false;
}

function keyDto(row: SshKeyRow) {
  return {
    id: row.id,
    name: row.name,
    algorithm: row.algorithm,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    connectionCount: Number(row.connection_count ?? 0),
    createdBy: row.creator_name ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exportFilename(name: string, part: "private" | "public"): string {
  const safe = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "ssh-key";
  return part === "public" ? `${safe}.pub` : safe;
}

async function findKey(app: FastifyInstance, id: string, workspace: ReturnType<typeof workspaceParams>): Promise<SshKeyRow | undefined> {
  return app.db.prepare(`SELECT * FROM ssh_keys WHERE id = ? AND ${workspaceWhere()}`).get(id, ...workspace) as Promise<SshKeyRow | undefined>;
}

async function insertKey(
  app: FastifyInstance,
  request: Parameters<typeof workspaceParams>[0],
  input: { name: string; privateKey: string; passphrase: string; publicKey: string; algorithm: string; fingerprint: string },
): Promise<SshKeyRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    await app.db.prepare(`
      INSERT INTO ssh_keys (
        id, workspace_type, workspace_id, name, algorithm, public_key, fingerprint,
        private_key_ciphertext, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ...workspaceParams(request),
      input.name,
      input.algorithm,
      input.publicKey,
      input.fingerprint,
      app.secrets.encrypt(JSON.stringify({ privateKey: input.privateKey, passphrase: input.passphrase })),
      request.admin!.id,
      now,
      now,
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) throw Object.assign(new Error("当前工作空间已存在同名 SSH 密钥"), { statusCode: 409 });
    throw error;
  }
  return (await findKey(app, id, workspaceParams(request)))!;
}

export async function registerSshKeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return reply;
  });

  app.get("/api/v1/ssh-keys", async (request) => {
    const rows = await app.db.prepare(`
      SELECT k.*, u.username AS creator_name,
        (SELECT COUNT(*) FROM ssh_connections c WHERE c.ssh_key_id = k.id) AS connection_count
      FROM ssh_keys k
      LEFT JOIN admin_users u ON u.id = k.created_by_user_id
      WHERE ${workspaceWhere("k")}
      ORDER BY k.name
    `).all(...workspaceParams(request)) as SshKeyRow[];
    return { items: rows.map(keyDto) };
  });

  app.post("/api/v1/ssh-keys/import", async (request, reply) => {
    const body = parseBody(importSchema, request.body, reply);
    if (!body) return;
    let parsed;
    try {
      parsed = inspectSshPrivateKey(body.privateKey, body.passphrase);
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_SSH_KEY", message: error instanceof Error ? error.message : "私钥无效" });
    }
    try {
      const row = await insertKey(app, request, { ...body, ...parsed });
      await writeAudit(app.db, {
        action: "ssh_key.imported",
        resourceType: "ssh_key",
        resourceId: row.id,
        summary: `导入 SSH 密钥 ${row.name}`,
        details: { algorithm: row.algorithm, fingerprint: row.fingerprint },
        request,
      });
      return reply.code(201).send(keyDto(row));
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 409) return reply.code(409).send({ error: "SSH_KEY_NAME_EXISTS", message: (error as Error).message });
      throw error;
    }
  });

  app.post("/api/v1/ssh-keys/generate", async (request, reply) => {
    const body = parseBody(generateSchema, request.body, reply);
    if (!body) return;
    const pair = generateSshKeyPair(body.algorithm, body.passphrase, body.name);
    try {
      const row = await insertKey(app, request, {
        name: body.name,
        privateKey: pair.privateKey,
        passphrase: body.passphrase,
        publicKey: pair.publicKey,
        algorithm: pair.parsed.algorithm,
        fingerprint: pair.parsed.fingerprint,
      });
      await writeAudit(app.db, {
        action: "ssh_key.generated",
        resourceType: "ssh_key",
        resourceId: row.id,
        summary: `生成 SSH 密钥 ${row.name}`,
        details: { algorithm: row.algorithm, fingerprint: row.fingerprint },
        request,
      });
      return reply.code(201).send(keyDto(row));
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 409) return reply.code(409).send({ error: "SSH_KEY_NAME_EXISTS", message: (error as Error).message });
      throw error;
    }
  });

  app.put<{ Params: { id: string } }>("/api/v1/ssh-keys/:id", async (request, reply) => {
    const body = parseBody(updateSchema, request.body, reply);
    if (!body) return;
    const key = await findKey(app, request.params.id, workspaceParams(request));
    if (!key) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 密钥不存在" });
    try {
      await app.db.prepare(`UPDATE ssh_keys SET name = ?, updated_at = ? WHERE id = ?`).run(body.name, new Date().toISOString(), key.id);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "SSH_KEY_NAME_EXISTS", message: "当前工作空间已存在同名 SSH 密钥" });
      throw error;
    }
    await writeAudit(app.db, { action: "ssh_key.updated", resourceType: "ssh_key", resourceId: key.id, summary: `更新 SSH 密钥 ${body.name}`, request });
    return keyDto((await findKey(app, key.id, workspaceParams(request)))!);
  });

  app.get<{ Params: { id: string }; Querystring: { part?: string } }>("/api/v1/ssh-keys/:id/export", async (request, reply) => {
    const key = await findKey(app, request.params.id, workspaceParams(request));
    if (!key) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 密钥不存在" });
    const part = request.query.part === "private" ? "private" : "public";
    let content = key.public_key.endsWith("\n") ? key.public_key : `${key.public_key}\n`;
    if (part === "private") {
      const credential = JSON.parse(app.secrets.decrypt(key.private_key_ciphertext)) as { privateKey?: string };
      if (!credential.privateKey) return reply.code(409).send({ error: "SSH_KEY_CONTENT_MISSING", message: "SSH 密钥没有保存私钥" });
      content = credential.privateKey.endsWith("\n") ? credential.privateKey : `${credential.privateKey}\n`;
    }
    const filename = exportFilename(key.name, part);
    reply.header("Content-Type", part === "private" ? "application/x-pem-file" : "text/plain; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    reply.header("Cache-Control", "no-store");
    await writeAudit(app.db, {
      action: part === "private" ? "ssh_key.private_exported" : "ssh_key.public_exported",
      resourceType: "ssh_key",
      resourceId: key.id,
      summary: `导出 SSH 密钥 ${key.name} 的${part === "private" ? "私钥" : "公钥"}`,
      details: { fingerprint: key.fingerprint },
      request,
    });
    return reply.send(content);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/ssh-keys/:id", async (request, reply) => {
    const key = await findKey(app, request.params.id, workspaceParams(request));
    if (!key) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 密钥不存在" });
    const usage = await app.db.prepare("SELECT COUNT(*) AS count FROM ssh_connections WHERE ssh_key_id = ?").get(key.id) as { count: number | string };
    if (Number(usage.count)) {
      return reply.code(409).send({ error: "SSH_KEY_IN_USE", message: `该密钥仍被 ${Number(usage.count)} 条 SSH 连接使用，请先解除关联` });
    }
    await app.db.prepare("DELETE FROM ssh_keys WHERE id = ?").run(key.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, { action: "ssh_key.deleted", resourceType: "ssh_key", resourceId: key.id, summary: `删除 SSH 密钥 ${key.name}`, request });
    return reply.code(204).send();
  });
}
