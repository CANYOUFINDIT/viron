import { currentLocale, localizeMessage, translate as tr } from "./i18n";
import { desktopRequest, isDesktopApp } from "./desktop";
import { dispatchConnectionLimit } from "./connection-limit";
import { connectionQualityByteLength, recordConnectionQualityTraffic } from "./connection-quality-traffic";
import { isAuthenticationRequired, notifyAuthenticationRequired } from "./authentication-required";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

interface ApiPrefetchEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}

const apiPrefetches = new Map<string, ApiPrefetchEntry>();

function requestMethod(init: RequestInit): string {
  return (init.method || "GET").toUpperCase();
}

function prefetchedResponse<T>(path: string): Promise<T> | null {
  const entry = apiPrefetches.get(path);
  if (!entry) return null;
  apiPrefetches.delete(path);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.promise as Promise<T>;
}

export function clearApiPrefetches(): void {
  apiPrefetches.clear();
}

export function isAuthenticationRequiredError(error: unknown): boolean {
  return error instanceof ApiError && isAuthenticationRequired(error.status, error.code);
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, Math.ceil(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : undefined;
}

function waitForRetry(delay: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function requestApiOnce<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept-Language", currentLocale());
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (init.body) recordConnectionQualityTraffic("upload", connectionQualityByteLength(init.body));
  if (isDesktopApp()) {
    const response = await desktopRequest(path, { ...init, headers });
    recordConnectionQualityTraffic("download", connectionQualityByteLength(response.body));
    if (response.status < 200 || response.status >= 300) {
      let body: { message?: string; error?: string } = {};
      try { body = JSON.parse(response.body) as typeof body; } catch { /* Use the HTTP fallback below. */ }
      const message = body.message ? localizeMessage(body.message) : tr("请求失败（{{0}}）", [response.status]);
      if (body.error === "USER_CONNECTION_LIMIT") dispatchConnectionLimit(message);
      notifyAuthenticationRequired(response.status, body.error);
      throw new ApiError(message, response.status, body.error, retryAfterMilliseconds(new Headers(response.headers).get("retry-after")));
    }
    if (response.status === 204 || !response.body) return undefined as T;
    return JSON.parse(response.body) as T;
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.message ? localizeMessage(body.message) : tr("请求失败（{{0}}）", [response.status]);
    if (body.error === "USER_CONNECTION_LIMIT") dispatchConnectionLimit(message);
    notifyAuthenticationRequired(response.status, body.error);
    throw new ApiError(message, response.status, body.error, retryAfterMilliseconds(response.headers.get("retry-after")));
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  recordConnectionQualityTraffic("download", connectionQualityByteLength(text));
  return JSON.parse(text) as T;
}

async function requestApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await requestApiOnce<T>(path, init);
  } catch (error) {
    // Retry a read only once, honoring the server's cooldown and cancellation.
    // Mutations stay explicit so a retry cannot repeat a user operation.
    if (!(error instanceof ApiError) || error.status !== 429 || requestMethod(init) !== "GET" || init.body
      || error.retryAfterMs === undefined || error.retryAfterMs > 60_000) throw error;
    await waitForRetry(error.retryAfterMs, init.signal);
    return requestApiOnce<T>(path, init);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (requestMethod(init) === "GET" && !init.body) {
    const prefetched = prefetchedResponse<T>(path);
    if (prefetched) return prefetched;
  } else {
    clearApiPrefetches();
  }
  return requestApi<T>(path, init);
}

export function transientApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestApi<T>(path, init);
}

export function prefetchApi<T>(path: string, ttlMs = 15_000, init: RequestInit = {}): Promise<T> {
  if (requestMethod(init) !== "GET" || init.body) return Promise.reject(new Error("API prefetch only supports GET requests"));
  const existing = apiPrefetches.get(path);
  if (existing && existing.expiresAt > Date.now()) return existing.promise as Promise<T>;
  if (existing) apiPrefetches.delete(path);

  const promise = requestApi<T>(path, init);
  const entry: ApiPrefetchEntry = {
    expiresAt: Date.now() + Math.max(1_000, ttlMs),
    promise,
  };
  apiPrefetches.set(path, entry);
  void promise.catch(() => {
    if (apiPrefetches.get(path) === entry) apiPrefetches.delete(path);
  });
  return promise;
}
