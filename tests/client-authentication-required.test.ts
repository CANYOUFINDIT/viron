import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api.js";
import { onAuthenticationRequired } from "../src/client/authentication-required.js";
import { logout, session } from "../src/client/session.js";

afterEach(() => {
  session.user = null;
  session.workspace = null;
  session.workspaces = [];
  session.loaded = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client authentication expiration", () => {
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
