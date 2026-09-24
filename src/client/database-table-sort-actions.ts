import type { TableDataSortRule } from "../shared/database-table-data";

const clipboardPrefix = "VIRON_SORT_RULES_V1\n";

export function serializeTableSortRules(rules: TableDataSortRule[]): string {
  return clipboardPrefix + JSON.stringify(rules.map(({ column, direction, enabled }) => ({ column, direction, enabled })));
}

export function parseTableSortRules(text: string, columns: string[]): TableDataSortRule[] {
  if (!text.startsWith(clipboardPrefix)) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(clipboardPrefix.length));
    if (!Array.isArray(parsed)) return [];
    const available = new Set(columns);
    const seen = new Set<string>();
    return parsed.flatMap((item): TableDataSortRule[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rule = item as Partial<TableDataSortRule>;
      if (typeof rule.column !== "string" || !available.has(rule.column) || seen.has(rule.column)) return [];
      if (rule.direction !== "asc" && rule.direction !== "desc") return [];
      seen.add(rule.column);
      return [{ column: rule.column, direction: rule.direction, enabled: rule.enabled !== false }];
    }).slice(0, 20);
  } catch {
    return [];
  }
}
