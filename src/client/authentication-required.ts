const AUTHENTICATION_REQUIRED_CODES = new Set(["SESSION_EXPIRED", "UNAUTHENTICATED"]);

const listeners = new Set<() => void>();

export function isAuthenticationRequired(status: number, code?: string): boolean {
  return status === 401 && Boolean(code && AUTHENTICATION_REQUIRED_CODES.has(code));
}

export function notifyAuthenticationRequired(status: number, code?: string): boolean {
  if (!isAuthenticationRequired(status, code)) return false;
  for (const listener of listeners) listener();
  return true;
}

export function onAuthenticationRequired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
