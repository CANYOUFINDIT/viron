import { describe, expect, it } from "vitest";
import { containsPersistedWebLoginSecret as contains } from "../src/shared/web-login-storage.js";

describe("persisted Web login secret inspection", () => {
  const identity = "fixture-identity";
  it("accepts the known username in a structured token without exempting actual password fields", () => {
    expect(contains(JSON.stringify({ accessToken: "opaque-token", username: identity }), identity, identity)).toBe(false);
    expect(contains(JSON.stringify({ username: identity, password: identity }), identity, identity)).toBe(true);
    expect(contains(identity, identity, identity, "username")).toBe(false);
    expect(contains(identity, identity, identity, "password")).toBe(true);
    expect(contains(identity, identity, identity)).toBe(true);
  });
  it("requires an exact known identity and keeps nested or unstructured secret values blocked", () => {
    expect(contains({ username: "other-fixture-secret" }, "fixture-secret", identity)).toBe(true);
    expect(contains({ auth: { password: "fixture-secret" } }, "fixture-secret", identity)).toBe(true);
    expect(contains("prefix fixture-secret suffix", "fixture-secret", identity)).toBe(true);
    expect(contains(new Map([["password", "fixture-secret"]]), "fixture-secret", identity)).toBe(true);
    expect(contains(new TextEncoder().encode('fixture-secret'), "fixture-secret", identity)).toBe(true);
    expect(contains(JSON.stringify({ password: 123456 }), "123456", identity)).toBe(true);
    expect(contains(JSON.stringify({ "fixture-secret": "cached" }), "fixture-secret", identity)).toBe(true);
    const cycle: Record<string, unknown> = { password: "fixture-secret" }; cycle.self = cycle;
    expect(contains(cycle, "fixture-secret", identity)).toBe(true);
  });
  it("checks JSON escaped secrets rather than only their serialized bytes", () => {
    expect(contains(JSON.stringify({ password: 'fixture-"secret' }), 'fixture-"secret', identity)).toBe(true);
    expect(contains('{"password":"\\u0073ecret"}', "secret", identity)).toBe(true);
    expect(contains('"secret"', "secret", identity)).toBe(true);
  });
});
