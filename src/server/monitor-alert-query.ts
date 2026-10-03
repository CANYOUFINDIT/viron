import type { DatabaseDialect, EnvmanDatabase } from "./database-client.js";
import { monitorAlertSeverityWeight, type MonitorAlertSeverity, type MonitorHostEventCalendarDay } from "../shared/monitor-alerts.js";

export interface MonitorAlertSqlScope {
  sql: string;
  parameters: unknown[];
}

// Disjoint ranges seek new incidents by trigger time and older incidents by
// status/recovery time, without scanning expired history or notification state.
export function monitorAlertRangeSql(
  scope: MonitorAlertSqlScope,
  columns: string,
  from: number,
  to: number,
  generatedAt: number,
  dialect: DatabaseDialect,
): MonitorAlertSqlScope {
  const start = new Date(from).toISOString();
  const end = new Date(to).toISOString();
  const includeActive = generatedAt >= from;
  const branches: MonitorAlertSqlScope[] = [{
    sql: `a.triggered_at >= ? AND a.triggered_at < ?
      AND ((a.status <> 'active' AND (a.recovered_at IS NULL OR a.recovered_at >= ?))${includeActive ? " OR a.status = 'active'" : ""})`,
    parameters: [start, end, start],
  }];
  if (includeActive) branches.push({ sql: "a.status = 'active' AND a.triggered_at < ?", parameters: [start] });
  branches.push({
    sql: "a.status IN ('recovered', 'event') AND a.recovered_at >= ? AND a.triggered_at < ?",
    parameters: [start, start],
  });
  return {
    sql: branches.map((branch, index) => {
      const name = index === 0 ? "monitor_alerts_calendar_trigger_idx" : "monitor_alerts_calendar_recovery_idx";
      // Without ANALYZE, SQLite may choose trigger time for old recovered rows.
      const hint = dialect === "mysql" ? `FORCE INDEX (${name})` : `INDEXED BY ${name}`;
      return `SELECT ${columns} FROM monitor_alerts a ${hint} WHERE (${scope.sql}) AND ${branch.sql}`;
    }).join("\nUNION ALL\n"),
    parameters: branches.flatMap((branch) => [...scope.parameters, ...branch.parameters]),
  };
}

// UTC conversion is independent of the database timezone and keeps exact ms.
function timestampMsSql(db: EnvmanDatabase, value: string): string {
  if (db.dialect === "mysql") return `(TIMESTAMPDIFF(MICROSECOND, '1970-01-01', CAST(REPLACE(SUBSTRING(${value}, 1, 23), 'T', ' ') AS DATETIME(3))) / 1000)`;
  return `(CAST(strftime('%s', ${value}) AS INTEGER) * 1000 + CAST(substr(${value}, 21, 3) AS INTEGER))`;
}

interface CalendarAggregateRow {
  date: string;
  new_count: number | string;
  active_count: number | string;
  info_count: number | string;
  warning_count: number | string;
  major_count: number | string;
  critical_count: number | string;
  new_critical_count: number | string;
  recovery_count: number | string;
  recovery_ms: number | string;
  affected_ms: number | string;
}

export async function loadMonitorAlertCalendarAggregates(
  db: EnvmanDatabase,
  scope: MonitorAlertSqlScope | null,
  days: Array<{ date: string; start: number; end: number }>,
  generatedAt: number,
) {
  const from = days[0]!.start;
  const to = days.at(-1)!.end;
  let rows: CalendarAggregateRow[] = [];
  if (scope) {
    const matched = monitorAlertRangeSql(scope, "a.triggered_at, a.recovered_at, a.status, a.peak_severity, a.severity", from, to, generatedAt, db.dialect);
    const dayIndexSql = (timestamp: string) => `CASE WHEN ${timestamp} < ${from} THEN -1
      ${days.map((day, index) => `WHEN ${timestamp} < ${day.end} THEN ${index}`).join("\n")}
      ELSE ${days.length} END`;
    const rowsSql = `
      WITH calendar_days AS (${days.map((_, index) => `SELECT ? AS date, ? AS start_ms, ? AS end_ms, ${index} AS day_index`).join(" UNION ALL ")}),
      matched_alerts AS (${matched.sql}),
      event_times AS (
        SELECT ${timestampMsSql(db, "triggered_at")} AS start_ms,
          ${timestampMsSql(db, "recovered_at")} AS recovery_ms, status,
          CASE WHEN COALESCE(NULLIF(peak_severity, ''), severity) IN ('info', 'warning', 'major', 'critical')
            THEN COALESCE(NULLIF(peak_severity, ''), severity) ELSE 'warning' END AS severity
        FROM matched_alerts
      ),
      event_ends AS (
        SELECT *, CASE WHEN status = 'active' THEN ? ELSE COALESCE(recovery_ms, start_ms + 1) END AS observed_end_ms
        FROM event_times
      ),
      event_intervals AS (
        SELECT *, CASE WHEN observed_end_ms > start_ms THEN observed_end_ms ELSE start_ms + 1 END AS end_ms
        FROM event_ends
      ),
      day_event_spans AS (
        SELECT ${dayIndexSql("start_ms")} AS start_day, ${dayIndexSql("end_ms")} AS end_day,
          severity, COUNT(*) AS event_count,
          SUM(CASE WHEN recovery_ms IS NOT NULL THEN 1 ELSE 0 END) AS recovery_count,
          SUM(CASE WHEN recovery_ms > start_ms THEN recovery_ms - start_ms ELSE 0 END) AS recovery_ms
        FROM event_intervals GROUP BY start_day, end_day, severity
      ),
      daily_counts AS (
        SELECT d.date,
          SUM(CASE WHEN m.start_day = d.day_index THEN m.event_count ELSE 0 END) AS new_count,
          COALESCE(SUM(m.event_count), 0) AS active_count,
          SUM(CASE WHEN m.severity = 'info' THEN m.event_count ELSE 0 END) AS info_count,
          SUM(CASE WHEN m.severity = 'warning' THEN m.event_count ELSE 0 END) AS warning_count,
          SUM(CASE WHEN m.severity = 'major' THEN m.event_count ELSE 0 END) AS major_count,
          SUM(CASE WHEN m.severity = 'critical' THEN m.event_count ELSE 0 END) AS critical_count,
          SUM(CASE WHEN m.start_day = d.day_index AND m.severity = 'critical' THEN m.event_count ELSE 0 END) AS new_critical_count,
          SUM(CASE WHEN m.start_day = d.day_index THEN m.recovery_count ELSE 0 END) AS recovery_count,
          SUM(CASE WHEN m.start_day = d.day_index THEN m.recovery_ms ELSE 0 END) AS recovery_ms
        FROM calendar_days d
        LEFT JOIN day_event_spans m ON m.start_day <= d.day_index AND m.end_day >= d.day_index
        GROUP BY d.date
      ),
      clipped_intervals AS (
        SELECT DISTINCT CASE WHEN start_ms < ? THEN ? ELSE start_ms END AS start_ms,
          CASE WHEN end_ms > ? THEN ? ELSE end_ms END AS end_ms
        FROM event_intervals
      ),
      ordered_intervals AS (
        SELECT *, MAX(end_ms) OVER (
          ORDER BY start_ms, end_ms ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS previous_end_ms
        FROM clipped_intervals WHERE end_ms > start_ms
      ),
      uncovered_intervals AS (
        SELECT CASE WHEN previous_end_ms > start_ms THEN previous_end_ms ELSE start_ms END AS start_ms, end_ms
        FROM ordered_intervals WHERE previous_end_ms IS NULL OR end_ms > previous_end_ms
      ),
      daily_duration AS (
        SELECT d.date, SUM(
          (CASE WHEN m.end_ms < d.end_ms THEN m.end_ms ELSE d.end_ms END)
          - (CASE WHEN m.start_ms > d.start_ms THEN m.start_ms ELSE d.start_ms END)
        ) AS affected_ms
        FROM calendar_days d
        JOIN uncovered_intervals m ON m.start_ms < d.end_ms AND m.end_ms > d.start_ms
        GROUP BY d.date
      )
      SELECT c.*, COALESCE(t.affected_ms, 0) AS affected_ms
      FROM daily_counts c LEFT JOIN daily_duration t ON t.date = c.date
      ORDER BY c.date
    `;
    rows = await db.prepare(rowsSql).all<CalendarAggregateRow>(
      ...days.flatMap((day) => [day.date, day.start, day.end]),
      ...matched.parameters, generatedAt, from, from, to, to,
    );
  }
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const aggregates: MonitorHostEventCalendarDay[] = days.map((day) => {
    const row = byDate.get(day.date);
    const counts = {
      info: Number(row?.info_count ?? 0), warning: Number(row?.warning_count ?? 0),
      major: Number(row?.major_count ?? 0), critical: Number(row?.critical_count ?? 0),
    };
    const peakSeverity = (["critical", "major", "warning", "info"] as MonitorAlertSeverity[]).find((value) => counts[value] > 0) ?? null;
    const affectedMinutes = Math.round(Number(row?.affected_ms ?? 0) / 60_000);
    const weightedCount = Object.entries(counts).reduce((sum, [key, count]) => sum + monitorAlertSeverityWeight[key as MonitorAlertSeverity] * count, 0);
    return {
      date: day.date, future: day.start > generatedAt, coverageRatio: 0,
      newEventCount: Number(row?.new_count ?? 0), activeEventCount: Number(row?.active_count ?? 0),
      infoCount: counts.info, warningCount: counts.warning, majorCount: counts.major, criticalCount: counts.critical,
      peakSeverity, affectedMinutes, burdenScore: Math.round((weightedCount + affectedMinutes / 60) * 10) / 10,
    };
  });
  const recoveryCount = rows.reduce((sum, row) => sum + Number(row.recovery_count), 0);
  return {
    days: aggregates,
    criticalEvents: rows.reduce((sum, row) => sum + Number(row.new_critical_count), 0),
    totalEvents: aggregates.reduce((sum, day) => sum + day.newEventCount, 0),
    affectedMinutes: aggregates.reduce((sum, day) => sum + day.affectedMinutes, 0),
    meanRecoveryMinutes: recoveryCount
      ? Math.round(rows.reduce((sum, row) => sum + Number(row.recovery_ms), 0) / recoveryCount / 60_000)
      : null,
  };
}
