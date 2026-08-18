export type MonitorAlertRuleType =
  | "host_offline"
  | "cpu"
  | "memory"
  | "disk_usage"
  | "temperature"
  | "disk_added"
  | "disk_missing"
  | "deployment_status";

export type MonitorAlertTargetType = "host" | "deployment";

export interface MonitorAlertSettings {
  enabled: boolean;
  hostOfflineEnabled: boolean;
  cpuEnabled: boolean;
  cpuThreshold: number;
  memoryEnabled: boolean;
  memoryThreshold: number;
  diskUsageEnabled: boolean;
  diskUsageThreshold: number;
  temperatureEnabled: boolean;
  temperatureThreshold: number;
  deploymentStatusEnabled: boolean;
  diskMissingEnabled: boolean;
  excludedDisks: string[];
  consecutiveSamples: 2;
}

export interface MonitorAlertItem {
  id: string;
  environmentId: string;
  environmentName: string;
  targetType: MonitorAlertTargetType;
  targetId: string;
  ruleType: MonitorAlertRuleType;
  ruleKey: string;
  sshConnectionId: string | null;
  serviceId: string | null;
  deploymentId: string | null;
  targetName: string;
  connectionName: string;
  serviceName: string;
  status: "active" | "recovered" | "event";
  details: Record<string, unknown>;
  triggeredAt: string;
  recoveredAt: string | null;
  notificationPhase: "active" | "recovered" | null;
  read: boolean;
}

export interface MonitorAlertListResponse {
  items: MonitorAlertItem[];
  unread: number;
}

export interface DesktopMonitorAlertNotification {
  id: string;
  title: string;
  body: string;
  environmentId: string;
  sshConnectionId: string | null;
  serviceId: string | null;
  deploymentId: string | null;
}

export const defaultMonitorAlertSettings: MonitorAlertSettings = {
  enabled: false,
  hostOfflineEnabled: true,
  cpuEnabled: true,
  cpuThreshold: 90,
  memoryEnabled: true,
  memoryThreshold: 90,
  diskUsageEnabled: true,
  diskUsageThreshold: 90,
  temperatureEnabled: true,
  temperatureThreshold: 80,
  deploymentStatusEnabled: true,
  diskMissingEnabled: true,
  excludedDisks: [],
  consecutiveSamples: 2,
};

export function monitorAlertNavigationQuery(alert: Pick<MonitorAlertItem, "sshConnectionId" | "serviceId" | "deploymentId">) {
  const serviceTarget = Boolean(alert.serviceId || alert.deploymentId);
  return {
    tab: "maintenance",
    ...(!serviceTarget && alert.sshConnectionId ? { maintenanceHostId: alert.sshConnectionId } : {}),
    ...(alert.serviceId ? { maintenanceServiceId: alert.serviceId } : {}),
    ...(alert.deploymentId ? { maintenanceDeploymentId: alert.deploymentId } : {}),
  };
}

export function monitorDiskKey(disk: { path: string; device?: string }): string {
  return JSON.stringify([disk.device?.trim() ?? "", disk.path.trim()]);
}
