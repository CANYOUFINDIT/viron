import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildMonitorDiagnostics,
  summarizeMonitorPerformance,
  type MonitorPressureSnapshot,
  type MonitorProcessSnapshot,
} from "../../shared/monitor-performance.js";
import { canAccessConnection, canAccessEnvironment } from "../access-control.js";
import { requireAdmin } from "./auth.js";

const historyQuerySchema = z.object({
  range: z.enum(["1h", "6h", "24h", "7d", "30d"]).default("6h"),
});

const rangeMilliseconds = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

interface StoredSampleKeyRow {
  agent_id: string;
  sequence_end: number | string;
  collected_at: string;
  resolution_seconds: number | string;
}

interface StoredSampleRow extends StoredSampleKeyRow {
  payload_json: string;
}

interface StoredGapRow {
  agent_id: string;
  sequence_end: number | string;
  started_at: string;
  ended_at: string;
  reason: string;
}

interface DeploymentTarget {
  id: string;
  service_name: string;
  provider_type: string;
  external_id: string;
  display_name: string;
}

interface StoredDeploymentMetric {
  agent_id: string;
  sequence_end: number | string;
  provider: string;
  external_id: string;
  cpu_used_percent: number | string | null;
  memory_bytes: number | string | null;
  restart_count: number | string | null;
  uptime_seconds: number | string | null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pressureValue(value: unknown): MonitorPressureSnapshot {
  const pressure = objectValue(value);
  return {
    someAvg10: finiteNumber(pressure.someAvg10) ?? 0,
    someAvg60: finiteNumber(pressure.someAvg60) ?? 0,
    someAvg300: finiteNumber(pressure.someAvg300) ?? 0,
    fullAvg10: finiteNumber(pressure.fullAvg10) ?? 0,
    fullAvg60: finiteNumber(pressure.fullAvg60) ?? 0,
    fullAvg300: finiteNumber(pressure.fullAvg300) ?? 0,
  };
}

function processValues(value: unknown): MonitorProcessSnapshot[] {
  return arrayValue(value).map((item) => objectValue(item)).map((process) => ({
    pid: finiteNumber(process.pid) ?? 0,
    name: String(process.name ?? ""),
    executable: process.executable ? String(process.executable) : undefined,
    user: process.user ? String(process.user) : undefined,
    cpuUsedPercent: finiteNumber(process.cpuUsedPercent) ?? 0,
    memoryBytes: finiteNumber(process.memoryBytes) ?? 0,
    diskReadBytesPerSecond: finiteNumber(process.diskReadBytesPerSecond) ?? 0,
    diskWriteBytesPerSecond: finiteNumber(process.diskWriteBytesPerSecond) ?? 0,
    workloadProvider: process.workloadProvider ? String(process.workloadProvider) : undefined,
    workloadId: process.workloadId ? String(process.workloadId) : undefined,
    workloadName: process.workloadName ? String(process.workloadName) : undefined,
  })).filter((process) => process.pid > 0 && process.name);
}

function parseSample(
  row: StoredSampleRow,
  targets: Map<string, DeploymentTarget>,
  storedDeploymentMetrics?: StoredDeploymentMetric[],
) {
  let payload: Record<string, unknown>;
  try {
    payload = objectValue(JSON.parse(row.payload_json));
  } catch {
    return null;
  }
  const host = objectValue(payload.host);
  const disks = arrayValue(host.disks).map((value) => objectValue(value)).map((disk) => ({
    path: String(disk.path ?? ""),
    device: String(disk.device ?? ""),
    filesystem: String(disk.filesystem ?? ""),
    totalBytes: finiteNumber(disk.totalBytes),
    freeBytes: finiteNumber(disk.freeBytes),
    usedBytes: finiteNumber(disk.usedBytes),
    usedPercent: finiteNumber(disk.usedPercent),
  })).filter((disk) => disk.path);
  const temperatures = arrayValue(host.temperatures).map((value) => objectValue(value)).map((temperature) => ({
    chip: String(temperature.chip ?? ""),
    feature: String(temperature.feature ?? ""),
    celsius: finiteNumber(temperature.celsius),
    maximum: finiteNumber(temperature.maximum),
    critical: finiteNumber(temperature.critical),
  })).filter((temperature) => temperature.chip && temperature.celsius !== null);
  const deployments = [];
  const candidateMetrics = storedDeploymentMetrics?.map((metric) => ({
    provider: metric.provider,
    externalId: metric.external_id,
    cpuUsedPercent: metric.cpu_used_percent,
    memoryBytes: metric.memory_bytes,
    restartCount: metric.restart_count,
    uptimeSeconds: metric.uptime_seconds,
  })) ?? arrayValue(payload.candidates).map((value) => objectValue(value));
  for (const candidate of candidateMetrics) {
    const target = targets.get(`${String(candidate.provider ?? "")}:${String(candidate.externalId ?? "")}`);
    if (!target) continue;
    deployments.push({
      deploymentId: target.id,
      cpuUsedPercent: finiteNumber(candidate.cpuUsedPercent),
      memoryBytes: finiteNumber(candidate.memoryBytes),
      restartCount: finiteNumber(candidate.restartCount),
      uptimeSeconds: finiteNumber(candidate.uptimeSeconds),
    });
  }
  return {
    at: String(payload.collectedAt ?? row.collected_at),
    agentId: row.agent_id,
    sequenceEnd: Number(row.sequence_end),
    resolutionSeconds: Number(payload.resolutionSeconds ?? row.resolution_seconds),
    sampleCount: Number(payload.sampleCount ?? 1),
    breakBefore: false,
    host: {
      metricsVersion: finiteNumber(host.metricsVersion) ?? 1,
      cpuCount: finiteNumber(host.cpuCount),
      cpuUsedPercent: finiteNumber(host.cpuUsedPercent),
      cpuUserPercent: finiteNumber(host.cpuUserPercent),
      cpuSystemPercent: finiteNumber(host.cpuSystemPercent),
      cpuIoWaitPercent: finiteNumber(host.cpuIoWaitPercent),
      cpuStealPercent: finiteNumber(host.cpuStealPercent),
      load1: finiteNumber(host.load1),
      load5: finiteNumber(host.load5),
      load15: finiteNumber(host.load15),
      memoryTotalBytes: finiteNumber(host.memoryTotalBytes),
      memoryUsedBytes: finiteNumber(host.memoryUsedBytes),
      memoryUsedPercent: finiteNumber(host.memoryUsedPercent),
      swapTotalBytes: finiteNumber(host.swapTotalBytes),
      swapUsedBytes: finiteNumber(host.swapUsedBytes),
      swapUsedPercent: finiteNumber(host.swapUsedPercent),
      swapInBytesPerSecond: finiteNumber(host.swapInBytesPerSecond),
      swapOutBytesPerSecond: finiteNumber(host.swapOutBytesPerSecond),
      uptimeSeconds: finiteNumber(host.uptimeSeconds),
      diskReadBytesPerSecond: finiteNumber(host.diskReadBytesPerSecond),
      diskWriteBytesPerSecond: finiteNumber(host.diskWriteBytesPerSecond),
      diskReadOpsPerSecond: finiteNumber(host.diskReadOpsPerSecond),
      diskWriteOpsPerSecond: finiteNumber(host.diskWriteOpsPerSecond),
      networkReceiveBytesPerSecond: finiteNumber(host.networkReceiveBytesPerSecond),
      networkTransmitBytesPerSecond: finiteNumber(host.networkTransmitBytesPerSecond),
      networkReceiveErrorsPerSecond: finiteNumber(host.networkReceiveErrorsPerSecond),
      networkTransmitErrorsPerSecond: finiteNumber(host.networkTransmitErrorsPerSecond),
      networkReceiveDropsPerSecond: finiteNumber(host.networkReceiveDropsPerSecond),
      networkTransmitDropsPerSecond: finiteNumber(host.networkTransmitDropsPerSecond),
      cpuPressure: pressureValue(host.cpuPressure),
      memoryPressure: pressureValue(host.memoryPressure),
      ioPressure: pressureValue(host.ioPressure),
      disks,
      temperatures,
      topProcesses: processValues(host.topProcesses),
    },
    deployments,
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function markDiscontinuities<
  T extends { at: string; agentId: string; breakBefore: boolean },
>(points: T[], gaps: StoredGapRow[]): T[] {
  const regularDeltas: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    if (points[index - 1]!.agentId !== points[index]!.agentId) continue;
    const delta = Date.parse(points[index]!.at) - Date.parse(points[index - 1]!.at);
    if (delta > 0) regularDeltas.push(delta);
  }
  const typicalDelta = median(regularDeltas);
  return points.map((point, index) => {
    if (index === 0) return point;
    const previous = points[index - 1]!;
    const previousAt = Date.parse(previous.at);
    const currentAt = Date.parse(point.at);
    const explicitGap = gaps.some((gap) => Date.parse(gap.started_at) <= currentAt && Date.parse(gap.ended_at) >= previousAt);
    return {
      ...point,
      breakBefore: point.agentId !== previous.agentId
        || explicitGap
        || (typicalDelta > 0 && currentAt - previousAt > typicalDelta * 2.75),
    };
  });
}

export async function registerMonitorHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { environmentId: string; connectionId: string };
    Querystring: { range?: string };
  }>(
    "/api/v1/environments/:environmentId/monitor-hosts/:connectionId/history",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const query = historyQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "INVALID_MONITOR_HISTORY_RANGE", message: "监控时间范围无效" });
      const { environmentId, connectionId } = request.params;
      if (!await canAccessEnvironment(app.db, request.admin!, environmentId)
        || !await canAccessConnection(app.db, request.admin!, "ssh", connectionId)) {
        return reply.code(404).send({ error: "MONITOR_HOST_NOT_FOUND", message: "监控主机不存在" });
      }
      const connection = await app.db.prepare(`
        SELECT c.id, c.host, c.port, c.jump_connection_id,
          c.workspace_type, c.workspace_id, h.agent_id
        FROM ssh_connections c
        JOIN ssh_connection_environments ce ON ce.connection_id = c.id
        LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
        WHERE c.id = ? AND ce.environment_id = ? AND c.source_deleted = 0
      `).get(connectionId, environmentId) as {
        id: string;
        host: string;
        port: number | string;
        jump_connection_id: string | null;
        workspace_type: string;
        workspace_id: string;
        agent_id: string | null;
      } | undefined;
      if (!connection) return reply.code(404).send({ error: "MONITOR_HOST_NOT_FOUND", message: "监控主机不存在" });

      const historicalAgents = await app.db.prepare(`
        SELECT DISTINCT s.agent_id
        FROM monitor_samples s
        JOIN ssh_connections c ON c.id = s.ssh_connection_id
        WHERE c.host = ? AND c.port = ?
          AND COALESCE(c.jump_connection_id, '') = COALESCE(?, '')
          AND c.workspace_type = ? AND c.workspace_id = ?
          AND s.agent_id <> ''
      `).all(
        connection.host,
        Number(connection.port),
        connection.jump_connection_id,
        connection.workspace_type,
        connection.workspace_id,
      ) as Array<{ agent_id: string }>;
      const agentIds = [...new Set([
        ...(connection.agent_id ? [connection.agent_id] : []),
        ...historicalAgents.map((row) => row.agent_id),
      ])];
      const now = new Date();
      const from = new Date(now.getTime() - rangeMilliseconds[query.data.range]);
      if (!agentIds.length) {
        return {
          range: query.data.range, from: from.toISOString(), to: now.toISOString(),
          sourceSampleCount: 0, points: [], gaps: [], deployments: [],
        };
      }

      const placeholders = agentIds.map(() => "?").join(",");
      const bounds = [from.toISOString(), now.toISOString()];
      const scopeClause = "ssh_connection_id IN (SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?)";
      const scopeParameters = [connection.workspace_type, connection.workspace_id];
      const countRow = await app.db.prepare(`
        SELECT COUNT(*) AS sample_count FROM (
          SELECT agent_id, sequence_end FROM monitor_samples
          WHERE agent_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ?
            AND ${scopeClause}
          GROUP BY agent_id, sequence_end
        ) unique_samples
      `).get(...agentIds, ...bounds, ...scopeParameters) as { sample_count: number | string };
      const sourceSampleCount = Number(countRow.sample_count);
      const maximumPoints = 480;
      const stride = Math.max(1, Math.ceil(sourceSampleCount / maximumPoints));
      const sampledRows = await app.db.prepare(`
        SELECT agent_id, sequence_end, MAX(collected_at) AS collected_at,
          MAX(resolution_seconds) AS resolution_seconds
        FROM monitor_samples
        WHERE agent_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ?
          AND ${scopeClause}
          AND (sequence_end % ?) = 0
        GROUP BY agent_id, sequence_end
        ORDER BY collected_at
        LIMIT 520
      `).all(...agentIds, ...bounds, ...scopeParameters, stride) as StoredSampleKeyRow[];
      const boundaryRows = await Promise.all(["ASC", "DESC"].map(async (direction) => await app.db.prepare(`
        SELECT agent_id, sequence_end, MAX(collected_at) AS collected_at,
          MAX(resolution_seconds) AS resolution_seconds
        FROM monitor_samples
        WHERE agent_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ?
          AND ${scopeClause}
        GROUP BY agent_id, sequence_end
        ORDER BY collected_at ${direction}
        LIMIT 1
      `).get(...agentIds, ...bounds, ...scopeParameters) as StoredSampleKeyRow | undefined));
      const sampleKeys = new Map(sampledRows.map((row) => [`${row.agent_id}:${row.sequence_end}`, row]));
      for (const row of boundaryRows) if (row) sampleKeys.set(`${row.agent_id}:${row.sequence_end}`, row);
      const selectedKeys = [...sampleKeys.values()];

      const deployments = await app.db.prepare(`
        SELECT DISTINCT d.id, s.name AS service_name, d.provider_type, d.external_id, d.display_name
        FROM service_deployments d
        JOIN services s ON s.id = d.service_id
        JOIN monitor_hosts h ON h.ssh_connection_id = d.ssh_connection_id
        WHERE s.environment_id = ? AND h.agent_id IN (${placeholders})
        ORDER BY s.name, d.display_name, d.external_id
      `).all(environmentId, ...agentIds) as DeploymentTarget[];
      const targets = new Map(deployments.map((target) => [`${target.provider_type}:${target.external_id}`, target]));
      const boundaryConditions = boundaryRows.filter((row): row is StoredSampleKeyRow => Boolean(row));
      const selectionSql = (sequenceColumn: string, agentColumn: string) => [
        `(${sequenceColumn} % ?) = 0`,
        ...boundaryConditions.map(() => `(${agentColumn} = ? AND ${sequenceColumn} = ?)`),
      ].join(" OR ");
      const selectionParameters = [
        stride,
        ...boundaryConditions.flatMap((row) => [row.agent_id, Number(row.sequence_end)]),
      ];
      let selectedRows: StoredSampleRow[] = [];
      let storedDeploymentMetrics: StoredDeploymentMetric[] | undefined;
      if (selectedKeys.length && app.db.dialect === "mysql") {
        selectedRows = await app.db.prepare(`
          SELECT agent_id, sequence_end, collected_at, resolution_seconds,
            CAST(JSON_OBJECT(
              'collectedAt', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.collectedAt')), collected_at),
              'resolutionSeconds', COALESCE(JSON_EXTRACT(payload_json, '$.resolutionSeconds'), resolution_seconds),
              'sampleCount', COALESCE(JSON_EXTRACT(payload_json, '$.sampleCount'), 1),
              'host', JSON_EXTRACT(payload_json, '$.host'),
              'candidates', JSON_ARRAY()
            ) AS CHAR) AS payload_json
          FROM monitor_samples
          WHERE agent_id IN (${placeholders}) AND collected_at >= ? AND collected_at <= ?
            AND ${scopeClause}
            AND (${selectionSql("sequence_end", "agent_id")})
          ORDER BY collected_at, received_at
          LIMIT 1040
        `).all(...agentIds, ...bounds, ...scopeParameters, ...selectionParameters) as StoredSampleRow[];
        storedDeploymentMetrics = [];
        if (deployments.length) {
          const targetSql = deployments.map(() => "(candidate.provider = ? AND candidate.external_id = ?)").join(" OR ");
          storedDeploymentMetrics = await app.db.prepare(`
            SELECT samples.agent_id, samples.sequence_end,
              candidate.provider, candidate.external_id,
              candidate.cpu_used_percent, candidate.memory_bytes,
              candidate.restart_count, candidate.uptime_seconds
            FROM monitor_samples samples
            JOIN JSON_TABLE(samples.payload_json, '$.candidates[*]' COLUMNS(
              provider VARCHAR(32) PATH '$.provider',
              external_id VARCHAR(1024) PATH '$.externalId',
              cpu_used_percent DOUBLE PATH '$.cpuUsedPercent' NULL ON EMPTY,
              memory_bytes DOUBLE PATH '$.memoryBytes' NULL ON EMPTY,
              restart_count DOUBLE PATH '$.restartCount' NULL ON EMPTY,
              uptime_seconds DOUBLE PATH '$.uptimeSeconds' NULL ON EMPTY
            )) candidate
            WHERE samples.agent_id IN (${placeholders})
              AND samples.collected_at >= ? AND samples.collected_at <= ?
              AND samples.ssh_connection_id IN (
                SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?
              )
              AND (${selectionSql("samples.sequence_end", "samples.agent_id")})
              AND (${targetSql})
            ORDER BY samples.collected_at, samples.received_at
          `).all(
            ...agentIds, ...bounds, ...scopeParameters, ...selectionParameters,
            ...deployments.flatMap((deployment) => [deployment.provider_type, deployment.external_id]),
          ) as StoredDeploymentMetric[];
        }
      } else if (selectedKeys.length) {
        const selectedPlaceholders = selectedKeys.map(() => "(?, ?)").join(",");
        selectedRows = await app.db.prepare(`
          SELECT agent_id, sequence_end, collected_at, resolution_seconds, payload_json
          FROM monitor_samples
          WHERE (agent_id, sequence_end) IN (${selectedPlaceholders})
            AND ${scopeClause}
          ORDER BY collected_at, received_at
        `).all(
          ...selectedKeys.flatMap((row) => [row.agent_id, Number(row.sequence_end)]),
          ...scopeParameters,
        ) as StoredSampleRow[];
      }
      const rowsByKey = new Map(selectedRows.map((row) => [`${row.agent_id}:${row.sequence_end}`, row]));
      const rows = [...rowsByKey.values()].sort((left, right) => left.collected_at.localeCompare(right.collected_at));
      const deploymentMetricsBySample = new Map<string, StoredDeploymentMetric[]>();
      for (const metric of storedDeploymentMetrics ?? []) {
        const key = `${metric.agent_id}:${metric.sequence_end}`;
        const items = deploymentMetricsBySample.get(key) ?? [];
        items.push(metric);
        deploymentMetricsBySample.set(key, items);
      }
      const gaps = await app.db.prepare(`
        SELECT agent_id, sequence_end, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at, MAX(reason) AS reason
        FROM monitor_sequence_gaps
        WHERE agent_id IN (${placeholders}) AND ended_at >= ? AND started_at <= ?
          AND ${scopeClause}
        GROUP BY agent_id, sequence_end
        ORDER BY ended_at
      `).all(...agentIds, ...bounds, ...scopeParameters) as StoredGapRow[];
      const parsed = rows.map((row) => parseSample(
        row,
        targets,
        storedDeploymentMetrics === undefined ? undefined : deploymentMetricsBySample.get(`${row.agent_id}:${row.sequence_end}`) ?? [],
      )).filter((point) => point !== null);
      const points = markDiscontinuities(parsed, gaps);
      const diagnostics = buildMonitorDiagnostics(points);
      const summary = summarizeMonitorPerformance(points);

      return {
        range: query.data.range,
        from: from.toISOString(),
        to: now.toISOString(),
        sourceSampleCount,
        sampledPointCount: points.length,
        points,
        diagnostics,
        summary,
        gaps: gaps.map((gap) => ({
          startedAt: gap.started_at,
          endedAt: gap.ended_at,
          reason: gap.reason,
        })),
        deployments: deployments.map((deployment) => ({
          id: deployment.id,
          serviceName: deployment.service_name,
          name: deployment.display_name || deployment.external_id,
          provider: deployment.provider_type,
        })),
      };
    },
  );
}
