import { randomUUID, X509Certificate } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { quotePosixShellArg } from "../shared/environment-log.js";
import {
  DEFAULT_TLS_WARN_DAYS,
  MAX_TLS_ENDPOINTS_PER_ENVIRONMENT,
  TLS_MANUAL_PROBE_COOLDOWN_MS,
  TLS_PROBE_MAX_BYTES,
  TLS_PROBE_TIMEOUT_MS,
  canonicalFingerprint,
  classifyTlsProbeFailure,
  deriveCertificateStatus,
  hostnameMatchesCertificate,
  isForbiddenTlsProbeTarget,
  isValidTlsHost,
  isValidTlsPort,
  isValidTlsSni,
  looksLikeIpAddress,
  normalizeFingerprint,
  normalizeTlsHost,
  opensslVerifyOk,
  parseHttpsOrigin,
  parseSubjectAltNames,
  parseSubjectCommonName,
  tlsConnectTarget,
  tlsDaysRemaining,
  tlsEndpointIsStale,
  tlsProbeDueAt,
  tlsWebEntryBadge,
  type SslCertificateAsset,
  type SslCertificateStatus,
  type TlsCertificateSnapshot,
  type TlsEndpoint,
  type TlsEndpointSource,
  type TlsHttpsOrigin,
  type TlsProbeResult,
  type TlsProbeStatus,
  type TlsWebEntryBadge,
  type TlsWebEntryLink,
} from "../shared/tls-certificates.js";
import { isUniqueConstraintError } from "./database-errors.js";
import { executeSshCommand } from "./ssh/command.js";
import { evaluateTlsEndpointAlerts } from "./monitor-alerts.js";

export class TlsCertificateError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "TlsCertificateError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface SslEndpointRow {
  id: string;
  environment_id: string;
  certificate_id: string | null;
  ssh_connection_id: string | null;
  ssh_bind_key: string;
  host: string;
  port: number | string;
  sni: string;
  source: TlsEndpointSource;
  observe_enabled: number | string;
  customized: number | string;
  sort_order: number | string;
  probe_status: TlsProbeStatus;
  probe_error: string;
  probed_at: string | null;
  last_success_at: string | null;
  hostname_match: number | string | null;
  chain_complete: number | string | null;
  created_at: string;
  updated_at: string;
  connection_name?: string | null;
  ssh_host?: string | null;
  leaf_cn?: string | null;
  leaf_sans_json?: string | null;
  issuer?: string | null;
  serial?: string | null;
  signature_algorithm?: string | null;
  not_before?: string | null;
  not_after?: string | null;
  fingerprint_sha256?: string | null;
  is_self_signed?: number | string | null;
}

const probing = new Set<string>();
const lastManualProbe = new Map<string, number>();
const sshProbeTail = new Map<string, Promise<unknown>>();
let globalProbeCount = 0;

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function nullableFlag(value: number | string | null | undefined): boolean | null {
  if (value == null || value === "") return null;
  return Boolean(Number(value));
}

export function buildTlsProbeCommand(host: string, port: number, sni: string): string {
  const args = ["openssl", "s_client", "-connect", quotePosixShellArg(tlsConnectTarget(host, port)), "-showcerts"];
  if (sni) args.push("-servername", quotePosixShellArg(sni));
  return args.join(" ");
}

export function extractLeafCertificatePem(text: string): string | null {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text);
  return match?.[0] ?? null;
}

export function parseTlsCertificatePem(pem: string, hostname = "", now = Date.now()): TlsCertificateSnapshot {
  const cert = new X509Certificate(pem);
  const leafCn = parseSubjectCommonName(cert.subject);
  const leafSans = parseSubjectAltNames(cert.subjectAltName);
  const notAfter = new Date(cert.validTo).toISOString();
  const notBefore = new Date(cert.validFrom).toISOString();
  const fingerprintSha256 = canonicalFingerprint(cert.fingerprint256) ?? normalizeFingerprint(cert.fingerprint256);
  const matchHost = hostname || leafCn;
  return {
    leafCn,
    leafSans,
    issuer: parseSubjectCommonName(cert.issuer) || cert.issuer,
    serial: cert.serialNumber,
    signatureAlgorithm: String((cert as { sigAlg?: string }).sigAlg ?? ""),
    notBefore,
    notAfter,
    fingerprintSha256,
    isSelfSigned: cert.subject === cert.issuer,
    hostnameMatch: matchHost ? hostnameMatchesCertificate(matchHost, leafCn, leafSans) : null,
    chainComplete: null,
    daysRemaining: tlsDaysRemaining(notAfter, now),
  };
}

export function parseTlsProbeOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  hostname: string,
  now = new Date().toISOString(),
): Omit<TlsProbeResult, "leafPem"> & { leafPem: string } {
  const combined = `${stdout}\n${stderr}`;
  const pem = extractLeafCertificatePem(combined);
  if (!pem) {
    return {
      status: classifyTlsProbeFailure(stdout, stderr, exitCode),
      error: (stderr || stdout).trim().slice(0, 500),
      probedAt: now,
      leafPem: "",
      leafCn: "",
      leafSans: [],
      issuer: "",
      serial: "",
      signatureAlgorithm: "",
      notBefore: null,
      notAfter: null,
      fingerprintSha256: "",
      isSelfSigned: false,
      hostnameMatch: null,
      chainComplete: opensslVerifyOk(combined),
      daysRemaining: null,
    };
  }
  const snapshot = parseTlsCertificatePem(pem, hostname, Date.parse(now));
  return {
    ...snapshot,
    status: "ok",
    error: "",
    probedAt: now,
    leafPem: pem,
    chainComplete: opensslVerifyOk(combined),
  };
}

function mapEndpoint(row: SslEndpointRow, webEntries: TlsWebEntryLink[] = [], warnDays = DEFAULT_TLS_WARN_DAYS): TlsEndpoint {
  const sshConnectionId = row.ssh_connection_id;
  const probeStatus = !sshConnectionId && row.probe_status !== "never" && row.probe_status !== "skipped"
    ? "probe_unavailable"
    : row.probe_status;
  const endpoint: TlsEndpoint = {
    id: row.id,
    environmentId: row.environment_id,
    certificateId: row.certificate_id,
    sshConnectionId,
    sshConnectionName: String(row.connection_name ?? ""),
    sshHost: String(row.ssh_host ?? ""),
    host: row.host,
    port: Number(row.port),
    sni: row.sni,
    source: row.source,
    observeEnabled: Boolean(Number(row.observe_enabled)),
    customized: Boolean(Number(row.customized)),
    sortOrder: Number(row.sort_order),
    probeStatus,
    probeError: sshConnectionId ? row.probe_error ?? "" : (row.probe_error || "SSH 连接已删除"),
    probedAt: row.probed_at,
    lastSuccessAt: row.last_success_at,
    leafCn: row.leaf_cn ?? "",
    leafSans: parseJsonArray(row.leaf_sans_json),
    issuer: row.issuer ?? "",
    serial: row.serial ?? "",
    signatureAlgorithm: row.signature_algorithm ?? "",
    notBefore: row.not_before ?? null,
    notAfter: row.not_after ?? null,
    fingerprintSha256: row.fingerprint_sha256 ?? "",
    isSelfSigned: Boolean(Number(row.is_self_signed ?? 0)),
    hostnameMatch: nullableFlag(row.hostname_match),
    chainComplete: nullableFlag(row.chain_complete),
    daysRemaining: tlsDaysRemaining(row.not_after),
    stale: false,
    webEntries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  endpoint.stale = tlsEndpointIsStale(endpoint, warnDays);
  return endpoint;
}

const ENDPOINT_SELECT = `
  SELECT e.id, e.environment_id, e.certificate_id, e.ssh_connection_id, e.ssh_bind_key, e.host, e.port, e.sni,
    e.source, e.observe_enabled, e.customized, e.sort_order, e.probe_status, e.probe_error, e.probed_at,
    e.last_success_at, e.hostname_match, e.chain_complete, e.created_at, e.updated_at,
    c.name AS connection_name, c.host AS ssh_host,
    cert.leaf_cn, cert.leaf_sans_json, cert.issuer, cert.serial, cert.signature_algorithm,
    cert.not_before, cert.not_after, cert.fingerprint_sha256, cert.is_self_signed
  FROM ssl_endpoints e
  LEFT JOIN ssh_connections c ON c.id = e.ssh_connection_id
  LEFT JOIN ssl_certificates cert ON cert.id = e.certificate_id
`;

async function environmentSshHosts(app: FastifyInstance, environmentId: string): Promise<Array<{ id: string; host: string; name: string }>> {
  return await app.db.prepare(`
    SELECT c.id, c.host, c.name FROM ssh_connections c
    JOIN ssh_connection_environments ce ON ce.connection_id = c.id
    WHERE ce.environment_id = ? AND c.source_deleted = 0
    ORDER BY ce.maintenance_sort_order, c.name, c.id
  `).all(environmentId) as Array<{ id: string; host: string; name: string }>;
}

function uniqueMatchingSshId(hosts: Array<{ id: string; host: string }>, hostname: string): string | null {
  const matches = hosts.filter((item) => normalizeTlsHost(item.host) === normalizeTlsHost(hostname));
  return matches.length === 1 ? matches[0]!.id : null;
}

async function environmentWorkspace(app: FastifyInstance, environmentId: string): Promise<{ workspaceType: string; workspaceId: string }> {
  const row = await app.db.prepare("SELECT workspace_type, workspace_id FROM environments WHERE id = ?").get(environmentId) as
    | { workspace_type: string; workspace_id: string }
    | undefined;
  if (!row) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  return { workspaceType: row.workspace_type, workspaceId: row.workspace_id };
}

async function endpointCount(app: FastifyInstance, environmentId: string): Promise<number> {
  const row = await app.db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoints WHERE environment_id = ?").get(environmentId) as { total: number | string };
  return Number(row.total);
}

export function validateTlsEndpointInput(input: { host: string; port: number; sni?: string; sshConnectionId?: string | null }): TlsHttpsOrigin & { sshConnectionId: string | null } {
  const host = normalizeTlsHost(input.host);
  if (!isValidTlsHost(host) || isForbiddenTlsProbeTarget(host)) throw new TlsCertificateError("INVALID_TLS_HOST", "证书探测主机无效");
  if (!isValidTlsPort(input.port)) throw new TlsCertificateError("INVALID_TLS_PORT", "证书探测端口无效");
  const sni = normalizeTlsHost(input.sni ?? "") || (looksLikeIpAddress(host) ? "" : host);
  if (!isValidTlsSni(sni)) throw new TlsCertificateError("INVALID_TLS_SNI", "SNI 只能使用域名");
  return { host, port: input.port, sni, sshConnectionId: input.sshConnectionId ?? null };
}

async function loadEndpointRow(app: FastifyInstance, endpointId: string): Promise<SslEndpointRow | undefined> {
  return await app.db.prepare(`${ENDPOINT_SELECT} WHERE e.id = ?`).get(endpointId) as SslEndpointRow | undefined;
}

async function webEntriesForEndpoints(app: FastifyInstance, endpointIds: string[]): Promise<Map<string, TlsWebEntryLink[]>> {
  const links = new Map<string, TlsWebEntryLink[]>();
  if (!endpointIds.length) return links;
  const placeholders = endpointIds.map(() => "?").join(", ");
  const rows = await app.db.prepare(`
    SELECT l.endpoint_id, w.id, w.name, w.url
    FROM ssl_endpoint_web_entries l
    JOIN web_entries w ON w.id = l.web_entry_id
    WHERE l.endpoint_id IN (${placeholders})
    ORDER BY w.sort_order, w.name
  `).all(...endpointIds) as Array<{ endpoint_id: string; id: string; name: string; url: string }>;
  for (const row of rows) {
    const items = links.get(row.endpoint_id) ?? [];
    items.push({ id: row.id, name: row.name, url: row.url });
    links.set(row.endpoint_id, items);
  }
  return links;
}

export async function listTlsEndpoints(app: FastifyInstance, environmentId: string): Promise<TlsEndpoint[]> {
  const rows = await app.db.prepare(`${ENDPOINT_SELECT} WHERE e.environment_id = ? ORDER BY e.sort_order, e.updated_at DESC, e.host`).all(environmentId) as SslEndpointRow[];
  const links = await webEntriesForEndpoints(app, rows.map((row) => row.id));
  return rows.map((row) => mapEndpoint(row, links.get(row.id) ?? []));
}

export async function getTlsEndpoint(app: FastifyInstance, endpointId: string): Promise<TlsEndpoint | null> {
  const row = await loadEndpointRow(app, endpointId);
  if (!row) return null;
  const links = await webEntriesForEndpoints(app, [endpointId]);
  return mapEndpoint(row, links.get(endpointId) ?? []);
}

async function findIdentityEndpoint(
  app: FastifyInstance,
  environmentId: string,
  origin: TlsHttpsOrigin,
  sshConnectionId: string | null,
): Promise<SslEndpointRow | undefined> {
  const bindKey = sshConnectionId ?? "";
  return await app.db.prepare(`
    SELECT * FROM ssl_endpoints
    WHERE environment_id = ? AND ssh_bind_key = ? AND host = ? AND port = ? AND sni = ?
  `).get(environmentId, bindKey, origin.host, origin.port, origin.sni) as SslEndpointRow | undefined;
}

async function findOriginEndpoints(
  app: FastifyInstance,
  environmentId: string,
  origin: TlsHttpsOrigin,
): Promise<SslEndpointRow[]> {
  return await app.db.prepare(`
    SELECT * FROM ssl_endpoints
    WHERE environment_id = ? AND host = ? AND port = ? AND sni = ?
    ORDER BY CASE WHEN ssh_connection_id IS NULL THEN 1 ELSE 0 END, updated_at DESC
  `).all(environmentId, origin.host, origin.port, origin.sni) as SslEndpointRow[];
}

async function insertLegacyEndpoint(
  app: FastifyInstance,
  input: {
    id: string;
    environmentId: string;
    origin: TlsHttpsOrigin;
    sshConnectionId: string | null;
    source: TlsEndpointSource;
    customized: boolean;
    observeEnabled: boolean;
    sortOrder: number;
    now: string;
  },
): Promise<void> {
  await app.db.prepare(`
    INSERT INTO tls_endpoints (
      id, environment_id, ssh_connection_id, ssh_bind_key, host, port, sni, source,
      observe_enabled, customized, sort_order, probe_status, probe_error, leaf_sans_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', '', '[]', ?, ?)
  `).run(
    input.id,
    input.environmentId,
    input.sshConnectionId,
    input.sshConnectionId ?? "",
    input.origin.host,
    input.origin.port,
    input.origin.sni,
    input.source,
    input.observeEnabled ? 1 : 0,
    input.customized ? 1 : 0,
    input.sortOrder,
    input.now,
    input.now,
  );
}

async function insertEndpoint(
  app: FastifyInstance,
  input: {
    environmentId: string;
    origin: TlsHttpsOrigin;
    sshConnectionId: string | null;
    source: TlsEndpointSource;
    customized?: boolean;
    observeEnabled?: boolean;
  },
): Promise<string> {
  if (await endpointCount(app, input.environmentId) >= MAX_TLS_ENDPOINTS_PER_ENVIRONMENT) {
    throw new TlsCertificateError("TLS_ENDPOINT_LIMIT", `每个环境最多观察 ${MAX_TLS_ENDPOINTS_PER_ENVIRONMENT} 个 TLS 端点`);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const observeEnabled = input.observeEnabled !== false;
  const nextOrder = await app.db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM ssl_endpoints WHERE environment_id = ?
  `).get(input.environmentId) as { next_sort_order: number | string };
  const sortOrder = Number(nextOrder.next_sort_order);
  try {
    await app.db.prepare(`
      INSERT INTO ssl_endpoints (
        id, environment_id, certificate_id, ssh_connection_id, ssh_bind_key, host, port, sni, source,
        observe_enabled, customized, sort_order, probe_status, probe_error, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', '', ?, ?)
    `).run(
      id,
      input.environmentId,
      input.sshConnectionId,
      input.sshConnectionId ?? "",
      input.origin.host,
      input.origin.port,
      input.origin.sni,
      input.source,
      observeEnabled ? 1 : 0,
      input.customized ? 1 : 0,
      sortOrder,
      now,
      now,
    );
    await insertLegacyEndpoint(app, {
      id,
      environmentId: input.environmentId,
      origin: input.origin,
      sshConnectionId: input.sshConnectionId,
      source: input.source,
      customized: Boolean(input.customized),
      observeEnabled,
      sortOrder,
      now,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new TlsCertificateError("TLS_ENDPOINT_EXISTS", "该 TLS 端点已经存在", 409);
    throw error;
  }
  return id;
}

export async function createTlsEndpoint(
  app: FastifyInstance,
  environmentId: string,
  input: { host: string; port: number; sni?: string; sshConnectionId?: string | null; observeEnabled?: boolean },
): Promise<string> {
  const origin = validateTlsEndpointInput(input);
  if (origin.sshConnectionId) {
    const hosts = await environmentSshHosts(app, environmentId);
    if (!hosts.some((item) => item.id === origin.sshConnectionId)) {
      throw new TlsCertificateError("TLS_SSH_NOT_IN_ENVIRONMENT", "只能绑定当前环境中的 SSH 连接");
    }
  }
  const existing = await findIdentityEndpoint(app, environmentId, origin, origin.sshConnectionId);
  if (existing) throw new TlsCertificateError("TLS_ENDPOINT_EXISTS", "该 TLS 端点已经存在", 409);
  let id = "";
  await app.db.transaction(async () => {
    id = await insertEndpoint(app, {
      environmentId,
      origin,
      sshConnectionId: origin.sshConnectionId,
      source: "manual",
      observeEnabled: input.observeEnabled !== false,
    });
  })();
  return id;
}

export async function updateTlsEndpoint(
  app: FastifyInstance,
  endpointId: string,
  input: { host: string; port: number; sni?: string; sshConnectionId?: string | null; observeEnabled?: boolean },
): Promise<TlsEndpoint> {
  const row = await loadEndpointRow(app, endpointId);
  if (!row) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  const origin = validateTlsEndpointInput(input);
  if (origin.sshConnectionId) {
    const hosts = await environmentSshHosts(app, row.environment_id);
    if (!hosts.some((item) => item.id === origin.sshConnectionId)) {
      throw new TlsCertificateError("TLS_SSH_NOT_IN_ENVIRONMENT", "只能绑定当前环境中的 SSH 连接");
    }
  }
  const identityChanged = row.host !== origin.host || Number(row.port) !== origin.port || row.sni !== origin.sni
    || (row.ssh_connection_id ?? "") !== (origin.sshConnectionId ?? "");
  if (identityChanged) {
    const existing = await findIdentityEndpoint(app, row.environment_id, origin, origin.sshConnectionId);
    if (existing && existing.id !== endpointId) throw new TlsCertificateError("TLS_ENDPOINT_EXISTS", "该 TLS 端点已经存在", 409);
  }
  const now = new Date().toISOString();
  const customized = row.source === "web_entry" && identityChanged ? 1 : Number(row.customized);
  const source = customized && row.source === "web_entry" ? "manual" : row.source;
  const bindKey = origin.sshConnectionId ?? "";
  const observeEnabled = input.observeEnabled === false ? 0 : 1;
  try {
    await app.db.transaction(async () => {
    if (identityChanged) {
      await app.db.prepare(`
        UPDATE ssl_endpoints SET
          ssh_connection_id = ?, ssh_bind_key = ?, host = ?, port = ?, sni = ?,
          observe_enabled = ?, customized = ?, source = ?,
          certificate_id = NULL, probe_status = 'never', probe_error = '',
          probed_at = NULL, last_success_at = NULL, hostname_match = NULL, chain_complete = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(
        origin.sshConnectionId,
        bindKey,
        origin.host,
        origin.port,
        origin.sni,
        observeEnabled,
        customized,
        source,
        now,
        endpointId,
      );
      await app.db.prepare(`
        UPDATE tls_endpoints SET
          ssh_connection_id = ?, ssh_bind_key = ?, host = ?, port = ?, sni = ?,
          observe_enabled = ?, customized = ?, source = ?,
          probe_status = 'never', probe_error = '', probed_at = NULL,
          leaf_cn = '', leaf_sans_json = '[]', issuer = '', serial = '', signature_algorithm = '',
          not_before = NULL, not_after = NULL, fingerprint_sha256 = '', is_self_signed = 0,
          hostname_match = NULL, chain_complete = NULL, days_remaining = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(
        origin.sshConnectionId,
        bindKey,
        origin.host,
        origin.port,
        origin.sni,
        observeEnabled,
        customized,
        source,
        now,
        endpointId,
      );
      return;
    }
    await app.db.prepare(`
      UPDATE ssl_endpoints SET
        ssh_connection_id = ?, ssh_bind_key = ?, host = ?, port = ?, sni = ?,
        observe_enabled = ?, customized = ?, source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      origin.sshConnectionId,
      bindKey,
      origin.host,
      origin.port,
      origin.sni,
      observeEnabled,
      customized,
      source,
      now,
      endpointId,
    );
    await app.db.prepare(`
      UPDATE tls_endpoints SET
        ssh_connection_id = ?, ssh_bind_key = ?, host = ?, port = ?, sni = ?,
        observe_enabled = ?, customized = ?, source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      origin.sshConnectionId,
      bindKey,
      origin.host,
      origin.port,
      origin.sni,
      observeEnabled,
      customized,
      source,
      now,
      endpointId,
    );
  })();
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new TlsCertificateError("TLS_ENDPOINT_EXISTS", "该 TLS 端点已经存在", 409);
    throw error;
  }
  const updated = await getTlsEndpoint(app, endpointId);
  if (!updated) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  return updated;
}

async function recoverEndpointAlerts(app: FastifyInstance, environmentId: string, endpointId: string): Promise<void> {
  const now = new Date().toISOString();
  await app.db.prepare(`
    UPDATE monitor_alerts SET status = 'recovered', recovered_at = ?, updated_at = ?
    WHERE environment_id = ? AND target_type = 'tls_endpoint' AND target_id = ? AND status = 'active'
  `).run(now, now, environmentId, endpointId);
  await app.db.prepare("DELETE FROM monitor_alert_states WHERE environment_id = ? AND target_type = 'tls_endpoint' AND target_id = ?")
    .run(environmentId, endpointId);
}

export async function deleteTlsEndpoint(app: FastifyInstance, endpointId: string): Promise<SslEndpointRow> {
  const row = await loadEndpointRow(app, endpointId);
  if (!row) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  await app.db.transaction(async () => {
    await recoverEndpointAlerts(app, row.environment_id, endpointId);
    await app.db.prepare("DELETE FROM ssl_endpoints WHERE id = ?").run(endpointId);
    await app.db.prepare("DELETE FROM tls_endpoints WHERE id = ?").run(endpointId);
  })();
  return row;
}

async function linkWebEntry(app: FastifyInstance, endpointId: string, webEntryId: string): Promise<void> {
  await app.db.prepare("DELETE FROM ssl_endpoint_web_entries WHERE web_entry_id = ?").run(webEntryId);
  await app.db.prepare("DELETE FROM tls_endpoint_web_entries WHERE web_entry_id = ?").run(webEntryId);
  await app.db.prepare("INSERT INTO ssl_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)").run(endpointId, webEntryId);
  await app.db.prepare("INSERT OR IGNORE INTO tls_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)").run(endpointId, webEntryId);
}

async function unlinkWebEntry(app: FastifyInstance, webEntryId: string): Promise<string[]> {
  const rows = await app.db.prepare("SELECT endpoint_id FROM ssl_endpoint_web_entries WHERE web_entry_id = ?").all(webEntryId) as Array<{ endpoint_id: string }>;
  await app.db.prepare("DELETE FROM ssl_endpoint_web_entries WHERE web_entry_id = ?").run(webEntryId);
  await app.db.prepare("DELETE FROM tls_endpoint_web_entries WHERE web_entry_id = ?").run(webEntryId);
  return rows.map((row) => row.endpoint_id);
}

async function cleanupOrphanWebEntryEndpoints(app: FastifyInstance, endpointIds: string[]): Promise<void> {
  for (const endpointId of endpointIds) {
    const row = await app.db.prepare("SELECT id, environment_id, source, customized FROM ssl_endpoints WHERE id = ?").get(endpointId) as
      | { id: string; environment_id: string; source: TlsEndpointSource; customized: number | string }
      | undefined;
    if (!row || row.source !== "web_entry" || Number(row.customized)) continue;
    const remaining = await app.db.prepare("SELECT COUNT(*) AS total FROM ssl_endpoint_web_entries WHERE endpoint_id = ?").get(endpointId) as { total: number | string };
    if (Number(remaining.total) === 0) {
      await recoverEndpointAlerts(app, row.environment_id, endpointId);
      await app.db.prepare("DELETE FROM ssl_endpoints WHERE id = ?").run(endpointId);
      await app.db.prepare("DELETE FROM tls_endpoints WHERE id = ?").run(endpointId);
    }
  }
}

export async function syncWebEntryTlsEndpoint(app: FastifyInstance, environmentId: string, webEntryId: string, url: string): Promise<string | null> {
  let linkedEndpointId: string | null = null;
  await app.db.transaction(async () => {
    const previous = await unlinkWebEntry(app, webEntryId);
    const origin = parseHttpsOrigin(url);
    if (!origin || isForbiddenTlsProbeTarget(origin.host)) {
      await cleanupOrphanWebEntryEndpoints(app, previous);
      return;
    }
    const existing = await findOriginEndpoints(app, environmentId, origin);
    let endpointId = existing[0]?.id;
    if (!endpointId) {
      const hosts = await environmentSshHosts(app, environmentId);
      endpointId = await insertEndpoint(app, {
        environmentId,
        origin,
        sshConnectionId: uniqueMatchingSshId(hosts, origin.host),
        source: "web_entry",
      });
    }
    await linkWebEntry(app, endpointId, webEntryId);
    linkedEndpointId = endpointId;
    await cleanupOrphanWebEntryEndpoints(app, previous.filter((id) => id !== endpointId));
  })();
  return linkedEndpointId;
}

export async function removeWebEntryTlsEndpoint(app: FastifyInstance, webEntryId: string): Promise<void> {
  await app.db.transaction(async () => {
    const previous = await unlinkWebEntry(app, webEntryId);
    await cleanupOrphanWebEntryEndpoints(app, previous);
  })();
}

export async function replaceEndpointWebEntries(app: FastifyInstance, endpointId: string, webEntryIds: string[]): Promise<TlsEndpoint> {
  const row = await loadEndpointRow(app, endpointId);
  if (!row) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  if (webEntryIds.length > 100) throw new TlsCertificateError("INVALID_WEB_ENTRY_IDS", "一次最多关联 100 个 Web 入口");
  const uniqueIds = [...new Set(webEntryIds)];
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const entries = await app.db.prepare(`
      SELECT id, environment_id FROM web_entries WHERE id IN (${placeholders})
    `).all(...uniqueIds) as Array<{ id: string; environment_id: string }>;
    if (entries.length !== uniqueIds.length || entries.some((item) => item.environment_id !== row.environment_id)) {
      throw new TlsCertificateError("INVALID_WEB_ENTRY_IDS", "只能关联同一环境中的 Web 入口");
    }
  }
  await app.db.transaction(async () => {
    const previous = await app.db.prepare("SELECT web_entry_id FROM ssl_endpoint_web_entries WHERE endpoint_id = ?").all(endpointId) as Array<{ web_entry_id: string }>;
    for (const item of previous) await unlinkWebEntry(app, item.web_entry_id);
    for (const webEntryId of uniqueIds) await linkWebEntry(app, endpointId, webEntryId);
  })();
  const updated = await getTlsEndpoint(app, endpointId);
  if (!updated) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  return updated;
}

async function upsertCertificate(
  app: FastifyInstance,
  workspaceType: string,
  workspaceId: string,
  snapshot: TlsCertificateSnapshot,
  seenAt: string,
): Promise<string | null> {
  const fingerprint = canonicalFingerprint(snapshot.fingerprintSha256);
  if (!fingerprint || !snapshot.notBefore || !snapshot.notAfter) return null;
  const existing = await app.db.prepare(`
    SELECT id FROM ssl_certificates WHERE workspace_type = ? AND workspace_id = ? AND fingerprint_sha256 = ?
  `).get(workspaceType, workspaceId, fingerprint) as { id: string } | undefined;
  if (existing) {
    await app.db.prepare(`
      UPDATE ssl_certificates SET
        leaf_cn = ?, leaf_sans_json = ?, issuer = ?, serial = ?, signature_algorithm = ?,
        not_before = ?, not_after = ?, is_self_signed = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      snapshot.leafCn, JSON.stringify(snapshot.leafSans), snapshot.issuer, snapshot.serial, snapshot.signatureAlgorithm,
      snapshot.notBefore, snapshot.notAfter, snapshot.isSelfSigned ? 1 : 0, seenAt, seenAt, existing.id,
    );
    return existing.id;
  }
  const id = randomUUID();
  try {
    await app.db.prepare(`
      INSERT INTO ssl_certificates (
        id, workspace_type, workspace_id, fingerprint_sha256, leaf_cn, leaf_sans_json, issuer, serial,
        signature_algorithm, not_before, not_after, is_self_signed, first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, workspaceType, workspaceId, fingerprint, snapshot.leafCn, JSON.stringify(snapshot.leafSans), snapshot.issuer,
      snapshot.serial, snapshot.signatureAlgorithm, snapshot.notBefore, snapshot.notAfter, snapshot.isSelfSigned ? 1 : 0,
      seenAt, seenAt, seenAt, seenAt,
    );
    return id;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await app.db.prepare(`
      SELECT id FROM ssl_certificates WHERE workspace_type = ? AND workspace_id = ? AND fingerprint_sha256 = ?
    `).get(workspaceType, workspaceId, fingerprint) as { id: string } | undefined;
    if (!raced) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书资产不存在", 404);
    return raced.id;
  }
}

async function persistProbe(app: FastifyInstance, endpointId: string, environmentId: string, result: ReturnType<typeof parseTlsProbeOutput>): Promise<void> {
  const now = result.probedAt;
  const workspace = await environmentWorkspace(app, environmentId);
  await app.db.transaction(async () => {
    if (result.status === "ok") {
      const certificateId = await upsertCertificate(app, workspace.workspaceType, workspace.workspaceId, result, now);
      await app.db.prepare(`
        UPDATE ssl_endpoints SET
          certificate_id = ?, probe_status = ?, probe_error = '', probed_at = ?, last_success_at = ?,
          hostname_match = ?, chain_complete = ?, updated_at = ?
        WHERE id = ?
      `).run(
        certificateId,
        result.status,
        now,
        now,
        result.hostnameMatch == null ? null : result.hostnameMatch ? 1 : 0,
        result.chainComplete == null ? null : result.chainComplete ? 1 : 0,
        now,
        endpointId,
      );
      await app.db.prepare(`
        UPDATE tls_endpoints SET
          probe_status = ?, probe_error = '', probed_at = ?,
          leaf_cn = ?, leaf_sans_json = ?, issuer = ?, serial = ?, signature_algorithm = ?,
          not_before = ?, not_after = ?, fingerprint_sha256 = ?, is_self_signed = ?,
          hostname_match = ?, chain_complete = ?, days_remaining = ?, updated_at = ?
        WHERE id = ?
      `).run(
        result.status,
        now,
        result.leafCn,
        JSON.stringify(result.leafSans),
        result.issuer,
        result.serial,
        result.signatureAlgorithm,
        result.notBefore,
        result.notAfter,
        result.fingerprintSha256,
        result.isSelfSigned ? 1 : 0,
        result.hostnameMatch == null ? null : result.hostnameMatch ? 1 : 0,
        result.chainComplete == null ? null : result.chainComplete ? 1 : 0,
        result.daysRemaining,
        now,
        endpointId,
      );
      return;
    }
    await app.db.prepare(`
      UPDATE ssl_endpoints SET probe_status = ?, probe_error = ?, probed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(result.status, result.error.slice(0, 500), now, now, endpointId);
    await app.db.prepare(`
      UPDATE tls_endpoints SET probe_status = ?, probe_error = ?, probed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(result.status, result.error.slice(0, 500), now, now, endpointId);
  })();
}

async function runSerializedSshProbe<T>(sshConnectionId: string, task: () => Promise<T>): Promise<T> {
  while (globalProbeCount >= 4) await new Promise((resolve) => setTimeout(resolve, 25));
  globalProbeCount += 1;
  const previous = sshProbeTail.get(sshConnectionId) ?? Promise.resolve();
  let result!: T;
  const current = previous.catch(() => undefined).then(async () => {
    result = await task();
  });
  sshProbeTail.set(sshConnectionId, current);
  try {
    await current;
    return result;
  } finally {
    globalProbeCount -= 1;
    if (sshProbeTail.get(sshConnectionId) === current) sshProbeTail.delete(sshConnectionId);
  }
}

export async function probeTlsEndpoint(
  app: FastifyInstance,
  endpointId: string,
  options: { manual?: boolean } = {},
): Promise<TlsEndpoint> {
  const row = await loadEndpointRow(app, endpointId);
  if (!row) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  if (!row.ssh_connection_id) throw new TlsCertificateError("TLS_ENDPOINT_UNBOUND", "请先关联 SSH 主机后再探测");
  if (!Number(row.observe_enabled)) throw new TlsCertificateError("TLS_ENDPOINT_DISABLED", "该端点已停止观察");
  if (isForbiddenTlsProbeTarget(row.host)) throw new TlsCertificateError("INVALID_TLS_HOST", "证书探测主机无效");
  if (options.manual) {
    const last = lastManualProbe.get(endpointId) ?? 0;
    if (Date.now() - last < TLS_MANUAL_PROBE_COOLDOWN_MS) {
      throw new TlsCertificateError("TLS_PROBE_RATE_LIMIT", "同一端点 1 分钟内只能重新探测一次", 429);
    }
  }
  if (probing.has(endpointId)) throw new TlsCertificateError("TLS_PROBE_IN_PROGRESS", "该端点正在探测", 409);
  probing.add(endpointId);
  try {
    return await runSerializedSshProbe(row.ssh_connection_id, async () => {
      const command = buildTlsProbeCommand(row.host, Number(row.port), row.sni);
      let result: ReturnType<typeof parseTlsProbeOutput>;
      try {
        const output = await executeSshCommand(app, row.ssh_connection_id!, command, {
          timeoutMs: TLS_PROBE_TIMEOUT_MS,
          maxBytes: TLS_PROBE_MAX_BYTES,
          endStdin: true,
        });
        result = parseTlsProbeOutput(output.stdout, output.stderr, output.exitCode, row.sni || row.host);
      } catch (error) {
        const message = error instanceof Error ? error.message : "TLS 探测失败";
        result = parseTlsProbeOutput("", message, /超过/.test(message) ? 124 : 1, row.sni || row.host);
      }
      await persistProbe(app, endpointId, row.environment_id, result);
      if (options.manual) lastManualProbe.set(endpointId, Date.now());
      await evaluateTlsEndpointAlerts(app, row.environment_id);
      const updated = await getTlsEndpoint(app, endpointId);
      if (!updated) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
      return updated;
    });
  } finally {
    probing.delete(endpointId);
  }
}

export async function pollTlsEndpointsOnce(app: FastifyInstance, shouldStop: () => boolean = () => false): Promise<void> {
  const settingsRows = await app.db.prepare("SELECT environment_id, tls_warn_days FROM monitor_alert_settings").all() as Array<{ environment_id: string; tls_warn_days: number | string }>;
  const warnDaysByEnvironment = new Map(settingsRows.map((row) => [row.environment_id, Number(row.tls_warn_days) || DEFAULT_TLS_WARN_DAYS]));
  const rows = await app.db.prepare(`
    SELECT e.id, e.environment_id, e.ssh_connection_id, e.observe_enabled, e.probe_status, e.probed_at,
      cert.not_after
    FROM ssl_endpoints e
    LEFT JOIN ssl_certificates cert ON cert.id = e.certificate_id
    WHERE e.observe_enabled = 1 AND e.ssh_connection_id IS NOT NULL
    ORDER BY COALESCE(e.probed_at, ''), e.created_at
  `).all() as Array<{
    id: string;
    environment_id: string;
    ssh_connection_id: string;
    observe_enabled: number | string;
    probe_status: TlsProbeStatus;
    probed_at: string | null;
    not_after: string | null;
  }>;
  const now = Date.now();
  const due = rows.filter((row) => {
    const dueAt = tlsProbeDueAt({
      observeEnabled: true,
      sshConnectionId: row.ssh_connection_id,
      probeStatus: row.probe_status,
      probedAt: row.probed_at,
      daysRemaining: tlsDaysRemaining(row.not_after, now),
    }, warnDaysByEnvironment.get(row.environment_id) ?? DEFAULT_TLS_WARN_DAYS, now);
    return dueAt != null && dueAt <= now;
  });
  const grouped = new Map<string, string[]>();
  for (const row of due) {
    const items = grouped.get(row.ssh_connection_id) ?? [];
    if (items.length < 10) items.push(row.id);
    grouped.set(row.ssh_connection_id, items);
  }
  const batches = [...grouped.values()];
  for (let index = 0; index < batches.length; index += 4) {
    if (shouldStop()) break;
    await Promise.all(batches.slice(index, index + 4).map(async (endpointIds) => {
      for (const endpointId of endpointIds) {
        if (shouldStop()) break;
        try {
          await probeTlsEndpoint(app, endpointId);
        } catch (error) {
          app.log.warn({ err: error, endpointId }, "scheduled TLS certificate probe failed");
        }
      }
    }));
  }
}

export function startTlsEndpointPuller(app: FastifyInstance, tickMs = 30_000): () => Promise<void> {
  let polling = false;
  let stopped = false;
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      await pollTlsEndpointsOnce(app, () => stopped);
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => { void poll(); }, tickMs);
  timer.unref();
  void poll();
  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}

function assetStatus(asset: Omit<SslCertificateAsset, "status">, warnDays: number): SslCertificateStatus {
  return deriveCertificateStatus(asset, warnDays);
}

function certificateListOrderBy(sort: string | undefined): string {
  if (sort === "name") return "leaf_cn ASC, id ASC";
  if (sort === "updated") return "last_seen_at DESC, id DESC";
  return "not_after ASC, leaf_cn ASC, id ASC";
}

function isoPlusDays(now: number, days: number): string {
  return new Date(now + days * 86_400_000).toISOString();
}

async function hydrateCertificateAssets(
  app: FastifyInstance,
  certificates: Array<Record<string, unknown>>,
  warnDays: number,
): Promise<SslCertificateAsset[]> {
  const certificateIds = certificates.map((row) => String(row.id));
  const endpoints = certificateIds.length
    ? await app.db.prepare(`${ENDPOINT_SELECT} WHERE e.certificate_id IN (${certificateIds.map(() => "?").join(", ")})`).all(...certificateIds) as SslEndpointRow[]
    : [];
  const links = await webEntriesForEndpoints(app, endpoints.map((row) => row.id));
  const environmentNames = new Map<string, string>();
  if (endpoints.length) {
    const envIds = [...new Set(endpoints.map((row) => row.environment_id))];
    const envRows = await app.db.prepare(`SELECT id, name FROM environments WHERE id IN (${envIds.map(() => "?").join(", ")})`).all(...envIds) as Array<{ id: string; name: string }>;
    for (const row of envRows) environmentNames.set(row.id, row.name);
  }
  const endpointsByCert = new Map<string, TlsEndpoint[]>();
  for (const row of endpoints) {
    const mapped = mapEndpoint(row, links.get(row.id) ?? [], warnDays);
    const items = endpointsByCert.get(row.certificate_id ?? "") ?? [];
    items.push(mapped);
    endpointsByCert.set(row.certificate_id ?? "", items);
  }
  return certificates.map((row) => {
    const mappedEndpoints = endpointsByCert.get(String(row.id)) ?? [];
    const webEntries = mappedEndpoints.flatMap((endpoint) => endpoint.webEntries.map((entry) => ({
      ...entry,
      environmentId: endpoint.environmentId,
      environmentName: environmentNames.get(endpoint.environmentId) ?? "",
    })));
    const uniqueWeb = [...new Map(webEntries.map((item) => [item.id, item])).values()];
    const asset: SslCertificateAsset = {
      id: String(row.id),
      fingerprintSha256: String(row.fingerprint_sha256),
      leafCn: String(row.leaf_cn ?? ""),
      leafSans: parseJsonArray(row.leaf_sans_json),
      issuer: String(row.issuer ?? ""),
      serial: String(row.serial ?? ""),
      signatureAlgorithm: String(row.signature_algorithm ?? ""),
      notBefore: String(row.not_before),
      notAfter: String(row.not_after),
      isSelfSigned: Boolean(Number(row.is_self_signed)),
      status: "valid",
      daysRemaining: tlsDaysRemaining(String(row.not_after)),
      orphan: mappedEndpoints.length === 0,
      endpointCount: mappedEndpoints.length,
      webEntryCount: uniqueWeb.length,
      endpoints: mappedEndpoints,
      webEntries: uniqueWeb,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
    };
    asset.status = assetStatus(asset, warnDays);
    if (asset.endpoints.some((item) => item.hostnameMatch === false) && asset.status === "valid") asset.status = "error";
    return asset;
  });
}

export async function listWorkspaceCertificates(
  app: FastifyInstance,
  workspace: { type: string; id: string },
  query: {
    page: number;
    pageSize: number;
    q?: string;
    status?: string;
    environmentId?: string;
    sort?: string;
    warnDays?: number;
  },
): Promise<{ items: SslCertificateAsset[]; pageInfo: { page: number; pageSize: number; total: number }; summary: Record<string, number> }> {
  const warnDays = query.warnDays ?? DEFAULT_TLS_WARN_DAYS;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiringCutoffIso = isoPlusDays(now, warnDays + 1);
  const plus8Iso = isoPlusDays(now, 8);
  const plus15Iso = isoPlusDays(now, 15);
  const plus31Iso = isoPlusDays(now, 31);
  const needle = query.q?.trim().toLowerCase() ?? "";
  const like = `%${needle}%`;
  const environmentId = query.environmentId ?? "";
  const status = query.status ?? "";
  const filteredSql = `
    SELECT c.*,
      CASE
        WHEN COUNT(e.id) = 0 THEN 'orphan'
        WHEN c.not_after < ? THEN 'expired'
        WHEN SUM(CASE WHEN e.probe_status NOT IN ('ok', 'never', 'skipped') THEN 1 ELSE 0 END) > 0 THEN 'error'
        WHEN c.not_after < ? THEN 'expiring'
        WHEN SUM(CASE WHEN e.hostname_match = 0 THEN 1 ELSE 0 END) > 0 THEN 'error'
        ELSE 'valid'
      END AS derived_status,
      MAX(CASE WHEN e.hostname_match = 0 THEN 1 ELSE 0 END) AS has_mismatch
    FROM ssl_certificates c
    LEFT JOIN ssl_endpoints e ON e.certificate_id = c.id
    WHERE c.workspace_type = ? AND c.workspace_id = ?
      AND (? = '' OR LOWER(c.leaf_cn) LIKE ? OR LOWER(c.issuer) LIKE ? OR LOWER(c.fingerprint_sha256) LIKE ? OR LOWER(c.leaf_sans_json) LIKE ?)
      AND (? = '' OR EXISTS (SELECT 1 FROM ssl_endpoints scoped WHERE scoped.certificate_id = c.id AND scoped.environment_id = ?))
    GROUP BY c.id
    HAVING (
      ? = ''
      OR (? = 'mismatch' AND has_mismatch = 1)
      OR (? IN ('30d', '14d', '7d') AND c.not_after >= ? AND c.not_after < CASE ? WHEN '7d' THEN ? WHEN '14d' THEN ? ELSE ? END)
      OR (? NOT IN ('mismatch', '30d', '14d', '7d') AND derived_status = ?)
    )
  `;
  const filterParams = [
    nowIso,
    expiringCutoffIso,
    workspace.type,
    workspace.id,
    needle, like, like, like, like,
    environmentId, environmentId,
    status,
    status,
    status, nowIso, status, plus8Iso, plus15Iso, plus31Iso,
    status, status,
  ];
  const summaryRows = await app.db.prepare(`
    SELECT derived_status, COUNT(*) AS total, SUM(CASE WHEN has_mismatch = 1 THEN 1 ELSE 0 END) AS mismatch_total
    FROM (${filteredSql}) filtered
    GROUP BY derived_status
  `).all(...filterParams) as Array<{ derived_status: string; total: number | string; mismatch_total: number | string }>;
  const summary = {
    total: 0,
    valid: 0,
    expiring: 0,
    expired: 0,
    error: 0,
    orphan: 0,
  };
  for (const row of summaryRows) {
    const total = Number(row.total);
    summary.total += total;
    if (row.derived_status === "valid") summary.valid = total;
    if (row.derived_status === "expiring") summary.expiring = total;
    if (row.derived_status === "expired") summary.expired = total;
    if (row.derived_status === "error") summary.error += total;
    if (row.derived_status === "orphan") summary.orphan = total;
    if (row.derived_status !== "error") summary.error += Number(row.mismatch_total);
  }
  const offset = Math.max(0, (query.page - 1) * query.pageSize);
  const pageRows = await app.db.prepare(`
    SELECT * FROM (${filteredSql}) filtered
    ORDER BY ${certificateListOrderBy(query.sort)}
    LIMIT ? OFFSET ?
  `).all(...filterParams, query.pageSize, offset) as Array<Record<string, unknown>>;
  return {
    items: await hydrateCertificateAssets(app, pageRows, warnDays),
    pageInfo: { page: query.page, pageSize: query.pageSize, total: summary.total },
    summary,
  };
}

export async function getWorkspaceCertificate(app: FastifyInstance, workspace: { type: string; id: string }, certificateId: string): Promise<SslCertificateAsset | null> {
  const row = await app.db.prepare(`
    SELECT * FROM ssl_certificates WHERE id = ? AND workspace_type = ? AND workspace_id = ?
  `).get(certificateId, workspace.type, workspace.id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const [asset] = await hydrateCertificateAssets(app, [row], DEFAULT_TLS_WARN_DAYS);
  return asset ?? null;
}

export async function deleteWorkspaceCertificate(
  app: FastifyInstance,
  workspace: { type: string; id: string },
  certificateId: string,
  cascade: boolean,
): Promise<{ endpointCount: number; webEntryCount: number }> {
  const asset = await getWorkspaceCertificate(app, workspace, certificateId);
  if (!asset) throw new TlsCertificateError("CERTIFICATE_NOT_FOUND", "证书不存在", 404);
  if (asset.endpointCount > 0 && !cascade) {
    throw new TlsCertificateError("CERTIFICATE_IN_USE", `该证书仍被 ${asset.endpointCount} 个探测端点引用`, 409);
  }
  await app.db.transaction(async () => {
    if (cascade) {
      for (const endpoint of asset.endpoints) {
        await recoverEndpointAlerts(app, endpoint.environmentId, endpoint.id);
        await app.db.prepare("DELETE FROM ssl_endpoints WHERE id = ?").run(endpoint.id);
        await app.db.prepare("DELETE FROM tls_endpoints WHERE id = ?").run(endpoint.id);
      }
    }
    await app.db.prepare("DELETE FROM ssl_certificates WHERE id = ? AND workspace_type = ? AND workspace_id = ?")
      .run(certificateId, workspace.type, workspace.id);
  })();
  return { endpointCount: asset.endpointCount, webEntryCount: asset.webEntryCount };
}

export async function webEntryTlsBadge(
  app: FastifyInstance,
  environmentId: string,
  webEntryId: string,
  warnDays = DEFAULT_TLS_WARN_DAYS,
): Promise<TlsWebEntryBadge | null> {
  const linked = await app.db.prepare(`
    SELECT endpoint_id FROM ssl_endpoint_web_entries WHERE web_entry_id = ?
  `).all(webEntryId) as Array<{ endpoint_id: string }>;
  if (!linked.length) return null;
  const endpoints = [];
  for (const item of linked) {
    const endpoint = await getTlsEndpoint(app, item.endpoint_id);
    if (endpoint && endpoint.environmentId === environmentId) endpoints.push(endpoint);
  }
  return tlsWebEntryBadge(endpoints, warnDays);
}
