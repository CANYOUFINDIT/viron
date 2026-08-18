import {
  normalizeTableDataFilterRules,
  normalizeTableDataSortRules,
  type TableDataFilterRule,
  type TableDataSortRule,
} from "../shared/database-table-data";

export type TableProfileFilterOperator = TableDataFilterRule["operator"];

export interface TableProfileConfig {
  filters: TableDataFilterRule[];
  sorts: TableDataSortRule[];
  columns: Array<{ name: string; visible: boolean; width: number }>;
  pageSize: number;
  viewMode: "grid" | "form";
}

export interface DatabaseTableProfile {
  id: string;
  connectionId: string;
  database: string;
  table: string;
  name: string;
  config: TableProfileConfig;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}

type LegacyTableProfileConfig = Omit<TableProfileConfig, "filters" | "sorts"> & {
  filters?: TableDataFilterRule[];
  sorts?: TableDataSortRule[];
  filter?: Omit<TableDataFilterRule, "enabled"> | null;
  sort?: Omit<TableDataSortRule, "enabled"> | null;
};

export function normalizeTableProfile(config: TableProfileConfig | LegacyTableProfileConfig, availableColumns: string[]): TableProfileConfig {
  const available = new Set(availableColumns);
  const columns = config.columns.filter((column, index, values) => available.has(column.name) && values.findIndex((item) => item.name === column.name) === index)
    .map((column) => ({ ...column, width: Math.max(40, Math.min(4000, Math.round(column.width))) }));
  for (const name of availableColumns) {
    if (!columns.some((column) => column.name === name)) columns.push({ name, visible: true, width: 120 });
  }
  const legacy = config as LegacyTableProfileConfig;
  const filterRules = config.filters ?? (legacy.filter ? [{ ...legacy.filter, enabled: true }] : []);
  const sortRules = config.sorts ?? (legacy.sort ? [{ ...legacy.sort, enabled: true }] : []);
  return {
    filters: normalizeTableDataFilterRules(filterRules, availableColumns),
    sorts: normalizeTableDataSortRules(sortRules, availableColumns),
    columns,
    pageSize: [50, 100, 200, 500].includes(config.pageSize) ? config.pageSize : 100,
    viewMode: config.viewMode === "form" ? "form" : "grid",
  };
}
