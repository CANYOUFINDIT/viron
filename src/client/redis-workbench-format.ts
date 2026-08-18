import { translate as tr } from "./i18n";
import type { RedisBinaryValue, RedisReply } from "../shared/redis";

export type RedisValueView = "utf8" | "json" | "hex" | "base64";
export type RedisKeyType = "string" | "hash" | "list" | "set" | "zset" | "stream" | "none";

export interface RedisDatabaseOption {
  database: number;
  keys: number;
  expires: number;
}

export interface RedisDetailRow {
  index: number;
  primary: string;
  secondary: string;
}

export type RedisKeyTreeRow<T> =
  | { kind: "group"; id: string; depth: number; name: string; path: string; count: number; expanded: boolean }
  | { kind: "key"; id: string; depth: number; label: string; item: T };

interface RedisKeyTreeNode<T> {
  name: string;
  path: string;
  count: number;
  children: Map<string, RedisKeyTreeNode<T>>;
  keys: Array<{ item: T; label: string }>;
}

const maxRedisKeyTreeDepth = 8;

function validDatabase(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 1023;
}

export function redisKeyspaceStats(raw: string | undefined): { keys: number; expires: number } {
  const entries = Object.fromEntries(
    String(raw ?? "")
      .split(",")
      .map((entry) => entry.split("=", 2))
      .filter((entry) => entry.length === 2),
  );
  return {
    keys: Number.isFinite(Number(entries.keys)) ? Number(entries.keys) : 0,
    expires: Number.isFinite(Number(entries.expires)) ? Number(entries.expires) : 0,
  };
}

export function redisDatabaseOptions(
  keyspace: Record<string, string> | undefined,
  currentDatabase: number,
  defaultDatabase: number,
): RedisDatabaseOption[] {
  const databases = new Set(Array.from({ length: 16 }, (_, index) => index));
  if (validDatabase(currentDatabase)) databases.add(currentDatabase);
  if (validDatabase(defaultDatabase)) databases.add(defaultDatabase);
  for (const name of Object.keys(keyspace ?? {})) {
    const match = /^db(\d+)$/.exec(name);
    const database = match ? Number(match[1]) : Number.NaN;
    if (validDatabase(database)) databases.add(database);
  }
  return [...databases]
    .sort((left, right) => left - right)
    .map((database) => ({ database, ...redisKeyspaceStats(keyspace?.[`db${database}`]) }));
}

function redisKeyHierarchy(value: RedisBinaryValue, separator: string): { groups: string[]; leaf: string } {
  const fullLabel = value.utf8 ?? `base64:${value.base64}`;
  if (!separator || value.utf8 === null || !value.utf8.includes(separator)) return { groups: [], leaf: fullLabel };
  const segments = value.utf8.split(separator).filter(Boolean);
  if (segments.length < 2) return { groups: [], leaf: fullLabel };
  const groupCount = Math.min(segments.length - 1, maxRedisKeyTreeDepth);
  return {
    groups: segments.slice(0, groupCount),
    leaf: segments.slice(groupCount).join(separator) || fullLabel,
  };
}

function redisKeyGroupPath(groups: string[]): string {
  return JSON.stringify(groups);
}

export function redisKeyGroupPaths(value: RedisBinaryValue, separator: string): string[] {
  const paths: string[] = [];
  const groups = redisKeyHierarchy(value, separator).groups;
  for (let index = 1; index <= groups.length; index += 1) paths.push(redisKeyGroupPath(groups.slice(0, index)));
  return paths;
}

export function redisKeyTreeRows<T extends { key: RedisBinaryValue }>(
  items: readonly T[],
  separator: string,
  expandedPaths: ReadonlySet<string>,
): RedisKeyTreeRow<T>[] {
  const root: RedisKeyTreeNode<T> = { name: "", path: "", count: 0, children: new Map(), keys: [] };
  for (const item of items) {
    const hierarchy = redisKeyHierarchy(item.key, separator);
    let node = root;
    const ancestors: string[] = [];
    for (const group of hierarchy.groups) {
      ancestors.push(group);
      let child = node.children.get(group);
      if (!child) {
        child = { name: group, path: redisKeyGroupPath(ancestors), count: 0, children: new Map(), keys: [] };
        node.children.set(group, child);
      }
      child.count += 1;
      node = child;
    }
    node.keys.push({ item, label: hierarchy.leaf });
  }

  const rows: RedisKeyTreeRow<T>[] = [];
  const appendNode = (node: RedisKeyTreeNode<T>, depth: number) => {
    const children = [...node.children.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    for (const child of children) {
      const expanded = expandedPaths.has(child.path);
      rows.push({ kind: "group", id: `group:${child.path}`, depth, name: child.name, path: child.path, count: child.count, expanded });
      if (expanded) appendNode(child, depth + 1);
    }
    const keys = [...node.keys].sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { numeric: true }));
    for (const key of keys) rows.push({ kind: "key", id: `key:${key.item.key.base64}`, depth, label: key.label, item: key.item });
  };
  appendNode(root, 0);
  return rows;
}

function binaryBytes(value: RedisBinaryValue): Uint8Array {
  return Uint8Array.from(atob(value.base64), (character) => character.charCodeAt(0));
}

export function redisBinaryDisplay(value: RedisBinaryValue, view: RedisValueView): string {
  if (view === "base64") return value.base64;
  if (view === "hex") return [...binaryBytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  if (view === "json") {
    if (value.utf8 === null) return tr("非 UTF-8 数据，无法解释为 JSON");
    try {
      return JSON.stringify(JSON.parse(value.utf8), null, 2);
    } catch {
      return tr("内容不是有效 JSON");
    }
  }
  return value.utf8 ?? tr("非 UTF-8 数据（{{0}} bytes）", [value.byteLength]);
}

function binaryValues(reply: RedisReply | null): RedisBinaryValue[] {
  if (!reply) return [];
  if (reply.type === "binary") return [reply.value];
  if (reply.type !== "array") return [];
  return reply.value.flatMap((item) => binaryValues(item));
}

export function detectRedisValueView(reply: RedisReply | null, keyType: RedisKeyType): RedisValueView {
  const values = binaryValues(reply);
  if (values.some((value) => value.utf8 === null)) return "base64";
  if (keyType === "string" && values.length === 1) {
    try {
      JSON.parse(values[0].utf8 ?? "");
      return "json";
    } catch {
      // Ordinary UTF-8 text remains in its original representation.
    }
  }
  return "utf8";
}

function replyValue(reply: RedisReply | undefined, view: RedisValueView): string {
  if (!reply || reply.type === "null") return "(nil)";
  if (reply.type === "integer") return reply.value;
  if (reply.type === "binary") return redisBinaryDisplay(reply.value, view);
  return reply.value.map((item) => replyValue(item, view)).join(" · ");
}

function replyItems(reply: RedisReply | null): RedisReply[] {
  return reply?.type === "array" ? reply.value : [];
}

function scanItems(reply: RedisReply | null): RedisReply[] {
  const outer = replyItems(reply);
  return outer[1]?.type === "array" ? outer[1].value : [];
}

function pairedRows(items: RedisReply[], view: RedisValueView): RedisDetailRow[] {
  const rows: RedisDetailRow[] = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push({
      index: rows.length + 1,
      primary: replyValue(items[index], view),
      secondary: replyValue(items[index + 1], view),
    });
  }
  return rows;
}

export function redisDetailRows(keyType: RedisKeyType, reply: RedisReply | null, view: RedisValueView): RedisDetailRow[] | null {
  if (keyType === "string" || keyType === "none") return null;
  if (keyType === "hash") return pairedRows(scanItems(reply), view);
  if (keyType === "set") {
    return scanItems(reply).map((item, index) => ({ index: index + 1, primary: replyValue(item, view), secondary: "" }));
  }
  if (keyType === "list") {
    return replyItems(reply).map((item, index) => ({ index: index + 1, primary: replyValue(item, view), secondary: "" }));
  }
  if (keyType === "zset") return pairedRows(replyItems(reply), view);
  return replyItems(reply).map((entry, index) => {
    const parts = replyItems(entry);
    const fields = parts[1]?.type === "array" ? pairedRows(parts[1].value, view) : [];
    return {
      index: index + 1,
      primary: replyValue(parts[0] ?? entry, view),
      secondary: fields.map((field) => `${field.primary} = ${field.secondary}`).join("\n"),
    };
  });
}

export function redisDetailCursor(keyType: RedisKeyType, reply: RedisReply | null): string | null {
  if (keyType !== "hash" && keyType !== "set") return null;
  const cursor = replyItems(reply)[0];
  if (cursor?.type === "integer") return cursor.value;
  if (cursor?.type === "binary") return cursor.value.utf8;
  return null;
}
