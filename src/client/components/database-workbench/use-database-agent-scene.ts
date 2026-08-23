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

export function useDatabaseAgentScene(
  ctx: DatabaseWorkbenchContext,
  props: Readonly<DatabaseWorkbenchProps>,
  route: { fullPath: string },
) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $connections = deferDatabaseWorkbenchPart(ctx, "connections");
  const $navigator = deferDatabaseWorkbenchPart(ctx, "navigator");
  const $queryTabs = deferDatabaseWorkbenchPart(ctx, "queryTabs");
  const $artifacts = deferDatabaseWorkbenchPart(ctx, "artifacts");
  const $menuActions = deferDatabaseWorkbenchPart(ctx, "menuActions");
  let removeAgentDatabaseSceneProvider: (() => void) | undefined;

  let removeAgentWorkbenchExecutionProvider: (() => void) | undefined;

  const pendingAgentDatabaseExecutions = new Map<string, {
      jobId: string;
      tab: QueryTab;
      timer: number;
      reject: (error: Error) => void;
  }>();

  function registerDatabaseAgentScene() {
      removeAgentDatabaseSceneProvider?.();
      removeAgentDatabaseSceneProvider = undefined;
      if (!props.active)
          return;
      removeAgentDatabaseSceneProvider = registerAgentDatabaseSceneProvider({
          current: () => {
              if (!props.active)
                  return null;
              const connection = $connections.selectedConnection.value;
              const database = $queryTabs.activeTab.value?.kind === "sql" ? $queryTabs.activeTab.value.database : $navigator.selectedDatabase.value;
              if (!connection || !database)
                  return null;
              const result = $queryTabs.activeTab.value?.kind === "sql" ? $queryTabs.queryResult($queryTabs.activeTab.value) : undefined;
              return {
                  routePath: route.fullPath,
                  connectionId: connection.id,
                  connectionName: connection.name,
                  database,
                  connected: $connections.databaseConnected.value,
                  localExecution: isDesktopApp() && desktopExecutionTargets.value.database === "local",
                  editorSql: $queryTabs.activeTab.value?.kind === "sql" ? $queryTabs.activeTab.value.sql : "",
                  selectedSql: $queryTabs.activeTab.value?.kind === "sql" ? ($queryTabs.sqlEditor.value?.selectedSql() ?? "") : "",
                  resultPreview: result?.rows.slice(0, 20) ?? [],
              };
          },
          fill: (connectionId, database, sql) => {
              if (!props.active || $connections.selectedConnectionId.value !== connectionId || !$connections.databaseConnected.value || desktopExecutionTargets.value.database !== "local")
                  return false;
              const tab = $queryTabs.activeTab.value?.kind === "sql" && $queryTabs.activeTab.value.database === database ? $queryTabs.activeTab.value : $queryTabs.newTab("", database, tr("Viron Agent SQL"));
              tab.sql = sql;
              return true;
          },
      });
  }

  function databaseAgentResult(request: AgentWorkbenchExecutionRequest & {
      domain: "database";
  }, job: QueryJob): AgentDatabaseReadResult {
      if (job.status !== "success")
          throw new Error(job.error || tr("数据库工作台查询失败"));
      const result = job.resultSets[0];
      if (!result) {
          return {
              connectionId: request.connectionId,
              connectionName: $connections.selectedConnection.value?.name || tr("数据库连接"),
              database: request.database,
              sql: request.sql,
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              durationMs: job.durationMs ?? 0,
              presentation: "workbench",
          };
      }
      const rows = agentTransportValue(result.rows.slice(0, 100));
      if (!Array.isArray(rows))
          throw new Error(tr("数据库工作台查询结果无效"));
      return {
          connectionId: request.connectionId,
          connectionName: $connections.selectedConnection.value?.name || tr("数据库连接"),
          database: request.database,
          sql: request.sql,
          columns: result.columns.map((column) => column.name),
          rows: rows as AgentDatabaseReadResult["rows"],
          rowCount: result.rows.length,
          truncated: result.truncated || result.rows.length > 100,
          durationMs: job.durationMs ?? 0,
          presentation: "workbench",
          affectedRows: result.affectedRows,
          insertId: result.insertId,
      };
  }

  async function executeAgentDatabaseWorkbench(request: AgentWorkbenchExecutionRequest & {
      domain: "database";
  }): Promise<{
      domain: "database";
      requestId: string;
      result: AgentDatabaseReadResult;
  }> {
      if (!props.active
          || !$layout.workbenchElement.value?.getClientRects().length
          || $connections.selectedConnectionId.value !== request.connectionId
          || !$connections.databaseConnected.value
          || desktopExecutionTargets.value.database !== "local"
          || $queryTabs.tabs.value.some((item) => item.job && ["pending", "running"].includes(item.job.status))
          || pendingAgentDatabaseExecutions.size)
          throw new Error(tr("请切回 Agent 绑定的空闲本机数据库工作台后重试"));
      const tab = $queryTabs.activeTab.value?.kind === "sql" && $queryTabs.activeTab.value.database === request.database
          ? $queryTabs.activeTab.value
          : $queryTabs.newTab("", request.database, tr("Viron Agent SQL"));
      tab.sql = request.sql;
      tab.job = { id: "", status: "pending", resultSets: [] };
      tab.activeResult = 0;
      let response: {
          job: QueryJob;
      };
      try {
          response = await api<{
              job: QueryJob;
          }>(`/api/v1/database-connections/${request.connectionId}/queries`, {
              method: "POST",
              body: JSON.stringify({ sql: request.sql, database: request.database, continueOnError: false }),
          });
          tab.job = response.job;
      }
      catch (error) {
          tab.job = { id: "", status: "error", error: error instanceof Error ? error.message : tr("查询启动失败"), resultSets: [] };
          throw error instanceof Error ? error : new Error(tr("查询启动失败"));
      }
      return new Promise((resolve, reject) => {
          const poll = async () => {
              try {
                  const latest = await api<{
                      job: QueryJob;
                  }>(`/api/v1/database-queries/${response.job.id}`);
                  tab.job = latest.job;
                  if (["pending", "running"].includes(latest.job.status))
                      return;
                  const pending = pendingAgentDatabaseExecutions.get(request.requestId);
                  if (!pending)
                      return;
                  pendingAgentDatabaseExecutions.delete(request.requestId);
                  window.clearInterval(pending.timer);
                  await $artifacts.loadHistory();
                  if (latest.job.status === "success")
                      resolve({ domain: "database", requestId: request.requestId, result: databaseAgentResult(request, latest.job) });
                  else
                      reject(new Error(latest.job.error || tr("数据库工作台查询失败")));
              }
              catch (error) {
                  const pending = pendingAgentDatabaseExecutions.get(request.requestId);
                  if (!pending)
                      return;
                  pendingAgentDatabaseExecutions.delete(request.requestId);
                  window.clearInterval(pending.timer);
                  tab.job = { id: response.job.id, status: "error", error: error instanceof Error ? error.message : tr("读取查询结果失败"), resultSets: [] };
                  reject(error instanceof Error ? error : new Error(tr("读取查询结果失败")));
              }
          };
          const timer = window.setInterval(() => void poll(), 350);
          pendingAgentDatabaseExecutions.set(request.requestId, { jobId: response.job.id, tab, timer, reject });
          void poll();
      });
  }

  function registerDatabaseAgentWorkbenchExecution() {
      removeAgentWorkbenchExecutionProvider?.();
      removeAgentWorkbenchExecutionProvider = undefined;
      if (!props.active)
          return;
      removeAgentWorkbenchExecutionProvider = registerAgentWorkbenchExecutionProvider({
          domain: "database",
          routePath: () => props.active && $layout.workbenchElement.value?.getClientRects().length ? route.fullPath : null,
          execute: (request) => {
              if (request.domain !== "database")
                  throw new Error(tr("Viron Agent 数据库工作台请求无效"));
              return executeAgentDatabaseWorkbench(request);
          },
          cancel: async (requestId, reason) => {
              const pending = pendingAgentDatabaseExecutions.get(requestId);
              if (!pending)
                  return;
              pendingAgentDatabaseExecutions.delete(requestId);
              window.clearInterval(pending.timer);
              await api(`/api/v1/database-queries/${pending.jobId}`, { method: "DELETE" }).catch(() => undefined);
              pending.tab.job = { id: pending.jobId, status: "cancelled", error: reason, resultSets: [] };
              pending.reject(new Error(reason || tr("数据库工作台执行已取消")));
          },
      });
  }

  function unregisterDatabaseAgentProviders() {
      removeAgentDatabaseSceneProvider?.();
      removeAgentDatabaseSceneProvider = undefined;
      removeAgentWorkbenchExecutionProvider?.();
      removeAgentWorkbenchExecutionProvider = undefined;
  }

  function disposeAgentScene() {
      unregisterDatabaseAgentProviders();
      for (const [requestId, pending] of pendingAgentDatabaseExecutions) {
          pendingAgentDatabaseExecutions.delete(requestId);
          window.clearInterval(pending.timer);
          void api(`/api/v1/database-queries/${pending.jobId}`, { method: "DELETE" }).catch(() => undefined);
          pending.reject(new Error(tr("当前数据库工作台已关闭")));
      }
  }

  return {
    removeAgentDatabaseSceneProvider,
    removeAgentWorkbenchExecutionProvider,
    pendingAgentDatabaseExecutions,
    registerDatabaseAgentScene,
    databaseAgentResult,
    executeAgentDatabaseWorkbench,
    registerDatabaseAgentWorkbenchExecution,
    unregisterDatabaseAgentProviders,
    disposeAgentScene,
  };
}

export type { DatabaseAgentSceneApi } from "./context";
