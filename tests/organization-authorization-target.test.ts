import { describe, expect, it } from "vitest";
import {
  authorizationOriginText,
  authorizationStatusText,
  featureSubjectText,
  resolveAuthorizationTargets,
} from "../src/client/views/organization/authorization-target";

const catalog = [
  { type: "environment" as const, id: "env-1", environmentIds: [] as string[] },
  { type: "ssh_connection" as const, id: "ssh-1", environmentIds: ["env-1"] },
  { type: "ssh_connection" as const, id: "ssh-2", environmentIds: ["env-2"] },
  { type: "database_connection" as const, id: "db-1", environmentIds: ["env-1"] },
];

describe("authorization target selection", () => {
  it("keeps a pure environment record when data scope does not expand", () => {
    expect(resolveAuthorizationTargets(catalog, ["environment:env-1"], "exact").map((item) => item.id)).toEqual(["env-1"]);
  });

  it("fixes only the resources linked to the environment now", () => {
    expect(resolveAuthorizationTargets(catalog, ["environment:env-1"], "related").map((item) => item.id)).toEqual(["env-1", "ssh-1", "db-1"]);
  });

  it("does not invent a connection for an environment that has none in the selection", () => {
    const bare = catalog.filter((item) => item.id !== "ssh-1" && item.id !== "db-1");
    expect(resolveAuthorizationTargets(bare, ["environment:env-1"], "related").map((item) => item.id)).toEqual(["env-1"]);
  });

  it("keeps an explicitly selected connection without pulling in its siblings", () => {
    expect(resolveAuthorizationTargets(catalog, ["ssh_connection:ssh-1"], "exact").map((item) => item.id)).toEqual(["ssh-1"]);
    expect(resolveAuthorizationTargets(catalog, ["ssh_connection:ssh-1"], "related").map((item) => item.id)).toEqual(["ssh-1"]);
  });
});

describe("authorization display text", () => {
  it("uses readable status, origin, and subject labels", () => {
    expect(authorizationStatusText("pending")).toBe("未生效");
    expect(authorizationOriginText("request")).toBe("审批授权");
    expect(authorizationOriginText("direct")).toBe("直接授权");
    expect(featureSubjectText("user")).toBe("成员");
    expect(featureSubjectText("project")).toBe("子组织");
    expect(featureSubjectText("organization")).toBe("组织及所有成员");
  });
});
