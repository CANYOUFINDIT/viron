import type { FastifyInstance } from "fastify";
import {
  MONITOR_ALERT_SEVERITIES,
  monitorAlertSeverityRank,
  monitorAlertSeverityWeight,
  type MonitorAlertRuleType,
  type MonitorAlertSeverity,
  type MonitorAlertTargetType,
  type MonitorHostEventCalendarDay,
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

function zonedParts(timestamp: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
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

async function hostIdentity(app: FastifyInstance, environmentId: string, connectionId: string): Promise<HostIdentity | null> {
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
  const historicalAgents = await app.db.prepare(`
    SELECT DISTINCT agent_id FROM monitor_samples
    WHERE ssh_connection_id IN (${placeholders}) AND agent_id <> ''
  `).all(...connectionIds) as Array<{ agent_id: string }>;
  return {
    connectionIds,
    agentIds: [...new Set([
      ...connections.flatMap((item) => item.agent_id ? [item.agent_id] : []),
      ...historicalAgents.map((item) => item.agent_id),
    ])],
  };
}

async function loadEvents(
  app: FastifyInstance,
  environmentId: string,
  connectionId: string,
  from: number,
  to: number,
  limit = 2_000,
): Promise<StoredEventRow[] | null> {
  const identity = await hostIdentity(app, environmentId, connectionId);
  if (!identity) return null;
  const targetClauses: string[] = [];
  const targetParameters: unknown[] = [];
  if (identity.agentIds.length) {
    targetClauses.push(`target_id IN (${identity.agentIds.map(() => "?").join(",")})`);
    targetParameters.push(...identity.agentIds);
  }
  if (identity.connectionIds.length) {
    targetClauses.push(`ssh_connection_id IN (${identity.connectionIds.map(() => "?").join(",")})`);
    targetParameters.push(...identity.connectionIds);
  }
  if (!targetClauses.length) return [];
  return app.db.prepare(`
    SELECT id, rule_type, rule_key, status, severity, peak_severity, occurrence_count,
      target_name, details_json, triggered_at, recovered_at, last_seen_at
    FROM monitor_alerts
    WHERE environment_id = ? AND target_type = 'host'
      AND (${targetClauses.join(" OR ")})
      AND triggered_at < ?
      AND (CASE WHEN status = 'active' THEN ? WHEN recovered_at IS NOT NULL THEN recovered_at ELSE triggered_at END) >= ?
    ORDER BY triggered_at DESC
    LIMIT ${limit}
  `).all(environmentId, ...targetParameters, new Date(to).toISOString(), new Date().toISOString(), new Date(from).toISOString()) as Promise<StoredEventRow[]>;
}

function mergeDuration(intervals: TimeInterval[]): number {
  if (!intervals.length) return 0;
  const sorted = intervals.slice().sort((left, right) => left.start - right.start);
  let duration = 0;
  let current = { ...sorted[0]! };
  for (const interval of sorted.slice(1)) {
    if (interval.start <= current.end) current.end = Math.max(current.end, interval.end);
    else {
      duration += Math.max(0, current.end - current.start);
      current = { ...interval };
    }
  }
  return duration + Math.max(0, current.end - current.start);
}

function eventInterval(event: StoredEventRow, generatedAt: number): TimeInterval {
  const start = Date.parse(event.triggered_at);
  const end = event.status === "active"
    ? generatedAt
    : event.recovered_at
      ? Date.parse(event.recovered_at)
      : start + 1;
  return { start, end: Math.max(start + 1, end) };
}

function overlaps(interval: TimeInterval, start: number, end: number): boolean {
  return interval.start < end && interval.end >= start;
}

async function coverageIntervals(
  app: FastifyInstance,
  environmentId: string,
  connectionId: string,
  from: number,
  to: number,
): Promise<TimeInterval[] | null> {
  const identity = await hostIdentity(app, environmentId, connectionId);
  if (!identity) return null;
  if (!identity.connectionIds.length) return [];
  const placeholders = identity.connectionIds.map(() => "?").join(",");
  const rows = await app.db.prepare(`
    SELECT sequence_start, sequence_end, collected_at, resolution_seconds
    FROM monitor_samples
    WHERE ssh_connection_id IN (${placeholders})
      AND collected_at >= ? AND collected_at < ?
    ORDER BY collected_at
  `).all(
    ...identity.connectionIds,
    new Date(from - 24 * 60 * 60 * 1000).toISOString(),
    new Date(to + 24 * 60 * 60 * 1000).toISOString(),
  ) as StoredSampleCoverageRow[];
  return rows.flatMap((row) => {
    const end = Date.parse(row.collected_at);
    const resolutionSeconds = Math.max(1, Number(row.resolution_seconds) || 1);
    const sampleCount = Math.max(1, Number(row.sequence_end) - Number(row.sequence_start) + 1);
    const duration = Math.min(24 * 60 * 60 * 1000, resolutionSeconds * sampleCount * 1000);
    return Number.isFinite(end) ? [{ start: end - duration, end: end + resolutionSeconds * 1000 }] : [];
  });
}

function dayAggregate(day: { date: string; start: number; end: number }, events: StoredEventRow[], coverage: TimeInterval[], generatedAt: number): MonitorHostEventCalendarDay {
  const eventIntervals = events.map((event) => ({ event, interval: eventInterval(event, generatedAt) }));
  const active = eventIntervals.filter(({ interval }) => overlaps(interval, day.start, day.end));
  const newEvents = events.filter((event) => {
    const triggeredAt = Date.parse(event.triggered_at);
    return triggeredAt >= day.start && triggeredAt < day.end;
  });
  const counts = { info: 0, warning: 0, major: 0, critical: 0 };
  let peakSeverity: MonitorAlertSeverity | null = null;
  for (const { event } of active) {
    const eventSeverity = severity(event.peak_severity || event.severity);
    counts[eventSeverity] += 1;
    if (!peakSeverity || monitorAlertSeverityRank(eventSeverity) > monitorAlertSeverityRank(peakSeverity)) peakSeverity = eventSeverity;
  }
  const affectedMs = mergeDuration(active.map(({ interval }) => ({
    start: Math.max(day.start, interval.start),
    end: Math.min(day.end, interval.end),
  })));
  const coverageMs = mergeDuration(coverage.filter((interval) => overlaps(interval, day.start, day.end)).map((interval) => ({
    start: Math.max(day.start, interval.start),
    end: Math.min(day.end, interval.end),
  })));
  const effectiveEnd = Math.min(day.end, generatedAt);
  const possibleMs = Math.max(0, effectiveEnd - day.start);
  const future = day.start > generatedAt;
  const affectedMinutes = Math.round(affectedMs / 60_000);
  const weightedCount = Object.entries(counts).reduce((total, [key, value]) => (
    total + monitorAlertSeverityWeight[key as MonitorAlertSeverity] * value
  ), 0);
  return {
    date: day.date,
    future,
    coverageRatio: future || possibleMs === 0 ? 0 : Math.min(1, coverageMs / possibleMs),
    newEventCount: newEvents.length,
    activeEventCount: active.length,
    infoCount: counts.info,
    warningCount: counts.warning,
    majorCount: counts.major,
    criticalCount: counts.critical,
    affectedMinutes,
    peakSeverity,
    burdenScore: Math.round((weightedCount + affectedMinutes / 60) * 10) / 10,
  };
}

export async function loadMonitorHostEventCalendar(
  app: FastifyInstance,
  environmentId: string,
  connectionId: string,
  month: string,
  timezone: string,
): Promise<MonitorHostEventCalendarResponse | null> {
  const days = monitorMonthDays(month, timezone);
  if (!days.length) return null;
  const generatedAt = Date.now();
  const from = days[0]!.start;
  const to = days.at(-1)!.end;
  const [events, coverage] = await Promise.all([
    loadEvents(app, environmentId, connectionId, from, to),
    coverageIntervals(app, environmentId, connectionId, from, to),
  ]);
  if (!events || !coverage) return null;
  const aggregates = days.map((day) => dayAggregate(day, events, coverage, generatedAt));
  const triggeredInMonth = events.filter((event) => {
    const triggeredAt = Date.parse(event.triggered_at);
    return triggeredAt >= from && triggeredAt < to;
  });
  const recoveredDurations = triggeredInMonth.flatMap((event) => event.recovered_at
    ? [Math.max(0, Date.parse(event.recovered_at) - Date.parse(event.triggered_at)) / 60_000]
    : []);
  return {
    month,
    timezone,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    generatedAt: new Date(generatedAt).toISOString(),
    days: aggregates,
    summary: {
      healthyDays: aggregates.filter((day) => !day.future && day.coverageRatio >= 0.8 && day.activeEventCount === 0).length,
      affectedDays: aggregates.filter((day) => !day.future && day.activeEventCount > 0).length,
      noDataDays: aggregates.filter((day) => !day.future && day.coverageRatio < 0.8 && day.activeEventCount === 0).length,
      criticalEvents: triggeredInMonth.filter((event) => severity(event.peak_severity) === "critical").length,
      totalEvents: triggeredInMonth.length,
      affectedMinutes: aggregates.reduce((total, day) => total + day.affectedMinutes, 0),
      meanRecoveryMinutes: recoveredDurations.length
        ? Math.round(recoveredDurations.reduce((total, value) => total + value, 0) / recoveredDurations.length)
        : null,
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
  limit?: number;
}

async function loadPlatformAlertRows(
  app: FastifyInstance,
  query: PlatformMonitorAlertQuery,
): Promise<PlatformStoredEventRow[]> {
  const clauses = [
    "e.workspace_type = ?",
    "e.workspace_id = ?",
    "a.triggered_at <= ?",
    "COALESCE(NULLIF(a.last_seen_at, ''), a.recovered_at, a.triggered_at) >= ?",
  ];
  const parameters: unknown[] = [
    query.workspaceType,
    query.workspaceId,
    new Date(query.to).toISOString(),
    new Date(query.from).toISOString(),
  ];
  if (query.environmentId) {
    clauses.push("a.environment_id = ?");
    parameters.push(query.environmentId);
  }
  if (query.allowedEnvironmentIds) {
    if (!query.allowedEnvironmentIds.length) return [];
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
  const limit = Math.min(Math.max(1, query.limit ?? 500), 2_000);
  return app.db.prepare(`
    SELECT a.id, a.rule_type, a.rule_key, a.status, a.severity, a.peak_severity, a.occurrence_count,
      a.target_name, a.details_json, a.triggered_at, a.recovered_at, a.last_seen_at,
      a.environment_id, a.environment_name, a.ssh_connection_id, a.service_id, a.service_name,
      a.connection_name, a.target_type
    FROM monitor_alerts a
    JOIN environments e ON e.id = a.environment_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 WHEN a.status = 'event' THEN 1 ELSE 2 END, a.triggered_at DESC
    LIMIT ${limit}
  `).all(...parameters) as Promise<PlatformStoredEventRow[]>;
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
  const events = await loadPlatformAlertRows(app, { ...query, from, to, limit: 2_000 });
  const aggregates = days.map((day) => dayAggregate(day, events, [], generatedAt));
  const triggeredInMonth = events.filter((event) => {
    const triggeredAt = Date.parse(event.triggered_at);
    return triggeredAt >= from && triggeredAt < to;
  });
  const recoveredDurations = triggeredInMonth.flatMap((event) => event.recovered_at
    ? [Math.max(0, Date.parse(event.recovered_at) - Date.parse(event.triggered_at)) / 60_000]
    : []);
  return {
    month: query.month,
    timezone: query.timezone,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    generatedAt: new Date(generatedAt).toISOString(),
    days: aggregates,
    summary: {
      healthyDays: aggregates.filter((day) => !day.future && day.activeEventCount === 0).length,
      affectedDays: aggregates.filter((day) => !day.future && day.activeEventCount > 0).length,
      noDataDays: 0,
      criticalEvents: triggeredInMonth.filter((event) => severity(event.peak_severity) === "critical").length,
      totalEvents: triggeredInMonth.length,
      affectedMinutes: aggregates.reduce((total, day) => total + day.affectedMinutes, 0),
      meanRecoveryMinutes: recoveredDurations.length
        ? Math.round(recoveredDurations.reduce((total, value) => total + value, 0) / recoveredDurations.length)
        : null,
    },
  };
}

export async function loadPlatformEvents(
  app: FastifyInstance,
  query: PlatformMonitorAlertQuery,
): Promise<MonitorPlatformEventItem[]> {
  const rows = await loadPlatformAlertRows(app, query);
  return rows.map(mapPlatformEvent);
}
