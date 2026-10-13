import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "viron-legacy-flow-"));
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    databasePath: join(dir, "db.sqlite"),
    masterKey: Buffer.alloc(32, 21),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  cleanup.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
  const cookies = { envman_session: login.cookies[0].value };
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "旧流程组织" } });
  expect(organization.statusCode, organization.body).toBe(201);
  const org = organization.json().id as string;
  expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: org } })).statusCode).toBe(200);
  const ssh = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-connections",
    cookies,
    payload: { name: "虚构连接", host: "example.invalid", port: 22, username: "fake", authType: "password", password: "fake" },
  });
  expect(ssh.statusCode, ssh.body).toBe(201);
  return { app, db, cookies, org, sshId: ssh.json().id as string, base: `/api/v1/organizations/${org}` };
}

describe("legacy approval flow compatibility", () => {
  it("keeps an unknown legacy node, blocks edit and submit, and does not downgrade it", async () => {
    const f = await fixture();
    const approver = randomUUID();
    const roleId = randomUUID();
    const legacy = {
      name: "虚构旧流程",
      stages: [
        { name: "旧会签", mode: "all", approverIds: [approver], approverRoleId: roleId, allowSelf: false, requireComment: true, allowTransfer: false },
        { name: "旧自定义", mode: "department_head", approverIds: [approver], approverRoleId: roleId, allowSelf: true, requireComment: true, allowRollback: false },
      ],
    };
    await f.db.prepare("INSERT INTO organization_approval_workflows (organization_id, workflow_json, updated_at) VALUES (?,?,?)")
      .run(f.org, JSON.stringify(legacy), new Date().toISOString());
    const flows = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    expect(flows.statusCode, flows.body).toBe(200);
    const defaults = flows.json().items.filter((item: { isDefault: boolean }) => item.isDefault);
    expect(defaults).toHaveLength(1);
    const nodes = defaults[0].nodes;
    expect(nodes.map((node: { mode: string }) => node.mode)).toEqual(["all", "department_head"]);
    expect(nodes[0]).toMatchObject({ approverUserIds: [approver], approverRoleId: roleId, allowSelf: false, requireComment: true, allowTransfer: false });
    expect(nodes[0]).not.toHaveProperty("allowAddSign");
    expect(nodes[0]).not.toHaveProperty("allowRollback");
    expect(nodes[1]).toMatchObject({
      unsupported: true,
      approverUserIds: [approver],
      approverRoleId: roleId,
      allowSelf: true,
      requireComment: true,
      allowRollback: false,
      legacySnapshot: legacy.stages[1],
    });
    expect(nodes[1]).not.toHaveProperty("allowTransfer");
    expect(nodes[1]).not.toHaveProperty("allowAddSign");
    expect(nodes[1].mode).not.toBe("any");
    const again = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    expect(again.json().items.filter((item: { isDefault: boolean }) => item.isDefault)).toEqual([
      expect.objectContaining({ id: defaults[0].id }),
    ]);
    const edit = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        id: defaults[0].id,
        name: "所有连接",
        nodes: [{ id: randomUUID(), name: "降级", mode: "any", approverUserIds: [approver], approverRoleId: null, allowSelf: false, requireComment: false }],
        targets: [],
      },
    });
    expect(edit.statusCode, edit.body).toBe(409);
    expect(edit.json().error).toBe("UNSUPPORTED_APPROVAL_NODE");
    expect(edit.json().message).toContain("不支持");
    expect(edit.json().message).toContain("不能编辑或降级");
    const kept = await f.db.prepare("SELECT nodes_json FROM organization_approval_flows WHERE id = ?").get<{ nodes_json: string }>(defaults[0].id);
    expect(JSON.parse(kept!.nodes_json)[1].mode).toBe("department_head");
    const before = await f.db.prepare("SELECT COUNT(*) AS count FROM organization_grant_requests WHERE organization_id = ?").get<{ count: number }>(f.org);
    const submit = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features: { mcp: true, agent: false, webPlugins: false }, targets: [{ type: "ssh_connection", id: f.sshId }], reason: "未知节点不能提交" },
    });
    expect(submit.statusCode, submit.body).toBe(409);
    expect(submit.json().error).toBe("UNSUPPORTED_APPROVAL_NODE");
    expect(submit.json().message).toContain("department_head");
    const after = await f.db.prepare("SELECT COUNT(*) AS count FROM organization_grant_requests WHERE organization_id = ?").get<{ count: number }>(f.org);
    expect(after!.count).toBe(before!.count);
  });

  it("rolls back a failed ledger from GET approval-flows and rereads one default flow", async () => {
    const f = await fixture();
    const legacy = JSON.stringify({ name: "旧流程", stages: [{ name: "会签", mode: "all", approverIds: [randomUUID()], allowSelf: false, requireComment: true }] });
    await f.db.prepare("INSERT INTO organization_approval_workflows (organization_id, workflow_json, updated_at) VALUES (?,?,?)").run(f.org, legacy, new Date().toISOString());
    const originalPrepare = f.db.prepare.bind(f.db);
    (f.db as unknown as { prepare: typeof f.db.prepare }).prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("INSERT INTO organization_grant_ledger")) return statement;
      return {
        ...statement,
        run: async (...values: unknown[]) => {
          if (values[4] === "建立默认审批流程") throw new Error("fictional migration ledger unavailable");
          return statement.run(...values);
        },
      };
    }) as typeof f.db.prepare;
    let failed: { statusCode: number; body: string };
    try {
      failed = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    } finally {
      f.db.prepare = originalPrepare;
    }
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await f.db.prepare("SELECT id FROM organization_approval_flows WHERE organization_id = ?").all(f.org)).toEqual([]);
    expect(await f.db.prepare("SELECT id FROM organization_grant_ledger WHERE organization_id = ? AND action = ?").all(f.org, "建立默认审批流程")).toEqual([]);
    const flows = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    expect(flows.statusCode, flows.body).toBe(200);
    const defaults = flows.json().items.filter((item: { isDefault: boolean }) => item.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].nodes[0].mode).toBe("all");
    const again = await f.app.inject({ method: "GET", url: f.base + "/approval-flows", cookies: f.cookies });
    const reread = again.json().items.filter((item: { isDefault: boolean }) => item.isDefault);
    expect(reread).toHaveLength(1);
    expect(reread[0].id).toBe(defaults[0].id);
    expect((await f.db.prepare("SELECT workflow_json FROM organization_approval_workflows WHERE organization_id = ?").get<{ workflow_json: string }>(f.org))!.workflow_json).toBe(legacy);
  });

  it("keeps an independent feature grant when a referenced role cannot be deleted", async () => {
    const f = await fixture();
    const registration = await f.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "holder", password: "holder-password" } });
    const userId = registration.json().user.id as string;
    const stamp = new Date().toISOString();
    await f.db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(f.org, userId, stamp, stamp);
    const feature = await f.app.inject({
      method: "POST",
      url: f.base + "/feature-grants",
      cookies: f.cookies,
      payload: {
        subjectType: "user",
        subjectId: userId,
        targets: [{ type: "ssh_connection", id: f.sshId }],
        features: { mcp: true, agent: false, webPlugins: false },
        reason: "独立功能",
      },
    });
    expect(feature.statusCode, feature.body).toBe(201);
    const role = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "只被流程引用", permissionCodes: ["approval.approve"], reason: "引用" },
    });
    expect(role.statusCode, role.body).toBe(201);
    const flow = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "角色流程",
        targets: [{ type: "ssh_connection", id: f.sshId }],
        nodes: [{ id: randomUUID(), name: "角色审批", mode: "any", approverUserIds: [], approverRoleId: role.json().id, allowSelf: false, requireComment: false }],
      },
    });
    expect(flow.statusCode, flow.body).toBe(201);
    const removed = await f.app.inject({
      method: "DELETE",
      url: f.base + "/roles/" + role.json().id,
      cookies: f.cookies,
      payload: { reason: "不应删除" },
    });
    expect(removed.statusCode, removed.body).toBe(409);
    expect(await f.db.prepare("SELECT id FROM organization_roles WHERE id = ?").get(role.json().id)).toBeTruthy();
    expect(await f.db.prepare("SELECT id FROM organization_feature_grants WHERE id = ?").get(feature.json().id)).toBeTruthy();
    const spare = await f.app.inject({
      method: "POST",
      url: f.base + "/roles",
      cookies: f.cookies,
      payload: { name: "无引用角色", permissionCodes: ["ssh.view"], reason: "可删" },
    });
    expect((await f.app.inject({
      method: "DELETE",
      url: f.base + "/roles/" + spare.json().id,
      cookies: f.cookies,
      payload: { reason: "删除无引用角色" },
    })).statusCode).toBe(200);
    expect(await f.db.prepare("SELECT id FROM organization_feature_grants WHERE id = ?").get(feature.json().id)).toBeTruthy();
  });
});
