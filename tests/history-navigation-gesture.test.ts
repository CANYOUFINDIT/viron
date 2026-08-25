import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HISTORY_NAVIGATION_HANDLE_SIZE,
  elementCanScrollHistoryDirection,
  historyNavigationBlockedBySelector,
  historyNavigationDirectionFromDeltaX,
  historyNavigationFromAppCommand,
  historyNavigationFromMouseButton,
  historyNavigationFromSwipeDirection,
  historyNavigationHandleBounds,
  historyNavigationProgress,
  idleHistoryNavigationGesture,
  reduceHistoryNavigationWheel,
  settleHistoryNavigationGesture,
} from "../src/shared/history-navigation-gesture.js";
import { HISTORY_NAVIGATION_OVERLAY_HTML } from "../src/desktop/history-navigation-overlay.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function swipe(deltas: number[], start = idleHistoryNavigationGesture(0)) {
  return deltas.reduce((state, deltaX, index) => reduceHistoryNavigationWheel(state, {
    deltaX,
    deltaY: 0,
    deltaMode: 0,
    time: index * 8,
  }), start);
}

describe("history navigation gestures", () => {
  it("maps natural two-finger swipes onto back and forward", () => {
    expect(historyNavigationDirectionFromDeltaX(-12)).toBe("back");
    expect(historyNavigationDirectionFromDeltaX(9)).toBe("forward");
    expect(historyNavigationFromSwipeDirection("right")).toBe("back");
    expect(historyNavigationFromSwipeDirection("left")).toBe("forward");
    expect(historyNavigationFromAppCommand("browser-backward")).toBe("back");
    expect(historyNavigationFromAppCommand("browser-forward")).toBe("forward");
    expect(historyNavigationFromMouseButton(3)).toBe("back");
    expect(historyNavigationFromMouseButton(4)).toBe("forward");
    expect(historyNavigationFromMouseButton("back")).toBe("back");
  });

  it("arms a two-finger swipe while held and only commits after release", () => {
    const pending = swipe([-18, -18]);
    expect(pending.status).toBe("pending");
    expect(pending.direction).toBe("back");
    expect(historyNavigationProgress(pending)).toBeGreaterThan(0);
    expect(settleHistoryNavigationGesture(pending).status).toBe("idle");

    const tracking = swipe([-18, -18, -18]);
    expect(tracking.status).toBe("pending");
    expect(settleHistoryNavigationGesture(tracking).status).toBe("idle");

    const armed = swipe(Array.from({ length: 8 }, () => -20));
    expect(armed.status).toBe("armed");
    expect(armed.direction).toBe("back");
    expect(historyNavigationProgress(armed)).toBe(1);
    expect(settleHistoryNavigationGesture(armed)).toMatchObject({ status: "committed", direction: "back" });
  });

  it("ignores vertical scrolling, pinch zoom, and shifted mouse wheels", () => {
    expect(reduceHistoryNavigationWheel(idleHistoryNavigationGesture(0), {
      deltaX: 4,
      deltaY: 28,
      time: 16,
    }).status).toBe("idle");
    expect(reduceHistoryNavigationWheel(idleHistoryNavigationGesture(0), {
      deltaX: -40,
      deltaY: 0,
      ctrlKey: true,
      time: 16,
    }).status).toBe("idle");
    expect(reduceHistoryNavigationWheel(idleHistoryNavigationGesture(0), {
      deltaX: -40,
      deltaY: 0,
      shiftKey: true,
      time: 16,
    }).status).toBe("idle");
    expect(reduceHistoryNavigationWheel(idleHistoryNavigationGesture(0), {
      deltaX: -40,
      deltaY: 0,
      deltaMode: 1,
      time: 16,
    }).status).toBe("idle");
  });

  it("resets when the swipe reverses or sits idle", () => {
    const pending = swipe([-24, -24]);
    expect(reduceHistoryNavigationWheel(pending, { deltaX: 30, deltaY: 0, time: 40 }).status).toBe("idle");
    expect(reduceHistoryNavigationWheel(pending, { deltaX: -12, deltaY: 0, time: pending.lastEventAt + 400 }).status).toBe("pending");
    expect(reduceHistoryNavigationWheel(pending, { deltaX: -12, deltaY: 0, time: pending.lastEventAt + 400 }).direction).toBe("back");
  });

  it("keeps the swipe held across a pause until it is explicitly released", () => {
    const pending = swipe([-24, -24]);
    const held = reduceHistoryNavigationWheel(pending, {
      deltaX: -12,
      deltaY: 0,
      holding: true,
      time: pending.lastEventAt + 400,
    });
    expect(held.status).toBe("pending");
    expect(held.distance).toBe(60);
    expect(settleHistoryNavigationGesture(held).status).toBe("idle");
    const armed = swipe(Array.from({ length: 8 }, () => -20));
    expect(settleHistoryNavigationGesture(armed).status).toBe("committed");
  });

  it("slides a larger handle in from the content surface edge", () => {
    const surface = { x: 200, y: 40, width: 1000, height: 700 };
    const { width, height } = HISTORY_NAVIGATION_HANDLE_SIZE;
    const y = 40 + Math.round((700 - height) / 2);
    expect(historyNavigationHandleBounds("back", 0, surface)).toEqual({ x: 200 - width, y, width, height });
    expect(historyNavigationHandleBounds("back", 1, surface)).toEqual({ x: 200, y, width, height });
    expect(historyNavigationHandleBounds("forward", 0, surface)).toEqual({ x: 1200, y, width, height });
    expect(historyNavigationHandleBounds("forward", 1, surface)).toEqual({ x: 1200 - width, y, width, height });
    expect(width).toBeGreaterThanOrEqual(48);
    expect(height).toBeGreaterThanOrEqual(72);
  });

  it("does not steal an in-progress horizontal scroll, and allows workbench tab switching", () => {
    expect(elementCanScrollHistoryDirection({ scrollLeft: 80, clientWidth: 400, scrollWidth: 900 }, "back")).toBe(true);
    expect(elementCanScrollHistoryDirection({ scrollLeft: 0, clientWidth: 400, scrollWidth: 900 }, "back")).toBe(false);
    expect(elementCanScrollHistoryDirection({ scrollLeft: 0, clientWidth: 400, scrollWidth: 900 }, "forward")).toBe(true);
    expect(elementCanScrollHistoryDirection({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }, "forward")).toBe(false);
    expect(historyNavigationBlockedBySelector({ closest: (selector) => selector.includes(".el-dialog") ? {} : null })).toBe(true);
    expect(historyNavigationBlockedBySelector({ closest: (selector) => selector.includes(".ssh-workbench") ? {} : null })).toBe(false);
  });
});

describe("history navigation wiring", () => {
  it("keeps the native overlay handle on the content edge", () => {
    expect(HISTORY_NAVIGATION_OVERLAY_HTML).toContain("data-direction=\"back\"");
    expect(HISTORY_NAVIGATION_OVERLAY_HTML).toContain("border-radius: 0 18px 18px 0");
    expect(HISTORY_NAVIGATION_OVERLAY_HTML).toContain("rotate(-135deg)");
    expect(HISTORY_NAVIGATION_OVERLAY_HTML).toContain("width: 18px");
  });

  it("uses visit order for pages and tabs, and pins the cue to the interaction surface", () => {
    const main = source("src/desktop/main.ts");
    const runtime = source("src/desktop/history-navigation-runtime.ts");
    expect(main).toContain("attachDesktopHistoryNavigationListeners(createdMainWindow)");
    expect(runtime).toContain('window.on("swipe"');
    expect(runtime).toContain('window.on("app-command"');
    expect(runtime).toContain("handleDesktopHistoryNavigationWheel(");
    expect(runtime).toContain('webContents.on("input-event"');
    expect(runtime).toContain('send("viron:history-navigation-touch"');
    expect(runtime).toContain("gestureScrollBegin");
    expect(runtime).toContain("gestureScrollEnd");
    expect(runtime).toContain('mainWindow.webContents.send("viron:history-navigation", direction)');
    expect(source("src/client/history-navigation.ts")).toContain("holdUntilRelease");
    expect(source("src/client/history-navigation.ts")).toContain("applyHistoryNavigationTouch");
    expect(source("src/client/styles/base.css")).toContain("overscroll-behavior-x: none");
    expect(source("src/client/history-navigation.ts")).toContain("settleHistoryNavigationGesture(gesture");
    expect(runtime).toContain("settleHistoryNavigationGesture(historyNavigationGesture");
    expect(source("src/client/components/AppShell.vue")).toContain("installVisitHistory(router)");
    expect(source("src/client/components/HistoryNavigationOverlay.vue")).toContain("HISTORY_NAVIGATION_SURFACE_SELECTOR");
    expect(source("src/client/components/HistoryNavigationOverlay.vue")).toContain(":size=\"28\"");
    expect(source("src/client/components/WebAccountBrowser.vue")).toContain("applyHistoryNavigationWheel");
    expect(source("src/client/components/DesktopWebAccountBrowser.vue")).toContain("handleHistoryMouseButton");
  });
});
