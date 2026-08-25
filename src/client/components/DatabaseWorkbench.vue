<script setup lang="ts">
import {
  Braces,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleCheck,
  CircleStop,
  Clock3,
  Columns3,
  Database,
  Eye,
  ExternalLink,
  FileCode2,
  FilePenLine,
  FolderTree,
  FolderOpen,
  GitCompareArrows,
  History,
  HardDriveDownload,
  Info,
  LayoutGrid,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Save,
  Star,
  Table2,
  TerminalSquare,
  Trash2,
  Unplug,
  Upload,
  Download,
  WandSparkles,
  Wrench,
  X,
} from "@lucide/vue";
import { onActivated, onBeforeUnmount, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import ConnectionEditDialog from "./ConnectionEditDialog.vue";
import DatabaseAutomationWorkspace from "./DatabaseAutomationWorkspace.vue";
import DatabaseBiWorkspace from "./DatabaseBiWorkspace.vue";
import DatabaseCodeSnippetPanel from "./DatabaseCodeSnippetPanel.vue";
import DatabaseCommandLine from "./DatabaseCommandLine.vue";
import DatabaseDataGeneratorDialog from "./DatabaseDataGeneratorDialog.vue";
import DatabaseModelWorkspace from "./DatabaseModelWorkspace.vue";
import DatabaseNavigatorContextMenu from "./DatabaseNavigatorContextMenu.vue";
import DatabaseObjectPrivilegeDialog from "./DatabaseObjectPrivilegeDialog.vue";
import DatabaseQueryBuilderDialog from "./DatabaseQueryBuilderDialog.vue";
import DatabaseSyncDialog from "./DatabaseSyncDialog.vue";
import DatabaseUserWorkspace from "./DatabaseUserWorkspace.vue";
import QueryResultGrid from "./QueryResultGrid.vue";
import SqlEditor from "./SqlEditor.vue";
import TableDataEditor from "./TableDataEditor.vue";
import TableDesigner from "./TableDesigner.vue";
import DatabaseTaskPanel from "./DatabaseTaskPanel.vue";
import { createDatabaseWorkbenchContext } from "./database-workbench/context";
import { useDatabaseConnections } from "./database-workbench/use-database-connections";
import { useDatabaseNavigator } from "./database-workbench/use-database-navigator";
import { useDatabaseQueryTabs } from "./database-workbench/use-database-query-tabs";
import { useDatabaseArtifacts } from "./database-workbench/use-database-artifacts";
import { useDatabaseAgentScene } from "./database-workbench/use-database-agent-scene";
import { useNavigatorMenuActions } from "./database-workbench/navigator-menu-actions";
import { useDatabaseLayout } from "./database-workbench/use-database-layout";
import { formatBytes, sqlIdentifier, textSize } from "./database-workbench/format";
import { shortcutLabel } from "../keyboard-shortcuts";
import type { FavoriteItem } from "./database-workbench/types";

const props = withDefaults(defineProps<{
  environmentId?: string;
  initialConnectionId?: string;
  workspaceKey?: string;
  active?: boolean;
}>(), { workspaceKey: "fixed:database", active: true });
const route = useRoute();
const databaseWorkbenchContext = createDatabaseWorkbenchContext();
const databaseLayout = useDatabaseLayout(props);
databaseWorkbenchContext.layout = databaseLayout;

function focusSearchInput(container: HTMLElement | null) {
  const input = container?.querySelector("input");
  input?.focus();
  input?.select();
}

const databaseConnections = useDatabaseConnections(databaseWorkbenchContext, props, route);
databaseWorkbenchContext.connections = databaseConnections;
const databaseNavigator = useDatabaseNavigator(databaseWorkbenchContext, props, route);
databaseWorkbenchContext.navigator = databaseNavigator;
const databaseQueryTabs = useDatabaseQueryTabs(databaseWorkbenchContext, props, route, focusSearchInput);
databaseWorkbenchContext.queryTabs = databaseQueryTabs;
const databaseArtifacts = useDatabaseArtifacts(databaseWorkbenchContext, props, route);
databaseWorkbenchContext.artifacts = databaseArtifacts;
const databaseAgentScene = useDatabaseAgentScene(databaseWorkbenchContext, props, route);
databaseWorkbenchContext.agentScene = databaseAgentScene;
const databaseMenuActions = useNavigatorMenuActions(databaseWorkbenchContext, props, route);
databaseWorkbenchContext.menuActions = databaseMenuActions;
const databaseWorkbench = {
  ...databaseLayout,
  ...databaseConnections,
  ...databaseNavigator,
  ...databaseQueryTabs,
  ...databaseArtifacts,
  ...databaseAgentScene,
  ...databaseMenuActions,
  focusSearchInput,
  formatBytes,
  textSize,
  sqlIdentifier,
  shortcutLabel,
};

const {
  loading,
  connecting,
  databaseSessionId,
  connections,
  connectionGroups,
  selectedConnectionId,
  focusedConnectionId,
  connectionPaneWidth,
  connectionPaneVisible,
  explorerPaneWidth,
  informationPaneVisible,
  informationPaneTab,
  informationDdl,
  informationLoading,
  navigationFilter,
  showStarredOnly,
  queryResultLayout,
  queryFocused,
  syncDialogOpen,
  syncDialogMode,
  connectionEditorOpen,
  editingConnection,
  copyConnectionMode,
  connectionProfileParentId,
  workbenchElement,
  schemas,
  sqlCompletionCatalogs,
  sqlCompletionLoading,
  expandedDatabases,
  expandedCategories,
  selectedDatabase,
  objects,
  objectLoading,
  navigatorTarget,
  objectSearch,
  objectViewMode,
  selectedObjects,
  connectionSearch,
  tabs,
  activeTabId,
  sidePanel,
  historyItems,
  favorites,
  savedQueries,
  selectedUtilityItems,
  objectFavorites,
  objectGroups,
  navigatorObjectClipboard,
  taskPanel,
  taskPanelRequest,
  databaseTasks,
  navigatorMenu,
  databaseSearchOpen,
  databaseSearchDatabase,
  databaseSearchQuery,
  databaseSearchSelection,
  connectionSearchContainer,
  objectSearchContainer,
  databaseSearchContainer,
  automationWorkspace,
  modelWorkspace,
  biWorkspace,
  queryBuilderOpen,
  codeSnippetOpen,
  dataGenerator,
  objectPrivilege,
  shareDialogOpen,
  shareDialogLoading,
  shareConnection,
  shareDetail,
  shareGrantee,
  collapsedConnectionGroups,
  collapsedConnectionIds,
  pollTimers,
  databaseSessionPollTimer,
  persistenceKey,
  workbenchStyle,
  objectCategories,
  categories,
  selectedConnection,
  rootConnections,
  selectedRootConnection,
  editingRootConnection,
  editingConnectionProfiles,
  activeRootConnectionId,
  activeConnectionProfiles,
  databaseConnected,
  activeTab,
  queryRunning,
  continueOnQueryError,
  sqlEditor,
  removeShortcutListener,
  removeAgentDatabaseSceneProvider,
  removeAgentWorkbenchExecutionProvider,
  pendingAgentDatabaseExecutions,
  navigatorMenuItems,
  favoriteConnectionIds,
  filteredConnections,
  groupedConnections,
  visibleObjectFavorites,
  shareGrants,
  shareCandidates,
  sqlCompletionContext,
  activeObjectItems,
  databaseSearchResults,
  categoryKey,
  categoryDefinition,
  isObjectCategory,
  categoryItems,
  queryFavoritesForDatabase,
  savedQueriesForDatabase,
  databaseTaskDatabase,
  backupTasksForDatabase,
  categoryCount,
  categorySelected,
  navigatorTargetKey,
  objectCategoryLabel,
  objectSelectionKey,
  utilitySelectionKey,
  selectedSavedQuery,
  selectedBackup,
  selectUtilityItem,
  selectedObject,
  selectedObjectInCategory,
  selectObject,
  newTab,
  registerDatabaseAgentScene,
  databaseAgentResult,
  executeAgentDatabaseWorkbench,
  registerDatabaseAgentWorkbenchExecution,
  queryTabDirty,
  toggleConnectionGroup,
  setConnectionCollapsed,
  connectionChildrenVisible,
  handleConnectionNodeClick,
  activeUtilityItems,
  dataTabs,
  informationTitle,
  informationSubtitle,
  informationRows,
  persistWorkbenchPreferences,
  restoreWorkbenchPreferences,
  setConnectionPaneWidth,
  startConnectionPaneResize,
  resizeConnectionPane,
  setExplorerPaneWidth,
  startExplorerPaneResize,
  resizeExplorerPane,
  setConnectionPaneVisible,
  setInformationPaneVisible,
  setQueryResultLayout,
  visibleCategoryItems,
  newDataTab,
  newCommandLine,
  newTableDesigner,
  newObjectTab,
  newUtilityTab,
  newArtifactTab,
  closeTab,
  resetDatabaseWorkspace,
  load,
  showConnectionError,
  selectConnection,
  closeConnection,
  editConnection,
  copyConnection,
  createConnection,
  createConnectionProfile,
  switchConnectionProfile,
  refreshConnectionProfileEditor,
  handleConnectionProfileAction,
  focusConnection,
  selectConnectionById,
  refreshConnections,
  updateConnectionPreference,
  connectionUpdateBody,
  moveConnectionToGroup,
  createConnectionGroup,
  openConnectionShare,
  grantSharedConnection,
  revokeSharedConnection,
  openConnectionContextMenu,
  deleteConnection,
  collapseAllNavigation,
  refreshSchemas,
  testConnection,
  loadDatabaseObjects,
  loadSqlCompletionCatalog,
  selectDatabaseNode,
  toggleDatabase,
  objectFavorite,
  loadObjectFavorites,
  loadObjectGroups,
  objectGroup,
  createObjectGroup,
  addNavigatorObjectToGroup,
  excludeNavigatorObjectFromGroup,
  toggleObjectFavorite,
  removeObjectFavorite,
  openObjectFavorite,
  openCategory,
  toggleCategory,
  openNavigatorObject,
  selectNavigatorObject,
  showNavigatorDdl,
  refreshObjectCategory,
  selectedCategoryContext,
  selectedTableContext,
  currentTableContext,
  openSelectedObject,
  designSelectedObject,
  designSelectedTable,
  designCurrentTable,
  createObjectTemplate,
  setTableDesignerDirty,
  handleTableDesignerSaved,
  waitForQueryJob,
  deleteObject,
  deleteSelectedObject,
  removeTabsForDatabase,
  clearDatabaseLocalState,
  triggerSelectedTableAction,
  clearTableAction,
  refreshUtilityTab,
  createFromUtilityTab,
  closeTaskPanelRequest,
  openTaskPanel,
  requireSelectedDatabase,
  openGlobalCategory,
  handleGlobalTableCommand,
  handleGlobalConnectionCommand,
  handleGlobalQueryCommand,
  handleGlobalBackupCommand,
  openSyncDialog,
  handleDatabaseToolCommand,
  loadInformationDdl,
  openDatabaseDictionary,
  openTableDictionary,
  closeDatabase,
  editDatabaseTemplate,
  createDatabaseTemplate,
  deleteDatabase,
  startDatabaseBackup,
  runServerReload,
  dumpTableStructure,
  reverseNavigatorTarget,
  createBiWorkspaceFromTarget,
  openObjectPrivileges,
  openDatabaseSearch,
  openDatabaseSearchResult,
  navigatorObject,
  chooseNavigatorObject,
  openTableWizard,
  duplicateObjectDraft,
  fetchObjectDdl,
  executeDatabaseStatement,
  rewriteCreateObjectName,
  copyNavigatorObject,
  pasteNavigatorObject,
  duplicateTableDraft,
  tableMutationDraft,
  renameObjectDraft,
  openNavigatorContextMenu,
  handleNavigatorMenuAction,
  showDdl,
  openObject,
  runQuery,
  pollJob,
  cancelQuery,
  formatSql,
  explainSql,
  handleQueryRunCommand,
  handleBuiltQuery,
  insertCodeSnippet,
  handleGeneratedData,
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
  resultSummary,
  queryResult,
  handleWorkbenchShortcut,
  handleWorkbenchKeydown,
  pollDatabaseSession,
  focusInitialConnection,
  unregisterDatabaseAgentProviders,
  startDatabaseWorkbenchListeners,
  disposeAgentScene,
  disposeDatabaseWorkbench,
} = databaseWorkbench;

onMounted(() => {
  restoreWorkbenchPreferences();
  void load();
  startDatabaseWorkbenchListeners();
  if (props.active) {
    registerDatabaseAgentScene();
    registerDatabaseAgentWorkbenchExecution();
  }
});

watch(() => [selectedConnectionId.value, activeTab.value?.kind === "sql" ? activeTab.value.database : ""] as const, ([, database]) => {
  if (database) void loadSqlCompletionCatalog(database);
});
watch(() => props.initialConnectionId, () => { void focusInitialConnection(); });
watch(() => props.active, (active) => {
  if (active) {
    registerDatabaseAgentScene();
    registerDatabaseAgentWorkbenchExecution();
  } else {
    unregisterDatabaseAgentProviders();
  }
});
onActivated(() => {
  if (props.active) {
    registerDatabaseAgentScene();
    registerDatabaseAgentWorkbenchExecution();
    void focusInitialConnection();
  }
});
onBeforeUnmount(() => {
  disposeAgentScene();
  disposeDatabaseWorkbench();
});
</script>

<template>
  <section
    ref="workbenchElement"
    class="database-workbench"
    :class="{
      'is-navigation-hidden': !connectionPaneVisible,
      'has-information-pane': informationPaneVisible,
      'is-query-focused': queryFocused,
    }"
    :style="workbenchStyle"
    v-loading="loading"
  >
    <header class="database-global-toolbar">
      <div class="database-global-tools">
        <el-dropdown trigger="click" @command="handleGlobalConnectionCommand">
          <button class="database-global-tool" type="button" data-navicat-action="connection" :title="$t('连接')"><Server :size="22" /><span>{{ $t('连接') }}</span><ChevronDown :size="11" /></button>
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="new">{{ $t('新建连接…') }}</el-dropdown-item><el-dropdown-item command="edit" :disabled="!selectedConnection && !focusedConnectionId">{{ $t('编辑连接…') }}</el-dropdown-item><el-dropdown-item command="duplicate" :disabled="!selectedConnection && !focusedConnectionId">{{ $t('复制连接') }}</el-dropdown-item><el-dropdown-item command="close" :disabled="!databaseConnected" divided>{{ $t('关闭连接') }}</el-dropdown-item><el-dropdown-item command="refresh">{{ $t('刷新') }}</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
        <button class="database-global-tool" type="button" data-navicat-action="new-query" :disabled="!databaseConnected" @click="newTab('', selectedDatabase)"><FileCode2 :size="22" /><span>{{ $t('新建查询') }}</span></button>
        <el-dropdown trigger="click" @command="handleGlobalTableCommand">
          <button class="database-global-tool" type="button" data-navicat-action="table" :disabled="!databaseConnected"><Table2 :size="22" /><span>{{ $t('表') }}</span><ChevronDown :size="11" /></button>
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="open">{{ $t('打开表列表') }}</el-dropdown-item><el-dropdown-item command="new">{{ $t('新建表') }}</el-dropdown-item><el-dropdown-item command="design" :disabled="activeTab?.kind !== 'objects' || activeTab.category !== 'tables'">{{ $t('设计表') }}</el-dropdown-item><el-dropdown-item command="import" divided>{{ $t('导入向导…') }}</el-dropdown-item><el-dropdown-item command="csv">{{ $t('导出 CSV') }}</el-dropdown-item><el-dropdown-item command="xlsx">{{ $t('导出 XLSX') }}</el-dropdown-item><el-dropdown-item command="sql">{{ $t('导出 SQL') }}</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
        <button class="database-global-tool" type="button" data-navicat-action="view" :disabled="!databaseConnected" @click="openGlobalCategory('views')"><Eye :size="22" /><span>{{ $t('视图') }}</span></button>
        <button class="database-global-tool" type="button" data-navicat-action="function" :disabled="!databaseConnected" @click="openGlobalCategory('functions')"><Braces :size="22" /><span>{{ $t('函数') }}</span></button>
        <button class="database-global-tool" type="button" data-navicat-action="user" :disabled="!databaseConnected" @click="newArtifactTab('user')"><Server :size="22" /><span>{{ $t('用户') }}</span></button>
        <button class="database-global-tool" type="button" data-navicat-action="event" :disabled="!databaseConnected" @click="openGlobalCategory('events')"><Clock3 :size="22" /><span>{{ $t('事件') }}</span></button>
        <el-dropdown trigger="click" @command="handleGlobalQueryCommand">
          <button class="database-global-tool" type="button" data-navicat-action="query" :disabled="!databaseConnected"><FileCode2 :size="22" /><span>{{ $t('查询') }}</span><ChevronDown :size="11" /></button>
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="new">{{ $t('新建查询') }}</el-dropdown-item><el-dropdown-item command="queries">{{ $t('打开查询列表') }}</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
        <el-dropdown trigger="click" @command="handleGlobalBackupCommand">
          <button class="database-global-tool" type="button" data-navicat-action="backup" :disabled="!databaseConnected"><HardDriveDownload :size="22" /><span>{{ $t('备份') }}</span><ChevronDown :size="11" /></button>
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="new">{{ $t('新建备份') }}</el-dropdown-item><el-dropdown-item command="list">{{ $t('打开备份列表') }}</el-dropdown-item><el-dropdown-item command="restore" divided>{{ $t('还原备份从…') }}</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
      </div>
      <div class="database-global-trailing-tools">
        <div class="database-view-tools">
          <button type="button" data-navicat-action="navigation-pane" :class="{ 'is-active': connectionPaneVisible }" :title="$t('隐藏或显示导航窗格')" :aria-label="$t('隐藏或显示导航窗格')" @click="setConnectionPaneVisible(!connectionPaneVisible)"><PanelLeftClose v-if="connectionPaneVisible" :size="18" /><PanelLeftOpen v-else :size="18" /></button>
          <button type="button" data-navicat-action="information-pane" :class="{ 'is-active': informationPaneVisible }" :title="$t('隐藏或显示信息窗格')" :aria-label="$t('隐藏或显示信息窗格')" @click="setInformationPaneVisible(!informationPaneVisible)"><PanelRightClose v-if="informationPaneVisible" :size="18" /><PanelRight v-else :size="18" /></button>
          <span>{{ $t('查看') }}</span>
        </div>
        <div class="database-global-extension-tools">
          <el-dropdown trigger="click" @command="handleDatabaseToolCommand">
            <button class="database-global-tool database-global-tool--tools" type="button" data-viron-action="extensions" :disabled="!databaseConnected"><Wrench :size="22" /><span>{{ $t('工具') }}</span><ChevronDown :size="11" /></button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="add-favorite" :disabled="activeTab?.kind !== 'sql' || !activeTab.sql.trim()">{{ $t('收藏当前 SQL…') }}</el-dropdown-item><el-dropdown-item command="favorites">{{ $t('SQL 收藏夹') }}</el-dropdown-item><el-dropdown-item command="history">{{ $t('执行历史') }}</el-dropdown-item><el-dropdown-item command="tasks" divided>{{ $t('数据库任务') }}</el-dropdown-item><el-dropdown-item command="restore">{{ $t('从 SQL 文件恢复…') }}</el-dropdown-item><el-dropdown-item command="transfer">{{ $t('数据传输…') }}</el-dropdown-item><el-dropdown-item command="data-sync" divided>{{ $t('数据同步…') }}</el-dropdown-item><el-dropdown-item command="structure-sync">{{ $t('结构同步…') }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </div>
    </header>

    <aside v-if="connectionPaneVisible" class="database-navigator">
      <div class="database-navigation-tree">
        <section v-if="visibleObjectFavorites.length" class="database-navigation-favorites">
          <header><Star :size="12" fill="currentColor" /><span>{{ $t('收藏') }}</span><small>{{ visibleObjectFavorites.length }}</small></header>
          <button
            v-for="item in visibleObjectFavorites"
            :key="item.id"
            type="button"
            :title="`${item.connectionName} · ${item.database}${item.table ? `.${item.table}` : ''}`"
            @dblclick="openObjectFavorite(item)"
            @keydown.enter="openObjectFavorite(item)"
          >
            <span class="database-navigation-favorite-icon" :class="`is-${item.targetType}`">
              <Table2 v-if="item.targetType === 'table'" :size="14" />
              <Database v-else :size="14" />
            </span>
            <span class="database-navigation-favorite-copy">
              <strong>{{ item.table || item.database }}</strong>
              <small>{{ item.connectionName }}<template v-if="item.targetType === 'table'"> · {{ item.database }}</template></small>
            </span>
            <ChevronRight class="database-navigation-favorite-arrow" :size="13" />
          </button>
        </section>

        <section v-for="group in groupedConnections" :key="group.path" class="database-navigation-group">
          <button class="database-navigation-group-toggle" type="button" :aria-expanded="!collapsedConnectionGroups.has(group.path)" :title="group.path" @click="toggleConnectionGroup(group.path)"><ChevronDown v-if="!collapsedConnectionGroups.has(group.path)" :size="12" /><ChevronRight v-else :size="12" /><FolderTree :size="13" /><span>{{ group.path }}</span></button>
          <template v-for="connection in collapsedConnectionGroups.has(group.path) ? [] : group.items" :key="connection.id">
            <div class="database-navigation-connection-row" :class="{ 'is-selected': focusedConnectionId === connection.id, 'is-active': activeRootConnectionId === connection.id && databaseConnected }" @contextmenu="openConnectionContextMenu($event, connection)">
              <span class="database-navigation-placeholder"></span>
              <button class="database-navigation-connection" type="button" :aria-expanded="activeRootConnectionId === connection.id && databaseConnected ? connectionChildrenVisible(connection) : undefined" :title="`${connection.name}${activeRootConnectionId === connection.id && selectedConnection?.profileName ? ` · ${selectedConnection.profileName}` : ''} · ${connection.engine.toUpperCase()} · ${connection.host}:${connection.port}`" @click="handleConnectionNodeClick(connection)" @dblclick="selectConnection(connection)" @keydown.enter="selectConnection(connection)"><Database :size="14" :style="connection.color ? { color: connection.color } : undefined" /><span class="database-navigation-connection-label">{{ connection.name }}<template v-if="activeRootConnectionId === connection.id && selectedConnection?.profileName"> · {{ selectedConnection.profileName }}</template></span><Star v-if="connection.starred" class="database-navigation-connection-star" :size="10" fill="currentColor" /><i :class="{ 'is-online': activeRootConnectionId === connection.id && databaseConnected }"></i></button>
              <button class="database-navigation-more" type="button" :aria-label="$t('{0} 连接菜单', [connection.name])" :title="$t('连接菜单')" @click.stop="openConnectionContextMenu($event, connection)"><ChevronDown :size="12" /></button>
            </div>

            <div v-if="connectionChildrenVisible(connection)" class="database-navigation-connection-children">
              <section v-for="schema in schemas" :key="schema.name" class="schema-branch">
                <div class="schema-node-row">
                  <button class="schema-disclosure" :aria-label="$t('{0}数据库 {1}', [expandedDatabases.has(schema.name) ? $t('关闭') : $t('打开'), schema.name])" @click="toggleDatabase(schema.name)"><ChevronDown v-if="expandedDatabases.has(schema.name)" :size="12" /><ChevronRight v-else :size="12" /></button>
                  <button class="schema-node" :class="{ 'is-selected': selectedDatabase === schema.name && expandedDatabases.has(schema.name), 'is-located': navigatorTarget === `database:${schema.name}` }" :data-navigator-target="`database:${schema.name}`" @click="selectDatabaseNode(schema.name)" @dblclick="toggleDatabase(schema.name)" @contextmenu="openNavigatorContextMenu($event, { kind: 'database', database: schema.name })"><Database :size="13" /><span>{{ schema.name }}</span></button>
                  <button class="object-favorite-toggle" :class="{ 'is-active': objectFavorite('database', schema.name) }" :aria-label="objectFavorite('database', schema.name) ? $t('取消收藏数据库 {0}', [schema.name]) : $t('收藏数据库 {0}', [schema.name])" @click="toggleObjectFavorite('database', schema.name)"><Star :size="12" :fill="objectFavorite('database', schema.name) ? 'currentColor' : 'none'" /></button>
                </div>
                <div v-if="expandedDatabases.has(schema.name)" class="schema-children" v-loading="objectLoading === schema.name">
                  <section v-for="category in categories" :key="category.key" class="schema-category">
                    <div class="schema-category-heading" @contextmenu="openNavigatorContextMenu($event, { kind: 'category', database: schema.name, category: category.key })">
                      <button class="schema-category-toggle" :aria-label="`${expandedCategories.has(categoryKey(schema.name, category.key)) ? $t('收起') : $t('展开')}${category.label}`" @click="toggleCategory(schema.name, category)"><ChevronDown v-if="expandedCategories.has(categoryKey(schema.name, category.key))" :size="11" /><ChevronRight v-else :size="11" /></button>
                      <button class="schema-category-node" :class="{ 'is-selected': categorySelected(schema.name, category), 'is-located': navigatorTarget === `category:${schema.name}:${category.key}` }" @click="openCategory(schema.name, category)"><component :is="category.icon" :size="12" /><span>{{ category.label }}</span></button>
                    </div>
                    <template v-if="isObjectCategory(category)">
                      <div v-for="item in expandedCategories.has(categoryKey(schema.name, category.key)) ? visibleCategoryItems(schema.name, category) : []" :key="`${category.key}-${item.sourceCategory}-${item.name}`" class="schema-object-row" :class="{ 'has-favorite': category.key === 'tables' && objectFavorite('table', schema.name, item.name), 'is-located': navigatorTarget === `object:${schema.name}:${category.key}:${item.name}` }" :data-navigator-target="`object:${schema.name}:${category.key}:${item.name}`" @contextmenu="openNavigatorContextMenu($event, { kind: 'object', database: schema.name, category: category.key, objectName: item.name, objectSource: item.sourceCategory })">
                        <button class="schema-object-main" type="button" @click="selectNavigatorObject(schema.name, category, item)" @dblclick="openNavigatorObject(schema.name, category, item)" @keydown.enter="openNavigatorObject(schema.name, category, item)"><span>{{ item.name }}</span><small v-if="objectGroup(schema.name, category.key, item)">{{ objectGroup(schema.name, category.key, item)?.name }}</small></button>
                        <button v-if="category.key === 'tables'" class="object-favorite-toggle" :class="{ 'is-active': objectFavorite('table', schema.name, item.name) }" :aria-label="objectFavorite('table', schema.name, item.name) ? $t('取消收藏数据表 {0}', [item.name]) : $t('收藏数据表 {0}', [item.name])" @click="toggleObjectFavorite('table', schema.name, item.name)"><Star :size="11" :fill="objectFavorite('table', schema.name, item.name) ? 'currentColor' : 'none'" /></button>
                      </div>
                    </template>
                    <div v-else-if="expandedCategories.has(categoryKey(schema.name, category.key))" class="schema-utility-list">
                      <template v-if="category.key === 'queries'"><button v-for="item in savedQueriesForDatabase(schema.name)" :key="item.id" class="schema-utility-row" :class="{ 'is-selected': selectedUtilityItems[utilitySelectionKey(schema.name, 'queries')] === item.id, 'is-located': navigatorTarget === `object:${schema.name}:queries:${item.id}` }" type="button" @click="selectUtilityItem(schema.name, 'queries', item.id)" @dblclick="openSavedQuery(item)" @keydown.enter="openSavedQuery(item)" @contextmenu="openNavigatorContextMenu($event, { kind: 'object', database: schema.name, category: 'queries', objectId: item.id, objectName: item.name })"><FileCode2 :size="11" /><span>{{ item.name }}</span></button><span v-if="!savedQueriesForDatabase(schema.name).length" class="schema-utility-empty">{{ $t('没有查询') }}</span></template>
                      <template v-else><button v-for="item in backupTasksForDatabase(schema.name)" :key="item.id" class="schema-utility-row" :class="{ 'is-selected': selectedUtilityItems[utilitySelectionKey(schema.name, 'backups')] === item.id, 'is-located': navigatorTarget === `object:${schema.name}:backups:${item.id}` }" type="button" @click="selectUtilityItem(schema.name, 'backups', item.id)" @dblclick="item.status === 'success' ? restoreSelectedBackup(item) : openTaskPanel(schema.name)" @keydown.enter="item.status === 'success' ? restoreSelectedBackup(item) : openTaskPanel(schema.name)" @contextmenu="openNavigatorContextMenu($event, { kind: 'object', database: schema.name, category: 'backups', objectId: item.id, objectName: item.title, objectStatus: item.status })"><HardDriveDownload :size="11" /><span>{{ item.title }}</span><em :class="`is-${item.status}`">{{ item.progress }}%</em></button><span v-if="!backupTasksForDatabase(schema.name).length" class="schema-utility-empty">{{ $t('没有备份') }}</span></template>
                    </div>
                  </section>
                </div>
              </section>
            </div>
          </template>
        </section>
        <div v-if="!filteredConnections.length" class="explorer-empty"><Database :size="22" /><span>{{ $t('没有数据库连接') }}</span></div>
      </div>
      <footer class="database-navigation-footer">
        <div ref="connectionSearchContainer"><el-input v-model="connectionSearch" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="13" /></template></el-input></div>
        <el-dropdown trigger="click" @command="navigationFilter = $event"><button type="button" :class="{ 'is-active': navigationFilter !== 'all' }" :title="$t('连接筛选')" :aria-label="$t('连接筛选')"><Columns3 :size="14" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="all">{{ $t('全部连接') }}</el-dropdown-item><el-dropdown-item command="connected">{{ $t('已连接') }}</el-dropdown-item><el-dropdown-item command="disconnected">{{ $t('未连接') }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
        <button type="button" :class="{ 'is-active': showStarredOnly }" :title="$t('仅显示收藏')" :aria-label="$t('仅显示收藏')" @click="showStarredOnly = !showStarredOnly"><Star :size="14" :fill="showStarredOnly ? 'currentColor' : 'none'" /></button>
        <button type="button" :title="$t('全部折叠')" :aria-label="$t('全部折叠')" @click="collapseAllNavigation"><ChevronsDownUp :size="14" /></button>
      </footer>
    </aside>

    <button v-if="connectionPaneVisible" class="workbench-sidebar-resizer" type="button" role="separator" aria-orientation="vertical" :aria-label="$t('调整导航窗格宽度')" :aria-valuenow="connectionPaneWidth" @pointerdown="startConnectionPaneResize" @keydown.left.prevent="resizeConnectionPane(-20)" @keydown.right.prevent="resizeConnectionPane(20)"><span></span></button>

    <main class="sql-workspace" :class="{ 'is-sql-tab': activeTab?.kind === 'sql' }">
      <div v-if="selectedConnection && !databaseConnected && !connecting" class="database-disconnected-banner"><Unplug :size="14" /><span>{{ $t('连接已断开，当前查询页签和结果仍保留。') }}</span><button type="button" @click="selectConnection(selectedConnection)">{{ $t('重新连接') }}</button></div>
      <header v-if="activeTab?.kind === 'sql'" class="sql-toolbar navicat-query-toolbar">
        <button data-navicat-action="save" :disabled="!selectedConnection" :title="$t('保存 ({0})', [shortcutLabel('workspace.save')])" @click="saveQueryTab()"><Save :size="16" /><span>{{ $t('保存') }}</span></button>
        <button data-navicat-action="beautify" :title="$t('美化 SQL')" @click="formatSql"><WandSparkles :size="16" /><span>{{ $t('美化 SQL') }}</span></button>
        <button data-navicat-action="code-snippet" :class="{ 'is-active': codeSnippetOpen }" :title="$t('代码段')" @click="codeSnippetOpen = !codeSnippetOpen"><BookOpenText :size="16" /><span>{{ $t('代码段') }}</span></button>
        <span class="toolbar-divider"></span>
        <button data-navicat-action="result-below" :class="{ 'is-active': queryResultLayout === 'below' }" :title="$t('在编辑器下方显示结果')" @click="setQueryResultLayout('below')"><Columns3 :size="16" /></button>
        <button data-navicat-action="result-right" :class="{ 'is-active': queryResultLayout === 'right' }" :title="$t('在编辑器旁边显示结果')" @click="setQueryResultLayout('right')"><PanelRight :size="16" /></button>
        <button data-navicat-action="focus" :class="{ 'is-active': queryFocused }" :title="$t('进入专注模式')" @click="queryFocused = !queryFocused"><ExternalLink :size="16" /></button>
        <span class="toolbar-divider"></span>
        <el-dropdown trigger="click" @command="selectConnectionById"><button class="query-context-button" type="button" data-navicat-action="connection"><Server :size="13" /><span>{{ selectedRootConnection?.name || $t('连接') }}<template v-if="selectedConnection?.profileName"> · {{ selectedConnection.profileName }}</template></span><ChevronDown :size="11" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="connection in rootConnections" :key="connection.id" :command="connection.id">{{ connection.name }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
        <el-select v-model="activeTab.database" data-navicat-action="database" size="small" :placeholder="$t('数据库')"><el-option :label="$t('不指定数据库')" value="" /><el-option v-for="schema in schemas" :key="schema.name" :label="schema.name" :value="schema.name" /></el-select>
        <div class="query-run-split">
          <button class="run-query" type="button" data-navicat-action="run" :disabled="!databaseConnected || queryRunning" @click="runQuery()"><Play :size="15" />{{ $t('运行') }}</button>
          <el-dropdown trigger="click" @command="handleQueryRunCommand">
            <button class="query-run-menu" type="button" :aria-label="$t('运行菜单')" :title="$t('运行菜单')" :disabled="!databaseConnected || queryRunning"><ChevronDown :size="11" /></button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="run">{{ $t('运行') }}</el-dropdown-item><el-dropdown-item command="current">{{ $t('运行当前语句') }}</el-dropdown-item><el-dropdown-item command="selected">{{ $t('运行已选择的') }}</el-dropdown-item><el-dropdown-item command="toggle-continue" divided><Check :style="{ visibility: continueOnQueryError ? 'visible' : 'hidden' }" :size="14" />{{ $t('遇到错误时继续') }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
        <button data-navicat-action="explain" :disabled="!databaseConnected || queryRunning" @click="explainSql"><Braces :size="15" /><span>{{ $t('解释') }}</span></button>
        <button v-if="queryRunning" data-navicat-action="stop" class="stop-query" :title="$t('停止')" @click="cancelQuery"><CircleStop :size="15" /></button>
      </header>

      <div class="query-tabs">
        <button v-for="tab in tabs" :key="tab.id" :class="{ 'is-active': activeTabId === tab.id }" @click="activeTabId = tab.id"><HardDriveDownload v-if="tab.kind === 'utility' && tab.utilityCategory === 'backups'" :size="13" /><History v-else-if="tab.kind === 'automation'" :size="13" /><Server v-else-if="tab.kind === 'user'" :size="13" /><LayoutGrid v-else-if="tab.kind === 'model' || tab.kind === 'bi'" :size="13" /><TerminalSquare v-else-if="tab.kind === 'command-line'" :size="13" /><FileCode2 v-else-if="tab.kind === 'sql' || tab.kind === 'utility'" :size="13" /><Table2 v-else :size="13" /><span>{{ tab.title }}{{ queryTabDirty(tab) || tab.dirty ? ' *' : '' }}</span><i role="button" :aria-label="$t('关闭页签')" :title="$t('关闭页签')" @click.stop="closeTab(tab)"><X :size="12" /></i></button>
        <button class="new-query-tab" :aria-label="$t('新建查询')" :title="$t('新建查询')" @click="newTab()"><Plus :size="14" /></button>
      </div>

      <div v-if="activeTab" class="query-stage" :class="{ 'is-results-side': activeTab.kind === 'sql' && queryResultLayout === 'right' }">
        <template v-if="activeTab.kind === 'sql'">
          <SqlEditor ref="sqlEditor" v-model="activeTab.sql" :completion="sqlCompletionContext" @execute="runQuery($event)" />
          <section class="query-results">
            <header><div class="result-tabs"><button v-for="(result, index) in activeTab.job?.resultSets ?? []" :key="index" :class="{ 'is-active': activeTab.activeResult === index }" @click="activeTab.activeResult = index">{{ $t('结果') }} {{ index + 1 }} <small>{{ resultSummary(result) }}</small></button><span v-if="queryRunning" class="query-running"><RefreshCw :size="13" class="is-spinning" />{{ $t('正在执行') }}</span></div><span v-if="activeTab.job?.durationMs !== undefined" class="query-duration"><Clock3 :size="13" />{{ activeTab.job.durationMs }} ms</span></header>
            <div v-if="activeTab.job?.status === 'cancelled'" class="query-error"><CircleStop :size="18" /><div><strong>{{ $t('查询已取消') }}</strong><code>{{ activeTab.job.error }}</code></div></div>
            <div v-else-if="queryResult(activeTab)?.error" class="query-error"><CircleStop :size="18" /><div><strong>{{ $t('SQL 执行失败') }}</strong><code v-if="queryResult(activeTab)?.statement">{{ queryResult(activeTab)?.statement }}</code><code>{{ queryResult(activeTab)?.error }}</code></div></div>
            <QueryResultGrid v-else-if="queryResult(activeTab)?.rows.length" :columns="queryResult(activeTab)!.columns" :rows="queryResult(activeTab)!.rows" />
            <div v-else-if="queryResult(activeTab)" class="query-success"><CircleCheck :size="22" /><strong>{{ $t('执行成功') }}</strong><span>{{ resultSummary(queryResult(activeTab)!) }}</span></div>
            <div v-else-if="activeTab.job?.status === 'error'" class="query-error"><CircleStop :size="18" /><div><strong>{{ $t('SQL 执行失败') }}</strong><code>{{ activeTab.job.error }}</code></div></div>
            <div v-else class="query-placeholder"><Database :size="27" /><strong>{{ selectedConnection ? $t('准备执行 SQL') : $t('选择数据库连接后开始查询') }}</strong></div>
          </section>
        </template>
        <DatabaseCommandLine v-else-if="activeTab.kind === 'command-line'" :connection-id="selectedConnectionId" :connection-name="selectedConnection?.name || ''" :database="activeTab.database" @database-change="activeTab.database = $event" @close="closeTab(activeTab)" />
        <TableDesigner v-else-if="activeTab.kind === 'table-design'" :key="activeTab.id" :connection-id="selectedConnectionId" :database="activeTab.database" :table="activeTab.table" @dirty-change="setTableDesignerDirty(activeTab, $event)" @saved="handleTableDesignerSaved(activeTab, $event)" />
        <DatabaseAutomationWorkspace v-else-if="activeTab.kind === 'automation'" ref="automationWorkspace" :connection-id="selectedConnectionId" :database="selectedDatabase" :connections="rootConnections" :saved-queries="savedQueries" @dirty-change="activeTab.dirty = $event" />
        <DatabaseModelWorkspace v-else-if="activeTab.kind === 'model'" ref="modelWorkspace" :connection-id="selectedConnectionId" :database="selectedDatabase" @dirty-change="activeTab.dirty = $event" />
        <DatabaseUserWorkspace v-else-if="activeTab.kind === 'user'" :connection-id="selectedConnectionId" :engine="selectedConnection?.engine" :schemas="schemas" />
        <DatabaseBiWorkspace v-else-if="activeTab.kind === 'bi'" ref="biWorkspace" :connection-id="selectedConnectionId" :database="selectedDatabase" :connections="rootConnections" @dirty-change="activeTab.dirty = $event" />
        <section v-else-if="activeTab.kind === 'utility'" class="database-object-browser database-utility-browser">
          <header class="object-browser-toolbar"><div class="object-toolbar-actions"><button @click="createFromUtilityTab(activeTab)"><Plus :size="17" /><span>{{ activeTab.utilityCategory === 'queries' ? $t('新建查询') : $t('新建备份') }}</span></button><button @click="refreshUtilityTab(activeTab)"><RefreshCw :size="17" /><span>{{ $t('刷新') }}</span></button></div><div ref="objectSearchContainer" class="object-toolbar-view"><el-input v-model="objectSearch" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="14" /></template></el-input></div></header>
          <div class="database-object-table-wrap">
            <table v-if="activeTab.utilityCategory === 'queries'" class="database-object-table"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('文件大小') }}</th><th>{{ $t('创建的用户') }}</th><th>{{ $t('创建日期') }}</th><th>{{ $t('修改的用户') }}</th><th>{{ $t('修改日期') }}</th><th>{{ $t('访问时间') }}</th></tr></thead><tbody><tr v-for="item in savedQueriesForDatabase(activeTab.database).filter((entry) => !objectSearch || `${entry.name} ${entry.sql}`.toLowerCase().includes(objectSearch.toLowerCase()))" :key="item.id" tabindex="0" :class="{ 'is-selected': selectedUtilityItems[utilitySelectionKey(activeTab.database, 'queries')] === item.id }" @click="selectUtilityItem(activeTab.database, 'queries', item.id)" @dblclick="openSavedQuery(item)" @keydown.enter="openSavedQuery(item)" @contextmenu="openNavigatorContextMenu($event, { kind: 'object', database: activeTab.database, category: 'queries', objectId: item.id, objectName: item.name })"><td><span class="object-name-cell"><FileCode2 :size="15" />{{ item.name }}</span></td><td>{{ textSize(item.sql) }} B</td><td>{{ item.ownerName }}</td><td>{{ new Date(item.createdAt).toLocaleString($locale()) }}</td><td>{{ item.ownerName }}</td><td>{{ new Date(item.updatedAt).toLocaleString($locale()) }}</td><td>{{ new Date(item.accessedAt).toLocaleString($locale()) }}</td></tr></tbody></table>
            <table v-else class="database-object-table"><thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('文件大小') }}</th><th>{{ $t('创建日期') }}</th><th>{{ $t('修改日期') }}</th><th>{{ $t('访问时间') }}</th><th>{{ $t('注释') }}</th></tr></thead><tbody><tr v-for="item in backupTasksForDatabase(activeTab.database).filter((entry) => !objectSearch || `${entry.title} ${entry.status}`.toLowerCase().includes(objectSearch.toLowerCase()))" :key="item.id" tabindex="0" :class="{ 'is-selected': selectedUtilityItems[utilitySelectionKey(activeTab.database, 'backups')] === item.id }" @click="selectUtilityItem(activeTab.database, 'backups', item.id)" @dblclick="item.status === 'success' ? restoreSelectedBackup(item) : openTaskPanel(activeTab.database)" @keydown.enter="item.status === 'success' ? restoreSelectedBackup(item) : openTaskPanel(activeTab.database)" @contextmenu="openNavigatorContextMenu($event, { kind: 'object', database: activeTab.database, category: 'backups', objectId: item.id, objectName: item.title, objectStatus: item.status })"><td><span class="object-name-cell"><HardDriveDownload :size="15" />{{ item.title }}</span></td><td>{{ typeof item.details.fileSize === 'number' ? formatBytes(item.details.fileSize) : '—' }}</td><td>{{ new Date(item.createdAt).toLocaleString($locale()) }}</td><td>{{ new Date(item.completedAt || item.createdAt).toLocaleString($locale()) }}</td><td>—</td><td>{{ item.status }} · {{ item.progress }}%</td></tr></tbody></table>
            <div v-if="!activeUtilityItems.length" class="object-browser-empty"><component :is="activeTab.utilityCategory === 'queries' ? FileCode2 : HardDriveDownload" :size="25" /><span>{{ activeTab.utilityCategory === 'queries' ? $t('没有查询') : $t('没有备份') }}</span></div>
          </div>
          <footer><span>{{ activeUtilityItems.length }} {{ $t('个') }}{{ activeTab.utilityCategory === 'queries' ? $t('查询') : $t('备份') }}</span><span>{{ activeTab.database }}</span></footer>
        </section>
        <section v-else-if="activeTab.kind === 'objects'" class="database-object-browser">
          <header class="object-browser-toolbar"><div class="object-toolbar-actions"><button :disabled="!selectedObject(activeTab)" @click="openSelectedObject"><FolderOpen :size="17" /><span>{{ $t('打开') }}{{ categoryDefinition(activeTab.category!).label }}</span></button><button :disabled="!selectedObject(activeTab)" @click="designSelectedObject"><FilePenLine :size="17" /><span>{{ $t('设计') }}{{ categoryDefinition(activeTab.category!).label }}</span></button><button @click="createObjectTemplate()"><Plus :size="17" /><span>{{ $t('新建') }}{{ categoryDefinition(activeTab.category!).label }}</span></button><button class="is-danger" :disabled="!selectedObject(activeTab)" @click="deleteSelectedObject"><Trash2 :size="17" /><span>{{ $t('删除') }}{{ categoryDefinition(activeTab.category!).label }}</span></button><span class="toolbar-divider"></span><button v-if="activeTab.category === 'tables'" :disabled="!selectedObject(activeTab)" @click="triggerSelectedTableAction('import')"><Upload :size="17" /><span>{{ $t('导入向导') }}</span></button><el-dropdown v-if="activeTab.category === 'tables'" trigger="click" @command="triggerSelectedTableAction('export', $event)"><button :disabled="!selectedObject(activeTab)"><Download :size="17" /><span>{{ $t('导出向导') }}</span></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="csv">{{ $t('CSV 文件') }}</el-dropdown-item><el-dropdown-item command="xlsx">{{ $t('XLSX 工作簿') }}</el-dropdown-item><el-dropdown-item command="sql">{{ $t('SQL 文件') }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown><button @click="refreshObjectCategory(activeTab)"><RefreshCw :size="17" /><span>{{ $t('刷新') }}</span></button></div><div class="object-toolbar-view"><button :class="{ 'is-active': objectViewMode === 'details' }" :title="$t('详细信息')" @click="objectViewMode = 'details'"><List :size="17" /></button><button :class="{ 'is-active': objectViewMode === 'diagram' }" :title="$t('ER 图表')" @click="objectViewMode = 'diagram'"><LayoutGrid :size="17" /></button><div ref="objectSearchContainer"><el-input v-model="objectSearch" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="14" /></template></el-input></div></div></header>
          <div v-if="objectViewMode === 'details'" class="database-object-table-wrap"><table class="database-object-table"><thead v-if="activeTab.category === 'tables'"><tr><th>{{ $t('名称') }}</th><th>{{ $t('行') }}</th><th>{{ $t('数据长度') }}</th><th>{{ $t('引擎') }}</th><th>{{ $t('创建日期') }}</th><th>{{ $t('修改日期') }}</th><th>{{ $t('排序规则') }}</th><th>{{ $t('注释') }}</th></tr></thead><thead v-else><tr><th>{{ $t('名称') }}</th><th>{{ $t('类型 / 状态') }}</th><th>{{ $t('关联对象') }}</th><th>{{ $t('创建日期') }}</th><th>{{ $t('修改日期') }}</th><th>{{ $t('注释') }}</th></tr></thead><tbody><tr v-for="item in activeObjectItems" :key="`${item.sourceCategory ?? activeTab.category}-${item.name}`" tabindex="0" :class="{ 'is-selected': selectedObject(activeTab) === item }" @click="selectObject(activeTab, item)" @dblclick="openObject(activeTab.database, categoryDefinition(activeTab.category!), item)" @keydown.enter="openObject(activeTab.database, categoryDefinition(activeTab.category!), item)" @contextmenu="openNavigatorContextMenu($event, { kind: 'object', database: activeTab.database, category: activeTab.category!, objectName: item.name, objectSource: item.sourceCategory })"><template v-if="activeTab.category === 'tables'"><td><span class="object-name-cell"><Table2 :size="15" />{{ item.name }}<small v-if="objectGroup(activeTab.database, activeTab.category!, item)">{{ objectGroup(activeTab.database, activeTab.category!, item)?.name }}</small></span></td><td>{{ item.rowCount?.toLocaleString($locale()) ?? '—' }}</td><td>{{ item.dataSize !== undefined ? formatBytes(item.dataSize) : '—' }}</td><td>{{ item.engine || '—' }}</td><td>{{ item.createdAt ? new Date(item.createdAt).toLocaleString($locale()) : '—' }}</td><td>{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString($locale()) : '—' }}</td><td>{{ item.collation || '—' }}</td><td>{{ item.comment || '—' }}</td></template><template v-else><td><span class="object-name-cell"><component :is="categoryDefinition(activeTab.category!).icon" :size="15" />{{ item.name }}<small v-if="objectGroup(activeTab.database, activeTab.category!, item)">{{ objectGroup(activeTab.database, activeTab.category!, item)?.name }}</small></span></td><td>{{ item.engine || item.status || item.eventType || item.timing || objectCategoryLabel(item, categoryDefinition(activeTab.category!)) }}</td><td>{{ item.tableName || item.event || '—' }}</td><td>{{ item.createdAt ? new Date(item.createdAt).toLocaleString($locale()) : '—' }}</td><td>{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString($locale()) : '—' }}</td><td>{{ item.comment || '—' }}</td></template></tr></tbody></table><div v-if="!activeObjectItems.length" class="object-browser-empty"><component :is="categoryDefinition(activeTab.category!).icon" :size="25" /><span>{{ objectSearch ? $t('没有匹配对象') : $t('当前分类没有对象') }}</span></div></div>
          <div v-else class="database-er-canvas"><article v-for="item in activeObjectItems" :key="`${item.sourceCategory ?? activeTab.category}-${item.name}`" :class="{ 'is-selected': selectedObject(activeTab) === item }" tabindex="0" @click="selectObject(activeTab, item)" @dblclick="openObject(activeTab.database, categoryDefinition(activeTab.category!), item)"><header><component :is="categoryDefinition(activeTab.category!).icon" :size="15" /><strong>{{ item.name }}</strong></header><dl><div><dt>{{ $t('类型') }}</dt><dd>{{ item.engine || item.eventType || objectCategoryLabel(item, categoryDefinition(activeTab.category!)) }}</dd></div><div><dt>{{ $t('行') }}</dt><dd>{{ item.rowCount?.toLocaleString($locale()) ?? '—' }}</dd></div><div><dt>{{ $t('数据长度') }}</dt><dd>{{ item.dataSize !== undefined ? formatBytes(item.dataSize) : '—' }}</dd></div></dl><p>{{ item.comment || item.tableName || $t('无注释') }}</p></article><div v-if="!activeObjectItems.length" class="object-browser-empty"><LayoutGrid :size="25" /><span>{{ objectSearch ? $t('没有匹配对象') : $t('当前分类没有对象') }}</span></div></div>
          <footer><span>{{ activeObjectItems.length }} {{ $t('个') }}{{ categoryDefinition(activeTab.category!).label }}</span><span>{{ activeTab.database }}</span></footer>
        </section>
        <div
          v-for="tab in dataTabs"
          v-show="activeTabId === tab.id"
          :key="tab.id"
          style="min-width: 0; min-height: 0; grid-row: 1 / -1; display: grid;"
        >
          <TableDataEditor
            :active="activeTabId === tab.id"
            :connection-id="selectedConnectionId"
            :database="tab.database"
            :table="tab.table!"
            :read-only="tab.readOnly"
            :action-request="tab.tableAction"
            @action-handled="clearTableAction"
          />
        </div>
      </div>
      <div v-else class="query-stage-empty"><FileCode2 :size="27" /><strong>{{ $t('未打开查询或数据表') }}</strong></div>

      <aside v-if="sidePanel" class="query-side-panel"><header><div><strong>{{ sidePanel === 'history' ? $t('执行历史') : $t('SQL 收藏夹') }}</strong></div><button :aria-label="$t('关闭侧栏')" @click="sidePanel = ''"><X :size="16" /></button></header><div class="saved-query-list"><article v-for="item in sidePanel === 'history' ? historyItems : favorites" :key="item.id" @click="openSaved(item.sql, 'database' in item ? item.database : selectedDatabase, 'name' in item ? item.name : $t('历史查询'))"><header><span v-if="'status' in item" :class="`is-${item.status}`">{{ item.status }}</span><strong v-else>{{ item.name }}</strong><time>{{ new Date('createdAt' in item ? item.createdAt : item.updatedAt).toLocaleString($locale()) }}</time></header><code>{{ item.sql }}</code><footer v-if="'durationMs' in item"><span>{{ item.database || $t('默认库') }}</span><span>{{ item.durationMs }} ms · {{ item.rowCount }} {{ $t('行') }}</span></footer><footer v-else><span>{{ $t('点击打开') }}</span><button :title="$t('删除收藏')" @click.stop="deleteFavorite(item as FavoriteItem)"><X :size="12" /></button></footer></article><div v-if="sidePanel === 'history' ? !historyItems.length : !favorites.length" class="saved-empty"><History :size="23" /><span>{{ sidePanel === 'history' ? $t('还没有查询历史') : $t('还没有收藏 SQL') }}</span></div></div></aside>
      <DatabaseTaskPanel :visible="taskPanel" :connection-id="selectedConnectionId" :database="selectedDatabase" :connections="rootConnections" :action-request="taskPanelRequest" @close="taskPanel = false" @action-handled="closeTaskPanelRequest" @tasks-change="updateDatabaseTasks" />
      <DatabaseCodeSnippetPanel :visible="codeSnippetOpen && activeTab?.kind === 'sql'" :current-sql="activeTab?.kind === 'sql' ? activeTab.sql : ''" @close="codeSnippetOpen = false" @insert="insertCodeSnippet" />
    </main>

    <button v-if="informationPaneVisible" class="database-information-resizer" type="button" role="separator" aria-orientation="vertical" :aria-label="$t('调整信息窗格宽度')" :aria-valuenow="explorerPaneWidth" @pointerdown="startExplorerPaneResize" @keydown.left.prevent="resizeExplorerPane(20)" @keydown.right.prevent="resizeExplorerPane(-20)"><span></span></button>
    <aside v-if="informationPaneVisible" class="database-information-pane">
      <header><nav><button :class="{ 'is-active': informationPaneTab === 'general' }" @click="informationPaneTab = 'general'">{{ $t('常规') }}</button><button :class="{ 'is-active': informationPaneTab === 'ddl' }" @click="loadInformationDdl">{{ activeTab?.kind === 'utility' || activeTab?.kind === 'sql' ? $t('预览') : 'DDL' }}</button></nav><button type="button" :title="$t('关闭信息窗格')" :aria-label="$t('关闭信息窗格')" @click="setInformationPaneVisible(false)"><X :size="14" /></button></header>
      <div v-if="informationPaneTab === 'general'" class="database-information-general"><dl><div v-for="row in informationRows" :key="row[0]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></div></dl></div>
      <div v-else class="database-information-ddl" v-loading="informationLoading"><pre>{{ informationDdl || $t('-- 选择对象后查看预览') }}</pre></div>
      <footer><span><Info :size="24" /></span><div><strong>{{ informationTitle }}</strong><small>{{ informationSubtitle }}</small></div></footer>
    </aside>

    <ConnectionEditDialog v-model="connectionEditorOpen" connection-type="database" :connection="editingConnection" :copy-mode="copyConnectionMode" :profile-parent-id="connectionProfileParentId || undefined" :profiles="editingConnectionProfiles" :active-profile-id="String(editingRootConnection?.options.activeProfileId ?? '')" :connected="Boolean(editingRootConnection && databaseConnected && activeRootConnectionId === editingRootConnection.id)" :default-environment-id="environmentId ?? null" @saved="refreshConnections" @profile-action="handleConnectionProfileAction" />
    <DatabaseSyncDialog :visible="syncDialogOpen" :initial-mode="syncDialogMode" :connection-id="selectedConnectionId" :database="selectedDatabase" :connections="rootConnections" @close="syncDialogOpen = false" @started="loadDatabaseTasks" />
    <el-dialog v-model="databaseSearchOpen" class="database-search-dialog" width="640px" append-to-body destroy-on-close><template #header><div class="database-search-title"><Search :size="18" /><span><strong>{{ $t('在数据库中查找') }}</strong><small>{{ databaseSearchDatabase }}</small></span></div></template><div ref="databaseSearchContainer"><el-input v-model="databaseSearchQuery" clearable :placeholder="$t('输入对象名称、类型、注释或关联表')" @keyup.enter="openDatabaseSearchResult()"><template #prefix><Search :size="15" /></template></el-input></div><div class="database-search-results" role="listbox" :aria-label="$t('数据库对象搜索结果')"><button v-for="result in databaseSearchResults" :key="result.key" type="button" role="option" :aria-selected="databaseSearchSelection === result.key" :class="{ 'is-selected': databaseSearchSelection === result.key }" @click="databaseSearchSelection = result.key" @dblclick="openDatabaseSearchResult(result)"><component :is="categoryDefinition(result.category).icon" :size="15" /><span><strong>{{ result.item.name }}</strong><small>{{ result.categoryLabel }}<template v-if="result.item.tableName"> · {{ result.item.tableName }}</template></small></span></button><div v-if="!databaseSearchResults.length" class="database-search-empty"><Search :size="24" /><span>{{ $t('没有匹配的数据库对象') }}</span></div></div><template #footer><el-button @click="databaseSearchOpen = false">{{ $t('取消') }}</el-button><span class="database-search-count">{{ databaseSearchResults.length }} {{ $t('个对象') }}</span><el-button type="primary" :disabled="!databaseSearchSelection" @click="openDatabaseSearchResult()">{{ $t('打开') }}</el-button></template></el-dialog>
    <DatabaseNavigatorContextMenu :visible="navigatorMenu.visible" :x="navigatorMenu.x" :y="navigatorMenu.y" :items="navigatorMenuItems" @close="navigatorMenu.visible = false" @select="handleNavigatorMenuAction" />
    <DatabaseQueryBuilderDialog :visible="queryBuilderOpen" :connection-id="selectedConnectionId" :database="activeTab?.kind === 'sql' ? activeTab.database : selectedDatabase" @close="queryBuilderOpen = false" @build="handleBuiltQuery" />
    <DatabaseDataGeneratorDialog :visible="dataGenerator.visible" :connection-id="selectedConnectionId" :database="dataGenerator.database" :table="dataGenerator.table" @close="dataGenerator.visible = false" @generate="handleGeneratedData" />
    <DatabaseObjectPrivilegeDialog :visible="objectPrivilege.visible" :connection-id="selectedConnectionId" :database="objectPrivilege.database" :object-name="objectPrivilege.objectName" :object-type="objectPrivilege.objectType" @close="objectPrivilege.visible = false" />
    <el-dialog v-model="shareDialogOpen" class="database-navicat-dialog" :title="$t('共享连接 · {0}', [shareConnection?.name || ''])" width="620px" append-to-body destroy-on-close>
      <div class="database-connection-share" v-loading="shareDialogLoading">
        <div class="database-connection-share__grant"><el-select v-model="shareGrantee" filterable :placeholder="$t('选择组织成员或项目')"><el-option v-for="candidate in shareCandidates" :key="candidate.key" :label="`${candidate.type === 'project' ? $t('项目') : $t('成员')} · ${candidate.label}`" :value="candidate.key" /></el-select><el-button type="primary" :disabled="!shareGrantee" @click="grantSharedConnection">{{ $t('共享') }}</el-button></div>
        <div class="database-connection-share__list"><article v-for="grant in shareGrants" :key="grant.id"><span><strong>{{ grant.granteeName }}</strong><small>{{ grant.granteeType === 'project' ? $t('项目授权') : $t('成员授权') }}</small></span><button type="button" @click="revokeSharedConnection(grant)">{{ $t('撤销') }}</button></article><div v-if="!shareGrants.length" class="object-browser-empty">{{ $t('当前连接尚未共享') }}</div></div>
      </div>
      <template #footer><el-button @click="shareDialogOpen = false">{{ $t('完成') }}</el-button></template>
    </el-dialog>
  </section>
</template>
