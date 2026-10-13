import type { FastifyInstance } from "fastify";
import { intersectWindows, serverNow } from "../organization-boundary.js";
import { recordGrantLedger } from "../organization-approval.js";
import { loadOrganizationAccess } from "../organization-rbac.js";
import { decideCheck, emptyExecutionBasis } from "../organization-execution-basis.js";
import { acceptDesktopReport, DesktopReportError } from "../desktop-report.js";
import { requireAdmin } from "./auth.js";
import {
  DESKTOP_EXECUTION_AUTHORIZATION_KIND,
  DESKTOP_EXECUTION_RESULT_KIND,
  desktopExecutionAuthorizationPayloadSchema,
  desktopExecutionResultPayloadSchema,
  type DesktopExecutionAuthorizationPayload,
  type DesktopExecutionAuthorizationResult,
  type DesktopExecutionCheckResult,
  type DesktopExecutionWindow,
} from "../../shared/desktop-execution-authorization.js";

const OPEN_WINDOW: DesktopExecutionWindow = { allowed: true, permanent: true, expiresAt: null };

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
    basis: emptyExecutionBasis(OPEN_WINDOW),
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

  app.post(
    "/api/v1/desktop/organization-execution/result",
    { preHandler: requireAdmin, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.admin) return;
      const admin = request.admin;
      try {
        const accepted = await acceptDesktopReport(
          app,
          admin,
          request.body,
          desktopExecutionResultPayloadSchema,
          async ({ payload }) => {
            if (admin.workspace.type !== "organization") return;
            await recordGrantLedger(
              app.db,
              admin.workspace.id,
              { id: admin.id, username: admin.username },
              "执行结果",
              `${payload.code} ${payload.target.type}:${payload.target.id}`,
              {
                targets: [payload.target],
                channel: payload.channel,
                after: {
                  kind: DESKTOP_EXECUTION_RESULT_KIND,
                  status: payload.status,
                  code: payload.code,
                  channel: payload.channel,
                  operationId: payload.operationId,
                  target: payload.target,
                  basis: payload.basis,
                },
              },
            );
          },
        );
        return { accepted: true, duplicate: accepted.duplicate };
      } catch (error) {
        if (error instanceof DesktopReportError) return reply.code(error.status).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );
}
