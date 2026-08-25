import { randomUUID } from "node:crypto";
import { WebSocket as NodeWebSocket, type RawData } from "ws";
import type { ActiveConnectionType } from "../shared/active-connection.js";
import type { DesktopDatabaseCredential, DesktopRedisCredential, DesktopSshCredential, DesktopWebCredential, DeviceIdentity } from "./device-identity.js";
import {
  openCredentialEnvelope,
  openDatabaseCredentialEnvelope,
  openRedisCredentialEnvelope,
  openSshCredentialEnvelope,
  signDeviceReport,
  solveDeviceChallenge,
  type CredentialEnvelope,
} from "./device-identity.js";
import type { DesktopDatabaseExecutionReport } from "./database-runtime.js";
import type { DesktopRedisExecutionReport } from "./redis-runtime.js";
import type { DesktopInspectionReportPayload } from "./connection-inspection-runtime.js";
import type { AgentSettingsScope } from "./agent-settings.js";
import type { AgentRuntimeScope } from "./agent-diagnostic-session.js";
import {
  closeDesktopSshConnectionPool,
  type DesktopSshContext,
} from "./ssh-runtime.js";
import {
  activeEndpoint,
  currentExecutionMode,
  executionScopeForEndpoint,
} from "./endpoint-context.js";
import {
  confirmSystemKeyAccess,
  deviceIdentity,
  forgetSystemKeyAccessConsent,
  rememberSystemKeyAccessConsent,
} from "./device-session.js";
import {
  assertDesktopRuntimeContextInitialized,
  desktopAgentRuntime,
  desktopAuditSourceContext,
  desktopDatabaseOperationRuntime,
  desktopDatabaseRuntime,
  desktopDeviceAuthorizationContext,
  desktopLogRuntime,
  desktopRedisRuntime,
  desktopRuntimeRegistrations,
  desktopSftpRuntime,
  desktopSshRuntime,
  pendingCredentialRequests,
  type DesktopAuthContext,
  type DesktopRuntimeRegistration,
} from "./desktop-runtime-context.js";
import { DesktopApiError, endpointJson } from "./http-proxy.js";
import { translate as tr } from "./i18n.js";
import { mainWindow } from "./window-host.js";

interface ManagedServiceSocket {
  id: string;
  socket: NodeWebSocket;
}

export interface ExecutionActivity {
  total: number;
  counts: { web: number; ssh: number; sftp: number; logs: number; database: number; redis: number };
}

interface DesktopSshExecutionReport {
  operationId: string;
  connectionId: string;
  action: "commands_read_batch";
  summary: string;
  details: Record<string, unknown>;
}

export const serviceSockets = new Map<string, ManagedServiceSocket>();
let desktopRuntimeContext: DesktopSshContext | null = null;
let desktopAuthContext: DesktopAuthContext | null = null;
let desktopAuthEndpoint: string | null = null;

export async function reserveDesktopRuntime(type: Exclude<ActiveConnectionType, "database" | "redis">, resourceId: string, relatedResourceId?: string, originEnvironmentId?: string): Promise<string> {
  assertDesktopRuntimeContextInitialized();
  const id = randomUUID();
  const response = await endpointJson<{ idleMinutes: number }>("/api/v1/active-connections/desktop", {
    method: "POST",
    body: { id, type, resourceId, relatedResourceId, originEnvironmentId },
  });
  desktopSshRuntime.setIdleMinutes(response.idleMinutes);
  return id;
}

export async function releaseDesktopRuntimeReservation(id: string): Promise<void> {
  desktopRuntimeRegistrations.delete(id);
  await endpointJson(`/api/v1/active-connections/desktop/${id}`, { method: "DELETE" }).catch(() => undefined);
}

export function trackDesktopRuntime(registration: DesktopRuntimeRegistration): void {
  desktopRuntimeRegistrations.set(registration.id, registration);
}

export async function syncDesktopRuntimeConnections(): Promise<void> {
  if (!activeEndpoint) return;
  const items: Array<{ id: string; lastActivityAt: number }> = [];
  for (const [id, registration] of desktopRuntimeRegistrations) {
    const lastActivityAt = registration.activity();
    if (lastActivityAt === null) {
      desktopRuntimeRegistrations.delete(id);
      continue;
    }
    items.push({ id, lastActivityAt });
  }
  try {
    const response = await endpointJson<{ close: Array<{ id: string; reason: string }> }>("/api/v1/active-connections/desktop", {
      method: "PUT",
      body: { items },
    });
    for (const request of response.close) {
      const registration = desktopRuntimeRegistrations.get(request.id);
      if (!registration) continue;
      await registration.close(request.reason);
      desktopRuntimeRegistrations.delete(request.id);
    }
    if (response.close.length) {
      const remaining = [...desktopRuntimeRegistrations.values()].flatMap((registration) => {
        const lastActivityAt = registration.activity();
        return lastActivityAt === null ? [] : [{ id: registration.id, lastActivityAt }];
      });
      await endpointJson("/api/v1/active-connections/desktop", { method: "PUT", body: { items: remaining } });
    }
  } catch {
    // The next heartbeat reconciles after transient endpoint or authentication failures.
  }
}

export function sendServiceSocketEvent(payload: Record<string, unknown>): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("viron:service-socket-event", payload);
}

export function serviceSocketBytes(data: RawData): ArrayBuffer {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Uint8Array.from(buffer).buffer;
}

export async function openServiceSocket(path: string, params: Record<string, string>): Promise<{ id: string }> {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  if (currentExecutionMode() !== "server") throw new Error(tr("当前连接模式不是服务端转发"));
  if (!["/ws/ssh", "/ws/ssh-logs", "/ws/web-account-view"].includes(path)) throw new Error(tr("不支持的服务端实时通道"));
  const url = new URL(path, activeEndpoint.endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const cookies = await activeEndpoint.partition.cookies.get({ url: activeEndpoint.endpoint });
  const id = randomUUID();
  const socket = new NodeWebSocket(url, {
    headers: {
      Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      "X-Viron-API-Protocol": String(activeEndpoint.protocolVersion),
      "X-Viron-Execution-Scope": executionScopeForEndpoint(activeEndpoint.endpoint),
    },
  });
  serviceSockets.set(id, { id, socket });
  socket.once("open", () => sendServiceSocketEvent({ socketId: id, type: "open" }));
  socket.on("message", (data, isBinary) => sendServiceSocketEvent({
    socketId: id,
    type: "message",
    data: isBinary ? serviceSocketBytes(data) : data.toString(),
  }));
  socket.once("error", (error) => sendServiceSocketEvent({ socketId: id, type: "error", message: error.message }));
  socket.once("close", (code, reason) => {
    serviceSockets.delete(id);
    sendServiceSocketEvent({ socketId: id, type: "close", code, reason: reason.toString() });
  });
  return { id };
}

export function closeAllServiceSockets(reason: string): void {
  for (const { id, socket } of serviceSockets.values()) {
    sendServiceSocketEvent({ socketId: id, type: "close", code: 1000, reason });
    socket.terminate();
  }
  serviceSockets.clear();
}

export function emptyExecutionActivity(): ExecutionActivity {
  return { total: 0, counts: { web: 0, ssh: 0, sftp: 0, logs: 0, database: 0, redis: 0 } };
}

export function executionRuntimeApiMissing(error: unknown): boolean {
  return error instanceof DesktopApiError && error.status === 404;
}

export async function closeServerForwardingRuntime(reason: string): Promise<void> {
  if (!activeEndpoint || currentExecutionMode() !== "server") return;
  closeAllServiceSockets(reason);
  try {
    await endpointJson("/api/v1/auth/execution-runtime/close", { method: "POST" });
  } catch (error) {
    if (!executionRuntimeApiMissing(error)) throw error;
  }
}

export async function ensureDeviceRegistration(identity: DeviceIdentity): Promise<void> {
  try {
    const current = await endpointJson<{ keyId: string; status: string }>(`/api/v1/desktop/devices/${identity.deviceId}`);
    if (current.status !== "active") throw new Error(tr("当前设备已被撤销"));
    if (current.keyId !== identity.keyId) throw new Error(tr("中心服务记录的设备密钥与本机不一致"));
    return;
  } catch (error) {
    if (!(error instanceof DesktopApiError) || error.status !== 404 || error.code !== "DEVICE_NOT_FOUND") throw error;
  }
  const challenge = await endpointJson<{ challengeId: string; encryptedChallenge: string; keyId: string }>(
    "/api/v1/desktop/devices/registration-challenges",
    { method: "POST", body: { deviceId: identity.deviceId, publicKey: identity.publicKey } },
  );
  if (challenge.keyId !== identity.keyId) throw new Error(tr("中心服务返回的设备密钥标识不一致"));
  const proof = solveDeviceChallenge(identity, challenge.encryptedChallenge);
  await endpointJson(`/api/v1/desktop/devices/registration-challenges/${challenge.challengeId}/complete`, {
    method: "POST",
    body: { proof },
  });
}

export async function currentDeviceAuthorization(): Promise<{
  auth: DesktopAuthContext;
  identity: DeviceIdentity;
  endpoint: string;
}> {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  const endpoint = activeEndpoint.endpoint;
  const scoped = desktopDeviceAuthorizationContext.getStore();
  if (scoped?.endpoint === endpoint) return scoped;
  const auth = await currentDesktopAuthContext();
  await confirmSystemKeyAccess(endpoint, auth.user.id);
  let identity: DeviceIdentity;
  try {
    identity = deviceIdentity(endpoint, auth.user.id);
    rememberSystemKeyAccessConsent();
  } catch (error) {
    forgetSystemKeyAccessConsent();
    throw error;
  }
  try {
    await ensureDeviceRegistration(identity);
  } catch (error) {
    if ((error instanceof DesktopApiError && [401, 403].includes(error.status)) || /设备已被撤销/.test(error instanceof Error ? error.message : String(error))) {
      await closeDesktopExecution(tr("本机设备授权已失效"));
    }
    throw error;
  }
  return { auth, identity, endpoint };
}

export async function localWebCredential(credentialId: string): Promise<{
  auth: DesktopAuthContext;
  credential: DesktopWebCredential;
}> {
  if (currentExecutionMode() === "server"
    && activeEndpoint?.capabilities.serverForwarding.enabled
    && activeEndpoint.capabilities.serverForwarding.web) {
    throw new Error(tr("当前 Web 账号使用服务端转发"));
  }
  const { auth, identity, endpoint } = await currentDeviceAuthorization();
  const requestId = randomUUID();
  pendingCredentialRequests.add(requestId);
  try {
    const envelope = await endpointJson<CredentialEnvelope>(`/api/v1/desktop/web-credentials/${credentialId}/envelope`, {
      method: "POST",
      body: { deviceId: identity.deviceId, requestId, endpoint, auditSource: desktopAuditSourceContext.getStore() ?? "manual" },
    });
    if (!pendingCredentialRequests.has(requestId)) throw new Error(tr("凭据请求已经结束"));
    const opened = openCredentialEnvelope(identity, envelope, {
      requestId,
      userId: auth.user.id,
      workspaceType: auth.workspace.type,
      workspaceId: auth.workspace.id,
      credentialId,
      endpoint,
    });
    return { auth, credential: opened.credential };
  } finally {
    pendingCredentialRequests.delete(requestId);
  }
}

export async function localSshCredential(connectionId: string): Promise<{ context: DesktopSshContext; credential: DesktopSshCredential }> {
  if (currentExecutionMode() !== "local") throw new Error(tr("当前 SSH 连接使用服务端转发"));
  if (!activeEndpoint?.capabilities.desktopLocal?.ssh) throw new Error(tr("当前 Endpoint 未声明桌面 App 本机 SSH 能力"));
  const { auth, identity, endpoint } = await currentDeviceAuthorization();
  const requestId = randomUUID();
  pendingCredentialRequests.add(requestId);
  try {
    const envelope = await endpointJson<CredentialEnvelope>(`/api/v1/desktop/ssh-connections/${connectionId}/envelope`, {
      method: "POST",
      body: { deviceId: identity.deviceId, requestId, endpoint, auditSource: desktopAuditSourceContext.getStore() ?? "manual" },
    });
    if (!pendingCredentialRequests.has(requestId)) throw new Error(tr("SSH 凭据请求已经结束"));
    const opened = openSshCredentialEnvelope(identity, envelope, {
      requestId,
      userId: auth.user.id,
      workspaceType: auth.workspace.type,
      workspaceId: auth.workspace.id,
      connectionId,
      endpoint,
    });
    const context = { endpoint, userId: auth.user.id, workspaceType: auth.workspace.type, workspaceId: auth.workspace.id };
    desktopRuntimeContext = context;
    return { context, credential: opened.credential };
  } finally {
    pendingCredentialRequests.delete(requestId);
  }
}

export async function localDatabaseCredential(connectionId: string): Promise<{ context: DesktopSshContext; credential: DesktopDatabaseCredential }> {
  if (currentExecutionMode() !== "local") throw new Error(tr("当前数据库连接使用服务端转发"));
  if (!activeEndpoint?.capabilities.desktopLocal?.database) throw new Error(tr("当前 Endpoint 未声明桌面 App 本机数据库能力"));
  const { auth, identity, endpoint } = await currentDeviceAuthorization();
  const requestId = randomUUID();
  pendingCredentialRequests.add(requestId);
  try {
    const envelope = await endpointJson<CredentialEnvelope>(`/api/v1/desktop/database-connections/${connectionId}/envelope`, {
      method: "POST",
      body: { deviceId: identity.deviceId, requestId, endpoint, auditSource: desktopAuditSourceContext.getStore() ?? "manual" },
    });
    if (!pendingCredentialRequests.has(requestId)) throw new Error(tr("数据库凭据请求已经结束"));
    const opened = openDatabaseCredentialEnvelope(identity, envelope, {
      requestId,
      userId: auth.user.id,
      workspaceType: auth.workspace.type,
      workspaceId: auth.workspace.id,
      connectionId,
      endpoint,
    });
    const context = { endpoint, userId: auth.user.id, workspaceType: auth.workspace.type, workspaceId: auth.workspace.id };
    desktopRuntimeContext = context;
    return { context, credential: opened.credential };
  } finally {
    pendingCredentialRequests.delete(requestId);
  }
}

export async function localRedisCredential(connectionId: string): Promise<{ context: DesktopSshContext; credential: DesktopRedisCredential }> {
  if (currentExecutionMode() !== "local") throw new Error(tr("当前 Redis 连接使用服务端转发"));
  if (!activeEndpoint?.capabilities.desktopLocal?.redis) throw new Error(tr("当前 Endpoint 未声明桌面 App 本机 Redis 能力"));
  const { auth, identity, endpoint } = await currentDeviceAuthorization();
  const requestId = randomUUID();
  pendingCredentialRequests.add(requestId);
  try {
    const envelope = await endpointJson<CredentialEnvelope>(`/api/v1/desktop/redis-connections/${connectionId}/envelope`, {
      method: "POST",
      body: { deviceId: identity.deviceId, requestId, endpoint, auditSource: desktopAuditSourceContext.getStore() ?? "manual" },
    });
    if (!pendingCredentialRequests.has(requestId)) throw new Error(tr("Redis 凭据请求已经结束"));
    const opened = openRedisCredentialEnvelope(identity, envelope, {
      requestId,
      userId: auth.user.id,
      workspaceType: auth.workspace.type,
      workspaceId: auth.workspace.id,
      connectionId,
      endpoint,
    });
    const context = { endpoint, userId: auth.user.id, workspaceType: auth.workspace.type, workspaceId: auth.workspace.id };
    desktopRuntimeContext = context;
    return { context, credential: opened.credential };
  } finally {
    pendingCredentialRequests.delete(requestId);
  }
}

export async function signedDesktopOperation<T extends { operationId: string }>(
  payload: T,
  expectedContext?: DesktopSshContext,
): Promise<{ protected: string; signature: string }> {
  const { auth, identity, endpoint } = await currentDeviceAuthorization();
  if (expectedContext && (
    expectedContext.endpoint !== endpoint
    || expectedContext.userId !== auth.user.id
    || expectedContext.workspaceType !== auth.workspace.type
    || expectedContext.workspaceId !== auth.workspace.id
  )) {
    throw new Error(tr("本机执行报告所属用户或工作空间已经切换"));
  }
  const issuedAt = new Date();
  const protectedBytes = Buffer.from(JSON.stringify({
    version: 1,
    algorithm: "RSA-PSS-SHA256",
    keyId: identity.keyId,
    deviceId: identity.deviceId,
    operationId: payload.operationId,
    userId: auth.user.id,
    workspaceType: auth.workspace.type,
    workspaceId: auth.workspace.id,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    payload,
  }), "utf8");
  return {
    protected: protectedBytes.toString("base64url"),
    signature: signDeviceReport(identity, protectedBytes),
  };
}

export async function reportSignedDesktopOperation<T extends { operationId: string }>(
  path: string,
  report: T,
  expectedContext?: DesktopSshContext,
): Promise<void> {
  await endpointJson(path, {
    method: "POST",
    body: await signedDesktopOperation(
      { ...report, auditSource: desktopAuditSourceContext.getStore() ?? "manual" },
      expectedContext,
    ),
  });
}

export async function reportDesktopDatabaseExecution(report: DesktopDatabaseExecutionReport, context?: DesktopSshContext): Promise<void> {
  await reportSignedDesktopOperation("/api/v1/desktop/database-executions", report, context);
}

export async function reportDesktopSshExecution(report: DesktopSshExecutionReport, context?: DesktopSshContext): Promise<void> {
  await reportSignedDesktopOperation("/api/v1/desktop/ssh-executions", report, context);
}

export async function reportDesktopRedisExecution(report: DesktopRedisExecutionReport, context?: DesktopSshContext): Promise<void> {
  await reportSignedDesktopOperation("/api/v1/desktop/redis-executions", report, context);
}

export async function reportDesktopConnectionInspection(report: DesktopInspectionReportPayload, context: DesktopSshContext): Promise<void> {
  await reportSignedDesktopOperation("/api/v1/desktop/connection-inspections", report, context);
}

export async function currentDesktopSshContext(): Promise<DesktopSshContext> {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  if (desktopRuntimeContext?.endpoint === activeEndpoint.endpoint) return desktopRuntimeContext;
  const auth = await currentDesktopAuthContext();
  desktopRuntimeContext = {
    endpoint: activeEndpoint.endpoint,
    userId: auth.user.id,
    workspaceType: auth.workspace.type,
    workspaceId: auth.workspace.id,
  };
  return desktopRuntimeContext;
}

export async function currentDesktopAuthContext(): Promise<DesktopAuthContext> {
  if (!activeEndpoint) throw new Error(tr("请先验证 Viron Endpoint"));
  if (desktopAuthContext && desktopAuthEndpoint === activeEndpoint.endpoint) return desktopAuthContext;
  desktopAuthContext = await endpointJson<DesktopAuthContext>("/api/v1/auth/me");
  desktopAuthEndpoint = activeEndpoint.endpoint;
  return desktopAuthContext;
}

export async function currentAgentSettingsScope(): Promise<AgentSettingsScope> {
  const context = await currentDesktopSshContext();
  return { vironEndpoint: context.endpoint, vironUserId: context.userId };
}

export function agentRuntimeScope(context: DesktopSshContext): AgentRuntimeScope {
  return {
    vironEndpoint: context.endpoint,
    vironUserId: context.userId,
    workspaceType: context.workspaceType,
    workspaceId: context.workspaceId,
  };
}

export async function currentAgentRuntimeScope(): Promise<AgentRuntimeScope> {
  return agentRuntimeScope(await currentDesktopSshContext());
}

export async function touchDesktopDatabaseRequest(path: string, context: DesktopSshContext): Promise<void> {
  const pathname = new URL(path, "http://desktop.local").pathname;
  const connectionRoute = pathname.match(/^\/api\/v1\/database-connections\/([0-9a-f-]+)\//i);
  const queryRoute = pathname.match(/^\/api\/v1\/database-queries\/([0-9a-f-]+)$/i);
  const connectionId = connectionRoute?.[1] ?? (queryRoute ? desktopDatabaseRuntime.connectionIdForQuery(queryRoute[1], context) : null);
  if (!connectionId) return;
  await endpointJson("/api/v1/database-sessions/activity", { method: "POST", body: { connectionId } });
}

export async function touchDesktopRedisRequest(path: string): Promise<void> {
  const connectionId = new URL(path, "http://desktop.local").pathname.match(/^\/api\/v1\/redis-connections\/([0-9a-f-]+)\//i)?.[1];
  if (!connectionId) return;
  await endpointJson("/api/v1/redis-sessions/activity", { method: "POST", body: { connectionId } });
}

export async function closeDesktopExecution(reason: string): Promise<void> {
  assertDesktopRuntimeContextInitialized();
  desktopAgentRuntime?.stopAll(reason);
  await Promise.all([
    desktopSshRuntime.closeAllSessions(reason),
    desktopSftpRuntime.closeAll(),
    desktopDatabaseRuntime.closeAll(reason),
    desktopRedisRuntime.closeAll(),
    closeDesktopSshConnectionPool(),
  ]);
  desktopLogRuntime.closeAll(reason);
  await desktopDatabaseOperationRuntime.closeAll(reason);
  desktopRuntimeContext = null;
  desktopAuthContext = null;
  desktopAuthEndpoint = null;
  pendingCredentialRequests.clear();
}
