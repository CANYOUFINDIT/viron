import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { resourceBelongsToWorkspace } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { revokeUserRuntime } from "../user-runtime.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const organizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
});
const invitationSchema = z.object({
  expiresInHours: z.union([z.literal(1), z.literal(24), z.literal(168), z.literal(720)]),
  maxUses: z.number().int().min(1).max(10_000).nullable().default(1),
  projectId: z.string().uuid().nullable().default(null),
});
const memberRoleSchema = z.object({ role: z.enum(["admin", "member"]) });
const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  parentId: z.string().uuid().nullable().default(null),
});
const projectMemberSchema = z.object({ userId: z.string().uuid() });
const grantSchema = z.object({
  granteeType: z.enum(["user", "project"]),
  granteeId: z.string().uuid(),
  resourceType: z.enum(["environment_group", "environment", "ssh_connection", "database_connection", "redis_connection"]),
  resourceId: z.string().uuid().optional(),
  resourceIds: z.array(z.string().uuid()).min(1).max(500)
    .refine((ids) => new Set(ids).size === ids.length, "资源不能重复")
    .optional(),
}).superRefine((body, context) => {
  if (Boolean(body.resourceId) === Boolean(body.resourceIds)) {
    context.addIssue({ code: "custom", message: "resourceId 和 resourceIds 必须且只能提供一个" });
  }
});

function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type InvitationRow = {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_description: string;
  created_by_user_id: string;
  inviter_username: string;
  expires_at: string;
  accepted_by_user_id: string | null;
  accepted_at: string | null;
  created_at: string;
  policy_invitation_id: string | null;
  token_ciphertext: string | null;
  max_uses: number | string | null;
  used_count: number | string | null;
  revoked_at: string | null;
  deleted_at: string | null;
  project_id: string | null;
  project_name: string | null;
};

type InvitationAcceptanceRow = {
  invitation_id: string;
  user_id: string;
  username: string;
  accepted_at: string;
  joined_organization: number | string;
  joined_project: number | string;
};

type InvitationStatus = "active" | "expired" | "exhausted" | "revoked";

async function invitationForToken(app: FastifyInstance, token: string): Promise<InvitationRow | undefined> {
  return await app.db.prepare(`
    SELECT i.id, i.organization_id, o.name AS organization_name, o.description AS organization_description,
      i.created_by_user_id, u.username AS inviter_username, i.expires_at, i.accepted_by_user_id,
      i.accepted_at, i.created_at, p.invitation_id AS policy_invitation_id, p.token_ciphertext,
      p.max_uses, p.used_count, p.revoked_at, p.deleted_at, project.id AS project_id, project.name AS project_name
    FROM organization_invitations i
    JOIN organizations o ON o.id = i.organization_id
    JOIN admin_users u ON u.id = i.created_by_user_id
    LEFT JOIN organization_invitation_policies p ON p.invitation_id = i.id
    LEFT JOIN projects project ON project.id = p.project_id AND project.organization_id = i.organization_id
    WHERE i.token_hash = ?
  `).get(invitationTokenHash(token)) as InvitationRow | undefined;
}

async function invitationsForOrganization(app: FastifyInstance, organizationId: string): Promise<InvitationRow[]> {
  return await app.db.prepare(`
    SELECT i.id, i.organization_id, o.name AS organization_name, o.description AS organization_description,
      i.created_by_user_id, u.username AS inviter_username, i.expires_at, i.accepted_by_user_id,
      i.accepted_at, i.created_at, p.invitation_id AS policy_invitation_id, p.token_ciphertext,
      p.max_uses, p.used_count, p.revoked_at, p.deleted_at, project.id AS project_id, project.name AS project_name
    FROM organization_invitations i
    JOIN organizations o ON o.id = i.organization_id
    JOIN admin_users u ON u.id = i.created_by_user_id
    LEFT JOIN organization_invitation_policies p ON p.invitation_id = i.id
    LEFT JOIN projects project ON project.id = p.project_id AND project.organization_id = i.organization_id
    WHERE i.organization_id = ? AND p.deleted_at IS NULL
    ORDER BY i.created_at DESC
  `).all(organizationId) as InvitationRow[];
}

async function invitationAcceptancesForOrganization(app: FastifyInstance, organizationId: string): Promise<Map<string, InvitationAcceptanceRow[]>> {
  const rows = await app.db.prepare(`
    SELECT a.invitation_id, a.user_id, u.username, a.accepted_at, a.joined_organization, a.joined_project
    FROM organization_invitation_acceptances a
    JOIN organization_invitations i ON i.id = a.invitation_id
    JOIN admin_users u ON u.id = a.user_id
    WHERE i.organization_id = ?
    ORDER BY a.accepted_at DESC, u.username COLLATE NOCASE
  `).all(organizationId) as InvitationAcceptanceRow[];
  const grouped = new Map<string, InvitationAcceptanceRow[]>();
  for (const row of rows) {
    const invitationRows = grouped.get(row.invitation_id) ?? [];
    invitationRows.push(row);
    grouped.set(row.invitation_id, invitationRows);
  }
  return grouped;
}

function invitationMaxUses(invitation: InvitationRow): number | null {
  if (!invitation.policy_invitation_id) return 1;
  return invitation.max_uses === null ? null : Number(invitation.max_uses);
}

function invitationUsedCount(invitation: InvitationRow): number {
  if (!invitation.policy_invitation_id) return invitation.accepted_at ? 1 : 0;
  return Number(invitation.used_count ?? 0);
}

function invitationStatus(invitation: InvitationRow): InvitationStatus {
  if (invitation.revoked_at || invitation.deleted_at) return "revoked";
  if (new Date(invitation.expires_at).getTime() <= Date.now()) return "expired";
  const maxUses = invitationMaxUses(invitation);
  if (maxUses !== null && invitationUsedCount(invitation) >= maxUses) return "exhausted";
  return "active";
}

function remainingInvitationUses(invitation: InvitationRow): number | null {
  const maxUses = invitationMaxUses(invitation);
  return maxUses === null ? null : Math.max(0, maxUses - invitationUsedCount(invitation));
}

function invitationUnavailable(status: Exclude<InvitationStatus, "active">) {
  if (status === "expired") return { error: "INVITATION_EXPIRED" as const, message: "邀请链接已过期" };
  if (status === "revoked") return { error: "INVITATION_REVOKED" as const, message: "邀请链接已撤销" };
  return { error: "INVITATION_EXHAUSTED" as const, message: "邀请链接名额已用完" };
}

function invitationResponse(invitation: InvitationRow, alreadyMember: boolean, alreadyProjectMember: boolean) {
  return {
    organization: {
      id: invitation.organization_id,
      name: invitation.organization_name,
      description: invitation.organization_description,
    },
    inviter: { id: invitation.created_by_user_id, username: invitation.inviter_username },
    project: invitation.project_id ? { id: invitation.project_id, name: invitation.project_name } : null,
    expiresAt: invitation.expires_at,
    maxUses: invitationMaxUses(invitation),
    usedCount: invitationUsedCount(invitation),
    remainingUses: remainingInvitationUses(invitation),
    alreadyMember,
    alreadyProjectMember,
  };
}

function invitationListItem(app: FastifyInstance, invitation: InvitationRow, acceptances: InvitationAcceptanceRow[]) {
  let token: string | null = null;
  if (invitation.token_ciphertext) {
    try { token = app.secrets.decrypt(invitation.token_ciphertext); } catch { /* Keep invalid encrypted tokens visible but not copyable. */ }
  }
  return {
    id: invitation.id,
    token,
    createdBy: { id: invitation.created_by_user_id, username: invitation.inviter_username },
    project: invitation.project_id ? { id: invitation.project_id, name: invitation.project_name } : null,
    expiresAt: invitation.expires_at,
    maxUses: invitationMaxUses(invitation),
    usedCount: invitationUsedCount(invitation),
    remainingUses: remainingInvitationUses(invitation),
    status: invitationStatus(invitation),
    revokedAt: invitation.revoked_at,
    createdAt: invitation.created_at,
    acceptedUsers: acceptances.map((acceptance) => ({
      id: acceptance.user_id,
      username: acceptance.username,
      acceptedAt: acceptance.accepted_at,
      joinedOrganization: Boolean(Number(acceptance.joined_organization)),
      joinedProject: Boolean(Number(acceptance.joined_project)),
    })),
  };
}

class InvitationAcceptConflict extends Error {
  constructor(readonly code: "MEMBER_EXISTS") {
    super(code);
  }
}

class GrantRequestError extends Error {
  constructor(readonly code: "INVALID_RESOURCE" | "INVALID_GRANTEE") {
    super(code);
  }
}

async function membership(app: FastifyInstance, organizationId: string, userId: string) {
  return await app.db.prepare(`
    SELECT o.id, o.name, o.description, m.role
    FROM organizations o
    JOIN organization_members m ON m.organization_id = o.id
    WHERE o.id = ? AND m.user_id = ?
  `).get(organizationId, userId) as { id: string; name: string; description: string; role: "admin" | "member" } | undefined;
}

async function requireOrganizationAdmin(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, organizationId: string): Promise<boolean> {
  if (request.admin?.workspace.type !== "organization" || request.admin.workspace.id !== organizationId) {
    void reply.code(403).send({ error: "ORGANIZATION_WORKSPACE_REQUIRED", message: "请先切换到目标组织工作空间" });
    return false;
  }
  const current = await membership(app, organizationId, request.admin!.id);
  if (current?.role === "admin") return true;
  void reply.code(403).send({ error: "ORGANIZATION_ADMIN_REQUIRED", message: "只有组织管理员可以执行此操作" });
  return false;
}

async function activeAdministratorCount(app: FastifyInstance, organizationId: string): Promise<number> {
  const row = await app.db.prepare(`
    SELECT COUNT(*) AS count
    FROM organization_members m
    JOIN admin_users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND m.role = 'admin' AND u.status = 'active'
  `).get(organizationId) as { count: number };
  return Number(row.count);
}

async function projectBelongsToOrganization(app: FastifyInstance, projectId: string, organizationId: string): Promise<boolean> {
  return Boolean(await app.db.prepare("SELECT 1 FROM projects WHERE id = ? AND organization_id = ?").get(projectId, organizationId));
}

type ProjectRow = { id: string; parent_id: string | null };

async function projectRowsForOrganization(app: FastifyInstance, organizationId: string): Promise<ProjectRow[]> {
  return await app.db.prepare("SELECT id, parent_id FROM projects WHERE organization_id = ?").all(organizationId) as ProjectRow[];
}

function projectSubtreeIds(projects: ProjectRow[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  const visited = new Set<string>();
  for (const project of projects) {
    if (!project.parent_id) continue;
    const siblings = children.get(project.parent_id) ?? [];
    siblings.push(project.id);
    children.set(project.parent_id, siblings);
  }
  const result: string[] = [];
  const visit = (projectId: string) => {
    if (visited.has(projectId)) return;
    visited.add(projectId);
    result.push(projectId);
    for (const childId of children.get(projectId) ?? []) visit(childId);
  };
  visit(rootId);
  return result;
}

async function projectSubtreeUserIds(app: FastifyInstance, organizationId: string, projectId: string): Promise<string[]> {
  const projectIds = projectSubtreeIds(await projectRowsForOrganization(app, organizationId), projectId);
  const placeholders = projectIds.map(() => "?").join(",");
  const rows = await app.db.prepare(`SELECT DISTINCT user_id FROM project_members WHERE project_id IN (${placeholders})`).all(...projectIds) as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/v1/organizations", async (request) => ({
    items: (await app.db.prepare(`
      SELECT o.id, o.name, o.description, m.role, o.created_at, o.updated_at
      FROM organization_members m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ?
      ORDER BY o.name COLLATE NOCASE
    `).all(request.admin!.id) as Record<string, unknown>[]).map((row) => ({
      id: row.id, name: row.name, description: row.description, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
  }));

  app.post("/api/v1/organizations", async (request, reply) => {
    const body = parseBody(organizationSchema, request.body, reply);
    if (!body) return;
    if (await app.db.prepare("SELECT id FROM organizations WHERE name = ? COLLATE NOCASE").get(body.name)) {
      return reply.code(409).send({ error: "ORGANIZATION_EXISTS", message: "组织名称已存在" });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await app.db.transaction(async () => {
      await app.db.prepare("INSERT INTO organizations (id, name, description, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, body.name, body.description, request.admin!.id, now, now);
      await app.db.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)")
        .run(id, request.admin!.id, now, now);
    })();
    await writeAudit(app.db, { action: "organization.created", resourceType: "organization", resourceId: id, summary: `创建组织 ${body.name}`, request });
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id", async (request, reply) => {
    if (request.admin!.workspace.type !== "organization" || request.admin!.workspace.id !== request.params.id) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "请先切换到目标组织工作空间" });
    }
    const organization = await membership(app, request.params.id, request.admin!.id);
    if (!organization) return reply.code(404).send({ error: "NOT_FOUND", message: "组织不存在或你不是组织成员" });
    const memberProjectRows = await app.db.prepare(`
      SELECT pm.user_id, pm.project_id
      FROM project_members pm
      JOIN projects p ON p.id = pm.project_id
      WHERE p.organization_id = ?
    `).all(request.params.id) as Array<{ user_id: string; project_id: string }>;
    const projectIdsByMember = new Map<string, string[]>();
    for (const row of memberProjectRows) {
      const projectIds = projectIdsByMember.get(row.user_id) ?? [];
      projectIds.push(row.project_id);
      projectIdsByMember.set(row.user_id, projectIds);
    }
    const members = (await app.db.prepare(`
      SELECT u.id, u.username, u.status, m.role, m.created_at,
        mi.invited_by_user_id, inviter.username AS invited_by_username
      FROM organization_members m
      JOIN admin_users u ON u.id = m.user_id
      LEFT JOIN organization_member_invitations mi
        ON mi.organization_id = m.organization_id AND mi.user_id = m.user_id
      LEFT JOIN admin_users inviter ON inviter.id = mi.invited_by_user_id
      WHERE m.organization_id = ? ORDER BY m.role, u.username COLLATE NOCASE
    `).all(request.params.id) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      username: row.username,
      status: row.status,
      role: row.role,
      createdAt: row.created_at,
      projectIds: projectIdsByMember.get(String(row.id)) ?? [],
      invitedBy: row.invited_by_user_id ? { id: row.invited_by_user_id, username: row.invited_by_username } : null,
    }));
    const projects = (await app.db.prepare(`
      SELECT p.*, COUNT(pm.user_id) AS member_count
      FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
      WHERE p.organization_id = ? GROUP BY p.id ORDER BY p.name COLLATE NOCASE
    `).all(request.params.id) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      description: row.description,
      memberCount: Number(row.member_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const grants = organization.role === "admin" ? (await app.db.prepare(`
      SELECT g.*, COALESCE(u.username, p.name) AS grantee_name
      FROM resource_grants g
      LEFT JOIN admin_users u ON g.grantee_type = 'user' AND u.id = g.grantee_id
      LEFT JOIN projects p ON g.grantee_type = 'project' AND p.id = g.grantee_id
      WHERE g.organization_id = ? ORDER BY g.created_at DESC
    `).all(request.params.id) as Record<string, unknown>[]).map((row) => ({
      id: row.id, granteeType: row.grantee_type, granteeId: row.grantee_id, granteeName: row.grantee_name,
      resourceType: row.resource_type, resourceId: row.resource_id, createdAt: row.created_at,
    })) : [];
    return { organization, members, projects, grants };
  });

  app.put<{ Params: { id: string } }>("/api/v1/organizations/:id", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const body = parseBody(organizationSchema, request.body, reply);
    if (!body) return;
    const duplicate = await app.db.prepare("SELECT id FROM organizations WHERE name = ? COLLATE NOCASE AND id != ?").get(body.name, request.params.id);
    if (duplicate) return reply.code(409).send({ error: "ORGANIZATION_EXISTS", message: "组织名称已存在" });
    await app.db.prepare("UPDATE organizations SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(body.name, body.description, new Date().toISOString(), request.params.id);
    await writeAudit(app.db, { action: "organization.updated", resourceType: "organization", resourceId: request.params.id, summary: `更新组织 ${body.name}`, request });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/organizations/:id/invitations", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const body = parseBody(invitationSchema, request.body, reply);
    if (!body) return;
    if (body.projectId && !await projectBelongsToOrganization(app, body.projectId, request.params.id)) {
      return reply.code(400).send({ error: "INVALID_PROJECT", message: "邀请项目组不属于当前组织" });
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + body.expiresInHours * 60 * 60 * 1000);
    const invitationId = randomUUID();
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT INTO organization_invitations (
          id, organization_id, token_hash, created_by_user_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(invitationId, request.params.id, invitationTokenHash(token), request.admin!.id, expiresAt.toISOString(), now.toISOString());
      await app.db.prepare(`
        INSERT INTO organization_invitation_policies (
          invitation_id, token_ciphertext, max_uses, used_count, project_id
        ) VALUES (?, ?, ?, 0, ?)
      `).run(invitationId, app.secrets.encrypt(token), body.maxUses, body.projectId);
    })();
    await writeAudit(app.db, {
      action: "organization.invitation_created",
      resourceType: "organization",
      resourceId: request.params.id,
      summary: "生成组织邀请链接",
      details: { invitationId, expiresAt: expiresAt.toISOString(), maxUses: body.maxUses, projectId: body.projectId },
      request,
    });
    return reply.code(201).send({
      id: invitationId,
      token,
      expiresAt: expiresAt.toISOString(),
      maxUses: body.maxUses,
      usedCount: 0,
      project: body.projectId
        ? await app.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(body.projectId)
        : null,
    });
  });

  app.get<{ Params: { id: string } }>("/api/v1/organizations/:id/invitations", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const [invitations, acceptances] = await Promise.all([
      invitationsForOrganization(app, request.params.id),
      invitationAcceptancesForOrganization(app, request.params.id),
    ]);
    return { items: invitations.map((invitation) => invitationListItem(app, invitation, acceptances.get(invitation.id) ?? [])) };
  });

  app.delete<{ Params: { id: string; invitationId: string } }>("/api/v1/organizations/:id/invitations/:invitationId", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const invitation = (await invitationsForOrganization(app, request.params.id)).find((item) => item.id === request.params.invitationId);
    if (!invitation) return reply.code(404).send({ error: "NOT_FOUND", message: "邀请链接不存在" });
    if (invitation.revoked_at) return reply.code(204).send();
    const revokedAt = new Date().toISOString();
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT OR IGNORE INTO organization_invitation_policies (
          invitation_id, token_ciphertext, max_uses, used_count, revoked_at
        ) VALUES (?, NULL, 1, ?, ?)
      `).run(invitation.id, invitation.accepted_at ? 1 : 0, revokedAt);
      await app.db.prepare("UPDATE organization_invitation_policies SET revoked_at = ? WHERE invitation_id = ? AND revoked_at IS NULL")
        .run(revokedAt, invitation.id);
    })();
    await writeAudit(app.db, {
      action: "organization.invitation_revoked",
      resourceType: "organization",
      resourceId: request.params.id,
      summary: "撤销组织邀请链接",
      details: { invitationId: invitation.id },
      request,
    });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; invitationId: string } }>("/api/v1/organizations/:id/invitations/:invitationId/record", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const invitation = (await invitationsForOrganization(app, request.params.id)).find((item) => item.id === request.params.invitationId);
    if (!invitation) return reply.code(404).send({ error: "NOT_FOUND", message: "邀请链接不存在或记录已删除" });
    const deletedAt = new Date().toISOString();
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT OR IGNORE INTO organization_invitation_policies (
          invitation_id, token_ciphertext, max_uses, used_count, revoked_at, deleted_at
        ) VALUES (?, NULL, 1, ?, ?, ?)
      `).run(invitation.id, invitation.accepted_at ? 1 : 0, deletedAt, deletedAt);
      await app.db.prepare(`
        UPDATE organization_invitation_policies
        SET token_ciphertext = NULL, revoked_at = COALESCE(revoked_at, ?), deleted_at = ?
        WHERE invitation_id = ?
      `).run(deletedAt, deletedAt, invitation.id);
    })();
    await writeAudit(app.db, {
      action: "organization.invitation_record_deleted",
      resourceType: "organization",
      resourceId: request.params.id,
      summary: "删除组织邀请链接记录",
      details: { invitationId: invitation.id },
      request,
    });
    return reply.code(204).send();
  });

  app.get<{ Params: { token: string } }>("/api/v1/organization-invitations/:token", async (request, reply) => {
    const invitation = await invitationForToken(app, request.params.token);
    if (!invitation) return reply.code(404).send({ error: "INVALID_INVITATION", message: "邀请链接无效" });
    const alreadyMember = Boolean(await app.db.prepare(
      "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?",
    ).get(invitation.organization_id, request.admin!.id));
    const alreadyProjectMember = Boolean(invitation.project_id && await app.db.prepare(
      "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
    ).get(invitation.project_id, request.admin!.id));
    if (alreadyMember && (!invitation.project_id || alreadyProjectMember)) {
      return invitationResponse(invitation, true, alreadyProjectMember);
    }
    const status = invitationStatus(invitation);
    if (status !== "active") return reply.code(410).send(invitationUnavailable(status));
    return invitationResponse(invitation, alreadyMember, alreadyProjectMember);
  });

  app.post<{ Params: { token: string } }>("/api/v1/organization-invitations/:token/accept", async (request, reply) => {
    const now = new Date().toISOString();
    try {
      const result = await app.db.transaction(async () => {
        const invitation = await invitationForToken(app, request.params.token);
        if (!invitation) return { error: "INVALID_INVITATION" as const, message: "邀请链接无效" };
        const currentMembership = await membership(app, invitation.organization_id, request.admin!.id);
        const alreadyProjectMember = Boolean(invitation.project_id && await app.db.prepare(
          "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
        ).get(invitation.project_id, request.admin!.id));
        if (currentMembership && (!invitation.project_id || alreadyProjectMember)) {
          return { error: "MEMBER_EXISTS" as const, message: "你已经是该组织的成员" };
        }
        const status = invitationStatus(invitation);
        if (status !== "active") return invitationUnavailable(status);
        if (invitation.policy_invitation_id) {
          const reserved = await app.db.prepare(`
            UPDATE organization_invitation_policies
            SET used_count = used_count + 1
            WHERE invitation_id = ? AND revoked_at IS NULL
              AND (max_uses IS NULL OR used_count < max_uses)
          `).run(invitation.id);
          if (!reserved.changes) return invitationUnavailable("exhausted");
        } else {
          const reserved = await app.db.prepare(`
            UPDATE organization_invitations SET accepted_by_user_id = ?, accepted_at = ?
            WHERE id = ? AND accepted_at IS NULL AND expires_at > ?
          `).run(request.admin!.id, now, invitation.id, now);
          if (!reserved.changes) return invitationUnavailable("exhausted");
        }
        if (!currentMembership) {
          try {
            await app.db.prepare(`
              INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at)
              VALUES (?, ?, 'member', ?, ?)
            `).run(invitation.organization_id, request.admin!.id, now, now);
          } catch (error) {
            if (isUniqueConstraintError(error)) throw new InvitationAcceptConflict("MEMBER_EXISTS");
            throw error;
          }
          await app.db.prepare(`
            INSERT INTO organization_member_invitations (
              organization_id, user_id, invitation_id, invited_by_user_id, accepted_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(invitation.organization_id, request.admin!.id, invitation.id, invitation.created_by_user_id, now);
        }
        if (invitation.project_id) {
          const assigned = await app.db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)")
            .run(invitation.project_id, request.admin!.id, now);
          if (!assigned.changes) throw new InvitationAcceptConflict("MEMBER_EXISTS");
        }
        await app.db.prepare(`
          INSERT OR IGNORE INTO organization_invitation_acceptances (
            invitation_id, user_id, accepted_at, joined_organization, joined_project
          ) VALUES (?, ?, ?, ?, ?)
        `).run(invitation.id, request.admin!.id, now, currentMembership ? 0 : 1, invitation.project_id ? 1 : 0);
        return { invitation, role: currentMembership?.role ?? "member", joinedOrganization: !currentMembership };
      })();
      if ("error" in result) {
        const status = result.error === "INVALID_INVITATION" ? 404 : result.error === "MEMBER_EXISTS" ? 409 : 410;
        return reply.code(status).send(result);
      }
      await writeAudit(app.db, {
        action: "organization.invitation_accepted",
        resourceType: "organization",
        resourceId: result.invitation.organization_id,
        summary: result.joinedOrganization
          ? `${request.admin!.username} 通过邀请链接加入组织`
          : `${request.admin!.username} 通过邀请链接加入项目组`,
        details: {
          invitationId: result.invitation.id,
          invitedByUserId: result.invitation.created_by_user_id,
          projectId: result.invitation.project_id,
          role: result.role,
        },
        request,
      });
      return reply.code(201).send({
        organization: { id: result.invitation.organization_id, name: result.invitation.organization_name },
        project: result.invitation.project_id ? { id: result.invitation.project_id, name: result.invitation.project_name } : null,
        role: result.role,
      });
    } catch (error) {
      if (error instanceof InvitationAcceptConflict) {
        return reply.code(409).send({ error: error.code, message: "你已经是该组织的成员" });
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string; userId: string } }>("/api/v1/organizations/:id/members/:userId", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const body = parseBody(memberRoleSchema, request.body, reply);
    if (!body) return;
    const member = await app.db.prepare("SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?").get(request.params.id, request.params.userId) as { role: string } | undefined;
    if (!member) return reply.code(404).send({ error: "NOT_FOUND", message: "组织成员不存在" });
    if (member.role === "admin" && body.role === "member" && await activeAdministratorCount(app, request.params.id) <= 1) {
      return reply.code(400).send({ error: "LAST_ORGANIZATION_ADMIN", message: "组织必须保留至少一名有效管理员" });
    }
    await app.db.prepare("UPDATE organization_members SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?")
      .run(body.role, new Date().toISOString(), request.params.id, request.params.userId);
    if (member.role === "admin" && body.role === "member") await revokeUserRuntime(app, request.params.userId, false);
    await writeAudit(app.db, { action: "organization.member_role_changed", resourceType: "organization", resourceId: request.params.id, summary: "调整组织成员角色", details: { userId: request.params.userId, role: body.role }, request });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/v1/organizations/:id/members/:userId", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const member = await app.db.prepare(`
      SELECT m.role, u.username FROM organization_members m JOIN admin_users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND m.user_id = ?
    `).get(request.params.id, request.params.userId) as { role: string; username: string } | undefined;
    if (!member) return reply.code(404).send({ error: "NOT_FOUND", message: "组织成员不存在" });
    if (member.role === "admin" && await activeAdministratorCount(app, request.params.id) <= 1) {
      return reply.code(400).send({ error: "LAST_ORGANIZATION_ADMIN", message: "组织必须保留至少一名有效管理员" });
    }
    await app.db.transaction(async () => {
      await app.db.prepare("DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE organization_id = ?)").run(request.params.userId, request.params.id);
      await app.db.prepare("DELETE FROM resource_grants WHERE organization_id = ? AND grantee_type = 'user' AND grantee_id = ?").run(request.params.id, request.params.userId);
      await app.db.prepare("DELETE FROM knowledge_node_grants WHERE organization_id = ? AND grantee_type = 'user' AND grantee_id = ?").run(request.params.id, request.params.userId);
      await app.db.prepare("DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?").run(request.params.id, request.params.userId);
      await app.db.prepare("UPDATE sessions SET workspace_type = 'personal', workspace_id = user_id WHERE user_id = ? AND workspace_type = 'organization' AND workspace_id = ?")
        .run(request.params.userId, request.params.id);
    })();
    await revokeUserRuntime(app, request.params.userId, false);
    await writeAudit(app.db, { action: "organization.member_removed", resourceType: "organization", resourceId: request.params.id, summary: `从组织移除 ${member.username}`, details: { userId: request.params.userId }, request });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/organizations/:id/projects", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const body = parseBody(projectSchema, request.body, reply);
    if (!body) return;
    if (body.parentId && !await projectBelongsToOrganization(app, body.parentId, request.params.id)) {
      return reply.code(400).send({ error: "INVALID_PARENT_PROJECT", message: "父项目组不属于当前组织" });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare("INSERT INTO projects (id, organization_id, parent_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, request.params.id, body.parentId, body.name, body.description, now, now);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "PROJECT_EXISTS", message: "项目名称已存在" });
      throw error;
    }
    await writeAudit(app.db, { action: "project.created", resourceType: "project", resourceId: id, summary: `创建项目组 ${body.name}`, details: { parentId: body.parentId }, request });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string; projectId: string } }>("/api/v1/organizations/:id/projects/:projectId", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const body = parseBody(projectSchema, request.body, reply);
    if (!body) return;
    if (!await projectBelongsToOrganization(app, request.params.projectId, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "项目不存在" });
    const projectRows = await projectRowsForOrganization(app, request.params.id);
    if (body.parentId && !projectRows.some((project) => project.id === body.parentId)) {
      return reply.code(400).send({ error: "INVALID_PARENT_PROJECT", message: "父项目组不属于当前组织" });
    }
    if (body.parentId && projectSubtreeIds(projectRows, request.params.projectId).includes(body.parentId)) {
      return reply.code(400).send({ error: "PROJECT_CYCLE", message: "项目组不能移动到自身或子项目组下" });
    }
    const affectedUsers = await projectSubtreeUserIds(app, request.params.id, request.params.projectId);
    try {
      await app.db.prepare("UPDATE projects SET parent_id = ?, name = ?, description = ?, updated_at = ? WHERE id = ?")
        .run(body.parentId, body.name, body.description, new Date().toISOString(), request.params.projectId);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "PROJECT_EXISTS", message: "项目名称已存在" });
      throw error;
    }
    await Promise.all(affectedUsers.map((userId) => revokeUserRuntime(app, userId, false)));
    await writeAudit(app.db, { action: "project.updated", resourceType: "project", resourceId: request.params.projectId, summary: `更新项目组 ${body.name}`, details: { parentId: body.parentId }, request });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; projectId: string } }>("/api/v1/organizations/:id/projects/:projectId", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const project = await app.db.prepare("SELECT name FROM projects WHERE id = ? AND organization_id = ?").get(request.params.projectId, request.params.id) as { name: string } | undefined;
    if (!project) return reply.code(404).send({ error: "NOT_FOUND", message: "项目不存在" });
    const projectRows = await projectRowsForOrganization(app, request.params.id);
    const projectIds = projectSubtreeIds(projectRows, request.params.projectId);
    const placeholders = projectIds.map(() => "?").join(",");
    const affectedUsers = (await app.db.prepare(`SELECT DISTINCT user_id FROM project_members WHERE project_id IN (${placeholders})`).all(...projectIds) as Array<{ user_id: string }>).map((item) => item.user_id);
    await app.db.transaction(async () => {
      await app.db.prepare(`UPDATE organization_invitation_policies SET project_id = NULL WHERE project_id IN (${placeholders})`).run(...projectIds);
      await app.db.prepare(`DELETE FROM resource_grants WHERE organization_id = ? AND grantee_type = 'project' AND grantee_id IN (${placeholders})`).run(request.params.id, ...projectIds);
      await app.db.prepare(`DELETE FROM knowledge_node_grants WHERE organization_id = ? AND grantee_type = 'project' AND grantee_id IN (${placeholders})`).run(request.params.id, ...projectIds);
      await app.db.prepare(`DELETE FROM project_members WHERE project_id IN (${placeholders})`).run(...projectIds);
      for (const projectId of [...projectIds].reverse()) await app.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    })();
    await Promise.all(affectedUsers.map((userId) => revokeUserRuntime(app, userId, false)));
    await writeAudit(app.db, { action: "project.deleted", resourceType: "project", resourceId: request.params.projectId, summary: `删除项目组 ${project.name}`, details: { deletedProjectIds: projectIds }, request });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string; projectId: string } }>("/api/v1/organizations/:id/projects/:projectId/members", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const body = parseBody(projectMemberSchema, request.body, reply);
    if (!body) return;
    if (!await projectBelongsToOrganization(app, request.params.projectId, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "项目不存在" });
    if (!await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(request.params.id, body.userId)) {
      return reply.code(400).send({ error: "NOT_ORGANIZATION_MEMBER", message: "项目成员必须先加入组织" });
    }
    await app.db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)").run(request.params.projectId, body.userId, new Date().toISOString());
    await writeAudit(app.db, { action: "project.member_added", resourceType: "project", resourceId: request.params.projectId, summary: "添加项目成员", details: { userId: body.userId }, request });
    return reply.code(201).send({ ok: true });
  });

  app.delete<{ Params: { id: string; projectId: string; userId: string } }>("/api/v1/organizations/:id/projects/:projectId/members/:userId", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    if (!await projectBelongsToOrganization(app, request.params.projectId, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "项目不存在" });
    await app.db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(request.params.projectId, request.params.userId);
    await revokeUserRuntime(app, request.params.userId, false);
    await writeAudit(app.db, { action: "project.member_removed", resourceType: "project", resourceId: request.params.projectId, summary: "移除项目成员", details: { userId: request.params.userId }, request });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string; projectId: string } }>("/api/v1/organizations/:id/projects/:projectId/members", async (request, reply) => {
    if (request.admin!.workspace.type !== "organization" || request.admin!.workspace.id !== request.params.id) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "请先切换到目标组织工作空间" });
    }
    if (!await membership(app, request.params.id, request.admin!.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "组织不存在" });
    if (!await projectBelongsToOrganization(app, request.params.projectId, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "项目不存在" });
    const items = await app.db.prepare(`
      SELECT u.id, u.username FROM project_members pm JOIN admin_users u ON u.id = pm.user_id
      WHERE pm.project_id = ? ORDER BY u.username COLLATE NOCASE
    `).all(request.params.projectId);
    return { items };
  });

  app.post<{ Params: { id: string } }>("/api/v1/organizations/:id/grants", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const body = parseBody(grantSchema, request.body, reply);
    if (!body) return;
    const resourceIds = body.resourceIds ?? [body.resourceId!];
    const userInWorkspace = { ...request.admin!, workspace: { type: "organization" as const, id: request.params.id, name: "", role: "admin" as const } };
    const grantIds = resourceIds.map(() => randomUUID());
    try {
      await app.db.transaction(async () => {
        for (const resourceId of resourceIds) {
          if (!await resourceBelongsToWorkspace(app.db, userInWorkspace, body.resourceType, resourceId)) {
            throw new GrantRequestError("INVALID_RESOURCE");
          }
        }
        const validGrantee = body.granteeType === "user"
          ? await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(request.params.id, body.granteeId)
          : await app.db.prepare("SELECT 1 FROM projects WHERE organization_id = ? AND id = ?").get(request.params.id, body.granteeId);
        if (!validGrantee) throw new GrantRequestError("INVALID_GRANTEE");

        const createdAt = new Date().toISOString();
        for (const [index, resourceId] of resourceIds.entries()) {
          const grantId = grantIds[index];
          await app.db.prepare(`
            INSERT INTO resource_grants (id, organization_id, grantee_type, grantee_id, resource_type, resource_id, created_by_user_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(grantId, request.params.id, body.granteeType, body.granteeId, body.resourceType, resourceId, request.admin!.id, createdAt);
          await writeAudit(app.db, {
            action: "resource.granted",
            resourceType: body.resourceType,
            resourceId,
            summary: "分配组织资源",
            details: { grantId, granteeType: body.granteeType, granteeId: body.granteeId },
            request,
          });
        }
      })();
    } catch (error) {
      if (error instanceof GrantRequestError) {
        if (error.code === "INVALID_RESOURCE") return reply.code(400).send({ error: error.code, message: "只能授权当前组织的资源" });
        return reply.code(400).send({ error: error.code, message: "授权对象不属于当前组织" });
      }
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "GRANT_EXISTS", message: "该授权已存在" });
      throw error;
    }
    return reply.code(201).send({ id: grantIds[0], ids: grantIds });
  });

  app.delete<{ Params: { id: string; grantId: string } }>("/api/v1/organizations/:id/grants/:grantId", async (request, reply) => {
    if (!await requireOrganizationAdmin(app, request, reply, request.params.id)) return;
    const grant = await app.db.prepare("SELECT resource_type, resource_id, grantee_type, grantee_id FROM resource_grants WHERE id = ? AND organization_id = ?")
      .get(request.params.grantId, request.params.id) as Record<string, unknown> | undefined;
    if (!grant) return reply.code(404).send({ error: "NOT_FOUND", message: "授权不存在" });
    const affectedUsers = grant.grantee_type === "user"
      ? [String(grant.grantee_id)]
      : await projectSubtreeUserIds(app, request.params.id, String(grant.grantee_id));
    await app.db.prepare("DELETE FROM resource_grants WHERE id = ?").run(request.params.grantId);
    await Promise.all(affectedUsers.map((userId) => revokeUserRuntime(app, userId, false)));
    await writeAudit(app.db, { action: "resource.revoked", resourceType: String(grant.resource_type), resourceId: String(grant.resource_id), summary: "撤销组织资源授权", details: { grantId: request.params.grantId, granteeType: grant.grantee_type, granteeId: grant.grantee_id }, request });
    return reply.code(204).send();
  });
}
