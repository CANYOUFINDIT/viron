import { translate as tr } from "../../i18n";
import { ElMessage } from "element-plus";
import { computed, reactive, ref } from "vue";
import { api } from "../../api";
import { defaultMonitorAlertSettings, defaultMonitoredDiskTypes, MONITOR_DISK_TYPE_OPTIONS, monitorDiskKey, visibleMonitorDisks, type MonitorAlertSettings, } from "../../../shared/monitor-alerts";

import type { MaintenancePanelProps, MaintenancePanelEmit } from "./types";
import { deferMaintenancePart, type MaintenanceContext } from "./context";

export function useAlertSettings(ctx: MaintenanceContext, props: Readonly<MaintenancePanelProps>, emit: MaintenancePanelEmit) {
  const $payload = deferMaintenancePart(ctx, "payload");
  const $directory = deferMaintenancePart(ctx, "directory");
  const $monitorInstall = deferMaintenancePart(ctx, "monitorInstall");
  const $scriptActions = deferMaintenancePart(ctx, "scriptActions");
  const alertSettingsDialog = ref(false);

  const savingAlertSettings = ref(false);

  const alertSettingsForm = reactive<MonitorAlertSettings>({ ...defaultMonitorAlertSettings, excludedDisks: [], monitoredDiskTypes: [...defaultMonitoredDiskTypes] });
  const monitorDiskTypeOptions = MONITOR_DISK_TYPE_OPTIONS;

  const cpuVisualThreshold = computed(() => $payload.visualThreshold($payload.payload.value.alertSettings.cpuEnabled, $payload.payload.value.alertSettings.cpuThreshold, 80));

  const memoryVisualThreshold = computed(() => $payload.visualThreshold($payload.payload.value.alertSettings.memoryEnabled, $payload.payload.value.alertSettings.memoryThreshold, 80));

  const diskVisualThreshold = computed(() => $payload.visualThreshold($payload.payload.value.alertSettings.diskUsageEnabled, $payload.payload.value.alertSettings.diskUsageThreshold, 80));

  const monitorDiskOptions = computed(() => {
      const options = new Map<string, {
          key: string;
          label: string;
      }>();
      for (const host of $payload.payload.value.hosts) {
          for (const disk of visibleMonitorDisks(host.snapshot?.disks ?? [], alertSettingsForm)) {
              const key = monitorDiskKey(disk);
              const identity = [disk.device, disk.path].filter(Boolean).join(" · ");
              options.set(key, { key, label: `${host.connectionName} · ${identity}` });
          }
      }
      return [...options.values()];
  });

  function copyAlertSettingsForm() {
      Object.assign(alertSettingsForm, $payload.payload.value.alertSettings, {
          excludedDisks: [...$payload.payload.value.alertSettings.excludedDisks],
          monitoredDiskTypes: [...($payload.payload.value.alertSettings.monitoredDiskTypes ?? defaultMonitoredDiskTypes)],
      });
  }

  async function openAlertSettings() {
      try {
          const response = await api<{ item: MonitorAlertSettings }>(`/api/v1/environments/${props.environmentId}/monitor-alert-settings`);
          $payload.payload.value = { ...$payload.payload.value, alertSettings: { ...response.item, excludedDisks: [...(response.item.excludedDisks ?? [])], monitoredDiskTypes: [...(response.item.monitoredDiskTypes ?? defaultMonitoredDiskTypes)] } };
      } catch {
          /* keep last known settings */
      }
      copyAlertSettingsForm();
      alertSettingsDialog.value = true;
  }

  function monitorSettingsBody() {
      return {
          section: "monitor",
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
          monitoredDiskTypes: alertSettingsForm.monitoredDiskTypes,
      };
  }

  async function putAlertSettings() {
      savingAlertSettings.value = true;
      try {
          const response = await api<{
              item: MonitorAlertSettings;
          }>(`/api/v1/environments/${props.environmentId}/monitor-alert-settings`, {
              method: "PUT",
              body: JSON.stringify(monitorSettingsBody()),
          });
          $payload.payload.value.alertSettings = response.item;
          alertSettingsDialog.value = false;
          ElMessage.success(response.item.enabled ? tr("监控告警已启用") : tr("监控告警已关闭"));
      }
      finally {
          savingAlertSettings.value = false;
      }
  }

  async function saveAlertSettings() {
      await putAlertSettings();
  }

  return {
    alertSettingsDialog,
    savingAlertSettings,
    alertSettingsForm,
    cpuVisualThreshold,
    memoryVisualThreshold,
    diskVisualThreshold,
    monitorDiskOptions,
    monitorDiskTypeOptions,
    openAlertSettings,
    saveAlertSettings,
  };
}
