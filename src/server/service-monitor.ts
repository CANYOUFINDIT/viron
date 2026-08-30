import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { executeSshCommand } from "./ssh/command.js";
import { evaluateMonitorHostAvailability, evaluateRecentMonitorAlerts } from "./monitor-alerts.js";

const candidateSchema = z.object({
  provider: z.enum(["systemd", "docker", "podman", "supervisor", "kubernetes", "process"]),
  externalId: z.string().min(1).max(512),
  name: z.string().min(1).max(255),
  group: z.string().max(255).optional(),
  status: z.enum(["running", "stopped", "degraded", "unknown"]),
  state: z.string().max(255),
  pid: z.number().int().optional(),
  cpuUsedPercent: z.number().finite().optional(),
  memoryBytes: z.number().nonnegative().optional(),
  restartCount: z.number().int().nonnegative().optional(),
  uptimeSeconds: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const kubernetesConfigSchema = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().max(4096).optional(),
  context: z.string().max(512).optional(),
  cluster: z.string().max(512).optional(),
  namespace: z.string().max(253).optional(),
  currentContext: z.boolean(),
  selected: z.boolean(),
  status: z.enum(["discovered", "connected", "error", "unreadable", "invalid"]),
  candidateCount: z.number().int().nonnegative().max(10_000),
  error: z.string().max(500).optional(),
});

const diskSchema = z.object({
  path: z.string(),
  device: z.string().optional(),
  filesystem: z.string().optional(),
  totalBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  usedPercent: z.number().finite(),
});

const temperatureSchema = z.object({
  chip: z.string(),
  feature: z.string().optional(),
  celsius: z.number().finite(),
  maximum: z.number().finite().optional(),
  critical: z.number().finite().optional(),
});

const pressureSchema = z.object({
  someAvg10: z.number().finite().default(0),
  someAvg60: z.number().finite().default(0),
  someAvg300: z.number().finite().default(0),
  fullAvg10: z.number().finite().default(0),
  fullAvg60: z.number().finite().default(0),
  fullAvg300: z.number().finite().default(0),
});

const emptyPressure = {
  someAvg10: 0,
  someAvg60: 0,
  someAvg300: 0,
  fullAvg10: 0,
  fullAvg60: 0,
  fullAvg300: 0,
};

const processSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().min(1).max(255),
  executable: z.string().max(255).optional(),
  user: z.string().max(255).optional(),
  cpuUsedPercent: z.number().finite().nonnegative().default(0),
  memoryBytes: z.number().nonnegative().default(0),
  diskReadBytesPerSecond: z.number().finite().nonnegative().default(0),
  diskWriteBytesPerSecond: z.number().finite().nonnegative().default(0),
  workloadProvider: z.string().max(32).optional(),
  workloadId: z.string().max(512).optional(),
  workloadName: z.string().max(255).optional(),
});

const hostSchema = z.object({
  hostname: z.string(),
  metricsVersion: z.number().int().nonnegative().default(1),
  diskCollectionStatus: z.enum(["complete", "partial", "failed"]).optional(),
  collectorUser: z.string().max(255).optional(),
  operatingSystem: z.string().optional(),
  architecture: z.string().optional(),
  kernelVersion: z.string().optional(),
  cpuCount: z.number().int().nonnegative(),
  cpuUsedPercent: z.number().finite(),
  cpuUserPercent: z.number().finite().default(0),
  cpuSystemPercent: z.number().finite().default(0),
  cpuIoWaitPercent: z.number().finite().default(0),
  cpuStealPercent: z.number().finite().default(0),
  load1: z.number().finite(),
  load5: z.number().finite(),
  load15: z.number().finite(),
  memoryTotalBytes: z.number().nonnegative(),
  memoryUsedBytes: z.number().nonnegative(),
  memoryUsedPercent: z.number().finite(),
  swapTotalBytes: z.number().nonnegative().default(0),
  swapUsedBytes: z.number().nonnegative().default(0),
  swapUsedPercent: z.number().finite().nonnegative().default(0),
  swapInBytesPerSecond: z.number().finite().nonnegative().default(0),
  swapOutBytesPerSecond: z.number().finite().nonnegative().default(0),
  uptimeSeconds: z.number().int().nonnegative(),
  diskReadBytesPerSecond: z.number().finite().nonnegative().default(0),
  diskWriteBytesPerSecond: z.number().finite().nonnegative().default(0),
  diskReadOpsPerSecond: z.number().finite().nonnegative().default(0),
  diskWriteOpsPerSecond: z.number().finite().nonnegative().default(0),
  networkReceiveBytesPerSecond: z.number().finite().nonnegative().default(0),
  networkTransmitBytesPerSecond: z.number().finite().nonnegative().default(0),
  networkReceiveErrorsPerSecond: z.number().finite().nonnegative().default(0),
  networkTransmitErrorsPerSecond: z.number().finite().nonnegative().default(0),
  networkReceiveDropsPerSecond: z.number().finite().nonnegative().default(0),
  networkTransmitDropsPerSecond: z.number().finite().nonnegative().default(0),
  cpuPressure: pressureSchema.default(emptyPressure),
  memoryPressure: pressureSchema.default(emptyPressure),
  ioPressure: pressureSchema.default(emptyPressure),
  disks: z.array(diskSchema).max(256),
  temperatures: z.array(temperatureSchema).max(256),
  topProcesses: z.preprocess((value) => value == null ? [] : value, z.array(processSchema).max(15)),
});

const snapshotSchema = z.object({
  collectedAt: z.string().datetime({ offset: true }),
  resolutionSeconds: z.number().int().positive(),
  sampleCount: z.number().int().positive(),
  host: hostSchema,
  candidates: z.array(candidateSchema).max(10_000),
  kubernetesConfigs: z.preprocess(
    (value) => value == null ? [] : value,
    z.array(kubernetesConfigSchema).max(1000),
  ),
  errors: z.array(z.string().max(500)).max(20),
});

const pullResponseSchema = z.object({
  protocolVersion: z.literal(1),
  agentId: z.string().uuid(),
  agentVersion: z.string().max(64),
  hostname: z.string().max(255),
  oldestSequence: z.number().int().nonnegative(),
  latestSequence: z.number().int().nonnegative(),
  throughSequence: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  samples: z.array(z.object({
    sequenceStart: z.number().int().positive(),
    sequenceEnd: z.number().int().positive(),
    collectedAt: z.string().datetime({ offset: true }),
    resolutionSeconds: z.number().int().positive(),
    payload: snapshotSchema,
  })).max(1000),
  gaps: z.array(z.object({
    sequenceStart: z.number().int().positive(),
    sequenceEnd: z.number().int().positive(),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    reason: z.string().max(64),
  })).max(1000),
});

export type MonitorCandidate = z.infer<typeof candidateSchema>;
export type MonitorHostSnapshot = z.infer<typeof hostSchema>;
export type MonitorKubernetesConfig = z.infer<typeof kubernetesConfigSchema>;

export interface MonitorSyncResult {
  status: "ready" | "missing" | "error";
  agentId: string;
  agentVersion: string;
  protocolVersion: number;
  lastSequence: number;
  host: MonitorHostSnapshot | null;
  candidates: MonitorCandidate[];
  kubernetesConfigs: MonitorKubernetesConfig[];
  lastCollectedAt: string | null;
  lastPulledAt: string;
  error: string;
  retainedOnHost: true;
}

export interface MonitorPollCandidate {
  ssh_connection_id: string;
  agent_id: string | null;
  workspace_type: string;
  workspace_id: string;
  install_managed: number | string | null;
  status: string | null;
  last_pulled_at: string | null;
  updated_at: string | null;
}

const activeSyncs = new WeakMap<FastifyInstance, Map<string, Promise<MonitorSyncResult>>>();
const monitorAgentWrites = new WeakMap<FastifyInstance, Map<string, Promise<void>>>();
const preferredPullLimits = new WeakMap<FastifyInstance, Map<string, number>>();
const monitorStorageNormalizations = new WeakMap<FastifyInstance, Promise<void>>();
const monitorPullLimit = 20;
const monitorPullMaxBytes = 16 * 1024 * 1024;
const monitorPullCatchUpMaxBatches = 40;
const monitorSampleRetentionMs = 30 * 24 * 60 * 60 * 1000;
const monitorEnvironmentFile = "/etc/viron-monitor/viron-monitor.env";
const monitorTransactionAttempts = 3;

export function monitorSampleIsFresh(checkedAt: string, collectedAt: string | null | undefined, resolutionSeconds: number): boolean {
  const checkedAtMillis = Date.parse(checkedAt);
  const collectedAtMillis = Date.parse(collectedAt ?? "");
  if (!Number.isFinite(checkedAtMillis) || !Number.isFinite(collectedAtMillis)) return false;
  const normalizedResolution = Number.isFinite(resolutionSeconds) && resolutionSeconds > 0 ? resolutionSeconds : 30;
  return checkedAtMillis - collectedAtMillis <= Math.max(60, normalizedResolution * 3) * 1000;
}

export async function serializeMonitorAgentWork<T>(
  app: FastifyInstance,
  agentId: string,
  work: () => T | Promise<T>,
): Promise<T> {
  let appWrites = monitorAgentWrites.get(app);
  if (!appWrites) {
    appWrites = new Map();
    monitorAgentWrites.set(app, appWrites);
  }
  const previous = appWrites.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  appWrites.set(agentId, current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (appWrites.get(agentId) === current) appWrites.delete(agentId);
  }
}

function isMysqlDeadlock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const databaseError = error as { code?: unknown; errno?: unknown; sqlState?: unknown };
  return databaseError.code === "ER_LOCK_DEADLOCK"
    || databaseError.errno === 1213
    || databaseError.sqlState === "40001";
}

async function runMonitorTransaction<T>(app: FastifyInstance, work: () => T | Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= monitorTransactionAttempts; attempt += 1) {
    try {
      return await app.db.transaction(work)();
    } catch (error) {
      if (app.db.dialect !== "mysql" || !isMysqlDeadlock(error) || attempt === monitorTransactionAttempts) throw error;
      app.log.warn({ err: error, attempt }, "retrying viron-monitor storage transaction after mysql deadlock");
      await new Promise<void>((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
  throw new Error("监控事务重试次数已耗尽");
}

function monitorCommand(after: number, collect: boolean, limit: number): string {
  const prefix = `command -v viron-monitor >/dev/null 2>&1 || exit 127; set -a; if [ -r ${monitorEnvironmentFile} ]; then . ${monitorEnvironmentFile}; fi; set +a; `;
  const collectCommand = collect ? "viron-monitor collect --quiet && " : "";
  return `${prefix}${collectCommand}viron-monitor pull --after ${Math.max(0, Math.trunc(after))} --limit ${limit}`;
}

async function executeMonitorPull(app: FastifyInstance, connectionId: string, after: number, collect: boolean) {
  let appLimits = preferredPullLimits.get(app);
  if (!appLimits) {
    appLimits = new Map();
    preferredPullLimits.set(app, appLimits);
  }
  let limit = appLimits.get(connectionId) ?? monitorPullLimit;
  let result = await executeSshCommand(app, connectionId, monitorCommand(after, collect, limit), { timeoutMs: 120_000, maxBytes: monitorPullMaxBytes });
  while (result.truncated && limit > 1) {
    limit = Math.max(1, Math.floor(limit / 2));
    result = await executeSshCommand(app, connectionId, monitorCommand(after, false, limit), { timeoutMs: 120_000, maxBytes: monitorPullMaxBytes });
  }
  if (result.truncated) throw new Error("viron-monitor 单条数据超过 16 MiB，请检查目标机是否存在异常数量的服务候选");
  appLimits.set(connectionId, limit);
  return result;
}

async function continueMonitorPull(
  app: FastifyInstance,
  connectionId: string,
  response: z.infer<typeof pullResponseSchema>,
): Promise<z.infer<typeof pullResponseSchema>> {
  let current = response;
  for (let batch = 0; batch < monitorPullCatchUpMaxBatches && current.hasMore; batch += 1) {
    if (current.samples.length >= 800) break;
    const continued = await executeMonitorPull(app, connectionId, current.throughSequence, false);
    if (continued.exitCode !== 0) break;
    let more: z.infer<typeof pullResponseSchema>;
    try {
      more = parsePullOutput(continued.stdout.trim());
    } catch {
      break;
    }
    current = {
      ...current,
      latestSequence: more.latestSequence,
      throughSequence: more.throughSequence,
      hasMore: more.hasMore,
      samples: [...current.samples, ...more.samples],
      gaps: [...current.gaps, ...more.gaps],
    };
    if (!more.samples.length && !more.gaps.length) break;
  }
  return current;
}

async function pruneExpiredMonitorSamples(
  app: FastifyInstance,
  agentId: string,
  workspaceType: string,
  workspaceId: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - monitorSampleRetentionMs).toISOString();
  await app.db.prepare(`
    DELETE FROM monitor_samples WHERE agent_id = ? AND collected_at < ?
      AND ssh_connection_id IN (SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?)
  `).run(agentId, cutoff, workspaceType, workspaceId);
  await app.db.prepare(`
    DELETE FROM monitor_sequence_gaps WHERE agent_id = ? AND ended_at < ?
      AND ssh_connection_id IN (SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?)
  `).run(agentId, cutoff, workspaceType, workspaceId);
}

function parsePullOutput(stdout: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("viron-monitor 返回了无法解析的数据");
  }
  const result = pullResponseSchema.safeParse(parsed);
  if (!result.success) throw new Error("viron-monitor 返回的数据协议不兼容");
  return result.data;
}

async function markMonitorFailure(app: FastifyInstance, connectionId: string, status: "missing" | "error", message: string): Promise<void> {
  const now = new Date().toISOString();
  await app.db.prepare(`
    INSERT INTO monitor_hosts (
      ssh_connection_id, status, last_error, last_pulled_at, updated_at,
      latest_host_json, latest_candidates_json, latest_kubernetes_configs_json
    ) VALUES (?, ?, ?, ?, ?, 'null', '[]', '[]')
    ON CONFLICT(ssh_connection_id) DO UPDATE SET
      status = excluded.status,
      last_error = excluded.last_error,
      last_pulled_at = excluded.last_pulled_at,
      updated_at = excluded.updated_at
  `).run(connectionId, status, message.slice(0, 500), now, now);
  try {
    await evaluateMonitorHostAvailability(app, {
      connectionId,
      checkedAt: now,
      available: false,
      status,
      reason: status === "missing" ? "monitor_missing" : "pull_failed",
      error: message,
    });
  } catch (error) {
    app.log.error({ err: error, connectionId }, "monitor host availability evaluation failed");
  }
}

function parseStoredHost(value: string): MonitorHostSnapshot | null {
  try {
    const parsed = hostSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseStoredCandidates(value: string): MonitorCandidate[] {
  try {
    const parsed = z.array(candidateSchema).max(10_000).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseStoredKubernetesConfigs(value: string): MonitorKubernetesConfig[] {
  try {
    const parsed = z.array(kubernetesConfigSchema).max(1000).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

async function storedCursor(app: FastifyInstance, connectionId: string): Promise<{
  agentId: string;
  sequence: number;
  workspaceType: string;
  workspaceId: string;
}> {
  const row = await app.db.prepare(`
    SELECT h.agent_id, h.last_sequence, c.workspace_type, c.workspace_id
    FROM ssh_connections c
    LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
    WHERE c.id = ?
  `).get(connectionId) as
    | { agent_id: string | null; last_sequence: number | string | null; workspace_type: string; workspace_id: string }
    | undefined;
  const agentId = row?.agent_id ?? "";
  const scope = { workspaceType: row?.workspace_type ?? "personal", workspaceId: row?.workspace_id ?? "" };
  if (!agentId) return { agentId: "", sequence: Number(row?.last_sequence ?? 0), ...scope };
  const shared = await app.db.prepare(`
    SELECT MAX(h.last_sequence) AS last_sequence
    FROM monitor_hosts h JOIN ssh_connections c ON c.id = h.ssh_connection_id
    WHERE h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
  `).get(agentId, scope.workspaceType, scope.workspaceId) as
    | { last_sequence: number | string | null }
    | undefined;
  return { agentId, sequence: Number(shared?.last_sequence ?? row?.last_sequence ?? 0), ...scope };
}

async function canonicalMonitorConnection(
  app: FastifyInstance,
  agentId: string,
  fallbackConnectionId: string,
  workspaceType: string,
  workspaceId: string,
): Promise<string> {
  const current = await app.db.prepare(`
    SELECT h.ssh_connection_id FROM monitor_hosts h
    JOIN ssh_connections c ON c.id = h.ssh_connection_id
    WHERE h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
    ORDER BY h.install_managed DESC,
      CASE WHEN h.status = 'ready' THEN 0 ELSE 1 END,
      COALESCE(h.last_collected_at, '') DESC,
      h.ssh_connection_id
    LIMIT 1
  `).get(agentId, workspaceType, workspaceId) as { ssh_connection_id: string } | undefined;
  if (current?.ssh_connection_id) return current.ssh_connection_id;
  const historical = await app.db.prepare(`
    SELECT s.ssh_connection_id
    FROM monitor_samples s
    LEFT JOIN monitor_hosts h ON h.ssh_connection_id = s.ssh_connection_id
    JOIN ssh_connections c ON c.id = s.ssh_connection_id
    WHERE s.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
    GROUP BY s.ssh_connection_id, h.install_managed, h.status, h.last_collected_at
    ORDER BY COALESCE(h.install_managed, 0) DESC,
      CASE WHEN h.status = 'ready' THEN 0 ELSE 1 END,
      COALESCE(h.last_collected_at, '') DESC,
      s.ssh_connection_id
    LIMIT 1
  `).get(agentId, workspaceType, workspaceId) as { ssh_connection_id: string } | undefined;
  return historical?.ssh_connection_id ?? fallbackConnectionId;
}

export async function deduplicateMonitorStorage(app: FastifyInstance): Promise<void> {
  const agents = await app.db.prepare(`
    SELECT agent_id, workspace_type, workspace_id FROM (
      SELECT s.agent_id, c.workspace_type, c.workspace_id
      FROM monitor_samples s JOIN ssh_connections c ON c.id = s.ssh_connection_id
      WHERE s.agent_id <> ''
      UNION
      SELECT g.agent_id, c.workspace_type, c.workspace_id
      FROM monitor_sequence_gaps g JOIN ssh_connections c ON c.id = g.ssh_connection_id
      WHERE g.agent_id <> ''
    ) stored_agents
    ORDER BY workspace_type, workspace_id, agent_id
  `).all() as Array<{ agent_id: string; workspace_type: string; workspace_id: string }>;
  for (const { agent_id: agentId, workspace_type: workspaceType, workspace_id: workspaceId } of agents) {
    const connections = await app.db.prepare(`
      SELECT COUNT(DISTINCT ssh_connection_id) AS connection_count
      FROM monitor_samples s JOIN ssh_connections c ON c.id = s.ssh_connection_id
      WHERE s.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
    `).get(agentId, workspaceType, workspaceId) as { connection_count: number | string } | undefined;
    if (Number(connections?.connection_count ?? 0) <= 1) continue;
    const canonicalConnectionId = await canonicalMonitorConnection(app, agentId, "", workspaceType, workspaceId);
    if (!canonicalConnectionId) continue;
    await app.db.transaction(async () => {
      const before = await app.db.prepare(`
        SELECT COUNT(*) AS sample_count FROM (
          SELECT s.sequence_end FROM monitor_samples s
          JOIN ssh_connections c ON c.id = s.ssh_connection_id
          WHERE s.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
          GROUP BY s.sequence_end
        ) unique_samples
      `).get(agentId, workspaceType, workspaceId) as { sample_count: number | string };
      await app.db.prepare(`
        INSERT OR IGNORE INTO monitor_samples (
          ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at,
          resolution_seconds, payload_json, received_at
        )
        SELECT ?, agent_id, sequence_start, sequence_end, collected_at,
          resolution_seconds, payload_json, received_at
        FROM monitor_samples s JOIN ssh_connections c ON c.id = s.ssh_connection_id
        WHERE s.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
        ORDER BY s.collected_at, s.sequence_end
      `).run(canonicalConnectionId, agentId, workspaceType, workspaceId);
      await app.db.prepare(`
        DELETE FROM monitor_samples
        WHERE agent_id = ? AND ssh_connection_id <> ?
          AND ssh_connection_id IN (SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?)
      `).run(agentId, canonicalConnectionId, workspaceType, workspaceId);
      await app.db.prepare(`
        INSERT OR IGNORE INTO monitor_sequence_gaps (
          ssh_connection_id, agent_id, sequence_start, sequence_end,
          started_at, ended_at, reason, received_at
        )
        SELECT ?, agent_id, sequence_start, sequence_end,
          started_at, ended_at, reason, received_at
        FROM monitor_sequence_gaps g JOIN ssh_connections c ON c.id = g.ssh_connection_id
        WHERE g.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
        ORDER BY g.ended_at, g.sequence_end
      `).run(canonicalConnectionId, agentId, workspaceType, workspaceId);
      await app.db.prepare(`
        DELETE FROM monitor_sequence_gaps
        WHERE agent_id = ? AND ssh_connection_id <> ?
          AND ssh_connection_id IN (SELECT id FROM ssh_connections WHERE workspace_type = ? AND workspace_id = ?)
      `).run(agentId, canonicalConnectionId, workspaceType, workspaceId);
      const after = await app.db.prepare(`
        SELECT COUNT(*) AS sample_count FROM monitor_samples s
        JOIN ssh_connections c ON c.id = s.ssh_connection_id
        WHERE s.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
      `).get(agentId, workspaceType, workspaceId) as { sample_count: number | string };
      if (Number(after.sample_count) !== Number(before.sample_count)) {
        throw new Error(`监控样本去重校验失败：${agentId}`);
      }
    })();
  }
}

async function ensureMonitorStorageNormalized(app: FastifyInstance): Promise<void> {
  let normalization = monitorStorageNormalizations.get(app);
  if (!normalization) {
    normalization = deduplicateMonitorStorage(app).catch((error) => {
      monitorStorageNormalizations.delete(app);
      throw error;
    });
    monitorStorageNormalizations.set(app, normalization);
  }
  await normalization;
}

async function performMonitorHostSync(app: FastifyInstance, connectionId: string, collect: boolean): Promise<MonitorSyncResult> {
  await ensureMonitorStorageNormalized(app);
  const cursor = await storedCursor(app, connectionId);
  let commandResult;
  try {
    commandResult = await executeMonitorPull(app, connectionId, cursor.sequence, collect);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SSH 连接失败";
    await markMonitorFailure(app, connectionId, "error", message);
    throw new Error(message);
  }
  if (commandResult.exitCode === 127) {
    const message = "目标机器尚未安装 viron-monitor";
    await markMonitorFailure(app, connectionId, "missing", message);
    return {
      status: "missing", agentId: "", agentVersion: "", protocolVersion: 0, lastSequence: cursor.sequence,
      host: null, candidates: [], kubernetesConfigs: [], lastCollectedAt: null, lastPulledAt: new Date().toISOString(), error: message, retainedOnHost: true,
    };
  }
  if (commandResult.exitCode !== 0) {
    const message = (commandResult.stderr.trim() || "viron-monitor 执行失败").slice(0, 500);
    await markMonitorFailure(app, connectionId, "error", message);
    throw new Error(message);
  }
  let response: z.infer<typeof pullResponseSchema>;
  try {
    response = parsePullOutput(commandResult.stdout.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : "viron-monitor 返回的数据协议不兼容";
    await markMonitorFailure(app, connectionId, "error", message);
    throw error;
  }
  try {
    if (cursor.agentId && cursor.agentId !== response.agentId && cursor.sequence > 0) {
      const restarted = await executeMonitorPull(app, connectionId, 0, false);
      if (restarted.exitCode !== 0) throw new Error((restarted.stderr.trim() || "无法从新监控实例读取数据").slice(0, 500));
      response = parsePullOutput(restarted.stdout.trim());
    }
    if (cursor.agentId !== response.agentId) {
      const shared = await app.db.prepare(`
        SELECT MAX(h.last_sequence) AS last_sequence
        FROM monitor_hosts h JOIN ssh_connections c ON c.id = h.ssh_connection_id
        WHERE h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
      `).get(response.agentId, cursor.workspaceType, cursor.workspaceId) as
        | { last_sequence: number | string | null }
        | undefined;
      const sharedSequence = Number(shared?.last_sequence ?? 0);
      if (sharedSequence > response.throughSequence) {
        const resumed = await executeMonitorPull(app, connectionId, sharedSequence, false);
        if (resumed.exitCode !== 0) throw new Error((resumed.stderr.trim() || "无法继续读取已识别监控实例的数据").slice(0, 500));
        response = parsePullOutput(resumed.stdout.trim());
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法继续读取监控实例数据";
    await markMonitorFailure(app, connectionId, "error", message);
    throw error;
  }
  try {
    response = await continueMonitorPull(app, connectionId, response);
  } catch {
    // Keep the samples already pulled if catch-up SSH fails.
  }

  return serializeMonitorAgentWork(app, response.agentId, async () => {
    const now = new Date().toISOString();
    const latestSample = response.samples.at(-1);
    const previous = await app.db.prepare(`
      SELECT latest_host_json, latest_candidates_json, latest_kubernetes_configs_json, last_collected_at
      FROM monitor_hosts h JOIN ssh_connections c ON c.id = h.ssh_connection_id
      WHERE h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
      ORDER BY COALESCE(last_collected_at, '') DESC LIMIT 1
    `).get(response.agentId, cursor.workspaceType, cursor.workspaceId) as
      | { latest_host_json: string; latest_candidates_json: string; latest_kubernetes_configs_json: string; last_collected_at: string | null }
      | undefined;
    const latestHost = latestSample?.payload.host ?? (previous ? parseStoredHost(previous.latest_host_json) : null);
    const latestCandidates = latestSample?.payload.candidates ?? (previous ? parseStoredCandidates(previous.latest_candidates_json) : []);
    const latestKubernetesConfigs = latestSample?.payload.kubernetesConfigs ?? (previous ? parseStoredKubernetesConfigs(previous.latest_kubernetes_configs_json) : []);
    const latestCollectedAt = latestSample?.payload.collectedAt ?? previous?.last_collected_at ?? null;
    const canonicalConnectionId = await canonicalMonitorConnection(
      app,
      response.agentId,
      connectionId,
      cursor.workspaceType,
      cursor.workspaceId,
    );
    const lastSequence = Math.max(cursor.agentId === response.agentId ? cursor.sequence : 0, response.throughSequence);

    await runMonitorTransaction(app, async () => {
      for (const sample of response.samples) {
        await app.db.prepare(`
          INSERT OR IGNORE INTO monitor_samples (
            ssh_connection_id, agent_id, sequence_start, sequence_end, collected_at,
            resolution_seconds, payload_json, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          canonicalConnectionId, response.agentId, sample.sequenceStart, sample.sequenceEnd, sample.collectedAt,
          sample.resolutionSeconds, JSON.stringify(sample.payload), now,
        );
      }
      for (const gap of response.gaps) {
        await app.db.prepare(`
          INSERT OR IGNORE INTO monitor_sequence_gaps (
            ssh_connection_id, agent_id, sequence_start, sequence_end, started_at, ended_at, reason, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(canonicalConnectionId, response.agentId, gap.sequenceStart, gap.sequenceEnd, gap.startedAt, gap.endedAt, gap.reason, now);
      }
      await app.db.prepare(`
        INSERT INTO monitor_hosts (
          ssh_connection_id, agent_id, agent_version, protocol_version, status, last_sequence,
          latest_host_json, latest_candidates_json, latest_kubernetes_configs_json,
          last_error, last_collected_at, last_pulled_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, '', ?, ?, ?)
        ON CONFLICT(ssh_connection_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          agent_version = excluded.agent_version,
          protocol_version = excluded.protocol_version,
          status = excluded.status,
          last_sequence = CASE WHEN monitor_hosts.last_sequence > excluded.last_sequence THEN monitor_hosts.last_sequence ELSE excluded.last_sequence END,
          latest_host_json = excluded.latest_host_json,
          latest_candidates_json = excluded.latest_candidates_json,
          latest_kubernetes_configs_json = excluded.latest_kubernetes_configs_json,
          last_error = excluded.last_error,
          last_collected_at = excluded.last_collected_at,
          last_pulled_at = excluded.last_pulled_at,
          updated_at = excluded.updated_at
      `).run(
        connectionId, response.agentId, response.agentVersion, response.protocolVersion,
        lastSequence,
        JSON.stringify(latestHost), JSON.stringify(latestCandidates), JSON.stringify(latestKubernetesConfigs), latestCollectedAt, now, now,
      );
      const monitorConnections = await app.db.prepare(`
        SELECT h.ssh_connection_id
        FROM monitor_hosts h JOIN ssh_connections c ON c.id = h.ssh_connection_id
        WHERE h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
        ORDER BY h.ssh_connection_id
      `).all(response.agentId, cursor.workspaceType, cursor.workspaceId) as Array<{ ssh_connection_id: string }>;
      for (const monitorConnection of monitorConnections) {
        await app.db.prepare(`
          UPDATE monitor_hosts SET
            agent_version = ?, protocol_version = ?, status = 'ready',
            last_sequence = CASE WHEN last_sequence > ? THEN last_sequence ELSE ? END,
            latest_host_json = ?, latest_candidates_json = ?, latest_kubernetes_configs_json = ?,
            last_error = '', last_collected_at = ?, last_pulled_at = ?, updated_at = ?
          WHERE ssh_connection_id = ? AND agent_id = ?
        `).run(
          response.agentVersion, response.protocolVersion, lastSequence, lastSequence,
          JSON.stringify(latestHost), JSON.stringify(latestCandidates), JSON.stringify(latestKubernetesConfigs),
          latestCollectedAt, now, now, monitorConnection.ssh_connection_id, response.agentId,
        );
      }

      const deployments = await app.db.prepare(`
        SELECT d.id, d.provider_type, d.external_id FROM service_deployments d
        JOIN monitor_hosts h ON h.ssh_connection_id = d.ssh_connection_id
        JOIN ssh_connections c ON c.id = h.ssh_connection_id
        WHERE h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
      `).all(response.agentId, cursor.workspaceType, cursor.workspaceId) as Array<{ id: string; provider_type: string; external_id: string }>;
      const candidateByTarget = new Map(latestCandidates.map((candidate) => [`${candidate.provider}:${candidate.externalId}`, candidate]));
      for (const deployment of deployments) {
        const candidate = candidateByTarget.get(`${deployment.provider_type}:${deployment.external_id}`);
        await app.db.prepare(`
          UPDATE service_deployments
          SET status = ?, state_detail = ?, latest_metrics_json = ?, last_checked_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          candidate?.status ?? "unknown",
          candidate?.state ?? "not_found_in_latest_scan",
          JSON.stringify(candidate ?? {}),
          latestCollectedAt,
          now,
          deployment.id,
        );
      }
    });

    try {
      await pruneExpiredMonitorSamples(app, response.agentId, cursor.workspaceType, cursor.workspaceId);
    } catch (error) {
      app.log.warn({ err: error, agentId: response.agentId }, "monitor sample retention prune failed");
    }

    void evaluateRecentMonitorAlerts(app, response.agentId, cursor.workspaceType, cursor.workspaceId).catch((error) => {
      app.log.error({ err: error, agentId: response.agentId }, "monitor alert evaluation failed");
    });

    try {
      const collectedAt = latestSample?.collectedAt ?? latestCollectedAt;
      const resolutionSeconds = Number(latestSample?.resolutionSeconds ?? 30);
      const available = monitorSampleIsFresh(now, collectedAt, resolutionSeconds);
      await evaluateMonitorHostAvailability(app, {
        connectionId,
        checkedAt: now,
        available,
        status: "ready",
        reason: available ? "healthy" : collectedAt ? "sample_stale" : "no_samples",
        hostname: latestHost?.hostname,
        lastCollectedAt: collectedAt,
        sampleResolutionSeconds: Number.isFinite(resolutionSeconds) ? resolutionSeconds : null,
      });
    } catch (error) {
      app.log.error({ err: error, agentId: response.agentId }, "monitor host availability evaluation failed");
    }

    return {
      status: "ready",
      agentId: response.agentId,
      agentVersion: response.agentVersion,
      protocolVersion: response.protocolVersion,
      lastSequence,
      host: latestHost,
      candidates: latestCandidates,
      kubernetesConfigs: latestKubernetesConfigs,
      lastCollectedAt: latestCollectedAt,
      lastPulledAt: now,
      error: "",
      retainedOnHost: true,
    };
  });
}

export function syncMonitorHost(app: FastifyInstance, connectionId: string, collect = true): Promise<MonitorSyncResult> {
  let appSyncs = activeSyncs.get(app);
  if (!appSyncs) {
    appSyncs = new Map();
    activeSyncs.set(app, appSyncs);
  }
  const existing = appSyncs.get(connectionId);
  if (existing) return existing;
  const sync = performMonitorHostSync(app, connectionId, collect).finally(() => appSyncs!.delete(connectionId));
  appSyncs.set(connectionId, sync);
  return sync;
}

export function selectMonitorPollCandidates(
  candidates: MonitorPollCandidate[],
  now: number,
  readyIntervalSeconds: number,
): MonitorPollCandidate[] {
  const readyCutoff = now - Math.max(10, Math.min(3600, readyIntervalSeconds)) * 1000;
  const retryCutoff = now - 5 * 60_000;
  const due = candidates.filter((row) => {
    if (!row.agent_id && !Number(row.install_managed ?? 0) && row.status !== null) return false;
    if (!row.status) return true;
    const attemptedAt = Date.parse(row.status === "ready" ? row.last_pulled_at ?? "" : row.updated_at ?? "");
    if (!Number.isFinite(attemptedAt)) return true;
    return attemptedAt <= (row.status === "ready" ? readyCutoff : retryCutoff);
  });
  const grouped = new Map<string, MonitorPollCandidate>();
  for (const row of due) {
    const key = row.agent_id
      ? `workspace:${row.workspace_type}:${row.workspace_id}:agent:${row.agent_id}`
      : `connection:${row.ssh_connection_id}`;
    const current = grouped.get(key);
    if (!current || Number(row.install_managed ?? 0) > Number(current.install_managed ?? 0)) grouped.set(key, row);
  }
  return [...grouped.values()];
}

export async function pollMonitorHostsOnce(app: FastifyInstance, shouldStop: () => boolean = () => false): Promise<void> {
  await ensureMonitorStorageNormalized(app);
  const now = Date.now();
  const candidates = await app.db.prepare(`
    SELECT c.id AS ssh_connection_id, c.workspace_type, c.workspace_id,
      h.agent_id, h.install_managed, h.status, h.last_pulled_at, h.updated_at
    FROM ssh_connections c
    LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
    WHERE c.source_deleted = 0
      AND EXISTS (SELECT 1 FROM ssh_connection_environments ce WHERE ce.connection_id = c.id)
    ORDER BY COALESCE(h.last_pulled_at, ''), COALESCE(h.updated_at, ''), c.created_at
  `).all() as MonitorPollCandidate[];
  const rows = selectMonitorPollCandidates(candidates, now, app.config.monitorPullIntervalSeconds ?? 60);
  for (let index = 0; index < rows.length; index += 4) {
    if (shouldStop()) break;
    await Promise.all(rows.slice(index, index + 4).map(async (row) => {
      try {
        await syncMonitorHost(app, row.ssh_connection_id, false);
      } catch (error) {
        app.log.warn({ err: error, connectionId: row.ssh_connection_id }, "scheduled viron-monitor pull failed");
      }
    }));
  }
}

export function startMonitorHostPuller(app: FastifyInstance, tickMs = 10_000): () => Promise<void> {
  let polling = false;
  let stopped = false;
  let currentPoll = Promise.resolve();
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      await pollMonitorHostsOnce(app, () => stopped);
    } finally {
      polling = false;
    }
  };
  currentPoll = poll();
  const timer = setInterval(() => {
    if (!polling) currentPoll = poll();
  }, Math.max(1_000, tickMs));
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await currentPoll;
  };
}
