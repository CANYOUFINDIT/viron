import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { capSeriesPoints } from "../src/shared/monitoring.js";
import { monitoringTestConfig, runMonitoringContractSuite } from "./helpers/monitoring-harness.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("monitoring downsample helpers", () => {
  it("keeps first and last points when capping above 480", () => {
    const points = Array.from({ length: 2000 }, (_, index) => ({ at: index }));
    const capped = capSeriesPoints(points, 480);
    expect(capped.length).toBeLessThanOrEqual(480);
    expect(capped.length).toBeGreaterThan(400);
    expect(capped[0]).toEqual({ at: 0 });
    expect(capped[capped.length - 1]).toEqual({ at: 1999 });
  });

  it("keeps first, last, and both sides of explicit gaps", () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({ at: index, breakBefore: index === 100 || index === 500 }));
    const capped = capSeriesPoints(points, 480, (point) => point.breakBefore);
    expect(capped[0]).toEqual({ at: 0, breakBefore: false });
    expect(capped[capped.length - 1]?.at).toBe(999);
    const values = new Set(capped.map((point) => point.at));
    expect(values.has(99) && values.has(100)).toBe(true);
    expect(values.has(499) && values.has(500)).toBe(true);
    expect(capped.some((point) => point.breakBefore)).toBe(true);
  });
});

describe("monitoring overview and service timeseries", () => {
  it("covers stale KPI, page-stable summary, service buckets, downsample, and constant query budget", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitoring-"));
    directories.push(directory);
    const config = monitoringTestConfig(directory);
    const db = await openDatabase(config);
    try {
      const result = await runMonitoringContractSuite(config, db);
      expect(result.summary.hostTotal).toBeGreaterThanOrEqual(200);
      expect(result.summary.hostStale).toBeGreaterThanOrEqual(1);
      expect(result.firstPoint).toBeTruthy();
      expect(result.lastPoint).toBeTruthy();
    } finally {
      await db.close();
    }
  });

  it("returns 404 for an environment outside the current workspace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitoring-iso-"));
    directories.push(directory);
    const config = monitoringTestConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      expect((await app.inject({ method: "GET", url: `/api/v1/monitoring/overview?environmentId=${randomUUID()}`, cookies })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
