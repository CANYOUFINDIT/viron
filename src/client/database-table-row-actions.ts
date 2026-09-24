export type TableRowCopyFormat = "values" | "names" | "names-and-values" | "insert" | "update";

export interface TableRowCopySelection {
  database: string;
  table: string;
  fields: string[];
  rows: Array<Record<string, unknown>>;
  primaryKey: string[];
}

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("\0", "\\0").replaceAll("\t", "\\t").replaceAll("\n", "\\n").replaceAll("\r", "\\r")}'`;
}

function tabValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function copyTableRows(format: TableRowCopyFormat, selection: TableRowCopySelection): string {
  const { database, table, fields, rows, primaryKey } = selection;
  if (format === "names") return fields.map(tabValue).join("\t");
  if (format === "values" || format === "names-and-values") {
    const lines = rows.map((row) => fields.map((field) => tabValue(row[field])).join("\t"));
    if (format === "names-and-values") lines.unshift(fields.map(tabValue).join("\t"));
    return lines.join("\n");
  }

  const qualifiedTable = `${identifier(database)}.${identifier(table)}`;
  if (format === "insert") {
    const names = fields.map(identifier).join(", ");
    return rows.map((row) => `INSERT INTO ${qualifiedTable} (${names}) VALUES (${fields.map((field) => sqlValue(row[field])).join(", ")});`).join("\n");
  }

  if (!primaryKey.length) return "";
  const valuesToSet = fields.filter((field) => !primaryKey.includes(field));
  if (!valuesToSet.length) return "";
  return rows.map((row) => {
    if (primaryKey.some((key) => row[key] === null || row[key] === undefined)) return "";
    const set = valuesToSet.map((field) => `${identifier(field)} = ${sqlValue(row[field])}`).join(", ");
    const where = primaryKey.map((key) => `${identifier(key)} = ${sqlValue(row[key])}`).join(" AND ");
    return `UPDATE ${qualifiedTable} SET ${set} WHERE ${where};`;
  }).filter(Boolean).join("\n");
}

export function parseTableClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (!value || quoted) quoted = !quoted;
      else value += char;
    } else if (!quoted && char === "\t") {
      row.push(value); value = "";
    } else if (!quoted && (char === "\r" || char === "\n")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value); rows.push(row); row = []; value = "";
    } else value += char;
  }
  if (row.length || value || !rows.length) { row.push(value); rows.push(row); }
  return rows;
}
