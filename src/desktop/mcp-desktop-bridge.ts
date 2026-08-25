import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow } from "electron";
import { translate as tr } from "./i18n.js";
import {
  isDesktopDatabaseExecutionPath,
} from "./database-runtime.js";
import {
  isDesktopDatabaseDownloadPath,
  isDesktopDatabaseOperationPath,
} from "./database-operations-runtime.js";
import { isDesktopRedisExecutionPath } from "./redis-runtime.js";
import { isDesktopConnectionInspectionPath } from "./connection-inspection-runtime.js";
import type { DesktopSftpTransferOptions } from "./sftp-runtime.js";
import {
  connectDesktopSshConnection,
  executeDesktopSshCommandOnConnection,
  type DesktopSshCommandResult,
} from "./ssh-runtime.js";
import { sshCommandRiskLevel } from "../shared/ssh-command-risk.js";
import { DesktopMcpBroker } from "./mcp-broker.js";
import { desktopMcpOperationUrlAllowed } from "./mcp-security.js";
import { resolveVironMcpApiRequest, resolveVironMcpApprovedRequest } from "../shared/mcp-tools.js";
import type { McpApiRequest, McpApiResponse, VironMcpOperationPublic } from "../shared/mcp-protocol.js";
import {
  mcpApprovalMode,
  VIRON_MCP_APPROVAL_MODE_HEADER,
  type DesktopMcpStatus,
} from "../shared/mcp-settings.js";
import { readState } from "./app-state.js";
import { activeEndpoint, currentExecutionMode } from "./endpoint-context.js";
import { mainWindow } from "./window-host.js";
import {
  desktopAuditSourceContext,
  desktopConnectionInspectionRuntime,
  desktopDatabaseOperationRuntime,
  desktopDatabaseRuntime,
  desktopDeviceAuthorizationContext,
  desktopLogRuntime,
  desktopMcpApprovalModeContext,
  desktopRedisRuntime,
  desktopSftpRuntime,
  desktopSshRuntime,
} from "./desktop-runtime-context.js";
import {
  currentDesktopSshContext,
  currentDeviceAuthorization,
  localSshCredential,
  reportDesktopSshExecution,
  touchDesktopDatabaseRequest,
} from "./execution-router.js";
import { endpointFetch, endpointJson, type DesktopRequest } from "./http-proxy.js";
import {
  actOnDesktopWebCredential,
  controlDesktopWebCredential,
  desktopWebViews,
  resetDesktopWebViews,
  snapshotDesktopWebCredential,
  uploadDesktopWebCredential,
  type DesktopMcpWebAction,
  type DesktopMcpWebControl,
} from "./web-view-runtime.js";

interface DesktopEnvironmentLog {
  id: string;
  sshConnectionId: string;
  name: string;
  filePaths: string[];
  connectionAvailable: boolean;
}

export let desktopMcpBroker: DesktopMcpBroker;
let desktopMcpLastError: string | null = null;
const desktopMcpOperationWindows = new Set<BrowserWindow>();
const desktopMcpOperationIds = new Set<string>();
const desktopMcpPendingOperations = new Map<string, {
  lease: string;
  request: McpApiRequest;
  response?: McpApiResponse;
  running?: Promise<McpApiResponse>;
}>();

export function initializeDesktopMcpBridge(broker: DesktopMcpBroker): void {
  if (desktopMcpBroker) throw new Error("Desktop MCP bridge has already been initialized");
  desktopMcpBroker = broker;
}

export function setDesktopMcpLastError(error: unknown | null): void {
  desktopMcpLastError = error == null ? null : error instanceof Error ? error.message : tr("本机 MCP Broker 启动失败");
}

export function localMcpLauncherPath(): string {
  return process.platform === "win32"
    ? join(dirname(process.execPath), "viron-mcp.cmd")
    : join(dirname(process.execPath), "viron-mcp");
}

export function localMcpStatus(): DesktopMcpStatus {
  const broker = desktopMcpBroker.status();
  return {
    enabled: readState().localMcpEnabled === true,
    approvalMode: mcpApprovalMode(readState().localMcpApprovalMode),
    running: broker.running,
    transport: broker.transport,
    address: broker.address,
    launcherPath: localMcpLauncherPath(),
    clients: broker.clients,
    lastError: desktopMcpLastError,
  };
}

export async function openDesktopMcpOperationWindow(actionUrl: string): Promise<void> {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  const target = new URL(actionUrl);
  if (!desktopMcpOperationUrlAllowed(activeEndpoint.endpoint, target.href)) {
    throw new Error(tr("Viron MCP Operation 页面地址无效"));
  }
  const existing = [...desktopMcpOperationWindows].find((window) => !window.isDestroyed() && window.webContents.getURL() === target.href);
  if (existing) {
    existing.show();
    existing.focus();
    return;
  }
  const operationWindow = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 520,
    minHeight: 480,
    show: false,
    parent: mainWindow ?? undefined,
    modal: false,
    closable: true,
    title: tr("Viron 安全操作"),
    backgroundColor: "#edf1f0",
    webPreferences: {
      session: activeEndpoint.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  desktopMcpOperationWindows.add(operationWindow);
  operationWindow.setMenuBarVisibility(false);
  operationWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  operationWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  operationWindow.webContents.on("will-navigate", (event, url) => {
    if (desktopMcpOperationUrlAllowed(activeEndpoint!.endpoint, url, true)) return;
    event.preventDefault();
  });
  const operationId = target.pathname.split("/").at(-1)!;
  let closeWithoutCancelling = false;
  let checkingStatus = false;
  let statusRefreshQueued = false;
  const closeWindow = () => {
    if (operationWindow.isDestroyed()) return;
    closeWithoutCancelling = true;
    operationWindow.close();
  };
  const refreshOperationStatus = (queueIfBusy = false) => {
    if (checkingStatus) {
      statusRefreshQueued ||= queueIfBusy;
      return;
    }
    if (operationWindow.isDestroyed()) return;
    checkingStatus = true;
    void endpointJson<VironMcpOperationPublic>(`/api/v1/mcp/operations/${operationId}`)
      .then((operation) => {
        if (operation.status === "approved") {
          const pending = desktopMcpPendingOperations.get(operationId);
          if (pending) {
            pending.running ??= completeDesktopMcpOperation(operationId, pending).finally(() => { pending.running = undefined; });
            void pending.running.catch(() => undefined);
          }
          closeWindow();
        } else if (["completed", "failed", "cancelled", "expired"].includes(operation.status)) {
          desktopMcpPendingOperations.delete(operationId);
          desktopMcpOperationIds.delete(operationId);
          closeWindow();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checkingStatus = false;
        if (!statusRefreshQueued) return;
        statusRefreshQueued = false;
        refreshOperationStatus();
      });
  };
  const statusTimer = setInterval(() => refreshOperationStatus(), 750);
  operationWindow.webContents.on("did-navigate", (_event, url) => {
    try {
      if (/\/(?:submit|cancel)$/.test(new URL(url).pathname)) refreshOperationStatus(true);
    } catch {
      // Navigation is already constrained by desktopMcpOperationUrlAllowed.
    }
  });
  operationWindow.once("ready-to-show", () => operationWindow.show());
  operationWindow.once("closed", () => {
    clearInterval(statusTimer);
    desktopMcpOperationWindows.delete(operationWindow);
    if (closeWithoutCancelling || !desktopMcpOperationIds.has(operationId)) return;
    desktopMcpOperationIds.delete(operationId);
    desktopMcpPendingOperations.delete(operationId);
    void endpointJson(`/api/v1/mcp/operations/${operationId}`, { method: "DELETE" }).catch(() => undefined);
  });
  await operationWindow.loadURL(target.href);
}

export async function closeDesktopMcpOperations(cancelRemote = true): Promise<void> {
  const operationIds = [...desktopMcpOperationIds];
  desktopMcpOperationIds.clear();
  desktopMcpPendingOperations.clear();
  for (const operationWindow of [...desktopMcpOperationWindows]) {
    if (!operationWindow.isDestroyed()) operationWindow.destroy();
  }
  desktopMcpOperationWindows.clear();
  if (!cancelRemote || !activeEndpoint) return;
  await Promise.all(operationIds.map((operationId) => endpointJson(`/api/v1/mcp/operations/${operationId}`, { method: "DELETE" }).catch(() => undefined)));
}

export function mcpRequestPath(input: McpApiRequest): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") query.set(name, String(value));
  }
  return `${input.path}${query.size ? `?${query.toString()}` : ""}`;
}

export function mcpDesktopRequest(input: McpApiRequest): DesktopRequest {
  const formEntries = input.form ? [
    ...Object.entries(input.form.fields ?? {}).map(([name, value]) => ({ name, value })),
    ...(input.form.files ?? []).map((file) => {
      const data = Buffer.from(file.contentBase64, "base64");
      return {
        name: file.fieldName,
        file: {
          name: file.filename,
          type: file.contentType,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        },
      };
    }),
  ] : undefined;
  return {
    path: mcpRequestPath(input),
    method: input.method,
    headers: input.form ? undefined : input.body === undefined ? undefined : [["content-type", "application/json"]],
    body: input.form ? { kind: "form", entries: formEntries } : input.body === undefined ? undefined : { kind: "text", value: JSON.stringify(input.body) },
  };
}

export function mcpFormFile(input: McpApiRequest): { name: string; type: string; data: Buffer } {
  const file = input.form?.files?.[0];
  if (!file) throw new Error(tr("MCP 文件请求缺少文件内容"));
  return { name: file.filename, type: file.contentType, data: Buffer.from(file.contentBase64, "base64") };
}

export function isDesktopLocalMcpExecutionPath(path: string): boolean {
  const pathname = new URL(path, "http://desktop.local").pathname;
  return isDesktopConnectionInspectionPath(path)
    || isDesktopDatabaseExecutionPath(path)
    || isDesktopDatabaseOperationPath(path)
    || isDesktopDatabaseDownloadPath(path)
    || isDesktopRedisExecutionPath(path)
    || /^\/api\/v1\/mcp\/ssh-connections\/[0-9a-f-]+\/commands$/i.test(pathname)
    || /^\/api\/v1\/ssh-connections\/[0-9a-f-]+\/sftp(?:\/download)?$/i.test(pathname)
    || /^\/api\/v1\/sftp-transfers(?:\/preview|\/[0-9a-f-]+)?$/i.test(pathname)
    || /^\/api\/v1\/mcp\/environment-logs\/[0-9a-f-]+\/snapshot$/i.test(pathname)
    || /^\/api\/v1\/mcp\/web-credentials\/[0-9a-f-]+\/snapshot$/i.test(pathname)
    || /^\/api\/v1\/ssh-recordings(?:\/[0-9a-f-]+(?:\/download)?)?$/i.test(pathname);
}

export function boundedDesktopSshBatchResult(result: DesktopSshCommandResult, maxBytes: number): DesktopSshCommandResult {
  const stdout = Buffer.from(result.stdout, "utf8");
  const boundedStdout = stdout.subarray(0, Math.max(0, maxBytes));
  const remaining = Math.max(0, maxBytes - boundedStdout.length);
  const stderr = Buffer.from(result.stderr, "utf8");
  const boundedStderr = stderr.subarray(0, remaining);
  return {
    ...result,
    stdout: boundedStdout.toString("utf8"),
    stderr: boundedStderr.toString("utf8"),
    truncated: result.truncated || boundedStdout.length < stdout.length || boundedStderr.length < stderr.length,
  };
}

export async function executeDesktopMcpApprovedRequest(input: McpApiRequest): Promise<McpApiResponse> {
  if (!desktopDeviceAuthorizationContext.getStore()) {
    const authorization = await currentDeviceAuthorization();
    return desktopDeviceAuthorizationContext.run(authorization, () => executeDesktopMcpApprovedRequest(input));
  }
  return desktopAuditSourceContext.run("mcp", async () => {
    const request = mcpDesktopRequest(input);
    const path = request.path;
    try {
      const sshCommand = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/ssh-connections\/([0-9a-f-]+)\/command$/i);
      if (sshCommand && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.ssh) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SSH 能力，MCP 不会回退到服务端执行"));
        const body = input.body as { command: string; timeoutMs: number; maxBytes: number };
        const loaded = await connectDesktopSshConnection(sshCommand[1], await currentDesktopSshContext(), localSshCredential);
        try {
          return mcpJsonResponse(200, await executeDesktopSshCommandOnConnection(loaded.connected, body.command, { timeoutMs: body.timeoutMs, maxBytes: body.maxBytes }));
        } finally {
          loaded.connected.close();
        }
      }
      if (isDesktopDatabaseExecutionPath(path)) {
        if (!activeEndpoint?.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
        const context = await currentDesktopSshContext();
        await touchDesktopDatabaseRequest(path, context);
        return desktopResponseToMcp(await desktopDatabaseRuntime.handle(request, context));
      }
      if (isDesktopDatabaseOperationPath(path)) {
        if (!activeEndpoint?.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
        return desktopResponseToMcp(await desktopDatabaseOperationRuntime.handle(request, await currentDesktopSshContext()));
      }
      if (isDesktopRedisExecutionPath(path)) {
        if (!activeEndpoint?.capabilities.desktopLocal?.redis) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Redis 能力，MCP 不会回退到服务端执行"));
        return desktopResponseToMcp(await desktopRedisRuntime.handle(request, await currentDesktopSshContext()));
      }
      const url = new URL(path, "http://desktop.local");
      const sftp = url.pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp\/(mkdir|rename|chmod)$/i);
      if (sftp && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        const body = input.body as { path: string; newPath?: string; mode?: string };
        if (sftp[2] === "mkdir") return mcpJsonResponse(201, await desktopSftpRuntime.mkdir(sftp[1], body.path));
        if (sftp[2] === "rename") return mcpJsonResponse(200, await desktopSftpRuntime.rename(sftp[1], body.path, body.newPath ?? ""));
        await desktopSftpRuntime.chmod(sftp[1], body.path, body.mode ?? "");
        return mcpJsonResponse(200, { ok: true });
      }
      const sftpDelete = url.pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp$/i);
      if (sftpDelete && input.method === "DELETE") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        await desktopSftpRuntime.delete(sftpDelete[1], String((input.body as { path?: unknown }).path ?? ""));
        return mcpJsonResponse(204, null);
      }
      if (url.pathname === "/api/v1/sftp-transfers" && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(201, { task: await desktopSftpRuntime.create(await currentDesktopSshContext(), input.body as DesktopSftpTransferOptions) });
      }
      const sftpUpload = url.pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp\/upload$/i);
      if (sftpUpload && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        const file = mcpFormFile(input);
        const context = await currentDesktopSshContext();
        const started = await desktopSftpRuntime.startUpload(sftpUpload[1], url.searchParams.get("path") ?? "/", file.name, context);
        try {
          await desktopSftpRuntime.uploadChunk(started.uploadId, context, file.data);
          return mcpJsonResponse(201, await desktopSftpRuntime.completeUpload(started.uploadId, context));
        } catch (error) {
          try { desktopSftpRuntime.cancelUpload(started.uploadId, context); } catch { /* Upload may already be closed. */ }
          throw error;
        }
      }
      const sftpRetry = url.pathname.match(/^\/api\/v1\/sftp-transfers\/([0-9a-f-]+)\/retry$/i);
      if (sftpRetry && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(201, { task: await desktopSftpRuntime.retryTransfer(sftpRetry[1], await currentDesktopSshContext()) });
      }
      const webAction = url.pathname.match(/^\/api\/v1\/mcp\/web-credentials\/([0-9a-f-]+)\/action$/i);
      if (webAction && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(200, await actOnDesktopWebCredential(webAction[1], input.body as DesktopMcpWebAction));
      }
      const webControl = url.pathname.match(/^\/api\/v1\/mcp\/web-credentials\/([0-9a-f-]+)\/control$/i);
      if (webControl && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
        return mcpJsonResponse(200, await controlDesktopWebCredential(webControl[1], input.body as DesktopMcpWebControl));
      }
      const webUpload = url.pathname.match(/^\/api\/v1\/web-credentials\/([0-9a-f-]+)\/view\/upload$/i);
      if (webUpload && input.method === "POST") {
        if (!activeEndpoint?.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
        const file = mcpFormFile(input);
        return mcpJsonResponse(200, await uploadDesktopWebCredential(webUpload[1], file.name, file.data));
      }
      throw new Error(tr("当前本机 MCP Operation 没有对应的受控 Runtime"));
    } catch (error) {
      return mcpJsonResponse(502, { error: "DESKTOP_MCP_OPERATION_FAILED", message: error instanceof Error ? error.message : tr("本机 MCP Operation 执行失败") });
    }
  });
}

export async function completeDesktopMcpOperation(operationId: string, pending: NonNullable<ReturnType<typeof desktopMcpPendingOperations.get>>): Promise<McpApiResponse> {
  pending.response ??= await executeDesktopMcpApprovedRequest(pending.request);
  const operation = await endpointJson<VironMcpOperationPublic>(`/api/v1/mcp/operations/${operationId}/desktop-result`, {
    method: "POST",
    body: { lease: pending.lease, response: pending.response },
  });
  desktopMcpPendingOperations.delete(operationId);
  desktopMcpOperationIds.delete(operationId);
  return mcpJsonResponse(200, operation);
}

export async function handleDesktopMcpOperationResponse(toolName: string, arguments_: Record<string, unknown>, response: McpApiResponse): Promise<McpApiResponse> {
  const data = response.data as Partial<VironMcpOperationPublic> | null;
  if (response.status < 400 && data?.operationId && ["awaiting_purpose", "pending", "approved"].includes(String(data.status))) {
    desktopMcpOperationIds.add(data.operationId);
    const leaseHeader = response.headers["x-viron-mcp-desktop-lease"];
    const lease = Array.isArray(leaseHeader) ? leaseHeader[0] : leaseHeader;
    if (lease) {
      desktopMcpPendingOperations.set(data.operationId, {
        lease,
        request: resolveVironMcpApprovedRequest(toolName, arguments_),
      });
    }
    if (data.status === "awaiting_purpose") return response;
    if (data.status === "pending") {
      if (!data.actionUrl) throw new Error(tr("Viron Operation 缺少审批页面地址"));
      await openDesktopMcpOperationWindow(data.actionUrl);
      return response;
    }
    const pending = desktopMcpPendingOperations.get(data.operationId);
    if (!pending) throw new Error(tr("本机 Operation 缺少当前 App 启动实例的执行租约，请重新创建 Operation"));
    pending.running ??= completeDesktopMcpOperation(data.operationId, pending).finally(() => { pending.running = undefined; });
    return pending.running;
  }
  if (toolName === "viron_operation_get" && response.status < 400 && data?.operationId && data.status === "approved") {
    const pending = desktopMcpPendingOperations.get(data.operationId);
    if (!pending) throw new Error(tr("本机 Operation 缺少当前 App 启动实例的执行租约，请重新创建 Operation"));
    pending.running ??= completeDesktopMcpOperation(data.operationId, pending).finally(() => { pending.running = undefined; });
    return pending.running;
  }
  if (toolName === "viron_operation_cancel" && data?.operationId) desktopMcpPendingOperations.delete(data.operationId);
  if (data?.operationId && ["completed", "failed", "cancelled", "expired"].includes(String(data.status))) desktopMcpOperationIds.delete(data.operationId);
  return response;
}

export async function invokeDesktopMcpTool(toolName: string, arguments_: Record<string, unknown>): Promise<McpApiResponse> {
  if (!activeEndpoint) throw new Error(tr("请先在 Viron App 中验证 Endpoint"));
  const request = resolveVironMcpApiRequest(toolName, arguments_);
  if (request.workspace) {
    const context = await currentDesktopSshContext();
    const currentWorkspace = context.workspaceType === "personal" ? "personal" : `organization:${context.workspaceId}`;
    if (request.workspace !== currentWorkspace) {
      throw new Error(tr("本机 MCP 只能使用 Viron App 当前工作空间（当前：{{0}}，请求：{{1}}）", [currentWorkspace, request.workspace]));
    }
  }
  const path = mcpRequestPath(request);
  const desktopRequest = mcpDesktopRequest(request);
  if (currentExecutionMode() === "local" && isDesktopLocalMcpExecutionPath(path) && !desktopDeviceAuthorizationContext.getStore()) {
    const authorization = await currentDeviceAuthorization();
    const source = desktopAuditSourceContext.getStore() ?? "mcp";
    return desktopDeviceAuthorizationContext.run(authorization, () => desktopAuditSourceContext.run(source, () => invokeDesktopMcpTool(toolName, arguments_)));
  }
  if (currentExecutionMode() === "local") {
    const sshBatch = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/ssh-connections\/([0-9a-f-]+)\/commands$/i);
    if (sshBatch && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.ssh) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SSH 能力，MCP 不会回退到服务端执行"));
      const body = request.body as { commands: string[]; timeoutMs: number; maxBytes: number };
      if (body.commands.some((command) => sshCommandRiskLevel(command) !== "low")) {
        return mcpJsonResponse(400, { error: "SSH_BATCH_NOT_READ_ONLY", message: tr("SSH 批量读取只允许可证明为只读的命令") });
      }
      const context = await currentDesktopSshContext();
      const started = Date.now();
      const acquireStarted = Date.now();
      const loaded = await connectDesktopSshConnection(sshBatch[1], context, localSshCredential);
      const transportAcquireDurationMs = Date.now() - acquireStarted;
      const items = [];
      let remainingBytes = body.maxBytes;
      try {
        for (let index = 0; index < body.commands.length; index += 1) {
          if (remainingBytes <= 0) {
            items.push({ index, ok: false, error: tr("SSH 批量响应已达到总输出限制") });
            continue;
          }
          try {
            const result = boundedDesktopSshBatchResult(await executeDesktopSshCommandOnConnection(
              loaded.connected,
              body.commands[index],
              { timeoutMs: body.timeoutMs, maxBytes: Math.max(1024, remainingBytes) },
            ), remainingBytes);
            remainingBytes -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
            items.push({ index, ok: true, ...result });
          } catch (error) {
            items.push({ index, ok: false, error: error instanceof Error ? error.message : tr("SSH 命令执行失败") });
          }
        }
      } finally {
        loaded.connected.close();
      }
      const durationMs = Date.now() - started;
      await reportDesktopSshExecution({
        operationId: randomUUID(),
        connectionId: sshBatch[1],
        action: "commands_read_batch",
        summary: tr("本机批量执行 {{0}} 条 SSH 只读命令", [body.commands.length]),
        details: {
          commandCount: body.commands.length,
          failedCount: items.filter((item) => !item.ok).length,
          outputBytes: body.maxBytes - remainingBytes,
          durationMs,
          transportAcquireDurationMs,
          transportReused: loaded.reused,
        },
      }, context);
      return mcpJsonResponse(200, {
        items,
        durationMs,
        outputBytes: body.maxBytes - remainingBytes,
        reusedConnection: body.commands.length > 1,
        transportReused: loaded.reused,
        transportAcquireDurationMs,
      });
    }
    if (isDesktopConnectionInspectionPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.inspection) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机连接巡检能力，MCP 不会回退到服务端执行"));
      return desktopResponseToMcp(await desktopConnectionInspectionRuntime.handle(desktopRequest, await currentDesktopSshContext()));
    }
    if (isDesktopDatabaseExecutionPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
      const context = await currentDesktopSshContext();
      await touchDesktopDatabaseRequest(path, context);
      return desktopResponseToMcp(await desktopDatabaseRuntime.handle(desktopRequest, context));
    }
    if (isDesktopDatabaseOperationPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
      return desktopResponseToMcp(await desktopDatabaseOperationRuntime.handle(desktopRequest, await currentDesktopSshContext()));
    }
    if (isDesktopDatabaseDownloadPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，MCP 不会回退到服务端执行"));
      const download = await desktopDatabaseOperationRuntime.download(path, await currentDesktopSshContext());
      return mcpJsonResponse(200, {
        filename: download.filename,
        contentType: download.contentType,
        size: download.data.length,
        contentBase64: download.data.toString("base64"),
      });
    }
    if (isDesktopRedisExecutionPath(path)) {
      if (!activeEndpoint.capabilities.desktopLocal?.redis) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Redis 能力，MCP 不会回退到服务端执行"));
      return desktopResponseToMcp(await desktopRedisRuntime.handle(desktopRequest, await currentDesktopSshContext()));
    }
    const sftpList = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp$/i);
    if (sftpList && (request.method ?? "GET") === "GET") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      return mcpJsonResponse(200, await desktopSftpRuntime.list(sftpList[1], new URL(path, "http://desktop.local").searchParams.get("path") ?? "/"));
    }
    if (path === "/api/v1/sftp-transfers") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      return mcpJsonResponse(200, { items: desktopSftpRuntime.listTransfers(await currentDesktopSshContext()) });
    }
    if (path === "/api/v1/sftp-transfers/preview" && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      const body = request.body as Omit<DesktopSftpTransferOptions, "conflict">;
      return mcpJsonResponse(200, await desktopSftpRuntime.preview(body));
    }
    const sftpDownload = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)\/sftp\/download$/i);
    if (sftpDownload && (request.method ?? "GET") === "GET") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      const url = new URL(path, "http://desktop.local");
      const download = await desktopSftpRuntime.download(sftpDownload[1], url.searchParams.get("path") ?? "/");
      return mcpJsonResponse(200, {
        filename: download.filename,
        contentType: "application/octet-stream",
        size: download.data.length,
        contentBase64: download.data.toString("base64"),
      });
    }
    const sftpTransfer = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/sftp-transfers\/([0-9a-f-]+)$/i);
    if (sftpTransfer && request.method === "DELETE") {
      if (!activeEndpoint.capabilities.desktopLocal?.sftp) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SFTP 能力，MCP 不会回退到服务端执行"));
      desktopSftpRuntime.cancelTransfer(sftpTransfer[1], await currentDesktopSshContext());
      return mcpJsonResponse(204, null);
    }
    const logSnapshot = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/environment-logs\/([0-9a-f-]+)\/snapshot$/i);
    if (logSnapshot && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.logs) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机日志能力，MCP 不会回退到服务端执行"));
      const body = request.body as { initialLines: number; maxBytes: number };
      const response = await endpointJson<{ items: DesktopEnvironmentLog[] }>(`/api/v1/environments/${encodeURIComponent(await environmentIdForLog(logSnapshot[1]))}/logs`);
      const log = response.items.find((item) => item.id === logSnapshot[1]);
      if (!log || !log.connectionAvailable) throw new Error(tr("日志配置不存在或关联 SSH 连接不可用"));
      return mcpJsonResponse(200, await desktopLogRuntime.snapshot({ logId: log.id, logName: log.name, sshConnectionId: log.sshConnectionId, filePaths: log.filePaths, initialLines: body.initialLines }, body.maxBytes));
    }
    const webSnapshot = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/mcp\/web-credentials\/([0-9a-f-]+)\/snapshot$/i);
    if (webSnapshot && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
      const body = request.body as { width: number; height: number; maxTextChars: number };
      return mcpJsonResponse(200, await snapshotDesktopWebCredential(webSnapshot[1], body.width, body.height, body.maxTextChars));
    }
    const webReset = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/web-credentials\/([0-9a-f-]+)\/view\/reset$/i);
    if (webReset && request.method === "POST") {
      if (!activeEndpoint.capabilities.desktopLocal?.web) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Web 能力，MCP 不会回退到服务端执行"));
      const views = [...desktopWebViews.values()].filter((view) => view.credentialId === webReset[1] && !view.closing);
      if (views.length) await resetDesktopWebViews(views);
      return mcpJsonResponse(200, { ok: true });
    }
    const sshRecording = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/ssh-recordings(?:\/([0-9a-f-]+)(?:\/download)?)?$/i);
    if (sshRecording) {
      if (!activeEndpoint.capabilities.desktopLocal?.ssh) throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 SSH 能力，MCP 不会回退到服务端执行"));
      const context = await currentDesktopSshContext();
      if (!sshRecording[1] && (request.method ?? "GET") === "GET") return mcpJsonResponse(200, { items: desktopSshRuntime.listRecordings(context) });
      if (sshRecording[1] && request.method === "DELETE") {
        desktopSshRuntime.deleteRecording(sshRecording[1], context);
        return mcpJsonResponse(204, null);
      }
      if (sshRecording[1] && (request.method ?? "GET") === "GET") {
        const file = desktopSshRuntime.recordingFile(sshRecording[1], context);
        const data = await readFile(file.path);
        return mcpJsonResponse(200, { filename: file.filename, contentType: "application/x-asciicast", size: data.length, contentBase64: data.toString("base64") });
      }
    }
    if (/^\/api\/v1\/web-view-downloads\//.test(new URL(path, "http://desktop.local").pathname)) {
      throw new Error(tr("本机 Web 下载由系统保存对话框处理，不存在可回读的服务端下载 ID"));
    }
  }
  const response = await endpointFetch({
    ...desktopRequest,
    headers: [
      ...(desktopRequest.headers ?? []),
      ["X-Viron-MCP-Origin", activeEndpoint.endpoint],
      [VIRON_MCP_APPROVAL_MODE_HEADER, desktopMcpApprovalModeContext.getStore() ?? mcpApprovalMode(readState().localMcpApprovalMode)],
    ],
  });
  const headers = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get("content-type") ?? "";
  let data: unknown;
  if (contentType.includes("application/json")) {
    const body = await response.text();
    try { data = body ? JSON.parse(body) as unknown : null; }
    catch { data = { error: "INVALID_JSON_RESPONSE", message: tr("Viron Endpoint 返回了无效 JSON") }; }
  } else if (contentType.startsWith("text/") || contentType.includes("application/sql") || contentType.includes("application/x-asciicast")) {
    data = await response.text();
  } else {
    const binary = Buffer.from(await response.arrayBuffer());
    data = {
      contentType: contentType || "application/octet-stream",
      contentDisposition: response.headers.get("content-disposition") ?? "",
      size: binary.length,
      contentBase64: binary.toString("base64"),
    };
  }
  return handleDesktopMcpOperationResponse(toolName, arguments_, { status: response.status, headers, data });
}

export function mcpJsonResponse(status: number, data: unknown): McpApiResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, data };
}

export function desktopResponseToMcp(response: { status: number; headers: Array<[string, string]>; body: string }): McpApiResponse {
  const headers = Object.fromEntries(response.headers);
  let data: unknown = response.body;
  if (headers["content-type"]?.includes("application/json")) {
    try { data = response.body ? JSON.parse(response.body) as unknown : null; }
    catch { data = { error: "INVALID_JSON_RESPONSE", message: tr("桌面 Runtime 返回了无效 JSON") }; }
  }
  return { status: response.status, headers, data };
}

export async function environmentIdForLog(logId: string): Promise<string> {
  const environments = await endpointJson<{ items: Array<{ id: string }> }>("/api/v1/environments");
  for (const environment of environments.items) {
    const logs = await endpointJson<{ items: DesktopEnvironmentLog[] }>(`/api/v1/environments/${encodeURIComponent(environment.id)}/logs`);
    if (logs.items.some((item) => item.id === logId)) return environment.id;
  }
  throw new Error(tr("日志配置不存在或无权访问"));
}
