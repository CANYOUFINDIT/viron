import { translate as tr } from "./i18n";
import { createClientId } from "./client-id";

export const SSH_COMMAND_HISTORY_LIMIT = 50;
export const UNKNOWN_REMOTE_CWD = tr("路径未知");

export interface SshCommandHistoryEntry {
  id: string;
  command: string;
  cwd: string;
  createdAt: string;
}

export interface SshCommandFavoriteEntry extends SshCommandHistoryEntry {
  connectionId: string;
  updatedAt: string;
}

export interface CommandSubmission {
  command: string;
  cwd: string;
}

export interface TerminalCommandSnapshot {
  value: string;
  cursor: number;
  reliable: boolean;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface AppendCommandOptions {
  command: string;
  cwd?: string;
  id?: string;
  createdAt?: string;
}

function isHistoryEntry(value: unknown): value is SshCommandHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string"
    && typeof entry.command === "string"
    && typeof entry.cwd === "string"
    && typeof entry.createdAt === "string";
}

export function sshCommandHistoryKey(userId: string, connectionId: string): string {
  return `envman:ssh-command-history:v1:${userId}:${connectionId}`;
}

export function sshHistorySuggestionsPreferenceKey(userId: string): string {
  return `envman:ssh-history-suggestions:v1:${userId}`;
}

export function readSshHistorySuggestionsEnabled(storage: StorageLike, userId: string): boolean {
  try {
    return storage.getItem(sshHistorySuggestionsPreferenceKey(userId)) !== "off";
  } catch {
    return true;
  }
}

export function writeSshHistorySuggestionsEnabled(storage: StorageLike, userId: string, enabled: boolean): void {
  try {
    storage.setItem(sshHistorySuggestionsPreferenceKey(userId), enabled ? "on" : "off");
  } catch {
    // Local preferences are best effort; the current in-memory setting still applies.
  }
}

export function readSshCommandHistory(storage: StorageLike, userId: string, connectionId: string): SshCommandHistoryEntry[] {
  try {
    const parsed = JSON.parse(storage.getItem(sshCommandHistoryKey(userId, connectionId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryEntry).slice(0, SSH_COMMAND_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeSshCommandHistory(storage: StorageLike, userId: string, connectionId: string, entries: SshCommandHistoryEntry[]): boolean {
  try {
    storage.setItem(sshCommandHistoryKey(userId, connectionId), JSON.stringify(entries.slice(0, SSH_COMMAND_HISTORY_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

export function isSensitiveSshCommand(command: string): boolean {
  if (/^\s/.test(command)) return true;
  return [
    /\b(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)\b\s*(?:=|:)\s*\S+/i,
    /--(?:password|passwd|token|secret|api[_-]?key)(?:=|\s+)\S+/i,
    /\b(?:mysql|mariadb)\b[^\r\n]*\s-p\S+/i,
    /\b(?:export|set)\s+[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=/i,
  ].some((pattern) => pattern.test(command));
}

export function appendSshCommandHistory(
  storage: StorageLike,
  userId: string,
  connectionId: string,
  options: AppendCommandOptions,
): SshCommandHistoryEntry[] {
  const command = options.command.trim();
  if (!command || isSensitiveSshCommand(options.command)) return readSshCommandHistory(storage, userId, connectionId);
  const entry: SshCommandHistoryEntry = {
    id: options.id ?? createClientId(),
    command,
    cwd: options.cwd?.trim() || UNKNOWN_REMOTE_CWD,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  const current = readSshCommandHistory(storage, userId, connectionId);
  if (current[0]?.command === command) return current;
  const entries = [entry, ...current].slice(0, SSH_COMMAND_HISTORY_LIMIT);
  return writeSshCommandHistory(storage, userId, connectionId, entries) ? entries : current;
}

export function findSshCommandSuggestions(
  entries: SshCommandHistoryEntry[],
  input: string,
  limit = 8,
): SshCommandHistoryEntry[] {
  const query = input.trimStart().toLocaleLowerCase();
  if (!query || limit <= 0) return [];
  const prefix: SshCommandHistoryEntry[] = [];
  const contains: SshCommandHistoryEntry[] = [];
  const commands = new Set<string>();
  for (const entry of entries) {
    if (commands.has(entry.command)) continue;
    const command = entry.command.toLocaleLowerCase();
    if (!command.includes(query)) continue;
    commands.add(entry.command);
    (command.startsWith(query) ? prefix : contains).push(entry);
  }
  return [...prefix, ...contains].slice(0, limit);
}

export function removeSshCommandHistoryEntry(
  storage: StorageLike,
  userId: string,
  connectionId: string,
  entryId: string,
): SshCommandHistoryEntry[] {
  const current = readSshCommandHistory(storage, userId, connectionId);
  const entries = current.filter((entry) => entry.id !== entryId);
  return writeSshCommandHistory(storage, userId, connectionId, entries) ? entries : current;
}

export function removeSshCommandHistoryCommand(
  storage: StorageLike,
  userId: string,
  connectionId: string,
  command: string,
): SshCommandHistoryEntry[] {
  const current = readSshCommandHistory(storage, userId, connectionId);
  const entries = current.filter((entry) => entry.command !== command);
  return writeSshCommandHistory(storage, userId, connectionId, entries) ? entries : current;
}

export function moveSshSuggestionSelection(
  currentIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= itemCount) return direction === 1 ? 0 : itemCount - 1;
  return (currentIndex + direction + itemCount) % itemCount;
}

export function clearSshCommandHistory(storage: StorageLike, userId: string, connectionId: string): void {
  storage.removeItem(sshCommandHistoryKey(userId, connectionId));
}

function insertText(buffer: string, cursor: number, text: string): { buffer: string; cursor: number } {
  return {
    buffer: `${buffer.slice(0, cursor)}${text}${buffer.slice(cursor)}`,
    cursor: cursor + text.length,
  };
}

export class TerminalCommandTracker {
  private buffer = "";
  private cursor = 0;
  private reliable = true;

  reset(): void {
    this.buffer = "";
    this.cursor = 0;
    this.reliable = true;
  }

  snapshot(): TerminalCommandSnapshot {
    return { value: this.buffer, cursor: this.cursor, reliable: this.reliable };
  }

  replace(command: string): void {
    if (!command || /[\r\n]/.test(command)) return;
    this.buffer = command;
    this.cursor = command.length;
    this.reliable = true;
  }

  insert(command: string): void {
    if (!command || /[\r\n]/.test(command)) return;
    const next = insertText(this.buffer, this.cursor, command);
    this.buffer = next.buffer;
    this.cursor = next.cursor;
  }

  consume(data: string, alternateBuffer = false): string[] {
    if (alternateBuffer) {
      this.reset();
      return [];
    }

    const submissions: string[] = [];
    let index = 0;
    let previousWasCarriageReturn = false;
    while (index < data.length) {
      const terminalResponse = data.slice(index).match(/^\x1b\[(?:\?|>)?[\d;]+[Rc]/)?.[0];
      if (terminalResponse) {
        index += terminalResponse.length;
        continue;
      }

      if (data.startsWith("\x1b[200~", index)) {
        const end = data.indexOf("\x1b[201~", index + 6);
        if (end < 0) {
          this.reliable = false;
          break;
        }
        const pasted = data.slice(index + 6, end);
        if (/[\r\n]/.test(pasted)) this.reliable = false;
        else this.insert(pasted);
        index = end + 6;
        continue;
      }

      const sequences: Array<[string, () => void]> = [
        ["\x1b[D", () => { this.cursor = Math.max(0, this.cursor - 1); }],
        ["\x1b[C", () => { this.cursor = Math.min(this.buffer.length, this.cursor + 1); }],
        ["\x1b[H", () => { this.cursor = 0; }],
        ["\x1bOH", () => { this.cursor = 0; }],
        ["\x1b[F", () => { this.cursor = this.buffer.length; }],
        ["\x1bOF", () => { this.cursor = this.buffer.length; }],
        ["\x1b[3~", () => {
          if (this.cursor < this.buffer.length) this.buffer = `${this.buffer.slice(0, this.cursor)}${this.buffer.slice(this.cursor + 1)}`;
        }],
      ];
      const sequence = sequences.find(([value]) => data.startsWith(value, index));
      if (sequence) {
        sequence[1]();
        index += sequence[0].length;
        previousWasCarriageReturn = false;
        continue;
      }

      const character = data[index];
      if (character === "\r" || character === "\n") {
        if (!(character === "\n" && previousWasCarriageReturn) && this.reliable && this.buffer.trim()) {
          submissions.push(this.buffer.trim());
        }
        previousWasCarriageReturn = character === "\r";
        this.reset();
        index += 1;
        continue;
      }
      previousWasCarriageReturn = false;

      if (character === "\x7f" || character === "\b") {
        if (this.cursor > 0) {
          this.buffer = `${this.buffer.slice(0, this.cursor - 1)}${this.buffer.slice(this.cursor)}`;
          this.cursor -= 1;
        }
      } else if (character === "\x01") {
        this.cursor = 0;
      } else if (character === "\x05") {
        this.cursor = this.buffer.length;
      } else if (character === "\x15") {
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
      } else if (character === "\x0b") {
        this.buffer = this.buffer.slice(0, this.cursor);
      } else if (character === "\x17") {
        const before = this.buffer.slice(0, this.cursor).replace(/\s*\S+\s*$/, "");
        this.buffer = `${before}${this.buffer.slice(this.cursor)}`;
        this.cursor = before.length;
      } else if (character === "\x03") {
        this.reset();
      } else if (character === "\x04") {
        if (this.cursor < this.buffer.length) this.buffer = `${this.buffer.slice(0, this.cursor)}${this.buffer.slice(this.cursor + 1)}`;
      } else if (character === "\t" || character === "\x12" || character === "\x1b") {
        this.reliable = false;
      } else if (character.charCodeAt(0) < 0x20) {
        this.reliable = false;
      } else {
        this.insert(character);
      }
      index += 1;
    }
    return submissions;
  }
}

export function parseOsc7Cwd(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "file:") return undefined;
    return decodeURIComponent(url.pathname) || "/";
  } catch {
    return candidate.startsWith("/") ? candidate : undefined;
  }
}

function normalizeTerminalLine(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n]/g, "")
    .trim();
}

export function detectCwdFromPrompt(value: string): string | undefined {
  const line = normalizeTerminalLine(value);
  const patterns = [
    /(?:^|\s)[^@\s]+@[^:\s]+:(~(?:\/[^\s#$%>]*)?|\/[^\s#$%>]*)\s*[#$%>]\s*$/,
    /(?:^|\s)[^@\s]+@[^:\s]+\s+(~(?:\/[^\s#$%>]*)?|\/[^\s#$%>]*)\s*[#$%>]\s*$/,
    /(?:^|\s)\[[^\]]+\s+(~(?:\/[^\]#$%>]*)?|\/[^\]#$%>]*)\]\s*[#$%>]\s*$/,
    /^(~(?:\/[^\s#$%>]*)?|\/[^\s#$%>]*)\s*[#$%>]\s*$/,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function isLikelyShellPrompt(value: string): boolean {
  if (detectCwdFromPrompt(value)) return true;
  const line = normalizeTerminalLine(value);
  return /(?:^|\s)[^@\s]+@[^\s]+\s*[#$%]\s*$/.test(line)
    || /^(?:ba|z|a|da)?sh(?:-[\d.]+)?\s*[#$%]\s*$/i.test(line);
}
