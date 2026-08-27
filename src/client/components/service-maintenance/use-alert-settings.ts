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

  function copyAlertSettingsForm() {
      Object.assign(alertSettingsForm, $payload.payload.value.alertSettings, { excludedDisks: [...$payload.payload.value.alertSettings.excludedDisks] });
  }

  async function openAlertSettings() {
      try {
          const response = await api<{ item: MonitorAlertSettings }>(`/api/v1/environments/${props.environmentId}/monitor-alert-settings`);
          $payload.payload.value = { ...$payload.payload.value, alertSettings: { ...response.item, excludedDisks: [...(response.item.excludedDisks ?? [])] } };
      } catch {
          /* keep last known settings */
      }
      copyAlertSettingsForm();
      alertSettingsDialog.value = true;
  }

  function monitorSettingsBody(section: "monitor" | "tls") {
      const monitor = section === "monitor" ? alertSettingsForm : $payload.payload.value.alertSettings;
      const tls = section === "tls" ? alertSettingsForm : $payload.payload.value.alertSettings;
      return {
          section,
          enabled: monitor.enabled,
          hostOfflineEnabled: monitor.hostOfflineEnabled,
          cpuEnabled: monitor.cpuEnabled,
          cpuThreshold: monitor.cpuThreshold,
          memoryEnabled: monitor.memoryEnabled,
          memoryThreshold: monitor.memoryThreshold,
          diskUsageEnabled: monitor.diskUsageEnabled,
          diskUsageThreshold: monitor.diskUsageThreshold,
          temperatureEnabled: monitor.temperatureEnabled,
          temperatureThreshold: monitor.temperatureThreshold,
          deploymentStatusEnabled: monitor.deploymentStatusEnabled,
          diskMissingEnabled: monitor.diskMissingEnabled,
          excludedDisks: section === "monitor" ? alertSettingsForm.excludedDisks : monitor.excludedDisks,
          ...(section === "tls"
              ? {
                  tlsEnabled: tls.tlsEnabled,
                  tlsWarnDays: tls.tlsWarnDays,
                  tlsHostnameMismatchEnabled: tls.tlsHostnameMismatchEnabled,
              }
              : {}),
      };
  }

  async function putAlertSettings(section: "monitor" | "tls") {
      savingAlertSettings.value = true;
      try {
          const response = await api<{
              item: MonitorAlertSettings;
          }>(`/api/v1/environments/${props.environmentId}/monitor-alert-settings`, {
              method: "PUT",
              body: JSON.stringify(monitorSettingsBody(section)),
          });
          $payload.payload.value.alertSettings = response.item;
          if (section === "tls") {
              ElMessage.success(response.item.tlsEnabled ? tr("证书告警已启用") : tr("证书告警已关闭"));
              return;
          }
          alertSettingsDialog.value = false;
          ElMessage.success(response.item.enabled ? tr("监控告警已启用") : tr("监控告警已关闭"));
      }
      finally {
          savingAlertSettings.value = false;
      }
  }

  async function saveAlertSettings() {
      await putAlertSettings("monitor");
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

