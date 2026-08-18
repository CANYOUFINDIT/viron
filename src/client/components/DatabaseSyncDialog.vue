<script setup lang="ts">import { translate as tr } from "../i18n";

import { AlertTriangle, ArrowLeft, ArrowRight, Check, Database, GitCompareArrows, Play, RefreshCw, Rows3, Server, X } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, reactive, ref, watch } from "vue";
import type { DatabaseSyncMode, DatabaseSyncPreview, DatabaseSyncPreviewItem } from "../../database-sync";
import { api } from "../api";
import TipIcon from "./TipIcon.vue";

interface DatabaseConnection { id: string; name: string; host: string; engine: string }
interface SchemaItem { name: string; charset: string; collation: string }

const props = defineProps<{
  visible: boolean;
  initialMode: DatabaseSyncMode;
  connectionId: string;
  database: string;
  connections: DatabaseConnection[];
}>();
const emit = defineEmits<{ close: []; started: [] }>();

const mode = ref<DatabaseSyncMode>("data");
const step = ref<"setup" | "preview">("setup");
const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetSchemas = ref<SchemaItem[]>([]);
const loadingSchemas = ref(false);
const comparing = ref(false);
const starting = ref(false);
const preview = ref<DatabaseSyncPreview | null>(null);
const selectedItems = ref<string[]>([]);
const activeItemId = ref("");
const data = reactive({ insert: true, update: true, delete: true });
const structure = reactive({
  compareTables: true,
  comparePrimaryKeys: true,
  compareForeignKeys: true,
  compareIndexes: true,
  compareChecks: true,
  compareCharsets: true,
  compareAutoIncrement: false,
  compareTableOptions: true,
  compareViews: true,
  compareRoutines: true,
  compareTriggers: true,
  compareEvents: true,
  compareDefiners: false,
  dropExtra: false,
});

const sourceConnection = computed(() => props.connections.find((item) => item.id === props.connectionId));
const targetConnection = computed(() => props.connections.find((item) => item.id === targetConnectionId.value));
const activeItem = computed(() => preview.value?.items.find((item) => item.id === activeItemId.value) ?? preview.value?.items[0] ?? null);
const actionableItems = computed(() => preview.value?.items.filter((item) => item.action !== "none") ?? []);
const selectedDestructive = computed(() => actionableItems.value.filter((item) => item.destructive && selectedItems.value.includes(item.id)).length);
const canCompare = computed(() => Boolean(props.connectionId && props.database && targetConnectionId.value && targetDatabase.value.trim())
  && !(props.connectionId === targetConnectionId.value && props.database === targetDatabase.value.trim())
  && (mode.value === "structure" || data.insert || data.update || data.delete));

function statusLabel(item: DatabaseSyncPreviewItem): string {
  if (item.status === "ready") return tr("可同步");
  if (item.status === "missing") return tr("目标缺少");
  if (item.status === "different") return tr("存在差异");
  if (item.status === "extra") return tr("仅目标存在");
  if (item.status === "same") return tr("一致");
  return tr("需处理");
}

function categoryLabel(item: DatabaseSyncPreviewItem): string {
  if (item.category === "table") return tr("表");
  if (item.category === "view") return tr("视图");
  if (item.category === "trigger") return tr("触发器");
  if (item.category === "event") return tr("事件");
  return item.subtype === "FUNCTION" ? tr("函数") : tr("存储过程");
}

function reset() {
  mode.value = props.initialMode;
  step.value = "setup";
  preview.value = null;
  selectedItems.value = [];
  activeItemId.value = "";
  const firstTarget = props.connections.find((item) => item.id !== props.connectionId) ?? props.connections.find((item) => item.id === props.connectionId);
  targetConnectionId.value = firstTarget?.id ?? "";
  targetDatabase.value = "";
  targetSchemas.value = [];
  if (firstTarget) void loadTargetSchemas();
}

async function loadTargetSchemas() {
  targetSchemas.value = [];
  targetDatabase.value = "";
  if (!targetConnectionId.value) return;
  loadingSchemas.value = true;
  try {
    const response = await api<{ items: SchemaItem[] }>(`/api/v1/database-connections/${targetConnectionId.value}/schemas`);
    targetSchemas.value = response.items;
    const sameName = response.items.find((item) => item.name === props.database);
    targetDatabase.value = sameName?.name ?? "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载目标数据库失败"));
  } finally {
    loadingSchemas.value = false;
  }
}

function payload() {
  return {
    mode: mode.value,
    sourceDatabase: props.database,
    targetConnectionId: targetConnectionId.value,
    targetDatabase: targetDatabase.value.trim(),
    data: { ...data },
    structure: { ...structure },
  };
}

async function compare() {
  if (!canCompare.value) return ElMessage.warning(tr("请选择不同的源数据库和目标数据库，并至少启用一项同步操作"));
  comparing.value = true;
  try {
    const response = await api<{ preview: DatabaseSyncPreview }>(`/api/v1/database-connections/${props.connectionId}/sync-preview`, { method: "POST", body: JSON.stringify(payload()) });
    preview.value = response.preview;
    selectedItems.value = response.preview.items.filter((item) => item.selectedByDefault && item.action !== "none").map((item) => item.id);
    activeItemId.value = response.preview.items.find((item) => item.action !== "none")?.id ?? response.preview.items[0]?.id ?? "";
    step.value = "preview";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("数据库比较失败"));
  } finally {
    comparing.value = false;
  }
}

function toggleAll(checked: boolean) {
  selectedItems.value = checked ? actionableItems.value.map((item) => item.id) : [];
}

async function start() {
  if (!selectedItems.value.length) return ElMessage.warning(tr("请选择要同步的对象"));
  const operation = mode.value === "data" ? tr("数据同步") : tr("结构同步");
  const warning = selectedDestructive.value
    ? tr("所选对象包含 {0} 项删除或替换操作。目标数据库将被修改，请确认已检查比较结果。", [selectedDestructive.value])
    : tr("目标数据库将被修改，请确认已检查比较结果。");
  try {
    await ElMessageBox.confirm(warning, tr("开始{0}", [operation]), { confirmButtonText: tr("开始{0}", [operation]), cancelButtonText: tr("取消"), type: selectedDestructive.value ? "warning" : "info" });
  } catch {
    return;
  }
  starting.value = true;
  try {
    await api(`/api/v1/database-connections/${props.connectionId}/sync`, { method: "POST", body: JSON.stringify({ ...payload(), selectedItems: selectedItems.value }) });
    ElMessage.success(tr("{0}任务已开始", [operation]));
    emit("started");
    emit("close");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法开始{0}", [operation]));
  } finally {
    starting.value = false;
  }
}

watch(() => props.visible, (visible) => { if (visible) reset(); });
watch(() => props.initialMode, (value) => { if (props.visible) mode.value = value; });
watch(mode, () => { preview.value = null; step.value = "setup"; selectedItems.value = []; activeItemId.value = ""; });
</script>

<template>
  <el-dialog :model-value="visible" width="min(1120px, 94vw)" class="database-sync-dialog" append-to-body :close-on-click-modal="false" destroy-on-close @close="emit('close')">
    <template #header>
      <div class="sync-dialog-title"><span><GitCompareArrows :size="20" /></span><div><strong>{{ mode === 'data' ? $t('数据同步') : $t('结构同步') }}</strong></div></div>
    </template>

    <div class="sync-mode-switch" role="tablist" :aria-label="$t('同步类型')">
      <button :class="{ 'is-active': mode === 'data' }" role="tab" :aria-selected="mode === 'data'" @click="mode = 'data'"><Rows3 :size="16" />{{ $t('数据同步') }}</button>
      <button :class="{ 'is-active': mode === 'structure' }" role="tab" :aria-selected="mode === 'structure'" @click="mode = 'structure'"><GitCompareArrows :size="16" />{{ $t('结构同步') }}</button>
    </div>

    <section v-if="step === 'setup'" class="sync-setup">
      <div class="sync-endpoints">
        <section><header><span class="is-source"><Database :size="17" /></span><div><small>{{ $t('源') }}</small><strong>{{ sourceConnection?.name || $t('未选择连接') }}</strong></div></header><dl><div><dt>{{ $t('连接') }}</dt><dd>{{ sourceConnection?.host || '—' }}</dd></div><div><dt>{{ $t('数据库') }}</dt><dd>{{ database || '—' }}</dd></div><div><dt>{{ $t('类型') }}</dt><dd>{{ sourceConnection?.engine?.toUpperCase() || '—' }}</dd></div></dl></section>
        <ArrowRight :size="22" class="sync-direction" />
        <section><header><span class="is-target"><Server :size="17" /></span><div><small>{{ $t('目标') }}</small><strong>{{ targetConnection?.name || $t('选择目标连接') }}</strong></div></header><el-select v-model="targetConnectionId" filterable :placeholder="$t('目标连接')" @change="loadTargetSchemas"><el-option v-for="connection in connections" :key="connection.id" :label="`${connection.name} · ${connection.host}`" :value="connection.id" /></el-select><el-select v-model="targetDatabase" filterable allow-create default-first-option :loading="loadingSchemas" :placeholder="$t('选择或输入目标数据库')"><el-option v-for="schema in targetSchemas" :key="schema.name" :label="schema.name" :value="schema.name" /></el-select></section>
      </div>

      <section v-if="mode === 'data'" class="sync-options"><header><span class="heading-with-tip"><strong>{{ $t('同步操作') }}</strong><TipIcon :content="$t('插入用于补齐缺失记录，更新按主键覆盖差异，删除会移除目标端多出的记录。')" placement="right" /></span></header><div class="sync-option-grid"><label><el-checkbox v-model="data.insert" /><span><strong>{{ $t('插入') }}</strong></span></label><label><el-checkbox v-model="data.update" /><span><strong>{{ $t('更新') }}</strong></span></label><label class="is-danger"><el-checkbox v-model="data.delete" /><span><strong>{{ $t('删除') }}</strong></span></label></div></section>
      <section v-else class="sync-options"><header><span class="heading-with-tip"><strong>{{ $t('比较选项') }}</strong><TipIcon :content="$t('按所选对象结构生成目标数据库需要执行的差异 SQL。')" placement="right" /></span></header><div class="structure-option-grid"><el-checkbox v-model="structure.compareTables">{{ $t('比较表和列') }}</el-checkbox><el-checkbox v-model="structure.comparePrimaryKeys">{{ $t('比较主键') }}</el-checkbox><el-checkbox v-model="structure.compareIndexes">{{ $t('比较索引') }}</el-checkbox><el-checkbox v-model="structure.compareForeignKeys">{{ $t('比较外键') }}</el-checkbox><el-checkbox v-model="structure.compareChecks">{{ $t('比较检查约束') }}</el-checkbox><el-checkbox v-model="structure.compareCharsets">{{ $t('比较字符集') }}</el-checkbox><el-checkbox v-model="structure.compareTableOptions">{{ $t('比较表选项') }}</el-checkbox><el-checkbox v-model="structure.compareAutoIncrement">{{ $t('比较自动递增值') }}</el-checkbox><el-checkbox v-model="structure.compareViews">{{ $t('比较视图') }}</el-checkbox><el-checkbox v-model="structure.compareRoutines">{{ $t('比较函数和存储过程') }}</el-checkbox><el-checkbox v-model="structure.compareTriggers">{{ $t('比较触发器') }}</el-checkbox><el-checkbox v-model="structure.compareEvents">{{ $t('比较事件') }}</el-checkbox><el-checkbox v-model="structure.compareDefiners">{{ $t('比较定义者') }}</el-checkbox><el-checkbox v-model="structure.dropExtra" class="is-danger">{{ $t('删除目标多余对象') }}</el-checkbox></div></section>
    </section>

    <section v-else-if="preview" class="sync-preview">
      <header class="sync-summary"><div><strong>{{ preview.summary.actionable }}</strong><span>{{ $t('可执行') }}</span></div><div><strong>{{ preview.summary.unchanged }}</strong><span>{{ $t('一致') }}</span></div><div :class="{ 'has-warning': preview.summary.blocked }"><strong>{{ preview.summary.blocked }}</strong><span>{{ $t('需处理') }}</span></div><div :class="{ 'has-danger': preview.summary.destructive }"><strong>{{ preview.summary.destructive }}</strong><span>{{ $t('高风险') }}</span></div><button @click="compare"><RefreshCw :size="14" />{{ $t('重新比较') }}</button></header>
      <div class="sync-preview-body">
        <section class="sync-object-list"><header><el-checkbox :model-value="selectedItems.length === actionableItems.length && actionableItems.length > 0" :indeterminate="selectedItems.length > 0 && selectedItems.length < actionableItems.length" @change="toggleAll(Boolean($event))">{{ $t('选择全部差异') }}</el-checkbox><small>{{ selectedItems.length }} / {{ actionableItems.length }}</small></header><el-checkbox-group v-model="selectedItems"><div v-for="item in preview.items" :key="item.id" role="button" tabindex="0" :class="['sync-object-row', `is-${item.status}`, { 'is-active': activeItem?.id === item.id }]" @click="activeItemId = item.id" @keydown.enter="activeItemId = item.id"><el-checkbox :value="item.id" :disabled="item.action === 'none'" @click.stop /><span class="sync-object-kind">{{ categoryLabel(item) }}</span><span class="sync-object-name"><strong>{{ item.name }}</strong><small>{{ item.detail }}</small></span><em>{{ statusLabel(item) }}</em><AlertTriangle v-if="item.destructive" :size="14" /></div></el-checkbox-group></section>
        <section class="sync-diff-panel"><template v-if="activeItem"><header><div><small>{{ categoryLabel(activeItem) }}</small><strong>{{ activeItem.name }}</strong></div><span :class="`is-${activeItem.status}`">{{ statusLabel(activeItem) }}</span></header><template v-if="mode === 'structure'"><div v-if="activeItem.sql.length" class="sync-sql-preview"><code v-for="(statement, index) in activeItem.sql" :key="index">{{ statement }};</code></div><div v-else class="sync-no-diff"><Check v-if="activeItem.status === 'same'" :size="24" /><X v-else :size="24" /><span>{{ activeItem.detail }}</span></div></template><template v-else><dl class="sync-data-detail"><div><dt>{{ $t('源记录估算') }}</dt><dd>{{ activeItem.sourceRows ?? '—' }}</dd></div><div><dt>{{ $t('目标记录估算') }}</dt><dd>{{ activeItem.targetRows ?? '—' }}</dd></div><div><dt>{{ $t('匹配主键') }}</dt><dd>{{ activeItem.primaryKey.join(', ') || $t('无') }}</dd></div><div><dt class="label-with-tip">{{ $t('执行策略') }}<TipIcon :content="$t('按主键分批比较；每张表使用独立事务，失败时回滚该表。')" placement="left" /></dt><dd>{{ [data.insert ? $t('插入') : '', data.update ? $t('更新') : '', data.delete ? $t('删除') : ''].filter(Boolean).join(' / ') }}</dd></div></dl></template></template></section>
      </div>
    </section>

    <template #footer>
      <div class="sync-dialog-footer"><el-button @click="emit('close')">{{ $t('取消') }}</el-button><el-button v-if="step === 'preview'" @click="step = 'setup'"><ArrowLeft :size="14" />{{ $t('返回') }}</el-button><el-button v-if="step === 'setup'" type="primary" :disabled="!canCompare" :loading="comparing" @click="compare"><GitCompareArrows :size="15" />{{ $t('比较') }}</el-button><el-button v-else type="primary" :disabled="!selectedItems.length" :loading="starting" @click="start"><Play :size="15" />{{ $t('开始') }}{{ mode === 'data' ? $t('数据同步') : $t('结构同步') }}</el-button></div>
    </template>
  </el-dialog>
</template>
