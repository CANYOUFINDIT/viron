import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { emptyAgentHostState, isAgentHostAction, isAgentHostState } from "../src/shared/agent-host.js";

describe("Agent host overlay contract", () => {
  it("accepts a complete host snapshot and rejects partial objects", () => {
    expect(isAgentHostState(emptyAgentHostState)).toBe(true);
    expect(isAgentHostState({ ...emptyAgentHostState, userId: "u1", routePath: "/ssh" })).toBe(true);
    expect(isAgentHostState({ userId: "u1" })).toBe(false);
    expect(isAgentHostState(null)).toBe(false);
  });

  it("accepts the overlay-to-host actions used by Chatbox", () => {
    expect(isAgentHostAction({ type: "navigate-settings" })).toBe(true);
    expect(isAgentHostAction({ type: "scene-snapshot" })).toBe(true);
    expect(isAgentHostAction({ type: "fill-ssh", sessionId: "s1", command: "ls" })).toBe(true);
    expect(isAgentHostAction({ type: "fill-ssh-script", sessionId: "s1", script: "echo 1" })).toBe(true);
    expect(isAgentHostAction({ type: "fill-database", connectionId: "c1", database: "db", sql: "select 1" })).toBe(true);
    expect(isAgentHostAction({ type: "workbench-cancel", requestId: "r1", domain: "ssh" })).toBe(true);
    expect(isAgentHostAction({ type: "fill-ssh", sessionId: "s1" })).toBe(false);
    expect(isAgentHostAction({ type: "unknown" })).toBe(false);
  });

  it("keeps Chatbox in the main window unless a native Web page needs an overlay", () => {
    const host = readFileSync(new URL("../src/client/agent-host.ts", import.meta.url), "utf8");
    const overlay = readFileSync(new URL("../src/client/desktop-agent-chat.ts", import.meta.url), "utf8");
    expect(host).toContain("export function retainAgentNativeOverlay");
    expect(host).toContain("isAgentChatOverlayRuntime()");
    expect(overlay).toContain("window.vironAgentChatOverlay = true");
  });
});
