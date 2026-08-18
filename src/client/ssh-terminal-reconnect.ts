export type SshTerminalStatus = "connecting" | "connected" | "disconnected" | "closed";

export function shouldReconnectFromTerminalKey(event: KeyboardEvent, status: SshTerminalStatus): boolean {
  return status === "disconnected"
    && event.type === "keydown"
    && event.key === "Enter"
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !event.isComposing;
}
