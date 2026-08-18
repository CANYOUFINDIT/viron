<script setup lang="ts">
import { Bot, ChevronDown, CircleStop, ClipboardPaste, Code2, Database, Ellipsis, Eye, EyeOff, Layers, Pencil, Plus, Send, TerminalSquare, Trash2, X } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import {
  agentQuickBubbleStackStyle,
  displayAgentSessionTitle,
  recentAgentSessionItems,
  shouldStackAgentQuickBubbles,
} from "../agent-quick-history";
import { renderAgentMarkdown } from "../agent-markdown";
import { translate as tr } from "../i18n";
import type {
  AgentConversationSummary,
  AgentDatabaseReadResult,
  AgentDatabaseSqlSuggestion,
  AgentSshCommandSuggestion,
  AgentSshDiagnosticResult,
  AgentSshScriptSuggestion,
  AgentTurnUsage,
  AgentVironToolApprovalSuggestion,
} from "../../shared/agent";
import AgentTurnStats from "./AgentTurnStats.vue";

interface AgentQuickBubble {
  id: string;
  prompt: string;
  content: string;
  running: boolean;
  durationMs?: number;
  usage?: AgentTurnUsage;
}

type AgentQuickDatabaseSuggestion = AgentDatabaseSqlSuggestion & {
  id: string;
  runId?: string;
  executing?: boolean;
  cancelling?: boolean;
  result?: AgentDatabaseReadResult;
  error?: string;
};

type AgentQuickSshSuggestion = AgentSshCommandSuggestion & {
  id: string;
  runId?: string;
  executing?: boolean;
  cancelling?: boolean;
  result?: AgentSshDiagnosticResult;
  error?: string;
};

type AgentQuickSshScriptSuggestion = AgentSshScriptSuggestion & {
  id: string;
};

type AgentQuickVironApproval = Omit<AgentVironToolApprovalSuggestion, "input"> & {
  input: unknown;
  id: string;
  executing?: boolean;
  error?: string;
};

const props = defineProps<{
  composerVisible: boolean;
  input: string;
  inputLimit: number;
  running: boolean;
  active: boolean;
  configured: boolean;
  addingContext: boolean;
  sessionItems: AgentConversationSummary[];
  currentSessionId: string;
  historyOpen: boolean;
  bubbles: AgentQuickBubble[];
  expandedBubbleId: string;
  historyTiled: boolean;
  bubblesHidden: boolean;
  canRestoreBubbles: boolean;
  sshSuggestions: AgentQuickSshSuggestion[];
  sshScriptSuggestions: AgentQuickSshScriptSuggestion[];
  databaseSuggestions: AgentQuickDatabaseSuggestion[];
  vironApprovals: AgentQuickVironApproval[];
}>();

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

const emit = defineEmits<{
  updateInput: [value: string];
  submit: [];
  closeComposer: [];
  toggleHistory: [];
  createSession: [];
  selectSession: [id: string];
  renameSession: [item: AgentConversationSummary];
  deleteSession: [item: AgentConversationSummary];
  approveViron: [item: AgentQuickVironApproval, approved: boolean];
  toggleBubble: [id: string];
  closeBubble: [id: string];
  hideBubbles: [];
  showBubbles: [];
  toggleHistoryStack: [];
  stop: [];
  fillSsh: [suggestion: AgentSshCommandSuggestion];
  fillSshScript: [suggestion: AgentSshScriptSuggestion];
  executeSsh: [suggestion: AgentQuickSshSuggestion];
  cancelSsh: [suggestion: AgentQuickSshSuggestion];
  fillDatabase: [suggestion: AgentDatabaseSqlSuggestion];
  executeDatabase: [suggestion: AgentQuickDatabaseSuggestion];
  cancelDatabase: [suggestion: AgentQuickDatabaseSuggestion];
}>();

const surfaceEl = ref<HTMLElement | null>(null);
const composerInput = ref<HTMLTextAreaElement | null>(null);
const stickyBottomSlack = 36;
const followOutput = new Map<string, boolean>();
const latestBubbleId = computed(() => props.bubbles.at(-1)?.id ?? "");
const recentSessions = computed(() => recentAgentSessionItems(props.sessionItems, props.currentSessionId));
const hasOverflowSessions = computed(() => props.sessionItems.length > recentSessions.value.length);
const historyStacked = computed(() => shouldStackAgentQuickBubbles(props.bubbles.length, props.historyTiled));

function outputFollowKey(kind: "preview" | "detail", id: string): string {
  return `${kind}:${id}`;
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= stickyBottomSlack;
}

function rememberFollow(kind: "preview" | "detail", id: string, event: Event) {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return;
  followOutput.set(outputFollowKey(kind, id), isNearBottom(element));
}

function scrollIfFollowing(kind: "preview" | "detail", id: string, element: HTMLElement | null, running: boolean) {
  if (!element) return;
  if (!(followOutput.get(outputFollowKey(kind, id)) ?? running)) return;
  element.scrollTop = element.scrollHeight;
}

function followStreamingOutput() {
  const root = surfaceEl.value;
  if (!root) return;
  for (const bubble of props.bubbles) {
    scrollIfFollowing("preview", bubble.id, root.querySelector<HTMLElement>(`[data-bubble-preview="${CSS.escape(bubble.id)}"]`), bubble.running);
    scrollIfFollowing("detail", bubble.id, root.querySelector<HTMLElement>(`[data-bubble-detail="${CSS.escape(bubble.id)}"]`), bubble.running);
  }
}

function resizeComposer() {
  const input = composerInput.value;
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  input.style.overflowY = input.scrollHeight > 96 ? "auto" : "hidden";
}

function updateInput(event: Event) {
  emit("updateInput", (event.target as HTMLTextAreaElement).value);
  resizeComposer();
}

function scriptLineLabel(script: string): string {
  return tr("{{0}} 行", [script.split("\n").length]);
}

watch(
  () => props.composerVisible,
  (visible) => {
    if (!visible) return;
    void nextTick(() => {
      resizeComposer();
      composerInput.value?.focus();
    });
  },
);

watch(
  () => `${props.expandedBubbleId}|${props.bubbles.map((bubble) => `${bubble.id}:${bubble.content.length}:${bubble.running ? 1 : 0}`).join("|")}`,
  () => {
    void nextTick(followStreamingOutput);
  },
);
</script>

<template>
  <div ref="surfaceEl" class="agent-quick-surface" :class="{ 'has-composer': composerVisible }" :aria-label="$t('小 V 快捷输入')">
    <svg class="agent-quick-liquid-filter" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id="agent-quick-liquid-distortion" x="-12%" y="-80%" width="124%" height="260%" color-interpolation-filters="sRGB">
          <feMorphology in="SourceAlpha" operator="erode" radius="8" result="inner-alpha" />
          <feComposite in="SourceAlpha" in2="inner-alpha" operator="out" result="edge-alpha" />
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.032" numOctaves="2" seed="17" stitchTiles="stitch" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="1.6" result="soft-map" />
          <feDisplacementMap in="SourceGraphic" in2="soft-map" scale="72" xChannelSelector="R" yChannelSelector="G" result="displaced" />
          <feComposite in="SourceGraphic" in2="inner-alpha" operator="in" result="clear-center" />
          <feComposite in="displaced" in2="edge-alpha" operator="in" result="refracted-edge" />
          <feSpecularLighting in="soft-map" surfaceScale="3" specularConstant="0.42" specularExponent="42" lighting-color="#f3fffb" result="specular-light">
            <fePointLight x="-90" y="-120" z="210" />
          </feSpecularLighting>
          <feComposite in="specular-light" in2="edge-alpha" operator="in" result="edge-light" />
          <feMerge>
            <feMergeNode in="clear-center" />
            <feMergeNode in="refracted-edge" />
            <feMergeNode in="edge-light" />
          </feMerge>
        </filter>
      </defs>
    </svg>

    <section
      class="agent-quick-bubbles"
      :class="{ 'is-stacked': historyStacked, 'is-tiled': !historyStacked }"
      aria-live="polite"
      data-agent-overlay="quick-bubbles"
    >
      <div v-if="bubbles.length" class="agent-quick-bubbles__toolbar">
        <button
          type="button"
          class="agent-quick-bubbles__toggle"
          :aria-label="$t('隐藏全部回复')"
          :title="$t('隐藏回复')"
          @click="emit('hideBubbles')"
        >
          <EyeOff :size="13" />
          <span>{{ $t('隐藏回复') }}</span>
        </button>
        <button
          v-if="historyTiled && bubbles.length > 1"
          type="button"
          class="agent-quick-bubbles__toggle"
          aria-expanded="true"
          :aria-label="$t('叠起历史轮次')"
          :title="$t('叠起历史')"
          @click="emit('toggleHistoryStack')"
        >
          <Layers :size="13" />
          <span>{{ $t('叠起历史') }}</span>
        </button>
      </div>
      <TransitionGroup name="agent-quick-bubble" tag="div" class="agent-quick-bubbles__stack">
      <article
        v-for="(bubble, index) in bubbles"
        :key="bubble.id"
        class="agent-quick-bubble"
        :class="{
          'is-expanded': expandedBubbleId === bubble.id,
          'is-running': bubble.running,
          'is-latest': bubble.id === latestBubbleId,
          'is-folded': bubble.id !== latestBubbleId && expandedBubbleId !== bubble.id,
          'is-stacked-back': historyStacked && bubble.id !== latestBubbleId,
        }"
        :style="agentQuickBubbleStackStyle(index, bubbles.length, historyTiled)"
      >
        <div class="agent-quick-glass" aria-hidden="true">
          <span class="agent-quick-glass__distortion"></span>
          <span class="agent-quick-glass__tint"></span>
          <span class="agent-quick-glass__rim"></span>
        </div>
        <div class="agent-quick-bubble__header">
          <button class="agent-quick-bubble__body" type="button" :aria-expanded="expandedBubbleId === bubble.id" @click="emit('toggleBubble', bubble.id)">
            <span class="agent-quick-bubble__icon" aria-hidden="true"><Bot :size="15" /></span>
            <strong>{{ bubble.prompt }}</strong>
            <span v-if="bubble.running" class="agent-quick-bubble__pulse" :aria-label="$t('正在生成')"><i></i><i></i><i></i></span>
            <ChevronDown v-else :size="14" class="agent-quick-bubble__chevron" />
          </button>
          <button class="agent-quick-bubble__close" type="button" :aria-label="$t('关闭回复气泡')" :title="$t('关闭')" @click.stop="emit('closeBubble', bubble.id)"><X :size="13" /></button>
        </div>
        <div
          v-if="expandedBubbleId !== bubble.id && bubble.id === latestBubbleId"
          class="agent-quick-bubble__preview"
          :data-bubble-preview="bubble.id"
          @click="emit('toggleBubble', bubble.id)"
          @scroll="rememberFollow('preview', bubble.id, $event)"
        >{{ bubble.content || (bubble.running ? $t('正在生成回复…') : $t('小 V 未返回文本')) }}</div>

        <div
          v-if="expandedBubbleId === bubble.id"
          class="agent-quick-bubble__detail"
          :data-bubble-detail="bubble.id"
          @scroll="rememberFollow('detail', bubble.id, $event)"
        >
          <div class="agent-quick-bubble__markdown" v-html="renderAgentMarkdown(bubble.content || (bubble.running ? $t('正在生成回复…') : $t('小 V 未返回文本')))"></div>

          <div v-if="vironApprovals.length" class="agent-quick-actions">
            <article v-for="approval in vironApprovals" :key="approval.id">
              <header><span>{{ approval.title }}</span><em>{{ approval.riskLevel === 'high' ? $t('高风险') : $t('需要确认') }}</em></header>
              <p>{{ approval.description }}</p>
              <code>{{ JSON.stringify(approval.input, null, 2) }}</code>
              <footer>
                <button type="button" :disabled="approval.executing" @click="emit('approveViron', approval, true)">{{ approval.executing ? $t('正在执行…') : $t('批准并执行') }}</button>
                <button v-if="!approval.executing" type="button" @click="emit('approveViron', approval, false)">{{ $t('拒绝') }}</button>
              </footer>
              <p v-if="approval.error" class="agent-quick-diagnostic-error">{{ approval.error }}</p>
            </article>
          </div>

          <div v-if="sshSuggestions.length" class="agent-quick-actions">
            <article v-for="suggestion in sshSuggestions" :key="suggestion.id">
              <header><span><TerminalSquare :size="13" />{{ $t('SSH 命令') }}</span><em>{{ sshSuggestionBadge(suggestion) }}</em></header>
              <code>{{ suggestion.command }}</code>
              <p v-if="suggestion.impactPreview">{{ suggestion.impactPreview.reason }}</p>
              <p v-if="suggestion.explanation">{{ suggestion.explanation }}</p>
              <footer>
                <button v-if="suggestion.source.startsWith('desktop-ssh:')" type="button" @click="emit('fillSsh', suggestion)"><ClipboardPaste :size="13" />{{ $t('填入终端') }}</button>
                <button v-if="suggestion.approval && !suggestion.executing && !suggestion.result && !suggestion.error" type="button" @click="emit('executeSsh', suggestion)">{{ $t('确认并执行') }}</button>
                <button v-else-if="suggestion.executing" type="button" :disabled="suggestion.cancelling" @click="emit('cancelSsh', suggestion)">{{ suggestion.cancelling ? $t('正在取消…') : $t('取消诊断') }}</button>
              </footer>
              <p v-if="suggestion.error" class="agent-quick-diagnostic-error">{{ suggestion.error }}</p>
              <div v-if="suggestion.result" class="agent-quick-diagnostic-result">
                <span>{{ $t('退出码 {0} · {1} ms{2}', [suggestion.result.exitCode ?? $t('未知'), suggestion.result.durationMs, suggestion.result.truncated ? $t(' · 已截断') : '']) }}</span>
                <p v-if="suggestion.result.presentation === 'workbench'">{{ $t('命令与原始输出已显示在 SSH 终端，Agent 已读取脱敏结果继续分析。') }}</p>
                <template v-else>
                  <pre v-if="suggestion.result.stdout">{{ suggestion.result.stdout }}</pre>
                  <pre v-if="suggestion.result.stderr" class="is-stderr">{{ suggestion.result.stderr }}</pre>
                </template>
              </div>
            </article>
          </div>

          <div v-if="sshScriptSuggestions.length" class="agent-quick-actions">
            <article v-for="suggestion in sshScriptSuggestions" :key="suggestion.id">
              <header><span><Code2 :size="13" />{{ $t('Shell 脚本') }}</span><em>{{ $t('安全填入，不执行') }}</em></header>
              <div class="agent-quick-script-meta"><strong>{{ suggestion.interpreter }}</strong><span>{{ scriptLineLabel(suggestion.script) }}</span></div>
              <pre>{{ suggestion.script }}</pre>
              <p v-if="suggestion.explanation">{{ suggestion.explanation }}</p>
              <footer><button type="button" @click="emit('fillSshScript', suggestion)"><ClipboardPaste :size="13" />{{ $t('填入终端') }}</button></footer>
            </article>
          </div>

          <div v-if="databaseSuggestions.length" class="agent-quick-actions">
            <article v-for="suggestion in databaseSuggestions" :key="suggestion.id">
              <header><span><Database :size="13" />{{ $t('数据库 SQL') }}</span><em>{{ databaseSuggestionBadge(suggestion) }}</em></header>
              <code>{{ suggestion.sql }}</code>
              <p v-if="suggestion.impactPreview">
                {{ suggestion.impactPreview.reason }}
                <template v-if="suggestion.impactPreview.estimatedRows !== undefined"> · {{ $t('预计影响 {0} 行', [suggestion.impactPreview.estimatedRows]) }}</template>
              </p>
              <p v-if="suggestion.explanation">{{ suggestion.explanation }}</p>
              <footer>
                <button type="button" @click="emit('fillDatabase', suggestion)">{{ $t('填入编辑器') }}</button>
                <button v-if="suggestion.approval && !suggestion.executing && !suggestion.result && !suggestion.error" type="button" @click="emit('executeDatabase', suggestion)">{{ $t('确认并执行') }}</button>
                <button v-else-if="suggestion.executing" type="button" :disabled="suggestion.cancelling" @click="emit('cancelDatabase', suggestion)">{{ suggestion.cancelling ? $t('正在取消…') : $t('取消诊断') }}</button>
              </footer>
              <p v-if="suggestion.error" class="agent-quick-diagnostic-error">{{ suggestion.error }}</p>
              <p v-if="suggestion.result?.presentation === 'workbench'">{{ suggestion.execution === 'confirm-write' ? $t('SQL 与执行结果已显示在数据库工作台，Agent 已读取受影响行数继续分析。') : $t('SQL 与查询结果已显示在数据库工作台，Agent 已读取受限结果继续分析。') }}</p>
              <p v-else-if="suggestion.result && suggestion.execution === 'confirm-write'">{{ $t('已影响 {0} 行', [suggestion.result.affectedRows ?? suggestion.result.rowCount]) }}</p>
              <pre v-else-if="suggestion.result">{{ JSON.stringify(suggestion.result.rows, null, 2) }}</pre>
            </article>
          </div>
        </div>
        <AgentTurnStats
          class="agent-quick-bubble__stats"
          :duration-ms="bubble.durationMs"
          :usage="bubble.usage"
        />
      </article>
      </TransitionGroup>
    </section>

    <Transition name="agent-quick-composer">
      <section v-if="composerVisible" class="agent-quick-composer" data-agent-overlay="quick-composer">
        <div class="agent-quick-session-bar">
          <div class="agent-quick-session-recent">
            <button
              v-for="item in recentSessions"
              :key="item.id"
              type="button"
              class="agent-quick-session-chip"
              :class="{ 'is-current': item.id === currentSessionId }"
              :aria-current="item.id === currentSessionId ? 'true' : undefined"
              :aria-label="item.title"
              :title="item.title"
              @click="emit('selectSession', item.id)"
            >
              <span class="agent-quick-glass" aria-hidden="true">
                <span class="agent-quick-glass__distortion"></span>
                <span class="agent-quick-glass__tint"></span>
                <span class="agent-quick-glass__rim"></span>
              </span>
              <span class="agent-quick-session-chip__label">{{ displayAgentSessionTitle(item.title) }}</span>
            </button>
          </div>
          <div class="agent-quick-session-actions">
            <button
              v-if="hasOverflowSessions"
              type="button"
              class="agent-quick-session-more"
              :class="{ 'is-open': historyOpen }"
              :aria-label="$t('更多会话')"
              :aria-expanded="historyOpen"
              :title="$t('更多会话')"
              @click="emit('toggleHistory')"
            >
              <span class="agent-quick-glass" aria-hidden="true">
                <span class="agent-quick-glass__distortion"></span>
                <span class="agent-quick-glass__tint"></span>
                <span class="agent-quick-glass__rim"></span>
              </span>
              <Ellipsis :size="14" />
            </button>
            <button
              v-if="bubblesHidden && canRestoreBubbles"
              type="button"
              class="agent-quick-session-restore"
              :aria-label="$t('显示全部回复')"
              :title="$t('显示回复')"
              @click="emit('showBubbles')"
            >
              <span class="agent-quick-glass" aria-hidden="true">
                <span class="agent-quick-glass__distortion"></span>
                <span class="agent-quick-glass__tint"></span>
                <span class="agent-quick-glass__rim"></span>
              </span>
              <Eye :size="14" />
              <span>{{ $t('显示回复') }}</span>
            </button>
            <button type="button" class="agent-quick-session-create" :aria-label="$t('新建会话')" :title="$t('新建会话')" @click="emit('createSession')">
              <span class="agent-quick-glass" aria-hidden="true">
                <span class="agent-quick-glass__distortion"></span>
                <span class="agent-quick-glass__tint"></span>
                <span class="agent-quick-glass__rim"></span>
              </span>
              <Plus :size="14" />
            </button>
          </div>
        </div>
        <section v-if="historyOpen" class="agent-quick-history">
          <div class="agent-quick-glass" aria-hidden="true">
            <span class="agent-quick-glass__distortion"></span>
            <span class="agent-quick-glass__tint"></span>
            <span class="agent-quick-glass__rim"></span>
          </div>
          <article v-for="item in sessionItems" :key="item.id" :class="{ 'is-current': item.id === currentSessionId }">
            <button type="button" class="agent-quick-history__select" @click="emit('selectSession', item.id)"><strong>{{ item.title }}</strong><small>{{ new Date(item.updatedAt).toLocaleString($locale()) }}</small></button>
            <button type="button" :aria-label="$t('重命名会话')" :title="$t('重命名')" @click="emit('renameSession', item)"><Pencil :size="12" /></button>
            <button type="button" :aria-label="$t('删除会话')" :title="$t('删除')" @click="emit('deleteSession', item)"><Trash2 :size="12" /></button>
          </article>
        </section>
        <div class="agent-quick-composer__bar">
          <div class="agent-quick-composer__liquid agent-quick-glass" aria-hidden="true">
            <span class="agent-quick-composer__distortion agent-quick-glass__distortion"></span>
            <span class="agent-quick-composer__tint agent-quick-glass__tint"></span>
            <span class="agent-quick-composer__rim agent-quick-glass__rim"></span>
          </div>
          <span class="agent-quick-composer__icon" aria-hidden="true"><Bot :size="19" /></span>
          <textarea
            ref="composerInput"
            :value="input"
            rows="1"
            :maxlength="inputLimit"
            :disabled="addingContext || active || !configured"
            :placeholder="active ? $t('当前多步诊断结束后可继续提问') : $t('向小 V 提问')"
            @input="updateInput"
            @keydown.enter.exact.prevent="emit('submit')"
            @keydown.esc.stop.prevent="emit('closeComposer')"
          ></textarea>
          <span class="agent-quick-composer__wave" :class="{ 'is-running': running }" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <button v-if="active" class="agent-quick-composer__submit is-stop" type="button" :aria-label="$t('结束诊断')" :title="$t('结束诊断')" @click="emit('stop')"><CircleStop :size="20" /></button>
          <button v-else class="agent-quick-composer__submit" type="button" :aria-label="$t('发送')" :title="$t('发送')" :disabled="addingContext || !configured || !input.trim()" @click="emit('submit')"><Send :size="19" /></button>
        </div>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.agent-quick-surface {
  position: fixed;
  inset: 0;
  z-index: 121;
  color: #f4f4f5;
  font-family: var(--font-ui);
  pointer-events: none;
}

.agent-quick-liquid-filter { position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none; }

.agent-quick-bubbles {
  position: absolute;
  right: 24px;
  bottom: 24px;
  width: min(520px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  overflow: visible;
  pointer-events: none;
  transition: bottom .18s ease;
}

.agent-quick-bubbles__stack {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: visible;
  pointer-events: none;
}

.agent-quick-bubbles.is-stacked .agent-quick-bubbles__stack { gap: 0; }

.agent-quick-bubbles__toolbar {
  position: relative;
  z-index: 30;
  align-self: flex-end;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}

.agent-quick-bubbles__toggle {
  position: relative;
  z-index: 30;
  align-self: flex-end;
  min-height: 26px;
  padding: 0 10px 0 8px;
  border: 1px solid rgba(255, 255, 255, .22);
  border-radius: 999px;
  background: rgba(16, 22, 24, .62);
  color: #e8eeeb;
  font: 600 11px/1 var(--font-ui);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  pointer-events: auto;
  cursor: pointer;
  box-shadow:
    0 8px 18px rgba(0, 0, 0, .2),
    inset 0 1px rgba(255, 255, 255, .16);
}

.agent-quick-bubbles__toggle:hover {
  border-color: rgba(192, 255, 238, .42);
  background: rgba(24, 38, 36, .78);
  color: #f4fffb;
}

.agent-quick-surface.has-composer .agent-quick-bubbles { bottom: 214px; }

.agent-quick-glass {
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}

.agent-quick-glass__distortion,
.agent-quick-glass__tint,
.agent-quick-glass__rim { position: absolute; pointer-events: none; }

.agent-quick-glass__distortion {
  inset: 0;
  border-radius: inherit;
  background: rgba(255, 255, 255, .012);
  -webkit-backdrop-filter: blur(9px) saturate(1.38) contrast(1.03);
  backdrop-filter: blur(9px) saturate(1.38) contrast(1.03);
  filter: url("#agent-quick-liquid-distortion");
  transform: translateZ(0);
}

.agent-quick-glass__tint {
  inset: 0;
  background:
    radial-gradient(ellipse 42% 150% at 12% -36%, rgba(239, 255, 250, .2), transparent 68%),
    radial-gradient(ellipse 36% 130% at 88% 136%, rgba(138, 116, 216, .12), transparent 70%),
    linear-gradient(112deg, rgba(19, 39, 35, .34), rgba(27, 34, 36, .44) 48%, rgba(8, 13, 15, .56));
}

:global(html.is-agent-chat-overlay) .agent-quick-glass__tint {
  background:
    radial-gradient(ellipse 42% 150% at 12% -36%, rgba(239, 255, 250, .16), transparent 68%),
    radial-gradient(ellipse 36% 130% at 88% 136%, rgba(138, 116, 216, .1), transparent 70%),
    linear-gradient(112deg, rgba(19, 39, 35, .78), rgba(27, 34, 36, .86) 48%, rgba(8, 13, 15, .9));
}

.agent-quick-bubble .agent-quick-glass__tint,
.agent-quick-history .agent-quick-glass__tint {
  background:
    radial-gradient(ellipse 42% 150% at 12% -36%, rgba(239, 255, 250, .18), transparent 68%),
    radial-gradient(ellipse 36% 130% at 88% 136%, rgba(138, 116, 216, .12), transparent 70%),
    linear-gradient(112deg, rgba(19, 39, 35, .56), rgba(27, 34, 36, .66) 48%, rgba(8, 13, 15, .76));
}

.agent-quick-glass__rim {
  inset: 0;
  border-radius: inherit;
  background:
    radial-gradient(ellipse 36% 110% at 8% -28%, rgba(255, 255, 255, .44), transparent 64%),
    radial-gradient(ellipse 28% 96% at 94% 126%, rgba(197, 244, 234, .2), transparent 68%),
    linear-gradient(105deg, transparent 24%, rgba(255, 255, 255, .16) 45%, transparent 64%);
  background-position: 0 0, 0 0, 100% 0;
  background-size: 100% 100%, 100% 100%, 220% 100%;
  box-shadow:
    inset 1.5px 1.5px 1px rgba(255, 255, 255, .54),
    inset -1px -1px 1px rgba(255, 255, 255, .13),
    inset 0 -2px 3px rgba(8, 17, 19, .14);
  transition: background-position .7s cubic-bezier(.175, .885, .32, 1.15);
}

.agent-quick-bubble {
  --agent-quick-card-radius: 24px;
  position: relative;
  isolation: isolate;
  min-width: 0;
  transition: left .2s ease, right .2s ease, bottom .2s ease, opacity .18s ease;
  border: 1px solid rgba(255, 255, 255, .22);
  border-radius: var(--agent-quick-card-radius);
  background: transparent;
  box-shadow:
    0 18px 42px rgba(0, 0, 0, .26),
    0 4px 14px rgba(0, 0, 0, .14);
  overflow: hidden;
  pointer-events: auto;
}

.agent-quick-bubble__header,
.agent-quick-bubble__preview,
.agent-quick-bubble__detail { position: relative; z-index: 1; }

.agent-quick-bubble.is-running {
  border-color: rgba(192, 255, 238, .42);
  box-shadow:
    0 18px 42px rgba(0, 0, 0, .26),
    0 4px 14px rgba(13, 88, 73, .16),
    0 0 0 1px rgba(115, 214, 184, .12);
}

.agent-quick-bubble.is-folded {
  opacity: .78;
}

.agent-quick-bubble.is-stacked-back {
  position: absolute;
  left: calc(var(--agent-quick-stack-depth, 1) * var(--agent-quick-stack-inset, 8px));
  right: calc(var(--agent-quick-stack-depth, 1) * var(--agent-quick-stack-inset, 8px));
  bottom: calc(100% - (var(--agent-quick-stack-header, 40px) - var(--agent-quick-stack-depth, 1) * var(--agent-quick-stack-peek-step, 12px)));
  height: var(--agent-quick-stack-header, 40px);
  overflow: hidden;
  opacity: .88;
  cursor: pointer;
}

.agent-quick-bubble.is-stacked-back:hover {
  opacity: 1;
}

.agent-quick-bubble.is-stacked-back .agent-quick-bubble__stats,
.agent-quick-bubble.is-stacked-back .agent-quick-bubble__close {
  display: none;
}

.agent-quick-bubble__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22px;
  align-items: center;
  min-height: 40px;
  padding: 0 8px 0 0;
}

.agent-quick-bubble__body {
  width: 100%;
  min-height: 40px;
  padding: 8px 4px 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  text-align: left;
  cursor: pointer;
}

.agent-quick-bubble__body:hover,
.agent-quick-bubble__preview:hover { background: rgba(255, 255, 255, .05); }
.agent-quick-bubble__body:active { background: rgba(255, 255, 255, .08); }

.agent-quick-bubble__icon {
  width: 22px;
  height: 22px;
  border: 1px solid rgba(255, 255, 255, .12);
  border-radius: 50%;
  background: rgba(255, 255, 255, .06);
  color: #d4d4d8;
  display: grid;
  place-items: center;
  box-shadow: inset 0 1px rgba(255, 255, 255, .06);
}

.agent-quick-bubble__body > strong {
  min-width: 0;
  overflow: hidden;
  color: #f4f4f5;
  font-size: 13px;
  font-weight: 650;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .38);
}

.agent-quick-bubble__preview {
  max-height: 4.6em;
  padding: 4px 18px 8px;
  overflow: auto;
  color: #d5ddd9;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  cursor: pointer;
  scrollbar-width: none;
}
.agent-quick-bubble__preview::-webkit-scrollbar { display: none; }

.agent-quick-bubble__chevron { color: #aeb7b5; transition: transform .18s ease; }
.agent-quick-bubble.is-expanded .agent-quick-bubble__chevron { transform: rotate(180deg); }

.agent-quick-bubble__pulse { height: 22px; display: inline-flex; align-items: center; gap: 3px; }
.agent-quick-bubble__pulse i { width: 3px; border-radius: 2px; background: #73d6b6; animation: agent-quick-pulse .8s ease-in-out infinite alternate; }
.agent-quick-bubble__pulse i:nth-child(1) { height: 8px; }
.agent-quick-bubble__pulse i:nth-child(2) { height: 16px; animation-delay: .12s; }
.agent-quick-bubble__pulse i:nth-child(3) { height: 11px; animation-delay: .24s; }

.agent-quick-bubble__close {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #aeb7b5;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.agent-quick-bubble__close:hover { background: rgba(239, 68, 68, .12); color: #fca5a5; }

.agent-quick-bubble__detail {
  max-height: min(420px, calc(100dvh - 190px));
  padding: 6px 18px 10px;
  overflow: auto;
  scrollbar-color: rgba(161, 161, 170, .35) transparent;
}

.agent-quick-bubble__stats {
  --agent-turn-stats-color: rgba(174, 183, 181, .78);
  --agent-turn-stats-dot: rgba(174, 183, 181, .55);
  position: relative;
  z-index: 1;
  display: flex;
  margin: 0 18px 11px;
}

.agent-quick-bubble__markdown { color: #e8eeeb; font-size: 13px; line-height: 1.75; overflow-wrap: anywhere; text-shadow: 0 1px 2px rgba(0, 0, 0, .28); }
.agent-quick-bubble__markdown :deep(p),
.agent-quick-bubble__markdown :deep(ul),
.agent-quick-bubble__markdown :deep(ol),
.agent-quick-bubble__markdown :deep(pre) { margin: 0; }
.agent-quick-bubble__markdown :deep(h1),
.agent-quick-bubble__markdown :deep(h2),
.agent-quick-bubble__markdown :deep(h3) { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
.agent-quick-bubble__markdown :deep(p + p),
.agent-quick-bubble__markdown :deep(p + ul),
.agent-quick-bubble__markdown :deep(p + ol),
.agent-quick-bubble__markdown :deep(p + pre),
.agent-quick-bubble__markdown :deep(ul + p),
.agent-quick-bubble__markdown :deep(ol + p),
.agent-quick-bubble__markdown :deep(pre + p) { margin-top: 12px; }
.agent-quick-bubble__markdown :deep(li + li) { margin-top: 6px; }
.agent-quick-bubble__markdown :deep(ul),
.agent-quick-bubble__markdown :deep(ol) { padding-left: 1.2em; }
.agent-quick-bubble__markdown :deep(code) { padding: 2px 5px; border-radius: 6px; background: rgba(8, 13, 15, .72); color: #e4e4e7; font-family: var(--font-mono); overflow-wrap: anywhere; }
.agent-quick-bubble__markdown :deep(pre) { max-width: 100%; padding: 12px; border-radius: 12px; background: rgba(8, 13, 15, .72); overflow: auto; white-space: pre-wrap; }
.agent-quick-bubble__markdown :deep(table) { width: 100%; margin: 10px 0; table-layout: fixed; border-collapse: collapse; }
.agent-quick-bubble__markdown :deep(th),
.agent-quick-bubble__markdown :deep(td) { padding: 7px 8px; border: 1px solid #3f3f46; overflow-wrap: anywhere; }

.agent-quick-actions { margin-top: 10px; display: grid; gap: 7px; }
.agent-quick-actions > article { min-width: 0; padding: 9px; border: 1px solid rgba(255, 255, 255, .12); border-radius: 12px; background: rgba(8, 16, 18, .42); display: grid; gap: 7px; }
.agent-quick-actions header,
.agent-quick-actions footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-quick-actions header span { color: #a7f3d0; display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 650; }
.agent-quick-actions header em { color: #6ee7b7; font-size: 9px; font-style: normal; }
.agent-quick-actions code,
.agent-quick-actions pre { max-width: 100%; margin: 0; padding: 7px 8px; border-radius: 10px; background: rgba(4, 16, 14, .72); color: #ecfdf5; font-family: var(--font-mono); font-size: 10px; line-height: 1.45; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
.agent-quick-actions p { margin: 0; color: #a1a1aa; font-size: 10px; line-height: 1.45; }
.agent-quick-script-meta { display: flex; align-items: center; gap: 6px; color: #a1a1aa; font-size: 9px; }
.agent-quick-script-meta strong { padding: 1px 5px; border-radius: 4px; background: rgba(52, 211, 153, .12); color: #a7f3d0; font-family: var(--font-mono); }
.agent-quick-actions button { width: fit-content; min-height: 28px; padding: 0 9px; border: 1px solid rgba(52, 211, 153, .32); border-radius: 14px; background: rgba(6, 95, 70, .38); color: #d1fae5; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-size: 10px; font-weight: 650; }
.agent-quick-actions button:hover:not(:disabled) { background: rgba(5, 150, 105, .34); }
.agent-quick-actions button:disabled { opacity: .52; cursor: wait; }
.agent-quick-diagnostic-result { min-width: 0; display: grid; gap: 6px; }
.agent-quick-diagnostic-result > span { color: #a7f3d0; font-size: 9px; font-weight: 650; }
.agent-quick-diagnostic-result > pre { max-height: 180px; }
.agent-quick-diagnostic-result > pre.is-stderr { border: 1px solid rgba(251, 146, 60, .24); color: #fed7aa; }
.agent-quick-diagnostic-error { margin: 0; color: #fecaca; font-size: 10px; line-height: 1.45; overflow-wrap: anywhere; }

.agent-quick-composer {
  --agent-quick-glass-radius: 30px;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 28px;
  width: min(720px, calc(100vw - 48px));
  margin-inline: auto;
  isolation: isolate;
  pointer-events: auto;
}

.agent-quick-composer::before {
  content: "";
  position: absolute;
  inset: -12px 8% -14px;
  z-index: -1;
  border-radius: 999px;
  background:
    radial-gradient(circle at 24% 50%, rgba(76, 193, 166, .28), transparent 42%),
    radial-gradient(circle at 76% 52%, rgba(112, 93, 190, .25), transparent 44%);
  filter: blur(26px);
  opacity: .48;
  pointer-events: none;
}

.agent-quick-session-bar {
  position: relative;
  min-height: 36px;
  margin: 0 8px 8px;
  padding: 0;
  border: 0;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: visible;
}
.agent-quick-session-recent,
.agent-quick-session-actions {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-quick-session-recent { flex: 1 1 auto; }
.agent-quick-session-actions { flex: 0 0 auto; }
.agent-quick-session-bar button {
  --agent-quick-session-radius: 18px;
  position: relative;
  isolation: isolate;
  min-width: 0;
  height: 36px;
  padding: 0 18px;
  border: 1px solid rgba(255, 255, 255, .22);
  border-radius: var(--agent-quick-session-radius);
  background: transparent;
  box-shadow:
    0 8px 20px rgba(0, 0, 0, .18),
    0 1px 4px rgba(0, 0, 0, .1);
  color: #c4cdc9;
  display: inline-grid;
  grid-auto-flow: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  transition: border-color .18s ease, color .18s ease, box-shadow .18s ease;
}
.agent-quick-session-bar button > :not(.agent-quick-glass) { position: relative; z-index: 1; }
.agent-quick-session-bar button:hover { color: #e8f7f2; border-color: rgba(255, 255, 255, .34); }
.agent-quick-session-bar button:hover .agent-quick-glass__tint {
  background:
    radial-gradient(ellipse 42% 150% at 12% -36%, rgba(239, 255, 250, .26), transparent 68%),
    radial-gradient(ellipse 36% 130% at 88% 136%, rgba(138, 116, 216, .16), transparent 70%),
    linear-gradient(112deg, rgba(19, 39, 35, .42), rgba(27, 34, 36, .52) 48%, rgba(8, 13, 15, .64));
}
.agent-quick-session-chip {
  flex: 0 1 auto;
  width: max-content;
  max-width: 16em;
  color: #dce8e3;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .38);
}
.agent-quick-session-chip__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-quick-session-chip.is-current {
  color: #f3fbf7;
  border-color: rgba(197, 244, 234, .42);
  box-shadow:
    0 8px 20px rgba(0, 0, 0, .2),
    0 0 0 1px rgba(113, 208, 184, .18);
}
.agent-quick-session-chip.is-current .agent-quick-glass__tint {
  background:
    radial-gradient(ellipse 42% 150% at 12% -36%, rgba(239, 255, 250, .28), transparent 68%),
    radial-gradient(ellipse 36% 130% at 88% 136%, rgba(138, 116, 216, .16), transparent 70%),
    linear-gradient(112deg, rgba(24, 58, 50, .5), rgba(27, 40, 40, .6) 48%, rgba(8, 18, 18, .7));
}
.agent-quick-session-more,
.agent-quick-session-create { width: 36px; flex: 0 0 36px; padding: 0; }
.agent-quick-session-restore {
  flex: 0 0 auto;
  width: auto;
  padding: 0 12px 0 10px;
  gap: 6px;
  color: #e8f7f2;
  font-size: 12px;
  font-weight: 600;
}
.agent-quick-session-more.is-open {
  color: #e8f7f2;
  border-color: rgba(255, 255, 255, .34);
}
.agent-quick-history {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 8px);
  left: 8px;
  z-index: 4;
  isolation: isolate;
  max-height: min(260px, calc(100dvh - 260px));
  padding: 6px;
  border: 1px solid rgba(255, 255, 255, .22);
  border-radius: 20px;
  background: transparent;
  box-shadow:
    0 18px 42px rgba(0, 0, 0, .26),
    0 4px 14px rgba(0, 0, 0, .14);
  overflow-y: auto;
  display: grid;
  gap: 3px;
}
.agent-quick-history article { position: relative; z-index: 1; min-width: 0; min-height: 42px; padding: 3px; border-radius: 14px; display: grid; grid-template-columns: minmax(0, 1fr) 28px 28px; align-items: center; gap: 2px; }
.agent-quick-history article:hover, .agent-quick-history article.is-current { background: rgba(255, 255, 255, .07); }
.agent-quick-history button { min-width: 0; height: 28px; padding: 0; border: 0; border-radius: 12px; background: transparent; color: #aeb7b5; display: grid; place-items: center; cursor: pointer; }
.agent-quick-history button:hover { background: rgba(255, 255, 255, .08); color: #e4e4e7; }
.agent-quick-history__select { height: 38px !important; padding-inline: 7px !important; justify-items: start; align-content: center; text-align: left; }
.agent-quick-history__select strong, .agent-quick-history__select small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-quick-history__select strong { color: #e4e4e7; font-size: 11px; }
.agent-quick-history__select small { color: #aeb7b5; font-size: 9px; }

.agent-quick-composer__bar {
  position: relative;
  isolation: isolate;
  min-height: 60px;
  padding: 6px 8px;
  border: 1px solid rgba(255, 255, 255, .22);
  border-radius: var(--agent-quick-glass-radius);
  background: transparent;
  box-shadow:
    0 18px 42px rgba(0, 0, 0, .26),
    0 4px 14px rgba(0, 0, 0, .14);
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 38px 40px;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  transition: border-color .18s ease, box-shadow .18s ease;
}

.agent-quick-composer__bar:focus-within {
  border-color: rgba(192, 255, 238, .5);
  box-shadow:
    0 20px 48px rgba(0, 0, 0, .3),
    0 6px 18px rgba(13, 88, 73, .16),
    0 0 0 1px rgba(115, 214, 184, .12);
}
.agent-quick-composer__bar:focus-within .agent-quick-glass__rim { background-position: 0 0, 0 0, 0 0; }

.agent-quick-composer__icon,
.agent-quick-composer__submit {
  position: relative;
  z-index: 1;
  padding: 0;
  border: 0;
  background: transparent;
  color: #d4d4d8;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.agent-quick-composer__icon,
.agent-quick-composer__submit { width: 36px; height: 36px; border-radius: 50%; }
.agent-quick-composer__icon:hover:not(:disabled) { background: rgba(255, 255, 255, .07); color: #f4f4f5; }
.agent-quick-composer__icon:disabled { opacity: .36; cursor: not-allowed; }

.agent-quick-composer textarea {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 26px;
  max-height: 96px;
  padding: 5px 4px;
  resize: none;
  border: 0;
  background: transparent;
  color: #f4f4f5;
  font: 500 14px/1.5 var(--font-ui);
  outline: 0;
  caret-color: #f4f4f5;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .38);
  scrollbar-width: none;
}
.agent-quick-composer textarea::-webkit-scrollbar { display: none; }
.agent-quick-composer textarea::placeholder { color: #aeb7b5; }
.agent-quick-composer textarea:disabled { color: #71717a; cursor: not-allowed; }
.agent-quick-composer textarea:focus-visible { outline: 0; }

.agent-quick-composer__wave { position: relative; z-index: 1; height: 26px; display: inline-flex; align-items: center; justify-content: center; gap: 3px; }
.agent-quick-composer__wave i { width: 3px; border-radius: 2px; background: #8de0c5; }
.agent-quick-composer__wave i:nth-child(1) { height: 8px; background: #e8a36f; }
.agent-quick-composer__wave i:nth-child(2) { height: 14px; background: #d97f87; }
.agent-quick-composer__wave i:nth-child(3) { height: 19px; }
.agent-quick-composer__wave i:nth-child(4) { height: 13px; background: #81a9df; }
.agent-quick-composer__wave i:nth-child(5) { height: 7px; background: #9f8bc8; }
.agent-quick-composer__wave.is-running i { animation: agent-quick-pulse .7s ease-in-out infinite alternate; }
.agent-quick-composer__wave.is-running i:nth-child(2) { animation-delay: .08s; }
.agent-quick-composer__wave.is-running i:nth-child(3) { animation-delay: .16s; }
.agent-quick-composer__wave.is-running i:nth-child(4) { animation-delay: .24s; }
.agent-quick-composer__wave.is-running i:nth-child(5) { animation-delay: .32s; }

.agent-quick-composer__submit { border: 1px solid rgba(255, 255, 255, .12); background: rgba(255, 255, 255, .06); box-shadow: inset 0 1px rgba(255, 255, 255, .06); }
.agent-quick-composer__submit:hover:not(:disabled) { border-color: rgba(113, 208, 184, .48); background: rgba(24, 112, 91, .4); color: #d1fae5; transform: translateY(-1px); }
.agent-quick-composer__submit:active:not(:disabled) { transform: translateY(0); }
.agent-quick-composer__submit:disabled { opacity: .36; cursor: not-allowed; }
.agent-quick-composer__submit.is-stop { color: #fca5a5; }

.agent-quick-bubble__body:focus-visible,
.agent-quick-bubble__close:focus-visible,
.agent-quick-bubbles__toggle:focus-visible,
.agent-quick-composer button:focus-visible { outline: 2px solid rgba(113, 208, 184, .82); outline-offset: 2px; }

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .agent-quick-glass__distortion { display: none; }
  .agent-quick-glass__tint { background: rgba(25, 28, 31, .96); }
}

.agent-quick-composer-enter-active { animation: agent-quick-composer-in .24s cubic-bezier(.2, .8, .2, 1) both; }
.agent-quick-composer-leave-active { animation: agent-quick-composer-out .16s ease-in both; }
.agent-quick-bubble-enter-active { animation: agent-quick-bubble-in .24s cubic-bezier(.2, .8, .2, 1) both; }
.agent-quick-bubble-leave-active { animation: agent-quick-bubble-out .16s ease-in both; }

@keyframes agent-quick-composer-in { from { transform: translateY(18px) scale(.98); } to { transform: none; } }
@keyframes agent-quick-composer-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(12px) scale(.985); } }
@keyframes agent-quick-bubble-in { from { transform: translateY(14px) scale(.98); } to { transform: none; } }
@keyframes agent-quick-bubble-out { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(8px) scale(.985); } }
@keyframes agent-quick-pulse { from { transform: scaleY(.62); opacity: .58; } to { transform: scaleY(1.12); opacity: 1; } }

@media (max-width: 44rem) {
  .agent-quick-bubbles { right: 16px; bottom: 16px; width: calc(100vw - 32px); }
  .agent-quick-composer { --agent-quick-glass-radius: 28px; bottom: 16px; width: calc(100vw - 32px); }
  .agent-quick-surface.has-composer .agent-quick-bubbles { bottom: 204px; }
  .agent-quick-composer__bar { min-height: 56px; grid-template-columns: 36px minmax(0, 1fr) 32px 38px; }
  .agent-quick-composer__icon,
  .agent-quick-composer__submit { width: 34px; height: 34px; }
  .agent-quick-composer textarea { font-size: 14px; }
  .agent-quick-bubble__detail { padding-inline: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .agent-quick-session-bar button { transition: none; }
  .agent-quick-composer-enter-active,
  .agent-quick-composer-leave-active,
  .agent-quick-bubble-enter-active,
  .agent-quick-bubble-leave-active,
  .agent-quick-bubble__pulse i,
  .agent-quick-composer__wave.is-running i { animation: none; }
  .agent-quick-bubble.is-stacked-back,
  .agent-quick-bubbles__toggle { transition: none; }
  .agent-quick-glass__rim { transition: none; }
}
</style>
