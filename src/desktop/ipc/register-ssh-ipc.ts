import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { app, dialog, ipcMain } from "electron";
import { translate as tr } from "../i18n.js";
import {
  desktopSftpRemoteConnectionIds,
  type DesktopSftpTransferOptions,
} from "../sftp-runtime.js";
import { mainWindow } from "../window-host.js";
import { trustedSender } from "../ipc-guards.js";
import {
  desktopAgentRuntime,
  desktopSftpRuntime,
  desktopSshRuntime,
} from "../desktop-runtime-context.js";
import {
  currentDesktopSshContext,
  localSshCredential,
  releaseDesktopRuntimeReservation,
  reserveDesktopRuntime,
  trackDesktopRuntime,
} from "../execution-router.js";
import { desktopBinary, requireDesktopInput, requireDesktopString } from "./desktop-ipc-parse.js";

export function registerDesktopSshIpc(): void {
  ipcMain.handle("viron:ssh:list", async (event) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    return { items: desktopSshRuntime.list(context) };
  });

  ipcMain.handle("viron:ssh:open", async (event, input: { connectionId?: unknown; originEnvironmentId?: unknown; cols?: unknown; rows?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const cols = Number(input?.cols ?? 120);
    const rows = Number(input?.rows ?? 32);
    const originEnvironmentId = typeof input?.originEnvironmentId === "string" ? input.originEnvironmentId : undefined;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error(tr("终端尺寸无效"));
    const loaded = await localSshCredential(connectionId);
    const registrationId = await reserveDesktopRuntime("ssh", connectionId, undefined, originEnvironmentId);
    try {
      const opened = await desktopSshRuntime.create(loaded.context, loaded.credential, cols, rows);
      trackDesktopRuntime({
        id: registrationId,
        localId: opened.session.id,
        activity: () => desktopSshRuntime.activity(opened.session.id),
        close: (reason) => {
          desktopAgentRuntime?.stopForSource(`desktop-ssh:${opened.session.id}`, reason);
          return desktopSshRuntime.close(opened.session.id, reason);
        },
      });
      return { ...opened, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });

  ipcMain.handle("viron:ssh:ticket", async (event, sessionId: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    return { ticket: desktopSshRuntime.ticket(requireDesktopString(sessionId, tr("SSH 会话 ID")), context) };
  });

  ipcMain.handle("viron:ssh:attach", async (event, sessionId: unknown, ticket: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    return desktopSshRuntime.attach(requireDesktopString(sessionId, tr("SSH 会话 ID")), requireDesktopString(ticket, tr("终端票据")), context);
  });

  ipcMain.handle("viron:ssh:detach", async (event, sessionId: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    desktopSshRuntime.detach(requireDesktopString(sessionId, tr("SSH 会话 ID")), context);
    return { detached: true as const };
  });

  ipcMain.handle("viron:ssh:action", async (event, sessionId: unknown, action: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown }) => {
    trustedSender(event);
    const id = requireDesktopString(sessionId, tr("SSH 会话 ID"));
    const context = await currentDesktopSshContext();
    if (action?.type === "input") await desktopSshRuntime.input(id, context, requireDesktopInput(action.data));
    else if (action?.type === "binary") await desktopSshRuntime.input(id, context, desktopBinary(action.data));
    else if (action?.type === "resize") {
      const cols = Number(action.cols);
      const rows = Number(action.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error(tr("终端尺寸无效"));
      desktopSshRuntime.resize(id, context, cols, rows);
    } else throw new Error(tr("不支持的终端操作"));
    return { ok: true as const };
  });

  ipcMain.handle("viron:ssh:close", async (event, sessionId: unknown) => {
    trustedSender(event);
    const context = await currentDesktopSshContext();
    const id = requireDesktopString(sessionId, tr("SSH 会话 ID"));
    if (!desktopSshRuntime.list(context).some((session) => session.id === id)) throw new Error(tr("SSH 会话不存在或已经结束"));
    desktopAgentRuntime.stopForSource(`desktop-ssh:${id}`, tr("当前 SSH 会话已关闭"));
    await desktopSshRuntime.close(id);
    return { closed: true as const };
  });

  ipcMain.handle("viron:ssh-recordings:list", async (event) => {
    trustedSender(event);
    return { items: desktopSshRuntime.listRecordings(await currentDesktopSshContext()) };
  });

  ipcMain.handle("viron:ssh-recordings:download", async (event, recordingId: unknown) => {
    trustedSender(event);
    const file = desktopSshRuntime.recordingFile(requireDesktopString(recordingId, tr("终端录像 ID")), await currentDesktopSshContext());
    const target = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath("downloads"), basename(file.filename)) });
    if (target.canceled || !target.filePath) return { saved: false as const };
    await copyFile(file.path, target.filePath);
    return { saved: true as const, filePath: target.filePath };
  });

  ipcMain.handle("viron:ssh-recordings:delete", async (event, recordingId: unknown) => {
    trustedSender(event);
    desktopSshRuntime.deleteRecording(requireDesktopString(recordingId, tr("终端录像 ID")), await currentDesktopSshContext());
    return { deleted: true as const };
  });

  ipcMain.handle("viron:sftp:list", async (event, input: { connectionId?: unknown; path?: unknown }) => {
    trustedSender(event);
    return desktopSftpRuntime.list(requireDesktopString(input?.connectionId, tr("SSH 连接 ID")), typeof input?.path === "string" ? input.path : "/");
  });

  ipcMain.handle("viron:sftp:action", async (event, input: { type?: unknown; connectionId?: unknown; path?: unknown; newPath?: unknown; mode?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const path = requireDesktopString(input?.path, tr("远程路径"));
    if (input.type === "mkdir") return desktopSftpRuntime.mkdir(connectionId, path);
    if (input.type === "rename") return desktopSftpRuntime.rename(connectionId, path, requireDesktopString(input.newPath, tr("新路径")));
    if (input.type === "chmod") {
      await desktopSftpRuntime.chmod(connectionId, path, requireDesktopString(input.mode, tr("权限")));
      return { ok: true as const };
    }
    if (input.type === "delete") {
      await desktopSftpRuntime.delete(connectionId, path);
      return { deleted: true as const };
    }
    throw new Error(tr("不支持的 SFTP 操作"));
  });

  ipcMain.handle("viron:sftp:upload-start", async (event, input: { connectionId?: unknown; directory?: unknown; filename?: unknown }) => {
    trustedSender(event);
    return desktopSftpRuntime.startUpload(
      requireDesktopString(input?.connectionId, tr("SSH 连接 ID")),
      requireDesktopString(input?.directory, tr("远程目录")),
      requireDesktopString(input?.filename, tr("上传文件名")),
      await currentDesktopSshContext(),
    );
  });

  ipcMain.handle("viron:sftp:upload-chunk", async (event, uploadId: unknown, data: unknown) => {
    trustedSender(event);
    await desktopSftpRuntime.uploadChunk(requireDesktopString(uploadId, tr("上传任务 ID")), await currentDesktopSshContext(), desktopBinary(data));
    return { accepted: true as const };
  });

  ipcMain.handle("viron:sftp:upload-complete", async (event, uploadId: unknown) => {
    trustedSender(event);
    return desktopSftpRuntime.completeUpload(requireDesktopString(uploadId, tr("上传任务 ID")), await currentDesktopSshContext());
  });

  ipcMain.handle("viron:sftp:upload-cancel", async (event, uploadId: unknown) => {
    trustedSender(event);
    desktopSftpRuntime.cancelUpload(requireDesktopString(uploadId, tr("上传任务 ID")), await currentDesktopSshContext());
    return { cancelled: true as const };
  });

  ipcMain.handle("viron:sftp:download", async (event, input: { connectionId?: unknown; path?: unknown; filename?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const path = requireDesktopString(input?.path, tr("远程路径"));
    const filename = typeof input?.filename === "string" ? basename(input.filename) : basename(path);
    const target = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath("downloads"), filename || "download") });
    if (target.canceled || !target.filePath) return { saved: false as const };
    await desktopSftpRuntime.downloadTo(connectionId, path, target.filePath);
    return { saved: true as const, filePath: target.filePath };
  });

  ipcMain.handle("viron:sftp:drag-out", async (event, input: { connectionId?: unknown; paths?: unknown }) => {
    trustedSender(event);
    const connectionId = requireDesktopString(input?.connectionId, tr("SSH 连接 ID"));
    const paths = Array.isArray(input?.paths) ? input.paths.map((path) => requireDesktopString(path, tr("来源路径"))) : [];
    if (!paths.length) throw new Error(tr("请选择要拖出的文件或目录"));
    const temporaryDirectory = join(app.getPath("temp"), "viron-sftp-drag", randomUUID());
    const materialized = await desktopSftpRuntime.materializeForNativeDrag(connectionId, paths, temporaryDirectory);
    const icon = await app.getFileIcon(materialized.files[0], { size: "small" });
    event.sender.startDrag({ file: materialized.files[0], files: materialized.files, icon });
    if (materialized.temporary) {
      const cleanup = setTimeout(() => void rm(temporaryDirectory, { recursive: true, force: true }), 10 * 60 * 1000);
      cleanup.unref();
    }
    return { started: true as const };
  });

  ipcMain.handle("viron:sftp-transfers:list", async (event) => {
    trustedSender(event);
    return { items: desktopSftpRuntime.listTransfers(await currentDesktopSshContext()) };
  });

  ipcMain.handle("viron:sftp-transfers:preview", async (event, input: Omit<DesktopSftpTransferOptions, "conflict">) => {
    trustedSender(event);
    const sourcePaths = Array.isArray(input?.sourcePaths)
      ? input.sourcePaths.map((path) => requireDesktopString(path, tr("来源路径")))
      : undefined;
    return desktopSftpRuntime.preview({
      sourceConnectionId: requireDesktopString(input?.sourceConnectionId, tr("来源 SSH 连接 ID")),
      targetConnectionId: requireDesktopString(input?.targetConnectionId, tr("目标 SSH 连接 ID")),
      sourcePath: typeof input?.sourcePath === "string" ? requireDesktopString(input.sourcePath, tr("来源路径")) : undefined,
      sourcePaths,
      targetDirectory: requireDesktopString(input?.targetDirectory, tr("目标目录")),
    });
  });

  ipcMain.handle("viron:sftp-transfers:create", async (event, input: DesktopSftpTransferOptions) => {
    trustedSender(event);
    const conflict = input?.conflict;
    if (conflict !== "overwrite" && conflict !== "skip") throw new Error(tr("文件冲突策略无效"));
    const sourcePaths = Array.isArray(input?.sourcePaths)
      ? input.sourcePaths.map((path) => requireDesktopString(path, tr("来源路径")))
      : undefined;
    const conflictDecisions = input?.conflictDecisions && Object.fromEntries(Object.entries(input.conflictDecisions).map(([path, decision]) => {
      if (decision !== "overwrite" && decision !== "skip") throw new Error(tr("文件冲突策略无效"));
      return [requireDesktopString(path, tr("目标路径")), decision];
    }));
    const sourceConnectionId = requireDesktopString(input?.sourceConnectionId, tr("来源 SSH 连接 ID"));
    const targetConnectionId = requireDesktopString(input?.targetConnectionId, tr("目标 SSH 连接 ID"));
    const [resourceId, relatedResourceId] = desktopSftpRemoteConnectionIds(sourceConnectionId, targetConnectionId);
    const registrationId = await reserveDesktopRuntime("sftp", resourceId, relatedResourceId, input.originEnvironmentId);
    try {
      const context = await currentDesktopSshContext();
      const task = await desktopSftpRuntime.create(context, {
      sourceConnectionId,
      targetConnectionId,
      sourcePath: typeof input?.sourcePath === "string" ? requireDesktopString(input.sourcePath, tr("来源路径")) : undefined,
      sourcePaths,
      targetDirectory: requireDesktopString(input?.targetDirectory, tr("目标目录")),
      conflict,
      conflictDecisions,
      });
      trackDesktopRuntime({
        id: registrationId,
        localId: task.id,
        activity: () => desktopSftpRuntime.activity(task.id),
        close: () => {
          if (desktopSftpRuntime.activity(task.id) !== null) desktopSftpRuntime.cancelTransfer(task.id, context);
        },
      });
      return { task, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });

  ipcMain.handle("viron:sftp-transfers:cancel", async (event, taskId: unknown) => {
    trustedSender(event);
    desktopSftpRuntime.cancelTransfer(requireDesktopString(taskId, tr("传输任务 ID")), await currentDesktopSshContext());
    return { cancelled: true as const };
  });

  ipcMain.handle("viron:sftp-transfers:retry", async (event, input: { taskId?: unknown; originEnvironmentId?: unknown }) => {
    trustedSender(event);
    const id = requireDesktopString(input?.taskId, tr("传输任务 ID"));
    const originEnvironmentId = typeof input?.originEnvironmentId === "string" ? input.originEnvironmentId : undefined;
    const context = await currentDesktopSshContext();
    const previous = desktopSftpRuntime.listTransfers(context).find((task) => task.id === id);
    if (!previous) throw new Error(tr("传输任务不存在"));
    const [resourceId, relatedResourceId] = desktopSftpRemoteConnectionIds(previous.sourceConnectionId, previous.targetConnectionId);
    const registrationId = await reserveDesktopRuntime("sftp", resourceId, relatedResourceId, originEnvironmentId);
    try {
      const task = await desktopSftpRuntime.retryTransfer(id, context);
      trackDesktopRuntime({
        id: registrationId,
        localId: task.id,
        activity: () => desktopSftpRuntime.activity(task.id),
        close: () => {
          if (desktopSftpRuntime.activity(task.id) !== null) desktopSftpRuntime.cancelTransfer(task.id, context);
        },
      });
      return { task, activeConnectionId: registrationId };
    } catch (error) {
      await releaseDesktopRuntimeReservation(registrationId);
      throw error;
    }
  });
}


