<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  FolderSync,
  RefreshCw,
  Search,
  Server,
  X,
  XCircle,
} from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { rememberActiveConnectionOrigin } from "../active-connection-origin";
import {
  cancelDesktopSftpTransfer,
  createDesktopSftpTransfer,
  desktopDroppedFilePath,
  listDesktopSftpTransfers,
  listDesktopSshSessions,
  previewDesktopSftpTransfer,
  retryDesktopSftpTransfer,
  startDesktopSftpDrag,
} from "../desktop";
import {
  formatFileSize,
  groupSftpConnections,
  isLocalSftpConnection,
  LOCAL_SFTP_CONNECTION_ID,
  type SftpConnection,
  type SftpConflictDecision,
  type SftpOpenRequest,
  type SftpPaneState,
  type SftpTransferConflict,
  type SftpTransferTask,
} from "../sftp";
import SftpPanel from "./SftpPanel.vue";
import TipIcon from "./TipIcon.vue";

const props = withDefaults(defineProps<{
  drawer?: boolean;
  environmentId?: string;
  initialConnectionId?: string;
  openRequest?: SftpOpenRequest;
  localExecution?: boolean;
}>(), { drawer: false, localExecution: false });
const emit = defineEmits<{ close: [] }>();

interface SshSession {
  id: string;
  connectionId: string;
  attached: boolean;
}

interface TransferPreview {
  sourceName: string;
  sourceType: "file" | "directory";
  sourcePath: string;
  sourcePaths: string[];
  targetPath: string;
  targetExists: boolean;
  totalBytes: number;
  totalFiles: number;
  conflicts: SftpTransferConflict[];
}

interface PendingTransfer {
  kind: "transfer" | "upload";
  direction: "left-to-right" | "right-to-left";
  sourceConnection: SftpConnection;
  targetConnection: SftpConnection;
  sourcePaths: string[];
  targetDirectory: string;
  preview: TransferPreview;
  uploadEntries?: BrowserUploadEntry[];
}

interface BrowserUploadEntry {
  relativePath: string;
  type: "file" | "directory";
  size: number;
  file?: File;
}

interface BrowserFileSystemEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file(callback: (file: File) => void, error?: (error: DOMException) => void): void;
  createReader(): { readEntries(callback: (entries: BrowserFileSystemEntry[]) => void, error?: (error: DOMException) => void): void };
}

const loading = ref(true);
const connections = ref<SftpConnection[]>([]);
const sessions = ref<SshSession[]>([]);
const leftConnectionId = ref("");
const rightConnectionId = ref("");
const leftState = ref<SftpPaneState>({ connectionId: "", path: "/", selectedItems: [] });
const rightState = ref<SftpPaneState>({ connectionId: "", path: "/", selectedItems: [] });
const leftPane = ref<InstanceType<typeof SftpPanel> | null>(null);
const rightPane = ref<InstanceType<typeof SftpPanel> | null>(null);
const pickerOpen = ref(false);
const pickerSide = ref<"left" | "right">("left");
const pickerKeyword = ref("");
const transferDialogOpen = ref(false);
const transferStarting = ref(false);
const transferPreparing = ref(false);
const pendingTransfer = ref<PendingTransfer | null>(null);
const conflictIndex = ref(0);
const applyConflictToAll = ref(false);
const conflictDecisions = ref<Record<string, SftpConflictDecision>>({});
const tasks = ref<SftpTransferTask[]>([]);
const tasksExpanded = ref(!props.drawer);
const activeDrag = ref<{ connectionId: string; items: import("../sftp").SftpItem[] } | null>(null);
const nativeDragPreparing = ref(false);
let pollTimer: number | undefined;

const connectionById = computed(() => new Map(connections.value.map((connection) => [connection.id, connection])));
const leftConnection = computed(() => connectionById.value.get(leftConnectionId.value) ?? null);
const rightConnection = computed(() => connectionById.value.get(rightConnectionId.value) ?? null);
const currentConnectionIds = computed(() => new Set(sessions.value.map((session) => session.connectionId)));
const localConnection = computed<SftpConnection>(() => ({
  id: LOCAL_SFTP_CONNECTION_ID,
  type: "local",
  name: tr("本机"),
  host: "localhost",
  port: 0,
  username: "local",
  environmentIds: [],
  connectionGroupPath: null,
}));
const filteredConnections = computed(() => {
  const keyword = pickerKeyword.value.trim().toLowerCase();
  const available = connections.value;
  if (!keyword) return available;
  return available.filter((connection) => `${connection.name} ${connection.username}@${connection.host} ${connection.connectionGroupPath ?? ""}`.toLowerCase().includes(keyword));
});
const groupedConnections = computed(() => groupSftpConnections(filteredConnections.value, props.environmentId, currentConnectionIds.value));
const activeTaskCount = computed(() => tasks.value.filter((task) => ["pending", "running"].includes(task.status)).length);
const currentConflict = computed(() => pendingTransfer.value?.preview.conflicts[conflictIndex.value] ?? null);

function isCurrentSession(connectionId: string): boolean {
  return currentConnectionIds.value.has(connectionId);
}

function connectionMeta(connection: SftpConnection): string {
  if (isLocalSftpConnection(connection)) return tr("当前电脑文件系统");
  return `${connection.username}@${connection.host}:${connection.port}${connection.connectionGroupPath ? ` · ${connection.connectionGroupPath}` : ""}`;
}

function openPicker(side: "left" | "right") {
  pickerSide.value = side;
  pickerKeyword.value = "";
  pickerOpen.value = true;
}

function chooseConnection(connection: SftpConnection) {
  if (pickerSide.value === "left") leftConnectionId.value = connection.id;
  else rightConnectionId.value = connection.id;
  pickerOpen.value = false;
  transferDialogOpen.value = false;
  pendingTransfer.value = null;
}

function updatePaneState(side: "left" | "right", state: SftpPaneState) {
  if (side === "left") leftState.value = state;
  else rightState.value = state;
  if (pendingTransfer.value) {
    transferDialogOpen.value = false;
    pendingTransfer.value = null;
  }
}

async function loadWorkspace() {
  loading.value = true;
  try {
    const query = new URLSearchParams({ type: "ssh" });
    const [connectionResponse, sessionResponse, taskResponse] = await Promise.all([
      api<{ items: SftpConnection[] }>(`/api/v1/connections?${query.toString()}`),
      props.localExecution ? listDesktopSshSessions() : api<{ items: SshSession[] }>("/api/v1/ssh-sessions"),
      props.localExecution ? listDesktopSftpTransfers() : api<{ items: SftpTransferTask[] }>("/api/v1/sftp-transfers"),
    ]);
    connections.value = props.localExecution ? [localConnection.value, ...connectionResponse.items] : connectionResponse.items;
    const visibleIds = new Set(connections.value.map((connection) => connection.id));
    sessions.value = sessionResponse.items.filter((session) => visibleIds.has(session.connectionId));
    tasks.value = taskResponse.items;
    const recommendedIds = new Set(connections.value.filter((connection) => connection.environmentIds.includes(props.environmentId ?? "")).map((connection) => connection.id));
    const requestedConnectionId = props.openRequest?.connectionId ?? props.initialConnectionId;
    const preferred = requestedConnectionId && visibleIds.has(requestedConnectionId)
      ? requestedConnectionId
      : sessions.value.find((session) => recommendedIds.has(session.connectionId))?.connectionId
        ?? connections.value.find((connection) => recommendedIds.has(connection.id))?.id
        ?? sessions.value[0]?.connectionId
        ?? connections.value[0]?.id
        ?? "";
    if (!visibleIds.has(leftConnectionId.value)) leftConnectionId.value = preferred;
    if (!visibleIds.has(rightConnectionId.value)) rightConnectionId.value = "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载 SFTP 工作台失败"));
  } finally {
    loading.value = false;
  }
}

async function loadTasks() {
  try {
    const response = props.localExecution
      ? await listDesktopSftpTransfers()
      : await api<{ items: SftpTransferTask[] }>("/api/v1/sftp-transfers");
    const previous = new Map(tasks.value.map((task) => [task.id, task.status]));
    tasks.value = response.items;
    for (const task of response.items) {
      if (task.status !== "success" || previous.get(task.id) === "success") continue;
      if (task.targetConnectionId === leftConnectionId.value) void leftPane.value?.reload();
      if (task.targetConnectionId === rightConnectionId.value) void rightPane.value?.reload();
    }
  } catch {
    // A transient polling failure should not interrupt an active transfer.
  }
}

async function pollTasks() {
  await loadTasks();
  pollTimer = window.setTimeout(() => void pollTasks(), activeTaskCount.value ? 1000 : 4000);
}

async function prepareTransfer(
  direction: PendingTransfer["direction"],
  options?: { sourceItems?: import("../sftp").SftpItem[]; targetDirectory?: string },
) {
  const sourceState = direction === "left-to-right" ? leftState.value : rightState.value;
  const targetState = direction === "left-to-right" ? rightState.value : leftState.value;
  const sourceConnection = direction === "left-to-right" ? leftConnection.value : rightConnection.value;
  const targetConnection = direction === "left-to-right" ? rightConnection.value : leftConnection.value;
  const sourceItems = options?.sourceItems ?? sourceState.selectedItems;
  if (!sourceConnection || !targetConnection || !sourceItems.length || transferPreparing.value) return;
  if (sourceItems.some((item) => item.type === "symlink")) {
    ElMessage.warning(tr("暂不支持传输符号链接"));
    return;
  }
  await prepareTransferPaths({
    direction,
    sourceConnection,
    targetConnection,
    sourcePaths: sourceItems.map((item) => item.path),
    targetDirectory: options?.targetDirectory ?? targetState.path,
  });
}

async function prepareTransferPaths(input: {
  direction: PendingTransfer["direction"];
  sourceConnection: SftpConnection;
  targetConnection: SftpConnection;
  sourcePaths: string[];
  targetDirectory: string;
}) {
  if (!input.sourcePaths.length || transferPreparing.value) return;
  transferPreparing.value = true;
  try {
    const request = {
      sourceConnectionId: input.sourceConnection.id,
      targetConnectionId: input.targetConnection.id,
      sourcePaths: input.sourcePaths,
      targetDirectory: input.targetDirectory,
    };
    const preview = props.localExecution
      ? await previewDesktopSftpTransfer(request) as TransferPreview
      : await api<TransferPreview>("/api/v1/sftp-transfers/preview", {
          method: "POST",
          body: JSON.stringify(request),
        });
    pendingTransfer.value = {
      kind: "transfer",
      direction: input.direction,
      sourceConnection: input.sourceConnection,
      targetConnection: input.targetConnection,
      sourcePaths: request.sourcePaths,
      targetDirectory: request.targetDirectory,
      preview,
    };
    conflictIndex.value = 0;
    conflictDecisions.value = {};
    applyConflictToAll.value = false;
    if (preview.conflicts.length) transferDialogOpen.value = true;
    else await createTransfer();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法检查传输内容"));
  } finally {
    transferPreparing.value = false;
  }
}

function entryFile(entry: BrowserFileSystemEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function directoryEntries(entry: BrowserFileSystemEntry): Promise<BrowserFileSystemEntry[]> {
  const reader = entry.createReader();
  const collected: BrowserFileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const read = () => reader.readEntries((entries) => {
      if (!entries.length) {
        resolve(collected);
        return;
      }
      collected.push(...entries);
      read();
    }, reject);
    read();
  });
}

async function flattenDroppedEntry(entry: BrowserFileSystemEntry, parent = ""): Promise<BrowserUploadEntry[]> {
  const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await entryFile(entry);
    return [{ relativePath, type: "file", size: file.size, file }];
  }
  if (!entry.isDirectory) return [];
  const children = await directoryEntries(entry);
  const nested = await Promise.all(children.map((child) => flattenDroppedEntry(child, relativePath)));
  return [{ relativePath, type: "directory", size: 0 }, ...nested.flat()];
}

async function droppedUploadEntries(dataTransfer: DataTransfer): Promise<BrowserUploadEntry[]> {
  const entryItems = Array.from(dataTransfer.items).map((item) => {
    const withEntry = item as DataTransferItem & { webkitGetAsEntry?: () => BrowserFileSystemEntry | null };
    return withEntry.webkitGetAsEntry?.() ?? null;
  }).filter(Boolean) as unknown as BrowserFileSystemEntry[];
  const entries = entryItems.length
    ? (await Promise.all(entryItems.map((entry) => flattenDroppedEntry(entry)))).flat()
    : Array.from(dataTransfer.files).map((file) => ({
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        type: "file" as const,
        size: file.size,
        file,
      }));
  return [...new Map(entries.map((entry) => [entry.relativePath, entry])).values()];
}

function sftpJoin(directory: string, relativePath: string): string {
  return `${directory.replace(/\/$/, "")}/${relativePath}`.replace(/\/{2,}/g, "/") || "/";
}

async function prepareBrowserUpload(targetSide: "left" | "right", payload: { dataTransfer: DataTransfer; targetDirectory: string }) {
  const targetConnection = targetSide === "left" ? leftConnection.value : rightConnection.value;
  if (!targetConnection || transferPreparing.value) return;
  transferPreparing.value = true;
  try {
    const entries = await droppedUploadEntries(payload.dataTransfer);
    if (!entries.length) throw new Error(tr("未识别到可上传的文件或目录"));
    const request = {
      targetDirectory: payload.targetDirectory,
      entries: entries.map(({ relativePath, type, size }) => ({ relativePath, type, size })),
    };
    const preview = await api<TransferPreview>(`/api/v1/ssh-connections/${targetConnection.id}/sftp/upload-preview`, {
      method: "POST",
      body: JSON.stringify(request),
    });
    pendingTransfer.value = {
      kind: "upload",
      direction: targetSide === "left" ? "right-to-left" : "left-to-right",
      sourceConnection: localConnection.value,
      targetConnection,
      sourcePaths: preview.sourcePaths,
      targetDirectory: payload.targetDirectory,
      preview,
      uploadEntries: entries,
    };
    conflictIndex.value = 0;
    conflictDecisions.value = {};
    applyConflictToAll.value = false;
    if (preview.conflicts.length) transferDialogOpen.value = true;
    else await createTransfer();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法检查上传内容"));
  } finally {
    transferPreparing.value = false;
  }
}

async function executeBrowserUpload(pending: PendingTransfer): Promise<void> {
  const entries = pending.uploadEntries ?? [];
  const manifest = entries.map(({ relativePath, type, size }) => ({ relativePath, type, size }));
  const prepared = await api<{ skippedDirectories: string[] }>(`/api/v1/ssh-connections/${pending.targetConnection.id}/sftp/upload-directories`, {
    method: "POST",
    body: JSON.stringify({ targetDirectory: pending.targetDirectory, entries: manifest, conflictDecisions: conflictDecisions.value }),
  });
  let uploadedFiles = 0;
  let skippedFiles = 0;
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.file) continue;
    if (prepared.skippedDirectories.some((prefix) => entry.relativePath.startsWith(`${prefix}/`))) {
      skippedFiles += 1;
      continue;
    }
    const targetPath = sftpJoin(pending.targetDirectory, entry.relativePath);
    if (conflictDecisions.value[targetPath] === "skip") {
      skippedFiles += 1;
      continue;
    }
    const separator = entry.relativePath.lastIndexOf("/");
    const relativeDirectory = separator < 0 ? "" : entry.relativePath.slice(0, separator);
    const filename = separator < 0 ? entry.relativePath : entry.relativePath.slice(separator + 1);
    const formData = new FormData();
    formData.append("file", entry.file, filename);
    const query = new URLSearchParams({
      path: relativeDirectory ? sftpJoin(pending.targetDirectory, relativeDirectory) : pending.targetDirectory,
      filename,
      conflict: conflictDecisions.value[targetPath] === "overwrite" ? "overwrite" : "skip",
    });
    const uploaded = await api<{ skipped?: boolean }>(`/api/v1/ssh-connections/${pending.targetConnection.id}/sftp/upload?${query.toString()}`, { method: "POST", body: formData });
    if (uploaded.skipped) skippedFiles += 1;
    else uploadedFiles += 1;
  }
  if (pending.direction === "left-to-right") await rightPane.value?.reload();
  else await leftPane.value?.reload();
  ElMessage.success(skippedFiles ? tr("上传完成：{0} 个文件，跳过 {1} 个", [uploadedFiles, skippedFiles]) : tr("上传完成：{0} 个文件", [uploadedFiles]));
}

async function createTransfer() {
  const pending = pendingTransfer.value;
  if (!pending || transferStarting.value) return;
  transferStarting.value = true;
  try {
    if (pending.kind === "upload") {
      await executeBrowserUpload(pending);
      transferDialogOpen.value = false;
      pendingTransfer.value = null;
      return;
    }
    const input = {
      sourceConnectionId: pending.sourceConnection.id,
      targetConnectionId: pending.targetConnection.id,
      sourcePaths: pending.sourcePaths,
      targetDirectory: pending.targetDirectory,
      conflict: "skip" as const,
      conflictDecisions: conflictDecisions.value,
      originEnvironmentId: props.environmentId,
    };
    const response = props.localExecution
      ? await createDesktopSftpTransfer(input)
      : await api<{ task: SftpTransferTask; activeConnectionId?: string }>("/api/v1/sftp-transfers", {
          method: "POST",
          body: JSON.stringify(input),
        });
    rememberActiveConnectionOrigin(response.activeConnectionId ?? response.task.id, props.environmentId);
    transferDialogOpen.value = false;
    pendingTransfer.value = null;
    tasksExpanded.value = true;
    ElMessage.success(tr("传输任务已在后台开始"));
    await loadTasks();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法开始传输"));
  } finally {
    transferStarting.value = false;
  }
}

function cancelPendingTransfer() {
  transferDialogOpen.value = false;
  pendingTransfer.value = null;
  conflictIndex.value = 0;
  conflictDecisions.value = {};
  applyConflictToAll.value = false;
}

async function resolveCurrentConflict(decision: SftpConflictDecision) {
  const pending = pendingTransfer.value;
  const current = currentConflict.value;
  if (!pending || !current || transferStarting.value) return;
  if (applyConflictToAll.value) {
    for (const conflict of pending.preview.conflicts.slice(conflictIndex.value)) conflictDecisions.value[conflict.targetPath] = decision;
    await createTransfer();
    return;
  }
  conflictDecisions.value[current.targetPath] = decision;
  if (conflictIndex.value < pending.preview.conflicts.length - 1) {
    conflictIndex.value += 1;
    return;
  }
  await createTransfer();
}

function handleTransferDrop(
  targetSide: "left" | "right",
  payload: { sourceConnectionId: string; sourceSide: "left" | "right"; items: import("../sftp").SftpItem[]; targetDirectory: string },
) {
  if (payload.sourceSide === targetSide) return;
  const direction: PendingTransfer["direction"] = payload.sourceSide === "left" ? "left-to-right" : "right-to-left";
  void prepareTransfer(direction, { sourceItems: payload.items, targetDirectory: payload.targetDirectory });
}

function rememberDrag(payload: { connectionId: string; items: import("../sftp").SftpItem[] }) {
  activeDrag.value = payload;
}

function clearDrag() {
  activeDrag.value = null;
}

function startNativeDragAtBoundary(event: DragEvent) {
  if (!props.localExecution || !activeDrag.value || nativeDragPreparing.value) return;
  const atWindowEdge = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth - 1 || event.clientY >= window.innerHeight - 1;
  if (!atWindowEdge) return;
  const drag = activeDrag.value;
  nativeDragPreparing.value = true;
  ElMessage.info(tr("正在准备拖出内容，请保持拖动"));
  void startDesktopSftpDrag({ connectionId: drag.connectionId, paths: drag.items.map((item) => item.path) })
    .catch((error) => ElMessage.error(error instanceof Error ? error.message : tr("无法拖出 SFTP 文件")))
    .finally(() => { nativeDragPreparing.value = false; });
}

function handleWorkspaceDragLeave(event: DragEvent) {
  const workspace = event.currentTarget as HTMLElement | null;
  if (workspace && event.relatedTarget instanceof Node && workspace.contains(event.relatedTarget)) return;
  startNativeDragAtBoundary(event);
}

function handleExternalDrop(targetSide: "left" | "right", payload: { dataTransfer: DataTransfer; targetDirectory: string }) {
  if (!props.localExecution) {
    void prepareBrowserUpload(targetSide, payload);
    return;
  }
  const targetConnection = targetSide === "left" ? leftConnection.value : rightConnection.value;
  if (!targetConnection) return;
  const sourcePaths = Array.from(payload.dataTransfer.files).map((file) => desktopDroppedFilePath(file)).filter(Boolean);
  if (!sourcePaths.length) {
    ElMessage.warning(tr("未识别到可上传的文件或目录"));
    return;
  }
  if (isLocalSftpConnection(targetConnection)) {
    ElMessage.warning(tr("本机文件请直接使用 Finder 或资源管理器移动"));
    return;
  }
  void prepareTransferPaths({
    direction: targetSide === "left" ? "right-to-left" : "left-to-right",
    sourceConnection: localConnection.value,
    targetConnection,
    sourcePaths,
    targetDirectory: payload.targetDirectory,
  });
}

async function cancelTask(task: SftpTransferTask) {
  try {
    if (props.localExecution) await cancelDesktopSftpTransfer(task.id);
    else await api(`/api/v1/sftp-transfers/${task.id}`, { method: "DELETE" });
    await loadTasks();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法取消传输"));
  }
}

async function retryTask(task: SftpTransferTask) {
  try {
    const response = props.localExecution
      ? await retryDesktopSftpTransfer(task.id, props.environmentId)
      : await api<{ task: SftpTransferTask; activeConnectionId?: string }>(`/api/v1/sftp-transfers/${task.id}/retry`, {
          method: "POST",
          body: JSON.stringify({ originEnvironmentId: props.environmentId }),
        });
    rememberActiveConnectionOrigin(response.activeConnectionId ?? response.task.id, props.environmentId);
    tasksExpanded.value = true;
    ElMessage.success(tr("传输任务已重新开始"));
    await loadTasks();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法重试传输"));
  }
}

function statusLabel(status: SftpTransferTask["status"]): string {
  return { pending: tr("等待中"), running: tr("传输中"), success: tr("已完成"), error: tr("失败"), cancelled: tr("已取消") }[status];
}

function statusIcon(status: SftpTransferTask["status"]) {
  return status === "success" ? CheckCircle2 : status === "error" ? XCircle : status === "cancelled" ? Ban : status === "running" ? RefreshCw : Clock3;
}

watch(() => props.openRequest?.requestId, () => {
  const connectionId = props.openRequest?.connectionId;
  if (connectionId && connectionById.value.has(connectionId)) leftConnectionId.value = connectionId;
});
watch(() => props.localExecution, () => { void loadWorkspace(); });

onMounted(() => {
  void loadWorkspace();
  pollTimer = window.setTimeout(() => void pollTasks(), 1000);
  document.addEventListener("dragover", startNativeDragAtBoundary);
  document.addEventListener("dragend", clearDrag);
});
onBeforeUnmount(() => {
  window.clearTimeout(pollTimer);
  document.removeEventListener("dragover", startNativeDragAtBoundary);
  document.removeEventListener("dragend", clearDrag);
});
</script>

<template>
  <section class="sftp-workspace" :class="{ 'is-drawer': drawer }" v-loading="loading" @dragleave="handleWorkspaceDragLeave">
    <header class="sftp-workspace__header">
      <div class="sftp-workspace__title">
        <span><FolderSync :size="19" /></span>
        <div class="heading-with-tip"><strong>{{ $t('SFTP 文件传输') }}</strong><TipIcon :content="$t('传输任务在后台运行，切换工作区不会中断。')" placement="right" /></div>
      </div>
      <div class="sftp-workspace__header-actions">
        <div class="sftp-workspace__legend"><i></i>{{ activeTaskCount ? $t('{0} 个后台任务运行中', [activeTaskCount]) : $t('等待传输') }}</div>
        <button v-if="drawer" type="button" class="sftp-drawer-close" :aria-label="$t('关闭 SFTP 抽屉')" :title="$t('关闭 SFTP')" @click="emit('close')"><X :size="16" /></button>
      </div>
    </header>

    <div class="sftp-dual-pane">
      <SftpPanel ref="leftPane" side="left" :connection="leftConnection" :current-session="Boolean(leftConnection && isCurrentSession(leftConnection.id))" :open-request="openRequest" :local-execution="localExecution" @choose-connection="openPicker('left')" @state="updatePaneState('left', $event)" @transfer-drop="handleTransferDrop('left', $event)" @external-drop="handleExternalDrop('left', $event)" @drag-start="rememberDrag" @drag-end="clearDrag" />

      <aside class="sftp-transfer-rail" :aria-label="$t('主机间传输方向')">
        <span class="sftp-transfer-rail__line"></span>
        <div>
          <button type="button" :disabled="!leftState.selectedItems.length || !rightConnection || transferPreparing" :title="leftState.selectedItems.length ? $t('复制已选 {0} 项到右侧当前目录', [leftState.selectedItems.length]) : $t('请先选择左侧文件或目录')" @click="prepareTransfer('left-to-right')"><ArrowRight :size="17" /><small>{{ $t('传到右侧') }}</small></button>
          <button type="button" :disabled="!rightState.selectedItems.length || !leftConnection || transferPreparing" :title="rightState.selectedItems.length ? $t('复制已选 {0} 项到左侧当前目录', [rightState.selectedItems.length]) : $t('请先选择右侧文件或目录')" @click="prepareTransfer('right-to-left')"><ArrowLeft :size="17" /><small>{{ $t('传到左侧') }}</small></button>
        </div>
        <span class="sftp-transfer-rail__line"></span>
      </aside>

      <SftpPanel ref="rightPane" side="right" :connection="rightConnection" :current-session="Boolean(rightConnection && isCurrentSession(rightConnection.id))" :local-execution="localExecution" @choose-connection="openPicker('right')" @state="updatePaneState('right', $event)" @transfer-drop="handleTransferDrop('right', $event)" @external-drop="handleExternalDrop('right', $event)" @drag-start="rememberDrag" @drag-end="clearDrag" />
    </div>

    <section class="sftp-task-dock" :class="{ 'is-expanded': tasksExpanded }">
      <button type="button" class="sftp-task-dock__toggle" :aria-expanded="tasksExpanded" @click="tasksExpanded = !tasksExpanded">
        <span><FolderSync :size="15" /><strong>{{ $t('传输任务') }}</strong><em v-if="activeTaskCount">{{ activeTaskCount }} {{ $t('进行中') }}</em><small v-else>{{ tasks.length ? $t('最近 {0} 项', [tasks.length]) : $t('暂无任务') }}</small></span>
        <ChevronDown v-if="!tasksExpanded" :size="16" /><ChevronUp v-else :size="16" />
      </button>
      <div v-if="tasksExpanded" class="sftp-task-list">
        <article v-for="task in tasks.slice(0, 20)" :key="task.id" class="sftp-task" :class="`is-${task.status}`">
          <span class="sftp-task__status"><component :is="statusIcon(task.status)" :size="16" :class="{ 'is-spinning': task.status === 'running' }" /></span>
          <div class="sftp-task__main">
            <div><strong>{{ task.sourceConnectionName }}</strong><ArrowRight :size="12" /><strong>{{ task.targetConnectionName }}</strong><code :title="task.sourcePaths?.join('\n') || task.sourcePath">{{ task.sourcePaths?.length > 1 ? $t('{0} 项', [task.sourcePaths.length]) : task.sourcePath.split('/').pop() }}</code></div>
            <span><i :style="{ width: `${task.progress}%` }"></i></span>
          </div>
          <div class="sftp-task__metrics">
            <strong>{{ statusLabel(task.status) }} · {{ task.progress }}%</strong>
            <small v-if="task.status === 'running'">{{ formatFileSize(task.transferredBytes) }} / {{ formatFileSize(task.totalBytes) }} · {{ formatFileSize(task.speedBytesPerSecond) }}/s</small>
            <small v-else-if="task.status === 'success'">{{ task.completedFiles }} {{ $t('个文件') }}<span v-if="task.skippedFiles"> {{ $t('· 跳过') }} {{ task.skippedFiles }}</span></small>
            <small v-else-if="task.error" :title="task.error">{{ task.error }}</small>
          </div>
          <div class="sftp-task__actions">
            <button v-if="task.status === 'pending' || task.status === 'running'" type="button" @click="cancelTask(task)">{{ $t('取消') }}</button>
            <button v-else-if="task.status === 'error' || task.status === 'cancelled'" type="button" @click="retryTask(task)"><RefreshCw :size="12" />{{ $t('重试') }}</button>
          </div>
        </article>
        <div v-if="!tasks.length" class="sftp-task-list__empty"><Clock3 :size="18" />{{ $t('暂无传输任务') }}</div>
      </div>
    </section>

    <el-dialog append-to-body v-model="pickerOpen" align-center width="min(620px, calc(100vw - 28px))" class="envman-dialog sftp-host-picker" :title="$t('为{0}栏选择主机', [pickerSide === 'left' ? $t('来源') : $t('目标')])">
      <el-input v-model="pickerKeyword" clearable :placeholder="$t('搜索连接名称、主机、用户或分组')"><template #prefix><Search :size="15" /></template></el-input>
      <div class="sftp-host-picker__list">
        <section v-if="groupedConnections.recommended.length">
          <header><span>{{ $t('当前环境') }}</span></header>
          <button v-for="connection in groupedConnections.recommended" :key="connection.id" type="button" @click="chooseConnection(connection)"><span><Server :size="16" /></span><div><strong>{{ connection.name }}</strong><small>{{ connectionMeta(connection) }}</small></div><em v-if="isCurrentSession(connection.id)">{{ $t('会话活动') }}</em></button>
        </section>
        <section>
          <header><span>{{ props.environmentId ? $t('其他位置') : $t('可用位置') }}</span></header>
          <button v-for="connection in groupedConnections.others" :key="connection.id" type="button" @click="chooseConnection(connection)"><span><Server :size="16" /></span><div><strong>{{ connection.name }}</strong><small>{{ connectionMeta(connection) }}</small></div><em v-if="isCurrentSession(connection.id)">{{ $t('会话活动') }}</em></button>
        </section>
        <div v-if="!filteredConnections.length" class="sftp-host-picker__empty"><CircleAlert :size="20" />{{ $t('没有匹配的位置') }}</div>
      </div>
      <template #footer><el-button @click="pickerOpen = false">{{ $t('取消') }}</el-button></template>
    </el-dialog>

    <el-dialog append-to-body v-model="transferDialogOpen" align-center width="min(520px, calc(100vw - 28px))" class="envman-dialog sftp-transfer-dialog sftp-conflict-dialog" :title="$t('文件已存在')" :close-on-click-modal="false" @closed="pendingTransfer && cancelPendingTransfer()">
      <template v-if="pendingTransfer && currentConflict">
        <div class="sftp-conflict-message">
          <CircleAlert :size="20" />
          <div>
            <strong>{{ $t('目标位置已存在“{0}”', [currentConflict.targetPath.split('/').pop()]) }}</strong>
            <p>{{ currentConflict.sourceType === currentConflict.targetType ? $t('要使用正在传输的文件替换它吗？') : $t('来源与目标类型不同，覆盖将完整替换目标内容。') }}</p>
            <code>{{ currentConflict.targetPath }}</code>
          </div>
        </div>
        <div class="sftp-conflict-progress">
          <span>{{ $t('冲突 {0} / {1}', [conflictIndex + 1, pendingTransfer.preview.conflicts.length]) }}</span>
          <small>{{ pendingTransfer.sourcePaths.length }} {{ $t('项') }} · {{ pendingTransfer.preview.totalFiles }} {{ $t('个文件') }} · {{ formatFileSize(pendingTransfer.preview.totalBytes) }}</small>
        </div>
        <label v-if="pendingTransfer.preview.conflicts.length > 1" class="sftp-apply-all"><span>{{ $t('应用全部') }}</span><el-switch v-model="applyConflictToAll" /></label>
      </template>
      <template #footer>
        <div class="sftp-conflict-actions">
          <el-button @click="cancelPendingTransfer">{{ $t('取消') }}</el-button>
          <span></span>
          <el-button :disabled="transferStarting" @click="resolveCurrentConflict('skip')">{{ $t('跳过') }}</el-button>
          <el-button type="primary" :loading="transferStarting" @click="resolveCurrentConflict('overwrite')">{{ $t('覆盖') }}</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
