import type { FastifyInstance } from "fastify";
import type { FieldPacket, QueryResult, ResultSetHeader } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { DesktopDatabaseRuntime, type ConnectedDesktopDatabase, type DatabaseConnectionClient, type DesktopDatabaseQueryJob } from "../src/desktop/database-runtime.js";
import type { DesktopDatabaseCredential } from "../src/desktop/device-identity.js";
import type { DesktopSshContext } from "../src/desktop/ssh-runtime.js";
import type { AuthenticatedUser } from "../src/server/access-control.js";
import type { ConnectedDatabase } from "../src/server/database-workbench/connector.js";
import { DatabaseQueryManager, type PublicQueryJob } from "../src/server/database-workbench/query-manager.js";

const connectionId = "22222222-2222-4222-8222-222222222222";
const context: DesktopSshContext = {
  endpoint: "http://127.0.0.1:8080",
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceType: "personal",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};

function credential(): DesktopDatabaseCredential {
  return {
    connection: {
      connectionId,
      name: "Test",
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
      connectionUpdatedAt: "2026-07-25T00:00:00.000Z",
    },
    sshCredential: null,
  };
}

function fakeConnection(statements: string[]): DatabaseConnectionClient {
  return {
    async query<T extends QueryResult = QueryResult>(sql: string): Promise<[T, FieldPacket[]]> {
      statements.push(sql);
      if (/FAIL/i.test(sql)) throw Object.assign(new Error("statement failed"), { sqlMessage: "statement failed" });
      if (/SELECT/i.test(sql)) {
        return [[{ value: Number(sql.match(/\d+/)?.[0] ?? 0) }] as T, [{ name: "value", table: "", type: 3 } as FieldPacket]];
      }
      return [{ affectedRows: 1, insertId: 0, info: "" } as ResultSetHeader as T, []];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    escape: (value) => String(value),
    async end() {},
    destroy() {},
  };
}

async function waitFor<T extends { status: string }>(read: () => T, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (!["pending", "running"].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("query did not finish");
}

async function waitForAsync<T extends { status: string }>(read: () => Promise<T>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (!["pending", "running"].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("query did not finish");
}

describe("database query continue-on-error execution", () => {
  it("continues on the server and preserves each failed statement as a result", async () => {
    const statements: string[] = [];
    const app = {
      db: {
        prepare(sql: string) {
          return {
            get: async () => sql.includes("SELECT name FROM database_connections") ? { name: "Test" } : undefined,
            run: async () => ({ changes: 1 }),
          };
        },
      },
      activeConnections: { touchResource() {} },
    } as unknown as FastifyInstance;
    const connected = {
      connection: fakeConnection(statements),
      record: { name: "Test" },
      async close() {},
    } as ConnectedDatabase;
    const manager = new DatabaseQueryManager(app, async () => connected);
    const user: AuthenticatedUser = {
      id: context.userId,
      username: "operator",
      isPlatformAdmin: true,
      workspace: { type: "personal", id: context.workspaceId, name: "Personal", role: "owner" },
    };

    const created = await manager.create(user, connectionId, "SELECT 1; FAIL; SELECT 2;", "ops", null, true);
    const completed = await waitFor(() => manager.get(created.id, user.id, null) as PublicQueryJob);
    manager.closeAll();

    expect(statements).toEqual(["SELECT 1", "FAIL", "SELECT 2"]);
    expect(completed.status).toBe("error");
    expect(completed.error).toContain("1 条语句执行失败");
    expect(completed.resultSets.map((result) => result.error ?? result.rows[0]?.value)).toEqual([1, "statement failed", 2]);
  });

  it("continues through the desktop local runtime with the same result contract", async () => {
    const statements: string[] = [];
    const databaseCredential = credential();
    const runtime = new DesktopDatabaseRuntime(
      async () => ({ context, credential: databaseCredential }),
      async () => undefined,
      async (): Promise<ConnectedDesktopDatabase> => ({
        connection: fakeConnection(statements),
        credential: databaseCredential,
        async close() {},
      }),
    );
    const started = await runtime.handle({
      path: `/api/v1/database-connections/${connectionId}/queries`,
      method: "POST",
      body: { kind: "text", value: JSON.stringify({ database: "ops", sql: "SELECT 1; FAIL; SELECT 2;", continueOnError: true }) },
    }, context);
    const id = (JSON.parse(started.body).job as DesktopDatabaseQueryJob).id;
    const completed = await waitForAsync(async () => {
      const response = await runtime.handle({ path: `/api/v1/database-queries/${id}` }, context);
      return JSON.parse(response.body).job as DesktopDatabaseQueryJob;
    });

    expect(statements).toEqual(["SELECT 1", "FAIL", "SELECT 2"]);
    expect(completed.status).toBe("error");
    expect(completed.resultSets.map((result) => result.error ?? result.rows[0]?.value)).toEqual([1, "statement failed", 2]);
  });
});
