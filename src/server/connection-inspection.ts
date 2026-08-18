import type { FastifyInstance } from "fastify";
import { connectDatabase } from "./database-workbench/connector.js";
import { connectSsh } from "./ssh/connector.js";
import { connectRedis } from "./redis/connector.js";

export type InspectableConnectionType = "ssh" | "database" | "redis";

function inspectionError(error: unknown): string {
  const value = error as { code?: string; message?: string; sqlMessage?: string };
  if (value.code === "ER_ACCESS_DENIED_ERROR" || /authentication|wrongpass|noauth/i.test(value.message ?? "")) return "认证失败，请检查用户名和凭据";
  if (value.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(value.message ?? "")) return "目标端口拒绝连接";
  if (value.code === "ETIMEDOUT" || /timed out/i.test(value.message ?? "")) return "连接超时";
  if (/ENOTFOUND|EAI_AGAIN/i.test(value.message ?? "")) return "无法解析主机地址";
  if (/Host key/i.test(value.message ?? "")) return "SSH 主机指纹不匹配";
  return value.sqlMessage || value.message || String(error);
}

export async function inspectConnection(app: FastifyInstance, type: InspectableConnectionType, connectionId: string): Promise<{ latencyMs: number; message: string }> {
  const started = Date.now();
  try {
    if (type === "ssh") {
      const connected = await connectSsh(app, connectionId);
      connected.close();
    } else if (type === "database") {
      const connected = await connectDatabase(app, connectionId);
      try {
        await connected.connection.query("SELECT 1 AS envman_connection_check");
      } finally {
        await connected.close();
      }
    } else {
      const connected = await connectRedis(app, connectionId);
      try {
        await connected.client.ping();
      } finally {
        await connected.close();
      }
    }
    return { latencyMs: Date.now() - started, message: "连接成功" };
  } catch (error) {
    throw new Error(inspectionError(error));
  }
}
