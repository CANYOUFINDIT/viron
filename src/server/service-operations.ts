import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUniqueConstraintError } from "./database-errors.js";
import { canAccessEnvironment, workspaceParams } from "./access-control.js";
import {
  SERVICE_OPERATION_BATCH_LIMIT,
  SERVICE_OPERATION_COMMAND_TIMEOUT_MS,
  SERVICE_OPERATION_CONCURRENCY,
  SERVICE_OPERATION_LOCK_TTL_MS,
  SERVICE_OPERATION_OUTPUT_LIMIT,
  SERVICE_OPERATION_RESULT_LIMIT,
  SERVICE_OPERATION_RETENTION_DAYS,
  SERVICE_OPERATION_TOTAL_TIMEOUT_MS,
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
  execute: (onProgress: (current: number, total: number) => Promise<void>) => Promise<ServiceOperationTargetResult[]>,
): Promise<void> {
  const started = new Date().toISOString();
  await app.db.prepare(`
    UPDATE service_operation_runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'
  `).run(started, started, operationId);
  const deadline = Date.now() + SERVICE_OPERATION_TOTAL_TIMEOUT_MS;
  try {
    const targets = await execute(async (current, total) => {
      if (Date.now() > deadline) throw new ServiceOperationError("OPERATION_TIMEOUT", "批量操作超过 10 分钟限制", 504);
      await app.db.prepare(`
        UPDATE service_operation_runs SET progress_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify({ current, total }), new Date().toISOString(), operationId);
    });
    const succeeded = targets.filter((item) => item.ok).length;
    const failed = targets.length - succeeded;
    const compact = capOperationResult(targets);
    const status: ServiceOperationStatus = failed === 0 ? "succeeded" : succeeded === 0 ? "failed" : "partial";
    const completed = new Date().toISOString();
    await app.db.prepare(`
      UPDATE service_operation_runs SET
        status = ?, progress_json = ?, result_json = ?, error_code = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      JSON.stringify({ current: targets.length, total: targets.length }),
      JSON.stringify(compact),
      status === "succeeded" ? "" : status === "partial" ? "OPERATION_PARTIAL" : "OPERATION_FAILED",
      completed,
      completed,
      operationId,
    );
  } catch (error) {
    const timedOut = error instanceof ServiceOperationError && error.code === "OPERATION_TIMEOUT";
    const completed = new Date().toISOString();
    await app.db.prepare(`
      UPDATE service_operation_runs SET status = ?, error_code = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(
      timedOut ? "timed_out" : "failed",
      timedOut ? "OPERATION_TIMEOUT" : "OPERATION_FAILED",
      completed,
      completed,
      operationId,
    );
  } finally {
    await releaseLocks(app, operationId);
  }
}

function capOperationResult(targets: ServiceOperationTargetResult[]): ServiceOperationDto["result"] {
  const clipped = targets.map((item) => ({
    ...item,
    stdout: item.stdout?.slice(0, SERVICE_OPERATION_OUTPUT_LIMIT),
    stderr: item.stderr?.slice(0, SERVICE_OPERATION_OUTPUT_LIMIT),
    truncated: Boolean(item.truncated || (item.stdout?.length ?? 0) > SERVICE_OPERATION_OUTPUT_LIMIT || (item.stderr?.length ?? 0) > SERVICE_OPERATION_OUTPUT_LIMIT),
    message: item.message.slice(0, 500),
  }));
  const pack = (items: ServiceOperationTargetResult[], truncated: boolean) => ({
    succeeded: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    truncated,
    targets: items,
  });
  const full = pack(clipped, clipped.some((item) => item.truncated));
  if (JSON.stringify(full).length <= SERVICE_OPERATION_RESULT_LIMIT) return full;
  return pack(clipped.map(({ stdout: _stdout, stderr: _stderr, ...rest }) => rest), true);
}

export async function interruptStaleServiceOperations(app: FastifyInstance): Promise<void> {
  const now = new Date().toISOString();
  const rows = await app.db.prepare(`
    SELECT id FROM service_operation_runs WHERE status IN ('queued', 'running')
  `).all() as Array<{ id: string }>;
  for (const row of rows) {
    await app.db.prepare(`
      UPDATE service_operation_runs SET status = 'interrupted', error_code = 'INTERRUPTED_BY_RESTART', completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);
    await releaseLocks(app, row.id);
  }
  const cutoff = new Date(Date.now() - SERVICE_OPERATION_RETENTION_DAYS * 86_400_000).toISOString();
  await app.db.prepare("DELETE FROM service_operation_runs WHERE created_at < ? AND status NOT IN ('queued', 'running')").run(cutoff);
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}
