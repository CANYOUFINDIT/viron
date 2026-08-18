export interface LogShortcutInput {
  key: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  repeat?: boolean;
  composing?: boolean;
}

export interface LogPauseShortcutContext {
  streamActive: boolean;
  dialogVisible?: boolean;
  editableTarget?: boolean;
  hasSelection?: boolean;
}

export interface LogReconnectShortcutContext {
  reconnectAvailable: boolean;
  dialogVisible?: boolean;
  interactiveTarget?: boolean;
}

export function isLogPauseShortcut(input: LogShortcutInput): boolean {
  return input.key.toLowerCase() === "c"
    && Boolean(input.control)
    && !input.meta
    && !input.alt
    && !input.shift
    && !input.repeat
    && !input.composing;
}

export function shouldHandleLogPauseShortcut(input: LogShortcutInput, context: LogPauseShortcutContext): boolean {
  return isLogPauseShortcut(input)
    && context.streamActive
    && !context.dialogVisible
    && !context.editableTarget
    && !context.hasSelection;
}

export function isLogReconnectShortcut(input: LogShortcutInput): boolean {
  return input.key === "Enter"
    && !input.control
    && !input.meta
    && !input.alt
    && !input.shift
    && !input.repeat
    && !input.composing;
}

export function shouldHandleLogReconnectShortcut(input: LogShortcutInput, context: LogReconnectShortcutContext): boolean {
  return isLogReconnectShortcut(input)
    && context.reconnectAvailable
    && !context.dialogVisible
    && !context.interactiveTarget;
}
