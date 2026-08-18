import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const enabled = process.env.VIRON_MYSQL_TEST === "1";
const integrationIt = enabled ? it : it.skip;
const directory = mkdtempSync(join(tmpdir(), "envman-mysql-it-"));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function config(): AppConfig {
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

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for integration task");
}

function multipart(boundary: string, fields: Record<string, string>, filename: string, content: Buffer | string): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe("MariaDB workbench integration", () => {
  integrationIt("queries, edits, imports, exports, backs up, restores, and transfers real data", async () => {
    const appConfig = config();
    const db = await openDatabase(appConfig);
    await ensureAdmin(db, appConfig);
    const app = await buildApp({ config: appConfig, db, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const createConnection = async (name: string) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/database-connections",
          cookies,
          payload: { name, engine: "mariadb", host: "127.0.0.1", port: 13306, username: "root", credential: { password: "envman-integration-test" } },
        });
        expect(response.statusCode).toBe(201);
        return response.json().id as string;
      };
      const sourceId = await createConnection("Integration Source");
      const targetId = await createConnection("Integration Target");

      const tested = await app.inject({ method: "POST", url: `/api/v1/database-connections/${sourceId}/test`, cookies });
      expect(tested.statusCode).toBe(200);
      expect(tested.json().version).toContain("MariaDB");

      const startQuery = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/queries`,
        cookies,
        payload: { database: "envman_test", sql: "DROP VIEW IF EXISTS item_totals; DROP PROCEDURE IF EXISTS item_count; DROP FUNCTION IF EXISTS item_double; DROP TRIGGER IF EXISTS items_amount_guard; DROP EVENT IF EXISTS item_maintenance; DROP TABLE IF EXISTS items; CREATE TABLE items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80) NOT NULL, amount INT NOT NULL); INSERT INTO items(name, amount) VALUES ('alpha', 10), ('beta', 20); CREATE VIEW item_totals AS SELECT COUNT(*) AS total FROM items; CREATE PROCEDURE item_count() SELECT COUNT(*) AS total FROM items; CREATE FUNCTION item_double(v INT) RETURNS INT DETERMINISTIC RETURN v * 2; CREATE TRIGGER items_amount_guard BEFORE INSERT ON items FOR EACH ROW SET NEW.amount = GREATEST(NEW.amount, 0); CREATE EVENT item_maintenance ON SCHEDULE EVERY 1 DAY DO UPDATE items SET amount = amount; SELECT * FROM items ORDER BY id;" },
      });
      expect(startQuery.statusCode).toBe(202);
      const jobId = startQuery.json().job.id as string;
      const queryJob = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-queries/${jobId}`, cookies })).json().job,
        (job: { status: string }) => !["pending", "running"].includes(job.status),
      );
      expect(queryJob.status, queryJob.error).toBe("success");
      expect(queryJob.resultSets.at(-1).rows).toHaveLength(2);

      const tableData = await app.inject({ method: "GET", url: `/api/v1/database-connections/${sourceId}/table-data?database=envman_test&table=items`, cookies });
      expect(tableData.statusCode).toBe(200);
      expect(tableData.json().primaryKey).toEqual(["id"]);

      const suggestions = await app.inject({
        method: "GET",
        url: `/api/v1/database-connections/${sourceId}/table-data/suggestions?database=envman_test&table=items&column=name&q=a`,
        cookies,
      });
      expect(suggestions.statusCode).toBe(200);
      expect(suggestions.json().items).toEqual(["alpha", "beta"]);

      const tableDataRules = new URLSearchParams({
        database: "envman_test",
        table: "items",
        filters: JSON.stringify([
          { column: "amount", operator: "gte", value: "10", enabled: true },
          { column: "name", operator: "ne", value: "beta", enabled: true },
        ]),
        sorts: JSON.stringify([
          { column: "amount", direction: "desc", enabled: true },
          { column: "id", direction: "asc", enabled: true },
        ]),
      });
      const filteredTableData = await app.inject({ method: "GET", url: `/api/v1/database-connections/${sourceId}/table-data?${tableDataRules.toString()}`, cookies });
      expect(filteredTableData.statusCode).toBe(200);
      expect(filteredTableData.json().rows).toEqual([expect.objectContaining({ name: "alpha", amount: 10 })]);

      const changed = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/table-data/changes`,
        cookies,
        payload: { database: "envman_test", table: "items", changes: [{ type: "update", key: { id: 1 }, values: { name: "alpha-updated", amount: 15 } }] },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().changed).toBe(1);

      const csvBoundary = "envman-csv-it";
      const imported = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/table-import`,
        cookies,
        headers: { "content-type": `multipart/form-data; boundary=${csvBoundary}` },
        payload: multipart(csvBoundary, { database: "envman_test", table: "items", mode: "append" }, "items.csv", "name,amount\r\ngamma,30\r\n"),
      });
      expect(imported.statusCode).toBe(201);
      expect(imported.json().imported).toBe(1);

      const csv = await app.inject({ method: "GET", url: `/api/v1/database-connections/${sourceId}/table-export?database=envman_test&table=items&format=csv`, cookies });
      expect(csv.statusCode).toBe(200);
      expect(csv.body).toContain("alpha-updated");
      const xlsx = await app.inject({ method: "GET", url: `/api/v1/database-connections/${sourceId}/table-export?database=envman_test&table=items&format=xlsx`, cookies });
      expect(xlsx.statusCode).toBe(200);
      expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");

      const backupStart = await app.inject({ method: "POST", url: `/api/v1/database-connections/${sourceId}/backup`, cookies, payload: { database: "envman_test" } });
      expect(backupStart.statusCode).toBe(202);
      const backupId = backupStart.json().task.id as string;
      const backup = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-tasks/${backupId}`, cookies })).json().task,
        (task: { status: string }) => !["pending", "running"].includes(task.status),
      );
      expect(backup.status).toBe("success");
      const backupFile = await app.inject({ method: "GET", url: `/api/v1/database-tasks/${backupId}/download`, cookies });
      expect(backupFile.statusCode).toBe(200);
      expect(backupFile.body).toContain("CREATE TABLE");
      expect(backupFile.body).toContain("PROCEDURE `item_count`");
      expect(backupFile.body).toContain("TRIGGER items_amount_guard");
      expect(backupFile.body).toContain("EVENT `item_maintenance`");

      const restoreBoundary = "envman-restore-it";
      const restoreStart = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${targetId}/restore`,
        cookies,
        headers: { "content-type": `multipart/form-data; boundary=${restoreBoundary}` },
        payload: multipart(restoreBoundary, { database: "envman_restore" }, "backup.sql", backupFile.rawPayload),
      });
      expect(restoreStart.statusCode).toBe(202);
      const restoreId = restoreStart.json().task.id as string;
      const restore = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-tasks/${restoreId}`, cookies })).json().task,
        (task: { status: string }) => !["pending", "running"].includes(task.status),
      );
      expect(restore.status, restore.error).toBe("success");

      const transferStart = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/transfer`,
        cookies,
        payload: { sourceDatabase: "envman_test", targetConnectionId: targetId, targetDatabase: "envman_transfer", includeStructure: true, includeData: true, includeObjects: true, dropExisting: true },
      });
      expect(transferStart.statusCode).toBe(202);
      const transferId = transferStart.json().task.id as string;
      const transfer = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-tasks/${transferId}`, cookies })).json().task,
        (task: { status: string }) => !["pending", "running"].includes(task.status),
      );
      expect(transfer.status, transfer.error).toBe("success");

      const verifyTransfer = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${targetId}/queries`,
        cookies,
        payload: { database: "envman_transfer", sql: "SELECT (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = 'envman_transfer') AS views, (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = 'envman_transfer') AS routines, (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = 'envman_transfer') AS triggers, (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = 'envman_transfer') AS events;" },
      });
      const verifyId = verifyTransfer.json().job.id as string;
      const verified = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-queries/${verifyId}`, cookies })).json().job,
        (job: { status: string }) => !["pending", "running"].includes(job.status),
      );
      expect(verified.status, verified.error).toBe("success");
      expect(verified.resultSets[0].rows[0]).toMatchObject({ views: "1", routines: "2", triggers: "1", events: "1" });

      const structurePreviewResponse = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/sync-preview`,
        cookies,
        payload: {
          mode: "structure",
          sourceDatabase: "envman_test",
          targetConnectionId: targetId,
          targetDatabase: "envman_sync",
          data: { insert: true, update: true, delete: true },
          structure: { dropExtra: true },
        },
      });
      expect(structurePreviewResponse.statusCode).toBe(200);
      const structurePreview = structurePreviewResponse.json().preview;
      const structureItems = structurePreview.items.filter((item: { action: string }) => item.action !== "none").map((item: { id: string }) => item.id);
      expect(structureItems.length).toBeGreaterThanOrEqual(6);
      const structureStart = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/sync`,
        cookies,
        payload: {
          mode: "structure",
          sourceDatabase: "envman_test",
          targetConnectionId: targetId,
          targetDatabase: "envman_sync",
          data: { insert: true, update: true, delete: true },
          structure: { dropExtra: true },
          selectedItems: structureItems,
        },
      });
      expect(structureStart.statusCode).toBe(202);
      const structureTask = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-tasks/${structureStart.json().task.id}`, cookies })).json().task,
        (task: { status: string }) => !["pending", "running"].includes(task.status),
      );
      expect(structureTask.status, structureTask.error).toBe("success");

      const disturbTarget = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${targetId}/queries`,
        cookies,
        payload: { database: "envman_sync", sql: "UPDATE items SET amount = 999 WHERE id = 1; DELETE FROM items WHERE id = 2; INSERT INTO items(id, name, amount) VALUES (100, 'extra', 100);" },
      });
      const disturbJob = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-queries/${disturbTarget.json().job.id}`, cookies })).json().job,
        (job: { status: string }) => !["pending", "running"].includes(job.status),
      );
      expect(disturbJob.status, disturbJob.error).toBe("success");

      const dataPreviewResponse = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/sync-preview`,
        cookies,
        payload: {
          mode: "data",
          sourceDatabase: "envman_test",
          targetConnectionId: targetId,
          targetDatabase: "envman_sync",
          data: { insert: true, update: true, delete: true },
          structure: {},
        },
      });
      expect(dataPreviewResponse.statusCode).toBe(200);
      const dataItems = dataPreviewResponse.json().preview.items.filter((item: { action: string }) => item.action === "sync").map((item: { id: string }) => item.id);
      expect(dataItems).toContain("table:data:items");
      const dataStart = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${sourceId}/sync`,
        cookies,
        payload: {
          mode: "data",
          sourceDatabase: "envman_test",
          targetConnectionId: targetId,
          targetDatabase: "envman_sync",
          data: { insert: true, update: true, delete: true },
          structure: {},
          selectedItems: dataItems,
        },
      });
      expect(dataStart.statusCode).toBe(202);
      const dataTask = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-tasks/${dataStart.json().task.id}`, cookies })).json().task,
        (task: { status: string }) => !["pending", "running"].includes(task.status),
      );
      expect(dataTask.status, dataTask.error).toBe("success");

      const verifyDataSync = await app.inject({
        method: "POST",
        url: `/api/v1/database-connections/${targetId}/queries`,
        cookies,
        payload: { database: "envman_sync", sql: "SELECT id, name, amount FROM items ORDER BY id" },
      });
      const verifiedData = await waitFor(
        async () => (await app.inject({ method: "GET", url: `/api/v1/database-queries/${verifyDataSync.json().job.id}`, cookies })).json().job,
        (job: { status: string }) => !["pending", "running"].includes(job.status),
      );
      expect(verifiedData.status, verifiedData.error).toBe("success");
      expect(verifiedData.resultSets[0].rows).toEqual([
        { id: 1, name: "alpha-updated", amount: 15 },
        { id: 2, name: "beta", amount: 20 },
        { id: 3, name: "gamma", amount: 30 },
      ]);
    } finally {
      await app.close();
    }
  }, 60_000);
});
