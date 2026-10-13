import type { FastifyRequest } from "fastify";
import { sshCredentialPurposePayloadSchema, type SshCredentialPurposePayload } from "../shared/ssh-credential-purpose.js";
import type { ResourceRef } from "../shared/organization-rbac.js";
import { acceptDesktopReport, DesktopReportError } from "./desktop-report.js";
import { executionDecision, type ExecutionChannel } from "./organization-boundary.js";

const SSH_TRANSPORT_CODES = new Set(["ssh.use", "ssh.browse", "ssh.download", "ssh.upload", "ssh.delete"]);

export interface SshEnvelopePurposeDenial {
  allowed: false;
  status: number;
  error: string;
  message: string;
  channel: ExecutionChannel;
  code: string;
  target?: ResourceRef;
}

export type SshEnvelopePurposeResult =
  | { allowed: true; payload: SshCredentialPurposePayload }
  | SshEnvelopePurposeDenial;

function denied(status: number, error: string, message: string, channel: ExecutionChannel, code = "", target?: ResourceRef): SshEnvelopePurposeDenial {
  return { allowed: false, status, error, message, channel, code, target };
}

/** Verifies the device signature, then the current role operation, data scope, and feature window. */
export async function authorizeSignedSshCredentialPurpose(request: FastifyRequest, connectionId: string): Promise<SshEnvelopePurposeResult> {
  const admin = request.admin;
  const access = admin?.organizationAccess;
  const purpose = (request.body as { purpose?: unknown } | undefined)?.purpose;
  if (!admin || !access) return denied(403, "ACTION_FORBIDDEN", "没有这项操作权限", "mcp");
  try {
    const accepted = await acceptDesktopReport(request.server, admin, purpose, sshCredentialPurposePayloadSchema, async () => {});
    if (accepted.duplicate) return denied(409, "DESKTOP_REPORT_REPLAYED", "桌面执行报告操作标识已被使用", "mcp");
    const payload = accepted.payload;
    const channel: ExecutionChannel = payload.channel;
    if (payload.connectionId.toLowerCase() !== connectionId.toLowerCase()) {
      return denied(403, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", channel);
    }
    if (payload.code === "logs.view") {
      if (payload.targetType !== "environment_log") return denied(403, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", channel, payload.code);
      const linked = await request.server.db.prepare(`
        SELECT l.id FROM environment_logs l
        JOIN environments e ON e.id = l.environment_id
        WHERE l.id = ? AND l.ssh_connection_id = ? AND e.workspace_type = ? AND e.workspace_id = ?
      `).get(payload.targetId, connectionId, admin.workspace.type, admin.workspace.id) as { id: string } | undefined;
      const target: ResourceRef = { type: "environment_log", id: payload.targetId };
      if (!linked) return denied(403, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", channel, "logs.view", target);
      const decision = executionDecision(access, channel, "logs.view", target);
      if (!decision.allowed) return denied(403, decision.error ?? "FEATURE_FORBIDDEN", decision.message, channel, "logs.view", target);
      return { allowed: true, payload };
    }
    const target: ResourceRef = { type: "ssh_connection", id: connectionId };
    if (!SSH_TRANSPORT_CODES.has(payload.code) || payload.targetType !== "ssh_connection" || payload.targetId.toLowerCase() !== connectionId.toLowerCase()) {
      return denied(403, "ACTION_FORBIDDEN", "角色未获得这项资源操作权限", channel, payload.code, target);
    }
    const decision = executionDecision(access, channel, payload.code, target);
    if (!decision.allowed) return denied(403, decision.error ?? "FEATURE_FORBIDDEN", decision.message, channel, payload.code, target);
    return { allowed: true, payload };
  } catch (error) {
    if (error instanceof DesktopReportError) return denied(error.status, error.code, error.message, "mcp");
    throw error;
  }
}
