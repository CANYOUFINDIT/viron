import { describe, expect, it, vi } from "vitest";
import type { EnvmanDatabase } from "../src/server/database-client";
import { roleNamesByMember } from "../src/server/organization-approval";
function database(roleCount: number) {
  const roles = Array.from({ length: roleCount }, (_, index) => ({ id: `role-${index}`, name: `角色 ${index}`, enabled: 1, description: "", permission_codes_json: "[]", version: 1 }));
  roles.push({ ...roles[0], id: "disabled", name: "停用角色", enabled: 0 });
  const assignments = roles.map(role => ({ id: `assignment-${role.id}`, role_id: role.id, subject_type: "project", subject_id: "parent", enabled: 1, starts_at: null, expires_at: null, reason: "测试", management_scope_json: "{}" }));
  assignments.push({ ...assignments[0], id: "duplicate", subject_type: "user", subject_id: "active-child" });
  assignments.push({ ...assignments[0], id: "expired", role_id: "expired", expires_at: "2000-01-01T00:00:00Z", subject_type: "organization", subject_id: "org" });
  assignments.push({ ...assignments[0], id: "future", role_id: "future", starts_at: "2100-01-01T00:00:00Z", subject_type: "user", subject_id: "active-child" });
  roles.push({ ...roles[0], id: "expired", name: "过期角色" }, { ...roles[0], id: "future", name: "未来角色" });
  const prepare = vi.fn((sql: string) => ({ all: async () => {
    if (sql.includes("organization_roles WHERE")) return roles;
    if (sql.includes("organization_role_assignments WHERE")) return assignments;
    if (sql.includes("organization_members m JOIN admin_users")) return [{ user_id: "active-child" }, { user_id: "outside" }];
    if (sql.includes("SELECT id, parent_id FROM projects")) return [{ id: "parent", parent_id: null }, { id: "child", parent_id: "parent" }];
    if (sql.includes("SELECT pm.project_id, pm.user_id")) return [{ project_id: "child", user_id: "active-child" }, { project_id: "child", user_id: "disabled-user" }];
    return [];
  } }));
  return { db: { prepare } as unknown as EnvmanDatabase, prepare };
}
describe("member role summary query cost", () => {
  it("uses a constant number of reads while preserving inherited roles, deduplication and validity", async () => {
    const small = database(1), large = database(40);
    await roleNamesByMember(small.db, "org", Date.UTC(2026, 9, 14));
    const names = await roleNamesByMember(large.db, "org", Date.UTC(2026, 9, 14));
    expect(large.prepare).toHaveBeenCalledTimes(7);
    expect(large.prepare.mock.calls.length).toBe(small.prepare.mock.calls.length);
    expect(names.get("active-child")).toHaveLength(40);
    expect(names.get("active-child")).not.toContain("停用角色");
    expect(names.get("active-child")).not.toContain("过期角色");
    expect(names.get("active-child")).not.toContain("未来角色");
    expect(names.has("disabled-user")).toBe(false);
    expect(names.has("outside")).toBe(false);
  });
});
