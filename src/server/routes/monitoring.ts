import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadMonitoringOverview } from "../monitoring-overview.js";
import { loadServiceTimeseries, MonitoringQueryError } from "../monitoring-timeseries.js";
import {
  loadMonitorHostEventCalendar,
  loadMonitorHostEvents,
  validateMonitorTimezone,
} from "../monitor-event-calendar.js";
import { canAccessConnection, canAccessEnvironment } from "../access-control.js";
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
}
