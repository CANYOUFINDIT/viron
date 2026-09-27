import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopStateFile, InstalledWebExtension } from "../src/desktop/app-state.js";

const fixture = vi.hoisted(() => ({ root: "", state: {} as DesktopStateFile, send: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root }, BrowserWindow: class {}, dialog: {}, nativeImage: {}, screen: {} }));
vi.mock("electron-chrome-web-store", () => ({ installChromeWebStore: vi.fn() }));
vi.mock("../src/desktop/app-state.js", () => ({
  readState: () => structuredClone(fixture.state),
  writeState: (state: DesktopStateFile) => { fixture.state = structuredClone(state); },
}));
vi.mock("../src/desktop/i18n.js", () => ({ translate: (text: string) => text }));
vi.mock("../src/desktop/window-host.js", () => ({ mainWindow: { isDestroyed: () => false, webContents: { send: fixture.send } } }));
vi.mock("../src/desktop/overlays/native-window-stack.js", () => ({ registerNativeOverlayWindow: vi.fn() }));
vi.mock("../src/desktop/web-extension-context-menus.js", () => ({ clearDesktopWebExtensionContextMenus: vi.fn(), restoreDesktopWebExtensionContextMenus: vi.fn() }));

const firstScope = "a".repeat(64);
const secondScope = "b".repeat(64);
let extensions: typeof import("../src/desktop/web-extensions.js");
let catalog: typeof import("../src/desktop/web-extension-catalog.js");

function session(fail = false) {
  const loaded = new Map<string, { id: string; name: string; version: string; manifest: object; path: string }>();
  return {
    extensions: {
      getExtension: (id: string) => loaded.get(id),
      removeExtension: vi.fn((id: string) => loaded.delete(id)),
      loadExtension: vi.fn(async (path: string) => {
        if (fail) throw new Error("Fixture load failure");
        const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
        const id = createHash("sha256").update(manifest.key || path).digest("hex").slice(0, 32);
        const extension = { id, name: manifest.name, version: manifest.version, manifest, path };
        loaded.set(id, extension);
        return extension;
      }),
    },
  } as unknown as Session;
}

async function source(name = "Fixture", key?: string) {
  const directory = join(fixture.root, "sources", randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ manifest_version: 3, name, version: "1.0.0", key }));
  return directory;
}

function legacy(name: string, fields: Partial<InstalledWebExtension> = {}): InstalledWebExtension {
  return { installId: randomUUID(), extensionId: randomUUID(), name, version: "1.0.0", ...fields };
}

beforeEach(async () => {
  vi.resetModules();
  fixture.root = await mkdtemp(join(tmpdir(), "viron-global-extensions-"));
  fixture.state = {};
  fixture.send.mockClear();
  extensions = await import("../src/desktop/web-extensions.js");
  catalog = await import("../src/desktop/web-extension-catalog.js");
});

afterEach(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe("computer-wide Web extensions", () => {
  it("migrates unopened accounts once, retaining original paths and preferences", () => {
    const first = legacy("First", { pinned: true, enabled: false });
    const second = legacy("Second");
    fixture.state = { language: "en", webExtensions: { [firstScope]: [first], [secondScope]: [second] } };
    expect(catalog.installedWebExtensions()).toEqual([{ ...first, sourceScope: firstScope }, { ...second, sourceScope: secondScope }]);
    expect(fixture.state.webExtensions).toBeUndefined();
    expect(fixture.state.language).toBe("en");
    expect(catalog.webExtensionPath(catalog.installedWebExtensions()[0])).toBe(join(fixture.root, "web-extensions", firstScope, first.installId));
    catalog.saveInstalledWebExtensions([]);
    expect(catalog.installedWebExtensions()).toEqual([]);
  });

  it("merges duplicate Chrome installs using an available newer version", async () => {
    const first = legacy("Chrome", { chromeId: "c".repeat(32), enabled: false, pinned: true });
    const second = legacy("Chrome", { chromeId: first.chromeId, version: "2.0.0" });
    const path = join(fixture.root, "web-extensions", secondScope, second.installId);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "manifest.json"), "{}");
    fixture.state.webExtensions = { [firstScope]: [first], [secondScope]: [second] };
    expect(catalog.installedWebExtensions()).toEqual([{ ...second, sourceScope: secondScope, pinned: true, enabled: true }]);
  });

  it("shares installs, pins, enablement and removal with existing and future sessions", async () => {
    const first = session();
    const second = session();
    await extensions.loadDesktopWebExtensions(first, firstScope);
    await extensions.loadDesktopWebExtensions(second, secondScope);
    const [item] = await extensions.installDesktopWebExtensionFromDirectory(first, firstScope, await source(), "c".repeat(32));
    const inSecond = () => extensions.listDesktopWebExtensions(second, secondScope)[0];
    expect(inSecond()).toMatchObject({ installId: item.installId, loaded: true });
    expect(first.extensions.getExtension(item.extensionId)?.path).toBe(second.extensions.getExtension(item.extensionId)?.path);
    const third = session();
    await extensions.loadDesktopWebExtensions(third, "d".repeat(64));
    expect(third.extensions.getExtension(item.extensionId)).toBeTruthy();
    await extensions.updateDesktopWebExtension(second, secondScope, item.installId, { pinned: true, enabled: false });
    expect(extensions.listDesktopWebExtensions(first, firstScope)[0]).toMatchObject({ pinned: true, enabled: false, loaded: false });
    expect(third.extensions.getExtension(item.extensionId)).toBeUndefined();
    await extensions.updateDesktopWebExtension(first, firstScope, item.installId, { enabled: true });
    expect(inSecond()).toMatchObject({ enabled: true, loaded: true });
    await expect(extensions.installDesktopWebExtensionFromDirectory(second, secondScope, await source(), "c".repeat(32))).rejects.toThrow("本机已添加");
    fixture.state.webExtensionMenus = { ["e".repeat(64)]: { [item.extensionId]: [] } };
    const installedPath = catalog.webExtensionPath(catalog.installedWebExtensions()[0]);
    await extensions.removeDesktopWebExtension(second, secondScope, item.installId);
    expect(extensions.listDesktopWebExtensions(first, firstScope)).toEqual([]);
    expect(first.extensions.getExtension(item.extensionId)).toBeUndefined();
    expect(third.extensions.getExtension(item.extensionId)).toBeUndefined();
    expect(existsSync(installedPath)).toBe(false);
    expect(fixture.state.webExtensionMenus?.["e".repeat(64)]?.[item.extensionId]).toBeUndefined();
    expect(fixture.send).toHaveBeenCalledWith("viron:web-extension:changed", { type: "refresh" });
    await extensions.loadDesktopWebExtensions(session(), "f".repeat(64));
    expect(catalog.installedWebExtensions()).toEqual([]);
  });

  it("retains migrated files and installs after deleting their original account", async () => {
    const item = legacy("Migrated");
    const path = join(fixture.root, "web-extensions", firstScope, item.installId);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "manifest.json"), JSON.stringify({ manifest_version: 3, name: item.name, version: item.version }));
    fixture.state.webExtensions = { [firstScope]: [item] };
    const first = session();
    await extensions.loadDesktopWebExtensions(first, firstScope);
    await extensions.forgetDesktopWebExtensions(first, firstScope);
    expect(existsSync(path)).toBe(true);
    const second = session();
    await extensions.loadDesktopWebExtensions(second, secondScope);
    expect(extensions.listDesktopWebExtensions(second, secondScope)[0]).toMatchObject({ installId: item.installId, loaded: true });
  });

  it("keeps load failures specific to the affected environment", async () => {
    const first = session();
    const second = session(true);
    await extensions.loadDesktopWebExtensions(second, secondScope);
    const [item] = await extensions.installDesktopWebExtensionFromDirectory(first, firstScope, await source());
    expect(item).toMatchObject({ loaded: true, error: "" });
    expect(extensions.listDesktopWebExtensions(second, secondScope)[0]).toMatchObject({ loaded: false, error: "Fixture load failure" });
    await extensions.removeDesktopWebExtension(first, firstScope, item.installId);
    expect(catalog.installedWebExtensions()).toEqual([]);
  });

  it("serializes concurrent imports and does not reload an extension after removal", async () => {
    const first = session();
    const second = session();
    const path = await source();
    const results = await Promise.allSettled([
      extensions.installDesktopWebExtensionFromDirectory(first, firstScope, path, "c".repeat(32)),
      extensions.installDesktopWebExtensionFromDirectory(second, secondScope, path, "c".repeat(32)),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const item = catalog.installedWebExtensions()[0];
    await Promise.all([
      extensions.loadDesktopWebExtensions(second, secondScope),
      extensions.removeDesktopWebExtension(first, firstScope, item.installId),
      extensions.loadDesktopWebExtensions(second, secondScope),
    ]);
    expect(second.extensions.getExtension(item.extensionId)).toBeUndefined();
    expect(catalog.installedWebExtensions()).toEqual([]);
  });

  it("restores an existing keyed extension when a duplicate archive is rejected", async () => {
    const first = session();
    const path = await source("Keyed", "fixture-public-key");
    const [item] = await extensions.installDesktopWebExtensionFromDirectory(first, firstScope, path);
    const originalPath = first.extensions.getExtension(item.extensionId)?.path;
    await expect(extensions.installDesktopWebExtensionFromDirectory(first, firstScope, path)).rejects.toThrow("本机已添加");
    expect(catalog.installedWebExtensions()).toHaveLength(1);
    expect(first.extensions.getExtension(item.extensionId)?.path).toBe(originalPath);
  });
});
