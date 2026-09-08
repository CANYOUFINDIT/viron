export interface SshEchoPredictContext {
  acceptingCommandInput: boolean;
  alternateBuffer: boolean;
  reliableCommand: boolean;
  cursorAtEnd: boolean;
  cursorX: number;
  cols: number;
}

export interface SshEchoApplyResult {
  rollback: string;
  display: string;
}

export function sshTerminalDisplayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    width += isWideTerminalChar(code) ? 2 : 1;
  }
  return width;
}

export function canPredictSshInput(data: string, context: SshEchoPredictContext): boolean {
  if (
    !data
    || !context.acceptingCommandInput
    || context.alternateBuffer
    || !context.reliableCommand
    || !context.cursorAtEnd
    || !isEchoableSshInput(data)
  ) return false;
  if (context.cols > 0 && context.cursorX + sshTerminalDisplayWidth(data) >= context.cols) return false;
  return true;
}

export class SshEchoPredictor {
  private predicted = "";

  get pending(): string {
    return this.predicted;
  }

  pendingWidth(): number {
    return sshTerminalDisplayWidth(this.predicted);
  }

  reset(): void {
    this.predicted = "";
  }

  predict(data: string): string {
    this.predicted += data;
    return data;
  }

  applyRemote(remote: string): SshEchoApplyResult {
    if (!this.predicted) return { rollback: "", display: remote };
    if (!remote) return { rollback: "", display: "" };

    let index = 0;
    const limit = Math.min(this.predicted.length, remote.length);
    while (index < limit && this.predicted.charCodeAt(index) === remote.charCodeAt(index)) index += 1;

    if (index === 0) {
      const rollback = rollbackSequence(this.predicted);
      this.predicted = "";
      return { rollback, display: remote };
    }

    this.predicted = this.predicted.slice(index);
    const rest = remote.slice(index);
    if (!rest) return { rollback: "", display: "" };
    if (!this.predicted) return { rollback: "", display: rest };

    const rollback = rollbackSequence(this.predicted);
    this.predicted = "";
    return { rollback, display: rest };
  }
}

function isEchoableSshInput(data: string): boolean {
  for (const character of data) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isWideTerminalChar(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff);
}

function rollbackSequence(predicted: string): string {
  const width = sshTerminalDisplayWidth(predicted);
  if (width <= 0) return "";
  return `\x1b[${width}D\x1b[K`;
}
