import { describe, expect, it } from "vitest";
import {
  canPredictSshInput,
  SshEchoPredictor,
  sshTerminalDisplayWidth,
  type SshEchoPredictContext,
} from "../src/client/ssh-terminal-predict.js";

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

  it("does not write empty remote while predictions are still outstanding", () => {
    const predictor = new SshEchoPredictor();
    predictor.predict("a");
    expect(predictor.applyRemote("")).toEqual({ rollback: "", display: "" });
    expect(predictor.pending).toBe("a");
    predictor.reset();
    expect(predictor.applyRemote("hello")).toEqual({ rollback: "", display: "hello" });
  });
});
