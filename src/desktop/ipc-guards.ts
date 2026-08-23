import type { IpcMainInvokeEvent } from "electron";
import { translate as tr } from "./i18n.js";
import { agentChatWindow } from "./overlays/agent-chat-window.js";
import { mainWindow } from "./window-host.js";

export function isTrustedAppSender(event: IpcMainInvokeEvent): boolean {
  return Boolean(
    (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)
    || (agentChatWindow && !agentChatWindow.isDestroyed() && event.sender === agentChatWindow.webContents),
  );
}

export function trustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedAppSender(event)) throw new Error(tr("拒绝来自非主窗口的请求"));
}

export function trustedMainWindowSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error(tr("拒绝来自非主窗口的请求"));
}

export function trustedAgentChatSender(event: IpcMainInvokeEvent): void {
  if (!agentChatWindow || event.sender !== agentChatWindow.webContents) throw new Error(tr("拒绝来自非 Agent 对话窗口的请求"));
}
