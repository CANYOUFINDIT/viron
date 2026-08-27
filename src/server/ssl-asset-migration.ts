import { createHash } from "node:crypto";
import type { EnvmanDatabase } from "./database-client.js";
import { canonicalFingerprint } from "../shared/tls-certificates.js";

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
  source: "web_entry" | "manual";
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

function flag(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  return Number(value) ? 1 : 0;
}

async function migrationApplied(db: EnvmanDatabase): Promise<boolean> {
  const row = await db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(SSL_ASSET_MIGRATION_ID) as { checksum: string } | undefined;
  if (!row) return false;
  if (row.checksum !== SSL_ASSET_MIGRATION_CHECKSUM) {
    throw new SslAssetMigrationError(`schema_migrations checksum mismatch for ${SSL_ASSET_MIGRATION_ID}`);
  }
  return true;
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

async function backfill(db: EnvmanDatabase): Promise<void> {
  const endpoints = await db.prepare(`
    SELECT e.*, env.workspace_type, env.workspace_id
    FROM tls_endpoints e
    LEFT JOIN environments env ON env.id = e.environment_id
    ORDER BY e.created_at, e.id
  `).all() as LegacyEndpointRow[];
  const missingEnvironment = endpoints.filter((row) => !row.workspace_type || row.workspace_id == null);
  if (missingEnvironment.length) {
    throw new SslAssetMigrationError("tls_endpoints 缺少可派生的工作空间", missingEnvironment.map((row) => row.id));
  }

  const certificateIds = new Map<string, string>();
  for (const row of endpoints) {
    const fingerprint = canonicalFingerprint(row.fingerprint_sha256 ?? "");
    const seenAt = row.probed_at || row.updated_at || row.created_at;
    let certificateId: string | null = null;
    if (fingerprint && row.not_before && row.not_after) {
      const cacheKey = `${row.workspace_type}:${row.workspace_id}:${fingerprint}`;
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
    }
    const lastSuccessAt = fingerprint && row.probe_status === "ok" ? row.probed_at : fingerprint ? row.probed_at : null;
    await db.prepare(`
      INSERT INTO ssl_endpoints (
        id, environment_id, certificate_id, ssh_connection_id, ssh_bind_key, host, port, sni, source,
        observe_enabled, customized, sort_order, probe_status, probe_error, probed_at, last_success_at,
        hostname_match, chain_complete, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const links = await db.prepare(`
    SELECT l.endpoint_id, l.web_entry_id, e.environment_id AS endpoint_environment_id, w.environment_id AS entry_environment_id
    FROM tls_endpoint_web_entries l
    JOIN tls_endpoints e ON e.id = l.endpoint_id
    JOIN web_entries w ON w.id = l.web_entry_id
  `).all() as Array<{ endpoint_id: string; web_entry_id: string; endpoint_environment_id: string; entry_environment_id: string }>;
  const invalidLinks = links.filter((row) => row.endpoint_environment_id !== row.entry_environment_id);
  if (invalidLinks.length) {
    throw new SslAssetMigrationError("tls_endpoint_web_entries 存在跨环境关联", invalidLinks.map((row) => `${row.endpoint_id}:${row.web_entry_id}`));
  }
  const seenEntries = new Set<string>();
  for (const row of links) {
    if (seenEntries.has(row.web_entry_id)) continue;
    seenEntries.add(row.web_entry_id);
    await db.prepare("INSERT INTO ssl_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)").run(row.endpoint_id, row.web_entry_id);
  }
}

async function validate(db: EnvmanDatabase): Promise<void> {
  const oldEndpoints = await db.prepare("SELECT COUNT(*) AS total FROM tls_endpoints").get() as { total: number | string };
  const newEndpoints = await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints").get() as { total: number | string };
  if (Number(oldEndpoints.total) !== Number(newEndpoints.total)) {
    throw new SslAssetMigrationError(`endpoint 数量不一致: tls=${oldEndpoints.total} ssl=${newEndpoints.total}`);
  }
  const oldLinks = await db.prepare("SELECT COUNT(DISTINCT web_entry_id) AS total FROM tls_endpoint_web_entries").get() as { total: number | string };
  const newLinks = await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoint_web_entries").get() as { total: number | string };
  if (Number(oldLinks.total) !== Number(newLinks.total)) {
    throw new SslAssetMigrationError(`web entry 关联数量不一致: tls=${oldLinks.total} ssl=${newLinks.total}`);
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
  if (await migrationApplied(db)) return;
  const existing = await db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints").get() as { total: number | string };
  try {
    await db.transaction(async () => {
      if (Number(existing.total) === 0) await backfill(db);
      else {
        const oldEndpoints = await db.prepare("SELECT COUNT(*) AS total FROM tls_endpoints").get() as { total: number | string };
        if (Number(oldEndpoints.total) !== Number(existing.total)) {
          throw new SslAssetMigrationError("中断的 ssl_endpoints 回填与旧表数量不一致，拒绝激活");
        }
      }
      await validate(db);
      await db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)").run(
        SSL_ASSET_MIGRATION_ID,
        SSL_ASSET_MIGRATION_CHECKSUM,
        new Date().toISOString(),
      );
    })();
  } catch (error) {
    if (Number(existing.total) === 0) {
      await db.prepare("DELETE FROM ssl_endpoint_web_entries").run();
      await db.prepare("DELETE FROM ssl_endpoints").run();
      await db.prepare("DELETE FROM ssl_certificates").run();
    }
    throw error;
  }
}
