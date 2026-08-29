import type { FastifyInstance, FastifyRequest } from "fastify";
import { canAccessEnvironment, getWorkspaceAccess, workspaceParams } from "./access-control.js";
import {
  MONITORING_MAX_HOSTS,
  MONITORING_MAX_SERVICES,
  MONITORING_OVERVIEW_CACHE_MS,
  compareMonitoringHosts,
  finiteMetric,
  isMonitorStale,
} from "../shared/monitoring.js";

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson<unknown>(value, {});
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

const overviewCache = new Map<string, { expiresAt: number; payload: Record<string, unknown> }>();

function average(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

export async function loadMonitoringOverview(
  app: FastifyInstance,
  request: FastifyRequest,
  query: { environmentId?: string; hostCursor?: string; hostLimit?: number; serviceLimit?: number },
): Promise<Record<string, unknown>> {
  const [workspaceType, workspaceId] = workspaceParams(request);
  if (query.environmentId && !await canAccessEnvironment(app.db, request.admin!, query.environmentId)) {
    const error = new Error("ENVIRONMENT_NOT_FOUND");
    (error as Error & { statusCode: number; code: string }).statusCode = 404;
    (error as Error & { statusCode: number; code: string }).code = "ENVIRONMENT_NOT_FOUND";
    throw error;
  }
  const cacheKey = `${workspaceType}:${workspaceId}:${request.admin!.id}:${query.environmentId ?? ""}:${query.hostCursor ?? ""}:${query.hostLimit ?? ""}:${query.serviceLimit ?? ""}`;
  const cached = overviewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const access = await getWorkspaceAccess(app.db, request.admin!);
  const hostLimit = Math.min(Math.max(1, query.hostLimit ?? MONITORING_MAX_HOSTS), MONITORING_MAX_HOSTS);
  const serviceLimit = Math.min(Math.max(1, query.serviceLimit ?? MONITORING_MAX_SERVICES), MONITORING_MAX_SERVICES);
  const environmentFilter = query.environmentId ? "AND e.id = ?" : "";
  const environmentParams = query.environmentId ? [query.environmentId] : [];

  const hostRows = await app.db.prepare(`
    SELECT e.id AS environment_id, e.name AS environment_name,
      c.id AS ssh_connection_id, c.name AS connection_name, c.host, c.source_deleted,
      h.status, h.agent_id, h.agent_version, h.latest_host_json, h.last_collected_at, h.last_pulled_at,
      h.last_error, h.install_managed, h.install_path
    FROM environments e
    JOIN ssh_connection_environments ce ON ce.environment_id = e.id
    JOIN ssh_connections c ON c.id = ce.connection_id
    LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
    WHERE e.workspace_type = ? AND e.workspace_id = ?
      AND c.workspace_type = e.workspace_type AND c.workspace_id = e.workspace_id
      AND c.source_deleted = 0 ${environmentFilter}
    ORDER BY e.name, c.name, c.id
  `).all(workspaceType, workspaceId, ...environmentParams) as Record<string, unknown>[];

  const visibleHosts: Record<string, unknown>[] = [];
  const partialFailures: string[] = [];
  for (const row of hostRows) {
    if (!access.canManage && !access.environmentIds.has(String(row.environment_id))) continue;
    if (!access.canManage && !access.sshConnectionIds.has(String(row.ssh_connection_id))) continue;
    visibleHosts.push(row);
  }

  const mappedHosts = visibleHosts.map((row) => {
    const snapshot = parseObject(row.latest_host_json);
    const disks = Array.isArray(snapshot.disks) ? snapshot.disks as Array<Record<string, unknown>> : [];
    const diskPercents = disks.map((disk) => finiteMetric(disk.usedPercent)).filter((value): value is number => value !== null);
    const worstDisk = disks.reduce<Record<string, unknown> | null>((worst, disk) => {
      const used = finiteMetric(disk.usedPercent);
      if (used === null) return worst;
      const worstUsed = finiteMetric(worst?.usedPercent);
      return worstUsed === null || used > worstUsed ? disk : worst;
    }, null);
    const temperatures = Array.isArray(snapshot.temperatures) ? snapshot.temperatures as Array<Record<string, unknown>> : [];
    const hottest = temperatures.reduce<number | null>((max, item) => {
      const value = finiteMetric(item.celsius);
      if (value === null) return max;
      return max === null || value > max ? value : max;
    }, null);
    const status = String(row.status ?? "unknown");
    const collectedAt = row.last_collected_at ? String(row.last_collected_at) : null;
    const resolution = finiteMetric(snapshot.resolutionSeconds) ?? 30;
    const stale = status === "ready" && isMonitorStale(collectedAt, resolution);
    const offline = status === "error";
    const missing = status === "missing" || (!row.agent_id && !row.install_managed);
    return {
      sshConnectionId: row.ssh_connection_id,
      connectionName: row.connection_name,
      host: row.host,
      environmentId: row.environment_id,
      environmentName: row.environment_name,
      status,
      offline,
      missing,
      stale,
      agentId: row.agent_id || "",
      agentVersion: row.agent_version || "",
      lastCollectedAt: collectedAt,
      lastPulledAt: row.last_pulled_at ? String(row.last_pulled_at) : null,
      lastError: String(row.last_error ?? ""),
      installManaged: Boolean(row.install_managed),
      cpuUsedPercent: missing ? null : finiteMetric(snapshot.cpuUsedPercent),
      memoryUsedPercent: missing ? null : finiteMetric(snapshot.memoryUsedPercent),
      diskUsedPercent: missing ? null : (diskPercents.length ? Math.max(...diskPercents) : null),
      networkReceiveBytesPerSecond: missing ? null : finiteMetric(snapshot.networkReceiveBytesPerSecond),
      networkTransmitBytesPerSecond: missing ? null : finiteMetric(snapshot.networkTransmitBytesPerSecond),
      temperatureCelsius: missing ? null : hottest,
      operatingSystem: snapshot.operatingSystem ? String(snapshot.operatingSystem) : "",
      architecture: snapshot.architecture ? String(snapshot.architecture) : "",
      worstDisk: worstDisk ? {
        path: String(worstDisk.path ?? ""),
        usedPercent: finiteMetric(worstDisk.usedPercent),
      } : null,
    };
  });

  mappedHosts.sort(compareMonitoringHosts);

  let hostStart = 0;
  if (query.hostCursor) {
    const index = mappedHosts.findIndex((host) => String(host.sshConnectionId) === query.hostCursor);
    hostStart = index >= 0 ? index + 1 : 0;
  }
  const hosts = mappedHosts.slice(hostStart, hostStart + hostLimit);
  const hostsTruncated = hostStart + hosts.length < mappedHosts.length;

  const serviceRows = await app.db.prepare(`
    SELECT s.id, s.name, s.status, s.environment_id, e.name AS environment_name,
      d.id AS deployment_id, d.display_name, d.external_id, d.provider_type, d.status AS deployment_status,
      d.latest_metrics_json, d.ssh_connection_id, d.ssh_connection_name, d.last_checked_at
    FROM services s
    JOIN environments e ON e.id = s.environment_id
    LEFT JOIN service_deployments d ON d.service_id = s.id
    WHERE e.workspace_type = ? AND e.workspace_id = ? ${environmentFilter}
    ORDER BY s.name, d.created_at
  `).all(workspaceType, workspaceId, ...environmentParams) as Record<string, unknown>[];

  const servicesById = new Map<string, {
    id: string;
    name: string;
    status: string;
    environmentId: string;
    environmentName: string;
    deployments: Array<Record<string, unknown>>;
  }>();
  for (const row of serviceRows) {
    if (!access.canManage && !access.environmentIds.has(String(row.environment_id))) continue;
    const current = servicesById.get(String(row.id)) ?? {
      id: String(row.id),
      name: String(row.name),
      status: String(row.status),
      environmentId: String(row.environment_id),
      environmentName: String(row.environment_name),
      deployments: [],
    };
    if (row.deployment_id) {
      const metrics = parseObject(row.latest_metrics_json);
      current.deployments.push({
        id: row.deployment_id,
        name: row.display_name || row.external_id,
        provider: row.provider_type,
        status: row.deployment_status,
        sshConnectionId: row.ssh_connection_id,
        sshConnectionName: row.ssh_connection_name,
        lastCheckedAt: row.last_checked_at,
        cpuUsedPercent: finiteMetric(metrics.cpuUsedPercent),
        memoryBytes: finiteMetric(metrics.memoryBytes),
        restartCount: finiteMetric(metrics.restartCount),
      });
    }
    servicesById.set(String(row.id), current);
  }
  const allServices = [...servicesById.values()];
  const servicesTruncated = allServices.length > serviceLimit;
  const services = allServices.slice(0, serviceLimit).map((service) => {
    const running = service.deployments.filter((item) => item.status === "running").length;
    const problem = service.deployments.filter((item) => item.status === "stopped" || item.status === "degraded").length;
    const cpuValues = service.deployments.map((item) => finiteMetric(item.cpuUsedPercent));
    const memoryValues = service.deployments.map((item) => finiteMetric(item.memoryBytes));
    return {
      id: service.id,
      name: service.name,
      status: service.status,
      environmentId: service.environmentId,
      environmentName: service.environmentName,
      deploymentCount: service.deployments.length,
      runningCount: running,
      problemCount: problem,
      cpuUsedPercent: average(cpuValues),
      memoryBytes: average(memoryValues),
      health: service.status === "disabled" ? "disabled" : problem ? "degraded" : running && running === service.deployments.length ? "running" : service.deployments.length ? "unknown" : "empty",
    };
  });
  const rankedServices = [...services].sort((left, right) => {
    if (right.problemCount !== left.problemCount) return right.problemCount - left.problemCount;
    return (right.cpuUsedPercent ?? -1) - (left.cpuUsedPercent ?? -1);
  }).slice(0, 10);
  services.sort((left, right) => {
    if (right.problemCount !== left.problemCount) return right.problemCount - left.problemCount;
    if ((right.health === "degraded" ? 1 : 0) !== (left.health === "degraded" ? 1 : 0)) {
      return (right.health === "degraded" ? 1 : 0) - (left.health === "degraded" ? 1 : 0);
    }
    return (right.cpuUsedPercent ?? -1) - (left.cpuUsedPercent ?? -1);
  });
  const problemNodes = allServices.flatMap((service) => service.deployments.map((deployment) => ({
    serviceId: service.id,
    serviceName: service.name,
    environmentId: service.environmentId,
    id: deployment.id,
    name: deployment.name,
    status: deployment.status,
    sshConnectionId: deployment.sshConnectionId,
    sshConnectionName: deployment.sshConnectionName,
    cpuUsedPercent: deployment.cpuUsedPercent,
    restartCount: deployment.restartCount,
  }))).filter((item) => item.status === "degraded" || item.status === "stopped" || (finiteMetric(item.cpuUsedPercent) ?? 0) >= 80 || (finiteMetric(item.restartCount) ?? 0) > 0)
    .sort((left, right) => (finiteMetric(right.cpuUsedPercent) ?? -1) - (finiteMetric(left.cpuUsedPercent) ?? -1))
    .slice(0, 10);

  const healthyHosts = mappedHosts.filter((host) => !host.missing && !host.offline && !host.stale);
  const payload = {
    generatedAt: new Date().toISOString(),
    truncated: hostsTruncated || servicesTruncated,
    nextHostCursor: hostsTruncated ? String(hosts[hosts.length - 1]?.sshConnectionId ?? "") : null,
    partialFailures,
    summary: {
      hostTotal: mappedHosts.length,
      hostOnline: mappedHosts.filter((host) => host.status === "ready" && !host.stale && !host.offline && !host.missing).length,
      hostOffline: mappedHosts.filter((host) => host.offline).length,
      hostMissing: mappedHosts.filter((host) => host.missing).length,
      hostStale: mappedHosts.filter((host) => host.stale).length,
      serviceTotal: allServices.length,
      avgCpuPercent: average(healthyHosts.map((host) => host.cpuUsedPercent)),
      avgMemoryPercent: average(healthyHosts.map((host) => host.memoryUsedPercent)),
      diskAlerts: mappedHosts.filter((host) => !host.stale && !host.missing && !host.offline && (host.diskUsedPercent ?? 0) >= 90 && host.diskUsedPercent !== null).length,
    },
    hosts,
    services,
    serviceRanking: rankedServices,
    problemNodes,
  };
  overviewCache.set(cacheKey, { expiresAt: Date.now() + MONITORING_OVERVIEW_CACHE_MS, payload });
  return payload;
}

export function clearMonitoringOverviewCache(): void {
  overviewCache.clear();
}
