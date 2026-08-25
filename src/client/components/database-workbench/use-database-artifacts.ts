import { computed, nextTick, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { format } from "sql-formatter";
import { Clock3, Eye, FileCode2, HardDriveDownload, Table2 } from "@lucide/vue";
import { translate as tr, currentLocale } from "../../i18n";
import { ApiError, api } from "../../api";
import { createClientId } from "../../client-id";
import {
  buildConnectionNavigatorMenu,
  buildDatabaseNavigatorMenu,
  type DatabaseNavigatorMenuItem,
  type DatabaseNavigatorTarget,
} from "../../database-navigator-menu";
import {
  downloadApiFile,
  desktopExecutionTargets,
  isDesktopApp,
  openDesktopDatabaseQueryExternally,
  openMacosLocalNetworkSettings,
  revealDesktopDatabaseBackup,
  revealDesktopDatabaseQuery,
  selectDesktopDatabaseSqlFile,
  stopDesktopAgentResourceRuns,
} from "../../desktop";
import { registerAgentDatabaseSceneProvider } from "../../agent-database-scene";
import { registerAgentWorkbenchExecutionProvider } from "../../agent-workbench-execution";
import { rememberActiveConnectionOrigin } from "../../active-connection-origin";
import { session } from "../../session";
import { onAppShortcut, shortcutActionFromKeyboardEvent, shortcutLabel } from "../../keyboard-shortcuts";
import type { SqlCompletionCatalog } from "../../sql-completion";
import type { ShortcutActionId } from "../../../shared/keyboard-shortcuts";
import {
  agentTransportValue,
  type AgentDatabaseReadResult,
  type AgentWorkbenchExecutionRequest,
} from "../../../shared/agent";
import DatabaseAutomationWorkspace from "../DatabaseAutomationWorkspace.vue";
import DatabaseBiWorkspace from "../DatabaseBiWorkspace.vue";
import DatabaseModelWorkspace from "../DatabaseModelWorkspace.vue";
import type {
  BrowserCategory,
  ConnectionGroupItem,
  DatabaseConnection,
  DatabaseObject,
  DatabaseSearchResult,
  DatabaseTreeTask,
  FavoriteItem,
  HistoryItem,
  NavigatorCategory,
  NavigatorCategoryKey,
  NavigatorObjectClipboard,
  ObjectCategory,
  ObjectCategoryDefinition,
  ObjectFavoriteItem,
  ObjectGroupItem,
  OrganizationGrant,
  OrganizationShareDetail,
  QueryJob,
  QueryResultSet,
  QueryTab,
  SavedQueryItem,
  SchemaItem,
  TableMaintenanceOperation,
  UtilityCategory,
  WorkbenchNavigatorTarget,
  DatabaseWorkbenchProps,
} from "./types";
import { formatBytes, sqlIdentifier, textSize } from "./format";
import { deferDatabaseWorkbenchPart, type DatabaseWorkbenchContext } from "./context";

export function useDatabaseArtifacts(
  ctx: DatabaseWorkbenchContext,
  props: Readonly<DatabaseWorkbenchProps>,
  route: { fullPath: string },
) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $connections = deferDatabaseWorkbenchPart(ctx, "connections");
  const $navigator = deferDatabaseWorkbenchPart(ctx, "navigator");
  const $queryTabs = deferDatabaseWorkbenchPart(ctx, "queryTabs");
  const $agentScene = deferDatabaseWorkbenchPart(ctx, "agentScene");
  const $menuActions = deferDatabaseWorkbenchPart(ctx, "menuActions");
  const syncDialogOpen = ref(false);

  const syncDialogMode = ref<"data" | "structure">("structure");

  const sidePanel = ref<"history" | "favorites" | "">("");

  const historyItems = ref<HistoryItem[]>([]);

  const favorites = ref<FavoriteItem[]>([]);

  const savedQueries = ref<SavedQueryItem[]>([]);

  const selectedUtilityItems = ref<Record<string, string>>({});

  const databaseTasks = ref<DatabaseTreeTask[]>([]);

  const automationWorkspace = ref<InstanceType<typeof DatabaseAutomationWorkspace> | null>(null);

  const modelWorkspace = ref<InstanceType<typeof DatabaseModelWorkspace> | null>(null);

  const biWorkspace = ref<InstanceType<typeof DatabaseBiWorkspace> | null>(null);

  function queryFavoritesForDatabase(database: string): FavoriteItem[] {
      return favorites.value.filter((item) => !item.database || item.database === database);
  }

  function savedQueriesForDatabase(database: string): SavedQueryItem[] {
      return savedQueries.value.filter((item) => item.database === database);
  }

  function databaseTaskDatabase(task: DatabaseTreeTask): string {
      return String(task.details.database ?? task.details.sourceDatabase ?? "");
  }

  function backupTasksForDatabase(database: string): DatabaseTreeTask[] {
      return databaseTasks.value.filter((task) => (task.connectionId === $connections.selectedConnectionId.value
          && task.type === "backup"
          && databaseTaskDatabase(task) === database));
  }

  function utilitySelectionKey(database: string, category: UtilityCategory): string {
      return `${database}:${category}`;
  }

  function selectedSavedQuery(target: DatabaseNavigatorTarget): SavedQueryItem | null {
      if (target.category !== "queries")
          return null;
      const id = target.objectId || selectedUtilityItems.value[utilitySelectionKey(target.database, "queries")];
      return savedQueries.value.find((item) => item.id === id) ?? null;
  }

  function selectedBackup(target: DatabaseNavigatorTarget): DatabaseTreeTask | null {
      if (target.category !== "backups")
          return null;
      const id = target.objectId || selectedUtilityItems.value[utilitySelectionKey(target.database, "backups")];
      return databaseTasks.value.find((item) => item.id === id && item.type === "backup") ?? null;
  }

  function selectUtilityItem(database: string, category: UtilityCategory, id: string) {
      $navigator.selectedDatabase.value = database;
      selectedUtilityItems.value = { ...selectedUtilityItems.value, [utilitySelectionKey(database, category)]: id };
      $navigator.navigatorTarget.value = `object:${database}:${category}:${id}`;
  }

  const activeUtilityItems = computed(() => {
      if ($queryTabs.activeTab.value?.kind !== "utility" || !$queryTabs.activeTab.value.utilityCategory)
          return [];
      const query = $navigator.objectSearch.value.trim().toLowerCase();
      if ($queryTabs.activeTab.value.utilityCategory === "queries") {
          return savedQueriesForDatabase($queryTabs.activeTab.value.database).filter((item) => !query || `${item.name} ${item.sql}`.toLowerCase().includes(query));
      }
      return backupTasksForDatabase($queryTabs.activeTab.value.database).filter((item) => !query || `${item.title} ${item.status}`.toLowerCase().includes(query));
  });

  function handleGlobalBackupCommand(command: string) {
      const database = $queryTabs.requireSelectedDatabase();
      if (!database)
          return;
      if (command === "new")
          void startDatabaseBackup(database);
      else if (command === "restore")
          $queryTabs.openTaskPanel(database, "restore");
      else if (command === "list")
          void $navigator.openGlobalCategory("backups");
  }

  function openSyncDialog(mode: "data" | "structure") {
      if (!$queryTabs.requireSelectedDatabase())
          return;
      syncDialogMode.value = mode;
      syncDialogOpen.value = true;
  }

  function handleDatabaseToolCommand(command: string) {
      if (command === "add-favorite") {
          void addFavorite();
          return;
      }
      if (command === "favorites") {
          sidePanel.value = sidePanel.value === "favorites" ? "" : "favorites";
          void loadFavorites();
          return;
      }
      if (command === "history") {
          sidePanel.value = sidePanel.value === "history" ? "" : "history";
          void loadHistory();
          return;
      }
      const database = $queryTabs.requireSelectedDatabase();
      if (!database)
          return;
      if (command === "tasks")
          $queryTabs.openTaskPanel(database);
      else if (command === "restore")
          $queryTabs.openTaskPanel(database, "restore");
      else if (command === "transfer")
          $queryTabs.openTaskPanel(database, "transfer");
      else if (command === "data-sync")
          openSyncDialog("data");
      else if (command === "structure-sync")
          openSyncDialog("structure");
  }

  async function startDatabaseBackup(database: string, includeData = true) {
      if (!$connections.selectedConnectionId.value)
          return;
      try {
          await api(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/backup`, {
              method: "POST",
              body: JSON.stringify({ database, includeData }),
          });
          await loadDatabaseTasks();
          $queryTabs.openTaskPanel(database);
          ElMessage.success(tr("数据库 {0} 的{1}任务已开始", [database, includeData ? tr("备份") : tr("结构备份")]));
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("无法开始数据库备份"));
      }
  }

  async function runServerReload(action: string, database = $navigator.selectedDatabase.value) {
      const commands: Record<string, {
          sql: string;
          title: string;
      }> = {
          "reload-privileges": { sql: "FLUSH PRIVILEGES;", title: tr("重载权限") },
          "reload-hosts": { sql: "FLUSH HOSTS;", title: tr("重载主机") },
          "reload-log-files": { sql: "FLUSH LOGS;", title: tr("重载日志文件") },
          "reload-status": { sql: "FLUSH STATUS;", title: tr("重载状态") },
          "reload-tables": { sql: "FLUSH TABLES;", title: tr("重载表") },
      };
      const command = commands[action];
      if (!command)
          return;
      const tab = $queryTabs.newTab(command.sql, database, command.title);
      await $queryTabs.runQuery(command.sql, tab);
  }

  function syncSavedQueryTab(tab: QueryTab, item: SavedQueryItem) {
      tab.savedQueryId = item.id;
      tab.savedQuerySql = item.sql;
      tab.savedQueryName = item.name;
      tab.savedQueryDatabase = item.database;
      tab.title = item.name;
      tab.sql = item.sql;
      tab.database = item.database;
  }

  async function saveQueryTab(tab = $queryTabs.activeTab.value): Promise<boolean> {
      if (!tab || tab.kind !== "sql" || !$connections.selectedConnectionId.value)
          return false;
      const database = tab.database || $navigator.selectedDatabase.value;
      if (!database) {
          ElMessage.warning(tr("请先选择查询所属的数据库"));
          return false;
      }
      let name = tab.savedQueryName || tab.title;
      if (!tab.savedQueryId) {
          try {
              const response = await ElMessageBox.prompt(tr("请输入查询名称"), tr("保存查询"), {
                  confirmButtonText: tr("保存"),
                  cancelButtonText: tr("取消"),
                  inputValue: /^(?:查询|Query) \d+$/.test(name) ? "" : name,
                  inputPlaceholder: tr("查询名称"),
                  inputValidator: (value) => Boolean(value.trim()) && value.trim().length <= 160 || tr("查询名称需为 1–160 个字符"),
              });
              name = response.value.trim();
          }
          catch (error) {
              if (error !== "cancel" && error !== "close")
                  ElMessage.error(error instanceof Error ? error.message : tr("无法读取查询名称"));
              return false;
          }
      }
      try {
          if (tab.savedQueryId) {
              await api(`/api/v1/database-saved-queries/${tab.savedQueryId}`, {
                  method: "PUT",
                  body: JSON.stringify({ connectionId: $connections.selectedConnectionId.value, database, name, sql: tab.sql }),
              });
          }
          else {
              const created = await api<{
                  id: string;
              }>("/api/v1/database-saved-queries", {
                  method: "POST",
                  body: JSON.stringify({ connectionId: $connections.selectedConnectionId.value, database, name, sql: tab.sql }),
              });
              tab.savedQueryId = created.id;
          }
          tab.title = name;
          tab.database = database;
          tab.savedQuerySql = tab.sql;
          tab.savedQueryName = name;
          tab.savedQueryDatabase = database;
          await loadSavedQueries();
          ElMessage.success(tr("查询 {0} 已保存", [name]));
          return true;
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("保存查询失败"));
          return false;
      }
  }

  async function openSavedQuery(item: SavedQueryItem) {
      const existing = $queryTabs.tabs.value.find((tab) => tab.kind === "sql" && tab.savedQueryId === item.id);
      if (existing)
          $queryTabs.activeTabId.value = existing.id;
      else
          syncSavedQueryTab($queryTabs.newTab(item.sql, item.database, item.name), item);
      selectUtilityItem(item.database, "queries", item.id);
      try {
          const accessed = await api<{
              accessedAt: string;
          }>(`/api/v1/database-saved-queries/${item.id}/access`, { method: "POST" });
          item.accessedAt = accessed.accessedAt;
      }
      catch {
          // Opening the locally loaded query remains useful if the access timestamp update fails.
      }
  }

  async function deleteSavedQuery(item: SavedQueryItem) {
      try {
          await ElMessageBox.confirm(tr("确定删除查询“{0}”吗？", [item.name]), tr("删除查询"), {
              confirmButtonText: tr("删除"),
              cancelButtonText: tr("取消"),
              type: "warning",
          });
          await api(`/api/v1/database-saved-queries/${item.id}`, { method: "DELETE" });
          $queryTabs.tabs.value = $queryTabs.tabs.value.filter((tab) => tab.savedQueryId !== item.id);
          if (!$queryTabs.tabs.value.some((tab) => tab.id === $queryTabs.activeTabId.value))
              $queryTabs.activeTabId.value = $queryTabs.tabs.value.at(-1)?.id ?? "";
          await loadSavedQueries();
          ElMessage.success(tr("查询 {0} 已删除", [item.name]));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("删除查询失败"));
      }
  }

  async function duplicateSavedQuery(item: SavedQueryItem) {
      try {
          const response = await ElMessageBox.prompt(tr("请输入副本名称"), tr("复制查询"), {
              confirmButtonText: tr("复制"),
              cancelButtonText: tr("取消"),
              inputValue: tr("{0} 副本", [item.name]),
              inputValidator: (value) => Boolean(value.trim()) && value.trim().length <= 160 || tr("查询名称需为 1–160 个字符"),
          });
          const created = await api<{
              id: string;
          }>("/api/v1/database-saved-queries", {
              method: "POST",
              body: JSON.stringify({ connectionId: item.connectionId, database: item.database, name: response.value.trim(), sql: item.sql }),
          });
          await loadSavedQueries();
          const copy = savedQueries.value.find((candidate) => candidate.id === created.id);
          if (copy)
              await openSavedQuery(copy);
          ElMessage.success(tr("查询已复制"));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("复制查询失败"));
      }
  }

  async function renameSavedQuery(item: SavedQueryItem) {
      try {
          const response = await ElMessageBox.prompt(tr("请输入新的查询名称"), tr("重命名查询"), {
              confirmButtonText: tr("重命名"),
              cancelButtonText: tr("取消"),
              inputValue: item.name,
              inputValidator: (value) => Boolean(value.trim()) && value.trim().length <= 160 || tr("查询名称需为 1–160 个字符"),
          });
          const name = response.value.trim();
          await api(`/api/v1/database-saved-queries/${item.id}`, {
              method: "PUT",
              body: JSON.stringify({ connectionId: item.connectionId, database: item.database, name, sql: item.sql }),
          });
          for (const tab of $queryTabs.tabs.value.filter((candidate) => candidate.savedQueryId === item.id)) {
              tab.title = name;
              tab.savedQueryName = name;
          }
          await loadSavedQueries();
          ElMessage.success(tr("查询已重命名"));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("重命名查询失败"));
      }
  }

  function exportSavedQuery(item: SavedQueryItem) {
      const url = URL.createObjectURL(new Blob([item.sql], { type: "application/sql;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${item.name.replaceAll(/[\\/:*?"<>|]/g, "_")}.sql`;
      link.click();
      URL.revokeObjectURL(url);
  }

  function selectBrowserSqlFile(): Promise<{
      name: string;
      content: string;
  } | null> {
      return new Promise((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".sql,application/sql,text/plain";
          input.addEventListener("change", async () => {
              const file = input.files?.[0];
              resolve(file ? { name: file.name, content: await file.text() } : null);
          }, { once: true });
          input.addEventListener("cancel", () => resolve(null), { once: true });
          input.click();
      });
  }

  async function openExternalQuery() {
      try {
          const selected = isDesktopApp()
              ? await selectDesktopDatabaseSqlFile().then((item) => item.selected && item.name !== undefined && item.content !== undefined ? { name: item.name, content: item.content } : null)
              : await selectBrowserSqlFile();
          if (!selected)
              return;
          const title = selected.name.replace(/\.sql$/i, "") || tr("外部查询");
          $queryTabs.newTab(selected.content, $navigator.selectedDatabase.value, title);
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("无法打开外部查询"));
      }
  }

  async function openSavedQueryExternally(item: SavedQueryItem) {
      try {
          if (isDesktopApp())
              await openDesktopDatabaseQueryExternally({ id: item.id, name: item.name, sql: item.sql });
          else {
              exportSavedQuery(item);
              ElMessage.info(tr("浏览器已下载 SQL 文件，请使用本机编辑器打开"));
          }
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("无法使用外部编辑器打开查询"));
      }
  }

  async function revealSavedQuery(item: SavedQueryItem) {
      try {
          if (isDesktopApp())
              await revealDesktopDatabaseQuery({ id: item.id, name: item.name, sql: item.sql });
          else {
              exportSavedQuery(item);
              ElMessage.info(tr("浏览器已将 SQL 文件下载到默认下载目录"));
          }
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("无法定位查询文件"));
      }
  }

  async function restoreSelectedBackup(item: DatabaseTreeTask) {
      const database = databaseTaskDatabase(item);
      try {
          await ElMessageBox.confirm(tr("确定将备份“{0}”还原到数据库 {1} 吗？", [item.title, database]), tr("还原备份"), {
              confirmButtonText: tr("还原"),
              cancelButtonText: tr("取消"),
              type: "warning",
          });
          await api(`/api/v1/database-backups/${item.id}/restore`, { method: "POST", body: JSON.stringify({ database }) });
          await loadDatabaseTasks();
          $queryTabs.openTaskPanel(database);
          ElMessage.success(tr("恢复任务已开始"));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("无法还原备份"));
      }
  }

  async function deleteBackupObject(item: DatabaseTreeTask) {
      try {
          await ElMessageBox.confirm(tr("确定删除备份“{0}”及其 SQL 文件吗？", [item.title]), tr("删除备份"), {
              confirmButtonText: tr("删除"),
              cancelButtonText: tr("取消"),
              type: "warning",
          });
          await api(`/api/v1/database-backups/${item.id}`, { method: "DELETE" });
          await loadDatabaseTasks();
          ElMessage.success(tr("备份已删除"));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("无法删除备份"));
      }
  }

  async function duplicateBackupObject(item: DatabaseTreeTask) {
      try {
          const response = await ElMessageBox.prompt(tr("请输入备份副本名称"), tr("复制备份"), {
              confirmButtonText: tr("复制"),
              cancelButtonText: tr("取消"),
              inputValue: tr("{0} 副本", [item.title]),
              inputValidator: (value) => Boolean(value.trim()) && value.trim().length <= 160 || tr("备份名称需为 1–160 个字符"),
          });
          await api(`/api/v1/database-backups/${item.id}/duplicate`, { method: "POST", body: JSON.stringify({ name: response.value.trim() }) });
          await loadDatabaseTasks();
          ElMessage.success(tr("备份已复制"));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("无法复制备份"));
      }
  }

  async function renameBackupObject(item: DatabaseTreeTask) {
      try {
          const response = await ElMessageBox.prompt(tr("请输入新的备份名称"), tr("重命名备份"), {
              confirmButtonText: tr("重命名"),
              cancelButtonText: tr("取消"),
              inputValue: item.title,
              inputValidator: (value) => Boolean(value.trim()) && value.trim().length <= 160 || tr("备份名称需为 1–160 个字符"),
          });
          await api(`/api/v1/database-backups/${item.id}`, { method: "PATCH", body: JSON.stringify({ name: response.value.trim() }) });
          await loadDatabaseTasks();
          ElMessage.success(tr("备份已重命名"));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("无法重命名备份"));
      }
  }

  async function extractBackupSql(item: DatabaseTreeTask) {
      try {
          await downloadApiFile(`/api/v1/database-tasks/${item.id}/download`, item.outputFilename || `${item.title}.sql`);
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("无法提取 SQL"));
      }
  }

  async function revealBackupObject(item: DatabaseTreeTask) {
      const path = `/api/v1/database-tasks/${item.id}/download`;
      const filename = item.outputFilename || `${item.title}.sql`;
      try {
          if (isDesktopApp())
              await revealDesktopDatabaseBackup({ id: item.id, path, filename });
          else {
              await downloadApiFile(path, filename);
              ElMessage.info(tr("浏览器已将备份下载到默认下载目录"));
          }
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("无法定位备份文件"));
      }
  }

  function extractSqlFromFile() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".sql,application/sql,text/plain";
      input.addEventListener("change", async () => {
          const file = input.files?.[0];
          if (!file)
              return;
          const url = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: "application/sql;charset=utf-8" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = file.name.toLowerCase().endsWith(".sql") ? file.name : `${file.name}.sql`;
          link.click();
          URL.revokeObjectURL(url);
      }, { once: true });
      input.click();
  }

  async function addFavorite() {
      if (!$queryTabs.activeTab.value || !$connections.selectedConnectionId.value)
          return;
      try {
          const result = await ElMessageBox.prompt(tr("给这段 SQL 起一个便于查找的名称"), tr("收藏 SQL"), { confirmButtonText: tr("收藏"), cancelButtonText: tr("取消"), inputValue: $queryTabs.activeTab.value.title });
          await api("/api/v1/database-query-favorites", {
              method: "POST",
              body: JSON.stringify({
                  connectionId: $connections.selectedConnectionId.value,
                  database: $queryTabs.activeTab.value.database || $navigator.selectedDatabase.value,
                  name: result.value,
                  sql: $queryTabs.activeTab.value.sql,
              }),
          });
          ElMessage.success(tr("SQL 已收藏"));
          await loadFavorites();
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("收藏失败"));
      }
  }

  async function loadHistory() {
      if (!$connections.selectedConnectionId.value)
          return;
      const response = await api<{
          items: HistoryItem[];
      }>(`/api/v1/database-query-history?connectionId=${$connections.selectedConnectionId.value}`);
      historyItems.value = response.items;
  }

  async function loadFavorites() {
      if (!$connections.selectedConnectionId.value)
          return;
      const response = await api<{
          items: FavoriteItem[];
      }>(`/api/v1/database-query-favorites?connectionId=${$connections.selectedConnectionId.value}`);
      favorites.value = response.items;
  }

  async function loadSavedQueries() {
      if (!$connections.selectedConnectionId.value)
          return;
      const response = await api<{
          items: SavedQueryItem[];
      }>(`/api/v1/database-saved-queries?connectionId=${$connections.selectedConnectionId.value}`);
      savedQueries.value = response.items;
  }

  async function loadDatabaseTasks() {
      if (!$connections.selectedConnectionId.value)
          return;
      const response = await api<{
          items: DatabaseTreeTask[];
      }>("/api/v1/database-tasks");
      databaseTasks.value = response.items;
  }

  function updateDatabaseTasks(items: DatabaseTreeTask[]) {
      databaseTasks.value = items;
  }

  function openSaved(sql: string, database: string, title: string) {
      $queryTabs.newTab(sql, database || $navigator.selectedDatabase.value, title);
      sidePanel.value = "";
  }

  async function deleteFavorite(item: FavoriteItem) {
      await api(`/api/v1/database-query-favorites/${item.id}`, { method: "DELETE" });
      await loadFavorites();
      ElMessage.success(tr("收藏已删除"));
  }

  return {
    syncDialogOpen,
    syncDialogMode,
    sidePanel,
    historyItems,
    favorites,
    savedQueries,
    selectedUtilityItems,
    databaseTasks,
    automationWorkspace,
    modelWorkspace,
    biWorkspace,
    activeUtilityItems,
    queryFavoritesForDatabase,
    savedQueriesForDatabase,
    databaseTaskDatabase,
    backupTasksForDatabase,
    selectedSavedQuery,
    selectedBackup,
    selectUtilityItem,
    utilitySelectionKey,
    handleGlobalBackupCommand,
    openSyncDialog,
    handleDatabaseToolCommand,
    startDatabaseBackup,
    runServerReload,
    syncSavedQueryTab,
    saveQueryTab,
    openSavedQuery,
    deleteSavedQuery,
    duplicateSavedQuery,
    renameSavedQuery,
    exportSavedQuery,
    selectBrowserSqlFile,
    openExternalQuery,
    openSavedQueryExternally,
    revealSavedQuery,
    restoreSelectedBackup,
    deleteBackupObject,
    duplicateBackupObject,
    renameBackupObject,
    extractBackupSql,
    revealBackupObject,
    extractSqlFromFile,
    addFavorite,
    loadHistory,
    loadFavorites,
    loadSavedQueries,
    loadDatabaseTasks,
    updateDatabaseTasks,
    openSaved,
    deleteFavorite,
  };
}

export type { DatabaseArtifactsApi } from "./context";
