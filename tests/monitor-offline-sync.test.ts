import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { clearMonitoringOverviewCache } from "../src/server/monitoring-overview.js";
import { evaluateMonitorHostAvailability } from "../src/server/monitor-alerts.js";
import { pollMonitorHostsOnce, selectMonitorPollCandidates, syncMonitorHost } from "../src/server/service-monitor.js";
import { executeSshCommand } from "../src/server/ssh/command.js";
import { defaultMonitorAlertSettings } from "../src/shared/monitor-alerts.js";
import { monitoringTestConfig } from "./helpers/monitoring-harness.js";

vi.mock("../src/server/ssh/command.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/ssh/command.js")>(),
  executeSshCommand: vi.fn(),
}));

const execute = vi.mocked(executeSshCommand);
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  clearMonitoringOverviewCache();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function response(agentId: string, collectedAt: string, resolutionSeconds = 30) {
  return {
    protocolVersion: 1, agentId, agentVersion: "0.1.9", hostname: "monitor-node",
    oldestSequence: 1, latestSequence: 1, throughSequence: 1, hasMore: false,
    samples: [{
      sequenceStart: 1, sequenceEnd: 1, collectedAt, resolutionSeconds,
      payload: {
        collectedAt, resolutionSeconds, sampleCount: 1,
        host: {
          hostname: "monitor-node", cpuCount: 4, cpuUsedPercent: 10,
          load1: 1, load5: 1, load15: 1, memoryTotalBytes: 1000,
          memoryUsedBytes: 500, memoryUsedPercent: 50, uptimeSeconds: 3600,
          disks: [], temperatures: [],
        },
        candidates: [], kubernetesConfigs: [], errors: [],
      },
    }],
    gaps: [],
  };
}

function commandResult(payload: unknown) {
  return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0, signal: null, durationMs: 1, truncated: false };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "viron-offline-sync-"));
  directories.push(directory);
  const config = { ...monitoringTestConfig(directory), monitorPullIntervalSeconds: 3600 };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Monitor test" } });
  const environmentId = environment.json().id as string;
  const createConnection = async (name: string) => {
    const result = await app.inject({
      method: "POST", url: "/api/v1/ssh-connections", cookies,
      payload: { environmentId, name, host: "127.0.0.1", port: 22, username: "operator", authType: "password", credential: { password: "test-secret" }, options: {} },
    });
    expect(result.statusCode).toBe(201);
    return result.json().id as string;
  };
  const connectionId = await createConnection("monitor-node");
  expect((await app.inject({
    method: "PUT", url: `/api/v1/environments/${environmentId}/monitor-alert-settings`, cookies,
    payload: { ...defaultMonitorAlertSettings, enabled: true, hostOfflineEnabled: true },
  })).statusCode).toBe(200);
  return { app, db, cookies, environmentId, connectionId, createConnection };
}

describe("monitor transport failures and collection availability", () => {
  it("retries a handshake once, preserves fresh telemetry, and reports a connection fault without an offline alert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-09T06:00:00.000Z");
    const { app, db, cookies, environmentId, connectionId } = await fixture();
    try {
      const payload = response(randomUUID(), new Date().toISOString());
      execute.mockRejectedValueOnce(new Error("Timed out while waiting for handshake"))
        .mockResolvedValueOnce(commandResult(payload));
      await expect(syncMonitorHost(app, connectionId, false)).resolves.toMatchObject({ status: "ready" });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls.map((call) => call[3]?.connectTimeoutSeconds)).toEqual([45, 60]);
      execute.mockClear().mockRejectedValue(new Error("All configured authentication methods failed"));
      for (const seconds of [30, 60]) {
        vi.setSystemTime(Date.parse(payload.samples[0]!.collectedAt) + seconds * 1000);
        await expect(syncMonitorHost(app, connectionId, false)).rejects.toThrow("authentication");
      }
      expect(execute).toHaveBeenCalledTimes(2); // Authentication failures are not retried.
      expect(await db.prepare("SELECT COUNT(*) AS count FROM monitor_alerts WHERE rule_type = 'host_offline'").get()).toEqual({ count: 0 });
      clearMonitoringOverviewCache();
      const overview = (await app.inject({ method: "GET", url: "/api/v1/monitoring/overview", cookies })).json();
      expect(overview.summary).toMatchObject({ hostOffline: 0, hostUnreachable: 1, hostMissing: 0 });
      expect(overview.hosts[0]).toMatchObject({ probeState: "unreachable", probeInstalled: true, offline: false, cpuUsedPercent: 10 });
      const host = (await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/candidates`, cookies })).json().item;
      expect(host).toMatchObject({ probeState: "unreachable", monitorOffline: false, snapshot: { cpuUsedPercent: 10 } });
      const services = (await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/service-deployments`, cookies })).json();
      expect(services.discovery.hosts[0]).toMatchObject({ probeState: "unreachable" });
      execute.mockClear().mockRejectedValue(new Error("Timed out while waiting for handshake"));
      vi.setSystemTime(Date.parse(payload.samples[0]!.collectedAt) + 90_000);
      await expect(syncMonitorHost(app, connectionId, false)).rejects.toThrow("handshake");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(await db.prepare("SELECT COUNT(*) AS count FROM monitor_alerts WHERE rule_type = 'host_offline'").get()).toEqual({ count: 0 });
      execute.mockRejectedValue(new Error("All configured authentication methods failed"));
      for (const minutes of [31, 32]) {
        vi.setSystemTime(Date.parse(payload.samples[0]!.collectedAt) + minutes * 60_000);
        await expect(syncMonitorHost(app, connectionId, false)).rejects.toThrow("authentication");
      }
      const alerts = (await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items;
      expect(alerts).toEqual([expect.objectContaining({ ruleType: "host_offline", status: "active" })]);
      clearMonitoringOverviewCache();
      const staleOverview = (await app.inject({ method: "GET", url: "/api/v1/monitoring/overview", cookies })).json();
      expect(staleOverview.summary.hostOffline).toBe(1);
      expect(staleOverview.hosts[0].probeState).toBe("offline");
    } finally { await app.close(); }
  });

  it("keeps the collection interval after an empty pull and uses a healthy alias to prevent false alerts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-09T06:00:00.000Z");
    const { app, db, cookies, connectionId, createConnection } = await fixture();
    try {
      const agentId = randomUUID();
      const payload = response(agentId, "2026-10-09T04:30:00.000Z", 3600);
      execute.mockResolvedValueOnce(commandResult(payload));
      await syncMonitorHost(app, connectionId, false);
      vi.setSystemTime(Date.now() + 60_000);
      execute.mockResolvedValueOnce(commandResult({ ...payload, samples: [] }));
      await syncMonitorHost(app, connectionId, false);
      expect(JSON.parse((await db.prepare("SELECT latest_host_json FROM monitor_hosts WHERE ssh_connection_id = ?").get(connectionId) as { latest_host_json: string }).latest_host_json).resolutionSeconds).toBe(3600);
      expect(await db.prepare("SELECT breach_count FROM monitor_alert_states WHERE rule_type = 'host_offline'").get()).toEqual({ breach_count: 0 });
      clearMonitoringOverviewCache();
      expect((await app.inject({ method: "GET", url: "/api/v1/monitoring/overview", cookies })).json().hosts[0]).toMatchObject({ probeState: "online", stale: false });
      const alias = await createConnection("monitor-alias");
      execute.mockResolvedValueOnce(commandResult(response(agentId, new Date().toISOString())));
      await syncMonitorHost(app, alias, false);
      const staleAt = "2026-10-09T04:00:00.000Z";
      await db.prepare("UPDATE monitor_hosts SET status = 'error', last_collected_at = ? WHERE ssh_connection_id = ?").run(staleAt, connectionId);
      for (const seconds of [30, 60]) {
        await evaluateMonitorHostAvailability(app, { connectionId, checkedAt: new Date(Date.now() + seconds * 1000).toISOString(), available: false, status: "error", reason: "pull_failed", lastCollectedAt: staleAt });
      }
      expect(await db.prepare("SELECT COUNT(*) AS count FROM monitor_alerts WHERE rule_type = 'host_offline'").get()).toEqual({ count: 0 });
      // A fresh copy in another workspace must not hide a failure in this one.
      await db.prepare("UPDATE ssh_connections SET workspace_id = ? WHERE id = ?").run(randomUUID(), alias);
      for (const seconds of [90, 120]) {
        await evaluateMonitorHostAvailability(app, { connectionId, checkedAt: new Date(Date.now() + seconds * 1000).toISOString(), available: false, status: "error", reason: "pull_failed", lastCollectedAt: staleAt, sampleResolutionSeconds: 30 });
      }
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("prioritizes known probes and retries their failures on the regular interval", () => {
    const now = Date.now();
    const previous = new Date(now - 120_000).toISOString();
    const base = { workspace_type: "personal", workspace_id: "test", install_managed: 0, last_pulled_at: previous, updated_at: previous };
    const selected = selectMonitorPollCandidates([
      { ...base, ssh_connection_id: "discovery", agent_id: "", status: null },
      { ...base, ssh_connection_id: "failed-probe", agent_id: "agent-1", status: "error" },
      { ...base, ssh_connection_id: "failed-discovery", agent_id: "", status: "error" },
    ], now, 60);
    expect(selected.map((item) => item.ssh_connection_id)).toEqual(["failed-probe", "discovery"]);
  });

  it("refreshes known telemetry before a bounded batch of unmonitored connections", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-09T06:00:00.000Z");
    const { app, connectionId, createConnection } = await fixture();
    try {
      execute.mockResolvedValueOnce(commandResult(response(randomUUID(), new Date().toISOString())));
      await syncMonitorHost(app, connectionId, false);
      const discoveries = [];
      for (let index = 0; index < 5; index += 1) discoveries.push(await createConnection(`discovery-${index}`));
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
      execute.mockClear().mockRejectedValue(new Error("All configured authentication methods failed"));
      await pollMonitorHostsOnce(app);
      expect(execute.mock.calls[0]![1]).toBe(connectionId);
      expect(execute.mock.calls).toHaveLength(5);
      expect(execute.mock.calls.filter((call) => discoveries.includes(call[1]))).toHaveLength(4);
    } finally { await app.close(); }
  });
});
