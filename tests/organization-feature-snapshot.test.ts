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
  const dir = mkdtempSync(join(tmpdir(), "viron-feature-snapshot-"));
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
  const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies, payload: { name: "功能快照组织" } });
  const org = organization.json().id as string;
  await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies, payload: { type: "organization", id: org } });
  const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "snapshot-approver", password: "approver-password" } });
  const approverId = registered.json().user.id as string;
  const approverCookies = { envman_session: registered.cookies[0].value };
  const stamp = new Date().toISOString();
  await db.prepare("INSERT INTO organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (?,?,'member',?,?)").run(org, approverId, stamp, stamp);
  await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: approverCookies, payload: { type: "organization", id: org } });
  const base = `/api/v1/organizations/${org}`;
  const role = await app.inject({
    method: "POST",
    url: base + "/roles",
    cookies,
    payload: { name: "审批人", permissionCodes: ["approval.approve"], reason: "验收" },
  });
  expect((await app.inject({
    method: "POST",
    url: base + "/role-assignments",
    cookies,
    payload: { roleId: role.json().id, subjectType: "user", subjectId: approverId, managementScope: { kind: "organization", ids: [], includeChildren: true }, reason: "验收" },
  })).statusCode).toBe(201);
  const flows = await app.inject({ method: "GET", url: base + "/approval-flows", cookies });
  const current = flows.json().items.find((item: { isDefault: boolean }) => item.isDefault);
  expect((await app.inject({
    method: "POST",
    url: base + "/approval-flows",
    cookies,
    payload: {
      id: current.id,
      name: "所有连接",
      nodes: [{ id: randomUUID(), name: "审批", mode: "any", approverUserIds: [approverId], approverRoleId: null, allowSelf: false, requireComment: false }],
      targets: [],
    },
  })).statusCode).toBe(200);
  return { app, db, cookies, approverCookies, approverId, org, base };
}

function connection(name: string, environmentId?: string) {
  return {
    name,
    host: "fixture.invalid",
    port: 22,
    username: "example",
    authType: "password",
    password: "fictional",
    ...(environmentId ? { environmentIds: [environmentId] } : {}),
  };
}

describe("feature request scope snapshots", () => {
  it("approves the connections linked at submission and leaves a later connection out", async () => {
    const f = await fixture();
    const environment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "验收环境" } });
    const envId = environment.json().id as string;
    const initial = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("提交前", envId) });
    const initialId = initial.json().id as string;
    const submitted = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: {
        kind: "feature",
        features: { mcp: true, agent: true, webPlugins: false },
        targets: [{ type: "environment", id: envId }, { type: "environment", id: envId }],
        reason: "固定环境范围",
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const stored = JSON.parse((await f.db.prepare("SELECT targets_json FROM organization_grant_requests WHERE id = ?").get<{ targets_json: string }>(submitted.json().id))!.targets_json) as Array<{ type: string; id: string }>;
    const keys = stored.map((target) => `${target.type}:${target.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(stored.filter((target) => target.type === "environment" && target.id === envId)).toHaveLength(1);
    expect(stored).toEqual(expect.arrayContaining([
      { type: "ssh_connection", id: initialId },
      { type: "monitor_host", id: initialId },
    ]));
    const added = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("提交后", envId) });
    const approved = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${submitted.json().id}/decision`,
      cookies: f.approverCookies,
      payload: { decision: "approve", comment: "同意" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const grants = await f.db.prepare("SELECT targets_json FROM organization_feature_grants WHERE request_id = ?").all<{ targets_json: string }>(submitted.json().id);
    const targets = grants.flatMap((row) => JSON.parse(row.targets_json) as Array<{ type: string; id: string }>);
    expect(grants).toHaveLength(1);
    expect(targets).toEqual(expect.arrayContaining([{ type: "ssh_connection", id: initialId }]));
    expect(targets.some((target) => target.id === added.json().id)).toBe(false);
  });

  it("keeps an empty environment on the default flow and rejects a connection-only web plugin", async () => {
    const f = await fixture();
    const environment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "空环境" } });
    const envId = environment.json().id as string;
    const submitted = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features: { mcp: false, agent: false, webPlugins: true }, targets: [{ type: "environment", id: envId }], reason: "空环境插件" },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const row = await f.db.prepare("SELECT targets_json, workflow_snapshot_json FROM organization_grant_requests WHERE id = ?").get<{ targets_json: string; workflow_snapshot_json: string }>(submitted.json().id);
    expect(JSON.parse(row!.targets_json)).toEqual([{ type: "environment", id: envId }]);
    expect(JSON.parse(row!.workflow_snapshot_json).flowName).toBe("所有连接");
    const approved = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${submitted.json().id}/decision`,
      cookies: f.approverCookies,
      payload: { decision: "approve", comment: "同意" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const grant = await f.db.prepare("SELECT targets_json FROM organization_feature_grants WHERE request_id = ?").get<{ targets_json: string }>(submitted.json().id);
    expect(JSON.parse(grant!.targets_json)).toEqual([{ type: "environment", id: envId }]);
    const ssh = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("单独连接") });
    const plugin = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features: { mcp: false, agent: false, webPlugins: true }, targets: [{ type: "ssh_connection", id: ssh.json().id }], reason: "连接不能开插件" },
    });
    expect(plugin.statusCode, plugin.body).toBe(400);
    expect(plugin.json().error).toBe("INVALID_PLUGIN_SCOPE");
  });

  it("returns fixed groups for one environment and accepts each group without pulling the other back", async () => {
    const f = await fixture();
    const environment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "跨流程环境" } });
    const envId = environment.json().id as string;
    const first = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("流程甲", envId) });
    const second = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("流程乙", envId) });
    const firstId = first.json().id as string;
    const secondId = second.json().id as string;
    const isolated = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "连接甲流程",
        targets: [{ type: "ssh_connection", id: firstId }],
        nodes: [{ id: randomUUID(), name: "审批", mode: "any", approverUserIds: [f.approverId], approverRoleId: null, allowSelf: false, requireComment: false }],
      },
    });
    expect(isolated.statusCode, isolated.body).toBe(201);
    const mixed = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features: { mcp: true, agent: false, webPlugins: false }, targets: [{ type: "environment", id: envId }], reason: "环境跨流程" },
    });
    expect(mixed.statusCode, mixed.body).toBe(409);
    expect(mixed.json().error).toBe("MULTIPLE_APPROVAL_FLOWS");
    const groups = mixed.json().groups as Array<{ flowId: string; flowName: string; targets: Array<{ type: string; id: string }> }>;
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.flowName).sort()).toEqual(["所有连接", "连接甲流程"]);
    const created: string[] = [];
    const targetKey = (target: { type: string; id: string }) => `${target.type}:${target.id}`;
    for (const group of groups) {
      const response = await f.app.inject({
        method: "POST",
        url: f.base + "/grant-requests",
        cookies: f.cookies,
        payload: {
          kind: "feature",
          features: { mcp: true, agent: false, webPlugins: false },
          targets: group.targets,
          flowId: group.flowId,
          reason: group.flowName,
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      created.push(response.json().id as string);
      const saved = JSON.parse((await f.db.prepare("SELECT targets_json FROM organization_grant_requests WHERE id = ?").get<{ targets_json: string }>(response.json().id))!.targets_json) as Array<{ type: string; id: string }>;
      const hasConnection = (id: string) => saved.some((target) => target.type === "ssh_connection" && target.id === id);
      expect(hasConnection(firstId) && hasConnection(secondId)).toBe(false);
      expect(saved.map(targetKey).sort()).toEqual(group.targets.map(targetKey).sort());
    }
    const later = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("批准前新增", envId) });
    for (const id of created) {
      const approved = await f.app.inject({
        method: "POST",
        url: `${f.base}/grant-requests/${id}/decision`,
        cookies: f.approverCookies,
        payload: { decision: "approve", comment: "同意" },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      const grant = JSON.parse((await f.db.prepare("SELECT targets_json FROM organization_feature_grants WHERE request_id = ?").get<{ targets_json: string }>(id))!.targets_json) as Array<{ id: string }>;
      expect(grant.some((target) => target.id === later.json().id)).toBe(false);
    }
  });

  it("submits an environment-only default group by flowId without re-expanding", async () => {
    const f = await fixture();
    const environment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "仅环境默认组" } });
    const envId = environment.json().id as string;
    const ssh = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("全部归指定流程", envId) });
    const sshId = ssh.json().id as string;
    const node = { id: randomUUID(), name: "审批", mode: "any", approverUserIds: [f.approverId], approverRoleId: null, allowSelf: false, requireComment: false };
    const owned = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "全部关联资源流程",
        targets: [
          { type: "ssh_connection", id: sshId },
          { type: "monitor_host", id: sshId },
        ],
        nodes: [node],
      },
    });
    expect(owned.statusCode, owned.body).toBe(201);
    const grouped = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features: { mcp: true, agent: false, webPlugins: false }, targets: [{ type: "environment", id: envId }], reason: "环境单独成组" },
    });
    expect(grouped.statusCode, grouped.body).toBe(409);
    const groups = grouped.json().groups as Array<{ flowId: string; flowName: string; targets: Array<{ type: string; id: string }> }>;
    const environmentGroup = groups.find((group) => group.targets.length === 1 && group.targets[0].type === "environment");
    const ownedGroup = groups.find((group) => group.flowId === owned.json().id);
    expect(environmentGroup?.flowName).toBe("所有连接");
    expect(ownedGroup).toBeTruthy();
    const features = { mcp: true, agent: false, webPlugins: false };
    const withoutFlow = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features, targets: environmentGroup!.targets, reason: "未声明分组仍是初次选择" },
    });
    expect(withoutFlow.statusCode, withoutFlow.body).toBe(409);
    expect(withoutFlow.json().error).toBe("MULTIPLE_APPROVAL_FLOWS");
    const mismatched = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features, targets: environmentGroup!.targets, flowId: owned.json().id, reason: "目标不属于该流程" },
    });
    expect(mismatched.statusCode, mismatched.body).toBe(409);
    expect(mismatched.json().error).toBe("APPROVAL_FLOW_MISMATCH");
    const submitted = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: { kind: "feature", features, targets: environmentGroup!.targets, flowId: environmentGroup!.flowId, reason: "按默认组提交" },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const saved = JSON.parse((await f.db.prepare("SELECT targets_json FROM organization_grant_requests WHERE id = ?").get<{ targets_json: string }>(submitted.json().id))!.targets_json) as Array<{ type: string; id: string }>;
    expect(saved).toEqual(environmentGroup!.targets);
    expect(saved.some((target) => target.id === sshId && target.type !== "environment")).toBe(false);
    const approved = await f.app.inject({
      method: "POST",
      url: `${f.base}/grant-requests/${submitted.json().id}/decision`,
      cookies: f.approverCookies,
      payload: { decision: "approve", comment: "同意" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const grant = JSON.parse((await f.db.prepare("SELECT targets_json FROM organization_feature_grants WHERE request_id = ?").get<{ targets_json: string }>(submitted.json().id))!.targets_json) as Array<{ type: string; id: string }>;
    expect(grant).toEqual(environmentGroup!.targets);
  });

  it("submits web plugins only on the environment group and mcp or agent on the connection group", async () => {
    const f = await fixture();
    const environment = await f.app.inject({ method: "POST", url: "/api/v1/environments", cookies: f.cookies, payload: { name: "插件分组环境" } });
    const envId = environment.json().id as string;
    const ssh = await f.app.inject({ method: "POST", url: "/api/v1/ssh-connections", cookies: f.cookies, payload: connection("插件分组连接", envId) });
    const sshId = ssh.json().id as string;
    const node = { id: randomUUID(), name: "审批", mode: "any", approverUserIds: [f.approverId], approverRoleId: null, allowSelf: false, requireComment: false };
    const owned = await f.app.inject({
      method: "POST",
      url: f.base + "/approval-flows",
      cookies: f.cookies,
      payload: {
        name: "连接组流程",
        targets: [
          { type: "ssh_connection", id: sshId },
          { type: "monitor_host", id: sshId },
        ],
        nodes: [node],
      },
    });
    expect(owned.statusCode, owned.body).toBe(201);
    const grouped = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: {
        kind: "feature",
        features: { mcp: true, agent: true, webPlugins: true },
        targets: [{ type: "environment", id: envId }],
        reason: "混合功能初次选择",
      },
    });
    expect(grouped.statusCode, grouped.body).toBe(409);
    expect(grouped.json().error).toBe("MULTIPLE_APPROVAL_FLOWS");
    const groups = grouped.json().groups as Array<{ flowId: string; flowName: string; targets: Array<{ type: string; id: string }> }>;
    const environmentGroup = groups.find((group) => group.targets.some((target) => target.type === "environment"));
    const connectionGroup = groups.find((group) => group.flowId === owned.json().id);
    expect(environmentGroup?.targets).toEqual([{ type: "environment", id: envId }]);
    expect(connectionGroup?.targets.every((target) => target.type !== "environment")).toBe(true);
    expect(connectionGroup?.targets).toEqual(expect.arrayContaining([{ type: "ssh_connection", id: sshId }]));
    const pluginOnConnection = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: {
        kind: "feature",
        features: { mcp: true, agent: true, webPlugins: true },
        targets: connectionGroup!.targets,
        flowId: connectionGroup!.flowId,
        reason: "连接组不能带插件",
      },
    });
    expect(pluginOnConnection.statusCode, pluginOnConnection.body).toBe(400);
    expect(pluginOnConnection.json().error).toBe("INVALID_PLUGIN_SCOPE");
    const connectionOnly = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: {
        kind: "feature",
        features: { mcp: true, agent: true, webPlugins: false },
        targets: connectionGroup!.targets,
        flowId: connectionGroup!.flowId,
        reason: "连接组只提交 MCP 和 Agent",
      },
    });
    expect(connectionOnly.statusCode, connectionOnly.body).toBe(201);
    const savedConnections = JSON.parse((await f.db.prepare("SELECT targets_json FROM organization_grant_requests WHERE id = ?").get<{ targets_json: string }>(connectionOnly.json().id))!.targets_json) as Array<{ type: string; id: string }>;
    expect(savedConnections).toEqual(connectionGroup!.targets);
    expect(savedConnections.some((target) => target.type === "environment")).toBe(false);
    const pluginsOnly = await f.app.inject({
      method: "POST",
      url: f.base + "/grant-requests",
      cookies: f.cookies,
      payload: {
        kind: "feature",
        features: { mcp: false, agent: false, webPlugins: true },
        targets: environmentGroup!.targets,
        flowId: environmentGroup!.flowId,
        reason: "环境组只提交 Web 插件",
      },
    });
    expect(pluginsOnly.statusCode, pluginsOnly.body).toBe(201);
    const savedEnvironment = await f.db.prepare("SELECT targets_json, permission_snapshot_json FROM organization_grant_requests WHERE id = ?").get<{ targets_json: string; permission_snapshot_json: string }>(pluginsOnly.json().id);
    expect(JSON.parse(savedEnvironment!.targets_json)).toEqual(environmentGroup!.targets);
    expect(JSON.parse(savedEnvironment!.permission_snapshot_json).features).toEqual({ mcp: false, agent: false, webPlugins: true });
  });
});
