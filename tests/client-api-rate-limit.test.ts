import { afterEach, describe, expect, it, vi } from "vitest";
import { api, clearApiPrefetches } from "../src/client/api.js";
import { onAuthenticationRequired } from "../src/client/authentication-required.js";
import { loadSession, session } from "../src/client/session.js";

function limitedResponse(retryAfter = "1") {
  return new Response(JSON.stringify({ error: "API_RATE_LIMIT", message: "请求过于频繁" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": retryAfter },
  });
}

afterEach(() => {
  clearApiPrefetches();
  session.user = null;
  session.workspace = null;
  session.workspaces = [];
  session.loaded = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client rate-limit recovery", () => {
  it("waits for Retry-After and refreshes authentication without logging out", async () => {
    vi.useFakeTimers();
    const user = { id: "fixture-user", username: "fixture", isPlatformAdmin: false, createdAt: "2026-01-01T00:00:00.000Z" };
    const workspace = { type: "personal" as const, id: user.id, name: "个人工作台", role: "owner" as const };
    session.user = user;
    session.workspace = workspace;
    session.workspaces = [workspace];
    session.loaded = true;
    const fetch = vi.fn()
      .mockResolvedValueOnce(limitedResponse("2"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user, workspace, workspaces: [workspace] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);
    try {
      const pending = loadSession();
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(session.user?.id).toBe(user.id);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("also retries desktop reads using their response headers", async () => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 429, statusText: "Too Many Requests", headers: [["retry-after", "1"]], body: JSON.stringify({ error: "API_RATE_LIMIT", message: "稍后重试" }) })
      .mockResolvedValueOnce({ status: 200, statusText: "OK", headers: [], body: JSON.stringify({ items: ["fixture"] }) });
    vi.stubGlobal("window", { vironDesktop: { request } });

    const pending = api("/api/v1/environments");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ items: ["fixture"] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops after one retry if the server still limits the read", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => limitedResponse());
    vi.stubGlobal("fetch", fetch);

    const rejected = expect(api("/api/v1/environments")).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never automatically repeats a mutation", async () => {
    const fetch = vi.fn().mockImplementation(async () => limitedResponse());
    vi.stubGlobal("fetch", fetch);

    await expect(api("/api/v1/environments", { method: "POST", body: JSON.stringify({ name: "fixture" }) })).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued retry when the caller aborts", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(limitedResponse());
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const rejected = expect(api("/api/v1/environments", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid", "120"])("returns long or invalid cooldowns (%s) without an unbounded wait", async (retryAfter) => {
    const fetch = vi.fn().mockResolvedValue(limitedResponse(retryAfter));
    vi.stubGlobal("fetch", fetch);

    await expect(api("/api/v1/environments")).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
