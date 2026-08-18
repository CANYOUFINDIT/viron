import { translate as tr } from "./i18n.js";
import type { AgentDatabaseContextInput, AgentDatabaseContextSnapshot, AgentJsonValue } from "../shared/agent.js";
import { normalizeAgentDatabaseSql } from "../shared/agent.js";
import { assertMcpWriteSql } from "../shared/mcp-policy.js";
import { splitSqlStatements } from "../shared/sql-statements.js";

const SECRET = /(password|passwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi;

function cleanText(value: unknown, max: number): { value: string; truncated: boolean; redactions: number } {
  const raw = typeof value === "string" ? value.replace(/\0/g, "") : "";
  let redactions = 0;
  const redacted = raw.replace(SECRET, (_match, key: string) => { redactions += 1; return `${key}=[REDACTED]`; });
  return { value: redacted.slice(0, max), truncated: redacted.length > max, redactions };
}

function cleanValue(value: unknown): AgentJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  const text = cleanText(String(value ?? ""), 1_000).value;
  return text;
}

export function sanitizeAgentDatabaseInput(input: AgentDatabaseContextInput, maxRows = 20) {
  const editor = cleanText(input.editorSql, 12_000);
  const selected = cleanText(input.selectedSql, 8_000);
  const candidates = Array.isArray(input.resultPreview) ? input.resultPreview.slice(0, 100).map((row) => Object.fromEntries(
    Object.entries(row ?? {}).slice(0, 30).map(([key, value]) => [key.slice(0, 200), cleanValue(value)]),
  )) : [];
  const rowLimit = Math.min(maxRows, candidates.length);
  const rows: Array<Record<string, AgentJsonValue>> = [];
  let resultBytes = 0;
  for (const row of candidates.slice(0, rowLimit)) {
    const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (resultBytes + bytes > 128 * 1024) break;
    rows.push(row);
    resultBytes += bytes;
  }
  return {
    editorSql: editor.value,
    selectedSql: selected.value,
    resultPreview: rows,
    truncated: editor.truncated || selected.truncated || input.resultPreview.length > rows.length,
    redactionCount: editor.redactions + selected.redactions,
  };
}

export function assertAgentReadOnlySql(value: unknown): string {
  const sql = normalizeAgentDatabaseSql(value);
  const statements = splitSqlStatements(sql).map((item) => item.replace(/^(?:\s*(?:--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/))+/g, "").trim());
  if (statements.length !== 1) throw new Error(tr("Viron Agent 只读执行只允许一条 SQL"));
  if (!/^(?:SELECT\b|EXPLAIN\s+(?:FORMAT\s*=\s*(?:JSON|TREE|TRADITIONAL)\s+)?SELECT\b)/i.test(statements[0])) {
    throw new Error(tr("Viron Agent 只允许执行 SELECT 或 EXPLAIN SELECT"));
  }
  if (/\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i.test(statements[0])) {
    throw new Error(tr("Viron Agent 拒绝带文件写入或锁副作用的查询"));
  }
  return statements[0];
}

export function assertAgentWriteSql(value: unknown): string {
  return assertMcpWriteSql(normalizeAgentDatabaseSql(value));
}

export function agentDatabaseContextSnapshot(input: Omit<AgentDatabaseContextSnapshot, "capturedAt">): AgentDatabaseContextSnapshot {
  return { ...input, capturedAt: new Date().toISOString() };
}
