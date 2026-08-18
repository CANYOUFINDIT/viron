import { describe, expect, it } from "vitest";
import { agentContextCardDisplay, agentSceneName } from "../src/client/agent-context-card-display.js";
import type { AgentContextCard } from "../src/shared/agent.js";

function card(input: Partial<AgentContextCard>): AgentContextCard {
  return {
    id: "context-1",
    kind: "scene",
    title: "环境详情",
    summary: "不用于卡片展示",
    source: "/environments/context-1",
    createdAt: "2026-07-29T00:00:00.000Z",
    ...input,
  };
}

describe("Agent context card display", () => {
  it("uses meaningful names for known product pages", () => {
    expect(agentSceneName("overview")).toBe("环境总览");
    expect(agentSceneName("ssh-keys")).toBe("SSH 密钥");
    expect(agentSceneName("audit")).toBe("操作审计");
    expect(agentSceneName(Symbol("unknown"))).toBe("当前页面");
  });

  it("separates SSH names from their type", () => {
    expect(agentContextCardDisplay(card({ kind: "ssh", title: "SSH · 192.168.5.195" }))).toEqual({
      name: "192.168.5.195",
      typeLabel: "SSH",
    });
  });

  it("separates database names from their type", () => {
    expect(agentContextCardDisplay(card({ kind: "database", title: "数据库 · mysql-prod / viron" }))).toEqual({
      name: "mysql-prod / viron",
      typeLabel: "数据库",
    });
  });

  it("keeps page names and labels them as pages", () => {
    expect(agentContextCardDisplay(card({ title: "环境详情" }))).toEqual({ name: "环境详情", typeLabel: "页面" });
  });
});
