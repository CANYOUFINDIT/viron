import { randomUUID, X509Certificate } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { quotePosixShellArg } from "../shared/environment-log.js";
import {
  DEFAULT_TLS_WARN_DAYS,
  MAX_TLS_ENDPOINTS_PER_ENVIRONMENT,
  TLS_MANUAL_PROBE_COOLDOWN_MS,
  TLS_PROBE_MAX_BYTES,
  TLS_PROBE_TIMEOUT_MS,
  classifyTlsProbeFailure,
  hostnameMatchesCertificate,
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
  tlsProbeDueAt,
  type TlsCertificateSnapshot,
  type TlsEndpoint,
  type TlsEndpointSource,
  type TlsHttpsOrigin,
  type TlsProbeResult,
  type TlsProbeStatus,
  type TlsWebEntryLink,
} from "../shared/tls-certificates.js";
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

interface TlsEndpointRow {
  id: string;
  environment_id: string;
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
  days_remaining: number | string | null;
  created_at: string;
  updated_at: string;
  connection_name?: string | null;
  ssh_host?: string | null;
}

const probing = new Set<string>();
const lastManualProbe = new Map<string, number>();

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
  const fingerprintSha256 = normalizeFingerprint(cert.fingerprint256);
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

function mapEndpoint(row: TlsEndpointRow, webEntries: TlsWebEntryLink[] = []): TlsEndpoint {
  return {
    id: row.id,
    environmentId: row.environment_id,
    sshConnectionId: row.ssh_connection_id,
    sshConnectionName: String(row.connection_name ?? ""),
    sshHost: String(row.ssh_host ?? ""),
    host: row.host,
    port: Number(row.port),
    sni: row.sni,
    source: row.source,
    observeEnabled: Boolean(Number(row.observe_enabled)),
    customized: Boolean(Number(row.customized)),
    sortOrder: Number(row.sort_order),
    probeStatus: row.probe_status,
    probeError: row.probe_error ?? "",
    probedAt: row.probed_at,
    leafCn: row.leaf_cn ?? "",
    leafSans: parseJsonArray(row.leaf_sans_json),
    issuer: row.issuer ?? "",
    serial: row.serial ?? "",
    signatureAlgorithm: row.signature_algorithm ?? "",
    notBefore: row.not_before,
    notAfter: row.not_after,
    fingerprintSha256: row.fingerprint_sha256 ?? "",
    isSelfSigned: Boolean(Number(row.is_self_signed)),
    hostnameMatch: nullableFlag(row.hostname_match),
    chainComplete: nullableFlag(row.chain_complete),
    daysRemaining: row.days_remaining == null || row.days_remaining === "" ? null : Number(row.days_remaining),
    webEntries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function environmentSshHosts(app: FastifyInstance, environmentId: string): Promise<Array<{ id: string; host: string; name: string }>> {
  const rows = await app.db.prepare(`
    SELECT c.id, c.host, c.name FROM ssh_connections c
    JOIN ssh_connection_environments ce ON ce.connection_id = c.id
    WHERE ce.environment_id = ? AND c.source_deleted = 0
    ORDER BY ce.maintenance_sort_order, c.name, c.id
  `).all(environmentId) as Array<{ id: string; host: string; name: string }>;
  return rows;
}

function uniqueMatchingSshId(hosts: Array<{ id: string; host: string }>, hostname: string): string | null {
  const matches = hosts.filter((item) => normalizeTlsHost(item.host) === normalizeTlsHost(hostname));
  return matches.length === 1 ? matches[0]!.id : null;
}

async function endpointCount(app: FastifyInstance, environmentId: string): Promise<number> {
  const row = await app.db.prepare("SELECT COUNT(*) AS total FROM tls_endpoints WHERE environment_id = ?").get(environmentId) as { total: number | string };
  return Number(row.total);
}

export function validateTlsEndpointInput(input: { host: string; port: number; sni?: string; sshConnectionId?: string | null }): TlsHttpsOrigin & { sshConnectionId: string | null } {
  const host = normalizeTlsHost(input.host);
  if (!isValidTlsHost(host)) throw new TlsCertificateError("INVALID_TLS_HOST", "证书探测主机无效");
  if (!isValidTlsPort(input.port)) throw new TlsCertificateError("INVALID_TLS_PORT", "证书探测端口无效");
  const sni = normalizeTlsHost(input.sni ?? "") || (looksLikeIpAddress(host) ? "" : host);
  if (!isValidTlsSni(sni)) throw new TlsCertificateError("INVALID_TLS_SNI", "SNI 只能使用域名");
  return { host, port: input.port, sni, sshConnectionId: input.sshConnectionId ?? null };
}

async function loadEndpointRow(app: FastifyInstance, endpointId: string): Promise<TlsEndpointRow | undefined> {
  return await app.db.prepare(`
    SELECT e.*, c.name AS connection_name, c.host AS ssh_host
    FROM tls_endpoints e
    LEFT JOIN ssh_connections c ON c.id = e.ssh_connection_id
    WHERE e.id = ?
  `).get(endpointId) as TlsEndpointRow | undefined;
}

async function webEntriesForEndpoints(app: FastifyInstance, endpointIds: string[]): Promise<Map<string, TlsWebEntryLink[]>> {
  const links = new Map<string, TlsWebEntryLink[]>();
  if (!endpointIds.length) return links;
  const placeholders = endpointIds.map(() => "?").join(", ");
  const rows = await app.db.prepare(`
    SELECT l.endpoint_id, w.id, w.name, w.url
    FROM tls_endpoint_web_entries l
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
  const rows = await app.db.prepare(`
    SELECT e.*, c.name AS connection_name, c.host AS ssh_host
    FROM tls_endpoints e
    LEFT JOIN ssh_connections c ON c.id = e.ssh_connection_id
    WHERE e.environment_id = ?
    ORDER BY e.sort_order, e.updated_at DESC, e.host
  `).all(environmentId) as TlsEndpointRow[];
  const links = await webEntriesForEndpoints(app, rows.map((row) => row.id));
  return rows.map((row) => mapEndpoint(row, links.get(row.id) ?? []));
}

async function findIdentityEndpoint(
  app: FastifyInstance,
  environmentId: string,
  origin: TlsHttpsOrigin,
  sshConnectionId: string | null,
): Promise<TlsEndpointRow | undefined> {
  const bindKey = sshConnectionId ?? "";
  return await app.db.prepare(`
    SELECT * FROM tls_endpoints
    WHERE environment_id = ? AND ssh_bind_key = ? AND host = ? AND port = ? AND sni = ?
  `).get(environmentId, bindKey, origin.host, origin.port, origin.sni) as TlsEndpointRow | undefined;
}

async function findOriginEndpoints(
  app: FastifyInstance,
  environmentId: string,
  origin: TlsHttpsOrigin,
): Promise<TlsEndpointRow[]> {
  return await app.db.prepare(`
    SELECT * FROM tls_endpoints
    WHERE environment_id = ? AND host = ? AND port = ? AND sni = ?
    ORDER BY CASE WHEN ssh_connection_id IS NULL THEN 1 ELSE 0 END, updated_at DESC
  `).all(environmentId, origin.host, origin.port, origin.sni) as TlsEndpointRow[];
}

async function insertEndpoint(
  app: FastifyInstance,
  input: {
    environmentId: string;
    origin: TlsHttpsOrigin;
    sshConnectionId: string | null;
    source: TlsEndpointSource;
    customized?: boolean;
  },
): Promise<string> {
  if (await endpointCount(app, input.environmentId) >= MAX_TLS_ENDPOINTS_PER_ENVIRONMENT) {
    throw new TlsCertificateError("TLS_ENDPOINT_LIMIT", `每个环境最多观察 ${MAX_TLS_ENDPOINTS_PER_ENVIRONMENT} 个 TLS 端点`);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const nextOrder = await app.db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM tls_endpoints WHERE environment_id = ?
  `).get(input.environmentId) as { next_sort_order: number | string };
  await app.db.prepare(`
    INSERT INTO tls_endpoints (
      id, environment_id, ssh_connection_id, ssh_bind_key, host, port, sni, source,
      observe_enabled, customized, sort_order, probe_status, probe_error, leaf_sans_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'never', '', '[]', ?, ?)
  `).run(
    id,
    input.environmentId,
    input.sshConnectionId,
    input.sshConnectionId ?? "",
    input.origin.host,
    input.origin.port,
    input.origin.sni,
    input.source,
    input.customized ? 1 : 0,
    Number(nextOrder.next_sort_order),
    now,
    now,
  );
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
  if (existing) throw new TlsCertificateError("TLS_ENDPOINT_EXISTS", "该 TLS 端点已经存在");
  return await insertEndpoint(app, {
    environmentId,
    origin,
    sshConnectionId: origin.sshConnectionId,
    source: "manual",
  });
}

export async function updateTlsEndpoint(
  app: FastifyInstance,
  endpointId: string,
  input: { host: string; port: number; sni?: string; sshConnectionId?: string | null; observeEnabled?: boolean },
): Promise<void> {
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
    if (existing && existing.id !== endpointId) throw new TlsCertificateError("TLS_ENDPOINT_EXISTS", "该 TLS 端点已经存在");
  }
  const now = new Date().toISOString();
  const customized = row.source === "web_entry" && identityChanged ? 1 : Number(row.customized);
  await app.db.prepare(`
    UPDATE tls_endpoints SET
      ssh_connection_id = ?, ssh_bind_key = ?, host = ?, port = ?, sni = ?,
      observe_enabled = ?, customized = ?, source = ?, updated_at = ?
    WHERE id = ?
  `).run(
    origin.sshConnectionId,
    origin.sshConnectionId ?? "",
    origin.host,
    origin.port,
    origin.sni,
    input.observeEnabled === false ? 0 : 1,
    customized,
    customized && row.source === "web_entry" ? "manual" : row.source,
    now,
    endpointId,
  );
}

export async function deleteTlsEndpoint(app: FastifyInstance, endpointId: string): Promise<TlsEndpointRow> {
  const row = await loadEndpointRow(app, endpointId);
  if (!row) throw new TlsCertificateError("TLS_ENDPOINT_NOT_FOUND", "证书端点不存在", 404);
  await app.db.transaction(async () => {
    await app.db.prepare(`
      UPDATE monitor_alerts SET status = 'recovered', recovered_at = ?, updated_at = ?
      WHERE environment_id = ? AND target_type = 'tls_endpoint' AND target_id = ? AND status = 'active'
    `).run(new Date().toISOString(), new Date().toISOString(), row.environment_id, endpointId);
    await app.db.prepare("DELETE FROM monitor_alert_states WHERE environment_id = ? AND target_type = 'tls_endpoint' AND target_id = ?")
      .run(row.environment_id, endpointId);
    await app.db.prepare("DELETE FROM tls_endpoints WHERE id = ?").run(endpointId);
  })();
  return row;
}

async function linkWebEntry(app: FastifyInstance, endpointId: string, webEntryId: string): Promise<void> {
  await app.db.prepare("INSERT OR IGNORE INTO tls_endpoint_web_entries (endpoint_id, web_entry_id) VALUES (?, ?)").run(endpointId, webEntryId);
}

async function unlinkWebEntry(app: FastifyInstance, webEntryId: string): Promise<string[]> {
  const rows = await app.db.prepare("SELECT endpoint_id FROM tls_endpoint_web_entries WHERE web_entry_id = ?").all(webEntryId) as Array<{ endpoint_id: string }>;
  await app.db.prepare("DELETE FROM tls_endpoint_web_entries WHERE web_entry_id = ?").run(webEntryId);
  return rows.map((row) => row.endpoint_id);
}

async function cleanupOrphanWebEntryEndpoints(app: FastifyInstance, endpointIds: string[]): Promise<void> {
  for (const endpointId of endpointIds) {
    const row = await app.db.prepare("SELECT id, source, customized FROM tls_endpoints WHERE id = ?").get(endpointId) as
      | { id: string; source: TlsEndpointSource; customized: number | string }
      | undefined;
    if (!row || row.source !== "web_entry" || Number(row.customized)) continue;
    const remaining = await app.db.prepare("SELECT COUNT(*) AS total FROM tls_endpoint_web_entries WHERE endpoint_id = ?").get(endpointId) as { total: number | string };
    if (Number(remaining.total) === 0) await app.db.prepare("DELETE FROM tls_endpoints WHERE id = ?").run(endpointId);
  }
}

export async function syncWebEntryTlsEndpoint(app: FastifyInstance, environmentId: string, webEntryId: string, url: string): Promise<void> {
  const previous = await unlinkWebEntry(app, webEntryId);
  const origin = parseHttpsOrigin(url);
  if (!origin) {
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
  await cleanupOrphanWebEntryEndpoints(app, previous.filter((id) => id !== endpointId));
}

export async function removeWebEntryTlsEndpoint(app: FastifyInstance, webEntryId: string): Promise<void> {
  const previous = await unlinkWebEntry(app, webEntryId);
  await cleanupOrphanWebEntryEndpoints(app, previous);
}

function snapshotColumns(snapshot: TlsCertificateSnapshot | TlsProbeResult) {
  return [
    snapshot.leafCn,
    JSON.stringify(snapshot.leafSans),
    snapshot.issuer,
    snapshot.serial,
    snapshot.signatureAlgorithm,
    snapshot.notBefore,
    snapshot.notAfter,
    snapshot.fingerprintSha256,
    snapshot.isSelfSigned ? 1 : 0,
    snapshot.hostnameMatch == null ? null : snapshot.hostnameMatch ? 1 : 0,
    snapshot.chainComplete == null ? null : snapshot.chainComplete ? 1 : 0,
    snapshot.daysRemaining,
  ];
}

async function persistProbe(app: FastifyInstance, endpointId: string, result: ReturnType<typeof parseTlsProbeOutput>): Promise<void> {
  const now = result.probedAt;
  if (result.status === "ok") {
    await app.db.prepare(`
      UPDATE tls_endpoints SET
        probe_status = ?, probe_error = '', probed_at = ?,
        leaf_cn = ?, leaf_sans_json = ?, issuer = ?, serial = ?, signature_algorithm = ?,
        not_before = ?, not_after = ?, fingerprint_sha256 = ?, is_self_signed = ?,
        hostname_match = ?, chain_complete = ?, days_remaining = ?, updated_at = ?
      WHERE id = ?
    `).run(result.status, now, ...snapshotColumns(result), now, endpointId);
    return;
  }
  await app.db.prepare(`
    UPDATE tls_endpoints SET probe_status = ?, probe_error = ?, probed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(result.status, result.error.slice(0, 500), now, now, endpointId);
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
  if (options.manual) {
    const last = lastManualProbe.get(endpointId) ?? 0;
    if (Date.now() - last < TLS_MANUAL_PROBE_COOLDOWN_MS) {
      throw new TlsCertificateError("TLS_PROBE_RATE_LIMIT", "同一端点 1 分钟内只能重新探测一次", 429);
    }
  }
  if (probing.has(endpointId)) throw new TlsCertificateError("TLS_PROBE_IN_PROGRESS", "该端点正在探测", 409);
  probing.add(endpointId);
  try {
    const command = buildTlsProbeCommand(row.host, Number(row.port), row.sni);
    let result: ReturnType<typeof parseTlsProbeOutput>;
    try {
      const output = await executeSshCommand(app, row.ssh_connection_id, command, {
        timeoutMs: TLS_PROBE_TIMEOUT_MS,
        maxBytes: TLS_PROBE_MAX_BYTES,
        endStdin: true,
      });
      result = parseTlsProbeOutput(output.stdout, output.stderr, output.exitCode, row.sni || row.host);
    } catch (error) {
      const message = error instanceof Error ? error.message : "TLS 探测失败";
      result = parseTlsProbeOutput("", message, /超过/.test(message) ? 124 : 1, row.sni || row.host);
    }
    await persistProbe(app, endpointId, result);
    if (options.manual) lastManualProbe.set(endpointId, Date.now());
    await evaluateTlsEndpointAlerts(app, row.environment_id);
    const updated = await loadEndpointRow(app, endpointId);
    const links = await webEntriesForEndpoints(app, [endpointId]);
    return mapEndpoint(updated!, links.get(endpointId) ?? []);
  } finally {
    probing.delete(endpointId);
  }
}

export async function pollTlsEndpointsOnce(app: FastifyInstance, shouldStop: () => boolean = () => false): Promise<void> {
  const settingsRows = await app.db.prepare("SELECT environment_id, tls_warn_days FROM monitor_alert_settings").all() as Array<{ environment_id: string; tls_warn_days: number | string }>;
  const warnDaysByEnvironment = new Map(settingsRows.map((row) => [row.environment_id, Number(row.tls_warn_days) || DEFAULT_TLS_WARN_DAYS]));
  const rows = await app.db.prepare(`
    SELECT e.id, e.environment_id, e.ssh_connection_id, e.observe_enabled, e.probe_status, e.probed_at, e.days_remaining
    FROM tls_endpoints e
    WHERE e.observe_enabled = 1 AND e.ssh_connection_id IS NOT NULL
    ORDER BY COALESCE(e.probed_at, ''), e.created_at
  `).all() as Array<{
    id: string;
    environment_id: string;
    ssh_connection_id: string;
    observe_enabled: number | string;
    probe_status: TlsProbeStatus;
    probed_at: string | null;
    days_remaining: number | string | null;
  }>;
  const now = Date.now();
  const due = rows.filter((row) => {
    const dueAt = tlsProbeDueAt({
      observeEnabled: true,
      sshConnectionId: row.ssh_connection_id,
      probeStatus: row.probe_status,
      probedAt: row.probed_at,
      daysRemaining: row.days_remaining == null ? null : Number(row.days_remaining),
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
