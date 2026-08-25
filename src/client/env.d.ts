/// <reference types="vite/client" />
import "vue";

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare global {
interface Window {
  vironAgentChatOverlay?: boolean;
  vironActiveEnvironmentDock?: {
    onState(listener: (state: import("../shared/active-environment-dock").ActiveEnvironmentDockState | null) => void): () => void;
    onLayout(listener: (layout: import("../shared/active-environment-dock").ActiveEnvironmentDockLayoutState) => void): () => void;
    action(action: import("../shared/active-environment-dock").ActiveEnvironmentDockAction): Promise<void>;
    drag(action: import("../shared/active-environment-dock").ActiveEnvironmentDockDragAction): void;
  };
  vironConnectionQuality?: {
    onState(listener: (state: import("../shared/connection-quality").ConnectionQualityOverlayState | null) => void): () => void;
    action(action: import("../shared/connection-quality").ConnectionQualityOverlayAction): Promise<void>;
  };
  vironAgentLauncher?: {
    onState(listener: (state: import("../shared/agent-floating-overlay").AgentFloatingOverlayState | null) => void): () => void;
    action(action: import("../shared/agent-floating-overlay").AgentFloatingOverlayAction): Promise<void>;
  };
  vironDesktop?: {
    setLanguage(language: import("../shared/i18n").Language): Promise<{ language: import("../shared/i18n").Language }>;
    getState(): Promise<import("./desktop").DesktopState>;
    readClipboardText(): Promise<string>;
    writeClipboardText(value: string): Promise<{ written: true }>;
    setTitleBarTheme(appearance: import("../shared/desktop-titlebar").DesktopTitleBarAppearance): Promise<{ applied: boolean }>;
    showMonitorAlertNotification(input: import("../shared/monitor-alerts").DesktopMonitorAlertNotification): Promise<{ shown: boolean }>;
    onMonitorAlertOpen(listener: (target: import("../shared/monitor-alerts").DesktopMonitorAlertNotification) => void): () => void;
    getShortcutPreferences(): Promise<{
      overrides: import("../shared/keyboard-shortcuts").ShortcutOverrides;
      bindings: import("../shared/keyboard-shortcuts").ShortcutBindings;
    }>;
    setShortcutPreferences(overrides: import("../shared/keyboard-shortcuts").ShortcutOverrides): Promise<{
      overrides: import("../shared/keyboard-shortcuts").ShortcutOverrides;
      bindings: import("../shared/keyboard-shortcuts").ShortcutBindings;
    }>;
    setShortcutCapture(active: boolean): Promise<{ active: boolean }>;
    setAgentEntryMode(mode: import("../shared/agent").AgentEntryMode): Promise<import("./desktop").DesktopState>;
    onShortcut(listener: (action: import("../shared/keyboard-shortcuts").ShortcutActionId) => void): () => void;
    onShortcutCaptureInput(listener: (input: import("../shared/keyboard-shortcuts").ShortcutInput) => void): () => void;
    checkForUpdates(): Promise<import("../shared/desktop-release").DesktopUpdateCheckResult>;
    openLocalNetworkSettings(): Promise<{ opened: true }>;
    setExecutionMode(mode: import("../shared/execution-mode").DesktopExecutionMode): Promise<import("./desktop").DesktopState>;
    getExecutionActivity(): Promise<import("./desktop").DesktopExecutionActivity>;
    getMcpStatus(): Promise<import("../shared/mcp-settings").DesktopMcpStatus>;
    setLocalMcpEnabled(enabled: boolean): Promise<import("../shared/mcp-settings").DesktopMcpStatus>;
    setLocalMcpApprovalMode(mode: import("../shared/mcp-settings").McpApprovalMode): Promise<import("../shared/mcp-settings").DesktopMcpStatus>;
    getAgentSettings(): Promise<import("../shared/agent").AgentSettingsPublic>;
    saveAgentSettings(input: import("../shared/agent").AgentSettingsInput): Promise<import("../shared/agent").AgentSettingsPublic>;
    listAgentModels(input: import("../shared/agent").AgentModelListInput): Promise<import("../shared/agent").AgentModelListResult>;
    deleteAgentSettings(): Promise<import("../shared/agent").AgentSettingsPublic>;
    testAgentSettings(): Promise<import("../shared/agent").AgentSettingsTestResult>;
    readAgentSshContext(sessionId: string): Promise<import("../shared/agent").AgentSshContextSnapshot>;
    readAgentDatabaseContext(input: import("../shared/agent").AgentDatabaseContextInput): Promise<import("../shared/agent").AgentDatabaseContextSnapshot>;
    executeAgentDatabaseRead(input: { connectionId: string; database: string; sql: string }): Promise<import("../shared/agent").AgentDatabaseReadResult>;
    recordAgentAction(input: { action: string; target: string; summary: string }): Promise<{ recorded: true }>;
    clearAgentAudit(): Promise<{ cleared: number }>;
    listAgentSessions(): Promise<import("../shared/agent").AgentConversationListResult>;
    getCurrentAgentSession(): Promise<import("../shared/agent").AgentConversation>;
    createAgentSession(title?: string): Promise<import("../shared/agent").AgentConversation>;
    selectAgentSession(sessionId: string): Promise<import("../shared/agent").AgentConversation>;
    renameAgentSession(input: { sessionId: string; title: string }): Promise<import("../shared/agent").AgentConversationSummary>;
    deleteAgentSession(sessionId: string): Promise<import("../shared/agent").AgentConversation>;
    sendAgentChat(input: import("../shared/agent").AgentChatRequest): Promise<{ runId: string; messageId: string; sessionId: string }>;
    respondAgentApproval(input: import("../shared/agent").AgentToolApprovalResponseInput): Promise<{ accepted: boolean; runId: string; messageId: string }>;
    respondAgentWorkbenchExecution(input: import("../shared/agent").AgentWorkbenchExecutionResponseInput): Promise<{ accepted: true }>;
    stopAgentChat(runId: string): Promise<{ stopped: boolean }>;
    stopAgentResourceRuns(input: { kind: "database" | "ssh"; resourceId: string; executionTarget?: "desktop-local" | "server-forwarded" }): Promise<{ stopped: number }>;
    onAgentEvent(listener: (event: import("../shared/agent").AgentStreamEvent) => void): () => void;
    updateAgentLauncher(state: import("../shared/agent-floating-overlay").AgentFloatingOverlayState | null): Promise<void>;
    onAgentLauncherAction(listener: (action: import("../shared/agent-floating-overlay").AgentFloatingOverlayAction) => void): () => void;
    getAgentHost(): Promise<import("../shared/agent-host").AgentHostState | null>;
    updateAgentHost(state: import("../shared/agent-host").AgentHostState | null): Promise<void>;
    agentHostAction(action: import("../shared/agent-host").AgentHostAction): Promise<import("../shared/agent-host").AgentHostActionResult>;
    respondAgentHost(id: string, result: import("../shared/agent-host").AgentHostActionResult): Promise<void>;
    onAgentHostState(listener: (state: import("../shared/agent-host").AgentHostState | null) => void): () => void;
    onAgentHostRequest(listener: (request: import("../shared/agent-host").AgentHostActionRequest) => void): () => void;
    setAgentChatNativeOverlay(active: boolean): Promise<void>;
    updateAgentChatChrome(visible: boolean): Promise<void>;
    setAgentChatIgnoreMouse(ignore: boolean): Promise<void>;
    focusAgentChat(): Promise<void>;
    notifyAgentChatPointerOutside(): Promise<void>;
    onAgentChatPointerOutside(listener: () => void): () => void;
    updateConnectionQuality(state: import("../shared/connection-quality").ConnectionQualityOverlayState | null): Promise<void>;
    probeConnectionQualityTarget(targetId: string): Promise<number>;
    onConnectionQualityAction(listener: (action: import("../shared/connection-quality").ConnectionQualityOverlayAction) => void): () => void;
    updateActiveEnvironmentDock(state: import("../shared/active-environment-dock").ActiveEnvironmentDockState | null): Promise<void>;
    updateActiveEnvironmentDockLayout(layout: import("../shared/active-environment-dock").ActiveEnvironmentDockLayoutState): Promise<void>;
    captureRendererPreview(bounds: import("./desktop").DesktopWebViewBounds): Promise<string>;
    onActiveEnvironmentDockAction(listener: (action: import("../shared/active-environment-dock").ActiveEnvironmentDockAction) => void): () => void;
    onNativeViewPointerDown(listener: () => void): () => void;
    onHistoryNavigation(listener: (direction: "back" | "forward") => void): () => void;
    onHistoryNavigationTouch(listener: (phase: "begin" | "end") => void): () => void;
    onStateChanged(listener: (state: import("./desktop").DesktopState) => void): () => void;
    setEndpoint(endpoint: string): Promise<
      | { ok: true; state: import("./desktop").DesktopState }
      | { ok: false; error: { code: string; message: string } }
    >;
    clearEndpoint(): Promise<import("./desktop").DesktopState>;
    request(request: unknown): Promise<import("./desktop").DesktopResponse>;
    download(path: string, filename?: string): Promise<{ saved: boolean; filePath?: string }>;
    saveTextFile(input: { filename: string; content: string }): Promise<{ saved: boolean; filePath?: string }>;
    selectDatabaseSqlFile(): Promise<{ selected: boolean; name?: string; content?: string; filePath?: string }>;
    openDatabaseQueryExternally(input: { id: string; name: string; sql: string }): Promise<{ opened: true; filePath: string }>;
    revealDatabaseQuery(input: { id: string; name: string; sql: string }): Promise<{ revealed: true; filePath: string }>;
    revealDatabaseBackup(input: { id: string; path: string; filename: string }): Promise<{ revealed: true; filePath: string }>;
    openWebView(input: { credentialId: string; bounds: import("./desktop").DesktopWebViewBounds; initialPage?: import("./desktop").DesktopWebInitialPage; originEnvironmentId?: string }): Promise<import("./desktop").DesktopWebViewState>;
    updateWebViewBounds(id: string, bounds: import("./desktop").DesktopWebViewBounds): Promise<import("./desktop").DesktopWebViewState>;
    setWebViewVisible(id: string, visible: boolean): Promise<import("./desktop").DesktopWebViewState>;
    setWebViewPreviewing(id: string, previewing: boolean): Promise<import("./desktop").DesktopWebViewState>;
    captureWebView(id: string): Promise<string>;
    webViewAction(id: string, action: import("./desktop").DesktopWebViewAction): Promise<import("./desktop").DesktopWebViewState>;
    closeWebView(id: string): Promise<{ closed: boolean }>;
    onWebViewState(listener: (state: import("./desktop").DesktopWebViewState) => void): () => void;
    updateImmersiveNavigation(state: import("../shared/immersive-navigation").ImmersiveNavigationState | null): Promise<void>;
    onImmersiveNavigationAction(listener: (action: import("../shared/immersive-navigation").ImmersiveNavigationAction) => void): () => void;
    listSshSessions(): Promise<{ items: import("./desktop").DesktopSshSessionState[] }>;
    openSshSession(input: { connectionId: string; originEnvironmentId?: string; cols: number; rows: number }): Promise<{ session: import("./desktop").DesktopSshSessionState; ticket: string; activeConnectionId: string }>;
    issueSshTicket(sessionId: string): Promise<{ ticket: string }>;
    attachSshSession(sessionId: string, ticket: string): Promise<{ session: import("./desktop").DesktopSshSessionState; output: string }>;
    detachSshSession(sessionId: string): Promise<{ detached: boolean }>;
    sshSessionAction(sessionId: string, action: unknown): Promise<{ ok: boolean }>;
    closeSshSession(sessionId: string): Promise<{ closed: boolean }>;
    onSshSessionEvent(listener: (event: import("./desktop").DesktopSshSessionEvent) => void): () => void;
    listSshRecordings(): Promise<{ items: import("./desktop").DesktopSshRecording[] }>;
    downloadSshRecording(recordingId: string): Promise<{ saved: boolean; filePath?: string }>;
    deleteSshRecording(recordingId: string): Promise<{ deleted: boolean }>;
    listSftp(input: { connectionId: string; path: string }): Promise<{ path: string; parentPath: string | null; items: import("./sftp").SftpItem[] }>;
    sftpAction(input: unknown): Promise<unknown>;
    startSftpUpload(input: { connectionId: string; directory: string; filename: string }): Promise<{ uploadId: string; path: string }>;
    uploadSftpChunk(uploadId: string, data: ArrayBuffer): Promise<{ accepted: boolean }>;
    completeSftpUpload(uploadId: string): Promise<{ path: string }>;
    cancelSftpUpload(uploadId: string): Promise<{ cancelled: boolean }>;
    downloadSftp(input: { connectionId: string; path: string; filename: string }): Promise<{ saved: boolean; filePath?: string }>;
    droppedFilePath(file: File): string;
    startSftpDrag(input: { connectionId: string; paths: string[] }): Promise<{ started: boolean }>;
    listSftpTransfers(): Promise<{ items: import("./sftp").SftpTransferTask[] }>;
    previewSftpTransfer(input: unknown): Promise<unknown>;
    createSftpTransfer(input: unknown): Promise<{ task: import("./sftp").SftpTransferTask; activeConnectionId: string }>;
    cancelSftpTransfer(taskId: string): Promise<{ cancelled: boolean }>;
    retrySftpTransfer(input: { taskId: string; originEnvironmentId?: string }): Promise<{ task: import("./sftp").SftpTransferTask; activeConnectionId: string }>;
    openLogStream(input: { environmentId: string; logId: string; initialLines: number }): Promise<{ stream: import("./desktop").DesktopLogStreamState; activeConnectionId: string }>;
    closeLogStream(streamId: string): Promise<{ closed: boolean }>;
    onLogStreamEvent(listener: (event: import("./desktop").DesktopLogStreamEvent) => void): () => void;
    openServiceSocket(path: string, params: Record<string, string>): Promise<{ id: string }>;
    sendServiceSocket(id: string, data: string | ArrayBuffer): Promise<{ sent: boolean }>;
    closeServiceSocket(id: string): Promise<{ closed: boolean }>;
    onServiceSocketEvent(listener: (event: import("./desktop").DesktopServiceSocketEvent) => void): () => void;
  };
}
}

declare module "vue" {
  interface ComponentCustomProperties {
    $t(key: string, values?: readonly unknown[]): string;
    $locale(): import("../shared/i18n").Language;
  }
}
