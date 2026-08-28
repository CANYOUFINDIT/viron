import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { interruptStaleServiceOperations, mapWithConcurrency, runServiceOperation } from "../src/server/service-operations.js";
import {
  SERVICE_OPERATION_OUTPUT_LIMIT,
  capabilityDisabledReason,
  clipUtf8,
  deploymentCapabilities,
  kubernetesController,
} from "../src/shared/service-operations.js";
import type { FastifyRequest } from "fastify";
import { operationHeaders } from "./helpers/service-operations.js";

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
    masterKey: Buffer.alloc(32, 47),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("service operation capabilities", () => {
  it("exposes start/stop/restart for systemd docker podman supervisor", () => {
    expect(deploymentCapabilities("systemd")).toEqual(["start", "stop", "restart"]);
    expect(deploymentCapabilities("docker")).toEqual(["start", "stop", "restart"]);
    expect(deploymentCapabilities("process")).toEqual([]);
    expect(capabilityDisabledReason("process", "restart")).toContain("Runbook");
  });

  it("exposes kubernetes restart only for structured controllers", () => {
    expect(kubernetesController({ metadata: { resourceKind: "Deployment", name: "api", namespace: "prod" } })).toEqual({
      kind: "Deployment",
      name: "api",
      namespace: "prod",
    });
    expect(deploymentCapabilities("kubernetes", { metadata: { resourceKind: "Deployment", name: "api", namespace: "prod" } })).toEqual(["restart"]);
    expect(deploymentCapabilities("kubernetes", {})).toEqual([]);
  });
});

describe("service operation API contract", () => {
  it("enforces lightweight payload, idempotency, locks, interrupt, member 403 and capabilities", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-service-operations-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      expect((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_operation_runs'").get() as { name?: string } | undefined)?.name).toBe("service_operation_runs");
      expect((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_operation_locks'").get() as { name?: string } | undefined)?.name).toBe("service_operation_locks");

      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "ops-env" } });
      const environmentId = environment.json().id as string;
      const ssh = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "ops-host",
          host: "127.0.0.1",
          port: 22,
          username: "operator",
          authType: "password",
          credential: { password: "maintenance-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const connectionId = ssh.json().id as string;
      const service = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/services`,
        cookies,
        payload: { name: "api", description: "", status: "active" },
      });
      const serviceId = service.json().id as string;
      const systemd = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/deployments`,
        cookies,
        payload: { sshConnectionId: connectionId, provider: "systemd", externalId: "api.service", displayName: "api", origin: "manual" },
      });
      const processNode = await app.inject({
        method: "POST",
        url: `/api/v1/services/${serviceId}/deployments`,
        cookies,
        payload: { sshConnectionId: connectionId, provider: "process", externalId: "python app.py", displayName: "worker", origin: "manual" },
      });
      const k8sId = randomUUID();
      const stamped = new Date().toISOString();
      await db.prepare(`
        INSERT INTO service_deployments (
          id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
          display_name, origin, status, state_detail, latest_metrics_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'kubernetes', 'k8s:order', 'order', 'discovered', 'running', '', ?, ?, ?)
      `).run(
        k8sId,
        serviceId,
        connectionId,
        "ops-host",
        JSON.stringify({ metadata: { resourceKind: "Deployment", name: "order", namespace: "prod" } }),
        stamped,
        stamped,
      );

      const payload = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/service-deployments`, cookies });
      expect(payload.statusCode).toBe(200);
      expect(payload.json().hosts).toBeUndefined();
      expect(payload.json().tlsEndpoints).toBeUndefined();
      expect(payload.json().alertSettings).toBeUndefined();
      expect(payload.json().discovery.hosts[0]).toMatchObject({ sshConnectionId: connectionId, candidateCount: expect.any(Number) });
      expect(JSON.stringify(payload.json())).not.toContain("scriptBody");
      const systemdDto = payload.json().services[0].deployments.find((item: { provider: string }) => item.provider === "systemd");
      const processDto = payload.json().services[0].deployments.find((item: { provider: string }) => item.provider === "process");
      const k8sDto = payload.json().services[0].deployments.find((item: { provider: string }) => item.provider === "kubernetes");
      expect(systemdDto.capabilities).toEqual(["start", "stop", "restart"]);
      expect(processDto.capabilities).toEqual([]);
      expect(k8sDto.capabilities).toEqual(["restart"]);

      const alias = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      expect(alias.headers.deprecation).toBe("true");

      expect((await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${processNode.json().id}/actions`,
        cookies,
        headers: operationHeaders(),
        payload: { action: "restart" },
      })).statusCode).toBe(400);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${k8sId}/actions`,
        cookies,
        headers: operationHeaders(),
        payload: { action: "start" },
      })).statusCode).toBe(400);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${systemd.json().id}/actions`,
        cookies,
        payload: { action: "restart" },
      })).json().error).toBe("INVALID_IDEMPOTENCY_KEY");

      const now = new Date().toISOString();
      const adminId = (await db.prepare("SELECT id FROM admin_users WHERE username = 'admin'").get() as { id: string }).id;
      const blockingId = randomUUID();
      await db.prepare(`
        INSERT INTO service_operation_runs (
          id, workspace_type, workspace_id, environment_id, idempotency_key, request_hash, operation_type,
          resource_id, requested_by_user_id, status, progress_json, result_json, error_code,
          created_at, started_at, completed_at, updated_at
        ) VALUES (?, 'personal', ?, ?, ?, 'hash', 'deployment_action', ?, ?, 'running', '{}', '{}', '', ?, ?, NULL, ?)
      `).run(
        blockingId,
        adminId,
        environmentId,
        randomUUID().repeat(2).slice(0, 32),
        systemd.json().id,
        adminId,
        now,
        now,
        now,
      );
      await db.prepare(`
        INSERT INTO service_operation_locks (workspace_type, workspace_id, resource_key, operation_id, expires_at)
        VALUES ('personal', ?, ?, ?, ?)
      `).run(adminId, `deployment:${systemd.json().id}`, blockingId, new Date(Date.now() + 120_000).toISOString());
      const locked = await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${systemd.json().id}/actions`,
        cookies,
        headers: operationHeaders(),
        payload: { action: "restart" },
      });
      expect(locked.statusCode).toBe(409);
      expect(locked.json().error).toBe("OPERATION_IN_PROGRESS");

      await interruptStaleServiceOperations(app);
      expect(await db.prepare("SELECT status, error_code FROM service_operation_runs WHERE id = ?").get(blockingId)).toEqual({
        status: "interrupted",
        error_code: "INTERRUPTED_BY_RESTART",
      });
      expect(await db.prepare("SELECT 1 FROM service_operation_locks WHERE operation_id = ?").get(blockingId)).toBeUndefined();

      const key = `${randomUUID()}${randomUUID()}`.slice(0, 48);
      const first = await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${systemd.json().id}/actions`,
        cookies,
        headers: { "idempotency-key": key },
        payload: { action: "restart" },
      });
      expect(first.statusCode).toBe(202);
      const replay = await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${systemd.json().id}/actions`,
        cookies,
        headers: { "idempotency-key": key },
        payload: { action: "restart" },
      });
      expect(replay.statusCode).toBe(202);
      expect(replay.json().item.id).toBe(first.json().item.id);
      const conflict = await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${systemd.json().id}/actions`,
        cookies,
        headers: { "idempotency-key": key },
        payload: { action: "stop" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error).toBe("IDEMPOTENCY_KEY_REUSED");

      const memberRegistration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "ops-member", password: "member-password-123" } });
      const org = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "Ops Org", description: "" } });
      const organizationId = org.json().id as string;
      await db.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'member', ?, ?)").run(
        organizationId,
        memberRegistration.json().user.id,
        now,
        now,
      );
      const member = { envman_session: memberRegistration.cookies.find((item) => item.name === "envman_session")!.value };
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: member, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
      const memberForbidden = await app.inject({
        method: "POST",
        url: `/api/v1/service-deployments/${systemd.json().id}/actions`,
        cookies: member,
        headers: operationHeaders(),
        payload: { action: "restart" },
      });
      expect(memberForbidden.statusCode).toBe(403);
      expect(memberForbidden.json().error).toBe("WORKSPACE_ADMIN_REQUIRED");
    } finally {
      await app.close();
    }
  });

  it("clips stdout by UTF-8 bytes and keeps locks until the last worker finishes", async () => {
    const clipped = clipUtf8("测".repeat(6000), SERVICE_OPERATION_OUTPUT_LIMIT);
    expect(clipped.truncated).toBe(true);
    expect(Buffer.byteLength(clipped.text, "utf8")).toBeLessThanOrEqual(SERVICE_OPERATION_OUTPUT_LIMIT);

    const started: number[] = [];
    const assigned = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 4, async (item) => {
      started.push(item);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return item;
    }, { shouldContinue: () => started.length < 4 });
    expect(started.length).toBe(4);
    expect(assigned.filter((item) => item !== undefined)).toHaveLength(4);

    const events: string[] = [];
    await expect(mapWithConcurrency([0, 1, 2], 2, async (item) => {
      events.push(`start:${item}`);
      if (item === 0) throw new Error("worker failed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`finish:${item}`);
      return item;
    })).rejects.toThrow("worker failed");
    expect(events).toContain("finish:1");
    expect(events).not.toContain("start:2");

    const recovered = await mapWithConcurrency([0, 1, 2], 2, async (item) => {
      if (item === 0) throw new Error("progress write failed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `ok:${item}`;
    }, { onError: (_error, item) => `failed:${item}` });
    expect(recovered).toEqual(["failed:0", "ok:1", undefined]);

    const directory = mkdtempSync(join(tmpdir(), "viron-ops-timeout-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "timeout-env" } });
      const environmentId = environment.json().id as string;
      const adminId = (await db.prepare("SELECT id FROM admin_users WHERE username = 'admin'").get() as { id: string }).id;
      const operationId = randomUUID();
      const now = new Date().toISOString();
      await db.prepare(`
        INSERT INTO service_operation_runs (
          id, workspace_type, workspace_id, environment_id, idempotency_key, request_hash, operation_type,
          resource_id, requested_by_user_id, status, progress_json, result_json, error_code,
          created_at, started_at, completed_at, updated_at
        ) VALUES (?, 'personal', ?, ?, ?, 'hash', 'deployment_batch_action', ?, ?, 'queued', '{}', '{}', '', ?, NULL, NULL, ?)
      `).run(operationId, adminId, environmentId, randomUUID().repeat(2).slice(0, 32), environmentId, adminId, now, now);
      await db.prepare(`
        INSERT INTO service_operation_locks (workspace_type, workspace_id, resource_key, operation_id, expires_at)
        VALUES ('personal', ?, 'deployment:a', ?, ?)
      `).run(adminId, operationId, new Date(Date.now() + 120_000).toISOString());
      const request = {
        admin: { id: adminId, workspace: { type: "personal", id: adminId, role: "owner" } },
        ip: "127.0.0.1",
        url: "/api/v1/service-operations",
        headers: {},
        routeOptions: { url: "/api/v1/service-operations" },
      } as unknown as FastifyRequest;
      let locksWhileRunning = 0;
      await runServiceOperation(app, operationId, async (_onProgress, helpers) => {
        const items = [0, 1, 2, 3, 4, 5];
        let launched = 0;
        const assignedTargets = await mapWithConcurrency(items, 4, async (item) => {
          launched += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          locksWhileRunning = Number((await db.prepare("SELECT COUNT(*) AS count FROM service_operation_locks WHERE operation_id = ?").get(operationId) as { count: number | string }).count);
          return {
            deploymentId: `d-${item}`,
            targetName: `node-${item}`,
            connectionId: "c1",
            connectionName: "host",
            ok: true,
            exitCode: 0,
            durationMs: 15,
            errorCode: "",
            message: "",
            truncated: false,
            stdout: "测".repeat(6000),
          };
        }, { shouldContinue: () => launched < 4 && helpers.shouldContinue() });
        return items.map((item, index) => assignedTargets[index] ?? {
          deploymentId: `d-${item}`,
          targetName: `node-${item}`,
          connectionId: "c1",
          connectionName: "host",
          ok: false,
          exitCode: null,
          durationMs: 0,
          errorCode: "OPERATION_TIMEOUT",
          message: "未在时限内启动或完成",
          truncated: false,
        });
      }, request);
      expect(locksWhileRunning).toBeGreaterThan(0);
      expect(await db.prepare("SELECT 1 FROM service_operation_locks WHERE operation_id = ?").get(operationId)).toBeUndefined();
      const row = await db.prepare("SELECT status, error_code, result_json FROM service_operation_runs WHERE id = ?").get(operationId) as { status: string; error_code: string; result_json: string };
      expect(row.status).toBe("timed_out");
      expect(row.error_code).toBe("OPERATION_TIMEOUT");
      const result = JSON.parse(row.result_json) as { targets: Array<{ ok: boolean; truncated?: boolean; stdout?: string }> };
      expect(result.targets).toHaveLength(6);
      expect(result.targets.filter((item) => item.ok)).toHaveLength(4);
      expect(result.targets.filter((item) => !item.ok)).toHaveLength(2);
      expect(result.targets.some((item) => item.truncated)).toBe(true);
      expect(result.targets.every((item) => !item.stdout || Buffer.byteLength(item.stdout, "utf8") <= SERVICE_OPERATION_OUTPUT_LIMIT)).toBe(true);
      const audits = await db.prepare("SELECT action FROM audit_events WHERE resource_id = ? ORDER BY created_at").all(operationId) as Array<{ action: string }>;
      expect(audits.map((item) => item.action)).toEqual(["service_operation.started", "service_operation.timed_out"]);
    } finally {
      await app.close();
    }
  });
});
