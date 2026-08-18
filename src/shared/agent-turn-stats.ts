import type { AgentTurnUsage } from "./agent.js";

export function emptyAgentTurnUsage(): AgentTurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function nonNegativeInt(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

export function agentTurnUsage(value: unknown): AgentTurnUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: AgentTurnUsage = {
    input: nonNegativeInt(record.input),
    output: nonNegativeInt(record.output),
    cacheRead: nonNegativeInt(record.cacheRead),
    cacheWrite: nonNegativeInt(record.cacheWrite),
    totalTokens: nonNegativeInt(record.totalTokens),
  };
  if (!usage.totalTokens) {
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  return hasAgentTurnTokens(usage) ? usage : undefined;
}

export function addAgentTurnUsage(left: AgentTurnUsage, right: unknown): AgentTurnUsage {
  const next = agentTurnUsage(right) ?? emptyAgentTurnUsage();
  return {
    input: left.input + next.input,
    output: left.output + next.output,
    cacheRead: left.cacheRead + next.cacheRead,
    cacheWrite: left.cacheWrite + next.cacheWrite,
    totalTokens: left.totalTokens + (next.totalTokens || next.input + next.output + next.cacheRead + next.cacheWrite),
  };
}

export function agentTurnDurationMs(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.round(number);
}

export function hasAgentTurnTokens(usage: AgentTurnUsage | undefined): boolean {
  return Boolean(usage && (usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0));
}

export function hasAgentTurnStats(durationMs?: number, usage?: AgentTurnUsage): boolean {
  return (typeof durationMs === "number" && durationMs >= 0) || hasAgentTurnTokens(usage);
}

export function formatAgentDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, ".0")}s`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatAgentTokenCount(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`.replace(/\.0k$/, "k");
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatAgentExactTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export interface AgentTurnTokenDetail {
  key: "input" | "output" | "cacheRead" | "cacheWrite";
  label: string;
  value: number;
}

export function agentTurnTokenDetails(usage: AgentTurnUsage | undefined): AgentTurnTokenDetail[] {
  if (!hasAgentTurnTokens(usage) || !usage) return [];
  const rows: AgentTurnTokenDetail[] = [
    { key: "input", label: "输入 {{0}}", value: usage.input },
    { key: "output", label: "输出 {{0}}", value: usage.output },
  ];
  if (usage.cacheRead > 0) rows.push({ key: "cacheRead", label: "缓存读 {{0}}", value: usage.cacheRead });
  if (usage.cacheWrite > 0) rows.push({ key: "cacheWrite", label: "缓存写 {{0}}", value: usage.cacheWrite });
  return rows;
}

export function agentTurnStatsSummary(durationMs?: number, usage?: AgentTurnUsage): string {
  const parts: string[] = [];
  if (typeof durationMs === "number" && durationMs >= 0) parts.push(formatAgentDuration(durationMs));
  if (hasAgentTurnTokens(usage) && usage) parts.push(formatAgentTokenCount(usage.totalTokens));
  return parts.join(" · ");
}
