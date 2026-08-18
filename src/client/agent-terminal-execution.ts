import { isLikelyShellPrompt } from "./ssh-command-history";

export interface AgentTerminalExecutionResult {
  rawOutput: string;
  durationMs: number;
  truncated: boolean;
}

const MAX_CAPTURE_CHARACTERS = 256 * 1024;

export class AgentTerminalExecutionCapture {
  private output = "";
  private sawLineBreak = false;
  private truncated = false;

  constructor(private readonly startedAt = Date.now()) {}

  append(value: string, now = Date.now()): AgentTerminalExecutionResult | null {
    if (!value) return null;
    this.sawLineBreak ||= /[\r\n]/.test(value);
    this.output += value;
    if (this.output.length > MAX_CAPTURE_CHARACTERS) {
      this.output = this.output.slice(-MAX_CAPTURE_CHARACTERS);
      this.truncated = true;
    }
    const lastLine = this.output.split(/[\r\n]/).at(-1) ?? "";
    if (!this.sawLineBreak || !isLikelyShellPrompt(lastLine)) return null;
    return {
      rawOutput: this.output,
      durationMs: Math.max(0, now - this.startedAt),
      truncated: this.truncated,
    };
  }
}
