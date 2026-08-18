import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 19),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value };
}

async function createInvitation(
  app: Awaited<ReturnType<typeof buildApp>>,
  organizationId: string,
  cookies: { envman_session: string },
  expiresInHours: 1 | 24 | 168 | 720 = 24,
  maxUses: number | null = 1,
  projectId: string | null = null,
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/invitations`,
    cookies,
    payload: { expiresInHours, maxUses, projectId },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; token: string; expiresAt: string; maxUses: number | null; usedCount: number };
}

async function registerUser(app: Awaited<ReturnType<typeof buildApp>>, username: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username, password: username } });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id as string,
    cookies: { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value },
  };
}

async function acceptInvitation(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  cookies: { envman_session: string },
) {
  return await app.inject({
    method: "POST",
    url: `/api/v1/organization-invitations/${token}/accept`,
    cookies,
  });
}

describe("multi-user workspaces", () => {
  it("enforces the configured platform password policy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-password-policy-"));
    directories.push(directory);
    const config = { ...configFor(directory), allowWeakPasswords: false };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const admin = await login(app, "admin", config.adminPassword);

    const weakRegistration = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username: "weak-user", password: "123123" },
    });
    expect(weakRegistration.statusCode).toBe(400);
    expect(weakRegistration.json().error).toBe("WEAK_PASSWORD");

    const strongRegistration = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username: "strong-user", password: "Strong-pass-123" },
    });
    expect(strongRegistration.statusCode).toBe(201);
    const strongUserId = strongRegistration.json().user.id as string;

    const weakChange = await app.inject({
      method: "PUT", url: "/api/v1/auth/password",
      cookies: { envman_session: strongRegistration.cookies.find((item) => item.name === "envman_session")!.value },
      payload: { currentPassword: "Strong-pass-123", newPassword: "123123" },
    });
    expect(weakChange.statusCode).toBe(400);
    expect(weakChange.json().error).toBe("WEAK_PASSWORD");

    const weakCreation = await app.inject({
      method: "POST", url: "/api/v1/users", cookies: admin,
      payload: { username: "another-user", password: "123123", isPlatformAdmin: false },
    });
    expect(weakCreation.statusCode).toBe(400);
    expect(weakCreation.json().error).toBe("WEAK_PASSWORD");

    const weakReset = await app.inject({
      method: "PUT", url: `/api/v1/users/${strongUserId}/password`, cookies: admin,
      payload: { password: "123123" },
    });
    expect(weakReset.statusCode).toBe(400);
    expect(weakReset.json().error).toBe("WEAK_PASSWORD");

    await app.close();
  });

  it("upgrades legacy global group uniqueness without breaking foreign keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-legacy-workspaces-"));
    directories.push(directory);
    const config = configFor(directory);
    const raw = new Database(config.databasePath);
    const now = new Date().toISOString();
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE admin_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE environment_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#1d8a74', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE environments (id TEXT PRIMARY KEY, group_id TEXT REFERENCES environment_groups(id) ON DELETE SET NULL, name TEXT NOT NULL, short_name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', owner TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE connection_groups (id TEXT PRIMARY KEY, type TEXT NOT NULL, parent_id TEXT REFERENCES connection_groups(id) ON DELETE CASCADE, name TEXT NOT NULL, path TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(type, path));
    `);
    await raw.prepare("INSERT INTO environment_groups (id, name, created_at, updated_at) VALUES ('group-1', 'Production', ?, ?)").run(now, now);
    await raw.prepare("INSERT INTO environments (id, group_id, name, created_at, updated_at) VALUES ('environment-1', 'group-1', 'Legacy', ?, ?)").run(now, now);
    await raw.prepare("INSERT INTO connection_groups (id, type, name, path, created_at, updated_at) VALUES ('connection-group-1', 'ssh', 'Production', 'Production', ?, ?)").run(now, now);
    raw.close();

    const upgraded = await openDatabase(config);
    expect(await upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await upgraded.prepare("INSERT INTO environment_groups (id, workspace_type, workspace_id, name, created_at, updated_at) VALUES ('group-2', 'organization', 'organization-1', 'Production', ?, ?)").run(now, now);
    await upgraded.prepare("INSERT INTO connection_groups (id, workspace_type, workspace_id, type, name, path, created_at, updated_at) VALUES ('connection-group-2', 'organization', 'organization-1', 'ssh', 'Production', 'Production', ?, ?)").run(now, now);
    expect((await upgraded.prepare("SELECT group_id FROM environments WHERE id = 'environment-1'").get() as { group_id: string }).group_id).toBe("group-1");
    await upgraded.close();
  });

  it("adds environment favorites to existing preferences without losing aliases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-environment-favorite-migration-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const administrator = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO environments (id, workspace_type, workspace_id, name, created_at, updated_at)
      VALUES ('legacy-environment', 'personal', ?, 'Legacy environment', ?, ?)
    `).run(administrator.id, now, now);
    await db.prepare(`
      INSERT INTO environment_preferences (owner_user_id, environment_id, alias_name, updated_at)
      VALUES (?, 'legacy-environment', 'Legacy alias', ?)
    `).run(administrator.id, now);
    await db.close();

    const legacy = new Database(config.databasePath);
    legacy.exec("ALTER TABLE environment_preferences DROP COLUMN is_favorite");
    legacy.close();

    const migrated = await openDatabase(config);
    expect(await migrated.prepare("SELECT alias_name, is_favorite FROM environment_preferences WHERE environment_id = 'legacy-environment'").get()).toEqual({
      alias_name: "Legacy alias",
      is_favorite: 0,
    });
    await migrated.close();
  });

  it("enforces invitation expiry and usage limits while recording who invited each member", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-organization-invitations-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const alice = await registerUser(app, "alice");
    const createdOrganization = await app.inject({
      method: "POST", url: "/api/v1/organizations", cookies: alice.cookies,
      payload: { name: "Delivery", description: "Delivery team" },
    });
    const organizationId = createdOrganization.json().id as string;
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice.cookies, payload: { type: "organization", id: organizationId } });

    const bob = await registerUser(app, "bob");
    const charlie = await registerUser(app, "charlie");
    const dana = await registerUser(app, "dana");
    const erin = await registerUser(app, "erin");
    const frank = await registerUser(app, "frank");
    const grace = await registerUser(app, "grace");
    const henry = await registerUser(app, "henry");
    const irene = await registerUser(app, "irene");
    const invitation = await createInvitation(app, organizationId, alice.cookies, 24, 3);
    expect(invitation.token).toHaveLength(43);
    expect(invitation.maxUses).toBe(3);
    expect(invitation.usedCount).toBe(0);
    expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const storedInvitation = await app.db.prepare("SELECT token_hash FROM organization_invitations").get() as { token_hash: string };
    expect(storedInvitation.token_hash).toHaveLength(64);
    expect(storedInvitation.token_hash).not.toBe(invitation.token);
    const storedPolicy = await app.db.prepare(`
      SELECT token_ciphertext, max_uses, used_count
      FROM organization_invitation_policies WHERE invitation_id = ?
    `).get(invitation.id) as { token_ciphertext: string; max_uses: number; used_count: number };
    expect(storedPolicy.token_ciphertext).not.toContain(invitation.token);
    expect(storedPolicy.max_uses).toBe(3);
    expect(storedPolicy.used_count).toBe(0);

    const preview = await app.inject({
      method: "GET", url: `/api/v1/organization-invitations/${invitation.token}`, cookies: bob.cookies,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      inviter: { username: "alice" },
      organization: { id: organizationId, name: "Delivery", description: "Delivery team" },
      maxUses: 3,
      usedCount: 0,
      remainingUses: 3,
      alreadyMember: false,
    });

    const accepted = await acceptInvitation(app, invitation.token, bob.cookies);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ organization: { id: organizationId, name: "Delivery" }, role: "member" });
    const membership = await app.db.prepare(
      `SELECT m.role, mi.invitation_id, mi.invited_by_user_id
       FROM organization_members m
       LEFT JOIN organization_member_invitations mi
         ON mi.organization_id = m.organization_id AND mi.user_id = m.user_id
       WHERE m.organization_id = ? AND m.user_id = ?`,
    ).get(organizationId, bob.id) as { role: string; invitation_id: string; invited_by_user_id: string };
    expect(membership.role).toBe("member");
    expect(membership.invitation_id).toBe(invitation.id);
    expect(membership.invited_by_user_id).toBe(alice.id);
    expect(await app.db.prepare(`
      SELECT invitation_id, user_id, joined_organization, joined_project
      FROM organization_invitation_acceptances WHERE invitation_id = ? AND user_id = ?
    `).get(invitation.id, bob.id)).toEqual({
      invitation_id: invitation.id,
      user_id: bob.id,
      joined_organization: 1,
      joined_project: 0,
    });
    const detailAfterAcceptance = await app.inject({
      method: "GET", url: `/api/v1/organizations/${organizationId}`, cookies: alice.cookies,
    });
    expect(detailAfterAcceptance.json().members.find((member: { id: string }) => member.id === bob.id)).toMatchObject({
      invitedBy: { id: alice.id, username: "alice" },
    });

    const remainingPreview = await app.inject({
      method: "GET", url: `/api/v1/organization-invitations/${invitation.token}`, cookies: charlie.cookies,
    });
    expect(remainingPreview.json()).toMatchObject({ usedCount: 1, remainingUses: 2 });
    const memberPreview = await app.inject({
      method: "GET", url: `/api/v1/organization-invitations/${invitation.token}`, cookies: bob.cookies,
    });
    expect(memberPreview.statusCode).toBe(200);
    expect(memberPreview.json().alreadyMember).toBe(true);

    expect((await acceptInvitation(app, invitation.token, charlie.cookies)).statusCode).toBe(201);
    expect((await acceptInvitation(app, invitation.token, dana.cookies)).statusCode).toBe(201);
    const exhausted = await acceptInvitation(app, invitation.token, grace.cookies);
    expect(exhausted.statusCode).toBe(410);
    expect(exhausted.json().error).toBe("INVITATION_EXHAUSTED");

    const invitationList = await app.inject({
      method: "GET", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: alice.cookies,
    });
    expect(invitationList.statusCode).toBe(200);
    expect(invitationList.json().items[0]).toMatchObject({
      id: invitation.id,
      token: invitation.token,
      createdBy: { id: alice.id, username: "alice" },
      maxUses: 3,
      usedCount: 3,
      remainingUses: 0,
      status: "exhausted",
    });
    expect(invitationList.json().items[0].acceptedUsers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: bob.id, username: "bob", joinedOrganization: true, joinedProject: false }),
      expect.objectContaining({ id: charlie.id, username: "charlie", joinedOrganization: true, joinedProject: false }),
      expect.objectContaining({ id: dana.id, username: "dana", joinedOrganization: true, joinedProject: false }),
    ]));

    const extraInvitation = await createInvitation(app, organizationId, alice.cookies, 1, 3);
    const alreadyMember = await acceptInvitation(app, extraInvitation.token, bob.cookies);
    expect(alreadyMember.statusCode).toBe(409);
    expect(alreadyMember.json().error).toBe("MEMBER_EXISTS");
    expect((await app.db.prepare(
      "SELECT used_count FROM organization_invitation_policies WHERE invitation_id = ?",
    ).get(extraInvitation.id) as { used_count: number }).used_count).toBe(0);

    const concurrentInvitation = await createInvitation(app, organizationId, alice.cookies, 24, 1);
    const concurrentResults = await Promise.all([
      acceptInvitation(app, concurrentInvitation.token, erin.cookies),
      acceptInvitation(app, concurrentInvitation.token, frank.cookies),
    ]);
    expect(concurrentResults.map((response) => response.statusCode).sort()).toEqual([201, 410]);
    expect(concurrentResults.find((response) => response.statusCode === 410)!.json().error).toBe("INVITATION_EXHAUSTED");
    expect((await app.db.prepare(
      "SELECT used_count FROM organization_invitation_policies WHERE invitation_id = ?",
    ).get(concurrentInvitation.id) as { used_count: number }).used_count).toBe(1);

    const expiredInvitation = await createInvitation(app, organizationId, alice.cookies, 1, 5);
    await app.db.prepare("UPDATE organization_invitations SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), expiredInvitation.id);
    const expired = await acceptInvitation(app, expiredInvitation.token, grace.cookies);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error).toBe("INVITATION_EXPIRED");

    const unlimitedInvitation = await createInvitation(app, organizationId, alice.cookies, 720, null);
    const revoked = await app.inject({
      method: "DELETE", url: `/api/v1/organizations/${organizationId}/invitations/${unlimitedInvitation.id}`, cookies: alice.cookies,
    });
    expect(revoked.statusCode).toBe(204);
    const revokedAcceptance = await acceptInvitation(app, unlimitedInvitation.token, grace.cookies);
    expect(revokedAcceptance.statusCode).toBe(410);
    expect(revokedAcceptance.json().error).toBe("INVITATION_REVOKED");
    const listAfterRevocation = await app.inject({
      method: "GET", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: alice.cookies,
    });
    expect(listAfterRevocation.json().items.find((item: { id: string }) => item.id === unlimitedInvitation.id)).toMatchObject({
      maxUses: null,
      remainingUses: null,
      status: "revoked",
    });

    const deletableInvitation = await createInvitation(app, organizationId, alice.cookies, 24, 2);
    expect((await acceptInvitation(app, deletableInvitation.token, henry.cookies)).statusCode).toBe(201);
    const deletedRecord = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/invitations/${deletableInvitation.id}/record`,
      cookies: alice.cookies,
    });
    expect(deletedRecord.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: alice.cookies,
    })).json().items.some((item: { id: string }) => item.id === deletableInvitation.id)).toBe(false);
    const deletedAcceptance = await acceptInvitation(app, deletableInvitation.token, irene.cookies);
    expect(deletedAcceptance.statusCode).toBe(410);
    expect(deletedAcceptance.json().error).toBe("INVITATION_REVOKED");
    expect(await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(organizationId, henry.id)).toBeTruthy();
    expect(await app.db.prepare("SELECT 1 FROM organization_invitation_acceptances WHERE invitation_id = ? AND user_id = ?").get(deletableInvitation.id, henry.id)).toBeTruthy();
    expect(await app.db.prepare(`
      SELECT token_ciphertext, revoked_at, deleted_at FROM organization_invitation_policies WHERE invitation_id = ?
    `).get(deletableInvitation.id)).toMatchObject({ token_ciphertext: null, revoked_at: expect.any(String), deleted_at: expect.any(String) });

    const legacyInvitation = await createInvitation(app, organizationId, alice.cookies, 24, 1);
    await app.db.prepare("DELETE FROM organization_invitation_policies WHERE invitation_id = ?").run(legacyInvitation.id);
    expect((await acceptInvitation(app, legacyInvitation.token, grace.cookies)).statusCode).toBe(201);
    const exhaustedLegacyInvitation = await acceptInvitation(app, legacyInvitation.token, irene.cookies);
    expect(exhaustedLegacyInvitation.statusCode).toBe(410);
    expect(exhaustedLegacyInvitation.json().error).toBe("INVITATION_EXHAUSTED");

    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: bob.cookies, payload: { type: "organization", id: organizationId } });
    const memberCannotListInvitations = await app.inject({
      method: "GET", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: bob.cookies,
    });
    expect(memberCannotListInvitations.statusCode).toBe(403);
    const memberCannotInvite = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: bob.cookies,
      payload: { expiresInHours: 24, maxUses: 1 },
    });
    expect(memberCannotInvite.statusCode).toBe(403);
    const memberCannotDeleteInvitationRecord = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/invitations/${expiredInvitation.id}/record`,
      cookies: bob.cookies,
    });
    expect(memberCannotDeleteInvitationRecord.statusCode).toBe(403);
    const invalidDuration = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: alice.cookies,
      payload: { expiresInHours: 2, maxUses: 1 },
    });
    expect(invalidDuration.statusCode).toBe(400);
    const invalidUsageLimit = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: alice.cookies,
      payload: { expiresInHours: 24, maxUses: 0 },
    });
    expect(invalidUsageLimit.statusCode).toBe(400);
    const removedDirectAdd = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/members`, cookies: alice.cookies,
      payload: { username: "grace", role: "member" },
    });
    expect(removedDirectAdd.statusCode).toBe(404);

    await app.db.prepare("DELETE FROM organization_invitation_acceptances WHERE invitation_id = ? AND user_id = ?").run(invitation.id, bob.id);
    await app.close();
    const reopened = await openDatabase(config);
    expect(await reopened.prepare(`
      SELECT joined_organization, joined_project FROM organization_invitation_acceptances
      WHERE invitation_id = ? AND user_id = ?
    `).get(invitation.id, bob.id)).toEqual({ joined_organization: 1, joined_project: 0 });
    await reopened.close();
  });

  it("builds nested project groups, inherits parent grants, and assigns invitation members", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-project-tree-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const alice = await registerUser(app, "tree-alice");
    const bob = await registerUser(app, "tree-bob");
    const charlie = await registerUser(app, "tree-charlie");
    const createdOrganization = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      cookies: alice.cookies,
      payload: { name: "Platform Engineering", description: "Nested delivery groups" },
    });
    const organizationId = createdOrganization.json().id as string;
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice.cookies, payload: { type: "organization", id: organizationId } });

    const parentProject = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/projects`,
      cookies: alice.cookies,
      payload: { name: "Infrastructure", description: "Shared infrastructure", parentId: null },
    });
    expect(parentProject.statusCode).toBe(201);
    const parentProjectId = parentProject.json().id as string;
    const childProject = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/projects`,
      cookies: alice.cookies,
      payload: { name: "Database", description: "Database operations", parentId: parentProjectId },
    });
    expect(childProject.statusCode).toBe(201);
    const childProjectId = childProject.json().id as string;

    const invitation = await createInvitation(app, organizationId, alice.cookies, 24, 3, childProjectId);
    const preview = await app.inject({ method: "GET", url: `/api/v1/organization-invitations/${invitation.token}`, cookies: bob.cookies });
    expect(preview.json()).toMatchObject({
      project: { id: childProjectId, name: "Database" },
      alreadyMember: false,
      alreadyProjectMember: false,
    });
    expect((await acceptInvitation(app, invitation.token, bob.cookies)).statusCode).toBe(201);
    expect(await app.db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(childProjectId, bob.id)).toBeTruthy();

    const generalInvitation = await createInvitation(app, organizationId, alice.cookies);
    expect((await acceptInvitation(app, generalInvitation.token, charlie.cookies)).statusCode).toBe(201);
    const projectInvitation = await createInvitation(app, organizationId, alice.cookies, 24, 2, childProjectId);
    const existingMemberPreview = await app.inject({ method: "GET", url: `/api/v1/organization-invitations/${projectInvitation.token}`, cookies: charlie.cookies });
    expect(existingMemberPreview.json()).toMatchObject({ alreadyMember: true, alreadyProjectMember: false });
    expect((await acceptInvitation(app, projectInvitation.token, charlie.cookies)).statusCode).toBe(201);
    expect(await app.db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(childProjectId, charlie.id)).toBeTruthy();

    const group = await app.inject({
      method: "POST",
      url: "/api/v1/environment-groups",
      cookies: alice.cookies,
      payload: { name: "Inherited Access", description: "", color: "#1d8a74" },
    });
    const environment = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      cookies: alice.cookies,
      payload: { groupId: group.json().id, name: "Inherited Environment", status: "active", tags: [] },
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/grants`,
      cookies: alice.cookies,
      payload: { granteeType: "project", granteeId: parentProjectId, resourceType: "environment_group", resourceId: group.json().id },
    })).statusCode).toBe(201);
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: bob.cookies, payload: { type: "organization", id: organizationId } });
    const inheritedEnvironments = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: bob.cookies });
    expect(inheritedEnvironments.json().items.map((item: { id: string }) => item.id)).toEqual([environment.json().id]);

    const detail = await app.inject({ method: "GET", url: `/api/v1/organizations/${organizationId}`, cookies: alice.cookies });
    expect(detail.json().projects.find((project: { id: string }) => project.id === childProjectId)).toMatchObject({ parentId: parentProjectId, memberCount: 2 });
    expect(detail.json().members.find((member: { id: string }) => member.id === bob.id).projectIds).toEqual([childProjectId]);
    const cycle = await app.inject({
      method: "PUT",
      url: `/api/v1/organizations/${organizationId}/projects/${parentProjectId}`,
      cookies: alice.cookies,
      payload: { name: "Infrastructure", description: "Shared infrastructure", parentId: childProjectId },
    });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error).toBe("PROJECT_CYCLE");

    const invitations = await app.inject({ method: "GET", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: alice.cookies });
    const newMemberInvitation = invitations.json().items.find((item: { id: string }) => item.id === invitation.id);
    expect(newMemberInvitation.project).toMatchObject({ id: childProjectId, name: "Database" });
    expect(newMemberInvitation.acceptedUsers).toEqual([
      expect.objectContaining({ id: bob.id, username: "tree-bob", joinedOrganization: true, joinedProject: true }),
    ]);
    const existingMemberInvitation = invitations.json().items.find((item: { id: string }) => item.id === projectInvitation.id);
    expect(existingMemberInvitation.acceptedUsers).toEqual([
      expect.objectContaining({ id: charlie.id, username: "tree-charlie", joinedOrganization: false, joinedProject: true }),
    ]);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/organizations/${organizationId}/projects/${parentProjectId}`, cookies: alice.cookies })).statusCode).toBe(204);
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE organization_id = ?").get(organizationId)).toEqual({ count: 0 });
    expect(await app.db.prepare("SELECT project_id FROM organization_invitation_policies WHERE invitation_id = ?").get(invitation.id)).toEqual({ project_id: null });

    await app.close();
  });

  it("creates organization resource grants atomically in batches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-batch-grants-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const alice = await registerUser(app, "batch-grant-alice");
    const bob = await registerUser(app, "batch-grant-bob");
    const organization = await app.inject({
      method: "POST", url: "/api/v1/organizations", cookies: alice.cookies,
      payload: { name: "Batch Grants", description: "Atomic grant creation" },
    });
    const organizationId = organization.json().id as string;
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice.cookies, payload: { type: "organization", id: organizationId } });
    const invitation = await createInvitation(app, organizationId, alice.cookies);
    expect((await acceptInvitation(app, invitation.token, bob.cookies)).statusCode).toBe(201);

    const environments = [];
    for (const name of ["Batch One", "Batch Two", "Batch Three"]) {
      const response = await app.inject({
        method: "POST", url: "/api/v1/environments", cookies: alice.cookies,
        payload: { name, status: "active", tags: [] },
      });
      expect(response.statusCode).toBe(201);
      environments.push(response.json().id as string);
    }

    const granted = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/grants`, cookies: alice.cookies,
      payload: { granteeType: "user", granteeId: bob.id, resourceType: "environment", resourceIds: environments.slice(0, 2) },
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json().id).toBe(granted.json().ids[0]);
    expect(granted.json().ids).toHaveLength(2);

    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: bob.cookies, payload: { type: "organization", id: organizationId } });
    const visible = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: bob.cookies });
    expect(visible.json().items.map((item: { id: string }) => item.id).sort()).toEqual(environments.slice(0, 2).sort());

    const conflicted = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/grants`, cookies: alice.cookies,
      payload: { granteeType: "user", granteeId: bob.id, resourceType: "environment", resourceIds: [environments[2], environments[0]] },
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json().error).toBe("GRANT_EXISTS");
    expect(await app.db.prepare("SELECT 1 FROM resource_grants WHERE organization_id = ? AND grantee_type = 'user' AND grantee_id = ? AND resource_id = ?").get(organizationId, bob.id, environments[2])).toBeUndefined();
    expect(await app.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'resource.granted'").get(organizationId)).toEqual({ count: 2 });

    await app.close();
  });

  it("isolates personal workspaces and applies direct organization grants", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-users-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const admin = await login(app, "admin", config.adminPassword);

    const privateEnvironment = await app.inject({
      method: "POST", url: "/api/v1/environments", cookies: admin,
      payload: { name: "Admin Private", status: "active", tags: [] },
    });
    expect(privateEnvironment.statusCode).toBe(201);
    const privateSsh = await app.inject({
      method: "POST", url: "/api/v1/ssh-connections", cookies: admin,
      payload: {
        environmentIds: [privateEnvironment.json().id],
        name: "Admin Private SSH",
        host: "private.internal",
        port: 22,
        username: "root",
        authType: "password",
        credential: { password: "private-secret" },
      },
    });
    expect(privateSsh.statusCode).toBe(201);

    const registration = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username: "alice", password: "a" },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().user).toMatchObject({ username: "alice", isPlatformAdmin: false });
    expect(Number.isNaN(Date.parse(registration.json().user.createdAt))).toBe(false);
    const alice = { envman_session: registration.cookies.find((item) => item.name === "envman_session")!.value };
    const alicePersonal = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: alice });
    expect(alicePersonal.json().items).toEqual([]);

    const createdOrganization = await app.inject({
      method: "POST", url: "/api/v1/organizations", cookies: alice,
      payload: { name: "Delivery", description: "Delivery team" },
    });
    expect(createdOrganization.statusCode).toBe(201);
    const organizationId = createdOrganization.json().id as string;
    const unswitchedOrganization = await app.inject({ method: "GET", url: `/api/v1/organizations/${organizationId}`, cookies: alice });
    expect(unswitchedOrganization.statusCode).toBe(404);
    const switchAlice = await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice, payload: { type: "organization", id: organizationId } });
    expect(switchAlice.statusCode).toBe(200);
    const secondOrganization = await app.inject({
      method: "POST", url: "/api/v1/organizations", cookies: alice,
      payload: { name: "Platform", description: "Platform team" },
    });
    expect(secondOrganization.statusCode).toBe(201);
    const workspaceAfterCreation = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: alice });
    expect(workspaceAfterCreation.json().workspace).toMatchObject({ type: "organization", id: organizationId });
    expect(workspaceAfterCreation.json().user.createdAt).toBe(registration.json().user.createdAt);

    const organizationEnvironment = await app.inject({
      method: "POST", url: "/api/v1/environments", cookies: alice,
      payload: { name: "Shared Production", status: "active", tags: [] },
    });
    expect(organizationEnvironment.statusCode).toBe(201);
    const environmentId = organizationEnvironment.json().id as string;

    const crossWorkspaceTunnel = await app.inject({
      method: "POST", url: "/api/v1/database-connections", cookies: alice,
      payload: {
        name: "Invalid Cross-workspace Tunnel",
        engine: "mysql",
        host: "database.internal",
        port: 3306,
        username: "reader",
        credential: { password: "database-secret" },
        connectionMode: "sshTunnel",
        options: { sshConnectionId: privateSsh.json().id },
      },
    });
    expect(crossWorkspaceTunnel.statusCode).toBe(400);
    expect(crossWorkspaceTunnel.json().error).toBe("INVALID_SSH_TUNNEL");

    const databaseConnectionId = crypto.randomUUID();
    const historyId = crypto.randomUUID();
    const now = new Date().toISOString();
    await app.db.prepare(`
      INSERT INTO database_connections (
        id, workspace_type, workspace_id, name, engine, host, port, username,
        credential_ciphertext, created_at, updated_at
      ) VALUES (?, 'organization', ?, 'Shared Database', 'mysql', 'db.internal', 3306, 'reader', ?, ?, ?)
    `).run(databaseConnectionId, organizationId, app.secrets.encrypt("{}"), now, now);
    await app.db.prepare(`
      INSERT INTO database_query_history (
        id, owner_user_id, connection_id, database_name, sql_text, status, created_at
      ) VALUES (?, ?, ?, 'app', 'SELECT organization_secret', 'success', ?)
    `).run(historyId, registration.json().user.id, databaseConnectionId, now);
    const organizationHistory = await app.inject({ method: "GET", url: "/api/v1/database-query-history", cookies: alice });
    expect(organizationHistory.json().items.map((item: { id: string }) => item.id)).toEqual([historyId]);
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice, payload: { type: "personal" } });
    const personalHistory = await app.inject({ method: "GET", url: "/api/v1/database-query-history", cookies: alice });
    expect(personalHistory.json().items).toEqual([]);
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice, payload: { type: "organization", id: organizationId } });

    const adminIdentity = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: admin });
    const adminInvitation = await createInvitation(app, organizationId, alice);
    expect((await acceptInvitation(app, adminInvitation.token, admin)).statusCode).toBe(201);

    const switchAdmin = await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: admin, payload: { type: "organization", id: organizationId } });
    expect(switchAdmin.statusCode).toBe(200);
    const beforeGrant = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: admin });
    expect(beforeGrant.json().items).toEqual([]);

    const grant = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/grants`, cookies: alice,
      payload: { granteeType: "user", granteeId: adminIdentity.json().user.id, resourceType: "environment", resourceId: environmentId },
    });
    expect(grant.statusCode).toBe(201);
    const afterGrant = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: admin });
    expect(afterGrant.json().items.map((item: { id: string }) => item.id)).toEqual([environmentId]);
    const forbiddenWrite = await app.inject({
      method: "POST", url: "/api/v1/environments", cookies: admin,
      payload: { name: "Forbidden", status: "active", tags: [] },
    });
    expect(forbiddenWrite.statusCode).toBe(403);

    const bobAccount = await app.inject({ method: "POST", url: "/api/v1/users", cookies: admin, payload: { username: "bob", password: "b", isPlatformAdmin: false } });
    const bob = await login(app, "bob", "b");
    const bobInvitation = await createInvitation(app, organizationId, alice);
    expect((await acceptInvitation(app, bobInvitation.token, bob)).statusCode).toBe(201);
    const project = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/projects`, cookies: alice, payload: { name: "Operations", description: "" } });
    expect(project.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/projects/${project.json().id}/members`, cookies: alice, payload: { userId: bobAccount.json().id } });
    const group = await app.inject({ method: "POST", url: "/api/v1/environment-groups", cookies: alice, payload: { name: "Project Group", description: "", color: "#1d8a74" } });
    const projectEnvironment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: alice, payload: { groupId: group.json().id, name: "Project Environment", status: "active", tags: [] } });
    const projectGrant = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/grants`, cookies: alice, payload: { granteeType: "project", granteeId: project.json().id, resourceType: "environment_group", resourceId: group.json().id } });
    expect(projectGrant.statusCode).toBe(201);
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: bob, payload: { type: "organization", id: organizationId } });
    const bobEnvironments = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: bob });
    expect(bobEnvironments.json().items.map((item: { id: string }) => item.id)).toEqual([projectEnvironment.json().id]);
    await app.inject({ method: "DELETE", url: `/api/v1/organizations/${organizationId}/grants/${projectGrant.json().id}`, cookies: alice });
    const bobAfterRevoke = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: bob });
    expect(bobAfterRevoke.json().items).toEqual([]);

    const lastAdminDemotion = await app.inject({
      method: "PUT", url: `/api/v1/organizations/${organizationId}/members/${registration.json().user.id}`, cookies: alice,
      payload: { role: "member" },
    });
    expect(lastAdminDemotion.statusCode).toBe(400);
    expect(lastAdminDemotion.json().error).toBe("LAST_ORGANIZATION_ADMIN");

    await app.close();
  });

  it("stores organization environment aliases per user without changing the shared name", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-environment-aliases-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const alice = await registerUser(app, "alias-alice");
    const bob = await registerUser(app, "alias-bob");
    const organization = await app.inject({
      method: "POST", url: "/api/v1/organizations", cookies: alice.cookies,
      payload: { name: "Alias Team", description: "Shared environments" },
    });
    const organizationId = organization.json().id as string;
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice.cookies, payload: { type: "organization", id: organizationId } });
    const environment = await app.inject({
      method: "POST", url: "/api/v1/environments", cookies: alice.cookies,
      payload: { name: "Shared Development", status: "active", tags: ["shared"] },
    });
    const environmentId = environment.json().id as string;

    const invitation = await createInvitation(app, organizationId, alice.cookies);
    expect((await acceptInvitation(app, invitation.token, bob.cookies)).statusCode).toBe(201);
    const grant = await app.inject({
      method: "POST", url: `/api/v1/organizations/${organizationId}/grants`, cookies: alice.cookies,
      payload: { granteeType: "user", granteeId: bob.id, resourceType: "environment", resourceId: environmentId },
    });
    expect(grant.statusCode).toBe(201);
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: bob.cookies, payload: { type: "organization", id: organizationId } });

    const saved = await app.inject({
      method: "PUT", url: `/api/v1/environments/${environmentId}/preferences`, cookies: bob.cookies,
      payload: { alias: "  我的开发环境  " },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ alias: "我的开发环境" });
    const favorited = await app.inject({
      method: "PUT", url: `/api/v1/environments/${environmentId}/preferences`, cookies: bob.cookies,
      payload: { favorite: true },
    });
    expect(favorited.statusCode).toBe(200);
    expect(favorited.json()).toEqual({ favorite: true });
    const bobList = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: bob.cookies });
    expect(bobList.json().items[0]).toMatchObject({ id: environmentId, name: "Shared Development", alias: "我的开发环境", favorite: true });
    const aliasSearch = await app.inject({ method: "GET", url: `/api/v1/environments?q=${encodeURIComponent("我的开发")}`, cookies: bob.cookies });
    expect(aliasSearch.json().items.map((item: { id: string }) => item.id)).toEqual([environmentId]);
    const bobDetail = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies: bob.cookies });
    expect(bobDetail.json().item).toMatchObject({ name: "Shared Development", alias: "", favorite: true });

    const aliceList = await app.inject({ method: "GET", url: "/api/v1/environments", cookies: alice.cookies });
    expect(aliceList.json().items[0]).toMatchObject({ id: environmentId, name: "Shared Development", alias: "", favorite: false });
    const aliceAliasSearch = await app.inject({ method: "GET", url: `/api/v1/environments?q=${encodeURIComponent("我的开发")}`, cookies: alice.cookies });
    expect(aliceAliasSearch.json().items).toEqual([]);

    const cleared = await app.inject({
      method: "PUT", url: `/api/v1/environments/${environmentId}/preferences`, cookies: bob.cookies,
      payload: { alias: "   " },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ alias: "" });
    expect((await app.inject({ method: "GET", url: "/api/v1/environments", cookies: bob.cookies })).json().items[0].alias).toBe("");
    expect(await app.db.prepare("SELECT is_favorite FROM environment_preferences WHERE owner_user_id = ? AND environment_id = ?").get(bob.id, environmentId)).toEqual({ is_favorite: 1 });

    const unfavorited = await app.inject({
      method: "PUT", url: `/api/v1/environments/${environmentId}/preferences`, cookies: bob.cookies,
      payload: { favorite: false },
    });
    expect(unfavorited.statusCode).toBe(200);
    expect(unfavorited.json()).toEqual({ favorite: false });
    expect(await app.db.prepare("SELECT 1 FROM environment_preferences WHERE owner_user_id = ? AND environment_id = ?").get(bob.id, environmentId)).toBeUndefined();

    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: bob.cookies, payload: { type: "personal" } });
    const personalEnvironment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: bob.cookies, payload: { name: "Personal", status: "active", tags: [] } });
    const personalAlias = await app.inject({
      method: "PUT", url: `/api/v1/environments/${personalEnvironment.json().id}/preferences`, cookies: bob.cookies,
      payload: { alias: "Not allowed" },
    });
    expect(personalAlias.statusCode).toBe(400);
    expect(personalAlias.json().error).toBe("ORGANIZATION_WORKSPACE_REQUIRED");
    const personalFavorite = await app.inject({
      method: "PUT", url: `/api/v1/environments/${personalEnvironment.json().id}/preferences`, cookies: bob.cookies,
      payload: { favorite: true },
    });
    expect(personalFavorite.statusCode).toBe(200);
    expect(personalFavorite.json()).toEqual({ favorite: true });
    expect((await app.inject({ method: "GET", url: "/api/v1/environments", cookies: bob.cookies })).json().items[0]).toMatchObject({
      id: personalEnvironment.json().id,
      favorite: true,
    });

    await app.close();
  });

  it("invalidates every session when a platform user is disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-disable-user-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const admin = await login(app, "admin", config.adminPassword);
    const created = await app.inject({
      method: "POST", url: "/api/v1/users", cookies: admin,
      payload: { username: "bob", password: "b", isPlatformAdmin: false },
    });
    expect(created.statusCode).toBe(201);
    const bob = await login(app, "bob", "b");
    const disabled = await app.inject({ method: "PUT", url: `/api/v1/users/${created.json().id}/status`, cookies: admin, payload: { status: "disabled" } });
    expect(disabled.statusCode).toBe(200);
    const expired = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: bob });
    expect(expired.statusCode).toBe(401);
    await app.close();
  });
});
