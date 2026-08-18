const SECRET_KEY = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|private[_-]?key)/i;

const SECRET_PATTERNS: Array<[RegExp, string | ((substring: string, ...args: string[]) => string)]> = [
  [/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/(\bAuthorization\b\s*:\s*)(?:Bearer\s+)?[^\s,;]+/gi, (_match, prefix) => `${prefix}[REDACTED]`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_ACCESS_KEY]"],
  [/\b(?:sk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_TOKEN]"],
  [/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*)([^\s,;]+)/gi, (_match, prefix) => `${prefix}[REDACTED]`],
  [/(:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g, (_match, prefix, _secret, suffix) => `${prefix}[REDACTED]${suffix}`],
];

export function redactAgentSensitiveText(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = typeof replacement === "string" ? result.replace(pattern, replacement) : result.replace(pattern, replacement);
  }
  return result;
}

export function redactAgentSensitiveValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const redact = (input: unknown, key = "", depth = 0): unknown => {
    if (SECRET_KEY.test(key)) return "[REDACTED]";
    if (typeof input === "string") return redactAgentSensitiveText(input);
    if (input === null || typeof input !== "object" || depth >= 8) return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => redact(item, "", depth + 1));
    return Object.fromEntries(Object.entries(input).map(([entryKey, item]) => [entryKey, redact(item, entryKey, depth + 1)]));
  };
  return redact(value);
}
