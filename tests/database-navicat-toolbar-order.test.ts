import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function region(contents: string, start: string, end: string): string {
  const from = contents.indexOf(start);
  const to = contents.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing source region ${start} ... ${end}`);
  return contents.slice(from, to);
}

function actions(contents: string): string[] {
  return [...contents.matchAll(/data-navicat-action="([^"]+)"/g)].map((match) => match[1]);
}

describe("Navicat toolbar action order", () => {
  const workbench = source("../src/client/components/DatabaseWorkbench.vue");
  // contract unchanged; connectionPaneVisible default still true, moved to use-database-layout.ts
  const layout = source("../src/client/components/database-workbench/use-database-layout.ts");
  // contract unchanged; implementation moved from DatabaseWorkbench.vue
  const connections = source("../src/client/components/database-workbench/use-database-connections.ts");
  // contract unchanged; implementation moved from use-database-navigator.ts
  const navigatorActions = source("../src/client/components/database-workbench/database-navigator-actions.ts");
  const queryTabs = source("../src/client/components/database-workbench/use-database-query-tabs.ts");
  const connectionEditor = source("../src/client/components/ConnectionEditDialog.vue");
  const designer = source("../src/client/components/TableDesigner.vue");
  const tableData = source("../src/client/components/TableDataEditor.vue");
  const automation = source("../src/client/components/DatabaseAutomationWorkspace.vue");
  const model = source("../src/client/components/DatabaseModelWorkspace.vue");
  const users = source("../src/client/components/DatabaseUserWorkspace.vue");
  const bi = source("../src/client/components/DatabaseBiWorkspace.vue");
  const styles = source("../src/client/styles/base.css");

  it("keeps the global toolbar and pane controls in Navicat order", () => {
    expect(actions(region(workbench, '<header class="database-global-toolbar">', '<aside v-if="connectionPaneVisible"'))).toEqual([
      "connection",
      "new-query",
      "table",
      "view",
      "function",
      "user",
      "event",
      "query",
      "backup",
      "navigation-pane",
      "information-pane",
    ]);
  });

  it("opens the navigation pane by default on each workbench entry", () => {
    expect(layout).toContain("const connectionPaneVisible = ref(true);");
    expect(region(layout, "function persistWorkbenchPreferences", "function restoreWorkbenchPreferences"))
      .not.toContain("connectionPaneVisible");
    expect(region(layout, "function restoreWorkbenchPreferences", "function setConnectionPaneWidth"))
      .not.toContain("connectionPaneVisible");
    expect(workbench).toContain(":class=\"{ 'is-active': connectionPaneVisible }\"");
    expect(workbench).toContain('<aside v-if="connectionPaneVisible" class="database-navigator">');
  });

  it("keeps the global connection action as a single dropdown button", () => {
    const globalToolbar = region(workbench, '<header class="database-global-toolbar">', '<aside v-if="connectionPaneVisible"');
    const connectionTool = region(globalToolbar, '<el-dropdown trigger="click" @command="handleGlobalConnectionCommand">', 'data-navicat-action="new-query"');
    expect(connectionTool).toContain('data-navicat-action="connection" :title="$t(\'连接\')"');
    expect(connectionTool).toContain("<span>{{ $t('连接') }}</span><ChevronDown");
    expect(connectionTool).toContain('command="new">{{ $t(\'新建连接…\') }}');
    expect(connectionTool).not.toContain("database-global-split");
    expect(connectionTool).not.toContain("@click=\"handleGlobalConnectionCommand('new')\"");
    expect(globalToolbar).not.toContain("database-global-split-tool");
    expect(globalToolbar).not.toContain("database-global-split-menu");
  });

  it("keeps the query toolbar in Navicat order", () => {
    expect(actions(region(workbench, 'class="sql-toolbar navicat-query-toolbar"', '<div class="query-tabs">'))).toEqual([
      "save",
      "beautify",
      "code-snippet",
      "result-below",
      "result-right",
      "focus",
      "connection",
      "database",
      "run",
      "explain",
      "stop",
    ]);
  });

  it("keeps the table designer toolbar in Navicat order", () => {
    expect(actions(region(designer, '<header class="table-designer-toolbar">', '<nav class="table-designer-tabs"'))).toEqual([
      "save",
      "add",
      "insert",
      "delete",
      "focus",
    ]);
    expect(region(queryTabs, "function newTableDesigner", "function newObjectTab")).toContain("dirty: !table");
  });

  it("keeps connection profile lifecycle actions in the connection window", () => {
    expect(actions(region(connectionEditor, '<section v-if="profileManagerVisible"', '</section>'))).toEqual([
      "new-connection-profile",
      "set-active-profile",
      "duplicate-profile",
      "delete-profile",
    ]);
    const connectionMenu = region(navigatorActions, "function openNavigatorContextMenu", "async function showDdl");
    expect(connectionMenu).not.toContain('action === "new-profile"');
  });

  it("keeps connection block folding separate from the context menu button", () => {
    const connectionRow = region(workbench, '<div class="database-navigation-connection-row"', '<div v-if="connectionChildrenVisible(connection)"');
    expect(connectionRow).toContain('@contextmenu="openConnectionContextMenu($event, connection)"');
    expect(connectionRow).toContain('@click="handleConnectionNodeClick(connection)"');
    expect(connectionRow).toContain(':aria-expanded="activeRootConnectionId === connection.id && databaseConnected ? connectionChildrenVisible(connection) : undefined"');
    expect(connectionRow).toContain('@click.stop="openConnectionContextMenu($event, connection)"');
    expect(connectionRow).toContain(':title="$t(\'连接菜单\')"');
    expect(connections).toContain('function handleConnectionNodeClick(connection: DatabaseConnection)');
    expect(connections).toContain('setConnectionCollapsed(connection.id, !collapsedConnectionIds.value.has(connection.id));');
  });

  it("keeps the connection and profile label on one truncating line", () => {
    const connectionRow = region(workbench, '<div class="database-navigation-connection-row"', '<div v-if="connectionChildrenVisible(connection)"');
    expect(connectionRow).toContain('<span class="database-navigation-connection-label">{{ connection.name }}');
    expect(connectionRow).toContain(' · {{ selectedConnection.profileName }}');
    expect(connectionRow).not.toContain("<small");
    expect(styles).toContain(".database-navigation-connection-label { min-width: 0; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;");
  });

  it("keeps long connection group paths inside their fixed-height row", () => {
    const groupToggle = region(workbench, '<button class="database-navigation-group-toggle"', '</button>');
    expect(groupToggle).toContain(':title="group.path"');
    expect(groupToggle).toContain('<span>{{ group.path }}</span>');
    expect(styles).toContain(".database-navigation-group-toggle > span { min-width: 0; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
  });

  it("labels database object favorites as favorites instead of starred items", () => {
    const favorites = region(workbench, '<section v-if="visibleObjectFavorites.length" class="database-navigation-favorites">', '<section v-for="group in groupedConnections"');
    expect(favorites).toContain("<span>{{ $t('收藏') }}</span>");
    expect(favorites).not.toContain("已标星");
    expect(workbench).toContain(':title="$t(\'仅显示收藏\')" :aria-label="$t(\'仅显示收藏\')"');
    expect(workbench).not.toContain("显示已标星");
  });

  it("shares navigator table selection with global table actions", () => {
    const navigatorSelection = region(navigatorActions, "function selectNavigatorObject", "async function showNavigatorDdl");
    expect(navigatorSelection).toContain("selectedDatabase.value = database;");
    expect(navigatorSelection).toContain("$navigator.selectedObjects.value = { ...$navigator.selectedObjects.value, [`${database}:${category.key}`]: item.name };");
    expect(navigatorSelection).toContain('const objectTab = $queryTabs.tabs.value.find((tab) => tab.kind === "objects");');
    expect(navigatorSelection).toContain("objectTab.database = database;");
    expect(navigatorSelection).toContain("objectTab.category = category.key;");

    const selectedTable = region(navigatorActions, "function selectedTableContext", "async function openSelectedObject");
    expect(selectedTable).toContain("const activeContext = selectedCategoryContext();");
    expect(selectedTable).toContain('activeContext?.tab.category === "tables"');
    expect(selectedTable).toContain('selectedObjectInCategory(database, "tables")');

    const tableActions = region(navigatorActions, "function handleGlobalTableCommand", "async function loadInformationDdl");
    expect(tableActions).toContain('else if (command === "import")');
    expect(tableActions).toContain('$queryTabs.triggerSelectedTableAction("import");');
    expect(tableActions).toContain('$queryTabs.triggerSelectedTableAction("export", command as "csv" | "xlsx" | "sql")');
    expect(tableActions).not.toContain("请先在表列表中选择数据表");
  });

  it("opens the current table designer with the Navicat design shortcut", () => {
    const tableContext = region(navigatorActions, "function currentTableContext", "async function openSelectedObject");
    expect(tableContext).toContain('tab?.kind === "data" && tab.table && !tab.readOnly');
    expect(tableContext).toContain("return selectedTableContext();");

    const shortcuts = region(queryTabs, "function handleWorkbenchShortcut", "function handleWorkbenchKeydown");
    expect(shortcuts).toContain('action === "workspace.design"');
    expect(shortcuts).toContain("designCurrentTable();");
  });

  it("closes database child tabs when databases or sessions close", () => {
    const removeTabs = region(queryTabs, "function removeTabsForDatabase", "function triggerSelectedTableAction");
    expect(removeTabs).toContain("tabs.value = tabs.value.filter((tab) => tab.database !== database);");
    expect(removeTabs).toContain("activeTabId.value = tabs.value[0]?.id ?? \"\";");

    const clearState = region(navigatorActions, "function clearDatabaseLocalState", "async function openGlobalCategory");
    expect(clearState).toContain("delete $navigator.objects.value[database];");
    expect(clearState).toContain("delete $navigator.sqlCompletionCatalogs.value[database];");
    expect(clearState).toContain("$navigator.selectedObjects.value = Object.fromEntries");
    expect(clearState).toContain("$navigator.expandedCategories.value = new Set");

    const closeDatabase = region(navigatorActions, "function closeDatabase", "function editDatabaseTemplate");
    expect(closeDatabase).toContain("removeTabsForDatabase(database);");
    expect(closeDatabase).toContain("clearDatabaseLocalState(database);");

    const sessionPoll = region(connections, "async function pollDatabaseSession", "async function focusInitialConnection");
    expect(sessionPoll).toContain("selectedConnectionId.value = \"\";");
    expect(sessionPoll).toContain("resetDatabaseWorkspace(false);");
  });

  it("keeps the table data toolbars in Navicat order", () => {
    expect(actions(region(tableData, '<header class="table-data-toolbar">', '<section v-if="toolPanel"'))).toEqual([
      "data-view",
      "transaction",
      "editor",
      "filter-sort",
      "columns",
      "tools",
      "focus",
    ]);
    expect(actions(region(tableData, '<footer class="table-data-commandbar">', '</footer>'))).toEqual([
      "add-record",
      "delete-record",
      "commit",
      "rollback",
      "refresh",
      "stop",
      "first-page",
      "previous-page",
      "page-number",
      "next-page",
      "last-page",
      "page-size",
      "grid-view",
      "form-view",
    ]);
    const stop = region(tableData, 'data-navicat-action="stop"', '</button>');
    expect(stop).toContain(':disabled="!loading"');
    expect(stop).toContain('@click="stopLoading"');
    expect(tableData).toContain('class="table-filter-sort-editor"');
    expect(tableData).toContain("filterRules");
    expect(tableData).toContain("sortRules");
    expect(tableData).toContain("table-data/suggestions");
    expect(tableData).toContain('class="table-findbar"');
    expect(tableData).toContain("openFind();");
  });

  it("themes database inputs independently from the outer app theme", () => {
    expect(styles).toContain(".database-workbench,\n.database-navicat-dialog.el-dialog,");
    expect(styles).toContain("--el-fill-color-blank: #1b2022;");
    expect(styles).toContain("--el-mask-color: #101c1f;");
    expect(styles).toContain("--el-loading-spinner-size: 30px;");
    expect(styles).toContain(".database-workbench .el-loading-spinner .path { stroke: #5bc9a6; stroke-width: 3; }");
    expect(styles).toContain(":root.bright .database-workbench,");
    expect(styles).toContain(":root.bright .database-workbench { --el-mask-color: #f4f7f7; }");
    expect(styles).toContain(".database-console-select-popper.el-select__popper.el-popper");
    expect(tableData.match(/popper-class="database-console-select-popper"/g)).toHaveLength(6);
  });

  it("keeps the database loading indicator calm when reduced motion is requested", () => {
    expect(styles).toContain(".database-workbench .el-loading-spinner .circular,\n  .database-workbench .el-loading-spinner .path {\n    animation: none !important;");
  });

  it("keeps opened table data tabs mounted while switching tabs", () => {
    expect(queryTabs).toContain('const dataTabs = computed(() => tabs.value.filter((tab) => tab.kind === "data" && tab.table));');
    expect(workbench).not.toContain('<TableDataEditor v-else-if="activeTab.kind === \'data\'"');
    const dataEditorHost = region(workbench, '<div\n          v-for="tab in dataTabs"', "        </div>");
    expect(dataEditorHost).toContain('v-show="activeTabId === tab.id"');
    expect(dataEditorHost).toContain(':key="tab.id"');
    expect(dataEditorHost).toContain("grid-row: 1 / -1");
    expect(dataEditorHost).toContain("<TableDataEditor");
    expect(dataEditorHost).toContain(':active="activeTabId === tab.id"');
    expect(dataEditorHost).toContain(':database="tab.database"');
    expect(dataEditorHost).toContain(':table="tab.table!"');

    const keydown = region(tableData, "function handleDocumentKeydown", "async function changePage");
    expect(keydown).toContain("if (!props.active) return;");
    const shortcuts = region(tableData, "removeShortcutListener = onAppShortcut", "});\n  await refreshTableContext");
    expect(shortcuts).toContain("if (!props.active || !editorElement.value?.getClientRects().length) return;");
    expect(tableData).toContain("watch(() => props.active");
    expect(tableData).toContain("tableGrid?.redraw(true)");
  });

  it("keeps the automation object page and editor in Navicat order", () => {
    expect(actions(region(automation, '<header class="database-artifact-list-toolbar">', '<div class="database-object-table-wrap">'))).toEqual([
      "new-automation",
      "refresh",
    ]);
    expect(actions(region(automation, '<header class="database-automation-toolbar">', '<nav class="database-automation-tabs">'))).toEqual([
      "start",
      "save",
      "set-schedule",
      "delete-schedule",
      "add-work",
      "add-all",
      "remove-work",
      "remove-all",
      "focus",
    ]);
  });

  it("keeps the model object page and editor in Navicat order", () => {
    expect(actions(region(model, '<header class="database-artifact-list-toolbar">', '<div class="database-object-table-wrap">'))).toEqual([
      "new-model",
      "refresh",
    ]);
    expect(actions(region(model, '<header class="database-model-toolbar">', '<main class="database-model-stage"'))).toEqual([
      "existing-objects",
      "new-table",
      "add-foreign-key",
      "new-view",
      "new-procedure",
      "new-function",
      "new-label",
      "new-note",
      "new-image",
      "new-shape",
      "new-layer",
      "auto-layout",
      "preview",
      "focus",
    ]);
  });

  it("keeps the user object page in Navicat order", () => {
    expect(actions(region(users, '<header class="database-user-toolbar">', '<div class="database-object-table-wrap">'))).toEqual([
      "new-user",
      "privilege-manager",
      "refresh",
    ]);
  });

  it("keeps the BI object page and editor in Navicat order", () => {
    expect(actions(region(bi, '<header class="database-artifact-list-toolbar">', '<div class="database-object-table-wrap">'))).toEqual([
      "new-bi-workspace",
      "refresh",
    ]);
    expect(actions(region(bi, '<header class="database-bi-toolbar">', '<nav class="database-bi-tabs">'))).toEqual([
      "save",
      "new-data-source",
      "new-chart",
      "new-dashboard",
      "theme",
    ]);
  });

  it("does not route Navicat actions to unrelated Viron workflows", () => {
    const contextMenu = region(navigatorActions, "function openNavigatorContextMenu", "async function showDdl");
    expect(contextMenu).not.toContain("openCategory(");
    expect(contextMenu).not.toContain("newObjectTab(");

    const globalToolbar = region(workbench, '<header class="database-global-toolbar">', '<aside v-if="connectionPaneVisible"');
    expect(globalToolbar).toContain('data-navicat-action="user" :disabled="!databaseConnected" @click="newArtifactTab(\'user\')"');
    expect(globalToolbar).not.toContain('data-navicat-action="automation"');
    expect(globalToolbar).not.toContain('data-navicat-action="model"');
    expect(globalToolbar).not.toContain('data-navicat-action="bi"');
    expect(globalToolbar).toContain('data-viron-action="extensions"');
    expect(globalToolbar).toContain("<span>{{ $t('工具') }}</span>");
    expect(globalToolbar).not.toContain('<span>Viron</span>');
    expect(globalToolbar.indexOf('data-navicat-action="information-pane"')).toBeLessThan(globalToolbar.indexOf('data-viron-action="extensions"'));
    expect(globalToolbar).toContain('data-navicat-action="connection" :title="$t(\'连接\')"');
    expect(globalToolbar).not.toContain('aria-label="连接菜单"');

    const queryToolbar = region(workbench, 'class="sql-toolbar navicat-query-toolbar"', '<div class="query-tabs">');
    expect(queryToolbar).toContain('data-navicat-action="save" :disabled="!selectedConnection"');
    expect(queryToolbar).toContain('@click="saveQueryTab()"');
    expect(queryToolbar).not.toContain('@click="addFavorite"');
    expect(queryToolbar).not.toContain('data-navicat-action="query-builder"');
    expect(queryToolbar).toContain('data-navicat-action="code-snippet"');
    expect(queryToolbar).not.toContain('code-snippet" disabled');
    expect(queryToolbar).toContain('command="selected">{{ $t(\'运行已选择的\') }}</el-dropdown-item>');
    expect(queryToolbar).toContain('data-navicat-action="run" :disabled="!databaseConnected || queryRunning" @click="runQuery()"');
    expect(queryToolbar).toContain(':aria-label="$t(\'运行菜单\')"');
    expect(queryToolbar).toContain('command="toggle-continue"');
    expect(queryToolbar).not.toContain('<el-dropdown-item disabled>{{ $t(\'遇到错误时继续\') }}</el-dropdown-item>');
    expect(queryToolbar).toContain('<button v-if="queryRunning" data-navicat-action="stop"');
    expect(queryToolbar).not.toContain('data-navicat-action="history"');
    expect(globalToolbar).toContain('<el-dropdown-item command="history">{{ $t(\'执行历史\') }}</el-dropdown-item>');
  });
});
