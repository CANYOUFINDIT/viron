import type { FastifyInstance, FastifyRequest } from "fastify";
import { canAccessConnection, canManageWorkspace } from "./access-control.js";
import {
  SERVICE_DEPLOYMENTS_MAX_BYTES,
  SERVICE_DEPLOYMENTS_MAX_DEPLOYMENTS,
  SERVICE_DEPLOYMENTS_MAX_SERVICES,
  capabilityDisabledReason,
  deploymentCapabilities,
} from "../shared/service-operations.js";

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

export async function loadServiceDeploymentsPayload(
  app: FastifyInstance,
  request: FastifyRequest,
  environmentId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<Record<string, unknown>> {
  const [serviceRows, deploymentRows, scriptActionRows, logLinkRows, logRows, connectionRowsRaw] = await Promise.all([
    app.db.prepare("SELECT * FROM services WHERE environment_id = ? ORDER BY sort_order, updated_at DESC, name").all(environmentId) as Promise<Record<string, unknown>[]>,
    app.db.prepare(`
      SELECT d.*, c.host, c.port, c.username, c.source_deleted,
        CASE WHEN c.id IS NULL THEN 0 ELSE EXISTS(
          SELECT 1 FROM ssh_connection_environments ce
          WHERE ce.connection_id = c.id AND ce.environment_id = ?
        ) END AS connection_available
      FROM service_deployments d
      JOIN services s ON s.id = d.service_id
      LEFT JOIN ssh_connections c ON c.id = d.ssh_connection_id
      WHERE s.environment_id = ?
      ORDER BY d.created_at
    `).all(environmentId, environmentId) as Promise<Record<string, unknown>[]>,
    app.db.prepare(`
      SELECT a.id, a.service_id, a.deployment_id, a.name, a.icon, a.created_at, a.updated_at
      FROM service_script_actions a
      JOIN services s ON s.id = a.service_id
      WHERE s.environment_id = ?
      ORDER BY a.created_at, a.name
    `).all(environmentId) as Promise<Record<string, unknown>[]>,
    app.db.prepare(`
      SELECT l.service_id, l.environment_log_id FROM service_log_links l
      JOIN services s ON s.id = l.service_id WHERE s.environment_id = ?
    `).all(environmentId) as Promise<Array<{ service_id: string; environment_log_id: string }>>,
    app.db.prepare(`
      SELECT l.id, l.name, l.ssh_connection_id, l.file_path, l.file_paths_json, c.name AS connection_name
      FROM environment_logs l JOIN ssh_connections c ON c.id = l.ssh_connection_id
      WHERE l.environment_id = ? ORDER BY l.updated_at DESC
    `).all(environmentId) as Promise<Record<string, unknown>[]>,
    app.db.prepare(`
      SELECT c.id, c.name, c.host, c.source_deleted, h.status AS monitor_status, h.latest_candidates_json
      FROM ssh_connections c
      JOIN ssh_connection_environments ce ON ce.connection_id = c.id
      LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
      WHERE ce.environment_id = ?
      ORDER BY ce.maintenance_sort_order, c.name, c.id
    `).all(environmentId) as Promise<Record<string, unknown>[]>,
  ]);

  const connectionRows: Record<string, unknown>[] = [];
  for (const row of connectionRowsRaw) {
    if (await canAccessConnection(app.db, request.admin!, "ssh", String(row.id))) connectionRows.push(row);
  }
  const visibleConnectionIds = new Set(connectionRows.map((row) => String(row.id)));
  const manager = canManageWorkspace(request);
  const scriptActionsByService = new Map<string, Record<string, unknown>[]>();
  const scriptActionsByDeployment = new Map<string, Record<string, unknown>[]>();
  for (const row of scriptActionRows) {
    const action = {
      id: row.id,
      serviceId: row.service_id,
      deploymentId: row.deployment_id,
      name: row.name,
      icon: row.icon,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.deployment_id) {
      const items = scriptActionsByDeployment.get(String(row.deployment_id)) ?? [];
      items.push(action);
      scriptActionsByDeployment.set(String(row.deployment_id), items);
    } else {
      const items = scriptActionsByService.get(String(row.service_id)) ?? [];
      items.push(action);
      scriptActionsByService.set(String(row.service_id), items);
    }
  }

  const deploymentsByService = new Map<string, Record<string, unknown>[]>();
  let deploymentCount = 0;
  let truncated = false;
  for (const row of deploymentRows) {
    if (deploymentCount >= SERVICE_DEPLOYMENTS_MAX_DEPLOYMENTS) {
      truncated = true;
      break;
    }
    const connectionVisible = visibleConnectionIds.has(String(row.ssh_connection_id));
    const metrics = connectionVisible ? parseJson<Record<string, unknown>>(row.latest_metrics_json, {}) : {};
    const provider = String(row.provider_type);
    const capabilities = deploymentCapabilities(provider, metrics);
    const deployment = {
      id: row.id,
      serviceId: row.service_id,
      sshConnectionId: row.ssh_connection_id,
      sshConnectionName: row.ssh_connection_name,
      provider,
      externalId: row.external_id,
      displayName: row.display_name,
      origin: row.origin,
      status: connectionVisible ? row.status : "unknown",
      state: connectionVisible ? row.state_detail : "",
      metrics,
      lastCheckedAt: connectionVisible ? row.last_checked_at : null,
      connectionAvailable: Boolean(row.connection_available) && !Boolean(row.source_deleted) && connectionVisible,
      capabilities,
      capabilityNotes: {
        start: capabilities.includes("start") ? "" : capabilityDisabledReason(provider, "start"),
        stop: capabilities.includes("stop") ? "" : capabilityDisabledReason(provider, "stop"),
        restart: capabilities.includes("restart") ? "" : capabilityDisabledReason(provider, "restart"),
      },
      scriptActions: scriptActionsByDeployment.get(String(row.id)) ?? [],
    };
    const items = deploymentsByService.get(String(row.service_id)) ?? [];
    items.push(deployment);
    deploymentsByService.set(String(row.service_id), items);
    deploymentCount += 1;
  }

  const logIdsByService = new Map<string, string[]>();
  for (const row of logLinkRows) {
    const ids = logIdsByService.get(row.service_id) ?? [];
    ids.push(row.environment_log_id);
    logIdsByService.set(row.service_id, ids);
  }

  const limit = Math.min(Math.max(1, query.limit ?? SERVICE_DEPLOYMENTS_MAX_SERVICES), SERVICE_DEPLOYMENTS_MAX_SERVICES);
  const cursorIndex = query.cursor ? serviceRows.findIndex((row) => String(row.id) === query.cursor) : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const pageRows = serviceRows.slice(start, start + limit);
  if (start + pageRows.length < serviceRows.length) truncated = true;
  const services = pageRows.map((row) => ({
    id: row.id,
    environmentId: row.environment_id,
    name: row.name,
    description: row.description,
    status: row.status,
    sortOrder: row.sort_order,
    scriptActions: scriptActionsByService.get(String(row.id)) ?? [],
    deployments: deploymentsByService.get(String(row.id)) ?? [],
    logIds: logIdsByService.get(String(row.id)) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  if (serviceRows.length > SERVICE_DEPLOYMENTS_MAX_SERVICES) truncated = true;

  const payload = {
    canConfigure: manager,
    canOperate: manager,
    generatedAt: new Date().toISOString(),
    truncated,
    nextCursor: truncated && services.length ? String(services[services.length - 1]!.id) : null,
    hasMore: truncated,
    partialFailures: [] as string[],
    services,
    logs: logRows.map((row) => {
      const paths = parseJson<string[]>(row.file_paths_json, []);
      return {
        id: row.id,
        name: row.name,
        sshConnectionId: row.ssh_connection_id,
        connectionName: row.connection_name,
        filePaths: paths.length ? paths : (row.file_path ? [String(row.file_path)] : []),
      };
    }),
    discovery: {
      hosts: connectionRows.map((row) => ({
        sshConnectionId: row.id,
        connectionName: row.name,
        host: row.host,
        connectionAvailable: !Boolean(row.source_deleted),
        monitorStatus: row.monitor_status ?? "unknown",
        candidateCount: parseJson<unknown[]>(row.latest_candidates_json, []).length,
      })),
    },
  };

  const encoded = JSON.stringify(payload);
  if (encoded.length > SERVICE_DEPLOYMENTS_MAX_BYTES) {
    return {
      ...payload,
      truncated: true,
      hasMore: true,
      services: payload.services.slice(0, Math.max(1, Math.floor(payload.services.length / 2))),
      partialFailures: ["payload_truncated"],
    };
  }
  return payload;
}
