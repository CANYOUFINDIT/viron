<script setup lang="ts">import { currentLocale, translate as tr } from "../i18n";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Search,
  Server,
  Shield,
  Trash2,
  Upload,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, ref, watch } from "vue";
import { api } from "../api";
import { updateSftpSelection } from "../sftp-selection";
import {
  cancelDesktopSftpUpload,
  completeDesktopSftpUpload,
  desktopSftpAction,
  downloadApiFile,
  downloadDesktopSftp,
  isDesktopApp,
  listDesktopSftp,
  startDesktopSftpUpload,
  uploadDesktopSftpChunk,
} from "../desktop";
import {
  formatFileSize,
  isLocalSftpConnection,
  isSftpDirectory,
  sftpOpenPathForConnection,
  type SftpConnection,
  type SftpItem,
  type SftpOpenRequest,
  type SftpPaneState,
} from "../sftp";

const props = defineProps<{
  side: "left" | "right";
  connection: SftpConnection | null;
  currentSession: boolean;
  openRequest?: SftpOpenRequest;
  localExecution?: boolean;
}>();
const emit = defineEmits<{
  chooseConnection: [];
  state: [state: SftpPaneState];
  transferDrop: [payload: { sourceConnectionId: string; sourceSide: "left" | "right"; items: SftpItem[]; targetDirectory: string }];
  externalDrop: [payload: { dataTransfer: DataTransfer; targetDirectory: string }];
  dragStart: [payload: { connectionId: string; items: SftpItem[] }];
  dragEnd: [];
}>();
const desktopApp = isDesktopApp();

const loading = ref(false);
const path = ref("/");
const items = ref<SftpItem[]>([]);
const selectedItems = ref<SftpItem[]>([]);
const selectionAnchorPath = ref("");
const dropTargetPath = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const uploadProgress = ref<number | null>(null);
const pathHistory = ref<string[]>(["/"]);
const historyIndex = ref(0);
const pathEditing = ref(false);
const pathDraft = ref("/");
const pathInput = ref<HTMLInputElement | null>(null);
const filterOpen = ref(false);
const filterKeyword = ref("");
const showHidden = ref(false);
let loadGeneration = 0;
let navigationGeneration = 0;

const visibleItems = computed(() => {
  const keyword = filterKeyword.value.trim().toLowerCase();
  return items.value.filter((item) => {
    if (!showHidden.value && item.name.startsWith(".")) return false;
    return !keyword || item.name.toLowerCase().includes(keyword);
  });
});
const breadcrumbs = computed(() => {
  const parts = path.value.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...parts.map((label, index) => ({ label, path: `/${parts.slice(0, index + 1).join("/")}` })),
  ];
});
const localConnection = computed(() => isLocalSftpConnection(props.connection));
const selectedPathSet = computed(() => new Set(selectedItems.value.map((item) => item.path)));
const selected = computed(() => selectedItems.value.length === 1 ? selectedItems.value[0] : null);

function publishState() {
  emit("state", {
    connectionId: props.connection?.id ?? "",
    path: path.value,
    selectedItems: selectedItems.value,
  });
}

function clearSelection() {
  selectedItems.value = [];
  selectionAnchorPath.value = "";
  publishState();
}

async function load(target = path.value, recordHistory = true, notifyError = true): Promise<boolean> {
  const connection = props.connection;
  if (!connection) return false;
  const generation = ++loadGeneration;
  loading.value = true;
  selectedItems.value = [];
  selectionAnchorPath.value = "";
  publishState();
  try {
    const response = props.localExecution
      ? await listDesktopSftp(connection.id, target)
      : await api<{ path: string; parentPath: string | null; items: SftpItem[] }>(
          `/api/v1/ssh-connections/${connection.id}/sftp?path=${encodeURIComponent(target)}`,
        );
    if (generation !== loadGeneration || props.connection?.id !== connection.id) return false;
    path.value = response.path;
    items.value = response.items;
    if (recordHistory && pathHistory.value[historyIndex.value] !== response.path) {
      pathHistory.value = [...pathHistory.value.slice(0, historyIndex.value + 1), response.path];
      historyIndex.value = pathHistory.value.length - 1;
    }
    return true;
  } catch (error) {
    if (generation !== loadGeneration || props.connection?.id !== connection.id) return false;
    if (notifyError) ElMessage.error(error instanceof Error ? error.message : localConnection.value ? tr("读取本机目录失败") : tr("读取远程目录失败"));
    return false;
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
      publishState();
    }
  }
}

async function resetAndLoadInitialPath(connectionId: string | undefined) {
  const generation = ++navigationGeneration;
  loadGeneration += 1;
  path.value = "/";
  items.value = [];
  selectedItems.value = [];
  selectionAnchorPath.value = "";
  pathHistory.value = ["/"];
  historyIndex.value = 0;
  pathEditing.value = false;
  pathDraft.value = "/";
  filterKeyword.value = "";
  publishState();
  if (!connectionId) return;

  const target = sftpOpenPathForConnection(props.openRequest, connectionId);
  const loaded = await load(target, true, target === "/");
  if (generation !== navigationGeneration || props.connection?.id !== connectionId || loaded || target === "/") return;
  ElMessage.warning(tr("无法进入终端当前目录，已回退到默认目录"));
  await load("/");
}

async function navigateHistory(offset: -1 | 1) {
  const nextIndex = historyIndex.value + offset;
  const target = pathHistory.value[nextIndex];
  if (target === undefined) return;
  if (await load(target, false)) historyIndex.value = nextIndex;
}

async function startPathEditing() {
  pathDraft.value = path.value;
  pathEditing.value = true;
  await nextTick();
  pathInput.value?.focus();
  pathInput.value?.select();
}

async function submitPath() {
  const target = pathDraft.value.trim();
  if (!target) return;
  if (await load(target)) pathEditing.value = false;
}

function cancelPathEditing() {
  pathEditing.value = false;
  pathDraft.value = path.value;
}

function selectItem(item: SftpItem, event?: Pick<MouseEvent | KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey">) {
  const result = updateSftpSelection(visibleItems.value, selectedItems.value, selectionAnchorPath.value, item, event);
  selectedItems.value = result.selectedItems;
  selectionAnchorPath.value = result.anchorPath;
  publishState();
}

function dragItemsFor(item: SftpItem): SftpItem[] {
  if (selectedPathSet.value.has(item.path)) return selectedItems.value;
  selectedItems.value = [item];
  selectionAnchorPath.value = item.path;
  publishState();
  return [item];
}

function startItemDrag(item: SftpItem, event: DragEvent) {
  if (!props.connection || !event.dataTransfer) return;
  const dragItems = dragItemsFor(item);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-viron-sftp-items", JSON.stringify({
    connectionId: props.connection.id,
    side: props.side,
    items: dragItems,
  }));
  event.dataTransfer.setData("text/plain", dragItems.map((candidate) => candidate.name).join("\n"));
  emit("dragStart", { connectionId: props.connection.id, items: dragItems });
  if (dragItems.length === 1 && !isSftpDirectory(dragItems[0]) && !props.localExecution && props.connection.type === "ssh") {
    const url = `${window.location.origin}/api/v1/ssh-connections/${props.connection.id}/sftp/download?path=${encodeURIComponent(dragItems[0].path)}`;
    event.dataTransfer.setData("DownloadURL", `application/octet-stream:${dragItems[0].name}:${url}`);
  }
}

function endItemDrag() {
  dropTargetPath.value = "";
  emit("dragEnd");
}

function targetDirectoryFor(item?: SftpItem): string {
  return item && isSftpDirectory(item) ? item.path : path.value;
}

function supportsDrop(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types);
  return types.includes("application/x-viron-sftp-items") || types.includes("Files");
}

function dragOver(item: SftpItem | undefined, event: DragEvent) {
  if (!props.connection || !supportsDrop(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  dropTargetPath.value = targetDirectoryFor(item);
}

function leaveDropTarget(event: DragEvent) {
  const current = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  if (!current || !next || !current.contains(next)) dropTargetPath.value = "";
}

function dropItems(item: SftpItem | undefined, event: DragEvent) {
  if (!props.connection || !event.dataTransfer || !supportsDrop(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  const targetDirectory = targetDirectoryFor(item);
  const encoded = event.dataTransfer.getData("application/x-viron-sftp-items");
  dropTargetPath.value = "";
  if (encoded) {
    try {
      const payload = JSON.parse(encoded) as { connectionId: string; side: "left" | "right"; items: SftpItem[] };
      emit("transferDrop", { sourceConnectionId: payload.connectionId, sourceSide: payload.side, items: payload.items, targetDirectory });
      return;
    } catch {
      ElMessage.error(tr("无法识别拖动的 SFTP 文件"));
      return;
    }
  }
  emit("externalDrop", { dataTransfer: event.dataTransfer, targetDirectory });
}

async function openItem(item: SftpItem) {
  if (isSftpDirectory(item)) await load(item.path);
}

async function createDirectory() {
  if (!props.connection) return;
  try {
    const result = await ElMessageBox.prompt(tr("请输入目录名称"), tr("新建远程目录"), {
      confirmButtonText: tr("创建"),
      cancelButtonText: tr("取消"),
      inputPattern: /^[^/\\\0]+$/,
      inputErrorMessage: tr("目录名称不能包含路径分隔符"),
    });
    const targetPath = `${path.value.replace(/\/$/, "")}/${result.value}`;
    if (props.localExecution) await desktopSftpAction({ type: "mkdir", connectionId: props.connection.id, path: targetPath });
    else await api(`/api/v1/ssh-connections/${props.connection.id}/sftp/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path: targetPath }),
    });
    ElMessage.success(tr("目录已创建"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("创建目录失败"));
  }
}

async function renameItem(item: SftpItem) {
  if (!props.connection) return;
  try {
    const result = await ElMessageBox.prompt(tr("请输入新名称"), tr("重命名 {0}", [item.name]), {
      confirmButtonText: tr("保存"),
      cancelButtonText: tr("取消"),
      inputValue: item.name,
      inputPattern: /^[^/\\\0]+$/,
      inputErrorMessage: tr("名称不能包含路径分隔符"),
    });
    const directory = item.path.slice(0, item.path.lastIndexOf("/")) || "/";
    const newPath = `${directory.replace(/\/$/, "")}/${result.value}`;
    if (props.localExecution) await desktopSftpAction({ type: "rename", connectionId: props.connection.id, path: item.path, newPath });
    else await api(`/api/v1/ssh-connections/${props.connection.id}/sftp/rename`, {
      method: "POST",
      body: JSON.stringify({ path: item.path, newPath }),
    });
    ElMessage.success(tr("名称已更新"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("重命名失败"));
  }
}

async function chmodItem(item: SftpItem) {
  if (!props.connection) return;
  try {
    const result = await ElMessageBox.prompt(tr("请输入 Unix 权限，例如 640 或 0755"), tr("修改权限 · {0}", [item.name]), {
      confirmButtonText: tr("保存"),
      cancelButtonText: tr("取消"),
      inputValue: item.mode,
      inputPattern: /^[0-7]{3,4}$/,
      inputErrorMessage: tr("请输入 3 或 4 位八进制权限"),
    });
    if (props.localExecution) await desktopSftpAction({ type: "chmod", connectionId: props.connection.id, path: item.path, mode: result.value });
    else await api(`/api/v1/ssh-connections/${props.connection.id}/sftp/chmod`, {
      method: "POST",
      body: JSON.stringify({ path: item.path, mode: result.value }),
    });
    ElMessage.success(tr("权限已更新"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("修改权限失败"));
  }
}

async function deleteItem(item: SftpItem) {
  if (!props.connection) return;
  try {
    const kind = item.type === "symlink" ? tr("符号链接") : isSftpDirectory(item) ? tr("空目录") : tr("文件");
    await ElMessageBox.confirm(tr("确定删除{0}“{1}”吗？", [kind, item.name]), tr("删除远程资源"), {
      confirmButtonText: tr("删除"),
      cancelButtonText: tr("取消"),
      type: "warning",
    });
    if (props.localExecution) await desktopSftpAction({ type: "delete", connectionId: props.connection.id, path: item.path });
    else await api(`/api/v1/ssh-connections/${props.connection.id}/sftp`, {
      method: "DELETE",
      body: JSON.stringify({ path: item.path }),
    });
    ElMessage.success(tr("远程资源已删除"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除失败"));
  }
}

async function downloadItem(item: SftpItem) {
  if (!props.connection || isSftpDirectory(item)) return;
  try {
    if (props.localExecution) await downloadDesktopSftp({ connectionId: props.connection.id, path: item.path, filename: item.name });
    else await downloadApiFile(`/api/v1/ssh-connections/${props.connection.id}/sftp/download?path=${encodeURIComponent(item.path)}`, item.name);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("下载失败"));
  }
}

async function uploadDesktopFile(connectionId: string, file: globalThis.File) {
  let uploadId = "";
  try {
    const started = await startDesktopSftpUpload({ connectionId, directory: path.value, filename: file.name });
    uploadId = started.uploadId;
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const end = Math.min(file.size, offset + chunkSize);
      await uploadDesktopSftpChunk(uploadId, await file.slice(offset, end).arrayBuffer());
      uploadProgress.value = file.size ? Math.round((end / file.size) * 100) : 100;
    }
    await completeDesktopSftpUpload(uploadId);
    uploadId = "";
    ElMessage.success(tr("文件上传完成"));
    await load();
  } catch (error) {
    if (uploadId) await cancelDesktopSftpUpload(uploadId).catch(() => undefined);
    ElMessage.error(error instanceof Error ? error.message : tr("文件上传失败"));
  } finally {
    uploadProgress.value = null;
  }
}

function uploadFile(file: globalThis.File) {
  if (!props.connection) return;
  const connectionId = props.connection.id;
  uploadProgress.value = 0;
  if (props.localExecution) {
    void uploadDesktopFile(connectionId, file);
    return;
  }
  const formData = new FormData();
  formData.append("file", file);
  if (desktopApp) {
    void api(`/api/v1/ssh-connections/${connectionId}/sftp/upload?path=${encodeURIComponent(path.value)}`, { method: "POST", body: formData })
      .then(async () => { ElMessage.success(tr("文件上传完成")); await load(); })
      .catch((error) => ElMessage.error(error instanceof Error ? error.message : tr("文件上传失败")))
      .finally(() => { uploadProgress.value = null; });
    return;
  }
  const request = new XMLHttpRequest();
  request.open("POST", `/api/v1/ssh-connections/${connectionId}/sftp/upload?path=${encodeURIComponent(path.value)}`);
  request.setRequestHeader("Accept-Language", currentLocale());
  request.upload.addEventListener("progress", (event) => {
    if (event.lengthComputable) uploadProgress.value = Math.round((event.loaded / event.total) * 100);
  });
  request.addEventListener("load", async () => {
    uploadProgress.value = null;
    if (request.status >= 200 && request.status < 300) {
      ElMessage.success(tr("文件上传完成"));
      await load();
      return;
    }
    try {
      const body = JSON.parse(request.responseText || "{}") as { message?: string };
      ElMessage.error(body.message ?? tr("文件上传失败"));
    } catch {
      ElMessage.error(tr("文件上传失败"));
    }
  });
  request.addEventListener("error", () => {
    uploadProgress.value = null;
    ElMessage.error(tr("文件上传失败"));
  });
  request.send(formData);
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) uploadFile(file);
  target.value = "";
}

function handleAction(command: string) {
  const item = selected.value;
  if (command === "open" && item) void openItem(item);
  else if (command === "download" && item && !isSftpDirectory(item)) downloadItem(item);
  else if (command === "upload") fileInput.value?.click();
  else if (command === "rename" && item) void renameItem(item);
  else if (command === "delete" && item) void deleteItem(item);
  else if (command === "refresh") void load();
  else if (command === "mkdir") void createDirectory();
  else if (command === "hidden") showHidden.value = !showHidden.value;
  else if (command === "chmod" && item) void chmodItem(item);
  else if (command === "clear") clearSelection();
}

watch([() => props.connection?.id, () => props.openRequest?.requestId], ([connectionId]) => {
  void resetAndLoadInitialPath(connectionId);
}, { immediate: true });

defineExpose({ reload: () => load() });
</script>

<template>
  <section class="sftp-pane" :class="[`is-${side}`, { 'has-upload-progress': uploadProgress !== null, 'is-drop-target': dropTargetPath === path }]" @dragleave="leaveDropTarget">
    <header class="sftp-pane__toolbar">
      <button type="button" class="sftp-host-select" :title="connection ? localConnection ? $t('当前电脑文件系统') : `${connection.username}@${connection.host}:${connection.port}` : $t('选择位置')" @click="emit('chooseConnection')">
        <span class="sftp-pane__host-icon" :class="{ 'is-empty': !connection }"><Server :size="16" /></span>
        <span><strong>{{ connection?.name || $t('选择主机') }}</strong><small v-if="currentSession">{{ $t('活动') }}</small></span>
        <ChevronDown :size="14" />
      </button>
      <div v-if="connection" class="sftp-pane__toolbar-actions">
        <span v-if="selectedItems.length > 1" class="sftp-selection-count">{{ $t('已选 {0} 项', [selectedItems.length]) }}</span>
        <button type="button" class="sftp-filter-toggle" :class="{ 'is-active': filterOpen || filterKeyword }" :aria-label="$t('筛选文件')" :aria-expanded="filterOpen" @click="filterOpen = !filterOpen"><Search :size="14" /><span>{{ $t('筛选') }}</span></button>
        <el-dropdown trigger="click" placement="bottom-end" popper-class="sftp-actions-popper" @command="handleAction">
          <button type="button" class="sftp-actions-trigger">{{ $t('操作') }}<ChevronDown :size="14" /></button>
          <template #dropdown>
            <el-dropdown-menu class="sftp-actions-menu">
              <el-dropdown-item command="open" :disabled="!selected || !isSftpDirectory(selected)"><FolderOpen :size="14" />{{ $t('打开') }}</el-dropdown-item>
              <el-dropdown-item command="download" :disabled="!selected || isSftpDirectory(selected)"><Download :size="14" />{{ $t('下载') }}</el-dropdown-item>
              <el-dropdown-item command="upload"><Upload :size="14" />{{ $t('上传文件') }}</el-dropdown-item>
              <el-dropdown-item command="rename" :disabled="!selected"><Pencil :size="14" />{{ $t('重命名') }}</el-dropdown-item>
              <el-dropdown-item command="delete" :disabled="!selected"><Trash2 :size="14" />{{ $t('删除') }}</el-dropdown-item>
              <el-dropdown-item command="refresh" divided><RefreshCw :size="14" />{{ $t('刷新') }}</el-dropdown-item>
              <el-dropdown-item command="mkdir"><FolderPlus :size="14" />{{ $t('新建目录') }}</el-dropdown-item>
              <el-dropdown-item command="hidden"><EyeOff v-if="showHidden" :size="14" /><Eye v-else :size="14" />{{ showHidden ? $t('隐藏隐藏文件') : $t('显示隐藏文件') }}</el-dropdown-item>
              <el-dropdown-item command="chmod" :disabled="!selected"><Shield :size="14" />{{ $t('修改权限') }}</el-dropdown-item>
              <el-dropdown-item command="clear" :disabled="!selectedItems.length" divided><X :size="14" />{{ $t('取消选择') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div v-if="filterOpen && connection" class="sftp-filter-popover">
        <Search :size="14" /><input v-model="filterKeyword" type="search" :placeholder="$t('按名称筛选当前目录')" :aria-label="$t('按名称筛选当前目录')" /><button type="button" :aria-label="$t('关闭筛选')" @click="filterOpen = false"><X :size="13" /></button>
      </div>
      <input ref="fileInput" type="file" hidden @change="handleFile" />
    </header>

    <template v-if="connection">
      <div class="sftp-pathbar">
        <button type="button" :disabled="historyIndex === 0" :aria-label="$t('后退')" @click="navigateHistory(-1)"><ChevronLeft :size="15" /></button>
        <button type="button" :disabled="historyIndex >= pathHistory.length - 1" :aria-label="$t('前进')" @click="navigateHistory(1)"><ChevronRight :size="15" /></button>
        <form v-if="pathEditing" class="sftp-path-editor" @submit.prevent="submitPath">
          <input ref="pathInput" v-model="pathDraft" :aria-label="localConnection ? $t('本机目录路径') : $t('远程目录路径')" @keydown.esc.prevent="cancelPathEditing" />
        </form>
        <div v-else class="sftp-breadcrumbs" :title="$t('双击手动输入路径')" @dblclick="startPathEditing">
          <template v-for="(segment, index) in breadcrumbs" :key="segment.path">
            <ChevronRight v-if="index" :size="12" />
            <button type="button" :title="segment.path" @click="load(segment.path)">{{ segment.label }}</button>
          </template>
        </div>
        <button type="button" :aria-label="$t('刷新目录')" @click="load()"><RefreshCw :size="15" /></button>
      </div>
      <div v-if="uploadProgress !== null" class="upload-progress"><span :style="{ width: `${uploadProgress}%` }"></span><em>{{ $t('正在上传') }} {{ uploadProgress }}%</em></div>
      <div class="sftp-list" v-loading="loading" @dragover="dragOver(undefined, $event)" @drop="dropItems(undefined, $event)">
        <div class="sftp-list__head"><span>{{ $t('名称') }}</span><span>{{ $t('修改时间') }}</span><span>{{ $t('大小') }}</span></div>
        <div
          v-for="item in visibleItems"
          :key="item.path"
          class="sftp-row"
          :class="{ 'is-selected': selectedPathSet.has(item.path), 'is-drop-target': dropTargetPath === item.path && isSftpDirectory(item) }"
          role="button"
          tabindex="0"
          draggable="true"
          :aria-pressed="selectedPathSet.has(item.path)"
          @click="selectItem(item, $event)"
          @dblclick="openItem(item)"
          @keydown.enter="openItem(item)"
          @keydown.space.prevent="selectItem(item, $event)"
          @dragstart="startItemDrag(item, $event)"
          @dragend="endItemDrag"
          @dragover.stop="dragOver(item, $event)"
          @drop.stop="dropItems(item, $event)"
        >
          <span class="sftp-name"><Folder v-if="isSftpDirectory(item)" :size="16" /><File v-else :size="16" /><span><strong>{{ item.name }}</strong><small>{{ item.mode }}</small></span></span>
          <span>{{ new Date(item.modifiedAt).toLocaleString($locale()) }}</span>
          <span>{{ isSftpDirectory(item) ? '—' : formatFileSize(item.size) }}</span>
        </div>
        <div v-if="!visibleItems.length && !loading" class="sftp-empty"><Folder :size="24" /><span>{{ filterKeyword ? $t('没有匹配的文件') : $t('此目录为空') }}</span></div>
      </div>
    </template>
    <div v-else class="sftp-pane__empty">
      <span><FolderOpen :size="34" /></span>
      <strong>{{ side === 'left' ? $t('选择来源主机') : $t('选择目标主机') }}</strong>
      <p>{{ $t('每一栏独立维护连接、路径和选中项。') }}</p>
      <button type="button" @click="emit('chooseConnection')">{{ $t('选择位置') }}</button>
    </div>
  </section>
</template>
