import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAgentSessionStore } from "../src/desktop/agent-session-store.js";
import type { AgentChatMessage } from "../src/shared/agent.js";

const tempDirectories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "viron-agent-sessions-"));
  tempDirectories.push(directory);
  return { directory, store: new DesktopAgentSessionStore(directory) };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Desktop Agent session store", () => {
  it("isolates sessions by Endpoint and user but not by workspace", () => {
    const { store } = createStore();
    const firstScope = { vironEndpoint: "https://viron.example", vironUserId: "u1", workspaceType: "organization", workspaceId: "o1" };
    const first = store.current(firstScope);
    store.append(firstScope, first.id, { id: "u-1", role: "user", content: "跨工作空间问题", createdAt: "2026-08-14T00:00:00.000Z" });

    const otherWorkspace = store.current({ ...firstScope, workspaceId: "o2" });
    expect(otherWorkspace.id).toBe(first.id);
    expect(otherWorkspace.messages[0]?.content).toBe("跨工作空间问题");
    expect(store.current({ ...firstScope, vironUserId: "u2" }).id).not.toBe(first.id);
    expect(store.current({ ...firstScope, vironEndpoint: "https://other.example" }).id).not.toBe(first.id);
  });

  it("creates, selects, renames, lists, and deletes historical conversations", () => {
    const { store } = createStore();
    const scope = { vironEndpoint: "https://viron.example", vironUserId: "u1" };
    const initial = store.current(scope);
    const created = store.create(scope, "排查数据库");
    expect(store.list(scope).currentSessionId).toBe(created.id);
    expect(store.select(scope, initial.id).id).toBe(initial.id);
    expect(store.rename(scope, initial.id, "  服务   排查  ").title).toBe("服务 排查");
    expect(store.list(scope).items).toHaveLength(2);
    expect(store.delete(scope, initial.id).id).toBe(created.id);
    expect(store.list(scope).items.map((item) => item.id)).toEqual([created.id]);
  });

  it("reuses the unused new conversation instead of creating another empty one", () => {
    const { store } = createStore();
    const scope = { vironEndpoint: "https://viron.example", vironUserId: "u1" };
    const initial = store.current(scope);
    expect(store.create(scope).id).toBe(initial.id);
    expect(store.list(scope).items).toHaveLength(1);

    store.append(scope, initial.id, { id: "u-1", role: "user", content: "查看连接", createdAt: "2026-08-16T00:00:00.000Z" });
    const fresh = store.create(scope);
    expect(fresh.id).not.toBe(initial.id);
    expect(fresh.title).toBe("新对话");
    expect(fresh.messages).toEqual([]);
    expect(store.create(scope).id).toBe(fresh.id);
    expect(store.list(scope).items).toHaveLength(2);
  });

  it("collapses leftover unused new conversations down to one", () => {
    const { directory, store } = createStore();
    const scope = { vironEndpoint: "https://viron.example", vironUserId: "u1" };
    store.current(scope);
    const raw = JSON.parse(readFileSync(join(directory, "ai-agent-sessions.json"), "utf8")) as {
      scopes: Record<string, { currentSessionId: string; sessions: Array<{ id: string; title: string; createdAt: string; updatedAt: string; messages: unknown[] }> }>;
    };
    const scoped = Object.values(raw.scopes)[0];
    scoped.sessions.push({
      id: "unused-older",
      title: "新对话",
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      messages: [],
    });
    writeFileSync(join(directory, "ai-agent-sessions.json"), `${JSON.stringify(raw, null, 2)}\n`);

    const listed = store.list(scope);
    expect(listed.items.filter((item) => item.title === "新对话" && item.messageCount === 0)).toHaveLength(1);
    expect(store.create(scope).id).toBe(listed.currentSessionId);
  });

  it("persists only bounded user and assistant text with common secrets redacted", () => {
    const { directory, store } = createStore();
    const scope = { vironEndpoint: "https://viron.example", vironUserId: "u1" };
    const conversation = store.current(scope);
    store.append(scope, conversation.id, {
      id: "user-secret",
      role: "user",
      content: "password=hunter2 Authorization: Bearer abcdefghijklmnop",
      createdAt: "2026-08-14T00:00:00.000Z",
      toolCalls: [{ name: "should-not-persist" }],
    } as unknown as AgentChatMessage);
    store.append(scope, conversation.id, {
      id: "assistant-secret",
      role: "assistant",
      content: "postgres://admin:supersecret@db.example/app",
      createdAt: "2026-08-14T00:00:01.000Z",
    });

    const raw = readFileSync(join(directory, "ai-agent-sessions.json"), "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain("toolCalls");
    expect(raw).toContain("[REDACTED]");
    expect(store.current(scope).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("persists assistant turn duration and token usage without extra fields", () => {
    const { directory, store } = createStore();
    const scope = { vironEndpoint: "https://viron.example", vironUserId: "u1" };
    const conversation = store.current(scope);
    store.append(scope, conversation.id, {
      id: "assistant-usage",
      role: "assistant",
      content: "已完成检查",
      createdAt: "2026-08-15T00:00:00.000Z",
      durationMs: 1240,
      usage: { input: 2100, output: 1280, cacheRead: 80, cacheWrite: 0, totalTokens: 3460, cost: 9 } as never,
    });

    const stored = store.current(scope).messages[0];
    expect(stored).toMatchObject({
      durationMs: 1240,
      usage: { input: 2100, output: 1280, cacheRead: 80, cacheWrite: 0, totalTokens: 3460 },
    });
    expect(stored.usage).not.toHaveProperty("cost");
    expect(readFileSync(join(directory, "ai-agent-sessions.json"), "utf8")).toContain("\"totalTokens\": 3460");
  });
});
