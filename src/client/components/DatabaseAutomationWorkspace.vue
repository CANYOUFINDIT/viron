<script setup lang="ts">import { translate as tr } from "../i18n";

import { CircleStop, Clock3, Dice5, Download, FileCode2, Focus, HardDriveDownload, ListPlus, Play, Plus, RefreshCw, Save, Search, Trash2, Upload, X } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { createClientId } from "../client-id";
import { downloadApiFile } from "../desktop";
import { onAppShortcut, shortcutActionFromKeyboardEvent } from "../keyboard-shortcuts";

interface ConnectionItem { id: string; name: string }
interface SavedQueryItem { id: string; connectionId: string; name: string; database: string }
interface ModelItem { id: string; name: string; database: string }
interface AutomationWork { id: string; type: "query" | "backup" | "transfer" | "dataSync" | "structureSync" | "dataDictionary" | "export" | "import" | "dataGeneration" | "model"; name: string; config: Record<string, unknown> }
interface AutomationOutput { path: string; filename: string; contentType: string; createdAt: string }
interface AutomationItem {
  id: string;
  connectionId: string;
  database: string;
  name: string;
  works: AutomationWork[];
  advanced: Record<string, unknown>;
  scheduleCron: string;
  scheduleEnabled: boolean;
  status: "idle" | "running" | "success" | "error";
  logs: string[];
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
  lastRunAt: string | null;
}

const props = defineProps<{ connectionId: string; database: string; connections: ConnectionItem[]; savedQueries: SavedQueryItem[] }>();
const emit = defineEmits<{ dirtyChange: [dirty: boolean] }>();

const mode = ref<"list" | "editor">("list");
const loading = ref(false);
const saving = ref(false);
const running = ref(false);
const focused = ref(false);
const workspaceElement = ref<HTMLElement | null>(null);
let removeShortcutListener: (() => void) | undefined;
const activeSection = ref<"general" | "advanced" | "logs">("general");
const search = ref("");
const items = ref<AutomationItem[]>([]);
const currentId = ref("");
const jobConnectionId = ref(props.connectionId || props.connections[0]?.id || "");
const jobDatabase = ref(props.database);
const name = ref("");
const works = ref<AutomationWork[]>([]);
const advanced = ref<Record<string, unknown>>({});
const selectedWorkId = ref("");
const availableSelectedId = ref("available-backup");
const models = ref<ModelItem[]>([]);
const scheduleCron = ref("");
const scheduleEnabled = ref(false);
const logs = ref<string[]>([]);
let baseline = "";
let timer: number | undefined;

const filteredItems = computed(() => items.value.filter((item) => !search.value || `${item.name} ${item.status}`.toLowerCase().includes(search.value.toLowerCase())));
const selectedWork = computed(() => works.value.find((item) => item.id === selectedWorkId.value) ?? null);
const availableWorks = computed<AutomationWork[]>(() => [
  { id: "available-backup", type: "backup", name: tr("备份 {0}", [jobDatabase.value || tr("数据库")]), config: { database: jobDatabase.value } },
  ...props.savedQueries.filter((item) => item.connectionId === jobConnectionId.value && (!jobDatabase.value || item.database === jobDatabase.value)).map((item) => ({ id: `available-query-${item.id}`, type: "query" as const, name: item.name, config: { savedQueryId: item.id } })),
  { id: "available-transfer", type: "transfer", name: tr("数据传输"), config: { targetConnectionId: "", targetDatabase: "", includeStructure: true, includeData: true, includeObjects: true, dropExisting: false } },
  { id: "available-data-sync", type: "dataSync", name: tr("数据同步"), config: { targetConnectionId: "", targetDatabase: "" } },
  { id: "available-structure-sync", type: "structureSync", name: tr("结构同步"), config: { targetConnectionId: "", targetDatabase: "" } },
  { id: "available-dictionary", type: "dataDictionary", name: tr("数据字典"), config: { database: jobDatabase.value } },
  { id: "available-export", type: "export", name: tr("导出"), config: { database: jobDatabase.value, table: "", format: "csv", includeData: true } },
  { id: "available-import", type: "import", name: tr("导入"), config: { database: jobDatabase.value, table: "", filename: "", contentBase64: "", mode: "append" } },
  { id: "available-data-generation", type: "dataGeneration", name: tr("数据生成"), config: { database: jobDatabase.value, table: "", rowCount: 100, seed: 1 } },
  ...models.value.map((item) => ({ id: `available-model-${item.id}`, type: "model" as const, name: item.name, config: { modelId: item.id } })),
]);
const selectedAvailableWork = computed(() => availableWorks.value.find((item) => item.id === availableSelectedId.value) ?? availableWorks.value[0] ?? null);
const outputs = computed(() => Object.entries((advanced.value.outputs && typeof advanced.value.outputs === "object" ? advanced.value.outputs : {}) as Record<string, AutomationOutput>));
const stateJson = computed(() => JSON.stringify({ connectionId: jobConnectionId.value, database: jobDatabase.value, name: name.value, works: works.value, advanced: advanced.value, scheduleCron: scheduleCron.value, scheduleEnabled: scheduleEnabled.value }));

function markBaseline() {
  baseline = stateJson.value;
  emit("dirtyChange", false);
}

watch(stateJson, (value) => emit("dirtyChange", mode.value === "editor" && value !== baseline));

async function load() {
  loading.value = true;
  try {
    const [response, modelResponse] = await Promise.all([
      api<{ items: AutomationItem[] }>("/api/v1/database-automations"),
      api<{ items: ModelItem[] }>("/api/v1/database-models"),
    ]);
    items.value = response.items;
    models.value = modelResponse.items;
    const active = currentId.value ? response.items.find((item) => item.id === currentId.value) : null;
    if (active) {
      logs.value = active.logs;
      running.value = active.status === "running";
      advanced.value = JSON.parse(JSON.stringify(active.advanced ?? {}));
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载批处理作业失败"));
  } finally {
    loading.value = false;
  }
}

function newAutomation() {
  currentId.value = "";
  name.value = "";
  works.value = [];
  advanced.value = {};
  selectedWorkId.value = "";
  scheduleCron.value = "";
  scheduleEnabled.value = false;
  logs.value = [];
  jobConnectionId.value = props.connectionId || props.connections[0]?.id || "";
  jobDatabase.value = props.database;
  activeSection.value = "general";
  mode.value = "editor";
  markBaseline();
}

function openAutomation(item: AutomationItem) {
  currentId.value = item.id;
  name.value = item.name;
  jobConnectionId.value = item.connectionId;
  jobDatabase.value = item.database;
  works.value = JSON.parse(JSON.stringify(item.works));
  advanced.value = JSON.parse(JSON.stringify(item.advanced ?? {}));
  selectedWorkId.value = works.value[0]?.id ?? "";
  scheduleCron.value = item.scheduleCron;
  scheduleEnabled.value = item.scheduleEnabled;
  logs.value = item.logs;
  activeSection.value = "general";
  mode.value = "editor";
  markBaseline();
}

function addWork(item: AutomationWork) {
  const work = JSON.parse(JSON.stringify(item)) as AutomationWork;
  work.id = createClientId();
  works.value.push(work);
  selectedWorkId.value = work.id;
}

function addAllWorks() {
  for (const item of availableWorks.value) addWork(item);
}

function removeWork() {
  const index = works.value.findIndex((item) => item.id === selectedWorkId.value);
  if (index < 0) return;
  works.value.splice(index, 1);
  selectedWorkId.value = works.value[Math.min(index, works.value.length - 1)]?.id ?? "";
}

async function save(): Promise<boolean> {
  if (!name.value.trim()) {
    try {
      const response = await ElMessageBox.prompt(tr("请输入批处理作业名称"), tr("保存批处理作业"), { confirmButtonText: tr("保存"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入名称") });
      name.value = response.value.trim();
    } catch { return false; }
  }
  if (!jobConnectionId.value) { ElMessage.warning(tr("请选择批处理作业连接")); return false; }
  if (!jobDatabase.value.trim()) { ElMessage.warning(tr("请输入批处理作业数据库")); return false; }
  if (!works.value.length) { ElMessage.warning(tr("请至少添加一个工作")); return false; }
  saving.value = true;
  try {
    const payload = { connectionId: jobConnectionId.value, database: jobDatabase.value.trim(), name: name.value.trim(), works: works.value, advanced: advanced.value, scheduleCron: scheduleCron.value, scheduleEnabled: scheduleEnabled.value };
    if (currentId.value) await api(`/api/v1/database-automations/${currentId.value}`, { method: "PUT", body: JSON.stringify(payload) });
    else {
      const response = await api<{ item: AutomationItem }>("/api/v1/database-automations", { method: "POST", body: JSON.stringify(payload) });
      currentId.value = response.item.id;
    }
    await load();
    markBaseline();
    ElMessage.success(tr("批处理作业已保存"));
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存批处理作业失败"));
    return false;
  } finally {
    saving.value = false;
  }
}

async function start() {
  if (stateJson.value !== baseline && !await save()) return;
  if (!currentId.value) return;
  try {
    await api(`/api/v1/database-automations/${currentId.value}/run`, { method: "POST" });
    running.value = true;
    activeSection.value = "logs";
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法开始批处理作业"));
  }
}

async function setSchedule() {
  try {
    const response = await ElMessageBox.prompt(tr("请输入 Cron 表达式"), tr("设置任务计划"), { confirmButtonText: tr("设置"), cancelButtonText: tr("取消"), inputValue: scheduleCron.value || "0 2 * * *", inputValidator: (value) => Boolean(value.trim()) || tr("请输入 Cron 表达式") });
    scheduleCron.value = response.value.trim();
    scheduleEnabled.value = true;
    await save();
  } catch { /* cancelled */ }
}

async function deleteSchedule() {
  if (!currentId.value) {
    scheduleCron.value = "";
    scheduleEnabled.value = false;
    return;
  }
  await api(`/api/v1/database-automations/${currentId.value}/schedule`, { method: "DELETE" });
  scheduleCron.value = "";
  scheduleEnabled.value = false;
  markBaseline();
  await load();
}

async function deleteAutomation(item: AutomationItem) {
  try {
    await ElMessageBox.confirm(tr("确定删除批处理作业“{0}”吗？", [item.name]), tr("删除批处理作业"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/database-automations/${item.id}`, { method: "DELETE" });
    await load();
  } catch { /* cancelled */ }
}

async function chooseAutomationImportFile() {
  const work = selectedWork.value;
  if (!work || work.type !== "import") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,text/csv";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 1_500_000) return ElMessage.warning(tr("自动导入文件必须小于 1.5 MB"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    work.config.filename = file.name;
    work.config.contentBase64 = btoa(binary);
  }, { once: true });
  input.click();
}

async function downloadOutput(workId: string, output: AutomationOutput) {
  try {
    await downloadApiFile(`/api/v1/database-automations/${currentId.value}/outputs/${workId}`, output.filename);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("下载自动运行输出失败"));
  }
}

async function backToList() {
  if (stateJson.value !== baseline) {
    try {
      await ElMessageBox.confirm(tr("当前批处理作业尚未保存。"), tr("关闭批处理作业"), { confirmButtonText: tr("保存"), cancelButtonText: tr("不保存"), distinguishCancelAndClose: true });
      if (!await save()) return;
    } catch (action) {
      if (action !== "cancel") return;
    }
  }
  mode.value = "list";
  emit("dirtyChange", false);
  await load();
}

function handleKeydown(event: KeyboardEvent) {
  if (shortcutActionFromKeyboardEvent(event) !== "workspace.save" || mode.value !== "editor") return;
  event.preventDefault();
  void save();
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => { if (running.value) void load(); }, 1_000);
  document.addEventListener("keydown", handleKeydown);
  removeShortcutListener = onAppShortcut((action) => {
    if (action === "workspace.save" && mode.value === "editor" && workspaceElement.value?.getClientRects().length) void save();
  });
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener("keydown", handleKeydown);
  removeShortcutListener?.();
});

defineExpose({ save });
</script>

<template>
  <Teleport to="body" :disabled="!focused">
    <section ref="workspaceElement" class="database-automation-workspace" :class="{ 'is-focused': focused }" v-loading="loading">
      <template v-if="mode === 'list'">
        <header class="database-artifact-list-toolbar"><div><button data-navicat-action="new-automation" @click="newAutomation"><Plus :size="17" />{{ $t('新建批处理作业') }}</button><button data-navicat-action="refresh" @click="load"><RefreshCw :size="17" />{{ $t('刷新') }}</button></div><el-input v-model="search" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="14" /></template></el-input></header>
        <div class="database-object-table-wrap"><table class="database-object-table"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('文件大小') }}</th><th>{{ $t('创建日期') }}</th><th>{{ $t('修改日期') }}</th><th>{{ $t('访问时间') }}</th><th></th></tr></thead><tbody><tr v-for="item in filteredItems" :key="item.id" tabindex="0" @dblclick="openAutomation(item)" @keydown.enter="openAutomation(item)"><td><span class="object-name-cell"><Clock3 :size="15" />{{ item.name }}</span></td><td>{{ JSON.stringify(item.works).length }} B</td><td>{{ new Date(item.createdAt).toLocaleString($locale()) }}</td><td>{{ new Date(item.updatedAt).toLocaleString($locale()) }}</td><td>{{ new Date(item.accessedAt).toLocaleString($locale()) }}</td><td><button class="artifact-row-delete" :title="$t('删除')" @click.stop="deleteAutomation(item)"><Trash2 :size="13" /></button></td></tr></tbody></table><div v-if="!filteredItems.length" class="object-browser-empty"><Clock3 :size="25" /><span>{{ $t('没有批处理作业') }}</span></div></div>
        <footer><span>{{ filteredItems.length }} {{ $t('个批处理作业') }}</span></footer>
      </template>

      <template v-else>
        <header class="database-automation-toolbar">
          <button data-navicat-action="start" :disabled="running" @click="start"><Play :size="17" />{{ $t('开始') }}</button>
          <button data-navicat-action="save" :disabled="saving" @click="save"><Save :size="17" />{{ $t('保存') }}</button>
          <button data-navicat-action="set-schedule" @click="setSchedule"><Clock3 :size="17" />{{ $t('设置任务计划') }}</button>
          <button data-navicat-action="delete-schedule" :disabled="!scheduleEnabled" @click="deleteSchedule"><CircleStop :size="17" />{{ $t('删除任务计划') }}</button>
          <span></span>
          <button data-navicat-action="add-work" :disabled="!selectedAvailableWork" @click="selectedAvailableWork && addWork(selectedAvailableWork)"><Plus :size="17" />{{ $t('添加工作') }}</button>
          <button data-navicat-action="add-all" @click="addAllWorks"><ListPlus :size="17" />{{ $t('添加所有工作') }}</button>
          <button data-navicat-action="remove-work" :disabled="!selectedWork" @click="removeWork"><X :size="17" />{{ $t('移除工作') }}</button>
          <button data-navicat-action="remove-all" :disabled="!works.length" @click="works = []; selectedWorkId = ''"><Trash2 :size="17" />{{ $t('移除所有工作') }}</button>
          <button data-navicat-action="focus" class="automation-focus" @click="focused = !focused"><Focus :size="17" />{{ focused ? $t('退出专注模式') : $t('进入专注模式') }}</button>
        </header>
        <nav class="database-automation-tabs"><button :class="{ 'is-active': activeSection === 'general' }" @click="activeSection = 'general'">{{ $t('常规') }}</button><button :class="{ 'is-active': activeSection === 'advanced' }" @click="activeSection = 'advanced'">{{ $t('高级') }}</button><button :class="{ 'is-active': activeSection === 'logs' }" @click="activeSection = 'logs'">{{ $t('消息日志') }}</button></nav>
        <main v-if="activeSection === 'general'" class="database-automation-general">
          <section class="automation-selected"><header><strong>{{ $t('已选择的工作') }}</strong><small>{{ name || $t('无标题') }}</small></header><table><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('类型') }}</th><th>{{ $t('连接') }}</th><th>{{ $t('数据库') }}</th></tr></thead><tbody><tr v-for="work in works" :key="work.id" :class="{ 'is-selected': selectedWorkId === work.id }" @click="selectedWorkId = work.id"><td>{{ work.name }}</td><td>{{ work.type }}</td><td>{{ connections.find((item) => item.id === (work.config.targetConnectionId || jobConnectionId))?.name || '—' }}</td><td>{{ work.config.targetDatabase || work.config.database || jobDatabase }}</td></tr></tbody></table><div v-if="!works.length" class="automation-drop-hint">{{ $t('拖曳或添加你的可用工作到这里') }}</div></section>
          <section class="automation-available"><header><strong>{{ $t('可用的工作') }}</strong></header><button v-for="work in availableWorks" :key="work.id" :class="{ 'is-selected': availableSelectedId === work.id }" @click="availableSelectedId = work.id" @dblclick="addWork(work)"><HardDriveDownload v-if="work.type === 'backup'" :size="14" /><FileCode2 v-else-if="work.type === 'query'" :size="14" /><Download v-else-if="work.type === 'export'" :size="14" /><Upload v-else-if="work.type === 'import'" :size="14" /><Dice5 v-else-if="work.type === 'dataGeneration'" :size="14" /><RefreshCw v-else :size="14" /><span>{{ work.name }}</span><small>{{ work.type }}</small></button></section>
        </main>
        <main v-else-if="activeSection === 'advanced'" class="database-automation-advanced">
          <label><span>{{ $t('作业名称') }}</span><el-input v-model="name" maxlength="160" /></label>
          <label><span>{{ $t('连接') }}</span><el-select v-model="jobConnectionId"><el-option v-for="connection in connections" :key="connection.id" :label="connection.name" :value="connection.id" /></el-select></label>
          <label><span>{{ $t('数据库') }}</span><el-input v-model="jobDatabase" /></label>
          <label><span>{{ $t('任务计划') }}</span><el-input v-model="scheduleCron" :placeholder="$t('Cron 表达式')" /><el-switch v-model="scheduleEnabled" /></label>
          <template v-if="selectedWork && ['transfer','dataSync','structureSync'].includes(selectedWork.type)">
            <label><span>{{ $t('目标连接') }}</span><el-select v-model="selectedWork.config.targetConnectionId"><el-option v-for="connection in connections.filter((item) => item.id !== jobConnectionId)" :key="connection.id" :label="connection.name" :value="connection.id" /></el-select></label>
            <label><span>{{ $t('目标数据库') }}</span><el-input v-model="selectedWork.config.targetDatabase" /></label>
          </template>
          <template v-if="selectedWork && ['export','import','dataGeneration'].includes(selectedWork.type)">
            <label><span>{{ $t('工作数据库') }}</span><el-input v-model="selectedWork.config.database" /></label>
            <label><span>{{ $t('数据表') }}</span><el-input v-model="selectedWork.config.table" :placeholder="$t('输入数据表名称')" /></label>
          </template>
          <template v-if="selectedWork?.type === 'export'">
            <label><span>{{ $t('导出格式') }}</span><el-select v-model="selectedWork.config.format"><el-option label="CSV" value="csv" /><el-option label="SQL" value="sql" /></el-select></label>
            <label><span>{{ $t('包含数据') }}</span><el-switch v-model="selectedWork.config.includeData" /></label>
          </template>
          <template v-if="selectedWork?.type === 'import'">
            <label><span>{{ $t('CSV 文件') }}</span><button class="automation-file-button" type="button" @click="chooseAutomationImportFile"><Upload :size="14" />{{ selectedWork.config.filename || $t('选择文件') }}</button></label>
            <label><span>{{ $t('导入模式') }}</span><el-select v-model="selectedWork.config.mode"><el-option :label="$t('追加数据')" value="append" /><el-option :label="$t('清空后导入')" value="replace" /></el-select></label>
          </template>
          <template v-if="selectedWork?.type === 'dataGeneration'">
            <label><span>{{ $t('生成行数') }}</span><el-input-number v-model="selectedWork.config.rowCount" :min="1" :max="10000" /></label>
            <label><span>{{ $t('随机种子') }}</span><el-input-number v-model="selectedWork.config.seed" :min="0" :max="999999" /></label>
          </template>
        </main>
        <main v-else class="database-automation-logs"><pre>{{ logs.join('\n') || $t('尚未运行批处理作业') }}</pre><section v-if="outputs.length"><header>{{ $t('输出文件') }}</header><button v-for="[workId, output] in outputs" :key="workId" type="button" @click="downloadOutput(workId, output)"><Download :size="14" /><span>{{ output.filename }}</span><small>{{ new Date(output.createdAt).toLocaleString($locale()) }}</small></button></section></main>
        <footer class="database-automation-status"><button @click="backToList">{{ $t('返回对象列表') }}</button><span>{{ scheduleEnabled ? $t('计划：{0}', [scheduleCron]) : $t('未设置任务计划') }}</span><strong :class="`is-${running ? 'running' : 'idle'}`">{{ running ? $t('运行中') : $t('就绪') }}</strong></footer>
      </template>
    </section>
  </Teleport>
</template>
