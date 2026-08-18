import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import mysql, { type FieldPacket, type QueryResult, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";

interface TunnelOptions {
  url: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  timeoutMs: number;
  basicAuthUsername?: string;
  basicAuthPassword?: string;
  rejectUnauthorized?: boolean;
}

interface ParsedResult {
  rows: RowDataPacket[] | ResultSetHeader;
  fields: FieldPacket[];
}

const MAX_TUNNEL_RESPONSE_BYTES = 100 * 1024 * 1024;

function tunnelError(message: string, errno?: number): Error {
  return Object.assign(new Error(message), { code: "HTTP_TUNNEL_ERROR", errno, sqlMessage: message });
}

function splitSql(sql: string): string[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];
  if (/^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(trimmed)) return [trimmed];
  const statements: string[] = [];
  let current = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") { current += next; index += 1; blockComment = false; }
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\" && next) { current += next; index += 1; continue; }
      if (char === quote) {
        if (next === quote) { current += next; index += 1; }
        else quote = "";
      }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; current += char; continue; }
    if (char === "#") { lineComment = true; current += char; continue; }
    if (char === "/" && next === "*") { blockComment = true; current += char; continue; }
    if (["'", "\"", "`"].includes(char)) { quote = char; current += char; continue; }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

class BufferReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  uint32(): number {
    this.ensure(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  uint16(): number {
    this.ensure(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  byte(): number {
    this.ensure(1);
    return this.buffer[this.offset++];
  }

  bytes(length: number): Buffer {
    this.ensure(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  block(firstByte?: number): Buffer {
    const marker = firstByte ?? this.byte();
    const length = marker === 0xfe ? this.uint32() : marker;
    return this.bytes(length);
  }

  private ensure(length: number): void {
    if (length < 0 || this.offset + length > this.buffer.length) throw tunnelError("HTTP Tunnel 返回数据不完整");
  }
}

function decodeValue(value: Buffer, type: number, flags: number): unknown {
  if ([249, 250, 251, 252].includes(type) && (flags & 128) !== 0) return Buffer.from(value);
  const text = value.toString("utf8");
  if ([1, 2, 3, 9, 13].includes(type)) {
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : text;
  }
  if ([4, 5].includes(type)) {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  return text;
}

export function parseNavicatTunnelResponse(buffer: Buffer): ParsedResult[] {
  const reader = new BufferReader(buffer);
  if (reader.uint32() !== 1111) throw tunnelError("HTTP Tunnel 响应标识不正确");
  reader.uint16();
  const connectionError = reader.uint32();
  reader.bytes(6);
  if (connectionError) throw tunnelError(reader.block().toString("utf8") || `HTTP Tunnel 连接失败 (${connectionError})`, connectionError);
  const results: ParsedResult[] = [];
  while (reader.remaining > 0) {
    const errno = reader.uint32();
    const affectedRows = reader.uint32();
    const insertId = reader.uint32();
    const fieldCount = reader.uint32();
    const rowCount = reader.uint32();
    reader.bytes(12);
    if (errno) throw tunnelError(reader.block().toString("utf8") || `SQL 执行失败 (${errno})`, errno);
    const fields: FieldPacket[] = [];
    for (let index = 0; index < fieldCount; index += 1) {
      const name = reader.block().toString("utf8");
      const table = reader.block().toString("utf8");
      const type = reader.uint32();
      const flags = reader.uint32();
      const length = reader.uint32();
      fields.push({ name, table, type, flags, length } as FieldPacket);
    }
    if (fieldCount) {
      const rows: RowDataPacket[] = [];
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row: RowDataPacket = {} as RowDataPacket;
        for (const field of fields) {
          const marker = reader.byte();
          const flags = typeof field.flags === "number" ? field.flags : 0;
          row[field.name] = marker === 0xff ? null : decodeValue(reader.block(marker), field.type ?? 0, flags);
        }
        rows.push(row);
      }
      results.push({ rows, fields });
    } else {
      const info = reader.block().toString("utf8");
      results.push({ rows: { affectedRows, insertId, info } as ResultSetHeader, fields: [] });
    }
    if (reader.remaining) reader.byte();
  }
  return results;
}

export class NavicatHttpTunnelConnection {
  private activeRequest: ClientRequest | null = null;
  private closed = false;
  private transaction: string[] | null = null;
  private foreignKeyChecks = true;
  private database: string;

  constructor(private readonly options: TunnelOptions) {
    this.database = options.database;
  }

  async query<T extends QueryResult = QueryResult>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]> {
    this.assertOpen();
    const formatted = values === undefined ? sql : (mysql.format as (statement: string, parameters: unknown) => string)(sql, values);
    const use = formatted.trim().match(/^USE\s+`?([^`;]+)`?\s*;?$/i);
    if (use) {
      this.database = use[1];
      return [this.header(0) as T, []];
    }
    const foreignKeys = formatted.trim().match(/^SET\s+FOREIGN_KEY_CHECKS\s*=\s*([01])\s*;?$/i);
    if (foreignKeys) {
      this.foreignKeyChecks = foreignKeys[1] === "1";
      return [this.header(0) as T, []];
    }
    const statements = splitSql(formatted);
    if (!statements.length) return [this.header(0) as T, []];
    if (this.transaction) {
      this.transaction.push(...statements);
      return [this.header(1) as T, []];
    }
    const results = await this.send(statements);
    if (results.length === 1) return [results[0].rows as T, results[0].fields];
    return [results.map((result) => result.rows) as T, results.map((result) => result.fields) as unknown as FieldPacket[]];
  }

  async beginTransaction(): Promise<void> {
    this.assertOpen();
    if (this.transaction) throw tunnelError("HTTP Tunnel 事务已经开始");
    this.transaction = [];
  }

  async commit(): Promise<void> {
    this.assertOpen();
    const statements = this.transaction;
    if (!statements) return;
    this.transaction = null;
    if (statements.length) await this.send(["START TRANSACTION", ...statements, "COMMIT"]);
  }

  async rollback(): Promise<void> {
    this.transaction = null;
  }

  escape(value: unknown): string {
    return (mysql.escape as (input: unknown) => string)(value);
  }

  async end(): Promise<void> {
    this.destroy();
  }

  destroy(): void {
    this.closed = true;
    this.transaction = null;
    this.activeRequest?.destroy(tunnelError("HTTP Tunnel 请求已取消"));
    this.activeRequest = null;
  }

  private async send(statements: string[]): Promise<ParsedResult[]> {
    const body = new URLSearchParams({
      actn: "Q",
      host: this.options.host,
      port: String(this.options.port),
      login: this.options.username,
      password: this.options.password,
      db: this.database,
      encodeBase64: "1",
    });
    if (!this.foreignKeyChecks) body.append("q[]", Buffer.from("SET FOREIGN_KEY_CHECKS=0", "utf8").toString("base64"));
    for (const statement of statements) body.append("q[]", Buffer.from(statement, "utf8").toString("base64"));
    const buffer = await this.post(body.toString());
    const results = parseNavicatTunnelResponse(buffer);
    return this.foreignKeyChecks ? results : results.slice(1);
  }

  private post(body: string): Promise<Buffer> {
    const target = new URL(this.options.url);
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Accept-Encoding": "identity",
        Accept: "application/octet-stream, text/plain;q=0.9",
      };
      if (this.options.basicAuthUsername) {
        headers.Authorization = `Basic ${Buffer.from(`${this.options.basicAuthUsername}:${this.options.basicAuthPassword ?? ""}`, "utf8").toString("base64")}`;
      }
      const req = request(target, {
        method: "POST",
        headers,
        timeout: this.options.timeoutMs,
        rejectUnauthorized: this.options.rejectUnauthorized !== false,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_TUNNEL_RESPONSE_BYTES) req.destroy(tunnelError("HTTP Tunnel 响应超过 100MB 上限"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          this.activeRequest = null;
          const responseBody = Buffer.concat(chunks);
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(tunnelError(`HTTP Tunnel 返回 HTTP ${response.statusCode}`));
          } else resolve(responseBody);
        });
      });
      this.activeRequest = req;
      req.once("timeout", () => req.destroy(tunnelError("HTTP Tunnel 请求超时")));
      req.once("error", (error) => { this.activeRequest = null; reject(error); });
      req.end(body);
    });
  }

  private header(affectedRows: number): ResultSetHeader {
    return { affectedRows, insertId: 0, info: "" } as ResultSetHeader;
  }

  private assertOpen(): void {
    if (this.closed) throw tunnelError("HTTP Tunnel 连接已经关闭");
  }
}
