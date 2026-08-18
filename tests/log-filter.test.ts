import { describe, expect, it } from "vitest";
import { filterLogOutput, normalizeLogInteger, tailLogLines } from "../src/client/log-filter";

describe("log filtering", () => {
  it("keeps the newest lines inside the display limit", () => {
    expect(tailLogLines("1\n2\n3\n4", 2)).toBe("3\n4");
    expect(normalizeLogInteger(9999, 1, 5000, 200)).toBe(5000);
    expect(normalizeLogInteger("bad", 1, 5000, 200)).toBe(200);
  });

  it("filters by fixed keyword with before and after context", () => {
    const result = filterLogOutput("a\nbefore\nERROR one\nafter\ngap\nskip\nERROR two\nend", {
      keyword: "error",
      caseSensitive: false,
      before: 1,
      after: 1,
    });
    expect(result.matchLineCount).toBe(2);
    expect(result.includedLineCount).toBe(6);
    expect(result.output).toBe("before\nERROR one\nafter\n--\nskip\nERROR two\nend");
    expect(result.hasGaps).toBe(true);
  });

  it("honors case-sensitive matching", () => {
    expect(filterLogOutput("ERROR\nerror", { keyword: "error", caseSensitive: true, before: 0, after: 0 }).output).toBe("error");
    expect(filterLogOutput("ERROR\nerror", { keyword: "error", caseSensitive: false, before: 0, after: 0 }).matchLineCount).toBe(2);
  });
});
