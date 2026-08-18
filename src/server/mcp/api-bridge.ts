import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InjectOptions } from "light-my-request";
import { resolveVironMcpApiRequest } from "../../shared/mcp-tools.js";
import type { McpApiRequest, McpApiResponse, VironMcpBackend } from "../../shared/mcp-protocol.js";
import { runWithAuditSource } from "../audit.js";

interface McpHttpContext {
  authorization: string;
  defaultWorkspace?: string;
  acceptLanguage?: string;
  executionScope: string;
  origin: string;
}

function responseData(body: string, rawPayload: Buffer, contentType: string | undefined, contentDisposition: string | undefined): unknown {
  if (!body && !rawPayload.length) return null;
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return { error: "INVALID_JSON_RESPONSE", message: "Viron API 返回了无效 JSON" };
    }
  }
  if (contentType?.startsWith("text/") || contentType?.includes("application/sql") || contentType?.includes("application/x-asciicast")) return body;
  return {
    contentType: contentType ?? "application/octet-stream",
    contentDisposition: contentDisposition ?? "",
    size: rawPayload.length,
    contentBase64: rawPayload.toString("base64"),
  };
}

function multipartPayload(form: NonNullable<McpApiRequest["form"]>): { contentType: string; payload: Buffer } {
  const boundary = `----viron-mcp-${randomUUID()}`;
  const chunks: Buffer[] = [];
  const append = (value: string | Buffer) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
  for (const [name, value] of Object.entries(form.fields ?? {})) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name=${JSON.stringify(name)}\r\n\r\n${value}\r\n`);
  }
  for (const file of form.files ?? []) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name=${JSON.stringify(file.fieldName)}; filename=${JSON.stringify(file.filename)}\r\nContent-Type: ${file.contentType}\r\n\r\n`);
    append(Buffer.from(file.contentBase64, "base64"));
    append("\r\n");
  }
  append(`--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) };
}

export class McpApiBridge implements VironMcpBackend {
  private readonly contexts = new AsyncLocalStorage<McpHttpContext>();

  constructor(private readonly app: FastifyInstance) {}

  runWithRequest<T>(request: FastifyRequest, executionScope: string, callback: () => Promise<T>): Promise<T> {
    const authorization = request.headers.authorization;
    if (!authorization) throw new Error("MCP 请求缺少认证信息");
    const workspaceHeader = request.headers["x-viron-workspace"];
    const languageHeader = request.headers["accept-language"];
    return this.contexts.run({
      authorization,
      defaultWorkspace: typeof workspaceHeader === "string" ? workspaceHeader : undefined,
      acceptLanguage: typeof languageHeader === "string" ? languageHeader : undefined,
      executionScope,
      origin: `${request.protocol}://${request.headers.host ?? request.hostname}`,
    }, callback);
  }

  async invoke(toolName: string, arguments_: Record<string, unknown>): Promise<McpApiResponse> {
    return this.invokeRequest(resolveVironMcpApiRequest(toolName, arguments_));
  }

  private async invokeRequest(input: McpApiRequest): Promise<McpApiResponse> {
    const context = this.contexts.getStore();
    if (!context) throw new Error("MCP 工具调用不在已认证请求上下文中");
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const url = `${input.path}${query.size ? `?${query.toString()}` : ""}`;
    const workspace = input.workspace?.trim() || context.defaultWorkspace;
    const headers: Record<string, string> = { authorization: context.authorization };
    if (workspace) headers["x-viron-workspace"] = workspace;
    if (context.acceptLanguage) headers["accept-language"] = context.acceptLanguage;
    headers["x-viron-execution-scope"] = context.executionScope;
    headers["x-viron-execution-mode"] = "server";
    headers["x-viron-mcp-origin"] = context.origin;
    const multipart = input.form ? multipartPayload(input.form) : null;
    if (multipart) headers["content-type"] = multipart.contentType;
    else if (input.body !== undefined) headers["content-type"] = "application/json";
    const options: InjectOptions = {
      method: input.method ?? "GET",
      url,
      headers,
      ...(multipart ? { payload: multipart.payload } : input.body === undefined ? {} : { payload: JSON.stringify(input.body) }),
    };
    const response = await runWithAuditSource("mcp", (auditHeaders) => this.app.inject({
      ...options,
      headers: { ...options.headers, ...auditHeaders },
    }));
    const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [
      name,
      typeof value === "number" ? String(value) : value,
    ]));
    return {
      status: response.statusCode,
      headers: responseHeaders,
      data: responseData(
        response.body,
        response.rawPayload,
        response.headers["content-type"]?.toString(),
        response.headers["content-disposition"]?.toString(),
      ),
    };
  }
}
