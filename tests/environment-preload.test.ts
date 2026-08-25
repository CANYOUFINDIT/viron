import { describe, expect, it } from "vitest";
import {
  environmentBackgroundPreloadAllowed,
  environmentBackgroundPreloadOrder,
  environmentTabUsesIntentOnlyPreload,
} from "../src/client/environment-preload.js";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("environment preload policy", () => {
  it("runs only for the visible foreground environment outside data saver mode", () => {
    expect(environmentBackgroundPreloadAllowed({ active: true, preview: false, visible: true, saveData: false })).toBe(true);
    expect(environmentBackgroundPreloadAllowed({ active: false, preview: false, visible: true, saveData: false })).toBe(false);
    expect(environmentBackgroundPreloadAllowed({ active: true, preview: true, visible: true, saveData: false })).toBe(false);
    expect(environmentBackgroundPreloadAllowed({ active: true, preview: false, visible: false, saveData: false })).toBe(false);
    expect(environmentBackgroundPreloadAllowed({ active: true, preview: false, visible: true, saveData: true })).toBe(false);
  });

  it("preloads smaller populated tabs sequentially and leaves database to user intent", () => {
    expect(environmentBackgroundPreloadOrder({
      ssh: 2,
      logs: 1,
      database: 3,
      redis: 1,
      knowledge: 4,
      maintenance: 0,
    }, "web")).toEqual(["logs", "knowledge", "redis", "ssh"]);
    expect(environmentTabUsesIntentOnlyPreload("database")).toBe(true);
    expect(environmentTabUsesIntentOnlyPreload("ssh")).toBe(false);
  });

  it("does not enqueue empty tabs or the current tab", () => {
    expect(environmentBackgroundPreloadOrder({
      ssh: 0,
      logs: 2,
      database: 2,
      redis: 1,
      knowledge: 0,
      maintenance: 3,
    }, "logs")).toEqual(["redis", "maintenance"]);
  });

  it("binds Web preloading to one account and releases desktop runtime reservations immediately", () => {
    const environment = source("../src/client/views/EnvironmentDetailView.vue");
    const ordinaryWeb = source("../src/client/components/WebAccountBrowser.vue");
    const desktopWeb = source("../src/client/components/DesktopWebAccountBrowser.vue");
    const viewManager = source("../src/server/web-browser/view-manager.ts");
    // contract unchanged; implementation moved from src/desktop/main.ts
    const desktopWebRuntime = source("../src/desktop/web-view-runtime.ts");
    expect(environment).toContain("webPreloadCredentialId.value = paneCredentialIds.value[0]");
    expect(environment).toContain("webPreloadCredentialId === opened.id");
    expect(ordinaryWeb).toContain("body: JSON.stringify({ ...viewportSize(), initialPage, preload })");
    expect(ordinaryWeb).toContain('visible: props.active && !preloading.value');
    expect(ordinaryWeb).toContain('status.value = preload ? "idle" : "disconnected"');
    expect(ordinaryWeb).toContain("if (!preload) claimPreloadedView()");
    expect(ordinaryWeb).toContain("await Promise.allSettled([closeRequest, connectPromise])");
    expect(ordinaryWeb).toContain("window.setTimeout(() => void loadActiveConnections().catch(() => undefined), 120)");
    expect(ordinaryWeb).toContain("@pointerdown.capture=\"handleBrowserInteraction\"");
    expect(ordinaryWeb).toContain("target.closest(\".web-browser-idle\")");
    expect(ordinaryWeb).toContain("@pointerdown.stop @mousedown.stop @dblclick=\"visitPage\"");
    expect(desktopWeb).toContain("@pointerdown.capture=\"handleBrowserInteraction\"");
    expect(desktopWeb).toContain("target.closest(\".web-browser-idle\")");
    expect(desktopWeb).toContain("@pointerdown.stop @mousedown.stop @dblclick=\"visitPage\"");
    expect(desktopWeb).toContain("props.active && !preloading.value");
    expect(desktopWeb).toContain("await startPromise?.catch(() => undefined)");
    expect(desktopWeb).toContain('startError.value = preload ? ""');
    expect(viewManager).toContain('frame: preload ? "" : await this.captureInitialFrame(view)');
    expect(viewManager).toContain("if (ticketData.initiallyVisible) view.visibleSockets.add(socket)");
    expect(viewManager).toContain("if (!preload) await navigation");
    expect(viewManager).toContain("starting.cancelled = true");
    expect(viewManager.indexOf("this.app.activeConnections.release(view.runtimeId)")).toBeLessThan(viewManager.indexOf("await view.context.close().catch(() => undefined)"));
    expect(desktopWebRuntime).toContain("registrationId: string");
    expect(desktopWebRuntime).toContain("const releaseReservation = releaseDesktopRuntimeReservation(managed.registrationId)");
    expect(desktopWebRuntime).toContain("await releaseReservation");
  });
});
