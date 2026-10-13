import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
  DESKTOP_EXECUTION_RESULT_KIND,
  type DesktopExecutionAuthorizationBasis,
  type DesktopExecutionAuthorizationResult,
  type DesktopExecutionChannel,
  type DesktopExecutionCheck,
  type DesktopExecutionCheckResult,
  type DesktopExecutionRequestIdentity,
} from "../shared/desktop-execution-authorization.js";
import type { ResourceRef } from "../shared/organization-rbac.js";
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

interface PendingExecutionResult {
  operationId: string;
  context: DesktopSshContext;
  channel: DesktopExecutionChannel;
  target: ResourceRef;
  code: string;
  status: DesktopExecutionOutcome;
  basis: DesktopExecutionAuthorizationBasis;
}

function pendingResultPath(): string {
  return join(app.getPath("userData"), "organization-execution-results.json");
}

function readPendingResults(): PendingExecutionResult[] {
  try {
    const parsed = JSON.parse(readFileSync(pendingResultPath(), "utf8")) as { results?: PendingExecutionResult[] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

function writePendingResults(results: PendingExecutionResult[]): void {
  const directory = app.getPath("userData");
  mkdirSync(directory, { recursive: true });
  writeFileSync(pendingResultPath(), `${JSON.stringify({ results }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sameContext(left: DesktopSshContext, right: DesktopSshContext): boolean {
  return left.endpoint === right.endpoint
    && left.userId === right.userId
    && left.workspaceType === right.workspaceType
    && left.workspaceId === right.workspaceId;
}

function rememberPendingResult(watch: OrganizationExecutionWatch, status: DesktopExecutionOutcome): void {
  const pending = readPendingResults();
  for (const decision of watch.decisions) {
    pending.push({
      operationId: randomUUID(),
      context: watch.context,
      channel: watch.channel,
      target: decision.target,
      code: decision.code,
      status,
      basis: decision.basis,
    });
  }
  writePendingResults(pending);
}

/** Retries a saved outcome. A different signed time still carries the same operation and basis. */
export async function flushPendingOrganizationExecutionResults(): Promise<void> {
  const pending = readPendingResults();
  if (!pending.length) return;
  let current: DesktopSshContext;
  try {
    current = await currentDesktopSshContext();
  } catch {
    return;
  }
  const remaining: PendingExecutionResult[] = [];
  for (const item of pending) {
    if (!sameContext(current, item.context)) {
      remaining.push(item);
      continue;
    }
    try {
      await endpointJson("/api/v1/desktop/organization-execution/result", {
        method: "POST",
        body: await signedDesktopOperation({
          operationId: item.operationId,
          kind: DESKTOP_EXECUTION_RESULT_KIND,
          channel: item.channel,
          target: item.target,
          code: item.code,
          status: item.status,
          basis: item.basis,
        }, item.context),
      });
    } catch {
      remaining.push(item);
    }
  }
  writePendingResults(remaining);
}

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
      try {
        rememberPendingResult(watch, status);
        await flushPendingOrganizationExecutionResults();
      } catch {
        // The task is already settled. The heartbeat retries the saved outcome.
      }
    },
  };
}

export async function syncOrganizationExecutionWatches(): Promise<void> {
  await flushPendingOrganizationExecutionResults();
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


