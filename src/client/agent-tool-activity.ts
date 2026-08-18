import { translate as tr } from "./i18n";
import type { AgentJsonValue, AgentStreamEvent } from "../shared/agent.js";

export interface AgentToolActivity {
  id: string;
  type: "call" | "result";
  toolName: string;
  title: string;
  detail: string;
}

type AgentToolEvent = Extract<AgentStreamEvent, { type: "tool-call" | "tool-result" }>;

const hiddenToolNames = new Set([
  "agent_echo_context",
  "ssh_propose_command",
  "ssh_propose_script",
  "database_propose_sql",
]);

function readableKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim();
}

function shortValue(value: AgentJsonValue): string {
  if (value === null) return tr("无");
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 90);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return tr("{{0}} 项", [value.length]);
  return tr("{{0}} 个字段", [Object.keys(value).length]);
}

export function summarizeAgentToolValue(value: AgentJsonValue): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return shortValue(value);
  const details = Object.entries(value)
    .slice(0, 4)
    .map(([key, item]) => `${readableKey(key)}：${shortValue(item)}`)
    .filter((item) => !item.endsWith("："));
  return details.join("；");
}

export function agentToolActivity(event: AgentToolEvent): AgentToolActivity | null {
  if (hiddenToolNames.has(event.toolName)) return null;
  const type = event.type === "tool-call" ? "call" : "result";
  const value = event.type === "tool-call" ? event.input : event.output;
  const toolLabel = readableKey(event.toolName) || tr("工具");
  return {
    id: `${event.toolCallId}:${type}`,
    type,
    toolName: event.toolName,
    title: type === "call" ? tr("正在使用 {{0}}", [toolLabel]) : tr("{{0}} 已完成", [toolLabel]),
    detail: summarizeAgentToolValue(value),
  };
}
