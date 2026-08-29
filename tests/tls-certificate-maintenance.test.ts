import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { evaluateTlsEndpointAlerts } from "../src/server/monitor-alerts.js";

const directories: string[] = [];
const leafPem = `-----BEGIN CERTIFICATE-----
MIIC5DCCAcygAwIBAgIJAPF8qfu29bACMA0GCSqGSIb3DQEBCwUAMBoxGDAWBgNV
BAMMD2FwcC5leGFtcGxlLmNvbTAeFw0yNjA4MjYxMjE5NDBaFw0yNjA5MjUxMjE5
NDBaMBoxGDAWBgNVBAMMD2FwcC5leGFtcGxlLmNvbTCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAL/QP2J3Zcba68aq5mvmuDikBzLpP2O1vnFZA5n4zuEx
2+jI0AF3YnI1bkWzVy5bGMTJ9PtshupyslJEpsmec0kpKf94NJBoe7nkclxC70UI
X/Klvx7A5tuBHPkUXD5B3/RZZ7zill0q11ufa9qOknlsVyTh52yO8iwmYA2dBaCb
b0kl6yTLXk64Yc2AaRVpiFuYBJocZpJ7qs3qldINtUsNFdIljg3Iy3GXa/Xs1QX9
NB29ebZwZPgpvBsixT1izpt2kUIxyYSqk6AghaUFdBzfaN9G1/n9KkZuKGNWCUfN
0EWI7wi1d0XLgx/KnYPvFkBPSFDo5mlos/XXIOO2vEECAwEAAaMtMCswKQYDVR0R
BCIwIIIPYXBwLmV4YW1wbGUuY29tgg0qLmV4YW1wbGUuY29tMA0GCSqGSIb3DQEB
CwUAA4IBAQAEGoqI/xm6ucV34O5h6l1cr9MYA2/P69IYkl87GDIyxEfYefUk/paa
9y2z8/C668Ym6Z9PxksU3GeffJ6TJBhVZDd9hgCqVGDflEymUMAtur6rpKKBO6MV
KicZWAVUBhrwrZhWSTS7bokJls8u2HAfDC2Vb3MgvSKTjCJB+kURG2wBuA+7ty97
K59yO7apswVh3AZTTxaSJLIq00gtm+LKN19vbUhEheJxkxToxl1Ka2GDj62x99Lv
D0ts+GliXAOz6LRrlzF1lzGH/eZ8Q8faeglZCm6wTvJ5imym20AVyPkSks/A2tXn
Ora+Pq14wMcIueA5/E+kx6/T7zRjA1Z6
-----END CERTIFICATE-----`;

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
    masterKey: Buffer.alloc(32, 44),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function startSshServer() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const commands: string[] = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "tls-secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          if (info.command.includes("openssl s_client")) {
            stream.write(`${leafPem}\nVerify return code: 18 (self signed certificate)\n`);
            stream.exit(0);
          } else stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port, commands };
}

describe("TLS certificate maintenance", () => {
  it("auto-binds a web origin when exactly one SSH host name matches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-tls-autobind-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "证书环境" } });
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "证书主机",
          host: "app.example.com",
          port: 22,
          username: "operator",
          authType: "password",
          credential: { password: "tls-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      expect(connection.statusCode).toBe(201);
      const web = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/web-entries`,
        cookies,
        payload: { name: "后台", url: "https://app.example.com/admin", description: "", tags: [] },
      });
      expect(web.statusCode).toBe(201);
      expect(web.json()).toMatchObject({ tlsEndpointId: expect.any(String), tlsProbeReady: true });
      const endpoint = await app.inject({ method: "GET", url: `/api/v1/tls-endpoints/${web.json().tlsEndpointId}`, cookies });
      expect(endpoint.statusCode).toBe(200);
      expect(endpoint.json().item).toMatchObject({
        host: "app.example.com",
        port: 443,
        sshConnectionId: connection.json().id,
        source: "web_entry",
      });
      const listed = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/web-entries`, cookies });
      expect(listed.json().items[0].tls).toEqual(expect.objectContaining({
        endpointId: expect.any(String),
      }));
    } finally {
      await app.close();
    }
  });

  it("probes a bound endpoint over SSH and raises certificate expiry alerts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-tls-probe-"));
    directories.push(directory);
    const ssh = await startSshServer();
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "证书探测环境" } });
      const environmentId = environment.json().id as string;
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies,
        payload: {
          environmentId,
          name: "本机 SSH",
          host: "127.0.0.1",
          port: ssh.port,
          username: "operator",
          authType: "password",
          credential: { password: "tls-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      expect(connection.statusCode).toBe(201);
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/tls-endpoints`,
        cookies,
        payload: { host: "127.0.0.1", port: 443, sni: "app.example.com", sshConnectionId: connection.json().id },
      });
      expect(created.statusCode).toBe(201);
      const endpointId = created.json().id as string;
      const probed = await app.inject({ method: "POST", url: `/api/v1/tls-endpoints/${endpointId}/probe`, cookies });
      expect(probed.statusCode).toBe(200);
      expect(probed.json().item).toMatchObject({
        probeStatus: "ok",
        leafCn: "app.example.com",
        isSelfSigned: true,
        hostnameMatch: true,
      });
      expect(ssh.commands.some((command) => command.includes("openssl s_client") && command.includes("127.0.0.1:443"))).toBe(true);

      await app.db.prepare("UPDATE tls_endpoints SET days_remaining = 3, not_after = ? WHERE id = ?")
        .run(new Date(Date.now() + 3 * 86_400_000).toISOString(), endpointId);
      const settingsPut = await app.inject({
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
          diskMissingEnabled: false,
          tlsEnabled: true,
          tlsWarnDays: 14,
          tlsHostnameMismatchEnabled: true,
          excludedDisks: [],
        },
      });
      expect(settingsPut.statusCode).toBe(200);
      await evaluateTlsEndpointAlerts(app, environmentId);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await evaluateTlsEndpointAlerts(app, environmentId);
      const alerts = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(alerts.json().items.some((item: { ruleType: string; status: string }) => item.ruleType === "tls_expiring" && item.status === "active")).toBe(true);

      const monitorOff = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies,
        payload: {
          section: "monitor",
          enabled: false,
          cpuEnabled: false,
          cpuThreshold: 90,
          memoryEnabled: false,
          memoryThreshold: 90,
          diskUsageEnabled: false,
          diskUsageThreshold: 90,
          temperatureEnabled: false,
          temperatureThreshold: 80,
          deploymentStatusEnabled: false,
          diskMissingEnabled: false,
          excludedDisks: [],
        },
      });
      expect(monitorOff.statusCode).toBe(200);
      const stillActive = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(stillActive.json().items.some((item: { ruleType: string; status: string }) => item.ruleType === "tls_expiring" && item.status === "active")).toBe(true);

      const tlsOff = await app.inject({
        method: "PUT",
        url: `/api/v1/environments/${environmentId}/monitor-alert-settings`,
        cookies,
        payload: {
          section: "tls",
          enabled: false,
          cpuEnabled: false,
          cpuThreshold: 90,
          memoryEnabled: false,
          memoryThreshold: 90,
          diskUsageEnabled: false,
          diskUsageThreshold: 90,
          temperatureEnabled: false,
          temperatureThreshold: 80,
          deploymentStatusEnabled: false,
          diskMissingEnabled: false,
          tlsEnabled: false,
          tlsWarnDays: 14,
          tlsHostnameMismatchEnabled: true,
          excludedDisks: [],
        },
      });
      expect(tlsOff.statusCode).toBe(200);
      const recovered = await app.inject({ method: "GET", url: "/api/v1/monitor-alerts", cookies });
      expect(recovered.json().items.some((item: { ruleType: string; status: string }) => item.ruleType === "tls_expiring" && item.status === "active")).toBe(false);
    } finally {
      await app.close();
      ssh.server.close();
    }
  });

  it("binds an existing TLS endpoint to a web entry without changing its URL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-tls-bind-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "绑定环境" } });
      const environmentId = environment.json().id as string;
      const other = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "其它环境" } });
      const web = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/web-entries`,
        cookies,
        payload: { name: "控制台", url: "http://dev.example.com/app", description: "", tags: [] },
      });
      expect(web.statusCode).toBe(201);
      expect(web.json().tlsEndpointId).toBeNull();
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/tls-endpoints`,
        cookies,
        payload: { host: "dev.example.com", port: 443, sni: "dev.example.com" },
      });
      expect(created.statusCode).toBe(201);
      const endpointId = created.json().id as string;
      const listed = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/tls-endpoints`, cookies });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: endpointId, host: "dev.example.com" })]));
      const bound = await app.inject({
        method: "PUT",
        url: `/api/v1/web-entries/${web.json().id}/tls-endpoint`,
        cookies,
        payload: { endpointId },
      });
      expect(bound.statusCode).toBe(200);
      expect(bound.json()).toMatchObject({ ok: true, endpointId, tlsProbeReady: false });
      const entries = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/web-entries`, cookies });
      expect(entries.json().items[0]).toEqual(expect.objectContaining({
        url: "http://dev.example.com/app",
        tls: expect.objectContaining({ endpointId }),
      }));
      const otherEndpoint = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${other.json().id}/tls-endpoints`,
        cookies,
        payload: { host: "other.example.com", port: 443 },
      });
      const cross = await app.inject({
        method: "PUT",
        url: `/api/v1/web-entries/${web.json().id}/tls-endpoint`,
        cookies,
        payload: { endpointId: otherEndpoint.json().id },
      });
      expect(cross.statusCode).toBe(400);
      const unbound = await app.inject({
        method: "PUT",
        url: `/api/v1/web-entries/${web.json().id}/tls-endpoint`,
        cookies,
        payload: { endpointId: null },
      });
      expect(unbound.statusCode).toBe(200);
      expect(unbound.json()).toMatchObject({ ok: true, endpointId: null });
    } finally {
      await app.close();
    }
  });
});
