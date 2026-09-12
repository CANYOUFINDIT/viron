import { describe, expect, it } from "vitest";
import {
  canBatchApplyColumnEdit,
  TABLE_GRID_MAX_INITIAL_COLUMN_WIDTH,
  tableGridColumnSize,
  tableGridColumnWidth,
  tableGridRangeBounds,
  tableGridSelectionMode,
} from "../src/client/database-table-grid.js";

describe("database table grid column sizing", () => {
  it("caps default column width so long cell text does not stretch the grid", () => {
    expect(tableGridColumnWidth("accelerator_ids")).toBeLessThanOrEqual(200);
    expect(tableGridColumnSize("accelerator_ids")).toMatchObject({
      maxInitialWidth: TABLE_GRID_MAX_INITIAL_COLUMN_WIDTH,
      resizable: true,
    });
    expect(tableGridColumnSize("accelerator_ids")).not.toHaveProperty("width");
  });

  it("preserves a user-resized width above the default cap", () => {
    expect(tableGridColumnWidth("accelerator_ids", 640)).toBe(640);
    expect(tableGridColumnSize("accelerator_ids", 640)).toEqual({
      minWidth: 96,
      width: 640,
      resizable: true,
    });
  });
});

describe("database table grid selection", () => {
  it("keeps a multi-row selection when clicking an already selected row to edit", () => {
    expect(tableGridSelectionMode({ shiftKey: false, metaKey: false, ctrlKey: false }, true, 4)).toBe("preserve");
    expect(tableGridSelectionMode({ shiftKey: false, metaKey: false, ctrlKey: false }, false, 4)).toBe("replace");
    expect(tableGridSelectionMode({ shiftKey: true, metaKey: false, ctrlKey: false }, false, 1)).toBe("range");
    expect(tableGridSelectionMode({ shiftKey: false, metaKey: true, ctrlKey: false }, true, 1)).toBe("toggle");
    expect(tableGridRangeBounds(5, 2)).toEqual([2, 5]);
  });

  it("applies cell edits across selected rows except primary key and auto-increment fields", () => {
    expect(canBatchApplyColumnEdit("status", ["id"], ["id"])).toBe(true);
    expect(canBatchApplyColumnEdit("id", ["id"], [])).toBe(false);
    expect(canBatchApplyColumnEdit("__envmanId", [], [])).toBe(false);
  });
});
