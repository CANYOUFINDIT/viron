import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeDatabaseSync, defaultDataSyncOptions, defaultStructureSyncOptions, type DatabaseSyncClient } from "../src/database-sync.js";

const gate = vi.hoisted(() => ({
  sql: [] as string[],
  holdConnect: false,
  releaseConnect: [] as Array<() => void>,
}));

vi.mock("../src/server/database-workbench/connector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/database-workbench/connector.js")>();
  return {
    ...actual,
    connectDatabase: async () => {
      if (gate.holdConnect) await new Promise<void>((resolve) => gate.releaseConnect.push(resolve));
      return {
        connection: {
          query(sql: string) {
            gate.sql.push(sql);
            if (/information_schema\.TABLES/i.test(sql)) return Promise.resolve([[{ name: "example" }], []]);
            if (/SHOW CREATE TABLE/i.test(sql)) return Promise.resolve([[{ "Create Table": "CREATE TABLE `example` (`id` INT, `label` VARCHAR(100))" }], []]);
            if (/^SELECT \*/i.test(sql)) return Promise.resolve([[{ id: 1, label: "fictional source" }], [{ name: "id" }, { name: "label" }]]);
            return Promise.resolve([[], []]);
          },
          escape(value: unknown) { return value === null || value === undefined ? "NULL" : JSON.stringify(value); },
          destroy() {},
        },
        async close() {},
        record: { name: "fixture" },
      };
    },
  };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { disconnectGrantees } from "../src/server/access-expiry.js";

const scratchRoot = join(process.cwd(), "private", "grok-supervision-20261011");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  gate.holdConnect = false;
  for (const release of gate.releaseConnect.splice(0)) release();
  gate.sql.length = 0;
  for (const finish of cleanup.splice(0)) await finish();
});

function configFor(dir: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 21),
    adminUsername: "review-admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function settle(app: FastifyInstance, userId: string, taskId: string) {
  const deadline = Date.now() + 5_000;
  let task = app.databaseTasks.get(taskId, userId, null);
  while (task && ["pending", "running"].includes(task.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    task = app.databaseTasks.get(taskId, userId, null);
  }
  return task;
}

async function fixture() {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "viron-task-"));
  const config = configFor(dir);
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  cleanup.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const req = (method: string, url: string, cookies: Record<string, string>, payload?: unknown) => app.inject({ method: method as "GET", url, cookies, payload });
  const login = await req("POST", "/api/v1/auth/login", {}, { username: config.adminUsername, password: config.adminPassword });
  const admin = { envman_session: login.cookies[0].value };
  const org = (await req("POST", "/api/v1/organizations", admin, { name: "任务验收组织" })).json().id as string;
  const base = `/api/v1/organizations/${org}`;
  await req("PUT", "/api/v1/auth/workspace", admin, { type: "organization", id: org });
  let client = 1;
  async function member(name: string, codes: string[], targets: Array<{ type: string; id: string }>) {
    const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: `192.0.2.${client++}`, payload: { username: name, password: "fake-review-password" } });
    expect(registered.statusCode, registered.body).toBe(201);
    const userId = registered.json().user.id as string;
    const cookies = { envman_session: registered.cookies[0].value };
    const stamp = new Date().toISOString();
    await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, userId, stamp, stamp);
    expect((await req("PUT", "/api/v1/auth/workspace", cookies, { type: "organization", id: org })).statusCode).toBe(200);
    const role = await req("POST", `${base}/roles`, admin, { name, permissionCodes: codes, reason: "任务验收" });
    expect(role.statusCode, role.body).toBe(201);
    const roleId = role.json().id as string;
    const assignment = await req("POST", `${base}/role-assignments`, admin, { roleId, subjectType: "user", subjectId: userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "任务验收" });
    expect(assignment.statusCode, assignment.body).toBe(201);
    if (targets.length) expect((await req("POST", `${base}/role-data-grants`, admin, { roleId, targets, reason: "任务验收" })).statusCode).toBe(201);
    return { userId, cookies, roleId };
  }
  async function database(name: string) {
    const response = await req("POST", "/api/v1/database-connections", admin, { name, engine: "mysql", host: "127.0.0.1", port: 3306, username: "fixture", credential: { password: "fixture-secret" } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }
  return { app, db, admin, org, base, member, database, req };
}

function multipart(database: string, sql: string) {
  const boundary = "task-permission-boundary";
  const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="database"\r\n\r\n${database}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fictional.sql"\r\nContent-Type: application/sql\r\n\r\n${sql}\r\n--${boundary}--\r\n`);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function hiddenDdl(statements: string[], database: string): string[] {
  return statements.filter((sql) => /^(?:CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql.trim()) && sql.includes(database));
}

describe("database background task permissions", () => {
  it("runs read-only source transfers, backup, and independent restores through the real routes", async () => {
    const f = await fixture();
    const source = await f.database("来源");
    const target = await f.database("目标");
    const ref = (id: string) => ({ type: "database_connection", id });
    const dataActor = await f.member("task-data", ["database.read"], [ref(source)]);
    const dataTarget = await f.req("POST", `${f.base}/roles`, f.admin, { name: "data-write", permissionCodes: ["database.write"], reason: "任务验收" });
    const dataRole = dataTarget.json().id as string;
    expect((await f.req("POST", `${f.base}/role-assignments`, f.admin, { roleId: dataRole, subjectType: "user", subjectId: dataActor.userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "任务验收" })).statusCode).toBe(201);
    expect((await f.req("POST", `${f.base}/role-data-grants`, f.admin, { roleId: dataRole, targets: [ref(target)], reason: "任务验收" })).statusCode).toBe(201);
    const structureActor = await f.member("task-structure", ["database.read"], [ref(source)]);
    const structureTarget = await f.req("POST", `${f.base}/roles`, f.admin, { name: "structure-ddl", permissionCodes: ["database.ddl"], reason: "任务验收" });
    const structureRole = structureTarget.json().id as string;
    expect((await f.req("POST", `${f.base}/role-assignments`, f.admin, { roleId: structureRole, subjectType: "user", subjectId: structureActor.userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "任务验收" })).statusCode).toBe(201);
    expect((await f.req("POST", `${f.base}/role-data-grants`, f.admin, { roleId: structureRole, targets: [ref(target)], reason: "任务验收" })).statusCode).toBe(201);
    const backupActor = await f.member("task-backup", ["database.read", "database.export"], [ref(source)]);
    const restoreWrite = await f.member("task-restore-write", ["database.write"], [ref(target)]);
    const restoreDdl = await f.member("task-restore-ddl", ["database.ddl"], [ref(target)]);

    const deniedTruncate = await f.req("POST", `/api/v1/database-connections/${source}/transfer`, dataActor.cookies, { sourceDatabase: "src_example", targetConnectionId: target, targetDatabase: "data_target", includeStructure: false, includeData: true, includeObjects: false, dropExisting: true, tables: ["example"] });
    expect(deniedTruncate.statusCode, deniedTruncate.body).toBe(403);

    const dataTransfer = await f.req("POST", `/api/v1/database-connections/${source}/transfer`, dataActor.cookies, { sourceDatabase: "src_example", targetConnectionId: target, targetDatabase: "data_target", includeStructure: false, includeData: true, includeObjects: false, dropExisting: false, tables: ["example"] });
    expect(dataTransfer.statusCode, dataTransfer.body).toBe(202);
    expect((await settle(f.app, dataActor.userId, dataTransfer.json().task.id)).status).toBe("success");
    const dataSql = gate.sql.splice(0);
    expect(hiddenDdl(dataSql, "data_target")).toEqual([]);
    expect(dataSql.some((sql) => sql.startsWith("INSERT INTO"))).toBe(true);
    expect(dataSql.some((sql) => sql.startsWith("CREATE DATABASE"))).toBe(false);

    const structureTransfer = await f.req("POST", `/api/v1/database-connections/${source}/transfer`, structureActor.cookies, { sourceDatabase: "src_example", targetConnectionId: target, targetDatabase: "structure_target", includeStructure: true, includeData: false, includeObjects: false, dropExisting: false, tables: ["example"] });
    expect(structureTransfer.statusCode, structureTransfer.body).toBe(202);
    expect((await settle(f.app, structureActor.userId, structureTransfer.json().task.id)).status).toBe("success");
    const structureSql = gate.sql.splice(0);
    expect(structureSql.some((sql) => sql.startsWith("CREATE DATABASE IF NOT EXISTS `structure_target`"))).toBe(true);
    expect(structureSql.some((sql) => /^CREATE TABLE /i.test(sql))).toBe(true);
    expect(structureSql.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);

    const withDdl = await f.member("task-truncate", ["database.write", "database.ddl"], [ref(target)]);
    const sourceRead = await f.req("POST", `${f.base}/roles`, f.admin, { name: "truncate-source-read", permissionCodes: ["database.read"], reason: "任务验收" });
    const sourceRole = sourceRead.json().id as string;
    expect((await f.req("POST", `${f.base}/role-assignments`, f.admin, { roleId: sourceRole, subjectType: "user", subjectId: withDdl.userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "任务验收" })).statusCode).toBe(201);
    expect((await f.req("POST", `${f.base}/role-data-grants`, f.admin, { roleId: sourceRole, targets: [ref(source)], reason: "任务验收" })).statusCode).toBe(201);
    const truncate = await f.req("POST", `/api/v1/database-connections/${source}/transfer`, withDdl.cookies, { sourceDatabase: "src_example", targetConnectionId: target, targetDatabase: "data_target", includeStructure: false, includeData: true, includeObjects: false, dropExisting: true, tables: ["example"] });
    expect(truncate.statusCode, truncate.body).toBe(202);
    expect((await settle(f.app, withDdl.userId, truncate.json().task.id)).status).toBe("success");
    expect(gate.sql.some((sql) => sql.startsWith("TRUNCATE TABLE `data_target`"))).toBe(true);
    expect(gate.sql.some((sql) => sql.startsWith("CREATE DATABASE"))).toBe(false);
    gate.sql.length = 0;

    const backup = await f.req("POST", `/api/v1/database-connections/${source}/backup`, backupActor.cookies, { database: "src_example", includeData: true });
    expect(backup.statusCode, backup.body).toBe(202);
    expect((await settle(f.app, backupActor.userId, backup.json().task.id)).status).toBe("success");
    expect(gate.sql.some((sql) => /^(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql.trim()))).toBe(false);

    const writeRestore = await f.app.inject({ method: "POST", url: `/api/v1/database-connections/${target}/restore`, cookies: restoreWrite.cookies, ...multipart("data_target", "UPDATE example SET label='restored fictional' WHERE id=1") });
    expect(writeRestore.statusCode, writeRestore.body).toBe(202);
    expect((await settle(f.app, restoreWrite.userId, writeRestore.json().task.id)).status).toBe("success");
    expect(hiddenDdl(gate.sql, "data_target")).toEqual([]);
    expect(gate.sql.some((sql) => sql.startsWith("UPDATE example"))).toBe(true);
    gate.sql.length = 0;

    const ddlRestore = await f.app.inject({ method: "POST", url: `/api/v1/database-connections/${target}/restore`, cookies: restoreDdl.cookies, ...multipart("structure_target", "CREATE TABLE restore_ddl(id INT PRIMARY KEY)") });
    expect(ddlRestore.statusCode, ddlRestore.body).toBe(202);
    expect((await settle(f.app, restoreDdl.userId, ddlRestore.json().task.id)).status).toBe("success");
    expect(gate.sql.some((sql) => sql.startsWith("CREATE TABLE restore_ddl"))).toBe(true);
    expect(gate.sql.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
    expect(gate.sql.some((sql) => sql.startsWith("CREATE DATABASE"))).toBe(false);
  });

  it("stops a running task only when its real target operation is revoked", async () => {
    const f = await fixture();
    const source = await f.database("来源");
    const target = await f.database("目标");
    const ref = (id: string) => ({ type: "database_connection", id });
    const actor = await f.member("task-live", ["database.read"], [ref(source)]);
    const targetRole = await f.req("POST", `${f.base}/roles`, f.admin, { name: "live-target", permissionCodes: ["database.write", "database.ddl"], reason: "任务验收" });
    const roleId = targetRole.json().id as string;
    expect((await f.req("POST", `${f.base}/role-assignments`, f.admin, { roleId, subjectType: "user", subjectId: actor.userId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "任务验收" })).statusCode).toBe(201);
    expect((await f.req("POST", `${f.base}/role-data-grants`, f.admin, { roleId, targets: [ref(target)], reason: "任务验收" })).statusCode).toBe(201);
    gate.holdConnect = true;
    const data = await f.req("POST", `/api/v1/database-connections/${source}/transfer`, actor.cookies, { sourceDatabase: "src_example", targetConnectionId: target, targetDatabase: "data_target", includeStructure: false, includeData: true, includeObjects: false, dropExisting: false, tables: ["example"] });
    const structure = await f.req("POST", `/api/v1/database-connections/${source}/transfer`, actor.cookies, { sourceDatabase: "src_example", targetConnectionId: target, targetDatabase: "structure_target", includeStructure: true, includeData: false, includeObjects: false, dropExisting: false, tables: ["example"] });
    expect(data.statusCode, data.body).toBe(202);
    expect(structure.statusCode, structure.body).toBe(202);
    await vi.waitFor(() => { expect(gate.releaseConnect.length).toBe(2); }, { timeout: 5_000 });
    await disconnectGrantees(f.app, f.org, [actor.userId]);
    expect(f.app.databaseTasks.get(data.json().task.id, actor.userId)?.status).toBe("running");
    expect(f.app.databaseTasks.get(structure.json().task.id, actor.userId)?.status).toBe("running");
    const revoked = await f.req("PUT", `${f.base}/roles/${roleId}`, f.admin, { name: "live-target", description: "", permissionCodes: ["database.ddl"], enabled: true, reason: "撤销目标写入" });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await disconnectGrantees(f.app, f.org, [actor.userId]);
    expect(f.app.databaseTasks.get(data.json().task.id, actor.userId)).toMatchObject({ status: "cancelled", error: "授权已到期" });
    expect(f.app.databaseTasks.get(structure.json().task.id, actor.userId)?.status).toBe("running");
    gate.holdConnect = false;
    for (const release of gate.releaseConnect.splice(0)) release();
    expect((await settle(f.app, actor.userId, structure.json().task.id))?.status).toBe("success");
    expect(gate.sql.some((sql) => sql.includes("data_target") && /^(?:CREATE|DROP|ALTER|TRUNCATE|INSERT|UPDATE|DELETE)\b/i.test(sql.trim()))).toBe(false);
    expect(gate.sql.some((sql) => sql.startsWith("CREATE TABLE"))).toBe(true);
  });

  it("keeps data sync off DDL and lets structure sync create the database", async () => {
    const statements: string[] = [];
    const rowsFor = (sql: string, present: boolean, withRows: boolean) => {
      statements.push(sql);
      if (/information_schema\.TABLES/i.test(sql)) return present ? [{ name: "example", rowCount: 1, engine: "InnoDB", collation: "utf8mb4_general_ci", comment: "", autoIncrement: null, rowFormat: "Dynamic" }] : [];
      if (/information_schema\.COLUMNS/i.test(sql)) return present ? [{ tableName: "example", name: "id", ordinalPosition: 1, columnType: "int", nullable: "NO", defaultValue: null, extra: "", charset: "", collation: "", comment: "", generationExpression: "" }, { tableName: "example", name: "label", ordinalPosition: 2, columnType: "varchar(100)", nullable: "YES", defaultValue: null, extra: "", charset: "utf8mb4", collation: "utf8mb4_general_ci", comment: "", generationExpression: "" }] : [];
      if (/information_schema\.STATISTICS/i.test(sql)) return present ? [{ tableName: "example", indexName: "PRIMARY", nonUnique: 0, indexType: "BTREE", sequence: 1, columnName: "id", subPart: null, direction: "A" }] : [];
      if (/^SELECT /i.test(sql)) return withRows && !/ WHERE /i.test(sql) ? [{ id: 1, label: "fictional source" }] : [];
      if (/SHOW CREATE TABLE/i.test(sql)) return [{ "Create Table": "CREATE TABLE `example` (`id` INT, `label` VARCHAR(100))" }];
      return [];
    };
    const client = (present: boolean, withRows: boolean): DatabaseSyncClient => ({
      query: (async (sql: string) => [rowsFor(sql, present, withRows), []]) as DatabaseSyncClient["query"],
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      escape(value: unknown) { return JSON.stringify(value); },
    });
    const options = { sourceDatabase: "src_example", targetDatabase: "data_target", data: { ...defaultDataSyncOptions(), delete: false }, structure: defaultStructureSyncOptions() };
    await executeDatabaseSync(client(true, true), client(true, false), { ...options, mode: "data" }, ["table:data:example"], { log() {}, progress() {}, cancelled: () => false });
    expect(statements.some((sql) => /^(?:CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql.trim()))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO"))).toBe(true);
    statements.length = 0;
    await executeDatabaseSync(client(true, false), client(false, false), { ...options, mode: "structure", targetDatabase: "structure_target" }, ["table:table:example"], { log() {}, progress() {}, cancelled: () => false });
    expect(statements.some((sql) => sql.startsWith("CREATE DATABASE IF NOT EXISTS `structure_target`"))).toBe(true);
    expect(statements.some((sql) => /^CREATE TABLE /i.test(sql))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
  });
});
