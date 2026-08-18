import { translate as tr } from "./i18n";
import { parseSqlStatements } from "../shared/sql-statements";

export interface SqlCompletionColumn {
  name: string;
  dataType: string;
  columnType: string;
}

export interface SqlCompletionObject {
  name: string;
  type: "table" | "view";
  columns: SqlCompletionColumn[];
}

export interface SqlCompletionRoutine {
  name: string;
  type: "function" | "procedure";
}

export interface SqlCompletionCatalog {
  database: string;
  objects: SqlCompletionObject[];
  routines: SqlCompletionRoutine[];
}

export interface SqlCompletionContext {
  schemas: string[];
  catalog?: SqlCompletionCatalog;
}

export type SqlCompletionKind = "keyword" | "schema" | "table" | "view" | "column" | "function" | "procedure" | "parameter";

export interface SqlCompletionSuggestion {
  label: string;
  insertText: string;
  kind: SqlCompletionKind;
  detail: string;
  sortText: string;
  filterText?: string;
  replaceQualifier?: boolean;
  snippet?: boolean;
}

const keywords = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE", "SET", "SHOW", "DESCRIBE", "EXPLAIN", "WITH",
  "FROM", "INTO", "VALUES", "WHERE", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "CROSS JOIN", "ON", "USING",
  "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "UNION", "UNION ALL", "DISTINCT", "AS",
  "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL", "ASC", "DESC",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "TABLE", "VIEW", "INDEX", "DATABASE", "SCHEMA", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT",
  "BEGIN", "COMMIT", "ROLLBACK", "START TRANSACTION", "CASE", "WHEN", "THEN", "ELSE", "END",
];

const functions = [
  ["COUNT", "COUNT(${1:*})"], ["SUM", "SUM(${1:column})"], ["AVG", "AVG(${1:column})"], ["MIN", "MIN(${1:column})"], ["MAX", "MAX(${1:column})"],
  ["COALESCE", "COALESCE(${1:value}, ${2:fallback})"], ["IFNULL", "IFNULL(${1:value}, ${2:fallback})"], ["CONCAT", "CONCAT(${1:value}, ${2:value})"],
  ["DATE_FORMAT", "DATE_FORMAT(${1:date}, ${2:'%Y-%m-%d'})"], ["NOW", "NOW()"], ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP"],
] as const;

const identifier = "(?:`(?:``|[^`])+`|[A-Za-z_$][A-Za-z0-9_$]*)";
const qualifiedIdentifier = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
const clauseKeywords = new Set(["where", "join", "inner", "left", "right", "cross", "full", "on", "using", "group", "having", "order", "limit", "offset", "union", "set", "values", "returning"]);

function unquote(value: string): string {
  return value.trim().replace(/^`|`$/g, "").replaceAll("``", "`");
}

function insertIdentifier(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : `\`${value.replaceAll("`", "``")}\``;
}

function maskSql(source: string): string {
  let result = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      result += char === "\n" ? "\n" : " ";
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      result += " ";
      if (char === "*" && next === "/") {
        result += " ";
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (quote === "`") result += char;
      else result += char === "\n" ? "\n" : " ";
      if (char === "\\" && next && quote !== "`") {
        result += " ";
        index += 1;
      } else if (char === quote) {
        if (next === quote) {
          result += quote === "`" ? next : " ";
          index += 1;
        } else quote = "";
      }
      continue;
    }
    if (char === "-" && next === "-") {
      result += "  ";
      index += 1;
      lineComment = true;
    } else if (char === "#") {
      result += " ";
      lineComment = true;
    } else if (char === "/" && next === "*") {
      result += "  ";
      index += 1;
      blockComment = true;
    } else {
      result += char;
      if (["'", '"', "`"].includes(char)) quote = char;
    }
  }
  return result;
}

function statementContext(source: string, offset: number): { before: string; full: string } {
  const bounded = Math.max(0, Math.min(source.length, offset));
  const statement = parseSqlStatements(source).find((item) => bounded >= item.start && bounded <= item.end);
  if (!statement) return { before: source.slice(0, bounded), full: source };
  return { before: statement.sql.slice(0, Math.max(0, bounded - statement.start)), full: statement.sql };
}

function resolveObject(catalog: SqlCompletionCatalog | undefined, rawName: string): SqlCompletionObject | undefined {
  if (!catalog) return undefined;
  const parts = rawName.split(".").map(unquote);
  const objectName = parts.at(-1) ?? "";
  const database = parts.length > 1 ? parts[0] : catalog.database;
  if (database.toLowerCase() !== catalog.database.toLowerCase()) return undefined;
  return catalog.objects.find((item) => item.name.toLowerCase() === objectName.toLowerCase());
}

function referencedObjects(masked: string, catalog: SqlCompletionCatalog | undefined): Array<{ alias: string; object: SqlCompletionObject }> {
  if (!catalog) return [];
  const result: Array<{ alias: string; object: SqlCompletionObject }> = [];
  const expression = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${qualifiedIdentifier})(?:\\s+(?:AS\\s+)?(${identifier}))?`, "gi");
  for (const match of masked.matchAll(expression)) {
    const object = resolveObject(catalog, match[1]);
    if (!object) continue;
    const rawAlias = match[2] ? unquote(match[2]) : "";
    const alias = rawAlias && !clauseKeywords.has(rawAlias.toLowerCase()) ? rawAlias : object.name;
    if (!result.some((item) => item.alias.toLowerCase() === alias.toLowerCase())) result.push({ alias, object });
  }
  return result;
}

function deduplicate(items: SqlCompletionSuggestion[]): SqlCompletionSuggestion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}\0${item.label}\0${item.detail}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sqlCompletionSuggestions(source: string, offset: number, context: SqlCompletionContext): SqlCompletionSuggestion[] {
  const statement = statementContext(source, offset);
  const masked = maskSql(statement.before);
  const catalog = context.catalog;
  const references = referencedObjects(maskSql(statement.full), catalog);
  const dotMatch = masked.match(new RegExp("(" + identifier + ")\\s*\\.\\s*(?:`[^`]*|[A-Za-z0-9_$]*)$", "i"));
  if (dotMatch) {
    const rawOwner = dotMatch[1].trim();
    const owner = unquote(dotMatch[1]);
    const reference = references.find((item) => item.alias.toLowerCase() === owner.toLowerCase());
    const object = reference?.object ?? resolveObject(catalog, owner);
    if (object) {
      return object.columns.map((column, index) => ({
        label: column.name,
        insertText: `${rawOwner}.${insertIdentifier(column.name)}`,
        kind: "column",
        detail: `${column.columnType} · ${catalog?.database}.${object.name}`,
        sortText: `0-${String(index).padStart(4, "0")}`,
        filterText: `${owner}.${column.name}`,
        replaceQualifier: true,
      }));
    }
    if (catalog && owner.toLowerCase() === catalog.database.toLowerCase()) {
      return catalog.objects.map((object, index) => ({
        label: object.name,
        insertText: `${rawOwner}.${insertIdentifier(object.name)}`,
        kind: object.type,
        detail: catalog.database,
        sortText: `0-${String(index).padStart(4, "0")}`,
        filterText: `${owner}.${object.name}`,
        replaceQualifier: true,
      }));
    }
  }

  const objectContext = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO|TABLE|DESCRIBE|DESC)\\s+(?:${qualifiedIdentifier})?$`, "i").test(masked);
  if (objectContext) {
    return deduplicate([
      ...(catalog?.objects.map((object, index) => ({
        label: object.name,
        insertText: insertIdentifier(object.name),
        kind: object.type as "table" | "view",
        detail: catalog.database,
        sortText: `0-${String(index).padStart(4, "0")}`,
      })) ?? []),
      ...context.schemas.map((schema, index) => ({ label: schema, insertText: insertIdentifier(schema), kind: "schema" as const, detail: tr("数据库"), sortText: `1-${String(index).padStart(4, "0")}` })),
    ]);
  }

  const parameterNames = [...new Set([...source.matchAll(/\[\$([A-Za-z_][A-Za-z0-9_]*)\]/g)].map((match) => match[1]))];
  const items: SqlCompletionSuggestion[] = [
    ...keywords.map((keyword, index) => ({ label: keyword, insertText: keyword, kind: "keyword" as const, detail: tr("SQL 关键字"), sortText: `0-${String(index).padStart(4, "0")}` })),
    ...context.schemas.map((schema, index) => ({ label: schema, insertText: insertIdentifier(schema), kind: "schema" as const, detail: tr("数据库"), sortText: `1-${String(index).padStart(4, "0")}` })),
    ...(catalog?.objects.map((object, index) => ({ label: object.name, insertText: insertIdentifier(object.name), kind: object.type, detail: catalog.database, sortText: `2-${String(index).padStart(4, "0")}` })) ?? []),
    ...references.flatMap((reference, referenceIndex) => reference.object.columns.map((column, columnIndex) => ({
      label: column.name,
      insertText: insertIdentifier(column.name),
      kind: "column" as const,
      detail: `${column.columnType} · ${reference.alias} (${catalog?.database}.${reference.object.name})`,
      sortText: `3-${String(referenceIndex).padStart(3, "0")}-${String(columnIndex).padStart(4, "0")}`,
    }))),
    ...functions.map(([label, insertText], index) => ({ label, insertText, kind: "function" as const, detail: tr("MySQL 函数"), sortText: `4-${String(index).padStart(4, "0")}`, snippet: insertText.includes("${") })),
    ...(catalog?.routines.map((routine, index) => ({ label: routine.name, insertText: routine.name, kind: routine.type, detail: `${catalog.database} · ${routine.type === "function" ? tr("函数") : tr("存储过程")}`, sortText: `5-${String(index).padStart(4, "0")}` })) ?? []),
    ...parameterNames.map((name, index) => ({ label: `[$${name}]`, insertText: `[$${name}]`, kind: "parameter" as const, detail: tr("查询参数"), sortText: `6-${String(index).padStart(4, "0")}` })),
    { label: "[$parameter]", insertText: "[$${1:parameter}]", kind: "parameter", detail: tr("查询参数"), sortText: "6-9999", snippet: true },
  ];
  return deduplicate(items);
}
