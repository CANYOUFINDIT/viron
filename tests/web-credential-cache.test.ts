import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebCredentialCache, WEB_CREDENTIAL_CACHE_TTL, clearWebCredentialCaches } from "../src/desktop/web-credential-cache.js";
import type { DesktopWebCredential } from "../src/desktop/device-identity.js";

const owned: WebCredentialCache[] = [];
const credential = (password = "fixture-password"): DesktopWebCredential => ({ credentialId: "fixture-account", entryId: "fixture-entry", entryUrl: "https://console.example.test/login",
  username: "fixture-user", password, customFields: { fixture: "value" }, credentialUpdatedAt: "fixture-version" });
const lease = (value = credential(), ttl = 60_000) => ({ credential: value, expiresAt: new Date(Date.now() + ttl).toISOString() });
function fixture(load = vi.fn(async () => lease())) {
  const scope = { current: true };
  const cache = new WebCredentialCache({ load, current: () => scope.current }); owned.push(cache);
  return { cache, load, scope };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { owned.splice(0).forEach(cache => cache.dispose()); vi.useRealTimers(); });

describe("main-process Web credential cache", () => {
  it("reuses an already fetched credential and returns independent copies", async () => {
    const { cache, load } = fixture();
    const initial = credential(); cache.seed(initial); initial.password = "changed-outside";
    const first = await cache.get(); first.password = "caller-cleared"; first.customFields.fixture = "changed-outside";
    expect(await cache.get()).toEqual(credential()); expect(load).not.toHaveBeenCalled();
  });
  it("merges prefetch and concurrent username/password requests into one lookup", async () => {
    let resolve!: (value: ReturnType<typeof lease>) => void;
    const load = vi.fn(() => new Promise<ReturnType<typeof lease>>(done => { resolve = done; }));
    const { cache } = fixture(load);
    const pending = [cache.get(), cache.get(), cache.get()]; await Promise.resolve(); resolve(lease());
    const results = await Promise.all(pending);
    expect(results.map(value => value.password)).toEqual(Array(3).fill("fixture-password"));
    expect(results[0]).not.toBe(results[1]); expect(load).toHaveBeenCalledOnce();
    expect((await cache.get()).username).toBe("fixture-user"); expect(load).toHaveBeenCalledOnce();
  });
  it("erases cached secrets at 30 seconds and never extends expiry on a hit", async () => {
    const { cache, load } = fixture(); cache.seed(credential());
    const held = (cache as unknown as { value: DesktopWebCredential }).value;
    await vi.advanceTimersByTimeAsync(WEB_CREDENTIAL_CACHE_TTL - 1); await cache.get();
    await vi.advanceTimersByTimeAsync(1);
    expect(held.password).toBe(""); expect(held.username).toBe(""); expect(held.customFields).toEqual({});
    await cache.get(); expect(load).toHaveBeenCalledOnce();
  });
  it("caps retention at the issued envelope expiry", async () => {
    const { cache, load } = fixture(vi.fn(async () => lease(credential(), 1000)));
    await cache.get(); await vi.advanceTimersByTimeAsync(1000); await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("rejects an expired envelope without retaining its credentials", async () => {
    const { cache, load } = fixture(vi.fn(async () => lease(credential(), -1)));
    await expect(cache.get()).rejects.toThrow("credential-lease-expired");
    await expect(cache.get()).rejects.toThrow("credential-lease-expired"); expect(load).toHaveBeenCalledTimes(2);
  });
  it("discards an old in-flight reply when a credential update starts a new request", async () => {
    const resolves: Array<(value: ReturnType<typeof lease>) => void> = [];
    const { cache, load } = fixture(vi.fn(() => new Promise<ReturnType<typeof lease>>(resolve => resolves.push(resolve))));
    const old = expect(cache.get()).rejects.toThrow("credential-cache-invalidated"); await Promise.resolve(); cache.invalidate();
    const fresh = cache.get(); await Promise.resolve(); resolves[1](lease(credential("new-password"))); await fresh;
    resolves[0](lease(credential("old-password"))); await old;
    expect((await cache.get()).password).toBe("new-password"); expect(load).toHaveBeenCalledTimes(2);
  });
  it("clears all accounts on session invalidation and cannot revive a closed view", async () => {
    const first = fixture(), second = fixture(); first.cache.seed(credential()); second.cache.seed(credential());
    clearWebCredentialCaches(); await first.cache.get(); await second.cache.get();
    expect(first.load).toHaveBeenCalledOnce(); expect(second.load).toHaveBeenCalledOnce();
    first.cache.dispose(); await expect(first.cache.get()).rejects.toThrow("credential-cache-expired");
    second.scope.current = false; await expect(second.cache.get()).rejects.toThrow("credential-cache-expired");
  });
  it("isolates caches between views even when credential IDs match", async () => {
    const first = fixture(), second = fixture();
    first.cache.seed(credential("first-workspace")); second.cache.seed(credential("second-workspace"));
    expect((await first.cache.get()).password).toBe("first-workspace"); expect((await second.cache.get()).password).toBe("second-workspace");
  });
});
