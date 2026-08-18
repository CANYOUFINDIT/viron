export const MAX_ENVIRONMENT_LOG_FILES = 10;
export const DEFAULT_ENVIRONMENT_LOG_LINES = 200;
export const MIN_ENVIRONMENT_LOG_LINES = 1;
export const MAX_ENVIRONMENT_LOG_LINES = 5000;

export function parseStoredLogFilePaths(value: unknown, fallback: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) {
      const paths = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
      if (paths.length) return paths;
    }
  } catch {
    // Older rows only have file_path; fall through to the compatibility value.
  }
  return typeof fallback === "string" && fallback.length > 0 ? [fallback] : [];
}

export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildSshLogTailCommand(filePaths: string[], initialLines: number): string {
  validateLogRequest(filePaths, initialLines);
  return `tail -n ${initialLines} -F -- ${filePaths.map(quotePosixShellArg).join(" ")}`;
}

export function buildSshLogSnapshotCommand(filePaths: string[], initialLines: number): string {
  validateLogRequest(filePaths, initialLines);
  return `tail -n ${initialLines} -- ${filePaths.map(quotePosixShellArg).join(" ")}`;
}

function validateLogRequest(filePaths: string[], initialLines: number): void {
  if (!Number.isInteger(initialLines) || initialLines < MIN_ENVIRONMENT_LOG_LINES || initialLines > MAX_ENVIRONMENT_LOG_LINES) {
    throw new Error(`初始行数必须是 ${MIN_ENVIRONMENT_LOG_LINES}–${MAX_ENVIRONMENT_LOG_LINES} 的整数`);
  }
  if (!filePaths.length || filePaths.length > MAX_ENVIRONMENT_LOG_FILES) {
    throw new Error(`日志文件数量必须是 1–${MAX_ENVIRONMENT_LOG_FILES}`);
  }
  if (filePaths.some((filePath) => !filePath.startsWith("/") || /[\0\r\n]/.test(filePath))) {
    throw new Error("日志文件必须是无换行的绝对路径");
  }
}
