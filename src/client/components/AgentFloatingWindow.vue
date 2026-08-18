<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  Activity,
  ChevronDown,
  CircleStop,
  ClipboardPaste,
  Code2,
  Database,
  History,
  Info,
  MessageSquareText,
  PanelRightClose,
  Pencil,
  Plus,
  Send,
  Settings,
  TerminalSquare,
  Trash2,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  desktopAppState,
  desktopAgentSettings,
  createDesktopAgentSession,
  deleteDesktopAgentSession,
  getDesktopAgentSettings,
  getCurrentDesktopAgentSession,
  isDesktopApp,
  listDesktopAgentSessions,
  onDesktopAgentEvent,
  onDesktopAgentLauncherAction,
  onDesktopNativeViewPointerDown,
  readDesktopAgentSshContext,
  readDesktopAgentDatabaseContext,
  recordDesktopAgentAction,
  renameDesktopAgentSession,
  respondDesktopAgentWorkbenchExecution,
  respondDesktopAgentApproval,
  sendDesktopAgentChat,
  selectDesktopAgentSession,
  stopDesktopAgentChat,
  updateDesktopAgentLauncher,
} from "../desktop";
import {
  agentHostState,
  applyAgentHostState,
  executeAgentHostWorkbench,
  isAgentChatOverlayRuntime,
  getDesktopAgentHost,
  focusDesktopAgentChat,
  onDesktopAgentChatPointerOutside,
  onDesktopAgentHostState,
  performAgentHostAction,
  setDesktopAgentChatIgnoreMouse,
  updateDesktopAgentChatChrome,
} from "../agent-host";
import { onAppShortcut } from "../keyboard-shortcuts";
import {
  AGENT_FLOATING_BUTTON_SIZE,
  agentFloatingSnapEdge,
  clampAgentFloatingPosition,
  nearestAgentFloatingEdge,
  snapAgentFloatingPosition,
  type AgentFloatingEdge,
  type AgentFloatingPosition,
  type AgentFloatingViewport,
} from "../agent-floating-position";
import { agentFloatingOverlayLayout } from "../agent-floating-overlay";
import { agentQuickBubblesFromMessages, latestAgentQuickBubbleId, shouldStartFreshAgentConversation } from "../agent-quick-history";
import { agentSceneName } from "../agent-context-card-display";
import { renderAgentMarkdown } from "../agent-markdown";
import { agentToolActivity, type AgentToolActivity } from "../agent-tool-activity";
import { agentDatabaseReadResult, agentDatabaseSqlSuggestion, agentSshCommandSuggestion, agentSshDiagnosticResult, agentSshScriptSuggestion, agentVironToolApprovalSuggestion } from "../../shared/agent";
import type { AgentChatMessage, AgentContextCard, AgentConversationSummary, AgentDatabaseReadResult, AgentDatabaseSqlSuggestion, AgentEntryMode, AgentSshCommandSuggestion, AgentSshDiagnosticResult, AgentSshScriptSuggestion, AgentStreamEvent, AgentTurnUsage, AgentVironToolApprovalSuggestion } from "../../shared/agent";
import type { AgentFloatingOverlayAction } from "../../shared/agent-floating-overlay";
import AgentQuickSurface from "./AgentQuickSurface.vue";
import AgentTurnStats from "./AgentTurnStats.vue";

interface AgentOverlayDragState {
  startX: number;
  startY: number;
  origin: AgentFloatingPosition;
}

type AgentSshSuggestionState = AgentSshCommandSuggestion & {
  id: string;
  runId?: string;
  executing?: boolean;
  cancelling?: boolean;
  result?: AgentSshDiagnosticResult;
  error?: string;
};

type AgentDatabaseSuggestionState = AgentDatabaseSqlSuggestion & {
  id: string;
  runId?: string;
  executing?: boolean;
  cancelling?: boolean;
  result?: AgentDatabaseReadResult;
  error?: string;
};

type AgentSshScriptSuggestionState = AgentSshScriptSuggestion & {
  id: string;
};

type AgentVironApprovalState = Omit<AgentVironToolApprovalSuggestion, "input"> & {
  input: unknown;
  id: string;
  executing?: boolean;
  error?: string;
};

const edgeCollapsedStorageKey = "viron-agent-edge-collapsed";
const edgeStorageKey = "viron-agent-edge";
const positionStorageKey = "viron-agent-position";

function currentViewport(): AgentFloatingViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function defaultButtonPosition(viewport: AgentFloatingViewport): AgentFloatingPosition {
  return clampAgentFloatingPosition({ x: viewport.width - AGENT_FLOATING_BUTTON_SIZE - 24, y: viewport.height - AGENT_FLOATING_BUTTON_SIZE - 24 }, viewport);
}

function storedButtonPosition(viewport: AgentFloatingViewport): AgentFloatingPosition {
  try {
    const value = JSON.parse(localStorage.getItem(positionStorageKey) || "null") as Partial<AgentFloatingPosition> | null;
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return clampAgentFloatingPosition({ x: Number(value.x), y: Number(value.y) }, viewport);
    }
  } catch {
    // Fall back to the default position when local state is malformed.
  }
  return defaultButtonPosition(viewport);
}

function storedEdge(): AgentFloatingEdge | null {
  const value = localStorage.getItem(edgeStorageKey);
  return value === "left" || value === "right" || value === "top" || value === "bottom" ? value : null;
}

const desktop = isDesktopApp();
const overlayRuntime = isAgentChatOverlayRuntime();
const open = ref(false);
const viewport = ref<AgentFloatingViewport>(currentViewport());
const buttonPosition = ref<AgentFloatingPosition>(storedButtonPosition(viewport.value));
const edgeCollapsed = ref(localStorage.getItem(edgeCollapsedStorageKey) === "1");
const snappedEdge = ref<AgentFloatingEdge | null>(edgeCollapsed.value ? (storedEdge() || "right") : null);
const dragging = ref(false);
const input = ref("");
const composerExpanded = ref(false);
const settings = desktopAgentSettings;
const settingsError = ref("");
const loadingSettings = ref(false);
const running = ref(false);
const activeRunId = ref("");
const activeMessageId = ref("");
const messages = ref<AgentChatMessage[]>([]);
const currentSessionId = ref("");
const sessionItems = ref<AgentConversationSummary[]>([]);
const sessionsLoading = ref(false);
const historyOpen = ref(false);
const contextCards = ref<AgentContextCard[]>([]);
const toolActivities = ref<AgentToolActivity[]>([]);
const sshSuggestions = ref<AgentSshSuggestionState[]>([]);
const sshScriptSuggestions = ref<AgentSshScriptSuggestionState[]>([]);
const databaseSuggestions = ref<AgentDatabaseSuggestionState[]>([]);
const vironApprovals = ref<AgentVironApprovalState[]>([]);
const addingContext = ref(false);
const quickComposerVisible = ref(false);
const quickBubbleIds = ref<string[]>([]);
const quickBubblePrompts = ref<Record<string, string>>({});
const quickExpandedBubbleId = ref("");
const quickHistoryTiled = ref(false);
const quickBubblesHidden = ref(false);
const activePresentation = ref<AgentEntryMode>("floating");
const agentRoot = ref<HTMLElement | null>(null);
const scrollBody = ref<HTMLElement | null>(null);
const composerInput = ref<HTMLTextAreaElement | null>(null);
let removeAgentEventListener: (() => void) | undefined;
let removeAgentLauncherActionListener: (() => void) | undefined;
let removeNativeViewPointerDownListener: (() => void) | undefined;
let removeAppShortcutListener: (() => void) | undefined;
let removeHostStateListener: (() => void) | undefined;
let removePointerOutsideListener: (() => void) | undefined;
let ignoreMouse = true;
let overlayDragState: AgentOverlayDragState | null = null;
let pendingQuickPrompt = "";
let sessionsLoadSeq = 0;
let launchConversationReady = false;
let loadSessionsTail = Promise.resolve();
const inputLimit = 2000;

if (edgeCollapsed.value && snappedEdge.value) {
  buttonPosition.value = snapAgentFloatingPosition(buttonPosition.value, snappedEdge.value, viewport.value);
}

const visible = computed(() => desktop && Boolean(agentHostState.userId));
const entryMode = computed<AgentEntryMode>(() => desktopAppState.value?.agentEntryMode ?? "disabled");
const floatingVisible = computed(() => visible.value && entryMode.value === "floating");
const configured = computed(() => Boolean(settings.value?.configured));
const sshDiagnosticExecuting = computed(() => sshSuggestions.value.some((item) => item.executing));
const databaseDiagnosticExecuting = computed(() => databaseSuggestions.value.some((item) => item.executing));
const diagnosticActive = computed(() => Boolean(activeRunId.value));
const sendDisabled = computed(() => addingContext.value || diagnosticActive.value || sshDiagnosticExecuting.value || databaseDiagnosticExecuting.value || !input.value.trim() || !configured.value);
const inputCount = computed(() => input.value.length);
const rootStyle = computed(() => ({ left: `${buttonPosition.value.x}px`, top: `${buttonPosition.value.y}px` }));
const panelAlignLeft = computed(() => buttonPosition.value.x + AGENT_FLOATING_BUTTON_SIZE / 2 < viewport.value.width / 2);
const panelBelow = computed(() => buttonPosition.value.y + AGENT_FLOATING_BUTTON_SIZE / 2 < viewport.value.height / 2);
const floatingButtonLabel = computed(() => {
  if (edgeCollapsed.value && !open.value) return tr("展开并打开 Viron Agent");
  return open.value ? tr("关闭 Viron Agent") : tr("打开 Viron Agent");
});
const agentStatusText = computed(() => {
  if (loadingSettings.value) return tr("正在读取本机配置");
  if (settingsError.value) return tr("配置读取失败");
  if (!configured.value) return tr("需要配置模型");
  if (running.value) return tr("正在生成");
  if (diagnosticActive.value) return tr("等待逐步确认");
  return tr("本机模型已就绪");
});
const panelBodyVisible = computed(() => (
  loadingSettings.value
  || Boolean(settingsError.value)
  || !configured.value
  || messages.value.length > 0
  || toolActivities.value.length > 0
  || sshSuggestions.value.length > 0
  || sshScriptSuggestions.value.length > 0
  || databaseSuggestions.value.length > 0
  || vironApprovals.value.length > 0
));
const currentSessionTitle = computed(() => sessionItems.value.find((item) => item.id === currentSessionId.value)?.title || tr("新对话"));
const quickBubbles = computed(() => quickBubbleIds.value.flatMap((id) => {
  const message = messages.value.find((item) => item.id === id && item.role === "assistant");
  if (!message) return [];
  return [{
    id,
    prompt: quickBubblePrompts.value[id] || tr("小 V"),
    content: message.content,
    running: running.value && activeMessageId.value === id,
    durationMs: message.durationMs,
    usage: message.usage,
  }];
}));
const quickActionBubbleId = computed(() => quickBubbleIds.value.at(-1) ?? "");
const quickSshSuggestions = computed(() => (
  quickExpandedBubbleId.value === quickActionBubbleId.value ? sshSuggestions.value : []
));
const quickSshScriptSuggestions = computed(() => (
  quickExpandedBubbleId.value === quickActionBubbleId.value ? sshScriptSuggestions.value : []
));
const quickDatabaseSuggestions = computed(() => (
  quickExpandedBubbleId.value === quickActionBubbleId.value ? databaseSuggestions.value : []
));
const sceneLabel = computed(() => agentSceneName(agentHostState.routeName));
const displayedQuickBubbles = computed(() => quickBubblesHidden.value ? [] : quickBubbles.value);
const chromeVisible = computed(() => visible.value && (
  (entryMode.value === "floating" && open.value)
  || (entryMode.value === "quick" && (quickComposerVisible.value || displayedQuickBubbles.value.length > 0))
));

function quickPromptLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized || tr("小 V");
}

function scriptLineLabel(script: string): string {
  return tr("{{0}} 行", [script.split("\n").length]);
}

function collapseQuickHistoryStack() {
  quickHistoryTiled.value = false;
  if (quickBubbleIds.value.length) {
    quickExpandedBubbleId.value = latestAgentQuickBubbleId(quickBubbleIds.value);
  }
}

function hideQuickBubbles() {
  quickBubblesHidden.value = true;
  collapseQuickHistoryStack();
}

function showQuickBubbles() {
  quickBubblesHidden.value = false;
  if (!quickBubbleIds.value.length && messages.value.length) {
    restoreQuickBubblesFromHistory(messages.value);
  }
}

function toggleQuickHistoryStack() {
  if (quickHistoryTiled.value) {
    collapseQuickHistoryStack();
    return;
  }
  quickHistoryTiled.value = true;
}

function trackQuickBubble(messageId: string, prompt: string) {
  quickBubblesHidden.value = false;
  quickBubblePrompts.value = { ...quickBubblePrompts.value, [messageId]: quickPromptLabel(prompt) };
  quickBubbleIds.value = [...quickBubbleIds.value.filter((id) => id !== messageId), messageId].slice(-3);
  quickExpandedBubbleId.value = messageId;
  quickHistoryTiled.value = false;
}

function closeQuickBubble(messageId: string) {
  if (messageId === quickActionBubbleId.value) stopActiveDiagnostic();
  quickBubbleIds.value = quickBubbleIds.value.filter((id) => id !== messageId);
  if (!quickBubbleIds.value.includes(quickExpandedBubbleId.value)) {
    quickExpandedBubbleId.value = latestAgentQuickBubbleId(quickBubbleIds.value);
  }
  if (quickBubbleIds.value.length <= 1) quickHistoryTiled.value = false;
}

function toggleQuickBubble(messageId: string) {
  const latestId = latestAgentQuickBubbleId(quickBubbleIds.value);
  if (!quickHistoryTiled.value && quickBubbleIds.value.length > 1 && messageId !== latestId) {
    quickHistoryTiled.value = true;
    return;
  }
  quickExpandedBubbleId.value = quickExpandedBubbleId.value === messageId ? "" : messageId;
}

function scrollToBottom() {
  void nextTick(() => {
    if (!scrollBody.value) return;
    scrollBody.value.scrollTop = scrollBody.value.scrollHeight;
  });
}

function resizeComposerInput() {
  const textarea = composerInput.value;
  if (!textarea) return;
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, 118);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > nextHeight ? "auto" : "hidden";
}

function expandComposer() {
  if (!configured.value) {
    void openSettings();
    return;
  }
  if (running.value) return;
  composerExpanded.value = true;
  void nextTick(() => {
    resizeComposerInput();
    composerInput.value?.focus();
    scrollToBottom();
  });
}

function collapseComposer() {
  composerExpanded.value = false;
  scrollToBottom();
}

function nowIso(): string {
  return new Date().toISOString();
}

function newMessage(role: AgentChatMessage["role"], content: string, id: string = crypto.randomUUID()): AgentChatMessage {
  return { id, role, content, createdAt: nowIso() };
}

async function loadSettings() {
  if (!desktop || !agentHostState.userId) return;
  loadingSettings.value = true;
  settingsError.value = "";
  try {
    settings.value = await getDesktopAgentSettings();
  } catch (error) {
    settings.value = null;
    settingsError.value = error instanceof Error ? error.message : tr("读取 Viron Agent 配置失败");
  } finally {
    loadingSettings.value = false;
  }
}

function restoreQuickBubblesFromHistory(history: AgentChatMessage[]) {
  const restored = agentQuickBubblesFromMessages(history);
  quickBubblePrompts.value = Object.fromEntries(restored.map((item) => [item.id, quickPromptLabel(item.prompt)]));
  quickBubbleIds.value = restored.map((item) => item.id);
  quickExpandedBubbleId.value = latestAgentQuickBubbleId(quickBubbleIds.value);
  quickHistoryTiled.value = false;
}

function applyConversation(conversation: { id: string; messages: AgentChatMessage[] }, options?: { restoreQuick?: boolean }) {
  const restoreQuick = options?.restoreQuick === true;
  const keepLiveRun = conversation.id === currentSessionId.value && (running.value || diagnosticActive.value);
  currentSessionId.value = conversation.id;
  if (!keepLiveRun) {
    messages.value = conversation.messages.slice();
    resetRunArtifacts();
  }
  if (restoreQuick) {
    quickBubblesHidden.value = false;
    restoreQuickBubblesFromHistory(keepLiveRun ? messages.value : conversation.messages);
  } else if (!keepLiveRun) {
    quickBubbleIds.value = [];
    quickBubblePrompts.value = {};
    quickExpandedBubbleId.value = "";
    quickHistoryTiled.value = false;
    quickBubblesHidden.value = false;
  }
  scrollToBottom();
}

async function loadSessions(options?: { startFresh?: boolean; restoreQuick?: boolean }) {
  if (!desktop || !agentHostState.userId) return;
  const seq = ++sessionsLoadSeq;
  const run = async () => {
    sessionsLoading.value = true;
    try {
      const current = await getCurrentDesktopAgentSession();
      if (seq !== sessionsLoadSeq) return;
      if (options?.startFresh && shouldStartFreshAgentConversation(current.messages)) {
        const created = await createDesktopAgentSession();
        if (seq !== sessionsLoadSeq) return;
        const list = await listDesktopAgentSessions();
        if (seq !== sessionsLoadSeq) return;
        sessionItems.value = list.items;
        applyConversation(created);
        launchConversationReady = true;
        return;
      }
      const list = await listDesktopAgentSessions();
      if (seq !== sessionsLoadSeq) return;
      sessionItems.value = list.items;
      applyConversation(current, { restoreQuick: options?.restoreQuick === true && !options?.startFresh });
      if (options?.startFresh) launchConversationReady = true;
    } catch (error) {
      if (seq !== sessionsLoadSeq) return;
      ElMessage.error(error instanceof Error ? error.message : tr("读取 Viron Agent 历史会话失败"));
    } finally {
      if (seq === sessionsLoadSeq) sessionsLoading.value = false;
    }
  };
  const queued = loadSessionsTail.then(run, run);
  loadSessionsTail = queued.then(() => undefined, () => undefined);
  return queued;
}

async function ensureLaunchConversation() {
  if (launchConversationReady) return;
  await loadSessions({ startFresh: true });
}

async function refreshSessionList() {
  const list = await listDesktopAgentSessions();
  sessionItems.value = list.items;
  currentSessionId.value = list.currentSessionId;
}

function resetRunArtifacts() {
  toolActivities.value = [];
  sshSuggestions.value = [];
  sshScriptSuggestions.value = [];
  databaseSuggestions.value = [];
  vironApprovals.value = [];
}

async function createConversation() {
  if (diagnosticActive.value) await stopActiveDiagnostic();
  const conversation = await createDesktopAgentSession();
  applyConversation(conversation);
  historyOpen.value = false;
  await refreshSessionList();
}

async function selectConversation(sessionId: string) {
  if (diagnosticActive.value && sessionId !== currentSessionId.value) await stopActiveDiagnostic();
  const conversation = await selectDesktopAgentSession(sessionId);
  applyConversation(conversation, { restoreQuick: true });
  launchConversationReady = true;
  historyOpen.value = false;
}

async function renameConversation(item: AgentConversationSummary) {
  try {
    const response = await ElMessageBox.prompt(tr("请输入新名称"), tr("重命名会话"), {
      confirmButtonText: tr("重命名"),
      cancelButtonText: tr("取消"),
      inputValue: item.title,
      inputValidator: (value) => Boolean(value.trim()) || tr("请输入新名称"),
    });
    const title = response.value.trim();
    if (title === item.title) return;
    await renameDesktopAgentSession(item.id, title);
    await refreshSessionList();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("重命名失败"));
  }
}

async function deleteConversation(item: AgentConversationSummary) {
  const keepWindow = open.value;
  const keepComposer = quickComposerVisible.value;
  const keepHistory = historyOpen.value;
  try {
    await ElMessageBox.confirm(tr("删除会话“{0}”？", [item.title]), tr("删除会话"), {
      confirmButtonText: tr("删除"),
      cancelButtonText: tr("取消"),
      type: "warning",
    });
    if (diagnosticActive.value && item.id === currentSessionId.value) await stopActiveDiagnostic();
    const current = await deleteDesktopAgentSession(item.id);
    applyConversation(current, { restoreQuick: current.messages.length > 0 });
    launchConversationReady = true;
    await refreshSessionList();
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : tr("删除失败"));
    }
  } finally {
    if (keepWindow) open.value = true;
    if (keepComposer) quickComposerVisible.value = true;
    if (keepHistory) historyOpen.value = true;
  }
}

function currentSceneCard(): AgentContextCard {
  return {
    id: `scene:${agentHostState.routePath}`,
    kind: "scene",
    title: sceneLabel.value,
    summary: tr("当前应用页面为{0}，路径为 {1}。该引用不包含连接输出、凭据或工作台编辑内容。", [sceneLabel.value, agentHostState.routePath]),
    source: agentHostState.routePath,
    createdAt: nowIso(),
  };
}

function upsertContextCard(card: AgentContextCard) {
  if (card.kind === "ssh") contextCards.value = contextCards.value.filter((item) => item.kind !== "ssh" || item.id === card.id);
  if (card.kind === "database") contextCards.value = contextCards.value.filter((item) => item.kind !== "database" || item.id === card.id);
  const existingIndex = contextCards.value.findIndex((item) => item.id === card.id);
  if (existingIndex >= 0) contextCards.value.splice(existingIndex, 1, card);
  else contextCards.value.push(card);
}

async function captureCurrentScene() {
  if (addingContext.value || diagnosticActive.value) return;
  contextCards.value = [];
  const snapshot = await performAgentHostAction({ type: "scene-snapshot" });
  if (snapshot.ok && snapshot.result) applyAgentHostState(snapshot.result as import("../../shared/agent-host").AgentHostState);
  const sshScene = agentHostState.ssh?.routePath === agentHostState.routePath ? agentHostState.ssh : null;
  const databaseScene = agentHostState.database?.routePath === agentHostState.routePath ? agentHostState.database : null;
  if (!sshScene) {
    if (databaseScene) {
      if (!databaseScene.localExecution || !databaseScene.connected) {
        upsertContextCard(currentSceneCard());
        return;
      }
      addingContext.value = true;
      try {
        const snapshot = await readDesktopAgentDatabaseContext({
          connectionId: databaseScene.connectionId,
          database: databaseScene.database,
          editorSql: databaseScene.editorSql,
          selectedSql: databaseScene.selectedSql,
          resultPreview: databaseScene.resultPreview,
        });
        const schema = snapshot.schema.map((object) => `${object.type === "view" ? tr("视图") : tr("表")} ${object.name}(${object.columns.map((column) => `${column.name}:${column.dataType}`).join(", ")})`).join("\n");
        upsertContextCard({
          id: `database:${snapshot.connectionId}:${snapshot.database}`,
          kind: "database",
          title: tr("数据库 · {0} / {1}", [snapshot.connectionName, snapshot.database]),
          summary: [tr("目标：{0} / {1}", [snapshot.connectionName, snapshot.database]), `Schema：\n${schema || tr("[无可见对象]")}`, tr("当前 SQL：\n{0}", [snapshot.editorSql || tr("[空]")]), tr("选中 SQL：\n{0}", [snapshot.selectedSql || tr("[无]")]), tr("结果预览：\n{0}", [JSON.stringify(snapshot.resultPreview)])].join("\n"),
          source: `desktop-database:${snapshot.connectionId}:${encodeURIComponent(snapshot.database)}`,
          createdAt: snapshot.capturedAt,
          resourceId: snapshot.connectionId,
        });
      } catch {
        upsertContextCard(currentSceneCard());
      } finally { addingContext.value = false; }
      return;
    }
    upsertContextCard(currentSceneCard());
    return;
  }
  if (sshScene.status !== "connected") {
    upsertContextCard(currentSceneCard());
    return;
  }
  addingContext.value = true;
  try {
    const snapshot = await readDesktopAgentSshContext(sshScene.sessionId);
    const summary = [
      tr("当前 SSH 会话：{0} ({1})。", [snapshot.connectionName, snapshot.host]),
      tr("工作目录线索：{0}。", [sshScene.currentDirectory || tr("未知")]),
      tr("最近输出：{0} 行 / {1} 字节；已移除终端控制字符，脱敏 {2} 处{3}。", [snapshot.lineCount, snapshot.includedBytes, snapshot.redactionCount, snapshot.truncated ? tr("，内容已截断") : ""]),
      snapshot.output ? tr("输出内容：\n{0}", [snapshot.output]) : tr("输出内容：[暂无可用输出]"),
    ].join("\n");
    upsertContextCard({
      id: `ssh:${snapshot.sessionId}`,
      kind: "ssh",
      title: `SSH · ${snapshot.connectionName}`,
      summary,
      source: `${snapshot.executionTarget === "server-forwarded" ? "server" : "desktop"}-ssh:${snapshot.sessionId}`,
      createdAt: snapshot.capturedAt,
      resourceId: snapshot.connectionId,
    });
  } catch {
    upsertContextCard(currentSceneCard());
  } finally {
    addingContext.value = false;
  }
}

function ensureAssistantMessage(messageId: string): AgentChatMessage {
  let message = messages.value.find((item) => item.id === messageId);
  if (!message) {
    message = newMessage("assistant", "", messageId);
    messages.value.push(message);
  }
  return message;
}

function applyTurnStats(messageId: string, durationMs?: number, usage?: AgentTurnUsage) {
  const message = ensureAssistantMessage(messageId);
  if (typeof durationMs === "number") message.durationMs = durationMs;
  if (usage) message.usage = usage;
}

function handleAgentEvent(event: AgentStreamEvent) {
  if (event.type === "workbench-execution-request") {
    if (event.runId !== activeRunId.value) {
      void respondDesktopAgentWorkbenchExecution({ requestId: event.requestId, error: tr("Viron Agent 工作台执行现场已经失效") }).catch(() => undefined);
      return;
    }
    void executeAgentHostWorkbench(event)
      .then((result) => respondDesktopAgentWorkbenchExecution({ requestId: event.requestId, result }))
      .catch((error) => respondDesktopAgentWorkbenchExecution({
        requestId: event.requestId,
        error: error instanceof Error ? error.message : tr("Viron Agent 工作台执行失败"),
      }))
      .catch(() => undefined);
    return;
  }
  if (event.type === "workbench-execution-cancel") {
    void performAgentHostAction({
      type: "workbench-cancel",
      requestId: event.requestId,
      domain: event.domain,
      reason: event.reason,
    }).catch(() => undefined);
    return;
  }
  if (event.type === "run-start") {
    if (event.sessionId !== currentSessionId.value) return;
    activeRunId.value = event.runId;
    activeMessageId.value = event.messageId;
    running.value = true;
    ensureAssistantMessage(event.messageId);
    if (activePresentation.value === "quick") trackQuickBubble(event.messageId, pendingQuickPrompt);
    scrollToBottom();
    return;
  }
  if (event.runId !== activeRunId.value) return;
  if (event.type === "text-delta") {
    ensureAssistantMessage(event.messageId).content += event.delta;
    scrollToBottom();
  } else if (event.type === "tool-call") {
    const activity = agentToolActivity(event);
    if (activity) toolActivities.value.push(activity);
    scrollToBottom();
  } else if (event.type === "tool-result") {
    const activity = agentToolActivity(event);
    if (activity) toolActivities.value.push(activity);
    vironApprovals.value = vironApprovals.value.filter((item) => item.id !== event.toolCallId);
    const suggestion = agentSshCommandSuggestion(event.output);
    if (suggestion) {
      sshSuggestions.value = [
        ...sshSuggestions.value.filter((item) => item.id !== event.toolCallId),
        { ...suggestion, id: event.toolCallId },
      ];
    }
    const scriptSuggestion = agentSshScriptSuggestion(event.output);
    if (scriptSuggestion) {
      sshScriptSuggestions.value = [
        ...sshScriptSuggestions.value.filter((item) => item.id !== event.toolCallId),
        { ...scriptSuggestion, id: event.toolCallId },
      ];
    }
    const databaseSuggestion = agentDatabaseSqlSuggestion(event.output);
    if (databaseSuggestion) databaseSuggestions.value = [...databaseSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...databaseSuggestion, id: event.toolCallId }];
    const sshResult = agentSshDiagnosticResult(event.output);
    if (sshResult) {
      const existing = sshSuggestions.value.find((item) => item.id === event.toolCallId);
      if (existing) Object.assign(existing, { result: sshResult, executing: false, cancelling: false, error: undefined });
    }
    const databaseResult = agentDatabaseReadResult(event.output);
    if (databaseResult) {
      const existing = databaseSuggestions.value.find((item) => item.id === event.toolCallId);
      if (existing) Object.assign(existing, { result: databaseResult, executing: false, cancelling: false, error: undefined });
    }
    scrollToBottom();
  } else if (event.type === "approval-required") {
    const vironApproval = agentVironToolApprovalSuggestion(event.suggestion);
    if (vironApproval) {
      const state: AgentVironApprovalState = Object.assign({}, vironApproval, { id: event.toolCallId });
      vironApprovals.value = [...vironApprovals.value.filter((item) => item.id !== event.toolCallId), state];
    }
    const sshSuggestion = agentSshCommandSuggestion(event.suggestion);
    if (sshSuggestion) {
      sshSuggestions.value = [...sshSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...sshSuggestion, id: event.toolCallId }];
    }
    const databaseSuggestion = agentDatabaseSqlSuggestion(event.suggestion);
    if (databaseSuggestion) {
      databaseSuggestions.value = [...databaseSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...databaseSuggestion, id: event.toolCallId }];
    }
    scrollToBottom();
  } else if (event.type === "execution-start") {
    const vironApproval = agentVironToolApprovalSuggestion(event.suggestion);
    if (vironApproval) {
      const state: AgentVironApprovalState = Object.assign({}, vironApproval, { id: event.toolCallId, executing: true });
      vironApprovals.value = [...vironApprovals.value.filter((item) => item.id !== event.toolCallId), state];
    }
    const sshSuggestion = agentSshCommandSuggestion(event.suggestion);
    if (sshSuggestion) {
      sshSuggestions.value = [...sshSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...sshSuggestion, id: event.toolCallId, runId: event.runId, executing: true }];
    }
    const databaseSuggestion = agentDatabaseSqlSuggestion(event.suggestion);
    if (databaseSuggestion) {
      databaseSuggestions.value = [...databaseSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...databaseSuggestion, id: event.toolCallId, runId: event.runId, executing: true }];
    }
    scrollToBottom();
  } else if (event.type === "tool-error") {
    const vironApproval = vironApprovals.value.find((item) => item.id === event.toolCallId);
    if (vironApproval) Object.assign(vironApproval, { executing: false, error: event.message });
    const sshSuggestion = sshSuggestions.value.find((item) => item.id === event.toolCallId);
    if (sshSuggestion) Object.assign(sshSuggestion, { executing: false, cancelling: false, error: event.message });
    const databaseSuggestion = databaseSuggestions.value.find((item) => item.id === event.toolCallId);
    if (databaseSuggestion) Object.assign(databaseSuggestion, { executing: false, cancelling: false, error: event.message });
    scrollToBottom();
  } else if (event.type === "run-pause") {
    running.value = false;
    scrollToBottom();
  } else if (event.type === "run-finish") {
    applyTurnStats(event.messageId, event.durationMs, event.usage);
    for (const suggestion of [...sshSuggestions.value, ...databaseSuggestions.value]) {
      if (suggestion.approval?.runId === event.runId || suggestion.runId === event.runId) Object.assign(suggestion, { executing: false, cancelling: false });
    }
    running.value = false;
    activeRunId.value = "";
    activeMessageId.value = "";
    void refreshSessionList().catch(() => undefined);
    scrollToBottom();
  } else if (event.type === "run-error") {
    const messageId = event.messageId ?? (activeMessageId.value || crypto.randomUUID());
    ensureAssistantMessage(messageId).content += tr("\n\n请求失败：{0}", [event.message]);
    applyTurnStats(messageId, event.durationMs, event.usage);
    for (const suggestion of [...sshSuggestions.value, ...databaseSuggestions.value]) {
      if (suggestion.approval?.runId === event.runId || suggestion.runId === event.runId) Object.assign(suggestion, { executing: false, cancelling: false, error: event.message });
    }
    running.value = false;
    activeRunId.value = "";
    activeMessageId.value = "";
    scrollToBottom();
  } else if (event.type === "run-abort") {
    const messageId = event.messageId ?? (activeMessageId.value || crypto.randomUUID());
    ensureAssistantMessage(messageId).content += tr("\n\n已停止：{0}", [event.reason]);
    applyTurnStats(messageId, event.durationMs, event.usage);
    if (activePresentation.value === "quick") trackQuickBubble(messageId, pendingQuickPrompt);
    for (const suggestion of [...sshSuggestions.value, ...databaseSuggestions.value]) {
      if ((suggestion.approval?.runId === event.runId || suggestion.runId === event.runId) && !suggestion.result) Object.assign(suggestion, { executing: false, cancelling: false, error: event.reason });
    }
    running.value = false;
    activeRunId.value = "";
    activeMessageId.value = "";
    scrollToBottom();
  }
}

async function sendMessageFor(presentation: AgentEntryMode) {
  const content = input.value.trim();
  if (!content || running.value) return;
  if (diagnosticActive.value || sshDiagnosticExecuting.value || databaseDiagnosticExecuting.value) {
    ElMessage.warning(tr("请先完成或结束当前多步诊断"));
    return;
  }
  if (!configured.value) {
    await openSettings();
    return;
  }
  input.value = "";
  composerExpanded.value = false;
  if (presentation === "quick") quickHistoryTiled.value = false;
  resetRunArtifacts();
  await captureCurrentScene();
  messages.value.push(newMessage("user", content));
  activePresentation.value = presentation;
  pendingQuickPrompt = presentation === "quick" ? content : "";
  scrollToBottom();
  try {
    const started = await sendDesktopAgentChat({
      sessionId: currentSessionId.value,
      message: content,
      sceneHint: {
        routePath: agentHostState.routePath,
        routeName: sceneLabel.value,
        contexts: contextCards.value,
        capturedAt: nowIso(),
      },
    });
    currentSessionId.value = started.sessionId;
    activeRunId.value = activeRunId.value || started.runId;
    activeMessageId.value = activeMessageId.value || started.messageId;
    running.value = true;
  } catch (error) {
    const failure = newMessage("assistant", tr("请求失败：{0}", [error instanceof Error ? error.message : tr("发送 Viron Agent 请求失败")]));
    messages.value.push(failure);
    if (presentation === "quick") trackQuickBubble(failure.id, content);
    running.value = false;
    scrollToBottom();
  }
}

function sendMessage() {
  return sendMessageFor("floating");
}

function sendQuickMessage() {
  if (!input.value.trim() || addingContext.value || diagnosticActive.value || !configured.value) return;
  return sendMessageFor("quick");
}

async function toggleQuickComposer() {
  if (entryMode.value !== "quick") return;
  if (quickComposerVisible.value) {
    quickComposerVisible.value = false;
    return;
  }
  if (!settings.value && !loadingSettings.value) await loadSettings();
  if (loadingSettings.value) {
    ElMessage.info(tr("正在读取 Viron Agent 配置"));
    return;
  }
  if (!configured.value) {
    ElMessage.warning(tr("请先配置 Viron Agent 模型"));
    await openSettings();
    return;
  }
  await ensureLaunchConversation();
  quickComposerVisible.value = true;
  if (messages.value.length && !quickBubblesHidden.value) restoreQuickBubblesFromHistory(messages.value);
}

function handleAppShortcut(action: import("../../shared/keyboard-shortcuts").ShortcutActionId) {
  if (action === "app.agentQuickInput") void toggleQuickComposer();
}

async function fillSshSuggestion(suggestion: AgentSshCommandSuggestion) {
  const prefix = "desktop-ssh:";
  const sessionId = suggestion.source.startsWith(prefix) ? suggestion.source.slice(prefix.length) : "";
  if (!sessionId || !contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source)) {
    ElMessage.warning(tr("该命令建议对应的 SSH 现场已被移除"));
    return;
  }
  const filled = await performAgentHostAction({ type: "fill-ssh", sessionId, command: suggestion.command });
  if (!filled.ok || !filled.filled) {
    ElMessage.warning(tr("请切回对应 SSH 会话，并确认终端停留在 Shell 提示符"));
    return;
  }
  ElMessage.success(tr("命令已填入终端，未执行"));
}

function canFillSshSuggestion(suggestion: AgentSshCommandSuggestion): boolean {
  return suggestion.source.startsWith("desktop-ssh:");
}

async function fillSshScriptSuggestion(suggestion: AgentSshScriptSuggestion) {
  const prefix = "desktop-ssh:";
  const sessionId = suggestion.source.startsWith(prefix) ? suggestion.source.slice(prefix.length) : "";
  if (!sessionId || !contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source)) {
    ElMessage.warning(tr("该脚本建议对应的 SSH 现场已被移除"));
    return;
  }
  const filled = await performAgentHostAction({ type: "fill-ssh-script", sessionId, script: suggestion.script });
  if (!filled.ok || !filled.filled) {
    ElMessage.warning(tr("请切回对应 SSH 会话，确认终端停留在 Shell 提示符并启用安全粘贴模式"));
    return;
  }
  void recordDesktopAgentAction({
    action: "ssh_script_filled",
    target: sessionId,
    summary: tr("将 Viron Agent Shell 脚本安全填入当前终端，未执行（{{0}}，{{1}} 行）", [suggestion.interpreter, suggestion.script.split("\n").length]),
  }).catch(() => undefined);
  ElMessage.success(tr("脚本已安全填入终端，未执行"));
}

function sshSuggestionTarget(suggestion: AgentSshCommandSuggestion): { sessionId: string; context: AgentContextCard } | null {
  const match = suggestion.source.match(/^(?:desktop|server)-ssh:(.+)$/);
  const sessionId = match?.[1] ?? "";
  const context = contextCards.value.find((card) => card.id === suggestion.contextId && card.source === suggestion.source);
  return sessionId && context ? { sessionId, context } : null;
}

function isExecutableSuggestion(execution: AgentSshCommandSuggestion["execution"] | AgentDatabaseSqlSuggestion["execution"]): boolean {
  return execution === "confirm-read" || execution === "confirm-write";
}

function sshSuggestionBadge(suggestion: AgentSshCommandSuggestion): string {
  if (suggestion.approval) {
    return suggestion.execution === "confirm-write"
      ? tr("L3 · 第 {0}/{1} 步", [suggestion.approval.step, suggestion.approval.maxSteps])
      : tr("L2 · 第 {0}/{1} 步", [suggestion.approval.step, suggestion.approval.maxSteps]);
  }
  if (suggestion.execution === "confirm-write") return tr("按策略自动执行写命令");
  if (suggestion.execution === "confirm-read") return tr("按策略自动执行");
  return tr("只填入，不执行");
}

function databaseSuggestionBadge(suggestion: AgentDatabaseSqlSuggestion): string {
  if (suggestion.approval) {
    return suggestion.execution === "confirm-write"
      ? tr("L3 · 第 {0}/{1} 步", [suggestion.approval.step, suggestion.approval.maxSteps])
      : tr("第 {0}/{1} 步", [suggestion.approval.step, suggestion.approval.maxSteps]);
  }
  if (suggestion.execution === "confirm-write") return tr("按策略自动执行写 SQL");
  if (suggestion.execution === "confirm-read") return tr("按策略自动执行");
  return tr("仅填入");
}

async function executeSshSuggestion(suggestion: AgentSshSuggestionState) {
  if (!isExecutableSuggestion(suggestion.execution) || suggestion.executing || !suggestion.approval) return;
  if (!sshSuggestionTarget(suggestion)) return void ElMessage.warning(tr("该命令建议对应的 SSH 现场已被移除"));
  suggestion.executing = true;
  suggestion.cancelling = false;
  suggestion.result = undefined;
  suggestion.error = undefined;
  try {
    await respondDesktopAgentApproval({ runId: suggestion.approval.runId, approvalId: suggestion.approval.approvalId, approved: true });
    ElMessage.info(suggestion.execution === "confirm-write"
      ? tr("已批准第 {0}/{1} 步，正在执行 SSH 写命令", [suggestion.approval.step, suggestion.approval.maxSteps])
      : tr("已批准第 {0}/{1} 步，正在执行 SSH 只读诊断", [suggestion.approval.step, suggestion.approval.maxSteps]));
  } catch (error) {
    suggestion.executing = false;
    suggestion.error = error instanceof Error ? error.message : tr("SSH 命令审批失败");
    ElMessage.error(suggestion.error);
  }
}

async function cancelSshSuggestion(suggestion: AgentSshSuggestionState) {
  const runId = suggestion.approval?.runId ?? suggestion.runId;
  if (!runId || suggestion.cancelling) return;
  suggestion.cancelling = true;
  try {
    const result = await stopDesktopAgentChat(runId);
    if (!result.stopped) suggestion.cancelling = false;
  } catch (error) {
    suggestion.cancelling = false;
    ElMessage.error(error instanceof Error ? error.message : tr("取消 SSH 诊断失败"));
  }
}

async function stopActiveDiagnostic() {
  const runId = activeRunId.value;
  if (!runId) return;
  await stopDesktopAgentChat(runId).catch(() => undefined);
  if (activeRunId.value === runId) {
    running.value = false;
    activeRunId.value = "";
    activeMessageId.value = "";
  }
}

function databaseSuggestionTarget(suggestion: AgentDatabaseSqlSuggestion) {
  const match = suggestion.source.match(/^desktop-database:([^:]+):(.+)$/);
  return match ? { connectionId: match[1], database: decodeURIComponent(match[2]) } : null;
}

async function fillDatabaseSuggestion(suggestion: AgentDatabaseSqlSuggestion) {
  const target = databaseSuggestionTarget(suggestion);
  if (!target || !contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source)) return void ElMessage.warning(tr("该 SQL 对应的数据库现场已被移除"));
  const filled = await performAgentHostAction({
    type: "fill-database",
    connectionId: target.connectionId,
    database: target.database,
    sql: suggestion.sql,
  });
  if (!filled.ok || !filled.filled) return void ElMessage.warning(tr("请切回对应的本机数据库连接和数据库"));
  void recordDesktopAgentAction({ action: "database_sql_filled", target: `${target.connectionId}:${target.database}`, summary: tr("将 Viron Agent SQL 填入当前编辑器，未执行") }).catch(() => undefined);
  ElMessage.success(tr("SQL 已填入编辑器，未执行"));
}

async function executeDatabaseSuggestion(suggestion: AgentDatabaseSuggestionState) {
  const target = databaseSuggestionTarget(suggestion);
  if (!target || !isExecutableSuggestion(suggestion.execution) || suggestion.executing || !suggestion.approval) return;
  if (!contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source)) return void ElMessage.warning(tr("该 SQL 对应的数据库现场已被移除"));
  suggestion.executing = true;
  suggestion.cancelling = false;
  suggestion.result = undefined;
  suggestion.error = undefined;
  try {
    await respondDesktopAgentApproval({ runId: suggestion.approval.runId, approvalId: suggestion.approval.approvalId, approved: true });
    ElMessage.info(suggestion.execution === "confirm-write"
      ? tr("已批准第 {0}/{1} 步，正在执行数据库写 SQL", [suggestion.approval.step, suggestion.approval.maxSteps])
      : tr("已批准第 {0}/{1} 步，正在执行数据库只读查询", [suggestion.approval.step, suggestion.approval.maxSteps]));
  } catch (error) {
    suggestion.executing = false;
    suggestion.error = error instanceof Error ? error.message : tr("数据库 SQL 审批失败");
    ElMessage.error(suggestion.error);
  }
}

async function cancelDatabaseSuggestion(suggestion: AgentDatabaseSuggestionState) {
  const runId = suggestion.approval?.runId ?? suggestion.runId;
  if (!runId || suggestion.cancelling) return;
  suggestion.cancelling = true;
  try {
    const result = await stopDesktopAgentChat(runId);
    if (!result.stopped) suggestion.cancelling = false;
  } catch (error) {
    suggestion.cancelling = false;
    ElMessage.error(error instanceof Error ? error.message : tr("取消数据库诊断失败"));
  }
}

async function respondVironApproval(item: AgentVironApprovalState, approved: boolean) {
  if (item.executing) return;
  item.executing = approved;
  item.error = undefined;
  try {
    await respondDesktopAgentApproval({
      runId: item.approval.runId,
      approvalId: item.approval.approvalId,
      approved,
      ...(!approved ? { reason: tr("用户拒绝了本次 Viron 操作") } : {}),
    });
    if (!approved) vironApprovals.value = vironApprovals.value.filter((candidate) => candidate.id !== item.id);
  } catch (error) {
    item.executing = false;
    item.error = error instanceof Error ? error.message : tr("Viron Agent 工具审批失败");
    ElMessage.error(item.error);
  }
}

async function stopRun() {
  if (!activeRunId.value) return;
  await stopDesktopAgentChat(activeRunId.value).catch(() => undefined);
}

async function openSettings() {
  if (agentHostState.routeName === "settings" && agentHostState.settingsSection === "ai-agent") return;
  await performAgentHostAction({ type: "navigate-settings" });
}

function persistButtonPosition() {
  localStorage.setItem(positionStorageKey, JSON.stringify(buttonPosition.value));
}

function persistEdgeState() {
  localStorage.setItem(edgeCollapsedStorageKey, edgeCollapsed.value ? "1" : "0");
  if (snappedEdge.value) localStorage.setItem(edgeStorageKey, snappedEdge.value);
  else localStorage.removeItem(edgeStorageKey);
}

function collapseAtEdge(edge: AgentFloatingEdge) {
  buttonPosition.value = snapAgentFloatingPosition(buttonPosition.value, edge, viewport.value);
  snappedEdge.value = edge;
  edgeCollapsed.value = true;
  persistButtonPosition();
  persistEdgeState();
}

function expandFromEdge() {
  buttonPosition.value = clampAgentFloatingPosition(buttonPosition.value, viewport.value);
  edgeCollapsed.value = false;
  snappedEdge.value = null;
  persistButtonPosition();
  persistEdgeState();
}

function collapseToEdge() {
  collapseAtEdge(nearestAgentFloatingEdge(buttonPosition.value, viewport.value).edge);
  open.value = false;
}

function togglePanel() {
  if (edgeCollapsed.value) {
    expandFromEdge();
    open.value = true;
    return;
  }
  open.value = !open.value;
}

function settleButtonDrag() {
  const edge = agentFloatingSnapEdge(buttonPosition.value, viewport.value);
  if (edge) collapseAtEdge(edge);
  else {
    edgeCollapsed.value = false;
    snappedEdge.value = null;
    persistButtonPosition();
    persistEdgeState();
  }
}

function handleDesktopLauncherAction(action: AgentFloatingOverlayAction) {
  if (action.type === "toggle") return void togglePanel();
  if (action.type === "expand") return void expandFromEdge();
  if (action.type === "drag-start") {
    if (edgeCollapsed.value) return;
    overlayDragState = { startX: action.screenX, startY: action.screenY, origin: { ...buttonPosition.value } };
    dragging.value = true;
    open.value = false;
    return;
  }
  if (!overlayDragState) return;
  if (action.type === "drag-move") {
    buttonPosition.value = clampAgentFloatingPosition({
      x: overlayDragState.origin.x + action.screenX - overlayDragState.startX,
      y: overlayDragState.origin.y + action.screenY - overlayDragState.startY,
    }, viewport.value);
    return;
  }
  overlayDragState = null;
  dragging.value = false;
  settleButtonDrag();
}

function syncDesktopLauncherOverlay() {
  if (!desktop) return;
  if (!floatingVisible.value) {
    void updateDesktopAgentLauncher(null);
    return;
  }
  const edge = edgeCollapsed.value ? snappedEdge.value : null;
  const layout = agentFloatingOverlayLayout(buttonPosition.value, viewport.value, edge);
  void updateDesktopAgentLauncher({
    ...layout,
    open: open.value,
    running: running.value,
    dragging: dragging.value,
    edgeCollapsed: edgeCollapsed.value,
    snappedEdge: edge,
    label: floatingButtonLabel.value,
  });
}

function handleViewportResize() {
  viewport.value = currentViewport();
  if (edgeCollapsed.value && snappedEdge.value) {
    buttonPosition.value = snapAgentFloatingPosition(buttonPosition.value, snappedEdge.value, viewport.value);
  } else {
    buttonPosition.value = clampAgentFloatingPosition(buttonPosition.value, viewport.value);
  }
  persistButtonPosition();
}

function isDialogOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".el-overlay, .el-popper, .el-message-box, .el-message"));
}

function dialogOverlayOpen(): boolean {
  return Boolean(document.querySelector(".el-overlay.is-message-box, .el-message-box"));
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (isDialogOverlayTarget(event.target)) return;
  if (quickComposerVisible.value) {
    const composer = document.querySelector<HTMLElement>('[data-agent-overlay="quick-composer"]');
    if (event.target instanceof Node && (!composer || !composer.contains(event.target))) {
      quickComposerVisible.value = false;
    }
  }
  if (quickHistoryTiled.value) {
    const bubbles = document.querySelector<HTMLElement>('[data-agent-overlay="quick-bubbles"]');
    if (event.target instanceof Node && (!bubbles || !bubbles.contains(event.target))) {
      collapseQuickHistoryStack();
    }
  }
  if (!open.value || !agentRoot.value) return;
  if (event.target instanceof Node && !agentRoot.value.contains(event.target)) open.value = false;
}

function handleNativeViewPointerDown() {
  if (dialogOverlayOpen()) return;
  quickComposerVisible.value = false;
  collapseQuickHistoryStack();
}

function handlePointerOutside() {
  if (dialogOverlayOpen()) return;
  quickComposerVisible.value = false;
  collapseQuickHistoryStack();
  open.value = false;
}

function isAgentHitTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest([
    ".agent-window",
    ".agent-quick-composer",
    ".agent-quick-bubble",
    ".agent-quick-bubbles",
    ".agent-quick-history",
    ".el-overlay",
    ".el-popper",
    ".el-message-box",
    ".el-message",
    "[data-agent-hit]",
  ].join(", ")));
}

function syncIgnoreMouse(ignore: boolean) {
  if (ignoreMouse === ignore) return;
  ignoreMouse = ignore;
  void setDesktopAgentChatIgnoreMouse(ignore);
}

function handleOverlayMouseMove(event: MouseEvent) {
  if (!chromeVisible.value) return;
  syncIgnoreMouse(!isAgentHitTarget(document.elementFromPoint(event.clientX, event.clientY)));
}

watch(open, (value) => {
  if (value) {
    void loadSettings();
    void ensureLaunchConversation();
  } else {
    composerExpanded.value = false;
  }
});

watch(input, () => {
  if (composerExpanded.value) void nextTick(resizeComposerInput);
});

watch([() => agentHostState.userId, () => desktopAppState.value?.endpoint], () => {
  stopActiveDiagnostic();
  settings.value = null;
  settingsError.value = "";
  composerExpanded.value = false;
  messages.value = [];
  currentSessionId.value = "";
  sessionItems.value = [];
  contextCards.value = [];
  resetRunArtifacts();
  quickComposerVisible.value = false;
  quickBubbleIds.value = [];
  quickBubblePrompts.value = {};
  quickExpandedBubbleId.value = "";
  quickHistoryTiled.value = false;
  quickBubblesHidden.value = false;
  pendingQuickPrompt = "";
  launchConversationReady = false;
  if (agentHostState.userId) {
    void loadSettings();
    void loadSessions();
  }
});

watch([() => agentHostState.workspaceType, () => agentHostState.workspaceId], () => {
  stopActiveDiagnostic();
  contextCards.value = [];
  resetRunArtifacts();
});

watch(entryMode, (mode) => {
  if (mode === "disabled") stopActiveDiagnostic();
  open.value = false;
  composerExpanded.value = false;
  quickComposerVisible.value = false;
  quickExpandedBubbleId.value = "";
  quickHistoryTiled.value = false;
  if (mode === "quick") {
    edgeCollapsed.value = false;
    snappedEdge.value = null;
    if (launchConversationReady && !quickBubblesHidden.value) restoreQuickBubblesFromHistory(messages.value);
  } else {
    quickBubblesHidden.value = false;
  }
});

watch(() => desktopAppState.value?.executionMode, () => {
  if (!contextCards.value.some((card) => card.kind === "ssh")) return;
  stopActiveDiagnostic();
  const sshContextIds = new Set(contextCards.value.filter((card) => card.kind === "ssh").map((card) => card.id));
  contextCards.value = contextCards.value.filter((card) => card.kind !== "ssh");
  sshSuggestions.value = sshSuggestions.value.filter((item) => !sshContextIds.has(item.contextId));
  sshScriptSuggestions.value = sshScriptSuggestions.value.filter((item) => !sshContextIds.has(item.contextId));
});

watch(
  [floatingVisible, open, running, dragging, edgeCollapsed, snappedEdge, buttonPosition, viewport],
  syncDesktopLauncherOverlay,
  { immediate: true },
);

watch(chromeVisible, (value) => {
  if (!desktop) return;
  if (!value) syncIgnoreMouse(true);
  void updateDesktopAgentChatChrome(value);
}, { immediate: true });

watch([open, quickComposerVisible], ([panelOpen, composerVisible]) => {
  if (panelOpen || composerVisible) void focusDesktopAgentChat();
});

onMounted(() => {
  if (!desktop) return;
  removeAgentEventListener = onDesktopAgentEvent(handleAgentEvent);
  removeAgentLauncherActionListener = onDesktopAgentLauncherAction(handleDesktopLauncherAction);
  removeNativeViewPointerDownListener = onDesktopNativeViewPointerDown(handleNativeViewPointerDown);
  removeAppShortcutListener = onAppShortcut(handleAppShortcut);
  removeHostStateListener = onDesktopAgentHostState((state) => applyAgentHostState(state));
  removePointerOutsideListener = onDesktopAgentChatPointerOutside(handlePointerOutside);
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  window.addEventListener("mousemove", handleOverlayMouseMove);
  window.addEventListener("resize", handleViewportResize);
  handleViewportResize();
  void getDesktopAgentHost().then((state) => {
    applyAgentHostState(state);
    void loadSettings();
    void loadSessions();
  });
});

onBeforeUnmount(() => {
  stopActiveDiagnostic();
  removeAgentEventListener?.();
  removeAgentLauncherActionListener?.();
  removeNativeViewPointerDownListener?.();
  removeAppShortcutListener?.();
  removeHostStateListener?.();
  removePointerOutsideListener?.();
  if (desktop) {
    void updateDesktopAgentLauncher(null);
    void updateDesktopAgentChatChrome(false);
  }
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  window.removeEventListener("mousemove", handleOverlayMouseMove);
  window.removeEventListener("resize", handleViewportResize);
});
</script>

<template>
  <div v-if="visible" class="agent-host" :class="{ 'is-native-overlay': overlayRuntime }">
    <div
      v-if="entryMode === 'floating'"
      ref="agentRoot"
      class="agent-floating"
      :class="[
        { 'is-open': open, 'is-edge-collapsed': edgeCollapsed && !open, 'is-dragging': dragging },
        snappedEdge ? `is-edge-${snappedEdge}` : '',
      ]"
      :style="rootStyle"
    >
      <Transition name="agent-window">
      <section
        v-if="open"
        class="agent-window"
        data-agent-hit
        :class="{ 'is-running': running, 'is-align-left': panelAlignLeft, 'is-below': panelBelow }"
        :aria-label="$t('小 V')"
      >
        <span class="agent-window__ambient" aria-hidden="true"></span>
        <header class="agent-window__header">
          <div class="agent-window__identity">
            <span class="agent-window__status-dot" :class="{ 'is-muted': !configured, 'is-running': running }"></span>
            <div><strong>{{ $t('小 V') }}</strong><small :title="currentSessionTitle">{{ currentSessionTitle }}</small></div>
          </div>
          <div class="agent-window__actions" @pointerdown.stop>
            <div class="agent-window__secondary-actions">
              <button class="agent-window__icon-button" type="button" :aria-label="$t('历史会话')" :title="$t('历史会话')" @click="historyOpen = !historyOpen"><History :size="15" /></button>
              <button class="agent-window__icon-button" type="button" :aria-label="$t('新建会话')" :title="$t('新建会话')" @click="createConversation"><Plus :size="15" /></button>
              <button class="agent-window__icon-button" type="button" :aria-label="$t('配置 Viron Agent')" :title="$t('配置')" @click="openSettings"><Settings :size="15" /></button>
              <button class="agent-window__icon-button" type="button" :aria-label="$t('收缩到屏幕边缘')" :title="$t('收缩到屏幕边缘')" @click="collapseToEdge"><PanelRightClose :size="15" /></button>
            </div>
            <button class="agent-window__icon-button" type="button" :aria-label="$t('关闭小 V')" :title="$t('关闭')" @click="open = false"><X :size="16" /></button>
          </div>
        </header>

        <section v-if="historyOpen" class="agent-session-history">
          <header><strong>{{ $t('历史会话') }}</strong><span>{{ sessionItems.length }}</span></header>
          <div>
            <article v-for="item in sessionItems" :key="item.id" :class="{ 'is-current': item.id === currentSessionId }">
              <button type="button" class="agent-session-history__select" @click="selectConversation(item.id)">
                <strong>{{ item.title }}</strong><small>{{ new Date(item.updatedAt).toLocaleString($locale()) }}</small>
              </button>
              <button type="button" :aria-label="$t('重命名会话')" :title="$t('重命名')" @click="renameConversation(item)"><Pencil :size="13" /></button>
              <button type="button" :aria-label="$t('删除会话')" :title="$t('删除')" @click="deleteConversation(item)"><Trash2 :size="13" /></button>
            </article>
          </div>
        </section>

        <div v-if="panelBodyVisible" ref="scrollBody" class="agent-window__body">
          <div v-if="loadingSettings" class="agent-empty">{{ $t('正在读取本机 Viron Agent 配置…') }}</div>
          <div v-else-if="settingsError" class="agent-empty is-error">{{ settingsError }}</div>
          <div v-else-if="!configured" class="agent-empty">
            <strong>{{ $t('需要先配置模型') }}</strong>
            <span>{{ $t('接口地址、API 密钥和模型名称只保存在当前设备。') }}</span>
            <button type="button" @click="openSettings">{{ $t('打开设置') }}</button>
          </div>
          <template v-else>
            <article v-for="message in messages" :key="message.id" class="agent-message" :class="`is-${message.role}`">
              <span>{{ message.role === 'user' ? $t('你') : $t('小 V') }}</span>
              <p v-if="message.role === 'user'">{{ message.content }}</p>
              <template v-else>
                <div class="agent-message__content" v-html="renderAgentMarkdown(message.content || (running && message.id === activeMessageId ? $t('正在生成...') : ''))"></div>
                <AgentTurnStats :duration-ms="message.durationMs" :usage="message.usage" />
              </template>
            </article>
            <div v-if="vironApprovals.length" class="agent-viron-approvals">
              <article v-for="approval in vironApprovals" :key="approval.id">
                <header><strong>{{ approval.title }}</strong><em>{{ approval.riskLevel === 'high' ? $t('高风险') : $t('需要确认') }}</em></header>
                <p>{{ approval.description }}</p>
                <code>{{ JSON.stringify(approval.input, null, 2) }}</code>
                <footer>
                  <button type="button" :disabled="approval.executing" @click="respondVironApproval(approval, true)">{{ approval.executing ? $t('正在执行…') : $t('批准并执行') }}</button>
                  <button v-if="!approval.executing" type="button" class="is-secondary" @click="respondVironApproval(approval, false)">{{ $t('拒绝') }}</button>
                </footer>
                <p v-if="approval.error" class="agent-diagnostic-error">{{ approval.error }}</p>
              </article>
            </div>
            <div v-if="sshSuggestions.length" class="agent-ssh-suggestions">
              <article v-for="suggestion in sshSuggestions" :key="suggestion.id">
                <header><span><TerminalSquare :size="14" />{{ $t('SSH 命令') }}</span><em>{{ sshSuggestionBadge(suggestion) }}</em></header>
                <code>{{ suggestion.command }}</code>
                <p v-if="suggestion.impactPreview" class="agent-impact-preview">{{ suggestion.impactPreview.reason }}</p>
                <p v-if="suggestion.explanation">{{ suggestion.explanation }}</p>
                <footer>
                  <button v-if="canFillSshSuggestion(suggestion)" type="button" @click="fillSshSuggestion(suggestion)"><ClipboardPaste :size="14" />{{ $t('填入终端') }}</button>
                  <button v-if="suggestion.approval && !suggestion.executing && !suggestion.result && !suggestion.error" type="button" @click="executeSshSuggestion(suggestion)">{{ $t('确认并执行') }}</button>
                  <button v-else-if="suggestion.executing" type="button" :disabled="suggestion.cancelling" @click="cancelSshSuggestion(suggestion)">{{ suggestion.cancelling ? $t('正在取消…') : $t('取消诊断') }}</button>
                </footer>
                <p v-if="suggestion.error" class="agent-diagnostic-error">{{ suggestion.error }}</p>
                <div v-if="suggestion.result" class="agent-diagnostic-result">
                  <span>{{ $t('退出码 {0} · {1} ms{2}', [suggestion.result.exitCode ?? $t('未知'), suggestion.result.durationMs, suggestion.result.truncated ? $t(' · 已截断') : '']) }}</span>
                  <p v-if="suggestion.result.presentation === 'workbench'">{{ $t('命令与原始输出已显示在 SSH 终端，Agent 已读取脱敏结果继续分析。') }}</p>
                  <template v-else>
                    <pre v-if="suggestion.result.stdout">{{ suggestion.result.stdout }}</pre>
                    <pre v-if="suggestion.result.stderr" class="is-stderr">{{ suggestion.result.stderr }}</pre>
                  </template>
                </div>
              </article>
            </div>
            <div v-if="sshScriptSuggestions.length" class="agent-ssh-suggestions">
              <article v-for="suggestion in sshScriptSuggestions" :key="suggestion.id">
                <header><span><Code2 :size="14" />{{ $t('Shell 脚本') }}</span><em>{{ $t('安全填入，不执行') }}</em></header>
                <div class="agent-script-meta"><span>{{ $t('解释器') }}</span><strong>{{ suggestion.interpreter }}</strong><span>{{ scriptLineLabel(suggestion.script) }}</span></div>
                <pre class="agent-script-preview">{{ suggestion.script }}</pre>
                <p v-if="suggestion.explanation">{{ suggestion.explanation }}</p>
                <footer><button type="button" @click="fillSshScriptSuggestion(suggestion)"><ClipboardPaste :size="14" />{{ $t('填入终端') }}</button></footer>
              </article>
            </div>
            <div v-if="databaseSuggestions.length" class="agent-ssh-suggestions">
              <article v-for="suggestion in databaseSuggestions" :key="suggestion.id" class="agent-ssh-suggestion">
                <header><Database :size="14" /><strong>{{ $t('数据库 SQL 建议') }}</strong><span>{{ databaseSuggestionBadge(suggestion) }}</span></header>
                <code>{{ suggestion.sql }}</code>
                <p v-if="suggestion.impactPreview" class="agent-impact-preview">
                  {{ suggestion.impactPreview.reason }}
                  <template v-if="suggestion.impactPreview.targets.length"> · {{ suggestion.impactPreview.targets.join(', ') }}</template>
                  <template v-if="suggestion.impactPreview.estimatedRows !== undefined"> · {{ $t('预计影响 {0} 行', [suggestion.impactPreview.estimatedRows]) }}</template>
                </p>
                <p>{{ suggestion.explanation }}</p>
                <footer><button type="button" @click="fillDatabaseSuggestion(suggestion)">{{ $t('填入编辑器') }}</button><button v-if="suggestion.approval && !suggestion.executing && !suggestion.result && !suggestion.error" type="button" @click="executeDatabaseSuggestion(suggestion)">{{ $t('确认并执行') }}</button><button v-else-if="suggestion.executing" type="button" :disabled="suggestion.cancelling" @click="cancelDatabaseSuggestion(suggestion)">{{ suggestion.cancelling ? $t('正在取消…') : $t('取消诊断') }}</button></footer>
                <p v-if="suggestion.error" class="agent-diagnostic-error">{{ suggestion.error }}</p>
                <p v-if="suggestion.result?.presentation === 'workbench'">{{ suggestion.execution === 'confirm-write' ? $t('SQL 与执行结果已显示在数据库工作台，Agent 已读取受影响行数继续分析。') : $t('SQL 与查询结果已显示在数据库工作台，Agent 已读取受限结果继续分析。') }}</p>
                <p v-else-if="suggestion.result && suggestion.execution === 'confirm-write'">{{ $t('已影响 {0} 行', [suggestion.result.affectedRows ?? suggestion.result.rowCount]) }}</p>
                <pre v-else-if="suggestion.result">{{ JSON.stringify(suggestion.result.rows, null, 2) }}</pre>
              </article>
            </div>
            <details v-if="toolActivities.length" class="agent-tool-log">
              <summary><span><Activity :size="13" />{{ $t('运行详情') }}</span><em>{{ toolActivities.length }} {{ $t('条') }}</em><ChevronDown :size="13" /></summary>
              <div>
                <article v-for="item in toolActivities" :key="item.id" :class="`is-${item.type}`">
                  <header><strong>{{ item.title }}</strong><small>{{ item.toolName }}</small></header>
                  <p v-if="item.detail">{{ item.detail }}</p>
                </article>
              </div>
            </details>
          </template>
        </div>

        <footer class="agent-window__composer">
          <div v-if="!composerExpanded" class="agent-composer-collapsed">
            <button class="agent-composer-trigger" type="button" :disabled="diagnosticActive" @click="expandComposer">
              <MessageSquareText :size="16" />
              <span>{{ input ? $t('继续编辑草稿') : $t('输入消息') }}</span>
              <small v-if="input">{{ inputCount }}/{{ inputLimit }}</small>
            </button>
            <button v-if="diagnosticActive" class="agent-composer__send is-stop" type="button" :aria-label="$t('结束诊断')" :title="$t('结束诊断')" @click="stopRun"><CircleStop :size="18" /></button>
          </div>
          <div v-else class="agent-composer">
            <textarea
              ref="composerInput"
              v-model="input"
              rows="2"
              :placeholder="$t('向小 V 提问')"
              :maxlength="inputLimit"
              :disabled="diagnosticActive || !configured"
              @input="resizeComposerInput"
              @keydown.enter.exact.prevent="sendMessage"
            ></textarea>
            <div class="agent-composer__bar">
              <span class="agent-composer__counter">{{ inputCount }}/{{ inputLimit }}</span>
              <button class="agent-composer__collapse" type="button" :aria-label="$t('收起输入框')" :title="$t('收起输入框')" @click="collapseComposer"><ChevronDown :size="17" /></button>
              <button v-if="diagnosticActive" class="agent-composer__send is-stop" type="button" :aria-label="$t('结束诊断')" :title="$t('结束诊断')" @click="stopRun"><CircleStop :size="18" /></button>
              <button v-else class="agent-composer__send" type="button" :aria-label="$t('发送')" :title="$t('发送')" :disabled="sendDisabled" @click="sendMessage"><Send :size="19" /></button>
            </div>
          </div>
          <div class="agent-composer__meta">
            <span :title="agentStatusText"><Info :size="13" />{{ $t('按') }} <kbd>Shift + Enter</kbd> {{ $t('换行') }}</span>
            <span class="agent-composer__live"><i aria-hidden="true"></i>{{ configured ? $t('本机模型运行正常') : $t('请先完成本机配置') }}</span>
          </div>
        </footer>
      </section>
      </Transition>
    </div>
    <AgentQuickSurface
      v-else-if="entryMode === 'quick'"
      :composer-visible="quickComposerVisible"
      :input="input"
      :input-limit="inputLimit"
      :running="running"
      :active="diagnosticActive"
      :configured="configured"
      :adding-context="addingContext"
      :session-items="sessionItems"
      :current-session-id="currentSessionId"
      :history-open="historyOpen"
      :bubbles="displayedQuickBubbles"
      :expanded-bubble-id="quickExpandedBubbleId"
      :history-tiled="quickHistoryTiled"
      :bubbles-hidden="quickBubblesHidden"
      :can-restore-bubbles="messages.length > 0"
      :ssh-suggestions="quickSshSuggestions"
      :ssh-script-suggestions="quickSshScriptSuggestions"
      :database-suggestions="quickDatabaseSuggestions"
      :viron-approvals="vironApprovals"
      @update-input="input = $event"
      @submit="sendQuickMessage"
      @close-composer="quickComposerVisible = false"
      @toggle-history="historyOpen = !historyOpen"
      @create-session="createConversation"
      @select-session="selectConversation"
      @rename-session="renameConversation"
      @delete-session="deleteConversation"
      @approve-viron="respondVironApproval"
      @toggle-bubble="toggleQuickBubble"
      @close-bubble="closeQuickBubble"
      @hide-bubbles="hideQuickBubbles"
      @show-bubbles="showQuickBubbles"
      @toggle-history-stack="toggleQuickHistoryStack"
      @stop="stopRun"
      @fill-ssh="fillSshSuggestion"
      @fill-ssh-script="fillSshScriptSuggestion"
      @execute-ssh="executeSshSuggestion"
      @cancel-ssh="cancelSshSuggestion"
      @fill-database="fillDatabaseSuggestion"
      @execute-database="executeDatabaseSuggestion"
      @cancel-database="cancelDatabaseSuggestion"
    />
  </div>
</template>

<style scoped>
.agent-host { display: contents; }
.agent-host.is-native-overlay .agent-window {
  background: linear-gradient(135deg, rgba(39, 39, 42, .94), rgba(24, 24, 27, .96));
}

.agent-floating {
  --agent-bg-start: rgba(39, 39, 42, .80);
  --agent-bg-end: rgba(24, 24, 27, .90);
  --agent-text: #f4f4f5;
  --agent-soft-text: #a1a1aa;
  --agent-muted-text: #71717a;
  --agent-green: #22c55e;
  --agent-purple: #8b5cf6;
  --agent-red: #ef4444;
  position: fixed;
  z-index: 120;
  width: 64px;
  height: 64px;
  pointer-events: none;
  font-family: var(--font-ui);
  transition: left .2s ease, top .2s ease, transform .2s ease;
}

.agent-floating.is-dragging {
  transition: none;
}

.agent-window,
.agent-window button,
.agent-window textarea {
  pointer-events: auto;
}

.agent-window {
  position: absolute;
  right: 0;
  bottom: 80px;
  width: min(430px, calc(100vw - 32px));
  height: min(640px, calc(100dvh - 112px));
  max-height: calc(100dvh - 112px);
  border: 1px solid rgba(113, 113, 122, .50);
  border-radius: 20px;
  background: linear-gradient(135deg, var(--agent-bg-start), var(--agent-bg-end));
  color: var(--agent-text);
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, .48),
    0 18px 46px rgba(39, 30, 70, .20);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform-origin: bottom right;
  backdrop-filter: blur(48px) saturate(1.08);
}

.agent-window.is-align-left {
  right: auto;
  left: 0;
  transform-origin: bottom left;
}

.agent-window.is-below {
  top: 80px;
  bottom: auto;
  transform-origin: top right;
}

.agent-window.is-align-left.is-below {
  transform-origin: top left;
}

.agent-window::before,
.agent-window__ambient {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}

.agent-window::before {
  content: "";
  z-index: 0;
  background: linear-gradient(135deg, rgba(239, 68, 68, .05), transparent 50%, rgba(147, 51, 234, .05));
}

.agent-window__ambient {
  z-index: 0;
  background:
    radial-gradient(circle at 10% 0, rgba(255, 255, 255, .05), transparent 34%),
    linear-gradient(118deg, rgba(255, 255, 255, .025), transparent 36%);
}

.agent-window > :not(.agent-window__ambient) {
  position: relative;
  z-index: 1;
}

.agent-window__header {
  min-height: 42px;
  padding: 11px 16px 6px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.agent-window__identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.agent-window__identity > div { min-width: 0; display: grid; gap: 1px; }
.agent-window__identity small { max-width: 100%; overflow: hidden; color: var(--agent-muted-text); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }

.agent-window__identity strong {
  overflow: hidden;
  color: var(--agent-soft-text);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-window__status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--agent-green);
}

.agent-window__status-dot.is-muted {
  background: #71717a;
}

.agent-window__status-dot.is-running {
  animation: agent-status-pulse 1.2s ease-in-out infinite;
}

.agent-window__actions {
  display: flex;
  align-items: center;
  gap: 1px;
}

.agent-window__secondary-actions {
  display: flex;
}

.agent-window__icon-button,
.agent-composer__tool,
.agent-composer__send {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--agent-soft-text);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.agent-window__icon-button {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  transition: background-color .16s ease, color .16s ease;
}

.agent-window__icon-button svg {
  width: 14px;
  height: 14px;
}

.agent-window__icon-button:hover {
  background: rgba(63, 63, 70, .50);
  color: #e4e4e7;
}

.agent-session-history { min-height: 0; max-height: 230px; margin: 4px 14px 8px; border-block: 1px solid rgba(82, 82, 91, .42); overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.agent-session-history > header { min-height: 34px; display: flex; align-items: center; justify-content: space-between; color: var(--agent-soft-text); font-size: 10px; }
.agent-session-history > header span { color: var(--agent-muted-text); }
.agent-session-history > div { min-height: 0; padding-bottom: 6px; overflow-y: auto; display: grid; gap: 3px; }
.agent-session-history article { min-width: 0; min-height: 42px; padding: 3px; border-radius: 6px; display: grid; grid-template-columns: minmax(0, 1fr) 28px 28px; align-items: center; gap: 2px; }
.agent-session-history article:hover, .agent-session-history article.is-current { background: rgba(63, 63, 70, .44); }
.agent-session-history button { min-width: 0; height: 28px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--agent-muted-text); display: grid; place-items: center; cursor: pointer; }
.agent-session-history button:hover { background: rgba(82, 82, 91, .5); color: #e4e4e7; }
.agent-session-history__select { height: 38px !important; padding-inline: 7px !important; justify-items: start; align-content: center; text-align: left; }
.agent-session-history__select strong, .agent-session-history__select small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-session-history__select strong { color: #e4e4e7; font-size: 11px; }
.agent-session-history__select small { color: var(--agent-muted-text); font-size: 9px; }

.agent-window__body {
  min-height: 0;
  min-width: 0;
  margin: 3px 14px 7px;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 4px;
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 10px;
  scrollbar-color: rgba(161, 161, 170, .35) transparent;
}

.agent-empty {
  min-height: 100px;
  padding: 14px;
  border: 1px dashed rgba(113, 113, 122, .48);
  border-radius: 14px;
  background: rgba(39, 39, 42, .28);
  color: var(--agent-muted-text);
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  text-align: center;
  font-size: 11px;
}

.agent-empty strong {
  color: #e4e4e7;
  font-size: 13px;
}

.agent-empty button {
  height: 30px;
  padding-inline: 12px;
  border: 1px solid rgba(139, 92, 246, .5);
  border-radius: 999px;
  background: rgba(124, 58, 237, .22);
  color: #ddd6fe;
  cursor: pointer;
}

.agent-empty.is-error {
  border-color: rgba(239, 68, 68, .38);
  color: #fda4af;
}

.agent-message {
  min-width: 0;
  width: fit-content;
  max-width: 86%;
  display: grid;
  gap: 4px;
}

.agent-message > span {
  color: var(--agent-muted-text);
  font-size: 10px;
}

.agent-message > p,
.agent-message__content {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 8px 11px;
  border-radius: 13px;
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.55;
  font-size: 12px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, .16);
}

.agent-message > p,
.agent-message__content :deep(p) {
  white-space: pre-wrap;
}

.agent-message__content :deep(p),
.agent-message__content :deep(ul),
.agent-message__content :deep(ol),
.agent-message__content :deep(pre) {
  margin: 0;
}

.agent-message__content :deep(p + p),
.agent-message__content :deep(p + ul),
.agent-message__content :deep(p + ol),
.agent-message__content :deep(ul + p),
.agent-message__content :deep(ol + p),
.agent-message__content :deep(pre + p) {
  margin-top: 8px;
}

.agent-message__content :deep(ul),
.agent-message__content :deep(ol) {
  padding-left: 18px;
}

.agent-message__content :deep(li + li) {
  margin-top: 3px;
}

.agent-message__content :deep(strong) {
  color: #f4f4f5;
  font-weight: 650;
}

.agent-message__content :deep(a) {
  color: #c4b5fd;
  overflow-wrap: anywhere;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.agent-message__content :deep(code) {
  max-width: 100%;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(9, 9, 11, .58);
  color: #e4e4e7;
  font-family: var(--font-mono);
  font-size: .92em;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.agent-message__content :deep(pre) {
  max-width: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 8px;
  border-radius: 6px;
  background: rgba(9, 9, 11, .72);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-message__content :deep(pre code) {
  padding: 0;
  background: transparent;
  white-space: inherit;
}

.agent-message__content :deep(table) {
  width: 100%;
  max-width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.agent-message__content :deep(th),
.agent-message__content :deep(td) {
  padding: 4px 5px;
  border: 1px solid rgba(82, 82, 91, .5);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.agent-message__content :deep(blockquote) {
  min-width: 0;
  margin: 8px 0 0;
  padding-left: 9px;
  border-left: 1px solid rgba(196, 181, 253, .48);
}

.agent-message.is-user {
  align-self: flex-end;
  text-align: right;
}

.agent-message.is-assistant {
  align-self: stretch;
  width: 100%;
  max-width: 100%;
}

.agent-message.is-user > p {
  background: linear-gradient(135deg, #8b5cf6, #6d28d9);
  color: #fff;
}

.agent-message.is-assistant .agent-message__content {
  border: 1px solid rgba(82, 82, 91, .5);
  background: rgba(39, 39, 42, .5);
  color: #d4d4d8;
}

.agent-message.is-assistant :deep(.agent-turn-stats) {
  --agent-turn-stats-color: rgba(113, 113, 122, .92);
  --agent-turn-stats-dot: rgba(82, 82, 91, .9);
  margin-top: 1px;
  padding-left: 2px;
}

.agent-ssh-suggestions {
  display: grid;
  gap: 7px;
}

.agent-viron-approvals { display: grid; gap: 7px; }
.agent-viron-approvals > article { min-width: 0; padding: 10px; border: 1px solid rgba(251, 191, 36, .34); border-radius: 7px; background: rgba(120, 53, 15, .18); display: grid; gap: 7px; }
.agent-viron-approvals header, .agent-viron-approvals footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-viron-approvals header strong { color: #fde68a; font-size: 11px; }
.agent-viron-approvals header em { color: #fbbf24; font-size: 9px; font-style: normal; }
.agent-viron-approvals p { margin: 0; color: #a1a1aa; font-size: 10px; line-height: 1.45; }
.agent-viron-approvals code { max-height: 160px; padding: 7px; border-radius: 5px; background: rgba(24, 24, 27, .66); color: #e4e4e7; font: 10px/1.45 var(--font-mono); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-viron-approvals button { min-height: 28px; padding: 0 10px; border: 1px solid rgba(245, 158, 11, .42); border-radius: 6px; background: rgba(146, 64, 14, .42); color: #fef3c7; cursor: pointer; font-size: 10px; font-weight: 650; }
.agent-viron-approvals button.is-secondary { border-color: rgba(113, 113, 122, .5); background: rgba(39, 39, 42, .5); color: #d4d4d8; }
.agent-viron-approvals button:disabled { opacity: .55; cursor: wait; }

.agent-ssh-suggestions article {
  min-width: 0;
  max-width: 100%;
  padding: 9px;
  border: 1px solid rgba(52, 211, 153, .28);
  border-radius: 8px;
  background: rgba(20, 83, 68, .18);
  display: grid;
  gap: 7px;
}

.agent-ssh-suggestions header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agent-ssh-suggestions header span {
  color: #a7f3d0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 650;
}

.agent-ssh-suggestions header em {
  color: #6ee7b7;
  font-size: 9px;
  font-style: normal;
}

.agent-ssh-suggestions code {
  max-width: 100%;
  overflow: hidden;
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(9, 20, 19, .72);
  color: #ecfdf5;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-ssh-suggestions pre {
  max-width: 100%;
  margin: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-ssh-suggestions .agent-script-preview {
  max-height: 260px;
  padding: 8px;
  border-radius: 6px;
  background: rgba(9, 20, 19, .72);
  color: #ecfdf5;
  font: 10px/1.5 var(--font-mono);
}

.agent-script-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #a1a1aa;
  font-size: 9px;
}

.agent-script-meta strong {
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(52, 211, 153, .12);
  color: #a7f3d0;
  font-family: var(--font-mono);
}

.agent-ssh-suggestions p {
  margin: 0;
  color: #a1a1aa;
  font-size: 10px;
  line-height: 1.45;
}

.agent-ssh-suggestions footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.agent-ssh-suggestions button {
  width: fit-content;
  height: 28px;
  padding: 0 9px;
  border: 1px solid rgba(52, 211, 153, .36);
  border-radius: 6px;
  background: rgba(6, 95, 70, .42);
  color: #d1fae5;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 650;
}

.agent-ssh-suggestions button:hover:not(:disabled) {
  background: rgba(5, 150, 105, .38);
}

.agent-ssh-suggestions button:disabled {
  opacity: .52;
  cursor: wait;
}

.agent-diagnostic-result {
  min-width: 0;
  padding-top: 2px;
  display: grid;
  gap: 6px;
}

.agent-diagnostic-result > span {
  color: #a7f3d0;
  font-size: 9px;
  font-weight: 650;
}

.agent-diagnostic-result > pre {
  max-height: 180px;
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(9, 20, 19, .72);
  color: #d1fae5;
  font: 10px/1.5 var(--font-mono);
}

.agent-diagnostic-result > pre.is-stderr {
  border: 1px solid rgba(251, 146, 60, .24);
  color: #fed7aa;
}

.agent-diagnostic-error {
  margin: 0;
  color: #fecaca;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.agent-tool-log {
  border-top: 1px solid rgba(82, 82, 91, .36);
  padding-top: 8px;
}

.agent-tool-log summary {
  min-height: 30px;
  color: var(--agent-muted-text);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 20px;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  font-size: 10px;
}

.agent-tool-log summary::-webkit-details-marker {
  display: none;
}

.agent-tool-log summary span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.agent-tool-log summary em {
  font-style: normal;
}

.agent-tool-log summary > svg {
  transition: transform .18s var(--ease-out);
}

.agent-tool-log[open] summary > svg {
  transform: rotate(180deg);
}

.agent-tool-log > div {
  display: grid;
  gap: 6px;
}

.agent-tool-log article {
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(39, 39, 42, .42);
}

.agent-tool-log article header {
  min-width: 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.agent-tool-log article strong {
  color: #d4d4d8;
  font-size: 10px;
}

.agent-tool-log article small {
  overflow: hidden;
  color: var(--agent-muted-text);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-tool-log article p {
  margin: 4px 0 0;
  color: var(--agent-soft-text);
  font-size: 10px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.agent-window__composer {
  position: relative;
  flex: 0 0 auto;
  margin-top: auto;
  padding: 0 14px 12px;
}

.agent-composer-collapsed {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.agent-composer-collapsed__context,
.agent-composer-trigger,
.agent-composer__collapse {
  height: 40px;
  border: 1px solid rgba(82, 82, 91, .5);
  border-radius: 8px;
  background: rgba(39, 39, 42, .5);
  color: var(--agent-soft-text);
  cursor: pointer;
  transition: background-color .18s var(--ease-out), border-color .18s var(--ease-out), color .18s var(--ease-out);
}

.agent-composer-collapsed__context,
.agent-composer__collapse {
  width: 40px;
  padding: 0;
  display: grid;
  place-items: center;
}

.agent-composer-trigger {
  min-width: 0;
  padding: 0 12px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  text-align: left;
}

.agent-composer-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-composer-trigger small {
  color: var(--agent-muted-text);
  font-size: 10px;
}

.agent-composer-collapsed__context:hover:not(:disabled),
.agent-composer-trigger:hover:not(:disabled),
.agent-composer__collapse:hover:not(:disabled) {
  border-color: rgba(139, 92, 246, .5);
  background: rgba(63, 63, 70, .62);
  color: #e4e4e7;
}

.agent-composer-collapsed__context:disabled,
.agent-composer-trigger:disabled {
  opacity: .5;
  cursor: not-allowed;
}

.agent-composer {
  min-width: 0;
}

.agent-composer textarea {
  width: 100%;
  min-height: 54px;
  max-height: 118px;
  padding: 8px 6px;
  resize: none;
  border: 0;
  background: transparent;
  color: #f4f4f5;
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.6;
  outline: 0;
  caret-color: #fff;
  scrollbar-width: none;
}

.agent-composer textarea::-webkit-scrollbar {
  display: none;
}

.agent-composer textarea::placeholder {
  color: #71717a;
}

.agent-composer textarea:disabled {
  color: rgba(161, 161, 170, .5);
  cursor: not-allowed;
}

.agent-composer__bar {
  min-height: 40px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px 40px;
  align-items: center;
  gap: 8px;
}

.agent-composer__tool-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.agent-composer__tools {
  min-width: 0;
  padding: 3px;
  border: 1px solid rgba(63, 63, 70, .50);
  border-radius: 10px;
  background: rgba(39, 39, 42, .40);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
}

.agent-composer__tool {
  position: relative;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: 8px;
  color: #71717a;
  transition: background-color .3s ease, color .3s ease, transform .3s ease;
}

.agent-composer__tool svg {
  width: 14px;
  height: 14px;
}

.agent-composer__tool.is-figma svg {
  fill: currentColor;
}

.agent-composer__tool.is-primary {
  color: #71717a;
}

.agent-composer__tool:hover:not(:disabled) {
  background: rgba(39, 39, 42, .80);
  color: #e4e4e7;
  transform: scale(1.05) rotate(-3deg);
}

.agent-composer__tool:disabled {
  opacity: .78;
  cursor: default;
}

.agent-composer__voice {
  border: 1px solid rgba(63, 63, 70, .30);
  border-radius: 9px;
}

.agent-composer__counter {
  color: #71717a;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.agent-composer__send {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  background: linear-gradient(to right, #dc2626, var(--agent-red));
  color: #fff;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, .10);
  transition: transform .3s ease, filter .3s ease, box-shadow .3s ease;
}

.agent-composer__send svg {
  width: 17px;
  height: 17px;
}

.agent-composer__send:hover:not(:disabled) {
  transform: scale(1.1) rotate(-2deg);
  filter: brightness(1.08);
  box-shadow: 0 12px 24px rgba(239, 68, 68, .30);
}

.agent-composer__send:active:not(:disabled) {
  transform: scale(.95);
}

.agent-composer__send:disabled {
  background: linear-gradient(to right, #dc2626, var(--agent-red));
  color: rgba(255, 255, 255, .72);
  opacity: 1;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, .10);
  cursor: default;
}

.agent-composer__send.is-stop {
  border: 1px solid rgba(239, 68, 68, .32);
  background: rgba(39, 39, 42, .78);
  color: #f87171;
  box-shadow: none;
}

.agent-composer__meta {
  min-width: 0;
  min-height: 20px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(39, 39, 42, .50);
  color: #71717a;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 10px;
}

.agent-composer__meta > span {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-composer__meta kbd {
  padding: 2px 5px;
  border: 1px solid #52525b;
  border-radius: 4px;
  background: #27272a;
  color: #a1a1aa;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.4;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .12);
}

.agent-composer__live {
  justify-content: flex-end;
}

.agent-composer__live i {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--agent-green);
}

.agent-window__icon-button:focus-visible,
.agent-composer__tool:focus-visible,
.agent-composer__send:focus-visible,
.agent-composer-collapsed__context:focus-visible,
.agent-composer-trigger:focus-visible,
.agent-composer__collapse:focus-visible,
.agent-tool-log summary:focus-visible,
.agent-empty button:focus-visible {
  outline: 2px solid rgba(167, 139, 250, .78);
  outline-offset: 2px;
}

.agent-window-enter-active {
  animation: agent-window-pop-in .3s cubic-bezier(.175, .885, .32, 1.275) both;
}

.agent-window-leave-active {
  animation: agent-window-pop-out .2s ease-in both;
}

@keyframes agent-window-pop-in {
  0% {
    opacity: 0;
    transform: scale(.8) translateY(20px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes agent-window-pop-out {
  0% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  100% {
    opacity: 0;
    transform: scale(.9) translateY(12px);
  }
}

@keyframes agent-status-pulse {
  0%,
  100% {
    opacity: .72;
    transform: scale(.92);
  }
  50% {
    opacity: 1;
    transform: scale(1.12);
  }
}

@media (max-width: 30rem) {
  .agent-window,
  .agent-window.is-align-left,
  .agent-window.is-below,
  .agent-window.is-align-left.is-below {
    position: fixed;
    top: auto;
    right: 16px;
    bottom: 96px;
    left: 16px;
    width: auto;
    height: min(640px, calc(100dvh - 104px));
    max-height: calc(100dvh - 104px);
    transform-origin: bottom right;
  }

  .agent-window__header {
    padding-inline: 14px;
  }

  .agent-composer__bar {
    grid-template-columns: minmax(0, 1fr) 40px 40px;
  }

  .agent-composer__counter {
    display: none;
  }

  .agent-composer__tool {
    width: 30px;
  }

  .agent-composer__voice {
    display: none;
  }

  .agent-composer__meta {
    justify-content: flex-start;
  }

  .agent-composer__live {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-window__status-dot.is-running {
    animation: none;
  }

  .agent-window-enter-active,
  .agent-window-leave-active {
    animation-duration: .01ms;
    transition-duration: .01ms;
  }
}
</style>
