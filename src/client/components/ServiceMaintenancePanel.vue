<script setup lang="ts">
import { localizeMessage, translate as tr } from "../i18n";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  BellRing,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  Download,
  EllipsisVertical,
  FileText,
  GripVertical,
  Hammer,
  Package,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  RotateCw,
  ScanSearch,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Wrench,
  Zap,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch, type Component } from "vue";
import { api, ApiError } from "../api";
import { createLatestDataLoader } from "../latest-data-loader";
import { candidateKey, providerLabel, type CandidateStatus, type MonitorCandidate, type Provider } from "../service-candidate-tree";
import { normalizeMaintenanceScriptActions } from "../service-maintenance-payload";
import { reorderIds, sameOrder } from "../../shared/tab-order";
import {
  defaultMonitorAlertSettings,
  monitorDiskKey,
  type MonitorAlertSettings,
} from "../../shared/monitor-alerts";
import AnimatedCounter from "./AnimatedCounter.vue";
import DeploymentMonitorDashboard from "./DeploymentMonitorDashboard.vue";
import HostMonitorDashboard, { type HostFocusMetric } from "./HostMonitorDashboard.vue";
import ServiceDiscoveryPanel from "./ServiceDiscoveryPanel.vue";

type MaintenanceWorkspace = "service" | "host";
type HostWorkspaceTab = "monitor" | "discovery";
type MaintenanceDirectory = "service" | "host";
type DirectoryMoveDirection = "up" | "down";
type ScriptActionIcon = "terminal" | "rocket" | "refresh" | "database" | "package" | "shield" | "hammer" | "zap";

interface DirectoryDropTarget {
  id: string;
  after: boolean;
}

interface ScriptAction {
  id: string;
  serviceId: string;
  deploymentId: string | null;
  name: string;
  icon: ScriptActionIcon;
  scriptBody?: string;
  createdAt: string;
  updatedAt: string;
}

interface ScriptActionExecutionResult {
  deploymentId: string;
  targetName: string;
  connectionId: string;
  connectionName: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  message: string;
}

interface ScriptActionExecution {
  ok: boolean;
  action: Pick<ScriptAction, "id" | "name" | "icon" | "deploymentId">;
  succeeded: number;
  failed: number;
  results: ScriptActionExecutionResult[];
}

const scriptActionIconComponents: Record<ScriptActionIcon, Component> = {
  terminal: Terminal,
  rocket: Rocket,
  refresh: RefreshCw,
  database: Database,
  package: Package,
  shield: ShieldCheck,
  hammer: Hammer,
  zap: Zap,
};

const scriptActionIconOptions = Object.keys(scriptActionIconComponents) as ScriptActionIcon[];

interface HostSnapshot {
  hostname: string;
  collectorUser?: string;
  operatingSystem?: string;
  architecture?: string;
  kernelVersion?: string;
  cpuCount: number;
  cpuUsedPercent: number;
  load1: number;
  load5: number;
  load15: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsedPercent: number;
  uptimeSeconds: number;
  disks: Array<{ path: string; device?: string; filesystem?: string; totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number }>;
  temperatures: Array<{ chip: string; feature?: string; celsius: number; maximum?: number; critical?: number }>;
}

interface KubernetesConfigDiscovery {
  sourceId: string;
  path?: string;
  context?: string;
  cluster?: string;
  namespace?: string;
  currentContext: boolean;
  selected: boolean;
  status: "discovered" | "connected" | "error" | "unreadable" | "invalid";
  candidateCount: number;
  error?: string;
}

interface MonitorHost {
  sshConnectionId: string;
  connectionName: string;
  host: string;
  port: number;
  username: string;
  connectionAvailable: boolean;
  monitorStatus: "ready" | "missing" | "error" | "unknown";
  monitorOffline: boolean;
  agentId: string;
  agentVersion: string;
  monitorUpdateAvailable: boolean;
  protocolVersion: number;
  lastSequence: number;
  snapshot: HostSnapshot | null;
  candidates: MonitorCandidate[];
  kubernetesConfigs: KubernetesConfigDiscovery[];
  lastError: string;
  lastCollectedAt: string | null;
  lastPulledAt: string | null;
  installPath: string;
  installArchitecture: string;
  installManaged: boolean;
  installedAt: string | null;
}

interface MonitorInstallPreflight {
  defaultInstallPath: string;
  installPath: string;
  operatingSystem: string;
  machineArchitecture: string;
  architecture: "amd64" | "arm64" | null;
  systemdAvailable: boolean;
  privilege: "root" | "passwordless_sudo" | "unavailable";
  pathState: "available" | "upgrade" | "conflict" | "legacy";
  existingMonitorPath: string;
  existingInstallation: { product: "viron-monitor"; version: string; architecture: "amd64" | "arm64"; installPath: string; installedAt: string } | null;
  packageVersion: string;
  packageAvailable: boolean;
  canInstall: boolean;
  issues: Array<{ code: string; message: string }>;
}

type MonitorInstallTaskStatus = "pending" | "running" | "success" | "error";
type MonitorInstallTaskPhase = "queued" | "preflight" | "package_validation" | "ssh_connect" | "staging" | "upload" | "remote_install" | "reconnect" | "initial_collect" | "persist" | "complete";

interface MonitorInstallTask {
  id: string;
  environmentId: string;
  connectionId: string;
  connectionName: string;
  installPath: string;
  status: MonitorInstallTaskStatus;
  phase: MonitorInstallTaskPhase;
  progress: number;
  currentMessage: string;
  logs: Array<{ at: string; kind: "progress" | "output"; message: string }>;
  error: string;
  result: { monitorWarning?: string };
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface Deployment {
  id: string;
  serviceId: string;
  sshConnectionId: string | null;
  sshConnectionName: string;
  provider: Provider;
  externalId: string;
  displayName: string;
  origin: "discovered" | "manual";
  status: CandidateStatus | "disabled";
  state: string;
  metrics: Partial<MonitorCandidate>;
  lastCheckedAt: string | null;
  connectionAvailable: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  scriptActions: ScriptAction[];
}

interface ServiceItem {
  id: string;
  environmentId: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  scriptActions: ScriptAction[];
  deployments: Deployment[];
  logIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface EnvironmentLog {
  id: string;
  name: string;
  sshConnectionId: string;
  connectionName: string;
  filePaths: string[];
}

interface MaintenancePayload {
  canConfigure: boolean;
  canOperate: boolean;
  scriptActionsSupported: boolean;
  alertSettings: MonitorAlertSettings;
  services: ServiceItem[];
  logs: EnvironmentLog[];
  hosts: MonitorHost[];
}

interface MaintenanceDeploymentResponse extends Omit<Deployment, "scriptActions"> {
  scriptActions?: ScriptAction[];
}

interface MaintenanceServiceResponse extends Omit<ServiceItem, "scriptActions" | "deployments"> {
  scriptActions?: ScriptAction[];
  deployments: MaintenanceDeploymentResponse[];
}

interface MaintenancePayloadResponse extends Omit<MaintenancePayload, "scriptActionsSupported" | "services"> {
  services: MaintenanceServiceResponse[];
}

interface MaintenanceCounts {
  services: number;
  monitoredHosts: number;
}

const props = defineProps<{
  environmentId: string;
  focusHostId?: string;
  focusServiceId?: string;
  focusDeploymentId?: string;
}>();
const emit = defineEmits<{ "count-change": [counts: MaintenanceCounts]; "open-log": [logId: string] }>();

const loading = ref(true);
const saving = ref(false);
const payload = ref<MaintenancePayload>({
  canConfigure: false,
  canOperate: false,
  scriptActionsSupported: false,
  alertSettings: { ...defaultMonitorAlertSettings, excludedDisks: [] },
  services: [],
  logs: [],
  hosts: [],
});
const selectedServiceId = ref("");
const selectedHostId = ref("");
const activeWorkspace = ref<MaintenanceWorkspace>("service");
const hostWorkspaceTab = ref<HostWorkspaceTab>("monitor");
const hostFocusMetric = ref<HostFocusMetric>("cpu");
const discoveryTargetServiceId = ref("");
const pendingDiscoveryCandidate = ref<MonitorCandidate | null>(null);
const creatingServiceFromDiscovery = ref(false);
const servicePickerDialog = ref(false);
const refreshingHosts = ref(new Set<string>());
const installingHosts = ref(new Set<string>());
const clearingHosts = ref(new Set<string>());
const draggingDirectory = ref<{ kind: MaintenanceDirectory; id: string } | null>(null);
const serviceDropTarget = ref<DirectoryDropTarget | null>(null);
const hostDropTarget = ref<DirectoryDropTarget | null>(null);
const savingServiceOrder = ref(false);
const savingHostOrder = ref(false);
const installTask = ref<MonitorInstallTask | null>(null);
const installTaskConnectionId = ref("");
const installProgressDialog = ref(false);
const runningAction = ref("");
const runningScriptActionId = ref("");
const serviceDialog = ref(false);
const deploymentDialog = ref(false);
const logDialog = ref(false);
const kubernetesDialog = ref(false);
const scriptActionManagerDialog = ref(false);
const scriptActionEditorOpen = ref(false);
const scriptActionResultDialog = ref(false);
const alertSettingsDialog = ref(false);
const savingAlertSettings = ref(false);
const editingServiceId = ref("");
const editingDeploymentId = ref("");
const editingScriptActionId = ref("");
const manualDeployment = ref(false);
const savingKubernetes = ref(false);
const scriptActionExecution = ref<ScriptActionExecution | null>(null);
let refreshTimer: number | undefined;
let installTaskTimer: number | undefined;
const notifiedInstallTasks = new Set<string>();

const serviceForm = reactive({ name: "", description: "", status: "active" as "active" | "disabled" });
const deploymentForm = reactive({ sshConnectionId: "", candidateKey: "", provider: "systemd" as Provider, externalId: "", displayName: "", origin: "manual" as "discovered" | "manual" });
const scriptActionScope = reactive({ serviceId: "", deploymentId: null as string | null, label: "" });
const scriptActionForm = reactive({ name: "", icon: "terminal" as ScriptActionIcon, scriptBody: "" });
const selectedLogIds = ref<string[]>([]);
const selectedKubernetesContextKeys = ref<string[]>([]);
const alertSettingsForm = reactive<MonitorAlertSettings>({ ...defaultMonitorAlertSettings, excludedDisks: [] });

const selectedService = computed(() => payload.value.services.find((item) => item.id === selectedServiceId.value) ?? payload.value.services[0] ?? null);
const selectedHost = computed(() => payload.value.hosts.find((item) => item.sshConnectionId === selectedHostId.value) ?? payload.value.hosts[0] ?? null);
const selectedLogs = computed(() => payload.value.logs.filter((log) => selectedService.value?.logIds.includes(log.id)));
const hostCandidates = computed(() => payload.value.hosts.find((host) => host.sshConnectionId === deploymentForm.sshConnectionId)?.candidates ?? []);
const candidateOptions = computed(() => hostCandidates.value.map((candidate) => ({
  ...candidate,
  key: `${candidate.provider}:${candidate.externalId}`,
  label: `${candidateLocationLabel(candidate)} · ${candidate.name} · ${statusLabel(candidate.status)}`,
})));
const serviceSummary = computed(() => summarizeService(selectedService.value));
const runningDeployments = computed(() => payload.value.services.flatMap((service) => service.deployments).filter((deployment) => deployment.status === "running").length);
const problemDeployments = computed(() => payload.value.services.flatMap((service) => service.deployments).filter((deployment) => ["stopped", "degraded", "unknown"].includes(deployment.status)).length);
function countPhysicalMonitorHosts(hosts: MonitorHost[]) {
  return new Set(hosts.map((host) => host.agentId || `connection:${host.sshConnectionId}`)).size;
}

const monitoredHosts = computed(() => countPhysicalMonitorHosts(payload.value.hosts.filter((host) => Boolean(host.agentId) || host.installManaged)));
const offlineHosts = computed(() => payload.value.hosts.filter((host) => host.monitorOffline).length);
const unmonitoredHosts = computed(() => payload.value.hosts.filter((host) => host.monitorStatus === "missing" && !host.monitorOffline).length);
const attentionItems = computed(() => [
  problemDeployments.value ? { key: "problems", value: problemDeployments.value, label: tr("待处理") } : null,
  offlineHosts.value ? { key: "offline", value: offlineHosts.value, label: tr("离线主机") } : null,
  unmonitoredHosts.value ? { key: "missing", value: unmonitoredHosts.value, label: tr("未监控") } : null,
].filter((item): item is { key: string; value: number; label: string } => Boolean(item)));
const selectedUnmanagedCount = computed(() => selectedHost.value ? hostUnmanagedCount(selectedHost.value) : 0);
const selectedWorstDisk = computed(() => selectedHost.value ? worstDisk(selectedHost.value) : null);
const cpuVisualThreshold = computed(() => visualThreshold(payload.value.alertSettings.cpuEnabled, payload.value.alertSettings.cpuThreshold, 80));
const memoryVisualThreshold = computed(() => visualThreshold(payload.value.alertSettings.memoryEnabled, payload.value.alertSettings.memoryThreshold, 80));
const diskVisualThreshold = computed(() => visualThreshold(payload.value.alertSettings.diskUsageEnabled, payload.value.alertSettings.diskUsageThreshold, 80));
const canSortDirectory = computed(() => payload.value.canConfigure && !savingServiceOrder.value && !savingHostOrder.value);
const selectableKubernetesConfigs = computed(() => (selectedHost.value?.kubernetesConfigs ?? []).filter((item) => item.context && !["invalid", "unreadable"].includes(item.status)));
const discoveryManagedKeys = computed(() => {
  const hostId = selectedHost.value?.sshConnectionId;
  if (!hostId) return [];
  return [...new Set(
    payload.value.services.flatMap((service) => service.deployments)
      .filter((deployment) => deployment.sshConnectionId === hostId)
      .map(candidateKey),
  )];
});
const selectedInstallTask = computed(() => installTaskConnectionId.value === selectedHost.value?.sshConnectionId ? installTask.value : null);
const scopedScriptActions = computed(() => {
  const service = payload.value.services.find((item) => item.id === scriptActionScope.serviceId);
  if (!service) return [];
  if (!scriptActionScope.deploymentId) return service.scriptActions;
  return service.deployments.find((item) => item.id === scriptActionScope.deploymentId)?.scriptActions ?? [];
});
const installTaskSteps = computed(() => [
  { phase: "preflight" as const, label: tr("目标预检"), description: tr("系统、架构、权限与目录") },
  { phase: "package_validation" as const, label: tr("校验安装包"), description: tr("版本、架构与 SHA-256") },
  { phase: "ssh_connect" as const, label: tr("建立 SSH 会话"), description: tr("使用已有连接及跳板链路") },
  { phase: "staging" as const, label: tr("准备临时目录"), description: tr("在目标主机创建安全暂存区") },
  { phase: "upload" as const, label: tr("上传安装文件"), description: tr("逐个传输并显示文件进度") },
  { phase: "remote_install" as const, label: tr("安装并启动服务"), description: tr("写入配置和 systemd 单元") },
  { phase: "reconnect" as const, label: tr("重新连接主机"), description: tr("刷新安装后的用户组权限") },
  { phase: "initial_collect" as const, label: tr("首次采集指标"), description: tr("扫描服务并拉取宿主机状态") },
  { phase: "persist" as const, label: tr("保存安装结果"), description: tr("写入 Viron 中心数据库") },
]);
const monitorDiskOptions = computed(() => {
  const options = new Map<string, { key: string; label: string }>();
  for (const host of payload.value.hosts) {
    for (const disk of host.snapshot?.disks ?? []) {
      const key = monitorDiskKey(disk);
      const identity = [disk.device, disk.path].filter(Boolean).join(" · ");
      options.set(key, { key, label: `${host.connectionName} · ${identity}` });
    }
  }
  return [...options.values()];
});

watch(selectedService, (service) => {
  if (service && selectedServiceId.value !== service.id) selectedServiceId.value = service.id;
}, { immediate: true });

watch(selectedHost, (host) => {
  if (host && selectedHostId.value !== host.sshConnectionId) selectedHostId.value = host.sshConnectionId;
  if (host && installTaskConnectionId.value !== host.sshConnectionId) switchInstallTaskHost(host.sshConnectionId);
}, { immediate: true });

watch(serviceDialog, (open) => {
  if (open || !creatingServiceFromDiscovery.value) return;
  creatingServiceFromDiscovery.value = false;
  pendingDiscoveryCandidate.value = null;
});

watch(() => deploymentForm.candidateKey, (key) => {
  if (!key || manualDeployment.value) return;
  const candidate = candidateOptions.value.find((item) => item.key === key);
  if (!candidate) return;
  Object.assign(deploymentForm, {
    provider: candidate.provider,
    externalId: candidate.externalId,
    displayName: candidate.name,
    origin: "discovered",
  });
});

async function fetchMaintenance(silent = false) {
  if (silent && (savingServiceOrder.value || savingHostOrder.value)) return;
  if (!silent) loading.value = true;
  try {
    const response = await api<MaintenancePayloadResponse>(`/api/v1/environments/${props.environmentId}/maintenance`);
    payload.value = normalizeMaintenanceScriptActions(response) as MaintenancePayload;
    if (!payload.value.services.some((item) => item.id === selectedServiceId.value)) selectedServiceId.value = payload.value.services[0]?.id ?? "";
    if (!payload.value.services.some((item) => item.id === discoveryTargetServiceId.value)) discoveryTargetServiceId.value = "";
    if (!payload.value.hosts.some((item) => item.sshConnectionId === selectedHostId.value)) selectedHostId.value = payload.value.hosts[0]?.sshConnectionId ?? "";
    if (activeWorkspace.value === "service" && !payload.value.services.length && payload.value.hosts.length) activeWorkspace.value = "host";
    if (activeWorkspace.value === "host" && !payload.value.hosts.length && payload.value.services.length) activeWorkspace.value = "service";
    emit("count-change", { services: payload.value.services.length, monitoredHosts: monitoredHosts.value });
    applyFocusTarget();
  } finally {
    if (!silent) loading.value = false;
  }
}

function applyFocusTarget() {
  const requestedServiceId = props.focusServiceId
    || payload.value.services.find((service) => service.deployments.some((deployment) => deployment.id === props.focusDeploymentId))?.id;
  if (requestedServiceId && payload.value.services.some((service) => service.id === requestedServiceId)) {
    selectService(requestedServiceId);
    return;
  }
  if (props.focusHostId && payload.value.hosts.some((host) => host.sshConnectionId === props.focusHostId)) selectHost(props.focusHostId);
}

watch(
  () => [props.focusHostId, props.focusServiceId, props.focusDeploymentId],
  applyFocusTarget,
);

function openAlertSettings() {
  Object.assign(alertSettingsForm, payload.value.alertSettings, { excludedDisks: [...payload.value.alertSettings.excludedDisks] });
  alertSettingsDialog.value = true;
}

async function saveAlertSettings() {
  savingAlertSettings.value = true;
  try {
    const response = await api<{ item: MonitorAlertSettings }>(`/api/v1/environments/${props.environmentId}/monitor-alert-settings`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: alertSettingsForm.enabled,
        hostOfflineEnabled: alertSettingsForm.hostOfflineEnabled,
        cpuEnabled: alertSettingsForm.cpuEnabled,
        cpuThreshold: alertSettingsForm.cpuThreshold,
        memoryEnabled: alertSettingsForm.memoryEnabled,
        memoryThreshold: alertSettingsForm.memoryThreshold,
        diskUsageEnabled: alertSettingsForm.diskUsageEnabled,
        diskUsageThreshold: alertSettingsForm.diskUsageThreshold,
        temperatureEnabled: alertSettingsForm.temperatureEnabled,
        temperatureThreshold: alertSettingsForm.temperatureThreshold,
        deploymentStatusEnabled: alertSettingsForm.deploymentStatusEnabled,
        diskMissingEnabled: alertSettingsForm.diskMissingEnabled,
        excludedDisks: alertSettingsForm.excludedDisks,
      }),
    });
    payload.value.alertSettings = response.item;
    alertSettingsDialog.value = false;
    ElMessage.success(response.item.enabled ? tr("监控告警已启用") : tr("监控告警已关闭"));
  } finally {
    savingAlertSettings.value = false;
  }
}

const { load, reload } = createLatestDataLoader(fetchMaintenance);

function stopAutoRefresh() {
  if (refreshTimer === undefined) return;
  window.clearInterval(refreshTimer);
  refreshTimer = undefined;
}

function startAutoRefresh() {
  if (refreshTimer !== undefined) return;
  refreshTimer = window.setInterval(() => {
    void load(true).catch(() => undefined);
  }, 10_000);
}

function isInstallTaskActive(task: MonitorInstallTask | null | undefined) {
  return task?.status === "pending" || task?.status === "running";
}

function stopInstallTaskPolling() {
  if (installTaskTimer === undefined) return;
  window.clearInterval(installTaskTimer);
  installTaskTimer = undefined;
}

function startInstallTaskPolling(connectionId: string) {
  if (installTaskTimer !== undefined) return;
  installTaskTimer = window.setInterval(() => {
    void refreshInstallTask(connectionId);
  }, 1_000);
}

function switchInstallTaskHost(connectionId: string) {
  stopInstallTaskPolling();
  installTaskConnectionId.value = connectionId;
  installTask.value = null;
  void refreshInstallTask(connectionId, false);
}

async function refreshInstallTask(connectionId: string, notify = true) {
  if (!connectionId) return;
  const previous = installTaskConnectionId.value === connectionId ? installTask.value : null;
  try {
    const response = await api<{ item: MonitorInstallTask | null }>(
      `/api/v1/environments/${props.environmentId}/monitor-hosts/${connectionId}/install-task`,
    );
    if (installTaskConnectionId.value !== connectionId) return;
    installTask.value = response.item;
    if (isInstallTaskActive(response.item)) {
      startInstallTaskPolling(connectionId);
      return;
    }
    stopInstallTaskPolling();
    if (!notify || !response.item || !isInstallTaskActive(previous) || notifiedInstallTasks.has(response.item.id)) return;
    notifiedInstallTasks.add(response.item.id);
    await reload(true);
    if (response.item.status === "success") {
      const warning = response.item.result.monitorWarning;
      if (warning) ElMessage.warning(tr("监控服务已安装，但首次采集失败：{{0}}", [localizeMessage(warning)]));
      else ElMessage.success(tr("监控服务安装完成"));
    } else {
      ElMessage.error(tr("监控服务安装失败，请查看详细日志"));
    }
  } catch {
    if (isInstallTaskActive(previous)) startInstallTaskPolling(connectionId);
  }
}

async function openInstallProgress(host: MonitorHost) {
  if (installTaskConnectionId.value !== host.sshConnectionId) switchInstallTaskHost(host.sshConnectionId);
  await refreshInstallTask(host.sshConnectionId, false);
  if (installTask.value) installProgressDialog.value = true;
}

function installTaskStepState(index: number) {
  const task = selectedInstallTask.value;
  if (!task) return "pending";
  if (task.status === "success" || task.phase === "complete") return "complete";
  const current = installTaskSteps.value.findIndex((step) => step.phase === task.phase);
  if (current < 0) return index === 0 && isInstallTaskActive(task) ? "active" : "pending";
  if (index < current) return "complete";
  if (index > current) return "pending";
  return task.status === "error" ? "error" : "active";
}

function installTaskStatusLabel(task: MonitorInstallTask) {
  if (task.status === "success") return tr("安装完成");
  if (task.status === "error") return tr("安装失败");
  if (task.status === "pending") return tr("等待执行");
  return tr("正在安装");
}

function formatInstallTaskElapsed(task: MonitorInstallTask) {
  const start = task.startedAt ?? task.createdAt;
  const end = task.completedAt ?? new Date().toISOString();
  const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? tr("{{0}} 分 {{1}} 秒", [minutes, seconds % 60]) : tr("{{0}} 秒", [seconds]);
}

function formatInstallLogTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function summarizeService(service: ServiceItem | null) {
  if (!service || service.status === "disabled") return { status: "disabled", label: tr("已停用") };
  if (!service.deployments.length) return { status: "unknown", label: tr("尚未纳管节点") };
  const statuses = service.deployments.map((item) => item.status);
  if (statuses.every((status) => status === "running")) return { status: "running", label: tr("运行中") };
  if (statuses.some((status) => status === "degraded" || status === "stopped")) return { status: "degraded", label: tr("存在异常节点") };
  return { status: "unknown", label: tr("状态未确认") };
}

function statusLabel(status: string) {
  return ({ running: tr("运行中"), stopped: tr("已停止"), degraded: tr("异常"), unknown: tr("未知"), disabled: tr("已停用") } as Record<string, string>)[status] ?? status;
}

function candidateLocationLabel(candidate: MonitorCandidate) {
  if (candidate.provider !== "kubernetes") return providerLabel(candidate.provider);
  const metadata = candidate.metadata ?? {};
  return `Kubernetes · ${String(metadata.cluster ?? metadata.context ?? "")} / ${String(metadata.namespace ?? "default")} · ${String(metadata.resourceKind ?? "Workload")}`;
}

function supportsMaintenanceActions(provider: Provider) {
  return ["systemd", "docker", "podman", "supervisor"].includes(provider);
}

function unsupportedMaintenanceActionReason(provider: Provider) {
  if (provider === "kubernetes") return tr("Kubernetes 工作负载暂不提供通用启停");
  if (provider === "process") return tr("普通进程只登记关系，不提供通用启停");
  return "";
}

function deploymentIdentity(deployment: Deployment) {
  if (deployment.provider !== "kubernetes") return deployment.externalId;
  const metadata = deployment.metrics.metadata ?? {};
  const context = String(metadata.context ?? "");
  const namespace = String(metadata.namespace ?? "");
  const resourceKind = String(metadata.resourceKind ?? "");
  return context && namespace && resourceKind
    ? `${context}/${namespace}/${resourceKind}/${deployment.displayName || deployment.externalId}`
    : deployment.externalId;
}

function kubernetesMetric(deployment: Deployment, key: string) {
  const value = deployment.metrics.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : "—";
}

function kubernetesContextKey(item: Pick<KubernetesConfigDiscovery, "sourceId" | "context">) {
  return JSON.stringify([item.sourceId, item.context ?? ""]);
}

function kubernetesConfigStatusLabel(item: KubernetesConfigDiscovery) {
  if (item.status === "connected") return tr("已连接");
  if (item.status === "discovered") return tr("待选择");
  if (item.status === "unreadable") return tr("无法读取");
  if (item.status === "invalid") return tr("配置无效");
  return tr("连接失败");
}

function openKubernetesConfiguration() {
  selectedKubernetesContextKeys.value = (selectedHost.value?.kubernetesConfigs ?? [])
    .filter((item) => item.selected && item.context)
    .map(kubernetesContextKey);
  kubernetesDialog.value = true;
}

async function saveKubernetesConfiguration() {
  const host = selectedHost.value;
  if (!host) return;
  const selectedKeys = new Set(selectedKubernetesContextKeys.value);
  const selections = selectableKubernetesConfigs.value
    .filter((item) => selectedKeys.has(kubernetesContextKey(item)))
    .map((item) => ({ sourceId: item.sourceId, context: item.context! }));
  savingKubernetes.value = true;
  try {
    const response = await api<{ monitorWarning?: string }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/kubernetes-contexts`, {
      method: "PUT",
      body: JSON.stringify({ selections }),
    });
    kubernetesDialog.value = false;
    await reload(true);
    if (response.monitorWarning) ElMessage.warning(tr("Kubernetes 扫描配置已保存，但立即扫描失败：{{0}}", [localizeMessage(response.monitorWarning)]));
    else ElMessage.success(tr("Kubernetes 扫描配置已保存"));
  } finally {
    savingKubernetes.value = false;
  }
}

function isMonitorInstalled(host: MonitorHost) {
  return host.monitorStatus === "ready" || Boolean(host.agentId);
}

function formatPercent(value?: number) {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "—";
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value) || !value) return value === 0 ? "0 B" : "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let current = Number(value);
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 100 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds) || Number(seconds) < 0) return "—";
  if (Number(seconds) < 60) return tr("不到 1 分钟");
  const days = Math.floor(Number(seconds) / 86400);
  const hours = Math.floor((Number(seconds) % 86400) / 3600);
  const minutes = Math.floor((Number(seconds) % 3600) / 60);
  if (days) return tr("{{0}} 天 {{1}} 小时", [days, hours]);
  if (hours) return tr("{{0}} 小时", [hours]);
  return tr("{{0}} 分钟", [minutes]);
}

function formatTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : tr("尚未采集");
}

function formatRelativeCollected(value: string | null | undefined) {
  if (!value) return tr("尚未采集");
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return tr("尚未采集");
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return tr("刚刚采集");
  if (minutes < 60) return tr("{{0}} 分钟前采集", [minutes]);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return tr("{{0}} 小时前采集", [hours]);
  return formatTime(value);
}

function hostPresence(host: MonitorHost) {
  if (host.monitorOffline) return { key: "offline", label: tr("离线") };
  if (host.monitorStatus === "ready") return { key: "online", label: tr("在线") };
  if (host.monitorStatus === "missing") return { key: "missing", label: tr("未监控") };
  if (host.monitorStatus === "error") return { key: "error", label: tr("异常") };
  return { key: "unknown", label: tr("未知") };
}

function hostLiveCpu(host: MonitorHost) {
  return Number.isFinite(host.snapshot?.cpuUsedPercent) ? formatPercent(host.snapshot?.cpuUsedPercent) : "";
}

function worstDisk(host: MonitorHost) {
  const disks = host.snapshot?.disks ?? [];
  if (!disks.length) return null;
  return disks.reduce((worst, disk) => disk.usedPercent > (worst?.usedPercent ?? -1) ? disk : worst);
}

function metricTone(value: number | undefined, threshold: number) {
  if (!Number.isFinite(value)) return "unknown";
  if (Number(value) >= threshold) return "critical";
  if (Number(value) >= threshold * 0.8) return "warn";
  return "ok";
}

function hostUnmanagedCount(host: MonitorHost) {
  const managed = new Set(
    payload.value.services.flatMap((service) => service.deployments)
      .filter((deployment) => deployment.sshConnectionId === host.sshConnectionId)
      .map(candidateKey),
  );
  return host.candidates.filter((candidate) => !managed.has(candidateKey(candidate))).length;
}

function visualThreshold(enabled: boolean, value: number, fallback: number) {
  return enabled ? value : fallback;
}

function selectService(id: string) {
  selectedServiceId.value = id;
  discoveryTargetServiceId.value = id;
  activeWorkspace.value = "service";
}

function selectHost(id: string) {
  selectedHostId.value = id;
  activeWorkspace.value = "host";
}

function directoryIds(kind: MaintenanceDirectory): string[] {
  return kind === "service"
    ? payload.value.services.map((item) => item.id)
    : payload.value.hosts.map((item) => item.sshConnectionId);
}

function orderedDirectoryItems<T>(items: T[], orderedIds: string[], id: (item: T) => string): T[] {
  const byId = new Map(items.map((item) => [id(item), item]));
  return orderedIds.map((itemId) => byId.get(itemId)).filter((item): item is T => Boolean(item));
}

function directoryDropTarget(kind: MaintenanceDirectory) {
  return kind === "service" ? serviceDropTarget : hostDropTarget;
}

function insertAfterDirectoryTarget(event: DragEvent): boolean {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return false;
  const bounds = element.getBoundingClientRect();
  return event.clientY > bounds.top + bounds.height / 2;
}

function startDirectoryDrag(kind: MaintenanceDirectory, id: string, event: DragEvent) {
  if (!canSortDirectory.value) {
    event.preventDefault();
    return;
  }
  draggingDirectory.value = { kind, id };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `maintenance-${kind}:${id}`);
  }
}

function dragDirectoryOver(kind: MaintenanceDirectory, id: string, event: DragEvent) {
  if (!draggingDirectory.value || draggingDirectory.value.kind !== kind || draggingDirectory.value.id === id) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  directoryDropTarget(kind).value = { id, after: insertAfterDirectoryTarget(event) };
}

function leaveDirectoryDropTarget(kind: MaintenanceDirectory, event: DragEvent) {
  const element = event.currentTarget;
  const nextTarget = event.relatedTarget;
  const target = directoryDropTarget(kind);
  if (!(element instanceof HTMLElement) || target.value?.id !== element.dataset.directoryId) return;
  if (!(nextTarget instanceof Node && element.contains(nextTarget))) target.value = null;
}

async function persistDirectoryOrder(kind: MaintenanceDirectory, orderedIds: string[]) {
  const currentIds = directoryIds(kind);
  if (sameOrder(currentIds, orderedIds)) return;
  if (kind === "service") {
    const original = [...payload.value.services];
    payload.value.services = orderedDirectoryItems(original, orderedIds, (item) => item.id);
    savingServiceOrder.value = true;
    try {
      await api(`/api/v1/environments/${props.environmentId}/services/order`, {
        method: "PUT",
        body: JSON.stringify({ orderedIds }),
      });
    } catch (error) {
      payload.value.services = original;
      ElMessage.error(error instanceof Error ? error.message : tr("保存服务清单顺序失败"));
    } finally {
      savingServiceOrder.value = false;
    }
    return;
  }

  const original = [...payload.value.hosts];
  payload.value.hosts = orderedDirectoryItems(original, orderedIds, (item) => item.sshConnectionId);
  savingHostOrder.value = true;
  try {
    await api(`/api/v1/environments/${props.environmentId}/maintenance-hosts/order`, {
      method: "PUT",
      body: JSON.stringify({ orderedIds }),
    });
  } catch (error) {
    payload.value.hosts = original;
    ElMessage.error(error instanceof Error ? error.message : tr("保存宿主机顺序失败"));
  } finally {
    savingHostOrder.value = false;
  }
}

async function dropDirectoryItem(kind: MaintenanceDirectory, id: string, event: DragEvent) {
  if (!draggingDirectory.value || draggingDirectory.value.kind !== kind) return;
  event.preventDefault();
  const orderedIds = reorderIds(directoryIds(kind), draggingDirectory.value.id, id, insertAfterDirectoryTarget(event));
  endDirectoryDrag();
  await persistDirectoryOrder(kind, orderedIds);
}

function endDirectoryDrag() {
  draggingDirectory.value = null;
  serviceDropTarget.value = null;
  hostDropTarget.value = null;
}

function canMoveDirectoryItem(kind: MaintenanceDirectory, id: string, direction: DirectoryMoveDirection) {
  const ids = directoryIds(kind);
  const index = ids.indexOf(id);
  return index >= 0 && (direction === "up" ? index > 0 : index < ids.length - 1);
}

async function moveDirectoryItem(kind: MaintenanceDirectory, id: string, direction: DirectoryMoveDirection) {
  if (!canSortDirectory.value || !canMoveDirectoryItem(kind, id, direction)) return;
  const orderedIds = directoryIds(kind);
  const index = orderedIds.indexOf(id);
  const target = direction === "up" ? index - 1 : index + 1;
  [orderedIds[index], orderedIds[target]] = [orderedIds[target]!, orderedIds[index]!];
  await persistDirectoryOrder(kind, orderedIds);
}

function handleDirectoryMove(kind: MaintenanceDirectory, id: string, command: string | number | object) {
  if (command === "up" || command === "down") void moveDirectoryItem(kind, id, command);
}

function openServiceCreate(fromDiscovery = false) {
  creatingServiceFromDiscovery.value = fromDiscovery === true;
  editingServiceId.value = "";
  Object.assign(serviceForm, { name: "", description: "", status: "active" });
  serviceDialog.value = true;
}

function openServiceEdit() {
  if (!selectedService.value) return;
  editingServiceId.value = selectedService.value.id;
  Object.assign(serviceForm, { name: selectedService.value.name, description: selectedService.value.description, status: selectedService.value.status });
  serviceDialog.value = true;
}

async function saveService() {
  if (!serviceForm.name.trim()) return ElMessage.warning(tr("请输入服务名称"));
  saving.value = true;
  try {
    const body = JSON.stringify(serviceForm);
    if (editingServiceId.value) await api(`/api/v1/services/${editingServiceId.value}`, { method: "PUT", body });
    else {
      const created = await api<{ id: string }>(`/api/v1/environments/${props.environmentId}/services`, { method: "POST", body });
      selectedServiceId.value = created.id;
      discoveryTargetServiceId.value = created.id;
      if (creatingServiceFromDiscovery.value) {
        activeWorkspace.value = "host";
        hostWorkspaceTab.value = "discovery";
      } else {
        activeWorkspace.value = "service";
      }
    }
    const continueDiscovery = creatingServiceFromDiscovery.value;
    const pendingCandidate = pendingDiscoveryCandidate.value;
    creatingServiceFromDiscovery.value = false;
    serviceDialog.value = false;
    await reload();
    ElMessage.success(tr("服务已保存"));
    if (continueDiscovery && pendingCandidate && selectedHost.value) {
      pendingDiscoveryCandidate.value = null;
      openDeploymentCreate(pendingCandidate, selectedHost.value);
    }
  } finally {
    saving.value = false;
  }
}

async function removeService() {
  const service = selectedService.value;
  if (!service) return;
  await ElMessageBox.confirm(tr("删除服务“{{0}}”？部署节点关联会一并移除，SSH 连接和日志配置不会被删除。", [service.name]), tr("删除服务"), { type: "warning" });
  await api(`/api/v1/services/${service.id}`, { method: "DELETE" });
  selectedServiceId.value = "";
  await reload();
  ElMessage.success(tr("服务已删除"));
}

function resetDeploymentForm() {
  const defaultHost = selectedHost.value ?? payload.value.hosts[0];
  Object.assign(deploymentForm, { sshConnectionId: defaultHost?.sshConnectionId ?? "", candidateKey: "", provider: "systemd", externalId: "", displayName: "", origin: "manual" });
  manualDeployment.value = !(defaultHost?.candidates.length);
}

function openDeploymentCreate(candidate?: MonitorCandidate, host?: MonitorHost) {
  editingDeploymentId.value = "";
  resetDeploymentForm();
  if (host) deploymentForm.sshConnectionId = host.sshConnectionId;
  if (candidate) {
    manualDeployment.value = false;
    deploymentForm.candidateKey = `${candidate.provider}:${candidate.externalId}`;
    Object.assign(deploymentForm, { provider: candidate.provider, externalId: candidate.externalId, displayName: candidate.name, origin: "discovered" });
  }
  deploymentDialog.value = true;
}

function assignDiscoveryTarget(serviceId: string) {
  discoveryTargetServiceId.value = serviceId;
  if (serviceId) selectedServiceId.value = serviceId;
}

function beginCandidateEnrollment(candidate: MonitorCandidate) {
  if (!payload.value.canConfigure) return;
  const host = selectedHost.value;
  if (!host) return;
  pendingDiscoveryCandidate.value = candidate;
  if (discoveryTargetServiceId.value && payload.value.services.some((item) => item.id === discoveryTargetServiceId.value)) {
    selectedServiceId.value = discoveryTargetServiceId.value;
    openDeploymentCreate(candidate, host);
    return;
  }
  if (payload.value.services.length === 1 && payload.value.services[0]) {
    assignDiscoveryTarget(payload.value.services[0].id);
    openDeploymentCreate(candidate, host);
    return;
  }
  if (!payload.value.services.length) {
    openServiceCreate(true);
    return;
  }
  servicePickerDialog.value = true;
}

function pickServiceForDiscovery(serviceId: string) {
  assignDiscoveryTarget(serviceId);
  const candidate = pendingDiscoveryCandidate.value;
  const host = selectedHost.value;
  if (candidate && host) openDeploymentCreate(candidate, host);
  servicePickerDialog.value = false;
}

function createServiceFromDiscovery() {
  openServiceCreate(true);
  servicePickerDialog.value = false;
}

function cancelServicePicker() {
  servicePickerDialog.value = false;
  pendingDiscoveryCandidate.value = null;
}

function onServicePickerClosed() {
  if (creatingServiceFromDiscovery.value || deploymentDialog.value) return;
  pendingDiscoveryCandidate.value = null;
}

function discoveryPickerIntro() {
  return pendingDiscoveryCandidate.value
    ? tr("将“{{0}}”加入哪个服务？", [pendingDiscoveryCandidate.value.name])
    : tr("请选择要把扫描结果纳管到的服务。");
}

function openDeploymentEdit(deployment: Deployment) {
  editingDeploymentId.value = deployment.id;
  manualDeployment.value = deployment.origin === "manual";
  Object.assign(deploymentForm, {
    sshConnectionId: deployment.sshConnectionId ?? "",
    candidateKey: deployment.origin === "discovered" ? `${deployment.provider}:${deployment.externalId}` : "",
    provider: deployment.provider,
    externalId: deployment.externalId,
    displayName: deployment.displayName,
    origin: deployment.origin,
  });
  deploymentDialog.value = true;
}

async function saveDeployment() {
  if (!selectedService.value) return;
  if (!deploymentForm.sshConnectionId) return ElMessage.warning(tr("请选择 SSH 连接"));
  if (!manualDeployment.value && !deploymentForm.candidateKey) return ElMessage.warning(tr("请选择扫描到的服务"));
  if (!manualDeployment.value) {
    const candidate = candidateOptions.value.find((item) => item.key === deploymentForm.candidateKey);
    if (!candidate) return ElMessage.warning(tr("扫描候选已变化，请重新选择"));
    Object.assign(deploymentForm, {
      provider: candidate.provider,
      externalId: candidate.externalId,
      displayName: deploymentForm.displayName || candidate.name,
      origin: "discovered",
    });
  }
  if (!deploymentForm.externalId.trim()) return ElMessage.warning(tr("请选择扫描结果或填写服务标识"));
  saving.value = true;
  try {
    const body = JSON.stringify({
      sshConnectionId: deploymentForm.sshConnectionId,
      provider: deploymentForm.provider,
      externalId: deploymentForm.externalId,
      displayName: deploymentForm.displayName,
      origin: manualDeployment.value ? "manual" : deploymentForm.origin,
    });
    if (editingDeploymentId.value) await api(`/api/v1/service-deployments/${editingDeploymentId.value}`, { method: "PUT", body });
    else await api(`/api/v1/services/${selectedService.value.id}/deployments`, { method: "POST", body });
    deploymentDialog.value = false;
    await reload();
    ElMessage.success(tr("部署节点已保存"));
  } finally {
    saving.value = false;
  }
}

async function removeDeployment(deployment: Deployment) {
  await ElMessageBox.confirm(tr("从当前服务移除部署节点“{{0}}”？不会删除远程服务。", [deployment.displayName || deployment.externalId]), tr("移除部署节点"), { type: "warning" });
  await api(`/api/v1/service-deployments/${deployment.id}`, { method: "DELETE" });
  await reload();
}

function resolveScriptActionIcon(icon: ScriptActionIcon) {
  return scriptActionIconComponents[icon] ?? Terminal;
}

function resetScriptActionForm() {
  editingScriptActionId.value = "";
  Object.assign(scriptActionForm, { name: "", icon: "terminal", scriptBody: "" });
}

function beginScriptActionCreate() {
  resetScriptActionForm();
  scriptActionEditorOpen.value = true;
}

function beginScriptActionEdit(action: ScriptAction) {
  editingScriptActionId.value = action.id;
  Object.assign(scriptActionForm, {
    name: action.name,
    icon: action.icon,
    scriptBody: action.scriptBody ?? "",
  });
  scriptActionEditorOpen.value = true;
}

function openScriptActionManager(deployment: Deployment | null = null) {
  const service = selectedService.value;
  if (!service) return;
  Object.assign(scriptActionScope, {
    serviceId: service.id,
    deploymentId: deployment?.id ?? null,
    label: deployment ? (deployment.displayName || deployment.externalId) : service.name,
  });
  resetScriptActionForm();
  scriptActionEditorOpen.value = deployment ? deployment.scriptActions.length === 0 : service.scriptActions.length === 0;
  scriptActionManagerDialog.value = true;
}

async function saveScriptAction() {
  if (!scriptActionForm.name.trim()) return ElMessage.warning(tr("请输入按钮名称"));
  if (!scriptActionForm.scriptBody.trim()) return ElMessage.warning(tr("请输入脚本正文"));
  saving.value = true;
  try {
    const body = JSON.stringify({
      deploymentId: scriptActionScope.deploymentId,
      name: scriptActionForm.name,
      icon: scriptActionForm.icon,
      scriptBody: scriptActionForm.scriptBody,
    });
    if (editingScriptActionId.value) {
      await api(`/api/v1/service-script-actions/${editingScriptActionId.value}`, { method: "PUT", body });
    } else {
      await api(`/api/v1/services/${scriptActionScope.serviceId}/script-actions`, { method: "POST", body });
    }
    await reload(true);
    resetScriptActionForm();
    scriptActionEditorOpen.value = false;
    ElMessage.success(tr("功能按钮已保存"));
  } finally {
    saving.value = false;
  }
}

async function removeScriptAction(action: ScriptAction) {
  await ElMessageBox.confirm(tr("删除功能按钮“{{0}}”？脚本正文也会一并删除。", [action.name]), tr("删除功能按钮"), { type: "warning" });
  await api(`/api/v1/service-script-actions/${action.id}`, { method: "DELETE" });
  await reload(true);
  if (editingScriptActionId.value === action.id) {
    resetScriptActionForm();
    scriptActionEditorOpen.value = false;
  }
  ElMessage.success(tr("功能按钮已删除"));
}

async function executeScriptAction(action: ScriptAction) {
  const service = payload.value.services.find((item) => item.id === action.serviceId);
  if (!service) return;
  const deployment = action.deploymentId ? service.deployments.find((item) => item.id === action.deploymentId) : null;
  const targetDescription = deployment
    ? tr("节点“{{0}}”", [deployment.displayName || deployment.externalId])
    : tr("服务“{{0}}”的 {{1}} 个部署节点", [service.name, service.deployments.length]);
  await ElMessageBox.confirm(
    tr("确定执行功能“{{0}}”吗？脚本将通过已有 SSH 连接在{{1}}上以对应 SSH 用户运行。", [action.name, targetDescription]),
    tr("确认执行脚本"),
    { type: "warning", confirmButtonText: tr("执行") },
  );
  runningScriptActionId.value = action.id;
  try {
    scriptActionExecution.value = await api<ScriptActionExecution>(`/api/v1/service-script-actions/${action.id}/execute`, { method: "POST" });
    scriptActionResultDialog.value = true;
    if (scriptActionExecution.value.ok) ElMessage.success(tr("功能脚本执行成功"));
    else ElMessage.warning(tr("功能脚本执行完成，但有 {{0}} 个节点失败", [scriptActionExecution.value.failed]));
  } finally {
    runningScriptActionId.value = "";
  }
}

function formatScriptDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function scriptExecutionSummary(execution: ScriptActionExecution) {
  return tr("{{0}} 个成功 · {{1}} 个失败", [execution.succeeded, execution.failed]);
}

function openLogLinks() {
  if (!selectedService.value) return;
  selectedLogIds.value = [...selectedService.value.logIds];
  logDialog.value = true;
}

async function saveLogLinks() {
  if (!selectedService.value) return;
  saving.value = true;
  try {
    await api(`/api/v1/services/${selectedService.value.id}/logs`, { method: "PUT", body: JSON.stringify({ logIds: selectedLogIds.value }) });
    logDialog.value = false;
    await reload();
    ElMessage.success(tr("日志关联已更新"));
  } finally {
    saving.value = false;
  }
}

async function refreshHost(host: MonitorHost) {
  const next = new Set(refreshingHosts.value);
  next.add(host.sshConnectionId);
  refreshingHosts.value = next;
  try {
    await api(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/refresh`, { method: "POST" });
    await reload();
    const current = payload.value.hosts.find((item) => item.sshConnectionId === host.sshConnectionId);
    if (current?.monitorStatus === "missing") ElMessage.warning(tr("目标机器尚未安装 viron-monitor"));
    else ElMessage.success(tr("节点状态已刷新"));
  } finally {
    const updated = new Set(refreshingHosts.value);
    updated.delete(host.sshConnectionId);
    refreshingHosts.value = updated;
  }
}

function validMonitorInstallPath(value: string) {
  const path = value.trim().replace(/\/$/, "");
  const segments = path.slice(1).split("/");
  return /^\/opt\/[A-Za-z0-9._/-]+$/.test(path)
    && path !== "/opt"
    && segments.every((segment) => segment && segment !== "." && segment !== "..");
}

async function promptMonitorInstallPath(currentPath: string, message: string): Promise<string | null> {
  try {
    const result = await ElMessageBox.prompt(message, tr("修改监控安装目录"), {
      confirmButtonText: tr("重新预检"),
      cancelButtonText: tr("取消"),
      inputValue: currentPath === "/opt/viron/monitor" ? "/opt/viron/monitor-custom" : currentPath,
      inputPlaceholder: "/opt/viron/monitor-custom",
      inputValidator: (value) => validMonitorInstallPath(value) || tr("请输入 /opt 下不含空格和路径回退的绝对目录"),
    });
    return result.value.trim().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function installMonitorOnHost(host: MonitorHost) {
  const next = new Set(installingHosts.value);
  next.add(host.sshConnectionId);
  installingHosts.value = next;
  let installPath = host.installPath || "/opt/viron/monitor";
  try {
    while (true) {
      const response = await api<{ item: MonitorInstallPreflight }>(
        `/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/install/preflight`,
        { method: "POST", body: JSON.stringify({ installPath }) },
      );
      const preflight = response.item;
      if (preflight.pathState === "conflict") {
        const conflict = preflight.issues.find((item) => item.code === "MONITOR_INSTALL_PATH_CONFLICT");
        const replacement = await promptMonitorInstallPath(preflight.installPath, conflict?.message || tr("默认安装目录存在冲突，请修改安装目录"));
        if (!replacement) return;
        installPath = replacement;
        continue;
      }
      if (!preflight.canInstall) {
        await ElMessageBox.alert(preflight.issues.map((item) => item.message).join("\n"), tr("无法一键安装"), {
          confirmButtonText: tr("知道了"),
          type: "warning",
        });
        return;
      }
      const upgrading = preflight.pathState === "upgrade";
      const privilege = preflight.privilege === "root" ? "root" : tr("免密 sudo");
      await ElMessageBox.confirm(
        tr("目标主机：{{0}}\n安装目录：{{1}}\n安装版本：{{2}} · {{3}}\n执行权限：{{4}}\n\n确认后将上传安装包、写入 systemd 单元并启动监控服务。", [
          `${host.connectionName} (${host.host})`,
          preflight.installPath,
          preflight.packageVersion,
          preflight.architecture ?? preflight.machineArchitecture,
          privilege,
        ]),
        upgrading ? tr("确认更新监控服务") : tr("确认安装监控服务"),
        { confirmButtonText: upgrading ? tr("更新并重启") : tr("安装并启动"), cancelButtonText: tr("取消"), type: "warning" },
      );
      const started = await api<{ item: MonitorInstallTask }>(
        `/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/install-tasks`,
        { method: "POST", body: JSON.stringify({ installPath: preflight.installPath }) },
      );
      installTaskConnectionId.value = host.sshConnectionId;
      installTask.value = started.item;
      installProgressDialog.value = true;
      startInstallTaskPolling(host.sshConnectionId);
      return;
    }
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    if (error instanceof ApiError && error.code === "MONITOR_INSTALL_RUNNING") {
      await openInstallProgress(host);
      return;
    }
    ElMessage.error(error instanceof ApiError || error instanceof Error ? error.message : tr("监控服务安装失败"));
  } finally {
    const updated = new Set(installingHosts.value);
    updated.delete(host.sshConnectionId);
    installingHosts.value = updated;
  }
}

async function clearMonitorData(host: MonitorHost) {
  try {
    await ElMessageBox.confirm(
      tr("仅清理目标 SSH 主机上的 viron-monitor 本地缓冲，Viron 服务端已经入库的监控数据不会删除。确定继续吗？"),
      tr("清理节点监控数据"),
      { confirmButtonText: tr("清理本地缓冲"), cancelButtonText: tr("取消"), type: "warning" },
    );
  } catch {
    return;
  }
  const next = new Set(clearingHosts.value);
  next.add(host.sshConnectionId);
  clearingHosts.value = next;
  try {
    const result = await api<{ cleared: { samples: number; gaps: number } }>(
      `/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/clear`,
      { method: "POST" },
    );
    ElMessage.success(tr("已清理目标机本地缓冲：{{0}} 条样本，{{1}} 条缺口记录", [result.cleared.samples, result.cleared.gaps]));
  } finally {
    const updated = new Set(clearingHosts.value);
    updated.delete(host.sshConnectionId);
    clearingHosts.value = updated;
  }
}

async function runMaintenanceAction(deployment: Deployment, action: "start" | "stop" | "restart") {
  const actionLabel = ({ start: tr("启动"), stop: tr("停止"), restart: tr("重启") })[action];
  await ElMessageBox.confirm(tr("确定要{{0}}“{{1}}”吗？命令将在 {{2}} 上执行。", [actionLabel, deployment.displayName || deployment.externalId, deployment.sshConnectionName]), tr("确认维护动作"), { type: action === "stop" ? "warning" : "info" });
  runningAction.value = `${deployment.id}:${action}`;
  try {
    const result = await api<{ monitorWarning?: string }>(`/api/v1/service-deployments/${deployment.id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
    await reload();
    if (result.monitorWarning) ElMessage.warning(tr("动作已完成，但状态刷新失败：{{0}}", [result.monitorWarning]));
    else ElMessage.success(tr("{{0}}动作已完成", [actionLabel]));
  } finally {
    runningAction.value = "";
  }
}

onMounted(() => {
  void load().catch((error) => ElMessage.error(error instanceof Error ? error.message : tr("读取服务维护数据失败")));
  startAutoRefresh();
});
onActivated(() => {
  void load(true).catch(() => undefined);
  startAutoRefresh();
  if (installTaskConnectionId.value) void refreshInstallTask(installTaskConnectionId.value, false);
});
onDeactivated(() => {
  stopAutoRefresh();
  stopInstallTaskPolling();
});
onBeforeUnmount(() => {
  stopAutoRefresh();
  stopInstallTaskPolling();
});
</script>

<template>
  <section class="maintenance-console" v-loading="loading">
    <header class="maintenance-toolbar">
      <div class="maintenance-summary" :aria-label="$t('服务维护')">
        <span v-for="item in attentionItems" :key="item.key"><i :class="item.key === 'problems' || item.key === 'offline' ? 'is-amber' : 'is-muted'"></i><strong>{{ item.value }}</strong><small>{{ item.label }}</small></span>
        <span v-if="!attentionItems.length" class="is-quiet"><i class="is-green"></i><strong>{{ runningDeployments }}</strong><small>{{ $t('运行节点') }}</small></span>
      </div>
      <div v-if="payload.canConfigure" class="maintenance-toolbar__actions">
        <el-button :type="payload.alertSettings.enabled ? 'warning' : 'default'" plain @click="openAlertSettings"><BellRing :size="16" />{{ $t('告警设置') }}</el-button>
        <el-button v-if="activeWorkspace !== 'host'" type="primary" @click="openServiceCreate()"><Plus :size="16" />{{ $t('录入服务') }}</el-button>
      </div>
    </header>

    <div v-if="payload.services.length || payload.hosts.length" class="maintenance-layout">
      <aside class="maintenance-directory" :class="{ 'has-no-services': !payload.services.length }">
        <section class="directory-group">
          <header><h3>{{ $t('服务清单') }}</h3><RefreshCw v-if="savingServiceOrder" :size="13" class="is-spinning" /><span>{{ payload.services.length }}</span></header>
          <div class="directory-list">
            <article
              v-for="service in payload.services"
              :key="service.id"
              class="service-index__row"
              :class="{
                'is-active': activeWorkspace === 'service' && selectedService?.id === service.id,
                'is-dragging': draggingDirectory?.kind === 'service' && draggingDirectory.id === service.id,
                'is-drop-before': serviceDropTarget?.id === service.id && !serviceDropTarget.after,
                'is-drop-after': serviceDropTarget?.id === service.id && serviceDropTarget.after,
              }"
              :data-directory-id="service.id"
              @dragover="dragDirectoryOver('service', service.id, $event)"
              @dragleave="leaveDirectoryDropTarget('service', $event)"
              @drop="dropDirectoryItem('service', service.id, $event)"
            >
              <span v-if="payload.canConfigure" class="directory-row__grip" :class="{ 'is-disabled': !canSortDirectory }" :draggable="canSortDirectory" :title="$t('拖动服务排序')" aria-hidden="true" @dragstart="startDirectoryDrag('service', service.id, $event)" @dragend="endDirectoryDrag"><GripVertical :size="14" /></span>
              <span v-else class="directory-row__spacer"></span>
              <button class="directory-row__main" type="button" :aria-pressed="activeWorkspace === 'service' && selectedService?.id === service.id" @click="selectService(service.id)">
                <span class="service-mark" :class="`is-${summarizeService(service).status}`"><Box :size="16" /></span>
                <span><strong>{{ service.name }}</strong><small>{{ summarizeService(service).label }}<template v-if="service.deployments.length"> · {{ service.deployments.length }} {{ $t('节点') }}</template></small></span>
              </button>
              <el-dropdown v-if="payload.canConfigure" class="directory-row__menu-target" trigger="click" placement="bottom-end" @command="handleDirectoryMove('service', service.id, $event)">
                <button class="directory-row__menu" type="button" :disabled="!canSortDirectory" :aria-label="$t('调整服务顺序')" :title="$t('调整服务顺序')"><EllipsisVertical :size="14" /></button>
                <template #dropdown><el-dropdown-menu><el-dropdown-item command="up" :disabled="!canMoveDirectoryItem('service', service.id, 'up')"><ArrowUp :size="14" />{{ $t('上移') }}</el-dropdown-item><el-dropdown-item command="down" :disabled="!canMoveDirectoryItem('service', service.id, 'down')"><ArrowDown :size="14" />{{ $t('下移') }}</el-dropdown-item></el-dropdown-menu></template>
              </el-dropdown>
            </article>
            <div v-if="!payload.services.length" class="directory-empty"><Box :size="17" /><span>{{ $t('尚未录入服务') }}</span></div>
          </div>
        </section>

        <section class="directory-group directory-group--hosts">
          <header><h3>{{ $t('SSH 宿主机') }}</h3><RefreshCw v-if="savingHostOrder" :size="13" class="is-spinning" /><span>{{ payload.hosts.length }}</span></header>
          <div class="directory-list">
            <article
              v-for="host in payload.hosts"
              :key="host.sshConnectionId"
              class="host-index__row"
              :class="{
                'is-active': activeWorkspace === 'host' && selectedHost?.sshConnectionId === host.sshConnectionId,
                'is-dragging': draggingDirectory?.kind === 'host' && draggingDirectory.id === host.sshConnectionId,
                'is-drop-before': hostDropTarget?.id === host.sshConnectionId && !hostDropTarget.after,
                'is-drop-after': hostDropTarget?.id === host.sshConnectionId && hostDropTarget.after,
              }"
              :data-directory-id="host.sshConnectionId"
              @dragover="dragDirectoryOver('host', host.sshConnectionId, $event)"
              @dragleave="leaveDirectoryDropTarget('host', $event)"
              @drop="dropDirectoryItem('host', host.sshConnectionId, $event)"
            >
              <span v-if="payload.canConfigure" class="directory-row__grip" :class="{ 'is-disabled': !canSortDirectory }" :draggable="canSortDirectory" :title="$t('拖动宿主机排序')" aria-hidden="true" @dragstart="startDirectoryDrag('host', host.sshConnectionId, $event)" @dragend="endDirectoryDrag"><GripVertical :size="14" /></span>
              <span v-else class="directory-row__spacer"></span>
              <button class="directory-row__main" type="button" :aria-pressed="activeWorkspace === 'host' && selectedHost?.sshConnectionId === host.sshConnectionId" @click="selectHost(host.sshConnectionId)"><Server :size="15" /><span><strong>{{ host.connectionName }}</strong><small>{{ hostPresence(host).label }}<template v-if="hostLiveCpu(host)"> · CPU {{ hostLiveCpu(host) }}</template></small></span><i :class="`is-${hostPresence(host).key}`"></i></button>
              <el-dropdown v-if="payload.canConfigure" class="directory-row__menu-target" trigger="click" placement="bottom-end" @command="handleDirectoryMove('host', host.sshConnectionId, $event)">
                <button class="directory-row__menu" type="button" :disabled="!canSortDirectory" :aria-label="$t('调整宿主机顺序')" :title="$t('调整宿主机顺序')"><EllipsisVertical :size="14" /></button>
                <template #dropdown><el-dropdown-menu><el-dropdown-item command="up" :disabled="!canMoveDirectoryItem('host', host.sshConnectionId, 'up')"><ArrowUp :size="14" />{{ $t('上移') }}</el-dropdown-item><el-dropdown-item command="down" :disabled="!canMoveDirectoryItem('host', host.sshConnectionId, 'down')"><ArrowDown :size="14" />{{ $t('下移') }}</el-dropdown-item></el-dropdown-menu></template>
              </el-dropdown>
            </article>
          </div>
        </section>
      </aside>

      <main class="maintenance-workspace">
        <template v-if="activeWorkspace === 'service' && selectedService">
          <header class="service-stage__header">
            <div>
              <div class="service-title-line"><h3>{{ selectedService.name }}</h3><span class="status-seal" :class="`is-${serviceSummary.status}`"><Activity :size="15" />{{ serviceSummary.label }}</span></div>
              <p v-if="selectedService.description">{{ selectedService.description }}</p>
            </div>
            <div v-if="payload.canConfigure" class="service-stage__actions">
              <button v-if="payload.scriptActionsSupported" type="button" :title="$t('管理服务功能按钮')" :aria-label="$t('管理服务功能按钮')" @click="openScriptActionManager()"><Settings2 :size="16" /></button>
              <button type="button" :title="$t('关联日志')" :aria-label="$t('关联日志')" @click="openLogLinks"><FileText :size="16" /></button>
              <button type="button" :title="$t('编辑服务')" :aria-label="$t('编辑服务')" @click="openServiceEdit"><Pencil :size="16" /></button>
              <button type="button" class="is-danger" :title="$t('删除服务')" :aria-label="$t('删除服务')" @click="removeService"><Trash2 :size="16" /></button>
              <el-button type="primary" plain @click="openDeploymentCreate()"><Plus :size="15" />{{ $t('添加部署节点') }}</el-button>
            </div>
          </header>

          <div v-if="payload.scriptActionsSupported && (selectedService.scriptActions.length || payload.canConfigure)" class="service-script-ribbon">
            <span class="service-script-ribbon__label"><Zap :size="15" />{{ $t('服务功能') }}</span>
            <button
              v-for="action in selectedService.scriptActions"
              :key="action.id"
              type="button"
              class="script-action-button"
              :disabled="runningScriptActionId !== '' || selectedService.status !== 'active' || !selectedService.deployments.length || !payload.canOperate"
              @click="executeScriptAction(action)"
            >
              <component :is="resolveScriptActionIcon(action.icon)" :size="15" />
              <span>{{ action.name }}</span>
              <RefreshCw v-if="runningScriptActionId === action.id" :size="13" class="is-spinning" />
            </button>
            <button v-if="payload.canConfigure && !selectedService.scriptActions.length" type="button" class="script-action-add" @click="openScriptActionManager()"><Plus :size="14" />{{ $t('添加功能按钮') }}</button>
          </div>

          <div v-if="selectedLogs.length" class="service-log-ribbon">
            <FileText :size="15" /><span>{{ $t('关联日志') }}</span>
            <button v-for="log in selectedLogs" :key="log.id" type="button" @click="emit('open-log', log.id)">{{ log.name }}<small>{{ log.connectionName }}</small></button>
          </div>

          <section class="deployment-grid">
            <article v-for="deployment in selectedService.deployments" :key="deployment.id" class="deployment-card" :class="`is-${deployment.status}`">
              <header>
                <span class="deployment-provider">{{ providerLabel(deployment.provider) }}</span>
                <span class="deployment-status"><i></i>{{ statusLabel(deployment.status) }}</span>
                <div v-if="payload.canConfigure" class="deployment-card__tools">
                  <button v-if="payload.scriptActionsSupported" type="button" :title="$t('管理节点功能按钮')" :aria-label="$t('管理节点功能按钮')" @click="openScriptActionManager(deployment)"><Settings2 :size="14" /></button>
                  <button type="button" :title="$t('编辑部署节点')" :aria-label="$t('编辑部署节点')" @click="openDeploymentEdit(deployment)"><Pencil :size="14" /></button>
                  <button type="button" class="is-danger" :title="$t('移除部署节点')" :aria-label="$t('移除部署节点')" @click="removeDeployment(deployment)"><Trash2 :size="14" /></button>
                </div>
              </header>
              <div class="deployment-card__identity">
                <strong>{{ deployment.displayName || deployment.externalId }}</strong>
                <code>{{ deploymentIdentity(deployment) }}</code>
              </div>
              <dl>
                <div><dt>{{ $t('SSH 主机') }}</dt><dd>{{ deployment.sshConnectionName }}</dd></div>
                <div><dt>{{ $t('服务状态') }}</dt><dd>{{ deployment.state || $t('尚未采集') }}</dd></div>
                <template v-if="deployment.provider === 'kubernetes'">
                  <div><dt>{{ $t('期望副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'desiredReplicas') }}</dd></div>
                  <div><dt>{{ $t('就绪副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'readyReplicas') }}</dd></div>
                  <div><dt>{{ $t('可用副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'availableReplicas') }}</dd></div>
                  <div><dt>{{ $t('已更新副本') }}</dt><dd>{{ kubernetesMetric(deployment, 'updatedReplicas') }}</dd></div>
                </template>
                <template v-else>
                  <div><dt>CPU</dt><dd>{{ formatPercent(deployment.metrics.cpuUsedPercent) }}</dd></div>
                  <div><dt>{{ $t('内存') }}</dt><dd>{{ formatBytes(deployment.metrics.memoryBytes) }}</dd></div>
                  <div><dt>{{ $t('运行时间') }}</dt><dd>{{ formatDuration(deployment.metrics.uptimeSeconds) }}</dd></div>
                  <div><dt>{{ $t('重启次数') }}</dt><dd>{{ deployment.metrics.restartCount ?? '—' }}</dd></div>
                </template>
              </dl>
              <div v-if="deployment.scriptActions.length" class="deployment-script-actions">
                <button
                  v-for="action in deployment.scriptActions"
                  :key="action.id"
                  type="button"
                  class="script-action-button is-node"
                  :disabled="runningScriptActionId !== '' || selectedService.status !== 'active' || !deployment.connectionAvailable"
                  @click="executeScriptAction(action)"
                >
                  <component :is="resolveScriptActionIcon(action.icon)" :size="14" />
                  <span>{{ action.name }}</span>
                  <RefreshCw v-if="runningScriptActionId === action.id" :size="12" class="is-spinning" />
                </button>
              </div>
              <p v-if="!deployment.connectionAvailable" class="deployment-warning">{{ $t('原 SSH 连接已删除或移出环境，请修复部署节点。') }}</p>
              <footer>
                <span>{{ formatTime(deployment.lastCheckedAt) }}</span>
                <div v-if="payload.canOperate && selectedService.status === 'active' && supportsMaintenanceActions(deployment.provider)">
                  <button type="button" :disabled="runningAction !== '' || !deployment.connectionAvailable" :title="$t('启动')" :aria-label="$t('启动')" @click="runMaintenanceAction(deployment, 'start')"><Play :size="14" /></button>
                  <button type="button" :disabled="runningAction !== '' || !deployment.connectionAvailable" :title="$t('停止')" :aria-label="$t('停止')" @click="runMaintenanceAction(deployment, 'stop')"><Square :size="13" /></button>
                  <button type="button" :disabled="runningAction !== '' || !deployment.connectionAvailable" :title="$t('重启')" :aria-label="$t('重启')" @click="runMaintenanceAction(deployment, 'restart')"><RotateCw :size="14" :class="{ 'is-spinning': runningAction === `${deployment.id}:restart` }" /></button>
                </div>
                <small v-else-if="unsupportedMaintenanceActionReason(deployment.provider)" class="deployment-action-note">{{ unsupportedMaintenanceActionReason(deployment.provider) }}</small>
              </footer>
            </article>
            <button v-if="payload.canConfigure && !selectedService.deployments.length" class="deployment-empty-action" type="button" @click="openDeploymentCreate()"><Plus :size="18" /><strong>{{ $t('添加部署节点') }}</strong></button>
          </section>
          <DeploymentMonitorDashboard
            v-if="selectedService.deployments.length"
            :key="selectedService.id"
            :environment-id="environmentId"
            :deployments="selectedService.deployments"
          />
        </template>

        <section v-else-if="activeWorkspace === 'host' && selectedHost" class="host-observatory">
          <header>
            <div>
              <h3>{{ selectedHost.connectionName }}</h3>
              <p :title="`${selectedHost.username}@${selectedHost.host}:${selectedHost.port} · ${formatTime(selectedHost.lastCollectedAt)}`">{{ hostPresence(selectedHost).label }} · {{ formatRelativeCollected(selectedHost.lastCollectedAt) }}<template v-if="selectedHost.snapshot?.operatingSystem"> · {{ selectedHost.snapshot.operatingSystem }} {{ selectedHost.snapshot.architecture }}</template></p>
              <p v-if="selectedHost.lastError && selectedHost.snapshot" class="deployment-warning">{{ localizeMessage(selectedHost.lastError) }}</p>
            </div>
            <div v-if="payload.canOperate" class="host-observatory__actions">
              <el-button v-if="selectedInstallTask && (isInstallTaskActive(selectedInstallTask) || selectedInstallTask.status === 'error')" :disabled="installingHosts.has(selectedHost.sshConnectionId)" :type="selectedInstallTask.status === 'error' ? 'danger' : 'primary'" plain @click="openInstallProgress(selectedHost)"><Clock3 v-if="isInstallTaskActive(selectedInstallTask)" :size="15" /><CircleAlert v-else :size="15" />{{ isInstallTaskActive(selectedInstallTask) ? $t('查看安装进度') : $t('查看安装失败详情') }}</el-button>
              <el-button v-else-if="selectedHost.monitorUpdateAvailable || !isMonitorInstalled(selectedHost)" :loading="installingHosts.has(selectedHost.sshConnectionId)" :disabled="refreshingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId)" type="primary" @click="installMonitorOnHost(selectedHost)"><Download :size="15" />{{ isMonitorInstalled(selectedHost) ? $t('更新监控服务') : $t('一键安装监控服务') }}</el-button>
              <el-button :loading="refreshingHosts.has(selectedHost.sshConnectionId)" :disabled="installingHosts.has(selectedHost.sshConnectionId) || clearingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)" @click="refreshHost(selectedHost)"><RefreshCw :size="15" />{{ $t('刷新') }}</el-button>
              <el-dropdown v-if="isMonitorInstalled(selectedHost) || selectedHost.installPath" trigger="click" placement="bottom-end">
                <button class="host-observatory__more" type="button" :aria-label="$t('更多操作')"><EllipsisVertical :size="16" /></button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-if="selectedHost.installPath" disabled>{{ selectedHost.installManaged ? $t('Viron 托管') : $t('手工安装') }} · {{ selectedHost.installPath }}</el-dropdown-item>
                    <el-dropdown-item v-if="isMonitorInstalled(selectedHost)" :disabled="installingHosts.has(selectedHost.sshConnectionId) || refreshingHosts.has(selectedHost.sshConnectionId) || isInstallTaskActive(selectedInstallTask)" @click="clearMonitorData(selectedHost)">{{ $t('清理监控数据') }}</el-dropdown-item>
                    <el-dropdown-item @click="refreshHost(selectedHost)">{{ $t('扫描并拉取') }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </header>
          <nav class="host-workspace-tabs" role="tablist" :aria-label="$t('宿主机工作区')">
            <button type="button" role="tab" :aria-selected="hostWorkspaceTab === 'monitor'" :class="{ 'is-active': hostWorkspaceTab === 'monitor' }" @click="hostWorkspaceTab = 'monitor'"><Activity :size="18" />{{ $t('监控') }}</button>
            <button type="button" role="tab" :aria-selected="hostWorkspaceTab === 'discovery'" :class="{ 'is-active': hostWorkspaceTab === 'discovery' }" @click="hostWorkspaceTab = 'discovery'"><ScanSearch :size="18" />{{ $t('服务发现') }}<small v-if="selectedUnmanagedCount">{{ selectedUnmanagedCount }}</small><small v-else-if="selectedHost.candidates.length" class="is-muted">{{ selectedHost.candidates.length }}</small></button>
          </nav>
          <div v-if="hostWorkspaceTab === 'monitor'" class="host-observatory__pane" role="tabpanel">
            <div v-if="selectedHost.snapshot" class="host-metric-grid" role="group" :aria-label="$t('当前快照')">
              <button type="button" :class="['is-' + metricTone(selectedHost.snapshot.cpuUsedPercent, cpuVisualThreshold), { 'is-active': hostFocusMetric === 'cpu' }]" @click="hostFocusMetric = 'cpu'"><span>CPU</span><strong>{{ formatPercent(selectedHost.snapshot.cpuUsedPercent) }}</strong><small>{{ selectedHost.snapshot.cpuCount || '—' }} {{ $t('核') }} · {{ selectedHost.snapshot.load1.toFixed(2) }}</small><i :style="{ width: Math.min(100, selectedHost.snapshot.cpuUsedPercent || 0) + '%' }"></i></button>
              <button type="button" :class="['is-' + metricTone(selectedHost.snapshot.memoryUsedPercent, memoryVisualThreshold), { 'is-active': hostFocusMetric === 'memory' }]" @click="hostFocusMetric = 'memory'"><span>{{ $t('内存') }}</span><strong>{{ formatPercent(selectedHost.snapshot.memoryUsedPercent) }}</strong><small>{{ formatBytes(selectedHost.snapshot.memoryUsedBytes) }} / {{ formatBytes(selectedHost.snapshot.memoryTotalBytes) }}</small><i :style="{ width: Math.min(100, selectedHost.snapshot.memoryUsedPercent || 0) + '%' }"></i></button>
              <button type="button" :class="['is-' + metricTone(selectedWorstDisk?.usedPercent, diskVisualThreshold), { 'is-active': hostFocusMetric === 'disk' }]" @click="hostFocusMetric = 'disk'"><span>{{ $t('磁盘') }}</span><strong>{{ formatPercent(selectedWorstDisk?.usedPercent) }}</strong><small>{{ selectedWorstDisk?.path || '—' }} · {{ selectedHost.snapshot.disks.length }} {{ $t('挂载点') }}</small><i :style="{ width: Math.min(100, selectedWorstDisk?.usedPercent || 0) + '%' }"></i></button>
              <button v-if="selectedHost.snapshot.temperatures.length" type="button" :class="{ 'is-active': hostFocusMetric === 'temperature' }" @click="hostFocusMetric = 'temperature'"><span>{{ $t('温度') }}</span><strong>{{ Math.max(...selectedHost.snapshot.temperatures.map((item) => item.celsius)).toFixed(1) }}°C</strong><small>{{ selectedHost.snapshot.temperatures[0]?.chip }}</small></button>
              <div class="host-metric-uptime"><span>{{ $t('运行时间') }}</span><strong>{{ formatDuration(selectedHost.snapshot.uptimeSeconds) }}</strong></div>
            </div>
            <HostMonitorDashboard
              v-if="selectedHost.snapshot"
              v-model:focus-metric="hostFocusMetric"
              :environment-id="environmentId"
              :host-id="selectedHost.sshConnectionId"
              :last-collected-at="selectedHost.lastCollectedAt"
              :cpu-threshold="cpuVisualThreshold"
              :memory-threshold="memoryVisualThreshold"
              :disk-threshold="diskVisualThreshold"
            />
            <div v-else class="host-observatory__empty" :class="`is-${selectedHost.monitorStatus}`">
              <Power :size="24" /><div><strong>{{ selectedHost.monitorStatus === 'missing' ? $t('尚未安装 viron-monitor') : $t('尚未取得监控数据') }}</strong><p>{{ selectedHost.lastError || $t('点击“一键安装监控服务”，Viron 会预检权限和目录后通过现有 SSH 链路自动安装。') }}</p></div>
            </div>
          </div>
          <div v-else class="host-observatory__pane is-discovery" role="tabpanel">
            <ServiceDiscoveryPanel
              :host-id="selectedHost.sshConnectionId"
              :candidates="selectedHost.candidates"
              :kubernetes-configs="selectedHost.kubernetesConfigs"
              :services="payload.services"
              :managed-keys="discoveryManagedKeys"
              :can-configure="payload.canConfigure"
              :can-operate="payload.canOperate"
              :target-service-id="discoveryTargetServiceId"
              @enroll="beginCandidateEnrollment"
              @update:target-service-id="assignDiscoveryTarget"
              @create-service="openServiceCreate(true)"
              @configure-kubernetes="openKubernetesConfiguration"
            />
          </div>
        </section>

        <div v-else class="workspace-empty"><Wrench :size="26" /><strong>{{ $t('尚未录入服务') }}</strong><el-button v-if="payload.canConfigure" type="primary" @click="openServiceCreate()"><Plus :size="16" />{{ $t('录入服务') }}</el-button></div>
      </main>
    </div>

    <div v-else class="maintenance-zero-state"><Server :size="30" /><h3>{{ $t('当前环境还没有可维护资源') }}</h3></div>

    <el-dialog v-model="scriptActionManagerDialog" align-center class="envman-dialog script-action-manager-dialog" :title="$t('{{0}} · 功能按钮', [scriptActionScope.label])" width="760px">
      <section class="script-action-manager">
        <header>
          <div><strong>{{ scriptActionScope.deploymentId ? $t('节点功能按钮') : $t('服务功能按钮') }}</strong><p>{{ scriptActionScope.deploymentId ? $t('点击后只在当前部署节点的 SSH 连接上执行。') : $t('点击后在当前服务的全部部署节点上执行。') }}</p></div>
          <el-button v-if="!scriptActionEditorOpen" type="primary" plain @click="beginScriptActionCreate"><Plus :size="15" />{{ $t('新建功能按钮') }}</el-button>
        </header>
        <div v-if="scopedScriptActions.length" class="script-action-manager__list">
          <article v-for="action in scopedScriptActions" :key="action.id" :class="{ 'is-editing': editingScriptActionId === action.id }">
            <span><component :is="resolveScriptActionIcon(action.icon)" :size="17" /></span>
            <div><strong>{{ action.name }}</strong><small>/bin/sh · {{ action.scriptBody?.length ?? 0 }} {{ $t('字符') }}</small></div>
            <button type="button" :title="$t('编辑')" @click="beginScriptActionEdit(action)"><Pencil :size="14" /></button>
            <button type="button" class="is-danger" :title="$t('删除')" @click="removeScriptAction(action)"><Trash2 :size="14" /></button>
          </article>
        </div>
        <div v-else-if="!scriptActionEditorOpen" class="script-action-manager__empty"><Terminal :size="23" /><strong>{{ $t('还没有功能按钮') }}</strong><p>{{ $t('创建后，按钮会直接显示在对应的服务或部署节点上。') }}</p></div>
        <section v-if="scriptActionEditorOpen" class="script-action-editor">
          <header><strong>{{ editingScriptActionId ? $t('编辑功能按钮') : $t('新建功能按钮') }}</strong><button type="button" :title="$t('关闭')" @click="scriptActionEditorOpen = false; resetScriptActionForm()">×</button></header>
          <el-form label-position="top">
            <el-form-item :label="$t('按钮名称')" required><el-input v-model="scriptActionForm.name" :maxlength="80" show-word-limit :placeholder="$t('例如：发布、清缓存、同步配置')" /></el-form-item>
            <el-form-item :label="$t('按钮图标')" required>
              <div class="script-icon-picker">
                <button v-for="icon in scriptActionIconOptions" :key="icon" type="button" :class="{ 'is-active': scriptActionForm.icon === icon }" :aria-label="icon" @click="scriptActionForm.icon = icon"><component :is="resolveScriptActionIcon(icon)" :size="18" /></button>
              </div>
            </el-form-item>
            <el-form-item :label="$t('脚本正文')" required>
              <el-input v-model="scriptActionForm.scriptBody" class="script-body-input" type="textarea" :rows="12" :maxlength="65536" :placeholder="$t('#!/bin/sh\nset -eu\n\n# 在此输入要通过 SSH 执行的脚本')" />
              <small class="script-action-editor__hint">{{ $t('脚本通过 /bin/sh 执行，使用部署节点对应 SSH 连接的登录用户和默认工作目录。') }}</small>
            </el-form-item>
          </el-form>
          <footer><el-button @click="scriptActionEditorOpen = false; resetScriptActionForm()">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveScriptAction">{{ $t('保存功能按钮') }}</el-button></footer>
        </section>
      </section>
      <template #footer><el-button @click="scriptActionManagerDialog = false">{{ $t('关闭') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="scriptActionResultDialog" align-center class="envman-dialog script-action-result-dialog" :title="$t('功能脚本执行结果')" width="780px">
      <section v-if="scriptActionExecution" class="script-action-results">
        <header :class="scriptActionExecution.ok ? 'is-success' : 'is-warning'">
          <span><Check v-if="scriptActionExecution.ok" :size="18" /><CircleAlert v-else :size="18" /></span>
          <div><strong>{{ scriptActionExecution.action.name }}</strong><p>{{ scriptExecutionSummary(scriptActionExecution) }}</p></div>
        </header>
        <article v-for="result in scriptActionExecution.results" :key="result.deploymentId" :class="result.ok ? 'is-success' : 'is-error'">
          <header><span><Check v-if="result.ok" :size="15" /><CircleAlert v-else :size="15" /></span><div><strong>{{ result.targetName }}</strong><small>{{ result.connectionName }} · {{ formatScriptDuration(result.durationMs) }} · exit {{ result.exitCode ?? '—' }}</small></div></header>
          <p v-if="result.message" class="script-action-result__message">{{ localizeMessage(result.message) }}</p>
          <details v-if="result.stdout || result.stderr">
            <summary>{{ $t('查看输出') }}<small v-if="result.truncated">{{ $t('输出已截断') }}</small></summary>
            <div v-if="result.stdout"><strong>stdout</strong><pre>{{ result.stdout }}</pre></div>
            <div v-if="result.stderr"><strong>stderr</strong><pre>{{ result.stderr }}</pre></div>
          </details>
        </article>
      </section>
      <template #footer><el-button type="primary" @click="scriptActionResultDialog = false">{{ $t('关闭') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="installProgressDialog" align-center class="envman-dialog monitor-install-progress-dialog" :close-on-click-modal="false" :title="$t('监控服务安装进度')" width="720px">
      <section v-if="selectedInstallTask" class="monitor-install-progress">
        <header class="monitor-install-progress__summary" :class="`is-${selectedInstallTask.status}`">
          <span class="monitor-install-progress__status"><Check v-if="selectedInstallTask.status === 'success'" :size="19" /><CircleAlert v-else-if="selectedInstallTask.status === 'error'" :size="19" /><RefreshCw v-else :size="18" class="is-spinning" /></span>
          <div><strong>{{ installTaskStatusLabel(selectedInstallTask) }}</strong><p>{{ localizeMessage(selectedInstallTask.currentMessage) }}</p></div>
          <time>{{ formatInstallTaskElapsed(selectedInstallTask) }}</time>
        </header>

        <dl class="monitor-install-progress__target">
          <div><dt>{{ $t('目标主机') }}</dt><dd>{{ selectedInstallTask.connectionName }}</dd></div>
          <div><dt>{{ $t('安装目录') }}</dt><dd><code>{{ selectedInstallTask.installPath }}</code></dd></div>
        </dl>

        <div class="monitor-install-progress__bar">
          <el-progress :percentage="selectedInstallTask.progress" :status="selectedInstallTask.status === 'error' ? 'exception' : selectedInstallTask.status === 'success' ? 'success' : undefined" :stroke-width="7" />
        </div>

        <ol class="monitor-install-steps">
          <li v-for="(step, index) in installTaskSteps" :key="step.phase" :class="`is-${installTaskStepState(index)}`">
            <span><Check v-if="installTaskStepState(index) === 'complete'" :size="14" /><CircleAlert v-else-if="installTaskStepState(index) === 'error'" :size="14" /><i v-else>{{ index + 1 }}</i></span>
            <div><strong>{{ step.label }}</strong><small>{{ step.description }}</small></div>
          </li>
        </ol>

        <details class="monitor-install-logs">
          <summary>{{ $t('详细日志') }}<small>{{ selectedInstallTask.logs.length }} {{ $t('条日志') }}</small><ChevronRight :size="15" /></summary>
          <div class="monitor-install-logs__body">
            <p v-for="(entry, index) in selectedInstallTask.logs" :key="`${entry.at}:${index}`" :class="`is-${entry.kind}`"><time>{{ formatInstallLogTime(entry.at) }}</time><code>{{ localizeMessage(entry.message) }}</code></p>
          </div>
        </details>
      </section>
      <div v-else class="monitor-install-progress__loading"><RefreshCw :size="20" class="is-spinning" />{{ $t('正在读取安装任务') }}</div>
      <template #footer>
        <el-button @click="installProgressDialog = false">{{ selectedInstallTask && isInstallTaskActive(selectedInstallTask) ? $t('关闭并在后台继续') : $t('关闭') }}</el-button>
        <el-button v-if="selectedInstallTask?.status === 'error' && selectedHost" type="primary" :loading="installingHosts.has(selectedHost.sshConnectionId)" @click="installMonitorOnHost(selectedHost)"><RefreshCw :size="15" />{{ $t('重新安装') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="servicePickerDialog" align-center class="envman-dialog discovery-service-picker-dialog" :title="$t('选择要纳管到的服务')" width="520px" @closed="onServicePickerClosed">
      <p class="log-dialog-intro">{{ discoveryPickerIntro() }}</p>
      <div class="discovery-service-picker">
        <button v-for="service in payload.services" :key="service.id" type="button" @click="pickServiceForDiscovery(service.id)">
          <span class="service-mark" :class="`is-${summarizeService(service).status}`"><Box :size="16" /></span>
          <span><strong>{{ service.name }}</strong><small>{{ summarizeService(service).label }} · {{ service.deployments.length }} {{ $t('节点') }}</small></span>
        </button>
      </div>
      <template #footer>
        <el-button @click="cancelServicePicker">{{ $t('取消') }}</el-button>
        <el-button type="primary" plain @click="createServiceFromDiscovery"><Plus :size="15" />{{ $t('录入新服务') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="serviceDialog" align-center class="envman-dialog" :title="editingServiceId ? $t('编辑服务') : $t('录入服务')" width="560px">
      <el-form label-position="top">
        <el-form-item :label="$t('服务名称')" required><el-input v-model="serviceForm.name" :placeholder="$t('例如：订单 API')" /></el-form-item>
        <el-form-item :label="$t('服务说明')"><el-input v-model="serviceForm.description" type="textarea" :rows="3" :placeholder="$t('说明服务职责、依赖或维护注意事项')" /></el-form-item>
        <el-form-item :label="$t('管理状态')"><el-radio-group v-model="serviceForm.status"><el-radio-button value="active">{{ $t('启用') }}</el-radio-button><el-radio-button value="disabled">{{ $t('停用') }}</el-radio-button></el-radio-group></el-form-item>
      </el-form>
      <template #footer><el-button @click="serviceDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveService">{{ $t('保存服务') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="deploymentDialog" align-center class="envman-dialog" :title="editingDeploymentId ? $t('编辑部署节点') : $t('纳管部署节点')" width="640px">
      <el-form label-position="top">
        <el-form-item :label="$t('SSH 连接')" required><el-select v-model="deploymentForm.sshConnectionId" style="width:100%" @change="Object.assign(deploymentForm, { candidateKey: '', externalId: '', displayName: '', origin: 'manual' })"><el-option v-for="host in payload.hosts" :key="host.sshConnectionId" :value="host.sshConnectionId" :label="`${host.connectionName} · ${host.username}@${host.host}`" /></el-select></el-form-item>
        <el-form-item><el-switch v-model="manualDeployment" :active-text="$t('手动录入')" /></el-form-item>
        <template v-if="!manualDeployment">
          <el-form-item :label="$t('扫描到的服务')" required><el-select v-model="deploymentForm.candidateKey" filterable style="width:100%" :placeholder="candidateOptions.length ? $t('选择要纳管的服务') : $t('请先扫描该 SSH 主机')"><el-option v-for="candidate in candidateOptions" :key="candidate.key" :value="candidate.key" :label="candidate.label" /></el-select></el-form-item>
        </template>
        <template v-else>
          <div class="deployment-form-grid">
            <el-form-item :label="$t('服务类型')" required><el-select v-model="deploymentForm.provider" style="width:100%"><el-option label="systemd" value="systemd" /><el-option label="Docker" value="docker" /><el-option label="Podman" value="podman" /><el-option label="Supervisor" value="supervisor" /><el-option :label="$t('普通进程（仅登记）')" value="process" /></el-select></el-form-item>
            <el-form-item :label="$t('服务标识')" required><el-input v-model="deploymentForm.externalId" :placeholder="$t('unit、容器 ID、Supervisor 名称或进程匹配式')" /></el-form-item>
          </div>
        </template>
        <el-form-item :label="$t('显示名称')"><el-input v-model="deploymentForm.displayName" :placeholder="$t('留空时使用扫描名称或服务标识')" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="deploymentDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveDeployment">{{ $t('保存部署节点') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="kubernetesDialog" align-center class="envman-dialog kubernetes-dialog" :title="$t('选择 Kubernetes 扫描范围')" width="680px">
      <p class="kubernetes-dialog__intro">{{ $t('Viron 只保存 kubeconfig 路径、集群和 context 等非敏感元数据；证书、Token 和私钥始终留在目标 SSH 主机。只有选中的 context 才会连接 Kubernetes API。') }}</p>
      <el-checkbox-group v-model="selectedKubernetesContextKeys" class="kubernetes-context-options">
        <el-checkbox v-for="item in selectableKubernetesConfigs" :key="kubernetesContextKey(item)" :value="kubernetesContextKey(item)">
          <span><strong>{{ item.context }}<small v-if="item.currentContext">{{ $t('当前') }}</small></strong><code>{{ item.path }}</code><small>{{ item.cluster }} · {{ item.namespace || 'default' }} · {{ kubernetesConfigStatusLabel(item) }}</small></span>
        </el-checkbox>
      </el-checkbox-group>
      <div v-if="!selectableKubernetesConfigs.length" class="service-log-options__empty">{{ $t('没有可选择的 kubeconfig context，请确认 viron-monitor 对配置文件具有读取权限。') }}</div>
      <template #footer><el-button @click="kubernetesDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="savingKubernetes" @click="saveKubernetesConfiguration">{{ $t('保存并立即扫描') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="logDialog" align-center class="envman-dialog" :title="$t('关联服务日志')" width="600px">
      <p class="log-dialog-intro">{{ $t('日志仍由环境日志模块统一配置，这里只建立快捷关联。') }}</p>
      <el-checkbox-group v-model="selectedLogIds" class="service-log-options">
        <el-checkbox v-for="log in payload.logs" :key="log.id" :value="log.id"><span><strong>{{ log.name }}</strong><small>{{ log.connectionName }} · {{ log.filePaths.join(', ') }}</small></span></el-checkbox>
      </el-checkbox-group>
      <div v-if="!payload.logs.length" class="service-log-options__empty">{{ $t('当前环境还没有日志配置，请先在“日志”页面添加。') }}</div>
      <template #footer><el-button @click="logDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveLogLinks">{{ $t('保存关联') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="alertSettingsDialog" align-center class="envman-dialog monitor-alert-settings-dialog" :title="$t('监控告警设置')" width="720px">
      <section class="monitor-alert-settings">
        <header>
          <div><strong>{{ $t('启用当前环境的监控告警') }}</strong><p>{{ $t('连续两次采集达到条件后触发，连续两次恢复正常后解除。') }}</p></div>
          <el-switch v-model="alertSettingsForm.enabled" />
        </header>
        <div class="monitor-alert-rule-list" :class="{ 'is-disabled': !alertSettingsForm.enabled }">
          <article class="is-switch-rule">
            <el-checkbox v-model="alertSettingsForm.hostOfflineEnabled">{{ $t('宿主机离线') }}</el-checkbox>
            <span>{{ $t('连续两次无法拉取监控数据，或采集数据持续未更新时告警') }}</span>
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.cpuEnabled">CPU</el-checkbox>
            <span>{{ $t('使用率达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.cpuThreshold" :min="1" :max="100" suffix="%" />
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.memoryEnabled">{{ $t('内存') }}</el-checkbox>
            <span>{{ $t('使用率达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.memoryThreshold" :min="1" :max="100" suffix="%" />
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.diskUsageEnabled">{{ $t('磁盘使用率') }}</el-checkbox>
            <span>{{ $t('任一挂载点达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.diskUsageThreshold" :min="1" :max="100" suffix="%" />
          </article>
          <article>
            <el-checkbox v-model="alertSettingsForm.temperatureEnabled">{{ $t('温度') }}</el-checkbox>
            <span>{{ $t('最高温度达到') }}</span>
            <AnimatedCounter v-model="alertSettingsForm.temperatureThreshold" :min="1" :max="200" suffix="°C" />
          </article>
          <article class="is-switch-rule">
            <el-checkbox v-model="alertSettingsForm.diskMissingEnabled">{{ $t('磁盘挂载变化') }}</el-checkbox>
            <span>{{ $t('磁盘新增、消失或恢复挂载连续确认两次后通知') }}</span>
          </article>
          <article class="is-switch-rule">
            <el-checkbox v-model="alertSettingsForm.deploymentStatusEnabled">{{ $t('部署节点状态') }}</el-checkbox>
            <span>{{ $t('已纳管节点进入停止或异常状态时告警') }}</span>
          </article>
        </div>
        <section class="monitor-alert-exclusions">
          <div>
            <strong>{{ $t('排除磁盘') }}</strong>
            <p>{{ $t('排除后不检查该磁盘的使用率和挂载变化。当前采集已自动过滤虚拟文件系统。') }}</p>
          </div>
          <el-select v-model="alertSettingsForm.excludedDisks" multiple filterable collapse-tags collapse-tags-tooltip :placeholder="$t('选择不需要监控的临时或可移动磁盘')">
            <el-option v-for="option in monitorDiskOptions" :key="option.key" :label="option.label" :value="option.key" />
          </el-select>
        </section>
      </section>
      <template #footer><el-button @click="alertSettingsDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="savingAlertSettings" @click="saveAlertSettings">{{ $t('保存告警设置') }}</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.maintenance-console {
  --ops-green: var(--color-accent-strong);
  --ops-blue: var(--color-info);
  --ops-amber: var(--color-warning);
  --ops-red: var(--color-danger);
  height: 100%;
  min-height: 0;
  border: 1px solid var(--ink-100);
  border-radius: 12px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  color: var(--color-ink);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-body);
}

.maintenance-toolbar {
  min-width: 0;
  min-height: 3.25rem;
  padding: .5rem .875rem;
  border-block-end: 1px solid var(--ink-100);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: .625rem 1rem;
  background: var(--surface);
}
.maintenance-toolbar__identity { min-width: 0; display: flex; align-items: center; gap: .625rem; }
.maintenance-toolbar__identity > span {
  width: 2.125rem;
  height: 2.125rem;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--teal-500) 32%, var(--ink-100));
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--teal-50);
  color: var(--teal-700);
}
.maintenance-toolbar__identity > div { min-width: 0; }

.maintenance-toolbar h2 {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-display);
  font-size: .9375rem;
  font-style: normal;
  font-weight: 750;
  line-height: 1.2;
}
.maintenance-toolbar__identity p { margin: .1875rem 0 0; color: var(--ink-400); font-size: .625rem; }

.maintenance-toolbar :deep(.el-button) { white-space: nowrap; }
.maintenance-toolbar__actions { display: flex; align-items: center; gap: .5rem; }
.maintenance-toolbar__actions :deep(.el-button + .el-button) { margin-left: 0; }

.maintenance-summary {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .25rem 1rem;
  color: var(--ink-500);
  font-variant-numeric: tabular-nums;
}

.maintenance-summary span {
  min-width: 0;
  min-height: 1.875rem;
  padding-inline: .625rem;
  border-inline-start: 1px solid var(--ink-100);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  gap: .125rem .375rem;
}

.maintenance-summary span:first-child { border-inline-start: 0; }
.maintenance-summary i { grid-row: 1 / -1; }
.maintenance-summary strong { color: var(--ink-800); font-family: var(--font-mono); font-size: .75rem; line-height: 1; }
.maintenance-summary small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .625rem; }
.maintenance-summary i,
.host-index__row i { width: .375rem; height: .375rem; border-radius: 50%; background: var(--ink-200); }
.is-green,
.host-index__row i.is-online,
.host-index__row i.is-ready { background: var(--ops-green) !important; }
.is-amber,
.host-index__row i.is-offline,
.host-index__row i.is-error { background: var(--ops-amber) !important; }
.is-blue { background: var(--ops-blue) !important; }
.is-muted,
.host-index__row i.is-missing,
.host-index__row i.is-unknown { background: var(--ink-200) !important; }

.maintenance-layout { min-height: 0; overflow: auto; background: var(--surface); }
.maintenance-directory {
  min-height: 0;
  height: 18rem;
  max-height: 18rem;
  border-block-end: 1px solid var(--ink-100);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--ink-50) 54%, var(--surface));
}

.directory-group { min-height: 0; flex: 0 1 44%; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
.directory-group--hosts { flex: 1 1 56%; border-block-start: 1px solid var(--ink-100); }
.maintenance-directory.has-no-services .directory-group:first-child { flex: 0 0 auto; }
.directory-group > header {
  min-height: 2.75rem;
  padding-inline: .875rem;
  border-block-end: 1px solid var(--ink-100);
  display: flex;
  align-items: center;
  gap: .5rem;
  background: color-mix(in srgb, var(--surface) 72%, transparent);
}
.directory-group h3 { min-width: 0; margin: 0; flex: 1; color: var(--ink-700); font-size: .6875rem; font-weight: 750; line-height: 1.2; }
.directory-group > header > svg { color: var(--ink-400); }
.directory-group > header > span {
  min-width: 1.5rem;
  height: 1.375rem;
  padding-inline: .375rem;
  border-radius: .6875rem;
  display: grid;
  place-items: center;
  background: var(--ink-100);
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: .5625rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.directory-list { min-height: 0; padding: .4375rem; overflow: auto; display: grid; align-content: start; gap: .125rem; }
.service-index__row,
.host-index__row {
  position: relative;
  width: 100%;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  display: grid;
  grid-template-columns: 1.5rem minmax(0, 1fr) 1.75rem;
  align-items: center;
  background: transparent;
  color: var(--ink-600);
  transition: background-color var(--dur-micro) var(--ease-out), border-color var(--dur-micro) var(--ease-out), opacity var(--dur-micro) var(--ease-out);
}
.service-index__row { min-height: 3.25rem; }
.host-index__row { min-height: 2.875rem; }
.service-index__row.is-active,
.host-index__row.is-active { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); background: var(--teal-50); color: var(--teal-700); }
.service-index__row.is-dragging,
.host-index__row.is-dragging { opacity: .42; }
.service-index__row.is-drop-before::before,
.host-index__row.is-drop-before::before,
.service-index__row.is-drop-after::after,
.host-index__row.is-drop-after::after { content: ""; position: absolute; z-index: 2; inset-inline: .375rem; height: 2px; border-radius: 2px; background: var(--teal-500); }
.service-index__row.is-drop-before::before,
.host-index__row.is-drop-before::before { top: -2px; }
.service-index__row.is-drop-after::after,
.host-index__row.is-drop-after::after { bottom: -2px; }
.directory-row__grip,
.directory-row__menu {
  width: 1.5rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--ink-300);
}
.directory-row__grip,
.directory-row__menu { opacity: 0; }
.directory-row__grip { cursor: grab; }
.service-index__row:hover .directory-row__grip,
.service-index__row:hover .directory-row__menu,
.service-index__row:focus-within .directory-row__grip,
.service-index__row:focus-within .directory-row__menu,
.host-index__row:hover .directory-row__grip,
.host-index__row:hover .directory-row__menu,
.host-index__row:focus-within .directory-row__grip,
.host-index__row:focus-within .directory-row__menu,
.directory-row__grip:focus-visible,
.directory-row__menu:focus-visible { opacity: 1; }
.directory-row__grip:active { cursor: grabbing; }
.directory-row__grip.is-disabled,
.directory-row__menu:disabled { opacity: .45; cursor: not-allowed; }
.directory-row__spacer { width: 1.5rem; }
.directory-row__main {
  min-width: 0;
  min-height: inherit;
  padding: .375rem .25rem;
  border: 0;
  display: grid;
  align-items: center;
  gap: .5rem;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.service-index__row .directory-row__main { grid-template-columns: 2rem minmax(0, 1fr); }
.host-index__row .directory-row__main { grid-template-columns: 1rem minmax(0, 1fr) auto; }
.directory-row__menu-target { width: 1.75rem; height: 2rem; display: block; }
.directory-row__menu { width: 1.75rem; cursor: pointer; }
.directory-row__main:focus-visible,
.directory-row__menu:focus-visible,
.service-stage__actions > button:not(.el-button):focus-visible,
.deployment-card__tools button:focus-visible,
.deployment-card footer button:focus-visible,
.service-log-ribbon button:focus-visible,
.script-action-button:focus-visible,
.script-action-add:focus-visible,
.script-icon-picker button:focus-visible,
.script-action-manager__list article > button:focus-visible,
.deployment-empty-action:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.directory-row__main > span { min-width: 0; }
.directory-row__main > span:not(.service-mark) { display: grid; gap: .125rem; }
.service-index__row strong,
.host-index__row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .6875rem; }
.service-index__row small,
.host-index__row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-400); font-size: .5625rem; }
.service-mark {
  width: 2rem;
  height: 2rem;
  border-radius: 7px;
  display: grid;
  place-items: center;
  background: var(--ink-100);
  color: var(--ink-400);
}
.service-mark.is-running { background: var(--teal-100); color: var(--teal-700); }
.service-mark.is-degraded { background: var(--amber-100); color: var(--amber-600); }
.directory-empty { min-height: 3rem; padding-inline: .75rem; display: flex; align-items: center; gap: .5rem; color: var(--ink-400); font-size: .625rem; }

.maintenance-workspace { min-width: 0; min-height: 0; padding: 1rem; overflow: visible; background: var(--surface); }
.host-observatory {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
}
.host-workspace-tabs {
  min-width: 0;
  margin-block-start: .125rem;
  padding: 3px;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  background: var(--ink-50);
}
.host-workspace-tabs button {
  min-width: 0;
  min-height: 2.125rem;
  padding: 0 .75rem;
  border: 0;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .375rem;
  background: transparent;
  color: var(--ink-500);
  font: inherit;
  font-size: .875rem;
  font-weight: 750;
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), box-shadow var(--dur-micro) var(--ease-out);
}
.host-workspace-tabs button.is-active {
  background: var(--surface);
  color: var(--teal-700);
  box-shadow: 0 1px 5px rgba(8, 22, 25, .1);
}
.host-workspace-tabs small {
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 .35rem;
  border-radius: 999px;
  display: inline-grid;
  place-items: center;
  background: var(--ink-100);
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: .75rem;
  font-variant-numeric: tabular-nums;
}
.host-workspace-tabs button.is-active small { background: var(--teal-50); color: var(--teal-700); }
.host-workspace-tabs small.is-muted { background: transparent; color: var(--ink-400); }
.host-workspace-tabs button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.host-observatory__pane { min-width: 0; min-height: 0; padding-block-start: var(--space-md); overflow: auto; }
.host-observatory:has(> .host-observatory__pane.is-discovery) {
  min-height: 100%;
  height: auto;
  grid-template-rows: auto auto auto;
}
.host-observatory__pane.is-discovery { overflow: visible; }
.discovery-service-picker { display: grid; gap: .375rem; }
.discovery-service-picker button {
  width: 100%;
  min-height: 3.25rem;
  padding: .5rem .75rem;
  border: 1px solid var(--color-rule);
  border-radius: 8px;
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  align-items: center;
  gap: .625rem;
  background: var(--color-paper);
  color: var(--color-ink);
  text-align: start;
  cursor: pointer;
  transition: border-color var(--dur-micro) var(--ease-out), background-color var(--dur-micro) var(--ease-out);
}
.discovery-service-picker button > span:last-child { min-width: 0; display: grid; gap: .125rem; }
.discovery-service-picker strong { overflow: hidden; font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.discovery-service-picker small { overflow: hidden; color: var(--color-muted); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.service-stage__header,
.host-observatory > header {
  min-width: 0;
  padding-block-end: var(--space-md);
  border-block-end: 1px solid var(--color-rule);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-md);
}
.host-observatory > header { border-block-end: 0; }
.service-stage__header > div:first-child,
.host-observatory > header > div { min-width: 0; }
.service-title-line { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
.service-stage__header h3,
.host-observatory h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-family: var(--font-display); font-size: 1rem; font-style: normal; font-weight: 750; line-height: 1.2; }
.service-stage__header p,
.host-observatory p { margin: var(--space-2xs) 0 0; color: var(--color-muted); font-size: var(--text-xs); line-height: 1.5; }
.host-observatory p.deployment-warning { color: var(--ops-red); }
.monitor-install-path {
  display: block;
  width: fit-content;
  max-width: 100%;
  margin-block-start: var(--space-xs);
  overflow: hidden;
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-observatory__actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.host-observatory__actions :deep(.el-button) { margin: 0; }
.host-observatory__more {
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: var(--color-paper);
  color: var(--color-ink-soft);
  cursor: pointer;
}
.status-seal {
  width: fit-content;
  padding: var(--space-2xs) var(--space-xs);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2xs);
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.status-seal.is-running { border-color: var(--color-accent); color: var(--ops-green); }
.status-seal.is-degraded { border-color: var(--color-warning); color: var(--ops-amber); }
.service-stage__actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.service-stage__actions > button:not(.el-button),
.deployment-card__tools button,
.deployment-card footer button {
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: var(--color-paper-raised);
  color: var(--color-muted);
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.service-stage__actions > button:not(.el-button):active,
.deployment-card__tools button:active,
.deployment-card footer button:active { transform: translateY(1px); }
.service-script-ribbon {
  padding-block: var(--space-sm);
  border-block-end: 1px solid var(--color-rule);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs);
}
.service-script-ribbon__label { margin-inline-end: var(--space-2xs); display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--color-muted); font-size: var(--text-xs); }
.script-action-button,
.script-action-add {
  min-width: 0;
  min-height: 2rem;
  padding: var(--space-2xs) var(--space-sm);
  border: 1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-rule));
  border-radius: var(--radius-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font: inherit;
  font-size: var(--text-xs);
  font-weight: 700;
  cursor: pointer;
  transition: border-color var(--dur-micro) var(--ease-out), background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.script-action-button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.script-action-button:hover:not(:disabled) { border-color: var(--color-accent); background: var(--color-paper-raised); }
.script-action-button:active:not(:disabled), .script-action-add:active { transform: translateY(1px); }
.script-action-button:disabled { opacity: .5; cursor: not-allowed; }
.script-action-add { border-style: dashed; background: transparent; color: var(--color-muted); font-weight: 600; }
.service-log-ribbon {
  padding-block: var(--space-sm);
  border-block-end: 1px solid var(--color-rule);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs);
  color: var(--color-muted);
  font-size: var(--text-xs);
}
.service-log-ribbon button {
  min-height: 2rem;
  padding-inline: var(--space-xs);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  background: var(--color-paper);
  color: var(--color-ink-soft);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.service-log-ribbon button:active { transform: translateY(1px); }
.service-log-ribbon button small { margin-inline-start: var(--space-2xs); color: var(--color-muted); }
.deployment-grid { padding-block-start: var(--space-md); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); }
.deployment-card {
  min-width: 0;
  min-height: 14.5rem;
  padding: var(--space-md);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-card);
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  background: var(--color-paper);
  color: var(--color-ink);
  box-shadow: none;
}
.deployment-card > header { display: flex; align-items: center; gap: var(--space-xs); }
.deployment-provider {
  padding: var(--space-2xs) var(--space-xs);
  border-radius: var(--radius-control);
  background: var(--color-rule);
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  line-height: 1;
}
.deployment-status { display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--color-muted); font-size: var(--text-xs); }
.deployment-status i { width: .375rem; height: .375rem; border-radius: 50%; background: currentColor; }
.deployment-card.is-running .deployment-status { color: var(--ops-green); }
.deployment-card.is-degraded .deployment-status,
.deployment-card.is-stopped .deployment-status { color: var(--ops-amber); }
.deployment-card__tools { margin-inline-start: auto; display: flex; gap: var(--space-2xs); }
.deployment-card__tools button { width: 2rem; height: 2rem; border-color: transparent; background: transparent; }
.deployment-card__identity { min-width: 0; padding-block: var(--space-md) var(--space-sm); display: grid; gap: var(--space-2xs); }
.deployment-card__identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-base); }
.deployment-card code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); line-height: 1.35; }
.deployment-card dl { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
.deployment-card dl div { min-width: 0; }
.deployment-card dt { margin-block-end: var(--space-2xs); color: var(--color-muted); font-size: var(--text-2xs); }
.deployment-card dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.deployment-script-actions { margin-block-start: var(--space-sm); display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.script-action-button.is-node { min-height: 1.875rem; padding-inline: var(--space-xs); background: var(--color-paper-muted); font-size: var(--text-2xs); }
.deployment-warning { margin: var(--space-xs) 0 0; color: var(--ops-red); font-size: var(--text-xs); }
.deployment-card > footer { margin-block-start: var(--space-sm); padding-block-start: var(--space-sm); border-block-start: 1px solid var(--color-rule); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.deployment-card footer > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-2xs); }
.deployment-card footer > div { display: flex; gap: var(--space-2xs); }
.deployment-card footer button { width: 2rem; height: 2rem; }
.deployment-action-note { min-width: 0; color: var(--color-muted); font-size: var(--text-2xs); text-align: end; }
.deployment-empty-action {
  min-height: 3.5rem;
  padding: var(--space-sm) var(--space-md);
  border: 1px dashed var(--color-rule-strong);
  border-radius: var(--radius-card);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  background: var(--color-paper);
  color: var(--color-muted);
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.deployment-empty-action strong { font-size: var(--text-sm); }
.deployment-empty-action:active { transform: translateY(1px); }

.host-metric-grid {
  margin-block-start: var(--space-sm);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-panel);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  overflow: hidden;
  background: var(--color-paper);
}
.host-metric-grid > button,
.host-metric-uptime {
  position: relative;
  min-width: 0;
  min-height: 4.75rem;
  padding: var(--space-sm);
  border: 0;
  border-inline-end: 1px solid var(--color-rule);
  display: grid;
  align-content: center;
  gap: 2px;
  background: transparent;
  color: inherit;
  text-align: start;
}
.host-metric-grid > button { cursor: pointer; }
.host-metric-grid > button:last-child,
.host-metric-uptime:last-child { border-inline-end: 0; }
.host-metric-grid span { color: var(--color-muted); font-size: var(--text-2xs); }
.host-metric-grid strong { font-family: var(--font-mono); font-size: var(--text-lg); font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.host-metric-grid small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-2xs); }
.host-metric-grid > button > i {
  position: absolute;
  inset: auto 0 0 0;
  height: 3px;
  background: var(--color-accent);
}
.host-metric-grid > button.is-warn > i { background: var(--color-warning); }
.host-metric-grid > button.is-critical > i { background: var(--color-danger); }
.host-metric-grid > button.is-warn strong { color: var(--color-warning); }
.host-metric-grid > button.is-critical strong { color: var(--color-danger); }
.host-metric-grid > button.is-active { background: var(--color-accent-soft); }
.host-metric-uptime { background: var(--color-paper-muted); }
.host-observatory__empty {
  margin-block-start: var(--space-md);
  padding: var(--space-md);
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  background: var(--color-paper-muted);
  color: var(--color-muted);
}
.host-observatory__empty > div { min-width: 0; }
.host-observatory__empty strong { color: var(--color-ink-soft); font-size: var(--text-sm); }
.host-observatory__empty p { font-size: var(--text-xs); }
.host-observatory__empty code { display: block; width: fit-content; max-width: 100%; margin-block-start: var(--space-xs); padding: var(--space-xs) var(--space-sm); overflow-wrap: anywhere; border-radius: var(--radius-control); background: var(--color-ink); color: var(--color-sidebar-ink); font-family: var(--font-mono); font-size: var(--text-2xs); }
.service-stage__actions > button:not(.el-button):disabled,
.deployment-card__tools button:disabled,
.deployment-card footer button:disabled,
.service-log-ribbon button:disabled,
.deployment-empty-action:disabled { opacity: .55; cursor: not-allowed; }

.workspace-empty,
.maintenance-zero-state {
  min-height: 12rem;
  display: grid;
  place-items: center;
  align-content: center;
  gap: var(--space-sm);
  color: var(--color-muted);
  text-align: center;
}
.workspace-empty strong,
.maintenance-zero-state h3 { margin: 0; color: var(--color-ink-soft); font-size: var(--text-sm); }
.maintenance-zero-state { grid-row: 2; }
.deployment-form-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); }
.log-dialog-intro { margin: 0 0 var(--space-sm); color: var(--color-muted); font-size: var(--text-sm); }
.service-log-options { display: grid; gap: var(--space-xs); }
.service-log-options :deep(.el-checkbox) { height: auto; margin: 0; padding: var(--space-sm); border: 1px solid var(--color-rule); border-radius: var(--radius-control); align-items: flex-start; }
.service-log-options :deep(.el-checkbox__label) { min-width: 0; }
.service-log-options span { min-width: 0; display: grid; gap: var(--space-2xs); }
.service-log-options strong { font-size: var(--text-sm); }
.service-log-options small { overflow-wrap: anywhere; color: var(--color-muted); font-size: var(--text-xs); }
.service-log-options__empty { padding: var(--space-lg); border: 1px dashed var(--color-rule-strong); border-radius: var(--radius-control); text-align: center; color: var(--color-muted); font-size: var(--text-xs); }
.kubernetes-dialog__intro { margin: 0 0 var(--space-md); color: var(--color-muted); font-size: var(--text-sm); line-height: 1.6; }
.kubernetes-context-options { max-height: min(28rem, 55dvh); overflow: auto; display: grid; gap: var(--space-xs); }
.kubernetes-context-options :deep(.el-checkbox) { width: 100%; height: auto; margin: 0; padding: var(--space-sm); border: 1px solid var(--color-rule); border-radius: var(--radius-control); align-items: flex-start; }
.kubernetes-context-options :deep(.el-checkbox__label) { min-width: 0; flex: 1; }
.kubernetes-context-options :deep(.el-checkbox__label > span) { min-width: 0; display: grid; gap: var(--space-2xs); }
.kubernetes-context-options strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink-soft); font-size: var(--text-sm); }
.kubernetes-context-options strong small { margin-inline-start: var(--space-xs); color: var(--color-info); font-size: var(--text-2xs); }
.kubernetes-context-options code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); }
.kubernetes-context-options span > small { color: var(--color-muted); font-size: var(--text-2xs); }
:deep(.script-action-manager-dialog .el-dialog__body),
:deep(.script-action-result-dialog .el-dialog__body) { max-height: calc(100dvh - 10rem); overflow: auto; }
.script-action-manager { display: grid; gap: var(--space-md); }
.script-action-manager > header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); }
.script-action-manager > header > div { min-width: 0; }
.script-action-manager > header strong { font-size: var(--text-base); }
.script-action-manager > header p { margin: var(--space-2xs) 0 0; color: var(--color-muted); font-size: var(--text-xs); line-height: 1.5; }
.script-action-manager__list { border-block-start: 1px solid var(--color-rule); display: grid; }
.script-action-manager__list article {
  min-width: 0;
  min-height: 3.5rem;
  padding: var(--space-xs) var(--space-sm);
  border-block-end: 1px solid var(--color-rule);
  display: grid;
  grid-template-columns: 2.125rem minmax(0, 1fr) 2rem 2rem;
  align-items: center;
  gap: var(--space-xs);
}
.script-action-manager__list article.is-editing { background: var(--color-accent-soft); }
.script-action-manager__list article > span { width: 2.125rem; height: 2.125rem; border-radius: var(--radius-control); display: grid; place-items: center; background: var(--color-ink); color: var(--color-sidebar-ink); }
.script-action-manager__list article > div { min-width: 0; display: grid; gap: var(--space-2xs); }
.script-action-manager__list article strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
.script-action-manager__list article small { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); }
.script-action-manager__list article > button,
.script-action-editor > header button {
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
}
.script-action-manager__list article > button:hover { background: var(--color-paper-muted); color: var(--color-ink); }
.script-action-manager__list article > button.is-danger:hover { background: var(--color-danger-soft); color: var(--color-danger); }
.script-action-manager__empty { min-height: 9rem; border: 1px dashed var(--color-rule-strong); border-radius: var(--radius-card); display: grid; place-items: center; align-content: center; gap: var(--space-xs); color: var(--color-muted); text-align: center; }
.script-action-manager__empty strong { color: var(--color-ink-soft); font-size: var(--text-sm); }
.script-action-manager__empty p { margin: 0; font-size: var(--text-xs); }
.script-action-editor { padding: var(--space-md); border: 1px solid var(--color-rule-strong); border-radius: var(--radius-card); background: var(--color-paper-muted); }
.script-action-editor > header { margin-block-end: var(--space-md); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.script-action-editor > header strong { font-size: var(--text-base); }
.script-action-editor > header button { font-size: var(--text-xl); line-height: 1; }
.script-icon-picker { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.script-icon-picker button { width: 2.5rem; height: 2.5rem; padding: 0; border: 1px solid var(--color-rule); border-radius: var(--radius-control); display: grid; place-items: center; background: var(--color-paper-raised); color: var(--color-muted); cursor: pointer; }
.script-icon-picker button.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); box-shadow: 0 0 0 2px var(--color-paper-raised), 0 0 0 4px color-mix(in srgb, var(--color-accent) 25%, transparent); }
.script-body-input :deep(textarea) { min-height: 14rem; font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.6; tab-size: 2; }
.script-action-editor__hint { display: block; margin-block-start: var(--space-xs); color: var(--color-muted); font-size: var(--text-2xs); line-height: 1.5; }
.script-action-editor > footer { display: flex; justify-content: flex-end; gap: var(--space-xs); }
.script-action-results { display: grid; gap: var(--space-sm); }
.script-action-results > header { padding: var(--space-md); border: 1px solid var(--color-rule); border-radius: var(--radius-card); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-sm); background: var(--color-paper-muted); }
.script-action-results > header.is-success { border-color: color-mix(in srgb, var(--ops-green) 45%, var(--color-rule)); }
.script-action-results > header.is-warning { border-color: color-mix(in srgb, var(--ops-amber) 55%, var(--color-rule)); }
.script-action-results > header > span { width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; background: var(--color-accent-soft); color: var(--ops-green); }
.script-action-results > header.is-warning > span { background: var(--color-warning-soft); color: var(--ops-amber); }
.script-action-results > header strong { font-size: var(--text-base); }
.script-action-results > header p { margin: var(--space-2xs) 0 0; color: var(--color-muted); font-size: var(--text-xs); }
.script-action-results > article { border: 1px solid var(--color-rule); border-radius: var(--radius-card); overflow: hidden; background: var(--color-paper); }
.script-action-results > article.is-error { border-color: color-mix(in srgb, var(--ops-red) 45%, var(--color-rule)); }
.script-action-results > article > header { padding: var(--space-sm); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-xs); }
.script-action-results > article > header > span { color: var(--ops-green); }
.script-action-results > article.is-error > header > span { color: var(--ops-red); }
.script-action-results > article > header > div { min-width: 0; display: grid; gap: var(--space-2xs); }
.script-action-results > article > header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
.script-action-results > article > header small { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); }
.script-action-result__message { margin: 0; padding: 0 var(--space-sm) var(--space-sm); color: var(--ops-red); font-size: var(--text-xs); }
.script-action-results details { border-block-start: 1px solid var(--color-rule); }
.script-action-results summary { padding: var(--space-xs) var(--space-sm); display: flex; align-items: center; gap: var(--space-xs); color: var(--color-muted); font-size: var(--text-xs); cursor: pointer; }
.script-action-results summary small { color: var(--ops-amber); }
.script-action-results details > div { padding: var(--space-sm); border-block-start: 1px solid var(--color-rule); background: var(--color-ink); color: var(--color-sidebar-ink); }
.script-action-results details > div > strong { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); text-transform: uppercase; }
.script-action-results pre { max-height: 18rem; margin: var(--space-xs) 0 0; overflow: auto; color: inherit; font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
:deep(.monitor-install-progress-dialog .el-dialog__body) { max-height: calc(100dvh - 10rem); overflow: auto; }
.monitor-install-progress { display: grid; gap: var(--space-md); }
.monitor-install-progress__summary {
  min-width: 0;
  padding: var(--space-md);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-card);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-sm);
  background: var(--color-paper-muted);
}
.monitor-install-progress__summary.is-success { border-color: var(--color-accent); background: var(--color-accent-soft); }
.monitor-install-progress__summary.is-error { border-color: var(--color-danger); background: var(--color-danger-soft); }
.monitor-install-progress__status { width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; background: var(--color-info-soft); color: var(--color-info); }
.monitor-install-progress__summary.is-success .monitor-install-progress__status { background: var(--color-accent); color: var(--color-paper); }
.monitor-install-progress__summary.is-error .monitor-install-progress__status { background: var(--color-danger); color: var(--color-paper); }
.monitor-install-progress__summary > div { min-width: 0; }
.monitor-install-progress__summary strong { display: block; font-size: var(--text-sm); }
.monitor-install-progress__summary p { margin: var(--space-2xs) 0 0; overflow-wrap: anywhere; color: var(--color-ink-soft); font-size: var(--text-xs); }
.monitor-install-progress__summary > time { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); font-variant-numeric: tabular-nums; }
.monitor-install-progress__target { margin: 0; padding: 0 var(--space-xs); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
.monitor-install-progress__target div { min-width: 0; }
.monitor-install-progress__target dt { margin-block-end: var(--space-2xs); color: var(--color-muted); font-size: var(--text-2xs); }
.monitor-install-progress__target dd { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink-soft); font-size: var(--text-xs); }
.monitor-install-progress__target code { font-family: var(--font-mono); font-size: var(--text-2xs); }
.monitor-install-progress__bar { padding-inline: var(--space-xs); }
.monitor-install-progress__bar :deep(.el-progress__text) { min-width: 2.75rem; color: var(--color-ink-soft); font-family: var(--font-mono); font-size: var(--text-xs) !important; }
.monitor-install-steps { margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-xs); list-style: none; }
.monitor-install-steps li { min-width: 0; min-height: 4rem; padding: var(--space-sm); border: 1px solid var(--color-rule); border-radius: var(--radius-control); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: var(--space-xs); background: var(--color-paper); color: var(--color-muted); }
.monitor-install-steps li > span { width: 1.5rem; height: 1.5rem; border: 1px solid var(--color-rule-strong); border-radius: 50%; display: grid; place-items: center; background: var(--color-paper-muted); color: var(--color-muted); }
.monitor-install-steps li > span i { font-family: var(--font-mono); font-size: var(--text-2xs); font-style: normal; }
.monitor-install-steps li > div { min-width: 0; display: grid; gap: var(--space-2xs); }
.monitor-install-steps li strong { color: var(--color-ink-soft); font-size: var(--text-xs); line-height: 1.25; }
.monitor-install-steps li small { color: var(--color-muted); font-size: var(--text-2xs); line-height: 1.35; }
.monitor-install-steps li.is-complete { border-color: var(--color-accent); background: var(--color-accent-soft); }
.monitor-install-steps li.is-complete > span { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-paper); }
.monitor-install-steps li.is-active { border-color: var(--color-info); box-shadow: inset 0 0 0 1px var(--color-info); }
.monitor-install-steps li.is-active > span { border-color: var(--color-info); background: var(--color-info-soft); color: var(--color-info); }
.monitor-install-steps li.is-error { border-color: var(--color-danger); background: var(--color-danger-soft); }
.monitor-install-steps li.is-error > span { border-color: var(--color-danger); background: var(--color-danger); color: var(--color-paper); }
.monitor-install-logs { border-block: 1px solid var(--color-rule); }
.monitor-install-logs > summary { min-height: 2.75rem; padding-inline: var(--space-xs); display: flex; align-items: center; gap: var(--space-xs); color: var(--color-ink-soft); font-size: var(--text-xs); font-weight: 700; cursor: pointer; list-style: none; }
.monitor-install-logs > summary::-webkit-details-marker { display: none; }
.monitor-install-logs > summary small { margin-inline-start: auto; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); font-weight: 500; }
.monitor-install-logs > summary > svg { color: var(--color-muted); transition: transform var(--dur-micro) var(--ease-out); }
.monitor-install-logs[open] > summary > svg { transform: rotate(90deg); }
.monitor-install-logs__body { max-height: 15rem; padding: var(--space-sm); overflow: auto; border-block-start: 1px solid var(--color-rule); background: var(--color-ink); color: var(--color-sidebar-ink); }
.monitor-install-logs__body p { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-sm); font-family: var(--font-mono); font-size: var(--text-2xs); line-height: 1.65; }
.monitor-install-logs__body p + p { margin-block-start: var(--space-2xs); }
.monitor-install-logs__body time { color: var(--color-sidebar-muted); font-variant-numeric: tabular-nums; }
.monitor-install-logs__body code { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; color: inherit; font-family: inherit; }
.monitor-install-logs__body p.is-output code { color: var(--color-sidebar-muted); }
.monitor-install-progress__loading { min-height: 12rem; display: flex; align-items: center; justify-content: center; gap: var(--space-xs); color: var(--color-muted); font-size: var(--text-sm); }
.is-spinning { animation: maintenance-spin .8s linear infinite; }
@keyframes maintenance-spin { to { transform: rotate(360deg); } }
.monitor-alert-settings { display: grid; gap: 1rem; }
.monitor-alert-settings > header { min-height: 4rem; padding: .875rem 1rem; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--ink-50); display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.monitor-alert-settings > header strong, .monitor-alert-settings > header p { display: block; margin: 0; }
.monitor-alert-settings > header strong { color: var(--ink-800); font-size: .875rem; }
.monitor-alert-settings > header p { margin-top: .25rem; color: var(--ink-400); font-size: .6875rem; }
.monitor-alert-rule-list {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content auto;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  overflow: hidden;
  transition: opacity .15s ease;
}
.monitor-alert-rule-list.is-disabled { opacity: .5; pointer-events: none; }
.monitor-alert-rule-list article {
  min-height: 3.5rem;
  padding: .625rem .875rem;
  border-block-end: 1px solid var(--ink-100);
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: center;
  gap: .625rem .75rem;
}
.monitor-alert-rule-list article:last-child { border-block-end: 0; }
.monitor-alert-rule-list article > span { min-width: 0; color: var(--ink-500); font-size: .75rem; }
.monitor-alert-rule-list article:not(.is-switch-rule) > span { grid-column: 3; justify-self: end; }
.monitor-alert-rule-list article.is-switch-rule > span { grid-column: 2 / -1; }
.monitor-alert-rule-list article :deep(.animated-counter) { grid-column: 4; justify-self: start; }
.monitor-alert-settings :deep(.el-select) { width: 100%; }
.monitor-alert-exclusions {
  display: grid;
  gap: .75rem;
  padding: .875rem 1rem;
  border: 1px solid var(--ink-100);
  border-radius: 8px;
  background: var(--ink-50);
}
.monitor-alert-exclusions strong,
.monitor-alert-exclusions p { display: block; margin: 0; }
.monitor-alert-exclusions strong { color: var(--ink-800); font-size: .875rem; }
.monitor-alert-exclusions p { margin-top: .25rem; color: var(--ink-400); font-size: .6875rem; line-height: 1.5; }

@media (hover: hover) and (pointer: fine) {
  .service-index__row:hover:not(.is-active),
  .host-index__row:hover:not(.is-active) { background: var(--ink-50); }
  .service-index__row:hover .directory-row__grip,
  .service-index__row:hover .directory-row__menu,
  .host-index__row:hover .directory-row__grip,
  .host-index__row:hover .directory-row__menu { color: var(--ink-500); }
  .directory-row__grip:hover:not(.is-disabled),
  .directory-row__menu:hover:not(:disabled) { background: var(--surface); color: var(--teal-700); }
  .host-workspace-tabs button:hover:not(.is-active) { color: var(--ink-800); }
  .service-stage__actions > button:not(.el-button):hover,
  .deployment-card__tools button:hover,
  .deployment-card footer button:hover,
  .deployment-empty-action:hover,
  .discovery-service-picker button:hover { color: var(--ops-green); background: var(--color-accent-soft); }
  .discovery-service-picker button:hover { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); }
  .service-stage__actions > button:not(.el-button).is-danger:hover,
  .deployment-card__tools button.is-danger:hover { color: var(--ops-red); background: var(--color-danger-soft); }
}

@media (pointer: coarse) {
  .directory-row__grip,
  .directory-row__menu { opacity: 1; }
  .maintenance-console :deep(.el-button),
  .service-log-ribbon button,
  .script-action-button,
  .script-action-add,
  .directory-row__menu,
  .service-stage__actions > button:not(.el-button),
  .deployment-card__tools button,
  .deployment-card footer button,
  .host-workspace-tabs button { min-width: 2.75rem; min-height: 2.75rem; }
}

@media (min-width: 40rem) {
  .maintenance-summary span { padding-inline: var(--space-sm); grid-template-columns: auto auto minmax(0, 1fr); grid-template-rows: auto; gap: var(--space-xs); }
  .maintenance-summary i { grid-row: auto; }
  .maintenance-directory { height: 15rem; max-height: 15rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; }
  .directory-group--hosts { border-block-start: 0; border-inline-start: 1px solid var(--ink-100); }
  .deployment-form-grid { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); }
}

@media (max-width: 39.999rem) {
  .maintenance-toolbar__actions { grid-column: 1 / -1; width: 100%; }
  .maintenance-toolbar__actions :deep(.el-button) { flex: 1; }
  .monitor-alert-rule-list { grid-template-columns: minmax(0, 1fr); }
  .monitor-alert-rule-list article,
  .monitor-alert-rule-list article.is-switch-rule { grid-template-columns: minmax(0, 1fr); justify-items: start; }
  .monitor-alert-rule-list article:not(.is-switch-rule) > span,
  .monitor-alert-rule-list article.is-switch-rule > span { grid-column: auto; justify-self: start; }
  .monitor-alert-rule-list article :deep(.animated-counter) { grid-column: auto; justify-self: start; }
  .host-observatory > header,
  .host-observatory__actions { width: 100%; }
  .host-observatory__actions :deep(.el-button) { flex: 1 1 100%; }
  .monitor-install-progress__summary { grid-template-columns: auto minmax(0, 1fr); }
  .monitor-install-progress__summary > time { grid-column: 2; }
  .monitor-install-progress__target,
  .monitor-install-steps { grid-template-columns: minmax(0, 1fr); }
  .script-action-manager > header { align-items: stretch; flex-direction: column; }
  .script-action-manager > header :deep(.el-button) { width: 100%; }
  .script-action-manager__list article { grid-template-columns: 2.125rem minmax(0, 1fr) 2.25rem 2.25rem; padding-inline: var(--space-xs); }
}

@media (min-width: 52rem) {
  .maintenance-layout { display: grid; grid-template-columns: 16.75rem minmax(0, 1fr); overflow: hidden; }
  .maintenance-directory { height: auto; max-height: none; border-inline-end: 1px solid var(--ink-100); border-block-end: 0; display: flex; }
  .directory-group--hosts { border-inline-start: 0; border-block-start: 1px solid var(--ink-100); }
  .maintenance-workspace { padding: var(--space-lg); overflow: auto; }
  .maintenance-workspace:has(.host-observatory) { overflow: hidden; display: flex; flex-direction: column; }
  .maintenance-workspace:has(.host-observatory) > .host-observatory { flex: 1 1 auto; min-height: 0; }
  .maintenance-workspace:has(.host-observatory__pane.is-discovery) { overflow: auto; display: block; }
  .deployment-grid { grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); }
}

@media (min-width: 60rem) {
  .maintenance-toolbar { padding-inline: 1rem; }
}

@media (prefers-reduced-motion: reduce) {
  .directory-row__menu,
  .service-stage__actions > button:not(.el-button),
  .deployment-card__tools button,
  .deployment-card footer button,
  .service-log-ribbon button,
  .script-action-button,
  .script-action-add,
  .script-icon-picker button,
  .deployment-empty-action,
  .host-workspace-tabs button { transition-duration: var(--dur-micro); transform: none !important; }
  .is-spinning { animation-duration: 1.4s; }
}
</style>
