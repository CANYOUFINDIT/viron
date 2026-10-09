import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { monitorMetricColumn, monitorMetricKeys, monitorStatisticSuffixes } from "../shared/monitor-storage.js";
import { MONITORING_MAX_POINTS, rangeMilliseconds, type MonitoringRange } from "../shared/monitoring.js";
import { metricValues, object, pointStatistics, type MetricObject, type MetricPoint } from "./monitor-metric-storage.js";

export interface NumericSampleRow {
  agent_id: string; sequence_end: number; collected_at: string; resolution_seconds: number; payload_json: string;
  ssh_connection_id: string; normalized: true;
}

export async function historicalMetricAgents(app: FastifyInstance, connectionId: string): Promise<string[]> {
  const rows = await app.db.prepare(`SELECT DISTINCT t.agent_id FROM monitor_metric_streams t
    JOIN ssh_connections c ON c.id = t.ssh_connection_id JOIN ssh_connections target
      ON target.host = c.host AND target.port = c.port AND COALESCE(target.jump_connection_id, '') = COALESCE(c.jump_connection_id, '')
      AND target.workspace_type = c.workspace_type AND target.workspace_id = c.workspace_id WHERE target.id = ?`).all<{ agent_id: string }>(connectionId);
  return rows.map(row => row.agent_id);
}

function tierCondition(tier: number): string {
  if (tier === 0) return `(p.tier_seconds = 0 OR (p.tier_seconds = 300 AND NOT EXISTS (
    SELECT 1 FROM monitor_metric_points raw WHERE raw.series_id = p.series_id AND raw.tier_seconds = 0
      AND raw.at_ms >= p.at_ms AND raw.at_ms < p.at_ms + 300000))
    OR (p.tier_seconds = 3600 AND p.resolution_seconds > 300 AND NOT EXISTS (
      SELECT 1 FROM monitor_metric_points raw WHERE raw.series_id = p.series_id AND raw.tier_seconds = 0 AND raw.at_ms >= p.at_ms AND raw.at_ms < p.at_ms + 3600000)))`;
  return `(p.tier_seconds = ${tier} OR (p.tier_seconds = 0 AND p.rollup_done = 0)
    ${tier === 300 ? "OR (p.tier_seconds = 3600 AND p.resolution_seconds > 300)" : ""})`;
}

/** Aggregate numerically in SQL before transferring rows. Every display bucket keeps weighted values and extrema. */
export async function readMetricSamples(app: FastifyInstance, options: {
  workspaceType: string; workspaceId: string; agentIds: string[]; connectionId?: string; range: MonitoringRange;
  from: number; to: number; maxPoints?: number; deploymentTargets?: Set<string>; deploymentsOnly?: boolean;
}): Promise<{ rows: NumericSampleRow[]; sourceSampleCount: number; gaps: Array<{ startedAt: string; endedAt: string; reason: string }> }> {
  if (!options.agentIds.length) return { rows: [], sourceSampleCount: 0, gaps: [] };
  const tier = rangeMilliseconds[options.range] <= 48 * 3600_000 ? 0 : rangeMilliseconds[options.range] <= 30 * 86400_000 ? 300 : 3600;
  const streamRows = await app.db.prepare(`SELECT id, agent_id, ssh_connection_id FROM monitor_metric_streams WHERE workspace_type = ? AND workspace_id = ? AND agent_id IN (${options.agentIds.map(() => "?").join(",")})`)
    .all<{ id: number; agent_id: string; ssh_connection_id: string }>(options.workspaceType, options.workspaceId, ...options.agentIds);
  if (!streamRows.length) return { rows: [], sourceSampleCount: 0, gaps: [] };
  const streams = new Map(streamRows.map(row => [Number(row.id), row]));
  const directory = await app.db.prepare(`SELECT id, stream_id, kind, identity_json FROM monitor_metric_series WHERE stream_id IN (${streamRows.map(() => "?").join(",")})`)
    .all<{ id: number; stream_id: number; kind: string; identity_json: string }>(...streamRows.map(row => row.id));
  const selected = directory.filter(series => {
    if (series.kind !== "deployment") return !options.deploymentsOnly;
    const identity = object(JSON.parse(series.identity_json));
    return !options.deploymentTargets || options.deploymentTargets.has(`${identity.provider}:${identity.externalId}`);
  });
  if (!selected.length) return { rows: [], sourceSampleCount: 0, gaps: [] };
  const byId = new Map(selected.map(series => [Number(series.id), series]));
  const bucketMs = Math.max(1000, Math.ceil((options.to - options.from) / Math.max(1, (options.maxPoints ?? MONITORING_MAX_POINTS) - 1)));
  const where = `p.series_id IN (${selected.map(() => "?").join(",")}) AND p.at_ms >= ? AND p.at_ms <= ? AND ${tierCondition(tier)}`;
  const bounds = [options.from - Math.max(tier, 3600) * 1000, options.to];
  const aggregates = monitorMetricKeys.flatMap(key => monitorStatisticSuffixes.map(suffix => {
    const column = `${monitorMetricColumn(key)}_${suffix}`;
    return suffix === "last" ? `MAX(CASE WHEN latest_rank = 1 THEN ${column} ELSE NULL END) AS ${column}`
      : `${suffix === "min" ? "MIN" : suffix === "max" ? "MAX" : "SUM"}(${column}) AS ${column}`;
  }));
  const points = await app.db.prepare(`WITH ranked AS (
    SELECT p.*, CASE WHEN p.tier_seconds > p.resolution_seconds THEN p.tier_seconds ELSE p.resolution_seconds END AS display_resolution,
      CAST(FLOOR(p.source_last_ms / ?) AS ${app.db.dialect === "mysql" ? "SIGNED" : "INTEGER"}) AS display_bucket,
      ROW_NUMBER() OVER (PARTITION BY p.series_id, FLOOR(p.source_last_ms / ?) ORDER BY p.source_last_ms DESC, p.sequence_end DESC) AS latest_rank
    FROM monitor_metric_points p WHERE ${where} AND p.source_last_ms >= ?
  ) SELECT series_id, display_bucket, MAX(CASE WHEN latest_rank = 1 THEN metadata_id ELSE NULL END) AS metadata_id,
    MAX(CASE WHEN latest_rank = 1 THEN state_detail ELSE NULL END) AS state_detail,
    MAX(display_resolution) AS resolution_seconds, SUM(sample_count) AS sample_count,
    MIN(source_first_ms) AS source_first_ms, MAX(source_last_ms) AS source_last_ms,
    MIN(coverage_start_ms) AS coverage_start_ms, MAX(coverage_end_ms) AS coverage_end_ms,
    ${aggregates.join(",")} FROM ranked GROUP BY series_id, display_bucket ORDER BY display_bucket, series_id`)
    .all<MetricPoint & { display_bucket: number }>(bucketMs, bucketMs, ...selected.map(series => series.id), ...bounds, options.from);
  const metadataIds = [...new Set(points.map(point => Number(point.metadata_id)))];
  const metadata = new Map<number, MetricObject>();
  for (let index = 0; index < metadataIds.length; index += 400) {
    const ids = metadataIds.slice(index, index + 400);
    const rows = await app.db.prepare(`SELECT id, content_json FROM monitor_metric_metadata WHERE id IN (${ids.map(() => "?").join(",")})`).all<{ id: number; content_json: string }>(...ids);
    for (const row of rows) metadata.set(Number(row.id), object(JSON.parse(row.content_json)));
  }
  const groups = new Map<string, { streamId: number; bucket: number; at: number; resolution: number; sampleCount: number; host: MetricObject; candidates: MetricObject[]; statistics: MetricObject }>();
  for (const point of points) {
    const series = byId.get(Number(point.series_id))!, key = `${series.stream_id}:${point.display_bucket}`;
    const group = groups.get(key) ?? { streamId: Number(series.stream_id), bucket: point.display_bucket, at: point.source_last_ms, resolution: point.resolution_seconds, sampleCount: 1, host: { disks: [], temperatures: [], topProcesses: [] }, candidates: [], statistics: {} };
    const value = { ...metadata.get(Number(point.metadata_id)), ...metricValues(point) };
    const identity = object(JSON.parse(series.identity_json));
    const statisticKey = series.kind === "host" ? "host" : series.kind === "disk" ? `disk:${identity.path}:${identity.device ?? ""}`
      : series.kind === "temperature" ? `temperature:${identity.chip}:${identity.feature ?? ""}` : `deployment:${identity.provider}:${identity.externalId}`;
    group.statistics[statisticKey] = pointStatistics(point);
    if (series.kind === "host") { group.host = { ...group.host, ...value }; group.at = point.source_last_ms; group.sampleCount = point.sample_count; group.resolution = point.resolution_seconds; }
    else if (series.kind === "disk") (group.host.disks as unknown[]).push(value);
    else if (series.kind === "temperature") (group.host.temperatures as unknown[]).push(value);
    else group.candidates.push({ ...value, state: point.state_detail, status: ["unknown", "running", "stopped", "degraded"][Number(value.statusCode)] ?? "unknown" });
    groups.set(key, group);
  }
  const rows: NumericSampleRow[] = [...groups.values()].map(group => {
    const stream = streams.get(group.streamId)!;
    return { agent_id: stream.agent_id, sequence_end: group.bucket, collected_at: new Date(group.at).toISOString(), resolution_seconds: group.resolution,
      ssh_connection_id: options.connectionId ?? stream.ssh_connection_id, normalized: true as const,
      payload_json: JSON.stringify({ collectedAt: new Date(group.at).toISOString(), resolutionSeconds: group.resolution, sampleCount: group.sampleCount, host: group.host, candidates: group.candidates, statistics: group.statistics }) };
  }).sort((a, b) => a.collected_at.localeCompare(b.collected_at));
  const hostSeries = selected.filter(series => series.kind === "host");
  const coverage = hostSeries.length ? await app.db.prepare(`SELECT p.coverage_json FROM monitor_metric_points p WHERE p.series_id IN (${hostSeries.map(() => "?").join(",")}) AND p.at_ms >= ? AND p.at_ms <= ? AND ${tierCondition(tier)} ORDER BY p.source_last_ms`)
    .all<{ coverage_json: string }>(...hostSeries.map(series => series.id), ...bounds) : [];
  const ranges = coverage.flatMap(row => JSON.parse(row.coverage_json) as number[][]).sort((a, b) => a[0]! - b[0]!);
  const gaps: Array<{ startedAt: string; endedAt: string; reason: string }> = [];
  let end = 0;
  for (const [start, stop] of ranges) {
    if (end && start! - end > 1000 && start! >= options.from && end <= options.to) gaps.push({ startedAt: new Date(end).toISOString(), endedAt: new Date(start!).toISOString(), reason: "no_samples" });
    end = Math.max(end, stop!);
  }
  // Diagnostic decompression is bounded by ingestion limits and only needed for the short host history.
  if (!options.deploymentsOnly && tier === 0 && rows.length) {
    const diagnosticRows = await app.db.prepare(`SELECT stream_id, at_ms, payload_base64 FROM monitor_metric_diagnostics WHERE stream_id IN (${streamRows.map(() => "?").join(",")}) AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms DESC LIMIT 480`)
      .all<{ stream_id: number; at_ms: number; payload_base64: string }>(...streamRows.map(stream => stream.id), options.from, options.to);
    const diagnostics = new Map<string, typeof diagnosticRows[number]>();
    for (const row of diagnosticRows) {
      const key = `${streams.get(Number(row.stream_id))!.agent_id}:${Math.floor(Number(row.at_ms) / bucketMs)}`;
      if (!diagnostics.has(key)) diagnostics.set(key, row);
    }
    for (const row of rows) {
      const diagnostic = diagnostics.get(`${row.agent_id}:${row.sequence_end}`);
      if (!diagnostic) continue;
      try {
        const payload = JSON.parse(row.payload_json), detail = JSON.parse(gunzipSync(Buffer.from(diagnostic.payload_base64, "base64"), { maxOutputLength: 64 * 1024 }).toString());
        payload.host.topProcesses = detail.topProcesses; row.payload_json = JSON.stringify(payload);
      } catch { /* Corrupt diagnostics cannot hide numeric monitoring history. */ }
    }
  }
  return { rows, sourceSampleCount: points.filter(point => byId.get(Number(point.series_id))!.kind === (options.deploymentsOnly ? "deployment" : "host")).reduce((sum, point) => sum + Number(point.sample_count), 0), gaps };
}
