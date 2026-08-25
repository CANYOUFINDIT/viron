import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { desktopMcpOperationUrlAllowed, desktopMcpWorkspaceKey } from "../src/desktop/mcp-security.js";

const desktopMain = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopExecutionIpc = readFileSync(new URL("../src/desktop/ipc/register-execution-ipc.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopMcpBridge = readFileSync(new URL("../src/desktop/mcp-desktop-bridge.ts", import.meta.url), "utf8");
// contract unchanged; implementation moved from src/desktop/main.ts
const desktopWebRuntime = readFileSync(new URL("../src/desktop/web-view-runtime.ts", import.meta.url), "utf8");

describe("desktop MCP security", () => {
  it("limits the safety window to the current Endpoint and exact Operation routes", () => {
    const endpoint = "https://viron.example.test/base";
    const operation = "https://viron.example.test/mcp/operations/11111111-1111-4111-8111-111111111111";
    expect(desktopMcpOperationUrlAllowed(endpoint, operation)).toBe(true);
    expect(desktopMcpOperationUrlAllowed(endpoint, `${operation}/submit`)).toBe(false);
    expect(desktopMcpOperationUrlAllowed(endpoint, `${operation}/submit`, true)).toBe(true);
    expect(desktopMcpOperationUrlAllowed(endpoint, `${operation}?next=https://evil.test`, true)).toBe(false);
    expect(desktopMcpOperationUrlAllowed(endpoint, `${operation}#secret`, true)).toBe(false);
    expect(desktopMcpOperationUrlAllowed(endpoint, operation.replace("viron.example.test", "evil.test"), true)).toBe(false);
  });

  it("derives the only workspace accepted by local STDIO MCP", () => {
    expect(desktopMcpWorkspaceKey({ workspace: { type: "personal", id: "user-1" } })).toBe("personal");
    expect(desktopMcpWorkspaceKey({ workspace: { type: "organization", id: "11111111-1111-4111-8111-111111111111" } }))
      .toBe("organization:11111111-1111-4111-8111-111111111111");
  });

  it("closes pending Operations across mode, Endpoint, workspace, login, logout, clear, and quit boundaries", () => {
    expect(desktopMain).toContain('closeDesktopMcpOperations(),\n      closeAllDesktopWebViews(),\n      closeDesktopExecution(tr("App 连接模式已切换"))');
    expect(desktopMain).toContain('closeDesktopMcpOperations(),\n          closeAllDesktopWebViews(),\n          closeDesktopExecution(tr("Endpoint 已切换"))');
    expect(desktopMain).toContain('await Promise.all([closeDesktopMcpOperations(), closeAllDesktopWebViews(), closeDesktopExecution(tr("Endpoint 已清除"))');
    expect(desktopExecutionIpc).toContain('await Promise.all([closeDesktopMcpOperations(), closeAllDesktopWebViews(), closeDesktopExecution(reason)])');
    expect(desktopMain).toContain('closeDesktopMcpOperations(false),\n    desktopMcpBroker?.close()');
  });

  it("creates a sandboxed, closeable, non-blocking safety window using the signed-in Endpoint partition", () => {
    expect(desktopMcpBridge).toContain('["X-Viron-MCP-Origin", activeEndpoint.endpoint]');
    expect(desktopMcpBridge).toContain("session: activeEndpoint.partition");
    expect(desktopMcpBridge).toContain("contextIsolation: true");
    expect(desktopMcpBridge).toContain("nodeIntegration: false");
    expect(desktopMcpBridge).toContain("sandbox: true");
    expect(desktopMcpBridge).toContain("modal: false");
    expect(desktopMcpBridge).toContain("closable: true");
    expect(desktopMcpBridge).toContain('method: "DELETE"');
    expect(desktopMcpBridge).toContain('["completed", "failed", "cancelled", "expired"]');
    expect(desktopMcpBridge).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
    expect(desktopMcpBridge).toContain("desktopMcpOperationUrlAllowed(activeEndpoint!.endpoint, url, true)");
    expect(desktopMcpBridge).toContain('webContents.on("did-navigate"');
    expect(desktopMcpBridge).toContain('if (/\\/(?:submit|cancel)$/.test(new URL(url).pathname)) refreshOperationStatus(true)');
    expect(desktopMcpBridge).toContain("statusRefreshQueued ||= queueIfBusy");
    expect(desktopMcpBridge).toContain('["awaiting_purpose", "pending", "approved"].includes(String(data.status))');
    expect(desktopMcpBridge).toContain('if (data.status === "awaiting_purpose") return response');
    expect(desktopMcpBridge).toContain('if (!data.actionUrl) throw new Error');
  });

  it("routes confirmed local Web navigation through the managed desktop Web runtime", () => {
    expect(desktopWebRuntime).toContain("interface DesktopMcpWebControl");
    expect(desktopMcpBridge).toContain("controlDesktopWebCredential(webControl[1], input.body as DesktopMcpWebControl)");
    expect(desktopWebRuntime).toContain('if (!input.url || !supportedDesktopWebUrl(input.url))');
    expect(desktopWebRuntime).toContain("webContents.navigationHistory");
  });
});
