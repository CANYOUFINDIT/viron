import type { DatabaseWorkbenchApi } from "./api-contract";
import type { DatabaseLayoutApi } from "./use-database-layout";

type WorkbenchApi = DatabaseWorkbenchApi;
type WorkbenchPart<Keys extends keyof WorkbenchApi> = Pick<WorkbenchApi, Keys>;

export type DatabaseConnectionsApi = WorkbenchPart<
  | "loading" | "connecting" | "databaseSessionId" | "connections" | "connectionGroups"
  | "selectedConnectionId" | "focusedConnectionId" | "navigationFilter" | "showStarredOnly"
  | "connectionEditorOpen" | "editingConnection" | "copyConnectionMode" | "connectionProfileParentId"
  | "connectionSearch" | "connectionSearchContainer" | "shareDialogOpen" | "shareDialogLoading"
  | "shareConnection" | "shareDetail" | "shareGrantee" | "collapsedConnectionGroups"
  | "collapsedConnectionIds" | "selectedConnection" | "rootConnections" | "selectedRootConnection"
  | "editingRootConnection" | "editingConnectionProfiles" | "activeRootConnectionId"
  | "activeConnectionProfiles" | "databaseConnected" | "favoriteConnectionIds" | "filteredConnections"
  | "groupedConnections" | "shareGrants" | "shareCandidates" | "toggleConnectionGroup"
  | "setConnectionCollapsed" | "connectionChildrenVisible" | "handleConnectionNodeClick"
  | "resetDatabaseWorkspace" | "load" | "showConnectionError" | "selectConnection" | "closeConnection"
  | "editConnection" | "copyConnection" | "createConnection" | "createConnectionProfile"
  | "switchConnectionProfile" | "refreshConnectionProfileEditor" | "handleConnectionProfileAction"
  | "focusConnection" | "selectConnectionById" | "refreshConnections" | "updateConnectionPreference"
  | "connectionUpdateBody" | "moveConnectionToGroup" | "createConnectionGroup" | "openConnectionShare"
  | "grantSharedConnection" | "revokeSharedConnection" | "openConnectionContextMenu" | "deleteConnection"
  | "collapseAllNavigation" | "testConnection" | "pollDatabaseSession" | "focusInitialConnection"
  | "disposeDatabaseWorkbench"
>;

export type DatabaseNavigatorApi = WorkbenchPart<
  | "informationDdl" | "informationLoading" | "schemas" | "sqlCompletionCatalogs"
  | "sqlCompletionLoading" | "expandedDatabases" | "expandedCategories" | "selectedDatabase"
  | "objects" | "objectLoading" | "navigatorTarget" | "objectSearch" | "objectViewMode"
  | "selectedObjects" | "objectFavorites" | "objectGroups" | "navigatorObjectClipboard"
  | "navigatorMenu" | "databaseSearchOpen" | "databaseSearchDatabase" | "databaseSearchQuery"
  | "databaseSearchSelection" | "objectSearchContainer" | "databaseSearchContainer" | "objectPrivilege"
  | "objectCategories" | "categories" | "navigatorMenuItems" | "visibleObjectFavorites"
  | "sqlCompletionContext" | "activeObjectItems" | "databaseSearchResults" | "informationTitle"
  | "informationSubtitle" | "informationRows" | "categoryKey" | "categoryDefinition"
  | "isObjectCategory" | "categoryItems" | "categoryCount" | "categorySelected" | "navigatorTargetKey"
  | "objectCategoryLabel" | "objectSelectionKey" | "selectedObject" | "selectedObjectInCategory"
  | "selectObject" | "visibleCategoryItems" | "refreshSchemas" | "loadDatabaseObjects"
  | "loadSqlCompletionCatalog" | "selectDatabaseNode" | "toggleDatabase" | "objectFavorite"
  | "loadObjectFavorites" | "loadObjectGroups" | "objectGroup" | "createObjectGroup"
  | "addNavigatorObjectToGroup" | "excludeNavigatorObjectFromGroup" | "toggleObjectFavorite"
  | "removeObjectFavorite" | "openObjectFavorite" | "openCategory" | "toggleCategory"
  | "openNavigatorObject" | "selectNavigatorObject" | "showNavigatorDdl" | "refreshObjectCategory"
  | "selectedCategoryContext" | "selectedTableContext" | "currentTableContext" | "openSelectedObject"
  | "designSelectedObject" | "designSelectedTable" | "designCurrentTable" | "createObjectTemplate"
  | "deleteObject" | "deleteSelectedObject" | "clearDatabaseLocalState" | "openGlobalCategory"
  | "handleGlobalTableCommand" | "loadInformationDdl" | "openDatabaseDictionary" | "openTableDictionary"
  | "closeDatabase" | "editDatabaseTemplate" | "createDatabaseTemplate" | "deleteDatabase"
  | "dumpTableStructure" | "reverseNavigatorTarget" | "createBiWorkspaceFromTarget"
  | "openObjectPrivileges" | "openDatabaseSearch" | "openDatabaseSearchResult" | "navigatorObject"
  | "chooseNavigatorObject" | "openTableWizard" | "duplicateObjectDraft" | "fetchObjectDdl"
  | "rewriteCreateObjectName" | "copyNavigatorObject" | "pasteNavigatorObject" | "duplicateTableDraft"
  | "tableMutationDraft" | "renameObjectDraft" | "openNavigatorContextMenu" | "showDdl" | "openObject"
>;

export type DatabaseQueryTabsApi = WorkbenchPart<
  | "tabs" | "activeTabId" | "taskPanel" | "taskPanelRequest" | "queryBuilderOpen"
  | "codeSnippetOpen" | "dataGenerator" | "continueOnQueryError" | "sqlEditor" | "pollTimers"
  | "databaseSessionPollTimer" | "removeShortcutListener" | "activeTab" | "queryRunning" | "dataTabs"
  | "newTab" | "queryTabDirty" | "newDataTab" | "newCommandLine" | "newTableDesigner"
  | "newObjectTab" | "newUtilityTab" | "newArtifactTab" | "closeTab" | "setTableDesignerDirty"
  | "handleTableDesignerSaved" | "waitForQueryJob" | "removeTabsForDatabase" | "triggerSelectedTableAction"
  | "clearTableAction" | "refreshUtilityTab" | "createFromUtilityTab" | "closeTaskPanelRequest"
  | "openTaskPanel" | "requireSelectedDatabase" | "handleGlobalQueryCommand" | "runQuery" | "pollJob"
  | "cancelQuery" | "formatSql" | "explainSql" | "handleQueryRunCommand" | "handleBuiltQuery"
  | "insertCodeSnippet" | "handleGeneratedData" | "executeDatabaseStatement" | "handleWorkbenchShortcut"
  | "handleWorkbenchKeydown" | "queryResult" | "resultSummary" | "startDatabaseWorkbenchListeners"
>;

export type DatabaseArtifactsApi = WorkbenchPart<
  | "syncDialogOpen" | "syncDialogMode" | "sidePanel" | "historyItems" | "favorites" | "savedQueries"
  | "selectedUtilityItems" | "databaseTasks" | "automationWorkspace" | "modelWorkspace" | "biWorkspace"
  | "activeUtilityItems" | "queryFavoritesForDatabase" | "savedQueriesForDatabase" | "databaseTaskDatabase"
  | "backupTasksForDatabase" | "selectedSavedQuery" | "selectedBackup" | "selectUtilityItem"
  | "utilitySelectionKey" | "handleGlobalBackupCommand" | "openSyncDialog" | "handleDatabaseToolCommand"
  | "startDatabaseBackup" | "runServerReload" | "syncSavedQueryTab" | "saveQueryTab" | "openSavedQuery"
  | "deleteSavedQuery" | "duplicateSavedQuery" | "renameSavedQuery" | "exportSavedQuery"
  | "selectBrowserSqlFile" | "openExternalQuery" | "openSavedQueryExternally" | "revealSavedQuery"
  | "restoreSelectedBackup" | "deleteBackupObject" | "duplicateBackupObject" | "renameBackupObject"
  | "extractBackupSql" | "revealBackupObject" | "extractSqlFromFile" | "addFavorite" | "loadHistory"
  | "loadFavorites" | "loadSavedQueries" | "loadDatabaseTasks" | "updateDatabaseTasks" | "openSaved"
  | "deleteFavorite"
>;

export type DatabaseAgentSceneApi = WorkbenchPart<
  | "removeAgentDatabaseSceneProvider" | "removeAgentWorkbenchExecutionProvider"
  | "pendingAgentDatabaseExecutions" | "registerDatabaseAgentScene" | "databaseAgentResult"
  | "executeAgentDatabaseWorkbench" | "registerDatabaseAgentWorkbenchExecution"
  | "unregisterDatabaseAgentProviders" | "disposeAgentScene"
>;

export type DatabaseNavigatorMenuActionsApi = WorkbenchPart<"handleNavigatorMenuAction">;

export interface DatabaseWorkbenchContext {
  layout: DatabaseLayoutApi | null;
  connections: DatabaseConnectionsApi | null;
  navigator: DatabaseNavigatorApi | null;
  queryTabs: DatabaseQueryTabsApi | null;
  artifacts: DatabaseArtifactsApi | null;
  agentScene: DatabaseAgentSceneApi | null;
  menuActions: DatabaseNavigatorMenuActionsApi | null;
}

export function createDatabaseWorkbenchContext(): DatabaseWorkbenchContext {
  return { layout: null, connections: null, navigator: null, queryTabs: null, artifacts: null, agentScene: null, menuActions: null };
}

export function requireDatabaseWorkbenchPart<Key extends keyof DatabaseWorkbenchContext>(
  ctx: DatabaseWorkbenchContext,
  key: Key,
): NonNullable<DatabaseWorkbenchContext[Key]> {
  const part = ctx[key];
  if (part === null) throw new Error(`Database workbench part is not bound: ${key}`);
  return part as NonNullable<DatabaseWorkbenchContext[Key]>;
}

export function deferDatabaseWorkbenchPart<Key extends keyof DatabaseWorkbenchContext>(
  ctx: DatabaseWorkbenchContext,
  key: Key,
): NonNullable<DatabaseWorkbenchContext[Key]> {
  const bridges = new Map<PropertyKey, object>();
  const proxy = new Proxy({}, {
    get(_target, property) {
      const cached = bridges.get(property);
      if (cached) return cached;
      const callable = (..._args: unknown[]): unknown => undefined;
      const bridge = new Proxy(callable, {
        apply(_fn, _thisArg, args) {
          const part = requireDatabaseWorkbenchPart(ctx, key) as object;
          const member = Reflect.get(part, property);
          if (typeof member !== "function") throw new TypeError(`Database workbench member is not callable: ${String(property)}`);
          return Reflect.apply(member, part, args);
        },
        get(_fn, nestedProperty) {
          const part = requireDatabaseWorkbenchPart(ctx, key) as object;
          const member = Reflect.get(part, property);
          const nested = Reflect.get(Object(member), nestedProperty, member);
          return typeof nested === "function" ? nested.bind(member) : nested;
        },
        set(_fn, nestedProperty, value) {
          const part = requireDatabaseWorkbenchPart(ctx, key) as object;
          const member = Reflect.get(part, property);
          return Reflect.set(Object(member), nestedProperty, value, member);
        },
      });
      bridges.set(property, bridge);
      return bridge;
    },
  });
  return proxy as NonNullable<DatabaseWorkbenchContext[Key]>;
}
