import { describe, expect, it } from "vitest";
import { hasExactIds, idAfterClose, reorderIds, reorderMap, sameOrder } from "../src/shared/tab-order.js";

describe("tab ordering", () => {
  it("moves a dragged tab before or after its target", () => {
    expect(reorderIds(["a", "b", "c", "d"], "a", "c", false)).toEqual(["b", "a", "c", "d"]);
    expect(reorderIds(["a", "b", "c", "d"], "b", "c", true)).toEqual(["a", "c", "b", "d"]);
    expect(reorderIds(["a", "b"], "missing", "b", true)).toEqual(["a", "b"]);
  });

  it("validates and rebuilds ordered maps without losing values", () => {
    const items = new Map([["a", 1], ["b", 2], ["c", 3]]);
    expect(hasExactIds(["c", "a", "b"], [...items.keys()])).toBe(true);
    expect(hasExactIds(["c", "a"], [...items.keys()])).toBe(false);
    expect(hasExactIds(["a", "a", "c"], [...items.keys()])).toBe(false);
    expect([...reorderMap(items, ["c", "a", "b"])!.entries()]).toEqual([["c", 3], ["a", 1], ["b", 2]]);
    expect(reorderMap(items, ["c", "a"])).toBeNull();
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("selects the adjacent tab after closing the active tab", () => {
    expect(idAfterClose(["a", "b", "c", "d"], "b", "b")).toBe("c");
    expect(idAfterClose(["d", "b", "a", "c"], "b", "b")).toBe("a");
    expect(idAfterClose(["a", "b"], "a", "b")).toBe("a");
    expect(idAfterClose(["a"], "a", "a")).toBeNull();
  });
});
