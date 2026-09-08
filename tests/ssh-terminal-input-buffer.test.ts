import { describe, expect, it } from "vitest";
import { SshTerminalInputBuffer } from "../src/client/ssh-terminal-input-buffer.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SSH terminal input coalescing", () => {
  it("merges text queued before the first flush into one write", async () => {
    const sent: string[] = [];
    const buffer = new SshTerminalInputBuffer({
      sendText: (data) => { sent.push(data); },
      sendBinary: () => undefined,
      onError: (error) => { throw error; },
    });
    buffer.enqueueText("h");
    buffer.enqueueText("i");
    expect(sent).toEqual([]);
    await flushMicrotasks();
    expect(sent).toEqual(["hi"]);
  });

  it("keeps text and binary order and only coalesces adjacent text", async () => {
    const sent: Array<string | number> = [];
    const buffer = new SshTerminalInputBuffer({
      sendText: (data) => { sent.push(data); },
      sendBinary: (data) => { sent.push(data[0]); },
      onError: (error) => { throw error; },
    });
    buffer.enqueueText("ab");
    buffer.enqueueBinary(Uint8Array.of(7));
    buffer.enqueueText("c");
    buffer.enqueueText("d");
    await flushMicrotasks();
    expect(sent).toEqual(["ab", 7, "cd"]);
  });

  it("batches keystrokes that arrive while a write is in flight", async () => {
    const sent: string[] = [];
    let resume!: () => void;
    const firstWrite = new Promise<void>((resolve) => { resume = resolve; });
    let calls = 0;
    const buffer = new SshTerminalInputBuffer({
      sendText: (data) => {
        sent.push(data);
        calls += 1;
        if (calls === 1) return firstWrite;
      },
      sendBinary: () => undefined,
      onError: (error) => { throw error; },
    });
    buffer.enqueueText("a");
    await flushMicrotasks();
    expect(sent).toEqual(["a"]);
    buffer.enqueueText("b");
    buffer.enqueueText("c");
    expect(buffer.bufferedBytes).toBeGreaterThan(0);
    resume();
    await flushMicrotasks();
    expect(sent).toEqual(["a", "bc"]);
  });

  it("drops pending input after reset and reports send failures once", async () => {
    const errors: string[] = [];
    const buffer = new SshTerminalInputBuffer({
      sendText: () => { throw new Error("offline"); },
      sendBinary: () => undefined,
      onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
    });
    buffer.enqueueText("stay");
    buffer.reset();
    buffer.enqueueText("go");
    await flushMicrotasks();
    expect(errors).toEqual(["offline"]);

    const ignored: string[] = [];
    const next = new SshTerminalInputBuffer({
      sendText: (data) => { ignored.push(data); },
      sendBinary: () => undefined,
      onError: (error) => { throw error; },
    });
    next.enqueueText("old");
    next.reset();
    await flushMicrotasks();
    expect(ignored).toEqual([]);
  });
});
