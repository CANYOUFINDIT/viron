import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WorkspaceType } from "../access-control.js";
import {
  VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH,
  VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH,
  type McpApiRequest,
  type McpApiResponse,
  type VironMcpOperationPublic,
  type VironMcpOperationStatus,
} from "../../shared/mcp-protocol.js";

export type McpCredentialKind =
  | "ssh"
  | "database"
  | "databaseProfile"
  | "redis"
  | "web"
  | "sshKeyImport"
  | "sshKeyGenerate"
  | "connectionSource"
  | "connectionImport";

export interface McpCredentialOperation {
  kind: McpCredentialKind;
  mode: "create" | "update";
}

export interface McpOperationRecord {
  id: string;
  ownerUserId: string;
  apiKeyId: string | null;
  workspaceType: WorkspaceType;
  workspaceId: string;
  action: string;
  kind: "credential" | "confirmation";
  status: VironMcpOperationStatus;
  title: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  purpose: string | null;
  actionUrl: string;
  executionTarget: "server" | "desktop";
  executionScope: string | null;
  request: McpApiRequest;
  credential: McpCredentialOperation | null;
  desktopLeaseHash: string | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  result: McpApiResponse | null;
}

export interface CreateMcpOperationInput {
  ownerUserId: string;
  apiKeyId?: string | null;
  workspaceType: WorkspaceType;
  workspaceId: string;
  action: string;
  kind: "credential" | "confirmation";
  title: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  actionUrl: (operationId: string) => string;
  executionTarget: "server" | "desktop";
  executionScope: string | null;
  request: McpApiRequest;
  credential?: McpCredentialOperation | null;
  awaitingPurpose?: boolean;
}

const OPERATION_TTL_MS = 10 * 60_000;
const TERMINAL_RETENTION_MS = 60 * 60_000;

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeResult(response: McpApiResponse): McpApiResponse {
  const contentType = response.headers["content-type"];
  return {
    status: response.status,
    headers: contentType ? { "content-type": contentType } : {},
    data: response.data,
  };
}

export class McpOperationStore {
  private readonly operations = new Map<string, McpOperationRecord>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
    this.cleanupTimer.unref();
  }

  create(input: CreateMcpOperationInput): { operation: McpOperationRecord; desktopLease: string | null } {
    const id = randomUUID();
    const now = new Date();
    const desktopLease = input.kind === "confirmation" && input.executionTarget === "desktop"
      ? randomBytes(32).toString("base64url")
      : null;
    const operation: McpOperationRecord = {
      id,
      ownerUserId: input.ownerUserId,
      apiKeyId: input.apiKeyId ?? null,
      workspaceType: input.workspaceType,
      workspaceId: input.workspaceId,
      action: input.action,
      kind: input.kind,
      status: input.awaitingPurpose ? "awaiting_purpose" : "pending",
      title: input.title,
      summary: input.summary,
      riskLevel: input.riskLevel,
      purpose: null,
      actionUrl: input.actionUrl(id),
      executionTarget: input.executionTarget,
      executionScope: input.executionScope,
      request: input.request,
      credential: input.credential ?? null,
      desktopLeaseHash: desktopLease ? tokenHash(desktopLease) : null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + OPERATION_TTL_MS).toISOString(),
      approvedAt: null,
      completedAt: null,
      result: null,
    };
    this.operations.set(id, operation);
    return { operation, desktopLease };
  }

  get(id: string): McpOperationRecord | null {
    const operation = this.operations.get(id);
    if (!operation) return null;
    this.expire(operation);
    return operation;
  }

  public(operation: McpOperationRecord): VironMcpOperationPublic {
    this.expire(operation);
    return {
      operationId: operation.id,
      action: operation.action,
      kind: operation.kind,
      status: operation.status,
      title: operation.title,
      summary: operation.summary,
      riskLevel: operation.riskLevel,
      purpose: operation.purpose,
      actionUrl: operation.status === "awaiting_purpose" ? null : operation.actionUrl,
      expiresAt: operation.expiresAt,
      ...(operation.status === "awaiting_purpose" ? {
        nextAction: {
          tool: "viron_operation_purpose_provide" as const,
          arguments: {
            operationId: operation.id,
            workspace: operation.workspaceType === "personal" ? "personal" : `organization:${operation.workspaceId}`,
          },
          instruction: "请用一句话说明这次操作的业务目标和执行原因，不要重复命令；提交后 Viron 才会向用户展示审批页面。",
          purposeMinLength: VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH,
          purposeMaxLength: VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH,
        },
      } : {}),
      ...(operation.result ? { result: operation.result } : {}),
    };
  }

  providePurpose(operation: McpOperationRecord, purpose: string): void {
    this.expire(operation);
    if (operation.kind !== "confirmation" || operation.status !== "awaiting_purpose") {
      throw new Error("Operation 当前不需要补充执行意图");
    }
    operation.purpose = purpose;
    operation.status = "pending";
  }

  approveDesktop(operation: McpOperationRecord): void {
    this.assertPending(operation);
    operation.status = "approved";
    operation.approvedAt = new Date().toISOString();
  }

  startServer(operation: McpOperationRecord): void {
    this.assertPending(operation);
    operation.status = "running";
    operation.approvedAt = new Date().toISOString();
  }

  startDesktop(operation: McpOperationRecord, lease: string): void {
    this.expire(operation);
    if (operation.status !== "approved" || !operation.desktopLeaseHash || tokenHash(lease) !== operation.desktopLeaseHash) {
      throw new Error("本机 Operation 执行租约无效或状态已变化");
    }
    operation.status = "running";
  }

  complete(operation: McpOperationRecord, response: McpApiResponse): void {
    if (operation.status !== "running") throw new Error("Operation 当前不能完成");
    operation.status = response.status >= 400 ? "failed" : "completed";
    operation.result = safeResult(response);
    operation.completedAt = new Date().toISOString();
    operation.desktopLeaseHash = null;
  }

  fail(operation: McpOperationRecord, status: number, code: string, message: string): void {
    if (!["awaiting_purpose", "pending", "approved", "running"].includes(operation.status)) throw new Error("Operation 当前不能标记失败");
    operation.status = "failed";
    operation.result = safeResult({ status, headers: { "content-type": "application/json; charset=utf-8" }, data: { error: code, message } });
    operation.completedAt = new Date().toISOString();
    operation.desktopLeaseHash = null;
  }

  cancel(operation: McpOperationRecord): boolean {
    this.expire(operation);
    if (!["awaiting_purpose", "pending", "approved"].includes(operation.status)) return false;
    operation.status = "cancelled";
    operation.completedAt = new Date().toISOString();
    operation.desktopLeaseHash = null;
    return true;
  }

  cancelScope(ownerUserId: string, executionScope: string): void {
    for (const operation of this.operations.values()) {
      if (operation.ownerUserId === ownerUserId && operation.executionScope === executionScope) this.cancel(operation);
    }
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    this.operations.clear();
  }

  private assertPending(operation: McpOperationRecord): void {
    this.expire(operation);
    if (operation.status !== "pending") throw new Error("Operation 已处理、已取消或已过期");
  }

  private expire(operation: McpOperationRecord): void {
    if (["awaiting_purpose", "pending", "approved"].includes(operation.status) && new Date(operation.expiresAt).getTime() <= Date.now()) {
      operation.status = "expired";
      operation.completedAt = new Date().toISOString();
      operation.desktopLeaseHash = null;
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (const [id, operation] of this.operations) {
      this.expire(operation);
      const terminalAt = operation.completedAt ? new Date(operation.completedAt).getTime() : 0;
      if (terminalAt && terminalAt < cutoff) this.operations.delete(id);
    }
  }
}
