import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cursor, host } = vi.hoisted(() => ({
  cursor: { x: 150, y: 180 },
  host: {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 100, width: 1000, height: 700 }),
    getContentSize: () => [1000, 700],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn() },
    focus: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {
    visible = false;
    destroyed = false;
    bounds = { x: 0, y: 0, width: 1, height: 1 };
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(), focus: vi.fn(),
      isDestroyed: () => this.destroyed,
      close: () => { this.destroyed = true; this.webContents.emit("destroyed"); },
    });
    setBackgroundColor() {}
    setVisible(visible: boolean) { this.visible = visible; }
    getVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
  },
  screen: { getCursorScreenPoint: () => cursor },
}));
vi.mock("../src/desktop/window-host.js", () => ({ mainWindow: host }));
vi.mock("../src/desktop/overlays/native-window-stack.js", () => ({
  registerNativeOverlayWindow: vi.fn(), updateNativeOverlayPriority: vi.fn(), raiseNativeOverlayWindows: vi.fn(),
}));

import { closeAllDomOverlayWindows, hideDomOverlayWindow, layoutDomOverlayWindow, registerDomOverlayWindow } from "../src/desktop/overlays/dom-overlay-windows.js";
import { createSidebarOverlay, raiseSidebarOverlays, sidebarOverlayViews } from "../src/desktop/overlays/sidebar-overlay-view.js";

class Overlay extends EventEmitter {
  visible = false;
  destroyed = false;
  bounds = { x: 0, y: 0, width: 1, height: 1 };
  focus = vi.fn();
  webContents = Object.assign(new EventEmitter(), {
    session: { setPermissionRequestHandler: vi.fn() }, setWindowOpenHandler: vi.fn(),
  });
  getParentWindow() { return host; }
  setMenuBarVisibility() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return false; }
  getBounds() { return this.bounds; }
  setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; this.emit("show"); }
  hide() { this.visible = false; this.emit("hide"); }
  close() { this.destroyed = true; this.emit("closed"); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.assign(cursor, { x: 150, y: 180 });
});
afterEach(() => {
  closeAllDomOverlayWindows();
  vi.useRealTimers();
});

describe("native sidebar pointer tracking", () => {
  it("delivers enter, leave and re-entry without DOM events or window focus", () => {
    const name = "viron-dom-overlay-sidebar-1";
    const contents = createSidebarOverlay(name, {});
    layoutDomOverlayWindow(name, { x: 0, y: 0, width: 224, height: 700 }, 40);
    vi.advanceTimersByTime(80);
    expect(host.webContents.send).toHaveBeenLastCalledWith("viron:dom-overlay:pointer", name, true);
    cursor.x = 400;
    vi.advanceTimersByTime(160);
    expect(host.webContents.send).toHaveBeenLastCalledWith("viron:dom-overlay:pointer", name, false);
    expect(host.webContents.send).toHaveBeenCalledTimes(2);
    cursor.x = 200;
    vi.advanceTimersByTime(40);
    expect(host.webContents.send).toHaveBeenLastCalledWith("viron:dom-overlay:pointer", name, true);
    expect(contents.focus).not.toHaveBeenCalled();
    expect(host.focus).not.toHaveBeenCalled();
  });

  it("detects a pointer that has already left while the sidebar was opening and stops on hide/close", () => {
    const name = "viron-dom-overlay-sidebar-2";
    cursor.x = 500;
    const contents = createSidebarOverlay(name, {});
    layoutDomOverlayWindow(name, { x: 0, y: 0, width: 224, height: 700 }, 40);
    vi.advanceTimersByTime(40);
    expect(host.webContents.send).toHaveBeenLastCalledWith("viron:dom-overlay:pointer", name, false);
    hideDomOverlayWindow(name);
    expect(vi.getTimerCount()).toBe(0);
    cursor.x = 150;
    layoutDomOverlayWindow(name, { x: 0, y: 0, width: 224, height: 700 }, 40);
    vi.advanceTimersByTime(40);
    expect(host.webContents.send).toHaveBeenLastCalledWith("viron:dom-overlay:pointer", name, true);
    contents.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(sidebarOverlayViews()).toEqual([]);
  });

  it("keeps the visible sidebar above new web tabs without activating it", () => {
    const name = "viron-dom-overlay-sidebar-4";
    const contents = createSidebarOverlay(name, {});
    layoutDomOverlayWindow(name, { x: 0, y: 0, width: 224, height: 700 }, 40);
    host.contentView.addChildView.mockClear();
    raiseSidebarOverlays();
    expect(host.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(sidebarOverlayViews()[0]);
    expect(contents.focus).not.toHaveBeenCalled();
    hideDomOverlayWindow(name);
    host.contentView.addChildView.mockClear();
    raiseSidebarOverlays();
    expect(host.contentView.addChildView).not.toHaveBeenCalled();
  });

  it("keeps modal focus behavior and does not track other overlays", () => {
    const overlay = new Overlay();
    const name = "viron-dom-overlay-3";
    registerDomOverlayWindow(name, overlay as unknown as BrowserWindow);
    layoutDomOverlayWindow(name, { x: 20, y: 20, width: 500, height: 400 }, 2000, true);
    expect(overlay.focus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
