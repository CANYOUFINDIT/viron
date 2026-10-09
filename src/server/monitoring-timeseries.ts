import { historicalMetricAgents, readMetricSamples } from "./monitor-metric-reader.js";
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

function average(values: Array<{ value: number; weight: number }>): number | null {
  if (!values.length) return null;
  return values.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / values.reduce((sum, sample) => sum + sample.weight, 0);
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
  const legacyFilter = `AND NOT EXISTS (SELECT 1 FROM monitor_metric_ingest mi JOIN monitor_metric_streams mt ON mt.id = mi.stream_id
    JOIN ssh_connections mc ON mc.id = monitor_samples.ssh_connection_id AND mc.workspace_type = mt.workspace_type AND mc.workspace_id = mt.workspace_id
    WHERE mi.sequence_end = monitor_samples.sequence_end AND mt.agent_id = monitor_samples.agent_id)`;
  const countRow = await app.db.prepare(`
    SELECT COUNT(*) AS sample_count FROM monitor_samples
    WHERE ssh_connection_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ? ${legacyFilter}
  `).get(...connectionIds, from, to) as { sample_count: number | string };
  let sourceSampleCount = Number(countRow.sample_count);
  const bucketMs = timeBucketMs(range);
  const bucketExpression = app.db.dialect === "mysql"
    ? "FLOOR(UNIX_TIMESTAMP(collected_at) * 1000 / ?)"
    : "CAST((CAST(strftime('%s', collected_at) AS INTEGER) * 1000) / ? AS INTEGER)";
  const rows = await app.db.prepare(`
    WITH ranked_samples AS (
      SELECT ssh_connection_id, collected_at, payload_json,
        ROW_NUMBER() OVER (
          PARTITION BY ssh_connection_id, ${bucketExpression}
          ORDER BY collected_at DESC
        ) AS bucket_rank,
        ROW_NUMBER() OVER (PARTITION BY ssh_connection_id ORDER BY collected_at) AS first_rank,
        ROW_NUMBER() OVER (PARTITION BY ssh_connection_id ORDER BY collected_at DESC) AS last_rank
      FROM monitor_samples
      WHERE ssh_connection_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ? ${legacyFilter}
    )
    SELECT ssh_connection_id, collected_at, payload_json
    FROM ranked_samples
    WHERE bucket_rank = 1 OR first_rank = 1 OR last_rank = 1
    ORDER BY collected_at
  `).all(bucketMs, ...connectionIds, from, to) as Array<{ ssh_connection_id: string; collected_at: string; payload_json: string }>;
  const connections = await app.db.prepare(`SELECT c.id, c.workspace_type, c.workspace_id, h.agent_id FROM ssh_connections c LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id WHERE c.id IN (${placeholders})`)
    .all<{ id: string; workspace_type: string; workspace_id: string; agent_id: string | null }>(...connectionIds);
  for (const connection of connections) {
    const numeric = await readMetricSamples(app, { workspaceType: connection.workspace_type, workspaceId: connection.workspace_id,
      agentIds: [...new Set([...(connection.agent_id ? [connection.agent_id] : []), ...await historicalMetricAgents(app, connection.id)])],
      connectionId: connection.id, range, from: Date.parse(from), to: Date.parse(to), deploymentsOnly: true,
      deploymentTargets: new Set(selected.filter(item => item.ssh_connection_id === connection.id).map(item => `${item.provider_type}:${item.external_id}`)) });
    rows.push(...numeric.rows); sourceSampleCount += numeric.sourceSampleCount;
  }
  rows.sort((a, b) => a.collected_at.localeCompare(b.collected_at));
  const buckets = new Map<string, {
    at: string;
    cpu: Array<{ value: number; weight: number }>;
    memory: Array<{ value: number; weight: number }>;
    deployments: Record<string, { cpu: Array<{ value: number; weight: number }>; memory: Array<{ value: number; weight: number }>; cpuMin: number | null; cpuMax: number | null; memoryMax: number | null }>;
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
      const statistics = payload.statistics as Record<string, Record<string, { weight: number; min: number; max: number }>> | undefined;
      const stats = statistics?.[`deployment:${target.provider}:${target.externalId}`];
      const series = bucket.deployments[target.id] ?? { cpu: [], memory: [], cpuMin: null, cpuMax: null, memoryMax: null };
      if (cpu !== null) {
        const sample = { value: cpu, weight: Math.max(1, Number(stats?.cpuUsedPercent?.weight ?? payload.resolutionSeconds ?? 1)) };
        series.cpu.push(sample); bucket.cpu.push(sample);
        series.cpuMin = Math.min(series.cpuMin ?? Infinity, stats?.cpuUsedPercent?.min ?? cpu);
        series.cpuMax = Math.max(series.cpuMax ?? -Infinity, stats?.cpuUsedPercent?.max ?? cpu);
      }
      if (memory !== null) {
        const sample = { value: memory, weight: Math.max(1, Number(stats?.memoryBytes?.weight ?? payload.resolutionSeconds ?? 1)) };
        series.memory.push(sample); bucket.memory.push(sample);
        series.memoryMax = Math.max(series.memoryMax ?? -Infinity, stats?.memoryBytes?.max ?? memory);
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
      cpuMin: series.cpuMin,
      cpuMax: series.cpuMax,
      memoryMax: series.memoryMax,
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
