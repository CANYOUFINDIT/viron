import { translate as tr } from "./i18n.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentApprovalMode,
  agentExecutionPresentation,
  type AgentApiProtocol,
  type AgentApprovalMode,
  type AgentExecutionPresentation,
  type AgentSettingsInput,
  type AgentSettingsPublic,
} from "../shared/agent.js";
import { DesktopSecretStorage } from "./secret-storage.js";

export interface AgentSettingsScope {
  vironEndpoint: string;
  vironUserId: string;
}

interface StoredAgentSettingsRecord {
  endpoint: string;
  protocol?: AgentApiProtocol;
  model: string;
  approvalMode?: AgentApprovalMode;
  executionPresentation?: AgentExecutionPresentation;
  apiKeyCiphertext?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredAgentSettingsFile {
  records?: Record<string, StoredAgentSettingsRecord>;
}

export interface ResolvedAgentSettings {
  endpoint: string;
  protocol: AgentApiProtocol;
  model: string;
  apiKey: string;
  approvalMode: AgentApprovalMode;
  executionPresentation: AgentExecutionPresentation;
}

function settingsPath(userDataPath: string): string {
  return join(userDataPath, "ai-agent-settings.json");
}

function scopeKey(scope: AgentSettingsScope): string {
  return createHash("sha256").update(`${scope.vironEndpoint}\0${scope.vironUserId}`).digest("hex");
}

function readSettingsFile(userDataPath: string): StoredAgentSettingsFile {
  try {
    return JSON.parse(readFileSync(settingsPath(userDataPath), "utf8")) as StoredAgentSettingsFile;
  } catch {
    return {};
  }
}

function writeSettingsFile(userDataPath: string, state: StoredAgentSettingsFile): void {
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(settingsPath(userDataPath), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizeModelEndpoint(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(tr("模型 Endpoint 不能为空"));
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(tr("模型 Endpoint 必须是有效 URL"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(tr("模型 Endpoint 只支持 HTTP 或 HTTPS"));
  parsed.hash = "";
  return parsed.href.replace(/\/+$/, "");
}

function normalizeModelName(value: string): string {
  const model = value.trim();
  if (!model) throw new Error(tr("模型名称不能为空"));
  if (model.length > 200) throw new Error(tr("模型名称过长"));
  return model;
}

function normalizeProtocol(value: AgentApiProtocol): AgentApiProtocol {
  if (value !== "openai" && value !== "anthropic") throw new Error(tr("模型协议类型无效"));
  return value;
}

function publicSettings(record: StoredAgentSettingsRecord | undefined, apiKeyStored: boolean): AgentSettingsPublic {
  return {
    configured: Boolean(record?.endpoint && record.model),
    endpoint: record?.endpoint ?? "",
    protocol: record?.protocol ?? "openai",
    model: record?.model ?? "",
    apiKeyStored,
    approvalMode: agentApprovalMode(record?.approvalMode),
    executionPresentation: agentExecutionPresentation(record?.executionPresentation),
    updatedAt: record?.updatedAt ?? null,
  };
}

export class DesktopAgentSettingsStore {
  private readonly secretStorage: DesktopSecretStorage;

  constructor(private readonly userDataPath: string, platform: NodeJS.Platform = process.platform) {
    this.secretStorage = new DesktopSecretStorage(userDataPath, platform);
  }

  private publicSettings(record: StoredAgentSettingsRecord | undefined): AgentSettingsPublic {
    return publicSettings(record, this.secretStorage.supports(record?.apiKeyCiphertext));
  }

  private decryptApiKey(ciphertext: string, key: string): string {
    try {
      return this.secretStorage.decrypt(ciphertext, `agent-api-key:${key}`);
    } catch {
      throw new Error(tr("未能读取本机保存的 Viron Agent API Key，请重新保存设置"));
    }
  }

  get(scope: AgentSettingsScope): AgentSettingsPublic {
    return this.publicSettings(readSettingsFile(this.userDataPath).records?.[scopeKey(scope)]);
  }

  save(scope: AgentSettingsScope, input: AgentSettingsInput): AgentSettingsPublic {
    const endpoint = normalizeModelEndpoint(input.endpoint);
    const protocol = normalizeProtocol(input.protocol);
    const model = normalizeModelName(input.model);
    const state = readSettingsFile(this.userDataPath);
    const key = scopeKey(scope);
    const existing = state.records?.[key];
    const now = new Date().toISOString();
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const next: StoredAgentSettingsRecord = {
      endpoint,
      protocol,
      model,
      approvalMode: agentApprovalMode(input.approvalMode),
      executionPresentation: agentExecutionPresentation(input.executionPresentation),
      apiKeyCiphertext: apiKey
        ? this.secretStorage.encrypt(apiKey, `agent-api-key:${key}`)
        : existing?.endpoint === endpoint && (existing.protocol ?? "openai") === protocol
          && this.secretStorage.supports(existing.apiKeyCiphertext)
          ? existing.apiKeyCiphertext
          : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    writeSettingsFile(this.userDataPath, { records: { ...state.records, [key]: next } });
    return this.publicSettings(next);
  }

  delete(scope: AgentSettingsScope): AgentSettingsPublic {
    const state = readSettingsFile(this.userDataPath);
    const records = { ...state.records };
    delete records[scopeKey(scope)];
    if (existsSync(settingsPath(this.userDataPath))) writeSettingsFile(this.userDataPath, { records });
    return this.publicSettings(undefined);
  }

  resolve(scope: AgentSettingsScope): ResolvedAgentSettings {
    const key = scopeKey(scope);
    const record = readSettingsFile(this.userDataPath).records?.[key];
    if (!record?.endpoint || !record.model) throw new Error(tr("请先在设置中配置 Viron Agent 模型"));
    return {
      endpoint: record.endpoint,
      protocol: record.protocol ?? "openai",
      model: record.model,
      apiKey: this.secretStorage.supports(record.apiKeyCiphertext) ? this.decryptApiKey(record.apiKeyCiphertext, key) : "",
      approvalMode: agentApprovalMode(record.approvalMode),
      executionPresentation: agentExecutionPresentation(record.executionPresentation),
    };
  }

  apiKeyFor(scope: AgentSettingsScope, endpoint: string, protocol: AgentApiProtocol): string {
    const key = scopeKey(scope);
    const record = readSettingsFile(this.userDataPath).records?.[key];
    if (record?.endpoint !== normalizeModelEndpoint(endpoint) || (record.protocol ?? "openai") !== protocol) return "";
    return this.secretStorage.supports(record.apiKeyCiphertext) ? this.decryptApiKey(record.apiKeyCiphertext, key) : "";
  }
}
