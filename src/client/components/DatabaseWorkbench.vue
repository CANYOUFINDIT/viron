<script setup lang="ts">import { translate as tr, currentLocale } from "../i18n";

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
import { ElMessage, ElMessageBox } from "element-plus";
import { format } from "sql-formatter";
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ApiError, api } from "../api";
import { createClientId } from "../client-id";
import {
  buildConnectionNavigatorMenu,
  buildDatabaseNavigatorMenu,
  type DatabaseNavigatorMenuItem,
  type DatabaseNavigatorTarget,
} from "../database-navigator-menu";
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
} from "../desktop";
import { registerAgentDatabaseSceneProvider } from "../agent-database-scene";
import { registerAgentWorkbenchExecutionProvider } from "../agent-workbench-execution";
import { rememberActiveConnectionOrigin } from "../active-connection-origin";
import { session } from "../session";
import { onAppShortcut, shortcutActionFromKeyboardEvent, shortcutLabel } from "../keyboard-shortcuts";
import type { SqlCompletionCatalog } from "../sql-completion";
import type { ShortcutActionId } from "../../shared/keyboard-shortcuts";
import { agentTransportValue, type AgentDatabaseReadResult, type AgentWorkbenchExecutionRequest } from "../../shared/agent";
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

const props = withDefaults(defineProps<{
  environmentId?: string;
  initialConnectionId?: string;
  workspaceKey?: string;
  active?: boolean;
}>(), { workspaceKey: "fixed:database", active: true });
const route = useRoute();

interface DatabaseConnection {
  id: string;
  profileParentId: string | null;
  profileName: string;
  type: "database";
  name: string;
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  username: string;
  environmentId: string | null;
  environmentIds: string[];
  connectionGroupId: string | null;
  connectionGroupPath: string | null;
  defaultDatabase: string;
  connectionMode: "tcp" | "sshTunnel" | "httpTunnel";
  options: Record<string, unknown>;
  canManage: boolean;
  starred: boolean;
  color: string;
}

interface ConnectionGroupItem { id: string; parentId: string | null; name: string; path: string }
interface OrganizationGrant { id: string; granteeType: "user" | "project"; granteeId: string; granteeName: string; resourceType: string; resourceId: string }
interface OrganizationShareDetail {
  members: Array<{ id: string; username: string; role: "admin" | "member"; status: string }>;
  projects: Array<{ id: string; name: string }>;
  grants: OrganizationGrant[];
}

interface SchemaItem { name: string; charset: string; collation: string }
interface DatabaseObject {
  name: string;
  sourceCategory?: ObjectCategory;
  rowCount?: number;
  dataSize?: number;
  engine?: string;
  comment?: string;
  tableName?: string;
  status?: string;
  event?: string;
  timing?: string;
  eventType?: string;
  createdAt?: string;
  updatedAt?: string;
  collation?: string;
}
type ObjectCategory = "tables" | "views" | "procedures" | "functions" | "triggers" | "events";
type BrowserCategory = "tables" | "views" | "functions" | "events";
type UtilityCategory = "queries" | "backups";
type NavigatorCategoryKey = BrowserCategory | UtilityCategory;

interface ObjectCategoryDefinition {
  key: BrowserCategory;
  label: string;
  icon: typeof Table2;
  singular: string;
  sources: ObjectCategory[];
}

interface UtilityCategoryDefinition {
  key: UtilityCategory;
  label: string;
  icon: typeof Table2;
}

type NavigatorCategory = ObjectCategoryDefinition | UtilityCategoryDefinition;

interface QueryResultSet {
  columns: Array<{ name: string; table: string; type: number }>;
  rows: Array<Record<string, unknown>>;
  affectedRows: number;
  insertId: string | number;
  info: string;
  truncated: boolean;
  statement?: string;
  error?: string;
}

interface QueryJob {
  id: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  continueOnError?: boolean;
  resultSets: QueryResultSet[];
}

interface QueryTab {
  id: string;
  title: string;
  sql: string;
  database: string;
  job: QueryJob | null;
  activeResult: number;
  kind: "sql" | "command-line" | "data" | "objects" | "utility" | "table-design" | "automation" | "model" | "user" | "bi";
  table?: string;
  readOnly?: boolean;
  category?: BrowserCategory;
  utilityCategory?: UtilityCategory;
  tableAction?: { id: string; type: "import" | "export"; format?: "csv" | "xlsx" | "sql" };
  dirty?: boolean;
  savedQueryId?: string;
  savedQuerySql?: string;
  savedQueryName?: string;
  savedQueryDatabase?: string;
}

interface ConnectionNavigatorTarget {
  kind: "connection";
  connectionId: string;
}

type WorkbenchNavigatorTarget = DatabaseNavigatorTarget | ConnectionNavigatorTarget;

interface HistoryItem {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
  status: string;
  durationMs: number;
  rowCount: number;
  error: string;
  createdAt: string;
}

interface FavoriteItem { id: string; connectionId: string; database: string; name: string; sql: string; updatedAt: string }
interface SavedQueryItem {
  id: string;
  connectionId: string;
  database: string;
  name: string;
  sql: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}
interface DatabaseTreeTask {
  id: string;
  type: "backup" | "restore" | "transfer" | "import";
  connectionId: string | null;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  progress: number;
  title: string;
  details: Record<string, unknown>;
  downloadable: boolean;
  logs: string[];
  error: string;
  createdAt: string;
  completedAt?: string;
  outputFilename: string | null;
}
interface ObjectFavoriteItem {
  id: string;
  connectionId: string;
  connectionName: string;
  environmentId: string | null;
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  targetType: "database" | "table";
  database: string;
  table: string;
  updatedAt: string;
}
interface ObjectGroupItem {
  id: string;
  connectionId: string;
  database: string;
  category: NavigatorCategoryKey;
  name: string;
  members: Array<{ objectName: string; objectSource: string }>;
  createdAt: string;
  updatedAt: string;
}
interface NavigatorObjectClipboard {
  database: string;
  category: BrowserCategory;
  sourceCategory: ObjectCategory;
  name: string;
  ddl: string;
}

interface DatabaseSearchResult {
  key: string;
  category: BrowserCategory;
  categoryLabel: string;
  item: DatabaseObject;
}

const loading = ref(true);
const connecting = ref(false);
const databaseSessionId = ref("");
const connections = ref<DatabaseConnection[]>([]);
const connectionGroups = ref<ConnectionGroupItem[]>([]);
const selectedConnectionId = ref("");
const focusedConnectionId = ref("");
const connectionPaneWidth = ref(240);
const connectionPaneVisible = ref(true);
const explorerPaneWidth = ref(280);
const informationPaneVisible = ref(false);
const informationPaneTab = ref<"general" | "ddl">("general");
const informationDdl = ref("");
const informationLoading = ref(false);
const navigationFilter = ref<"all" | "connected" | "disconnected">("all");
const showStarredOnly = ref(false);
const queryResultLayout = ref<"below" | "right">("below");
const queryFocused = ref(false);
const syncDialogOpen = ref(false);
const syncDialogMode = ref<"data" | "structure">("structure");
const connectionEditorOpen = ref(false);
const editingConnection = ref<DatabaseConnection | null>(null);
const copyConnectionMode = ref(false);
const connectionProfileParentId = ref("");
const workbenchElement = ref<HTMLElement | null>(null);
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
const connectionSearch = ref("");
const tabs = ref<QueryTab[]>([]);
const activeTabId = ref("");
const sidePanel = ref<"history" | "favorites" | "">("");
const historyItems = ref<HistoryItem[]>([]);
const favorites = ref<FavoriteItem[]>([]);
const savedQueries = ref<SavedQueryItem[]>([]);
const selectedUtilityItems = ref<Record<string, string>>({});
const objectFavorites = ref<ObjectFavoriteItem[]>([]);
const objectGroups = ref<ObjectGroupItem[]>([]);
const navigatorObjectClipboard = ref<NavigatorObjectClipboard | null>(null);
const taskPanel = ref(false);
const taskPanelRequest = ref<{ id: string; type: "restore" | "list" | "transfer" }>();
const databaseTasks = ref<DatabaseTreeTask[]>([]);
const navigatorMenu = ref<{ visible: boolean; x: number; y: number; target: WorkbenchNavigatorTarget | null }>({ visible: false, x: 0, y: 0, target: null });
const databaseSearchOpen = ref(false);
const databaseSearchDatabase = ref("");
const databaseSearchQuery = ref("");
const databaseSearchSelection = ref("");
const connectionSearchContainer = ref<HTMLElement | null>(null);
const objectSearchContainer = ref<HTMLElement | null>(null);
const databaseSearchContainer = ref<HTMLElement | null>(null);
const automationWorkspace = ref<InstanceType<typeof DatabaseAutomationWorkspace> | null>(null);
const modelWorkspace = ref<InstanceType<typeof DatabaseModelWorkspace> | null>(null);
const biWorkspace = ref<InstanceType<typeof DatabaseBiWorkspace> | null>(null);
const queryBuilderOpen = ref(false);
const codeSnippetOpen = ref(false);
const dataGenerator = ref({ visible: false, database: "", table: "" });
const objectPrivilege = ref<{ visible: boolean; database: string; objectName: string; objectType: "table" | "view" | "procedure" | "function" }>({ visible: false, database: "", objectName: "", objectType: "table" });
const shareDialogOpen = ref(false);
const shareDialogLoading = ref(false);
const shareConnection = ref<DatabaseConnection | null>(null);
const shareDetail = ref<OrganizationShareDetail | null>(null);
const shareGrantee = ref("");
const collapsedConnectionGroups = ref<Set<string>>(new Set());
const collapsedConnectionIds = ref<Set<string>>(new Set());
const pollTimers = new Set<number>();
let databaseSessionPollTimer: number | undefined;
const persistenceKey = computed(() => `envman:database-workbench:${props.workspaceKey}:${props.environmentId ?? "global"}`);
const workbenchStyle = computed(() => ({
  "--connection-pane-width": `${connectionPaneWidth.value}px`,
  "--information-pane-width": `${explorerPaneWidth.value}px`,
}));

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

const selectedConnection = computed(() => connections.value.find((item) => item.id === selectedConnectionId.value) ?? null);
const rootConnections = computed(() => connections.value.filter((item) => !item.profileParentId));
const selectedRootConnection = computed(() => {
  const selected = selectedConnection.value;
  if (!selected) return null;
  return selected.profileParentId ? connections.value.find((item) => item.id === selected.profileParentId) ?? null : selected;
});
const editingRootConnection = computed(() => {
  const editing = editingConnection.value;
  if (!editing) return null;
  return editing.profileParentId ? connections.value.find((item) => item.id === editing.profileParentId) ?? null : editing;
});
const editingConnectionProfiles = computed(() => connections.value.filter((item) => item.profileParentId === editingRootConnection.value?.id));
const activeRootConnectionId = computed(() => selectedRootConnection.value?.id ?? "");
const activeConnectionProfiles = computed(() => connections.value
  .filter((item) => item.profileParentId === activeRootConnectionId.value)
  .map((item) => ({ id: item.id, name: item.profileName || item.name })));
const databaseConnected = computed(() => Boolean(databaseSessionId.value));
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null);
const queryRunning = computed(() => ["pending", "running"].includes(activeTab.value?.job?.status ?? ""));
const continueOnQueryError = ref(false);
const sqlEditor = ref<{ currentStatementSql(): string; selectedSql(): string; openFind(): void } | null>(null);
let removeShortcutListener: (() => void) | undefined;
let removeAgentDatabaseSceneProvider: (() => void) | undefined;
let removeAgentWorkbenchExecutionProvider: (() => void) | undefined;
const pendingAgentDatabaseExecutions = new Map<string, {
  jobId: string;
  tab: QueryTab;
  timer: number;
  reject: (error: Error) => void;
}>();
const navigatorMenuItems = computed<DatabaseNavigatorMenuItem[]>(() => {
  const target = navigatorMenu.value.target;
  if (!target) return [];
  if (target.kind === "connection") {
    const connection = connections.value.find((item) => item.id === target.connectionId);
    const profiles = connections.value.filter((item) => item.profileParentId === target.connectionId);
    return buildConnectionNavigatorMenu(target.connectionId === activeRootConnectionId.value && databaseConnected.value, {
      starred: connection?.starred,
      canManage: connection?.canManage,
      canShare: Boolean(connection?.canManage && session.workspace?.type === "organization" && session.workspace.role === "admin"),
      connectionGroupId: connection?.connectionGroupId,
      groups: connectionGroups.value,
      profiles: profiles.map((profile) => ({ id: profile.id, name: profile.profileName || profile.name })),
      activeProfileId: selectedConnection.value?.profileParentId === target.connectionId
        ? selectedConnection.value.id
        : String(connection?.options.activeProfileId ?? ""),
    });
  }
  return buildDatabaseNavigatorMenu(target, {
    canShare: Boolean(selectedRootConnection.value?.canManage && session.workspace?.type === "organization" && session.workspace.role === "admin"),
    canPaste: Boolean(target.category && navigatorObjectClipboard.value?.category === target.category),
    profiles: activeConnectionProfiles.value,
  });
});
const favoriteConnectionIds = computed(() => new Set(objectFavorites.value.map((item) => item.connectionId)));
const filteredConnections = computed(() => {
  const query = connectionSearch.value.trim().toLowerCase();
  return connections.value.filter((item) => {
    if (item.profileParentId) return false;
    if (navigationFilter.value === "connected" && !(item.id === activeRootConnectionId.value && databaseConnected.value)) return false;
    if (navigationFilter.value === "disconnected" && item.id === activeRootConnectionId.value && databaseConnected.value) return false;
    if (showStarredOnly.value && !item.starred && !favoriteConnectionIds.value.has(item.id)) return false;
    return !query || `${item.name} ${item.host} ${item.username}`.toLowerCase().includes(query);
  });
});
const groupedConnections = computed(() => {
  const groups = new Map<string, DatabaseConnection[]>();
  for (const connection of filteredConnections.value) {
    const path = connection.connectionGroupPath || tr("未分组");
    groups.set(path, [...(groups.get(path) ?? []), connection]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left === tr("未分组") ? 1 : right === tr("未分组") ? -1 : left.localeCompare(right, "zh-CN"))
    .map(([path, items]) => ({ path, items }));
});
const visibleObjectFavorites = computed(() => {
  const available = new Set(connections.value.map((connection) => connection.id));
  const query = connectionSearch.value.trim().toLowerCase();
  return objectFavorites.value.filter((item) => {
    if (!available.has(item.connectionId)) return false;
    if (!query) return true;
    return `${item.connectionName} ${item.database} ${item.table} ${item.host}`.toLowerCase().includes(query);
  });
});
const shareGrants = computed(() => shareDetail.value?.grants.filter((grant) => grant.resourceType === "database_connection" && grant.resourceId === shareConnection.value?.id) ?? []);
const shareCandidates = computed(() => {
  const granted = new Set(shareGrants.value.map((grant) => `${grant.granteeType}:${grant.granteeId}`));
  return [
    ...(shareDetail.value?.members ?? []).filter((item) => item.role !== "admin" && item.status === "active").map((item) => ({ key: `user:${item.id}`, label: item.username, type: "user" as const, id: item.id })),
    ...(shareDetail.value?.projects ?? []).map((item) => ({ key: `project:${item.id}`, label: item.name, type: "project" as const, id: item.id })),
  ].filter((item) => !granted.has(item.key));
});
const sqlCompletionContext = computed(() => {
  const database = activeTab.value?.kind === "sql" ? activeTab.value.database : "";
  return { schemas: schemas.value.map((schema) => schema.name), catalog: database ? sqlCompletionCatalogs.value[database] : undefined };
});
const activeObjectItems = computed(() => {
  if (activeTab.value?.kind !== "objects" || !activeTab.value.category) return [];
  const items = objects.value[activeTab.value.database]?.[activeTab.value.category] ?? [];
  const query = objectSearch.value.trim().toLowerCase();
  if (!query) return items;
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
  if (!isObjectCategory(category)) return [];
  return objects.value[database]?.[category.key] ?? [];
}

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
  return databaseTasks.value.filter((task) => (
    task.connectionId === selectedConnectionId.value
    && task.type === "backup"
    && databaseTaskDatabase(task) === database
  ));
}

function categoryCount(database: string, category: NavigatorCategory): number | string {
  if (category.key === "queries") return savedQueriesForDatabase(database).length;
  if (category.key === "backups") return backupTasksForDatabase(database).length;
  return objects.value[database]?.[category.key]?.length ?? "—";
}

function categorySelected(database: string, category: NavigatorCategory): boolean {
  if (!expandedDatabases.value.has(database) || selectedDatabase.value !== database) return false;
  if (isObjectCategory(category)) {
    return activeTab.value?.kind === "objects" && activeTab.value.database === database && activeTab.value.category === category.key;
  }
  return activeTab.value?.kind === "utility"
    && activeTab.value.database === database
    && activeTab.value.utilityCategory === category.key;
}

function navigatorTargetKey(target: DatabaseNavigatorTarget): string {
  if (target.kind === "database") return `database:${target.database}`;
  if (target.kind === "category") return `category:${target.database}:${target.category ?? ""}`;
  return `object:${target.database}:${target.category ?? ""}:${target.objectName ?? ""}`;
}

function objectCategoryLabel(item: DatabaseObject, fallback: ObjectCategoryDefinition): string {
  if (item.sourceCategory === "procedures") return tr("存储过程");
  if (item.sourceCategory === "functions") return tr("函数");
  return fallback.label;
}

function objectSelectionKey(tab: QueryTab): string {
  return `${tab.database}:${tab.category ?? ""}`;
}

function utilitySelectionKey(database: string, category: UtilityCategory): string {
  return `${database}:${category}`;
}

function selectedSavedQuery(target: DatabaseNavigatorTarget): SavedQueryItem | null {
  if (target.category !== "queries") return null;
  const id = target.objectId || selectedUtilityItems.value[utilitySelectionKey(target.database, "queries")];
  return savedQueries.value.find((item) => item.id === id) ?? null;
}

function selectedBackup(target: DatabaseNavigatorTarget): DatabaseTreeTask | null {
  if (target.category !== "backups") return null;
  const id = target.objectId || selectedUtilityItems.value[utilitySelectionKey(target.database, "backups")];
  return databaseTasks.value.find((item) => item.id === id && item.type === "backup") ?? null;
}

function selectUtilityItem(database: string, category: UtilityCategory, id: string) {
  selectedDatabase.value = database;
  selectedUtilityItems.value = { ...selectedUtilityItems.value, [utilitySelectionKey(database, category)]: id };
  navigatorTarget.value = `object:${database}:${category}:${id}`;
}

function selectedObject(tab = activeTab.value): DatabaseObject | null {
  if (!tab || tab.kind !== "objects" || !tab.category) return null;
  return selectedObjectInCategory(tab.database, tab.category);
}

function selectedObjectInCategory(database: string, category: BrowserCategory): DatabaseObject | null {
  const name = selectedObjects.value[`${database}:${category}`];
  return (objects.value[database]?.[category] ?? []).find((item) => item.name === name) ?? null;
}

function selectObject(tab: QueryTab, item: DatabaseObject) {
  selectedObjects.value = { ...selectedObjects.value, [objectSelectionKey(tab)]: item.name };
  selectedDatabase.value = tab.database;
  if (tab.category) navigatorTarget.value = `object:${tab.database}:${tab.category}:${item.name}`;
}

function formatBytes(value?: number) {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function textSize(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function newTab(sql = "", database = selectedDatabase.value, title?: string): QueryTab {
  const id = createClientId();
  const tab: QueryTab = { id, title: title ?? tr("查询 {0}", [tabs.value.length + 1]), sql, database, job: null, activeResult: 0, kind: "sql" };
  tabs.value.push(tab);
  activeTabId.value = id;
  return tab;
}

function registerDatabaseAgentScene() {
  removeAgentDatabaseSceneProvider?.();
  removeAgentDatabaseSceneProvider = undefined;
  if (!props.active) return;
  removeAgentDatabaseSceneProvider = registerAgentDatabaseSceneProvider({
    current: () => {
      if (!props.active) return null;
      const connection = selectedConnection.value;
      const database = activeTab.value?.kind === "sql" ? activeTab.value.database : selectedDatabase.value;
      if (!connection || !database) return null;
      const result = activeTab.value?.kind === "sql" ? queryResult(activeTab.value) : undefined;
      return {
        routePath: route.fullPath,
        connectionId: connection.id,
        connectionName: connection.name,
        database,
        connected: databaseConnected.value,
        localExecution: isDesktopApp() && desktopExecutionTargets.value.database === "local",
        editorSql: activeTab.value?.kind === "sql" ? activeTab.value.sql : "",
        selectedSql: activeTab.value?.kind === "sql" ? (sqlEditor.value?.selectedSql() ?? "") : "",
        resultPreview: result?.rows.slice(0, 20) ?? [],
      };
    },
    fill: (connectionId, database, sql) => {
      if (!props.active || selectedConnectionId.value !== connectionId || !databaseConnected.value || desktopExecutionTargets.value.database !== "local") return false;
      const tab = activeTab.value?.kind === "sql" && activeTab.value.database === database ? activeTab.value : newTab("", database, tr("Viron Agent SQL"));
      tab.sql = sql;
      return true;
    },
  });
}

function databaseAgentResult(request: AgentWorkbenchExecutionRequest & { domain: "database" }, job: QueryJob): AgentDatabaseReadResult {
  if (job.status !== "success") throw new Error(job.error || tr("数据库工作台查询失败"));
  const result = job.resultSets[0];
  if (!result) {
    return {
      connectionId: request.connectionId,
      connectionName: selectedConnection.value?.name || tr("数据库连接"),
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
  if (!Array.isArray(rows)) throw new Error(tr("数据库工作台查询结果无效"));
  return {
    connectionId: request.connectionId,
    connectionName: selectedConnection.value?.name || tr("数据库连接"),
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

async function executeAgentDatabaseWorkbench(request: AgentWorkbenchExecutionRequest & { domain: "database" }): Promise<{ domain: "database"; requestId: string; result: AgentDatabaseReadResult }> {
  if (
    !props.active
    || !workbenchElement.value?.getClientRects().length
    || selectedConnectionId.value !== request.connectionId
    || !databaseConnected.value
    || desktopExecutionTargets.value.database !== "local"
    || tabs.value.some((item) => item.job && ["pending", "running"].includes(item.job.status))
    || pendingAgentDatabaseExecutions.size
  ) throw new Error(tr("请切回 Agent 绑定的空闲本机数据库工作台后重试"));
  const tab = activeTab.value?.kind === "sql" && activeTab.value.database === request.database
    ? activeTab.value
    : newTab("", request.database, tr("Viron Agent SQL"));
  tab.sql = request.sql;
  tab.job = { id: "", status: "pending", resultSets: [] };
  tab.activeResult = 0;
  let response: { job: QueryJob };
  try {
    response = await api<{ job: QueryJob }>(`/api/v1/database-connections/${request.connectionId}/queries`, {
      method: "POST",
      body: JSON.stringify({ sql: request.sql, database: request.database, continueOnError: false }),
    });
    tab.job = response.job;
  } catch (error) {
    tab.job = { id: "", status: "error", error: error instanceof Error ? error.message : tr("查询启动失败"), resultSets: [] };
    throw error instanceof Error ? error : new Error(tr("查询启动失败"));
  }
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const latest = await api<{ job: QueryJob }>(`/api/v1/database-queries/${response.job.id}`);
        tab.job = latest.job;
        if (["pending", "running"].includes(latest.job.status)) return;
        const pending = pendingAgentDatabaseExecutions.get(request.requestId);
        if (!pending) return;
        pendingAgentDatabaseExecutions.delete(request.requestId);
        window.clearInterval(pending.timer);
        await loadHistory();
        if (latest.job.status === "success") resolve({ domain: "database", requestId: request.requestId, result: databaseAgentResult(request, latest.job) });
        else reject(new Error(latest.job.error || tr("数据库工作台查询失败")));
      } catch (error) {
        const pending = pendingAgentDatabaseExecutions.get(request.requestId);
        if (!pending) return;
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
  if (!props.active) return;
  removeAgentWorkbenchExecutionProvider = registerAgentWorkbenchExecutionProvider({
    domain: "database",
    routePath: () => props.active && workbenchElement.value?.getClientRects().length ? route.fullPath : null,
    execute: (request) => {
      if (request.domain !== "database") throw new Error(tr("Viron Agent 数据库工作台请求无效"));
      return executeAgentDatabaseWorkbench(request);
    },
    cancel: async (requestId, reason) => {
      const pending = pendingAgentDatabaseExecutions.get(requestId);
      if (!pending) return;
      pendingAgentDatabaseExecutions.delete(requestId);
      window.clearInterval(pending.timer);
      await api(`/api/v1/database-queries/${pending.jobId}`, { method: "DELETE" }).catch(() => undefined);
      pending.tab.job = { id: pending.jobId, status: "cancelled", error: reason, resultSets: [] };
      pending.reject(new Error(reason || tr("数据库工作台执行已取消")));
    },
  });
}

function queryTabDirty(tab: QueryTab): boolean {
  if (tab.kind !== "sql") return false;
  if (!tab.savedQueryId) return Boolean(tab.sql.trim());
  return tab.sql !== (tab.savedQuerySql ?? "")
    || tab.title !== (tab.savedQueryName ?? "")
    || tab.database !== (tab.savedQueryDatabase ?? "");
}

function toggleConnectionGroup(path: string) {
  const next = new Set(collapsedConnectionGroups.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedConnectionGroups.value = next;
}

function setConnectionCollapsed(connectionId: string, collapsed: boolean) {
  const next = new Set(collapsedConnectionIds.value);
  if (collapsed) next.add(connectionId);
  else next.delete(connectionId);
  collapsedConnectionIds.value = next;
}

function connectionChildrenVisible(connection: DatabaseConnection) {
  return activeRootConnectionId.value === connection.id
    && databaseConnected.value
    && !collapsedConnectionIds.value.has(connection.id);
}

function handleConnectionNodeClick(connection: DatabaseConnection) {
  focusConnection(connection);
  navigatorMenu.value.visible = false;
  if (activeRootConnectionId.value === connection.id && databaseConnected.value) {
    setConnectionCollapsed(connection.id, !collapsedConnectionIds.value.has(connection.id));
  }
}

const activeUtilityItems = computed(() => {
  if (activeTab.value?.kind !== "utility" || !activeTab.value.utilityCategory) return [];
  const query = objectSearch.value.trim().toLowerCase();
  if (activeTab.value.utilityCategory === "queries") {
    return savedQueriesForDatabase(activeTab.value.database).filter((item) => !query || `${item.name} ${item.sql}`.toLowerCase().includes(query));
  }
  return backupTasksForDatabase(activeTab.value.database).filter((item) => !query || `${item.title} ${item.status}`.toLowerCase().includes(query));
});

const dataTabs = computed(() => tabs.value.filter((tab) => tab.kind === "data" && tab.table));

const informationTitle = computed(() => {
  if (activeTab.value?.kind === "data") return activeTab.value.table ?? tr("表");
  if (activeTab.value?.kind === "objects") return selectedObject(activeTab.value)?.name ?? activeTab.value.database;
  if (activeTab.value?.kind === "utility") return activeTab.value.utilityCategory === "queries" ? tr("查询") : tr("备份");
  if (selectedDatabase.value) return selectedDatabase.value;
  return selectedConnection.value?.name ?? tr("对象");
});

const informationSubtitle = computed(() => {
  if (activeTab.value?.kind === "data") return tr("表 · {0}", [activeTab.value.database]);
  if (activeTab.value?.kind === "objects" && activeTab.value.category) return `${categoryDefinition(activeTab.value.category).label} · ${activeTab.value.database}`;
  if (activeTab.value?.kind === "utility") return `${activeTab.value.database} · ${activeTab.value.utilityCategory === "queries" ? tr("查询") : tr("备份")}`;
  if (selectedDatabase.value) return tr("数据库 · {0}", [selectedConnection.value?.name ?? ""]);
  return selectedConnection.value ? tr("{0} · 连接", [selectedConnection.value.engine.toUpperCase()]) : tr("数据库工作台");
});

const informationRows = computed(() => {
  const connection = selectedConnection.value;
  const tab = activeTab.value;
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
    if (item) return [
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
  if (connection) return [
    [tr("类型"), connection.engine.toUpperCase()],
    [tr("主机"), connection.host],
    [tr("端口"), String(connection.port)],
    [tr("用户"), connection.username],
    [tr("连接方式"), connection.connectionMode],
    [tr("默认数据库"), connection.defaultDatabase || "—"],
  ];
  return [];
});

function persistWorkbenchPreferences() {
  localStorage.setItem(persistenceKey.value, JSON.stringify({
    connectionPaneWidth: connectionPaneWidth.value,
    explorerPaneWidth: explorerPaneWidth.value,
    informationPaneVisible: informationPaneVisible.value,
    queryResultLayout: queryResultLayout.value,
  }));
}

function restoreWorkbenchPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(persistenceKey.value) ?? "{}") as {
      connectionPaneWidth?: number;
      explorerPaneWidth?: number;
      informationPaneVisible?: boolean;
      queryResultLayout?: "below" | "right";
    };
    if (value.connectionPaneWidth) connectionPaneWidth.value = Math.max(220, Math.min(520, value.connectionPaneWidth));
    if (value.explorerPaneWidth) explorerPaneWidth.value = Math.max(220, Math.min(420, value.explorerPaneWidth));
    if (typeof value.informationPaneVisible === "boolean") informationPaneVisible.value = value.informationPaneVisible;
    if (value.queryResultLayout === "below" || value.queryResultLayout === "right") queryResultLayout.value = value.queryResultLayout;
  } catch {
    // Ignore invalid local preferences and use the defaults.
  }
}

function setConnectionPaneWidth(value: number) {
  const maxWidth = Math.min(520, (workbenchElement.value?.getBoundingClientRect().width ?? 1040) * .5);
  connectionPaneWidth.value = Math.round(Math.max(220, Math.min(maxWidth, value)));
}

function startConnectionPaneResize(event: PointerEvent) {
  event.preventDefault();
  const bounds = workbenchElement.value?.getBoundingClientRect();
  if (!bounds) return;
  const move = (moveEvent: PointerEvent) => setConnectionPaneWidth(moveEvent.clientX - bounds.left);
  const finish = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    persistWorkbenchPreferences();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish, { once: true });
}

function resizeConnectionPane(delta: number) {
  setConnectionPaneWidth(connectionPaneWidth.value + delta);
  persistWorkbenchPreferences();
}

function setExplorerPaneWidth(value: number) {
  const workbenchWidth = workbenchElement.value?.getBoundingClientRect().width ?? 1200;
  const connectionWidth = connectionPaneVisible.value ? connectionPaneWidth.value : 0;
  const maxWidth = Math.min(420, workbenchWidth - connectionWidth - 420);
  explorerPaneWidth.value = Math.round(Math.max(220, Math.min(Math.max(220, maxWidth), value)));
}

function startExplorerPaneResize(event: PointerEvent) {
  event.preventDefault();
  const bounds = workbenchElement.value?.getBoundingClientRect();
  if (!bounds) return;
  const move = (moveEvent: PointerEvent) => setExplorerPaneWidth(bounds.right - moveEvent.clientX);
  const finish = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    persistWorkbenchPreferences();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish, { once: true });
}

function resizeExplorerPane(delta: number) {
  setExplorerPaneWidth(explorerPaneWidth.value + delta);
  persistWorkbenchPreferences();
}

function setConnectionPaneVisible(value: boolean) {
  connectionPaneVisible.value = value;
  setExplorerPaneWidth(explorerPaneWidth.value);
  persistWorkbenchPreferences();
}

function setInformationPaneVisible(value: boolean) {
  informationPaneVisible.value = value;
  setExplorerPaneWidth(explorerPaneWidth.value);
  persistWorkbenchPreferences();
}

function setQueryResultLayout(value: "below" | "right") {
  queryResultLayout.value = value;
  persistWorkbenchPreferences();
}

function visibleCategoryItems(database: string, category: NavigatorCategory): DatabaseObject[] {
  const items = categoryItems(database, category);
  const query = connectionSearch.value.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => `${item.name} ${item.comment ?? ""}`.toLowerCase().includes(query));
}

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

function newCommandLine(database = selectedDatabase.value) {
  const existing = tabs.value.find((tab) => tab.kind === "command-line" && tab.database === database);
  if (existing) {
    activeTabId.value = existing.id;
    return existing;
  }
  const tab: QueryTab = {
    id: createClientId(),
    title: tr("命令列@{0}", [database || selectedConnection.value?.name || tr("连接")]),
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

function newObjectTab(database: string, category: (typeof categories)[number]) {
  if (!isObjectCategory(category)) return;
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
    database: selectedDatabase.value,
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
      if (tab.kind === "automation" && !await automationWorkspace.value?.save()) return;
      if (tab.kind === "model" && !await modelWorkspace.value?.save()) return;
      if (tab.kind === "bi" && !await biWorkspace.value?.save()) return;
    } catch (action) {
      if (tab.kind === "table-design" || action !== "cancel") return;
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
      if (!await saveQueryTab(tab)) return;
    } catch (action) {
      if (action !== "cancel") return;
    }
  }
  const index = tabs.value.findIndex((item) => item.id === tab.id);
  tabs.value.splice(index, 1);
  if (activeTabId.value === tab.id) activeTabId.value = tabs.value[Math.max(0, index - 1)]?.id ?? "";
}

function resetDatabaseWorkspace(preserveSqlTabs = true) {
  schemas.value = [];
  sqlCompletionCatalogs.value = {};
  objects.value = {};
  expandedDatabases.value = new Set();
  expandedCategories.value = new Set();
  selectedDatabase.value = "";
  selectedObjects.value = {};
  tabs.value = preserveSqlTabs
    ? tabs.value.filter((tab) => ["sql", "automation", "model", "bi"].includes(tab.kind)).map((tab) => ({ ...tab, database: "", job: null, activeResult: 0 }))
    : [];
  activeTabId.value = tabs.value[0]?.id ?? "";
  historyItems.value = [];
  favorites.value = [];
  savedQueries.value = [];
  selectedUtilityItems.value = {};
  databaseTasks.value = [];
  sidePanel.value = "";
  taskPanel.value = false;
}

async function load() {
  loading.value = true;
  let initialConnection: DatabaseConnection | undefined;
  void loadObjectFavorites().catch(() => {
  objectFavorites.value = [];
  objectGroups.value = [];
    ElMessage.warning(tr("数据库收藏加载失败，不影响连接列表使用"));
  });
  try {
    const query = new URLSearchParams({ type: "database" });
    if (props.environmentId) query.set("environmentId", props.environmentId);
    const [response, groups] = await Promise.all([
      api<{ items: DatabaseConnection[] }>(`/api/v1/connections?${query.toString()}&includeProfiles=true`),
      api<{ items: ConnectionGroupItem[] }>("/api/v1/connection-groups?type=database"),
    ]);
    connections.value = response.items;
    connectionGroups.value = groups.items;
    initialConnection = connections.value.find((item) => item.id === props.initialConnectionId);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载数据库连接失败"));
  } finally {
    loading.value = false;
  }
  if (initialConnection && selectedConnectionId.value !== initialConnection.id) await selectConnection(initialConnection);
}

async function showConnectionError(error: unknown, fallback: string): Promise<void> {
  if (!(error instanceof ApiError) || error.code !== "DESKTOP_LOCAL_NETWORK_UNREACHABLE") {
    ElMessage.error(error instanceof Error ? error.message : fallback);
    return;
  }
  try {
    await ElMessageBox.confirm(
      error.message,
      tr("无法访问局域网数据库"),
      {
        confirmButtonText: tr("打开系统设置"),
        cancelButtonText: tr("稍后处理"),
        distinguishCancelAndClose: true,
        type: "warning",
      },
    );
  } catch (action) {
    if (action === "cancel" || action === "close") return;
    ElMessage.error(action instanceof Error ? action.message : tr("无法显示本地网络权限提醒"));
    return;
  }
  try {
    await openMacosLocalNetworkSettings();
  } catch (openError) {
    ElMessage.error(openError instanceof Error ? openError.message : tr("无法打开 macOS 本地网络设置"));
  }
}

async function selectConnection(connection: DatabaseConnection, useDefaultProfile = true): Promise<boolean> {
  const root = connection.profileParentId ? connections.value.find((item) => item.id === connection.profileParentId) ?? connection : connection;
  const configuredProfileId = useDefaultProfile && !connection.profileParentId ? String(connection.options.activeProfileId ?? "") : "";
  const target = configuredProfileId
    ? connections.value.find((item) => item.id === configuredProfileId && item.profileParentId === root.id) ?? connection
    : connection;
  focusedConnectionId.value = root.id;
  if (selectedConnectionId.value === target.id && databaseConnected.value) return true;
  const reconnecting = selectedConnectionId.value === target.id && Boolean(schemas.value.length || tabs.value.length);
  if (databaseSessionId.value) await api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
  selectedConnectionId.value = target.id;
  if (!reconnecting) resetDatabaseWorkspace();
  connecting.value = true;
  try {
    const runtime = await api<{ item: { id: string } }>("/api/v1/database-sessions", {
      method: "POST",
      body: JSON.stringify({ connectionId: target.id, originEnvironmentId: props.environmentId }),
    });
    databaseSessionId.value = runtime.item.id;
    rememberActiveConnectionOrigin(runtime.item.id, props.environmentId);
    const response = await api<{ items: SchemaItem[] }>(`/api/v1/database-connections/${target.id}/schemas`);
    schemas.value = response.items;
    await Promise.all([loadHistory(), loadFavorites(), loadSavedQueries(), loadDatabaseTasks(), loadObjectGroups()]);
    setConnectionCollapsed(root.id, false);
    ElMessage.success(tr("已连接 {0}{1}", [root.name, target.profileName ? ` · ${target.profileName}` : ""]));
    return true;
  } catch (error) {
    if (databaseSessionId.value) await api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
    databaseSessionId.value = "";
    await showConnectionError(error, tr("数据库连接失败"));
    return false;
  } finally {
    connecting.value = false;
  }
}

async function closeConnection(connection: DatabaseConnection) {
  if (activeRootConnectionId.value !== connection.id && selectedConnectionId.value !== connection.id) return;
  const runningJobs = tabs.value
    .map((tab) => tab.job)
    .filter((job): job is QueryJob => job !== null && Boolean(job.id) && ["pending", "running"].includes(job.status));

  if (runningJobs.length) {
    try {
      await ElMessageBox.confirm(
        tr("关闭“{0}”会同时取消 {1} 个正在运行的查询。", [connection.name, runningJobs.length]),
        tr("关闭数据库连接"),
        { confirmButtonText: tr("关闭连接"), cancelButtonText: tr("取消"), type: "warning" },
      );
    } catch (error) {
      if (error === "cancel" || error === "close") return;
      ElMessage.error(error instanceof Error ? error.message : tr("无法确认关闭数据库连接"));
      return;
    }
  }

  const cancellationResults = await Promise.allSettled(
    runningJobs.map((job) => api(`/api/v1/database-queries/${job.id}`, { method: "DELETE" })),
  );
  if (isDesktopApp()) {
    const agentConnectionId = selectedConnectionId.value || connection.id;
    await stopDesktopAgentResourceRuns({ kind: "database", resourceId: agentConnectionId }).catch(() => undefined);
  }
  for (const timer of pollTimers) window.clearInterval(timer);
  pollTimers.clear();
  for (const tab of tabs.value) {
    if (tab.job && ["pending", "running"].includes(tab.job.status)) {
      tab.job = { ...tab.job, status: "cancelled", error: tr("数据库连接已关闭") };
    }
  }
  if (databaseSessionId.value) await api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
  databaseSessionId.value = "";
  selectedConnectionId.value = "";
  if (focusedConnectionId.value === (connection.profileParentId || connection.id)) focusedConnectionId.value = "";
  setConnectionCollapsed(connection.profileParentId || connection.id, false);
  resetDatabaseWorkspace(false);

  const failedCancellations = cancellationResults.filter((result) => result.status === "rejected").length;
  if (failedCancellations) ElMessage.warning(tr("数据库工作区已关闭，{0} 个查询的取消状态未能确认", [failedCancellations]));
  else ElMessage.success(tr("已关闭 {0}", [connection.name]));
}

function editConnection(connection: DatabaseConnection) {
  editingConnection.value = connection;
  copyConnectionMode.value = false;
  connectionProfileParentId.value = connection.profileParentId ?? "";
  connectionEditorOpen.value = true;
}

function copyConnection(connection: DatabaseConnection) {
  editingConnection.value = connection;
  copyConnectionMode.value = true;
  connectionProfileParentId.value = "";
  connectionEditorOpen.value = true;
}

function createConnection() {
  editingConnection.value = null;
  copyConnectionMode.value = false;
  connectionProfileParentId.value = "";
  connectionEditorOpen.value = true;
}

function createConnectionProfile(connection: DatabaseConnection) {
  if (databaseConnected.value && activeRootConnectionId.value === connection.id) {
    ElMessage.warning(tr("要创建新的连接配置文件，必须关闭连接"));
    return;
  }
  editingConnection.value = connection;
  copyConnectionMode.value = false;
  connectionProfileParentId.value = connection.id;
  connectionEditorOpen.value = true;
}

async function switchConnectionProfile(root: DatabaseConnection, profileId: string | null) {
  const target = profileId ? connections.value.find((item) => item.id === profileId && item.profileParentId === root.id) : root;
  if (!target) return ElMessage.warning(tr("连接配置文件不存在"));
  if (selectedConnectionId.value === target.id && databaseConnected.value) return;
  if (databaseConnected.value && activeRootConnectionId.value === root.id) {
    ElMessage.warning(tr("要切换连接配置文件，必须关闭连接"));
    return;
  }
  try {
    await ElMessageBox.confirm(
      tr("你确定要将连接配置文件切换到“{0}”吗？", [target.profileName || tr("主要配置文件")]),
      tr("切换连接配置文件"),
      { confirmButtonText: tr("切换"), cancelButtonText: tr("取消"), type: "warning" },
    );
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    throw error;
  }
  await selectConnection(target, false);
}

async function refreshConnectionProfileEditor(rootId: string, profileId?: string) {
  await refreshConnections();
  editingConnection.value = connections.value.find((item) => item.id === (profileId || rootId)) ?? null;
  connectionProfileParentId.value = profileId ? rootId : "";
}

async function handleConnectionProfileAction(action: "create" | "edit" | "duplicate" | "delete" | "set-active", profileId?: string) {
  const root = editingRootConnection.value;
  if (!root) return;
  if (databaseConnected.value && activeRootConnectionId.value === root.id) {
    ElMessage.warning(action === "set-active" ? tr("要切换连接配置文件，必须关闭连接") : tr("要修改连接配置文件，必须关闭连接"));
    return;
  }
  const profile = profileId ? connections.value.find((item) => item.id === profileId && item.profileParentId === root.id) : null;
  if (action === "create") {
    createConnectionProfile(root);
    return;
  }
  if (action === "edit" && profile) {
    editingConnection.value = profile;
    connectionProfileParentId.value = root.id;
    return;
  }
  if (action === "set-active") {
    try {
      await api(`/api/v1/database-connections/${root.id}/profiles/active`, {
        method: "PUT",
        body: JSON.stringify({ profileId: profile?.id ?? null }),
      });
      await refreshConnectionProfileEditor(root.id);
      ElMessage.success(profile ? tr("已将 {0} 设为活动配置文件", [profile.profileName]) : tr("已将主要配置文件设为活动配置"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("无法设置活动连接配置文件"));
    }
    return;
  }
  if (!profile) return;
  if (action === "duplicate") {
    try {
      const result = await ElMessageBox.prompt(tr("请输入配置文件副本名称"), tr("复制配置文件"), {
        confirmButtonText: tr("复制"),
        cancelButtonText: tr("取消"),
        inputValue: tr("{0} 副本", [profile.profileName || profile.name]),
        inputValidator: (value) => Boolean(value.trim()) && value.trim().length <= 160 || tr("配置文件名称需为 1–160 个字符"),
      });
      await api(`/api/v1/database-connections/${root.id}/profiles/${profile.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ profileName: result.value.trim() }),
      });
      await refreshConnectionProfileEditor(root.id);
      ElMessage.success(tr("连接配置文件已复制"));
    } catch (error) {
      if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("无法复制连接配置文件"));
    }
    return;
  }
  try {
    await ElMessageBox.confirm(tr("确定删除连接配置文件“{0}”吗？", [profile.profileName || profile.name]), tr("删除配置文件"), {
      confirmButtonText: tr("删除"),
      cancelButtonText: tr("取消"),
      type: "warning",
    });
    await api(`/api/v1/database-connections/${root.id}/profiles/${profile.id}`, { method: "DELETE" });
    await refreshConnectionProfileEditor(root.id);
    ElMessage.success(tr("连接配置文件已删除"));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("无法删除连接配置文件"));
  }
}

function focusConnection(connection: DatabaseConnection) {
  focusedConnectionId.value = connection.id;
}

function selectConnectionById(connectionId: string) {
  const connection = connections.value.find((item) => item.id === connectionId);
  if (connection) void selectConnection(connection);
}

async function refreshConnections() {
  const query = new URLSearchParams({ type: "database" });
  if (props.environmentId) query.set("environmentId", props.environmentId);
  const [response, groups] = await Promise.all([
    api<{ items: DatabaseConnection[] }>(`/api/v1/connections?${query.toString()}&includeProfiles=true`),
    api<{ items: ConnectionGroupItem[] }>("/api/v1/connection-groups?type=database"),
  ]);
  connections.value = response.items;
  connectionGroups.value = groups.items;
  if (focusedConnectionId.value && !connections.value.some((item) => !item.profileParentId && item.id === focusedConnectionId.value)) {
    focusedConnectionId.value = "";
  }
  await loadObjectFavorites();
}

async function updateConnectionPreference(connection: DatabaseConnection, preference: { starred?: boolean; color?: string }) {
  try {
    const response = await api<{ starred: boolean; color: string }>(`/api/v1/database-connections/${connection.id}/preferences`, { method: "PUT", body: JSON.stringify(preference) });
    connection.starred = response.starred;
    connection.color = response.color;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("更新连接偏好失败"));
  }
}

function connectionUpdateBody(connection: DatabaseConnection, connectionGroupId: string | null) {
  return {
    environmentIds: connection.environmentIds,
    connectionGroupId,
    name: connection.name,
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    defaultDatabase: connection.defaultDatabase,
    connectionMode: connection.connectionMode,
    options: connection.options,
  };
}

async function moveConnectionToGroup(connection: DatabaseConnection, connectionGroupId: string | null) {
  if (!connection.canManage) return ElMessage.warning(tr("只有工作空间管理员可以移动连接"));
  try {
    await api(`/api/v1/database-connections/${connection.id}`, { method: "PUT", body: JSON.stringify(connectionUpdateBody(connection, connectionGroupId)) });
    await refreshConnections();
    ElMessage.success(connectionGroupId ? tr("连接已添加到组") : tr("连接已从组中排除"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("移动连接失败"));
  }
}

async function createConnectionGroup() {
  try {
    const response = await ElMessageBox.prompt(tr("请输入连接组名称"), tr("新建组"), { confirmButtonText: tr("创建"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入连接组名称") });
    await api("/api/v1/connection-groups", { method: "POST", body: JSON.stringify({ type: "database", parentId: null, name: response.value.trim() }) });
    await refreshConnections();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("新建连接组失败"));
  }
}

async function openConnectionShare(connection = selectedRootConnection.value) {
  if (!connection || session.workspace?.type !== "organization" || session.workspace.role !== "admin") return ElMessage.warning(tr("请切换到具有管理权限的组织工作空间"));
  shareConnection.value = connection;
  shareGrantee.value = "";
  shareDialogOpen.value = true;
  shareDialogLoading.value = true;
  try {
    shareDetail.value = await api<OrganizationShareDetail>(`/api/v1/organizations/${session.workspace.id}`);
  } catch (error) {
    shareDialogOpen.value = false;
    ElMessage.error(error instanceof Error ? error.message : tr("加载共享设置失败"));
  } finally {
    shareDialogLoading.value = false;
  }
}

async function grantSharedConnection() {
  const connection = shareConnection.value;
  const workspace = session.workspace;
  const candidate = shareCandidates.value.find((item) => item.key === shareGrantee.value);
  if (!connection || workspace?.type !== "organization" || !candidate) return;
  try {
    await api(`/api/v1/organizations/${workspace.id}/grants`, { method: "POST", body: JSON.stringify({ granteeType: candidate.type, granteeId: candidate.id, resourceType: "database_connection", resourceId: connection.id }) });
    shareDetail.value = await api<OrganizationShareDetail>(`/api/v1/organizations/${workspace.id}`);
    shareGrantee.value = "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("共享连接失败"));
  }
}

async function revokeSharedConnection(grant: OrganizationGrant) {
  const workspace = session.workspace;
  if (workspace?.type !== "organization") return;
  try {
    await api(`/api/v1/organizations/${workspace.id}/grants/${grant.id}`, { method: "DELETE" });
    shareDetail.value = await api<OrganizationShareDetail>(`/api/v1/organizations/${workspace.id}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("撤销共享失败"));
  }
}

function openConnectionContextMenu(event: MouseEvent, connection: DatabaseConnection) {
  event.preventDefault();
  event.stopPropagation();
  focusConnection(connection);
  navigatorMenu.value = { visible: false, x: event.clientX, y: event.clientY, target: { kind: "connection", connectionId: connection.id } };
  void nextTick(() => {
    navigatorMenu.value = { visible: true, x: event.clientX, y: event.clientY, target: { kind: "connection", connectionId: connection.id } };
  });
}

async function deleteConnection(connection: DatabaseConnection) {
  try {
    await ElMessageBox.confirm(tr("确定删除连接“{0}”吗？凭据也会一并删除。", [connection.name]), tr("删除连接"), {
      confirmButtonText: tr("删除"),
      cancelButtonText: tr("取消"),
      type: "warning",
    });
    if (activeRootConnectionId.value === connection.id && databaseConnected.value) await closeConnection(connection);
    await api(`/api/v1/database-connections/${connection.id}`, { method: "DELETE" });
    ElMessage.success(tr("连接已删除"));
    await refreshConnections();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除连接失败"));
  }
}

function collapseAllNavigation() {
  expandedDatabases.value = new Set();
  expandedCategories.value = new Set();
  collapsedConnectionGroups.value = new Set(groupedConnections.value.map((group) => group.path));
  selectedDatabase.value = "";
  navigatorTarget.value = "";
}

async function refreshSchemas() {
  if (!selectedConnection.value || !databaseConnected.value) return ElMessage.warning(tr("数据库连接已断开，请先重新连接"));
  connecting.value = true;
  try {
    const response = await api<{ items: SchemaItem[] }>(`/api/v1/database-connections/${selectedConnection.value.id}/schemas`);
    schemas.value = response.items;
    sqlCompletionCatalogs.value = {};
    const available = new Set(response.items.map((schema) => schema.name));
    expandedDatabases.value = new Set([...expandedDatabases.value].filter((database) => available.has(database)));
    if (selectedDatabase.value && !available.has(selectedDatabase.value)) selectedDatabase.value = "";
    objects.value = {};
    expandedCategories.value = new Set();
    if (selectedDatabase.value && expandedDatabases.value.has(selectedDatabase.value)) await loadDatabaseObjects(selectedDatabase.value);
    ElMessage.success(tr("数据库对象已刷新"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("刷新数据库对象失败"));
  } finally {
    connecting.value = false;
  }
}

async function testConnection(connection: DatabaseConnection) {
  connecting.value = true;
  try {
    const response = await api<{ version: string; latencyMs: number }>(`/api/v1/database-connections/${connection.id}/test`, { method: "POST" });
    ElMessage.success(tr("连接成功 · {0} · {1} ms", [response.version, response.latencyMs]));
  } catch (error) {
    await showConnectionError(error, tr("连接测试失败"));
  } finally {
    connecting.value = false;
  }
}

async function loadDatabaseObjects(database: string, force = false) {
  if (objects.value[database] && !force) return;
  objectLoading.value = database;
  const categoryMap: Partial<Record<BrowserCategory, DatabaseObject[]>> = {};
  const sourceMap = new Map<ObjectCategory, DatabaseObject[]>();
  const sources = [...new Set(objectCategories.flatMap((category) => category.sources))];
  let failedCategories = 0;
  await Promise.all(sources.map(async (source) => {
    try {
      const response = await api<{ items: DatabaseObject[] }>(`/api/v1/database-connections/${selectedConnectionId.value}/objects?database=${encodeURIComponent(database)}&category=${source}`);
      sourceMap.set(source, response.items.map((item) => ({ ...item, sourceCategory: source })));
    } catch {
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
    if (activeTab.value?.kind === "sql" && activeTab.value.database === database) void loadSqlCompletionCatalog(database);
  }
  objectLoading.value = "";
  if (failedCategories === sources.length) ElMessage.warning(tr("无法读取 {0} 的数据库对象", [database]));
}

async function loadSqlCompletionCatalog(database: string, force = false) {
  if (!database || !selectedConnectionId.value || !databaseConnected.value) return;
  if (sqlCompletionCatalogs.value[database] && !force) return;
  const connectionId = selectedConnectionId.value;
  const loadingKey = `${connectionId}\0${database}`;
  if (sqlCompletionLoading.has(loadingKey)) return;
  sqlCompletionLoading.add(loadingKey);
  try {
    const catalog = await api<SqlCompletionCatalog>(`/api/v1/database-connections/${connectionId}/completion-metadata?database=${encodeURIComponent(database)}`);
    if (selectedConnectionId.value === connectionId) sqlCompletionCatalogs.value = { ...sqlCompletionCatalogs.value, [database]: catalog };
  } catch {
    // SQL editing remains available when metadata cannot be read.
  } finally {
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
    if (selectedDatabase.value === database) selectedDatabase.value = "";
    return;
  }
  next.add(database);
  expandedDatabases.value = next;
  selectedDatabase.value = database;
  await loadDatabaseObjects(database);
}

function objectFavorite(targetType: "database" | "table", database: string, table = "") {
  return objectFavorites.value.find((item) => (
    item.connectionId === selectedConnectionId.value
    && item.targetType === targetType
    && item.database === database
    && item.table === (targetType === "table" ? table : "")
  ));
}

async function loadObjectFavorites() {
  const response = await api<{ items: ObjectFavoriteItem[] }>("/api/v1/database-object-favorites");
  objectFavorites.value = response.items;
}

async function loadObjectGroups() {
  if (!selectedConnectionId.value) {
    objectGroups.value = [];
    return;
  }
  const response = await api<{ items: ObjectGroupItem[] }>(`/api/v1/database-object-groups?connectionId=${encodeURIComponent(selectedConnectionId.value)}`);
  objectGroups.value = response.items;
}

function objectGroup(database: string, category: NavigatorCategoryKey, item: DatabaseObject | { name: string; sourceCategory?: string }) {
  return objectGroups.value.find((group) => group.database === database && group.category === category && group.members.some((member) => member.objectName === item.name && member.objectSource === (item.sourceCategory || "")));
}

async function createObjectGroup(target: DatabaseNavigatorTarget): Promise<ObjectGroupItem | null> {
  if (!selectedConnectionId.value || !target.category) return null;
  try {
    const response = await ElMessageBox.prompt(tr("请输入对象组名称"), tr("新建组"), { confirmButtonText: tr("新建"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入组名称") });
    const name = response.value.trim();
    const existing = objectGroups.value.find((group) => group.database === target.database && group.category === target.category && group.name === name);
    if (existing) return existing;
    await api("/api/v1/database-object-groups", { method: "POST", body: JSON.stringify({ connectionId: selectedConnectionId.value, database: target.database, category: target.category, name }) });
    await loadObjectGroups();
    return objectGroups.value.find((group) => group.database === target.database && group.category === target.category && group.name === name) ?? null;
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("新建对象组失败"));
    return null;
  }
}

async function addNavigatorObjectToGroup(target: DatabaseNavigatorTarget) {
  if (!target.category || !target.objectName) return;
  const candidates = objectGroups.value.filter((group) => group.database === target.database && group.category === target.category);
  let group: ObjectGroupItem | null = null;
  try {
    const response = await ElMessageBox.prompt(
      candidates.length ? tr("请输入目标组名称。可选：{0}", [candidates.map((item) => item.name).join("、")]) : tr("当前分类没有对象组，输入名称将新建组。"),
      tr("添加到组"),
      { confirmButtonText: tr("添加"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入组名称") },
    );
    const name = response.value.trim();
    group = candidates.find((item) => item.name === name) ?? null;
    if (!group) {
      await api("/api/v1/database-object-groups", { method: "POST", body: JSON.stringify({ connectionId: selectedConnectionId.value, database: target.database, category: target.category, name }) });
      await loadObjectGroups();
      group = objectGroups.value.find((item) => item.database === target.database && item.category === target.category && item.name === name) ?? null;
    }
    if (!group) throw new Error(tr("对象组不存在"));
    await api(`/api/v1/database-object-groups/${group.id}/members`, { method: "POST", body: JSON.stringify({ objectName: target.objectName, objectSource: target.objectSource || "" }) });
    await loadObjectGroups();
    ElMessage.success(tr("已添加到组 {0}", [group.name]));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("添加对象组失败"));
  }
}

async function excludeNavigatorObjectFromGroup(target: DatabaseNavigatorTarget) {
  if (!target.category || !target.objectName) return;
  const group = objectGroups.value.find((item) => item.database === target.database && item.category === target.category && item.members.some((member) => member.objectName === target.objectName && member.objectSource === (target.objectSource || "")));
  if (!group) return ElMessage.warning(tr("当前对象不属于任何组"));
  const query = new URLSearchParams({ objectName: target.objectName, objectSource: target.objectSource || "" });
  await api(`/api/v1/database-object-groups/${group.id}/members?${query}`, { method: "DELETE" });
  await loadObjectGroups();
  ElMessage.success(tr("已从组 {0} 中排除", [group.name]));
}

async function toggleObjectFavorite(targetType: "database" | "table", database: string, table = "") {
  if (!selectedConnectionId.value) return;
  const existing = objectFavorite(targetType, database, table);
  try {
    if (existing) {
      await api(`/api/v1/database-object-favorites/${existing.id}`, { method: "DELETE" });
      ElMessage.success(targetType === "table" ? tr("已取消收藏数据表") : tr("已取消收藏数据库"));
    } else {
      await api("/api/v1/database-object-favorites", {
        method: "POST",
        body: JSON.stringify({ connectionId: selectedConnectionId.value, targetType, database, table }),
      });
      ElMessage.success(targetType === "table" ? tr("数据表已收藏") : tr("数据库已收藏"));
    }
    await loadObjectFavorites();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("更新数据库收藏失败"));
  }
}

async function removeObjectFavorite(item: ObjectFavoriteItem) {
  try {
    await api(`/api/v1/database-object-favorites/${item.id}`, { method: "DELETE" });
    await loadObjectFavorites();
    ElMessage.success(item.targetType === "table" ? tr("已取消收藏数据表") : tr("已取消收藏数据库"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("取消数据库收藏失败"));
  }
}

async function openObjectFavorite(item: ObjectFavoriteItem) {
  const connection = connections.value.find((candidate) => candidate.id === item.connectionId);
  if (!connection) return ElMessage.warning(tr("当前工作台无法访问该收藏连接"));
  const connected = (selectedConnectionId.value === connection.id && databaseConnected.value) || await selectConnection(connection);
  if (!connected) return;
  const schemaExists = schemas.value.some((schema) => schema.name === item.database);
  if (!schemaExists) return ElMessage.warning(tr("数据库 {0} 不存在或当前账号无权访问", [item.database]));
  await toggleDatabase(item.database, true);
  if (item.targetType === "table") {
    const tableExists = (objects.value[item.database]?.tables ?? []).some((table) => table.name === item.table);
    if (!tableExists) return ElMessage.warning(tr("数据表 {0}.{1} 不存在或当前账号无权访问", [item.database, item.table]));
    const nextCategories = new Set(expandedCategories.value);
    nextCategories.add(categoryKey(item.database, "tables"));
    expandedCategories.value = nextCategories;
    newDataTab(item.database, item.table, false);
    navigatorTarget.value = `object:${item.database}:tables:${item.table}`;
  } else {
    await openCategory(item.database, objectCategories[0]);
    navigatorTarget.value = `database:${item.database}`;
  }
  await nextTick();
  const target = [...(workbenchElement.value?.querySelectorAll<HTMLElement>("[data-navigator-target]") ?? [])]
    .find((element) => element.dataset.navigatorTarget === navigatorTarget.value);
  target?.scrollIntoView({ block: "center" });
}

async function openCategory(database: string, category: NavigatorCategory) {
  selectedDatabase.value = database;
  if (category.key === "queries") {
    taskPanel.value = false;
    sidePanel.value = "";
    await loadSavedQueries();
    newUtilityTab(database, "queries");
    return;
  }
  if (category.key === "backups") {
    sidePanel.value = "";
    taskPanel.value = false;
    await loadDatabaseTasks();
    newUtilityTab(database, "backups");
    return;
  }
  await loadDatabaseObjects(database);
  newObjectTab(database, category);
}

async function toggleCategory(database: string, category: NavigatorCategory) {
  const key = categoryKey(database, category.key);
  const next = new Set(expandedCategories.value);
  if (next.has(key)) next.delete(key);
  else {
    next.add(key);
    if (isObjectCategory(category)) await loadDatabaseObjects(database);
    else if (category.key === "queries") await loadSavedQueries();
    else await loadDatabaseTasks();
  }
  expandedCategories.value = next;
}

async function openNavigatorObject(database: string, category: NavigatorCategory, item: DatabaseObject) {
  if (isObjectCategory(category)) await openObject(database, category, item);
}

function selectNavigatorObject(database: string, category: NavigatorCategory, item: DatabaseObject) {
  if (!isObjectCategory(category)) return;
  selectedDatabase.value = database;
  navigatorTarget.value = `object:${database}:${category.key}:${item.name}`;
  selectedObjects.value = { ...selectedObjects.value, [`${database}:${category.key}`]: item.name };
  const objectTab = tabs.value.find((tab) => tab.kind === "objects");
  if (objectTab) {
    objectTab.database = database;
    objectTab.category = category.key;
    objectTab.title = tr("对象");
  }
}

async function showNavigatorDdl(database: string, category: NavigatorCategory, item: DatabaseObject) {
  if (isObjectCategory(category)) await showDdl(database, category, item);
}

async function refreshObjectCategory(tab: QueryTab) {
  if (!tab.category) return;
  await loadDatabaseObjects(tab.database, true);
}

function sqlIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function selectedCategoryContext() {
  const tab = activeTab.value;
  if (!tab || tab.kind !== "objects" || !tab.category) return null;
  return { tab, category: categoryDefinition(tab.category), item: selectedObject(tab) };
}

function selectedTableContext() {
  const activeContext = selectedCategoryContext();
  if (activeContext?.tab.category === "tables" && activeContext.item) {
    return { database: activeContext.tab.database, item: activeContext.item };
  }
  const database = selectedDatabase.value || activeTab.value?.database || "";
  const item = database ? selectedObjectInCategory(database, "tables") : null;
  return item ? { database, item } : null;
}

function currentTableContext() {
  const tab = activeTab.value;
  if (tab?.kind === "data" && tab.table && !tab.readOnly) {
    const item = (objects.value[tab.database]?.tables ?? []).find((candidate) => candidate.name === tab.table) ?? { name: tab.table };
    return { database: tab.database, item };
  }
  return selectedTableContext();
}

async function openSelectedObject() {
  const context = selectedCategoryContext();
  if (!context?.item) return ElMessage.warning(tr("请先选择一个对象"));
  await openObject(context.tab.database, context.category, context.item);
}

async function designSelectedObject() {
  const context = selectedCategoryContext();
  if (!context?.item) return ElMessage.warning(tr("请先选择一个对象"));
  if (context.category.key === "tables") newTableDesigner(context.tab.database, context.item.name);
  else await showDdl(context.tab.database, context.category, context.item);
}

function designSelectedTable() {
  const context = selectedTableContext();
  if (!context) return ElMessage.warning(tr("请先选择一个表"));
  newTableDesigner(context.database, context.item.name);
}

function designCurrentTable() {
  const context = currentTableContext();
  if (!context) return ElMessage.warning(tr("请先打开或选择一个表"));
  newTableDesigner(context.database, context.item.name);
}

function createObjectTemplate(databaseName?: string, categoryKeyValue?: BrowserCategory) {
  const context = selectedCategoryContext();
  const targetDatabase = databaseName ?? context?.tab.database;
  const targetCategory = categoryKeyValue ?? context?.tab.category;
  if (!targetDatabase || !targetCategory) return;
  if (targetCategory === "tables") {
    newTableDesigner(targetDatabase);
    return;
  }
  const database = sqlIdentifier(targetDatabase);
  const templates: Record<BrowserCategory, string> = {
    tables: "",
    views: `CREATE VIEW ${database}.\`new_view\` AS\nSELECT 1 AS value;`,
    functions: `DELIMITER //\nCREATE FUNCTION ${database}.\`new_function\`() RETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN 1;\nEND //\nDELIMITER ;`,
    events: `CREATE EVENT ${database}.\`new_event\`\nON SCHEDULE EVERY 1 DAY\nDO SELECT 1;`,
  };
  newTab(templates[targetCategory], targetDatabase, tr("新建{0}", [categoryDefinition(targetCategory).label]));
}

function setTableDesignerDirty(tab: QueryTab, dirty: boolean) {
  tab.dirty = dirty;
}

async function handleTableDesignerSaved(tab: QueryTab, payload: { tableName: string; existing: boolean }) {
  tab.dirty = false;
  await loadDatabaseObjects(tab.database, true);
  await loadSqlCompletionCatalog(tab.database, true);
  const next = new Set(expandedCategories.value);
  next.add(categoryKey(tab.database, "tables"));
  expandedCategories.value = next;
  if (payload.existing) {
    tab.title = tr("设计 {0}@{1}", [payload.tableName, tab.database]);
    return;
  }
  const index = tabs.value.findIndex((item) => item.id === tab.id);
  if (index >= 0) tabs.value.splice(index, 1);
  newDataTab(tab.database, payload.tableName, false);
}

async function waitForQueryJob(jobId: string): Promise<QueryJob> {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const response = await api<{ job: QueryJob }>(`/api/v1/database-queries/${jobId}`);
    if (!["pending", "running"].includes(response.job.status)) return response.job;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(tr("等待数据库操作完成超时"));
}

async function deleteObject(database: string, category: ObjectCategoryDefinition, item: DatabaseObject) {
  if (!selectedConnectionId.value) return ElMessage.warning(tr("请先连接数据库"));
  const objectType: Record<ObjectCategory, string> = {
    tables: "TABLE",
    views: "VIEW",
    procedures: "PROCEDURE",
    functions: "FUNCTION",
    triggers: "TRIGGER",
    events: "EVENT",
  };
  try {
    await ElMessageBox.confirm(
      tr("确定删除 {0}“{1}”吗？该操作会立即写入数据库且不可撤销。", [objectCategoryLabel(item, category), item.name]),
      tr("删除{0}", [objectCategoryLabel(item, category)]),
      { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "error" },
    );
    objectLoading.value = database;
    const response = await api<{ job: QueryJob }>(`/api/v1/database-connections/${selectedConnectionId.value}/queries`, {
      method: "POST",
      body: JSON.stringify({
        sql: `DROP ${objectType[item.sourceCategory ?? category.key]} ${sqlIdentifier(database)}.${sqlIdentifier(item.name)}`,
        database,
      }),
    });
    const job = await waitForQueryJob(response.job.id);
    if (job.status !== "success") throw new Error(job.error || tr("删除{0}失败", [category.label]));
    tabs.value = tabs.value.filter((tab) => !(tab.kind === "data" && tab.database === database && tab.table === item.name));
    selectedObjects.value = { ...selectedObjects.value, [`${database}:${category.key}`]: "" };
    await loadDatabaseObjects(database, true);
    ElMessage.success(tr("{0}已删除", [objectCategoryLabel(item, category)]));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除{0}失败", [category.label]));
  } finally {
    objectLoading.value = "";
  }
}

async function deleteSelectedObject() {
  const context = selectedCategoryContext();
  if (!context?.item) return ElMessage.warning(tr("请先选择要删除的对象"));
  await deleteObject(context.tab.database, context.category, context.item);
}

function removeTabsForDatabase(database: string) {
  const activeWasRemoved = activeTab.value?.database === database;
  tabs.value = tabs.value.filter((tab) => tab.database !== database);
  if (activeWasRemoved || !tabs.value.some((tab) => tab.id === activeTabId.value)) {
    activeTabId.value = tabs.value[0]?.id ?? "";
  }
}

function clearDatabaseLocalState(database: string) {
  delete objects.value[database];
  delete sqlCompletionCatalogs.value[database];
  selectedObjects.value = Object.fromEntries(Object.entries(selectedObjects.value).filter(([key]) => !key.startsWith(`${database}:`)));
  selectedUtilityItems.value = Object.fromEntries(Object.entries(selectedUtilityItems.value).filter(([key]) => !key.startsWith(`${database}:`)));
  expandedCategories.value = new Set([...expandedCategories.value].filter((key) => !key.startsWith(`${database}:`)));
  databaseTasks.value = databaseTasks.value.filter((task) => task.details.database !== database && task.details.sourceDatabase !== database && task.details.targetDatabase !== database);
}

function triggerSelectedTableAction(type: "import" | "export", format?: "csv" | "xlsx" | "sql") {
  const context = selectedTableContext();
  if (!context) return ElMessage.warning(tr("请先选择一个表"));
  const tab = newDataTab(context.database, context.item.name, false);
  tab.tableAction = { id: createClientId(), type, format };
}

function clearTableAction(id: string) {
  const tab = tabs.value.find((candidate) => candidate.tableAction?.id === id);
  if (tab) delete tab.tableAction;
}

async function refreshUtilityTab(tab = activeTab.value) {
  if (tab?.kind !== "utility" || !tab.utilityCategory) return;
  if (tab.utilityCategory === "queries") await loadSavedQueries();
  else await loadDatabaseTasks();
}

function createFromUtilityTab(tab = activeTab.value) {
  if (tab?.kind !== "utility" || !tab.utilityCategory) return;
  if (tab.utilityCategory === "queries") newTab("", tab.database);
  else void startDatabaseBackup(tab.database);
}

function closeTaskPanelRequest(id: string) {
  if (taskPanelRequest.value?.id === id) taskPanelRequest.value = undefined;
}

function openTaskPanel(database: string, type: "restore" | "list" | "transfer" = "list") {
  selectedDatabase.value = database;
  sidePanel.value = "";
  taskPanel.value = true;
  taskPanelRequest.value = { id: createClientId(), type };
}

function requireSelectedDatabase(): string | null {
  if (!selectedConnection.value || !databaseConnected.value) {
    ElMessage.warning(tr("请先双击打开数据库连接"));
    return null;
  }
  if (!selectedDatabase.value) {
    ElMessage.warning(tr("请先选择数据库"));
    return null;
  }
  return selectedDatabase.value;
}

async function openGlobalCategory(key: BrowserCategory | UtilityCategory) {
  const database = requireSelectedDatabase();
  if (!database) return;
  const category = categories.find((item) => item.key === key);
  if (category) await openCategory(database, category);
}

function handleGlobalTableCommand(command: string) {
  const database = requireSelectedDatabase();
  if (!database) return;
  if (command === "open") void openGlobalCategory("tables");
  else if (command === "new") createObjectTemplate(database, "tables");
  else if (command === "design") designSelectedTable();
  else if (command === "import") triggerSelectedTableAction("import");
  else if (["csv", "xlsx", "sql"].includes(command)) triggerSelectedTableAction("export", command as "csv" | "xlsx" | "sql");
}

function handleGlobalConnectionCommand(command: string) {
  const connection = selectedRootConnection.value ?? connections.value.find((item) => !item.profileParentId && item.id === focusedConnectionId.value) ?? null;
  if (command === "new") createConnection();
  else if (command === "refresh") void refreshConnections();
  else if (command === "edit" && connection) editConnection(connection);
  else if (command === "duplicate" && connection) copyConnection(connection);
  else if (command === "close" && connection) void closeConnection(connection);
}

function handleGlobalQueryCommand(command: string) {
  if (command === "new") newTab("", selectedDatabase.value);
  else if (command === "queries") void openGlobalCategory("queries");
}

function handleGlobalBackupCommand(command: string) {
  const database = requireSelectedDatabase();
  if (!database) return;
  if (command === "new") void startDatabaseBackup(database);
  else if (command === "restore") openTaskPanel(database, "restore");
  else if (command === "list") void openGlobalCategory("backups");
}

function openSyncDialog(mode: "data" | "structure") {
  if (!requireSelectedDatabase()) return;
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
  const database = requireSelectedDatabase();
  if (!database) return;
  if (command === "tasks") openTaskPanel(database);
  else if (command === "restore") openTaskPanel(database, "restore");
  else if (command === "transfer") openTaskPanel(database, "transfer");
  else if (command === "data-sync") openSyncDialog("data");
  else if (command === "structure-sync") openSyncDialog("structure");
}

async function loadInformationDdl() {
  informationPaneTab.value = "ddl";
  informationDdl.value = "";
  const tab = activeTab.value;
  if (tab?.kind === "sql") {
    informationDdl.value = tab.sql || tr("-- 当前查询为空");
    return;
  }
  if (!selectedConnectionId.value || !databaseConnected.value) return;
  let database = tab?.database || selectedDatabase.value;
  let type = "";
  let name = "";
  if (tab?.kind === "data" && tab.table) {
    type = tab.readOnly ? "view" : "table";
    name = tab.table;
  } else if (tab?.kind === "objects" && tab.category) {
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
    const response = await api<{ ddl: string }>(`/api/v1/database-connections/${selectedConnectionId.value}/ddl?database=${encodeURIComponent(database)}&type=${type}&name=${encodeURIComponent(name)}`);
    informationDdl.value = response.ddl ? `${response.ddl};` : tr("-- 未返回 DDL");
  } catch (error) {
    informationDdl.value = `-- ${error instanceof Error ? error.message : tr("读取 DDL 失败")}`;
  } finally {
    informationLoading.value = false;
  }
}

function openDatabaseDictionary(database: string) {
  newTab(
    `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = ${JSON.stringify(database)}\nORDER BY TABLE_TYPE, TABLE_NAME;`,
    database,
    tr("数据字典 · {0}", [database]),
  );
}

function openTableDictionary(database: string, table: string) {
  newTab(
    `SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT\nFROM information_schema.COLUMNS\nWHERE TABLE_SCHEMA = ${JSON.stringify(database)} AND TABLE_NAME = ${JSON.stringify(table)}\nORDER BY ORDINAL_POSITION;`,
    database,
    tr("数据字典 · {0}", [table]),
  );
}

function closeDatabase(database: string) {
  const next = new Set(expandedDatabases.value);
  next.delete(database);
  expandedDatabases.value = next;
  removeTabsForDatabase(database);
  clearDatabaseLocalState(database);
  if (selectedDatabase.value === database) {
    selectedDatabase.value = "";
    navigatorTarget.value = "";
    taskPanel.value = false;
    sidePanel.value = "";
  }
}

function editDatabaseTemplate(database: string) {
  const schema = schemas.value.find((candidate) => candidate.name === database);
  const charset = schema?.charset ? ` CHARACTER SET ${schema.charset}` : "";
  const collation = schema?.collation ? ` COLLATE ${schema.collation}` : "";
  newTab(`ALTER DATABASE ${sqlIdentifier(database)}${charset}${collation};`, database, tr("编辑数据库 · {0}", [database]));
}

function createDatabaseTemplate(database: string) {
  const schema = schemas.value.find((candidate) => candidate.name === database);
  const charset = schema?.charset ? `\n  CHARACTER SET ${schema.charset}` : "";
  const collation = schema?.collation ? `\n  COLLATE ${schema.collation}` : "";
  newTab(`CREATE DATABASE \`new_database\`${charset}${collation};`, "", tr("新建数据库"));
}

async function deleteDatabase(database: string) {
  if (!selectedConnectionId.value) return;
  if (["information_schema", "mysql", "performance_schema", "sys"].includes(database.toLowerCase())) {
    return ElMessage.warning(tr("系统数据库不能通过 Viron 删除"));
  }
  try {
    await ElMessageBox.confirm(
      tr("确定删除数据库“{0}”及其中全部对象和数据吗？该操作不可撤销。", [database]),
      tr("删除数据库"),
      { confirmButtonText: tr("删除数据库"), cancelButtonText: tr("取消"), type: "error" },
    );
    const response = await api<{ job: QueryJob }>(`/api/v1/database-connections/${selectedConnectionId.value}/queries`, {
      method: "POST",
      body: JSON.stringify({ sql: `DROP DATABASE ${sqlIdentifier(database)}`, database: "" }),
    });
    const job = await waitForQueryJob(response.job.id);
    if (job.status !== "success") throw new Error(job.error || tr("删除数据库失败"));
    closeDatabase(database);
    await refreshSchemas();
    ElMessage.success(tr("数据库 {0} 已删除", [database]));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除数据库失败"));
  }
}

async function startDatabaseBackup(database: string, includeData = true) {
  if (!selectedConnectionId.value) return;
  try {
    await api(`/api/v1/database-connections/${selectedConnectionId.value}/backup`, {
      method: "POST",
      body: JSON.stringify({ database, includeData }),
    });
    await loadDatabaseTasks();
    openTaskPanel(database);
    ElMessage.success(tr("数据库 {0} 的{1}任务已开始", [database, includeData ? tr("备份") : tr("结构备份")]));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法开始数据库备份"));
  }
}

async function runServerReload(action: string, database = selectedDatabase.value) {
  const commands: Record<string, { sql: string; title: string }> = {
    "reload-privileges": { sql: "FLUSH PRIVILEGES;", title: tr("重载权限") },
    "reload-hosts": { sql: "FLUSH HOSTS;", title: tr("重载主机") },
    "reload-log-files": { sql: "FLUSH LOGS;", title: tr("重载日志文件") },
    "reload-status": { sql: "FLUSH STATUS;", title: tr("重载状态") },
    "reload-tables": { sql: "FLUSH TABLES;", title: tr("重载表") },
  };
  const command = commands[action];
  if (!command) return;
  const tab = newTab(command.sql, database, command.title);
  await runQuery(command.sql, tab);
}

async function dumpTableStructure(target: DatabaseNavigatorTarget) {
  const item = await chooseNavigatorObject(target, "tables");
  if (!item || !selectedConnectionId.value) return;
  try {
    await downloadApiFile(
      `/api/v1/database-connections/${selectedConnectionId.value}/table-export?database=${encodeURIComponent(target.database)}&table=${encodeURIComponent(item.name)}&format=sql&includeData=false`,
      `${target.database}.${item.name}.structure.sql`,
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导出数据表结构失败"));
  }
}

async function reverseNavigatorTarget(target: DatabaseNavigatorTarget) {
  const modelTab = newArtifactTab("model");
  modelTab.database = target.database;
  await nextTick();
  if (target.kind === "database") await modelWorkspace.value?.reverseDatabase(target.database);
  else if (target.objectName && target.category) await modelWorkspace.value?.reverseObject(target.database, target.category, target.objectName);
}

async function createBiWorkspaceFromTarget(target: DatabaseNavigatorTarget) {
  if (!target.objectName || !target.category) return;
  const biTab = newArtifactTab("bi");
  biTab.database = target.database;
  await nextTick();
  biWorkspace.value?.createFromObject(target.database, target.category, target.objectName);
}

function openObjectPrivileges(target: DatabaseNavigatorTarget) {
  const object = navigatorObject(target);
  if (!object) return;
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
  if (!selected) return ElMessage.warning(tr("请选择一个数据库对象"));
  databaseSearchOpen.value = false;
  await openObject(databaseSearchDatabase.value, categoryDefinition(selected.category), selected.item);
}

function navigatorObject(target: DatabaseNavigatorTarget): { category: ObjectCategoryDefinition; item: DatabaseObject } | null {
  if (target.kind !== "object" || !target.category || ["queries", "backups"].includes(target.category)) return null;
  const category = categoryDefinition(target.category as BrowserCategory);
  const item = (objects.value[target.database]?.[category.key] ?? []).find((candidate) => (
    candidate.name === target.objectName
    && (!target.objectSource || candidate.sourceCategory === target.objectSource)
  ));
  return item ? { category, item } : null;
}

async function chooseNavigatorObject(target: DatabaseNavigatorTarget, category: BrowserCategory): Promise<DatabaseObject | null> {
  const direct = navigatorObject(target);
  if (direct?.category.key === category) return direct.item;
  await loadDatabaseObjects(target.database);
  const candidates = objects.value[target.database]?.[category] ?? [];
  if (!candidates.length) {
    ElMessage.warning(tr("当前数据库没有可用的{0}", [categoryDefinition(category).label]));
    return null;
  }
  try {
    const response = await ElMessageBox.prompt(
      tr("请输入目标{0}名称。可选：{1}{2}", [categoryDefinition(category).label, candidates.slice(0, 8).map((item) => item.name).join("、"), candidates.length > 8 ? "…" : ""]),
      tr("选择{0}", [categoryDefinition(category).label]),
      {
        confirmButtonText: tr("继续"),
        cancelButtonText: tr("取消"),
        inputPlaceholder: candidates[0].name,
        inputValidator: (value) => candidates.some((item) => item.name === value.trim()) || tr("请输入当前分类中存在的对象名称"),
      },
    );
    return candidates.find((item) => item.name === response.value.trim()) ?? null;
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("无法选择数据库对象"));
    return null;
  }
}

async function openTableWizard(target: DatabaseNavigatorTarget, type: "import" | "export", format?: "csv" | "xlsx" | "sql") {
  const category: BrowserCategory = target.category === "views" ? "views" : "tables";
  const item = await chooseNavigatorObject(target, category);
  if (!item) return;
  const tab = newDataTab(target.database, item.name, category === "views");
  tab.tableAction = { id: createClientId(), type, format };
}

async function duplicateObjectDraft(target: DatabaseNavigatorTarget) {
  const object = navigatorObject(target);
  if (!object) return ElMessage.warning(tr("数据库对象已经变化，请刷新后重试"));
  if (object.category.key === "tables") return;
  await showDdl(target.database, object.category, object.item);
  if (activeTab.value?.kind === "sql") {
    activeTab.value.title = tr("复制{0} · {1}", [objectCategoryLabel(object.item, object.category), object.item.name]);
    activeTab.value.sql = tr("-- 将对象名称修改为新名称后执行\n{0}", [activeTab.value.sql]);
  }
}

async function fetchObjectDdl(database: string, category: ObjectCategoryDefinition, item: DatabaseObject): Promise<string> {
  const singular = item.sourceCategory === "procedures" ? "procedure" : item.sourceCategory === "functions" ? "function" : category.singular;
  const response = await api<{ ddl: string }>(`/api/v1/database-connections/${selectedConnectionId.value}/ddl?database=${encodeURIComponent(database)}&type=${singular}&name=${encodeURIComponent(item.name)}`);
  if (!response.ddl) throw new Error(tr("无法读取 {0} 的 DDL", [item.name]));
  return response.ddl;
}

async function executeDatabaseStatement(sql: string, database: string): Promise<QueryJob> {
  const response = await api<{ job: QueryJob }>(`/api/v1/database-connections/${selectedConnectionId.value}/queries`, {
    method: "POST",
    body: JSON.stringify({ sql, database }),
  });
  const job = await waitForQueryJob(response.job.id);
  if (job.status !== "success") throw new Error(job.error || tr("数据库操作失败"));
  await loadHistory();
  return job;
}

function rewriteCreateObjectName(ddl: string, sourceCategory: ObjectCategory, database: string, newName: string): string {
  const keyword = sourceCategory === "procedures" ? "PROCEDURE" : sourceCategory === "functions" ? "FUNCTION" : sourceCategory === "events" ? "EVENT" : sourceCategory === "views" ? "VIEW" : "TABLE";
  const objectPattern = /(?:`(?:``|[^`])+`\.)?`(?:``|[^`])+`/;
  const pattern = new RegExp(`(\\b${keyword}\\s+)${objectPattern.source}`, "i");
  const replacement = `$1${sqlIdentifier(database)}.${sqlIdentifier(newName)}`;
  const rewritten = ddl.replace(pattern, replacement);
  if (rewritten === ddl) throw new Error(tr("无法在 {0} DDL 中定位对象名称", [keyword]));
  return rewritten.replace(/;+\s*$/, "");
}

async function copyNavigatorObject(target: DatabaseNavigatorTarget) {
  const object = navigatorObject(target);
  if (!object) return ElMessage.warning(tr("请先选择数据库对象"));
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
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("复制数据库对象失败"));
  }
}

async function pasteNavigatorObject(target: DatabaseNavigatorTarget) {
  const copied = navigatorObjectClipboard.value;
  if (!copied || copied.category !== target.category) return ElMessage.warning(tr("请先复制同类数据库对象"));
  try {
    const response = await ElMessageBox.prompt(tr("请输入新对象名称"), tr("粘贴数据库对象"), {
      confirmButtonText: tr("创建"),
      cancelButtonText: tr("取消"),
      inputValue: `${copied.name}_copy`,
      inputValidator: (value) => /^[^`\u0000-\u001f]{1,64}$/.test(value.trim()) || tr("名称需为 1–64 个有效字符"),
    });
    const name = response.value.trim();
    const sql = rewriteCreateObjectName(copied.ddl, copied.sourceCategory, target.database, name);
    const tab = newTab(`${sql};`, target.database, tr("粘贴{0} · {1}", [categoryDefinition(copied.category).label, name]));
    await executeDatabaseStatement(sql, target.database);
    tab.job = { id: "", status: "success", resultSets: [] };
    await loadDatabaseObjects(target.database, true);
    ElMessage.success(tr("{0} 已创建", [name]));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("粘贴数据库对象失败"));
  }
}

function duplicateTableDraft(target: DatabaseNavigatorTarget, includeData: boolean) {
  const object = navigatorObject(target);
  if (!object || object.category.key !== "tables") return ElMessage.warning(tr("请先右键具体数据表"));
  const source = `${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}`;
  const copy = `${sqlIdentifier(target.database)}.${sqlIdentifier(`${object.item.name}_copy`)}`;
  newTab(
    `CREATE TABLE ${copy} LIKE ${source};${includeData ? `\nINSERT INTO ${copy} SELECT * FROM ${source};` : ""}`,
    target.database,
    tr("复制表 · {0}", [object.item.name]),
  );
}

type TableMaintenanceOperation =
  | "empty"
  | "truncate"
  | "analyze"
  | "check"
  | "checkQuick"
  | "checkFast"
  | "checkChanged"
  | "checkExtended"
  | "optimize"
  | "repairQuick"
  | "repairExtended";

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
  newTab(statements[operation], target.database, tr("{0}表 · {1}", [titles[operation], item.name]));
}

async function renameObjectDraft(target: DatabaseNavigatorTarget) {
  const object = navigatorObject(target);
  if (!object) return ElMessage.warning(tr("当前对象不支持重命名"));
  try {
    const response = await ElMessageBox.prompt(tr("请输入“{0}”的新名称", [object.item.name]), tr("重命名{0}", [object.category.label]), {
      confirmButtonText: tr("重命名"),
      cancelButtonText: tr("取消"),
      inputValue: object.item.name,
      inputValidator: (value) => /^[^`\u0000-\u001f]{1,64}$/.test(value.trim()) || tr("名称需为 1–64 个有效字符"),
    });
    const newName = response.value.trim();
    if (newName === object.item.name) return;
    const from = `${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}`;
    const to = `${sqlIdentifier(target.database)}.${sqlIdentifier(newName)}`;
    let sql = "";
    if (["tables", "views"].includes(object.category.key)) sql = `RENAME TABLE ${from} TO ${to}`;
    else if (object.item.sourceCategory === "events") sql = `ALTER EVENT ${from} RENAME TO ${to}`;
    else {
      const ddl = await fetchObjectDdl(target.database, object.category, object.item);
      const sourceCategory = object.item.sourceCategory ?? "functions";
      const createSql = rewriteCreateObjectName(ddl, sourceCategory, target.database, newName);
      await executeDatabaseStatement(createSql, target.database);
      const type = sourceCategory === "procedures" ? "PROCEDURE" : "FUNCTION";
      sql = `DROP ${type} ${from}`;
    }
    const tab = newTab(`${sql};`, target.database, tr("重命名{0} · {1}", [object.category.label, object.item.name]));
    await executeDatabaseStatement(sql, target.database);
    tab.job = { id: "", status: "success", resultSets: [] };
    await loadDatabaseObjects(target.database, true);
    ElMessage.success(tr("{0} 已重命名为 {1}", [object.item.name, newName]));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("重命名数据库对象失败"));
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

async function handleNavigatorMenuAction(action: string) {
  const target = navigatorMenu.value.target;
  if (!target) return;
  if (target.kind === "connection") {
    const connection = connections.value.find((item) => item.id === target.connectionId);
    if (!connection) return;
    if (action === "close-connection") await closeConnection(connection);
    else if (action === "main-profile") await switchConnectionProfile(connection, null);
    else if (action.startsWith("connection-profile:")) await switchConnectionProfile(connection, action.slice("connection-profile:".length));
    else if (action === "edit-connection") editConnection(activeRootConnectionId.value === connection.id ? selectedConnection.value ?? connection : connection);
    else if (action === "new-connection") createConnection();
    else if (action === "delete-connection") await deleteConnection(connection);
    else if (action === "duplicate-connection") copyConnection(connection);
    else if (action === "new-database") createDatabaseTemplate(schemas.value[0]?.name ?? "");
    else if (action === "new-query") newTab("", selectedDatabase.value);
    else if (action === "command-line") newCommandLine(selectedDatabase.value);
    else if (action === "run-sql-file") openTaskPanel(selectedDatabase.value, "restore");
    else if (action.startsWith("reload-")) await runServerReload(action, selectedDatabase.value);
    else if (action === "star-connection") await updateConnectionPreference(connection, { starred: !connection.starred });
    else if (action.startsWith("connection-color:")) await updateConnectionPreference(connection, { color: action.slice("connection-color:".length) });
    else if (action === "new-connection-group") await createConnectionGroup();
    else if (action.startsWith("connection-group:")) await moveConnectionToGroup(connection, action.slice("connection-group:".length));
    else if (action === "exclude-connection-from-group") await moveConnectionToGroup(connection, null);
    else if (action === "share-connection") await openConnectionShare(connection);
    else if (action === "refresh-connections") await refreshConnections();
    return;
  }
  if (action === "new-group") {
    await createObjectGroup(target);
    return;
  }
  if (action === "add-to-group") {
    await addNavigatorObjectToGroup(target);
    return;
  }
  if (action === "exclude-from-group") {
    await excludeNavigatorObjectFromGroup(target);
    return;
  }
  const object = navigatorObject(target);
  const savedQuery = selectedSavedQuery(target);
  const backup = selectedBackup(target);
  const category = target.category && !["queries", "backups"].includes(target.category)
    ? categoryDefinition(target.category as BrowserCategory)
    : null;

  if (action === "close-database") closeDatabase(target.database);
  else if (action === "edit-database") editDatabaseTemplate(target.database);
  else if (action === "new-database") createDatabaseTemplate(target.database);
  else if (action === "delete-database") await deleteDatabase(target.database);
  else if (action === "new-query") newTab("", target.database);
  else if (action === "command-line") newCommandLine(target.database);
  else if (action === "design-query" && savedQuery) await openSavedQuery(savedQuery);
  else if (action === "delete-query" && savedQuery) await deleteSavedQuery(savedQuery);
  else if (action === "duplicate-query" && savedQuery) await duplicateSavedQuery(savedQuery);
  else if (action === "export-query" && savedQuery) exportSavedQuery(savedQuery);
  else if (action === "rename-query" && savedQuery) await renameSavedQuery(savedQuery);
  else if (action === "external-editor" && savedQuery) await openSavedQueryExternally(savedQuery);
  else if (action === "show-query-finder" && savedQuery) await revealSavedQuery(savedQuery);
  else if (action === "open-external-query") await openExternalQuery();
  else if (action === "restore-selected-backup" && backup) await restoreSelectedBackup(backup);
  else if (action === "delete-backup" && backup) await deleteBackupObject(backup);
  else if (action === "duplicate-backup" && backup) await duplicateBackupObject(backup);
  else if (action === "extract-sql-from") extractSqlFromFile();
  else if (action === "extract-selected-sql" && backup) await extractBackupSql(backup);
  else if (action === "rename-backup" && backup) await renameBackupObject(backup);
  else if (action === "show-backup-finder" && backup) await revealBackupObject(backup);
  else if (action === "run-sql-file" || action === "restore-backup-from") openTaskPanel(target.database, "restore");
  else if (action === "dump-database-full" || action === "new-backup") await startDatabaseBackup(target.database);
  else if (action === "dump-database-structure") await startDatabaseBackup(target.database, false);
  else if (action === "reverse-database") await reverseNavigatorTarget(target);
  else if (action === "database-dictionary") openDatabaseDictionary(target.database);
  else if (action === "search-database") await openDatabaseSearch(target.database);
  else if (action === "share-database" || action === "share-object") await openConnectionShare();
  else if (action === "refresh-database") {
    await loadDatabaseObjects(target.database, true);
    ElMessage.success(tr("数据库 {0} 已刷新", [target.database]));
  } else if (action === "new-object" && category) createObjectTemplate(target.database, category.key);
  else if (action.startsWith("open-through-profile:") && object && selectedRootConnection.value) {
    const profileId = action.slice("open-through-profile:".length);
    await switchConnectionProfile(selectedRootConnection.value, profileId === "main" ? null : profileId);
    if (databaseConnected.value) await openObject(target.database, object.category, object.item);
  }
  else if ((action === "open-object" || action === "open-object-quick") && object) await openObject(target.database, object.category, object.item);
  else if (action === "design-object" && object) {
    if (object.category.key === "tables") newTableDesigner(target.database, object.item.name);
    else await showDdl(target.database, object.category, object.item);
  }
  else if (action === "delete-object" && object) await deleteObject(target.database, object.category, object.item);
  else if (action === "duplicate-object") await duplicateObjectDraft(target);
  else if (action === "duplicate-table-structure") duplicateTableDraft(target, false);
  else if (action === "duplicate-table-data") duplicateTableDraft(target, true);
  else if (action === "empty-table" && object) tableMutationDraft(target, "empty", object.item);
  else if (action === "truncate-table" && object) tableMutationDraft(target, "truncate", object.item);
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
    const table = await chooseNavigatorObject(target, "tables");
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
    if (table) tableMutationDraft(target, operations[action], table);
  } else if (action === "import-table") await openTableWizard(target, "import");
  else if (action === "export-table") await openTableWizard(target, "export", "csv");
  else if (action === "dump-table-data") await openTableWizard(target, "export", "sql");
  else if (action === "dump-table-structure") await dumpTableStructure(target);
  else if (action === "reverse-table" || action === "reverse-view") await reverseNavigatorTarget(target);
  else if (action === "create-bi-workspace") await createBiWorkspaceFromTarget(target);
  else if (["table-permissions", "view-permissions", "routine-permissions"].includes(action)) openObjectPrivileges(target);
  else if (action === "generate-data") {
    const item = object?.item ?? await chooseNavigatorObject(target, "tables");
    if (item) dataGenerator.value = { visible: true, database: target.database, table: item.name };
  }
  else if (action === "table-dictionary") {
    const item = object?.item ?? await chooseNavigatorObject(target, target.category === "views" ? "views" : "tables");
    if (item) openTableDictionary(target.database, item.name);
  } else if (action === "get-row-count") {
    const item = object?.item ?? await chooseNavigatorObject(target, "tables");
    if (item) newTab(`SELECT COUNT(*) AS row_count FROM ${sqlIdentifier(target.database)}.${sqlIdentifier(item.name)};`, target.database, tr("行数 · {0}", [item.name]));
  } else if (action === "copy-object" && object) await copyNavigatorObject(target);
  else if (action === "paste-object") await pasteNavigatorObject(target);
  else if (action === "rename-object") await renameObjectDraft(target);
  else if (action === "run-object" && object) {
    const call = object.item.sourceCategory === "procedures"
      ? `CALL ${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}();`
      : `SELECT ${sqlIdentifier(target.database)}.${sqlIdentifier(object.item.name)}();`;
    newTab(call, target.database, tr("运行{0} · {1}", [objectCategoryLabel(object.item, object.category), object.item.name]));
  } else if (action === "show-diagram" && category) {
    await openCategory(target.database, category);
    objectViewMode.value = "diagram";
  } else if (action === "refresh-category" && category) {
    await loadDatabaseObjects(target.database, true);
  } else if (action === "refresh-queries") {
    await loadSavedQueries();
    newUtilityTab(target.database, "queries");
  } else if (action === "refresh-backups") {
    await loadDatabaseTasks();
    newUtilityTab(target.database, "backups");
  }
}

async function showDdl(database: string, category: ObjectCategoryDefinition, item: DatabaseObject) {
  if (!databaseConnected.value) return ElMessage.warning(tr("数据库连接已断开，请先重新连接"));
  try {
    const singular = item.sourceCategory === "procedures" ? "procedure" : item.sourceCategory === "functions" ? "function" : category.singular;
    const response = await api<{ ddl: string }>(`/api/v1/database-connections/${selectedConnectionId.value}/ddl?database=${encodeURIComponent(database)}&type=${singular}&name=${encodeURIComponent(item.name)}`);
    newTab(response.ddl ? `${response.ddl};` : tr("-- 无法获取 {0} 的 DDL", [item.name]), database, `DDL · ${item.name}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取 DDL 失败"));
  }
}

async function openObject(database: string, category: ObjectCategoryDefinition, item: DatabaseObject) {
  selectedDatabase.value = database;
  if (category.key === "tables" || category.key === "views") {
    newDataTab(database, item.name, category.key === "views");
  } else {
    await showDdl(database, category, item);
  }
}

async function runQuery(sql?: string, tab = activeTab.value) {
  if (!selectedConnectionId.value || !databaseConnected.value) return ElMessage.warning(tr("请先连接数据库"));
  if (!tab) return;
  const statement = (sql ?? tab.sql).trim();
  if (!statement) return ElMessage.warning(tr("请输入要执行的 SQL"));
  tab.job = { id: "", status: "pending", resultSets: [] };
  tab.activeResult = 0;
  try {
    const response = await api<{ job: QueryJob }>(`/api/v1/database-connections/${selectedConnectionId.value}/queries`, {
      method: "POST",
      body: JSON.stringify({
        sql: statement,
        database: tab.database || selectedDatabase.value,
        continueOnError: continueOnQueryError.value,
      }),
    });
    tab.job = response.job;
    pollJob(tab, response.job.id);
  } catch (error) {
    tab.job = { id: "", status: "error", error: error instanceof Error ? error.message : tr("查询启动失败"), resultSets: [] };
  }
}

function pollJob(tab: QueryTab, jobId: string) {
  const timer = window.setInterval(async () => {
    try {
      const response = await api<{ job: QueryJob }>(`/api/v1/database-queries/${jobId}`);
      tab.job = response.job;
      if (!["pending", "running"].includes(response.job.status)) {
        window.clearInterval(timer);
        pollTimers.delete(timer);
        await loadHistory();
      }
    } catch (error) {
      window.clearInterval(timer);
      pollTimers.delete(timer);
      tab.job = { id: jobId, status: "error", error: error instanceof Error ? error.message : tr("读取查询结果失败"), resultSets: [] };
    }
  }, 350);
  pollTimers.add(timer);
}

async function cancelQuery() {
  const job = activeTab.value?.job;
  if (!job?.id) return;
  try {
    await api(`/api/v1/database-queries/${job.id}`, { method: "DELETE" });
    ElMessage.success(tr("已发送查询取消请求"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("取消查询失败"));
  }
}

function formatSql() {
  if (!activeTab.value) return;
  try {
    activeTab.value.sql = format(activeTab.value.sql, { language: "mysql", keywordCase: "upper", tabWidth: 2 });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("SQL 格式化失败"));
  }
}

async function explainSql() {
  if (!activeTab.value) return;
  await runQuery(`EXPLAIN ${activeTab.value.sql}`, activeTab.value);
}

function handleQueryRunCommand(command: string) {
  if (command === "run") void runQuery();
  else if (command === "current") void runQuery(sqlEditor.value?.currentStatementSql());
  else if (command === "selected") {
    const sql = sqlEditor.value?.selectedSql().trim();
    if (!sql) ElMessage.info(tr("请先选择要运行的 SQL"));
    else void runQuery(sql);
  }
  else if (command === "toggle-continue") continueOnQueryError.value = !continueOnQueryError.value;
}

function handleBuiltQuery(sql: string, run: boolean) {
  const tab = activeTab.value?.kind === "sql" ? activeTab.value : newTab("", selectedDatabase.value);
  tab.sql = sql;
  if (run) void runQuery(sql, tab);
}

function insertCodeSnippet(sql: string) {
  const tab = activeTab.value?.kind === "sql" ? activeTab.value : newTab("", selectedDatabase.value);
  tab.sql = tab.sql.trim() ? `${tab.sql.replace(/\s+$/, "")}\n\n${sql}` : sql;
}

function handleGeneratedData(sql: string, run: boolean) {
  const tab = newTab(sql, dataGenerator.value.database, tr("数据生成 · {0}", [dataGenerator.value.table]));
  if (run) void runQuery(sql, tab);
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

async function saveQueryTab(tab = activeTab.value): Promise<boolean> {
  if (!tab || tab.kind !== "sql" || !selectedConnectionId.value) return false;
  const database = tab.database || selectedDatabase.value;
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
    } catch (error) {
      if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("无法读取查询名称"));
      return false;
    }
  }
  try {
    if (tab.savedQueryId) {
      await api(`/api/v1/database-saved-queries/${tab.savedQueryId}`, {
        method: "PUT",
        body: JSON.stringify({ connectionId: selectedConnectionId.value, database, name, sql: tab.sql }),
      });
    } else {
      const created = await api<{ id: string }>("/api/v1/database-saved-queries", {
        method: "POST",
        body: JSON.stringify({ connectionId: selectedConnectionId.value, database, name, sql: tab.sql }),
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
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存查询失败"));
    return false;
  }
}

async function openSavedQuery(item: SavedQueryItem) {
  const existing = tabs.value.find((tab) => tab.kind === "sql" && tab.savedQueryId === item.id);
  if (existing) activeTabId.value = existing.id;
  else syncSavedQueryTab(newTab(item.sql, item.database, item.name), item);
  selectUtilityItem(item.database, "queries", item.id);
  try {
    const accessed = await api<{ accessedAt: string }>(`/api/v1/database-saved-queries/${item.id}/access`, { method: "POST" });
    item.accessedAt = accessed.accessedAt;
  } catch {
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
    tabs.value = tabs.value.filter((tab) => tab.savedQueryId !== item.id);
    if (!tabs.value.some((tab) => tab.id === activeTabId.value)) activeTabId.value = tabs.value.at(-1)?.id ?? "";
    await loadSavedQueries();
    ElMessage.success(tr("查询 {0} 已删除", [item.name]));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
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
    const created = await api<{ id: string }>("/api/v1/database-saved-queries", {
      method: "POST",
      body: JSON.stringify({ connectionId: item.connectionId, database: item.database, name: response.value.trim(), sql: item.sql }),
    });
    await loadSavedQueries();
    const copy = savedQueries.value.find((candidate) => candidate.id === created.id);
    if (copy) await openSavedQuery(copy);
    ElMessage.success(tr("查询已复制"));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
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
    for (const tab of tabs.value.filter((candidate) => candidate.savedQueryId === item.id)) {
      tab.title = name;
      tab.savedQueryName = name;
    }
    await loadSavedQueries();
    ElMessage.success(tr("查询已重命名"));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
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

function selectBrowserSqlFile(): Promise<{ name: string; content: string } | null> {
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
    if (!selected) return;
    const title = selected.name.replace(/\.sql$/i, "") || tr("外部查询");
    newTab(selected.content, selectedDatabase.value, title);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法打开外部查询"));
  }
}

async function openSavedQueryExternally(item: SavedQueryItem) {
  try {
    if (isDesktopApp()) await openDesktopDatabaseQueryExternally({ id: item.id, name: item.name, sql: item.sql });
    else {
      exportSavedQuery(item);
      ElMessage.info(tr("浏览器已下载 SQL 文件，请使用本机编辑器打开"));
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法使用外部编辑器打开查询"));
  }
}

async function revealSavedQuery(item: SavedQueryItem) {
  try {
    if (isDesktopApp()) await revealDesktopDatabaseQuery({ id: item.id, name: item.name, sql: item.sql });
    else {
      exportSavedQuery(item);
      ElMessage.info(tr("浏览器已将 SQL 文件下载到默认下载目录"));
    }
  } catch (error) {
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
    openTaskPanel(database);
    ElMessage.success(tr("恢复任务已开始"));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
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
  } catch (error) {
    if (error === "cancel" || error === "close") return;
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
  } catch (error) {
    if (error === "cancel" || error === "close") return;
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
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("无法重命名备份"));
  }
}

async function extractBackupSql(item: DatabaseTreeTask) {
  try {
    await downloadApiFile(`/api/v1/database-tasks/${item.id}/download`, item.outputFilename || `${item.title}.sql`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法提取 SQL"));
  }
}

async function revealBackupObject(item: DatabaseTreeTask) {
  const path = `/api/v1/database-tasks/${item.id}/download`;
  const filename = item.outputFilename || `${item.title}.sql`;
  try {
    if (isDesktopApp()) await revealDesktopDatabaseBackup({ id: item.id, path, filename });
    else {
      await downloadApiFile(path, filename);
      ElMessage.info(tr("浏览器已将备份下载到默认下载目录"));
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法定位备份文件"));
  }
}

function extractSqlFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".sql,application/sql,text/plain";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
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
  if (!activeTab.value || !selectedConnectionId.value) return;
  try {
    const result = await ElMessageBox.prompt(tr("给这段 SQL 起一个便于查找的名称"), tr("收藏 SQL"), { confirmButtonText: tr("收藏"), cancelButtonText: tr("取消"), inputValue: activeTab.value.title });
    await api("/api/v1/database-query-favorites", {
      method: "POST",
      body: JSON.stringify({
        connectionId: selectedConnectionId.value,
        database: activeTab.value.database || selectedDatabase.value,
        name: result.value,
        sql: activeTab.value.sql,
      }),
    });
    ElMessage.success(tr("SQL 已收藏"));
    await loadFavorites();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("收藏失败"));
  }
}

async function loadHistory() {
  if (!selectedConnectionId.value) return;
  const response = await api<{ items: HistoryItem[] }>(`/api/v1/database-query-history?connectionId=${selectedConnectionId.value}`);
  historyItems.value = response.items;
}

async function loadFavorites() {
  if (!selectedConnectionId.value) return;
  const response = await api<{ items: FavoriteItem[] }>(`/api/v1/database-query-favorites?connectionId=${selectedConnectionId.value}`);
  favorites.value = response.items;
}

async function loadSavedQueries() {
  if (!selectedConnectionId.value) return;
  const response = await api<{ items: SavedQueryItem[] }>(`/api/v1/database-saved-queries?connectionId=${selectedConnectionId.value}`);
  savedQueries.value = response.items;
}

async function loadDatabaseTasks() {
  if (!selectedConnectionId.value) return;
  const response = await api<{ items: DatabaseTreeTask[] }>("/api/v1/database-tasks");
  databaseTasks.value = response.items;
}

function updateDatabaseTasks(items: DatabaseTreeTask[]) {
  databaseTasks.value = items;
}

function openSaved(sql: string, database: string, title: string) {
  newTab(sql, database || selectedDatabase.value, title);
  sidePanel.value = "";
}

async function deleteFavorite(item: FavoriteItem) {
  await api(`/api/v1/database-query-favorites/${item.id}`, { method: "DELETE" });
  await loadFavorites();
  ElMessage.success(tr("收藏已删除"));
}

function resultSummary(result: QueryResultSet): string {
  if (result.error) return tr("失败");
  if (result.rows.length) return tr("{0}{1} 行", [result.rows.length, result.truncated ? "+" : ""]);
  return tr("{0} 行受影响", [result.affectedRows]);
}

function queryResult(tab: QueryTab): QueryResultSet | undefined {
  return tab.job?.resultSets[tab.activeResult];
}

function focusSearchInput(container: HTMLElement | null) {
  const input = container?.querySelector<HTMLInputElement>("input");
  input?.focus();
  input?.select();
}

function handleWorkbenchShortcut(action: ShortcutActionId): boolean {
  if (!props.active || !workbenchElement.value?.getClientRects().length) return false;
  if (action === "workspace.search") {
    if (activeTab.value?.kind === "data") return false;
    if (document.activeElement instanceof Element && document.activeElement.closest(".monaco-editor")) sqlEditor.value?.openFind();
    else if (databaseSearchOpen.value) focusSearchInput(databaseSearchContainer.value);
    else if (activeTab.value?.kind === "objects" || activeTab.value?.kind === "utility") focusSearchInput(objectSearchContainer.value);
    else focusSearchInput(connectionSearchContainer.value);
    return true;
  }
  if (action === "workspace.new") {
    newTab("", selectedDatabase.value);
    return true;
  }
  if (action === "workspace.design") {
    if (activeTab.value?.kind !== "table-design") designCurrentTable();
    return true;
  }
  if (action === "workspace.close" && activeTab.value) {
    void closeTab(activeTab.value);
    return true;
  }
  if (action === "workspace.save") {
    if (activeTab.value?.kind === "data") return false;
    if (activeTab.value?.kind === "sql") {
      void saveQueryTab(activeTab.value);
      return true;
    }
    return false;
  }
  if (action === "workspace.refresh") {
    if (activeTab.value?.kind === "data") return false;
    if (activeTab.value?.kind === "objects") void refreshObjectCategory(activeTab.value);
    else if (activeTab.value?.kind === "utility" && activeTab.value.utilityCategory === "queries") void loadSavedQueries();
    else if (activeTab.value?.kind === "utility") void loadDatabaseTasks();
    else if (selectedDatabase.value) void loadDatabaseObjects(selectedDatabase.value, true);
    else void refreshConnections();
    return true;
  }
  if (action === "workspace.execute" && activeTab.value?.kind === "sql") {
    void runQuery();
    return true;
  }
  return false;
}

function handleWorkbenchKeydown(event: KeyboardEvent) {
  if (!props.active) return;
  if (event.key === "Escape" && queryFocused.value) {
    event.preventDefault();
    queryFocused.value = false;
    return;
  }
  const action = shortcutActionFromKeyboardEvent(event);
  if (action && handleWorkbenchShortcut(action)) event.preventDefault();
}

async function pollDatabaseSession() {
  const id = databaseSessionId.value;
  if (!id) return;
  try {
    await api(`/api/v1/active-connections/${id}`);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404 || databaseSessionId.value !== id) return;
    databaseSessionId.value = "";
    const runningJobIds = tabs.value.flatMap((tab) => tab.job?.id && ["pending", "running"].includes(tab.job.status) ? [tab.job.id] : []);
    await Promise.allSettled(runningJobIds.map((jobId) => api(`/api/v1/database-queries/${jobId}`, { method: "DELETE" })));
    for (const timer of pollTimers) window.clearInterval(timer);
    pollTimers.clear();
    for (const tab of tabs.value) {
      if (tab.job && ["pending", "running"].includes(tab.job.status)) {
        tab.job = { ...tab.job, status: "cancelled", error: tr("数据库连接已断开") };
      }
    }
    selectedConnectionId.value = "";
    resetDatabaseWorkspace(false);
  }
}

async function focusInitialConnection(): Promise<void> {
  const connectionId = props.initialConnectionId;
  if (!connectionId || loading.value) return;
  const connection = connections.value.find((item) => item.id === connectionId);
  if (connection) await selectConnection(connection, false);
}

onMounted(() => {
  restoreWorkbenchPreferences();
  void load();
  document.addEventListener("keydown", handleWorkbenchKeydown);
  removeShortcutListener = onAppShortcut(handleWorkbenchShortcut);
  databaseSessionPollTimer = window.setInterval(pollDatabaseSession, 3_000);
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
  }
  else {
    removeAgentDatabaseSceneProvider?.();
    removeAgentDatabaseSceneProvider = undefined;
    removeAgentWorkbenchExecutionProvider?.();
    removeAgentWorkbenchExecutionProvider = undefined;
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
  pollTimers.forEach((timer) => window.clearInterval(timer));
  window.clearInterval(databaseSessionPollTimer);
  document.removeEventListener("keydown", handleWorkbenchKeydown);
  removeShortcutListener?.();
  removeAgentDatabaseSceneProvider?.();
  removeAgentWorkbenchExecutionProvider?.();
  for (const [requestId, pending] of pendingAgentDatabaseExecutions) {
    pendingAgentDatabaseExecutions.delete(requestId);
    window.clearInterval(pending.timer);
    void api(`/api/v1/database-queries/${pending.jobId}`, { method: "DELETE" }).catch(() => undefined);
    pending.reject(new Error(tr("当前数据库工作台已关闭")));
  }
  if (databaseSessionId.value) void api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
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
