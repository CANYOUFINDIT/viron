import { describe, expect, it } from "vitest";
import { buildTableDataClauses, parseTableDataQueryRules } from "../src/shared/database-table-data.js";

describe("database table data rules", () => {
  it("parses multiple validated filters and ordered sort rules", () => {
    const params = new URLSearchParams({
      filters: JSON.stringify([
        { column: "status", operator: "eq", value: "open", enabled: true },
        { column: "amount", operator: "gte", value: "10", enabled: false },
        { column: "missing", operator: "eq", value: "ignored", enabled: true },
      ]),
      sorts: JSON.stringify([
        { column: "created_at", direction: "desc", enabled: true },
        { column: "status", direction: "asc", enabled: true },
        { column: "created_at", direction: "asc", enabled: true },
      ]),
    });

    expect(parseTableDataQueryRules(params, ["status", "amount", "created_at"])).toEqual({
      filters: [
        { column: "status", operator: "eq", value: "open", enabled: true },
        { column: "amount", operator: "gte", value: "10", enabled: false },
      ],
      sorts: [
        { column: "created_at", direction: "desc", enabled: true },
        { column: "status", direction: "asc", enabled: true },
      ],
    });
  });

  it("keeps the legacy single-rule query compatible", () => {
    const params = new URLSearchParams({
      filterColumn: "name",
      filterOperator: "contains",
      filterValue: "gpu",
      sort: "id",
      direction: "desc",
    });

    expect(parseTableDataQueryRules(params, ["id", "name"])).toEqual({
      filters: [{ column: "name", operator: "contains", value: "gpu", enabled: true }],
      sorts: [{ column: "id", direction: "desc", enabled: true }],
    });
  });

  it("builds parameterized AND filters and stable multi-column ordering", () => {
    expect(buildTableDataClauses([
      { column: "name", operator: "contains", value: "gpu", enabled: true },
      { column: "deleted_at", operator: "isNull", value: "", enabled: true },
      { column: "status", operator: "eq", value: "ignored", enabled: false },
    ], [
      { column: "created_at", direction: "desc", enabled: true },
      { column: "id", direction: "asc", enabled: true },
    ], "id")).toEqual({
      where: " WHERE `name` LIKE ? AND `deleted_at` IS NULL",
      params: ["%gpu%"],
      orderBy: " ORDER BY `created_at` DESC, `id` ASC",
    });
  });
});
