import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ statements: [] as string[] }));

vi.mock("../src/server/database-workbench/connector.js", () => ({
  connectDatabase: vi.fn(async () => ({
    record: { engine: "mysql" },
    connection: {
      async query(sql: string, values?: unknown) {
        database.statements.push(`${sql.replace(/\s+/g, " ").trim()} :: ${JSON.stringify(values ?? null)}`);
        if (/SELECT \* FROM `billing`\.`orders` LIMIT \?/i.test(sql)) {
          return [[{ id: 1, customer: "Alice" }, { id: 2, customer: "Bob" }], [{ name: "id" }, { name: "customer" }]];
        }
        if (/SHOW CREATE TABLE/i.test(sql)) return [[{ "Create Table": "CREATE TABLE `orders` (`id` int, `customer` varchar(80))" }], []];
        if (/SELECT COLUMN_NAME AS name FROM information_schema\.COLUMNS/i.test(sql)) return [[{ name: "id" }, { name: "customer" }], []];
        if (/SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType/i.test(sql)) {
          return [[
            { name: "id", dataType: "int", nullable: "NO", extra: "auto_increment" },
            { name: "customer", dataType: "varchar", nullable: "NO", extra: "" },
          ], []];
        }
        return [{ affectedRows: 1, insertId: 0, info: "" }, []];
      },
      async beginTransaction() { database.statements.push("BEGIN"); },
      async commit() { database.statements.push("COMMIT"); },
      async rollback() { database.statements.push("ROLLBACK"); },
      escape(value: unknown) { return typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; },
      async end() {},
      destroy() {},
    },
    async close() {},
  })),
}));

import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  database.statements.length = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 23),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function waitForAutomation(app: Awaited<ReturnType<typeof buildApp>>, id: string, cookies: Record<string, string>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/v1/database-automations", cookies });
    const item = response.json().items.find((candidate: { id: string }) => candidate.id === id);
    if (item && item.status !== "running") return item;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for automation");
}

describe("database automation work execution", () => {
  it("executes export, CSV import, and data generation and exposes the export output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-automation-work-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const connection = await app.inject({ method: "POST", url: "/api/v1/database-connections", cookies, payload: { name: "Primary", engine: "mysql", host: "127.0.0.1", port: 3306, username: "root" } });
    const connectionId = connection.json().id as string;
    const csv = Buffer.from("id,customer\n3,Carol\n4,David\n", "utf8").toString("base64");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/database-automations",
      cookies,
      payload: {
        connectionId,
        database: "billing",
        name: "Nightly data",
        works: [
          { id: "export-orders", type: "export", name: "Export orders", config: { database: "billing", table: "orders", format: "csv" } },
          { id: "import-orders", type: "import", name: "Import orders", config: { database: "billing", table: "orders", filename: "orders.csv", contentBase64: csv, mode: "append" } },
          { id: "generate-orders", type: "dataGeneration", name: "Generate orders", config: { database: "billing", table: "orders", rowCount: 3, seed: 7 } },
        ],
        advanced: {},
        scheduleCron: "",
        scheduleEnabled: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().item.id as string;
    expect((await app.inject({ method: "POST", url: `/api/v1/database-automations/${id}/run`, cookies })).statusCode).toBe(202);
    const completed = await waitForAutomation(app, id, cookies);
    expect(completed).toMatchObject({ status: "success" });
    expect(completed.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("输出：billing.orders.csv"),
      expect.stringContaining("导入：2 行"),
      expect.stringContaining("生成：3 行"),
    ]));
    expect(completed.advanced.outputs["export-orders"]).toMatchObject({ filename: "billing.orders.csv", contentType: "text/csv; charset=utf-8" });

    const output = await app.inject({ method: "GET", url: `/api/v1/database-automations/${id}/outputs/export-orders`, cookies });
    expect(output.statusCode).toBe(200);
    expect(output.body).toContain("Alice");
    expect(database.statements.filter((statement) => statement.startsWith("BEGIN"))).toHaveLength(2);
    expect(database.statements.filter((statement) => statement.startsWith("COMMIT"))).toHaveLength(2);
    expect(database.statements.some((statement) => statement.includes("INSERT INTO `billing`.`orders` (`id`,`customer`) VALUES ?"))).toBe(true);
    expect(database.statements.some((statement) => statement.includes("INSERT INTO `billing`.`orders` (`customer`) VALUES ?"))).toBe(true);
    await app.close();
  });
});
