import { monitorMetricColumn, monitorMetricKeys, monitorStatisticSuffixes } from "../shared/monitor-storage.js";

export function monitorStorageSchema(dialect: "sqlite" | "mysql"): string {
  const mysql = dialect === "mysql";
  const id = mysql ? "BIGINT PRIMARY KEY AUTO_INCREMENT" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const integer = mysql ? "BIGINT" : "INTEGER";
  const text = mysql ? "LONGTEXT" : "TEXT";
  const name = (length: number) => mysql ? `VARCHAR(${length})` : "TEXT";
  const end = mysql ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci" : "";
  const index = (table: string, key: string, fields: string) => mysql ? `KEY ${key} (${fields})` : "";
  const numeric = monitorMetricKeys.flatMap(key => monitorStatisticSuffixes.map(suffix => `${monitorMetricColumn(key)}_${suffix} ${mysql ? "DOUBLE" : "REAL"} NULL`)).join(",\n");
  const tables = `
CREATE TABLE IF NOT EXISTS monitor_metric_streams (
  id ${id}, workspace_type ${name(16)} NOT NULL, workspace_id ${name(64)} NOT NULL,
  agent_id ${name(64)} NOT NULL, ssh_connection_id ${name(64)} NULL,
  last_collected_ms ${integer} NOT NULL DEFAULT 0, last_sequence ${integer} NOT NULL DEFAULT 0,
  UNIQUE(workspace_type, workspace_id, agent_id),
  ${mysql ? "KEY monitor_metric_streams_age_idx (last_collected_ms)," : ""}
  FOREIGN KEY(ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL
)${end};
CREATE TABLE IF NOT EXISTS monitor_metric_series (
  id ${id}, stream_id ${integer} NOT NULL, kind ${name(16)} NOT NULL,
  identity_hash ${name(64)} NOT NULL, identity_json ${text} NOT NULL,
  stored_bytes ${integer} NOT NULL DEFAULT 512,
  latest_metadata_id ${integer} NULL, last_seen_ms ${integer} NOT NULL DEFAULT 0,
  UNIQUE(stream_id, kind, identity_hash),
  ${mysql ? "KEY monitor_metric_series_metadata_idx (latest_metadata_id), KEY monitor_metric_series_age_idx (last_seen_ms, id)," : ""}
  FOREIGN KEY(stream_id) REFERENCES monitor_metric_streams(id) ON DELETE CASCADE
)${end};
CREATE TABLE IF NOT EXISTS monitor_metric_metadata (
  id ${id}, series_id ${integer} NOT NULL, content_hash ${name(64)} NOT NULL,
  content_json ${text} NOT NULL, stored_bytes ${integer} NOT NULL,
  last_used_ms ${integer} NOT NULL, UNIQUE(series_id, content_hash),
  ${mysql ? "KEY monitor_metric_metadata_age_idx (last_used_ms)," : ""}
  FOREIGN KEY(series_id) REFERENCES monitor_metric_series(id) ON DELETE CASCADE
)${end};
CREATE TABLE IF NOT EXISTS monitor_metric_points (
  id ${id}, series_id ${integer} NOT NULL, metadata_id ${integer} NOT NULL,
  tier_seconds INTEGER NOT NULL, at_ms ${integer} NOT NULL, sequence_end ${integer} NOT NULL,
  resolution_seconds INTEGER NOT NULL, sample_count ${integer} NOT NULL,
  coverage_start_ms ${integer} NOT NULL, coverage_end_ms ${integer} NOT NULL,
  coverage_json ${text} NOT NULL,
  source_first_ms ${integer} NOT NULL, source_last_ms ${integer} NOT NULL,
  rollup_done INTEGER NOT NULL DEFAULT 0, stored_bytes ${integer} NOT NULL,
  state_detail ${name(255)} NOT NULL DEFAULT '',
  ${numeric},
  UNIQUE(series_id, tier_seconds, at_ms, sequence_end),
  ${mysql ? `${index("monitor_metric_points", "monitor_metric_points_gc_idx", "tier_seconds, at_ms, id")},
  ${index("monitor_metric_points", "monitor_metric_points_pending_idx", "tier_seconds, rollup_done, id")},
  ${index("monitor_metric_points", "monitor_metric_points_metadata_idx", "metadata_id")},` : ""}
  FOREIGN KEY(series_id) REFERENCES monitor_metric_series(id) ON DELETE CASCADE,
  FOREIGN KEY(metadata_id) REFERENCES monitor_metric_metadata(id)
)${end};
CREATE TABLE IF NOT EXISTS monitor_metric_ingest (
  stream_id ${integer} NOT NULL, sequence_end ${integer} NOT NULL,
  sequence_start ${integer} NOT NULL, collected_at_ms ${integer} NOT NULL,
  stored_bytes ${integer} NOT NULL DEFAULT 288,
  PRIMARY KEY(stream_id, sequence_end),
  ${mysql ? "KEY monitor_metric_ingest_gc_idx (collected_at_ms)," : ""}
  FOREIGN KEY(stream_id) REFERENCES monitor_metric_streams(id) ON DELETE CASCADE
)${end};
CREATE TABLE IF NOT EXISTS monitor_metric_diagnostics (
  stream_id ${integer} NOT NULL, sequence_end ${integer} NOT NULL,
  at_ms ${integer} NOT NULL, expires_ms ${integer} NOT NULL,
  payload_base64 ${text} NOT NULL, stored_bytes ${integer} NOT NULL,
  PRIMARY KEY(stream_id, sequence_end),
  ${mysql ? "KEY monitor_metric_diagnostics_gc_idx (expires_ms), KEY monitor_metric_diagnostics_time_idx (stream_id, at_ms)," : ""}
  FOREIGN KEY(stream_id) REFERENCES monitor_metric_streams(id) ON DELETE CASCADE
)${end};
CREATE TABLE IF NOT EXISTS monitor_storage_state (
  state_key ${name(64)} PRIMARY KEY, value_json ${text} NOT NULL,
  lease_owner ${name(64)} NOT NULL DEFAULT '', lease_until_ms ${integer} NOT NULL DEFAULT 0,
  used_bytes ${integer} NOT NULL DEFAULT 0, diagnostic_bytes ${integer} NOT NULL DEFAULT 0,
  updated_ms ${integer} NOT NULL DEFAULT 0
)${end};
`;
  return tables + (mysql ? "" : `
CREATE INDEX IF NOT EXISTS monitor_metric_points_gc_idx ON monitor_metric_points(tier_seconds, at_ms, id);
CREATE INDEX IF NOT EXISTS monitor_metric_points_pending_idx ON monitor_metric_points(tier_seconds, rollup_done, id);
CREATE INDEX IF NOT EXISTS monitor_metric_points_metadata_idx ON monitor_metric_points(metadata_id);
CREATE INDEX IF NOT EXISTS monitor_metric_series_metadata_idx ON monitor_metric_series(latest_metadata_id);
CREATE INDEX IF NOT EXISTS monitor_metric_series_age_idx ON monitor_metric_series(last_seen_ms, id);
CREATE INDEX IF NOT EXISTS monitor_metric_ingest_gc_idx ON monitor_metric_ingest(collected_at_ms);
CREATE INDEX IF NOT EXISTS monitor_metric_diagnostics_gc_idx ON monitor_metric_diagnostics(expires_ms);
CREATE INDEX IF NOT EXISTS monitor_metric_diagnostics_time_idx ON monitor_metric_diagnostics(stream_id, at_ms);
CREATE INDEX IF NOT EXISTS monitor_metric_streams_age_idx ON monitor_metric_streams(last_collected_ms);
CREATE INDEX IF NOT EXISTS monitor_metric_metadata_age_idx ON monitor_metric_metadata(last_used_ms);
`);
}
