<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderTree,
  Grid2X2,
  History,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Rows2,
  Search,
  Server,
  Square,
  TerminalSquare,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, defineAsyncComponent, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { registerAgentSshSceneProvider } from "../agent-ssh-scene";
import { createClientId } from "../client-id";
import {
  closeDesktopSshSession,
  isDesktopApp,
  issueDesktopSshTicket,
  listDesktopSshSessions,
  openDesktopSshSession,
  stopDesktopAgentResourceRuns,
} from "../desktop";
import {
  appendSshCommandHistory,
  clearSshCommandHistory,
  readSshHistorySuggestionsEnabled,
  readSshCommandHistory,
  removeSshCommandHistoryCommand,
  writeSshHistorySuggestionsEnabled,
  type CommandSubmission,
  type SshCommandFavoriteEntry,
  type SshCommandHistoryEntry,
} from "../ssh-command-history";
import { session as adminSession } from "../session";
import { onAppShortcut } from "../keyboard-shortcuts";
import { createSftpOpenRequest, type SftpOpenRequest } from "../sftp";
import { rememberActiveConnectionOrigin } from "../active-connection-origin";
import ConnectionEditDialog from "./ConnectionEditDialog.vue";
import SshCommandHistoryPanel from "./SshCommandHistoryPanel.vue";
import SshTerminalPane from "./SshTerminalPane.vue";
import { registerAgentWorkbenchExecutionProvider } from "../agent-workbench-execution";
import type { AgentWorkbenchExecutionRequest } from "../../shared/agent";
import WorkbenchConnectionActions from "./WorkbenchConnectionActions.vue";

const SftpWorkspace = defineAsyncComponent(() => import("./SftpWorkspace.vue"));

const props = withDefaults(defineProps<{
  environmentId?: string;
  initialConnectionId?: string;
  initialMode?: "terminal" | "sftp";
  workspaceKey?: string;
  localExecution?: boolean;
  sftpEnabled?: boolean;
  active?: boolean;
}>(), { initialMode: "terminal", workspaceKey: "fixed:ssh", localExecution: false, sftpEnabled: true, active: true });

const router = useRouter();
const route = useRoute();
const desktopApp = isDesktopApp();

interface SshConnection {
  id: string;
  type: "ssh";
  name: string;
  host: string;
  port: number;
  username: string;
  environmentId: string | null;
  environmentName: string | null;
  environmentIds: string[];
  connectionGroupId: string | null;
  connectionGroupPath: string | null;
  authType: "password" | "privateKey" | "keyboardInteractive";
  jumpConnectionId: string | null;
  tags: string[];
  options: Record<string, unknown>;
  hasPassword: boolean;
  hasPrivateKey: boolean;
}

interface ServerSession {
  id: string;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
  attached: boolean;
}

interface OpenedSshSession {
  session: ServerSession;
  ticket: string;
  activeConnectionId?: string;
}

interface WorkbenchSession extends ServerSession {
  ticket: string;
  pane: number;
  status: "connecting" | "connected" | "disconnected" | "closed";
  placeholder?: boolean;
}

type Layout = "single" | "vertical" | "horizontal" | "quad";

const loading = ref(true);
const openingId = ref("");
const movingSessionId = ref("");
const connections = ref<SshConnection[]>([]);
const sessions = ref<WorkbenchSession[]>([]);
const keyword = ref("");
const layout = ref<Layout>("single");
const splitX = ref(50);
const splitY = ref(50);
const activeByPane = ref<Record<number, string>>({});
const terminalFontScaleVersion = 4;
const fontSize = ref(13);
const connectionPaneWidth = ref(280);
const connectionPaneVisible = ref(true);
const connectionEditorOpen = ref(false);
const editingConnection = ref<SshConnection | null>(null);
const copyConnectionMode = ref(false);
const terminalRefs = ref<Record<string, InstanceType<typeof SshTerminalPane>>>({});
const gridElement = ref<HTMLElement | null>(null);
const workbenchElement = ref<HTMLElement | null>(null);
const connectionSearchInput = ref<{ focus(): void } | null>(null);
let removeShortcutListener: (() => void) | undefined;
let removeAgentSceneProvider: (() => void) | undefined;
let removeAgentWorkbenchExecutionProvider: (() => void) | undefined;
const historyOpen = ref(true);
const sftpOpen = ref(props.initialMode === "sftp" && props.sftpEnabled);
const sftpVisited = ref(props.initialMode === "sftp" && props.sftpEnabled);
let sftpOpenRequestId = 0;
const sftpOpenRequest = ref<SftpOpenRequest>(createSftpOpenRequest(sftpOpenRequestId, props.initialConnectionId));
const historySuggestionsEnabled = ref(true);
const historyEntries = ref<SshCommandHistoryEntry[]>([]);
const favoriteEntries = ref<SshCommandFavoriteEntry[]>([]);
const favoritesLoading = ref(false);
const focusedSessionId = ref("");
const collapsedGroups = ref<Set<string>>(new Set());
const persistenceKey = computed(() => `envman:ssh-workbench:${props.workspaceKey}:${props.environmentId ?? "global"}`);
const sessionOwnershipKey = "envman:ssh-session-workspaces";
const sshConnectionActions = [
  { key: "edit", label: tr("编辑连接"), icon: Pencil },
  { key: "copy", label: tr("复制连接"), icon: Copy },
  ...(!desktopApp ? [{ key: "browser", label: tr("新标签页中打开"), icon: ExternalLink }] : []),
];

const filteredConnections = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  if (!query) return connections.value;
  return connections.value.filter((item) => `${item.name} ${item.host} ${item.username} ${item.tags.join(" ")}`.toLowerCase().includes(query));
});
const groupedConnections = computed(() => {
  const groups = new Map<string, SshConnection[]>();
  for (const connection of filteredConnections.value) {
    const path = connection.connectionGroupPath || tr("未分组");
    groups.set(path, [...(groups.get(path) ?? []), connection]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left === tr("未分组") ? 1 : right === tr("未分组") ? -1 : left.localeCompare(right, "zh-CN"))
    .map(([path, items]) => ({ path, items }));
});

const paneCount = computed(() => layout.value === "single" ? 1 : layout.value === "quad" ? 4 : 2);
const panes = computed(() => Array.from({ length: paneCount.value }, (_, index) => index));
const gridStyle = computed(() => ({
  "--split-x": `${splitX.value}%`,
  "--split-y": `${splitY.value}%`,
}));
const workbenchStyle = computed(() => ({ "--connection-pane-width": `${connectionPaneWidth.value}px` }));
const selectedSession = computed(() => {
  const focused = sessions.value.find((session) => session.id === focusedSessionId.value);
  if (focused && activeSession(focused.pane)?.id === focused.id) return focused;
  return panes.value.map((pane) => activeSession(pane)).find(Boolean) ?? null;
});
function sessionsForPane(pane: number) {
  return sessions.value.filter((session) => session.pane === pane);
}

function toggleConnectionGroup(path: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedGroups.value = next;
}

function activeSession(pane: number) {
  const candidates = sessionsForPane(pane);
  return candidates.find((session) => session.id === activeByPane.value[pane]) ?? candidates[0] ?? null;
}

function historyBelongsToPane(pane: number) {
  const selected = selectedSession.value;
  return selected ? activeSession(pane)?.id === selected.id : pane === 0;
}

function persist() {
  localStorage.setItem(persistenceKey.value, JSON.stringify({
    layout: layout.value,
    splitX: splitX.value,
    splitY: splitY.value,
    fontSize: fontSize.value,
    fontScaleVersion: terminalFontScaleVersion,
    connectionPaneWidth: connectionPaneWidth.value,
    connectionPaneVisible: connectionPaneVisible.value,
    historyOpen: historyOpen.value,
    panes: Object.fromEntries(sessions.value.map((session) => [session.id, session.pane])),
    sessionIds: sessions.value.map((session) => session.id),
    activeByPane: activeByPane.value,
  }));
}

function restorePreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(persistenceKey.value) ?? "{}") as {
      layout?: Layout;
      splitX?: number;
      splitY?: number;
      fontSize?: number;
      fontScaleVersion?: number;
      connectionPaneWidth?: number;
      connectionPaneVisible?: boolean;
      historyOpen?: boolean;
      panes?: Record<string, number>;
      sessionIds?: string[];
      activeByPane?: Record<number, string>;
    };
    if (["single", "vertical", "horizontal", "quad"].includes(value.layout ?? "")) layout.value = value.layout!;
    if (value.splitX) splitX.value = value.splitX;
    if (value.splitY) splitY.value = value.splitY;
    if (value.fontSize && value.fontScaleVersion === terminalFontScaleVersion) {
      fontSize.value = Math.max(10, Math.min(22, value.fontSize));
    }
    if (value.connectionPaneWidth) connectionPaneWidth.value = Math.max(220, Math.min(520, value.connectionPaneWidth));
    if (typeof value.connectionPaneVisible === "boolean") connectionPaneVisible.value = value.connectionPaneVisible;
    if (typeof value.historyOpen === "boolean") historyOpen.value = value.historyOpen;
    activeByPane.value = value.activeByPane ?? {};
    return { panes: value.panes ?? {}, sessionIds: new Set(value.sessionIds ?? []) };
  } catch {
    return { panes: {}, sessionIds: new Set<string>() };
  }
}

function readSessionOwnership(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(sessionOwnershipKey) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function claimSession(sessionId: string) {
  const ownership = readSessionOwnership();
  ownership[sessionId] = props.workspaceKey;
  localStorage.setItem(sessionOwnershipKey, JSON.stringify(ownership));
}

function releaseSession(sessionId: string) {
  const ownership = readSessionOwnership();
  delete ownership[sessionId];
  localStorage.setItem(sessionOwnershipKey, JSON.stringify(ownership));
}

function ownerIsAvailable(owner: string | undefined) {
  return Boolean(owner);
}

function releaseWorkspaceOwnership() {
  const ownership = readSessionOwnership();
  let changed = false;
  for (const [sessionId, owner] of Object.entries(ownership)) {
    if (owner !== props.workspaceKey) continue;
    delete ownership[sessionId];
    changed = true;
  }
  if (changed) localStorage.setItem(sessionOwnershipKey, JSON.stringify(ownership));
}

function choosePane(): number {
  const counts = panes.value.map((pane) => sessionsForPane(pane).length);
  const minimum = Math.min(...counts);
  return Math.max(0, counts.indexOf(minimum));
}

async function load() {
  loading.value = true;
  try {
    const query = new URLSearchParams({ type: "ssh" });
    if (props.environmentId) query.set("environmentId", props.environmentId);
    const [connectionResponse, sessionResponse] = await Promise.all([
      api<{ items: SshConnection[] }>(`/api/v1/connections?${query.toString()}`),
      props.localExecution ? listDesktopSshSessions() : api<{ items: ServerSession[] }>("/api/v1/ssh-sessions"),
    ]);
    connections.value = connectionResponse.items;
    const visibleIds = new Set(connections.value.map((item) => item.id));
    const saved = restorePreferences();
    const ownership = readSessionOwnership();
    const recovered: WorkbenchSession[] = [];
    for (const session of sessionResponse.items.filter((item) => {
      if (!visibleIds.has(item.connectionId)) return false;
      const owner = ownership[item.id];
      if (saved.sessionIds.has(item.id) || owner === props.workspaceKey) return true;
      return !props.initialConnectionId && !ownerIsAvailable(owner);
    })) {
      try {
        const response = props.localExecution
          ? await issueDesktopSshTicket(session.id)
          : await api<{ ticket: string }>(`/api/v1/ssh-sessions/${session.id}/ticket`, { method: "POST" });
        claimSession(session.id);
        recovered.push({
          ...session,
          ticket: response.ticket,
          pane: Math.min(saved.panes[session.id] ?? 0, paneCount.value - 1),
          status: "connecting",
        });
      } catch {
        // The remote session ended while the workbench was loading.
      }
    }
    sessions.value = recovered;
    for (const pane of panes.value) {
      if (!activeSession(pane) && sessionsForPane(pane)[0]) activeByPane.value[pane] = sessionsForPane(pane)[0].id;
    }
    focusedSessionId.value = panes.value.map((pane) => activeSession(pane)?.id).find(Boolean) ?? "";
    const initialConnection = connections.value.find((item) => item.id === props.initialConnectionId);
    if (props.initialMode === "terminal" && initialConnection && !sessions.value.some((item) => item.connectionId === initialConnection.id)) {
      await openConnection(initialConnection);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载 SSH 工作台失败"));
  } finally {
    loading.value = false;
  }
}

async function openConnection(connection: SshConnection) {
  openingId.value = connection.id;
  try {
    const response = props.localExecution
      ? await openDesktopSshSession({ connectionId: connection.id, originEnvironmentId: props.environmentId, cols: 120, rows: 32 })
      : await api<OpenedSshSession>("/api/v1/ssh-sessions", {
          method: "POST",
          body: JSON.stringify({ connectionId: connection.id, originEnvironmentId: props.environmentId, cols: 120, rows: 32 }),
        });
    rememberActiveConnectionOrigin(response.activeConnectionId ?? response.session.id, props.environmentId);
    const pane = choosePane();
    const session: WorkbenchSession = { ...response.session, ticket: response.ticket, pane, status: "connecting" };
    sessions.value.push(session);
    claimSession(session.id);
    activeByPane.value = { ...activeByPane.value, [pane]: session.id };
    focusedSessionId.value = session.id;
    persist();
    await nextTick();
    terminalRefs.value[session.id]?.focus();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("SSH 连接失败"));
  } finally {
    openingId.value = "";
  }
}

function editConnection(connection: SshConnection) {
  editingConnection.value = connection;
  copyConnectionMode.value = false;
  connectionEditorOpen.value = true;
}

function copyConnection(connection: SshConnection) {
  editingConnection.value = connection;
  copyConnectionMode.value = true;
  connectionEditorOpen.value = true;
}

function createConnection() {
  editingConnection.value = null;
  copyConnectionMode.value = false;
  connectionEditorOpen.value = true;
}

async function refreshConnections() {
  const query = new URLSearchParams({ type: "ssh" });
  if (props.environmentId) query.set("environmentId", props.environmentId);
  const response = await api<{ items: SshConnection[] }>(`/api/v1/connections?${query.toString()}`);
  connections.value = response.items;
  for (const session of sessions.value) {
    const connection = connections.value.find((item) => item.id === session.connectionId);
    if (connection) session.connectionName = connection.name;
  }
}

function setConnectionPaneVisible(value: boolean) {
  connectionPaneVisible.value = value;
  persist();
  nextTick(() => Object.values(terminalRefs.value).forEach((terminal) => terminal?.fit()));
}

function connectionBrowserHref(connection: SshConnection) {
  return router.resolve({
    name: "ssh",
    query: {
      connectionId: connection.id,
      environmentId: connection.environmentId ?? undefined,
      workspaceId: createClientId(),
      immersive: "1",
    },
  }).href;
}

function openConnectionInBrowser(connection: SshConnection) {
  if (desktopApp) void router.push(connectionBrowserHref(connection));
  else window.open(connectionBrowserHref(connection), "_blank", "noopener,noreferrer");
}

function handleConnectionAction(action: string, connection: SshConnection) {
  if (action === "edit") editConnection(connection);
  else if (action === "copy") copyConnection(connection);
  else if (action === "browser") openConnectionInBrowser(connection);
}

async function renewTicket(session: WorkbenchSession) {
  if (session.status !== "disconnected") return;
  session.status = "connecting";
  try {
    if (session.placeholder) {
      const previousId = session.id;
      const response = props.localExecution
        ? await openDesktopSshSession({ connectionId: session.connectionId, originEnvironmentId: props.environmentId, cols: 120, rows: 32 })
        : await api<OpenedSshSession>("/api/v1/ssh-sessions", {
            method: "POST",
            body: JSON.stringify({ connectionId: session.connectionId, originEnvironmentId: props.environmentId, cols: 120, rows: 32 }),
          });
      rememberActiveConnectionOrigin(response.activeConnectionId ?? response.session.id, props.environmentId);
      releaseSession(previousId);
      Object.assign(session, response.session, { ticket: response.ticket, status: "connecting", placeholder: false });
      claimSession(session.id);
      if (activeByPane.value[session.pane] === previousId) {
        activeByPane.value = { ...activeByPane.value, [session.pane]: session.id };
      }
      if (focusedSessionId.value === previousId) focusedSessionId.value = session.id;
      persist();
      return;
    }
    const response = props.localExecution
      ? await issueDesktopSshTicket(session.id)
      : await api<{ ticket: string }>(`/api/v1/ssh-sessions/${session.id}/ticket`, { method: "POST" });
    session.ticket = response.ticket;
    session.status = "connecting";
  } catch (error) {
    session.status = "disconnected";
    ElMessage.error(error instanceof Error ? error.message : tr("SSH 会话已经结束"));
  }
}

async function closeSession(session: WorkbenchSession) {
  try {
    await ElMessageBox.confirm(tr("关闭“{0}”终端会立即断开远程 Shell。", [session.connectionName]), tr("关闭终端"), {
      confirmButtonText: tr("关闭终端"),
      cancelButtonText: tr("取消"),
      type: "warning",
    });
    if (!session.placeholder) {
      if (props.localExecution) await closeDesktopSshSession(session.id);
      else await api(`/api/v1/ssh-sessions/${session.id}`, { method: "DELETE" });
    }
    invalidateAgentSshSession(session);
    removeLocalSession(session);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("关闭终端失败"));
  }
}

function removeLocalSession(session: WorkbenchSession) {
  sessions.value = sessions.value.filter((item) => item.id !== session.id);
  releaseSession(session.id);
  if (activeByPane.value[session.pane] === session.id) {
    activeByPane.value = { ...activeByPane.value, [session.pane]: sessionsForPane(session.pane)[0]?.id ?? "" };
  }
  if (focusedSessionId.value === session.id) {
    focusedSessionId.value = panes.value.map((pane) => activeSession(pane)?.id).find(Boolean) ?? "";
  }
  persist();
}

function invalidateAgentSshSession(session: WorkbenchSession) {
  if (!desktopApp || session.placeholder) return;
  void stopDesktopAgentResourceRuns({
    kind: "ssh",
    resourceId: session.id,
    executionTarget: props.localExecution ? "desktop-local" : "server-forwarded",
  }).catch(() => undefined);
}

function disconnectSession(session: WorkbenchSession) {
  if (session.placeholder) return;
  invalidateAgentSshSession(session);
  releaseSession(session.id);
  Object.assign(session, { status: "disconnected", placeholder: true });
}

function handleSessionClosed(session: WorkbenchSession, _reason: string) {
  disconnectSession(session);
  persist();
}

function selectSession(session: WorkbenchSession, focus = true) {
  activeByPane.value = { ...activeByPane.value, [session.pane]: session.id };
  focusedSessionId.value = session.id;
  activateAgentSceneProvider();
  persist();
  if (focus) nextTick(() => terminalRefs.value[session.id]?.focus());
}

function setFocusedSession(session: WorkbenchSession) {
  focusedSessionId.value = session.id;
  activateAgentSceneProvider();
}

function activateAgentSceneProvider() {
  removeAgentSceneProvider?.();
  removeAgentSceneProvider = undefined;
  if (!props.active) return;
  const provider = {
    current: () => {
      const selected = selectedSession.value;
      const terminal = selected ? terminalRefs.value[selected.id] : undefined;
      if (!props.active || !selected || !terminal || !workbenchElement.value?.getClientRects().length) return null;
      return {
        routePath: route.fullPath,
        sessionId: selected.id,
        connectionId: selected.connectionId,
        connectionName: selected.connectionName,
        host: selected.host,
        status: selected.status,
        currentDirectory: terminal.getCurrentDirectory(),
        localExecution: props.localExecution,
      };
    },
    fill: (sessionId: string, command: string) => {
      const selected = selectedSession.value;
      if (!props.active || !selected || selected.id !== sessionId || selected.status !== "connected" || !props.localExecution) return false;
      return terminalRefs.value[selected.id]?.replaceCurrentCommand(command) ?? false;
    },
    fillScript: (sessionId: string, script: string) => {
      const selected = selectedSession.value;
      if (!props.active || !selected || selected.id !== sessionId || selected.status !== "connected" || !props.localExecution) return false;
      return terminalRefs.value[selected.id]?.replaceCurrentScript(script) ?? false;
    },
  };
  removeAgentSceneProvider = registerAgentSshSceneProvider(provider);
}

function activateAgentWorkbenchExecutionProvider() {
  removeAgentWorkbenchExecutionProvider?.();
  removeAgentWorkbenchExecutionProvider = undefined;
  if (!props.active) return;
  removeAgentWorkbenchExecutionProvider = registerAgentWorkbenchExecutionProvider({
    domain: "ssh",
    routePath: () => props.active && workbenchElement.value?.getClientRects().length ? route.fullPath : null,
    execute: async (request: AgentWorkbenchExecutionRequest) => {
      if (request.domain !== "ssh") throw new Error(tr("Viron Agent SSH 工作台请求无效"));
      const selected = selectedSession.value;
      const terminal = selected ? terminalRefs.value[selected.id] : undefined;
      if (!selected || !terminal || selected.id !== request.sessionId || selected.status !== "connected") throw new Error(tr("请切回 Agent 绑定的 SSH 会话后重试"));
      const output = await terminal.executeAgentCommand(request.requestId, request.command, request.deadlineAt);
      return {
        domain: "ssh",
        requestId: request.requestId,
        sessionId: selected.id,
        connectionId: selected.connectionId,
        connectionName: selected.connectionName,
        host: selected.host,
        executionTarget: props.localExecution ? "desktop-local" : "server-forwarded",
        command: request.command,
        ...output,
      };
    },
    cancel: (requestId, reason) => {
      for (const terminal of Object.values(terminalRefs.value)) {
        if (terminal?.cancelAgentCommand(requestId, reason)) return;
      }
    },
  });
}

function historyContext(session = selectedSession.value) {
  const userId = adminSession.user?.id;
  if (!userId || !session) return null;
  return { userId, connectionId: session.connectionId };
}

function reloadHistory() {
  const context = historyContext();
  historyEntries.value = context
    ? readSshCommandHistory(localStorage, context.userId, context.connectionId)
    : [];
}

let favoritesRequestId = 0;

async function reloadFavorites() {
  const connectionId = selectedSession.value?.connectionId;
  const requestId = ++favoritesRequestId;
  if (!connectionId || !adminSession.user?.id) {
    favoriteEntries.value = [];
    favoritesLoading.value = false;
    return;
  }
  favoritesLoading.value = true;
  try {
    const query = new URLSearchParams({ connectionId });
    const response = await api<{ items: SshCommandFavoriteEntry[] }>(`/api/v1/ssh-command-favorites?${query.toString()}`);
    if (requestId === favoritesRequestId) favoriteEntries.value = response.items;
  } catch (error) {
    if (requestId === favoritesRequestId) {
      favoriteEntries.value = [];
      ElMessage.error(error instanceof Error ? error.message : tr("加载命令收藏失败"));
    }
  } finally {
    if (requestId === favoritesRequestId) favoritesLoading.value = false;
  }
}

function restoreHistorySuggestionsPreference() {
  const userId = adminSession.user?.id;
  historySuggestionsEnabled.value = userId
    ? readSshHistorySuggestionsEnabled(localStorage, userId)
    : true;
}

function setHistorySuggestions(enabled: string | number | boolean) {
  historySuggestionsEnabled.value = enabled === true;
  const userId = adminSession.user?.id;
  if (userId) writeSshHistorySuggestionsEnabled(localStorage, userId, historySuggestionsEnabled.value);
}

function recordCommand(session: WorkbenchSession, submission: CommandSubmission) {
  const context = historyContext(session);
  if (!context) return;
  const entries = appendSshCommandHistory(localStorage, context.userId, context.connectionId, submission);
  if (selectedSession.value?.connectionId === session.connectionId) historyEntries.value = entries;
}

function useHistoryEntry(entry: SshCommandHistoryEntry) {
  const active = selectedSession.value;
  if (!active || !terminalRefs.value[active.id]?.insertCommand(entry.command)) {
    ElMessage.warning(tr("当前终端无法填入命令，请确认连接正常并停留在 Shell 提示符"));
  }
}

async function favoriteHistoryEntry(entry: SshCommandHistoryEntry) {
  const connectionId = selectedSession.value?.connectionId;
  if (!connectionId || favoritesLoading.value) return;
  const requestId = favoritesRequestId;
  favoritesLoading.value = true;
  try {
    const response = await api<{ item: SshCommandFavoriteEntry; created: boolean }>("/api/v1/ssh-command-favorites", {
      method: "POST",
      body: JSON.stringify({ connectionId, command: entry.command, cwd: entry.cwd }),
    });
    if (requestId === favoritesRequestId && selectedSession.value?.connectionId === connectionId) {
      favoriteEntries.value = [response.item, ...favoriteEntries.value.filter((favorite) => favorite.id !== response.item.id)];
      ElMessage.success(response.created ? tr("命令已收藏") : tr("命令已在收藏中"));
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("收藏命令失败"));
  } finally {
    if (requestId === favoritesRequestId && selectedSession.value?.connectionId === connectionId) favoritesLoading.value = false;
  }
}

async function removeFavoriteEntry(entry: SshCommandFavoriteEntry) {
  const connectionId = selectedSession.value?.connectionId;
  if (!connectionId || favoritesLoading.value) return;
  const requestId = favoritesRequestId;
  favoritesLoading.value = true;
  try {
    await api(`/api/v1/ssh-command-favorites/${entry.id}`, { method: "DELETE" });
    if (requestId === favoritesRequestId && selectedSession.value?.connectionId === connectionId) {
      favoriteEntries.value = favoriteEntries.value.filter((favorite) => favorite.id !== entry.id);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("取消收藏失败"));
  } finally {
    if (requestId === favoritesRequestId && selectedSession.value?.connectionId === connectionId) favoritesLoading.value = false;
  }
}

function removeHistoryEntry(entry: SshCommandHistoryEntry) {
  const context = historyContext();
  if (!context) return;
  historyEntries.value = removeSshCommandHistoryCommand(localStorage, context.userId, context.connectionId, entry.command);
}

async function clearHistory() {
  const context = historyContext();
  if (!context || !historyEntries.value.length) return;
  try {
    await ElMessageBox.confirm(tr("清空当前 SSH 连接的全部本地命令记录？"), tr("清空命令历史"), {
      confirmButtonText: tr("清空"),
      cancelButtonText: tr("取消"),
      type: "warning",
    });
    clearSshCommandHistory(localStorage, context.userId, context.connectionId);
    historyEntries.value = [];
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(tr("清空命令历史失败"));
  }
}

function toggleHistory() {
  historyOpen.value = !historyOpen.value;
  persist();
  nextTick(() => Object.values(terminalRefs.value).forEach((terminal) => terminal?.fit()));
}

function setSftpOpen(open: boolean) {
  if (open && !props.sftpEnabled) {
    ElMessage.warning(tr("当前连接模式下服务端未启用 SFTP 转发"));
    return;
  }
  if (open && !sftpOpen.value) {
    const session = selectedSession.value;
    const currentDirectory = session ? terminalRefs.value[session.id]?.getCurrentDirectory() : undefined;
    sftpOpenRequest.value = createSftpOpenRequest(
      ++sftpOpenRequestId,
      session?.connectionId ?? props.initialConnectionId,
      currentDirectory,
    );
  }
  sftpOpen.value = open;
  if (open) sftpVisited.value = true;
}

function setLayout(value: Layout) {
  layout.value = value;
  const maxPane = value === "single" ? 0 : value === "quad" ? 3 : 1;
  for (const session of sessions.value) session.pane = Math.min(session.pane, maxPane);
  for (const pane of panes.value) {
    if (!activeSession(pane) && sessionsForPane(pane)[0]) activeByPane.value[pane] = sessionsForPane(pane)[0].id;
  }
  persist();
  nextTick(() => Object.values(terminalRefs.value).forEach((terminal) => terminal?.fit()));
}

async function moveToPane(session: WorkbenchSession, pane: number) {
  if (session.pane === pane || movingSessionId.value) return;
  movingSessionId.value = session.id;
  try {
    if (session.placeholder) {
      session.pane = pane;
      activeByPane.value = { ...activeByPane.value, [pane]: session.id };
      persist();
      return;
    }
    const response = props.localExecution
      ? await issueDesktopSshTicket(session.id)
      : await api<{ ticket: string }>(`/api/v1/ssh-sessions/${session.id}/ticket`, { method: "POST" });
    session.ticket = response.ticket;
    session.pane = pane;
    activeByPane.value = { ...activeByPane.value, [pane]: session.id };
    persist();
    await nextTick();
    terminalRefs.value[session.id]?.fit();
    terminalRefs.value[session.id]?.focus();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("移动 SSH 会话失败"));
  } finally {
    movingSessionId.value = "";
  }
}

function startResize(axis: "x" | "y", event: PointerEvent) {
  event.preventDefault();
  const move = (moveEvent: PointerEvent) => {
    const bounds = gridElement.value?.getBoundingClientRect();
    if (!bounds) return;
    if (axis === "x") splitX.value = Math.max(25, Math.min(75, ((moveEvent.clientX - bounds.left) / bounds.width) * 100));
    else splitY.value = Math.max(25, Math.min(75, ((moveEvent.clientY - bounds.top) / bounds.height) * 100));
  };
  const finish = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    persist();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish, { once: true });
}

function setConnectionPaneWidth(value: number) {
  const maxWidth = Math.min(520, (workbenchElement.value?.getBoundingClientRect().width ?? 1040) * .55);
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
    persist();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish, { once: true });
}

function resizeConnectionPane(delta: number) {
  setConnectionPaneWidth(connectionPaneWidth.value + delta);
  persist();
}

function updateStatus(session: WorkbenchSession, status: WorkbenchSession["status"]) {
  session.status = status;
}

async function focusInitialConnection(): Promise<void> {
  const connectionId = props.initialConnectionId;
  if (!connectionId || loading.value) return;
  const existing = sessions.value.find((session) => session.connectionId === connectionId);
  if (existing) {
    selectSession(existing);
    return;
  }
  const connection = connections.value.find((item) => item.id === connectionId);
  if (connection && openingId.value !== connectionId) await openConnection(connection);
}

watch([splitX, splitY, connectionPaneWidth], () => nextTick(() => Object.values(terminalRefs.value).forEach((terminal) => terminal?.fit())));
watch(() => props.localExecution, () => {
  for (const session of sessions.value) disconnectSession(session);
  terminalRefs.value = {};
  persist();
});
watch(() => props.sftpEnabled, (enabled) => {
  if (!enabled) setSftpOpen(false);
});
watch(() => props.initialMode, (mode) => setSftpOpen(mode === "sftp"));
watch(() => props.initialConnectionId, () => { void focusInitialConnection(); });
watch(() => props.active, (active) => {
  if (active) {
    activateAgentSceneProvider();
    activateAgentWorkbenchExecutionProvider();
    nextTick(() => Object.values(terminalRefs.value).forEach((terminal) => terminal?.fit()));
  } else {
    removeAgentSceneProvider?.();
    removeAgentSceneProvider = undefined;
    removeAgentWorkbenchExecutionProvider?.();
    removeAgentWorkbenchExecutionProvider = undefined;
  }
});
watch([() => selectedSession.value?.connectionId, () => adminSession.user?.id], () => {
  reloadHistory();
  void reloadFavorites();
}, { immediate: true });
watch(() => adminSession.user?.id, restoreHistorySuggestionsPreference, { immediate: true });
onMounted(() => {
  if (props.active) {
    activateAgentSceneProvider();
    activateAgentWorkbenchExecutionProvider();
  }
  window.addEventListener("beforeunload", releaseWorkspaceOwnership);
  removeShortcutListener = onAppShortcut((action) => {
    if (!props.active || !workbenchElement.value?.getClientRects().length) return;
    if (action === "workspace.search") connectionSearchInput.value?.focus();
    else if (action === "workspace.new") createConnection();
    else if (action === "workspace.close" && selectedSession.value) void closeSession(selectedSession.value);
    else if (action === "workspace.refresh") void load();
  });
  void load();
});
onActivated(() => {
  if (props.active) {
    activateAgentSceneProvider();
    activateAgentWorkbenchExecutionProvider();
    void focusInitialConnection();
    nextTick(() => Object.values(terminalRefs.value).forEach((terminal) => terminal?.fit()));
  }
});
onDeactivated(() => {
  removeAgentSceneProvider?.();
  removeAgentSceneProvider = undefined;
  removeAgentWorkbenchExecutionProvider?.();
  removeAgentWorkbenchExecutionProvider = undefined;
});
onBeforeUnmount(() => {
  removeAgentSceneProvider?.();
  removeAgentWorkbenchExecutionProvider?.();
  removeShortcutListener?.();
  persist();
  window.removeEventListener("beforeunload", releaseWorkspaceOwnership);
  releaseWorkspaceOwnership();
});
</script>

<template>
  <section ref="workbenchElement" class="ssh-workbench" :class="{ 'is-connection-pane-hidden': !connectionPaneVisible }" :style="workbenchStyle" v-loading="loading">
    <aside v-if="connectionPaneVisible" class="ssh-hosts">
      <header>
        <div><strong>{{ $t('服务器连接') }}</strong></div>
        <div class="workbench-sidebar-actions"><button class="mini-link" type="button" :aria-label="$t('新建 SSH 连接')" :title="$t('新建 SSH 连接')" @click="createConnection"><Plus :size="15" />{{ $t('新建') }}</button><button class="workbench-sidebar-visibility" type="button" :aria-label="$t('隐藏 SSH 连接列表')" :title="$t('隐藏连接列表')" @click="setConnectionPaneVisible(false)"><PanelLeftClose :size="15" /></button></div>
      </header>
      <el-input ref="connectionSearchInput" v-model="keyword" clearable :placeholder="$t('搜索主机或标签')">
        <template #prefix><Search :size="15" /></template>
      </el-input>
      <div class="ssh-host-list">
        <section v-for="group in groupedConnections" :key="group.path" class="workbench-connection-group">
          <button class="workbench-group-toggle" :aria-expanded="!collapsedGroups.has(group.path)" @click="toggleConnectionGroup(group.path)"><ChevronDown v-if="!collapsedGroups.has(group.path)" :size="14" /><ChevronRight v-else :size="14" /><FolderTree :size="13" /><span>{{ group.path }}</span><em>{{ group.items.length }}</em></button>
          <el-dropdown v-for="connection in collapsedGroups.has(group.path) ? [] : group.items" :key="connection.id" class="workbench-connection-context-target" trigger="contextmenu" placement="bottom-start" popper-class="workbench-connection-menu-popper" @command="handleConnectionAction($event, connection)">
            <div class="ssh-host-card" :class="{ 'is-opening': openingId === connection.id }">
              <button class="connection-card-main" type="button" :disabled="openingId === connection.id" :title="$t('双击在当前工作台连接：{0} · {1}@{2}:{3}', [connection.name, connection.username, connection.host, connection.port])" @dblclick="openConnection(connection)" @keydown.enter="openConnection(connection)">
                <span class="ssh-host-card__icon"><Server :size="16" /></span>
                <span class="ssh-host-card__details"><strong>{{ connection.name }}</strong><small>{{ connection.username }}@{{ connection.host }}:{{ connection.port }}</small><span v-if="connection.tags.length" class="ssh-host-tags"><i v-for="tag in connection.tags" :key="tag">{{ tag }}</i></span></span>
              </button>
              <el-dropdown trigger="click" placement="bottom-end" popper-class="workbench-connection-menu-popper" @command="handleConnectionAction($event, connection)">
                <button class="connect-indicator" type="button" :disabled="openingId === connection.id" :aria-label="$t('打开 {0} 的连接菜单', [connection.name])" :title="$t('连接操作')">
                  <RefreshCw v-if="openingId === connection.id" :size="15" class="is-spinning" />
                  <ChevronDown v-else :size="15" />
                </button>
                <template #dropdown><WorkbenchConnectionActions :actions="sshConnectionActions" /></template>
              </el-dropdown>
            </div>
            <template #dropdown><WorkbenchConnectionActions :actions="sshConnectionActions" /></template>
          </el-dropdown>
        </section>
        <div v-if="!filteredConnections.length" class="sidebar-empty"><Server :size="22" /><span>{{ $t('没有可用 SSH 连接') }}</span><button type="button" class="sidebar-empty-action" @click="createConnection">{{ $t('在当前页新建') }}</button></div>
      </div>
    </aside>

    <button v-if="connectionPaneVisible" class="workbench-sidebar-resizer" type="button" role="separator" aria-orientation="vertical" :aria-label="$t('调整 SSH 连接列表宽度')" :aria-valuenow="connectionPaneWidth" @pointerdown="startConnectionPaneResize" @keydown.left.prevent="resizeConnectionPane(-20)" @keydown.right.prevent="resizeConnectionPane(20)"><span></span></button>

    <main class="terminal-workspace">
      <button v-if="!connectionPaneVisible" class="workbench-sidebar-restore" type="button" :aria-label="$t('显示 SSH 连接列表')" :title="$t('显示连接列表')" @click="setConnectionPaneVisible(true)"><PanelLeftOpen :size="16" /></button>
      <header class="terminal-toolbar">
        <div class="layout-buttons" :aria-label="$t('终端分屏布局')">
          <button :class="{ 'is-active': layout === 'single' }" :title="$t('单窗口')" @click="setLayout('single')"><Square :size="16" /></button>
          <button :class="{ 'is-active': layout === 'vertical' }" :title="$t('左右分屏')" @click="setLayout('vertical')"><Columns2 :size="16" /></button>
          <button :class="{ 'is-active': layout === 'horizontal' }" :title="$t('上下分屏')" @click="setLayout('horizontal')"><Rows2 :size="16" /></button>
          <button :class="{ 'is-active': layout === 'quad' }" :title="$t('四宫格')" @click="setLayout('quad')"><Grid2X2 :size="16" /></button>
        </div>
        <span class="terminal-session-count"><i></i>{{ sessions.length }} {{ $t('个活动会话') }}</span>
        <button class="terminal-side-toggle terminal-sftp-toggle" :class="{ 'is-active': sftpOpen }" :disabled="!sftpEnabled" :aria-expanded="sftpOpen" :title="sftpEnabled ? $t('从右侧打开 SFTP 文件传输') : $t('当前连接模式下 SFTP 不可用')" @click="setSftpOpen(!sftpOpen)"><FolderOpen :size="15" />SFTP</button>
      </header>

      <div ref="gridElement" class="terminal-grid" :class="`layout-${layout}`" :style="gridStyle">
        <section v-for="pane in panes" :key="pane" class="terminal-cell">
          <header v-if="sessionsForPane(pane).length" class="terminal-tabs">
            <button v-for="session in sessionsForPane(pane)" :key="session.id" class="terminal-tab" :class="{ 'is-active': activeSession(pane)?.id === session.id }" @click="selectSession(session)">
              <i :class="`is-${session.status}`"></i><span>{{ session.connectionName }}</span>
              <em v-if="session.status === 'disconnected'" :title="$t('重新连接浏览器终端')" @click.stop="renewTicket(session)"><RefreshCw :size="12" /></em>
              <em :title="$t('关闭终端')" @click.stop="closeSession(session)"><X :size="12" /></em>
            </button>
          </header>
          <div class="terminal-cell__body" :class="{ 'is-history-open': historyOpen && historyBelongsToPane(pane) }">
            <template v-if="activeSession(pane)">
              <template v-for="session in sessionsForPane(pane)" :key="session.id">
                <SshTerminalPane
                  v-if="session.ticket"
                  v-show="activeSession(pane)?.id === session.id"
                  :ref="(element) => { if (element) terminalRefs[session.id] = element as InstanceType<typeof SshTerminalPane> }"
                  :session-id="session.id"
                  :ticket="session.ticket"
                  :font-size="fontSize"
                  :history-entries="selectedSession?.id === session.id ? historyEntries : []"
                  :history-suggestions-enabled="historySuggestionsEnabled"
                  :local-execution="localExecution"
                  :status="session.status"
                  @status="updateStatus(session, $event)"
                  @closed="handleSessionClosed(session, $event)"
                  @focused="setFocusedSession(session)"
                  @reconnect-requested="renewTicket(session)"
                  @command-submitted="recordCommand(session, $event)"
                  @history-remove="removeHistoryEntry"
                />
                <div v-else-if="activeSession(pane)?.id === session.id" class="terminal-cell-empty">
                  <TerminalSquare :size="28" />
                  <strong>{{ session.connectionName }} {{ $t('已断开') }}</strong>
                  <span>{{ $t('连接模式已切换，重新连接后将使用当前模式。') }}</span>
                  <button class="move-session-button" @click="renewTicket(session)"><RefreshCw :size="14" />{{ $t('重新连接') }}</button>
                </div>
              </template>
            </template>
            <div v-else class="terminal-cell-empty">
              <TerminalSquare :size="28" />
              <strong>{{ $t('分屏') }} {{ pane + 1 }}</strong>
              <span>{{ $t('从左侧选择服务器连接') }}</span>
              <el-dropdown v-if="sessions.length" trigger="click">
                <button class="move-session-button"><Plus :size="14" />{{ $t('移入已有会话') }}</button>
                <template #dropdown><el-dropdown-menu><el-dropdown-item v-for="session in sessions" :key="session.id" :disabled="Boolean(movingSessionId)" @click="moveToPane(session, pane)">{{ session.connectionName }}</el-dropdown-item></el-dropdown-menu></template>
              </el-dropdown>
            </div>
            <SshCommandHistoryPanel
              v-if="historyOpen && historyBelongsToPane(pane)"
              :entries="historyEntries"
              :favorites="favoriteEntries"
              :favorites-loading="favoritesLoading"
              :connection-name="selectedSession?.connectionName"
              :suggestions-enabled="historySuggestionsEnabled"
              @close="toggleHistory"
              @use="useHistoryEntry"
              @use-favorite="useHistoryEntry"
              @favorite="favoriteHistoryEntry"
              @unfavorite="removeFavoriteEntry"
              @remove="removeHistoryEntry"
              @clear="clearHistory"
              @suggestions-change="setHistorySuggestions"
            />
          </div>
        </section>
        <button v-if="layout === 'vertical' || layout === 'quad'" class="split-handle split-handle--x" :aria-label="$t('调整左右分屏')" @pointerdown="startResize('x', $event)"></button>
        <button v-if="layout === 'horizontal' || layout === 'quad'" class="split-handle split-handle--y" :aria-label="$t('调整上下分屏')" @pointerdown="startResize('y', $event)"></button>
      </div>

      <footer class="terminal-statusbar">
        <span class="terminal-statusbar__idle">{{ $t('空闲') }} {{ 30 }} {{ $t('分钟自动断开') }}</span>
        <span class="terminal-statusbar__capability"><FolderOpen :size="13" />{{ sftpEnabled ? $t('SFTP · rz/sz 已启用') : $t('SFTP 当前不可用 · rz/sz 已启用') }}</span>
        <div class="terminal-statusbar__controls">
          <div class="terminal-font-control"><button :aria-label="$t('减小终端字体')" :title="$t('减小终端字体')" @click="fontSize = Math.max(10, fontSize - 1); persist()"><Minus :size="14" /></button><span>{{ fontSize }}px</span><button :aria-label="$t('增大终端字体')" :title="$t('增大终端字体')" @click="fontSize = Math.min(22, fontSize + 1); persist()"><Plus :size="14" /></button></div>
          <button class="terminal-side-toggle" :class="{ 'is-active': historyOpen }" :title="selectedSession ? $t('查看 {0} 的命令历史', [selectedSession.connectionName]) : $t('查看命令历史')" :aria-label="$t('切换 SSH 命令历史')" @click="toggleHistory"><History :size="15" />{{ $t('历史') }} {{ historyEntries.length }}/50</button>
        </div>
      </footer>
      <aside v-if="sftpVisited" class="sftp-drawer" :class="{ 'is-open': sftpOpen }" :aria-hidden="!sftpOpen" :aria-label="$t('SFTP 文件传输抽屉')">
        <SftpWorkspace drawer :environment-id="environmentId" :initial-connection-id="sftpOpenRequest.connectionId" :open-request="sftpOpenRequest" :local-execution="localExecution" @close="setSftpOpen(false)" />
      </aside>
    </main>
    <ConnectionEditDialog v-model="connectionEditorOpen" connection-type="ssh" :connection="editingConnection" :copy-mode="copyConnectionMode" :default-environment-id="environmentId ?? null" @saved="refreshConnections" />
  </section>
</template>

<style scoped>
.terminal-cell__body { grid-row: 2; min-width: 0; min-height: 0; position: relative; overflow: hidden; background: #081214; box-sizing: border-box; transition: padding-right .16s ease-out; }
.terminal-cell__body.is-history-open { --ssh-history-panel-width: min(292px, 86%); padding-right: var(--ssh-history-panel-width); }
.terminal-cell__body > .ssh-terminal-shell,
.terminal-cell__body > .terminal-cell-empty { height: 100%; }
.terminal-statusbar__controls { margin-left: auto; }
.terminal-statusbar__idle { margin-left: 0; }
</style>
