import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, contentsById } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  contentsById: new Map<number, any>(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, callback: (...args: any[]) => unknown) => handlers.set(name, callback) },
  webContents: { fromId: (id: number) => contentsById.get(id) },
}));

describe("browser guest binding", () => {
  beforeEach(() => { vi.resetModules(); handlers.clear(); contentsById.clear(); });
  async function setup() {
    const host = await import("../src/desktop/browser-guest-host");
    const owner = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false, getUserAgent: () => "Browser test agent" });
    const session = {};
    host.configureBrowserGuestHost(owner as any);
    const request = host.createBrowserGuest(owner as any, session as any, "persist:account-a", "view-a", "page-a",
      { x: 10, y: 20, width: 500, height: 400 }, { session: session as any, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false });
    const token = owner.send.mock.calls[0][1].request.token as string;
    const params = { src: "about:blank", useragent: `VironBrowserGuest/${token}`, partition: "persist:account-a", preload: "untrusted-preload" };
    const preferences = { nodeIntegration: true, preload: "untrusted-preload", sandbox: false, webSecurity: false };
    return { host, owner, session, request, token, params, preferences };
  }
  function guest(owner: any, session: any) {
    const contents = Object.assign(new EventEmitter(), {
      id: 7, hostWebContents: owner, session,
      getType: () => "webview", isDestroyed: () => false,
      close: vi.fn(), loadURL: vi.fn().mockResolvedValue(undefined), navigationHistory: { clear: vi.fn() },
    });
    contentsById.set(contents.id, contents);
    return contents;
  }
  it("overrides renderer preferences and binds only an approved guest in the assigned account", async () => {
    const { owner, session, request, token, params, preferences } = await setup();
    const event = { preventDefault: vi.fn() };
    owner.emit("will-attach-webview", event, preferences, params);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(preferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false });
    expect(preferences).not.toHaveProperty("preload");
    expect(params).not.toHaveProperty("preload");
    const contents = guest(owner, session);
    owner.emit("did-attach-webview", {}, contents);
    const attach = handlers.get("viron:browser-host:attached")!;
    expect(() => attach({ sender: new EventEmitter() }, token, 7)).toThrow("Invalid or expired");
    contents.session = {};
    expect(() => attach({ sender: owner }, token, 7)).toThrow("Invalid or expired");
    contents.session = session;
    attach({ sender: owner }, token, 7);
    const page = await request;
    expect(contents.loadURL).not.toHaveBeenCalled();
    expect(params.useragent).toBe("Browser test agent");
    expect(contents.navigationHistory.clear).toHaveBeenCalled();
    expect(() => attach({ sender: owner }, token, 7)).toThrow("Invalid or expired");
    page.dispose();
    page.dispose();
    expect(contents.close).toHaveBeenCalledTimes(1);
  });
  it("rejects the wrong partition and cancels a page before it can attach", async () => {
    const { host, owner, request, token, params, preferences } = await setup();
    const event = { preventDefault: vi.fn() };
    owner.emit("will-attach-webview", event, preferences, { ...params, partition: "persist:account-b" });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const rejected = expect(request).rejects.toThrow("closed before attachment");
    host.closeBrowserGuests("view-a");
    await rejected;
    expect(() => handlers.get("viron:browser-host:attached")!({ sender: owner }, token, 7)).toThrow("Invalid or expired");
    expect(owner.send.mock.calls.at(-1)?.[1]).toEqual({ type: "destroy", token });
  });
});
