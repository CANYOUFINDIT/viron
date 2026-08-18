import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { deduplicateMonitorStorage, monitorSampleIsFresh, selectMonitorPollCandidates, serializeMonitorAgentWork } from "../src/server/service-monitor.js";

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

function samplePayload(collectedAt: string, cpuUsedPercent: number, deploymentId: string, metriclessDeploymentId?: string) {
  return {
    collectedAt,
    resolutionSeconds: 30,
    sampleCount: 1,
    host: {
      hostname: "monitor-node",
      operatingSystem: "linux",
      architecture: "amd64",
      kernelVersion: "6.8.0",
      cpuCount: 8,
      cpuUsedPercent,
      load1: cpuUsedPercent / 10,
      load5: cpuUsedPercent / 12,
      load15: cpuUsedPercent / 15,
      memoryTotalBytes: 16_000_000_000,
      memoryUsedBytes: 8_000_000_000,
      memoryUsedPercent: 50,
      uptimeSeconds: 86_400,
      disks: [{ path: "/", device: "sda1", filesystem: "ext4", totalBytes: 100_000, freeBytes: 40_000, usedBytes: 60_000, usedPercent: 60 }],
      temperatures: [{ chip: "coretemp", feature: "Package", celsius: 47 }],
    },
    candidates: [{
      provider: "systemd",
      externalId: deploymentId,
      name: "api",
      status: "running",
      state: "active/running",
      cpuUsedPercent: 4.2,
      memoryBytes: 128_000_000,
      restartCount: 1,
      uptimeSeconds: 3600,
    }, ...(metriclessDeploymentId ? [{
      provider: "kubernetes",
      externalId: metriclessDeploymentId,
      name: "order-workload",
      status: "running",
      state: "3/3 ready",
      cpuUsedPercent: null,
      memoryBytes: null,
      restartCount: null,
      uptimeSeconds: null,
    }] : [])],
    kubernetesConfigs: [],
    errors: [],
  };
}

describe("monitor history", () => {
  it("judges sample freshness from the agent collection resolution", () => {
    const collectedAt = "2026-08-09T12:00:00.000Z";
    expect(monitorSampleIsFresh("2026-08-09T12:01:29.000Z", collectedAt, 30)).toBe(true);
    expect(monitorSampleIsFresh("2026-08-09T12:01:31.000Z", collectedAt, 30)).toBe(false);
    expect(monitorSampleIsFresh("2026-08-09T14:59:59.000Z", collectedAt, 3600)).toBe(true);
    expect(monitorSampleIsFresh("2026-08-09T15:00:01.000Z", collectedAt, 3600)).toBe(false);
    expect(monitorSampleIsFresh("invalid", collectedAt, 30)).toBe(false);
  });

  it("serializes storage for one physical agent while preserving workspace poll candidates", async () => {
    const now = Date.now();
    const dueAt = new Date(now - 120_000).toISOString();
    const candidates = selectMonitorPollCandidates([
      { ssh_connection_id: "personal", agent_id: "agent-a", workspace_type: "personal", workspace_id: "owner-a", install_managed: 1, status: "ready", last_pulled_at: dueAt, updated_at: dueAt },
      { ssh_connection_id: "organization", agent_id: "agent-a", workspace_type: "organization", workspace_id: "org-b", install_managed: 1, status: "ready", last_pulled_at: dueAt, updated_at: dueAt },
    ], now, 60);
    expect(candidates.map((row) => row.ssh_connection_id).sort()).toEqual(["organization", "personal"]);

    const app = {} as Parameters<typeof serializeMonitorAgentWork>[0];
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const run = (name: string) => serializeMonitorAgentWork(app, "agent-a", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      order.push(`${name}:end`);
      active -= 1;
    });
    await Promise.all([run("personal"), run("organization")]);

    expect(maximumActive).toBe(1);
    expect(order).toEqual(["personal:start", "personal:end", "organization:start", "organization:end"]);
  });

  it("polls a known agent once and only discovers unseen SSH connections", () => {
    const now = Date.now();
    const dueAt = new Date(now - 120_000).toISOString();
    const rows = selectMonitorPollCandidates([
      { ssh_connection_id: "managed", agent_id: "agent-a", workspace_type: "personal", workspace_id: "owner-a", install_managed: 1, status: "ready", last_pulled_at: dueAt, updated_at: dueAt },
      { ssh_connection_id: "duplicate", agent_id: "agent-a", workspace_type: "personal", workspace_id: "owner-a", install_managed: 0, status: "ready", last_pulled_at: dueAt, updated_at: dueAt },
      { ssh_connection_id: "other-workspace", agent_id: "agent-a", workspace_type: "organization", workspace_id: "org-b", install_managed: 0, status: "ready", last_pulled_at: dueAt, updated_at: dueAt },
      { ssh_connection_id: "unknown-a", agent_id: "", workspace_type: "personal", workspace_id: "owner-a", install_managed: 0, status: null, last_pulled_at: null, updated_at: null },
      { ssh_connection_id: "unknown-b", agent_id: "", workspace_type: "personal", workspace_id: "owner-a", install_managed: 0, status: null, last_pulled_at: null, updated_at: null },
      { ssh_connection_id: "known-missing", agent_id: "", workspace_type: "personal", workspace_id: "owner-a", install_managed: 0, status: "missing", last_pulled_at: dueAt, updated_at: dueAt },
      { ssh_connection_id: "known-error", agent_id: "", workspace_type: "personal", workspace_id: "owner-a", install_managed: 0, status: "error", last_pulled_at: dueAt, updated_at: dueAt },
    ], now, 60);

    expect(rows.map((row) => row.ssh_connection_id).sort()).toEqual(["managed", "other-workspace", "unknown-a", "unknown-b"]);
  });

  it("consolidates duplicate agent samples and exposes chart-ready dimensions through either connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-history-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "监控环境" } });
      const environmentId = environment.json().id as string;
      const createConnection = async (name: string) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/ssh-connections",
          cookies,
          payload: {
            environmentId,
            name,
            host: "192.0.2.10",
            port: 22,
            username: "root",
            authType: "password",
            credential: { password: "monitor-secret" },
            options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
          },
        });
        expect(response.statusCode).toBe(201);
        return response.json().id as string;
      };
      const managedConnectionId = await createConnection("托管连接");
      const duplicateConnectionId = await createConnection("重复连接");
      const isolatedConnectionId = await createConnection("其他工作空间连接");
      await app.db.prepare("UPDATE ssh_connections SET workspace_type = 'organization', workspace_id = 'isolated-workspace' WHERE id = ?")
        .run(isolatedConnectionId);
      const agentId = crypto.randomUUID();
      const previousAgentId = crypto.randomUUID();
      const serviceId = crypto.randomUUID();
      const deploymentId = crypto.randomUUID();
      const metriclessDeploymentId = crypto.randomUUID();
      const externalId = "api.service";
      const metriclessExternalId = "k8s:order-workload";
      const now = new Date().toISOString();
      const previousTime = new Date(Date.now() - 90_000).toISOString();
      const times = [new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 30_000).toISOString()];
      await app.db.prepare(`
        INSERT INTO services (id, environment_id, name, description, status, created_at, updated_at)
        VALUES (?, ?, '订单服务', '', 'active', ?, ?)
      `).run(serviceId, environmentId, now, now);
      await app.db.prepare(`
        INSERT INTO service_deployments (
          id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
          display_name, origin, status, state_detail, latest_metrics_json, created_at, updated_at
        ) VALUES (?, ?, ?, '托管连接', 'systemd', ?, '订单 API', 'discovered', 'running', 'active/running', '{}', ?, ?)
      `).run(deploymentId, serviceId, managedConnectionId, externalId, now, now);
      await app.db.prepare(`
        INSERT INTO service_deployments (
          id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
          display_name, origin, status, state_detail, latest_metrics_json, created_at, updated_at
        ) VALUES (?, ?, ?, '托管连接', 'kubernetes', ?, '订单工作负载', 'discovered', 'running', '3/3 ready', '{}', ?, ?)
      `).run(metriclessDeploymentId, serviceId, managedConnectionId, metriclessExternalId, now, now);
      for (const [connectionId, managed] of [[managedConnectionId, 1], [duplicateConnectionId, 0]] as const) {
        await app.db.prepare(`
          INSERT INTO monitor_hosts (
            ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
            latest_host_json, latest_candidates_json, latest_kubernetes_configs_json,
            last_error, last_collected_at, last_pulled_at, install_managed, updated_at
          ) VALUES (?, ?, '0.1.5', 1, 'ready', 2, '{}', '[]', '[]', '', ?, ?, ?, ?)
        `).run(connectionId, agentId, times[1], now, managed, now);
        for (let index = 0; index < times.length; index += 1) {
          const payload = samplePayload(times[index]!, 20 + index * 10, externalId, metriclessExternalId);
          await app.db.prepare(`
            INSERT INTO monitor_samples (
              ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at,
              resolution_seconds, payload_json, received_at
            ) VALUES (?, ?, ?, ?, ?, 30, ?, ?)
          `).run(connectionId, agentId, index + 1, index + 1, times[index], JSON.stringify(payload), now);
        }
        await app.db.prepare(`
          INSERT INTO monitor_samples (
            ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at,
            resolution_seconds, payload_json, received_at
          ) VALUES (?, ?, 1, 1, ?, 30, ?, ?)
        `).run(connectionId, previousAgentId, previousTime, JSON.stringify(samplePayload(previousTime, 10, externalId, metriclessExternalId)), now);
      }
      await app.db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json,
          last_error, last_collected_at, last_pulled_at, install_managed, updated_at
        ) VALUES (?, ?, '0.1.5', 1, 'ready', 2, '{}', '[]', '[]', '', ?, ?, 0, ?)
      `).run(isolatedConnectionId, agentId, times[1], now, now);
      for (let index = 0; index < times.length; index += 1) {
        const payload = samplePayload(times[index]!, 90 + index, externalId);
        await app.db.prepare(`
          INSERT INTO monitor_samples (
            ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at,
            resolution_seconds, payload_json, received_at
          ) VALUES (?, ?, ?, ?, ?, 30, ?, ?)
        `).run(isolatedConnectionId, agentId, index + 1, index + 1, times[index], JSON.stringify(payload), now);
      }

      await deduplicateMonitorStorage(app);
      const stored = await app.db.prepare(`
        SELECT COUNT(*) AS sample_count, COUNT(DISTINCT s.ssh_connection_id) AS connection_count
        FROM monitor_samples s JOIN ssh_connections c ON c.id = s.ssh_connection_id
        WHERE s.agent_id = ? AND c.workspace_type = 'personal'
      `).get(agentId) as { sample_count: number; connection_count: number };
      expect(Number(stored.sample_count)).toBe(2);
      expect(Number(stored.connection_count)).toBe(1);
      const isolatedStored = await app.db.prepare(`
        SELECT COUNT(*) AS sample_count, COUNT(DISTINCT s.ssh_connection_id) AS connection_count
        FROM monitor_samples s JOIN ssh_connections c ON c.id = s.ssh_connection_id
        WHERE s.agent_id = ? AND c.workspace_type = 'organization'
      `).get(agentId) as { sample_count: number; connection_count: number };
      expect(Number(isolatedStored.sample_count)).toBe(2);
      expect(Number(isolatedStored.connection_count)).toBe(1);
      const previousStored = await app.db.prepare(`
        SELECT COUNT(*) AS sample_count, COUNT(DISTINCT ssh_connection_id) AS connection_count
        FROM monitor_samples WHERE agent_id = ?
      `).get(previousAgentId) as { sample_count: number; connection_count: number };
      expect(Number(previousStored.sample_count)).toBe(1);
      expect(Number(previousStored.connection_count)).toBe(1);

      const environmentDetail = await app.inject({
        method: "GET",
        url: `/api/v1/environments/${environmentId}`,
        cookies,
      });
      expect(environmentDetail.statusCode).toBe(200);
      expect(environmentDetail.json().item.monitorHostCount).toBe(1);

      const history = await app.inject({
        method: "GET",
        url: `/api/v1/environments/${environmentId}/monitor-hosts/${duplicateConnectionId}/history?range=1h`,
        cookies,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({ sourceSampleCount: 3, sampledPointCount: 3 });
      expect(history.json().summary.cpu).toMatchObject({ average: 20, maximum: 30, latest: 30 });
      expect(history.json().diagnostics).toEqual([]);
      expect(history.json().points.map((point: { host: { cpuUsedPercent: number } }) => point.host.cpuUsedPercent)).toEqual([10, 20, 30]);
      expect(history.json().points[1].breakBefore).toBe(true);
      expect(history.json().points[0].host.disks[0]).toMatchObject({ path: "/", usedPercent: 60 });
      expect(history.json().points[0].host.temperatures[0]).toMatchObject({ chip: "coretemp", celsius: 47 });
      expect(history.json().points[0].host).toMatchObject({ topProcesses: [], cpuPressure: { someAvg10: 0 }, ioPressure: { someAvg10: 0 } });
      expect(history.json().deployments).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: deploymentId, name: "订单 API" }),
        expect.objectContaining({ id: metriclessDeploymentId, name: "订单工作负载" }),
      ]));
      expect(history.json().points[0].deployments).toEqual(expect.arrayContaining([
        expect.objectContaining({ deploymentId, cpuUsedPercent: 4.2 }),
        expect.objectContaining({
          deploymentId: metriclessDeploymentId,
          cpuUsedPercent: null,
          memoryBytes: null,
          restartCount: null,
          uptimeSeconds: null,
        }),
      ]));
    } finally {
      await app.close();
    }
  });
});
