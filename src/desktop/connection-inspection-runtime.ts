import { translate as tr } from "./i18n.js";
import { randomUUID } from "node:crypto";
import type { DesktopDatabaseCredential, DesktopRedisCredential, DesktopSshCredential } from "./device-identity.js";
import { connectDesktopDatabase, desktopDatabaseErrorMessage } from "./database-runtime.js";
import { connectDesktopSsh, desktopSshErrorMessage, type DesktopSshContext } from "./ssh-runtime.js";
import { connectDesktopRedis, desktopRedisErrorMessage } from "./redis-runtime.js";

export type DesktopInspectionConnectionType = "ssh" | "database" | "redis";

export interface DesktopInspectionConnection {
  id: string;
  type: DesktopInspectionConnectionType;
  name: string;
  host: string;
  port: number;
}

export interface DesktopInspectionResult extends DesktopInspectionConnection {
  status: "available" | "unavailable";
  latencyMs: number;
  message: string;
  checkedAt: string;
}

export interface DesktopInspectionReportPayload {
  operationId: string;
  items: Array<Pick<DesktopInspectionResult, "type" | "id" | "status" | "latencyMs" | "message">>;
}

export interface DesktopInspectionResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

interface InspectionRequest {
  method?: string;
  body?: { kind: string; value?: string };
}

interface InspectionInput {
  items: Array<{ type: DesktopInspectionConnectionType; id: string }>;
}

class DesktopInspectionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function contextKey(context: DesktopSshContext): string {
  return `${context.endpoint}\0${context.userId}\0${context.workspaceType}\0${context.workspaceId}`;
}

function jsonResponse(status: number, body: unknown): DesktopInspectionResponse {
  return {
    status,
    statusText: status >= 400 ? "Error" : "OK",
    headers: [["content-type", "application/json; charset=utf-8"]],
    body: JSON.stringify(body),
  };
}

function parseInput(request: InspectionRequest): InspectionInput {
  if ((request.method ?? "GET").toUpperCase() !== "POST" || request.body?.kind !== "text") {
    throw new DesktopInspectionError(400, "INVALID_REQUEST", tr("连接巡检请求无效"));
  }
  let input: unknown;
  try {
    input = JSON.parse(request.body.value ?? "");
  } catch {
    throw new DesktopInspectionError(400, "INVALID_BODY", tr("连接巡检请求内容不是有效 JSON"));
  }
  const items = (input as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) {
    throw new DesktopInspectionError(400, "INVALID_REQUEST", tr("连接巡检数量必须在 1 到 500 之间"));
  }
  const normalized = items.map((item) => {
    const value = item as { type?: unknown; id?: unknown } | null;
    if (!value || !["ssh", "database", "redis"].includes(String(value.type)) || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
      throw new DesktopInspectionError(400, "INVALID_REQUEST", tr("连接巡检条目无效"));
    }
    return { type: value.type as DesktopInspectionConnectionType, id: value.id };
  });
  return { items: normalized };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export function isDesktopConnectionInspectionPath(path: string): boolean {
  return new URL(path, "http://desktop.local").pathname === "/api/v1/connections/inspect";
}

export class DesktopConnectionInspectionRuntime {
  constructor(
    private readonly loadConnections: () => Promise<{ items: DesktopInspectionConnection[] }>,
    private readonly loadSshCredential: (connectionId: string) => Promise<{ context: DesktopSshContext; credential: DesktopSshCredential }>,
    private readonly loadDatabaseCredential: (connectionId: string) => Promise<{ context: DesktopSshContext; credential: DesktopDatabaseCredential }>,
    private readonly loadRedisCredential: (connectionId: string) => Promise<{ context: DesktopSshContext; credential: DesktopRedisCredential }>,
    private readonly report: (payload: DesktopInspectionReportPayload, context: DesktopSshContext) => Promise<void>,
  ) {}

  async handle(request: InspectionRequest, context: DesktopSshContext): Promise<DesktopInspectionResponse> {
    try {
      const input = parseInput(request);
      const availableConnections = await this.loadConnections();
      const metadata = new Map(availableConnections.items.map((item) => [`${item.type}:${item.id}`, item]));
      const results = await mapWithConcurrency(input.items, 5, async (item): Promise<DesktopInspectionResult> => {
        const initial = metadata.get(`${item.type}:${item.id}`);
        const started = Date.now();
        if (!initial) {
          return {
            ...item,
            name: tr("已删除连接"),
            host: "",
            port: 0,
            status: "unavailable",
            latencyMs: 0,
            message: tr("连接不存在"),
            checkedAt: new Date().toISOString(),
          };
        }
        let current = initial;
        try {
          if (item.type === "ssh") {
            const loaded = await this.loadSshCredential(item.id);
            if (contextKey(loaded.context) !== contextKey(context)) throw new Error(tr("连接巡检期间用户或工作空间已切换"));
            current = {
              id: item.id,
              type: item.type,
              name: loaded.credential.connection.name,
              host: loaded.credential.connection.host,
              port: loaded.credential.connection.port,
            };
            const connected = await connectDesktopSsh(loaded.credential);
            connected.close();
          } else if (item.type === "database") {
            const loaded = await this.loadDatabaseCredential(item.id);
            if (contextKey(loaded.context) !== contextKey(context)) throw new Error(tr("连接巡检期间用户或工作空间已切换"));
            current = {
              id: item.id,
              type: item.type,
              name: loaded.credential.connection.name,
              host: loaded.credential.connection.host,
              port: loaded.credential.connection.port,
            };
            const connected = await connectDesktopDatabase(loaded.credential);
            try {
              await connected.connection.query("SELECT 1 AS envman_connection_check");
            } finally {
              await connected.close();
            }
          } else {
            const loaded = await this.loadRedisCredential(item.id);
            if (contextKey(loaded.context) !== contextKey(context)) throw new Error(tr("连接巡检期间用户或工作空间已切换"));
            current = {
              id: item.id,
              type: item.type,
              name: loaded.credential.connection.name,
              host: loaded.credential.connection.host,
              port: loaded.credential.connection.port,
            };
            const connected = await connectDesktopRedis(loaded.credential);
            try {
              await connected.client.ping();
            } finally {
              await connected.close();
            }
          }
          return {
            ...current,
            status: "available",
            latencyMs: Date.now() - started,
            message: tr("连接成功"),
            checkedAt: new Date().toISOString(),
          };
        } catch (error) {
          const message = item.type === "ssh" ? desktopSshErrorMessage(error) : item.type === "database" ? desktopDatabaseErrorMessage(error) : desktopRedisErrorMessage(error);
          return {
            ...current,
            status: "unavailable",
            latencyMs: Date.now() - started,
            message: message.slice(0, 8_192),
            checkedAt: new Date().toISOString(),
          };
        }
      });
      const operationId = randomUUID();
      await this.report({
        operationId,
        items: results.map(({ type, id, status, latencyMs, message }) => ({ type, id, status, latencyMs, message })),
      }, context);
      const available = results.filter((item) => item.status === "available").length;
      return jsonResponse(200, {
        summary: { total: results.length, available, unavailable: results.length - available },
        items: results,
      });
    } catch (error) {
      const known = error instanceof DesktopInspectionError;
      return jsonResponse(known ? error.status : 502, {
        error: known ? error.code : "DESKTOP_INSPECTION_FAILED",
        message: error instanceof Error ? error.message : tr("本机连接巡检失败"),
      });
    }
  }
}
