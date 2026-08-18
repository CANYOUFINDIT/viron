import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAudit } from "../src/server/audit.js";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "viron.db"),
    masterKey: Buffer.alloc(32, 43),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("audit source", () => {
  it("adds the source column, safely backfills explicit legacy MCP actions, and defaults background writes to system", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-audit-source-"));
    directories.push(directory);
    const config = configFor(directory);
    const legacy = await openDatabase(config);
    const now = new Date().toISOString();
    await legacy.prepare(`
      INSERT INTO audit_events (id, action, resource_type, summary, details_json, created_at)
      VALUES (?, ?, 'test', ?, '{}', ?), (?, ?, 'test', ?, '{}', ?)
    `).run(
      "legacy-mcp", "mcp.legacy_action", "Legacy MCP action", now,
      "legacy-unknown", "connection.legacy_action", "Legacy connection action", now,
    );
    await legacy.exec("ALTER TABLE audit_events DROP COLUMN source");
    await legacy.close();

    const migrated = await openDatabase(config);
    const columns = await migrated.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("source");
    expect(await migrated.prepare("SELECT source FROM audit_events WHERE id = ?").get("legacy-mcp")).toEqual({ source: "mcp" });
    expect(await migrated.prepare("SELECT source FROM audit_events WHERE id = ?").get("legacy-unknown")).toEqual({ source: "unknown" });

    await writeAudit(migrated, {
      action: "system.maintenance",
      resourceType: "system",
      summary: "Background maintenance",
    });
    expect(await migrated.prepare("SELECT source FROM audit_events WHERE action = ?").get("system.maintenance")).toEqual({ source: "system" });
    await migrated.close();
  });
});
