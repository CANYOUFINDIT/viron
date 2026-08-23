import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeConnectionNavigationTarget,
  activeEnvironmentDockNavigationTarget,
} from "../src/client/active-connection-navigation.js";
import {
  pruneActiveConnectionOrigins,
  rememberedActiveConnectionOrigin,
  rememberActiveConnectionOrigin,
} from "../src/client/active-connection-origin.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("active connection navigation", () => {
  it("returns to the environment that launched the connection", () => {
    expect(activeConnectionNavigationTarget({
      type: "ssh",
      originEnvironmentId: "environment-b",
      environmentIds: ["environment-a", "environment-b"],
    })).toEqual({ name: "environment", params: { id: "environment-b" } });
    expect(activeConnectionNavigationTarget({
      type: "ssh",
      originEnvironmentId: "environment-b",
      environmentIds: ["environment-b"],
    }, "environment-a")).toEqual({ name: "environment", params: { id: "environment-b" } });
  });

  it("uses the App-recorded origin when an older endpoint drops the source field", () => {
    expect(activeConnectionNavigationTarget({
      type: "ssh",
      originEnvironmentId: null,
      environmentIds: ["environment-a"],
    }, "environment-a")).toEqual({ name: "environment", params: { id: "environment-a" } });
  });

  it("uses the matching global workbench when no environment launched the connection", () => {
    expect(activeConnectionNavigationTarget({
      type: "ssh",
      originEnvironmentId: null,
      environmentIds: ["environment-a"],
    })).toEqual({ name: "ssh" });
    expect(activeConnectionNavigationTarget({ type: "sftp", originEnvironmentId: null, environmentIds: [] })).toEqual({ name: "ssh" });
    expect(activeConnectionNavigationTarget({ type: "database", originEnvironmentId: null, environmentIds: ["environment-a"] })).toEqual({ name: "database" });
    expect(activeConnectionNavigationTarget({ type: "redis", originEnvironmentId: null, environmentIds: ["environment-a"] })).toEqual({ name: "redis" });
  });

  it("returns exact environment workbench targets from the active environment dock", () => {
    expect(activeEnvironmentDockNavigationTarget({ id: "active-redis", type: "redis", resourceId: "redis-a" }, "environment-a")).toEqual({
      name: "environment",
      params: { id: "environment-a" },
      query: { tab: "redis", connectionId: "redis-a", activeConnectionId: "active-redis" },
    });
    expect(activeEnvironmentDockNavigationTarget({ id: "active-sftp", type: "sftp", resourceId: "ssh-a" }, "environment-b")).toEqual({
      name: "environment",
      params: { id: "environment-b" },
      query: { tab: "ssh", connectionId: "ssh-a", activeConnectionId: "active-sftp", mode: "sftp" },
    });
  });

  it("uses the single owning environment for environment-only Web and log runtimes", () => {
    expect(activeConnectionNavigationTarget({ type: "web", originEnvironmentId: null, environmentIds: ["environment-a"] }))
      .toEqual({ name: "environment", params: { id: "environment-a" } });
    expect(activeConnectionNavigationTarget({ type: "logs", originEnvironmentId: null, environmentIds: ["environment-b"] }))
      .toEqual({ name: "environment", params: { id: "environment-b" } });
  });

  it("retains origins only for active connection ids", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    rememberActiveConnectionOrigin("active-a", "environment-a");
    rememberActiveConnectionOrigin("active-b", "environment-b");
    pruneActiveConnectionOrigins(["active-b"]);

    expect(rememberedActiveConnectionOrigin("active-a")).toBeUndefined();
    expect(rememberedActiveConnectionOrigin("active-b")).toBe("environment-b");
  });

  it("makes the connection row navigable without letting close trigger navigation", () => {
    const view = source("src/client/views/ActiveConnectionsView.vue");
    expect(view).toContain('class="active-connection-open"');
    expect(view).toContain('@click="openItem(item)"');
    expect(view).toContain('@click.stop="closeItem(item)"');
    expect(view).toContain('currentWorkspace.id !== item.workspaceId');
    expect(view).toContain("rememberedActiveConnectionOrigin(item.id)");
  });

  it("returns exact active connection ids from desktop-local runtimes", () => {
    // contract unchanged; implementation moved from src/desktop/main.ts
    const desktopSshIpc = source("src/desktop/ipc/register-ssh-ipc.ts");
    // contract unchanged; implementation moved from src/desktop/main.ts
    const desktopWebRuntime = source("src/desktop/web-view-runtime.ts");
    const ssh = source("src/client/components/SshWorkbench.vue");
    const database = source("src/client/components/DatabaseWorkbench.vue");
    const desktopWeb = source("src/client/components/DesktopWebAccountBrowser.vue");
    expect(desktopSshIpc).toContain("return { ...opened, activeConnectionId: registrationId };");
    expect(desktopWebRuntime).toContain('reserveDesktopRuntime("web", credentialId, undefined, originEnvironmentId)');
    expect(ssh).toContain("response.activeConnectionId ?? response.session.id");
    expect(database).toContain("rememberActiveConnectionOrigin(runtime.item.id, props.environmentId)");
    expect(desktopWeb).toContain("props.environmentId");
    expect(desktopWeb).toContain("loadActiveConnections");
  });
});
