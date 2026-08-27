export const SERVICE_OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "interrupted",
] as const;

export type ServiceOperationStatus = (typeof SERVICE_OPERATION_STATUSES)[number];

export const SERVICE_OPERATION_TYPES = [
  "deployment_action",
  "deployment_batch_action",
  "script_action",
] as const;

export type ServiceOperationType = (typeof SERVICE_OPERATION_TYPES)[number];

export type ServiceDeploymentCapability = "start" | "stop" | "restart";

export const SERVICE_OPERATION_COMMAND_TIMEOUT_MS = 120_000;
export const SERVICE_OPERATION_BATCH_LIMIT = 50;
export const SERVICE_OPERATION_CONCURRENCY = 4;
export const SERVICE_OPERATION_TOTAL_TIMEOUT_MS = 10 * 60_000;
export const SERVICE_OPERATION_OUTPUT_LIMIT = 8 * 1024;
export const SERVICE_OPERATION_RESULT_LIMIT = 256 * 1024;
export const SERVICE_OPERATION_LOCK_TTL_MS = SERVICE_OPERATION_COMMAND_TIMEOUT_MS + 30_000;
export const SERVICE_OPERATION_RETENTION_DAYS = 7;
export const SERVICE_DEPLOYMENTS_MAX_SERVICES = 100;
export const SERVICE_DEPLOYMENTS_MAX_DEPLOYMENTS = 500;
export const SERVICE_DEPLOYMENTS_MAX_BYTES = 1024 * 1024;

export function clipUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export interface ServiceOperationTargetResult {
  deploymentId: string;
  targetName: string;
  connectionId: string;
  connectionName: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  errorCode: string;
  message: string;
  truncated: boolean;
  stdout?: string;
  stderr?: string;
}

export interface ServiceOperationDto {
  id: string;
  environmentId: string;
  operationType: ServiceOperationType;
  resourceId: string;
  status: ServiceOperationStatus;
  progress: { current: number; total: number };
  result: {
    succeeded: number;
    failed: number;
    truncated: boolean;
    targets: ServiceOperationTargetResult[];
  };
  errorCode: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export function deploymentCapabilities(
  provider: string,
  metrics: Record<string, unknown> = {},
): ServiceDeploymentCapability[] {
  if (provider === "systemd" || provider === "docker" || provider === "podman" || provider === "supervisor") {
    return ["start", "stop", "restart"];
  }
  if (provider === "kubernetes" && kubernetesController(metrics)) return ["restart"];
  return [];
}

export function kubernetesController(metrics: Record<string, unknown>): { kind: string; name: string; namespace: string } | null {
  const metadata = (metrics.metadata && typeof metrics.metadata === "object" && !Array.isArray(metrics.metadata)
    ? metrics.metadata
    : metrics) as Record<string, unknown>;
  const kind = String(metadata.resourceKind ?? metadata.kind ?? "");
  const name = String(metadata.name ?? metadata.resourceName ?? "");
  const namespace = String(metadata.namespace ?? "default") || "default";
  if (!["Deployment", "StatefulSet", "DaemonSet"].includes(kind) || !name) return null;
  return { kind, name, namespace };
}

export function capabilityDisabledReason(provider: string, action: string): string {
  if (provider === "kubernetes" && action !== "restart") return "Kubernetes 仅对结构化控制器提供重启";
  if (provider === "process") return "裸进程不提供通用启停，请使用 Runbook";
  if (provider === "kubernetes") return "当前 Kubernetes 目标不是可重启的结构化控制器";
  return "该节点不支持此操作";
}

export function hashServiceOperationRequest(body: unknown): string {
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
    const keys = Object.keys(value as object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  return stable(body ?? {});
}
