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

export function useAgentLauncherChrome(ctx: AgentFloatingContext) {
  const $sessions = deferAgentFloatingPart(ctx, "sessions");
  const $chat = deferAgentFloatingPart(ctx, "chat");
  const $suggestions = deferAgentFloatingPart(ctx, "suggestions");
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
      }
      catch {
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

  const activePresentation = ref<AgentEntryMode>("floating");

  const agentRoot = ref<HTMLElement | null>(null);

  let ignoreMouse = true;

  let overlayDragState: AgentOverlayDragState | null = null;

  const visible = computed(() => desktop && Boolean(agentHostState.userId));

  const entryMode = computed<AgentEntryMode>(() => desktopAppState.value?.agentEntryMode ?? "disabled");

  const floatingVisible = computed(() => visible.value && entryMode.value === "floating");

  const rootStyle = computed(() => ({ left: `${buttonPosition.value.x}px`, top: `${buttonPosition.value.y}px` }));

  const panelAlignLeft = computed(() => buttonPosition.value.x + AGENT_FLOATING_BUTTON_SIZE / 2 < viewport.value.width / 2);

  const panelBelow = computed(() => buttonPosition.value.y + AGENT_FLOATING_BUTTON_SIZE / 2 < viewport.value.height / 2);

  const floatingButtonLabel = computed(() => {
      if (edgeCollapsed.value && !open.value)
          return tr("展开并打开 Viron Agent");
      return open.value ? tr("关闭 Viron Agent") : tr("打开 Viron Agent");
  });

  const chromeVisible = computed(() => visible.value && ((entryMode.value === "floating" && open.value)
      || (entryMode.value === "quick" && ($chat.quickComposerVisible.value || $chat.displayedQuickBubbles.value.length > 0))));

  function persistButtonPosition() {
      localStorage.setItem(positionStorageKey, JSON.stringify(buttonPosition.value));
  }

  function persistEdgeState() {
      localStorage.setItem(edgeCollapsedStorageKey, edgeCollapsed.value ? "1" : "0");
      if (snappedEdge.value)
          localStorage.setItem(edgeStorageKey, snappedEdge.value);
      else
          localStorage.removeItem(edgeStorageKey);
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
      if (edge)
          collapseAtEdge(edge);
      else {
          edgeCollapsed.value = false;
          snappedEdge.value = null;
          persistButtonPosition();
          persistEdgeState();
      }
  }

  function handleDesktopLauncherAction(action: AgentFloatingOverlayAction) {
      if (action.type === "toggle")
          return void togglePanel();
      if (action.type === "expand")
          return void expandFromEdge();
      if (action.type === "drag-start") {
          if (edgeCollapsed.value)
              return;
          overlayDragState = { startX: action.screenX, startY: action.screenY, origin: { ...buttonPosition.value } };
          dragging.value = true;
          open.value = false;
          return;
      }
      if (!overlayDragState)
          return;
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
      if (!desktop)
          return;
      if (!floatingVisible.value) {
          void updateDesktopAgentLauncher(null);
          return;
      }
      const edge = edgeCollapsed.value ? snappedEdge.value : null;
      const layout = agentFloatingOverlayLayout(buttonPosition.value, viewport.value, edge);
      void updateDesktopAgentLauncher({
          ...layout,
          open: open.value,
          running: $chat.running.value,
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
      }
      else {
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
      if (isDialogOverlayTarget(event.target))
          return;
      if ($chat.quickComposerVisible.value) {
          const composer = document.querySelector<HTMLElement>('[data-agent-overlay="quick-composer"]');
          if (event.target instanceof Node && (!composer || !composer.contains(event.target))) {
              $chat.quickComposerVisible.value = false;
          }
      }
      if ($chat.quickHistoryTiled.value) {
          const bubbles = document.querySelector<HTMLElement>('[data-agent-overlay="quick-bubbles"]');
          if (event.target instanceof Node && (!bubbles || !bubbles.contains(event.target))) {
              $chat.collapseQuickHistoryStack();
          }
      }
      if (!open.value || !agentRoot.value)
          return;
      if (event.target instanceof Node && !agentRoot.value.contains(event.target))
          open.value = false;
  }

  function handleNativeViewPointerDown() {
      if (dialogOverlayOpen())
          return;
      $chat.quickComposerVisible.value = false;
      $chat.collapseQuickHistoryStack();
  }

  function handlePointerOutside() {
      if (dialogOverlayOpen())
          return;
      $chat.quickComposerVisible.value = false;
      $chat.collapseQuickHistoryStack();
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
      if (ignoreMouse === ignore)
          return;
      ignoreMouse = ignore;
      void setDesktopAgentChatIgnoreMouse(ignore);
  }

  function handleOverlayMouseMove(event: MouseEvent) {
      if (!chromeVisible.value)
          return;
      syncIgnoreMouse(!isAgentHitTarget(document.elementFromPoint(event.clientX, event.clientY)));
  }

  if (edgeCollapsed.value && snappedEdge.value) {
      buttonPosition.value = snapAgentFloatingPosition(buttonPosition.value, snappedEdge.value, viewport.value);
  }

  function startAgentLauncherChromeWatchers() {
    watch([floatingVisible, open, $chat.running, dragging, edgeCollapsed, snappedEdge, buttonPosition, viewport], syncDesktopLauncherOverlay, { immediate: true });

    watch(chromeVisible, (value) => {
        if (!desktop)
            return;
        if (!value)
            syncIgnoreMouse(true);
        void updateDesktopAgentChatChrome(value);
    }, { immediate: true });

    watch([open, $chat.quickComposerVisible], ([panelOpen, composerVisible]) => {
        if (panelOpen || composerVisible)
            void focusDesktopAgentChat();
    });
  }

  return {
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
    startAgentLauncherChromeWatchers,
  };
}

