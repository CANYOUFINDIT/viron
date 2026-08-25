import { translate as tr } from "../../i18n";
import { Activity, ChevronDown, CircleStop, ClipboardPaste, Code2, Database, History, Info, MessageSquareText, PanelRightClose, Pencil, Plus, Send, Settings, TerminalSquare, Trash2, X, } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { desktopAppState, desktopAgentSettings, createDesktopAgentSession, deleteDesktopAgentSession, getDesktopAgentSettings, getCurrentDesktopAgentSession, isDesktopApp, listDesktopAgentSessions, onDesktopAgentEvent, onDesktopAgentLauncherAction, onDesktopNativeViewPointerDown, readDesktopAgentSshContext, readDesktopAgentDatabaseContext, recordDesktopAgentAction, renameDesktopAgentSession, respondDesktopAgentWorkbenchExecution, respondDesktopAgentApproval, sendDesktopAgentChat, selectDesktopAgentSession, stopDesktopAgentChat, updateDesktopAgentLauncher, } from "../../desktop";
import { agentHostState, applyAgentHostState, executeAgentHostWorkbench, isAgentChatOverlayRuntime, getDesktopAgentHost, focusDesktopAgentChat, onDesktopAgentChatPointerOutside, onDesktopAgentHostState, performAgentHostAction, setDesktopAgentChatIgnoreMouse, updateDesktopAgentChatChrome, } from "../../agent-host";
import { onAppShortcut } from "../../keyboard-shortcuts";
import { AGENT_FLOATING_BUTTON_SIZE, agentFloatingSnapEdge, clampAgentFloatingPosition, nearestAgentFloatingEdge, snapAgentFloatingPosition, type AgentFloatingEdge, type AgentFloatingPosition, type AgentFloatingViewport, } from "../../agent-floating-position";
import { agentFloatingOverlayLayout } from "../../agent-floating-overlay";
import { agentQuickBubblesFromMessages, latestAgentQuickBubbleId, shouldStartFreshAgentConversation } from "../../agent-quick-history";
import { agentSceneName } from "../../agent-context-card-display";
import { renderAgentMarkdown } from "../../agent-markdown";
import { agentToolActivity, type AgentToolActivity } from "../../agent-tool-activity";
import { agentDatabaseReadResult, agentDatabaseSqlSuggestion, agentSshCommandSuggestion, agentSshDiagnosticResult, agentSshScriptSuggestion, agentVironToolApprovalSuggestion } from "../../../shared/agent";
import type { AgentChatMessage, AgentContextCard, AgentConversationSummary, AgentDatabaseReadResult, AgentDatabaseSqlSuggestion, AgentEntryMode, AgentSshCommandSuggestion, AgentSshDiagnosticResult, AgentSshScriptSuggestion, AgentStreamEvent, AgentTurnUsage, AgentVironToolApprovalSuggestion } from "../../../shared/agent";
import type { AgentFloatingOverlayAction } from "../../../shared/agent-floating-overlay";
import AgentQuickSurface from "../AgentQuickSurface.vue";
import AgentTurnStats from "../AgentTurnStats.vue";
import type { AgentOverlayDragState, AgentSshSuggestionState, AgentDatabaseSuggestionState, AgentSshScriptSuggestionState, AgentVironApprovalState } from "./types";
import { deferAgentFloatingPart, type AgentFloatingContext } from "./context";

export function useAgentChat(ctx: AgentFloatingContext) {
  const $launcherChrome = deferAgentFloatingPart(ctx, "launcherChrome");
  const $sessions = deferAgentFloatingPart(ctx, "sessions");
  const $suggestions = deferAgentFloatingPart(ctx, "suggestions");
  const input = ref("");

  const composerExpanded = ref(false);

  const settings = desktopAgentSettings;

  const settingsError = ref("");

  const loadingSettings = ref(false);

  const running = ref(false);

  const activeRunId = ref("");

  const activeMessageId = ref("");

  const messages = ref<AgentChatMessage[]>([]);

  const contextCards = ref<AgentContextCard[]>([]);

  const toolActivities = ref<AgentToolActivity[]>([]);

  const addingContext = ref(false);

  const quickComposerVisible = ref(false);

  const quickBubbleIds = ref<string[]>([]);

  const quickBubblePrompts = ref<Record<string, string>>({});

  const quickExpandedBubbleId = ref("");

  const quickHistoryTiled = ref(false);

  const quickBubblesHidden = ref(false);

  const scrollBody = ref<HTMLElement | null>(null);

  const composerInput = ref<HTMLTextAreaElement | null>(null);

  let pendingQuickPrompt = "";

  const inputLimit = 2000;

  const configured = computed(() => Boolean(settings.value?.configured));

  const diagnosticActive = computed(() => Boolean(activeRunId.value));

  const sendDisabled = computed(() => addingContext.value || diagnosticActive.value || $suggestions.sshDiagnosticExecuting.value || $suggestions.databaseDiagnosticExecuting.value || !input.value.trim() || !configured.value);

  const inputCount = computed(() => input.value.length);

  const agentStatusText = computed(() => {
      if (loadingSettings.value)
          return tr("正在读取本机配置");
      if (settingsError.value)
          return tr("配置读取失败");
      if (!configured.value)
          return tr("需要配置模型");
      if (running.value)
          return tr("正在生成");
      if (diagnosticActive.value)
          return tr("等待逐步确认");
      return tr("本机模型已就绪");
  });

  const panelBodyVisible = computed(() => (loadingSettings.value
      || Boolean(settingsError.value)
      || !configured.value
      || messages.value.length > 0
      || toolActivities.value.length > 0
      || $suggestions.sshSuggestions.value.length > 0
      || $suggestions.sshScriptSuggestions.value.length > 0
      || $suggestions.databaseSuggestions.value.length > 0
      || $suggestions.vironApprovals.value.length > 0));

  const currentSessionTitle = computed(() => $sessions.sessionItems.value.find((item) => item.id === $sessions.currentSessionId.value)?.title || tr("新对话"));

  const quickBubbles = computed(() => quickBubbleIds.value.flatMap((id) => {
      const message = messages.value.find((item) => item.id === id && item.role === "assistant");
      if (!message)
          return [];
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

  const sceneLabel = computed(() => agentSceneName(agentHostState.routeName));

  const displayedQuickBubbles = computed(() => quickBubblesHidden.value ? [] : quickBubbles.value);

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
      if (messageId === quickActionBubbleId.value)
          $suggestions.stopActiveDiagnostic();
      quickBubbleIds.value = quickBubbleIds.value.filter((id) => id !== messageId);
      if (!quickBubbleIds.value.includes(quickExpandedBubbleId.value)) {
          quickExpandedBubbleId.value = latestAgentQuickBubbleId(quickBubbleIds.value);
      }
      if (quickBubbleIds.value.length <= 1)
          quickHistoryTiled.value = false;
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
          if (!scrollBody.value)
              return;
          scrollBody.value.scrollTop = scrollBody.value.scrollHeight;
      });
  }

  function resizeComposerInput() {
      const textarea = composerInput.value;
      if (!textarea)
          return;
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
      if (running.value)
          return;
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

  function restoreQuickBubblesFromHistory(history: AgentChatMessage[]) {
      const restored = agentQuickBubblesFromMessages(history);
      quickBubblePrompts.value = Object.fromEntries(restored.map((item) => [item.id, quickPromptLabel(item.prompt)]));
      quickBubbleIds.value = restored.map((item) => item.id);
      quickExpandedBubbleId.value = latestAgentQuickBubbleId(quickBubbleIds.value);
      quickHistoryTiled.value = false;
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
      if (card.kind === "ssh")
          contextCards.value = contextCards.value.filter((item) => item.kind !== "ssh" || item.id === card.id);
      if (card.kind === "database")
          contextCards.value = contextCards.value.filter((item) => item.kind !== "database" || item.id === card.id);
      const existingIndex = contextCards.value.findIndex((item) => item.id === card.id);
      if (existingIndex >= 0)
          contextCards.value.splice(existingIndex, 1, card);
      else
          contextCards.value.push(card);
  }

  async function captureCurrentScene() {
      if (addingContext.value || diagnosticActive.value)
          return;
      contextCards.value = [];
      const snapshot = await performAgentHostAction({ type: "scene-snapshot" });
      if (snapshot.ok && snapshot.result)
          applyAgentHostState(snapshot.result as import("../../../shared/agent-host").AgentHostState);
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
              }
              catch {
                  upsertContextCard(currentSceneCard());
              }
              finally {
                  addingContext.value = false;
              }
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
      }
      catch {
          upsertContextCard(currentSceneCard());
      }
      finally {
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
      if (typeof durationMs === "number")
          message.durationMs = durationMs;
      if (usage)
          message.usage = usage;
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
          if (event.sessionId !== $sessions.currentSessionId.value)
              return;
          activeRunId.value = event.runId;
          activeMessageId.value = event.messageId;
          running.value = true;
          ensureAssistantMessage(event.messageId);
          if ($launcherChrome.activePresentation.value === "quick")
              trackQuickBubble(event.messageId, pendingQuickPrompt);
          scrollToBottom();
          return;
      }
      if (event.runId !== activeRunId.value)
          return;
      if (event.type === "text-delta") {
          ensureAssistantMessage(event.messageId).content += event.delta;
          scrollToBottom();
      }
      else if (event.type === "tool-call") {
          const activity = agentToolActivity(event);
          if (activity)
              toolActivities.value.push(activity);
          scrollToBottom();
      }
      else if (event.type === "tool-result") {
          const activity = agentToolActivity(event);
          if (activity)
              toolActivities.value.push(activity);
          $suggestions.vironApprovals.value = $suggestions.vironApprovals.value.filter((item) => item.id !== event.toolCallId);
          const suggestion = agentSshCommandSuggestion(event.output);
          if (suggestion) {
              $suggestions.sshSuggestions.value = [
                  ...$suggestions.sshSuggestions.value.filter((item) => item.id !== event.toolCallId),
                  { ...suggestion, id: event.toolCallId },
              ];
          }
          const scriptSuggestion = agentSshScriptSuggestion(event.output);
          if (scriptSuggestion) {
              $suggestions.sshScriptSuggestions.value = [
                  ...$suggestions.sshScriptSuggestions.value.filter((item) => item.id !== event.toolCallId),
                  { ...scriptSuggestion, id: event.toolCallId },
              ];
          }
          const databaseSuggestion = agentDatabaseSqlSuggestion(event.output);
          if (databaseSuggestion)
              $suggestions.databaseSuggestions.value = [...$suggestions.databaseSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...databaseSuggestion, id: event.toolCallId }];
          const sshResult = agentSshDiagnosticResult(event.output);
          if (sshResult) {
              const existing = $suggestions.sshSuggestions.value.find((item) => item.id === event.toolCallId);
              if (existing)
                  Object.assign(existing, { result: sshResult, executing: false, cancelling: false, error: undefined });
          }
          const databaseResult = agentDatabaseReadResult(event.output);
          if (databaseResult) {
              const existing = $suggestions.databaseSuggestions.value.find((item) => item.id === event.toolCallId);
              if (existing)
                  Object.assign(existing, { result: databaseResult, executing: false, cancelling: false, error: undefined });
          }
          scrollToBottom();
      }
      else if (event.type === "approval-required") {
          const vironApproval = agentVironToolApprovalSuggestion(event.suggestion);
          if (vironApproval) {
              const state: AgentVironApprovalState = Object.assign({}, vironApproval, { id: event.toolCallId });
              $suggestions.vironApprovals.value = [...$suggestions.vironApprovals.value.filter((item) => item.id !== event.toolCallId), state];
          }
          const sshSuggestion = agentSshCommandSuggestion(event.suggestion);
          if (sshSuggestion) {
              $suggestions.sshSuggestions.value = [...$suggestions.sshSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...sshSuggestion, id: event.toolCallId }];
          }
          const databaseSuggestion = agentDatabaseSqlSuggestion(event.suggestion);
          if (databaseSuggestion) {
              $suggestions.databaseSuggestions.value = [...$suggestions.databaseSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...databaseSuggestion, id: event.toolCallId }];
          }
          scrollToBottom();
      }
      else if (event.type === "execution-start") {
          const vironApproval = agentVironToolApprovalSuggestion(event.suggestion);
          if (vironApproval) {
              const state: AgentVironApprovalState = Object.assign({}, vironApproval, { id: event.toolCallId, executing: true });
              $suggestions.vironApprovals.value = [...$suggestions.vironApprovals.value.filter((item) => item.id !== event.toolCallId), state];
          }
          const sshSuggestion = agentSshCommandSuggestion(event.suggestion);
          if (sshSuggestion) {
              $suggestions.sshSuggestions.value = [...$suggestions.sshSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...sshSuggestion, id: event.toolCallId, runId: event.runId, executing: true }];
          }
          const databaseSuggestion = agentDatabaseSqlSuggestion(event.suggestion);
          if (databaseSuggestion) {
              $suggestions.databaseSuggestions.value = [...$suggestions.databaseSuggestions.value.filter((item) => item.id !== event.toolCallId), { ...databaseSuggestion, id: event.toolCallId, runId: event.runId, executing: true }];
          }
          scrollToBottom();
      }
      else if (event.type === "tool-error") {
          const vironApproval = $suggestions.vironApprovals.value.find((item) => item.id === event.toolCallId);
          if (vironApproval)
              Object.assign(vironApproval, { executing: false, error: event.message });
          const sshSuggestion = $suggestions.sshSuggestions.value.find((item) => item.id === event.toolCallId);
          if (sshSuggestion)
              Object.assign(sshSuggestion, { executing: false, cancelling: false, error: event.message });
          const databaseSuggestion = $suggestions.databaseSuggestions.value.find((item) => item.id === event.toolCallId);
          if (databaseSuggestion)
              Object.assign(databaseSuggestion, { executing: false, cancelling: false, error: event.message });
          scrollToBottom();
      }
      else if (event.type === "run-pause") {
          running.value = false;
          scrollToBottom();
      }
      else if (event.type === "run-finish") {
          applyTurnStats(event.messageId, event.durationMs, event.usage);
          for (const suggestion of [...$suggestions.sshSuggestions.value, ...$suggestions.databaseSuggestions.value]) {
              if (suggestion.approval?.runId === event.runId || suggestion.runId === event.runId)
                  Object.assign(suggestion, { executing: false, cancelling: false });
          }
          running.value = false;
          activeRunId.value = "";
          activeMessageId.value = "";
          void $sessions.refreshSessionList().catch(() => undefined);
          scrollToBottom();
      }
      else if (event.type === "run-error") {
          const messageId = event.messageId ?? (activeMessageId.value || crypto.randomUUID());
          ensureAssistantMessage(messageId).content += tr("\n\n请求失败：{0}", [event.message]);
          applyTurnStats(messageId, event.durationMs, event.usage);
          for (const suggestion of [...$suggestions.sshSuggestions.value, ...$suggestions.databaseSuggestions.value]) {
              if (suggestion.approval?.runId === event.runId || suggestion.runId === event.runId)
                  Object.assign(suggestion, { executing: false, cancelling: false, error: event.message });
          }
          running.value = false;
          activeRunId.value = "";
          activeMessageId.value = "";
          scrollToBottom();
      }
      else if (event.type === "run-abort") {
          const messageId = event.messageId ?? (activeMessageId.value || crypto.randomUUID());
          ensureAssistantMessage(messageId).content += tr("\n\n已停止：{0}", [event.reason]);
          applyTurnStats(messageId, event.durationMs, event.usage);
          if ($launcherChrome.activePresentation.value === "quick")
              trackQuickBubble(messageId, pendingQuickPrompt);
          for (const suggestion of [...$suggestions.sshSuggestions.value, ...$suggestions.databaseSuggestions.value]) {
              if ((suggestion.approval?.runId === event.runId || suggestion.runId === event.runId) && !suggestion.result)
                  Object.assign(suggestion, { executing: false, cancelling: false, error: event.reason });
          }
          running.value = false;
          activeRunId.value = "";
          activeMessageId.value = "";
          scrollToBottom();
      }
  }

  async function sendMessageFor(presentation: AgentEntryMode) {
      const content = input.value.trim();
      if (!content || running.value)
          return;
      if (diagnosticActive.value || $suggestions.sshDiagnosticExecuting.value || $suggestions.databaseDiagnosticExecuting.value) {
          ElMessage.warning(tr("请先完成或结束当前多步诊断"));
          return;
      }
      if (!configured.value) {
          await openSettings();
          return;
      }
      input.value = "";
      composerExpanded.value = false;
      if (presentation === "quick")
          quickHistoryTiled.value = false;
      $sessions.resetRunArtifacts();
      await captureCurrentScene();
      messages.value.push(newMessage("user", content));
      $launcherChrome.activePresentation.value = presentation;
      pendingQuickPrompt = presentation === "quick" ? content : "";
      scrollToBottom();
      try {
          const started = await sendDesktopAgentChat({
              sessionId: $sessions.currentSessionId.value,
              message: content,
              sceneHint: {
                  routePath: agentHostState.routePath,
                  routeName: sceneLabel.value,
                  contexts: contextCards.value,
                  capturedAt: nowIso(),
              },
          });
          $sessions.currentSessionId.value = started.sessionId;
          activeRunId.value = activeRunId.value || started.runId;
          activeMessageId.value = activeMessageId.value || started.messageId;
          running.value = true;
      }
      catch (error) {
          const failure = newMessage("assistant", tr("请求失败：{0}", [error instanceof Error ? error.message : tr("发送 Viron Agent 请求失败")]));
          messages.value.push(failure);
          if (presentation === "quick")
              trackQuickBubble(failure.id, content);
          running.value = false;
          scrollToBottom();
      }
  }

  function sendMessage() {
      return sendMessageFor("floating");
  }

  function sendQuickMessage() {
      if (!input.value.trim() || addingContext.value || diagnosticActive.value || !configured.value)
          return;
      return sendMessageFor("quick");
  }

  async function toggleQuickComposer() {
      if ($launcherChrome.entryMode.value !== "quick")
          return;
      if (quickComposerVisible.value) {
          quickComposerVisible.value = false;
          return;
      }
      if (!settings.value && !loadingSettings.value)
          await $sessions.loadSettings();
      if (loadingSettings.value) {
          ElMessage.info(tr("正在读取 Viron Agent 配置"));
          return;
      }
      if (!configured.value) {
          ElMessage.warning(tr("请先配置 Viron Agent 模型"));
          await openSettings();
          return;
      }
      await $sessions.ensureLaunchConversation();
      quickComposerVisible.value = true;
      if (messages.value.length && !quickBubblesHidden.value)
          restoreQuickBubblesFromHistory(messages.value);
  }

  function handleAppShortcut(action: import("../../../shared/keyboard-shortcuts").ShortcutActionId) {
      if (action === "app.agentQuickInput")
          void toggleQuickComposer();
  }

  async function stopRun() {
      if (!activeRunId.value)
          return;
      await stopDesktopAgentChat(activeRunId.value).catch(() => undefined);
  }

  async function openSettings() {
      if (agentHostState.routeName === "settings" && agentHostState.settingsSection === "ai-agent")
          return;
      await performAgentHostAction({ type: "navigate-settings" });
  }

  function startAgentChatWatchers() {
    watch($launcherChrome.open, (value) => {
        if (value) {
            void $sessions.loadSettings();
            void $sessions.ensureLaunchConversation();
        }
        else {
            composerExpanded.value = false;
        }
    });

    watch(input, () => {
        if (composerExpanded.value)
            void nextTick(resizeComposerInput);
    });

    watch([() => agentHostState.userId, () => desktopAppState.value?.endpoint], () => {
        $suggestions.stopActiveDiagnostic();
        settings.value = null;
        settingsError.value = "";
        composerExpanded.value = false;
        messages.value = [];
        $sessions.currentSessionId.value = "";
        $sessions.sessionItems.value = [];
        contextCards.value = [];
        $sessions.resetRunArtifacts();
        quickComposerVisible.value = false;
        quickBubbleIds.value = [];
        quickBubblePrompts.value = {};
        quickExpandedBubbleId.value = "";
        quickHistoryTiled.value = false;
        quickBubblesHidden.value = false;
        pendingQuickPrompt = "";
        $sessions.launchConversationReady = false;
        if (agentHostState.userId) {
            void $sessions.loadSettings();
            void $sessions.loadSessions();
        }
    });

    watch([() => agentHostState.workspaceType, () => agentHostState.workspaceId], () => {
        $suggestions.stopActiveDiagnostic();
        contextCards.value = [];
        $sessions.resetRunArtifacts();
    });

    watch($launcherChrome.entryMode, (mode) => {
        if (mode === "disabled")
            $suggestions.stopActiveDiagnostic();
        $launcherChrome.open.value = false;
        composerExpanded.value = false;
        quickComposerVisible.value = false;
        quickExpandedBubbleId.value = "";
        quickHistoryTiled.value = false;
        if (mode === "quick") {
            $launcherChrome.edgeCollapsed.value = false;
            $launcherChrome.snappedEdge.value = null;
            if ($sessions.launchConversationReady && !quickBubblesHidden.value)
                restoreQuickBubblesFromHistory(messages.value);
        }
        else {
            quickBubblesHidden.value = false;
        }
    });
  }

  return {
    input,
    composerExpanded,
    settings,
    settingsError,
    loadingSettings,
    running,
    activeRunId,
    activeMessageId,
    messages,
    contextCards,
    toolActivities,
    addingContext,
    quickComposerVisible,
    quickBubbleIds,
    quickBubblePrompts,
    quickExpandedBubbleId,
    quickHistoryTiled,
    quickBubblesHidden,
    scrollBody,
    composerInput,
    pendingQuickPrompt,
    inputLimit,
    configured,
    diagnosticActive,
    sendDisabled,
    inputCount,
    agentStatusText,
    panelBodyVisible,
    currentSessionTitle,
    quickBubbles,
    quickActionBubbleId,
    sceneLabel,
    displayedQuickBubbles,
    nowIso,
    newMessage,
    restoreQuickBubblesFromHistory,
    collapseQuickHistoryStack,
    hideQuickBubbles,
    showQuickBubbles,
    toggleQuickHistoryStack,
    trackQuickBubble,
    closeQuickBubble,
    toggleQuickBubble,
    scrollToBottom,
    resizeComposerInput,
    expandComposer,
    collapseComposer,
    quickPromptLabel,
    scriptLineLabel,
    currentSceneCard,
    upsertContextCard,
    captureCurrentScene,
    ensureAssistantMessage,
    applyTurnStats,
    handleAgentEvent,
    sendMessageFor,
    sendMessage,
    sendQuickMessage,
    toggleQuickComposer,
    handleAppShortcut,
    stopRun,
    openSettings,
    startAgentChatWatchers,
  };
}
