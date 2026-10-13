import { describe, expect, it } from "vitest";
import type { NamedCatalogItem } from "../src/client/views/organization/grant-selection";
import { applicationEnvironmentState, durationMilliseconds, linkedEnvironmentState, toggleApplicationEnvironment, toggleLinkedEnvironment } from "../src/client/views/organization/grant-selection";

const catalog: NamedCatalogItem[] = [
  { type: "environment", id: "env-empty", name: "空环境", environmentIds: ["env-empty"] },
  { type: "environment", id: "env-a", name: "环境甲", environmentIds: ["env-a"] },
  { type: "ssh_connection", id: "ssh-a", name: "连接甲", environmentIds: ["env-a"] },
  { type: "ssh_connection", id: "ssh-free", name: "独立连接", environmentIds: [] },
];

describe("grant target selection", () => {
  it("keeps an empty environment and fixes the current linked resources", () => {
    const selected = toggleApplicationEnvironment(catalog, [], "env-empty", true);
    expect(selected).toEqual([{ type: "environment", id: "env-empty" }]);
    expect(applicationEnvironmentState(catalog, selected, "env-empty")).toBe("empty-on");
    const batch = toggleApplicationEnvironment(catalog, [], "env-a", true);
    expect(batch).toEqual([
      { type: "ssh_connection", id: "ssh-a" },
      { type: "environment", id: "env-a" },
    ]);
    expect(toggleApplicationEnvironment(catalog, batch, "env-a", false)).toEqual([]);
  });

  it("still batches approval scope by linked resources without adding the environment", () => {
    const selected = toggleLinkedEnvironment(catalog, [], "env-a", true);
    expect(selected).toEqual([{ type: "ssh_connection", id: "ssh-a" }]);
    expect(linkedEnvironmentState(catalog, selected, "env-a")).toBe("on");
    expect(linkedEnvironmentState(catalog, selected, "env-empty")).toBe("empty");
  });

  it("accepts minute, hour, day, and permanent durations", () => {
    expect(durationMilliseconds(30, "minute")).toBe(1_800_000);
    expect(durationMilliseconds(2, "hour")).toBe(7_200_000);
    expect(durationMilliseconds(3, "day")).toBe(259_200_000);
    expect(durationMilliseconds(0, "day")).toBeNull();
  });
});
