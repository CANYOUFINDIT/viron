<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  AlertTriangle,
  BadgeCheck,
  Columns3,
  FileCode2,
  KeyRound,
  Link2,
  ListPlus,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  Zap,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { createClientId } from "../client-id";
import { onAppShortcut, shortcutActionFromKeyboardEvent, shortcutLabel } from "../keyboard-shortcuts";
import {
  buildAlterTableSql,
  buildCreateTableSql,
  TABLE_FIELD_TYPES,
  validateTableDesigner,
  type ForeignKeyAction,
  type TableDefaultKind,
  type TableDesignerCheck,
  type TableDesignerField,
  type TableDesignerForeignKey,
  type TableDesignerIndex,
  type TableDesignerState,
  type TableDesignerTrigger,
  type TableFieldType,
  type TableIndexType,
  type TableTriState,
  type TriggerEvent,
  type TriggerTiming,
} from "../database-table-designer";

const props = defineProps<{ connectionId: string; database: string; table?: string }>();
const emit = defineEmits<{ saved: [payload: { tableName: string; existing: boolean }]; dirtyChange: [dirty: boolean] }>();

type DesignerTab = "fields" | "indexes" | "foreignKeys" | "triggers" | "checks" | "options" | "comment" | "sql";
interface QueryJob { id: string; status: "pending" | "running" | "success" | "error" | "cancelled"; error?: string }

const activeTab = ref<DesignerTab>("fields");
const loading = ref(Boolean(props.table));
const loadingMessage = ref("");
const loadError = ref("");
const saving = ref(false);
const focused = ref(false);
const designerElement = ref<HTMLElement | null>(null);
let removeShortcutListener: (() => void) | undefined;
const validationErrors = ref<string[]>([]);
const tableName = ref("");
const fields = ref<TableDesignerField[]>([newField()]);
const indexes = ref<TableDesignerIndex[]>([]);
const foreignKeys = ref<TableDesignerForeignKey[]>([]);
const triggers = ref<TableDesignerTrigger[]>([]);
const checks = ref<TableDesignerCheck[]>([]);
const engine = ref("InnoDB");
const charset = ref("utf8mb4");
const collation = ref("");
const rowFormat = ref("");
const autoIncrement = ref<number | null>(null);
const tablespace = ref("");
const minRows = ref<number | null>(null);
const averageRowLength = ref<number | null>(null);
const keyBlockSize = ref<number | null>(null);
const maxRows = ref<number | null>(null);
const partition = ref("");
const dataDirectory = ref("");
const indexDirectory = ref("");
const delayKeyWrite = ref<boolean | null>(null);
const packKeys = ref<TableTriState>("");
const checksum = ref<boolean | null>(null);
const pageChecksum = ref<boolean | null>(null);
const connectionOption = ref("");
const encryption = ref<"" | "Y" | "N">("");
const unionTables = ref("");
const insertMethod = ref<"" | "NO" | "FIRST" | "LAST">("");
const statsPersistent = ref<TableTriState>("");
const statsAutoRecalc = ref<TableTriState>("");
const statsSamplePages = ref<number | null>(null);
const transactional = ref<boolean | null>(null);
const comment = ref("");
const selectedFieldId = ref(fields.value[0].id);
const selectedIndexId = ref("");
const selectedForeignKeyId = ref("");
const selectedTriggerId = ref("");
const selectedCheckId = ref("");
let trackingChanges = false;
let originalState: TableDesignerState | null = null;
let loadGeneration = 0;
let loadController: AbortController | null = null;
const TABLE_DESIGN_LOAD_TIMEOUT_MS = 45_000;

const tabs = [
  { key: "fields" as const, label: tr("字段"), icon: Columns3 },
  { key: "indexes" as const, label: tr("索引"), icon: KeyRound },
  { key: "foreignKeys" as const, label: tr("外键"), icon: Link2 },
  { key: "triggers" as const, label: tr("触发器"), icon: Zap },
  { key: "checks" as const, label: tr("检查"), icon: BadgeCheck },
  { key: "options" as const, label: tr("选项"), icon: Settings2 },
  { key: "comment" as const, label: tr("注释"), icon: MessageSquareText },
  { key: "sql" as const, label: tr("SQL 预览"), icon: FileCode2 },
];

const fieldNames = computed(() => fields.value.map((field) => field.name.trim()).filter(Boolean));
const selectedField = computed(() => fields.value.find((field) => field.id === selectedFieldId.value) ?? null);
const selectedIndex = computed(() => indexes.value.find((item) => item.id === selectedIndexId.value) ?? null);
const selectedTrigger = computed(() => triggers.value.find((item) => item.id === selectedTriggerId.value) ?? null);
const designerState = computed<TableDesignerState>(() => ({
  database: props.database,
  tableName: tableName.value,
  fields: fields.value,
  indexes: indexes.value,
  foreignKeys: foreignKeys.value,
  checks: checks.value,
  triggers: triggers.value,
  options: {
    engine: engine.value,
    charset: charset.value,
    collation: collation.value,
    rowFormat: rowFormat.value,
    autoIncrement: autoIncrement.value,
    tablespace: tablespace.value,
    minRows: minRows.value,
    averageRowLength: averageRowLength.value,
    keyBlockSize: keyBlockSize.value,
    maxRows: maxRows.value,
    partition: partition.value,
    dataDirectory: dataDirectory.value,
    indexDirectory: indexDirectory.value,
    delayKeyWrite: delayKeyWrite.value,
    packKeys: packKeys.value,
    checksum: checksum.value,
    pageChecksum: pageChecksum.value,
    connection: connectionOption.value,
    encryption: encryption.value,
    unionTables: unionTables.value,
    insertMethod: insertMethod.value,
    statsPersistent: statsPersistent.value,
    statsAutoRecalc: statsAutoRecalc.value,
    statsSamplePages: statsSamplePages.value,
    transactional: transactional.value,
  },
  comment: comment.value,
}));
const sqlPreview = computed(() => {
  try {
    return originalState ? buildAlterTableSql(originalState, designerState.value) : buildCreateTableSql(designerState.value);
  } catch {
    return tr("-- 完成表名和字段配置后显示 SQL");
  }
});

function newField(): TableDesignerField {
  return {
    id: createClientId(),
    name: "",
    type: "VARCHAR",
    length: "255",
    decimals: "",
    notNull: false,
    primaryKey: false,
    unsigned: false,
    zerofill: false,
    charset: "",
    collation: "",
    binary: false,
    columnFormat: "",
    storage: "",
    keyLength: "",
    autoIncrement: false,
    defaultKind: "none",
    defaultValue: "",
    comment: "",
    generated: false,
    generatedExpression: "",
    generatedStored: false,
    onUpdateExpression: "",
  };
}

function cloneState(state: TableDesignerState): TableDesignerState {
  return JSON.parse(JSON.stringify(state)) as TableDesignerState;
}

function markCurrentAsPersisted() {
  for (const item of [...fields.value, ...indexes.value, ...foreignKeys.value, ...checks.value, ...triggers.value]) item.originalName = item.name;
}

function applyDesign(design: TableDesignerState) {
  tableName.value = design.tableName;
  fields.value = design.fields.map((field) => ({
    ...newField(),
    ...field,
    id: createClientId(),
    originalName: field.originalName ?? field.name,
  }));
  indexes.value = design.indexes.map((item) => ({
    ...newIndex(),
    ...item,
    id: createClientId(),
    originalName: item.originalName ?? item.name,
    columnSettings: Object.fromEntries(item.columns.map((column) => [column, item.columnSettings?.[column] ?? { length: "", order: "" }])),
  }));
  foreignKeys.value = design.foreignKeys.map((item) => ({ ...item, id: createClientId(), originalName: item.originalName ?? item.name }));
  checks.value = design.checks.map((item) => ({ ...item, id: createClientId(), originalName: item.originalName ?? item.name }));
  triggers.value = design.triggers.map((item) => ({ ...item, id: createClientId(), originalName: item.originalName ?? item.name }));
  engine.value = design.options.engine || "InnoDB";
  charset.value = design.options.charset || "utf8mb4";
  collation.value = design.options.collation || "";
  rowFormat.value = design.options.rowFormat || "";
  autoIncrement.value = design.options.autoIncrement;
  tablespace.value = design.options.tablespace ?? "";
  minRows.value = design.options.minRows ?? null;
  averageRowLength.value = design.options.averageRowLength ?? null;
  keyBlockSize.value = design.options.keyBlockSize ?? null;
  maxRows.value = design.options.maxRows ?? null;
  partition.value = design.options.partition ?? "";
  dataDirectory.value = design.options.dataDirectory ?? "";
  indexDirectory.value = design.options.indexDirectory ?? "";
  delayKeyWrite.value = design.options.delayKeyWrite ?? null;
  packKeys.value = design.options.packKeys ?? "";
  checksum.value = design.options.checksum ?? null;
  pageChecksum.value = design.options.pageChecksum ?? null;
  connectionOption.value = design.options.connection ?? "";
  encryption.value = design.options.encryption ?? "";
  unionTables.value = design.options.unionTables ?? "";
  insertMethod.value = design.options.insertMethod ?? "";
  statsPersistent.value = design.options.statsPersistent ?? "";
  statsAutoRecalc.value = design.options.statsAutoRecalc ?? "";
  statsSamplePages.value = design.options.statsSamplePages ?? null;
  transactional.value = design.options.transactional ?? null;
  comment.value = design.comment;
  selectedFieldId.value = fields.value[0]?.id ?? "";
  selectedIndexId.value = indexes.value[0]?.id ?? "";
  selectedForeignKeyId.value = foreignKeys.value[0]?.id ?? "";
  selectedTriggerId.value = triggers.value[0]?.id ?? "";
  selectedCheckId.value = checks.value[0]?.id ?? "";
}

async function loadExistingTable() {
  if (!props.table) return;
  const generation = ++loadGeneration;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  loadingMessage.value = tr("正在连接并读取数据表结构");
  loadError.value = "";
  trackingChanges = false;
  let loaded = false;
  const timers = [
    window.setTimeout(() => {
      if (generation === loadGeneration) loadingMessage.value = tr("数据库响应较慢，正在继续等待");
    }, 5_000),
    window.setTimeout(() => {
      if (generation === loadGeneration) loadingMessage.value = tr("网络或数据库响应较慢，仍在等待");
    }, 20_000),
    window.setTimeout(() => {
      controller.abort(new Error(tr("读取数据表结构超过 45 秒，请检查 VPN、网络或数据库状态后重试")));
    }, TABLE_DESIGN_LOAD_TIMEOUT_MS),
  ];
  try {
    const response = await api<{ design: TableDesignerState }>(`/api/v1/database-connections/${props.connectionId}/table-design?database=${encodeURIComponent(props.database)}&table=${encodeURIComponent(props.table)}`, { signal: controller.signal });
    if (generation !== loadGeneration) return;
    applyDesign(response.design);
    originalState = cloneState(designerState.value);
    emit("dirtyChange", false);
    loaded = true;
  } catch (error) {
    if (generation !== loadGeneration) return;
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    loadError.value = reason instanceof Error ? reason.message : tr("读取数据表结构失败");
  } finally {
    for (const timer of timers) window.clearTimeout(timer);
    if (generation !== loadGeneration) return;
    if (loadController === controller) loadController = null;
    loading.value = false;
    loadingMessage.value = "";
    await nextTick();
    trackingChanges = loaded;
  }
}

function newIndex(): TableDesignerIndex {
  return {
    id: createClientId(),
    name: "",
    type: "INDEX",
    columns: [],
    columnSettings: {},
    method: "BTREE",
    comment: "",
    collation: "",
    cardinality: "",
    packed: false,
    keyBlockSize: null,
    parser: "",
    invisible: false,
  };
}

function newForeignKey(): TableDesignerForeignKey {
  return {
    id: createClientId(),
    name: "",
    columns: [],
    referencedDatabase: props.database,
    referencedTable: "",
    referencedColumns: [],
    onDelete: "RESTRICT",
    onUpdate: "RESTRICT",
  };
}

function newTrigger(): TableDesignerTrigger {
  return { id: createClientId(), name: "", timing: "BEFORE", event: "INSERT", statement: "" };
}

function newCheck(): TableDesignerCheck {
  return { id: createClientId(), name: "", expression: "" };
}

function addCurrent() {
  if (activeTab.value === "fields") {
    const field = newField();
    fields.value.push(field);
    selectedFieldId.value = field.id;
  } else if (activeTab.value === "indexes") {
    const item = newIndex(); indexes.value.push(item); selectedIndexId.value = item.id;
  } else if (activeTab.value === "foreignKeys") {
    const item = newForeignKey(); foreignKeys.value.push(item); selectedForeignKeyId.value = item.id;
  } else if (activeTab.value === "triggers") {
    const item = newTrigger(); triggers.value.push(item); selectedTriggerId.value = item.id;
  } else if (activeTab.value === "checks") {
    const item = newCheck(); checks.value.push(item); selectedCheckId.value = item.id;
  }
}

function insertCurrent() {
  if (activeTab.value !== "fields") return addCurrent();
  const index = fields.value.findIndex((field) => field.id === selectedFieldId.value);
  const field = newField();
  fields.value.splice(index < 0 ? fields.value.length : index, 0, field);
  selectedFieldId.value = field.id;
}

function deleteCurrent() {
  if (activeTab.value === "fields") {
    if (fields.value.length <= 1) return ElMessage.warning(tr("数据表至少需要一个字段"));
    const index = fields.value.findIndex((field) => field.id === selectedFieldId.value);
    if (index < 0) return;
    const [removed] = fields.value.splice(index, 1);
    for (const item of indexes.value) item.columns = item.columns.filter((name) => name !== removed.name);
    for (const item of foreignKeys.value) item.columns = item.columns.filter((name) => name !== removed.name);
    selectedFieldId.value = fields.value[Math.min(index, fields.value.length - 1)]?.id ?? "";
  } else if (activeTab.value === "indexes") {
    indexes.value = indexes.value.filter((item) => item.id !== selectedIndexId.value);
    selectedIndexId.value = indexes.value[0]?.id ?? "";
  } else if (activeTab.value === "foreignKeys") {
    foreignKeys.value = foreignKeys.value.filter((item) => item.id !== selectedForeignKeyId.value);
    selectedForeignKeyId.value = foreignKeys.value[0]?.id ?? "";
  } else if (activeTab.value === "triggers") {
    triggers.value = triggers.value.filter((item) => item.id !== selectedTriggerId.value);
    selectedTriggerId.value = triggers.value[0]?.id ?? "";
  } else if (activeTab.value === "checks") {
    checks.value = checks.value.filter((item) => item.id !== selectedCheckId.value);
    selectedCheckId.value = checks.value[0]?.id ?? "";
  }
}

function canModifyRows(): boolean {
  return ["fields", "indexes", "foreignKeys", "triggers", "checks"].includes(activeTab.value);
}

function selectedRowExists(): boolean {
  if (activeTab.value === "fields") return fields.value.some((item) => item.id === selectedFieldId.value);
  if (activeTab.value === "indexes") return indexes.value.some((item) => item.id === selectedIndexId.value);
  if (activeTab.value === "foreignKeys") return foreignKeys.value.some((item) => item.id === selectedForeignKeyId.value);
  if (activeTab.value === "triggers") return triggers.value.some((item) => item.id === selectedTriggerId.value);
  if (activeTab.value === "checks") return checks.value.some((item) => item.id === selectedCheckId.value);
  return false;
}

function updateCommaList(target: TableDesignerForeignKey, key: "columns" | "referencedColumns", value: string) {
  target[key] = value.split(",").map((item) => item.trim()).filter(Boolean);
}

function setFieldType(field: TableDesignerField, value: TableFieldType) {
  field.type = value;
  if (["VARCHAR", "CHAR", "BINARY", "VARBINARY", "BIT"].includes(value) && !field.length) field.length = value === "VARCHAR" ? "255" : "1";
  if (!["VARCHAR", "CHAR", "BINARY", "VARBINARY", "BIT", "DECIMAL", "DOUBLE", "FLOAT", "DATETIME", "TIMESTAMP", "TIME", "ENUM", "SET"].includes(value)) {
    field.length = "";
    field.decimals = "";
  }
  if (!["BIGINT", "INT", "MEDIUMINT", "SMALLINT", "TINYINT"].includes(value)) field.autoIncrement = false;
}

function setIndexColumns(index: TableDesignerIndex, columns: string[]) {
  index.columns = columns;
  const current = index.columnSettings ?? {};
  index.columnSettings = Object.fromEntries(columns.map((column) => [column, current[column] ?? { length: "", order: "" }]));
}

function indexColumnSetting(index: TableDesignerIndex, column: string) {
  index.columnSettings ??= {};
  index.columnSettings[column] ??= { length: "", order: "" };
  return index.columnSettings[column];
}

function numericField(field: TableDesignerField): boolean {
  return ["BIGINT", "INT", "MEDIUMINT", "SMALLINT", "TINYINT", "DECIMAL", "DOUBLE", "FLOAT"].includes(field.type);
}

function characterField(field: TableDesignerField): boolean {
  return ["VARCHAR", "CHAR", "TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT", "ENUM", "SET"].includes(field.type);
}

function setTriggerEvent(trigger: TableDesignerTrigger, event: TriggerEvent) {
  trigger.event = event;
}

async function waitForQuery(jobId: string): Promise<QueryJob> {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const response = await api<{ job: QueryJob }>(`/api/v1/database-queries/${jobId}`);
    if (!["pending", "running"].includes(response.job.status)) return response.job;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(tr("等待建表操作完成超时"));
}

async function saveTable() {
  if (loading.value) return ElMessage.info(tr("数据表结构仍在读取，请稍候"));
  if (loadError.value) return ElMessage.warning(tr("数据表结构尚未完整加载，请重试后再保存"));
  if (!tableName.value.trim() && !props.table) {
    try {
      const response = await ElMessageBox.prompt(tr("请输入数据表名称"), tr("保存表"), {
        confirmButtonText: tr("保存"),
        cancelButtonText: tr("取消"),
        inputPlaceholder: tr("表名"),
        inputValidator: (value) => /^[^`\u0000-\u001f]{1,64}$/.test(value.trim()) || tr("表名需为 1–64 个有效字符"),
      });
      tableName.value = response.value.trim();
    } catch (error) {
      if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("无法读取表名"));
      return;
    }
  }
  validationErrors.value = validateTableDesigner(designerState.value);
  if (validationErrors.value.length) {
    activeTab.value = "fields";
    return ElMessage.warning(validationErrors.value[0]);
  }
  if (!props.connectionId) return ElMessage.warning(tr("数据库连接已断开，请先重新连接"));
  if (originalState && sqlPreview.value.startsWith(tr("-- 未检测到结构变更"))) {
    emit("dirtyChange", false);
    ElMessage.info(tr("没有需要保存的结构变更"));
    return;
  }
  saving.value = true;
  try {
    const response = await api<{ job: QueryJob }>(`/api/v1/database-connections/${props.connectionId}/queries`, {
      method: "POST",
      body: JSON.stringify({ database: props.database, sql: sqlPreview.value }),
    });
    const job = await waitForQuery(response.job.id);
    if (job.status !== "success") throw new Error(job.error || (props.table ? tr("保存数据表失败") : tr("创建数据表失败")));
    if (props.table) {
      markCurrentAsPersisted();
      originalState = cloneState(designerState.value);
    }
    emit("dirtyChange", false);
    ElMessage.success(tr("数据表 {0}.{1} 已{2}", [props.database, tableName.value.trim(), props.table ? tr("保存") : tr("创建")]));
    emit("saved", { tableName: tableName.value.trim(), existing: Boolean(props.table) });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : props.table ? tr("保存数据表失败") : tr("创建数据表失败"));
  } finally {
    saving.value = false;
  }
}

function toggleFocused() {
  focused.value = !focused.value;
}

function handleKeydown(event: KeyboardEvent) {
  if (shortcutActionFromKeyboardEvent(event) === "workspace.save") {
    event.preventDefault();
    void saveTable();
  } else if (event.key === "Escape" && focused.value) {
    event.preventDefault();
    toggleFocused();
  }
}

watch(designerState, () => {
  validationErrors.value = [];
  if (trackingChanges) emit("dirtyChange", true);
}, { deep: true });

onMounted(async () => {
  document.addEventListener("keydown", handleKeydown);
  removeShortcutListener = onAppShortcut((action) => {
    if (action === "workspace.save" && designerElement.value?.getClientRects().length) void saveTable();
  });
  if (props.table) await loadExistingTable();
  else void nextTick(() => { trackingChanges = true; });
});
onBeforeUnmount(() => {
  loadGeneration += 1;
  loadController?.abort();
  loadController = null;
  document.removeEventListener("keydown", handleKeydown);
  removeShortcutListener?.();
});
</script>

<template>
  <Teleport to="body" :disabled="!focused">
    <section ref="designerElement" class="table-designer" :class="{ 'is-focused': focused }" v-loading="loading" :element-loading-text="loadingMessage">
      <header class="table-designer-toolbar">
        <div class="table-designer-actions">
          <button class="is-primary" data-navicat-action="save" :disabled="saving || loading || Boolean(loadError)" :title="$t('保存表 ({0})', [shortcutLabel('workspace.save')])" @click="saveTable"><Save :size="17" />{{ $t('保存') }}</button>
          <span></span>
          <button data-navicat-action="add" :disabled="loading || Boolean(loadError) || !canModifyRows()" :title="$t('添加')" @click="addCurrent"><Plus :size="17" />{{ $t('添加') }}</button>
          <button data-navicat-action="insert" :disabled="loading || Boolean(loadError) || !canModifyRows()" :title="$t('插入')" @click="insertCurrent"><ListPlus :size="17" />{{ $t('插入') }}</button>
          <button class="is-danger" data-navicat-action="delete" :disabled="loading || Boolean(loadError) || !selectedRowExists()" :title="$t('删除')" @click="deleteCurrent"><Trash2 :size="17" />{{ $t('删除') }}</button>
        </div>
        <button class="table-designer-focus" data-navicat-action="focus" :title="focused ? $t('退出专注模式') : $t('进入专注模式')" @click="toggleFocused"><Minimize2 v-if="focused" :size="18" /><Maximize2 v-else :size="18" /></button>
      </header>

      <nav class="table-designer-tabs" :aria-label="$t('数据表设计')">
        <button v-for="tab in tabs" :key="tab.key" :class="{ 'is-active': activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
      </nav>

      <main class="table-designer-stage">
        <section v-if="loadError" class="table-designer-load-error">
          <AlertTriangle :size="30" />
          <strong>{{ $t('无法读取数据表结构') }}</strong>
          <p>{{ loadError }}</p>
          <button type="button" @click="loadExistingTable"><RefreshCw :size="14" />{{ $t('重试') }}</button>
        </section>
        <div v-else-if="activeTab === 'fields'" class="table-designer-fields-layout">
          <div class="table-designer-grid-wrap">
          <table class="table-designer-grid table-designer-fields">
            <thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('类型') }}</th><th>{{ $t('长度') }}</th><th>{{ $t('小数点') }}</th><th>{{ $t('不是 Null') }}</th><th>{{ $t('虚拟') }}</th><th>{{ $t('键') }}</th><th>{{ $t('注释') }}</th></tr></thead>
            <tbody>
              <tr v-for="field in fields" :key="field.id" :class="{ 'is-selected': selectedFieldId === field.id }" @click="selectedFieldId = field.id">
                <td><el-input v-model="field.name" maxlength="64" :placeholder="$t('字段名')" /></td>
                <td><el-select :model-value="field.type" filterable @update:model-value="setFieldType(field, $event as TableFieldType)"><el-option v-for="type in TABLE_FIELD_TYPES" :key="type" :label="type" :value="type" /></el-select></td>
                <td><el-input v-model="field.length" inputmode="numeric" /></td>
                <td><el-input v-model="field.decimals" inputmode="numeric" /></td>
                <td><el-checkbox v-model="field.notNull" /></td>
                <td><el-checkbox v-model="field.generated" /></td>
                <td><el-checkbox v-model="field.primaryKey" /></td>
                <td><el-input v-model="field.comment" maxlength="1024" /></td>
              </tr>
            </tbody>
          </table>
          </div>
          <section v-if="selectedField" class="table-designer-properties field-properties">
            <label><span>{{ $t('默认值') }}</span><div class="table-default-editor"><el-select v-model="selectedField.defaultKind" :disabled="selectedField.generated"><el-option :label="$t('无')" value="none" /><el-option label="NULL" value="null" /><el-option :label="$t('值')" value="value" /><el-option :label="$t('表达式')" value="expression" /></el-select><el-input v-if="selectedField.defaultKind === 'value' || selectedField.defaultKind === 'expression'" v-model="selectedField.defaultValue" :disabled="selectedField.generated" :placeholder="selectedField.defaultKind === 'expression' ? 'CURRENT_TIMESTAMP' : $t('默认值')" /></div></label>
            <label><span>{{ $t('无符号') }}</span><el-checkbox v-model="selectedField.unsigned" /></label>
            <label><span>{{ $t('填充零') }}</span><el-checkbox v-model="selectedField.zerofill" :disabled="!numericField(selectedField)" /></label>
            <label><span>{{ $t('键长度') }}</span><el-input v-model="selectedField.keyLength" inputmode="numeric" :disabled="!selectedField.primaryKey" /></label>
            <label><span>{{ $t('字符集') }}</span><el-input v-model="selectedField.charset" :disabled="!characterField(selectedField)" :placeholder="$t('跟随表默认值')" /></label>
            <label><span>{{ $t('排序规则') }}</span><el-input v-model="selectedField.collation" :disabled="!characterField(selectedField)" :placeholder="$t('跟随字符集')" /></label>
            <label><span>{{ $t('二进制') }}</span><el-checkbox v-model="selectedField.binary" :disabled="!characterField(selectedField)" /></label>
            <label><span>{{ $t('自动递增') }}</span><el-checkbox v-model="selectedField.autoIncrement" :disabled="selectedField.generated" /></label>
            <label><span>{{ $t('列格式') }}</span><el-select v-model="selectedField.columnFormat"><el-option :label="$t('默认')" value="" /><el-option label="DEFAULT" value="DEFAULT" /><el-option label="FIXED" value="FIXED" /><el-option label="DYNAMIC" value="DYNAMIC" /></el-select></label>
            <label><span>{{ $t('存储') }}</span><el-select v-model="selectedField.storage"><el-option :label="$t('默认')" value="" /><el-option label="DEFAULT" value="DEFAULT" /><el-option label="DISK" value="DISK" /><el-option label="MEMORY" value="MEMORY" /></el-select></label>
            <label class="is-wide"><span>{{ $t('更新表达式') }}</span><el-input v-model="selectedField.onUpdateExpression" :disabled="selectedField.generated" :placeholder="$t('例如 CURRENT_TIMESTAMP')" /></label>
            <label v-if="selectedField.generated" class="is-wide"><span>{{ $t('虚拟列表达式') }}</span><el-input v-model="selectedField.generatedExpression" :placeholder="$t('例如 price * quantity')" /></label>
            <label v-if="selectedField.generated"><span>{{ $t('存储方式') }}</span><el-select v-model="selectedField.generatedStored"><el-option label="VIRTUAL" :value="false" /><el-option label="STORED" :value="true" /></el-select></label>
          </section>
        </div>

        <div v-else-if="activeTab === 'indexes'" class="table-designer-fields-layout">
          <div class="table-designer-grid-wrap"><table class="table-designer-grid table-designer-indexes"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('字段') }}</th><th>{{ $t('索引类型') }}</th><th>{{ $t('索引方法') }}</th><th>{{ $t('注释') }}</th></tr></thead><tbody><tr v-for="item in indexes" :key="item.id" :class="{ 'is-selected': selectedIndexId === item.id }" @click="selectedIndexId = item.id"><td><el-input v-model="item.name" maxlength="64" :placeholder="$t('索引名称')" /></td><td><el-select :model-value="item.columns" multiple filterable collapse-tags @update:model-value="setIndexColumns(item, $event)"><el-option v-for="name in fieldNames" :key="name" :label="name" :value="name" /></el-select></td><td><el-select v-model="item.type"><el-option :label="$t('普通索引')" value="INDEX" /><el-option :label="$t('唯一索引')" value="UNIQUE" /><el-option :label="$t('全文索引')" value="FULLTEXT" /></el-select></td><td><el-select v-model="item.method"><el-option label="BTREE" value="BTREE" /><el-option label="HASH" value="HASH" /></el-select></td><td><el-input v-model="item.comment" maxlength="1024" /></td></tr></tbody></table></div>
          <section v-if="selectedIndex" class="table-designer-properties index-properties"><label><span>{{ $t('排序') }}</span><el-select v-model="selectedIndex.collation"><el-option :label="$t('默认')" value="" /><el-option label="ASC" value="ASC" /><el-option label="DESC" value="DESC" /></el-select></label><label><span>{{ $t('基数') }}</span><el-input v-model="selectedIndex.cardinality" inputmode="numeric" /></label><label><span>{{ $t('压缩') }}</span><el-checkbox v-model="selectedIndex.packed" /></label><label><span>{{ $t('键块大小') }}</span><el-input-number v-model="selectedIndex.keyBlockSize" :min="0" controls-position="right" /></label><label><span>{{ $t('解析器') }}</span><el-input v-model="selectedIndex.parser" /></label><label><span>{{ $t('不可见') }}</span><el-checkbox v-model="selectedIndex.invisible" /></label><div class="index-column-settings is-wide"><header><span>{{ $t('索引字段') }}</span><small>{{ $t('键长度 / 排序') }}</small></header><div v-for="column in selectedIndex.columns" :key="column"><strong>{{ column }}</strong><el-input v-model="indexColumnSetting(selectedIndex, column).length" inputmode="numeric" :placeholder="$t('键长度')" /><el-select v-model="indexColumnSetting(selectedIndex, column).order"><el-option :label="$t('默认')" value="" /><el-option label="ASC" value="ASC" /><el-option label="DESC" value="DESC" /></el-select></div></div></section>
          <div v-if="!indexes.length" class="table-designer-empty"><KeyRound :size="26" /><span>{{ $t('使用“添加”创建普通、唯一或全文索引') }}</span></div>
        </div>

        <div v-else-if="activeTab === 'foreignKeys'" class="table-designer-grid-wrap">
          <table class="table-designer-grid table-designer-foreign-keys"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('字段') }}</th><th>{{ $t('引用数据库') }}</th><th>{{ $t('引用表') }}</th><th>{{ $t('引用字段') }}</th><th>{{ $t('删除时') }}</th><th>{{ $t('更新时') }}</th></tr></thead><tbody><tr v-for="item in foreignKeys" :key="item.id" :class="{ 'is-selected': selectedForeignKeyId === item.id }" @click="selectedForeignKeyId = item.id"><td><el-input v-model="item.name" maxlength="64" /></td><td><el-select v-model="item.columns" multiple filterable collapse-tags><el-option v-for="name in fieldNames" :key="name" :label="name" :value="name" /></el-select></td><td><el-input v-model="item.referencedDatabase" maxlength="64" /></td><td><el-input v-model="item.referencedTable" maxlength="64" /></td><td><el-input :model-value="item.referencedColumns.join(', ')" :placeholder="$t('例如 id, tenant_id')" @update:model-value="updateCommaList(item, 'referencedColumns', $event)" /></td><td><el-select v-model="item.onDelete"><el-option v-for="value in ['RESTRICT','CASCADE','SET NULL','NO ACTION'] as ForeignKeyAction[]" :key="value" :label="value" :value="value" /></el-select></td><td><el-select v-model="item.onUpdate"><el-option v-for="value in ['RESTRICT','CASCADE','SET NULL','NO ACTION'] as ForeignKeyAction[]" :key="value" :label="value" :value="value" /></el-select></td></tr></tbody></table>
          <div v-if="!foreignKeys.length" class="table-designer-empty"><Link2 :size="26" /><span>{{ $t('使用“添加”定义外键关系') }}</span></div>
        </div>

        <div v-else-if="activeTab === 'triggers'" class="table-designer-trigger-layout">
          <div class="table-designer-grid-wrap"><table class="table-designer-grid table-designer-triggers"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('时间') }}</th><th>{{ $t('插入') }}</th><th>{{ $t('更新') }}</th><th>{{ $t('删除') }}</th></tr></thead><tbody><tr v-for="item in triggers" :key="item.id" :class="{ 'is-selected': selectedTriggerId === item.id }" @click="selectedTriggerId = item.id"><td><el-input v-model="item.name" maxlength="64" /></td><td><el-select v-model="item.timing"><el-option label="BEFORE" value="BEFORE" /><el-option label="AFTER" value="AFTER" /></el-select></td><td><el-checkbox :model-value="item.event === 'INSERT'" @change="setTriggerEvent(item, 'INSERT')" /></td><td><el-checkbox :model-value="item.event === 'UPDATE'" @change="setTriggerEvent(item, 'UPDATE')" /></td><td><el-checkbox :model-value="item.event === 'DELETE'" @change="setTriggerEvent(item, 'DELETE')" /></td></tr></tbody></table></div>
          <section class="table-trigger-source"><header>{{ $t('源代码') }}</header><el-input v-if="selectedTrigger" v-model="selectedTrigger.statement" type="textarea" resize="none" :placeholder="$t('例如 SET NEW.updated_at = CURRENT_TIMESTAMP')" /><div v-else class="table-designer-empty"><Zap :size="26" /><span>{{ $t('选择触发器后编辑源代码') }}</span></div></section>
          <div v-if="!triggers.length" class="table-designer-empty"><Zap :size="26" /><span>{{ $t('使用“添加”创建随表保存的简单触发器') }}</span></div>
        </div>

        <div v-else-if="activeTab === 'checks'" class="table-designer-grid-wrap">
          <table class="table-designer-grid"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('检查表达式') }}</th></tr></thead><tbody><tr v-for="item in checks" :key="item.id" :class="{ 'is-selected': selectedCheckId === item.id }" @click="selectedCheckId = item.id"><td><el-input v-model="item.name" maxlength="64" /></td><td><el-input v-model="item.expression" :placeholder="$t('例如 amount >= 0')" /></td></tr></tbody></table>
          <div v-if="!checks.length" class="table-designer-empty"><BadgeCheck :size="26" /><span>{{ $t('使用“添加”定义检查约束') }}</span></div>
        </div>

        <section v-else-if="activeTab === 'options'" class="table-designer-options">
          <el-form label-position="right" label-width="128px">
            <el-form-item :label="$t('引擎:')"><el-select v-model="engine" filterable allow-create><el-option v-for="value in ['InnoDB','MyISAM','MEMORY','CSV','ARCHIVE','BLACKHOLE','MERGE','Aria']" :key="value" :label="value" :value="value" /></el-select></el-form-item>
            <el-form-item :label="$t('表空间:')"><el-input v-model="tablespace" /></el-form-item>
            <el-form-item :label="$t('默认字符集:')"><el-input v-model="charset" placeholder="utf8mb4" /></el-form-item>
            <el-form-item :label="$t('默认排序规则:')"><el-input v-model="collation" :placeholder="$t('跟随数据库默认值')" /></el-form-item>
            <el-form-item :label="$t('最小行数:')"><el-input-number v-model="minRows" :min="0" :controls="false" /></el-form-item>
            <el-form-item :label="$t('平均行长度:')"><el-input-number v-model="averageRowLength" :min="0" :controls="false" /></el-form-item>
            <el-form-item :label="$t('键块大小:')"><el-input-number v-model="keyBlockSize" :min="0" :controls="false" /></el-form-item>
            <el-form-item :label="$t('最大行数:')"><el-input-number v-model="maxRows" :min="0" :controls="false" /></el-form-item>
            <el-form-item :label="$t('行格式:')"><el-select v-model="rowFormat" clearable><el-option v-for="value in ['DYNAMIC','COMPACT','REDUNDANT','COMPRESSED','FIXED']" :key="value" :label="value" :value="value" /></el-select></el-form-item>
            <el-form-item :label="$t('自动递增:')"><el-input-number v-model="autoIncrement" :min="1" :controls="false" /></el-form-item>
            <el-form-item :label="$t('分区:')"><el-input v-model="partition" :placeholder="$t('例如 HASH(id) PARTITIONS 4')" /></el-form-item>
            <el-form-item :label="$t('数据目录:')"><el-input v-model="dataDirectory" /></el-form-item>
            <el-form-item :label="$t('索引目录:')"><el-input v-model="indexDirectory" /></el-form-item>
            <el-form-item :label="$t('延迟键写入:')"><el-select v-model="delayKeyWrite"><el-option :label="$t('服务器默认')" :value="null" /><el-option :label="$t('启用')" :value="true" /><el-option :label="$t('禁用')" :value="false" /></el-select></el-form-item>
            <el-form-item :label="$t('封装键:')"><el-select v-model="packKeys"><el-option :label="$t('服务器默认')" value="" /><el-option label="DEFAULT" value="DEFAULT" /><el-option :label="$t('启用')" value="1" /><el-option :label="$t('禁用')" value="0" /></el-select></el-form-item>
            <el-form-item :label="$t('校验和:')"><el-select v-model="checksum"><el-option :label="$t('服务器默认')" :value="null" /><el-option :label="$t('启用')" :value="true" /><el-option :label="$t('禁用')" :value="false" /></el-select></el-form-item>
            <el-form-item :label="$t('页校验和:')"><el-select v-model="pageChecksum"><el-option :label="$t('服务器默认')" :value="null" /><el-option :label="$t('启用')" :value="true" /><el-option :label="$t('禁用')" :value="false" /></el-select></el-form-item>
            <el-form-item :label="$t('连接:')"><el-input v-model="connectionOption" /></el-form-item>
            <el-form-item :label="$t('加密:')"><el-select v-model="encryption"><el-option :label="$t('服务器默认')" value="" /><el-option :label="$t('是')" value="Y" /><el-option :label="$t('否')" value="N" /></el-select></el-form-item>
            <el-form-item :label="$t('并集表:')"><el-input v-model="unionTables" :placeholder="$t('例如 `db`.`table_a`, `db`.`table_b`')" /></el-form-item>
            <el-form-item :label="$t('插入方法:')"><el-select v-model="insertMethod"><el-option :label="$t('服务器默认')" value="" /><el-option label="NO" value="NO" /><el-option label="FIRST" value="FIRST" /><el-option label="LAST" value="LAST" /></el-select></el-form-item>
            <el-form-item :label="$t('统计数据持久:')"><el-select v-model="statsPersistent"><el-option :label="$t('服务器默认')" value="" /><el-option label="DEFAULT" value="DEFAULT" /><el-option :label="$t('启用')" value="1" /><el-option :label="$t('禁用')" value="0" /></el-select></el-form-item>
            <el-form-item :label="$t('统计自动重计:')"><el-select v-model="statsAutoRecalc"><el-option :label="$t('服务器默认')" value="" /><el-option label="DEFAULT" value="DEFAULT" /><el-option :label="$t('启用')" value="1" /><el-option :label="$t('禁用')" value="0" /></el-select></el-form-item>
            <el-form-item :label="$t('统计样本页面:')"><el-input-number v-model="statsSamplePages" :min="1" :controls="false" /></el-form-item>
            <el-form-item :label="$t('事务:')"><el-select v-model="transactional"><el-option :label="$t('服务器默认')" :value="null" /><el-option :label="$t('启用')" :value="true" /><el-option :label="$t('禁用')" :value="false" /></el-select></el-form-item>
          </el-form>
        </section>

        <section v-else-if="activeTab === 'comment'" class="table-designer-comment"><el-input v-model="comment" type="textarea" :rows="10" maxlength="2048" show-word-limit :placeholder="$t('数据表注释')" /></section>
        <section v-else class="table-designer-sql"><pre>{{ sqlPreview }}</pre></section>
      </main>

      <footer class="table-designer-status">
        <span>{{ loadError ? $t('结构未加载') : `${$t('字段数:')} ${fields.length}` }}</span>
        <span v-if="validationErrors.length" class="is-error">{{ validationErrors.join('；') }}</span>
        <span v-else-if="loadError" class="is-error">{{ loadError }}</span>
        <span v-else>{{ database }} · {{ table ? $t('设计 {0}', [table]) : engine }}</span>
      </footer>
    </section>
  </Teleport>
</template>
