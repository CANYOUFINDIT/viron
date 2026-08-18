import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FieldPacket, QueryResult, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopDatabaseOperationRuntime, isDesktopDatabaseOperationPath } from "../src/desktop/database-operations-runtime.js";
import type { DesktopDatabaseCredential } from "../src/desktop/device-identity.js";
import type {
  ConnectedDesktopDatabase,
  DatabaseConnectionClient,
  DesktopDatabaseExecutionReport,
  DesktopDatabaseRequest,
} from "../src/desktop/database-runtime.js";
import type { DesktopSshContext } from "../src/desktop/ssh-runtime.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const context: DesktopSshContext = {
  endpoint: "http://127.0.0.1:8080",
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceType: "personal",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};

function credential(connectionId: string): DesktopDatabaseCredential {
  return {
    connection: {
      connectionId,
      name: connectionId === "22222222-2222-4222-8222-222222222222" ? "Source" : "Target",
      engine: "mysql",
      host: "127.0.0.1",
      port: 3306,
      username: "operator",
      password: "secret",
      httpTunnelUsername: "",
      httpTunnelPassword: "",
      defaultDatabase: "ops",
      connectionMode: "tcp",
      options: {},
      connectionUpdatedAt: "2026-07-21T00:00:00.000Z",
    },
    sshCredential: null,
  };
}

function header(affectedRows = 0): ResultSetHeader {
  return { affectedRows, insertId: 0, info: "" } as ResultSetHeader;
}

function fakeConnection(connectionId: string, statements: string[]): DatabaseConnectionClient {
  return {
    async query<T extends QueryResult = QueryResult>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]> {
      statements.push(`${connectionId}:${sql}`);
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (/SELECT \* FROM `ops`\.`items` LIMIT \?/i.test(normalized)) {
        return [[{ id: 1, name: "alpha" }, { id: 2, name: "beta" }] as T, [{ name: "id" }, { name: "name" }] as FieldPacket[]];
      }
      if (/SELECT COLUMN_NAME AS name FROM information_schema\.COLUMNS/i.test(normalized)) {
        return [[{ name: "id" }, { name: "name" }] as T, []];
      }
      if (/SHOW FULL TABLES FROM `ops`/i.test(normalized)) {
        return [[{ Tables_in_ops: "items", Table_type: "BASE TABLE" }] as T, []];
      }
      if (/SELECT ROUTINE_NAME AS name/i.test(normalized)
        || /SELECT TRIGGER_NAME AS name/i.test(normalized)
        || /SELECT EVENT_NAME AS name/i.test(normalized)
        || /SELECT TABLE_NAME AS name FROM information_schema\.VIEWS/i.test(normalized)) {
        return [[] as unknown as T, []];
      }
      if (/SELECT TABLE_NAME AS name FROM information_schema\.TABLES/i.test(normalized)) {
        return [[{ name: "items" }] as T, []];
      }
      if (/SHOW CREATE TABLE/i.test(normalized)) {
        return [[{ Table: "items", "Create Table": "CREATE TABLE `items` (`id` int primary key, `name` varchar(80))" }] as T, []];
      }
      if (/SELECT \* FROM `ops`\.`items`$/i.test(normalized)) {
        return [[{ id: 1, name: "alpha" }, { id: 2, name: "beta" }] as T, [{ name: "id" }, { name: "name" }] as FieldPacket[]];
      }
      const affectedRows = /INSERT INTO|DELETE FROM/i.test(normalized) ? 2 : 0;
      void values;
      return [header(affectedRows) as T, []];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    escape(value: unknown) {
      if (value === null || value === undefined) return "NULL";
      if (typeof value === "number") return String(value);
      return `'${String(value).replaceAll("'", "''")}'`;
    },
    async end() {},
    destroy() {},
  };
}

function textRequest(path: string, method: string, body: Record<string, unknown>): DesktopDatabaseRequest {
  return { path, method, body: { kind: "text", value: JSON.stringify(body) } };
}

function formRequest(path: string, fields: Record<string, string>, filename: string, content: string): DesktopDatabaseRequest {
  const bytes = Uint8Array.from(Buffer.from(content, "utf8"));
  return {
    path,
    method: "POST",
    body: {
      kind: "form",
      entries: [
        ...Object.entries(fields).map(([name, value]) => ({ name, value })),
        { name: "file", file: { name: filename, type: "text/plain", data: bytes.buffer } },
      ],
    },
  };
}

async function waitForTask(runtime: DesktopDatabaseOperationRuntime, taskId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await runtime.handle({ path: `/api/v1/database-tasks/${taskId}` }, context);
    const task = JSON.parse(response.body).task as { status: string; error: string; downloadable: boolean };
    if (!["pending", "running"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待本机数据库任务超时");
}

describe("desktop database operations runtime", () => {
  it("routes data and structure synchronization through the local database operation runtime", () => {
    const connectionId = "22222222-2222-4222-8222-222222222222";
    expect(isDesktopDatabaseOperationPath(`/api/v1/database-connections/${connectionId}/sync-preview`)).toBe(true);
    expect(isDesktopDatabaseOperationPath(`/api/v1/database-connections/${connectionId}/sync`)).toBe(true);
  });

  it("imports, exports, backs up, restores, transfers, persists task output, and reports operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-database-operations-"));
    directories.push(directory);
    const statements: string[] = [];
    const reports: DesktopDatabaseExecutionReport[] = [];
    const runtime = new DesktopDatabaseOperationRuntime(
      directory,
      async (connectionId) => ({ context, credential: credential(connectionId) }),
      async (report) => { reports.push(report); },
      async (databaseCredential): Promise<ConnectedDesktopDatabase> => ({
        connection: fakeConnection(databaseCredential.connection.connectionId, statements),
        credential: databaseCredential,
        async close() {},
      }),
    );
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const targetId = "33333333-3333-4333-8333-333333333333";

    const csv = await runtime.download(
      `/api/v1/database-connections/${sourceId}/table-export?database=ops&table=items&format=csv`,
      context,
    );
    expect(csv.filename).toBe("ops.items.csv");
    expect(csv.data.toString("utf8")).toContain("alpha");
    const xlsx = await runtime.download(
      `/api/v1/database-connections/${sourceId}/table-export?database=ops&table=items&format=xlsx`,
      context,
    );
    expect(xlsx.contentType).toContain("spreadsheetml");
    expect(xlsx.data.length).toBeGreaterThan(1_000);
    const sql = await runtime.download(
      `/api/v1/database-connections/${sourceId}/table-export?database=ops&table=items&format=sql`,
      context,
    );
    expect(sql.data.toString("utf8")).toContain("CREATE TABLE `items`");

    const imported = await runtime.handle(formRequest(
      `/api/v1/database-connections/${sourceId}/table-import`,
      { database: "ops", table: "items", mode: "append" },
      "items.csv",
      "id,name\n3,gamma\n4,delta\n",
    ), context);
    expect(imported.status).toBe(201);
    expect(JSON.parse(imported.body)).toEqual({ imported: 2, columns: 2 });

    const backupStarted = await runtime.handle(textRequest(
      `/api/v1/database-connections/${sourceId}/backup`,
      "POST",
      { database: "ops" },
    ), context);
    const backupId = JSON.parse(backupStarted.body).task.id as string;
    expect(await waitForTask(runtime, backupId)).toMatchObject({ status: "success", downloadable: true });
    const backup = await runtime.download(`/api/v1/database-tasks/${backupId}/download`, context);
    expect(backup.data.toString("utf8")).toContain("Viron SQL Backup");
    expect(backup.data.toString("utf8")).toContain("INSERT INTO `items`");

    const restoreStarted = await runtime.handle(formRequest(
      `/api/v1/database-connections/${targetId}/restore`,
      { database: "restored" },
      "restore.sql",
      "CREATE TABLE restored_items(id INT);\nINSERT INTO restored_items VALUES (1);\n",
    ), context);
    const restoreId = JSON.parse(restoreStarted.body).task.id as string;
    expect(await waitForTask(runtime, restoreId)).toMatchObject({ status: "success" });

    const transferStarted = await runtime.handle(textRequest(
      `/api/v1/database-connections/${sourceId}/transfer`,
      "POST",
      {
        sourceDatabase: "ops",
        targetConnectionId: targetId,
        targetDatabase: "copied",
        includeStructure: true,
        includeData: true,
        includeObjects: true,
        dropExisting: true,
      },
    ), context);
    const transferId = JSON.parse(transferStarted.body).task.id as string;
    expect(await waitForTask(runtime, transferId)).toMatchObject({ status: "success" });

    const list = await runtime.handle({ path: "/api/v1/database-tasks" }, context);
    expect(JSON.parse(list.body).items).toHaveLength(3);
    expect(statements.some((statement) => statement.includes("CREATE DATABASE IF NOT EXISTS `restored`"))).toBe(true);
    expect(statements.some((statement) => statement.includes("CREATE DATABASE IF NOT EXISTS `copied`"))).toBe(true);
    expect(statements.some((statement) => statement.includes("INSERT INTO `copied`.`items`"))).toBe(true);
    expect(reports.filter((report) => report.kind === "operation" && report.action === "table_exported")).toHaveLength(3);
    expect(reports.some((report) => report.kind === "operation" && report.action === "table_imported")).toBe(true);
    expect(reports.some((report) => report.kind === "operation" && report.action === "backup_success")).toBe(true);
    expect(reports.some((report) => report.kind === "operation" && report.action === "restore_success")).toBe(true);
    expect(reports.some((report) => report.kind === "operation" && report.action === "transfer_success")).toBe(true);
  });
});
