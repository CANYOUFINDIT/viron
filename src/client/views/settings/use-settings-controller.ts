import { Bot, Cable, Database, Keyboard, KeyRound, PackageCheck, Palette, RadioTower, Settings2, UserRound } from "@lucide/vue";
import { currentLocale, language, setLanguage, translate as tr } from "../../i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../../api";
import { activeConnections } from "../../active-connections";
import {
  desktopAppState,
  desktopExecutionActivity,
  desktopExecutionTargets,
  desktopMcpStatus,
  desktopState,
  checkForDesktopUpdates,
  deleteDesktopAgentSettings,
  clearDesktopAgentAudit,
  downloadApiFile,
  getDesktopAgentSettings,
  isDesktopApp,
  listDesktopAgentModels,
  saveDesktopAgentSettings,
  setDesktopAgentEntryMode,
  setDesktopExecutionMode,
  setDesktopMcpApprovalMode,
  setDesktopMcpEnabled,
  testDesktopAgentSettings,
} from "../../desktop";
import { logout, session } from "../../session";
import { setTheme, theme } from "../../theme";
import { connectionQualityEnabled, setConnectionQualityEnabled } from "../../connection-quality-preference";
import {
  initializeAppShortcuts,
  onShortcutCaptureInput,
  saveAppShortcutOverrides,
  setShortcutCapture,
} from "../../keyboard-shortcuts";
import {
  SHORTCUT_DEFINITIONS,
  defaultShortcutBindings,
  formatShortcutBinding,
  shortcutBindingFromInput,
  shortcutConflict,
  shortcutDefaultBinding,
  shortcutOverridesFromBindings,
  shortcutValidationError,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../../../shared/keyboard-shortcuts";
import type { DesktopExecutionMode, ExecutionTarget } from "../../../shared/execution-mode";
import type { ThemeName } from "../../../shared/theme";
import type { Language } from "../../../shared/i18n";
import type { AgentApiProtocol, AgentApprovalMode, AgentEntryMode, AgentExecutionPresentation, AgentSettingsPublic } from "../../../shared/agent";
import type { DesktopMcpStatus, McpApprovalMode, ServerMcpStatus } from "../../../shared/mcp-settings";

import type { SettingsSection } from "./types";

export function useSettingsController() {
  const route = useRoute();
  const router = useRouter();
  const loading = ref(true);
  const saving = ref(false);
  const signingOut = ref(false);
  const modeSwitching = ref(false);
  const mcpLoading = ref(false);
  const mcpSwitching = ref(false);
  const updateChecking = ref(false);
  const exporting = ref(false);
  const agentSaving = ref(false);
  const agentTesting = ref(false);
  const agentDeleting = ref(false);
  const agentAuditClearing = ref(false);
  const agentEntrySwitching = ref(false);
  const agentTestMessage = ref("");
  const agentModelsLoading = ref(false);
  const agentModels = ref<string[]>([]);
  const agentModelsMessage = ref("");
  const agentModelsError = ref(false);
  const restoreFile = ref<File | null>(null);
  const restoreInput = ref<HTMLInputElement | null>(null);
  const restoreProgress = ref<number | null>(null);
  const restartRequired = ref(false);
  const passwordPanelOpen = ref(false);
  const shortcutSaving = ref(false);
  const shortcutRecording = ref<ShortcutActionId | "">("");
  const shortcutError = ref("");
  const shortcutBaseline = ref("");
  const shortcutDraft = reactive<ShortcutBindings>(defaultShortcutBindings());
  let removeShortcutCaptureListener: (() => void) | undefined;
  let agentModelsTimer: ReturnType<typeof setTimeout> | undefined;
  let agentModelsRequest = 0;
  let mcpPollTimer: ReturnType<typeof setInterval> | undefined;
  const desktop = isDesktopApp();
  const shortcutPlatform = /Macintosh|Mac OS X/.test(navigator.userAgent) ? "darwin" : "win32";
  const activeSection = ref<SettingsSection>("profile");
  const settings = reactive({ connectionIdleMinutes: 30, userConnectionLimit: 30, auditRetentionDays: 30, monitorPullIntervalSeconds: 60, databaseMode: "SQLite WAL", dataDir: "/data" });
  const agentSettings = reactive<AgentSettingsPublic>({ configured: false, endpoint: "", protocol: "openai", model: "", apiKeyStored: false, approvalMode: "always", executionPresentation: "conversation", updatedAt: null });
  const agentDraft = reactive<{
    endpoint: string;
    apiKey: string;
    protocol: AgentApiProtocol;
    model: string;
    approvalMode: AgentApprovalMode;
    executionPresentation: AgentExecutionPresentation;
  }>({ endpoint: "", apiKey: "", protocol: "openai", model: "", approvalMode: "always", executionPresentation: "conversation" });
  const password = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const migration = reactive({ exportPassword: "", exportPasswordConfirm: "", importPassword: "" });
  const serverMcp = ref<ServerMcpStatus | null>(null);
  const localMcp = ref<DesktopMcpStatus | null>(null);
  const executionMode = computed(() => desktopAppState.value?.executionMode ?? "local");
  const agentEntryMode = computed(() => desktopAppState.value?.agentEntryMode ?? "disabled");
  const agentStoredApiKeyAvailable = computed(() => agentSettings.apiKeyStored
    && agentDraft.endpoint.trim().replace(/\/+$/, "") === agentSettings.endpoint
    && agentDraft.protocol === agentSettings.protocol);
  const themeOptions: Array<{ value: ThemeName; label: string }> = [
    { value: "light", label: tr("浅色") },
    { value: "dark", label: tr("深色") },
    { value: "bright", label: tr("明亮") },
  ];
  const languageOptions: Array<{ value: Language; label: string; description: string }> = [
    { value: "zh-CN", label: tr("中文"), description: tr("简体中文界面") },
    { value: "en", label: "English", description: tr("英文界面") },
  ];

  const sections = computed(() => [
    { key: "profile" as const, label: tr("个人信息"), icon: UserRound },
    { key: "appearance" as const, label: tr("外观与语言"), icon: Palette },
    { key: "api-keys" as const, label: "API Key", icon: KeyRound },
    { key: "mcp" as const, label: "MCP", icon: RadioTower },
    ...(desktop ? [
      { key: "shortcuts" as const, label: tr("快捷键"), icon: Keyboard },
      { key: "connection" as const, label: tr("连接与执行"), icon: Cable },
      { key: "ai-agent" as const, label: tr("Viron Agent"), icon: Bot },
      { key: "client-version" as const, label: tr("客户端版本"), icon: PackageCheck },
    ] : []),
    ...(session.user?.isPlatformAdmin ? [
      { key: "runtime" as const, label: tr("运行策略"), icon: Settings2 },
      { key: "migration" as const, label: tr("数据迁移"), icon: Database },
    ] : []),
  ]);
  const serverMcpUrl = computed(() => {
    const path = serverMcp.value?.path ?? "/mcp";
    const origin = desktopAppState.value?.endpoint || window.location.origin;
    try { return new URL(path, `${origin.replace(/\/$/, "")}/`).href; }
    catch { return path; }
  });
  const codexLocalMcpApprovalMode = computed(() => localMcp.value?.approvalMode === "never"
    ? "approve"
    : localMcp.value?.approvalMode === "high-risk"
      ? "auto"
      : "prompt");
  const shortcutGroups = [
    { key: "application", label: tr("应用"), items: SHORTCUT_DEFINITIONS.filter((item) => item.group === "application" && item.settingsSection !== "ai-agent") },
    { key: "workbench", label: tr("工作台"), items: SHORTCUT_DEFINITIONS.filter((item) => item.group === "workbench" && item.settingsSection !== "ai-agent") },
  ] as const;
  const shortcutDirty = computed(() => JSON.stringify(shortcutDraft) !== shortcutBaseline.value);
  const agentShortcutDirty = computed(() => {
    const baseline = JSON.parse(shortcutBaseline.value || "{}") as Partial<ShortcutBindings>;
    return shortcutDraft["app.agentQuickInput"] !== baseline["app.agentQuickInput"];
  });

  watch(() => route.query.section, (value) => {
    if (typeof value === "string" && sections.value.some((section) => section.key === value)) activeSection.value = value as SettingsSection;
  }, { immediate: true });

  watch(activeSection, (section) => {
    const action = shortcutRecording.value;
    if (!action) return;
    const recordingSection: SettingsSection = action === "app.agentQuickInput" ? "ai-agent" : "shortcuts";
    if (section !== recordingSection) void stopShortcutRecording();
  });

  watch(activeSection, (section) => {
    if (mcpPollTimer) clearInterval(mcpPollTimer);
    mcpPollTimer = undefined;
    if (section !== "mcp") return;
    void loadMcpStatus(true);
    mcpPollTimer = setInterval(() => void loadMcpStatus(true), 3_000);
  });

  watch(
    () => [agentDraft.endpoint, agentDraft.apiKey, agentDraft.protocol] as const,
    () => {
      if (agentDraft.endpoint.trim() !== agentSettings.endpoint || agentDraft.protocol !== agentSettings.protocol || agentDraft.apiKey.trim()) {
        agentDraft.model = "";
      }
      scheduleAgentModelsLoad();
    },
  );

  function selectSection(section: SettingsSection) {
    activeSection.value = section;
    if (route.query.section !== section) void router.replace({ query: { ...route.query, section } });
  }

  function changeConnectionQualityVisibility(value: string | number | boolean): void {
    setConnectionQualityEnabled(Boolean(value));
  }

  async function chooseLanguage(value: Language) {
    if (value === language.value) return;
    await setLanguage(value);
    window.location.reload();
  }

  function formatAccountCreatedAt(value: string | undefined): string {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(currentLocale(), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function chooseTheme(value: ThemeName) {
    setTheme(value);
  }

  function closePasswordPanel() {
    passwordPanelOpen.value = false;
    Object.assign(password, { currentPassword: "", newPassword: "", confirmPassword: "" });
  }

  const targetRows = computed(() => [
    { label: tr("Web 账号"), target: desktopExecutionTargets.value.web, fallback: executionMode.value === "server" && desktopExecutionTargets.value.web === "local", planned: false },
    { label: "SSH", target: desktopExecutionTargets.value.ssh, planned: false },
    { label: "SFTP", target: desktopExecutionTargets.value.sftp, planned: false },
    { label: tr("环境日志"), target: desktopExecutionTargets.value.logs, planned: false },
    { label: tr("数据库"), target: desktopExecutionTargets.value.database, planned: false },
    { label: "Redis", target: desktopExecutionTargets.value.redis, planned: false },
    {
      label: tr("连接巡检"),
      target: desktopExecutionTargets.value.inspectionSsh === "unavailable" && desktopExecutionTargets.value.inspectionDatabase === "unavailable" && desktopExecutionTargets.value.inspectionRedis === "unavailable"
        ? "unavailable" as const
        : executionMode.value === "server" ? "server" as const : "local" as const,
      planned: false,
    },
  ]);

  function targetLabel(target: ExecutionTarget, fallback = false, planned = false): string {
    if (planned) return tr("待开放");
    if (fallback) return tr("本机直连 · 服务端不支持 Web 代理");
    if (target === "local") return tr("本机直连");
    if (target === "server") return tr("服务端转发");
    return tr("当前模式不可用");
  }

  async function load() {
    loading.value = true;
    try {
      const tasks: Promise<unknown>[] = [
        api<{ item: typeof settings }>("/api/v1/settings").then((response) => Object.assign(settings, response.item)),
        loadMcpStatus(),
      ];
      if (desktop) tasks.push(
        desktopState(),
        loadAgentSettings(),
        initializeAppShortcuts().then((bindings) => {
          Object.assign(shortcutDraft, bindings);
          shortcutBaseline.value = JSON.stringify(shortcutDraft);
        }),
      );
      await Promise.all(tasks);
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("读取设置失败"));
    } finally {
      loading.value = false;
    }
  }

  async function loadMcpStatus(silent = false) {
    if (!silent) mcpLoading.value = true;
    try {
      const [server, local] = await Promise.all([
        api<ServerMcpStatus>("/api/v1/mcp/status"),
        desktop ? desktopMcpStatus() : Promise.resolve(null),
      ]);
      serverMcp.value = server;
      localMcp.value = local;
    } catch (error) {
      if (!silent) ElMessage.error(error instanceof Error ? error.message : tr("读取 MCP 状态失败"));
    } finally {
      if (!silent) mcpLoading.value = false;
    }
  }

  function formatMcpTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(currentLocale(), {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(date);
  }

  async function changeLocalMcp(enabled: boolean) {
    if (!desktop || mcpSwitching.value || localMcp.value?.enabled === enabled) return;
    if (!enabled && localMcp.value?.clients.length) {
      try {
        await ElMessageBox.confirm(
          tr("关闭本机 MCP 会立即断开 {0} 个客户端，并取消仍在等待的本机 MCP 操作。", [localMcp.value.clients.length]),
          tr("关闭本机 MCP"),
          { type: "warning", confirmButtonText: tr("断开并关闭"), cancelButtonText: tr("取消") },
        );
      } catch { return; }
    }
    mcpSwitching.value = true;
    try {
      localMcp.value = await setDesktopMcpEnabled(enabled);
      ElMessage.success(enabled ? tr("本机 MCP 已开启") : tr("本机 MCP 已关闭"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("切换本机 MCP 失败"));
      await loadMcpStatus(true);
    } finally {
      mcpSwitching.value = false;
    }
  }

  async function changeLocalMcpApprovalMode(mode: McpApprovalMode) {
    if (!desktop || mcpSwitching.value || localMcp.value?.approvalMode === mode) return;
    if (mode === "never") {
      try {
        await ElMessageBox.confirm(
          tr("完全访问会让 Agent 在当前 Viron 用户权限内直接执行 SSH、数据库、Redis、SFTP 和 Web 风险操作。凭据输入、账号权限和秘密导出限制仍然保留。"),
          tr("开启 MCP 完全访问"),
          { type: "warning", confirmButtonText: tr("确认开启"), cancelButtonText: tr("取消") },
        );
      } catch { return; }
    }
    mcpSwitching.value = true;
    try {
      localMcp.value = await setDesktopMcpApprovalMode(mode);
      ElMessage.success(tr("本机 MCP 审批策略已更新"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("更新本机 MCP 审批策略失败"));
      await loadMcpStatus(true);
    } finally {
      mcpSwitching.value = false;
    }
  }

  function applyAgentSettings(value: AgentSettingsPublic) {
    Object.assign(agentSettings, value);
    agentDraft.endpoint = value.endpoint;
    agentDraft.protocol = value.protocol;
    agentDraft.model = value.model;
    agentDraft.approvalMode = value.approvalMode;
    agentDraft.executionPresentation = value.executionPresentation;
    agentDraft.apiKey = "";
  }

  function scheduleAgentModelsLoad() {
    if (agentModelsTimer) clearTimeout(agentModelsTimer);
    const credentialsReady = Boolean(agentDraft.endpoint.trim() && (agentDraft.apiKey.trim() || agentStoredApiKeyAvailable.value));
    if (!credentialsReady) {
      agentModels.value = [];
      agentModelsError.value = false;
      agentModelsMessage.value = agentDraft.endpoint.trim()
        ? tr("请输入 API Key 后自动获取模型列表")
        : tr("填写 Endpoint、API Key 并选择协议后自动获取模型列表");
      return;
    }
    agentModelsTimer = setTimeout(() => void loadAgentModels(), 500);
  }

  async function loadAgentModels() {
    const request = ++agentModelsRequest;
    agentModelsLoading.value = true;
    agentModelsMessage.value = tr("正在获取模型列表…");
    agentModelsError.value = false;
    try {
      const result = await listDesktopAgentModels({
        endpoint: agentDraft.endpoint,
        apiKey: agentDraft.apiKey || undefined,
        protocol: agentDraft.protocol,
      });
      if (request !== agentModelsRequest) return;
      agentModels.value = result.models;
      if (agentDraft.model && !result.models.includes(agentDraft.model)) agentDraft.model = "";
      agentModelsMessage.value = result.models.length ? tr("已获取 {0} 个模型", [result.models.length]) : tr("接口未返回可选模型");
    } catch (error) {
      if (request !== agentModelsRequest) return;
      agentModels.value = [];
      agentModelsError.value = true;
      agentModelsMessage.value = error instanceof Error ? error.message : tr("获取模型列表失败");
    } finally {
      if (request === agentModelsRequest) agentModelsLoading.value = false;
    }
  }

  async function loadAgentSettings() {
    applyAgentSettings(await getDesktopAgentSettings());
  }

  async function saveAgentSettings() {
    agentSaving.value = true;
    agentTestMessage.value = "";
    try {
      const saved = await saveDesktopAgentSettings({
        endpoint: agentDraft.endpoint,
        protocol: agentDraft.protocol,
        model: agentDraft.model,
        apiKey: agentDraft.apiKey || undefined,
        approvalMode: agentDraft.approvalMode,
        executionPresentation: agentDraft.executionPresentation,
      });
      applyAgentSettings(saved);
      ElMessage.success(tr("Viron Agent 配置已保存"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("保存 Viron Agent 配置失败"));
    } finally {
      agentSaving.value = false;
    }
  }

  async function testAgentSettings() {
    agentTesting.value = true;
    agentTestMessage.value = "";
    try {
      const result = await testDesktopAgentSettings();
      agentTestMessage.value = tr("连接成功 · {0} · {1}ms · {2}", [result.model, result.latencyMs, result.text]);
      ElMessage.success(tr("Viron Agent 模型连接正常"));
    } catch (error) {
      agentTestMessage.value = error instanceof Error ? error.message : tr("Viron Agent 模型测试失败");
      ElMessage.error(agentTestMessage.value);
    } finally {
      agentTesting.value = false;
    }
  }

  async function clearAgentSettings() {
    if (agentDeleting.value) return;
    try {
      await ElMessageBox.confirm(tr("将删除当前 Endpoint 与当前用户在本机保存的 Viron Agent 配置。"), tr("清除 Viron Agent 配置"), {
        type: "warning",
        confirmButtonText: tr("清除配置"),
        cancelButtonText: tr("取消"),
      });
    } catch {
      return;
    }
    agentDeleting.value = true;
    agentTestMessage.value = "";
    try {
      applyAgentSettings(await deleteDesktopAgentSettings());
      ElMessage.success(tr("Viron Agent 配置已清除"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("清除 Viron Agent 配置失败"));
    } finally {
      agentDeleting.value = false;
    }
  }

  async function clearAgentAudit() {
    try {
      await ElMessageBox.confirm(tr("将清除当前 Endpoint 与当前用户最近 30 天的本机 Viron Agent 操作记录。"), tr("清除 Viron Agent 操作记录"), { type: "warning", confirmButtonText: tr("清除记录"), cancelButtonText: tr("取消") });
    } catch { return; }
    agentAuditClearing.value = true;
    try {
      const result = await clearDesktopAgentAudit();
      ElMessage.success(tr("已清除 {0} 条 Viron Agent 操作记录", [result.cleared]));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("清除 Viron Agent 操作记录失败"));
    } finally { agentAuditClearing.value = false; }
  }

  function shortcutDisplay(action: ShortcutActionId): string {
    return formatShortcutBinding(shortcutDraft[action], shortcutPlatform);
  }

  async function changeAgentEntryMode(mode: AgentEntryMode) {
    if (mode === agentEntryMode.value || agentEntrySwitching.value) return;
    agentEntrySwitching.value = true;
    try {
      await setDesktopAgentEntryMode(mode);
      const label = mode === "floating" ? tr("悬浮按钮") : mode === "quick" ? tr("快捷输入") : tr("关闭");
      ElMessage.success(tr("Viron Agent 入口已切换为{0}", [label]));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("切换 Viron Agent 入口失败"));
    } finally {
      agentEntrySwitching.value = false;
    }
  }

  async function stopShortcutRecording() {
    shortcutRecording.value = "";
    try {
      await setShortcutCapture(false);
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("停止快捷键录制失败"));
    }
  }

  async function startShortcutRecording(action: ShortcutActionId) {
    shortcutError.value = "";
    shortcutRecording.value = action;
    try {
      await setShortcutCapture(true);
    } catch (error) {
      shortcutRecording.value = "";
      ElMessage.error(error instanceof Error ? error.message : tr("开始快捷键录制失败"));
    }
  }

  function handleShortcutCapture(input: import("../../../shared/keyboard-shortcuts").ShortcutInput) {
    const action = shortcutRecording.value;
    if (!action) return;
    if (input.key === "Escape") {
      void stopShortcutRecording();
      return;
    }
    if (input.key === "Backspace" || input.key === "Delete") {
      if (action === "app.agentQuickInput") {
        shortcutError.value = tr("快捷输入入口必须保留一个唤起快捷键");
        return;
      }
      shortcutDraft[action] = "";
      shortcutError.value = "";
      void stopShortcutRecording();
      return;
    }
    const binding = shortcutBindingFromInput(input, shortcutPlatform);
    if (!binding) {
      shortcutError.value = tr("请同时按下 Command、Control 或 Option；也可以使用 F1–F12");
      return;
    }
    const validation = shortcutValidationError(binding, shortcutPlatform);
    if (validation) {
      shortcutError.value = validation;
      return;
    }
    const conflict = shortcutConflict(shortcutDraft, action, binding);
    if (conflict) {
      shortcutError.value = tr("该组合已用于“{0}”", [conflict.label]);
      return;
    }
    shortcutDraft[action] = binding;
    shortcutError.value = "";
    void stopShortcutRecording();
  }

  function resetShortcut(action: ShortcutActionId) {
    shortcutDraft[action] = defaultShortcutBindings(shortcutPlatform)[action];
    shortcutError.value = "";
  }

  function clearShortcut(action: ShortcutActionId) {
    shortcutDraft[action] = "";
    shortcutError.value = "";
  }

  function resetAllShortcuts() {
    Object.assign(shortcutDraft, defaultShortcutBindings(shortcutPlatform));
    shortcutError.value = "";
  }

  function undoShortcutChanges() {
    Object.assign(shortcutDraft, JSON.parse(shortcutBaseline.value || "{}") as ShortcutBindings);
    shortcutError.value = "";
  }

  async function saveShortcuts() {
    if (!shortcutDraft["app.agentQuickInput"]) {
      ElMessage.warning(tr("请为 Viron Agent 快捷输入保留一个唤起快捷键"));
      return;
    }
    shortcutSaving.value = true;
    try {
      const bindings = await saveAppShortcutOverrides(shortcutOverridesFromBindings(shortcutDraft, shortcutPlatform));
      Object.assign(shortcutDraft, bindings);
      shortcutBaseline.value = JSON.stringify(shortcutDraft);
      ElMessage.success(tr("快捷键已保存"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("保存快捷键失败"));
    } finally {
      shortcutSaving.value = false;
    }
  }

  async function changeExecutionMode(mode: DesktopExecutionMode) {
    if (!desktop || mode === executionMode.value || modeSwitching.value) return;
    modeSwitching.value = true;
    try {
      const activity = await desktopExecutionActivity();
      if (activity.total) {
        const labels = { web: "Web", ssh: "SSH", sftp: "SFTP", logs: tr("日志"), database: tr("数据库"), redis: "Redis" } as const;
        const summary = Object.entries(activity.counts)
          .filter(([, count]) => count > 0)
          .map(([key, count]) => `${labels[key as keyof typeof labels]} ${count}`)
          .join("、");
        await ElMessageBox.confirm(
          tr("将关闭当前 App 建立的活动连接（{0}）；工作台布局与编辑内容会保留。", [summary]),
          tr("切换到{0}", [mode === "local" ? tr("本机直连") : tr("服务端转发")]),
          { type: "warning", confirmButtonText: tr("关闭连接并切换"), cancelButtonText: tr("取消") },
        );
      }
      await setDesktopExecutionMode(mode);
      ElMessage.success(tr("连接模式已切换为{0}", [mode === "local" ? tr("本机直连") : tr("服务端转发")]));
    } catch (error) {
      if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("连接模式切换失败"));
    } finally {
      modeSwitching.value = false;
    }
  }

  async function checkForUpdates() {
    if (!desktop || updateChecking.value) return;
    updateChecking.value = true;
    try {
      const result = await checkForDesktopUpdates();
      if (result === "no-update") ElMessage.success(tr("当前已经是最新版本"));
      else if (result === "installer-unavailable") ElMessage.warning(tr("发现更高版本，但当前平台没有可用安装包"));
      else if (result === "development") ElMessage.info(tr("开发模式不提供客户端更新检测"));
      else if (result === "busy") ElMessage.info(tr("正在检查或安装更新，请稍候"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("检测更新失败"));
    } finally {
      updateChecking.value = false;
    }
  }

  async function saveSettings() {
    saving.value = true;
    try {
      await api("/api/v1/settings", {
        method: "PUT",
        body: JSON.stringify({
          auditRetentionDays: settings.auditRetentionDays,
          monitorPullIntervalSeconds: settings.monitorPullIntervalSeconds,
        }),
      });
      ElMessage.success(tr("运行策略已保存"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("保存运行策略失败"));
    } finally {
      saving.value = false;
    }
  }

  async function changePassword() {
    if (!password.newPassword) return ElMessage.warning(tr("新密码不能为空"));
    if (password.newPassword !== password.confirmPassword) return ElMessage.warning(tr("两次输入的新密码不一致"));
    saving.value = true;
    try {
      await api("/api/v1/auth/password", { method: "PUT", body: JSON.stringify({ currentPassword: password.currentPassword, newPassword: password.newPassword }) });
      closePasswordPanel();
      ElMessage.success(tr("密码已修改，其他登录会话已失效"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("修改密码失败"));
    } finally {
      saving.value = false;
    }
  }

  async function signOut() {
    if (signingOut.value) return;
    signingOut.value = true;
    try {
      if (activeConnections.current > 0) {
        await ElMessageBox.confirm(
          tr("当前还有 {0} 个活动连接。退出登录会关闭这些连接，是否继续？", [activeConnections.current]),
          tr("退出登录"),
          { type: "warning", confirmButtonText: tr("关闭连接并退出"), cancelButtonText: tr("取消") },
        );
      }
      const result = await logout();
      if (result === "logged-out") await router.replace({ name: "login" });
    } catch (error) {
      if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : tr("退出登录失败"));
    } finally {
      signingOut.value = false;
    }
  }

  async function exportPlatform() {
    if (migration.exportPassword.length < 12) return ElMessage.warning(tr("迁移密码至少需要 12 个字符"));
    if (migration.exportPassword !== migration.exportPasswordConfirm) return ElMessage.warning(tr("两次输入的迁移密码不一致"));
    exporting.value = true;
    try {
      const response = await api<{ downloadUrl: string }>("/api/v1/platform-exports", { method: "POST", body: JSON.stringify({ password: migration.exportPassword }) });
      const saved = await downloadApiFile(response.downloadUrl);
      if (saved) {
        Object.assign(migration, { exportPassword: "", exportPasswordConfirm: "" });
        ElMessage.success(tr("密码保护的平台迁移包已生成并保存"));
      }
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("导出平台迁移包失败"));
    } finally {
      exporting.value = false;
    }
  }

  function selectRestoreFile(event: Event) {
    restoreFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  }

  async function restorePlatform() {
    if (!restoreFile.value) return ElMessage.warning(tr("请选择 Viron 平台迁移 ZIP"));
    try {
      await ElMessageBox.confirm(tr("导入会在 Viron 下次启动时替换当前平台数据、终端录像和数据库备份。系统会先保留一份恢复前数据库。"), tr("暂存跨实例迁移"), { confirmButtonText: tr("确认暂存"), cancelButtonText: tr("取消"), type: "warning" });
    } catch {
      return;
    }
    const formData = new FormData();
    formData.append("password", migration.importPassword);
    formData.append("file", restoreFile.value);
    if (desktop) {
      restoreProgress.value = 0;
      try {
        const body = await api<{ restartRequired?: boolean }>("/api/v1/platform-restore", { method: "POST", body: formData });
        restartRequired.value = Boolean(body.restartRequired);
        restoreFile.value = null;
        migration.importPassword = "";
        ElMessage.success(tr("迁移包已校验并暂存，请重启 Viron 服务完成导入"));
      } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : tr("平台恢复失败"));
      } finally {
        restoreProgress.value = null;
      }
      return;
    }
    restoreProgress.value = 0;
    const request = new XMLHttpRequest();
    request.open("POST", "/api/v1/platform-restore");
    request.setRequestHeader("Accept-Language", currentLocale());
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) restoreProgress.value = Math.round(event.loaded / event.total * 100);
    });
    request.addEventListener("load", () => {
      restoreProgress.value = null;
      const body = JSON.parse(request.responseText || "{}") as { message?: string; restartRequired?: boolean };
      if (request.status >= 200 && request.status < 300) {
        restartRequired.value = Boolean(body.restartRequired);
        restoreFile.value = null;
        migration.importPassword = "";
        ElMessage.success(tr("迁移包已校验并暂存，请重启 Viron 服务完成导入"));
      } else ElMessage.error(body.message ?? tr("上传迁移包失败"));
    });
    request.addEventListener("error", () => { restoreProgress.value = null; ElMessage.error(tr("上传迁移包失败")); });
    request.send(formData);
  }

  onMounted(() => {
    removeShortcutCaptureListener = onShortcutCaptureInput(handleShortcutCapture);
    void load();
  });
  onBeforeUnmount(() => {
    if (agentModelsTimer) clearTimeout(agentModelsTimer);
    if (mcpPollTimer) clearInterval(mcpPollTimer);
    agentModelsRequest += 1;
    removeShortcutCaptureListener?.();
    void setShortcutCapture(false);
  });

  return {
    activeSection, agentAuditClearing, agentDeleting, agentDraft, agentEntryMode, agentEntrySwitching,
    agentModels, agentModelsError, agentModelsLoading, agentModelsMessage, agentSaving, agentSettings,
    agentShortcutDirty, agentStoredApiKeyAvailable, agentTestMessage, agentTesting, changeAgentEntryMode,
    changeConnectionQualityVisibility, changeExecutionMode, changeLocalMcp, changeLocalMcpApprovalMode,
    changePassword, checkForUpdates, chooseLanguage, chooseTheme, clearAgentAudit, clearAgentSettings,
    clearShortcut, closePasswordPanel, codexLocalMcpApprovalMode, connectionQualityEnabled, desktop,
    desktopAppState, defaultShortcutBindings, executionMode, exportPlatform, exporting,
    formatAccountCreatedAt, formatMcpTime, language, languageOptions, loadAgentModels, loading, localMcp,
    mcpLoading, mcpSwitching, migration, modeSwitching, password, passwordPanelOpen, resetAllShortcuts,
    resetShortcut, restartRequired, restoreFile, restoreInput, restorePlatform, restoreProgress,
    saveAgentSettings, saveSettings, saveShortcuts, saving, sections, selectRestoreFile, selectSection,
    serverMcp, serverMcpUrl, session, settings, shortcutDirty, shortcutDefaultBinding, shortcutDisplay,
    shortcutDraft, shortcutError, shortcutGroups, shortcutPlatform, shortcutRecording, shortcutSaving,
    signOut, signingOut, startShortcutRecording, targetLabel, targetRows, testAgentSettings, theme,
    themeOptions, undoShortcutChanges, updateChecking,
  };
}
