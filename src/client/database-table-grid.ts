export const TABLE_GRID_MIN_COLUMN_WIDTH = 72;
export const TABLE_GRID_DEFAULT_COLUMN_WIDTH = 120;
export const TABLE_GRID_MAX_INITIAL_COLUMN_WIDTH = 280;
export const TABLE_GRID_LAYOUT = "fitData";

const HEADER_CHAR_WIDTH = 8;
const HEADER_CHROME = 40;

export type TableGridSelectionMode = "replace" | "toggle" | "range" | "preserve";

export function tableGridColumnWidth(columnName: string, storedWidth?: number): number {
  if (typeof storedWidth === "number" && Number.isFinite(storedWidth) && storedWidth >= TABLE_GRID_MIN_COLUMN_WIDTH) {
    return Math.round(storedWidth);
  }
  return Math.max(88, Math.min(TABLE_GRID_MAX_INITIAL_COLUMN_WIDTH, Math.ceil(columnName.length * HEADER_CHAR_WIDTH + HEADER_CHROME)));
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
    minWidth: TABLE_GRID_MIN_COLUMN_WIDTH,
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

export const TABLE_GRID_ROW_HEADER_FIELD = "__envmanRow";

export function isTableGridInternalField(field: string | undefined | null): boolean {
  return !field || field.startsWith("__envman");
}

export function canBatchApplyColumnEdit(field: string, primaryKey: readonly string[], autoIncrementFields: readonly string[]): boolean {
  return Boolean(field)
    && !isTableGridInternalField(field)
    && !primaryKey.includes(field)
    && !autoIncrementFields.includes(field);
}

export function flattenTableGridRangeCells<T>(cells: T[] | T[][] | undefined | null): T[] {
  if (!cells?.length) return [];
  return (cells as unknown[]).flatMap((item) => Array.isArray(item) ? item : [item]) as T[];
}

export function tableGridSelectionLabel(rowCount: number, columnCount: number): { rows: number; columns: number } | null {
  if (rowCount < 1 || columnCount < 1) return null;
  if (rowCount === 1 && columnCount === 1) return null;
  return { rows: rowCount, columns: columnCount };
}

export type TableGridFillAction = "fill" | "clear" | "cancel" | "edit";

export function tableGridFillAction(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}, hasFillSession = false): TableGridFillAction | null {
  if (event.key === "Escape") return hasFillSession ? "cancel" : null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Delete" || event.key === "Backspace") return "clear";
  if (event.key === "F2" || event.key === "Enter") return "edit";
  if (event.key.length === 1) return "fill";
  return null;
}

export function tableGridFillDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function tableGridFillStoredValue(text: string): unknown {
  return text === "" ? null : text;
}

export function isForeignTableGridInput(target: EventTarget | null, gridRoot: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (!target.closest("input, textarea, select, [contenteditable='true']")) return false;
  if (target.classList.contains("table-range-fill-input")) return false;
  return !gridRoot || !gridRoot.contains(target);
}
