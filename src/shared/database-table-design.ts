export type ParsedForeignKeyAction = "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION";

export interface ParsedTableForeignKey {
  originalName: string;
  name: string;
  columns: string[];
  referencedDatabase: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete: ParsedForeignKeyAction;
  onUpdate: ParsedForeignKeyAction;
}

export interface ParsedTableCheck {
  originalName: string;
  name: string;
  expression: string;
}

export interface ParsedCreateTableConstraints {
  foreignKeys: ParsedTableForeignKey[];
  checks: ParsedTableCheck[];
  foreignKeysComplete: boolean;
  checksComplete: boolean;
}

interface ParsedToken {
  value: string;
  end: number;
}

interface ParsedParentheses {
  value: string;
  end: number;
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (/\s/.test(input[index] ?? "")) index += 1;
  return index;
}

function readKeyword(input: string, start: number, keyword: string): number | null {
  const index = skipWhitespace(input, start);
  const value = input.slice(index, index + keyword.length);
  if (value.toUpperCase() !== keyword) return null;
  const next = input[index + keyword.length] ?? "";
  if (/[A-Za-z0-9_$]/.test(next)) return null;
  return index + keyword.length;
}

function readIdentifier(input: string, start: number): ParsedToken | null {
  let index = skipWhitespace(input, start);
  if (input[index] === "`") {
    index += 1;
    let value = "";
    while (index < input.length) {
      if (input[index] === "`" && input[index + 1] === "`") {
        value += "`";
        index += 2;
        continue;
      }
      if (input[index] === "`") return { value, end: index + 1 };
      value += input[index];
      index += 1;
    }
    return null;
  }
  const match = input.slice(index).match(/^[^\s.,()]+/);
  return match ? { value: match[0], end: index + match[0].length } : null;
}

function readParenthesized(input: string, start: number): ParsedParentheses | null {
  const open = skipWhitespace(input, start);
  if (input[open] !== "(") return null;
  let depth = 1;
  let quote = "";
  for (let index = open + 1; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quote) {
      if (character === "\\" && quote !== "`" && next) {
        index += 1;
        continue;
      }
      if (character === quote) {
        if (next === quote) index += 1;
        else quote = "";
      }
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { value: input.slice(open + 1, index), end: index + 1 };
    }
  }
  return null;
}

function splitTopLevelDefinitions(body: string): string[] {
  const definitions: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    const next = body[index + 1];
    if (quote) {
      if (character === "\\" && quote !== "`" && next) {
        index += 1;
        continue;
      }
      if (character === quote) {
        if (next === quote) index += 1;
        else quote = "";
      }
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      definitions.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  const remaining = body.slice(start).trim();
  if (remaining) definitions.push(remaining);
  return definitions;
}

function createTableDefinitions(ddl: string): string[] | null {
  const create = ddl.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\b/i);
  if (!create || create.index === undefined) return null;
  const open = ddl.indexOf("(", create.index + create[0].length);
  if (open < 0) return null;
  const body = readParenthesized(ddl, open);
  return body ? splitTopLevelDefinitions(body.value) : null;
}

function parseIdentifierList(input: string): string[] | null {
  const identifiers: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const identifier = readIdentifier(input, cursor);
    if (!identifier) return null;
    identifiers.push(identifier.value);
    cursor = skipWhitespace(input, identifier.end);
    if (cursor >= input.length) break;
    if (input[cursor] !== ",") return null;
    cursor += 1;
  }
  return identifiers.length ? identifiers : null;
}

function foreignKeyAction(tail: string, kind: "DELETE" | "UPDATE"): ParsedForeignKeyAction {
  const normalized = tail.replace(/\s+/g, " ");
  const value = normalized.match(new RegExp(`\\bON\\s+${kind}\\s+(RESTRICT|CASCADE|SET\\s+NULL|NO\\s+ACTION)\\b`, "i"))?.[1];
  return (value?.replace(/\s+/g, " ").toUpperCase() as ParsedForeignKeyAction | undefined) ?? "RESTRICT";
}

function parseForeignKeyDefinition(definition: string, database: string): ParsedTableForeignKey | null {
  let cursor = readKeyword(definition, 0, "CONSTRAINT");
  if (cursor === null) return null;
  const name = readIdentifier(definition, cursor);
  if (!name) return null;
  cursor = readKeyword(definition, name.end, "FOREIGN");
  if (cursor === null) return null;
  cursor = readKeyword(definition, cursor, "KEY");
  if (cursor === null) return null;
  const localColumns = readParenthesized(definition, cursor);
  if (!localColumns) return null;
  cursor = readKeyword(definition, localColumns.end, "REFERENCES");
  if (cursor === null) return null;
  const firstReference = readIdentifier(definition, cursor);
  if (!firstReference) return null;
  cursor = skipWhitespace(definition, firstReference.end);
  let referencedDatabase = database;
  let referencedTable = firstReference.value;
  if (definition[cursor] === ".") {
    const table = readIdentifier(definition, cursor + 1);
    if (!table) return null;
    referencedDatabase = firstReference.value;
    referencedTable = table.value;
    cursor = table.end;
  }
  const referencedColumns = readParenthesized(definition, cursor);
  if (!referencedColumns) return null;
  const columns = parseIdentifierList(localColumns.value);
  const references = parseIdentifierList(referencedColumns.value);
  if (!columns || !references || columns.length !== references.length) return null;
  const tail = definition.slice(referencedColumns.end);
  return {
    originalName: name.value,
    name: name.value,
    columns,
    referencedDatabase,
    referencedTable,
    referencedColumns: references,
    onDelete: foreignKeyAction(tail, "DELETE"),
    onUpdate: foreignKeyAction(tail, "UPDATE"),
  };
}

function parseCheckDefinition(definition: string): ParsedTableCheck | null {
  let cursor = readKeyword(definition, 0, "CONSTRAINT");
  if (cursor === null) return null;
  const name = readIdentifier(definition, cursor);
  if (!name) return null;
  cursor = readKeyword(definition, name.end, "CHECK");
  if (cursor === null) return null;
  const clause = readParenthesized(definition, cursor);
  if (!clause || !clause.value.trim()) return null;
  return {
    originalName: name.value,
    name: name.value,
    expression: clause.value.trim(),
  };
}

export function parseCreateTableConstraints(ddl: string, database: string): ParsedCreateTableConstraints {
  const definitions = createTableDefinitions(ddl);
  if (!definitions) return { foreignKeys: [], checks: [], foreignKeysComplete: false, checksComplete: false };

  const foreignKeyDefinitions = definitions.filter((definition) => /\bFOREIGN\s+KEY\b/i.test(definition));
  const checkDefinitions = definitions.filter((definition) => /\bCHECK\s*\(/i.test(definition));
  const parsedForeignKeys = foreignKeyDefinitions.map((definition) => parseForeignKeyDefinition(definition, database));
  const parsedChecks = checkDefinitions.map(parseCheckDefinition);
  return {
    foreignKeys: parsedForeignKeys.filter((item): item is ParsedTableForeignKey => Boolean(item)),
    checks: parsedChecks.filter((item): item is ParsedTableCheck => Boolean(item)),
    foreignKeysComplete: parsedForeignKeys.every(Boolean),
    checksComplete: parsedChecks.every(Boolean),
  };
}
