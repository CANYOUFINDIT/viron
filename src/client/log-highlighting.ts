export type LogSeverity = "critical" | "error" | "warning" | "info" | "debug" | "trace" | "unknown";

export interface LogHighlightOptions {
  semantic?: boolean;
  keyword?: string;
  keywordCaseSensitive?: boolean;
}

const SEVERITY_PATTERNS: Array<[LogSeverity, RegExp]> = [
  ["critical", /\b(?:EMERG(?:ENCY)?|FATAL|CRIT(?:ICAL)?)\b/i],
  ["error", /\b(?:ERR(?:OR)?|EROR|SEVERE)\b/i],
  ["warning", /\bWARN(?:ING)?\b/i],
  ["info", /\b(?:INFO(?:RMATION(?:AL)?)?|NOTICE)\b/i],
  ["debug", /\b(?:DBUG|DEBUG)\b/i],
  ["trace", /\bTRACE\b/i],
];

const EXCEPTION_PATTERN = /(?:^|[\s,:[({])(?:[\w.$]+)?(?:Exception|Error)(?=[:\s,\])}]|$)/i;
const STACK_CONTINUATION_PATTERN = /^\s*(?:at\s+|Caused by:|Suppressed:|\.\.\.\s+\d+\s+more\b)/i;
const TIMESTAMP_PATTERN = /\b\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const LEVEL_PATTERN = /\b(?:EMERG(?:ENCY)?|FATAL|CRIT(?:ICAL)?|ERR(?:OR)?|EROR|SEVERE|WARN(?:ING)?|INFO(?:RMATION(?:AL)?)?|NOTICE|DBUG|DEBUG|TRACE)\b/gi;
const DURATION_PATTERN = /\b(?:duration|elapsed|latency|cost|took|useTime|mqUseTime)\s*[:=]\s*\d+(?:\.\d+)?\s*(?:ns|[μµ]?s|ms|s|m)\b/gi;
const IDENTIFIER_PATTERN = /\b(?:traceId|spanId|requestId|reqId|messageId|jobId|taskId|id)\s*[:=]\s*[\w.-]+/gi;
const HTTP_STATUS_PATTERN = /\b(?:status|statusCode|httpStatus)\s*[:=]\s*[1-5]\d{2}\b/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

interface MatchRange {
  start: number;
  end: number;
  kind: "timestamp" | "level" | "duration" | "identifier" | "status" | "ip" | "keyword";
  text: string;
}

export function classifyLogSeverity(line: string): LogSeverity {
  for (const [severity, pattern] of SEVERITY_PATTERNS) {
    if (pattern.test(line)) return severity;
  }
  return EXCEPTION_PATTERN.test(line) ? "error" : "unknown";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function collectKeywordMatches(line: string, options: LogHighlightOptions): MatchRange[] {
  const keyword = options.keyword?.trim() ?? "";
  if (!keyword) return [];
  const haystack = options.keywordCaseSensitive ? line : line.toLowerCase();
  const needle = options.keywordCaseSensitive ? keyword : keyword.toLowerCase();
  const matches: MatchRange[] = [];
  let cursor = 0;
  while (cursor < haystack.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start < 0) break;
    const end = start + needle.length;
    matches.push({ start, end, kind: "keyword", text: line.slice(start, end) });
    cursor = end;
  }
  return matches;
}

function collectMatches(line: string, options: LogHighlightOptions): MatchRange[] {
  const matches: MatchRange[] = [];
  matches.push(...collectKeywordMatches(line, options));
  if (options.semantic === false) return matches;
  const patterns: Array<[MatchRange["kind"], RegExp]> = [
    ["timestamp", TIMESTAMP_PATTERN],
    ["level", LEVEL_PATTERN],
    ["duration", DURATION_PATTERN],
    ["identifier", IDENTIFIER_PATTERN],
    ["status", HTTP_STATUS_PATTERN],
    ["ip", IPV4_PATTERN],
  ];
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      const start = match.index;
      const text = match[0];
      const end = start + text.length;
      if (!matches.some((existing) => start < existing.end && end > existing.start)) matches.push({ start, end, kind, text });
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

function severityForLevelToken(value: string): LogSeverity {
  return classifyLogSeverity(value);
}

function statusClass(value: string): string {
  const status = Number(value.match(/[1-5]\d{2}/)?.[0]);
  if (status >= 500) return " log-token--status-error";
  if (status >= 400) return " log-token--status-warning";
  if (status >= 200 && status < 400) return " log-token--status-ok";
  return "";
}

function renderLine(line: string, severity: LogSeverity, options: LogHighlightOptions): string {
  const matches = collectMatches(line, options);
  let cursor = 0;
  let content = "";
  for (const match of matches) {
    content += escapeHtml(line.slice(cursor, match.start));
    const modifier = match.kind === "level"
      ? ` log-token--${severityForLevelToken(match.text)}`
      : match.kind === "status" ? statusClass(match.text) : "";
    content += `<span class="log-token log-token--${match.kind}${modifier}">${escapeHtml(match.text)}</span>`;
    cursor = match.end;
  }
  content += escapeHtml(line.slice(cursor));
  return `<span class="log-line log-line--${severity}">${content || "&#8203;"}</span>`;
}

export function renderHighlightedLogHtml(output: string, options: LogHighlightOptions = {}): string {
  let previousSeverity: LogSeverity = "unknown";
  const semantic = options.semantic !== false;
  return output.split(/\r?\n/).map((line) => {
    let severity = semantic ? classifyLogSeverity(line) : "unknown";
    if (severity === "unknown" && STACK_CONTINUATION_PATTERN.test(line) && (previousSeverity === "critical" || previousSeverity === "error")) {
      severity = previousSeverity;
    }
    if (severity !== "unknown" && line.trim()) previousSeverity = severity;
    else if (line.trim() && !STACK_CONTINUATION_PATTERN.test(line)) previousSeverity = "unknown";
    return renderLine(line, severity, options);
  }).join("");
}
