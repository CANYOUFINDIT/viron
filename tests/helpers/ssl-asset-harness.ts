import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { AppConfig } from "../../src/server/config.js";
import type { EnvmanDatabase } from "../../src/server/database.js";
import {
  SSL_ASSET_MIGRATION_CHECKSUM,
  SSL_ASSET_MIGRATION_ID,
  SslAssetMigrationError,
  migrateSslAssets,
} from "../../src/server/ssl-asset-migration.js";

export function fingerprintFor(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function sslTestConfig(directory: string, mysql?: { host: string; port: number }): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: `${directory}/envman.db`,
    ...(mysql ? {
      databaseDriver: "mysql" as const,
      databaseHost: mysql.host,
      databasePort: mysql.port,
      databaseName: "viron_ssl",
      databaseUsername: "root",
      databasePassword: "test",
    } : {}),
    masterKey: Buffer.alloc(32, 61),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

export async function resetSslTables(db: EnvmanDatabase): Promise<void> {
  await db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(SSL_ASSET_MIGRATION_ID);
  await db.prepare("DELETE FROM ssl_endpoint_web_entries").run();
  await db.prepare("DELETE FROM ssl_endpoints").run();
  await db.prepare("DELETE FROM ssl_certificates").run();
}

export async function clearTlsState(db: EnvmanDatabase): Promise<void> {
  await db.prepare("DELETE FROM monitor_alert_user_states").run();
  await db.prepare("DELETE FROM monitor_alerts").run();
  await db.prepare("DELETE FROM monitor_alert_states").run();
  await db.prepare("DELETE FROM ssl_endpoint_web_entries").run();
  await db.prepare("DELETE FROM tls_endpoint_web_entries").run();
  await db.prepare("DELETE FROM ssl_endpoints").run();
  await db.prepare("DELETE FROM tls_endpoints").run();
  await db.prepare("DELETE FROM ssl_certificates").run();
  await db.prepare("DELETE FROM web_entries").run();
  await db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(SSL_ASSET_MIGRATION_ID);
}

export async function insertEnvironment(db: EnvmanDatabase, id: string, workspaceId: string, name: string, now: string): Promise<void> {
  await db.prepare(`
    INSERT INTO environments (id, workspace_type, workspace_id, name, short_name, description, status, owner, tags_json, sort_order, created_at, updated_at)
    VALUES (?, 'personal', ?, ?, '', '', 'active', '', '[]', 0, ?, ?)
  `).run(id, workspaceId, name, now, now);
}

export async function insertLegacyEndpoint(
  db: EnvmanDatabase,
  input: {
    id: string;
    environmentId: string;
    host: string;
    probeStatus: string;
    fingerprint?: string;
    probedAt?: string | null;
    now: string;
    webEntryId?: string;
  },
): Promise<void> {
  const fingerprint = input.fingerprint ?? "";
  const hasSnapshot = Boolean(fingerprint);
  await db.prepare(`
    INSERT INTO tls_endpoints (
      id, environment_id, ssh_bind_key, host, port, sni, source, observe_enabled, customized, sort_order,
      probe_status, probe_error, probed_at, leaf_cn, leaf_sans_json, issuer, serial, signature_algorithm,
      not_before, not_after, fingerprint_sha256, is_self_signed, created_at, updated_at
    ) VALUES (?, ?, '', ?, 443, ?, 'manual', 1, 0, 0, ?, '', ?, ?, '[]', 'Issuer', '1', 'sha256', ?, ?, ?, 0, ?, ?)
  `).run(
    input.id,
    input.environmentId,
    input.host,
    input.host,
    input.probeStatus,
    input.probedAt ?? (hasSnapshot ? input.now : null),
    hasSnapshot ? input.host : "",
    hasSnapshot ? input.now : null,
    hasSnapshot ? input.now : null,
    fingerprint,
    input.now,
    input.now,
  );
  if (input.webEntryId) {
    await db.prepare("INSERT INTO tls_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)").run(input.id, input.webEntryId);
  }
}

export async function insertWebEntry(db: EnvmanDatabase, id: string, environmentId: string, url: string, now: string): Promise<void> {
  await db.prepare(`
    INSERT INTO web_entries (id, environment_id, name, url, description, tags_json, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', '[]', 0, ?, ?)
  `).run(id, environmentId, id.slice(0, 8), url, now, now);
}

export async function countTable(db: EnvmanDatabase, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number | string };
  return Number(row.total);
}

export async function runSslMigrationBehaviorTests(db: EnvmanDatabase, workspaceId: string): Promise<void> {
  await clearTlsState(db);
  const now = new Date().toISOString();
  const envA = randomUUID();
  const envB = randomUUID();
  const okId = randomUUID();
  const failedId = randomUUID();
  const timeoutId = randomUUID();
  const neverId = randomUUID();
  const webA = randomUUID();
  const okFingerprint = fingerprintFor("ok");
  const failedFingerprint = fingerprintFor("failed");
  await insertEnvironment(db, envA, workspaceId, "A", now);
  await insertEnvironment(db, envB, workspaceId, "B", now);
  await insertWebEntry(db, webA, envA, "https://ok.example.com", now);
  await insertLegacyEndpoint(db, { id: okId, environmentId: envA, host: "ok.example.com", probeStatus: "ok", fingerprint: okFingerprint, now, webEntryId: webA });
  await insertLegacyEndpoint(db, { id: failedId, environmentId: envA, host: "failed.example.com", probeStatus: "connect_failed", fingerprint: failedFingerprint, now });
  await insertLegacyEndpoint(db, { id: timeoutId, environmentId: envB, host: "timeout.example.com", probeStatus: "timeout", fingerprint: fingerprintFor("timeout"), now });
  await insertLegacyEndpoint(db, { id: neverId, environmentId: envB, host: "never.example.com", probeStatus: "never", now });
  await resetSslTables(db);

  await migrateSslAssets(db);
  await migrateSslAssets(db);

  const okRow = await db.prepare("SELECT certificate_id, last_success_at, probe_status FROM ssl_endpoints WHERE id = ?").get(okId) as {
    certificate_id: string | null;
    last_success_at: string | null;
    probe_status: string;
  };
  expect(okRow.probe_status).toBe("ok");
  expect(okRow.certificate_id).toBeTruthy();
  expect(okRow.last_success_at).toBe(now);
  for (const id of [failedId, timeoutId, neverId]) {
    const row = await db.prepare("SELECT certificate_id, last_success_at FROM ssl_endpoints WHERE id = ?").get(id) as {
      certificate_id: string | null;
      last_success_at: string | null;
    };
    expect(row.certificate_id).toBeNull();
    expect(row.last_success_at).toBeNull();
  }
  expect(await countTable(db, "ssl_certificates")).toBe(1);
  expect(await countTable(db, "ssl_endpoints")).toBe(4);
  expect(await countTable(db, "ssl_endpoint_web_entries")).toBe(1);
  expect(await countTable(db, "tls_endpoints")).toBe(4);
  expect(await db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(SSL_ASSET_MIGRATION_ID)).toEqual({
    checksum: SSL_ASSET_MIGRATION_CHECKSUM,
  });
  const originalCertId = okRow.certificate_id;

  const failedAt = new Date(Date.parse(now) + 60_000).toISOString();
  await db.prepare(`
    UPDATE tls_endpoints
    SET probe_status = 'connect_failed', probe_error = 'connection refused', probed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(failedAt, failedAt, okId);
  await db.prepare(`
    UPDATE ssl_endpoints
    SET probe_status = 'connect_failed', probe_error = 'connection refused', probed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(failedAt, failedAt, okId);
  await migrateSslAssets(db);
  expect(await db.prepare(`
    SELECT certificate_id, last_success_at, probe_status FROM ssl_endpoints WHERE id = ?
  `).get(okId)).toEqual({
    certificate_id: originalCertId,
    last_success_at: now,
    probe_status: "connect_failed",
  });

  await db.prepare(`
    UPDATE tls_endpoints
    SET host = 'rotated.example.com', sni = 'rotated.example.com', updated_at = ?
    WHERE id = ?
  `).run(failedAt, okId);
  await migrateSslAssets(db);
  expect(await db.prepare(`
    SELECT host, certificate_id, last_success_at, probe_status FROM ssl_endpoints WHERE id = ?
  `).get(okId)).toEqual({
    host: "rotated.example.com",
    certificate_id: null,
    last_success_at: null,
    probe_status: "connect_failed",
  });

  const extraId = randomUUID();
  await insertLegacyEndpoint(db, {
    id: extraId,
    environmentId: envA,
    host: "extra.example.com",
    probeStatus: "ok",
    fingerprint: okFingerprint,
    now,
  });
  await migrateSslAssets(db);
  const extra = await db.prepare("SELECT id, certificate_id FROM ssl_endpoints WHERE id = ?").get(extraId) as { id: string; certificate_id: string };
  expect(extra.certificate_id).toBe(originalCertId);
  expect(await countTable(db, "ssl_endpoints")).toBe(5);
  expect(await countTable(db, "ssl_certificates")).toBe(1);
  expect(await db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(SSL_ASSET_MIGRATION_ID)).toEqual({
    checksum: SSL_ASSET_MIGRATION_CHECKSUM,
  });
}

export async function runDuplicateJunctionFailureTest(db: EnvmanDatabase, workspaceId: string): Promise<void> {
  await clearTlsState(db);
  const now = new Date().toISOString();
  const envId = randomUUID();
  const endpointA = randomUUID();
  const endpointB = randomUUID();
  const webId = randomUUID();
  await insertEnvironment(db, envId, workspaceId, "Dup", now);
  await insertWebEntry(db, webId, envId, "https://dup.example.com", now);
  await insertLegacyEndpoint(db, { id: endpointA, environmentId: envId, host: "dup-a.example.com", probeStatus: "never", now, webEntryId: webId });
  await insertLegacyEndpoint(db, { id: endpointB, environmentId: envId, host: "dup-b.example.com", probeStatus: "never", now, webEntryId: webId });
  await resetSslTables(db);
  const legacyEndpoints = await countTable(db, "tls_endpoints");
  const legacyLinks = await countTable(db, "tls_endpoint_web_entries");

  await expect(migrateSslAssets(db)).rejects.toMatchObject({
    name: "SslAssetMigrationError",
    code: "SSL_ASSET_MIGRATION_FAILED",
  });
  try {
    await migrateSslAssets(db);
  } catch (error) {
    expect(error).toBeInstanceOf(SslAssetMigrationError);
    const details = (error as SslAssetMigrationError).details.rowIds;
    expect(details).toEqual(expect.arrayContaining([`${endpointA}:${webId}`, `${endpointB}:${webId}`]));
  }
  expect(await db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(SSL_ASSET_MIGRATION_ID)).toBeUndefined();
  expect(await countTable(db, "tls_endpoints")).toBe(legacyEndpoints);
  expect(await countTable(db, "tls_endpoint_web_entries")).toBe(legacyLinks);
  expect(await countTable(db, "ssl_endpoints")).toBe(0);
  expect(await countTable(db, "ssl_certificates")).toBe(0);
  expect(await countTable(db, "ssl_endpoint_web_entries")).toBe(0);
}
