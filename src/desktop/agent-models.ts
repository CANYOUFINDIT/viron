import { translate as tr } from "./i18n.js";
import type { AgentApiProtocol, AgentModelListInput, AgentModelListResult } from "../shared/agent.js";
import type { AgentSettingsScope, DesktopAgentSettingsStore } from "./agent-settings.js";

function modelListUrl(endpoint: string, protocol: AgentApiProtocol): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(tr("模型 Endpoint 必须是有效 URL"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(tr("模型 Endpoint 只支持 HTTP 或 HTTPS"));
  const suffix = protocol === "anthropic" && (url.pathname === "/" || url.pathname === "") ? "/v1/models" : "/models";
  return `${base}${suffix}`;
}

function modelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") throw new Error(tr("模型列表接口未返回有效 JSON"));
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error(tr("模型列表接口未返回 data 数组"));
  return [...new Set(data
    .map((item) => item && typeof item === "object" ? (item as { id?: unknown }).id : undefined)
    .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
    .map((id) => id.trim()))].sort((left, right) => left.localeCompare(right));
}

export async function listAgentModels(
  settingsStore: DesktopAgentSettingsStore,
  scope: AgentSettingsScope,
  input: AgentModelListInput,
  request: typeof fetch = fetch,
): Promise<AgentModelListResult> {
  if (input.protocol !== "openai" && input.protocol !== "anthropic") throw new Error(tr("模型协议类型无效"));
  const apiKey = input.apiKey?.trim() || settingsStore.apiKeyFor(scope, input.endpoint, input.protocol);
  const headers: Record<string, string> = {};
  if (apiKey) {
    if (input.protocol === "anthropic") headers["x-api-key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  if (input.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";

  let response: Response;
  try {
    response = await request(modelListUrl(input.endpoint, input.protocol), {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(apiKey ? message.split(apiKey).join("[REDACTED_API_KEY]") : message);
  }
  if (!response.ok) throw new Error(tr("获取模型列表失败（HTTP {{0}}）", [response.status]));
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(tr("模型列表接口未返回有效 JSON"));
  }
  return { models: modelIds(payload) };
}
