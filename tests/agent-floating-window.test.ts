import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const floatingWindow = readFileSync(new URL("../src/client/components/AgentFloatingWindow.vue", import.meta.url), "utf8");
// contract unchanged; behavior moved from AgentFloatingWindow.vue into composables
const agentChat = readFileSync(new URL("../src/client/components/agent-floating-window/use-agent-chat.ts", import.meta.url), "utf8");
const agentSessions = readFileSync(new URL("../src/client/components/agent-floating-window/use-agent-sessions.ts", import.meta.url), "utf8");
const agentSuggestions = readFileSync(new URL("../src/client/components/agent-floating-window/use-agent-suggestions.ts", import.meta.url), "utf8");
const agentLauncherChrome = readFileSync(new URL("../src/client/components/agent-floating-window/use-agent-launcher-chrome.ts", import.meta.url), "utf8");
const quickSurface = readFileSync(new URL("../src/client/components/AgentQuickSurface.vue", import.meta.url), "utf8");
const settingsView = readFileSync(new URL("../src/client/views/SettingsView.vue", import.meta.url), "utf8");
const desktopClient = readFileSync(new URL("../src/client/desktop.ts", import.meta.url), "utf8");
const desktopPreload = readFileSync(new URL("../src/desktop/preload.cts", import.meta.url), "utf8");
const desktopMain = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopAgentIpc = readFileSync(new URL("../src/desktop/ipc/register-agent-ipc.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopExecutionIpc = readFileSync(new URL("../src/desktop/ipc/register-execution-ipc.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopStaticOverlaySmoke = readFileSync(new URL("../src/desktop/smoke/static-overlay-smoke.ts", import.meta.url), "utf8");
const desktopAgentChat = readFileSync(new URL("../src/desktop/overlays/agent-chat-window.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopExecutionRouter = readFileSync(new URL("../src/desktop/execution-router.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopWebRuntime = readFileSync(new URL("../src/desktop/web-view-runtime.ts", import.meta.url), "utf8");
const desktopSshRuntime = readFileSync(new URL("../src/desktop/ssh-runtime.ts", import.meta.url), "utf8");
const agentRuntime = readFileSync(new URL("../src/desktop/agent-runtime.ts", import.meta.url), "utf8");
const sshTerminalPane = readFileSync(new URL("../src/client/components/SshTerminalPane.vue", import.meta.url), "utf8");
const sshWorkbench = readFileSync(new URL("../src/client/components/SshWorkbench.vue", import.meta.url), "utf8");
const databaseWorkbench = readFileSync(new URL("../src/client/components/DatabaseWorkbench.vue", import.meta.url), "utf8");
// contract unchanged; database Agent providers moved from DatabaseWorkbench.vue
const databaseAgentScene = readFileSync(new URL("../src/client/components/database-workbench/use-database-agent-scene.ts", import.meta.url), "utf8");

describe("AI Agent floating window layout", () => {
  it("keeps the composer collapsed until the user opens it", () => {
    expect(floatingWindow).toContain('v-if="!composerExpanded" class="agent-composer-collapsed"');
    expect(floatingWindow).toContain("@click=\"expandComposer\"");
    expect(floatingWindow).toContain('v-else class="agent-composer"');
    expect(floatingWindow).toContain('rows="2"');
    expect(agentChat).toContain("composerExpanded.value = false;");
  });

  it("gives the conversation body the flexible panel area", () => {
    expect(floatingWindow).toContain("height: min(640px, calc(100dvh - 112px));");
    expect(floatingWindow).toContain("flex: 1 1 0;");
    expect(floatingWindow).toContain("margin-top: auto;");
    expect(floatingWindow).not.toContain("max-height: 280px;");
  });

  it("places non-specialized tool activity behind a collapsed readable disclosure", () => {
    expect(floatingWindow).toContain('<details v-if="toolActivities.length" class="agent-tool-log">');
    expect(floatingWindow).toContain("运行详情");
    expect(floatingWindow).not.toContain("JSON.stringify(value)");
  });

  it("renders assistant Markdown while keeping user messages as text", () => {
    expect(floatingWindow).toContain('v-html="renderAgentMarkdown(');
    expect(floatingWindow).toContain('v-if="message.role === \'user\'"');
  });

  it("shows a muted per-turn duration and token caption on both entry surfaces", () => {
    expect(floatingWindow).toContain("<AgentTurnStats");
    expect(agentChat).toContain('applyTurnStats(');
    expect(quickSurface).toContain("<AgentTurnStats");
    expect(quickSurface).toContain('class="agent-quick-bubble__stats"');
    expect(floatingWindow).not.toContain("JSON.stringify(message.usage");
  });

  it("removes scene cards and attachment controls from both entry surfaces", () => {
    expect(floatingWindow).not.toContain('class="agent-context-panel"');
    expect(floatingWindow).not.toContain("Paperclip");
    expect(floatingWindow).not.toContain("加入当前现场");
    expect(quickSurface).not.toContain("agent-quick-context");
    expect(quickSurface).not.toContain("Paperclip");
  });

  it("prevents conversation content from creating horizontal scrolling", () => {
    expect(floatingWindow).toContain("overflow-x: hidden;");
    expect(floatingWindow).toContain("overflow-wrap: anywhere;");
    expect(floatingWindow).toContain("white-space: pre-wrap;");
    expect(floatingWindow).toContain("table-layout: fixed;");
  });

  it("hosts Chatbox in a global overlay and reads the current scene from the main window", () => {
    const appShell = readFileSync(new URL("../src/client/components/AppShell.vue", import.meta.url), "utf8");
    expect(appShell).toContain("<AgentHostBridge v-if=\"desktop\" />");
    expect(appShell).toContain("<AgentFloatingWindow v-if=\"desktop && !agentNativeOverlayActive\" />");
    expect(agentChat).toContain("agentHostState.routePath");
    expect(agentLauncherChrome).toContain("updateDesktopAgentChatChrome");
    expect(agentLauncherChrome).toContain("setDesktopAgentChatIgnoreMouse");
    expect(agentChat).toContain('type: "scene-snapshot"');
    expect(desktopAgentChat).toContain("desktop-agent-chat.html");
    expect(desktopAgentChat).toContain("setAgentChatNativeOverlay");
    expect(readFileSync(new URL("../scripts/package-windows.mjs", import.meta.url), "utf8")).toContain("/dist/desktop-renderer/desktop-agent-chat.html");
    expect(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")).toContain("desktop-agent-chat");
  });

  it("keeps the current Chatbox exclusive to floating mode", () => {
    expect(floatingWindow).toContain("v-if=\"entryMode === 'floating'\"");
    expect(floatingWindow).toContain("v-else-if=\"entryMode === 'quick'\"");
    expect(agentChat).toContain('if (action === "app.agentQuickInput")');
    expect(agentChat).toContain('return sendMessageFor("floating")');
    expect(agentChat).toContain('return sendMessageFor("quick")');
    expect(agentSuggestions).toContain("$chat.quickExpandedBubbleId.value === $chat.quickActionBubbleId.value");
  });

  it("captures the current scene only when a message is submitted", () => {
    const openWatcher = agentChat.slice(
      agentChat.indexOf("watch($launcherChrome.open"),
      agentChat.indexOf("watch(input"),
    );
    const quickComposerToggle = agentChat.slice(
      agentChat.indexOf("async function toggleQuickComposer"),
      agentChat.indexOf("function handleAppShortcut"),
    );

    const sendHandler = agentChat.slice(
      agentChat.indexOf("async function sendMessageFor"),
      agentChat.indexOf("function sendMessage()"),
    );
    expect(openWatcher).not.toContain("captureCurrentScene");
    expect(quickComposerToggle).not.toContain("captureCurrentScene");
    expect(sendHandler).toContain("await captureCurrentScene();");
    expect(sendHandler).toContain("sceneHint:");
    expect(sendHandler).not.toContain("quickComposerVisible.value = false");
    expect(quickSurface).toContain(":disabled=\"addingContext || active || !configured\"");
  });

  it("manages historical sessions in both Chatbox modes", () => {
    expect(agentSessions).toContain("listDesktopAgentSessions");
    expect(agentSessions).toContain("createDesktopAgentSession");
    expect(agentSessions).toContain("selectDesktopAgentSession");
    expect(agentSessions).toContain("renameDesktopAgentSession");
    expect(agentSessions).toContain("deleteDesktopAgentSession");
    expect(floatingWindow).toContain('class="agent-session-history"');
    expect(quickSurface).toContain('class="agent-quick-history"');
    expect(quickSurface).toContain("recentAgentSessionItems");
    expect(quickSurface).toContain('class="agent-quick-session-chip"');
    expect(quickSurface).toContain('class="agent-quick-session-more"');
    expect(quickSurface).toContain("emit('createSession')");
    expect(quickSurface).toContain("emit('selectSession', item.id)");
    expect(quickSurface).not.toContain("agent-quick-session-title");
    expect(agentSessions).toContain("ElMessageBox.prompt");
    expect(agentSessions).toContain("ElMessageBox.confirm");
    expect(agentSessions).not.toContain("window.prompt");
    expect(agentSessions).not.toContain("window.confirm");
  });

  it("keeps the chat window and session list open after deleting a conversation", () => {
    const deleteHandler = agentSessions.slice(agentSessions.indexOf("async function deleteConversation"));
    const outsideHandler = agentLauncherChrome.slice(
      agentLauncherChrome.indexOf("function handleDocumentPointerDown"),
      agentLauncherChrome.indexOf("function startAgentLauncherChromeWatchers"),
    );
    expect(deleteHandler).toContain("const keepWindow = $launcherChrome.open.value;");
    expect(deleteHandler).toContain("const keepComposer = $chat.quickComposerVisible.value;");
    expect(deleteHandler).toContain("const keepHistory = historyOpen.value;");
    expect(deleteHandler).toContain("if (keepWindow)");
    expect(deleteHandler).toContain("$launcherChrome.open.value = true;");
    expect(deleteHandler).toContain("if (keepComposer)");
    expect(deleteHandler).toContain("$chat.quickComposerVisible.value = true;");
    expect(deleteHandler).toContain("if (keepHistory)");
    expect(deleteHandler).toContain("historyOpen.value = true;");
    expect(deleteHandler).not.toContain("historyOpen.value = false");
    expect(deleteHandler).not.toContain("$launcherChrome.open.value = false");
    expect(deleteHandler).not.toContain("$chat.quickComposerVisible.value = false");
    expect(outsideHandler).toContain("if (isDialogOverlayTarget(event.target))");
    expect(outsideHandler).toContain("if (dialogOverlayOpen())");
    expect(outsideHandler).toContain("bubbles.contains(event.target)");
    expect(outsideHandler).toContain("collapseQuickHistoryStack");
    expect(floatingWindow).toContain("onDesktopNativeViewPointerDown(handleNativeViewPointerDown)");
    expect(agentLauncherChrome.slice(
      agentLauncherChrome.indexOf("function handleNativeViewPointerDown"),
      agentLauncherChrome.indexOf("function handlePointerOutside"),
    )).toContain("collapseQuickHistoryStack");
    expect(agentLauncherChrome.slice(
      agentLauncherChrome.indexOf("function handlePointerOutside"),
      agentLauncherChrome.indexOf("function isAgentHitTarget"),
    )).toContain("collapseQuickHistoryStack");
  });

  it("starts a fresh conversation on launch and restores history only after the user switches sessions", () => {
    const selectHandler = agentSessions.slice(
      agentSessions.indexOf("async function selectConversation"),
      agentSessions.indexOf("async function renameConversation"),
    );
    const quickComposerToggle = agentChat.slice(
      agentChat.indexOf("async function toggleQuickComposer"),
      agentChat.indexOf("function handleAppShortcut"),
    );
    const openWatcher = agentChat.slice(
      agentChat.indexOf("watch($launcherChrome.open"),
      agentChat.indexOf("watch(input"),
    );
    expect(agentSessions).toContain("shouldStartFreshAgentConversation");
    expect(agentSessions).toContain("ensureLaunchConversation");
    expect(agentSessions).toContain("startFresh: true");
    expect(agentChat).toContain("latestAgentQuickBubbleId");
    expect(selectHandler).toContain("applyConversation(conversation, { restoreQuick: true })");
    expect(quickComposerToggle).toContain("await $sessions.ensureLaunchConversation()");
    expect(quickComposerToggle).not.toContain("await $sessions.loadSessions()");
    expect(openWatcher).toContain("ensureLaunchConversation");
    expect(openWatcher).not.toContain("loadSessions");
    expect(agentChat).toContain("if ($sessions.launchConversationReady && !quickBubblesHidden.value)");
    expect(agentChat).toContain("restoreQuickBubblesFromHistory(messages.value)");
    expect(quickSurface).toContain("bubble.id === latestBubbleId");
    expect(quickSurface).toContain("is-folded");
    expect(quickSurface).toContain("is-stacked-back");
    expect(quickSurface).toContain("line-height: 1.75");
    expect(quickSurface).toContain("gap: 12px");
  });

  it("stacks older quick turns like a picture-in-picture deck until the user tiles them", () => {
    expect(quickSurface).toContain('class="agent-quick-bubbles__toggle"');
    expect(quickSurface).toContain('v-if="historyTiled && bubbles.length > 1"');
    expect(quickSurface).toContain("叠起历史");
    expect(quickSurface).not.toContain("还有 {0} 轮");
    expect(quickSurface).not.toContain("平铺历史轮次");
    expect(quickSurface).toContain("emit('toggleHistoryStack')");
    expect(quickSurface).toContain("is-stacked");
    expect(quickSurface).toContain("is-tiled");
    expect(agentChat).toContain("quickHistoryTiled");
    expect(agentChat).toContain("collapseQuickHistoryStack");
    expect(agentChat).toContain("toggleQuickHistoryStack");
    expect(agentChat).toContain("if (presentation === \"quick\")");
    expect(agentChat).toContain("quickHistoryTiled.value = false;");
    expect(agentChat).toContain("if (!quickHistoryTiled.value && quickBubbleIds.value.length > 1 && messageId !== latestId)");
    expect(agentChat).toContain("quickHistoryTiled.value = true;");
    expect(agentChat).toContain("return;");
    expect(agentChat.slice(
      agentChat.indexOf("function toggleQuickBubble"),
      agentChat.indexOf("function scrollToBottom"),
    )).not.toContain("quickExpandedBubbleId.value = messageId;");
  });

  it("lets the user hide every quick reply bubble without losing the conversation", () => {
    expect(quickSurface).toContain("emit('hideBubbles')");
    expect(quickSurface).toContain("$t('隐藏回复')");
    expect(quickSurface).toContain("$t('隐藏全部回复')");
    expect(quickSurface).toContain("emit('showBubbles')");
    expect(quickSurface).toContain("bubblesHidden && canRestoreBubbles");
    expect(agentChat).toContain("quickBubblesHidden");
    expect(agentChat).toContain("displayedQuickBubbles");
    expect(agentChat).toContain("function hideQuickBubbles");
    expect(agentChat).toContain("function showQuickBubbles");
    expect(agentChat).toContain("quickBubblesHidden.value = false;");
    expect(agentChat).toContain("if (messages.value.length && !quickBubblesHidden.value)");
    expect(agentChat).toContain("restoreQuickBubblesFromHistory(messages.value)");
    expect(floatingWindow).toContain(":bubbles=\"displayedQuickBubbles\"");
    expect(floatingWindow).toContain("@hide-bubbles=\"hideQuickBubbles\"");
    expect(floatingWindow).toContain("@show-bubbles=\"showQuickBubbles\"");
  });

  it("keeps conversation history when only the workspace changes", () => {
    const workspaceWatcher = agentChat.slice(
      agentChat.indexOf("watch([() => agentHostState.workspaceType"),
      agentChat.indexOf("watch($launcherChrome.entryMode"),
    );
    expect(workspaceWatcher).toContain("stopActiveDiagnostic();");
    expect(workspaceWatcher).toContain("contextCards.value = [];");
    expect(workspaceWatcher).not.toContain("messages.value = [];");
    expect(workspaceWatcher).not.toContain("sessionItems.value = [];");
  });

  it("supports disabling every Agent entry without clearing configuration", () => {
    expect(settingsView).toContain("changeAgentEntryMode('disabled')");
    expect(settingsView).toContain("隐藏所有 Viron Agent 入口，保留配置和当前会话");
    expect(settingsView).toContain("repeat(3, minmax(0, 1fr))");
    expect(settingsView).toContain('agentEntryMode ?? "disabled"');
    expect(agentLauncherChrome).toContain('agentEntryMode ?? "disabled"');
  });

  it("lets Viron Agent settings fill the settings column", () => {
    expect(settingsView).toContain(".agent-entry-settings { width: 100%;");
    expect(settingsView).toContain(".agent-control-settings { width: 100%;");
    expect(settingsView).toContain(".settings-form.agent-settings-form { width: 100%;");
    expect(settingsView).not.toContain("width: min(720px, 100%)");
    expect(settingsView).not.toContain("width: min(561px, 100%)");
  });

  it("warns that Viron Agent is experimental and requires verification", () => {
    expect(settingsView).toContain("实验性功能 · 使用有风险");
    expect(settingsView).toContain("生成内容和操作建议可能不准确或不可靠");
    expect(settingsView).toContain("执行命令、SQL 或其他操作前自行核验");
  });

  it("uses 小 V as the user-facing assistant name", () => {
    expect(quickSurface).toContain("$t('向小 V 提问')");
    expect(quickSurface).toContain("$t('当前多步诊断结束后可继续提问')");
    expect(quickSurface).not.toContain("Viron Agent");
    expect(floatingWindow).toContain("<strong>{{ $t('小 V') }}</strong>");
    expect(floatingWindow).toContain("message.role === 'user' ? $t('你') : $t('小 V')");
    expect(floatingWindow).not.toContain("$t('助手')");
    expect(floatingWindow).toContain(':placeholder="$t(\'向小 V 提问\')"');
  });

  it("widens assistant replies and hides header model and local badges", () => {
    expect(floatingWindow).toContain("align-self: stretch;");
    expect(floatingWindow).toContain(".agent-message.is-assistant {");
    expect(floatingWindow).not.toContain("agent-window__badges");
    expect(floatingWindow).not.toContain("agent-window__model-pill");
    expect(floatingWindow).not.toContain("agent-window__local-pill");
    expect(floatingWindow).not.toContain("const modelBadge");
  });

  it("uses Viron Agent as the feature name outside Chat", () => {
    expect(agentLauncherChrome).toContain('return open.value ? tr("关闭 Viron Agent") : tr("打开 Viron Agent");');
    expect(settingsView).toContain('{ key: "ai-agent" as const, label: tr("Viron Agent"), icon: Bot }');
    expect(settingsView).toContain("Viron Agent 仍在开发中");
    expect(settingsView).not.toContain("小 V 入口");
    expect(desktopStaticOverlaySmoke).toContain('label: tr("打开 Viron Agent")');
  });

  it("provides a bottom quick composer and stacked response bubbles", () => {
    expect(quickSurface).toContain('data-agent-overlay="quick-composer"');
    expect(quickSurface).toContain('data-agent-overlay="quick-bubbles"');
    expect(quickSurface).toContain("margin-inline: auto;");
    expect(quickSurface).toContain("bottom: 24px;");
    expect(quickSurface).toContain('class="agent-quick-bubble__header"');
    expect(quickSurface).toContain("expandedBubbleId === bubble.id");
    expect(quickSurface).toContain(".agent-quick-composer::before");
    expect(quickSurface).toContain("fillSsh");
    expect(quickSurface).toContain("executeDatabase");
  });

  it("uses one inline approval surface and supports visible workbench execution", () => {
    const approvalHandler = agentSuggestions.slice(
      agentSuggestions.indexOf("async function respondVironApproval"),
    );
    expect(approvalHandler).not.toContain("ElMessageBox");
    expect(floatingWindow).not.toContain("sshApprovalCard");
    expect(floatingWindow).toContain('v-if="canFillSshSuggestion(suggestion)"');
    expect(quickSurface).toContain("suggestion.source.startsWith('desktop-ssh:')");
    expect(agentSuggestions).toContain("respondDesktopAgentApproval");
    expect(agentSuggestions).toContain("respondDesktopAgentWorkbenchExecution");
    expect(agentChat).toContain('event.type === "workbench-execution-request"');
    expect(agentChat).toContain("resourceId: snapshot.connectionId");
    expect(agentSuggestions).toContain("suggestion.approval.step");
    expect(agentSuggestions).toContain("suggestion.approval?.runId ?? suggestion.runId");
    expect(quickSurface).toContain("executeSsh");
    expect(quickSurface).toContain("cancelSsh");
    expect(quickSurface).toContain("cancelDatabase");
    expect(desktopPreload).toContain('ipcRenderer.invoke("viron:agent:approval:respond", input)');
    expect(desktopPreload).toContain('ipcRenderer.invoke("viron:agent:workbench:respond", input)');
    expect(desktopPreload).not.toContain("viron:agent:ssh-diagnostic");
    expect(desktopSshRuntime).toContain('sshCommandRiskLevel(normalizedCommand) !== "low"');
    expect(desktopExecutionIpc).toContain('agent-(?:context|diagnostics)');
    expect(agentChat).toContain("desktopAppState.value?.endpoint");
    expect(agentSuggestions).toContain("desktopAppState.value?.executionMode");
    expect(sshTerminalPane).toContain('sendTransportText(`\\x01\\x0b${command}\\r`)');
    expect(sshTerminalPane).toContain('sendTransportText("\\x03")');
    expect(sshTerminalPane).toContain("!snapshot.reliable");
    expect(sshTerminalPane).toContain("Boolean(snapshot.value)");
    expect(sshWorkbench).toContain('domain: "ssh"');
    expect(databaseAgentScene).toContain('domain: "database"');
    expect(databaseAgentScene).toContain("pendingAgentDatabaseExecutions");
  });

  it("persists policy changes before stopping sessions and settles invalid workbench responses", () => {
    const saveHandler = desktopAgentIpc.slice(
      desktopAgentIpc.indexOf('ipcMain.handle("viron:agent:settings:save"'),
      desktopAgentIpc.indexOf('ipcMain.handle("viron:agent:models:list"'),
    );
    expect(saveHandler.indexOf("desktopAgentSettingsStore.save")).toBeGreaterThanOrEqual(0);
    expect(saveHandler.indexOf("desktopAgentSettingsStore.save")).toBeLessThan(saveHandler.indexOf("desktopAgentRuntime.stopAll"));

    const workbenchHandler = desktopAgentIpc.slice(
      desktopAgentIpc.indexOf('ipcMain.handle("viron:agent:workbench:respond"'),
      desktopAgentIpc.indexOf('ipcMain.handle("viron:agent:chat:stop"'),
    );
    expect(workbenchHandler).toContain("if (requestId) settleAgentWorkbenchExecution");
    expect(workbenchHandler).toContain('if (!input.result) throw new Error(tr("Viron Agent 工作台执行结果无效"))');
  });

  it("previews Shell scripts and only fills them through terminal safe-paste mode", () => {
    expect(agentChat).toContain("agentSshScriptSuggestion(event.output)");
    expect(floatingWindow).toContain("安全填入，不执行");
    expect(agentSuggestions).toContain('type: "fill-ssh-script"');
    expect(agentSuggestions).toContain('action: "ssh_script_filled"');
    expect(quickSurface).toContain("sshScriptSuggestions");
    expect(quickSurface).toContain("fillSshScript");
    expect(agentRuntime).toContain('name: "ssh_propose_script"');
    expect(agentRuntime).toContain("Never execute it.");
    expect(sshTerminalPane).toContain("terminal?.modes.bracketedPasteMode");
    expect(sshTerminalPane).toContain("terminal.paste(script.replace");
    expect(sshTerminalPane).toContain('sendTransportText("\\x01\\x0b")');
  });

  it("uses one resumable Pi loop with a bounded 64-call safety budget", () => {
    expect(desktopExecutionRouter).toContain("currentAgentRuntimeScope()");
    expect(desktopMain).toContain("executeSshDiagnostic: async");
    expect(desktopMain).toContain("executeDatabaseRead: async");
    expect(agentChat).toContain('event.type === "run-pause"');
    expect(agentChat).toContain("agentSshDiagnosticResult(event.output)");
    expect(agentChat).toContain("agentDatabaseReadResult(event.output)");
    expect(agentRuntime).toContain("new Agent({");
    expect(agentRuntime).toContain('toolExecution: "sequential"');
    expect(agentRuntime).toContain("await this.waitForApproval");
    expect(agentRuntime).toContain("run.budget.beginStep()");
    expect(agentRuntime).toContain("AGENT_DIAGNOSTIC_MAX_STEPS");
  });

  it("uses layered liquid glass for quick input", () => {
    expect(quickSurface).toContain("--agent-quick-glass-radius: 30px;");
    expect(quickSurface).toContain("min-height: 60px;");
    expect(quickSurface).toContain('id="agent-quick-liquid-distortion"');
    expect(quickSurface).toContain("<feTurbulence");
    expect(quickSurface).toContain("<feDisplacementMap");
    expect(quickSurface).toContain('<feMorphology in="SourceAlpha" operator="erode"');
    expect(quickSurface).toContain('result="edge-alpha"');
    expect(quickSurface).toContain('scale="72"');
    expect(quickSurface).toContain('result="clear-center"');
    expect(quickSurface).toContain('result="refracted-edge"');
    expect(quickSurface).toContain("agent-quick-composer__distortion");
    expect(quickSurface).toContain("agent-quick-composer__tint");
    expect(quickSurface).toContain("agent-quick-composer__rim");
    expect(quickSurface).toContain(".agent-quick-composer__bar:focus-within");
    expect(quickSurface).toContain("@supports not ((backdrop-filter: blur(1px))");
  });

  it("keeps the bubble icon in a compact header and follows streaming output at the bottom", () => {
    expect(quickSurface).toContain('class="agent-quick-bubble__header"');
    expect(quickSurface).toContain("min-height: 40px;");
    expect(quickSurface).not.toContain("min-height: 72px;");
    expect(quickSurface).not.toContain("padding: 0 14px 14px 56px;");
    expect(quickSurface).toContain("padding: 6px 18px 10px;");
    expect(quickSurface).toContain("data-bubble-preview");
    expect(quickSurface).toContain("data-bubble-detail");
    expect(quickSurface).toContain("function followStreamingOutput");
    expect(quickSurface).toContain("function rememberFollow");
    expect(quickSurface).toContain("element.scrollTop = element.scrollHeight");
    expect(quickSurface).toContain("followOutput.get(outputFollowKey(kind, id)) ?? running");
    expect(quickSurface).not.toContain("-webkit-line-clamp: 2;");
    expect(quickSurface).toContain("max-height: 4.6em;");
  });

  it("uses the same liquid glass language for chat bubbles and session chrome", () => {
    expect(quickSurface).toContain('class="agent-quick-glass"');
    expect(quickSurface).toContain("--agent-quick-card-radius: 24px;");
    expect(quickSurface).toContain("border-radius: var(--agent-quick-card-radius);");
    expect(quickSurface).toContain(".agent-quick-session-bar");
    expect(quickSurface).toContain("--agent-quick-session-radius: 18px;");
    expect(quickSurface).toContain("border-radius: var(--agent-quick-session-radius);");
    expect(quickSurface).toContain(".agent-quick-history");
    expect(quickSurface).toContain("border-radius: 20px;");
    expect(quickSurface).toContain(".agent-quick-bubble .agent-quick-glass__tint");
    expect(quickSurface).toContain('filter: url("#agent-quick-liquid-distortion")');
    expect(quickSurface).not.toContain("background: rgba(28, 28, 30, .96);");
    expect(quickSurface).not.toContain("border-radius: 8px;");
  });

  it("renders each recent session as a separate rounded glass button", () => {
    const sessionBar = quickSurface.slice(
      quickSurface.indexOf(".agent-quick-session-bar {"),
      quickSurface.indexOf(".agent-quick-history {"),
    );
    expect(quickSurface).toContain('class="agent-quick-session-chip__label"');
    expect(sessionBar).toContain("gap: 8px;");
    expect(sessionBar).toContain("overflow: visible;");
    expect(sessionBar).toContain("border: 0;");
    expect(sessionBar).toContain(".agent-quick-session-bar button {");
    expect(sessionBar).toContain("border: 1px solid rgba(255, 255, 255, .22);");
    expect(sessionBar).not.toContain("flex: 1 1 0;");
    expect(sessionBar).not.toContain("grid-template-columns: minmax(0, 1fr) auto;");
  });

  it("sizes session chips to their titles instead of clipping the label", () => {
    const sessionBar = quickSurface.slice(
      quickSurface.indexOf(".agent-quick-session-bar {"),
      quickSurface.indexOf(".agent-quick-history {"),
    );
    expect(quickSurface).toContain("displayAgentSessionTitle(item.title)");
    expect(quickSurface).toContain(':title="item.title"');
    expect(quickSurface).toContain(':aria-label="item.title"');
    expect(sessionBar).toContain("padding: 0 18px;");
    expect(sessionBar).toContain("width: max-content;");
    expect(sessionBar).toContain("max-width: 16em;");
    expect(sessionBar).toContain("font-size: 12px;");
    expect(sessionBar).toContain("line-height: 1.2;");
    expect(sessionBar).toContain("text-overflow: ellipsis;");
    expect(sessionBar).not.toContain("font-size: 10px;");
  });

  it("shows the complete quick-input glass from the first entrance frame", () => {
    expect(quickSurface).toContain("@keyframes agent-quick-composer-in { from { transform:");
    expect(quickSurface).not.toContain("@keyframes agent-quick-composer-in { from { opacity: 0;");
    expect(quickSurface).toContain("@keyframes agent-quick-composer-out { from { opacity: 1;");
  });

  it("keeps quick input open after sending so the same session can continue", () => {
    const sendHandler = agentChat.slice(
      agentChat.indexOf("async function sendMessageFor"),
      agentChat.indexOf("function sendMessage()"),
    );
    expect(sendHandler).toContain('pendingQuickPrompt = presentation === "quick" ? content : "";');
    expect(sendHandler).not.toContain("quickComposerVisible.value = false");
    expect(floatingWindow).not.toContain(":session-title=\"currentSessionTitle\"");
  });

  it("dismisses quick input outside the glass while preserving an unsent draft", () => {
    const outsideHandler = agentLauncherChrome.slice(
      agentLauncherChrome.indexOf("function handleDocumentPointerDown"),
      agentLauncherChrome.indexOf("function handleNativeViewPointerDown"),
    );
    expect(outsideHandler).toContain("composer.contains(event.target)");
    expect(outsideHandler).toContain("quickComposerVisible.value = false;");
    expect(outsideHandler).not.toContain('input.value = ""');
    expect(quickSurface).not.toContain("agent-quick-composer__close");
    expect(quickSurface).not.toContain("shortcutLabel");
  });

  it("dismisses quick input when a native desktop page receives the click", () => {
    expect(desktopWebRuntime).toContain('nativeView.webContents.on("before-mouse-event"');
    expect(desktopWebRuntime).toContain('mouse.type !== "mouseDown"');
    expect(desktopWebRuntime).toContain('mainWindow.webContents.send("viron:native-view-pointer-down")');
    expect(desktopPreload).toContain('onNativeViewPointerDown: (listener: () => void)');
    expect(desktopClient).toContain("export function onDesktopNativeViewPointerDown");
    expect(floatingWindow).toContain("onDesktopNativeViewPointerDown(handleNativeViewPointerDown)");
  });
});
