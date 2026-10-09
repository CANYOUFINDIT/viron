import type { FastifyInstance } from "fastify";
import { historicalMetricAgents } from "./monitor-metric-reader.js";
import { loadMonitorAlertCalendarAggregates, monitorAlertRangeSql, type MonitorAlertSqlScope } from "./monitor-alert-query.js";
import {
  MONITOR_ALERT_SEVERITIES,
  type MonitorAlertRuleType,
  type MonitorAlertSeverity,
  type MonitorAlertTargetType,
  type MonitorHostEventCalendarResponse,
  type MonitorHostEventItem,
  type MonitorPlatformEventItem,
} from "../shared/monitor-alerts.js";

interface HostIdentity {
  connectionIds: string[];
  agentIds: string[];
}

interface StoredEventRow {
  id: string;
  rule_type: MonitorAlertRuleType;
  rule_key: string;
  status: "active" | "recovered" | "event";
  severity: string;
  peak_severity: string;
  occurrence_count: number | string;
  target_name: string;
  details_json: string;
  triggered_at: string;
  recovered_at: string | null;
  last_seen_at: string;
}

interface PlatformStoredEventRow extends StoredEventRow {
  environment_id: string;
  environment_name: string;
  ssh_connection_id: string | null;
  service_id: string | null;
  service_name: string;
  connection_name: string;
  target_type: MonitorAlertTargetType;
}

interface StoredSampleCoverageRow {
  sequence_start: number | string;
  sequence_end: number | string;
  collected_at: string;
  resolution_seconds: number | string;
}

interface TimeInterval {
  start: number;
  end: number;
}

function severity(value: unknown): MonitorAlertSeverity {
  const normalized = String(value ?? "");
  return MONITOR_ALERT_SEVERITIES.includes(normalized as MonitorAlertSeverity)
    ? normalized as MonitorAlertSeverity
    : "warning";
}

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function localDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(timestamp: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let formatter = timezoneFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    });
    if (timezoneFormatters.size >= 32) timezoneFormatters.delete(timezoneFormatters.keys().next().value!);
    timezoneFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

function zonedMidnight(date: string, timezone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const desired = Date.UTC(year, month - 1, day);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(candidate, timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    if (represented === desired) break;
    candidate += desired - represented;
  }
  return candidate;
}

export function validateMonitorTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function monitorMonthDays(month: string, timezone: string): Array<{ date: string; start: number; end: number }> {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return [];
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 2000 || year > 2100 || monthNumber < 1 || monthNumber > 12) return [];
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => {
    const date = localDate(year, monthNumber, index + 1);
    const nextDate = localDate(year, monthNumber, index + 2);
    return { date, start: zonedMidnight(date, timezone), end: zonedMidnight(nextDate, timezone) };
  });
}

export function monitorLocalDayRange(date: string, timezone: string): { start: number; end: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (localDate(year, month, day) !== date) return null;
  return {
    start: zonedMidnight(date, timezone),
    end: zonedMidnight(localDate(year, month, day + 1), timezone),
  };
}

const hostIdentityInflight = new Map<string, Promise<HostIdentity | null>>();
const databaseTokens = new WeakMap<object, number>();
let nextDatabaseToken = 1;

function databaseToken(db: object): number {
  const existing = databaseTokens.get(db);
  if (existing) return existing;
  const token = nextDatabaseToken;
  nextDatabaseToken += 1;
  databaseTokens.set(db, token);
  return token;
}

function singleFlight<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const pending = load().finally(() => {
    if (map.get(key) === pending) map.delete(key);
  });
  map.set(key, pending);
  return pending;
}

async function hostIdentity(app: FastifyInstance, environmentId: string, connectionId: string): Promise<HostIdentity | null> {
  const key = `${databaseToken(app.db)}:${environmentId}:${connectionId}`;
  return singleFlight(hostIdentityInflight, key, () => resolveHostIdentity(app, environmentId, connectionId));
}

async function resolveHostIdentity(app: FastifyInstance, environmentId: string, connectionId: string): Promise<HostIdentity | null> {
  const connection = await app.db.prepare(`
    SELECT c.host, c.port, c.jump_connection_id, c.workspace_type, c.workspace_id
    FROM ssh_connections c
    JOIN ssh_connection_environments ce ON ce.connection_id = c.id
    WHERE c.id = ? AND ce.environment_id = ? AND c.source_deleted = 0
  `).get(connectionId, environmentId) as {
    host: string;
    port: number | string;
    jump_connection_id: string | null;
    workspace_type: string;
    workspace_id: string;
  } | undefined;
  if (!connection) return null;
  const connections = await app.db.prepare(`
    SELECT c.id, h.agent_id
    FROM ssh_connections c
    LEFT JOIN monitor_hosts h ON h.ssh_connection_id = c.id
    WHERE c.host = ? AND c.port = ?
      AND COALESCE(c.jump_connection_id, '') = COALESCE(?, '')
      AND c.workspace_type = ? AND c.workspace_id = ?
  `).all(
    connection.host,
    Number(connection.port),
    connection.jump_connection_id,
    connection.workspace_type,
    connection.workspace_id,
  ) as Array<{ id: string; agent_id: string | null }>;
  const connectionIds = [...new Set(connections.map((item) => item.id))];
  if (!connectionIds.includes(connectionId)) connectionIds.push(connectionId);
  const placeholders = connectionIds.map(() => "?").join(",");
  // 只取连接上出现过的 agent。索引含这两列，不会去读采样正文。
  const historicalAgents = await app.db.prepare(`
    SELECT DISTINCT agent_id FROM monitor_samples
    WHERE ssh_connection_id IN (${placeholders}) AND agent_id <> ''
  `).all(...connectionIds) as Array<{ agent_id: string }>;
  return {
    connectionIds,
    agentIds: [...new Set([
      ...connections.flatMap((item) => item.agent_id ? [item.agent_id] : []),
      ...historicalAgents.map((item) => item.agent_id),
      ...await historicalMetricAgents(app, connectionId),
    ])],
  };
}

function hostAlertScope(environmentId: string, resolved: HostIdentity): MonitorAlertSqlScope {
  const targetClauses: string[] = [];
  const targetParameters: unknown[] = [];
  if (resolved.agentIds.length) {
    targetClauses.push(`a.target_id IN (${resolved.agentIds.map(() => "?").join(",")})`);
    targetParameters.push(...resolved.agentIds);
  }
  if (resolved.connectionIds.length) {
    targetClauses.push(`a.ssh_connection_id IN (${resolved.connectionIds.map(() => "?").join(",")})`);
    targetParameters.push(...resolved.connectionIds);
  }
  return {
    sql: `a.environment_id = ? AND a.target_type = 'host' AND (${targetClauses.join(" OR ") || "0 = 1"})`,
    parameters: [environmentId, ...targetParameters],
  };
}

async function loadEvents(
  app: FastifyInstance, environmentId: string, connectionId: string,
  from: number, to: number, limit = 500,
): Promise<StoredEventRow[] | null> {
  const identity = await hostIdentity(app, environmentId, connectionId);
  if (!identity) return null;
  const matched = monitorAlertRangeSql(hostAlertScope(environmentId, identity), "a.id, a.triggered_at", from, to, Date.now(), app.db.dialect);
  return app.db.prepare(`
    WITH matched_alerts AS (${matched.sql}),
    page_ids AS (SELECT id FROM matched_alerts ORDER BY triggered_at DESC, id DESC LIMIT ${limit})
    SELECT a.id, a.rule_type, a.rule_key, a.status, a.severity, a.peak_severity, a.occurrence_count,
      a.target_name, a.details_json, a.triggered_at, a.recovered_at, a.last_seen_at
    FROM page_ids p JOIN monitor_alerts a ON a.id = p.id
    ORDER BY a.triggered_at DESC, a.id DESC
  `).all(...matched.parameters) as Promise<StoredEventRow[]>;
}

export function monitorSampleCoverageInterval(row: StoredSampleCoverageRow): TimeInterval | null {
  const end = Date.parse(row.collected_at);
  if (!Number.isFinite(end)) return null;
  const resolutionSeconds = Math.max(1, Number(row.resolution_seconds) || 1);
  const sampleCount = Math.max(1, Number(row.sequence_end) - Number(row.sequence_start) + 1);
  const duration = Math.min(24 * 60 * 60 * 1000, resolutionSeconds * sampleCount * 1000);
  return { start: end - duration, end: end + resolutionSeconds * 1000 };
}

export function coverageMsByDay(days: Array<{ start: number; end: number }>, intervals: TimeInterval[]): number[] {
  const covered = Array.from({ length: days.length }, () => 0);
  if (!days.length || !intervals.length) return covered;
  const merged: TimeInterval[] = [];
  for (const interval of intervals.slice().sort((left, right) => left.start - right.start || left.end - right.end)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  let dayIndex = 0;
  for (const interval of merged) {
    while (dayIndex < days.length && days[dayIndex]!.end <= interval.start) dayIndex += 1;
    for (let index = dayIndex; index < days.length && days[index]!.start < interval.end; index += 1) {
      const start = Math.max(days[index]!.start, interval.start);
      const end = Math.min(days[index]!.end, interval.end);
      if (end > start) covered[index] += end - start;
    }
  }
  return covered;
}

async function coverageIntervals(
  app: FastifyInstance,
  identity: HostIdentity,
  from: number,
  to: number,
): Promise<TimeInterval[]> {
  if (!identity.connectionIds.length) return [];
  const placeholders = identity.connectionIds.map(() => "?").join(",");
  // 覆盖率只需要区间端点。这些列都在 monitor_samples_coverage_idx 里，查询不会读取 payload_json。
  const rows = await app.db.prepare(`
    SELECT sequence_start, sequence_end, collected_at, resolution_seconds
    FROM monitor_samples
    WHERE ssh_connection_id IN (${placeholders})
      AND collected_at >= ? AND collected_at < ?
  `).all(
    ...identity.connectionIds,
    new Date(from - 24 * 60 * 60 * 1000).toISOString(),
    new Date(to + 24 * 60 * 60 * 1000).toISOString(),
  ) as StoredSampleCoverageRow[];
  const numeric = await app.db.prepare(`SELECT p.coverage_json FROM monitor_metric_points p
    JOIN monitor_metric_series s ON s.id = p.series_id JOIN monitor_metric_streams t ON t.id = s.stream_id
    WHERE s.kind = 'host' AND p.at_ms >= ? AND p.at_ms <= ? AND t.ssh_connection_id IN (${placeholders})`)
    .all<{ coverage_json: string }>(from - 86400_000, to + 86400_000, ...identity.connectionIds);
  return [...numeric.flatMap(row => {
    try { return (JSON.parse(row.coverage_json) as number[][]).map(([start, end]) => ({ start: start!, end: end! })); } catch { return []; }
  }), ...rows.flatMap((row) => {
    const interval = monitorSampleCoverageInterval(row);
    return interval ? [interval] : [];
  })];
}

export async function loadMonitorHostEventCalendar(
  app: FastifyInstance, environmentId: string, connectionId: string, month: string, timezone: string,
): Promise<MonitorHostEventCalendarResponse | null> {
  const days = monitorMonthDays(month, timezone);
  if (!days.length) return null;
  const generatedAt = Date.now();
  const from = days[0]!.start;
  const to = days.at(-1)!.end;
  const identity = await hostIdentity(app, environmentId, connectionId);
  if (!identity) return null;
  const [statistics, coverage] = await Promise.all([
    loadMonitorAlertCalendarAggregates(app.db, hostAlertScope(environmentId, identity), days, generatedAt),
    coverageIntervals(app, identity, from, to),
  ]);
  const coverageByDay = coverageMsByDay(days, coverage);
  const aggregates = statistics.days.map((day, index) => {
    const possibleMs = Math.max(0, Math.min(days[index]!.end, generatedAt) - days[index]!.start);
    return { ...day, coverageRatio: day.future || !possibleMs ? 0 : Math.min(1, (coverageByDay[index] ?? 0) / possibleMs) };
  });
  return {
    month, timezone, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    generatedAt: new Date(generatedAt).toISOString(), days: aggregates,
    summary: {
      healthyDays: aggregates.filter((day) => !day.future && day.coverageRatio >= 0.8 && day.activeEventCount === 0).length,
      affectedDays: aggregates.filter((day) => !day.future && day.activeEventCount > 0).length,
      noDataDays: aggregates.filter((day) => !day.future && day.coverageRatio < 0.8 && day.activeEventCount === 0).length,
      criticalEvents: statistics.criticalEvents, totalEvents: statistics.totalEvents,
      affectedMinutes: statistics.affectedMinutes, meanRecoveryMinutes: statistics.meanRecoveryMinutes,
    },
  };
}

export async function loadMonitorHostEvents(
  app: FastifyInstance,
  environmentId: string,
  connectionId: string,
  date: string,
  timezone: string,
): Promise<MonitorHostEventItem[] | null> {
  const range = monitorLocalDayRange(date, timezone);
  if (!range) return null;
  const rows = await loadEvents(app, environmentId, connectionId, range.start, range.end, 500);
  if (!rows) return null;
  return rows.map((row) => ({
    id: row.id,
    ruleType: row.rule_type,
    ruleKey: row.rule_key,
    status: row.status,
    severity: severity(row.severity),
    peakSeverity: severity(row.peak_severity),
    occurrenceCount: Math.max(1, Number(row.occurrence_count) || 1),
    targetName: row.target_name,
    details: parseDetails(row.details_json),
    triggeredAt: row.triggered_at,
    recoveredAt: row.recovered_at,
    lastSeenAt: row.last_seen_at || row.recovered_at || row.triggered_at,
  }));
}

export interface PlatformMonitorAlertQuery {
  workspaceType: string;
  workspaceId: string;
  environmentId?: string;
  allowedEnvironmentIds?: string[] | null;
  from: number;
  to: number;
  severity?: MonitorAlertSeverity | "all";
  status?: "active" | "recovered" | "event" | "all";
  order?: "recent" | "priority";
  limit?: number | null;
  offset?: number;
}

function platformAlertScope(query: PlatformMonitorAlertQuery): MonitorAlertSqlScope | null {
  const clauses = ["a.environment_id IN (SELECT e.id FROM environments e WHERE e.workspace_type = ? AND e.workspace_id = ?)"];
  const parameters: unknown[] = [query.workspaceType, query.workspaceId];
  if (query.environmentId) {
    clauses.push("a.environment_id = ?");
    parameters.push(query.environmentId);
  }
  if (query.allowedEnvironmentIds) {
    if (!query.allowedEnvironmentIds.length) return null;
    clauses.push(`a.environment_id IN (${query.allowedEnvironmentIds.map(() => "?").join(",")})`);
    parameters.push(...query.allowedEnvironmentIds);
  }
  if (query.severity && query.severity !== "all") {
    clauses.push("a.peak_severity = ?");
    parameters.push(query.severity);
  }
  if (query.status && query.status !== "all") {
    clauses.push("a.status = ?");
    parameters.push(query.status);
  }
  return { sql: clauses.join(" AND "), parameters };
}

async function loadPlatformAlertRows(app: FastifyInstance, query: PlatformMonitorAlertQuery, generatedAt: number): Promise<PlatformStoredEventRow[]> {
  const scope = platformAlertScope(query);
  if (!scope) return [];
  const matched = monitorAlertRangeSql(scope, "a.id, a.status, a.peak_severity, a.triggered_at, a.recovered_at, a.last_seen_at", query.from, query.to, generatedAt, app.db.dialect);
  const limit = query.limit === null ? null : Math.min(Math.max(1, query.limit ?? 100), 500);
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const pagination = limit === null ? "" : `LIMIT ${limit} OFFSET ${offset}`;
  const orderBy = query.order === "priority"
    ? `CASE peak_severity WHEN 'critical' THEN 4 WHEN 'major' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
       CASE WHEN status = 'active' THEN 0 WHEN status = 'event' THEN 1 ELSE 2 END,
       COALESCE(NULLIF(last_seen_at, ''), recovered_at, triggered_at) DESC, triggered_at DESC, id DESC`
    : "CASE WHEN status = 'active' THEN 0 WHEN status = 'event' THEN 1 ELSE 2 END, triggered_at DESC, id DESC";
  return app.db.prepare(`
    WITH matched_alerts AS (${matched.sql}),
    page_ids AS (SELECT * FROM matched_alerts ORDER BY ${orderBy} ${pagination})
    SELECT a.id, a.rule_type, a.rule_key, a.status, a.severity, a.peak_severity, a.occurrence_count,
      a.target_name, a.details_json, a.triggered_at, a.recovered_at, a.last_seen_at,
      a.environment_id, a.environment_name, a.ssh_connection_id, a.service_id, a.service_name,
      a.connection_name, a.target_type
    FROM page_ids p JOIN monitor_alerts a ON a.id = p.id
    ORDER BY ${orderBy.replace(/\b(peak_severity|status|last_seen_at|recovered_at|triggered_at|id)\b/g, "p.$1")}
  `).all(...matched.parameters) as Promise<PlatformStoredEventRow[]>;
}

async function countPlatformAlertRows(app: FastifyInstance, query: PlatformMonitorAlertQuery, generatedAt: number): Promise<number> {
  const scope = platformAlertScope(query);
  if (!scope) return 0;
  const counted = monitorAlertRangeSql(scope, "COUNT(*) AS count", query.from, query.to, generatedAt, app.db.dialect);
  const row = await app.db.prepare(`SELECT SUM(count) AS count FROM (${counted.sql}) AS counted_alerts`)
    .get(...counted.parameters) as { count: number | string } | undefined;
  return Math.max(0, Number(row?.count) || 0);
}

function mapPlatformEvent(row: PlatformStoredEventRow): MonitorPlatformEventItem {
  return {
    id: row.id,
    ruleType: row.rule_type,
    ruleKey: row.rule_key,
    status: row.status,
    severity: severity(row.severity),
    peakSeverity: severity(row.peak_severity),
    occurrenceCount: Math.max(1, Number(row.occurrence_count) || 1),
    targetName: row.target_name,
    details: parseDetails(row.details_json),
    triggeredAt: row.triggered_at,
    recoveredAt: row.recovered_at,
    lastSeenAt: row.last_seen_at || row.recovered_at || row.triggered_at,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    sshConnectionId: row.ssh_connection_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    connectionName: row.connection_name,
    targetType: row.target_type,
  };
}

export async function loadPlatformEventCalendar(
  app: FastifyInstance,
  query: Omit<PlatformMonitorAlertQuery, "from" | "to" | "severity" | "status" | "limit"> & { month: string; timezone: string },
): Promise<MonitorHostEventCalendarResponse | null> {
  const days = monitorMonthDays(query.month, query.timezone);
  if (!days.length) return null;
  const generatedAt = Date.now();
  const from = days[0]!.start;
  const to = days.at(-1)!.end;
  const statistics = await loadMonitorAlertCalendarAggregates(app.db, platformAlertScope({ ...query, from, to }), days, generatedAt);
  const aggregates = statistics.days.map((day) => ({ ...day, coverageRatio: day.future ? 0 : 1 }));
  return {
    month: query.month, timezone: query.timezone,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    generatedAt: new Date(generatedAt).toISOString(), days: aggregates,
    summary: {
      healthyDays: aggregates.filter((day) => !day.future && day.activeEventCount === 0).length,
      affectedDays: aggregates.filter((day) => !day.future && day.activeEventCount > 0).length,
      noDataDays: 0, criticalEvents: statistics.criticalEvents, totalEvents: statistics.totalEvents,
      affectedMinutes: statistics.affectedMinutes, meanRecoveryMinutes: statistics.meanRecoveryMinutes,
    },
  };
}

export async function loadPlatformEvents(app: FastifyInstance, query: PlatformMonitorAlertQuery): Promise<{ items: MonitorPlatformEventItem[]; total: number }> {
  const generatedAt = Date.now();
  const [rows, total] = await Promise.all([
    loadPlatformAlertRows(app, query, generatedAt), countPlatformAlertRows(app, query, generatedAt),
  ]);
  return { items: rows.map(mapPlatformEvent), total };
}
