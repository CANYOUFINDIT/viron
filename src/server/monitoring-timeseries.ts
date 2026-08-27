import type { FastifyInstance, FastifyRequest } from "fastify";
import { canAccessEnvironment } from "./access-control.js";
import {
  MONITORING_MAX_POINTS,
  MONITORING_MAX_SERVICE_DEPLOYMENTS,
  bucketTimestamp,
  capSeriesPoints,
  finiteMetric,
  rangeMilliseconds,
  timeBucketMs,
  type MonitoringRange,
} from "../shared/monitoring.js";

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

export class MonitoringQueryError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "MonitoringQueryError";
  }
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function loadServiceTimeseries(
  app: FastifyInstance,
  request: FastifyRequest,
  serviceId: string,
  range: MonitoringRange,
): Promise<Record<string, unknown>> {
  const service = await app.db.prepare(`
    SELECT s.id, s.name, s.environment_id, e.name AS environment_name
    FROM services s JOIN environments e ON e.id = s.environment_id
    WHERE s.id = ?
  `).get(serviceId) as { id: string; name: string; environment_id: string; environment_name: string } | undefined;
  if (!service || !await canAccessEnvironment(app.db, request.admin!, service.environment_id)) {
    throw new MonitoringQueryError("SERVICE_NOT_FOUND", "服务不存在", 404);
  }
  const deployments = await app.db.prepare(`
    SELECT id, display_name, external_id, provider_type, ssh_connection_id, ssh_connection_name
    FROM service_deployments WHERE service_id = ? ORDER BY created_at
  `).all(serviceId) as Array<Record<string, unknown>>;
  const truncated = deployments.length > MONITORING_MAX_SERVICE_DEPLOYMENTS;
  const selected = deployments.slice(0, MONITORING_MAX_SERVICE_DEPLOYMENTS);
  const now = Date.now();
  const from = new Date(now - rangeMilliseconds[range]).toISOString();
  const to = new Date(now).toISOString();
  const connectionIds = [...new Set(selected.map((item) => String(item.ssh_connection_id ?? "")).filter(Boolean))];
  if (!connectionIds.length) {
    return {
      range, from, to, truncated, sourceSampleCount: 0,
      service: { id: service.id, name: service.name, environmentId: service.environment_id, environmentName: service.environment_name },
      points: [],
      deployments: selected.map((item) => ({
        id: item.id, name: item.display_name || item.external_id, provider: item.provider_type, sshConnectionName: item.ssh_connection_name,
      })),
    };
  }
  const placeholders = connectionIds.map(() => "?").join(",");
  const countRow = await app.db.prepare(`
    SELECT COUNT(*) AS sample_count FROM monitor_samples
    WHERE ssh_connection_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ?
  `).get(...connectionIds, from, to) as { sample_count: number | string };
  const sourceSampleCount = Number(countRow.sample_count);
  const bucketMs = timeBucketMs(range);
  const rows = await app.db.prepare(`
    SELECT ssh_connection_id, collected_at, payload_json
    FROM monitor_samples
    WHERE ssh_connection_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ?
    ORDER BY collected_at
    LIMIT 50000
  `).all(...connectionIds, from, to) as Array<{ ssh_connection_id: string; collected_at: string; payload_json: string }>;
  const buckets = new Map<string, {
    at: string;
    cpu: number[];
    memory: number[];
    deployments: Record<string, { cpu: number[]; memory: number[] }>;
  }>();
  const deploymentByConnection = new Map<string, Array<{ id: string; provider: string; externalId: string }>>();
  for (const item of selected) {
    const connectionId = String(item.ssh_connection_id ?? "");
    const list = deploymentByConnection.get(connectionId) ?? [];
    list.push({ id: String(item.id), provider: String(item.provider_type), externalId: String(item.external_id) });
    deploymentByConnection.set(connectionId, list);
  }
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
    const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<Record<string, unknown>> : [];
    const targets = deploymentByConnection.get(row.ssh_connection_id) ?? [];
    const bucketKey = bucketTimestamp(row.collected_at, bucketMs);
    const bucket = buckets.get(bucketKey) ?? { at: bucketKey, cpu: [], memory: [], deployments: {} };
    for (const target of targets) {
      const candidate = candidates.find((item) => String(item.provider ?? "") === target.provider && String(item.externalId ?? "") === target.externalId);
      const cpu = finiteMetric(candidate?.cpuUsedPercent);
      const memory = finiteMetric(candidate?.memoryBytes);
      const series = bucket.deployments[target.id] ?? { cpu: [], memory: [] };
      if (cpu !== null) {
        series.cpu.push(cpu);
        bucket.cpu.push(cpu);
      }
      if (memory !== null) {
        series.memory.push(memory);
        bucket.memory.push(memory);
      }
      bucket.deployments[target.id] = series;
    }
    buckets.set(bucketKey, bucket);
  }
  const sortedBuckets = [...buckets.values()].sort((left, right) => left.at.localeCompare(right.at));
  const gapMs = Math.max(bucketMs * 4, 60_000);
  const rawPoints = sortedBuckets.map((bucket, index) => ({
    at: bucket.at,
    breakBefore: index > 0 && Date.parse(bucket.at) - Date.parse(sortedBuckets[index - 1]!.at) > gapMs,
    cpuUsedPercent: average(bucket.cpu),
    memoryBytes: average(bucket.memory),
    deployments: Object.fromEntries(Object.entries(bucket.deployments).map(([id, series]) => [id, {
      cpuUsedPercent: average(series.cpu),
      memoryBytes: average(series.memory),
    }])),
  }));
  const points = capSeriesPoints(rawPoints, MONITORING_MAX_POINTS, (point) => point.breakBefore);
  return {
    range,
    from,
    to,
    truncated,
    sourceSampleCount,
    sampledPointCount: points.length,
    service: { id: service.id, name: service.name, environmentId: service.environment_id, environmentName: service.environment_name },
    deployments: selected.map((item) => ({
      id: item.id,
      name: item.display_name || item.external_id,
      provider: item.provider_type,
      sshConnectionName: item.ssh_connection_name,
    })),
    points,
  };
}
