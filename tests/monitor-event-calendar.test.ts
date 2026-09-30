import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/database.js";
import {
  coverageMsByDay,
  loadMonitorHostEventCalendar,
  monitorLocalDayRange,
  monitorMonthDays,
  monitorSampleCoverageInterval,
  validateMonitorTimezone,
} from "../src/server/monitor-event-calendar.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testConfig(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 37),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
    monitorPullIntervalSeconds: 3600,
  };
}

function legacyClippedCoverageMs(intervals: Array<{ start: number; end: number }>, windowStart: number, windowEnd: number): number {
  const clipped = intervals
    .filter((interval) => interval.start < windowEnd && interval.end >= windowStart)
    .map((interval) => ({ start: Math.max(windowStart, interval.start), end: Math.min(windowEnd, interval.end) }))
    .sort((left, right) => left.start - right.start);
  if (!clipped.length) return 0;
  let duration = 0;
  let current = { ...clipped[0]! };
  for (const interval of clipped.slice(1)) {
    if (interval.start <= current.end) current.end = Math.max(current.end, interval.end);
    else {
      duration += Math.max(0, current.end - current.start);
      current = { ...interval };
    }
  }
  return duration + Math.max(0, current.end - current.start);
}

describe("monitor event calendar time boundaries", () => {
  it("builds local calendar days without assuming every day is 24 hours", () => {
    const days = monitorMonthDays("2026-03", "America/New_York");
    expect(days).toHaveLength(31);
    const daylightSavingDay = days.find((day) => day.date === "2026-03-08");
    expect(daylightSavingDay).toBeDefined();
    expect(daylightSavingDay!.end - daylightSavingDay!.start).toBe(23 * 60 * 60 * 1000);
  });

  it("rejects invalid dates and timezones", () => {
    expect(validateMonitorTimezone("Asia/Shanghai")).toBe(true);
    expect(validateMonitorTimezone("Not/A_Timezone")).toBe(false);
    expect(monitorLocalDayRange("2026-02-30", "UTC")).toBeNull();
    expect(monitorMonthDays("2026-13", "UTC")).toEqual([]);
  });

  it("keeps the same per-day coverage after merging intervals once", () => {
    const days = monitorMonthDays("2026-03", "America/New_York");
    let state = 20260308;
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const intervals = Array.from({ length: 400 }, () => {
      const start = days[0]!.start + Math.floor(next() * 40 * 24 * 60 * 60 * 1000);
      const end = start + Math.floor(next() * 36 * 60 * 60 * 1000);
      return { start, end };
    });
    const covered = coverageMsByDay(days, intervals);
    days.forEach((day, index) => {
      expect(covered[index]).toBe(legacyClippedCoverageMs(intervals, day.start, day.end));
    });
  });

  it("reads coverage from the slim index and keeps the 80% healthy rule", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-event-calendar-"));
    directories.push(directory);
    const db = await openDatabase(testConfig(directory));
    try {
      const now = "2026-01-01T00:00:00.000Z";
      await db.prepare(`
        INSERT INTO environments (id, name, created_at, updated_at)
        VALUES ('env-1', '日历环境', ?, ?)
      `).run(now, now);
      await db.prepare(`
        INSERT INTO ssh_connections (
          id, name, host, port, username, credential_ciphertext, created_at, updated_at
        ) VALUES ('conn-1', '日历主机', '10.0.0.8', 22, 'root', 'cipher', ?, ?)
      `).run(now, now);
      await db.prepare(`
        INSERT INTO ssh_connection_environments (connection_id, environment_id)
        VALUES ('conn-1', 'env-1')
      `).run();
      await db.prepare(`
        INSERT INTO monitor_hosts (ssh_connection_id, agent_id, status, updated_at)
        VALUES ('conn-1', 'agent-current', 'ready', ?)
      `).run(now);
      const insertSample = db.prepare(`
        INSERT INTO monitor_samples (
          ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at,
          resolution_seconds, payload_json, received_at
        ) VALUES ('conn-1', 'agent-old', ?, ?, ?, 30, ?, ?)
      `);
      await insertSample.run(1, 1440, "2026-01-01T12:00:00.000Z", "{}", now);
      await insertSample.run(1, 2304, "2026-01-02T19:12:00.000Z", "x".repeat(80_000), now);
      await db.prepare(`
        INSERT INTO monitor_alerts (
          id, environment_id, target_type, target_id, rule_type, ssh_connection_id,
          environment_name, status, severity, peak_severity, details_json,
          triggered_at, recovered_at, last_seen_at, created_at, updated_at
        ) VALUES (
          'alert-1', 'env-1', 'host', 'agent-old', 'cpu', NULL,
          '日历环境', 'recovered', 'critical', 'critical', '{}',
          '2026-01-03T01:00:00.000Z', '2026-01-03T02:00:00.000Z', '2026-01-03T02:00:00.000Z', ?, ?
        )
      `).run(now, now);

      const coveragePlan = await db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT sequence_start, sequence_end, collected_at, resolution_seconds
        FROM monitor_samples
        WHERE ssh_connection_id = ? AND collected_at >= ? AND collected_at < ?
      `).all("conn-1", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z") as Array<{ detail: string }>;
      expect(coveragePlan.map((row) => row.detail).join("\n")).toContain("USING COVERING INDEX monitor_samples_coverage_idx");
      const agentPlan = await db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT DISTINCT agent_id FROM monitor_samples
        WHERE ssh_connection_id = ? AND agent_id <> ''
      `).all("conn-1") as Array<{ detail: string }>;
      expect(agentPlan.map((row) => row.detail).join("\n")).toContain("USING COVERING INDEX monitor_samples_connection_agent_idx");

      const calendar = await loadMonitorHostEventCalendar({ db } as FastifyInstance, "env-1", "conn-1", "2026-01", "UTC");
      expect(calendar).not.toBeNull();
      const halfDay = calendar!.days.find((day) => day.date === "2026-01-01");
      const healthyDay = calendar!.days.find((day) => day.date === "2026-01-02");
      const alertDay = calendar!.days.find((day) => day.date === "2026-01-03");
      const halfInterval = monitorSampleCoverageInterval({
        sequence_start: 1,
        sequence_end: 1440,
        collected_at: "2026-01-01T12:00:00.000Z",
        resolution_seconds: 30,
      });
      expect(halfDay).toMatchObject({
        coverageRatio: (halfInterval!.end - halfInterval!.start) / (24 * 60 * 60 * 1000),
        activeEventCount: 0,
        peakSeverity: null,
      });
      expect(halfDay!.coverageRatio).toBeLessThan(0.8);
      const fullInterval = monitorSampleCoverageInterval({
        sequence_start: 1,
        sequence_end: 2304,
        collected_at: "2026-01-02T19:12:00.000Z",
        resolution_seconds: 30,
      });
      expect(healthyDay).toMatchObject({
        coverageRatio: (fullInterval!.end - fullInterval!.start) / (24 * 60 * 60 * 1000),
        activeEventCount: 0,
        peakSeverity: null,
      });
      expect(healthyDay!.coverageRatio).toBeGreaterThanOrEqual(0.8);
      expect(alertDay).toMatchObject({
        coverageRatio: 0,
        activeEventCount: 1,
        newEventCount: 1,
        peakSeverity: "critical",
        affectedMinutes: 60,
      });
      expect(calendar!.summary).toMatchObject({ healthyDays: 1, affectedDays: 1, noDataDays: 29, totalEvents: 1, criticalEvents: 1 });
    } finally {
      await db.close();
    }
  });
});
