import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  canAccessEnvironment,
  canManageWorkspace,
  getWorkspaceAccess,
  type AuthenticatedUser,
  type WorkspaceContext,
} from "../access-control.js";
import { hasBearerApiKey } from "../api-key-auth.js";
import { writeAudit } from "../audit.js";
import {
  evaluateTlsEndpointAlerts,
  monitorAlertSettingsForEnvironment,
  primeMonitorAlertEnvironment,
  resetMonitorAlertEnvironment,
} from "../monitor-alerts.js";
import type { MonitorAlertItem, MonitorAlertRuleType, MonitorAlertTargetType } from "../../shared/monitor-alerts.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const threshold = z.number().finite().min(1).max(100);
const settingsSchema = z.object({
  enabled: z.boolean(),
  hostOfflineEnabled: z.boolean().optional(),
  cpuEnabled: z.boolean(),
  cpuThreshold: threshold,
  memoryEnabled: z.boolean(),
  memoryThreshold: threshold,
  diskUsageEnabled: z.boolean(),
  diskUsageThreshold: threshold,
  temperatureEnabled: z.boolean(),
  temperatureThreshold: z.number().finite().min(1).max(200),
  deploymentStatusEnabled: z.boolean(),
  diskMissingEnabled: z.boolean(),
  tlsEnabled: z.boolean().optional(),
  tlsWarnDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional(),
  tlsHostnameMismatchEnabled: z.boolean().optional(),
  excludedDisks: z.array(z.string().min(1).max(1024)).max(512).transform((items) => [...new Set(items)]),
  section: z.enum(["monitor", "tls"]).optional(),
});
const notificationSchema = z.object({ phase: z.enum(["active", "recovered"]) });

function parseJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function requireManager(request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "只有工作空间管理员可以配置监控告警" });
  return false;
}

async function alertEnvironmentId(app: FastifyInstance, alertId: string): Promise<string | null> {
  const row = await app.db.prepare("SELECT environment_id FROM monitor_alerts WHERE id = ?").get(alertId) as { environment_id: string } | undefined;
  return row?.environment_id ?? null;
}

interface AlertWorkspaceScope extends WorkspaceContext {
  canManage: boolean;
  environmentIds: Set<string>;
}

async function alertWorkspaceAccess(app: FastifyInstance, user: AuthenticatedUser, workspace: WorkspaceContext): Promise<AlertWorkspaceScope> {
  const canManage = workspace.role === "owner" || workspace.role === "admin";
  if (canManage) return { ...workspace, canManage: true, environmentIds: new Set() };
  const access = await getWorkspaceAccess(app.db, { ...user, workspace });
  return { ...workspace, canManage: access.canManage, environmentIds: access.environmentIds };
}

async function alertWorkspaceScopes(app: FastifyInstance, request: FastifyRequest): Promise<AlertWorkspaceScope[]> {
  const user = request.admin!;
  const workspaces: WorkspaceContext[] = hasBearerApiKey(request)
    ? [user.workspace]
    : [
        { type: "personal", id: user.id, name: "个人工作台", role: "owner" },
        ...await app.db.prepare(`
          SELECT 'organization' AS type, o.id, o.name, m.role
          FROM organization_members m
          JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = ?
          ORDER BY o.name COLLATE NOCASE
        `).all(user.id) as WorkspaceContext[],
      ];
  return Promise.all(workspaces.map((workspace) => alertWorkspaceAccess(app, user, workspace)));
}

function alertScopeWhere(scopes: AlertWorkspaceScope[]): { sql: string; parameters: unknown[] } {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  for (const scope of scopes) {
    if (!scope.canManage && scope.environmentIds.size === 0) continue;
    const environmentIds = [...scope.environmentIds];
    clauses.push(`(e.workspace_type = ? AND e.workspace_id = ?${scope.canManage ? "" : ` AND e.id IN (${environmentIds.map(() => "?").join(",")})`})`);
    parameters.push(scope.type, scope.id, ...environmentIds);
  }
  return { sql: clauses.length ? `(${clauses.join(" OR ")})` : "0 = 1", parameters };
}

async function touchAlertUserState(
  app: FastifyInstance,
  alertId: string,
  userId: string,
  now: string,
  patch: {
    activeNotifiedAt?: string | null;
    recoveryNotifiedAt?: string | null;
    readAt?: string | null;
    clearedAt?: string | null;
  },
): Promise<void> {
  const existing = await app.db.prepare("SELECT alert_id FROM monitor_alert_user_states WHERE alert_id = ? AND user_id = ?").get(alertId, userId);
  if (!existing) {
    await app.db.prepare(`
      INSERT INTO monitor_alert_user_states (
        alert_id, user_id, active_notified_at, recovery_notified_at, read_at, cleared_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      alertId,
      userId,
      patch.activeNotifiedAt ?? null,
      patch.recoveryNotifiedAt ?? null,
      patch.readAt ?? null,
      patch.clearedAt ?? null,
      now,
    );
    return;
  }
  const assignments = ["updated_at = ?"];
  const params: unknown[] = [now];
  if (patch.activeNotifiedAt !== undefined) {
    assignments.push("active_notified_at = ?");
    params.push(patch.activeNotifiedAt);
  }
  if (patch.recoveryNotifiedAt !== undefined) {
    assignments.push("recovery_notified_at = ?");
    params.push(patch.recoveryNotifiedAt);
  }
  if (patch.readAt !== undefined) {
    assignments.push("read_at = ?");
    params.push(patch.readAt);
  }
  if (patch.clearedAt !== undefined) {
    assignments.push("cleared_at = ?");
    params.push(patch.clearedAt);
  }
  params.push(alertId, userId);
  await app.db.prepare(`UPDATE monitor_alert_user_states SET ${assignments.join(", ")} WHERE alert_id = ? AND user_id = ?`).run(...params);
}

async function bulkMarkAlertUserStates(
  app: FastifyInstance,
  userId: string,
  scope: { sql: string; parameters: unknown[] },
  now: string,
  mode: "read" | "clear",
): Promise<number> {
  const scopedAlertsSql = `
    SELECT id FROM (
      SELECT a.id AS id
      FROM monitor_alerts a
      JOIN environments e ON e.id = a.environment_id
      WHERE ${scope.sql}
    ) AS scoped_alerts
  `;
  let updated = 0;
  await app.db.transaction(async () => {
    if (mode === "clear") {
      const updateResult = await app.db.prepare(`
        UPDATE monitor_alert_user_states
        SET read_at = COALESCE(read_at, ?), cleared_at = ?, updated_at = ?
        WHERE user_id = ? AND cleared_at IS NULL AND alert_id IN (${scopedAlertsSql})
      `).run(now, now, now, userId, ...scope.parameters);
      const insertResult = await app.db.prepare(`
        INSERT INTO monitor_alert_user_states (
          alert_id, user_id, active_notified_at, recovery_notified_at, read_at, cleared_at, updated_at
        )
        SELECT alert_id, user_id, active_notified_at, recovery_notified_at, read_at, cleared_at, updated_at
        FROM (
          SELECT a.id AS alert_id, ? AS user_id, NULL AS active_notified_at, NULL AS recovery_notified_at,
            ? AS read_at, ? AS cleared_at, ? AS updated_at
          FROM monitor_alerts a
          JOIN environments e ON e.id = a.environment_id
          LEFT JOIN monitor_alert_user_states u ON u.alert_id = a.id AND u.user_id = ?
          WHERE ${scope.sql}
            AND u.alert_id IS NULL
        ) AS missing_alert_states
      `).run(userId, now, now, now, userId, ...scope.parameters);
      updated = updateResult.changes + insertResult.changes;
      return;
    }
    const updateResult = await app.db.prepare(`
      UPDATE monitor_alert_user_states
      SET read_at = COALESCE(read_at, ?), updated_at = ?
      WHERE user_id = ? AND alert_id IN (${scopedAlertsSql})
    `).run(now, now, userId, ...scope.parameters);
    const insertResult = await app.db.prepare(`
      INSERT INTO monitor_alert_user_states (
        alert_id, user_id, active_notified_at, recovery_notified_at, read_at, cleared_at, updated_at
      )
      SELECT alert_id, user_id, active_notified_at, recovery_notified_at, read_at, cleared_at, updated_at
      FROM (
        SELECT a.id AS alert_id, ? AS user_id, NULL AS active_notified_at, NULL AS recovery_notified_at,
          ? AS read_at, NULL AS cleared_at, ? AS updated_at
        FROM monitor_alerts a
        JOIN environments e ON e.id = a.environment_id
        LEFT JOIN monitor_alert_user_states u ON u.alert_id = a.id AND u.user_id = ?
        WHERE ${scope.sql}
          AND u.alert_id IS NULL
      ) AS missing_alert_states
    `).run(userId, now, now, userId, ...scope.parameters);
    updated = updateResult.changes + insertResult.changes;
  })();
  return updated;
}

async function canAccessAlert(app: FastifyInstance, request: FastifyRequest, alertId: string): Promise<boolean> {
  const environmentId = await alertEnvironmentId(app, alertId);
  if (!environmentId) return false;
  const environment = await app.db.prepare("SELECT workspace_type, workspace_id FROM environments WHERE id = ?").get(environmentId) as
    | { workspace_type: "personal" | "organization"; workspace_id: string }
    | undefined;
  if (!environment) return false;
  const user = request.admin!;
  let workspace: WorkspaceContext | undefined;
  if (environment.workspace_type === "personal" && environment.workspace_id === user.id) {
    workspace = { type: "personal", id: user.id, name: "个人工作台", role: "owner" };
  } else if (environment.workspace_type === "organization" && !hasBearerApiKey(request)) {
    workspace = await app.db.prepare(`
      SELECT 'organization' AS type, o.id, o.name, m.role
      FROM organization_members m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND o.id = ?
    `).get(user.id, environment.workspace_id) as WorkspaceContext | undefined;
  }
  if (!workspace) return false;
  const scope = await alertWorkspaceAccess(app, user, workspace);
  return Boolean(scope && (scope.canManage || scope.environmentIds.has(environmentId)));
}

function mapAlert(row: Record<string, unknown>): MonitorAlertItem {
  const activeNotifiedAt = row.active_notified_at ? String(row.active_notified_at) : null;
  const recoveryNotifiedAt = row.recovery_notified_at ? String(row.recovery_notified_at) : null;
  const status = String(row.status) as "active" | "recovered" | "event";
  const details = parseJson(row.details_json);
  return {
    id: String(row.id),
    workspaceType: String(row.workspace_type) as "personal" | "organization",
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    environmentId: String(row.environment_id),
    environmentName: String(row.environment_name),
    targetType: String(row.target_type) as MonitorAlertTargetType,
    targetId: String(row.target_id),
    ruleType: String(row.rule_type) as MonitorAlertRuleType,
    ruleKey: String(row.rule_key ?? ""),
    sshConnectionId: row.ssh_connection_id ? String(row.ssh_connection_id) : null,
    serviceId: row.service_id ? String(row.service_id) : null,
    deploymentId: row.deployment_id ? String(row.deployment_id) : null,
    targetName: String(row.target_name ?? ""),
    connectionName: String(row.connection_name ?? ""),
    serviceName: String(row.service_name ?? ""),
    status,
    details,
    triggeredAt: String(row.triggered_at),
    recoveredAt: row.recovered_at ? String(row.recovered_at) : null,
    notificationPhase: (status === "active" || status === "event") && !activeNotifiedAt
      ? "active"
      : status === "recovered" && (Boolean(activeNotifiedAt) || (row.rule_type === "disk_missing" && details.recovered === true)) && !recoveryNotifiedAt
        ? "recovered"
        : null,
    read: Boolean(row.read_at),
  };
}

export async function registerMonitorAlertRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/monitor-alert-settings",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      return { item: await monitorAlertSettingsForEnvironment(app, request.params.environmentId), canConfigure: canManageWorkspace(request) };
    },
  );

  app.put<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId/monitor-alert-settings",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const body = parseBody(settingsSchema, request.body, reply);
      if (!body) return;
      if (!await canAccessEnvironment(app.db, request.admin!, request.params.environmentId)) {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      const currentSettings = await app.db.prepare("SELECT host_offline_enabled, tls_enabled, tls_warn_days, tls_hostname_mismatch_enabled FROM monitor_alert_settings WHERE environment_id = ?")
        .get(request.params.environmentId) as {
          host_offline_enabled?: number | string;
          tls_enabled?: number | string;
          tls_warn_days?: number | string;
          tls_hostname_mismatch_enabled?: number | string;
        } | undefined;
      const hostOfflineEnabled = body.hostOfflineEnabled ?? Boolean(Number(currentSettings?.host_offline_enabled ?? 0));
      const tlsEnabled = body.tlsEnabled ?? (currentSettings?.tls_enabled == null ? true : Boolean(Number(currentSettings.tls_enabled)));
      const tlsWarnDays = body.tlsWarnDays ?? (Number(currentSettings?.tls_warn_days) || 14);
      const tlsHostnameMismatchEnabled = body.tlsHostnameMismatchEnabled
        ?? (currentSettings?.tls_hostname_mismatch_enabled == null ? true : Boolean(Number(currentSettings.tls_hostname_mismatch_enabled)));
      const now = new Date().toISOString();
      await app.db.prepare(`
        INSERT INTO monitor_alert_settings (
          environment_id, enabled, host_offline_enabled, cpu_enabled, cpu_threshold, memory_enabled, memory_threshold,
          disk_usage_enabled, disk_usage_threshold, temperature_enabled, temperature_threshold,
          deployment_status_enabled, disk_missing_enabled, tls_enabled, tls_warn_days, tls_hostname_mismatch_enabled,
          excluded_disks_json, updated_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(environment_id) DO UPDATE SET
          enabled = excluded.enabled,
          host_offline_enabled = excluded.host_offline_enabled,
          cpu_enabled = excluded.cpu_enabled,
          cpu_threshold = excluded.cpu_threshold,
          memory_enabled = excluded.memory_enabled,
          memory_threshold = excluded.memory_threshold,
          disk_usage_enabled = excluded.disk_usage_enabled,
          disk_usage_threshold = excluded.disk_usage_threshold,
          temperature_enabled = excluded.temperature_enabled,
          temperature_threshold = excluded.temperature_threshold,
          deployment_status_enabled = excluded.deployment_status_enabled,
          disk_missing_enabled = excluded.disk_missing_enabled,
          tls_enabled = excluded.tls_enabled,
          tls_warn_days = excluded.tls_warn_days,
          tls_hostname_mismatch_enabled = excluded.tls_hostname_mismatch_enabled,
          excluded_disks_json = excluded.excluded_disks_json,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at = excluded.updated_at
      `).run(
        request.params.environmentId, body.enabled ? 1 : 0,
        hostOfflineEnabled ? 1 : 0,
        body.cpuEnabled ? 1 : 0, body.cpuThreshold,
        body.memoryEnabled ? 1 : 0, body.memoryThreshold,
        body.diskUsageEnabled ? 1 : 0, body.diskUsageThreshold,
        body.temperatureEnabled ? 1 : 0, body.temperatureThreshold,
        body.deploymentStatusEnabled ? 1 : 0, body.diskMissingEnabled ? 1 : 0,
        tlsEnabled ? 1 : 0, tlsWarnDays, tlsHostnameMismatchEnabled ? 1 : 0,
        JSON.stringify(body.excludedDisks), request.admin!.id, now, now,
      );
      const section = body.section ?? "all";
      if (section === "tls") {
        await resetMonitorAlertEnvironment(app, request.params.environmentId, "tls");
        if (tlsEnabled) await evaluateTlsEndpointAlerts(app, request.params.environmentId);
      } else if (section === "monitor") {
        await resetMonitorAlertEnvironment(app, request.params.environmentId, "monitor");
        if (body.enabled) await primeMonitorAlertEnvironment(app, request.params.environmentId, { includeTls: false });
      } else {
        await resetMonitorAlertEnvironment(app, request.params.environmentId);
        if (body.enabled) await primeMonitorAlertEnvironment(app, request.params.environmentId);
      }
      await writeAudit(app.db, {
        action: "monitor_alert.settings_updated",
        resourceType: "environment",
        resourceId: request.params.environmentId,
        summary: section === "tls"
          ? (tlsEnabled ? "启用并更新证书告警" : "关闭证书告警")
          : (body.enabled ? "启用并更新监控告警" : "关闭监控告警"),
        details: {
          hostOfflineEnabled,
          cpuEnabled: body.cpuEnabled,
          cpuThreshold: body.cpuThreshold,
          memoryEnabled: body.memoryEnabled,
          memoryThreshold: body.memoryThreshold,
          diskUsageEnabled: body.diskUsageEnabled,
          diskUsageThreshold: body.diskUsageThreshold,
          temperatureEnabled: body.temperatureEnabled,
          temperatureThreshold: body.temperatureThreshold,
          deploymentStatusEnabled: body.deploymentStatusEnabled,
          diskMissingEnabled: body.diskMissingEnabled,
          tlsEnabled,
          tlsWarnDays,
          tlsHostnameMismatchEnabled,
          excludedDiskCount: body.excludedDisks.length,
        },
        request,
      });
      return { ok: true, item: await monitorAlertSettingsForEnvironment(app, request.params.environmentId) };
    },
  );

  app.get("/api/v1/monitor-alerts", { preHandler: requireAdmin }, async (request) => {
    const scope = alertScopeWhere(await alertWorkspaceScopes(app, request));
    const parameters = [request.admin!.id, ...scope.parameters];
    const rows = await app.db.prepare(`
      SELECT a.*, e.workspace_type, e.workspace_id,
        CASE WHEN e.workspace_type = 'personal' THEN '个人工作台' ELSE COALESCE(o.name, '') END AS workspace_name,
        u.active_notified_at, u.recovery_notified_at, u.read_at
      FROM monitor_alerts a
      JOIN environments e ON e.id = a.environment_id
      LEFT JOIN organizations o ON o.id = e.workspace_id AND e.workspace_type = 'organization'
      LEFT JOIN monitor_alert_user_states u ON u.alert_id = a.id AND u.user_id = ?
      WHERE ${scope.sql}
        AND u.cleared_at IS NULL
      ORDER BY CASE WHEN a.status = 'active' THEN 0 WHEN a.status = 'event' THEN 1 ELSE 2 END, a.triggered_at DESC
      LIMIT 100
    `).all(...parameters) as Record<string, unknown>[];
    const unreadRow = await app.db.prepare(`
      SELECT COUNT(*) AS count
      FROM monitor_alerts a
      JOIN environments e ON e.id = a.environment_id
      LEFT JOIN monitor_alert_user_states u ON u.alert_id = a.id AND u.user_id = ?
      WHERE ${scope.sql}
        AND u.cleared_at IS NULL
        AND u.read_at IS NULL
    `).get(...parameters) as { count: number | string };
    return { items: rows.map(mapAlert), unread: Number(unreadRow.count) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/monitor-alerts/:id/notified", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(notificationSchema, request.body, reply);
    if (!body) return;
    if (!await canAccessAlert(app, request, request.params.id)) return reply.code(404).send({ error: "MONITOR_ALERT_NOT_FOUND", message: "监控告警不存在" });
    const now = new Date().toISOString();
    await touchAlertUserState(
      app,
      request.params.id,
      request.admin!.id,
      now,
      body.phase === "active" ? { activeNotifiedAt: now } : { recoveryNotifiedAt: now },
    );
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/monitor-alerts/:id/read", { preHandler: requireAdmin }, async (request, reply) => {
    if (!await canAccessAlert(app, request, request.params.id)) return reply.code(404).send({ error: "MONITOR_ALERT_NOT_FOUND", message: "监控告警不存在" });
    const now = new Date().toISOString();
    await touchAlertUserState(app, request.params.id, request.admin!.id, now, { readAt: now });
    return { ok: true };
  });

  app.post("/api/v1/monitor-alerts/read-all", { preHandler: requireAdmin }, async (request) => {
    const scope = alertScopeWhere(await alertWorkspaceScopes(app, request));
    const updated = await bulkMarkAlertUserStates(app, request.admin!.id, scope, new Date().toISOString(), "read");
    return { ok: true, updated };
  });

  app.post("/api/v1/monitor-alerts/clear-all", { preHandler: requireAdmin }, async (request) => {
    const scope = alertScopeWhere(await alertWorkspaceScopes(app, request));
    const updated = await bulkMarkAlertUserStates(app, request.admin!.id, scope, new Date().toISOString(), "clear");
    return { ok: true, updated };
  });
}
