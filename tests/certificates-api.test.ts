import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { fingerprintFor } from "./helpers/ssl-asset-harness.js";

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
    masterKey: Buffer.alloc(32, 62),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username = "admin", password = "test-password-123") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  return { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value };
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

describe("certificate assets API", () => {
  it("merges the same fingerprint across environments, isolates workspaces, and dual-writes legacy rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-cert-api-"));
    directories.push(directory);
    const ssh = await startSshServer();
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const cookies = await login(app);
      const envA = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Env A" } });
      const envB = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Env B" } });
      const sshA = await app.inject({
        method: "POST", url: "/api/v1/ssh-connections", cookies,
        payload: {
          environmentId: envA.json().id, name: "ssh-a", host: "127.0.0.1", port: ssh.port, username: "operator",
          authType: "password", credential: { password: "tls-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const sshB = await app.inject({
        method: "POST", url: "/api/v1/ssh-connections", cookies,
        payload: {
          environmentId: envB.json().id, name: "ssh-b", host: "127.0.0.1", port: ssh.port, username: "operator",
          authType: "password", credential: { password: "tls-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const endpointA = await app.inject({
        method: "POST", url: `/api/v1/environments/${envA.json().id}/tls-endpoints`, cookies,
        payload: { host: "127.0.0.1", port: 443, sni: "app.example.com", sshConnectionId: sshA.json().id },
      });
      const endpointB = await app.inject({
        method: "POST", url: `/api/v1/environments/${envB.json().id}/tls-endpoints`, cookies,
        payload: { host: "127.0.0.1", port: 443, sni: "app.example.com", sshConnectionId: sshB.json().id },
      });
      expect(endpointA.statusCode).toBe(201);
      expect(endpointA.json().item.id).toBe(endpointA.json().id);
      expect((await app.inject({ method: "POST", url: `/api/v1/tls-endpoints/${endpointA.json().id}/probe`, cookies })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/v1/tls-endpoints/${endpointB.json().id}/probe`, cookies })).statusCode).toBe(200);

      const listed = await app.inject({ method: "GET", url: "/api/v1/certificates", cookies });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toHaveLength(1);
      expect(listed.json().items[0].endpointCount).toBe(2);
      expect(listed.json().summary.total).toBe(1);
      expect(await db.prepare("SELECT COUNT(*) AS total FROM tls_endpoints").get()).toEqual({ total: 2 });
      expect(await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints").get()).toEqual({ total: 2 });

      expect((await app.inject({
        method: "POST", url: `/api/v1/environments/${envA.json().id}/tls-endpoints`, cookies,
        payload: { host: "169.254.169.254", port: 443, sshConnectionId: sshA.json().id },
      })).statusCode).toBe(400);

      const httpEntry = await app.inject({
        method: "POST", url: `/api/v1/environments/${envA.json().id}/web-entries`, cookies,
        payload: { name: "plain", url: "http://app.example.com", description: "", tags: [] },
      });
      const httpsEntry = await app.inject({
        method: "POST", url: `/api/v1/environments/${envA.json().id}/web-entries`, cookies,
        payload: { name: "secure", url: "https://app.example.com/admin", description: "", tags: [] },
      });
      expect(httpEntry.statusCode).toBe(201);
      expect(httpsEntry.statusCode).toBe(201);
      const webList = await app.inject({ method: "GET", url: `/api/v1/environments/${envA.json().id}/web-entries`, cookies });
      const httpTls = webList.json().items.find((item: { name: string }) => item.name === "plain");
      const httpsTls = webList.json().items.find((item: { name: string }) => item.name === "secure");
      expect(httpTls.tls).toBeNull();
      expect(httpsTls.tls.status).toMatch(/valid|expiring|expired|unconfigured|error/);
      expect(httpsTls.tls).toEqual(expect.objectContaining({ endpointId: expect.any(String) }));

      const memberRegistration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "cert-member", password: "member-password-123" } });
      const memberId = memberRegistration.json().user.id as string;
      const org = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "Cert Org", description: "" } });
      const organizationId = org.json().id as string;
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'member', ?, ?)").run(organizationId, memberId, now, now);
      const member = { envman_session: memberRegistration.cookies.find((item) => item.name === "envman_session")!.value };
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: member, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/certificates", cookies: member })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/v1/tls-endpoints/${endpointA.json().id}/probe`, cookies: member })).statusCode).toBe(403);

      await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "other-admin", password: "other-password-123" } });
      const otherLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "other-admin", password: "other-password-123" } });
      const otherCookies = { envman_session: otherLogin.cookies.find((item) => item.name === "envman_session")!.value };
      const missing = await app.inject({ method: "GET", url: `/api/v1/certificates/${listed.json().items[0].id}`, cookies: otherCookies });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe("CERTIFICATE_NOT_FOUND");

      const inUse = await app.inject({ method: "DELETE", url: `/api/v1/certificates/${listed.json().items[0].id}`, cookies });
      expect(inUse.statusCode).toBe(409);
      const cascaded = await app.inject({ method: "DELETE", url: `/api/v1/certificates/${listed.json().items[0].id}?cascade=endpoints`, cookies });
      expect(cascaded.statusCode).toBe(204);
      expect((await app.inject({ method: "GET", url: "/api/v1/certificates", cookies })).json().items).toHaveLength(0);
      expect(otherCookies).toBeTruthy();
      expect(sshA.statusCode).toBe(201);
    } finally {
      await app.close();
      ssh.server.close();
    }
  });

  it("creates disabled endpoints atomically, clears identity/probe on change, unbinds with empty bind key, recovers alerts, and marks failed snapshots stale", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-cert-lifecycle-"));
    directories.push(directory);
    const ssh = await startSshServer();
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const cookies = await login(app);
      const env = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Lifecycle" } });
      const environmentId = env.json().id as string;
      const sshConn = await app.inject({
        method: "POST", url: "/api/v1/ssh-connections", cookies,
        payload: {
          environmentId, name: "ssh", host: "127.0.0.1", port: ssh.port, username: "operator",
          authType: "password", credential: { password: "tls-secret" },
          options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
        },
      });
      const sshId = sshConn.json().id as string;

      const disabled = await app.inject({
        method: "POST", url: `/api/v1/environments/${environmentId}/tls-endpoints`, cookies,
        payload: { host: "off.example.com", port: 443, observeEnabled: false },
      });
      expect(disabled.statusCode).toBe(201);
      expect(disabled.json().item.observeEnabled).toBe(false);
      expect(await db.prepare("SELECT observe_enabled FROM ssl_endpoints WHERE id = ?").get(disabled.json().id)).toEqual({ observe_enabled: 0 });
      expect(await db.prepare("SELECT observe_enabled FROM tls_endpoints WHERE id = ?").get(disabled.json().id)).toEqual({ observe_enabled: 0 });

      const created = await app.inject({
        method: "POST", url: `/api/v1/environments/${environmentId}/tls-endpoints`, cookies,
        payload: { host: "127.0.0.1", port: 443, sni: "app.example.com", sshConnectionId: sshId },
      });
      const endpointId = created.json().id as string;
      expect((await app.inject({ method: "POST", url: `/api/v1/tls-endpoints/${endpointId}/probe`, cookies })).statusCode).toBe(200);
      const afterFail = await db.prepare("UPDATE ssl_endpoints SET probe_status = 'connect_failed', probe_error = 'boom' WHERE id = ?").run(endpointId);
      expect(afterFail.changes).toBe(1);
      const staleGet = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/maintenance`, cookies });
      const staleItem = staleGet.json().tlsEndpoints.find((item: { id: string }) => item.id === endpointId);
      expect(staleItem.probeStatus).toBe("connect_failed");
      expect(staleItem.stale).toBe(true);
      expect(staleItem.certificateId).toBeTruthy();

      const renamed = await app.inject({
        method: "PUT", url: `/api/v1/tls-endpoints/${endpointId}`, cookies,
        payload: { host: "rotated.example.com", port: 443, sni: "rotated.example.com", sshConnectionId: sshId },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().item).toMatchObject({ host: "rotated.example.com", probeStatus: "never", certificateId: null, lastSuccessAt: null });

      const unbound = await app.inject({
        method: "PUT", url: `/api/v1/tls-endpoints/${endpointId}`, cookies,
        payload: { host: "rotated.example.com", port: 443, sni: "rotated.example.com", sshConnectionId: null },
      });
      expect(unbound.statusCode).toBe(200);
      expect(await db.prepare("SELECT ssh_bind_key FROM ssl_endpoints WHERE id = ?").get(endpointId)).toEqual({ ssh_bind_key: "" });
      expect(await db.prepare("SELECT ssh_bind_key FROM tls_endpoints WHERE id = ?").get(endpointId)).toEqual({ ssh_bind_key: "" });

      const duplicate = await app.inject({
        method: "POST", url: `/api/v1/environments/${environmentId}/tls-endpoints`, cookies,
        payload: { host: "rotated.example.com", port: 443, sni: "rotated.example.com" },
      });
      expect(duplicate.statusCode).toBe(409);

      const originalPrepare = app.db.prepare.bind(app.db);
      app.db.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        if (/INSERT INTO tls_endpoints\s*\(/.test(sql)) {
          return {
            get: statement.get.bind(statement),
            all: statement.all.bind(statement),
            run: async () => {
              throw new Error("legacy write failed");
            },
          };
        }
        return statement;
      }) as typeof app.db.prepare;
      const before = await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints").get() as { total: number | string };
      const rolled = await app.inject({
        method: "POST", url: `/api/v1/environments/${environmentId}/tls-endpoints`, cookies,
        payload: { host: "rollback.example.com", port: 443 },
      });
      app.db.prepare = originalPrepare;
      expect(rolled.statusCode).toBe(500);
      expect(await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints").get()).toEqual(before);

      const web = await app.inject({
        method: "POST", url: `/api/v1/environments/${environmentId}/web-entries`, cookies,
        payload: { name: "secure", url: "https://web.example.com", description: "", tags: [] },
      });
      expect(web.statusCode).toBe(201);
      const webId = web.json().id as string;
      const linked = await db.prepare("SELECT endpoint_id FROM ssl_endpoint_web_entries WHERE web_entry_id = ?").get(webId) as { endpoint_id: string };
      const now = new Date().toISOString();
      const stateId = randomUUID();
      const alertId = randomUUID();
      await db.prepare(`
        INSERT INTO monitor_alert_states (
          id, environment_id, target_type, target_id, rule_type, rule_key_hash, rule_key, target_name,
          breach_count, recovery_count, last_value_json, last_evaluated_at, created_at, updated_at
        ) VALUES (?, ?, 'tls_endpoint', ?, 'tls_expired', 'hash', '', 'web.example.com', 1, 0, '{}', ?, ?, ?)
      `).run(stateId, environmentId, linked.endpoint_id, now, now, now);
      await db.prepare(`
        INSERT INTO monitor_alerts (
          id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
          environment_name, target_name, status, details_json, triggered_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'tls_endpoint', ?, 'tls_expired', '', 'Lifecycle', 'web.example.com', 'active', '{}', ?, ?, ?)
      `).run(alertId, environmentId, stateId, linked.endpoint_id, now, now, now);
      const certId = randomUUID();
      await db.prepare(`
        INSERT INTO ssl_certificates (
          id, workspace_type, workspace_id, fingerprint_sha256, leaf_cn, leaf_sans_json, issuer, serial,
          signature_algorithm, not_before, not_after, is_self_signed, first_seen_at, last_seen_at, created_at, updated_at
        ) VALUES (?, 'personal', ?, ?, 'web.example.com', '[]', 'Issuer', '1', 'sha256', ?, ?, 0, ?, ?, ?, ?)
      `).run(certId, (await db.prepare("SELECT workspace_id FROM environments WHERE id = ?").get(environmentId) as { workspace_id: string }).workspace_id, fingerprintFor("web-orphan"), now, now, now, now, now, now);
      await db.prepare("UPDATE ssl_endpoints SET certificate_id = ? WHERE id = ?").run(certId, linked.endpoint_id);

      const toHttp = await app.inject({
        method: "PUT", url: `/api/v1/web-entries/${webId}`, cookies,
        payload: { name: "secure", url: "http://web.example.com", description: "", tags: [] },
      });
      expect(toHttp.statusCode).toBe(200);
      expect(await db.prepare("SELECT id FROM ssl_endpoints WHERE id = ?").get(linked.endpoint_id)).toBeUndefined();
      expect(await db.prepare("SELECT status, recovered_at FROM monitor_alerts WHERE id = ?").get(alertId)).toEqual(expect.objectContaining({ status: "recovered" }));
      expect(await db.prepare("SELECT id FROM monitor_alert_states WHERE id = ?").get(stateId)).toBeUndefined();
      expect(await db.prepare("SELECT id FROM ssl_certificates WHERE id = ?").get(certId)).toEqual({ id: certId });
      expect(await db.prepare("SELECT COUNT(*) AS total FROM web_entries WHERE id = ?").get(webId)).toEqual({ total: 1 });
    } finally {
      await app.close();
      ssh.server.close();
    }
  });

  it("pages certificates in the database and can load assets beyond the first 1000", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-cert-page-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const cookies = await login(app);
      const user = await db.prepare("SELECT id FROM admin_users LIMIT 1").get() as { id: string };
      const now = Date.now();
      let lastId = "";
      await db.transaction(async () => {
        for (let index = 0; index < 1001; index += 1) {
          const id = randomUUID();
          if (index === 1000) lastId = id;
          const seen = new Date(now).toISOString();
          const notAfter = new Date(now + (index + 1) * 86_400_000).toISOString();
          await db.prepare(`
            INSERT INTO ssl_certificates (
              id, workspace_type, workspace_id, fingerprint_sha256, leaf_cn, leaf_sans_json, issuer, serial,
              signature_algorithm, not_before, not_after, is_self_signed, first_seen_at, last_seen_at, created_at, updated_at
            ) VALUES (?, 'personal', ?, ?, ?, '[]', 'Issuer', '1', 'sha256', ?, ?, 0, ?, ?, ?, ?)
          `).run(id, user.id, fingerprintFor(`page-${index}`), `cert-${String(index).padStart(4, "0")}.example.com`, seen, notAfter, seen, seen, seen, seen);
        }
      })();

      let statements = 0;
      const originalPrepare = app.db.prepare.bind(app.db);
      app.db.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        return {
          get: (...params: unknown[]) => {
            statements += 1;
            return statement.get(...params);
          },
          all: (...params: unknown[]) => {
            statements += 1;
            return statement.all(...params);
          },
          run: (...params: unknown[]) => {
            statements += 1;
            return statement.run(...params);
          },
        };
      }) as typeof app.db.prepare;
      const page = await app.inject({ method: "GET", url: "/api/v1/certificates?page=1&pageSize=100&sort=expiry", cookies });
      app.db.prepare = originalPrepare;
      expect(page.statusCode).toBe(200);
      expect(page.json().items).toHaveLength(100);
      expect(page.json().pageInfo).toEqual({ page: 1, pageSize: 100, total: 1001 });
      expect(page.json().items.some((item: { id: string }) => item.id === lastId)).toBe(false);
      expect(statements).toBeLessThan(20);

      const detail = await app.inject({ method: "GET", url: `/api/v1/certificates/${lastId}`, cookies });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().item.id).toBe(lastId);
      const deleted = await app.inject({ method: "DELETE", url: `/api/v1/certificates/${lastId}`, cookies });
      expect(deleted.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});
