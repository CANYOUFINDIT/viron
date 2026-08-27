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
});
