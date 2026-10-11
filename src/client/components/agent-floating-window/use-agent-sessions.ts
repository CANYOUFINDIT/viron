import { translate as tr } from "../../i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { ref } from "vue";
import { createDesktopAgentSession, deleteDesktopAgentSession, getDesktopAgentSettings, getCurrentDesktopAgentSession, listDesktopAgentSessions, renameDesktopAgentSession, selectDesktopAgentSession } from "../../desktop";
import { agentHostState } from "../../agent-host";
import { shouldStartFreshAgentConversation } from "../../agent-quick-history";
import type { AgentChatMessage, AgentConversationSummary } from "../../../shared/agent";
import { deferAgentFloatingPart, type AgentFloatingContext } from "./context";

export function useAgentSessions(ctx: AgentFloatingContext) {
  const $launcherChrome = deferAgentFloatingPart(ctx, "launcherChrome");
  const $chat = deferAgentFloatingPart(ctx, "chat");
  const $suggestions = deferAgentFloatingPart(ctx, "suggestions");
  const currentSessionId = ref("");

  const sessionItems = ref<AgentConversationSummary[]>([]);

  const sessionsLoading = ref(false);

  const historyOpen = ref(false);

  let sessionsLoadSeq = 0;

  let launchConversationReady = false;

  let loadSessionsTail = Promise.resolve();

  async function loadSettings() {
      if (!$launcherChrome.desktop || !agentHostState.userId)
          return;
      $chat.loadingSettings.value = true;
      $chat.settingsError.value = "";
      try {
          $chat.settings.value = await getDesktopAgentSettings();
      }
      catch (error) {
          $chat.settings.value = null;
          $chat.settingsError.value = error instanceof Error ? error.message : tr("读取 Viron Agent 配置失败");
      }
      finally {
          $chat.loadingSettings.value = false;
      }
  }

  function applyConversation(conversation: {
      id: string;
      messages: AgentChatMessage[];
  }, options?: {
      restoreQuick?: boolean;
  }) {
      const restoreQuick = options?.restoreQuick === true;
      const keepLiveRun = conversation.id === currentSessionId.value && ($chat.running.value || $chat.diagnosticActive.value);
      currentSessionId.value = conversation.id;
      if (!keepLiveRun) {
          $chat.messages.value = conversation.messages.slice();
          resetRunArtifacts();
      }
      if (restoreQuick) {
          $chat.quickBubblesHidden.value = false;
          $chat.restoreQuickBubblesFromHistory(keepLiveRun ? $chat.messages.value : conversation.messages);
      }
      else if (!keepLiveRun) {
          $chat.quickBubbleIds.value = [];
          $chat.quickBubblePrompts.value = {};
          $chat.quickExpandedBubbleId.value = "";
          $chat.quickHistoryTiled.value = false;
          $chat.quickBubblesHidden.value = false;
      }
      $chat.scrollToBottom();
  }

  async function loadSessions(options?: {
      startFresh?: boolean;
      restoreQuick?: boolean;
  }) {
      if (!$launcherChrome.desktop || !agentHostState.userId)
          return;
      const seq = ++sessionsLoadSeq;
      const run = async () => {
          sessionsLoading.value = true;
          try {
              const current = await getCurrentDesktopAgentSession();
              if (seq !== sessionsLoadSeq)
                  return;
              if (options?.startFresh && shouldStartFreshAgentConversation(current.messages)) {
                  const created = await createDesktopAgentSession();
                  if (seq !== sessionsLoadSeq)
                      return;
                  const list = await listDesktopAgentSessions();
                  if (seq !== sessionsLoadSeq)
                      return;
                  sessionItems.value = list.items;
                  applyConversation(created);
                  launchConversationReady = true;
                  return;
              }
              const list = await listDesktopAgentSessions();
              if (seq !== sessionsLoadSeq)
                  return;
              sessionItems.value = list.items;
              applyConversation(current, { restoreQuick: options?.restoreQuick === true && !options?.startFresh });
              if (options?.startFresh)
                  launchConversationReady = true;
          }
          catch (error) {
              if (seq !== sessionsLoadSeq)
                  return;
              ElMessage.error(error instanceof Error ? error.message : tr("读取 Viron Agent 历史会话失败"));
          }
          finally {
              if (seq === sessionsLoadSeq)
                  sessionsLoading.value = false;
          }
      };
      const queued = loadSessionsTail.then(run, run);
      loadSessionsTail = queued.then(() => undefined, () => undefined);
      return queued;
  }

  async function ensureLaunchConversation() {
      if (launchConversationReady)
          return;
      await loadSessions({ startFresh: true });
  }

  async function refreshSessionList() {
      const list = await listDesktopAgentSessions();
      sessionItems.value = list.items;
      currentSessionId.value = list.currentSessionId;
  }

  function resetRunArtifacts() {
      $chat.toolActivities.value = [];
      $suggestions.sshSuggestions.value = [];
      $suggestions.sshScriptSuggestions.value = [];
      $suggestions.databaseSuggestions.value = [];
      $suggestions.vironApprovals.value = [];
  }

  async function createConversation() {
      if ($chat.diagnosticActive.value)
          await $suggestions.stopActiveDiagnostic();
      const conversation = await createDesktopAgentSession();
      applyConversation(conversation);
      historyOpen.value = false;
      await refreshSessionList();
  }

  async function selectConversation(sessionId: string) {
      if ($chat.diagnosticActive.value && sessionId !== currentSessionId.value)
          await $suggestions.stopActiveDiagnostic();
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
          if (title === item.title)
              return;
          await renameDesktopAgentSession(item.id, title);
          await refreshSessionList();
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          ElMessage.error(error instanceof Error ? error.message : tr("重命名失败"));
      }
  }

  async function deleteConversation(item: AgentConversationSummary) {
      const keepWindow = $launcherChrome.open.value;
      const keepComposer = $chat.quickComposerVisible.value;
      const keepHistory = historyOpen.value;
      try {
          await ElMessageBox.confirm(tr("删除会话“{0}”？", [item.title]), tr("删除会话"), {
              confirmButtonText: tr("删除"),
              cancelButtonText: tr("取消"),
              type: "warning",
          });
          if ($chat.diagnosticActive.value && item.id === currentSessionId.value)
              await $suggestions.stopActiveDiagnostic();
          const current = await deleteDesktopAgentSession(item.id);
          applyConversation(current, { restoreQuick: current.messages.length > 0 });
          launchConversationReady = true;
          await refreshSessionList();
      }
      catch (error) {
          if (error !== "cancel" && error !== "close") {
              ElMessage.error(error instanceof Error ? error.message : tr("删除失败"));
          }
      }
      finally {
          if (keepWindow)
              $launcherChrome.open.value = true;
          if (keepComposer)
              $chat.quickComposerVisible.value = true;
          if (keepHistory)
              historyOpen.value = true;
      }
  }

  return {
    currentSessionId,
    sessionItems,
    sessionsLoading,
    historyOpen,
    sessionsLoadSeq,
    get launchConversationReady() { return launchConversationReady; },
    set launchConversationReady(value: boolean) { launchConversationReady = value; },
    loadSessionsTail,
    loadSettings,
    applyConversation,
    loadSessions,
    ensureLaunchConversation,
    refreshSessionList,
    createConversation,
    selectConversation,
    renameConversation,
    deleteConversation,
    resetRunArtifacts,
  };
}
