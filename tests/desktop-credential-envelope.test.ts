import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDeviceIdentity,
  openCredentialEnvelope,
  openDatabaseCredentialEnvelope,
  openSshCredentialEnvelope,
  signDeviceReport,
  solveDeviceChallenge,
} from "../src/desktop/device-identity.js";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 29),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

function signedDesktopReport(
  identity: ReturnType<typeof createDeviceIdentity>,
  userId: string,
  payload: { operationId: string } & Record<string, unknown>,
  issuedAt = new Date(),
) {
  const protectedBytes = Buffer.from(JSON.stringify({
    version: 1,
    algorithm: "RSA-PSS-SHA256",
    keyId: identity.keyId,
    deviceId: identity.deviceId,
    operationId: payload.operationId,
    userId,
    workspaceType: "personal",
    workspaceId: userId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    payload,
  }), "utf8");
  return {
    protected: protectedBytes.toString("base64url"),
    signature: signDeviceReport(identity, protectedBytes),
  };
}

describe("desktop credential envelopes", () => {
  it("registers a proven device key and issues request-bound one-time Web and SSH credential envelopes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-envelope-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: config.adminUsername, password: config.adminPassword },
    });
    expect(login.statusCode).toBe(200);
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const userId = login.json().user.id as string;

    const environment = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      cookies,
      payload: { name: "Desktop Web" },
    });
    expect(environment.statusCode).toBe(201);
    const entry = await app.inject({
      method: "POST",
      url: `/api/v1/environments/${environment.json().id}/web-entries`,
      cookies,
      payload: { name: "Console", url: "https://console.example.com/login" },
    });
    expect(entry.statusCode).toBe(201);
    const credential = await app.inject({
      method: "POST",
      url: `/api/v1/web-entries/${entry.json().id}/credentials`,
      cookies,
      payload: { username: "operator", password: "desktop-secret", note: "", customFields: { tenant: "north" } },
    });
    expect(credential.statusCode).toBe(201);

    const identity = createDeviceIdentity();
    const deviceId = identity.deviceId;
    const challenge = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/devices/registration-challenges",
      cookies,
      payload: { deviceId, publicKey: identity.publicKey },
    });
    expect(challenge.statusCode).toBe(201);
    const proof = solveDeviceChallenge(identity, challenge.json().encryptedChallenge);
    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/desktop/devices/registration-challenges/${challenge.json().challengeId}/complete`,
      cookies,
      payload: { proof },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ deviceId, keyId: challenge.json().keyId, status: "active" });

    const device = await app.inject({ method: "GET", url: `/api/v1/desktop/devices/${deviceId}`, cookies });
    expect(device.statusCode).toBe(200);
    expect(device.json()).toMatchObject({ deviceId, status: "active" });

    const requestId = randomUUID();
    const request = {
      method: "POST" as const,
      url: `/api/v1/desktop/web-credentials/${credential.json().id}/envelope`,
      cookies,
      payload: { deviceId, requestId, endpoint: "http://127.0.0.1:8081" },
    };
    const issued = await app.inject(request);
    expect(issued.statusCode).toBe(200);
    const opened = openCredentialEnvelope(identity, issued.json(), {
      requestId,
      userId,
      workspaceType: "personal",
      workspaceId: userId,
      credentialId: credential.json().id,
      endpoint: "http://127.0.0.1:8081",
    });
    expect(opened.claims).toMatchObject({
      version: 1,
      algorithm: "RSA-OAEP-256+A256GCM",
      deviceId,
      requestId,
      userId,
      credentialId: credential.json().id,
      endpoint: "http://127.0.0.1:8081",
      targetOrigin: "https://console.example.com",
    });
    expect(new Date(opened.claims.expiresAt).getTime() - new Date(opened.claims.issuedAt).getTime()).toBe(60_000);
    expect(opened.credential).toMatchObject({
      credentialId: credential.json().id,
      entryId: entry.json().id,
      entryUrl: "https://console.example.com/login",
      username: "operator",
      password: "desktop-secret",
      customFields: { tenant: "north" },
    });

    const replayed = await app.inject(request);
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().error).toBe("REQUEST_REPLAYED");

    const tamperedTag = Buffer.from(issued.json().tag, "base64url");
    tamperedTag[0] ^= 0xff;
    expect(() => openCredentialEnvelope(identity, { ...issued.json(), tag: tamperedTag.toString("base64url") }, {
      requestId,
      userId,
      workspaceType: "personal",
      workspaceId: userId,
      credentialId: credential.json().id,
      endpoint: "http://127.0.0.1:8081",
    })).toThrow();

    const jump = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: {
        name: "Desktop Jump",
        host: "jump.example.com",
        port: 2222,
        username: "jump-user",
        authType: "password",
        credential: { password: "jump-secret" },
      },
    });
    expect(jump.statusCode).toBe(201);
    const sshConnection = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: {
        name: "Desktop SSH",
        host: "target.example.com",
        port: 2201,
        username: "target-user",
        authType: "privateKey",
        credential: { privateKey: "desktop-private-key", passphrase: "key-secret" },
        jumpConnectionId: jump.json().id,
        options: {
          terminalType: "xterm-256color",
          keepAliveSeconds: 45,
          encoding: "utf-8",
          hostKeySha256: "SHA256:fixture",
          loginScriptEnabled: true,
          loginScript: "cd /srv/app\necho ready",
        },
      },
    });
    expect(sshConnection.statusCode).toBe(201);

    const sshRequestId = randomUUID();
    const sshRequest = {
      method: "POST" as const,
      url: `/api/v1/desktop/ssh-connections/${sshConnection.json().id}/envelope`,
      cookies,
      payload: { deviceId, requestId: sshRequestId, endpoint: "http://127.0.0.1:8081" },
    };
    const sshIssued = await app.inject(sshRequest);
    expect(sshIssued.statusCode).toBe(200);
    const sshOpened = openSshCredentialEnvelope(identity, sshIssued.json(), {
      requestId: sshRequestId,
      userId,
      workspaceType: "personal",
      workspaceId: userId,
      connectionId: sshConnection.json().id,
      endpoint: "http://127.0.0.1:8081",
    });
    expect(sshOpened.claims).toMatchObject({
      deviceId,
      requestId: sshRequestId,
      userId,
      connectionId: sshConnection.json().id,
      targetHost: "target.example.com",
      targetPort: 2201,
      jumpConnectionId: jump.json().id,
    });
    expect(sshOpened.credential.connection).toMatchObject({
      connectionId: sshConnection.json().id,
      name: "Desktop SSH",
      authType: "privateKey",
      credential: { privateKey: "desktop-private-key", passphrase: "key-secret" },
      jumpConnectionId: jump.json().id,
      options: { loginScriptEnabled: true, loginScript: "cd /srv/app\necho ready" },
    });
    expect(sshOpened.credential.jumpConnection).toMatchObject({
      connectionId: jump.json().id,
      name: "Desktop Jump",
      authType: "password",
      credential: { password: "jump-secret" },
    });
    expect(() => openSshCredentialEnvelope(identity, sshIssued.json(), {
      requestId: randomUUID(),
      userId,
      workspaceType: "personal",
      workspaceId: userId,
      connectionId: sshConnection.json().id,
      endpoint: "http://127.0.0.1:8081",
    })).toThrow("凭据信封请求不匹配");
    const sshReplayed = await app.inject(sshRequest);
    expect(sshReplayed.statusCode).toBe(409);
    expect(sshReplayed.json().error).toBe("REQUEST_REPLAYED");

    const databaseConnection = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: {
        name: "Desktop Database",
        engine: "mysql",
        host: "database.internal",
        port: 3307,
        username: "database-user",
        credential: { password: "database-secret" },
        defaultDatabase: "operations",
        connectionMode: "sshTunnel",
        options: {
          sshConnectionId: sshConnection.json().id,
          charset: "utf8mb4",
          timezone: "+08:00",
          ssl: {
            enabled: true,
            rejectUnauthorized: true,
            ca: "desktop-ca",
            certificate: "desktop-cert",
            privateKey: "desktop-key",
            passphrase: "desktop-key-secret",
          },
        },
      },
    });
    expect(databaseConnection.statusCode).toBe(201);
    const databaseRequestId = randomUUID();
    const databaseRequest = {
      method: "POST" as const,
      url: `/api/v1/desktop/database-connections/${databaseConnection.json().id}/envelope`,
      cookies,
      payload: { deviceId, requestId: databaseRequestId, endpoint: "http://127.0.0.1:8081" },
    };
    const databaseIssued = await app.inject(databaseRequest);
    expect(databaseIssued.statusCode, databaseIssued.body).toBe(200);
    const databaseOpened = openDatabaseCredentialEnvelope(identity, databaseIssued.json(), {
      requestId: databaseRequestId,
      userId,
      workspaceType: "personal",
      workspaceId: userId,
      connectionId: databaseConnection.json().id,
      endpoint: "http://127.0.0.1:8081",
    });
    expect(databaseOpened.claims).toMatchObject({
      deviceId,
      requestId: databaseRequestId,
      userId,
      connectionId: databaseConnection.json().id,
      targetHost: "database.internal",
      targetPort: 3307,
      connectionMode: "sshTunnel",
      sshConnectionId: sshConnection.json().id,
      jumpConnectionId: jump.json().id,
    });
    expect(databaseOpened.credential.connection).toMatchObject({
      connectionId: databaseConnection.json().id,
      name: "Desktop Database",
      username: "database-user",
      password: "database-secret",
      defaultDatabase: "operations",
      connectionMode: "sshTunnel",
      options: {
        sshConnectionId: sshConnection.json().id,
        ssl: {
          ca: "desktop-ca",
          certificate: "desktop-cert",
          privateKey: "desktop-key",
          passphrase: "desktop-key-secret",
        },
      },
    });
    expect(databaseOpened.credential.sshCredential?.connection.connectionId).toBe(sshConnection.json().id);
    expect(databaseOpened.credential.sshCredential?.jumpConnection?.connectionId).toBe(jump.json().id);
    const databaseReplayed = await app.inject(databaseRequest);
    expect(databaseReplayed.statusCode).toBe(409);
    expect(databaseReplayed.json().error).toBe("REQUEST_REPLAYED");

    const operationId = randomUUID();
    const queryReport = {
      kind: "query",
      operationId,
      connectionId: databaseConnection.json().id,
      database: "operations",
      sql: "SELECT 1",
      status: "success",
      durationMs: 8,
      rowCount: 1,
      error: "",
      auditSource: "mcp",
    } as const;
    const signedQueryReport = signedDesktopReport(identity, userId, queryReport);
    const reported = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/database-executions",
      cookies,
      payload: signedQueryReport,
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toEqual({ accepted: true, duplicate: false });
    expect(await db.prepare("SELECT status, sql_text, row_count FROM database_query_history WHERE id = ?").get(operationId)).toMatchObject({
      status: "success",
      sql_text: "SELECT 1",
      row_count: 1,
    });
    const tamperedClaims = JSON.parse(Buffer.from(signedQueryReport.protected, "base64url").toString("utf8")) as { payload: { rowCount: number } };
    tamperedClaims.payload.rowCount = 2;
    const tamperedReport = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/database-executions",
      cookies,
      payload: { ...signedQueryReport, protected: Buffer.from(JSON.stringify(tamperedClaims), "utf8").toString("base64url") },
    });
    expect(tamperedReport.statusCode).toBe(403);
    expect(tamperedReport.json().error).toBe("INVALID_DESKTOP_REPORT_SIGNATURE");

    const duplicateReport = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/database-executions",
      cookies,
      payload: signedDesktopReport(identity, userId, queryReport, new Date(Date.now() + 1)),
    });
    expect(duplicateReport.statusCode).toBe(200);
    expect(duplicateReport.json()).toEqual({ accepted: true, duplicate: true });
    expect((await db.prepare("SELECT COUNT(*) AS total FROM database_query_history WHERE id = ?").get(operationId) as { total: number }).total).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS total, MIN(source) AS source FROM audit_events WHERE action = 'database.query_executed'").get()).toEqual({ total: 1, source: "mcp" });

    const databaseBatchReport = {
      kind: "operation",
      operationId: randomUUID(),
      connectionId: databaseConnection.json().id,
      action: "queries_read_batch",
      summary: "本机批量执行 2 条数据库只读查询",
      details: { queryCount: 2, failedCount: 0, durationMs: 12 },
      auditSource: "mcp",
    } as const;
    const reportedDatabaseBatch = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/database-executions",
      cookies,
      payload: signedDesktopReport(identity, userId, databaseBatchReport),
    });
    expect(reportedDatabaseBatch.statusCode).toBe(200);
    expect(await db.prepare("SELECT source FROM audit_events WHERE action = 'database.queries_read_batch' AND resource_id = ?").get(databaseConnection.json().id)).toEqual({ source: "mcp" });

    const sshBatchReport = {
      operationId: randomUUID(),
      connectionId: sshConnection.json().id,
      action: "commands_read_batch",
      summary: "本机批量执行 2 条 SSH 只读命令",
      details: { commandCount: 2, failedCount: 0, outputBytes: 128, durationMs: 9, transportReused: true },
      auditSource: "mcp",
    } as const;
    const reportedSshBatch = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/ssh-executions",
      cookies,
      payload: signedDesktopReport(identity, userId, sshBatchReport),
    });
    expect(reportedSshBatch.statusCode).toBe(200);
    expect(reportedSshBatch.json()).toEqual({ accepted: true, duplicate: false });
    const sshBatchAudit = await db.prepare("SELECT source, details_json FROM audit_events WHERE action = 'ssh.commands_read_batch' AND resource_id = ?").get(sshConnection.json().id) as { source: string; details_json: string };
    expect(sshBatchAudit.source).toBe("mcp");
    expect(JSON.parse(sshBatchAudit.details_json)).toMatchObject({ commandCount: 2, executionMode: "desktop-local", transportReused: true });
    expect(sshBatchAudit.details_json).not.toContain("uname");

    const replayedReport = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/database-executions",
      cookies,
      payload: signedDesktopReport(identity, userId, { ...queryReport, sql: "SELECT 2" }),
    });
    expect(replayedReport.statusCode).toBe(409);
    expect(replayedReport.json().error).toBe("DESKTOP_REPORT_REPLAYED");

    const expiredReport = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/database-executions",
      cookies,
      payload: signedDesktopReport(identity, userId, { ...queryReport, operationId: randomUUID() }, new Date(Date.now() - 120_000)),
    });
    expect(expiredReport.statusCode).toBe(410);
    expect(expiredReport.json().error).toBe("DESKTOP_REPORT_EXPIRED");

    const inspectionOperationId = randomUUID();
    const inspectionReport = {
      operationId: inspectionOperationId,
      items: [
        { type: "ssh", id: sshConnection.json().id, status: "available", latencyMs: 12, message: "连接成功" },
        { type: "database", id: databaseConnection.json().id, status: "unavailable", latencyMs: 18, message: "目标端口拒绝连接" },
      ],
    } as const;
    const reportedInspection = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/connection-inspections",
      cookies,
      payload: signedDesktopReport(identity, userId, inspectionReport),
    });
    expect(reportedInspection.statusCode).toBe(200);
    expect(reportedInspection.json()).toEqual({ accepted: true, duplicate: false });
    expect(await db.prepare(`
      SELECT status, latency_ms, message FROM connection_inspection_results
      WHERE connection_type = 'ssh' AND connection_id = ?
    `).get(sshConnection.json().id)).toMatchObject({ status: "available", latency_ms: 12, message: "连接成功" });
    expect(await db.prepare(`
      SELECT status, latency_ms, message FROM connection_inspection_results
      WHERE connection_type = 'database' AND connection_id = ?
    `).get(databaseConnection.json().id)).toMatchObject({ status: "unavailable", latency_ms: 18, message: "目标端口拒绝连接" });
    const duplicateInspection = await app.inject({
      method: "POST",
      url: "/api/v1/desktop/connection-inspections",
      cookies,
      payload: signedDesktopReport(identity, userId, inspectionReport, new Date(Date.now() + 1)),
    });
    expect(duplicateInspection.statusCode).toBe(200);
    expect(duplicateInspection.json()).toEqual({ accepted: true, duplicate: true });
    expect((await db.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'connection.inspected'").get() as { total: number }).total).toBe(1);

    await db.prepare("UPDATE desktop_devices SET status = 'revoked' WHERE device_id = ?").run(deviceId);
    const revoked = await app.inject({
      ...request,
      payload: { ...request.payload, requestId: randomUUID() },
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().error).toBe("DEVICE_REVOKED");

    await app.close();
  });
});
