import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import ssh2 from "ssh2";

const { Server: SshServer } = ssh2;

// Critical-user-flow integration: production server and UI are real; external database and Electron bridge boundaries use deterministic fixtures.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = resolve(repositoryRoot, ".tmp/user-flow-verification");
const adminUsername = "flow-admin";
const adminPassword = "Flow-password-123";
const flowSuffix = `${Date.now()}-${process.pid}`;
const environmentName = `全流程环境-${flowSuffix}`;
const serviceName = `全流程服务-${flowSuffix}`;
const organizationName = `全流程组织-${flowSuffix}`;
const projectName = `全流程项目-${flowSuffix}`;
const mockDatabaseName = "flow_database";
const mockConnectionName = `全流程数据库-${flowSuffix}`;
const mockConnectionId = "10000000-0000-4000-8000-000000000001";
const mockSessionId = "20000000-0000-4000-8000-000000000001";

const initialCertificatePem = `-----BEGIN CERTIFICATE-----
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

const rotatedCertificatePem = `-----BEGIN CERTIFICATE-----
MIIC+zCCAeOgAwIBAgIJAMHzX820zkk3MA0GCSqGSIb3DQEBCwUAMBwxGjAYBgNV
BAMMEWZsb3cucm90YXRlZC50ZXN0MB4XDTI2MDgyODEwNTgwM1oXDTI3MDgyODEw
NTgwM1owHDEaMBgGA1UEAwwRZmxvdy5yb3RhdGVkLnRlc3QwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC6HJk7VociweY8lrEouqUEBhk/EkF7DRnLrxlL
boI9YqD2GADN721oP/lO1VRrTDFIDvMwCRBJuhS2iS2EgUc3FLRDMPydDonqHM6P
ZIaPRhYLRUQ7UiIoSqw7OTscc2cBwzuzz1puDPBFGD9SXVJ1OI8wKL3C9p8Ms8t+
BEFU5XQxxwZm+DFkxwo1t7dwKoyDUH2ZPr4ZCl6nCrrL0VkuqV+PjdzwcLyusKrU
22zKKWvNM0ZnP+izaaL5iiTmvdrmN12yjSBxBrKpG8q3fVuFleGiWRub+JNxMPDv
noj/CUd+KswEGwWl0sca5tnTEp1G1+BPzihYYesPjtKaXUPVAgMBAAGjQDA+MDwG
A1UdEQQ1MDOCEWZsb3cucm90YXRlZC50ZXN0gg9hZG1pbi5mbG93LnRlc3SCDWFw
aS5mbG93LnRlc3QwDQYJKoZIhvcNAQELBQADggEBADJrXQVDqAAhtRqEMQbwsxUC
t1odvcy5a5fddE62kIOhboNz+Ws9/tJl3rDJS41Ou7MDwqSQkqc1f3f2jpkcS4JA
1eaMGhZt6cx4AkDHOr5WBPfdOZRpuAOV8a6U0VBpCnAaPS3zFfAg8ErylPQVVQZx
aD3jJA8Wf7cdIvc2AjJ5IIN3vyzzacFxTJeH1+pnBVnnJujO1QKb38KSEQWsRelQ
c7wGYbE/7LAObH3jKnVcPJYm7QxeChbWsWwAjxqJ6/DIJjou1tyMAflzs5/JkLlX
XHcKplSt7kmW3S1D37NqU19vNeu3tVBqWV8Yu2w4pcku5ZwgjhpLHTa5dbW0tRo=
-----END CERTIFICATE-----`;

function browserExecutable() {
  const programFiles = process.env.PROGRAMFILES;
  const programFilesX86 = process.env["PROGRAMFILES(X86)"];
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.VIRON_FLOW_BROWSER,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    programFiles && join(programFiles, "Google/Chrome/Application/chrome.exe"),
    programFilesX86 && join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
    programFiles && join(programFiles, "Microsoft/Edge/Application/msedge.exe"),
    programFilesX86 && join(programFilesX86, "Microsoft/Edge/Application/msedge.exe"),
    localAppData && join(localAppData, "Google/Chrome/Application/chrome.exe"),
    localAppData && join(localAppData, "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error("未找到可用于关键用户流集成测试的 Chrome/Chromium/Edge；请安装浏览器或通过 VIRON_FLOW_BROWSER 指定可执行文件");
  }
  return executable;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object", "无法分配全流程测试端口");
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

async function startFlowSshServer() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  let certificatePem = initialCertificatePem;
  const commands = [];
  const server = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === "flow-secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          if (info.command.includes("openssl s_client")) {
            stream.write(`${certificatePem}\nVerify return code: 18 (self signed certificate)\n`);
            stream.exit(0);
          } else if (info.command.includes("worker.service")) {
            stream.stderr.write("SSH 执行失败\n");
            stream.exit(1);
          } else {
            stream.write("ok\n");
            stream.exit(0);
          }
          stream.end();
        });
      });
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object", "无法分配 SSH fixture 端口");
  return {
    port: address.port,
    commands,
    useCertificate(pem) { certificatePem = pem; },
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`测试服务提前退出（${child.exitCode}）\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`等待测试服务启动超时\n${output()}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("close", resolveExit)).then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 3_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function observePage(page, failures) {
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.stack || error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) {
      failures.push(`API ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
}

async function expectVisible(locator, label, timeout = 20_000) {
  await locator.waitFor({ state: "visible", timeout }).catch((error) => {
    throw new Error(`${label}未显示`, { cause: error });
  });
  return locator;
}

async function expectNoRouteError(page, label) {
  assert.equal(await page.locator(".route-error-state").count(), 0, `${label}触发了页面级错误状态`);
}

async function loginThroughUi(page, baseUrl, { desktop = false } = {}) {
  await page.goto(desktop ? `${baseUrl}/#/login` : `${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await expectVisible(page.getByRole("heading", { name: "登录 Viron" }), "登录页");
  if (desktop) await page.getByLabel("Viron Endpoint").fill(baseUrl);
  await page.getByPlaceholder("输入用户名").fill(adminUsername);
  await page.getByPlaceholder("输入密码").fill(adminPassword);
  await Promise.all([
    page.waitForURL((url) => desktop ? url.pathname === "/" && url.hash === "#/monitoring" : url.pathname === "/monitoring", { timeout: 20_000 }),
    page.getByRole("button", { name: "进入运维桌面" }).click(),
  ]);
  await expectVisible(page.locator(".monitoring-view"), "监控大盘");
  await expectNoRouteError(page, "登录流程");
}

function openFlowDatabase(dataDirectory) {
  const db = new Database(join(dataDirectory, "envman.db"));
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  return db;
}

function seedMonitoringFixture(dataDirectory, { environmentId, connectionId, serviceName }) {
  const db = openFlowDatabase(dataDirectory);
  try {
    const now = new Date().toISOString();
    const host = db.prepare("SELECT ssh_connection_id FROM monitor_hosts WHERE ssh_connection_id = ?").get(connectionId);
    if (!host) {
      db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
          last_collected_at, last_pulled_at, install_path, install_architecture, install_managed, installed_at, updated_at
        ) VALUES (?, ?, '0.1.4', 1, 'ready', 1, ?, '[]', '[]', '', ?, ?, '', '', 1, ?, ?)
      `).run(connectionId, randomUUID(), JSON.stringify({
        cpuUsedPercent: 18, memoryUsedPercent: 33, disks: [{ path: "/", usedPercent: 41 }], operatingSystem: "linux", architecture: "amd64", resolutionSeconds: 30,
      }), now, now, now, now);
    }
    db.prepare(`
      INSERT INTO monitor_samples (
        ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at, resolution_seconds, payload_json, received_at
      ) VALUES (?, 'flow-agent', 1, 1, ?, 30, ?, ?)
    `).run(connectionId, now, JSON.stringify({
      collectedAt: now,
      host: { cpuUsedPercent: 18 },
      candidates: [{ provider: "systemd", externalId: "flow.service", name: serviceName, cpuUsedPercent: 11, memoryBytes: 128 }],
    }), now);
    const alertSeverities = ["info", "warning", "critical", "major", "warning", "critical", "info"];
    const insertAlert = db.prepare(`
      INSERT INTO monitor_alerts (
        id, environment_id, target_type, target_id, rule_type, rule_key,
        ssh_connection_id, environment_name, target_name, connection_name,
        status, severity, peak_severity, details_json, triggered_at, last_seen_at,
        created_at, updated_at
      ) VALUES (?, ?, 'host', ?, 'cpu', ?, ?, '全流程测试环境', ?, 'flow-host-a',
        'event', ?, ?, '{}', ?, ?, ?, ?)
    `);
    alertSeverities.forEach((severity, index) => {
      const at = new Date(Date.now() - index * 60_000).toISOString();
      insertAlert.run(
        randomUUID(), environmentId, randomUUID(), `flow-priority-${index}`, connectionId,
        `flow-alert-${index}`, severity, severity, at, at, at, at,
      );
    });
  } finally {
    db.close();
  }
}

async function verifyEnvironmentAndMaintenance(page, { baseUrl, sshFixture }) {
  await page.locator(".primary-menu").getByRole("button", { name: "环境总览" }).click();
  await page.waitForURL((url) => url.pathname === "/overview", { timeout: 20_000 });
  await expectVisible(page.locator(".overview-view"), "环境总览");

  await page.getByRole("button", { name: "新建环境", exact: true }).click();
  const environmentDialog = page.getByRole("dialog", { name: "新建环境" });
  await expectVisible(environmentDialog, "新建环境对话框");
  await environmentDialog.getByPlaceholder("例如：生产环境").fill(environmentName);
  await environmentDialog.locator("textarea").fill("全流程测试创建的临时环境");
  await environmentDialog.getByRole("button", { name: "创建环境", exact: true }).click();

  const environmentLink = page.getByRole("link", { name: `进入 ${environmentName} 工作区` });
  await expectVisible(environmentLink, "新环境卡片");
  await environmentLink.click();
  await page.waitForURL((url) => /^\/environments\/[^/]+$/.test(url.pathname), { timeout: 20_000 });
  const environmentId = new URL(page.url()).pathname.split("/").at(-1);
  assert(environmentId, "环境详情 URL 缺少环境 ID");

  await page.getByRole("button", { name: /服务维护/ }).click();
  await expectVisible(page.locator(".maintenance-console"), "服务维护工作台");
  await expectVisible(page.getByText("尚未录入服务", { exact: true }).first(), "服务维护空状态");

  await page.locator(".maintenance-toolbar").getByRole("button", { name: "录入服务", exact: true }).click();
  const serviceDialog = page.getByRole("dialog", { name: "录入服务" });
  await expectVisible(serviceDialog, "录入服务对话框");
  await serviceDialog.getByPlaceholder("例如：订单 API").fill(serviceName);
  await serviceDialog.getByPlaceholder("说明服务职责、依赖或维护注意事项").fill("全流程测试服务");
  await serviceDialog.getByRole("button", { name: "保存服务", exact: true }).click();
  await expectVisible(page.locator(".maintenance-directory").getByText(serviceName, { exact: true }), "新服务目录项");

  const sshPayload = (name) => ({
    environmentId,
    name,
    host: "127.0.0.1",
    port: sshFixture.port,
    username: "operator",
    authType: "password",
    credential: { password: "flow-secret" },
    options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "", loginScriptEnabled: false, loginScript: "" },
  });
  const sshA = await page.request.post(`${baseUrl}/api/v1/ssh-connections`, { data: sshPayload("flow-host-a") });
  const sshB = await page.request.post(`${baseUrl}/api/v1/ssh-connections`, { data: sshPayload("flow-host-b") });
  assert.equal(sshA.status(), 201, "创建 SSH A 失败");
  assert.equal(sshB.status(), 201, "创建 SSH B 失败");
  const connectionA = await sshA.json();
  const connectionB = await sshB.json();
  const serviceRow = await page.request.get(`${baseUrl}/api/v1/environments/${environmentId}/service-deployments`);
  const serviceId = (await serviceRow.json()).services[0].id;
  const depAResponse = await page.request.post(`${baseUrl}/api/v1/services/${serviceId}/deployments`, {
    data: { sshConnectionId: connectionA.id, provider: "systemd", externalId: "flow.service", displayName: "flow-a", origin: "manual" },
  });
  const depBResponse = await page.request.post(`${baseUrl}/api/v1/services/${serviceId}/deployments`, {
    data: { sshConnectionId: connectionB.id, provider: "systemd", externalId: "worker.service", displayName: "flow-b", origin: "manual" },
  });
  assert.equal(depAResponse.status(), 201, "创建部署节点 A 失败");
  assert.equal(depBResponse.status(), 201, "创建部署节点 B 失败");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /服务维护/ }).click();
  await expectVisible(page.locator(".deployment-card").getByText("flow-a"), "部署节点 A");
  await page.locator(".deployment-select-all input").check();
  await page.getByRole("button", { name: "批量重启", exact: true }).click();
  const confirm = page.getByRole("dialog").last();
  await expectVisible(confirm, "批量确认");
  await confirm.getByRole("button", { name: /确定|确认|OK/ }).click();
  await expectVisible(page.getByText("SSH 执行失败"), "批量部分失败结果");
  assert(sshFixture.commands.some((command) => command.includes("flow.service")), "批量操作未执行成功目标的真实 SSH 命令");
  assert(sshFixture.commands.some((command) => command.includes("worker.service")), "批量操作未执行失败目标的真实 SSH 命令");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  process.stdout.write("Given/When/Then 服务批量部分失败: pass\n");

  await page.locator(".maintenance-toolbar").getByRole("button", { name: "告警设置", exact: true }).click();
  const alertDialog = page.getByRole("dialog", { name: "监控告警设置" });
  await expectVisible(alertDialog, "监控告警设置对话框");
  await alertDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expectNoRouteError(page, "环境与服务维护流程");
  return { environmentId, serviceName, connectionId: connectionA.id };
}

async function verifyCredentialsAndMonitoring(page, { environmentId, serviceName, connectionId, dataDirectory, baseUrl, sshFixture }) {
  const adminEntry = await page.request.post(`${baseUrl}/api/v1/environments/${environmentId}/web-entries`, {
    data: { name: "admin", url: "https://admin.flow.test", description: "", tags: [] },
  });
  const apiEntry = await page.request.post(`${baseUrl}/api/v1/environments/${environmentId}/web-entries`, {
    data: { name: "api", url: "https://api.flow.test", description: "", tags: [] },
  });
  assert.equal(adminEntry.status(), 201, "创建 admin Web 入口失败");
  assert.equal(apiEntry.status(), 201, "创建 api Web 入口失败");
  const adminEntryId = (await adminEntry.json()).id;
  const apiEntryId = (await apiEntry.json()).id;
  const endpointResponse = await page.request.post(`${baseUrl}/api/v1/environments/${environmentId}/tls-endpoints`, {
    data: { host: "127.0.0.1", port: 443, sni: "app.example.com", sshConnectionId: connectionId },
  });
  assert.equal(endpointResponse.status(), 201, "创建 TLS 端点失败");
  const endpointId = (await endpointResponse.json()).id;
  const linkResponse = await page.request.put(`${baseUrl}/api/v1/tls-endpoints/${endpointId}/web-entries`, {
    data: { webEntryIds: [adminEntryId, apiEntryId] },
  });
  assert.equal(linkResponse.status(), 200, "关联多个 Web 入口失败");
  const probeResponse = await page.request.post(`${baseUrl}/api/v1/tls-endpoints/${endpointId}/probe`);
  assert.equal(probeResponse.status(), 200, "真实 SSH TLS 探测失败");
  seedMonitoringFixture(dataDirectory, { environmentId, connectionId, serviceName });

  const expandSidebar = page.getByRole("button", { name: "展开左侧菜单" });
  if (await expandSidebar.count()) await expandSidebar.click();
  await page.locator(".primary-menu").getByRole("button", { name: "密钥与证书" }).click();
  await page.waitForURL((url) => url.pathname === "/ssh-keys", { timeout: 20_000 });
  await expectVisible(page.getByRole("heading", { name: "密钥与证书" }), "密钥与证书页");
  await expectVisible(page.getByRole("tab", { name: /SSH 密钥/ }), "SSH 密钥 Tab");
  await page.getByRole("tab", { name: "SSL/TLS 证书" }).click();
  await expectVisible(page.locator(".certificate-center"), "证书中心");
  await expectVisible(page.getByRole("heading", { name: "app.example.com" }), "同证书 CN");
  await expectVisible(page.locator(".cert-card li").filter({ hasText: "admin.flow.test" }), "admin 入口");
  await expectVisible(page.locator(".cert-card li").filter({ hasText: "api.flow.test" }), "api 入口");
  sshFixture.useCertificate(rotatedCertificatePem);
  const rotateEndpoint = await page.request.post(`${baseUrl}/api/v1/environments/${environmentId}/tls-endpoints`, {
    data: { host: "127.0.0.1", port: 8443, sni: "flow.rotated.test", sshConnectionId: connectionId },
  });
  assert.equal(rotateEndpoint.status(), 201, "创建轮换 TLS 端点失败");
  const rotatedEndpointId = (await rotateEndpoint.json()).id;
  const rotateLink = await page.request.put(`${baseUrl}/api/v1/tls-endpoints/${rotatedEndpointId}/web-entries`, {
    data: { webEntryIds: [adminEntryId, apiEntryId] },
  });
  assert.equal(rotateLink.status(), 200, "切换 Web 入口的证书端点失败");
  const rotateProbe = await page.request.post(`${baseUrl}/api/v1/tls-endpoints/${rotatedEndpointId}/probe`);
  assert.equal(rotateProbe.status(), 200, "轮换后的真实 SSH TLS 探测失败");
  const removeOldEndpoint = await page.request.delete(`${baseUrl}/api/v1/tls-endpoints/${endpointId}`);
  assert.equal(removeOldEndpoint.status(), 204, "移除旧证书端点失败");
  const certificates = await page.request.get(`${baseUrl}/api/v1/certificates`);
  assert.equal(certificates.status(), 200, "读取证书列表失败");
  const certificateItems = (await certificates.json()).items;
  assert(certificateItems.some((item) => item.leafCn === "flow.rotated.test" && item.endpointCount === 1), "轮换证书未绑定原端点");
  assert(certificateItems.some((item) => item.leafCn === "app.example.com" && item.endpointCount === 0), "旧证书未保留为孤儿资产");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "SSL/TLS 证书" }).click();
  await expectVisible(page.getByRole("heading", { name: "flow.rotated.test" }), "轮换后证书");
  process.stdout.write("Given/When/Then 多入口同证书与轮换: pass\n");

  await page.locator(".primary-menu").getByRole("button", { name: "监控大盘" }).click();
  await page.waitForURL((url) => url.pathname === "/monitoring", { timeout: 20_000 });
  await expectVisible(page.getByRole("heading", { name: "监控大盘" }), "监控大盘页");
  await expectVisible(page.getByRole("heading", { name: "重点告警事件" }), "重点告警事件");
  await page.waitForFunction(() => document.querySelectorAll(".priority-event-panel .event-row").length === 5);
  assert.equal(await page.locator(".priority-event-panel .event-row").count(), 5, "重点告警未限制为 5 条");
  assert.equal(await page.locator(".priority-event-panel .event-row .tone-badge").first().innerText(), "CRITICAL", "重点告警未按严重度排序");
  await expectVisible(page.getByText(serviceName).first(), "重点告警下方的服务列表");
  if (process.env.VIRON_CAPTURE_FLOW_SCREENSHOTS === "true") {
    await page.screenshot({ path: resolve(artifactDirectory, "monitoring-top5-review.png"), fullPage: true });
  }
  await page.getByRole("button", { name: /查看全部系统告警/ }).click();
  await expectVisible(page.getByRole("heading", { name: "全部系统告警" }), "全部系统告警抽屉");
  await page.waitForFunction(() => document.querySelectorAll(".drawer-event-list .event-row").length >= 7);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "主机节点" }).click();
  await expectVisible(page.locator(".priority-host-grid").first(), "监控主机卡片列表");
  await expectVisible(page.locator(".probe-state-tabs"), "探针状态分类");
  await expectVisible(page.getByText("按探针状态分组，组内按资源压力排序"), "主机分类说明");
  await expectVisible(page.locator('[data-probe-state="unreachable"]'), "连接异常探针分类");
  await expectVisible(page.locator('[data-probe-state="unchecked"]'), "尚未检测探针分类");
  await expectVisible(page.getByText("状态判定依据").or(page.getByText("优先处理原因")).first(), "主机状态判定依据");
  assert.equal(await page.locator(".host-pressure-score").count(), 0, "主机列表仍展示难以理解的压力裸分数");
  if (process.env.VIRON_CAPTURE_FLOW_SCREENSHOTS === "true") {
    await page.screenshot({ path: resolve(artifactDirectory, "monitoring-host-cards-review.png"), fullPage: true });
  }
  await expectVisible(page.getByRole("heading", { name: "flow-host-a" }), "监控主机下钻");
  await page.getByRole("heading", { name: "flow-host-a" }).click();
  await expectVisible(page.locator(".host-resource-detail"), "监控主机详情");
  if (process.env.VIRON_CAPTURE_FLOW_SCREENSHOTS === "true") {
    await page.screenshot({ path: resolve(artifactDirectory, "monitoring-host-detail-review.png"), fullPage: true });
  }
  await page.getByRole("tab", { name: "主机节点" }).click();
  await expectVisible(page.locator(".priority-host-grid").first(), "重新进入主机卡片列表");
  await page.getByRole("tab", { name: "告警与服务" }).click();
  await expectVisible(page.getByText(serviceName).first(), "服务时序下钻");
  process.stdout.write("Given/When/Then 监控双页与主机下钻: pass\n");
  await expectNoRouteError(page, "凭据中心与监控大盘流程");
}

async function installDatabaseFixture(page) {
  const connection = {
    id: mockConnectionId,
    profileParentId: null,
    profileName: "",
    type: "database",
    name: mockConnectionName,
    engine: "mysql",
    host: "database.flow.invalid",
    port: 3306,
    username: "flow",
    environmentId: null,
    environmentIds: [],
    connectionGroupId: null,
    connectionGroupPath: null,
    defaultDatabase: mockDatabaseName,
    connectionMode: "tcp",
    options: {},
    canManage: true,
    starred: false,
    color: "",
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const emptyItemCollections = new Set([
      "/api/v1/database-object-favorites",
      "/api/v1/database-query-history",
      "/api/v1/database-query-favorites",
      "/api/v1/database-saved-queries",
      "/api/v1/database-tasks",
      "/api/v1/database-object-groups",
    ]);

    if (path === "/api/v1/connections" && url.searchParams.get("type") === "database") {
      return route.fulfill({ json: { items: [connection] } });
    }
    if (path === "/api/v1/connection-groups" && url.searchParams.get("type") === "database") {
      return route.fulfill({ json: { items: [] } });
    }
    if ([...emptyItemCollections].some((candidate) => path === candidate)) {
      return route.fulfill({ json: { items: [] } });
    }
    if (path === "/api/v1/database-sessions" && request.method() === "POST") {
      return route.fulfill({ status: 201, json: { item: { id: mockSessionId } } });
    }
    if (path === `/api/v1/database-connections/${mockConnectionId}/schemas`) {
      return route.fulfill({ json: { items: [{ name: mockDatabaseName, charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }] } });
    }
    if (path === `/api/v1/database-connections/${mockConnectionId}/objects`) {
      const category = url.searchParams.get("category");
      const items = category === "tables" ? [{
        name: "flow_items",
        rowCount: 2,
        dataSize: 256,
        engine: "InnoDB",
        comment: "full-flow fixture",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
        collation: "utf8mb4_unicode_ci",
      }] : [];
      return route.fulfill({ json: { items } });
    }
    if (path === `/api/v1/database-connections/${mockConnectionId}/completion-metadata`) {
      return route.fulfill({ json: {
        database: mockDatabaseName,
        objects: [{ name: "flow_items", type: "table", columns: [{ name: "id", dataType: "int", columnType: "int" }] }],
        routines: [],
      } });
    }
    if (path === `/api/v1/active-connections/${mockSessionId}` && request.method() === "GET") {
      return route.fulfill({ json: { item: { id: mockSessionId, type: "database", status: "active" } } });
    }
    if (path === `/api/v1/active-connections/${mockSessionId}` && request.method() === "DELETE") {
      return route.fulfill({ status: 204, body: "" });
    }
    return route.continue();
  });
}

async function verifyDatabaseWorkbench(page, baseUrl) {
  await installDatabaseFixture(page);
  await page.goto(`${baseUrl}/database`, { waitUntil: "domcontentloaded" });
  const workbench = page.locator(".database-workbench");
  await expectVisible(workbench, "数据库工作台");

  const navigationToggle = page.getByRole("button", { name: "隐藏或显示导航窗格" });
  await navigationToggle.click();
  assert.equal(await page.locator(".database-navigator").count(), 0, "导航窗格未关闭");
  await navigationToggle.click();
  await expectVisible(page.locator(".database-navigator"), "恢复后的数据库导航窗格");

  const informationToggle = page.getByRole("button", { name: "隐藏或显示信息窗格" });
  await informationToggle.click();
  await expectVisible(page.locator(".database-information-pane"), "数据库信息窗格");
  await page.getByRole("button", { name: "关闭信息窗格" }).click();
  assert.equal(await page.locator(".database-information-pane").count(), 0, "信息窗格未关闭");

  const connectionButton = page.getByRole("button", { name: mockConnectionName, exact: true });
  await expectVisible(connectionButton, "模拟数据库连接");
  await connectionButton.click();
  assert.match(await connectionButton.locator("..").getAttribute("class") || "", /is-selected/, "单击连接没有更新选中态");
  await connectionButton.dblclick();

  const schemaButton = page.locator("button.schema-node", { hasText: mockDatabaseName });
  await expectVisible(schemaButton, "数据库 schema", 30_000);
  await schemaButton.dblclick();
  await expectVisible(page.locator(".schema-children"), "数据库对象分类");

  const tableCategory = page.locator(".schema-category", { has: page.getByRole("button", { name: "表", exact: true }) });
  await tableCategory.locator(".schema-category-toggle").click();
  await expectVisible(tableCategory.getByText("flow_items", { exact: true }), "数据库表对象");

  await schemaButton.click({ button: "right" });
  const navigatorMenu = page.getByRole("menu", { name: "数据库对象操作" });
  await expectVisible(navigatorMenu, "数据库右键菜单");
  await navigatorMenu.getByRole("menuitem", { name: "新建查询", exact: true }).click();
  await expectVisible(page.locator(".query-tabs > button:not(.new-query-tab)").filter({ hasText: "查询" }).first(), "右键菜单创建的查询页签");
  await expectVisible(page.locator(".monaco-editor"), "SQL 编辑器", 30_000);
  await expectNoRouteError(page, "数据库工作台流程");
}

async function verifySettings(page, baseUrl) {
  await page.goto(`${baseUrl}/settings?section=profile`, { waitUntil: "domcontentloaded" });
  await expectVisible(page.locator(".settings-view"), "设置页");
  const settingsNavigation = page.getByRole("navigation", { name: "设置分类" });
  const sections = [
    ["个人信息", "profile"],
    ["外观与语言", "appearance"],
    ["API Key", "api-keys"],
    ["MCP", "mcp"],
    ["运行策略", "runtime"],
    ["数据迁移", "migration"],
  ];
  for (const [label, key] of sections) {
    await settingsNavigation.getByRole("button", { name: label, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("section") === key);
    await expectVisible(page.locator(".settings-detail .settings-section-panel"), `设置分区 ${label}`);
  }

  await settingsNavigation.getByRole("button", { name: "外观与语言", exact: true }).click();
  const lightTheme = page.getByRole("radio", { name: "切换到浅色主题" });
  await lightTheme.click();
  assert.equal(await lightTheme.getAttribute("aria-checked"), "true", "主题切换没有更新选择状态");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light", "主题切换没有同步到根节点");

  await settingsNavigation.getByRole("button", { name: "MCP", exact: true }).click();
  const manageApiKeys = page.getByRole("button", { name: "管理 API Key", exact: true });
  await expectVisible(manageApiKeys, "MCP 到 API Key 的跨组件入口");
  await manageApiKeys.click();
  await page.waitForURL((url) => url.searchParams.get("section") === "api-keys");
  await expectVisible(page.locator(".settings-section-panel").getByText("API Key", { exact: true }).first(), "API Key 设置分区");
  await expectNoRouteError(page, "设置流程");
}

async function verifyOrganization(page, baseUrl) {
  await page.goto(`${baseUrl}/organization`, { waitUntil: "domcontentloaded" });
  await expectVisible(page.locator(".organization-view"), "组织管理页");
  await page.getByRole("button", { name: "创建组织", exact: true }).click();
  const organizationDialog = page.getByRole("dialog", { name: "创建新组织" });
  await expectVisible(organizationDialog, "创建组织对话框");
  await organizationDialog.getByPlaceholder("例如：基础架构团队").fill(organizationName);
  await organizationDialog.getByPlaceholder("这个组织负责什么？").fill("全流程测试组织");
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/organization", { timeout: 20_000 }),
    organizationDialog.getByRole("button", { name: "创建组织", exact: true }).click(),
  ]);
  await expectVisible(page.locator(".workspace-console__heading").getByText(organizationName, { exact: true }), "新组织工作台");

  await page.getByRole("button", { name: "创建根项目组" }).click();
  const projectDialog = page.getByRole("dialog", { name: "创建项目组" });
  await expectVisible(projectDialog, "创建项目组对话框");
  await projectDialog.getByPlaceholder("例如：生产运维").fill(projectName);
  await projectDialog.getByPlaceholder("说明职责范围").fill("全流程测试项目组");
  await projectDialog.getByRole("button", { name: "创建项目组", exact: true }).click();
  await expectVisible(page.locator(".structure-tree").getByText(projectName, { exact: true }), "新项目组树节点");

  await page.locator(".console-tabs").getByRole("button", { name: "邀请", exact: true }).click();
  const invitationPanel = page.locator(".invitation-directory");
  await expectVisible(invitationPanel, "邀请管理面板");
  await invitationPanel.getByRole("button", { name: "生成邀请链接", exact: true }).first().click();
  const invitationDialog = page.getByRole("dialog", { name: "生成邀请链接" });
  await expectVisible(invitationDialog, "生成邀请链接对话框");
  await invitationDialog.getByRole("button", { name: "生成链接", exact: true }).click();
  const invitationLink = invitationDialog.getByLabel("新生成的邀请链接");
  await expectVisible(invitationLink, "新邀请链接");
  assert.match(await invitationLink.inputValue(), /\/join\//, "邀请链接格式错误");
  await invitationDialog.getByRole("button", { name: "关闭", exact: true }).click();

  await page.locator(".console-tabs").getByRole("button", { name: "平台账号", exact: true }).click();
  const platformPanel = page.locator(".platform-workspace");
  await expectVisible(platformPanel, "平台账号面板");
  await expectVisible(platformPanel.getByText(adminUsername, { exact: true }), "平台管理员账号");
  await expectNoRouteError(page, "组织管理流程");
}

async function installDesktopBridge(context, baseUrl) {
  await context.addInitScript(({ endpoint, username }) => {
    const state = {
      appVersion: "0.0.0-flow",
      language: "zh-CN",
      agentEntryMode: "floating",
      recentEndpoint: endpoint,
      endpoint,
      protocolVersion: 1,
      capabilities: {
        product: "viron",
        productVersion: "0.0.0-flow",
        apiProtocol: { min: 1, max: 1 },
        clientAccess: { desktop: true, web: true },
        desktopLocal: { web: true, ssh: true, sftp: true, logs: true, database: true, redis: true, inspection: true },
        serverForwarding: { enabled: true, web: true, ssh: true, sftp: true, logs: true, database: true, redis: true },
      },
      executionMode: "local",
    };
    const unconfiguredAgent = {
      configured: false,
      endpoint: "",
      protocol: "openai",
      model: "",
      apiKeyStored: false,
      approvalMode: "always",
      executionPresentation: "conversation",
      updatedAt: null,
    };
    const conversation = {
      id: "flow-agent-session",
      title: "新对话",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      messageCount: 0,
      messages: [],
    };
    const noListener = () => () => undefined;
    const noOperation = async () => undefined;
    const mcpStatus = {
      enabled: false,
      approvalMode: "always",
      running: false,
      transport: "unix",
      address: null,
      launcherPath: "/tmp/viron-flow-mcp",
      clients: [],
      lastError: null,
    };
    const bridge = {
      getState: async () => ({ ...state }),
      setEndpoint: async (value) => {
        state.endpoint = value.replace(/\/$/, "");
        state.recentEndpoint = state.endpoint;
        return { ok: true, state: { ...state } };
      },
      clearEndpoint: async () => ({ ...state, endpoint: null }),
      setLanguage: async (language) => ({ language }),
      setTitleBarTheme: async () => ({ applied: true }),
      getExecutionActivity: async () => ({ total: 0, counts: { web: 0, ssh: 0, sftp: 0, logs: 0, database: 0, redis: 0 } }),
      setExecutionMode: async (mode) => ({ ...state, executionMode: mode }),
      setAgentEntryMode: async (mode) => {
        state.agentEntryMode = mode;
        return { ...state };
      },
      getMcpStatus: async () => ({ ...mcpStatus }),
      setLocalMcpEnabled: async (enabled) => ({ ...mcpStatus, enabled, running: enabled }),
      setLocalMcpApprovalMode: async (approvalMode) => ({ ...mcpStatus, approvalMode }),
      getShortcutPreferences: async () => ({ overrides: {}, bindings: {} }),
      setShortcutPreferences: async (overrides) => ({ overrides, bindings: {} }),
      setShortcutCapture: async (active) => ({ active }),
      getAgentSettings: async () => ({ ...unconfiguredAgent }),
      saveAgentSettings: async (input) => ({ ...unconfiguredAgent, ...input, configured: true, apiKeyStored: Boolean(input.apiKey), updatedAt: new Date().toISOString() }),
      deleteAgentSettings: async () => ({ ...unconfiguredAgent }),
      listAgentModels: async () => ({ models: [] }),
      testAgentSettings: async () => ({ ok: true, model: "flow", latencyMs: 1, text: "ok" }),
      getCurrentAgentSession: async () => ({ ...conversation }),
      listAgentSessions: async () => ({ currentSessionId: conversation.id, items: [{ ...conversation }] }),
      createAgentSession: async () => ({ ...conversation }),
      selectAgentSession: async () => ({ ...conversation }),
      renameAgentSession: async ({ title }) => ({ ...conversation, title }),
      deleteAgentSession: async () => ({ ...conversation }),
      updateAgentLauncher: noOperation,
      updateAgentHost: noOperation,
      respondAgentHost: noOperation,
      setAgentChatNativeOverlay: noOperation,
      updateAgentChatChrome: noOperation,
      setAgentChatIgnoreMouse: noOperation,
      focusAgentChat: noOperation,
      notifyAgentChatPointerOutside: noOperation,
      updateConnectionQuality: noOperation,
      updateActiveEnvironmentDock: noOperation,
      updateActiveEnvironmentDockLayout: noOperation,
      updateImmersiveNavigation: noOperation,
      onStateChanged: noListener,
      onShortcut: noListener,
      onShortcutCaptureInput: noListener,
      onAgentEvent: noListener,
      onAgentHostState: noListener,
      onAgentHostRequest: noListener,
      onAgentChatPointerOutside: noListener,
      onConnectionQualityAction: noListener,
      onActiveEnvironmentDockAction: noListener,
      onNativeViewPointerDown: noListener,
      onImmersiveNavigationAction: noListener,
      onMonitorAlertOpen: noListener,
      onWebViewState: noListener,
      onSshSessionEvent: noListener,
      onLogStreamEvent: noListener,
      onServiceSocketEvent: noListener,
      onAgentLauncherAction: (listener) => {
        window.__vironFlowAgentLauncherAction = listener;
        return () => { delete window.__vironFlowAgentLauncherAction; };
      },
      request: async (input) => {
        const headers = new Headers(input.headers || []);
        let body;
        if (input.body?.kind === "text") body = input.body.value;
        else if (input.body?.kind === "form") {
          const form = new FormData();
          for (const entry of input.body.entries || []) form.append(entry.name, entry.value || "");
          body = form;
        }
        const response = await fetch(input.path, {
          method: input.method || "GET",
          headers,
          body,
          credentials: "include",
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          body: await response.text(),
        };
      },
    };
    window.vironDesktop = new Proxy(bridge, {
      get(target, key) {
        if (key in target) return target[key];
        if (String(key).startsWith("on")) return noListener;
        return async () => ({});
      },
    });
    window.__vironFlowDesktopUser = username;
  }, { endpoint: baseUrl, username: adminUsername });
}

async function verifyDesktopAgent(browser, baseUrl, failures) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await installDesktopBridge(context, baseUrl);
  const page = await context.newPage();
  observePage(page, failures);
  try {
    await loginThroughUi(page, baseUrl, { desktop: true });
    await page.waitForFunction(() => typeof window.__vironFlowAgentLauncherAction === "function");
    await page.evaluate(() => window.__vironFlowAgentLauncherAction({ type: "toggle" }));
    const agentWindow = page.getByRole("region", { name: "小 V" });
    await expectVisible(agentWindow, "Viron Agent 悬浮窗口");
    await expectVisible(agentWindow.getByText("需要先配置模型", { exact: true }), "Agent 未配置状态");

    await agentWindow.getByRole("button", { name: "历史会话" }).click();
    await expectVisible(agentWindow.locator(".agent-session-history").getByText("新对话", { exact: true }), "Agent 会话列表");
    await agentWindow.getByRole("button", { name: "配置 Viron Agent" }).click();
    await page.waitForURL((url) => url.hash === "#/settings?section=ai-agent");
    await expectVisible(page.locator(".settings-section-panel--agent").getByRole("heading", { name: "Viron Agent" }), "Agent 设置分区");
    await expectNoRouteError(page, "桌面 Agent 流程");
  } catch (error) {
    const screenshotPath = resolve(artifactDirectory, `desktop-failure-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    process.stderr.write(`桌面 Agent 全流程失败截图：${screenshotPath}\n`);
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  assert(existsSync(resolve(repositoryRoot, "dist/server/index.js")), "缺少服务端构建产物；请先执行 npm run build");
  assert(existsSync(resolve(repositoryRoot, "dist/client/index.html")), "缺少 Web 构建产物；请先执行 npm run build");
  await mkdir(artifactDirectory, { recursive: true });
  const dataDirectory = await mkdtemp(join(tmpdir(), "viron-user-flow-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("ENVMAN_")) delete environment[name];
  }
  Object.assign(environment, {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDirectory,
    DATABASE_DRIVER: "sqlite",
    VIRON_MASTER_KEY: Buffer.alloc(32, 41).toString("base64"),
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD: adminPassword,
    ALLOW_WEAK_PASSWORDS: "true",
    COOKIE_SECURE: "false",
    WEB_CLIENT_ENABLED: "true",
    VIRON_MCP_ENABLED: "true",
  });

  let serverOutput = "";
  let server;
  let browser;
  let activePage;
  let sshFixture;
  const failures = [];
  try {
    sshFixture = await startFlowSshServer();
    server = spawn(process.execPath, ["scripts/start.mjs"], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
      });
    }
    await waitForServer(baseUrl, server, () => serverOutput);
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    activePage = page;
    observePage(page, failures);
    await loginThroughUi(page, baseUrl);
    const maintenance = await verifyEnvironmentAndMaintenance(page, { baseUrl, sshFixture });
    assert(maintenance.environmentId, "环境流程未返回环境 ID");
    await verifyCredentialsAndMonitoring(page, { ...maintenance, dataDirectory, baseUrl, sshFixture });
    await verifyDatabaseWorkbench(page, baseUrl);
    await verifySettings(page, baseUrl);
    await verifyOrganization(page, baseUrl);
    await context.close();
    activePage = undefined;

    await verifyDesktopAgent(browser, baseUrl, failures);
    assert.deepEqual(failures, [], `全流程测试捕获到运行时错误：\n${failures.join("\n")}`);
    process.stdout.write("VIRON_USER_FLOW login environment maintenance credentials monitoring database settings organization desktop-agent: complete\n");
  } catch (error) {
    if (activePage && !activePage.isClosed()) {
      const screenshotPath = resolve(artifactDirectory, `failure-${Date.now()}.png`);
      await activePage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      process.stderr.write(`全流程失败截图：${screenshotPath}\n`);
    }
    if (serverOutput.trim()) process.stderr.write(`测试服务日志：\n${serverOutput}\n`);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProcess(server);
    await sshFixture?.close().catch(() => undefined);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

await main();
