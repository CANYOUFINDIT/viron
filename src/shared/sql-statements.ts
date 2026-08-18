export interface SqlStatement {
  sql: string;
  start: number;
  end: number;
}

function trimmedStatement(source: string, start: number, end: number): SqlStatement | null {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(source[from])) from += 1;
  while (to > from && /\s/.test(source[to - 1])) to -= 1;
  return from < to ? { sql: source.slice(from, to), start: from, end: to } : null;
}

export function parseSqlStatements(source: string): SqlStatement[] {
  if (source.includes("-- ENVMAN_STATEMENT_BOUNDARY")) {
    const statements: SqlStatement[] = [];
    const boundary = /\r?\n-- ENVMAN_STATEMENT_BOUNDARY\r?\n/g;
    let start = 0;
    for (const match of source.matchAll(boundary)) {
      const statement = trimmedStatement(source, start, match.index);
      if (statement) statements.push(statement);
      start = match.index + match[0].length;
    }
    const statement = trimmedStatement(source, start, source.length);
    if (statement) statements.push(statement);
    return statements;
  }

  const statements: SqlStatement[] = [];
  let delimiter = ";";
  let statementStart = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const lineStart = index === 0 || source[index - 1] === "\n";

    if (!quote && !lineComment && !blockComment && lineStart) {
      const lineEnd = source.indexOf("\n", index);
      const end = lineEnd < 0 ? source.length : lineEnd;
      const directive = source.slice(index, end).match(/^\s*DELIMITER\s+(\S+)\s*$/i);
      const pending = trimmedStatement(source, statementStart, index);
      if (directive && !pending) {
        delimiter = directive[1];
        statementStart = lineEnd < 0 ? source.length : lineEnd + 1;
        index = lineEnd < 0 ? source.length : lineEnd;
        continue;
      }
    }

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (char === "\\" && next) {
        index += 1;
        continue;
      }
      if (char === quote) {
        if (next === quote) index += 1;
        else quote = "";
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "#") {
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["'", "\"", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (delimiter && source.startsWith(delimiter, index)) {
      const statement = trimmedStatement(source, statementStart, index);
      if (statement) statements.push(statement);
      index += delimiter.length - 1;
      statementStart = index + 1;
    }
  }

  const statement = trimmedStatement(source, statementStart, source.length);
  if (statement) statements.push(statement);
  return statements;
}

export function splitSqlStatements(source: string): string[] {
  return parseSqlStatements(source).map((statement) => statement.sql);
}

export function sqlStatementAtOffset(source: string, offset: number): string {
  const statements = parseSqlStatements(source);
  const boundedOffset = Math.max(0, Math.min(source.length, offset));
  const selected = statements.find((statement) => boundedOffset >= statement.start && boundedOffset <= statement.end);
  if (selected) return selected.sql;
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    if (statements[index].end < boundedOffset) return statements[index].sql;
  }
  return statements[0]?.sql ?? source.trim();
}
