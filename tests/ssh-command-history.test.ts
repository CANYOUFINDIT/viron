import { describe, expect, it } from "vitest";
import {
  appendSshCommandHistory,
  clearSshCommandHistory,
  detectCwdFromPrompt,
  findSshCommandSuggestions,
  isLikelyShellPrompt,
  isSensitiveSshCommand,
  moveSshSuggestionSelection,
  parseOsc7Cwd,
  readSshHistorySuggestionsEnabled,
  readSshCommandHistory,
  removeSshCommandHistoryCommand,
  removeSshCommandHistoryEntry,
  SSH_COMMAND_HISTORY_LIMIT,
  sshHistorySuggestionsPreferenceKey,
  sshCommandHistoryKey,
  TerminalCommandTracker,
  writeSshHistorySuggestionsEnabled,
} from "../src/client/ssh-command-history.js";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("SSH command history storage", () => {
  it("isolates histories and keeps only the newest 50 commands", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 55; index += 1) {
      appendSshCommandHistory(storage, "user-a", "connection-a", {
        id: `entry-${index}`,
        command: `echo ${index}`,
        cwd: `/srv/${index}`,
        createdAt: new Date(2026, 6, 20, 0, 0, index).toISOString(),
      });
    }
    appendSshCommandHistory(storage, "user-a", "connection-b", { id: "other", command: "pwd" });
    appendSshCommandHistory(storage, "user-b", "connection-a", { id: "other-user", command: "whoami" });

    const entries = readSshCommandHistory(storage, "user-a", "connection-a");
    expect(entries).toHaveLength(SSH_COMMAND_HISTORY_LIMIT);
    expect(entries[0]).toMatchObject({ id: "entry-54", command: "echo 54", cwd: "/srv/54" });
    expect(entries.at(-1)?.id).toBe("entry-5");
    expect(readSshCommandHistory(storage, "user-a", "connection-b")).toHaveLength(1);
    expect(readSshCommandHistory(storage, "user-b", "connection-a")).toHaveLength(1);
    expect(sshCommandHistoryKey("user-a", "connection-a")).toContain(":v1:user-a:connection-a");
  });

  it("filters sensitive commands and supports single delete and clear", () => {
    const storage = new MemoryStorage();
    appendSshCommandHistory(storage, "user", "connection", { id: "safe", command: "ls -la", cwd: "/tmp" });
    appendSshCommandHistory(storage, "user", "connection", { id: "secret", command: "export API_TOKEN=secret-value" });
    appendSshCommandHistory(storage, "user", "connection", { id: "ignored", command: " mysql -uroot -psecret" });
    expect(readSshCommandHistory(storage, "user", "connection").map((entry) => entry.id)).toEqual(["safe"]);
    expect(isSensitiveSshCommand("curl --token abc https://example.com")).toBe(true);

    expect(removeSshCommandHistoryEntry(storage, "user", "connection", "safe")).toEqual([]);
    appendSshCommandHistory(storage, "user", "connection", { id: "again", command: "pwd" });
    clearSshCommandHistory(storage, "user", "connection");
    expect(readSshCommandHistory(storage, "user", "connection")).toEqual([]);
  });

  it("removes every copy of a command so it cannot return as an input suggestion", () => {
    const storage = new MemoryStorage();
    appendSshCommandHistory(storage, "user", "connection", { id: "old-typo", command: "gti status" });
    appendSshCommandHistory(storage, "user", "connection", { id: "other", command: "pwd" });
    appendSshCommandHistory(storage, "user", "connection", { id: "new-typo", command: "gti status" });

    expect(findSshCommandSuggestions(readSshCommandHistory(storage, "user", "connection"), "gti")).toHaveLength(1);
    const entries = removeSshCommandHistoryCommand(storage, "user", "connection", "gti status");
    expect(entries.map((entry) => entry.command)).toEqual(["pwd"]);
    expect(findSshCommandSuggestions(entries, "gti")).toEqual([]);
  });

  it("skips consecutive duplicates and ranks prefix suggestions before text matches", () => {
    const storage = new MemoryStorage();
    appendSshCommandHistory(storage, "user", "connection", { id: "first", command: "git status", cwd: "/repo" });
    appendSshCommandHistory(storage, "user", "connection", { id: "duplicate", command: "git status", cwd: "/other" });
    appendSshCommandHistory(storage, "user", "connection", { id: "contains", command: "sudo git fetch", cwd: "/repo" });
    appendSshCommandHistory(storage, "user", "connection", { id: "prefix", command: "git fetch", cwd: "/repo" });

    const entries = readSshCommandHistory(storage, "user", "connection");
    expect(entries.map((entry) => entry.id)).toEqual(["prefix", "contains", "first"]);
    expect(findSshCommandSuggestions(entries, "git").map((entry) => entry.command)).toEqual(["git fetch", "git status", "sudo git fetch"]);
    expect(findSshCommandSuggestions([...entries, { ...entries[0], id: "same-command" }], "fetch")).toHaveLength(2);
    expect(findSshCommandSuggestions(entries, "")).toEqual([]);
  });

  it("stores the input suggestion switch per user and defaults to enabled", () => {
    const storage = new MemoryStorage();
    expect(readSshHistorySuggestionsEnabled(storage, "user-a")).toBe(true);
    writeSshHistorySuggestionsEnabled(storage, "user-a", false);
    expect(readSshHistorySuggestionsEnabled(storage, "user-a")).toBe(false);
    expect(readSshHistorySuggestionsEnabled(storage, "user-b")).toBe(true);
    expect(sshHistorySuggestionsPreferenceKey("user-a")).toContain(":v1:user-a");
  });

  it("requires arrow-key selection before a suggestion can be accepted", () => {
    expect(moveSshSuggestionSelection(-1, 3, 1)).toBe(0);
    expect(moveSshSuggestionSelection(-1, 3, -1)).toBe(2);
    expect(moveSshSuggestionSelection(0, 3, -1)).toBe(2);
    expect(moveSshSuggestionSelection(2, 3, 1)).toBe(0);
    expect(moveSshSuggestionSelection(0, 0, 1)).toBe(-1);
  });
});

describe("terminal command tracking", () => {
  it("tracks normal line editing and programmatic history insertion", () => {
    const tracker = new TerminalCommandTracker();
    tracker.consume("echp");
    tracker.consume("\x7f");
    tracker.consume("o");
    expect(tracker.consume("\r")).toEqual(["echo"]);

    tracker.insert("pwd");
    expect(tracker.consume("\r")).toEqual(["pwd"]);

    tracker.consume("old command");
    tracker.replace("new command");
    expect(tracker.snapshot()).toEqual({ value: "new command", cursor: 11, reliable: true });
    expect(tracker.consume("\r")).toEqual(["new command"]);
  });

  it("does not record alternate-screen or unreliable completion input", () => {
    const tracker = new TerminalCommandTracker();
    tracker.consume("dd if=/dev/zero", true);
    expect(tracker.consume("\r", true)).toEqual([]);
    tracker.consume("cat /et");
    tracker.consume("\t");
    expect(tracker.consume("\r")).toEqual([]);
    tracker.consume("pwd");
    expect(tracker.consume("\r")).toEqual(["pwd"]);
  });

  it("ignores terminal protocol responses without invalidating typed input", () => {
    const tracker = new TerminalCommandTracker();
    tracker.consume("echo ready");
    tracker.consume("\x1b[34;29R");
    tracker.consume("\x1b[?1;2c");
    expect(tracker.snapshot()).toEqual({ value: "echo ready", cursor: 10, reliable: true });
    expect(tracker.consume("\r")).toEqual(["echo ready"]);
  });

  it("accepts single-line bracketed paste and rejects multiline paste", () => {
    const tracker = new TerminalCommandTracker();
    tracker.consume("\x1b[200~echo pasted\x1b[201~");
    expect(tracker.consume("\r")).toEqual(["echo pasted"]);
    tracker.consume("\x1b[200~echo one\necho two\x1b[201~");
    expect(tracker.consume("\r")).toEqual([]);
  });
});

describe("remote path detection", () => {
  it("reads OSC 7 file URLs and common shell prompts", () => {
    expect(parseOsc7Cwd("file://server/srv/app%20one")).toBe("/srv/app one");
    expect(parseOsc7Cwd("https://server/srv/app")).toBeUndefined();
    expect(detectCwdFromPrompt("\x1b[32mroot@server:/var/log# \x1b[0m")).toBe("/var/log");
    expect(detectCwdFromPrompt("user@server:~/project$ ")).toBe("~/project");
    expect(detectCwdFromPrompt("user@server ~/project % ")).toBe("~/project");
    expect(detectCwdFromPrompt("custom prompt without path > ")).toBeUndefined();
    expect(isLikelyShellPrompt("root@server:/var/log# ")).toBe(true);
    expect(isLikelyShellPrompt("bash-5.2$ ")).toBe(true);
    expect(isLikelyShellPrompt("Password: ")).toBe(false);
    expect(isLikelyShellPrompt(">>> ")).toBe(false);
  });
});
