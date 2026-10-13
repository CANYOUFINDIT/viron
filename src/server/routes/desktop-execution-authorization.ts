import type { FastifyInstance } from "fastify";
import { executionDecision, intersectWindows, serverNow, unionWindow } from "../organization-boundary.js";
import { recordGrantLedger } from "../organization-approval.js";
import { loadOrganizationAccess, type OrganizationAccess } from "../organization-rbac.js";
import { acceptDesktopReport, DesktopReportError } from "../desktop-report.js";
import { requireAdmin } from "./auth.js";
import { resourceKey, validAt, type ResourceRef } from "../../shared/organization-rbac.js";
import {
  DESKTOP_EXECUTION_AUTHORIZATION_KIND,
  desktopExecutionAuthorizationPayloadSchema,
  type DesktopExecutionAuthorizationBasis,
  type DesktopExecutionAuthorizationPayload,
  type DesktopExecutionAuthorizationResult,
  type DesktopExecutionChannel,
  type DesktopExecutionCheckResult,
  type DesktopExecutionWindow,
} from "../../shared/desktop-execution-authorization.js";

const OPEN_WINDOW: DesktopExecutionWindow = { allowed: true, permanent: true, expiresAt: null };

function emptyBasis(window: DesktopExecutionWindow = { allowed: false, permanent: false, expiresAt: null }): DesktopExecutionAuthorizationBasis {
  return { roles: [], featureGrantIds: [], operation: window, feature: window };
}

function sameRoleBasis(access: OrganizationAccess, code: string, target: ResourceRef, now: number): DesktopExecutionAuthorizationBasis["roles"] {
  const key = resourceKey(target);
  const roles: DesktopExecutionAuthorizationBasis["roles"] = [];
  for (const assignment of access.state.assignments) {
    if (!validAt(assignment, now) || !access.applies(assignment.subjectType, assignment.subjectId)) continue;
    const role = access.state.roles.find((item) => item.id === assignment.roleId && item.enabled);
    if (!role?.permissionCodes.includes(code)) continue;
    for (const grant of access.state.dataGrants) {
      if (grant.roleId !== role.id || !validAt(grant, now) || resourceKey(grant.target) !== key) continue;
      roles.push({ roleId: role.id, roleName: role.name, assignmentId: assignment.id, dataGrantId: grant.id });
    }
  }
  return roles;
}

function currentFeatureGrantIds(access: OrganizationAccess, channel: DesktopExecutionChannel, target: ResourceRef, now: number): string[] {
  const feature = channel === "mcp" ? "mcp" : "agent";
  const key = resourceKey(target);
  return access.state.featureGrants
    .filter((grant) => validAt(grant, now)
      && access.applies(grant.subjectType, grant.subjectId)
      && grant.features[feature]
      && grant.targets.some((item) => resourceKey(item) === key))
    .map((grant) => grant.id);
}

function decideCheck(
  access: OrganizationAccess,
  channel: DesktopExecutionChannel,
  code: string,
  target: ResourceRef,
  now: number,
): DesktopExecutionCheckResult {
  const listed = access.catalog.some((item) => resourceKey(item) === resourceKey(target));
  const decision = executionDecision(access, channel, code, target);
  const operation = unionWindow(access.operationPaths(code, target));
  const feature = unionWindow(access.featurePaths(channel === "mcp" ? "mcp" : "agent", target));
  const allowed = listed && decision.allowed;
  const basis: DesktopExecutionAuthorizationBasis = {
    roles: listed && operation.allowed ? sameRoleBasis(access, code, target, now) : [],
    featureGrantIds: listed && feature.allowed ? currentFeatureGrantIds(access, channel, target, now) : [],
    operation: listed ? operation : emptyBasis().operation,
    feature: listed ? feature : emptyBasis().feature,
  };
  return {
    target,
    code,
    allowed,
    error: allowed ? null : (decision.error ?? "ACTION_FORBIDDEN"),
    message: allowed ? "" : (listed ? decision.message : "角色未获得这项资源操作权限"),
    window: allowed ? decision.window : { allowed: false, permanent: false, expiresAt: null },
    basis,
  };
}

function overall(checks: DesktopExecutionCheckResult[]): { window: DesktopExecutionWindow; error: DesktopExecutionCheckResult["error"]; message: string } {
  const denied = checks.find((check) => !check.allowed);
  if (denied) return { window: denied.window, error: denied.error, message: denied.message };
  return {
    window: checks.reduce((window, check) => intersectWindows(window, check.window), checks[0]?.window ?? OPEN_WINDOW),
    error: null,
    message: "",
  };
}

function personalResult(payload: DesktopExecutionAuthorizationPayload, duplicate: boolean): DesktopExecutionAuthorizationResult {
  const checks = payload.checks.map((check): DesktopExecutionCheckResult => ({
    target: check.target,
    code: check.code,
    allowed: true,
    error: null,
    message: "",
    window: OPEN_WINDOW,
    basis: emptyBasis(OPEN_WINDOW),
  }));
  return {
    allowed: true,
    scope: "personal",
    operationId: payload.operationId,
    duplicate,
    kind: DESKTOP_EXECUTION_AUTHORIZATION_KIND,
    channel: payload.channel,
    error: null,
    message: "",
    window: OPEN_WINDOW,
    checks,
    requestIdentity: payload.requestIdentity,
  };
}

export async function registerDesktopExecutionAuthorizationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/desktop/organization-execution/authorize",
    { preHandler: requireAdmin, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.admin) return;
      const admin = request.admin;
      try {
        const accepted = await acceptDesktopReport(
          app,
          admin,
          request.body,
          desktopExecutionAuthorizationPayloadSchema,
          async () => {},
        );
        const payload = accepted.payload;
        if (admin.workspace.type !== "organization") {
          return personalResult(payload, accepted.duplicate);
        }
        const now = serverNow();
        const access = await loadOrganizationAccess(app.db, admin.workspace.id, admin.id, now);
        const checks = payload.checks.map((check) => decideCheck(access, payload.channel, check.code, check.target, now));
        const summary = overall(checks);
        const result: DesktopExecutionAuthorizationResult = {
          allowed: summary.error === null,
          scope: "organization",
          operationId: payload.operationId,
          duplicate: accepted.duplicate,
          kind: DESKTOP_EXECUTION_AUTHORIZATION_KIND,
          channel: payload.channel,
          error: summary.error,
          message: summary.message,
          window: summary.window,
          checks,
          requestIdentity: payload.requestIdentity,
        };
        await recordGrantLedger(
          app.db,
          admin.workspace.id,
          { id: admin.id, username: admin.username },
          "执行授权检查",
          `${payload.requestIdentity.method} ${payload.requestIdentity.path}`,
          {
            targets: payload.checks.map((check) => check.target),
            channel: payload.channel,
            after: {
              kind: DESKTOP_EXECUTION_AUTHORIZATION_KIND,
              result: result.allowed ? "allowed" : "denied",
              error: result.error,
              operationId: payload.operationId,
              channel: payload.channel,
              requestIdentity: payload.requestIdentity,
              checks: checks.map((check) => ({
                code: check.code,
                target: check.target,
                allowed: check.allowed,
                error: check.error,
                window: check.window,
                basis: check.basis,
              })),
            },
          },
        );
        if (!result.allowed) return reply.code(403).send(result);
        return result;
      } catch (error) {
        if (error instanceof DesktopReportError) return reply.code(error.status).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );
}
