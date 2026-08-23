import { ipcMain } from "electron";
import { translate as tr } from "../i18n.js";
import { activeEndpoint } from "../endpoint-context.js";
import { trustedSender } from "../ipc-guards.js";
import { desktopLogRuntime } from "../desktop-runtime-context.js";
import {
  currentDesktopSshContext,
  releaseDesktopRuntimeReservation,
  reserveDesktopRuntime,
  trackDesktopRuntime,
} from "../execution-router.js";
import { endpointJson } from "../http-proxy.js";
import { requireDesktopString } from "./desktop-ipc-parse.js";

interface DesktopEnvironmentLog {
  id: string;
  sshConnectionId: string;
  name: string;
  filePaths: string[];
  connectionAvailable: boolean;
}

export function registerDesktopLogIpc(): void {
  ipcMain.handle("viron:logs:open", async (event, input: { environmentId?: unknown; logId?: unknown; initialLines?: unknown }) => {
    trustedSender(event);
    if (!activeEndpoint?.capabilities.desktopLocal?.logs) throw new Error(tr("当前 Endpoint 未声明桌面 App 本机日志能力"));
    const environmentId = requireDesktopString(input?.environmentId, tr("环境 ID"));
    const logId = requireDesktopString(input?.logId, tr("日志配置 ID"));
    const initialLines = Number(input?.initialLines);
    const response = await endpointJson<{ items: DesktopEnvironmentLog[] }>(`/api/v1/environments/${encodeURIComponent(environmentId)}/logs`);
    const log = response.items.find((item) => item.id === logId);
    if (!log) throw new Error(tr("日志配置不存在或无权访问"));
    if (!log.connectionAvailable) throw new Error(tr("该 SSH 连接已不可用，请编辑日志配置"));
    const registrationId = await reserveDesktopRuntime("logs", log.id, undefined, environmentId);
    try {
      const opened = await desktopLogRuntime.create({
        logId: log.id,
        logName: log.name,
        sshConnectionId: log.sshConnectionId,
        filePaths: log.filePaths,
        initialLines,
      });
      trackDesktopRuntime({
        id: registrationId,
        localId: opened.stream.id,
        activity: () => desktopLogRuntime.activity(opened.stream.id),
        close: (reason) => { desktopLogRuntime.close(opened.stream.id, undefined, reason); },
      });
      return { ...opened, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });

  ipcMain.handle("viron:logs:close", async (event, streamId: unknown) => {
    trustedSender(event);
    const closed = desktopLogRuntime.close(
      requireDesktopString(streamId, tr("日志流 ID")),
      await currentDesktopSshContext(),
    );
    if (!closed) throw new Error(tr("实时日志不存在或已经结束"));
    return { closed: true as const };
  });
}


