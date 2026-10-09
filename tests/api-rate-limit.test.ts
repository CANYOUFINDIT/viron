import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, loadSavedSettings, openDatabase } from "../src/server/database.js";
import { requireAdmin } from "../src/server/routes/auth.js";
import { defaultApiRateLimitSettings, type ApiRateLimitSettings } from "../src/shared/api-rate-limit-settings.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "viron-rate-limit-test-"));
  directories.push(directory);
  const config: AppConfig = {
    nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory,
    databasePath: join(directory, "fixture.db"), masterKey: Buffer.alloc(32, 7),
    adminUsername: "fixture-admin", adminPassword: "fixture-password-123",
    sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30,
  };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  apps.push(app);
  app.get("/api/v1/fixture/read", { preHandler: requireAdmin }, async () => ({ ok: true }));
  app.get("/api/v1/fixture/strict", { preHandler: requireAdmin, config: { rateLimit: { max: 2, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
  expect(login.statusCode).toBe(200);
  const cookies = { envman_session: login.cookies.find((cookie) => cookie.name === "envman_session")!.value };
  return { app, cookies, config, db };
}

function savePolicy(app: FastifyInstance, cookies: { envman_session: string }, policy: Partial<ApiRateLimitSettings>) {
  return app.inject({
    method: "PUT", url: "/api/v1/settings", cookies,
    payload: { auditRetentionDays: 30, apiRateLimit: { ...defaultApiRateLimitSettings(), ...policy } },
  });
}

describe("API rate-limit budgets", () => {
  it("isolates users behind the same IP and keeps authentication available after a business limit", async () => {
    const { app, cookies, config } = await fixture();
    for (let index = 0; index < 1200; index++) {
      const response = await app.inject({ url: "/api/v1/fixture/read", cookies });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ url: "/api/v1/fixture/read", cookies, headers: { "accept-language": "en" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "API_RATE_LIMIT", retryAfter: expect.any(Number) });
    expect(limited.json().message).toContain("Too many requests");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    const me = await app.inject({ url: "/api/v1/auth/me", cookies });
    expect(me.statusCode).toBe(200);
    expect(me.headers["x-ratelimit-limit"]).toBe("120");

    const anotherLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
    expect(anotherLogin.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies: { envman_session: anotherLogin.cookies[0].value } })).statusCode).toBe(429);

    const registration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "fixture-other", password: "fixture-password-456" } });
    expect(registration.statusCode).toBe(201);
    const otherCookies = { envman_session: registration.cookies[0].value };
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies: otherCookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies })).statusCode).toBe(204);
  });

  it("does not elevate anonymous budgets for unverified cookies and keeps login separate", async () => {
    const { app, config } = await fixture();
    for (let index = 0; index < 300; index++) {
      expect((await app.inject({ url: "/api/v1/capabilities", cookies: { envman_session: `invalid-${index}` } })).statusCode).toBe(200);
    }
    const limited = await app.inject({ url: "/api/v1/capabilities", cookies: { envman_session: "another-invalid-cookie" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe("300");
    expect(limited.json().message).toContain("请求过于频繁");
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } })).statusCode).toBe(200);
  });

  it("preserves stricter route limits and isolates them by verified user", async () => {
    const { app, cookies } = await fixture();
    expect((await app.inject({ url: "/api/v1/fixture/strict", cookies })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/strict", cookies })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/strict", cookies })).statusCode).toBe(429);
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).statusCode).toBe(200);
    const registration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "fixture-other", password: "fixture-password-456" } });
    expect((await app.inject({ url: "/api/v1/fixture/strict", cookies: { envman_session: registration.cookies[0].value } })).statusCode).toBe(200);
  });

  it("still limits login attempts independently of business traffic", async () => {
    const { app } = await fixture();
    for (let index = 1; index < 20; index++) {
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "nonexistent-fixture", password: "incorrect" } })).statusCode).toBe(401);
    }
    const limited = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "nonexistent-fixture", password: "incorrect" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe("20");
  });

  it("applies changed budgets immediately to the current counting window", async () => {
    const { app, cookies } = await fixture();
    expect((await savePolicy(app, cookies, { userRequestsPerMinute: 2, sessionRequestsPerMinute: 2, anonymousRequestsPerMinute: 2, loginAttemptsPerMinute: 2 })).statusCode).toBe(200);
    for (let index = 0; index < 2; index++) {
      expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).statusCode).toBe(200);
      expect((await app.inject({ url: "/api/v1/auth/me", cookies })).statusCode).toBe(200);
      expect((await app.inject("/api/v1/capabilities")).statusCode).toBe(200);
    }
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).statusCode).toBe(429);
    expect((await app.inject({ url: "/api/v1/auth/me", cookies })).statusCode).toBe(429);
    expect((await app.inject("/api/v1/capabilities")).statusCode).toBe(429);
    const failedLogin = { method: "POST" as const, url: "/api/v1/auth/login", payload: { username: "missing-fixture", password: "incorrect" } };
    expect((await app.inject(failedLogin)).statusCode).toBe(401);
    expect((await app.inject(failedLogin)).statusCode).toBe(429);

    expect((await savePolicy(app, cookies, { userRequestsPerMinute: 4, sessionRequestsPerMinute: 4, anonymousRequestsPerMinute: 4, loginAttemptsPerMinute: 4 })).statusCode).toBe(200);
    const business = await app.inject({ url: "/api/v1/fixture/read", cookies });
    expect(business.statusCode).toBe(200);
    expect(business.headers["x-ratelimit-limit"]).toBe("4");
    expect((await app.inject({ url: "/api/v1/auth/me", cookies })).statusCode).toBe(200);
    expect((await app.inject("/api/v1/capabilities")).statusCode).toBe(200);
    expect((await app.inject(failedLogin)).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).statusCode).toBe(429);
  });

  it("keeps management accessible when the IP budget is exhausted", async () => {
    const { app, cookies } = await fixture();
    expect((await savePolicy(app, cookies, { ipRequestsPerMinute: 1 })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).statusCode).toBe(429);
    const settings = await app.inject({ url: "/api/v1/settings?refresh=1", cookies });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().item.apiRateLimit.ipRequestsPerMinute).toBe(1);
    expect((await savePolicy(app, cookies, { ipRequestsPerMinute: 100 })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).statusCode).toBe(200);
  });

  it("can disable general limits while preserving dedicated sensitive-operation limits", async () => {
    const { app, cookies } = await fixture();
    expect((await savePolicy(app, cookies, { enabled: false, userRequestsPerMinute: 1, anonymousRequestsPerMinute: 1, sessionRequestsPerMinute: 1, loginAttemptsPerMinute: 1, ipRequestsPerMinute: 1 })).statusCode).toBe(200);
    for (let index = 0; index < 4; index++) {
      expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).statusCode).toBe(200);
      expect((await app.inject({ url: "/api/v1/auth/me", cookies })).statusCode).toBe(200);
      expect((await app.inject("/api/v1/capabilities")).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "missing-fixture", password: "incorrect" } })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: "/api/v1/fixture/strict", cookies })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/strict", cookies })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/strict", cookies })).statusCode).toBe(429);
    expect((await savePolicy(app, cookies, {})).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/fixture/read", cookies })).headers["x-ratelimit-limit"]).toBe("1200");
  });

  it("rejects non-admin changes and invalid budgets without changing the live policy", async () => {
    const { app, cookies, config } = await fixture();
    const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "fixture-member", password: "fixture-password-456" } });
    const memberCookies = { envman_session: registered.cookies[0].value };
    expect((await savePolicy(app, memberCookies, { userRequestsPerMinute: 1 })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/v1/settings", payload: { auditRetentionDays: 30, apiRateLimit: defaultApiRateLimitSettings() } })).statusCode).toBe(401);
    for (const invalid of [
      { userRequestsPerMinute: 0 }, { sessionRequestsPerMinute: 1.5 }, { ipRequestsPerMinute: 1_000_001 },
      { enabled: "false" }, { loginAttemptsPerMinute: "20" }, { unknownBudget: 100 },
    ]) {
      const result = await app.inject({ method: "PUT", url: "/api/v1/settings", cookies, payload: { auditRetentionDays: 30, apiRateLimit: { ...defaultApiRateLimitSettings(), ...invalid } } });
      expect(result.statusCode).toBe(400);
    }
    expect(config.apiRateLimit).toEqual(defaultApiRateLimitSettings());
  });

  it("persists policy across restart and audits both the old and new values", async () => {
    const { app, cookies, config, db } = await fixture();
    const policy = { ...defaultApiRateLimitSettings(), userRequestsPerMinute: 4321, loginAttemptsPerMinute: 45 };
    expect((await savePolicy(app, cookies, policy)).statusCode).toBe(200);
    const audit = await db.prepare("SELECT details_json FROM audit_events WHERE action = 'settings.updated' ORDER BY created_at DESC LIMIT 1").get() as { details_json: string };
    expect(JSON.parse(audit.details_json)).toMatchObject({ apiRateLimit: policy, previousApiRateLimit: defaultApiRateLimitSettings() });
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restartedConfig = { ...config, apiRateLimit: undefined };
    const restartedDb = await openDatabase(restartedConfig);
    const restartedApp = await buildApp({ config: restartedConfig, db: restartedDb, logger: false });
    apps.push(restartedApp);
    const settings = await restartedApp.inject({ url: "/api/v1/settings", cookies });
    expect(settings.json().item.apiRateLimit).toEqual(policy);
    expect((await restartedApp.inject({ url: "/api/v1/active-connections", cookies })).headers["x-ratelimit-limit"]).toBe("4321");
    expect((await restartedApp.inject({ method: "PUT", url: "/api/v1/settings", cookies, payload: { auditRetentionDays: 45 } })).statusCode).toBe(200);
    expect(restartedConfig.apiRateLimit).toEqual(policy);
  });

  it("rolls back persistence failures before changing any live setting", async () => {
    const { app, cookies, config, db } = await fixture();
    await savePolicy(app, cookies, {});
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (!sql.startsWith("INSERT INTO settings")) return statement;
      return { ...statement, run: async (...params: unknown[]) => {
        if (params[0] === "apiRateLimit") throw new Error("fixture persistence failure");
        return statement.run(...params);
      } };
    });
    const failed = await app.inject({ method: "PUT", url: "/api/v1/settings", cookies, payload: { auditRetentionDays: 90, apiRateLimit: { ...defaultApiRateLimitSettings(), enabled: false } } });
    expect(failed.statusCode).toBe(500);
    expect(config.auditRetentionDays).toBe(30);
    expect(config.apiRateLimit).toEqual(defaultApiRateLimitSettings());
    const saved = await db.prepare("SELECT value_json FROM settings WHERE `key` = 'auditRetentionDays'").get() as { value_json: string };
    expect(JSON.parse(saved.value_json)).toBe(30);
  });

  it("ignores malformed saved policies instead of failing startup", async () => {
    const { db, config } = await fixture();
    await db.prepare("INSERT INTO settings (`key`, value_json, updated_at) VALUES (?, ?, ?)").run("apiRateLimit", "{invalid", new Date().toISOString());
    const reloaded = { ...config, apiRateLimit: undefined };
    await expect(loadSavedSettings(db, reloaded)).resolves.toBeUndefined();
    expect(reloaded.apiRateLimit).toBeUndefined();
  });
});
