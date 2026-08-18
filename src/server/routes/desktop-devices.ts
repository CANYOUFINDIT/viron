import {
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessConnection, canAccessWebCredential, canManageWorkspace } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { decryptDatabaseCredential, hydrateDatabaseOptions } from "../database-credentials.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { acceptDesktopReport, DesktopReportError } from "../desktop-report.js";
import { resolveSshCredential } from "../ssh/key-store.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const deviceIdSchema = z.string().uuid();
const publicKeySchema = z.string().min(256).max(8192);
const challengeProofSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const registrationSchema = z.object({
  deviceId: deviceIdSchema,
  publicKey: publicKeySchema,
});

const proofSchema = z.object({ proof: challengeProofSchema });

const envelopeRequestSchema = z.object({
  deviceId: deviceIdSchema,
  requestId: z.string().uuid(),
  auditSource: z.enum(["manual", "mcp"]).default("manual"),
  endpoint: z.string().url().max(2048).transform((value, context) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      context.addIssue({ code: "custom", message: "Endpoint 必须是 HTTP(S) Origin" });
      return z.NEVER;
    }
    return url.origin;
  }),
});

const databaseExecutionReportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("query"),
    operationId: z.string().uuid(),
    connectionId: z.string().uuid(),
    database: z.string().max(255).default(""),
    sql: z.string().min(1).max(2 * 1024 * 1024),
    status: z.enum(["success", "error", "cancelled"]),
    durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
    rowCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    error: z.string().max(8_192).default(""),
    auditSource: z.enum(["manual", "mcp"]).default("manual"),
  }),
  z.object({
    kind: z.literal("operation"),
    operationId: z.string().uuid(),
    connectionId: z.string().uuid(),
    action: z.enum([
      "connection_tested",
      "connection_test_failed",
      "queries_read_batch",
      "table_data_changed",
      "table_exported",
      "table_imported",
      "backup_success",
      "backup_error",
      "backup_cancelled",
      "restore_success",
      "restore_error",
      "restore_cancelled",
      "transfer_success",
      "transfer_error",
      "transfer_cancelled",
    ]),
    summary: z.string().min(1).max(500),
    details: z.record(z.string(), z.unknown()).default({}),
    auditSource: z.enum(["manual", "mcp"]).default("manual"),
  }),
]);

const redisExecutionReportSchema = z.object({
  operationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  action: z.enum(["connection_tested", "connection_test_failed", "info_read", "keys_scanned", "command_executed", "command_failed", "command_rejected", "commands_read_batch"]),
  summary: z.string().min(1).max(500),
  details: z.record(z.string(), z.unknown()).default({}),
  auditSource: z.enum(["manual", "mcp"]).default("manual"),
});

const sshExecutionReportSchema = z.object({
  operationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  action: z.literal("commands_read_batch"),
  summary: z.string().min(1).max(500),
  details: z.record(z.string(), z.unknown()).default({}),
  auditSource: z.enum(["manual", "mcp"]).default("manual"),
});

const connectionInspectionReportSchema = z.object({
  operationId: z.string().uuid(),
  items: z.array(z.object({
    type: z.enum(["ssh", "database", "redis"]),
    id: z.string().uuid(),
    status: z.enum(["available", "unavailable"]),
    latencyMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
    message: z.string().max(8_192),
  })).min(1).max(500),
  auditSource: z.enum(["manual", "mcp"]).default("manual"),
});

interface StoredDevice {
  device_id: string;
  user_id: string;
  public_key_pem: string;
  key_id: string;
  status: "active" | "revoked";
}

function publicKeyDetails(value: string): { pem: string; fingerprint: string } {
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new Error("设备公钥必须使用至少 3072 位 RSA");
  }
  const pem = key.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  return { pem, fingerprint };
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function credentialPayload(app: FastifyInstance, row: {
  id: string;
  web_entry_id: string;
  entry_url: string;
  username: string;
  password_ciphertext: string;
  custom_fields_json: string;
  updated_at: string;
}) {
  return {
    credentialId: row.id,
    entryId: row.web_entry_id,
    entryUrl: row.entry_url,
    username: row.username,
    password: app.secrets.decrypt(row.password_ciphertext),
    customFields: JSON.parse(row.custom_fields_json || "{}") as Record<string, string>,
    credentialUpdatedAt: row.updated_at,
  };
}

interface SshEnvelopeRow {
  id: string;
  workspace_type: "personal" | "organization";
  workspace_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "privateKey" | "keyboardInteractive";
  ssh_key_id: string | null;
  credential_ciphertext: string;
  jump_connection_id: string | null;
  options_json: string;
  source_deleted: number;
  updated_at: string;
}

interface DatabaseEnvelopeRow {
  id: string;
  workspace_type: "personal" | "organization";
  workspace_id: string;
  name: string;
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  username: string;
  credential_ciphertext: string;
  default_database: string;
  connection_mode: "tcp" | "sshTunnel" | "httpTunnel";
  options_json: string;
  source_deleted: number;
  updated_at: string;
}

interface RedisEnvelopeRow {
  id: string;
  workspace_type: "personal" | "organization";
  workspace_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credential_ciphertext: string;
  default_database: number;
  connection_mode: "tcp" | "sshTunnel";
  options_json: string;
  source_deleted: number;
  updated_at: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function sshConnectionPayload(app: FastifyInstance, row: SshEnvelopeRow) {
  return {
    connectionId: row.id,
    name: row.name,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    authType: row.auth_type,
    credential: await resolveSshCredential(app, row),
    jumpConnectionId: row.jump_connection_id,
    options: parseJson<Record<string, unknown>>(row.options_json, {}),
    connectionUpdatedAt: row.updated_at,
  };
}

function databaseConnectionPayload(app: FastifyInstance, row: DatabaseEnvelopeRow) {
  const credential = decryptDatabaseCredential(app, row.credential_ciphertext);
  const options = hydrateDatabaseOptions(parseJson<Record<string, unknown>>(row.options_json, {}), credential);
  return {
    connectionId: row.id,
    name: row.name,
    engine: row.engine,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    password: credential.password ?? "",
    httpTunnelUsername: credential.httpTunnelUsername ?? "",
    httpTunnelPassword: credential.httpTunnelPassword ?? "",
    defaultDatabase: row.default_database,
    connectionMode: row.connection_mode,
    options,
    connectionUpdatedAt: row.updated_at,
  };
}

function redisConnectionPayload(app: FastifyInstance, row: RedisEnvelopeRow) {
  const credential = parseJson<{
    password?: string;
    tlsCa?: string;
    tlsCertificate?: string;
    tlsPrivateKey?: string;
    tlsPassphrase?: string;
  }>(app.secrets.decrypt(row.credential_ciphertext), {});
  const options = parseJson<Record<string, unknown> & { tls?: Record<string, unknown> }>(row.options_json, {});
  options.tls = {
    ...(options.tls ?? {}),
    ca: credential.tlsCa ?? "",
    certificate: credential.tlsCertificate ?? "",
    privateKey: credential.tlsPrivateKey ?? "",
    passphrase: credential.tlsPassphrase ?? "",
  };
  return {
    connectionId: row.id,
    name: row.name,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    password: credential.password ?? "",
    defaultDatabase: Number(row.default_database),
    connectionMode: row.connection_mode,
    options,
    connectionUpdatedAt: row.updated_at,
  };
}

function encryptEnvelope(device: StoredDevice, protectedPayload: Record<string, unknown>, payload: unknown) {
  const protectedBytes = Buffer.from(JSON.stringify(protectedPayload), "utf8");
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  cipher.setAAD(protectedBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = publicEncrypt({ key: device.public_key_pem, oaepHash: "sha256" }, contentKey);
  return {
    protected: base64url(protectedBytes),
    encryptedKey: base64url(encryptedKey),
    iv: base64url(iv),
    ciphertext: base64url(ciphertext),
    tag: base64url(tag),
  };
}

export async function registerDesktopDeviceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { deviceId: string } }>(
    "/api/v1/desktop/devices/:deviceId",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const deviceId = deviceIdSchema.safeParse(request.params.deviceId);
      if (!deviceId.success) return reply.code(400).send({ error: "INVALID_DEVICE_ID", message: "设备 ID 无效" });
      const device = await app.db.prepare(`
        SELECT device_id, user_id, key_id, status FROM desktop_devices WHERE device_id = ? AND user_id = ?
      `).get(deviceId.data, request.admin!.id) as Pick<StoredDevice, "device_id" | "user_id" | "key_id" | "status"> | undefined;
      if (!device) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "当前设备尚未注册" });
      return { deviceId: device.device_id, keyId: device.key_id, status: device.status };
    },
  );

  app.post(
    "/api/v1/desktop/devices/registration-challenges",
    { preHandler: requireAdmin, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = parseBody(registrationSchema, request.body, reply);
      if (!body) return;
      let key: { pem: string; fingerprint: string };
      try {
        key = publicKeyDetails(body.publicKey);
      } catch (error) {
        return reply.code(400).send({ error: "INVALID_DEVICE_KEY", message: error instanceof Error ? error.message : "设备公钥无效" });
      }

      const existing = await app.db.prepare(`
        SELECT device_id, user_id, public_key_pem, key_id, status FROM desktop_devices WHERE device_id = ?
      `).get(body.deviceId) as StoredDevice | undefined;
      if (existing && existing.user_id !== request.admin!.id) {
        return reply.code(409).send({ error: "DEVICE_ID_IN_USE", message: "设备 ID 已被使用" });
      }
      if (existing && existing.status === "revoked") {
        return reply.code(409).send({ error: "DEVICE_REVOKED", message: "当前设备已被撤销，请清除本机数据后重新注册" });
      }
      if (existing && (existing.key_id !== key.fingerprint || existing.public_key_pem !== key.pem)) {
        return reply.code(409).send({ error: "DEVICE_KEY_MISMATCH", message: "设备 ID 已绑定其他密钥" });
      }

      const challenge = randomBytes(32);
      const encryptedChallenge = publicEncrypt({ key: key.pem, oaepHash: "sha256" }, challenge);
      const id = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
      await app.db.prepare("DELETE FROM desktop_device_challenges WHERE expires_at < ?").run(now.toISOString());
      await app.db.prepare(`
        INSERT INTO desktop_device_challenges (
          id, user_id, device_id, public_key_pem, key_id, challenge_hash, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        request.admin!.id,
        body.deviceId,
        key.pem,
        key.fingerprint,
        createHash("sha256").update(challenge).digest("hex"),
        expiresAt.toISOString(),
        now.toISOString(),
      );
      return reply.code(201).send({
        challengeId: id,
        encryptedChallenge: base64url(encryptedChallenge),
        expiresAt: expiresAt.toISOString(),
        keyId: key.fingerprint,
      });
    },
  );

  app.post<{ Params: { challengeId: string } }>(
    "/api/v1/desktop/devices/registration-challenges/:challengeId/complete",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const challengeId = z.string().uuid().safeParse(request.params.challengeId);
      const body = parseBody(proofSchema, request.body, reply);
      if (!body) return;
      if (!challengeId.success) return reply.code(400).send({ error: "INVALID_CHALLENGE", message: "设备注册挑战无效" });
      const challenge = await app.db.prepare(`
        SELECT id, user_id, device_id, public_key_pem, key_id, challenge_hash, expires_at
        FROM desktop_device_challenges WHERE id = ? AND user_id = ?
      `).get(challengeId.data, request.admin!.id) as {
        id: string;
        user_id: string;
        device_id: string;
        public_key_pem: string;
        key_id: string;
        challenge_hash: string;
        expires_at: string;
      } | undefined;
      if (!challenge) return reply.code(404).send({ error: "CHALLENGE_NOT_FOUND", message: "设备注册挑战不存在或已使用" });
      await app.db.prepare("DELETE FROM desktop_device_challenges WHERE id = ?").run(challenge.id);
      if (new Date(challenge.expires_at).getTime() <= Date.now()) {
        return reply.code(410).send({ error: "CHALLENGE_EXPIRED", message: "设备注册挑战已过期" });
      }
      const expected = Buffer.from(challenge.challenge_hash, "hex");
      const actual = createHash("sha256").update(Buffer.from(body.proof, "base64url")).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return reply.code(403).send({ error: "INVALID_CHALLENGE_PROOF", message: "设备密钥持有证明无效" });
      }

      const existing = await app.db.prepare(`
        SELECT device_id, user_id, public_key_pem, key_id, status FROM desktop_devices WHERE device_id = ?
      `).get(challenge.device_id) as StoredDevice | undefined;
      if (existing && existing.user_id !== request.admin!.id) return reply.code(409).send({ error: "DEVICE_ID_IN_USE", message: "设备 ID 已被使用" });
      if (existing?.status === "revoked") return reply.code(409).send({ error: "DEVICE_REVOKED", message: "当前设备已被撤销" });
      if (existing && (existing.key_id !== challenge.key_id || existing.public_key_pem !== challenge.public_key_pem)) {
        return reply.code(409).send({ error: "DEVICE_KEY_MISMATCH", message: "设备 ID 已绑定其他密钥" });
      }
      const now = new Date().toISOString();
      if (existing) {
        await app.db.prepare("UPDATE desktop_devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ? AND user_id = ?")
          .run(now, now, challenge.device_id, request.admin!.id);
      } else {
        await app.db.prepare(`
          INSERT INTO desktop_devices (
            device_id, user_id, public_key_pem, key_id, status, created_at, updated_at, last_seen_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(challenge.device_id, request.admin!.id, challenge.public_key_pem, challenge.key_id, now, now, now);
      }
      await writeAudit(app.db, {
        action: "desktop_device.registered",
        resourceType: "desktop_device",
        resourceId: challenge.device_id,
        summary: "注册 macOS App 本机设备密钥",
        request,
        details: { keyId: challenge.key_id },
      });
      return { deviceId: challenge.device_id, keyId: challenge.key_id, status: "active" };
    },
  );

  app.post<{ Params: { credentialId: string } }>(
    "/api/v1/desktop/web-credentials/:credentialId/envelope",
    { preHandler: requireAdmin, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const credentialId = z.string().uuid().safeParse(request.params.credentialId);
      const body = parseBody(envelopeRequestSchema, request.body, reply);
      if (!body) return;
      if (!credentialId.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "凭据请求无效" });
      const device = await app.db.prepare(`
        SELECT device_id, user_id, public_key_pem, key_id, status FROM desktop_devices
        WHERE device_id = ? AND user_id = ?
      `).get(body.deviceId, request.admin!.id) as StoredDevice | undefined;
      if (!device) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "当前设备尚未注册" });
      if (device.status !== "active") return reply.code(403).send({ error: "DEVICE_REVOKED", message: "当前设备已被撤销" });
      if (!await canAccessWebCredential(app.db, request.admin!, credentialId.data)) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      }
      const credential = await app.db.prepare(`
        SELECT c.id, c.web_entry_id, c.username, c.password_ciphertext, c.custom_fields_json, c.updated_at,
          w.url AS entry_url
        FROM web_credentials c
        JOIN web_entries w ON w.id = c.web_entry_id
        WHERE c.id = ?
      `).get(credentialId.data) as {
        id: string;
        web_entry_id: string;
        username: string;
        password_ciphertext: string;
        custom_fields_json: string;
        updated_at: string;
        entry_url: string;
      } | undefined;
      if (!credential) return reply.code(404).send({ error: "NOT_FOUND", message: "登录账号不存在" });
      let targetOrigin: string;
      try {
        const target = new URL(credential.entry_url);
        if (!["http:", "https:"].includes(target.protocol)) throw new Error();
        targetOrigin = target.origin;
      } catch {
        return reply.code(400).send({ error: "UNSUPPORTED_WEB_URL", message: "Web 入口地址只支持 HTTP 或 HTTPS" });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 1000);
      await app.db.prepare("DELETE FROM desktop_credential_requests WHERE expires_at < ?").run(now.toISOString());
      try {
        await app.db.prepare(`
          INSERT INTO desktop_credential_requests (
            request_id, user_id, device_id, credential_id, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(body.requestId, request.admin!.id, body.deviceId, credential.id, expiresAt.toISOString(), now.toISOString());
      } catch (error) {
        if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "REQUEST_REPLAYED", message: "凭据请求已经使用" });
        throw error;
      }

      const protectedPayload = {
        version: 1,
        algorithm: "RSA-OAEP-256+A256GCM",
        keyId: device.key_id,
        deviceId: device.device_id,
        requestId: body.requestId,
        userId: request.admin!.id,
        workspaceType: request.admin!.workspace.type,
        workspaceId: request.admin!.workspace.id,
        credentialId: credential.id,
        endpoint: body.endpoint,
        targetOrigin,
        credentialUpdatedAt: credential.updated_at,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await app.db.prepare("UPDATE desktop_devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?")
        .run(now.toISOString(), now.toISOString(), device.device_id);
      await writeAudit(app.db, {
        action: "desktop_web_credential.issued",
        resourceType: "web_credential",
        resourceId: credential.id,
        summary: `向 macOS App 发放 Web 账号 ${credential.username} 的一次性凭据信封`,
        source: body.auditSource,
        request,
        details: { deviceId: device.device_id, requestId: body.requestId },
      });
      return encryptEnvelope(device, protectedPayload, credentialPayload(app, credential));
    },
  );

  app.post<{ Params: { connectionId: string } }>(
    "/api/v1/desktop/ssh-connections/:connectionId/envelope",
    { preHandler: requireAdmin, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const connectionId = z.string().uuid().safeParse(request.params.connectionId);
      const body = parseBody(envelopeRequestSchema, request.body, reply);
      if (!body) return;
      if (!connectionId.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "SSH 凭据请求无效" });
      const device = await app.db.prepare(`
        SELECT device_id, user_id, public_key_pem, key_id, status FROM desktop_devices
        WHERE device_id = ? AND user_id = ?
      `).get(body.deviceId, request.admin!.id) as StoredDevice | undefined;
      if (!device) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "当前设备尚未注册" });
      if (device.status !== "active") return reply.code(403).send({ error: "DEVICE_REVOKED", message: "当前设备已被撤销" });
      if (!await canAccessConnection(app.db, request.admin!, "ssh", connectionId.data)) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
      }
      const connection = await app.db.prepare(`
        SELECT id, workspace_type, workspace_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
          jump_connection_id, options_json, source_deleted, updated_at
        FROM ssh_connections WHERE id = ?
      `).get(connectionId.data) as SshEnvelopeRow | undefined;
      if (!connection || connection.source_deleted) return reply.code(404).send({ error: "NOT_FOUND", message: "SSH 连接不存在" });
      const jumpConnection = connection.jump_connection_id
        ? await app.db.prepare(`
            SELECT id, workspace_type, workspace_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
              jump_connection_id, options_json, source_deleted, updated_at
            FROM ssh_connections WHERE id = ?
          `).get(connection.jump_connection_id) as SshEnvelopeRow | undefined
        : undefined;
      if (connection.jump_connection_id && (!jumpConnection || jumpConnection.source_deleted)) {
        return reply.code(409).send({ error: "JUMP_CONNECTION_UNAVAILABLE", message: "跳板机连接不存在或已失效" });
      }
      if (jumpConnection && (jumpConnection.workspace_type !== connection.workspace_type || jumpConnection.workspace_id !== connection.workspace_id)) {
        return reply.code(409).send({ error: "JUMP_CONNECTION_INVALID", message: "跳板机不属于同一工作空间" });
      }
      if (jumpConnection?.jump_connection_id) return reply.code(409).send({ error: "JUMP_CONNECTION_INVALID", message: "只支持单级跳板机" });

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 1000);
      await app.db.prepare("DELETE FROM desktop_ssh_credential_requests WHERE expires_at < ?").run(now.toISOString());
      try {
        await app.db.prepare(`
          INSERT INTO desktop_ssh_credential_requests (
            request_id, user_id, device_id, connection_id, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(body.requestId, request.admin!.id, body.deviceId, connection.id, expiresAt.toISOString(), now.toISOString());
      } catch (error) {
        if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "REQUEST_REPLAYED", message: "凭据请求已经使用" });
        throw error;
      }
      const protectedPayload = {
        version: 1,
        algorithm: "RSA-OAEP-256+A256GCM",
        keyId: device.key_id,
        deviceId: device.device_id,
        requestId: body.requestId,
        userId: request.admin!.id,
        workspaceType: request.admin!.workspace.type,
        workspaceId: request.admin!.workspace.id,
        connectionId: connection.id,
        endpoint: body.endpoint,
        targetHost: connection.host,
        targetPort: Number(connection.port),
        connectionUpdatedAt: connection.updated_at,
        jumpConnectionId: jumpConnection?.id ?? null,
        jumpConnectionUpdatedAt: jumpConnection?.updated_at ?? null,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await app.db.prepare("UPDATE desktop_devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?")
        .run(now.toISOString(), now.toISOString(), device.device_id);
      await writeAudit(app.db, {
        action: "desktop_ssh_credential.issued",
        resourceType: "ssh_connection",
        resourceId: connection.id,
        summary: `向 macOS App 发放 SSH 连接 ${connection.name} 的一次性凭据信封`,
        source: body.auditSource,
        request,
        details: { deviceId: device.device_id, requestId: body.requestId, jumpConnectionId: jumpConnection?.id ?? null },
      });
      return encryptEnvelope(device, protectedPayload, {
        connection: await sshConnectionPayload(app, connection),
        jumpConnection: jumpConnection ? await sshConnectionPayload(app, jumpConnection) : null,
      });
    },
  );

  app.post<{ Params: { connectionId: string } }>(
    "/api/v1/desktop/database-connections/:connectionId/envelope",
    { preHandler: requireAdmin, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const connectionId = z.string().uuid().safeParse(request.params.connectionId);
      const body = parseBody(envelopeRequestSchema, request.body, reply);
      if (!body) return;
      if (!connectionId.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "数据库凭据请求无效" });
      const device = await app.db.prepare(`
        SELECT device_id, user_id, public_key_pem, key_id, status FROM desktop_devices
        WHERE device_id = ? AND user_id = ?
      `).get(body.deviceId, request.admin!.id) as StoredDevice | undefined;
      if (!device) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "当前设备尚未注册" });
      if (device.status !== "active") return reply.code(403).send({ error: "DEVICE_REVOKED", message: "当前设备已被撤销" });
      if (!await canAccessConnection(app.db, request.admin!, "database", connectionId.data)) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
      }
      const connection = await app.db.prepare(`
        SELECT id, workspace_type, workspace_id, name, engine, host, port, username, credential_ciphertext,
          default_database, connection_mode, options_json, source_deleted, updated_at
        FROM database_connections WHERE id = ?
      `).get(connectionId.data) as DatabaseEnvelopeRow | undefined;
      if (!connection || connection.source_deleted) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });

      const options = parseJson<{ sshConnectionId?: string | null; httpTunnelUrl?: string }>(connection.options_json, {});
      let sshConnection: SshEnvelopeRow | undefined;
      let jumpConnection: SshEnvelopeRow | undefined;
      if (connection.connection_mode === "sshTunnel") {
        if (!options.sshConnectionId) return reply.code(409).send({ error: "SSH_TUNNEL_UNAVAILABLE", message: "数据库连接没有配置 SSH Tunnel" });
        if (!await canAccessConnection(app.db, request.admin!, "ssh", options.sshConnectionId)) {
          return reply.code(404).send({ error: "NOT_FOUND", message: "SSH Tunnel 连接不存在" });
        }
        sshConnection = await app.db.prepare(`
          SELECT id, workspace_type, workspace_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
            jump_connection_id, options_json, source_deleted, updated_at
          FROM ssh_connections WHERE id = ?
        `).get(options.sshConnectionId) as SshEnvelopeRow | undefined;
        if (!sshConnection || sshConnection.source_deleted) {
          return reply.code(409).send({ error: "SSH_TUNNEL_UNAVAILABLE", message: "SSH Tunnel 连接不存在或已失效" });
        }
        if (sshConnection.workspace_type !== connection.workspace_type || sshConnection.workspace_id !== connection.workspace_id) {
          return reply.code(409).send({ error: "SSH_TUNNEL_INVALID", message: "SSH Tunnel 不属于同一工作空间" });
        }
        jumpConnection = sshConnection.jump_connection_id
          ? await app.db.prepare(`
              SELECT id, workspace_type, workspace_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
                jump_connection_id, options_json, source_deleted, updated_at
              FROM ssh_connections WHERE id = ?
            `).get(sshConnection.jump_connection_id) as SshEnvelopeRow | undefined
          : undefined;
        if (sshConnection.jump_connection_id && (!jumpConnection || jumpConnection.source_deleted)) {
          return reply.code(409).send({ error: "JUMP_CONNECTION_UNAVAILABLE", message: "跳板机连接不存在或已失效" });
        }
        if (jumpConnection && (jumpConnection.workspace_type !== connection.workspace_type || jumpConnection.workspace_id !== connection.workspace_id)) {
          return reply.code(409).send({ error: "JUMP_CONNECTION_INVALID", message: "跳板机不属于同一工作空间" });
        }
        if (jumpConnection?.jump_connection_id) return reply.code(409).send({ error: "JUMP_CONNECTION_INVALID", message: "只支持单级跳板机" });
      }

      let httpTunnelOrigin: string | null = null;
      if (connection.connection_mode === "httpTunnel") {
        try {
          const tunnelUrl = new URL(options.httpTunnelUrl ?? "");
          if (!["http:", "https:"].includes(tunnelUrl.protocol) || tunnelUrl.username || tunnelUrl.password) throw new Error();
          httpTunnelOrigin = tunnelUrl.origin;
        } catch {
          return reply.code(409).send({ error: "HTTP_TUNNEL_INVALID", message: "数据库 HTTP Tunnel 地址无效" });
        }
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 1000);
      await app.db.prepare("DELETE FROM desktop_database_credential_requests WHERE expires_at < ?").run(now.toISOString());
      try {
        await app.db.prepare(`
          INSERT INTO desktop_database_credential_requests (
            request_id, user_id, device_id, connection_id, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(body.requestId, request.admin!.id, body.deviceId, connection.id, expiresAt.toISOString(), now.toISOString());
      } catch (error) {
        if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "REQUEST_REPLAYED", message: "凭据请求已经使用" });
        throw error;
      }

      const protectedPayload = {
        version: 1,
        algorithm: "RSA-OAEP-256+A256GCM",
        keyId: device.key_id,
        deviceId: device.device_id,
        requestId: body.requestId,
        userId: request.admin!.id,
        workspaceType: request.admin!.workspace.type,
        workspaceId: request.admin!.workspace.id,
        connectionId: connection.id,
        endpoint: body.endpoint,
        targetHost: connection.host,
        targetPort: Number(connection.port),
        connectionUpdatedAt: connection.updated_at,
        connectionMode: connection.connection_mode,
        httpTunnelOrigin,
        sshConnectionId: sshConnection?.id ?? null,
        sshConnectionUpdatedAt: sshConnection?.updated_at ?? null,
        jumpConnectionId: jumpConnection?.id ?? null,
        jumpConnectionUpdatedAt: jumpConnection?.updated_at ?? null,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await app.db.prepare("UPDATE desktop_devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?")
        .run(now.toISOString(), now.toISOString(), device.device_id);
      await writeAudit(app.db, {
        action: "desktop_database_credential.issued",
        resourceType: "database_connection",
        resourceId: connection.id,
        summary: `向 macOS App 发放数据库连接 ${connection.name} 的一次性凭据信封`,
        source: body.auditSource,
        request,
        details: {
          deviceId: device.device_id,
          requestId: body.requestId,
          connectionMode: connection.connection_mode,
          sshConnectionId: sshConnection?.id ?? null,
          jumpConnectionId: jumpConnection?.id ?? null,
        },
      });
      return encryptEnvelope(device, protectedPayload, {
        connection: databaseConnectionPayload(app, connection),
        sshCredential: sshConnection ? {
          connection: await sshConnectionPayload(app, sshConnection),
          jumpConnection: jumpConnection ? await sshConnectionPayload(app, jumpConnection) : null,
        } : null,
      });
    },
  );

  app.post(
    "/api/v1/desktop/redis-connections/:connectionId/envelope",
    { preHandler: requireAdmin, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const rawConnectionId = (request.params as { connectionId?: string }).connectionId;
      const connectionId = z.string().uuid().safeParse(rawConnectionId);
      const body = parseBody(envelopeRequestSchema, request.body, reply);
      if (!body) return;
      if (!connectionId.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Redis 凭据请求无效" });
      const device = await app.db.prepare(`
        SELECT device_id, user_id, public_key_pem, key_id, status FROM desktop_devices
        WHERE device_id = ? AND user_id = ?
      `).get(body.deviceId, request.admin!.id) as StoredDevice | undefined;
      if (!device) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "当前设备尚未注册" });
      if (device.status !== "active") return reply.code(403).send({ error: "DEVICE_REVOKED", message: "当前设备已被撤销" });
      if (!await canAccessConnection(app.db, request.admin!, "redis", connectionId.data)) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "Redis 连接不存在" });
      }
      const connection = await app.db.prepare(`
        SELECT id, workspace_type, workspace_id, name, host, port, username, credential_ciphertext,
          default_database, connection_mode, options_json, source_deleted, updated_at
        FROM redis_connections WHERE id = ?
      `).get(connectionId.data) as RedisEnvelopeRow | undefined;
      if (!connection || connection.source_deleted) return reply.code(404).send({ error: "NOT_FOUND", message: "Redis 连接不存在" });

      const options = parseJson<{ sshConnectionId?: string | null }>(connection.options_json, {});
      let sshConnection: SshEnvelopeRow | undefined;
      let jumpConnection: SshEnvelopeRow | undefined;
      if (connection.connection_mode === "sshTunnel") {
        if (!options.sshConnectionId) return reply.code(409).send({ error: "SSH_TUNNEL_UNAVAILABLE", message: "Redis 连接没有配置 SSH Tunnel" });
        if (!await canAccessConnection(app.db, request.admin!, "ssh", options.sshConnectionId)) {
          return reply.code(404).send({ error: "NOT_FOUND", message: "SSH Tunnel 连接不存在" });
        }
        sshConnection = await app.db.prepare(`
          SELECT id, workspace_type, workspace_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
            jump_connection_id, options_json, source_deleted, updated_at
          FROM ssh_connections WHERE id = ?
        `).get(options.sshConnectionId) as SshEnvelopeRow | undefined;
        if (!sshConnection || sshConnection.source_deleted) {
          return reply.code(409).send({ error: "SSH_TUNNEL_UNAVAILABLE", message: "SSH Tunnel 连接不存在或已失效" });
        }
        if (sshConnection.workspace_type !== connection.workspace_type || sshConnection.workspace_id !== connection.workspace_id) {
          return reply.code(409).send({ error: "SSH_TUNNEL_INVALID", message: "SSH Tunnel 不属于同一工作空间" });
        }
        jumpConnection = sshConnection.jump_connection_id
          ? await app.db.prepare(`
              SELECT id, workspace_type, workspace_id, name, host, port, username, auth_type, ssh_key_id, credential_ciphertext,
                jump_connection_id, options_json, source_deleted, updated_at
              FROM ssh_connections WHERE id = ?
            `).get(sshConnection.jump_connection_id) as SshEnvelopeRow | undefined
          : undefined;
        if (sshConnection.jump_connection_id && (!jumpConnection || jumpConnection.source_deleted)) {
          return reply.code(409).send({ error: "JUMP_CONNECTION_UNAVAILABLE", message: "跳板机连接不存在或已失效" });
        }
        if (jumpConnection && (jumpConnection.workspace_type !== connection.workspace_type || jumpConnection.workspace_id !== connection.workspace_id)) {
          return reply.code(409).send({ error: "JUMP_CONNECTION_INVALID", message: "跳板机不属于同一工作空间" });
        }
        if (jumpConnection?.jump_connection_id) return reply.code(409).send({ error: "JUMP_CONNECTION_INVALID", message: "只支持单级跳板机" });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 1000);
      await app.db.prepare("DELETE FROM desktop_redis_credential_requests WHERE expires_at < ?").run(now.toISOString());
      try {
        await app.db.prepare(`
          INSERT INTO desktop_redis_credential_requests (
            request_id, user_id, device_id, connection_id, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(body.requestId, request.admin!.id, body.deviceId, connection.id, expiresAt.toISOString(), now.toISOString());
      } catch (error) {
        if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "REQUEST_REPLAYED", message: "凭据请求已经使用" });
        throw error;
      }
      const protectedPayload = {
        version: 1,
        algorithm: "RSA-OAEP-256+A256GCM",
        keyId: device.key_id,
        deviceId: device.device_id,
        requestId: body.requestId,
        userId: request.admin!.id,
        workspaceType: request.admin!.workspace.type,
        workspaceId: request.admin!.workspace.id,
        connectionId: connection.id,
        endpoint: body.endpoint,
        targetHost: connection.host,
        targetPort: Number(connection.port),
        connectionUpdatedAt: connection.updated_at,
        connectionMode: connection.connection_mode,
        sshConnectionId: sshConnection?.id ?? null,
        sshConnectionUpdatedAt: sshConnection?.updated_at ?? null,
        jumpConnectionId: jumpConnection?.id ?? null,
        jumpConnectionUpdatedAt: jumpConnection?.updated_at ?? null,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await app.db.prepare("UPDATE desktop_devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?")
        .run(now.toISOString(), now.toISOString(), device.device_id);
      await writeAudit(app.db, {
        action: "desktop_redis_credential.issued",
        resourceType: "redis_connection",
        resourceId: connection.id,
        summary: `向桌面 App 发放 Redis 连接 ${connection.name} 的一次性凭据信封`,
        source: body.auditSource,
        request,
        details: {
          deviceId: device.device_id,
          requestId: body.requestId,
          connectionMode: connection.connection_mode,
          sshConnectionId: sshConnection?.id ?? null,
          jumpConnectionId: jumpConnection?.id ?? null,
        },
      });
      return encryptEnvelope(device, protectedPayload, {
        connection: redisConnectionPayload(app, connection),
        sshCredential: sshConnection ? {
          connection: await sshConnectionPayload(app, sshConnection),
          jumpConnection: jumpConnection ? await sshConnectionPayload(app, jumpConnection) : null,
        } : null,
      });
    },
  );

  app.post(
    "/api/v1/desktop/ssh-executions",
    { preHandler: requireAdmin, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.admin) return;
      const admin = request.admin;
      try {
        const accepted = await acceptDesktopReport(app, admin, request.body, sshExecutionReportSchema, async ({ payload, deviceId }) => {
          if (!await canAccessConnection(app.db, admin, "ssh", payload.connectionId)) {
            throw new DesktopReportError(404, "NOT_FOUND", "SSH 连接不存在");
          }
          await writeAudit(app.db, {
            action: `ssh.${payload.action}`,
            resourceType: "ssh_connection",
            resourceId: payload.connectionId,
            summary: payload.summary,
            source: payload.auditSource,
            details: { ...payload.details, operationId: payload.operationId, executionMode: "desktop-local", deviceId },
            request,
          });
        });
        return { accepted: true, duplicate: accepted.duplicate };
      } catch (error) {
        if (error instanceof DesktopReportError) return reply.code(error.status).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/desktop/database-executions",
    { preHandler: requireAdmin, bodyLimit: 5 * 1024 * 1024, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.admin) return;
      const admin = request.admin;
      try {
        const accepted = await acceptDesktopReport(app, admin, request.body, databaseExecutionReportSchema, async ({ payload: body, deviceId }) => {
          if (!await canAccessConnection(app.db, admin, "database", body.connectionId)) {
            throw new DesktopReportError(404, "NOT_FOUND", "数据库连接不存在");
          }
          if (body.kind === "query") {
            const existing = await app.db.prepare("SELECT id FROM database_query_history WHERE id = ?").get(body.operationId) as { id: string } | undefined;
            if (existing) throw new DesktopReportError(409, "DATABASE_QUERY_ID_IN_USE", "数据库查询标识已被使用");
            const completedAt = new Date().toISOString();
            await app.db.prepare(`
              INSERT INTO database_query_history (
                id, owner_user_id, connection_id, database_name, sql_text, status, duration_ms,
                row_count, error_message, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              body.operationId,
              admin.id,
              body.connectionId,
              body.database,
              body.sql,
              body.status,
              body.durationMs,
              body.rowCount,
              body.error,
              completedAt,
            );
            await writeAudit(app.db, {
              action: body.status === "success" ? "database.query_executed" : "database.query_failed",
              resourceType: "database_connection",
              resourceId: body.connectionId,
              summary: `${body.status === "success" ? "执行" : "未完成"}本机 SQL`,
              source: body.auditSource,
              details: {
                queryId: body.operationId,
                status: body.status,
                durationMs: body.durationMs,
                rowCount: body.rowCount,
                executionMode: "desktop-local",
                deviceId,
              },
              request,
            });
          } else {
            await writeAudit(app.db, {
              action: `database.${body.action}`,
              resourceType: "database_connection",
              resourceId: body.connectionId,
              summary: body.summary,
              source: body.auditSource,
              details: { ...body.details, operationId: body.operationId, executionMode: "desktop-local", deviceId },
              request,
            });
          }
        });
        return { accepted: true, duplicate: accepted.duplicate };
      } catch (error) {
        if (error instanceof DesktopReportError) {
          return reply.code(error.status).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/desktop/redis-executions",
    { preHandler: requireAdmin, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.admin) return;
      const admin = request.admin;
      try {
        const accepted = await acceptDesktopReport(app, admin, request.body, redisExecutionReportSchema, async ({ payload, deviceId }) => {
          if (!await canAccessConnection(app.db, admin, "redis", payload.connectionId)) {
            throw new DesktopReportError(404, "NOT_FOUND", "Redis 连接不存在");
          }
          await writeAudit(app.db, {
            action: `redis.${payload.action}`,
            resourceType: "redis_connection",
            resourceId: payload.connectionId,
            summary: payload.summary,
            source: payload.auditSource,
            details: { ...payload.details, operationId: payload.operationId, executionMode: "desktop-local", deviceId },
            request,
          });
        });
        return { accepted: true, duplicate: accepted.duplicate };
      } catch (error) {
        if (error instanceof DesktopReportError) return reply.code(error.status).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/desktop/connection-inspections",
    { preHandler: requireAdmin, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.admin) return;
      if (!canManageWorkspace(request)) {
        return reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "当前工作空间只有管理员可以执行连接巡检" });
      }
      const admin = request.admin;
      try {
        const accepted = await acceptDesktopReport(app, admin, request.body, connectionInspectionReportSchema, async ({ payload, deviceId }) => {
          const saveResult = app.db.prepare(`
            INSERT INTO connection_inspection_results (
              connection_type, connection_id, status, latency_ms, message, checked_by_user_id, checked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(connection_type, connection_id) DO UPDATE SET
              status = excluded.status,
              latency_ms = excluded.latency_ms,
              message = excluded.message,
              checked_by_user_id = excluded.checked_by_user_id,
              checked_at = excluded.checked_at
          `);
          const checkedAt = new Date().toISOString();
          for (const item of payload.items) {
            const table = item.type === "ssh" ? "ssh_connections" : item.type === "database" ? "database_connections" : "redis_connections";
            const connection = await app.db.prepare(`
              SELECT id FROM ${table} WHERE id = ? AND workspace_type = ? AND workspace_id = ?
            `).get(item.id, admin.workspace.type, admin.workspace.id);
            if (!connection) continue;
            await saveResult.run(item.type, item.id, item.status, item.latencyMs, item.message, admin.id, checkedAt);
          }
          const available = payload.items.filter((item) => item.status === "available").length;
          await writeAudit(app.db, {
            action: "connection.inspected",
            resourceType: "connection",
            summary: `本机巡检 ${payload.items.length} 个连接：可用 ${available}，不可用 ${payload.items.length - available}`,
            source: payload.auditSource,
            details: {
              operationId: payload.operationId,
              executionMode: "desktop-local",
              deviceId,
              items: payload.items.map((item) => ({ type: item.type, id: item.id, status: item.status, latencyMs: item.latencyMs })),
            },
            request,
          });
        });
        return { accepted: true, duplicate: accepted.duplicate };
      } catch (error) {
        if (error instanceof DesktopReportError) {
          return reply.code(error.status).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
}
