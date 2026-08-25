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

export function useDatabaseQueryTabs(
  ctx: DatabaseWorkbenchContext,
  props: Readonly<DatabaseWorkbenchProps>,
  route: { fullPath: string },
  focusSearchInput: (container: HTMLElement | null) => void,
) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $connections = deferDatabaseWorkbenchPart(ctx, "connections");
  const $navigator = deferDatabaseWorkbenchPart(ctx, "navigator");
  const $artifacts = deferDatabaseWorkbenchPart(ctx, "artifacts");
  const $agentScene = deferDatabaseWorkbenchPart(ctx, "agentScene");
  const $menuActions = deferDatabaseWorkbenchPart(ctx, "menuActions");
  const tabs = ref<QueryTab[]>([]);

  const activeTabId = ref("");

  const taskPanel = ref(false);

  const taskPanelRequest = ref<{
      id: string;
      type: "restore" | "list" | "transfer";
  }>();

  const queryBuilderOpen = ref(false);

  const codeSnippetOpen = ref(false);

  const dataGenerator = ref({ visible: false, database: "", table: "" });

  const pollTimers = new Set<number>();

  let databaseSessionPollTimer: number | undefined;

  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null);

  const queryRunning = computed(() => ["pending", "running"].includes(activeTab.value?.job?.status ?? ""));

  const continueOnQueryError = ref(false);

  const sqlEditor = ref<{
      currentStatementSql(): string;
      selectedSql(): string;
      openFind(): void;
  } | null>(null);

  let removeShortcutListener: (() => void) | undefined;

  function newTab(sql = "", database = $navigator.selectedDatabase.value, title?: string): QueryTab {
      const id = createClientId();
      const tab: QueryTab = { id, title: title ?? tr("查询 {0}", [tabs.value.length + 1]), sql, database, job: null, activeResult: 0, kind: "sql" };
      tabs.value.push(tab);
      activeTabId.value = id;
      return tab;
  }

  function queryTabDirty(tab: QueryTab): boolean {
      if (tab.kind !== "sql")
          return false;
      if (!tab.savedQueryId)
          return Boolean(tab.sql.trim());
      return tab.sql !== (tab.savedQuerySql ?? "")
          || tab.title !== (tab.savedQueryName ?? "")
          || tab.database !== (tab.savedQueryDatabase ?? "");
  }

  const dataTabs = computed(() => tabs.value.filter((tab) => tab.kind === "data" && tab.table));

  function newDataTab(database: string, table: string, readOnly: boolean): QueryTab {
      const existing = tabs.value.find((tab) => tab.kind === "data" && tab.database === database && tab.table === table);
      if (existing) {
          activeTabId.value = existing.id;
          return existing;
      }
      const id = createClientId();
      tabs.value.push({
          id,
          title: `${table}@${database}`,
          sql: "",
          database,
          table,
          readOnly,
          job: null,
          activeResult: 0,
          kind: "data",
      });
      activeTabId.value = id;
      return tabs.value[tabs.value.length - 1];
  }

  function newCommandLine(database = $navigator.selectedDatabase.value) {
      const existing = tabs.value.find((tab) => tab.kind === "command-line" && tab.database === database);
      if (existing) {
          activeTabId.value = existing.id;
          return existing;
      }
      const tab: QueryTab = {
          id: createClientId(),
          title: tr("命令列@{0}", [database || $connections.selectedConnection.value?.name || tr("连接")]),
          sql: "",
          database,
          job: null,
          activeResult: 0,
          kind: "command-line",
      };
      tabs.value.push(tab);
      activeTabId.value = tab.id;
      return tab;
  }

  function newTableDesigner(database: string, table?: string): QueryTab {
      if (table) {
          const existing = tabs.value.find((tab) => tab.kind === "table-design" && tab.database === database && tab.table === table);
          if (existing) {
              activeTabId.value = existing.id;
              return existing;
          }
      }
      const id = createClientId();
      const tab: QueryTab = {
          id,
          title: table ? tr("设计 {0}@{1}", [table, database]) : tr("无标题@{0}", [database]),
          sql: "",
          database,
          table,
          job: null,
          activeResult: 0,
          kind: "table-design",
          dirty: !table,
      };
      tabs.value.push(tab);
      activeTabId.value = id;
      return tab;
  }

  function newObjectTab(database: string, category: NavigatorCategory) {
      if (!("sources" in category))
          return;
      const existing = tabs.value.find((tab) => tab.kind === "objects");
      if (existing) {
          existing.database = database;
          existing.category = category.key;
          existing.title = tr("对象");
          activeTabId.value = existing.id;
          return;
      }
      const id = createClientId();
      tabs.value.push({
          id,
          title: tr("对象"),
          sql: "",
          database,
          category: category.key,
          job: null,
          activeResult: 0,
          kind: "objects",
      });
      activeTabId.value = id;
  }

  function newUtilityTab(database: string, category: UtilityCategory) {
      const existing = tabs.value.find((tab) => tab.kind === "utility" && tab.database === database && tab.utilityCategory === category);
      if (existing) {
          activeTabId.value = existing.id;
          return existing;
      }
      const id = createClientId();
      const tab: QueryTab = {
          id,
          title: category === "queries" ? tr("查询") : tr("备份"),
          sql: "",
          database,
          utilityCategory: category,
          job: null,
          activeResult: 0,
          kind: "utility",
      };
      tabs.value.push(tab);
      activeTabId.value = id;
      return tab;
  }

  function newArtifactTab(kind: "automation" | "model" | "user" | "bi") {
      const existing = tabs.value.find((tab) => tab.kind === kind);
      if (existing) {
          activeTabId.value = existing.id;
          return existing;
      }
      const id = createClientId();
      const tab: QueryTab = {
          id,
          title: kind === "automation" ? tr("自动运行") : kind === "model" ? tr("模型") : kind === "user" ? tr("用户") : "BI",
          sql: "",
          database: $navigator.selectedDatabase.value,
          job: null,
          activeResult: 0,
          kind,
          dirty: false,
      };
      tabs.value.push(tab);
      activeTabId.value = id;
      return tab;
  }

  async function closeTab(tab: QueryTab) {
      if (["table-design", "automation", "model", "bi"].includes(tab.kind) && tab.dirty) {
          if (activeTabId.value !== tab.id) {
              activeTabId.value = tab.id;
              await nextTick();
          }
          try {
              const artifact = tab.kind === "table-design" ? tr("表设计") : tab.kind === "automation" ? tr("批处理作业") : tab.kind === "model" ? tr("模型") : tr("BI 工作区");
              await ElMessageBox.confirm(tr("当前{0}尚未保存。", [artifact]), tr("关闭{0}", [artifact]), {
                  confirmButtonText: tab.kind === "table-design" ? tr("放弃并关闭") : tr("保存"),
                  cancelButtonText: tab.kind === "table-design" ? tr("继续设计") : tr("不保存"),
                  distinguishCancelAndClose: tab.kind !== "table-design",
                  type: "warning",
              });
              if (tab.kind === "automation" && !await $artifacts.automationWorkspace.value?.save())
                  return;
              if (tab.kind === "model" && !await $artifacts.modelWorkspace.value?.save())
                  return;
              if (tab.kind === "bi" && !await $artifacts.biWorkspace.value?.save())
                  return;
          }
          catch (action) {
              if (tab.kind === "table-design" || action !== "cancel")
                  return;
          }
      }
      if (queryTabDirty(tab)) {
          try {
              await ElMessageBox.confirm(tr("当前查询尚未保存。"), tr("保存查询"), {
                  confirmButtonText: tr("保存"),
                  cancelButtonText: tr("不保存"),
                  distinguishCancelAndClose: true,
                  closeOnClickModal: false,
                  type: "warning",
              });
              if (!await $artifacts.saveQueryTab(tab))
                  return;
          }
          catch (action) {
              if (action !== "cancel")
                  return;
          }
      }
      const index = tabs.value.findIndex((item) => item.id === tab.id);
      tabs.value.splice(index, 1);
      if (activeTabId.value === tab.id)
          activeTabId.value = tabs.value[Math.max(0, index - 1)]?.id ?? "";
  }

  function setTableDesignerDirty(tab: QueryTab, dirty: boolean) {
      tab.dirty = dirty;
  }

  async function handleTableDesignerSaved(tab: QueryTab, payload: {
      tableName: string;
      existing: boolean;
  }) {
      tab.dirty = false;
      await $navigator.loadDatabaseObjects(tab.database, true);
      await $navigator.loadSqlCompletionCatalog(tab.database, true);
      const next = new Set($navigator.expandedCategories.value);
      next.add($navigator.categoryKey(tab.database, "tables"));
      $navigator.expandedCategories.value = next;
      if (payload.existing) {
          tab.title = tr("设计 {0}@{1}", [payload.tableName, tab.database]);
          return;
      }
      const index = tabs.value.findIndex((item) => item.id === tab.id);
      if (index >= 0)
          tabs.value.splice(index, 1);
      newDataTab(tab.database, payload.tableName, false);
  }

  async function waitForQueryJob(jobId: string): Promise<QueryJob> {
      for (let attempt = 0; attempt < 480; attempt += 1) {
          const response = await api<{
              job: QueryJob;
          }>(`/api/v1/database-queries/${jobId}`);
          if (!["pending", "running"].includes(response.job.status))
              return response.job;
          await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      throw new Error(tr("等待数据库操作完成超时"));
  }

  function removeTabsForDatabase(database: string) {
      const activeWasRemoved = activeTab.value?.database === database;
      tabs.value = tabs.value.filter((tab) => tab.database !== database);
      if (activeWasRemoved || !tabs.value.some((tab) => tab.id === activeTabId.value)) {
          activeTabId.value = tabs.value[0]?.id ?? "";
      }
  }

  function triggerSelectedTableAction(type: "import" | "export", format?: "csv" | "xlsx" | "sql") {
      const context = $navigator.selectedTableContext();
      if (!context)
          return ElMessage.warning(tr("请先选择一个表"));
      const tab = newDataTab(context.database, context.item.name, false);
      tab.tableAction = { id: createClientId(), type, format };
  }

  function clearTableAction(id: string) {
      const tab = tabs.value.find((candidate) => candidate.tableAction?.id === id);
      if (tab)
          delete tab.tableAction;
  }

  async function refreshUtilityTab(tab = activeTab.value) {
      if (tab?.kind !== "utility" || !tab.utilityCategory)
          return;
      if (tab.utilityCategory === "queries")
          await $artifacts.loadSavedQueries();
      else
          await $artifacts.loadDatabaseTasks();
  }

  function createFromUtilityTab(tab = activeTab.value) {
      if (tab?.kind !== "utility" || !tab.utilityCategory)
          return;
      if (tab.utilityCategory === "queries")
          newTab("", tab.database);
      else
          void $artifacts.startDatabaseBackup(tab.database);
  }

  function closeTaskPanelRequest(id: string) {
      if (taskPanelRequest.value?.id === id)
          taskPanelRequest.value = undefined;
  }

  function openTaskPanel(database: string, type: "restore" | "list" | "transfer" = "list") {
      $navigator.selectedDatabase.value = database;
      $artifacts.sidePanel.value = "";
      taskPanel.value = true;
      taskPanelRequest.value = { id: createClientId(), type };
  }

  function requireSelectedDatabase(): string | null {
      if (!$connections.selectedConnection.value || !$connections.databaseConnected.value) {
          ElMessage.warning(tr("请先双击打开数据库连接"));
          return null;
      }
      if (!$navigator.selectedDatabase.value) {
          ElMessage.warning(tr("请先选择数据库"));
          return null;
      }
      return $navigator.selectedDatabase.value;
  }

  function handleGlobalQueryCommand(command: string) {
      if (command === "new")
          newTab("", $navigator.selectedDatabase.value);
      else if (command === "queries")
          void $navigator.openGlobalCategory("queries");
  }

  async function executeDatabaseStatement(sql: string, database: string): Promise<QueryJob> {
      const response = await api<{
          job: QueryJob;
      }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/queries`, {
          method: "POST",
          body: JSON.stringify({ sql, database }),
      });
      const job = await waitForQueryJob(response.job.id);
      if (job.status !== "success")
          throw new Error(job.error || tr("数据库操作失败"));
      await $artifacts.loadHistory();
      return job;
  }

  async function runQuery(sql?: string, tab = activeTab.value) {
      if (!$connections.selectedConnectionId.value || !$connections.databaseConnected.value)
          return ElMessage.warning(tr("请先连接数据库"));
      if (!tab)
          return;
      const statement = (sql ?? tab.sql).trim();
      if (!statement)
          return ElMessage.warning(tr("请输入要执行的 SQL"));
      tab.job = { id: "", status: "pending", resultSets: [] };
      tab.activeResult = 0;
      try {
          const response = await api<{
              job: QueryJob;
          }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/queries`, {
              method: "POST",
              body: JSON.stringify({
                  sql: statement,
                  database: tab.database || $navigator.selectedDatabase.value,
                  continueOnError: continueOnQueryError.value,
              }),
          });
          tab.job = response.job;
          pollJob(tab, response.job.id);
      }
      catch (error) {
          tab.job = { id: "", status: "error", error: error instanceof Error ? error.message : tr("查询启动失败"), resultSets: [] };
      }
  }

  function pollJob(tab: QueryTab, jobId: string) {
      const timer = window.setInterval(async () => {
          try {
              const response = await api<{
                  job: QueryJob;
              }>(`/api/v1/database-queries/${jobId}`);
              tab.job = response.job;
              if (!["pending", "running"].includes(response.job.status)) {
                  window.clearInterval(timer);
                  pollTimers.delete(timer);
                  await $artifacts.loadHistory();
              }
          }
          catch (error) {
              window.clearInterval(timer);
              pollTimers.delete(timer);
              tab.job = { id: jobId, status: "error", error: error instanceof Error ? error.message : tr("读取查询结果失败"), resultSets: [] };
          }
      }, 350);
      pollTimers.add(timer);
  }

  async function cancelQuery() {
      const job = activeTab.value?.job;
      if (!job?.id)
          return;
      try {
          await api(`/api/v1/database-queries/${job.id}`, { method: "DELETE" });
          ElMessage.success(tr("已发送查询取消请求"));
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("取消查询失败"));
      }
  }

  function formatSql() {
      if (!activeTab.value)
          return;
      try {
          activeTab.value.sql = format(activeTab.value.sql, { language: "mysql", keywordCase: "upper", tabWidth: 2 });
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("SQL 格式化失败"));
      }
  }

  async function explainSql() {
      if (!activeTab.value)
          return;
      await runQuery(`EXPLAIN ${activeTab.value.sql}`, activeTab.value);
  }

  function handleQueryRunCommand(command: string) {
      if (command === "run")
          void runQuery();
      else if (command === "current")
          void runQuery(sqlEditor.value?.currentStatementSql());
      else if (command === "selected") {
          const sql = sqlEditor.value?.selectedSql().trim();
          if (!sql)
              ElMessage.info(tr("请先选择要运行的 SQL"));
          else
              void runQuery(sql);
      }
      else if (command === "toggle-continue")
          continueOnQueryError.value = !continueOnQueryError.value;
  }

  function handleBuiltQuery(sql: string, run: boolean) {
      const tab = activeTab.value?.kind === "sql" ? activeTab.value : newTab("", $navigator.selectedDatabase.value);
      tab.sql = sql;
      if (run)
          void runQuery(sql, tab);
  }

  function insertCodeSnippet(sql: string) {
      const tab = activeTab.value?.kind === "sql" ? activeTab.value : newTab("", $navigator.selectedDatabase.value);
      tab.sql = tab.sql.trim() ? `${tab.sql.replace(/\s+$/, "")}\n\n${sql}` : sql;
  }

  function handleGeneratedData(sql: string, run: boolean) {
      const tab = newTab(sql, dataGenerator.value.database, tr("数据生成 · {0}", [dataGenerator.value.table]));
      if (run)
          void runQuery(sql, tab);
  }

  function resultSummary(result: QueryResultSet): string {
      if (result.error)
          return tr("失败");
      if (result.rows.length)
          return tr("{0}{1} 行", [result.rows.length, result.truncated ? "+" : ""]);
      return tr("{0} 行受影响", [result.affectedRows]);
  }

  function queryResult(tab: QueryTab): QueryResultSet | undefined {
      return tab.job?.resultSets[tab.activeResult];
  }

  function handleWorkbenchShortcut(action: ShortcutActionId): boolean {
      if (!props.active || !$layout.workbenchElement.value?.getClientRects().length)
          return false;
      if (action === "workspace.search") {
          if (activeTab.value?.kind === "data")
              return false;
          if (document.activeElement instanceof Element && document.activeElement.closest(".monaco-editor"))
              sqlEditor.value?.openFind();
          else if ($navigator.databaseSearchOpen.value)
              focusSearchInput($navigator.databaseSearchContainer.value);
          else if (activeTab.value?.kind === "objects" || activeTab.value?.kind === "utility")
              focusSearchInput($navigator.objectSearchContainer.value);
          else
              focusSearchInput($connections.connectionSearchContainer.value);
          return true;
      }
      if (action === "workspace.new") {
          newTab("", $navigator.selectedDatabase.value);
          return true;
      }
      if (action === "workspace.design") {
          if (activeTab.value?.kind !== "table-design")
              $navigator.designCurrentTable();
          return true;
      }
      if (action === "workspace.close" && activeTab.value) {
          void closeTab(activeTab.value);
          return true;
      }
      if (action === "workspace.save") {
          if (activeTab.value?.kind === "data")
              return false;
          if (activeTab.value?.kind === "sql") {
              void $artifacts.saveQueryTab(activeTab.value);
              return true;
          }
          return false;
      }
      if (action === "workspace.refresh") {
          if (activeTab.value?.kind === "data")
              return false;
          if (activeTab.value?.kind === "objects")
              void $navigator.refreshObjectCategory(activeTab.value);
          else if (activeTab.value?.kind === "utility" && activeTab.value.utilityCategory === "queries")
              void $artifacts.loadSavedQueries();
          else if (activeTab.value?.kind === "utility")
              void $artifacts.loadDatabaseTasks();
          else if ($navigator.selectedDatabase.value)
              void $navigator.loadDatabaseObjects($navigator.selectedDatabase.value, true);
          else
              void $connections.refreshConnections();
          return true;
      }
      if (action === "workspace.execute" && activeTab.value?.kind === "sql") {
          void runQuery();
          return true;
      }
      return false;
  }

  function handleWorkbenchKeydown(event: KeyboardEvent) {
      if (!props.active)
          return;
      if (event.key === "Escape" && $layout.queryFocused.value) {
          event.preventDefault();
          $layout.queryFocused.value = false;
          return;
      }
      const action = shortcutActionFromKeyboardEvent(event);
      if (action && handleWorkbenchShortcut(action))
          event.preventDefault();
  }

  function startDatabaseWorkbenchListeners() {
      document.addEventListener("keydown", handleWorkbenchKeydown);
      removeShortcutListener = onAppShortcut(handleWorkbenchShortcut);
      databaseSessionPollTimer = window.setInterval($connections.pollDatabaseSession, 3000);
  }

  return {
    tabs,
    activeTabId,
    taskPanel,
    taskPanelRequest,
    queryBuilderOpen,
    codeSnippetOpen,
    dataGenerator,
    continueOnQueryError,
    sqlEditor,
    pollTimers,
    get databaseSessionPollTimer() { return databaseSessionPollTimer; },
    set databaseSessionPollTimer(value: number | undefined) { databaseSessionPollTimer = value; },
    get removeShortcutListener() { return removeShortcutListener; },
    set removeShortcutListener(value: (() => void) | undefined) { removeShortcutListener = value; },
    activeTab,
    queryRunning,
    dataTabs,
    newTab,
    queryTabDirty,
    newDataTab,
    newCommandLine,
    newTableDesigner,
    newObjectTab,
    newUtilityTab,
    newArtifactTab,
    closeTab,
    setTableDesignerDirty,
    handleTableDesignerSaved,
    waitForQueryJob,
    removeTabsForDatabase,
    triggerSelectedTableAction,
    clearTableAction,
    refreshUtilityTab,
    createFromUtilityTab,
    closeTaskPanelRequest,
    openTaskPanel,
    requireSelectedDatabase,
    handleGlobalQueryCommand,
    runQuery,
    pollJob,
    cancelQuery,
    formatSql,
    explainSql,
    handleQueryRunCommand,
    handleBuiltQuery,
    insertCodeSnippet,
    handleGeneratedData,
    executeDatabaseStatement,
    handleWorkbenchShortcut,
    handleWorkbenchKeydown,
    queryResult,
    resultSummary,
    startDatabaseWorkbenchListeners,
  };
}

export type { DatabaseQueryTabsApi } from "./context";
