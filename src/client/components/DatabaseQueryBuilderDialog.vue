<script setup lang="ts">import { translate as tr } from "../i18n";

import { ChevronRight, Database, Minus, Plus, Search, Table2 } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { api } from "../api";

interface TableItem { name: string }
interface DesignField { name: string; type: string; primaryKey?: boolean }
interface BuilderTable { name: string; alias: string; fields: DesignField[] }
interface BuilderField { id: string; table: string; field: string; alias: string; aggregate: string; sort: string }

const props = defineProps<{ visible: boolean; connectionId: string; database: string }>();
const emit = defineEmits<{ close: []; build: [sql: string, run: boolean] }>();

const loading = ref(false);
const search = ref("");
const tables = ref<TableItem[]>([]);
const selectedTables = ref<BuilderTable[]>([]);
const fields = ref<BuilderField[]>([]);
const activeClause = ref<"select" | "from" | "where" | "group" | "having" | "order" | "limit">("select");
const relationshipMode = ref<"table" | "field">("field");
const distinct = ref(false);
const fromExpression = ref("");
const whereExpression = ref("");
const groupExpression = ref("");
const havingExpression = ref("");
const orderExpression = ref("");
const limitValue = ref("");

const filteredTables = computed(() => tables.value.filter((item) => !search.value || item.name.toLowerCase().includes(search.value.toLowerCase())));
const previewSql = computed(() => buildSql());

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function qualified(table: BuilderTable): string {
  const source = `${identifier(props.database)}.${identifier(table.name)}`;
  return table.alias.trim() ? `${source} AS ${identifier(table.alias.trim())}` : source;
}

function tableReference(name: string): string {
  const table = selectedTables.value.find((item) => item.name === name);
  return identifier(table?.alias.trim() || name);
}

function buildSql(): string {
  const selected = fields.value.map((item) => {
    const value = `${tableReference(item.table)}.${identifier(item.field)}`;
    const expression = item.aggregate ? `${item.aggregate}(${value})` : value;
    return item.alias.trim() ? `${expression} AS ${identifier(item.alias.trim())}` : expression;
  });
  const selectSql = `SELECT${distinct.value ? " DISTINCT" : ""}\n  ${selected.length ? selected.join(",\n  ") : "*"}`;
  const fromSql = fromExpression.value.trim() || selectedTables.value.map(qualified).join(",\n  ");
  const clauses = [selectSql];
  if (fromSql) clauses.push(`FROM\n  ${fromSql}`);
  if (whereExpression.value.trim()) clauses.push(`WHERE ${whereExpression.value.trim()}`);
  if (groupExpression.value.trim()) clauses.push(`GROUP BY ${groupExpression.value.trim()}`);
  if (havingExpression.value.trim()) clauses.push(`HAVING ${havingExpression.value.trim()}`);
  const fieldOrder = fields.value.filter((item) => item.sort).map((item) => `${tableReference(item.table)}.${identifier(item.field)} ${item.sort}`);
  const order = orderExpression.value.trim() || fieldOrder.join(", ");
  if (order) clauses.push(`ORDER BY ${order}`);
  if (limitValue.value.trim()) clauses.push(`LIMIT ${Math.max(0, Number.parseInt(limitValue.value, 10) || 0)}`);
  return `${clauses.join("\n")}\n;`;
}

async function loadTables() {
  if (!props.connectionId || !props.database) return;
  loading.value = true;
  try {
    const [tableResponse, viewResponse] = await Promise.all([
      api<{ items: TableItem[] }>(`/api/v1/database-connections/${props.connectionId}/objects?database=${encodeURIComponent(props.database)}&category=tables`),
      api<{ items: TableItem[] }>(`/api/v1/database-connections/${props.connectionId}/objects?database=${encodeURIComponent(props.database)}&category=views`),
    ]);
    tables.value = [...tableResponse.items, ...viewResponse.items];
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载查询对象失败"));
  } finally {
    loading.value = false;
  }
}

async function addTable(item: TableItem) {
  if (selectedTables.value.some((table) => table.name === item.name)) return;
  try {
    const response = await api<{ design: { fields: DesignField[] } }>(`/api/v1/database-connections/${props.connectionId}/table-design?database=${encodeURIComponent(props.database)}&table=${encodeURIComponent(item.name)}`);
    selectedTables.value.push({ name: item.name, alias: "", fields: response.design.fields });
  } catch {
    selectedTables.value.push({ name: item.name, alias: "", fields: [] });
  }
}

function removeTable(name: string) {
  selectedTables.value = selectedTables.value.filter((item) => item.name !== name);
  fields.value = fields.value.filter((item) => item.table !== name);
}

function addField(table: BuilderTable, field: DesignField) {
  if (fields.value.some((item) => item.table === table.name && item.field === field.name)) return;
  fields.value.push({ id: `${table.name}:${field.name}`, table: table.name, field: field.name, alias: "", aggregate: "", sort: "" });
}

function removeField(id: string) {
  fields.value = fields.value.filter((item) => item.id !== id);
}

function reset() {
  search.value = "";
  selectedTables.value = [];
  fields.value = [];
  activeClause.value = "select";
  relationshipMode.value = "field";
  distinct.value = false;
  fromExpression.value = "";
  whereExpression.value = "";
  groupExpression.value = "";
  havingExpression.value = "";
  orderExpression.value = "";
  limitValue.value = "";
}

function finish(run: boolean) {
  emit("build", previewSql.value, run);
  emit("close");
}

watch(() => props.visible, (visible) => {
  if (!visible) return;
  reset();
  void loadTables();
});
</script>

<template>
  <el-dialog :model-value="visible" class="database-query-builder-dialog" :title="$t('查询创建工具 · {0}', [database])" width="min(1180px, 94vw)" append-to-body destroy-on-close :close-on-click-modal="false" @close="emit('close')">
    <div class="database-query-builder" v-loading="loading">
      <aside class="query-builder-object-list"><el-input v-model="search" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="14" /></template></el-input><button v-for="item in filteredTables" :key="item.name" @dblclick="addTable(item)" @click="addTable(item)"><Table2 :size="14" /><span>{{ item.name }}</span><ChevronRight :size="13" /></button></aside>
      <main class="query-builder-main">
        <section class="query-builder-canvas">
          <article v-for="table in selectedTables" :key="table.name"><header><Table2 :size="14" /><strong>{{ table.name }}</strong><el-input v-model="table.alias" :placeholder="$t('别名')" /><button :title="$t('移除表')" @click="removeTable(table.name)"><Minus :size="13" /></button></header><button v-for="field in table.fields" :key="field.name" @dblclick="addField(table, field)" @click="addField(table, field)"><span>{{ field.primaryKey ? 'PK' : '' }} {{ field.name }}</span><small>{{ field.type }}</small></button></article><div v-if="!selectedTables.length" class="query-builder-empty"><Database :size="28" /><span>{{ $t('将表或视图添加到此处') }}</span></div>
        </section>
        <div class="query-builder-relation-mode"><el-radio-group v-model="relationshipMode"><el-radio value="table">{{ $t('表关系') }}</el-radio><el-radio value="field">{{ $t('字段关系') }}</el-radio></el-radio-group></div>
        <nav class="query-builder-clauses"><button :class="{ 'is-active': activeClause === 'select' }" @click="activeClause = 'select'">SELECT</button><button :class="{ 'is-active': activeClause === 'from' }" @click="activeClause = 'from'">FROM</button><button :class="{ 'is-active': activeClause === 'where' }" @click="activeClause = 'where'">WHERE</button><button :class="{ 'is-active': activeClause === 'group' }" @click="activeClause = 'group'">GROUP BY</button><button :class="{ 'is-active': activeClause === 'having' }" @click="activeClause = 'having'">HAVING</button><button :class="{ 'is-active': activeClause === 'order' }" @click="activeClause = 'order'">ORDER BY</button><button :class="{ 'is-active': activeClause === 'limit' }" @click="activeClause = 'limit'">LIMIT</button></nav>
        <section class="query-builder-clause-editor">
          <template v-if="activeClause === 'select'"><table><thead><tr><th></th><th>{{ $t('表') }}</th><th>{{ $t('字段') }}</th><th>{{ $t('聚合') }}</th><th>{{ $t('别名') }}</th><th>{{ $t('排序') }}</th></tr></thead><tbody><tr v-for="field in fields" :key="field.id"><td><button @click="removeField(field.id)"><Minus :size="12" /></button></td><td>{{ field.table }}</td><td>{{ field.field }}</td><td><el-select v-model="field.aggregate"><el-option :label="$t('无')" value="" /><el-option label="COUNT" value="COUNT" /><el-option label="SUM" value="SUM" /><el-option label="AVG" value="AVG" /><el-option label="MIN" value="MIN" /><el-option label="MAX" value="MAX" /></el-select></td><td><el-input v-model="field.alias" /></td><td><el-select v-model="field.sort"><el-option :label="$t('无')" value="" /><el-option label="ASC" value="ASC" /><el-option label="DESC" value="DESC" /></el-select></td></tr></tbody></table><button class="query-builder-add-field" :disabled="!selectedTables[0]?.fields[0]" @click="selectedTables[0] && selectedTables[0].fields[0] && addField(selectedTables[0], selectedTables[0].fields[0])"><Plus :size="13" />{{ $t('添加字段') }}</button><el-checkbox v-model="distinct">{{ $t('非重复') }}</el-checkbox></template>
          <el-input v-else-if="activeClause === 'from'" v-model="fromExpression" type="textarea" :rows="5" :placeholder="$t('留空时按已选择的数据表生成 FROM')" />
          <el-input v-else-if="activeClause === 'where'" v-model="whereExpression" type="textarea" :rows="5" :placeholder="$t('例如 status = \'active\'')" />
          <el-input v-else-if="activeClause === 'group'" v-model="groupExpression" type="textarea" :rows="5" :placeholder="$t('例如 department_id')" />
          <el-input v-else-if="activeClause === 'having'" v-model="havingExpression" type="textarea" :rows="5" :placeholder="$t('例如 COUNT(*) > 1')" />
          <el-input v-else-if="activeClause === 'order'" v-model="orderExpression" type="textarea" :rows="5" :placeholder="$t('留空时使用 SELECT 字段的排序设置')" />
          <el-input v-else v-model="limitValue" type="number" min="0" :placeholder="$t('返回行数')" />
        </section>
        <pre class="query-builder-preview">{{ previewSql }}</pre>
      </main>
    </div>
    <template #footer><el-button @click="emit('close')">{{ $t('取消') }}</el-button><el-button type="primary" @click="finish(false)">{{ $t('构建') }}</el-button><el-button type="primary" @click="finish(true)">{{ $t('构建并运行') }}</el-button></template>
  </el-dialog>
</template>
