import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../src/server/config.js";
import { buildApp } from "../../src/server/app.js";
import { ensureAdmin, type EnvmanDatabase } from "../../src/server/database.js";
import { clearMonitoringOverviewCache } from "../../src/server/monitoring-overview.js";
import { rangeMilliseconds, timeBucketMs } from "../../src/shared/monitoring.js";
import { installQueryCounter } from "./query-counter.js";

export function monitoringTestConfig(directory: string, mysql?: { host: string; port: number; database: string }): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: `${directory}/envman.db`,
    ...(mysql ? {
      databaseDriver: "mysql" as const,
      databaseHost: mysql.host,
      databasePort: mysql.port,
      databaseName: mysql.database,
      databaseUsername: "root",
      databasePassword: "test",
    } : {}),
    masterKey: Buffer.alloc(32, 53),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

const snapshot = JSON.stringify({
  cpuUsedPercent: 22.5,
  memoryUsedPercent: 41,
  disks: [{ path: "/", usedPercent: 70 }],
  operatingSystem: "linux",
  architecture: "amd64",
  resolutionSeconds: 30,
});

async function insertHost(
  db: EnvmanDatabase,
  connectionId: string,
  status: string,
  collectedAt: string | null,
  extraNow: string,
  hostJson = snapshot,
) {
  await db.prepare(`
    INSERT INTO monitor_hosts (
      ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
      latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
      last_collected_at, last_pulled_at, install_path, install_architecture, install_managed, installed_at, updated_at
    ) VALUES (?, ?, '0.1.4', 1, ?, 1, ?, '[]', '[]', '', ?, ?, '', '', 1, ?, ?)
  `).run(
    connectionId,
    status === "missing" ? "" : randomUUID(),
    status,
    status === "missing" ? "{}" : hostJson,
    collectedAt,
    collectedAt,
    collectedAt,
    extraNow,
  );
}

export async function runMonitoringContractSuite(config: AppConfig, db: EnvmanDatabase): Promise<{
  summary: Record<string, unknown>;
  firstPoint: string | null;
  lastPoint: string | null;
  truncated: boolean;
  dialect: string;
}> {
  await ensureAdmin(db, config);
  clearMonitoringOverviewCache();
  const app = await buildApp({ config, db, logger: false });
  try {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "监控环境" } });
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
    const first = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("host-a") });
    const second = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("host-b") });
    const now = new Date();
    const freshAt = now.toISOString();
    const staleAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    await insertHost(db, first.json().id, "ready", freshAt, freshAt);
    await insertHost(db, second.json().id, "missing", null, freshAt);

    const extraNow = freshAt;
    const adminId = (await db.prepare("SELECT id FROM admin_users WHERE username = 'admin'").get() as { id: string }).id;
    const bulkIds: string[] = [];
    for (let index = 0; index < 198; index += 1) {
      const connectionId = randomUUID();
      bulkIds.push(connectionId);
      await db.prepare(`
        INSERT INTO ssh_connections (
          id, workspace_type, workspace_id, name, host, port, username, auth_type, credential_ciphertext, options_json, tags_json, source_deleted, created_at, updated_at
        ) VALUES (?, 'personal', ?, ?, '127.0.0.1', 22, 'operator', 'password', 'x', '{}', '[]', 0, ?, ?)
      `).run(connectionId, adminId, `bulk-${index}`, extraNow, extraNow);
      await db.prepare("INSERT INTO ssh_connection_environments (connection_id, environment_id) VALUES (?, ?)").run(connectionId, environmentId);
      const collected = index === 0 ? staleAt : extraNow;
      const hostJson = index === 0
        ? JSON.stringify({ cpuUsedPercent: 5, memoryUsedPercent: 10, disks: [{ path: "/", usedPercent: 95 }], resolutionSeconds: 30 })
        : snapshot;
      await insertHost(db, connectionId, "ready", collected, extraNow, hostJson);
    }

    const counter = installQueryCounter(db);
    counter.reset();
    clearMonitoringOverviewCache();
    const overview = await app.inject({ method: "GET", url: `/api/v1/monitoring/overview?environmentId=${environmentId}&hostLimit=1`, cookies });
    const firstPageQueries = counter.count;
    expect(overview.statusCode).toBe(200);
    expect(overview.json().summary.hostTotal).toBeGreaterThanOrEqual(200);
    expect(overview.json().summary.hostStale).toBeGreaterThanOrEqual(1);
    expect(overview.json().summary.hostMissing).toBeGreaterThanOrEqual(1);
    expect(overview.json().summary.hostOnline).toBe(overview.json().summary.hostTotal - overview.json().summary.hostStale - overview.json().summary.hostMissing - overview.json().summary.hostOffline);
    expect(firstPageQueries).toBeLessThan(40);

    const pageTwo = await app.inject({
      method: "GET",
      url: `/api/v1/monitoring/overview?environmentId=${environmentId}&hostLimit=1&hostCursor=${overview.json().hosts[0].sshConnectionId}`,
      cookies,
    });
    expect(pageTwo.statusCode).toBe(200);
    expect(pageTwo.json().summary).toEqual(overview.json().summary);
    expect(pageTwo.json().hosts[0]?.sshConnectionId).not.toBe(overview.json().hosts[0]?.sshConnectionId);

    const service = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "api", description: "", status: "active" } });
    const serviceId = service.json().id as string;
    const deploymentA = await app.inject({
      method: "POST",
      url: `/api/v1/services/${serviceId}/deployments`,
      cookies,
      payload: { sshConnectionId: first.json().id, provider: "systemd", externalId: "api.service", displayName: "api-a", origin: "manual" },
    });
    const deploymentB = await app.inject({
      method: "POST",
      url: `/api/v1/services/${serviceId}/deployments`,
      cookies,
      payload: { sshConnectionId: bulkIds[1], provider: "systemd", externalId: "api.service", displayName: "api-b", origin: "manual" },
    });
    expect(deploymentA.statusCode).toBe(201);
    expect(deploymentB.statusCode).toBe(201);

    const bucketMs = timeBucketMs("1h");
    const bucketStart = Math.floor(now.getTime() / bucketMs) * bucketMs;
    const firstStamp = new Date(bucketStart + 120).toISOString();
    const secondStamp = new Date(bucketStart + 480).toISOString();
    await db.prepare(`
      INSERT INTO monitor_samples (
        ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at, resolution_seconds, payload_json, received_at
      ) VALUES (?, 'agent-a', 1, 1, ?, 30, ?, ?)
    `).run(first.json().id, firstStamp, JSON.stringify({
      collectedAt: firstStamp,
      candidates: [{ provider: "systemd", externalId: "api.service", cpuUsedPercent: 10, memoryBytes: 100 }],
    }), firstStamp);
    await db.prepare(`
      INSERT INTO monitor_samples (
        ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at, resolution_seconds, payload_json, received_at
      ) VALUES (?, 'agent-b', 1, 1, ?, 30, ?, ?)
    `).run(bulkIds[1], secondStamp, JSON.stringify({
      collectedAt: secondStamp,
      candidates: [{ provider: "systemd", externalId: "api.service", cpuUsedPercent: 20, memoryBytes: 200 }],
    }), secondStamp);
    const series = await app.inject({ method: "GET", url: `/api/v1/monitoring/services/${serviceId}/timeseries?range=1h`, cookies });
    expect(series.statusCode).toBe(200);
    expect(series.json().points.length).toBe(1);
    expect(series.json().points[0].cpuUsedPercent).toBeCloseTo(15);
    expect(series.json().points[0].memoryBytes).toBeCloseTo(150);
    expect(series.json().points[0].deployments[deploymentA.json().id].cpuUsedPercent).toBe(10);
    expect(series.json().points[0].deployments[deploymentB.json().id].cpuUsedPercent).toBe(20);

    const stamped = extraNow;
    for (let index = 0; index < 501; index += 1) {
      await db.prepare(`
        INSERT INTO service_deployments (
          id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
          display_name, origin, status, state_detail, latest_metrics_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'host-a', 'systemd', ?, ?, 'manual', 'running', '', '{}', ?, ?)
      `).run(randomUUID(), serviceId, first.json().id, `unit-${index}.service`, `unit-${index}`, stamped, stamped);
    }
    const crowded = await app.inject({ method: "GET", url: `/api/v1/monitoring/services/${serviceId}/timeseries?range=30d`, cookies });
    expect(crowded.statusCode).toBe(200);
    expect(crowded.json().truncated).toBe(true);
    expect(crowded.json().deployments.length).toBeLessThanOrEqual(50);

    const monthBucket = timeBucketMs("30d");
    const agentId = randomUUID();
    const monthPoints = 600;
    const oldest = new Date(now.getTime() - (monthPoints - 1) * monthBucket);
    for (let index = 0; index < monthPoints; index += 1) {
      if (index >= 200 && index <= 210) continue;
      const collected = new Date(oldest.getTime() + index * monthBucket).toISOString();
      await db.prepare(`
        INSERT INTO monitor_samples (
          ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at, resolution_seconds, payload_json, received_at
        ) VALUES (?, ?, ?, ?, ?, 30, ?, ?)
      `).run(first.json().id, agentId, index + 2, index + 2, collected, JSON.stringify({
        collectedAt: collected,
        host: { cpuUsedPercent: 12 },
        candidates: [{ provider: "systemd", externalId: "api.service", cpuUsedPercent: 8, memoryBytes: 128 }],
      }), collected);
    }
    const month = await app.inject({ method: "GET", url: `/api/v1/monitoring/services/${serviceId}/timeseries?range=30d`, cookies });
    expect(month.statusCode).toBe(200);
    expect(month.json().sampledPointCount).toBeLessThanOrEqual(480);
    expect(month.json().points.length).toBeLessThanOrEqual(480);
    const points = month.json().points as Array<{ at: string; breakBefore?: boolean }>;
    const rangeStart = now.getTime() - rangeMilliseconds["30d"];
    expect(Date.parse(points[0]!.at)).toBeGreaterThanOrEqual(rangeStart - monthBucket);
    expect(Date.parse(points[0]!.at)).toBeLessThan(rangeStart + monthBucket * 4);
    expect(Date.parse(points.at(-1)!.at)).toBeGreaterThan(Date.parse(points[0]!.at));
    expect(points.some((point) => point.breakBefore)).toBe(true);

    return {
      summary: overview.json().summary,
      firstPoint: points[0]?.at ?? null,
      lastPoint: points.at(-1)?.at ?? null,
      truncated: crowded.json().truncated,
      dialect: db.dialect,
    };
  } finally {
    await app.close();
  }
}
