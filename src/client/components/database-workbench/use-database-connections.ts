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

export function useDatabaseConnections(
  ctx: DatabaseWorkbenchContext,
  props: Readonly<DatabaseWorkbenchProps>,
  route: { fullPath: string },
) {
  const $layout = deferDatabaseWorkbenchPart(ctx, "layout");
  const $navigator = deferDatabaseWorkbenchPart(ctx, "navigator");
  const $queryTabs = deferDatabaseWorkbenchPart(ctx, "queryTabs");
  const $artifacts = deferDatabaseWorkbenchPart(ctx, "artifacts");
  const $agentScene = deferDatabaseWorkbenchPart(ctx, "agentScene");
  const $menuActions = deferDatabaseWorkbenchPart(ctx, "menuActions");
  const loading = ref(true);

  const connecting = ref(false);

  const databaseSessionId = ref("");

  const connections = ref<DatabaseConnection[]>([]);

  const connectionGroups = ref<ConnectionGroupItem[]>([]);

  const selectedConnectionId = ref("");

  const focusedConnectionId = ref("");

  const navigationFilter = ref<"all" | "connected" | "disconnected">("all");

  const showStarredOnly = ref(false);

  const connectionEditorOpen = ref(false);

  const editingConnection = ref<DatabaseConnection | null>(null);

  const copyConnectionMode = ref(false);

  const connectionProfileParentId = ref("");

  const connectionSearch = ref("");

  const connectionSearchContainer = ref<HTMLElement | null>(null);

  const shareDialogOpen = ref(false);

  const shareDialogLoading = ref(false);

  const shareConnection = ref<DatabaseConnection | null>(null);

  const shareDetail = ref<OrganizationShareDetail | null>(null);

  const shareGrantee = ref("");

  const collapsedConnectionGroups = ref<Set<string>>(new Set());

  const collapsedConnectionIds = ref<Set<string>>(new Set());

  const selectedConnection = computed(() => connections.value.find((item) => item.id === selectedConnectionId.value) ?? null);

  const rootConnections = computed(() => connections.value.filter((item) => !item.profileParentId));

  const selectedRootConnection = computed(() => {
      const selected = selectedConnection.value;
      if (!selected)
          return null;
      return selected.profileParentId ? connections.value.find((item) => item.id === selected.profileParentId) ?? null : selected;
  });

  const editingRootConnection = computed(() => {
      const editing = editingConnection.value;
      if (!editing)
          return null;
      return editing.profileParentId ? connections.value.find((item) => item.id === editing.profileParentId) ?? null : editing;
  });

  const editingConnectionProfiles = computed(() => connections.value.filter((item) => item.profileParentId === editingRootConnection.value?.id));

  const activeRootConnectionId = computed(() => selectedRootConnection.value?.id ?? "");

  const activeConnectionProfiles = computed(() => connections.value
      .filter((item) => item.profileParentId === activeRootConnectionId.value)
      .map((item) => ({ id: item.id, name: item.profileName || item.name })));

  const databaseConnected = computed(() => Boolean(databaseSessionId.value));

  const favoriteConnectionIds = computed(() => new Set($navigator.objectFavorites.value.map((item) => item.connectionId)));

  const filteredConnections = computed(() => {
      const query = connectionSearch.value.trim().toLowerCase();
      return connections.value.filter((item) => {
          if (item.profileParentId)
              return false;
          if (navigationFilter.value === "connected" && !(item.id === activeRootConnectionId.value && databaseConnected.value))
              return false;
          if (navigationFilter.value === "disconnected" && item.id === activeRootConnectionId.value && databaseConnected.value)
              return false;
          if (showStarredOnly.value && !item.starred && !favoriteConnectionIds.value.has(item.id))
              return false;
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

  const shareGrants = computed(() => shareDetail.value?.grants.filter((grant) => grant.resourceType === "database_connection" && grant.resourceId === shareConnection.value?.id) ?? []);

  const shareCandidates = computed(() => {
      const granted = new Set(shareGrants.value.map((grant) => `${grant.granteeType}:${grant.granteeId}`));
      return [
          ...(shareDetail.value?.members ?? []).filter((item) => item.role !== "admin" && item.status === "active").map((item) => ({ key: `user:${item.id}`, label: item.username, type: "user" as const, id: item.id })),
          ...(shareDetail.value?.projects ?? []).map((item) => ({ key: `project:${item.id}`, label: item.name, type: "project" as const, id: item.id })),
      ].filter((item) => !granted.has(item.key));
  });

  function toggleConnectionGroup(path: string) {
      const next = new Set(collapsedConnectionGroups.value);
      if (next.has(path))
          next.delete(path);
      else
          next.add(path);
      collapsedConnectionGroups.value = next;
  }

  function setConnectionCollapsed(connectionId: string, collapsed: boolean) {
      const next = new Set(collapsedConnectionIds.value);
      if (collapsed)
          next.add(connectionId);
      else
          next.delete(connectionId);
      collapsedConnectionIds.value = next;
  }

  function connectionChildrenVisible(connection: DatabaseConnection) {
      return activeRootConnectionId.value === connection.id
          && databaseConnected.value
          && !collapsedConnectionIds.value.has(connection.id);
  }

  function handleConnectionNodeClick(connection: DatabaseConnection) {
      focusConnection(connection);
      $navigator.navigatorMenu.value.visible = false;
      if (activeRootConnectionId.value === connection.id && databaseConnected.value) {
          setConnectionCollapsed(connection.id, !collapsedConnectionIds.value.has(connection.id));
      }
  }

  function resetDatabaseWorkspace(preserveSqlTabs = true) {
      $navigator.schemas.value = [];
      $navigator.sqlCompletionCatalogs.value = {};
      $navigator.objects.value = {};
      $navigator.expandedDatabases.value = new Set();
      $navigator.expandedCategories.value = new Set();
      $navigator.selectedDatabase.value = "";
      $navigator.selectedObjects.value = {};
      $queryTabs.tabs.value = preserveSqlTabs
          ? $queryTabs.tabs.value.filter((tab) => ["sql", "automation", "model", "bi"].includes(tab.kind)).map((tab) => ({ ...tab, database: "", job: null, activeResult: 0 }))
          : [];
      $queryTabs.activeTabId.value = $queryTabs.tabs.value[0]?.id ?? "";
      $artifacts.historyItems.value = [];
      $artifacts.favorites.value = [];
      $artifacts.savedQueries.value = [];
      $artifacts.selectedUtilityItems.value = {};
      $artifacts.databaseTasks.value = [];
      $artifacts.sidePanel.value = "";
      $queryTabs.taskPanel.value = false;
  }

  async function load() {
      loading.value = true;
      let initialConnection: DatabaseConnection | undefined;
      void $navigator.loadObjectFavorites().catch(() => {
          $navigator.objectFavorites.value = [];
          $navigator.objectGroups.value = [];
          ElMessage.warning(tr("数据库收藏加载失败，不影响连接列表使用"));
      });
      try {
          const query = new URLSearchParams({ type: "database" });
          if (props.environmentId)
              query.set("environmentId", props.environmentId);
          const [response, groups] = await Promise.all([
              api<{
                  items: DatabaseConnection[];
              }>(`/api/v1/connections?${query.toString()}&includeProfiles=true`),
              api<{
                  items: ConnectionGroupItem[];
              }>("/api/v1/connection-groups?type=database"),
          ]);
          connections.value = response.items;
          connectionGroups.value = groups.items;
          initialConnection = connections.value.find((item) => item.id === props.initialConnectionId);
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("加载数据库连接失败"));
      }
      finally {
          loading.value = false;
      }
      if (initialConnection && selectedConnectionId.value !== initialConnection.id)
          await selectConnection(initialConnection);
  }

  async function showConnectionError(error: unknown, fallback: string): Promise<void> {
      if (!(error instanceof ApiError) || error.code !== "DESKTOP_LOCAL_NETWORK_UNREACHABLE") {
          ElMessage.error(error instanceof Error ? error.message : fallback);
          return;
      }
      try {
          await ElMessageBox.confirm(error.message, tr("无法访问局域网数据库"), {
              confirmButtonText: tr("打开系统设置"),
              cancelButtonText: tr("稍后处理"),
              distinguishCancelAndClose: true,
              type: "warning",
          });
      }
      catch (action) {
          if (action === "cancel" || action === "close")
              return;
          ElMessage.error(action instanceof Error ? action.message : tr("无法显示本地网络权限提醒"));
          return;
      }
      try {
          await openMacosLocalNetworkSettings();
      }
      catch (openError) {
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
      if (selectedConnectionId.value === target.id && databaseConnected.value)
          return true;
      const reconnecting = selectedConnectionId.value === target.id && Boolean($navigator.schemas.value.length || $queryTabs.tabs.value.length);
      if (databaseSessionId.value)
          await api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
      selectedConnectionId.value = target.id;
      if (!reconnecting)
          resetDatabaseWorkspace();
      connecting.value = true;
      try {
          const runtime = await api<{
              item: {
                  id: string;
              };
          }>("/api/v1/database-sessions", {
              method: "POST",
              body: JSON.stringify({ connectionId: target.id, originEnvironmentId: props.environmentId }),
          });
          databaseSessionId.value = runtime.item.id;
          rememberActiveConnectionOrigin(runtime.item.id, props.environmentId);
          const response = await api<{
              items: SchemaItem[];
          }>(`/api/v1/database-connections/${target.id}/schemas`);
          $navigator.schemas.value = response.items;
          await Promise.all([$artifacts.loadHistory(), $artifacts.loadFavorites(), $artifacts.loadSavedQueries(), $artifacts.loadDatabaseTasks(), $navigator.loadObjectGroups()]);
          setConnectionCollapsed(root.id, false);
          ElMessage.success(tr("已连接 {0}{1}", [root.name, target.profileName ? ` · ${target.profileName}` : ""]));
          return true;
      }
      catch (error) {
          if (databaseSessionId.value)
              await api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
          databaseSessionId.value = "";
          await showConnectionError(error, tr("数据库连接失败"));
          return false;
      }
      finally {
          connecting.value = false;
      }
  }

  async function closeConnection(connection: DatabaseConnection) {
      if (activeRootConnectionId.value !== connection.id && selectedConnectionId.value !== connection.id)
          return;
      const runningJobs = $queryTabs.tabs.value
          .map((tab) => tab.job)
          .filter((job): job is QueryJob => job !== null && Boolean(job.id) && ["pending", "running"].includes(job.status));
      if (runningJobs.length) {
          try {
              await ElMessageBox.confirm(tr("关闭“{0}”会同时取消 {1} 个正在运行的查询。", [connection.name, runningJobs.length]), tr("关闭数据库连接"), { confirmButtonText: tr("关闭连接"), cancelButtonText: tr("取消"), type: "warning" });
          }
          catch (error) {
              if (error === "cancel" || error === "close")
                  return;
              ElMessage.error(error instanceof Error ? error.message : tr("无法确认关闭数据库连接"));
              return;
          }
      }
      const cancellationResults = await Promise.allSettled(runningJobs.map((job) => api(`/api/v1/database-queries/${job.id}`, { method: "DELETE" })));
      if (isDesktopApp()) {
          const agentConnectionId = selectedConnectionId.value || connection.id;
          await stopDesktopAgentResourceRuns({ kind: "database", resourceId: agentConnectionId }).catch(() => undefined);
      }
      for (const timer of $queryTabs.pollTimers)
          window.clearInterval(timer);
      $queryTabs.pollTimers.clear();
      for (const tab of $queryTabs.tabs.value) {
          if (tab.job && ["pending", "running"].includes(tab.job.status)) {
              tab.job = { ...tab.job, status: "cancelled", error: tr("数据库连接已关闭") };
          }
      }
      if (databaseSessionId.value)
          await api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
      databaseSessionId.value = "";
      selectedConnectionId.value = "";
      if (focusedConnectionId.value === (connection.profileParentId || connection.id))
          focusedConnectionId.value = "";
      setConnectionCollapsed(connection.profileParentId || connection.id, false);
      resetDatabaseWorkspace(false);
      const failedCancellations = cancellationResults.filter((result) => result.status === "rejected").length;
      if (failedCancellations)
          ElMessage.warning(tr("数据库工作区已关闭，{0} 个查询的取消状态未能确认", [failedCancellations]));
      else
          ElMessage.success(tr("已关闭 {0}", [connection.name]));
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
      if (!target)
          return ElMessage.warning(tr("连接配置文件不存在"));
      if (selectedConnectionId.value === target.id && databaseConnected.value)
          return;
      if (databaseConnected.value && activeRootConnectionId.value === root.id) {
          ElMessage.warning(tr("要切换连接配置文件，必须关闭连接"));
          return;
      }
      try {
          await ElMessageBox.confirm(tr("你确定要将连接配置文件切换到“{0}”吗？", [target.profileName || tr("主要配置文件")]), tr("切换连接配置文件"), { confirmButtonText: tr("切换"), cancelButtonText: tr("取消"), type: "warning" });
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
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
      if (!root)
          return;
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
          }
          catch (error) {
              ElMessage.error(error instanceof Error ? error.message : tr("无法设置活动连接配置文件"));
          }
          return;
      }
      if (!profile)
          return;
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
          }
          catch (error) {
              if (error !== "cancel" && error !== "close")
                  ElMessage.error(error instanceof Error ? error.message : tr("无法复制连接配置文件"));
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
      }
      catch (error) {
          if (error !== "cancel" && error !== "close")
              ElMessage.error(error instanceof Error ? error.message : tr("无法删除连接配置文件"));
      }
  }

  function focusConnection(connection: DatabaseConnection) {
      focusedConnectionId.value = connection.id;
  }

  function selectConnectionById(connectionId: string) {
      const connection = connections.value.find((item) => item.id === connectionId);
      if (connection)
          void selectConnection(connection);
  }

  async function refreshConnections() {
      const query = new URLSearchParams({ type: "database" });
      if (props.environmentId)
          query.set("environmentId", props.environmentId);
      const [response, groups] = await Promise.all([
          api<{
              items: DatabaseConnection[];
          }>(`/api/v1/connections?${query.toString()}&includeProfiles=true`),
          api<{
              items: ConnectionGroupItem[];
          }>("/api/v1/connection-groups?type=database"),
      ]);
      connections.value = response.items;
      connectionGroups.value = groups.items;
      if (focusedConnectionId.value && !connections.value.some((item) => !item.profileParentId && item.id === focusedConnectionId.value)) {
          focusedConnectionId.value = "";
      }
      await $navigator.loadObjectFavorites();
  }

  async function updateConnectionPreference(connection: DatabaseConnection, preference: {
      starred?: boolean;
      color?: string;
  }) {
      try {
          const response = await api<{
              starred: boolean;
              color: string;
          }>(`/api/v1/database-connections/${connection.id}/preferences`, { method: "PUT", body: JSON.stringify(preference) });
          connection.starred = response.starred;
          connection.color = response.color;
      }
      catch (error) {
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
      if (!connection.canManage)
          return ElMessage.warning(tr("只有工作空间管理员可以移动连接"));
      try {
          await api(`/api/v1/database-connections/${connection.id}`, { method: "PUT", body: JSON.stringify(connectionUpdateBody(connection, connectionGroupId)) });
          await refreshConnections();
          ElMessage.success(connectionGroupId ? tr("连接已添加到组") : tr("连接已从组中排除"));
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("移动连接失败"));
      }
  }

  async function createConnectionGroup() {
      try {
          const response = await ElMessageBox.prompt(tr("请输入连接组名称"), tr("新建组"), { confirmButtonText: tr("创建"), cancelButtonText: tr("取消"), inputValidator: (value) => Boolean(value.trim()) || tr("请输入连接组名称") });
          await api("/api/v1/connection-groups", { method: "POST", body: JSON.stringify({ type: "database", parentId: null, name: response.value.trim() }) });
          await refreshConnections();
      }
      catch (error) {
          if (error !== "cancel" && error !== "close")
              ElMessage.error(error instanceof Error ? error.message : tr("新建连接组失败"));
      }
  }

  async function openConnectionShare(connection = selectedRootConnection.value) {
      if (!connection || session.workspace?.type !== "organization" || session.workspace.role !== "admin")
          return ElMessage.warning(tr("请切换到具有管理权限的组织工作空间"));
      shareConnection.value = connection;
      shareGrantee.value = "";
      shareDialogOpen.value = true;
      shareDialogLoading.value = true;
      try {
          shareDetail.value = await api<OrganizationShareDetail>(`/api/v1/organizations/${session.workspace.id}`);
      }
      catch (error) {
          shareDialogOpen.value = false;
          ElMessage.error(error instanceof Error ? error.message : tr("加载共享设置失败"));
      }
      finally {
          shareDialogLoading.value = false;
      }
  }

  async function grantSharedConnection() {
      const connection = shareConnection.value;
      const workspace = session.workspace;
      const candidate = shareCandidates.value.find((item) => item.key === shareGrantee.value);
      if (!connection || workspace?.type !== "organization" || !candidate)
          return;
      try {
          await api(`/api/v1/organizations/${workspace.id}/grants`, { method: "POST", body: JSON.stringify({ granteeType: candidate.type, granteeId: candidate.id, resourceType: "database_connection", resourceId: connection.id }) });
          shareDetail.value = await api<OrganizationShareDetail>(`/api/v1/organizations/${workspace.id}`);
          shareGrantee.value = "";
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("共享连接失败"));
      }
  }

  async function revokeSharedConnection(grant: OrganizationGrant) {
      const workspace = session.workspace;
      if (workspace?.type !== "organization")
          return;
      try {
          await api(`/api/v1/organizations/${workspace.id}/grants/${grant.id}`, { method: "DELETE" });
          shareDetail.value = await api<OrganizationShareDetail>(`/api/v1/organizations/${workspace.id}`);
      }
      catch (error) {
          ElMessage.error(error instanceof Error ? error.message : tr("撤销共享失败"));
      }
  }

  function openConnectionContextMenu(event: MouseEvent, connection: DatabaseConnection) {
      event.preventDefault();
      event.stopPropagation();
      focusConnection(connection);
      $navigator.navigatorMenu.value = { visible: false, x: event.clientX, y: event.clientY, target: { kind: "connection", connectionId: connection.id } };
      void nextTick(() => {
          $navigator.navigatorMenu.value = { visible: true, x: event.clientX, y: event.clientY, target: { kind: "connection", connectionId: connection.id } };
      });
  }

  async function deleteConnection(connection: DatabaseConnection) {
      try {
          await ElMessageBox.confirm(tr("确定删除连接“{0}”吗？凭据也会一并删除。", [connection.name]), tr("删除连接"), {
              confirmButtonText: tr("删除"),
              cancelButtonText: tr("取消"),
              type: "warning",
          });
          if (activeRootConnectionId.value === connection.id && databaseConnected.value)
              await closeConnection(connection);
          await api(`/api/v1/database-connections/${connection.id}`, { method: "DELETE" });
          ElMessage.success(tr("连接已删除"));
          await refreshConnections();
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("删除连接失败"));
      }
  }

  function collapseAllNavigation() {
      $navigator.expandedDatabases.value = new Set();
      $navigator.expandedCategories.value = new Set();
      collapsedConnectionGroups.value = new Set(groupedConnections.value.map((group) => group.path));
      $navigator.selectedDatabase.value = "";
      $navigator.navigatorTarget.value = "";
  }

  async function testConnection(connection: DatabaseConnection) {
      connecting.value = true;
      try {
          const response = await api<{
              version: string;
              latencyMs: number;
          }>(`/api/v1/database-connections/${connection.id}/test`, { method: "POST" });
          ElMessage.success(tr("连接成功 · {0} · {1} ms", [response.version, response.latencyMs]));
      }
      catch (error) {
          await showConnectionError(error, tr("连接测试失败"));
      }
      finally {
          connecting.value = false;
      }
  }

  function handleGlobalConnectionCommand(command: string) {
      const connection = selectedRootConnection.value ?? connections.value.find((item) => !item.profileParentId && item.id === focusedConnectionId.value) ?? null;
      if (command === "new")
          createConnection();
      else if (command === "refresh")
          void refreshConnections();
      else if (command === "edit" && connection)
          editConnection(connection);
      else if (command === "duplicate" && connection)
          copyConnection(connection);
      else if (command === "close" && connection)
          void closeConnection(connection);
  }

  async function pollDatabaseSession() {
      const id = databaseSessionId.value;
      if (!id)
          return;
      try {
          await api(`/api/v1/active-connections/${id}`);
      }
      catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404 || databaseSessionId.value !== id)
              return;
          databaseSessionId.value = "";
          const runningJobIds = $queryTabs.tabs.value.flatMap((tab) => tab.job?.id && ["pending", "running"].includes(tab.job.status) ? [tab.job.id] : []);
          await Promise.allSettled(runningJobIds.map((jobId) => api(`/api/v1/database-queries/${jobId}`, { method: "DELETE" })));
          for (const timer of $queryTabs.pollTimers)
              window.clearInterval(timer);
          $queryTabs.pollTimers.clear();
          for (const tab of $queryTabs.tabs.value) {
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
      if (!connectionId || loading.value)
          return;
      const connection = connections.value.find((item) => item.id === connectionId);
      if (connection)
          await selectConnection(connection, false);
  }

  function disposeDatabaseWorkbench() {
      $queryTabs.pollTimers.forEach((timer) => window.clearInterval(timer));
      window.clearInterval($queryTabs.databaseSessionPollTimer);
      document.removeEventListener("keydown", $queryTabs.handleWorkbenchKeydown);
      $queryTabs.removeShortcutListener?.();
      if (databaseSessionId.value)
          void api(`/api/v1/active-connections/${databaseSessionId.value}`, { method: "DELETE" }).catch(() => undefined);
  }

  return {
    loading,
    connecting,
    databaseSessionId,
    connections,
    connectionGroups,
    selectedConnectionId,
    focusedConnectionId,
    navigationFilter,
    showStarredOnly,
    connectionEditorOpen,
    editingConnection,
    copyConnectionMode,
    connectionProfileParentId,
    connectionSearch,
    connectionSearchContainer,
    shareDialogOpen,
    shareDialogLoading,
    shareConnection,
    shareDetail,
    shareGrantee,
    collapsedConnectionGroups,
    collapsedConnectionIds,
    selectedConnection,
    rootConnections,
    selectedRootConnection,
    editingRootConnection,
    editingConnectionProfiles,
    activeRootConnectionId,
    activeConnectionProfiles,
    databaseConnected,
    favoriteConnectionIds,
    filteredConnections,
    groupedConnections,
    shareGrants,
    shareCandidates,
    toggleConnectionGroup,
    setConnectionCollapsed,
    connectionChildrenVisible,
    handleConnectionNodeClick,
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
    testConnection,
    pollDatabaseSession,
    focusInitialConnection,
    handleGlobalConnectionCommand,
    disposeDatabaseWorkbench,
  };
}

export type { DatabaseConnectionsApi } from "./context";
