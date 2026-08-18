import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { evaluateMonitorAlertSamples, evaluateMonitorHostAvailability, type MonitorAlertSample } from "../src/server/monitor-alerts.js";
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

      await evaluate(sample(at(30), { cpu: 95, dataDisk: true, deploymentStatus: "running" }));
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items).toHaveLength(0);
      await evaluate(sample(at(60), { cpu: 95, dataDisk: true, deploymentStatus: "running" }));

      let listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json()).toMatchObject({ unread: 1, items: [expect.objectContaining({ ruleType: "cpu", status: "active", notificationPhase: "active", read: false })] });
      const cpuAlertId = listed.json().items[0].id as string;
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${cpuAlertId}/notified`, cookies, payload: { phase: "active" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${cpuAlertId}/read`, cookies })).statusCode).toBe(200);

      await evaluate(sample(at(90), { cpu: 95, dataDisk: false, deploymentStatus: "stopped" }));
      await evaluate(sample(at(120), { cpu: 95, dataDisk: false, deploymentStatus: "stopped" }));
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items.map((item: { ruleType: string }) => item.ruleType)).toEqual(expect.arrayContaining(["cpu", "disk_missing", "deployment_status"]));
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

      const maintenance = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(maintenance.json().alertSettings).toMatchObject({ enabled: true, cpuThreshold: 80 });
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
      const now = new Date().toISOString();
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
      await check(60, false);
      let listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items).toEqual([
        expect.objectContaining({
          ruleType: "host_offline",
          targetType: "host",
          targetName: "offline-node",
          sshConnectionId: connectionId,
          status: "active",
          details: expect.objectContaining({ reason: "pull_failed", lastError: "SSH 连接失败" }),
        }),
      ]);
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies })).json().hosts[0]).toMatchObject({ monitorOffline: true });

      await check(90, true);
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items[0]).toMatchObject({ ruleType: "host_offline", status: "active" });
      await check(120, true);
      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(listed.json().items[0]).toMatchObject({ ruleType: "host_offline", status: "recovered", details: { available: true, reason: "healthy" } });
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies })).json().hosts[0]).toMatchObject({ monitorOffline: false });
    } finally {
      await app.close();
    }
  });

  it("establishes an empty disk baseline, then detects additions and disappearance when disk monitoring is the only enabled host rule", async () => {
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
      await evaluate(withoutDisks(sample(at(30), { cpu: 20, dataDisk: false, deploymentStatus: "running" })));
      await evaluate(sample(at(60), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));
      await evaluate(sample(at(90), { cpu: 20, dataDisk: true, deploymentStatus: "running" }));

      let listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      const added = listed.json().items.filter((item: { ruleType: string }) => item.ruleType === "disk_added");
      expect(added).toHaveLength(2);

      await evaluate(withoutDisks(sample(at(120), { cpu: 20, dataDisk: false, deploymentStatus: "running" })));
      await evaluate(withoutDisks(sample(at(150), { cpu: 20, dataDisk: false, deploymentStatus: "running" })));

      listed = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      const missing = listed.json().items.filter((item: { ruleType: string }) => item.ruleType === "disk_missing");
      expect(missing).toHaveLength(2);
      expect(missing).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "active", details: { device: "/dev/sda1", path: "/", missing: true } }),
        expect.objectContaining({ status: "active", details: { device: "/dev/sdb1", path: "/data", missing: true } }),
      ]));
    } finally {
      await app.close();
    }
  });

  it("shares alerts with authorized environment members while keeping notification state per user", async () => {
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
      await app.db.prepare(`
        INSERT INTO resource_grants (
          id, organization_id, grantee_type, grantee_id, resource_type, resource_id,
          created_by_user_id, created_at
        ) VALUES (?, ?, 'user', ?, 'environment', ?, ?, ?)
      `).run(randomUUID(), organizationId, memberId, environmentId, ownerLogin.json().user.id, now);
      const alertId = randomUUID();
      await app.db.prepare(`
        INSERT INTO monitor_alerts (
          id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
          ssh_connection_id, service_id, deployment_id, environment_name, target_name,
          connection_name, service_name, status, details_json, triggered_at, recovered_at,
          created_at, updated_at
        ) VALUES (?, ?, NULL, 'host', ?, 'cpu', '', NULL, NULL, NULL, ?, ?, '', '', 'active', ?, ?, NULL, ?, ?)
      `).run(alertId, environmentId, randomUUID(), "共享告警环境", "授权主机", JSON.stringify({ value: 95, threshold: 90 }), now, now, now);

      const ownerAlerts = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: ownerCookies });
      const memberAlerts = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies });
      expect(ownerAlerts.json()).toMatchObject({ unread: 1, items: [expect.objectContaining({ id: alertId, notificationPhase: "active" })] });
      expect(memberAlerts.json()).toMatchObject({ unread: 1, items: [expect.objectContaining({ id: alertId, notificationPhase: "active" })] });

      expect((await app.inject({ method: "POST", url: `/api/v1/monitor-alerts/${alertId}/notified`, cookies: ownerCookies, payload: { phase: "active" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: ownerCookies })).json().items[0].notificationPhase).toBeNull();
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies: memberCookies })).json().items[0].notificationPhase).toBe("active");
      expect((await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies: memberCookies,
        payload: defaultMonitorAlertSettings,
      })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
