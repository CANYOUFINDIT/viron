import { computed, nextTick, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Clock3, Eye, FileCode2, HardDriveDownload, Table2 } from "@lucide/vue";
import { translate as tr, currentLocale } from "../../i18n";
import { api } from "../../api";
import {
  buildConnectionNavigatorMenu,
  buildDatabaseNavigatorMenu,
  type DatabaseNavigatorMenuItem,
  type DatabaseNavigatorTarget,
} from "../../database-navigator-menu";
import { session } from "../../session";
import type { SqlCompletionCatalog } from "../../sql-completion";
import type {
  BrowserCategory,
  DatabaseObject,
  DatabaseSearchResult,
  NavigatorCategory,
  NavigatorCategoryKey,
  NavigatorObjectClipboard,
  ObjectCategory,
  ObjectCategoryDefinition,
  ObjectFavoriteItem,
  ObjectGroupItem,
  QueryTab,
  SchemaItem,
  WorkbenchNavigatorTarget,
  DatabaseWorkbenchProps,
} from "./types";
import { formatBytes } from "./format";
import { deferDatabaseWorkbenchPart, type DatabaseWorkbenchContext } from "./context";
import { createDatabaseNavigatorActions } from "./database-navigator-actions";

export function useDatabaseNavigator(
  ctx: DatabaseWorkbenchContext,
  props: Readonly<DatabaseWorkbenchProps>,
  route: { fullPath: string },
) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $connections = deferDatabaseWorkbenchPart(ctx, "connections");
  const $queryTabs = deferDatabaseWorkbenchPart(ctx, "queryTabs");
  const $artifacts = deferDatabaseWorkbenchPart(ctx, "artifacts");
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

  const {
    openCategory, toggleCategory, openNavigatorObject, selectNavigatorObject,
    showNavigatorDdl, refreshObjectCategory, selectedCategoryContext, selectedTableContext,
    currentTableContext, openSelectedObject, designSelectedObject, designSelectedTable,
    designCurrentTable, createObjectTemplate, deleteObject, deleteSelectedObject,
    clearDatabaseLocalState, openGlobalCategory, handleGlobalTableCommand, loadInformationDdl,
    openDatabaseDictionary, openTableDictionary, closeDatabase, editDatabaseTemplate,
    createDatabaseTemplate, deleteDatabase, dumpTableStructure, reverseNavigatorTarget,
    createBiWorkspaceFromTarget, openObjectPrivileges, openDatabaseSearch, openDatabaseSearchResult,
    navigatorObject, chooseNavigatorObject, openTableWizard, duplicateObjectDraft,
    fetchObjectDdl, rewriteCreateObjectName, copyNavigatorObject, pasteNavigatorObject,
    duplicateTableDraft, tableMutationDraft, renameObjectDraft, openNavigatorContextMenu,
    showDdl, openObject,
  } = createDatabaseNavigatorActions(ctx);

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
