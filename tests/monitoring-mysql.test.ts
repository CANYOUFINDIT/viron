import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import type { EnvmanDatabase } from "../src/server/database.js";
import { monitoringTestConfig, runMonitoringContractSuite } from "./helpers/monitoring-harness.js";

const enabled = process.env.VIRON_MONITOR_MYSQL_TEST === "1";
const mysqlIt = enabled ? it : it.skip;
const directory = mkdtempSync(join(tmpdir(), "viron-monitor-mysql-"));
const containerName = `viron-monitor-mysql-${process.pid}`;
const externalHost = process.env.VIRON_MONITOR_MYSQL_HOST;
const port = Number(process.env.VIRON_MONITOR_MYSQL_PORT ?? 13318);
let dockerStarted = false;
let db: EnvmanDatabase | undefined;

async function waitForMysql(timeoutMs = 60000): Promise<void> {
  const mysql = await import("mysql2/promise");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const connection = await mysql.createConnection({
        host: externalHost || "127.0.0.1",
        port,
        user: "root",
        password: "test",
        database: "viron_monitor",
      });
      await connection.query("SELECT 1");
      await connection.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("MariaDB container did not become ready");
}

beforeAll(async () => {
  if (!enabled) return;
  if (!externalHost) {
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // container may not exist
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", [
        "run", "-d", "--name", containerName,
        "-e", "MYSQL_ROOT_PASSWORD=test",
        "-e", "MYSQL_DATABASE=viron_monitor",
        "-p", `${port}:3306`,
        "mariadb:11.4",
      ], { stdio: "inherit" });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker run exited ${code}`)));
      child.on("error", reject);
    });
    dockerStarted = true;
  }
  await waitForMysql();
  const config = monitoringTestConfig(directory, { host: externalHost || "127.0.0.1", port, database: "viron_monitor" });
  db = await openDatabase(config);
  await ensureAdmin(db, config);
}, 120_000);

afterAll(async () => {
  await db?.close();
  if (dockerStarted) {
    try { execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch { /* ignore */ }
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("monitoring MariaDB equivalence", () => {
  mysqlIt("matches SQLite contract for overview, buckets, first/last/gap, and truncated", async () => {
    expect(db).toBeDefined();
    const config = monitoringTestConfig(directory, { host: externalHost || "127.0.0.1", port, database: "viron_monitor" });
    const result = await runMonitoringContractSuite(config, db!);
    expect(result.dialect).toBe("mysql");
    expect(result.summary.hostTotal).toBeGreaterThanOrEqual(200);
    expect(result.summary.hostStale).toBeGreaterThanOrEqual(1);
    expect(result.truncated).toBe(true);
    expect(result.firstPoint).toBeTruthy();
    expect(result.lastPoint).toBeTruthy();
  });
});
