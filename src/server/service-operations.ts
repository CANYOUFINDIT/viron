import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUniqueConstraintError } from "./database-errors.js";
import { canAccessEnvironment, workspaceParams } from "./access-control.js";
import { writeAudit } from "./audit.js";
import {
  SERVICE_OPERATION_BATCH_LIMIT,
  SERVICE_OPERATION_COMMAND_TIMEOUT_MS,
  SERVICE_OPERATION_CONCURRENCY,
  SERVICE_OPERATION_LOCK_TTL_MS,
  SERVICE_OPERATION_OUTPUT_LIMIT,
  SERVICE_OPERATION_RESULT_LIMIT,
  SERVICE_OPERATION_RETENTION_DAYS,
  SERVICE_OPERATION_TOTAL_TIMEOUT_MS,
  clipUtf8,
  utf8ByteLength,
  type ServiceOperationDto,
  type ServiceOperationStatus,
  type ServiceOperationTargetResult,
  type ServiceOperationType,
} from "../shared/service-operations.js";

export class ServiceOperationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly operationId?: string;

  constructor(code: string, message: string, statusCode = 400, operationId?: string) {
    super(message);
    this.name = "ServiceOperationError";
    this.code = code;
    this.statusCode = statusCode;
    this.operationId = operationId;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function canonicalRequestHash(body: unknown): string {
  return createHash("sha256").update(stableStringify(body ?? {})).digest("hex");
}

export function readIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length < 16 || value.length > 128) {
    throw new ServiceOperationError("INVALID_IDEMPOTENCY_KEY", "危险操作必须提供 16 到 128 字符的 Idempotency-Key", 400);
  }
  return value;
}

function emptyResult(): ServiceOperationDto["result"] {
  return { succeeded: 0, failed: 0, truncated: false, targets: [] };
}

function mapOperationRow(row: Record<string, unknown>): ServiceOperationDto {
  let progress = { current: 0, total: 0 };
  let result = emptyResult();
  try { progress = JSON.parse(String(row.progress_json || "{}")); } catch { /* keep default */ }
  try { result = JSON.parse(String(row.result_json || "{}")); } catch { /* keep default */ }
  return {
    id: String(row.id),
    environmentId: String(row.environment_id),
    operationType: String(row.operation_type) as ServiceOperationType,
    resourceId: String(row.resource_id),
    status: String(row.status) as ServiceOperationStatus,
    progress: { current: Number(progress.current) || 0, total: Number(progress.total) || 0 },
    result: {
      succeeded: Number(result.succeeded) || 0,
      failed: Number(result.failed) || 0,
      truncated: Boolean(result.truncated),
      targets: Array.isArray(result.targets) ? result.targets : [],
    },
    errorCode: String(row.error_code ?? ""),
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    updatedAt: String(row.updated_at),
  };
}

async function loadOperation(app: FastifyInstance, id: string): Promise<ServiceOperationDto | null> {
  const row = await app.db.prepare("SELECT * FROM service_operation_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapOperationRow(row) : null;
}

export async function getServiceOperation(
  app: FastifyInstance,
  request: FastifyRequest,
  operationId: string,
): Promise<ServiceOperationDto> {
  const [workspaceType, workspaceId] = workspaceParams(request);
  const row = await app.db.prepare(`
    SELECT * FROM service_operation_runs WHERE id = ? AND workspace_type = ? AND workspace_id = ?
  `).get(operationId, workspaceType, workspaceId) as Record<string, unknown> | undefined;
  if (!row) throw new ServiceOperationError("OPERATION_NOT_FOUND", "操作不存在", 404);
  if (!await canAccessEnvironment(app.db, request.admin!, String(row.environment_id))) {
    throw new ServiceOperationError("OPERATION_NOT_FOUND", "操作不存在", 404);
  }
  return mapOperationRow(row);
}

async function releaseLocks(app: FastifyInstance, operationId: string): Promise<void> {
  await app.db.prepare("DELETE FROM service_operation_locks WHERE operation_id = ?").run(operationId);
}

async function acquireLocks(
  app: FastifyInstance,
  workspaceType: string,
  workspaceId: string,
  resourceKeys: string[],
  operationId: string,
  expiresAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await app.db.prepare("DELETE FROM service_operation_locks WHERE expires_at < ?").run(now);
  for (const resourceKey of resourceKeys) {
    const existing = await app.db.prepare(`
      SELECT operation_id, expires_at FROM service_operation_locks
      WHERE workspace_type = ? AND workspace_id = ? AND resource_key = ?
    `).get(workspaceType, workspaceId, resourceKey) as { operation_id: string; expires_at: string } | undefined;
    if (existing && existing.expires_at > now && existing.operation_id !== operationId) {
      throw new ServiceOperationError("OPERATION_IN_PROGRESS", "该部署节点已有进行中的操作", 409, existing.operation_id);
    }
    try {
      await app.db.prepare(`
        INSERT INTO service_operation_locks (workspace_type, workspace_id, resource_key, operation_id, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(workspaceType, workspaceId, resourceKey, operationId, expiresAt);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await app.db.prepare(`
        SELECT operation_id FROM service_operation_locks
        WHERE workspace_type = ? AND workspace_id = ? AND resource_key = ?
      `).get(workspaceType, workspaceId, resourceKey) as { operation_id: string } | undefined;
      throw new ServiceOperationError("OPERATION_IN_PROGRESS", "该部署节点已有进行中的操作", 409, raced?.operation_id);
    }
  }
}

export async function beginServiceOperation(
  app: FastifyInstance,
  request: FastifyRequest,
  input: {
    environmentId: string;
    operationType: ServiceOperationType;
    resourceId: string;
    body: unknown;
    resourceKeys: string[];
  },
): Promise<{ operation: ServiceOperationDto; created: boolean }> {
  if (input.resourceKeys.length > SERVICE_OPERATION_BATCH_LIMIT) {
    throw new ServiceOperationError("INVALID_OPERATION_TARGETS", `一次最多操作 ${SERVICE_OPERATION_BATCH_LIMIT} 个节点`, 413);
  }
  const idempotencyKey = readIdempotencyKey(request);
  const requestHash = canonicalRequestHash(input.body);
  const [workspaceType, workspaceId] = workspaceParams(request);
  const existing = await app.db.prepare(`
    SELECT * FROM service_operation_runs
    WHERE workspace_type = ? AND workspace_id = ? AND idempotency_key = ?
  `).get(workspaceType, workspaceId, idempotencyKey) as Record<string, unknown> | undefined;
  if (existing) {
    if (String(existing.request_hash) !== requestHash) {
      throw new ServiceOperationError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于不同请求", 409, String(existing.id));
    }
    return { operation: mapOperationRow(existing), created: false };
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const userId = request.admin!.id;
  try {
    await app.db.prepare(`
      INSERT INTO service_operation_runs (
        id, workspace_type, workspace_id, environment_id, idempotency_key, request_hash, operation_type,
        resource_id, requested_by_user_id, status, progress_json, result_json, error_code,
        created_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '{}', '{}', '', ?, NULL, NULL, ?)
    `).run(
      id, workspaceType, workspaceId, input.environmentId, idempotencyKey, requestHash, input.operationType,
      input.resourceId, userId, now, now,
    );
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await app.db.prepare(`
      SELECT * FROM service_operation_runs
      WHERE workspace_type = ? AND workspace_id = ? AND idempotency_key = ?
    `).get(workspaceType, workspaceId, idempotencyKey) as Record<string, unknown> | undefined;
    if (!raced) throw error;
    if (String(raced.request_hash) !== requestHash) {
      throw new ServiceOperationError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于不同请求", 409, String(raced.id));
    }
    return { operation: mapOperationRow(raced), created: false };
  }
  const lockTtl = new Date(Date.now() + Math.max(SERVICE_OPERATION_LOCK_TTL_MS, input.resourceKeys.length * SERVICE_OPERATION_COMMAND_TIMEOUT_MS / SERVICE_OPERATION_CONCURRENCY + 30_000)).toISOString();
  try {
    await acquireLocks(app, workspaceType, workspaceId, input.resourceKeys, id, lockTtl);
  } catch (error) {
    await app.db.prepare("DELETE FROM service_operation_runs WHERE id = ?").run(id);
    throw error;
  }
  const operation = await loadOperation(app, id);
  if (!operation) throw new ServiceOperationError("OPERATION_NOT_FOUND", "操作不存在", 404);
  return { operation, created: true };
}

export async function runServiceOperation(
  app: FastifyInstance,
  operationId: string,
  execute: (
    onProgress: (current: number, total: number) => Promise<void>,
    helpers: { shouldContinue: () => boolean; deadline: number },
  ) => Promise<ServiceOperationTargetResult[]>,
  request?: FastifyRequest,
): Promise<void> {
  const started = new Date().toISOString();
  const operation = await loadOperation(app, operationId);
  await app.db.prepare(`
    UPDATE service_operation_runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'
  `).run(started, started, operationId);
  if (request) {
    await writeAudit(app.db, {
      action: "service_operation.started",
      resourceType: "service_operation",
      resourceId: operationId,
      summary: `开始服务操作 ${operation?.operationType ?? "operation"}`,
      details: { operationType: operation?.operationType, environmentId: operation?.environmentId },
      request,
    }).catch(() => undefined);
  }
  const deadline = Date.now() + SERVICE_OPERATION_TOTAL_TIMEOUT_MS;
  const shouldContinue = () => Date.now() <= deadline;
  let targets: ServiceOperationTargetResult[] = [];
  let failure: unknown;
  try {
    targets = await execute(async (current, total) => {
      await app.db.prepare(`
        UPDATE service_operation_runs SET progress_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify({ current, total }), new Date().toISOString(), operationId);
    }, { shouldContinue, deadline });
  } catch (error) {
    failure = error;
  }
  const compact = capOperationResult(targets);
  const timedOut = !shouldContinue() || targets.some((item) => item.errorCode === "OPERATION_TIMEOUT")
    || (failure instanceof ServiceOperationError && failure.code === "OPERATION_TIMEOUT");
  const succeeded = compact.targets.filter((item) => item.ok).length;
  const failed = compact.targets.length - succeeded;
  const status: ServiceOperationStatus = timedOut
    ? "timed_out"
    : failure
      ? "failed"
      : failed === 0
        ? "succeeded"
        : succeeded === 0
          ? "failed"
          : "partial";
  const completed = new Date().toISOString();
  const errorCode = status === "succeeded"
    ? ""
    : status === "timed_out"
      ? "OPERATION_TIMEOUT"
      : status === "partial"
        ? "OPERATION_PARTIAL"
        : "OPERATION_FAILED";
  await app.db.prepare(`
    UPDATE service_operation_runs SET
      status = ?, progress_json = ?, result_json = ?, error_code = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(
    status,
    JSON.stringify({ current: compact.targets.length, total: Math.max(compact.targets.length, operation?.progress.total ?? compact.targets.length) }),
    JSON.stringify(compact),
    errorCode,
    completed,
    completed,
    operationId,
  );
  if (request) {
    await writeAudit(app.db, {
      action: status === "succeeded" ? "service_operation.completed" : `service_operation.${status}`,
      resourceType: "service_operation",
      resourceId: operationId,
      summary: `服务操作 ${status}`,
      details: {
        status,
        errorCode,
        targetCount: compact.targets.length,
        succeeded,
        failed,
        durationMs: Date.parse(completed) - Date.parse(started),
      },
      request,
    }).catch(() => undefined);
  }
  await releaseLocks(app, operationId);
}

function capOperationResult(targets: ServiceOperationTargetResult[]): ServiceOperationDto["result"] {
  const clipped = targets.filter(Boolean).map((item) => {
    const stdout = item.stdout == null ? undefined : clipUtf8(item.stdout, SERVICE_OPERATION_OUTPUT_LIMIT);
    const stderr = item.stderr == null ? undefined : clipUtf8(item.stderr, SERVICE_OPERATION_OUTPUT_LIMIT);
    const message = clipUtf8(item.message, 500);
    return {
      ...item,
      stdout: stdout?.text,
      stderr: stderr?.text,
      truncated: Boolean(item.truncated || stdout?.truncated || stderr?.truncated),
      message: message.text,
    };
  });
  const pack = (items: ServiceOperationTargetResult[], truncated: boolean) => ({
    succeeded: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    truncated,
    targets: items,
  });
  const full = pack(clipped, clipped.some((item) => item.truncated));
  if (utf8ByteLength(JSON.stringify(full)) <= SERVICE_OPERATION_RESULT_LIMIT) return full;
  return pack(clipped.map(({ stdout: _stdout, stderr: _stderr, ...rest }) => rest), true);
}

export async function interruptStaleServiceOperations(app: FastifyInstance): Promise<void> {
  const now = new Date().toISOString();
  const rows = await app.db.prepare(`
    SELECT id, operation_type, environment_id FROM service_operation_runs WHERE status IN ('queued', 'running')
  `).all() as Array<{ id: string; operation_type: string; environment_id: string }>;
  for (const row of rows) {
    await app.db.prepare(`
      UPDATE service_operation_runs SET status = 'interrupted', error_code = 'INTERRUPTED_BY_RESTART', completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);
    await writeAudit(app.db, {
      action: "service_operation.interrupted",
      resourceType: "service_operation",
      resourceId: row.id,
      summary: "服务操作因进程重启中断",
      details: { errorCode: "INTERRUPTED_BY_RESTART", operationType: row.operation_type, environmentId: row.environment_id },
    }).catch(() => undefined);
    await releaseLocks(app, row.id);
  }
  const cutoff = new Date(Date.now() - SERVICE_OPERATION_RETENTION_DAYS * 86_400_000).toISOString();
  await app.db.prepare("DELETE FROM service_operation_runs WHERE created_at < ? AND status NOT IN ('queued', 'running')").run(cutoff);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
  options: {
    shouldContinue?: () => boolean;
    onError?: (error: unknown, item: T, index: number) => R | Promise<R>;
  } = {},
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  let stopped = false;
  let firstError: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) {
      if (stopped || (options.shouldContinue && !options.shouldContinue())) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!);
      } catch (error) {
        stopped = true;
        if (options.onError) {
          try {
            results[index] = await options.onError(error, items[index]!, index);
          } catch (mappedError) {
            firstError ??= mappedError;
          }
        } else {
          firstError ??= error;
        }
      }
    }
  }));
  if (firstError) throw firstError;
  return results;
}
