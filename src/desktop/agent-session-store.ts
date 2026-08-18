import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentChatMessage,
  AgentConversation,
  AgentConversationListResult,
  AgentConversationSummary,
} from "../shared/agent.js";
import { agentTurnDurationMs, agentTurnUsage } from "../shared/agent-turn-stats.js";
import { redactAgentSensitiveText } from "../shared/agent-redaction.js";
import type { AgentSettingsScope } from "./agent-settings.js";

interface StoredAgentConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentChatMessage[];
}

interface StoredAgentConversationScope {
  currentSessionId?: string;
  sessions?: StoredAgentConversation[];
}

interface StoredAgentConversationFile {
  scopes?: Record<string, StoredAgentConversationScope>;
}

const MAX_SESSIONS = 80;
const MAX_MESSAGES = 240;
const MAX_MESSAGE_LENGTH = 32_000;
const MAX_TITLE_LENGTH = 80;

function storePath(userDataPath: string): string {
  return join(userDataPath, "ai-agent-sessions.json");
}

function scopeKey(scope: AgentSettingsScope): string {
  return createHash("sha256").update(`${scope.vironEndpoint}\0${scope.vironUserId}`).digest("hex");
}

function readStore(userDataPath: string): StoredAgentConversationFile {
  try {
    return JSON.parse(readFileSync(storePath(userDataPath), "utf8")) as StoredAgentConversationFile;
  } catch {
    return {};
  }
}

function writeStore(userDataPath: string, value: StoredAgentConversationFile): void {
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(storePath(userDataPath), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizedTitle(value: string): string {
  const title = redactAgentSensitiveText(value).replace(/\s+/g, " ").trim();
  return (title || "新对话").slice(0, MAX_TITLE_LENGTH);
}

function normalizedMessage(message: AgentChatMessage): AgentChatMessage {
  const durationMs = agentTurnDurationMs(message.durationMs);
  const usage = agentTurnUsage(message.usage);
  return {
    id: message.id.slice(0, 200),
    role: message.role,
    content: redactAgentSensitiveText(message.content).slice(0, MAX_MESSAGE_LENGTH),
    createdAt: Number.isNaN(Date.parse(message.createdAt)) ? new Date().toISOString() : message.createdAt,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(usage ? { usage } : {}),
  };
}

function summary(session: StoredAgentConversation): AgentConversationSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

function isUnusedNewSession(session: StoredAgentConversation): boolean {
  return session.title === "新对话" && session.messages.length === 0;
}

export class DesktopAgentSessionStore {
  constructor(private readonly userDataPath: string) {}

  list(scope: AgentSettingsScope): AgentConversationListResult {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope);
    writeStore(this.userDataPath, state);
    return {
      currentSessionId: scoped.currentSessionId!,
      items: scoped.sessions!.map(summary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  current(scope: AgentSettingsScope): AgentConversation {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope);
    const session = scoped.sessions!.find((item) => item.id === scoped.currentSessionId) ?? scoped.sessions![0];
    scoped.currentSessionId = session.id;
    writeStore(this.userDataPath, state);
    return { ...summary(session), messages: session.messages.map(normalizedMessage) };
  }

  get(scope: AgentSettingsScope, sessionId: string): AgentConversation {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope);
    const session = scoped.sessions!.find((item) => item.id === sessionId);
    if (!session) throw new Error("Viron Agent 历史会话不存在");
    return { ...summary(session), messages: session.messages.map(normalizedMessage) };
  }

  create(scope: AgentSettingsScope, title = "新对话"): AgentConversation {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope, false);
    const requestedTitle = normalizedTitle(title);
    const reusable = requestedTitle === "新对话" ? this.unusedNewSession(scoped) : undefined;
    if (reusable) {
      scoped.currentSessionId = reusable.id;
      writeStore(this.userDataPath, state);
      return { ...summary(reusable), messages: [] };
    }
    const session = this.newSession(requestedTitle);
    scoped.sessions = [session, ...(scoped.sessions ?? [])].slice(0, MAX_SESSIONS);
    scoped.currentSessionId = session.id;
    writeStore(this.userDataPath, state);
    return { ...summary(session), messages: [] };
  }

  select(scope: AgentSettingsScope, sessionId: string): AgentConversation {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope);
    const session = scoped.sessions!.find((item) => item.id === sessionId);
    if (!session) throw new Error("Viron Agent 历史会话不存在");
    scoped.currentSessionId = session.id;
    writeStore(this.userDataPath, state);
    return { ...summary(session), messages: session.messages.map(normalizedMessage) };
  }

  rename(scope: AgentSettingsScope, sessionId: string, title: string): AgentConversationSummary {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope);
    const session = scoped.sessions!.find((item) => item.id === sessionId);
    if (!session) throw new Error("Viron Agent 历史会话不存在");
    session.title = normalizedTitle(title);
    session.updatedAt = new Date().toISOString();
    writeStore(this.userDataPath, state);
    return summary(session);
  }

  delete(scope: AgentSettingsScope, sessionId: string): AgentConversation {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope);
    const remaining = scoped.sessions!.filter((item) => item.id !== sessionId);
    if (remaining.length === scoped.sessions!.length) throw new Error("Viron Agent 历史会话不存在");
    if (!remaining.length) remaining.push(this.newSession());
    scoped.sessions = remaining;
    if (scoped.currentSessionId === sessionId) scoped.currentSessionId = remaining[0].id;
    writeStore(this.userDataPath, state);
    const current = remaining.find((item) => item.id === scoped.currentSessionId) ?? remaining[0];
    return { ...summary(current), messages: current.messages.map(normalizedMessage) };
  }

  append(scope: AgentSettingsScope, sessionId: string, message: AgentChatMessage): AgentConversation {
    const state = readStore(this.userDataPath);
    const scoped = this.ensureScope(state, scope);
    const session = scoped.sessions!.find((item) => item.id === sessionId);
    if (!session) throw new Error("Viron Agent 历史会话不存在");
    const normalized = normalizedMessage(message);
    const existing = session.messages.find((item) => item.id === normalized.id);
    if (existing) Object.assign(existing, normalized);
    else session.messages.push(normalized);
    session.messages = session.messages.slice(-MAX_MESSAGES);
    if (session.title === "新对话" && normalized.role === "user") session.title = normalizedTitle(normalized.content);
    session.updatedAt = normalized.createdAt;
    scoped.currentSessionId = session.id;
    writeStore(this.userDataPath, state);
    return { ...summary(session), messages: session.messages.map(normalizedMessage) };
  }

  private ensureScope(state: StoredAgentConversationFile, scope: AgentSettingsScope, createSession = true): StoredAgentConversationScope {
    const key = scopeKey(scope);
    state.scopes ??= {};
    const scoped = state.scopes[key] ??= {};
    scoped.sessions = Array.isArray(scoped.sessions) ? scoped.sessions : [];
    if (createSession && !scoped.sessions.length) scoped.sessions.push(this.newSession());
    this.collapseUnusedNewSessions(scoped);
    if (scoped.sessions.length && !scoped.sessions.some((item) => item.id === scoped.currentSessionId)) {
      scoped.currentSessionId = scoped.sessions[0].id;
    }
    return scoped;
  }

  private unusedNewSession(scoped: StoredAgentConversationScope): StoredAgentConversation | undefined {
    return (scoped.sessions ?? []).find((session) => isUnusedNewSession(session));
  }

  private collapseUnusedNewSessions(scoped: StoredAgentConversationScope): void {
    const unused = (scoped.sessions ?? []).filter((session) => isUnusedNewSession(session));
    if (unused.length <= 1) return;
    const keep = unused.find((session) => session.id === scoped.currentSessionId)
      ?? unused.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    scoped.sessions = (scoped.sessions ?? []).filter((session) => !isUnusedNewSession(session) || session.id === keep.id);
    if (scoped.currentSessionId && unused.some((session) => session.id === scoped.currentSessionId)) {
      scoped.currentSessionId = keep.id;
    }
  }

  private newSession(title = "新对话"): StoredAgentConversation {
    const now = new Date().toISOString();
    return { id: randomUUID(), title: normalizedTitle(title), createdAt: now, updatedAt: now, messages: [] };
  }
}
