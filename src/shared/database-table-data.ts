export type TableDataFilterOperator = "contains" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "isNull" | "isNotNull";

export interface TableDataFilterRule {
  column: string;
  operator: TableDataFilterOperator;
  value: string;
  enabled: boolean;
}

export interface TableDataSortRule {
  column: string;
  direction: "asc" | "desc";
  enabled: boolean;
}

export const TABLE_DATA_RULE_LIMIT = 20;

const filterSql: Record<TableDataFilterOperator, string> = {
  contains: "LIKE ?",
  eq: "= ?",
  ne: "!= ?",
  gt: "> ?",
  gte: ">= ?",
  lt: "< ?",
  lte: "<= ?",
  isNull: "IS NULL",
  isNotNull: "IS NOT NULL",
};

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function parsedArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeTableDataFilterRules(rules: unknown[], availableColumns: string[]): TableDataFilterRule[] {
  const available = new Set(availableColumns);
  return rules.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Partial<TableDataFilterRule>;
    const column = typeof candidate.column === "string" ? candidate.column : "";
    const operator = typeof candidate.operator === "string" && candidate.operator in filterSql
      ? candidate.operator as TableDataFilterOperator
      : "contains";
    if (!available.has(column)) return [];
    return [{
      column,
      operator,
      value: typeof candidate.value === "string" ? candidate.value : "",
      enabled: candidate.enabled !== false,
    }];
  }).slice(0, TABLE_DATA_RULE_LIMIT);
}

export function normalizeTableDataSortRules(rules: unknown[], availableColumns: string[]): TableDataSortRule[] {
  const available = new Set(availableColumns);
  const seen = new Set<string>();
  return rules.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Partial<TableDataSortRule>;
    const column = typeof candidate.column === "string" ? candidate.column : "";
    if (!available.has(column) || seen.has(column)) return [];
    seen.add(column);
    return [{
      column,
      direction: candidate.direction === "desc" ? "desc" as const : "asc" as const,
      enabled: candidate.enabled !== false,
    }];
  }).slice(0, TABLE_DATA_RULE_LIMIT);
}

export function parseTableDataQueryRules(searchParams: URLSearchParams, availableColumns: string[]) {
  const filterRules = parsedArray(searchParams.get("filters"));
  if (!filterRules.length && searchParams.get("filterColumn")) {
    filterRules.push({
      column: searchParams.get("filterColumn"),
      operator: searchParams.get("filterOperator") ?? "contains",
      value: searchParams.get("filterValue") ?? "",
      enabled: true,
    });
  }

  const sortRules = parsedArray(searchParams.get("sorts"));
  if (!sortRules.length && searchParams.get("sort")) {
    sortRules.push({
      column: searchParams.get("sort"),
      direction: searchParams.get("direction") === "desc" ? "desc" : "asc",
      enabled: true,
    });
  }

  return {
    filters: normalizeTableDataFilterRules(filterRules, availableColumns),
    sorts: normalizeTableDataSortRules(sortRules, availableColumns),
  };
}

export function buildTableDataClauses(
  filters: TableDataFilterRule[],
  sorts: TableDataSortRule[],
  defaultSortColumn: string,
) {
  const activeFilters = filters.filter((rule) => rule.enabled);
  const whereParts: string[] = [];
  const params: unknown[] = [];
  for (const rule of activeFilters) {
    whereParts.push(`${identifier(rule.column)} ${filterSql[rule.operator]}`);
    if (rule.operator !== "isNull" && rule.operator !== "isNotNull") {
      params.push(rule.operator === "contains" ? `%${rule.value}%` : rule.value);
    }
  }

  const activeSorts = sorts.filter((rule) => rule.enabled);
  const effectiveSorts = activeSorts.length
    ? activeSorts
    : [{ column: defaultSortColumn, direction: "asc" as const, enabled: true }];

  return {
    where: whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "",
    params,
    orderBy: ` ORDER BY ${effectiveSorts.map((rule) => `${identifier(rule.column)} ${rule.direction.toUpperCase()}`).join(", ")}`,
  };
}
