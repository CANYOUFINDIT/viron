import { describe, expect, it } from "vitest";
import {
  applyDesktopWebPluginPolicy,
  refreshOrganizationWebPlugins,
  webExtensionShortcutEnabled,
  type WebPluginView,
} from "../src/desktop/web-plugin-session.js";

function view(environmentId: string, allowExtensions: boolean, locked = false): WebPluginView & {
  suspended: boolean;
  resumed: boolean;
  popupClosed: number;
} {
  const state = {
    environmentId,
    allowExtensions,
    locked,
    suspended: false,
    resumed: false,
    popupClosed: 0,
    async suspend() { state.suspended = true; },
    async resume() { state.resumed = true; },
    closePopup() { state.popupClosed += 1; },
  };
  return state;
}

describe("open web plugin sessions", () => {
  it("suspends extension execution and shortcuts when injection stops, and leaves the page open", async () => {
    const open = view("env-a", true);
    expect(await applyDesktopWebPluginPolicy(open, { inject: false })).toBe("suspended");
    expect(open.allowExtensions).toBe(false);
    expect(open.suspended).toBe(true);
    expect(open.popupClosed).toBe(1);
    expect(open.resumed).toBe(false);
    expect(webExtensionShortcutEnabled(open.allowExtensions, open.locked)).toBe(false);
    expect(await applyDesktopWebPluginPolicy(open, { inject: false })).toBe("unchanged");
    expect(open.popupClosed).toBe(1);
  });

  it("resumes only while injection is allowed and the page is not locked", async () => {
    const open = view("env-a", false);
    expect(await applyDesktopWebPluginPolicy(open, { inject: true })).toBe("resumed");
    expect(open.allowExtensions).toBe(true);
    expect(open.resumed).toBe(true);
    expect(webExtensionShortcutEnabled(open.allowExtensions, open.locked)).toBe(true);
    const locked = view("env-a", true, true);
    expect(await applyDesktopWebPluginPolicy(locked, { inject: true })).toBe("suspended");
    expect(locked.allowExtensions).toBe(false);
    expect(webExtensionShortcutEnabled(locked.allowExtensions, locked.locked)).toBe(false);
  });

  it("refreshes each environment separately and fails closed without a policy", async () => {
    const lost = view("env-a", true);
    const kept = view("env-b", true);
    const personal = view("", true);
    const reads: string[] = [];
    await refreshOrganizationWebPlugins([lost, kept, personal], async (environmentId) => {
      reads.push(environmentId);
      return { inject: environmentId === "env-b" };
    });
    expect(reads).toEqual(["env-a", "env-b"]);
    expect(lost.suspended).toBe(true);
    expect(lost.allowExtensions).toBe(false);
    expect(webExtensionShortcutEnabled(lost.allowExtensions, lost.locked)).toBe(false);
    expect(kept.suspended).toBe(false);
    expect(kept.allowExtensions).toBe(true);
    expect(personal.allowExtensions).toBe(true);
    expect(personal.suspended).toBe(false);

    const offline = view("env-c", true);
    await refreshOrganizationWebPlugins([offline], async () => {
      throw new Error("policy unavailable");
    });
    expect(offline.allowExtensions).toBe(false);
    expect(offline.suspended).toBe(true);
    expect(offline.popupClosed).toBe(1);
  });
});
