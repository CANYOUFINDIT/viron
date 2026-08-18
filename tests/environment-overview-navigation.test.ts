import { describe, expect, it } from "vitest";
import {
  environmentOverviewNavigationTarget,
  updateRememberedEnvironmentId,
} from "../src/client/environment-overview-navigation.js";

describe("environment overview navigation", () => {
  it("returns to the environment once before opening the overview", () => {
    let rememberedEnvironmentId: string | null = null;

    rememberedEnvironmentId = updateRememberedEnvironmentId(rememberedEnvironmentId, "environment", "environment-a", "overview");
    rememberedEnvironmentId = updateRememberedEnvironmentId(rememberedEnvironmentId, "settings", null, "environment");

    expect(environmentOverviewNavigationTarget("settings", rememberedEnvironmentId)).toEqual({
      name: "environment",
      params: { id: "environment-a" },
    });
    expect(environmentOverviewNavigationTarget("environment", rememberedEnvironmentId)).toEqual({ name: "overview" });

    rememberedEnvironmentId = updateRememberedEnvironmentId(rememberedEnvironmentId, "overview", null, "environment");
    expect(environmentOverviewNavigationTarget("settings", rememberedEnvironmentId)).toEqual({ name: "overview" });
  });

  it("does not create a return target for an environment opened outside the overview flow", () => {
    const rememberedEnvironmentId = updateRememberedEnvironmentId(null, "environment", "environment-a", "settings");

    expect(rememberedEnvironmentId).toBeNull();
    expect(environmentOverviewNavigationTarget("settings", rememberedEnvironmentId)).toEqual({ name: "overview" });
  });

  it("tracks the latest environment while an overview return context is active", () => {
    let rememberedEnvironmentId = updateRememberedEnvironmentId(null, "environment", "environment-a", "overview");
    rememberedEnvironmentId = updateRememberedEnvironmentId(rememberedEnvironmentId, "environment", "environment-b", "environment");

    expect(environmentOverviewNavigationTarget("audit", rememberedEnvironmentId)).toEqual({
      name: "environment",
      params: { id: "environment-b" },
    });
  });
});
