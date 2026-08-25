import type { MaintenanceApi } from "./api-contract";

type MaintenancePart<Keys extends keyof MaintenanceApi> = Pick<MaintenanceApi, Keys>;

export type MaintenancePayloadApi = MaintenancePart<
  | "loading"
  | "saving"
  | "payload"
  | "selectedServiceId"
  | "selectedHostId"
  | "activeWorkspace"
  | "hostWorkspaceTab"
  | "hostFocusMetric"
  | "discoveryTargetServiceId"
  | "pendingDiscoveryCandidate"
  | "creatingServiceFromDiscovery"
  | "servicePickerDialog"
  | "refreshingHosts"
  | "runningAction"
  | "serviceDialog"
  | "deploymentDialog"
  | "logDialog"
  | "kubernetesDialog"
  | "editingServiceId"
  | "editingDeploymentId"
  | "manualDeployment"
  | "savingKubernetes"
  | "refreshTimer"
  | "serviceForm"
  | "deploymentForm"
  | "selectedLogIds"
  | "selectedKubernetesContextKeys"
  | "selectedService"
  | "selectedHost"
  | "selectedLogs"
  | "hostCandidates"
  | "candidateOptions"
  | "serviceSummary"
  | "runningDeployments"
  | "problemDeployments"
  | "monitoredHosts"
  | "offlineHosts"
  | "unmonitoredHosts"
  | "attentionItems"
  | "selectedUnmanagedCount"
  | "selectedWorstDisk"
  | "selectableKubernetesConfigs"
  | "discoveryManagedKeys"
  | "load"
  | "reload"
  | "countPhysicalMonitorHosts"
  | "fetchMaintenance"
  | "applyFocusTarget"
  | "stopAutoRefresh"
  | "startAutoRefresh"
  | "summarizeService"
  | "statusLabel"
  | "candidateLocationLabel"
  | "supportsMaintenanceActions"
  | "unsupportedMaintenanceActionReason"
  | "deploymentIdentity"
  | "kubernetesMetric"
  | "kubernetesContextKey"
  | "kubernetesConfigStatusLabel"
  | "openKubernetesConfiguration"
  | "saveKubernetesConfiguration"
  | "formatPercent"
  | "formatBytes"
  | "formatDuration"
  | "formatTime"
  | "formatRelativeCollected"
  | "hostPresence"
  | "hostLiveCpu"
  | "worstDisk"
  | "metricTone"
  | "hostUnmanagedCount"
  | "visualThreshold"
  | "selectService"
  | "selectHost"
  | "openServiceCreate"
  | "openServiceEdit"
  | "saveService"
  | "removeService"
  | "resetDeploymentForm"
  | "openDeploymentCreate"
  | "assignDiscoveryTarget"
  | "beginCandidateEnrollment"
  | "pickServiceForDiscovery"
  | "createServiceFromDiscovery"
  | "cancelServicePicker"
  | "onServicePickerClosed"
  | "discoveryPickerIntro"
  | "openDeploymentEdit"
  | "saveDeployment"
  | "removeDeployment"
  | "openLogLinks"
  | "saveLogLinks"
  | "refreshHost"
  | "runMaintenanceAction"
>;

export type MaintenanceDirectoryApi = MaintenancePart<
  | "draggingDirectory"
  | "serviceDropTarget"
  | "hostDropTarget"
  | "savingServiceOrder"
  | "savingHostOrder"
  | "canSortDirectory"
  | "directoryIds"
  | "orderedDirectoryItems"
  | "directoryDropTarget"
  | "insertAfterDirectoryTarget"
  | "startDirectoryDrag"
  | "dragDirectoryOver"
  | "leaveDirectoryDropTarget"
  | "persistDirectoryOrder"
  | "dropDirectoryItem"
  | "endDirectoryDrag"
  | "canMoveDirectoryItem"
  | "moveDirectoryItem"
  | "handleDirectoryMove"
>;

export type MonitorInstallApi = MaintenancePart<
  | "installingHosts"
  | "clearingHosts"
  | "installTask"
  | "installTaskConnectionId"
  | "installProgressDialog"
  | "installTaskTimer"
  | "notifiedInstallTasks"
  | "selectedInstallTask"
  | "installTaskSteps"
  | "isInstallTaskActive"
  | "stopInstallTaskPolling"
  | "startInstallTaskPolling"
  | "switchInstallTaskHost"
  | "refreshInstallTask"
  | "openInstallProgress"
  | "installTaskStepState"
  | "installTaskStatusLabel"
  | "formatInstallTaskElapsed"
  | "formatInstallLogTime"
  | "isMonitorInstalled"
  | "validMonitorInstallPath"
  | "promptMonitorInstallPath"
  | "installMonitorOnHost"
  | "clearMonitorData"
>;

export type ScriptActionsApi = MaintenancePart<
  | "scriptActionIconComponents"
  | "scriptActionIconOptions"
  | "runningScriptActionId"
  | "scriptActionManagerDialog"
  | "scriptActionEditorOpen"
  | "scriptActionResultDialog"
  | "editingScriptActionId"
  | "scriptActionExecution"
  | "scriptActionScope"
  | "scriptActionForm"
  | "scopedScriptActions"
  | "resolveScriptActionIcon"
  | "resetScriptActionForm"
  | "beginScriptActionCreate"
  | "beginScriptActionEdit"
  | "openScriptActionManager"
  | "saveScriptAction"
  | "removeScriptAction"
  | "executeScriptAction"
  | "formatScriptDuration"
  | "scriptExecutionSummary"
>;

export type AlertSettingsApi = MaintenancePart<
  | "alertSettingsDialog"
  | "savingAlertSettings"
  | "alertSettingsForm"
  | "cpuVisualThreshold"
  | "memoryVisualThreshold"
  | "diskVisualThreshold"
  | "monitorDiskOptions"
  | "openAlertSettings"
  | "saveAlertSettings"
>;

export interface MaintenanceContext {
  payload: MaintenancePayloadApi | null;
  directory: MaintenanceDirectoryApi | null;
  monitorInstall: MonitorInstallApi | null;
  scriptActions: ScriptActionsApi | null;
  alertSettings: AlertSettingsApi | null;
}

export function createMaintenanceContext(): MaintenanceContext {
  return { payload: null, directory: null, monitorInstall: null, scriptActions: null, alertSettings: null };
}

export function requireMaintenancePart<Key extends keyof MaintenanceContext>(ctx: MaintenanceContext, key: Key): NonNullable<MaintenanceContext[Key]> {
  const part = ctx[key];
  if (part === null) throw new Error(`Maintenance part is not bound: ${key}`);
  return part as NonNullable<MaintenanceContext[Key]>;
}

export function deferMaintenancePart<Key extends keyof MaintenanceContext>(ctx: MaintenanceContext, key: Key): NonNullable<MaintenanceContext[Key]> {
  const proxy = new Proxy({}, {
    get(_target, property) {
      return Reflect.get(requireMaintenancePart(ctx, key) as object, property);
    },
    set(_target, property, value) {
      return Reflect.set(requireMaintenancePart(ctx, key) as object, property, value);
    },
  });
  return proxy as NonNullable<MaintenanceContext[Key]>;
}
