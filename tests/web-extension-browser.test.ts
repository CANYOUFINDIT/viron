import { EventEmitter } from "node:events";
import type { Session, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn), on: vi.fn() },
  BrowserWindow: { fromId: () => ({ getContentBounds: () => ({ width: 800, height: 600 }) }) },
  WebContentsView: class {},
}));
let api: typeof import("../src/desktop/web-extension-browser.js");
const extensionId = "a".repeat(32);
const extensionUrl = `chrome-extension://${extensionId}/popup.html`;
function session() {
  return { extensions: { getExtension: (id: string) => id === extensionId ? { id, manifest: { permissions: ["activeTab", "scripting"] } } : null } } as unknown as Session;
}
function tab(partition: Session, id: number) {
  return Object.assign(new EventEmitter(), { id, session: partition, isDestroyed: () => false,
    getURL: () => "https://example.com/", getTitle: () => "Example", isLoading: () => false,
    capturePage: vi.fn(async () => ({ toDataURL: () => "data:image/png;base64,fixture", toJPEG: () => Buffer.from("jpeg") })),
    loadURL: vi.fn(async () => undefined), setAudioMuted: vi.fn(),
  });
}
function invoke(partition: Session, method: string, args: unknown[] = [], origin = extensionUrl) {
  return handlers.get("viron:extension-browser")!({ sender: { session: partition, id: 500 }, senderFrame: { url: origin } }, method, args);
}
beforeEach(async () => {
  vi.resetModules(); handlers.clear();
  api = await import("../src/desktop/web-extension-browser.js");
  api.registerExtensionBrowserIpc();
});

describe("extension browser bridge", () => {
  it("queries only registered tabs in the caller's environment, preserving the selected tab", async () => {
    const first = session(); const second = session();
    const a = tab(first, 1); const b = tab(first, 2); const c = tab(second, 3);
    for (const item of [a, b, c]) api.registerExtensionTab(item as unknown as WebContents, { windowId: 7, select: vi.fn(), remove: vi.fn() });
    api.selectExtensionTab(a as unknown as WebContents);
    api.selectExtensionTab(c as unknown as WebContents);
    expect(await invoke(first, "tabs.query", [{ active: true }])).toMatchObject({ result: [{ id: 1, active: true, windowId: 7 }] });
    expect((await invoke(first, "tabs.query", [{}])).result.map((value: any) => value.id)).toEqual([1, 2]);
    expect((await invoke(second, "tabs.get", [1])).error).toContain("No tab");
    expect((await invoke(first, "tabs.query", [{}], "https://example.com/")).error).toBe("Invalid extension origin");
  });

  it("grants capture only after a user gesture and revokes it on navigation", async () => {
    const partition = session(); const page = tab(partition, 1);
    api.registerExtensionTab(page as unknown as WebContents, { windowId: 7, select: vi.fn(), remove: vi.fn() });
    api.selectExtensionTab(page as unknown as WebContents);
    expect((await invoke(partition, "tabs.captureVisibleTab", [undefined, { format: "png" }])).error).toContain("user gesture");
    api.grantExtensionActiveTab(partition, extensionId, 1);
    expect(await invoke(partition, "tabs.captureVisibleTab", [undefined, { format: "png" }])).toEqual({ result: "data:image/png;base64,fixture" });
    expect((await invoke(partition, "tabs.captureVisibleTab", [99, {}])).error).toContain("No active tab");
    page.emit("did-start-navigation", {}, "https://elsewhere.example/", false, true);
    expect((await invoke(partition, "tabs.captureVisibleTab", [undefined, { format: "png" }])).error).toContain("user gesture");
    expect(page.capturePage).toHaveBeenCalledOnce();
  });

  it("uses the host to create, activate, and close tabs, rejecting privileged URLs", async () => {
    const partition = session(); const page = tab(partition, 1); const select = vi.fn(); const remove = vi.fn();
    api.registerExtensionTab(page as unknown as WebContents, { windowId: 7, select, remove });
    const create = vi.fn(() => page as unknown as WebContents);
    api.registerExtensionBrowser(partition, { create });
    await invoke(partition, "tabs.create", [{ url: "result.html", active: false }]);
    expect(create).toHaveBeenCalledWith(`chrome-extension://${extensionId}/result.html`, false);
    await invoke(partition, "tabs.update", [1, { active: true }]);
    expect(select).toHaveBeenCalledOnce();
    await invoke(partition, "tabs.remove", [1]);
    expect(remove).toHaveBeenCalledOnce();
    expect((await invoke(partition, "tabs.create", [{ url: "file:///etc/passwd" }])).error).toContain("Unsupported");
    expect((await invoke(partition, "tabs.create", [{ url: `chrome-extension://${"b".repeat(32)}/private.html` }])).error).toContain("Unsupported");
  });
});
