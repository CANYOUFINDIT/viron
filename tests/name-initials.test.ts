import { describe, expect, it } from "vitest";
import { nameInitials } from "../src/shared/name-initials";

describe("name initials", () => {
  it("uses the first character of a Chinese name and the initials of an English name", () => {
    expect(nameInitials("张三")).toBe("张");
    expect(nameInitials("付同永")).toBe("付");
    expect(nameInitials("Michelle Bill")).toBe("MB");
    expect(nameInitials("  michelle   bill  ")).toBe("MB");
    expect(nameInitials("Michelle")).toBe("M");
    expect(nameInitials("Mary Ann Smith")).toBe("MA");
    expect(nameInitials("")).toBe("");
  });
});
