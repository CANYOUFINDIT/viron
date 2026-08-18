import { constants, createHash, verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "./access-control.js";
import { isUniqueConstraintError } from "./database-errors.js";

const signedReportSchema = z.object({
  protected: z.string().min(1).max(4 * 1024 * 1024),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(2_048),
});

const reportClaimsSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("RSA-PSS-SHA256"),
  keyId: z.string().regex(/^[0-9a-f]{64}$/),
  deviceId: z.string().uuid(),
  operationId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceType: z.enum(["personal", "organization"]),
  workspaceId: z.string().uuid(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  payload: z.unknown(),
});

export class DesktopReportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VerifiedDesktopReport<T> {
  operationId: string;
  deviceId: string;
  payload: T;
}

export interface AcceptedDesktopReport<T> extends VerifiedDesktopReport<T> {
  duplicate: boolean;
}

interface ParsedDesktopReport<T> extends VerifiedDesktopReport<T> {
  protectedBytes: Buffer;
  signature: Buffer;
  keyId: string;
  payloadHash: string;
}

function parseDesktopReport<T>(
  user: AuthenticatedUser,
  input: unknown,
  payloadSchema: z.ZodType<T>,
): ParsedDesktopReport<T> {
  const signed = signedReportSchema.safeParse(input);
  if (!signed.success) throw new DesktopReportError(400, "INVALID_DESKTOP_REPORT", "桌面执行报告格式无效");
  let protectedBytes: Buffer;
  let claims: z.infer<typeof reportClaimsSchema>;
  try {
    protectedBytes = Buffer.from(signed.data.protected, "base64url");
    claims = reportClaimsSchema.parse(JSON.parse(protectedBytes.toString("utf8")));
  } catch {
    throw new DesktopReportError(400, "INVALID_DESKTOP_REPORT", "桌面执行报告内容无效");
  }
  if (
    claims.userId !== user.id
    || claims.workspaceType !== user.workspace.type
    || claims.workspaceId !== user.workspace.id
  ) {
    throw new DesktopReportError(403, "DESKTOP_REPORT_CONTEXT_MISMATCH", "桌面执行报告用户或工作空间不匹配");
  }
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  const now = Date.now();
  if (issuedAt > now + 30_000 || expiresAt <= now || expiresAt - issuedAt > 60_000) {
    throw new DesktopReportError(410, "DESKTOP_REPORT_EXPIRED", "桌面执行报告已过期或尚未生效");
  }
  const payload = payloadSchema.safeParse(claims.payload);
  if (!payload.success) throw new DesktopReportError(400, "INVALID_DESKTOP_REPORT_PAYLOAD", "桌面执行报告负载无效");
  const payloadOperationId = (payload.data as { operationId?: unknown }).operationId;
  if (payloadOperationId !== claims.operationId) {
    throw new DesktopReportError(400, "DESKTOP_REPORT_OPERATION_MISMATCH", "桌面执行报告操作标识不匹配");
  }
  const stableClaims = {
    version: claims.version,
    algorithm: claims.algorithm,
    keyId: claims.keyId,
    deviceId: claims.deviceId,
    operationId: claims.operationId,
    userId: claims.userId,
    workspaceType: claims.workspaceType,
    workspaceId: claims.workspaceId,
    payload: payload.data,
  };
  return {
    operationId: claims.operationId,
    deviceId: claims.deviceId,
    payload: payload.data,
    protectedBytes,
    signature: Buffer.from(signed.data.signature, "base64url"),
    keyId: claims.keyId,
    payloadHash: createHash("sha256").update(JSON.stringify(stableClaims)).digest("hex"),
  };
}

async function matchingReport(
  app: FastifyInstance,
  report: ParsedDesktopReport<unknown>,
  user: AuthenticatedUser,
): Promise<boolean> {
  const existing = await app.db.prepare(`
    SELECT user_id, device_id, payload_hash FROM desktop_operation_reports WHERE operation_id = ?
  `).get(report.operationId) as { user_id: string; device_id: string; payload_hash: string } | undefined;
  if (!existing) return false;
  if (existing.user_id === user.id && existing.device_id === report.deviceId && existing.payload_hash === report.payloadHash) return true;
  throw new DesktopReportError(409, "DESKTOP_REPORT_REPLAYED", "桌面执行报告操作标识已被使用");
}

export async function acceptDesktopReport<T>(
  app: FastifyInstance,
  user: AuthenticatedUser,
  input: unknown,
  payloadSchema: z.ZodType<T>,
  handler: (report: VerifiedDesktopReport<T>) => Promise<void>,
): Promise<AcceptedDesktopReport<T>> {
  const report = parseDesktopReport(user, input, payloadSchema);
  const accept = app.db.transaction(async () => {
    const acceptedAt = new Date();
    await app.db.prepare("DELETE FROM desktop_operation_reports WHERE expires_at < ?").run(acceptedAt.toISOString());
    const device = await app.db.prepare(`
      SELECT public_key_pem, key_id, status FROM desktop_devices
      WHERE device_id = ? AND user_id = ?
    `).get(report.deviceId, user.id) as { public_key_pem: string; key_id: string; status: "active" | "revoked" } | undefined;
    if (!device) throw new DesktopReportError(404, "DEVICE_NOT_FOUND", "当前设备尚未注册");
    if (device.status !== "active") throw new DesktopReportError(403, "DEVICE_REVOKED", "当前设备已被撤销");
    if (device.key_id !== report.keyId) throw new DesktopReportError(403, "DEVICE_KEY_MISMATCH", "桌面执行报告设备密钥不匹配");
    const valid = verify("sha256", report.protectedBytes, {
      key: device.public_key_pem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, report.signature);
    if (!valid) throw new DesktopReportError(403, "INVALID_DESKTOP_REPORT_SIGNATURE", "桌面执行报告签名无效");
    if (await matchingReport(app, report, user)) return true;
    await handler(report);
    await app.db.prepare(`
      INSERT INTO desktop_operation_reports (
        operation_id, user_id, device_id, payload_hash, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      report.operationId,
      user.id,
      report.deviceId,
      report.payloadHash,
      new Date(acceptedAt.getTime() + app.config.auditRetentionDays * 24 * 60 * 60 * 1000).toISOString(),
      acceptedAt.toISOString(),
    );
    return false;
  });
  try {
    const duplicate = await accept();
    return { operationId: report.operationId, deviceId: report.deviceId, payload: report.payload, duplicate };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    if (await matchingReport(app, report, user)) {
      return { operationId: report.operationId, deviceId: report.deviceId, payload: report.payload, duplicate: true };
    }
    throw error;
  }
}
