import { translate as tr } from "./i18n.js";
export const DESKTOP_API_PROTOCOL = { min: 1, max: 2 } as const;

export interface ServerForwardingCapabilities {
  enabled: boolean;
  web: boolean;
  ssh: boolean;
  sftp: boolean;
  logs: boolean;
  database: boolean;
  redis?: boolean;
}

export interface ProductCapabilities {
  product: string;
  productVersion: string;
  apiProtocol: { min: number; max: number };
  clientAccess?: { desktop: boolean; web: boolean };
  desktopLocal?: { web: boolean; ssh?: boolean; sftp?: boolean; logs?: boolean; database?: boolean; redis?: boolean; inspection?: boolean };
  mcp?: { server: { enabled: boolean; path: string; transport: "streamable-http"; authentication: "personal-api-key" } };
  serverForwarding: ServerForwardingCapabilities;
}

export interface ValidatedEndpoint {
  endpoint: string;
  protocolVersion: number;
  capabilities: ProductCapabilities;
}

export class EndpointValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeEndpoint(input: string): string {
  const value = input.trim();
  if (!/^https?:\/\//i.test(value)) {
    throw new EndpointValidationError("INVALID_ENDPOINT", tr("Endpoint 必须是完整的 HTTP(S) Origin"));
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EndpointValidationError("INVALID_ENDPOINT", tr("Endpoint 地址格式无效"));
  }

  if (url.username || url.password) {
    throw new EndpointValidationError("ENDPOINT_CREDENTIALS", tr("Endpoint 不能包含用户名或密码"));
  }
  if (url.href !== `${url.origin}/`) {
    throw new EndpointValidationError("ENDPOINT_NOT_ORIGIN", tr("Endpoint 只能填写 Origin，不能包含路径、查询参数或 Fragment"));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EndpointValidationError("INVALID_ENDPOINT_PROTOCOL", tr("Endpoint 只支持 HTTP(S)"));
  }
  return url.origin;
}

function capabilitiesFrom(value: unknown): ProductCapabilities {
  if (!value || typeof value !== "object") {
    throw new EndpointValidationError("NOT_VIRON", tr("Endpoint 返回的不是 Viron 能力信息"));
  }
  const body = value as Partial<ProductCapabilities>;
  const protocol = body.apiProtocol;
  const forwarding = body.serverForwarding;
  const desktopLocal = body.desktopLocal;
  const clientAccess = body.clientAccess;
  const mcp = body.mcp;
  if (
    body.product !== "viron"
    || typeof body.productVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(body.productVersion)
    || !protocol
    || !Number.isInteger(protocol.min)
    || !Number.isInteger(protocol.max)
    || protocol.min! < 1
    || protocol.max! < protocol.min!
    || (clientAccess !== undefined && (
      !clientAccess
      || typeof clientAccess !== "object"
      || typeof clientAccess.desktop !== "boolean"
      || typeof clientAccess.web !== "boolean"
    ))
    || (desktopLocal !== undefined && (
      !desktopLocal
      || typeof desktopLocal !== "object"
      || typeof desktopLocal.web !== "boolean"
      || (desktopLocal.ssh !== undefined && typeof desktopLocal.ssh !== "boolean")
      || (desktopLocal.sftp !== undefined && typeof desktopLocal.sftp !== "boolean")
      || (desktopLocal.logs !== undefined && typeof desktopLocal.logs !== "boolean")
      || (desktopLocal.database !== undefined && typeof desktopLocal.database !== "boolean")
      || (desktopLocal.redis !== undefined && typeof desktopLocal.redis !== "boolean")
      || (desktopLocal.inspection !== undefined && typeof desktopLocal.inspection !== "boolean")
    ))
    || (mcp !== undefined && (
      !mcp
      || typeof mcp !== "object"
      || !mcp.server
      || typeof mcp.server.enabled !== "boolean"
      || typeof mcp.server.path !== "string"
      || mcp.server.transport !== "streamable-http"
      || mcp.server.authentication !== "personal-api-key"
    ))
    || !forwarding
    || ["enabled", "web", "ssh", "sftp", "logs", "database"].some(
      (key) => typeof forwarding[key as keyof ServerForwardingCapabilities] !== "boolean",
    )
    || (forwarding.redis !== undefined && typeof forwarding.redis !== "boolean")
  ) {
    throw new EndpointValidationError("NOT_VIRON", tr("Endpoint 未返回可识别的 Viron 产品与协议信息"));
  }
  return body as ProductCapabilities;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new EndpointValidationError("ENDPOINT_RESPONSE", tr("{{0}}请求失败（HTTP {{1}}）", [label, response.status]));
  }
  try {
    return await response.json();
  } catch {
    throw new EndpointValidationError("NOT_VIRON", tr("{{0}}未返回有效 JSON", [label]));
  }
}

export async function validateEndpoint(
  input: string,
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ValidatedEndpoint> {
  const endpoint = normalizeEndpoint(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const fetcher = options.fetcher ?? fetch;

  try {
    const request = (path: string) => fetcher(`${endpoint}${path}`, {
      method: "GET",
      credentials: "include",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const healthBody = await readJson(await request("/healthz"), tr("健康检查"));
    const health = healthBody as { status?: unknown; product?: unknown };
    if (health.status !== "ok" || health.product !== "viron") {
      throw new EndpointValidationError("NOT_VIRON", tr("Endpoint 不是可识别的 Viron 服务"));
    }

    const capabilities = capabilitiesFrom(await readJson(await request("/api/v1/capabilities"), tr("能力协商")));
    const minimum = Math.max(DESKTOP_API_PROTOCOL.min, capabilities.apiProtocol.min);
    const maximum = Math.min(DESKTOP_API_PROTOCOL.max, capabilities.apiProtocol.max);
    if (minimum > maximum) {
      throw new EndpointValidationError(
        "INCOMPATIBLE_PROTOCOL",
        tr("App 支持 API 协议 {{0}}–{{1}}，中心服务支持 {{2}}–{{3}}，请升级 App 或中心服务", [DESKTOP_API_PROTOCOL.min, DESKTOP_API_PROTOCOL.max, capabilities.apiProtocol.min, capabilities.apiProtocol.max]),
      );
    }

    return { endpoint, protocolVersion: maximum, capabilities };
  } catch (error) {
    if (error instanceof EndpointValidationError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new EndpointValidationError("ENDPOINT_TIMEOUT", tr("连接 Endpoint 超时"));
    }
    throw new EndpointValidationError(
      "ENDPOINT_NETWORK",
      error instanceof Error ? tr("无法连接 Endpoint：{{0}}", [error.message]) : tr("无法连接 Endpoint"),
    );
  } finally {
    clearTimeout(timeout);
  }
}
