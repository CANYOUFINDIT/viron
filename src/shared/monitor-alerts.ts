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

export const MONITOR_DISK_TYPES = ["host_local", "nfs", "csi_network", "container_pod"] as const;
export type MonitorDiskType = (typeof MONITOR_DISK_TYPES)[number];
export const defaultMonitoredDiskTypes: MonitorDiskType[] = ["host_local"];
export const MONITOR_DISK_TYPE_OPTIONS: Array<{ value: MonitorDiskType; label: string; description: string }> = [
  { value: "host_local", label: "主机本地磁盘", description: "节点自身的本地块设备和文件系统，例如 / 与 /data" },
  { value: "nfs", label: "NFS", description: "宿主机上的 NFS 网络文件系统挂载" },
  { value: "csi_network", label: "CSI 或其他网络卷", description: "CIFS、Ceph、Gluster 等宿主机网络卷" },
  { value: "container_pod", label: "容器与 Pod 挂载", description: "kubelet、containerd、Docker 等运行时下的 Pod 与容器卷，包括其中的 NFS 与 CSI" },
];

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
  monitoredDiskTypes: MonitorDiskType[];
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

export interface MonitorPlatformEventItem extends MonitorHostEventItem {
  environmentId: string;
  environmentName: string;
  sshConnectionId: string | null;
  serviceId: string | null;
  serviceName: string;
  connectionName: string;
  targetType: MonitorAlertTargetType;
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
  monitoredDiskTypes: [...defaultMonitoredDiskTypes],
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

export function monitorDiskIdentity(key: string): { device: string; path: string } | null {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length === 2) {
      return { device: String(parsed[0] ?? ""), path: String(parsed[1] ?? "") };
    }
  } catch {
    // Preserve opaque historical disk identities.
  }
  return null;
}

export function parseMonitoredDiskTypes(value: unknown): MonitorDiskType[] {
  if (!Array.isArray(value)) return [...defaultMonitoredDiskTypes];
  const allowed = new Set<string>(MONITOR_DISK_TYPES);
  const unique: MonitorDiskType[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item) || unique.includes(item as MonitorDiskType)) continue;
    unique.push(item as MonitorDiskType);
  }
  return unique;
}

const virtualMonitorDiskFilesystems = new Set([
  "autofs", "cgroup", "cgroup2", "configfs", "debugfs", "devfs", "devtmpfs",
  "fuse.lxcfs", "fuse.portal", "fusectl", "hugetlbfs", "mqueue", "nsfs",
  "overlay", "proc", "pstore", "securityfs", "squashfs", "sysfs", "tmpfs", "tracefs",
]);

const nfsMonitorDiskFilesystems = new Set(["nfs", "nfs4"]);
const networkMonitorDiskFilesystems = new Set(["9p", "ceph", "cifs", "glusterfs", "smb3"]);

const containerPodMonitorDiskMountRoots = [
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

function pathUnderMonitorDiskRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function monitorDiskType(disk: { path: string; device?: string; filesystem?: string }): MonitorDiskType | null {
  const path = disk.path.trim();
  if (!path) return null;
  const filesystem = disk.filesystem?.trim().toLowerCase() ?? "";
  if (virtualMonitorDiskFilesystems.has(filesystem)) return null;
  const device = disk.device?.trim() ?? "";
  if (pathUnderMonitorDiskRoot(path, containerPodMonitorDiskMountRoots)) return "container_pod";
  if (nfsMonitorDiskFilesystems.has(filesystem) || device.includes(":/")) return "nfs";
  if (
    networkMonitorDiskFilesystems.has(filesystem)
    || device.startsWith("//")
    || (filesystem.startsWith("fuse.") && filesystem !== "fuse.lxcfs" && filesystem !== "fuse.portal")
  ) return "csi_network";
  return "host_local";
}

export function monitorDiskIsEligible(
  disk: { path: string; device?: string; filesystem?: string },
  types: readonly MonitorDiskType[] = defaultMonitoredDiskTypes,
): boolean {
  const type = monitorDiskType(disk);
  return type !== null && types.includes(type);
}

function preferredMonitorDisk<T extends { path: string }>(left: T, right: T): T {
  const depth = (path: string) => path === "/" ? -1 : path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).length;
  const leftDepth = depth(left.path);
  const rightDepth = depth(right.path);
  if (leftDepth !== rightDepth) return leftDepth < rightDepth ? left : right;
  if (left.path.length !== right.path.length) return left.path.length < right.path.length ? left : right;
  return left.path <= right.path ? left : right;
}

export function stableMonitorDisks<T extends { path: string; device?: string; filesystem?: string }>(
  disks: T[],
  types: readonly MonitorDiskType[] = defaultMonitoredDiskTypes,
): T[] {
  const byDevice = new Map<string, T>();
  for (const disk of disks) {
    if (!monitorDiskIsEligible(disk, types)) continue;
    const normalizedDevice = disk.device?.trim().replace(/^\/dev\//, "") || "";
    const key = normalizedDevice || `path:${disk.path.trim()}`;
    const current = byDevice.get(key);
    byDevice.set(key, current ? preferredMonitorDisk(current, disk) : disk);
  }
  return [...byDevice.values()].sort((left, right) => left.path.localeCompare(right.path) || String(left.device ?? "").localeCompare(String(right.device ?? "")));
}

export function visibleMonitorDisks<T extends { path: string; device?: string; filesystem?: string }>(
  disks: T[] | undefined,
  settings: Pick<MonitorAlertSettings, "monitoredDiskTypes" | "excludedDisks"> = defaultMonitorAlertSettings,
): T[] {
  const excluded = new Set(settings.excludedDisks);
  const excludedPaths = new Set(settings.excludedDisks.flatMap((key) => {
    const disk = monitorDiskIdentity(key);
    return disk?.path ? [disk.path] : [];
  }));
  return stableMonitorDisks(disks ?? [], settings.monitoredDiskTypes).filter((disk) => {
    const key = monitorDiskKey(disk);
    return !excluded.has(key) && !excludedPaths.has(disk.path.trim());
  });
}
