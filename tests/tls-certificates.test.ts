import { describe, expect, it } from "vitest";
import {
  classifyTlsProbeFailure,
  groupTlsEndpoints,
  hostnameMatchesCertificate,
  parseHttpsOrigin,
  parseSubjectAltNames,
  parseSubjectCommonName,
  tlsConnectTarget,
  tlsDaysRemaining,
  tlsProbeDueAt,
  tlsWebEntryBadge,
} from "../src/shared/tls-certificates.js";
import { extractLeafCertificatePem, parseTlsCertificatePem, parseTlsProbeOutput } from "../src/server/tls-certificates.js";

const leafPem = `-----BEGIN CERTIFICATE-----
MIIC5DCCAcygAwIBAgIJAPF8qfu29bACMA0GCSqGSIb3DQEBCwUAMBoxGDAWBgNV
BAMMD2FwcC5leGFtcGxlLmNvbTAeFw0yNjA4MjYxMjE5NDBaFw0yNjA5MjUxMjE5
NDBaMBoxGDAWBgNVBAMMD2FwcC5leGFtcGxlLmNvbTCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAL/QP2J3Zcba68aq5mvmuDikBzLpP2O1vnFZA5n4zuEx
2+jI0AF3YnI1bkWzVy5bGMTJ9PtshupyslJEpsmec0kpKf94NJBoe7nkclxC70UI
X/Klvx7A5tuBHPkUXD5B3/RZZ7zill0q11ufa9qOknlsVyTh52yO8iwmYA2dBaCb
b0kl6yTLXk64Yc2AaRVpiFuYBJocZpJ7qs3qldINtUsNFdIljg3Iy3GXa/Xs1QX9
NB29ebZwZPgpvBsixT1izpt2kUIxyYSqk6AghaUFdBzfaN9G1/n9KkZuKGNWCUfN
0EWI7wi1d0XLgx/KnYPvFkBPSFDo5mlos/XXIOO2vEECAwEAAaMtMCswKQYDVR0R
BCIwIIIPYXBwLmV4YW1wbGUuY29tgg0qLmV4YW1wbGUuY29tMA0GCSqGSIb3DQEB
CwUAA4IBAQAEGoqI/xm6ucV34O5h6l1cr9MYA2/P69IYkl87GDIyxEfYefUk/paa
9y2z8/C668Ym6Z9PxksU3GeffJ6TJBhVZDd9hgCqVGDflEymUMAtur6rpKKBO6MV
KicZWAVUBhrwrZhWSTS7bokJls8u2HAfDC2Vb3MgvSKTjCJB+kURG2wBuA+7ty97
K59yO7apswVh3AZTTxaSJLIq00gtm+LKN19vbUhEheJxkxToxl1Ka2GDj62x99Lv
D0ts+GliXAOz6LRrlzF1lzGH/eZ8Q8faeglZCm6wTvJ5imym20AVyPkSks/A2tXn
Ora+Pq14wMcIueA5/E+kx6/T7zRjA1Z6
-----END CERTIFICATE-----`;

describe("TLS certificate helpers", () => {
  it("parses https origins and rejects plain http", () => {
    expect(parseHttpsOrigin("https://app.example.com/login")).toEqual({ host: "app.example.com", port: 443, sni: "app.example.com" });
    expect(parseHttpsOrigin("https://app.example.com:8443/")).toEqual({ host: "app.example.com", port: 8443, sni: "app.example.com" });
    expect(parseHttpsOrigin("http://app.example.com")).toBeNull();
  });

  it("matches wildcard SAN and formats connect targets", () => {
    expect(hostnameMatchesCertificate("app.example.com", "app.example.com", ["*.example.com"])).toBe(true);
    expect(hostnameMatchesCertificate("other.example.net", "app.example.com", ["*.example.com"])).toBe(false);
    expect(tlsConnectTarget("::1", 443)).toBe("[::1]:443");
    expect(tlsConnectTarget("127.0.0.1", 443)).toBe("127.0.0.1:443");
  });

  it("parses openssl output into a public snapshot", () => {
    const snapshot = parseTlsCertificatePem(leafPem, "app.example.com", Date.parse("2026-08-26T12:19:40Z"));
    expect(snapshot.leafCn).toBe("app.example.com");
    expect(snapshot.leafSans).toEqual(["app.example.com", "*.example.com"]);
    expect(snapshot.isSelfSigned).toBe(true);
    expect(snapshot.hostnameMatch).toBe(true);
    expect(snapshot.daysRemaining).toBe(30);
    expect(extractLeafCertificatePem(`noise\n${leafPem}\nVerify return code: 18 (self signed certificate)`)).toContain("BEGIN CERTIFICATE");
    expect(parseTlsProbeOutput(`${leafPem}\nVerify return code: 0 (ok)\n`, "", 0, "app.example.com", "2026-08-26T12:19:40.000Z")).toMatchObject({
      status: "ok",
      chainComplete: true,
      leafCn: "app.example.com",
    });
    expect(classifyTlsProbeFailure("", "openssl: command not found", 127)).toBe("probe_unavailable");
    expect(tlsDaysRemaining("2026-08-27T00:00:00.000Z", Date.parse("2026-08-26T00:00:00.000Z"))).toBe(1);
  });

  it("groups endpoints by fingerprint and builds web-entry badges", () => {
    const endpoint = {
      id: "endpoint-1",
      environmentId: "env",
      sshConnectionId: "ssh",
      sshConnectionName: "web-1",
      sshHost: "app.example.com",
      host: "app.example.com",
      port: 443,
      sni: "app.example.com",
      source: "web_entry" as const,
      observeEnabled: true,
      customized: false,
      sortOrder: 0,
      probeStatus: "ok" as const,
      probeError: "",
      probedAt: "2026-08-26T00:00:00.000Z",
      leafCn: "app.example.com",
      leafSans: ["app.example.com"],
      issuer: "app.example.com",
      serial: "1",
      signatureAlgorithm: "",
      notBefore: "2026-08-01T00:00:00.000Z",
      notAfter: "2026-09-01T00:00:00.000Z",
      fingerprintSha256: "aa".repeat(32),
      isSelfSigned: true,
      hostnameMatch: true,
      chainComplete: true,
      daysRemaining: 6,
      webEntries: [],
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    expect(groupTlsEndpoints([endpoint])[0]?.key).toBe(endpoint.fingerprintSha256);
    expect(tlsWebEntryBadge([endpoint], 14)).toMatchObject({ status: "expiring", daysRemaining: 6 });
    expect(tlsProbeDueAt(endpoint, 14, Date.parse("2026-08-26T00:10:00.000Z"))).toBeGreaterThan(Date.parse(endpoint.probedAt!));
    expect(parseSubjectCommonName("CN=app.example.com")).toBe("app.example.com");
    expect(parseSubjectAltNames("DNS:app.example.com, DNS:*.example.com")).toEqual(["app.example.com", "*.example.com"]);
  });
});
