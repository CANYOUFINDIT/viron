import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isLogPauseShortcut,
  isLogReconnectShortcut,
  shouldHandleLogPauseShortcut,
  shouldHandleLogReconnectShortcut,
} from "../src/client/log-shortcut.js";

const logPanel = readFileSync(new URL("../src/client/components/EnvironmentLogPanel.vue", import.meta.url), "utf8");

describe("log pause shortcut", () => {
  it("matches only a plain Control+C press", () => {
    expect(isLogPauseShortcut({ key: "c", control: true })).toBe(true);
    expect(isLogPauseShortcut({ key: "C", control: true })).toBe(true);
    expect(isLogPauseShortcut({ key: "c", meta: true })).toBe(false);
    expect(isLogPauseShortcut({ key: "c", control: true, shift: true })).toBe(false);
    expect(isLogPauseShortcut({ key: "c", control: true, alt: true })).toBe(false);
    expect(isLogPauseShortcut({ key: "c", control: true, meta: true })).toBe(false);
    expect(isLogPauseShortcut({ key: "v", control: true })).toBe(false);
  });

  it("ignores repeats and IME composition", () => {
    expect(isLogPauseShortcut({ key: "c", control: true, repeat: true })).toBe(false);
    expect(isLogPauseShortcut({ key: "c", control: true, composing: true })).toBe(false);
  });

  it("preserves copy and editing contexts", () => {
    const shortcut = { key: "c", control: true };
    expect(shouldHandleLogPauseShortcut(shortcut, { streamActive: true })).toBe(true);
    expect(shouldHandleLogPauseShortcut(shortcut, { streamActive: false })).toBe(false);
    expect(shouldHandleLogPauseShortcut(shortcut, { streamActive: true, dialogVisible: true })).toBe(false);
    expect(shouldHandleLogPauseShortcut(shortcut, { streamActive: true, editableTarget: true })).toBe(false);
    expect(shouldHandleLogPauseShortcut(shortcut, { streamActive: true, hasSelection: true })).toBe(false);
  });

  it("shows the shortcut directly in the stop button label", () => {
    expect(logPanel).toContain("{{ $t('ctrl+c/停止') }}");
  });

  it("matches a plain Enter press for reconnecting", () => {
    expect(isLogReconnectShortcut({ key: "Enter" })).toBe(true);
    expect(isLogReconnectShortcut({ key: "Enter", control: true })).toBe(false);
    expect(isLogReconnectShortcut({ key: "Enter", shift: true })).toBe(false);
    expect(isLogReconnectShortcut({ key: "Enter", repeat: true })).toBe(false);
    expect(isLogReconnectShortcut({ key: "Enter", composing: true })).toBe(false);
  });

  it("reconnects only from a safe stopped or error context", () => {
    const shortcut = { key: "Enter" };
    expect(shouldHandleLogReconnectShortcut(shortcut, { reconnectAvailable: true })).toBe(true);
    expect(shouldHandleLogReconnectShortcut(shortcut, { reconnectAvailable: false })).toBe(false);
    expect(shouldHandleLogReconnectShortcut(shortcut, { reconnectAvailable: true, dialogVisible: true })).toBe(false);
    expect(shouldHandleLogReconnectShortcut(shortcut, { reconnectAvailable: true, interactiveTarget: true })).toBe(false);
  });

  it("shows Enter directly in the reconnect button label", () => {
    expect(logPanel).toContain("{{ $t('Enter/重新连接') }}");
  });
});
