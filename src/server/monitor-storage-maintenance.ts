import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { accountStorage, lockStorageBudget, mergeCoverage, metricBaseColumns, metricValueColumns,
  storagePolicy, storeMetricSamples, object, type MetricPoint, type MetricSample } from "./monitor-metric-storage.js";

const maintenanceOwners = new WeakMap<FastifyInstance, string>();
const placeholders = (rows: unknown[]) => rows.map(() => "?").join(",");
const parseRanges = (value: unknown): number[][] => { try { return mergeCoverage(JSON.parse(String(value))); } catch { return []; } };

export function combineMetricPoints(previous: MetricPoint | undefined, incoming: MetricPoint, tier: number): MetricPoint {
  const latest = !previous || incoming.source_last_ms >= previous.source_last_ms;
  const coverage = mergeCoverage([...parseRanges(previous?.coverage_json ?? "[]"), ...parseRanges(incoming.coverage_json)]);
  const point: MetricPoint = { ...incoming, metadata_id: latest ? incoming.metadata_id : previous!.metadata_id,
    tier_seconds: tier, at_ms: Math.floor(incoming.at_ms / (tier * 1000)) * tier * 1000,
    sequence_end: tier === 3600 && incoming.resolution_seconds > 300 ? 1 : 0,
    resolution_seconds: Math.max(incoming.resolution_seconds, previous?.resolution_seconds ?? 0),
    sample_count: incoming.sample_count + (previous?.sample_count ?? 0),
    source_first_ms: Math.min(incoming.source_first_ms, previous?.source_first_ms ?? incoming.source_first_ms),
    source_last_ms: Math.max(incoming.source_last_ms, previous?.source_last_ms ?? 0),
    coverage_start_ms: coverage[0]?.[0] ?? incoming.coverage_start_ms, coverage_end_ms: coverage.at(-1)?.[1] ?? incoming.coverage_end_ms,
    coverage_json: JSON.stringify(coverage), state_detail: latest ? incoming.state_detail : previous!.state_detail };
  for (const column of metricValueColumns) {
    const a = previous?.[column], b = incoming[column];
    point[column] = a == null ? b ?? null : b == null ? a
      : column.endsWith("_min") ? Math.min(Number(a), Number(b))
        : column.endsWith("_max") ? Math.max(Number(a), Number(b))
          : column.endsWith("_last") ? latest ? b : a : Number(a) + Number(b);
  }
  point.stored_bytes = Math.ceil((320 + Buffer.byteLength(point.coverage_json) + metricValueColumns.filter(column => point[column] != null).length * 8) * 1.5);
  return point;
}

/** The pending flag and both rollups are changed in the same transaction; retries cannot double count. */
export async function rollupMetricBatch(app: FastifyInstance, limit = storagePolicy(app).batchSize): Promise<number> {
  return app.db.transaction(async () => {
    const budget = await lockStorageBudget(app.db);
    const raw = await app.db.prepare(`SELECT * FROM monitor_metric_points WHERE tier_seconds = 0 AND rollup_done = 0 ORDER BY id LIMIT ?`).all<MetricPoint>(limit);
    let added = 0;
    for (const source of raw) {
      for (const tier of [300, 3600]) {
        // A coarse source remains coarse. In particular, an hourly probe row cannot masquerade as a five minute row.
        if (tier === 300 && source.resolution_seconds > tier) continue;
        if (tier === 300 && source.at_ms < Date.now() - storagePolicy(app).fiveMinuteDays * 86400_000) continue;
        const at = Math.floor(source.at_ms / (tier * 1000)) * tier * 1000;
        const previous = await app.db.prepare("SELECT * FROM monitor_metric_points WHERE series_id = ? AND tier_seconds = ? AND at_ms = ? AND sequence_end = ?").get<MetricPoint>(source.series_id, tier, at, tier === 3600 && source.resolution_seconds > 300 ? 1 : 0);
        const point = combineMetricPoints(previous, source, tier), delta = point.stored_bytes - Number(previous?.stored_bytes ?? 0);
        if (Number(budget.used_bytes) + added + delta > storagePolicy(app).maxBytes) throw new Error("MONITOR_ROLLUP_CAPACITY");
        const columns = [...metricBaseColumns, ...metricValueColumns];
        await app.db.prepare(`INSERT INTO monitor_metric_points (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
          ON CONFLICT(series_id, tier_seconds, at_ms, sequence_end) DO UPDATE SET ${columns.filter(column => !["series_id", "tier_seconds", "at_ms", "sequence_end"].includes(column)).map(column => `${column} = excluded.${column}`).join(",")}`)
          .run(...columns.map(column => point[column] ?? null));
        added += delta;
      }
      await app.db.prepare("UPDATE monitor_metric_points SET rollup_done = 1 WHERE id = ?").run(source.id);
    }
    await accountStorage(app.db, added);
    return raw.length;
  })();
}

async function deleteMetricBatch(app: FastifyInstance, tier: number, cutoff: number, limit: number): Promise<number> {
  return app.db.transaction(async () => {
    await lockStorageBudget(app.db);
    // Select through the tier/time index, then delete explicit primary keys. Never DELETE ORDER BY a large JSON table.
    const rows = await app.db.prepare(`SELECT id, stored_bytes FROM monitor_metric_points
      WHERE tier_seconds = ? AND at_ms < ? ${tier === 0 ? "AND rollup_done = 1" : ""} ORDER BY at_ms, id LIMIT ?`)
      .all<{ id: number; stored_bytes: number }>(tier, cutoff, limit);
    if (rows.length) {
      await app.db.prepare(`DELETE FROM monitor_metric_points WHERE id IN (${placeholders(rows)})`).run(...rows.map(row => row.id));
      await accountStorage(app.db, -rows.reduce((sum, row) => sum + Number(row.stored_bytes), 0));
    }
    return rows.length;
  })();
}

export async function cleanupMetricStorage(app: FastifyInstance, now = Date.now()): Promise<number> {
  const policy = storagePolicy(app), limit = policy.batchSize;
  let removed = 0;
  for (const [tier, age] of [[0, policy.rawHours * 3600_000], [300, policy.fiveMinuteDays * 86400_000], [3600, policy.hourlyDays * 86400_000]]) {
    removed += await deleteMetricBatch(app, tier!, now - age!, limit);
  }
  await app.db.transaction(async () => {
    const budget = await lockStorageBudget(app.db);
    const diagnostics = await app.db.prepare(`SELECT stream_id, sequence_end, stored_bytes FROM monitor_metric_diagnostics WHERE expires_ms < ? ORDER BY expires_ms LIMIT ?`).all<{ stream_id: number; sequence_end: number; stored_bytes: number }>(now, limit);
    if (diagnostics.length) {
      await app.db.prepare(`DELETE FROM monitor_metric_diagnostics WHERE ${diagnostics.map(() => "(stream_id = ? AND sequence_end = ?)").join(" OR ")}`).run(...diagnostics.flatMap(row => [row.stream_id, row.sequence_end]));
      const bytes = diagnostics.reduce((sum, row) => sum + Number(row.stored_bytes), 0);
      await accountStorage(app.db, -bytes, -bytes); removed += diagnostics.length;
    }
    const metadata = await app.db.prepare(`SELECT m.id, m.stored_bytes FROM monitor_metric_metadata m WHERE m.last_used_ms < ?
      AND NOT EXISTS (SELECT 1 FROM monitor_metric_points p WHERE p.metadata_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM monitor_metric_series s WHERE s.latest_metadata_id = m.id) ORDER BY m.last_used_ms LIMIT ?`).all<{ id: number; stored_bytes: number }>(now - policy.rawHours * 3600_000, limit);
    if (metadata.length) {
      await app.db.prepare(`DELETE FROM monitor_metric_metadata WHERE id IN (${placeholders(metadata)})`).run(...metadata.map(row => row.id));
      await accountStorage(app.db, -metadata.reduce((sum, row) => sum + Number(row.stored_bytes), 0)); removed += metadata.length;
    }
    // At capacity, shorten the oldest processed raw history first. Aggregates and latest host state survive.
    if (Number(budget.used_bytes) > policy.maxBytes * .70) {
      const ordinary = await app.db.prepare(`SELECT stream_id, sequence_end, stored_bytes FROM monitor_metric_diagnostics WHERE at_ms < ?
        AND expires_ms - at_ms <= ? ORDER BY at_ms LIMIT ?`).all<{ stream_id: number; sequence_end: number; stored_bytes: number }>(now-300000, policy.diagnosticHours*3600_000, limit);
      if (ordinary.length) {
        await app.db.prepare(`DELETE FROM monitor_metric_diagnostics WHERE ${ordinary.map(() => "(stream_id = ? AND sequence_end = ?)").join(" OR ")}`).run(...ordinary.flatMap(row => [row.stream_id,row.sequence_end]));
        const bytes = ordinary.reduce((sum, row) => sum+Number(row.stored_bytes),0); await accountStorage(app.db,-bytes,-bytes); removed += ordinary.length;
      }
      const cold = await app.db.prepare(`SELECT id, stored_bytes FROM monitor_metric_points WHERE tier_seconds = 0 AND rollup_done = 1 AND at_ms < ? ORDER BY at_ms, id LIMIT ?`)
        .all<{ id: number; stored_bytes: number }>(now - 3600_000, limit);
      if (cold.length) {
        await app.db.prepare(`DELETE FROM monitor_metric_points WHERE id IN (${placeholders(cold)})`).run(...cold.map(row => row.id));
        await accountStorage(app.db, -cold.reduce((sum, row) => sum + Number(row.stored_bytes), 0)); removed += cold.length;
      }
    }
  })();
  const pressure = await app.db.prepare("SELECT used_bytes FROM monitor_storage_state WHERE state_key = 'budget'").get<{ used_bytes: number }>();
  if (Number(pressure?.used_bytes ?? 0) > policy.maxBytes * .70) removed += await deleteMetricBatch(app, 300, now - 86400_000, limit);
  const remaining = await app.db.prepare("SELECT used_bytes FROM monitor_storage_state WHERE state_key = 'budget'").get<{ used_bytes: number }>();
  if (Number(remaining?.used_bytes ?? 0) > policy.maxBytes * .70) removed += await deleteMetricBatch(app, 3600, now - 30 * 86400_000, limit);
  await app.db.transaction(async () => {
    await lockStorageBudget(app.db);
    const ledger = await app.db.prepare(`SELECT i.stream_id, i.sequence_end, i.stored_bytes FROM monitor_metric_ingest i JOIN monitor_metric_streams t ON t.id = i.stream_id
      WHERE i.collected_at_ms < ? AND NOT EXISTS (SELECT 1 FROM monitor_samples old JOIN ssh_connections c ON c.id = old.ssh_connection_id
        WHERE c.workspace_type = t.workspace_type AND c.workspace_id = t.workspace_id AND old.agent_id = t.agent_id)
      ORDER BY i.collected_at_ms LIMIT ?`).all<{ stream_id: number; sequence_end: number; stored_bytes: number }>(now - policy.rawHours * 3600_000, limit);
    if (ledger.length) {
      await app.db.prepare(`DELETE FROM monitor_metric_ingest WHERE ${ledger.map(() => "(stream_id = ? AND sequence_end = ?)").join(" OR ")}`).run(...ledger.flatMap(row => [row.stream_id, row.sequence_end]));
      await accountStorage(app.db, -ledger.reduce((sum, row) => sum + Number(row.stored_bytes), 0)); removed += ledger.length;
    }
  })();
  await app.db.transaction(async () => {
    await lockStorageBudget(app.db);
    const stale = await app.db.prepare(`SELECT s.id, s.stored_bytes FROM monitor_metric_series s WHERE s.last_seen_ms < ? AND NOT EXISTS
      (SELECT 1 FROM monitor_metric_points p WHERE p.series_id = s.id) ORDER BY s.last_seen_ms LIMIT ?`).all<{ id: number; stored_bytes: number }>(now - policy.hourlyDays * 86400_000, limit);
    if (stale.length) {
      const metadata = await app.db.prepare(`SELECT COALESCE(SUM(stored_bytes),0) AS bytes FROM monitor_metric_metadata WHERE series_id IN (${placeholders(stale)})`).get<{ bytes: number }>(...stale.map(row => row.id));
      await app.db.prepare(`DELETE FROM monitor_metric_series WHERE id IN (${placeholders(stale)})`).run(...stale.map(row => row.id));
      await accountStorage(app.db, -Number(metadata?.bytes ?? 0) - stale.reduce((sum, row) => sum + Number(row.stored_bytes), 0)); removed += stale.length;
    }
    const streams = await app.db.prepare(`SELECT t.id FROM monitor_metric_streams t WHERE t.last_collected_ms < ?
      AND NOT EXISTS (SELECT 1 FROM monitor_metric_series s WHERE s.stream_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM monitor_metric_ingest i WHERE i.stream_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM monitor_metric_diagnostics d WHERE d.stream_id = t.id) ORDER BY t.last_collected_ms LIMIT ?`).all<{ id: number }>(now - policy.hourlyDays * 86400_000, limit);
    if (streams.length) {
      await app.db.prepare(`DELETE FROM monitor_metric_streams WHERE id IN (${placeholders(streams)})`).run(...streams.map(row => row.id));
      await accountStorage(app.db, -streams.length * 512); removed += streams.length;
    }
  })();
  const cutoff = new Date(now - policy.alertDays * 86400_000).toISOString();
  for (const status of ["recovered", "event"]) {
    const alerts = await app.db.prepare(`SELECT id FROM monitor_alerts WHERE status = ? AND last_seen_at < ?
      AND COALESCE(NULLIF(recovered_at,''), NULLIF(last_seen_at,''), triggered_at) < ? ORDER BY last_seen_at, id LIMIT ?`).all<{ id: string }>(status, cutoff, cutoff, limit);
    if (alerts.length) { await app.db.prepare(`DELETE FROM monitor_alerts WHERE status <> 'active' AND id IN (${placeholders(alerts)})`).run(...alerts.map(row => row.id)); removed += alerts.length; }
  }
  const gaps = await app.db.prepare("SELECT ssh_connection_id, agent_id, sequence_end FROM monitor_sequence_gaps WHERE ended_at < ? ORDER BY ended_at LIMIT ?")
    .all<{ ssh_connection_id: string; agent_id: string; sequence_end: number }>(new Date(now - policy.hourlyDays * 86400_000).toISOString(), limit);
  for (const gap of gaps) await app.db.prepare("DELETE FROM monitor_sequence_gaps WHERE ssh_connection_id = ? AND agent_id = ? AND sequence_end = ?").run(gap.ssh_connection_id, gap.agent_id, gap.sequence_end);
  removed += gaps.length;
  return removed;
}

/** One legacy row at a time keeps memory bounded even when old inventories contain thousands of candidates. */
export async function migrateLegacyMetricBatch(app: FastifyInstance, limit = 2): Promise<number> {
  const connection = await app.db.prepare("SELECT ssh_connection_id FROM monitor_samples LIMIT 1").get<{ ssh_connection_id: string }>();
  if (!connection) return 0;
  const keys = await app.db.prepare(`SELECT ssh_connection_id, agent_id, sequence_end FROM monitor_samples WHERE ssh_connection_id = ? ORDER BY collected_at LIMIT ?`).all<{ ssh_connection_id: string; agent_id: string; sequence_end: number }>(connection.ssh_connection_id, limit);
  let migrated = 0;
  for (const key of keys) {
    await app.db.transaction(async () => {
      const row = await app.db.prepare(`SELECT s.*, c.workspace_type, c.workspace_id FROM monitor_samples s JOIN ssh_connections c ON c.id = s.ssh_connection_id WHERE s.ssh_connection_id = ? AND s.agent_id = ? AND s.sequence_end = ?`).get<Record<string, unknown>>(key.ssh_connection_id, key.agent_id, key.sequence_end);
      if (!row) return;
      const payload = object(JSON.parse(String(row.payload_json)));
      if (!payload.host) throw new Error("MONITOR_LEGACY_INVALID_SAMPLE");
      const sample: MetricSample = { sequenceStart: Number(row.sequence_start), sequenceEnd: Number(row.sequence_end), collectedAt: String(row.collected_at), resolutionSeconds: Number(row.resolution_seconds), payload: payload as MetricSample["payload"] };
      await storeMetricSamples(app, { workspaceType: String(row.workspace_type), workspaceId: String(row.workspace_id), agentId: key.agent_id, connectionId: key.ssh_connection_id }, [sample], undefined, true);
      // Readers can use pending raw points at any age until the aggregation job commits.
      const connections = await app.db.prepare("SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?").all<{ id: string }>(row.workspace_type, row.workspace_id);
      for (let index = 0; index < connections.length; index += 100) {
        const batch = connections.slice(index, index+100);
        await app.db.prepare(`DELETE FROM monitor_samples WHERE ${batch.map(() => "(ssh_connection_id = ? AND agent_id = ? AND sequence_end = ?)").join(" OR ")}`)
          .run(...batch.flatMap(alias => [alias.id, key.agent_id, key.sequence_end]));
      }
      migrated++;
    })();
  }
  return migrated;
}

export async function runMonitorStorageMaintenance(app: FastifyInstance, shouldStop = () => false): Promise<boolean> {
  const policy = storagePolicy(app), now = Date.now(), owner = maintenanceOwners.get(app) ?? randomUUID();
  maintenanceOwners.set(app, owner);
  const leased = await app.db.transaction(async () => {
    await lockStorageBudget(app.db);
    await app.db.prepare("INSERT OR IGNORE INTO monitor_storage_state (state_key, value_json) VALUES ('maintenance', '{}')").run();
    const result = await app.db.prepare(`UPDATE monitor_storage_state SET lease_owner = ?, lease_until_ms = ? WHERE state_key = 'maintenance' AND lease_until_ms < ?`)
      .run(owner, now + Math.max(120_000, policy.maintenanceBudgetMs * 4), now);
    return result.changes > 0;
  })();
  if (!leased) return false;
  let lastError: string | null = null;
  try {
    const deadline = now + Math.min(30_000, policy.maintenanceBudgetMs);
    // Cleanup is independent of successful pulls, and gets time before migration.
    do {
      const cleaned = await cleanupMetricStorage(app);
      if (!cleaned || shouldStop() || Date.now() >= deadline) break;
    } while (true);
    while (!shouldStop() && Date.now() < deadline) {
      if (await rollupMetricBatch(app) > 0) continue;
      if (await migrateLegacyMetricBatch(app) === 0) break;
    }
  } catch (error) {
    // Never expose SQL, internal addresses or credentials in the public status.
    lastError = error instanceof Error && error.message.includes("CAPACITY") ? "监控存储容量不足，历史处理已暂停" : "监控历史维护失败，请检查服务端日志";
    app.log.error({ err: error }, "monitor storage maintenance failed");
  } finally {
    await app.db.prepare(`UPDATE monitor_storage_state SET value_json = ?, lease_owner = '', lease_until_ms = 0, updated_ms = ? WHERE state_key = 'maintenance' AND lease_owner = ?`)
      .run(JSON.stringify({ lastMaintenanceAt: new Date().toISOString(), lastError }), Date.now(), owner);
  }
  return true;
}

export function startMonitorStorageMaintenance(app: FastifyInstance): () => Promise<void> {
  // Fixtures run the maintenance functions explicitly and must remain deterministic.
  if (app.config.nodeEnv === "test") return async () => {};
  let stopped = false, current: Promise<unknown> | null = null, dueAt = 0;
  const tick = () => {
    if (!current && !stopped && Date.now() >= dueAt) current = (async () => {
      try {
        await runMonitorStorageMaintenance(app, () => stopped);
        const state = await app.db.prepare("SELECT value_json FROM monitor_storage_state WHERE state_key = 'maintenance'").get<{ value_json: string }>();
        const failed = object(JSON.parse(state?.value_json ?? "{}")).lastError;
        const pending = !failed && await app.db.prepare("SELECT id FROM monitor_metric_points WHERE tier_seconds = 0 AND rollup_done = 0 LIMIT 1").get();
        // Drain an aggregation backlog in bounded slices without waiting a full idle interval.
        dueAt = Date.now() + (pending ? 10000 : storagePolicy(app).maintenanceIntervalSeconds * 1000);
      } catch (error) {
        dueAt = Date.now() + storagePolicy(app).maintenanceIntervalSeconds * 1000;
        app.log.error({ err: error }, "monitor maintenance could not start");
      }
    })().finally(() => { current = null; });
  };
  const timer = setInterval(tick, 10000);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await current; };
}
