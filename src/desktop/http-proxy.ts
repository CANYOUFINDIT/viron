import { basename } from "node:path";
import { activeEndpoint, currentExecutionMode, executionScopeForEndpoint } from "./endpoint-context.js";
import { translate as tr } from "./i18n.js";

export interface DesktopRequestBody {
  kind: "text" | "form";
  value?: string;
  entries?: Array<{
    name: string;
    value?: string;
    file?: { name: string; type: string; data: ArrayBuffer };
  }>;
}

export interface DesktopRequest {
  path: string;
  method?: string;
  headers?: Array<[string, string]>;
  body?: DesktopRequestBody;
}

export class DesktopApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function requestUrl(path: string): string {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  if (!path.startsWith("/api/") && path !== "/healthz") throw new Error(tr("App 只允许访问 Viron API"));
  const url = new URL(path, activeEndpoint.endpoint);
  if (url.origin !== activeEndpoint.endpoint) throw new Error(tr("请求不能离开当前 Endpoint"));
  return url.href;
}

export function requestBody(body: DesktopRequestBody | undefined): BodyInit | undefined {
  if (!body) return undefined;
  if (body.kind === "text") return body.value ?? "";
  const form = new FormData();
  for (const entry of body.entries ?? []) {
    if (entry.file) {
      form.append(entry.name, new Blob([new Uint8Array(entry.file.data)], { type: entry.file.type }), entry.file.name);
    } else {
      form.append(entry.name, entry.value ?? "");
    }
  }
  return form;
}

export async function endpointFetch(request: DesktopRequest, signal?: AbortSignal): Promise<Response> {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  const headers = new Headers(request.headers ?? []);
  headers.set("X-Viron-API-Protocol", String(activeEndpoint.protocolVersion));
  headers.set("X-Viron-Execution-Scope", executionScopeForEndpoint(activeEndpoint.endpoint));
  headers.set("X-Viron-Execution-Mode", currentExecutionMode());
  return activeEndpoint.partition.fetch(requestUrl(request.path), {
    method: request.method ?? "GET",
    headers,
    body: requestBody(request.body),
    credentials: "include",
    redirect: "error",
    signal,
  });
}

export async function endpointJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await endpointFetch({
    path,
    method: init.method,
    headers: init.body === undefined ? undefined : [["content-type", "application/json"]],
    body: init.body === undefined ? undefined : { kind: "text", value: JSON.stringify(init.body) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as T & { error?: string; message?: string } : {} as T & { error?: string; message?: string };
  if (!response.ok) throw new DesktopApiError(response.status, body.error ?? "API_ERROR", body.message ?? tr("请求失败（HTTP {{0}}）", [response.status]));
  return body;
}

export function suggestedFilename(response: Response, path: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const value = encoded ? decodeURIComponent(encoded) : plain;
  return basename(value || new URL(path, "https://local.invalid").pathname || "viron-download");
}
