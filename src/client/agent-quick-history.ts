export interface AgentQuickHistoryMessage {
  id: string;
  role: string;
  content: string;
}

export interface AgentQuickHistoryBubble {
  id: string;
  prompt: string;
}

const DEFAULT_QUICK_BUBBLE_LIMIT = 3;

export function agentQuickBubblesFromMessages(
  messages: AgentQuickHistoryMessage[],
  limit = DEFAULT_QUICK_BUBBLE_LIMIT,
): AgentQuickHistoryBubble[] {
  const pairs: AgentQuickHistoryBubble[] = [];
  let lastUser = "";
  for (const message of messages) {
    if (message.role === "user") {
      lastUser = message.content;
      continue;
    }
    if (message.role !== "assistant") continue;
    pairs.push({ id: message.id, prompt: lastUser });
  }
  return pairs.slice(-Math.max(1, limit));
}

export function shouldStartFreshAgentConversation(messages: { length: number } | undefined): boolean {
  return Boolean(messages?.length);
}

export function latestAgentQuickBubbleId(ids: string[]): string {
  return ids.at(-1) ?? "";
}

export const DEFAULT_QUICK_SESSION_CHIP_LIMIT = 3;
export const DEFAULT_QUICK_SESSION_TITLE_MAX_LENGTH = 14;
export const AGENT_QUICK_BUBBLE_STACK_PEEK_PX = 12;
export const AGENT_QUICK_BUBBLE_STACK_INSET_PX = 8;
export const AGENT_QUICK_BUBBLE_STACK_HEADER_PX = 40;
export const AGENT_QUICK_BUBBLE_STACK_MAX_DEPTH = 2;

export function agentQuickHistoryHiddenCount(bubbleCount: number): number {
  return Math.max(0, bubbleCount - 1);
}

export function shouldStackAgentQuickBubbles(bubbleCount: number, tiled: boolean): boolean {
  return !tiled && bubbleCount > 1;
}

export function agentQuickBubbleStackDepth(index: number, total: number): number {
  return Math.max(0, total - 1 - index);
}

export function agentQuickBubbleStackPeekHeight(bubbleCount: number): number {
  return Math.min(Math.max(0, bubbleCount - 1), AGENT_QUICK_BUBBLE_STACK_MAX_DEPTH) * AGENT_QUICK_BUBBLE_STACK_PEEK_PX;
}

export function agentQuickBubbleStackStyle(
  index: number,
  total: number,
  tiled: boolean,
): Record<string, string> {
  if (!shouldStackAgentQuickBubbles(total, tiled)) return {};
  const depth = agentQuickBubbleStackDepth(index, total);
  if (depth === 0) return { zIndex: String(total) };
  const layer = Math.min(depth, AGENT_QUICK_BUBBLE_STACK_MAX_DEPTH);
  return {
    zIndex: String(Math.max(1, total - depth)),
    "--agent-quick-stack-depth": String(layer),
    "--agent-quick-stack-inset": `${AGENT_QUICK_BUBBLE_STACK_INSET_PX}px`,
    "--agent-quick-stack-header": `${AGENT_QUICK_BUBBLE_STACK_HEADER_PX}px`,
    "--agent-quick-stack-peek-step": `${AGENT_QUICK_BUBBLE_STACK_PEEK_PX}px`,
    ...(depth > AGENT_QUICK_BUBBLE_STACK_MAX_DEPTH ? { opacity: "0", pointerEvents: "none" } : {}),
  };
}

export function displayAgentSessionTitle(
  title: string,
  maxLength = DEFAULT_QUICK_SESSION_TITLE_MAX_LENGTH,
): string {
  const value = title.replace(/\s+/g, " ").trim();
  const characters = [...value];
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, maxLength).join("").trimEnd()}...`;
}

export function recentAgentSessionItems<T extends { id: string; updatedAt: string }>(
  items: T[],
  currentSessionId: string,
  limit = DEFAULT_QUICK_SESSION_CHIP_LIMIT,
): T[] {
  const max = Math.max(1, limit);
  const sorted = items.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const current = sorted.find((item) => item.id === currentSessionId);
  const others = sorted.filter((item) => item.id !== currentSessionId);
  return (current ? [current, ...others] : others).slice(0, max);
}
