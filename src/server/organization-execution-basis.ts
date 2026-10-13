import type { FastifyRequest } from "fastify";
import { executionDecision, serverNow, unionWindow, type ExecutionChannel } from "./organization-boundary.js";
import { recordGrantLedger } from "./organization-approval.js";
import { loadOrganizationAccess, type OrganizationAccess } from "./organization-rbac.js";
import type { EnvmanDatabase } from "./database-client.js";
import { resourceKey, validAt, type ResourceRef } from "../shared/organization-rbac.js";
import type {
  DesktopExecutionAuthorizationBasis,
  DesktopExecutionChannel,
  DesktopExecutionCheckResult,
  DesktopExecutionWindow,
} from "../shared/desktop-execution-authorization.js";

const CLOSED: DesktopExecutionWindow = { allowed: false, permanent: false, expiresAt: null };

export function emptyExecutionBasis(window: DesktopExecutionWindow = CLOSED): DesktopExecutionAuthorizationBasis {
  return { roles: [], featureGrantIds: [], operation: window, feature: window };
}

export function sameRoleBasis(
  access: OrganizationAccess,
  code: string,
  target: ResourceRef,
  now: number,
): DesktopExecutionAuthorizationBasis["roles"] {
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

function featureName(channel: DesktopExecutionChannel): "mcp" | "agent" {
  return channel === "mcp" ? "mcp" : "agent";
}

export function currentFeatureGrantIds(
  access: OrganizationAccess,
  channel: DesktopExecutionChannel,
  target: ResourceRef,
  now: number,
): string[] {
  const feature = featureName(channel);
  const key = resourceKey(target);
  return access.state.featureGrants
    .filter((grant) => validAt(grant, now)
      && access.applies(grant.subjectType, grant.subjectId)
      && grant.features[feature]
      && grant.targets.some((item) => resourceKey(item) === key))
    .map((grant) => grant.id);
}

/** Same decision the desktop authorization route already returns. A listed target and one complete path are required. */
export function decideCheck(
  access: OrganizationAccess,
  channel: DesktopExecutionChannel,
  code: string,
  target: ResourceRef,
  now: number,
): DesktopExecutionCheckResult {
  const listed = access.catalog.some((item) => resourceKey(item) === resourceKey(target));
  const decision = executionDecision(access, channel, code, target);
  const operation = unionWindow(access.operationPaths(code, target));
  const feature = unionWindow(access.featurePaths(featureName(channel), target));
  const allowed = listed && decision.allowed;
  const basis: DesktopExecutionAuthorizationBasis = {
    roles: listed && operation.allowed ? sameRoleBasis(access, code, target, now) : [],
    featureGrantIds: listed && feature.allowed ? currentFeatureGrantIds(access, channel, target, now) : [],
    operation: listed ? operation : CLOSED,
    feature: listed ? feature : CLOSED,
  };
  return {
    target,
    code,
    allowed,
    error: allowed ? null : (decision.error ?? "ACTION_FORBIDDEN"),
    message: allowed ? "" : (listed ? decision.message : "角色未获得这项资源操作权限"),
    window: allowed ? decision.window : CLOSED,
    basis,
  };
}

export async function recordOrganizationExecutionResult(
  db: EnvmanDatabase,
  organizationId: string,
  actor: { id: string; username: string },
  input: {
    channel: ExecutionChannel;
    status: "success" | "failed" | "cancelled";
    code: string;
    target: ResourceRef;
    basis: DesktopExecutionAuthorizationBasis;
  },
): Promise<void> {
  if (input.channel === "manual") return;
  await recordGrantLedger(
    db,
    organizationId,
    { id: actor.id, username: actor.username },
    "执行结果",
    `${input.code} ${input.target.type}:${input.target.id}`,
    {
      targets: [input.target],
      channel: input.channel,
      after: {
        status: input.status,
        code: input.code,
        channel: input.channel,
        target: input.target,
        basis: input.basis,
      },
    },
  );
}

/** Reloads organization access while one command runs. Any remaining complete path keeps that command going. */
export function watchOrganizationExecution(input: {
  db: EnvmanDatabase;
  organizationId: string;
  userId: string;
  channel: ExecutionChannel;
  codes: string[];
  target: ResourceRef;
  controller: AbortController;
  intervalMs?: number;
}): () => void {
  if (input.channel === "manual" || !input.codes.length) return () => {};
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running || input.controller.signal.aborted) return;
    running = true;
    const now = serverNow();
    void loadOrganizationAccess(input.db, input.organizationId, input.userId, now)
      .then((access) => {
        if (stopped || input.controller.signal.aborted) return;
        const stillAllowed = input.codes.every((code) => executionDecision(access, input.channel, code, input.target).allowed);
        if (!stillAllowed) input.controller.abort();
      })
      .catch(() => {
        if (!stopped && !input.controller.signal.aborted) input.controller.abort();
      })
      .finally(() => {
        running = false;
      });
  }, input.intervalMs ?? 40);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Aborts only the controller for this request. It does not close other SSH sessions. */
export function abortWhenRequestDisconnects(request: FastifyRequest, controller: AbortController): () => void {
  const raw = request.raw;
  if (raw.aborted) {
    controller.abort();
    return () => {};
  }
  const abort = () => controller.abort();
  raw.once("aborted", abort);
  return () => raw.removeListener("aborted", abort);
}
