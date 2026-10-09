import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api.js";
import { onAuthenticationRequired } from "../src/client/authentication-required.js";
import { loadSession, logout, session } from "../src/client/session.js";

function seedSession() {
  session.user = { id: "user-1", username: "fixture", isPlatformAdmin: false, createdAt: "2026-01-01T00:00:00.000Z" };
  session.workspace = { type: "personal", id: "user-1", name: "个人工作台", role: "owner" };
  session.workspaces = [session.workspace];
  session.loaded = true;
}

afterEach(() => {
  session.user = null;
  session.workspace = null;
  session.workspaces = [];
  session.loaded = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client authentication expiration", () => {
  it.each([429, 503])("preserves an existing session when its refresh returns HTTP %i", async (status) => {
    seedSession();
    const user = session.user;
    const workspace = session.workspace;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: status === 429 ? "API_RATE_LIMIT" : "SERVICE_UNAVAILABLE",
      message: "暂时无法完成请求",
    }), { status, headers: { "content-type": "application/json" } })));

    await expect(loadSession()).rejects.toMatchObject({ status });
    expect(session.user).toBe(user);
    expect(session.workspace).toBe(workspace);
    expect(session.workspaces).toEqual([workspace]);
    expect(session.loaded).toBe(true);
  });

  it("preserves an existing session on a network failure", async () => {
    seedSession();
    const error = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(loadSession()).rejects.toBe(error);
    expect(session.user?.id).toBe("user-1");
    expect(session.loaded).toBe(true);
  });

  it("leaves initial authentication unresolved after a temporary server failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "暂时不可用" }), { status: 503 })));

    await expect(loadSession()).rejects.toMatchObject({ status: 503 });
    expect(session.loaded).toBe(false);
    expect(session.user).toBeNull();
  });

  it.each(["SESSION_EXPIRED", "UNAUTHENTICATED"])("clears the session only on confirmed %s", async (code) => {
    seedSession();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: code, message: "请先登录" }), { status: 401 })));

    await expect(loadSession()).resolves.toBe(false);
    expect(session.user).toBeNull();
    expect(session.workspace).toBeNull();
    expect(session.workspaces).toEqual([]);
    expect(session.loaded).toBe(true);
  });

  it("publishes an authentication-required signal for expired Web and desktop requests", async () => {
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "SESSION_EXPIRED",
      message: "登录已过期",
    }), { status: 401, headers: { "content-type": "application/json" } })));

    await expect(api("/api/v1/environments")).rejects.toMatchObject<ApiError>({
      status: 401,
      code: "SESSION_EXPIRED",
    });

    vi.stubGlobal("window", {
      vironDesktop: {
        request: vi.fn().mockResolvedValue({
          status: 401,
          statusText: "Unauthorized",
          headers: [],
          body: JSON.stringify({ error: "UNAUTHENTICATED", message: "请先登录" }),
        }),
      },
    });
    await expect(api("/api/v1/settings")).rejects.toMatchObject<ApiError>({
      status: 401,
      code: "UNAUTHENTICATED",
    });

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("treats logout as complete when the server session has already expired", async () => {
    session.user = { id: "user-1", username: "admin", isPlatformAdmin: true, createdAt: "2026-08-05T00:00:00.000Z" };
    session.workspace = { type: "personal", id: "user-1", name: "个人工作台", role: "owner" };
    session.workspaces = [session.workspace];
    session.loaded = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "SESSION_EXPIRED",
      message: "登录已过期",
    }), { status: 401, headers: { "content-type": "application/json" } })));

    await expect(logout()).resolves.toBe("session-expired");
    expect(session.user).toBeNull();
    expect(session.workspace).toBeNull();
    expect(session.workspaces).toEqual([]);
  });
});
