import type { AgentFloatingApi } from "./api-contract";

type AgentFloatingPart<Keys extends keyof AgentFloatingApi> = Pick<AgentFloatingApi, Keys>;

export type AgentLauncherChromeApi = AgentFloatingPart<
  | "edgeCollapsedStorageKey"
  | "edgeStorageKey"
  | "positionStorageKey"
  | "desktop"
  | "overlayRuntime"
  | "open"
  | "viewport"
  | "buttonPosition"
  | "edgeCollapsed"
  | "snappedEdge"
  | "dragging"
  | "activePresentation"
  | "agentRoot"
  | "ignoreMouse"
  | "overlayDragState"
  | "visible"
  | "entryMode"
  | "floatingVisible"
  | "rootStyle"
  | "panelAlignLeft"
  | "panelBelow"
  | "floatingButtonLabel"
  | "chromeVisible"
  | "currentViewport"
  | "defaultButtonPosition"
  | "storedButtonPosition"
  | "storedEdge"
  | "persistButtonPosition"
  | "persistEdgeState"
  | "collapseAtEdge"
  | "expandFromEdge"
  | "collapseToEdge"
  | "togglePanel"
  | "settleButtonDrag"
  | "handleDesktopLauncherAction"
  | "syncDesktopLauncherOverlay"
  | "handleViewportResize"
  | "isDialogOverlayTarget"
  | "dialogOverlayOpen"
  | "handleDocumentPointerDown"
  | "handleNativeViewPointerDown"
  | "handlePointerOutside"
  | "isAgentHitTarget"
  | "syncIgnoreMouse"
  | "handleOverlayMouseMove"
>;

export type AgentSessionsApi = AgentFloatingPart<
  | "currentSessionId"
  | "sessionItems"
  | "sessionsLoading"
  | "historyOpen"
  | "sessionsLoadSeq"
  | "launchConversationReady"
  | "loadSessionsTail"
  | "loadSettings"
  | "applyConversation"
  | "loadSessions"
  | "ensureLaunchConversation"
  | "refreshSessionList"
  | "createConversation"
  | "selectConversation"
  | "renameConversation"
  | "deleteConversation"
  | "resetRunArtifacts"
>;

export type AgentChatApi = AgentFloatingPart<
  | "input"
  | "composerExpanded"
  | "settings"
  | "settingsError"
  | "loadingSettings"
  | "running"
  | "activeRunId"
  | "activeMessageId"
  | "messages"
  | "contextCards"
  | "toolActivities"
  | "addingContext"
  | "quickComposerVisible"
  | "quickBubbleIds"
  | "quickBubblePrompts"
  | "quickExpandedBubbleId"
  | "quickHistoryTiled"
  | "quickBubblesHidden"
  | "scrollBody"
  | "composerInput"
  | "pendingQuickPrompt"
  | "inputLimit"
  | "configured"
  | "diagnosticActive"
  | "sendDisabled"
  | "inputCount"
  | "agentStatusText"
  | "panelBodyVisible"
  | "currentSessionTitle"
  | "quickBubbles"
  | "quickActionBubbleId"
  | "sceneLabel"
  | "displayedQuickBubbles"
  | "nowIso"
  | "newMessage"
  | "restoreQuickBubblesFromHistory"
  | "collapseQuickHistoryStack"
  | "hideQuickBubbles"
  | "showQuickBubbles"
  | "toggleQuickHistoryStack"
  | "trackQuickBubble"
  | "closeQuickBubble"
  | "toggleQuickBubble"
  | "scrollToBottom"
  | "resizeComposerInput"
  | "expandComposer"
  | "collapseComposer"
  | "quickPromptLabel"
  | "scriptLineLabel"
  | "currentSceneCard"
  | "upsertContextCard"
  | "captureCurrentScene"
  | "ensureAssistantMessage"
  | "applyTurnStats"
  | "handleAgentEvent"
  | "sendMessageFor"
  | "sendMessage"
  | "sendQuickMessage"
  | "toggleQuickComposer"
  | "handleAppShortcut"
  | "stopRun"
  | "openSettings"
>;

export type AgentSuggestionsApi = AgentFloatingPart<
  | "sshSuggestions"
  | "sshScriptSuggestions"
  | "databaseSuggestions"
  | "vironApprovals"
  | "sshDiagnosticExecuting"
  | "databaseDiagnosticExecuting"
  | "quickSshSuggestions"
  | "quickSshScriptSuggestions"
  | "quickDatabaseSuggestions"
  | "fillSshSuggestion"
  | "canFillSshSuggestion"
  | "fillSshScriptSuggestion"
  | "sshSuggestionTarget"
  | "isExecutableSuggestion"
  | "sshSuggestionBadge"
  | "databaseSuggestionBadge"
  | "executeSshSuggestion"
  | "cancelSshSuggestion"
  | "stopActiveDiagnostic"
  | "databaseSuggestionTarget"
  | "fillDatabaseSuggestion"
  | "executeDatabaseSuggestion"
  | "cancelDatabaseSuggestion"
  | "respondVironApproval"
>;

export interface AgentFloatingContext {
  launcherChrome: AgentLauncherChromeApi | null;
  sessions: AgentSessionsApi | null;
  chat: AgentChatApi | null;
  suggestions: AgentSuggestionsApi | null;
}

export function createAgentFloatingContext(): AgentFloatingContext { return { launcherChrome: null, sessions: null, chat: null, suggestions: null }; }

export function requireAgentFloatingPart<Key extends keyof AgentFloatingContext>(ctx: AgentFloatingContext, key: Key): NonNullable<AgentFloatingContext[Key]> {
  const part = ctx[key];
  if (part === null) throw new Error(`Agent floating part is not bound: ${key}`);
  return part as NonNullable<AgentFloatingContext[Key]>;
}

export function deferAgentFloatingPart<Key extends keyof AgentFloatingContext>(ctx: AgentFloatingContext, key: Key): NonNullable<AgentFloatingContext[Key]> {
  const proxy = new Proxy({}, {
    get(_target, property) {
      return Reflect.get(requireAgentFloatingPart(ctx, key) as object, property);
    },
    set(_target, property, value) {
      return Reflect.set(requireAgentFloatingPart(ctx, key) as object, property, value);
    },
  });
  return proxy as NonNullable<AgentFloatingContext[Key]>;
}
