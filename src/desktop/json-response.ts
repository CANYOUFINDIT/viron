export interface DesktopJsonResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

export type DesktopDatabaseResponse = DesktopJsonResponse;
export type DesktopRedisResponse = DesktopJsonResponse;
export type DesktopInspectionResponse = DesktopJsonResponse;

export function jsonResponse(status: number, body?: unknown): DesktopJsonResponse {
  return {
    status,
    statusText: status === 204 ? "No Content" : status >= 400 ? "Error" : "OK",
    headers: body === undefined ? [] : [["content-type", "application/json; charset=utf-8"]],
    body: body === undefined ? "" : JSON.stringify(body),
  };
}
