<script setup lang="ts">import { translate as tr } from "../i18n";

import { ArrowLeftRight, CircleStop, Database, Download, FileUp, GitCompareArrows, HardDriveDownload, RefreshCw, Rows3, X } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { DatabaseSyncMode } from "../../database-sync";
import { api } from "../api";
import { downloadApiFile } from "../desktop";
import DatabaseSyncDialog from "./DatabaseSyncDialog.vue";
import TipIcon from "./TipIcon.vue";

interface DatabaseConnection { id: string; name: string; host: string; engine: string }
interface DatabaseTask {
  id: string;
  type: "backup" | "restore" | "transfer" | "import";
  connectionId: string | null;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  progress: number;
  title: string;
  details: Record<string, unknown>;
  logs: string[];
  error: string;
  createdAt: string;
  completedAt?: string;
  downloadable: boolean;
  outputFilename: string | null;
}

const props = defineProps<{
  visible: boolean;
  connectionId: string;
  database: string;
  connections: DatabaseConnection[];
  actionRequest?: { id: string; type: "restore" | "list" | "transfer" };
}>();
const emit = defineEmits<{ close: []; actionHandled: [id: string]; tasksChange: [tasks: DatabaseTask[]] }>();

const tasks = ref<DatabaseTask[]>([]);
const loading = ref(false);
const starting = ref(false);
const mode = ref<"list" | "restore" | "transfer">("list");
const syncMode = ref<DatabaseSyncMode | null>(null);
const restoreFile = ref<File | null>(null);
const restoreInput = ref<HTMLInputElement | null>(null);
const transfer = ref({ targetConnectionId: "", targetDatabase: "", includeStructure: true, includeData: true, includeObjects: true, dropExisting: false });
let timer: number | undefined;

const currentConnection = computed(() => props.connections.find((item) => item.id === props.connectionId));
const activeTasks = computed(() => tasks.value.filter((task) => ["pending", "running"].includes(task.status)).length);

async function load() {
  if (!props.visible) return;
  loading.value = true;
  try {
    const response = await api<{ items: DatabaseTask[] }>("/api/v1/database-tasks");
    tasks.value = response.items;
    emit("tasksChange", response.items);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载数据库任务失败"));
  } finally {
    loading.value = false;
  }
}

async function startBackup() {
  if (!props.connectionId || !props.database) return ElMessage.warning(tr("请先选择连接和数据库"));
  starting.value = true;
  try {
    await api(`/api/v1/database-connections/${props.connectionId}/backup`, { method: "POST", body: JSON.stringify({ database: props.database }) });
    ElMessage.success(tr("备份任务已开始"));
    mode.value = "list";
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法开始备份"));
  } finally {
    starting.value = false;
  }
}

function chooseRestoreFile(event: Event) {
  restoreFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function startRestore() {
  if (!restoreFile.value) return ElMessage.warning(tr("请选择 SQL 备份文件"));
  starting.value = true;
  try {
    const formData = new FormData();
    formData.append("database", props.database);
    formData.append("file", restoreFile.value);
    await api(`/api/v1/database-connections/${props.connectionId}/restore`, { method: "POST", body: formData });
    ElMessage.success(tr("恢复任务已开始"));
    restoreFile.value = null;
    mode.value = "list";
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法开始恢复"));
  } finally {
    starting.value = false;
  }
}

async function startTransfer() {
  if (!transfer.value.targetConnectionId || !transfer.value.targetDatabase.trim()) return ElMessage.warning(tr("请选择目标连接并填写目标数据库"));
  starting.value = true;
  try {
    await api(`/api/v1/database-connections/${props.connectionId}/transfer`, { method: "POST", body: JSON.stringify({ sourceDatabase: props.database, ...transfer.value }) });
    ElMessage.success(tr("一次性迁移任务已开始"));
    mode.value = "list";
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法开始迁移"));
  } finally {
    starting.value = false;
  }
}

function openSync(value: DatabaseSyncMode) {
  if (!props.connectionId || !props.database) return ElMessage.warning(tr("请先选择连接和数据库"));
  syncMode.value = value;
}

function taskTypeLabel(task: DatabaseTask): string {
  if (task.details.syncMode === "data") return tr("数据同步");
  if (task.details.syncMode === "structure") return tr("结构同步");
  if (task.type === "backup") return tr("备份");
  if (task.type === "restore") return tr("恢复");
  if (task.type === "transfer") return tr("数据传输");
  return tr("导入");
}

async function cancelTask(task: DatabaseTask) {
  try {
    await api(`/api/v1/database-tasks/${task.id}`, { method: "DELETE" });
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("取消任务失败"));
  }
}

async function downloadTask(task: DatabaseTask) {
  try {
    await downloadApiFile(`/api/v1/database-tasks/${task.id}/download`, task.outputFilename ?? undefined);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("下载 SQL 失败"));
  }
}

watch(() => props.visible, (visible) => {
  if (visible) {
    void load();
    timer = window.setInterval(load, 1_000);
  } else {
    window.clearInterval(timer);
    timer = undefined;
    syncMode.value = null;
  }
}, { immediate: true });
watch(() => props.actionRequest, async (request) => {
  if (!request || !props.visible) return;
  mode.value = request.type;
  await nextTick();
  if (request.type === "restore") restoreInput.value?.click();
  emit("actionHandled", request.id);
}, { deep: true });
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <aside v-if="visible" class="database-task-panel">
    <header><div><strong>{{ $t('备份、恢复与同步') }}</strong></div><button :aria-label="$t('关闭数据库操作面板')" :title="$t('关闭')" @click="emit('close')"><X :size="16" /></button></header>
    <div class="task-context"><Database :size="15" /><span><strong>{{ currentConnection?.name || $t('未选择连接') }}</strong><small>{{ database || $t('未选择数据库') }}</small></span><em v-if="activeTasks">{{ activeTasks }} {{ $t('个运行中') }}</em></div>
    <nav class="task-actions"><button :disabled="!database || starting" @click="startBackup"><HardDriveDownload :size="16" />{{ $t('立即备份') }}</button><button :disabled="!database" :class="{ 'is-active': mode === 'restore' }" @click="mode = mode === 'restore' ? 'list' : 'restore'"><FileUp :size="16" />{{ $t('恢复 SQL') }}</button><button :disabled="!database" :class="{ 'is-active': mode === 'transfer' }" @click="mode = mode === 'transfer' ? 'list' : 'transfer'"><ArrowLeftRight :size="16" />{{ $t('数据传输') }}</button><button :disabled="!database" @click="openSync('data')"><Rows3 :size="16" />{{ $t('数据同步') }}</button><button :disabled="!database" @click="openSync('structure')"><GitCompareArrows :size="16" />{{ $t('结构同步') }}</button></nav>
    <section v-if="mode === 'restore'" class="task-form"><span class="heading-with-tip"><strong>{{ $t('恢复 SQL 备份') }}</strong><TipIcon :content="$t('SQL 将按语句顺序在 {0} 中执行，并记录进度与错误日志。', [database])" placement="right" /></span><button class="task-file" @click="restoreInput?.click()"><FileUp :size="18" />{{ restoreFile?.name || $t('选择 .sql 文件') }}</button><input ref="restoreInput" hidden type="file" accept=".sql" @change="chooseRestoreFile" /><el-button type="primary" size="small" :disabled="!restoreFile" :loading="starting" @click="startRestore">{{ $t('开始恢复') }}</el-button></section>
    <section v-else-if="mode === 'transfer'" class="task-form"><span class="heading-with-tip"><strong>{{ $t('数据传输') }}</strong><TipIcon :content="$t('将所选数据库的结构和数据复制到另一个 MySQL/MariaDB 数据库。')" placement="right" /></span><el-select v-model="transfer.targetConnectionId" :placeholder="$t('目标连接')" size="small"><el-option v-for="connection in connections.filter((item) => item.id !== connectionId)" :key="connection.id" :label="`${connection.name} · ${connection.host}`" :value="connection.id" /></el-select><el-input v-model="transfer.targetDatabase" size="small" :placeholder="$t('目标数据库名称')" /><div class="task-checks"><el-checkbox v-model="transfer.includeStructure">{{ $t('表结构') }}</el-checkbox><el-checkbox v-model="transfer.includeData">{{ $t('表数据') }}</el-checkbox><el-checkbox v-model="transfer.includeObjects" :disabled="!transfer.includeStructure">{{ $t('视图 / 例程 / 触发器 / 事件') }}</el-checkbox><el-checkbox v-model="transfer.dropExisting">{{ $t('覆盖同名对象') }}</el-checkbox></div><el-button type="primary" size="small" :loading="starting" @click="startTransfer">{{ $t('开始传输') }}</el-button></section>
    <section class="task-list" v-loading="loading"><header><span>{{ $t('最近任务') }}</span><button :aria-label="$t('刷新数据库任务')" :title="$t('刷新')" @click="load"><RefreshCw :size="13" /></button></header><article v-for="task in tasks" :key="task.id"><div class="task-title"><span :class="`is-${task.status}`"><RefreshCw v-if="task.status === 'running' || task.status === 'pending'" :size="13" class="is-spinning" /><CircleStop v-else-if="task.status === 'error' || task.status === 'cancelled'" :size="13" /><Database v-else :size="13" /></span><div><strong>{{ task.title }}</strong><small>{{ new Date(task.createdAt).toLocaleString($locale()) }} · {{ taskTypeLabel(task) }}</small></div><em>{{ task.progress }}%</em></div><el-progress :percentage="task.progress" :status="task.status === 'error' ? 'exception' : task.status === 'success' ? 'success' : undefined" :show-text="false" :stroke-width="3" /><code v-if="task.error">{{ task.error }}</code><p v-else-if="task.logs.length">{{ task.logs[task.logs.length - 1] }}</p><footer><button v-if="task.downloadable" @click="downloadTask(task)"><Download :size="13" />{{ $t('下载 SQL') }}</button><button v-if="task.status === 'running' || task.status === 'pending'" class="is-danger" @click="cancelTask(task)"><CircleStop :size="13" />{{ $t('取消') }}</button></footer></article><div v-if="!tasks.length" class="saved-empty"><HardDriveDownload :size="23" /><span>{{ $t('还没有数据库后台任务') }}</span></div></section>
  </aside>
  <DatabaseSyncDialog :visible="visible && Boolean(syncMode)" :initial-mode="syncMode || 'data'" :connection-id="connectionId" :database="database" :connections="connections" @close="syncMode = null" @started="mode = 'list'; load()" />
</template>
