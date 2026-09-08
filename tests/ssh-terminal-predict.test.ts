import { describe, expect, it } from "vitest";
import {
  canPredictSshInput,
  SshEchoPredictor,
  sshTerminalDisplayWidth,
  type SshEchoPredictContext,
} from "../src/client/ssh-terminal-predict.js";

function playLocalEcho(typed: string[], remote: string[]): string[] {
  const predictor = new SshEchoPredictor();
  const writes: string[] = [];
  for (const data of typed) {
    predictor.predict(data);
    writes.push(data);
  }
  for (const chunk of remote) {
    const applied = predictor.applyRemote(chunk);
    if (applied.rollback) writes.push(applied.rollback);
    if (applied.display) writes.push(applied.display);
  }
  expect(predictor.pending).toBe("");
  return writes;
}

function visibleLine(prompt: string, writes: string[]): string {
  let line = prompt;
  let cursor = prompt.length;
  const write = (text: string) => {
    let index = 0;
    while (index < text.length) {
      if (text.startsWith("\x1b[", index)) {
        const end = text.slice(index + 2).search(/[A-Za-z]/);
        if (end < 0) break;
        const seq = text.slice(index, index + 2 + end + 1);
        const body = seq.slice(2, -1);
        const command = seq.at(-1);
        const count = Number(body || "1");
        if (command === "D") cursor = Math.max(0, cursor - (Number.isFinite(count) ? count : 1));
        else if (command === "K") {
          if (body === "2") line = "";
          else line = line.slice(0, cursor);
        }
        index += seq.length;
        continue;
      }
      const character = text[index];
      if (character === "\r") cursor = 0;
      else if (character === "\n") {
        line = "";
        cursor = 0;
      } else if (character === "\b") cursor = Math.max(0, cursor - 1);
      else {
        line = `${line.slice(0, cursor)}${character}${line.slice(cursor + 1)}`;
        cursor += 1;
      }
      index += 1;
    }
  };
  for (const chunk of writes) write(chunk);
  return line;
}

function context(overrides: Partial<SshEchoPredictContext> = {}): SshEchoPredictContext {
  return {
    acceptingCommandInput: true,
    alternateBuffer: false,
    reliableCommand: true,
    cursorAtEnd: true,
    cursorX: 12,
    cols: 120,
    ...overrides,
  };
}

describe("SSH local echo prediction", () => {
  it("predicts printable prompt input and consumes matching remote echo", () => {
    expect(canPredictSshInput("ls", context())).toBe(true);
    expect(canPredictSshInput("中", context())).toBe(true);
    expect(canPredictSshInput("a\r", context())).toBe(false);
    expect(canPredictSshInput("\t", context())).toBe(false);
    expect(canPredictSshInput("\x7f", context())).toBe(false);
    expect(canPredictSshInput("\x1b[A", context())).toBe(false);
    expect(canPredictSshInput("ls", context({ acceptingCommandInput: false }))).toBe(false);
    expect(canPredictSshInput("ls", context({ alternateBuffer: true }))).toBe(false);
    expect(canPredictSshInput("ls", context({ reliableCommand: false }))).toBe(false);
    expect(canPredictSshInput("ls", context({ cursorAtEnd: false }))).toBe(false);
    expect(canPredictSshInput("ls", context({ cursorX: 119, cols: 120 }))).toBe(false);
    expect(canPredictSshInput("中", context({ cursorX: 118, cols: 120 }))).toBe(false);

    const predictor = new SshEchoPredictor();
    expect(predictor.predict("ls")).toBe("ls");
    expect(predictor.applyRemote("l")).toEqual({ rollback: "", display: "" });
    expect(predictor.pending).toBe("s");
    expect(predictor.applyRemote("s")).toEqual({ rollback: "", display: "" });
    expect(predictor.pending).toBe("");
  });

  it("rolls back unmatched predictions and keeps later remote output", () => {
    const predictor = new SshEchoPredictor();
    predictor.predict("abc");
    expect(predictor.applyRemote("abX")).toEqual({ rollback: "\x1b[1D\x1b[K", display: "X" });
    expect(predictor.pending).toBe("");

    predictor.predict("ls");
    expect(predictor.applyRemote("^C\r\n")).toEqual({ rollback: "\x1b[2D\x1b[K", display: "^C\r\n" });
    expect(predictor.pending).toBe("");
  });

  it("uses two columns when rolling back CJK input", () => {
    expect(sshTerminalDisplayWidth("中文")).toBe(4);
    const predictor = new SshEchoPredictor();
    predictor.predict("中");
    expect(predictor.pendingWidth()).toBe(2);
    expect(predictor.applyRemote("nope")).toEqual({ rollback: "\x1b[2D\x1b[K", display: "nope" });
  });

  it("keeps a single copy of delayed bash echo, tab completion, and backspace", () => {
    expect(visibleLine("host$ ", playLocalEcho(["l", "s"], ["l", "s"]))).toBe("host$ ls");
    expect(visibleLine("host$ ", playLocalEcho(["ls"], ["ls"]))).toBe("host$ ls");
    expect(visibleLine("host$ ", playLocalEcho(["l"], ["l", "s"]))).toBe("host$ ls");
    expect(visibleLine("host$ ", playLocalEcho(["abc"], ["abc", "\b \b"])).trimEnd()).toBe("host$ ab");
    expect(visibleLine("host$ ", playLocalEcho(["l"], ["l", "\x1b[2K\rhost$ cd /tmp"]))).toBe("host$ cd /tmp");
    expect(visibleLine("host$ ", playLocalEcho(["l"], ["\x1b[2K\rhost$ cd /tmp"]))).toBe("host$ cd /tmp");
    expect(visibleLine("host$ ", playLocalEcho(["ec"], ["echo hello"]))).toBe("host$ echo hello");
    expect(visibleLine("host$ ", playLocalEcho(["l", "s"], ["l", "\x08ls"]))).toBe("host$ ls");
    expect(visibleLine("host$ ", playLocalEcho(["ls"], ["l\x08ls"]))).toBe("host$ ls");
    expect(visibleLine("host$ ", playLocalEcho(["ls"], ["ls", "\x08\x1b[K"])).trimEnd()).toBe("host$ l");
  });

  it("does not write empty remote while predictions are still outstanding", () => {
    const predictor = new SshEchoPredictor();
    predictor.predict("a");
    expect(predictor.applyRemote("")).toEqual({ rollback: "", display: "" });
    expect(predictor.pending).toBe("a");
    predictor.reset();
    expect(predictor.applyRemote("hello")).toEqual({ rollback: "", display: "hello" });
  });
});
