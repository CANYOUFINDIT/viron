import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const enabled = process.env.VIRON_DESKTOP_WEB_TEST === "1";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electronPath = createRequire(import.meta.url)("electron") as string;
const privateDir = join(root, "private", "web-plugin-phase6");
const servers: Server[] = [];
const applications: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  })));
});

it.skipIf(!enabled)("loads extensions only for the real authorized entry and stops that session on revoke", async () => {
  rmSync(privateDir, { recursive: true, force: true });
  mkdirSync(privateDir, { recursive: true });
  const page = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>${request.url}</title><main>${request.url}</main>`);
  });
  servers.push(page);
  const port = await new Promise<number>((resolvePort, reject) => {
    page.once("error", reject);
    page.listen(0, "127.0.0.1", () => {
      const address = page.address();
      if (!address || typeof address === "string") reject(new Error("页面服务器未监听"));
      else resolvePort(address.port);
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const config: AppConfig = {
    nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: privateDir,
    databasePath: join(privateDir, "db.sqlite"), masterKey: Buffer.alloc(32, 7),
    adminUsername: "admin", adminPassword: "test-password-123", allowWeakPasswords: true,
    sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30,
  };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  applications.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const listening = app.server.address();
  if (!listening || typeof listening === "string") throw new Error("策略服务未监听");
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies[0].value };
  const member = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "plugin-member", password: "member" } });
  const userId = member.json().user.id as string;
  const memberCookies = { envman_session: member.cookies[0].value };
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "插件环境" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, now, now);
  for (const session of [cookies, memberCookies])
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: session, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  const base = `/api/v1/organizations/${org}`;
  const environment = async (name: string) => {
    const response = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name, owner: "member" } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  };
  const devEnv = await environment("开发");
  const prodEnv = await environment("生产");
  const stageEnv = await environment("预发");
  const devEntry = randomUUID();
  const prodEntry = randomUUID();
  const stageEntry = randomUUID();
  const devCredential = randomUUID();
  const prodCredential = randomUUID();
  const stageCredential = randomUUID();
  const loginConfig = JSON.stringify({ mode: "direct" });
  const insert = db.prepare("INSERT INTO web_entries (id, environment_id, name, url, description, tags_json, login_config_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, '', '[]', ?, 0, ?, ?)");
  await insert.run(devEntry, devEnv, "开发台", `${origin}/dev`, loginConfig, now, now);
  await insert.run(prodEntry, prodEnv, "生产台", `${origin}/prod`, loginConfig, now, now);
  await insert.run(stageEntry, stageEnv, "预发台", `${origin}/stage`, loginConfig, now, now);
  const password = app.secrets.encrypt("fixture-password");
  const insertCredential = db.prepare("INSERT INTO web_credentials (id, web_entry_id, username, password_ciphertext, note, custom_fields_json, sort_order, created_at, updated_at) VALUES (?, ?, 'ops', ?, '', '{}', 0, ?, ?)");
  await insertCredential.run(devCredential, devEntry, password, now, now);
  await insertCredential.run(prodCredential, prodEntry, password, now, now);
  await insertCredential.run(stageCredential, stageEntry, password, now, now);
  const role = await app.inject({ method: "POST", url: `${base}/roles`, cookies, payload: { name: "网页", permissionCodes: ["web.view", "web.use", "environment.view"], reason: "插件验收" } });
  expect(role.statusCode, role.body).toBe(201);
  expect((await app.inject({ method: "POST", url: `${base}/role-assignments`, cookies, payload: { roleId: role.json().id, subjectType: "user", subjectId: userId, reason: "分配" } })).statusCode).toBe(201);
  expect((await app.inject({ method: "POST", url: `${base}/role-data-grants`, cookies, payload: { roleId: role.json().id, targets: [{ type: "web_entry", id: devEntry }, { type: "web_entry", id: prodEntry }, { type: "web_entry", id: stageEntry }, { type: "environment", id: devEnv }, { type: "environment", id: prodEnv }, { type: "environment", id: stageEnv }], reason: "入口" } })).statusCode).toBe(201);
  const features: Record<string, string> = {};
  for (const environmentId of [devEnv, stageEnv]) {
    const feature = await app.inject({ method: "POST", url: `${base}/feature-grants`, cookies, payload: { subjectType: "user", subjectId: userId, targets: [{ type: "environment", id: environmentId }], features: { mcp: false, agent: false, webPlugins: true }, reason: "插件" } });
    expect(feature.statusCode, feature.body).toBe(201);
    features[environmentId] = feature.json().id as string;
  }
  const child = spawn(electronPath, ["--smoke-test", "tests/fixtures/web-plugin-environment-smoke.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VIRON_PLUGIN_PROFILE: join(privateDir, "electron-profile"),
      VIRON_PLUGIN_ORIGIN: origin,
      VIRON_PLUGIN_POLICY_BASE: `http://127.0.0.1:${listening.port}`,
      VIRON_PLUGIN_COOKIE: `envman_session=${memberCookies.envman_session}`,
      VIRON_PLUGIN_ADMIN_COOKIE: `envman_session=${cookies.envman_session}`,
      VIRON_PLUGIN_USER_ID: userId,
      VIRON_PLUGIN_ORG_BASE: base,
      VIRON_PLUGIN_DEV_FEATURE: features[devEnv],
      VIRON_PLUGIN_STAGE_FEATURE: features[stageEnv],
      VIRON_PLUGIN_DEV: JSON.stringify({ environmentId: devEnv, entryId: devEntry, credentialId: devCredential, url: `${origin}/dev` }),
      VIRON_PLUGIN_PROD: JSON.stringify({ environmentId: prodEnv, entryId: prodEntry, credentialId: prodCredential, url: `${origin}/prod` }),
      VIRON_PLUGIN_STAGE: JSON.stringify({ environmentId: stageEnv, entryId: stageEntry, credentialId: stageCredential, url: `${origin}/stage` }),
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const result = await new Promise<{ code: number | null }>((resolveProcess, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(output || "插件环境测试超时")); }, 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolveProcess({ code }); });
  });
  expect(result.code, output).toBe(0);
  expect(output).toContain("WEB_PLUGIN_ENVIRONMENT_PASS");
}, 70_000);
