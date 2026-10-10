import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  activeEndpoint: null as null | { endpoint: string; partition: unknown },
  recentEndpoint: undefined as string | undefined,
  partition: { fetch: vi.fn(), cookies: { remove: vi.fn(), flushStore: vi.fn() } },
  endpointSession: vi.fn(),
  closeSockets: vi.fn(),
  closeExecution: vi.fn(),
  closeMcp: vi.fn(),
  closeWebViews: vi.fn(),
}));

vi.mock("../src/desktop/app-state.js", () => ({ readState: () => ({ recentEndpoint: fixture.recentEndpoint }) }));
vi.mock("../src/desktop/device-session.js", () => ({ endpointSession: fixture.endpointSession }));
vi.mock("../src/desktop/endpoint-context.js", () => ({
  get activeEndpoint() { return fixture.activeEndpoint; },
  setActiveEndpoint: (next: null) => { fixture.activeEndpoint = next; },
}));
vi.mock("../src/desktop/execution-router.js", () => ({
  closeAllServiceSockets: fixture.closeSockets, closeDesktopExecution: fixture.closeExecution,
}));
vi.mock("../src/desktop/mcp-desktop-bridge.js", () => ({ closeDesktopMcpOperations: fixture.closeMcp }));
vi.mock("../src/desktop/web-view-runtime.js", () => ({ closeAllDesktopWebViews: fixture.closeWebViews }));

import { logoutDesktopEndpoint } from "../src/desktop/endpoint-logout.js";

beforeEach(() => {
  vi.resetAllMocks();
  fixture.activeEndpoint = { endpoint: "https://endpoint-a.example.test", partition: fixture.partition };
  fixture.recentEndpoint = "https://endpoint-b.example.test";
  fixture.endpointSession.mockReturnValue(fixture.partition);
  fixture.partition.fetch.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => vi.useRealTimers());

describe("desktop Endpoint logout", () => {
  it.each(["online", "connection-refused", "server-error"])("clears only the current Endpoint session when %s", async (state) => {
    if (state === "connection-refused") fixture.partition.fetch.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    if (state === "server-error") fixture.partition.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    fixture.closeExecution.mockImplementation(() => {
      expect(fixture.activeEndpoint).toBeNull();
      return Promise.resolve();
    });

    await expect(logoutDesktopEndpoint()).resolves.toBeUndefined();

    expect(fixture.partition.fetch).toHaveBeenCalledWith("https://endpoint-a.example.test/api/v1/auth/logout", expect.objectContaining({ method: "POST" }));
    expect(fixture.partition.cookies.remove).toHaveBeenCalledExactlyOnceWith("https://endpoint-a.example.test", "envman_session");
    expect(fixture.partition.cookies.flushStore).toHaveBeenCalledOnce();
    expect(fixture.endpointSession).not.toHaveBeenCalled();
    expect(fixture.closeSockets).toHaveBeenCalledOnce();
    expect(fixture.closeMcp).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.closeExecution).toHaveBeenCalledOnce();
    expect(fixture.closeWebViews).toHaveBeenCalledOnce();
  });

  it("finishes local logout when the Endpoint never responds", async () => {
    vi.useFakeTimers();
    fixture.partition.fetch.mockReturnValue(new Promise(() => undefined));
    const pending = logoutDesktopEndpoint();
    expect(fixture.activeEndpoint).toBeNull();
    expect(fixture.closeSockets).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBeUndefined();
    expect(fixture.partition.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(fixture.partition.cookies.remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the saved Endpoint cookie even if startup could not validate it", async () => {
    fixture.activeEndpoint = null;
    fixture.partition.fetch.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));

    await logoutDesktopEndpoint();

    expect(fixture.endpointSession).toHaveBeenCalledExactlyOnceWith("https://endpoint-b.example.test");
    expect(fixture.partition.cookies.remove).toHaveBeenCalledExactlyOnceWith("https://endpoint-b.example.test", "envman_session");
  });

  it("returns to a clean state when no Endpoint was ever selected", async () => {
    fixture.activeEndpoint = null;
    fixture.recentEndpoint = undefined;
    await logoutDesktopEndpoint();
    expect(fixture.partition.fetch).not.toHaveBeenCalled();
    expect(fixture.closeExecution).toHaveBeenCalledOnce();
  });
});
