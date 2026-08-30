export type MonitorAlertRuleType =
  | "host_offline"
  | "cpu"
  | "memory"
  | "disk_usage"
  | "temperature"
  | "disk_added"
  | "disk_missing"
  | "deployment_status"
  | "tls_expiring"
  | "tls_expired"
  | "tls_hostname_mismatch";

export type MonitorAlertTargetType = "host" | "deployment" | "tls_endpoint";

export const MONITOR_ALERT_SEVERITIES = ["info", "warning", "major", "critical"] as const;
export type MonitorAlertSeverity = (typeof MONITOR_ALERT_SEVERITIES)[number];
export type MonitorAlertNotificationPhase = "active" | "escalated" | "recovered";

export const monitorAlertSeverityWeight: Record<MonitorAlertSeverity, number> = {
  info: 0,
  warning: 1,
  major: 3,
  critical: 8,
};

export function monitorAlertSeverityRank(severity: MonitorAlertSeverity): number {
  return MONITOR_ALERT_SEVERITIES.indexOf(severity);
}

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
  tlsEnabled: boolean;
  tlsWarnDays: number;
  tlsHostnameMismatchEnabled: boolean;
  excludedDisks: string[];
  consecutiveSamples: 2;
}

export interface MonitorAlertItem {
  id: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  workspaceName: string;
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
  severity: MonitorAlertSeverity;
  peakSeverity: MonitorAlertSeverity;
  occurrenceCount: number;
  details: Record<string, unknown>;
  triggeredAt: string;
  recoveredAt: string | null;
  lastSeenAt: string;
  notificationPhase: MonitorAlertNotificationPhase | null;
  read: boolean;
}

export interface MonitorAlertListResponse {
  items: MonitorAlertItem[];
  unread: number;
}

export interface MonitorHostEventCalendarDay {
  date: string;
  future: boolean;
  coverageRatio: number;
  newEventCount: number;
  activeEventCount: number;
  infoCount: number;
  warningCount: number;
  majorCount: number;
  criticalCount: number;
  affectedMinutes: number;
  peakSeverity: MonitorAlertSeverity | null;
  burdenScore: number;
}

export interface MonitorHostEventCalendarSummary {
  healthyDays: number;
  affectedDays: number;
  noDataDays: number;
  criticalEvents: number;
  totalEvents: number;
  affectedMinutes: number;
  meanRecoveryMinutes: number | null;
}

export interface MonitorHostEventCalendarResponse {
  month: string;
  timezone: string;
  from: string;
  to: string;
  generatedAt: string;
  days: MonitorHostEventCalendarDay[];
  summary: MonitorHostEventCalendarSummary;
}

export interface MonitorHostEventItem {
  id: string;
  ruleType: MonitorAlertRuleType;
  ruleKey: string;
  status: "active" | "recovered" | "event";
  severity: MonitorAlertSeverity;
  peakSeverity: MonitorAlertSeverity;
  occurrenceCount: number;
  targetName: string;
  details: Record<string, unknown>;
  triggeredAt: string;
  recoveredAt: string | null;
  lastSeenAt: string;
}

export interface DesktopMonitorAlertNotification {
  id: string;
  title: string;
  body: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
  workspaceName: string;
  environmentId: string;
  sshConnectionId: string | null;
  serviceId: string | null;
  deploymentId: string | null;
  targetType?: MonitorAlertTargetType;
  targetId?: string;
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
  tlsEnabled: true,
  tlsWarnDays: 14,
  tlsHostnameMismatchEnabled: true,
  excludedDisks: [],
  consecutiveSamples: 2,
};

export function monitorAlertNavigationQuery(alert: Pick<MonitorAlertItem, "sshConnectionId" | "serviceId" | "deploymentId"> & Partial<Pick<MonitorAlertItem, "targetType" | "targetId">>) {
  const certificateTarget = alert.targetType === "tls_endpoint";
  const serviceTarget = Boolean(alert.serviceId || alert.deploymentId);
  return {
    tab: "maintenance",
    ...(certificateTarget && alert.targetId ? { maintenanceEndpointId: alert.targetId } : {}),
    ...(!certificateTarget && !serviceTarget && alert.sshConnectionId ? { maintenanceHostId: alert.sshConnectionId } : {}),
    ...(alert.serviceId ? { maintenanceServiceId: alert.serviceId } : {}),
    ...(alert.deploymentId ? { maintenanceDeploymentId: alert.deploymentId } : {}),
  };
}

export function monitorDiskKey(disk: { path: string; device?: string }): string {
  return JSON.stringify([disk.device?.trim() ?? "", disk.path.trim()]);
}

const ignoredMonitorDiskFilesystems = new Set([
  "9p", "autofs", "ceph", "cgroup", "cgroup2", "cifs", "configfs", "debugfs", "devfs", "devtmpfs",
  "fuse.lxcfs", "fuse.portal", "fusectl", "glusterfs", "hugetlbfs", "mqueue", "nfs", "nfs4", "nsfs",
  "overlay", "proc", "pstore", "securityfs", "smb3", "squashfs", "sysfs", "tmpfs", "tracefs",
]);

const ignoredMonitorDiskMountRoots = [
  "/run/containerd",
  "/run/credentials",
  "/run/docker",
  "/run/k3s/containerd",
  "/run/systemd/unit-root",
  "/var/lib/containers/storage/overlay",
  "/var/lib/containers/storage/overlay-containers",
  "/var/lib/containers/storage/volumes",
  "/var/lib/docker/containers",
  "/var/lib/docker/overlay2",
  "/var/lib/docker/volumes",
  "/var/lib/kubelet/plugins",
  "/var/lib/kubelet/plugins_registry",
  "/var/lib/kubelet/pods",
  "/var/lib/rancher/k3s/agent/containerd",
];

export function monitorDiskIsEligible(disk: { path: string; device?: string; filesystem?: string }): boolean {
  const path = disk.path.trim();
  if (!path) return false;
  const device = disk.device?.trim() ?? "";
  if (device.startsWith("//") || device.includes(":/")) return false;
  if (ignoredMonitorDiskFilesystems.has(disk.filesystem?.trim().toLowerCase() ?? "")) return false;
  return !ignoredMonitorDiskMountRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

function preferredMonitorDisk<T extends { path: string }>(left: T, right: T): T {
  const depth = (path: string) => path === "/" ? -1 : path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).length;
  const leftDepth = depth(left.path);
  const rightDepth = depth(right.path);
  if (leftDepth !== rightDepth) return leftDepth < rightDepth ? left : right;
  if (left.path.length !== right.path.length) return left.path.length < right.path.length ? left : right;
  return left.path <= right.path ? left : right;
}

export function stableMonitorDisks<T extends { path: string; device?: string; filesystem?: string }>(disks: T[]): T[] {
  const byDevice = new Map<string, T>();
  for (const disk of disks) {
    if (!monitorDiskIsEligible(disk)) continue;
    const normalizedDevice = disk.device?.trim().replace(/^\/dev\//, "") || "";
    const key = normalizedDevice || `path:${disk.path.trim()}`;
    const current = byDevice.get(key);
    byDevice.set(key, current ? preferredMonitorDisk(current, disk) : disk);
  }
  return [...byDevice.values()].sort((left, right) => left.path.localeCompare(right.path) || String(left.device ?? "").localeCompare(String(right.device ?? "")));
}
