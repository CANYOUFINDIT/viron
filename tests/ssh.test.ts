import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createDeviceIdentity,
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

function testConfig(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 11),
    adminUsername: "admin",
    adminPassword: "test-password-123",
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

async function startSshServer(): Promise<{ server: Server; port: number; commands: string[] }> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const commands: string[] = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "ssh-test-secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("SSH-TEST-READY\r\n");
          stream.on("data", (chunk: Buffer) => stream.write(Buffer.concat([Buffer.from("ECHO:"), chunk])));
        });
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          if (info.command === "tail -f /var/log/viron.log") {
            stream.write("waiting for logs\n");
            const timer = setTimeout(() => { stream.exit(0); stream.end(); }, 5_000);
            stream.once("close", () => clearTimeout(timer));
            return;
          }
          stream.write("service active\ntoken=server-diagnostic-secret\n");
          stream.stderr.write("warning password=server-stderr-secret\n");
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
  return { server, port: (server.address() as AddressInfo).port, commands };
}

function waitFor(messages: string[], predicate: (message: string) => boolean, timeoutMs = 3000): Promise<string> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = messages.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for WebSocket message. Received: ${messages.join(" | ")}`));
      }
    }, 10);
  });
}

function waitForOutput(chunks: Buffer[], predicate: (output: Buffer) => boolean, timeoutMs = 3000): Promise<Buffer> {
  const output = () => Buffer.concat(chunks);
  if (predicate(output())) return Promise.resolve(output());
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const current = output();
      if (predicate(current)) {
        clearInterval(timer);
        resolve(current);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for SSH output. Received ${current.length} bytes.`));
      }
    }, 10);
  });
}

describe("SSH terminal gateway", () => {
  it("opens a real SSH shell and transports terminal input over WebSocket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-ssh-test-"));
    directories.push(directory);
    const sshServer = await startSshServer();
    const config = testConfig(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const appPort = (app.server.address() as AddressInfo).port;
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "admin", password: "test-password-123" },
      });
      const cookie = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const userId = login.json().user.id as string;
      const identity = createDeviceIdentity();
      const challenge = await app.inject({
        method: "POST",
        url: "/api/v1/desktop/devices/registration-challenges",
        cookies: cookie,
        payload: { deviceId: identity.deviceId, publicKey: identity.publicKey },
      });
      expect(challenge.statusCode).toBe(201);
      const completedDevice = await app.inject({
        method: "POST",
        url: `/api/v1/desktop/devices/registration-challenges/${challenge.json().challengeId}/complete`,
        cookies: cookie,
        payload: { proof: solveDeviceChallenge(identity, challenge.json().encryptedChallenge) },
      });
      expect(completedDevice.statusCode).toBe(200);
      const environment = await app.inject({
        method: "POST",
        url: "/api/v1/environments",
        cookies: cookie,
        payload: { name: "SSH Source Environment" },
      });
      expect(environment.statusCode).toBe(201);
      const connection = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-connections",
        cookies: cookie,
        payload: {
          name: "Local SSH Fixture",
          host: "127.0.0.1",
          port: sshServer.port,
          username: "operator",
          authType: "password",
          credential: { password: "ssh-test-secret" },
          environmentIds: [environment.json().id],
          options: {
            terminalType: "xterm-256color",
            keepAliveSeconds: 30,
            encoding: "utf-8",
            hostKeySha256: "",
            loginScriptEnabled: true,
            loginScript: "cd /opt/app\r\necho LOGIN-SCRIPT\rprintf ready",
          },
        },
      });
      expect(connection.statusCode).toBe(201);

      const unavailableDatabase = await app.inject({
        method: "POST",
        url: "/api/v1/database-connections",
        cookies: cookie,
        payload: {
          name: "Unavailable Database Fixture",
          engine: "mysql",
          host: "127.0.0.1",
          port: 1,
          username: "operator",
          credential: { password: "not-used" },
          options: { connectTimeoutMs: 1000 },
        },
      });
      expect(unavailableDatabase.statusCode).toBe(201);

      const inspection = await app.inject({
        method: "POST",
        url: "/api/v1/connections/inspect",
        cookies: cookie,
        payload: {
          items: [
            { type: "ssh", id: connection.json().id },
            { type: "database", id: unavailableDatabase.json().id },
          ],
        },
      });
      expect(inspection.statusCode).toBe(200);
      expect(inspection.json().summary).toEqual({ total: 2, available: 1, unavailable: 1 });
      expect(inspection.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "ssh", id: connection.json().id, status: "available" }),
        expect.objectContaining({ type: "database", id: unavailableDatabase.json().id, status: "unavailable" }),
      ]));
      const inspectedPool = await app.inject({ method: "GET", url: "/api/v1/connections", cookies: cookie });
      expect(inspectedPool.json().items.find((item: { id: string }) => item.id === connection.json().id).lastInspectionStatus).toBe("available");
      expect(inspectedPool.json().items.find((item: { id: string }) => item.id === unavailableDatabase.json().id).lastInspectionStatus).toBe("unavailable");

      const executionScope = randomUUID();
      const agentHeaders = { "x-viron-execution-scope": executionScope, "x-viron-execution-mode": "server" };
      const opened = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-sessions",
        cookies: cookie,
        headers: agentHeaders,
        payload: { connectionId: connection.json().id, originEnvironmentId: environment.json().id, cols: 100, rows: 28 },
      });
      expect(opened.statusCode).toBe(201);
      const { session, ticket } = opened.json() as { session: { id: string }; ticket: string };
      const activeConnections = await app.inject({ method: "GET", url: "/api/v1/active-connections", cookies: cookie });
      expect(activeConnections.json().items).toContainEqual(expect.objectContaining({
        id: session.id,
        originEnvironmentId: environment.json().id,
      }));

      const controlMessages: string[] = [];
      const outputChunks: Buffer[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${appPort}/ws/ssh?ticket=${encodeURIComponent(ticket)}`);
      socket.on("message", (message, isBinary) => {
        if (isBinary) outputChunks.push(Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer));
        else controlMessages.push(message.toString());
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await waitFor(controlMessages, (message) => JSON.parse(message).type === "ready");
      await waitForOutput(outputChunks, (output) => output.includes(Buffer.from("SSH-TEST-READY")));
      const expectedLoginScript = Buffer.from("ECHO:cd /opt/app\necho LOGIN-SCRIPT\nprintf ready\n");
      const loginScript = await waitForOutput(outputChunks, (output) => output.includes(expectedLoginScript));
      expect(loginScript.includes(expectedLoginScript)).toBe(true);
      socket.send(JSON.stringify({ type: "input", data: "envman\n" }));
      const echoed = await waitForOutput(outputChunks, (output) => output.includes(Buffer.from("ECHO:envman")));
      expect(echoed.toString("utf8")).toContain("envman");

      const binaryInput = Buffer.from([0x00, 0x18, 0xff, 0x0f, 0x16, 0x80]);
      socket.send(binaryInput);
      const binaryEcho = Buffer.concat([Buffer.from("ECHO:"), binaryInput]);
      const binaryOutput = await waitForOutput(outputChunks, (output) => output.includes(binaryEcho));
      expect(binaryOutput.includes(binaryEcho)).toBe(true);

      socket.send(JSON.stringify({ type: "input", data: "token=context-secret\n" }));
      await waitForOutput(outputChunks, (output) => output.includes(Buffer.from("ECHO:token=context-secret")));
      const browserContext = await app.inject({ method: "GET", url: `/api/v1/ssh-sessions/${session.id}/agent-context`, cookies: cookie });
      expect(browserContext.statusCode).toBe(404);
      const unsignedContext = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-context`,
        cookies: cookie,
        headers: agentHeaders,
        payload: {},
      });
      expect(unsignedContext.statusCode).toBe(400);
      expect(unsignedContext.json().error).toBe("INVALID_DESKTOP_REPORT");
      const wrongExecutionScope = randomUUID();
      const wrongContext = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-context`,
        cookies: cookie,
        headers: { ...agentHeaders, "x-viron-execution-scope": wrongExecutionScope },
        payload: signedDesktopReport(identity, userId, {
          operationId: randomUUID(),
          action: "context",
          sessionId: session.id,
          executionScope: wrongExecutionScope,
        }),
      });
      expect(wrongContext.statusCode).toBe(404);
      const mismatchedContext = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-context`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDesktopReport(identity, userId, {
          operationId: randomUUID(),
          action: "context",
          sessionId: session.id,
          executionScope: randomUUID(),
        }),
      });
      expect(mismatchedContext.statusCode).toBe(403);
      expect(mismatchedContext.json().error).toBe("DESKTOP_REPORT_CONTEXT_MISMATCH");
      const contextOperationId = randomUUID();
      const signedContext = signedDesktopReport(identity, userId, {
        operationId: contextOperationId,
        action: "context",
        sessionId: session.id,
        executionScope,
      });
      const agentContext = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-context`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedContext,
      });
      expect(agentContext.statusCode).toBe(200);
      expect(agentContext.json()).toMatchObject({
        sessionId: session.id,
        connectionId: connection.json().id,
        executionTarget: "server-forwarded",
      });
      expect(agentContext.json().output).toContain("token=[REDACTED]");
      expect(agentContext.json().output).not.toContain("context-secret");
      const replayedContext = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-context`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedContext,
      });
      expect(replayedContext.statusCode).toBe(409);
      expect(replayedContext.json().error).toBe("AGENT_AUTHORIZATION_REPLAYED");

      const diagnosticId = randomUUID();
      const diagnosticPayload = {
        operationId: diagnosticId,
        action: "execute",
        sessionId: session.id,
        executionScope,
        command: "systemctl status viron",
      } as const;
      const signedDiagnostic = signedDesktopReport(identity, userId, diagnosticPayload);
      const tamperedClaims = JSON.parse(Buffer.from(signedDiagnostic.protected, "base64url").toString("utf8")) as { payload: { command: string } };
      tamperedClaims.payload.command = "uptime";
      const commandsBeforeTamper = sshServer.commands.length;
      const tamperedDiagnostic = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics`,
        cookies: cookie,
        headers: agentHeaders,
        payload: { ...signedDiagnostic, protected: Buffer.from(JSON.stringify(tamperedClaims), "utf8").toString("base64url") },
      });
      expect(tamperedDiagnostic.statusCode).toBe(403);
      expect(tamperedDiagnostic.json().error).toBe("INVALID_DESKTOP_REPORT_SIGNATURE");
      expect(sshServer.commands).toHaveLength(commandsBeforeTamper);
      const diagnostic = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDiagnostic,
      });
      expect(diagnostic.statusCode).toBe(200);
      expect(diagnostic.json()).toMatchObject({
        executionId: diagnosticId,
        sessionId: session.id,
        executionTarget: "server-forwarded",
        command: "systemctl status viron",
        exitCode: 0,
        redactionCount: 2,
      });
      expect(diagnostic.json().stdout).toContain("service active");
      expect(diagnostic.json().stdout).not.toContain("server-diagnostic-secret");
      expect(diagnostic.json().stderr).not.toContain("server-stderr-secret");
      expect(sshServer.commands).toContain("systemctl status viron");

      const commandsBeforeReplay = sshServer.commands.length;
      const replayedDiagnostic = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDiagnostic,
      });
      expect(replayedDiagnostic.statusCode).toBe(409);
      expect(replayedDiagnostic.json().error).toBe("AGENT_AUTHORIZATION_REPLAYED");
      const changedReplay = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDesktopReport(identity, userId, { ...diagnosticPayload, command: "uptime" }),
      });
      expect(changedReplay.statusCode).toBe(409);
      expect(changedReplay.json().error).toBe("DESKTOP_REPORT_REPLAYED");
      expect(sshServer.commands).toHaveLength(commandsBeforeReplay);

      const commandsBeforeWrite = sshServer.commands.length;
      const writeOperationId = randomUUID();
      const writeAttempt = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDesktopReport(identity, userId, {
          operationId: writeOperationId,
          action: "execute",
          sessionId: session.id,
          executionScope,
          command: "rm -rf /tmp/unsafe",
        }),
      });
      expect(writeAttempt.statusCode).toBe(400);
      expect(writeAttempt.json().message).toContain("只读");
      expect(sshServer.commands).toHaveLength(commandsBeforeWrite);

      const cancelId = randomUUID();
      const pendingDiagnostic = app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDesktopReport(identity, userId, {
          operationId: cancelId,
          action: "execute",
          sessionId: session.id,
          executionScope,
          command: "tail -f /var/log/viron.log",
        }),
      });
      await waitFor(sshServer.commands, (command) => command === "tail -f /var/log/viron.log");
      const cancelled = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics/${cancelId}/cancel`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDesktopReport(identity, userId, {
          operationId: randomUUID(),
          action: "cancel",
          sessionId: session.id,
          executionScope,
          executionId: cancelId,
        }),
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toEqual({ stopped: true });
      expect((await pendingDiagnostic).statusCode).toBe(502);
      socket.send(JSON.stringify({ type: "input", data: "still-connected\n" }));
      await waitForOutput(outputChunks, (output) => output.includes(Buffer.from("ECHO:still-connected")));

      const preCancelledId = randomUUID();
      const commandsBeforePreCancel = sshServer.commands.length;
      const preCancelled = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics/${preCancelledId}/cancel`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDesktopReport(identity, userId, {
          operationId: randomUUID(),
          action: "cancel",
          sessionId: session.id,
          executionScope,
          executionId: preCancelledId,
        }),
      });
      expect(preCancelled.statusCode).toBe(200);
      const cancelledBeforeExecution = await app.inject({
        method: "POST",
        url: `/api/v1/ssh-sessions/${session.id}/agent-diagnostics`,
        cookies: cookie,
        headers: agentHeaders,
        payload: signedDesktopReport(identity, userId, {
          operationId: preCancelledId,
          action: "execute",
          sessionId: session.id,
          executionScope,
          command: "uptime",
        }),
      });
      expect(cancelledBeforeExecution.statusCode).toBe(502);
      expect(cancelledBeforeExecution.json().message).toContain("已取消");
      expect(sshServer.commands).toHaveLength(commandsBeforePreCancel);

      const auditRows = await db.prepare(`
        SELECT action, summary, details_json FROM audit_events
        WHERE action LIKE 'agent.ssh_%' ORDER BY created_at ASC
      `).all() as Array<{ action: string; summary: string; details_json: string }>;
      expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining([
        "agent.ssh_context_read",
        "agent.ssh_diagnostic_approved",
        "agent.ssh_diagnostic_executed",
        "agent.ssh_diagnostic_rejected",
        "agent.ssh_diagnostic_cancelled",
      ]));
      expect(JSON.stringify(auditRows)).not.toContain("server-diagnostic-secret");
      expect(JSON.stringify(auditRows)).not.toContain("server-stderr-secret");
      expect(JSON.stringify(auditRows)).toContain(identity.deviceId);

      const closed = await app.inject({ method: "DELETE", url: `/api/v1/ssh-sessions/${session.id}`, cookies: cookie, headers: agentHeaders });
      expect(closed.statusCode).toBe(204);
      const recordings = await app.inject({ method: "GET", url: "/api/v1/ssh-recordings", cookies: cookie });
      expect(recordings.statusCode).toBe(200);
      expect(recordings.json().items).toHaveLength(1);
      expect(recordings.json().items[0]).toMatchObject({ connectionName: "Local SSH Fixture", status: "completed" });
      const recording = await app.inject({ method: "GET", url: `/api/v1/ssh-recordings/${recordings.json().items[0].id}/download`, cookies: cookie });
      expect(recording.statusCode).toBe(200);
      expect(recording.body).toContain("SSH-TEST-READY");
      socket.close();
    } finally {
      await app.close();
      await new Promise<void>((resolve) => sshServer.server.close(() => resolve()));
    }
  }, 20_000);
});
