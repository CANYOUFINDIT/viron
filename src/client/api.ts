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

async function requestApi<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      throw new ApiError(message, response.status, body.error);
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
    throw new ApiError(message, response.status, body.error);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  recordConnectionQualityTraffic("download", connectionQualityByteLength(text));
  return JSON.parse(text) as T;
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
