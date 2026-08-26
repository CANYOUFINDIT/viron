import { nextTick } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { createClientId } from "../../client-id";
import { downloadApiFile } from "../../desktop";
import type { DatabaseNavigatorTarget } from "../../database-navigator-menu";
import { translate as tr } from "../../i18n";
import { sqlIdentifier } from "./format";
import { deferDatabaseWorkbenchPart, type DatabaseWorkbenchContext } from "./context";
import type {
  BrowserCategory,
  DatabaseObject,
  DatabaseSearchResult,
  NavigatorCategory,
  ObjectCategory,
  ObjectCategoryDefinition,
  QueryJob,
  QueryTab,
  TableMaintenanceOperation,
  UtilityCategory,
} from "./types";

export function createDatabaseNavigatorActions(ctx: DatabaseWorkbenchContext) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $connections = deferDatabaseWorkbenchPart(ctx, "connections");
  const $navigator = deferDatabaseWorkbenchPart(ctx, "navigator");
  const $queryTabs = deferDatabaseWorkbenchPart(ctx, "queryTabs");
  const $artifacts = deferDatabaseWorkbenchPart(ctx, "artifacts");

  async function openCategory(database: string, category: NavigatorCategory) {
      $navigator.selectedDatabase.value = database;
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
      await $navigator.loadDatabaseObjects(database);
      $queryTabs.newObjectTab(database, category);
  }

  async function toggleCategory(database: string, category: NavigatorCategory) {
      const key = $navigator.categoryKey(database, category.key);
      const next = new Set($navigator.expandedCategories.value);
      if (next.has(key))
          next.delete(key);
      else {
          next.add(key);
          if ($navigator.isObjectCategory(category))
              await $navigator.loadDatabaseObjects(database);
          else if (category.key === "queries")
              await $artifacts.loadSavedQueries();
          else
              await $artifacts.loadDatabaseTasks();
      }
      $navigator.expandedCategories.value = next;
  }

  async function openNavigatorObject(database: string, category: NavigatorCategory, item: DatabaseObject) {
      if ($navigator.isObjectCategory(category))
          await openObject(database, category, item);
  }

  function selectNavigatorObject(database: string, category: NavigatorCategory, item: DatabaseObject) {
      if (!$navigator.isObjectCategory(category))
          return;
      $navigator.selectedDatabase.value = database;
      $navigator.navigatorTarget.value = `object:${database}:${category.key}:${item.name}`;
      $navigator.selectedObjects.value = { ...$navigator.selectedObjects.value, [`${database}:${category.key}`]: item.name };
      const objectTab = $queryTabs.tabs.value.find((tab) => tab.kind === "objects");
      if (objectTab) {
          objectTab.database = database;
          objectTab.category = category.key;
          objectTab.title = tr("对象");
      }
  }

  async function showNavigatorDdl(database: string, category: NavigatorCategory, item: DatabaseObject) {
      if ($navigator.isObjectCategory(category))
          await showDdl(database, category, item);
  }

  async function refreshObjectCategory(tab: QueryTab) {
      if (!tab.category)
          return;
      await $navigator.loadDatabaseObjects(tab.database, true);
  }

  function selectedCategoryContext() {
      const tab = $queryTabs.activeTab.value;
      if (!tab || tab.kind !== "objects" || !tab.category)
          return null;
      return { tab, category: $navigator.categoryDefinition(tab.category), item: $navigator.selectedObject(tab) };
  }

  function selectedTableContext() {
      const activeContext = selectedCategoryContext();
      if (activeContext?.tab.category === "tables" && activeContext.item) {
          return { database: activeContext.tab.database, item: activeContext.item };
      }
      const database = $navigator.selectedDatabase.value || $queryTabs.activeTab.value?.database || "";
      const item = database ? $navigator.selectedObjectInCategory(database, "tables") : null;
      return item ? { database, item } : null;
  }

  function currentTableContext() {
      const tab = $queryTabs.activeTab.value;
      if (tab?.kind === "data" && tab.table && !tab.readOnly) {
          const item = ($navigator.objects.value[tab.database]?.tables ?? []).find((candidate) => candidate.name === tab.table) ?? { name: tab.table };
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
      $queryTabs.newTab(templates[targetCategory], targetDatabase, tr("新建{0}", [$navigator.categoryDefinition(targetCategory).label]));
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
          await ElMessageBox.confirm(tr("确定删除 {0}“{1}”吗？该操作会立即写入数据库且不可撤销。", [$navigator.objectCategoryLabel(item, category), item.name]), tr("删除{0}", [$navigator.objectCategoryLabel(item, category)]), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "error" });
          $navigator.objectLoading.value = database;
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
          $navigator.selectedObjects.value = { ...$navigator.selectedObjects.value, [`${database}:${category.key}`]: "" };
          await $navigator.loadDatabaseObjects(database, true);
          ElMessage.success(tr("{0}已删除", [$navigator.objectCategoryLabel(item, category)]));
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("删除{0}失败", [category.label]));
      }
      finally {
          $navigator.objectLoading.value = "";
      }
  }

  async function deleteSelectedObject() {
      const context = selectedCategoryContext();
      if (!context?.item)
          return ElMessage.warning(tr("请先选择要删除的对象"));
      await deleteObject(context.tab.database, context.category, context.item);
  }

  function clearDatabaseLocalState(database: string) {
      delete $navigator.objects.value[database];
      delete $navigator.sqlCompletionCatalogs.value[database];
      $navigator.selectedObjects.value = Object.fromEntries(Object.entries($navigator.selectedObjects.value).filter(([key]) => !key.startsWith(`${database}:`)));
      $artifacts.selectedUtilityItems.value = Object.fromEntries(Object.entries($artifacts.selectedUtilityItems.value).filter(([key]) => !key.startsWith(`${database}:`)));
      $navigator.expandedCategories.value = new Set([...$navigator.expandedCategories.value].filter((key) => !key.startsWith(`${database}:`)));
      $artifacts.databaseTasks.value = $artifacts.databaseTasks.value.filter((task) => task.details.database !== database && task.details.sourceDatabase !== database && task.details.targetDatabase !== database);
  }

  async function openGlobalCategory(key: BrowserCategory | UtilityCategory) {
      const database = $queryTabs.requireSelectedDatabase();
      if (!database)
          return;
      const category = $navigator.categories.find((item) => item.key === key);
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
      $navigator.informationDdl.value = "";
      const tab = $queryTabs.activeTab.value;
      if (tab?.kind === "sql") {
          $navigator.informationDdl.value = tab.sql || tr("-- 当前查询为空");
          return;
      }
      if (!$connections.selectedConnectionId.value || !$connections.databaseConnected.value)
          return;
      let database = tab?.database || $navigator.selectedDatabase.value;
      let type = "";
      let name = "";
      if (tab?.kind === "data" && tab.table) {
          type = tab.readOnly ? "view" : "table";
          name = tab.table;
      }
      else if (tab?.kind === "objects" && tab.category) {
          const item = $navigator.selectedObject(tab);
          if (item) {
              type = item.sourceCategory === "procedures" ? "procedure" : item.sourceCategory === "functions" ? "function" : $navigator.categoryDefinition(tab.category).singular;
              name = item.name;
          }
      }
      if (!database || !type || !name) {
          $navigator.informationDdl.value = database ? `SHOW CREATE DATABASE ${sqlIdentifier(database)};` : tr("-- 选择数据库对象后查看 DDL");
          return;
      }
      $navigator.informationLoading.value = true;
      try {
          const response = await api<{
              ddl: string;
          }>(`/api/v1/database-connections/${$connections.selectedConnectionId.value}/ddl?database=${encodeURIComponent(database)}&type=${type}&name=${encodeURIComponent(name)}`);
          $navigator.informationDdl.value = response.ddl ? `${response.ddl};` : tr("-- 未返回 DDL");
      }
      catch (error) {
          $navigator.informationDdl.value = `-- ${error instanceof Error ? error.message : tr("读取 DDL 失败")}`;
      }
      finally {
          $navigator.informationLoading.value = false;
      }
  }

  function openDatabaseDictionary(database: string) {
      $queryTabs.newTab(`SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = ${JSON.stringify(database)}\nORDER BY TABLE_TYPE, TABLE_NAME;`, database, tr("数据字典 · {0}", [database]));
  }

  function openTableDictionary(database: string, table: string) {
      $queryTabs.newTab(`SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT\nFROM information_schema.COLUMNS\nWHERE TABLE_SCHEMA = ${JSON.stringify(database)} AND TABLE_NAME = ${JSON.stringify(table)}\nORDER BY ORDINAL_POSITION;`, database, tr("数据字典 · {0}", [table]));
  }

  function closeDatabase(database: string) {
      const next = new Set($navigator.expandedDatabases.value);
      next.delete(database);
      $navigator.expandedDatabases.value = next;
      $queryTabs.removeTabsForDatabase(database);
      clearDatabaseLocalState(database);
      if ($navigator.selectedDatabase.value === database) {
          $navigator.selectedDatabase.value = "";
          $navigator.navigatorTarget.value = "";
          $queryTabs.taskPanel.value = false;
          $artifacts.sidePanel.value = "";
      }
  }

  function editDatabaseTemplate(database: string) {
      const schema = $navigator.schemas.value.find((candidate) => candidate.name === database);
      const charset = schema?.charset ? ` CHARACTER SET ${schema.charset}` : "";
      const collation = schema?.collation ? ` COLLATE ${schema.collation}` : "";
      $queryTabs.newTab(`ALTER DATABASE ${sqlIdentifier(database)}${charset}${collation};`, database, tr("编辑数据库 · {0}", [database]));
  }

  function createDatabaseTemplate(database: string) {
      const schema = $navigator.schemas.value.find((candidate) => candidate.name === database);
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
          await $navigator.refreshSchemas();
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
      $navigator.objectPrivilege.value = { visible: true, database: target.database, objectName: object.item.name, objectType };
  }

  async function openDatabaseSearch(database: string) {
      await $navigator.loadDatabaseObjects(database);
      $navigator.databaseSearchDatabase.value = database;
      $navigator.databaseSearchQuery.value = "";
      $navigator.databaseSearchSelection.value = "";
      $navigator.databaseSearchOpen.value = true;
      await nextTick();
      $navigator.databaseSearchContainer.value?.querySelector<HTMLInputElement>("input")?.focus();
  }

  async function openDatabaseSearchResult(result?: DatabaseSearchResult) {
      const selected = result ?? $navigator.databaseSearchResults.value.find((candidate) => candidate.key === $navigator.databaseSearchSelection.value);
      if (!selected)
          return ElMessage.warning(tr("请选择一个数据库对象"));
      $navigator.databaseSearchOpen.value = false;
      await openObject($navigator.databaseSearchDatabase.value, $navigator.categoryDefinition(selected.category), selected.item);
  }

  function navigatorObject(target: DatabaseNavigatorTarget): {
      category: ObjectCategoryDefinition;
      item: DatabaseObject;
  } | null {
      if (target.kind !== "object" || !target.category || ["queries", "backups"].includes(target.category))
          return null;
      const category = $navigator.categoryDefinition(target.category as BrowserCategory);
      const item = ($navigator.objects.value[target.database]?.[category.key] ?? []).find((candidate) => (candidate.name === target.objectName
          && (!target.objectSource || candidate.sourceCategory === target.objectSource)));
      return item ? { category, item } : null;
  }

  async function chooseNavigatorObject(target: DatabaseNavigatorTarget, category: BrowserCategory): Promise<DatabaseObject | null> {
      const direct = navigatorObject(target);
      if (direct?.category.key === category)
          return direct.item;
      await $navigator.loadDatabaseObjects(target.database);
      const candidates = $navigator.objects.value[target.database]?.[category] ?? [];
      if (!candidates.length) {
          ElMessage.warning(tr("当前数据库没有可用的{0}", [$navigator.categoryDefinition(category).label]));
          return null;
      }
      try {
          const response = await ElMessageBox.prompt(tr("请输入目标{0}名称。可选：{1}{2}", [$navigator.categoryDefinition(category).label, candidates.slice(0, 8).map((item) => item.name).join("、"), candidates.length > 8 ? "…" : ""]), tr("选择{0}", [$navigator.categoryDefinition(category).label]), {
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
          $queryTabs.activeTab.value.title = tr("复制{0} · {1}", [$navigator.objectCategoryLabel(object.item, object.category), object.item.name]);
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
          $navigator.navigatorObjectClipboard.value = {
              database: target.database,
              category: object.category.key,
              sourceCategory: object.item.sourceCategory ?? object.category.key,
              name: object.item.name,
              ddl,
          };
          await copyTextToClipboard(ddl).catch(() => undefined);
          ElMessage.success(tr("已复制 {0}", [object.item.name]));
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("复制数据库对象失败"));
      }
  }

  async function pasteNavigatorObject(target: DatabaseNavigatorTarget) {
      const copied = $navigator.navigatorObjectClipboard.value;
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
          const tab = $queryTabs.newTab(`${sql};`, target.database, tr("粘贴{0} · {1}", [$navigator.categoryDefinition(copied.category).label, name]));
          await $queryTabs.executeDatabaseStatement(sql, target.database);
          tab.job = { id: "", status: "success", resultSets: [] };
          await $navigator.loadDatabaseObjects(target.database, true);
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
          await $navigator.loadDatabaseObjects(target.database, true);
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
      $navigator.selectedDatabase.value = target.database;
      $navigator.navigatorTarget.value = $navigator.navigatorTargetKey(target);
      if (target.kind === "object" && target.category && !["queries", "backups"].includes(target.category)) {
          $navigator.selectedObjects.value = { ...$navigator.selectedObjects.value, [`${target.database}:${target.category}`]: target.objectName ?? "" };
      }
      $navigator.navigatorMenu.value = { visible: false, x: event.clientX, y: event.clientY, target };
      void nextTick(() => {
          $navigator.navigatorMenu.value = { visible: true, x: event.clientX, y: event.clientY, target };
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
      $navigator.selectedDatabase.value = database;
      if (category.key === "tables" || category.key === "views") {
          $queryTabs.newDataTab(database, item.name, category.key === "views");
      }
      else {
          await showDdl(database, category, item);
      }
  }

  return {
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
