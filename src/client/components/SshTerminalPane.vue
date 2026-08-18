<script setup lang="ts">import { translate as tr } from "../i18n";

import { Download, Trash2, Upload, X } from "@lucide/vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ElMessage } from "element-plus";
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as Zmodem from "zmodem.js";
import {
  detectCwdFromPrompt,
  findSshCommandSuggestions,
  isLikelyShellPrompt,
  moveSshSuggestionSelection,
  parseOsc7Cwd,
  TerminalCommandTracker,
  UNKNOWN_REMOTE_CWD,
  type CommandSubmission,
  type SshCommandHistoryEntry,
} from "../ssh-command-history";
import { AgentTerminalExecutionCapture, type AgentTerminalExecutionResult } from "../agent-terminal-execution";
import { copyTextToClipboard } from "../clipboard";
import {
  attachDesktopSshSession,
  detachDesktopSshSession,
  isDesktopApp,
  onDesktopSshSessionEvent,
  readDesktopClipboardText,
  resizeDesktopSshSession,
  sendDesktopSshBinary,
  sendDesktopSshInput,
  writeDesktopClipboardText,
} from "../desktop";
import { ServiceSocket } from "../service-socket";
import { shouldReconnectFromTerminalKey, type SshTerminalStatus } from "../ssh-terminal-reconnect";
import { consoleUsesLightPalette, theme } from "../theme";

const props = withDefaults(defineProps<{
  sessionId: string;
  ticket: string;
  fontSize?: number;
  historyEntries?: SshCommandHistoryEntry[];
  historySuggestionsEnabled?: boolean;
  localExecution?: boolean;
  status?: SshTerminalStatus;
}>(), {
  historyEntries: () => [],
  historySuggestionsEnabled: true,
  localExecution: false,
  status: "connecting",
});

const emit = defineEmits<{
  status: [value: "connecting" | "connected" | "disconnected" | "closed"];
  closed: [reason: string];
  commandSubmitted: [value: CommandSubmission];
  historyRemove: [entry: SshCommandHistoryEntry];
  focused: [];
  reconnectRequested: [];
}>();

type TransferPhase = "waiting" | "transferring" | "success" | "error" | "cancelled";

interface TransferState {
  direction: "upload" | "download";
  phase: TransferPhase;
  fileName: string;
  bytesTransferred: number;
  totalBytes: number;
  filesComplete: number;
  filesTotal: number;
  message: string;
}

const terminalElement = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const transferState = ref<TransferState | null>(null);
const currentCommandInput = ref("");
const suggestionIndex = ref(-1);
const suggestionSuppressed = ref(false);
const suggestionAnchor = ref({ left: 8, top: 28 });
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let socket: ServiceSocket | null = null;
let desktopAttached = false;
let desktopAttaching = false;
let desktopEventBacklog: Uint8Array[] = [];
let unsubscribeDesktopEvents: (() => void) | null = null;
let desktopWriteQueue = Promise.resolve();
let desktopPendingBytes = 0;
let connectionGeneration = 0;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: number | undefined;
let transferNoticeTimer: number | undefined;
let selectionCopyTimer: number | undefined;
let zmodemSentry: Zmodem.Sentry | null = null;
let zmodemSession: Zmodem.Session | null = null;
let receivedFiles = 0;
let transferCancelled = false;
let pendingTransferEnd: { phase: "error" | "cancelled"; message: string } | null = null;
let intentionalClose = false;
let osc7Disposable: { dispose: () => void } | null = null;
let selectionChangeDisposable: { dispose: () => void } | null = null;
let outputDecoder = new TextDecoder();
let outputTail = "";
let currentDirectory = UNKNOWN_REMOTE_CWD;
const acceptingCommandInput = ref(false);
const commandTracker = new TerminalCommandTracker();
let lastCopiedSelection = "";
let selectionCopyQueue = Promise.resolve();
let agentExecution: {
  requestId: string;
  capture: AgentTerminalExecutionCapture;
  resolve: (result: AgentTerminalExecutionResult) => void;
  reject: (error: Error) => void;
  timer: number;
} | null = null;

const commandSuggestions = computed(() => props.historySuggestionsEnabled && acceptingCommandInput.value && !suggestionSuppressed.value
  ? findSshCommandSuggestions(props.historyEntries, currentCommandInput.value)
  : []);
const suggestionStyle = computed(() => ({
  left: `${suggestionAnchor.value.left}px`,
  top: `${suggestionAnchor.value.top}px`,
}));

const UPLOAD_CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_UPLOAD_BYTES = 2 * 1024 * 1024;

function terminalTheme(): ITheme {
  if (consoleUsesLightPalette()) {
    return {
      background: "#fbfcfd",
      foreground: "#17252a",
      cursor: "#137562",
      cursorAccent: "#ffffff",
      selectionBackground: "#c9e7df",
      black: "#11191c",
      red: "#b93632",
      green: "#187451",
      yellow: "#8b5c08",
      blue: "#216b9d",
      magenta: "#7c4596",
      cyan: "#126f73",
      white: "#4b5a5f",
      brightBlack: "#68777b",
      brightRed: "#ce443e",
      brightGreen: "#218a62",
      brightYellow: "#a36f12",
      brightBlue: "#337fad",
      brightMagenta: "#9556ad",
      brightCyan: "#21868a",
      brightWhite: "#26353a",
    };
  }
  return {
    background: "#081214",
    foreground: "#d7e2df",
    cursor: "#62d6b1",
    cursorAccent: "#081214",
    selectionBackground: "#235349",
    black: "#0b1517",
    red: "#ef6c67",
    green: "#65d4a8",
    yellow: "#e7b75e",
    blue: "#67a8d8",
    magenta: "#be8fd5",
    cyan: "#5bc4c6",
    white: "#d7e2df",
    brightBlack: "#536864",
    brightRed: "#ff8882",
    brightGreen: "#7ee7bc",
    brightYellow: "#f4ca78",
    brightBlue: "#82bde7",
    brightMagenta: "#d3a6e8",
    brightCyan: "#75d9db",
    brightWhite: "#f3f8f6",
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function transferPercent(state: TransferState): number {
  if (state.phase === "success") return 100;
  if (state.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((state.bytesTransferred / state.totalBytes) * 100)));
}

function transferTitle(state: TransferState): string {
  if (state.phase === "success") return state.direction === "upload" ? tr("上传完成") : tr("下载完成");
  if (state.phase === "error") return tr("传输失败");
  if (state.phase === "cancelled") return tr("传输已取消");
  if (state.phase === "waiting") return state.direction === "upload" ? tr("选择本地文件") : tr("等待远程文件");
  return state.direction === "upload" ? tr("正在上传") : tr("正在下载");
}

function updateTransfer(patch: Partial<TransferState>) {
  if (!transferState.value) return;
  transferState.value = { ...transferState.value, ...patch };
}

function setTerminalInputEnabled(enabled: boolean) {
  if (terminal) terminal.options.disableStdin = !enabled;
  if (enabled) nextTick(() => terminal?.focus());
}

function settleAgentCommand(result: AgentTerminalExecutionResult | Error): boolean {
  if (!agentExecution) return false;
  const pending = agentExecution;
  agentExecution = null;
  window.clearTimeout(pending.timer);
  setTerminalInputEnabled(!zmodemSession);
  if (result instanceof Error) pending.reject(result);
  else pending.resolve(result);
  return true;
}

function clearTransferNotice() {
  window.clearTimeout(transferNoticeTimer);
  transferState.value = null;
  setTerminalInputEnabled(true);
}

function scheduleTransferNoticeClear() {
  window.clearTimeout(transferNoticeTimer);
  transferNoticeTimer = window.setTimeout(clearTransferNotice, 2200);
}

function releaseZmodemSession() {
  zmodemSession = null;
  transferCancelled = false;
  if (fileInput.value) fileInput.value.value = "";
  setTerminalInputEnabled(true);
}

function handleZmodemSessionEnd() {
  const ending = pendingTransferEnd;
  pendingTransferEnd = null;
  releaseZmodemSession();
  if (!transferState.value) return;
  updateTransfer({
    phase: ending?.phase ?? "success",
    message: ending?.message ?? (transferState.value.direction === "upload" ? tr("文件已发送到远程主机") : tr("文件已保存到本机")),
  });
  if (ending?.phase !== "error") scheduleTransferNoticeClear();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : tr("ZMODEM 文件传输异常");
}

function abortTransfer(phase: "error" | "cancelled", message: string) {
  pendingTransferEnd = { phase, message };
  transferCancelled = true;
  const session = zmodemSession;
  try {
    if (session && !session.aborted()) session.abort();
  } catch {
    // The SSH peer may already have closed the ZMODEM session.
  }
  if (zmodemSession === session) {
    pendingTransferEnd = null;
    releaseZmodemSession();
    updateTransfer({ phase, message });
    if (phase === "cancelled") scheduleTransferNoticeClear();
  }
}

function cancelTransfer() {
  abortTransfer("cancelled", tr("已取消本次 ZMODEM 传输"));
}

function failTransfer(error: unknown) {
  abortTransfer("error", errorMessage(error));
}

function transportConnected(): boolean {
  return props.localExecution ? desktopAttached : socket?.readyState === ServiceSocket.OPEN;
}

function handleTransportError(error: unknown) {
  if (props.localExecution) desktopAttached = false;
  settleAgentCommand(new Error(errorMessage(error)));
  if (zmodemSession) failTransfer(error);
  else terminal?.writeln(tr("\r\n\u001b[31m[Viron] 终端通信失败：{0}\u001b[0m", [errorMessage(error)]));
  emit("status", "disconnected");
}

function enqueueDesktopWrite(operation: () => Promise<unknown>, bytes: number) {
  const generation = connectionGeneration;
  desktopPendingBytes += bytes;
  desktopWriteQueue = desktopWriteQueue
    .then(async () => {
      if (generation !== connectionGeneration) return;
      if (!desktopAttached) throw new Error(tr("SSH 终端连接已断开"));
      await operation();
    })
    .catch((error) => { if (generation === connectionGeneration) handleTransportError(error); })
    .finally(() => { desktopPendingBytes = Math.max(0, desktopPendingBytes - bytes); });
}

function sendTransportText(data: string) {
  if (!transportConnected()) throw new Error(tr("SSH 终端连接已断开"));
  if (props.localExecution) enqueueDesktopWrite(() => sendDesktopSshInput(props.sessionId, data), new TextEncoder().encode(data).byteLength);
  else socket!.send(JSON.stringify({ type: "input", data }));
}

function sendBinary(data: number[] | Uint8Array) {
  if (!transportConnected()) throw new Error(tr("SSH 终端连接已断开"));
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (props.localExecution) enqueueDesktopWrite(() => sendDesktopSshBinary(props.sessionId, bytes), bytes.byteLength);
  else socket!.send(bytes);
}

function observeTerminalOutput(text: string) {
  if (!text) return;
  outputTail = `${outputTail}${text}`.slice(-2048);
  const lastLine = outputTail.split(/[\r\n]/).at(-1) ?? "";
  const cwd = detectCwdFromPrompt(lastLine);
  if (cwd) currentDirectory = cwd;
  if (isLikelyShellPrompt(lastLine)) acceptingCommandInput.value = true;
}

function writeTerminalOutput(octets: number[] | Uint8Array) {
  if (!octets.length) return;
  const executionText = outputDecoder.decode(octets instanceof Uint8Array ? octets : Uint8Array.from(octets), { stream: true });
  observeTerminalOutput(executionText);
  terminal?.write(octets instanceof Uint8Array ? octets : Uint8Array.from(octets));
  const completed = agentExecution?.capture.append(executionText);
  if (completed && agentExecution) {
    settleAgentCommand(completed);
  }
}

function updateSuggestionAnchor() {
  if (!terminal || !terminalElement.value) return;
  const bounds = terminalElement.value.getBoundingClientRect();
  if (!bounds.width || !bounds.height || !terminal.cols || !terminal.rows) return;
  const cursor = terminal.buffer.active;
  const cellWidth = bounds.width / terminal.cols;
  const cellHeight = bounds.height / terminal.rows;
  const menuWidth = Math.min(420, Math.max(220, bounds.width - 16));
  const menuHeight = Math.min(260, 31 + commandSuggestions.value.length * 36);
  const cursorTop = cursor.cursorY * cellHeight;
  const belowCursor = cursorTop + cellHeight + 6;
  suggestionAnchor.value = {
    left: Math.max(8, Math.min(bounds.width - menuWidth - 8, cursor.cursorX * cellWidth + 8)),
    top: belowCursor + menuHeight <= bounds.height - 8
      ? belowCursor
      : Math.max(8, cursorTop - menuHeight - 6),
  };
}

function syncCurrentCommandInput() {
  const snapshot = commandTracker.snapshot();
  currentCommandInput.value = snapshot.reliable ? snapshot.value : "";
  window.requestAnimationFrame(updateSuggestionAnchor);
}

function trackTerminalInput(data: string) {
  suggestionSuppressed.value = false;
  suggestionIndex.value = -1;
  if (!acceptingCommandInput.value) {
    commandTracker.reset();
    currentCommandInput.value = "";
    return;
  }
  const alternateBuffer = terminal?.buffer.active.type === "alternate";
  const submissions = commandTracker.consume(data, alternateBuffer);
  for (const command of submissions) {
    emit("commandSubmitted", { command, cwd: currentDirectory });
  }
  if (submissions.length) {
    acceptingCommandInput.value = false;
    currentCommandInput.value = "";
  } else {
    syncCurrentCommandInput();
  }
}

function insertCommand(command: string): boolean {
  if (
    !command
    || /[\r\n]/.test(command)
    || !transportConnected()
    || Boolean(zmodemSession)
    || !acceptingCommandInput.value
    || terminal?.buffer.active.type === "alternate"
  ) return false;
  commandTracker.insert(command);
  syncCurrentCommandInput();
  suggestionSuppressed.value = true;
  sendTransportText(command);
  terminal?.focus();
  emit("focused");
  return true;
}

function replaceCurrentCommand(command: string): boolean {
  if (
    !command
    || /[\r\n]/.test(command)
    || !transportConnected()
    || Boolean(zmodemSession)
    || !acceptingCommandInput.value
    || terminal?.buffer.active.type === "alternate"
  ) return false;
  commandTracker.replace(command);
  currentCommandInput.value = command;
  suggestionSuppressed.value = true;
  suggestionIndex.value = -1;
  sendTransportText(`\x01\x0b${command}`);
  terminal?.focus();
  emit("focused");
  return true;
}

function replaceCurrentScript(script: string): boolean {
  if (
    !script
    || !/[\r\n]/.test(script)
    || /\0|\x1b/.test(script)
    || !transportConnected()
    || Boolean(zmodemSession)
    || !acceptingCommandInput.value
    || terminal?.buffer.active.type === "alternate"
    || !terminal?.modes.bracketedPasteMode
  ) return false;
  commandTracker.reset();
  currentCommandInput.value = "";
  suggestionSuppressed.value = true;
  suggestionIndex.value = -1;
  sendTransportText("\x01\x0b");
  terminal.paste(script.replace(/\r\n?/g, "\n"));
  terminal.focus();
  emit("focused");
  return true;
}

function executeAgentCommand(requestId: string, command: string, deadlineAt: string): Promise<AgentTerminalExecutionResult> {
  if (agentExecution) return Promise.reject(new Error(tr("当前终端已有 Agent 命令正在执行")));
  const snapshot = commandTracker.snapshot();
  if (
    !requestId
    || !command
    || /[\r\n]/.test(command)
    || !transportConnected()
    || props.status !== "connected"
    || Boolean(zmodemSession)
    || !acceptingCommandInput.value
    || terminal?.buffer.active.type === "alternate"
    || !snapshot.reliable
    || Boolean(snapshot.value)
  ) return Promise.reject(new Error(tr("当前终端必须已连接、停留在空闲 Shell 提示符且没有待输入内容")));
  const remainingMs = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return Promise.reject(new Error(tr("Viron Agent 多步诊断已达到 2 分钟总时限")));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (agentExecution?.requestId !== requestId) return;
      try { sendTransportText("\x03"); } catch { /* The transport may already be closed. */ }
      settleAgentCommand(new Error(tr("SSH 工作台执行等待 Shell 提示符超时")));
    }, remainingMs);
    agentExecution = { requestId, capture: new AgentTerminalExecutionCapture(), resolve, reject, timer };
    try {
      setTerminalInputEnabled(false);
      commandTracker.replace(command);
      currentCommandInput.value = command;
      suggestionSuppressed.value = true;
      suggestionIndex.value = -1;
      sendTransportText(`\x01\x0b${command}\r`);
      commandTracker.reset();
      acceptingCommandInput.value = false;
      currentCommandInput.value = "";
      terminal?.focus();
      emit("focused");
      emit("commandSubmitted", { command, cwd: currentDirectory });
    } catch (error) {
      settleAgentCommand(error instanceof Error ? error : new Error(tr("SSH 工作台执行失败")));
    }
  });
}

function cancelAgentCommand(requestId: string, reason: string): boolean {
  if (!agentExecution || agentExecution.requestId !== requestId) return false;
  try { sendTransportText("\x03"); } catch { /* The transport may already be closed. */ }
  settleAgentCommand(new Error(reason || tr("SSH 工作台执行已取消")));
  return true;
}

function acceptSuggestion(index = suggestionIndex.value) {
  const suggestion = commandSuggestions.value[index];
  if (suggestion && !replaceCurrentCommand(suggestion.command)) {
    ElMessage.warning(tr("当前终端无法填入历史命令，请确认连接正常并停留在 Shell 提示符"));
  }
}

function removeSuggestion(entry: SshCommandHistoryEntry) {
  suggestionIndex.value = -1;
  emit("historyRemove", entry);
}

function handleTerminalKeyEvent(event: KeyboardEvent): boolean {
  if (shouldReconnectFromTerminalKey(event, props.status)) {
    event.preventDefault();
    event.stopPropagation();
    emit("focused");
    emit("reconnectRequested");
    return false;
  }
  if (event.type !== "keydown" || !commandSuggestions.value.length) return true;
  if (event.key === "ArrowDown") {
    suggestionIndex.value = moveSshSuggestionSelection(suggestionIndex.value, commandSuggestions.value.length, 1);
  } else if (event.key === "ArrowUp") {
    suggestionIndex.value = moveSshSuggestionSelection(suggestionIndex.value, commandSuggestions.value.length, -1);
  } else if (event.key === "Enter" && suggestionIndex.value >= 0) {
    acceptSuggestion();
  } else if (event.key === "Escape") {
    suggestionSuppressed.value = true;
  } else {
    return true;
  }
  event.preventDefault();
  event.stopPropagation();
  return false;
}

function clipboardFailureMessage(error?: unknown): string {
  if (isDesktopApp()) return tr("无法访问系统剪贴板完成复制");
  if (!window.isSecureContext) return tr("当前页面不是安全上下文，无法复制；请使用 HTTPS、localhost 或 Ctrl/Cmd+C");
  if (!navigator.clipboard) return tr("当前浏览器不支持剪贴板复制；请使用 Ctrl/Cmd+C");
  const denied = error instanceof DOMException && error.name === "NotAllowedError";
  return denied
    ? tr("剪贴板权限被拒绝，无法复制；请允许访问或使用 Ctrl/Cmd+C")
    : tr("无法访问系统剪贴板完成复制；请使用 Ctrl/Cmd+C");
}

async function copyCurrentSelection() {
  const activeTerminal = terminal;
  if (!activeTerminal?.hasSelection()) return;
  const selection = activeTerminal.getSelection();
  if (!selection || selection === lastCopiedSelection) return;
  try {
    if (isDesktopApp()) await writeDesktopClipboardText(selection);
    else await copyTextToClipboard(selection);
    if (terminal?.getSelection() === selection) lastCopiedSelection = selection;
  } catch (error) {
    ElMessage.warning(clipboardFailureMessage(error));
  }
}

function scheduleSelectionCopy() {
  window.clearTimeout(selectionCopyTimer);
  if (!terminal?.hasSelection()) {
    lastCopiedSelection = "";
    return;
  }
  selectionCopyTimer = window.setTimeout(() => {
    selectionCopyQueue = selectionCopyQueue.then(copyCurrentSelection, copyCurrentSelection);
  }, 80);
}

async function pasteClipboardOnContextMenu(event: MouseEvent) {
  if (!isDesktopApp()) return;
  event.preventDefault();
  event.stopPropagation();
  if (!terminal || !transportConnected() || zmodemSession) {
    ElMessage.warning(tr("SSH 终端当前不可粘贴"));
    return;
  }
  try {
    const value = await readDesktopClipboardText();
    if (!value) return;
    terminal.focus();
    terminal.paste(value);
  } catch {
    ElMessage.warning(tr("无法读取系统剪贴板完成粘贴"));
  }
}

function sanitizeDownloadName(name: string): string {
  const fileName = name.replaceAll("\\", "/").split("/").pop()?.replaceAll("\0", "").trim();
  return fileName || "zmodem-download.bin";
}

function saveToDisk(payloads: Uint8Array[], name: string) {
  const blob = new Blob(payloads as BlobPart[], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.style.display = "none";
  link.href = url;
  link.download = sanitizeDownloadName(name);
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function receiveOffer(offer: Zmodem.Offer) {
  const details = offer.get_details();
  const totalFiles = Math.max(transferState.value?.filesTotal ?? 1, details.files_remaining ?? 1);
  updateTransfer({
    phase: "transferring",
    fileName: sanitizeDownloadName(details.name),
    bytesTransferred: offer.get_offset(),
    totalBytes: details.size ?? 0,
    filesComplete: receivedFiles,
    filesTotal: totalFiles,
    message: tr("正在接收远程文件"),
  });
  offer.on("input", () => updateTransfer({ bytesTransferred: offer.get_offset() }));
  try {
    const payloads = await offer.accept();
    if (transferCancelled) return;
    saveToDisk(payloads, details.name);
    receivedFiles += 1;
    updateTransfer({
      bytesTransferred: details.size ?? offer.get_offset(),
      filesComplete: receivedFiles,
      message: tr("文件接收完成，等待远程会话结束"),
    });
  } catch (error) {
    failTransfer(error);
  }
}

function startReceiveSession(session: Zmodem.ReceiveSession) {
  session.on("offer", (offer) => void receiveOffer(offer));
  try {
    session.start();
  } catch (error) {
    failTransfer(error);
  }
}

function chooseUploadFiles() {
  if (zmodemSession?.type !== "send" || !fileInput.value) return;
  fileInput.value.value = "";
  fileInput.value.click();
}

async function waitForUploadCapacity() {
  while (transportConnected() && (props.localExecution ? desktopPendingBytes : socket!.bufferedAmount) > MAX_BUFFERED_UPLOAD_BYTES) {
    if (transferCancelled) throw new Error(tr("文件上传已取消"));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  if (!transportConnected()) throw new Error(tr("SSH 终端连接已断开"));
}

async function sendFiles(session: Zmodem.SendSession, files: File[]) {
  const remainingBytes = new Array<number>(files.length);
  let bytes = 0;
  for (let index = files.length - 1; index >= 0; index -= 1) {
    bytes += files[index].size;
    remainingBytes[index] = bytes;
  }

  for (let index = 0; index < files.length; index += 1) {
    if (transferCancelled) throw new Error(tr("文件上传已取消"));
    const file = files[index];
    updateTransfer({
      phase: "transferring",
      fileName: file.name,
      bytesTransferred: 0,
      totalBytes: file.size,
      filesComplete: index,
      filesTotal: files.length,
      message: tr("正在等待远程主机接收"),
    });
    const transfer = await session.send_offer({
      name: file.name,
      size: file.size,
      mtime: new Date(file.lastModified),
      files_remaining: files.length - index,
      bytes_remaining: remainingBytes[index],
    });
    if (!transfer) {
      updateTransfer({ filesComplete: index + 1, message: tr("远程主机已跳过该文件") });
      continue;
    }

    let offset = transfer.get_offset();
    if (offset > file.size) throw new Error(tr("远程续传位置超出文件大小：{0}", [file.name]));
    updateTransfer({ bytesTransferred: offset, message: tr("正在上传到远程主机") });
    if (offset === file.size) {
      await transfer.end();
    } else {
      while (offset < file.size) {
        await waitForUploadCapacity();
        if (transferCancelled) throw new Error(tr("文件上传已取消"));
        const end = Math.min(file.size, offset + UPLOAD_CHUNK_SIZE);
        const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        if (end === file.size) await transfer.end(chunk);
        else transfer.send(chunk);
        offset = end;
        updateTransfer({ bytesTransferred: offset });
      }
    }
    updateTransfer({ filesComplete: index + 1, message: tr("文件上传完成") });
  }
}

async function handleFileSelection(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!files.length) {
    cancelTransfer();
    return;
  }
  const session = zmodemSession;
  if (!session || session.type !== "send") return;
  transferCancelled = false;
  try {
    await sendFiles(session, files);
    if (!transferCancelled) await session.close();
  } catch (error) {
    if (!transferCancelled) failTransfer(error);
  }
}

function handleFileSelectionCancel() {
  if (zmodemSession?.type === "send" && transferState.value?.phase === "waiting") cancelTransfer();
}

function handleZmodemDetection(detection: Zmodem.Detection) {
  window.clearTimeout(transferNoticeTimer);
  try {
    const session = detection.confirm();
    zmodemSession = session;
    receivedFiles = 0;
    transferCancelled = false;
    pendingTransferEnd = null;
    setTerminalInputEnabled(false);
    session.on("session_end", handleZmodemSessionEnd);
    if (session.type === "send") {
      transferState.value = {
        direction: "upload",
        phase: "waiting",
        fileName: tr("等待选择文件"),
        bytesTransferred: 0,
        totalBytes: 0,
        filesComplete: 0,
        filesTotal: 0,
        message: tr("远程 rz 已就绪，请从本机选择文件"),
      };
      nextTick(chooseUploadFiles);
    } else {
      transferState.value = {
        direction: "download",
        phase: "waiting",
        fileName: tr("等待远程文件"),
        bytesTransferred: 0,
        totalBytes: 0,
        filesComplete: 0,
        filesTotal: 1,
        message: tr("已识别远程 sz，正在建立接收会话"),
      };
      startReceiveSession(session);
    }
  } catch (error) {
    try {
      if (detection.is_valid()) detection.deny();
    } catch {
      // Detection may already have been consumed by the peer.
    }
    failTransfer(error);
  }
}

function initializeZmodem() {
  zmodemSentry = new Zmodem.Sentry({
    to_terminal: writeTerminalOutput,
    sender: sendBinary,
    on_detect: handleZmodemDetection,
    on_retract: () => {
      if (!zmodemSession) setTerminalInputEnabled(true);
    },
  });
}

function handleControlMessage(data: string) {
  try {
    const message = JSON.parse(data) as { type: string; message?: string; reason?: string };
    if (message.type === "ready") {
      emit("status", "connected");
      fit();
    } else if (message.type === "error") {
      terminal?.writeln(`\r\n\x1b[31m[Viron] ${message.message ?? tr("终端通信错误")}\x1b[0m`);
    } else if (message.type === "closed") {
      emit("status", "closed");
      emit("closed", message.reason ?? tr("SSH 会话已关闭"));
    }
  } catch {
    terminal?.writeln(tr("\r\n\u001b[31m[Viron] 收到无法识别的终端控制消息\u001b[0m"));
  }
}

async function handleSocketMessage(event: MessageEvent) {
  if (typeof event.data === "string") {
    handleControlMessage(event.data);
    return;
  }
  try {
    const data = event.data instanceof ArrayBuffer ? event.data : await (event.data as Blob).arrayBuffer();
    consumeTransportOutput(data);
  } catch (error) {
    if (zmodemSession) failTransfer(error);
    else terminal?.writeln(tr("\r\n\u001b[31m[Viron] 无法解析 SSH 终端数据：{0}\u001b[0m", [errorMessage(error)]));
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function consumeTransportOutput(data: Uint8Array | ArrayBuffer) {
  zmodemSentry?.consume(data instanceof Uint8Array ? data : new Uint8Array(data));
}

function handleDesktopEvent(event: import("../desktop").DesktopSshSessionEvent) {
  if (event.sessionId !== props.sessionId) return;
  if (event.type === "output") {
    const data = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
    if (desktopAttaching) desktopEventBacklog.push(data);
    else {
      try {
        consumeTransportOutput(data);
      } catch (error) {
        if (zmodemSession) failTransfer(error);
        else terminal?.writeln(tr("\r\n\u001b[31m[Viron] 无法解析 SSH 终端数据：{0}\u001b[0m", [errorMessage(error)]));
      }
    }
  } else if (event.type === "ready") {
    desktopAttached = true;
    emit("status", "connected");
    fit();
  } else if (event.type === "error") {
    terminal?.writeln(`\r\n\x1b[31m[Viron] ${event.message}\x1b[0m`);
  } else {
    desktopAttached = false;
    if (zmodemSession) {
      pendingTransferEnd = { phase: "error", message: tr("SSH 连接断开，文件传输未完成") };
      handleZmodemSessionEnd();
    }
    emit("status", "closed");
    emit("closed", event.reason);
  }
}

function paintTerminalChrome() {
  const root = terminalElement.value;
  if (!root) return;
  const viewport = root.querySelector(".xterm-viewport");
  if (viewport instanceof HTMLElement) {
    viewport.style.backgroundColor = "transparent";
    viewport.style.overflow = "hidden";
  }
  const scrollable = root.querySelector(".xterm-scrollable-element");
  if (scrollable instanceof HTMLElement) scrollable.style.backgroundColor = "transparent";
}

function fit() {
  if (!terminal || !fitAddon || !terminalElement.value) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    try {
      fitAddon?.fit();
      paintTerminalChrome();
      if (transportConnected()) {
        const cols = terminal?.cols ?? 120;
        const rows = terminal?.rows ?? 32;
        if (props.localExecution) void resizeDesktopSshSession(props.sessionId, cols, rows).catch(handleTransportError);
        else socket!.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    } catch {
      // The pane may be transitioning between split layouts.
    }
  }, 30);
}

function getCurrentDirectory(): string {
  return currentDirectory;
}

async function connect(ticket: string) {
  if (!terminal) return;
  const generation = ++connectionGeneration;
  commandTracker.reset();
  outputDecoder = new TextDecoder();
  outputTail = "";
  currentDirectory = UNKNOWN_REMOTE_CWD;
  acceptingCommandInput.value = false;
  currentCommandInput.value = "";
  suggestionSuppressed.value = false;
  suggestionIndex.value = -1;
  intentionalClose = true;
  socket?.close();
  intentionalClose = false;
  if (zmodemSession) {
    pendingTransferEnd = { phase: "error", message: tr("终端正在重新连接，文件传输已中断") };
    handleZmodemSessionEnd();
  }
  initializeZmodem();
  emit("status", "connecting");
  if (props.localExecution) {
    desktopAttached = false;
    desktopAttaching = true;
    desktopEventBacklog = [];
    try {
      await detachDesktopSshSession(props.sessionId).catch(() => undefined);
      const response = await attachDesktopSshSession(props.sessionId, ticket);
      if (generation !== connectionGeneration) return;
      const bufferedOutput = decodeBase64(response.output);
      if (bufferedOutput.byteLength) consumeTransportOutput(bufferedOutput);
      desktopAttaching = false;
      for (const data of desktopEventBacklog) consumeTransportOutput(data);
      desktopEventBacklog = [];
      desktopAttached = true;
      emit("status", "connected");
      fit();
    } catch (error) {
      if (generation !== connectionGeneration) return;
      desktopAttaching = false;
      desktopEventBacklog = [];
      handleTransportError(error);
    }
    return;
  }
  const nextSocket = new ServiceSocket("/ws/ssh", { ticket });
  nextSocket.binaryType = "arraybuffer";
  socket = nextSocket;
  nextSocket.addEventListener("open", () => fit());
  nextSocket.addEventListener("message", (event) => void handleSocketMessage(event));
  nextSocket.addEventListener("close", (event) => {
    if (socket !== nextSocket || intentionalClose) return;
    if (zmodemSession) {
      pendingTransferEnd = { phase: "error", message: tr("SSH 连接断开，文件传输未完成") };
      handleZmodemSessionEnd();
    }
    if (event.code !== 1000) {
      terminal?.writeln(tr("\r\n\u001b[33m[Viron] 终端连接已断开：{0}\u001b[0m", [event.reason || event.code]));
      emit("status", "disconnected");
    }
  });
  nextSocket.addEventListener("error", () => {
    if (socket === nextSocket) emit("status", "disconnected");
  });
}

onMounted(async () => {
  terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: props.fontSize ?? 13,
    lineHeight: 1.25,
    scrollback: 10_000,
    theme: terminalTheme(),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalElement.value!);
  paintTerminalChrome();
  terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent);
  selectionChangeDisposable = terminal.onSelectionChange(scheduleSelectionCopy);
  osc7Disposable = terminal.parser.registerOscHandler(7, (value) => {
    const cwd = parseOsc7Cwd(value);
    if (cwd) {
      currentDirectory = cwd;
      acceptingCommandInput.value = true;
    }
    return true;
  });
  terminal.onData((data) => {
    if (transportConnected() && !zmodemSession) {
      emit("focused");
      trackTerminalInput(data);
      sendTransportText(data);
    }
  });
  terminal.onBinary((data) => {
    if (transportConnected() && !zmodemSession) sendBinary(Uint8Array.from(data, (value) => value.charCodeAt(0)));
  });
  if (props.localExecution) unsubscribeDesktopEvents = onDesktopSshSessionEvent(handleDesktopEvent);
  resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(terminalElement.value!);
  await nextTick();
  fit();
  void connect(props.ticket);
});

onActivated(() => {
  nextTick(() => {
    fit();
    terminal?.focus();
  });
});

watch(() => props.ticket, (ticket, previous) => {
  if (ticket && ticket !== previous) void connect(ticket);
});

watch(() => props.fontSize, (fontSize) => {
  if (!terminal || !fontSize) return;
  terminal.options.fontSize = fontSize;
  fit();
});

watch(theme, () => {
  if (!terminal) return;
  terminal.options.theme = terminalTheme();
  paintTerminalChrome();
});

watch(commandSuggestions, (suggestions) => {
  if (!suggestions.length || suggestionIndex.value >= suggestions.length) suggestionIndex.value = -1;
});

onBeforeUnmount(() => {
  connectionGeneration += 1;
  intentionalClose = true;
  window.clearTimeout(resizeTimer);
  window.clearTimeout(transferNoticeTimer);
  window.clearTimeout(selectionCopyTimer);
  resizeObserver?.disconnect();
  osc7Disposable?.dispose();
  selectionChangeDisposable?.dispose();
  unsubscribeDesktopEvents?.();
  if (desktopAttached || desktopAttaching) void detachDesktopSshSession(props.sessionId).catch(() => undefined);
  desktopAttached = false;
  socket?.close();
  terminal?.dispose();
  settleAgentCommand(new Error(tr("当前 SSH 工作台已关闭")));
});

defineExpose({ fit, focus: () => terminal?.focus(), getCurrentDirectory, insertCommand, replaceCurrentCommand, replaceCurrentScript, executeAgentCommand, cancelAgentCommand });
</script>

<template>
  <div class="ssh-terminal-shell" :data-session-id="sessionId" @pointerdown="emit('focused')">
    <div ref="terminalElement" class="ssh-terminal-pane" @contextmenu="pasteClipboardOnContextMenu"></div>
    <div v-if="commandSuggestions.length" class="ssh-command-suggestions" :style="suggestionStyle" role="listbox" :aria-label="$t('历史命令输入建议')">
      <header><span>{{ $t('历史命令') }}</span><small>{{ $t('↑↓ 选择 · Enter 填入') }}</small></header>
      <div
        v-for="(suggestion, index) in commandSuggestions"
        :key="suggestion.id"
        class="ssh-command-suggestion"
        :class="{ 'is-active': suggestionIndex === index }"
      >
        <button
          type="button"
          class="ssh-command-suggestion__main"
          role="option"
          :aria-selected="suggestionIndex === index"
          :title="$t('填入命令：{0}', [suggestion.command])"
          @mousedown.prevent="acceptSuggestion(index)"
        >
          <code>{{ suggestion.command }}</code>
          <span>{{ suggestion.cwd }}</span>
        </button>
        <button
          type="button"
          class="ssh-command-suggestion__remove"
          :aria-label="$t('删除历史命令：{0}', [suggestion.command])"
          :title="$t('删除这条历史命令')"
          @mousedown.prevent.stop="removeSuggestion(suggestion)"
        ><Trash2 :size="13" /></button>
      </div>
    </div>
    <input
      ref="fileInput"
      class="zmodem-file-input"
      type="file"
      multiple
      tabindex="-1"
      aria-hidden="true"
      @change="handleFileSelection"
      @cancel="handleFileSelectionCancel"
    />
    <aside v-if="transferState" class="zmodem-transfer" :class="[`is-${transferState.phase}`, `is-${transferState.direction}`]" role="status" aria-live="polite">
      <span class="zmodem-transfer__icon">
        <Upload v-if="transferState.direction === 'upload'" :size="18" />
        <Download v-else :size="18" />
      </span>
      <div class="zmodem-transfer__body">
        <div class="zmodem-transfer__heading">
          <strong>{{ transferTitle(transferState) }}</strong>
          <span v-if="transferState.filesTotal > 1">{{ Math.min(transferState.filesComplete + 1, transferState.filesTotal) }}/{{ transferState.filesTotal }}</span>
        </div>
        <p :title="transferState.fileName">{{ transferState.fileName }}</p>
        <div v-if="transferState.phase === 'transferring'" class="zmodem-transfer__progress">
          <i :style="{ width: `${transferPercent(transferState)}%` }"></i>
        </div>
        <small>
          <template v-if="transferState.phase === 'transferring'">
            {{ transferPercent(transferState) }}% · {{ formatBytes(transferState.bytesTransferred) }} / {{ formatBytes(transferState.totalBytes) }}
          </template>
          <template v-else>{{ transferState.message }}</template>
        </small>
      </div>
      <div class="zmodem-transfer__actions">
        <button v-if="transferState.direction === 'upload' && transferState.phase === 'waiting'" type="button" @click="chooseUploadFiles">{{ $t('选择文件') }}</button>
        <button v-if="transferState.phase === 'waiting' || transferState.phase === 'transferring'" type="button" class="is-muted" @click="cancelTransfer">{{ $t('取消') }}</button>
        <button v-else type="button" class="is-icon" :aria-label="$t('关闭文件传输提示')" :title="$t('关闭')" @click="clearTransferNotice"><X :size="15" /></button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.ssh-terminal-pane :deep(.xterm),
.ssh-terminal-pane :deep(.xterm-viewport),
.ssh-terminal-pane :deep(.xterm-screen),
.ssh-terminal-pane :deep(.xterm-scrollable-element) { background-color: transparent !important; }
.ssh-terminal-pane :deep(.xterm-viewport) { overflow: hidden !important; }
.ssh-terminal-pane :deep(.horizontal.scrollbar) { display: none !important; }
</style>
