import { describe, expect, it } from "vitest";
import { shouldReconnectFromTerminalKey, type SshTerminalStatus } from "../src/client/ssh-terminal-reconnect.js";

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: "keydown",
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("SSH terminal reconnect shortcut", () => {
  it("reconnects with an unmodified Enter only after the terminal disconnects", () => {
    expect(shouldReconnectFromTerminalKey(keyEvent(), "disconnected")).toBe(true);
    for (const status of ["connecting", "connected", "closed"] satisfies SshTerminalStatus[]) {
      expect(shouldReconnectFromTerminalKey(keyEvent(), status)).toBe(false);
    }
  });

  it("does not consume other keys, modified Enter, composition, or keyup", () => {
    expect(shouldReconnectFromTerminalKey(keyEvent({ key: "a" }), "disconnected")).toBe(false);
    expect(shouldReconnectFromTerminalKey(keyEvent({ ctrlKey: true }), "disconnected")).toBe(false);
    expect(shouldReconnectFromTerminalKey(keyEvent({ shiftKey: true }), "disconnected")).toBe(false);
    expect(shouldReconnectFromTerminalKey(keyEvent({ isComposing: true }), "disconnected")).toBe(false);
    expect(shouldReconnectFromTerminalKey(keyEvent({ type: "keyup" }), "disconnected")).toBe(false);
  });
});
