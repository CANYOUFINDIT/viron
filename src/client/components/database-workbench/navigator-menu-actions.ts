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

export function useNavigatorMenuActions(
  ctx: DatabaseWorkbenchContext,
  props: Readonly<DatabaseWorkbenchProps>,
  route: { fullPath: string },
) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $connections = deferDatabaseWorkbenchPart(ctx, "connections");
  const $navigator = deferDatabaseWorkbenchPart(ctx, "navigator");
  const $queryTabs = deferDatabaseWorkbenchPart(ctx, "queryTabs");
  const $artifacts = deferDatabaseWorkbenchPart(ctx, "artifacts");
  const $agentScene = deferDatabaseWorkbenchPart(ctx, "agentScene");
  async function handleNavigatorMenuAction(action: string) {
      const target = $navigator.navigatorMenu.value.target;
      if (!target)
          return;
      if (target.kind === "connection") {
          const connection = $connections.connections.value.find((item) => item.id === target.connectionId);
          if (!connection)
              return;
          if (action === "close-connection")
              await $connections.closeConnection(connection);
          else if (action === "main-profile")
              await $connections.switchConnectionProfile(connection, null);
          else if (action.startsWith("connection-profile:"))
              await $connections.switchConnectionProfile(connection, action.slice("connection-profile:".length));
          else if (action === "edit-connection")
              $connections.editConnection($connections.activeRootConnectionId.value === connection.id ? $connections.selectedConnection.value ?? connection : connection);
          else if (action === "new-connection")
              $connections.createConnection();
          else if (action === "delete-connection")
              await $connections.deleteConnection(connection);
          else if (action === "duplicate-connection")
              $connections.copyConnection(connection);
          else if (action === "new-database")
              $navigator.createDatabaseTemplate($navigator.schemas.value[0]?.name ?? "");
          else if (action === "new-query")
              $queryTabs.newTab("", $navigator.selectedDatabase.value);
          else if (action === "command-line")
              $queryTabs.newCommandLine($navigator.selectedDatabase.value);
          else if (action === "run-sql-file")
              $queryTabs.openTaskPanel($navigator.selectedDatabase.value, "restore");
          else if (action.startsWith("reload-"))
              await $artifacts.runServerReload(action, $navigator.selectedDatabase.value);
          else if (action === "star-connection")
              await $connections.updateConnectionPreference(connection, { starred: !connection.starred });
          else if (action.startsWith("connection-color:"))
              await $connections.updateConnectionPreference(connection, { color: action.slice("connection-color:".length) });
          else if (action === "new-connection-group")
              await $connections.createConnectionGroup();
          else if (action.startsWith("connection-group:"))
              await $connections.moveConnectionToGroup(connection, action.slice("connection-group:".length));
          else if (action === "exclude-connection-from-group")
              await $connections.moveConnectionToGroup(connection, null);
          else if (action === "share-connection")
              await $connections.openConnectionShare(connection);
          else if (action === "refresh-connections")
              await $connections.refreshConnections();
          return;
      }
      if (action === "new-group") {
          await $navigator.createObjectGroup(target);
          return;
      }
      if (action === "add-to-group") {
          await $navigator.addNavigatorObjectToGroup(target);
          return;
      }
      if (action === "exclude-from-group") {
          await $navigator.excludeNavigatorObjectFromGroup(target);
          return;
      }
      const object = $navigator.navigatorObject(target);
      const savedQuery = $artifacts.selectedSavedQuery(target);
      const backup = $artifacts.selectedBackup(target);
      const category = target.category && !["queries", "backups"].includes(target.category)
          ? $navigator.categoryDefinition(target.category as BrowserCategory)
          : null;
      if (action === "close-database")
          $navigator.closeDatabase(target.database);
      else if (action === "edit-database")
          $navigator.editDatabaseTemplate(target.database);
      else if (action === "new-database")
          $navigator.createDatabaseTemplate(target.database);
      else if (action === "delete-database")
          await $navigator.deleteDatabase(target.database);
      else if (action === "new-query")
          $queryTabs.newTab("", target.database);
      else if (action === "command-line")
          $queryTabs.newCommandLine(target.database);
      else if (action === "design-query" && savedQuery)
          await $artifacts.openSavedQuery(savedQuery);
      else if (action === "delete-query" && savedQuery)
          await $artifacts.deleteSavedQuery(savedQuery);
      else if (action === "duplicate-query" && savedQuery)
          await $artifacts.duplicateSavedQuery(savedQuery);
      else if (action === "export-query" && savedQuery)
          $artifacts.exportSavedQuery(savedQuery);
      else if (action === "rename-query" && savedQuery)
          await $artifacts.renameSavedQuery(savedQuery);
      else if (action === "external-editor" && savedQuery)
          await $artifacts.openSavedQueryExternally(savedQuery);
      else if (action === "show-query-finder" && savedQuery)
          await $artifacts.revealSavedQuery(savedQuery);
      else if (action === "open-external-query")
          await $artifacts.openExternalQuery();
      else if (action === "restore-selected-backup" && backup)
          await $artifacts.restoreSelectedBackup(backup);
      else if (action === "delete-backup" && backup)
          await $artifacts.deleteBackupObject(backup);
      else if (action === "duplicate-backup" && backup)
          await $artifacts.duplicateBackupObject(backup);
      else if (action === "extract-sql-from")
          $artifacts.extractSqlFromFile();
      else if (action === "extract-selected-sql" && backup)
          await $artifacts.extractBackupSql(backup);
      else if (action === "rename-backup" && backup)
          await $artifacts.renameBackupObject(backup);
      else if (action === "show-backup-finder" && backup)
          await $artifacts.revealBackupObject(backup);
      else if (action === "run-sql-file" || action === "restore-backup-from")
          $queryTabs.openTaskPanel(target.database, "restore");
      else if (action === "dump-database-full" || action === "new-backup")
          await $artifacts.startDatabaseBackup(target.database);
      else if (action === "dump-database-structure")
          await $artifacts.startDatabaseBackup(target.database, false);
      else if (action === "reverse-database")
          await $navigator.reverseNavigatorTarget(target);
      else if (action === "database-dictionary")
          $navigator.openDatabaseDictionary(target.database);
      else if (action === "search-database")
          await $navigator.openDatabaseSearch(target.database);
      else if (action === "share-database" || action === "share-object")
          await $connections.openConnectionShare();
      else if (action === "refresh-database") {
          await $navigator.loadDatabaseObjects(target.database, true);
          ElMessage.success(tr("数据库 {0} 已刷新", [target.database]));
      }
      else if (action === "new-object" && category)
          $navigator.createObjectTemplate(target.database, category.key);
      else if (action.startsWith("open-through-profile:") && object && $connections.selectedRootConnection.value) {
          const profileId = action.slice("open-through-profile:".length);
          await $connections.switchConnectionProfile($connections.selectedRootConnection.value, profileId === "main" ? null : profileId);
          if ($connections.databaseConnected.value)
              await $navigator.openObject(target.database, object.category, object.item);
      }
      else if ((action === "open-object" || action === "open-object-quick") && object)
          await $navigator.openObject(target.database, object.category, object.item);
      else if (action === "design-object" && object) {
          if (object.category.key === "tables")
              $queryTabs.newTableDesigner(target.database, object.item.name);
          else
              await $navigator.showDdl(target.database, object.category, object.item);
      }
      else if (action === "delete-object" && object)
          await $navigator.deleteObject(target.database, object.category, object.item);
      else if (action === "duplicate-object")
          await $navigator.duplicateObjectDraft(target);
      else if (action === "duplicate-table-structure")
          $navigator.duplicateTableDraft(target, false);
      else if (action === "duplicate-table-data")
          $navigator.duplicateTableDraft(target, true);
      else if (action === "empty-table" && object)
          $navigator.tableMutationDraft(target, "empty", object.item);
      else if (action === "truncate-table" && object)
          $navigator.tableMutationDraft(target, "truncate", object.item);
      else if ([
          "analyze-table",
          "check-table-normal",
          "check-table-quick",
          "check-table-fast",
          "check-table-changed",
          "check-table-extended",
          "optimize-table",
          "repair-table-quick",
          "repair-table-extended",
      ].includes(action)) {
          const table = await $navigator.chooseNavigatorObject(target, "tables");
          const operations: Record<string, TableMaintenanceOperation> = {
              "analyze-table": "analyze",
              "check-table-normal": "check",
              "check-table-quick": "checkQuick",
              "check-table-fast": "checkFast",
              "check-table-changed": "checkChanged",
              "check-table-extended": "checkExtended",
              "optimize-table": "optimize",
              "repair-table-quick": "repairQuick",
              "repair-table-extended": "repairExtended",
          };
          if (table)
              $navigator.tableMutationDraft(target, operations[action], table);
      }
      else if (action === "import-table")
          await $navigator.openTableWizard(target, "import");
      else if (action === "export-table")
          await $navigator.openTableWizard(target, "export", "csv");
      else if (action === "dump-table-data")
          await $navigator.openTableWizard(target, "export", "sql");
      else if (action === "dump-table-structure")
          await $navigator.dumpTableStructure(target);
      else if (action === "reverse-table" || action === "reverse-view")
          await $navigator.reverseNavigatorTarget(target);
      else if (action === "create-bi-workspace")
          await $navigator.createBiWorkspaceFromTarget(target);
      else if (["table-permissions", "view-permissions", "routine-permissions"].includes(action))
          $navigator.openObjectPrivileges(target);
      else if (action === "generate-data") {
          const item = object?.item ?? await $navigator.chooseNavigatorObject(target, "tables");
          if (item)
              $queryTabs.dataGenerator.value = { visible: true, database: target.database, table: item.name };
      }
      else if (action === "table-dictionary") {
          const item = object?.item ?? await $navigator.chooseNavigatorObject(target, target.category === "views" ? "views" : "tables");
          if (item)
              $navigator.openTableDictionary(target.database, item.name);
      }
      else if (action === "get-row-count") {
          const item = object?.item ?? await $navigator.chooseNavigatorObject(target, "tables");
          if (item)
              $queryTabs.newTab(`SELECT COUNT(*) AS row_count FROM ${sqlIdentifier(target.database)}.${sqlIdentifier(item.name)};`, target.database, tr("行数 · {0}", [item.name]));
      }
      else if (action === "copy-object" && object)
          await $navigator.copyNavigatorObject(target);
      else if (action === "paste-object")
          await $navigator.pasteNavigatorObject(target);
      else if (action === "rename-object")
          await $navigator.renameObjectDraft(target);
      else if (action === "run-object" && object) {
          const call = object.item.sourceCategory === "procedures"
              ? `CALL ${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}();`
              : `SELECT ${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}();`;
          $queryTabs.newTab(call, target.database, tr("运行{0} · {1}", [$navigator.objectCategoryLabel(object.item, object.category), object.item.name]));
      }
      else if (action === "show-diagram" && category) {
          await $navigator.openCategory(target.database, category);
          $navigator.objectViewMode.value = "diagram";
      }
      else if (action === "refresh-category" && category) {
          await $navigator.loadDatabaseObjects(target.database, true);
      }
      else if (action === "refresh-queries") {
          await $artifacts.loadSavedQueries();
          $queryTabs.newUtilityTab(target.database, "queries");
      }
      else if (action === "refresh-backups") {
          await $artifacts.loadDatabaseTasks();
          $queryTabs.newUtilityTab(target.database, "backups");
      }
  }

  return {
    handleNavigatorMenuAction,
  };
}

export type { DatabaseNavigatorMenuActionsApi } from "./context";
