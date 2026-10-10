import type { IBuffer, IMarker, Terminal } from "@xterm/xterm";
import { isLikelyShellPrompt, type CommandSubmission } from "./ssh-command-history";

function readLogicalLine(buffer: IBuffer, row: number) {
  let start = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
  let end = start;
  let text = "";
  while (end < buffer.length) {
    const line = buffer.getLine(end);
    if (!line) break;
    const wrapped = Boolean(buffer.getLine(end + 1)?.isWrapped);
    let endColumn = line.length;
    // A wide character wrapping to the next row can leave an unused cell.
    // Remove only empty padding cells, retaining spaces actually entered.
    while (wrapped && endColumn > 0) {
      const cell = line.getCell(endColumn - 1);
      if (cell?.getChars() !== "" || cell.getWidth() !== 1) break;
      endColumn -= 1;
    }
    text += line.translateToString(!wrapped, 0, endColumn);
    if (!wrapped) break;
    end += 1;
  }
  return { start, end, text };
}

// Readline completion and history recall change the echoed line without sending
// that text through onData. Keep a marker until the remote shell submits it so
// delayed echo and wrapped commands are read from xterm's parsed buffer.
export class SshTerminalRenderedCommandTracker {
  private prompt = "";
  private pending: { marker: IMarker; prompt: string; cwd: string } | null = null;

  constructor(private readonly terminal: Pick<Terminal, "buffer" | "registerMarker">) {}

  reset(): void {
    this.pending?.marker.dispose();
    this.pending = null;
    this.prompt = "";
  }

  submit(cwd: string): boolean {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== "normal" || !this.prompt || this.pending) return false;
    const row = buffer.baseY + buffer.cursorY;
    const line = readLogicalLine(buffer, row);
    if (!line.text.startsWith(this.prompt.trimEnd())) return false;
    const marker = this.terminal.registerMarker(line.start - row);
    if (!marker) return false;
    this.pending = { marker, prompt: this.prompt, cwd };
    return true;
  }

  observe(): { prompt?: string; submission?: CommandSubmission } {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== "normal") {
      this.reset();
      return {};
    }
    const row = buffer.baseY + buffer.cursorY;
    let submission: CommandSubmission | undefined;
    const pending = this.pending;
    if (pending) {
      if (pending.marker.isDisposed) this.pending = null;
      else {
        const line = readLogicalLine(buffer, pending.marker.line);
        if (row > line.end) {
          if (line.text.startsWith(pending.prompt)) {
            const command = line.text.slice(pending.prompt.length);
            if (command.trim()) submission = { command, cwd: pending.cwd };
          }
          pending.marker.dispose();
          this.pending = null;
        }
      }
    }
    const line = readLogicalLine(buffer, row);
    if (!isLikelyShellPrompt(line.text)) return { submission };
    // Preserve the prompt's trailing space; a further leading space in the
    // command must still reach the history privacy filter.
    const cursorLine = buffer.getLine(row);
    this.prompt = line.text;
    if (cursorLine) {
      const beforeCursor = cursorLine.translateToString(false, 0, buffer.cursorX);
      const lastLine = cursorLine.translateToString(true);
      this.prompt = this.prompt.slice(0, this.prompt.length - lastLine.length) + beforeCursor;
    }
    return { prompt: this.prompt, submission };
  }
}
