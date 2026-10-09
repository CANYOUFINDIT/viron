import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { requireAdmin } from "../src/server/routes/auth.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
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
  return { app, cookies, config };
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
});
