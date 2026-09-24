import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import { raiseNativeOverlayWindows, registerNativeOverlayWindow, updateNativeOverlayPriority } from "../src/desktop/overlays/native-window-stack.js";

class OverlayWindow extends EventEmitter {
  visible = true;
  destroyed = false;
  constructor(readonly name: string, readonly moves: string[]) { super(); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  moveTop() { this.moves.push(this.name); }
  close() { this.destroyed = true; this.emit("closed"); }
}

describe("native overlay window stack", () => {
  it("orders visible windows by priority and keeps the interaction window above its visual layer", () => {
    const moves: string[] = [];
    const visual = new OverlayWindow("visual", moves);
    const interaction = new OverlayWindow("interaction", moves);
    const modal = new OverlayWindow("modal", moves);
    registerNativeOverlayWindow(modal as unknown as BrowserWindow, 2000);
    registerNativeOverlayWindow(interaction as unknown as BrowserWindow, 61);
    registerNativeOverlayWindow(visual as unknown as BrowserWindow, 60);
    raiseNativeOverlayWindows();
    expect(moves).toEqual(["visual", "interaction", "modal"]);

    moves.length = 0;
    updateNativeOverlayPriority(visual as unknown as BrowserWindow, 3000);
    expect(moves).toEqual(["interaction", "modal", "visual"]);
    visual.close();
    interaction.close();
    modal.close();
  });

  it("skips hidden windows and forgets closed windows", () => {
    const moves: string[] = [];
    const hidden = new OverlayWindow("hidden", moves);
    const shown = new OverlayWindow("shown", moves);
    hidden.visible = false;
    registerNativeOverlayWindow(hidden as unknown as BrowserWindow, 10);
    registerNativeOverlayWindow(shown as unknown as BrowserWindow, 20);
    raiseNativeOverlayWindows();
    expect(moves).toEqual(["shown"]);
    moves.length = 0;
    shown.close();
    hidden.visible = true;
    hidden.emit("show");
    expect(moves).toEqual(["hidden"]);
    hidden.close();
  });
});
