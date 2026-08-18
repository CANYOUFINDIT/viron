import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("vironDesktop", {
  getState: () => ipcRenderer.invoke("viron:state"),
  setLanguage: (language: "zh-CN" | "en") => ipcRenderer.invoke("viron:language:set", language),
  readClipboardText: () => ipcRenderer.invoke("viron:clipboard:read-text"),
  writeClipboardText: (value: string) => ipcRenderer.invoke("viron:clipboard:write-text", value),
  setTitleBarTheme: (appearance: "light" | "dark" | "bright" | "login") => ipcRenderer.invoke("viron:titlebar-theme:set", appearance),
  showMonitorAlertNotification: (input: unknown) => ipcRenderer.invoke("viron:monitor-alert:notify", input),
  onMonitorAlertOpen: (listener: (target: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: unknown) => listener(target);
    ipcRenderer.on("viron:monitor-alert-open", handler);
    return () => ipcRenderer.off("viron:monitor-alert-open", handler);
  },
  getShortcutPreferences: () => ipcRenderer.invoke("viron:shortcuts:get"),
  setShortcutPreferences: (overrides: unknown) => ipcRenderer.invoke("viron:shortcuts:set", overrides),
  setShortcutCapture: (active: boolean) => ipcRenderer.invoke("viron:shortcuts:capture", active),
  setAgentEntryMode: (mode: "floating" | "quick" | "disabled") => ipcRenderer.invoke("viron:agent:entry-mode:set", mode),
  onShortcut: (listener: (action: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => listener(action);
    ipcRenderer.on("viron:shortcut", handler);
    return () => ipcRenderer.off("viron:shortcut", handler);
  },
  onShortcutCaptureInput: (listener: (input: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => listener(input);
    ipcRenderer.on("viron:shortcut-capture-input", handler);
    return () => ipcRenderer.off("viron:shortcut-capture-input", handler);
  },
  checkForUpdates: () => ipcRenderer.invoke("viron:update:check"),
  openLocalNetworkSettings: () => ipcRenderer.invoke("viron:system-settings:open-local-network"),
  setExecutionMode: (mode: "local" | "server") => ipcRenderer.invoke("viron:execution-mode:set", mode),
  getExecutionActivity: () => ipcRenderer.invoke("viron:execution-activity"),
  getMcpStatus: () => ipcRenderer.invoke("viron:mcp:status"),
  setLocalMcpEnabled: (enabled: boolean) => ipcRenderer.invoke("viron:mcp:enabled:set", enabled),
  setLocalMcpApprovalMode: (mode: "always" | "high-risk" | "never") => ipcRenderer.invoke("viron:mcp:approval-mode:set", mode),
  getAgentSettings: () => ipcRenderer.invoke("viron:agent:settings:get"),
  saveAgentSettings: (input: unknown) => ipcRenderer.invoke("viron:agent:settings:save", input),
  listAgentModels: (input: unknown) => ipcRenderer.invoke("viron:agent:models:list", input),
  deleteAgentSettings: () => ipcRenderer.invoke("viron:agent:settings:delete"),
  testAgentSettings: () => ipcRenderer.invoke("viron:agent:settings:test"),
  readAgentSshContext: (sessionId: string) => ipcRenderer.invoke("viron:agent:ssh-context", sessionId),
  readAgentDatabaseContext: (input: unknown) => ipcRenderer.invoke("viron:agent:database-context", input),
  executeAgentDatabaseRead: (input: unknown) => ipcRenderer.invoke("viron:agent:database-read", input),
  recordAgentAction: (input: unknown) => ipcRenderer.invoke("viron:agent:audit:record", input),
  clearAgentAudit: () => ipcRenderer.invoke("viron:agent:audit:clear"),
  listAgentSessions: () => ipcRenderer.invoke("viron:agent:sessions:list"),
  getCurrentAgentSession: () => ipcRenderer.invoke("viron:agent:sessions:current"),
  createAgentSession: (title?: string) => ipcRenderer.invoke("viron:agent:sessions:create", title),
  selectAgentSession: (sessionId: string) => ipcRenderer.invoke("viron:agent:sessions:select", sessionId),
  renameAgentSession: (input: unknown) => ipcRenderer.invoke("viron:agent:sessions:rename", input),
  deleteAgentSession: (sessionId: string) => ipcRenderer.invoke("viron:agent:sessions:delete", sessionId),
  sendAgentChat: (input: unknown) => ipcRenderer.invoke("viron:agent:chat", input),
  respondAgentApproval: (input: unknown) => ipcRenderer.invoke("viron:agent:approval:respond", input),
  respondAgentWorkbenchExecution: (input: unknown) => ipcRenderer.invoke("viron:agent:workbench:respond", input),
  stopAgentChat: (runId: string) => ipcRenderer.invoke("viron:agent:chat:stop", runId),
  stopAgentResourceRuns: (input: unknown) => ipcRenderer.invoke("viron:agent:resource:stop", input),
  onAgentEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("viron:agent-event", handler);
    return () => ipcRenderer.off("viron:agent-event", handler);
  },
  updateAgentLauncher: (state: unknown) => ipcRenderer.invoke("viron:agent-launcher:update", state),
  onAgentLauncherAction: (listener: (action: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => listener(action);
    ipcRenderer.on("viron:agent-launcher-action", handler);
    return () => ipcRenderer.off("viron:agent-launcher-action", handler);
  },
  getAgentHost: () => ipcRenderer.invoke("viron:agent-host:get"),
  updateAgentHost: (state: unknown) => ipcRenderer.invoke("viron:agent-host:update", state),
  agentHostAction: (action: unknown) => ipcRenderer.invoke("viron:agent-host:action", action),
  respondAgentHost: (id: string, result: unknown) => ipcRenderer.invoke("viron:agent-host:respond", id, result),
  onAgentHostState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:agent-host-state", handler);
    return () => ipcRenderer.off("viron:agent-host-state", handler);
  },
  onAgentHostRequest: (listener: (request: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: unknown) => listener(request);
    ipcRenderer.on("viron:agent-host-request", handler);
    return () => ipcRenderer.off("viron:agent-host-request", handler);
  },
  setAgentChatNativeOverlay: (active: boolean) => ipcRenderer.invoke("viron:agent-chat:native-overlay", active),
  updateAgentChatChrome: (visible: boolean) => ipcRenderer.invoke("viron:agent-chat:chrome", visible),
  setAgentChatIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke("viron:agent-chat:ignore-mouse", ignore),
  focusAgentChat: () => ipcRenderer.invoke("viron:agent-chat:focus"),
  notifyAgentChatPointerOutside: () => ipcRenderer.invoke("viron:agent-chat:pointer-outside"),
  onAgentChatPointerOutside: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("viron:agent-chat-pointer-outside", handler);
    return () => ipcRenderer.off("viron:agent-chat-pointer-outside", handler);
  },
  updateConnectionQuality: (state: unknown) => ipcRenderer.invoke("viron:connection-quality:update", state),
  probeConnectionQualityTarget: (targetId: string) => ipcRenderer.invoke("viron:connection-quality:target:probe", targetId),
  onConnectionQualityAction: (listener: (action: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => listener(action);
    ipcRenderer.on("viron:connection-quality-action", handler);
    return () => ipcRenderer.off("viron:connection-quality-action", handler);
  },
  updateActiveEnvironmentDock: (state: unknown) => ipcRenderer.invoke("viron:active-environment-dock:update", state),
  updateActiveEnvironmentDockLayout: (layout: unknown) => ipcRenderer.invoke("viron:active-environment-dock:layout", layout),
  captureRendererPreview: (bounds: unknown) => ipcRenderer.invoke("viron:renderer-preview:capture", bounds),
  onActiveEnvironmentDockAction: (listener: (action: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => listener(action);
    ipcRenderer.on("viron:active-environment-dock-action", handler);
    return () => ipcRenderer.off("viron:active-environment-dock-action", handler);
  },
  onNativeViewPointerDown: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("viron:native-view-pointer-down", handler);
    return () => ipcRenderer.off("viron:native-view-pointer-down", handler);
  },
  onStateChanged: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:state-changed", handler);
    return () => ipcRenderer.off("viron:state-changed", handler);
  },
  setEndpoint: (endpoint: string) => ipcRenderer.invoke("viron:endpoint:set", endpoint),
  clearEndpoint: () => ipcRenderer.invoke("viron:endpoint:clear"),
  request: (request: unknown) => ipcRenderer.invoke("viron:api", request),
  download: (path: string, filename?: string) => ipcRenderer.invoke("viron:download", path, filename),
  saveTextFile: (input: unknown) => ipcRenderer.invoke("viron:save-text-file", input),
  selectDatabaseSqlFile: () => ipcRenderer.invoke("viron:database-artifact:select-sql"),
  openDatabaseQueryExternally: (input: unknown) => ipcRenderer.invoke("viron:database-artifact:open-query", input),
  revealDatabaseQuery: (input: unknown) => ipcRenderer.invoke("viron:database-artifact:reveal-query", input),
  revealDatabaseBackup: (input: unknown) => ipcRenderer.invoke("viron:database-artifact:reveal-backup", input),
  openWebView: (input: unknown) => ipcRenderer.invoke("viron:web-view:open", input),
  updateWebViewBounds: (id: string, bounds: unknown) => ipcRenderer.invoke("viron:web-view:bounds", id, bounds),
  setWebViewVisible: (id: string, visible: boolean) => ipcRenderer.invoke("viron:web-view:visible", id, visible),
  setWebViewPreviewing: (id: string, previewing: boolean) => ipcRenderer.invoke("viron:web-view:previewing", id, previewing),
  captureWebView: (id: string) => ipcRenderer.invoke("viron:web-view:capture", id),
  webViewAction: (id: string, action: unknown) => ipcRenderer.invoke("viron:web-view:action", id, action),
  closeWebView: (id: string) => ipcRenderer.invoke("viron:web-view:close", id),
  onWebViewState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("viron:web-view-state", handler);
    return () => ipcRenderer.off("viron:web-view-state", handler);
  },
  updateImmersiveNavigation: (state: unknown) => ipcRenderer.invoke("viron:immersive-navigation:update", state),
  onImmersiveNavigationAction: (listener: (action: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => listener(action);
    ipcRenderer.on("viron:immersive-navigation-action", handler);
    return () => ipcRenderer.off("viron:immersive-navigation-action", handler);
  },
  listSshSessions: () => ipcRenderer.invoke("viron:ssh:list"),
  openSshSession: (input: unknown) => ipcRenderer.invoke("viron:ssh:open", input),
  issueSshTicket: (sessionId: string) => ipcRenderer.invoke("viron:ssh:ticket", sessionId),
  attachSshSession: (sessionId: string, ticket: string) => ipcRenderer.invoke("viron:ssh:attach", sessionId, ticket),
  detachSshSession: (sessionId: string) => ipcRenderer.invoke("viron:ssh:detach", sessionId),
  sshSessionAction: (sessionId: string, action: unknown) => ipcRenderer.invoke("viron:ssh:action", sessionId, action),
  closeSshSession: (sessionId: string) => ipcRenderer.invoke("viron:ssh:close", sessionId),
  onSshSessionEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("viron:ssh-session-event", handler);
    return () => ipcRenderer.off("viron:ssh-session-event", handler);
  },
  listSshRecordings: () => ipcRenderer.invoke("viron:ssh-recordings:list"),
  downloadSshRecording: (recordingId: string) => ipcRenderer.invoke("viron:ssh-recordings:download", recordingId),
  deleteSshRecording: (recordingId: string) => ipcRenderer.invoke("viron:ssh-recordings:delete", recordingId),
  listSftp: (input: unknown) => ipcRenderer.invoke("viron:sftp:list", input),
  sftpAction: (input: unknown) => ipcRenderer.invoke("viron:sftp:action", input),
  startSftpUpload: (input: unknown) => ipcRenderer.invoke("viron:sftp:upload-start", input),
  uploadSftpChunk: (uploadId: string, data: ArrayBuffer) => ipcRenderer.invoke("viron:sftp:upload-chunk", uploadId, data),
  completeSftpUpload: (uploadId: string) => ipcRenderer.invoke("viron:sftp:upload-complete", uploadId),
  cancelSftpUpload: (uploadId: string) => ipcRenderer.invoke("viron:sftp:upload-cancel", uploadId),
  downloadSftp: (input: unknown) => ipcRenderer.invoke("viron:sftp:download", input),
  droppedFilePath: (file: File) => webUtils.getPathForFile(file),
  startSftpDrag: (input: unknown) => ipcRenderer.invoke("viron:sftp:drag-out", input),
  listSftpTransfers: () => ipcRenderer.invoke("viron:sftp-transfers:list"),
  previewSftpTransfer: (input: unknown) => ipcRenderer.invoke("viron:sftp-transfers:preview", input),
  createSftpTransfer: (input: unknown) => ipcRenderer.invoke("viron:sftp-transfers:create", input),
  cancelSftpTransfer: (taskId: string) => ipcRenderer.invoke("viron:sftp-transfers:cancel", taskId),
  retrySftpTransfer: (input: unknown) => ipcRenderer.invoke("viron:sftp-transfers:retry", input),
  openLogStream: (input: unknown) => ipcRenderer.invoke("viron:logs:open", input),
  closeLogStream: (streamId: string) => ipcRenderer.invoke("viron:logs:close", streamId),
  onLogStreamEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("viron:log-stream-event", handler);
    return () => ipcRenderer.off("viron:log-stream-event", handler);
  },
  openServiceSocket: (path: string, params: Record<string, string>) => ipcRenderer.invoke("viron:service-socket:open", path, params),
  sendServiceSocket: (id: string, data: string | ArrayBuffer) => ipcRenderer.invoke("viron:service-socket:send", id, data),
  closeServiceSocket: (id: string) => ipcRenderer.invoke("viron:service-socket:close", id),
  onServiceSocketEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("viron:service-socket-event", handler);
    return () => ipcRenderer.off("viron:service-socket-event", handler);
  },
});
