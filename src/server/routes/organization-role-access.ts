import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { parseBody } from "../validation.js";
import {
  OrganizationPermissionError,
  assertOrganizationMaintainer,
  insertAssignment,
  insertDataGrant,
  insertRole,
  loadOrganizationAccess,
  freezeFeatureTargets,
  organizationResourceCatalog,
  roleState,
} from "../organization-rbac.js";
import {
  PERMISSION_CODES,
  PERMISSION_DEFINITIONS,
  RESOURCE_TYPES,
  resourceKey,
  type ResourceRef,
} from "../../shared/organization-rbac.js";
import { disconnectGrantees } from "../access-expiry.js";
import { recordGrantLedger } from "../organization-approval.js";
import {
  dataAuthorizationRevision,
  featureAuthorizationRevision,
} from "../organization-overview.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";

const targetSchema = z
  .object({ type: z.enum(RESOURCE_TYPES), id: z.string().uuid() })
  .strict();
const validity = {
  enabled: z.boolean().default(true),
  startsAt: z.string().datetime().nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
  reason: z.string().trim().min(1).max(2000),
};
const validRange = <
  T extends { startsAt: string | null; expiresAt: string | null },
>(
  value: T,
) =>
  !value.expiresAt ||
  Date.parse(value.expiresAt) >
    Math.max(Date.now(), value.startsAt ? Date.parse(value.startsAt) : 0);
const roleSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).default(""),
    permissionCodes: z
      .array(
        z.string().refine((s) => PERMISSION_CODES.includes(s), "未知权限码"),
      )
      .max(200),
    enabled: z.boolean().default(true),
    version: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
const assignmentSchema = z
  .object({
    ...validity,
    roleId: z.string().uuid(),
    subjectType: z.enum(["user", "project", "organization"]),
    subjectId: z.string().uuid(),
    managementScope: z
      .object({
        kind: z.enum(["organization", "project", "resources"]),
        ids: z.array(z.string().uuid()).max(100).default([]),
        includeChildren: z.boolean().default(true),
      })
      .strict()
      .default({ kind: "resources", ids: [], includeChildren: false }),
  })
  .strict()
  .refine(validRange, "结束时间必须晚于开始时间并且尚未到期");
const dataSchema = z
  .object({
    ...validity,
    roleId: z.string().uuid(),
    targets: z.array(targetSchema).min(1).max(1000),
  })
  .strict()
  .refine(validRange, "结束时间必须晚于开始时间并且尚未到期");
const featureSchema = z
  .object({
    ...validity,
    subjectType: z.enum(["user", "project", "organization"]),
    subjectId: z.string().uuid(),
    targets: z.array(targetSchema).min(1).max(1000),
    features: z
      .object({ mcp: z.boolean(), agent: z.boolean(), webPlugins: z.boolean() })
      .strict()
      .refine((v) => v.mcp || v.agent || v.webPlugins, "至少选择一项功能"),
  })
  .strict()
  .refine(validRange, "结束时间必须晚于开始时间并且尚未到期");
const reasonSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict();
const revisionField = z.string().regex(/^[a-f0-9]{64}$/);
const targetWindowSchema = z
  .object({
    ...validity,
    revision: revisionField,
  })
  .strict()
  .refine(validRange, "结束时间必须晚于开始时间并且尚未到期");
const featureTargetWindowSchema = z
  .object({
    ...validity,
    revision: revisionField,
    features: z
      .object({ mcp: z.boolean(), agent: z.boolean(), webPlugins: z.boolean() })
      .strict()
      .refine((value) => value.mcp || value.agent || value.webPlugins, "至少选择一项功能"),
  })
  .strict()
  .refine(validRange, "结束时间必须晚于开始时间并且尚未到期");
const targetRevokeSchema = z
  .object({ reason: z.string().trim().min(1).max(2000), revision: revisionField })
  .strict();

export async function registerOrganizationRoleAccessRoutes(
  app: FastifyInstance,
) {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (
      request.admin?.workspace.type !== "organization" ||
      request.admin.workspace.id !== id
    )
      return reply.code(403).send({
        error: "ORGANIZATION_WORKSPACE_REQUIRED",
        message: "请先切换到目标组织工作空间",
      });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OrganizationPermissionError)
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message });
    if (isUniqueConstraintError(error))
      return reply.code(409).send({
        error: "RECORD_CONFLICT",
        message: "记录已存在或已被并发修改，请刷新后重试",
      });
    return reply.send(error);
  });
  const access = (request: FastifyRequest) =>
    loadOrganizationAccess(
      app.db,
      request.admin!.workspace.id,
      request.admin!.id,
    );
  const requirePermission = async (
    request: FastifyRequest,
    code: string,
    targets?: ResourceRef[],
  ) => {
    const a = await access(request);
    if (targets ? targets.some((t) => !a.allows(code, t) && !a.allows(code) && !a.allows(code)) : !a.allows(code))
      throw new OrganizationPermissionError(
        "ACTION_FORBIDDEN",
        403,
        "没有这项操作或资源范围的维护权限",
      );
    return a;
  };
  const validateTargets = async (org: string, refs: ResourceRef[]) => {
    const catalog = await organizationResourceCatalog(app.db, org),
      byId = new Map(catalog.map((c) => [resourceKey(c), c]));
    const targets = [...new Map(refs.map((r) => [resourceKey(r), r])).values()];
    if (targets.some((r) => !byId.has(resourceKey(r))))
      throw new OrganizationPermissionError(
        "INVALID_RESOURCE",
        400,
        "资源不存在或不属于当前组织",
      );
    return targets;
  };
  const validateSubject = async (org: string, type: string, id: string) => {
    const valid =
      type === "organization"
        ? id === org
        : !!(await app.db
            .prepare(
              type === "user"
                ? "SELECT 1 FROM organization_members m JOIN admin_users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.user_id = ? AND u.status = 'active'"
                : "SELECT 1 FROM projects WHERE organization_id = ? AND id = ?",
            )
            .get(org, id));
    if (!valid)
      throw new OrganizationPermissionError(
        "INVALID_SUBJECT",
        400,
        "授权对象不属于当前组织或已经失效",
      );
  };
  const validateRole = async (org: string, id: string) => {
    if (
      !(await app.db
        .prepare(
          "SELECT 1 FROM organization_roles WHERE organization_id = ? AND id = ?",
        )
        .get(org, id))
    )
      throw new OrganizationPermissionError(
        "INVALID_ROLE",
        400,
        "角色不属于当前组织",
      );
  };
  const mutate = async (
    request: FastifyRequest,
    action: string,
    reason: string,
    callback: () => Promise<{
      before?: unknown;
      after?: unknown;
      id?: string;
      ids?: string[];
    }>,
  ) => {
    const org = request.admin!.workspace.id;
    const result = await app.db.transaction(async () => {
      // Serializes organization mutations on both database drivers, including last-maintainer checks.
      await app.db
        .prepare(
          "UPDATE organizations SET updated_at = updated_at WHERE id = ?",
        )
        .run(org);
      const key = request.headers["idempotency-key"];
      const hash = createHash("sha256")
        .update(JSON.stringify([request.method, request.url, request.body]))
        .digest("hex");
      if (typeof key === "string") {
        if (!/^[0-9a-f-]{36}$/i.test(key))
          throw new OrganizationPermissionError(
            "INVALID_IDEMPOTENCY_KEY",
            400,
            "幂等标识必须是 UUID",
          );
        const previous = await app.db
          .prepare(
            "SELECT request_hash, response_json FROM organization_role_mutations WHERE organization_id = ? AND actor_id = ? AND mutation_key = ?",
          )
          .get<{ request_hash: string; response_json: string }>(
            org,
            request.admin!.id,
            key,
          );
        if (previous) {
          if (previous.request_hash !== hash)
            throw new OrganizationPermissionError(
              "IDEMPOTENCY_CONFLICT",
              409,
              "此幂等标识已用于其他变更",
            );
          return JSON.parse(previous.response_json) as {
            id?: string;
            ids?: string[];
          };
        }
      }
      const catalog = await organizationResourceCatalog(app.db, org);
      const roles = (await roleState(app.db, org)).roles;
      const named = async (value: unknown) => {
        if (!value || typeof value !== "object") return value;
        const v = value as {
          roleId?: string;
          subjectType?: string;
          subjectId?: string;
          target?: ResourceRef;
          targets?: ResourceRef[];
        };
        const targets = v.target ? [v.target] : (v.targets ?? []);
        const subject =
          v.subjectType === "user"
            ? await app.db
                .prepare(
                  "SELECT username AS name FROM admin_users WHERE id = ?",
                )
                .get<{ name: string }>(v.subjectId)
            : v.subjectType === "project"
              ? await app.db
                  .prepare("SELECT name FROM projects WHERE id = ?")
                  .get<{ name: string }>(v.subjectId)
              : null;
        return {
          ...value,
          roleName: roles.find((r) => r.id === v.roleId)?.name,
          subjectName:
            v.subjectType === "organization"
              ? request.admin!.workspace.name
              : subject?.name,
          resources: targets.map((t) => ({
            ...t,
            name:
              catalog.find((c) => resourceKey(c) === resourceKey(t))?.name ??
              "资源已删除",
          })),
        };
      };
      const change = await callback();
      change.before = await named(change.before);
      change.after = await named(change.after);
      await assertOrganizationMaintainer(app.db, org);
      await app.db
        .prepare(
          "INSERT INTO organization_role_events (id, organization_id, actor_id, actor_name, action, reason, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          org,
          request.admin!.id,
          request.admin!.username,
          action,
          reason,
          change.before ? JSON.stringify(change.before) : null,
          change.after ? JSON.stringify(change.after) : null,
          new Date().toISOString(),
        );
      await writeAudit(app.db, {
        action: "organization.permission_changed",
        resourceType: "organization",
        resourceId: org,
        summary: action,
        details: { reason, ...change },
        request,
      });
      if (typeof key === "string")
        await app.db
          .prepare(
            "INSERT INTO organization_role_mutations (organization_id,actor_id,mutation_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)",
          )
          .run(
            org,
            request.admin!.id,
            key,
            hash,
            JSON.stringify({ id: change.id, ids: change.ids }),
            new Date().toISOString(),
          );
      const targets = [
        ...((change.before as { targets?: ResourceRef[]; target?: ResourceRef } | undefined)?.targets ?? []),
        ...((change.after as { targets?: ResourceRef[] } | undefined)?.targets ?? []),
      ];
      const single = (change.before as { target?: ResourceRef } | undefined)?.target;
      await recordGrantLedger(app.db, org, { id: request.admin!.id, name: request.admin!.username }, action, reason, {
        before: change.before,
        after: change.after,
        targets: single ? [single, ...targets] : targets,
      });
      return change;
    })();
    const members = await app.db
      .prepare("SELECT user_id FROM organization_members WHERE organization_id = ?")
      .all<{ user_id: string }>(request.admin!.workspace.id);
    await disconnectGrantees(app, request.admin!.workspace.id, members.map((member) => member.user_id));
    return { ok: true, id: result.id, ids: result.ids };
  };
  app.get<{ Params: { id: string } }>(
    "/api/v1/organizations/:id/role-access",
    async (request) => {
      const a = await access(request),
        allRoles = a.allows("role.view"),
        ownRoles = new Set(
          a.state.assignments
            .filter((r) => a.applies(r.subjectType, r.subjectId))
            .map((r) => r.roleId),
        );
      const assignments = a.state.assignments.filter(
        (r) => allRoles || a.applies(r.subjectType, r.subjectId),
      );
      return {
        roles: a.state.roles.filter((r) => allRoles || ownRoles.has(r.id)),
        assignments,
        dataGrants: a.state.dataGrants.filter(
          (g) =>
            ownRoles.has(g.roleId) || a.allows("authorization.view", g.target),
        ),
        featureGrants: a.state.featureGrants.filter(
          (g) =>
            a.applies(g.subjectType, g.subjectId) ||
            g.targets.every((t) => a.allows("authorization.view", t)),
        ),
        permissions: PERMISSION_DEFINITIONS,
        capabilities: {
          roleView: allRoles,
          roleCreate: a.allows("role.create"),
          roleUpdate: a.allows("role.update"),
          roleDelete: a.allows("role.delete"),
          authorizationCreate: a.allows("authorization.create"),
          authorizationUpdate: a.allows("authorization.update"),
          authorizationRevoke: a.allows("authorization.revoke"),
        },
        resourceCapabilities: Object.fromEntries(
          a.catalog.map((t) => [
            resourceKey(t),
            {
              create: a.allows("authorization.create", t),
              update: a.allows("authorization.update", t),
              revoke: a.allows("authorization.revoke", t),
            },
          ]),
        ),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/organizations/:id/role-resource-catalog",
    async (request) => {
      const a = await access(request);
      if (
        !a.allows("environment.catalog") &&
        !a.allows("role.view") &&
        !a.allows("authorization.create")
      )
        throw new OrganizationPermissionError(
          "ACTION_FORBIDDEN",
          403,
          "没有目录查看权限",
        );
      return {
        items: a.catalog,
        groups: await app.db
          .prepare(
            "SELECT id, name FROM environment_groups WHERE workspace_type = 'organization' AND workspace_id = ?",
          )
          .all(request.params.id),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/organizations/:id/role-events",
    async (request) => {
      await requirePermission(request, "audit.view");
      return {
        items: (
          await app.db
            .prepare(
              "SELECT * FROM organization_role_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200",
            )
            .all<Record<string, unknown>>(request.params.id)
        ).map((r) => ({
          id: r.id,
          actorName: r.actor_name,
          action: r.action,
          reason: r.reason,
          createdAt: r.created_at,
        })),
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/organizations/:id/roles",
    async (request, reply) => {
      const body = parseBody(roleSchema, request.body, reply);
      if (!body) return;
      const result = await mutate(
        request,
        "创建角色",
        body.reason,
        async () => {
          await requirePermission(request, "role.create");
          const id = await insertRole(
            app.db,
            request.params.id,
            body.name,
            [...new Set(body.permissionCodes)],
            body.description,
          );
          if (!body.enabled)
            await app.db
              .prepare("UPDATE organization_roles SET enabled = 0 WHERE id = ?")
              .run(id);
          return { id, after: { ...body, id } };
        },
      );
      return reply.code(201).send(result);
    },
  );
  app.put<{ Params: { id: string; roleId: string } }>(
    "/api/v1/organizations/:id/roles/:roleId",
    async (request, reply) => {
      const body = parseBody(roleSchema, request.body, reply);
      if (!body) return;
      return mutate(request, "修改角色", body.reason, async () => {
        const a = await requirePermission(request, "role.update");
        const before = a.state.roles.find(
          (r) => r.id === request.params.roleId,
        );
        if (!before)
          throw new OrganizationPermissionError("NOT_FOUND", 404, "角色不存在");
        if (body.version !== undefined && before.version !== body.version)
          throw new OrganizationPermissionError(
            "VERSION_CONFLICT",
            409,
            "角色已变更，请刷新后重试",
          );
        await app.db
          .prepare(
            "UPDATE organization_roles SET name = ?, description = ?, permission_codes_json = ?, enabled = ?, version = version + 1, updated_at = ? WHERE organization_id = ? AND id = ?",
          )
          .run(
            body.name,
            body.description,
            JSON.stringify([...new Set(body.permissionCodes)]),
            body.enabled ? 1 : 0,
            new Date().toISOString(),
            request.params.id,
            before.id,
          );
        return { before, after: body };
      });
    },
  );
  app.delete<{ Params: { id: string; roleId: string } }>(
    "/api/v1/organizations/:id/roles/:roleId",
    async (request, reply) => {
      const body = parseBody(reasonSchema, request.body, reply);
      if (!body) return;
      return mutate(request, "删除角色", body.reason, async () => {
        const a = await requirePermission(request, "role.delete");
        const before = a.state.roles.find(
          (r) => r.id === request.params.roleId,
        );
        if (!before)
          throw new OrganizationPermissionError("NOT_FOUND", 404, "角色不存在");
        if (
          a.state.assignments.some((g) => g.roleId === before.id) ||
          a.state.dataGrants.some((g) => g.roleId === before.id)
        )
          throw new OrganizationPermissionError(
            "ROLE_IN_USE",
            409,
            "角色仍有分配或数据授权，请先处理引用",
          );
        const pending = await app.db
          .prepare(
            "SELECT snapshot_json FROM access_requests WHERE organization_id = ? AND status = 'pending'",
          )
          .all<{ snapshot_json: string }>(request.params.id);
        const flows = await app.db
          .prepare(
            "SELECT workflow_json FROM organization_approval_workflows WHERE organization_id = ?",
          )
          .all<{ workflow_json: string }>(request.params.id);
        if (
          [
            ...pending.map((r) => r.snapshot_json),
            ...flows.map((r) => r.workflow_json),
          ].some((r) => r.includes(before.id))
        )
          throw new OrganizationPermissionError(
            "ROLE_IN_USE",
            409,
            "角色仍被申请或审批流程引用",
          );
        const pendingRole = await app.db
          .prepare(
            "SELECT 1 AS present FROM organization_grant_requests WHERE organization_id = ? AND status = 'pending' AND role_id = ?",
          )
          .get(request.params.id, before.id);
        if (pendingRole)
          throw new OrganizationPermissionError(
            "ROLE_IN_USE",
            409,
            "角色仍有待处理的授权申请，请先处理引用",
          );
        const flowNodes = await app.db
          .prepare(
            "SELECT nodes_json FROM organization_approval_flows WHERE organization_id = ?",
          )
          .all<{ nodes_json: string }>(request.params.id);
        if (
          flowNodes.some((row) => {
            try {
              const nodes = JSON.parse(row.nodes_json) as Array<{ approverRoleId?: string | null }>;
              return Array.isArray(nodes) && nodes.some((node) => node?.approverRoleId === before.id);
            } catch {
              return false;
            }
          })
        )
          throw new OrganizationPermissionError(
            "ROLE_IN_USE",
            409,
            "角色仍被审批流程用作审批角色，请先处理引用",
          );
        await app.db
          .prepare(
            "DELETE FROM organization_roles WHERE organization_id = ? AND id = ?",
          )
          .run(request.params.id, before.id);
        return { before };
      });
    },
  );
  for (const method of ["POST", "PUT"] as const)
    app.route<{ Params: { id: string; assignmentId?: string } }>({
      method,
      url:
        "/api/v1/organizations/:id/role-assignments" +
        (method === "PUT" ? "/:assignmentId" : ""),
      handler: async (request, reply) => {
        const body = parseBody(assignmentSchema, request.body, reply);
        if (!body) return;
        const result = await mutate(
          request,
          method === "POST" ? "分配角色" : "修改角色分配",
          body.reason,
          async () => {
            const a = await requirePermission(request, "role.update");
            await validateSubject(
              request.params.id,
              body.subjectType,
              body.subjectId,
            );
            await validateRole(request.params.id, body.roleId);
            for (const id of body.managementScope.ids)
              await validateSubject(request.params.id, "project", id);
            if (
              body.managementScope.kind === "project" &&
              !body.managementScope.ids.length
            )
              throw new OrganizationPermissionError(
                "INVALID_SCOPE",
                400,
                "请选择管理子组织",
              );
            if (
              body.managementScope.kind !== "project" &&
              body.managementScope.ids.length
            )
              throw new OrganizationPermissionError(
                "INVALID_SCOPE",
                400,
                "此管理范围不使用子组织清单",
              );
            const before = a.state.assignments.find(
              (r) => r.id === request.params.assignmentId,
            );
            if (method === "PUT" && !before)
              throw new OrganizationPermissionError(
                "NOT_FOUND",
                404,
                "角色分配不存在",
              );
            const id =
              before?.id ??
              (await insertAssignment(
                app.db,
                request.params.id,
                body.roleId,
                body.subjectType,
                body.subjectId,
                body.managementScope,
                body.startsAt,
                body.expiresAt,
              ));
            await app.db
              .prepare(
                "UPDATE organization_role_assignments SET role_id = ?, subject_type = ?, subject_id = ?, management_scope_json = ?, enabled = ?, starts_at = ?, expires_at = ?, reason = ? WHERE organization_id = ? AND id = ?",
              )
              .run(
                body.roleId,
                body.subjectType,
                body.subjectId,
                JSON.stringify(body.managementScope),
                body.enabled ? 1 : 0,
                body.startsAt,
                body.expiresAt,
                body.reason,
                request.params.id,
                id,
              );
            return { id, before, after: body };
          },
        );
        return reply.code(method === "POST" ? 201 : 200).send(result);
      },
    });
  for (const method of ["POST", "PUT"] as const)
    app.route<{ Params: { id: string; grantId?: string } }>({
      method,
      url:
        "/api/v1/organizations/:id/role-data-grants" +
        (method === "PUT" ? "/:grantId" : ""),
      handler: async (request, reply) => {
        const body = parseBody(dataSchema, request.body, reply);
        if (!body) return;
        const result = await mutate(
          request,
          method === "POST" ? "新增数据授权" : "修改数据授权",
          body.reason,
          async () => {
            const targets = await validateTargets(
              request.params.id,
              body.targets,
            );
            await validateRole(request.params.id, body.roleId);
            const a = await requirePermission(
              request,
              method === "POST"
                ? "authorization.create"
                : "authorization.update",
              targets,
            );
            const before = a.state.dataGrants.find(
              (g) => g.id === request.params.grantId,
            );
            if (method === "PUT" && !before)
              throw new OrganizationPermissionError(
                "NOT_FOUND",
                404,
                "数据授权不存在",
              );
            if (before) {
              await requirePermission(request, "authorization.update", [
                before.target,
              ]);
              if (
                targets.length !== 1 ||
                resourceKey(targets[0]) !== resourceKey(before.target) ||
                body.roleId !== before.roleId
              )
                throw new OrganizationPermissionError(
                  "IMMUTABLE_TARGET",
                  400,
                  "单行修改不能替换角色或资源，请另行授权",
                );
              await app.db
                .prepare(
                  "UPDATE organization_role_data_grants SET enabled = ?, starts_at = ?, expires_at = ?, reason = ? WHERE organization_id = ? AND id = ?",
                )
                .run(
                  body.enabled ? 1 : 0,
                  body.startsAt,
                  body.expiresAt,
                  body.reason,
                  request.params.id,
                  before.id,
                );
              return { before, after: body };
            }
            const batch = randomUUID(),
              ids: string[] = [];
            for (const t of targets) {
              const id = await insertDataGrant(
                app.db,
                request.params.id,
                body.roleId,
                t,
                batch,
                body.startsAt,
                body.expiresAt,
                body.reason,
              );
              if (!body.enabled)
                await app.db
                  .prepare(
                    "UPDATE organization_role_data_grants SET enabled = 0 WHERE id = ?",
                  )
                  .run(id);
              ids.push(id);
            }
            return { ids, after: body };
          },
        );
        return reply.code(method === "POST" ? 201 : 200).send(result);
      },
    });
  for (const method of ["POST", "PUT"] as const)
    app.route<{ Params: { id: string; grantId?: string } }>({
      method,
      url:
        "/api/v1/organizations/:id/feature-grants" +
        (method === "PUT" ? "/:grantId" : ""),
      handler: async (request, reply) => {
        const body = parseBody(featureSchema, request.body, reply);
        if (!body) return;
        const result = await mutate(
          request,
          method === "POST" ? "新增功能授权" : "修改功能授权",
          body.reason,
          async () => {
            await validateSubject(
              request.params.id,
              body.subjectType,
              body.subjectId,
            );
            const catalog = await organizationResourceCatalog(
              app.db,
              request.params.id,
            );
            const frozen = method === "POST" ? freezeFeatureTargets(catalog, body.targets) : body.targets;
            const targets = await validateTargets(request.params.id, frozen);
            if (
              body.features.webPlugins &&
              !targets.some((t) => t.type === "environment")
            )
              throw new OrganizationPermissionError(
                "INVALID_PLUGIN_SCOPE",
                400,
                "Web 插件只能按环境授权",
              );
            const a = await requirePermission(
              request,
              method === "POST"
                ? "authorization.create"
                : "authorization.update",
              targets,
            );
            const before = a.state.featureGrants.find(
              (g) => g.id === request.params.grantId,
            );
            if (method === "PUT" && !before)
              throw new OrganizationPermissionError(
                "NOT_FOUND",
                404,
                "功能授权不存在",
              );
            if (before)
              await requirePermission(
                request,
                "authorization.update",
                before.targets,
              );
            const id = before?.id ?? randomUUID();
            if (before)
              await app.db
                .prepare(
                  "UPDATE organization_feature_grants SET subject_type = ?, subject_id = ?, targets_json = ?, features_json = ?, enabled = ?, starts_at = ?, expires_at = ?, reason = ? WHERE organization_id = ? AND id = ?",
                )
                .run(
                  body.subjectType,
                  body.subjectId,
                  JSON.stringify(targets),
                  JSON.stringify(body.features),
                  body.enabled ? 1 : 0,
                  body.startsAt,
                  body.expiresAt,
                  body.reason,
                  request.params.id,
                  id,
                );
            else
              await app.db
                .prepare(
                  "INSERT INTO organization_feature_grants (id, organization_id, subject_type, subject_id, targets_json, features_json, enabled, starts_at, expires_at, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .run(
                  id,
                  request.params.id,
                  body.subjectType,
                  body.subjectId,
                  JSON.stringify(targets),
                  JSON.stringify(body.features),
                  body.enabled ? 1 : 0,
                  body.startsAt,
                  body.expiresAt,
                  body.reason,
                  new Date().toISOString(),
                );
            return { id, before, after: body };
          },
        );
        return reply.code(method === "POST" ? 201 : 200).send(result);
      },
    });
  for (const [segment, table, collection] of [
    ["role-assignments", "organization_role_assignments", "assignments"],
    ["role-data-grants", "organization_role_data_grants", "dataGrants"],
    ["feature-grants", "organization_feature_grants", "featureGrants"],
  ] as const)
    app.delete<{ Params: { id: string; grantId: string } }>(
      `/api/v1/organizations/:id/${segment}/:grantId`,
      async (request, reply) => {
        const body = parseBody(reasonSchema, request.body, reply);
        if (!body) return;
        return mutate(request, "撤销" + segment, body.reason, async () => {
          const a = await access(request),
            before = a.state[collection].find(
              (g) => g.id === request.params.grantId,
            );
          if (!before)
            throw new OrganizationPermissionError(
              "NOT_FOUND",
              404,
              "记录不存在",
            );
          if (collection === "assignments")
            await requirePermission(request, "role.update");
          else
            await requirePermission(
              request,
              "authorization.revoke",
              "target" in before
                ? [before.target]
                : "targets" in before
                  ? before.targets
                  : [],
            );
          await app.db
            .prepare(
              `DELETE FROM ${table} WHERE organization_id = ? AND id = ?`,
            )
            .run(request.params.id, before.id);
          return { before };
        });
      },
    );

  const changed = () =>
    new OrganizationPermissionError(
      "GRANT_CHANGED",
      409,
      "当前授权已变更，请刷新后重试",
    );
  const targetGone = () =>
    new OrganizationPermissionError(
      "CURRENT_TARGET_CHANGED",
      409,
      "当前资源已不在这条授权中，请刷新后重试",
    );
  const parseFeatureTargets = (value: unknown) => {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? (parsed as ResourceRef[]) : [];
  };
  const parseFeatures = (value: unknown) => {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return {
      mcp: Boolean(record.mcp),
      agent: Boolean(record.agent),
      webPlugins: Boolean(record.webPlugins),
    };
  };
  const resourceParams = (
    request: FastifyRequest<{ Params: { type: string; resourceId: string; grantId: string } }>,
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const parsed = z
      .object({
        type: z.enum(RESOURCE_TYPES),
        resourceId: z.string().uuid(),
        grantId: z.string().uuid(),
      })
      .safeParse(request.params);
    if (!parsed.success) {
      void reply.code(400).send({ error: "INVALID_RESOURCE", message: "资源不存在" });
      return null;
    }
    return {
      grantId: parsed.data.grantId,
      target: { type: parsed.data.type, id: parsed.data.resourceId } as ResourceRef,
    };
  };

  app.put<{ Params: { id: string; type: string; resourceId: string; grantId: string } }>(
    "/api/v1/organizations/:id/resource-authorizations/:type/:resourceId/data-grants/:grantId",
    async (request, reply) => {
      const params = resourceParams(request, reply);
      const body = params && parseBody(targetWindowSchema, request.body, reply);
      if (!params || !body) return;
      const result = await mutate(request, "修改当前资源的数据授权", body.reason, async () => {
        const row = await app.db
          .prepare(
            "SELECT id, role_id, target_type, target_id, enabled, starts_at, expires_at, reason, source, request_id FROM organization_role_data_grants WHERE organization_id = ? AND id = ?",
          )
          .get<{
            id: string;
            role_id: string;
            target_type: ResourceRef["type"];
            target_id: string;
            enabled: number;
            starts_at: string | null;
            expires_at: string | null;
            reason: string;
            source: string;
            request_id: string | null;
          }>(request.params.id, params.grantId);
        if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "授权记录不存在");
        const stored = { type: row.target_type, id: row.target_id };
        if (resourceKey(stored) !== resourceKey(params.target)) throw targetGone();
        await validateTargets(request.params.id, [params.target]);
        const requestId = row.request_id ? String(row.request_id) : null;
        const current = {
          id: row.id,
          roleId: row.role_id,
          target: stored,
          enabled: Number(row.enabled) === 1,
          startsAt: row.starts_at ? String(row.starts_at) : null,
          expiresAt: row.expires_at ? String(row.expires_at) : null,
          reason: String(row.reason),
          source: String(row.source),
          requestId,
        };
        if (dataAuthorizationRevision(current) !== body.revision) throw changed();
        await requirePermission(request, "authorization.update", [params.target]);
        await app.db
          .prepare(
            "UPDATE organization_role_data_grants SET enabled = ?, starts_at = ?, expires_at = ?, reason = ? WHERE organization_id = ? AND id = ?",
          )
          .run(body.enabled ? 1 : 0, body.startsAt, body.expiresAt, body.reason, request.params.id, row.id);
        return {
          id: row.id,
          before: current,
          after: { ...current, enabled: body.enabled, startsAt: body.startsAt, expiresAt: body.expiresAt, reason: body.reason },
        };
      });
      return reply.send(result);
    },
  );
  app.delete<{ Params: { id: string; type: string; resourceId: string; grantId: string } }>(
    "/api/v1/organizations/:id/resource-authorizations/:type/:resourceId/data-grants/:grantId",
    async (request, reply) => {
      const params = resourceParams(request, reply);
      const body = params && parseBody(targetRevokeSchema, request.body, reply);
      if (!params || !body) return;
      return mutate(request, "撤销当前资源的数据授权", body.reason, async () => {
        const row = await app.db
          .prepare(
            "SELECT id, role_id, target_type, target_id, enabled, starts_at, expires_at, reason, source, request_id FROM organization_role_data_grants WHERE organization_id = ? AND id = ?",
          )
          .get<{
            id: string;
            role_id: string;
            target_type: ResourceRef["type"];
            target_id: string;
            enabled: number;
            starts_at: string | null;
            expires_at: string | null;
            reason: string;
            source: string;
            request_id: string | null;
          }>(request.params.id, params.grantId);
        if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "授权记录不存在");
        const stored = { type: row.target_type, id: row.target_id };
        if (resourceKey(stored) !== resourceKey(params.target)) throw targetGone();
        const requestId = row.request_id ? String(row.request_id) : null;
        const current = {
          id: row.id,
          roleId: row.role_id,
          target: stored,
          enabled: Number(row.enabled) === 1,
          startsAt: row.starts_at ? String(row.starts_at) : null,
          expiresAt: row.expires_at ? String(row.expires_at) : null,
          reason: String(row.reason),
          source: String(row.source),
          requestId,
        };
        if (dataAuthorizationRevision(current) !== body.revision) throw changed();
        await requirePermission(request, "authorization.revoke", [params.target]);
        await app.db
          .prepare("DELETE FROM organization_role_data_grants WHERE organization_id = ? AND id = ?")
          .run(request.params.id, row.id);
        return { before: current };
      });
    },
  );
  app.put<{ Params: { id: string; type: string; resourceId: string; grantId: string } }>(
    "/api/v1/organizations/:id/resource-authorizations/:type/:resourceId/feature-grants/:grantId",
    async (request, reply) => {
      const params = resourceParams(request, reply);
      const body = params && parseBody(featureTargetWindowSchema, request.body, reply);
      if (!params || !body) return;
      const result = await mutate(request, "修改当前资源的功能授权", body.reason, async () => {
        const row = await app.db
          .prepare(
            "SELECT id, subject_type, subject_id, targets_json, features_json, enabled, starts_at, expires_at, reason, request_id FROM organization_feature_grants WHERE organization_id = ? AND id = ?",
          )
          .get<Record<string, unknown>>(request.params.id, params.grantId);
        if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "授权记录不存在");
        const targets = parseFeatureTargets(row.targets_json);
        if (!targets.some((item) => resourceKey(item) === resourceKey(params.target))) throw targetGone();
        await validateTargets(request.params.id, [params.target]);
        const features = parseFeatures(row.features_json);
        const requestId = row.request_id ? String(row.request_id) : null;
        const current = {
          id: String(row.id),
          subjectType: String(row.subject_type),
          subjectId: String(row.subject_id),
          enabled: Number(row.enabled) === 1,
          startsAt: row.starts_at ? String(row.starts_at) : null,
          expiresAt: row.expires_at ? String(row.expires_at) : null,
          reason: String(row.reason),
          features,
          requestId,
          targets,
        };
        if (featureAuthorizationRevision(current) !== body.revision) throw changed();
        await requirePermission(request, "authorization.update", [params.target]);
        if (body.features.webPlugins && params.target.type !== "environment")
          throw new OrganizationPermissionError("INVALID_PLUGIN_SCOPE", 400, "Web 插件只能按环境授权");
        const remaining = targets.filter((item) => resourceKey(item) !== resourceKey(params.target));
        const next = {
          subjectType: current.subjectType,
          subjectId: current.subjectId,
          targets: [params.target],
          features: body.features,
          enabled: body.enabled,
          startsAt: body.startsAt,
          expiresAt: body.expiresAt,
          reason: body.reason,
          requestId,
          source: requestId ? "request" : "direct",
        };
        if (!remaining.length) {
          await app.db
            .prepare(
              "UPDATE organization_feature_grants SET features_json = ?, enabled = ?, starts_at = ?, expires_at = ?, reason = ? WHERE organization_id = ? AND id = ?",
            )
            .run(JSON.stringify(body.features), body.enabled ? 1 : 0, body.startsAt, body.expiresAt, body.reason, request.params.id, current.id);
          return { id: current.id, before: current, after: { ...next, id: current.id } };
        }
        const id = randomUUID();
        await app.db
          .prepare("UPDATE organization_feature_grants SET targets_json = ? WHERE organization_id = ? AND id = ?")
          .run(JSON.stringify(remaining), request.params.id, current.id);
        await app.db
          .prepare(
            `INSERT INTO organization_feature_grants (
              id, organization_id, subject_type, subject_id, targets_json, features_json,
              enabled, starts_at, expires_at, reason, request_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            request.params.id,
            current.subjectType,
            current.subjectId,
            JSON.stringify([params.target]),
            JSON.stringify(body.features),
            body.enabled ? 1 : 0,
            body.startsAt,
            body.expiresAt,
            body.reason,
            requestId,
            new Date().toISOString(),
          );
        return {
          id,
          before: current,
          after: { ...next, id, retainedGrantId: current.id, retainedTargets: remaining },
        };
      });
      return reply.send(result);
    },
  );
  app.delete<{ Params: { id: string; type: string; resourceId: string; grantId: string } }>(
    "/api/v1/organizations/:id/resource-authorizations/:type/:resourceId/feature-grants/:grantId",
    async (request, reply) => {
      const params = resourceParams(request, reply);
      const body = params && parseBody(targetRevokeSchema, request.body, reply);
      if (!params || !body) return;
      return mutate(request, "撤销当前资源的功能授权", body.reason, async () => {
        const row = await app.db
          .prepare(
            "SELECT id, subject_type, subject_id, targets_json, features_json, enabled, starts_at, expires_at, reason, request_id FROM organization_feature_grants WHERE organization_id = ? AND id = ?",
          )
          .get<Record<string, unknown>>(request.params.id, params.grantId);
        if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "授权记录不存在");
        const targets = parseFeatureTargets(row.targets_json);
        if (!targets.some((item) => resourceKey(item) === resourceKey(params.target))) throw targetGone();
        const features = parseFeatures(row.features_json);
        const requestId = row.request_id ? String(row.request_id) : null;
        const current = {
          id: String(row.id),
          subjectType: String(row.subject_type),
          subjectId: String(row.subject_id),
          enabled: Number(row.enabled) === 1,
          startsAt: row.starts_at ? String(row.starts_at) : null,
          expiresAt: row.expires_at ? String(row.expires_at) : null,
          reason: String(row.reason),
          features,
          requestId,
          targets,
        };
        if (featureAuthorizationRevision(current) !== body.revision) throw changed();
        await requirePermission(request, "authorization.revoke", [params.target]);
        const remaining = targets.filter((item) => resourceKey(item) !== resourceKey(params.target));
        if (!remaining.length) {
          await app.db
            .prepare("DELETE FROM organization_feature_grants WHERE organization_id = ? AND id = ?")
            .run(request.params.id, current.id);
          return { before: current };
        }
        await app.db
          .prepare("UPDATE organization_feature_grants SET targets_json = ? WHERE organization_id = ? AND id = ?")
          .run(JSON.stringify(remaining), request.params.id, current.id);
        return {
          before: current,
          after: {
            id: current.id,
            subjectType: current.subjectType,
            subjectId: current.subjectId,
            targets: remaining,
            features,
            enabled: current.enabled,
            startsAt: current.startsAt,
            expiresAt: current.expiresAt,
            reason: current.reason,
            requestId,
            source: requestId ? "request" : "direct",
          },
        };
      });
    },
  );
}
