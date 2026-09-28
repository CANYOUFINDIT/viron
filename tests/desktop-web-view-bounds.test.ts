import { describe, expect, it } from "vitest";
import { resolveWebViewBounds } from "../src/desktop/web-view-bounds.js";

describe("native web view scroll geometry", () => {
  const viewport = { width: 1288, height: 946 };

  it("moves the page without resizing it as the outer workspace scrolls", () => {
    const surface = { x: 86, y: 312, width: 1184, height: 698 };
    for (const scrollY of [0, 16, 40, 80, 40, 0]) {
      expect(resolveWebViewBounds({ ...surface, y: surface.y - scrollY }, viewport))
        .toEqual({ ...surface, y: surface.y - scrollY });
    }
  });

  it("preserves negative offsets so the window clips the correct part of the page", () => {
    expect(resolveWebViewBounds({ x: -20, y: -60, width: 900, height: 700 }, viewport))
      .toEqual({ x: -20, y: -60, width: 900, height: 700 });
  });

  it("keeps fully offscreen pages offscreen and bounds their resource use", () => {
    expect(resolveWebViewBounds({ x: -20000, y: 20000, width: 20000, height: 20000 }, viewport))
      .toEqual({ x: -1288, y: 946, width: 1288, height: 946 });
  });

  it("changes page dimensions when the surface or window actually resizes", () => {
    expect(resolveWebViewBounds({ x: 80.3, y: 240.7, width: 800.3, height: 600.7 }, viewport))
      .toEqual({ x: 80, y: 241, width: 800, height: 601 });
    expect(resolveWebViewBounds({ x: 80, y: 240, width: 800, height: 601 }, { width: 700, height: 500 }))
      .toEqual({ x: 80, y: 240, width: 700, height: 500 });
  });

  it.each([null, undefined, {}, { x: 0, y: NaN, width: 800, height: 600 }, { x: 0, y: 0, width: Infinity, height: 600 }])(
    "rejects malformed bounds: %j", (input) => {
      expect(resolveWebViewBounds(input, viewport)).toBeNull();
    },
  );
});
