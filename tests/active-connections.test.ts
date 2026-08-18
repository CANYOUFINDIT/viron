import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../src/server/access-control.js";
import { ActiveConnectionManager, ConnectionLimitError } from "../src/server/active-connections.js";

function user(id: string, isPlatformAdmin = false): AuthenticatedUser {
  return {
    id,
    username: id,
    isPlatformAdmin,
    workspace: { type: "personal", id, name: "个人工作台", role: "owner" },
  };
}

function manager(limit = 2, idleMinutes = 30) {
  const app = {
    config: { userConnectionLimit: limit, connectionIdleMinutes: idleMinutes, terminalIdleMinutes: idleMinutes },
    db: {
      prepare: () => ({
        get: async () => undefined,
        all: async () => [],
      }),
    },
    log: { error: vi.fn() },
  } as unknown as FastifyInstance;
  return new ActiveConnectionManager(app);
}

describe("active connection manager", () => {
  it("enforces one global per-user limit across types and execution scopes", async () => {
    const connections = manager(2);
    const owner = user("owner");
    await connections.reserve({ user: owner, type: "ssh", resourceId: crypto.randomUUID() });
    await connections.reserve({ user: owner, type: "web", resourceId: crypto.randomUUID(), executionScope: crypto.randomUUID() });

    await expect(connections.reserve({ user: owner, type: "database", resourceId: crypto.randomUUID() }))
      .rejects.toBeInstanceOf(ConnectionLimitError);
    expect(connections.activeCount(owner.id)).toBe(2);
    connections.stop();
  });

  it("preserves the environment that launched a connection independently of its associations", async () => {
    const connections = manager(3);
    const owner = user("owner");
    const originEnvironmentId = crypto.randomUUID();
    const environmentConnection = await connections.reserve({
      user: owner,
      type: "ssh",
      resourceId: crypto.randomUUID(),
      originEnvironmentId,
    });
    const workbenchConnection = await connections.reserve({
      user: owner,
      type: "database",
      resourceId: crypto.randomUUID(),
    });

    expect(environmentConnection.originEnvironmentId).toBe(originEnvironmentId);
    expect(workbenchConnection.originEnvironmentId).toBeNull();
    expect(connections.list(owner)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: environmentConnection.id, originEnvironmentId }),
      expect.objectContaining({ id: workbenchConnection.id, originEnvironmentId: null }),
    ]));
    connections.stop();
  });

  it("records the single environment as the origin for environment-only Web connections", async () => {
    const environmentId = crypto.randomUUID();
    const app = {
      config: { userConnectionLimit: 3, connectionIdleMinutes: 30, terminalIdleMinutes: 30 },
      db: {
        prepare: (sql: string) => ({
          get: async () => sql.includes("FROM web_credentials") ? { username: "operator", name: "Console" } : undefined,
          all: async () => sql.includes("JOIN environments") ? [{ id: environmentId, name: "开发环境" }] : [],
        }),
      },
      log: { error: vi.fn() },
    } as unknown as FastifyInstance;
    const connections = new ActiveConnectionManager(app);

    const item = await connections.reserve({ user: user("owner"), type: "web", resourceId: crypto.randomUUID() });

    expect(item.originEnvironmentId).toBe(environmentId);
    connections.stop();
  });

  it("limits ordinary users to their own list and lets platform admins close any connection", async () => {
    const connections = manager(3);
    const owner = user("owner");
    const other = user("other");
    const admin = user("admin", true);
    const closed = vi.fn();
    const item = await connections.reserve({ user: owner, type: "ssh", resourceId: crypto.randomUUID() });
    connections.activate(item.id, closed);

    expect(connections.list(other)).toEqual([]);
    expect(connections.list(admin)).toHaveLength(1);
    expect(await connections.closeForViewer(item.id, other, "无权关闭")).toBeUndefined();
    expect(await connections.closeForViewer(item.id, admin, "管理员关闭")).toMatchObject({ id: item.id });
    expect(closed).toHaveBeenCalledWith("管理员关闭");
    expect(connections.activeCount(owner.id)).toBe(0);
    connections.stop();
  });

  it("reconciles desktop leases without allowing one execution scope to touch another", async () => {
    const connections = manager(3);
    const owner = user("owner");
    const leftScope = crypto.randomUUID();
    const rightScope = crypto.randomUUID();
    const left = await connections.reserve({ id: crypto.randomUUID(), user: owner, type: "ssh", resourceId: crypto.randomUUID(), executionScope: leftScope, external: true });
    const right = await connections.reserve({ id: crypto.randomUUID(), user: owner, type: "logs", resourceId: crypto.randomUUID(), executionScope: rightScope, external: true });

    connections.syncExternal(owner.id, leftScope, [{ id: right.id, lastActivityAt: Date.now() }, { id: left.id, lastActivityAt: Date.now() }]);
    expect(connections.list(owner, leftScope).find((item) => item.id === left.id)?.currentExecutionInstance).toBe(true);
    expect(connections.list(owner, leftScope).find((item) => item.id === right.id)?.currentExecutionInstance).toBe(false);
    expect(connections.getForExecutionScope(left.id, owner, leftScope)).toBeDefined();
    expect(connections.getForExecutionScope(right.id, owner, leftScope)).toBeUndefined();
    expect(connections.get(left.id, owner)).toBeDefined();
    expect(connections.get(right.id, owner)).toBeDefined();
    connections.syncExternal(owner.id, leftScope, []);
    expect(connections.get(left.id, owner)).toBeUndefined();
    expect(connections.get(right.id, owner)).toBeDefined();
    connections.stop();
  });

  it("keeps a new desktop reservation until its first heartbeat", async () => {
    const connections = manager(3);
    const owner = user("owner");
    const scope = crypto.randomUUID();
    const item = await connections.reserve({
      id: crypto.randomUUID(),
      user: owner,
      type: "ssh",
      resourceId: crypto.randomUUID(),
      executionScope: scope,
      external: true,
    });

    connections.syncExternal(owner.id, scope, []);
    expect(connections.get(item.id, owner)).toBeDefined();

    connections.syncExternal(owner.id, scope, [{ id: item.id, lastActivityAt: Date.now() }]);
    connections.syncExternal(owner.id, scope, []);
    expect(connections.get(item.id, owner)).toBeUndefined();
    connections.stop();
  });

  it("closes an inactive connection after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const connections = manager(2, 1);
      const owner = user("owner");
      const closed = vi.fn();
      const item = await connections.reserve({ user: owner, type: "ssh", resourceId: crypto.randomUUID() });
      connections.activate(item.id, closed);

      await vi.advanceTimersByTimeAsync(65_000);
      expect(closed).toHaveBeenCalledWith("空闲超过 1 分钟");
      expect(connections.activeCount(owner.id)).toBe(0);
      connections.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rolling per-connection traffic without exposing internal buckets", async () => {
    vi.useFakeTimers();
    try {
      const connections = manager();
      const owner = user("owner");
      const item = await connections.reserve({ user: owner, type: "ssh", resourceId: crypto.randomUUID() });
      connections.recordTraffic(item.id, { sentBytes: 2_000, receivedBytes: 4_000 });

      expect(connections.get(item.id, owner)?.traffic).toMatchObject({
        sentBytes: 2_000,
        receivedBytes: 4_000,
        sentBytesPerSecond: 2_000,
        receivedBytesPerSecond: 4_000,
      });
      await vi.advanceTimersByTimeAsync(5_100);
      expect(connections.get(item.id, owner)?.traffic).toMatchObject({
        sentBytes: 2_000,
        receivedBytes: 4_000,
        sentBytesPerSecond: 0,
        receivedBytesPerSecond: 0,
      });
      connections.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
