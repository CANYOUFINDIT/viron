import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/database.js";
import { SQLITE_SCHEMA } from "../src/server/sqlite-schema.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testConfig(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 42),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
    monitorPullIntervalSeconds: 60,
  };
}

describe("monitor alert database migration", () => {
  it("preserves alert history while adding host availability, disk events, and event status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-monitor-alert-migration-"));
    directories.push(directory);
    const config = testConfig(directory);
    const raw = new Database(config.databasePath);
    raw.pragma("foreign_keys = ON");
    const legacySchema = SQLITE_SCHEMA
      .replaceAll("'host_offline',", "")
      .replaceAll("'disk_added',", "")
      .replace("CHECK(status IN ('active','recovered','event'))", "CHECK(status IN ('active','recovered'))")
      .replace("  host_offline_enabled INTEGER NOT NULL DEFAULT 0,\n", "");
    raw.exec(legacySchema);

    const userId = randomUUID();
    const environmentId = randomUUID();
    const stateId = randomUUID();
    const alertId = randomUUID();
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO admin_users (id, username, password_hash, is_platform_admin, status, created_at, updated_at)
      VALUES (?, 'migration-admin', 'not-used', 1, 'active', ?, ?)
    `).run(userId, now, now);
    raw.prepare(`
      INSERT INTO environments (
        id, workspace_type, workspace_id, group_id, sort_order, name, short_name,
        description, status, owner, tags_json, created_at, updated_at
      ) VALUES (?, 'personal', ?, NULL, 0, '迁移环境', '', '', 'active', '', '[]', ?, ?)
    `).run(environmentId, userId, now, now);
    raw.prepare(`
      INSERT INTO monitor_alert_states (
        id, environment_id, target_type, target_id, rule_type, rule_key_hash, rule_key,
        ssh_connection_id, service_id, deployment_id, target_name, connection_name, service_name,
        breach_count, recovery_count, active_alert_id, last_value_json, last_evaluated_at, created_at, updated_at
      ) VALUES (?, ?, 'host', ?, 'cpu', ?, '', NULL, NULL, NULL, '迁移主机', '', '', 2, 0, ?, '{}', ?, ?, ?)
    `).run(stateId, environmentId, randomUUID(), "0".repeat(64), alertId, now, now, now);
    raw.prepare(`
      INSERT INTO monitor_alerts (
        id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
        ssh_connection_id, service_id, deployment_id, environment_name, target_name,
        connection_name, service_name, status, details_json, triggered_at, recovered_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'host', ?, 'cpu', '', NULL, NULL, NULL, '迁移环境', '迁移主机', '', '', 'active', '{}', ?, NULL, ?, ?)
    `).run(alertId, environmentId, stateId, randomUUID(), now, now, now);
    raw.prepare(`
      INSERT INTO monitor_alert_user_states (alert_id, user_id, active_notified_at, recovery_notified_at, read_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(alertId, userId, now, now, now);
    raw.close();

    const db = await openDatabase(config);
    try {
      const stateSql = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'monitor_alert_states'").get() as { sql: string };
      const alertSql = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'monitor_alerts'").get() as { sql: string };
      expect(stateSql.sql).toContain("host_offline");
      expect(stateSql.sql).toContain("disk_added");
      expect(stateSql.sql).toContain("tls_expiring");
      expect(stateSql.sql).toContain("tls_endpoint");
      expect(alertSql.sql).toContain("host_offline");
      expect(alertSql.sql).toContain("disk_added");
      expect(alertSql.sql).toContain("tls_expiring");
      expect(alertSql.sql).toContain("'event'");
      expect(await db.prepare("SELECT id, status FROM monitor_alerts WHERE id = ?").get(alertId)).toEqual({ id: alertId, status: "active" });
      expect(await db.prepare("SELECT alert_id, user_id FROM monitor_alert_user_states WHERE alert_id = ?").get(alertId)).toEqual({ alert_id: alertId, user_id: userId });
      expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const columns = await db.prepare("PRAGMA table_info(monitor_alert_settings)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "host_offline_enabled")).toBe(true);
      const userStateColumns = await db.prepare("PRAGMA table_info(monitor_alert_user_states)").all() as Array<{ name: string }>;
      expect(userStateColumns.some((column) => column.name === "cleared_at")).toBe(true);
      expect(userStateColumns.some((column) => column.name === "severity_notified")).toBe(true);
      const stateColumns = await db.prepare("PRAGMA table_info(monitor_alert_states)").all() as Array<{ name: string }>;
      expect(stateColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["last_recovered_alert_id", "last_recovered_at"]));
      const alertColumns = await db.prepare("PRAGMA table_info(monitor_alerts)").all() as Array<{ name: string }>;
      expect(alertColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["severity", "peak_severity", "occurrence_count", "last_seen_at"]));
    } finally {
      await db.close();
    }
  });
});
