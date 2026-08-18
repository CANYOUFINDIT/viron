<script setup lang="ts">import { localizeMessage, translate as tr } from "../i18n";

import {
  ChevronDown,
  CircleStop,
  Download,
  Ellipsis,
  Eraser,
  FileText,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Server,
  Trash2,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api";
import { rememberActiveConnectionOrigin } from "../active-connection-origin";
import {
  closeDesktopLogStream,
  onDesktopLogStreamEvent,
  openDesktopLogStream,
  saveTextFile,
  type DesktopLogStreamEvent,
} from "../desktop";
import {
  countLogLines,
  filterLogOutput,
  MAX_LOG_CONTEXT_LINES,
  MAX_LOG_DISPLAY_LINES,
  normalizeLogInteger,
  tailLogLines,
} from "../log-filter";
import { renderHighlightedLogHtml } from "../log-highlighting";
import { shouldHandleLogPauseShortcut, shouldHandleLogReconnectShortcut } from "../log-shortcut";
import { ServiceSocket } from "../service-socket";
import DesktopExecutionNotice from "./DesktopExecutionNotice.vue";
import TipIcon from "./TipIcon.vue";
import WorkbenchConnectionActions from "./WorkbenchConnectionActions.vue";

interface EnvironmentLog {
  id: string;
  environmentId: string;
  sshConnectionId: string;
  name: string;
  filePath: string;
  filePaths: string[];
  connectionName: string;
  host: string;
  port: number;
  username: string;
  connectionAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SshConnection {
  id: string;
  type: "ssh";
  name: string;
  host: string;
  port: number;
  username: string;
  environmentId: string | null;
  sourceDeleted: boolean;
}

interface LogStream {
  id: string;
  logId: string;
  logName: string;
  filePath: string;
  filePaths: string[];
  initialLines: number;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
}

type ViewerStatus = "idle" | "connecting" | "streaming" | "stopped" | "error";

interface LogViewerState {
  output: string;
  status: ViewerStatus;
  message: string;
  streamId: string;
  lineLimit: number;
  filterKeyword: string;
  filterCaseSensitive: boolean;
  filterContextMode: FilterContextMode;
  filterContextLines: number;
  requestVersion: number;
}

type FilterContextMode = "before" | "after" | "both";

const props = withDefaults(defineProps<{ environmentId: string; executionEnabled?: boolean; localExecution?: boolean; focusLogId?: string; focusRequest?: number; active?: boolean }>(), {
  executionEnabled: true,
  localExecution: false,
  focusLogId: "",
  focusRequest: 0,
  active: true,
});
const emit = defineEmits<{ countChange: [count: number] }>();

const loading = ref(true);
const saving = ref(false);
const logs = ref<EnvironmentLog[]>([]);
const sshConnections = ref<SshConnection[]>([]);
const selectedLogId = ref("");
const catalogVisible = ref(true);
const dialogVisible = ref(false);
const editingLogId = ref("");
const autoScroll = ref(true);
const highlightImportant = ref(true);
const catalogWidth = ref(220);
const panelElement = ref<HTMLElement | null>(null);
const outputElement = ref<HTMLElement | null>(null);
const viewers = reactive<Record<string, LogViewerState>>({});
const sockets = new Map<string, ServiceSocket>();
const DEFAULT_LOG_LINE_LIMIT = 200;
const filterContextModeOptions: Array<{ value: FilterContextMode; label: string }> = [
  { value: "before", label: tr("上文") },
  { value: "after", label: tr("下文") },
  { value: "both", label: tr("上下文") },
];
const logConnectionActions = [
  { key: "edit", label: tr("编辑日志配置"), icon: Pencil },
  { key: "delete", label: tr("删除日志配置"), icon: Trash2, divided: true, danger: true },
];
let catalogResizeMove: ((event: PointerEvent) => void) | null = null;
let catalogResizeFinish: (() => void) | null = null;
let stopDesktopLogEvents: (() => void) | null = null;

const form = reactive({ name: "", sshConnectionId: "", filePaths: [""] as string[] });
const selectedLog = computed(() => logs.value.find((item) => item.id === selectedLogId.value) ?? null);
const totalFileCount = computed(() => logs.value.reduce((total, log) => total + log.filePaths.length, 0));
const emptyViewer: LogViewerState = {
  output: "",
  status: "idle",
  message: tr("选择日志配置并双击开始查看"),
  streamId: "",
  lineLimit: DEFAULT_LOG_LINE_LIMIT,
  filterKeyword: "",
  filterCaseSensitive: false,
  filterContextMode: "both",
  filterContextLines: 0,
  requestVersion: 0,
};
const selectedViewer = computed(() => viewers[selectedLogId.value] ?? emptyViewer);
const panelStyle = computed(() => ({ "--log-catalog-width": `${catalogWidth.value}px` }));
const output = computed(() => selectedViewer.value.output);
const viewerStatus = computed(() => selectedViewer.value.status);
const viewerMessage = computed(() => selectedViewer.value.message);
const lineLimit = computed({
  get: () => selectedViewer.value.lineLimit,
  set: (value: number) => {
    if (selectedLogId.value) ensureViewer(selectedLogId.value).lineLimit = value;
  },
});
const filterKeyword = computed({
  get: () => selectedViewer.value.filterKeyword,
  set: (value: string) => {
    if (selectedLogId.value) ensureViewer(selectedLogId.value).filterKeyword = value;
  },
});
const filterCaseSensitive = computed({
  get: () => selectedViewer.value.filterCaseSensitive,
  set: (value: boolean) => {
    if (selectedLogId.value) ensureViewer(selectedLogId.value).filterCaseSensitive = value;
  },
});
const filterContextMode = computed({
  get: () => selectedViewer.value.filterContextMode,
  set: (value: FilterContextMode) => {
    if (selectedLogId.value) ensureViewer(selectedLogId.value).filterContextMode = value;
  },
});
const filterContextLines = computed({
  get: () => selectedViewer.value.filterContextLines,
  set: (value: number) => {
    if (selectedLogId.value) ensureViewer(selectedLogId.value).filterContextLines = value;
  },
});
const rawLineCount = computed(() => countLogLines(output.value));
const limitedOutput = computed(() => tailLogLines(output.value, lineLimit.value));
const normalizedFilterKeyword = computed(() => filterKeyword.value.trim());
const filterBeforeLines = computed(() => (filterContextMode.value === "after" ? 0 : filterContextLines.value));
const filterAfterLines = computed(() => (filterContextMode.value === "before" ? 0 : filterContextLines.value));
const filteredLog = computed(() => filterLogOutput(limitedOutput.value, {
  keyword: normalizedFilterKeyword.value,
  caseSensitive: filterCaseSensitive.value,
  before: filterBeforeLines.value,
  after: filterAfterLines.value,
}));
const displayOutput = computed(() => filteredLog.value.output);
const logFilterActions = computed(() => [
  { key: "download", label: tr("下载日志"), icon: Download, disabled: !displayOutput.value },
]);
const lineCount = computed(() => countLogLines(displayOutput.value));
const highlightedOutput = computed(() => (highlightImportant.value || normalizedFilterKeyword.value) && displayOutput.value
  ? renderHighlightedLogHtml(displayOutput.value, {
    semantic: highlightImportant.value,
    keyword: normalizedFilterKeyword.value,
    keywordCaseSensitive: filterCaseSensitive.value,
  })
  : "");
const outputEmptyMessage = computed(() => output.value && normalizedFilterKeyword.value ? tr("没有匹配关键字的日志") : viewerMessage.value);
const statusLabel = computed(() => ({
  idle: tr("未连接"),
  connecting: tr("连接中"),
  streaming: tr("实时跟踪"),
  stopped: tr("已停止"),
  error: tr("连接异常"),
})[viewerStatus.value]);
const streamActive = computed(() => viewerStatus.value === "connecting" || viewerStatus.value === "streaming");
const activeStreamCount = computed(() => Object.values(viewers).filter((viewer) => viewer.status === "connecting" || viewer.status === "streaming").length);

watch(() => [props.focusLogId, props.focusRequest] as const, ([logId]) => {
  if (logId && logs.value.some((log) => log.id === logId)) selectedLogId.value = logId;
});

function createViewerState(): LogViewerState {
  return {
    output: "",
    status: "idle",
    message: tr("双击配置开始查看"),
    streamId: "",
    lineLimit: DEFAULT_LOG_LINE_LIMIT,
    filterKeyword: "",
    filterCaseSensitive: false,
    filterContextMode: "both",
    filterContextLines: 0,
    requestVersion: 0,
  };
}

function ensureViewer(logId: string): LogViewerState {
  if (!viewers[logId]) viewers[logId] = createViewerState();
  return viewers[logId]!;
}

function logStreamActive(logId: string): boolean {
  const status = viewers[logId]?.status;
  return status === "connecting" || status === "streaming";
}

async function loadData() {
  loading.value = true;
  try {
    const [logResponse, connectionResponse] = await Promise.all([
      api<{ items: EnvironmentLog[] }>(`/api/v1/environments/${props.environmentId}/logs`),
      api<{ items: SshConnection[] }>(`/api/v1/connections?type=ssh&environmentId=${encodeURIComponent(props.environmentId)}`),
    ]);
    logs.value = logResponse.items;
    sshConnections.value = connectionResponse.items.filter((item) => !item.sourceDeleted);
    const availableLogIds = new Set(logs.value.map((log) => log.id));
    for (const logId of Object.keys(viewers)) {
      if (availableLogIds.has(logId)) continue;
      if (logStreamActive(logId) || viewers[logId]?.streamId) await stopStream(logId);
      delete viewers[logId];
    }
    for (const log of logs.value) ensureViewer(log.id);
    if (props.focusLogId && availableLogIds.has(props.focusLogId)) selectedLogId.value = props.focusLogId;
    else if (!availableLogIds.has(selectedLogId.value)) selectedLogId.value = logs.value[0]?.id ?? "";
    emit("countChange", logs.value.length);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载日志配置失败"));
  } finally {
    loading.value = false;
  }
}

async function selectLog(id: string) {
  selectedLogId.value = id;
  if (autoScroll.value) await scrollToBottom();
}

function openCreate() {
  editingLogId.value = "";
  Object.assign(form, { name: "", sshConnectionId: sshConnections.value[0]?.id ?? "", filePaths: [""] });
  dialogVisible.value = true;
}

function openEdit(log: EnvironmentLog) {
  editingLogId.value = log.id;
  Object.assign(form, { name: log.name, sshConnectionId: log.sshConnectionId, filePaths: [...log.filePaths] });
  dialogVisible.value = true;
}

function addFilePath() {
  if (form.filePaths.length < 10) form.filePaths.push("");
}

function removeFilePath(index: number) {
  if (form.filePaths.length === 1) form.filePaths[0] = "";
  else form.filePaths.splice(index, 1);
}

function normalizeLineLimit(logId = selectedLogId.value) {
  if (!logId) return;
  const viewer = ensureViewer(logId);
  viewer.lineLimit = normalizeLogInteger(viewer.lineLimit, 1, MAX_LOG_DISPLAY_LINES, DEFAULT_LOG_LINE_LIMIT);
}

function normalizeFilterContext(logId = selectedLogId.value) {
  if (!logId) return;
  const viewer = ensureViewer(logId);
  if (!filterContextModeOptions.some((option) => option.value === viewer.filterContextMode)) viewer.filterContextMode = "both";
  viewer.filterContextLines = normalizeLogInteger(viewer.filterContextLines, 0, MAX_LOG_CONTEXT_LINES, 0);
}

function adjustLineLimit(delta: number) {
  if (!selectedLogId.value) return;
  const viewer = ensureViewer(selectedLogId.value);
  viewer.lineLimit = Math.min(MAX_LOG_DISPLAY_LINES, Math.max(1, viewer.lineLimit + delta));
}

function clearFilterKeyword(logId = selectedLogId.value) {
  if (!logId) return;
  ensureViewer(logId).filterKeyword = "";
}

async function saveLog() {
  if (!form.sshConnectionId) return ElMessage.warning(tr("请选择 SSH 连接"));
  const filePaths = form.filePaths.map((filePath) => filePath.trim()).filter(Boolean);
  if (!filePaths.length) return ElMessage.warning(tr("请至少输入一个日志文件路径"));
  if (filePaths.some((filePath) => !filePath.startsWith("/"))) return ElMessage.warning(tr("请输入以 / 开头的绝对路径"));
  if (new Set(filePaths).size !== filePaths.length) return ElMessage.warning(tr("日志文件路径不能重复"));
  saving.value = true;
  try {
    const editing = Boolean(editingLogId.value);
    const response = await api<{ id?: string }>(
      editing ? `/api/v1/environment-logs/${editingLogId.value}` : `/api/v1/environments/${props.environmentId}/logs`,
      {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({ name: form.name, sshConnectionId: form.sshConnectionId, filePaths }),
      },
    );
    dialogVisible.value = false;
    ElMessage.success(editing ? tr("日志配置已更新") : tr("日志配置已添加"));
    if (!editing && response.id) selectedLogId.value = response.id;
    if (editing) {
      if (logStreamActive(editingLogId.value)) await stopStream(editingLogId.value);
      const viewer = ensureViewer(editingLogId.value);
      viewer.output = "";
      viewer.status = "idle";
      viewer.message = tr("配置已更新，双击重新查看");
    }
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存日志配置失败"));
  } finally {
    saving.value = false;
  }
}

async function removeLog(log: EnvironmentLog) {
  try {
    await ElMessageBox.confirm(tr("删除“{0}”的日志配置？远程日志文件不会被修改。", [log.name]), tr("删除日志配置"), {
      type: "warning",
      confirmButtonText: tr("删除配置"),
      cancelButtonText: tr("取消"),
    });
    if (logStreamActive(log.id)) await stopStream(log.id);
    await api(`/api/v1/environment-logs/${log.id}`, { method: "DELETE" });
    delete viewers[log.id];
    ElMessage.success(tr("日志配置已删除"));
    await loadData();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除日志配置失败"));
  }
}

function handleLogConnectionAction(action: string, log: EnvironmentLog) {
  if (action === "edit") openEdit(log);
  else if (action === "delete") void removeLog(log);
}

function handleLogFilterAction(action: string) {
  if (action === "download") void downloadCurrentLog();
}

function appendOutput(logId: string, data: string, stderr = false) {
  const viewer = ensureViewer(logId);
  const next = `${viewer.output}${stderr ? "[tail] " : ""}${data}`;
  const lines = next.split("\n");
  viewer.output = lines.length > MAX_LOG_DISPLAY_LINES ? lines.slice(lines.length - MAX_LOG_DISPLAY_LINES).join("\n") : next;
  if (selectedLogId.value === logId && autoScroll.value) void scrollToBottom();
}

function downloadFilename(): string {
  const name = selectedLog.value?.name || "viron-log";
  const safeName = name.replace(/[\\/:*?"<>|\r\n]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "viron-log";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeName}${filteredLog.value.filtered ? "-filtered" : ""}-${timestamp}.log`;
}

async function downloadCurrentLog() {
  if (!displayOutput.value) return ElMessage.warning(normalizedFilterKeyword.value ? tr("没有可下载的匹配日志") : tr("没有可下载的日志内容"));
  try {
    const saved = await saveTextFile(downloadFilename(), displayOutput.value.endsWith("\n") ? displayOutput.value : `${displayOutput.value}\n`);
    if (saved) ElMessage.success(tr("日志已保存"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("下载日志失败"));
  }
}

async function scrollToBottom() {
  await nextTick();
  if (outputElement.value) outputElement.value.scrollTop = outputElement.value.scrollHeight;
}

function connectWebSocket(logId: string, ticket: string) {
  const viewer = ensureViewer(logId);
  const socket = new ServiceSocket("/ws/ssh-logs", { ticket });
  sockets.set(logId, socket);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data) as { type?: string; data?: string; reason?: string };
      if (message.type === "ready") {
        viewer.status = "streaming";
        viewer.message = tr("正在持续跟踪 {0} 个文件", [logs.value.find((log) => log.id === logId)?.filePaths.length ?? 0]);
      } else if (message.type === "output" && typeof message.data === "string") {
        appendOutput(logId, message.data);
      } else if (message.type === "stderr" && typeof message.data === "string") {
        appendOutput(logId, message.data, true);
      } else if (message.type === "closed") {
        const userStopped = message.reason === "用户停止查看日志" || message.reason === tr("用户停止查看日志");
        viewer.status = userStopped ? "stopped" : "error";
        viewer.message = message.reason ? localizeMessage(message.reason) : tr("实时日志已结束");
      }
    } catch {
      viewer.status = "error";
      viewer.message = tr("收到无法识别的日志消息");
    }
  });
  socket.addEventListener("error", () => {
    if (viewer.status !== "stopped") {
      viewer.status = "error";
      viewer.message = tr("实时日志连接异常");
    }
  });
  socket.addEventListener("close", () => {
    if (sockets.get(logId) !== socket) return;
    sockets.delete(logId);
    viewer.streamId = "";
    if (viewer.status === "connecting" || viewer.status === "streaming") {
      viewer.status = "stopped";
      viewer.message = tr("实时日志已停止");
    }
  });
}

function handleDesktopLogEvent(event: DesktopLogStreamEvent) {
  const viewer = ensureViewer(event.logId);
  if (event.type === "ready") {
    viewer.streamId = event.stream.id;
    viewer.status = "streaming";
    viewer.message = tr("正在持续跟踪 {0} 个文件", [event.stream.filePaths.length]);
  } else if (event.type === "output") {
    appendOutput(event.logId, event.data);
  } else if (event.type === "stderr") {
    appendOutput(event.logId, event.data, true);
  } else if (event.type === "error") {
    viewer.status = "error";
    viewer.message = event.message;
  } else if (event.type === "closed") {
    const userStopped = event.reason === "用户停止查看日志" || event.reason === tr("用户停止查看日志");
    viewer.streamId = "";
    viewer.status = userStopped ? "stopped" : "error";
    viewer.message = event.reason ? localizeMessage(event.reason) : tr("实时日志已结束");
  }
}

async function startStream(logId = selectedLogId.value) {
  if (!props.executionEnabled) return;
  const log = logs.value.find((item) => item.id === logId);
  if (!log) return;
  if (!log.connectionAvailable) return ElMessage.warning(tr("该 SSH 连接已不可用，请编辑日志配置"));
  const viewer = ensureViewer(logId);
  if (viewer.streamId || sockets.has(logId)) await stopStream(logId);
  normalizeLineLimit(logId);
  const requestVersion = ++viewer.requestVersion;
  viewer.output = "";
  viewer.status = "connecting";
  viewer.message = tr("正在连接 SSH 并读取最近 {0} 行", [viewer.lineLimit]);
  try {
    if (props.localExecution) {
      const response = await openDesktopLogStream({ environmentId: props.environmentId, logId: log.id, initialLines: viewer.lineLimit });
      rememberActiveConnectionOrigin(response.activeConnectionId, props.environmentId);
      if (viewer.requestVersion !== requestVersion) {
        await closeDesktopLogStream(response.stream.id).catch(() => undefined);
        return;
      }
      viewer.streamId = response.stream.id;
      viewer.status = "streaming";
      viewer.message = tr("正在持续跟踪 {0} 个文件", [response.stream.filePaths.length]);
      return;
    }
    const response = await api<{ stream: LogStream; ticket: string }>(`/api/v1/environment-logs/${log.id}/stream`, {
      method: "POST",
      body: JSON.stringify({ initialLines: viewer.lineLimit }),
    });
    rememberActiveConnectionOrigin(response.stream.id, props.environmentId);
    if (viewer.requestVersion !== requestVersion) {
      await api(`/api/v1/ssh-log-streams/${response.stream.id}`, { method: "DELETE" }).catch(() => undefined);
      return;
    }
    viewer.streamId = response.stream.id;
    connectWebSocket(logId, response.ticket);
  } catch (error) {
    if (viewer.requestVersion !== requestVersion) return;
    viewer.status = "error";
    viewer.message = error instanceof Error ? error.message : tr("实时日志连接失败");
    ElMessage.error(viewer.message);
  }
}

async function startLog(id: string) {
  await selectLog(id);
  if (!props.executionEnabled) return;
  await nextTick();
  await startStream(id);
}

async function stopStream(logId = selectedLogId.value) {
  if (!logId) return;
  const viewer = ensureViewer(logId);
  const streamId = viewer.streamId;
  const socket = sockets.get(logId);
  viewer.requestVersion += 1;
  viewer.streamId = "";
  sockets.delete(logId);
  if (streamId) {
    try {
      if (props.localExecution) await closeDesktopLogStream(streamId);
      else await api(`/api/v1/ssh-log-streams/${streamId}`, { method: "DELETE" });
    } catch {
      // Runtime or WebSocket closure also releases the tail process, so repeated stops stay silent.
    }
  }
  socket?.close();
  if (viewer.status !== "error") {
    viewer.status = "stopped";
    viewer.message = tr("已停止实时跟踪");
  }
}

async function restartStream(logId = selectedLogId.value) {
  await stopStream(logId);
  await startStream(logId);
}

function handleLogShortcut(event: KeyboardEvent) {
  if (!props.active) return;
  const target = event.target instanceof Element ? event.target : null;
  const selection = window.getSelection();
  const input = {
    key: event.key,
    control: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    repeat: event.repeat,
    composing: event.isComposing,
  };
  if (shouldHandleLogPauseShortcut(input, {
    streamActive: streamActive.value,
    dialogVisible: dialogVisible.value,
    editableTarget: Boolean(target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")),
    hasSelection: Boolean(selection && !selection.isCollapsed && selection.toString()),
  })) {
    event.preventDefault();
    void stopStream();
    return;
  }
  if (shouldHandleLogReconnectShortcut(input, {
    reconnectAvailable: Boolean(selectedLog.value) && (viewerStatus.value === "stopped" || viewerStatus.value === "error"),
    dialogVisible: dialogVisible.value,
    interactiveTarget: Boolean(target?.closest("a[href], button, input, textarea, select, [role='button'], [contenteditable]:not([contenteditable='false'])")),
  })) {
    event.preventDefault();
    void restartStream();
  }
}

function clearOutput(logId = selectedLogId.value) {
  if (logId) ensureViewer(logId).output = "";
}

function setCatalogWidth(value: number) {
  const maxWidth = Math.min(520, (panelElement.value?.getBoundingClientRect().width ?? 1040) * .55);
  catalogWidth.value = Math.round(Math.max(220, Math.min(maxWidth, value)));
}

function finishCatalogResize() {
  if (catalogResizeMove) document.removeEventListener("pointermove", catalogResizeMove);
  if (catalogResizeFinish) {
    document.removeEventListener("pointerup", catalogResizeFinish);
    document.removeEventListener("pointercancel", catalogResizeFinish);
  }
  catalogResizeMove = null;
  catalogResizeFinish = null;
}

function startCatalogResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const bounds = panelElement.value?.getBoundingClientRect();
  if (!bounds) return;
  finishCatalogResize();
  catalogResizeMove = (moveEvent) => setCatalogWidth(moveEvent.clientX - bounds.left);
  catalogResizeFinish = finishCatalogResize;
  document.addEventListener("pointermove", catalogResizeMove);
  document.addEventListener("pointerup", catalogResizeFinish, { once: true });
  document.addEventListener("pointercancel", catalogResizeFinish, { once: true });
}

function resizeCatalog(delta: number) {
  setCatalogWidth(catalogWidth.value + delta);
}

async function stopAllStreams() {
  await Promise.all(Object.keys(viewers).filter((logId) => logStreamActive(logId) || viewers[logId]?.streamId).map((logId) => stopStream(logId)));
}

onMounted(() => {
  if (props.localExecution) stopDesktopLogEvents = onDesktopLogStreamEvent(handleDesktopLogEvent);
  document.addEventListener("keydown", handleLogShortcut);
  void loadData();
});
watch([() => props.localExecution, () => props.executionEnabled], ([localExecution, executionEnabled]) => {
  stopDesktopLogEvents?.();
  stopDesktopLogEvents = localExecution && executionEnabled ? onDesktopLogStreamEvent(handleDesktopLogEvent) : null;
  for (const socket of sockets.values()) socket.close();
  sockets.clear();
  for (const viewer of Object.values(viewers)) {
    viewer.requestVersion += 1;
    viewer.streamId = "";
    if (viewer.status === "connecting" || viewer.status === "streaming") {
      viewer.status = "stopped";
      viewer.message = tr("连接模式已切换，重新连接后将使用当前模式");
    }
  }
});
watch(() => props.environmentId, async () => {
  await stopAllStreams();
  for (const logId of Object.keys(viewers)) delete viewers[logId];
  selectedLogId.value = "";
  await loadData();
});
onBeforeUnmount(() => {
  finishCatalogResize();
  document.removeEventListener("keydown", handleLogShortcut);
  for (const viewer of Object.values(viewers)) viewer.requestVersion += 1;
  stopDesktopLogEvents?.();
  stopDesktopLogEvents = null;
  if (props.localExecution) {
    for (const viewer of Object.values(viewers)) {
      if (viewer.streamId) void closeDesktopLogStream(viewer.streamId).catch(() => undefined);
    }
  }
  for (const socket of sockets.values()) socket.close();
  sockets.clear();
});
</script>

<template>
  <section ref="panelElement" class="environment-log-panel" :class="{ 'is-catalog-hidden': !catalogVisible }" :style="panelStyle" v-loading="loading">
    <aside v-if="catalogVisible" class="log-catalog" :aria-label="$t('日志配置')">
      <header class="log-catalog__header">
        <div class="log-catalog__title"><strong>{{ $t('日志配置') }}</strong><span>{{ logs.length }} {{ $t('个配置 ·') }} {{ totalFileCount }} {{ $t('个文件') }}{{ activeStreamCount ? $t(' · {0} 路活动', [activeStreamCount]) : '' }}</span></div>
        <div class="log-catalog__actions">
          <button type="button" :disabled="!sshConnections.length" :aria-label="$t('新增日志')" :title="$t('新增日志')" @click="openCreate"><Plus :size="16" /></button>
          <button type="button" :aria-label="$t('隐藏日志配置列表')" :title="$t('隐藏配置列表')" @click="catalogVisible = false"><PanelLeftClose :size="16" /></button>
        </div>
      </header>

      <div v-if="logs.length" class="log-catalog__list">
        <el-dropdown v-for="log in logs" :key="log.id" class="workbench-connection-context-target" trigger="contextmenu" placement="bottom-start" popper-class="workbench-connection-menu-popper" @command="handleLogConnectionAction($event, log)">
          <article class="log-config-item" :class="{ 'is-active': selectedLogId === log.id, 'is-streaming': logStreamActive(log.id) }">
            <button class="log-config-item__main" type="button" :title="executionEnabled ? $t('单击选择，双击开始查看') : $t('单击选择；本机日志执行尚未开放')" @click="selectLog(log.id)" @dblclick="startLog(log.id)" @keydown.enter.prevent="startLog(log.id)">
              <span class="log-config-item__icon" :title="logStreamActive(log.id) ? $t('正在后台跟踪') : undefined"><FileText :size="17" /><i v-if="logStreamActive(log.id)"></i></span>
              <span class="log-config-item__copy">
                <strong>{{ log.name }}</strong>
                <span>{{ log.connectionName }}</span>
                <code :title="log.filePaths.join('\n')">{{ log.filePaths[0] }}<em v-if="log.filePaths.length > 1">+{{ log.filePaths.length - 1 }}</em></code>
              </span>
            </button>
            <el-dropdown class="log-config-item__menu-target" trigger="click" placement="bottom-end" popper-class="workbench-connection-menu-popper" @command="handleLogConnectionAction($event, log)">
              <button class="log-config-item__menu" type="button" :aria-label="$t('打开 {0} 的日志操作菜单', [log.name])" :title="$t('日志操作')"><ChevronDown :size="15" /></button>
              <template #dropdown><WorkbenchConnectionActions :actions="logConnectionActions" /></template>
            </el-dropdown>
          </article>
          <template #dropdown><WorkbenchConnectionActions :actions="logConnectionActions" /></template>
        </el-dropdown>
      </div>

      <div v-else class="log-catalog__empty">
        <FileText :size="24" />
        <strong>{{ $t('还没有日志配置') }}</strong>
        <p v-if="sshConnections.length">{{ $t('选择当前环境的 SSH 连接，再填写远程日志文件路径。') }}</p>
        <p v-else>{{ $t('当前环境还没有可用的 SSH 连接，请先在连接资源池中完成分配。') }}</p>
        <el-button v-if="sshConnections.length" type="primary" @click="openCreate"><Plus :size="15" />{{ $t('新增日志') }}</el-button>
      </div>
    </aside>

    <button v-if="catalogVisible" class="log-catalog-resizer" type="button" role="separator" aria-orientation="vertical" :aria-label="$t('调整日志配置列表宽度')" aria-valuemin="220" aria-valuemax="520" :aria-valuenow="catalogWidth" @pointerdown="startCatalogResize" @keydown.left.prevent="resizeCatalog(-20)" @keydown.right.prevent="resizeCatalog(20)"><span></span></button>

    <main v-if="!executionEnabled" class="log-viewer log-viewer--execution-disabled">
      <button v-if="!catalogVisible" class="log-catalog-restore" type="button" :aria-label="$t('显示日志配置列表')" :title="$t('显示配置列表')" @click="catalogVisible = true"><PanelLeftOpen :size="16" /></button>
      <DesktopExecutionNotice :capability='$t("日志查看")' compact />
    </main>

    <main v-else class="log-viewer">
      <button v-if="!catalogVisible" class="log-catalog-restore" type="button" :aria-label="$t('显示日志配置列表')" :title="$t('显示配置列表')" @click="catalogVisible = true"><PanelLeftOpen :size="16" /></button>
      <header class="log-viewer__header">
        <div v-if="selectedLog" class="log-viewer__identity">
          <span class="log-viewer__icon"><FileText :size="18" /></span>
          <div><strong>{{ selectedLog.name }}</strong><span><Server :size="13" />{{ selectedLog.username }}@{{ selectedLog.host }}:{{ selectedLog.port }}</span></div>
        </div>
        <div v-else class="log-viewer__identity is-muted"><span class="log-viewer__icon"><FileText :size="18" /></span><div><strong>{{ $t('实时日志') }}</strong><span>{{ $t('尚未选择日志配置') }}</span></div></div>

        <div class="log-viewer__controls">
          <span class="log-status" :class="`is-${viewerStatus}`"><i></i>{{ statusLabel }}</span>
          <button v-if="streamActive" type="button" class="is-stop" :title="$t('停止当前日志流（Ctrl+C）')" @click="stopStream()"><CircleStop :size="15" />{{ $t('ctrl+c/停止') }}</button>
          <button v-else-if="viewerStatus === 'stopped' || viewerStatus === 'error'" type="button" :disabled="!selectedLog" :title="$t('重新连接当前日志流（Enter）')" @click="restartStream()"><RotateCcw :size="15" />{{ $t('Enter/重新连接') }}</button>
        </div>
      </header>

      <section class="log-filter-bar" :aria-label="$t('日志过滤')">
        <label class="log-filter-search">
          <Search :size="15" />
          <input v-model="filterKeyword" type="search" :placeholder="$t('grep 关键字')" :aria-label="$t('日志关键字过滤')" />
          <button v-if="filterKeyword" class="log-filter-clear" type="button" :aria-label="$t('清除日志过滤关键字')" :title="$t('清除关键字')" @click="clearFilterKeyword()"><X :size="13" /></button>
        </label>
        <label class="log-filter-check"><input v-model="filterCaseSensitive" type="checkbox" />{{ $t('区分大小写') }}</label>
        <el-select v-model="filterContextMode" class="log-context-mode-select" size="small" :aria-label="$t('关键字上下文范围')" popper-class="log-context-mode-popper" @change="normalizeFilterContext()">
          <el-option v-for="option in filterContextModeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <label class="log-context-lines"><input v-model.number="filterContextLines" type="number" min="0" max="200" :aria-label="$t('关键字上下文行数')" @change="normalizeFilterContext()" /><span>{{ $t('行') }}</span></label>
        <div class="log-line-control" :class="{ 'is-disabled': !selectedLog }">
          <span>{{ $t('行数上限') }}</span>
          <div class="log-line-stepper">
            <button type="button" :disabled="!selectedLog || lineLimit <= 1" :aria-label="$t('减少日志行数上限')" @click="adjustLineLimit(-100)"><Minus :size="14" /></button>
            <input v-model.number="lineLimit" type="number" min="1" max="5000" :disabled="!selectedLog" :aria-label="$t('日志行数上限')" @change="normalizeLineLimit()" />
            <button type="button" :disabled="!selectedLog || lineLimit >= 5000" :aria-label="$t('增加日志行数上限')" @click="adjustLineLimit(100)"><Plus :size="14" /></button>
          </div>
        </div>
        <button class="log-filter-action" type="button" :disabled="!output" :title="$t('清空当前屏幕')" @click="clearOutput()"><Eraser :size="15" />{{ $t('清屏') }}</button>
        <el-dropdown class="log-filter-menu-target" trigger="click" placement="bottom-end" popper-class="workbench-connection-menu-popper" @command="handleLogFilterAction">
          <button class="log-filter-more" type="button" :aria-label="$t('打开日志更多操作')" :title="$t('更多日志操作')"><Ellipsis :size="17" /></button>
          <template #dropdown><WorkbenchConnectionActions :actions="logFilterActions" /></template>
        </el-dropdown>
        <span v-if="filteredLog.filtered" class="log-filter-summary">{{ filteredLog.matchLineCount }} {{ $t('个匹配 ·') }} {{ filteredLog.includedLineCount }} {{ $t('行上下文') }}</span>
      </section>

      <div ref="outputElement" class="log-output" role="log" :aria-label="$t('实时日志输出')">
        <pre v-if="displayOutput"><code v-if="highlightImportant || normalizedFilterKeyword" class="is-highlighted" v-html="highlightedOutput"></code><code v-else>{{ displayOutput }}</code></pre>
        <div v-else class="log-output__empty" :class="{ 'is-error': viewerStatus === 'error' }">
          <FileText :size="28" />
          <strong>{{ outputEmptyMessage }}</strong>
        </div>
      </div>

      <footer class="log-viewer__footer">
        <div><TipIcon :content="$t('日志查看为只读操作，不会修改远程文件；界面最多保留 5000 行，下载导出当前屏幕结果。')" placement="right" /><label><input v-model="highlightImportant" type="checkbox" />{{ $t('重点高亮') }}</label><label><input v-model="autoScroll" type="checkbox" />{{ $t('自动滚动') }}</label><span>{{ $t('显示') }} {{ lineCount }} {{ $t('行 / 保留') }} {{ rawLineCount }} {{ $t('行') }}</span></div>
      </footer>
    </main>

    <el-dialog v-model="dialogVisible" align-center class="envman-dialog log-config-dialog" :title="editingLogId ? $t('编辑日志配置') : $t('新增日志配置')" width="620px" append-to-body destroy-on-close>
      <el-form label-position="top">
        <el-form-item :label="$t('SSH 连接')" required>
          <el-select v-model="form.sshConnectionId" :placeholder="$t('选择当前环境中的 SSH 连接')" style="width:100%">
            <el-option v-for="connection in sshConnections" :key="connection.id" :value="connection.id" :label="`${connection.name} · ${connection.username}@${connection.host}:${connection.port}`" />
          </el-select>
        </el-form-item>
        <el-form-item required>
          <template #label><span class="form-label-with-tip">{{ $t('日志文件路径') }}<TipIcon :content="$t('每个配置可填写 1–10 个远程绝对文件路径，不支持通配符或目录。')" placement="right" /></span></template>
          <div class="log-path-fields">
            <div v-for="(_filePath, index) in form.filePaths" :key="index" class="log-path-field">
              <span>{{ index + 1 }}</span>
              <el-input v-model="form.filePaths[index]" class="log-path-input" placeholder="/var/log/my-app/application.log" maxlength="1024" />
              <button type="button" :aria-label="$t('移除第 {0} 个文件路径', [index + 1])" :title="$t('移除路径')" @click="removeFilePath(index)"><X :size="15" /></button>
            </div>
            <button v-if="form.filePaths.length < 10" class="log-add-path" type="button" @click="addFilePath"><Plus :size="14" />{{ $t('添加文件路径') }}</button>
          </div>
        </el-form-item>
        <el-form-item :label="$t('显示名称')">
          <el-input v-model="form.name" :placeholder="$t('留空时使用文件名')" maxlength="120" show-word-limit />
        </el-form-item>
        <div class="dialog-tip-row"><span>{{ $t('只读命令') }}</span><TipIcon :content="$t('Viron 只生成固定的 tail 命令并独立转义路径，页面不能提交其他 Shell 命令。')" placement="right" /></div>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveLog">{{ $t('保存配置') }}</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.environment-log-panel { position: relative; height: min(760px, calc(100vh - 152px)); min-height: 590px; margin-top: 18px; display: grid; grid-template-columns: var(--log-catalog-width, 220px) minmax(0, 1fr); overflow: hidden; border: 1px solid var(--ink-100); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--shadow-lg); }
.environment-log-panel.is-catalog-hidden { grid-template-columns: minmax(0, 1fr); }
.log-catalog { min-width: 0; padding: 15px 13px; display: flex; flex-direction: column; border-right: 1px solid #243638; background: #101c1f; color: #dbe8e5; }
.log-catalog-resizer { position: absolute; z-index: 16; top: 0; bottom: 0; left: var(--log-catalog-width, 220px); width: 12px; padding: 0; border: 0; background: transparent; transform: translateX(-6px); cursor: col-resize; touch-action: none; }
.log-catalog-resizer span { width: 2px; height: 46px; margin: auto; display: block; border-radius: 2px; background: #405954; opacity: 0; transition: opacity .15s ease, height .15s ease, background .15s ease; }
.log-catalog-resizer:hover span, .log-catalog-resizer:focus-visible span, .log-catalog-resizer:active span { height: 72px; background: #56c9a5; opacity: 1; }
.log-catalog__header { min-height: 34px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.log-catalog__title { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.log-catalog__header strong { font-size: 13px; }
.log-catalog__title span { overflow: hidden; color: #78918e; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.log-catalog__actions { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; }
.log-catalog__header button { padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #314347; border-radius: 6px; background: transparent; color: #8da39d; cursor: pointer; }
.log-catalog__header button { width: 28px; height: 28px; }
.log-catalog__header button:hover { border-color: #3f736b; color: #75dcc5; }
.log-catalog__header button:disabled { cursor: not-allowed; opacity: .4; }
.log-catalog__list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; scrollbar-width: thin; scrollbar-color: #33484a transparent; }
.log-config-item { width: 100%; min-height: 59px; padding: 4px 5px 4px 8px; border: 1px solid transparent; border-radius: 8px; display: grid; grid-template-columns: minmax(0, 1fr) 27px; align-items: center; gap: 3px; }
.log-config-item:hover { background: #152527; }
.log-config-item.is-active { border-color: #276156; background: #17302d; }
.log-config-item.is-streaming:not(.is-active) { border-color: rgba(53, 139, 121, .34); background: rgba(23, 48, 45, .38); }
.log-config-item__main { min-width: 0; min-height: 49px; padding: 0; display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 8px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.log-config-item__icon, .log-viewer__icon { position: relative; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; background: #1d3b37; color: #68d3bc; }
.log-config-item__icon { width: 32px; height: 32px; }
.log-config-item__icon i { position: absolute; top: -3px; right: -3px; width: 8px; height: 8px; border: 2px solid #17302d; border-radius: 50%; background: #45d4b4; box-shadow: 0 0 0 3px rgba(69, 212, 180, .1); }
.log-config-item__copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.log-config-item__copy strong { overflow: hidden; color: #edf5f3; font-size: 13px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.log-config-item__copy span { overflow: hidden; color: #8ba19e; font-size: 12px; line-height: 14px; text-overflow: ellipsis; white-space: nowrap; }
.log-config-item__copy code { overflow: hidden; color: #617b78; font-family: var(--font-mono); font-size: 11px; font-style: normal; line-height: 13px; text-overflow: ellipsis; white-space: nowrap; }
.log-config-item__copy code em { margin-left: 6px; padding: 1px 5px; border: 1px solid #31504b; border-radius: 9px; color: #77a59c; font-size: 9px; font-style: normal; }
.log-config-item__menu-target { width: 25px; height: 27px; display: block; }
.log-config-item__menu { width: 25px; height: 27px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #60736f; display: grid; place-items: center; cursor: pointer; }
.log-config-item:hover .log-config-item__menu, .log-config-item.is-active .log-config-item__menu { background: #203833; color: #65d4b0; }
.log-catalog__empty { flex: 1; padding: 36px 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #708784; text-align: center; }
.log-catalog__empty strong { margin-top: 14px; color: #dbe8e5; font-size: 14px; }
.log-catalog__empty p { max-width: 220px; margin: 8px 0 18px; font-size: 12px; line-height: 1.6; }
.log-viewer { position: relative; min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr) 32px; background: #091416; color: #c9d7d4; }
.log-viewer--execution-disabled { display: block; background: var(--surface); }
.log-viewer--execution-disabled :deep(.desktop-execution-notice) { height: 100%; min-height: 100%; border-radius: 0; }
.log-catalog-restore { position: absolute; z-index: 4; top: 16px; left: 12px; width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border: 1px solid #304447; border-radius: 6px; background: #172629; color: #72a096; cursor: pointer; }
.log-catalog-restore:hover { border-color: #4b8d7c; background: #203833; color: #69d2af; }
.is-catalog-hidden .log-viewer__identity { padding-left: 34px; }
.log-viewer__header { min-height: 62px; padding: 10px 14px 10px 18px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #203133; }
.log-viewer__identity { min-width: 0; display: flex; align-items: center; gap: 10px; }
.log-viewer__icon { width: 34px; height: 34px; }
.log-viewer__identity > div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.log-viewer__identity strong { overflow: hidden; color: #f0f6f4; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.log-viewer__identity span { display: flex; align-items: center; gap: 5px; color: #77908d; font-family: var(--font-mono); font-size: 11px; }
.log-viewer__identity.is-muted { opacity: .7; }
.log-viewer__controls { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.log-viewer__controls button { height: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid #2d4446; border-radius: 7px; background: #122123; color: #aabbb8; font-size: 12px; cursor: pointer; }
.log-viewer__controls button:hover:not(:disabled) { border-color: #42736d; color: #dcf6f0; }
.log-viewer__controls button.is-stop { border-color: #734744; color: #ffaaa2; }
.log-viewer__controls button:disabled { cursor: not-allowed; opacity: .4; }
.log-line-control { flex: 0 0 auto; height: 32px; display: inline-flex; align-items: center; overflow: hidden; border: 1px solid #304548; border-radius: 8px; background: #101c1f; }
.log-line-control > span { height: 100%; padding: 0 10px 0 11px; display: inline-flex; align-items: center; border-right: 1px solid #263a3c; color: #8da39f; font-size: 12px; font-weight: 800; white-space: nowrap; }
.log-status { margin-right: 4px; display: inline-flex; align-items: center; gap: 6px; color: #7d9491; font-size: 12px; white-space: nowrap; }
.log-status i { width: 7px; height: 7px; border-radius: 50%; background: #607370; }
.log-status.is-connecting i { background: #d5a84d; }
.log-status.is-streaming { color: #79cdbb; }
.log-status.is-streaming i { background: #45d4b4; box-shadow: 0 0 0 4px rgba(69, 212, 180, .1); }
.log-status.is-error { color: #ee8e86; }
.log-status.is-error i { background: #ef6b62; }
.log-line-stepper { height: 100%; display: inline-grid; grid-template-columns: 32px 72px 32px; overflow: hidden; background: #091416; }
.log-line-control:focus-within { border-color: #3d776d; box-shadow: 0 0 0 2px rgba(56, 157, 137, .1); }
.log-line-stepper button, .log-line-stepper input { min-width: 0; padding: 0; border: 0; background: transparent; color: #b8cac6; }
.log-line-stepper button { height: 100%; display: grid; place-items: center; border-radius: 0; cursor: pointer; }
.log-line-stepper button:first-child { border-right: 1px solid #263a3c; }
.log-line-stepper button:last-child { border-left: 1px solid #263a3c; }
.log-line-stepper button:hover:not(:disabled) { background: #18302e; color: #73d8c1; }
.log-line-stepper button:disabled { cursor: not-allowed; opacity: .35; }
.log-line-stepper input { width: 72px; text-align: center; font-family: var(--font-mono); font-size: 12px; font-weight: 800; outline: 0; appearance: textfield; }
.log-line-stepper input::-webkit-inner-spin-button, .log-line-stepper input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.log-line-control.is-disabled { opacity: .55; }
.log-filter-bar { min-width: 0; min-height: 48px; padding: 7px 14px 7px 18px; display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; border-bottom: 1px solid #203133; background: #0c181a; overflow-x: auto; }
.log-filter-search { flex: 1 1 280px; min-width: 190px; max-width: 520px; height: 32px; padding: 0 6px 0 10px; border: 1px solid #304548; border-radius: 8px; background: #091416; color: #7aa69d; display: flex; align-items: center; gap: 8px; }
.log-filter-search:focus-within { border-color: #3d776d; box-shadow: 0 0 0 2px rgba(56, 157, 137, .1); }
.log-filter-search input { min-width: 0; width: 100%; padding: 0; border: 0; outline: 0; background: transparent; color: #d2e3df; font-family: var(--font-mono); font-size: 12px; }
.log-filter-search input::-webkit-search-cancel-button { appearance: none; }
.log-filter-search input::placeholder { color: #526a67; }
.log-filter-clear { flex: 0 0 auto; width: 22px; height: 22px; padding: 0; display: grid; place-items: center; border: 1px solid #344a4d; border-radius: 50%; background: #111f22; color: #8aa09c; cursor: pointer; }
.log-filter-clear:hover { border-color: #4b7773; color: #e0f5f0; }
.log-filter-check { height: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 7px; border: 1px solid #2b4143; border-radius: 8px; color: #a1b2af; font-size: 12px; font-weight: 700; white-space: nowrap; }
.log-filter-check input { accent-color: #35ae95; }
.log-context-mode-select { flex: 0 0 118px; width: 118px; }
.log-context-mode-select :deep(.el-select__wrapper) { min-height: 32px; height: 32px; padding: 0 10px; border: 1px solid #2b4143; border-radius: 8px; background: #091416; box-shadow: none; }
.log-context-mode-select :deep(.el-select__wrapper.is-focused), .log-context-mode-select :deep(.el-select__wrapper:hover) { border-color: #6f55b5; box-shadow: 0 0 0 2px rgba(126, 92, 210, .16); }
.log-context-mode-select :deep(.el-select__selected-item) { color: #d9d8e8; font-size: 12px; font-weight: 800; }
.log-context-mode-select :deep(.el-select__caret) { color: #9c93c9; }
.log-context-lines { height: 32px; display: inline-flex; align-items: center; overflow: hidden; border: 1px solid #2b4143; border-radius: 8px; background: #091416; color: #78908c; white-space: nowrap; }
.log-context-lines:focus-within { border-color: #3d776d; box-shadow: 0 0 0 2px rgba(56, 157, 137, .1); }
.log-context-lines input { width: 58px; height: 100%; padding: 0 8px; border: 0; outline: 0; background: transparent; color: #d2e3df; font-family: var(--font-mono); font-size: 12px; font-weight: 800; text-align: center; appearance: textfield; }
.log-context-lines span { height: 100%; padding: 0 9px; display: inline-flex; align-items: center; border-left: 1px solid #263a3c; color: #91a7a3; font-size: 12px; font-weight: 800; }
.log-context-lines input::-webkit-inner-spin-button, .log-context-lines input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.log-filter-action { flex: 0 0 auto; height: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid #2d4446; border-radius: 8px; background: #122123; color: #aabbb8; font-size: 12px; cursor: pointer; white-space: nowrap; }
.log-filter-action:hover:not(:disabled), .log-filter-more:hover:not(:disabled) { border-color: #42736d; color: #dcf6f0; }
.log-filter-action:disabled { cursor: not-allowed; opacity: .4; }
.log-filter-menu-target { flex: 0 0 auto; width: 34px; height: 32px; display: block; }
.log-filter-more { width: 34px; height: 32px; padding: 0; display: grid; place-items: center; border: 1px solid #3b3659; border-radius: 8px; background: #151727; color: #a996ff; cursor: pointer; }
.log-filter-more[aria-expanded="true"], .log-filter-more:focus-visible { border-color: #8c75e5; box-shadow: 0 0 0 2px rgba(140, 117, 229, .18); }
.log-filter-summary { flex: 0 0 auto; color: #66817c; font-size: 11px; white-space: nowrap; }
:global(.log-context-mode-popper) { border-color: #343846 !important; background: #181a20 !important; }
:global(.log-context-mode-popper .el-popper__arrow::before) { border-color: #343846 !important; background: #181a20 !important; }
:global(.log-context-mode-popper .el-select-dropdown__list) { padding: 6px; }
:global(.log-context-mode-popper .el-select-dropdown__item) { height: 34px; border-radius: 6px; color: #d1d4db; font-size: 13px; font-weight: 700; }
:global(.log-context-mode-popper .el-select-dropdown__item.hover), :global(.log-context-mode-popper .el-select-dropdown__item:hover) { background: #262930; }
:global(.log-context-mode-popper .el-select-dropdown__item.is-selected) { background: #2c2936; color: #a891ff; }
.log-output { min-width: 0; min-height: 0; overflow: auto; }
.log-output pre { min-width: 100%; width: max-content; margin: 0; padding: 18px 20px 32px; box-sizing: border-box; color: #c6d7d3; font-family: var(--font-console); font-size: var(--font-console-size); line-height: 1.65; tab-size: 4; }
.log-output code { font-family: inherit; }
.log-output code.is-highlighted { min-width: 100%; display: block; }
.log-output :deep(.log-line) { min-width: 100%; margin: 0 -8px; padding: 0 8px; display: block; box-sizing: border-box; box-shadow: inset 2px 0 transparent; white-space: pre; }
.log-output :deep(.log-line--critical) { background: rgba(163, 85, 224, .105); box-shadow: inset 2px 0 #b36df0; color: #eadcf6; }
.log-output :deep(.log-line--error) { background: rgba(222, 83, 73, .09); box-shadow: inset 2px 0 #e56d63; color: #efd8d5; }
.log-output :deep(.log-line--warning) { background: rgba(206, 153, 52, .07); box-shadow: inset 2px 0 #d1a64e; color: #e7dfcc; }
.log-output :deep(.log-line--info) { box-shadow: inset 2px 0 rgba(69, 212, 180, .38); }
.log-output :deep(.log-line--debug) { color: #9bb5c5; }
.log-output :deep(.log-line--trace) { color: #789799; }
.log-output :deep(.log-token) { border-radius: 3px; }
.log-output :deep(.log-token--level) { padding: 0 3px; font-weight: 900; }
.log-output :deep(.log-token--critical) { background: rgba(177, 101, 240, .16); color: #deaefc; }
.log-output :deep(.log-token--error) { background: rgba(232, 98, 88, .13); color: #ff9d94; }
.log-output :deep(.log-token--warning) { background: rgba(213, 168, 77, .13); color: #e8c673; }
.log-output :deep(.log-token--info) { color: #71d3bd; }
.log-output :deep(.log-token--debug) { color: #84bce8; }
.log-output :deep(.log-token--trace) { color: #77c8d1; }
.log-output :deep(.log-token--timestamp) { color: #7f9e9a; }
.log-output :deep(.log-token--identifier) { background: rgba(150, 120, 205, .08); color: #c0a8df; }
.log-output :deep(.log-token--keyword) { padding: 0 2px; border-radius: 3px; background: rgba(246, 215, 92, .24); color: #ffe68a; box-shadow: 0 0 0 1px rgba(246, 215, 92, .18); }
.log-output :deep(.log-token--duration) { color: #ddb878; }
.log-output :deep(.log-token--ip) { color: #72bfc7; }
.log-output :deep(.log-token--status-error) { background: rgba(232, 98, 88, .13); color: #ff9d94; }
.log-output :deep(.log-token--status-warning) { background: rgba(213, 168, 77, .13); color: #e8c673; }
.log-output :deep(.log-token--status-ok) { color: #71d3bd; }
.log-output__empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #526a67; text-align: center; }
.log-output__empty strong { margin-top: 12px; color: #8ca19e; font-size: 13px; }
.log-output__empty.is-error, .log-output__empty.is-error strong { color: #c9847e; }
.log-viewer__footer { padding: 0 14px 0 18px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #203133; color: #536d69; font-size: 11px; }
.log-viewer__footer div { display: flex; align-items: center; gap: 14px; }
.log-viewer__footer label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.log-viewer__footer input { accent-color: #35ae95; }
.log-path-fields { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.log-path-field { width: 100%; display: grid; grid-template-columns: 22px minmax(0, 1fr) 30px; align-items: center; gap: 7px; }
.log-path-field > span { color: var(--ink-400); font-family: var(--font-mono); font-size: 11px; text-align: center; }
.log-path-field > button { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border: 1px solid var(--ink-100); border-radius: 6px; background: var(--surface); color: var(--ink-400); cursor: pointer; }
.log-path-field > button:hover { border-color: #d88a84; color: #bf5048; }
.log-add-path { width: max-content; min-height: 30px; margin-left: 29px; padding: 0 10px; display: inline-flex; align-items: center; gap: 5px; border: 1px dashed var(--teal-300); border-radius: 6px; background: var(--teal-50); color: var(--teal-700); cursor: pointer; font-size: 12px; }
.log-add-path:hover { border-style: solid; color: var(--teal-900); }
.log-field-help { margin: 7px 0 0; color: var(--ink-400); font-size: 12px; }
.log-security-note { padding: 12px 14px; display: flex; align-items: flex-start; gap: 9px; border: 1px solid var(--teal-100); border-radius: 8px; background: var(--teal-50); color: var(--teal-800); font-size: 12px; line-height: 1.55; }
.log-security-note svg { flex: 0 0 auto; margin-top: 1px; }
.log-security-note code { font-family: var(--font-mono); }
:global(.log-config-dialog .log-path-input input) { font-family: var(--font-mono); }
@media (max-width: 900px) {
  .environment-log-panel { min-height: 680px; grid-template-columns: 1fr; grid-template-rows: 220px minmax(0, 1fr); }
  .environment-log-panel.is-catalog-hidden { grid-template-rows: minmax(0, 1fr); }
  .log-catalog { border-right: 0; border-bottom: 1px solid #243638; }
  .log-catalog-resizer { display: none; }
  .log-viewer__header { align-items: flex-start; flex-direction: column; }
  .log-viewer__controls { width: 100%; overflow-x: auto; }
}
</style>
