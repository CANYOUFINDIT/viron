export function isUniqueConstraintError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ER_DUP_ENTRY"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    || /\bUNIQUE\b/i.test(String(error));
}
