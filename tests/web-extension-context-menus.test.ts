import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopStateFile } from "../src/desktop/app-state.js";

const fixture = vi.hoisted(() => ({
  state: {} as DesktopStateFile,
  handle: vi.fn(),
  executeJavaScript: vi.fn(async () => undefined),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: fixture.handle },
  WebContentsView: class {
    webContents = { loadURL: async () => undefined, executeJavaScript: fixture.executeJavaScript, isDestroyed: () => false, close: vi.fn() };
  },
}));
vi.mock("../src/desktop/app-state.js", () => ({
  readState: () => structuredClone(fixture.state),
  writeState: (state: DesktopStateFile) => { fixture.state = structuredClone(state); },
}));
const extensionId = "a".repeat(32);
const scope = "b".repeat(64);
const origin = `chrome-extension://${extensionId}/background.html`;
const contents = { id: 42, getURL: () => "https://example.com/", getTitle: () => "Fixture" } as WebContents;
const page = { pageURL: "https://example.com/", frameURL: "", linkURL: "", srcURL: "", mediaType: "none", selectionText: "", isEditable: false };
let directory: string;
let menus: typeof import("../src/desktop/web-extension-context-menus.js");
let partition: Session;
let mutate: (operation: string, value?: unknown, senderOrigin?: string) => { error?: string };

beforeEach(async () => {
  vi.resetModules();
  fixture.handle.mockClear();
  fixture.executeJavaScript.mockClear();
  fixture.state = {};
  directory = await mkdtemp(join(tmpdir(), "viron-context-menus-"));
  const workers = Object.assign(new EventEmitter(), { getAllRunning: () => ({}) });
  partition = { extensions: { getExtension: (id: string) => id === extensionId ? { id, name: "Fixture", path: directory, manifest: { permissions: ["contextMenus"] } } : undefined }, serviceWorkers: workers } as unknown as Session;
  menus = await import("../src/desktop/web-extension-context-menus.js");
  menus.registerDesktopWebExtensionContextMenus();
  menus.registerDesktopWebExtensionWorkerMenus(partition, scope);
  const handler = fixture.handle.mock.calls[0][1];
  mutate = (operation, value, senderOrigin = origin) => handler({ sender: { session: partition }, senderFrame: { url: senderOrigin } }, operation, extensionId, value);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("extension context menu registration", () => {
  it("rejects update of a missing item so update-or-create plugins can register the intended contexts", () => {
    expect(mutate("update", { id: "translate", title: "Translate" }).error).toContain("Cannot find");
    expect(menus.desktopWebExtensionContextMenuItems(partition, contents, page)).toEqual([]);
    expect(mutate("create", { id: "translate", title: "Translate %s", contexts: ["selection"] })).toEqual({});
    expect(menus.desktopWebExtensionContextMenuItems(partition, contents, page)).toEqual([]);
    const selection = menus.desktopWebExtensionContextMenuItems(partition, contents, { ...page, selectionText: "Hello" });
    expect(selection).toMatchObject([{ label: "Fixture", submenu: [{ label: "Translate Hello" }] }]);
    expect(mutate("update", { id: "translate", title: "Updated" })).toEqual({});
    expect(fixture.state.webExtensionMenus?.[scope]?.[extensionId]?.[0]).toMatchObject({ contexts: ["selection"], title: "Updated" });
  });

  it("reports duplicate IDs and invalid parents without replacing existing menus", () => {
    mutate("create", { id: "parent", title: "Parent" });
    expect(mutate("create", { id: "parent", title: "Replacement" }).error).toContain("duplicate");
    expect(mutate("create", { id: "orphan", parentId: "absent", title: "Orphan" }).error).toBe("Invalid menu parent");
    mutate("create", { id: "child", parentId: "parent", title: "Child" });
    expect(mutate("update", { id: "parent", parentId: "child" }).error).toBe("Invalid menu parent");
    expect(mutate("remove", { id: "parent" })).toEqual({});
    expect(menus.desktopWebExtensionContextMenuItems(partition, contents, page)).toEqual([]);
    expect(mutate("update", { id: "child", title: "Leftover" }).error).toContain("Cannot find");
  });

  it("does not accept registration from ordinary pages or other extensions", () => {
    expect(mutate("create", { id: "bad", title: "Bad" }, "https://example.com/").error).toBeTruthy();
    expect(mutate("create", { id: "bad", title: "Bad" }, `chrome-extension://${"c".repeat(32)}/page.html`).error).toBeTruthy();
    expect(menus.desktopWebExtensionContextMenuItems(partition, contents, page)).toEqual([]);
  });

  it("persists menus and dispatches selection commands to the correct environment and tab", async () => {
    mutate("create", { id: "translate", title: "Translate", contexts: ["page", "selection", "image"] });
    menus.clearDesktopWebExtensionContextMenus(partition, extensionId);
    menus.restoreDesktopWebExtensionContextMenus(partition, scope, extensionId);
    const groups = menus.desktopWebExtensionContextMenuItems(partition, contents, { ...page, selectionText: "Selected text" });
    const command = (groups[0].submenu as Electron.MenuItemConstructorOptions[])[0];
    (command.click as () => void)();
    await vi.waitFor(() => expect(fixture.executeJavaScript).toHaveBeenCalled());
    expect(fixture.executeJavaScript.mock.calls[0][0]).toContain('"selectionText":"Selected text"');
    expect(fixture.executeJavaScript.mock.calls[0][0]).toContain('"id":42');
    const otherPartition = { ...partition } as Session;
    expect(menus.desktopWebExtensionContextMenuItems(otherPartition, contents, page)).toEqual([]);
  });
});
