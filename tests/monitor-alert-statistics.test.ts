import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type EnvmanDatabase } from "../src/server/database.js";
import { monitorAlertRangeSql } from "../src/server/monitor-alert-query.js";
import { coverageMsByDay, loadMonitorHostEventCalendar, loadPlatformEventCalendar, loadPlatformEvents, monitorMonthDays } from "../src/server/monitor-event-calendar.js";
import type { MonitorAlertSeverity } from "../src/shared/monitor-alerts.js";

const generatedAt = Date.parse("2026-03-25T12:00:00.000Z");
let directory: string;
let db: EnvmanDatabase;
let app: FastifyInstance;
const scope = { workspaceType: "personal", workspaceId: "owner-a" };
const calendarQuery = { ...scope, month: "2026-03", timezone: "UTC" };
interface FixtureEvent {
  id: string; start: string; end?: string; status?: "active" | "recovered" | "event";
  severity?: MonitorAlertSeverity; environment?: string;
}

async function insertEvents(events: FixtureEvent[]) {
  const insert = db.prepare(`INSERT INTO monitor_alerts (
    id, environment_id, target_type, target_id, rule_type, ssh_connection_id,
    environment_name, status, severity, peak_severity, details_json,
    triggered_at, recovered_at, last_seen_at, created_at, updated_at
  ) VALUES (?, ?, 'host', 'agent-1', 'cpu', 'conn-1', 'Test', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  await db.transaction(async () => {
    for (const event of events) await insert.run(
      event.id, event.environment ?? "env-1", event.status ?? (event.end ? "recovered" : "event"),
      event.severity ?? "warning", event.severity ?? "warning", JSON.stringify({ payload: "x".repeat(4096) }),
      event.start, event.end ?? null, event.end ?? event.start, event.start, event.start,
    );
  })();
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(generatedAt);
  directory = mkdtempSync(join(tmpdir(), "viron-alert-statistics-"));
  db = await openDatabase({
    nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "test.db"),
    masterKey: Buffer.alloc(32, 37), adminUsername: "admin", adminPassword: "test-password-123",
    sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30,
  });
  app = { db } as FastifyInstance;
  for (const [id, owner] of [["env-1", "owner-a"], ["env-2", "owner-a"], ["env-hidden", "owner-b"]]) {
    await db.prepare("INSERT INTO environments (id, name, workspace_type, workspace_id, created_at, updated_at) VALUES (?, ?, 'personal', ?, ?, ?)")
      .run(id, id, owner, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  }
  await db.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, credential_ciphertext, created_at, updated_at)
    VALUES ('conn-1', 'Test host', '127.0.0.1', 22, 'operator', 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  await db.prepare("INSERT INTO ssh_connection_environments (connection_id, environment_id) VALUES ('conn-1', 'env-1')").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("database alert statistics", () => {
  it("counts cross-month incidents and merges nested/overlapping durations", async () => {
    await insertEvents([
      { id: "previous-month", start: "2026-02-28T23:00:00.000Z", end: "2026-03-01T02:00:00.000Z", severity: "major" },
      { id: "overlap", start: "2026-03-01T01:00:00.000Z", end: "2026-03-01T04:00:00.000Z", severity: "critical" },
      { id: "nested", start: "2026-03-01T01:15:00.000Z", end: "2026-03-01T01:30:00.000Z", severity: "info" },
      { id: "instant", start: "2026-03-02T00:00:00.000Z", severity: "info" },
      { id: "expired", start: "2026-02-27T00:00:00.000Z", end: "2026-02-28T23:59:59.999Z" },
      { id: "other-workspace", start: "2026-03-01T00:00:00.000Z", status: "active", environment: "env-hidden" },
    ]);
    const calendar = (await loadPlatformEventCalendar(app, calendarQuery))!;
    expect(calendar.days[0]).toMatchObject({ newEventCount: 2, activeEventCount: 3, infoCount: 1, majorCount: 1, criticalCount: 1, affectedMinutes: 240, peakSeverity: "critical" });
    expect(calendar.days[1]).toMatchObject({ newEventCount: 1, activeEventCount: 1, affectedMinutes: 0 });
    expect(calendar.summary).toMatchObject({ totalEvents: 3, criticalEvents: 1, affectedMinutes: 240, affectedDays: 2, meanRecoveryMinutes: 98 });
    const list = await loadPlatformEvents(app, { ...scope, from: Date.parse(calendar.from), to: Date.parse(calendar.to), limit: 100 });
    expect(list.total).toBe(4);
    expect(new Set(list.items.map((item) => item.id))).toEqual(new Set(["previous-month", "overlap", "nested", "instant"]));
  });

  it("preserves recovery-at-midnight, ongoing alerts, timezone/DST boundaries and future days", async () => {
    await insertEvents([
      { id: "dst", start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z", severity: "critical" },
      { id: "active-old", start: "2026-02-01T00:00:00.000Z", status: "active", environment: "env-2" },
    ]);
    const calendar = (await loadPlatformEventCalendar(app, { ...calendarQuery, timezone: "America/New_York", environmentId: "env-1" }))!;
    expect(calendar.days.find((day) => day.date === "2026-03-08")).toMatchObject({ newEventCount: 1, activeEventCount: 1, affectedMinutes: 1380 });
    expect(calendar.days.find((day) => day.date === "2026-03-09")).toMatchObject({ newEventCount: 0, activeEventCount: 1, affectedMinutes: 0 });
    expect(calendar.days.at(-1)).toMatchObject({ future: true, coverageRatio: 0 });
    const ongoing = (await loadPlatformEventCalendar(app, { ...calendarQuery, environmentId: "env-2" }))!;
    expect(ongoing.summary.totalEvents).toBe(0);
    expect(ongoing.days[0]).toMatchObject({ activeEventCount: 1, affectedMinutes: 1440 });
    expect(ongoing.days[24]).toMatchObject({ activeEventCount: 1, affectedMinutes: 720 });
    expect(ongoing.days[25]).toMatchObject({ activeEventCount: 0, affectedMinutes: 0, future: true });
  });

  it("returns only daily aggregates and includes all host events beyond the old 2000-row limit", async () => {
    await insertEvents(Array.from({ length: 2105 }, (_, index) => ({ id: `bulk-${index}`, start: "2026-03-01T12:00:00.000Z", end: "2026-03-01T12:01:00.000Z", severity: "critical" })));
    const prepare = db.prepare.bind(db);
    const returnedRows: number[] = [];
    const aggregateSql: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("daily_counts")) return statement;
      aggregateSql.push(sql);
      const all = statement.all.bind(statement);
      return { ...statement, all: async <T>(...parameters: unknown[]) => {
        const rows = await all<T>(...parameters);
        returnedRows.push(rows.length);
        return rows;
      } };
    });
    const platform = (await loadPlatformEventCalendar(app, calendarQuery))!;
    const host = (await loadMonitorHostEventCalendar(app, "env-1", "conn-1", "2026-03", "UTC"))!;
    for (const calendar of [platform, host]) {
      expect(calendar.summary).toMatchObject({ totalEvents: 2105, criticalEvents: 2105, affectedMinutes: 1 });
      expect(calendar.days[0]).toMatchObject({ activeEventCount: 2105, newEventCount: 2105, affectedMinutes: 1 });
    }
    expect(returnedRows).toEqual([31, 31]);
    expect(aggregateSql.every((sql) => !sql.includes("details_json") && !sql.includes("monitor_samples"))).toBe(true);
  });

  it("matches an independent interval/count calculation across varied incidents", async () => {
    const days = monitorMonthDays("2026-03", "America/New_York");
    let seed = 20260308;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const events: FixtureEvent[] = Array.from({ length: 400 }, (_, index) => {
      const start = days[0]!.start + Math.floor((random() * 40 - 5) * 86400000);
      const status = (["active", "recovered", "event"] as const)[Math.floor(random() * 3)]!;
      return { id: `varied-${index}`, start: new Date(start).toISOString(), status,
        end: status === "recovered" ? new Date(start + Math.floor(random() * 36 * 3600000)).toISOString() : undefined,
        severity: (["info", "warning", "major", "critical"] as const)[Math.floor(random() * 4)]! };
    });
    await insertEvents(events);
    const matching = events.filter((event) => Date.parse(event.start) < days.at(-1)!.end
      && (event.status === "active" ? generatedAt : Date.parse(event.end ?? event.start)) >= days[0]!.start);
    const intervals = matching.map((event) => {
      const start = Date.parse(event.start);
      const end = event.status === "active" ? generatedAt : event.end ? Date.parse(event.end) : start + 1;
      return { start, end: Math.max(start + 1, end), event };
    });
    const duration = coverageMsByDay(days, intervals);
    const calendar = (await loadPlatformEventCalendar(app, { ...calendarQuery, timezone: "America/New_York" }))!;
    days.forEach((day, index) => {
      const active = intervals.filter((interval) => interval.start < day.end && interval.end >= day.start);
      expect(calendar.days[index]).toMatchObject({
        newEventCount: matching.filter((event) => Date.parse(event.start) >= day.start && Date.parse(event.start) < day.end).length,
        activeEventCount: active.length,
        infoCount: active.filter(({ event }) => event.severity === "info").length,
        warningCount: active.filter(({ event }) => event.severity === "warning").length,
        majorCount: active.filter(({ event }) => event.severity === "major").length,
        criticalCount: active.filter(({ event }) => event.severity === "critical").length,
        affectedMinutes: Math.round(duration[index]! / 60000),
      });
    });
    const started = matching.filter((event) => Date.parse(event.start) >= days[0]!.start);
    const recovered = started.filter((event) => event.end);
    expect(calendar.summary).toMatchObject({ totalEvents: started.length, criticalEvents: started.filter((event) => event.severity === "critical").length,
      meanRecoveryMinutes: Math.round(recovered.reduce((sum, event) => sum + Date.parse(event.end!) - Date.parse(event.start), 0) / recovered.length / 60000) });
  });

  it("keeps scopes, severity/status filters, totals and stable pagination aligned", async () => {
    await insertEvents([
      { id: "a-critical", start: "2026-03-01T12:00:00.000Z", severity: "critical" },
      { id: "z-critical", start: "2026-03-01T12:00:00.000Z", severity: "critical" },
      { id: "major", start: "2026-03-01T12:00:00.000Z", severity: "major" },
      { id: "ongoing", start: "2026-02-01T00:00:00.000Z", status: "active" },
      { id: "denied", start: "2026-03-01T12:00:00.000Z", environment: "env-2", severity: "critical" },
      { id: "hidden", start: "2026-03-01T12:00:00.000Z", environment: "env-hidden", severity: "critical" },
    ]);
    const days = monitorMonthDays("2026-03", "UTC");
    const query = { ...scope, allowedEnvironmentIds: ["env-1"], from: days[0]!.start, to: days.at(-1)!.end, order: "priority" as const, limit: 1 };
    expect(await loadPlatformEvents(app, query)).toMatchObject({ total: 4, items: [{ id: "z-critical" }] });
    expect(await loadPlatformEvents(app, { ...query, offset: 1 })).toMatchObject({ total: 4, items: [{ id: "a-critical" }] });
    expect(await loadPlatformEvents(app, { ...query, severity: "critical", status: "event" })).toMatchObject({ total: 2 });
    expect((await loadPlatformEventCalendar(app, { ...calendarQuery, allowedEnvironmentIds: ["env-1"] }))!.summary.totalEvents).toBe(3);
    expect((await loadPlatformEventCalendar(app, { ...calendarQuery, allowedEnvironmentIds: [] }))!.summary.totalEvents).toBe(0);
    expect(await loadPlatformEvents(app, { ...query, allowedEnvironmentIds: [] })).toEqual({ total: 0, items: [] });
    expect(await loadPlatformEvents(app, { ...query, environmentId: "env-hidden", allowedEnvironmentIds: null })).toEqual({ total: 0, items: [] });
  });

  it("uses covering range indexes instead of scanning expired history", async () => {
    const days = monitorMonthDays("2026-03", "UTC");
    const matched = monitorAlertRangeSql({ sql: "a.environment_id = ?", parameters: ["env-1"] }, "a.triggered_at, a.recovered_at, a.status, a.peak_severity, a.severity", days[0]!.start, days.at(-1)!.end, generatedAt, db.dialect);
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${matched.sql}`).all<{ detail: string }>(...matched.parameters);
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("USING COVERING INDEX monitor_alerts_calendar_trigger_idx");
    expect(details).toContain("USING COVERING INDEX monitor_alerts_calendar_recovery_idx");
    expect(details).not.toMatch(/SCAN a\b/);
  });
});
