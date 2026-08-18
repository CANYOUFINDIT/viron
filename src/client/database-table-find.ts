import type { CellComponent } from "tabulator-tables";

export interface TableFindMatch {
  rowId: string;
  field: string;
}

interface TableFindRow {
  getCell(field: string): CellComponent | false;
}

export interface TableFindGrid {
  getRow(rowId: string): TableFindRow | false;
}

export function createTableFindMatch(cell: CellComponent): TableFindMatch {
  return { rowId: String(cell.getRow().getIndex()), field: cell.getField() };
}

export function resolveTableFindCell(table: TableFindGrid | null, match: TableFindMatch): CellComponent | null {
  const row = table?.getRow(match.rowId);
  if (!row) return null;
  return row.getCell(match.field) || null;
}
