import { translate as tr } from "./i18n.js";
import type { AgentSettingsScope } from "./agent-settings.js";

export const AGENT_DIAGNOSTIC_MAX_STEPS = 64;
export const AGENT_DIAGNOSTIC_MAX_DURATION_MS = 20 * 60_000;

export interface AgentRuntimeScope extends AgentSettingsScope {
  workspaceType: "personal" | "organization";
  workspaceId: string;
}

export function agentRuntimeScopeMatches(left: AgentRuntimeScope, right: AgentRuntimeScope): boolean {
  return left.vironEndpoint === right.vironEndpoint
    && left.vironUserId === right.vironUserId
    && left.workspaceType === right.workspaceType
    && left.workspaceId === right.workspaceId;
}

export class AgentDiagnosticBudget {
  readonly startedAt: number;
  readonly deadlineAt: number;
  private completedSteps = 0;

  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt;
    this.deadlineAt = startedAt + AGENT_DIAGNOSTIC_MAX_DURATION_MS;
  }

  get completed(): number {
    return this.completedSteps;
  }

  get remaining(): number {
    return Math.max(0, AGENT_DIAGNOSTIC_MAX_STEPS - this.completedSteps);
  }

  get nextStep(): number {
    return this.completedSteps + 1;
  }

  assertAvailable(now = Date.now()): void {
    if (now >= this.deadlineAt) throw new Error(tr("Viron Agent 本次执行已达到 20 分钟安全时限"));
    if (this.completedSteps >= AGENT_DIAGNOSTIC_MAX_STEPS) throw new Error(tr("Viron Agent 本次执行已达到 64 次工具调用安全上限"));
  }

  beginStep(now = Date.now()): number {
    this.assertAvailable(now);
    this.completedSteps += 1;
    return this.completedSteps;
  }

  remainingDuration(now = Date.now()): number {
    return Math.max(0, this.deadlineAt - now);
  }
}
