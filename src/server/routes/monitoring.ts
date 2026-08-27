import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadMonitoringOverview } from "../monitoring-overview.js";
import { loadServiceTimeseries, MonitoringQueryError } from "../monitoring-timeseries.js";
import { MONITORING_MAX_HOSTS, MONITORING_MAX_SERVICES, MONITORING_RANGES } from "../../shared/monitoring.js";
import { requireAdmin } from "./auth.js";

const overviewQuerySchema = z.object({
  environmentId: z.string().uuid().optional(),
  hostCursor: z.string().uuid().optional(),
  hostLimit: z.coerce.number().int().min(1).max(MONITORING_MAX_HOSTS).optional(),
  serviceLimit: z.coerce.number().int().min(1).max(MONITORING_MAX_SERVICES).optional(),
});

const timeseriesQuerySchema = z.object({
  range: z.enum(MONITORING_RANGES).default("1h"),
});

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
}
