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
  webEntries: TlsWebEntryLink[];
  createdAt: string;
  updatedAt: string;
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
  status: "ok" | "expiring" | "expired" | "mismatch" | "unbound" | "unknown";
  daysRemaining: number | null;
  endpointId: string | null;
  fingerprintSha256: string;
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
  if (!host || host.length > 253 || /[\s\0\r\n;|&$`'<>\\"]/.test(host)) return false;
  return DNS_HOST.test(host) || IPV4.test(host) || (host.includes(":") && IPV6.test(host));
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

export function formatFingerprint(value: string): string {
  const hex = normalizeFingerprint(value);
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

export function tlsWebEntryBadge(
  endpoints: Array<Pick<TlsEndpoint, "id" | "sshConnectionId" | "probeStatus" | "daysRemaining" | "hostnameMatch" | "fingerprintSha256">>,
  warnDays = DEFAULT_TLS_WARN_DAYS,
): TlsWebEntryBadge | null {
  if (!endpoints.length) return null;
  const bound = endpoints.filter((item) => item.sshConnectionId);
  if (!bound.length) {
    return { status: "unbound", daysRemaining: null, endpointId: endpoints[0]?.id ?? null, fingerprintSha256: "" };
  }
  const expired = bound.find((item) => item.daysRemaining != null && item.daysRemaining < 0);
  if (expired) return { status: "expired", daysRemaining: expired.daysRemaining, endpointId: expired.id, fingerprintSha256: expired.fingerprintSha256 };
  const expiring = bound
    .filter((item) => item.daysRemaining != null && item.daysRemaining <= warnDays)
    .sort((left, right) => (left.daysRemaining ?? 0) - (right.daysRemaining ?? 0))[0];
  if (expiring) return { status: "expiring", daysRemaining: expiring.daysRemaining, endpointId: expiring.id, fingerprintSha256: expiring.fingerprintSha256 };
  const mismatch = bound.find((item) => item.hostnameMatch === false);
  if (mismatch) return { status: "mismatch", daysRemaining: mismatch.daysRemaining, endpointId: mismatch.id, fingerprintSha256: mismatch.fingerprintSha256 };
  const ok = bound.find((item) => item.probeStatus === "ok");
  if (ok) return { status: "ok", daysRemaining: ok.daysRemaining, endpointId: ok.id, fingerprintSha256: ok.fingerprintSha256 };
  return { status: "unknown", daysRemaining: null, endpointId: bound[0]?.id ?? null, fingerprintSha256: bound[0]?.fingerprintSha256 ?? "" };
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
