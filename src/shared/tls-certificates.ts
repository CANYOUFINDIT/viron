export const MAX_TLS_ENDPOINTS_PER_ENVIRONMENT = 50;
export const TLS_PROBE_TIMEOUT_MS = 10_000;
export const TLS_PROBE_MAX_BYTES = 64 * 1024;
export const TLS_PROBE_MIN_INTERVAL_MS = 5 * 60_000;
export const TLS_PROBE_HEALTHY_INTERVAL_MS = 60 * 60_000;
export const TLS_PROBE_ATTENTION_INTERVAL_MS = 15 * 60_000;
export const TLS_MANUAL_PROBE_COOLDOWN_MS = 60_000;
export const TLS_WARN_DAYS = [7, 14, 30] as const;
export const DEFAULT_TLS_WARN_DAYS = 14;

export type TlsEndpointSource = "web_entry" | "manual";
export type TlsProbeStatus =
  | "never"
  | "ok"
  | "connect_failed"
  | "handshake_failed"
  | "timeout"
  | "probe_unavailable"
  | "skipped";

const TLS_ENDPOINT_SOURCE_VALUES = new Set<string>(["web_entry", "manual"]);
const TLS_PROBE_STATUS_VALUES = new Set<string>([
  "never",
  "ok",
  "connect_failed",
  "handshake_failed",
  "timeout",
  "probe_unavailable",
  "skipped",
]);

export function isTlsEndpointSource(value: unknown): value is TlsEndpointSource {
  return typeof value === "string" && TLS_ENDPOINT_SOURCE_VALUES.has(value);
}

export function isTlsProbeStatus(value: unknown): value is TlsProbeStatus {
  return typeof value === "string" && TLS_PROBE_STATUS_VALUES.has(value);
}

export interface TlsHttpsOrigin {
  host: string;
  port: number;
  sni: string;
}

export interface TlsCertificateSnapshot {
  leafCn: string;
  leafSans: string[];
  issuer: string;
  serial: string;
  signatureAlgorithm: string;
  notBefore: string | null;
  notAfter: string | null;
  fingerprintSha256: string;
  isSelfSigned: boolean;
  hostnameMatch: boolean | null;
  chainComplete: boolean | null;
  daysRemaining: number | null;
}

export interface TlsProbeResult extends TlsCertificateSnapshot {
  status: Exclude<TlsProbeStatus, "never" | "skipped">;
  error: string;
  probedAt: string;
  leafPem: string;
}

export interface TlsWebEntryLink {
  id: string;
  name: string;
  url: string;
}

export interface TlsEndpoint {
  id: string;
  environmentId: string;
  certificateId: string | null;
  sshConnectionId: string | null;
  sshConnectionName: string;
  sshHost: string;
  host: string;
  port: number;
  sni: string;
  source: TlsEndpointSource;
  observeEnabled: boolean;
  customized: boolean;
  sortOrder: number;
  probeStatus: TlsProbeStatus;
  probeError: string;
  probedAt: string | null;
  lastSuccessAt: string | null;
  leafCn: string;
  leafSans: string[];
  issuer: string;
  serial: string;
  signatureAlgorithm: string;
  notBefore: string | null;
  notAfter: string | null;
  fingerprintSha256: string;
  isSelfSigned: boolean;
  hostnameMatch: boolean | null;
  chainComplete: boolean | null;
  daysRemaining: number | null;
  stale: boolean;
  webEntries: TlsWebEntryLink[];
  createdAt: string;
  updatedAt: string;
}

export type SslCertificateStatus = "valid" | "expiring" | "expired" | "error" | "orphan";
export type TlsWebEntryStatus = "unconfigured" | "probing" | "valid" | "expiring" | "expired" | "mismatch" | "error";

export interface SslCertificateAsset {
  id: string;
  fingerprintSha256: string;
  leafCn: string;
  leafSans: string[];
  issuer: string;
  serial: string;
  signatureAlgorithm: string;
  notBefore: string;
  notAfter: string;
  isSelfSigned: boolean;
  status: SslCertificateStatus;
  daysRemaining: number | null;
  orphan: boolean;
  endpointCount: number;
  webEntryCount: number;
  endpoints: TlsEndpoint[];
  webEntries: Array<TlsWebEntryLink & { environmentId: string; environmentName: string }>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface TlsCertificateGroup {
  key: string;
  fingerprintSha256: string;
  leafCn: string;
  leafSans: string[];
  issuer: string;
  notAfter: string | null;
  daysRemaining: number | null;
  hostnameMatch: boolean | null;
  isSelfSigned: boolean;
  endpoints: TlsEndpoint[];
}

export interface TlsWebEntryBadge {
  status: TlsWebEntryStatus;
  daysRemaining: number | null;
  endpointId: string | null;
  certificateId: string | null;
  fingerprintSha256: string | null;
  probedAt: string | null;
  stale: boolean;
  probeError: string;
}

export interface CertificateProbeTargetResult {
  endpointId: string;
  status: "succeeded" | "failed";
  probeStatus?: TlsProbeStatus;
  error?: string;
  message?: string;
}

export interface CertificateProbeResponse {
  probed: number;
  succeeded: number;
  failed: number;
  results: CertificateProbeTargetResult[];
}

const DNS_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export function looksLikeIpAddress(value: string): boolean {
  const host = stripHostBrackets(value);
  return IPV4.test(host) || (host.includes(":") && IPV6.test(host));
}

export function stripHostBrackets(value: string): string {
  return value.trim().replace(/^\[|\]$/g, "");
}

export function normalizeTlsHost(value: string): string {
  return stripHostBrackets(value).toLowerCase();
}

export function isValidTlsHost(value: string): boolean {
  const host = normalizeTlsHost(value);
  if (!host || host.length > 253 || /[\s\0\r\n;|&$`'<>\\"%]/.test(host)) return false;
  return DNS_HOST.test(host) || IPV4.test(host) || (host.includes(":") && IPV6.test(host));
}

const FORBIDDEN_METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.google.com",
  "metadata.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

function ipv4Octets(host: string): number[] | null {
  if (!IPV4.test(host)) return null;
  return host.split(".").map((part) => Number(part));
}

export function isForbiddenTlsProbeTarget(value: string): boolean {
  const host = normalizeTlsHost(value);
  if (FORBIDDEN_METADATA_HOSTS.has(host)) return true;
  if (host === "100.100.100.200" || host === "169.254.169.254") return true;
  const octets = ipv4Octets(host);
  if (octets) {
    const [a, b] = octets;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224 && a <= 239) return true;
    if (a === 255 && octets.every((part) => part === 255)) return true;
    return false;
  }
  if (host.includes(":")) {
    const compact = host.replace(/^\[|\]$/g, "");
    if (compact === "::" || compact === "0:0:0:0:0:0:0:0") return true;
    if (compact.startsWith("fe8") || compact.startsWith("fe9") || compact.startsWith("fea") || compact.startsWith("feb")) return true;
    if (compact.startsWith("ff")) return true;
  }
  return false;
}

export function isValidTlsSni(value: string): boolean {
  if (!value.trim()) return true;
  const sni = normalizeTlsHost(value);
  return DNS_HOST.test(sni) && !looksLikeIpAddress(sni);
}

export function isValidTlsPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function tlsConnectTarget(host: string, port: number): string {
  const normalized = normalizeTlsHost(host);
  return normalized.includes(":") ? `[${normalized}]:${port}` : `${normalized}:${port}`;
}

export function parseHttpsOrigin(url: string): TlsHttpsOrigin | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const host = normalizeTlsHost(parsed.hostname);
    if (!isValidTlsHost(host)) return null;
    const port = parsed.port ? Number(parsed.port) : 443;
    if (!isValidTlsPort(port)) return null;
    const sni = looksLikeIpAddress(host) ? "" : host;
    return { host, port, sni };
  } catch {
    return null;
  }
}

export function tlsDaysRemaining(notAfter: string | Date | null | undefined, now = Date.now()): number | null {
  if (!notAfter) return null;
  const expires = typeof notAfter === "number" || notAfter instanceof Date ? new Date(notAfter).getTime() : Date.parse(notAfter);
  if (!Number.isFinite(expires)) return null;
  return Math.floor((expires - now) / 86_400_000);
}

export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

export function canonicalFingerprint(value: string): string | null {
  const hex = normalizeFingerprint(value);
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function formatFingerprint(value: string): string {
  const hex = canonicalFingerprint(value) ?? normalizeFingerprint(value);
  if (!hex) return "";
  return hex.replace(/(.{2})(?=.)/g, "$1:").toUpperCase();
}

export function parseSubjectCommonName(subject: string): string {
  const match = /(?:^|,)\s*CN\s*=\s*([^,/]+)/i.exec(subject);
  return (match?.[1] ?? "").trim();
}

export function parseSubjectAltNames(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/,\s*/).flatMap((part) => {
    const match = /^(?:DNS|IP Address):\s*(.+)$/i.exec(part.trim());
    return match ? [match[1].trim().toLowerCase()] : [];
  }))];
}

export function hostnameMatchesCertificate(hostname: string, commonName: string, subjectAltNames: string[]): boolean {
  const host = normalizeTlsHost(hostname);
  if (!host || looksLikeIpAddress(host)) {
    return subjectAltNames.includes(host);
  }
  const names = [...new Set([commonName.trim().toLowerCase(), ...subjectAltNames.map((item) => item.toLowerCase())].filter(Boolean))];
  return names.some((name) => name === host || (name.startsWith("*.") && host.endsWith(name.slice(1)) && host.split(".").length === name.split(".").length));
}

export function tlsEndpointAttention(endpoint: Pick<TlsEndpoint, "sshConnectionId" | "probeStatus" | "daysRemaining" | "hostnameMatch">, warnDays = DEFAULT_TLS_WARN_DAYS): "expired" | "expiring" | "mismatch" | "unbound" | "failed" | null {
  if (!endpoint.sshConnectionId) return "unbound";
  if (endpoint.daysRemaining != null && endpoint.daysRemaining < 0) return "expired";
  if (endpoint.daysRemaining != null && endpoint.daysRemaining <= warnDays) return "expiring";
  if (endpoint.hostnameMatch === false) return "mismatch";
  if (endpoint.probeStatus !== "ok" && endpoint.probeStatus !== "never" && endpoint.probeStatus !== "skipped") return "failed";
  return null;
}

export function tlsEndpointIsStale(
  endpoint: Pick<TlsEndpoint, "observeEnabled" | "sshConnectionId" | "probeStatus" | "probedAt" | "lastSuccessAt" | "daysRemaining" | "certificateId">,
  warnDays = DEFAULT_TLS_WARN_DAYS,
  now = Date.now(),
): boolean {
  const failed = endpoint.probeStatus !== "ok" && endpoint.probeStatus !== "never" && endpoint.probeStatus !== "skipped";
  if (failed && (endpoint.lastSuccessAt || endpoint.certificateId)) return true;
  const reference = endpoint.lastSuccessAt || endpoint.probedAt;
  if (!reference) return false;
  const dueAt = tlsProbeDueAt(endpoint, warnDays, Date.parse(reference));
  if (dueAt == null) return false;
  const interval = Math.max(TLS_PROBE_MIN_INTERVAL_MS, dueAt - Date.parse(reference));
  return now - Date.parse(reference) > interval * 2;
}

export function deriveCertificateStatus(
  asset: Pick<SslCertificateAsset, "daysRemaining" | "orphan" | "endpoints">,
  warnDays = DEFAULT_TLS_WARN_DAYS,
): SslCertificateStatus {
  if (asset.orphan || !asset.endpoints.length) return "orphan";
  if (asset.daysRemaining != null && asset.daysRemaining < 0) return "expired";
  if (asset.endpoints.some((item) => item.probeStatus !== "ok" && item.probeStatus !== "never" && item.probeStatus !== "skipped")) return "error";
  if (asset.daysRemaining != null && asset.daysRemaining <= warnDays) return "expiring";
  if (asset.endpoints.some((item) => item.hostnameMatch === false)) return "error";
  return "valid";
}

function badgeFromEndpoint(
  endpoint: Pick<TlsEndpoint, "id" | "certificateId" | "sshConnectionId" | "probeStatus" | "probeError" | "probedAt" | "daysRemaining" | "hostnameMatch" | "fingerprintSha256" | "stale">,
  probing = false,
): TlsWebEntryBadge {
  const fingerprint = canonicalFingerprint(endpoint.fingerprintSha256);
  const base = {
    daysRemaining: endpoint.daysRemaining,
    endpointId: endpoint.id,
    certificateId: endpoint.certificateId,
    fingerprintSha256: fingerprint,
    probedAt: endpoint.probedAt,
    stale: Boolean(endpoint.stale),
    probeError: endpoint.probeError ?? "",
  };
  if (probing) return { ...base, status: "probing" };
  if (!endpoint.sshConnectionId) return { ...base, status: "unconfigured" };
  if (endpoint.daysRemaining != null && endpoint.daysRemaining < 0) return { ...base, status: "expired" };
  if (endpoint.hostnameMatch === false) return { ...base, status: "mismatch" };
  if (endpoint.probeStatus !== "ok" && endpoint.probeStatus !== "never" && endpoint.probeStatus !== "skipped") {
    return { ...base, status: "error" };
  }
  if (endpoint.probeStatus === "never" || endpoint.probeStatus === "skipped") return { ...base, status: "unconfigured" };
  if (endpoint.daysRemaining != null && endpoint.daysRemaining <= DEFAULT_TLS_WARN_DAYS) return { ...base, status: "expiring" };
  return { ...base, status: "valid" };
}

export function tlsWebEntryBadge(
  endpoints: Array<Pick<TlsEndpoint, "id" | "certificateId" | "sshConnectionId" | "probeStatus" | "probeError" | "probedAt" | "daysRemaining" | "hostnameMatch" | "fingerprintSha256" | "stale">>,
  warnDays = DEFAULT_TLS_WARN_DAYS,
  probingEndpointIds: Iterable<string> = [],
): TlsWebEntryBadge | null {
  if (!endpoints.length) return null;
  const probing = new Set(probingEndpointIds);
  const probingHit = endpoints.find((item) => probing.has(item.id));
  if (probingHit) return badgeFromEndpoint(probingHit, true);
  const bound = endpoints.filter((item) => item.sshConnectionId);
  const chosen = (bound.length ? bound : endpoints).slice().sort((left, right) => {
    const leftDays = left.daysRemaining ?? Number.POSITIVE_INFINITY;
    const rightDays = right.daysRemaining ?? Number.POSITIVE_INFINITY;
    return leftDays - rightDays;
  })[0]!;
  const badge = badgeFromEndpoint({ ...chosen, stale: chosen.stale || tlsEndpointIsStale(chosen as TlsEndpoint, warnDays) });
  if (badge.status === "valid" && chosen.daysRemaining != null && chosen.daysRemaining <= warnDays) {
    return { ...badge, status: "expiring" };
  }
  return badge;
}

export function groupTlsEndpoints(endpoints: TlsEndpoint[]): TlsCertificateGroup[] {
  const groups = new Map<string, TlsCertificateGroup>();
  for (const endpoint of endpoints) {
    const key = endpoint.fingerprintSha256 || `pending:${endpoint.id}`;
    const current = groups.get(key);
    if (current) {
      current.endpoints.push(endpoint);
      if (endpoint.daysRemaining != null && (current.daysRemaining == null || endpoint.daysRemaining < current.daysRemaining)) {
        current.daysRemaining = endpoint.daysRemaining;
        current.notAfter = endpoint.notAfter;
      }
      if (endpoint.hostnameMatch === false) current.hostnameMatch = false;
      continue;
    }
    groups.set(key, {
      key,
      fingerprintSha256: endpoint.fingerprintSha256,
      leafCn: endpoint.leafCn || endpoint.sni || endpoint.host,
      leafSans: endpoint.leafSans,
      issuer: endpoint.issuer,
      notAfter: endpoint.notAfter,
      daysRemaining: endpoint.daysRemaining,
      hostnameMatch: endpoint.hostnameMatch,
      isSelfSigned: endpoint.isSelfSigned,
      endpoints: [endpoint],
    });
  }
  return [...groups.values()].sort((left, right) => {
    const leftDays = left.daysRemaining ?? Number.POSITIVE_INFINITY;
    const rightDays = right.daysRemaining ?? Number.POSITIVE_INFINITY;
    if (leftDays !== rightDays) return leftDays - rightDays;
    return left.leafCn.localeCompare(right.leafCn);
  });
}

export function tlsProbeDueAt(
  endpoint: Pick<TlsEndpoint, "observeEnabled" | "sshConnectionId" | "probeStatus" | "probedAt" | "daysRemaining">,
  warnDays = DEFAULT_TLS_WARN_DAYS,
  now = Date.now(),
): number | null {
  if (!endpoint.observeEnabled || !endpoint.sshConnectionId) return null;
  if (!endpoint.probedAt) return now;
  const probedAt = Date.parse(endpoint.probedAt);
  if (!Number.isFinite(probedAt)) return now;
  const attention = endpoint.probeStatus !== "ok" || (endpoint.daysRemaining != null && endpoint.daysRemaining <= warnDays);
  const interval = attention ? TLS_PROBE_ATTENTION_INTERVAL_MS : TLS_PROBE_HEALTHY_INTERVAL_MS;
  return probedAt + Math.max(TLS_PROBE_MIN_INTERVAL_MS, interval);
}

export function opensslVerifyOk(output: string): boolean | null {
  const match = /Verify return code:\s*(\d+)/i.exec(output);
  if (!match) return null;
  return match[1] === "0";
}

export function classifyTlsProbeFailure(stdout: string, stderr: string, exitCode: number | null): Exclude<TlsProbeStatus, "never" | "skipped" | "ok"> {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (exitCode === 127 || /openssl:\s*(command )?not found|no such file or directory/.test(text)) return "probe_unavailable";
  if (exitCode === 124 || /timed out|timeout/.test(text)) return "timeout";
  if (/connection refused|network is unreachable|no route to host|name or service not known|temporarily unavailable/.test(text)) {
    return "connect_failed";
  }
  return "handshake_failed";
}
