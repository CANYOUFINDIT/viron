import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { organizationResourceCatalog } from "../../src/server/organization-rbac.js";
import {
  PERMISSION_CODES,
  type ResourceRef,
} from "../../src/shared/organization-rbac.js";

export async function authorizeOrganizationResources(
  app: FastifyInstance,
  cookies: { envman_session: string },
  org: string,
  subjectId?: string,
  resources?: ResourceRef[],
  codes: string[] = PERMISSION_CODES,
  subjectType: "user" | "project" | "organization" = "user",
) {
  const base = `/api/v1/organizations/${org}`;
  const state = (
    await app.inject({ method: "GET", url: base + "/role-access", cookies })
  ).json();
  let roleId: string;
  if (!subjectId)
    roleId = state.roles.find(
      (r: { name: string }) => r.name === "组织管理员",
    ).id;
  else {
    const role = await app.inject({
      method: "POST",
      url: base + "/roles",
      cookies,
      payload: {
        name: "测试角色 " + randomUUID(),
        permissionCodes: codes,
        reason: "测试显式授权",
      },
    });
    expect(role.statusCode, role.body).toBe(201);
    roleId = role.json().id;
    const assignment = await app.inject({
      method: "POST",
      url: base + "/role-assignments",
      cookies,
      payload: { roleId, subjectType, subjectId, reason: "测试显式分配" },
    });
    expect(assignment.statusCode, assignment.body).toBe(201);
  }
  const targets =
    resources ??
    (await organizationResourceCatalog(app.db, org)).map(({ type, id }) => ({
      type,
      id,
    }));
  if (!targets.length) return { roleId, ids: [] as string[] };
  const grant = await app.inject({
    method: "POST",
    url: base + "/role-data-grants",
    cookies,
    payload: { roleId, targets, reason: "测试固定资源范围" },
  });
  expect(grant.statusCode, grant.body).toBe(201);
  return { roleId, ids: grant.json().ids as string[] };
}
