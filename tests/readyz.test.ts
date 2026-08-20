import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { PRODUCT_VERSION } from "../src/server/product-info.js";

const directories: string[] = [];
// root 无视权限位，chmod 造不出不可读写的库文件，只能跳过这条，避免 CI 里假绿。
const permissionIt = process.getuid?.() === 0 ? it.skip : it;

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
    masterKey: Buffer.alloc(32, 7),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("Viron readiness probe", () => {
  it("turns red while the metadata database is gone and green again once it comes back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-readyz-recovery-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const movedPath = `${config.databasePath}.moved`;

    const healthy = await app.inject({ method: "GET", url: "/readyz" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({ status: "ok", database: "sqlite" });

    renameSync(config.databasePath, movedPath);
    const unavailable = await app.inject({ method: "GET", url: "/readyz" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE" });

    renameSync(movedPath, config.databasePath);
    const recovered = await app.inject({ method: "GET", url: "/readyz" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ status: "ok", database: "sqlite" });

    renameSync(config.databasePath, movedPath);
    const unavailableAgain = await app.inject({ method: "GET", url: "/readyz" });
    expect(unavailableAgain.statusCode).toBe(503);
    expect(unavailableAgain.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE" });

    renameSync(movedPath, config.databasePath);
    await app.close();
  });

  permissionIt("turns red while the metadata database file is neither readable nor writable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-readyz-permission-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    chmodSync(config.databasePath, 0o000);
    const unavailable = await app.inject({ method: "GET", url: "/readyz" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE" });

    chmodSync(config.databasePath, 0o600);
    const recovered = await app.inject({ method: "GET", url: "/readyz" });
    expect(recovered.statusCode).toBe(200);

    await app.close();
  });

  it("stays red for a metadata database that constant queries still report as usable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-readyz-constant-query-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    renameSync(config.databasePath, `${config.databasePath}.moved`);
    // 进程仍持有库文件的 fd，所以常量查询照样成功——这正是 `SELECT 1` 当不了就绪检查的原因。
    await expect(db.prepare("SELECT 1 AS one").get()).resolves.toMatchObject({ one: 1 });
    const unavailable = await app.inject({ method: "GET", url: "/readyz" });
    expect(unavailable.statusCode).toBe(503);

    renameSync(`${config.databasePath}.moved`, config.databasePath);
    await app.close();
  });

  it("stays red for a closed connection that the library file check alone would miss", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-readyz-closed-connection-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);

    await expect(db.ping()).resolves.toBeUndefined();
    await db.close();
    // 库文件仍在原处，路径检查发现不了连接已关闭，只有真实读能兜住。
    expect(existsSync(config.databasePath)).toBe(true);
    await expect(db.ping()).rejects.toThrow();
  });

  it("keeps the liveness probe green and unchanged while the metadata database is unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-readyz-liveness-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    renameSync(config.databasePath, `${config.databasePath}.moved`);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      version: PRODUCT_VERSION,
      product: "viron",
      productVersion: PRODUCT_VERSION,
    });
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);

    renameSync(`${config.databasePath}.moved`, config.databasePath);
    await app.close();
  });

  it("localizes the unavailable message for English clients", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-readyz-i18n-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    renameSync(config.databasePath, `${config.databasePath}.moved`);
    const english = await app.inject({ method: "GET", url: "/readyz", headers: { "accept-language": "en" } });
    expect(english.statusCode).toBe(503);
    expect(english.json()).toEqual({
      error: "DATABASE_UNAVAILABLE",
      message: "Metadata database unavailable",
    });
    const chinese = await app.inject({ method: "GET", url: "/readyz", headers: { "accept-language": "zh-CN" } });
    expect(chinese.statusCode).toBe(503);
    expect(chinese.json()).toEqual({
      error: "DATABASE_UNAVAILABLE",
      message: "元数据库不可用",
    });

    renameSync(`${config.databasePath}.moved`, config.databasePath);
    await app.close();
  });
});
