import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import type { EnvmanDatabase } from "../src/server/database.js";
import { monitoringTestConfig, runMonitoringContractSuite } from "./helpers/monitoring-harness.js";
import { loadMonitorHostEventCalendar, loadPlatformEventCalendar, loadPlatformEvents } from "../src/server/monitor-event-calendar.js";
import Fastify from "fastify";
import { accountStorage, lockStorageBudget, storeMetricSamples } from "../src/server/monitor-metric-storage.js";
import { readMetricSamples } from "../src/server/monitor-metric-reader.js";
import { cleanupMetricStorage, migrateLegacyMetricBatch, rollupMetricBatch } from "../src/server/monitor-storage-maintenance.js";

const enabled = process.env.VIRON_MONITOR_MYSQL_TEST === "1";
const mysqlIt = enabled ? it : it.skip;
const directory = mkdtempSync(join(tmpdir(), "viron-monitor-mysql-"));
const containerName = `viron-monitor-mysql-${process.pid}`;
const externalHost = process.env.VIRON_MONITOR_MYSQL_HOST;
const port = Number(process.env.VIRON_MONITOR_MYSQL_PORT ?? 13318);
let dockerStarted = false;
let db: EnvmanDatabase | undefined;

async function waitForMysql(timeoutMs = 60000): Promise<void> {
  const mysql = await import("mysql2/promise");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const connection = await mysql.createConnection({
        host: externalHost || "127.0.0.1",
        port,
        user: "root",
        password: "test",
        database: "viron_monitor",
      });
      await connection.query("SELECT 1");
      await connection.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("MariaDB container did not become ready");
}

beforeAll(async () => {
  if (!enabled) return;
  if (!externalHost) {
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // container may not exist
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", [
        "run", "-d", "--name", containerName,
        "-e", "MYSQL_ROOT_PASSWORD=test",
        "-e", "MYSQL_DATABASE=viron_monitor",
        "-p", `${port}:3306`,
        "mariadb:11.4",
      ], { stdio: "inherit" });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker run exited ${code}`)));
      child.on("error", reject);
    });
    dockerStarted = true;
  }
  await waitForMysql();
  const config = monitoringTestConfig(directory, { host: externalHost || "127.0.0.1", port, database: "viron_monitor" });
  db = await openDatabase(config);
  await ensureAdmin(db, config);
}, 120_000);

afterAll(async () => {
  await db?.close();
  if (dockerStarted) {
    try { execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch { /* ignore */ }
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("monitoring MariaDB equivalence", () => {
  mysqlIt("serializes concurrent storage accounting without upgrading shared duplicate-key locks", async () => {
    const database = db!;
    await database.prepare("INSERT OR IGNORE INTO monitor_storage_state (state_key, value_json) VALUES ('budget', '{}')").run();
    const before = await database.prepare("SELECT used_bytes FROM monitor_storage_state WHERE state_key = 'budget'").get<{ used_bytes: number }>();
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let round = 0; round < 10; round++) {
        await database.transaction(async () => {
          await lockStorageBudget(database);
          await accountStorage(database, 1);
        })();
      }
    }));
    expect(await database.prepare("SELECT used_bytes FROM monitor_storage_state WHERE state_key = 'budget'").get())
      .toEqual({ used_bytes: Number(before?.used_bytes ?? 0) + 80 });
  });
  mysqlIt("stores and reads idempotent weighted numeric rollups with source precision and metadata", async () => {
    const config = monitoringTestConfig(directory, { host: externalHost || "127.0.0.1", port, database: "viron_monitor" });
    const database = await openDatabase(config), app = Fastify({ logger: false }); app.decorate("db", database); app.decorate("config", config);
    try {
      const scope = { workspaceType: "personal", workspaceId: randomUUID(), agentId: randomUUID(), connectionId: randomUUID() };
      const at = Math.floor((Date.now()-600000)/3600000)*3600000+60000;
      await database.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, credential_ciphertext, options_json, tags_json, workspace_type, workspace_id, created_at, updated_at)
        VALUES (?, 'Numeric test', '127.0.0.1', 22, 'test', '', '{}', '[]', 'personal', ?, ?, ?)`)
        .run(scope.connectionId, scope.workspaceId, new Date().toISOString(), new Date().toISOString());
      const points = [10, 90].map((cpu, i) => ({ sequenceStart: i+1, sequenceEnd: i+1, collectedAt: new Date(at+i*30000).toISOString(), resolutionSeconds: 30,
        payload: { sampleCount: 1, host: { hostname: "numeric", cpuCount: 4, cpuUsedPercent: cpu, memoryUsedPercent: 50, uptimeSeconds: 100+i, disks: [], temperatures: [] }, candidates: [] } }));
      await database.transaction(() => storeMetricSamples(app, scope, points, new Set()))();
      await database.transaction(() => storeMetricSamples(app, scope, points, new Set()))();
      await rollupMetricBatch(app); await rollupMetricBatch(app);
      const history = await readMetricSamples(app, { ...scope, agentIds: [scope.agentId], range: "7d", from: at-1000, to: Date.now() });
      expect(history.sourceSampleCount).toBe(2);
      expect(history.rows).toHaveLength(1);
      expect(JSON.parse(history.rows[0]!.payload_json)).toMatchObject({ host: { cpuUsedPercent: 50 }, statistics: { host: { cpuUsedPercent: { min: 10, max: 90, weight: 60 } } } });
      await cleanupMetricStorage(app);
    } finally { await database.close(); await app.close(); }
  });
  mysqlIt("matches SQLite contract for overview, buckets, first/last/gap, and truncated", async () => {
    expect(db).toBeDefined();
    const config = monitoringTestConfig(directory, { host: externalHost || "127.0.0.1", port, database: "viron_monitor" });
    const ownedDb = db!;
    db = undefined;
    const result = await runMonitoringContractSuite(config, ownedDb);
    expect(result.dialect).toBe("mysql");
    expect(result.summary.hostTotal).toBeGreaterThanOrEqual(200);
    expect(result.summary.hostStale).toBeGreaterThanOrEqual(1);
    expect(result.truncated).toBe(true);
    expect(result.firstPoint).toBeTruthy();
    expect(result.lastPoint).toBeTruthy();
  });

  mysqlIt("matches SQLite alert statistics, interval merging and paginated queries", async () => {
    const sqlite = await openDatabase({ ...monitoringTestConfig(directory), databasePath: join(directory, "alert-statistics.db") });
    const mysql = await openDatabase(monitoringTestConfig(directory, { host: externalHost || "127.0.0.1", port, database: "viron_monitor" }));
    const ownerId = randomUUID();
    const environmentId = randomUUID();
    const connectionId = randomUUID();
    const now = "2026-03-25T12:00:00.000Z";
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
    async function seedAndQuery(database: EnvmanDatabase) {
      await database.prepare(`INSERT INTO environments (id, name, workspace_type, workspace_id, description, tags_json, created_at, updated_at)
        VALUES (?, 'Statistics test', 'personal', ?, '', '[]', ?, ?)`).run(environmentId, ownerId, now, now);
      await database.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, credential_ciphertext, options_json, tags_json, created_at, updated_at)
        VALUES (?, 'Statistics host', '127.0.0.1', 22, 'operator', 'test', '{}', '[]', ?, ?)`).run(connectionId, now, now);
      await database.prepare("INSERT INTO ssh_connection_environments (connection_id, environment_id) VALUES (?, ?)").run(connectionId, environmentId);
      const insert = database.prepare(`INSERT INTO monitor_alerts (
        id, environment_id, target_type, target_id, rule_type, rule_key, ssh_connection_id, environment_name,
        status, severity, peak_severity, details_json, triggered_at, recovered_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, 'host', 'statistics-agent', 'cpu', '', ?, 'Statistics test', ?, ?, ?, '{}', ?, ?, ?, ?, ?)`);
      const events = [
        { id: "earlier", start: "2026-02-28T23:00:00.000Z", end: "2026-03-01T02:00:00.000Z", severity: "major", status: "recovered" },
        { id: "dst", start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z", severity: "critical", status: "recovered" },
        { id: "ongoing", start: "2026-02-01T00:00:00.000Z", end: null, severity: "warning", status: "active" },
        ...Array.from({ length: 2105 }, (_, index) => ({ id: `bulk-${index}`, start: "2026-03-01T01:00:00.000Z", end: "2026-03-01T09:00:00.000Z", severity: "critical", status: "recovered" })),
      ];
      await database.transaction(async () => {
        for (const event of events) await insert.run(`${ownerId}-${event.id}`, environmentId, connectionId,
          event.status, event.severity, event.severity, event.start, event.end, event.end ?? event.start, now, now);
      })();
      const app = { db: database } as FastifyInstance;
      const query = { workspaceType: "personal", workspaceId: ownerId, month: "2026-03", timezone: "America/New_York" };
      const platform = (await loadPlatformEventCalendar(app, query))!;
      const host = await loadMonitorHostEventCalendar(app, environmentId, connectionId, query.month, query.timezone);
      const eventQuery = { workspaceType: query.workspaceType, workspaceId: ownerId, from: Date.parse(platform.from), to: Date.parse(platform.to), order: "priority" as const, limit: 2 };
      const eventsPage = await loadPlatformEvents(app, { ...eventQuery, offset: 1 });
      const filtered = await loadPlatformEvents(app, { ...eventQuery, severity: "warning", status: "active" });
      const denied = await loadPlatformEvents(app, { ...eventQuery, allowedEnvironmentIds: [] });
      return { platform, host, eventsPage, filtered, denied };
    }
    try {
      const expected = await seedAndQuery(sqlite);
      const actual = await seedAndQuery(mysql);
      expect(actual).toEqual(expected);
      expect(actual.filtered.total).toBe(1);
      expect(actual.denied).toEqual({ items: [], total: 0 });
      expect(actual.host!.days[0]!.activeEventCount).toBe(2106);
      expect(actual.platform.days.find((day) => day.date === "2026-03-08")!.affectedMinutes).toBe(1380);
    } finally {
      clock.mockRestore();
      await sqlite.close();
      await mysql.close();
    }
  }, 30_000);
});
