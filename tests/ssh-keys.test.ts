import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "ssh2";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { createDeviceIdentity, openSshCredentialEnvelope, solveDeviceChallenge } from "../src/desktop/device-identity.js";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { connectSsh } from "../src/server/ssh/connector.js";

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
    masterKey: Buffer.alloc(32, 41),
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

async function startPublicKeyServer(): Promise<{ port: number; readonly connectionCount: number; close: () => Promise<void> }> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  let connectionCount = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    connectionCount += 1;
    client.on("authentication", (context) => {
      if (context.username === "operator" && context.method === "publickey") context.accept();
      else context.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          stream.write(`output:${info.command}\n`);
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
  return {
    port: (server.address() as AddressInfo).port,
    get connectionCount() { return connectionCount; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("workspace SSH key management", () => {
  it("imports, generates, exports, protects, shares and uses workspace keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssh-keys-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const target = await startPublicKeyServer();
    const admin = await login(app);

    try {
      const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies: admin, payload: { name: "密钥测试组织", description: "" } });
      const organizationId = organization.json().id as string;
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: admin, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);

      const importedPair = ssh2.utils.generateKeyPairSync("ed25519", { comment: "imported-test" });
      const imported = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-keys/import",
        cookies: admin,
        payload: { name: "bastion-01", privateKey: importedPair.private, passphrase: "" },
      });
      expect(imported.statusCode, imported.body).toBe(201);
      expect(imported.json()).toMatchObject({ name: "bastion-01", algorithm: "ssh-ed25519", connectionCount: 0 });
      expect(imported.body).not.toContain("OPENSSH PRIVATE KEY");

      const generated = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-keys/generate",
        cookies: admin,
        payload: { name: "Viron generated", algorithm: "ed25519", passphrase: "generated-passphrase" },
      });
      expect(generated.statusCode, generated.body).toBe(201);

      const stored = await db.prepare("SELECT private_key_ciphertext FROM ssh_keys WHERE id = ?").get<{ private_key_ciphertext: string }>(imported.json().id);
      expect(stored?.private_key_ciphertext).toMatch(/^v1:/);
      expect(stored?.private_key_ciphertext).not.toContain("OPENSSH PRIVATE KEY");

      const missingKey = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies: admin,
        payload: { name: "Missing key", host: "127.0.0.1", port: target.port, username: "operator", authType: "privateKey" },
      });
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json().error).toBe("SSH_KEY_REQUIRED");

      const legacy = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies: admin,
        payload: {
          name: "Legacy inline key",
          host: "legacy.example.com",
          port: 22,
          username: "operator",
          authType: "privateKey",
          credential: { privateKey: importedPair.private, passphrase: "legacy-passphrase" },
        },
      });
      expect(legacy.statusCode, legacy.body).toBe(201);
      const migrated = await app.inject({
        method: "PUT",
        url: `/api/v1/ssh-connections/${legacy.json().id}`,
        cookies: admin,
        payload: { name: "Legacy inline key", host: "legacy.example.com", port: 22, username: "operator", authType: "privateKey", sshKeyId: imported.json().id },
      });
      expect(migrated.statusCode, migrated.body).toBe(200);
      const migratedCredential = await db.prepare("SELECT credential_ciphertext FROM ssh_connections WHERE id = ?").get<{ credential_ciphertext: string }>(legacy.json().id);
      expect(JSON.parse(app.secrets.decrypt(migratedCredential!.credential_ciphertext))).toEqual({});

      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies: admin,
        payload: {
          name: "Shared key target",
          host: "127.0.0.1",
          port: target.port,
          username: "operator",
          authType: "privateKey",
          sshKeyId: imported.json().id,
        },
      });
      expect(connection.statusCode, connection.body).toBe(201);
      const connected = await connectSsh(app, connection.json().id);
      connected.close();
      const batch = await app.inject({
        method: "POST",
        url: `/api/v1/mcp/ssh-connections/${connection.json().id}/commands`,
        cookies: admin,
        payload: { commands: ["uname -a", "pwd"], timeoutMs: 5000, maxBytes: 4096 },
      });
      expect(batch.statusCode, batch.body).toBe(200);
      expect(batch.json()).toMatchObject({
        items: [
          { index: 0, ok: true, stdout: "output:uname -a\n", exitCode: 0 },
          { index: 1, ok: true, stdout: "output:pwd\n", exitCode: 0 },
        ],
        reusedConnection: true,
      });
      expect(JSON.stringify(batch.json())).not.toContain("command");
      expect(target.connectionCount).toBe(1);
      expect(await db.prepare("SELECT source FROM audit_events WHERE action = 'mcp.ssh_commands_read_batch' AND resource_id = ?").get(connection.json().id)).toEqual({ source: "mcp" });
      const reusedBatch = await app.inject({
        method: "POST",
        url: `/api/v1/mcp/ssh-connections/${connection.json().id}/commands`,
        cookies: admin,
        payload: { commands: ["pwd"], timeoutMs: 5000, maxBytes: 4096 },
      });
      expect(reusedBatch.statusCode, reusedBatch.body).toBe(200);
      expect(reusedBatch.json().transportReused).toBe(true);
      expect(target.connectionCount).toBe(1);
      const refreshedConnection = await app.inject({
        method: "PUT",
        url: `/api/v1/ssh-connections/${connection.json().id}`,
        cookies: admin,
        payload: {
          name: "Shared key target",
          host: "127.0.0.1",
          port: target.port,
          username: "operator",
          authType: "privateKey",
          sshKeyId: imported.json().id,
        },
      });
      expect(refreshedConnection.statusCode, refreshedConnection.body).toBe(200);
      const afterInvalidation = await app.inject({
        method: "POST",
        url: `/api/v1/mcp/ssh-connections/${connection.json().id}/commands`,
        cookies: admin,
        payload: { commands: ["pwd"], timeoutMs: 5000, maxBytes: 4096 },
      });
      expect(afterInvalidation.statusCode, afterInvalidation.body).toBe(200);
      expect(afterInvalidation.json().transportReused).toBe(false);
      expect(target.connectionCount).toBe(2);

      const list = await app.inject({ method: "GET", url: "/api/v1/ssh-keys", cookies: admin });
      expect(list.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: imported.json().id, name: "bastion-01", connectionCount: 2 }),
        expect.objectContaining({ id: generated.json().id, name: "Viron generated", connectionCount: 0 }),
      ]));
      expect(list.body).not.toContain("OPENSSH PRIVATE KEY");

      const publicExport = await app.inject({ method: "GET", url: `/api/v1/ssh-keys/${imported.json().id}/export?part=public`, cookies: admin });
      expect(publicExport.statusCode).toBe(200);
      expect(publicExport.body).toContain("ssh-ed25519 ");
      const safeDefaultExport = await app.inject({ method: "GET", url: `/api/v1/ssh-keys/${imported.json().id}/export?part=unexpected`, cookies: admin });
      expect(safeDefaultExport.body).toContain("ssh-ed25519 ");
      expect(safeDefaultExport.body).not.toContain("PRIVATE KEY");
      const privateExport = await app.inject({ method: "GET", url: `/api/v1/ssh-keys/${imported.json().id}/export?part=private`, cookies: admin });
      expect(privateExport.statusCode).toBe(200);
      expect(privateExport.body).toContain("BEGIN OPENSSH PRIVATE KEY");
      expect((await app.inject({ method: "DELETE", url: `/api/v1/ssh-keys/${imported.json().id}`, cookies: admin })).statusCode).toBe(409);

      const memberRegistration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "member", password: "member-password-123" } });
      const memberId = memberRegistration.json().user.id as string;
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'member', ?, ?)").run(organizationId, memberId, now, now);
      await db.prepare("INSERT INTO resource_grants (id, organization_id, grantee_type, grantee_id, resource_type, resource_id, created_by_user_id, created_at) VALUES (?, ?, 'user', ?, 'ssh_connection', ?, ?, ?)")
        .run(randomUUID(), organizationId, memberId, connection.json().id, memberId, now);
      const member = { envman_session: memberRegistration.cookies.find((item) => item.name === "envman_session")!.value };
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: member, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/ssh-keys", cookies: member })).statusCode).toBe(403);
      const memberConnections = await app.inject({ method: "GET", url: "/api/v1/connections?type=ssh", cookies: member });
      expect(memberConnections.statusCode).toBe(200);
      expect(memberConnections.json().items).toEqual([
        expect.objectContaining({ id: connection.json().id, authType: "privateKey", hasPrivateKey: true, sshKeyId: null, sshKeyName: null }),
      ]);

      const identity = createDeviceIdentity();
      const challenge = await app.inject({
        method: "POST",
        url: "/api/v1/desktop/devices/registration-challenges",
        cookies: member,
        payload: { deviceId: identity.deviceId, publicKey: identity.publicKey },
      });
      expect(challenge.statusCode).toBe(201);
      const completed = await app.inject({
        method: "POST",
        url: `/api/v1/desktop/devices/registration-challenges/${challenge.json().challengeId}/complete`,
        cookies: member,
        payload: { proof: solveDeviceChallenge(identity, challenge.json().encryptedChallenge) },
      });
      expect(completed.statusCode).toBe(200);
      const requestId = randomUUID();
      const envelope = await app.inject({
        method: "POST",
        url: `/api/v1/desktop/ssh-connections/${connection.json().id}/envelope`,
        cookies: member,
        payload: { deviceId: identity.deviceId, requestId, endpoint: "http://127.0.0.1:8081" },
      });
      expect(envelope.statusCode, envelope.body).toBe(200);
      const opened = openSshCredentialEnvelope(identity, envelope.json(), {
        requestId,
        userId: memberId,
        workspaceType: "organization",
        workspaceId: organizationId,
        connectionId: connection.json().id,
        endpoint: "http://127.0.0.1:8081",
      });
      expect(opened.credential.connection).toMatchObject({
        authType: "privateKey",
        credential: { privateKey: importedPair.private, passphrase: "" },
      });

      expect((await app.inject({ method: "DELETE", url: `/api/v1/ssh-keys/${generated.json().id}`, cookies: admin })).statusCode).toBe(204);
    } finally {
      await app.close();
      await target.close();
    }
  }, 20_000);

  it("copies a referenced personal key into an organization and reencrypts it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-ssh-key-copy-"));
    directories.push(directory);
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const admin = await login(app);

    try {
      const key = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-keys/generate",
        cookies: admin,
        payload: { name: "Personal deployment key", algorithm: "ed25519", passphrase: "copy-passphrase" },
      });
      expect(key.statusCode, key.body).toBe(201);
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies: admin,
        payload: { name: "Personal target", host: "ssh.example.com", port: 22, username: "operator", authType: "privateKey", sshKeyId: key.json().id },
      });
      expect(connection.statusCode, connection.body).toBe(201);
      const source = await db.prepare("SELECT private_key_ciphertext FROM ssh_keys WHERE id = ?").get<{ private_key_ciphertext: string }>(key.json().id);

      const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies: admin, payload: { name: "密钥复制组织", description: "" } });
      const organizationId = organization.json().id as string;
      expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: admin, payload: { type: "organization", id: organizationId } })).statusCode).toBe(200);
      const copied = await app.inject({
        method: "POST",
        url: "/api/v1/connection-copy",
        cookies: admin,
        payload: { selection: { sshConnectionIds: [connection.json().id] }, reuse: {}, grantees: [] },
      });
      expect(copied.statusCode, copied.body).toBe(201);
      expect(copied.json().counts).toMatchObject({ sshKeys: 1, sshConnections: 1 });

      const target = await db.prepare(`
        SELECT c.ssh_key_id, k.fingerprint, k.private_key_ciphertext
        FROM ssh_connections c JOIN ssh_keys k ON k.id = c.ssh_key_id
        WHERE c.workspace_type = 'organization' AND c.workspace_id = ?
      `).get<{ ssh_key_id: string; fingerprint: string; private_key_ciphertext: string }>(organizationId);
      expect(target?.ssh_key_id).not.toBe(key.json().id);
      expect(target?.fingerprint).toBe(key.json().fingerprint);
      expect(target?.private_key_ciphertext).not.toBe(source?.private_key_ciphertext);
      expect(JSON.parse(app.secrets.decrypt(target!.private_key_ciphertext))).toMatchObject({ passphrase: "copy-passphrase" });
    } finally {
      await app.close();
    }
  });
});
