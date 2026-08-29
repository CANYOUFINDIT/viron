import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, type SFTPStream } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { MonitorInstallError, normalizeMonitorInstallPath, restartMonitorServiceCommand } from "../src/server/monitor-installer.js";
import { sanitizeMonitorInstallOutput } from "../src/server/monitor-install-task-manager.js";
import { PRODUCT_VERSION } from "../src/server/product-info.js";

const directories: string[] = [];
const packageFiles = [
  "viron-monitor",
  "viron-monitor-collector",
  "viron-monitor.service",
  "viron-monitor.service.legacy",
  "THIRD_PARTY_NOTICES.md",
  "install.sh",
  "manifest.json",
] as const;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testConfig(directory: string, monitorPackageDir: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "viron.db"),
    masterKey: Buffer.alloc(32, 41),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
    monitorPackageDir,
  };
}

function writeMonitorPackage(root: string) {
  const directory = join(root, "linux-amd64");
  mkdirSync(directory, { recursive: true });
  const content = new Map<string, Buffer>();
  for (const name of packageFiles) {
    const value = name === "manifest.json"
      ? Buffer.from(JSON.stringify({ product: "viron-monitor", version: PRODUCT_VERSION, architecture: "amd64" }))
      : Buffer.from(`fixture:${name}\n`);
    content.set(name, value);
    writeFileSync(join(directory, name), value);
  }
  const checksums = packageFiles.map((name) => `${createHash("sha256").update(content.get(name)!).digest("hex")}  ${name}`).join("\n");
  writeFileSync(join(directory, "SHA256SUMS"), `${checksums}\n`);
  return directory;
}

interface MonitorSshState {
  kernel: string;
  machine: string;
  systemd: boolean;
  privilege: "root" | "passwordless_sudo" | "unavailable";
  pathKind: "missing" | "directory" | "other";
  pathEmpty: boolean;
  manifestBase64: string;
  monitorPath: string;
  monitorInstalled: boolean;
  failInstall: boolean;
  installDelayMs: number;
  uploads: Map<string, Buffer>;
}

function preflightOutput(state: MonitorSshState) {
  return [
    "VIRON_MONITOR_PREFLIGHT_V1",
    `kernel=${state.kernel}`,
    `machine=${state.machine}`,
    `systemd=${state.systemd ? 1 : 0}`,
    `privilege=${state.privilege}`,
    `path_kind=${state.pathKind}`,
    `path_empty=${state.pathEmpty ? 1 : 0}`,
    ...(state.manifestBase64 ? [`manifest_base64=${state.manifestBase64}`] : []),
    `monitor_path=${state.monitorPath}`,
    "",
  ].join("\n");
}

function monitorPayload() {
  const collectedAt = new Date().toISOString();
  return {
    protocolVersion: 1,
    agentId: "d4f89c8e-23ae-4a21-a82a-2b204667be31",
    agentVersion: PRODUCT_VERSION,
    hostname: "installed-node",
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
          hostname: "installed-node",
          metricsVersion: 2,
          collectorUser: "root",
          operatingSystem: "linux",
          architecture: "amd64",
          kernelVersion: "6.8.0",
          cpuCount: 4,
          cpuUsedPercent: 12,
          load1: 0.2,
          load5: 0.3,
          load15: 0.4,
          memoryTotalBytes: 8_000_000_000,
          memoryUsedBytes: 4_000_000_000,
          memoryUsedPercent: 50,
          uptimeSeconds: 3600,
          disks: [],
          temperatures: [],
        },
        candidates: [],
        errors: [],
      },
    }],
    gaps: [],
  };
}

function installUploadServer(sftp: SFTPStream, uploads: Map<string, Buffer>) {
  const handles = new Map<number, string>();
  let nextHandle = 1;
  sftp.on("OPEN", (requestId, path) => {
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(nextHandle);
    handles.set(nextHandle, path);
    nextHandle += 1;
    uploads.set(path, Buffer.alloc(0));
    sftp.handle(requestId, handle);
  });
  sftp.on("WRITE", (requestId, rawHandle, offset, data) => {
    const path = rawHandle.length === 4 ? handles.get(rawHandle.readUInt32BE(0)) : undefined;
    if (!path) return sftp.status(requestId, 4);
    const current = uploads.get(path) ?? Buffer.alloc(0);
    const next = Buffer.alloc(Math.max(current.length, offset + data.length));
    current.copy(next);
    data.copy(next, offset);
    uploads.set(path, next);
    sftp.status(requestId, 0);
  });
  sftp.on("CLOSE", (requestId, rawHandle) => {
    if (rawHandle.length === 4) handles.delete(rawHandle.readUInt32BE(0));
    sftp.status(requestId, 0);
  });
}

async function startMonitorSshServer() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const commands: string[] = [];
  const state: MonitorSshState = {
    kernel: "Linux",
    machine: "x86_64",
    systemd: true,
    privilege: "passwordless_sudo",
    pathKind: "missing",
    pathEmpty: true,
    manifestBase64: "",
    monitorPath: "",
    monitorInstalled: false,
    failInstall: false,
    installDelayMs: 0,
    uploads: new Map(),
  };
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "monitor-secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => installUploadServer(acceptSftp(), state.uploads));
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          if (info.command.includes("VIRON_MONITOR_PREFLIGHT_V1")) stream.write(preflightOutput(state));
          else if (info.command === "mktemp -d /tmp/viron-monitor-install.XXXXXX") stream.write("/tmp/viron-monitor-install.A1b2C3\n");
          else if (info.command.includes("/install.sh")) {
            const finish = () => {
              if (state.failInstall) {
                stream.stderr.write("install failed password=monitor-secret token=private-token\n");
                stream.exit(1);
                stream.end();
                return;
              }
              state.monitorInstalled = true;
              stream.write("installed\n");
              stream.exit(0);
              stream.end();
            };
            if (state.installDelayMs) setTimeout(finish, state.installDelayMs);
            else finish();
            return;
          } else if (info.command.includes("viron-monitor pull")) {
            if (state.monitorInstalled) stream.write(JSON.stringify(monitorPayload()));
            else {
              stream.exit(127);
              stream.end();
              return;
            }
          } else if (info.command.includes("viron-monitor ack")) stream.write('{"ok":true}\n');
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
    server,
    port: (server.address() as AddressInfo).port,
    commands,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function createInstallationContext() {
  const directory = mkdtempSync(join(tmpdir(), "viron-monitor-installer-test-"));
  directories.push(directory);
  const packageRoot = join(directory, "packages");
  const packageDirectory = writeMonitorPackage(packageRoot);
  const ssh = await startMonitorSshServer();
  const config = testConfig(directory, packageRoot);
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
  const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "安装测试环境" } });
  const environmentId = environment.json().id as string;
  const connection = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-connections",
    cookies,
    payload: {
      environmentId,
      name: "安装测试节点",
      host: "127.0.0.1",
      port: ssh.port,
      username: "operator",
      authType: "password",
      credential: { password: "monitor-secret" },
      options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
    },
  });
  return { app, cookies, environmentId, connectionId: connection.json().id as string, packageDirectory, ssh };
}

describe("monitor installer", () => {
  it("redacts credentials from installation output", () => {
    expect(sanitizeMonitorInstallOutput("password=hunter2 token=abc Bearer xyz https://user:pass@example.test"))
      .toBe("password=[已隐藏] token=[已隐藏] Bearer [已隐藏] https://user:[已隐藏]@example.test");
  });

  it("restarts viron-monitor with root or passwordless sudo and fails closed when missing", () => {
    const command = restartMonitorServiceCommand();
    expect(command).toContain("command -v viron-monitor");
    expect(command).toContain("systemctl restart viron-monitor");
    expect(command).toContain("sudo -n systemctl restart viron-monitor");
    expect(command).toContain("exit 127");
    expect(command).toContain("exit 126");
  });

  it("accepts only normalized installation directories below /opt", () => {
    expect(normalizeMonitorInstallPath(undefined)).toBe("/opt/viron/monitor");
    expect(normalizeMonitorInstallPath("/opt/viron/custom/")).toBe("/opt/viron/custom");
    for (const path of ["opt/viron", "/opt", "/etc/viron", "/opt/viron/../other", "/opt/viron monitor", "/opt//viron"]) {
      expect(() => normalizeMonitorInstallPath(path)).toThrow(MonitorInstallError);
    }
  });

  it("reports install, conflict, legacy, privilege and architecture preflight states", async () => {
    const context = await createInstallationContext();
    const url = `/api/v1/environments/${context.environmentId}/monitor-hosts/${context.connectionId}/install/preflight`;
    try {
      const available = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(available.statusCode).toBe(200);
      expect(available.json().item).toMatchObject({ installPath: "/opt/viron/monitor", architecture: "amd64", pathState: "available", packageAvailable: true, canInstall: true });

      context.ssh.state.pathKind = "directory";
      context.ssh.state.pathEmpty = false;
      context.ssh.state.monitorPath = "/opt/viron/monitor/viron-monitor";
      context.ssh.state.manifestBase64 = Buffer.from(JSON.stringify({
        product: "viron-monitor",
        version: "0.1.3",
        architecture: "amd64",
        installPath: "/opt/viron/monitor",
        installedAt: "2026-08-01T00:00:00Z",
      })).toString("base64");
      const upgrade = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(upgrade.json().item).toMatchObject({ pathState: "upgrade", canInstall: true, existingInstallation: { version: "0.1.3" } });

      context.ssh.state.manifestBase64 = "";
      context.ssh.state.monitorPath = "";
      context.ssh.state.pathKind = "directory";
      context.ssh.state.pathEmpty = false;
      const conflict = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(conflict.json().item).toMatchObject({ pathState: "conflict", canInstall: false, issues: [expect.objectContaining({ code: "MONITOR_INSTALL_PATH_CONFLICT" })] });

      context.ssh.state.pathKind = "missing";
      context.ssh.state.pathEmpty = true;
      context.ssh.state.monitorPath = "/usr/local/bin/viron-monitor";
      const legacy = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(legacy.json().item).toMatchObject({ pathState: "legacy", canInstall: false, issues: [expect.objectContaining({ code: "LEGACY_MONITOR_INSTALLATION" })] });

      context.ssh.state.monitorPath = "";
      context.ssh.state.privilege = "unavailable";
      const privilege = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(privilege.json().item).toMatchObject({ privilege: "unavailable", canInstall: false, issues: [expect.objectContaining({ code: "MONITOR_INSTALL_PRIVILEGE_REQUIRED" })] });

      context.ssh.state.privilege = "root";
      context.ssh.state.machine = "riscv64";
      const architecture = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(architecture.json().item).toMatchObject({ architecture: null, packageAvailable: false, canInstall: false });
      expect(architecture.json().item.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNSUPPORTED_MONITOR_ARCHITECTURE" })]));
    } finally {
      await context.app.close();
      await context.ssh.close();
    }
  });

  it("uploads a verified package, installs it, pulls metrics and records audit metadata", async () => {
    const context = await createInstallationContext();
    const installUrl = `/api/v1/environments/${context.environmentId}/monitor-hosts/${context.connectionId}/install`;
    try {
      const installed = await context.app.inject({ method: "POST", url: installUrl, cookies: context.cookies, payload: { installPath: "/opt/viron/monitor" } });
      expect(installed.statusCode).toBe(200);
      expect(installed.json()).toMatchObject({
        ok: true,
        installation: { installPath: "/opt/viron/monitor", architecture: "amd64", version: PRODUCT_VERSION },
        monitor: { status: "ready", host: { hostname: "installed-node" } },
        monitorWarning: "",
      });
      expect([...context.ssh.state.uploads.keys()].sort()).toEqual([...packageFiles, "SHA256SUMS"].map((name) => `/tmp/viron-monitor-install.A1b2C3/${name}`).sort());
      expect(context.ssh.commands).toContain("sudo -n bash '/tmp/viron-monitor-install.A1b2C3/install.sh' --ssh-user 'operator' --install-dir '/opt/viron/monitor'");
      expect(context.ssh.commands.some((command) => command.includes("viron-monitor pull"))).toBe(true);

      const host = await context.app.db.prepare("SELECT install_path, install_architecture, install_managed, status FROM monitor_hosts WHERE ssh_connection_id = ?").get(context.connectionId) as { install_path: string; install_architecture: string; install_managed: number; status: string };
      expect(host).toMatchObject({ install_path: "/opt/viron/monitor", install_architecture: "amd64", install_managed: 1, status: "ready" });
      const workspace = await context.app.inject({ method: "GET", url: `/api/v1/environments/${context.environmentId}/service-deployments`, cookies: context.cookies });
      expect(workspace.json().discovery.hosts[0]).toMatchObject({ sshConnectionId: context.connectionId, monitorStatus: "ready" });
      const audit = await context.app.db.prepare("SELECT action, details_json FROM audit_events WHERE resource_id = ? AND action = ?").get(context.connectionId, "monitor_host.installed") as { action: string; details_json: string };
      expect(audit.action).toBe("monitor_host.installed");
      expect(JSON.parse(audit.details_json)).toMatchObject({ installPath: "/opt/viron/monitor", architecture: "amd64", version: PRODUCT_VERSION, mode: "install" });
    } finally {
      await context.app.close();
      await context.ssh.close();
    }
  });

  it("runs installation in the background with recoverable progress, redacted failures, and full retry", async () => {
    const context = await createInstallationContext();
    const taskUrl = `/api/v1/environments/${context.environmentId}/monitor-hosts/${context.connectionId}/install-tasks`;
    const latestUrl = `/api/v1/environments/${context.environmentId}/monitor-hosts/${context.connectionId}/install-task`;
    const waitForTerminalTask = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await context.app.inject({ method: "GET", url: latestUrl, cookies: context.cookies });
        const task = response.json().item as { status: string; [key: string]: unknown };
        if (task && !["pending", "running"].includes(task.status)) return task;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("installation task did not complete");
    };
    try {
      context.ssh.state.failInstall = true;
      context.ssh.state.installDelayMs = 40;
      const started = await context.app.inject({ method: "POST", url: taskUrl, cookies: context.cookies, payload: { installPath: "/opt/viron/monitor" } });
      expect(started.statusCode).toBe(202);
      expect(started.json().item).toMatchObject({ connectionId: context.connectionId, status: "running", phase: "queued", progress: 0 });

      const duplicate = await context.app.inject({ method: "POST", url: taskUrl, cookies: context.cookies, payload: { installPath: "/opt/viron/monitor" } });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ error: "MONITOR_INSTALL_RUNNING" });

      const failed = await waitForTerminalTask() as { status: string; phase: string; error: string; logs: Array<{ kind: string; message: string }> };
      expect(failed.status).toBe("error");
      expect(failed.phase).toBe("remote_install");
      expect(failed.error).toContain("[已隐藏]");
      expect(failed.error).not.toContain("monitor-secret");
      expect(failed.error).not.toContain("private-token");
      expect(failed.logs.some((entry) => entry.message.includes("正在上传安装包 8/8"))).toBe(true);

      context.ssh.state.failInstall = false;
      context.ssh.state.installDelayMs = 0;
      const retried = await context.app.inject({ method: "POST", url: taskUrl, cookies: context.cookies, payload: { installPath: "/opt/viron/monitor" } });
      expect(retried.statusCode).toBe(202);
      const completed = await waitForTerminalTask() as { status: string; phase: string; progress: number; logs: Array<{ kind: string; message: string }> };
      expect(completed).toMatchObject({ status: "success", phase: "complete", progress: 100 });
      expect(completed.logs).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "output", message: "installed" }),
        expect.objectContaining({ kind: "progress", message: "监控服务安装完成" }),
      ]));
    } finally {
      await context.app.close();
      await context.ssh.close();
    }
  });

  it("reports a version mismatch instead of treating the package as missing", async () => {
    const context = await createInstallationContext();
    const url = `/api/v1/environments/${context.environmentId}/monitor-hosts/${context.connectionId}/install/preflight`;
    try {
      writeFileSync(join(context.packageDirectory, "manifest.json"), JSON.stringify({
        product: "viron-monitor",
        version: "0.0.0",
        architecture: "amd64",
      }));
      const response = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().item).toMatchObject({ packageAvailable: false, canInstall: false });
      expect(response.json().item.issues).toEqual(expect.arrayContaining([expect.objectContaining({
        code: "MONITOR_PACKAGE_VERSION_MISMATCH",
        message: `监控安装包必须与 Viron ${PRODUCT_VERSION} 版本一致`,
      })]));
    } finally {
      await context.app.close();
      await context.ssh.close();
    }
  });

  it("rejects tampered server packages before upload", async () => {
    const context = await createInstallationContext();
    const url = `/api/v1/environments/${context.environmentId}/monitor-hosts/${context.connectionId}/install/preflight`;
    try {
      writeFileSync(join(context.packageDirectory, "viron-monitor"), "tampered\n");
      const response = await context.app.inject({ method: "POST", url, cookies: context.cookies, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().item).toMatchObject({ packageAvailable: false, canInstall: false });
      expect(response.json().item.issues).toEqual(expect.arrayContaining([expect.objectContaining({
        code: "MONITOR_PACKAGE_CHECKSUM_MISMATCH",
        message: "监控安装包校验失败：viron-monitor",
      })]));
      expect(context.ssh.state.uploads.size).toBe(0);
    } finally {
      await context.app.close();
      await context.ssh.close();
    }
  });

  it("rejects member probe install, preflight, and install-tasks", async () => {
    const context = await createInstallationContext();
    try {
      const now = new Date().toISOString();
      const memberRegistration = await context.app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { username: "install-member", password: "member-password-123" },
      });
      const org = await context.app.inject({ method: "POST", url: "/api/v1/organizations", cookies: context.cookies, payload: { name: "Install Org", description: "" } });
      await context.app.db.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'member', ?, ?)").run(
        org.json().id,
        memberRegistration.json().user.id,
        now,
        now,
      );
      const member = { envman_session: memberRegistration.cookies.find((item) => item.name === "envman_session")!.value };
      expect((await context.app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: member, payload: { type: "organization", id: org.json().id } })).statusCode).toBe(200);
      const base = `/api/v1/environments/${context.environmentId}/monitor-hosts/${context.connectionId}`;
      for (const path of [`${base}/install/preflight`, `${base}/install`, `${base}/install-tasks`]) {
        const response = await context.app.inject({ method: "POST", url: path, cookies: member, payload: { installPath: "/opt/viron/monitor" } });
        expect(response.statusCode, path).toBe(403);
        expect(response.json().error).toBe("WORKSPACE_ADMIN_REQUIRED");
      }
    } finally {
      await context.app.close();
      await context.ssh.close();
    }
  });
});
