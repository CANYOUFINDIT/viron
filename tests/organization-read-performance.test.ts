import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app";
import { ensureAdmin, openDatabase } from "../src/server/database";
import type { AppConfig } from "../src/server/config";
import { PERMISSION_CODES } from "../src/shared/organization-rbac";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it("keeps directory reads bounded as roles and requests grow, and refreshes revoked access on the next request", async () => {
  const root = join(process.cwd(), "private", "organization-read-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "db-"));
  const config: AppConfig = {
    nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: dir, databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 21), adminUsername: "read-admin", adminPassword: "test-password-123",
    allowWeakPasswords: true, sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30,
  };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
  const cookies = { envman_session: login.cookies[0].value };
  const userId = login.json().user.id as string;
  const created = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "查询性能示例" } });
  const org = created.json().id as string;
  const base = `/api/v1/organizations/${org}`;
  expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  await app.inject({ method: "GET", url: base + "/approval-flows", cookies });
  const reads = vi.spyOn(db, "prepare");
  const get = async (path: string) => {
    reads.mockClear();
    const response = await app.inject({ method: "GET", url: base + path, cookies });
    expect(response.statusCode, response.body).toBe(200);
    return { payload: response.json(), queries: reads.mock.calls.length, roleReads: reads.mock.calls.filter(([sql]) => sql.includes("FROM organization_roles WHERE")).length };
  };
  const small = await get("/my-access");
  const stamp = new Date().toISOString();
  for (let index = 0; index < 40; index++) {
    const roleId = randomUUID();
    await db.prepare("INSERT INTO organization_roles (id,organization_id,name,description,permission_codes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(roleId, org, `示例角色 ${index}`, "", JSON.stringify(PERMISSION_CODES), stamp, stamp);
    await db.prepare("INSERT INTO organization_role_assignments (id,organization_id,role_id,subject_type,subject_id,management_scope_json,reason,source,created_at) VALUES (?,?,?,'user',?,?,'性能验证','manual',?)")
      .run(randomUUID(), org, roleId, userId, JSON.stringify({ kind: "organization", ids: [], includeChildren: true }), stamp);
  }
  const large = await get("/my-access");
  expect(large.queries).toBe(small.queries);
  expect(large.roleReads).toBe(1);
  expect(large.payload.roles.length).toBe(small.payload.roles.length + 40);
  for (const role of large.payload.roles) expect(role.holders).toEqual([{ id: userId, name: config.adminUsername }]);
  for (const path of ["/role-access", "/role-resource-catalog", "/approval-flows", "/grant-ledger", `/members/${userId}/permissions`]) {
    expect((await get(path)).roleReads, path).toBe(1);
  }

  const snapshot = { permissionCodes: [], holderIds: [], targets: [], features: { mcp: true, agent: false, webPlugins: false }, durationMs: null, display: { frozen: true, roleName: null, requesterName: "示例申请人", holderNames: {}, targets: [] } };
  const workflow = { flowId: randomUUID(), flowName: "示例审批流程", nodes: [{ id: "node", name: "审批", mode: "any", resolvedApproverIds: [userId], passApproverIds: [userId], approverNames: { [userId]: "示例审批人" }, allowSelf: true, requireComment: false }] };
  const requestIds: string[] = [];
  for (let index = 0; index < 40; index++) {
    const requestId = randomUUID();
    requestIds.push(requestId);
    await db.prepare("INSERT INTO organization_grant_requests (id,organization_id,requester_id,kind,targets_json,permission_snapshot_json,workflow_snapshot_json,decisions_json,status,grant_ids_json,block_reason,reason,created_at,updated_at) VALUES (?,?,?,'feature','[]',?,?,'[]',?,'[]','','性能验证',?,?)")
      .run(requestId, org, userId, JSON.stringify(snapshot), JSON.stringify(workflow), index < 10 ? "pending" : "approved", stamp, stamp);
  }
  const summary = await get("/grant-requests?view=all&summary=1");
  expect(summary.queries).toBeLessThan(20);
  expect(summary.roleReads).toBe(1);
  expect(summary.payload.items).toHaveLength(40);
  expect(summary.payload.items[0].requesterName).toBe("示例申请人");
  expect(summary.payload.items[0]).not.toHaveProperty("nodes");
  expect(summary.payload.items[0]).not.toHaveProperty("operations");
  const todo = await get("/grant-requests?view=todo&summary=1");
  expect(todo.payload.items).toHaveLength(10);
  expect(todo.queries).toBeLessThan(20);
  const detail = await get(`/grant-requests/${requestIds[0]}`);
  expect(detail.payload.nodes).toHaveLength(1);
  expect(detail.payload.canApprove).toBe(true);

  await db.prepare("UPDATE organization_roles SET enabled = 0 WHERE organization_id = ?").run(org);
  expect((await get("/grant-requests?view=todo&summary=1")).payload.items).toEqual([]);
  expect((await get("/my-access")).payload.roles.every((role: { usable: boolean }) => !role.usable)).toBe(true);
  expect((await app.inject({ method: "GET", url: base + "/grant-requests?view=all&summary=1", cookies })).statusCode).toBe(403);
  reads.mockRestore();
});
