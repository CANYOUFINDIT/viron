import { describe, expect, it } from "vitest";
import {
  desktopWebZoomStorageKey,
  pageZoomCommandFromKey,
  pageZoomFactor,
  pageZoomLabel,
  pageZoomOrigin,
  pageZoomWheelShouldHandle,
  reducePageZoomWheel,
  selectPageZoomTarget,
  stepPageZoom,
  stepPageZoomBy,
} from "../src/shared/page-zoom.js";

const view = (id: string, patch: Partial<{ visible: boolean; closing: boolean; closedReason: string; lastActivityAt: number; hasActivePage: boolean }> = {}) => ({
  id,
  visible: true,
  closing: false,
  closedReason: "",
  lastActivityAt: 1,
  hasActivePage: true,
  ...patch,
});

describe("Chrome page zoom levels", () => {
  it("steps through Chrome's preset percentages", () => {
    expect(pageZoomLabel(1)).toBe("100%");
    expect(stepPageZoom(1, "in")).toBe(1.1);
    expect(pageZoomLabel(stepPageZoom(1, "in"))).toBe("110%");
    expect(pageZoomLabel(stepPageZoom(1.1, "in"))).toBe("125%");
    expect(pageZoomLabel(stepPageZoom(1, "out"))).toBe("90%");
    expect(pageZoomLabel(1 / 3)).toBe("33%");
    expect(pageZoomLabel(2 / 3)).toBe("67%");
  });

  it("stops at 25% and 500% and resets to 100%", () => {
    expect(stepPageZoom(0.25, "out")).toBe(0.25);
    expect(stepPageZoom(5, "in")).toBe(5);
    expect(stepPageZoom(2.5, "reset")).toBe(1);
    expect(stepPageZoomBy(1, 2)).toBe(0.8);
    expect(pageZoomLabel(stepPageZoomBy(1, -2))).toBe("125%");
    expect(pageZoomFactor(Number.NaN)).toBe(1);
  });

  it("keeps zoom per HTTP(S) origin", () => {
    expect(pageZoomOrigin("https://chromewebstore.google.com/detail/onetab")).toBe("https://chromewebstore.google.com");
    expect(pageZoomOrigin("http://127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000");
    expect(pageZoomOrigin("about:blank")).toBeNull();
    expect(pageZoomOrigin("javascript:alert(1)")).toBeNull();
    expect(desktopWebZoomStorageKey("account", "https://example.com")).toBe("account\nhttps://example.com");
  });

  it("recognizes Chrome's zoom shortcuts", () => {
    expect(pageZoomCommandFromKey({ key: "=", code: "Equal", meta: true, control: false, alt: false, shift: false })).toBe("in");
    expect(pageZoomCommandFromKey({ key: "+", code: "Equal", meta: true, control: false, alt: false, shift: true })).toBe("in");
    expect(pageZoomCommandFromKey({ key: "-", code: "Minus", meta: false, control: true, alt: false, shift: false })).toBe("out");
    expect(pageZoomCommandFromKey({ key: "0", code: "Digit0", meta: true, control: false, alt: false, shift: false })).toBe("reset");
    expect(pageZoomCommandFromKey({ key: ")", code: "Digit0", meta: true, control: false, alt: false, shift: true })).toBeNull();
    expect(pageZoomCommandFromKey({ key: "=", code: "Equal", meta: true, control: false, alt: true, shift: false })).toBeNull();
    expect(pageZoomCommandFromKey({ key: "=", code: "Equal", meta: false, control: false, alt: false, shift: false })).toBeNull();
  });

  it("turns a vertical modified wheel into discrete zoom steps", () => {
    expect(pageZoomWheelShouldHandle({ control: true, meta: false, alt: false, shift: false, deltaX: 0, deltaY: 40 })).toBe(true);
    expect(pageZoomWheelShouldHandle({ control: true, meta: false, alt: false, shift: true, deltaX: 0, deltaY: 40 })).toBe(false);
    expect(pageZoomWheelShouldHandle({ control: false, meta: false, alt: false, shift: false, deltaX: 0, deltaY: 120 })).toBe(false);
    expect(pageZoomWheelShouldHandle({ control: true, meta: false, alt: false, shift: false, deltaX: 80, deltaY: 10 })).toBe(false);
    const partial = reducePageZoomWheel(0, 40);
    expect(partial).toEqual({ accumulated: 40, steps: 0 });
    expect(reducePageZoomWheel(partial.accumulated, 70)).toEqual({ accumulated: 10, steps: 1 });
    expect(reducePageZoomWheel(0, -100).steps).toBe(-1);
    expect(reducePageZoomWheel(0, 450).steps).toBe(3);
  });

  it("zooms the focused visible page", () => {
    const pages = [view("older", { lastActivityAt: 5 }), view("newer", { lastActivityAt: 9 }), view("hidden", { visible: false, lastActivityAt: 20 })];
    expect(selectPageZoomTarget(pages, "")?.id).toBe("newer");
    expect(selectPageZoomTarget(pages, "older")?.id).toBe("older");
    expect(selectPageZoomTarget([view("closed", { closedReason: "closed" })], "")).toBeNull();
  });
});
