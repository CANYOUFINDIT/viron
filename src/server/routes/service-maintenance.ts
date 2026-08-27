import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canAccessConnection, canAccessEnvironment, canManageWorkspace } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { quotePosixShellArg } from "../../shared/environment-log.js";
import { hasExactIds } from "../../shared/tab-order.js";
import { syncMonitorHost } from "../service-monitor.js";
import { monitorAlertSettingsForEnvironment } from "../monitor-alerts.js";
import { executeSshCommand, executeSshScript } from "../ssh/command.js";
import { closeSshConnectionPool } from "../ssh/connector.js";
import {
  installMonitor,
  MonitorInstallError,
  normalizeMonitorInstallPath,
  preflightMonitorInstallation,
} from "../monitor-installer.js";
import { MonitorInstallTaskConflictError, sanitizeMonitorInstallOutput, type MonitorInstallTaskReporter } from "../monitor-install-task-manager.js";
import { PRODUCT_VERSION } from "../product-info.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import {
  TlsCertificateError,
  createTlsEndpoint,
  deleteTlsEndpoint,
  getTlsEndpoint,
  listTlsEndpoints,
  probeTlsEndpoint,
  replaceEndpointWebEntries,
  updateTlsEndpoint,
} from "../tls-certificates.js";

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(""),
  status: z.enum(["active", "disabled"]).default("active"),
});

const externalIdSchema = z.string().trim().min(1).max(512)
  .refine((value) => !/[\0\r\n]/.test(value), "服务标识不能包含换行或空字符");

const deploymentSchema = z.object({
  sshConnectionId: z.string().uuid(),
  provider: z.enum(["systemd", "docker", "podman", "supervisor", "kubernetes", "process"]),
  externalId: externalIdSchema,
  displayName: z.string().trim().max(255).default(""),
  origin: z.enum(["discovered", "manual"]).default("manual"),
});

const serviceLogsSchema = z.object({ logIds: z.array(z.string().uuid()).max(100) });
const maintenanceOrderSchema = z.object({ orderedIds: z.array(z.string().uuid()).max(500) });
const maintenanceActionSchema = z.object({ action: z.enum(["start", "stop", "restart"]) });
const serviceScriptActionSchema = z.object({
  deploymentId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  icon: z.enum(["terminal", "rocket", "refresh", "database", "package", "shield", "hammer", "zap"]),
  scriptBody: z.string().min(1).max(65_536).refine((value) => value.trim().length > 0, "脚本正文不能为空"),
});
const monitorInstallSchema = z.object({ installPath: z.string().trim().max(512).optional() });
const tlsEndpointSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(443),
  sni: z.string().trim().max(253).optional().default(""),
  sshConnectionId: z.string().uuid().nullable().optional(),
  observeEnabled: z.boolean().optional().default(true),
});

const kubernetesSelectionSchema = z.object({
  selections: z.array(z.object({
    sourceId: z.string().regex(/^[a-f0-9]{64}$/),
    context: z.string().trim().min(1).max(512).refine((value) => !/[\0\r\n]/.test(value), "Kubernetes context 不能包含换行或空字符"),
  })).max(64),
});

function requireManager(request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "只有工作空间管理员可以修改或执行服务维护" });
  return false;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

function monitorUpdateAvailable(agentVersion: unknown, snapshot: Record<string, unknown> | null, installManaged: boolean): boolean {
  const installed = String(agentVersion ?? "").trim();
  if (!installed && !installManaged) return false;
  if (snapshot?.collectorUser !== "root") return true;
  if (Number(snapshot?.metricsVersion ?? 0) < 2) return true;
  if (!installed || installed === PRODUCT_VERSION) return false;
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(value);
    return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? "" } : null;
  };
  const installedVersion = parse(installed);
  const availableVersion = parse(PRODUCT_VERSION);
  if (!installedVersion || !availableVersion) return true;
  for (let index = 0; index < installedVersion.numbers.length; index += 1) {
    const difference = installedVersion.numbers[index]! - availableVersion.numbers[index]!;
    if (difference !== 0) return difference < 0;
  }
  return Boolean(installedVersion.prerelease) && !availableVersion.prerelease;
}

function parseHostSnapshot(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson<unknown>(value, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return typeof (parsed as Record<string, unknown>).hostname === "string" ? parsed as Record<string, unknown> : null;
}

async function connectionBelongsToEnvironment(app: FastifyInstance, connectionId: string, environmentId: string) {
  return await app.db.prepare(`
    SELECT c.id, c.name, c.username FROM ssh_connections c
    JOIN ssh_connection_environments ce ON ce.connection_id = c.id
    WHERE c.id = ? AND ce.environment_id = ? AND c.source_deleted = 0
  `).get(connectionId, environmentId) as { id: string; name: string; username: string } | undefined;
}

async function serviceRow(app: FastifyInstance, serviceId: string) {
  return await app.db.prepare("SELECT id, environment_id, name FROM services WHERE id = ?").get(serviceId) as
    | { id: string; environment_id: string; name: string }
    | undefined;
}

async function deploymentRow(app: FastifyInstance, deploymentId: string) {
  return await app.db.prepare(`
    SELECT d.*, s.environment_id, s.name AS service_name, s.status AS service_status
    FROM service_deployments d JOIN services s ON s.id = d.service_id
    WHERE d.id = ?
  `).get(deploymentId) as Record<string, unknown> | undefined;
}

async function scriptActionRow(app: FastifyInstance, actionId: string) {
  return await app.db.prepare(`
    SELECT a.*, s.environment_id, s.name AS service_name, s.status AS service_status,
      d.service_id AS deployment_service_id, d.ssh_connection_id, d.ssh_connection_name,
      d.display_name AS deployment_name, d.external_id AS deployment_external_id
    FROM service_script_actions a
    JOIN services s ON s.id = a.service_id
    LEFT JOIN service_deployments d ON d.id = a.deployment_id
    WHERE a.id = ?
  `).get(actionId) as Record<string, unknown> | undefined;
}

async function duplicateScriptActionName(
  app: FastifyInstance,
  serviceId: string,
  deploymentId: string | null,
  name: string,
  exceptId = "",
) {
  return await app.db.prepare(`
    SELECT id FROM service_script_actions
    WHERE service_id = ?
      AND ((deployment_id IS NULL AND ? IS NULL) OR deployment_id = ?)
      AND LOWER(name) = LOWER(?)
      AND id <> ?
  `).get(serviceId, deploymentId, deploymentId, name, exceptId) as { id: string } | undefined;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

async function kubernetesCandidateExists(app: FastifyInstance, connectionId: string, externalId: string): Promise<boolean> {
  const row = await app.db.prepare("SELECT latest_candidates_json FROM monitor_hosts WHERE ssh_connection_id = ?").get(connectionId) as { latest_candidates_json?: string } | undefined;
  const candidates = parseJson<Array<{ provider?: unknown; externalId?: unknown }>>(row?.latest_candidates_json, []);
  return candidates.some((candidate) => candidate.provider === "kubernetes" && candidate.externalId === externalId);
}

function maintenanceCommand(provider: string, externalId: string, action: "start" | "stop" | "restart"): string | null {
  const target = quotePosixShellArg(externalId);
  if (provider === "systemd") return `systemctl ${action} -- ${target}`;
  if (provider === "docker") return `docker container ${action} -- ${target}`;
  if (provider === "podman") return `podman ${action} -- ${target}`;
  if (provider === "supervisor") return `supervisorctl ${action} ${target}`;
  return null;
}

async function performMonitorInstallation(
  app: FastifyInstance,
  connection: { id: string; name: string; username: string },
  installPath: string | undefined,
  request: FastifyRequest,
  reporter?: MonitorInstallTaskReporter,
) {
  const started = Date.now();
  const installed = await installMonitor(app, connection.id, connection.username, installPath, async (event) => {
    await reporter?.progress(event.phase, event.progress, event.message);
  });
  if (installed.stdout) await reporter?.output(installed.stdout);
  const installedAt = new Date().toISOString();
  await reporter?.progress("reconnect", 82, "正在关闭旧连接并重新建立 SSH 会话");
  await closeSshConnectionPool(app, connection.id);
  let monitorResult = null;
  let monitorWarning = "";
  await reporter?.progress("initial_collect", 88, "正在执行首次采集并拉取监控指标");
  try {
    monitorResult = await syncMonitorHost(app, connection.id, true);
    monitorWarning = monitorResult.error;
  } catch (error) {
    monitorWarning = error instanceof Error ? error.message : "安装完成，但首次监控数据拉取失败";
  }
  await reporter?.progress("persist", 96, "正在保存安装信息和首批监控状态");
  await app.db.prepare(`
    INSERT INTO monitor_hosts (
      ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
      latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_error,
      install_path, install_architecture, install_managed, installed_at, updated_at
    ) VALUES (?, '', '', 0, 'unknown', 0, '{}', '[]', '[]', '', ?, ?, 1, ?, ?)
    ON CONFLICT(ssh_connection_id) DO UPDATE SET
      install_path = excluded.install_path,
      install_architecture = excluded.install_architecture,
      install_managed = excluded.install_managed,
      installed_at = excluded.installed_at,
      updated_at = excluded.updated_at
  `).run(connection.id, installed.preflight.installPath, installed.preflight.architecture, installedAt, installedAt);
  await writeAudit(app.db, {
    action: "monitor_host.installed",
    resourceType: "ssh_connection",
    resourceId: connection.id,
    summary: `安装监控服务 ${connection.name}`,
    details: {
      installPath: installed.preflight.installPath,
      architecture: installed.preflight.architecture,
      version: installed.preflight.packageVersion,
      mode: installed.preflight.pathState === "upgrade" ? "upgrade" : "install",
      durationMs: Date.now() - started,
      monitorWarning,
    },
    request,
  });
  return {
    ok: true,
    installation: {
      installPath: installed.preflight.installPath,
      architecture: installed.preflight.architecture,
      version: installed.preflight.packageVersion,
      installedAt,
    },
    monitor: monitorResult,
    monitorWarning,
    stdout: sanitizeMonitorInstallOutput(installed.stdout),
  };
}

async function recordMonitorInstallFailure(
  app: FastifyInstance,
  connection: { id: string; name: string },
  installPath: string | undefined,
  started: number,
  error: unknown,
  request: FastifyRequest,
) {
  const code = error instanceof MonitorInstallError ? error.code : "MONITOR_INSTALL_FAILED";
  const message = sanitizeMonitorInstallOutput(error instanceof Error ? error.message : "监控服务安装失败");
  await writeAudit(app.db, {
    action: "monitor_host.install_failed",
    resourceType: "ssh_connection",
    resourceId: connection.id,
    summary: `安装监控服务 ${connection.name} 失败`,
    details: { installPath, code, message: message.slice(0, 1000), durationMs: Date.now() - started },
    request,
  });
  return { code, message };
}

export async function registerServiceMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/maintenance",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const environmentId = request.params.environmentId;
      if (!await canAccessEnvironment(app.db, request.admin!, environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      const [serviceRows, deploymentRows, scriptActionRows, logLinkRows, logRows, connectionCandidates, offlineHostRows, tlsEndpoints] = await Promise.all([
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
          SELECT a.* FROM service_script_actions a
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
          SELECT c.id, c.name, c.host, c.port, c.username, c.source_deleted,
            h.agent_id, h.agent_version, h.protocol_version, h.status AS monitor_status,
            h.last_sequence, h.latest_host_json, h.latest_candidates_json, h.latest_kubernetes_configs_json,
            h.last_error, h.last_collected_at, h.last_pulled_at,
            h.install_path, h.install_architecture, h.install_managed, h.installed_at
          FROM ssh_connections c
          JOIN ssh_connection_environments ce ON ce.connection_id = c.id
          LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
          WHERE ce.environment_id = ?
          ORDER BY ce.maintenance_sort_order, c.name, c.id
        `).all(environmentId) as Promise<Record<string, unknown>[]>,
        app.db.prepare(`
          SELECT target_id FROM monitor_alert_states
          WHERE environment_id = ? AND rule_type = 'host_offline' AND active_alert_id IS NOT NULL
        `).all(environmentId) as Promise<Array<{ target_id: string }>>,
        listTlsEndpoints(app, environmentId),
      ]);
      const connectionRows: Record<string, unknown>[] = [];
      for (const row of connectionCandidates) {
        if (await canAccessConnection(app.db, request.admin!, "ssh", String(row.id))) connectionRows.push(row);
      }
      const visibleConnectionIds = new Set(connectionRows.map((row) => String(row.id)));
      const offlineAgentIds = new Set(offlineHostRows.map((row) => row.target_id));
      const canConfigure = canManageWorkspace(request);
      const scriptActionsByService = new Map<string, Record<string, unknown>[]>();
      const scriptActionsByDeployment = new Map<string, Record<string, unknown>[]>();
      for (const row of scriptActionRows) {
        const action = {
          id: row.id,
          serviceId: row.service_id,
          deploymentId: row.deployment_id,
          name: row.name,
          icon: row.icon,
          ...(canConfigure ? { scriptBody: row.script_body } : {}),
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
      for (const row of deploymentRows) {
        const connectionVisible = visibleConnectionIds.has(String(row.ssh_connection_id));
        const deployment = {
          id: row.id,
          serviceId: row.service_id,
          sshConnectionId: row.ssh_connection_id,
          sshConnectionName: row.ssh_connection_name,
          provider: row.provider_type,
          externalId: row.external_id,
          displayName: row.display_name,
          origin: row.origin,
          status: connectionVisible ? row.status : "unknown",
          state: connectionVisible ? row.state_detail : "",
          metrics: connectionVisible ? parseJson(row.latest_metrics_json, {}) : {},
          lastCheckedAt: connectionVisible ? row.last_checked_at : null,
          connectionAvailable: Boolean(row.connection_available) && !Boolean(row.source_deleted) && connectionVisible,
          host: connectionVisible ? row.host : null,
          port: connectionVisible && row.port != null ? Number(row.port) : null,
          username: connectionVisible ? row.username : null,
          scriptActions: scriptActionsByDeployment.get(String(row.id)) ?? [],
        };
        const items = deploymentsByService.get(String(row.service_id)) ?? [];
        items.push(deployment);
        deploymentsByService.set(String(row.service_id), items);
      }
      const logIdsByService = new Map<string, string[]>();
      for (const row of logLinkRows) {
        const ids = logIdsByService.get(row.service_id) ?? [];
        ids.push(row.environment_log_id);
        logIdsByService.set(row.service_id, ids);
      }
      return {
        canConfigure,
        canOperate: connectionRows.some((row) => !Boolean(row.source_deleted)),
        alertSettings: await monitorAlertSettingsForEnvironment(app, environmentId),
        services: serviceRows.map((row) => ({
          id: row.id,
          environmentId: row.environment_id,
          name: row.name,
          description: row.description,
          status: row.status,
          scriptActions: scriptActionsByService.get(String(row.id)) ?? [],
          deployments: deploymentsByService.get(String(row.id)) ?? [],
          logIds: logIdsByService.get(String(row.id)) ?? [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        logs: logRows.map((row) => ({
          id: row.id,
          name: row.name,
          sshConnectionId: row.ssh_connection_id,
          connectionName: row.connection_name,
          filePaths: parseJson(row.file_paths_json, [row.file_path]),
        })),
        hosts: connectionRows.map((row) => {
          const snapshot = parseHostSnapshot(row.latest_host_json);
          const installManaged = Boolean(row.install_managed);
          return {
            sshConnectionId: row.id,
            connectionName: row.name,
            host: row.host,
            port: Number(row.port),
            username: row.username,
            connectionAvailable: !Boolean(row.source_deleted),
            monitorStatus: row.monitor_status ?? "unknown",
            monitorOffline: Boolean(row.agent_id) && offlineAgentIds.has(String(row.agent_id)),
            agentId: row.agent_id ?? "",
            agentVersion: row.agent_version ?? "",
            monitorUpdateAvailable: monitorUpdateAvailable(row.agent_version, snapshot, installManaged),
            protocolVersion: Number(row.protocol_version ?? 0),
            lastSequence: Number(row.last_sequence ?? 0),
            snapshot,
            candidates: parseJson(row.latest_candidates_json, []),
            kubernetesConfigs: parseJson(row.latest_kubernetes_configs_json, []),
            lastError: row.last_error ?? "",
            lastCollectedAt: row.last_collected_at,
            lastPulledAt: row.last_pulled_at,
            installPath: row.install_path ?? "",
            installArchitecture: row.install_architecture ?? "",
            installManaged,
            installedAt: row.installed_at,
          };
        }),
        tlsEndpoints: tlsEndpoints.filter((endpoint) => !endpoint.sshConnectionId || visibleConnectionIds.has(endpoint.sshConnectionId)),
      };
    },
  );

  app.post<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/tls-endpoints",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(tlsEndpointSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      if (body.sshConnectionId && !await canAccessConnection(app.db, request.admin!, "ssh", body.sshConnectionId)) {
        return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      }
      try {
        const id = await createTlsEndpoint(app, request.params.environmentId, body);
        const item = await getTlsEndpoint(app, id);
        await writeAudit(app.db, {
          action: "tls_endpoint.created",
          resourceType: "tls_endpoint",
          resourceId: id,
          summary: `登记 TLS 端点 ${body.host}:${body.port}`,
          details: { host: body.host, port: body.port, sni: body.sni, sshConnectionId: body.sshConnectionId ?? null },
          request,
        });
        return reply.code(201).send({ id, item });
      } catch (error) {
        if (error instanceof TlsCertificateError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/tls-endpoints/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(tlsEndpointSchema, request.body, reply);
      if (!body) return;
      try {
        const row = await app.db.prepare("SELECT environment_id FROM ssl_endpoints WHERE id = ?").get(request.params.id) as { environment_id: string } | undefined;
        if (!row || !await canAccessEnvironment(app.db, request.admin!, row.environment_id)) {
          return reply.code(404).send({ error: "TLS_ENDPOINT_NOT_FOUND", message: "证书端点不存在" });
        }
        if (body.sshConnectionId && !await canAccessConnection(app.db, request.admin!, "ssh", body.sshConnectionId)) {
          return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
        }
        const item = await updateTlsEndpoint(app, request.params.id, body);
        await writeAudit(app.db, {
          action: "tls_endpoint.updated",
          resourceType: "tls_endpoint",
          resourceId: request.params.id,
          summary: `更新 TLS 端点 ${body.host}:${body.port}`,
          details: { host: body.host, port: body.port, sni: body.sni, sshConnectionId: body.sshConnectionId ?? null },
          request,
        });
        return { ok: true, item };
      } catch (error) {
        if (error instanceof TlsCertificateError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/tls-endpoints/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const row = await app.db.prepare("SELECT environment_id, host, port FROM ssl_endpoints WHERE id = ?").get(request.params.id) as
        | { environment_id: string; host: string; port: number | string }
        | undefined;
      if (!row || !await canAccessEnvironment(app.db, request.admin!, row.environment_id)) {
        return reply.code(404).send({ error: "TLS_ENDPOINT_NOT_FOUND", message: "证书端点不存在" });
      }
      try {
        await deleteTlsEndpoint(app, request.params.id);
        await writeAudit(app.db, {
          action: "tls_endpoint.deleted",
          resourceType: "tls_endpoint",
          resourceId: request.params.id,
          summary: `删除 TLS 端点 ${row.host}:${row.port}`,
          details: { host: row.host, port: Number(row.port) },
          request,
        });
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof TlsCertificateError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/tls-endpoints/:id/web-entries",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(z.object({ webEntryIds: z.array(z.string().uuid()).max(100) }), request.body, reply);
      if (!body) return;
      const row = await app.db.prepare("SELECT environment_id FROM ssl_endpoints WHERE id = ?").get(request.params.id) as { environment_id: string } | undefined;
      if (!row || !await canAccessEnvironment(app.db, request.admin!, row.environment_id)) {
        return reply.code(404).send({ error: "TLS_ENDPOINT_NOT_FOUND", message: "证书端点不存在" });
      }
      try {
        const item = await replaceEndpointWebEntries(app, request.params.id, body.webEntryIds);
        await writeAudit(app.db, {
          action: "tls_endpoint.web_entries_updated",
          resourceType: "tls_endpoint",
          resourceId: request.params.id,
          summary: "更新 TLS 端点关联的 Web 入口",
          details: { webEntryIds: body.webEntryIds },
          request,
        });
        return { item };
      } catch (error) {
        if (error instanceof TlsCertificateError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/tls-endpoints/:id/probe",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const row = await app.db.prepare("SELECT environment_id, ssh_connection_id, host, port FROM ssl_endpoints WHERE id = ?").get(request.params.id) as
        | { environment_id: string; ssh_connection_id: string | null; host: string; port: number | string }
        | undefined;
      if (!row || !await canAccessEnvironment(app.db, request.admin!, row.environment_id)) {
        return reply.code(404).send({ error: "TLS_ENDPOINT_NOT_FOUND", message: "证书端点不存在" });
      }
      if (row.ssh_connection_id && !await canAccessConnection(app.db, request.admin!, "ssh", row.ssh_connection_id)) {
        return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      }
      try {
        const item = await probeTlsEndpoint(app, request.params.id, { manual: true });
        await writeAudit(app.db, {
          action: "tls_endpoint.probed",
          resourceType: "tls_endpoint",
          resourceId: request.params.id,
          summary: `探测 TLS 端点 ${row.host}:${row.port}`,
          details: { host: row.host, port: Number(row.port), status: item.probeStatus, fingerprint: item.fingerprintSha256, daysRemaining: item.daysRemaining },
          request,
        });
        return { item };
      } catch (error) {
        if (error instanceof TlsCertificateError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/services/order",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(maintenanceOrderSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      const rows = await app.db.prepare("SELECT id FROM services WHERE environment_id = ?").all(request.params.environmentId) as Array<{ id: string }>;
      if (!hasExactIds(body.orderedIds, rows.map((row) => row.id))) {
        return reply.code(400).send({ error: "INVALID_SERVICE_ORDER", message: "服务排序必须包含当前环境的全部服务" });
      }
      await app.db.transaction(async () => {
        for (const [index, id] of body.orderedIds.entries()) {
          await app.db.prepare("UPDATE services SET sort_order = ? WHERE id = ? AND environment_id = ?")
            .run(index, id, request.params.environmentId);
        }
      })();
      await writeAudit(app.db, {
        action: "service.reordered",
        resourceType: "environment",
        resourceId: request.params.environmentId,
        summary: "调整服务清单顺序",
        details: { orderedIds: body.orderedIds },
        request,
      });
      return { ok: true };
    },
  );

  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/maintenance-hosts/order",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(maintenanceOrderSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      const rows = await app.db.prepare("SELECT connection_id AS id FROM ssh_connection_environments WHERE environment_id = ?")
        .all(request.params.environmentId) as Array<{ id: string }>;
      if (!hasExactIds(body.orderedIds, rows.map((row) => row.id))) {
        return reply.code(400).send({ error: "INVALID_MAINTENANCE_HOST_ORDER", message: "宿主机排序必须包含当前环境的全部 SSH 宿主机" });
      }
      await app.db.transaction(async () => {
        for (const [index, id] of body.orderedIds.entries()) {
          await app.db.prepare(`
            UPDATE ssh_connection_environments SET maintenance_sort_order = ?
            WHERE connection_id = ? AND environment_id = ?
          `).run(index, id, request.params.environmentId);
        }
      })();
      await writeAudit(app.db, {
        action: "maintenance_host.reordered",
        resourceType: "environment",
        resourceId: request.params.environmentId,
        summary: "调整服务维护宿主机顺序",
        details: { orderedIds: body.orderedIds },
        request,
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/services",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(serviceSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const id = randomUUID();
      const now = new Date().toISOString();
      const nextOrder = await app.db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM services WHERE environment_id = ?
      `).get(request.params.environmentId) as { next_sort_order: number | string };
      try {
        await app.db.prepare(`
          INSERT INTO services (id, environment_id, name, description, status, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, request.params.environmentId, body.name, body.description, body.status, Number(nextOrder.next_sort_order), now, now);
      } catch (error) {
        if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "DUPLICATE_SERVICE", message: "当前环境已存在同名服务" });
        throw error;
      }
      await writeAudit(app.db, { action: "service.created", resourceType: "service", resourceId: id, summary: `创建服务 ${body.name}`, details: { environmentId: request.params.environmentId }, request });
      return reply.code(201).send({ id });
    },
  );

  app.put<{ Params: { id: string } }>("/api/v1/services/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const body = parseBody(serviceSchema, request.body, reply);
    if (!body) return;
    const existing = await serviceRow(app, request.params.id);
    if (!existing || !await canAccessEnvironment(app.db, request.admin!, existing.environment_id)) return reply.code(404).send({ error: "SERVICE_NOT_FOUND", message: "服务不存在" });
    try {
      await app.db.prepare("UPDATE services SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(body.name, body.description, body.status, new Date().toISOString(), existing.id);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "DUPLICATE_SERVICE", message: "当前环境已存在同名服务" });
      throw error;
    }
    await writeAudit(app.db, { action: "service.updated", resourceType: "service", resourceId: existing.id, summary: `更新服务 ${body.name}`, request });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/services/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const existing = await serviceRow(app, request.params.id);
    if (!existing || !await canAccessEnvironment(app.db, request.admin!, existing.environment_id)) return reply.code(404).send({ error: "SERVICE_NOT_FOUND", message: "服务不存在" });
    await app.db.prepare("DELETE FROM services WHERE id = ?").run(existing.id);
    await writeAudit(app.db, { action: "service.deleted", resourceType: "service", resourceId: existing.id, summary: `删除服务 ${existing.name}`, request });
    return reply.code(204).send();
  });

  app.post<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId/deployments", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const body = parseBody(deploymentSchema, request.body, reply);
    if (!body) return;
    const service = await serviceRow(app, request.params.serviceId);
    if (!service || !await canAccessEnvironment(app.db, request.admin!, service.environment_id)) return reply.code(404).send({ error: "SERVICE_NOT_FOUND", message: "服务不存在" });
    const connection = await connectionBelongsToEnvironment(app, body.sshConnectionId, service.environment_id);
    if (!connection) return reply.code(400).send({ error: "INVALID_SSH_CONNECTION", message: "请选择当前环境中可用的 SSH 连接" });
    if (body.provider === "kubernetes" && (body.origin !== "discovered" || !await kubernetesCandidateExists(app, connection.id, body.externalId))) {
      return reply.code(400).send({ error: "KUBERNETES_WORKLOAD_NOT_DISCOVERED", message: "Kubernetes 部署节点只能从当前扫描候选中纳管" });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        INSERT INTO service_deployments (
          id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
          display_name, origin, status, state_detail, latest_metrics_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', '', '{}', ?, ?)
      `).run(id, service.id, connection.id, connection.name, body.provider, body.externalId, body.displayName, body.origin, now, now);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "DUPLICATE_DEPLOYMENT", message: "该服务已经纳管同一部署目标" });
      throw error;
    }
    await writeAudit(app.db, { action: "service_deployment.created", resourceType: "service_deployment", resourceId: id, summary: `为服务 ${service.name} 添加部署节点`, details: body, request });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/v1/service-deployments/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const body = parseBody(deploymentSchema, request.body, reply);
    if (!body) return;
    const existing = await deploymentRow(app, request.params.id);
    if (!existing || !await canAccessEnvironment(app.db, request.admin!, String(existing.environment_id))) return reply.code(404).send({ error: "DEPLOYMENT_NOT_FOUND", message: "部署节点不存在" });
    const connection = await connectionBelongsToEnvironment(app, body.sshConnectionId, String(existing.environment_id));
    if (!connection) return reply.code(400).send({ error: "INVALID_SSH_CONNECTION", message: "请选择当前环境中可用的 SSH 连接" });
    if (body.provider === "kubernetes" && (body.origin !== "discovered" || !await kubernetesCandidateExists(app, connection.id, body.externalId))) {
      return reply.code(400).send({ error: "KUBERNETES_WORKLOAD_NOT_DISCOVERED", message: "Kubernetes 部署节点只能从当前扫描候选中纳管" });
    }
    try {
      await app.db.prepare(`
        UPDATE service_deployments SET ssh_connection_id = ?, ssh_connection_name = ?, provider_type = ?,
          external_id = ?, display_name = ?, origin = ?, status = 'unknown', state_detail = '',
          latest_metrics_json = '{}', last_checked_at = NULL, updated_at = ? WHERE id = ?
      `).run(connection.id, connection.name, body.provider, body.externalId, body.displayName, body.origin, new Date().toISOString(), request.params.id);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "DUPLICATE_DEPLOYMENT", message: "该服务已经纳管同一部署目标" });
      throw error;
    }
    await writeAudit(app.db, { action: "service_deployment.updated", resourceType: "service_deployment", resourceId: request.params.id, summary: `更新服务 ${String(existing.service_name)} 的部署节点`, details: body, request });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/service-deployments/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const existing = await deploymentRow(app, request.params.id);
    if (!existing || !await canAccessEnvironment(app.db, request.admin!, String(existing.environment_id))) return reply.code(404).send({ error: "DEPLOYMENT_NOT_FOUND", message: "部署节点不存在" });
    await app.db.prepare("DELETE FROM service_deployments WHERE id = ?").run(request.params.id);
    await writeAudit(app.db, { action: "service_deployment.deleted", resourceType: "service_deployment", resourceId: request.params.id, summary: `删除服务 ${String(existing.service_name)} 的部署节点`, request });
    return reply.code(204).send();
  });

  app.post<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId/script-actions", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const body = parseBody(serviceScriptActionSchema, request.body, reply);
    if (!body) return;
    const service = await serviceRow(app, request.params.serviceId);
    if (!service || !await canAccessEnvironment(app.db, request.admin!, service.environment_id)) {
      return reply.code(404).send({ error: "SERVICE_NOT_FOUND", message: "服务不存在" });
    }
    if (body.deploymentId) {
      const deployment = await deploymentRow(app, body.deploymentId);
      if (!deployment || deployment.service_id !== service.id) {
        return reply.code(400).send({ error: "INVALID_SCRIPT_ACTION_DEPLOYMENT", message: "节点功能按钮只能关联当前服务的部署节点" });
      }
    }
    if (await duplicateScriptActionName(app, service.id, body.deploymentId, body.name)) {
      return reply.code(409).send({ error: "DUPLICATE_SCRIPT_ACTION", message: "当前位置已经存在同名功能按钮" });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await app.db.prepare(`
      INSERT INTO service_script_actions (id, service_id, deployment_id, name, icon, script_body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, service.id, body.deploymentId, body.name, body.icon, body.scriptBody, now, now);
    await writeAudit(app.db, {
      action: "service_script_action.created",
      resourceType: "service_script_action",
      resourceId: id,
      summary: `创建服务功能按钮 ${body.name}`,
      details: { serviceId: service.id, deploymentId: body.deploymentId, icon: body.icon },
      request,
    });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/v1/service-script-actions/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const body = parseBody(serviceScriptActionSchema, request.body, reply);
    if (!body) return;
    const existing = await scriptActionRow(app, request.params.id);
    if (!existing || !await canAccessEnvironment(app.db, request.admin!, String(existing.environment_id))) {
      return reply.code(404).send({ error: "SCRIPT_ACTION_NOT_FOUND", message: "功能按钮不存在" });
    }
    if (body.deploymentId) {
      const deployment = await deploymentRow(app, body.deploymentId);
      if (!deployment || deployment.service_id !== existing.service_id) {
        return reply.code(400).send({ error: "INVALID_SCRIPT_ACTION_DEPLOYMENT", message: "节点功能按钮只能关联当前服务的部署节点" });
      }
    }
    if (await duplicateScriptActionName(app, String(existing.service_id), body.deploymentId, body.name, request.params.id)) {
      return reply.code(409).send({ error: "DUPLICATE_SCRIPT_ACTION", message: "当前位置已经存在同名功能按钮" });
    }
    await app.db.prepare(`
      UPDATE service_script_actions
      SET deployment_id = ?, name = ?, icon = ?, script_body = ?, updated_at = ?
      WHERE id = ?
    `).run(body.deploymentId, body.name, body.icon, body.scriptBody, new Date().toISOString(), request.params.id);
    await writeAudit(app.db, {
      action: "service_script_action.updated",
      resourceType: "service_script_action",
      resourceId: request.params.id,
      summary: `更新服务功能按钮 ${body.name}`,
      details: { serviceId: existing.service_id, deploymentId: body.deploymentId, icon: body.icon },
      request,
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/service-script-actions/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const existing = await scriptActionRow(app, request.params.id);
    if (!existing || !await canAccessEnvironment(app.db, request.admin!, String(existing.environment_id))) {
      return reply.code(404).send({ error: "SCRIPT_ACTION_NOT_FOUND", message: "功能按钮不存在" });
    }
    await app.db.prepare("DELETE FROM service_script_actions WHERE id = ?").run(request.params.id);
    await writeAudit(app.db, {
      action: "service_script_action.deleted",
      resourceType: "service_script_action",
      resourceId: request.params.id,
      summary: `删除服务功能按钮 ${String(existing.name)}`,
      details: { serviceId: existing.service_id, deploymentId: existing.deployment_id },
      request,
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/service-script-actions/:id/execute", { preHandler: requireAdmin }, async (request, reply) => {
    const action = await scriptActionRow(app, request.params.id);
    if (!action || !await canAccessEnvironment(app.db, request.admin!, String(action.environment_id))) {
      return reply.code(404).send({ error: "SCRIPT_ACTION_NOT_FOUND", message: "功能按钮不存在" });
    }
    if (action.service_status !== "active") {
      return reply.code(409).send({ error: "SERVICE_DISABLED", message: "服务已停用，不能执行功能按钮" });
    }
    const targets = await app.db.prepare(`
      SELECT d.id, d.ssh_connection_id, d.ssh_connection_name, d.provider_type, d.external_id, d.display_name,
        c.source_deleted,
        CASE WHEN c.id IS NULL THEN 0 ELSE EXISTS(
          SELECT 1 FROM ssh_connection_environments ce
          WHERE ce.connection_id = c.id AND ce.environment_id = ?
        ) END AS connection_available
      FROM service_deployments d
      LEFT JOIN ssh_connections c ON c.id = d.ssh_connection_id
      WHERE d.service_id = ? AND (? IS NULL OR d.id = ?)
      ORDER BY d.created_at
    `).all(action.environment_id, action.service_id, action.deployment_id, action.deployment_id) as Array<Record<string, unknown>>;
    if (!targets.length) {
      return reply.code(409).send({ error: "SCRIPT_ACTION_NO_TARGETS", message: "当前功能按钮没有可执行的部署节点" });
    }
    const results = await mapWithConcurrency(targets, 4, async (target) => {
      const deploymentId = String(target.id);
      const targetName = String(target.display_name || target.external_id || target.ssh_connection_name);
      const connectionId = target.ssh_connection_id ? String(target.ssh_connection_id) : "";
      const base = { deploymentId, targetName, connectionId, connectionName: String(target.ssh_connection_name ?? "") };
      if (!connectionId || !Boolean(target.connection_available) || Boolean(target.source_deleted)) {
        return { ...base, ok: false, exitCode: null, signal: null, durationMs: 0, stdout: "", stderr: "", truncated: false, message: "SSH 连接已删除或移出当前环境" };
      }
      if (!await canAccessConnection(app.db, request.admin!, "ssh", connectionId)) {
        return { ...base, ok: false, exitCode: null, signal: null, durationMs: 0, stdout: "", stderr: "", truncated: false, message: "当前账号无权访问该 SSH 连接" };
      }
      const connection = await connectionBelongsToEnvironment(app, connectionId, String(action.environment_id));
      if (!connection) {
        return { ...base, ok: false, exitCode: null, signal: null, durationMs: 0, stdout: "", stderr: "", truncated: false, message: "SSH 连接不可用" };
      }
      const started = Date.now();
      try {
        const result = await executeSshScript(app, connectionId, String(action.script_body), { timeoutMs: 120_000, maxBytes: 128 * 1024 });
        const ok = result.exitCode === 0;
        return {
          ...base,
          ok,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          stdout: result.stdout.slice(0, 32 * 1024),
          stderr: result.stderr.slice(0, 32 * 1024),
          truncated: result.truncated || result.stdout.length > 32 * 1024 || result.stderr.length > 32 * 1024,
          message: ok ? "" : (result.stderr.trim() || result.stdout.trim() || "脚本执行失败").slice(0, 1000),
        };
      } catch (error) {
        return {
          ...base,
          ok: false,
          exitCode: null,
          signal: null,
          durationMs: Date.now() - started,
          stdout: "",
          stderr: "",
          truncated: false,
          message: error instanceof Error ? error.message.slice(0, 1000) : "SSH 脚本执行失败",
        };
      }
    });
    const succeeded = results.filter((item) => item.ok).length;
    const failed = results.length - succeeded;
    await writeAudit(app.db, {
      action: failed ? "service_script_action.execution_failed" : "service_script_action.executed",
      resourceType: "service_script_action",
      resourceId: request.params.id,
      summary: `执行服务功能按钮 ${String(action.name)}`,
      details: {
        serviceId: action.service_id,
        deploymentId: action.deployment_id,
        targetCount: results.length,
        succeeded,
        failed,
        results: results.map((item) => ({
          deploymentId: item.deploymentId,
          connectionId: item.connectionId,
          ok: item.ok,
          exitCode: item.exitCode,
          durationMs: item.durationMs,
          truncated: item.truncated,
          message: item.ok ? "" : item.exitCode == null ? item.message : "脚本以非零状态退出",
        })),
      },
      request,
    });
    return {
      ok: failed === 0,
      action: { id: action.id, name: action.name, icon: action.icon, deploymentId: action.deployment_id },
      succeeded,
      failed,
      results,
    };
  });

  app.put<{ Params: { id: string } }>("/api/v1/services/:id/logs", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const body = parseBody(serviceLogsSchema, request.body, reply);
    if (!body) return;
    const service = await serviceRow(app, request.params.id);
    if (!service || !await canAccessEnvironment(app.db, request.admin!, service.environment_id)) return reply.code(404).send({ error: "SERVICE_NOT_FOUND", message: "服务不存在" });
    if (body.logIds.length) {
      const rows = await app.db.prepare(`SELECT id FROM environment_logs WHERE environment_id = ? AND id IN (${body.logIds.map(() => "?").join(",")})`)
        .all(service.environment_id, ...body.logIds) as Array<{ id: string }>;
      if (rows.length !== body.logIds.length) return reply.code(400).send({ error: "INVALID_LOG_LINK", message: "只能关联当前环境中的日志配置" });
    }
    await app.db.transaction(async () => {
      await app.db.prepare("DELETE FROM service_log_links WHERE service_id = ?").run(service.id);
      for (const logId of body.logIds) await app.db.prepare("INSERT INTO service_log_links (service_id, environment_log_id) VALUES (?, ?)").run(service.id, logId);
    })();
    await writeAudit(app.db, { action: "service.logs_updated", resourceType: "service", resourceId: service.id, summary: `更新服务 ${service.name} 的日志关联`, details: { logIds: body.logIds }, request });
    return { ok: true };
  });

  app.post<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/install/preflight",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = parseBody(monitorInstallSchema, request.body ?? {}, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const connection = await connectionBelongsToEnvironment(app, request.params.connectionId, request.params.environmentId);
      if (!connection || !await canAccessConnection(app.db, request.admin!, "ssh", connection.id)) return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      try {
        return { item: await preflightMonitorInstallation(app, connection.id, body.installPath) };
      } catch (error) {
        if (error instanceof MonitorInstallError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message, preflight: error.preflight });
        }
        return reply.code(502).send({ error: "MONITOR_PREFLIGHT_FAILED", message: error instanceof Error ? error.message : "监控安装预检失败" });
      }
    },
  );

  app.post<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/install",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = parseBody(monitorInstallSchema, request.body ?? {}, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const connection = await connectionBelongsToEnvironment(app, request.params.connectionId, request.params.environmentId);
      if (!connection || !await canAccessConnection(app.db, request.admin!, "ssh", connection.id)) return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      const started = Date.now();
      try {
        return await performMonitorInstallation(app, connection, body.installPath, request);
      } catch (error) {
        const { code, message } = await recordMonitorInstallFailure(app, connection, body.installPath, started, error, request);
        if (error instanceof MonitorInstallError) {
          return reply.code(error.statusCode).send({ error: error.code, message, preflight: error.preflight });
        }
        return reply.code(502).send({ error: code, message });
      }
    },
  );

  app.get<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/install-task",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const connection = await connectionBelongsToEnvironment(app, request.params.connectionId, request.params.environmentId);
      if (!connection || !await canAccessConnection(app.db, request.admin!, "ssh", connection.id)) return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      return { item: await app.monitorInstallTasks.latest(connection.id) };
    },
  );

  app.post<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/install-tasks",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = parseBody(monitorInstallSchema, request.body ?? {}, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const connection = await connectionBelongsToEnvironment(app, request.params.connectionId, request.params.environmentId);
      if (!connection || !await canAccessConnection(app.db, request.admin!, "ssh", connection.id)) return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      let installPath: string;
      try {
        installPath = normalizeMonitorInstallPath(body.installPath);
      } catch (error) {
        if (error instanceof MonitorInstallError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        throw error;
      }
      const started = Date.now();
      try {
        const task = await app.monitorInstallTasks.start({
          environmentId: request.params.environmentId,
          connectionId: connection.id,
          connectionName: connection.name,
          installPath,
          actorUserId: request.admin!.id,
        }, async (reporter) => {
          try {
            const result = await performMonitorInstallation(app, connection, installPath, request, reporter);
            return {
              installation: result.installation,
              monitorStatus: result.monitor?.status ?? null,
              monitorWarning: result.monitorWarning,
            };
          } catch (error) {
            await recordMonitorInstallFailure(app, connection, installPath, started, error, request);
            throw error;
          }
        });
        return reply.code(202).send({ item: task });
      } catch (error) {
        if (error instanceof MonitorInstallTaskConflictError) {
          return reply.code(409).send({ error: "MONITOR_INSTALL_RUNNING", message: error.message, item: error.task });
        }
        return reply.code(502).send({ error: "MONITOR_INSTALL_TASK_FAILED", message: error instanceof Error ? error.message : "无法启动监控安装任务" });
      }
    },
  );

  app.post<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/refresh",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const connection = await connectionBelongsToEnvironment(app, request.params.connectionId, request.params.environmentId);
      if (!connection || !await canAccessConnection(app.db, request.admin!, "ssh", connection.id)) return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      try {
        const result = await syncMonitorHost(app, connection.id, true);
        await writeAudit(app.db, { action: "monitor_host.refreshed", resourceType: "ssh_connection", resourceId: connection.id, summary: `刷新监控节点 ${connection.name}`, details: { status: result.status, candidateCount: result.candidates.length, lastSequence: result.lastSequence }, request });
        return { item: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "监控节点刷新失败";
        await writeAudit(app.db, { action: "monitor_host.refresh_failed", resourceType: "ssh_connection", resourceId: connection.id, summary: `刷新监控节点 ${connection.name} 失败`, details: { message }, request });
        return reply.code(502).send({ error: "MONITOR_REFRESH_FAILED", message });
      }
    },
  );

  app.put<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/kubernetes-contexts",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = parseBody(kubernetesSelectionSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const connection = await connectionBelongsToEnvironment(app, request.params.connectionId, request.params.environmentId);
      if (!connection || !await canAccessConnection(app.db, request.admin!, "ssh", connection.id)) return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });

      const monitorHost = await app.db.prepare("SELECT latest_kubernetes_configs_json FROM monitor_hosts WHERE ssh_connection_id = ?").get(connection.id) as { latest_kubernetes_configs_json?: string } | undefined;
      const discoveries = parseJson<Array<{ sourceId?: unknown; context?: unknown; status?: unknown }>>(monitorHost?.latest_kubernetes_configs_json, []);
      const selectable = new Set(discoveries
        .filter((item) => typeof item.sourceId === "string" && typeof item.context === "string" && !["invalid", "unreadable"].includes(String(item.status)))
        .map((item) => `${item.sourceId}\0${item.context}`));
      const invalidSelection = body.selections.find((item) => !selectable.has(`${item.sourceId}\0${item.context}`));
      if (invalidSelection) return reply.code(400).send({ error: "KUBERNETES_CONTEXT_NOT_DISCOVERED", message: "所选 kubeconfig context 已变化，请重新扫描后再选择" });

      const selectionDocument = Buffer.from(JSON.stringify({ version: 1, selections: body.selections }), "utf8").toString("base64");
      const command = `command -v viron-monitor >/dev/null 2>&1 || exit 127; viron-monitor configure-kubernetes --selection-base64 ${quotePosixShellArg(selectionDocument)}`;
      const started = Date.now();
      let result;
      try {
        result = await executeSshCommand(app, connection.id, command, { timeoutMs: 30_000, maxBytes: 64 * 1024 });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "SSH 连接失败";
        await writeAudit(app.db, { action: "monitor_host.kubernetes_contexts_update_failed", resourceType: "ssh_connection", resourceId: connection.id, summary: `更新 Kubernetes 扫描配置 ${connection.name} 失败`, details: { message, durationMs: Date.now() - started }, request });
        return reply.code(502).send({ error: "KUBERNETES_CONTEXTS_UPDATE_FAILED", message });
      }
      if (result.exitCode === 127) return reply.code(409).send({ error: "MONITOR_UPDATE_REQUIRED", message: "当前 viron-monitor 版本不支持 Kubernetes 扫描，请先更新监控服务" });
      if (result.exitCode !== 0) {
        const message = (result.stderr.trim() || result.stdout.trim() || "保存 Kubernetes 扫描配置失败").slice(0, 500);
        await writeAudit(app.db, { action: "monitor_host.kubernetes_contexts_update_failed", resourceType: "ssh_connection", resourceId: connection.id, summary: `更新 Kubernetes 扫描配置 ${connection.name} 失败`, details: { message, durationMs: Date.now() - started }, request });
        return reply.code(502).send({ error: "KUBERNETES_CONTEXTS_UPDATE_FAILED", message });
      }
      try {
        const monitor = await syncMonitorHost(app, connection.id, true);
        await writeAudit(app.db, { action: "monitor_host.kubernetes_contexts_updated", resourceType: "ssh_connection", resourceId: connection.id, summary: `更新 Kubernetes 扫描配置 ${connection.name}`, details: { selectedContexts: body.selections.length, durationMs: Date.now() - started }, request });
        return { ok: true, item: monitor };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Kubernetes 配置已保存，但立即扫描失败";
        await writeAudit(app.db, { action: "monitor_host.kubernetes_contexts_updated", resourceType: "ssh_connection", resourceId: connection.id, summary: `更新 Kubernetes 扫描配置 ${connection.name}`, details: { selectedContexts: body.selections.length, durationMs: Date.now() - started, monitorWarning: message }, request });
        return { ok: true, monitorWarning: message };
      }
    },
  );

  app.post<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/clear",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      const connection = await connectionBelongsToEnvironment(app, request.params.connectionId, request.params.environmentId);
      if (!connection || !await canAccessConnection(app.db, request.admin!, "ssh", connection.id)) return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
      const started = Date.now();
      try {
        const result = await executeSshCommand(app, connection.id, "command -v viron-monitor >/dev/null 2>&1 || exit 127; viron-monitor clear", { timeoutMs: 30_000, maxBytes: 64 * 1024 });
        if (result.exitCode === 127) {
          const message = "目标机器尚未安装 viron-monitor";
          await writeAudit(app.db, {
            action: "monitor_host.local_buffer_clear_failed",
            resourceType: "ssh_connection",
            resourceId: connection.id,
            summary: `清理监控节点本地数据 ${connection.name} 失败`,
            details: { message, durationMs: Date.now() - started },
            request,
          });
          return reply.code(409).send({ error: "MONITOR_NOT_INSTALLED", message });
        }
        if (result.exitCode !== 0) {
          const message = (result.stderr.trim() || "目标机器不支持清理监控数据，请先更新 viron-monitor").slice(0, 500);
          throw new Error(message);
        }
        const output = parseJson<{ cleared?: { samples?: number; gaps?: number } }>(result.stdout, {});
        const cleared = {
          samples: Number(output.cleared?.samples ?? 0),
          gaps: Number(output.cleared?.gaps ?? 0),
        };
        await writeAudit(app.db, {
          action: "monitor_host.local_buffer_cleared",
          resourceType: "ssh_connection",
          resourceId: connection.id,
          summary: `清理监控节点本地数据 ${connection.name}`,
          details: { ...cleared, durationMs: Date.now() - started },
          request,
        });
        return { ok: true, cleared };
      } catch (error) {
        const message = error instanceof Error ? error.message : "清理目标机器监控数据失败";
        await writeAudit(app.db, {
          action: "monitor_host.local_buffer_clear_failed",
          resourceType: "ssh_connection",
          resourceId: connection.id,
          summary: `清理监控节点本地数据 ${connection.name} 失败`,
          details: { message: message.slice(0, 500), durationMs: Date.now() - started },
          request,
        });
        return reply.code(502).send({ error: "MONITOR_CLEAR_FAILED", message });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/service-deployments/:id/actions", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(maintenanceActionSchema, request.body, reply);
    if (!body) return;
    const deployment = await deploymentRow(app, request.params.id);
    if (!deployment || !await canAccessEnvironment(app.db, request.admin!, String(deployment.environment_id))) return reply.code(404).send({ error: "DEPLOYMENT_NOT_FOUND", message: "部署节点不存在" });
    if (deployment.service_status !== "active") return reply.code(409).send({ error: "SERVICE_DISABLED", message: "服务已停用，不能执行维护动作" });
    if (!deployment.ssh_connection_id) return reply.code(409).send({ error: "SSH_CONNECTION_MISSING", message: "原 SSH 连接已删除，请先修复部署节点" });
    if (!await canAccessConnection(app.db, request.admin!, "ssh", String(deployment.ssh_connection_id))) {
      return reply.code(404).send({ error: "SSH_CONNECTION_NOT_FOUND", message: "SSH 连接不存在" });
    }
    if (!await connectionBelongsToEnvironment(app, String(deployment.ssh_connection_id), String(deployment.environment_id))) {
      return reply.code(409).send({ error: "SSH_CONNECTION_UNAVAILABLE", message: "SSH 连接已删除或移出当前环境，请先修复部署节点" });
    }
    const command = maintenanceCommand(String(deployment.provider_type), String(deployment.external_id), body.action);
    if (!command) return reply.code(400).send({ error: "UNSUPPORTED_MAINTENANCE_ACTION", message: "普通进程和 Kubernetes 工作负载当前不提供标准启停接口" });
    const started = Date.now();
    let result;
    try {
      result = await executeSshCommand(app, String(deployment.ssh_connection_id), command, { timeoutMs: 120_000, maxBytes: 512 * 1024 });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "SSH 连接失败";
      await writeAudit(app.db, { action: "service_deployment.action_failed", resourceType: "service_deployment", resourceId: request.params.id, summary: `${body.action} ${String(deployment.service_name)} 失败`, details: { action: body.action, durationMs: Date.now() - started, message }, request });
      return reply.code(502).send({ error: "MAINTENANCE_ACTION_FAILED", message });
    }
    if (result.exitCode !== 0) {
      const message = (result.stderr.trim() || result.stdout.trim() || "远程维护命令执行失败").slice(0, 1000);
      await writeAudit(app.db, { action: "service_deployment.action_failed", resourceType: "service_deployment", resourceId: request.params.id, summary: `${body.action} ${String(deployment.service_name)} 失败`, details: { action: body.action, exitCode: result.exitCode, durationMs: result.durationMs, message }, request });
      return reply.code(502).send({ error: "MAINTENANCE_ACTION_FAILED", message });
    }
    let monitorWarning = "";
    try {
      const monitorResult = await syncMonitorHost(app, String(deployment.ssh_connection_id), true);
      monitorWarning = monitorResult.error;
    } catch (error) {
      monitorWarning = error instanceof Error ? error.message : "状态刷新失败";
    }
    await writeAudit(app.db, { action: "service_deployment.action_completed", resourceType: "service_deployment", resourceId: request.params.id, summary: `${body.action} ${String(deployment.service_name)}`, details: { action: body.action, durationMs: Date.now() - started, monitorWarning }, request });
    return { ok: true, durationMs: Date.now() - started, stdout: result.stdout.slice(0, 20_000), monitorWarning };
  });
}
