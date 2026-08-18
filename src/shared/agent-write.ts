import type { AgentActionRiskLevel } from "./agent.js";
import { assertMcpWriteSql } from "./mcp-policy.js";
import { sshCommandRiskLevel } from "./ssh-command-risk.js";

export const AGENT_SQL_WRITE_KINDS = ["insert", "update", "delete", "replace", "ddl", "drop", "truncate"] as const;
export type AgentSqlWriteKind = (typeof AGENT_SQL_WRITE_KINDS)[number];

export interface AgentSqlWritePreview {
  kind: AgentSqlWriteKind;
  riskLevel: Exclude<AgentActionRiskLevel, "low">;
  reason: string;
  targets: string[];
  missingWhere: boolean;
  previewSql?: string;
  estimatedRows?: number;
  verificationSql?: string;
}

export interface AgentSshWritePreview {
  riskLevel: "high";
  reason: string;
}

const IDENTIFIER = "`[^`]+`|[A-Za-z0-9_]+";
const QUALIFIED_TABLE = `(${IDENTIFIER}(?:\\.(?:${IDENTIFIER}))?)`;

function stripLeadingSqlNoise(sql: string): string {
  return sql.replace(/^(?:\s*(?:--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/))+/g, "").trim();
}

function scanSqlOutsideQuotes(sql: string, visitor: (index: number, char: string, next: string) => boolean | void): void {
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";
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
    if (visitor(index, char, next) === false) return;
  }
}

function extractWhereClause(sql: string): string | undefined {
  let whereAt = -1;
  scanSqlOutsideQuotes(sql, (index, char) => {
    if (whereAt >= 0) return;
    if (!/^[Ww]$/.test(char)) return;
    if (!/^WHERE\b/i.test(sql.slice(index))) return;
    const before = sql[index - 1] ?? " ";
    if (/[A-Za-z0-9_]/.test(before)) return;
    whereAt = index;
  });
  if (whereAt < 0) return undefined;
  let end = sql.length;
  scanSqlOutsideQuotes(sql.slice(whereAt + 5), (index, char) => {
    if (!/^[Oo]$/.test(char)) return;
    if (!/^(?:ORDER\s+BY|LIMIT|OFFSET)\b/i.test(sql.slice(whereAt + 5 + index))) return;
    const before = sql[whereAt + 4 + index] ?? " ";
    if (/[A-Za-z0-9_]/.test(before)) return;
    end = whereAt + 5 + index;
    return false;
  });
  const clause = sql.slice(whereAt + 5, end).replace(/;\s*$/, "").trim();
  return clause || undefined;
}

function firstTable(sql: string, pattern: RegExp): string | undefined {
  const match = sql.match(pattern);
  return match?.[1];
}

function kindReason(kind: AgentSqlWriteKind, missingWhere: boolean): string {
  if (kind === "drop") return "该 SQL 会删除数据库对象，执行后可能无法恢复。";
  if (kind === "truncate") return "该 SQL 会清空整张表并重置自增计数，执行后数据无法按行回滚。";
  if (missingWhere) return "该变更没有 WHERE 条件，可能影响整张表。";
  if (kind === "ddl") return "该 SQL 会修改数据库结构，执行前请确认对象名称和影响范围。";
  if (kind === "delete") return "该 SQL 会删除匹配行，执行前请核对对应影响的数据范围。";
  if (kind === "update") return "该 SQL 会更新匹配行，执行前请核对对应影响的数据范围。";
  if (kind === "replace") return "该 SQL 会替换已有行，可能覆盖当前数据。";
  return "该 SQL 会向目标表写入新行。";
}

export function describeAgentWriteSql(sql: string): AgentSqlWritePreview {
  sql = assertMcpWriteSql(stripLeadingSqlNoise(sql));
  const missingWhere = !extractWhereClause(sql);
  let kind: AgentSqlWriteKind = "ddl";
  let targets: string[] = [];
  let previewSql: string | undefined;
  let verificationSql: string | undefined;

  const insertTable = firstTable(sql, new RegExp(`^INSERT\\s+(?:LOW_PRIORITY\\s+|DELAYED\\s+|HIGH_PRIORITY\\s+|IGNORE\\s+|INTO\\s+)*${QUALIFIED_TABLE}`, "i"));
  const replaceTable = firstTable(sql, new RegExp(`^REPLACE\\s+(?:LOW_PRIORITY\\s+|DELAYED\\s+|INTO\\s+)*${QUALIFIED_TABLE}`, "i"));
  const updateTable = firstTable(sql, new RegExp(`^UPDATE\\s+(?:LOW_PRIORITY\\s+|IGNORE\\s+)*${QUALIFIED_TABLE}`, "i"));
  const deleteTable = firstTable(sql, new RegExp(`^DELETE\\s+(?:LOW_PRIORITY\\s+|QUICK\\s+|IGNORE\\s+)*(?:FROM\\s+)?${QUALIFIED_TABLE}`, "i"));
  const dropTarget = firstTable(sql, /^DROP\s+(?:TEMPORARY\s+)?(?:DATABASE|SCHEMA|TABLE|VIEW|INDEX|TRIGGER|PROCEDURE|FUNCTION|EVENT)\s+(?:IF\s+EXISTS\s+)?((?:`[^`]+`|[A-Za-z0-9_]+)(?:\.(?:`[^`]+`|[A-Za-z0-9_]+))?)/i);
  const truncateTable = firstTable(sql, new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?${QUALIFIED_TABLE}`, "i"));
  const renameTarget = firstTable(sql, new RegExp(`^RENAME\\s+TABLE\\s+${QUALIFIED_TABLE}`, "i"));
  const createTarget = firstTable(sql, /^CREATE\s+(?:OR\s+REPLACE\s+|TEMPORARY\s+|UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)*(?:DATABASE|SCHEMA|TABLE|VIEW|INDEX|TRIGGER|PROCEDURE|FUNCTION|EVENT)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`[^`]+`|[A-Za-z0-9_]+)(?:\.(?:`[^`]+`|[A-Za-z0-9_]+))?)/i);
  const alterTarget = firstTable(sql, /^ALTER\s+(?:DATABASE|SCHEMA|TABLE|VIEW|EVENT)\s+((?:`[^`]+`|[A-Za-z0-9_]+)(?:\.(?:`[^`]+`|[A-Za-z0-9_]+))?)/i);

  if (insertTable) {
    kind = "insert";
    targets = [insertTable];
  } else if (replaceTable) {
    kind = "replace";
    targets = [replaceTable];
  } else if (updateTable && !/\bJOIN\b/i.test(sql)) {
    kind = "update";
    targets = [updateTable];
    const where = extractWhereClause(sql);
    previewSql = `SELECT COUNT(*) AS affected_estimate FROM ${updateTable}${where ? ` WHERE ${where}` : ""}`;
    if (where) verificationSql = `SELECT * FROM ${updateTable} WHERE ${where} LIMIT 20`;
  } else if (deleteTable && !/\bJOIN\b/i.test(sql)) {
    kind = "delete";
    targets = [deleteTable];
    const where = extractWhereClause(sql);
    previewSql = `SELECT COUNT(*) AS affected_estimate FROM ${deleteTable}${where ? ` WHERE ${where}` : ""}`;
    if (where) verificationSql = `SELECT * FROM ${deleteTable} WHERE ${where} LIMIT 20`;
  } else if (truncateTable) {
    kind = "truncate";
    targets = [truncateTable];
    previewSql = `SELECT COUNT(*) AS affected_estimate FROM ${truncateTable}`;
  } else if (dropTarget) {
    kind = "drop";
    targets = [dropTarget];
  } else {
    kind = "ddl";
    targets = [renameTarget, createTarget, alterTarget].filter((item): item is string => Boolean(item));
  }

  const highRisk = kind === "drop" || kind === "truncate" || kind === "ddl" || ((kind === "update" || kind === "delete") && missingWhere);
  return {
    kind,
    riskLevel: highRisk ? "high" : "medium",
    reason: kindReason(kind, (kind === "update" || kind === "delete") && missingWhere),
    targets,
    missingWhere: (kind === "update" || kind === "delete") && missingWhere,
    ...(previewSql ? { previewSql } : {}),
    ...(verificationSql ? { verificationSql } : {}),
  };
}

export function describeAgentWriteCommand(command: string): AgentSshWritePreview {
  if (sshCommandRiskLevel(command) === "low") {
    throw new Error("SSH 写执行只接受无法证明为只读的命令");
  }
  let reason = "该命令无法证明为只读，执行后可能修改远端状态。";
  if (/\brm\s+-[^\s]*[rf][^\s]*[rf]/i.test(command) || /\brm\s+--recursive\b/i.test(command)) {
    reason = "该命令包含递归或强制删除，执行后文件可能无法恢复。";
  } else if (/\b(?:mkfs(?:\.\w+)?|dd|shutdown|reboot|halt|poweroff|init\s+[06])\b/i.test(command)) {
    reason = "该命令可能破坏磁盘或关闭主机。";
  } else if (/\b(?:chmod|chown|chgrp)\s+-[^\s]*R/i.test(command)) {
    reason = "该命令会递归修改权限或所有者。";
  } else if (/\b(?:systemctl|service)\s+(?:stop|restart|disable|mask)\b/i.test(command)) {
    reason = "该命令会停止或变更系统服务。";
  }
  return { riskLevel: "high", reason };
}

export function agentSqlWritePreview(value: unknown): AgentSqlWritePreview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!AGENT_SQL_WRITE_KINDS.includes(input.kind as AgentSqlWriteKind)) return undefined;
  if (input.riskLevel !== "medium" && input.riskLevel !== "high") return undefined;
  if (typeof input.reason !== "string" || !input.reason.trim()) return undefined;
  if (!Array.isArray(input.targets) || !input.targets.every((item) => typeof item === "string")) return undefined;
  if (typeof input.missingWhere !== "boolean") return undefined;
  return {
    kind: input.kind as AgentSqlWriteKind,
    riskLevel: input.riskLevel,
    reason: input.reason.slice(0, 600),
    targets: input.targets.map((item) => String(item).slice(0, 200)).slice(0, 8),
    missingWhere: input.missingWhere,
    ...(typeof input.previewSql === "string" && input.previewSql.trim() ? { previewSql: input.previewSql.slice(0, 20_000) } : {}),
    ...(typeof input.estimatedRows === "number" && Number.isFinite(input.estimatedRows) ? { estimatedRows: input.estimatedRows } : {}),
    ...(typeof input.verificationSql === "string" && input.verificationSql.trim() ? { verificationSql: input.verificationSql.slice(0, 20_000) } : {}),
  };
}

export function agentSshWritePreview(value: unknown): AgentSshWritePreview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.riskLevel !== "high" || typeof input.reason !== "string" || !input.reason.trim()) return undefined;
  return { riskLevel: "high", reason: input.reason.slice(0, 600) };
}
