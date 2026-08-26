import type { Component } from "vue";
import type { HostFocusMetric } from "../HostMonitorDashboard.vue";
import type { CandidateStatus, MonitorCandidate, Provider } from "../../service-candidate-tree";
import type { MonitorAlertSettings } from "../../../shared/monitor-alerts";
import type { TlsCertificateGroup, TlsEndpoint, TlsWebEntryBadge } from "../../../shared/tls-certificates";

export type MaintenanceWorkspace = "service" | "host" | "certificate";

export type HostWorkspaceTab = "monitor" | "discovery";

export type MaintenanceDirectory = "service" | "host";

export type DirectoryMoveDirection = "up" | "down";

export type ScriptActionIcon = "terminal" | "rocket" | "refresh" | "database" | "package" | "shield" | "hammer" | "zap";

export interface DirectoryDropTarget {
    id: string;
    after: boolean;
}

export interface ScriptAction {
    id: string;
    serviceId: string;
    deploymentId: string | null;
    name: string;
    icon: ScriptActionIcon;
    scriptBody?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ScriptActionExecutionResult {
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

export interface ScriptActionExecution {
    ok: boolean;
    action: Pick<ScriptAction, "id" | "name" | "icon" | "deploymentId">;
    succeeded: number;
    failed: number;
    results: ScriptActionExecutionResult[];
}

export interface HostSnapshot {
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
    disks: Array<{
        path: string;
        device?: string;
        filesystem?: string;
        totalBytes: number;
        freeBytes: number;
        usedBytes: number;
        usedPercent: number;
    }>;
    temperatures: Array<{
        chip: string;
        feature?: string;
        celsius: number;
        maximum?: number;
        critical?: number;
    }>;
}

export interface KubernetesConfigDiscovery {
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

export interface MonitorHost {
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

export interface MonitorInstallPreflight {
    defaultInstallPath: string;
    installPath: string;
    operatingSystem: string;
    machineArchitecture: string;
    architecture: "amd64" | "arm64" | null;
    systemdAvailable: boolean;
    privilege: "root" | "passwordless_sudo" | "unavailable";
    pathState: "available" | "upgrade" | "conflict" | "legacy";
    existingMonitorPath: string;
    existingInstallation: {
        product: "viron-monitor";
        version: string;
        architecture: "amd64" | "arm64";
        installPath: string;
        installedAt: string;
    } | null;
    packageVersion: string;
    packageAvailable: boolean;
    canInstall: boolean;
    issues: Array<{
        code: string;
        message: string;
    }>;
}

export type MonitorInstallTaskStatus = "pending" | "running" | "success" | "error";

export type MonitorInstallTaskPhase = "queued" | "preflight" | "package_validation" | "ssh_connect" | "staging" | "upload" | "remote_install" | "reconnect" | "initial_collect" | "persist" | "complete";

export interface MonitorInstallTask {
    id: string;
    environmentId: string;
    connectionId: string;
    connectionName: string;
    installPath: string;
    status: MonitorInstallTaskStatus;
    phase: MonitorInstallTaskPhase;
    progress: number;
    currentMessage: string;
    logs: Array<{
        at: string;
        kind: "progress" | "output";
        message: string;
    }>;
    error: string;
    result: {
        monitorWarning?: string;
    };
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
}

export interface Deployment {
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

export interface ServiceItem {
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

export interface EnvironmentLog {
    id: string;
    name: string;
    sshConnectionId: string;
    connectionName: string;
    filePaths: string[];
}

export interface MaintenancePayload {
    canConfigure: boolean;
    canOperate: boolean;
    scriptActionsSupported: boolean;
    alertSettings: MonitorAlertSettings;
    services: ServiceItem[];
    logs: EnvironmentLog[];
    hosts: MonitorHost[];
    tlsEndpoints: TlsEndpoint[];
}

export type { TlsCertificateGroup, TlsEndpoint, TlsWebEntryBadge };

export interface MaintenanceDeploymentResponse extends Omit<Deployment, "scriptActions"> {
    scriptActions?: ScriptAction[];
}

export interface MaintenanceServiceResponse extends Omit<ServiceItem, "scriptActions" | "deployments"> {
    scriptActions?: ScriptAction[];
    deployments: MaintenanceDeploymentResponse[];
}

export interface MaintenancePayloadResponse extends Omit<MaintenancePayload, "scriptActionsSupported" | "services"> {
    services: MaintenanceServiceResponse[];
}

export interface MaintenanceCounts {
    services: number;
    monitoredHosts: number;
}

export interface MaintenancePanelProps {
  environmentId: string;
  focusHostId?: string;
  focusServiceId?: string;
  focusDeploymentId?: string;
  focusEndpointId?: string;
}

export interface MaintenancePanelEmit {
  (event: "count-change", counts: MaintenanceCounts): void;
  (event: "open-log", logId: string): void;
}

