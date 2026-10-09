import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import type { EnvmanDatabase } from "./database-client.js";
import {
  defaultMonitorStoragePolicy, monitorHostMetricKeys, monitorObjectMetricKeys, monitorDeploymentMetricKeys,
  monitorMetricColumn, monitorMetricKeys, monitorStatisticSuffixes, monitorStorageLevel,
  type MonitorMetricStatistic, type MonitorStoragePolicy, type MonitorStorageStatus,
} from "../shared/monitor-storage.js";

export type MetricObject = Record<string, unknown>;
export interface MetricSample {
  sequenceStart: number; sequenceEnd: number; collectedAt: string; resolutionSeconds: number;
  payload: { host: unknown; candidates?: unknown[]; sampleCount?: number; errors?: string[];
    statistics?: Record<string, Record<string, MonitorMetricStatistic>>; coverage?: number[][] };
}
export interface MetricScope { workspaceType: string; workspaceId: string; agentId: string; connectionId: string }
export interface MetricPoint extends MetricObject {
  id: number; series_id: number; metadata_id: number; tier_seconds: number; at_ms: number; sequence_end: number;
  resolution_seconds: number; sample_count: number; source_first_ms: number; source_last_ms: number;
  coverage_start_ms: number; coverage_end_ms: number; coverage_json: string; stored_bytes: number; state_detail: string;
}
export const metricBaseColumns = ["series_id", "metadata_id", "tier_seconds", "at_ms", "sequence_end", "resolution_seconds",
  "sample_count", "coverage_start_ms", "coverage_end_ms", "coverage_json", "source_first_ms", "source_last_ms", "stored_bytes", "state_detail"];
export const metricValueColumns = monitorMetricKeys.flatMap(key => monitorStatisticSuffixes.map(suffix => `${monitorMetricColumn(key)}_${suffix}`));
export const object = (value: unknown): MetricObject => value && typeof value === "object" && !Array.isArray(value) ? value as MetricObject : {};
const writeErrors = new WeakMap<EnvmanDatabase, string>();
export function recordMonitorStorageError(app: FastifyInstance, failed: boolean): void {
  if (failed) writeErrors.set(app.db, "监控历史写入失败，请检查服务端存储");
  else writeErrors.delete(app.db);
}
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const storagePolicy = (app: FastifyInstance): MonitorStoragePolicy => {
  const policy = { ...defaultMonitorStoragePolicy, ...app.config.monitorStoragePolicy };
  policy.batchSize = Math.min(500, Math.max(1, policy.batchSize));
  policy.maintenanceBudgetMs = Math.min(30000, Math.max(100, policy.maintenanceBudgetMs));
  policy.maintenanceIntervalSeconds = Math.min(3600, Math.max(10, policy.maintenanceIntervalSeconds));
  policy.diagnosticMaxBytes = Math.min(policy.maxBytes, policy.diagnosticMaxBytes);
  return policy;
};
const estimatedBytes = (bytes: number) => Math.ceil(bytes * 1.5); // Includes an explicit allowance for rows and indexes, not filesystem allocation.
const json = (value: unknown) => JSON.stringify(value);
const numberAt = (value: MetricObject, path: string): number | null => {
  const item = path.split(".").reduce<unknown>((current, key) => object(current)[key], value);
  return typeof item === "number" && Number.isFinite(item) ? item : null;
};
export function mergeCoverage(ranges: number[][]): number[][] {
  const merged: number[][] = [];
  for (const [start, end] of ranges.filter(range => range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1]! > range[0]!)
    .sort((a, b) => a[0]! - b[0]!)) {
    const last = merged.at(-1);
    if (last && start! <= last[1]!) last[1] = Math.max(last[1]!, end!);
    else merged.push([start!, end!]);
  }
  return merged;
}
export function pointStatistics(point: MetricObject): Record<string, MonitorMetricStatistic> {
  const statistics: Record<string, MonitorMetricStatistic> = {};
  for (const key of monitorMetricKeys) {
    const column = monitorMetricColumn(key);
    if (point[`${column}_weight`] == null || Number(point[`${column}_weight`]) <= 0) continue;
    statistics[key] = Object.fromEntries(monitorStatisticSuffixes.map(suffix => [suffix, Number(point[`${column}_${suffix}`])])) as unknown as MonitorMetricStatistic;
  }
  return statistics;
}
export function metricValues(point: MetricObject, last = false): MetricObject {
  const value: MetricObject = {};
  for (const [key, statistic] of Object.entries(pointStatistics(point))) {
    const parts = key.split(".");
    let target = value;
    for (const part of parts.slice(0, -1)) { target[part] ??= {}; target = object(target[part]); }
    target[parts.at(-1)!] = last || ["cpuCount", "uptimeSeconds", "restartCount", "statusCode"].includes(key)
      ? statistic.last : statistic.sum / statistic.weight;
  }
  return value;
}
export async function lockStorageBudget(db: EnvmanDatabase): Promise<{ used_bytes: number; diagnostic_bytes: number }> {
  // A duplicate-key upsert takes the exclusive lock immediately. INSERT IGNORE
  // followed by UPDATE makes concurrent MySQL writers upgrade shared locks and deadlock.
  await db.prepare(`INSERT INTO monitor_storage_state (state_key, value_json) VALUES ('budget', '{}')
    ON CONFLICT(state_key) DO UPDATE SET updated_ms = updated_ms`).run();
  return (await db.prepare("SELECT used_bytes, diagnostic_bytes FROM monitor_storage_state WHERE state_key = 'budget'").get()) as { used_bytes: number; diagnostic_bytes: number };
}
export async function accountStorage(db: EnvmanDatabase, bytes: number, diagnosticBytes = 0): Promise<void> {
  await db.prepare(`UPDATE monitor_storage_state SET used_bytes = ${db.dialect === "mysql" ? "GREATEST" : "MAX"}(0, used_bytes + ?),
    diagnostic_bytes = ${db.dialect === "mysql" ? "GREATEST" : "MAX"}(0, diagnostic_bytes + ?) WHERE state_key = 'budget'`).run(bytes, diagnosticBytes);
}
export async function loadMonitorStorageStatus(app: FastifyInstance, scope?: { workspaceType: string; workspaceId: string }): Promise<MonitorStorageStatus> {
  const policy = storagePolicy(app);
  const state = await app.db.prepare("SELECT used_bytes, value_json, updated_ms FROM monitor_storage_state WHERE state_key = 'budget'").get<{ used_bytes: number; value_json: string; updated_ms: number }>();
  const maintenance = await app.db.prepare("SELECT value_json FROM monitor_storage_state WHERE state_key = 'maintenance'").get<{ value_json: string }>();
  const info = object(JSON.parse(maintenance?.value_json ?? "{}"));
  const condition = scope ? "WHERE t.workspace_type = ? AND t.workspace_id = ?" : "";
  const series = await app.db.prepare(`SELECT COUNT(*) AS count FROM monitor_metric_series s JOIN monitor_metric_streams t ON t.id = s.stream_id ${condition}`)
    .get<{ count: number }>(...(scope ? [scope.workspaceType, scope.workspaceId] : []));
  const pending = await app.db.prepare(`SELECT 1 AS pending FROM monitor_samples s ${scope ? "JOIN ssh_connections c ON c.id = s.ssh_connection_id WHERE c.workspace_type = ? AND c.workspace_id = ?" : ""} LIMIT 1`)
    .get(...(scope ? [scope.workspaceType, scope.workspaceId] : []));
  const usedBytes = Number(state?.used_bytes ?? 0);
  return { policy, level: monitorStorageLevel(usedBytes, policy.maxBytes), usedBytes, budgetBytes: policy.maxBytes,
    seriesCount: Number(series?.count ?? 0), lastMaintenanceAt: typeof info.lastMaintenanceAt === "string" ? info.lastMaintenanceAt : null,
    lastError: writeErrors.get(app.db) ?? (typeof info.lastError === "string" ? info.lastError : null), migrationPending: Boolean(pending) };
}

export async function retainIncidentDiagnostics(app: FastifyInstance, scope: MetricScope, at: number): Promise<void> {
  const incident = await app.db.prepare(`SELECT a.id FROM monitor_alerts a JOIN ssh_connections c ON c.id = a.ssh_connection_id
    JOIN monitor_hosts h ON h.ssh_connection_id = c.id WHERE a.status = 'active' AND h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ? LIMIT 1`)
    .get(scope.agentId, scope.workspaceType, scope.workspaceId);
  if (!incident) return;
  await app.db.prepare(`UPDATE monitor_metric_diagnostics SET expires_ms = at_ms + ? WHERE stream_id IN
    (SELECT id FROM monitor_metric_streams WHERE workspace_type = ? AND workspace_id = ? AND agent_id = ?)
    AND at_ms >= ? AND at_ms <= ?`).run(storagePolicy(app).incidentDiagnosticDays * 86400_000, scope.workspaceType, scope.workspaceId, scope.agentId, at - 300000, at);
}

export async function managedMetricTargets(app: FastifyInstance, scope: MetricScope): Promise<Set<string>> {
  const rows = await app.db.prepare(`SELECT DISTINCT d.provider_type, d.external_id FROM service_deployments d
    JOIN ssh_connections c ON c.id = d.ssh_connection_id LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
    WHERE c.workspace_type = ? AND c.workspace_id = ? AND (c.id = ? OR h.agent_id = ?)`)
    .all<{ provider_type: string; external_id: string }>(scope.workspaceType, scope.workspaceId, scope.connectionId, scope.agentId);
  return new Set(rows.map(row => `${row.provider_type}:${row.external_id}`));
}

/** Caller owns the transaction: samples, latest state and acknowledged cursor must commit together. */
export async function storeMetricSamples(app: FastifyInstance, scope: MetricScope, samples: MetricSample[], targets?: Set<string>, migration = false): Promise<{ stored: number; limited: boolean; overlap: boolean }> {
  const policy = storagePolicy(app), db = app.db;
  const budget = await lockStorageBudget(db);
  let bytes = Number(budget.used_bytes), diagnosticBytes = Number(budget.diagnostic_bytes), added = 0, diagnosticAdded = 0, stored = 0, limited = false, overlap = false;
  const existingStream = await db.prepare(`SELECT id, last_sequence FROM monitor_metric_streams WHERE workspace_type = ? AND workspace_id = ? AND agent_id = ?`)
    .get<{ id: number; last_sequence: number }>(scope.workspaceType, scope.workspaceId, scope.agentId);
  if (!existingStream && bytes + 512 > policy.maxBytes * .95) {
    if (migration) throw new Error("MONITOR_MIGRATION_CAPACITY");
    return { stored: 0, limited: true, overlap: false };
  }
  const streamInsert = await db.prepare(`INSERT OR IGNORE INTO monitor_metric_streams (workspace_type, workspace_id, agent_id, ssh_connection_id) VALUES (?, ?, ?, ?)`)
    .run(scope.workspaceType, scope.workspaceId, scope.agentId, scope.connectionId);
  if (streamInsert.changes) { bytes += 512; added += 512; }
  const stream = existingStream ?? await db.prepare(`SELECT id, last_sequence FROM monitor_metric_streams WHERE workspace_type = ? AND workspace_id = ? AND agent_id = ?`)
    .get<{ id: number; last_sequence: number }>(scope.workspaceType, scope.workspaceId, scope.agentId);
  const streamId = Number(stream!.id);
  targets ??= await managedMetricTargets(app, scope);
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM monitor_metric_series s JOIN monitor_metric_streams t ON t.id = s.stream_id WHERE t.workspace_type = ? AND t.workspace_id = ?`)
    .get<{ count: number }>(scope.workspaceType, scope.workspaceId);
  let seriesCount = Number(count?.count ?? 0);
  const cache = new Map<string, { id: number; metadataId: number; metadataHash: string }>();
  for (const sample of samples) {
    const at = Date.parse(sample.collectedAt);
    if (!Number.isFinite(at)) throw new Error("监控采样时间无效");
    if ((!migration && sample.sequenceEnd <= Number(stream!.last_sequence)) || await db.prepare("SELECT 1 AS found FROM monitor_metric_ingest WHERE stream_id = ? AND sequence_end = ?").get(streamId, sample.sequenceEnd)) continue;
    // A locally compacted interval may overlap acknowledged raw samples. Its unknown suffix cannot be
    // recovered from an average; record a gap instead of double counting the already stored prefix.
    if (!migration && sample.sequenceStart <= Number(stream!.last_sequence)) { overlap = true; continue; }
    // Never advance a legacy migration cursor if capacity prevents conversion.
    if (at < Date.now() - policy.hourlyDays * 86400_000) { stored++; continue; }
    const host = object(sample.payload.host);
    const entities: Array<{ kind: string; identity: MetricObject; metadata: MetricObject; values: MetricObject; keys: readonly string[]; statisticKey: string; detail?: string }> = [
      { kind: "host", identity: {}, metadata: Object.fromEntries(["hostname", "operatingSystem", "architecture", "kernelVersion", "metricsVersion", "collectorUser", "diskCollectionStatus"].filter(key => host[key] !== undefined).map(key => [key, host[key]])), values: host, keys: monitorHostMetricKeys, statisticKey: "host" },
      ...(Array.isArray(host.disks) ? host.disks : []).slice(0, 256).map(value => { const disk = object(value); return { kind: "disk", identity: { path: disk.path, device: disk.device ?? "" }, metadata: { path: disk.path, device: disk.device ?? "", filesystem: disk.filesystem ?? "" }, values: disk, keys: monitorObjectMetricKeys, statisticKey: `disk:${disk.path}:${disk.device ?? ""}` }; }),
      ...(Array.isArray(host.temperatures) ? host.temperatures : []).slice(0, 256).map(value => { const temp = object(value); return { kind: "temperature", identity: { chip: temp.chip, feature: temp.feature ?? "" }, metadata: { chip: temp.chip, feature: temp.feature ?? "" }, values: temp, keys: monitorObjectMetricKeys, statisticKey: `temperature:${temp.chip}:${temp.feature ?? ""}` }; }),
      ...(sample.payload.candidates ?? []).map(object).filter(candidate => targets!.has(`${candidate.provider}:${candidate.externalId}`)).map(candidate => ({ kind: "deployment", identity: { provider: candidate.provider, externalId: candidate.externalId }, metadata: { provider: candidate.provider, externalId: candidate.externalId, name: candidate.name, group: candidate.group ?? "" }, values: { ...candidate, statusCode: ["unknown", "running", "stopped", "degraded"].indexOf(String(candidate.status)) }, keys: monitorDeploymentMetricKeys, statisticKey: `deployment:${candidate.provider}:${candidate.externalId}`, detail: String(candidate.state ?? "").slice(0, 255) })),
    ];
    const duration = Math.max(1, Math.min(86400, sample.resolutionSeconds));
    const coverage = mergeCoverage(sample.payload.coverage ?? [[at - duration * 1000, at]]);
    if (coverage.length > 2880) throw new Error("监控覆盖区间数量超限");
    let sampleLimited = false;
    for (const entity of entities) {
      const identityJson = json(entity.identity), identityHash = hash(identityJson), metadataJson = json(entity.metadata), metadataHash = hash(metadataJson);
      const seriesBytes = estimatedBytes(Buffer.byteLength(identityJson) + 320);
      const key = `${entity.kind}:${identityHash}`;
      let series = cache.get(key);
      if (!series) {
        const existing = await db.prepare("SELECT id, latest_metadata_id FROM monitor_metric_series WHERE stream_id = ? AND kind = ? AND identity_hash = ?")
          .get<{ id: number; latest_metadata_id: number | null }>(streamId, entity.kind, identityHash);
        if (!existing && (seriesCount >= policy.maxSeriesPerWorkspace || bytes + seriesBytes >= policy.maxBytes * .95)) { sampleLimited = true; continue; }
        if (!existing) {
          const result = await db.prepare("INSERT OR IGNORE INTO monitor_metric_series (stream_id, kind, identity_hash, identity_json, stored_bytes) VALUES (?, ?, ?, ?, ?)").run(streamId, entity.kind, identityHash, identityJson, seriesBytes);
          if (result.changes) { seriesCount++; bytes += seriesBytes; added += seriesBytes; }
        }
        const current = existing ?? (await db.prepare("SELECT id, latest_metadata_id FROM monitor_metric_series WHERE stream_id = ? AND kind = ? AND identity_hash = ?").get<{ id: number; latest_metadata_id: number | null }>(streamId, entity.kind, identityHash))!;
        series = { id: Number(current.id), metadataId: Number(current.latest_metadata_id ?? 0), metadataHash: "" };
        cache.set(key, series);
      }
      if (series.metadataHash !== metadataHash) {
        const previous = await db.prepare("SELECT id FROM monitor_metric_metadata WHERE series_id = ? AND content_hash = ?").get<{ id: number }>(series.id, metadataHash);
        const metadataBytes = estimatedBytes(Buffer.byteLength(metadataJson) + 320);
        if (!previous && bytes + metadataBytes >= policy.maxBytes) { sampleLimited = true; continue; }
        if (!previous) {
          const insert = await db.prepare("INSERT OR IGNORE INTO monitor_metric_metadata (series_id, content_hash, content_json, stored_bytes, last_used_ms) VALUES (?, ?, ?, ?, ?)").run(series.id, metadataHash, metadataJson, metadataBytes, at);
          if (insert.changes) { bytes += metadataBytes; added += metadataBytes; }
        }
        const metadata = previous ?? (await db.prepare("SELECT id FROM monitor_metric_metadata WHERE series_id = ? AND content_hash = ?").get<{ id: number }>(series.id, metadataHash))!;
        series.metadataId = Number(metadata.id); series.metadataHash = metadataHash;
      }
      const point: MetricObject = { series_id: series.id, metadata_id: series.metadataId, tier_seconds: 0, at_ms: at, sequence_end: sample.sequenceEnd,
        resolution_seconds: duration, sample_count: Math.max(1, sample.payload.sampleCount ?? 1), coverage_start_ms: coverage[0]?.[0] ?? at,
        coverage_end_ms: coverage.at(-1)?.[1] ?? at, coverage_json: json(coverage), source_first_ms: coverage[0]?.[0] ?? at,
        source_last_ms: at, state_detail: entity.detail ?? "" };
      const supplied = sample.payload.statistics?.[entity.statisticKey];
      for (const metric of entity.keys) {
        const value = numberAt(entity.values, metric), statistic = supplied?.[metric];
        if (statistic && (!monitorStatisticSuffixes.every(suffix => Number.isFinite(statistic[suffix])) || statistic.weight <= 0 || statistic.min > statistic.max)) throw new Error("监控聚合统计无效");
        if (value === null && !statistic) continue;
        const valid = statistic ?? { sum: value! * duration, min: value!, max: value!, last: value!, weight: duration };
        for (const suffix of monitorStatisticSuffixes) point[`${monitorMetricColumn(metric)}_${suffix}`] = valid[suffix];
      }
      point.stored_bytes = estimatedBytes(320 + Buffer.byteLength(String(point.coverage_json)) + (Object.keys(point).length - metricBaseColumns.length) * 8);
      // Leave room for the aggregation worker so a full raw buffer cannot deadlock retention.
      if (bytes + Number(point.stored_bytes) > policy.maxBytes * .75) { sampleLimited = true; continue; }
      const columns = Object.keys(point);
      const insert = await db.prepare(`INSERT OR IGNORE INTO monitor_metric_points (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => point[column]));
      if (insert.changes) { bytes += Number(point.stored_bytes); added += Number(point.stored_bytes); }
      await db.prepare(`UPDATE monitor_metric_series SET latest_metadata_id = CASE WHEN last_seen_ms <= ? THEN ? ELSE latest_metadata_id END,
        last_seen_ms = ${db.dialect === "mysql" ? "GREATEST" : "MAX"}(last_seen_ms, ?) WHERE id = ?`).run(at, series.metadataId, at, series.id);
      await db.prepare(`UPDATE monitor_metric_metadata SET last_used_ms = ${db.dialect === "mysql" ? "GREATEST" : "MAX"}(last_used_ms, ?) WHERE id = ?`).run(at, series.metadataId);
    }
    if (sampleLimited && migration) throw new Error("MONITOR_MIGRATION_CAPACITY");
    limited ||= sampleLimited;
    const processes = Array.isArray(host.topProcesses) ? host.topProcesses.slice(0, 5) : [];
    if (!migration && at + policy.diagnosticHours * 3600_000 > Date.now() && bytes < policy.maxBytes * .85 && (processes.length || sample.payload.errors?.length)) {
      const diagnostic = Buffer.from(json({ topProcesses: processes, errors: sample.payload.errors ?? [] }));
      if (diagnostic.byteLength <= 64 * 1024) {
        const payload = gzipSync(diagnostic).toString("base64"), cost = estimatedBytes(Buffer.byteLength(payload) + 192);
        if (bytes + cost <= policy.maxBytes && diagnosticBytes + cost <= policy.diagnosticMaxBytes) {
          const result = await db.prepare("INSERT OR IGNORE INTO monitor_metric_diagnostics (stream_id, sequence_end, at_ms, expires_ms, payload_base64, stored_bytes) VALUES (?, ?, ?, ?, ?, ?)")
            .run(streamId, sample.sequenceEnd, at, at + policy.diagnosticHours * 3600_000, payload, cost);
          if (result.changes) { bytes += cost; added += cost; diagnosticBytes += cost; diagnosticAdded += cost; }
        }
      }
    }
    if (!sampleLimited && bytes + 288 <= policy.maxBytes * .80) {
      const ledger = await db.prepare("INSERT OR IGNORE INTO monitor_metric_ingest (stream_id, sequence_end, sequence_start, collected_at_ms) VALUES (?, ?, ?, ?)").run(streamId, sample.sequenceEnd, sample.sequenceStart, at);
      if (ledger.changes) { bytes += 288; added += 288; }
    }
    await db.prepare(`UPDATE monitor_metric_streams SET last_collected_ms = ${db.dialect === "mysql" ? "GREATEST" : "MAX"}(last_collected_ms, ?), ssh_connection_id = ? WHERE id = ?`).run(at, scope.connectionId, streamId);
    stored++;
  }
  if (!migration && samples.length) await db.prepare(`UPDATE monitor_metric_streams SET last_sequence = ${db.dialect === "mysql" ? "GREATEST" : "MAX"}(last_sequence, ?) WHERE id = ?`).run(Math.max(...samples.map(sample => sample.sequenceEnd)), streamId);
  await accountStorage(db, added, diagnosticAdded);
  return { stored, limited, overlap };
}
