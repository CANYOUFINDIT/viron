import { afterEach, describe, expect, it, vi } from "vitest";
import { api, clearApiPrefetches, prefetchApi, transientApi } from "../src/client/api.js";

afterEach(() => {
  clearApiPrefetches();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client API prefetch", () => {
  it("consumes one prefetched GET response without sending a duplicate request", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: ["ssh"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const pending = prefetchApi<{ items: string[] }>("/api/v1/connections?type=ssh");
    await expect(api<{ items: string[] }>("/api/v1/connections?type=ssh")).resolves.toEqual({ items: ["ssh"] });
    await expect(pending).resolves.toEqual({ items: ["ssh"] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("invalidates prefetched reads before a mutation", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: ["stale"] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: ["fresh"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await prefetchApi("/api/v1/environments/environment-1/logs");
    await api("/api/v1/environment-logs/log-1", { method: "DELETE" });
    await expect(api<{ items: string[] }>("/api/v1/environments/environment-1/logs")).resolves.toEqual({ items: ["fresh"] });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps prefetched business data across an ephemeral runtime cleanup", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: ["logs"] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await prefetchApi("/api/v1/environments/environment-1/logs");
    await transientApi("/api/v1/web-credentials/credential-1/view", { method: "DELETE" });
    await expect(api<{ items: string[] }>("/api/v1/environments/environment-1/logs")).resolves.toEqual({ items: ["logs"] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
