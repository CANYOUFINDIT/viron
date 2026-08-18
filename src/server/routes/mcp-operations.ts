import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  canAccessConnection,
  canAccessEnvironment,
  canAccessWebCredential,
  canManageWorkspace,
  workspaceWhere,
} from "../access-control.js";
import { runWithAuditSource, writeAudit } from "../audit.js";
import { resolveMcpBusinessOperation } from "../../shared/mcp-business-operations.js";
import { sshCommandRiskLevel } from "../../shared/ssh-command-risk.js";
import { executionScope, EXECUTION_SCOPE_HEADER } from "../execution-scope.js";
import {
  VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH,
  VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH,
  type McpApiRequest,
  type McpApiResponse,
} from "../../shared/mcp-protocol.js";
import { resolveVironMcpApiRequest, resolveVironMcpApprovedRequest } from "../../shared/mcp-tools.js";
import {
  mcpApprovalMode,
  mcpApprovalRequired,
  VIRON_MCP_APPROVAL_MODE_HEADER,
  type McpApprovalMode,
} from "../../shared/mcp-settings.js";
import type { McpCredentialKind, McpOperationRecord } from "../mcp/operation-store.js";
import { requireAdmin } from "./auth.js";

const operationCreateSchema = z.object({
  action: z.string().trim().min(1).max(160),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const operationPurposeSchema = z.object({
  purpose: z.string().trim()
    .min(VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH)
    .max(VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH)
    .regex(/^[^\r\n]+$/),
});

const desktopResultSchema = z.object({
  lease: z.string().min(32).max(256),
  response: z.object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.undefined()])),
    data: z.unknown(),
  }),
});

const secretSchema = z.object({
  password: z.string().max(4096).default(""),
  privateKey: z.string().max(128 * 1024).default(""),
  passphrase: z.string().max(4096).default(""),
  httpTunnelUsername: z.string().max(4096).default(""),
  httpTunnelPassword: z.string().max(4096).default(""),
  tlsCa: z.string().max(128 * 1024).default(""),
  tlsCertificate: z.string().max(128 * 1024).default(""),
  tlsPrivateKey: z.string().max(128 * 1024).default(""),
  tlsPassphrase: z.string().max(4096).default(""),
  configPassphrase: z.string().max(4096).default(""),
});

function approvalModeForRequest(request: FastifyRequest): McpApprovalMode {
  if (request.sessionId && executionScope(request) && request.headers[VIRON_MCP_APPROVAL_MODE_HEADER.toLowerCase()] !== undefined) {
    return mcpApprovalMode(request.headers[VIRON_MCP_APPROVAL_MODE_HEADER.toLowerCase()]);
  }
  return request.apiKey?.mcpApprovalMode ?? "always";
}

function workspaceKey(request: FastifyRequest): string {
  return request.admin!.workspace.type === "personal" ? "personal" : `organization:${request.admin!.workspace.id}`;
}

function sameOwner(operation: McpOperationRecord, request: FastifyRequest): boolean {
  if (!request.admin) return false;
  if (operation.ownerUserId !== request.admin.id
    || operation.workspaceType !== request.admin.workspace.type
    || operation.workspaceId !== request.admin.workspace.id) return false;
  return !request.apiKey || operation.apiKeyId === request.apiKey.id;
}

function operationForRequest(app: FastifyInstance, request: FastifyRequest, id: string): McpOperationRecord | null {
  const operation = app.mcpOperations.get(id);
  return operation && sameOwner(operation, request) ? operation : null;
}

function actionOrigin(request: FastifyRequest): string {
  const forwarded = request.headers["x-viron-mcp-origin"];
  const candidates = [typeof forwarded === "string" ? forwarded : "", `${request.protocol}://${request.headers.host ?? request.hostname}`];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol)) return url.origin;
    } catch {
      // Try the request-derived fallback.
    }
  }
  throw new Error("无法确定 Viron Operation 页面地址");
}

function apiResponse(response: Awaited<ReturnType<FastifyInstance["inject"]>>): McpApiResponse {
  const contentType = response.headers["content-type"]?.toString();
  let data: unknown = response.body;
  if (contentType?.includes("application/json")) {
    try { data = response.body ? JSON.parse(response.body) as unknown : null; }
    catch { data = { error: "INVALID_JSON_RESPONSE", message: "Viron API 返回了无效 JSON" }; }
  } else if (!(contentType?.startsWith("text/") || contentType?.includes("application/sql") || contentType?.includes("application/x-asciicast"))) {
    data = {
      contentType: contentType ?? "application/octet-stream",
      contentDisposition: response.headers["content-disposition"]?.toString() ?? "",
      size: response.rawPayload.length,
      contentBase64: response.rawPayload.toString("base64"),
    };
  }
  return {
    status: response.statusCode,
    headers: contentType ? { "content-type": contentType } : {},
    data,
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

async function connectionImportRequest(browserRequest: FastifyRequest, operation: McpOperationRecord): Promise<McpApiRequest> {
  if (!browserRequest.isMultipart()) throw new Error("连接导入必须选择文件");
  let filename = "";
  let contentType = "application/octet-stream";
  let content: Buffer | null = null;
  let passphrase = "";
  try {
    for await (const part of browserRequest.parts({ limits: { files: 1, fields: 2, fileSize: 8 * 1024 * 1024 } })) {
      if (part.type === "file") {
        filename = part.filename;
        contentType = part.mimetype || contentType;
        content = await part.toBuffer();
      } else if (part.fieldname === "passphrase") passphrase = String(part.value ?? "").slice(0, 4096);
    }
  } catch {
    throw new Error("连接导入文件不能超过 8 MiB");
  }
  if (!content?.length || !filename) throw new Error("请选择连接导入文件");
  const type = String((operation.request.body as Record<string, unknown> | undefined)?.type ?? "");
  return {
    method: "POST",
    path: operation.request.path,
    form: {
      fields: { type, passphrase },
      files: [{ fieldName: "file", filename, contentType, contentBase64: content.toString("base64") }],
    },
  };
}

function requestPath(input: McpApiRequest): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") query.set(name, String(value));
  }
  return `${input.path}${query.size ? `?${query.toString()}` : ""}`;
}

function supportsDesktopExecution(input: McpApiRequest): boolean {
  const pathname = new URL(input.path, "http://desktop.local").pathname;
  return /^\/api\/v1\/mcp\/ssh-connections\/[0-9a-f-]+\/command$/i.test(pathname)
    || /^\/api\/v1\/database-connections\/[0-9a-f-]+\/(?:queries|table-data\/changes|table-import|backup|restore|transfer|sync)$/i.test(pathname)
    || /^\/api\/v1\/redis-connections\/[0-9a-f-]+\/command$/i.test(pathname)
    || /^\/api\/v1\/ssh-connections\/[0-9a-f-]+\/sftp(?:\/(?:mkdir|rename|chmod|upload))?$/i.test(pathname)
    || pathname === "/api/v1/sftp-transfers"
    || /^\/api\/v1\/sftp-transfers\/[0-9a-f-]+\/retry$/i.test(pathname)
    || /^\/api\/v1\/mcp\/web-credentials\/[0-9a-f-]+\/action$/i.test(pathname)
    || /^\/api\/v1\/mcp\/web-credentials\/[0-9a-f-]+\/control$/i.test(pathname)
    || /^\/api\/v1\/web-credentials\/[0-9a-f-]+\/view\/upload$/i.test(pathname);
}

async function executeOperationRequest(app: FastifyInstance, browserRequest: FastifyRequest, operation: McpOperationRecord, input: McpApiRequest): Promise<McpApiResponse> {
  const headers: Record<string, string> = {};
  if (browserRequest.headers.cookie) headers.cookie = browserRequest.headers.cookie;
  if (browserRequest.headers.authorization) headers.authorization = browserRequest.headers.authorization;
  if (browserRequest.headers["x-viron-workspace"] && typeof browserRequest.headers["x-viron-workspace"] === "string") {
    headers["x-viron-workspace"] = browserRequest.headers["x-viron-workspace"];
  }
  if (browserRequest.headers["accept-language"] && typeof browserRequest.headers["accept-language"] === "string") {
    headers["accept-language"] = browserRequest.headers["accept-language"];
  }
  if (operation.executionScope) headers[EXECUTION_SCOPE_HEADER] = operation.executionScope;
  headers["x-viron-execution-mode"] = "server";
  const multipart = input.form ? multipartPayload(input.form) : null;
  if (multipart) headers["content-type"] = multipart.contentType;
  else if (input.body !== undefined) headers["content-type"] = "application/json";
  const response = await runWithAuditSource("mcp", (auditHeaders) => app.inject({
    method: input.method ?? "GET",
    url: requestPath(input),
    headers: { ...headers, ...auditHeaders },
    ...(multipart ? { payload: multipart.payload } : input.body === undefined ? {} : { payload: JSON.stringify(input.body) }),
  }));
  return apiResponse(response);
}

async function credentialRequest(operation: McpOperationRecord, body: unknown): Promise<McpApiRequest> {
  const secrets = secretSchema.parse(body);
  const base = structuredClone((operation.request.body ?? {}) as Record<string, unknown>);
  const updating = operation.credential?.mode === "update";
  const nonEmpty = (value: string) => value ? value : undefined;
  switch (operation.credential?.kind) {
    case "ssh": {
      const authType = String(base.authType ?? "password");
      const sshKeyId = typeof base.sshKeyId === "string" && base.sshKeyId ? base.sshKeyId : null;
      if (!updating && ["password", "keyboardInteractive"].includes(authType) && !secrets.password) throw new Error("密码认证必须输入密码");
      if (!updating && authType === "privateKey" && !sshKeyId && !secrets.privateKey) throw new Error("私钥认证必须输入私钥或选择已有 SSH 密钥");
      const credential = {
        ...(nonEmpty(secrets.password) ? { password: secrets.password } : {}),
        ...(nonEmpty(secrets.privateKey) ? { privateKey: secrets.privateKey } : {}),
        ...(nonEmpty(secrets.passphrase) ? { passphrase: secrets.passphrase } : {}),
      };
      return { ...operation.request, body: { ...base, ...(Object.keys(credential).length ? { credential } : {}) } };
    }
    case "database":
    case "databaseProfile": {
      const credential = {
        ...(nonEmpty(secrets.password) ? { password: secrets.password } : {}),
        ...(nonEmpty(secrets.httpTunnelUsername) ? { httpTunnelUsername: secrets.httpTunnelUsername } : {}),
        ...(nonEmpty(secrets.httpTunnelPassword) ? { httpTunnelPassword: secrets.httpTunnelPassword } : {}),
        ...(nonEmpty(secrets.tlsCa) ? { tlsCa: secrets.tlsCa } : {}),
        ...(nonEmpty(secrets.tlsCertificate) ? { tlsCertificate: secrets.tlsCertificate } : {}),
        ...(nonEmpty(secrets.tlsPrivateKey) ? { tlsPrivateKey: secrets.tlsPrivateKey } : {}),
        ...(nonEmpty(secrets.tlsPassphrase) ? { tlsPassphrase: secrets.tlsPassphrase } : {}),
      };
      return { ...operation.request, body: { ...base, ...(Object.keys(credential).length ? { credential } : {}) } };
    }
    case "redis": {
      const credential = {
        ...(nonEmpty(secrets.password) ? { password: secrets.password } : {}),
        ...(nonEmpty(secrets.tlsCa) ? { tlsCa: secrets.tlsCa } : {}),
        ...(nonEmpty(secrets.tlsCertificate) ? { tlsCertificate: secrets.tlsCertificate } : {}),
        ...(nonEmpty(secrets.tlsPrivateKey) ? { tlsPrivateKey: secrets.tlsPrivateKey } : {}),
        ...(nonEmpty(secrets.tlsPassphrase) ? { tlsPassphrase: secrets.tlsPassphrase } : {}),
      };
      return { ...operation.request, body: { ...base, ...(Object.keys(credential).length ? { credential } : {}) } };
    }
    case "web": {
      if (!updating && !secrets.password) throw new Error("Web 登录账号必须输入密码");
      return { ...operation.request, body: { ...base, ...(secrets.password ? { password: secrets.password } : {}) } };
    }
    case "sshKeyImport": {
      if (!secrets.privateKey) throw new Error("请粘贴 SSH 私钥");
      return { ...operation.request, body: { ...base, privateKey: secrets.privateKey, passphrase: secrets.passphrase } };
    }
    case "sshKeyGenerate":
      return { ...operation.request, body: { ...base, passphrase: secrets.passphrase } };
    case "connectionSource": {
      const authType = String(base.authType ?? "password");
      if (!updating && authType === "password" && !secrets.password) throw new Error("密码认证必须输入密码");
      if (!updating && authType === "privateKey" && !secrets.privateKey) throw new Error("私钥认证必须输入私钥");
      return {
        ...operation.request,
        body: {
          ...base,
          ...(secrets.password ? { password: secrets.password } : {}),
          ...(secrets.privateKey ? { privateKey: secrets.privateKey } : {}),
          ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}),
          ...(secrets.configPassphrase ? { configPassphrase: secrets.configPassphrase } : {}),
        },
      };
    }
    case "connectionImport":
      throw new Error("连接文件导入必须使用安全文件表单");
    default:
      throw new Error("Operation 不是安全凭据操作");
  }
}

function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
}

function dateTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function secretFields(kind: McpCredentialKind, updating: boolean): string {
  const suffix = updating ? "（留空保持不变）" : kind === "databaseProfile" ? "（留空沿用主配置凭据）" : "";
  const input = (name: string, label: string, type = "password") => `<label><span>${htmlEscape(label)}${htmlEscape(suffix)}</span><input type="${type}" name="${name}" autocomplete="new-password"></label>`;
  const textarea = (name: string, label: string) => `<label><span>${htmlEscape(label)}${htmlEscape(suffix)}</span><textarea name="${name}" rows="7" spellcheck="false"></textarea></label>`;
  if (kind === "ssh") return `${input("password", "SSH 密码")}${textarea("privateKey", "SSH 私钥")}${input("passphrase", "私钥口令")}`;
  if (kind === "database" || kind === "databaseProfile") return `${input("password", "数据库密码")}${input("httpTunnelUsername", "HTTP Tunnel 用户名", "text")}${input("httpTunnelPassword", "HTTP Tunnel 密码")}${textarea("tlsCa", "TLS CA")}${textarea("tlsCertificate", "TLS 证书")}${textarea("tlsPrivateKey", "TLS 私钥")}${input("tlsPassphrase", "TLS 私钥口令")}`;
  if (kind === "redis") return `${input("password", "Redis 密码")}${textarea("tlsCa", "TLS CA")}${textarea("tlsCertificate", "TLS 证书")}${textarea("tlsPrivateKey", "TLS 私钥")}${input("tlsPassphrase", "TLS 私钥口令")}`;
  if (kind === "sshKeyImport") return `${textarea("privateKey", "SSH 私钥")}${input("passphrase", "私钥口令")}`;
  if (kind === "sshKeyGenerate") return input("passphrase", "新密钥口令");
  if (kind === "connectionSource") return `${input("password", "同步 SSH 密码")}${textarea("privateKey", "同步 SSH 私钥")}${input("passphrase", "私钥口令")}${input("configPassphrase", "SecureCRT 配置口令")}`;
  if (kind === "connectionImport") return `<label><span>连接文件</span><input type="file" name="file" required accept=".ini,.zip,.xml,.ncx"></label>${input("passphrase", "文件口令")}`;
  return input("password", "Web 登录密码");
}

function operationPresentation(operation: McpOperationRecord): { label: string; content: string; context: string } | null {
  if (operation.kind !== "confirmation") return null;
  const body = (operation.request.body ?? {}) as Record<string, unknown>;
  const separator = operation.summary.indexOf(" · ");
  const context = separator >= 0 ? operation.summary.slice(0, separator) : "";
  if (operation.action === "viron_ssh_command_request") {
    return { label: "待执行命令", content: String(body.command ?? operation.summary), context };
  }
  if (operation.action === "viron_database_write_request") {
    return { label: "待执行 SQL", content: String(body.sql ?? operation.summary), context };
  }
  return { label: "待执行操作", content: operation.summary, context };
}

function operationPage(operation: McpOperationRecord, message = "", isError = false): string {
  const pending = operation.status === "pending";
  const awaitingPurpose = operation.status === "awaiting_purpose";
  const credential = operation.kind === "credential" ? operation.credential : null;
  const multipart = credential?.kind === "connectionImport";
  const presentation = operationPresentation(operation);
  const purpose = operation.kind === "confirmation" ? operation.purpose : null;
  const displayMessage = message || (awaitingPurpose ? "正在等待 Agent 补充执行意图，完成前暂不能审批。" : "");
  const submit = pending
    ? credential
      ? `<form class="credential-form" method="post" action="/mcp/operations/${operation.id}/submit"${multipart ? " enctype=\"multipart/form-data\"" : ""}>${secretFields(credential.kind, credential.mode === "update")}<button class="primary" type="submit">安全提交</button></form>`
      : `<form method="post" action="/mcp/operations/${operation.id}/submit"><button class="primary danger" type="submit">确认执行</button></form>`
    : "";
  const cancel = pending ? `<form method="post" action="/mcp/operations/${operation.id}/cancel"><button class="secondary" type="submit">取消</button></form>` : "";
  const riskLabel = operation.riskLevel === "high" ? "高风险" : operation.riskLevel === "medium" ? "中风险" : "低风险";
  const targetLabel = operation.executionTarget === "desktop" ? "Viron App 本机" : "Viron 服务端";
  const expiresAtLabel = dateTimeLabel(operation.expiresAt);
  const actions = pending && !credential ? `<div class="actions">${cancel}${submit}</div>` : `${submit}${cancel}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(operation.title)} - Viron</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#edf1f0;color:#172321;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}main{width:min(684px,calc(100% - 32px));margin:24px auto}.shell{overflow:hidden;background:#fbfcfb;border:1px solid #d5dedb;border-radius:16px;box-shadow:0 24px 64px rgba(28,47,42,.13),0 2px 8px rgba(28,47,42,.06)}.page-header{padding:25px 26px 20px;display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.kicker{margin-bottom:7px;color:#63746f;font-size:11px;font-weight:750;letter-spacing:.12em}.page-header h1{margin:0;color:#14201e;font-size:22px;line-height:1.25;letter-spacing:-.025em}.page-header p{max-width:48ch;margin:7px 0 0;color:#71807c;font-size:13px}.badge{flex:none;margin-top:2px;padding:6px 9px;border:1px solid #d7dfdc;border-radius:6px;background:#eef2f1;color:#41514d;font-size:11px;font-weight:800;letter-spacing:.04em}.badge.high{border-color:#efc5bc;background:#fff0ed;color:#a93f2b}.badge.medium{border-color:#ead7a8;background:#fff8e5;color:#805b08}.content{padding:0 26px 26px}.purpose{position:relative;margin:0 0 14px;padding:14px 16px 13px 18px;border:1px solid #c8ddd5;border-radius:10px;background:#f1f8f5}.purpose:before{content:"";position:absolute;inset:12px auto 12px 0;width:3px;border-radius:0 3px 3px 0;background:#2b8a6d}.purpose-label{margin:0 0 5px;color:#27775f;font-size:10px;font-weight:850;letter-spacing:.11em}.purpose blockquote{margin:0;color:#1d2d29;font-size:15px;font-weight:700;line-height:1.5;letter-spacing:-.01em}.purpose small{display:block;margin-top:6px;color:#6a7975;font-size:10.5px}.focus{overflow:hidden;border:1px solid #233c37;border-radius:10px;background:#12211e;box-shadow:0 12px 30px rgba(14,34,29,.18)}.focus-heading{min-height:43px;padding:0 15px;border-bottom:1px solid #29413c;display:flex;align-items:center;justify-content:space-between;gap:16px}.focus-heading span{color:#75c7ab;font-size:11px;font-weight:800;letter-spacing:.1em}.focus-heading strong{overflow:hidden;color:#92a8a1;font-size:11px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.focus pre{max-height:260px;margin:0;padding:18px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}.focus code{color:#f1f7f5;font:13.5px/1.7 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.summary{margin:0;padding:16px;border:1px solid #dde4e2;border-radius:9px;background:#f4f7f6;color:#40504c}.notice{margin:0 0 16px;padding:11px 13px;border:1px solid #b9ddcf;border-radius:8px;background:#eef9f5;color:#17644e;font-weight:600}.notice.error{border-color:#e7b5ad;background:#fff2f0;color:#9b3122}.context-row{margin:14px 0 0;padding:0 2px;display:flex;align-items:center;gap:18px;color:#64736f;font-size:11px}.context-row span{display:flex;align-items:center;gap:6px}.context-row b{color:#33433f;font-weight:700}.details{margin:14px 0 18px;border-top:1px solid #e1e7e5;border-bottom:1px solid #e1e7e5}.details summary{padding:10px 2px;color:#60706b;font-size:11px;font-weight:700;cursor:pointer;list-style:none}.details summary::-webkit-details-marker{display:none}.details summary:after{content:"+";float:right;color:#80908b;font:16px/1 ui-monospace,monospace}.details[open] summary:after{content:"−"}.meta{display:grid;grid-template-columns:92px minmax(0,1fr);gap:7px 14px;margin:0;padding:0 2px 12px}.meta dt{color:#85918e;font-size:11px}.meta dd{min-width:0;margin:0;color:#42514d;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}label{display:block;margin:0 0 15px}label span{display:block;margin-bottom:6px;color:#40504c;font-size:12px;font-weight:700}input,textarea{width:100%;padding:10px 11px;border:1px solid #b8c5c1;border-radius:7px;background:#fff;color:#172321;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;transition:border-color .18s ease,box-shadow .18s ease}input:focus,textarea:focus{outline:0;border-color:#26866b;box-shadow:0 0 0 3px rgba(38,134,107,.12)}textarea{resize:vertical;min-height:110px}.credential-form{margin-top:18px}.actions{display:grid;grid-template-columns:minmax(0,.78fr) minmax(0,1.22fr);gap:10px}.actions form{margin:0}button{width:100%;min-height:44px;border:1px solid transparent;border-radius:7px;padding:0 17px;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;cursor:pointer;transition:transform .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease}button:hover{transform:translateY(-1px)}button:active{transform:translateY(0) scale(.985)}button:focus-visible{outline:2px solid #20856a;outline-offset:2px}.primary{background:#18785f;color:#fff;box-shadow:0 7px 16px rgba(24,120,95,.18)}.primary:hover{background:#126c55}.primary.danger{background:#ae412f;box-shadow:0 7px 16px rgba(174,65,47,.18)}.primary.danger:hover{background:#9e3828}.secondary{margin-top:10px;border-color:#c5cfcc;background:#fbfcfb;color:#44534f}.actions .secondary{margin-top:0}.secondary:hover{border-color:#a9b7b3;background:#f2f5f4}@media(max-width:560px){main{width:min(100% - 20px,684px);margin:10px auto}.shell{border-radius:12px}.page-header{padding:20px 18px 17px;gap:12px}.page-header h1{font-size:19px}.content{padding:0 18px 20px}.purpose{padding:13px 14px 12px 16px}.purpose blockquote{font-size:14px}.focus pre{max-height:220px;padding:15px}.focus-heading{align-items:flex-start;flex-direction:column;justify-content:center;gap:2px;padding:8px 13px}.focus-heading strong{max-width:100%}.context-row{align-items:flex-start;flex-direction:column;gap:4px}.actions{grid-template-columns:1fr}.meta{grid-template-columns:1fr;gap:3px}.meta dd{margin-bottom:5px}}</style></head><body><main><article class="shell"><header class="page-header"><div><div class="kicker">VIRON 安全审批</div><h1>${htmlEscape(operation.title)}</h1><p>${credential ? htmlEscape(operation.summary) : "Agent 说明用于辅助判断，请以实际操作内容为准。"}</p></div><span class="badge ${operation.riskLevel}">${htmlEscape(riskLabel)}</span></header><div class="content">${displayMessage ? `<div class="notice${isError ? " error" : ""}">${htmlEscape(displayMessage)}</div>` : ""}${purpose ? `<section class="purpose"><div class="purpose-label">AGENT 提供的执行意图</div><blockquote>${htmlEscape(purpose)}</blockquote><small>这是 Agent 提供的说明；审批时请仍以实际操作内容为准。</small></section>` : ""}${presentation ? `<section class="focus"><div class="focus-heading"><span>${htmlEscape(presentation.label)}</span>${presentation.context ? `<strong>${htmlEscape(presentation.context)}</strong>` : ""}</div><pre><code>${htmlEscape(presentation.content)}</code></pre></section>` : `<p class="summary">${htmlEscape(operation.summary)}</p>`}<div class="context-row"><span>执行位置 <b>${htmlEscape(targetLabel)}</b></span><span>有效期至 <b>${htmlEscape(expiresAtLabel)}</b></span></div><details class="details"><summary>操作详情</summary><dl class="meta"><dt>Operation ID</dt><dd>${htmlEscape(operation.id)}</dd><dt>状态</dt><dd>${htmlEscape(operation.status)}</dd><dt>风险等级</dt><dd>${htmlEscape(operation.riskLevel)}</dd></dl></details>${actions}</div></article></main></body></html>`;
}

function sendOperationPage(reply: FastifyReply, operation: McpOperationRecord, message = "", isError = false): FastifyReply {
  return reply
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    .type("text/html; charset=utf-8")
    .send(operationPage(operation, message, isError));
}

async function connectionName(app: FastifyInstance, type: "ssh" | "database" | "redis", id: string): Promise<string> {
  const table = type === "ssh" ? "ssh_connections" : type === "database" ? "database_connections" : "redis_connections";
  const row = await app.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined;
  return row?.name ?? id;
}

async function ensureCredentialTarget(app: FastifyInstance, request: FastifyRequest, action: string, arguments_: Record<string, unknown>): Promise<void> {
  if (!canManageWorkspace(request)) throw new Error("只有当前工作空间管理员可以新增或更新连接凭据");
  if (action === "viron_database_connection_profile_secure_create" || action === "viron_database_connection_profile_secure_update") {
    const connectionId = String(arguments_.connectionId);
    const root = await app.db.prepare(`SELECT 1 FROM database_connections WHERE id = ? AND profile_parent_id IS NULL AND ${workspaceWhere()}`)
      .get(connectionId, request.admin!.workspace.type, request.admin!.workspace.id);
    if (!root) throw new Error("数据库连接不存在或不属于当前工作空间");
    if (action.endsWith("_update")) {
      const profile = await app.db.prepare("SELECT 1 FROM database_connections WHERE id = ? AND profile_parent_id = ?")
        .get(String(arguments_.profileId), connectionId);
      if (!profile) throw new Error("数据库连接配置档不存在");
    }
    return;
  }
  if (!action.endsWith("_update")) {
    if (action === "viron_web_credential_secure_create") {
      const entry = await app.db.prepare("SELECT environment_id FROM web_entries WHERE id = ?").get(String(arguments_.webEntryId)) as { environment_id: string } | undefined;
      if (!entry || !await canAccessEnvironment(app.db, request.admin!, entry.environment_id)) throw new Error("Web 入口不存在或无权访问");
    }
    return;
  }
  if (action === "viron_web_credential_secure_update") {
    if (!await canAccessWebCredential(app.db, request.admin!, String(arguments_.credentialId))) throw new Error("Web 登录账号不存在或无权访问");
    return;
  }
  if (action === "viron_connection_source_secure_update") {
    const exists = await app.db.prepare(`SELECT 1 FROM connection_sources WHERE id = ? AND ${workspaceWhere()}`).get(String(arguments_.sourceId), request.admin!.workspace.type, request.admin!.workspace.id);
    if (!exists) throw new Error("连接来源不存在或不属于当前工作空间");
    return;
  }
  if (action.startsWith("viron_ssh_key_") || action === "viron_connection_import_secure_preview") return;
  const type = action.includes("ssh_connection") ? "ssh" : action.includes("database_connection") ? "database" : "redis";
  const id = String(arguments_.connectionId);
  const table = type === "ssh" ? "ssh_connections" : type === "database" ? "database_connections" : "redis_connections";
  const exists = await app.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND ${workspaceWhere()}`).get(id, request.admin!.workspace.type, request.admin!.workspace.id);
  if (!exists) throw new Error("连接不存在或不属于当前工作空间");
}

function credentialSpec(action: string, arguments_: Record<string, unknown>): { title: string; summary: string; credential: { kind: McpCredentialKind; mode: "create" | "update" }; request: McpApiRequest } {
  if (action === "viron_ssh_connection_secure_create" || action === "viron_ssh_connection_secure_update") {
    const updating = action.endsWith("_update");
    const config = arguments_.config as Record<string, unknown>;
    return {
      title: updating ? "安全更新 SSH 连接" : "安全创建 SSH 连接",
      summary: `${String(config.name)} · ${String(config.username)}@${String(config.host)}:${String(config.port)}`,
      credential: { kind: "ssh", mode: updating ? "update" : "create" },
      request: { method: updating ? "PUT" : "POST", path: updating ? `/api/v1/ssh-connections/${String(arguments_.connectionId)}` : "/api/v1/ssh-connections", body: config },
    };
  }
  if (action === "viron_database_connection_secure_create" || action === "viron_database_connection_secure_update") {
    const updating = action.endsWith("_update");
    const config = arguments_.config as Record<string, unknown>;
    const options = config.options as Record<string, unknown>;
    const ssl = options.ssl as Record<string, unknown>;
    const body = { ...config, options: { ...options, ssl: { ...ssl, ca: "", certificate: "", privateKey: "", passphrase: "" } } };
    return {
      title: updating ? "安全更新数据库连接" : "安全创建数据库连接",
      summary: `${String(config.name)} · ${String(config.engine)}://${String(config.host)}:${String(config.port)}`,
      credential: { kind: "database", mode: updating ? "update" : "create" },
      request: { method: updating ? "PUT" : "POST", path: updating ? `/api/v1/database-connections/${String(arguments_.connectionId)}` : "/api/v1/database-connections", body },
    };
  }
  if (action === "viron_database_connection_profile_secure_create" || action === "viron_database_connection_profile_secure_update") {
    const updating = action.endsWith("_update");
    const config = arguments_.config as Record<string, unknown>;
    const options = config.options as Record<string, unknown>;
    const ssl = options.ssl as Record<string, unknown>;
    const body = {
      ...config,
      name: String(config.profileName),
      options: { ...options, ssl: { ...ssl, ca: "", certificate: "", privateKey: "", passphrase: "" } },
    };
    return {
      title: updating ? "安全更新数据库连接配置档" : "安全创建数据库连接配置档",
      summary: `${String(config.profileName)} · ${String(config.engine)}://${String(config.host)}:${String(config.port)}`,
      credential: { kind: "databaseProfile", mode: updating ? "update" : "create" },
      request: {
        method: updating ? "PUT" : "POST",
        path: updating
          ? `/api/v1/database-connections/${String(arguments_.connectionId)}/profiles/${String(arguments_.profileId)}`
          : `/api/v1/database-connections/${String(arguments_.connectionId)}/profiles`,
        body,
      },
    };
  }
  if (action === "viron_redis_connection_secure_create" || action === "viron_redis_connection_secure_update") {
    const updating = action.endsWith("_update");
    const config = arguments_.config as Record<string, unknown>;
    return {
      title: updating ? "安全更新 Redis 连接" : "安全创建 Redis 连接",
      summary: `${String(config.name)} · redis://${String(config.host)}:${String(config.port)}/${String(config.defaultDatabase)}`,
      credential: { kind: "redis", mode: updating ? "update" : "create" },
      request: { method: updating ? "PUT" : "POST", path: updating ? `/api/v1/redis-connections/${String(arguments_.connectionId)}` : "/api/v1/redis-connections", body: config },
    };
  }
  if (action === "viron_web_credential_secure_create" || action === "viron_web_credential_secure_update") {
    const updating = action.endsWith("_update");
    const body = { username: arguments_.username, note: arguments_.note, customFields: arguments_.customFields };
    return {
      title: updating ? "安全更新 Web 登录账号" : "安全创建 Web 登录账号",
      summary: `账号 ${String(arguments_.username)}`,
      credential: { kind: "web", mode: updating ? "update" : "create" },
      request: { method: updating ? "PUT" : "POST", path: updating ? `/api/v1/web-credentials/${String(arguments_.credentialId)}` : `/api/v1/web-entries/${String(arguments_.webEntryId)}/credentials`, body },
    };
  }
  if (action === "viron_ssh_key_secure_import") {
    return {
      title: "安全导入 SSH 私钥",
      summary: `SSH 密钥 ${String(arguments_.name)}`,
      credential: { kind: "sshKeyImport", mode: "create" },
      request: { method: "POST", path: "/api/v1/ssh-keys/import", body: { name: arguments_.name } },
    };
  }
  if (action === "viron_ssh_key_secure_generate") {
    return {
      title: "安全生成 SSH 密钥",
      summary: `${String(arguments_.name)} · ${String(arguments_.algorithm)}`,
      credential: { kind: "sshKeyGenerate", mode: "create" },
      request: { method: "POST", path: "/api/v1/ssh-keys/generate", body: { name: arguments_.name, algorithm: arguments_.algorithm } },
    };
  }
  if (action === "viron_connection_source_secure_create" || action === "viron_connection_source_secure_update") {
    const updating = action.endsWith("_update");
    const config = arguments_.config as Record<string, unknown>;
    return {
      title: updating ? "安全更新 SecureCRT 同步源" : "安全创建 SecureCRT 同步源",
      summary: `${String(config.name)} · ${String(config.username)}@${String(config.host)}:${String(config.port)}`,
      credential: { kind: "connectionSource", mode: updating ? "update" : "create" },
      request: { method: updating ? "PUT" : "POST", path: updating ? `/api/v1/connection-sources/${String(arguments_.sourceId)}` : "/api/v1/connection-sources/securecrt", body: config },
    };
  }
  if (action === "viron_connection_import_secure_preview") {
    return {
      title: "安全预览连接文件导入",
      summary: `${String(arguments_.type) === "securecrt" ? "SecureCRT" : "Navicat"} 连接文件`,
      credential: { kind: "connectionImport", mode: "create" },
      request: { method: "POST", path: "/api/v1/connection-imports/preview", body: { type: arguments_.type } },
    };
  }
  throw new Error("不支持的安全凭据 Operation");
}

async function confirmationSpec(app: FastifyInstance, request: FastifyRequest, action: string, arguments_: Record<string, unknown>) {
  const approved = resolveVironMcpApprovedRequest(action, arguments_);
  if (action === "viron_ssh_command_request") {
    const id = String(arguments_.connectionId);
    if (!await canAccessConnection(app.db, request.admin!, "ssh", id)) throw new Error("SSH 连接不存在或无权访问");
    return { title: "确认执行 SSH 命令", summary: `${await connectionName(app, "ssh", id)} · ${String(arguments_.command).slice(0, 300)}`, riskLevel: sshCommandRiskLevel(String(arguments_.command)), request: approved };
  }
  if (action === "viron_database_write_request") {
    const id = String(arguments_.connectionId);
    if (!await canAccessConnection(app.db, request.admin!, "database", id)) throw new Error("数据库连接不存在或无权访问");
    return { title: "确认执行数据库写 SQL", summary: `${await connectionName(app, "database", id)} / ${String(arguments_.database || "默认 Schema")} · ${String(arguments_.sql).slice(0, 300)}`, riskLevel: "high" as const, request: approved };
  }
  if (action === "viron_redis_write_request") {
    const id = String(arguments_.connectionId);
    if (!await canAccessConnection(app.db, request.admin!, "redis", id)) throw new Error("Redis 连接不存在或无权访问");
    return { title: "确认执行 Redis 写命令", summary: `${await connectionName(app, "redis", id)} · ${String(arguments_.command)}，${Array.isArray(arguments_.args) ? arguments_.args.length : 0} 个参数`, riskLevel: "high" as const, request: approved };
  }
  if (["viron_sftp_mkdir_request", "viron_sftp_rename_request", "viron_sftp_chmod_request", "viron_sftp_delete_request"].includes(action)) {
    const id = String(arguments_.connectionId);
    if (!await canAccessConnection(app.db, request.admin!, "ssh", id)) throw new Error("SSH 连接不存在或无权访问");
    const label = action.includes("mkdir") ? "创建目录" : action.includes("rename") ? "重命名路径" : action.includes("chmod") ? "修改权限" : "删除路径";
    return { title: `确认${label}`, summary: `${await connectionName(app, "ssh", id)} · ${String(arguments_.path)}${arguments_.newPath ? ` → ${String(arguments_.newPath)}` : ""}`, riskLevel: action.includes("delete") ? "high" as const : "medium" as const, request: approved };
  }
  if (action === "viron_sftp_transfer_request") {
    const sourceId = String(arguments_.sourceConnectionId);
    const targetId = String(arguments_.targetConnectionId);
    const [sourceAllowed, targetAllowed] = await Promise.all([
      canAccessConnection(app.db, request.admin!, "ssh", sourceId),
      canAccessConnection(app.db, request.admin!, "ssh", targetId),
    ]);
    if (!sourceAllowed || !targetAllowed) throw new Error("来源或目标 SSH 连接不存在或无权访问");
    return { title: "确认 SFTP 主机间传输", summary: `${await connectionName(app, "ssh", sourceId)}:${String(arguments_.sourcePath)} → ${await connectionName(app, "ssh", targetId)}:${String(arguments_.targetDirectory)}（${String(arguments_.conflict)}）`, riskLevel: "high" as const, request: approved };
  }
  if (action === "viron_web_action_request") {
    const id = String(arguments_.credentialId);
    if (!await canAccessWebCredential(app.db, request.admin!, id)) throw new Error("Web 登录账号不存在或无权访问");
    const row = await app.db.prepare("SELECT c.username, w.name FROM web_credentials c JOIN web_entries w ON w.id = c.web_entry_id WHERE c.id = ?").get(id) as { username: string; name: string } | undefined;
    return { title: "确认操作 Web 页面", summary: `${row?.name ?? id} / ${row?.username ?? id} · ${String(arguments_.action)} 交互元素 #${String(arguments_.elementIndex)}`, riskLevel: "high" as const, request: approved };
  }
  if (action === "viron_business_risk_request") {
    const resolved = resolveMcpBusinessOperation("risk", arguments_.operation, arguments_.input);
    return {
      title: `确认${resolved.operation.title}`,
      summary: resolved.operation.description,
      riskLevel: resolved.operation.riskLevel,
      request: approved,
    };
  }
  throw new Error("不支持的风险确认 Operation");
}

export async function registerMcpOperationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/mcp/operations", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = operationCreateSchema.safeParse(request.body);
    if (!parsed.success || !request.admin) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "Operation 请求参数不正确" });
    try {
      const normalizedRequest = resolveVironMcpApiRequest(parsed.data.action, { ...parsed.data.arguments, workspace: workspaceKey(request) });
      if (normalizedRequest.path !== "/api/v1/mcp/operations" || normalizedRequest.method !== "POST") throw new Error("该 MCP 工具不能创建 Operation");
      const normalized = normalizedRequest.body as { action: string; arguments: Record<string, unknown> };
      const isCredential = normalized.action.includes("_secure_");
      let spec: {
        title: string;
        summary: string;
        riskLevel: "low" | "medium" | "high";
        request: McpApiRequest;
        credential?: { kind: McpCredentialKind; mode: "create" | "update" };
      };
      if (isCredential) {
        await ensureCredentialTarget(app, request, normalized.action, normalized.arguments);
        const credential = credentialSpec(normalized.action, normalized.arguments);
        spec = { ...credential, riskLevel: "medium" };
      } else {
        spec = await confirmationSpec(app, request, normalized.action, normalized.arguments);
      }
      const desktop = !isCredential
        && Boolean(request.sessionId)
        && request.headers["x-viron-execution-mode"] === "local"
        && supportsDesktopExecution(spec.request);
      const approvalMode = approvalModeForRequest(request);
      const requiresApproval = isCredential || mcpApprovalRequired(approvalMode, spec.riskLevel);
      const awaitingPurpose = !isCredential && requiresApproval;
      const created = app.mcpOperations.create({
        ownerUserId: request.admin.id,
        apiKeyId: request.apiKey?.id ?? null,
        workspaceType: request.admin.workspace.type,
        workspaceId: request.admin.workspace.id,
        action: normalized.action,
        kind: isCredential ? "credential" : "confirmation",
        title: spec.title,
        summary: spec.summary,
        riskLevel: spec.riskLevel,
        actionUrl: (id) => `${actionOrigin(request)}/mcp/operations/${id}`,
        executionTarget: desktop ? "desktop" : "server",
        executionScope: executionScope(request),
        request: spec.request,
        credential: spec.credential ?? null,
        awaitingPurpose,
      });
      if (created.desktopLease) reply.header("X-Viron-MCP-Desktop-Lease", created.desktopLease);
      await writeAudit(app.db, {
        action: "mcp.operation_created",
        resourceType: "mcp_operation",
        resourceId: created.operation.id,
        summary: `创建 MCP Operation：${created.operation.title}`,
        details: {
          action: created.operation.action,
          kind: created.operation.kind,
          riskLevel: created.operation.riskLevel,
          executionTarget: created.operation.executionTarget,
          approvalMode,
          approval: requiresApproval ? "user" : "automatic",
          purposeRequired: awaitingPurpose,
        },
        request,
      });
      if (!requiresApproval) {
        if (desktop) {
          app.mcpOperations.approveDesktop(created.operation);
        } else {
          app.mcpOperations.startServer(created.operation);
          const response = await executeOperationRequest(app, request, created.operation, created.operation.request);
          app.mcpOperations.complete(created.operation, response);
        }
        await writeAudit(app.db, {
          action: created.operation.status === "approved"
            ? "mcp.operation_approved"
            : created.operation.status === "completed"
              ? "mcp.operation_completed"
              : "mcp.operation_failed",
          resourceType: "mcp_operation",
          resourceId: created.operation.id,
          summary: `自动审批 MCP Operation：${created.operation.title}`,
          details: {
            action: created.operation.action,
            status: created.operation.status,
            executionTarget: created.operation.executionTarget,
            approvalMode,
          },
          request,
        });
      }
      return reply.code(201).send(app.mcpOperations.public(created.operation));
    } catch (error) {
      return reply.code(400).send({ error: "MCP_OPERATION_REJECTED", message: error instanceof Error ? error.message : "Operation 请求被拒绝" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/mcp/operations/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const operation = operationForRequest(app, request, request.params.id);
    if (!operation) return reply.code(404).send({ error: "MCP_OPERATION_NOT_FOUND", message: "Operation 不存在或无权访问" });
    return app.mcpOperations.public(operation);
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/operations/:id/purpose", { preHandler: requireAdmin }, async (request, reply) => {
    const operation = operationForRequest(app, request, request.params.id);
    if (!operation) return reply.code(404).send({ error: "MCP_OPERATION_NOT_FOUND", message: "Operation 不存在或无权访问" });
    const parsed = operationPurposeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: `执行意图必须是 ${VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH}–${VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH} 字的一句话`,
      });
    }
    try {
      app.mcpOperations.providePurpose(operation, parsed.data.purpose);
      await writeAudit(app.db, {
        action: "mcp.operation_purpose_provided",
        resourceType: "mcp_operation",
        resourceId: operation.id,
        summary: `补充 MCP Operation 执行意图：${operation.title}`,
        details: {
          action: operation.action,
          purpose: operation.purpose,
          riskLevel: operation.riskLevel,
          executionTarget: operation.executionTarget,
        },
        request,
      });
      return app.mcpOperations.public(operation);
    } catch (error) {
      return reply.code(409).send({ error: "MCP_OPERATION_PURPOSE_REJECTED", message: error instanceof Error ? error.message : "Operation 当前不能补充执行意图" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/mcp/operations/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const operation = operationForRequest(app, request, request.params.id);
    if (!operation) return reply.code(404).send({ error: "MCP_OPERATION_NOT_FOUND", message: "Operation 不存在或无权访问" });
    if (!app.mcpOperations.cancel(operation)) return reply.code(409).send({ error: "MCP_OPERATION_NOT_CANCELLABLE", message: "Operation 当前不能取消" });
    await writeAudit(app.db, { action: "mcp.operation_cancelled", resourceType: "mcp_operation", resourceId: operation.id, summary: `取消 MCP Operation：${operation.title}`, request });
    return app.mcpOperations.public(operation);
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/operations/:id/desktop-result", { preHandler: requireAdmin }, async (request, reply) => {
    const operation = operationForRequest(app, request, request.params.id);
    if (!operation || operation.executionTarget !== "desktop") return reply.code(404).send({ error: "MCP_OPERATION_NOT_FOUND", message: "本机 Operation 不存在或无权访问" });
    const parsed = desktopResultSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "本机 Operation 结果无效" });
    try {
      app.mcpOperations.startDesktop(operation, parsed.data.lease);
      app.mcpOperations.complete(operation, parsed.data.response);
      await writeAudit(app.db, {
        action: operation.status === "completed" ? "mcp.operation_completed" : "mcp.operation_failed",
        resourceType: "mcp_operation",
        resourceId: operation.id,
        summary: `${operation.status === "completed" ? "完成" : "失败"}本机 MCP Operation：${operation.title}`,
        details: { action: operation.action, purpose: operation.purpose, status: operation.status, executionTarget: "desktop" },
        request,
      });
      return app.mcpOperations.public(operation);
    } catch (error) {
      return reply.code(409).send({ error: "MCP_OPERATION_RESULT_REJECTED", message: error instanceof Error ? error.message : "本机 Operation 结果被拒绝" });
    }
  });

  const browserOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization) {
      await reply.code(403).type("text/plain; charset=utf-8").send("Operation 页面不接受 API Key，请使用 Viron 登录 Session。\n");
      return;
    }
    await requireAdmin(request, reply);
  };

  app.get<{ Params: { id: string } }>("/mcp/operations/:id", { preHandler: browserOnly }, async (request, reply) => {
    const operation = operationForRequest(app, request, request.params.id);
    if (!operation) return reply.code(404).type("text/plain; charset=utf-8").send("Operation 不存在、已过期或当前工作空间无权访问。\n");
    return sendOperationPage(reply, operation);
  });

  app.post<{ Params: { id: string } }>("/mcp/operations/:id/submit", { preHandler: browserOnly, bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const operation = operationForRequest(app, request, request.params.id);
    if (!operation) return reply.code(404).type("text/plain; charset=utf-8").send("Operation 不存在、已过期或当前工作空间无权访问。\n");
    if (operation.status !== "pending") return sendOperationPage(reply, operation, "Operation 已处理、已取消或已过期。", true);
    try {
      if (operation.kind === "credential") {
        app.mcpOperations.startServer(operation);
        const credentialInput = operation.credential?.kind === "connectionImport"
          ? await connectionImportRequest(request, operation)
          : await credentialRequest(operation, request.body);
        const response = await executeOperationRequest(app, request, operation, credentialInput);
        app.mcpOperations.complete(operation, response);
      } else if (operation.executionTarget === "desktop") {
        app.mcpOperations.approveDesktop(operation);
      } else {
        app.mcpOperations.startServer(operation);
        const response = await executeOperationRequest(app, request, operation, operation.request);
        app.mcpOperations.complete(operation, response);
      }
      const status = app.mcpOperations.get(operation.id)?.status ?? operation.status;
      await writeAudit(app.db, {
        action: status === "approved" ? "mcp.operation_approved" : status === "completed" ? "mcp.operation_completed" : "mcp.operation_failed",
        resourceType: "mcp_operation",
        resourceId: operation.id,
        summary: `${status === "approved" ? "确认" : status === "completed" ? "完成" : "失败"} MCP Operation：${operation.title}`,
        details: { action: operation.action, purpose: operation.purpose, status, executionTarget: operation.executionTarget },
        request,
      });
      const message = status === "approved" ? "已确认。Viron App 会在 Codex 查询 Operation 状态时按当前本机模式执行。" : status === "completed" ? "操作已完成，可以关闭此窗口并返回 Codex。" : "操作执行失败，请返回 Codex 查看脱敏错误。";
      return sendOperationPage(reply, operation, message, status === "failed");
    } catch (error) {
      const status = app.mcpOperations.get(operation.id)?.status ?? operation.status;
      if (status === "running") app.mcpOperations.fail(operation, 500, "MCP_OPERATION_FAILED", error instanceof Error ? error.message : "Operation 执行失败");
      return sendOperationPage(reply, operation, error instanceof Error ? error.message : "Operation 执行失败", true);
    }
  });

  app.post<{ Params: { id: string } }>("/mcp/operations/:id/cancel", { preHandler: browserOnly }, async (request, reply) => {
    const operation = operationForRequest(app, request, request.params.id);
    if (!operation) return reply.code(404).type("text/plain; charset=utf-8").send("Operation 不存在、已过期或当前工作空间无权访问。\n");
    if (app.mcpOperations.cancel(operation)) {
      await writeAudit(app.db, { action: "mcp.operation_cancelled", resourceType: "mcp_operation", resourceId: operation.id, summary: `取消 MCP Operation：${operation.title}`, request });
    }
    return sendOperationPage(reply, operation, "Operation 已取消。");
  });
}
