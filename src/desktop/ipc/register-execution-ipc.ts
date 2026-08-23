import { WebSocket as NodeWebSocket } from "ws";
import { ipcMain } from "electron";
import { translate as tr } from "../i18n.js";
import { mcpApprovalMode } from "../../shared/mcp-settings.js";
import { readState, writeState } from "../app-state.js";
import { activeEndpoint, currentExecutionMode } from "../endpoint-context.js";
import { trustedSender } from "../ipc-guards.js";
import {
  desktopAgentRuntime,
  desktopConnectionInspectionRuntime,
  desktopDatabaseOperationRuntime,
  desktopDatabaseRuntime,
  desktopLogRuntime,
  desktopRedisRuntime,
  desktopSftpRuntime,
  desktopSshRuntime,
} from "../desktop-runtime-context.js";
import {
  closeAllServiceSockets,
  closeDesktopExecution,
  currentDesktopSshContext,
  openServiceSocket,
  serviceSockets,
  touchDesktopDatabaseRequest,
  touchDesktopRedisRequest,
} from "../execution-router.js";
import {
  desktopMcpBroker,
  closeDesktopMcpOperations,
  localMcpStatus,
  setDesktopMcpLastError,
} from "../mcp-desktop-bridge.js";
import { closeDesktopSshConnectionPool } from "../ssh-runtime.js";
import { isDesktopConnectionInspectionPath } from "../connection-inspection-runtime.js";
import { isDesktopDatabaseExecutionPath } from "../database-runtime.js";
import {
  isDesktopDatabaseOperationPath,
} from "../database-operations-runtime.js";
import { isDesktopRedisExecutionPath } from "../redis-runtime.js";
import { endpointFetch, type DesktopRequest } from "../http-proxy.js";
import {
  closeAllDesktopWebViews,
  desktopWebMutationContext,
  reconcileDesktopWebMutation,
} from "../web-view-runtime.js";

export function registerDesktopExecutionIpc(): void {
  ipcMain.handle("viron:mcp:status", (event) => {
    trustedSender(event);
    return localMcpStatus();
  });
  ipcMain.handle("viron:mcp:enabled:set", async (event, enabled: unknown) => {
    trustedSender(event);
    if (typeof enabled !== "boolean") throw new Error(tr("本机 MCP 开关值无效"));
    const currentlyEnabled = readState().localMcpEnabled === true;
    if (enabled) {
      try {
        await desktopMcpBroker.start();
        setDesktopMcpLastError(null);
      } catch (error) {
        setDesktopMcpLastError(error);
        throw error;
      }
    } else if (currentlyEnabled || desktopMcpBroker.status().running) {
      await closeDesktopMcpOperations();
      await desktopMcpBroker.close();
      setDesktopMcpLastError(null);
    }
    const state = readState();
    writeState({ ...state, localMcpEnabled: enabled });
    return localMcpStatus();
  });
  ipcMain.handle("viron:mcp:approval-mode:set", async (event, mode: unknown) => {
    trustedSender(event);
    const approvalMode = mcpApprovalMode(mode);
    if (approvalMode !== mode) throw new Error(tr("MCP 审批策略无效"));
    const state = readState();
    writeState({ ...state, localMcpApprovalMode: approvalMode });
    return localMcpStatus();
  });

  ipcMain.handle("viron:service-socket:open", async (event, path: string, params: Record<string, string>) => {
    trustedSender(event);
    return openServiceSocket(path, params ?? {});
  });
  ipcMain.handle("viron:service-socket:send", (event, id: string, data: string | ArrayBuffer) => {
    trustedSender(event);
    const managed = serviceSockets.get(id);
    if (!managed || managed.socket.readyState !== NodeWebSocket.OPEN) throw new Error(tr("服务端实时通道尚未连接"));
    managed.socket.send(typeof data === "string" ? data : Buffer.from(data));
    return { sent: true as const };
  });
  ipcMain.handle("viron:service-socket:close", (event, id: string) => {
    trustedSender(event);
    const managed = serviceSockets.get(id);
    if (!managed) return { closed: false as const };
    managed.socket.close(1000, tr("用户关闭连接"));
    return { closed: true as const };
  });

  ipcMain.handle("viron:api", async (event, request: DesktopRequest) => {
    trustedSender(event);
    if (request.path.startsWith("/api/v1/desktop/")
      || request.path === "/api/v1/auth/execution-runtime/close"
      || /^\/api\/v1\/web-credentials\/[^/]+\/reveal$/.test(request.path)
      || /^\/api\/v1\/ssh-sessions\/[^/]+\/agent-(?:context|diagnostics)(?:\/|$)/.test(request.path)) {
      throw new Error(tr("桌面界面不能直接调用受保护的主进程或敏感接口"));
    }
    const method = (request.method ?? "GET").toUpperCase();
    if (currentExecutionMode() === "local" && isDesktopConnectionInspectionPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.inspection) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机连接巡检能力，桌面 App 不会回退到服务端执行"));
      }
      return desktopConnectionInspectionRuntime.handle(request, await currentDesktopSshContext());
    }
    if (currentExecutionMode() === "local" && isDesktopDatabaseExecutionPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.database) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，桌面 App 不会回退到服务端执行"));
      }
      const context = await currentDesktopSshContext();
      await touchDesktopDatabaseRequest(request.path, context);
      return desktopDatabaseRuntime.handle(request, context);
    }
    if (currentExecutionMode() === "local" && isDesktopRedisExecutionPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.redis) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机 Redis 能力，桌面 App 不会回退到服务端执行"));
      }
      await touchDesktopRedisRequest(request.path);
      return desktopRedisRuntime.handle(request, await currentDesktopSshContext());
    }
    if (currentExecutionMode() === "local" && isDesktopDatabaseOperationPath(request.path)) {
      if (!activeEndpoint || activeEndpoint.protocolVersion < 2 || !activeEndpoint.capabilities.desktopLocal?.database) {
        throw new Error(tr("当前 Endpoint 未开放桌面 App 本机数据库能力，桌面 App 不会回退到服务端执行"));
      }
      return desktopDatabaseOperationRuntime.handle(request, await currentDesktopSshContext());
    }
    const mutationContext = await desktopWebMutationContext(request.path, method);
    const response = await endpointFetch(request);
    const result = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body: await response.text(),
    };
    if (response.ok && ["/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/workspace"].includes(request.path)) {
      const reason = request.path.endsWith("login") ? tr("用户已重新登录") : request.path.endsWith("logout") ? tr("用户已退出登录") : tr("工作空间已切换");
      closeAllServiceSockets(reason);
      await Promise.all([closeDesktopMcpOperations(), closeAllDesktopWebViews(), closeDesktopExecution(reason)]);
    } else {
      await reconcileDesktopWebMutation(mutationContext, method, response);
      const sshConnection = request.path.match(/^\/api\/v1\/ssh-connections\/([0-9a-f-]+)$/i);
      if (response.ok && sshConnection && ["PUT", "DELETE"].includes(method)) {
        const reason = method === "DELETE" ? tr("SSH 连接已删除") : tr("SSH 连接配置已更新");
        for (const session of desktopSshRuntime.list(await currentDesktopSshContext())) {
          if (session.connectionId === sshConnection[1]) desktopAgentRuntime.stopForSource(`desktop-ssh:${session.id}`, reason);
        }
        await Promise.all([
          desktopSshRuntime.closeConnection(sshConnection[1], reason),
          closeDesktopSshConnectionPool(sshConnection[1]),
          desktopDatabaseRuntime.closeAll(reason),
          desktopRedisRuntime.closeAll(),
        ]);
        desktopSftpRuntime.closeConnection(sshConnection[1]);
        desktopLogRuntime.closeConnection(sshConnection[1], reason);
      }
      const databaseConnection = request.path.match(/^\/api\/v1\/database-connections\/([0-9a-f-]+)$/i);
      if (response.ok && databaseConnection && ["PUT", "DELETE"].includes(method)) {
        desktopAgentRuntime.stopForSourcePrefix(`desktop-database:${databaseConnection[1]}:`, method === "DELETE" ? tr("数据库连接已删除") : tr("数据库连接配置已更新"));
        await desktopDatabaseRuntime.closeConnection(databaseConnection[1], method === "DELETE" ? tr("数据库连接已删除") : tr("数据库连接配置已更新"));
        desktopDatabaseOperationRuntime.closeConnection(databaseConnection[1], method === "DELETE" ? tr("数据库连接已删除") : tr("数据库连接配置已更新"));
      }
      const redisConnection = request.path.match(/^\/api\/v1\/redis-connections\/([0-9a-f-]+)$/i);
      if (response.ok && redisConnection && ["PUT", "DELETE"].includes(method)) {
        await desktopRedisRuntime.closeConnection(redisConnection[1]);
      }
      const environmentLog = request.path.match(/^\/api\/v1\/environment-logs\/([0-9a-f-]+)$/i);
      if (response.ok && environmentLog && ["PUT", "DELETE"].includes(method)) {
        desktopLogRuntime.closeLog(environmentLog[1], method === "DELETE" ? tr("日志配置已删除") : tr("日志配置已更新"));
      }
    }
    return result;
  });

}
