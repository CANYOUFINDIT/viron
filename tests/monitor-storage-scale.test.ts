import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/database.js";
import { loadMonitorStorageStatus, storeMetricSamples, type MetricSample, type MetricScope } from "../src/server/monitor-metric-storage.js";
import { cleanupMetricStorage, rollupMetricBatch } from "../src/server/monitor-storage-maintenance.js";
import { readMetricSamples } from "../src/server/monitor-metric-reader.js";
import { monitorHostMetricKeys } from "../src/shared/monitor-storage.js";
import { monitoringTestConfig } from "./helpers/monitoring-harness.js";

const scaleIt = process.env.VIRON_MONITOR_SCALE_TEST === "1" ? it : it.skip;
describe("monitor metric scale", () => {
  for (const hosts of [100, 1000]) scaleIt(`${hosts} hosts: bounded retention and numeric queries with eight objects per host`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-storage-scale-")), config = monitoringTestConfig(directory);
    const db = await openDatabase(config), app = Fastify({ logger: false }); app.decorate("db", db); app.decorate("config", config);
    const clock = Date.now(), scopes: MetricScope[] = [], targets = new Set(Array.from({ length: 5 }, (_, i) => `systemd:managed-${i}`));
    try {
      const workspace = randomUUID();
      await db.transaction(async () => {
        for (let i = 0; i < hosts; i++) {
          const scope = { workspaceType: "personal", workspaceId: workspace, agentId: randomUUID(), connectionId: randomUUID() }; scopes.push(scope);
          await db.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, credential_ciphertext, options_json, tags_json, workspace_type, workspace_id, created_at, updated_at)
            VALUES (?, 'Fictional benchmark host', '127.0.0.1', 22, 'test', '', '{}', '[]', 'personal', ?, ?, ?)`)
            .run(scope.connectionId, workspace, new Date(clock).toISOString(), new Date(clock).toISOString());
        }
      })();
      const baseHost: Record<string, unknown> = { hostname: "fictional-node", metricsVersion: 2 };
      for (const key of monitorHostMetricKeys) {
        const parts = key.split(".");
        if (parts.length === 2) { baseHost[parts[0]!] ??= {}; (baseHost[parts[0]!] as Record<string,unknown>)[parts[1]!] = 1; }
        else baseHost[key] = 10;
      }
      baseHost.disks = [{ path: "/", device: "disk0", filesystem: "ext4", totalBytes: 1000000, usedBytes: 500000, freeBytes: 500000, usedPercent: 50 }];
      baseHost.temperatures = [{ chip: "fictional", feature: "core", celsius: 40, maximum: 80 }];
      const candidates = Array.from({ length: 5 }, (_, i) => ({ provider: "systemd", externalId: `managed-${i}`, name: `Managed ${i}`, cpuUsedPercent: i, memoryBytes: i*10000, restartCount: 1, uptimeSeconds: 100, status: "running", state: "active" }));
      const started = performance.now();
      for (const scope of scopes) {
        const samples: MetricSample[] = [31*86400_000, 3*86400_000, 3600_000, 30000].map((age, i) => ({
          sequenceStart: i+1, sequenceEnd: i+1, collectedAt: new Date(clock-age).toISOString(), resolutionSeconds: 30,
          payload: { sampleCount: 1, host: { ...baseHost, cpuUsedPercent: i === 2 ? 99 : 10 }, candidates },
        }));
        await db.transaction(() => storeMetricSamples(app, scope, samples, targets))();
      }
      const ingestMs = performance.now()-started, rollupStart = performance.now();
      while (await rollupMetricBatch(app, 100)) { /* bounded independent transactions */ }
      while (await cleanupMetricStorage(app, clock)) { /* verify full retention drain */ }
      const rollupAndCleanupMs = performance.now()-rollupStart;
      const queryStart = performance.now();
      const result = await readMetricSamples(app, { ...scopes[0]!, agentIds: [scopes[0]!.agentId], range: "90d", from: clock-90*86400_000, to: clock });
      const queryMs = performance.now()-queryStart;
      expect(result.sourceSampleCount).toBe(4);
      expect(result.rows.length).toBeGreaterThanOrEqual(3);
      expect(result.rows.length).toBeLessThanOrEqual(4);
      expect(result.rows.some(row => JSON.parse(row.payload_json).statistics.host.cpuUsedPercent.max === 99)).toBe(true);
      const raw = await db.prepare("SELECT COUNT(*) AS count FROM monitor_metric_points WHERE tier_seconds = 0").get<{ count: number }>();
      expect(raw!.count).toBe(hosts*8*2);
      const before = (await loadMonitorStorageStatus(app)).usedBytes;
      expect(before).toBeLessThan(10*1024**3);
      await cleanupMetricStorage(app, clock+181*86400_000);
      while (await cleanupMetricStorage(app, clock+181*86400_000)) { /* expire all fixture data */ }
      expect((await loadMonitorStorageStatus(app)).usedBytes).toBe(0);
      const reportDirectory = join(process.cwd(), "private", "monitor-offline-investigation"); mkdirSync(reportDirectory, { recursive: true });
      writeFileSync(join(reportDirectory, `storage-scale-${hosts}.json`), JSON.stringify({ hosts, objectsPerHost: 8, samplesPerHost: 4,
        fullHostMetricFields: monitorHostMetricKeys.length, ingestMs, rollupAndCleanupMs, queryMs, estimatedLiveBytes: before,
        environment: { platform: process.platform, arch: process.arch, database: "sqlite" },
        note: "Four sparse source windows at 31 days, 3 days, 1 hour and 30 seconds. Not a sustained production throughput test." }, null, 2));
    } finally { vi.restoreAllMocks(); await db.close(); await app.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 120000);
});
