import { redisCommandAccess, validateRedisBoundedRead } from "./redis.js";
import { splitSqlStatements } from "./sql-statements.js";
import type { McpApiRequest } from "./mcp-protocol.js";

const forbiddenMcpPaths = [
  /^\/api\/v1\/(?:api-keys|platform\/api-keys|platform\/users|platform\/organizations)(?:\/|$)/,
  /^\/api\/v1\/users(?:\/|$)/,
  /^\/api\/v1\/organizations(?:\/|$)/,
  /^\/api\/v1\/organization-invitations(?:\/|$)/,
  /^\/api\/v1\/auth\/(?:register|login|logout|password|workspace|api-key)(?:\/|$)/,
  /^\/api\/v1\/settings(?:\/|$)/,
  /^\/api\/v1\/platform-(?:exports|restore)(?:\/|$)/,
  /^\/api\/v1\/desktop(?:\/|$)/,
  /^\/api\/v1\/client-installers(?:\/|$)/,
  /^\/api\/v1\/web-credentials\/[0-9a-f-]+\/reveal$/i,
  /^\/api\/v1\/database-connections\/[0-9a-f-]+\/(?:users|user-grants|user-object-privileges|user-privileges)$/i,
];

export function assertMcpApiRequestAllowed(input: McpApiRequest): McpApiRequest {
  const pathname = new URL(input.path, "http://viron.local").pathname;
  if (forbiddenMcpPaths.some((pattern) => pattern.test(pathname))) {
    throw new Error(`Viron MCP 禁止访问账号安全、权限控制或内部接口：${pathname}`);
  }
  if (/^\/api\/v1\/ssh-keys\/[0-9a-f-]+\/export$/i.test(pathname) && String(input.query?.part ?? "public") !== "public") {
    throw new Error("Viron MCP 禁止读取或导出 SSH 私钥");
  }
  return input;
}

export function assertMcpReadOnlySql(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 * 1024) throw new Error("SQL 必须是 1 MiB 以内的非空字符串");
  const statements = splitSqlStatements(value).map((item) => item.replace(/^(?:\s*(?:--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/))+/g, "").trim());
  if (statements.length !== 1) throw new Error("MCP 只读查询只允许一条 SQL");
  const sql = statements[0];
  if (!/^(?:SELECT\b|EXPLAIN\s+(?:FORMAT\s*=\s*(?:JSON|TREE|TRADITIONAL)\s+)?SELECT\b)/i.test(sql)) {
    throw new Error("MCP 只读查询只允许 SELECT 或 EXPLAIN SELECT");
  }
  if (/\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i.test(sql)) {
    throw new Error("MCP 只读查询拒绝文件写入或锁副作用");
  }
  return sql;
}

export function assertMcpWriteSql(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 * 1024) throw new Error("SQL 必须是 1 MiB 以内的非空字符串");
  const statements = splitSqlStatements(value).map((item) => item.replace(/^(?:\s*(?:--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/))+/g, "").trim());
  if (statements.length !== 1) throw new Error("MCP 写操作只允许一条 SQL");
  const sql = statements[0];
  if (!/^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE\s+(?:DATABASE|SCHEMA|TABLE|VIEW|INDEX|TRIGGER|PROCEDURE|FUNCTION|EVENT)|ALTER\s+(?:DATABASE|SCHEMA|TABLE|VIEW|EVENT)|DROP\s+(?:DATABASE|SCHEMA|TABLE|VIEW|INDEX|TRIGGER|PROCEDURE|FUNCTION|EVENT)|TRUNCATE\s+TABLE|RENAME\s+TABLE)\b/i.test(sql)) {
    throw new Error("MCP 写操作只允许受控的数据或 Schema 变更 SQL");
  }
  if (/\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|LOAD\s+DATA|GRANT|REVOKE|CREATE\s+USER|ALTER\s+USER|DROP\s+USER|SET\s+PASSWORD|INSTALL\s+PLUGIN|UNINSTALL\s+PLUGIN|SHUTDOWN|KILL|SET\s+(?:GLOBAL|PERSIST))\b/i.test(sql)) {
    throw new Error("MCP 写操作拒绝文件、账号安全或服务管理副作用");
  }
  return sql;
}

export function assertMcpReadOnlyRedisCommand(commandValue: unknown, argsValue: unknown): { command: string; args: Array<string | { base64: string }> } {
  const command = typeof commandValue === "string" ? commandValue.trim().toUpperCase() : "";
  if (!command || command.length > 64) throw new Error("Redis 命令名称无效");
  if (!Array.isArray(argsValue) || argsValue.length > 256) throw new Error("Redis 命令参数无效");
  const args = argsValue.map((value) => {
    if (typeof value === "string" && Buffer.byteLength(value) <= 256 * 1024) return value;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { base64?: unknown }).base64 === "string") {
      const base64 = (value as { base64: string }).base64;
      if (base64.length <= 512 * 1024) return { base64 };
    }
    throw new Error("Redis 命令参数无效或过大");
  });
  const policyArgs = args.map((value) => typeof value === "string" ? value : Buffer.from(value.base64, "base64").toString("utf8"));
  if (redisCommandAccess(command, policyArgs) !== "read") throw new Error(`MCP 只读工具不允许执行 Redis 写命令 ${command}`);
  const boundedError = validateRedisBoundedRead(command, policyArgs.map((value) => Buffer.from(value, "utf8")));
  if (boundedError) throw new Error(boundedError);
  return { command, args };
}

export function assertMcpRedisWriteCommand(commandValue: unknown, argsValue: unknown): { command: string; args: Array<string | { base64: string }> } {
  const command = typeof commandValue === "string" ? commandValue.trim().toUpperCase() : "";
  if (!command || command.length > 64) throw new Error("Redis 命令名称无效");
  if (!Array.isArray(argsValue) || argsValue.length > 256) throw new Error("Redis 命令参数无效");
  const args = argsValue.map((value) => {
    if (typeof value === "string" && Buffer.byteLength(value) <= 256 * 1024) return value;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { base64?: unknown }).base64 === "string") {
      const base64 = (value as { base64: string }).base64;
      if (base64.length <= 512 * 1024) return { base64 };
    }
    throw new Error("Redis 命令参数无效或过大");
  });
  const policyArgs = args.map((value) => typeof value === "string" ? value : Buffer.from(value.base64, "base64").toString("utf8"));
  if (redisCommandAccess(command, policyArgs) !== "write") throw new Error(`MCP 写工具不允许执行 Redis 命令 ${command}`);
  const boundedError = validateRedisBoundedRead(command, policyArgs.map((value) => Buffer.from(value, "utf8")));
  if (boundedError) throw new Error(boundedError);
  return { command, args };
}
