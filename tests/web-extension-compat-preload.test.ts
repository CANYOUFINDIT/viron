import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("../src/desktop/web-extension-compat-preload.cts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function preload(backend: (operation: string, value?: any) => Promise<{ error?: string }>) {
  const runtime: any = { id: "a".repeat(32), onMessage: { addListener: vi.fn() } };
  Object.defineProperty(runtime, "lastError", { configurable: true, get: () => undefined });
  const sandbox: any = { exports: {}, chrome: { runtime }, browser: { runtime }, location: { protocol: "chrome-extension:" }, document: {}, console, queueMicrotask, process: { platform: "darwin" } };
  const invoke = vi.fn((_channel: string, operation: string, _id: string, value: unknown) => backend(operation, value));
  sandbox.require = () => ({
    ipcRenderer: { invoke },
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => { sandbox[key] = value; },
      executeInMainWorld: ({ func }: { func: () => void }) => func(),
    },
  });
  runInNewContext(code, sandbox);
  return { menus: sandbox.chrome.contextMenus, chrome: sandbox.chrome, browser: sandbox.browser, runtime, invoke };
}

describe("Chrome menu API compatibility", () => {
  it("lets extensions register command listeners before installing their context menus", async () => {
    const { chrome, browser } = preload(async () => ({}));
    const listener = vi.fn();
    chrome.commands.onCommand.addListener(listener);
    expect(chrome.commands.onCommand.hasListener(listener)).toBe(true);
    expect(browser.commands).toBe(chrome.commands);
    expect(await chrome.commands.getAll()).toEqual([]);
    chrome.commands.onCommand.removeListener(listener);
    expect(chrome.commands.onCommand.hasListeners()).toBe(false);
  });

  it("exposes the same menu API in Electron's separate browser namespace", async () => {
    const { menus, browser, invoke } = preload(async () => ({}));
    expect(browser.contextMenus).toBe(menus);
    expect(Object.keys(browser)).toContain("contextMenus");
    await browser.contextMenus.update("translate", { title: "Translate" });
    expect(invoke).toHaveBeenCalledWith("viron:extension-menu:mutate", "update", "a".repeat(32), { id: "translate", title: "Translate", onclick: undefined });
  });
  it("rejects missing updates for Promise callers and supports update-or-create initialization", async () => {
    const stored = new Map<string, object>();
    const { menus } = preload(async (operation, value) => {
      if (operation === "update" && !stored.has(value.id)) return { error: "Cannot find menu item" };
      if (operation === "create") stored.set(value.id, value);
      return {};
    });
    await expect(menus.update("translate", { title: "Translate" })).rejects.toThrow("Cannot find menu item");
    await new Promise<void>((resolve, reject) => {
      menus.update("translate", { title: "Translate" }).catch(() => {
        try { expect(menus.create({ id: "translate", title: "Translate", contexts: ["selection"] }, resolve)).toBe("translate"); }
        catch (error) { reject(error); }
      });
    });
    expect(stored.get("translate")).toMatchObject({ contexts: ["selection"] });
  });

  it("exposes lastError only during callbacks so webextension-polyfill rejects failed operations", async () => {
    const { menus, runtime } = preload(async () => ({ error: "Cannot find menu item" }));
    const polyfillUpdate = () => new Promise<void>((resolve, reject) => {
      expect(menus.update("translate", { title: "Translate" }, () => {
        if (runtime.lastError) reject(new Error(runtime.lastError.message));
        else resolve();
      })).toBeUndefined();
    });
    await expect(polyfillUpdate()).rejects.toThrow("Cannot find menu item");
    expect(runtime.lastError).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(runtime, "lastError")?.get).toBeTypeOf("function");
  });

  it("waits for registration to complete before invoking success callbacks", async () => {
    let finish!: (result: {}) => void;
    const { menus, invoke } = preload(() => new Promise((resolve) => { finish = resolve; }));
    const callback = vi.fn();
    menus.create({ id: "translate", title: "Translate", onclick: () => undefined }, callback);
    expect(callback).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0][3]).toMatchObject({ id: "translate", onclick: undefined });
    finish({});
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  });
});
