import { afterEach, describe, expect, it } from "vitest";
import { currentAgentSshScene, fillAgentSshCommand, fillAgentSshScript, registerAgentSshSceneProvider } from "../src/client/agent-ssh-scene.js";

let release: (() => void) | undefined;

afterEach(() => {
  release?.();
  release = undefined;
});

describe("AI Agent SSH workbench scene", () => {
  it("binds fill actions to the visible route and selected connected session", () => {
    const filled: string[] = [];
    const filledScripts: string[] = [];
    release = registerAgentSshSceneProvider({
      current: () => ({
        routePath: "/ssh?workspaceId=one",
        sessionId: "session-1",
        connectionId: "connection-1",
        connectionName: "Production Readonly",
        host: "10.0.0.8",
        status: "connected",
        currentDirectory: "/srv/app",
        localExecution: true,
      }),
      fill: (_sessionId, command) => {
        filled.push(command);
        return true;
      },
      fillScript: (_sessionId, script) => {
        filledScripts.push(script);
        return true;
      },
    });

    expect(currentAgentSshScene("/ssh?workspaceId=one")?.currentDirectory).toBe("/srv/app");
    expect(currentAgentSshScene("/ssh?workspaceId=two")).toBeNull();
    expect(fillAgentSshCommand("/ssh?workspaceId=one", "session-1", "pwd")).toBe(true);
    expect(fillAgentSshCommand("/ssh?workspaceId=one", "session-2", "whoami")).toBe(false);
    expect(fillAgentSshCommand("/ssh?workspaceId=one", "session-1", "pwd\nuname -a")).toBe(false);
    expect(fillAgentSshScript("/ssh?workspaceId=one", "session-1", "set -eu\nprintf ready")).toBe(true);
    expect(fillAgentSshScript("/ssh?workspaceId=one", "session-2", "echo ignored")).toBe(false);
    expect(fillAgentSshScript("/ssh?workspaceId=one", "session-1", "echo ready\x1b[2J")).toBe(false);
    expect(filled).toEqual(["pwd"]);
    expect(filledScripts).toEqual(["set -eu\nprintf ready"]);
  });

  it("does not fill server-forwarded or disconnected SSH scenes", () => {
    let fillCount = 0;
    release = registerAgentSshSceneProvider({
      current: () => ({
        routePath: "/ssh",
        sessionId: "session-1",
        connectionId: "connection-1",
        connectionName: "Server Mode",
        host: "10.0.0.9",
        status: "disconnected",
        currentDirectory: "unknown",
        localExecution: false,
      }),
      fill: () => {
        fillCount += 1;
        return true;
      },
      fillScript: () => {
        fillCount += 1;
        return true;
      },
    });

    expect(fillAgentSshCommand("/ssh", "session-1", "pwd")).toBe(false);
    expect(fillAgentSshScript("/ssh", "session-1", "echo ready\necho done")).toBe(false);
    expect(fillCount).toBe(0);
  });
});
