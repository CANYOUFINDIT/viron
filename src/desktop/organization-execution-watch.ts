import { randomUUID } from "node:crypto";
import {
  DESKTOP_EXECUTION_RESULT_KIND,
  type DesktopExecutionAuthorizationResult,
  type DesktopExecutionChannel,
  type DesktopExecutionCheck,
  type DesktopExecutionCheckResult,
  type DesktopExecutionRequestIdentity,
} from "../shared/desktop-execution-authorization.js";
import type { DesktopSshContext } from "./ssh-context.js";
import { currentDesktopSshContext, signedDesktopOperation } from "./execution-router.js";
import { endpointJson } from "./http-proxy.js";
import { translate as tr } from "./i18n.js";
import { authorizeOrganizationExecution, runWithOrganizationExecutionChannel } from "./organization-execution.js";

export type DesktopExecutionOutcome = "success" | "failed" | "cancelled";

interface OrganizationExecutionWatch {
  id: string;
  context: DesktopSshContext;
  channel: DesktopExecutionChannel;
  checks: DesktopExecutionCheck[];
  decisions: DesktopExecutionCheckResult[];
  requestIdentity: DesktopExecutionRequestIdentity;
  cancel: (reason: string) => void;
  settled: boolean;
}

const watches = new Map<string, OrganizationExecutionWatch>();

export function linkAbortSignal(parent?: AbortSignal): { signal: AbortSignal; cancel: (reason?: unknown) => void } {
  const controller = new AbortController();
  const cancel = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (parent?.aborted) cancel(parent.reason);
  else parent?.addEventListener("abort", () => cancel(parent.reason), { once: true });
  return { signal: controller.signal, cancel };
}

/** Keeps one in-flight organization operation until its external work actually finishes. */
export function watchOrganizationExecution(input: {
  context: DesktopSshContext;
  channel: DesktopExecutionChannel;
  checks: DesktopExecutionCheck[];
  decisions: DesktopExecutionCheckResult[];
  requestIdentity: DesktopExecutionRequestIdentity;
  cancel: (reason: string) => void;
}): { finish: (status: DesktopExecutionOutcome) => Promise<void> } {
  if (input.context.workspaceType !== "organization" || !input.decisions.length || !input.checks.length) {
    return { finish: async () => undefined };
  }
  const watch: OrganizationExecutionWatch = { id: randomUUID(), ...input, settled: false };
  watches.set(watch.id, watch);
  return {
    async finish(status) {
      if (watch.settled) return;
      watch.settled = true;
      watches.delete(watch.id);
      await reportOrganizationExecution(watch, status);
    },
  };
}

export async function syncOrganizationExecutionWatches(): Promise<void> {
  for (const watch of [...watches.values()]) {
    if (watch.settled) continue;
    const lost = tr("组织执行授权已失效，进行中的操作已停止");
    try {
      const current = await currentDesktopSshContext();
      if (
        current.endpoint !== watch.context.endpoint
        || current.userId !== watch.context.userId
        || current.workspaceType !== watch.context.workspaceType
        || current.workspaceId !== watch.context.workspaceId
      ) {
        watch.cancel(lost);
        continue;
      }
      const allowed = await runWithOrganizationExecutionChannel(watch.channel, async () => {
        const result: DesktopExecutionAuthorizationResult = await authorizeOrganizationExecution(watch.requestIdentity, watch.checks);
        return result.allowed;
      });
      if (!allowed) watch.cancel(lost);
    } catch {
      watch.cancel(tr("无法确认当前授权，进行中的操作已停止"));
    }
  }
}

async function reportOrganizationExecution(watch: OrganizationExecutionWatch, status: DesktopExecutionOutcome): Promise<void> {
  for (const decision of watch.decisions) {
    await endpointJson("/api/v1/desktop/organization-execution/result", {
      method: "POST",
      body: await signedDesktopOperation({
        operationId: randomUUID(),
        kind: DESKTOP_EXECUTION_RESULT_KIND,
        channel: watch.channel,
        target: decision.target,
        code: decision.code,
        status,
        basis: decision.basis,
      }, watch.context),
    });
  }
}
