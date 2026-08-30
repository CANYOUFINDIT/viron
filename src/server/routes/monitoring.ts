import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadMonitoringOverview } from "../monitoring-overview.js";
import { loadServiceTimeseries, MonitoringQueryError } from "../monitoring-timeseries.js";
import {
  loadMonitorHostEventCalendar,
  loadMonitorHostEvents,
  loadPlatformEventCalendar,
  loadPlatformEvents,
  monitorLocalDayRange,
  validateMonitorTimezone,
} from "../monitor-event-calendar.js";
import { canAccessConnection, canAccessEnvironment, getWorkspaceAccess, workspaceParams } from "../access-control.js";
import { MONITORING_MAX_HOSTS, MONITORING_MAX_SERVICES, MONITORING_RANGES } from "../../shared/monitoring.js";
import { requireAdmin } from "./auth.js";

const overviewQuerySchema = z.object({
  environmentId: z.string().uuid().optional(),
  hostCursor: z.string().uuid().optional(),
  hostOffset: z.coerce.number().int().min(0).max(10_000).optional(),
  hostLimit: z.coerce.number().int().min(1).max(MONITORING_MAX_HOSTS).optional(),
  serviceLimit: z.coerce.number().int().min(1).max(MONITORING_MAX_SERVICES).optional(),
  hostsOnly: z.enum(["1"]).optional(),
});

const timeseriesQuerySchema = z.object({
  range: z.enum(MONITORING_RANGES).default("1h"),
});

const eventTimezone = z.string().min(1).max(100).default("UTC").refine(validateMonitorTimezone);
const eventCalendarQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional(),
  timezone: eventTimezone,
});
const eventDayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/),
  timezone: eventTimezone,
});
const platformCalendarQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional(),
  timezone: eventTimezone,
  environmentId: z.string().uuid().optional(),
});
const isoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const platformEventsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/).optional(),
  from: isoTimestamp.optional(),
  to: isoTimestamp.optional(),
  timezone: eventTimezone,
  environmentId: z.string().uuid().optional(),
  severity: z.enum(["all", "info", "warning", "major", "critical"]).optional(),
  status: z.enum(["all", "active", "recovered", "event"]).optional(),
});

function currentMonth(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts();
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

async function canAccessMonitorHost(app: FastifyInstance, request: FastifyRequest, environmentId: string, connectionId: string): Promise<boolean> {
  return await canAccessEnvironment(app.db, request.admin!, environmentId)
    && await canAccessConnection(app.db, request.admin!, "ssh", connectionId);
}

export async function registerMonitoringRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/monitoring/overview", { preHandler: requireAdmin }, async (request, reply) => {
    const query = overviewQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "INVALID_QUERY", message: "监控概览参数无效" });
    try {
      return await loadMonitoringOverview(app, request, query.data);
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "ENVIRONMENT_NOT_FOUND") {
        return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
      }
      throw error;
    }
  });

  app.get<{ Params: { serviceId: string } }>(
    "/api/v1/monitoring/services/:serviceId/timeseries",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const query = timeseriesQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "INVALID_MONITOR_HISTORY_RANGE", message: "监控时间范围无效" });
      try {
        return await loadServiceTimeseries(app, request, request.params.serviceId, query.data.range);
      } catch (error) {
        if (error instanceof MonitoringQueryError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/event-calendar",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const query = eventCalendarQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "INVALID_MONITOR_EVENT_CALENDAR", message: "主机事件日历参数无效" });
      if (!await canAccessMonitorHost(app, request, request.params.environmentId, request.params.connectionId)) {
        return reply.code(404).send({ error: "MONITOR_HOST_NOT_FOUND", message: "监控主机不存在" });
      }
      const month = query.data.month ?? currentMonth(query.data.timezone);
      const result = await loadMonitorHostEventCalendar(
        app,
        request.params.environmentId,
        request.params.connectionId,
        month,
        query.data.timezone,
      );
      if (!result) return reply.code(404).send({ error: "MONITOR_HOST_NOT_FOUND", message: "监控主机不存在" });
      return result;
    },
  );

  app.get<{ Params: { environmentId: string; connectionId: string } }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/events",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const query = eventDayQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "INVALID_MONITOR_EVENT_DAY", message: "主机事件日期参数无效" });
      if (!await canAccessMonitorHost(app, request, request.params.environmentId, request.params.connectionId)) {
        return reply.code(404).send({ error: "MONITOR_HOST_NOT_FOUND", message: "监控主机不存在" });
      }
      const items = await loadMonitorHostEvents(
        app,
        request.params.environmentId,
        request.params.connectionId,
        query.data.date,
        query.data.timezone,
      );
      if (!items) return reply.code(404).send({ error: "MONITOR_HOST_NOT_FOUND", message: "监控主机不存在" });
      return { date: query.data.date, timezone: query.data.timezone, items };
    },
  );

  app.get("/api/v1/monitoring/event-calendar", { preHandler: requireAdmin }, async (request, reply) => {
    const query = platformCalendarQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "INVALID_MONITOR_EVENT_CALENDAR", message: "告警热力矩阵参数无效" });
    if (query.data.environmentId && !await canAccessEnvironment(app.db, request.admin!, query.data.environmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
    }
    const [workspaceType, workspaceId] = workspaceParams(request);
    const access = await getWorkspaceAccess(app.db, request.admin!);
    const month = query.data.month ?? currentMonth(query.data.timezone);
    const result = await loadPlatformEventCalendar(app, {
      workspaceType,
      workspaceId,
      environmentId: query.data.environmentId,
      allowedEnvironmentIds: access.canManage ? null : [...access.environmentIds],
      month,
      timezone: query.data.timezone,
    });
    if (!result) return reply.code(400).send({ error: "INVALID_MONITOR_EVENT_CALENDAR", message: "告警热力矩阵参数无效" });
    return result;
  });

  app.get("/api/v1/monitoring/events", { preHandler: requireAdmin }, async (request, reply) => {
    const query = platformEventsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "INVALID_MONITOR_EVENT_DAY", message: "告警事件筛选参数无效" });
    if (query.data.environmentId && !await canAccessEnvironment(app.db, request.admin!, query.data.environmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
    }
    let from = query.data.from ? Date.parse(query.data.from) : NaN;
    let to = query.data.to ? Date.parse(query.data.to) : Date.now();
    if (query.data.date) {
      const range = monitorLocalDayRange(query.data.date, query.data.timezone);
      if (!range) return reply.code(400).send({ error: "INVALID_MONITOR_EVENT_DAY", message: "告警事件日期无效" });
      from = range.start;
      to = range.end;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return reply.code(400).send({ error: "INVALID_MONITOR_EVENT_DAY", message: "告警事件时间范围无效" });
    }
    const [workspaceType, workspaceId] = workspaceParams(request);
    const access = await getWorkspaceAccess(app.db, request.admin!);
    const items = await loadPlatformEvents(app, {
      workspaceType,
      workspaceId,
      environmentId: query.data.environmentId,
      allowedEnvironmentIds: access.canManage ? null : [...access.environmentIds],
      from,
      to,
      severity: query.data.severity ?? "all",
      status: query.data.status ?? "all",
    });
    return { items };
  });
}
