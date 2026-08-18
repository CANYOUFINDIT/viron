import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canAccessEnvironment, canManageWorkspace, getWorkspaceAccess, workspaceParams } from "../access-control.js";
import { writeAudit } from "../audit.js";
import {
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
  excludedDisks: z.array(z.string().min(1).max(1024)).max(512).transform((items) => [...new Set(items)]),
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

async function canAccessAlert(app: FastifyInstance, request: FastifyRequest, alertId: string): Promise<boolean> {
  const environmentId = await alertEnvironmentId(app, alertId);
  return Boolean(environmentId && await canAccessEnvironment(app.db, request.admin!, environmentId));
}

function mapAlert(row: Record<string, unknown>): MonitorAlertItem {
  const activeNotifiedAt = row.active_notified_at ? String(row.active_notified_at) : null;
  const recoveryNotifiedAt = row.recovery_notified_at ? String(row.recovery_notified_at) : null;
  const status = String(row.status) as "active" | "recovered" | "event";
  const details = parseJson(row.details_json);
  return {
    id: String(row.id),
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
      const currentSettings = await app.db.prepare("SELECT host_offline_enabled FROM monitor_alert_settings WHERE environment_id = ?")
        .get(request.params.environmentId) as { host_offline_enabled: number | string } | undefined;
      const hostOfflineEnabled = body.hostOfflineEnabled ?? Boolean(Number(currentSettings?.host_offline_enabled ?? 0));
      const now = new Date().toISOString();
      await app.db.prepare(`
        INSERT INTO monitor_alert_settings (
          environment_id, enabled, host_offline_enabled, cpu_enabled, cpu_threshold, memory_enabled, memory_threshold,
          disk_usage_enabled, disk_usage_threshold, temperature_enabled, temperature_threshold,
          deployment_status_enabled, disk_missing_enabled, excluded_disks_json,
          updated_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(body.excludedDisks), request.admin!.id, now, now,
      );
      await resetMonitorAlertEnvironment(app, request.params.environmentId);
      if (body.enabled) await primeMonitorAlertEnvironment(app, request.params.environmentId);
      await writeAudit(app.db, {
        action: "monitor_alert.settings_updated",
        resourceType: "environment",
        resourceId: request.params.environmentId,
        summary: body.enabled ? "启用并更新监控告警" : "关闭监控告警",
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
          excludedDiskCount: body.excludedDisks.length,
        },
        request,
      });
      return { ok: true, item: await monitorAlertSettingsForEnvironment(app, request.params.environmentId) };
    },
  );

  app.get("/api/v1/monitor-alerts", { preHandler: requireAdmin }, async (request) => {
    const [workspaceType, workspaceId] = workspaceParams(request);
    const access = await getWorkspaceAccess(app.db, request.admin!);
    if (!access.canManage && access.environmentIds.size === 0) return { items: [], unread: 0 };
    const environmentFilter = access.canManage
      ? ""
      : ` AND a.environment_id IN (${[...access.environmentIds].map(() => "?").join(",")})`;
    const parameters = [request.admin!.id, workspaceType, workspaceId, ...access.environmentIds];
    const rows = await app.db.prepare(`
      SELECT a.*, u.active_notified_at, u.recovery_notified_at, u.read_at
      FROM monitor_alerts a
      JOIN environments e ON e.id = a.environment_id
      LEFT JOIN monitor_alert_user_states u ON u.alert_id = a.id AND u.user_id = ?
      WHERE e.workspace_type = ? AND e.workspace_id = ?${environmentFilter}
      ORDER BY CASE WHEN a.status = 'active' THEN 0 WHEN a.status = 'event' THEN 1 ELSE 2 END, a.triggered_at DESC
      LIMIT 100
    `).all(...parameters) as Record<string, unknown>[];
    const unreadRow = await app.db.prepare(`
      SELECT COUNT(*) AS count
      FROM monitor_alerts a
      JOIN environments e ON e.id = a.environment_id
      LEFT JOIN monitor_alert_user_states u ON u.alert_id = a.id AND u.user_id = ?
      WHERE e.workspace_type = ? AND e.workspace_id = ?${environmentFilter}
        AND u.read_at IS NULL
    `).get(...parameters) as { count: number | string };
    return { items: rows.map(mapAlert), unread: Number(unreadRow.count) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/monitor-alerts/:id/notified", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseBody(notificationSchema, request.body, reply);
    if (!body) return;
    if (!await canAccessAlert(app, request, request.params.id)) return reply.code(404).send({ error: "MONITOR_ALERT_NOT_FOUND", message: "监控告警不存在" });
    const now = new Date().toISOString();
    const existing = await app.db.prepare("SELECT alert_id FROM monitor_alert_user_states WHERE alert_id = ? AND user_id = ?").get(request.params.id, request.admin!.id);
    if (existing) {
      await app.db.prepare(`UPDATE monitor_alert_user_states SET ${body.phase === "active" ? "active_notified_at" : "recovery_notified_at"} = ?, updated_at = ? WHERE alert_id = ? AND user_id = ?`)
        .run(now, now, request.params.id, request.admin!.id);
    } else {
      await app.db.prepare(`
        INSERT INTO monitor_alert_user_states (alert_id, user_id, active_notified_at, recovery_notified_at, read_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(request.params.id, request.admin!.id, body.phase === "active" ? now : null, body.phase === "recovered" ? now : null, now);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/monitor-alerts/:id/read", { preHandler: requireAdmin }, async (request, reply) => {
    if (!await canAccessAlert(app, request, request.params.id)) return reply.code(404).send({ error: "MONITOR_ALERT_NOT_FOUND", message: "监控告警不存在" });
    const now = new Date().toISOString();
    const existing = await app.db.prepare("SELECT alert_id FROM monitor_alert_user_states WHERE alert_id = ? AND user_id = ?").get(request.params.id, request.admin!.id);
    if (existing) await app.db.prepare("UPDATE monitor_alert_user_states SET read_at = ?, updated_at = ? WHERE alert_id = ? AND user_id = ?").run(now, now, request.params.id, request.admin!.id);
    else await app.db.prepare("INSERT INTO monitor_alert_user_states (alert_id, user_id, read_at, updated_at) VALUES (?, ?, ?, ?)").run(request.params.id, request.admin!.id, now, now);
    return { ok: true };
  });

  app.post("/api/v1/monitor-alerts/read-all", { preHandler: requireAdmin }, async (request) => {
    const [workspaceType, workspaceId] = workspaceParams(request);
    const access = await getWorkspaceAccess(app.db, request.admin!);
    if (!access.canManage && access.environmentIds.size === 0) return { ok: true, updated: 0 };
    const environmentFilter = access.canManage
      ? ""
      : ` AND a.environment_id IN (${[...access.environmentIds].map(() => "?").join(",")})`;
    const rows = await app.db.prepare(`
      SELECT a.id FROM monitor_alerts a JOIN environments e ON e.id = a.environment_id
      WHERE e.workspace_type = ? AND e.workspace_id = ?${environmentFilter}
    `).all(workspaceType, workspaceId, ...access.environmentIds) as Array<{ id: string }>;
    const now = new Date().toISOString();
    await app.db.transaction(async () => {
      for (const row of rows) {
        const existing = await app.db.prepare("SELECT alert_id FROM monitor_alert_user_states WHERE alert_id = ? AND user_id = ?").get(row.id, request.admin!.id);
        if (existing) await app.db.prepare("UPDATE monitor_alert_user_states SET read_at = ?, updated_at = ? WHERE alert_id = ? AND user_id = ?").run(now, now, row.id, request.admin!.id);
        else await app.db.prepare("INSERT INTO monitor_alert_user_states (alert_id, user_id, read_at, updated_at) VALUES (?, ?, ?, ?)").run(row.id, request.admin!.id, now, now);
      }
    })();
    return { ok: true, updated: rows.length };
  });
}
