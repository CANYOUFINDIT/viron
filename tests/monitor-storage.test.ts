import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/database.js";
import { storeMetricSamples, loadMonitorStorageStatus, type MetricSample, type MetricScope } from "../src/server/monitor-metric-storage.js";
import { cleanupMetricStorage, migrateLegacyMetricBatch, rollupMetricBatch, runMonitorStorageMaintenance } from "../src/server/monitor-storage-maintenance.js";
import { readMetricSamples } from "../src/server/monitor-metric-reader.js";
import { monitoringTestConfig } from "./helpers/monitoring-harness.js";

const resources: Array<{ app: FastifyInstance; directory: string }> = [];
afterEach(async () => { for (const { app, directory } of resources.splice(0)) { await app.db.close(); await app.close(); rmSync(directory, { recursive: true, force: true }); } });
async function fixture(policy = {}) {
  const directory = mkdtempSync(join(tmpdir(), "viron-metric-storage-")), config = { ...monitoringTestConfig(directory), monitorStoragePolicy: policy };
  const db = await openDatabase(config), app = Fastify({ logger: false });
  app.decorate("config", config); app.decorate("db", db); resources.push({ app, directory });
  const scope: MetricScope = { workspaceType: "personal", workspaceId: randomUUID(), agentId: randomUUID(), connectionId: randomUUID() };
  await connection(app, scope);
  return { app, scope };
}
async function connection(app: FastifyInstance, scope: MetricScope) {
  const now = new Date().toISOString();
  await app.db.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, credential_ciphertext, options_json, tags_json, workspace_type, workspace_id, created_at, updated_at)
    VALUES (?, 'Storage test', '127.0.0.1', 22, 'test', '', '{}', '[]', ?, ?, ?, ?)`).run(scope.connectionId, scope.workspaceType, scope.workspaceId, now, now);
}
function sample(sequence: number, at: number, cpu = 10, resolution = 30): MetricSample {
  return { sequenceStart: sequence, sequenceEnd: sequence, collectedAt: new Date(at).toISOString(), resolutionSeconds: resolution, payload: {
    sampleCount: 1, host: { hostname: "test-host", cpuCount: 4, cpuUsedPercent: cpu, memoryUsedPercent: 50,
      memoryTotalBytes: 1000, memoryUsedBytes: 500, uptimeSeconds: sequence * 30, load1: 1, load5: 1, load15: 1,
      disks: [{ path: "/", device: "disk0", filesystem: "ext4", totalBytes: 1000, usedBytes: sequence, freeBytes: 1000-sequence, usedPercent: sequence/10 }], temperatures: [],
      topProcesses: [{ pid: sequence, name: "test-process", cpuUsedPercent: cpu, memoryBytes: 30 }] },
    candidates: [{ provider: "systemd", externalId: "managed.service", name: "Managed", status: "running", state: "active", pid: sequence, cpuUsedPercent: cpu, memoryBytes: sequence * 10 },
      { provider: "process", externalId: `ephemeral-${sequence}`, name: "Ephemeral", status: "running", state: "active", cpuUsedPercent: 1, memoryBytes: 1 }],
  } };
}
const write = (app: FastifyInstance, scope: MetricScope, samples: MetricSample[], targets = new Set(["systemd:managed.service"])) => app.db.transaction(() => storeMetricSamples(app, scope, samples, targets))();
const read = (app: FastifyInstance, scope: MetricScope, range: "1h" | "7d" | "90d" = "1h", from = Date.now()-3600_000) => readMetricSamples(app, { ...scope, agentIds: [scope.agentId], range, from, to: Date.now() });

describe("monitor metric storage", () => {
  it("atomically rolls back both aggregate tiers and the checkpoint after a worker write failure", async () => {
    const { app, scope } = await fixture(); await write(app, scope, [sample(1, Date.now()-30000)]);
    const prepare = app.db.prepare.bind(app.db);
    const failure = vi.spyOn(app.db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (!sql.startsWith("INSERT INTO monitor_metric_points")) return statement;
      return { ...statement, run: async (...parameters) => {
        if (parameters[2] === 3600) throw new Error("simulated worker interruption");
        return statement.run(...parameters);
      } };
    });
    try { await expect(rollupMetricBatch(app)).rejects.toThrow("interruption"); } finally { failure.mockRestore(); }
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE tier_seconds > 0").get()).toEqual({ count: 0 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE rollup_done = 0").get()).toEqual({ count: 3 });
    expect(await rollupMetricBatch(app)).toBe(3);
    expect(await rollupMetricBatch(app)).toBe(0);
  });
  it("respects another server's live maintenance lease and resumes after its expiration", async () => {
    const { app } = await fixture();
    await app.db.prepare("INSERT INTO monitor_storage_state (state_key, value_json, lease_owner, lease_until_ms) VALUES ('maintenance','{}','other-server',?)").run(Date.now()+60000);
    expect(await runMonitorStorageMaintenance(app)).toBe(false);
    await app.db.prepare("UPDATE monitor_storage_state SET lease_until_ms = 0 WHERE state_key = 'maintenance'").run();
    expect(await runMonitorStorageMaintenance(app)).toBe(true);
  });
  it("stores managed numeric metrics and static metadata once, deduplicating aliases within a workspace", async () => {
    const { app, scope } = await fixture(), now = Date.now()-60_000;
    await write(app, scope, [sample(1, now), sample(2, now+30_000, 90)]);
    const alias = { ...scope, connectionId: randomUUID() }; await connection(app, alias);
    await write(app, alias, [sample(1, now), sample(2, now+30_000)]);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_samples").get()).toEqual({ count: 0 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE tier_seconds = 0").get()).toEqual({ count: 6 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_metadata").get()).toEqual({ count: 3 });
    const other = { ...scope, workspaceId: randomUUID(), connectionId: randomUUID() }; await connection(app, other);
    await write(app, other, [sample(1, now, 42)]);
    expect((await read(app, scope)).rows.map(row => JSON.parse(row.payload_json).host.cpuUsedPercent)).toEqual([10, 90]);
    expect(JSON.parse((await read(app, other)).rows[0]!.payload_json).host.cpuUsedPercent).toBe(42);
    expect((await loadMonitorStorageStatus(app)).usedBytes).toBeGreaterThan(0);
  });
  it("preserves weighted extrema, counters, late timestamps and internal gaps without counting retries twice", async () => {
    const { app, scope } = await fixture();
    const base = Math.floor((Date.now()-1200_000)/3600_000)*3600_000;
    await write(app, scope, [sample(1, base+30_000, 10), sample(2, base+90_000, 100, 60), sample(3, base+180_000, 20)]);
    expect(await rollupMetricBatch(app)).toBe(9);
    expect(await rollupMetricBatch(app)).toBe(0);
    // Event time is late, while the agent sequence remains monotonic.
    await write(app, scope, [sample(4, base+120_000, 50)]); await rollupMetricBatch(app);
    const raw = await read(app, scope, "7d", base-1000), payload = JSON.parse(raw.rows[0]!.payload_json);
    expect(payload.host.cpuUsedPercent).toBeCloseTo(56);
    expect(payload.statistics.host.cpuUsedPercent).toMatchObject({ min: 10, max: 100, last: 20, weight: 150, sum: 8400 });
    expect(payload.host.uptimeSeconds).toBe(90); // Last by event time, not the order of ingestion.
    expect(raw.gaps.some(gap => gap.startedAt === new Date(base+120_000).toISOString())).toBe(true);
  });
  it("keeps coarse source precision and supplied peaks through rollup and raw expiration", async () => {
    const { app, scope } = await fixture({ rawHours: 1 });
    const now = Date.now(), point = sample(1, now-2*3600_000, 30, 3600);
    point.payload.sampleCount = 120;
    point.payload.statistics = { host: { cpuUsedPercent: { sum: 108000, min: 2, max: 98, last: 10, weight: 3600 } } };
    await write(app, scope, [point]); await rollupMetricBatch(app); await cleanupMetricStorage(app);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE tier_seconds = 300").get()).toEqual({ count: 0 });
    const history = await read(app, scope, "7d", now-3*3600_000);
    expect(history.rows).toHaveLength(1);
    expect(JSON.parse(history.rows[0]!.payload_json)).toMatchObject({ resolutionSeconds: 3600, statistics: { host: { cpuUsedPercent: { max: 98 } } } });
    const bytes = (await loadMonitorStorageStatus(app)).usedBytes;
    await write(app, scope, [point]);
    expect((await loadMonitorStorageStatus(app)).usedBytes).toBe(bytes);
  });
  it("rolls back failed migrations and resumes without losing legacy history", async () => {
    const { app, scope } = await fixture({ maxBytes: 1000 }), point = sample(1, Date.now()-30000);
    await app.db.prepare(`INSERT INTO monitor_samples (ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at, resolution_seconds, payload_json, received_at) VALUES (?, ?, 1, 1, ?, 30, ?, ?)`)
      .run(scope.connectionId, scope.agentId, point.collectedAt, JSON.stringify(point.payload), point.collectedAt);
    await expect(migrateLegacyMetricBatch(app)).rejects.toThrow("CAPACITY");
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_samples").get()).toEqual({ count: 1 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points").get()).toEqual({ count: 0 });
    app.config.monitorStoragePolicy = { maxBytes: 1024**2 };
    expect(await migrateLegacyMetricBatch(app)).toBe(1); await rollupMetricBatch(app);
    expect(await migrateLegacyMetricBatch(app)).toBe(0);
    expect(JSON.parse((await read(app, scope)).rows[0]!.payload_json).host.cpuUsedPercent).toBe(10);
  });
  it("bounds admission and diagnostics without deleting latest state, and runs when no hosts can be pulled", async () => {
    const { app, scope } = await fixture({ maxBytes: 20000, diagnosticMaxBytes: 500, maxSeriesPerWorkspace: 2 });
    const result = await write(app, scope, Array.from({ length: 25 }, (_, i) => sample(i+1, Date.now()-3600_000+i*30_000)));
    expect(result.limited).toBe(true);
    expect((await loadMonitorStorageStatus(app)).usedBytes).toBeLessThanOrEqual(20000);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_series").get()).toEqual({ count: 2 });
    expect((await app.db.prepare("SELECT COALESCE(SUM(stored_bytes),0) AS bytes FROM monitor_metric_diagnostics").get<{ bytes: number }>())!.bytes).toBeLessThanOrEqual(500);
    await runMonitorStorageMaintenance(app);
    expect((await loadMonitorStorageStatus(app)).lastMaintenanceAt).toBeTruthy();
  });
  it("marks a partially overlapping probe compaction instead of counting its acknowledged prefix again", async () => {
    const { app, scope } = await fixture();
    const at = Date.now()-60000;
    await write(app, scope, [sample(1, at)]);
    const compacted = sample(2, at+30000, 50, 60); compacted.sequenceStart = 1; compacted.payload.sampleCount = 2;
    expect((await write(app, scope, [compacted])).overlap).toBe(true);
    expect((await read(app, scope)).sourceSampleCount).toBe(1);
  });
  it("expires history at each tier and reclaims inactive series, while retaining active alerts", async () => {
    const { app, scope } = await fixture({ rawHours: 1, fiveMinuteDays: 1, hourlyDays: 3 });
    const environmentId = randomUUID(), ancient = new Date(Date.now()-400*86400_000).toISOString();
    await app.db.prepare(`INSERT INTO environments (id, name, workspace_type, workspace_id, description, tags_json, created_at, updated_at) VALUES (?, 'Retention test', 'personal', ?, '', '[]', ?, ?)`)
      .run(environmentId, scope.workspaceId, ancient, ancient);
    for (const status of ["active", "recovered"]) await app.db.prepare(`INSERT INTO monitor_alerts (id, environment_id, target_type, target_id, rule_type, environment_name, status, triggered_at, recovered_at, last_seen_at, created_at, updated_at)
      VALUES (?, ?, 'host', ?, 'cpu', 'Retention test', ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), environmentId, scope.agentId, status, ancient, status === "active" ? null : ancient, ancient, ancient, ancient);
    await write(app, scope, [sample(1, Date.now()-2*86400_000), sample(2, Date.now()-2*3600_000)]);
    await rollupMetricBatch(app); await cleanupMetricStorage(app);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE tier_seconds = 0").get()).toEqual({ count: 0 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE tier_seconds = 300").get()).toEqual({ count: 3 });
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE tier_seconds = 3600").get()).toEqual({ count: 6 });
    expect((await read(app, scope, "90d", Date.now()-3*86400_000)).rows).toHaveLength(2);
    expect(await app.db.prepare("SELECT status FROM monitor_alerts").all()).toEqual([{ status: "active" }]);
    await cleanupMetricStorage(app, Date.now()+4*86400_000);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_series").get()).toEqual({ count: 0 });
  });
});
