<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  AlertTriangle,
  Braces,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock3,
  Copy,
  CornerDownRight,
  Database,
  FolderTree,
  Gauge,
  Info,
  KeyRound,
  List,
  MemoryStick,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api } from "../api";
import { rememberActiveConnectionOrigin } from "../active-connection-origin";
import {
  detectRedisValueView,
  redisBinaryDisplay,
  redisDatabaseOptions,
  redisDetailCursor,
  redisDetailRows,
  redisKeyGroupPaths,
  redisKeyTreeRows,
  redisKeyspaceStats,
  type RedisValueView,
} from "../redis-workbench-format";
import RedisCommandEditor from "./RedisCommandEditor.vue";
import TipIcon from "./TipIcon.vue";

const props = withDefaults(defineProps<{
  environmentId?: string;
  initialConnectionId?: string;
  workspaceKey?: string;
}>(), { workspaceKey: "fixed:redis" });
const router = useRouter();

interface BinaryValue { base64: string; utf8: string | null; byteLength: number }
type RedisReply =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "binary"; value: BinaryValue }
  | { type: "array"; value: RedisReply[] };

interface RedisConnection {
  id: string;
  type: "redis";
  name: string;
  host: string;
  port: number;
  username: string;
  environmentIds: string[];
  connectionGroupPath: string | null;
  defaultDatabase: number;
  connectionMode: "tcp" | "sshTunnel";
  options: { keySeparator?: string; readOnly?: boolean; tls?: { enabled?: boolean } };
}

interface KeyItem { key: BinaryValue; type: "string" | "hash" | "list" | "set" | "zset" | "stream" | "none"; ttlMs: number }
interface ScanResponse { cursor: string; complete: boolean; items: KeyItem[] }
interface CommandResponse { result: RedisReply; durationMs: number; byteLength: number }
interface InfoResponse { info: Record<string, Record<string, string>>; database: number }
interface ConsoleResult { id: string; command: string; status: "success" | "error"; durationMs: number; byteLength: number; result: RedisReply | null; error: string; createdAt: string }

const commandNames = [
  "PING", "DBSIZE", "INFO", "TYPE", "EXISTS", "GET", "STRLEN", "MGET", "SET", "MSET", "DEL", "UNLINK",
  "TTL", "PTTL", "EXPIRE", "PEXPIRE", "PERSIST", "RENAME", "RENAMENX", "COPY", "SCAN", "MEMORY USAGE",
  "HLEN", "HGET", "HMGET", "HSCAN", "HSET", "HDEL", "LLEN", "LRANGE", "LPUSH", "RPUSH", "LPOP", "RPOP", "LSET", "LREM",
  "SCARD", "SSCAN", "SISMEMBER", "SADD", "SREM", "ZCARD", "ZRANGE", "ZREVRANGE", "ZSCAN", "ZSCORE", "ZADD", "ZREM",
  "XLEN", "XRANGE", "XREVRANGE", "XADD", "XDEL", "SLOWLOG GET", "SLOWLOG LEN", "OBJECT ENCODING",
];

const loading = ref(true);
const busy = ref(false);
const connections = ref<RedisConnection[]>([]);
const selectedConnectionId = ref("");
const connectionSearch = ref("");
const activeSection = ref<"keys" | "command" | "diagnostics">("keys");
const databaseNumber = ref(0);
const keyPattern = ref("*");
const keyType = ref("");
const scanCount = ref(200);
const scanCursor = ref("0");
const scanComplete = ref(false);
const scanStarted = ref(false);
const scannedBatches = ref(0);
const retainedKeys = ref<KeyItem[]>([]);
const selectedKeyBase64 = ref("");
const detailResult = ref<RedisReply | null>(null);
const detailLoading = ref(false);
const memoryBytes = ref<number | null>(null);
const keyView = ref<"list" | "tree">("tree");
const expandedKeyGroups = ref<Set<string>>(new Set());
const valueView = ref<RedisValueView>("utf8");
const inputEncoding = ref<"utf8" | "hex" | "base64">("utf8");
const mutationPrimary = ref("");
const mutationSecondary = ref("");
const mutationScore = ref("0");
const commandText = ref("PING");
const commandRunning = ref(false);
const commandResults = ref<ConsoleResult[]>([]);
const favorites = ref<string[]>([]);
const info = ref<Record<string, Record<string, string>>>({});
const slowLog = ref<RedisReply | null>(null);
const diagnosticsLoading = ref(false);
const createDialog = ref(false);
const createType = ref<KeyItem["type"]>("string");
const createKey = ref("");
const createPrimary = ref("");
const createSecondary = ref("");
const createScore = ref("0");
const testState = ref<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
const workspaceError = ref("");
const redisSessionId = ref("");
let detailRequestVersion = 0;
let redisSessionPollTimer: number | undefined;
let redisSessionPromise: Promise<void> | null = null;

const persistencePrefix = computed(() => `viron:redis:${props.workspaceKey}:${props.environmentId ?? "global"}`);
const selectedConnection = computed(() => connections.value.find((item) => item.id === selectedConnectionId.value) ?? null);
const selectedKey = computed(() => retainedKeys.value.find((item) => item.key.base64 === selectedKeyBase64.value) ?? null);
const readOnly = computed(() => Boolean(selectedConnection.value?.options.readOnly));
const filteredConnections = computed(() => {
  const query = connectionSearch.value.trim().toLowerCase();
  return query ? connections.value.filter((item) => `${item.name} ${item.host} ${item.username}`.toLowerCase().includes(query)) : connections.value;
});
const groupedConnections = computed(() => {
  const groups = new Map<string, RedisConnection[]>();
  for (const connection of filteredConnections.value) {
    const path = connection.connectionGroupPath || tr("未分组");
    groups.set(path, [...(groups.get(path) ?? []), connection]);
  }
  return [...groups.entries()].sort(([left], [right]) => left === tr("未分组") ? 1 : right === tr("未分组") ? -1 : left.localeCompare(right, "zh-CN"));
});
const keySeparator = computed(() => selectedConnection.value?.options.keySeparator || ":");
const keyTreeRows = computed(() => redisKeyTreeRows(retainedKeys.value, keySeparator.value, expandedKeyGroups.value));
const serverSummary = computed(() => ({
  version: info.value.server?.redis_version || "—",
  mode: info.value.server?.redis_mode || "standalone",
  uptime: info.value.server?.uptime_in_days ? tr("{0} 天", [info.value.server.uptime_in_days]) : "—",
  memory: info.value.memory?.used_memory_human || "—",
  clients: info.value.clients?.connected_clients || "—",
}));
const keyspaceSummary = computed(() => {
  const values = redisKeyspaceStats(info.value.keyspace?.[`db${databaseNumber.value}`]);
  return { keys: values.keys || retainedKeys.value.length, expires: values.expires };
});
const databaseOptions = computed(() => redisDatabaseOptions(
  info.value.keyspace,
  databaseNumber.value,
  selectedConnection.value?.defaultDatabase ?? 0,
));
const detailRows = computed(() => redisDetailRows(selectedKey.value?.type ?? "none", detailResult.value, valueView.value));
const detailCursor = computed(() => redisDetailCursor(selectedKey.value?.type ?? "none", detailResult.value));
const detailPreviewMeta = computed(() => {
  if (detailRows.value === null) return "";
  return tr("{0} 项{1}", [detailRows.value.length, detailCursor.value && detailCursor.value !== "0" ? tr(" · 仍有更多") : ""]);
});
const detailColumns = computed<[string, string]>(() => {
  if (selectedKey.value?.type === "hash") return [tr("字段"), tr("值")];
  if (selectedKey.value?.type === "zset") return [tr("成员"), tr("分数")];
  if (selectedKey.value?.type === "stream") return ["Entry ID", tr("字段和值")];
  return [selectedKey.value?.type === "set" ? tr("成员") : tr("元素"), ""];
});
const detectedValueLabel = computed(() => {
  if (!selectedKey.value || !detailResult.value) return "";
  if (selectedKey.value.type !== "string") return selectedKey.value.type.toUpperCase();
  const detected = detectRedisValueView(detailResult.value, selectedKey.value.type);
  return detected === "base64" ? tr("自动识别 · 二进制") : detected === "json" ? tr("自动识别 · JSON") : tr("自动识别 · UTF-8");
});
const quickCommands = ["PING", "DBSIZE", "INFO server", "INFO memory", "SLOWLOG GET 16"];

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatTtl(value: number): string {
  if (value === -1) return tr("永久");
  if (value === -2) return tr("已失效");
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return tr("{0} 秒", [Math.ceil(value / 1000)]);
  if (value < 3_600_000) return tr("{0} 分钟", [Math.ceil(value / 60_000)]);
  if (value < 86_400_000) return tr("{0} 小时", [Math.ceil(value / 3_600_000)]);
  return tr("{0} 天", [Math.ceil(value / 86_400_000)]);
}

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success(tr("{0}已复制", [label]));
  } catch {
    ElMessage.error(tr("无法复制{0}", [label]));
  }
}

function openConnectionCreate() {
  void router.push({ name: "connections", query: { create: "redis" } });
}

async function retryCurrentSection() {
  workspaceError.value = "";
  if (activeSection.value === "diagnostics") await loadDiagnostics();
  else if (activeSection.value === "keys") await Promise.all([loadInfo().catch(() => undefined), scanKeys(true)]);
  else await testConnection();
}

function binaryLabel(value: BinaryValue): string {
  return value.utf8 ?? `base64:${value.base64}`;
}

function keyTreeStorageKey(): string {
  return `${persistencePrefix.value}:tree-expanded:${selectedConnectionId.value || "none"}`;
}

function loadKeyTreeExpansion() {
  try {
    const saved = JSON.parse(localStorage.getItem(keyTreeStorageKey()) || "[]") as unknown;
    expandedKeyGroups.value = new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : []);
  } catch {
    expandedKeyGroups.value = new Set();
  }
}

function saveKeyTreeExpansion() {
  localStorage.setItem(keyTreeStorageKey(), JSON.stringify([...expandedKeyGroups.value]));
}

function toggleKeyGroup(path: string) {
  const next = new Set(expandedKeyGroups.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expandedKeyGroups.value = next;
  saveKeyTreeExpansion();
}

function expandKeyGroups(item: KeyItem) {
  const paths = redisKeyGroupPaths(item.key, keySeparator.value);
  if (!paths.some((path) => !expandedKeyGroups.value.has(path))) return;
  expandedKeyGroups.value = new Set([...expandedKeyGroups.value, ...paths]);
  saveKeyTreeExpansion();
}

function switchKeyView(view: "list" | "tree") {
  keyView.value = view;
  localStorage.setItem(`${persistencePrefix.value}:key-view`, view);
  if (view === "tree" && selectedKey.value) expandKeyGroups(selectedKey.value);
}

function keyTreeIndent(depth: number): Record<string, string> {
  return { "--redis-tree-indent": `${8 + depth * 16}px` };
}

function keyArgument(item = selectedKey.value): { base64: string } {
  if (!item) throw new Error(tr("请先选择 Redis 键"));
  return { base64: item.key.base64 };
}

function bytesFromHex(value: string): Uint8Array {
  const normalized = value.replaceAll(/\s+/g, "");
  if (!normalized || normalized.length % 2 || !/^[0-9a-f]+$/i.test(normalized)) throw new Error(tr("十六进制内容无效"));
  return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodedArgument(value: string): string | { base64: string } {
  if (inputEncoding.value === "utf8") return value;
  if (inputEncoding.value === "hex") return { base64: bytesBase64(bytesFromHex(value)) };
  const normalized = value.replaceAll(/\s+/g, "");
  try {
    if (btoa(atob(normalized)).replace(/=+$/, "") !== normalized.replace(/=+$/, "")) throw new Error();
  } catch {
    throw new Error(tr("Base64 内容无效"));
  }
  return { base64: normalized };
}

function binaryDisplay(value: BinaryValue): string {
  return redisBinaryDisplay(value, valueView.value);
}

function displayReply(reply: RedisReply | null, depth = 0): string {
  if (!reply) return "";
  if (reply.type === "null") return "(nil)";
  if (reply.type === "integer") return reply.value;
  if (reply.type === "binary") return binaryDisplay(reply.value);
  return reply.value.map((item, index) => `${"  ".repeat(depth)}${index + 1}) ${displayReply(item, depth + 1)}`).join("\n");
}

function replyText(reply: RedisReply | undefined): string {
  if (!reply) return "";
  if (reply.type === "binary") return reply.value.utf8 ?? "";
  if (reply.type === "integer") return reply.value;
  return "";
}

function databaseOptionLabel(database: number, keys: number): string {
  return keys ? tr("数据库 {0} · {1} 个键", [database, keys]) : tr("数据库 {0}", [database]);
}

function detailCopyText(): string {
  if (detailRows.value === null) return displayReply(detailResult.value);
  return detailRows.value.map((row) => row.secondary ? `${row.primary}\t${row.secondary}` : row.primary).join("\n");
}

function detailCommand(item: KeyItem): { command: string; args: Array<string | { base64: string }> } {
  const key = keyArgument(item);
  if (item.type === "string") return { command: "GET", args: [key] };
  if (item.type === "hash") return { command: "HSCAN", args: [key, "0", "COUNT", "500"] };
  if (item.type === "list") return { command: "LRANGE", args: [key, "0", "499"] };
  if (item.type === "set") return { command: "SSCAN", args: [key, "0", "COUNT", "500"] };
  if (item.type === "zset") return { command: "ZRANGE", args: [key, "0", "499", "WITHSCORES"] };
  if (item.type === "stream") return { command: "XRANGE", args: [key, "-", "+", "COUNT", "500"] };
  return { command: "TYPE", args: [key] };
}

async function redisCommand(command: string, args: Array<string | { base64: string }>, database = databaseNumber.value): Promise<CommandResponse> {
  if (!selectedConnectionId.value) throw new Error(tr("请先选择 Redis 连接"));
  return api<CommandResponse>(`/api/v1/redis-connections/${selectedConnectionId.value}/command`, {
    method: "POST",
    body: JSON.stringify({ database, command, args }),
  });
}

async function ensureRedisSession(): Promise<void> {
  if (!selectedConnectionId.value || redisSessionId.value) return;
  if (redisSessionPromise) return redisSessionPromise;
  const connectionId = selectedConnectionId.value;
  const pending = (async () => {
    const response = await api<{ item: { id: string } }>("/api/v1/redis-sessions", {
      method: "POST",
      body: JSON.stringify({ connectionId, originEnvironmentId: props.environmentId }),
    });
    redisSessionId.value = response.item.id;
    rememberActiveConnectionOrigin(response.item.id, props.environmentId);
  })();
  redisSessionPromise = pending;
  try {
    await pending;
  } finally {
    if (redisSessionPromise === pending) redisSessionPromise = null;
  }
}

async function closeRedisSession(): Promise<void> {
  await redisSessionPromise?.catch(() => undefined);
  const id = redisSessionId.value;
  redisSessionId.value = "";
  if (id) await api(`/api/v1/active-connections/${id}`, { method: "DELETE" }).catch(() => undefined);
}

async function loadConnections() {
  loading.value = true;
  workspaceError.value = "";
  try {
    const query = new URLSearchParams({ assignment: "all", type: "redis" });
    if (props.environmentId) query.set("environmentId", props.environmentId);
    const response = await api<{ items: RedisConnection[] }>(`/api/v1/connections?${query.toString()}`);
    connections.value = response.items;
    const saved = localStorage.getItem(`${persistencePrefix.value}:connection`) || "";
    const preferred = props.initialConnectionId || saved;
    selectedConnectionId.value = response.items.some((item) => item.id === preferred) ? preferred : response.items[0]?.id ?? "";
    loadKeyTreeExpansion();
    if (selectedConnection.value) databaseNumber.value = selectedConnection.value.defaultDatabase;
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : tr("加载 Redis 连接失败");
    ElMessage.error(workspaceError.value);
  } finally {
    loading.value = false;
  }
}

async function testConnection() {
  if (!selectedConnectionId.value) return;
  busy.value = true;
  testState.value = null;
  workspaceError.value = "";
  try {
    const response = await api<{ ok: boolean; latencyMs: number; version: string }>(`/api/v1/redis-connections/${selectedConnectionId.value}/test`, { method: "POST" });
    await ensureRedisSession();
    testState.value = { ok: true, latencyMs: response.latencyMs, message: `Redis ${response.version || tr("兼容服务")}` };
    ElMessage.success(tr("连接成功 · {0} ms", [response.latencyMs]));
  } catch (error) {
    const message = error instanceof Error ? error.message : tr("Redis 连接失败");
    testState.value = { ok: false, message };
    workspaceError.value = message;
    ElMessage.error(message);
  } finally {
    busy.value = false;
  }
}

async function loadInfo() {
  if (!selectedConnectionId.value) return;
  const response = await api<InfoResponse>(`/api/v1/redis-connections/${selectedConnectionId.value}/info?database=${databaseNumber.value}`);
  await ensureRedisSession();
  info.value = response.info;
  workspaceError.value = "";
}

function resetScan() {
  detailRequestVersion += 1;
  scanCursor.value = "0";
  scanComplete.value = false;
  scanStarted.value = false;
  scannedBatches.value = 0;
  retainedKeys.value = [];
  selectedKeyBase64.value = "";
  detailResult.value = null;
  memoryBytes.value = null;
}

async function scanKeys(reset = false) {
  if (!selectedConnectionId.value || busy.value || (scanComplete.value && !reset)) return;
  if (reset) resetScan();
  busy.value = true;
  try {
    do {
      const response = await api<ScanResponse>(`/api/v1/redis-connections/${selectedConnectionId.value}/scan`, {
        method: "POST",
        body: JSON.stringify({
          database: databaseNumber.value,
          cursor: scanCursor.value,
          pattern: keyPattern.value || "*",
          count: scanCount.value,
          type: keyType.value || undefined,
        }),
      });
      scanStarted.value = true;
      scannedBatches.value += 1;
      scanCursor.value = response.cursor;
      scanComplete.value = response.complete;
      const seen = new Set(retainedKeys.value.map((item) => item.key.base64));
      const merged = [...retainedKeys.value];
      for (const item of response.items) {
        if (!seen.has(item.key.base64)) {
          seen.add(item.key.base64);
          if (merged.length < 10_000) merged.push(item);
        }
      }
      retainedKeys.value = merged.sort((left, right) => binaryLabel(left.key).localeCompare(binaryLabel(right.key)));
      if (merged.length >= 10_000 && !response.complete) {
        ElMessage.warning(tr("已达到 10,000 个键的界面保留上限，请缩小匹配范围"));
        break;
      }
    } while (!scanComplete.value);
    workspaceError.value = "";
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : tr("扫描 Redis 键失败");
    ElMessage.error(workspaceError.value);
  } finally {
    busy.value = false;
  }
}

async function selectKey(item: KeyItem) {
  if (keyView.value === "tree") expandKeyGroups(item);
  const requestVersion = ++detailRequestVersion;
  selectedKeyBase64.value = item.key.base64;
  detailLoading.value = true;
  detailResult.value = null;
  memoryBytes.value = null;
  valueView.value = "utf8";
  mutationPrimary.value = "";
  mutationSecondary.value = "";
  inputEncoding.value = "utf8";
  try {
    const detail = await redisCommand(detailCommand(item).command, detailCommand(item).args);
    if (requestVersion !== detailRequestVersion || selectedKeyBase64.value !== item.key.base64) return;
    detailResult.value = detail.result;
    valueView.value = detectRedisValueView(detail.result, item.type);
    if (item.type === "string" && detail.result.type === "binary") {
      inputEncoding.value = detail.result.value.utf8 === null ? "base64" : "utf8";
      mutationPrimary.value = detail.result.value.utf8 ?? detail.result.value.base64;
    }
    const memory = await redisCommand("MEMORY", ["USAGE", keyArgument(item)]).catch(() => null);
    if (requestVersion !== detailRequestVersion || selectedKeyBase64.value !== item.key.base64) return;
    const memoryValue = replyText(memory?.result);
    memoryBytes.value = /^\d+$/.test(memoryValue) ? Number(memoryValue) : null;
    workspaceError.value = "";
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : tr("读取 Redis 键失败");
    ElMessage.error(workspaceError.value);
  } finally {
    if (requestVersion === detailRequestVersion) detailLoading.value = false;
  }
}

async function refreshSelected() {
  if (selectedKey.value) await selectKey(selectedKey.value);
}

async function executeMutation(command: string, args: Array<string | { base64: string }>, success: string, refreshScan = false) {
  if (readOnly.value) return ElMessage.warning(tr("当前 Redis 连接为只读模式"));
  busy.value = true;
  try {
    await redisCommand(command, args);
    ElMessage.success(success);
    workspaceError.value = "";
    if (refreshScan) await scanKeys(true);
    else await refreshSelected();
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : tr("Redis 操作失败");
    ElMessage.error(workspaceError.value);
  } finally {
    busy.value = false;
  }
}

async function saveTypedValue() {
  const item = selectedKey.value;
  if (!item) return;
  const key = keyArgument(item);
  try {
    if (item.type === "string") return executeMutation("SET", [key, encodedArgument(mutationPrimary.value), "KEEPTTL"], tr("String 值已保存"));
    if (item.type === "hash") return executeMutation("HSET", [key, encodedArgument(mutationPrimary.value), encodedArgument(mutationSecondary.value)], tr("Hash 字段已保存"));
    if (item.type === "list") return executeMutation("RPUSH", [key, encodedArgument(mutationPrimary.value)], tr("元素已追加到 List 尾部"));
    if (item.type === "set") return executeMutation("SADD", [key, encodedArgument(mutationPrimary.value)], tr("Set 成员已添加"));
    if (item.type === "zset") return executeMutation("ZADD", [key, mutationScore.value, encodedArgument(mutationPrimary.value)], tr("Sorted Set 成员已保存"));
    if (item.type === "stream") return executeMutation("XADD", [key, "*", encodedArgument(mutationPrimary.value), encodedArgument(mutationSecondary.value)], tr("Stream entry 已追加"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("输入内容无效"));
  }
}

async function removeTypedValue() {
  const item = selectedKey.value;
  if (!item || !mutationPrimary.value) return ElMessage.warning(tr("请填写要删除的字段、成员或 entry ID"));
  const key = keyArgument(item);
  try {
    if (item.type === "hash") return executeMutation("HDEL", [key, encodedArgument(mutationPrimary.value)], tr("Hash 字段已删除"));
    if (item.type === "set") return executeMutation("SREM", [key, encodedArgument(mutationPrimary.value)], tr("Set 成员已删除"));
    if (item.type === "zset") return executeMutation("ZREM", [key, encodedArgument(mutationPrimary.value)], tr("Sorted Set 成员已删除"));
    if (item.type === "stream") return executeMutation("XDEL", [key, mutationPrimary.value], tr("Stream entry 已删除"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("输入内容无效"));
  }
}

async function listEdge(command: "LPUSH" | "RPUSH" | "LPOP" | "RPOP") {
  if (!selectedKey.value) return;
  const args: Array<string | { base64: string }> = [keyArgument()];
  if (command.endsWith("PUSH")) {
    try { args.push(encodedArgument(mutationPrimary.value)); } catch (error) { return ElMessage.error((error as Error).message); }
  }
  await executeMutation(command, args, command.endsWith("PUSH") ? tr("List 元素已写入") : tr("List 端点元素已移除"));
}

async function renameKey(copy = false) {
  if (!selectedKey.value) return;
  try {
    const result = await ElMessageBox.prompt(copy ? tr("输入目标键名；COPY 不会删除源键。") : tr("输入新的键名；并发写入时以 Redis 实际执行结果为准。"), copy ? tr("复制 Redis 键") : tr("重命名 Redis 键"), {
      confirmButtonText: copy ? tr("复制") : tr("重命名"), cancelButtonText: tr("取消"), inputPattern: /.+/, inputErrorMessage: tr("键名不能为空"),
    });
    await executeMutation(copy ? "COPY" : "RENAME", [keyArgument(), result.value], copy ? tr("Redis 键已复制") : tr("Redis 键已重命名"), true);
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("键操作失败"));
  }
}

async function changeTtl() {
  if (!selectedKey.value) return;
  try {
    const result = await ElMessageBox.prompt(tr("输入相对过期秒数（1–2147483647）"), tr("设置 Redis 键 TTL"), {
      confirmButtonText: tr("设置"), cancelButtonText: tr("取消"), inputPattern: /^[1-9]\d{0,9}$/, inputErrorMessage: tr("请输入正整数秒数"),
    });
    await executeMutation("EXPIRE", [keyArgument(), result.value], tr("TTL 已更新"), true);
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("设置 TTL 失败"));
  }
}

async function deleteSelectedKey() {
  if (!selectedKey.value) return;
  try {
    await ElMessageBox.confirm(tr("确定异步删除键“{0}”吗？", [binaryLabel(selectedKey.value.key)]), tr("删除 Redis 键"), { type: "warning", confirmButtonText: tr("UNLINK 删除"), cancelButtonText: tr("取消") });
    await executeMutation("UNLINK", [keyArgument()], tr("Redis 键已提交异步删除"), true);
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("删除键失败"));
  }
}

async function createRedisKey() {
  if (readOnly.value) return ElMessage.warning(tr("当前 Redis 连接为只读模式"));
  if (!createKey.value) return ElMessage.warning(tr("请输入键名"));
  let command = "SET";
  let args: Array<string | { base64: string }> = [createKey.value, createPrimary.value];
  if (createType.value === "hash") { command = "HSET"; args = [createKey.value, createPrimary.value || "field", createSecondary.value]; }
  if (createType.value === "list") { command = "RPUSH"; args = [createKey.value, createPrimary.value]; }
  if (createType.value === "set") { command = "SADD"; args = [createKey.value, createPrimary.value]; }
  if (createType.value === "zset") { command = "ZADD"; args = [createKey.value, createScore.value, createPrimary.value]; }
  if (createType.value === "stream") { command = "XADD"; args = [createKey.value, "*", createPrimary.value || "field", createSecondary.value]; }
  busy.value = true;
  try {
    await redisCommand(command, args);
    createDialog.value = false;
    ElMessage.success(tr("Redis 键已创建"));
    workspaceError.value = "";
    await scanKeys(true);
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : tr("创建 Redis 键失败");
    ElMessage.error(workspaceError.value);
  } finally {
    busy.value = false;
  }
}

function parseCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of line.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = ""; }
    } else current += character;
  }
  if (escaped || quote) throw new Error(tr("命令包含未闭合的引号或转义符"));
  if (current) tokens.push(current);
  return tokens;
}

async function executeConsole(text = commandText.value) {
  if (!selectedConnectionId.value || commandRunning.value) return;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) return ElMessage.warning(tr("请输入 Redis 命令"));
  if (lines.length > 20) return ElMessage.warning(tr("单次最多逐条执行 20 条命令"));
  commandRunning.value = true;
  const newResults: ConsoleResult[] = [];
  for (const line of lines) {
    const started = Date.now();
    try {
      const tokens = parseCommandLine(line);
      if (!tokens.length) continue;
      const response = await redisCommand(tokens[0], tokens.slice(1));
      newResults.unshift({ id: crypto.randomUUID(), command: line, status: "success", durationMs: response.durationMs, byteLength: response.byteLength, result: response.result, error: "", createdAt: new Date().toISOString() });
    } catch (error) {
      newResults.unshift({ id: crypto.randomUUID(), command: line, status: "error", durationMs: Date.now() - started, byteLength: 0, result: null, error: error instanceof Error ? error.message : tr("命令执行失败"), createdAt: new Date().toISOString() });
    }
  }
  commandResults.value = [...newResults, ...commandResults.value].slice(0, 100);
  localStorage.setItem(`${persistencePrefix.value}:command-history`, JSON.stringify(commandResults.value.slice(0, 30)));
  commandRunning.value = false;
}

function clearCommandResults() {
  commandResults.value = [];
  localStorage.removeItem(`${persistencePrefix.value}:command-history`);
}

async function executeQuickCommand(command: string) {
  activeSection.value = "command";
  commandText.value = command;
  await executeConsole(command);
}

function toggleFavorite() {
  const value = commandText.value.trim();
  if (!value) return;
  favorites.value = favorites.value.includes(value) ? favorites.value.filter((item) => item !== value) : [value, ...favorites.value].slice(0, 30);
  localStorage.setItem(`${persistencePrefix.value}:favorites`, JSON.stringify(favorites.value));
}

async function loadDiagnostics() {
  if (!selectedConnectionId.value || diagnosticsLoading.value) return;
  diagnosticsLoading.value = true;
  try {
    await loadInfo();
    slowLog.value = (await redisCommand("SLOWLOG", ["GET", "32"])).result;
    workspaceError.value = "";
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : tr("加载 Redis 诊断信息失败");
    ElMessage.error(workspaceError.value);
  } finally {
    diagnosticsLoading.value = false;
  }
}

async function activateConnection(id: string) {
  if (id === selectedConnectionId.value && scanStarted.value) return;
  await closeRedisSession();
  selectedConnectionId.value = id;
  localStorage.setItem(`${persistencePrefix.value}:connection`, id);
  loadKeyTreeExpansion();
  databaseNumber.value = selectedConnection.value?.defaultDatabase ?? 0;
  testState.value = null;
  workspaceError.value = "";
  info.value = {};
  slowLog.value = null;
  resetScan();
  await Promise.all([loadInfo().catch(() => undefined), scanKeys(true)]);
}

async function focusInitialConnection(): Promise<void> {
  const id = props.initialConnectionId;
  if (!id || loading.value || selectedConnectionId.value === id) return;
  if (!connections.value.some((connection) => connection.id === id)) return;
  await activateConnection(id);
  await nextTick();
}

async function pollRedisSession(): Promise<void> {
  const id = redisSessionId.value;
  if (!id) return;
  try {
    await api(`/api/v1/active-connections/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && redisSessionId.value === id) redisSessionId.value = "";
  }
}

watch(databaseNumber, async () => {
  if (!selectedConnectionId.value) return;
  resetScan();
  await Promise.all([loadInfo().catch(() => undefined), scanKeys(true)]);
});

watch(activeSection, (section) => { if (section === "diagnostics" && !Object.keys(info.value).length) void loadDiagnostics(); });
watch(() => props.initialConnectionId, () => { void focusInitialConnection(); });

onMounted(async () => {
  try {
    commandResults.value = JSON.parse(localStorage.getItem(`${persistencePrefix.value}:command-history`) || "[]") as ConsoleResult[];
    favorites.value = JSON.parse(localStorage.getItem(`${persistencePrefix.value}:favorites`) || "[]") as string[];
    keyView.value = localStorage.getItem(`${persistencePrefix.value}:key-view`) === "list" ? "list" : "tree";
  } catch { /* Ignore corrupt local UI state. */ }
  await loadConnections();
  if (selectedConnectionId.value) await Promise.all([loadInfo().catch(() => undefined), scanKeys(true)]);
  redisSessionPollTimer = window.setInterval(() => void pollRedisSession(), 3_000);
});
onActivated(() => { void focusInitialConnection(); });
onBeforeUnmount(() => {
  window.clearInterval(redisSessionPollTimer);
  void closeRedisSession();
});
</script>

<template>
  <div class="redis-workbench" data-testid="redis-workbench" v-loading="loading">
    <aside class="redis-connections">
      <header class="redis-pane-heading">
        <span class="redis-brand-mark"><MemoryStick :size="17" /></span>
        <div><strong>Redis</strong><small>{{ connections.length }} {{ $t('个连接') }}</small></div>
        <div class="redis-pane-actions">
          <button type="button" :aria-label="$t('刷新 Redis 连接')" :title="$t('刷新 Redis 连接')" @click="loadConnections"><RotateCcw :size="14" /></button>
          <button type="button" :aria-label="$t('新建 Redis 连接')" :title="$t('新建 Redis 连接')" @click="openConnectionCreate"><Plus :size="14" /></button>
        </div>
      </header>
      <el-input v-model="connectionSearch" clearable size="small" :placeholder="$t('搜索连接')"><template #prefix><Search :size="14" /></template></el-input>
      <div class="redis-connection-list">
        <section v-for="[group, items] in groupedConnections" :key="group">
          <h4><FolderTree :size="13" /><span>{{ group }}</span><small>{{ items.length }}</small></h4>
          <button v-for="connection in items" :key="connection.id" :class="{ 'is-active': selectedConnectionId === connection.id }" @click="activateConnection(connection.id)">
            <span class="redis-connection-icon"><Server :size="14" /></span>
            <div>
              <strong>{{ connection.name }}</strong>
              <small>{{ connection.host }}:{{ connection.port }} · DB {{ connection.defaultDatabase }}</small>
            </div>
            <em v-if="connection.options.readOnly">{{ $t('只读') }}</em><ChevronRight v-else :size="14" />
          </button>
        </section>
        <div v-if="!filteredConnections.length" class="redis-empty-mini">
          <Search v-if="connections.length" :size="21" /><MemoryStick v-else :size="22" />
          <strong>{{ connections.length ? $t('没有匹配的连接') : $t('还没有 Redis 连接') }}</strong>
          <el-button v-if="!connections.length" size="small" type="primary" @click="openConnectionCreate"><Plus :size="14" />{{ $t('新建连接') }}</el-button>
        </div>
      </div>
    </aside>

    <main v-if="selectedConnection" class="redis-main">
      <header class="redis-topbar">
        <div class="redis-endpoint">
          <span class="redis-brand-mark"><MemoryStick :size="17" /></span>
          <div><strong>{{ selectedConnection.name }}</strong><small>{{ selectedConnection.username ? `${selectedConnection.username}@` : '' }}{{ selectedConnection.host }}:{{ selectedConnection.port }} · {{ selectedConnection.connectionMode === 'sshTunnel' ? 'SSH Tunnel' : 'TCP' }}<template v-if="selectedConnection.options.tls?.enabled"> · TLS</template></small></div>
          <i v-if="readOnly" class="redis-readonly-badge"><ShieldCheck :size="12" />{{ $t('只读') }}</i>
        </div>
        <nav :aria-label="$t('Redis 工作区')">
          <button :class="{ 'is-active': activeSection === 'keys' }" @click="activeSection = 'keys'"><KeyRound :size="15" />{{ $t('键空间') }}</button>
          <button :class="{ 'is-active': activeSection === 'command' }" @click="activeSection = 'command'"><TerminalSquare :size="15" />{{ $t('命令') }}</button>
          <button :class="{ 'is-active': activeSection === 'diagnostics' }" @click="activeSection = 'diagnostics'; loadDiagnostics()"><Gauge :size="15" />{{ $t('诊断') }}</button>
        </nav>
        <div class="redis-topbar-actions">
          <el-select v-model="databaseNumber" class="redis-database-select" size="small" :aria-label="$t('选择 Redis 数据库')" popper-class="redis-database-popper">
            <template #prefix><Database :size="14" /></template>
            <el-option v-for="item in databaseOptions" :key="item.database" :value="item.database" :label="databaseOptionLabel(item.database, item.keys)">
              <span class="redis-database-option"><span>{{ $t('数据库') }} {{ item.database }}</span><small>{{ item.keys ? $t('{0} 个键', [item.keys]) : $t('空') }}</small></span>
            </el-option>
          </el-select>
          <el-button size="small" :loading="busy" @click="testConnection"><CircleCheck :size="14" />{{ $t('测试连接') }}</el-button>
        </div>
      </header>

      <div v-if="testState" class="redis-test-state" :class="testState.ok ? 'is-success' : 'is-error'"><CircleCheck v-if="testState.ok" :size="15" /><CircleX v-else :size="15" /><span>{{ testState.message }}</span><small v-if="testState.latencyMs !== undefined">{{ testState.latencyMs }} ms</small></div>
      <div v-if="workspaceError && !testState?.ok" class="redis-workspace-error"><AlertTriangle :size="15" /><span>{{ workspaceError }}</span><button type="button" @click="retryCurrentSection"><RotateCcw :size="13" />{{ $t('重试') }}</button><button type="button" :aria-label="$t('关闭错误提示')" :title="$t('关闭错误提示')" @click="workspaceError = ''"><X :size="13" /></button></div>

      <section v-if="activeSection === 'keys'" class="redis-keyspace">
        <div class="redis-scan-toolbar">
          <el-input v-model="keyPattern" :placeholder="$t('SCAN glob，例如 user:*')" @keyup.enter="scanKeys(true)"><template #prefix><Search :size="15" /></template></el-input>
          <el-select v-model="keyType"><el-option :label="$t('全部类型')" value="" /><el-option v-for="item in ['string','hash','list','set','zset','stream']" :key="item" :label="item" :value="item" /></el-select>
          <el-select v-model="scanCount"><el-option label="COUNT 100" :value="100" /><el-option label="COUNT 200" :value="200" /><el-option label="COUNT 500" :value="500" /><el-option label="COUNT 1000" :value="1000" /></el-select>
          <div class="view-switch"><button :class="{ 'is-active': keyView === 'list' }" :aria-label="$t('列表显示')" :title="$t('列表显示')" @click="switchKeyView('list')"><List :size="15" /></button><button :class="{ 'is-active': keyView === 'tree' }" :aria-label="$t('层级显示')" :title="$t('层级显示')" @click="switchKeyView('tree')"><FolderTree :size="15" /></button></div>
          <el-button :loading="busy" @click="scanKeys(true)"><RefreshCw :size="15" />{{ $t('重新扫描') }}</el-button>
          <el-button type="primary" :disabled="readOnly" @click="createDialog = true"><Plus :size="15" />{{ $t('新建键') }}</el-button>
        </div>
        <div class="redis-scan-note">
          <span><strong>{{ retainedKeys.length }}</strong> {{ $t('已载入') }}</span>
          <span><strong>{{ keyspaceSummary.keys }}</strong> {{ $t('当前库键数') }}</span>
          <span><strong>{{ keyspaceSummary.expires }}</strong> {{ $t('设置过期') }}</span>
          <TipIcon :content="$t('SCAN 是游标遍历而非一致性快照；已返回键会在界面去重。')" placement="right" />
          <b>{{ scanComplete ? $t('遍历完成') : $t('{0} 批 · 游标 {1}', [scannedBatches, scanCursor]) }}</b>
        </div>

        <div class="redis-key-grid">
          <section class="redis-key-list">
            <template v-if="keyView === 'list'">
              <button v-for="item in retainedKeys" :key="item.key.base64" class="redis-flat-key" :class="{ 'is-active': selectedKeyBase64 === item.key.base64 }" @click="selectKey(item)"><span class="key-type" :class="`is-${item.type}`">{{ item.type.slice(0, 1).toUpperCase() }}</span><div><strong :title="binaryLabel(item.key)">{{ binaryLabel(item.key) }}</strong><small>{{ formatBytes(item.key.byteLength) }} · {{ formatTtl(item.ttlMs) }}</small></div><em>{{ item.type }}</em></button>
            </template>
            <template v-else>
              <template v-for="row in keyTreeRows" :key="row.id">
                <button v-if="row.kind === 'group'" class="redis-key-tree-group" :class="{ 'is-expanded': row.expanded }" :style="keyTreeIndent(row.depth)" :aria-expanded="row.expanded" @click="toggleKeyGroup(row.path)"><ChevronRight :size="13" /><FolderTree :size="14" /><strong>{{ row.name }}</strong><small>{{ row.count }} {{ $t('个键') }}</small></button>
                <button v-else class="redis-key-tree-key" :class="{ 'is-active': selectedKeyBase64 === row.item.key.base64 }" :style="keyTreeIndent(row.depth)" @click="selectKey(row.item)"><span class="redis-tree-branch"><CornerDownRight v-if="row.depth" :size="12" /></span><span class="key-type" :class="`is-${row.item.type}`">{{ row.item.type.slice(0, 1).toUpperCase() }}</span><div><strong :title="binaryLabel(row.item.key)">{{ row.label }}</strong><small>{{ formatBytes(row.item.key.byteLength) }} · {{ formatTtl(row.item.ttlMs) }}</small></div><em>{{ row.item.type }}</em></button>
              </template>
            </template>
            <div v-if="!retainedKeys.length" class="redis-empty"><KeyRound :size="27" /><strong>{{ scanComplete ? $t('当前范围没有键') : $t('正在读取键空间') }}</strong><span v-if="scanComplete">{{ $t('调整匹配模式或类型后重新扫描') }}</span></div>
          </section>

          <section class="redis-key-detail" v-loading="detailLoading">
            <template v-if="selectedKey">
              <header><div><span class="key-type" :class="`is-${selectedKey.type}`">{{ selectedKey.type.slice(0, 1).toUpperCase() }}</span><div><small>{{ selectedKey.type.toUpperCase() }}</small><strong :title="binaryLabel(selectedKey.key)">{{ binaryLabel(selectedKey.key) }}</strong></div></div><div class="redis-key-actions"><button type="button" :aria-label="$t('复制键名')" :title="$t('复制键名')" @click="copyText(binaryLabel(selectedKey.key), $t('键名'))"><Copy :size="14" /></button><button type="button" :aria-label="$t('刷新键值')" :title="$t('刷新键值')" @click="refreshSelected"><RefreshCw :size="14" /></button><el-dropdown trigger="click"><el-button size="small" :disabled="readOnly"><Pencil :size="14" />{{ $t('键操作') }}</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item :disabled="readOnly" @click="renameKey(false)">{{ $t('重命名') }}</el-dropdown-item><el-dropdown-item :disabled="readOnly" @click="renameKey(true)"><Copy :size="13" />{{ $t('复制') }}</el-dropdown-item><el-dropdown-item :disabled="readOnly" @click="changeTtl"><Clock3 :size="13" />{{ $t('设置 TTL') }}</el-dropdown-item><el-dropdown-item :disabled="readOnly" @click="executeMutation('PERSIST', [keyArgument()], $t('已改为永不过期'), true)">{{ $t('改为永不过期') }}</el-dropdown-item><el-dropdown-item divided :disabled="readOnly" @click="deleteSelectedKey"><Trash2 :size="13" />{{ $t('删除键') }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></header>
              <div class="redis-key-metrics"><span>TTL <strong>{{ formatTtl(selectedKey.ttlMs) }}</strong></span><span>{{ $t('键名大小') }} <strong>{{ formatBytes(selectedKey.key.byteLength) }}</strong></span><span>{{ $t('占用内存') }} <strong>{{ memoryBytes === null ? $t('无法确认') : formatBytes(memoryBytes) }}</strong></span><span>{{ $t('逻辑库') }} <strong>DB {{ databaseNumber }}</strong></span></div>
              <div class="redis-value-toolbar"><div class="redis-value-heading"><strong>{{ $t('值预览') }}</strong><span v-if="detectedValueLabel">{{ detectedValueLabel }}</span><small v-if="detailPreviewMeta">{{ detailPreviewMeta }}</small></div><div><button type="button" :aria-label="$t('复制当前值')" :title="$t('复制当前值')" @click="copyText(detailCopyText(), $t('当前值'))"><Copy :size="14" /></button><el-radio-group v-model="valueView" size="small"><el-radio-button value="utf8">UTF-8</el-radio-button><el-radio-button value="json">JSON</el-radio-button><el-radio-button value="hex">Hex</el-radio-button><el-radio-button value="base64">Base64</el-radio-button></el-radio-group></div></div>
              <pre v-if="detailRows === null" class="redis-value-preview">{{ displayReply(detailResult) || '(empty)' }}</pre>
              <div v-else class="redis-value-table" :class="`is-${selectedKey.type}`">
                <header><span>#</span><strong>{{ detailColumns[0] }}</strong><strong v-if="detailColumns[1]">{{ detailColumns[1] }}</strong></header>
                <div v-for="row in detailRows" :key="row.index"><span>{{ row.index }}</span><code>{{ row.primary }}</code><code v-if="detailColumns[1]">{{ row.secondary }}</code></div>
                <div v-if="!detailRows.length" class="redis-value-table-empty">{{ $t('当前集合没有成员') }}</div>
              </div>
              <div v-if="readOnly" class="redis-readonly-notice"><ShieldCheck :size="16" /><div><strong>{{ $t('只读连接') }}</strong><span>{{ $t('写入、删除和 TTL 修改已禁用') }}</span></div></div>
              <section v-else class="redis-mutation-card">
                <header><div class="redis-mutation-heading"><ShieldCheck :size="15" /><strong>{{ selectedKey.type === 'string' ? $t('编辑值') : $t('类型化维护') }}</strong><TipIcon :content="$t('所有操作会在可信执行端重新检查命令策略；界面不持有连接凭据。')" placement="right" /></div><el-select v-model="inputEncoding" class="redis-input-encoding" size="small"><el-option :label="$t('UTF-8 输入')" value="utf8" /><el-option :label="$t('Hex 输入')" value="hex" /><el-option :label="$t('Base64 输入')" value="base64" /></el-select></header>
                <template v-if="selectedKey.type === 'string'"><el-input v-model="mutationPrimary" type="textarea" :rows="4" :placeholder="$t('新值；保存使用 KEEPTTL，最后写入生效')" /><el-button type="primary" :loading="busy" @click="saveTypedValue">{{ $t('保存 String') }}</el-button></template>
                <template v-else-if="selectedKey.type === 'hash'"><div class="redis-mutation-fields"><el-input v-model="mutationPrimary" placeholder="field" /><el-input v-model="mutationSecondary" placeholder="value" /></div><div><el-button type="primary" :loading="busy" @click="saveTypedValue">{{ $t('HSET 保存') }}</el-button><el-button type="danger" plain :loading="busy" @click="removeTypedValue">{{ $t('HDEL 删除字段') }}</el-button></div></template>
                <template v-else-if="selectedKey.type === 'list'"><el-input v-model="mutationPrimary" :placeholder="$t('元素值')" /><div><el-button :loading="busy" @click="listEdge('LPUSH')">LPUSH</el-button><el-button type="primary" :loading="busy" @click="listEdge('RPUSH')">RPUSH</el-button><el-button :loading="busy" @click="listEdge('LPOP')">LPOP</el-button><el-button :loading="busy" @click="listEdge('RPOP')">RPOP</el-button></div></template>
                <template v-else-if="selectedKey.type === 'set'"><el-input v-model="mutationPrimary" placeholder="member" /><div><el-button type="primary" :loading="busy" @click="saveTypedValue">{{ $t('SADD 添加') }}</el-button><el-button type="danger" plain :loading="busy" @click="removeTypedValue">{{ $t('SREM 删除') }}</el-button></div></template>
                <template v-else-if="selectedKey.type === 'zset'"><div class="redis-mutation-fields"><el-input v-model="mutationPrimary" placeholder="member" /><el-input v-model="mutationScore" placeholder="score" /></div><div><el-button type="primary" :loading="busy" @click="saveTypedValue">{{ $t('ZADD 保存') }}</el-button><el-button type="danger" plain :loading="busy" @click="removeTypedValue">{{ $t('ZREM 删除') }}</el-button></div></template>
                <template v-else-if="selectedKey.type === 'stream'"><div class="redis-mutation-fields"><el-input v-model="mutationPrimary" :placeholder="$t('field；删除时填写 entry ID')" /><el-input v-model="mutationSecondary" placeholder="value" /></div><div><el-button type="primary" :loading="busy" @click="saveTypedValue">{{ $t('XADD 追加') }}</el-button><el-button type="danger" plain :loading="busy" @click="removeTypedValue">XDEL entry</el-button></div></template>
              </section>
            </template>
            <div v-else class="redis-detail-empty"><Braces :size="34" /><strong>{{ $t('选择一个 Redis 键') }}</strong><span>{{ $t('查看值、TTL、内存占用和类型化操作') }}</span></div>
          </section>
        </div>
      </section>

      <section v-else-if="activeSection === 'command'" class="redis-command-workspace">
        <div class="redis-command-head"><div class="heading-with-tip"><h2>{{ $t('受控命令') }}</h2><TipIcon :content="$t('⌘/Ctrl + Enter 或 F5 执行选中内容；多行按顺序执行，不保证原子性。')" placement="right" /></div><div><el-button :aria-label="$t('清空执行结果')" :title="$t('清空执行结果')" :disabled="!commandResults.length" @click="clearCommandResults"><X :size="15" /></el-button><el-button @click="toggleFavorite"><ShieldCheck :size="15" />{{ favorites.includes(commandText.trim()) ? $t('取消收藏') : $t('收藏') }}</el-button><el-button type="primary" :loading="commandRunning" @click="executeConsole()"><Play :size="15" />{{ $t('执行') }}</el-button></div></div>
        <div class="redis-command-quick"><span>{{ $t('快捷命令') }}</span><button v-for="item in quickCommands" :key="item" type="button" @click="executeQuickCommand(item)"><code>{{ item }}</code></button></div>
        <div class="redis-command-layout">
          <section class="redis-command-editor-panel"><RedisCommandEditor v-model="commandText" :commands="commandNames" @execute="executeConsole" /><footer><span>DB {{ databaseNumber }}</span><span v-if="readOnly"><ShieldCheck :size="12" />{{ $t('只读策略') }}</span><TipIcon :content="$t('未知、管理、脚本、阻塞和无界命令默认拒绝。')" placement="left" /></footer></section>
          <aside class="redis-command-side"><section><h3>{{ $t('收藏') }}</h3><button v-for="item in favorites" :key="item" @click="commandText = item"><TerminalSquare :size="13" /><code>{{ item }}</code></button><small v-if="!favorites.length">{{ $t('收藏常用的受控命令。') }}</small></section><section><h3>{{ $t('最近执行') }}</h3><button v-for="item in commandResults.slice(0, 12)" :key="item.id" @click="commandText = item.command"><CircleCheck v-if="item.status === 'success'" :size="13" /><CircleX v-else :size="13" /><code>{{ item.command }}</code></button></section></aside>
        </div>
        <div class="redis-command-results"><article v-for="item in commandResults" :key="item.id" :class="`is-${item.status}`"><header><span><CircleCheck v-if="item.status === 'success'" :size="15" /><CircleX v-else :size="15" /><code>{{ item.command }}</code></span><small>{{ item.durationMs }} ms · {{ item.byteLength }} B · {{ new Date(item.createdAt).toLocaleTimeString($locale()) }}</small></header><pre>{{ item.status === 'success' ? displayReply(item.result) : item.error }}</pre></article><div v-if="!commandResults.length" class="redis-empty"><TerminalSquare :size="28" /><strong>{{ $t('尚未执行命令') }}</strong></div></div>
      </section>

      <section v-else class="redis-diagnostics" v-loading="diagnosticsLoading">
        <header><div class="heading-with-tip"><h2>{{ $t('运行诊断') }}</h2><TipIcon :content="$t('数据来自当前连接和当前节点的一次采样，不代表 Cluster 全局或持续实时状态。')" placement="right" /></div><el-button @click="loadDiagnostics"><RefreshCw :size="15" />{{ $t('重新采样') }}</el-button></header>
        <div class="redis-metric-grid"><article><span>{{ $t('版本') }}</span><strong>{{ serverSummary.version }}</strong><small>{{ serverSummary.mode }}</small></article><article><span>{{ $t('运行时间') }}</span><strong>{{ serverSummary.uptime }}</strong><small>{{ $t('当前节点') }}</small></article><article><span>{{ $t('内存') }}</span><strong>{{ serverSummary.memory }}</strong><small>used_memory_human</small></article><article><span>{{ $t('客户端') }}</span><strong>{{ serverSummary.clients }}</strong><small>connected_clients</small></article><article><span>DB {{ databaseNumber }}</span><strong>{{ keyspaceSummary.keys }}</strong><small>{{ keyspaceSummary.expires }} {{ $t('个设置过期') }}</small></article></div>
        <div class="redis-diagnostic-grid"><section><header><Info :size="16" /><strong>INFO</strong></header><div class="redis-info-sections"><details v-for="(values, section) in info" :key="section" :open="['server','memory','clients','stats','keyspace'].includes(String(section))"><summary>{{ section }}<small>{{ Object.keys(values).length }}</small></summary><dl><div v-for="(value, key) in values" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></div></dl></details></div></section><section><header><Clock3 :size="16" /><strong>{{ $t('Slow Log · 最近 32 条') }}</strong><TipIcon :content="$t('SLOWLOG 是 Redis 服务端执行耗时，不是端到端延迟；此处只使用受控只读命令。')" placement="left" /></header><pre>{{ displayReply(slowLog) || $t('当前没有 Slow Log，或账号无读取权限。') }}</pre></section></div>
      </section>
    </main>

    <div v-else class="redis-no-connection"><span class="redis-empty-mark"><MemoryStick :size="30" /></span><h2>{{ $t('还没有 Redis 连接') }}</h2><el-button type="primary" @click="openConnectionCreate"><Plus :size="15" />{{ $t('新建 Redis 连接') }}</el-button></div>

    <el-dialog v-model="createDialog" align-center width="580px" class="envman-dialog compact-dialog" append-to-body>
      <template #header><div class="dialog-title"><span class="dialog-title__icon"><Plus :size="18" /></span><div><h3>{{ $t('新建键') }}</h3></div></div></template>
      <el-form label-position="top" class="polished-dialog-form"><el-form-item :label="$t('数据类型')"><el-radio-group v-model="createType"><el-radio-button v-for="item in ['string','hash','list','set','zset','stream']" :key="item" :value="item">{{ item }}</el-radio-button></el-radio-group></el-form-item><el-form-item :label="$t('键名')" required><el-input v-model="createKey" :placeholder="$t('例如 cache:user:1001')" /></el-form-item><el-form-item :label="createType === 'hash' || createType === 'stream' ? 'field' : createType === 'zset' ? 'member' : $t('初始值 / member')"><el-input v-model="createPrimary" /></el-form-item><el-form-item v-if="createType === 'hash' || createType === 'stream'" label="value"><el-input v-model="createSecondary" /></el-form-item><el-form-item v-if="createType === 'zset'" label="score"><el-input v-model="createScore" /></el-form-item></el-form>
      <template #footer><el-button @click="createDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="busy" @click="createRedisKey">{{ $t('创建键') }}</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.redis-workbench {
  --redis-accent: #b4473e;
  --redis-accent-soft: color-mix(in srgb, var(--redis-accent) 11%, var(--surface));
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-height: 620px;
  overflow: hidden;
  border: 1px solid var(--ink-200);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.redis-connections { min-width: 0; padding: 13px 10px 10px; border-right: 1px solid var(--ink-200); background: color-mix(in srgb, var(--paper) 76%, var(--surface)); display: flex; flex-direction: column; }
.redis-pane-heading { min-height: 38px; margin: 0 2px 11px; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 9px; }
.redis-pane-heading > div:nth-child(2), .redis-endpoint > div { min-width: 0; display: flex; flex-direction: column; }
.redis-pane-heading strong { font-size: 13px; }
.redis-pane-heading small, .redis-endpoint small { color: var(--ink-500); font-size: 10px; }
.redis-brand-mark { width: 32px; height: 32px; border-radius: 7px; background: var(--redis-accent); color: #fff; display: grid; place-items: center; box-shadow: 0 6px 14px color-mix(in srgb, var(--redis-accent) 20%, transparent); }
.redis-pane-actions, .redis-key-actions, .redis-value-toolbar > div { display: flex; align-items: center; gap: 4px; }
.redis-pane-actions button, .redis-key-actions > button, .redis-value-toolbar button, .redis-workspace-error button { width: 28px; height: 28px; padding: 0; border: 1px solid var(--ink-100); border-radius: 6px; background: var(--surface); color: var(--ink-500); display: grid; place-items: center; cursor: pointer; transition: border-color .15s ease, background .15s ease, color .15s ease, transform .15s ease; }
.redis-pane-actions button:hover, .redis-key-actions > button:hover, .redis-value-toolbar button:hover { border-color: var(--teal-300); background: var(--teal-50); color: var(--teal-700); }
.redis-pane-actions button:active, .redis-key-actions > button:active, .redis-value-toolbar button:active { transform: translateY(1px); }
.redis-connection-list { flex: 1; min-height: 0; margin-top: 10px; overflow: auto; scrollbar-width: thin; }
.redis-connection-list section + section { margin-top: 12px; }
.redis-connection-list h4 { min-width: 0; margin: 0 4px 4px; color: var(--ink-500); display: flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; }
.redis-connection-list h4 span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.redis-connection-list h4 small { margin-left: auto; font-family: var(--font-mono); font-size: 9px; }
.redis-connection-list section > button { width: 100%; min-height: 46px; padding: 6px 7px; border: 0; border-radius: 7px; background: transparent; color: var(--ink-600); display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 8px; text-align: left; cursor: pointer; transition: background .15s ease, color .15s ease, box-shadow .15s ease; }
.redis-connection-list section > button:hover { background: var(--ink-50); color: var(--ink-800); }
.redis-connection-list section > button.is-active { background: var(--teal-50); color: var(--teal-700); box-shadow: inset 2px 0 var(--teal-500); }
.redis-connection-icon { width: 28px; height: 28px; border: 1px solid var(--ink-200); border-radius: 6px; background: var(--surface); display: grid; place-items: center; }
.redis-connection-list button > div { min-width: 0; display: flex; flex-direction: column; }
.redis-connection-list button strong, .redis-connection-list button small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.redis-connection-list button strong { font-size: 11px; }
.redis-connection-list button small { color: var(--ink-500); font-family: var(--font-mono); font-size: 9px; }
.redis-connection-list button em { padding: 2px 5px; border-radius: 4px; background: var(--amber-100); color: var(--amber-600); font-size: 9px; font-style: normal; }
.redis-main { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.redis-topbar { min-height: 62px; padding: 9px 14px; border-bottom: 1px solid var(--ink-200); display: grid; grid-template-columns: minmax(220px, 1fr) auto minmax(290px, 1fr); align-items: center; gap: 14px; }
.redis-endpoint { min-width: 0; display: flex; align-items: center; gap: 9px; }
.redis-endpoint strong, .redis-endpoint small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.redis-endpoint strong { font-size: 12px; }
.redis-readonly-badge { flex: 0 0 auto; padding: 3px 6px; border-radius: 4px; background: var(--amber-100); color: var(--amber-600); display: flex; align-items: center; gap: 4px; font-size: 9px; font-style: normal; font-weight: 800; }
.redis-topbar nav { padding: 3px; border-radius: 7px; background: var(--ink-50); display: flex; gap: 2px; }
.redis-topbar nav button, .view-switch button { min-height: 29px; padding: 0 9px; border: 0; border-radius: 5px; background: transparent; color: var(--ink-600); display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; font-weight: 700; transition: background .15s ease, color .15s ease, box-shadow .15s ease; }
.redis-topbar nav button:hover, .view-switch button:hover { color: var(--ink-800); }
.redis-topbar nav button.is-active, .view-switch button.is-active { background: var(--surface); color: var(--teal-700); box-shadow: 0 1px 4px color-mix(in srgb, var(--ink-900) 10%, transparent); }
.redis-topbar-actions { min-width: 0; display: flex; justify-content: flex-end; align-items: center; gap: 7px; }
.redis-database-select { width: 178px; }
.redis-database-select :deep(.el-select__wrapper) { min-height: 31px; font-family: var(--font-mono); }
.redis-database-select :deep(.el-select__prefix) { color: var(--teal-700); }
.redis-database-option { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.redis-database-option small { color: var(--ink-500); font-family: var(--font-mono); font-size: 10px; }
.redis-test-state, .redis-workspace-error { min-height: 32px; padding: 6px 14px; display: flex; align-items: center; gap: 8px; font-size: 11px; }
.redis-test-state small { margin-left: auto; font-family: var(--font-mono); }
.redis-test-state.is-success { background: var(--teal-50); color: var(--teal-700); }
.redis-test-state.is-error, .redis-workspace-error { background: var(--red-100); color: var(--red-600); }
.redis-workspace-error span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.redis-workspace-error button { width: auto; height: 23px; padding: 0 6px; border-color: color-mix(in srgb, var(--red-600) 22%, transparent); background: transparent; color: inherit; display: flex; gap: 4px; }
.redis-workspace-error button:last-child { width: 23px; padding: 0; }
.redis-keyspace { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.redis-scan-toolbar { padding: 10px 12px; border-bottom: 1px solid var(--ink-100); display: grid; grid-template-columns: minmax(180px, 1fr) 116px 118px auto auto auto; gap: 7px; }
.view-switch { padding: 3px; border-radius: 7px; background: var(--ink-50); display: flex; gap: 2px; }
.view-switch button { width: 29px; padding: 0; justify-content: center; }
.redis-scan-note { min-height: 31px; padding: 5px 13px; border-bottom: 1px solid var(--ink-100); background: color-mix(in srgb, var(--ink-50) 70%, var(--surface)); color: var(--ink-500); display: flex; align-items: center; gap: 15px; font-size: 10px; }
.redis-scan-note span { display: flex; align-items: baseline; gap: 4px; }
.redis-scan-note strong { color: var(--ink-800); font-family: var(--font-mono); font-size: 11px; }
.redis-scan-note b { margin-left: auto; color: var(--ink-600); font-family: var(--font-mono); font-size: 9px; font-weight: 600; }
.redis-key-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 32%) minmax(0, 1fr); }
.redis-key-list { min-height: 0; overflow: auto; border-right: 1px solid var(--ink-200); scrollbar-width: thin; }
.redis-flat-key, .redis-key-tree-key { width: 100%; min-height: 48px; padding: 7px 11px; border: 0; border-bottom: 1px solid var(--ink-100); background: transparent; display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 9px; text-align: left; cursor: pointer; transition: background .15s ease, box-shadow .15s ease; }
.redis-flat-key:hover, .redis-key-tree-key:hover { background: var(--ink-50); }
.redis-flat-key.is-active, .redis-key-tree-key.is-active { background: var(--teal-50); box-shadow: inset 3px 0 var(--teal-500); }
.redis-key-tree-group { width: 100%; min-height: 34px; padding: 5px 10px 5px var(--redis-tree-indent); border: 0; border-bottom: 1px solid var(--ink-100); background: color-mix(in srgb, var(--ink-50) 54%, var(--surface)); color: var(--ink-600); display: grid; grid-template-columns: 14px 16px minmax(0, 1fr) auto; align-items: center; gap: 6px; text-align: left; cursor: pointer; }
.redis-key-tree-group:hover { background: var(--ink-50); color: var(--ink-800); }
.redis-key-tree-group > svg:first-child { transition: transform .15s var(--ease-out); }
.redis-key-tree-group.is-expanded > svg:first-child { transform: rotate(90deg); }
.redis-key-tree-group strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.redis-key-tree-group small { color: var(--ink-500); font-family: var(--font-mono); font-size: 9px; }
.redis-key-tree-key { padding-left: var(--redis-tree-indent); grid-template-columns: 14px 28px minmax(0, 1fr) auto; }
.redis-tree-branch { color: var(--ink-400); display: grid; place-items: center; }
.key-type { width: 28px; height: 28px; border-radius: 6px; background: #65757a; color: #fff; display: grid; place-items: center; font-family: var(--font-mono); font-size: 10px; font-weight: 800; }
.key-type.is-string { background: #197f70; }
.key-type.is-hash { background: #7556a8; }
.key-type.is-list { background: #3377a5; }
.key-type.is-set { background: #a96518; }
.key-type.is-zset { background: #ad4a57; }
.key-type.is-stream { background: #4d687e; }
.redis-flat-key > div, .redis-key-tree-key > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.redis-flat-key strong, .redis-key-tree-key strong { overflow: hidden; color: var(--ink-800); font-family: var(--font-mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.redis-flat-key small, .redis-flat-key em, .redis-key-tree-key small, .redis-key-tree-key em { color: var(--ink-500); font-size: 9px; font-style: normal; }
.redis-key-detail { min-width: 0; min-height: 0; padding: 14px; overflow: auto; scrollbar-width: thin; }
.redis-key-detail > header { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.redis-key-detail > header > div:first-child { min-width: 0; display: flex; align-items: center; gap: 9px; }
.redis-key-detail > header > div:first-child > div { min-width: 0; display: flex; flex-direction: column; }
.redis-key-detail > header small { color: var(--ink-500); font-size: 9px; }
.redis-key-detail > header strong { overflow: hidden; font-family: var(--font-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.redis-key-metrics { margin: 12px 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.redis-key-metrics span { min-width: 0; padding: 8px 9px; border: 1px solid var(--ink-100); border-radius: 6px; color: var(--ink-500); display: flex; flex-direction: column; gap: 3px; font-size: 9px; }
.redis-key-metrics strong { overflow: hidden; color: var(--ink-800); font-family: var(--font-mono); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.redis-value-toolbar { min-height: 31px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.redis-value-toolbar strong { font-size: 11px; }
.redis-value-toolbar button { flex: 0 0 auto; }
.redis-value-heading { min-width: 0; display: flex; align-items: center; gap: 7px; }
.redis-value-heading span { padding: 2px 6px; border-radius: 4px; background: var(--teal-50); color: var(--teal-700); font-size: 9px; font-weight: 700; }
.redis-value-heading small { color: var(--ink-500); font-family: var(--font-mono); font-size: 9px; }
.redis-value-preview, .redis-command-results pre, .redis-diagnostic-grid pre { min-height: 145px; max-height: 300px; margin: 0; padding: 12px; overflow: auto; border: 1px solid #24373a; border-radius: 7px; background: #101b1e; color: #d7e7e2; font-family: var(--font-console); font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.redis-value-table { max-height: 300px; overflow: auto; border: 1px solid var(--ink-200); border-radius: 7px; background: var(--surface); font-family: var(--font-console); font-size: 10px; }
.redis-value-table > header, .redis-value-table > div:not(.redis-value-table-empty) { min-width: 440px; display: grid; grid-template-columns: 42px minmax(180px, 1fr) minmax(180px, 1fr); align-items: start; }
.redis-value-table.is-list > header, .redis-value-table.is-list > div:not(.redis-value-table-empty), .redis-value-table.is-set > header, .redis-value-table.is-set > div:not(.redis-value-table-empty) { grid-template-columns: 42px minmax(300px, 1fr); }
.redis-value-table > header { position: sticky; top: 0; z-index: 1; min-height: 32px; border-bottom: 1px solid var(--ink-200); background: var(--ink-50); color: var(--ink-500); }
.redis-value-table > header > *, .redis-value-table > div:not(.redis-value-table-empty) > * { min-width: 0; padding: 8px 10px; }
.redis-value-table > header > * + *, .redis-value-table > div:not(.redis-value-table-empty) > * + * { border-left: 1px solid var(--ink-100); }
.redis-value-table > div:not(.redis-value-table-empty) + div:not(.redis-value-table-empty) { border-top: 1px solid var(--ink-100); }
.redis-value-table > div:not(.redis-value-table-empty) > span { color: var(--ink-500); text-align: right; user-select: none; }
.redis-value-table code { color: var(--ink-800); font: inherit; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.redis-value-table-empty { min-height: 112px; color: var(--ink-500); display: grid; place-items: center; }
.redis-readonly-notice { min-height: 50px; margin-top: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--amber-600) 20%, var(--ink-100)); border-radius: 7px; background: var(--amber-100); color: var(--amber-600); display: flex; align-items: center; gap: 9px; }
.redis-readonly-notice div { display: flex; flex-direction: column; gap: 2px; }
.redis-readonly-notice strong { font-size: 11px; }
.redis-readonly-notice span { font-size: 10px; }
.redis-mutation-card { margin-top: 12px; padding: 11px; border: 1px solid var(--ink-200); border-radius: 7px; background: var(--paper); display: flex; flex-direction: column; gap: 9px; }
.redis-mutation-card > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.redis-mutation-heading { display: flex; align-items: center; gap: 7px; }
.redis-input-encoding { width: 126px; flex: 0 0 auto; }
.redis-mutation-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.redis-detail-empty, .redis-empty, .redis-no-connection, .redis-empty-mini { color: var(--ink-500); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; text-align: center; }
.redis-detail-empty { height: 100%; min-height: 280px; }
.redis-detail-empty strong, .redis-empty strong, .redis-empty-mini strong { color: var(--ink-800); font-size: 12px; }
.redis-detail-empty span, .redis-empty span { max-width: 340px; font-size: 10px; }
.redis-empty { min-height: 210px; }
.redis-empty-mini { flex: 1; min-height: 160px; padding: 24px 8px; }
.redis-no-connection { grid-column: 2; }
.redis-no-connection h2 { margin: 2px 0 5px; font-size: 18px; }
.redis-empty-mark { width: 58px; height: 58px; border: 1px solid color-mix(in srgb, var(--redis-accent) 25%, var(--ink-100)); border-radius: 8px; background: var(--redis-accent-soft); color: var(--redis-accent); display: grid; place-items: center; }
.redis-command-workspace, .redis-diagnostics { flex: 1; min-height: 0; padding: 17px; overflow: auto; scrollbar-width: thin; }
.redis-command-head, .redis-diagnostics > header { min-height: 34px; margin-bottom: 11px; display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.redis-command-head > div:last-child { display: flex; gap: 7px; }
.redis-command-head h2, .redis-diagnostics h2 { margin: 0; font-size: 17px; }
.redis-command-quick { min-height: 34px; margin-bottom: 9px; display: flex; align-items: center; gap: 5px; overflow-x: auto; }
.redis-command-quick > span { flex: 0 0 auto; margin-right: 3px; color: var(--ink-500); font-size: 10px; }
.redis-command-quick button { flex: 0 0 auto; min-height: 25px; padding: 0 8px; border: 1px solid var(--ink-100); border-radius: 5px; background: var(--surface); color: var(--ink-600); cursor: pointer; }
.redis-command-quick button:hover { border-color: var(--teal-300); background: var(--teal-50); color: var(--teal-700); }
.redis-command-quick code { font-size: 9px; }
.redis-command-layout { display: grid; grid-template-columns: minmax(0, 1fr) 226px; gap: 10px; }
.redis-command-editor-panel { overflow: hidden; border: 1px solid var(--ink-200); border-radius: 7px; background: #101b1e; }
.redis-command-editor-panel :deep(.redis-command-editor) { height: 236px; }
.redis-command-editor-panel footer { min-height: 28px; padding: 5px 10px; border-top: 1px solid #24373a; color: #7f9994; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 9px; }
.redis-command-editor-panel footer > span { display: flex; align-items: center; gap: 4px; }
.redis-command-side { display: grid; grid-template-rows: 1fr 1fr; gap: 8px; }
.redis-command-side section { min-height: 0; padding: 9px; overflow: auto; border: 1px solid var(--ink-200); border-radius: 7px; }
.redis-command-side h3 { margin: 0 0 5px; font-size: 10px; }
.redis-command-side button { width: 100%; min-height: 27px; padding: 4px 5px; border: 0; border-radius: 5px; background: transparent; display: flex; align-items: center; gap: 6px; text-align: left; cursor: pointer; }
.redis-command-side button:hover { background: var(--ink-50); }
.redis-command-side code { overflow: hidden; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.redis-command-side small { color: var(--ink-500); font-size: 9px; }
.redis-command-results { margin-top: 10px; display: grid; gap: 8px; }
.redis-command-results article { overflow: hidden; border: 1px solid var(--ink-200); border-radius: 7px; }
.redis-command-results article > header { min-height: 34px; padding: 6px 9px; background: var(--ink-50); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.redis-command-results article > header span { min-width: 0; display: flex; align-items: center; gap: 6px; }
.redis-command-results article > header code { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.redis-command-results article > header small { color: var(--ink-500); font-family: var(--font-mono); font-size: 9px; }
.redis-command-results article.is-success > header svg { color: var(--teal-600); }
.redis-command-results article.is-error > header svg { color: var(--red-600); }
.redis-command-results pre { min-height: 55px; max-height: 250px; border: 0; border-radius: 0; }
.redis-metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.redis-metric-grid article { min-width: 0; padding: 11px; border: 1px solid var(--ink-200); border-radius: 7px; background: var(--surface); display: flex; flex-direction: column; gap: 3px; }
.redis-metric-grid span { color: var(--ink-500); font-size: 9px; }
.redis-metric-grid strong { overflow: hidden; font-family: var(--font-display); font-size: 17px; text-overflow: ellipsis; white-space: nowrap; }
.redis-metric-grid small { color: var(--ink-500); font-size: 9px; }
.redis-diagnostic-grid { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.redis-diagnostic-grid > section { min-width: 0; overflow: hidden; border: 1px solid var(--ink-200); border-radius: 7px; }
.redis-diagnostic-grid > section > header { min-height: 36px; padding: 8px 10px; border-bottom: 1px solid var(--ink-100); display: flex; align-items: center; gap: 7px; }
.redis-info-sections { max-height: 490px; padding: 6px 10px; overflow: auto; }
.redis-info-sections details { border-bottom: 1px solid var(--ink-100); }
.redis-info-sections summary { padding: 7px 0; font-family: var(--font-mono); font-size: 10px; cursor: pointer; }
.redis-info-sections summary small { float: right; color: var(--ink-500); }
.redis-info-sections dl { margin: 0 0 7px; }
.redis-info-sections dl div { padding: 3px 0; display: grid; grid-template-columns: minmax(130px, .8fr) 1fr; gap: 9px; font-size: 9px; }
.redis-info-sections dt { overflow: hidden; color: var(--ink-500); text-overflow: ellipsis; }
.redis-info-sections dd { margin: 0; overflow-wrap: anywhere; font-family: var(--font-mono); }
.redis-diagnostic-grid pre { max-height: 430px; margin: 0 10px 10px; }
@media (max-width: 1180px) {
  .redis-workbench { grid-template-columns: 200px minmax(0, 1fr); }
  .redis-topbar { grid-template-columns: minmax(200px, 1fr) auto; }
  .redis-topbar nav { grid-column: 1 / -1; grid-row: 2; justify-self: center; }
  .redis-scan-toolbar { grid-template-columns: minmax(180px, 1fr) 110px 110px auto; }
  .redis-scan-toolbar > .el-button { grid-row: 2; }
  .redis-metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .redis-command-layout, .redis-diagnostic-grid { grid-template-columns: 1fr; }
  .redis-command-side { grid-template-columns: 1fr 1fr; grid-template-rows: 150px; }
}
@media (max-width: 760px) {
  .redis-workbench { min-height: 760px; grid-template-columns: 1fr; grid-template-rows: 154px minmax(0, 1fr); }
  .redis-connections { padding: 10px; border-right: 0; border-bottom: 1px solid var(--ink-200); }
  .redis-connection-list { display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; }
  .redis-connection-list section { flex: 0 0 210px; }
  .redis-connection-list section + section { margin-top: 0; }
  .redis-connection-list section > button { min-width: 200px; }
  .redis-empty-mini { min-width: 210px; min-height: 70px; }
  .redis-topbar { grid-template-columns: 1fr; }
  .redis-topbar nav { grid-column: auto; grid-row: auto; justify-self: stretch; overflow-x: auto; }
  .redis-topbar nav button { flex: 1 0 auto; justify-content: center; }
  .redis-topbar-actions { justify-content: flex-start; }
  .redis-database-select { width: min(190px, 100%); }
  .redis-scan-toolbar { grid-template-columns: 1fr 1fr; }
  .redis-scan-toolbar > .el-input { grid-column: 1 / -1; }
  .redis-scan-note { overflow-x: auto; }
  .redis-scan-note span { flex: 0 0 auto; }
  .redis-key-grid { grid-template-columns: 1fr; grid-template-rows: minmax(220px, 36%) minmax(0, 1fr); }
  .redis-key-list { border-right: 0; border-bottom: 1px solid var(--ink-200); }
  .redis-key-metrics { grid-template-columns: 1fr 1fr; }
  .redis-mutation-fields { grid-template-columns: 1fr; }
  .redis-command-side { grid-template-columns: 1fr; grid-template-rows: 140px 140px; }
  .redis-metric-grid { grid-template-columns: 1fr 1fr; }
  .redis-no-connection { grid-column: 1; grid-row: 2; }
}
</style>
