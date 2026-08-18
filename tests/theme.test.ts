import { describe, expect, it } from "vitest";
import { normalizeTheme, themeNames } from "../src/shared/theme.js";

describe("client theme selection", () => {
  it("accepts the three supported device themes", () => {
    expect(themeNames.map((value) => normalizeTheme(value))).toEqual(["light", "dark", "bright"]);
  });

  it("falls back to light for missing or obsolete local values", () => {
    expect(normalizeTheme(null)).toBe("light");
    expect(normalizeTheme(undefined)).toBe("light");
    expect(normalizeTheme("system")).toBe("light");
  });
});
