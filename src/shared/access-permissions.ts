import { parseSqlStatements, startsSqlLineComment } from "./sql-statements.js";

export const CAPABILITIES = ["web", "ssh", "logs", "database", "redis", "knowledge", "maintenance"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_ACTIONS = {
  web: ["view", "use", "manage"],
  ssh: ["view", "use", "manage"],
  logs: ["view", "manage"],
  database: ["read", "write", "manage"],
  redis: ["view", "write", "manage"],
  knowledge: ["view", "edit"],
  maintenance: ["view", "control", "script", "manage", "install"],
} as const;

export type CapabilityAction<C extends Capability = Capability> = (typeof CAPABILITY_ACTIONS)[C][number];
export type PermissionMap = Partial<Record<Capability, string[]>>;
export type ItemMap = Partial<Record<Capability, string[]>>;

export const SCOPE_KINDS = ["environment_group", "environment", "ssh_connection", "database_connection", "redis_connection"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  web: "Web 入口",
  ssh: "SSH 终端",
  logs: "日志",
  database: "数据库",
  redis: "Redis",
  knowledge: "知识库",
  maintenance: "服务维护",
};

export const ACTION_LABELS: { [C in Capability]: Record<(typeof CAPABILITY_ACTIONS)[C][number], string> } = {
  web: { view: "查看并打开", use: "使用已存账号", manage: "编辑入口和账号" },
  ssh: { view: "查看连接", use: "登录使用", manage: "编辑连接" },
  logs: { view: "查看日志", manage: "编辑日志来源" },
  database: { read: "查询和导出", write: "修改", manage: "编辑连接" },
  redis: { view: "查看", write: "修改", manage: "编辑连接" },
  knowledge: { view: "查看", edit: "编辑" },
  maintenance: { view: "查看", control: "启动、停止、重启", script: "执行脚本", manage: "编辑服务", install: "安装和维护主机监控" },
};

const IMPLICATIONS: Record<Capability, Partial<Record<string, readonly string[]>>> = {
  web: { manage: ["use", "view"], use: ["view"] },
  ssh: { manage: ["use", "view"], use: ["view"] },
  logs: { manage: ["view"] },
  database: { manage: ["write", "read"], write: ["read"] },
  redis: { manage: ["write", "view"], write: ["view"] },
  knowledge: { edit: ["view"] },
  maintenance: { control: ["view"], script: ["view"], manage: ["view"], install: ["view"] },
};

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function connectionCapability(kind: "ssh_connection" | "database_connection" | "redis_connection"): Capability {
  if (kind === "ssh_connection") return "ssh";
  if (kind === "database_connection") return "database";
  return "redis";
}

export function expandActions(capability: Capability, actions: Iterable<string>): string[] {
  const order = CAPABILITY_ACTIONS[capability];
  const known = new Set<string>(order);
  const selected = new Set<string>();
  const visit = (action: string) => {
    if (!known.has(action) || selected.has(action)) return;
    selected.add(action);
    for (const implied of IMPLICATIONS[capability][action] ?? []) visit(implied);
  };
  for (const action of actions) visit(action);
  return order.filter((action) => selected.has(action));
}

export function expandPermissions(permissions: PermissionMap): PermissionMap {
  const result: PermissionMap = {};
  for (const capability of CAPABILITIES) {
    const actions = permissions[capability];
    if (!actions?.length) continue;
    const expanded = expandActions(capability, actions);
    if (expanded.length) result[capability] = expanded;
  }
  return result;
}

export function fullPermissions(kind: ScopeKind): PermissionMap {
  if (kind === "ssh_connection" || kind === "database_connection" || kind === "redis_connection") {
    const capability = connectionCapability(kind);
    return { [capability]: [...CAPABILITY_ACTIONS[capability]] };
  }
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, [...CAPABILITY_ACTIONS[capability]]])) as PermissionMap;
}

export function heavierActions(capability: Capability, action: string): string[] {
  const implications = IMPLICATIONS[capability];
  const heavier = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of CAPABILITY_ACTIONS[capability]) {
      if (candidate === action || heavier.has(candidate)) continue;
      const implied = implications[candidate] ?? [];
      if (implied.some((item) => item === action || heavier.has(item))) {
        heavier.add(candidate);
        changed = true;
      }
    }
  }
  return CAPABILITY_ACTIONS[capability].filter((candidate) => heavier.has(candidate));
}

export function permissionSummary(permissions: PermissionMap): string {
  const parts: string[] = [];
  for (const capability of CAPABILITIES) {
    const actions = permissions[capability] ?? [];
    if (!actions.length) continue;
    const labels = actions.map((action) => (ACTION_LABELS[capability] as Record<string, string>)[action]).filter(Boolean);
    parts.push(`${CAPABILITY_LABELS[capability]}：${labels.join("、")}`);
  }
  return parts.join("；");
}

export type DatabaseSqlPermission = "database.read" | "database.export" | "database.write" | "database.ddl";
export type DatabaseSqlAction = "read" | "export" | "write" | "ddl";

const DATABASE_SQL_PERMISSIONS: DatabaseSqlPermission[] = ["database.read", "database.export", "database.write", "database.ddl"];
const STATEMENT_VERB = /^(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|TABLE|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|LOAD|LOCK|SET|USE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|CALL|DO|HANDLER|WITH|OPTIMIZE|REPAIR|ANALYZE|CHECK|FLUSH|KILL|PREPARE|EXECUTE|DEALLOCATE)\b/i;

function skipSpace(sql: string, index: number): number {
  let cursor = index;
  while (cursor < sql.length && /\s/.test(sql[cursor])) cursor += 1;
  return cursor;
}

function skipParens(sql: string, open: number): number {
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return sql.length;
}

// MariaDB ends a block comment at the first */. An apostrophe inside it is not a SQL string.
// An unclosed comment still runs to the end of the text.
function commentEnd(source: string, start: number): number {
  const end = source.indexOf("*/", start);
  return end < 0 ? source.length : end;
}

function executableComment(source: string, slash: number): { start: number; end: number } | null {
  let cursor = slash + 2;
  if (source[cursor] === "M" || source[cursor] === "m") cursor += 1;
  if (source[cursor] !== "!") return null;
  cursor += 1;
  while (cursor < source.length && source[cursor] >= "0" && source[cursor] <= "9") cursor += 1;
  return { start: cursor, end: commentEnd(source, cursor) };
}

function requireEvery(codes: Set<DatabaseSqlPermission>): void {
  for (const code of DATABASE_SQL_PERMISSIONS) codes.add(code);
}

// MySQL runs /*!...*/ and MariaDB also runs /*M!...*/. A verb inside one is a statement.
// backslashEscapes follows the session mode used for this slice. NO_BACKSLASH_ESCAPES
// makes \' end a string, so a later statement can no longer hide inside it.
function sqlForPermissionScan(source: string, backslashEscapes = true): string {
  let out = "";
  let index = 0;
  let quote = "";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (backslashEscapes && char === "\\" && next) {
        out += "  ";
        index += 2;
        continue;
      }
      if (char === quote && next === quote) {
        out += "  ";
        index += 2;
        continue;
      }
      out += char === quote ? char : " ";
      if (char === quote) quote = "";
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (startsSqlLineComment(source, index)) {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      const executable = executableComment(source, index);
      if (executable) {
        const body = sqlForPermissionScan(source.slice(executable.start, executable.end), backslashEscapes);
        if (STATEMENT_VERB.test(body.trim())) out += ";\n";
        out += body;
        index = source.startsWith("*/", executable.end) ? executable.end + 2 : executable.end;
        out += " ";
        continue;
      }
      const end = commentEnd(source, index + 2);
      while (index < end) {
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (source.startsWith("*/", index)) {
        out += "  ";
        index += 2;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function mainClause(sql: string): string {
  const trimmed = sql.trim();
  if (!/^WITH\b/i.test(trimmed)) return trimmed;
  let index = /^WITH\s+(?:RECURSIVE\s+)?/i.exec(trimmed)?.[0].length ?? 0;
  while (index < trimmed.length) {
    const name = /^`(?:``|[^`])*`|[A-Za-z_][\w$]*/.exec(trimmed.slice(index));
    if (!name) break;
    index += name[0].length;
    index = skipSpace(trimmed, index);
    if (trimmed[index] === "(") index = skipParens(trimmed, index);
    index = skipSpace(trimmed, index);
    if (!/^AS\b/i.test(trimmed.slice(index))) break;
    index += 2;
    index = skipSpace(trimmed, index);
    if (trimmed[index] !== "(") break;
    index = skipParens(trimmed, index);
    index = skipSpace(trimmed, index);
    if (trimmed[index] === ",") {
      index += 1;
      index = skipSpace(trimmed, index);
      continue;
    }
    break;
  }
  return trimmed.slice(index).trim();
}

function hasDepthZeroKeyword(sql: string, keyword: string): boolean {
  let depth = 0;
  for (const match of sql.matchAll(new RegExp(`\\b${keyword}\\b|\\(|\\)`, "gi"))) {
    if (match[0] === "(") depth += 1;
    else if (match[0] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) return true;
  }
  return false;
}

function statementPermissions(statement: string): DatabaseSqlPermission[] {
  const text = statement.trim();
  if (!text) return [];
  const codes = new Set<DatabaseSqlPermission>();
  const locking = /\bFOR\s+UPDATE\b/i.test(text) || /\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(text);
  if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(text)) codes.add("database.export");
  if (locking) codes.add("database.write");
  const main = mainClause(text);
  const verb = (main.match(/^([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  switch (verb) {
    case "SELECT":
    case "SHOW":
    case "DESCRIBE":
    case "DESC":
    case "EXPLAIN":
    case "TABLE":
      codes.add("database.read");
      break;
    case "HANDLER":
      codes.add("database.read");
      break;
    case "INSERT":
    case "REPLACE":
    case "UPDATE":
    case "DELETE":
    case "LOAD":
    case "LOCK":
    case "DEALLOCATE":
      codes.add("database.write");
      break;
    case "GRANT":
    case "REVOKE":
    case "CALL":
    case "DO":
    case "PREPARE":
    case "EXECUTE":
      requireEvery(codes);
      break;
    case "CREATE":
    case "ALTER":
    case "DROP":
    case "TRUNCATE":
    case "RENAME":
      codes.add("database.ddl");
      break;
    case "SET":
      if (/\b(?:GLOBAL|PERSIST(?:_ONLY)?|PASSWORD)\b/i.test(main) || /@@\s*(?:GLOBAL|PERSIST)/i.test(main)) codes.add("database.write");
      break;
    case "USE":
    case "BEGIN":
    case "START":
    case "COMMIT":
    case "ROLLBACK":
    case "SAVEPOINT":
    case "RELEASE":
      break;
    default:
      if (verb) requireEvery(codes);
      break;
  }
  if ((verb === "INSERT" || verb === "REPLACE") && hasDepthZeroKeyword(main, "SELECT")) codes.add("database.read");
  if (verb === "CREATE" && /\bTABLE\b/i.test(main) && hasDepthZeroKeyword(main, "SELECT")) {
    codes.add("database.read");
    codes.add("database.write");
  }
  return DATABASE_SQL_PERMISSIONS.filter((code) => codes.has(code));
}

export async function missingDatabaseSqlPermission(
  sql: string,
  allows: (code: DatabaseSqlPermission) => boolean | Promise<boolean>,
): Promise<DatabaseSqlPermission | null> {
  const required = databaseSqlPermissions(sql);
  if (!required.length) {
    for (const code of DATABASE_SQL_PERMISSIONS) if (await allows(code)) return null;
    return "database.read";
  }
  for (const code of required) if (!await allows(code)) return code;
  return null;
}

function readSqlExpr(text: string, start: number): string {
  let quote = "";
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
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
    if (startsSqlLineComment(text, index)) {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = commentEnd(text, index + 2);
      index = text.startsWith("*/", end) ? end + 1 : end;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === "," || char === ";")) return text.slice(start, index);
  }
  return text.slice(start);
}

function simpleSqlString(value: string): string | null {
  const text = value.trim();
  const quote = text[0];
  if ((quote !== "'" && quote !== "\"") || text.length < 2 || text.at(-1) !== quote) return null;
  const body = text.slice(1, -1);
  if (body.includes(quote) || body.includes("\\")) return null;
  return body;
}

// Session sql_mode changes how the following statements in this batch are lexed.
// Only a literal assignment is predictable. Anything else can hide a later statement.
function sessionSqlModeEffect(statement: string): "unchanged" | "backslash" | "no-backslash" | "unknown" {
  const text = statement.trim();
  if (!/^SET\b/i.test(text)) return "unchanged";
  let quote = "";
  let value = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
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
    if (startsSqlLineComment(text, index)) {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      if (executableComment(text, index) && /\bsql_mode\s*(?::=|=)\s*$/i.test(text.slice(0, index))) return "unknown";
      const end = commentEnd(text, index + 2);
      index = text.startsWith("*/", end) ? end + 1 : end;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    const target = /^(?:@@(?:(GLOBAL|PERSIST(?:_ONLY)?|SESSION)\.)?)?sql_mode\b/i.exec(text.slice(index));
    const precededByAt = index > 0 && text[index - 1] === "@";
    if (!target || (index > 0 && /[\w.]/.test(text[index - 1])) || (precededByAt && !text.startsWith("@@", index))) continue;
    const scope = (target[1] ?? "").toUpperCase();
    let cursor = index + target[0].length;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] === ":" && text[cursor + 1] === "=") cursor += 2;
    else if (text[cursor] === "=") cursor += 1;
    else continue;
    const expr = readSqlExpr(text, cursor);
    if (scope !== "GLOBAL" && !scope.startsWith("PERSIST")) value = expr;
    index = cursor + Math.max(expr.length, 1) - 1;
  }
  if (!value) return "unchanged";
  const literal = simpleSqlString(value);
  if (literal === null) return "unknown";
  const modes = new Set(literal.toUpperCase().split(",").map((item) => item.trim()).filter(Boolean));
  return modes.has("NO_BACKSLASH_ESCAPES") ? "no-backslash" : "backslash";
}

function classifySql(sql: string, backslashEscapes: boolean): DatabaseSqlPermission[] {
  const statements = parseSqlStatements(sqlForPermissionScan(sql, backslashEscapes)).map((item) => item.sql.trim()).filter(Boolean);
  const found = new Set<DatabaseSqlPermission>();
  for (const statement of statements) for (const code of statementPermissions(statement)) found.add(code);
  for (const statement of parseSqlStatements(sql)) {
    const effect = sessionSqlModeEffect(statement.sql);
    if (effect === "unchanged" || (effect === "backslash" && backslashEscapes) || (effect === "no-backslash" && !backslashEscapes)) continue;
    const tail = sql.slice(statement.end).replace(/^\s*;\s*/, "");
    if (!tail.trim()) break;
    const tails = effect === "unknown" ? [true, false] : [effect === "backslash"];
    for (const escapes of tails) for (const code of classifySql(tail, escapes)) found.add(code);
    break;
  }
  if (!statements.length && !found.size) return ["database.write"];
  return DATABASE_SQL_PERMISSIONS.filter((code) => found.has(code));
}

function unionSqlPermissions(groups: DatabaseSqlPermission[][]): DatabaseSqlPermission[] {
  const found = new Set<DatabaseSqlPermission>();
  for (const group of groups) for (const code of group) found.add(code);
  return DATABASE_SQL_PERMISSIONS.filter((code) => found.has(code));
}

// The connection's sql_mode is not known here. A backslash may or may not end a string,
// so every statement is classified both ways and the operation codes are united.
export function databaseSqlPermissions(sql: string): DatabaseSqlPermission[] {
  return unionSqlPermissions([classifySql(sql, true), classifySql(sql, false)]);
}

export function databaseSqlActions(sql: string): DatabaseSqlAction[] {
  return databaseSqlPermissions(sql).map((code) => code.slice("database.".length) as DatabaseSqlAction);
}

export function sqlRequiresWrite(sql: string): boolean {
  return databaseSqlPermissions(sql).some((code) => code !== "database.read");
}

export function databaseSqlOperation(sql: string): "database.read" | "database.write" | "database.ddl" {
  const codes = databaseSqlPermissions(sql);
  if (codes.includes("database.ddl")) return "database.ddl";
  if (codes.includes("database.write") || codes.includes("database.export")) return "database.write";
  return "database.read";
}
