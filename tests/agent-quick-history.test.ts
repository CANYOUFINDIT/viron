import { describe, expect, it } from "vitest";
import {
  agentQuickBubbleStackPeekHeight,
  agentQuickBubbleStackStyle,
  agentQuickBubblesFromMessages,
  agentQuickHistoryHiddenCount,
  displayAgentSessionTitle,
  latestAgentQuickBubbleId,
  recentAgentSessionItems,
  shouldStackAgentQuickBubbles,
  shouldStartFreshAgentConversation,
} from "../src/client/agent-quick-history.js";

describe("agent quick history restore", () => {
  it("rebuilds the latest assistant bubbles from persisted user/assistant turns", () => {
    const bubbles = agentQuickBubblesFromMessages([
      { id: "u1", role: "user", content: "当前环境有哪些连接" },
      { id: "a1", role: "assistant", content: "有 6 个 SSH 连接" },
      { id: "u2", role: "user", content: "帮我连接 192.168.5.195" },
      { id: "a2", role: "assistant", content: "已验证连通性" },
      { id: "u3", role: "user", content: "还有吗" },
      { id: "a3", role: "assistant", content: "本机还有 32 个 Pod" },
      { id: "u4", role: "user", content: "再查一次" },
      { id: "a4", role: "assistant", content: "集群一共 79 个 Pod" },
    ]);

    expect(bubbles).toEqual([
      { id: "a2", prompt: "帮我连接 192.168.5.195" },
      { id: "a3", prompt: "还有吗" },
      { id: "a4", prompt: "再查一次" },
    ]);
    expect(latestAgentQuickBubbleId(bubbles.map((item) => item.id))).toBe("a4");
  });

  it("starts a fresh conversation after launch when the last session already has messages", () => {
    expect(shouldStartFreshAgentConversation([{ id: "a1" }])).toBe(true);
    expect(shouldStartFreshAgentConversation([])).toBe(false);
    expect(latestAgentQuickBubbleId([])).toBe("");
  });

  it("pins the current conversation and fills remaining chips from the most recent sessions", () => {
    const items = [
      { id: "old", title: "旧会话", updatedAt: "2026-08-14T00:00:00.000Z" },
      { id: "mid", title: "中间会话", updatedAt: "2026-08-15T00:00:00.000Z" },
      { id: "new", title: "新对话", updatedAt: "2026-08-16T00:00:00.000Z" },
      { id: "current", title: "当前环境有哪些连接信息", updatedAt: "2026-08-13T00:00:00.000Z" },
    ];
    expect(recentAgentSessionItems(items, "current").map((item) => item.id)).toEqual(["current", "new", "mid"]);
    expect(recentAgentSessionItems(items, "new").map((item) => item.id)).toEqual(["new", "mid", "old"]);
    expect(recentAgentSessionItems(items.slice(0, 2), "old")).toHaveLength(2);
  });

  it("truncates long session titles and keeps short titles intact", () => {
    expect(displayAgentSessionTitle("新对话")).toBe("新对话");
    expect(displayAgentSessionTitle("当前环境有哪些连接信息")).toBe("当前环境有哪些连接信息");
    expect(displayAgentSessionTitle("这个环境的 nginx 是通过什么部署的")).toBe("这个环境的 nginx 是通...");
    expect(displayAgentSessionTitle("这个环境的 nginx 是通过什么部署的", 20)).toBe("这个环境的 nginx 是通过什么部署的");
  });

  it("stacks older quick bubbles behind the latest turn until the user tiles history", () => {
    expect(agentQuickHistoryHiddenCount(1)).toBe(0);
    expect(agentQuickHistoryHiddenCount(3)).toBe(2);
    expect(shouldStackAgentQuickBubbles(3, false)).toBe(true);
    expect(shouldStackAgentQuickBubbles(3, true)).toBe(false);
    expect(shouldStackAgentQuickBubbles(1, false)).toBe(false);
    expect(agentQuickBubbleStackPeekHeight(3)).toBe(24);
    expect(agentQuickBubbleStackStyle(2, 3, false)).toEqual({ zIndex: "3" });
    expect(agentQuickBubbleStackStyle(0, 3, false)).toMatchObject({
      zIndex: "1",
      "--agent-quick-stack-depth": "2",
      "--agent-quick-stack-inset": "8px",
      "--agent-quick-stack-header": "40px",
      "--agent-quick-stack-peek-step": "12px",
    });
    expect(agentQuickBubbleStackStyle(0, 3, true)).toEqual({});
  });

  it("keeps an in-progress assistant reply so a restart can restore the latest bubble", () => {
    expect(agentQuickBubblesFromMessages([
      { id: "u1", role: "user", content: "查看当前的连接有哪些" },
      { id: "a1", role: "assistant", content: "" },
    ])).toEqual([
      { id: "a1", prompt: "查看当前的连接有哪些" },
    ]);
  });
});
