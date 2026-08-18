<script setup lang="ts">import { translate as tr } from "../i18n";

import { BarChart3, Database, LayoutDashboard, Palette, Plus, RefreshCw, Save, Search, TableProperties, Trash2 } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { createClientId } from "../client-id";

interface ConnectionItem { id: string; name: string }
interface QueryJob { id: string; status: "pending" | "running" | "success" | "error" | "cancelled"; error?: string; resultSets: Array<{ columns: Array<{ name: string }>; rows: Array<Record<string, unknown>> }> }
interface DataSource { id: string; name: string; connectionId: string; database: string; sql: string; columns: string[]; rows: Array<Record<string, unknown>> }
interface ChartItem { id: string; name: string; type: "bar" | "line" | "pie" | "table"; sourceId: string; categoryField: string; valueField: string }
interface DashboardItem { id: string; name: string; chartIds: string[] }
interface BiDocument { theme: "system" | "light" | "dark"; dataSources: DataSource[]; charts: ChartItem[]; dashboards: DashboardItem[] }
interface BiWorkspaceItem { id: string; connectionId: string | null; name: string; document: BiDocument; ownerName: string; createdAt: string; updatedAt: string; accessedAt: string }

const props = defineProps<{ connectionId: string; database: string; connections: ConnectionItem[] }>();
const emit = defineEmits<{ dirtyChange: [dirty: boolean] }>();

const mode = ref<"list" | "editor">("list");
const loading = ref(false);
const saving = ref(false);
const search = ref("");
const items = ref<BiWorkspaceItem[]>([]);
const currentId = ref("");
const name = ref("");
const workspaceConnectionId = ref(props.connectionId);
const theme = ref<BiDocument["theme"]>("system");
const dataSources = ref<DataSource[]>([]);
const charts = ref<ChartItem[]>([]);
const dashboards = ref<DashboardItem[]>([]);
const activeView = ref<"workspace" | "sources" | "charts" | "dashboards">("workspace");
const sourceDialog = ref(false);
const sourceEditingId = ref("");
const sourceName = ref("");
const sourceConnectionId = ref(props.connectionId);
const sourceDatabase = ref(props.database);
const sourceSql = ref("SELECT * FROM table_name LIMIT 100;");
const sourcePreview = ref<DataSource | null>(null);
const chartDialog = ref(false);
const chartName = ref("");
const chartType = ref<ChartItem["type"]>("bar");
const chartSourceId = ref("");
const chartCategory = ref("");
const chartValue = ref("");
const dashboardDialog = ref(false);
const dashboardName = ref("");
const dashboardCharts = ref<string[]>([]);
let baseline = "";

const filteredItems = computed(() => items.value.filter((item) => !search.value || item.name.toLowerCase().includes(search.value.toLowerCase())));
const documentJson = computed(() => JSON.stringify({ name: name.value, connectionId: workspaceConnectionId.value, theme: theme.value, dataSources: dataSources.value, charts: charts.value, dashboards: dashboards.value }));
const selectedChartSource = computed(() => dataSources.value.find((item) => item.id === chartSourceId.value) ?? null);

function markBaseline() {
  baseline = documentJson.value;
  emit("dirtyChange", false);
}

watch(documentJson, (value) => emit("dirtyChange", mode.value === "editor" && value !== baseline));

async function load() {
  loading.value = true;
  try {
    const response = await api<{ items: BiWorkspaceItem[] }>("/api/v1/database-bi-workspaces");
    items.value = response.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载 BI 工作区失败"));
  } finally {
    loading.value = false;
  }
}

function newWorkspace() {
  currentId.value = "";
  name.value = "";
  workspaceConnectionId.value = props.connectionId;
  theme.value = "system";
  dataSources.value = [];
  charts.value = [];
  dashboards.value = [];
  activeView.value = "workspace";
  mode.value = "editor";
  markBaseline();
}

function sqlIdentifier(value: string) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function createFromObject(database: string, category: string, objectName: string) {
  newWorkspace();
  name.value = `${objectName} BI`;
  sourceName.value = objectName;
  sourceConnectionId.value = props.connectionId || workspaceConnectionId.value;
  sourceDatabase.value = database;
  sourceSql.value = `SELECT * FROM ${sqlIdentifier(database)}.${sqlIdentifier(objectName)} LIMIT 500;`;
  sourcePreview.value = null;
  sourceDialog.value = true;
  if (category === "queries") sourceSql.value = objectName;
}

function openWorkspace(item: BiWorkspaceItem) {
  currentId.value = item.id;
  name.value = item.name;
  workspaceConnectionId.value = item.connectionId || props.connectionId;
  theme.value = item.document.theme || "system";
  dataSources.value = JSON.parse(JSON.stringify(item.document.dataSources || []));
  charts.value = JSON.parse(JSON.stringify(item.document.charts || []));
  dashboards.value = JSON.parse(JSON.stringify(item.document.dashboards || []));
  activeView.value = "workspace";
  mode.value = "editor";
  markBaseline();
  void api(`/api/v1/database-bi-workspaces/${item.id}/access`, { method: "POST" }).catch(() => undefined);
}

async function save(): Promise<boolean> {
  if (!name.value.trim()) {
    try {
      const response = await ElMessageBox.prompt(tr("请输入 BI 工作区名称"), tr("保存工作区"), { confirmButtonText: tr("保存"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入名称") });
      name.value = response.value.trim();
    } catch { return false; }
  }
  saving.value = true;
  try {
    const payload = { connectionId: workspaceConnectionId.value || null, name: name.value, document: { theme: theme.value, dataSources: dataSources.value, charts: charts.value, dashboards: dashboards.value } };
    if (currentId.value) await api(`/api/v1/database-bi-workspaces/${currentId.value}`, { method: "PUT", body: JSON.stringify(payload) });
    else {
      const response = await api<{ item: BiWorkspaceItem }>("/api/v1/database-bi-workspaces", { method: "POST", body: JSON.stringify(payload) });
      currentId.value = response.item.id;
    }
    await load();
    markBaseline();
    ElMessage.success(tr("BI 工作区已保存"));
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存 BI 工作区失败"));
    return false;
  } finally {
    saving.value = false;
  }
}

async function deleteWorkspace(item: BiWorkspaceItem) {
  try {
    await ElMessageBox.confirm(tr("确定删除 BI 工作区“{0}”吗？", [item.name]), tr("删除 BI 工作区"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/database-bi-workspaces/${item.id}`, { method: "DELETE" });
    await load();
  } catch { /* cancelled */ }
}

function newSource() {
  sourceEditingId.value = "";
  sourceName.value = tr("数据源 {0}", [dataSources.value.length + 1]);
  sourceConnectionId.value = props.connectionId || workspaceConnectionId.value;
  sourceDatabase.value = props.database;
  sourceSql.value = "SELECT * FROM table_name LIMIT 100;";
  sourcePreview.value = null;
  sourceDialog.value = true;
}

function editSource(source: DataSource) {
  sourceEditingId.value = source.id;
  sourceName.value = source.name;
  sourceConnectionId.value = source.connectionId;
  sourceDatabase.value = source.database;
  sourceSql.value = source.sql;
  sourcePreview.value = JSON.parse(JSON.stringify(source));
  sourceDialog.value = true;
}

async function querySource(): Promise<DataSource | null> {
  if (!sourceConnectionId.value || !sourceDatabase.value || !sourceSql.value.trim()) return null;
  try {
    const created = await api<{ job: QueryJob }>(`/api/v1/database-connections/${sourceConnectionId.value}/queries`, { method: "POST", body: JSON.stringify({ sql: sourceSql.value, database: sourceDatabase.value }) });
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await api<{ job: QueryJob }>(`/api/v1/database-queries/${created.job.id}`);
      if (["pending", "running"].includes(response.job.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        continue;
      }
      if (response.job.status !== "success") throw new Error(response.job.error || tr("数据源查询失败"));
      const result = response.job.resultSets[0];
      return { id: sourceEditingId.value || createClientId(), name: sourceName.value.trim(), connectionId: sourceConnectionId.value, database: sourceDatabase.value.trim(), sql: sourceSql.value, columns: result?.columns.map((item) => item.name) || [], rows: result?.rows.slice(0, 500) || [] };
    }
    throw new Error(tr("数据源查询超时"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("数据源查询失败"));
    return null;
  }
}

async function previewSource() {
  sourcePreview.value = await querySource();
}

async function saveSource() {
  if (!sourceName.value.trim()) return ElMessage.warning(tr("请输入数据源名称"));
  const source = sourcePreview.value || await querySource();
  if (!source) return;
  const index = dataSources.value.findIndex((item) => item.id === source.id);
  if (index >= 0) dataSources.value[index] = source;
  else dataSources.value.push(source);
  sourceDialog.value = false;
  activeView.value = "sources";
}

function newChart() {
  if (!dataSources.value.length) return ElMessage.warning(tr("请先新建数据源"));
  chartName.value = tr("图表 {0}", [charts.value.length + 1]);
  chartType.value = "bar";
  chartSourceId.value = dataSources.value[0].id;
  chartCategory.value = dataSources.value[0].columns[0] || "";
  chartValue.value = dataSources.value[0].columns[1] || dataSources.value[0].columns[0] || "";
  chartDialog.value = true;
}

function saveChart() {
  if (!chartName.value.trim() || !chartSourceId.value || !chartCategory.value || !chartValue.value) return ElMessage.warning(tr("请完整配置图表"));
  charts.value.push({ id: createClientId(), name: chartName.value.trim(), type: chartType.value, sourceId: chartSourceId.value, categoryField: chartCategory.value, valueField: chartValue.value });
  chartDialog.value = false;
  activeView.value = "charts";
}

function newDashboard() {
  if (!charts.value.length) return ElMessage.warning(tr("请先新建图表"));
  dashboardName.value = tr("仪表板 {0}", [dashboards.value.length + 1]);
  dashboardCharts.value = charts.value.map((item) => item.id);
  dashboardDialog.value = true;
}

function saveDashboard() {
  if (!dashboardName.value.trim()) return ElMessage.warning(tr("请输入仪表板名称"));
  dashboards.value.push({ id: createClientId(), name: dashboardName.value.trim(), chartIds: [...dashboardCharts.value] });
  dashboardDialog.value = false;
  activeView.value = "dashboards";
}

function nextTheme() {
  theme.value = theme.value === "system" ? "light" : theme.value === "light" ? "dark" : "system";
}

function chartSource(chart: ChartItem) {
  return dataSources.value.find((item) => item.id === chart.sourceId) ?? null;
}

function chartRows(chart: ChartItem) {
  return chartSource(chart)?.rows.slice(0, 12) ?? [];
}

function maxChartValue(chart: ChartItem) {
  return Math.max(1, ...chartRows(chart).map((row) => Number(row[chart.valueField]) || 0));
}

async function backToList() {
  if (documentJson.value !== baseline) {
    try {
      await ElMessageBox.confirm(tr("当前 BI 工作区尚未保存。"), tr("关闭工作区"), { confirmButtonText: tr("保存"), cancelButtonText: tr("不保存"), distinguishCancelAndClose: true });
      if (!await save()) return;
    } catch (action) {
      if (action !== "cancel") return;
    }
  }
  mode.value = "list";
  emit("dirtyChange", false);
  await load();
}

onMounted(() => void load());
defineExpose({ save, createFromObject });
</script>

<template>
  <section class="database-bi-workspace" :class="`is-theme-${theme}`" v-loading="loading">
    <template v-if="mode === 'list'">
      <header class="database-artifact-list-toolbar"><div><button data-navicat-action="new-bi-workspace" @click="newWorkspace"><Plus :size="17" />{{ $t('新建工作区') }}</button><button data-navicat-action="refresh" @click="load"><RefreshCw :size="17" />{{ $t('刷新') }}</button></div><el-input v-model="search" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="14" /></template></el-input></header>
      <div class="database-object-table-wrap"><table class="database-object-table"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('文件大小') }}</th><th>{{ $t('创建的用户') }}</th><th>{{ $t('创建日期') }}</th><th>{{ $t('修改的用户') }}</th><th>{{ $t('修改日期') }}</th><th>{{ $t('访问时间') }}</th><th></th></tr></thead><tbody><tr v-for="item in filteredItems" :key="item.id" tabindex="0" @dblclick="openWorkspace(item)" @keydown.enter="openWorkspace(item)"><td><span class="object-name-cell"><LayoutDashboard :size="15" />{{ item.name }}</span></td><td>{{ JSON.stringify(item.document).length }} B</td><td>{{ item.ownerName }}</td><td>{{ new Date(item.createdAt).toLocaleString($locale()) }}</td><td>{{ item.ownerName }}</td><td>{{ new Date(item.updatedAt).toLocaleString($locale()) }}</td><td>{{ new Date(item.accessedAt).toLocaleString($locale()) }}</td><td><button class="artifact-row-delete" :title="$t('删除')" @click.stop="deleteWorkspace(item)"><Trash2 :size="13" /></button></td></tr></tbody></table><div v-if="!filteredItems.length" class="object-browser-empty"><LayoutDashboard :size="25" /><span>{{ $t('没有 BI 工作区') }}</span></div></div>
      <footer><span>{{ filteredItems.length }} {{ $t('个 BI 工作区') }}</span></footer>
    </template>

    <template v-else>
      <header class="database-bi-toolbar"><button data-navicat-action="save" :disabled="saving" @click="save"><Save :size="17" />{{ $t('保存') }}</button><button data-navicat-action="new-data-source" @click="newSource"><Database :size="17" />{{ $t('新建数据源') }}</button><button data-navicat-action="new-chart" @click="newChart"><BarChart3 :size="17" />{{ $t('新建图表') }}</button><button data-navicat-action="new-dashboard" @click="newDashboard"><LayoutDashboard :size="17" />{{ $t('新建仪表板') }}</button><button data-navicat-action="theme" @click="nextTheme"><Palette :size="17" />{{ $t('切换布景主题') }}</button></header>
      <nav class="database-bi-tabs"><button :class="{ 'is-active': activeView === 'workspace' }" @click="activeView = 'workspace'">{{ $t('工作区') }}</button><button :class="{ 'is-active': activeView === 'sources' }" @click="activeView = 'sources'">{{ $t('数据源') }}</button><button :class="{ 'is-active': activeView === 'charts' }" @click="activeView = 'charts'">{{ $t('图表') }}</button><button :class="{ 'is-active': activeView === 'dashboards' }" @click="activeView = 'dashboards'">{{ $t('仪表板') }}</button></nav>
      <main class="database-bi-stage">
        <section v-if="activeView === 'workspace'" class="database-bi-start"><LayoutDashboard :size="42" /><strong>{{ $t('显示你的仪表板') }}</strong><p>{{ $t('创建数据源、设计图表，然后组合为仪表板。') }}</p><div><button @click="newSource"><Database :size="18" />{{ $t('创建数据源') }}</button><button :disabled="!dataSources.length" @click="newChart"><BarChart3 :size="18" />{{ $t('设计图表') }}</button><button :disabled="!charts.length" @click="newDashboard"><LayoutDashboard :size="18" />{{ $t('显示仪表板') }}</button></div></section>
        <section v-else-if="activeView === 'sources'" class="database-bi-grid"><article v-for="source in dataSources" :key="source.id" @dblclick="editSource(source)"><header><Database :size="16" /><strong>{{ source.name }}</strong><button @click.stop="dataSources = dataSources.filter((item) => item.id !== source.id)"><Trash2 :size="13" /></button></header><small>{{ source.database }} · {{ source.rows.length }} {{ $t('行') }}</small><pre>{{ source.sql }}</pre></article><div v-if="!dataSources.length" class="database-bi-empty"><Database :size="29" />{{ $t('没有数据源') }}</div></section>
        <section v-else-if="activeView === 'charts'" class="database-bi-grid"><article v-for="chart in charts" :key="chart.id" class="database-bi-chart"><header><BarChart3 :size="16" /><strong>{{ chart.name }}</strong><button @click.stop="charts = charts.filter((item) => item.id !== chart.id)"><Trash2 :size="13" /></button></header><table v-if="chart.type === 'table'"><thead><tr><th>{{ chart.categoryField }}</th><th>{{ chart.valueField }}</th></tr></thead><tbody><tr v-for="(row, index) in chartRows(chart)" :key="index"><td>{{ row[chart.categoryField] }}</td><td>{{ row[chart.valueField] }}</td></tr></tbody></table><div v-else class="database-bi-bars"><span v-for="(row, index) in chartRows(chart)" :key="index" :style="{ height: `${Math.max(5, (Number(row[chart.valueField]) || 0) / maxChartValue(chart) * 100)}%` }" :title="`${row[chart.categoryField]}: ${row[chart.valueField]}`"><i>{{ row[chart.categoryField] }}</i></span></div></article><div v-if="!charts.length" class="database-bi-empty"><BarChart3 :size="29" />{{ $t('没有图表') }}</div></section>
        <section v-else class="database-bi-dashboards"><article v-for="dashboard in dashboards" :key="dashboard.id"><header><LayoutDashboard :size="16" /><strong>{{ dashboard.name }}</strong><button @click.stop="dashboards = dashboards.filter((item) => item.id !== dashboard.id)"><Trash2 :size="13" /></button></header><div><section v-for="chart in charts.filter((item) => dashboard.chartIds.includes(item.id))" :key="chart.id"><strong>{{ chart.name }}</strong><div class="database-bi-bars"><span v-for="(row, index) in chartRows(chart)" :key="index" :style="{ height: `${Math.max(5, (Number(row[chart.valueField]) || 0) / maxChartValue(chart) * 100)}%` }"></span></div></section></div></article><div v-if="!dashboards.length" class="database-bi-empty"><LayoutDashboard :size="29" />{{ $t('没有仪表板') }}</div></section>
      </main>
      <footer class="database-bi-status"><button @click="backToList">{{ $t('返回对象列表') }}</button><span>{{ dataSources.length }} {{ $t('个数据源，') }}{{ charts.length }} {{ $t('个图表，') }}{{ dashboards.length }} {{ $t('个仪表板') }}</span></footer>
    </template>
  </section>

  <el-dialog v-model="sourceDialog" class="database-navicat-dialog" :title="$t('新建数据源')" width="760px" append-to-body destroy-on-close><div class="database-bi-source-form"><label><span>{{ $t('数据源名称') }}</span><el-input v-model="sourceName" /></label><label><span>{{ $t('连接') }}</span><el-select v-model="sourceConnectionId"><el-option v-for="connection in connections" :key="connection.id" :label="connection.name" :value="connection.id" /></el-select></label><label><span>{{ $t('数据库') }}</span><el-input v-model="sourceDatabase" /></label><label><span>SQL</span><el-input v-model="sourceSql" type="textarea" :rows="8" /></label><div v-if="sourcePreview" class="database-bi-source-preview"><table><thead><tr><th v-for="column in sourcePreview.columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="(row, index) in sourcePreview.rows.slice(0, 10)" :key="index"><td v-for="column in sourcePreview.columns" :key="column">{{ row[column] }}</td></tr></tbody></table></div></div><template #footer><el-button @click="sourceDialog = false">{{ $t('取消') }}</el-button><el-button @click="previewSource">{{ $t('预览') }}</el-button><el-button type="primary" @click="saveSource">{{ $t('确定') }}</el-button></template></el-dialog>
  <el-dialog v-model="chartDialog" class="database-navicat-dialog" :title="$t('新建图表')" width="580px" append-to-body destroy-on-close><div class="database-bi-chart-form"><label><span>{{ $t('图表名称') }}</span><el-input v-model="chartName" /></label><label><span>{{ $t('图表类型') }}</span><el-select v-model="chartType"><el-option :label="$t('柱状图')" value="bar" /><el-option :label="$t('折线图')" value="line" /><el-option :label="$t('饼图')" value="pie" /><el-option :label="$t('表格')" value="table" /></el-select></label><label><span>{{ $t('数据源') }}</span><el-select v-model="chartSourceId"><el-option v-for="source in dataSources" :key="source.id" :label="source.name" :value="source.id" /></el-select></label><label><span>{{ $t('分类字段') }}</span><el-select v-model="chartCategory"><el-option v-for="column in selectedChartSource?.columns || []" :key="column" :label="column" :value="column" /></el-select></label><label><span>{{ $t('数值字段') }}</span><el-select v-model="chartValue"><el-option v-for="column in selectedChartSource?.columns || []" :key="column" :label="column" :value="column" /></el-select></label></div><template #footer><el-button @click="chartDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="saveChart">{{ $t('确定') }}</el-button></template></el-dialog>
  <el-dialog v-model="dashboardDialog" class="database-navicat-dialog" :title="$t('新建仪表板')" width="560px" append-to-body destroy-on-close><div class="database-bi-dashboard-form"><label><span>{{ $t('仪表板名称') }}</span><el-input v-model="dashboardName" /></label><el-checkbox-group v-model="dashboardCharts"><el-checkbox v-for="chart in charts" :key="chart.id" :value="chart.id">{{ chart.name }}</el-checkbox></el-checkbox-group></div><template #footer><el-button @click="dashboardDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="saveDashboard">{{ $t('确定') }}</el-button></template></el-dialog>
</template>
