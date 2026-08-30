import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { evaluateMonitorAlertSamples, evaluateMonitorHostAvailability, evaluateRecentMonitorAlerts, type MonitorAlertSample } from "../src/server/monitor-alerts.js";
import { defaultMonitorAlertSettings } from "../src/shared/monitor-alerts.js";

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
    masterKey: Buffer.alloc(32, 41),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
    monitorPullIntervalSeconds: 3600,
  };
}

function sample(collectedAt: string, input: { cpu: number; dataDisk: boolean; deploymentStatus: "running" | "stopped" }): MonitorAlertSample {
  return {
    collectedAt,
    host: {
      hostname: "alert-node",
      collectorUser: "root",
      operatingSystem: "linux",
      architecture: "amd64",
      kernelVersion: "6.8.0",
      cpuCount: 8,
      cpuUsedPercent: input.cpu,
      load1: 1,
      load5: 1,
      load15: 1,
      memoryTotalBytes: 16_000_000_000,
      memoryUsedBytes: 8_000_000_000,
      memoryUsedPercent: 50,
      uptimeSeconds: 1000,
      disks: [
        { path: "/", device: "/dev/sda1", filesystem: "ext4", totalBytes: 1000, freeBytes: 500, usedBytes: 500, usedPercent: 50 },
        ...(input.dataDisk ? [{ path: "/data", device: "/dev/sdb1", filesystem: "xfs", totalBytes: 1000, freeBytes: 500, usedBytes: 500, usedPercent: 50 }] : []),
      ],
      temperatures: [{ chip: "coretemp", celsius: 45 }],
    },
    candidates: [{
      provider: "systemd",
      externalId: "orders.service",
      name: "orders",
      status: input.deploymentStatus,
      state: input.deploymentStatus === "running" ? "active/running" : "inactive/dead",
    }],
  };
}

function withoutDisks(value: MonitorAlertSample): MonitorAlertSample {
  return { ...value, host: { ...value.host, disks: [] } };
}

describe("monitor alerts", () => {
  it("persists settings, confirms two consecutive samples, detects a missing disk, and tracks per-user notifications", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-alert-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "告警环境" } });
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "告警主机",
          host: "127.0.0.1",
          port: 22,
          username: "operator",
          authType: "password",
          credential: { password: "monitor-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const connectionId = connection.json().id as string;
      const agentId = "c98c7ee6-6f42-4abf-a12f-8acbd78025aa";
      const now = new Date().toISOString();
      await app.db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, updated_at
        ) VALUES (?, ?, '0.1.5', 1, 'ready', 1, '{}', '[]', '[]', '', ?, ?, ?)
      `).run(connectionId, agentId, now, now, now);

      const service = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "订单服务", description: "", status: "active" } });
      const serviceId = service.json().id as string;
      const deployment = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/deployments`,
        cookies,
        payload: { sshConnectionId: connectionId, provider: "systemd", externalId: "orders.service", displayName: "订单节点", origin: "manual" },
      });
      expect(deployment.statusCode).toBe(201);

      const saved = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies,
        payload: {
          enabled: true,
          cpuEnabled: true,
          cpuThreshold: 80,
          memoryEnabled: false,
          memoryThreshold: 90,
          diskUsageEnabled: false,
          diskUsageThreshold: 90,
          temperatureEnabled: false,
          temperatureThreshold: 80,
          deploymentStatusEnabled: true,
          diskMissingEnabled: true,
          excludedDisks: [],
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().item).toMatchObject({ enabled: true, hostOfflineEnabled: false, cpuThreshold: 80, diskMissingEnabled: true, consecutiveSamples: 2 });

      const evaluate = async (value: MonitorAlertSample) => evaluateMonitorAlertSamples(app, {
        agentId,
        workspaceType: "personal",
        workspaceId: login.json().user.id,
        samples: [value],
      });
      const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();

      await evaluate(sample(at(30), { cpu: 82, dataDisk: true, deploymentStatus: "running" }));
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items).toHaveLength(0);
      await evaluate(sample(at(60), { cpu: 82, dataDisk: true, deploymentStatus: "running" }));

      let listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json()).toMatchObject({ unread: 1, items: [expect.objectContaining({ ruleType: "cpu", status: "active", notificationPhase: "active", read: false })] });
      const cpuAlertId = listed.json().items[0].id as string;
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${cpuAlertId}/notified`, cookies, payload: { phase: "active" } })).json()).toMatchObject({ claimed: true });
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${cpuAlertId}/notified`, cookies, payload: { phase: "active" } })).json()).toMatchObject({ claimed: false });
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${cpuAlertId}/read`, cookies })).statusCode).toBe(200);

      await evaluate(sample(at(90), { cpu: 95, dataDisk: false, deploymentStatus: "stopped" }));
      await evaluate(sample(at(120), { cpu: 95, dataDisk: false, deploymentStatus: "stopped" }));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items.map((item: { ruleType: string }) => item.ruleType)).toEqual(expect.arrayContaining(["cpu", "disk_missing", "deployment_status"]));
      expect(listed.json().items.find((item: { ruleType: string }) => item.ruleType === "cpu")).toMatchObject({
        severity: "critical",
        peakSeverity: "critical",
        notificationPhase: "escalated",
      });
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${cpuAlertId}/notified`, cookies, payload: { phase: "escalated" } })).json()).toMatchObject({ claimed: true });
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${cpuAlertId}/notified`, cookies, payload: { phase: "escalated" } })).json()).toMatchObject({ claimed: false });
      expect(listed.json().items.find((item: { ruleType: string }) => item.ruleType === "disk_missing")).toMatchObject({
        status: "active",
        details: { device: "/dev/sdb1", path: "/data", missing: true },
      });

      await evaluate(sample(at(150), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      await evaluate(sample(at(180), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      const items = listed.json().items as Array<{ id: string; ruleType: string; status: string; notificationPhase: string | null; details: Record<string, unknown> }>;
      expect(items.filter((item) => ["cpu", "disk_missing", "deployment_status"].includes(item.ruleType)).every((item) => item.status === "recovered")).toBe(true);
      expect(items.find((item) => item.ruleType === "cpu")?.notificationPhase).toBe("recovered");
      expect(items.find((item) => item.ruleType === "disk_missing")?.notificationPhase).toBe("recovered");
      expect(items.find((item) => item.ruleType === "disk_missing")?.details.recovered).toBe(true);

      const failedDiskCollection = (value: MonitorAlertSample): MonitorAlertSample => ({
        ...withoutDisks(value),
        host: { ...withoutDisks(value).host, diskCollectionStatus: "failed" },
      });
      const legacyFailedDiskCollection = (value: MonitorAlertSample): MonitorAlertSample => ({
        ...withoutDisks(value),
        errors: ["running monitor collector: signal: killed"],
      });
      await evaluate(failedDiskCollection(sample(at(185), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      await evaluate(legacyFailedDiskCollection(sample(at(190), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      const withDataDeviceAlias = (value: MonitorAlertSample): MonitorAlertSample => ({
        ...value,
        host: {
          ...value.host,
          disks: value.host.disks.map((disk) => disk.path === "/data" ? { ...disk, device: "/dev/disk/by-id/data-volume" } : disk),
        },
      });
      await evaluate(withDataDeviceAlias(sample(at(195), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      await evaluate(withDataDeviceAlias(sample(at(200), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      const diskItemsAfterInvalidSamples = listed.json().items as Array<{ ruleType: string; status: string; details: Record<string, unknown> }>;
      expect(diskItemsAfterInvalidSamples.some((item) => item.ruleType === "disk_missing" && item.status === "active")).toBe(false);
      expect(diskItemsAfterInvalidSamples.some((item) => item.ruleType === "disk_added" && item.details.path === "/data")).toBe(false);

      const withKubernetesBindMount = (value: MonitorAlertSample): MonitorAlertSample => ({
        ...value,
        host: {
          ...value.host,
          disks: [...value.host.disks, {
            path: "/var/lib/kubelet/pods/pod-id/volumes/data",
            device: "/dev/sdz1",
            filesystem: "ext4",
            totalBytes: 1000,
            freeBytes: 500,
            usedBytes: 500,
            usedPercent: 50,
          }],
        },
      });
      await evaluate(withKubernetesBindMount(sample(at(202), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      await evaluate(withKubernetesBindMount(sample(at(204), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect((listed.json().items as Array<{ ruleType: string; details: Record<string, unknown> }>).some((item) => (
        ["disk_added", "disk_missing"].includes(item.ruleType) && String(item.details.path ?? "").includes("/var/lib/kubelet/pods/")
      ))).toBe(false);

      const withArchiveDisk = (value: MonitorAlertSample): MonitorAlertSample => ({
        ...value,
        host: {
          ...value.host,
          disks: [...value.host.disks, {
            path: "/archive", device: "/dev/sdc1", filesystem: "xfs",
            totalBytes: 500_000, freeBytes: 400_000, usedBytes: 100_000, usedPercent: 20,
          }],
        },
      });
      await evaluate(withArchiveDisk(sample(at(210), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect((listed.json().items as Array<{ ruleType: string }>).some((item) => item.ruleType === "disk_added")).toBe(false);
      await evaluate(withArchiveDisk(sample(at(240), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect((listed.json().items as Array<Record<string, unknown>>).find((item) => item.ruleType === "disk_added")).toMatchObject({
        status: "event",
        notificationPhase: "active",
        details: { device: "/dev/sdc1", path: "/archive", added: true },
      });

      const withBackupDisk = (value: MonitorAlertSample): MonitorAlertSample => ({
        ...value,
        host: {
          ...value.host,
          disks: [...value.host.disks, {
            path: "/backup", device: "/dev/sdd1", filesystem: "xfs",
            totalBytes: 500_000, freeBytes: 400_000, usedBytes: 100_000, usedPercent: 20,
          }],
        },
      });
      await evaluate(withBackupDisk(sample(at(270), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      await evaluate(sample(at(300), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      await evaluate(sample(at(330), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect((listed.json().items as Array<{ ruleType: string; details: Record<string, unknown> }>).some((item) => item.ruleType === "disk_added" && item.details.path === "/backup")).toBe(false);
      expect((listed.json().items as Array<{ ruleType: string; details: Record<string, unknown> }>).some((item) => item.ruleType === "disk_missing" && item.details.path === "/backup")).toBe(false);
      await evaluate(withBackupDisk(sample(at(360), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect((listed.json().items as Array<{ ruleType: string; details: Record<string, unknown> }>).some((item) => item.ruleType === "disk_added" && item.details.path === "/backup")).toBe(false);
      await evaluate(withBackupDisk(sample(at(390), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect((listed.json().items as Array<{ ruleType: string; details: Record<string, unknown> }>).some((item) => item.ruleType === "disk_added" && item.details.path === "/backup")).toBe(true);

      const settings = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/monitor-alert-settings`, cookies });
      expect(settings.json().item).toMatchObject({ enabled: true, cpuThreshold: 80 });
    } finally {
      await app.close();
    }
  });

  it("alerts after two unavailable host checks and recovers after two healthy checks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-host-offline-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "离线告警环境" } });
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "离线主机",
          host: "127.0.0.1",
          port: 22,
          username: "operator",
          authType: "password",
          credential: { password: "monitor-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const connectionId = connection.json().id as string;
      const agentId = "f8b148e8-eaa3-45d4-a8d0-839d4a8a0ab3";
      const now = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await app.db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, updated_at
        ) VALUES (?, ?, '0.1.5', 1, 'ready', 1, ?, '[]', '[]', '', ?, ?, ?)
      `).run(connectionId, agentId, JSON.stringify({ hostname: "offline-node" }), now, now, now);
      const saved = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies,
        payload: {
          ...defaultMonitorAlertSettings,
          enabled: true,
          hostOfflineEnabled: true,
          cpuEnabled: false,
          memoryEnabled: false,
          diskUsageEnabled: false,
          temperatureEnabled: false,
          deploymentStatusEnabled: false,
          diskMissingEnabled: false,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().item).toMatchObject({ enabled: true, hostOfflineEnabled: true });

      const check = (seconds: number, available: boolean) => evaluateMonitorHostAvailability(app, {
        connectionId,
        checkedAt: new Date(Date.parse(now) + seconds * 1000).toISOString(),
        available,
        status: available ? "ready" : "error",
        reason: available ? "healthy" : "pull_failed",
        error: available ? "" : "SSH 连接失败",
        lastCollectedAt: now,
        sampleResolutionSeconds: 30,
      });

      await check(30, false);
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items).toHaveLength(0);
      await Promise.all(Array.from({ length: 20 }, () => check(60, false)));
      let listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items).toEqual([
        expect.objectContaining({
          ruleType: "host_offline",
          targetType: "host",
          targetName: "offline-node",
          sshConnectionId: connectionId,
          status: "active",
          severity: "critical",
          peakSeverity: "critical",
          occurrenceCount: 1,
          details: expect.objectContaining({ reason: "pull_failed", lastError: "SSH 连接失败" }),
        }),
      ]);
      const originalAlertId = listed.json().items[0].id as string;
      for (let second = 61; second <= 180; second += 1) await check(second, false);
      expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_alerts WHERE environment_id = ? AND rule_type = 'host_offline'").get(environmentId)).toEqual({ count: 1 });
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${originalAlertId}/notified`, cookies, payload: { phase: "active" } })).json()).toMatchObject({ claimed: true });
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${originalAlertId}/notified`, cookies, payload: { phase: "active" } })).json()).toMatchObject({ claimed: false });
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/service-deployments`, cookies })).json().discovery.hosts[0].sshConnectionId).toBe(connectionId);

      await check(210, true);
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items[0]).toMatchObject({ ruleType: "host_offline", status: "active" });
      await check(240, true);
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items[0]).toMatchObject({ ruleType: "host_offline", status: "recovered", details: { available: true, reason: "healthy" } });

      await check(270, false);
      await check(300, false);
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items[0]).toMatchObject({ id: originalAlertId, status: "active", occurrenceCount: 2, details: { flapping: true } });
      expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_alerts WHERE environment_id = ? AND rule_type = 'host_offline'").get(environmentId)).toEqual({ count: 1 });
      await check(330, true);
      await check(360, true);

      const calendar = await app.inject({
        method: "GET",
        url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/event-calendar?month=${now.slice(0, 7)}&timezone=UTC`,
        cookies,
      });
      expect(calendar.statusCode).toBe(200);
      expect(calendar.json().summary).toMatchObject({ totalEvents: 1, criticalEvents: 1 });
      expect(calendar.json().days.find((day: { date: string }) => day.date === now.slice(0, 10))).toMatchObject({
        newEventCount: 1,
        activeEventCount: 1,
        peakSeverity: "critical",
      });
      const events = await app.inject({
        method: "GET",
        url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/events?date=${now.slice(0, 10)}&timezone=UTC`,
        cookies,
      });
      expect(events.json().items).toEqual([expect.objectContaining({ id: originalAlertId, occurrenceCount: 2, peakSeverity: "critical" })]);
      const platformCalendar = await app.inject({
        method: "GET",
        url: `/api/v1/monitoring/event-calendar?month=${now.slice(0, 7)}&timezone=UTC`,
        cookies,
      });
      expect(platformCalendar.statusCode).toBe(200);
      expect(platformCalendar.json().summary.totalEvents).toBeGreaterThanOrEqual(1);
      const platformEvents = await app.inject({
        method: "GET",
        url: `/api/v1/monitoring/events?date=${now.slice(0, 10)}&timezone=UTC`,
        cookies,
      });
      expect(platformEvents.statusCode).toBe(200);
      expect(platformEvents.json().items).toEqual([expect.objectContaining({ id: originalAlertId, environmentId })]);
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/service-deployments`, cookies })).json().discovery.hosts[0].sshConnectionId).toBe(connectionId);
    } finally {
      await app.close();
    }
  });

  it("ignores failed empty snapshots, then establishes a valid baseline and detects a missing data disk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-alert-all-disks-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "掉盘环境" } });
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "掉盘主机",
          host: "127.0.0.1",
          port: 22,
          username: "operator",
          authType: "password",
          credential: { password: "monitor-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const connectionId = connection.json().id as string;
      const agentId = "b6ff9c58-2c84-48dc-95a9-b4d37a78b30c";
      const now = new Date().toISOString();
      await app.db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, updated_at
        ) VALUES (?, ?, '0.1.5', 1, 'ready', 1, '{}', '[]', '[]', '', ?, ?, ?)
      `).run(connectionId, agentId, now, now, now);
      await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies,
        payload: {
          enabled: true,
          cpuEnabled: false,
          cpuThreshold: 90,
          memoryEnabled: false,
          memoryThreshold: 90,
          diskUsageEnabled: false,
          diskUsageThreshold: 90,
          temperatureEnabled: false,
          temperatureThreshold: 80,
          deploymentStatusEnabled: false,
          diskMissingEnabled: true,
          excludedDisks: [],
        },
      });
      const evaluate = (value: MonitorAlertSample) => evaluateMonitorAlertSamples(app, {
        agentId,
        workspaceType: "personal",
        workspaceId: login.json().user.id,
        samples: [value],
      });
      const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
      await evaluate({
        ...withoutDisks(sample(at(30), { cpu: 20, dataDisk: false, deploymentStatus: "running" })),
        errors: ["running monitor collector: signal: killed"],
      });
      await evaluate(sample(at(60), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      await evaluate(sample(at(90), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));

      let listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      const added = listed.json().items.filter((item: { ruleType: string }) => item.ruleType === "disk_added");
      expect(added).toHaveLength(0);

      await evaluate(sample(at(120), { cpu: 20, dataDisk: false, deploymentStatus: "running" }));
      await evaluate(sample(at(150), { cpu: 20, dataDisk: false, deploymentStatus: "running" }));

      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      const missing = listed.json().items.filter((item: { ruleType: string }) => item.ruleType === "disk_missing");
      expect(missing).toEqual([
        expect.objectContaining({
          status: "active",
          details: expect.objectContaining({ device: "/dev/sdb1", path: "/data", missing: true }),
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("aggregates authorized alerts across workspaces while keeping notification state per user", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-alert-access-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const ownerLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const ownerCookies = { envman_session: ownerLogin.cookies.find((item) => item.name === "envman_session")!.value };
      const memberRegistration = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { username: "alert-member", password: "member-password-123" },
      });
      const memberId = memberRegistration.json().user.id as string;
      const memberCookies = { envman_session: memberRegistration.cookies.find((item) => item.name === "envman_session")!.value };
      const organization = await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        cookies: ownerCookies,
        payload: { name: "告警组织", description: "" },
      });
      const organizationId = organization.json().id as string;
      const now = new Date().toISOString();
      await app.db.prepare(`
        INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, 'member', ?, ?)
      `).run(organizationId, memberId, now, now);
      for (const cookies of [ownerCookies, memberCookies]) {
        const switched = await app.inject({
          method: "PUT",
          url: "/api/v1/auth/workspace",
          cookies,
          payload: { type: "organization", id: organizationId },
        });
        expect(switched.statusCode).toBe(200);
      }

      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: ownerCookies, payload: { name: "共享告警环境" } });
      const environmentId = environment.json().id as string;
      const hiddenEnvironment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: ownerCookies, payload: { name: "未授权告警环境" } });
      const hiddenEnvironmentId = hiddenEnvironment.json().id as string;
      await app.db.prepare(`
        INSERT INTO resource_grants (
          id, organization_id, grantee_type, grantee_id, resource_type, resource_id,
          created_by_user_id, created_at
        ) VALUES (?, ?, 'user', ?, 'environment', ?, ?, ?)
      `).run(randomUUID(), organizationId, memberId, environmentId, ownerLogin.json().user.id, now);
      const insertAlert = async (environmentId: string, environmentName: string, targetName: string) => {
        const alertId = randomUUID();
        await app.db.prepare(`
          INSERT INTO monitor_alerts (
            id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
            ssh_connection_id, service_id, deployment_id, environment_name, target_name,
            connection_name, service_name, status, details_json, triggered_at, recovered_at,
            created_at, updated_at
          ) VALUES (?, ?, NULL, 'host', ?, 'cpu', '', NULL, NULL, NULL, ?, ?, '', '', 'active', ?, ?, NULL, ?, ?)
        `).run(alertId, environmentId, randomUUID(), environmentName, targetName, JSON.stringify({ value: 95, threshold: 90 }), now, now, now);
        return alertId;
      };
      const alertId = await insertAlert(environmentId, "共享告警环境", "授权主机");
      const hiddenAlertId = await insertAlert(hiddenEnvironmentId, "未授权告警环境", "未授权主机");

      expect((await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies: memberCookies,
        payload: defaultMonitorAlertSettings,
      })).statusCode).toBe(403);
      const filtered = await app.inject({ method: "GET", url: `/api/v1/monitor-alerts?environmentId=${environmentId}`, cookies: ownerCookies });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json().items.every((item: { environmentId: string }) => item.environmentId === environmentId)).toBe(true);
      expect((await app.inject({ method: "GET", url: `/api/v1/monitor-alerts?environmentId=${hiddenEnvironmentId}`, cookies: memberCookies })).statusCode).toBe(404);

      for (const cookies of [ownerCookies, memberCookies]) {
        const switched = await app.inject({
          method: "PUT",
          url: "/api/v1/auth/workspace",
          cookies,
          payload: { type: "personal" },
        });
        expect(switched.statusCode).toBe(200);
      }
      const personalEnvironment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: ownerCookies, payload: { name: "个人告警环境" } });
      const personalAlertId = await insertAlert(personalEnvironment.json().id as string, "个人告警环境", "个人主机");

      const ownerAlerts = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: ownerCookies });
      const memberAlerts = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies });
      expect(ownerAlerts.json()).toMatchObject({ unread: 3 });
      expect(ownerAlerts.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: alertId, workspaceType: "organization", workspaceId: organizationId, workspaceName: "告警组织" }),
        expect.objectContaining({ id: hiddenAlertId, workspaceType: "organization", workspaceId: organizationId, workspaceName: "告警组织" }),
        expect.objectContaining({ id: personalAlertId, workspaceType: "personal", workspaceId: ownerLogin.json().user.id, workspaceName: "个人工作台" }),
      ]));
      expect(memberAlerts.json()).toMatchObject({
        unread: 1,
        items: [expect.objectContaining({ id: alertId, workspaceType: "organization", workspaceId: organizationId, workspaceName: "告警组织", notificationPhase: "active" })],
      });

      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${alertId}/notified`, cookies: ownerCookies, payload: { phase: "active" } })).statusCode).toBe(200);
      const refreshedOwnerAlerts = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: ownerCookies });
      expect(refreshedOwnerAlerts.json().items.find((item: { id: string }) => item.id === alertId).notificationPhase).toBeNull();
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies })).json().items[0].notificationPhase).toBe("active");
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${hiddenAlertId}/read`, cookies: memberCookies })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/v1/monitor-alerts/read-all", cookies: memberCookies })).json()).toMatchObject({ updated: 1 });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies })).json().unread).toBe(0);
      expect((await app.inject({ method: "POST", url: "/api/v1/monitor-alerts/clear-all", cookies: memberCookies })).json()).toMatchObject({ updated: 1 });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies })).json()).toMatchObject({ unread: 0, items: [] });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: ownerCookies })).json()).toMatchObject({ unread: 3 });
      const extraAlertId = await insertAlert(environmentId, "共享告警环境", "新告警主机");
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies })).json()).toMatchObject({
        unread: 1,
        items: [expect.objectContaining({ id: extraAlertId })],
      });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: ownerCookies })).json().unread).toBe(4);
      expect((await app.inject({ method: "POST", url: "/api/v1/monitor-alerts/clear-all", cookies: ownerCookies })).json().updated).toBe(4);
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: ownerCookies })).json()).toMatchObject({ unread: 0, items: [] });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies })).json()).toMatchObject({
        unread: 1,
        items: [expect.objectContaining({ id: extraAlertId })],
      });
    } finally {
      await app.close();
    }
  });

  it("clears a large unread backlog with a bulk write instead of per-alert updates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-alert-clear-all-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "大批量告警环境" } });
      const environmentId = environment.json().id as string;
      const now = new Date().toISOString();
      const total = 240;
      await app.db.transaction(async () => {
        for (let index = 0; index < total; index += 1) {
          await app.db.prepare(`
            INSERT INTO monitor_alerts (
              id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
              ssh_connection_id, service_id, deployment_id, environment_name, target_name,
              connection_name, service_name, status, details_json, triggered_at, recovered_at,
              created_at, updated_at
            ) VALUES (?, ?, NULL, 'host', ?, 'cpu', '', NULL, NULL, NULL, ?, ?, '', '', 'active', ?, ?, NULL, ?, ?)
          `).run(
            randomUUID(),
            environmentId,
            randomUUID(),
            "大批量告警环境",
            `主机 ${index}`,
            JSON.stringify({ value: 95, threshold: 90 }),
            now,
            now,
            now,
          );
        }
      })();
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().unread).toBe(total);
      const started = Date.now();
      const cleared = await app.inject({ method: "POST", url: "/api/v1/monitor-alerts/clear-all", cookies });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ ok: true, updated: total });
      expect(Date.now() - started).toBeLessThan(1_500);
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json()).toMatchObject({ unread: 0, items: [] });
      expect((await app.inject({ method: "POST", url: "/api/v1/monitor-alerts/clear-all", cookies })).json()).toMatchObject({ updated: 0 });
    } finally {
      await app.close();
    }
  });

  it("evaluates recent samples for the canonical connection instead of scanning every duplicate host row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-alert-canonical-samples-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "重复连接告警环境" } });
      const environmentId = environment.json().id as string;
      const sshPayload = (name: string) => ({
        environmentId,
        name,
        host: "127.0.0.1",
        port: 22,
        username: "operator",
        authType: "password",
        credential: { password: "monitor-secret" },
        options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
      });
      const managed = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("托管主机") });
      const duplicate = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("重复主机") });
      const managedId = managed.json().id as string;
      const duplicateId = duplicate.json().id as string;
      const agentId = "5d1f0c3a-2b8e-4d11-9c4a-7a6f0b12e9aa";
      const now = Date.parse("2026-08-29T12:00:00.000Z");
      const insertHost = async (connectionId: string, managedFlag: number, collectedAt: string) => {
        await app.db.prepare(`
          INSERT INTO monitor_hosts (
            ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
            latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
            last_collected_at, last_pulled_at, install_managed, updated_at
          ) VALUES (?, ?, '0.1.6', 1, 'ready', 4, ?, '[]', '[]', '', ?, ?, ?, ?)
        `).run(connectionId, agentId, JSON.stringify({ hostname: "alert-node", cpuUsedPercent: 95 }), collectedAt, collectedAt, managedFlag, collectedAt);
      };
      const hotAt = new Date(now).toISOString();
      const laterCoolAt = new Date(now + 120_000).toISOString();
      await insertHost(managedId, 1, hotAt);
      await insertHost(duplicateId, 0, laterCoolAt);
      const insertSample = async (connectionId: string, sequence: number, collectedAt: string, cpu: number) => {
        const payload = sample(collectedAt, { cpu, dataDisk: false, deploymentStatus: "running" });
        await app.db.prepare(`
          INSERT INTO monitor_samples (
            ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at,
            resolution_seconds, payload_json, received_at
          ) VALUES (?, ?, ?, ?, ?, 30, ?, ?)
        `).run(connectionId, agentId, sequence, sequence, collectedAt, JSON.stringify(payload), collectedAt);
      };
      await insertSample(managedId, 1, new Date(now - 30_000).toISOString(), 95);
      await insertSample(managedId, 2, hotAt, 95);
      await insertSample(duplicateId, 3, new Date(now + 90_000).toISOString(), 10);
      await insertSample(duplicateId, 4, laterCoolAt, 10);
      const saved = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies,
        payload: {
          ...defaultMonitorAlertSettings,
          enabled: true,
          hostOfflineEnabled: false,
          cpuEnabled: true,
          cpuThreshold: 90,
          memoryEnabled: false,
          diskUsageEnabled: false,
          temperatureEnabled: false,
          deploymentStatusEnabled: false,
          diskMissingEnabled: false,
        },
      });
      expect(saved.statusCode).toBe(200);
      const scope = await app.db.prepare("SELECT workspace_type, workspace_id FROM ssh_connections WHERE id = ?").get(managedId) as { workspace_type: string; workspace_id: string };
      await evaluateRecentMonitorAlerts(app, agentId, scope.workspace_type, scope.workspace_id);
      const listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items).toEqual([
        expect.objectContaining({ ruleType: "cpu", status: "active", targetName: "alert-node" }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("does not treat kubelet NFS/CSI mounts as missing disks unless container mounts are opted in", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-alert-disk-types-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "磁盘类型环境" } });
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "k8s 节点",
          host: "127.0.0.1",
          port: 22,
          username: "operator",
          authType: "password",
          credential: { password: "monitor-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const connectionId = connection.json().id as string;
      const agentId = "a11c0d4e-2b9f-4c71-8e0a-5d6f7b12c8aa";
      const now = new Date().toISOString();
      await app.db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, updated_at
        ) VALUES (?, ?, '0.1.6', 1, 'ready', 1, '{}', '[]', '[]', '', ?, ?, ?)
      `).run(connectionId, agentId, now, now, now);
      const saveSettings = async (monitoredDiskTypes: string[]) => {
        const saved = await app.inject({
          method: "PUT",
          url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
          cookies,
          payload: {
            ...defaultMonitorAlertSettings,
            enabled: true,
            hostOfflineEnabled: false,
            cpuEnabled: false,
            memoryEnabled: false,
            diskUsageEnabled: false,
            temperatureEnabled: false,
            deploymentStatusEnabled: false,
            diskMissingEnabled: true,
            monitoredDiskTypes,
          },
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().item.monitoredDiskTypes).toEqual(monitoredDiskTypes);
      };
      await saveSettings(["host_local"]);
      const evaluate = (value: MonitorAlertSample) => evaluateMonitorAlertSamples(app, {
        agentId,
        workspaceType: "personal",
        workspaceId: login.json().user.id,
        samples: [value],
      });
      const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
      const withPodVolumes = (value: MonitorAlertSample): MonitorAlertSample => ({
        ...value,
        host: {
          ...value.host,
          disks: [
            ...value.host.disks,
            {
              path: "/var/lib/kubelet/pods/pod-id/volumes/kubernetes.io~nfs/models",
              device: "192.168.5.195:/opt/onepro/hehao/vllm",
              filesystem: "nfs",
              totalBytes: 1000, freeBytes: 500, usedBytes: 500, usedPercent: 50,
            },
            {
              path: "/var/lib/kubelet/pods/pod-id/volumes/kubernetes.io~csi/pvc-data/mount",
              device: "/dev/sdz1",
              filesystem: "ext4",
              totalBytes: 1000, freeBytes: 500, usedBytes: 500, usedPercent: 50,
            },
          ],
        },
      });
      const diskAlertPaths = async () => {
        const listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
        return (listed.json().items as Array<{ ruleType: string; details: Record<string, unknown> }>)
          .filter((item) => ["disk_added", "disk_missing"].includes(item.ruleType))
          .map((item) => String(item.details.path ?? ""));
      };

      await evaluate(withPodVolumes(sample(at(30), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      await evaluate(withPodVolumes(sample(at(60), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      await evaluate(sample(at(90), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      await evaluate(sample(at(120), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      expect((await diskAlertPaths()).some((path) => path.includes("/var/lib/kubelet/pods/"))).toBe(false);

      await saveSettings(["host_local", "container_pod"]);
      await evaluate(withPodVolumes(sample(at(150), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      await evaluate(withPodVolumes(sample(at(180), { cpu: 20, dataDisk: true, deploymentStatus: "running" })));
      expect((await diskAlertPaths()).some((path) => path.includes("/var/lib/kubelet/pods/"))).toBe(false);
      await evaluate(sample(at(210), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      await evaluate(sample(at(240), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      const missingPaths = (await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items
        .filter((item: { ruleType: string; status: string }) => item.ruleType === "disk_missing" && item.status === "active")
        .map((item: { details: Record<string, unknown> }) => String(item.details.path ?? ""));
      expect(missingPaths).toEqual(expect.arrayContaining([
        "/var/lib/kubelet/pods/pod-id/volumes/kubernetes.io~nfs/models",
        "/var/lib/kubelet/pods/pod-id/volumes/kubernetes.io~csi/pvc-data/mount",
      ]));
    } finally {
      await app.close();
    }
  });
});
