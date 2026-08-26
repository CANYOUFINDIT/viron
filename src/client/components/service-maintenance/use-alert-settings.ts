import { localizeMessage, translate as tr } from "../../i18n";
import { Activity, ArrowDown, ArrowUp, BellRing, Box, Check, ChevronRight, CircleAlert, Clock3, Database, Download, EllipsisVertical, FileText, GripVertical, Hammer, Package, Pencil, Play, Plus, Power, RefreshCw, Rocket, RotateCw, ScanSearch, Server, Settings2, ShieldCheck, Square, Terminal, Trash2, Wrench, Zap, } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch, type Component } from "vue";
import { api, ApiError } from "../../api";
import { createLatestDataLoader } from "../../latest-data-loader";
import { candidateKey, providerLabel, type CandidateStatus, type MonitorCandidate, type Provider } from "../../service-candidate-tree";
import { normalizeMaintenanceScriptActions } from "../../service-maintenance-payload";
import { reorderIds, sameOrder } from "../../../shared/tab-order";
import { defaultMonitorAlertSettings, monitorDiskKey, type MonitorAlertSettings, } from "../../../shared/monitor-alerts";
import AnimatedCounter from "../AnimatedCounter.vue";
import DeploymentMonitorDashboard from "../DeploymentMonitorDashboard.vue";
import HostMonitorDashboard, { type HostFocusMetric } from "../HostMonitorDashboard.vue";
import ServiceDiscoveryPanel from "../ServiceDiscoveryPanel.vue";
import type { MaintenanceWorkspace, HostWorkspaceTab, MaintenanceDirectory, DirectoryMoveDirection, ScriptActionIcon, DirectoryDropTarget, ScriptAction, ScriptActionExecutionResult, ScriptActionExecution, HostSnapshot, KubernetesConfigDiscovery, MonitorHost, MonitorInstallPreflight, MonitorInstallTaskStatus, MonitorInstallTaskPhase, MonitorInstallTask, Deployment, ServiceItem, EnvironmentLog, MaintenancePayload, MaintenanceDeploymentResponse, MaintenanceServiceResponse, MaintenancePayloadResponse, MaintenanceCounts, MaintenancePanelProps, MaintenancePanelEmit } from "./types";
import { deferMaintenancePart, type MaintenanceContext } from "./context";

export function useAlertSettings(ctx: MaintenanceContext, props: Readonly<MaintenancePanelProps>, emit: MaintenancePanelEmit) {
  const $payload = deferMaintenancePart(ctx, "payload");
  const $directory = deferMaintenancePart(ctx, "directory");
  const $monitorInstall = deferMaintenancePart(ctx, "monitorInstall");
  const $scriptActions = deferMaintenancePart(ctx, "scriptActions");
  const alertSettingsDialog = ref(false);

  const savingAlertSettings = ref(false);

  const alertSettingsForm = reactive<MonitorAlertSettings>({ ...defaultMonitorAlertSettings, excludedDisks: [] });

  const cpuVisualThreshold = computed(() => $payload.visualThreshold($payload.payload.value.alertSettings.cpuEnabled, $payload.payload.value.alertSettings.cpuThreshold, 80));

  const memoryVisualThreshold = computed(() => $payload.visualThreshold($payload.payload.value.alertSettings.memoryEnabled, $payload.payload.value.alertSettings.memoryThreshold, 80));

  const diskVisualThreshold = computed(() => $payload.visualThreshold($payload.payload.value.alertSettings.diskUsageEnabled, $payload.payload.value.alertSettings.diskUsageThreshold, 80));

  const monitorDiskOptions = computed(() => {
      const options = new Map<string, {
          key: string;
          label: string;
      }>();
      for (const host of $payload.payload.value.hosts) {
          for (const disk of host.snapshot?.disks ?? []) {
              const key = monitorDiskKey(disk);
              const identity = [disk.device, disk.path].filter(Boolean).join(" · ");
              options.set(key, { key, label: `${host.connectionName} · ${identity}` });
          }
      }
      return [...options.values()];
  });

  function openAlertSettings() {
      Object.assign(alertSettingsForm, $payload.payload.value.alertSettings, { excludedDisks: [...$payload.payload.value.alertSettings.excludedDisks] });
      alertSettingsDialog.value = true;
  }

  async function saveAlertSettings() {
      savingAlertSettings.value = true;
      try {
          const response = await api<{
              item: MonitorAlertSettings;
          }>(`/api/v1/environments/${props.environmentId}/monitor-alert-settings`, {
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
                  tlsEnabled: alertSettingsForm.tlsEnabled,
                  tlsWarnDays: alertSettingsForm.tlsWarnDays,
                  tlsHostnameMismatchEnabled: alertSettingsForm.tlsHostnameMismatchEnabled,
                  excludedDisks: alertSettingsForm.excludedDisks,
              }),
          });
          $payload.payload.value.alertSettings = response.item;
          alertSettingsDialog.value = false;
          ElMessage.success(response.item.enabled ? tr("监控告警已启用") : tr("监控告警已关闭"));
      }
      finally {
          savingAlertSettings.value = false;
      }
  }

  return {
    alertSettingsDialog,
    savingAlertSettings,
    alertSettingsForm,
    cpuVisualThreshold,
    memoryVisualThreshold,
    diskVisualThreshold,
    monitorDiskOptions,
    openAlertSettings,
    saveAlertSettings,
  };
}

