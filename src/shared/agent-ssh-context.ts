import type { AgentSshContextSnapshot } from "./agent.js";

const AGENT_SSH_OUTPUT_MAX_BYTES = 3 * 1024;
const AGENT_SSH_OUTPUT_MAX_LINES = 120;

export interface AgentSshOutputSummary {
  output: string;
  includedBytes: number;
  lineCount: number;
  truncated: boolean;
  redactionCount: number;
}

interface AgentSshOutputLimits {
  maxBytes?: number;
  maxLines?: number;
}

function replaceAndCount(value: string, pattern: RegExp, replacement: string | ((substring: string, ...args: string[]) => string)) {
  let count = 0;
  const output = value.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === "string" ? replacement : replacement(...args);
  });
  return { output, count };
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function redactAgentSshOutput(value: string): { output: string; redactionCount: number } {
  const replacements: Array<[RegExp, string | ((substring: string, ...args: string[]) => string)]> = [
    [/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g, "[REDACTED_PRIVATE_KEY]"],
    [/(\bAuthorization\b\s*:\s*)(?:Bearer\s+)?[^\s,;]+/gi, (_match, prefix) => `${prefix}[REDACTED]`],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_ACCESS_KEY]"],
    [/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*)([^\s,;]+)/gi, (_match, prefix) => `${prefix}[REDACTED]`],
    [/(:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g, (_match, prefix, _secret, suffix) => `${prefix}[REDACTED]${suffix}`],
  ];
  let output = value;
  let redactionCount = 0;
  for (const [pattern, replacement] of replacements) {
    const result = replaceAndCount(output, pattern, replacement);
    output = result.output;
    redactionCount += result.count;
  }
  return { output, redactionCount };
}

function tailUtf8(value: string, maxBytes: number): { output: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { output: value, truncated: false };
  return {
    output: encoded.subarray(encoded.length - maxBytes).toString("utf8").replace(/^\uFFFD+/, ""),
    truncated: true,
  };
}

export function summarizeAgentSshOutput(value: Buffer | string, limits: AgentSshOutputLimits = {}): AgentSshOutputSummary {
  const maxBytes = Math.max(1_024, Math.min(128 * 1024, limits.maxBytes ?? AGENT_SSH_OUTPUT_MAX_BYTES));
  const maxLines = Math.max(1, Math.min(2_000, limits.maxLines ?? AGENT_SSH_OUTPUT_MAX_LINES));
  const plain = stripTerminalControlSequences(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  const redacted = redactAgentSshOutput(plain);
  const lines = redacted.output.split("\n");
  const lineTruncated = lines.length > maxLines;
  const lineBounded = (lineTruncated ? lines.slice(-maxLines) : lines).join("\n");
  const byteBounded = tailUtf8(lineBounded, maxBytes);
  const output = byteBounded.output.trim();
  return {
    output,
    includedBytes: Buffer.byteLength(output, "utf8"),
    lineCount: output ? output.split("\n").length : 0,
    truncated: lineTruncated || byteBounded.truncated,
    redactionCount: redacted.redactionCount,
  };
}

export function agentSshContextSnapshot(input: {
  sessionId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  output: Buffer | string;
  executionTarget: "desktop-local" | "server-forwarded";
}): AgentSshContextSnapshot {
  return {
    sessionId: input.sessionId,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    host: input.host,
    executionTarget: input.executionTarget,
    capturedAt: new Date().toISOString(),
    ...summarizeAgentSshOutput(input.output),
  };
}
