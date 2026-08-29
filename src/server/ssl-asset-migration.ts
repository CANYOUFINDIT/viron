import { createHash } from "node:crypto";
import type { EnvmanDatabase } from "./database-client.js";
import {
  canonicalFingerprint,
  isTlsEndpointSource,
  isTlsProbeStatus,
  isForbiddenTlsProbeTarget,
  isValidTlsHost,
  isValidTlsPort,
  isValidTlsSni,
  normalizeTlsHost,
  parseHttpsOrigin,
} from "../shared/tls-certificates.js";

export const SSL_ASSET_MIGRATION_ID = "20260827_ssl_asset_v1";
export const SSL_ASSET_MIGRATION_CHECKSUM = createHash("sha256")
  .update(`${SSL_ASSET_MIGRATION_ID}:ssl_certificates+ssl_endpoints+ssl_endpoint_web_entries`)
  .digest("hex");

export class SslAssetMigrationError extends Error {
  readonly code = "SSL_ASSET_MIGRATION_FAILED";
  readonly details: { rowIds: string[] };

  constructor(message: string, rowIds: string[] = []) {
    super(message);
    this.name = "SslAssetMigrationError";
    this.details = { rowIds };
  }
}

interface LegacyEndpointRow {
  id: string;
  environment_id: string;
  ssh_connection_id: string | null;
  ssh_bind_key: string;
  host: string;
  port: number | string;
  sni: string;
  source: string;
  observe_enabled: number | string;
  customized: number | string;
  sort_order: number | string;
  probe_status: string;
  probe_error: string;
  probed_at: string | null;
  leaf_cn: string;
  leaf_sans_json: string;
  issuer: string;
  serial: string;
  signature_algorithm: string;
  not_before: string | null;
  not_after: string | null;
  fingerprint_sha256: string;
  is_self_signed: number | string;
  hostname_match: number | string | null;
  chain_complete: number | string | null;
  created_at: string;
  updated_at: string;
  workspace_type: string | null;
  workspace_id: string | null;
}

interface LegacyLinkRow {
  endpoint_id: string;
  web_entry_id: string;
  endpoint_environment_id: string;
  entry_environment_id: string;
}

interface ExistingSslEndpointRow {
  id: string;
  environment_id: string;
  certificate_id: string | null;
  ssh_bind_key: string;
  host: string;
  port: number | string;
  sni: string;
  last_success_at: string | null;
  certificate_workspace_type: string | null;
  certificate_workspace_id: string | null;
}

interface UnlinkedWebEntryRow {
  id: string;
  environment_id: string;
  url: string;
}

function flag(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  return Number(value) ? 1 : 0;
}

function countTotal(row: { total: number | string } | undefined): number {
  return Number(row?.total ?? 0);
}

function isStorageBoolean(value: number | string | null, nullable = false): boolean {
  if (nullable && value == null) return true;
  return value === 0 || value === 1 || value === "0" || value === "1";
}

function legacyEndpointHasValidDomain(row: LegacyEndpointRow): boolean {
  const port = Number(row.port);
  return (row.workspace_type === "personal" || row.workspace_type === "organization")
    && isTlsEndpointSource(row.source)
    && isTlsProbeStatus(row.probe_status)
    && isValidTlsHost(row.host)
    && isValidTlsPort(port)
    && isValidTlsSni(row.sni ?? "")
    && isStorageBoolean(row.observe_enabled)
    && isStorageBoolean(row.customized)
    && isStorageBoolean(row.is_self_signed)
    && isStorageBoolean(row.hostname_match, true)
    && isStorageBoolean(row.chain_complete, true);
}

function endpointIdentityMatches(row: LegacyEndpointRow, existing: ExistingSslEndpointRow): boolean {
  return row.environment_id === existing.environment_id
    && (row.ssh_bind_key ?? "") === (existing.ssh_bind_key ?? "")
    && row.host === existing.host
    && Number(row.port) === Number(existing.port)
    && (row.sni ?? "") === (existing.sni ?? "");
}

async function migrationApplied(db: EnvmanDatabase): Promise<boolean> {
  const row = await db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(SSL_ASSET_MIGRATION_ID) as { checksum: string } | undefined;
  if (!row) return false;
  if (row.checksum !== SSL_ASSET_MIGRATION_CHECKSUM) {
    throw new SslAssetMigrationError(`schema_migrations checksum mismatch for ${SSL_ASSET_MIGRATION_ID}`);
  }
  return true;
}

async function wipeNewTables(db: EnvmanDatabase): Promise<void> {
  await db.prepare("DELETE FROM ssl_endpoint_web_entries").run();
  await db.prepare("DELETE FROM ssl_endpoints").run();
  await db.prepare("DELETE FROM ssl_certificates").run();
}

async function recoverMigratedEndpointAlerts(db: EnvmanDatabase, environmentId: string, endpointId: string, now: string): Promise<void> {
  await db.prepare(`
    UPDATE monitor_alerts SET status = 'recovered', recovered_at = ?, updated_at = ?
    WHERE environment_id = ? AND target_type = 'tls_endpoint' AND target_id = ? AND status = 'active'
  `).run(now, now, environmentId, endpointId);
  await db.prepare("DELETE FROM monitor_alert_states WHERE environment_id = ? AND target_type = 'tls_endpoint' AND target_id = ?")
    .run(environmentId, endpointId);
}

async function upsertCertificate(
  db: EnvmanDatabase,
  input: {
    workspaceType: string;
    workspaceId: string;
    fingerprint: string;
    leafCn: string;
    leafSansJson: string;
    issuer: string;
    serial: string;
    signatureAlgorithm: string;
    notBefore: string;
    notAfter: string;
    isSelfSigned: number;
    seenAt: string;
  },
): Promise<string> {
  const existing = await db.prepare(`
    SELECT id FROM ssl_certificates
    WHERE workspace_type = ? AND workspace_id = ? AND fingerprint_sha256 = ?
  `).get(input.workspaceType, input.workspaceId, input.fingerprint) as { id: string } | undefined;
  if (existing) {
    await db.prepare(`
      UPDATE ssl_certificates SET
        leaf_cn = ?, leaf_sans_json = ?, issuer = ?, serial = ?, signature_algorithm = ?,
        not_before = ?, not_after = ?, is_self_signed = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.leafCn, input.leafSansJson, input.issuer, input.serial, input.signatureAlgorithm,
      input.notBefore, input.notAfter, input.isSelfSigned, input.seenAt, input.seenAt, existing.id,
    );
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO ssl_certificates (
      id, workspace_type, workspace_id, fingerprint_sha256, leaf_cn, leaf_sans_json, issuer, serial,
      signature_algorithm, not_before, not_after, is_self_signed, first_seen_at, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.workspaceType, input.workspaceId, input.fingerprint, input.leafCn, input.leafSansJson,
    input.issuer, input.serial, input.signatureAlgorithm, input.notBefore, input.notAfter, input.isSelfSigned,
    input.seenAt, input.seenAt, input.seenAt, input.seenAt,
  );
  return id;
}

function duplicateJunctionIds(links: LegacyLinkRow[]): string[] {
  const byEntry = new Map<string, string[]>();
  for (const row of links) {
    const items = byEntry.get(row.web_entry_id) ?? [];
    items.push(`${row.endpoint_id}:${row.web_entry_id}`);
    byEntry.set(row.web_entry_id, items);
  }
  return [...byEntry.values()].filter((items) => items.length > 1).flat();
}

async function loadLegacyEndpoints(db: EnvmanDatabase): Promise<LegacyEndpointRow[]> {
  return await db.prepare(`
    SELECT e.*, env.workspace_type, env.workspace_id
    FROM tls_endpoints e
    LEFT JOIN environments env ON env.id = e.environment_id
    ORDER BY e.created_at, e.id
  `).all() as LegacyEndpointRow[];
}

async function loadLegacyLinks(db: EnvmanDatabase): Promise<LegacyLinkRow[]> {
  return await db.prepare(`
    SELECT l.endpoint_id, l.web_entry_id, e.environment_id AS endpoint_environment_id, w.environment_id AS entry_environment_id
    FROM tls_endpoint_web_entries l
    JOIN tls_endpoints e ON e.id = l.endpoint_id
    JOIN web_entries w ON w.id = l.web_entry_id
  `).all() as LegacyLinkRow[];
}

async function backfillHttpsWebEntryEndpoints(db: EnvmanDatabase): Promise<void> {
  const entries = await db.prepare(`
    SELECT w.id, w.environment_id, w.url
    FROM web_entries w
    LEFT JOIN tls_endpoint_web_entries l ON l.web_entry_id = w.id
    WHERE l.web_entry_id IS NULL
    ORDER BY w.created_at, w.id
  `).all() as UnlinkedWebEntryRow[];

  for (const entry of entries) {
    const origin = parseHttpsOrigin(entry.url);
    if (!origin || isForbiddenTlsProbeTarget(origin.host)) continue;

    const existing = await db.prepare(`
      SELECT id FROM tls_endpoints
      WHERE environment_id = ? AND host = ? AND port = ? AND sni = ?
      ORDER BY CASE WHEN ssh_connection_id IS NULL THEN 1 ELSE 0 END, updated_at DESC
    `).get(entry.environment_id, origin.host, origin.port, origin.sni) as { id: string } | undefined;

    let endpointId = existing?.id;
    if (!endpointId) {
      const sshHosts = await db.prepare(`
        SELECT c.id, c.host FROM ssh_connections c
        JOIN ssh_connection_environments ce ON ce.connection_id = c.id
        WHERE ce.environment_id = ? AND c.source_deleted = 0
      `).all(entry.environment_id) as Array<{ id: string; host: string }>;
      const matchingSshHosts = sshHosts.filter((item) => normalizeTlsHost(item.host) === origin.host);
      const sshConnectionId = matchingSshHosts.length === 1 ? matchingSshHosts[0]!.id : null;
      const nextOrder = await db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM tls_endpoints WHERE environment_id = ?
      `).get(entry.environment_id) as { next_sort_order: number | string };
      endpointId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.prepare(`
        INSERT INTO tls_endpoints (
          id, environment_id, ssh_connection_id, ssh_bind_key, host, port, sni, source,
          observe_enabled, customized, sort_order, probe_status, probe_error, leaf_sans_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'web_entry', 1, 0, ?, 'never', '', '[]', ?, ?)
      `).run(
        endpointId,
        entry.environment_id,
        sshConnectionId,
        sshConnectionId ?? "",
        origin.host,
        origin.port,
        origin.sni,
        Number(nextOrder.next_sort_order),
        now,
        now,
      );
    }

    await db.prepare("INSERT INTO tls_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)")
      .run(endpointId, entry.id);
  }
}

async function upsertEndpoint(
  db: EnvmanDatabase,
  row: LegacyEndpointRow,
  certificateId: string | null,
  lastSuccessAt: string | null,
): Promise<void> {
  await db.prepare(`
    INSERT INTO ssl_endpoints (
      id, environment_id, certificate_id, ssh_connection_id, ssh_bind_key, host, port, sni, source,
      observe_enabled, customized, sort_order, probe_status, probe_error, probed_at, last_success_at,
      hostname_match, chain_complete, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      environment_id = excluded.environment_id,
      certificate_id = excluded.certificate_id,
      ssh_connection_id = excluded.ssh_connection_id,
      ssh_bind_key = excluded.ssh_bind_key,
      host = excluded.host,
      port = excluded.port,
      sni = excluded.sni,
      source = excluded.source,
      observe_enabled = excluded.observe_enabled,
      customized = excluded.customized,
      sort_order = excluded.sort_order,
      probe_status = excluded.probe_status,
      probe_error = excluded.probe_error,
      probed_at = excluded.probed_at,
      last_success_at = excluded.last_success_at,
      hostname_match = excluded.hostname_match,
      chain_complete = excluded.chain_complete,
      updated_at = excluded.updated_at
  `).run(
    row.id,
    row.environment_id,
    certificateId,
    row.ssh_connection_id,
    row.ssh_bind_key ?? "",
    row.host,
    Number(row.port),
    row.sni ?? "",
    row.source,
    Number(row.observe_enabled) ? 1 : 0,
    Number(row.customized) ? 1 : 0,
    Number(row.sort_order),
    row.probe_status,
    row.probe_error ?? "",
    row.probed_at,
    lastSuccessAt,
    flag(row.hostname_match),
    flag(row.chain_complete),
    row.created_at,
    row.updated_at,
  );
}

async function reconcile(db: EnvmanDatabase, applied: boolean): Promise<void> {
  const endpoints = await loadLegacyEndpoints(db);
  const missingEnvironment = endpoints.filter((row) => !row.workspace_type || row.workspace_id == null);
  if (missingEnvironment.length) {
    throw new SslAssetMigrationError("tls_endpoints 缺少可派生的工作空间", missingEnvironment.map((row) => row.id));
  }
  const invalidDomainRows = endpoints.filter((row) => !legacyEndpointHasValidDomain(row));
  if (invalidDomainRows.length) {
    throw new SslAssetMigrationError("tls_endpoints 存在非法领域值", invalidDomainRows.map((row) => row.id));
  }

  const links = await loadLegacyLinks(db);
  const invalidLinks = links.filter((row) => row.endpoint_environment_id !== row.entry_environment_id);
  if (invalidLinks.length) {
    throw new SslAssetMigrationError("tls_endpoint_web_entries 存在跨环境关联", invalidLinks.map((row) => `${row.endpoint_id}:${row.web_entry_id}`));
  }
  const duplicateLinks = duplicateJunctionIds(links);
  if (duplicateLinks.length) {
    throw new SslAssetMigrationError("tls_endpoint_web_entries 存在同一 Web 入口关联多个端点", duplicateLinks);
  }

  const certificateIds = new Map<string, string>();
  const seenEndpointIds = new Set<string>();
  const existingRows = await db.prepare(`
    SELECT e.id, e.environment_id, e.certificate_id, e.ssh_bind_key, e.host, e.port, e.sni, e.last_success_at,
      cert.workspace_type AS certificate_workspace_type, cert.workspace_id AS certificate_workspace_id
    FROM ssl_endpoints e
    LEFT JOIN ssl_certificates cert ON cert.id = e.certificate_id
  `).all() as ExistingSslEndpointRow[];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  for (const row of endpoints) {
    seenEndpointIds.add(row.id);
    const fingerprint = canonicalFingerprint(row.fingerprint_sha256 ?? "");
    const probeOk = row.probe_status === "ok";
    let certificateId: string | null = null;
    let lastSuccessAt: string | null = null;
    if (probeOk && fingerprint && row.not_before && row.not_after) {
      const cacheKey = `${row.workspace_type}:${row.workspace_id}:${fingerprint}`;
      const seenAt = row.probed_at || row.updated_at || row.created_at;
      certificateId = certificateIds.get(cacheKey) ?? await upsertCertificate(db, {
        workspaceType: row.workspace_type!,
        workspaceId: row.workspace_id!,
        fingerprint,
        leafCn: row.leaf_cn ?? "",
        leafSansJson: row.leaf_sans_json || "[]",
        issuer: row.issuer ?? "",
        serial: row.serial ?? "",
        signatureAlgorithm: row.signature_algorithm ?? "",
        notBefore: row.not_before,
        notAfter: row.not_after,
        isSelfSigned: flag(row.is_self_signed) ?? 0,
        seenAt,
      });
      certificateIds.set(cacheKey, certificateId);
      lastSuccessAt = row.probed_at;
    } else if (applied) {
      const existing = existingById.get(row.id);
      if (existing
        && endpointIdentityMatches(row, existing)
        && existing.certificate_id
        && existing.last_success_at
        && existing.certificate_workspace_type === row.workspace_type
        && existing.certificate_workspace_id === row.workspace_id) {
        certificateId = existing.certificate_id;
        lastSuccessAt = existing.last_success_at;
      }
    }
    await upsertEndpoint(db, row, certificateId, lastSuccessAt);
  }

  const extras = await db.prepare("SELECT id, environment_id FROM ssl_endpoints").all() as Array<{ id: string; environment_id: string }>;
  const now = new Date().toISOString();
  for (const row of extras) {
    if (seenEndpointIds.has(row.id)) continue;
    await recoverMigratedEndpointAlerts(db, row.environment_id, row.id, now);
    await db.prepare("DELETE FROM ssl_endpoints WHERE id = ?").run(row.id);
  }

  await db.prepare("DELETE FROM ssl_endpoint_web_entries").run();
  for (const row of links) {
    await db.prepare("INSERT INTO ssl_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)").run(row.endpoint_id, row.web_entry_id);
  }
}

async function validate(db: EnvmanDatabase, applied: boolean): Promise<void> {
  const oldEndpoints = await db.prepare("SELECT COUNT(*) AS total FROM tls_endpoints").get() as { total: number | string };
  const newEndpoints = await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints").get() as { total: number | string };
  if (countTotal(oldEndpoints) !== countTotal(newEndpoints)) {
    throw new SslAssetMigrationError(`endpoint 数量不一致: tls=${oldEndpoints.total} ssl=${newEndpoints.total}`);
  }
  const oldLinks = await db.prepare("SELECT COUNT(*) AS total FROM tls_endpoint_web_entries").get() as { total: number | string };
  const newLinks = await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoint_web_entries").get() as { total: number | string };
  if (countTotal(oldLinks) !== countTotal(newLinks)) {
    throw new SslAssetMigrationError(`web entry 关联数量不一致: tls=${oldLinks.total} ssl=${newLinks.total}`);
  }

  const mappings = await db.prepare(`
    SELECT e.id, e.probe_status, e.fingerprint_sha256, se.certificate_id, se.last_success_at,
      cert.fingerprint_sha256 AS cert_fingerprint
    FROM tls_endpoints e
    JOIN ssl_endpoints se ON se.id = e.id
    LEFT JOIN ssl_certificates cert ON cert.id = se.certificate_id
  `).all() as Array<{
    id: string;
    probe_status: string;
    fingerprint_sha256: string;
    certificate_id: string | null;
    last_success_at: string | null;
    cert_fingerprint: string | null;
  }>;
  const mappingFailures: string[] = [];
  for (const row of mappings) {
    const fingerprint = canonicalFingerprint(row.fingerprint_sha256 ?? "");
    if (row.probe_status === "ok" && fingerprint) {
      if (!row.certificate_id || canonicalFingerprint(row.cert_fingerprint ?? "") !== fingerprint) {
        mappingFailures.push(row.id);
      }
    } else {
      const hasRetainedSnapshot = Boolean(row.certificate_id || row.last_success_at);
      const retainedSnapshotValid = applied
        && Boolean(row.certificate_id)
        && Boolean(row.last_success_at)
        && Boolean(fingerprint)
        && canonicalFingerprint(row.cert_fingerprint ?? "") === fingerprint;
      if (hasRetainedSnapshot && !retainedSnapshotValid) mappingFailures.push(row.id);
    }
  }
  if (mappingFailures.length) {
    throw new SslAssetMigrationError("成功探测指纹未正确映射，或失败行的最后成功快照不完整", mappingFailures);
  }

  const duplicateFingerprints = await db.prepare(`
    SELECT workspace_type, workspace_id, fingerprint_sha256
    FROM ssl_certificates
    GROUP BY workspace_type, workspace_id, fingerprint_sha256
    HAVING COUNT(*) > 1
  `).all() as Array<{ workspace_type: string; workspace_id: string; fingerprint_sha256: string }>;
  if (duplicateFingerprints.length) {
    throw new SslAssetMigrationError(
      "ssl_certificates 工作空间指纹唯一约束被破坏",
      duplicateFingerprints.map((row) => `${row.workspace_type}:${row.workspace_id}:${row.fingerprint_sha256}`),
    );
  }

  const oldWorkspaceCounts = await db.prepare(`
    SELECT env.workspace_type, env.workspace_id, COUNT(*) AS total
    FROM tls_endpoints e
    JOIN environments env ON env.id = e.environment_id
    GROUP BY env.workspace_type, env.workspace_id
    ORDER BY env.workspace_type, env.workspace_id
  `).all() as Array<{ workspace_type: string; workspace_id: string; total: number | string }>;
  const newWorkspaceCounts = await db.prepare(`
    SELECT env.workspace_type, env.workspace_id, COUNT(*) AS total
    FROM ssl_endpoints e
    JOIN environments env ON env.id = e.environment_id
    GROUP BY env.workspace_type, env.workspace_id
    ORDER BY env.workspace_type, env.workspace_id
  `).all() as Array<{ workspace_type: string; workspace_id: string; total: number | string }>;
  if (JSON.stringify(oldWorkspaceCounts.map((row) => ({ ...row, total: countTotal(row) })))
    !== JSON.stringify(newWorkspaceCounts.map((row) => ({ ...row, total: countTotal(row) })))) {
    throw new SslAssetMigrationError("按工作空间的 endpoint 计数不一致");
  }

  if (db.dialect === "sqlite") {
    const violations = await db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number }>;
    const sslViolations = violations.filter((row) => String(row.table).startsWith("ssl_"));
    if (sslViolations.length) {
      throw new SslAssetMigrationError("ssl_* foreign_key_check 失败", sslViolations.map((row) => `${row.table}:${row.rowid}`));
    }
  }
}

export async function migrateSslAssets(db: EnvmanDatabase): Promise<void> {
  const applied = await migrationApplied(db);
  try {
    await db.transaction(async () => {
      await backfillHttpsWebEntryEndpoints(db);
      await reconcile(db, applied);
      await validate(db, applied);
      if (!applied) {
        await db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)").run(
          SSL_ASSET_MIGRATION_ID,
          SSL_ASSET_MIGRATION_CHECKSUM,
          new Date().toISOString(),
        );
      }
    })();
  } catch (error) {
    if (!applied) await wipeNewTables(db);
    throw error;
  }
}
