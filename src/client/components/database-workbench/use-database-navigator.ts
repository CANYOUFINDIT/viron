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

export function useDatabaseNavigator(
  ctx: DatabaseWorkbenchContext,
  props: Readonly<DatabaseWorkbenchProps>,
  route: { fullPath: string },
) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $connections = deferDatabaseWorkbenchPart(ctx, "connections");
  const $queryTabs = deferDatabaseWorkbenchPart(ctx, "queryTabs");
  const $artifacts = deferDatabaseWorkbenchPart(ctx, "artifacts");
  const $agentScene = deferDatabaseWorkbenchPart(ctx, "agentScene");
  const $menuActions = deferDatabaseWorkbenchPart(ctx, "menuActions");
  const informationDdl = ref("");

  const informationLoading = ref(false);

  const schemas = ref<SchemaItem[]>([]);

  const sqlCompletionCatalogs = ref<Record<string, SqlCompletionCatalog>>({});

  const sqlCompletionLoading = new Set<string>();

  const expandedDatabases = ref<Set<string>>(new Set());

  const expandedCategories = ref<Set<string>>(new Set());

  const selectedDatabase = ref("");

  const objects = ref<Record<string, Partial<Record<BrowserCategory, DatabaseObject[]>>>>({});

  const objectLoading = ref("");

  const navigatorTarget = ref("");

  const objectSearch = ref("");

  const objectViewMode = ref<"details" | "diagram">("details");

  const selectedObjects = ref<Record<string, string>>({});

  const objectFavorites = ref<ObjectFavoriteItem[]>([]);

  const objectGroups = ref<ObjectGroupItem[]>([]);

  const navigatorObjectClipboard = ref<NavigatorObjectClipboard | null>(null);

  const navigatorMenu = ref<{
      visible: boolean;
      x: number;
      y: number;
      target: WorkbenchNavigatorTarget | null;
  }>({ visible: false, x: 0, y: 0, target: null });

  const databaseSearchOpen = ref(false);

  const databaseSearchDatabase = ref("");

  const databaseSearchQuery = ref("");

  const databaseSearchSelection = ref("");

  const objectSearchContainer = ref<HTMLElement | null>(null);

  const databaseSearchContainer = ref<HTMLElement | null>(null);

  const objectPrivilege = ref<{
      visible: boolean;
      database: string;
      objectName: string;
      objectType: "table" | "view" | "procedure" | "function";
  }>({ visible: false, database: "", objectName: "", objectType: "table" });

  const objectCategories: ObjectCategoryDefinition[] = [
      { key: "tables", label: tr("表"), icon: Table2, singular: "table", sources: ["tables"] },
      { key: "views", label: tr("视图"), icon: Eye, singular: "view", sources: ["views"] },
      { key: "functions", label: tr("函数"), icon: FileCode2, singular: "function", sources: ["procedures", "functions"] },
      { key: "events", label: tr("事件"), icon: Clock3, singular: "event", sources: ["events"] },
  ];

  const categories: NavigatorCategory[] = [
      ...objectCategories,
      { key: "queries", label: tr("查询"), icon: FileCode2 },
      { key: "backups", label: tr("备份"), icon: HardDriveDownload },
  ];

  const navigatorMenuItems = computed<DatabaseNavigatorMenuItem[]>(() => {
      const target = navigatorMenu.value.target;
      if (!target)
          return [];
      if (target.kind === "connection") {
          const connection = $connections.connections.value.find((item) => item.id === target.connectionId);
          const profiles = $connections.connections.value.filter((item) => item.profileParentId === target.connectionId);
          return buildConnectionNavigatorMenu(target.connectionId === $connections.activeRootConnectionId.value && $connections.databaseConnected.value, {
              starred: connection?.starred,
              canManage: connection?.canManage,
              canShare: Boolean(connection?.canManage && session.workspace?.type === "organization" && session.workspace.role === "admin"),
              connectionGroupId: connection?.connectionGroupId,
              groups: $connections.connectionGroups.value,
              profiles: profiles.map((profile) => ({ id: profile.id, name: profile.profileName || profile.name })),
              activeProfileId: $connections.selectedConnection.value?.profileParentId === target.connectionId
                  ? $connections.selectedConnection.value.id
                  : String(connection?.options.activeProfileId ?? ""),
          });
      }
      return buildDatabaseNavigatorMenu(target, {
          canShare: Boolean($connections.selectedRootConnection.value?.canManage && session.workspace?.type === "organization" && session.workspace.role === "admin"),
          canPaste: Boolean(target.category && navigatorObjectClipboard.value?.category === target.category),
          profiles: $connections.activeConnectionProfiles.value,
      });
  });

  const visibleObjectFavorites = computed(() => {
      const available = new Set($connections.connections.value.map((connection) => connection.id));
      const query = $connections.connectionSearch.value.trim().toLowerCase();
      return objectFavorites.value.filter((item) => {
          if (!available.has(item.connectionId))
              return false;
          if (!query)
              return true;
          return `${item.connectionName} ${item.database} ${item.table} ${item.host}`.toLowerCase().includes(query);
      });
  });

  const sqlCompletionContext = computed(() => {
      const database = $queryTabs.activeTab.value?.kind === "sql" ? $queryTabs.activeTab.value.database : "";
      return { schemas: schemas.value.map((schema) => schema.name), catalog: database ? sqlCompletionCatalogs.value[database] : undefined };
  });

  const activeObjectItems = computed(() => {
      if ($queryTabs.activeTab.value?.kind !== "objects" || !$queryTabs.activeTab.value.category)
          return [];
      const items = objects.value[$queryTabs.activeTab.value.database]?.[$queryTabs.activeTab.value.category] ?? [];
      const query = objectSearch.value.trim().toLowerCase();
      if (!query)
          return items;
      return items.filter((item) => `${item.name} ${item.engine ?? ""} ${item.status ?? ""} ${item.comment ?? ""} ${item.tableName ?? ""}`.toLowerCase().includes(query));
  });

  const databaseSearchResults = computed<DatabaseSearchResult[]>(() => {
      const query = databaseSearchQuery.value.trim().toLowerCase();
      return objectCategories.flatMap((category) => (objects.value[databaseSearchDatabase.value]?.[category.key] ?? [])
          .filter((item) => !query || `${item.name} ${item.comment ?? ""} ${item.tableName ?? ""} ${objectCategoryLabel(item, category)}`.toLowerCase().includes(query))
          .map((item) => ({
          key: `${category.key}:${item.sourceCategory ?? category.key}:${item.name}`,
          category: category.key,
          categoryLabel: objectCategoryLabel(item, category),
          item,
      })));
  });

  function categoryKey(database: string, category: NavigatorCategoryKey) {
      return `${database}:${category}`;
  }

  function categoryDefinition(key: BrowserCategory) {
      return objectCategories.find((category) => category.key === key)!;
  }

  function isObjectCategory(category: NavigatorCategory): category is ObjectCategoryDefinition {
      return "sources" in category;
  }

  function categoryItems(database: string, category: NavigatorCategory): DatabaseObject[] {
      if (!isObjectCategory(category))
          return [];
      return objects.value[database]?.[category.key] ?? [];
  }

  function categoryCount(database: string, category: NavigatorCategory): number | string {
      if (category.key === "queries")
          return $artifacts.savedQueriesForDatabase(database).length;
      if (category.key === "backups")
          return $artifacts.backupTasksForDatabase(database).length;
      return objects.value[database]?.[category.key]?.length ?? "—";
  }

  function categorySelected(database: string, category: NavigatorCategory): boolean {
      if (!expandedDatabases.value.has(database) || selectedDatabase.value !== database)
          return false;
      if (isObjectCategory(category)) {
          return $queryTabs.activeTab.value?.kind === "objects" && $queryTabs.activeTab.value.database === database && $queryTabs.activeTab.value.category === category.key;
      }
      return $queryTabs.activeTab.value?.kind === "utility"
          && $queryTabs.activeTab.value.database === database
          && $queryTabs.activeTab.value.utilityCategory === category.key;
  }

  function navigatorTargetKey(target: DatabaseNavigatorTarget): string {
      if (target.kind === "database")
          return `database:${target.database}`;
      if (target.kind === "category")
          return `category:${target.database}:${target.category ?? ""}`;
      return `object:${target.database}:${target.category ?? ""}:${target.objectName ?? ""}`;
  }

  function objectCategoryLabel(item: DatabaseObject, fallback: ObjectCategoryDefinition): string {
      if (item.sourceCategory === "procedures")
          return tr("存储过程");
      if (item.sourceCategory === "functions")
          return tr("函数");
      return fallback.label;
  }

  function objectSelectionKey(tab: QueryTab): string {
      return `${tab.database}:${tab.category ?? ""}`;
  }

  function selectedObject(tab = $queryTabs.activeTab.value): DatabaseObject | null {
      if (!tab || tab.kind !== "objects" || !tab.category)
          return null;
      return selectedObjectInCategory(tab.database, tab.category);
  }

  function selectedObjectInCategory(database: string, category: BrowserCategory): DatabaseObject | null {
      const name = selectedObjects.value[`${database}:${category}`];
      return (objects.value[database]?.[category] ?? []).find((item) => item.name === name) ?? null;
  }

  function selectObject(tab: QueryTab, item: DatabaseObject) {
      selectedObjects.value = { ...selectedObjects.value, [objectSelectionKey(tab)]: item.name };
      selectedDatabase.value = tab.database;
      if (tab.category)
          navigatorTarget.value = `object:${tab.database}:${tab.category}:${item.name}`;
  }

  const informationTitle = computed(() => {
      if ($queryTabs.activeTab.value?.kind === "data")
          return $queryTabs.activeTab.value.table ?? tr("表");
      if ($queryTabs.activeTab.value?.kind === "objects")
          return selectedObject($queryTabs.activeTab.value)?.name ?? $queryTabs.activeTab.value.database;
      if ($queryTabs.activeTab.value?.kind === "utility")
          return $queryTabs.activeTab.value.utilityCategory === "queries" ? tr("查询") : tr("备份");
      if (selectedDatabase.value)
          return selectedDatabase.value;
      return $connections.selectedConnection.value?.name ?? tr("对象");
  });

  const informationSubtitle = computed(() => {
      if ($queryTabs.activeTab.value?.kind === "data")
          return tr("表 · {0}", [$queryTabs.activeTab.value.database]);
      if ($queryTabs.activeTab.value?.kind === "objects" && $queryTabs.activeTab.value.category)
          return `${categoryDefinition($queryTabs.activeTab.value.category).label} · ${$queryTabs.activeTab.value.database}`;
      if ($queryTabs.activeTab.value?.kind === "utility")
          return `${$queryTabs.activeTab.value.database} · ${$queryTabs.activeTab.value.utilityCategory === "queries" ? tr("查询") : tr("备份")}`;
      if (selectedDatabase.value)
          return tr("数据库 · {0}", [$connections.selectedConnection.value?.name ?? ""]);
      return $connections.selectedConnection.value ? tr("{0} · 连接", [$connections.selectedConnection.value.engine.toUpperCase()]) : tr("数据库工作台");
  });

  const informationRows = computed(() => {
      const connection = $connections.selectedConnection.value;
      const tab = $queryTabs.activeTab.value;
      if (tab?.kind === "data" && tab.table) {
          const item = (objects.value[tab.database]?.tables ?? []).find((candidate) => candidate.name === tab.table);
          return [
              [tr("数据库"), tab.database],
              [tr("类型"), tab.readOnly ? tr("视图") : tr("表")],
              [tr("行"), item?.rowCount?.toLocaleString(currentLocale()) ?? "—"],
              [tr("数据长度"), item?.dataSize !== undefined ? formatBytes(item.dataSize) : "—"],
              [tr("引擎"), item?.engine || "—"],
              [tr("排序规则"), item?.collation || "—"],
              [tr("注释"), item?.comment || "—"],
          ];
      }
      if (tab?.kind === "objects" && tab.category) {
          const item = selectedObject(tab);
          if (item)
              return [
                  [tr("数据库"), tab.database],
                  [tr("类型"), objectCategoryLabel(item, categoryDefinition(tab.category))],
                  [tr("引擎 / 状态"), item.engine || item.status || "—"],
                  [tr("关联对象"), item.tableName || item.event || "—"],
                  [tr("创建日期"), item.createdAt ? new Date(item.createdAt).toLocaleString(currentLocale()) : "—"],
                  [tr("修改日期"), item.updatedAt ? new Date(item.updatedAt).toLocaleString(currentLocale()) : "—"],
                  [tr("注释"), item.comment || "—"],
              ];
      }
      if (selectedDatabase.value) {
          const schema = schemas.value.find((item) => item.name === selectedDatabase.value);
          return [
              [tr("连接"), connection?.name || "—"],
              [tr("字符集"), schema?.charset || "—"],
              [tr("排序规则"), schema?.collation || "—"],
              [tr("主机"), connection ? `${connection.host}:${connection.port}` : "—"],
          ];
      }
      if (connection)
          return [
              [tr("类型"), connection.engine.toUpperCase()],
              [tr("主机"), connection.host],
              [tr("端口"), String(connection.port)],
              [tr("用户"), connection.username],
              [tr("连接方式"), connection.connectionMode],
              [tr("默认数据库"), connection.defaultDatabase || "—"],
          ];
      return [];
  });

  function visibleCategoryItems(database: string, category: NavigatorCategory): DatabaseObject[] {
      const items = categoryItems(database, category);
      const query = $connections.connectionSearch.value.trim().toLowerCase();
      if (!query)
          return items;
      return items.filter((item) => `${item.name} ${item.comment ?? ""}`.toLowerCase().includes(query));
  }

  async function refreshSchemas() {
      if (!$connections.selectedConnection.value || !$connections.databaseConnected.value)
          return ElMessage.warning(tr("数据库连接已断开，请先重新连接"));
      $connections.connecting.value = true;
      try {
          const response = await api<{
              items: SchemaItem[];
          }>(`/api/v1/database-connections/${$connections.selectedConnection.value.id}/schemas`);
          schemas.value = response.items;
          sqlCompletionCatalogs.value = {};
          const available = new Set(response.items.map((schema) => schema.name));
          expandedDatabases.value = new Set([...expandedDatabases.value].filter((database) => available.has(database)));
          if (selectedDatabase.value && !available.has(selectedDatabase.value))
              selectedDatabase.value = "";
          objects.value = {};
          expandedCategories.value = new Set();
          if (selectedDatabase.value && expandedDatabases.value.has(selectedDatabase.value))
              await loadDatabaseObjects(selectedDatabase.value);
          ElMessage.success(tr("数据库对象已刷新"));
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("刷新数据库对象失败"));
      }
      finally {
          $connections.connecting.value = false;
      }
  }

  async function loadDatabaseObjects(database: string, force = false) {
      if (objects.value[database] && !force)
          return;
      objectLoading.value = database;
      const categoryMap: Partial<Record<BrowserCategory, DatabaseObject[]>> = {};
      const sourceMap = new Map<ObjectCategory, DatabaseObject[]>();
      const sources = [...new Set(objectCategories.flatMap((category) => category.sources))];
      let failedCategories = 0;
      await Promise.all(sources.map(async (source) => {
          try {
              const response = await api<{
                  items: DatabaseObject[];
              }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/objects?database=${encodeURIComponent(database)}&category=${source}`);
              sourceMap.set(source, response.items.map((item) => ({ ...item, sourceCategory: source })));
          }
          catch {
              failedCategories += 1;
              sourceMap.set(source, []);
          }
      }));
      for (const category of objectCategories) {
          categoryMap[category.key] = category.sources.flatMap((source) => sourceMap.get(source) ?? []);
      }
      objects.value = { ...objects.value, [database]: categoryMap };
      if (force) {
          const nextCatalogs = { ...sqlCompletionCatalogs.value };
          delete nextCatalogs[database];
          sqlCompletionCatalogs.value = nextCatalogs;
          if ($queryTabs.activeTab.value?.kind === "sql" && $queryTabs.activeTab.value.database === database)
              void loadSqlCompletionCatalog(database);
      }
      objectLoading.value = "";
      if (failedCategories === sources.length)
          ElMessage.warning(tr("无法读取 {0} 的数据库对象", [database]));
  }

  async function loadSqlCompletionCatalog(database: string, force = false) {
      if (!database || !$connections.selectedConnectionId.value || !$connections.databaseConnected.value)
          return;
      if (sqlCompletionCatalogs.value[database] && !force)
          return;
      const connectionId = $connections.selectedConnectionId.value;
      const loadingKey = `${connectionId}\0${database}`;
      if (sqlCompletionLoading.has(loadingKey))
          return;
      sqlCompletionLoading.add(loadingKey);
      try {
          const catalog = await api<SqlCompletionCatalog>(`/api/v1/database-connections/${connectionId}/completion-metadata?database=${encodeURIComponent(database)}`);
          if ($connections.selectedConnectionId.value === connectionId)
              sqlCompletionCatalogs.value = { ...sqlCompletionCatalogs.value, [database]: catalog };
      }
      catch {
          // SQL editing remains available when metadata cannot be read.
      }
      finally {
          sqlCompletionLoading.delete(loadingKey);
      }
  }

  function selectDatabaseNode(database: string) {
      selectedDatabase.value = database;
  }

  async function toggleDatabase(database: string, forceOpen = false) {
      const next = new Set(expandedDatabases.value);
      if (next.has(database) && !forceOpen) {
          next.delete(database);
          expandedDatabases.value = next;
          if (selectedDatabase.value === database)
              selectedDatabase.value = "";
          return;
      }
      next.add(database);
      expandedDatabases.value = next;
      selectedDatabase.value = database;
      await loadDatabaseObjects(database);
  }

  function objectFavorite(targetType: "database" | "table", database: string, table = "") {
      return objectFavorites.value.find((item) => (item.connectionId === $connections.selectedConnectionId.value
          && item.targetType === targetType
          && item.database === database
          && item.table === (targetType === "table" ? table : "")));
  }

  async function loadObjectFavorites() {
      const response = await api<{
          items: ObjectFavoriteItem[];
      }>("/api/v1/database-object-favorites");
      objectFavorites.value = response.items;
  }

  async function loadObjectGroups() {
      if (!$connections.selectedConnectionId.value) {
          objectGroups.value = [];
          return;
      }
      const response = await api<{
          items: ObjectGroupItem[];
      }>(`/api/v1/database-object-groups?connectionId=${encodeURIComponent($connections.selectedConnectionId.value)}`);
      objectGroups.value = response.items;
  }

  function objectGroup(database: string, category: NavigatorCategoryKey, item: DatabaseObject | {
      name: string;
      sourceCategory?: string;
  }) {
      return objectGroups.value.find((group) => group.database === database && group.category === category && group.members.some((member) => member.objectName === item.name && member.objectSource === (item.sourceCategory || "")));
  }

  async function createObjectGroup(target: DatabaseNavigatorTarget): Promise<ObjectGroupItem | null> {
      if (!$connections.selectedConnectionId.value || !target.category)
          return null;
      try {
          const response = await ElMessageBox.prompt(tr("请输入对象组名称"), tr("新建组"), { confirmButtonText: tr("新建"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入组名称") });
          const name = response.value.trim();
          const existing = objectGroups.value.find((group) => group.database === target.database && group.category === target.category && group.name === name);
          if (existing)
              return existing;
          await api("/api/v1/database-object-groups", { method: "POST", body: JSON.stringify({ connectionId: $connections.selectedConnectionId.value, database: target.database, category: target.category, name }) });
          await loadObjectGroups();
          return objectGroups.value.find((group) => group.database === target.database && group.category === target.category && group.name === name) ?? null;
      }
      catch (error) {
          if (error !== "cancel" && error !== "close")
              ElMessage.error(error instanceof Error ? error.message : tr("新建对象组失败"));
          return null;
      }
  }

  async function addNavigatorObjectToGroup(target: DatabaseNavigatorTarget) {
      if (!target.category || !target.objectName)
          return;
      const candidates = objectGroups.value.filter((group) => group.database === target.database && group.category === target.category);
      let group: ObjectGroupItem | null = null;
      try {
          const response = await ElMessageBox.prompt(candidates.length ? tr("请输入目标组名称。可选：{0}", [candidates.map((item) => item.name).join("、")]) : tr("当前分类没有对象组，输入名称将新建组。"), tr("添加到组"), { confirmButtonText: tr("添加"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入组名称") });
          const name = response.value.trim();
          group = candidates.find((item) => item.name === name) ?? null;
          if (!group) {
              await api("/api/v1/database-object-groups", { method: "POST", body: JSON.stringify({ connectionId: $connections.selectedConnectionId.value, database: target.database, category: target.category, name }) });
              await loadObjectGroups();
              group = objectGroups.value.find((item) => item.database === target.database && item.category === target.category && item.name === name) ?? null;
          }
          if (!group)
              throw new Error(tr("对象组不存在"));
          await api(`/api/v1/database-object-groups/${group.id}/members`, { method: "POST", body: JSON.stringify({ objectName: target.objectName, objectSource: target.objectSource || "" }) });
          await loadObjectGroups();
          ElMessage.success(tr("已添加到组 {0}", [group.name]));
      }
      catch (error) {
          if (error !== "cancel" && error !== "close")
              ElMessage.error(error instanceof Error ? error.message : tr("添加对象组失败"));
      }
  }

  async function excludeNavigatorObjectFromGroup(target: DatabaseNavigatorTarget) {
      if (!target.category || !target.objectName)
          return;
      const group = objectGroups.value.find((item) => item.database === target.database && item.category === target.category && item.members.some((member) => member.objectName === target.objectName && member.objectSource === (target.objectSource || "")));
      if (!group)
          return ElMessage.warning(tr("当前对象不属于任何组"));
      const query = new URLSearchParams({ objectName: target.objectName, objectSource: target.objectSource || "" });
      await api(`/api/v1/database-object-groups/${group.id}/members?${query}`, { method: "DELETE" });
      await loadObjectGroups();
      ElMessage.success(tr("已从组 {0} 中排除", [group.name]));
  }

  async function toggleObjectFavorite(targetType: "database" | "table", database: string, table = "") {
      if (!$connections.selectedConnectionId.value)
          return;
      const existing = objectFavorite(targetType, database, table);
      try {
          if (existing) {
              await api(`/api/v1/database-object-favorites/${existing.id}`, { method: "DELETE" });
              ElMessage.success(targetType === "table" ? tr("已取消收藏数据表") : tr("已取消收藏数据库"));
          }
          else {
              await api("/api/v1/database-object-favorites", {
                  method: "POST",
                  body: JSON.stringify({ connectionId: $connections.selectedConnectionId.value, targetType, database, table }),
              });
              ElMessage.success(targetType === "table" ? tr("数据表已收藏") : tr("数据库已收藏"));
          }
          await loadObjectFavorites();
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("更新数据库收藏失败"));
      }
  }

  async function removeObjectFavorite(item: ObjectFavoriteItem) {
      try {
          await api(`/api/v1/database-object-favorites/${item.id}`, { method: "DELETE" });
          await loadObjectFavorites();
          ElMessage.success(item.targetType === "table" ? tr("已取消收藏数据表") : tr("已取消收藏数据库"));
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("取消数据库收藏失败"));
      }
  }

  async function openObjectFavorite(item: ObjectFavoriteItem) {
      const connection = $connections.connections.value.find((candidate) => candidate.id === item.connectionId);
      if (!connection)
          return ElMessage.warning(tr("当前工作台无法访问该收藏连接"));
      const connected = ($connections.selectedConnectionId.value === connection.id && $connections.databaseConnected.value) || await $connections.selectConnection(connection);
      if (!connected)
          return;
      const schemaExists = schemas.value.some((schema) => schema.name === item.database);
      if (!schemaExists)
          return ElMessage.warning(tr("数据库 {0} 不存在或当前账号无权访问", [item.database]));
      await toggleDatabase(item.database, true);
      if (item.targetType === "table") {
          const tableExists = (objects.value[item.database]?.tables ?? []).some((table) => table.name === item.table);
          if (!tableExists)
              return ElMessage.warning(tr("数据表 {0}.{1} 不存在或当前账号无权访问", [item.database, item.table]));
          const nextCategories = new Set(expandedCategories.value);
          nextCategories.add(categoryKey(item.database, "tables"));
          expandedCategories.value = nextCategories;
          $queryTabs.newDataTab(item.database, item.table, false);
          navigatorTarget.value = `object:${item.database}:tables:${item.table}`;
      }
      else {
          await openCategory(item.database, objectCategories[0]);
          navigatorTarget.value = `database:${item.database}`;
      }
      await nextTick();
      const target = [...($layout.workbenchElement.value?.querySelectorAll<HTMLElement>("[data-navigator-target]") ?? [])]
          .find((element) => element.dataset.navigatorTarget === navigatorTarget.value);
      target?.scrollIntoView({ block: "center" });
  }

  async function openCategory(database: string, category: NavigatorCategory) {
      selectedDatabase.value = database;
      if (category.key === "queries") {
          $queryTabs.taskPanel.value = false;
          $artifacts.sidePanel.value = "";
          await $artifacts.loadSavedQueries();
          $queryTabs.newUtilityTab(database, "queries");
          return;
      }
      if (category.key === "backups") {
          $artifacts.sidePanel.value = "";
          $queryTabs.taskPanel.value = false;
          await $artifacts.loadDatabaseTasks();
          $queryTabs.newUtilityTab(database, "backups");
          return;
      }
      await loadDatabaseObjects(database);
      $queryTabs.newObjectTab(database, category);
  }

  async function toggleCategory(database: string, category: NavigatorCategory) {
      const key = categoryKey(database, category.key);
      const next = new Set(expandedCategories.value);
      if (next.has(key))
          next.delete(key);
      else {
          next.add(key);
          if (isObjectCategory(category))
              await loadDatabaseObjects(database);
          else if (category.key === "queries")
              await $artifacts.loadSavedQueries();
          else
              await $artifacts.loadDatabaseTasks();
      }
      expandedCategories.value = next;
  }

  async function openNavigatorObject(database: string, category: NavigatorCategory, item: DatabaseObject) {
      if (isObjectCategory(category))
          await openObject(database, category, item);
  }

  function selectNavigatorObject(database: string, category: NavigatorCategory, item: DatabaseObject) {
      if (!isObjectCategory(category))
          return;
      selectedDatabase.value = database;
      navigatorTarget.value = `object:${database}:${category.key}:${item.name}`;
      selectedObjects.value = { ...selectedObjects.value, [`${database}:${category.key}`]: item.name };
      const objectTab = $queryTabs.tabs.value.find((tab) => tab.kind === "objects");
      if (objectTab) {
          objectTab.database = database;
          objectTab.category = category.key;
          objectTab.title = tr("对象");
      }
  }

  async function showNavigatorDdl(database: string, category: NavigatorCategory, item: DatabaseObject) {
      if (isObjectCategory(category))
          await showDdl(database, category, item);
  }

  async function refreshObjectCategory(tab: QueryTab) {
      if (!tab.category)
          return;
      await loadDatabaseObjects(tab.database, true);
  }

  function selectedCategoryContext() {
      const tab = $queryTabs.activeTab.value;
      if (!tab || tab.kind !== "objects" || !tab.category)
          return null;
      return { tab, category: categoryDefinition(tab.category), item: selectedObject(tab) };
  }

  function selectedTableContext() {
      const activeContext = selectedCategoryContext();
      if (activeContext?.tab.category === "tables" && activeContext.item) {
          return { database: activeContext.tab.database, item: activeContext.item };
      }
      const database = selectedDatabase.value || $queryTabs.activeTab.value?.database || "";
      const item = database ? selectedObjectInCategory(database, "tables") : null;
      return item ? { database, item } : null;
  }

  function currentTableContext() {
      const tab = $queryTabs.activeTab.value;
      if (tab?.kind === "data" && tab.table && !tab.readOnly) {
          const item = (objects.value[tab.database]?.tables ?? []).find((candidate) => candidate.name === tab.table) ?? { name: tab.table };
          return { database: tab.database, item };
      }
      return selectedTableContext();
  }

  async function openSelectedObject() {
      const context = selectedCategoryContext();
      if (!context?.item)
          return ElMessage.warning(tr("请先选择一个对象"));
      await openObject(context.tab.database, context.category, context.item);
  }

  async function designSelectedObject() {
      const context = selectedCategoryContext();
      if (!context?.item)
          return ElMessage.warning(tr("请先选择一个对象"));
      if (context.category.key === "tables")
          $queryTabs.newTableDesigner(context.tab.database, context.item.name);
      else
          await showDdl(context.tab.database, context.category, context.item);
  }

  function designSelectedTable() {
      const context = selectedTableContext();
      if (!context)
          return ElMessage.warning(tr("请先选择一个表"));
      $queryTabs.newTableDesigner(context.database, context.item.name);
  }

  function designCurrentTable() {
      const context = currentTableContext();
      if (!context)
          return ElMessage.warning(tr("请先打开或选择一个表"));
      $queryTabs.newTableDesigner(context.database, context.item.name);
  }

  function createObjectTemplate(databaseName?: string, categoryKeyValue?: BrowserCategory) {
      const context = selectedCategoryContext();
      const targetDatabase = databaseName ?? context?.tab.database;
      const targetCategory = categoryKeyValue ?? context?.tab.category;
      if (!targetDatabase || !targetCategory)
          return;
      if (targetCategory === "tables") {
          $queryTabs.newTableDesigner(targetDatabase);
          return;
      }
      const database = sqlIdentifier(targetDatabase);
      const templates: Record<BrowserCategory, string> = {
          tables: "",
          views: `CREATE VIEW ${database}.\`new_view\` AS\nSELECT 1 AS value;`,
          functions: `DELIMITER //\nCREATE FUNCTION ${database}.\`new_function\`() RETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN 1;\nEND //\nDELIMITER ;`,
          events: `CREATE EVENT ${database}.\`new_event\`\nON SCHEDULE EVERY 1 DAY\nDO SELECT 1;`,
      };
      $queryTabs.newTab(templates[targetCategory], targetDatabase, tr("新建{0}", [categoryDefinition(targetCategory).label]));
  }

  async function deleteObject(database: string, category: ObjectCategoryDefinition, item: DatabaseObject) {
      if (!$connections.selectedConnectionId.value)
          return ElMessage.warning(tr("请先连接数据库"));
      const objectType: Record<ObjectCategory, string> = {
          tables: "TABLE",
          views: "VIEW",
          procedures: "PROCEDURE",
          functions: "FUNCTION",
          triggers: "TRIGGER",
          events: "EVENT",
      };
      try {
          await ElMessageBox.confirm(tr("确定删除 {0}“{1}”吗？该操作会立即写入数据库且不可撤销。", [objectCategoryLabel(item, category), item.name]), tr("删除{0}", [objectCategoryLabel(item, category)]), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "error" });
          objectLoading.value = database;
          const response = await api<{
              job: QueryJob;
          }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/queries`, {
              method: "POST",
              body: JSON.stringify({
                  sql: `DROP ${objectType[item.sourceCategory ?? category.key]} ${sqlIdentifier(database)}.${sqlIdentifier(item.name)}`,
                  database,
              }),
          });
          const job = await $queryTabs.waitForQueryJob(response.job.id);
          if (job.status !== "success")
              throw new Error(job.error || tr("删除{0}失败", [category.label]));
          $queryTabs.tabs.value = $queryTabs.tabs.value.filter((tab) => !(tab.kind === "data" && tab.database === database && tab.table === item.name));
          selectedObjects.value = { ...selectedObjects.value, [`${database}:${category.key}`]: "" };
          await loadDatabaseObjects(database, true);
          ElMessage.success(tr("{0}已删除", [objectCategoryLabel(item, category)]));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("删除{0}失败", [category.label]));
      }
      finally {
          objectLoading.value = "";
      }
  }

  async function deleteSelectedObject() {
      const context = selectedCategoryContext();
      if (!context?.item)
          return ElMessage.warning(tr("请先选择要删除的对象"));
      await deleteObject(context.tab.database, context.category, context.item);
  }

  function clearDatabaseLocalState(database: string) {
      delete objects.value[database];
      delete sqlCompletionCatalogs.value[database];
      selectedObjects.value = Object.fromEntries(Object.entries(selectedObjects.value).filter(([key]) => !key.startsWith(`${database}:`)));
      $artifacts.selectedUtilityItems.value = Object.fromEntries(Object.entries($artifacts.selectedUtilityItems.value).filter(([key]) => !key.startsWith(`${database}:`)));
      expandedCategories.value = new Set([...expandedCategories.value].filter((key) => !key.startsWith(`${database}:`)));
      $artifacts.databaseTasks.value = $artifacts.databaseTasks.value.filter((task) => task.details.database !== database && task.details.sourceDatabase !== database && task.details.targetDatabase !== database);
  }

  async function openGlobalCategory(key: BrowserCategory | UtilityCategory) {
      const database = $queryTabs.requireSelectedDatabase();
      if (!database)
          return;
      const category = categories.find((item) => item.key === key);
      if (category)
          await openCategory(database, category);
  }

  function handleGlobalTableCommand(command: string) {
      const database = $queryTabs.requireSelectedDatabase();
      if (!database)
          return;
      if (command === "open")
          void openGlobalCategory("tables");
      else if (command === "new")
          createObjectTemplate(database, "tables");
      else if (command === "design")
          designSelectedTable();
      else if (command === "import")
          $queryTabs.triggerSelectedTableAction("import");
      else if (["csv", "xlsx", "sql"].includes(command))
          $queryTabs.triggerSelectedTableAction("export", command as "csv" | "xlsx" | "sql");
  }

  async function loadInformationDdl() {
      $layout.informationPaneTab.value = "ddl";
      informationDdl.value = "";
      const tab = $queryTabs.activeTab.value;
      if (tab?.kind === "sql") {
          informationDdl.value = tab.sql || tr("-- 当前查询为空");
          return;
      }
      if (!$connections.selectedConnectionId.value || !$connections.databaseConnected.value)
          return;
      let database = tab?.database || selectedDatabase.value;
      let type = "";
      let name = "";
      if (tab?.kind === "data" && tab.table) {
          type = tab.readOnly ? "view" : "table";
          name = tab.table;
      }
      else if (tab?.kind === "objects" && tab.category) {
          const item = selectedObject(tab);
          if (item) {
              type = item.sourceCategory === "procedures" ? "procedure" : item.sourceCategory === "functions" ? "function" : categoryDefinition(tab.category).singular;
              name = item.name;
          }
      }
      if (!database || !type || !name) {
          informationDdl.value = database ? `SHOW CREATE DATABASE ${sqlIdentifier(database)};` : tr("-- 选择数据库对象后查看 DDL");
          return;
      }
      informationLoading.value = true;
      try {
          const response = await api<{
              ddl: string;
          }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/ddl?database=${encodeURIComponent(database)}&type=${type}&name=${encodeURIComponent(name)}`);
          informationDdl.value = response.ddl ? `${response.ddl};` : tr("-- 未返回 DDL");
      }
      catch (error) {
          informationDdl.value = `-- ${error instanceof Error ? error.message : tr("读取 DDL 失败")}`;
      }
      finally {
          informationLoading.value = false;
      }
  }

  function openDatabaseDictionary(database: string) {
      $queryTabs.newTab(`SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = ${JSON.stringify(database)}\nORDER BY TABLE_TYPE, TABLE_NAME;`, database, tr("数据字典 · {0}", [database]));
  }

  function openTableDictionary(database: string, table: string) {
      $queryTabs.newTab(`SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT\nFROM information_schema.COLUMNS\nWHERE TABLE_SCHEMA = ${JSON.stringify(database)} AND TABLE_NAME = ${JSON.stringify(table)}\nORDER BY ORDINAL_POSITION;`, database, tr("数据字典 · {0}", [table]));
  }

  function closeDatabase(database: string) {
      const next = new Set(expandedDatabases.value);
      next.delete(database);
      expandedDatabases.value = next;
      $queryTabs.removeTabsForDatabase(database);
      clearDatabaseLocalState(database);
      if (selectedDatabase.value === database) {
          selectedDatabase.value = "";
          navigatorTarget.value = "";
          $queryTabs.taskPanel.value = false;
          $artifacts.sidePanel.value = "";
      }
  }

  function editDatabaseTemplate(database: string) {
      const schema = schemas.value.find((candidate) => candidate.name === database);
      const charset = schema?.charset ? ` CHARACTER SET ${schema.charset}` : "";
      const collation = schema?.collation ? ` COLLATE ${schema.collation}` : "";
      $queryTabs.newTab(`ALTER DATABASE ${sqlIdentifier(database)}${charset}${collation};`, database, tr("编辑数据库 · {0}", [database]));
  }

  function createDatabaseTemplate(database: string) {
      const schema = schemas.value.find((candidate) => candidate.name === database);
      const charset = schema?.charset ? `\n  CHARACTER SET ${schema.charset}` : "";
      const collation = schema?.collation ? `\n  COLLATE ${schema.collation}` : "";
      $queryTabs.newTab(`CREATE DATABASE \`new_database\`${charset}${collation};`, "", tr("新建数据库"));
  }

  async function deleteDatabase(database: string) {
      if (!$connections.selectedConnectionId.value)
          return;
      if (["information_schema", "mysql", "performance_schema", "sys"].includes(database.toLowerCase())) {
          return ElMessage.warning(tr("系统数据库不能通过 Viron 删除"));
      }
      try {
          await ElMessageBox.confirm(tr("确定删除数据库“{0}”及其中全部对象和数据吗？该操作不可撤销。", [database]), tr("删除数据库"), { confirmButtonText: tr("删除数据库"), cancelButtonText: tr("取消"), type: "error" });
          const response = await api<{
              job: QueryJob;
          }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/queries`, {
              method: "POST",
              body: JSON.stringify({ sql: `DROP DATABASE ${sqlIdentifier(database)}`, database: "" }),
          });
          const job = await $queryTabs.waitForQueryJob(response.job.id);
          if (job.status !== "success")
              throw new Error(job.error || tr("删除数据库失败"));
          closeDatabase(database);
          await refreshSchemas();
          ElMessage.success(tr("数据库 {0} 已删除", [database]));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("删除数据库失败"));
      }
  }

  async function dumpTableStructure(target: DatabaseNavigatorTarget) {
      const item = await chooseNavigatorObject(target, "tables");
      if (!item || !$connections.selectedConnectionId.value)
          return;
      try {
          await downloadApiFile(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/table-export?database=${encodeURIComponent(target.database)}&table=${encodeURIComponent(item.name)}&format=sql&includeData=false`, `${target.database}.${item.name}.structure.sql`);
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("导出数据表结构失败"));
      }
  }

  async function reverseNavigatorTarget(target: DatabaseNavigatorTarget) {
      const modelTab = $queryTabs.newArtifactTab("model");
      modelTab.database = target.database;
      await nextTick();
      if (target.kind === "database")
          await $artifacts.modelWorkspace.value?.reverseDatabase(target.database);
      else if (target.objectName && target.category)
          await $artifacts.modelWorkspace.value?.reverseObject(target.database, target.category, target.objectName);
  }

  async function createBiWorkspaceFromTarget(target: DatabaseNavigatorTarget) {
      if (!target.objectName || !target.category)
          return;
      const biTab = $queryTabs.newArtifactTab("bi");
      biTab.database = target.database;
      await nextTick();
      $artifacts.biWorkspace.value?.createFromObject(target.database, target.category, target.objectName);
  }

  function openObjectPrivileges(target: DatabaseNavigatorTarget) {
      const object = navigatorObject(target);
      if (!object)
          return;
      const objectType = object.category.key === "tables"
          ? "table"
          : object.category.key === "views"
              ? "view"
              : object.item.sourceCategory === "procedures" ? "procedure" : "function";
      objectPrivilege.value = { visible: true, database: target.database, objectName: object.item.name, objectType };
  }

  async function openDatabaseSearch(database: string) {
      await loadDatabaseObjects(database);
      databaseSearchDatabase.value = database;
      databaseSearchQuery.value = "";
      databaseSearchSelection.value = "";
      databaseSearchOpen.value = true;
      await nextTick();
      databaseSearchContainer.value?.querySelector<HTMLInputElement>("input")?.focus();
  }

  async function openDatabaseSearchResult(result?: DatabaseSearchResult) {
      const selected = result ?? databaseSearchResults.value.find((candidate) => candidate.key === databaseSearchSelection.value);
      if (!selected)
          return ElMessage.warning(tr("请选择一个数据库对象"));
      databaseSearchOpen.value = false;
      await openObject(databaseSearchDatabase.value, categoryDefinition(selected.category), selected.item);
  }

  function navigatorObject(target: DatabaseNavigatorTarget): {
      category: ObjectCategoryDefinition;
      item: DatabaseObject;
  } | null {
      if (target.kind !== "object" || !target.category || ["queries", "backups"].includes(target.category))
          return null;
      const category = categoryDefinition(target.category as BrowserCategory);
      const item = (objects.value[target.database]?.[category.key] ?? []).find((candidate) => (candidate.name === target.objectName
          && (!target.objectSource || candidate.sourceCategory === target.objectSource)));
      return item ? { category, item } : null;
  }

  async function chooseNavigatorObject(target: DatabaseNavigatorTarget, category: BrowserCategory): Promise<DatabaseObject | null> {
      const direct = navigatorObject(target);
      if (direct?.category.key === category)
          return direct.item;
      await loadDatabaseObjects(target.database);
      const candidates = objects.value[target.database]?.[category] ?? [];
      if (!candidates.length) {
          ElMessage.warning(tr("当前数据库没有可用的{0}", [categoryDefinition(category).label]));
          return null;
      }
      try {
          const response = await ElMessageBox.prompt(tr("请输入目标{0}名称。可选：{1}{2}", [categoryDefinition(category).label, candidates.slice(0, 8).map((item) => item.name).join("、"), candidates.length > 8 ? "…" : ""]), tr("选择{0}", [categoryDefinition(category).label]), {
              confirmButtonText: tr("继续"),
              cancelButtonText: tr("取消"),
              inputPlaceholder: candidates[0].name,
              inputValidator: (value) => candidates.some((item) => item.name === value.trim()) || tr("请输入当前分类中存在的对象名称"),
          });
          return candidates.find((item) => item.name === response.value.trim()) ?? null;
      }
      catch (error) {
          if (error !== "cancel" && error !== "close")
              ElMessage.error(error instanceof Error ? error.message : tr("无法选择数据库对象"));
          return null;
      }
  }

  async function openTableWizard(target: DatabaseNavigatorTarget, type: "import" | "export", format?: "csv" | "xlsx" | "sql") {
      const category: BrowserCategory = target.category === "views" ? "views" : "tables";
      const item = await chooseNavigatorObject(target, category);
      if (!item)
          return;
      const tab = $queryTabs.newDataTab(target.database, item.name, category === "views");
      tab.tableAction = { id: createClientId(), type, format };
  }

  async function duplicateObjectDraft(target: DatabaseNavigatorTarget) {
      const object = navigatorObject(target);
      if (!object)
          return ElMessage.warning(tr("数据库对象已经变化，请刷新后重试"));
      if (object.category.key === "tables")
          return;
      await showDdl(target.database, object.category, object.item);
      if ($queryTabs.activeTab.value?.kind === "sql") {
          $queryTabs.activeTab.value.title = tr("复制{0} · {1}", [objectCategoryLabel(object.item, object.category), object.item.name]);
          $queryTabs.activeTab.value.sql = tr("-- 将对象名称修改为新名称后执行\n{0}", [$queryTabs.activeTab.value.sql]);
      }
  }

  async function fetchObjectDdl(database: string, category: ObjectCategoryDefinition, item: DatabaseObject): Promise<string> {
      const singular = item.sourceCategory === "procedures" ? "procedure" : item.sourceCategory === "functions" ? "function" : category.singular;
      const response = await api<{
          ddl: string;
      }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/ddl?database=${encodeURIComponent(database)}&type=${singular}&name=${encodeURIComponent(item.name)}`);
      if (!response.ddl)
          throw new Error(tr("无法读取 {0} 的 DDL", [item.name]));
      return response.ddl;
  }

  function rewriteCreateObjectName(ddl: string, sourceCategory: ObjectCategory, database: string, newName: string): string {
      const keyword = sourceCategory === "procedures" ? "PROCEDURE" : sourceCategory === "functions" ? "FUNCTION" : sourceCategory === "events" ? "EVENT" : sourceCategory === "views" ? "VIEW" : "TABLE";
      const objectPattern = /(?:`(?:``|[^`])+`\.)?`(?:``|[^`])+`/;
      const pattern = new RegExp(`(\\b${keyword}\\s+)${objectPattern.source}`, "i");
      const replacement = `$1${sqlIdentifier(database)}.${sqlIdentifier(newName)}`;
      const rewritten = ddl.replace(pattern, replacement);
      if (rewritten === ddl)
          throw new Error(tr("无法在 {0} DDL 中定位对象名称", [keyword]));
      return rewritten.replace(/;+\s*$/, "");
  }

  async function copyNavigatorObject(target: DatabaseNavigatorTarget) {
      const object = navigatorObject(target);
      if (!object)
          return ElMessage.warning(tr("请先选择数据库对象"));
      try {
          const ddl = await fetchObjectDdl(target.database, object.category, object.item);
          navigatorObjectClipboard.value = {
              database: target.database,
              category: object.category.key,
              sourceCategory: object.item.sourceCategory ?? object.category.key,
              name: object.item.name,
              ddl,
          };
          await navigator.clipboard.writeText(ddl).catch(() => undefined);
          ElMessage.success(tr("已复制 {0}", [object.item.name]));
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("复制数据库对象失败"));
      }
  }

  async function pasteNavigatorObject(target: DatabaseNavigatorTarget) {
      const copied = navigatorObjectClipboard.value;
      if (!copied || copied.category !== target.category)
          return ElMessage.warning(tr("请先复制同类数据库对象"));
      try {
          const response = await ElMessageBox.prompt(tr("请输入新对象名称"), tr("粘贴数据库对象"), {
              confirmButtonText: tr("创建"),
              cancelButtonText: tr("取消"),
              inputValue: `${copied.name}_copy`,
              inputValidator: (value) => /^[^`\u0000-\u001f]{1,64}$/.test(value.trim()) || tr("名称需为 1–64 个有效字符"),
          });
          const name = response.value.trim();
          const sql = rewriteCreateObjectName(copied.ddl, copied.sourceCategory, target.database, name);
          const tab = $queryTabs.newTab(`${sql};`, target.database, tr("粘贴{0} · {1}", [categoryDefinition(copied.category).label, name]));
          await $queryTabs.executeDatabaseStatement(sql, target.database);
          tab.job = { id: "", status: "success", resultSets: [] };
          await loadDatabaseObjects(target.database, true);
          ElMessage.success(tr("{0} 已创建", [name]));
      }
      catch (error) {
          if (error !== "cancel" && error !== "close")
              ElMessage.error(error instanceof Error ? error.message : tr("粘贴数据库对象失败"));
      }
  }

  function duplicateTableDraft(target: DatabaseNavigatorTarget, includeData: boolean) {
      const object = navigatorObject(target);
      if (!object || object.category.key !== "tables")
          return ElMessage.warning(tr("请先右键具体数据表"));
      const source = `${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}`;
      const copy = `${sqlIdentifier(target.database)}.${sqlIdentifier(`${object.item.name}_copy`)}`;
      $queryTabs.newTab(`CREATE TABLE ${copy} LIKE ${source};${includeData ? `\nINSERT INTO ${copy} SELECT * FROM ${source};` : ""}`, target.database, tr("复制表 · {0}", [object.item.name]));
  }

  function tableMutationDraft(target: DatabaseNavigatorTarget, operation: TableMaintenanceOperation, item: DatabaseObject) {
      const table = `${sqlIdentifier(target.database)}.${sqlIdentifier(item.name)}`;
      const statements = {
          empty: tr("-- DELETE 会逐行删除数据并保留自增计数；执行前请再次确认\nDELETE FROM {0};", [table]),
          truncate: tr("-- TRUNCATE 会立即清空数据并重置自增计数；执行前请再次确认\nTRUNCATE TABLE {0};", [table]),
          analyze: `ANALYZE TABLE ${table};`,
          check: `CHECK TABLE ${table};`,
          checkQuick: `CHECK TABLE ${table} QUICK;`,
          checkFast: `CHECK TABLE ${table} FAST;`,
          checkChanged: `CHECK TABLE ${table} CHANGED;`,
          checkExtended: `CHECK TABLE ${table} EXTENDED;`,
          optimize: `OPTIMIZE TABLE ${table};`,
          repairQuick: `REPAIR TABLE ${table} QUICK;`,
          repairExtended: `REPAIR TABLE ${table} EXTENDED;`,
      };
      const titles: Record<TableMaintenanceOperation, string> = {
          empty: tr("清空"),
          truncate: tr("截断"),
          analyze: tr("分析"),
          check: tr("检查"),
          checkQuick: tr("快速检查"),
          checkFast: tr("快速检查"),
          checkChanged: tr("更改检查"),
          checkExtended: tr("扩展检查"),
          optimize: tr("优化"),
          repairQuick: tr("快速修复"),
          repairExtended: tr("扩展修复"),
      };
      $queryTabs.newTab(statements[operation], target.database, tr("{0}表 · {1}", [titles[operation], item.name]));
  }

  async function renameObjectDraft(target: DatabaseNavigatorTarget) {
      const object = navigatorObject(target);
      if (!object)
          return ElMessage.warning(tr("当前对象不支持重命名"));
      try {
          const response = await ElMessageBox.prompt(tr("请输入“{0}”的新名称", [object.item.name]), tr("重命名{0}", [object.category.label]), {
              confirmButtonText: tr("重命名"),
              cancelButtonText: tr("取消"),
              inputValue: object.item.name,
              inputValidator: (value) => /^[^`\u0000-\u001f]{1,64}$/.test(value.trim()) || tr("名称需为 1–64 个有效字符"),
          });
          const newName = response.value.trim();
          if (newName === object.item.name)
              return;
          const from = `${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}`;
          const to = `${sqlIdentifier(target.database)}.${sqlIdentifier(newName)}`;
          let sql = "";
          if (["tables", "views"].includes(object.category.key))
              sql = `RENAME TABLE ${from} TO ${to}`;
          else if (object.item.sourceCategory === "events")
              sql = `ALTER EVENT ${from} RENAME TO ${to}`;
          else {
              const ddl = await fetchObjectDdl(target.database, object.category, object.item);
              const sourceCategory = object.item.sourceCategory ?? "functions";
              const createSql = rewriteCreateObjectName(ddl, sourceCategory, target.database, newName);
              await $queryTabs.executeDatabaseStatement(createSql, target.database);
              const type = sourceCategory === "procedures" ? "PROCEDURE" : "FUNCTION";
              sql = `DROP ${type} ${from}`;
          }
          const tab = $queryTabs.newTab(`${sql};`, target.database, tr("重命名{0} · {1}", [object.category.label, object.item.name]));
          await $queryTabs.executeDatabaseStatement(sql, target.database);
          tab.job = { id: "", status: "success", resultSets: [] };
          await loadDatabaseObjects(target.database, true);
          ElMessage.success(tr("{0} 已重命名为 {1}", [object.item.name, newName]));
      }
      catch (error) {
          if (error !== "cancel" && error !== "close")
              ElMessage.error(error instanceof Error ? error.message : tr("重命名数据库对象失败"));
      }
  }

  function openNavigatorContextMenu(event: MouseEvent, target: DatabaseNavigatorTarget) {
      event.preventDefault();
      event.stopPropagation();
      selectedDatabase.value = target.database;
      navigatorTarget.value = navigatorTargetKey(target);
      if (target.kind === "object" && target.category && !["queries", "backups"].includes(target.category)) {
          selectedObjects.value = { ...selectedObjects.value, [`${target.database}:${target.category}`]: target.objectName ?? "" };
      }
      navigatorMenu.value = { visible: false, x: event.clientX, y: event.clientY, target };
      void nextTick(() => {
          navigatorMenu.value = { visible: true, x: event.clientX, y: event.clientY, target };
      });
  }

  async function showDdl(database: string, category: ObjectCategoryDefinition, item: DatabaseObject) {
      if (!$connections.databaseConnected.value)
          return ElMessage.warning(tr("数据库连接已断开，请先重新连接"));
      try {
          const singular = item.sourceCategory === "procedures" ? "procedure" : item.sourceCategory === "functions" ? "function" : category.singular;
          const response = await api<{
              ddl: string;
          }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/ddl?database=${encodeURIComponent(database)}&type=${singular}&name=${encodeURIComponent(item.name)}`);
          $queryTabs.newTab(response.ddl ? `${response.ddl};` : tr("-- 无法获取 {0} 的 DDL", [item.name]), database, `DDL · ${item.name}`);
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("读取 DDL 失败"));
      }
  }

  async function openObject(database: string, category: ObjectCategoryDefinition, item: DatabaseObject) {
      selectedDatabase.value = database;
      if (category.key === "tables" || category.key === "views") {
          $queryTabs.newDataTab(database, item.name, category.key === "views");
      }
      else {
          await showDdl(database, category, item);
      }
  }

  return {
    informationDdl,
    informationLoading,
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
    objectFavorites,
    objectGroups,
    navigatorObjectClipboard,
    navigatorMenu,
    databaseSearchOpen,
    databaseSearchDatabase,
    databaseSearchQuery,
    databaseSearchSelection,
    objectSearchContainer,
    databaseSearchContainer,
    objectPrivilege,
    objectCategories,
    categories,
    navigatorMenuItems,
    visibleObjectFavorites,
    sqlCompletionContext,
    activeObjectItems,
    databaseSearchResults,
    informationTitle,
    informationSubtitle,
    informationRows,
    categoryKey,
    categoryDefinition,
    isObjectCategory,
    categoryItems,
    categoryCount,
    categorySelected,
    navigatorTargetKey,
    objectCategoryLabel,
    objectSelectionKey,
    selectedObject,
    selectedObjectInCategory,
    selectObject,
    visibleCategoryItems,
    refreshSchemas,
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
    deleteObject,
    deleteSelectedObject,
    clearDatabaseLocalState,
    openGlobalCategory,
    handleGlobalTableCommand,
    loadInformationDdl,
    openDatabaseDictionary,
    openTableDictionary,
    closeDatabase,
    editDatabaseTemplate,
    createDatabaseTemplate,
    deleteDatabase,
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
    rewriteCreateObjectName,
    copyNavigatorObject,
    pasteNavigatorObject,
    duplicateTableDraft,
    tableMutationDraft,
    renameObjectDraft,
    openNavigatorContextMenu,
    showDdl,
    openObject,
  };
}

export type { DatabaseNavigatorApi } from "./context";
