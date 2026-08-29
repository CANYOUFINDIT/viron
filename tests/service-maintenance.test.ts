import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Server } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { PRODUCT_VERSION } from "../src/server/product-info.js";
import { pollMonitorHostsOnce } from "../src/server/service-monitor.js";
import { defaultMonitorAlertSettings } from "../src/shared/monitor-alerts.js";
import { operationHeaders, waitForOperation } from "./helpers/service-operations.js";

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
    masterKey: Buffer.alloc(32, 31),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

const kubernetesSourceId = "a".repeat(64);

function monitorPayload(kubernetesSelected = false, collectorUser?: string) {
  const collectedAt = new Date().toISOString();
  return {
    protocolVersion: 1,
    agentId: "d4f89c8e-23ae-4a21-a82a-2b204667be31",
    agentVersion: "0.1.4",
    hostname: "service-node-01",
    oldestSequence: 1,
    latestSequence: 1,
    throughSequence: 1,
    hasMore: false,
    samples: [{
      sequenceStart: 1,
      sequenceEnd: 1,
      collectedAt,
      resolutionSeconds: 30,
      payload: {
        collectedAt,
        resolutionSeconds: 30,
        sampleCount: 1,
        host: {
          hostname: "service-node-01",
          ...(collectorUser ? { collectorUser } : {}),
          ...(collectorUser === "root" ? { metricsVersion: 2 } : {}),
          operatingSystem: "linux",
          architecture: "amd64",
          kernelVersion: "6.8.0",
          cpuCount: 8,
          cpuUsedPercent: 23.5,
          load1: 0.6,
          load5: 0.7,
          load15: 0.5,
          memoryTotalBytes: 16_000_000_000,
          memoryUsedBytes: 8_000_000_000,
          memoryUsedPercent: 50,
          uptimeSeconds: 86_400,
          disks: [{ path: "/", device: "sda1", filesystem: "ext4", totalBytes: 100_000, freeBytes: 40_000, usedBytes: 60_000, usedPercent: 60 }],
          temperatures: [{ chip: "coretemp", feature: "Package id 0", celsius: 47 }],
        },
        candidates: [{
          provider: "systemd",
          externalId: "api.service",
          name: "api",
          status: "running",
          state: "active/running",
          pid: 321,
          cpuUsedPercent: 4.2,
          memoryBytes: 128_000_000,
          restartCount: 1,
          uptimeSeconds: 3600,
          metadata: { unitFileState: "enabled" },
        }, ...(kubernetesSelected ? [{
          provider: "kubernetes",
          externalId: `k8s:${"b".repeat(64)}`,
          name: "order-api",
          group: "development/default",
          status: "running",
          state: "3/3 ready · 3 updated · 0 unavailable",
          metadata: {
            kubeconfigSourceId: kubernetesSourceId,
            kubeconfigPath: "/home/operator/.kube/config",
            context: "development",
            cluster: "development-cluster",
            namespace: "default",
            resourceKind: "Deployment",
            desiredReplicas: 3,
            readyReplicas: 3,
            services: ["order-api"],
          },
        }] : [])],
        kubernetesConfigs: [{
          sourceId: kubernetesSourceId,
          path: "/home/operator/.kube/config",
          context: "development",
          cluster: "development-cluster",
          namespace: "default",
          currentContext: true,
          selected: kubernetesSelected,
          status: kubernetesSelected ? "connected" : "discovered",
          candidateCount: kubernetesSelected ? 1 : 0,
        }],
        errors: [],
      },
    }],
    gaps: [],
  };
}

async function startSshServer() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const commands: string[] = [];
  const scripts: string[] = [];
  const state = { monitorInstalled: true, kubernetesSelected: false, legacyKubernetesNull: false };
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "maintenance-secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          if (info.command === "/bin/sh -s") {
            let script = "";
            stream.on("data", (chunk: Buffer | string) => { script += chunk.toString(); });
            stream.on("end", () => {
              scripts.push(script);
              if (script.includes("exit 7")) {
                stream.stderr.write("script failed\n");
                stream.exit(7);
              } else {
                stream.write("script complete\n");
                stream.exit(0);
              }
              stream.end();
            });
            return;
          }
          if (info.command.includes("viron-monitor pull") && !state.monitorInstalled) {
            stream.exit(127);
            stream.end();
            return;
          }
          if (info.command.includes("configure-kubernetes")) {
            state.kubernetesSelected = true;
            stream.write('{"ok":true,"selectedContexts":1}\n');
          }
          else if (info.command.includes("viron-monitor pull")) {
            const payload = monitorPayload(state.kubernetesSelected);
            if (state.legacyKubernetesNull) {
              (payload.samples[0]!.payload as { kubernetesConfigs: unknown }).kubernetesConfigs = null;
            }
            stream.write(JSON.stringify(payload));
          }
          else if (info.command.includes("viron-monitor clear")) stream.write('{"ok":true,"cleared":{"samples":12,"gaps":2}}\n');
          else if (info.command.includes("systemctl restart")) stream.write("restart requested\n");
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port, commands, scripts, state };
}

describe("service maintenance", () => {
  it("migrates the SQLite deployment provider constraint to include Kubernetes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-maintenance-migration-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const initial = await openDatabase(config);
    await initial.close();

    const legacy = new Database(config.databasePath);
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      DROP TABLE service_deployments;
      CREATE TABLE service_deployments (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
        ssh_connection_name TEXT NOT NULL DEFAULT '',
        provider_type TEXT NOT NULL CHECK(provider_type IN ('systemd','docker','podman','supervisor','process')),
        external_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('discovered','manual')),
        status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('running','stopped','degraded','unknown','disabled')),
        state_detail TEXT NOT NULL DEFAULT '',
        latest_metrics_json TEXT NOT NULL DEFAULT '{}',
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const migrated = await openDatabase(config);
    try {
      const table = await migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'service_deployments'").get<{ sql: string }>();
      expect(table?.sql).toContain("'kubernetes'");
      expect((await migrated.prepare("PRAGMA table_info(services)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("sort_order");
      expect((await migrated.prepare("PRAGMA table_info(ssh_connection_environments)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("maintenance_sort_order");
    } finally {
      await migrated.close();
    }
  });

  it("persists administrator-defined service and maintenance host order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-maintenance-order-test-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "排序环境" } });
      const environmentId = environment.json().id as string;
      const sshPayload = (name: string) => ({
        environmentId,
        name,
        host: "127.0.0.1",
        port: 22,
        username: "operator",
        authType: "password",
        credential: { password: "maintenance-secret" },
        options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
      });
      const firstHost = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("宿主机 B") });
      const secondHost = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("宿主机 A") });
      const firstService = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "网关", description: "", status: "active" } });
      const secondService = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "任务", description: "", status: "active" } });
      const serviceIds = [firstService.json().id, secondService.json().id] as string[];
      const hostIds = [firstHost.json().id, secondHost.json().id] as string[];

      const initial = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(initial.json().services.map((item: { id: string }) => item.id)).toEqual(serviceIds);
      expect(initial.json().discovery.hosts.map((item: { sshConnectionId: string }) => item.sshConnectionId)).toEqual(hostIds);
      expect(initial.json().hosts).toBeUndefined();
      expect(initial.json().tlsEndpoints).toBeUndefined();
      expect(initial.headers.deprecation).toBe("true");
      expect(String(initial.headers.link ?? "")).toContain("/service-deployments");
      const lightweight = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/service-deployments`, cookies });
      expect(lightweight.statusCode).toBe(200);
      expect(lightweight.headers.deprecation).toBeUndefined();
      expect(lightweight.json().alertSettings).toBeUndefined();
      expect(JSON.stringify(lightweight.json())).not.toMatch(/scriptBody|tlsEndpoints|latest_host_json|snapshot/);

      const invalidServices = await app.inject({ method: "PUT", url: `/api/v1/environments/${environmentId}/services/order`, cookies, payload: { orderedIds: [serviceIds[0]] } });
      expect(invalidServices.statusCode).toBe(400);
      const invalidHosts = await app.inject({ method: "PUT", url: `/api/v1/environments/${environmentId}/maintenance-hosts/order`, cookies, payload: { orderedIds: [hostIds[0]] } });
      expect(invalidHosts.statusCode).toBe(400);

      expect((await app.inject({ method: "PUT", url: `/api/v1/environments/${environmentId}/services/order`, cookies, payload: { orderedIds: [...serviceIds].reverse() } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PUT", url: `/api/v1/environments/${environmentId}/maintenance-hosts/order`, cookies, payload: { orderedIds: [...hostIds].reverse() } })).statusCode).toBe(200);

      const reordered = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(reordered.json().services.map((item: { id: string }) => item.id)).toEqual([...serviceIds].reverse());
      expect(reordered.json().discovery.hosts.map((item: { sshConnectionId: string }) => item.sshConnectionId)).toEqual([...hostIds].reverse());

      const appendedService = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "报表", description: "", status: "active" } });
      const appendedHost = await app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies, payload: sshPayload("宿主机 C") });
      const withAppendedItems = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(withAppendedItems.json().services.map((item: { id: string }) => item.id)).toEqual([...serviceIds].reverse().concat(appendedService.json().id));
      expect(withAppendedItems.json().discovery.hosts.map((item: { sshConnectionId: string }) => item.sshConnectionId)).toEqual([...hostIds].reverse().concat(appendedHost.json().id));
    } finally {
      await app.close();
    }
  });

  it("routes monitor pull failures and recovery through host offline alerts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-maintenance-offline-alert-test-"));
    directories.push(directory);
    const ssh = await startSshServer();
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "拉取失败环境" } });
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "离线检测主机",
          host: "127.0.0.1",
          port: ssh.port,
          username: "operator",
          authType: "password",
          credential: { password: "maintenance-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const connectionId = connection.json().id as string;
      expect((await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies })).statusCode).toBe(200);
      expect((await app.inject({
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
      })).statusCode).toBe(200);

      ssh.state.monitorInstalled = false;
      await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items).toHaveLength(0);
      await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items[0]).toMatchObject({ ruleType: "host_offline", status: "active", details: { reason: "monitor_missing" } });

      ssh.state.monitorInstalled = true;
      await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies });
      await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies });
      expect((await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies })).json().items[0]).toMatchObject({ ruleType: "host_offline", status: "recovered", details: { reason: "healthy" } });
    } finally {
      await app.close();
      await new Promise<void>((resolve) => ssh.server.close(() => resolve()));
    }
  });

  it("scans a real SSH target, enrolls a candidate, links logs and runs a typed action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-maintenance-test-"));
    directories.push(directory);
    const ssh = await startSshServer();
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产环境" } });
      expect(environment.statusCode).toBe(201);
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "服务节点 01",
          host: "127.0.0.1",
          port: ssh.port,
          username: "operator",
          authType: "password",
          credential: { password: "maintenance-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      expect(connection.statusCode).toBe(201);
      const connectionId = connection.json().id as string;

      expect(await app.db.prepare("SELECT 1 FROM monitor_hosts WHERE ssh_connection_id = ?").get(connectionId)).toBeUndefined();
      ssh.state.legacyKubernetesNull = true;
      await pollMonitorHostsOnce(app);
      ssh.state.legacyKubernetesNull = false;
      expect(await app.db.prepare("SELECT status FROM monitor_hosts WHERE ssh_connection_id = ?").get(connectionId)).toEqual({ status: "ready" });
      expect(await app.db.prepare("SELECT latest_kubernetes_configs_json FROM monitor_hosts WHERE ssh_connection_id = ?").get(connectionId)).toEqual({ latest_kubernetes_configs_json: "[]" });

      const service = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "订单 API", description: "订单核心服务", status: "active" } });
      expect(service.statusCode).toBe(201);
      const serviceId = service.json().id as string;
      const refreshed = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().item).toMatchObject({ status: "ready", lastSequence: 1, retainedOnHost: true });
      const immediateCollect = ssh.commands.find((command) => command.includes("viron-monitor collect --quiet"));
      expect(immediateCollect).not.toContain("runuser");
      expect(immediateCollect).not.toContain("sudo");
      expect(immediateCollect).toContain("viron-monitor collect --quiet && viron-monitor pull");
      expect(immediateCollect).toContain(". /etc/viron-monitor/viron-monitor.env");
      if (process.platform !== "win32") expect(spawnSync("/bin/sh", ["-n", "-c", immediateCollect ?? ""]).status).toBe(0);

      const firstWorkspace = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(firstWorkspace.statusCode).toBe(200);
      expect(firstWorkspace.json()).toMatchObject({ canConfigure: true, canOperate: true });
      expect(firstWorkspace.json().hosts).toBeUndefined();
      expect(firstWorkspace.json().tlsEndpoints).toBeUndefined();
      expect(firstWorkspace.json().discovery.hosts[0]).toMatchObject({ monitorStatus: "ready", sshConnectionId: connectionId, candidateCount: expect.any(Number) });
      const firstCandidates = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/candidates`, cookies });
      expect(firstCandidates.json().item.candidates).toEqual([expect.objectContaining({ provider: "systemd", externalId: "api.service", status: "running" })]);
      expect(firstCandidates.json().item.kubernetesConfigs).toEqual([expect.objectContaining({ context: "development", selected: false, status: "discovered" })]);
      expect(firstCandidates.json().item.lastCollectedAt).toEqual(expect.any(String));
      expect(firstCandidates.json().item.snapshot).toEqual(expect.objectContaining({ hostname: expect.any(String) }));

      const configuredKubernetes = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/kubernetes-contexts`,
        cookies,
        payload: { selections: [{ sourceId: kubernetesSourceId, context: "development" }] },
      });
      expect(configuredKubernetes.statusCode).toBe(200);
      expect(ssh.commands.some((command) => command.includes("viron-monitor configure-kubernetes --selection-base64"))).toBe(true);
      const kubernetesCandidates = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/candidates`, cookies });
      expect(kubernetesCandidates.json().item.kubernetesConfigs).toEqual([expect.objectContaining({ context: "development", selected: true, status: "connected", candidateCount: 1 })]);
      expect(kubernetesCandidates.json().item.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "kubernetes", name: "order-api", status: "running" })]));

      const deployment = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/deployments`,
        cookies,
        payload: { sshConnectionId: connectionId, provider: "systemd", externalId: "api.service", displayName: "订单 API", origin: "discovered" },
      });
      expect(deployment.statusCode).toBe(201);
      const deploymentId = deployment.json().id as string;

      const manualKubernetesDeployment = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/deployments`,
        cookies,
        payload: { sshConnectionId: connectionId, provider: "kubernetes", externalId: `k8s:${"c".repeat(64)}`, displayName: "手工 Kubernetes", origin: "manual" },
      });
      expect(manualKubernetesDeployment.statusCode).toBe(400);

      const kubernetesDeployment = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/deployments`,
        cookies,
        payload: { sshConnectionId: connectionId, provider: "kubernetes", externalId: `k8s:${"b".repeat(64)}`, displayName: "订单 API Kubernetes", origin: "discovered" },
      });
      expect(kubernetesDeployment.statusCode).toBe(201);

      const log = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/logs`,
        cookies,
        payload: { sshConnectionId: connectionId, name: "订单 API 日志", filePaths: ["/var/log/order-api.log"] },
      });
      expect(log.statusCode).toBe(201);
      expect((await app.inject({ method: "PUT", url: `/api/v1/services/${serviceId}/logs`, cookies, payload: { logIds: [log.json().id] } })).statusCode).toBe(200);

      expect((await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies })).statusCode).toBe(200);
      const enrolledWorkspace = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(enrolledWorkspace.json().services[0]).toMatchObject({
        name: "订单 API",
        logIds: [log.json().id],
        deployments: expect.arrayContaining([
          expect.objectContaining({ provider: "systemd", externalId: "api.service", status: "running", state: "active/running" }),
          expect.objectContaining({ provider: "kubernetes", externalId: `k8s:${"b".repeat(64)}`, status: "running" }),
        ]),
      });
      const detail = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies });
      expect(detail.json().item.serviceCount).toBe(1);
      expect(detail.json().item.monitorHostCount).toBe(1);

      const serviceScriptAction = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/script-actions`,
        cookies,
        payload: { deploymentId: null, name: "发布", icon: "rocket", scriptBody: "printf 'service action\\n'" },
      });
      expect(serviceScriptAction.statusCode).toBe(201);
      const serviceScriptActionId = serviceScriptAction.json().id as string;
      const nodeScriptAction = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/script-actions`,
        cookies,
        payload: { deploymentId, name: "清缓存", icon: "zap", scriptBody: "printf 'node action\\n'" },
      });
      expect(nodeScriptAction.statusCode).toBe(201);
      const nodeScriptActionId = nodeScriptAction.json().id as string;
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/script-actions`,
        cookies,
        payload: { deploymentId, name: "清缓存", icon: "terminal", scriptBody: "true" },
      })).statusCode).toBe(409);

      const workspaceWithScriptActions = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(workspaceWithScriptActions.json().services[0]).toMatchObject({
        scriptActions: [expect.objectContaining({ id: serviceScriptActionId, deploymentId: null, name: "发布", icon: "rocket" })],
        deployments: expect.arrayContaining([
          expect.objectContaining({ id: deploymentId, scriptActions: [expect.objectContaining({ id: nodeScriptActionId, name: "清缓存", icon: "zap" })] }),
        ]),
      });
      expect(JSON.stringify(workspaceWithScriptActions.json())).not.toContain("printf 'service action");

      const executedServiceAction = await app.inject({ method: "POST", url: `/api/v1/service-script-actions/${serviceScriptActionId}/execute`, cookies, headers: operationHeaders(), payload: {} });
      expect(executedServiceAction.statusCode).toBe(202);
      const serviceOp = await waitForOperation(app, cookies, executedServiceAction.json().item.id);
      expect(serviceOp).toMatchObject({ status: "succeeded", result: { succeeded: 2, failed: 0 } });
      expect(ssh.scripts.filter((script) => script === "printf 'service action\\n'\n")).toHaveLength(2);
      expect(ssh.commands.filter((command) => command === "/bin/sh -s")).toHaveLength(2);
      expect(ssh.commands.some((command) => command.includes("service action"))).toBe(false);

      const executedNodeAction = await app.inject({ method: "POST", url: `/api/v1/service-script-actions/${nodeScriptActionId}/execute`, cookies, headers: operationHeaders(), payload: {} });
      expect(executedNodeAction.statusCode).toBe(202);
      const nodeOp = await waitForOperation(app, cookies, executedNodeAction.json().item.id);
      expect(nodeOp.result?.targets).toEqual([expect.objectContaining({ deploymentId, ok: true })]);
      expect(ssh.scripts).toContain("printf 'node action\\n'\n");

      expect((await app.inject({
        method: "PUT",
        url: `/api/v1/service-script-actions/${nodeScriptActionId}`,
        cookies,
        payload: { deploymentId, name: "清理缓存", icon: "hammer", scriptBody: "exit 7" },
      })).statusCode).toBe(200);
      const failedNodeAction = await app.inject({ method: "POST", url: `/api/v1/service-script-actions/${nodeScriptActionId}/execute`, cookies, headers: operationHeaders(), payload: {} });
      expect(failedNodeAction.statusCode).toBe(202);
      const failedOp = await waitForOperation(app, cookies, failedNodeAction.json().item.id);
      expect(failedOp).toMatchObject({ status: "failed", result: { succeeded: 0, failed: 1, targets: [expect.objectContaining({ ok: false, exitCode: 7 })] } });
      const scriptAudit = await app.db.prepare("SELECT details_json FROM audit_events WHERE resource_id = ? ORDER BY created_at DESC LIMIT 1").get(nodeScriptActionId) as { details_json: string };
      expect(scriptAudit.details_json).not.toContain("exit 7");
      expect(scriptAudit.details_json).not.toContain("script failed");

      const cleared = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/clear`, cookies });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ ok: true, cleared: { samples: 12, gaps: 2 } });
      expect(await app.db.prepare("SELECT COUNT(*) AS count FROM monitor_samples WHERE ssh_connection_id = ?").get(connectionId)).toEqual({ count: 1 });

      expect((await app.inject({
        method: "PUT",
        url: `/api/v1/services/${serviceId}`,
        cookies,
        payload: { name: "订单 API", description: "订单核心服务", status: "disabled" },
      })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/v1/service-script-actions/${serviceScriptActionId}/execute`, cookies })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `/api/v1/service-deployments/${deploymentId}/actions`, cookies, payload: { action: "restart" } })).statusCode).toBe(409);
      expect((await app.inject({
        method: "PUT",
        url: `/api/v1/services/${serviceId}`,
        cookies,
        payload: { name: "订单 API", description: "订单核心服务", status: "active" },
      })).statusCode).toBe(200);

      const restarted = await app.inject({ method: "POST", url: `/api/v1/service-deployments/${deploymentId}/actions`, cookies, headers: operationHeaders(), payload: { action: "restart" } });
      expect(restarted.statusCode).toBe(202);
      expect((await waitForOperation(app, cookies, restarted.json().item.id)).status).toBe("succeeded");
      expect(ssh.commands).toContain("systemctl restart -- 'api.service'");
      expect(ssh.commands.some((command) => command.includes("viron-monitor ack --through"))).toBe(false);
      expect(ssh.commands.some((command) => command.includes("viron-monitor clear"))).toBe(true);

      const unassigned = await app.inject({
        method: "POST",
        url: "/api/v1/connections/assign",
        cookies,
        payload: { environmentIds: [], items: [{ type: "ssh", id: connectionId }] },
      });
      expect(unassigned.statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/v1/service-deployments/${deploymentId}/actions`, cookies, payload: { action: "restart" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies })).json().services[0].deployments[0].connectionAvailable).toBe(false);

      expect((await app.inject({
        method: "POST",
        url: "/api/v1/connections/assign",
        cookies,
        payload: { environmentIds: [environmentId], items: [{ type: "ssh", id: connectionId }] },
      })).statusCode).toBe(200);
      await app.db.prepare("DELETE FROM monitor_hosts WHERE ssh_connection_id = ?").run(connectionId);
      ssh.state.monitorInstalled = false;
      const missing = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/monitor-hosts/${connectionId}/refresh`, cookies });
      expect(missing.statusCode).toBe(200);
      expect(missing.json().item).toMatchObject({ status: "missing", host: null, candidates: [] });
      const missingWorkspace = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(missingWorkspace.json().discovery.hosts[0]).toMatchObject({ monitorStatus: "missing" });
    } finally {
      await app.close();
      await new Promise<void>((resolve) => ssh.server.close(() => resolve()));
    }
  });
});
