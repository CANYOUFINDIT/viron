<script setup lang="ts">import { translate as tr } from "../i18n";

import { Eye, FileCode2, Focus, Image, Layers3, LayoutGrid, Link2, MessageSquareText, Plus, RefreshCw, Save, Search, Shapes, Table2, Tag, Trash2, X } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { createClientId } from "../client-id";

interface TableField { name: string; type: string; primaryKey?: boolean; notNull?: boolean }
interface ModelNode { id: string; kind: "table" | "view" | "procedure" | "function" | "label" | "note" | "image" | "shape" | "layer"; name: string; x: number; y: number; width?: number; height?: number; fields?: TableField[]; text?: string; imageData?: string; color?: string }
interface ModelEdge { id: string; from: string; to: string; name: string }
interface ModelDocument { nodes: ModelNode[]; edges: ModelEdge[]; settings: Record<string, unknown> }
interface ModelItem {
  id: string;
  connectionId: string | null;
  database: string;
  name: string;
  modelType: "physical" | "logical" | "conceptual";
  databaseEngine: string;
  databaseVersion: string;
  model: ModelDocument;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}
interface DatabaseObject { name: string; sourceCategory?: "procedures" | "functions" }
interface TableDesignResponse { design: { fields: Array<{ name: string; type: string; primaryKey?: boolean; notNull?: boolean }>; foreignKeys: Array<{ name: string; referencedTable: string }> } }

const props = defineProps<{ connectionId: string; database: string }>();
const emit = defineEmits<{ dirtyChange: [dirty: boolean] }>();

const mode = ref<"list" | "editor">("list");
const loading = ref(false);
const saving = ref(false);
const focused = ref(false);
const preview = ref(false);
const search = ref("");
const items = ref<ModelItem[]>([]);
const currentId = ref("");
const name = ref("");
const modelType = ref<"physical" | "logical" | "conceptual">("physical");
const databaseEngine = ref("MySQL");
const databaseVersion = ref("8.1");
const nodes = ref<ModelNode[]>([]);
const edges = ref<ModelEdge[]>([]);
const selectedNodeId = ref("");
const edgeSourceId = ref("");
const createDialog = ref(false);
let baseline = "";
let dragging: { id: string; offsetX: number; offsetY: number } | null = null;

const filteredItems = computed(() => items.value.filter((item) => !search.value || `${item.name} ${item.modelType}`.toLowerCase().includes(search.value.toLowerCase())));
const selectedNode = computed(() => nodes.value.find((node) => node.id === selectedNodeId.value) ?? null);
const modelJson = computed(() => JSON.stringify({ name: name.value, modelType: modelType.value, databaseEngine: databaseEngine.value, databaseVersion: databaseVersion.value, nodes: nodes.value, edges: edges.value }));

function markBaseline() {
  baseline = modelJson.value;
  emit("dirtyChange", false);
}

watch(modelJson, (value) => emit("dirtyChange", mode.value === "editor" && value !== baseline));

async function load() {
  loading.value = true;
  try {
    const response = await api<{ items: ModelItem[] }>("/api/v1/database-models");
    items.value = response.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载模型失败"));
  } finally {
    loading.value = false;
  }
}

function newModel() {
  modelType.value = "physical";
  databaseEngine.value = "MySQL";
  databaseVersion.value = "8.1";
  createDialog.value = true;
}

function createModel() {
  currentId.value = "";
  name.value = "";
  nodes.value = [];
  edges.value = [];
  selectedNodeId.value = "";
  preview.value = false;
  mode.value = "editor";
  createDialog.value = false;
  markBaseline();
}

function openModel(item: ModelItem) {
  currentId.value = item.id;
  name.value = item.name;
  modelType.value = item.modelType;
  databaseEngine.value = item.databaseEngine;
  databaseVersion.value = item.databaseVersion;
  nodes.value = JSON.parse(JSON.stringify(item.model.nodes ?? []));
  edges.value = JSON.parse(JSON.stringify(item.model.edges ?? []));
  selectedNodeId.value = "";
  preview.value = false;
  mode.value = "editor";
  markBaseline();
  void api(`/api/v1/database-models/${item.id}/access`, { method: "POST" }).catch(() => undefined);
}

function nextNodePosition(index = nodes.value.length) {
  return { x: 36 + (index % 4) * 220, y: 38 + Math.floor(index / 4) * 180 };
}

async function promptNode(kind: ModelNode["kind"], title: string, defaultName: string) {
  try {
    const response = await ElMessageBox.prompt(tr("请输入{0}名称", [title]), tr("新建{0}", [title]), { confirmButtonText: tr("新建"), cancelButtonText: tr("取消"), inputValue: defaultName, inputValidator: (value) => Boolean(value.trim()) || tr("请输入名称") });
    const node: ModelNode = { id: createClientId(), kind, name: response.value.trim(), ...nextNodePosition() };
    if (kind === "table") node.fields = [{ name: "id", type: "BIGINT", primaryKey: true, notNull: true }];
    if (kind === "note" || kind === "label") node.text = response.value.trim();
    if (kind === "shape") { node.width = 200; node.height = 120; node.color = "#7fa7a0"; }
    if (kind === "layer") { node.width = 430; node.height = 270; node.color = "#6d817e"; }
    nodes.value.push(node);
    selectedNodeId.value = node.id;
  } catch { /* cancelled */ }
}

function addForeignKey() {
  if (nodes.value.filter((node) => node.kind === "table").length < 2) return ElMessage.warning(tr("请先创建至少两个数据表"));
  edgeSourceId.value = "";
  ElMessage.info(tr("请依次点击外键来源表和目标表"));
}

function selectNode(node: ModelNode) {
  if (!edgeSourceId.value && nodes.value.some((item) => item.id === node.id && item.kind === "table") && selectedNodeId.value === "__edge__") {
    edgeSourceId.value = node.id;
    return;
  }
  if (edgeSourceId.value && node.kind === "table" && node.id !== edgeSourceId.value) {
    edges.value.push({ id: createClientId(), from: edgeSourceId.value, to: node.id, name: `fk_${nodes.value.find((item) => item.id === edgeSourceId.value)?.name}_${node.name}` });
    edgeSourceId.value = "";
    selectedNodeId.value = node.id;
    return;
  }
  selectedNodeId.value = node.id;
}

function beginForeignKeyMode() {
  selectedNodeId.value = "__edge__";
  addForeignKey();
}

function nodeCenter(id: string) {
  const node = nodes.value.find((item) => item.id === id);
  return node ? { x: node.x + (node.width ?? 180) / 2, y: node.y + 32 } : { x: 0, y: 0 };
}

function beginDrag(event: PointerEvent, node: ModelNode) {
  if (preview.value) return;
  selectedNodeId.value = node.id;
  dragging = { id: node.id, offsetX: event.clientX - node.x, offsetY: event.clientY - node.y };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent) {
  if (!dragging) return;
  const node = nodes.value.find((item) => item.id === dragging!.id);
  if (!node) return;
  node.x = Math.max(0, event.clientX - dragging.offsetX);
  node.y = Math.max(0, event.clientY - dragging.offsetY - 96);
}

function endDrag() {
  dragging = null;
}

function autoLayout() {
  nodes.value.forEach((node, index) => Object.assign(node, nextNodePosition(index)));
}

function deleteSelected() {
  if (!selectedNode.value) return;
  const id = selectedNode.value.id;
  nodes.value = nodes.value.filter((node) => node.id !== id);
  edges.value = edges.value.filter((edge) => edge.from !== id && edge.to !== id);
  selectedNodeId.value = "";
}

async function addImage(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) return ElMessage.warning(tr("模型内图片不能超过 1 MB"));
  const reader = new FileReader();
  reader.onload = () => {
    const node: ModelNode = { id: createClientId(), kind: "image", name: file.name, imageData: String(reader.result), width: 240, height: 160, ...nextNodePosition() };
    nodes.value.push(node);
    selectedNodeId.value = node.id;
  };
  reader.readAsDataURL(file);
}

async function importExistingObjects(database = props.database, objectNames?: string[]) {
  if (!props.connectionId || !database) return;
  loading.value = true;
  try {
    const response = await api<{ items: DatabaseObject[] }>(`/api/v1/database-connections/${props.connectionId}/objects?database=${encodeURIComponent(database)}&category=tables`);
    const tableItems = objectNames ? response.items.filter((item) => objectNames.includes(item.name)) : response.items;
    const created: ModelNode[] = [];
    const pendingEdges: Array<{ from: string; targetName: string; name: string }> = [];
    for (let offset = 0; offset < tableItems.length; offset += 8) {
      const batch = tableItems.slice(offset, offset + 8);
      const designs = await Promise.all(batch.map((item) => api<TableDesignResponse>(`/api/v1/database-connections/${props.connectionId}/table-design?database=${encodeURIComponent(database)}&table=${encodeURIComponent(item.name)}`)));
      designs.forEach((design, index) => {
        const item = batch[index];
        const node: ModelNode = { id: createClientId(), kind: "table", name: item.name, fields: design.design.fields.map((field) => ({ name: field.name, type: field.type, primaryKey: field.primaryKey, notNull: field.notNull })), ...nextNodePosition(created.length) };
        created.push(node);
        for (const foreignKey of design.design.foreignKeys) pendingEdges.push({ from: node.id, targetName: foreignKey.referencedTable, name: foreignKey.name });
      });
    }
    const byName = new Map(created.map((node) => [node.name, node.id]));
    if (!objectNames) {
      const [views, routines] = await Promise.all([
        api<{ items: DatabaseObject[] }>(`/api/v1/database-connections/${props.connectionId}/objects?database=${encodeURIComponent(database)}&category=views`),
        api<{ items: DatabaseObject[] }>(`/api/v1/database-connections/${props.connectionId}/objects?database=${encodeURIComponent(database)}&category=functions`),
      ]);
      for (const item of views.items) created.push({ id: createClientId(), kind: "view", name: item.name, ...nextNodePosition(created.length) });
      for (const item of routines.items) created.push({ id: createClientId(), kind: item.sourceCategory === "procedures" ? "procedure" : "function", name: item.name, ...nextNodePosition(created.length) });
    }
    nodes.value = created;
    edges.value = pendingEdges.flatMap((edge) => byName.has(edge.targetName) ? [{ id: createClientId(), from: edge.from, to: byName.get(edge.targetName)!, name: edge.name }] : []);
    ElMessage.success(tr("已导入 {0} 个模型对象", [created.length]));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取现有模型对象失败"));
  } finally {
    loading.value = false;
  }
}

async function reverseDatabase(database: string) {
  createModel();
  name.value = tr("{0} 模型", [database]);
  markBaseline();
  await importExistingObjects(database);
}

async function reverseObject(database: string, category: string, objectName: string) {
  createModel();
  name.value = tr("{0}.{1} 模型", [database, objectName]);
  markBaseline();
  if (category === "tables") await importExistingObjects(database, [objectName]);
  else {
    const kind: ModelNode["kind"] = category === "views" ? "view" : "function";
    nodes.value = [{ id: createClientId(), kind, name: objectName, ...nextNodePosition(0) }];
  }
}

async function save(): Promise<boolean> {
  if (!name.value.trim()) {
    try {
      const response = await ElMessageBox.prompt(tr("请输入模型名称"), tr("保存模型"), { confirmButtonText: tr("保存"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入名称") });
      name.value = response.value.trim();
    } catch { return false; }
  }
  saving.value = true;
  try {
    const payload = { connectionId: props.connectionId || null, database: props.database, name: name.value, modelType: modelType.value, databaseEngine: databaseEngine.value, databaseVersion: databaseVersion.value, model: { nodes: nodes.value, edges: edges.value, settings: {} } };
    if (currentId.value) await api(`/api/v1/database-models/${currentId.value}`, { method: "PUT", body: JSON.stringify(payload) });
    else {
      const response = await api<{ item: ModelItem }>("/api/v1/database-models", { method: "POST", body: JSON.stringify(payload) });
      currentId.value = response.item.id;
    }
    await load();
    markBaseline();
    ElMessage.success(tr("模型已保存"));
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存模型失败"));
    return false;
  } finally {
    saving.value = false;
  }
}

async function deleteModel(item: ModelItem) {
  try {
    await ElMessageBox.confirm(tr("确定删除模型“{0}”吗？", [item.name]), tr("删除模型"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/database-models/${item.id}`, { method: "DELETE" });
    await load();
  } catch { /* cancelled */ }
}

async function backToList() {
  if (modelJson.value !== baseline) {
    try {
      await ElMessageBox.confirm(tr("当前模型尚未保存。"), tr("关闭模型"), { confirmButtonText: tr("保存"), cancelButtonText: tr("不保存"), distinguishCancelAndClose: true });
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
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || mode.value !== "editor") return;
  event.preventDefault();
  void save();
}

onMounted(() => {
  void load();
  document.addEventListener("keydown", handleKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", handleKeydown));

defineExpose({ save, reverseDatabase, reverseObject });
</script>

<template>
  <Teleport to="body" :disabled="!focused">
    <section class="database-model-workspace" :class="{ 'is-focused': focused }" v-loading="loading">
      <template v-if="mode === 'list'">
        <header class="database-artifact-list-toolbar"><div><button data-navicat-action="new-model" @click="newModel"><Plus :size="17" />{{ $t('新建模型') }}</button><button data-navicat-action="refresh" @click="load"><RefreshCw :size="17" />{{ $t('刷新') }}</button></div><el-input v-model="search" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="14" /></template></el-input></header>
        <div class="database-object-table-wrap"><table class="database-object-table"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('文件大小') }}</th><th>{{ $t('创建的用户') }}</th><th>{{ $t('创建日期') }}</th><th>{{ $t('修改的用户') }}</th><th>{{ $t('修改日期') }}</th><th>{{ $t('访问时间') }}</th><th></th></tr></thead><tbody><tr v-for="item in filteredItems" :key="item.id" tabindex="0" @dblclick="openModel(item)" @keydown.enter="openModel(item)"><td><span class="object-name-cell"><LayoutGrid :size="15" />{{ item.name }}</span></td><td>{{ JSON.stringify(item.model).length }} B</td><td>{{ item.ownerName }}</td><td>{{ new Date(item.createdAt).toLocaleString($locale()) }}</td><td>{{ item.ownerName }}</td><td>{{ new Date(item.updatedAt).toLocaleString($locale()) }}</td><td>{{ new Date(item.accessedAt).toLocaleString($locale()) }}</td><td><button class="artifact-row-delete" :title="$t('删除')" @click.stop="deleteModel(item)"><Trash2 :size="13" /></button></td></tr></tbody></table><div v-if="!filteredItems.length" class="object-browser-empty"><LayoutGrid :size="25" /><span>{{ $t('没有模型工作区') }}</span></div></div>
        <footer><span>{{ filteredItems.length }} {{ $t('个模型工作区') }}</span></footer>
      </template>

      <template v-else>
        <header class="database-model-toolbar">
          <button data-navicat-action="existing-objects" @click="importExistingObjects()"><Layers3 :size="17" />{{ $t('现有模型对象') }}</button>
          <button data-navicat-action="new-table" @click="promptNode('table', $t('表'), 'new_table')"><Table2 :size="17" />{{ $t('新建表') }}</button>
          <button data-navicat-action="add-foreign-key" @click="beginForeignKeyMode"><Link2 :size="17" />{{ $t('添加外键') }}</button>
          <button data-navicat-action="new-view" @click="promptNode('view', $t('视图'), 'new_view')"><Eye :size="17" />{{ $t('新建视图') }}</button>
          <button data-navicat-action="new-procedure" @click="promptNode('procedure', $t('过程'), 'new_procedure')"><FileCode2 :size="17" />{{ $t('新建过程') }}</button>
          <button data-navicat-action="new-function" @click="promptNode('function', $t('函数'), 'new_function')"><FileCode2 :size="17" />{{ $t('新建函数') }}</button>
          <button data-navicat-action="new-label" @click="promptNode('label', $t('标签'), $t('标签'))"><Tag :size="17" />{{ $t('新建标签') }}</button>
          <button data-navicat-action="new-note" @click="promptNode('note', $t('笔记'), $t('笔记'))"><MessageSquareText :size="17" />{{ $t('新建笔记') }}</button>
          <label class="model-image-action" data-navicat-action="new-image"><Image :size="17" />{{ $t('新建图像') }}<input hidden type="file" accept="image/*" @change="addImage" /></label>
          <button data-navicat-action="new-shape" @click="promptNode('shape', $t('形状'), $t('形状'))"><Shapes :size="17" />{{ $t('新建形状') }}</button>
          <button data-navicat-action="new-layer" @click="promptNode('layer', $t('图层'), $t('图层'))"><Layers3 :size="17" />{{ $t('新建图层') }}</button>
          <button data-navicat-action="auto-layout" @click="autoLayout"><LayoutGrid :size="17" />{{ $t('自动布局') }}</button>
          <button data-navicat-action="preview" :class="{ 'is-active': preview }" @click="preview = !preview"><Eye :size="17" />{{ $t('预览') }}</button>
          <button data-navicat-action="focus" @click="focused = !focused"><Focus :size="17" />{{ focused ? $t('退出专注模式') : $t('进入专注模式') }}</button>
        </header>
        <main class="database-model-stage" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag">
          <svg class="database-model-edges"><line v-for="edge in edges" :key="edge.id" :x1="nodeCenter(edge.from).x" :y1="nodeCenter(edge.from).y" :x2="nodeCenter(edge.to).x" :y2="nodeCenter(edge.to).y" /><text v-for="edge in edges" :key="`label-${edge.id}`" :x="(nodeCenter(edge.from).x + nodeCenter(edge.to).x) / 2" :y="(nodeCenter(edge.from).y + nodeCenter(edge.to).y) / 2 - 5">{{ edge.name }}</text></svg>
          <article v-for="node in nodes" :key="node.id" class="database-model-node" :class="[`is-${node.kind}`, { 'is-selected': selectedNodeId === node.id }]" :style="{ transform: `translate(${node.x}px, ${node.y}px)`, width: `${node.width || 180}px`, minHeight: `${node.height || 72}px`, borderColor: node.color }" @pointerdown="beginDrag($event, node)" @click.stop="selectNode(node)"><header><component :is="node.kind === 'table' ? Table2 : node.kind === 'image' ? Image : node.kind === 'shape' || node.kind === 'layer' ? Shapes : FileCode2" :size="14" /><strong>{{ node.name }}</strong></header><img v-if="node.imageData" :src="node.imageData" :alt="node.name" /><p v-else-if="node.text">{{ node.text }}</p><ul v-else-if="node.fields"><li v-for="field in node.fields" :key="field.name"><span>{{ field.primaryKey ? 'PK' : '' }} {{ field.name }}</span><small>{{ field.type }}</small></li></ul></article>
          <div v-if="!nodes.length" class="database-model-empty"><LayoutGrid :size="31" /><strong>{{ $t('空模型图表') }}</strong></div>
        </main>
        <aside class="database-model-properties"><header><strong>{{ selectedNode?.name || $t('图表') }}</strong><button v-if="selectedNode" @click="deleteSelected"><Trash2 :size="14" /></button></header><template v-if="selectedNode"><label><span>{{ $t('名称') }}</span><el-input v-model="selectedNode.name" /></label><label v-if="selectedNode.text !== undefined"><span>{{ $t('内容') }}</span><el-input v-model="selectedNode.text" type="textarea" /></label></template><template v-else><label><span>{{ $t('目标数据库') }}</span><el-input :model-value="`${databaseEngine} ${databaseVersion}`" disabled /></label><label><span>{{ $t('模型类型') }}</span><el-input :model-value="modelType" disabled /></label></template></aside>
        <footer class="database-model-status"><button data-navicat-action="save" :disabled="saving" @click="save"><Save :size="15" />{{ $t('保存') }}</button><button @click="backToList">{{ $t('返回对象列表') }}</button><span>{{ nodes.length }} {{ $t('个对象，') }}{{ edges.length }} {{ $t('个关系') }}</span></footer>
      </template>
    </section>
  </Teleport>

  <el-dialog v-model="createDialog" :title="$t('新建模型')" width="460px" append-to-body><div class="database-model-create"><strong>{{ $t('模型类型') }}</strong><el-radio-group v-model="modelType"><el-radio value="physical">{{ $t('物理') }}</el-radio><el-radio value="logical">{{ $t('逻辑') }}</el-radio><el-radio value="conceptual">{{ $t('概念') }}</el-radio></el-radio-group><label><span>{{ $t('目标数据库') }}</span><el-select v-model="databaseEngine"><el-option label="MySQL" value="MySQL" /><el-option label="MariaDB" value="MariaDB" /></el-select></label><label><span>{{ $t('数据库版本') }}</span><el-select v-model="databaseVersion"><el-option label="8.1" value="8.1" /><el-option label="8.0" value="8.0" /><el-option label="5.7" value="5.7" /></el-select></label></div><template #footer><el-button @click="createDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="createModel">{{ $t('好') }}</el-button></template></el-dialog>
</template>
