import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { capSeriesPoints, compareMonitoringHosts, monitoringSeverityRank } from "../src/shared/monitoring.js";
import { clearMonitoringOverviewCache } from "../src/server/monitoring-overview.js";
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

  it("never exceeds the hard cap when required gap boundaries fill the budget", () => {
    const points = Array.from({ length: 1200 }, (_, index) => ({ at: index, breakBefore: index > 0 && index % 2 === 0 }));
    const capped = capSeriesPoints(points, 480, (point) => point.breakBefore);
    expect(capped).toHaveLength(480);
    expect(capped[0]?.at).toBe(0);
    expect(capped.at(-1)?.at).toBe(1199);
  });
});

describe("monitoring severity ranking", () => {
  it("puts offline and critical hosts ahead of stale and healthy ones", () => {
    const hosts = [
      { connectionName: "healthy", status: "ready", cpuUsedPercent: 12, memoryUsedPercent: 20, diskUsedPercent: 30 },
      { connectionName: "stale", status: "ready", stale: true, cpuUsedPercent: 10, memoryUsedPercent: 10, diskUsedPercent: 10 },
      { connectionName: "hot-disk", status: "ready", cpuUsedPercent: 20, memoryUsedPercent: 20, diskUsedPercent: 96 },
      { connectionName: "offline", status: "error", offline: true, cpuUsedPercent: 1, memoryUsedPercent: 1, diskUsedPercent: 1 },
    ];
    const ranked = [...hosts].sort(compareMonitoringHosts).map((host) => host.connectionName);
    expect(ranked).toEqual(["offline", "hot-disk", "stale", "healthy"]);
    expect(monitoringSeverityRank(hosts[3]!)).toBeLessThan(monitoringSeverityRank(hosts[0]!));
  });
});

describe("monitoring overview and service timeseries", () => {
  it("covers stale KPI, page-stable summary, service buckets, downsample, and constant query budget", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitoring-"));
    directories.push(directory);
    const config = monitoringTestConfig(directory);
    const db = await openDatabase(config);
    const result = await runMonitoringContractSuite(config, db);
    expect(result.summary.hostTotal).toBeGreaterThanOrEqual(200);
    expect(result.summary.hostStale).toBeGreaterThanOrEqual(1);
    expect(result.firstPoint).toBeTruthy();
    expect(result.lastPoint).toBeTruthy();
  });

  it("lists every workspace environment by default and ranks hosts by severity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitoring-severity-"));
    directories.push(directory);
    const config = monitoringTestConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const prod = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产环境" } });
      const dev = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "开发环境" } });
      const sshPayload = (environmentId: string, name: string) => ({
        environmentId,
        name,
        host: "127.0.0.1",
        port: 22,
        username: "operator",
        authType: "password",
        credential: { password: "monitor-secret" },
        options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
      });
      const healthy = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload(prod.json().id, "prod-healthy") });
      const hot = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload(dev.json().id, "dev-hot") });
      const offline = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload(dev.json().id, "dev-offline") });
      const now = new Date().toISOString();
      await db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, install_managed, updated_at
        ) VALUES (?, ?, '0.1.6', 1, 'ready', 1, ?, '[]', '[]', '', ?, ?, 1, ?)
      `).run(healthy.json().id, randomUUID(), JSON.stringify({ cpuUsedPercent: 8, memoryUsedPercent: 12, disks: [{ path: "/", usedPercent: 20 }], resolutionSeconds: 30 }), now, now, now);
      await db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, install_managed, updated_at
        ) VALUES (?, ?, '0.1.6', 1, 'ready', 1, ?, '[]', '[]', '', ?, ?, 1, ?)
      `).run(hot.json().id, randomUUID(), JSON.stringify({ cpuUsedPercent: 18, memoryUsedPercent: 22, disks: [{ path: "/", usedPercent: 97 }], resolutionSeconds: 30 }), now, now, now);
      await db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, install_managed, updated_at
        ) VALUES (?, ?, '0.1.6', 1, 'error', 1, ?, '[]', '[]', 'offline', ?, ?, 1, ?)
      `).run(offline.json().id, randomUUID(), JSON.stringify({ cpuUsedPercent: 1, memoryUsedPercent: 1, disks: [{ path: "/", usedPercent: 1 }], resolutionSeconds: 30 }), now, now, now);

      clearMonitoringOverviewCache();
      const overview = await app.inject({ method: "GET", url: "/api/v1/monitoring/overview", cookies });
      expect(overview.statusCode).toBe(200);
      const names = overview.json().hosts.map((host: { connectionName: string }) => host.connectionName);
      expect(new Set(overview.json().hosts.map((host: { environmentName: string }) => host.environmentName))).toEqual(new Set(["生产环境", "开发环境"]));
      expect(names.slice(0, 3)).toEqual(["dev-offline", "dev-hot", "prod-healthy"]);
      clearMonitoringOverviewCache();
      const firstPage = await app.inject({ method: "GET", url: "/api/v1/monitoring/overview?hostLimit=1&hostOffset=0", cookies });
      const secondPage = await app.inject({ method: "GET", url: "/api/v1/monitoring/overview?hostLimit=1&hostOffset=1&hostsOnly=1", cookies });
      expect(firstPage.json().hosts).toHaveLength(1);
      expect(firstPage.json().hosts[0].connectionName).toBe("dev-offline");
      expect(secondPage.json().hosts[0].connectionName).toBe("dev-hot");
      expect(secondPage.json().nextHostOffset).toBe(2);
      expect(secondPage.json().services).toEqual([]);
    } finally {
      await app.close();
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
