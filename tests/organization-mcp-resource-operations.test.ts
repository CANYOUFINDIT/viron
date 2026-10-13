import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/server/database-workbench/connector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/database-workbench/connector.js")>();
  return {
    ...actual,
    connectDatabase: async () => ({
      connection: {
        query: async () => [[], []],
        destroy() {},
      },
      async close() {},
      record: { name: "fixture" },
    }),
  };
});

vi.mock("../src/server/ssh/connector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/ssh/connector.js")>();
  return {
    ...actual,
    connectSsh: async () => ({
      client: {
        sftp(callback: (error: Error | null, sftp: unknown) => void) {
          callback(null, {
            readdir(_path: string, done: (error: Error | null, entries: unknown[]) => void) {
              done(null, [{
                filename: "fake.txt",
                longname: "-rw-r--r-- 1 root root 4 Jan 1 00:00 fake.txt",
                attrs: { mode: 0o100644, size: 4, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false },
              }]);
            },
            end() {},
          });
        },
        end() {},
      },
      close() {},
    }),
  };
});

vi.mock("../src/server/ssh/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/ssh/command.js")>();
  return {
    ...actual,
    executeSshCommand: async () => ({ stdout: "fake-log-line\n", stderr: "", exitCode: 0, signal: null, durationMs: 1, truncated: false }),
  };
});

import { desktopMcpRequestIdentity, organizationMcpChecks } from "../src/desktop/organization-mcp-request.js";
import { issueApiKey } from "../src/server/api-keys.js";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { McpApiBridge } from "../src/server/mcp/api-bridge.js";
import { runWithExecutionChannel } from "../src/server/organization-boundary.js";

const scratchRoot = join(process.cwd(), "private", "grok-supervision-20261011");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0)) await finish();
});

async function fixture() {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "viron-mcp-resources-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 11),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  cleanup.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies[0].value };
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "MCP资源组织" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  const switched = await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: org } });
  expect(switched.statusCode, switched.body).toBe(200);
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产" } });
  const env = environment.json().id as string;
  const parent = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "父环境" } });
  const ssh = await app.inject({
    method: "POST", url: "/api/v1/ssh-connections", cookies,
    payload: { name: "源主机", host: "example.invalid", port: 22, username: "root", authType: "password", password: "fake-password", environmentIds: [env] },
  });
  const otherSsh = await app.inject({
    method: "POST", url: "/api/v1/ssh-connections", cookies,
    payload: { name: "目标主机", host: "other.invalid", port: 22, username: "root", authType: "password", password: "other-secret", environmentIds: [env] },
  });
  const database = await app.inject({
    method: "POST", url: "/api/v1/database-connections", cookies,
    payload: { name: "源库", engine: "mysql", host: "127.0.0.1", port: 9, username: "fake", credential: { password: "fake-db" }, environmentIds: [env] },
  });
  const targetDatabase = await app.inject({
    method: "POST", url: "/api/v1/database-connections", cookies,
    payload: { name: "目标库", engine: "mysql", host: "127.0.0.1", port: 9, username: "fake", credential: { password: "fake-db-target" }, environmentIds: [env] },
  });
  const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${env}/web-entries`, cookies, payload: { name: "控制台", url: "https://example.invalid" } });
  const credential = await app.inject({
    method: "POST", url: `/api/v1/web-entries/${entry.json().id}/credentials`, cookies,
    payload: { username: "operator", password: "web-secret", note: "", customFields: {} },
  });
  const logId = randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO environment_logs (id, environment_id, ssh_connection_id, name, file_path, file_paths_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, '应用日志', '/var/log/app.log', ?, 0, ?, ?)").run(logId, env, ssh.json().id, JSON.stringify(["/var/log/app.log"]), now, now);
  const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "mcp-member", password: "test-password-123" } });
  const userId = registered.json().user.id as string;
  await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, now, now);
  const memberCookies = { envman_session: registered.cookies[0].value };
  expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: memberCookies, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  const key = await issueApiKey(db, "personal", userId, "mcp-resource", userId);
  const base = `/api/v1/organizations/${org}`;
  async function grant(codes: string[], targets: Array<{ type: string; id: string }>) {
    const role = await app.inject({ method: "POST", url: `${base}/roles`, cookies, payload: { name: `角色-${randomUUID()}`, permissionCodes: codes, reason: "资源操作" } });
    expect(role.statusCode, role.body).toBe(201);
    expect((await app.inject({ method: "POST", url: `${base}/role-assignments`, cookies, payload: { roleId: role.json().id, subjectType: "user", subjectId: userId, reason: "分配" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${base}/role-data-grants`, cookies, payload: { roleId: role.json().id, targets, reason: "范围" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${base}/feature-grants`, cookies, payload: { subjectType: "user", subjectId: userId, targets, features: { mcp: true, agent: false, webPlugins: false }, reason: "MCP" } })).statusCode).toBe(201);
  }
  const bridge = new McpApiBridge(app);
  const calls: string[] = [];
  app.webAccountViews.snapshot = async (_user, credentialId) => {
    calls.push(credentialId);
    return {
      view: { entryName: "控制台", url: "https://example.invalid/home", title: "fixture-page" },
      text: "fixture-page",
      interactive: [],
    } as never;
  };
  async function invoke(name: string, arguments_: Record<string, unknown>) {
    const request = {
      headers: { authorization: `Bearer ${key.apiKey}`, "x-viron-workspace": `organization:${org}` },
      protocol: "http",
      hostname: "127.0.0.1",
    } as FastifyRequest;
    return bridge.runWithRequest(request, randomUUID(), () => bridge.invoke(name, { ...arguments_, workspace: `organization:${org}` }));
  }
  return {
    app, db, cookies, memberCookies, org, env, parentId: parent.json().id as string, base, grant, invoke, calls, userId,
    sshId: ssh.json().id as string,
    otherSshId: otherSsh.json().id as string,
    databaseId: database.json().id as string,
    targetDatabaseId: targetDatabase.json().id as string,
    entryId: entry.json().id as string,
    credentialId: credential.json().id as string,
    logId,
  };
}

describe("organization MCP resource operations", () => {
  it("keeps query and upload bytes in the request identity", () => {
    const left = desktopMcpRequestIdentity({ method: "GET", path: "/api/v1/ssh-connections/00000000-0000-4000-8000-000000000001/sftp?path=/tmp" });
    const right = desktopMcpRequestIdentity({ method: "GET", path: "/api/v1/ssh-connections/00000000-0000-4000-8000-000000000001/sftp?path=/var" });
    expect(left.path).toBe(right.path);
    expect(left.bodyDigest).not.toBe(right.bodyDigest);
    const firstFile = desktopMcpRequestIdentity({ method: "POST", path: "/api/v1/web-credentials/00000000-0000-4000-8000-000000000001/view/upload", form: { files: [{ fieldName: "file", filename: "a.txt", contentType: "text/plain", contentBase64: Buffer.from("one").toString("base64") }] } });
    const secondFile = desktopMcpRequestIdentity({ method: "POST", path: "/api/v1/web-credentials/00000000-0000-4000-8000-000000000001/view/upload", form: { files: [{ fieldName: "file", filename: "a.txt", contentType: "text/plain", contentBase64: Buffer.from("two").toString("base64") }] } });
    expect(firstFile.bodyDigest).not.toBe(secondFile.bodyDigest);
    expect(firstFile.bodyDigest).toHaveLength(64);
  });

  it("uses the stored task connection instead of a body connection id", async () => {
    const source = "00000000-0000-4000-8000-000000000010";
    const forged = "00000000-0000-4000-8000-000000000099";
    const taskId = "00000000-0000-4000-8000-0000000000aa";
    const checks = await organizationMcpChecks({
      method: "GET",
      path: `/api/v1/database-tasks/${taskId}/download`,
      body: { connectionId: forged, targetConnectionId: forged },
    }, {
      webEntryId: async () => null,
      databaseTask: async () => ({ type: "backup", connectionId: source, details: { database: "app" } }),
      databaseQuery: async () => null,
      sftpTransfer: async () => null,
    });
    expect(checks).toEqual([
      { target: { type: "database_connection", id: source }, code: "database.read" },
      { target: { type: "database_connection", id: source }, code: "database.export" },
    ]);
    expect(JSON.stringify(checks)).not.toContain(forged);
  });

  it("authorizes web, log, SFTP, and database tasks through the MCP bridge", async () => {
    const f = await fixture();
    const deniedWeb = await f.invoke("viron_web_page_snapshot", { credentialId: f.credentialId });
    expect(deniedWeb.status).toBe(403);
    expect(deniedWeb.data).toMatchObject({ error: "ACTION_FORBIDDEN" });
    expect(f.calls).toEqual([]);
    await f.grant(["web.use"], [{ type: "environment", id: f.env }]);
    const parentWeb = await f.invoke("viron_web_page_snapshot", { credentialId: f.credentialId });
    expect(parentWeb.status).toBe(403);
    expect(f.calls).toEqual([]);
    await f.grant(["web.use"], [{ type: "web_entry", id: f.entryId }]);
    const allowedWeb = await f.invoke("viron_web_page_snapshot", { credentialId: f.credentialId });
    expect(allowedWeb.status).toBe(200);
    expect(JSON.stringify(allowedWeb.data)).toContain("fixture-page");
    expect(JSON.stringify(allowedWeb.data)).not.toContain("web-secret");
    expect(f.calls).toEqual([f.credentialId]);

    const deniedLog = await f.invoke("viron_environment_log_snapshot", { logId: f.logId });
    expect(deniedLog.status).toBe(403);
    await f.grant(["logs.view"], [{ type: "environment_log", id: f.logId }]);
    const allowedLog = await f.invoke("viron_environment_log_snapshot", { logId: f.logId });
    expect(allowedLog.status).toBe(200);
    expect(JSON.stringify(allowedLog.data)).toContain("fake-log-line");
    expect(JSON.stringify(allowedLog.data)).not.toContain("fake-password");

    const deniedSftp = await f.invoke("viron_sftp_directory_list", { connectionId: f.sshId, path: "/tmp" });
    expect(deniedSftp.status).toBe(403);
    await f.grant(["ssh.browse", "ssh.download"], [{ type: "ssh_connection", id: f.sshId }]);
    const allowedSftp = await f.invoke("viron_sftp_directory_list", { connectionId: f.sshId, path: "/tmp" });
    expect(allowedSftp.status).toBe(200);
    expect(JSON.stringify(allowedSftp.data)).toContain("fake.txt");
    const otherDirectory = await f.invoke("viron_sftp_directory_list", { connectionId: f.sshId, path: "/var" });
    expect(otherDirectory.status).toBe(200);
    expect((allowedSftp.data as { path: string }).path).not.toBe((otherDirectory.data as { path: string }).path);

    const deniedTransfer = await f.invoke("viron_sftp_transfer_preview", {
      sourceConnectionId: f.sshId, targetConnectionId: f.otherSshId, sourcePath: "/tmp/fake.txt", targetDirectory: "/dest",
    });
    expect(deniedTransfer.status).toBe(403);
    await f.grant(["ssh.upload"], [{ type: "ssh_connection", id: f.otherSshId }]);
    await f.grant(["ssh.download"], [{ type: "ssh_connection", id: f.sshId }]);

    const memberBackupDenied = await runWithExecutionChannel("mcp", (headers) => f.app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${f.databaseId}/backup`,
      cookies: f.memberCookies,
      headers,
      payload: { database: "app", includeData: false },
    }));
    expect(memberBackupDenied.statusCode).toBe(403);
    await f.grant(["database.read", "database.export"], [{ type: "database_connection", id: f.databaseId }]);
    const allowedBackup = await runWithExecutionChannel("mcp", (headers) => f.app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${f.databaseId}/backup`,
      cookies: f.memberCookies,
      headers,
      payload: { database: "app", includeData: false },
    }));
    expect(allowedBackup.statusCode, allowedBackup.body).toBe(202);
    const backupId = allowedBackup.json().task.id as string;
    const finished = await vi.waitFor(async () => {
      const task = f.app.databaseTasks.get(backupId, f.userId, null);
      expect(task && !["pending", "running"].includes(task.status)).toBeTruthy();
      return task;
    });
    expect(finished?.status).toBe("success");
    const deniedMove = await runWithExecutionChannel("mcp", (headers) => f.app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${f.databaseId}/transfer`,
      cookies: f.memberCookies,
      headers,
      payload: { sourceDatabase: "app", targetConnectionId: f.targetDatabaseId, targetDatabase: "app", includeStructure: false, includeData: true, includeObjects: false, dropExisting: false },
    }));
    expect(deniedMove.statusCode).toBe(403);
    await f.grant(["database.read", "database.write"], [{ type: "database_connection", id: f.targetDatabaseId }]);
    const allowedMove = await runWithExecutionChannel("mcp", (headers) => f.app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${f.databaseId}/transfer`,
      cookies: f.memberCookies,
      headers,
      payload: { sourceDatabase: "app", targetConnectionId: f.targetDatabaseId, targetDatabase: "app", includeStructure: false, includeData: true, includeObjects: false, dropExisting: false },
    }));
    expect(allowedMove.statusCode, allowedMove.body).toBe(202);
    const unknown = await runWithExecutionChannel("mcp", (headers) => f.app.inject({
      method: "GET",
      url: "/api/v1/connections",
      cookies: f.memberCookies,
      headers,
    }));
    expect(unknown.statusCode).toBe(403);
    const status = await runWithExecutionChannel("mcp", (headers) => f.app.inject({
      method: "GET",
      url: `/api/v1/database-tasks/${backupId}`,
      cookies: f.memberCookies,
      headers,
    }));
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().task.id).toBe(backupId);
  });
});
