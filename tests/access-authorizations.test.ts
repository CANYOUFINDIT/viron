import { describe, expect, it } from "vitest";
import { expandActions, heavierActions, sqlRequiresWrite } from "../src/shared/access-permissions.js";
describe("access permission helpers", () => {
  it("expands heavier actions without treating service actions as one chain", () => {
    expect(expandActions("web", ["manage"])).toEqual(["view", "use", "manage"]);
    expect(expandActions("database", ["write"])).toEqual(["read", "write"]);
    expect(expandActions("maintenance", ["script", "install"])).toEqual(["view", "script", "install"]);
    expect(heavierActions("ssh", "view")).toEqual(["use", "manage"]);
    expect(heavierActions("maintenance", "control")).toEqual([]);
    expect(heavierActions("maintenance", "view")).toEqual(["control", "script", "manage", "install"]);
  });

  it("treats reads as queries and everything else as a change", () => {
    expect(sqlRequiresWrite("SELECT 1")).toBe(false);
    expect(sqlRequiresWrite("SHOW TABLES")).toBe(false);
    expect(sqlRequiresWrite("WITH rows AS (SELECT 1 AS id) SELECT * FROM rows")).toBe(false);
    expect(sqlRequiresWrite("SELECT * FROM t FOR UPDATE")).toBe(true);
    expect(sqlRequiresWrite("UPDATE t SET name = 'a'")).toBe(true);
    expect(sqlRequiresWrite("")).toBe(true);
  });
});

