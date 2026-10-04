import { describe, expect, it } from "vitest";
import { grantEnvironmentIds, grantPermissionRows, type GrantScopeResource } from "../src/client/views/organization/grant-permission-details";

const resources: GrantScopeResource[] = [
  { id: "env-1", name: "示例环境", type: "environment", groupId: "group-1" },
  { id: "env-2", name: "第二个环境", type: "environment", groupId: "group-1" },
  { id: "env-3", name: "其他组", type: "environment", groupId: "group-2" },
  { id: "ssh-1", name: "示例主机", type: "ssh_connection" },
];

describe("grant permission details", () => {
  it("uses current group members for whole-group scopes and deduplicates individual targets", () => {
    expect(grantEnvironmentIds({ resourceId: "group-1", groupId: "group-1", wholeGroup: true, scopeKind: "environment_group" }, resources)).toEqual(["env-1", "env-2"]);
    expect(grantEnvironmentIds({ resourceId: "env-1", scopeKind: "environment", targetIds: ["env-1", "env-1", "env-2"] }, resources)).toEqual(["env-1", "env-2"]);
    expect(grantEnvironmentIds({ resourceId: "ssh-1", scopeKind: "ssh_connection" }, resources)).toEqual([]);
  });

  it("keeps selected item restrictions and does not expose other available resources as granted", () => {
    const rows = grantPermissionRows({ resourceId: "env-1", scopeKind: "environment", permissions: { web: ["view"], ssh: ["manage"] }, items: { web: ["web-2", "deleted"] } }, {
      web: [{ id: "web-1", name: "未授权入口" }, { id: "web-2", name: "已授权入口" }],
      ssh: [{ id: "ssh-1", name: "示例主机" }],
    }, resources);
    expect(rows.map((row) => row.capability)).toEqual(["web", "ssh"]);
    expect(rows[0].all).toBe(false);
    expect(rows[0].items.map((item) => item.name)).toEqual(["已授权入口", "资源信息不可用"]);
    expect(rows[0].items[1].unavailable).toBe(true);
    expect(rows[0].actions.filter((action) => action.selected).map((action) => action.id)).toEqual(["view"]);
    expect(rows[1].all).toBe(true);
    expect(rows[1].actions.every((action) => action.selected)).toBe(true);
  });

  it("shows all current items with future inclusion for an unrestricted scope", () => {
    const rows = grantPermissionRows({ resourceId: "env-1", permissions: { web: ["use"] }, items: {} }, {
      web: [{ id: "web-1", name: "示例入口" }, { id: "web-1", name: "示例入口" }, { id: "web-2", name: "另一个入口" }],
    }, resources);
    expect(rows[0].all).toBe(true);
    expect(rows[0].items).toHaveLength(2);
    expect(rows[0].actions.filter((action) => action.selected).map((action) => action.id)).toEqual(["view", "use"]);
  });

  it("resolves a direct connection grant to its selected connections without future inclusion", () => {
    const rows = grantPermissionRows({ resourceId: "ssh-1", scopeKind: "ssh_connection", permissions: { ssh: ["use"] } }, {}, resources);
    expect(rows[0].all).toBe(false);
    expect(rows[0].items.map((item) => item.name)).toEqual(["示例主机"]);
  });
});
