export const MIN_LOG_DISPLAY_LINES = 1;
export const MAX_LOG_DISPLAY_LINES = 5000;
export const DEFAULT_LOG_DISPLAY_LINES = 5000;
export const MIN_LOG_CONTEXT_LINES = 0;
export const MAX_LOG_CONTEXT_LINES = 200;

export interface LogFilterOptions {
  keyword: string;
  caseSensitive: boolean;
  before: number;
  after: number;
}

export interface LogFilterResult {
  output: string;
  totalLineCount: number;
  matchLineCount: number;
  includedLineCount: number;
  filtered: boolean;
  hasGaps: boolean;
}

export function normalizeLogInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
}

export function countLogLines(output: string): number {
  return output ? output.split("\n").length : 0;
}

export function tailLogLines(output: string, maxLines: number): string {
  if (!output) return "";
  const limit = normalizeLogInteger(maxLines, MIN_LOG_DISPLAY_LINES, MAX_LOG_DISPLAY_LINES, DEFAULT_LOG_DISPLAY_LINES);
  const lines = output.split("\n");
  return lines.length > limit ? lines.slice(lines.length - limit).join("\n") : output;
}

export function filterLogOutput(output: string, options: LogFilterOptions): LogFilterResult {
  const lines = output ? output.split("\n") : [];
  const totalLineCount = lines.length;
  const keyword = options.keyword.trim();
  if (!keyword) {
    return {
      output,
      totalLineCount,
      matchLineCount: 0,
      includedLineCount: totalLineCount,
      filtered: false,
      hasGaps: false,
    };
  }

  const before = normalizeLogInteger(options.before, MIN_LOG_CONTEXT_LINES, MAX_LOG_CONTEXT_LINES, 0);
  const after = normalizeLogInteger(options.after, MIN_LOG_CONTEXT_LINES, MAX_LOG_CONTEXT_LINES, 0);
  const needle = options.caseSensitive ? keyword : keyword.toLowerCase();
  const included = new Set<number>();
  let matchLineCount = 0;

  lines.forEach((line, index) => {
    const haystack = options.caseSensitive ? line : line.toLowerCase();
    if (!haystack.includes(needle)) return;
    matchLineCount += 1;
    for (let current = Math.max(0, index - before); current <= Math.min(lines.length - 1, index + after); current += 1) {
      included.add(current);
    }
  });

  const selected = [...included].sort((left, right) => left - right);
  const rendered: string[] = [];
  let previous = -1;
  let hasGaps = false;
  for (const index of selected) {
    if (previous >= 0 && index > previous + 1) {
      rendered.push("--");
      hasGaps = true;
    }
    rendered.push(lines[index]!);
    previous = index;
  }

  return {
    output: rendered.join("\n"),
    totalLineCount,
    matchLineCount,
    includedLineCount: selected.length,
    filtered: true,
    hasGaps,
  };
}
