export const TABLE_GRID_MIN_COLUMN_WIDTH = 96;
export const TABLE_GRID_DEFAULT_COLUMN_WIDTH = 160;
export const TABLE_GRID_MAX_INITIAL_COLUMN_WIDTH = 280;

export type TableGridSelectionMode = "replace" | "toggle" | "range" | "preserve";

export function tableGridColumnWidth(columnName: string, storedWidth?: number): number {
  if (typeof storedWidth === "number" && Number.isFinite(storedWidth) && storedWidth >= TABLE_GRID_MIN_COLUMN_WIDTH) {
    return Math.round(storedWidth);
  }
  return Math.max(TABLE_GRID_MIN_COLUMN_WIDTH, Math.min(200, columnName.length * 9 + 52));
}

export function tableGridColumnSize(columnName: string, storedWidth?: number) {
  if (typeof storedWidth === "number" && Number.isFinite(storedWidth) && storedWidth >= TABLE_GRID_MIN_COLUMN_WIDTH) {
    return {
      minWidth: TABLE_GRID_MIN_COLUMN_WIDTH,
      width: Math.round(storedWidth),
      resizable: true as const,
    };
  }
  return {
    minWidth: Math.max(TABLE_GRID_MIN_COLUMN_WIDTH, Math.min(160, columnName.length * 9 + 52)),
    maxInitialWidth: TABLE_GRID_MAX_INITIAL_COLUMN_WIDTH,
    resizable: true as const,
  };
}

export function tableGridSelectionMode(
  event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  rowAlreadySelected: boolean,
  selectedCount: number,
): TableGridSelectionMode {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  if (rowAlreadySelected && selectedCount > 1) return "preserve";
  return "replace";
}

export function tableGridRangeBounds(start: number, end: number): [number, number] {
  return start <= end ? [start, end] : [end, start];
}

export function canBatchApplyColumnEdit(field: string, primaryKey: readonly string[], autoIncrementFields: readonly string[]): boolean {
  return Boolean(field)
    && !field.startsWith("__envman")
    && !primaryKey.includes(field)
    && !autoIncrementFields.includes(field);
}
