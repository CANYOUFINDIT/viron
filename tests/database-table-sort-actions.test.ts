import { describe, expect, it } from "vitest";
import { parseTableSortRules, serializeTableSortRules } from "../src/client/database-table-sort-actions.js";

describe("table sort clipboard", () => {
  it("preserves multi-column precedence and direction", () => {
    const copied = serializeTableSortRules([
      { column: "created_at", direction: "desc", enabled: true },
      { column: "id", direction: "asc", enabled: true },
    ]);
    expect(parseTableSortRules(copied, ["id", "created_at"])).toEqual([
      { column: "created_at", direction: "desc", enabled: true },
      { column: "id", direction: "asc", enabled: true },
    ]);
  });

  it("rejects unrelated clipboard text and columns absent from the target table", () => {
    expect(parseTableSortRules("some text", ["id"])).toEqual([]);
    expect(parseTableSortRules(serializeTableSortRules([
      { column: "other_table_column", direction: "desc", enabled: true },
      { column: "id", direction: "asc", enabled: true },
    ]), ["id"])).toEqual([{ column: "id", direction: "asc", enabled: true }]);
  });
});
