import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { SERVICE_DEPLOYMENTS_MAX_BYTES, utf8ByteLength } from "../src/shared/service-operations.js";

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

describe("service deployments payload pagination", () => {
  it("pages services first and returns every deployment across cursors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-payload-page-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "payload-env" } });
      const environmentId = environment.json().id as string;
      const ssh = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "payload-host",
          host: "127.0.0.1",
          port: 22,
          username: "operator",
          authType: "password",
          credential: { password: "payload-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const connectionId = ssh.json().id as string;
      const firstService = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "svc-a", description: "", status: "active" } });
      const secondService = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/services`, cookies, payload: { name: "svc-b", description: "", status: "active" } });
      const stamped = new Date().toISOString();
      for (const [serviceId, count] of [[firstService.json().id as string, 300], [secondService.json().id as string, 250]] as const) {
        for (let index = 0; index < count; index += 1) {
          await db.prepare(`
            INSERT INTO service_deployments (
              id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
              display_name, origin, status, state_detail, latest_metrics_json, created_at, updated_at
            ) VALUES (?, ?, ?, 'payload-host', 'systemd', ?, ?, 'manual', 'running', '', '{}', ?, ?)
          `).run(randomUUID(), serviceId, connectionId, `${serviceId}-${index}`, `${serviceId}-${index}`, stamped, stamped);
        }
      }

      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 8; page += 1) {
        const url = `/api/v1/environments/${environmentId}/service-deployments${cursor ? `?cursor=${cursor}` : ""}`;
        const response = await app.inject({ method: "GET", url, cookies });
        expect(response.statusCode).toBe(200);
        expect(utf8ByteLength(response.body)).toBeLessThanOrEqual(SERVICE_DEPLOYMENTS_MAX_BYTES);
        const payload = response.json() as { services: Array<{ id: string; deployments: Array<{ id: string }> }>; nextCursor: string | null };
        for (const service of payload.services) {
          for (const deployment of service.deployments) seen.add(`${service.id}:${deployment.id}`);
        }
        if (!payload.nextCursor || payload.nextCursor === cursor) break;
        cursor = payload.nextCursor;
      }
      expect(seen.size).toBe(550);
    } finally {
      await app.close();
    }
  });

  it("enforces a UTF-8 1 MiB ceiling including discovery hosts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-payload-bytes-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "字节环境" } });
      const environmentId = environment.json().id as string;
      const adminId = (await db.prepare("SELECT id FROM admin_users WHERE username = 'admin'").get() as { id: string }).id;
      const now = new Date().toISOString();
      const fatName = "主机名称".repeat(2000);
      for (let index = 0; index < 200; index += 1) {
        const connectionId = randomUUID();
        await db.prepare(`
          INSERT INTO ssh_connections (
            id, workspace_type, workspace_id, name, host, port, username, auth_type, credential_ciphertext, options_json, tags_json, source_deleted, created_at, updated_at
          ) VALUES (?, 'personal', ?, ?, '127.0.0.1', 22, 'operator', 'password', 'x', '{}', '[]', 0, ?, ?)
        `).run(connectionId, adminId, `${fatName}-${index}`, now, now);
        await db.prepare("INSERT INTO ssh_connection_environments (connection_id, environment_id) VALUES (?, ?)").run(connectionId, environmentId);
        await db.prepare(`
          INSERT INTO monitor_hosts (
            ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
            latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
            last_collected_at, last_pulled_at, install_path, install_architecture, install_managed, installed_at, updated_at
          ) VALUES (?, ?, '0.1.4', 1, 'ready', 1, '{}', ?, '[]', '', ?, ?, '', '', 1, ?, ?)
        `).run(connectionId, randomUUID(), JSON.stringify(Array.from({ length: 40 }, (_, candidate) => ({
          provider: "docker",
          externalId: `${fatName}-c${candidate}`,
          name: fatName,
        }))), now, now, now, now);
      }
      const response = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/service-deployments`, cookies });
      expect([200, 413]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        expect(utf8ByteLength(response.body)).toBeLessThanOrEqual(SERVICE_DEPLOYMENTS_MAX_BYTES);
        expect(response.json().truncated).toBe(true);
      } else {
        expect(response.json().error).toBe("PAYLOAD_TOO_LARGE");
      }
    } finally {
      await app.close();
    }
  });
});
