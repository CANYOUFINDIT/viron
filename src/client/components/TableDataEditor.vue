<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  Filter,
  FolderCog,
  FolderOpen,
  Grid3X3,
  Maximize2,
  Minimize2,
  PanelTop,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Square,
  Table2,
  Trash2,
  Upload,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition, type RowComponent } from "tabulator-tables";
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { createClientId } from "../client-id";
import { createTableFindMatch, resolveTableFindCell, type TableFindMatch } from "../database-table-find";
import { type DatabaseTableProfile, type TableProfileConfig, normalizeTableProfile } from "../database-table-profile";
import { downloadApiFile } from "../desktop";
import { onAppShortcut, shortcutActionFromKeyboardEvent } from "../keyboard-shortcuts";
import type { TableDataFilterOperator, TableDataFilterRule, TableDataSortRule } from "../../shared/database-table-data";
import TipIcon from "./TipIcon.vue";

const props = defineProps<{
  connectionId: string;
  database: string;
  table: string;
  active?: boolean;
  readOnly?: boolean;
  actionRequest?: { id: string; type: "import" | "export"; format?: "csv" | "xlsx" | "sql" };
}>();
const emit = defineEmits<{ actionHandled: [id: string] }>();

interface TableColumn {
  name: string;
  columnType: string;
  dataType: string;
  nullable: boolean;
  defaultValue: unknown;
  primary: boolean;
  unique: boolean;
  autoIncrement: boolean;
  comment: string;
}

interface TableResponse {
  columns: TableColumn[];
  primaryKey: string[];
  page: number;
  pageSize: number;
  total: number;
  rows: Array<Record<string, unknown>>;
}

interface PendingChange {
  type: "insert" | "update" | "delete";
  values: Record<string, unknown>;
  key: Record<string, unknown>;
}

interface FilterRuleDraft extends TableDataFilterRule { id: string }
interface SortRuleDraft extends TableDataSortRule { id: string }

const tableElement = ref<HTMLElement | null>(null);
const filterPanelElement = ref<HTMLElement | null>(null);
const findInputElement = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const page = ref(1);
const pageSize = ref(100);
const total = ref(0);
const columns = ref<TableColumn[]>([]);
const primaryKey = ref<string[]>([]);
const filterRules = ref<FilterRuleDraft[]>([createFilterRule()]);
const sortRules = ref<SortRuleDraft[]>([createSortRule()]);
const filterSuggestions = ref<Record<string, string[]>>({});
const suggestionLoading = ref<Set<string>>(new Set());
const suggestionGenerations = new Map<string, number>();
const suggestionRequestKeys = new Map<string, string>();
const findVisible = ref(false);
const findQuery = ref("");
const findColumn = ref("");
const findMatchIndex = ref(-1);
const findMatchCount = ref(0);
const selectedCount = ref(0);
const selectedRow = ref<Record<string, unknown> | null>(null);
const loadedRowCount = ref(0);
const importDialog = ref(false);
const importFile = ref<File | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const importMode = ref<"append" | "replace">("append");
const pending = ref<Map<string, PendingChange>>(new Map());
const hiddenColumns = ref<Set<string>>(new Set());
const columnOrder = ref<string[]>([]);
const columnWidths = ref<Record<string, number>>({});
const tableProfiles = ref<DatabaseTableProfile[]>([]);
const activeProfileId = ref("");
const profileManagerVisible = ref(false);
const toolPanel = ref<"filter" | "columns" | "analysis" | "">("");
const viewMode = ref<"grid" | "form">("grid");
const focused = ref(false);
const editorElement = ref<HTMLElement | null>(null);
let removeShortcutListener: (() => void) | undefined;
const transactionActive = ref(false);
let tableGrid: Tabulator | null = null;
let loadController: AbortController | null = null;
let loadGeneration = 0;
let findMatches: TableFindMatch[] = [];

const canEdit = computed(() => !props.readOnly && primaryKey.value.length > 0);
const pendingCount = computed(() => pending.value.size);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const activeProfile = computed(() => tableProfiles.value.find((profile) => profile.id === activeProfileId.value) ?? null);
const activeFilters = computed<TableDataFilterRule[]>(() => filterRules.value
  .filter((rule) => rule.column)
  .map(({ id: _id, ...rule }) => rule));
const activeSorts = computed<TableDataSortRule[]>(() => sortRules.value
  .filter((rule) => rule.column)
  .map(({ id: _id, ...rule }) => rule));
const currentSql = computed(() => {
  const offset = (page.value - 1) * pageSize.value;
  const conditions = activeFilters.value.filter((rule) => rule.enabled).map((rule) => {
    const column = quoteIdentifier(rule.column);
    const value = quoteSqlValue(rule.value);
    const expressions: Record<TableDataFilterOperator, string> = {
      contains: `${column} LIKE ${quoteSqlValue(`%${rule.value}%`)}`,
      eq: `${column} = ${value}`,
      ne: `${column} <> ${value}`,
      gt: `${column} > ${value}`,
      gte: `${column} >= ${value}`,
      lt: `${column} < ${value}`,
      lte: `${column} <= ${value}`,
      isNull: `${column} IS NULL`,
      isNotNull: `${column} IS NOT NULL`,
    };
    return expressions[rule.operator];
  });
  const sorts = activeSorts.value.filter((rule) => rule.enabled);
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = sorts.length ? ` ORDER BY ${sorts.map((rule) => `${quoteIdentifier(rule.column)} ${rule.direction.toUpperCase()}`).join(", ")}` : "";
  return `SELECT * FROM ${quoteIdentifier(props.database)}.${quoteIdentifier(props.table)}${where}${orderBy} LIMIT ${offset},${pageSize.value}`;
});

function createFilterRule(rule: Partial<TableDataFilterRule> = {}): FilterRuleDraft {
  return { id: createClientId(), column: "", operator: "contains", value: "", enabled: true, ...rule };
}

function createSortRule(rule: Partial<TableDataSortRule> = {}): SortRuleDraft {
  return { id: createClientId(), column: "", direction: "asc", enabled: true, ...rule };
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function quoteSqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function originalKey(row: Record<string, unknown>): Record<string, unknown> {
  const stored = row.__envmanKey;
  if (stored && typeof stored === "object") return stored as Record<string, unknown>;
  return Object.fromEntries(primaryKey.value.map((key) => [key, row[key]]));
}

function changeId(row: Record<string, unknown>): string {
  if (row.__envmanNew) return `new:${String(row.__envmanId)}`;
  return `row:${JSON.stringify(originalKey(row))}`;
}

function visibleValues(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(columns.value.map((column) => [column.name, row[column.name]]));
}

function definitions(): ColumnDefinition[] {
  const positions = new Map(columnOrder.value.map((name, index) => [name, index]));
  return [...columns.value].sort((left, right) => (positions.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.name) ?? Number.MAX_SAFE_INTEGER)).map((column) => ({
    title: `${column.name}${column.primary ? " 🔑" : ""}`,
    field: column.name,
    minWidth: Math.max(120, Math.min(260, column.name.length * 10 + 70)),
    width: columnWidths.value[column.name],
    visible: !hiddenColumns.value.has(column.name),
    editor: canEdit.value && !column.autoIncrement ? "input" : undefined,
    headerSort: true,
    tooltip: `${column.columnType}${column.comment ? ` · ${column.comment}` : ""}`,
    formatter: (cell) => {
      const value = cell.getValue();
      if (value === null) return "<span class='db-null'>NULL</span>";
      const node = document.createElement("span");
      node.textContent = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
      return node;
    },
  }));
}

function currentProfileConfig(): TableProfileConfig {
  const profileColumns = tableGrid?.getColumns().flatMap((column) => {
    const name = column.getField();
    if (!name || !columns.value.some((candidate) => candidate.name === name)) return [];
    return [{ name, visible: column.isVisible(), width: Math.round(column.getWidth()) }];
  }) ?? columns.value.map((column) => ({ name: column.name, visible: !hiddenColumns.value.has(column.name), width: columnWidths.value[column.name] ?? 120 }));
  return {
    filters: activeFilters.value,
    sorts: activeSorts.value,
    columns: profileColumns,
    pageSize: pageSize.value,
    viewMode: viewMode.value,
  };
}

function tableProfilePayload(name: string, config = currentProfileConfig()) {
  return { connectionId: props.connectionId, database: props.database, table: props.table, name, config };
}

async function loadProfiles() {
  try {
    const query = new URLSearchParams({ connectionId: props.connectionId, database: props.database, table: props.table });
    const response = await api<{ items: DatabaseTableProfile[] }>(`/api/v1/database-table-profiles?${query.toString()}`);
    tableProfiles.value = response.items;
    if (activeProfileId.value && !response.items.some((profile) => profile.id === activeProfileId.value)) activeProfileId.value = "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取表配置文件失败"));
  }
}

async function saveProfile(saveAs = false) {
  const existing = saveAs ? null : activeProfile.value;
  let name = existing?.name ?? "";
  if (!name) {
    try {
      const result = await ElMessageBox.prompt(tr("请输入表配置文件名称"), saveAs ? tr("另存配置文件为") : tr("保存配置文件"), {
        confirmButtonText: tr("保存"),
        cancelButtonText: tr("取消"),
        inputPlaceholder: tr("配置文件名称"),
        inputValidator: (value) => value.trim().length > 0 && value.trim().length <= 160 || tr("名称需为 1–160 个字符"),
      });
      name = result.value.trim();
    } catch {
      return;
    }
  }
  try {
    if (existing) {
      await api(`/api/v1/database-table-profiles/${existing.id}`, { method: "PUT", body: JSON.stringify(tableProfilePayload(name)) });
      ElMessage.success(tr("已更新表配置文件“{0}”", [name]));
    } else {
      const created = await api<{ id: string }>("/api/v1/database-table-profiles", { method: "POST", body: JSON.stringify(tableProfilePayload(name)) });
      activeProfileId.value = created.id;
      ElMessage.success(tr("已保存表配置文件“{0}”", [name]));
    }
    await loadProfiles();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存表配置文件失败"));
  }
}

async function applyProfile(profile: DatabaseTableProfile) {
  const normalized = normalizeTableProfile(profile.config, columns.value.map((column) => column.name));
  filterRules.value = normalized.filters.length ? normalized.filters.map((rule) => createFilterRule(rule)) : [createFilterRule()];
  sortRules.value = normalized.sorts.length ? normalized.sorts.map((rule) => createSortRule(rule)) : [createSortRule()];
  pageSize.value = normalized.pageSize;
  viewMode.value = normalized.viewMode;
  columnOrder.value = normalized.columns.map((column) => column.name);
  columnWidths.value = Object.fromEntries(normalized.columns.map((column) => [column.name, column.width]));
  hiddenColumns.value = new Set(normalized.columns.filter((column) => !column.visible).map((column) => column.name));
  activeProfileId.value = profile.id;
  page.value = 1;
  profileManagerVisible.value = false;
  await Promise.all([
    load(),
    api(`/api/v1/database-table-profiles/${profile.id}/access`, { method: "POST" }).catch(() => undefined),
  ]);
}

async function renameProfile(profile: DatabaseTableProfile) {
  try {
    const result = await ElMessageBox.prompt(tr("请输入新的配置文件名称"), tr("重命名表配置文件"), {
      confirmButtonText: tr("重命名"),
      cancelButtonText: tr("取消"),
      inputValue: profile.name,
      inputValidator: (value) => value.trim().length > 0 && value.trim().length <= 160 || tr("名称需为 1–160 个字符"),
    });
    await api(`/api/v1/database-table-profiles/${profile.id}`, { method: "PUT", body: JSON.stringify(tableProfilePayload(result.value.trim(), profile.config)) });
    await loadProfiles();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("重命名表配置文件失败"));
  }
}

async function deleteProfile(profile: DatabaseTableProfile) {
  try {
    await ElMessageBox.confirm(tr("确定删除表配置文件“{0}”吗？", [profile.name]), tr("删除表配置文件"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/database-table-profiles/${profile.id}`, { method: "DELETE" });
    if (activeProfileId.value === profile.id) activeProfileId.value = "";
    await loadProfiles();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("删除表配置文件失败"));
  }
}

function handleProfileCommand(command: string) {
  if (command === "manage") profileManagerVisible.value = true;
  else if (command === "save") void saveProfile(false);
  else if (command === "save-as") void saveProfile(true);
  else if (command.startsWith("load:")) {
    const profile = tableProfiles.value.find((item) => item.id === command.slice(5));
    if (profile) void applyProfile(profile);
  }
}

function selectTableRow(row: RowComponent, additive = false) {
  if (!tableGrid) return;
  if (!additive) tableGrid.deselectRow();
  if (additive && row.isSelected()) row.deselect();
  else row.select();
  const selected = tableGrid.getSelectedRows();
  const fallback = selected.at(-1);
  selectedCount.value = selected.length;
  selectedRow.value = row.isSelected()
    ? row.getData() as Record<string, unknown>
    : fallback ? fallback.getData() as Record<string, unknown> : null;
}

function handleGridPointerDown(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null;
  const rowElement = target?.closest<HTMLElement>(".tabulator-row");
  if (!rowElement || !tableGrid) return;
  const row = tableGrid.getRows().find((candidate) => candidate.getElement() === rowElement);
  if (row) selectTableRow(row, event.metaKey || event.ctrlKey);
}

function installTable(rows: Array<Record<string, unknown>>) {
  const data = rows.map((row) => ({
    ...row,
    __envmanId: createClientId(),
    __envmanKey: Object.fromEntries(primaryKey.value.map((key) => [key, row[key]])),
  }));
  loadedRowCount.value = data.length;
  selectedRow.value = null;
  selectedCount.value = 0;
  if (!tableGrid) {
    tableGrid = new Tabulator(tableElement.value!, {
      data,
      columns: definitions(),
      height: "100%",
      layout: "fitDataFill",
      movableColumns: true,
      selectableRows: false,
      clipboard: true,
      placeholder: tr("数据表中没有记录"),
      index: "__envmanId",
    });
    tableGrid.on("cellEdited", (cell: CellComponent) => trackUpdate(cell.getRow()));
    tableGrid.on("dataSorted", (sorters: Array<{ field: string; dir: "asc" | "desc" }>) => {
      const sorter = sorters[0];
      const current = activeSorts.value;
      if (sorter && (current.length !== 1 || current[0].column !== sorter.field || current[0].direction !== sorter.dir)) {
        sortRules.value = [createSortRule({ column: sorter.field, direction: sorter.dir, enabled: true })];
        void load();
      }
    });
  } else {
    tableGrid.deselectRow();
    tableGrid.setColumns(definitions());
    void tableGrid.setData(data);
  }
  void nextTick(() => updateFindMatches());
}

function trackUpdate(rowComponent: RowComponent) {
  const row = rowComponent.getData() as Record<string, unknown>;
  const id = changeId(row);
  if (row.__envmanNew) pending.value.set(id, { type: "insert", values: visibleValues(row), key: {} });
  else pending.value.set(id, { type: "update", values: visibleValues(row), key: originalKey(row) });
  pending.value = new Map(pending.value);
  transactionActive.value = true;
  selectedRow.value = row;
}

async function load() {
  const generation = ++loadGeneration;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  try {
    const query = new URLSearchParams({ database: props.database, table: props.table, page: String(page.value), pageSize: String(pageSize.value) });
    if (activeFilters.value.length) query.set("filters", JSON.stringify(activeFilters.value));
    if (activeSorts.value.length) query.set("sorts", JSON.stringify(activeSorts.value));
    const response = await api<TableResponse>(`/api/v1/database-connections/${props.connectionId}/table-data?${query.toString()}`, {
      signal: controller.signal,
    });
    if (generation !== loadGeneration) return;
    columns.value = response.columns;
    primaryKey.value = response.primaryKey;
    total.value = response.total;
    pending.value = new Map();
    transactionActive.value = false;
    await nextTick();
    installTable(response.rows);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError") && generation === loadGeneration) {
      ElMessage.error(error instanceof Error ? error.message : tr("读取数据表失败"));
    }
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
      if (loadController === controller) loadController = null;
    }
  }
}

async function refreshTableContext() {
  page.value = 1;
  activeProfileId.value = "";
  closeFind();
  findQuery.value = "";
  findColumn.value = "";
  filterRules.value = [createFilterRule()];
  sortRules.value = [createSortRule()];
  filterSuggestions.value = {};
  suggestionGenerations.clear();
  suggestionRequestKeys.clear();
  columnOrder.value = [];
  columnWidths.value = {};
  hiddenColumns.value = new Set();
  await load();
  await loadProfiles();
}

function stopLoading() {
  if (!loading.value) return;
  loadGeneration += 1;
  loadController?.abort();
  loadController = null;
  loading.value = false;
}

async function addRow() {
  if (!tableGrid || !canEdit.value) return;
  const row = Object.fromEntries(columns.value.map((column) => [column.name, column.autoIncrement ? null : column.defaultValue]));
  const data = { ...row, __envmanId: createClientId(), __envmanNew: true };
  await tableGrid.addRow(data, true);
  pending.value.set(changeId(data), { type: "insert", values: visibleValues(data), key: {} });
  pending.value = new Map(pending.value);
  transactionActive.value = true;
}

async function deleteSelected() {
  if (!tableGrid || !canEdit.value) return;
  const rows = tableGrid.getSelectedRows();
  if (!rows.length) return ElMessage.warning(tr("请先选择要删除的数据行"));
  try {
    await ElMessageBox.confirm(tr("确定标记删除 {0} 行数据吗？提交变更后才会写入数据库。", [rows.length]), tr("删除数据行"), { confirmButtonText: tr("标记删除"), cancelButtonText: tr("取消"), type: "warning" });
    for (const rowComponent of rows) {
      const row = rowComponent.getData() as Record<string, unknown>;
      const id = changeId(row);
      if (row.__envmanNew) pending.value.delete(id);
      else pending.value.set(id, { type: "delete", values: {}, key: originalKey(row) });
      rowComponent.getElement().classList.add("is-pending-delete");
      rowComponent.deselect();
    }
    pending.value = new Map(pending.value);
    transactionActive.value = true;
    selectedCount.value = 0;
    selectedRow.value = null;
  } catch {
    // User cancelled deletion.
  }
}

async function saveChanges() {
  if (!pending.value.size) return;
  saving.value = true;
  try {
    const response = await api<{ changed: number }>(`/api/v1/database-connections/${props.connectionId}/table-data/changes`, {
      method: "POST",
      body: JSON.stringify({ database: props.database, table: props.table, changes: [...pending.value.values()] }),
    });
    ElMessage.success(tr("已提交变更，影响 {0} 行", [response.changed]));
    transactionActive.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("提交数据变更失败"));
  } finally {
    saving.value = false;
  }
}

async function exportTable(format: "csv" | "xlsx" | "sql") {
  try {
    await downloadApiFile(
      `/api/v1/database-connections/${props.connectionId}/table-export?database=${encodeURIComponent(props.database)}&table=${encodeURIComponent(props.table)}&format=${format}`,
      `${props.database}.${props.table}.${format}`,
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导出数据表失败"));
  }
}

function chooseImportFile(event: Event) {
  importFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function importTable() {
  if (!importFile.value) return ElMessage.warning(tr("请选择 CSV 或 XLSX 文件"));
  saving.value = true;
  try {
    const formData = new FormData();
    formData.append("database", props.database);
    formData.append("table", props.table);
    formData.append("mode", importMode.value);
    formData.append("file", importFile.value);
    const response = await api<{ imported: number; columns: number }>(`/api/v1/database-connections/${props.connectionId}/table-import`, { method: "POST", body: formData });
    ElMessage.success(tr("已导入 {0} 行、{1} 列", [response.imported, response.columns]));
    importDialog.value = false;
    importFile.value = null;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导入数据失败"));
  } finally {
    saving.value = false;
  }
}

async function handleActionRequest(action = props.actionRequest) {
  if (!action) return;
  if (action.type === "import") {
    importDialog.value = true;
    emit("actionHandled", action.id);
    return;
  }
  try {
    await exportTable(action.format ?? "csv");
  } finally {
    emit("actionHandled", action.id);
  }
}

async function discardChanges() {
  if (!pending.value.size) return;
  try {
    await ElMessageBox.confirm(tr("确定放弃当前未提交的全部变更吗？"), tr("回滚变更"), { confirmButtonText: tr("放弃变更"), cancelButtonText: tr("继续编辑"), type: "warning" });
    transactionActive.value = false;
    await load();
  } catch {
    // User cancelled rollback.
  }
}

function addFilterRule() {
  if (filterRules.value.length < 20) filterRules.value.push(createFilterRule());
}

function removeFilterRule(id: string) {
  filterRules.value = filterRules.value.filter((rule) => rule.id !== id);
  if (!filterRules.value.length) filterRules.value = [createFilterRule()];
  suggestionGenerations.delete(id);
  suggestionRequestKeys.delete(id);
  const nextSuggestions = { ...filterSuggestions.value };
  delete nextSuggestions[id];
  filterSuggestions.value = nextSuggestions;
}

function addSortRule() {
  if (sortRules.value.length < 20) sortRules.value.push(createSortRule());
}

function removeSortRule(id: string) {
  sortRules.value = sortRules.value.filter((rule) => rule.id !== id);
  if (!sortRules.value.length) sortRules.value = [createSortRule()];
}

function filterUsesValue(operator: TableDataFilterOperator): boolean {
  return operator !== "isNull" && operator !== "isNotNull";
}

function updateFilterColumn(rule: FilterRuleDraft) {
  rule.value = "";
  suggestionRequestKeys.delete(rule.id);
  filterSuggestions.value = { ...filterSuggestions.value, [rule.id]: [] };
}

async function loadFilterSuggestions(rule: FilterRuleDraft, search: string) {
  if (!rule.column || !filterUsesValue(rule.operator)) return;
  const requestKey = `${rule.column}\u0000${search}`;
  if (suggestionRequestKeys.get(rule.id) === requestKey) return;
  suggestionRequestKeys.set(rule.id, requestKey);
  const generation = (suggestionGenerations.get(rule.id) ?? 0) + 1;
  suggestionGenerations.set(rule.id, generation);
  suggestionLoading.value = new Set(suggestionLoading.value).add(rule.id);
  try {
    const query = new URLSearchParams({
      database: props.database,
      table: props.table,
      column: rule.column,
      q: search,
      limit: "50",
    });
    const response = await api<{ items: string[] }>(`/api/v1/database-connections/${props.connectionId}/table-data/suggestions?${query.toString()}`);
    if (suggestionGenerations.get(rule.id) === generation) {
      filterSuggestions.value = { ...filterSuggestions.value, [rule.id]: response.items };
    }
  } catch (error) {
    if (suggestionGenerations.get(rule.id) === generation) {
      suggestionRequestKeys.delete(rule.id);
      ElMessage.error(error instanceof Error ? error.message : tr("读取筛选建议值失败"));
    }
  } finally {
    const next = new Set(suggestionLoading.value);
    next.delete(rule.id);
    suggestionLoading.value = next;
  }
}

async function applyFilterSort() {
  page.value = 1;
  await load();
}

async function clearFilterSort() {
  filterRules.value = [createFilterRule()];
  sortRules.value = [createSortRule()];
  filterSuggestions.value = {};
  suggestionGenerations.clear();
  suggestionRequestKeys.clear();
  page.value = 1;
  await load();
}

function clearFindHighlights() {
  for (const match of findMatches) findMatchElement(match)?.classList.remove("is-find-match", "is-current-find-match");
  for (const element of tableElement.value?.querySelectorAll<HTMLElement>(".is-find-match, .is-current-find-match") ?? []) {
    element.classList.remove("is-find-match", "is-current-find-match");
  }
  findMatches = [];
  findMatchIndex.value = -1;
  findMatchCount.value = 0;
}

function findMatchElement(match: TableFindMatch): HTMLElement | null {
  const element: unknown = resolveTableFindCell(tableGrid, match)?.getElement();
  return element instanceof HTMLElement ? element : null;
}

function focusFindMatch(index: number) {
  for (const match of findMatches) findMatchElement(match)?.classList.remove("is-current-find-match");
  for (const element of tableElement.value?.querySelectorAll<HTMLElement>(".is-current-find-match") ?? []) {
    element.classList.remove("is-current-find-match");
  }
  const match = findMatches[index];
  if (!match) return;
  const cell = resolveTableFindCell(tableGrid, match);
  if (!cell) return;
  findMatchIndex.value = index;
  findMatchElement(match)?.classList.add("is-current-find-match");
  void cell.getRow().scrollTo("center", false).then(() => {
    const element = findMatchElement(match);
    if (!element) return;
    element.classList.add("is-find-match", "is-current-find-match");
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function updateFindMatches() {
  clearFindHighlights();
  const query = findQuery.value.trim().toLocaleLowerCase();
  if (!query || !tableGrid) return;
  const fields = findColumn.value ? new Set([findColumn.value]) : null;
  for (const row of tableGrid.getRows("active")) {
    for (const cell of row.getCells()) {
      const field = cell.getField();
      if (!field || field.startsWith("__envman") || (fields && !fields.has(field))) continue;
      const value = cell.getValue();
      const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
      if (!text.toLocaleLowerCase().includes(query)) continue;
      const element: unknown = cell.getElement();
      if (element instanceof HTMLElement) element.classList.add("is-find-match");
      findMatches.push(createTableFindMatch(cell));
    }
  }
  findMatchCount.value = findMatches.length;
  if (findMatches.length) focusFindMatch(0);
}

function findNext(direction: 1 | -1) {
  if (!findMatches.length) {
    updateFindMatches();
    return;
  }
  focusFindMatch((findMatchIndex.value + direction + findMatches.length) % findMatches.length);
}

function openFind() {
  findVisible.value = true;
  void nextTick(() => {
    findInputElement.value?.focus();
    findInputElement.value?.select();
    updateFindMatches();
  });
}

function closeFind() {
  findVisible.value = false;
  clearFindHighlights();
}

function toggleToolPanel(panel: "filter" | "columns" | "analysis") {
  toolPanel.value = toolPanel.value === panel ? "" : panel;
}

function toggleColumn(name: string, visible: boolean) {
  const next = new Set(hiddenColumns.value);
  if (visible) next.delete(name);
  else next.add(name);
  hiddenColumns.value = next;
  if (visible) tableGrid?.showColumn(name);
  else tableGrid?.hideColumn(name);
}

function updateFormValue(column: TableColumn, value: unknown) {
  if (!selectedRow.value || !tableGrid || column.autoIncrement || !canEdit.value) return;
  const rowId = selectedRow.value.__envmanId;
  const row = tableGrid.getRow(rowId as string);
  if (!row) return;
  void row.update({ [column.name]: value }).then(() => {
    selectedRow.value = row.getData() as Record<string, unknown>;
    trackUpdate(row);
  });
}

function startTransaction() {
  transactionActive.value = true;
}

async function goToPage(value: number) {
  await changePage(Math.max(1, Math.min(pageCount.value, value)));
}

function updatePageFromInput(event: Event) {
  const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
  if (Number.isFinite(value)) void goToPage(value);
}

function handleToolCommand(command: string) {
  if (command === "import") importDialog.value = true;
  else if (["csv", "xlsx", "sql"].includes(command)) void exportTable(command as "csv" | "xlsx" | "sql");
}

function setViewMode(command: string) {
  if (command === "grid" || command === "form") viewMode.value = command;
}

function setPageSize(command: string | number) {
  pageSize.value = Number(command);
  page.value = 1;
  void load();
}

function toggleFocused() {
  focused.value = !focused.value;
  void nextTick(() => tableGrid?.redraw(true));
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (!props.active) return;
  if (event.key === "Escape" && findVisible.value) {
    event.preventDefault();
    closeFind();
    return;
  }
  if (event.key === "Escape" && focused.value) {
    toggleFocused();
    return;
  }
  const action = shortcutActionFromKeyboardEvent(event);
  if (action === "workspace.search") {
    event.preventDefault();
    openFind();
  } else if (action === "workspace.save") {
    event.preventDefault();
    if (pending.value.size) void saveChanges();
  } else if (action === "workspace.refresh") {
    event.preventDefault();
    void load();
  }
}

async function changePage(value: number) {
  if (pending.value.size) {
    try {
      await ElMessageBox.confirm(tr("切换分页会放弃尚未提交的编辑。"), tr("放弃变更"), { confirmButtonText: tr("放弃并切换"), cancelButtonText: tr("继续编辑"), type: "warning" });
    } catch {
      return;
    }
  }
  page.value = value;
  await load();
}

watch(() => [props.connectionId, props.database, props.table], () => { void refreshTableContext(); });
watch(() => props.actionRequest?.id, () => { void handleActionRequest(); });
watch(() => props.active, (active) => {
  if (active) void nextTick(() => tableGrid?.redraw(true));
});
watch([findQuery, findColumn], () => updateFindMatches());
onMounted(async () => {
  document.addEventListener("keydown", handleDocumentKeydown);
  removeShortcutListener = onAppShortcut((action) => {
    if (!props.active || !editorElement.value?.getClientRects().length) return;
    if (action === "workspace.search") {
      openFind();
    } else if (action === "workspace.save" && pending.value.size) void saveChanges();
    else if (action === "workspace.refresh") void load();
  });
  await refreshTableContext();
  await handleActionRequest();
});
onActivated(() => nextTick(() => tableGrid?.redraw(true)));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleDocumentKeydown);
  removeShortcutListener?.();
  stopLoading();
  clearFindHighlights();
  tableGrid?.destroy();
});
</script>

<template>
  <Teleport to="body" :disabled="!focused">
  <section ref="editorElement" class="table-data-editor" :class="{ 'is-focused': focused }" v-loading="loading">
    <header class="table-data-toolbar">
      <div class="table-toolbar-primary">
        <el-dropdown trigger="click" @command="handleProfileCommand">
          <button class="table-profile-button" data-navicat-action="data-view" :aria-label="$t('表配置文件')" :title="$t('表配置文件')"><FolderCog :size="17" /><ChevronDown :size="12" /></button>
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="manage"><FolderCog :size="14" />{{ $t('管理配置文件…') }}</el-dropdown-item><el-dropdown-item v-for="profile in tableProfiles" :key="profile.id" :command="`load:${profile.id}`"><Check :size="14" :style="{ visibility: activeProfileId === profile.id ? 'visible' : 'hidden' }" />{{ $t('加载 ·') }} {{ profile.name }}</el-dropdown-item><el-dropdown-item command="save" divided><Save :size="14" />{{ $t('保存配置文件') }}</el-dropdown-item><el-dropdown-item command="save-as"><Copy :size="14" />{{ $t('另存配置文件为…') }}</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
        <span class="table-toolbar-divider"></span>
        <el-tooltip :content="$t('开始事务')" placement="bottom" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="transaction" :class="{ 'is-active': transactionActive }" :disabled="!canEdit" :aria-label="$t('开始事务')" :title="$t('开始事务')" @click="startTransaction"><BriefcaseBusiness :size="17" /><span>{{ $t('开始事务') }}</span></button></span></el-tooltip>
        <el-tooltip :content="$t('编辑器')" placement="bottom" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="editor" :class="{ 'is-active': viewMode === 'form' }" :aria-label="$t('编辑器')" :title="$t('编辑器')" @click="viewMode = viewMode === 'grid' ? 'form' : 'grid'"><PanelTop :size="17" /><span>{{ $t('编辑器') }}</span></button></span></el-tooltip>
        <el-tooltip :content="$t('筛选 & 排序')" placement="bottom" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="filter-sort" :class="{ 'is-active': toolPanel === 'filter' }" :aria-label="$t('筛选 & 排序')" :title="$t('筛选 & 排序')" @click="toggleToolPanel('filter')"><Filter :size="17" /><span>{{ $t('筛选 & 排序') }}</span></button></span></el-tooltip>
        <el-tooltip :content="$t('列')" placement="bottom" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="columns" :class="{ 'is-active': toolPanel === 'columns' }" :aria-label="$t('列')" :title="$t('列')" @click="toggleToolPanel('columns')"><Columns3 :size="17" /><span>{{ $t('列') }}</span></button></span></el-tooltip>
        <el-tooltip :content="$t('工具')" placement="bottom" :show-after="250"><el-dropdown trigger="click" @command="handleToolCommand"><button data-navicat-action="tools" :aria-label="$t('工具')" :title="$t('工具')"><BriefcaseBusiness :size="17" /><span>{{ $t('工具') }}</span><ChevronDown :size="11" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="import"><Upload :size="14" />{{ $t('导入向导') }}</el-dropdown-item><el-dropdown-item command="csv"><Download :size="14" />{{ $t('导出 CSV') }}</el-dropdown-item><el-dropdown-item command="xlsx"><Download :size="14" />{{ $t('导出 XLSX') }}</el-dropdown-item><el-dropdown-item command="sql"><Download :size="14" />{{ $t('导出 SQL') }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown></el-tooltip>
      </div>
      <el-tooltip :content="focused ? $t('退出专注模式') : $t('进入专注模式')" placement="bottom" :show-after="250">
        <button class="table-focus-button" data-navicat-action="focus" :aria-label="focused ? $t('退出专注模式') : $t('进入专注模式')" :title="focused ? $t('退出专注模式') : $t('进入专注模式')" @click="toggleFocused"><Minimize2 v-if="focused" :size="18" /><Maximize2 v-else :size="18" /></button>
      </el-tooltip>
    </header>

    <section v-if="toolPanel" class="table-tool-panel">
      <div v-if="toolPanel === 'filter'" ref="filterPanelElement" class="table-filter-sort-editor">
        <section class="table-rule-section">
          <header><strong>{{ $t('筛选') }}</strong><button type="button" :aria-label="$t('添加筛选规则')" :title="$t('添加筛选规则')" :disabled="filterRules.length >= 20" @click="addFilterRule"><Plus :size="14" /></button></header>
          <div class="table-rule-list">
            <div v-for="rule in filterRules" :key="rule.id" class="table-rule-row is-filter">
              <el-checkbox v-model="rule.enabled" :aria-label="$t('启用筛选规则')" />
              <el-select v-model="rule.column" clearable filterable :placeholder="$t('筛选列')" size="small" popper-class="database-console-select-popper" @change="updateFilterColumn(rule)"><el-option v-for="column in columns" :key="column.name" :label="column.name" :value="column.name" /></el-select>
              <el-select v-model="rule.operator" :disabled="!rule.column" size="small" popper-class="database-console-select-popper"><el-option :label="$t('包含')" value="contains" /><el-option :label="$t('等于')" value="eq" /><el-option :label="$t('不等于')" value="ne" /><el-option :label="$t('大于')" value="gt" /><el-option :label="$t('大于等于')" value="gte" /><el-option :label="$t('小于')" value="lt" /><el-option :label="$t('小于等于')" value="lte" /><el-option :label="$t('为空')" value="isNull" /><el-option :label="$t('不为空')" value="isNotNull" /></el-select>
              <el-select
                v-model="rule.value"
                filterable
                allow-create
                default-first-option
                remote
                reserve-keyword
                :remote-method="(query: string) => loadFilterSuggestions(rule, query)"
                :loading="suggestionLoading.has(rule.id)"
                :disabled="!rule.column || !filterUsesValue(rule.operator)"
                :placeholder="$t('筛选值或选择建议值')"
                size="small"
                popper-class="database-console-select-popper"
                @keyup.enter="applyFilterSort"
              ><el-option v-for="value in filterSuggestions[rule.id] || []" :key="value" :label="value" :value="value" /></el-select>
              <button type="button" class="table-rule-remove" :aria-label="$t('删除筛选规则')" :title="$t('删除筛选规则')" @click="removeFilterRule(rule.id)"><Trash2 :size="14" /></button>
            </div>
          </div>
        </section>
        <section class="table-rule-section">
          <header><strong>{{ $t('排序方式') }}</strong><button type="button" :aria-label="$t('添加排序规则')" :title="$t('添加排序规则')" :disabled="sortRules.length >= 20" @click="addSortRule"><Plus :size="14" /></button></header>
          <div class="table-rule-list">
            <div v-for="rule in sortRules" :key="rule.id" class="table-rule-row is-sort">
              <el-checkbox v-model="rule.enabled" :aria-label="$t('启用排序规则')" />
              <el-select v-model="rule.column" clearable filterable :placeholder="$t('排序列')" size="small" popper-class="database-console-select-popper"><el-option v-for="column in columns" :key="column.name" :label="column.name" :value="column.name" :disabled="sortRules.some((candidate) => candidate.id !== rule.id && candidate.column === column.name)" /></el-select>
              <el-select v-model="rule.direction" :disabled="!rule.column" size="small" popper-class="database-console-select-popper"><el-option :label="$t('升序')" value="asc" /><el-option :label="$t('降序')" value="desc" /></el-select>
              <button type="button" class="table-rule-remove" :aria-label="$t('删除排序规则')" :title="$t('删除排序规则')" @click="removeSortRule(rule.id)"><Trash2 :size="14" /></button>
            </div>
          </div>
        </section>
        <footer><button type="button" class="is-primary" @click="applyFilterSort"><Filter :size="14" />{{ $t('应用筛选与排序') }}</button><button type="button" @click="clearFilterSort"><RotateCcw :size="14" />{{ $t('清除规则') }}</button></footer>
      </div>
      <div v-else-if="toolPanel === 'columns'" class="table-columns-panel">
        <label v-for="column in columns" :key="column.name"><el-checkbox :model-value="!hiddenColumns.has(column.name)" @change="toggleColumn(column.name, Boolean($event))" /><span>{{ column.name }}</span><small>{{ column.columnType }}</small></label>
      </div>
      <div v-else class="table-analysis-panel">
        <article><span>{{ $t('总记录') }}</span><strong>{{ total.toLocaleString($locale()) }}</strong></article><article><span>{{ $t('当前页') }}</span><strong>{{ loadedRowCount }}</strong></article><article><span>{{ $t('列') }}</span><strong>{{ columns.length }}</strong></article><article><span>{{ $t('待提交') }}</span><strong>{{ pendingCount }}</strong></article>
      </div>
    </section>

    <div v-show="viewMode === 'grid'" ref="tableElement" class="editable-data-grid" @pointerdown.capture="handleGridPointerDown"></div>
    <div v-if="viewMode === 'form'" class="table-form-view">
      <div v-if="selectedRow" class="table-form-fields">
        <label v-for="column in columns" :key="column.name"><span><strong>{{ column.name }}</strong><small>{{ column.columnType }}</small></span><el-input :model-value="selectedRow[column.name] === null ? '' : String(selectedRow[column.name] ?? '')" :disabled="!canEdit || column.autoIncrement" :placeholder="selectedRow[column.name] === null ? 'NULL' : ''" @update:model-value="updateFormValue(column, $event)" /></label>
      </div>
      <div v-else class="table-form-empty"><PanelTop :size="24" /><span>{{ $t('请在网格视图中选择一条记录') }}</span></div>
    </div>

    <div v-if="findVisible" class="table-findbar">
      <span class="table-findbar-label">{{ $t('查找') }}</span>
      <el-select v-model="findColumn" size="small" :aria-label="$t('查找列')" popper-class="database-console-select-popper"><el-option :label="$t('所有列')" value="" /><el-option v-for="column in columns" :key="column.name" :label="column.name" :value="column.name" /></el-select>
      <label><Search :size="15" /><input ref="findInputElement" v-model="findQuery" type="search" :placeholder="$t('搜索当前页')" @keydown.enter.prevent="findNext($event.shiftKey ? -1 : 1)" /></label>
      <small>{{ findMatchCount ? `${findMatchIndex + 1} / ${findMatchCount}` : $t('无匹配') }}</small>
      <button type="button" :disabled="!findMatchCount" :aria-label="$t('上一个匹配')" :title="$t('上一个匹配')" @click="findNext(-1)"><ChevronLeft :size="16" /></button>
      <button type="button" :disabled="!findMatchCount" :aria-label="$t('下一个匹配')" :title="$t('下一个匹配')" @click="findNext(1)"><ChevronRight :size="16" /></button>
      <button type="button" class="table-findbar-done" @click="closeFind">{{ $t('完成') }}</button>
    </div>

    <footer class="table-data-commandbar">
      <div class="table-record-actions">
        <el-tooltip :content="$t('添加记录')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="add-record" :disabled="!canEdit" :aria-label="$t('添加记录')" :title="$t('添加记录')" @click="addRow"><Plus :size="17" /></button></span></el-tooltip>
        <el-tooltip :content="$t('删除记录')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="delete-record" :disabled="!canEdit || !selectedCount" :aria-label="$t('删除记录')" :title="$t('删除记录')" @click="deleteSelected"><Trash2 :size="17" /></button></span></el-tooltip>
        <el-tooltip :content="$t('提交变更')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="commit" :disabled="!pendingCount" class="is-commit" :aria-label="$t('提交变更')" :title="$t('提交变更')" @click="saveChanges"><Check :size="17" /></button></span></el-tooltip>
        <el-tooltip :content="$t('回滚变更')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="rollback" :disabled="!pendingCount" class="is-rollback" :aria-label="$t('回滚变更')" :title="$t('回滚变更')" @click="discardChanges"><X :size="17" /></button></span></el-tooltip>
        <el-tooltip :content="$t('刷新')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="refresh" :aria-label="$t('刷新')" :title="$t('刷新')" @click="load"><RefreshCw :size="17" /></button></span></el-tooltip>
        <el-tooltip :content="$t('停止')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="stop" :disabled="!loading" :aria-label="$t('停止')" :title="$t('停止')" @click="stopLoading"><Square :size="14" /></button></span></el-tooltip>
      </div>
      <code>{{ currentSql }}</code>
      <div class="table-page-actions">
        <el-tooltip :content="$t('第一页')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="first-page" :disabled="page <= 1" :aria-label="$t('第一页')" :title="$t('第一页')" @click="goToPage(1)"><ChevronFirst :size="16" /></button></span></el-tooltip>
        <el-tooltip :content="$t('上一页')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="previous-page" :disabled="page <= 1" :aria-label="$t('上一页')" :title="$t('上一页')" @click="goToPage(page - 1)"><ChevronLeft :size="16" /></button></span></el-tooltip>
        <input :value="page" data-navicat-action="page-number" inputmode="numeric" :aria-label="$t('当前页')" @change="updatePageFromInput" />
        <el-tooltip :content="$t('下一页')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="next-page" :disabled="page >= pageCount" :aria-label="$t('下一页')" :title="$t('下一页')" @click="goToPage(page + 1)"><ChevronRight :size="16" /></button></span></el-tooltip>
        <el-tooltip :content="$t('最后一页')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="last-page" :disabled="page >= pageCount" :aria-label="$t('最后一页')" :title="$t('最后一页')" @click="goToPage(pageCount)"><ChevronLast :size="16" /></button></span></el-tooltip>
        <el-tooltip :content="$t('每页行数')" placement="top" :show-after="250"><el-dropdown trigger="click" @command="setPageSize"><button data-navicat-action="page-size" :aria-label="$t('每页行数')" :title="$t('每页行数')"><Settings2 :size="16" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="50">{{ $t('每页 50 行') }}</el-dropdown-item><el-dropdown-item command="100">{{ $t('每页 100 行') }}</el-dropdown-item><el-dropdown-item command="200">{{ $t('每页 200 行') }}</el-dropdown-item><el-dropdown-item command="500">{{ $t('每页 500 行') }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown></el-tooltip>
        <el-tooltip :content="$t('网格视图')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="grid-view" :class="{ 'is-active': viewMode === 'grid' }" :aria-label="$t('网格视图')" :title="$t('网格视图')" @click="viewMode = 'grid'"><Grid3X3 :size="16" /></button></span></el-tooltip>
        <el-tooltip :content="$t('表单视图')" placement="top" :show-after="250"><span class="table-tooltip-trigger"><button data-navicat-action="form-view" :class="{ 'is-active': viewMode === 'form' }" :aria-label="$t('表单视图')" :title="$t('表单视图')" @click="viewMode = 'form'"><PanelTop :size="16" /></button></span></el-tooltip>
      </div>
    </footer>
    <div class="table-data-statusbar"><span>{{ total.toLocaleString($locale()) }} {{ $t('条记录在第') }} {{ page }} {{ $t('页 ·') }} {{ activeProfile?.name || $t('默认视图') }}</span><span>{{ readOnly ? $t('只读视图') : primaryKey.length ? $t('主键 {0}', [primaryKey.join(', ')]) : $t('无主键，只读') }}</span></div>
    <el-dialog v-model="profileManagerVisible" align-center class="envman-dialog database-table-profile-dialog" append-to-body :title="$t('管理表配置文件')" width="680px">
      <div class="table-profile-manager"><div v-if="!tableProfiles.length" class="table-form-empty"><FolderCog :size="24" /><span>{{ $t('当前数据表还没有配置文件') }}</span></div><article v-for="profile in tableProfiles" :key="profile.id" :class="{ 'is-active': activeProfileId === profile.id }"><span><strong>{{ profile.name }}</strong><small>{{ $t('修改于') }} {{ new Date(profile.updatedAt).toLocaleString($locale()) }}</small></span><div><button type="button" :title="$t('加载')" @click="applyProfile(profile)"><FolderOpen :size="15" /></button><button type="button" :title="$t('重命名')" @click="renameProfile(profile)"><Pencil :size="15" /></button><button type="button" class="is-danger" :title="$t('删除')" @click="deleteProfile(profile)"><Trash2 :size="15" /></button></div></article></div>
      <template #footer><el-button @click="profileManagerVisible = false">{{ $t('关闭') }}</el-button><el-button type="primary" @click="profileManagerVisible = false; saveProfile(true)">{{ $t('另存当前视图') }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="importDialog" align-center class="envman-dialog compact-dialog database-table-import-dialog" append-to-body :title="$t('导入表格数据')" width="520px">
      <el-form label-position="top"><el-form-item :label="$t('目标数据表')"><el-input :model-value="`${database}.${table}`" disabled /></el-form-item><el-form-item :label="$t('导入模式')"><el-radio-group v-model="importMode"><el-radio-button value="append">{{ $t('追加数据') }}</el-radio-button><el-radio-button value="replace">{{ $t('清空后导入') }}</el-radio-button></el-radio-group></el-form-item><el-form-item :label="$t('CSV / XLSX 文件')" required><button type="button" class="table-import-file" @click="importInput?.click()"><Upload :size="18" /><span>{{ importFile?.name || $t('选择文件') }}</span></button><input ref="importInput" type="file" hidden accept=".csv,.xlsx,.xlsm" @change="chooseImportFile" /></el-form-item></el-form>
      <div v-if="importMode === 'replace'" class="dialog-tip-row"><span>{{ $t('清空后导入') }}</span><TipIcon :content="$t('现有数据会在事务中删除；导入失败时删除操作会回滚。')" placement="right" /></div>
      <template #footer><el-button @click="importDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :disabled="!importFile" :loading="saving" @click="importTable">{{ $t('开始导入') }}</el-button></template>
    </el-dialog>
  </section>
  </Teleport>
</template>
