<script setup lang="ts">
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
import { onBeforeUnmount, onMounted } from "vue";
import {
  onDesktopAgentEvent,
  onDesktopAgentLauncherAction,
  onDesktopNativeViewPointerDown,
  updateDesktopAgentLauncher,
} from "../desktop";
import {
  applyAgentHostState,
  getDesktopAgentHost,
  onDesktopAgentChatPointerOutside,
  onDesktopAgentHostState,
  updateDesktopAgentChatChrome,
} from "../agent-host";
import { onAppShortcut } from "../keyboard-shortcuts";
import { renderAgentMarkdown } from "../agent-markdown";
import { agentToolActivity } from "../agent-tool-activity";
import AgentQuickSurface from "./AgentQuickSurface.vue";
import AgentTurnStats from "./AgentTurnStats.vue";
import { createAgentFloatingContext } from "./agent-floating-window/context";
import { useAgentSessions } from "./agent-floating-window/use-agent-sessions";
import { useAgentSuggestions } from "./agent-floating-window/use-agent-suggestions";
import { useAgentChat } from "./agent-floating-window/use-agent-chat";
import { useAgentLauncherChrome } from "./agent-floating-window/use-agent-launcher-chrome";

const agentFloatingContext = createAgentFloatingContext();
const agentSessions = useAgentSessions(agentFloatingContext);
agentFloatingContext.sessions = agentSessions;
const agentSuggestions = useAgentSuggestions(agentFloatingContext);
agentFloatingContext.suggestions = agentSuggestions;
const agentChat = useAgentChat(agentFloatingContext);
agentFloatingContext.chat = agentChat;
const agentLauncherChrome = useAgentLauncherChrome(agentFloatingContext);
agentFloatingContext.launcherChrome = agentLauncherChrome;
const agentFloating = { ...agentLauncherChrome, ...agentSessions, ...agentChat, ...agentSuggestions };

const {
  edgeCollapsedStorageKey,
  edgeStorageKey,
  positionStorageKey,
  desktop,
  overlayRuntime,
  open,
  viewport,
  buttonPosition,
  edgeCollapsed,
  snappedEdge,
  dragging,
  activePresentation,
  agentRoot,
  ignoreMouse,
  overlayDragState,
  visible,
  entryMode,
  floatingVisible,
  rootStyle,
  panelAlignLeft,
  panelBelow,
  floatingButtonLabel,
  chromeVisible,
  currentViewport,
  defaultButtonPosition,
  storedButtonPosition,
  storedEdge,
  persistButtonPosition,
  persistEdgeState,
  collapseAtEdge,
  expandFromEdge,
  collapseToEdge,
  togglePanel,
  settleButtonDrag,
  handleDesktopLauncherAction,
  syncDesktopLauncherOverlay,
  handleViewportResize,
  isDialogOverlayTarget,
  dialogOverlayOpen,
  handleDocumentPointerDown,
  handleNativeViewPointerDown,
  handlePointerOutside,
  isAgentHitTarget,
  syncIgnoreMouse,
  handleOverlayMouseMove,
  currentSessionId,
  sessionItems,
  sessionsLoading,
  historyOpen,
  sessionsLoadSeq,
  launchConversationReady,
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
  startAgentChatWatchers,
  startAgentSuggestionsWatchers,
  startAgentLauncherChromeWatchers,
} = agentFloating;

startAgentChatWatchers();
startAgentSuggestionsWatchers();
startAgentLauncherChromeWatchers();

let removeAgentEventListener: (() => void) | undefined;
let removeAgentLauncherActionListener: (() => void) | undefined;
let removeNativeViewPointerDownListener: (() => void) | undefined;
let removeAppShortcutListener: (() => void) | undefined;
let removeHostStateListener: (() => void) | undefined;
let removePointerOutsideListener: (() => void) | undefined;

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
