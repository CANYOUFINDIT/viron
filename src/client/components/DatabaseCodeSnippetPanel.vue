<script setup lang="ts">import { translate as tr } from "../i18n";

import { BookOpenText, Pencil, Plus, Search, Trash2, X } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api";

interface SnippetItem { id: string; name: string; description: string; sql: string; builtin?: boolean }

const props = defineProps<{ visible: boolean; currentSql: string }>();
const emit = defineEmits<{ close: []; insert: [sql: string] }>();

const builtins: SnippetItem[] = [
  { id: "builtin-select", name: tr("SELECT 查询"), description: tr("基础查询模板"), sql: "SELECT *\nFROM table_name\nWHERE condition;", builtin: true },
  { id: "builtin-insert", name: tr("INSERT 记录"), description: tr("插入单条记录"), sql: "INSERT INTO table_name (column_name)\nVALUES (value);", builtin: true },
  { id: "builtin-update", name: tr("UPDATE 记录"), description: tr("按条件更新记录"), sql: "UPDATE table_name\nSET column_name = value\nWHERE condition;", builtin: true },
  { id: "builtin-delete", name: tr("DELETE 记录"), description: tr("按条件删除记录"), sql: "DELETE FROM table_name\nWHERE condition;", builtin: true },
  { id: "builtin-cte", name: tr("公用表表达式"), description: tr("WITH 查询模板"), sql: "WITH result AS (\n  SELECT * FROM table_name\n)\nSELECT * FROM result;", builtin: true },
];

const loading = ref(false);
const search = ref("");
const saved = ref<SnippetItem[]>([]);
const selectedId = ref(builtins[0].id);
const editorOpen = ref(false);
const editing = ref<SnippetItem | null>(null);
const name = ref("");
const description = ref("");
const sql = ref("");
const allItems = computed(() => [...builtins, ...saved.value]);
const filtered = computed(() => allItems.value.filter((item) => !search.value || `${item.name} ${item.description} ${item.sql}`.toLowerCase().includes(search.value.toLowerCase())));
const selected = computed(() => allItems.value.find((item) => item.id === selectedId.value) ?? filtered.value[0] ?? null);

async function load() {
  loading.value = true;
  try {
    const response = await api<{ items: SnippetItem[] }>("/api/v1/database-code-snippets");
    saved.value = response.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载代码段失败"));
  } finally {
    loading.value = false;
  }
}

function newSnippet() {
  editing.value = null;
  name.value = "";
  description.value = "";
  sql.value = props.currentSql.trim();
  editorOpen.value = true;
}

function editSnippet(item: SnippetItem) {
  if (item.builtin) return;
  editing.value = item;
  name.value = item.name;
  description.value = item.description;
  sql.value = item.sql;
  editorOpen.value = true;
}

async function saveSnippet() {
  if (!name.value.trim() || !sql.value.trim()) return ElMessage.warning(tr("请输入代码段名称和 SQL"));
  try {
    const payload = { name: name.value.trim(), description: description.value.trim(), sql: sql.value };
    if (editing.value) await api(`/api/v1/database-code-snippets/${editing.value.id}`, { method: "PUT", body: JSON.stringify(payload) });
    else await api("/api/v1/database-code-snippets", { method: "POST", body: JSON.stringify(payload) });
    editorOpen.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存代码段失败"));
  }
}

async function deleteSnippet(item: SnippetItem) {
  if (item.builtin) return;
  try {
    await ElMessageBox.confirm(tr("确定删除代码段“{0}”吗？", [item.name]), tr("删除代码段"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/database-code-snippets/${item.id}`, { method: "DELETE" });
    selectedId.value = builtins[0].id;
    await load();
  } catch { /* cancelled */ }
}

watch(() => props.visible, (visible) => { if (visible) void load(); });
onMounted(() => { if (props.visible) void load(); });
</script>

<template>
  <aside v-if="visible" class="database-code-snippet-panel" v-loading="loading">
    <header><div><BookOpenText :size="17" /><strong>{{ $t('代码段') }}</strong></div><button :title="$t('关闭')" @click="emit('close')"><X :size="15" /></button></header>
    <div class="database-code-snippet-actions"><el-input v-model="search" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="13" /></template></el-input><button :title="$t('新建代码段')" @click="newSnippet"><Plus :size="15" /></button></div>
    <div class="database-code-snippet-list"><button v-for="item in filtered" :key="item.id" :class="{ 'is-selected': selectedId === item.id }" @click="selectedId = item.id" @dblclick="emit('insert', item.sql)"><BookOpenText :size="13" /><span><strong>{{ item.name }}</strong><small>{{ item.description || (item.builtin ? $t('内置代码段') : $t('用户代码段')) }}</small></span></button></div>
    <section v-if="selected" class="database-code-snippet-preview"><header><strong>{{ selected.name }}</strong><span><button v-if="!selected.builtin" :title="$t('编辑')" @click="editSnippet(selected)"><Pencil :size="13" /></button><button v-if="!selected.builtin" :title="$t('删除')" @click="deleteSnippet(selected)"><Trash2 :size="13" /></button></span></header><pre>{{ selected.sql }}</pre><button class="snippet-insert" @click="emit('insert', selected.sql)">{{ $t('插入代码段') }}</button></section>
  </aside>

  <el-dialog v-model="editorOpen" class="database-navicat-dialog" :title="editing ? $t('编辑代码段') : $t('新建代码段')" width="620px" append-to-body destroy-on-close><div class="database-code-snippet-editor"><label><span>{{ $t('名称') }}</span><el-input v-model="name" maxlength="160" /></label><label><span>{{ $t('描述') }}</span><el-input v-model="description" maxlength="500" /></label><label><span>SQL</span><el-input v-model="sql" type="textarea" :rows="12" /></label></div><template #footer><el-button @click="editorOpen = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="saveSnippet">{{ $t('保存') }}</el-button></template></el-dialog>
</template>
