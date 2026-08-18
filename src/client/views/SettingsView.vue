<script setup lang="ts">import { currentLocale, language, setLanguage, translate as tr } from "../i18n";

import {
  Activity,
  AlertTriangle,
  ArchiveRestore,
  Bot,
  Cable,
  CalendarDays,
  ChevronDown,
  Database,
  Download,
  Fingerprint,
  KeyRound,
  Keyboard,
  Laptop,
  Languages,
  LogOut,
  MessageSquareText,
  PackageCheck,
  Palette,
  Power,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { activeConnections } from "../active-connections";
import PageHeader from "../components/PageHeader.vue";
import TipIcon from "../components/TipIcon.vue";
import ApiKeySettings from "../components/ApiKeySettings.vue";
import McpApprovalModeSelector from "../components/McpApprovalModeSelector.vue";
import AgentApprovalModeSelector from "../components/AgentApprovalModeSelector.vue";
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
} from "../desktop";
import { logout, session } from "../session";
import { setTheme, theme } from "../theme";
import { connectionQualityEnabled, setConnectionQualityEnabled } from "../connection-quality-preference";
import {
  initializeAppShortcuts,
  onShortcutCaptureInput,
  saveAppShortcutOverrides,
  setShortcutCapture,
} from "../keyboard-shortcuts";
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
} from "../../shared/keyboard-shortcuts";
import type { DesktopExecutionMode, ExecutionTarget } from "../../shared/execution-mode";
import type { ThemeName } from "../../shared/theme";
import type { Language } from "../../shared/i18n";
import type { AgentApiProtocol, AgentApprovalMode, AgentEntryMode, AgentExecutionPresentation, AgentSettingsPublic } from "../../shared/agent";
import type { DesktopMcpStatus, McpApprovalMode, ServerMcpStatus } from "../../shared/mcp-settings";

type SettingsSection = "profile" | "appearance" | "api-keys" | "mcp" | "shortcuts" | "connection" | "ai-agent" | "client-version" | "runtime" | "migration";

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

function handleShortcutCapture(input: import("../../shared/keyboard-shortcuts").ShortcutInput) {
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
</script>

<template>
  <div class="settings-view" v-loading="loading">
    <PageHeader :title="$t('设置')" />
    <div v-if="restartRequired" class="restart-banner"><ArchiveRestore :size="18" /><strong>{{ $t('跨实例迁移已暂存') }}</strong><TipIcon :content="$t('重启 Viron 服务后会应用迁移包；当前服务在重启前仍使用原数据。')" placement="right" /></div>

    <section class="settings-console">
      <nav class="settings-sections" :aria-label="$t('设置分类')">
        <button v-for="item in sections" :key="item.key" type="button" :class="{ 'is-active': activeSection === item.key }" @click="selectSection(item.key)">
          <span><component :is="item.icon" :size="17" /></span>
          <strong>{{ item.label }}</strong>
        </button>
      </nav>

      <div class="settings-detail">
        <section v-if="activeSection === 'profile'" class="settings-section-panel settings-section-panel--profile">
          <header><span><UserRound :size="20" /></span><h3>{{ $t('个人信息') }}</h3></header>
          <div class="profile-summary">
            <span class="profile-avatar">{{ session.user?.username.slice(0, 1).toUpperCase() }}</span>
            <div class="profile-identity"><strong>{{ session.user?.username }}</strong><em>{{ session.user?.isPlatformAdmin ? $t('平台管理员') : $t('普通用户') }}</em></div>
            <dl>
              <div><dt><UserRound :size="14" />{{ $t('用户名') }}</dt><dd>{{ session.user?.username }}</dd></div>
              <div><dt><ShieldCheck :size="14" />{{ $t('平台角色') }}</dt><dd>{{ session.user?.isPlatformAdmin ? $t('平台管理员') : $t('普通用户') }}</dd></div>
              <div><dt><Fingerprint :size="14" />{{ $t('账号 ID') }}</dt><dd :title="session.user?.id"><code>{{ session.user?.id }}</code></dd></div>
              <div><dt><CalendarDays :size="14" />{{ $t('注册时间') }}</dt><dd>{{ formatAccountCreatedAt(session.user?.createdAt) }}</dd></div>
            </dl>
          </div>
          <div class="profile-action-bar">
            <div class="profile-password-trigger">
              <el-button :class="{ 'is-expanded': passwordPanelOpen }" @click="passwordPanelOpen = !passwordPanelOpen"><KeyRound :size="16" />{{ $t('修改密码') }}<ChevronDown :size="15" /></el-button>
              <TipIcon :content="$t('密码修改成功后，其他登录会话会立即失效。')" placement="right" />
            </div>
            <el-button type="danger" plain :loading="signingOut" @click="signOut"><LogOut :size="15" />{{ $t('退出登录') }}</el-button>
          </div>
          <Transition name="settings-expand">
            <section v-if="passwordPanelOpen" class="profile-password-panel">
              <el-form label-position="top" class="settings-form profile-password-form">
                <el-form-item :label="$t('当前密码')"><el-input v-model="password.currentPassword" type="password" autocomplete="current-password" show-password /></el-form-item>
                <el-form-item :label="$t('新密码')"><el-input v-model="password.newPassword" type="password" autocomplete="new-password" show-password /></el-form-item>
                <el-form-item :label="$t('确认新密码')"><el-input v-model="password.confirmPassword" type="password" autocomplete="new-password" show-password /></el-form-item>
              </el-form>
              <footer><el-button @click="closePasswordPanel">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="changePassword"><ShieldCheck :size="15" />{{ $t('保存密码') }}</el-button></footer>
            </section>
          </Transition>
        </section>

        <section v-else-if="activeSection === 'appearance'" class="settings-section-panel">
          <header><span><Palette :size="20" /></span><h3>{{ $t('外观与语言') }}</h3><TipIcon :content="$t('外观与语言保存在当前客户端中，同一客户端上的不同登录账号共用选择。')" placement="right" /></header>
          <div class="settings-field-heading appearance-heading"><strong>{{ $t('界面语言') }}</strong><span>{{ $t('切换后自动刷新界面') }}</span></div>
          <div class="language-choice-grid" role="radiogroup" :aria-label="$t('界面语言')">
            <button v-for="option in languageOptions" :key="option.value" type="button" role="radio" :aria-checked="language === option.value" :class="['language-choice', { 'is-active': language === option.value }]" @click="chooseLanguage(option.value)">
              <Languages :size="18" />
              <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
              <i>{{ language === option.value ? $t('当前使用') : $t('选择') }}</i>
            </button>
          </div>
          <div class="settings-field-heading appearance-heading theme-heading"><strong>{{ $t('主题样式') }}</strong></div>
          <div class="theme-choice-grid" role="radiogroup" :aria-label="$t('主题样式')">
            <button v-for="option in themeOptions" :key="option.value" type="button" role="radio" :aria-label="$t('切换到{0}主题', [option.label])" :aria-checked="theme === option.value" :class="['theme-choice', `is-${option.value}`, { 'is-active': theme === option.value }]" @click="chooseTheme(option.value)">
              <span class="theme-preview" aria-hidden="true"><i></i><b></b><em></em><small></small></span>
              <span class="theme-choice__copy"><strong>{{ option.label }}</strong></span>
              <i class="theme-choice__state">{{ theme === option.value ? $t('当前使用') : $t('选择') }}</i>
            </button>
          </div>
          <div class="settings-field-heading appearance-heading connection-quality-heading"><strong>{{ $t('连接质量悬浮面板') }}</strong><span>{{ $t('保存在当前设备') }}</span></div>
          <div class="connection-quality-preference">
            <span><Activity :size="19" /></span>
            <div><strong>{{ $t('显示连接质量') }}</strong><small>{{ $t('悬浮显示本机到 Viron、Viron 到活动目标的延迟与真实业务吞吐') }}</small></div>
            <el-switch :model-value="connectionQualityEnabled" :aria-label="$t('显示连接质量悬浮面板')" @change="changeConnectionQualityVisibility" />
          </div>
        </section>

        <section v-else-if="activeSection === 'api-keys'" class="settings-section-panel">
          <ApiKeySettings :is-platform-admin="Boolean(session.user?.isPlatformAdmin)" />
        </section>

        <section v-else-if="activeSection === 'mcp'" class="settings-section-panel settings-section-panel--mcp" v-loading="mcpLoading">
          <header><span><RadioTower :size="20" /></span><div><p>MODEL CONTEXT PROTOCOL</p><h3>{{ $t('MCP 服务') }}</h3><small>{{ $t('服务端 MCP 与桌面本机 MCP 相互独立；关闭其中一个不会影响另一个。') }}</small></div></header>

          <section class="mcp-service-card" :class="serverMcp?.enabled ? 'is-running' : 'is-stopped'">
            <header>
              <span><Server :size="20" /></span>
              <div><strong>{{ $t('服务端 MCP') }}</strong><small>{{ $t('由 Viron 服务配置统一控制') }}</small></div>
              <em><i></i>{{ serverMcp?.enabled ? $t('已启用') : $t('未启用') }}</em>
            </header>
            <template v-if="serverMcp?.enabled">
              <dl class="mcp-connection-grid">
                <div><dt>{{ $t('连接地址') }}</dt><dd><code>{{ serverMcpUrl }}</code></dd></div>
                <div><dt>{{ $t('传输协议') }}</dt><dd>Streamable HTTP</dd></div>
                <div><dt>{{ $t('认证方式') }}</dt><dd>{{ $t('个人 API Key') }}</dd></div>
                <div><dt>{{ $t('能力规模') }}</dt><dd>{{ serverMcp.toolCount }} {{ $t('个工具') }} · {{ serverMcp.businessOperationCount }} {{ $t('个业务操作') }}</dd></div>
              </dl>
              <div class="mcp-clients-heading"><strong>{{ $t('当前账号的客户端') }}</strong><span>{{ serverMcp.sessions.length }}</span></div>
              <div v-if="serverMcp.sessions.length" class="mcp-client-list">
                <article v-for="client in serverMcp.sessions" :key="client.id"><span><i></i></span><div><strong>{{ client.clientName }}</strong><small>{{ client.clientVersion || $t('版本未知') }}</small></div><time>{{ formatMcpTime(client.lastActivityAt) }}</time></article>
              </div>
              <p v-else class="mcp-empty">{{ $t('当前账号没有远程 MCP 客户端连接') }}</p>
              <div class="mcp-remote-policy-note"><ShieldCheck :size="15" /><span>{{ $t('远程 MCP 的 Viron 审批策略按个人 API Key 保存，可在“API Key”中为每个 Codex 连接独立设置。') }}</span><el-button text type="primary" @click="selectSection('api-keys')">{{ $t('管理 API Key') }}</el-button></div>
            </template>
            <p v-else class="mcp-disabled-note"><ShieldCheck :size="17" />{{ $t('管理员未在服务配置中启用 VIRON_MCP_ENABLED；远程 /mcp 不对外监听。') }}</p>
          </section>

          <section v-if="desktop && localMcp" class="mcp-service-card is-local" :class="localMcp.running ? 'is-running' : 'is-stopped'">
            <header>
              <span><Laptop :size="20" /></span>
              <div><strong>{{ $t('本机 MCP') }}</strong><small>{{ $t('只服务当前设备，并复用 App 的登录状态与执行模式') }}</small></div>
              <el-button :type="localMcp.enabled ? 'danger' : 'primary'" plain :loading="mcpSwitching" @click="changeLocalMcp(!localMcp.enabled)"><Power :size="14" />{{ localMcp.enabled ? $t('关闭') : $t('开启') }}</el-button>
            </header>
            <dl class="mcp-connection-grid">
              <div><dt>{{ $t('运行状态') }}</dt><dd><span class="mcp-state-dot" :class="{ 'is-on': localMcp.running }"></span>{{ localMcp.running ? $t('Broker 运行中') : $t('Broker 已停止') }}</dd></div>
              <div><dt>{{ $t('传输协议') }}</dt><dd>{{ localMcp.transport === 'unix' ? 'Unix Domain Socket' : 'Windows Named Pipe' }}</dd></div>
              <div class="is-wide"><dt>{{ $t('STDIO 启动器') }}</dt><dd><code>{{ localMcp.launcherPath }}</code></dd></div>
              <div v-if="localMcp.address" class="is-wide"><dt>{{ $t('Broker 地址') }}</dt><dd><code>{{ localMcp.address }}</code></dd></div>
            </dl>
            <div class="mcp-approval-block">
              <div class="mcp-approval-heading"><div><strong>{{ $t('本机 MCP 审批策略') }}</strong><small>{{ $t('只控制 Viron 是否要求二次确认；不会扩大当前用户、工作空间或连接权限。') }}</small></div><code>{{ localMcp.approvalMode }}</code></div>
              <McpApprovalModeSelector :model-value="localMcp.approvalMode" :disabled="mcpSwitching" @update:model-value="changeLocalMcpApprovalMode" />
              <p><span>{{ $t('Codex 客户端还有独立审批层。要与当前策略一致，请在该 MCP Server 配置中设置：') }}</span><code>default_tools_approval_mode = "{{ codexLocalMcpApprovalMode }}"</code></p>
            </div>
            <p v-if="localMcp.lastError" class="mcp-local-error"><AlertTriangle :size="16" />{{ localMcp.lastError }}</p>
            <div class="mcp-clients-heading"><strong>{{ $t('本机客户端') }}</strong><span>{{ localMcp.clients.length }}</span></div>
            <div v-if="localMcp.clients.length" class="mcp-client-list">
              <article v-for="client in localMcp.clients" :key="client.id"><span><i></i></span><div><strong>{{ client.clientName }}</strong><small>{{ client.clientVersion || $t('版本未知') }} · {{ $t('连接于') }} {{ formatMcpTime(client.connectedAt) }}</small></div><time>{{ formatMcpTime(client.lastActivityAt) }}</time></article>
            </div>
            <p v-else class="mcp-empty">{{ localMcp.running ? $t('等待本机 MCP 客户端连接') : $t('开启后，Codex 等客户端才能通过本机 STDIO 连接') }}</p>
          </section>
        </section>

        <section v-else-if="activeSection === 'shortcuts' && desktop" class="settings-section-panel settings-section-panel--shortcuts">
          <header><span><Keyboard :size="20" /></span><h3>{{ $t('快捷键') }}</h3><TipIcon :content="$t('快捷键保存在当前设备。Command+Shift+W 固定用于关闭窗口；系统与文本编辑保留组合不能覆盖。')" placement="right" /></header>
          <div class="shortcut-settings-toolbar">
            <span :class="{ 'is-dirty': shortcutDirty }">{{ shortcutDirty ? $t('未保存') : $t('已保存') }}</span>
            <el-button :disabled="shortcutRecording !== ''" @click="resetAllShortcuts"><RotateCcw :size="14" />{{ $t('恢复全部默认') }}</el-button>
          </div>
          <div class="shortcut-groups">
            <section v-for="group in shortcutGroups" :key="group.key" class="shortcut-group">
              <header><strong>{{ group.label }}</strong></header>
              <div v-for="definition in group.items" :key="definition.id" class="shortcut-row" :class="{ 'is-recording': shortcutRecording === definition.id }">
                <span class="shortcut-row__label"><strong>{{ $t(definition.label) }}</strong></span>
                <button class="shortcut-recorder" type="button" :aria-pressed="shortcutRecording === definition.id" @click="startShortcutRecording(definition.id)">
                  <Keyboard :size="14" /><kbd>{{ shortcutRecording === definition.id ? $t('请按下快捷键') : shortcutDisplay(definition.id) }}</kbd>
                </button>
                <button class="shortcut-icon-action" type="button" :disabled="shortcutDraft[definition.id] === shortcutDefaultBinding(definition, shortcutPlatform)" :aria-label="$t('恢复{0}默认快捷键', [$t(definition.label)])" :title="$t('恢复默认')" @click="resetShortcut(definition.id)"><RotateCcw :size="14" /></button>
                <button class="shortcut-icon-action" type="button" :disabled="!shortcutDraft[definition.id]" :aria-label="$t('清除{0}快捷键', [$t(definition.label)])" :title="$t('清除快捷键')" @click="clearShortcut(definition.id)"><X :size="14" /></button>
              </div>
            </section>
          </div>
          <p v-if="shortcutError" class="shortcut-error" role="alert">{{ shortcutError }}</p>
          <footer><el-button :disabled="!shortcutDirty" @click="undoShortcutChanges">{{ $t('撤销更改') }}</el-button><el-button type="primary" :loading="shortcutSaving" :disabled="!shortcutDirty || Boolean(shortcutRecording)" @click="saveShortcuts"><Save :size="15" />{{ $t('保存快捷键') }}</el-button></footer>
        </section>

        <section v-else-if="activeSection === 'connection' && desktop" class="settings-section-panel">
          <header><span><Cable :size="20" /></span><h3>{{ $t('连接与执行') }}</h3><TipIcon :content="$t('设置按当前设备与 Endpoint 保存；切换模式会安全释放当前 App 的活动连接。')" placement="right" /></header>
          <div class="execution-mode-block">
            <div class="settings-field-heading"><strong>{{ $t('连接模式') }}</strong></div>
            <div class="execution-mode-switch" role="radiogroup" :aria-label="$t('连接模式')" :aria-busy="modeSwitching">
              <button type="button" role="radio" :aria-checked="executionMode === 'local'" :class="{ 'is-active': executionMode === 'local' }" :disabled="modeSwitching" @click="changeExecutionMode('local')"><Laptop :size="18" /><strong>{{ $t('本机直连') }}</strong></button>
              <button type="button" role="radio" :aria-checked="executionMode === 'server'" :class="{ 'is-active': executionMode === 'server' }" :disabled="modeSwitching" @click="changeExecutionMode('server')"><Server :size="18" /><strong>{{ $t('服务端转发') }}</strong></button>
            </div>
          </div>
          <div class="execution-targets">
            <div class="settings-field-heading"><strong>{{ $t('实际执行位置') }}</strong><span>{{ desktopAppState?.endpoint || $t('尚未选择 Endpoint') }}</span></div>
            <div class="execution-target-list">
              <article v-for="row in targetRows" :key="row.label" :class="[`is-${row.target}`, { 'is-planned': row.planned }]"><span><i></i><strong>{{ row.label }}</strong></span><em>{{ targetLabel(row.target, row.fallback, row.planned) }}</em></article>
            </div>
          </div>
        </section>

        <section v-else-if="activeSection === 'ai-agent' && desktop" class="settings-section-panel settings-section-panel--agent">
          <header><span><Bot :size="20" /></span><h3>{{ $t('Viron Agent') }}</h3><TipIcon :content="$t('Viron Agent 配置只保存在当前 App 本机；API Key 不上传远端 Viron 服务，也不会在保存后回显。')" placement="right" /></header>
          <aside class="agent-experimental-notice" role="note" aria-labelledby="agent-experimental-heading">
            <span><AlertTriangle :size="18" /></span>
            <div>
              <strong id="agent-experimental-heading">{{ $t('实验性功能 · 使用有风险') }}</strong>
              <p>{{ $t('Viron Agent 仍在开发中，生成内容和操作建议可能不准确或不可靠。请谨慎使用，并在执行命令、SQL 或其他操作前自行核验。') }}</p>
            </div>
          </aside>
          <div class="agent-status-card" :class="{ 'is-configured': agentSettings.configured }">
            <span><Bot :size="22" /></span>
            <div>
              <strong>{{ agentSettings.configured ? $t('已配置本机模型') : $t('尚未配置模型') }}</strong>
              <small>{{ agentSettings.configured ? `${agentSettings.model} · ${agentSettings.protocol === 'anthropic' ? 'Anthropic API' : 'OpenAI API'} · ${agentSettings.endpoint}` : $t('配置模型后即可使用所选 Viron Agent 入口') }}</small>
            </div>
            <em>{{ agentSettings.apiKeyStored ? $t('API Key 已加密保存') : $t('未保存 API Key') }}</em>
          </div>

          <section class="agent-entry-settings" aria-labelledby="agent-entry-heading">
            <div class="settings-field-heading"><strong id="agent-entry-heading">{{ $t('Viron Agent 入口') }}</strong><span>{{ $t('保存在当前设备') }}</span></div>
            <div class="agent-entry-options" role="radiogroup" :aria-label="$t('Viron Agent 入口')" :aria-busy="agentEntrySwitching">
              <button type="button" role="radio" :aria-checked="agentEntryMode === 'floating'" :class="{ 'is-active': agentEntryMode === 'floating' }" :disabled="agentEntrySwitching" @click="changeAgentEntryMode('floating')">
                <Bot :size="18" />
                <span><strong>{{ $t('悬浮按钮') }}</strong><small>{{ $t('保留当前可拖动按钮和完整 Chatbox') }}</small></span>
              </button>
              <button type="button" role="radio" :aria-checked="agentEntryMode === 'quick'" :class="{ 'is-active': agentEntryMode === 'quick' }" :disabled="agentEntrySwitching" @click="changeAgentEntryMode('quick')">
                <MessageSquareText :size="18" />
                <span><strong>{{ $t('快捷输入') }}</strong><small>{{ $t('快捷键唤起底部输入条，回复显示为右下角气泡') }}</small></span>
              </button>
              <button type="button" role="radio" :aria-checked="agentEntryMode === 'disabled'" :class="{ 'is-active': agentEntryMode === 'disabled' }" :disabled="agentEntrySwitching" @click="changeAgentEntryMode('disabled')">
                <Power :size="18" />
                <span><strong>{{ $t('关闭') }}</strong><small>{{ $t('隐藏所有 Viron Agent 入口，保留配置和当前会话') }}</small></span>
              </button>
            </div>
            <Transition name="settings-expand">
              <div v-if="agentEntryMode === 'quick'" class="agent-entry-shortcut">
                <span><strong>{{ $t('唤起快捷键') }}</strong><small>{{ shortcutPlatform === 'darwin' ? $t('默认 Option + Space') : $t('默认 Ctrl + Shift + A') }}</small></span>
                <button class="shortcut-recorder" type="button" :aria-pressed="shortcutRecording === 'app.agentQuickInput'" @click="startShortcutRecording('app.agentQuickInput')">
                  <Keyboard :size="14" /><kbd>{{ shortcutRecording === 'app.agentQuickInput' ? $t('请按下快捷键') : shortcutDisplay('app.agentQuickInput') }}</kbd>
                </button>
                <button class="shortcut-icon-action" type="button" :disabled="shortcutDraft['app.agentQuickInput'] === defaultShortcutBindings(shortcutPlatform)['app.agentQuickInput']" :aria-label="$t('恢复 Viron Agent 默认快捷键')" :title="$t('恢复默认')" @click="resetShortcut('app.agentQuickInput')"><RotateCcw :size="14" /></button>
                <el-button type="primary" :loading="shortcutSaving" :disabled="!agentShortcutDirty || Boolean(shortcutRecording)" @click="saveShortcuts"><Save :size="14" />{{ $t('保存快捷键') }}</el-button>
              </div>
            </Transition>
            <p v-if="activeSection === 'ai-agent' && shortcutError" class="shortcut-error" role="alert">{{ shortcutError }}</p>
          </section>

          <section class="agent-control-settings" aria-labelledby="agent-approval-heading">
            <div class="settings-field-heading"><strong id="agent-approval-heading">{{ $t('审批策略') }}</strong><span>{{ $t('统一控制所有 Agent 环境功能') }}</span></div>
            <AgentApprovalModeSelector v-model="agentDraft.approvalMode" :disabled="agentSaving" />
            <p>{{ $t('策略适用于 SSH、数据库、Redis、知识库和服务维护。它不会扩大当前用户权限，也不会放开尚未实现或未启用的工具。') }}</p>
          </section>

          <section class="agent-control-settings" aria-labelledby="agent-presentation-heading">
            <div class="settings-field-heading"><strong id="agent-presentation-heading">{{ $t('执行位置') }}</strong><span>{{ $t('审批策略与显示位置相互独立') }}</span></div>
            <div class="agent-presentation-options" role="radiogroup" :aria-label="$t('Viron Agent 执行位置')">
              <button type="button" role="radio" :aria-checked="agentDraft.executionPresentation === 'conversation'" :class="{ 'is-active': agentDraft.executionPresentation === 'conversation' }" @click="agentDraft.executionPresentation = 'conversation'">
                <MessageSquareText :size="18" /><span><strong>{{ $t('在对话中显示') }}</strong><small>{{ $t('通过 Viron 受控后台通道执行，结果显示在 Agent 卡片中') }}</small></span>
              </button>
              <button type="button" role="radio" :aria-checked="agentDraft.executionPresentation === 'workbench'" :class="{ 'is-active': agentDraft.executionPresentation === 'workbench' }" @click="agentDraft.executionPresentation = 'workbench'">
                <Activity :size="18" /><span><strong>{{ $t('直接操作工作台') }}</strong><small>{{ $t('命令、SQL 和结果在绑定的 SSH 终端或数据库工作台中可见') }}</small></span>
              </button>
            </div>
            <div class="agent-domain-status">
              <span><strong>SSH</strong><em>{{ $t('已支持') }}</em></span>
              <span><strong>{{ $t('数据库') }}</strong><em>{{ $t('已支持') }}</em></span>
              <span><strong>Redis</strong><em>{{ $t('待安全工具接入') }}</em></span>
              <span><strong>{{ $t('知识库') }}</strong><em>{{ $t('待安全工具接入') }}</em></span>
              <span><strong>{{ $t('服务维护') }}</strong><em>{{ $t('待安全工具接入') }}</em></span>
            </div>
          </section>

          <el-form label-position="top" class="settings-form agent-settings-form">
            <el-form-item :label="$t('协议类型')">
              <el-radio-group v-model="agentDraft.protocol">
                <el-radio-button value="openai">OpenAI API</el-radio-button>
                <el-radio-button value="anthropic">Anthropic API</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="Endpoint">
              <el-input v-model="agentDraft.endpoint" :placeholder="$t('例如 https://api.example.com/v1 或 http://localhost:11434/v1')" autocomplete="off" />
            </el-form-item>
            <el-form-item label="API Key">
              <el-input v-model="agentDraft.apiKey" type="password" show-password :placeholder="agentSettings.apiKeyStored ? $t('已保存 API Key，留空继续使用') : $t('请输入模型服务 API Key')" autocomplete="new-password" />
            </el-form-item>
            <el-form-item :label="$t('模型')" class="agent-model-field">
              <el-select v-model="agentDraft.model" filterable :loading="agentModelsLoading" :disabled="agentModelsLoading || !agentModels.length" :placeholder="$t('请从自动获取的模型列表中选择')">
                <el-option v-for="model in agentModels" :key="model" :label="model" :value="model" />
              </el-select>
              <el-button circle :loading="agentModelsLoading" :disabled="!agentDraft.endpoint.trim() || (!agentDraft.apiKey.trim() && !agentStoredApiKeyAvailable)" :aria-label="$t('重新获取模型列表')" @click="loadAgentModels"><RefreshCw v-if="!agentModelsLoading" :size="15" /></el-button>
            </el-form-item>
            <p class="agent-models-message" :class="{ 'is-error': agentModelsError }">{{ agentModelsMessage }}</p>
          </el-form>

          <p v-if="agentTestMessage" class="agent-test-message" :class="{ 'is-success': agentTestMessage.startsWith($t('连接成功')) }">{{ agentTestMessage }}</p>
          <footer>
            <el-button :loading="agentAuditClearing" @click="clearAgentAudit"><Trash2 :size="15" />{{ $t('清除操作记录') }}</el-button>
            <el-button :loading="agentDeleting" :disabled="!agentSettings.configured" @click="clearAgentSettings"><Trash2 :size="15" />{{ $t('清除配置') }}</el-button>
            <el-button :loading="agentTesting" :disabled="!agentSettings.configured || agentSaving" @click="testAgentSettings"><RefreshCw :size="15" />{{ $t('测试连接') }}</el-button>
            <el-button type="primary" :loading="agentSaving" :disabled="!agentDraft.model" @click="saveAgentSettings"><Save :size="15" />{{ $t('保存配置') }}</el-button>
          </footer>
        </section>

        <section v-else-if="activeSection === 'client-version' && desktop" class="settings-section-panel">
          <header><span><PackageCheck :size="20" /></span><h3>{{ $t('客户端版本') }}</h3><TipIcon :content="$t('通过当前 Endpoint 检测适用于本机的软件更新。')" placement="right" /></header>
          <div class="client-version-card" :aria-busy="updateChecking">
            <span class="client-version-card__icon"><Laptop :size="26" /></span>
            <div class="client-version-card__copy"><strong>Viron <em>{{ desktopAppState?.appVersion || '—' }}</em></strong><p>{{ $t('更新来源：') }}{{ desktopAppState?.endpoint || $t('尚未选择 Endpoint') }}</p></div>
            <el-button type="primary" :loading="updateChecking" @click="checkForUpdates"><RefreshCw v-if="!updateChecking" :size="15" />{{ updateChecking ? $t('正在检测…') : $t('检测更新') }}</el-button>
            <span v-if="updateChecking" class="client-version-card__progress" aria-hidden="true"><i></i></span>
          </div>
        </section>

        <section v-else-if="activeSection === 'runtime' && session.user?.isPlatformAdmin" class="settings-section-panel">
          <header><span><Settings2 :size="20" /></span><h3>{{ $t('运行策略') }}</h3><TipIcon :content="$t('连接超时与单用户额度由服务环境变量控制；监控采集频率保存后无需重启即可生效。')" placement="right" /></header>
          <el-form label-position="top" class="settings-form settings-form--compact">
            <el-form-item :label="$t('连接空闲断开')"><el-input-number :model-value="settings.connectionIdleMinutes" disabled /><em>{{ $t('分钟 · CONNECTION_IDLE_MINUTES') }}</em></el-form-item>
            <el-form-item :label="$t('单用户最大连接数')"><el-input-number :model-value="settings.userConnectionLimit" disabled /><em>{{ $t('个 · USER_CONNECTION_LIMIT') }}</em></el-form-item>
            <el-form-item :label="$t('宿主机监控采集频率')"><el-input-number v-model="settings.monitorPullIntervalSeconds" :min="10" :max="3600" :step="10" /><em>{{ $t('秒 · 10–3600') }}</em></el-form-item>
            <el-form-item :label="$t('操作审计、终端录像与 SQL 历史保留')"><el-input-number v-model="settings.auditRetentionDays" :min="1" :max="3650" /><em>{{ $t('天') }}</em></el-form-item>
          </el-form>
          <footer><el-button type="primary" :loading="saving" @click="saveSettings"><Save :size="15" />{{ $t('保存策略') }}</el-button></footer>
        </section>

        <section v-else-if="activeSection === 'migration' && session.user?.isPlatformAdmin" class="settings-section-panel">
          <header><span><Database :size="20" /></span><h3>{{ $t('数据迁移') }}</h3><code class="settings-section-meta">{{ settings.databaseMode }} · {{ settings.dataDir }}</code></header>
          <div class="migration-groups">
            <article><Download :size="22" /><div><header><strong>{{ $t('导出迁移包') }}</strong><TipIcon :content="$t('迁移包包含平台快照、终端录像和数据库备份；来源主密钥仅以迁移密码加密后的形式写入。')" placement="right" /></header><el-input v-model="migration.exportPassword" type="password" show-password :placeholder="$t('设置迁移密码（至少 12 个字符）')" /><el-input v-model="migration.exportPasswordConfirm" type="password" show-password :placeholder="$t('再次输入迁移密码')" /><el-button :loading="exporting" @click="exportPlatform"><Download :size="15" />{{ $t('生成并下载') }}</el-button></div></article>
            <article><Upload :size="22" /><div><header><strong>{{ $t('导入迁移包') }}</strong><TipIcon :content="$t('凭据会使用当前实例主密钥重新加密；迁移密码和来源明文密钥不会落盘。')" placement="right" /></header><el-input v-model="migration.importPassword" type="password" show-password :placeholder="$t('输入迁移密码（旧版同密钥备份可留空）')" /><button class="restore-file" @click="restoreInput?.click()"><Upload :size="15" />{{ restoreFile?.name || $t('选择平台迁移 ZIP') }}</button><input ref="restoreInput" hidden type="file" accept=".zip" @change="selectRestoreFile" /><el-progress v-if="restoreProgress !== null" :percentage="restoreProgress" /><el-button type="danger" plain :disabled="!restoreFile" @click="restorePlatform">{{ $t('校验并暂存导入') }}</el-button></div></article>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-heading h2 { margin-bottom: 4px; }
.settings-heading p:last-child { margin: 0; color: var(--ink-400); font-size: 13px; }
.settings-console { min-height: 590px; border: 1px solid var(--ink-100); border-radius: 14px; background: color-mix(in srgb, var(--surface) 96%, transparent); box-shadow: var(--shadow-sm); display: grid; grid-template-columns: 230px minmax(0, 1fr); overflow: hidden; }
.settings-sections { padding: 14px; border-right: 1px solid var(--ink-100); background: color-mix(in srgb, var(--paper) 88%, var(--surface)); display: flex; flex-direction: column; gap: 6px; }
.settings-sections button { width: 100%; min-height: 62px; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--ink-500); display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 9px; text-align: left; cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease, transform .15s ease; }
.settings-sections button:hover { background: var(--surface); color: var(--ink-700); transform: translateX(1px); }
.settings-sections button.is-active { border-color: color-mix(in srgb, var(--teal-500) 30%, var(--ink-100)); background: var(--teal-50); color: var(--teal-700); box-shadow: inset 3px 0 var(--teal-500); }
.settings-sections button > span { width: 34px; height: 34px; border-radius: 8px; background: color-mix(in srgb, currentColor 9%, transparent); display: grid; place-items: center; }
.settings-sections strong, .settings-sections small { display: block; }
.settings-sections strong { font-size: 13px; }
.settings-sections small { margin-top: 3px; color: var(--ink-400); font-size: 11px; line-height: 1.35; }
.settings-detail { min-width: 0; padding: 28px 30px 32px; }
.settings-section-panel { width: min(760px, 100%); min-height: 510px; display: flex; flex-direction: column; }
.settings-section-panel > header { padding-bottom: 20px; border-bottom: 1px solid var(--ink-100); display: flex; align-items: flex-start; gap: 12px; }
.settings-section-panel > header > span { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 11px 11px 11px 4px; background: var(--teal-50); color: var(--teal-600); display: grid; place-items: center; }
.settings-section-panel > header p { margin: 1px 0 3px; color: var(--teal-600); font-family: var(--font-mono); font-size: 10px; font-weight: 800; letter-spacing: .12em; }
.settings-section-panel > header h3 { margin: 0; color: var(--ink-800); font-size: 20px; }
.settings-section-panel > header small { display: block; margin-top: 5px; color: var(--ink-400); font-size: 12px; line-height: 1.55; }
.profile-summary { margin-top: 22px; padding: 17px; border: 1px solid var(--ink-100); border-radius: 12px; background: linear-gradient(135deg, var(--surface), color-mix(in srgb, var(--teal-50) 36%, var(--surface))); display: grid; grid-template-columns: 58px minmax(150px, .7fr) minmax(300px, 1.3fr); align-items: center; gap: 16px; }
.profile-avatar { width: 58px; height: 58px; border-radius: 16px 16px 16px 6px; background: var(--teal-600); color: white; box-shadow: 0 10px 24px color-mix(in srgb, var(--teal-600) 22%, transparent); display: grid; place-items: center; font-family: var(--font-display); font-size: 25px; font-weight: 800; }
.profile-identity { min-width: 0; }
.profile-identity small, .profile-identity strong, .profile-identity em { display: block; }
.profile-identity small { color: var(--teal-600); font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: .12em; }
.profile-identity strong { margin-top: 4px; overflow: hidden; color: var(--ink-900); font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
.profile-identity em { width: max-content; margin-top: 6px; padding: 3px 7px; border-radius: 999px; background: var(--teal-50); color: var(--teal-700); font-size: 10px; font-style: normal; font-weight: 700; }
.profile-summary dl { min-width: 0; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 11px 18px; }
.profile-summary dl > div { min-width: 0; }
.profile-summary dt { color: var(--ink-400); display: flex; align-items: center; gap: 5px; font-size: 10px; }
.profile-summary dd { min-width: 0; margin: 4px 0 0; overflow: hidden; color: var(--ink-700); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.profile-summary dd code { font-family: var(--font-mono); font-size: 10px; }
.profile-actions-grid { margin-top: 14px; display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(220px, .55fr); gap: 12px; }
.profile-action-card { min-width: 0; padding: 16px; border: 1px solid var(--ink-100); border-radius: 11px; background: var(--surface); display: flex; flex-direction: column; }
.profile-action-card > header { display: flex; align-items: center; gap: 9px; }
.profile-action-card > header > span { width: 34px; height: 34px; border-radius: 8px 8px 8px 3px; background: var(--teal-50); color: var(--teal-600); display: grid; place-items: center; }
.profile-action-card > header strong, .profile-action-card > header small { display: block; }
.profile-action-card > header strong { color: var(--ink-800); font-size: 13px; }
.profile-action-card > header small { margin-top: 3px; color: var(--ink-400); font-size: 10px; }
.profile-password-form { width: 100%; margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.profile-password-form :deep(.el-form-item:first-child) { grid-column: 1 / -1; }
.profile-action-card > footer { margin-top: auto; padding-top: 3px; display: flex; justify-content: flex-end; }
.profile-signout-card { border-color: color-mix(in srgb, var(--red-600) 18%, var(--ink-100)); background: color-mix(in srgb, var(--red-100) 28%, var(--surface)); }
.profile-signout-card > header > span { background: var(--red-100); color: var(--red-600); }
.profile-signout-card > p { margin: 18px 0; color: var(--ink-500); font-size: 11px; line-height: 1.65; }
.theme-choice-grid { margin-top: 24px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.appearance-heading { margin-top: 24px; }
.theme-heading { margin-bottom: -12px; }
.language-choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.language-choice { min-width: 0; min-height: 74px; padding: 13px 14px; border: 1px solid var(--ink-100); border-radius: 11px; background: var(--surface); color: var(--ink-500); display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 10px; text-align: left; cursor: pointer; transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
.language-choice:hover { border-color: var(--ink-300); transform: translateY(-1px); }
.language-choice.is-active { border-color: var(--teal-500); color: var(--teal-600); box-shadow: 0 0 0 2px color-mix(in srgb, var(--teal-500) 12%, transparent); }
.language-choice span, .language-choice strong, .language-choice small { min-width: 0; display: block; }
.language-choice strong { color: var(--ink-800); font-size: 13px; }
.language-choice small { margin-top: 4px; color: var(--ink-400); font-size: 10px; }
.language-choice i { color: var(--ink-400); font-size: 9px; font-style: normal; font-weight: 700; }
.language-choice.is-active i { color: var(--teal-600); }
.theme-choice { min-width: 0; padding: 9px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface); color: var(--ink-700); cursor: pointer; text-align: left; transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
.theme-choice:hover { border-color: var(--ink-300); transform: translateY(-2px); }
.theme-choice.is-active { border-color: var(--teal-500); box-shadow: 0 0 0 2px color-mix(in srgb, var(--teal-500) 12%, transparent), var(--shadow-sm); }
.theme-preview { height: 112px; overflow: hidden; border: 1px solid #dfe5e5; border-radius: 8px; background: #f4f7f6; display: grid; grid-template-columns: 24% 1fr; grid-template-rows: 24px 1fr; gap: 1px; }
.theme-preview i { grid-row: 1 / -1; background: #102024; }
.theme-preview b { background: #fff; }
.theme-preview em { margin: 9px; border-radius: 5px; background: #fff; box-shadow: inset 0 0 0 1px #e3e9e8; }
.theme-preview small { display: none; }
.theme-choice.is-light .theme-preview em { background: #101c1f; box-shadow: inset 0 0 0 1px #283a3d; }
.theme-choice.is-dark .theme-preview { border-color: #344744; background: #0e1719; }
.theme-choice.is-dark .theme-preview i { background: #091416; }
.theme-choice.is-dark .theme-preview b { background: #152124; }
.theme-choice.is-dark .theme-preview em { background: #111d20; box-shadow: inset 0 0 0 1px #2c403d; }
.theme-choice.is-bright .theme-preview { background: #edf1f1; }
.theme-choice.is-bright .theme-preview i { background: #102024; }
.theme-choice.is-bright .theme-preview b { background: #fff; }
.theme-choice.is-bright .theme-preview em { position: relative; background: #fbfcfd; box-shadow: inset 0 0 0 1px #d8e0e1; }
.theme-choice.is-bright .theme-preview em::before { content: "$_"; position: absolute; top: 9px; left: 10px; color: #176f60; font-family: var(--font-mono); font-size: 11px; font-style: normal; font-weight: 800; }
.theme-choice__copy { min-height: 58px; padding: 10px 4px 4px; display: block; }
.theme-choice__copy strong, .theme-choice__copy small { display: block; }
.theme-choice__copy strong { color: var(--ink-800); font-size: 13px; }
.theme-choice__copy small { margin-top: 5px; color: var(--ink-400); font-size: 10px; line-height: 1.5; }
.theme-choice > .theme-choice__state { padding: 0 4px 3px; color: var(--ink-400); display: block; font-size: 9px; font-style: normal; font-weight: 700; text-align: right; }
.theme-choice.is-active > .theme-choice__state { color: var(--teal-600); }
.connection-quality-heading { margin-bottom: 10px; }
.connection-quality-preference { min-height: 72px; padding: 13px 15px; border: 1px solid var(--ink-100); border-radius: 11px; background: var(--surface); display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 11px; }
.connection-quality-preference > span { width: 36px; height: 36px; border-radius: 9px 9px 9px 3px; background: var(--teal-50); color: var(--teal-600); display: grid; place-items: center; }
.connection-quality-preference strong, .connection-quality-preference small { display: block; }
.connection-quality-preference strong { color: var(--ink-800); font-size: 12px; }
.connection-quality-preference small { margin-top: 4px; color: var(--ink-400); font-size: 10px; line-height: 1.5; }
.bright-theme-note { margin-top: 16px; padding: 13px 15px; border: 1px solid var(--teal-100); border-radius: 10px; background: var(--teal-50); color: var(--teal-700); display: flex; align-items: flex-start; gap: 10px; }
.bright-theme-note svg { flex: 0 0 auto; margin-top: 1px; }
.bright-theme-note strong { font-size: 12px; }
.bright-theme-note p { margin: 4px 0 0; color: var(--ink-500); font-size: 11px; line-height: 1.6; }
.execution-mode-block, .execution-targets { margin-top: 24px; }
.settings-field-heading { margin-bottom: 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.settings-field-heading strong { color: var(--ink-700); font-size: 13px; }
.settings-field-heading span { color: var(--ink-400); font-size: 11px; }
.execution-mode-switch { width: 100%; padding: 3px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--ink-50); display: grid; grid-template-columns: 1fr 1fr; gap: 3px; }
.execution-mode-switch button { min-height: 58px; padding: 8px 12px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ink-400); display: flex; align-items: center; gap: 10px; text-align: left; cursor: pointer; transition: background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .16s ease; }
.execution-mode-switch button:hover:not(:disabled) { color: var(--ink-700); transform: translateY(-1px); }
.execution-mode-switch button.is-active { border-color: color-mix(in srgb, var(--teal-500) 32%, var(--ink-100)); background: var(--surface); color: var(--teal-700); box-shadow: 0 4px 14px rgba(15, 68, 58, .09); }
.execution-mode-switch button > svg { flex: 0 0 auto; }
.execution-mode-switch button strong, .execution-mode-switch button small { display: block; }
.execution-mode-switch button strong { font-size: 13px; }
.execution-mode-switch button small { margin-top: 2px; color: var(--ink-400); font-size: 11px; }
.execution-target-list { border: 1px solid var(--ink-100); border-radius: 10px; overflow: hidden; }
.execution-target-list article { min-height: 43px; padding: 0 13px; border-bottom: 1px solid var(--ink-100); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.execution-target-list article:last-child { border-bottom: 0; }
.execution-target-list article > span { display: flex; align-items: center; gap: 9px; }
.execution-target-list i { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-300); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ink-300) 13%, transparent); }
.execution-target-list strong { color: var(--ink-600); font-size: 12px; }
.execution-target-list em { color: var(--ink-400); font-size: 11px; font-style: normal; text-align: right; }
.execution-target-list .is-local i { background: var(--teal-500); }
.execution-target-list .is-server i { background: #4f8fc2; box-shadow: 0 0 0 4px rgba(79,143,194,.12); }
.execution-target-list .is-unavailable i { background: var(--red-500); box-shadow: 0 0 0 4px color-mix(in srgb, var(--red-500) 12%, transparent); }
.execution-target-list .is-unavailable em { color: var(--red-600); }
.execution-target-list .is-planned i { background: var(--amber-600); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber-600) 12%, transparent); }
.execution-target-list .is-planned em { color: var(--amber-600); }
.settings-section-panel--mcp { width: min(820px, 100%); }
.mcp-service-card { margin-top: 18px; padding: 17px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-whisper); }
.mcp-service-card > header { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.mcp-service-card > header > span { width: 40px; height: 40px; border-radius: 10px 10px 10px 4px; background: var(--ink-50); color: var(--ink-500); display: grid; place-items: center; }
.mcp-service-card.is-running > header > span { background: var(--teal-50); color: var(--teal-700); }
.mcp-service-card > header strong, .mcp-service-card > header small { display: block; }
.mcp-service-card > header strong { color: var(--ink-800); font-size: 14px; }
.mcp-service-card > header small { margin-top: 3px; color: var(--ink-400); font-size: 10px; }
.mcp-service-card > header > em { padding: 5px 8px; border-radius: 999px; background: var(--ink-50); color: var(--ink-500); font-size: 10px; font-style: normal; font-weight: 750; }
.mcp-service-card > header > em i { width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--ink-300); display: inline-block; }
.mcp-service-card.is-running > header > em { background: var(--teal-50); color: var(--teal-700); }
.mcp-service-card.is-running > header > em i { background: var(--teal-500); box-shadow: 0 0 0 4px color-mix(in srgb, var(--teal-500) 12%, transparent); }
.mcp-connection-grid { margin: 15px 0 0; padding: 13px; border: 1px solid var(--ink-100); border-radius: 9px; background: var(--ink-50); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
.mcp-connection-grid > div { min-width: 0; }
.mcp-connection-grid > .is-wide { grid-column: 1 / -1; }
.mcp-connection-grid dt { color: var(--ink-400); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.mcp-connection-grid dd { min-width: 0; margin: 4px 0 0; overflow: hidden; color: var(--ink-700); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.mcp-connection-grid code { font-family: var(--font-mono); font-size: 10px; }
.mcp-state-dot { width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: var(--ink-300); display: inline-block; }
.mcp-state-dot.is-on { background: var(--teal-500); }
.mcp-clients-heading { margin-top: 14px; display: flex; align-items: center; justify-content: space-between; }
.mcp-clients-heading strong { color: var(--ink-600); font-size: 11px; }
.mcp-clients-heading span { min-width: 22px; padding: 2px 6px; border-radius: 999px; background: var(--ink-50); color: var(--ink-500); font-family: var(--font-mono); font-size: 9px; text-align: center; }
.mcp-client-list { margin-top: 7px; border: 1px solid var(--ink-100); border-radius: 9px; overflow: hidden; }
.mcp-client-list article { min-height: 48px; padding: 7px 11px; border-bottom: 1px solid var(--ink-100); display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.mcp-client-list article:last-child { border-bottom: 0; }
.mcp-client-list article > span i { width: 7px; height: 7px; border-radius: 50%; background: var(--teal-500); box-shadow: 0 0 0 4px color-mix(in srgb, var(--teal-500) 12%, transparent); display: block; }
.mcp-client-list strong, .mcp-client-list small { display: block; }
.mcp-client-list strong { color: var(--ink-700); font-size: 11px; }
.mcp-client-list small { margin-top: 2px; color: var(--ink-400); font-size: 9px; }
.mcp-client-list time { color: var(--ink-400); font-family: var(--font-mono); font-size: 9px; }
.mcp-empty, .mcp-disabled-note, .mcp-local-error { margin: 10px 0 0; padding: 11px 12px; border-radius: 8px; font-size: 10px; line-height: 1.55; }
.mcp-empty { background: var(--ink-50); color: var(--ink-400); text-align: center; }
.mcp-disabled-note { border: 1px solid var(--ink-100); background: var(--ink-50); color: var(--ink-500); display: flex; align-items: center; gap: 8px; }
.mcp-local-error { background: var(--red-100); color: var(--red-600); display: flex; align-items: flex-start; gap: 8px; }
.mcp-approval-block { margin-top: 14px; padding: 13px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--ink-50); }
.mcp-approval-heading { margin-bottom: 10px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.mcp-approval-heading strong, .mcp-approval-heading small { display: block; }
.mcp-approval-heading strong { color: var(--ink-700); font-size: 11px; }
.mcp-approval-heading small { margin-top: 3px; color: var(--ink-400); font-size: 9px; line-height: 1.5; }
.mcp-approval-heading code { flex: none; padding: 3px 6px; border-radius: 5px; background: var(--surface); color: var(--teal-700); font-family: var(--font-mono); font-size: 9px; }
.mcp-approval-block > p { margin: 10px 0 0; color: var(--ink-400); font-size: 9px; line-height: 1.55; }
.mcp-approval-block > p span, .mcp-approval-block > p code { display: block; }
.mcp-approval-block > p code { width: fit-content; margin-top: 4px; padding: 4px 6px; border-radius: 5px; background: var(--surface); color: var(--ink-600); font-family: var(--font-mono); }
.mcp-remote-policy-note { margin-top: 12px; padding: 9px 11px; border-radius: 8px; background: var(--ink-50); color: var(--ink-500); display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: 9px; line-height: 1.5; }
.agent-experimental-notice { margin-top: 20px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--amber-600) 30%, var(--ink-100)); border-radius: 10px; background: color-mix(in srgb, var(--amber-100) 58%, var(--surface)); color: var(--amber-600); display: flex; align-items: flex-start; gap: 10px; }
.agent-experimental-notice > span { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; background: color-mix(in srgb, var(--amber-600) 12%, transparent); display: grid; place-items: center; }
.agent-experimental-notice > div { min-width: 0; }
.agent-experimental-notice strong { display: block; color: color-mix(in srgb, var(--amber-600) 78%, var(--ink-800)); font-size: 12px; }
.agent-experimental-notice p { margin: 4px 0 0; color: var(--ink-500); font-size: 11px; line-height: 1.55; }
.agent-status-card { margin-top: 12px; padding: 16px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--ink-50); display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: center; gap: 13px; }
.agent-status-card > span { width: 42px; height: 42px; border-radius: 10px; background: var(--surface); color: var(--ink-500); display: grid; place-items: center; }
.agent-status-card.is-configured > span { background: var(--teal-50); color: var(--teal-700); }
.agent-status-card strong, .agent-status-card small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-status-card strong { color: var(--ink-800); font-size: 13px; }
.agent-status-card small { margin-top: 3px; color: var(--ink-400); font-size: 11px; }
.agent-status-card em { color: var(--ink-400); font-size: 11px; font-style: normal; text-align: right; }
.agent-status-card.is-configured em { color: var(--teal-700); }
.agent-entry-settings { width: 100%; margin-top: 20px; }
.agent-control-settings { width: 100%; margin-top: 20px; }
.agent-control-settings > p { margin: 9px 0 0; color: var(--ink-400); font-size: 10px; line-height: 1.55; }
.agent-presentation-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.agent-presentation-options > button { min-height: 66px; padding: 11px 12px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); color: var(--ink-500); display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 10px; text-align: left; cursor: pointer; }
.agent-presentation-options > button:hover { border-color: var(--ink-200); background: var(--ink-50); }
.agent-presentation-options > button.is-active { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); background: var(--teal-50); color: var(--teal-700); box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal-500) 8%, transparent); }
.agent-presentation-options span, .agent-presentation-options strong, .agent-presentation-options small { min-width: 0; display: block; }
.agent-presentation-options strong { color: var(--ink-700); font-size: 12px; }
.agent-presentation-options small { margin-top: 3px; color: var(--ink-400); font-size: 10px; line-height: 1.45; }
.agent-domain-status { margin-top: 9px; display: flex; flex-wrap: wrap; gap: 6px; }
.agent-domain-status > span { min-height: 25px; padding: 0 8px; border: 1px solid var(--ink-100); border-radius: 6px; background: var(--ink-50); display: inline-flex; align-items: center; gap: 6px; }
.agent-domain-status strong { color: var(--ink-600); font-size: 10px; }
.agent-domain-status em { color: var(--ink-400); font-size: 9px; font-style: normal; }
.agent-entry-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.agent-entry-options > button {
  min-width: 0;
  min-height: 66px;
  padding: 10px 12px;
  border: 1px solid var(--ink-100);
  border-radius: 7px;
  background: var(--ink-50);
  color: var(--ink-500);
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
  transition: border-color .16s ease, background-color .16s ease, color .16s ease, transform .16s ease;
}
.agent-entry-options > button:hover:not(:disabled) { border-color: var(--ink-200); color: var(--ink-700); transform: translateY(-1px); }
.agent-entry-options > button:active:not(:disabled) { transform: translateY(0); }
.agent-entry-options > button.is-active { border-color: color-mix(in srgb, var(--teal-500) 38%, var(--ink-100)); background: var(--surface); color: var(--teal-700); box-shadow: inset 3px 0 var(--teal-500); }
.agent-entry-options > button:disabled { opacity: .56; cursor: wait; }
.agent-entry-options > button > svg { justify-self: center; }
.agent-entry-options > button span,
.agent-entry-options > button strong,
.agent-entry-options > button small { min-width: 0; display: block; }
.agent-entry-options > button strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.agent-entry-options > button small { margin-top: 3px; color: var(--ink-400); font-size: 10px; line-height: 1.4; }
.agent-entry-shortcut {
  min-height: 48px;
  margin-top: 10px;
  padding: 8px 9px 8px 12px;
  border: 1px solid var(--ink-100);
  border-radius: 7px;
  background: var(--surface);
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(150px, 210px) 32px auto;
  align-items: center;
  gap: 8px;
}
.agent-entry-shortcut > span { min-width: 0; }
.agent-entry-shortcut > span strong,
.agent-entry-shortcut > span small { display: block; }
.agent-entry-shortcut > span strong { color: var(--ink-600); font-size: 11px; }
.agent-entry-shortcut > span small { margin-top: 2px; color: var(--ink-400); font-size: 10px; }
.settings-form.agent-settings-form { width: 100%; }
.agent-settings-form :deep(.el-select) { flex: 1; min-width: 0; }
.agent-model-field :deep(.el-select) { flex: 1; min-width: 0; width: auto; }
.agent-model-field :deep(.el-button) { flex: none; }
.agent-models-message { margin: -8px 0 16px; color: var(--ink-400); font-size: 12px; }
.agent-models-message.is-error { color: var(--red-600); }
.agent-test-message { margin: 2px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--red-100); color: var(--red-600); font-size: 12px; line-height: 1.5; }
.agent-test-message.is-success { background: var(--teal-50); color: var(--teal-700); }
.settings-section-panel--agent > footer { gap: 8px; }
.client-version-card { position: relative; margin-top: 24px; padding: 22px; overflow: hidden; border: 1px solid var(--ink-100); border-radius: 12px; background: linear-gradient(135deg, var(--ink-50), color-mix(in srgb, var(--teal-50) 38%, var(--surface))); display: grid; grid-template-columns: 54px minmax(0, 1fr) auto; align-items: center; gap: 16px; }
.client-version-card__icon { width: 54px; height: 54px; border: 1px solid color-mix(in srgb, var(--teal-500) 22%, var(--ink-100)); border-radius: 14px 14px 14px 5px; background: var(--surface); color: var(--teal-600); box-shadow: 0 8px 22px rgba(15, 68, 58, .08); display: grid; place-items: center; }
.client-version-card__copy { min-width: 0; }
.client-version-card__copy small, .client-version-card__copy strong { display: block; }
.client-version-card__copy small { color: var(--teal-600); font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: .14em; }
.client-version-card__copy strong { margin-top: 4px; color: var(--ink-800); font-size: 17px; }
.client-version-card__copy em { margin-left: 4px; color: var(--teal-700); font-family: var(--font-mono); font-style: normal; }
.client-version-card__copy p { margin: 5px 0 0; overflow: hidden; color: var(--ink-400); font-size: 11px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.client-version-card__progress { position: absolute; right: 0; bottom: 0; left: 0; height: 3px; overflow: hidden; background: color-mix(in srgb, var(--teal-500) 12%, transparent); }
.client-version-card__progress i { position: absolute; top: 0; bottom: 0; width: 36%; border-radius: 999px; background: linear-gradient(90deg, transparent, var(--teal-500), var(--teal-400), transparent); animation: client-version-progress 1.15s ease-in-out infinite; }
@keyframes client-version-progress {
  from { transform: translateX(-110%); }
  to { transform: translateX(310%); }
}
@media (prefers-reduced-motion: reduce) {
  .client-version-card__progress i { width: 100%; animation: none; }
}
.settings-form { width: min(520px, 100%); margin-top: 24px; }
.settings-form--compact { width: min(430px, 100%); }
.settings-form :deep(.el-form-item) { margin-bottom: 18px; }
.settings-form :deep(.el-form-item__content) { display: flex; align-items: center; gap: 9px; }
.settings-form em { color: var(--ink-400); font-size: 12px; font-style: normal; }
.settings-section-panel > footer { margin-top: auto; padding-top: 18px; border-top: 1px solid var(--ink-100); display: flex; justify-content: flex-end; }
.migration-groups { margin-top: 24px; display: grid; gap: 12px; }
.migration-groups > article { padding: 16px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--ink-50); color: var(--teal-600); display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; }
.migration-groups strong { color: var(--ink-700); font-size: 13px; }
.migration-groups p { margin: 5px 0 12px; color: var(--ink-400); font-size: 11px; line-height: 1.6; }
.migration-groups :deep(.el-input) { margin-bottom: 8px; }
.migration-groups .restore-file { margin-bottom: 8px; }
@media (max-width: 1100px) {
  .profile-summary { grid-template-columns: 52px minmax(0, 1fr); }
  .profile-avatar { width: 52px; height: 52px; }
  .profile-summary dl { grid-column: 1 / -1; }
  .profile-actions-grid { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .settings-console { grid-template-columns: 1fr; }
  .settings-sections { border-right: 0; border-bottom: 1px solid var(--ink-100); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .settings-detail { padding: 20px; }
  .profile-summary { grid-template-columns: 52px minmax(0, 1fr); }
  .profile-avatar { width: 52px; height: 52px; }
  .profile-summary dl { grid-column: 1 / -1; }
  .profile-actions-grid, .theme-choice-grid, .language-choice-grid { grid-template-columns: 1fr; }
  .execution-mode-switch { grid-template-columns: 1fr; }
  .agent-entry-options { grid-template-columns: 1fr; }
  .agent-presentation-options { grid-template-columns: 1fr; }
  .agent-entry-shortcut { grid-template-columns: minmax(0, 1fr) 32px auto; }
  .agent-entry-shortcut > span { grid-column: 1 / -1; }
  .client-version-card { grid-template-columns: 48px minmax(0, 1fr); padding: 18px; }
  .client-version-card__icon { width: 48px; height: 48px; }
  .client-version-card :deep(.el-button) { width: 100%; grid-column: 1 / -1; }
  .mcp-connection-grid { grid-template-columns: 1fr; }
  .mcp-connection-grid > .is-wide { grid-column: auto; }
  .mcp-client-list article { grid-template-columns: 18px minmax(0, 1fr); }
  .mcp-client-list time { grid-column: 2; }
}

/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */
.settings-console {
  min-height: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  grid-template-columns: 236px minmax(0, 1fr);
  gap: var(--space-md);
  overflow: visible;
}
.settings-sections {
  align-self: start;
  padding: var(--space-sm);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-panel);
  background: var(--color-paper-raised);
  box-shadow: var(--shadow-whisper);
  gap: var(--space-2xs);
}
.settings-sections button {
  min-height: 46px;
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-control);
  gap: var(--space-xs);
  transform: none;
}
.settings-sections button:hover { transform: none; }
.settings-sections button.is-active { box-shadow: none; }
.settings-sections button > span {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-control);
}
.settings-sections strong { font-size: var(--text-sm); }
.settings-detail {
  min-width: 0;
  padding: 0;
}
.settings-section-panel {
  width: 100%;
  min-height: 0;
  padding: var(--space-lg);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-panel);
  background: var(--color-paper-raised);
  box-shadow: var(--shadow-whisper);
}
.settings-section-panel > header {
  padding-block-end: var(--space-md);
  align-items: center;
  gap: var(--space-sm);
}
.settings-section-panel > header > span {
  width: 40px;
  height: 40px;
  flex-basis: 40px;
  border-radius: var(--radius-control);
}
.settings-section-panel > header p { display: none; }
.settings-section-panel > header h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  letter-spacing: 0;
}
.settings-section-meta {
  min-width: 0;
  margin-inline-start: auto;
  overflow: hidden;
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-summary {
  margin-block-start: var(--space-md);
  padding: var(--space-md);
  border-radius: var(--radius-panel);
  background: var(--color-paper-muted);
  grid-template-columns: 52px minmax(140px, 0.6fr) minmax(320px, 1.4fr);
  gap: var(--space-md);
}
.profile-avatar {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-control);
  box-shadow: none;
  font-size: var(--text-xl);
}
.profile-identity strong { margin-top: 0; }
.profile-action-bar {
  margin-block-start: var(--space-md);
  padding-block-start: var(--space-md);
  border-top: 1px solid var(--color-rule);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}
.profile-password-trigger { display: flex; align-items: center; gap: var(--space-2xs); }
.profile-password-trigger :deep(.el-button svg:last-child) { transition: transform var(--dur-short) var(--ease-out); }
.profile-password-trigger :deep(.el-button.is-expanded svg:last-child) { transform: rotate(180deg); }
.profile-password-panel {
  margin-block-start: var(--space-sm);
  padding: var(--space-md);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-panel);
  background: var(--color-paper-muted);
}
.profile-password-panel .settings-form { width: 100%; margin: 0; }
.profile-password-panel footer { display: flex; justify-content: flex-end; gap: var(--space-xs); }
.settings-expand-enter-active,
.settings-expand-leave-active { transition: opacity var(--dur-short) ease, transform var(--dur-short) var(--ease-out); }
.settings-expand-enter-from,
.settings-expand-leave-to { opacity: 0; transform: translateY(-4px); }
.theme-choice,
.execution-target-list,
.client-version-card,
.migration-groups > article {
  border-radius: var(--radius-panel);
  box-shadow: none;
}
.theme-choice:hover { transform: translateY(-1px); }
.theme-choice__copy { min-height: 0; padding-block: var(--space-xs) var(--space-2xs); }
.execution-mode-switch button { min-height: 46px; justify-content: center; }
.migration-groups > article > div > header {
  min-height: 28px;
  margin-block-end: var(--space-xs);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-xs);
}
.restart-banner { align-items: center; padding-block: var(--space-xs); }
.settings-section-panel > footer { margin-block-start: var(--space-lg); }
.settings-section-panel--shortcuts { width: min(820px, 100%); }
.shortcut-settings-toolbar {
  min-height: 40px;
  margin-block-start: var(--space-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}
.shortcut-settings-toolbar > span {
  color: var(--color-muted);
  font-size: var(--text-xs);
}
.shortcut-settings-toolbar > span.is-dirty { color: var(--color-warning); font-weight: 700; }
.shortcut-groups {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-panel);
  overflow: hidden;
}
.shortcut-group + .shortcut-group { border-top: 1px solid var(--color-rule); }
.shortcut-group > header {
  height: 34px;
  padding-inline: var(--space-sm);
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-paper-muted);
  color: var(--color-muted);
  display: flex;
  align-items: center;
  font-size: var(--text-2xs);
}
.shortcut-row {
  min-height: 48px;
  padding: var(--space-xs) var(--space-sm);
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(150px, 210px) 32px 32px;
  align-items: center;
  gap: var(--space-xs);
}
.shortcut-row + .shortcut-row { border-top: 1px solid var(--color-rule); }
.shortcut-row.is-recording { background: var(--color-accent-soft); }
.shortcut-row__label { min-width: 0; }
.shortcut-row__label strong {
  color: var(--color-ink-soft);
  display: block;
  overflow: hidden;
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shortcut-recorder {
  height: 32px;
  min-width: 0;
  padding-inline: var(--space-xs);
  border: 1px solid var(--color-rule-strong);
  border-radius: var(--radius-control);
  background: var(--color-paper-raised);
  color: var(--color-muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-xs);
  cursor: pointer;
}
.shortcut-recorder:hover,
.shortcut-recorder[aria-pressed="true"] { border-color: var(--color-accent); color: var(--color-accent-strong); }
.shortcut-recorder:focus-visible,
.shortcut-icon-action:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.shortcut-recorder kbd {
  min-width: 0;
  overflow: hidden;
  color: currentColor;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shortcut-icon-action {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.shortcut-icon-action:hover:not(:disabled) { background: var(--color-accent-soft); color: var(--color-accent-strong); }
.shortcut-icon-action:disabled { opacity: .32; cursor: default; }
.shortcut-error {
  min-height: 34px;
  margin: var(--space-xs) 0 0;
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-control);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-xs);
}
.settings-section-panel--shortcuts > footer { display: flex; justify-content: flex-end; gap: var(--space-xs); }

@media (max-width: 56.25rem) {
  .settings-console { grid-template-columns: 1fr; }
  .settings-sections {
    border-bottom: 1px solid var(--color-rule);
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .settings-detail { padding: 0; }
}
@media (max-width: 42.5rem) {
  .settings-sections { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .settings-sections button { min-height: 48px; }
  .settings-section-panel { min-height: 0; padding: var(--space-md); }
  .theme-choice-grid { grid-template-columns: 1fr; }
  .shortcut-row { grid-template-columns: minmax(0, 1fr) 32px 32px; }
  .shortcut-recorder { grid-column: 1 / -1; grid-row: 2; }
  .agent-entry-shortcut { grid-template-columns: minmax(0, 1fr) 32px; }
  .agent-entry-shortcut .shortcut-recorder { grid-column: 1 / -1; grid-row: auto; }
  .agent-entry-shortcut :deep(.el-button) { grid-column: 1 / -1; width: 100%; }
  .profile-action-bar { align-items: stretch; flex-direction: column; }
  .profile-action-bar > .el-button { width: 100%; }
}
@media (max-width: 25.875rem) {
  .settings-sections { grid-template-columns: 1fr; }
  .settings-sections button { grid-template-columns: 32px minmax(0, 1fr); }
  .profile-summary { grid-template-columns: 44px minmax(0, 1fr); }
  .profile-avatar { width: 44px; height: 44px; }
  .profile-summary dl { grid-column: 1 / -1; grid-template-columns: 1fr; }
  .profile-password-form { grid-template-columns: 1fr; }
  .profile-password-form :deep(.el-form-item:first-child) { grid-column: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .settings-expand-enter-active,
  .settings-expand-leave-active,
  .profile-password-trigger :deep(.el-button svg:last-child) {
    transition-duration: 150ms;
  }
  .settings-expand-enter-from,
  .settings-expand-leave-to { transform: none; }
}
</style>
