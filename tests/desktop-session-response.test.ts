import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/desktop/endpoint-context.js", () => ({
  activeEndpoint: { endpoint: "https://endpoint.example.test", protocolVersion: 2, partition: { fetch: fixture.fetch } },
  currentExecutionMode: () => "local",
  executionScopeForEndpoint: () => "fixture-scope",
}));

import { endpointSessionResponse } from "../src/desktop/http-proxy.js";

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("desktop session response deadline", () => {
  it("aborts a request that never responds and releases its timeout", async () => {
    fixture.fetch.mockReturnValue(new Promise(() => undefined));
    const pending = endpointSessionResponse({ path: "/api/v1/auth/me" });
    const result = expect(pending).rejects.toMatchObject({ code: "ENDPOINT_TIMEOUT", status: 504 });
    await vi.advanceTimersByTimeAsync(12_000);
    await result;
    expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also times out when response headers arrive but the body stalls", async () => {
    fixture.fetch.mockResolvedValue({ text: () => new Promise(() => undefined) });
    const pending = endpointSessionResponse({ path: "/api/v1/auth/me" });
    const result = expect(pending).rejects.toMatchObject({ code: "ENDPOINT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(12_000);
    await result;
    expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("returns the response and cleans up its deadline on success", async () => {
    const response = new Response('{"user":null}', { status: 401 });
    fixture.fetch.mockResolvedValue(response);
    await expect(endpointSessionResponse({ path: "/api/v1/auth/me" })).resolves.toEqual({ response, body: '{"user":null}' });
    expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
