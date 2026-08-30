import { localizeMessage, translate as tr } from "../../i18n";
import { Activity, ArrowDown, ArrowUp, BellRing, Box, Check, ChevronRight, CircleAlert, Clock3, Database, Download, EllipsisVertical, FileText, GripVertical, Hammer, Package, Pencil, Play, Plus, Power, RefreshCw, Rocket, RotateCw, ScanSearch, Server, Settings2, ShieldCheck, Square, Terminal, Trash2, Wrench, Zap, } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch, type Component } from "vue";
import { api, ApiError } from "../../api";
import { createLatestDataLoader } from "../../latest-data-loader";
import { candidateKey, providerLabel, type CandidateStatus, type MonitorCandidate, type Provider } from "../../service-candidate-tree";
import { normalizeMaintenanceScriptActions } from "../../service-maintenance-payload";
import { reorderIds, sameOrder } from "../../../shared/tab-order";
import { defaultMonitorAlertSettings, defaultMonitoredDiskTypes, visibleMonitorDisks, type MonitorAlertSettings, } from "../../../shared/monitor-alerts";

import type { MaintenanceWorkspace, HostWorkspaceTab, HostFocusMetric, MaintenanceDirectory, DirectoryMoveDirection, ScriptActionIcon, DirectoryDropTarget, ScriptAction, ScriptActionExecutionResult, ScriptActionExecution, HostSnapshot, KubernetesConfigDiscovery, MonitorHost, MonitorInstallPreflight, MonitorInstallTaskStatus, MonitorInstallTaskPhase, MonitorInstallTask, Deployment, ServiceItem, EnvironmentLog, MaintenancePayload, MaintenanceDeploymentResponse, MaintenanceServiceResponse, MaintenancePayloadResponse, MaintenanceCounts, MaintenancePanelProps, MaintenancePanelEmit } from "./types";
import { deferMaintenancePart, type MaintenanceContext } from "./context";
import { useMaintenanceActions } from "./use-maintenance-actions";

export function useMaintenancePayload(ctx: MaintenanceContext, props: Readonly<MaintenancePanelProps>, emit: MaintenancePanelEmit) {
  const $directory = deferMaintenancePart(ctx, "directory");
  const $monitorInstall = deferMaintenancePart(ctx, "monitorInstall");
  const $scriptActions = deferMaintenancePart(ctx, "scriptActions");
  const $alertSettings = deferMaintenancePart(ctx, "alertSettings");
  const loading = ref(true);

  const saving = ref(false);

  const payload = ref<MaintenancePayload>({
      canConfigure: false,
      canOperate: false,
      scriptActionsSupported: false,
      alertSettings: { ...defaultMonitorAlertSettings, excludedDisks: [], monitoredDiskTypes: [...defaultMonitoredDiskTypes] },
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

  const serviceDialog = ref(false);

  const deploymentDialog = ref(false);

  const logDialog = ref(false);

  const kubernetesDialog = ref(false);

  const editingServiceId = ref("");

  const editingDeploymentId = ref("");

  const manualDeployment = ref(false);

  const savingKubernetes = ref(false);

  let refreshTimer: number | undefined;

  const serviceForm = reactive({ name: "", description: "", status: "active" as "active" | "disabled" });

  const deploymentForm = reactive({ sshConnectionId: "", candidateKey: "", provider: "systemd" as Provider, externalId: "", displayName: "", origin: "manual" as "discovered" | "manual" });

  const selectedLogIds = ref<string[]>([]);

  const selectedKubernetesContextKeys = ref<string[]>([]);

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

  const attentionItems = computed(() => {
      const items = [
              problemDeployments.value ? { key: "problems", value: problemDeployments.value, label: tr("待处理") } : null,
              offlineHosts.value ? { key: "offline", value: offlineHosts.value, label: tr("离线主机") } : null,
              unmonitoredHosts.value ? { key: "missing", value: unmonitoredHosts.value, label: tr("未监控") } : null,
          ];
      return items.filter((item): item is {
          key: string;
          value: number;
          label: string;
      } => Boolean(item));
  });

  const selectedUnmanagedCount = computed(() => selectedHost.value ? hostUnmanagedCount(selectedHost.value) : 0);

  const selectedWorstDisk = computed(() => selectedHost.value ? worstDisk(selectedHost.value) : null);
  const selectedDiskCount = computed(() => selectedHost.value ? visibleMonitorDisks(selectedHost.value.snapshot?.disks ?? [], payload.value.alertSettings).length : 0);

  const selectableKubernetesConfigs = computed(() => (selectedHost.value?.kubernetesConfigs ?? []).filter((item) => item.context && !["invalid", "unreadable"].includes(item.status)));

  const discoveryManagedKeys = computed(() => {
      const hostId = selectedHost.value?.sshConnectionId;
      if (!hostId)
          return [];
      return [...new Set(payload.value.services.flatMap((service) => service.deployments)
              .filter((deployment) => deployment.sshConnectionId === hostId)
              .map(candidateKey))];
  });

  async function fetchMaintenance(silent = false) {
      if (silent && ($directory.savingServiceOrder.value || $directory.savingHostOrder.value))
          return;
      if (!silent)
          loading.value = true;
      try {
          const response = await api<MaintenancePayloadResponse>(`/api/v1/environments/${props.environmentId}/service-deployments`);
          const discoveryHosts = (response.discovery?.hosts ?? []).map((row) => {
              const previous = payload.value.hosts.find((host) => host.sshConnectionId === row.sshConnectionId);
              return {
                  sshConnectionId: row.sshConnectionId,
                  connectionName: row.connectionName,
                  host: previous?.host || row.host,
                  port: previous?.port ?? 0,
                  username: previous?.username ?? "",
                  connectionAvailable: row.connectionAvailable,
                  monitorStatus: row.monitorStatus,
                  monitorOffline: row.monitorStatus === "error",
                  agentId: previous?.agentId ?? "",
                  agentVersion: previous?.agentVersion ?? "",
                  monitorUpdateAvailable: previous?.monitorUpdateAvailable ?? false,
                  protocolVersion: previous?.protocolVersion ?? 0,
                  lastSequence: previous?.lastSequence ?? 0,
                  snapshot: previous?.snapshot ?? null,
                  candidates: previous?.candidates ?? [],
                  kubernetesConfigs: previous?.kubernetesConfigs ?? [],
                  lastError: previous?.lastError ?? "",
                  lastCollectedAt: previous?.lastCollectedAt ?? null,
                  lastPulledAt: previous?.lastPulledAt ?? null,
                  installPath: previous?.installPath ?? "",
                  installArchitecture: previous?.installArchitecture ?? "",
                  installManaged: previous?.installManaged ?? false,
                  installedAt: previous?.installedAt ?? null,
                  candidateCount: row.candidateCount,
              };
          });
          payload.value = normalizeMaintenanceScriptActions({
              ...response,
              alertSettings: payload.value.alertSettings,
              hosts: discoveryHosts,
          }) as MaintenancePayload;
          if (!payload.value.services.some((item) => item.id === selectedServiceId.value))
              selectedServiceId.value = payload.value.services[0]?.id ?? "";
          if (!payload.value.services.some((item) => item.id === discoveryTargetServiceId.value))
              discoveryTargetServiceId.value = "";
          if (!payload.value.hosts.some((item) => item.sshConnectionId === selectedHostId.value))
              selectedHostId.value = payload.value.hosts[0]?.sshConnectionId ?? "";
          if (activeWorkspace.value !== "service" && activeWorkspace.value !== "host")
              activeWorkspace.value = "service";
          if (activeWorkspace.value === "service" && !payload.value.services.length && payload.value.hosts.length)
              activeWorkspace.value = "host";
          if (activeWorkspace.value === "host" && !payload.value.hosts.length && payload.value.services.length)
              activeWorkspace.value = "service";
          emit("count-change", { services: payload.value.services.length, monitoredHosts: monitoredHosts.value });
          applyFocusTarget();
      }
      finally {
          if (!silent)
              loading.value = false;
      }
  }

  function applyFocusTarget() {
      const requestedServiceId = props.focusServiceId
          || payload.value.services.find((service) => service.deployments.some((deployment) => deployment.id === props.focusDeploymentId))?.id;
      if (requestedServiceId && payload.value.services.some((service) => service.id === requestedServiceId)) {
          selectService(requestedServiceId);
          return;
      }
      if (props.focusHostId && payload.value.hosts.some((host) => host.sshConnectionId === props.focusHostId))
          selectHost(props.focusHostId);
  }

  const { load, reload } = createLatestDataLoader(fetchMaintenance);
  const maintenanceActions = useMaintenanceActions(selectedService, reload);

  function stopAutoRefresh() {
      if (refreshTimer === undefined)
          return;
      window.clearInterval(refreshTimer);
      refreshTimer = undefined;
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  function onVisibilityChange() {
      if (document.hidden)
          return;
      void load(true).catch(() => undefined);
  }

  function startAutoRefresh() {
      if (refreshTimer !== undefined)
          return;
      refreshTimer = window.setInterval(() => {
          if (document.hidden)
              return;
          void load(true).catch(() => undefined);
      }, 15000);
      document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function summarizeService(service: ServiceItem | null) {
      if (!service || service.status === "disabled")
          return { status: "disabled", label: tr("已停用") };
      if (!service.deployments.length)
          return { status: "unknown", label: tr("尚未纳管节点") };
      const statuses = service.deployments.map((item) => item.status);
      if (statuses.every((status) => status === "running"))
          return { status: "running", label: tr("运行中") };
      if (statuses.some((status) => status === "degraded" || status === "stopped"))
          return { status: "degraded", label: tr("存在异常节点") };
      return { status: "unknown", label: tr("状态未确认") };
  }

  function statusLabel(status: string) {
      return ({ running: tr("运行中"), stopped: tr("已停止"), degraded: tr("异常"), unknown: tr("未知"), disabled: tr("已停用") } as Record<string, string>)[status] ?? status;
  }

  function candidateLocationLabel(candidate: MonitorCandidate) {
      if (candidate.provider !== "kubernetes")
          return providerLabel(candidate.provider);
      const metadata = candidate.metadata ?? {};
      return `Kubernetes · ${String(metadata.cluster ?? metadata.context ?? "")} / ${String(metadata.namespace ?? "default")} · ${String(metadata.resourceKind ?? "Workload")}`;
  }

  function supportsMaintenanceActions(provider: Provider, deployment?: Deployment) {
      if (deployment?.capabilities)
          return deployment.capabilities.length > 0;
      return ["systemd", "docker", "podman", "supervisor"].includes(provider);
  }

  function deploymentAllowsAction(deployment: Deployment, action: "start" | "stop" | "restart") {
      if (deployment.capabilities)
          return deployment.capabilities.includes(action);
      if (["systemd", "docker", "podman", "supervisor"].includes(deployment.provider))
          return true;
      return false;
  }

  function unsupportedMaintenanceActionReason(provider: Provider, deployment?: Deployment) {
      if (deployment?.capabilityNotes?.restart)
          return deployment.capabilityNotes.restart;
      if (provider === "kubernetes")
          return tr("Kubernetes 仅对结构化控制器提供重启");
      if (provider === "process")
          return tr("裸进程不提供通用启停，请使用 Runbook");
      return "";
  }

  function deploymentIdentity(deployment: Deployment) {
      if (deployment.provider !== "kubernetes")
          return deployment.externalId;
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
      if (item.status === "connected")
          return tr("已连接");
      if (item.status === "discovered")
          return tr("待选择");
      if (item.status === "unreadable")
          return tr("无法读取");
      if (item.status === "invalid")
          return tr("配置无效");
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
      if (!host)
          return;
      const selectedKeys = new Set(selectedKubernetesContextKeys.value);
      const selections = selectableKubernetesConfigs.value
          .filter((item) => selectedKeys.has(kubernetesContextKey(item)))
          .map((item) => ({ sourceId: item.sourceId, context: item.context! }));
      savingKubernetes.value = true;
      try {
          const response = await api<{
              monitorWarning?: string;
          }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/kubernetes-contexts`, {
              method: "PUT",
              body: JSON.stringify({ selections }),
          });
          kubernetesDialog.value = false;
          await reload(true);
          if (response.monitorWarning)
              ElMessage.warning(tr("Kubernetes 扫描配置已保存，但立即扫描失败：{{0}}", [localizeMessage(response.monitorWarning)]));
          else
              ElMessage.success(tr("Kubernetes 扫描配置已保存"));
      }
      finally {
          savingKubernetes.value = false;
      }
  }

  function formatPercent(value?: number) {
      return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "—";
  }

  function formatBytes(value?: number) {
      if (!Number.isFinite(value) || !value)
          return value === 0 ? "0 B" : "—";
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
      if (!Number.isFinite(seconds) || Number(seconds) < 0)
          return "—";
      if (Number(seconds) < 60)
          return tr("不到 1 分钟");
      const days = Math.floor(Number(seconds) / 86400);
      const hours = Math.floor((Number(seconds) % 86400) / 3600);
      const minutes = Math.floor((Number(seconds) % 3600) / 60);
      if (days)
          return tr("{{0}} 天 {{1}} 小时", [days, hours]);
      if (hours)
          return tr("{{0}} 小时", [hours]);
      return tr("{{0}} 分钟", [minutes]);
  }

  function formatTime(value: string | null | undefined) {
      return value ? new Date(value).toLocaleString() : tr("尚未采集");
  }

  function formatRelativeCollected(value: string | null | undefined) {
      if (!value)
          return tr("尚未采集");
      const then = Date.parse(value);
      if (!Number.isFinite(then))
          return tr("尚未采集");
      const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
      if (minutes < 1)
          return tr("刚刚采集");
      if (minutes < 60)
          return tr("{{0}} 分钟前采集", [minutes]);
      const hours = Math.round(minutes / 60);
      if (hours < 48)
          return tr("{{0}} 小时前采集", [hours]);
      return formatTime(value);
  }

  function hostPresence(host: MonitorHost) {
      if (host.monitorOffline)
          return { key: "offline", label: tr("离线") };
      if (host.monitorStatus === "ready")
          return { key: "online", label: tr("在线") };
      if (host.monitorStatus === "missing")
          return { key: "missing", label: tr("未监控") };
      if (host.monitorStatus === "error")
          return { key: "error", label: tr("异常") };
      return { key: "unknown", label: tr("未知") };
  }

  function hostLiveCpu(host: MonitorHost) {
      return Number.isFinite(host.snapshot?.cpuUsedPercent) ? formatPercent(host.snapshot?.cpuUsedPercent) : "";
  }

  function worstDisk(host: MonitorHost) {
      const disks = visibleMonitorDisks(host.snapshot?.disks ?? [], payload.value.alertSettings);
      if (!disks.length)
          return null;
      return disks.reduce((worst, disk) => disk.usedPercent > (worst?.usedPercent ?? -1) ? disk : worst);
  }

  function metricTone(value: number | undefined, threshold: number) {
      if (!Number.isFinite(value))
          return "unknown";
      if (Number(value) >= threshold)
          return "critical";
      if (Number(value) >= threshold * 0.8)
          return "warn";
      return "ok";
  }

  function hostUnmanagedCount(host: MonitorHost) {
      const managed = new Set(payload.value.services.flatMap((service) => service.deployments)
          .filter((deployment) => deployment.sshConnectionId === host.sshConnectionId)
          .map(candidateKey));
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

  async function loadHostCandidates(hostId: string) {
      try {
          const response = await api<{ item: Partial<MonitorHost> & { candidates: MonitorCandidate[]; kubernetesConfigs: KubernetesConfigDiscovery[] } }>(
              `/api/v1/environments/${props.environmentId}/monitor-hosts/${hostId}/candidates`,
          );
          payload.value = {
              ...payload.value,
              hosts: payload.value.hosts.map((host) => host.sshConnectionId === hostId
                  ? {
                      ...host,
                      ...response.item,
                      sshConnectionId: host.sshConnectionId,
                      connectionName: response.item.connectionName || host.connectionName,
                      connectionAvailable: host.connectionAvailable,
                      candidateCount: host.candidateCount,
                  }
                  : host),
          };
      } catch {
          /* keep last known candidates */
      }
  }

  function selectHost(id: string) {
      selectedHostId.value = id;
      activeWorkspace.value = "host";
      void loadHostCandidates(id);
  }

  function openWorkspaceTab(kind: MaintenanceWorkspace) {
      if (kind === "service") {
          const id = selectedServiceId.value || payload.value.services[0]?.id;
          if (id) selectService(id);
          else activeWorkspace.value = "service";
          return;
      }
      if (kind === "host") {
          const id = selectedHostId.value || payload.value.hosts[0]?.sshConnectionId;
          if (id) selectHost(id);
          else activeWorkspace.value = "host";
      }
  }

  function openServiceCreate(fromDiscovery = false) {
      creatingServiceFromDiscovery.value = fromDiscovery === true;
      editingServiceId.value = "";
      Object.assign(serviceForm, { name: "", description: "", status: "active" });
      serviceDialog.value = true;
  }

  function openServiceEdit() {
      if (!selectedService.value)
          return;
      editingServiceId.value = selectedService.value.id;
      Object.assign(serviceForm, { name: selectedService.value.name, description: selectedService.value.description, status: selectedService.value.status });
      serviceDialog.value = true;
  }

  async function saveService() {
      if (!serviceForm.name.trim())
          return ElMessage.warning(tr("请输入服务名称"));
      saving.value = true;
      try {
          const body = JSON.stringify(serviceForm);
          if (editingServiceId.value)
              await api(`/api/v1/services/${editingServiceId.value}`, { method: "PUT", body });
          else {
              const created = await api<{
                  id: string;
              }>(`/api/v1/environments/${props.environmentId}/services`, { method: "POST", body });
              selectedServiceId.value = created.id;
              discoveryTargetServiceId.value = created.id;
              if (creatingServiceFromDiscovery.value) {
                  activeWorkspace.value = "host";
                  hostWorkspaceTab.value = "discovery";
              }
              else {
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
      }
      finally {
          saving.value = false;
      }
  }

  async function removeService() {
      const service = selectedService.value;
      if (!service)
          return;
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
      if (host)
          deploymentForm.sshConnectionId = host.sshConnectionId;
      if (candidate) {
          manualDeployment.value = false;
          deploymentForm.candidateKey = `${candidate.provider}:${candidate.externalId}`;
          Object.assign(deploymentForm, { provider: candidate.provider, externalId: candidate.externalId, displayName: candidate.name, origin: "discovered" });
      }
      deploymentDialog.value = true;
  }

  function assignDiscoveryTarget(serviceId: string) {
      discoveryTargetServiceId.value = serviceId;
      if (serviceId)
          selectedServiceId.value = serviceId;
  }

  function beginCandidateEnrollment(candidate: MonitorCandidate) {
      if (!payload.value.canConfigure)
          return;
      const host = selectedHost.value;
      if (!host)
          return;
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
      if (candidate && host)
          openDeploymentCreate(candidate, host);
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
      if (creatingServiceFromDiscovery.value || deploymentDialog.value)
          return;
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
      if (!selectedService.value)
          return;
      if (!deploymentForm.sshConnectionId)
          return ElMessage.warning(tr("请选择 SSH 连接"));
      if (!manualDeployment.value && !deploymentForm.candidateKey)
          return ElMessage.warning(tr("请选择扫描到的服务"));
      if (!manualDeployment.value) {
          const candidate = candidateOptions.value.find((item) => item.key === deploymentForm.candidateKey);
          if (!candidate)
              return ElMessage.warning(tr("扫描候选已变化，请重新选择"));
          Object.assign(deploymentForm, {
              provider: candidate.provider,
              externalId: candidate.externalId,
              displayName: deploymentForm.displayName || candidate.name,
              origin: "discovered",
          });
      }
      if (!deploymentForm.externalId.trim())
          return ElMessage.warning(tr("请选择扫描结果或填写服务标识"));
      saving.value = true;
      try {
          const body = JSON.stringify({
              sshConnectionId: deploymentForm.sshConnectionId,
              provider: deploymentForm.provider,
              externalId: deploymentForm.externalId,
              displayName: deploymentForm.displayName,
              origin: manualDeployment.value ? "manual" : deploymentForm.origin,
          });
          if (editingDeploymentId.value)
              await api(`/api/v1/service-deployments/${editingDeploymentId.value}`, { method: "PUT", body });
          else
              await api(`/api/v1/services/${selectedService.value.id}/deployments`, { method: "POST", body });
          deploymentDialog.value = false;
          await reload();
          ElMessage.success(tr("部署节点已保存"));
      }
      finally {
          saving.value = false;
      }
  }

  async function removeDeployment(deployment: Deployment) {
      await ElMessageBox.confirm(tr("从当前服务移除部署节点“{{0}}”？不会删除远程服务。", [deployment.displayName || deployment.externalId]), tr("移除部署节点"), { type: "warning" });
      await api(`/api/v1/service-deployments/${deployment.id}`, { method: "DELETE" });
      await reload();
  }

  function openLogLinks() {
      if (!selectedService.value)
          return;
      selectedLogIds.value = [...selectedService.value.logIds];
      logDialog.value = true;
  }

  async function saveLogLinks() {
      if (!selectedService.value)
          return;
      saving.value = true;
      try {
          await api(`/api/v1/services/${selectedService.value.id}/logs`, { method: "PUT", body: JSON.stringify({ logIds: selectedLogIds.value }) });
          logDialog.value = false;
          await reload();
          ElMessage.success(tr("日志关联已更新"));
      }
      finally {
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
          if (current?.monitorStatus === "missing")
              ElMessage.warning(tr("目标机器尚未安装 viron-monitor"));
          else
              ElMessage.success(tr("节点状态已刷新"));
      }
      finally {
          const updated = new Set(refreshingHosts.value);
          updated.delete(host.sshConnectionId);
          refreshingHosts.value = updated;
      }
  }

  return {
    loading,
    saving,
    payload,
    selectedServiceId,
    selectedHostId,
    activeWorkspace,
    hostWorkspaceTab,
    hostFocusMetric,
    discoveryTargetServiceId,
    pendingDiscoveryCandidate,
    creatingServiceFromDiscovery,
    servicePickerDialog,
    refreshingHosts,
    ...maintenanceActions,
    serviceDialog,
    deploymentDialog,
    logDialog,
    kubernetesDialog,
    editingServiceId,
    editingDeploymentId,
    manualDeployment,
    savingKubernetes,
    refreshTimer,
    serviceForm,
    deploymentForm,
    selectedLogIds,
    selectedKubernetesContextKeys,
    selectedService,
    selectedHost,
    selectedLogs,
    hostCandidates,
    candidateOptions,
    serviceSummary,
    runningDeployments,
    problemDeployments,
    monitoredHosts,
    offlineHosts,
    unmonitoredHosts,
    attentionItems,
    selectedUnmanagedCount,
    selectedWorstDisk,
    selectedDiskCount,
    selectableKubernetesConfigs,
    discoveryManagedKeys,
    load,
    reload,
    countPhysicalMonitorHosts,
    fetchMaintenance,
    applyFocusTarget,
    stopAutoRefresh,
    startAutoRefresh,
    summarizeService,
    statusLabel,
    candidateLocationLabel,
    supportsMaintenanceActions,
    deploymentAllowsAction,
    unsupportedMaintenanceActionReason,
    deploymentIdentity,
    kubernetesMetric,
    kubernetesContextKey,
    kubernetesConfigStatusLabel,
    openKubernetesConfiguration,
    saveKubernetesConfiguration,
    formatPercent,
    formatBytes,
    formatDuration,
    formatTime,
    formatRelativeCollected,
    hostPresence,
    hostLiveCpu,
    worstDisk,
    metricTone,
    hostUnmanagedCount,
    visualThreshold,
    selectService,
    selectHost,
    openWorkspaceTab,
    openServiceCreate,
    openServiceEdit,
    saveService,
    removeService,
    resetDeploymentForm,
    openDeploymentCreate,
    assignDiscoveryTarget,
    beginCandidateEnrollment,
    pickServiceForDiscovery,
    createServiceFromDiscovery,
    cancelServicePicker,
    onServicePickerClosed,
    discoveryPickerIntro,
    openDeploymentEdit,
    saveDeployment,
    removeDeployment,
    openLogLinks,
    saveLogLinks,
    refreshHost,
  };
}
