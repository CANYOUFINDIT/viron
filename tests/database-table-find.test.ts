import type { CellComponent } from "tabulator-tables";
import { describe, expect, it } from "vitest";
import {
  createTableFindMatch,
  resolveTableFindCell,
  type TableFindGrid,
} from "../src/client/database-table-find.js";

function cell(rowId: string, field: string): CellComponent {
  return {
    getField: () => field,
    getRow: () => ({ getIndex: () => rowId }),
  } as CellComponent;
}

describe("database table find matches", () => {
  it("resolves the current cell after virtual scrolling replaces the original cell", () => {
    const original = cell("row-1", "translations");
    const replacement = cell("row-1", "translations");
    const grid: TableFindGrid = {
      getRow: (rowId) => rowId === "row-1" ? { getCell: (field) => field === "translations" ? replacement : false } : false,
    };

    const match = createTableFindMatch(original);

    expect(match).toEqual({ rowId: "row-1", field: "translations" });
    expect(resolveTableFindCell(grid, match)).toBe(replacement);
    expect(resolveTableFindCell(grid, match)).not.toBe(original);
  });

  it("ignores matches whose row or cell no longer exists", () => {
    const match = createTableFindMatch(cell("removed-row", "name"));
    const missingRow: TableFindGrid = { getRow: () => false };
    const missingCell: TableFindGrid = { getRow: () => ({ getCell: () => false }) };

    expect(resolveTableFindCell(null, match)).toBeNull();
    expect(resolveTableFindCell(missingRow, match)).toBeNull();
    expect(resolveTableFindCell(missingCell, match)).toBeNull();
  });
});
