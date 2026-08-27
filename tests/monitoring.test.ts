import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { capSeriesPoints } from "../src/shared/monitoring.js";

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
    masterKey: Buffer.alloc(32, 53),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("monitoring downsample helpers", () => {
  it("keeps first and last points when capping above 480", () => {
    const points = Array.from({ length: 2000 }, (_, index) => ({ at: index }));
    const capped = capSeriesPoints(points, 480);
    expect(capped.length).toBeLessThanOrEqual(480);
    expect(capped.length).toBeGreaterThan(400);
    expect(capped[0]).toEqual({ at: 0 });
    expect(capped[capped.length - 1]).toEqual({ at: 1999 });
  });
});

describe("monitoring overview and service timeseries", () => {
  it("returns a DB-only overview, respects environment isolation, and caps service series", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitoring-"));
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
      const other = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "其他环境" } });
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
      const first = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("host-a") });
      const second = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("host-b") });
      const now = new Date().toISOString();
      const snapshot = JSON.stringify({
        cpuUsedPercent: 22.5,
        memoryUsedPercent: 41,
        disks: [{ path: "/", usedPercent: 70 }],
        operatingSystem: "linux",
        architecture: "amd64",
        resolutionSeconds: 30,
      });
      await db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, install_path, install_architecture, install_managed, installed_at, updated_at
        ) VALUES (?, ?, '0.1.4', 1, 'ready', 1, ?, '[]', '[]', '', ?, ?, '', '', 1, ?, ?)
      `).run(first.json().id, randomUUID(), snapshot, now, now, now, now);
      await db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, install_path, install_architecture, install_managed, installed_at, updated_at
        ) VALUES (?, '', '', 0, 'missing', 0, '{}', '[]', '[]', '', NULL, NULL, '', '', 0, NULL, ?)
      `).run(second.json().id, now);

      const extraNow = new Date().toISOString();
      const adminId = (await db.prepare("SELECT id FROM admin_users WHERE username = 'admin'").get() as { id: string }).id;
      for (let index = 0; index < 198; index += 1) {
        const connectionId = randomUUID();
        await db.prepare(`
          INSERT INTO ssh_connections (
            id, workspace_type, workspace_id, name, host, port, username, auth_type, credential_ciphertext, options_json, tags_json, source_deleted, created_at, updated_at
          ) VALUES (?, 'personal', ?, ?, '127.0.0.1', 22, 'operator', 'password', 'x', '{}', '[]', 0, ?, ?)
        `).run(connectionId, adminId, `bulk-${index}`, extraNow, extraNow);
        await db.prepare("INSERT INTO ssh_connection_environments (connection_id, environment_id) VALUES (?, ?)").run(connectionId, environmentId);
        await db.prepare(`
          INSERT INTO monitor_hosts (
            ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
            latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
            last_collected_at, last_pulled_at, install_path, install_architecture, install_managed, installed_at, updated_at
          ) VALUES (?, ?, '0.1.4', 1, 'ready', 1, ?, '[]', '[]', '', ?, ?, '', '', 1, ?, ?)
        `).run(connectionId, randomUUID(), snapshot, extraNow, extraNow, extraNow, extraNow);
      }

      const overview = await app.inject({ method: "GET", url: `/api/v1/monitoring/overview?environmentId=${environmentId}`, cookies });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().hosts.length).toBeLessThanOrEqual(200);
      expect(overview.json().summary.hostTotal).toBeGreaterThanOrEqual(200);
      expect(overview.json().hosts.some((item: { missing: boolean }) => item.missing)).toBe(true);
      expect(overview.json().hosts.find((item: { connectionName: string }) => item.connectionName === "host-a").cpuUsedPercent).toBeCloseTo(22.5);
      expect(overview.json().generatedAt).toBeTruthy();
      expect((await app.inject({ method: "GET", url: `/api/v1/monitoring/overview?environmentId=${randomUUID()}`, cookies })).statusCode).toBe(404);

      const service = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "api", description: "", status: "active" } });
      const deployment = await app.inject({
        method: "POST",
        url: `/api/v1/services/${service.json().id}/deployments`,
        cookies,
        payload: { sshConnectionId: first.json().id, provider: "systemd", externalId: "api.service", displayName: "api", origin: "manual" },
      });
      expect(deployment.statusCode).toBe(201);
      const collected = new Date().toISOString();
      await db.prepare(`
        INSERT INTO monitor_samples (
          ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at, resolution_seconds, payload_json, received_at
        ) VALUES (?, 'agent-1', 1, 1, ?, 30, ?, ?)
      `).run(first.json().id, collected, JSON.stringify({
        collectedAt: collected,
        host: { cpuUsedPercent: 10 },
        candidates: [{ provider: "systemd", externalId: "api.service", cpuUsedPercent: 8, memoryBytes: 128 }],
      }), collected);
      const series = await app.inject({ method: "GET", url: `/api/v1/monitoring/services/${service.json().id}/timeseries?range=1h`, cookies });
      expect(series.statusCode).toBe(200);
      expect(series.json().sampledPointCount).toBeLessThanOrEqual(480);
      expect(series.json().points[0].cpuUsedPercent).toBe(8);
      expect((await app.inject({ method: "GET", url: `/api/v1/monitoring/services/${randomUUID()}/timeseries?range=1h`, cookies })).statusCode).toBe(404);
      expect(other.statusCode).toBe(201);

      const stamped = new Date().toISOString();
      for (let index = 0; index < 501; index += 1) {
        await db.prepare(`
          INSERT INTO service_deployments (
            id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
            display_name, origin, status, state_detail, latest_metrics_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'host-a', 'systemd', ?, ?, 'manual', 'running', '', '{}', ?, ?)
        `).run(randomUUID(), service.json().id, first.json().id, `unit-${index}.service`, `unit-${index}`, stamped, stamped);
      }
      const crowded = await app.inject({ method: "GET", url: `/api/v1/monitoring/services/${service.json().id}/timeseries?range=30d`, cookies });
      expect(crowded.statusCode).toBe(200);
      expect(crowded.json().truncated).toBe(true);
      expect(crowded.json().deployments.length).toBeLessThanOrEqual(50);

      const agentId = randomUUID();
      for (let index = 0; index < 600; index += 1) {
        const collected = new Date(Date.now() - index * 60 * 60 * 1000).toISOString();
        await db.prepare(`
          INSERT INTO monitor_samples (
            ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at, resolution_seconds, payload_json, received_at
          ) VALUES (?, ?, ?, ?, ?, 30, ?, ?)
        `).run(first.json().id, agentId, index + 2, index + 2, collected, JSON.stringify({
          collectedAt: collected,
          host: { cpuUsedPercent: 12, topProcesses: Array.from({ length: 8 }, (_, processIndex) => ({ pid: processIndex + 1, name: `proc-${processIndex}`, cpuUsedPercent: 1 })) },
          candidates: [{ provider: "systemd", externalId: "api.service", cpuUsedPercent: 8, memoryBytes: 128 }],
        }), collected);
      }
      const month = await app.inject({ method: "GET", url: `/api/v1/monitoring/services/${service.json().id}/timeseries?range=30d`, cookies });
      expect(month.statusCode).toBe(200);
      expect(month.json().sampledPointCount).toBeLessThanOrEqual(480);
      expect(month.json().points.length).toBeLessThanOrEqual(480);
      if (month.json().points.length) {
        expect(month.json().points[0].at).toBeTruthy();
        expect(month.json().points.at(-1).at).toBeTruthy();
      }
    } finally {
      await app.close();
    }
  });
});
