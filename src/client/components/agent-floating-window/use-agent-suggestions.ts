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

export function useAgentSuggestions(ctx: AgentFloatingContext) {
  const $launcherChrome = deferAgentFloatingPart(ctx, "launcherChrome");
  const $sessions = deferAgentFloatingPart(ctx, "sessions");
  const $chat = deferAgentFloatingPart(ctx, "chat");
  const sshSuggestions = ref<AgentSshSuggestionState[]>([]);

  const sshScriptSuggestions = ref<AgentSshScriptSuggestionState[]>([]);

  const databaseSuggestions = ref<AgentDatabaseSuggestionState[]>([]);

  const vironApprovals = ref<AgentVironApprovalState[]>([]);

  const sshDiagnosticExecuting = computed(() => sshSuggestions.value.some((item) => item.executing));

  const databaseDiagnosticExecuting = computed(() => databaseSuggestions.value.some((item) => item.executing));

  const quickSshSuggestions = computed(() => ($chat.quickExpandedBubbleId.value === $chat.quickActionBubbleId.value ? sshSuggestions.value : []));

  const quickSshScriptSuggestions = computed(() => ($chat.quickExpandedBubbleId.value === $chat.quickActionBubbleId.value ? sshScriptSuggestions.value : []));

  const quickDatabaseSuggestions = computed(() => ($chat.quickExpandedBubbleId.value === $chat.quickActionBubbleId.value ? databaseSuggestions.value : []));

  async function fillSshSuggestion(suggestion: AgentSshCommandSuggestion) {
      const prefix = "desktop-ssh:";
      const sessionId = suggestion.source.startsWith(prefix) ? suggestion.source.slice(prefix.length) : "";
      if (!sessionId || !$chat.contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source)) {
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
      if (!sessionId || !$chat.contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source)) {
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

  function sshSuggestionTarget(suggestion: AgentSshCommandSuggestion): {
      sessionId: string;
      context: AgentContextCard;
  } | null {
      const match = suggestion.source.match(/^(?:desktop|server)-ssh:(.+)$/);
      const sessionId = match?.[1] ?? "";
      const context = $chat.contextCards.value.find((card) => card.id === suggestion.contextId && card.source === suggestion.source);
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
      if (suggestion.execution === "confirm-write")
          return tr("按策略自动执行写命令");
      if (suggestion.execution === "confirm-read")
          return tr("按策略自动执行");
      return tr("只填入，不执行");
  }

  function databaseSuggestionBadge(suggestion: AgentDatabaseSqlSuggestion): string {
      if (suggestion.approval) {
          return suggestion.execution === "confirm-write"
              ? tr("L3 · 第 {0}/{1} 步", [suggestion.approval.step, suggestion.approval.maxSteps])
              : tr("第 {0}/{1} 步", [suggestion.approval.step, suggestion.approval.maxSteps]);
      }
      if (suggestion.execution === "confirm-write")
          return tr("按策略自动执行写 SQL");
      if (suggestion.execution === "confirm-read")
          return tr("按策略自动执行");
      return tr("仅填入");
  }

  async function executeSshSuggestion(suggestion: AgentSshSuggestionState) {
      if (!isExecutableSuggestion(suggestion.execution) || suggestion.executing || !suggestion.approval)
          return;
      if (!sshSuggestionTarget(suggestion))
          return void ElMessage.warning(tr("该命令建议对应的 SSH 现场已被移除"));
      suggestion.executing = true;
      suggestion.cancelling = false;
      suggestion.result = undefined;
      suggestion.error = undefined;
      try {
          await respondDesktopAgentApproval({ runId: suggestion.approval.runId, approvalId: suggestion.approval.approvalId, approved: true });
          ElMessage.info(suggestion.execution === "confirm-write"
              ? tr("已批准第 {0}/{1} 步，正在执行 SSH 写命令", [suggestion.approval.step, suggestion.approval.maxSteps])
              : tr("已批准第 {0}/{1} 步，正在执行 SSH 只读诊断", [suggestion.approval.step, suggestion.approval.maxSteps]));
      }
      catch (error) {
          suggestion.executing = false;
          suggestion.error = error instanceof Error ? error.message : tr("SSH 命令审批失败");
          ElMessage.error(suggestion.error);
      }
  }

  async function cancelSshSuggestion(suggestion: AgentSshSuggestionState) {
      const runId = suggestion.approval?.runId ?? suggestion.runId;
      if (!runId || suggestion.cancelling)
          return;
      suggestion.cancelling = true;
      try {
          const result = await stopDesktopAgentChat(runId);
          if (!result.stopped)
              suggestion.cancelling = false;
      }
      catch (error) {
          suggestion.cancelling = false;
          ElMessage.error(error instanceof Error ? error.message : tr("取消 SSH 诊断失败"));
      }
  }

  async function stopActiveDiagnostic() {
      const runId = $chat.activeRunId.value;
      if (!runId)
          return;
      await stopDesktopAgentChat(runId).catch(() => undefined);
      if ($chat.activeRunId.value === runId) {
          $chat.running.value = false;
          $chat.activeRunId.value = "";
          $chat.activeMessageId.value = "";
      }
  }

  function databaseSuggestionTarget(suggestion: AgentDatabaseSqlSuggestion) {
      const match = suggestion.source.match(/^desktop-database:([^:]+):(.+)$/);
      return match ? { connectionId: match[1], database: decodeURIComponent(match[2]) } : null;
  }

  async function fillDatabaseSuggestion(suggestion: AgentDatabaseSqlSuggestion) {
      const target = databaseSuggestionTarget(suggestion);
      if (!target || !$chat.contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source))
          return void ElMessage.warning(tr("该 SQL 对应的数据库现场已被移除"));
      const filled = await performAgentHostAction({
          type: "fill-database",
          connectionId: target.connectionId,
          database: target.database,
          sql: suggestion.sql,
      });
      if (!filled.ok || !filled.filled)
          return void ElMessage.warning(tr("请切回对应的本机数据库连接和数据库"));
      void recordDesktopAgentAction({ action: "database_sql_filled", target: `${target.connectionId}:${target.database}`, summary: tr("将 Viron Agent SQL 填入当前编辑器，未执行") }).catch(() => undefined);
      ElMessage.success(tr("SQL 已填入编辑器，未执行"));
  }

  async function executeDatabaseSuggestion(suggestion: AgentDatabaseSuggestionState) {
      const target = databaseSuggestionTarget(suggestion);
      if (!target || !isExecutableSuggestion(suggestion.execution) || suggestion.executing || !suggestion.approval)
          return;
      if (!$chat.contextCards.value.some((card) => card.id === suggestion.contextId && card.source === suggestion.source))
          return void ElMessage.warning(tr("该 SQL 对应的数据库现场已被移除"));
      suggestion.executing = true;
      suggestion.cancelling = false;
      suggestion.result = undefined;
      suggestion.error = undefined;
      try {
          await respondDesktopAgentApproval({ runId: suggestion.approval.runId, approvalId: suggestion.approval.approvalId, approved: true });
          ElMessage.info(suggestion.execution === "confirm-write"
              ? tr("已批准第 {0}/{1} 步，正在执行数据库写 SQL", [suggestion.approval.step, suggestion.approval.maxSteps])
              : tr("已批准第 {0}/{1} 步，正在执行数据库只读查询", [suggestion.approval.step, suggestion.approval.maxSteps]));
      }
      catch (error) {
          suggestion.executing = false;
          suggestion.error = error instanceof Error ? error.message : tr("数据库 SQL 审批失败");
          ElMessage.error(suggestion.error);
      }
  }

  async function cancelDatabaseSuggestion(suggestion: AgentDatabaseSuggestionState) {
      const runId = suggestion.approval?.runId ?? suggestion.runId;
      if (!runId || suggestion.cancelling)
          return;
      suggestion.cancelling = true;
      try {
          const result = await stopDesktopAgentChat(runId);
          if (!result.stopped)
              suggestion.cancelling = false;
      }
      catch (error) {
          suggestion.cancelling = false;
          ElMessage.error(error instanceof Error ? error.message : tr("取消数据库诊断失败"));
      }
  }

  async function respondVironApproval(item: AgentVironApprovalState, approved: boolean) {
      if (item.executing)
          return;
      item.executing = approved;
      item.error = undefined;
      try {
          await respondDesktopAgentApproval({
              runId: item.approval.runId,
              approvalId: item.approval.approvalId,
              approved,
              ...(!approved ? { reason: tr("用户拒绝了本次 Viron 操作") } : {}),
          });
          if (!approved)
              vironApprovals.value = vironApprovals.value.filter((candidate) => candidate.id !== item.id);
      }
      catch (error) {
          item.executing = false;
          item.error = error instanceof Error ? error.message : tr("Viron Agent 工具审批失败");
          ElMessage.error(item.error);
      }
  }

  function startAgentSuggestionsWatchers() {
    watch(() => desktopAppState.value?.executionMode, () => {
        if (!$chat.contextCards.value.some((card) => card.kind === "ssh"))
            return;
        stopActiveDiagnostic();
        const sshContextIds = new Set($chat.contextCards.value.filter((card) => card.kind === "ssh").map((card) => card.id));
        $chat.contextCards.value = $chat.contextCards.value.filter((card) => card.kind !== "ssh");
        sshSuggestions.value = sshSuggestions.value.filter((item) => !sshContextIds.has(item.contextId));
        sshScriptSuggestions.value = sshScriptSuggestions.value.filter((item) => !sshContextIds.has(item.contextId));
    });
  }

  return {
    sshSuggestions,
    sshScriptSuggestions,
    databaseSuggestions,
    vironApprovals,
    sshDiagnosticExecuting,
    databaseDiagnosticExecuting,
    quickSshSuggestions,
    quickSshScriptSuggestions,
    quickDatabaseSuggestions,
    fillSshSuggestion,
    canFillSshSuggestion,
    fillSshScriptSuggestion,
    sshSuggestionTarget,
    isExecutableSuggestion,
    sshSuggestionBadge,
    databaseSuggestionBadge,
    executeSshSuggestion,
    cancelSshSuggestion,
    stopActiveDiagnostic,
    databaseSuggestionTarget,
    fillDatabaseSuggestion,
    executeDatabaseSuggestion,
    cancelDatabaseSuggestion,
    respondVironApproval,
    startAgentSuggestionsWatchers,
  };
}

