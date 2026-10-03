import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { backfillAccessGovernance, recordExpiredAccess } from "../src/server/access-governance-events.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "viron-governance-"));
  const config: AppConfig = { nodeEnv: "test", host: "127.0.0.1", port: 0, dataDir: directory, databasePath: join(directory, "test.db"),
    masterKey: Buffer.alloc(32, 19), adminUsername: "admin", adminPassword: "test-password-123", allowWeakPasswords: true,
    sessionTtlHours: 12, terminalIdleMinutes: 30, auditRetentionDays: 30 };
  const db = await openDatabase(config);
  await ensureAdmin(db, config);
  const app = await buildApp({ config, db, logger: false });
  cleanup.push(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  async function login(username: string, password: string) {
    const result = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
    expect(result.statusCode).toBe(200);
    return { id: result.json().user.id as string, cookies: { envman_session: result.cookies.find((cookie) => cookie.name === "envman_session")!.value } };
  }
  const admin = await login("admin", config.adminPassword);
  const orgResult = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies: admin.cookies, payload: { name: "示例企业" } });
  const org = orgResult.json().id as string;
  const base = `/api/v1/organizations/${org}`;
  async function switchOrg(user: typeof admin, id = org) {
    expect((await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: user.cookies, payload: { type: "organization", id } })).statusCode).toBe(200);
  }
  await switchOrg(admin);
  async function member(username: string) {
    const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username, password: username } });
    expect(registered.statusCode).toBe(201);
    const user = await login(username, username);
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'member', ?, ?)").run(org, user.id, now, now);
    await switchOrg(user);
    return user;
  }
  const requester = await member("requester");
  const reviewer = await member("reviewer");
  const outsider = await member("outsider");
  const envResult = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: admin.cookies, payload: { name: "示例生产环境", groupId: null } });
  expect(envResult.statusCode).toBe(201);
  const environmentId = envResult.json().id as string;
  const draft = { granteeType: "user", granteeId: requester.id, scopeKind: "environment", targetIds: [environmentId], permissions: { web: ["view"] }, reason: "发布检查", expiresAt: null };
  const configure = (stages: Array<{ name: string; approverIds: string[]; mode?: string }>) => app.inject({ method: "PUT", url: `${base}/approval-workflow`, cookies: admin.cookies, payload: { name: "资源授权审批", stages } });
  const submit = (changes: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `${base}/access-requests`, cookies: requester.cookies, payload: { ...draft, ...changes } });
  const decide = (id: string, user: typeof admin, decision = "approve") => app.inject({ method: "POST", url: `${base}/access-requests/${id}/decisions`, cookies: user.cookies, payload: { decision, reason: "业务需要已核实" } });
  return { app, db, admin, requester, reviewer, outsider, org, base, environmentId, draft, configure, submit, decide, switchOrg };
}

describe("enterprise authorization governance", () => {
  it("runs sequential any/all stages, allows assigned self approval, and creates exactly one grant at the final decision", async () => {
    const f = await fixture();
    expect((await f.configure([{ name: "本人确认", approverIds: [f.requester.id] }, { name: "联合审批", mode: "all", approverIds: [f.admin.id, f.reviewer.id] }])).statusCode).toBe(200);
    const submitted = await f.submit();
    expect(submitted.statusCode).toBe(201);
    const id = submitted.json().id as string;
    expect((await f.submit()).statusCode).toBe(409);
    expect((await f.decide(id, f.admin)).statusCode).toBe(403);
    expect((await f.decide(id, f.outsider)).statusCode).toBe(403);
    expect((await f.app.inject({ method: "GET", url: `/api/v1/environments/${f.environmentId}`, cookies: f.requester.cookies })).statusCode).toBe(404);
    expect((await f.decide(id, f.requester)).statusCode).toBe(200);
    expect((await f.decide(id, f.requester)).statusCode).toBe(403);
    expect((await f.decide(id, f.admin)).statusCode).toBe(200);
    expect((await f.app.inject({ method: "GET", url: `/api/v1/environments/${f.environmentId}`, cookies: f.requester.cookies })).statusCode).toBe(404);
    const concurrent = await Promise.all([f.decide(id, f.reviewer), f.decide(id, f.reviewer)]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await f.app.inject({ method: "GET", url: `/api/v1/environments/${f.environmentId}`, cookies: f.requester.cookies })).statusCode).toBe(200);
    const detail = (await f.app.inject({ method: "GET", url: `${f.base}/access-requests/${id}`, cookies: f.requester.cookies })).json();
    expect(detail.item).toMatchObject({ status: "approved", stageIndex: 2, canApprove: false, canWithdraw: false });
    expect(detail.item.grantId).toBeTruthy();
    expect((await f.app.inject({ method: "GET", url: `${f.base}/access-history?grantId=${detail.item.grantId}`, cookies: f.admin.cookies })).json().items).toHaveLength(5);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/access-requests?view=reviewed`, cookies: f.reviewer.cookies })).json().items).toEqual([expect.objectContaining({ id, status: "approved" })]);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/access-requests?view=todo`, cookies: f.reviewer.cookies })).json().items).toEqual([]);
    expect(detail.events.map((event: { action: string }) => event.action).sort()).toEqual(["approved", "approved", "approved", "granted", "requested"]);
    expect(detail.events.find((event: { action: string; actorId: string }) => event.action === "approved" && event.actorId === f.requester.id)).toMatchObject({ details: { selfApproved: true, stageName: "本人确认" }, reason: "业务需要已核实" });
    expect((await f.db.prepare("SELECT COUNT(*) AS count FROM access_authorizations").get<{ count: number }>())!.count).toBe(1);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/access-requests/${id}`, cookies: f.outsider.cookies })).statusCode).toBe(404);
  });

  it("freezes workflows per request, records rejection and withdrawal, and restricts configuration and request targets", async () => {
    const f = await fixture();
    expect((await f.submit()).json().error).toBe("WORKFLOW_REQUIRED");
    expect((await f.configure([{ name: "原流程", approverIds: [f.reviewer.id] }])).statusCode).toBe(200);
    const submitted = await f.submit(); const id = submitted.json().id;
    expect((await f.configure([{ name: "新流程", approverIds: [f.admin.id] }])).statusCode).toBe(200);
    expect((await f.decide(id, f.admin)).statusCode).toBe(403);
    expect((await f.decide(id, f.reviewer, "reject")).statusCode).toBe(200);
    expect((await f.decide(id, f.reviewer)).statusCode).toBe(409);
    const second = await f.submit(); expect(second.statusCode).toBe(201);
    const withdrawUrl = `${f.base}/access-requests/${second.json().id}/withdraw`;
    expect((await f.app.inject({ method: "POST", url: withdrawUrl, cookies: f.outsider.cookies, payload: { reason: "他人撤回" } })).statusCode).toBe(409);
    expect((await f.app.inject({ method: "POST", url: withdrawUrl, cookies: f.requester.cookies, payload: { reason: "任务取消" } })).statusCode).toBe(200);
    expect((await f.submit({ granteeId: f.outsider.id })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "PUT", url: `${f.base}/approval-workflow`, cookies: f.requester.cookies, payload: { name: "越权", stages: [{ name: "节点", approverIds: [f.requester.id] }] } })).statusCode).toBe(403);
    const history = (await f.app.inject({ method: "GET", url: `${f.base}/access-history`, cookies: f.admin.cookies })).json().items;
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ action: "rejected" }), expect.objectContaining({ action: "withdrawn", reason: "任务取消" })]));
    expect((await f.app.inject({ method: "GET", url: `${f.base}/access-history`, cookies: f.requester.cookies })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/access-requests?view=all`, cookies: f.requester.cookies })).statusCode).toBe(403);
    expect((await f.db.prepare("SELECT COUNT(*) AS count FROM access_authorizations").get<{ count: number }>())!.count).toBe(0);
  });

  it("rolls back the final decision when a resource or grant deadline is no longer valid", async () => {
    const f = await fixture();
    await f.configure([{ name: "终审", approverIds: [f.admin.id] }]);
    const submitted = await f.submit({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const id = submitted.json().id;
    const row = (await f.db.prepare("SELECT authorization_json FROM access_requests WHERE id = ?").get<{ authorization_json: string }>(id))!;
    await f.db.prepare("UPDATE access_requests SET authorization_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.authorization_json), expiresAt: "2000-01-01T00:00:00.000Z" }), id);
    expect((await f.decide(id, f.admin)).json().error).toBe("INVALID_EXPIRY");
    const detail = (await f.app.inject({ method: "GET", url: `${f.base}/access-requests/${id}`, cookies: f.admin.cookies })).json();
    expect(detail.item).toMatchObject({ status: "pending", stageIndex: 0, grantId: null });
    expect(detail.events).toHaveLength(1);
    const second = await f.submit(); const secondId = second.json().id;
    await f.db.prepare("DELETE FROM environments WHERE id = ?").run(f.environmentId);
    expect((await f.decide(secondId, f.admin)).json().error).toBe("INVALID_RESOURCE");
    expect((await f.db.prepare("SELECT COUNT(*) AS count FROM access_authorizations").get<{ count: number }>())!.count).toBe(0);
  });

  it("keeps complete direct grant snapshots after modifications, revocation, account removal and general audit cleanup", async () => {
    const f = await fixture();
    const grant = await f.app.inject({ method: "POST", url: `${f.base}/grants`, cookies: f.admin.cookies, payload: f.draft });
    expect(grant.statusCode).toBe(201); const grantId = grant.json().id;
    expect((await f.app.inject({ method: "PUT", url: `${f.base}/grants/${grantId}`, cookies: f.admin.cookies, payload: { ...f.draft, permissions: { web: ["manage"] }, reason: "提升维护权限" } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/grants/${grantId}`, cookies: f.admin.cookies, payload: { reason: "维护完成" } })).statusCode).toBe(204);
    await f.db.prepare("DELETE FROM audit_events").run();
    await f.app.inject({ method: "DELETE", url: `${f.base}/members/${f.requester.id}`, cookies: f.admin.cookies });
    const ledger = (await f.app.inject({ method: "GET", url: `${f.base}/access-history?grantId=${grantId}`, cookies: f.admin.cookies })).json().items;
    expect(ledger).toHaveLength(3);
    expect(ledger.find((event: { action: string }) => event.action === "updated")).toMatchObject({ reason: "提升维护权限", before: { permissions: { web: ["view"] }, granteeName: "requester", label: "示例生产环境" }, after: { permissions: { web: ["view", "use", "manage"] } } });
    expect(ledger.find((event: { action: string }) => event.action === "revoked")).toMatchObject({ reason: "维护完成", before: { granteeName: "requester", targetIds: [f.environmentId] }, after: null });
    const secondOrg = await f.app.inject({ method: "POST", url: "/api/v1/organizations", cookies: f.admin.cookies, payload: { name: "另一企业" } });
    await f.switchOrg(f.admin, secondOrg.json().id);
    expect((await f.app.inject({ method: "GET", url: `${f.base}/access-history`, cookies: f.admin.cookies })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "GET", url: `/api/v1/organizations/${secondOrg.json().id}/access-history?grantId=${grantId}`, cookies: f.admin.cookies })).json().items).toEqual([]);
  });

  it("retains named snapshots when deleting authorized resources and rejects empty reasons and foreign approvers", async () => {
    const f = await fixture();
    expect((await f.submit({ reason: " " })).statusCode).toBe(400);
    expect((await f.configure([{ name: "无效", approverIds: ["00000000-0000-4000-8000-000000000001"] }])).json().error).toBe("INVALID_APPROVERS");
    const grant = await f.app.inject({ method: "POST", url: `${f.base}/grants`, cookies: f.admin.cookies, payload: f.draft });
    expect((await f.app.inject({ method: "DELETE", url: `/api/v1/environments/${f.environmentId}`, cookies: f.admin.cookies })).statusCode).toBe(204);
    const history = (await f.app.inject({ method: "GET", url: `${f.base}/access-history?grantId=${grant.json().id}`, cookies: f.admin.cookies })).json().items;
    expect(history.find((event: { action: string }) => event.action === "revoked")).toMatchObject({ reason: "授权资源被删除", before: { label: "示例生产环境", targetIds: [f.environmentId] }, after: null });
    expect((await f.db.prepare("SELECT COUNT(*) AS count FROM access_authorizations").get<{ count: number }>())!.count).toBe(0);
  });

  it("provides a safe request catalog, records baseline and expiry once, and retains legacy revocations", async () => {
    const f = await fixture();
    const catalog = await f.app.inject({ method: "GET", url: `${f.base}/access-request-catalog`, cookies: f.requester.cookies });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().environments).toEqual([expect.objectContaining({ id: f.environmentId, name: "示例生产环境" })]);
    const legacy = await f.app.inject({ method: "POST", url: `${f.base}/grants`, cookies: f.admin.cookies, payload: { granteeType: "user", granteeId: f.requester.id, resourceType: "environment", resourceId: f.environmentId } });
    expect(legacy.statusCode).toBe(201);
    const id = legacy.json().id;
    await f.db.prepare("DELETE FROM access_governance_events WHERE grant_id = ?").run(id);
    await backfillAccessGovernance(f.db); await backfillAccessGovernance(f.db);
    const initial = (await f.app.inject({ method: "GET", url: `${f.base}/access-history?grantId=${id}`, cookies: f.admin.cookies })).json().items;
    expect(initial).toHaveLength(1); expect(initial[0]).toMatchObject({ action: "imported", details: { baseline: true } });
    expect((await f.app.inject({ method: "DELETE", url: `${f.base}/grants/${id}`, cookies: f.admin.cookies })).statusCode).toBe(204);
    const fine = await f.app.inject({ method: "POST", url: `${f.base}/grants`, cookies: f.admin.cookies, payload: { ...f.draft, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    await f.db.prepare("UPDATE access_authorizations SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", fine.json().id);
    await recordExpiredAccess(f.db); await recordExpiredAccess(f.db);
    expect((await f.db.prepare("SELECT COUNT(*) AS count FROM access_governance_events WHERE action = 'expired'").get<{ count: number }>())!.count).toBe(1);
  });
});
