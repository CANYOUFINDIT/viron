export type RedisCommandAccess = "read" | "write" | "deny";

const READ_COMMANDS = new Set([
  "DBSIZE", "EXISTS", "GET", "HEXISTS", "HGET", "HLEN", "HMGET", "HSCAN",
  "INFO", "LLEN", "LPOS", "LRANGE", "MEMORY", "MGET", "OBJECT", "PING", "PTTL", "SCAN",
  "SCARD", "SISMEMBER", "SLOWLOG", "SMISMEMBER", "SSCAN", "STRLEN", "TIME", "TTL", "TYPE",
  "XLEN", "XRANGE", "XREVRANGE", "ZCARD", "ZMSCORE", "ZRANGE", "ZRANGEBYSCORE", "ZRANK",
  "ZREVRANGE", "ZREVRANGEBYSCORE", "ZREVRANK", "ZSCAN", "ZSCORE",
]);

const WRITE_COMMANDS = new Set([
  "COPY", "DEL", "EXPIRE", "EXPIREAT", "HDEL", "HINCRBY", "HINCRBYFLOAT", "HSET", "LINSERT",
  "LPOP", "LPUSH", "LREM", "LSET", "MSET", "PERSIST", "PEXPIRE", "PEXPIREAT", "RENAME", "RENAMENX",
  "RPOP", "RPUSH", "SADD", "SET", "SREM", "UNLINK", "XADD", "XDEL", "ZADD", "ZINCRBY", "ZREM",
]);

const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  MEMORY: new Set(["USAGE", "STATS", "DOCTOR", "MALLOC-STATS"]),
  OBJECT: new Set(["ENCODING", "FREQ", "IDLETIME", "REFCOUNT"]),
  SLOWLOG: new Set(["GET", "LEN"]),
};

export function redisCommandAccess(command: string, args: readonly string[] = []): RedisCommandAccess {
  const name = command.trim().toUpperCase();
  if (READ_COMMANDS.has(name)) {
    const subcommands = READ_ONLY_SUBCOMMANDS[name];
    if (!subcommands) return "read";
    return subcommands.has(String(args[0] ?? "").toUpperCase()) ? "read" : "deny";
  }
  if (WRITE_COMMANDS.has(name)) return "write";
  return "deny";
}

export interface RedisBinaryValue {
  base64: string;
  utf8: string | null;
  byteLength: number;
}

export function redisBinaryValue(value: Buffer): RedisBinaryValue {
  const utf8 = value.toString("utf8");
  return {
    base64: value.toString("base64"),
    utf8: Buffer.from(utf8, "utf8").equals(value) ? utf8 : null,
    byteLength: value.length,
  };
}

export type RedisReply =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "binary"; value: RedisBinaryValue }
  | { type: "array"; value: RedisReply[] };

export function redisReply(value: unknown): RedisReply {
  if (value === null || value === undefined) return { type: "null" };
  if (Buffer.isBuffer(value)) return { type: "binary", value: redisBinaryValue(value) };
  if (typeof value === "number" || typeof value === "bigint") return { type: "integer", value: String(value) };
  if (typeof value === "string") return { type: "binary", value: redisBinaryValue(Buffer.from(value, "utf8")) };
  if (Array.isArray(value)) return { type: "array", value: value.map(redisReply) };
  return { type: "binary", value: redisBinaryValue(Buffer.from(JSON.stringify(value), "utf8")) };
}

export function redisBuffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

export function redisResponseBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (typeof value === "number" || typeof value === "bigint") return 16;
  if (Array.isArray(value)) return value.reduce((total, item) => total + redisResponseBytes(item), 0);
  return Buffer.byteLength(JSON.stringify(value));
}

export function validateRedisBoundedRead(command: string, args: readonly Buffer[]): string | null {
  const name = command.toUpperCase();
  if (["LRANGE", "ZRANGE", "ZREVRANGE"].includes(name)) {
    if (name === "ZRANGE" && args.some((value) => ["BYSCORE", "BYLEX", "LIMIT"].includes(value.toString("utf8").toUpperCase()))) {
      return "ZRANGE 只允许按索引读取；按分数读取请使用带 LIMIT 的 ZRANGEBYSCORE";
    }
    const start = Number(args[1]?.toString("utf8"));
    const stop = Number(args[2]?.toString("utf8"));
    if (!Number.isInteger(start) || !Number.isInteger(stop) || stop < start || stop - start + 1 > 1000) {
      return `${name} 单次最多读取 1000 个成员`;
    }
  }
  if (name === "XRANGE" || name === "XREVRANGE") {
    const countIndex = args.findIndex((value) => value.toString("utf8").toUpperCase() === "COUNT");
    const count = countIndex >= 0 ? Number(args[countIndex + 1]?.toString("utf8")) : Number.NaN;
    if (!Number.isInteger(count) || count < 1 || count > 1000) return `${name} 必须指定 1–1000 的 COUNT`;
  }
  if ((name === "MGET" || name === "EXISTS") && args.length > 100) return `${name} 单次最多处理 100 个键`;
  if (["HMGET", "SMISMEMBER", "ZMSCORE"].includes(name) && args.length > 101) return `${name} 单次最多处理 100 个成员`;
  if (["DEL", "UNLINK"].includes(name) && args.length > 100) return `${name} 单次最多处理 100 个键`;
  if (name === "MSET" && (args.length % 2 !== 0 || args.length > 200)) return "MSET 单次最多写入 100 个键值对，且参数必须成对";
  if (["HSCAN", "SSCAN", "ZSCAN", "SCAN"].includes(name)) {
    const countIndex = args.findIndex((value) => value.toString("utf8").toUpperCase() === "COUNT");
    if (countIndex >= 0) {
      const count = Number(args[countIndex + 1]?.toString("utf8"));
      if (!Number.isInteger(count) || count < 1 || count > 1000) return `${name} 的 COUNT 必须在 1–1000 之间`;
    }
  }
  if (["ZRANGEBYSCORE", "ZREVRANGEBYSCORE"].includes(name)) {
    const limitIndex = args.findIndex((value) => value.toString("utf8").toUpperCase() === "LIMIT");
    const count = limitIndex >= 0 ? Number(args[limitIndex + 2]?.toString("utf8")) : Number.NaN;
    if (!Number.isInteger(count) || count < 1 || count > 1000) return `${name} 必须指定 LIMIT offset count，且 count 不超过 1000`;
  }
  if (["LPOP", "RPOP"].includes(name) && args[1]) {
    const count = Number(args[1].toString("utf8"));
    if (!Number.isInteger(count) || count < 1 || count > 1000) return `${name} 单次最多处理 1000 个元素`;
  }
  if (name === "SLOWLOG" && args[0]?.toString("utf8").toUpperCase() === "GET") {
    const count = Number(args[1]?.toString("utf8"));
    if (!Number.isInteger(count) || count < 1 || count > 1000) return "SLOWLOG GET 必须指定 1–1000 的数量";
  }
  if (name === "MEMORY" && args[0]?.toString("utf8").toUpperCase() === "USAGE") {
    const samplesIndex = args.findIndex((value) => value.toString("utf8").toUpperCase() === "SAMPLES");
    if (samplesIndex >= 0) {
      const samples = Number(args[samplesIndex + 1]?.toString("utf8"));
      if (!Number.isInteger(samples) || samples < 1 || samples > 1000) return "MEMORY USAGE 的 SAMPLES 必须在 1–1000 之间";
    }
  }
  return null;
}

export function parseRedisInfo(raw: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = "default";
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      section = line.slice(2).trim().toLowerCase();
      result[section] ??= {};
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    result[section] ??= {};
    result[section][line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}
